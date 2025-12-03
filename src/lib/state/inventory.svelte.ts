/**
 * Inventory state management
 * Handles multiple inventory sources and aggregation
 */

import type {
	InventorySource,
	SourcedItem,
	SourcedCargo,
	AggregatedItem,
	AggregatedCargo,
	MaterialAllocation,
	AllocationEntry
} from '$lib/types/inventory';
import {
	getCachedSources,
	saveSources,
	saveSource,
	saveSourceItems,
	saveSourceCargos,
	getAllCachedInventoryItems,
	getAllCachedInventoryCargos,
	deleteSource as deleteCachedSource,
	deleteSourcesByExternalRef,
	getCachedSourcesByExternalRef
} from '$lib/services/cache';
import {
	fetchPlayerInventory,
	fetchClaimInventories,
	fetchClaimDetails,
	parseBuildingInventory,
	parsePlayerInventory,
	parseExternalPlayerInventory,
	parseExternalBuildingInventory
} from '$lib/services/api/inventory';
import { settings, updateInventorySyncTime, isInventoryStale } from './settings.svelte';

/**
 * Convert a reactive proxy to a plain object for IndexedDB storage
 */
function toPlain<T>(obj: T): T {
	return JSON.parse(JSON.stringify(obj));
}

// State container
export const inventory = $state({
	sources: [] as InventorySource[],
	items: new Map<string, SourcedItem[]>(), // sourceId -> items
	cargos: new Map<string, SourcedCargo[]>(), // sourceId -> cargos
	isLoading: false,
	isSyncing: false,
	lastSync: null as number | null,
	error: null as string | null
});

// Getter: only enabled sources
export function getEnabledSources(): InventorySource[] {
	return inventory.sources.filter((s) => s.enabled);
}

// Re-export as computed property for convenience
export const enabledSources = {
	get value() {
		return getEnabledSources();
	}
};

// Getter: sources grouped by type
export const sourcesByType = {
	get value() {
		const groups = new Map<InventorySource['type'], InventorySource[]>();

		for (const source of inventory.sources) {
			const group = groups.get(source.type) || [];
			group.push(source);
			groups.set(source.type, group);
		}

		return groups;
	}
};

// Getter: sources grouped by claim
export const sourcesByClaim = {
	get value() {
		const groups = new Map<string, InventorySource[]>();

		for (const source of inventory.sources) {
			const claimId = source.claimId || 'player';
			const group = groups.get(claimId) || [];
			group.push(source);
			groups.set(claimId, group);
		}

		return groups;
	}
};

// Getter: aggregated inventory from enabled sources
export const aggregatedInventory = {
	get value() {
		const itemMap = new Map<number, AggregatedItem>();
		const enabled = getEnabledSources();

		for (const source of enabled) {
			const sourceItems = inventory.items.get(source.id) || [];

			for (const item of sourceItems) {
				const existing = itemMap.get(item.itemId);

				if (existing) {
					existing.totalQuantity += item.quantity;
					existing.sources.push(item);
				} else {
					itemMap.set(item.itemId, {
						itemId: item.itemId,
						totalQuantity: item.quantity,
						sources: [{ ...item }]
					});
				}
			}
		}

		return itemMap;
	},
	get size() {
		return this.value.size;
	},
	get(itemId: number) {
		return this.value.get(itemId);
	},
	values() {
		return this.value.values();
	}
};

// Getter: aggregated cargo from enabled sources
export const aggregatedCargo = {
	get value() {
		const cargoMap = new Map<number, AggregatedCargo>();
		const enabled = getEnabledSources();

		for (const source of enabled) {
			const sourceCargos = inventory.cargos.get(source.id) || [];

			for (const cargo of sourceCargos) {
				const existing = cargoMap.get(cargo.cargoId);

				if (existing) {
					existing.totalQuantity += cargo.quantity;
					existing.sources.push(cargo);
				} else {
					cargoMap.set(cargo.cargoId, {
						cargoId: cargo.cargoId,
						totalQuantity: cargo.quantity,
						sources: [{ ...cargo }]
					});
				}
			}
		}

		return cargoMap;
	},
	get size() {
		return this.value.size;
	},
	get(cargoId: number) {
		return this.value.get(cargoId);
	},
	values() {
		return this.value.values();
	}
};

/**
 * Initialize inventory from cache
 */
