/**
 * Crafting lists state management
 * Persisted to IndexedDB
 */

import type { CraftingList, CraftingListItem, CraftingListEntry, MaterialRequirement, TierGroup, StepGroup, ProfessionGroup, StepWithProfessionsGroup, ParentContribution, RootItemContribution, ItemListEntry, CargoListEntry } from '$lib/types/app';
import { isItemEntry, isCargoEntry } from '$lib/types/app';
import type { MaterialNode, FlatMaterial, Item, Recipe, Cargo, MaterialNodeType } from '$lib/types/game';
import { getCachedLists, getCachedList, saveList, deleteList as deleteCachedList, deleteListProgress } from '$lib/services/cache';
import { gameData, getItemById, getItemWithRecipes, getCargoById } from './game-data.svelte';
import { allocateMaterialsFromSources, getAggregatedInventoryForSources, getAggregatedCargoForSources } from './inventory.svelte';

/**
 * Convert a reactive proxy to a plain object for IndexedDB storage
 */
function toPlainList(list: CraftingList): CraftingList {
	return JSON.parse(JSON.stringify(list));
}

// State container
export const crafting = $state({
	lists: [] as CraftingList[],
	activeListId: null as string | null,
	isLoading: false,
	error: null as string | null
});

// Tree cache: stores full material trees per list (rebuilt when list items change)
// Key: listId, Value: { trees: MaterialNode[], listItemsHash: string }
const listTreeCache = new Map<string, { trees: MaterialNode[]; listItemsHash: string }>();

/**
 * Generate a hash of list entries to detect changes
 * Includes recipe preferences to trigger cache invalidation when recipes change
 */
function hashListEntries(entries: CraftingListEntry[], recipePreferences?: Map<string, number>): string {
	const entryHash = entries.map(e => {
		if (isItemEntry(e)) {
			return `i:${e.itemId}:${e.quantity}:${e.recipeId || 0}`;
		} else {
			return `c:${e.cargoId}:${e.quantity}`;
		}
	}).join('|');

	if (!recipePreferences || recipePreferences.size === 0) {
		return entryHash;
	}

	// Sort preferences for consistent hashing
	const prefsArray = Array.from(recipePreferences.entries()).sort(([a], [b]) => a.localeCompare(b));
	const prefsHash = prefsArray.map(([key, recipeId]) => `r:${key}:${recipeId}`).join('|');

	return `${entryHash}::${prefsHash}`;
}

/**
 * Build full material trees for a list (called when list entries change)
 * @param recipePreferences - Optional map of recipe preferences for items in the tree
 */
async function buildListTrees(list: CraftingList, recipePreferences?: Map<string, number>): Promise<MaterialNode[]> {
	const trees: MaterialNode[] = [];

	for (const entry of list.entries) {
		if (isItemEntry(entry)) {
			const tree = await calculateMaterialTree(
				entry.itemId,
				entry.quantity,
				entry.recipeId,
				recipePreferences // Pass preferences to tree calculation
			);
			if (tree) {
				trees.push(tree);
			}
		} else if (isCargoEntry(entry)) {
			const tree = calculateCargoMaterialTree(
				entry.cargoId,
				entry.quantity
			);
			if (tree) {
				trees.push(tree);
			}
		}
	}

	return trees;
}

/**
 * Calculate material tree for a cargo item (always a leaf node)
 */
function calculateCargoMaterialTree(
	cargoId: number,
	quantity: number
): MaterialNode | null {
	const cargo = getCargoById(cargoId);
	if (!cargo) return null;

	return {
		nodeType: 'cargo',
		cargo,
		quantity,
		tier: cargo.tier,
		children: []
	};
}

/**
 * Get or build cached trees for a list
 * @param recipePreferences - Optional map of recipe preferences for cache invalidation
 */
async function getListTrees(list: CraftingList, recipePreferences?: Map<string, number>): Promise<MaterialNode[]> {
	const currentHash = hashListEntries(list.entries, recipePreferences);
	const cached = listTreeCache.get(list.id);

	if (cached && cached.listItemsHash === currentHash) {
		return cached.trees;
	}

	// Build new trees with recipe preferences
	const trees = await buildListTrees(list, recipePreferences);
	listTreeCache.set(list.id, { trees, listItemsHash: currentHash });

	return trees;
}

/**
 * Clear tree cache for a list (call when list is deleted)
 */
function clearListTreeCache(listId: string): void {
	listTreeCache.delete(listId);
}

/**
 * Result from computeRemainingNeeds
 * Uses string keys to support both items (item-123) and cargo (cargo-456)
 */
interface ComputeRemainingNeedsResult {
	needs: Map<string, { baseRequired: number; remaining: number }>;
	parentContributions: Map<string, Array<{ parentNodeKey: string; parentQuantityUsed: number; coverage: number }>>;
}

/**
 * Get node key for a material node
 */
function getNodeKey(node: MaterialNode): string {
	if (node.nodeType === 'cargo') {
		return `cargo-${node.cargo!.id}`;
	}
	return `item-${node.item!.id}`;
}

/**
 * Get node ID (for backwards compatibility)
 */
function getNodeId(node: MaterialNode): number {
	if (node.nodeType === 'cargo') {
		return node.cargo!.id;
	}
	return node.item!.id;
}

/**
 * Compute remaining needs by propagating inventory through the tree
 * @param trees - Material trees to process
 * @param haveItems - Map of itemId -> quantity you have
 * @param haveCargo - Map of cargoId -> quantity you have
 * @param checkedOff - Set of itemIds that are manually marked complete
 * Returns: needs map and parent contributions map
 */
