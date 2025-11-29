/**
 * Inventory API service for player and claim inventories
 */

import { apiRequest } from './client';
import type {
	ClaimInventoryResponse,
	PlayerInventoryResponse,
	PlayerInventoryEntry,
	BuildingInventory,
	InventorySource,
	SourcedItem
} from '$lib/types/inventory';

/**
 * Fetch player inventory
 */
export async function fetchPlayerInventory(playerId: string): Promise<PlayerInventoryResponse> {
	return apiRequest<PlayerInventoryResponse>(`/players/${playerId}/inventories`);
}

/**
 * Fetch all inventories in a claim
 */
export async function fetchClaimInventories(claimId: string): Promise<ClaimInventoryResponse> {
	return apiRequest<ClaimInventoryResponse>(`/claims/${claimId}/inventories`);
}

/**
 * Fetch buildings in a claim (for metadata)
 */
export async function fetchClaimBuildings(claimId: string): Promise<BuildingInventory[]> {
	const response = await apiRequest<{ buildings: BuildingInventory[] } | BuildingInventory[]>(
		`/claims/${claimId}/buildings`
	);

	// Handle both response formats
	if (Array.isArray(response)) {
		return response;
	}
	return response.buildings || [];
}

/**
 * Get claim details
 */
export interface ClaimDetails {
	entityId: string;
	name: string;
	ownerPlayerEntityId: string;
	regionId: number;
	tier: number;
	locationX: number;
	locationZ: number;
}

export async function fetchClaimDetails(claimId: string): Promise<ClaimDetails> {
	return apiRequest<ClaimDetails>(`/claims/${claimId}`);
}

/**
 * Player claim with permissions
 */
export interface PlayerClaim {
	entityId: string;
	name: string;
	regionId: number;
	tier: number;
	supplies: number;
	memberPermissions: {
		inventoryPermission: number;
		buildPermission: number;
		officerPermission: number;
		coOwnerPermission: number;
	};
}

/**
 * Player details response
 */
export interface PlayerDetails {
	entityId: string;
	username: string;
	claims: PlayerClaim[];
}

/**
 * Fetch player details including claims they have access to
 */
export async function fetchPlayerDetails(playerId: string): Promise<PlayerDetails> {
	const response = await apiRequest<{
		player: {
			entityId: string;
			username: string;
			claims?: PlayerClaim[];
		};
	}>(`/players/${playerId}`);

	const player = response.player;
	return {
		entityId: player.entityId,
		username: player.username,
		claims: player.claims || []
	};
}

/**
 * Get claims where player has inventory access (permission level > 0)
 */
export async function fetchPlayerAccessibleClaims(playerId: string): Promise<PlayerClaim[]> {
	const player = await fetchPlayerDetails(playerId);
	return player.claims.filter(claim => claim.memberPermissions?.inventoryPermission > 0);
}

/**
 * Search for claims by name
 */
export async function searchClaims(
	query: string
): Promise<Array<{ entityId: string; name: string }>> {
	const response = await apiRequest<{ claims: Array<{ entityId: string; name: string }> }>('/claims', {
		params: { q: query, limit: 20 }
	});
	return response.claims || [];
}

/**
 * Search for players by username
 */
export async function searchPlayers(
	query: string
): Promise<Array<{ entityId: string; username: string }>> {
	const response = await apiRequest<{ players: Array<{ entityId: string; username: string }> }>('/players', {
		params: { q: query }
	});
	return response.players || [];
}

/**
 * Parse building inventory into InventorySource and SourcedItems
 */
export function parseBuildingInventory(
	building: BuildingInventory,
	claimId?: string,
	claimName?: string
): { source: InventorySource; items: SourcedItem[] } {
	const source: InventorySource = {
		id: building.entityId,
		type: 'claim_building',
		name: building.buildingName || 'Unknown',
		nickname: building.buildingNickname,
		icon: building.iconAssetName,
		claimId,
		claimName,
		enabled: true,
		lastSynced: Date.now()
	};

	const items: SourcedItem[] = [];

	// Handle case where inventory might not exist or be in a different format
	const inventory = building.inventory || [];

	for (const slot of inventory) {
		if (slot?.contents && slot.contents.quantity > 0) {
			items.push({
				itemId: slot.contents.item_id,
				itemType: slot.contents.item_type,
				quantity: slot.contents.quantity,
				sourceId: building.entityId
			});
		}
	}

	return { source, items };
}

/**
 * Parse player inventory into InventorySource and SourcedItems
 * Player inventory uses a different structure with pockets instead of inventory slots
 */
export function parsePlayerInventory(
	inventories: PlayerInventoryEntry[],
	playerId: string
): { sources: InventorySource[]; items: SourcedItem[] } {
	const sources: InventorySource[] = [];
	const items: SourcedItem[] = [];

	for (const inv of inventories) {
		const sourceId = `player:${playerId}:${inv.entityId}`;
		const displayName = inv.inventoryName || inv.buildingName || 'Unknown';

		const source: InventorySource = {
			id: sourceId,
			type: determineSourceType(displayName),
			name: displayName,
			claimId: inv.claimEntityId || undefined,
			claimName: inv.claimName || undefined,
			enabled: true,
			lastSynced: Date.now()
		};

		sources.push(source);

		// Parse pockets (camelCase format)
		for (const pocket of inv.pockets || []) {
			if (pocket?.contents && pocket.contents.quantity > 0) {
				items.push({
					itemId: pocket.contents.itemId,
					itemType: String(pocket.contents.itemType),
					quantity: pocket.contents.quantity,
					sourceId
				});
			}
		}
	}

	return { sources, items };
}

/**
 * Determine source type based on building name
 */
function determineSourceType(buildingName: string): InventorySource['type'] {
	const nameLower = buildingName.toLowerCase();

	if (nameLower.includes('bank')) return 'bank';
	if (nameLower.includes('deployable') || nameLower.includes('chest')) return 'deployable';
	if (nameLower.includes('player') || nameLower.includes('inventory')) return 'player';

	return 'claim_building';
}

/**
 * Aggregate items from multiple sources, combining quantities for same itemId
 */
export function aggregateItems(items: SourcedItem[]): Map<number, SourcedItem[]> {
	const itemMap = new Map<number, SourcedItem[]>();

	for (const item of items) {
		const existing = itemMap.get(item.itemId);
		if (existing) {
			existing.push(item);
		} else {
			itemMap.set(item.itemId, [item]);
		}
	}

	return itemMap;
}
