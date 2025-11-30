/**
 * Crafting lists state management
 * Persisted to IndexedDB
 */

import type { CraftingList, CraftingListItem, CraftingListEntry, MaterialRequirement, TierGroup, StepGroup, ProfessionGroup, StepWithProfessionsGroup, ParentContribution, RootItemContribution, ItemListEntry, CargoListEntry, BuildingListEntry } from '$lib/types/app';
import { isItemEntry, isCargoEntry, isBuildingEntry } from '$lib/types/app';
import type { MaterialNode, FlatMaterial, Item, Recipe, Cargo, MaterialNodeType } from '$lib/types/game';
import { getCachedLists, getCachedList, saveList, deleteList as deleteCachedList, deleteListProgress } from '$lib/services/cache';
import { gameData, getItemById, getItemWithRecipes, getCargoById, getConstructionRecipeById, getBuildingDescriptionById, findConstructionRecipeByBuildingId } from './game-data.svelte';
import { allocateMaterialsFromSources, getAggregatedInventoryForSources, getAggregatedCargoForSources } from './inventory.svelte';
import {
	type RecipeContext,
	calculateItemNaturalStep as calcStep,
	calculateItemProfession as calcProfession,
	getCargoProfession as getCargoProf,
	calculateCargoNaturalStep as calcCargoStep
} from '$lib/utils/recipe-utils';

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
		} else if (isCargoEntry(e)) {
			return `c:${e.cargoId}:${e.quantity}`;
		} else {
			return `b:${e.constructionRecipeId}:${e.quantity}`;
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
			const tree = await calculateCargoMaterialTree(
				entry.cargoId,
				entry.quantity,
				recipePreferences
			);
			if (tree) {
				trees.push(tree);
			}
		} else if (isBuildingEntry(entry)) {
			const tree = await calculateBuildingMaterialTree(
				entry.constructionRecipeId,
				entry.quantity,
				recipePreferences
			);
			if (tree) {
				trees.push(tree);
			}
		}
	}

	return trees;
}

/**
 * Calculate material tree for a cargo item.
 * If the cargo has a crafting recipe, expand it; otherwise treat as leaf node.
 * @param recipePreferences - Optional map of recipe preferences for items in tree
 */
async function calculateCargoMaterialTree(
	cargoId: number,
	quantity: number,
	recipePreferences?: Map<string, number>,
	depth = 0,
	maxDepth = 50
): Promise<MaterialNode | null> {
	const cargo = getCargoById(cargoId);
	if (!cargo) return null;

	// Check if this cargo has a crafting recipe
	const cargoRecipes = gameData.cargoRecipes.get(cargoId) || [];

	// No recipes or max depth reached = leaf node (gathered cargo)
	if (cargoRecipes.length === 0 || depth >= maxDepth) {
		return {
			nodeType: 'cargo',
			cargo,
			quantity,
			tier: cargo.tier,
			children: []
		};
	}

	// Select recipe: use preference if available, otherwise cheapest
	const sortedRecipes = [...cargoRecipes].sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity));
	let recipe = sortedRecipes[0];

	if (recipePreferences) {
		const preferredId = recipePreferences.get(`cargo-${cargoId}`);
		if (preferredId !== undefined) {
			const preferredRecipe = cargoRecipes.find(r => r.id === preferredId);
			recipe = preferredRecipe || sortedRecipes[0];
		}
	}

	// Calculate craft count
	const craftCount = Math.ceil(quantity / recipe.outputQuantity);

	// Build children from recipe ingredients
	const children: MaterialNode[] = [];

	// Process item ingredients
	for (const ingredient of recipe.ingredients) {
		const childNode = await calculateMaterialTree(
			ingredient.itemId,
			ingredient.quantity * craftCount,
			undefined,
			recipePreferences,
			depth + 1,
			maxDepth
		);
		if (childNode) {
			children.push(childNode);
		}
	}

	// Process cargo ingredients (recursive)
	if (recipe.cargoIngredients) {
		for (const cargoIng of recipe.cargoIngredients) {
			const childNode = await calculateCargoMaterialTree(
				cargoIng.cargoId,
				cargoIng.quantity * craftCount,
				recipePreferences,
				depth + 1,
				maxDepth
			);
			if (childNode) {
				children.push(childNode);
			}
		}
	}

	return {
		nodeType: 'cargo',
		cargo,
		quantity,
		tier: cargo.tier,
		children,
		recipeUsed: recipe
	};
}

/**
 * Calculate material tree for a building (construction recipe)
 * Expands item and cargo ingredients, and handles upgrade chains (consumedBuilding)
 * @param recipePreferences - Optional map of recipe preferences for items in tree
 */
