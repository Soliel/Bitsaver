/**
 * Application state types
 */

import type { Item, FlatMaterial } from './game';

// Crafting list
export interface CraftingList {
	id: string;
	name: string;
	description?: string;
	items: CraftingListItem[];
	enabledSourceIds: string[]; // Per-list inventory source selection
	autoRefreshEnabled?: boolean; // Per-list auto-refresh toggle (undefined = true)
	createdAt: number;
	updatedAt: number;
}

// Item in a crafting list
export interface CraftingListItem {
	id: string; // Unique ID for this list entry
	itemId: number;
	quantity: number;
	recipeId?: number; // Selected recipe ID (if item has multiple recipes)
	addedAt: number;
}

// Tracks how much of an item's need is covered by having parent items
export interface ParentContribution {
	parentItemId: number;
	parentQuantityUsed: number; // How many of the parent item contributed
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
	manualHave: [number, number][]; // Serialized Map<itemId, quantity>
	checkedOff: number[]; // Serialized Set<itemId>
	hideCompleted: boolean;
	viewMode: ListViewMode;
	collapsedSections: string[]; // Serialized Set<sectionId>
	updatedAt: number;
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
