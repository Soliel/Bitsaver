/**
 * Pure utility functions for recipe calculations.
 * These functions are decoupled from Svelte state for testability.
 */

import type { Item, Recipe, Cargo } from '$lib/types/game';

/**
 * Context object containing all data needed for recipe calculations.
 * This replaces direct access to global state, making functions testable.
 */
export interface RecipeContext {
	items: Map<number, Item>;
	recipes: Map<number, Recipe[]>; // outputItemId -> recipes
	cargoRecipes?: Map<number, Recipe[]>; // outputCargoId -> recipes (optional for backward compat)
	cargos: Map<number, Cargo>;
	cargoToSkill: Map<number, string>;
	itemToCargoSkill: Map<number, string>;
	itemFromListToSkill: Map<number, string>;
}

/**
 * Filter recipes to only valid "upgrade" crafting recipes.
 * Rules:
 * 1. Must have some ingredients (item or cargo)
 * 2. All item ingredients must be valid Items (can be looked up)
 * 3. Not a downgrade recipe (output tier >= all input tiers, unless tier is -1)
 */
export function filterValidRecipes(
	recipes: Recipe[],
	item: Item,
	ctx: RecipeContext
): Recipe[] {
	return recipes.filter(recipe => {
		// Must have some ingredients (item or cargo)
		const hasItemIngredients = recipe.ingredients.length > 0;
		const hasCargoIngredients = (recipe.cargoIngredients?.length ?? 0) > 0;
		if (!hasItemIngredients && !hasCargoIngredients) return false;

		// All item ingredients must be valid Items
		if (hasItemIngredients) {
			const allIngredientsValid = recipe.ingredients.every(ing => ctx.items.has(ing.itemId));
			if (!allIngredientsValid) return false;
		}

		// Filter downgrade recipes (only applies to item ingredients)
		if (item.tier === -1) return true; // Ignore tier -1 output items

		const isDowngrade = recipe.ingredients.some(ing => {
			const ingItem = ctx.items.get(ing.itemId);
			if (!ingItem || ingItem.tier === -1) return false; // Ignore tier -1 ingredients
			return ingItem.tier > item.tier;
		});

		return !isDowngrade;
	});
}

/**
 * Get the cheapest recipe from a list of recipes.
 * Returns undefined if list is empty.
 */
export function getCheapestRecipe(recipes: Recipe[]): Recipe | undefined {
	if (recipes.length === 0) return undefined;
	return [...recipes].sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity))[0];
}

/**
 * Calculate the natural crafting step for an item based on its cheapest recipe.
 * Step 1 = raw materials (no valid recipe), Step N = max(ingredient steps) + 1
 *
 * @param itemId - The item to calculate step for
 * @param ctx - Recipe context with items/recipes data
 * @param visited - Set of item IDs already visited (for cycle detection)
 * @param cache - Optional cache to store results
 * @returns The crafting step (1 = gathering, 2+ = crafted)
 */
export function calculateItemNaturalStep(
	itemId: number,
	ctx: RecipeContext,
	visited: Set<number> = new Set(),
	cache?: Map<number, number>
): number {
	// Check cache first
	if (cache?.has(itemId)) {
		return cache.get(itemId)!;
	}

	// Prevent infinite recursion for circular recipes
	if (visited.has(itemId)) {
		return 1;
	}
	visited.add(itemId);

	const item = ctx.items.get(itemId);
	if (!item) {
		cache?.set(itemId, 1);
		return 1;
	}

	// Get recipes for this item
	const allRecipes = ctx.recipes.get(itemId) || [];
	const validRecipes = filterValidRecipes(allRecipes, item, ctx);

	// No valid recipes = raw material = step 1
	if (validRecipes.length === 0) {
		cache?.set(itemId, 1);
		return 1;
	}

	// Sort by cost and pick cheapest recipe
	const recipe = getCheapestRecipe(validRecipes);
	if (!recipe) {
		cache?.set(itemId, 1);
		return 1;
	}

	// Calculate step from the cheapest recipe's ingredients
	let maxIngredientStep = 0;
	for (const ing of recipe.ingredients) {
		const ingStep = calculateItemNaturalStep(ing.itemId, ctx, new Set(visited), cache);
		maxIngredientStep = Math.max(maxIngredientStep, ingStep);
	}

	// Cargo ingredients are step 1, so if we have cargo, min step is 1
	if (recipe.cargoIngredients && recipe.cargoIngredients.length > 0) {
		maxIngredientStep = Math.max(maxIngredientStep, 1);
	}

	const step = maxIngredientStep + 1;
	cache?.set(itemId, step);
	return step;
}

