/**
 * Inventory types for tracking items across multiple sources
 */

// Source types for tracking origin
export type SourceType = 'player' | 'deployable' | 'bank' | 'claim_building';

// Inventory source configuration
export interface InventorySource {
	id: string; // entityId for buildings, playerId for player
	type: SourceType;
	name: string;
	nickname?: string;
	icon?: string;
	claimId?: string; // Parent claim ID (for buildings)
	claimName?: string;
	enabled: boolean; // User toggle
	lastSynced?: number; // Timestamp
}

// Item in a specific source
export interface SourcedItem {
	itemId: number;
	itemType: string;
	quantity: number;
	sourceId: string; // Reference to InventorySource.id
}

// Cargo in a specific source
export interface SourcedCargo {
	cargoId: number;
	quantity: number;
	sourceId: string; // Reference to InventorySource.id
}

// Aggregated item with source breakdown
export interface AggregatedItem {
	itemId: number;
	totalQuantity: number;
	sources: SourcedItem[]; // Breakdown by source
}

// Aggregated cargo with source breakdown
export interface AggregatedCargo {
	cargoId: number;
	totalQuantity: number;
	sources: SourcedCargo[]; // Breakdown by source
}

// Allocation entry showing where to get materials
export interface AllocationEntry {
	sourceId: string;
	sourceName: string;
	sourceType: SourceType;
	quantity: number;
}

// Full allocation for a material requirement
export interface MaterialAllocation {
	itemId: number;
	required: number;
	available: number;
	allocated: AllocationEntry[];
	shortfall: number; // How much we're missing
}

// API response types from Bitjita

// Inventory slot/pocket from API
export interface InventorySlot {
	locked: boolean;
	volume: number;
	contents: {
		item_id: number;
		quantity: number;
		item_type: string;
		durability?: number;
	} | null;
}

// Pocket format from player inventories API (camelCase)
export interface InventoryPocket {
	locked: boolean;
	volume: number;
	contents: {
		itemId: number;
		quantity: number;
		itemType: number;
	} | null;
}

// Building with inventory from /api/claims/[id]/inventories
export interface BuildingInventory {
	entityId: string;
	buildingDescriptionId: number;
	buildingName: string;
	buildingNickname?: string;
	iconAssetName: string;
	inventory: InventorySlot[];
}

// Player inventory entry from /api/players/[id]/inventories
export interface PlayerInventoryEntry {
	entityId: string;
	playerOwnerEntityId: string;
	ownerEntityId: string;
	pockets: InventoryPocket[];
	inventoryIndex: number;
	cargoIndex: number;
	buildingName: string | null;
	claimEntityId: string | null;
	claimName: string | null;
	claimLocationX: number | null;
	claimLocationZ: number | null;
	regionId: number;
	inventoryName: string;
}

// Full claim inventory response
export interface ClaimInventoryResponse {
	buildings: BuildingInventory[];
	items: unknown[];
	cargos: unknown[];
}

// Player inventory response - uses "inventories" with different structure
export interface PlayerInventoryResponse {
	inventories: PlayerInventoryEntry[];
	items: Record<string, unknown>;
	cargos: Record<string, unknown>;
}

// Sync state for UI feedback
export interface SyncState {
	isLoading: boolean;
	lastSync: number | null;
	error: string | null;
}
