/**
 * Game data state (items, recipes)
 * Loaded from static JSON files with hash-based caching
 */

import type { Item, ItemWithRecipes, Recipe, Cargo, ConstructionRecipe, BuildingDescription } from '$lib/types/game';
import {
	getGameDataHash,
	cacheAllGameData,
	loadAllGameDataFromCache
} from '$lib/services/cache';
import { fetchManifest, loadAllGameData, DATA_LOADER_VERSION } from '$lib/services/game-data-loader';
import { clearRecipeCaches } from './crafting.svelte';

// State container
export const gameData = $state({
	items: new Map<number, Item>(),
	cargos: new Map<number, Cargo>(), // cargoId -> cargo item
	recipes: new Map<number, Recipe[]>(), // outputItemId -> crafting recipes
	cargoRecipes: new Map<number, Recipe[]>(), // outputCargoId -> crafting recipes that produce cargo
	extractionRecipes: new Map<number, Recipe[]>(), // outputItemId -> extraction recipes
	cargoToSkill: new Map<number, string>(), // cargoId -> skill name (for tracing cargo to gathering skill)
	itemToCargoSkill: new Map<number, string>(), // outputItemId -> skill name (for items derived from cargo)
	itemFromListToSkill: new Map<number, string>(), // itemId -> skill name (for items inside item lists)
	constructionRecipes: new Map<number, ConstructionRecipe>(), // recipeId -> construction recipe
	buildingDescriptions: new Map<number, BuildingDescription>(), // buildingDescId -> building description
	isLoading: false,
	loadingProgress: 0,
	error: null as string | null,
	isInitialized: false
});

// Getter: items as array for iteration
export const itemsArray = {
	get value() {
		return Array.from(gameData.items.values());
	},
	get length() {
		return gameData.items.size;
	},
	filter(predicate: (item: Item) => boolean) {
		return Array.from(gameData.items.values()).filter(predicate);
	},
	slice(start?: number, end?: number) {
		return Array.from(gameData.items.values()).slice(start, end);
	},
	[Symbol.iterator]() {
		return gameData.items.values();
	}
};

// Getter: deduplicated items (by name, preferring items with recipes, then lowest rarity)
export const deduplicatedItems = {
	get value() {
		const byName = new Map<string, Item>();
		for (const item of gameData.items.values()) {
			const existing = byName.get(item.name);

			if (!existing) {
				byName.set(item.name, item);
			} else {
				// Prefer items that have recipes
				const existingHasRecipe = gameData.recipes.has(existing.id);
				const itemHasRecipe = gameData.recipes.has(item.id);

				if (itemHasRecipe && !existingHasRecipe) {
					byName.set(item.name, item);
				} else if (!itemHasRecipe && existingHasRecipe) {
					// Keep existing
				} else if (item.rarity < existing.rarity) {
					byName.set(item.name, item);
				}
			}
		}
		return Array.from(byName.values());
	},
	get length() {
		return this.value.length;
	}
};

// Getter: items grouped by tier
export const itemsByTier = {
	get value() {
		const tiers = new Map<number, Item[]>();

		for (const item of gameData.items.values()) {
			const tierItems = tiers.get(item.tier) || [];
			tierItems.push(item);
			tiers.set(item.tier, tierItems);
		}

		return tiers;
	},
	get(tier: number) {
		return this.value.get(tier);
	}
};

/**
 * Initialize game data from cache or JSON files
 */