/**
 * Get the profession/skill for an item based on its cheapest recipe.
 * Priority:
 * 1. Cargo-derived items → cargo source gathering skill
 * 2. Item list items → source skill from item list recipe
 * 3. Items with crafting recipes → recipe skill
 * 4. Items with extraction recipes → extraction skill
 * 5. Fallback → 'Gathering'
 *
 * @param itemId - The item to get profession for
 * @param ctx - Recipe context with items/recipes data
 * @param extractionRecipes - Optional extraction recipes map
 * @param cache - Optional cache to store results
 * @returns The profession name
 */
export function calculateItemProfession(
	itemId: number,
	ctx: RecipeContext,
	extractionRecipes?: Map<number, Recipe[]>,
	cache?: Map<number, string>
): string {
	// Check cache first
	if (cache?.has(itemId)) {
		return cache.get(itemId)!;
	}

	const item = ctx.items.get(itemId);
	if (!item) {
		cache?.set(itemId, 'Unknown');
		return 'Unknown';
	}

	// Check if this item is derived from cargo
	const cargoSourceSkill = ctx.itemToCargoSkill.get(itemId);
	if (cargoSourceSkill) {
		cache?.set(itemId, cargoSourceSkill);
		return cargoSourceSkill;
	}

	// Check if this item comes from an item list
	const listSourceSkill = ctx.itemFromListToSkill.get(itemId);
	if (listSourceSkill) {
		cache?.set(itemId, listSourceSkill);
		return listSourceSkill;
	}

	// Get crafting recipes for this item
	const allRecipes = ctx.recipes.get(itemId) || [];
	const validRecipes = filterValidRecipes(allRecipes, item, ctx);

	// No valid crafting recipes - try extraction
	if (validRecipes.length === 0) {
		// Try extraction recipes
		const extractRecipes = extractionRecipes?.get(itemId) || [];
		if (extractRecipes.length > 0 && extractRecipes[0].levelRequirements?.[0]?.skillName) {
			const profession = extractRecipes[0].levelRequirements[0].skillName;
			cache?.set(itemId, profession);
			return profession;
		}

		// Fall back to 'Gathering' for raw materials
		cache?.set(itemId, 'Gathering');
		return 'Gathering';
	}

	// Sort by cost and pick cheapest recipe
	const recipe = getCheapestRecipe(validRecipes);
	if (!recipe) {
		cache?.set(itemId, 'Gathering');
		return 'Gathering';
	}

	// Get profession from level requirements
	const profession = recipe.levelRequirements?.[0]?.skillName || recipe.craftingStationName || item.tag || 'Crafting';
	cache?.set(itemId, profession);
	return profession;
}

/**
 * Get the profession for a cargo item.
 */
export function getCargoProfession(cargoId: number, ctx: RecipeContext): string {
	return ctx.cargoToSkill.get(cargoId) || 'Gathering';
}

/**
 * Calculate the natural crafting step for a cargo item based on its cheapest recipe.
 * Step 1 = raw/gathered cargo, Step N = max(ingredient steps) + 1
 *
 * @param cargoId - The cargo to calculate step for
 * @param ctx - Recipe context with items/recipes/cargoRecipes data
 * @param visitedItems - Set of item IDs already visited (for cycle detection)
 * @param visitedCargos - Set of cargo IDs already visited (for cycle detection)
 * @param itemCache - Optional cache for item step results
 * @param cargoCache - Optional cache for cargo step results
 * @returns The crafting step (1 = gathering, 2+ = crafted)
 */