export async function initializeInventory(): Promise<void> {
	inventory.isLoading = true;

	try {
		// Load sources from cache
		const cachedSources = await getCachedSources();
		inventory.sources = cachedSources;

		// Load items for each source
		const allItems = await getAllCachedInventoryItems();
		inventory.items.clear();

		for (const item of allItems) {
			const existing = inventory.items.get(item.sourceId);
			if (existing) {
				existing.push(item);
			} else {
				inventory.items.set(item.sourceId, [item]);
			}
		}

		// Load cargos for each source
		const allCargos = await getAllCachedInventoryCargos();
		inventory.cargos.clear();

		for (const cargo of allCargos) {
			const existing = inventory.cargos.get(cargo.sourceId);
			if (existing) {
				existing.push(cargo);
			} else {
				inventory.cargos.set(cargo.sourceId, [cargo]);
			}
		}
	} catch (e) {
		console.error('Failed to initialize inventory:', e);
		inventory.error = e instanceof Error ? e.message : 'Failed to load inventory';
	} finally {
		inventory.isLoading = false;
	}
}

/**
 * Sync all configured inventories from API
 */
export async function syncAllInventories(): Promise<void> {
	inventory.isSyncing = true;
	inventory.error = null;

	try {
		// Sync player inventory if configured
		if (settings.playerId) {
			await syncPlayerInventory(settings.playerId);
		}

		// Sync each accessible claim's inventories
		for (const claim of settings.accessibleClaims) {
			await syncClaimInventory(claim.entityId);
		}

		inventory.lastSync = Date.now();
		updateInventorySyncTime();
	} catch (e) {
		inventory.error = e instanceof Error ? e.message : 'Failed to sync inventories';
		console.error('Failed to sync inventories:', e);
	} finally {
		inventory.isSyncing = false;
	}
}

/**
 * Sync inventories if stale (based on user's autoRefreshMinutes setting)
 * Returns true if sync was performed
 */
export async function syncIfStale(): Promise<boolean> {
	if (inventory.isSyncing) return false;

	if (isInventoryStale()) {
		await syncAllInventories();
		return true;
	}
	return false;
}

/**
 * Get aggregated inventory filtered by specific source IDs
 * Used for per-list inventory filtering
 */
export function getAggregatedInventoryForSources(sourceIds: string[]): Map<number, AggregatedItem> {
	const itemMap = new Map<number, AggregatedItem>();

	// If no sourceIds specified, use all enabled sources
	const sourcesToUse = sourceIds.length > 0
		? inventory.sources.filter(s => sourceIds.includes(s.id))
		: getEnabledSources();

	for (const source of sourcesToUse) {
		const sourceItems = inventory.items.get(source.id) || [];

		for (const item of sourceItems) {
			const existing = itemMap.get(item.itemId);

			if (existing) {
				existing.totalQuantity += item.quantity;
				existing.sources.push(item);
			} else {
				itemMap.set(item.itemId, {
					itemId: item.itemId,
					totalQuantity: item.quantity,
					sources: [{ ...item }]
				});
			}
		}
	}

	return itemMap;
}

/**
 * Get aggregated cargo filtered by specific source IDs
 * Used for per-list cargo inventory filtering
 */
export function getAggregatedCargoForSources(sourceIds: string[]): Map<number, AggregatedCargo> {
	const cargoMap = new Map<number, AggregatedCargo>();

	// If no sourceIds specified, use all enabled sources
	const sourcesToUse = sourceIds.length > 0
		? inventory.sources.filter(s => sourceIds.includes(s.id))
		: getEnabledSources();

	for (const source of sourcesToUse) {
		const sourceCargos = inventory.cargos.get(source.id) || [];

		for (const cargo of sourceCargos) {
			const existing = cargoMap.get(cargo.cargoId);

			if (existing) {
				existing.totalQuantity += cargo.quantity;
				existing.sources.push(cargo);
			} else {
				cargoMap.set(cargo.cargoId, {
					cargoId: cargo.cargoId,
					totalQuantity: cargo.quantity,
					sources: [{ ...cargo }]
				});
			}
		}
	}

	return cargoMap;
}

/**
 * Allocate materials from specific inventory sources
 * Used for per-list material allocation
 */