function computeRemainingNeeds(
	trees: MaterialNode[],
	haveItems: Map<number, number>,
	haveCargo: Map<number, number>,
	checkedOff?: Set<number>
): ComputeRemainingNeedsResult {
	const needs = new Map<string, { baseRequired: number; remaining: number }>();
	const parentContributions = new Map<string, Array<{ parentNodeKey: string; parentQuantityUsed: number; coverage: number }>>();

	// Track how much inventory we've "used" across tree branches
	const usedItemInventory = new Map<number, number>();
	const usedCargoInventory = new Map<number, number>();

	// Helper to record a parent's contribution to a child
	function recordContribution(childKey: string, parentKey: string, parentQuantityUsed: number, coverage: number) {
		if (coverage <= 0 || parentQuantityUsed <= 0) return;
		const existing = parentContributions.get(childKey) || [];
		existing.push({ parentNodeKey: parentKey, parentQuantityUsed, coverage });
		parentContributions.set(childKey, existing);
	}

	// Recursively record coverage for all descendants when an ancestor has full coverage
	function recordCoverageForDescendants(node: MaterialNode, ancestorKey: string, ancestorQuantityUsed: number) {
		for (const child of node.children) {
			const childKey = getNodeKey(child);
			recordContribution(childKey, ancestorKey, ancestorQuantityUsed, child.quantity);
			// Recurse to grandchildren
			if (child.children.length > 0) {
				recordCoverageForDescendants(child, ancestorKey, ancestorQuantityUsed);
			}
		}
	}

	function traverse(node: MaterialNode, neededQuantity: number): void {
		const nodeKey = getNodeKey(node);

		// Handle cargo nodes - they now have inventory tracking
		if (node.nodeType === 'cargo') {
			const cargoId = node.cargo!.id;

			// Get current inventory and how much we've already used
			const totalHave = haveCargo.get(cargoId) || 0;
			const alreadyUsed = usedCargoInventory.get(cargoId) || 0;
			const availableToUse = Math.max(0, totalHave - alreadyUsed);

			// How much can we satisfy from inventory?
			const useFromInventory = Math.min(availableToUse, neededQuantity);
			if (useFromInventory > 0) {
				usedCargoInventory.set(cargoId, alreadyUsed + useFromInventory);
			}

			// Remaining after using inventory
			const stillNeeded = neededQuantity - useFromInventory;

			const existing = needs.get(nodeKey) || { baseRequired: 0, remaining: 0 };
			existing.baseRequired += neededQuantity;
			existing.remaining += stillNeeded;
			needs.set(nodeKey, existing);
			// Cargo has no children, so we're done
			return;
		}

		// Item node handling
		const itemId = node.item!.id;

		// If item is checked off, treat as fully satisfied
		const isCheckedOff = checkedOff?.has(itemId) ?? false;

		// Get current inventory and how much we've already used
		const totalHave = haveItems.get(itemId) || 0;
		const alreadyUsed = usedItemInventory.get(itemId) || 0;

		// If checked off, available is infinite (use full needed amount)
		const availableToUse = isCheckedOff
			? neededQuantity
			: Math.max(0, totalHave - alreadyUsed);

		// How much can we satisfy from inventory (or checked off)?
		const useFromInventory = Math.min(availableToUse, neededQuantity);
		if (useFromInventory > 0 && !isCheckedOff) {
			usedItemInventory.set(itemId, alreadyUsed + useFromInventory);
		}

		// Remaining after using inventory
		const stillNeeded = neededQuantity - useFromInventory;

		// Aggregate base requirements and remaining needs
		const existing = needs.get(nodeKey) || { baseRequired: 0, remaining: 0 };
		existing.baseRequired += neededQuantity;
		existing.remaining += stillNeeded;
		needs.set(nodeKey, existing);

		// Handle children - track parent contributions
		if (node.children.length > 0 && node.recipeUsed) {
			const originalCraftCount = Math.ceil(node.quantity / node.recipeUsed.outputQuantity);

			if (stillNeeded > 0) {
				// Partial coverage: recurse with reduced child needs
				const craftCount = Math.ceil(stillNeeded / node.recipeUsed.outputQuantity);

				for (const child of node.children) {
					const childKey = getNodeKey(child);
					const childOriginal = child.quantity;
					const childNeeded = Math.ceil(childOriginal * craftCount / originalCraftCount);
					const childCoverage = childOriginal - childNeeded;

					// Record partial coverage from this parent's inventory
					if (childCoverage > 0 && useFromInventory > 0 && !isCheckedOff) {
						recordContribution(childKey, nodeKey, useFromInventory, childCoverage);
						// Also record coverage for grandchildren that won't be crafted
						if (child.children.length > 0 && childCoverage > 0) {
							// Calculate the portion of the child subtree that's covered
							const coveredRatio = childCoverage / childOriginal;
							recordPartialCoverageForDescendants(child, nodeKey, useFromInventory, coveredRatio);
						}
					}

					traverse(child, childNeeded);
				}
			} else if (useFromInventory > 0 && !isCheckedOff) {
				// Full coverage: record coverage for ALL descendants in subtree
				recordCoverageForDescendants(node, nodeKey, useFromInventory);
			}
		}
	}

	// Record partial coverage for descendants based on coverage ratio
	function recordPartialCoverageForDescendants(node: MaterialNode, ancestorKey: string, ancestorQuantityUsed: number, coverageRatio: number) {
		for (const child of node.children) {
			const childKey = getNodeKey(child);
			const coverage = Math.floor(child.quantity * coverageRatio);
			if (coverage > 0) {
				recordContribution(childKey, ancestorKey, ancestorQuantityUsed, coverage);
				if (child.children.length > 0) {
					recordPartialCoverageForDescendants(child, ancestorKey, ancestorQuantityUsed, coverageRatio);
				}
			}
		}
	}

	// Process each tree (each list item)
	for (const tree of trees) {
		traverse(tree, tree.quantity);
	}

	return { needs, parentContributions };
}

// Getter for active list
export function getActiveList(): CraftingList | null {
	return crafting.lists.find((l) => l.id === crafting.activeListId) || null;
}

// Getter for list count
export function getListCount(): number {
	return crafting.lists.length;
}

/**
 * Migrate old list format (items) to new format (entries)
 */
function migrateList(list: CraftingList & { items?: CraftingListItem[] }): CraftingList {
	// If list has old 'items' property but no 'entries', migrate it
	if (list.items && !list.entries) {
		const entries: CraftingListEntry[] = list.items.map((item) => ({
			id: item.id,
			type: 'item' as const,
			itemId: item.itemId,
			quantity: item.quantity,
			recipeId: item.recipeId,
			addedAt: item.addedAt
		}));
		return {
			...list,
			entries,
			items: undefined // Remove old property
		} as CraftingList;
	}
	// If entries is undefined, initialize to empty array
	if (!list.entries) {
		return { ...list, entries: [] };
	}
	return list;
}