export async function initializeGameData(): Promise<void> {
	if (gameData.isInitialized || gameData.isLoading) return;

	gameData.isLoading = true;
	gameData.error = null;
	gameData.loadingProgress = 0;

	try {
		// Fetch manifest to check hash
		const manifest = await fetchManifest();
		gameData.loadingProgress = 10;

		// Check if cached data matches current hash (including loader version)
		const cachedHash = await getGameDataHash();
		const expectedHash = `${manifest.hash}_v${DATA_LOADER_VERSION}`;

		if (cachedHash === expectedHash) {
			// Load from cache
			console.log('Loading game data from cache...');
			const cached = await loadAllGameDataFromCache();

			if (cached && cached.items.size > 0) {
				gameData.items = cached.items;
				gameData.cargos = cached.cargos || new Map();
				gameData.recipes = cached.recipes;
				gameData.cargoRecipes = cached.cargoRecipes || new Map();
				gameData.extractionRecipes = cached.extractionRecipes || new Map();
				gameData.cargoToSkill = cached.cargoToSkill || new Map();
				gameData.itemToCargoSkill = cached.itemToCargoSkill || new Map();
				gameData.itemFromListToSkill = cached.itemFromListToSkill || new Map();
				gameData.constructionRecipes = cached.constructionRecipes || new Map();
				gameData.buildingDescriptions = cached.buildingDescriptions || new Map();
				gameData.loadingProgress = 100;
				gameData.isInitialized = true;

				// Clear recipe caches to ensure fresh calculations with loaded data
				clearRecipeCaches();

				console.log(`Loaded ${cached.items.size} items, ${cached.cargos?.size || 0} cargos, ${cached.recipes.size} crafting recipe groups, ${cached.cargoRecipes?.size || 0} cargo recipe groups, ${cached.extractionRecipes?.size || 0} extraction recipe groups, ${cached.cargoToSkill?.size || 0} cargo mappings, ${cached.itemToCargoSkill?.size || 0} item-cargo mappings, ${cached.itemFromListToSkill?.size || 0} item-list mappings, ${cached.constructionRecipes?.size || 0} construction recipes, ${cached.buildingDescriptions?.size || 0} building descriptions from cache`);
				return;
			}
		}

		// Hash mismatch or no cache - fetch fresh data
		console.log('Fetching fresh game data from JSON files...');
		gameData.loadingProgress = 20;

		const data = await loadAllGameData();
		gameData.loadingProgress = 80;

		// Update state
		gameData.items = data.items;
		gameData.cargos = data.cargos;
		gameData.recipes = data.recipes;
		gameData.cargoRecipes = data.cargoRecipes;
		gameData.extractionRecipes = data.extractionRecipes;
		gameData.cargoToSkill = data.cargoToSkill;
		gameData.itemToCargoSkill = data.itemToCargoSkill;
		gameData.itemFromListToSkill = data.itemFromListToSkill;
		gameData.constructionRecipes = data.constructionRecipes;
		gameData.buildingDescriptions = data.buildingDescriptions;

		// Cache the data with hash (including loader version)
		await cacheAllGameData(data.items, data.cargos, data.recipes, data.cargoRecipes, data.extractionRecipes, data.cargoToSkill, data.itemToCargoSkill, data.itemFromListToSkill, data.constructionRecipes, data.buildingDescriptions, expectedHash);
		gameData.loadingProgress = 100;

		gameData.isInitialized = true;

		// Clear recipe caches to ensure fresh calculations with new data
		clearRecipeCaches();

		console.log(`Loaded ${data.items.size} items, ${data.cargos.size} cargos, ${data.recipes.size} crafting recipe groups, ${data.cargoRecipes.size} cargo recipe groups, ${data.extractionRecipes.size} extraction recipe groups, ${data.cargoToSkill.size} cargo mappings, ${data.itemToCargoSkill.size} item-cargo mappings, ${data.itemFromListToSkill.size} item-list mappings, ${data.constructionRecipes.size} construction recipes, ${data.buildingDescriptions.size} building descriptions from JSON files`);
	} catch (e) {
		gameData.error = e instanceof Error ? e.message : 'Failed to initialize game data';
		console.error('Failed to initialize game data:', e);
	} finally {
		gameData.isLoading = false;
	}
}

/**
 * Force refresh game data from JSON files
 */
export async function refreshGameData(): Promise<void> {
	gameData.isLoading = true;
	gameData.error = null;
	gameData.loadingProgress = 0;

	try {
		// Fetch manifest
		const manifest = await fetchManifest();
		gameData.loadingProgress = 10;

		// Fetch fresh data
		const data = await loadAllGameData();
		gameData.loadingProgress = 80;

		// Update state
		gameData.items = data.items;
		gameData.cargos = data.cargos;
		gameData.recipes = data.recipes;
		gameData.cargoRecipes = data.cargoRecipes;
		gameData.extractionRecipes = data.extractionRecipes;
		gameData.cargoToSkill = data.cargoToSkill;
		gameData.itemToCargoSkill = data.itemToCargoSkill;
		gameData.itemFromListToSkill = data.itemFromListToSkill;
		gameData.constructionRecipes = data.constructionRecipes;
		gameData.buildingDescriptions = data.buildingDescriptions;

		// Cache with new hash (including loader version)
		const versionedHash = `${manifest.hash}_v${DATA_LOADER_VERSION}`;
		await cacheAllGameData(data.items, data.cargos, data.recipes, data.cargoRecipes, data.extractionRecipes, data.cargoToSkill, data.itemToCargoSkill, data.itemFromListToSkill, data.constructionRecipes, data.buildingDescriptions, versionedHash);
		gameData.loadingProgress = 100;

		gameData.isInitialized = true;

		// Clear recipe caches to ensure fresh calculations with refreshed data
		clearRecipeCaches();

		console.log(`Refreshed ${data.items.size} items, ${data.cargos.size} cargos, ${data.recipes.size} crafting recipe groups, ${data.cargoRecipes.size} cargo recipe groups, ${data.extractionRecipes.size} extraction recipe groups, ${data.cargoToSkill.size} cargo mappings, ${data.itemToCargoSkill.size} item-cargo mappings, ${data.itemFromListToSkill.size} item-list mappings, ${data.constructionRecipes.size} construction recipes, ${data.buildingDescriptions.size} building descriptions`);
	} catch (e) {
		gameData.error = e instanceof Error ? e.message : 'Failed to refresh game data';
		console.error('Failed to refresh game data:', e);
		throw e;
	} finally {
		gameData.isLoading = false;
	}
}