export function allocateMaterialsFromSources(
	requirements: Array<{ itemId: number; quantity: number }>,
	sourceIds: string[]
): MaterialAllocation[] {
	const aggregated = getAggregatedInventoryForSources(sourceIds);
	const allocations: MaterialAllocation[] = [];

	for (const req of requirements) {
		const itemAgg = aggregated.get(req.itemId);
		const available = itemAgg?.totalQuantity || 0;

		if (!itemAgg || available === 0) {
			allocations.push({
				itemId: req.itemId,
				required: req.quantity,
				available: 0,
				allocated: [],
				shortfall: req.quantity
			});
			continue;
		}

		// Sort sources by quantity descending (fullest first)
		const sortedSources = [...itemAgg.sources].sort((a, b) => b.quantity - a.quantity);

		const allocated: AllocationEntry[] = [];
		let remaining = req.quantity;

		for (const source of sortedSources) {
			if (remaining <= 0) break;

			const sourceInfo = inventory.sources.find((s) => s.id === source.sourceId);
			const take = Math.min(source.quantity, remaining);

			allocated.push({
				sourceId: source.sourceId,
				sourceName: sourceInfo?.nickname || sourceInfo?.name || source.sourceId,
				sourceType: sourceInfo?.type || 'claim_building',
				quantity: take
			});

			remaining -= take;
		}

		allocations.push({
			itemId: req.itemId,
			required: req.quantity,
			available,
			allocated,
			shortfall: Math.max(0, remaining)
		});
	}

	return allocations;
}

/**
 * Sync player inventory
 */
async function syncPlayerInventory(playerId: string): Promise<void> {
	try {
		const response = await fetchPlayerInventory(playerId);
		const { sources, items, cargos } = parsePlayerInventory(response.inventories || [], playerId);

		// Merge sources (preserve enabled state)
		for (const newSource of sources) {
			const existingIndex = inventory.sources.findIndex((s) => s.id === newSource.id);

			if (existingIndex >= 0) {
				// Preserve enabled state
				newSource.enabled = inventory.sources[existingIndex].enabled;
				inventory.sources[existingIndex] = newSource;
			} else {
				inventory.sources.push(newSource);
			}

			// Update items
			inventory.items.set(newSource.id, items.filter((i) => i.sourceId === newSource.id));
			// Update cargos
			inventory.cargos.set(newSource.id, cargos.filter((c) => c.sourceId === newSource.id));
		}

		// Persist to cache
		await saveSources(sources);
		for (const source of sources) {
			const sourceItems = items.filter((i) => i.sourceId === source.id);
			await saveSourceItems(source.id, sourceItems);
			const sourceCargos = cargos.filter((c) => c.sourceId === source.id);
			await saveSourceCargos(source.id, sourceCargos);
		}
	} catch (e) {
		console.error(`Failed to sync player inventory for ${playerId}:`, e);
		throw e;
	}
}

/**
 * Sync claim inventory
 */
async function syncClaimInventory(claimId: string): Promise<void> {
	try {
		// Get claim details for name
		const claimDetails = await fetchClaimDetails(claimId);
		const claimName = claimDetails.name;

		// Get all building inventories
		const response = await fetchClaimInventories(claimId);

		const newSources: InventorySource[] = [];
		const newItems: SourcedItem[] = [];
		const newCargos: SourcedCargo[] = [];

		for (const building of response.buildings) {
			const { source, items, cargos } = parseBuildingInventory(building, claimId, claimName);

			// Check if source already exists and preserve enabled state
			const existingSource = inventory.sources.find((s) => s.id === source.id);
			if (existingSource) {
				source.enabled = existingSource.enabled;
			}

			newSources.push(source);
			newItems.push(...items);
			newCargos.push(...cargos);
		}

		// Update state
		for (const source of newSources) {
			const existingIndex = inventory.sources.findIndex((s) => s.id === source.id);

			if (existingIndex >= 0) {
				inventory.sources[existingIndex] = source;
			} else {
				inventory.sources.push(source);
			}

			inventory.items.set(
				source.id,
				newItems.filter((i) => i.sourceId === source.id)
			);
			inventory.cargos.set(
				source.id,
				newCargos.filter((c) => c.sourceId === source.id)
			);
		}

		// Persist to cache
		await saveSources(newSources);
		for (const source of newSources) {
			const sourceItems = newItems.filter((i) => i.sourceId === source.id);
			await saveSourceItems(source.id, sourceItems);
			const sourceCargos = newCargos.filter((c) => c.sourceId === source.id);
			await saveSourceCargos(source.id, sourceCargos);
		}
	} catch (e) {
		console.error(`Failed to sync claim inventory for ${claimId}:`, e);
		throw e;
	}
}

/**
 * Toggle a source on/off
 */
export async function toggleSource(sourceId: string): Promise<void> {
	const source = inventory.sources.find((s) => s.id === sourceId);
	if (source) {
		source.enabled = !source.enabled;
		await saveSource(toPlain(source));
	}
}

/**
 * Enable all sources
 */
export async function enableAllSources(): Promise<void> {
	for (const source of inventory.sources) {
		source.enabled = true;
	}
	await saveSources(toPlain(inventory.sources));
}

/**
 * Disable all sources
 */