/**
 * Initialize crafting lists from cache
 */
export async function initializeCrafting(): Promise<void> {
	crafting.isLoading = true;

	try {
		const lists = await getCachedLists();
		// Migrate old format lists to new format
		const migratedLists = lists.map(migrateList);
		crafting.lists = migratedLists;

		// Save any migrated lists back to cache
		for (let i = 0; i < lists.length; i++) {
			if (lists[i] !== migratedLists[i]) {
				await saveList(toPlainList(migratedLists[i]));
			}
		}
	} catch (e) {
		console.error('Failed to initialize crafting lists:', e);
		crafting.error = e instanceof Error ? e.message : 'Failed to load crafting lists';
	} finally {
		crafting.isLoading = false;
	}
}

/**
 * Create a new crafting list
 */
export async function createList(name: string, description?: string): Promise<CraftingList> {
	const now = Date.now();
	const newList: CraftingList = {
		id: crypto.randomUUID(),
		name,
		description,
		entries: [],
		enabledSourceIds: [], // Empty means use all available sources
		createdAt: now,
		updatedAt: now
	};

	crafting.lists.push(newList);
	await saveList(toPlainList(newList));

	return newList;
}

/**
 * Update list metadata
 */
export async function updateList(
	listId: string,
	updates: Partial<Pick<CraftingList, 'name' | 'description'>>
): Promise<void> {
	const list = crafting.lists.find((l) => l.id === listId);
	if (!list) return;

	if (updates.name !== undefined) list.name = updates.name;
	if (updates.description !== undefined) list.description = updates.description;
	list.updatedAt = Date.now();

	await saveList(toPlainList(list));
}

/**
 * Delete a crafting list
 */
export async function deleteList(listId: string): Promise<void> {
	crafting.lists = crafting.lists.filter((l) => l.id !== listId);

	if (crafting.activeListId === listId) {
		crafting.activeListId = null;
	}

	clearListTreeCache(listId);
	await deleteCachedList(listId);
	await deleteListProgress(listId);
}

/**
 * Set active list
 */
export function setActiveList(listId: string | null): void {
	crafting.activeListId = listId;
}

/**
 * Add item to a list
 */
export async function addItemToList(listId: string, itemId: number, quantity: number, recipeId?: number): Promise<void> {
	const list = crafting.lists.find((l) => l.id === listId);
	if (!list) return;

	// Check if item entry already exists with the same recipe
	const existingEntry = list.entries.find(
		(e) => isItemEntry(e) && e.itemId === itemId && e.recipeId === recipeId
	);

	if (existingEntry) {
		existingEntry.quantity += quantity;
	} else {
		const newEntry: ItemListEntry = {
			id: crypto.randomUUID(),
			type: 'item',
			itemId,
			quantity,
			recipeId,
			addedAt: Date.now()
		};
		list.entries.push(newEntry);
	}

	list.updatedAt = Date.now();
	await saveList(toPlainList(list));
}

/**
 * Add cargo to a list
 */
export async function addCargoToList(listId: string, cargoId: number, quantity: number): Promise<void> {
	const list = crafting.lists.find((l) => l.id === listId);
	if (!list) return;

	// Check if cargo entry already exists
	const existingEntry = list.entries.find(
		(e) => isCargoEntry(e) && e.cargoId === cargoId
	);

	if (existingEntry) {
		existingEntry.quantity += quantity;
	} else {
		const newEntry: CargoListEntry = {
			id: crypto.randomUUID(),
			type: 'cargo',
			cargoId,
			quantity,
			addedAt: Date.now()
		};
		list.entries.push(newEntry);
	}

	list.updatedAt = Date.now();
	await saveList(toPlainList(list));
}

/**
 * Update entry quantity in a list
 */
export async function updateEntryQuantity(
	listId: string,
	entryId: string,
	quantity: number
): Promise<void> {
	const list = crafting.lists.find((l) => l.id === listId);
	if (!list) return;

	const entry = list.entries.find((e) => e.id === entryId);
	if (entry) {
		entry.quantity = Math.max(0, quantity);
		list.updatedAt = Date.now();
		await saveList(toPlainList(list));
	}
}

/**
 * Update item quantity in a list (legacy, finds by itemId)
 */
export async function updateItemQuantity(
	listId: string,
	itemId: number,
	quantity: number
): Promise<void> {
	const list = crafting.lists.find((l) => l.id === listId);
	if (!list) return;

	const entry = list.entries.find((e) => isItemEntry(e) && e.itemId === itemId);
	if (entry) {
		entry.quantity = Math.max(0, quantity);
		list.updatedAt = Date.now();
		await saveList(toPlainList(list));
	}
}

/**
 * Remove entry from a list by entry ID
 */
export async function removeEntryFromList(listId: string, entryId: string): Promise<void> {
	const list = crafting.lists.find((l) => l.id === listId);
	if (!list) return;

	list.entries = list.entries.filter((e) => e.id !== entryId);
	list.updatedAt = Date.now();
	await saveList(toPlainList(list));
}

/**
 * Remove item from a list (legacy, finds by itemId)
 */
export async function removeItemFromList(listId: string, itemId: number): Promise<void> {
	const list = crafting.lists.find((l) => l.id === listId);
	if (!list) return;

	list.entries = list.entries.filter((e) => !(isItemEntry(e) && e.itemId === itemId));
	list.updatedAt = Date.now();
	await saveList(toPlainList(list));
}

/**
 * Clear all entries from a list
 */
export async function clearList(listId: string): Promise<void> {
	const list = crafting.lists.find((l) => l.id === listId);
	if (!list) return;

	list.entries = [];
	list.updatedAt = Date.now();
	await saveList(toPlainList(list));
}

/**
 * Duplicate a list
 */
