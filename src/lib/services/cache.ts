/**
 * IndexedDB caching layer for game data
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Item, ItemWithRecipes, Building, Recipe, Cargo } from '$lib/types/game';
import type { InventorySource, SourcedItem, SourcedCargo } from '$lib/types/inventory';
import type { CraftingList, CacheMetadata, ListProgress } from '$lib/types/app';

// Database schema version
const DB_NAME = 'bitsaver';
const DB_VERSION = 6; // Incremented for inventoryCargos store

// Cache TTL constants (in milliseconds)
export const CACHE_TTL = {
	ITEMS: 24 * 60 * 60 * 1000, // 24 hours
	BUILDINGS: 24 * 60 * 60 * 1000, // 24 hours
	ITEM_DETAILS: 24 * 60 * 60 * 1000, // 24 hours
	INVENTORY: 5 * 60 * 1000 // 5 minutes (inventories change frequently)
} as const;

// Stored recipe group (recipes for a single output item)
interface StoredRecipeGroup {
	outputItemId: number;
	recipes: Recipe[];
}

// Game data hash metadata
interface GameDataHashMeta {
	key: string;
	hash: string;
	cachedAt: number;
}

// IndexedDB schema definition
interface BithelperDB extends DBSchema {
	items: {
		key: number;
		value: Item;
		indexes: {
			'by-tier': number;
			'by-name': string;
			'by-tag': string;
		};
	};
	cargos: {
		key: number;
		value: Cargo;
		indexes: {
			'by-tier': number;
			'by-tag': string;
		};
	};
	recipes: {
		key: number; // outputItemId
		value: StoredRecipeGroup;
	};
	extractionRecipes: {
		key: number; // outputItemId
		value: StoredRecipeGroup;
	};
	itemDetails: {
		key: number;
		value: ItemWithRecipes & { cachedAt: number };
	};
	buildings: {
		key: string;
		value: Building;
		indexes: {
			'by-name': string;
		};
	};
	gameDataMeta: {
		key: string;
		value: GameDataHashMeta;
	};
	inventorySources: {
		key: string;
		value: InventorySource;
		indexes: {
			'by-type': string;
			'by-claim': string;
		};
	};
	inventoryItems: {
		key: [string, number]; // Composite key: [sourceId, itemId]
		value: SourcedItem;
		indexes: {
			'by-source': string;
			'by-item': number;
		};
	};
	inventoryCargos: {
		key: [string, number]; // Composite key: [sourceId, cargoId]
		value: SourcedCargo;
		indexes: {
			'by-source': string;
			'by-cargo': number;
		};
	};
	craftingLists: {
		key: string;
		value: CraftingList;
		indexes: {
			'by-updated': number;
		};
	};
	metadata: {
		key: string;
		value: CacheMetadata;
	};
	listProgress: {
		key: string; // listId
		value: ListProgress;
		indexes: {
			'by-updated': number;
		};
	};
}

// Database instance (lazy initialized)
let dbInstance: IDBPDatabase<BithelperDB> | null = null;

/**
 * Get or create database instance
 */