async function calculateBuildingMaterialTree(
	constructionRecipeId: number,
	quantity: number,
	recipePreferences?: Map<string, number>,
	depth = 0,
	maxDepth = 50
): Promise<MaterialNode | null> {
	const recipe = getConstructionRecipeById(constructionRecipeId);
	if (!recipe) return null;

	const building = getBuildingDescriptionById(recipe.buildingDescriptionId);
	if (!building) return null;

	// Prevent infinite recursion
	if (depth >= maxDepth) {
		return {
			nodeType: 'building',
			building,
			constructionRecipe: recipe,
			quantity,
			tier: 1, // Buildings don't have tiers, default to 1
			children: []
		};
	}

	const children: MaterialNode[] = [];

	// Process item ingredients
	for (const itemStack of recipe.consumedItemStacks) {
		const childNode = await calculateMaterialTree(
			itemStack.itemId,
			itemStack.quantity * quantity,
			undefined,
			recipePreferences,
			depth + 1,
			maxDepth
		);
		if (childNode) {
			children.push(childNode);
		}
	}

	// Process cargo ingredients (may have their own recipes)
	for (const cargoStack of recipe.consumedCargoStacks) {
		const childNode = await calculateCargoMaterialTree(
			cargoStack.cargoId,
			cargoStack.quantity * quantity,
			recipePreferences,
			depth + 1,
			maxDepth
		);
		if (childNode) {
			children.push(childNode);
		}
	}

	// Process consumed building (upgrade chain)
	if (recipe.consumedBuilding > 0) {
		// Find the construction recipe that builds the consumed building
		const baseRecipe = findConstructionRecipeByBuildingId(recipe.consumedBuilding);
		if (baseRecipe) {
			const baseNode = await calculateBuildingMaterialTree(
				baseRecipe.id,
				quantity,
				recipePreferences,
				depth + 1,
				maxDepth
			);
			if (baseNode) {
				children.push(baseNode);
			}
		}
	}

	return {
		nodeType: 'building',
		building,
		constructionRecipe: recipe,
		quantity,
		tier: 1, // Buildings don't have tiers
		children
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
	if (node.nodeType === 'building') {
		return `building-${node.constructionRecipe!.id}`;
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
	if (node.nodeType === 'building') {
		return node.constructionRecipe!.id;
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

		// Handle cargo nodes - they now have inventory tracking AND can have children (recipes)
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

			// Handle cargo children (if this cargo has a crafting recipe)
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

						// Record partial coverage from this cargo's inventory
						if (childCoverage > 0 && useFromInventory > 0) {
							recordContribution(childKey, nodeKey, useFromInventory, childCoverage);
							if (child.children.length > 0 && childCoverage > 0) {
								const coveredRatio = childCoverage / childOriginal;
								recordPartialCoverageForDescendants(child, nodeKey, useFromInventory, coveredRatio);
							}
						}

						traverse(child, childNeeded);
					}
				} else if (useFromInventory > 0) {
					// Full coverage: record coverage for ALL descendants in subtree
					recordCoverageForDescendants(node, nodeKey, useFromInventory);
				}
			}
			return;
		}

		// Handle building nodes - no inventory tracking, always need to build
		if (node.nodeType === 'building') {
			// Buildings always need to be constructed (no inventory)
			const existing = needs.get(nodeKey) || { baseRequired: 0, remaining: 0 };
			existing.baseRequired += neededQuantity;
			existing.remaining += neededQuantity; // Always need full amount
			needs.set(nodeKey, existing);

			// Process children (item and cargo requirements)
			for (const child of node.children) {
				traverse(child, child.quantity);
			}
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
 * Add building (construction recipe) to a list
 */
export async function addBuildingToList(listId: string, constructionRecipeId: number, quantity: number): Promise<void> {
	const list = crafting.lists.find((l) => l.id === listId);
	if (!list) return;

	// Check if building entry already exists
	const existingEntry = list.entries.find(
		(e) => isBuildingEntry(e) && e.constructionRecipeId === constructionRecipeId
	);

	if (existingEntry) {
		existingEntry.quantity += quantity;
	} else {
		const newEntry: BuildingListEntry = {
			id: crypto.randomUUID(),
			type: 'building',
			constructionRecipeId,
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
 * Shared list entry from API (without client-side fields)
 */
interface SharedListEntry {
	type: 'item' | 'cargo' | 'building';
	itemId?: number;
	cargoId?: number;
	constructionRecipeId?: number;
	quantity: number;
	recipeId?: number;
}

/**
 * Shared list data from API
 */
export interface SharedListData {
	name: string;
	description?: string;
	entries: SharedListEntry[];
}

/**
 * Import a shared list as a new local list.
 * Creates a fresh list with new IDs, no source restrictions.
 */
export async function importSharedList(sharedList: SharedListData): Promise<CraftingList> {
	const now = Date.now();

	// Convert shared entries to full CraftingListEntry objects
	const entries: CraftingListEntry[] = sharedList.entries.map((entry) => {
		const base = {
			id: crypto.randomUUID(),
			quantity: entry.quantity,
			addedAt: now
		};

		if (entry.type === 'item') {
			return {
				...base,
				type: 'item' as const,
				itemId: entry.itemId!,
				recipeId: entry.recipeId
			};
		} else if (entry.type === 'cargo') {
			return {
				...base,
				type: 'cargo' as const,
				cargoId: entry.cargoId!
			};
		} else {
			return {
				...base,
				type: 'building' as const,
				constructionRecipeId: entry.constructionRecipeId!
			};
		}
	});

	const imported: CraftingList = {
		id: crypto.randomUUID(),
		name: `${sharedList.name} (Imported)`,
		description: sharedList.description,
		entries,
		enabledSourceIds: [], // Empty = all sources enabled
		createdAt: now,
		updatedAt: now
	};

	crafting.lists.push(imported);
	await saveList(toPlainList(imported));

	return imported;
}

/**
 * Calculate material requirements from raw entries without requiring storage.
 * Used for previewing shared lists before import.
 * Returns requirements without inventory deductions (baseRequired = remaining).
 */
export async function calculateRequirementsFromEntries(
	entries: SharedListEntry[]
): Promise<FlatMaterial[]> {
	const trees: MaterialNode[] = [];

	// Build trees for each entry
	for (const entry of entries) {
		if (entry.type === 'item' && entry.itemId) {
			const tree = await calculateMaterialTree(
				entry.itemId,
				entry.quantity,
				entry.recipeId
			);
			if (tree) trees.push(tree);
		} else if (entry.type === 'cargo' && entry.cargoId) {
			const tree = await calculateCargoMaterialTree(entry.cargoId, entry.quantity);
			if (tree) trees.push(tree);
		} else if (entry.type === 'building' && entry.constructionRecipeId) {
			const tree = await calculateBuildingMaterialTree(entry.constructionRecipeId, entry.quantity);
			if (tree) trees.push(tree);
		}
	}

	if (trees.length === 0) return [];

	// Flatten and aggregate all materials
	const flatMaterials = new Map<string, FlatMaterial>();

	for (const tree of trees) {
		const flattened = flattenMaterialTree(tree);
		for (const mat of flattened) {
			const key = mat.nodeType === 'cargo' ? `cargo-${mat.cargoId}` : `item-${mat.itemId}`;
			const existing = flatMaterials.get(key);
			if (existing) {
				existing.quantity += mat.quantity;
			} else {
				flatMaterials.set(key, { ...mat });
			}
		}
	}

	// Sort by step ascending, then tier ascending
	const result = Array.from(flatMaterials.values());
	result.sort((a, b) => {
		if (a.step !== b.step) return a.step - b.step;
		return a.tier - b.tier;
	});

	return result;
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
 * Update share info for a list
 */
export async function updateListShare(
	listId: string,
	shareToken: string,
	shareExpiresAt: number
): Promise<void> {
	const list = crafting.lists.find((l) => l.id === listId);
	if (!list) return;

	list.shareToken = shareToken;
	list.shareExpiresAt = shareExpiresAt;
	list.updatedAt = Date.now();
	await saveList(toPlainList(list));
}

/**
 * Clear share info for a list (e.g., when share expires or is revoked)
 */
export async function clearListShare(listId: string): Promise<void> {
	const list = crafting.lists.find((l) => l.id === listId);
	if (!list) return;

	delete list.shareToken;
	delete list.shareExpiresAt;
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

	// Process cargo ingredients (may have their own recipes)
	if (recipe.cargoIngredients) {
		for (const cargoIng of recipe.cargoIngredients) {
			const childNode = await calculateCargoMaterialTree(
				cargoIng.cargoId,
				cargoIng.quantity * craftCount,
				recipePreferences,
				depth + 1,
				maxDepth
			);
			if (childNode) {
				children.push(childNode);
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
 * Cache for cargo step calculations (based on recipe structure)
 */
const cargoStepCache = new Map<number, number>();

/**
 * Cache for item profession calculations
 */
const itemProfessionCache = new Map<number, string>();

/**
 * Clear step and profession caches.
 * Should be called when game data is loaded or refreshed to prevent stale values.
 */
export function clearRecipeCaches(): void {
	itemStepCache.clear();
	cargoStepCache.clear();
	itemProfessionCache.clear();
	listTreeCache.clear(); // Also clear tree cache since trees depend on game data
	console.log('Recipe and tree caches cleared');
}

/**
 * Build a RecipeContext from current gameData state.
 * Used to call the pure utility functions.
 */
function buildRecipeContext(): RecipeContext {
	return {
		items: gameData.items,
		recipes: gameData.recipes,
		cargoRecipes: gameData.cargoRecipes,
		cargos: gameData.cargos,
		cargoToSkill: gameData.cargoToSkill,
		itemToCargoSkill: gameData.itemToCargoSkill,
		itemFromListToSkill: gameData.itemFromListToSkill
	};
}

/**
 * Get the profession/skill for an item based on its cheapest recipe.
 * Uses the pure utility function with caching.
 */
function getItemProfession(itemId: number): string {
	// Check cache first
	if (itemProfessionCache.has(itemId)) {
		return itemProfessionCache.get(itemId)!;
	}

	const ctx = buildRecipeContext();
	const profession = calcProfession(itemId, ctx, gameData.extractionRecipes);
	itemProfessionCache.set(itemId, profession);
	return profession;
}

/**
 * Calculate the natural step for an item based on its cheapest recipe.
 * Uses the pure utility function with caching.
 * Step 1 = raw materials (no recipe), Step N = max(ingredient steps) + 1
 */
function getItemNaturalStep(itemId: number): number {
	// Check cache first
	if (itemStepCache.has(itemId)) {
		return itemStepCache.get(itemId)!;
	}

	const ctx = buildRecipeContext();
	const step = calcStep(itemId, ctx, new Set(), itemStepCache);
	// Note: calcStep already populates the cache, but we ensure it's set
	itemStepCache.set(itemId, step);
	return step;
}

/**
 * Calculate the natural step for a cargo based on its cheapest recipe.
 * Uses the pure utility function with caching.
 * Step 1 = gathered cargo (no recipe), Step N = max(ingredient steps) + 1
 */
function getCargoNaturalStep(cargoId: number): number {
	// Check cache first
	if (cargoStepCache.has(cargoId)) {
		return cargoStepCache.get(cargoId)!;
	}

	const ctx = buildRecipeContext();
	const step = calcCargoStep(cargoId, ctx, new Set(), new Set(), itemStepCache, cargoStepCache);
	// Note: calcCargoStep already populates the cache, but we ensure it's set
	cargoStepCache.set(cargoId, step);
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
	if (node.nodeType === 'building') {
		return `building-${node.constructionRecipe!.id}`;
	}
	return `item-${node.item!.id}`;
}

/**
 * Get profession for a cargo node.
 * Uses the pure utility function.
 */
function getCargoProfession(cargoId: number): string {
	const ctx = buildRecipeContext();
	return getCargoProf(cargoId, ctx);
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
			// Cargo step calculated from recipes (crafted cargo like Timber) or step 1 (gathered)
			step = getCargoNaturalStep(node.cargo!.id);
			profession = getCargoProfession(node.cargo!.id);
		} else if (node.nodeType === 'building') {
			// Buildings are construction (highest step above their materials)
			// Calculate step based on children's max step + 1
			step = node.children.length === 0 ? 1 : 1 + Math.max(...node.children.map(c => {
				if (c.nodeType === 'cargo') return getCargoNaturalStep(c.cargo!.id);
				if (c.nodeType === 'building') return getNodeStep(c);
				return getItemNaturalStep(c.item!.id);
			}));
			profession = 'Construction';
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
				} else if (node.nodeType === 'building') {
					materials.set(nodeKey, {
						material: {
							nodeType: 'building',
							buildingId: node.constructionRecipe!.id,
							building: node.building,
							constructionRecipe: node.constructionRecipe,
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
		} else if (isCargoEntry(entry)) {
			const rootCargo = getCargoById(entry.cargoId);
			rootName = rootCargo?.name || `Cargo #${entry.cargoId}`;
			rootId = entry.cargoId;
		} else {
			// Building entry - will be handled when building support is added
			rootName = `Building #${entry.constructionRecipeId}`;
			rootId = entry.constructionRecipeId;
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
	// Works for both item and cargo parents
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

		// Convert to ParentContribution[] - include both item and cargo parents
		const result: ParentContribution[] = [];
		for (const [parentKey, data] of byParent) {
			// Parse parent key to get item ID (format: "item-123")
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
			// Parse parent key to get cargo ID (format: "cargo-123")
			else if (parentKey.startsWith('cargo-')) {
				const parentCargoId = parseInt(parentKey.substring(6), 10);
				if (!isNaN(parentCargoId)) {
					result.push({
						parentCargoId,
						parentQuantityUsed: data.parentQuantityUsed,
						coverage: data.coverage
					});
				}
			}
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
