/**
 * Game data state (items, recipes)
 * Loaded from static JSON files with hash-based caching
 */

import type { Item, ItemWithRecipes, Recipe } from '$lib/types/game';
import {
	getGameDataHash,
	cacheAllGameData,
	loadAllGameDataFromCache
} from '$lib/services/cache';
import { fetchManifest, loadAllGameData, DATA_LOADER_VERSION } from '$lib/services/game-data-loader';

// State container
export const gameData = $state({
	items: new Map<number, Item>(),
	recipes: new Map<number, Recipe[]>(), // outputItemId -> recipes
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

// Getter: deduplicated items (by name, keeping lowest rarity)
export const deduplicatedItems = {
	get value() {
		const byName = new Map<string, Item>();
		for (const item of gameData.items.values()) {
			const existing = byName.get(item.name);
			if (!existing || item.rarity < existing.rarity) {
				byName.set(item.name, item);
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
				gameData.recipes = cached.recipes;
				gameData.loadingProgress = 100;
				gameData.isInitialized = true;
				console.log(`Loaded ${cached.items.size} items and ${cached.recipes.size} recipe groups from cache`);
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
		gameData.recipes = data.recipes;

		// Cache the data with hash (including loader version)
		await cacheAllGameData(data.items, data.recipes, expectedHash);
		gameData.loadingProgress = 100;

		gameData.isInitialized = true;
		console.log(`Loaded ${data.items.size} items and ${data.recipes.size} recipe groups from JSON files`);
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
		gameData.recipes = data.recipes;

		// Cache with new hash (including loader version)
		const versionedHash = `${manifest.hash}_v${DATA_LOADER_VERSION}`;
		await cacheAllGameData(data.items, data.recipes, versionedHash);
		gameData.loadingProgress = 100;

		gameData.isInitialized = true;
		console.log(`Refreshed ${data.items.size} items and ${data.recipes.size} recipe groups`);
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

	// For now, we don't have extraction recipes or other data in the JSON
	return {
		...item,
		craftingRecipes,
		extractionRecipes: [],
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
 * Search items by name (deduplicated by name, keeping lowest rarity)
 */
export function searchItems(query: string, limit = 20): Item[] {
	if (!query.trim()) return [];

	const lowerQuery = query.toLowerCase();
	const resultsByName = new Map<string, Item>();

	for (const item of gameData.items.values()) {
		if (item.name.toLowerCase().includes(lowerQuery)) {
			const existing = resultsByName.get(item.name);
			// Keep the lowest rarity version (they have the same recipes)
			if (!existing || item.rarity < existing.rarity) {
				resultsByName.set(item.name, item);
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