export async function duplicateList(listId: string): Promise<CraftingList | null> {
	const original = crafting.lists.find((l) => l.id === listId);
	if (!original) return null;

	const now = Date.now();
	const duplicate: CraftingList = {
		id: crypto.randomUUID(),
		name: `${original.name} (Copy)`,
		description: original.description,
		entries: original.entries.map((entry) => ({
			...entry,
			id: crypto.randomUUID(),
			addedAt: now
		})),
		enabledSourceIds: [...original.enabledSourceIds],
		createdAt: now,
		updatedAt: now
	};

	crafting.lists.push(duplicate);
	await saveList(toPlainList(duplicate));

	return duplicate;
}

/**
 * Update enabled sources for a list
 */
export async function updateListSources(listId: string, sourceIds: string[]): Promise<void> {
	const list = crafting.lists.find((l) => l.id === listId);
	if (!list) return;

	list.enabledSourceIds = sourceIds;
	list.updatedAt = Date.now();
	await saveList(toPlainList(list));
}

/**
 * Update auto-refresh setting for a list
 */
export async function updateListAutoRefresh(listId: string, enabled: boolean): Promise<void> {
	const list = crafting.lists.find((l) => l.id === listId);
	if (!list) return;

	list.autoRefreshEnabled = enabled;
	list.updatedAt = Date.now();
	await saveList(toPlainList(list));
}


/**
 * Calculate material tree for an item (full tree, no inventory reduction)
 * @param recipeId - Optional specific recipe to use (for top-level item only)
 * @param recipePreferences - Optional map of recipe preferences for any item in tree
 */
export async function calculateMaterialTree(
	itemId: number,
	quantity: number,
	recipeId?: number,
	recipePreferences?: Map<string, number>,
	depth = 0,
	maxDepth = 50
): Promise<MaterialNode | null> {
	const item = getItemById(itemId);
	if (!item) return null;

	// Get recipes for this item (sync - all data is pre-loaded)
	const itemDetails = getItemWithRecipes(itemId);
	const allRecipes = itemDetails?.craftingRecipes || [];

	// Filter out downgrade recipes (output tier < input tier)
	const recipes = allRecipes.filter(recipe => {
		if (item.tier === -1) return true; // Ignore tier -1 output items

		return !recipe.ingredients.some(ing => {
			const ingItem = getItemById(ing.itemId);
			if (!ingItem || ingItem.tier === -1) return false; // Ignore tier -1 ingredients
			return ingItem.tier > item.tier;
		});
	});

	// Base case: no valid recipes or max depth reached
	if (recipes.length === 0 || depth >= maxDepth) {
		return {
			nodeType: 'item',
			item,
			quantity,
			tier: item.tier,
			children: []
		};
	}

	// Recipe selection priority:
	// 1. Explicit recipeId parameter (for top-level from entry.recipeId)
	// 2. Recipe preferences (for any item in tree)
	// 3. Default (cheapest recipe)
	const sortedRecipes = [...recipes].sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity));
	let recipe: Recipe;

	if (recipeId !== undefined) {
		// Explicit recipeId has highest priority
		const selectedRecipe = recipes.find(r => r.id === recipeId);
		recipe = selectedRecipe || sortedRecipes[0];
	} else if (recipePreferences) {
		// Check recipe preferences for this item
		const preferredId = recipePreferences.get(`item-${itemId}`);
		if (preferredId !== undefined) {
			const preferredRecipe = recipes.find(r => r.id === preferredId);
			recipe = preferredRecipe || sortedRecipes[0];
		} else {
			recipe = sortedRecipes[0]; // Default to cheapest
		}
	} else {
		recipe = sortedRecipes[0]; // Default to cheapest
	}
	const craftCount = Math.ceil(quantity / recipe.outputQuantity);

	// Recursively calculate children
	const children: MaterialNode[] = [];

	// Process item ingredients
	for (const ingredient of recipe.ingredients) {
		// Child ingredients can use recipe preferences (passed down)
		const childNode = await calculateMaterialTree(
			ingredient.itemId,
			ingredient.quantity * craftCount,
			undefined, // No explicit recipeId for children
			recipePreferences, // Pass preferences down
			depth + 1,
			maxDepth
		);

		if (childNode) {
			children.push(childNode);
		}
	}

	// Process cargo ingredients (these are always leaf nodes)
	if (recipe.cargoIngredients) {
		for (const cargoIng of recipe.cargoIngredients) {
			const cargo = getCargoById(cargoIng.cargoId);
			if (cargo) {
				children.push({
					nodeType: 'cargo',
					cargo,
					quantity: cargoIng.quantity * craftCount,
					tier: cargo.tier,
					children: []
				});
			}
		}
	}

	return {
		nodeType: 'item',
		item,
		quantity,
		tier: item.tier,
		children,
		recipeUsed: recipe
	};
}

/**
 * Cache for item step calculations (based on recipe structure, not inventory)
 */
const itemStepCache = new Map<number, number>();

/**
 * Cache for item profession calculations
 */
const itemProfessionCache = new Map<number, string>();

/**
 * Get the profession/skill for an item based on its cheapest recipe.
 * For raw materials (step 1), uses the item's tag.
 * For crafted items, uses the first level requirement's skill name.
 * For cargo-derived items, uses the cargo source gathering skill.
 */