export function calculateCargoNaturalStep(
	cargoId: number,
	ctx: RecipeContext,
	visitedItems: Set<number> = new Set(),
	visitedCargos: Set<number> = new Set(),
	itemCache?: Map<number, number>,
	cargoCache?: Map<number, number>
): number {
	// Check cache first
	if (cargoCache?.has(cargoId)) {
		return cargoCache.get(cargoId)!;
	}

	// Prevent infinite recursion for circular recipes
	if (visitedCargos.has(cargoId)) {
		return 1;
	}
	visitedCargos.add(cargoId);

	// No cargo recipes map = cargo is gathered = step 1
	if (!ctx.cargoRecipes) {
		cargoCache?.set(cargoId, 1);
		return 1;
	}

	// Get recipes for this cargo
	const cargoRecipes = ctx.cargoRecipes.get(cargoId) || [];

	// No recipes = gathered cargo = step 1
	if (cargoRecipes.length === 0) {
		cargoCache?.set(cargoId, 1);
		return 1;
	}

	// Pick cheapest recipe (by cost if available)
	const recipe = getCheapestRecipe(cargoRecipes);
	if (!recipe) {
		cargoCache?.set(cargoId, 1);
		return 1;
	}

	// Calculate step from ingredients
	let maxIngredientStep = 0;

	// Item ingredients
	for (const ing of recipe.ingredients) {
		const ingStep = calculateItemNaturalStep(ing.itemId, ctx, new Set(visitedItems), itemCache);
		maxIngredientStep = Math.max(maxIngredientStep, ingStep);
	}

	// Cargo ingredients (recursive)
	if (recipe.cargoIngredients) {
		for (const cargoIng of recipe.cargoIngredients) {
			const cargoStep = calculateCargoNaturalStep(
				cargoIng.cargoId,
				ctx,
				new Set(visitedItems),
				new Set(visitedCargos),
				itemCache,
				cargoCache
			);
			maxIngredientStep = Math.max(maxIngredientStep, cargoStep);
		}
	}

	const step = maxIngredientStep + 1;
	cargoCache?.set(cargoId, step);
	return step;
}

/**
 * Debug helper to trace recipe filtering for an item.
 * Returns detailed info about why recipes were filtered.
 */
export function debugRecipeFiltering(
	itemId: number,
	ctx: RecipeContext
): {
	item: Item | undefined;
	allRecipes: Recipe[];
	validRecipes: Recipe[];
	filterReasons: Array<{ recipeId: number; reason: string }>;
	selectedRecipe: Recipe | undefined;
	calculatedStep: number;
	calculatedProfession: string;
} {
	const item = ctx.items.get(itemId);
	const allRecipes = ctx.recipes.get(itemId) || [];
	const filterReasons: Array<{ recipeId: number; reason: string }> = [];

	const validRecipes = allRecipes.filter(recipe => {
		const hasItemIngredients = recipe.ingredients.length > 0;
		const hasCargoIngredients = (recipe.cargoIngredients?.length ?? 0) > 0;

		if (!hasItemIngredients && !hasCargoIngredients) {
			filterReasons.push({ recipeId: recipe.id, reason: 'No ingredients (item or cargo)' });
			return false;
		}

		if (hasItemIngredients) {
			const invalidIng = recipe.ingredients.find(ing => !ctx.items.has(ing.itemId));
			if (invalidIng) {
				filterReasons.push({ recipeId: recipe.id, reason: `Invalid ingredient: ${invalidIng.itemId}` });
				return false;
			}
		}

		if (item && item.tier !== -1) {
			const downgradeIng = recipe.ingredients.find(ing => {
				const ingItem = ctx.items.get(ing.itemId);
				if (!ingItem || ingItem.tier === -1) return false;
				return ingItem.tier > item.tier;
			});
			if (downgradeIng) {
				const ingItem = ctx.items.get(downgradeIng.itemId);
				filterReasons.push({
					recipeId: recipe.id,
					reason: `Downgrade recipe: ingredient ${ingItem?.name || downgradeIng.itemId} (tier ${ingItem?.tier}) > output (tier ${item.tier})`
				});
				return false;
			}
		}

		return true;
	});

	const selectedRecipe = getCheapestRecipe(validRecipes);
	const calculatedStep = calculateItemNaturalStep(itemId, ctx);
	const calculatedProfession = calculateItemProfession(itemId, ctx);

	return {
		item,
		allRecipes,
		validRecipes,
		filterReasons,
		selectedRecipe,
		calculatedStep,
		calculatedProfession
	};
}