/**
 * Get item by ID (basic info)
 */
export function getItemById(itemId: number): Item | undefined {
	return gameData.items.get(itemId);
}

/**
 * Get item with full recipe details
 * Uses pre-loaded recipe map (no API call needed)
 */
export function getItemWithRecipes(itemId: number): ItemWithRecipes | undefined {
	const item = gameData.items.get(itemId);
	if (!item) return undefined;

	const craftingRecipes = gameData.recipes.get(itemId) || [];
	const extractionRecipes = gameData.extractionRecipes.get(itemId) || [];

	return {
		...item,
		craftingRecipes,
		extractionRecipes,
		recipesUsingItem: [],
		relatedSkills: []
	};
}

/**
 * Get item with recipes (async version for compatibility)
 */
export async function getItemWithRecipesAsync(itemId: number): Promise<ItemWithRecipes | undefined> {
	return getItemWithRecipes(itemId);
}

/**
 * Search items by name (deduplicated by name, preferring items with recipes, then lowest rarity)
 */
export function searchItems(query: string, limit = 20): Item[] {
	if (!query.trim()) return [];

	const lowerQuery = query.toLowerCase();
	const resultsByName = new Map<string, Item>();

	for (const item of gameData.items.values()) {
		if (item.name.toLowerCase().includes(lowerQuery)) {
			const existing = resultsByName.get(item.name);

			if (!existing) {
				resultsByName.set(item.name, item);
			} else {
				// Prefer items that have recipes
				const existingHasRecipe = gameData.recipes.has(existing.id);
				const itemHasRecipe = gameData.recipes.has(item.id);

				if (itemHasRecipe && !existingHasRecipe) {
					// New item has recipe, existing doesn't - prefer new item
					resultsByName.set(item.name, item);
				} else if (!itemHasRecipe && existingHasRecipe) {
					// Existing has recipe, new doesn't - keep existing
				} else {
					// Both have recipes or neither has - use rarity tiebreaker
					if (item.rarity < existing.rarity) {
						resultsByName.set(item.name, item);
					}
				}
			}
		}
	}

	// Convert to array and limit
	return Array.from(resultsByName.values()).slice(0, limit);
}

/**
 * Find recipes that produce a given item
 */
export function findRecipesForItem(itemId: number): Recipe[] {
	return gameData.recipes.get(itemId) || [];
}

/**
 * Find recipes that use a given item as an ingredient
 */
export function findRecipesUsingItem(itemId: number): Array<{ recipe: Recipe; outputItem: Item | undefined }> {
	const results: Array<{ recipe: Recipe; outputItem: Item | undefined }> = [];

	for (const [outputItemId, recipes] of gameData.recipes) {
		for (const recipe of recipes) {
			if (recipe.ingredients.some(ing => ing.itemId === itemId)) {
				results.push({
					recipe,
					outputItem: gameData.items.get(outputItemId)
				});
			}
		}
	}

	return results;
}

/**
 * Get cargo by ID
 */
export function getCargoById(cargoId: number): Cargo | undefined {
	return gameData.cargos.get(cargoId);
}

/**
 * Search cargos by name
 */
export function searchCargos(query: string, limit = 20): Cargo[] {
	if (!query.trim()) return [];

	const lowerQuery = query.toLowerCase();
	const results: Cargo[] = [];

	for (const cargo of gameData.cargos.values()) {
		if (cargo.name.toLowerCase().includes(lowerQuery)) {
			results.push(cargo);
			if (results.length >= limit) break;
		}
	}

	return results;
}

/**
 * Get construction recipe by ID
 */
export function getConstructionRecipeById(recipeId: number): ConstructionRecipe | undefined {
	return gameData.constructionRecipes.get(recipeId);
}

/**
 * Get building description by ID
 */
export function getBuildingDescriptionById(buildingDescId: number): BuildingDescription | undefined {
	return gameData.buildingDescriptions.get(buildingDescId);
}

/**
 * Find construction recipe by building description ID
 * Used for finding the recipe that builds a specific building (for upgrades)
 */
export function findConstructionRecipeByBuildingId(buildingDescId: number): ConstructionRecipe | undefined {
	for (const recipe of gameData.constructionRecipes.values()) {
		if (recipe.buildingDescriptionId === buildingDescId) {
			return recipe;
		}
	}
	return undefined;
}

/**
 * Search construction recipes by name
 */
export function searchConstructionRecipes(query: string, limit = 20): ConstructionRecipe[] {
	if (!query.trim()) return [];

	const lowerQuery = query.toLowerCase();
	const results: ConstructionRecipe[] = [];

	for (const recipe of gameData.constructionRecipes.values()) {
		if (recipe.name.toLowerCase().includes(lowerQuery)) {
			results.push(recipe);
			if (results.length >= limit) break;
		}
	}

	return results;
}