function getItemProfession(itemId: number): string {
	// Check cache first
	if (itemProfessionCache.has(itemId)) {
		return itemProfessionCache.get(itemId)!;
	}

	const item = getItemById(itemId);
	if (!item) {
		itemProfessionCache.set(itemId, 'Unknown');
		return 'Unknown';
	}

	// Check if this item is derived from cargo (e.g., Ferralith Ore Piece from Ferralith Ore Cargo)
	// This takes priority over other methods to ensure cargo-derived items
	// show their source gathering profession (Mining, etc.)
	const cargoSourceSkill = gameData.itemToCargoSkill.get(itemId);
	if (cargoSourceSkill) {
		itemProfessionCache.set(itemId, cargoSourceSkill);
		return cargoSourceSkill;
	}

	// Check if this item comes from an item list (e.g., Fish Oil from "Breezy Fin Darter Products")
	// Item lists are produced by crafting recipes with a specific skill
	const listSourceSkill = gameData.itemFromListToSkill.get(itemId);
	if (listSourceSkill) {
		itemProfessionCache.set(itemId, listSourceSkill);
		return listSourceSkill;
	}

	// Get recipes for this item
	const itemDetails = getItemWithRecipes(itemId);
	const allRecipes = itemDetails?.craftingRecipes || [];

	// Filter to valid recipes (same logic as getItemNaturalStep)
	const validRecipes = allRecipes.filter(recipe => {
		// Must have some ingredients (item or cargo)
		const hasItemIngredients = recipe.ingredients.length > 0;
		const hasCargoIngredients = (recipe.cargoIngredients?.length ?? 0) > 0;
		if (!hasItemIngredients && !hasCargoIngredients) return false;

		// All item ingredients must be valid Items
		if (hasItemIngredients && !recipe.ingredients.every(ing => getItemById(ing.itemId) !== undefined)) return false;

		// Filter downgrade recipes (only applies to item ingredients)
		if (item.tier === -1) return true;
		return !recipe.ingredients.some(ing => {
			const ingItem = getItemById(ing.itemId);
			if (!ingItem || ingItem.tier === -1) return false;
			return ingItem.tier > item.tier;
		});
	});

	// No valid crafting recipes
	if (validRecipes.length === 0) {
		// Try extraction recipes first (for gathered/mined materials)
		const extractionRecipes = itemDetails?.extractionRecipes || [];
		if (extractionRecipes.length > 0 && extractionRecipes[0].levelRequirements?.[0]?.skillName) {
			const profession = extractionRecipes[0].levelRequirements[0].skillName;
			itemProfessionCache.set(itemId, profession);
			return profession;
		}

		// Try related skills
		const relatedSkills = itemDetails?.relatedSkills || [];
		if (relatedSkills.length > 0 && relatedSkills[0].name) {
			const profession = relatedSkills[0].name;
			itemProfessionCache.set(itemId, profession);
			return profession;
		}

		// Fall back to 'Gathering' for raw materials
		itemProfessionCache.set(itemId, 'Gathering');
		return 'Gathering';
	}

	// Sort by cost and pick cheapest recipe
	const sortedRecipes = [...validRecipes].sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity));
	const recipe = sortedRecipes[0];

	// Get profession from level requirements
	const profession = recipe.levelRequirements?.[0]?.skillName || recipe.craftingStationName || item.tag || 'Crafting';
	itemProfessionCache.set(itemId, profession);
	return profession;
}

/**
 * Calculate the natural step for an item based on its cheapest recipe.
 * Uses the defaultRecipeId (pre-computed cheapest recipe) for consistency
 * with material tree calculations.
 * Step 1 = raw materials (no recipe), Step N = max(ingredient steps) + 1
 */
function getItemNaturalStep(itemId: number, visited: Set<number> = new Set()): number {
	// Check cache first
	if (itemStepCache.has(itemId)) {
		return itemStepCache.get(itemId)!;
	}

	// Prevent infinite recursion for circular recipes
	if (visited.has(itemId)) {
		return 1;
	}
	visited.add(itemId);

	const item = getItemById(itemId);
	if (!item) {
		itemStepCache.set(itemId, 1);
		return 1;
	}

	// Get recipes for this item
	const itemDetails = getItemWithRecipes(itemId);
	const allRecipes = itemDetails?.craftingRecipes || [];

	// Filter recipes to only valid "upgrade" crafting recipes:
	// 1. Must have some ingredients (item or cargo)
	// 2. All item ingredients must be valid Items (can be looked up)
	// 3. Not a downgrade recipe (output tier >= all input tiers)
	const validRecipes = allRecipes.filter(recipe => {
		// Must have some ingredients (item or cargo)
		const hasItemIngredients = recipe.ingredients.length > 0;
		const hasCargoIngredients = (recipe.cargoIngredients?.length ?? 0) > 0;
		if (!hasItemIngredients && !hasCargoIngredients) return false;

		// All item ingredients must be valid Items
		if (hasItemIngredients && !recipe.ingredients.every(ing => getItemById(ing.itemId) !== undefined)) return false;

		// Filter downgrade recipes (only applies to item ingredients)
		if (item.tier === -1) return true; // Ignore tier -1 output items

		return !recipe.ingredients.some(ing => {
			const ingItem = getItemById(ing.itemId);
			if (!ingItem || ingItem.tier === -1) return false; // Ignore tier -1 ingredients
			return ingItem.tier > item.tier;
		});
	});

	// No valid recipes = raw material = step 1
	if (validRecipes.length === 0) {
		itemStepCache.set(itemId, 1);
		return 1;
	}

	// Sort by cost and pick cheapest recipe
	const sortedRecipes = [...validRecipes].sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity));
	const recipe = sortedRecipes[0];

	// Calculate step from the cheapest recipe's ingredients
	let maxIngredientStep = 0;
	for (const ing of recipe.ingredients) {
		const ingStep = getItemNaturalStep(ing.itemId, new Set(visited));
		maxIngredientStep = Math.max(maxIngredientStep, ingStep);
	}

	// Cargo ingredients are step 1, so if we have cargo, min step is 1
	if (recipe.cargoIngredients && recipe.cargoIngredients.length > 0) {
		maxIngredientStep = Math.max(maxIngredientStep, 1);
	}

	const step = maxIngredientStep + 1;
	itemStepCache.set(itemId, step);
	return step;
}

/**
 * Calculate the step for a node in the material tree.
 * Step 1 = leaf nodes (raw materials), Step N = max(children steps) + 1
 * @deprecated Use getItemNaturalStep instead for consistent step regardless of inventory
 */
function getNodeStep(node: MaterialNode): number {
	if (node.children.length === 0) return 1;
	return 1 + Math.max(...node.children.map(getNodeStep));
}

/**
 * Get a unique key for a material node
 */
function getMaterialKey(node: MaterialNode): string {
	if (node.nodeType === 'cargo') {
		return `cargo-${node.cargo!.id}`;
	}
	return `item-${node.item!.id}`;
}

/**
 * Get profession for a cargo node
 */
function getCargoProfession(cargoId: number): string {
	return gameData.cargoToSkill.get(cargoId) || 'Gathering';
}