export async function getDB(): Promise<IDBPDatabase<BithelperDB>> {
	if (dbInstance) return dbInstance;

	dbInstance = await openDB<BithelperDB>(DB_NAME, DB_VERSION, {
		upgrade(db, oldVersion) {
			// Items store
			if (!db.objectStoreNames.contains('items')) {
				const itemStore = db.createObjectStore('items', { keyPath: 'id' });
				itemStore.createIndex('by-tier', 'tier');
				itemStore.createIndex('by-name', 'name');
				itemStore.createIndex('by-tag', 'tag');
			}

			// Cargos store (new in v5)
			if (!db.objectStoreNames.contains('cargos')) {
				const cargoStore = db.createObjectStore('cargos', { keyPath: 'id' });
				cargoStore.createIndex('by-tier', 'tier');
				cargoStore.createIndex('by-tag', 'tag');
			}

			// Recipes store (new in v2)
			if (!db.objectStoreNames.contains('recipes')) {
				db.createObjectStore('recipes', { keyPath: 'outputItemId' });
			}

			// Extraction recipes store (new in v3)
			if (!db.objectStoreNames.contains('extractionRecipes')) {
				db.createObjectStore('extractionRecipes', { keyPath: 'outputItemId' });
			}

			// Game data meta store (new in v2)
			if (!db.objectStoreNames.contains('gameDataMeta')) {
				db.createObjectStore('gameDataMeta', { keyPath: 'key' });
			}

			// Item details store (with recipes) - kept for backward compatibility
			if (!db.objectStoreNames.contains('itemDetails')) {
				db.createObjectStore('itemDetails', { keyPath: 'id' });
			}

			// Buildings store
			if (!db.objectStoreNames.contains('buildings')) {
				const buildingStore = db.createObjectStore('buildings', { keyPath: 'entityId' });
				buildingStore.createIndex('by-name', 'buildingName');
			}

			// Inventory sources store
			if (!db.objectStoreNames.contains('inventorySources')) {
				const sourceStore = db.createObjectStore('inventorySources', { keyPath: 'id' });
				sourceStore.createIndex('by-type', 'type');
				sourceStore.createIndex('by-claim', 'claimId');
			}

			// Inventory items store
			if (!db.objectStoreNames.contains('inventoryItems')) {
				const invStore = db.createObjectStore('inventoryItems', {
					keyPath: ['sourceId', 'itemId']
				});
				invStore.createIndex('by-source', 'sourceId');
				invStore.createIndex('by-item', 'itemId');
			}

			// Inventory cargos store (new in v6)
			if (!db.objectStoreNames.contains('inventoryCargos')) {
				const cargoStore = db.createObjectStore('inventoryCargos', {
					keyPath: ['sourceId', 'cargoId']
				});
				cargoStore.createIndex('by-source', 'sourceId');
				cargoStore.createIndex('by-cargo', 'cargoId');
			}

			// Crafting lists store
			if (!db.objectStoreNames.contains('craftingLists')) {
				const listStore = db.createObjectStore('craftingLists', { keyPath: 'id' });
				listStore.createIndex('by-updated', 'updatedAt');
			}

			// Metadata store
			if (!db.objectStoreNames.contains('metadata')) {
				db.createObjectStore('metadata', { keyPath: 'key' });
			}

			// List progress store (new in v4)
			if (!db.objectStoreNames.contains('listProgress')) {
				const progressStore = db.createObjectStore('listProgress', { keyPath: 'listId' });
				progressStore.createIndex('by-updated', 'updatedAt');
			}
		}
	});

	return dbInstance;
}

/**
 * Close database connection
 */
export function closeDB(): void {
	if (dbInstance) {
		dbInstance.close();
		dbInstance = null;
	}
}

// ============ Cache Metadata ============

/**
 * Get cache metadata
 */
export async function getCacheMeta(key: string): Promise<CacheMetadata | undefined> {
	const db = await getDB();
	return db.get('metadata', key);
}

/**
 * Set cache metadata
 */
export async function setCacheMeta(key: string, ttl: number): Promise<void> {
	const db = await getDB();
	const now = Date.now();
	await db.put('metadata', {
		key,
		lastUpdated: now,
		expiresAt: now + ttl,
		version: DB_VERSION.toString()
	});
}

/**
 * Check if cache is valid (not expired)
 */
export async function isCacheValid(key: string): Promise<boolean> {
	const meta = await getCacheMeta(key);
	if (!meta) return false;
	return Date.now() < meta.expiresAt;
}

// ============ Items Cache ============

/**
 * Get all cached items
 */
export async function getCachedItems(): Promise<Item[]> {
	const db = await getDB();
	return db.getAll('items');
}

/**
 * Get items by tier
 */
export async function getCachedItemsByTier(tier: number): Promise<Item[]> {
	const db = await getDB();
	return db.getAllFromIndex('items', 'by-tier', tier);
}

/**
 * Get a single cached item
 */
export async function getCachedItem(itemId: number): Promise<Item | undefined> {
	const db = await getDB();
	return db.get('items', itemId);
}

/**
 * Cache multiple items
 */
