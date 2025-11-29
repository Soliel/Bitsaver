/**
 * Crafting lists state management
 * Persisted to IndexedDB
 */

import type { CraftingList, CraftingListItem, MaterialRequirement, TierGroup, StepGroup } from '$lib/types/app';
import type { MaterialNode, FlatMaterial, Item, Recipe } from '$lib/types/game';
import { getCachedLists, getCachedList, saveList, deleteList as deleteCachedList } from '$lib/services/cache';
import { gameData, getItemById, getItemWithRecipes } from './game-data.svelte';
import { allocateMaterialsFromSources, getAggregatedInventoryForSources } from './inventory.svelte';

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
 * Generate a hash of list items to detect changes
 */
function hashListItems(items: CraftingListItem[]): string {
	return items.map(i => `${i.itemId}:${i.quantity}:${i.recipeId || 0}`).join('|');
}

/**
 * Build full material trees for a list (called when list items change)
 */
async function buildListTrees(list: CraftingList): Promise<MaterialNode[]> {
	const trees: MaterialNode[] = [];

	for (const listItem of list.items) {
		const tree = await calculateMaterialTree(
			listItem.itemId,
			listItem.quantity,
			listItem.recipeId
		);
		if (tree) {
			trees.push(tree);
		}
	}

	return trees;
}

/**
 * Get or build cached trees for a list
 */