/**
 * Flatten material tree to aggregated list with step and profession information.
 * Includes ALL nodes (not just leaves), with step indicating crafting order.
 * Step is based on recipe structure, not current inventory state.
 */
export function flattenMaterialTree(tree: MaterialNode): FlatMaterial[] {
	const materials = new Map<string, { material: FlatMaterial; minStep: number }>();

	function traverse(node: MaterialNode, isRoot: boolean = false): void {
		const nodeKey = getMaterialKey(node);

		// Determine step and profession based on node type
		let step: number;
		let profession: string;

		if (node.nodeType === 'cargo') {
			// Cargo is always step 1 (gathered)
			step = 1;
			profession = getCargoProfession(node.cargo!.id);
		} else {
			// Item - use existing logic
			step = getItemNaturalStep(node.item!.id);
			profession = getItemProfession(node.item!.id);
		}

		// Skip the root node (it's the final craft, shown separately in UI)
		if (!isRoot) {
			const existing = materials.get(nodeKey);
			if (existing) {
				existing.material.quantity += node.quantity;
				existing.minStep = Math.min(existing.minStep, step);
			} else {
				if (node.nodeType === 'cargo') {
					materials.set(nodeKey, {
						material: {
							nodeType: 'cargo',
							cargoId: node.cargo!.id,
							cargo: node.cargo,
							quantity: node.quantity,
							tier: node.tier,
							step: step,
							profession: profession
						},
						minStep: step
					});
				} else {
					materials.set(nodeKey, {
						material: {
							nodeType: 'item',
							itemId: node.item!.id,
							item: node.item,
							quantity: node.quantity,
							tier: node.tier,
							step: step,
							profession: profession
						},
						minStep: step
					});
				}
			}
		}

		// Traverse children
		for (const child of node.children) {
			traverse(child, false);
		}
	}

	traverse(tree, true);

	// Finalize: use minStep for each item (items aggregate to lowest step)
	return Array.from(materials.values()).map(({ material, minStep }) => ({
		...material,
		step: minStep
	}));
}

/**
 * Recalculate material quantities to optimize for batch recipes.
 *
 * The tree builds quantities with each branch calculating ceil(need/output) independently.
 * When multiple branches need the same item, this over-counts because:
 *   Branch A: need 2, ceil(2/10) = 1 craft
 *   Branch B: need 2, ceil(2/10) = 1 craft
 *   Total: 2 crafts (but we only need ceil(4/10) = 1 craft)
 *
 * This function recalculates from the top down using aggregated demands.
 * Only applies to items (not cargo), as cargo doesn't have recipes.
 */
function optimizeBatchQuantities(
	flatMaterials: Map<string, FlatMaterial>,
	itemEntries: ItemListEntry[]
): void {
	// Extract item IDs from materials that are items (not cargo)
	const allItemIds = new Set<number>();
	for (const [key, mat] of flatMaterials) {
		if (mat.nodeType === 'item' && mat.itemId !== undefined) {
			allItemIds.add(mat.itemId);
		}
	}
	// Add root item IDs from list entries
	for (const entry of itemEntries) {
		allItemIds.add(entry.itemId);
	}

	// Get recipe for each item (using same logic as tree building)
	const itemRecipes = new Map<number, Recipe | null>();
	for (const itemId of allItemIds) {
		const item = getItemById(itemId);
		if (!item) {
			itemRecipes.set(itemId, null);
			continue;
		}

		const itemDetails = getItemWithRecipes(itemId);
		const allRecipes = itemDetails?.craftingRecipes || [];

		// Filter to valid recipes (same logic as calculateMaterialTree)
		const validRecipes = allRecipes.filter(recipe => {
			if (recipe.ingredients.length === 0) return false;
			if (!recipe.ingredients.every(ing => getItemById(ing.itemId) !== undefined)) return false;
			if (item.tier === -1) return true;
			return !recipe.ingredients.some(ing => {
				const ingItem = getItemById(ing.itemId);
				if (!ingItem || ingItem.tier === -1) return false;
				return ingItem.tier > item.tier;
			});
		});

		const sorted = [...validRecipes].sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity));
		itemRecipes.set(itemId, sorted[0] || null);
	}

	// Calculate correct demands top-down
	const correctDemands = new Map<number, number>();

	// Initialize with list item demands (the roots)
	for (const entry of itemEntries) {
		correctDemands.set(entry.itemId, (correctDemands.get(entry.itemId) || 0) + entry.quantity);
	}

	// Process items by step (highest step first = finished products first, raw materials last)
	const itemSteps = new Map<number, number>();
	for (const itemId of allItemIds) {
		itemSteps.set(itemId, getItemNaturalStep(itemId));
	}

	const sortedItemIds = [...allItemIds].sort((a, b) =>
		(itemSteps.get(b) || 0) - (itemSteps.get(a) || 0)
	);

	for (const itemId of sortedItemIds) {
		const demand = correctDemands.get(itemId) || 0;
		if (demand <= 0) continue;

		const recipe = itemRecipes.get(itemId);
		if (!recipe) continue; // Raw material, no children to calculate

		// Calculate optimal craft count from aggregated demand
		const craftCount = Math.ceil(demand / recipe.outputQuantity);

		// Add ingredient demands (only for item ingredients, not cargo)
		for (const ing of recipe.ingredients) {
			const ingDemand = craftCount * ing.quantity;
			correctDemands.set(ing.itemId, (correctDemands.get(ing.itemId) || 0) + ingDemand);
		}
	}

	// Update flatMaterials with correct quantities (only items)
	for (const [key, mat] of flatMaterials) {
		if (mat.nodeType === 'item' && mat.itemId !== undefined) {
			const correct = correctDemands.get(mat.itemId);
			if (correct !== undefined) {
				mat.quantity = correct;
			}
		}
	}
}

/**
 * Calculate all material requirements for a crafting list
 * Uses cached full trees and propagates inventory through them
 * @param listId - The list to calculate for
 * @param manualOverrides - Optional map of itemId -> quantity for manual "have" amounts
 * @param checkedOff - Optional set of itemIds that are manually marked complete
 * @param recipePreferences - Optional map of recipe preferences for items in tree
 */