export async function cacheItems(items: Item[]): Promise<void> {
	const db = await getDB();
	const tx = db.transaction('items', 'readwrite');

	await Promise.all([...items.map((item) => tx.store.put(item)), tx.done]);

	await setCacheMeta('items', CACHE_TTL.ITEMS);
}

/**
 * Get cached item with full recipe details
 */
export async function getCachedItemDetails(itemId: number): Promise<ItemWithRecipes | undefined> {
	const db = await getDB();
	const cached = await db.get('itemDetails', itemId);

	if (!cached) return undefined;

	// Check if cache is still valid
	if (Date.now() - cached.cachedAt > CACHE_TTL.ITEM_DETAILS) {
		return undefined;
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const { cachedAt: _, ...item } = cached;
	return item;
}

/**
 * Cache item with recipe details
 */
export async function cacheItemDetails(item: ItemWithRecipes): Promise<void> {
	const db = await getDB();
	await db.put('itemDetails', { ...item, cachedAt: Date.now() });
}

// ============ Buildings Cache ============

/**
 * Get all cached buildings
 */
export async function getCachedBuildings(): Promise<Building[]> {
	const db = await getDB();
	return db.getAll('buildings');
}

/**
 * Cache multiple buildings
 */
export async function cacheBuildings(buildings: Building[]): Promise<void> {
	const db = await getDB();
	const tx = db.transaction('buildings', 'readwrite');

	await Promise.all([...buildings.map((building) => tx.store.put(building)), tx.done]);

	await setCacheMeta('buildings', CACHE_TTL.BUILDINGS);
}

// ============ Inventory Sources Cache ============

/**
 * Get all inventory sources
 */
export async function getCachedSources(): Promise<InventorySource[]> {
	const db = await getDB();
	return db.getAll('inventorySources');
}

/**
 * Get sources by type
 */
export async function getCachedSourcesByType(type: string): Promise<InventorySource[]> {
	const db = await getDB();
	return db.getAllFromIndex('inventorySources', 'by-type', type);
}

/**
 * Get sources by claim
 */
export async function getCachedSourcesByClaim(claimId: string): Promise<InventorySource[]> {
	const db = await getDB();
	return db.getAllFromIndex('inventorySources', 'by-claim', claimId);
}

/**
 * Save a single inventory source
 */
export async function saveSource(source: InventorySource): Promise<void> {
	const db = await getDB();
	await db.put('inventorySources', source);
}

/**
 * Save multiple inventory sources
 */
export async function saveSources(sources: InventorySource[]): Promise<void> {
	const db = await getDB();
	const tx = db.transaction('inventorySources', 'readwrite');
	await Promise.all([...sources.map((source) => tx.store.put(source)), tx.done]);
}

/**
 * Delete a source and its items/cargos
 */
export async function deleteSource(sourceId: string): Promise<void> {
	const db = await getDB();

	// Delete source
	await db.delete('inventorySources', sourceId);

	// Delete associated items
	const items = await db.getAllFromIndex('inventoryItems', 'by-source', sourceId);
	const itemTx = db.transaction('inventoryItems', 'readwrite');
	await Promise.all([
		...items.map((item) => itemTx.store.delete([item.sourceId, item.itemId])),
		itemTx.done
	]);

	// Delete associated cargos
	const cargos = await db.getAllFromIndex('inventoryCargos', 'by-source', sourceId);
	const cargoTx = db.transaction('inventoryCargos', 'readwrite');
	await Promise.all([
		...cargos.map((cargo) => cargoTx.store.delete([cargo.sourceId, cargo.cargoId])),
		cargoTx.done
	]);
}

// ============ Inventory Items Cache ============

/**
 * Get all inventory items for a source
 */
export async function getCachedItemsForSource(sourceId: string): Promise<SourcedItem[]> {
	const db = await getDB();
	return db.getAllFromIndex('inventoryItems', 'by-source', sourceId);
}

/**
 * Get all inventory items
 */
export async function getAllCachedInventoryItems(): Promise<SourcedItem[]> {
	const db = await getDB();
	return db.getAll('inventoryItems');
}

/**
 * Save inventory items for a source (replaces existing)
 */
export async function saveSourceItems(sourceId: string, items: SourcedItem[]): Promise<void> {
	const db = await getDB();

	// Delete existing items for this source
	const existingItems = await db.getAllFromIndex('inventoryItems', 'by-source', sourceId);
	const deleteTx = db.transaction('inventoryItems', 'readwrite');
	await Promise.all([
		...existingItems.map((item) => deleteTx.store.delete([item.sourceId, item.itemId])),
		deleteTx.done
	]);

	// Add new items
	if (items.length > 0) {
		const addTx = db.transaction('inventoryItems', 'readwrite');
		await Promise.all([...items.map((item) => addTx.store.put(item)), addTx.done]);
	}
}

// ============ Inventory Cargos Cache ============

/**
 * Get all inventory cargos for a source
 */
export async function getCachedCargosForSource(sourceId: string): Promise<SourcedCargo[]> {
	const db = await getDB();
	return db.getAllFromIndex('inventoryCargos', 'by-source', sourceId);
}

/**
 * Get all inventory cargos
 */
export async function getAllCachedInventoryCargos(): Promise<SourcedCargo[]> {
	const db = await getDB();
	return db.getAll('inventoryCargos');
}

/**
 * Save inventory cargos for a source (replaces existing)
 */
export async function saveSourceCargos(sourceId: string, cargos: SourcedCargo[]): Promise<void> {
	const db = await getDB();

	// Delete existing cargos for this source
	const existingCargos = await db.getAllFromIndex('inventoryCargos', 'by-source', sourceId);
	const deleteTx = db.transaction('inventoryCargos', 'readwrite');
	await Promise.all([
		...existingCargos.map((cargo) => deleteTx.store.delete([cargo.sourceId, cargo.cargoId])),
		deleteTx.done
	]);

	// Add new cargos
	if (cargos.length > 0) {
		const addTx = db.transaction('inventoryCargos', 'readwrite');
		await Promise.all([...cargos.map((cargo) => addTx.store.put(cargo)), addTx.done]);
	}
}

// ============ Crafting Lists Cache ============

/**
 * Get all crafting lists
 */
export async function getCachedLists(): Promise<CraftingList[]> {
	const db = await getDB();
	return db.getAll('craftingLists');
}

/**
 * Get a single crafting list
 */
export async function getCachedList(listId: string): Promise<CraftingList | undefined> {
	const db = await getDB();
	return db.get('craftingLists', listId);
}

/**
 * Save a crafting list
 */
export async function saveList(list: CraftingList): Promise<void> {
	const db = await getDB();
	await db.put('craftingLists', list);
}

/**
 * Delete a crafting list
 */
export async function deleteList(listId: string): Promise<void> {
	const db = await getDB();
	await db.delete('craftingLists', listId);
}

// ============ List Progress Cache ============

/**
 * Get progress for a list
 */
export async function getListProgress(listId: string): Promise<ListProgress | undefined> {
	const db = await getDB();
	return db.get('listProgress', listId);
}

/**
 * Save progress for a list
 */
export async function saveListProgress(progress: ListProgress): Promise<void> {
	const db = await getDB();
	await db.put('listProgress', { ...progress, updatedAt: Date.now() });
}

/**
 * Delete progress for a list (when list is deleted)
 */
export async function deleteListProgress(listId: string): Promise<void> {
	const db = await getDB();
	await db.delete('listProgress', listId);
}

// ============ Clear Cache ============

/**
 * Clear all cached data
 */
export async function clearAllCache(): Promise<void> {
	const db = await getDB();

	await db.clear('items');
	await db.clear('itemDetails');
	await db.clear('buildings');
	await db.clear('inventorySources');
	await db.clear('inventoryItems');
	await db.clear('inventoryCargos');
	await db.clear('craftingLists');
	await db.clear('listProgress');
	await db.clear('metadata');
}

/**
 * Clear only game data cache (items, cargos, buildings, recipes)
 */
export async function clearGameDataCache(): Promise<void> {
	const db = await getDB();
	await db.clear('items');
	await db.clear('cargos');
	await db.clear('recipes');
	await db.clear('extractionRecipes');
	await db.clear('itemDetails');
	await db.clear('buildings');
	await db.clear('gameDataMeta');
	await db.delete('metadata', 'items');
	await db.delete('metadata', 'buildings');
}

// ============ Game Data Hash Cache ============

/**
 * Get stored game data hash
 */
export async function getGameDataHash(): Promise<string | null> {
	const db = await getDB();
	const meta = await db.get('gameDataMeta', 'gameDataHash');
	return meta?.hash ?? null;
}

/**
 * Store game data hash
 */
export async function setGameDataHash(hash: string): Promise<void> {
	const db = await getDB();
	await db.put('gameDataMeta', {
		key: 'gameDataHash',
		hash,
		cachedAt: Date.now()
	});
}

// ============ Recipes Cache ============

/**
 * Get all cached recipes (as Map)
 */
export async function getCachedRecipes(): Promise<Map<number, Recipe[]>> {
	const db = await getDB();
	const all = await db.getAll('recipes');
	const map = new Map<number, Recipe[]>();
	for (const group of all) {
		map.set(group.outputItemId, group.recipes);
	}
	return map;
}

/**
 * Get recipes for a specific item
 */
export async function getCachedRecipesForItem(itemId: number): Promise<Recipe[] | undefined> {
	const db = await getDB();
	const group = await db.get('recipes', itemId);
	return group?.recipes;
}

/**
 * Cache all recipes
 */
export async function cacheRecipes(recipes: Map<number, Recipe[]>): Promise<void> {
	const db = await getDB();
	const tx = db.transaction('recipes', 'readwrite');

	const puts = Array.from(recipes.entries()).map(([outputItemId, recipeList]) =>
		tx.store.put({ outputItemId, recipes: recipeList })
	);

	await Promise.all([...puts, tx.done]);
}

/**
 * Get all cached extraction recipes (as Map)
 */
export async function getCachedExtractionRecipes(): Promise<Map<number, Recipe[]>> {
	const db = await getDB();
	const all = await db.getAll('extractionRecipes');
	const map = new Map<number, Recipe[]>();
	for (const group of all) {
		map.set(group.outputItemId, group.recipes);
	}
	return map;
}

/**
 * Cache all extraction recipes
 */
export async function cacheExtractionRecipes(recipes: Map<number, Recipe[]>): Promise<void> {
	const db = await getDB();
	const tx = db.transaction('extractionRecipes', 'readwrite');

	const puts = Array.from(recipes.entries()).map(([outputItemId, recipeList]) =>
		tx.store.put({ outputItemId, recipes: recipeList })
	);

	await Promise.all([...puts, tx.done]);
}

// ============ Full Game Data Cache ============

/**
 * Cache all game data (items, cargos, recipes, extraction recipes, cargoToSkill, itemToCargoSkill, itemFromListToSkill) with hash
 */
export async function cacheAllGameData(
	items: Map<number, Item>,
	cargos: Map<number, Cargo>,
	recipes: Map<number, Recipe[]>,
	extractionRecipes: Map<number, Recipe[]>,
	cargoToSkill: Map<number, string>,
	itemToCargoSkill: Map<number, string>,
	itemFromListToSkill: Map<number, string>,
	hash: string
): Promise<void> {
	const db = await getDB();

	// Clear existing data
	await db.clear('items');
	await db.clear('cargos');
	await db.clear('recipes');
	await db.clear('extractionRecipes');

	// Cache items
	const itemTx = db.transaction('items', 'readwrite');
	const itemPuts = Array.from(items.values()).map((item) => itemTx.store.put(item));
	await Promise.all([...itemPuts, itemTx.done]);

	// Cache cargos
	const cargoTx = db.transaction('cargos', 'readwrite');
	const cargoPuts = Array.from(cargos.values()).map((cargo) => cargoTx.store.put(cargo));
	await Promise.all([...cargoPuts, cargoTx.done]);

	// Cache recipes
	await cacheRecipes(recipes);

	// Cache extraction recipes
	await cacheExtractionRecipes(extractionRecipes);

	// Cache cargoToSkill as JSON in metadata
	await cacheCargoToSkill(cargoToSkill);

	// Cache itemToCargoSkill as JSON in metadata
	await cacheItemToCargoSkill(itemToCargoSkill);

	// Cache itemFromListToSkill as JSON in metadata
	await cacheItemFromListToSkill(itemFromListToSkill);

	// Store hash
	await setGameDataHash(hash);

	// Update metadata
	await setCacheMeta('items', CACHE_TTL.ITEMS);
}

/**
 * Cache cargoToSkill mapping as JSON
 */
async function cacheCargoToSkill(cargoToSkill: Map<number, string>): Promise<void> {
	const db = await getDB();
	const entries = Array.from(cargoToSkill.entries());
	await db.put('gameDataMeta', {
		key: 'cargoToSkill',
		hash: JSON.stringify(entries),
		cachedAt: Date.now()
	});
}

/**
 * Load cargoToSkill mapping from cache
 */
async function loadCargoToSkill(): Promise<Map<number, string>> {
	const db = await getDB();
	const meta = await db.get('gameDataMeta', 'cargoToSkill');
	if (!meta?.hash) return new Map();
	try {
		const entries = JSON.parse(meta.hash) as [number, string][];
		return new Map(entries);
	} catch {
		return new Map();
	}
}

/**
 * Cache itemToCargoSkill mapping as JSON
 */
async function cacheItemToCargoSkill(itemToCargoSkill: Map<number, string>): Promise<void> {
	const db = await getDB();
	const entries = Array.from(itemToCargoSkill.entries());
	await db.put('gameDataMeta', {
		key: 'itemToCargoSkill',
		hash: JSON.stringify(entries),
		cachedAt: Date.now()
	});
}

/**
 * Load itemToCargoSkill mapping from cache
 */
async function loadItemToCargoSkill(): Promise<Map<number, string>> {
	const db = await getDB();
	const meta = await db.get('gameDataMeta', 'itemToCargoSkill');
	if (!meta?.hash) return new Map();
	try {
		const entries = JSON.parse(meta.hash) as [number, string][];
		return new Map(entries);
	} catch {
		return new Map();
	}
}

/**
 * Cache itemFromListToSkill mapping as JSON
 */
async function cacheItemFromListToSkill(itemFromListToSkill: Map<number, string>): Promise<void> {
	const db = await getDB();
	const entries = Array.from(itemFromListToSkill.entries());
	await db.put('gameDataMeta', {
		key: 'itemFromListToSkill',
		hash: JSON.stringify(entries),
		cachedAt: Date.now()
	});
}

/**
 * Load itemFromListToSkill mapping from cache
 */
async function loadItemFromListToSkill(): Promise<Map<number, string>> {
	const db = await getDB();
	const meta = await db.get('gameDataMeta', 'itemFromListToSkill');
	if (!meta?.hash) return new Map();
	try {
		const entries = JSON.parse(meta.hash) as [number, string][];
		return new Map(entries);
	} catch {
		return new Map();
	}
}

/**
 * Load all game data from cache
 */
export async function loadAllGameDataFromCache(): Promise<{
	items: Map<number, Item>;
	cargos: Map<number, Cargo>;
	recipes: Map<number, Recipe[]>;
	extractionRecipes: Map<number, Recipe[]>;
	cargoToSkill: Map<number, string>;
	itemToCargoSkill: Map<number, string>;
	itemFromListToSkill: Map<number, string>;
} | null> {
	const db = await getDB();

	// Check if we have cached data
	const hash = await getGameDataHash();
	if (!hash) return null;

	const items = new Map<number, Item>();
	const allItems = await db.getAll('items');
	for (const item of allItems) {
		items.set(item.id, item);
	}

	// If no items cached, return null
	if (items.size === 0) return null;

	// Load cargos
	const cargos = new Map<number, Cargo>();
	const allCargos = await db.getAll('cargos');
	for (const cargo of allCargos) {
		cargos.set(cargo.id, cargo);
	}

	const recipes = await getCachedRecipes();
	const extractionRecipes = await getCachedExtractionRecipes();
	const cargoToSkill = await loadCargoToSkill();
	const itemToCargoSkill = await loadItemToCargoSkill();
	const itemFromListToSkill = await loadItemFromListToSkill();

	return { items, cargos, recipes, extractionRecipes, cargoToSkill, itemToCargoSkill, itemFromListToSkill };
}