async function getListTrees(list: CraftingList): Promise<MaterialNode[]> {
	const currentHash = hashListItems(list.items);
	const cached = listTreeCache.get(list.id);

	if (cached && cached.listItemsHash === currentHash) {
		return cached.trees;
	}

	// Build new trees
	const trees = await buildListTrees(list);
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
 * Compute remaining needs by propagating inventory through the tree
 * @param trees - Material trees to process
 * @param have - Map of itemId -> quantity you have
 * @param checkedOff - Set of itemIds that are manually marked complete
 * Returns: Map<itemId, { baseRequired, remaining }>
 */
function computeRemainingNeeds(
	trees: MaterialNode[],
	have: Map<number, number>,
	checkedOff?: Set<number>
): Map<number, { baseRequired: number; remaining: number }> {
	const needs = new Map<number, { baseRequired: number; remaining: number }>();

	// Track how much inventory we've "used" across tree branches
	const usedInventory = new Map<number, number>();

	function traverse(node: MaterialNode, neededQuantity: number): void {
		const itemId = node.item.id;

		// If item is checked off, treat as fully satisfied
		const isCheckedOff = checkedOff?.has(itemId) ?? false;

		// Get current inventory and how much we've already used
		const totalHave = have.get(itemId) || 0;
		const alreadyUsed = usedInventory.get(itemId) || 0;

		// If checked off, available is infinite (use full needed amount)
		const availableToUse = isCheckedOff
			? neededQuantity
			: Math.max(0, totalHave - alreadyUsed);

		// How much can we satisfy from inventory (or checked off)?
		const useFromInventory = Math.min(availableToUse, neededQuantity);
		if (useFromInventory > 0 && !isCheckedOff) {
			usedInventory.set(itemId, alreadyUsed + useFromInventory);
		}

		// Remaining after using inventory
		const stillNeeded = neededQuantity - useFromInventory;

		// Aggregate base requirements and remaining needs
		const existing = needs.get(itemId) || { baseRequired: 0, remaining: 0 };
		existing.baseRequired += neededQuantity;
		existing.remaining += stillNeeded;
		needs.set(itemId, existing);

		// If we still need to craft/gather any, recurse to children
		if (stillNeeded > 0 && node.children.length > 0 && node.recipeUsed) {
			const craftCount = Math.ceil(stillNeeded / node.recipeUsed.outputQuantity);
			const originalCraftCount = Math.ceil(node.quantity / node.recipeUsed.outputQuantity);

			for (const child of node.children) {
				// Calculate how many of this child we need based on craft count ratio
				const childNeeded = Math.ceil(child.quantity * craftCount / originalCraftCount);
				traverse(child, childNeeded);
			}
		}
	}

	// Process each tree (each list item)
	for (const tree of trees) {
		traverse(tree, tree.quantity);
	}

	return needs;
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
 * Initialize crafting lists from cache
 */
export async function initializeCrafting(): Promise<void> {
	crafting.isLoading = true;

	try {
		const lists = await getCachedLists();
		crafting.lists = lists;
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
		items: [],
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

	// Check if item already exists with the same recipe
	const existingItem = list.items.find((i) => i.itemId === itemId && i.recipeId === recipeId);

	if (existingItem) {
		existingItem.quantity += quantity;
	} else {
		list.items.push({
			id: crypto.randomUUID(),
			itemId,
			quantity,
			recipeId,
			addedAt: Date.now()
		});
	}

	list.updatedAt = Date.now();
	await saveList(toPlainList(list));
}

/**
 * Update item quantity in a list
 */
export async function updateItemQuantity(
	listId: string,
	itemId: number,
	quantity: number
): Promise<void> {
	const list = crafting.lists.find((l) => l.id === listId);
	if (!list) return;

	const item = list.items.find((i) => i.itemId === itemId);
	if (item) {
		item.quantity = Math.max(0, quantity);
		list.updatedAt = Date.now();
		await saveList(toPlainList(list));
	}
}

/**
 * Remove item from a list
 */
export async function removeItemFromList(listId: string, itemId: number): Promise<void> {
	const list = crafting.lists.find((l) => l.id === listId);
	if (!list) return;

	list.items = list.items.filter((i) => i.itemId !== itemId);
	list.updatedAt = Date.now();
	await saveList(toPlainList(list));
}

/**
 * Clear all items from a list
 */
export async function clearList(listId: string): Promise<void> {
	const list = crafting.lists.find((l) => l.id === listId);
	if (!list) return;

	list.items = [];
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
		items: original.items.map((item) => ({
			...item,
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
 * Calculate material tree for an item (full tree, no inventory reduction)
 * @param recipeId - Optional specific recipe to use (for top-level item only)
 */
export async function calculateMaterialTree(
	itemId: number,
	quantity: number,
	recipeId?: number,
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
			item,
			quantity,
			tier: item.tier,
			children: []
		};
	}

	// Sort recipes by cost and pick the cheapest one
	// User can override with explicit recipeId if needed
	const sortedRecipes = [...recipes].sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity));
	let recipe = sortedRecipes[0];

	// Allow user override if specified
	if (recipeId !== undefined) {
		const selectedRecipe = recipes.find(r => r.id === recipeId);
		if (selectedRecipe) recipe = selectedRecipe;
	}
	const craftCount = Math.ceil(quantity / recipe.outputQuantity);

	// Recursively calculate children
	const children: MaterialNode[] = [];

	for (const ingredient of recipe.ingredients) {
		// Child ingredients use default recipe selection (first available)
		const childNode = await calculateMaterialTree(
			ingredient.itemId,
			ingredient.quantity * craftCount,
			undefined,
			depth + 1,
			maxDepth
		);

		if (childNode) {
			children.push(childNode);
		}
	}

	return {
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
	// 1. All ingredients must be valid Items (can be looked up)
	// 2. Not a downgrade recipe (output tier >= all input tiers)
	const validRecipes = allRecipes.filter(recipe => {
		// Must have ingredients and all must be valid Items
		if (recipe.ingredients.length === 0) return false;
		if (!recipe.ingredients.every(ing => getItemById(ing.itemId) !== undefined)) return false;

		// Filter downgrade recipes
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
 * Flatten material tree to aggregated list with step information.
 * Includes ALL nodes (not just leaves), with step indicating crafting order.
 * Step is based on recipe structure, not current inventory state.
 */
export function flattenMaterialTree(tree: MaterialNode): FlatMaterial[] {
	const materials = new Map<number, { material: FlatMaterial; minStep: number }>();

	function traverse(node: MaterialNode, isRoot: boolean = false): void {
		// Use natural step based on recipe structure, not tree structure
		const step = getItemNaturalStep(node.item.id);

		// Skip the root node (it's the final craft, shown separately in UI)
		if (!isRoot) {
			const existing = materials.get(node.item.id);
			if (existing) {
				existing.material.quantity += node.quantity;
				existing.minStep = Math.min(existing.minStep, step);
			} else {
				materials.set(node.item.id, {
					material: {
						itemId: node.item.id,
						item: node.item,
						quantity: node.quantity,
						tier: node.tier,
						step: step
					},
					minStep: step
				});
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
 * Calculate all material requirements for a crafting list
 * Uses cached full trees and propagates inventory through them
 * @param listId - The list to calculate for
 * @param manualOverrides - Optional map of itemId -> quantity for manual "have" amounts
 * @param checkedOff - Optional set of itemIds that are manually marked complete
 */
export async function calculateListRequirements(
	listId: string,
	manualOverrides?: Map<number, number>,
	checkedOff?: Set<number>
): Promise<MaterialRequirement[]> {
	const list = crafting.lists.find((l) => l.id === listId);
	if (!list || list.items.length === 0) return [];

	// Get or build cached trees (full trees, no inventory reduction)
	const trees = await getListTrees(list);
	if (trees.length === 0) return [];

	// Build "have" map: merge inventory with manual overrides (manual takes precedence)
	const baseInventory = getAggregatedInventoryForSources(list.enabledSourceIds);
	const have = new Map<number, number>();

	for (const [itemId, agg] of baseInventory) {
		const manualQty = manualOverrides?.get(itemId);
		have.set(itemId, manualQty !== undefined ? manualQty : agg.totalQuantity);
	}
	// Add manual overrides for items not in inventory
	if (manualOverrides) {
		for (const [itemId, qty] of manualOverrides) {
			if (!have.has(itemId)) {
				have.set(itemId, qty);
			}
		}
	}

	// Compute remaining needs by propagating inventory through the tree
	const needs = computeRemainingNeeds(trees, have, checkedOff);

	// Flatten trees to get base info (step, item details)
	const flatMaterials = new Map<number, FlatMaterial>();
	for (const tree of trees) {
		const flattened = flattenMaterialTree(tree);
		for (const mat of flattened) {
			const existing = flatMaterials.get(mat.itemId);
			if (existing) {
				existing.quantity += mat.quantity;
			} else {
				flatMaterials.set(mat.itemId, { ...mat });
			}
		}
	}

	// Build final requirements
	const result: MaterialRequirement[] = [];

	for (const [itemId, flatMat] of flatMaterials) {
		const need = needs.get(itemId);
		const baseRequired = flatMat.quantity;
		const remaining = need?.remaining ?? 0;

		// "have" is the effective amount covered, including propagation
		// e.g., if you have Rough Planks, that "covers" some Wood requirement
		const effectiveHave = baseRequired - remaining;

		result.push({
			...flatMat,
			quantity: flatMat.quantity, // Base quantity from full tree
			baseRequired, // Full requirement (stable, from full tree)
			remaining, // After propagation (what you still need)
			have: effectiveHave, // Effective amount covered (including propagation)
			isComplete: remaining === 0
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
		// Sort by tier within step
		materials.sort((a, b) => a.tier - b.tier);

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