export async function calculateListRequirements(
	listId: string,
	manualOverrides?: Map<number, number>,
	checkedOff?: Set<number>,
	recipePreferences?: Map<string, number>
): Promise<MaterialRequirement[]> {
	const list = crafting.lists.find((l) => l.id === listId);
	if (!list || list.entries.length === 0) return [];

	// Get or build cached trees (full trees, no inventory reduction) with recipe preferences
	const trees = await getListTrees(list, recipePreferences);
	if (trees.length === 0) return [];

	// Build "have" maps: merge inventory with manual overrides (manual takes precedence)
	const baseItemInventory = getAggregatedInventoryForSources(list.enabledSourceIds);
	const baseCargoInventory = getAggregatedCargoForSources(list.enabledSourceIds);

	const haveItems = new Map<number, number>();
	for (const [itemId, agg] of baseItemInventory) {
		const manualQty = manualOverrides?.get(itemId);
		haveItems.set(itemId, manualQty !== undefined ? manualQty : agg.totalQuantity);
	}
	// Add manual overrides for items not in inventory
	if (manualOverrides) {
		for (const [itemId, qty] of manualOverrides) {
			if (!haveItems.has(itemId)) {
				haveItems.set(itemId, qty);
			}
		}
	}

	const haveCargo = new Map<number, number>();
	for (const [cargoId, agg] of baseCargoInventory) {
		haveCargo.set(cargoId, agg.totalQuantity);
	}

	// Compute remaining needs by propagating inventory through the tree
	const { needs, parentContributions: rawContributions } = computeRemainingNeeds(trees, haveItems, haveCargo, checkedOff);

	// Track root contributions for each material (DEV only)
	const rootContributions = new Map<string, RootItemContribution[]>();

	// Helper to get material key
	function getMaterialKey(mat: FlatMaterial): string {
		if (mat.nodeType === 'cargo') {
			return `cargo-${mat.cargoId}`;
		}
		return `item-${mat.itemId}`;
	}

	// Flatten trees to get base info (step, item details)
	const flatMaterials = new Map<string, FlatMaterial>();
	for (let i = 0; i < trees.length; i++) {
		const tree = trees[i];
		const entry = list.entries[i];

		// Get root name for contributions
		let rootName: string;
		let rootId: number;
		if (isItemEntry(entry)) {
			const rootItem = getItemById(entry.itemId);
			rootName = rootItem?.name || `Item #${entry.itemId}`;
			rootId = entry.itemId;
		} else {
			const rootCargo = getCargoById(entry.cargoId);
			rootName = rootCargo?.name || `Cargo #${entry.cargoId}`;
			rootId = entry.cargoId;
		}

		const flattened = flattenMaterialTree(tree);
		for (const mat of flattened) {
			const matKey = getMaterialKey(mat);

			// Track root contribution (for DEV debugging)
			if (import.meta.env.DEV) {
				const contributions = rootContributions.get(matKey) || [];
				contributions.push({
					rootItemId: rootId,
					rootItemName: rootName,
					quantity: entry.quantity,
					contribution: mat.quantity
				});
				rootContributions.set(matKey, contributions);
			}

			// Aggregate flat materials (existing logic)
			const existing = flatMaterials.get(matKey);
			if (existing) {
				existing.quantity += mat.quantity;
			} else {
				flatMaterials.set(matKey, { ...mat });
			}
		}
	}

	// Optimize quantities for batch recipes (only for items, not cargo)
	const itemEntries = list.entries.filter(isItemEntry);
	optimizeBatchQuantities(flatMaterials, itemEntries);

	// Aggregate parent contributions by parent node key
	// Only works for items (parent contributions track item inventory, not cargo)
	function aggregateContributions(materialKey: string): ParentContribution[] | undefined {
		const contributions = rawContributions.get(materialKey);
		if (!contributions || contributions.length === 0) return undefined;

		// Aggregate by parent node key, then extract item IDs for items only
		const byParent = new Map<string, { parentQuantityUsed: number; coverage: number }>();
		for (const c of contributions) {
			const existing = byParent.get(c.parentNodeKey);
			if (existing) {
				// Take max of parentQuantityUsed (same inventory used), sum coverage
				existing.parentQuantityUsed = Math.max(existing.parentQuantityUsed, c.parentQuantityUsed);
				existing.coverage += c.coverage;
			} else {
				byParent.set(c.parentNodeKey, {
					parentQuantityUsed: c.parentQuantityUsed,
					coverage: c.coverage
				});
			}
		}

		// Convert to ParentContribution[] - only include item parents (not cargo)
		const result: ParentContribution[] = [];
		for (const [parentKey, data] of byParent) {
			// Parse parent key to get item ID (only for items, format: "item-123")
			if (parentKey.startsWith('item-')) {
				const parentItemId = parseInt(parentKey.substring(5), 10);
				if (!isNaN(parentItemId)) {
					result.push({
						parentItemId,
						parentQuantityUsed: data.parentQuantityUsed,
						coverage: data.coverage
					});
				}
			}
			// Skip cargo parents as they don't have inventory tracking
		}

		return result.length > 0 ? result : undefined;
	}

	// Build final requirements
	const result: MaterialRequirement[] = [];

	for (const [materialKey, flatMat] of flatMaterials) {
		const need = needs.get(materialKey);
		const baseRequired = flatMat.quantity;
		// Cap remaining at baseRequired since we optimized quantities after tree traversal
		// The tree may have over-counted, so remaining from tree could exceed optimized baseRequired
		const remaining = Math.min(need?.remaining ?? 0, baseRequired);

		// "have" is the effective amount covered, including propagation
		// e.g., if you have Rough Planks, that "covers" some Wood requirement
		const effectiveHave = baseRequired - remaining;

		result.push({
			...flatMat,
			quantity: flatMat.quantity, // Base quantity from full tree
			baseRequired, // Full requirement (stable, from full tree)
			remaining, // After propagation (what you still need)
			have: effectiveHave, // Effective amount covered (including propagation)
			isComplete: remaining === 0,
			parentContributions: aggregateContributions(materialKey),
			rootContributions: import.meta.env.DEV ? rootContributions.get(materialKey) : undefined
		});
	}

	// Sort by step ascending, then tier ascending within each step
	result.sort((a, b) => {
		if (a.step !== b.step) return a.step - b.step;
		return a.tier - b.tier;
	});

	return result;
}