export async function disableAllSources(): Promise<void> {
	for (const source of inventory.sources) {
		source.enabled = false;
	}
	await saveSources(toPlain(inventory.sources));
}

/**
 * Toggle all sources in a claim
 */
export async function toggleClaimSources(claimId: string, enabled: boolean): Promise<void> {
	const claimSources = inventory.sources.filter((s) => s.claimId === claimId);

	for (const source of claimSources) {
		source.enabled = enabled;
	}

	await saveSources(toPlain(claimSources));
}

/**
 * Remove a source and its items/cargos
 */
export async function removeSource(sourceId: string): Promise<void> {
	inventory.sources = inventory.sources.filter((s) => s.id !== sourceId);
	inventory.items.delete(sourceId);
	inventory.cargos.delete(sourceId);
	await deleteCachedSource(sourceId);
}

/**
 * Get quantity of an item from enabled sources
 */
export function getItemQuantity(itemId: number): number {
	const aggregated = aggregatedInventory.get(itemId);
	return aggregated?.totalQuantity || 0;
}

/**
 * Get source breakdown for an item
 */
export function getItemSources(itemId: number): SourcedItem[] {
	const aggregated = aggregatedInventory.get(itemId);
	return aggregated?.sources || [];
}

/**
 * Get quantity of a cargo from enabled sources
 */
export function getCargoQuantity(cargoId: number): number {
	const aggregated = aggregatedCargo.get(cargoId);
	return aggregated?.totalQuantity || 0;
}

/**
 * Get source breakdown for a cargo
 */
export function getCargoSources(cargoId: number): SourcedCargo[] {
	const aggregated = aggregatedCargo.get(cargoId);
	return aggregated?.sources || [];
}

/**
 * Allocate materials from inventory using "fullest first" strategy
 * Returns allocation showing which buildings to pull from
 */
export function allocateMaterials(
	requirements: Array<{ itemId: number; quantity: number }>
): MaterialAllocation[] {
	const allocations: MaterialAllocation[] = [];

	for (const req of requirements) {
		const aggregated = aggregatedInventory.get(req.itemId);
		const available = aggregated?.totalQuantity || 0;

		if (!aggregated || available === 0) {
			// Nothing available
			allocations.push({
				itemId: req.itemId,
				required: req.quantity,
				available: 0,
				allocated: [],
				shortfall: req.quantity
			});
			continue;
		}

		// Sort sources by quantity descending (fullest first)
		const sortedSources = [...aggregated.sources].sort((a, b) => b.quantity - a.quantity);

		const allocated: AllocationEntry[] = [];
		let remaining = req.quantity;

		for (const source of sortedSources) {
			if (remaining <= 0) break;

			const sourceInfo = inventory.sources.find((s) => s.id === source.sourceId);
			const take = Math.min(source.quantity, remaining);

			allocated.push({
				sourceId: source.sourceId,
				sourceName: sourceInfo?.nickname || sourceInfo?.name || source.sourceId,
				sourceType: sourceInfo?.type || 'claim_building',
				quantity: take
			});

			remaining -= take;
		}

		allocations.push({
			itemId: req.itemId,
			required: req.quantity,
			available,
			allocated,
			shortfall: Math.max(0, remaining)
		});
	}

	return allocations;
}

// ============================================================================
// External Inventory Management
// ============================================================================

/**
 * State for tracking external inventory sync status
 */
export const externalSyncState = $state({
	syncing: new Set<string>(), // externalRefId currently syncing
	errors: new Map<string, string>() // externalRefId -> error message
});

/**
 * Sync external player inventory
 * Returns the sources that were synced
 */
export async function syncExternalPlayerInventory(
	playerId: string,
	playerName: string
): Promise<InventorySource[]> {
	const externalRefId = `player:${playerId}`;
	externalSyncState.syncing.add(externalRefId);
	externalSyncState.errors.delete(externalRefId);

	try {
		const response = await fetchPlayerInventory(playerId);
		const { sources, items, cargos } = parseExternalPlayerInventory(
			response.inventories || [],
			playerId,
			playerName
		);

		// Merge sources (preserve enabled state)
		for (const newSource of sources) {
			const existingIndex = inventory.sources.findIndex((s) => s.id === newSource.id);

			if (existingIndex >= 0) {
				// Preserve enabled state
				newSource.enabled = inventory.sources[existingIndex].enabled;
				inventory.sources[existingIndex] = newSource;
			} else {
				inventory.sources.push(newSource);
			}

			// Update items
			inventory.items.set(newSource.id, items.filter((i) => i.sourceId === newSource.id));
			// Update cargos
			inventory.cargos.set(newSource.id, cargos.filter((c) => c.sourceId === newSource.id));
		}

		// Persist to cache
		await saveSources(sources);
		for (const source of sources) {
			const sourceItems = items.filter((i) => i.sourceId === source.id);
			await saveSourceItems(source.id, sourceItems);
			const sourceCargos = cargos.filter((c) => c.sourceId === source.id);
			await saveSourceCargos(source.id, sourceCargos);
		}

		return sources;
	} catch (e) {
		const errorMsg = e instanceof Error ? e.message : 'Failed to sync external player inventory';
		externalSyncState.errors.set(externalRefId, errorMsg);
		console.error(`Failed to sync external player inventory for ${playerId}:`, e);
		throw e;
	} finally {
		externalSyncState.syncing.delete(externalRefId);
	}
}

