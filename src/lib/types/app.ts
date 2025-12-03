/**
 * Application state types
 */

import type { Item, FlatMaterial, Cargo } from './game';

// List entry type discriminator
export type ListEntryType = 'item' | 'cargo' | 'building';

// Base properties for all list entries
interface ListEntryBase {
	id: string; // Unique ID for this list entry
	type: ListEntryType;
	quantity: number;
	addedAt: number;
}

// Item entry (most common, existing behavior)
export interface ItemListEntry extends ListEntryBase {
	type: 'item';
	itemId: number;
	recipeId?: number; // Selected recipe ID (if item has multiple recipes)
}

// Cargo entry (for direct cargo gathering goals)
export interface CargoListEntry extends ListEntryBase {
	type: 'cargo';
	cargoId: number;
}

// Building entry (for construction goals)
export interface BuildingListEntry extends ListEntryBase {
	type: 'building';
	constructionRecipeId: number; // ID from construction_recipe_desc.json
}

// Unified list entry type
export type CraftingListEntry = ItemListEntry | CargoListEntry | BuildingListEntry;

// Crafting list
export interface CraftingList {
	id: string;
	name: string;
	description?: string;
	entries: CraftingListEntry[]; // Renamed from 'items' for clarity with multiple types
	enabledSourceIds: string[]; // Per-list inventory source selection
	autoRefreshEnabled?: boolean; // Per-list auto-refresh toggle (undefined = true)
	shareToken?: string; // Token for shared link (if shared)
	shareExpiresAt?: number; // Expiration timestamp (if shared)
	createdAt: number;
	updatedAt: number;
	externalInventoryRefs?: ExternalInventoryRef[]; // External players/claims for this list
}

// Reference to an external player or claim inventory
export interface ExternalInventoryRef {
	type: 'player' | 'claim';
	entityId: string; // Player ID or Claim ID
	name: string; // Display name (player username or claim name)
	addedAt: number; // When this external ref was added
	lastFetched?: number; // Last time inventory was fetched
}

// Legacy: Item in a crafting list (for migration)
export interface CraftingListItem {
	id: string; // Unique ID for this list entry
	itemId: number;
	quantity: number;
	recipeId?: number; // Selected recipe ID (if item has multiple recipes)
	addedAt: number;
}

// Tracks how much of an item's need is covered by having parent items/cargo
export interface ParentContribution {
	parentItemId?: number; // Present when parent is an item
	parentCargoId?: number; // Present when parent is a cargo
	parentQuantityUsed: number; // How many of the parent item/cargo contributed
	coverage: number; // How many units of THIS item are covered
}

// DEV: Tracks how much of a material's requirement comes from each list item
export interface RootItemContribution {
	rootItemId: number;      // The list item (final product) ID
	rootItemName: string;    // Name for display
	quantity: number;        // How many list items requested
	contribution: number;    // How much this contributes to the material's baseRequired
}

// Material requirement with inventory info
export interface MaterialRequirement extends FlatMaterial {
	baseRequired: number;  // Full tree amount (stable, assumes 0 inventory)
	remaining: number;     // What still needs to be gathered/crafted (after propagation)
	have: number;          // Current inventory + manual override
	isComplete: boolean;   // remaining === 0
	parentContributions?: ParentContribution[]; // Coverage from parent items in inventory
	rootContributions?: RootItemContribution[]; // DEV: breakdown by list item
}

// Grouped materials by tier for display
export interface TierGroup {
	tier: number;
	materials: MaterialRequirement[];
	totalRequired: number;
	totalAvailable: number;
	isComplete: boolean;
}

// Grouped materials by crafting step for display
export interface StepGroup {
	step: number;
	label: string; // "Gathering" for step 1, "Step N" for others
	materials: MaterialRequirement[]; // Sorted by tier within step
	totalRequired: number;
	totalAvailable: number;
	isComplete: boolean;
}

// Grouped materials by profession for display
export interface ProfessionGroup {
	profession: string;
	materials: MaterialRequirement[]; // Sorted by tier, then step
	totalRequired: number;
	totalAvailable: number;
	isComplete: boolean;
}

// Step group with profession sub-groups (for combined view)
export interface StepWithProfessionsGroup {
	step: number;
	label: string;
	professionGroups: ProfessionGroup[];
	totalRequired: number;
	totalAvailable: number;
	isComplete: boolean;
}

// List view mode
export type ListViewMode = 'step' | 'profession' | 'combined';

// Per-list progress state (persisted separately from list data)
export interface ListProgress {
	listId: string; // Primary key, matches CraftingList.id
	manualHave: [number, number][]; // Serialized Map<itemId, quantity> (legacy, items only)
	manualHaveCargo?: [number, number][]; // Serialized Map<cargoId, quantity>
	manualHaveBuilding?: [number, number][]; // Serialized Map<constructionRecipeId, quantity>
	checkedOff: number[]; // Serialized Set<itemId> (legacy, items only)
	checkedOffCargo?: number[]; // Serialized Set<cargoId>
	checkedOffBuilding?: number[]; // Serialized Set<constructionRecipeId>
	recipePreferences?: [string, number][]; // Serialized Map<materialKey, recipeId>
	hideCompleted: boolean;
	viewMode: ListViewMode;
	collapsedSections: string[]; // Serialized Set<sectionId>
	updatedAt: number;
}

// Type guards for list entries
export function isItemEntry(entry: CraftingListEntry): entry is ItemListEntry {
	return entry.type === 'item';
}

export function isCargoEntry(entry: CraftingListEntry): entry is CargoListEntry {
	return entry.type === 'cargo';
}

export function isBuildingEntry(entry: CraftingListEntry): entry is BuildingListEntry {
	return entry.type === 'building';
}

// Player's accessible claim info
export interface AccessibleClaim {
	entityId: string;
	name: string;
	tier: number;
}

// User configuration
export interface UserConfig {
	playerId?: string;
	playerName?: string;
	accessibleClaims: AccessibleClaim[]; // Auto-populated from API
	inventoryLastSync?: number; // Timestamp of last inventory sync
	autoRefreshMinutes: number; // Default 5, 0 = disabled
	theme: 'light' | 'dark' | 'system';
	stripedRows: boolean; // Alternating row colors in tables
}

// Cache metadata for staleness checking
export interface CacheMetadata {
	key: string;
	lastUpdated: number;
	expiresAt: number;
	version: string;
}

// View mode for material display
export type MaterialViewMode = 'flat' | 'tree' | 'tier';

// Sort options for material lists
export type MaterialSortBy = 'tier' | 'name' | 'quantity' | 'availability';
export type SortDirection = 'asc' | 'desc';

export interface MaterialSortOptions {
	by: MaterialSortBy;
	direction: SortDirection;
}

// Filter options for material lists
export interface MaterialFilterOptions {
	showCompleted: boolean;
	tiers: number[]; // Empty = all tiers
	searchQuery: string;
}