/**
 * Group material requirements by tier
 */
export function groupRequirementsByTier(requirements: MaterialRequirement[]): TierGroup[] {
	const groups = new Map<number, MaterialRequirement[]>();

	for (const req of requirements) {
		const tierReqs = groups.get(req.tier) || [];
		tierReqs.push(req);
		groups.set(req.tier, tierReqs);
	}

	const result: TierGroup[] = [];

	for (const [tier, materials] of groups) {
		const totalRequired = materials.reduce((sum, m) => sum + m.baseRequired, 0);
		const totalAvailable = materials.reduce((sum, m) => sum + m.have, 0);

		result.push({
			tier,
			materials,
			totalRequired,
			totalAvailable,
			isComplete: materials.every((m) => m.isComplete)
		});
	}

	// Sort by tier ascending
	result.sort((a, b) => a.tier - b.tier);

	return result;
}

/**
 * Group material requirements by crafting step
 * Step 1 = raw materials (gathered), Step 2+ = crafted items
 * Sorted by tier, then profession within each step
 */
export function groupRequirementsByStep(requirements: MaterialRequirement[]): StepGroup[] {
	const groups = new Map<number, MaterialRequirement[]>();

	for (const req of requirements) {
		const step = req.step || 1; // Default to step 1 if missing
		const stepReqs = groups.get(step) || [];
		stepReqs.push(req);
		groups.set(step, stepReqs);
	}

	const result: StepGroup[] = [];

	for (const [step, materials] of groups) {
		// Sort by tier, then profession within step
		materials.sort((a, b) => {
			if (a.tier !== b.tier) return a.tier - b.tier;
			return a.profession.localeCompare(b.profession);
		});

		const totalRequired = materials.reduce((sum, m) => sum + m.baseRequired, 0);
		const totalAvailable = materials.reduce((sum, m) => sum + m.have, 0);

		result.push({
			step,
			label: step === 1 ? 'Gathering' : `Step ${step}`,
			materials,
			totalRequired,
			totalAvailable,
			isComplete: materials.every((m) => m.isComplete)
		});
	}

	// Sort by step ascending (step 1 first)
	result.sort((a, b) => a.step - b.step);

	return result;
}

/**
 * Group material requirements by profession
 * Sorted by tier, then step within each profession
 */
export function groupRequirementsByProfession(requirements: MaterialRequirement[]): ProfessionGroup[] {
	const groups = new Map<string, MaterialRequirement[]>();

	for (const req of requirements) {
		const profession = req.profession || 'Unknown';
		const profReqs = groups.get(profession) || [];
		profReqs.push(req);
		groups.set(profession, profReqs);
	}

	const result: ProfessionGroup[] = [];

	for (const [profession, materials] of groups) {
		// Sort by tier, then step within profession
		materials.sort((a, b) => {
			if (a.tier !== b.tier) return a.tier - b.tier;
			return a.step - b.step;
		});

		const totalRequired = materials.reduce((sum, m) => sum + m.baseRequired, 0);
		const totalAvailable = materials.reduce((sum, m) => sum + m.have, 0);

		result.push({
			profession,
			materials,
			totalRequired,
			totalAvailable,
			isComplete: materials.every((m) => m.isComplete)
		});
	}

	// Sort professions alphabetically
	result.sort((a, b) => a.profession.localeCompare(b.profession));

	return result;
}

/**
 * Group material requirements by step, with profession sub-groups within each step
 * For combined view mode
 */
export function groupRequirementsByStepWithProfessions(requirements: MaterialRequirement[]): StepWithProfessionsGroup[] {
	const stepGroups = new Map<number, Map<string, MaterialRequirement[]>>();

	for (const req of requirements) {
		const step = req.step || 1;
		const profession = req.profession || 'Unknown';

		if (!stepGroups.has(step)) {
			stepGroups.set(step, new Map());
		}
		const profGroups = stepGroups.get(step)!;

		const profReqs = profGroups.get(profession) || [];
		profReqs.push(req);
		profGroups.set(profession, profReqs);
	}

	const result: StepWithProfessionsGroup[] = [];

	for (const [step, profGroups] of stepGroups) {
		const professionGroups: ProfessionGroup[] = [];

		for (const [profession, materials] of profGroups) {
			// Sort by tier within profession
			materials.sort((a, b) => a.tier - b.tier);

			const totalRequired = materials.reduce((sum, m) => sum + m.baseRequired, 0);
			const totalAvailable = materials.reduce((sum, m) => sum + m.have, 0);

			professionGroups.push({
				profession,
				materials,
				totalRequired,
				totalAvailable,
				isComplete: materials.every((m) => m.isComplete)
			});
		}

		// Sort professions alphabetically
		professionGroups.sort((a, b) => a.profession.localeCompare(b.profession));

		const allMaterials = professionGroups.flatMap(pg => pg.materials);
		const totalRequired = allMaterials.reduce((sum, m) => sum + m.baseRequired, 0);
		const totalAvailable = allMaterials.reduce((sum, m) => sum + m.have, 0);

		result.push({
			step,
			label: step === 1 ? 'Gathering' : `Step ${step}`,
			professionGroups,
			totalRequired,
			totalAvailable,
			isComplete: allMaterials.every((m) => m.isComplete)
		});
	}

	// Sort by step ascending
	result.sort((a, b) => a.step - b.step);

	return result;
}

/**
 * Calculate overall progress for a list
 */
export async function calculateListProgress(
	listId: string
): Promise<{ completed: number; total: number; percentage: number }> {
	const requirements = await calculateListRequirements(listId);

	if (requirements.length === 0) {
		return { completed: 0, total: 0, percentage: 100 };
	}

	const completed = requirements.filter((r) => r.isComplete).length;
	const total = requirements.length;
	const percentage = Math.round((completed / total) * 100);

	return { completed, total, percentage };
}