/**
 * Sync external claim inventory
 * Returns the sources that were synced
 */
export async function syncExternalClaimInventory(
	claimId: string,
	claimName: string
): Promise<InventorySource[]> {
	const externalRefId = `claim:${claimId}`;
	externalSyncState.syncing.add(externalRefId);
	externalSyncState.errors.delete(externalRefId);

	try {
		// Get all building inventories
		const response = await fetchClaimInventories(claimId);

		const newSources: InventorySource[] = [];
		const newItems: SourcedItem[] = [];
		const newCargos: SourcedCargo[] = [];

		for (const building of response.buildings) {
			const { source, items, cargos } = parseExternalBuildingInventory(
				building,
				claimId,
				claimName
			);

			// Check if source already exists and preserve enabled state
			const existingSource = inventory.sources.find((s) => s.id === source.id);
			if (existingSource) {
				source.enabled = existingSource.enabled;
			}

			newSources.push(source);
			newItems.push(...items);
			newCargos.push(...cargos);
		}

		// Update state
		for (const source of newSources) {
			const existingIndex = inventory.sources.findIndex((s) => s.id === source.id);

			if (existingIndex >= 0) {
				inventory.sources[existingIndex] = source;
			} else {
				inventory.sources.push(source);
			}

			inventory.items.set(
				source.id,
				newItems.filter((i) => i.sourceId === source.id)
			);
			inventory.cargos.set(
				source.id,
				newCargos.filter((c) => c.sourceId === source.id)
			);
		}

		// Persist to cache
		await saveSources(newSources);
		for (const source of newSources) {
			const sourceItems = newItems.filter((i) => i.sourceId === source.id);
			await saveSourceItems(source.id, sourceItems);
			const sourceCargos = newCargos.filter((c) => c.sourceId === source.id);
			await saveSourceCargos(source.id, sourceCargos);
		}

		return newSources;
	} catch (e) {
		const errorMsg = e instanceof Error ? e.message : 'Failed to sync external claim inventory';
		externalSyncState.errors.set(externalRefId, errorMsg);
		console.error(`Failed to sync external claim inventory for ${claimId}:`, e);
		throw e;
	} finally {
		externalSyncState.syncing.delete(externalRefId);
	}
}

/**
 * Remove all sources for an external reference
 */
export async function removeExternalSources(externalRefId: string): Promise<void> {
	// Remove from state
	const sourcesToRemove = inventory.sources.filter((s) => s.externalRefId === externalRefId);

	for (const source of sourcesToRemove) {
		inventory.sources = inventory.sources.filter((s) => s.id !== source.id);
		inventory.items.delete(source.id);
		inventory.cargos.delete(source.id);
	}

	// Remove from cache
	await deleteSourcesByExternalRef(externalRefId);

	// Clear any error state
	externalSyncState.errors.delete(externalRefId);
}

/**
 * Get sources for a specific external reference
 */
export function getExternalSourcesByRef(externalRefId: string): InventorySource[] {
	return inventory.sources.filter((s) => s.externalRefId === externalRefId);
}

/**
 * Get all external sources grouped by their reference
 */
export const externalSourcesByRef = {
	get value() {
		const groups = new Map<string, InventorySource[]>();

		for (const source of inventory.sources) {
			if (source.isExternal && source.externalRefId) {
				const group = groups.get(source.externalRefId) || [];
				group.push(source);
				groups.set(source.externalRefId, group);
			}
		}

		return groups;
	}
};

/**
 * Get only local (non-external) sources grouped by claim
 */
export const localSourcesByClaim = {
	get value() {
		const groups = new Map<string, InventorySource[]>();

		for (const source of inventory.sources) {
			if (!source.isExternal) {
				const claimId = source.claimId || 'player';
				const group = groups.get(claimId) || [];
				group.push(source);
				groups.set(claimId, group);
			}
		}

		return groups;
	}
};
