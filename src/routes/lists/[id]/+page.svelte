<script lang="ts">
	import { tick } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import {
		crafting,
		removeItemFromList,
		removeEntryFromList,
		updateItemQuantity,
		updateEntryQuantity,
		updateEntryRecipe,
		updateListSources,
		updateListAutoRefresh,
		updateListUsePackages,
		updateListShare,
		calculateListRequirements,
		groupRequirementsByStep,
		groupRequirementsByProfession,
		groupRequirementsByStepWithProfessions,
		addExternalRefToList,
		removeExternalRefFromList,
		syncExternalInventoriesForList,
		getStaleExternalRefs,
		isExternalRefStale
	} from '$lib/state/crafting.svelte';
	import {
		inventory,
		syncIfStale,
		syncAllInventories,
		sourcesByClaim,
		localSourcesByClaim,
		externalSourcesByRef,
		getExternalSourcesByRef,
		syncExternalPlayerInventory,
		syncExternalClaimInventory,
		externalSyncState
	} from '$lib/state/inventory.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import {
		gameData,
		getItemById,
		getCargoById,
		getConstructionRecipeById,
		getBuildingDescriptionById,
		searchItems,
		searchCargos,
		findRecipesForItem,
		findRecipesForCargo,
		searchConstructionRecipes
	} from '$lib/state/game-data.svelte';
	import type { ConstructionRecipe, Cargo } from '$lib/types/game';
	import { addItemToList, addBuildingToList, addCargoToList } from '$lib/state/crafting.svelte';
	import { getListProgress, saveListProgress } from '$lib/services/cache';
	import { getItemIconUrl } from '$lib/utils/icons';
	import RecipePopover from '$lib/components/RecipePopover.svelte';
	import BuildingRecipePopover from '$lib/components/BuildingRecipePopover.svelte';
	import CargoRecipePopover from '$lib/components/CargoRecipePopover.svelte';
	import HaveBreakdownTooltip from '$lib/components/HaveBreakdownTooltip.svelte';
	import DevRequirementBreakdown from '$lib/components/DevRequirementBreakdown.svelte';
	import ExternalInventoryModal from '$lib/components/ExternalInventoryModal.svelte';
	import type { MaterialRequirement, StepGroup, ProfessionGroup, StepWithProfessionsGroup, ListViewMode, CraftingListEntry, ExternalInventoryRef } from '$lib/types/app';
	import { isItemEntry, isCargoEntry, isBuildingEntry } from '$lib/types/app';

	// Helper: Get unique material key for tracking
	function getMaterialKey(mat: MaterialRequirement): string {
		if (mat.nodeType === 'cargo') {
			return `cargo-${mat.cargoId}`;
		}
		if (mat.nodeType === 'building') {
			return `building-${mat.buildingId}`;
		}
		return `item-${mat.itemId}`;
	}

	// Helper: Get display name for a material
	function getMaterialName(mat: MaterialRequirement): string {
		if (mat.nodeType === 'cargo') {
			return mat.cargo?.name ?? `Cargo #${mat.cargoId}`;
		}
		if (mat.nodeType === 'building') {
			return mat.building?.name ?? mat.constructionRecipe?.name ?? `Building #${mat.buildingId}`;
		}
		return mat.item?.name ?? `Item #${mat.itemId}`;
	}

	// Helper: Get icon URL for a material
	function getMaterialIconUrl(mat: MaterialRequirement): string | null {
		if (mat.nodeType === 'cargo' && mat.cargo?.iconAssetName) {
			return getItemIconUrl(mat.cargo.iconAssetName);
		}
		if (mat.nodeType === 'building' && mat.building?.iconAssetName) {
			return getItemIconUrl(mat.building.iconAssetName);
		}
		if (mat.item?.iconAssetName) {
			return getItemIconUrl(mat.item.iconAssetName);
		}
		return null;
	}

	// Helper: Check if material is an item (for item-specific features like recipes)
	function isItemMaterial(mat: MaterialRequirement): boolean {
		return mat.nodeType === 'item';
	}

	// Get list from URL param
	const listId = $derived($page.params.id);
	const list = $derived(crafting.lists.find((l) => l.id === listId));

	// Inventory state
	let isSyncing = $state(false);
	let lastSyncMessage = $state<string | null>(null);

	// Material requirements state
	let requirements = $state<MaterialRequirement[]>([]);
	let stepGroups = $state<StepGroup[]>([]);
	let professionGroups = $state<ProfessionGroup[]>([]);
	let combinedGroups = $state<StepWithProfessionsGroup[]>([]);
	let isCalculating = $state(false);

	// Display options
	let viewMode = $state<ListViewMode>('step');
	let hideCompleted = $state(false);
	let collapsedSections = $state<Set<string>>(new Set());

	// Sharing state
	let isSharing = $state(false);
	let shareUrl = $state<string | null>(null);
	let shareError = $state<string | null>(null);
	let showShareModal = $state(false);
	let shareCopied = $state(false);

	// Manual tracking: user-entered "have" quantities and checked-off items
	// Uses string keys to support both items ("item-123") and cargo ("cargo-456")
	let manualHave = $state<Map<string, number>>(new Map()); // materialKey -> manual quantity
	let checkedOff = $state<Set<string>>(new Set()); // materialKey -> manually marked complete
	// Track previous baseRequired values to detect changes and auto-uncheck
	let prevBaseRequired = $state<Map<string, number>>(new Map()); // materialKey -> previous baseRequired
	// Legacy number-keyed maps for backwards compatibility with saved progress
	let legacyManualHave = $state<Map<number, number>>(new Map()); // itemId -> manual quantity (legacy)
	let legacyCheckedOff = $state<Set<number>>(new Set()); // itemId -> manually complete (legacy)

	// Recipe preferences: user-selected recipes for items with multiple options
	let recipePreferences = $state<Map<string, number>>(new Map()); // materialKey -> recipeId

	// Progress persistence
	let progressLoaded = $state(false);
	let saveTimeout: ReturnType<typeof setTimeout> | null = null;

	function scheduleProgressSave() {
		if (!listId || !progressLoaded) return;
		if (saveTimeout) clearTimeout(saveTimeout);
		saveTimeout = setTimeout(async () => {
			// Convert string-keyed maps to separate item, cargo, and building arrays for storage
			const itemManualHave: [number, number][] = [];
			const cargoManualHave: [number, number][] = [];
			const buildingManualHave: [number, number][] = [];
			for (const [key, qty] of manualHave) {
				if (key.startsWith('item-')) {
					const itemId = parseInt(key.substring(5), 10);
					if (!isNaN(itemId)) itemManualHave.push([itemId, qty]);
				} else if (key.startsWith('cargo-')) {
					const cargoId = parseInt(key.substring(6), 10);
					if (!isNaN(cargoId)) cargoManualHave.push([cargoId, qty]);
				} else if (key.startsWith('building-')) {
					const buildingId = parseInt(key.substring(9), 10);
					if (!isNaN(buildingId)) buildingManualHave.push([buildingId, qty]);
				}
			}
			const itemCheckedOff: number[] = [];
			const cargoCheckedOff: number[] = [];
			const buildingCheckedOff: number[] = [];
			for (const key of checkedOff) {
				if (key.startsWith('item-')) {
					const itemId = parseInt(key.substring(5), 10);
					if (!isNaN(itemId)) itemCheckedOff.push(itemId);
				} else if (key.startsWith('cargo-')) {
					const cargoId = parseInt(key.substring(6), 10);
					if (!isNaN(cargoId)) cargoCheckedOff.push(cargoId);
				} else if (key.startsWith('building-')) {
					const buildingId = parseInt(key.substring(9), 10);
					if (!isNaN(buildingId)) buildingCheckedOff.push(buildingId);
				}
			}
			// Serialize recipe preferences
			const recipePrefsArray = Array.from(recipePreferences.entries());

			await saveListProgress({
				listId,
				manualHave: itemManualHave,
				manualHaveCargo: cargoManualHave,
				manualHaveBuilding: buildingManualHave,
				checkedOff: itemCheckedOff,
				checkedOffCargo: cargoCheckedOff,
				checkedOffBuilding: buildingCheckedOff,
				recipePreferences: recipePrefsArray,
				hideCompleted,
				viewMode,
				collapsedSections: Array.from(collapsedSections),
				updatedAt: Date.now()
			});
		}, 500);
	}

	// Get manual have by material key
	function getManualHaveByKey(key: string): number | undefined {
		return manualHave.get(key);
	}

	// Legacy function for item ID (used in some places)
	function getManualHave(itemId: number): number | undefined {
		return manualHave.get(`item-${itemId}`);
	}

	let recalcTimeout: ReturnType<typeof setTimeout> | null = null;

	function setManualHaveByKey(key: string, qty: number) {
		const newMap = new Map(manualHave);
		if (qty <= 0) {
			newMap.delete(key);
		} else {
			newMap.set(key, qty);
		}
		manualHave = newMap;

		// Save progress
		scheduleProgressSave();

		// Debounce recalculation to avoid excessive calls while typing
		if (recalcTimeout) clearTimeout(recalcTimeout);
		recalcTimeout = setTimeout(() => {
			calculateRequirements();
		}, 300);
	}

	// Legacy function for item ID
	function setManualHave(itemId: number, qty: number) {
		setManualHaveByKey(`item-${itemId}`, qty);
	}

	function isCheckedOffByKey(key: string): boolean {
		return checkedOff.has(key);
	}

	// Legacy function for item ID
	function isCheckedOff(itemId: number): boolean {
		return checkedOff.has(`item-${itemId}`);
	}

	async function toggleCheckedOffByKey(key: string) {
		// Save scroll position before state change
		const scrollY = window.scrollY;

		const newSet = new Set(checkedOff);
		if (newSet.has(key)) {
			newSet.delete(key);
		} else {
			newSet.add(key);
		}
		checkedOff = newSet;
		// Save progress
		scheduleProgressSave();
		// Recalculate to propagate check-off through the tree
		await calculateRequirements();

		// Restore scroll position after DOM updates
		await tick();
		window.scrollTo(0, scrollY);
	}

	// Legacy function for item ID
	function toggleCheckedOff(itemId: number) {
		toggleCheckedOffByKey(`item-${itemId}`);
	}

	// Get effective "have" amount (manual override or from inventory)
	function getEffectiveHave(mat: MaterialRequirement): number {
		const key = getMaterialKey(mat);
		const manual = manualHave.get(key);
		return manual !== undefined ? manual : mat.have;
	}

	// Check if material is effectively complete (remaining after propagation is 0)
	function isEffectivelyComplete(mat: MaterialRequirement): boolean {
		const key = getMaterialKey(mat);
		if (checkedOff.has(key)) return true;
		return mat.remaining === 0;
	}

	// Filter step groups to exclude final items and apply hide completed
	// Helper to filter materials - excludes list entry root items/cargo
	function filterMaterials(materials: MaterialRequirement[], listEntryKeys: Set<string>): MaterialRequirement[] {
		let filtered = materials.filter((mat) => !listEntryKeys.has(getMaterialKey(mat)));
		if (hideCompleted) {
			filtered = filtered.filter((m) => !isEffectivelyComplete(m));
		}
		return filtered;
	}

	// Helper to get keys for all list entries (both items and cargo)
	function getListEntryKeys(entries: CraftingListEntry[]): Set<string> {
		const keys = new Set<string>();
		for (const entry of entries) {
			if (isItemEntry(entry)) {
				keys.add(`item-${entry.itemId}`);
			} else if (isCargoEntry(entry)) {
				keys.add(`cargo-${entry.cargoId}`);
			}
		}
		return keys;
	}

	const filteredStepGroups = $derived.by(() => {
		const listEntryKeys = getListEntryKeys(list?.entries || []);

		return stepGroups
			.map((group) => ({
				...group,
				materials: filterMaterials(group.materials, listEntryKeys)
			}))
			.filter((group) => group.materials.length > 0);
	});

	const filteredProfessionGroups = $derived.by(() => {
		const listEntryKeys = getListEntryKeys(list?.entries || []);

		return professionGroups
			.map((group) => ({
				...group,
				materials: filterMaterials(group.materials, listEntryKeys)
			}))
			.filter((group) => group.materials.length > 0);
	});

	const filteredCombinedGroups = $derived.by(() => {
		const listEntryKeys = getListEntryKeys(list?.entries || []);

		return combinedGroups
			.map((stepGroup) => ({
				...stepGroup,
				professionGroups: stepGroup.professionGroups
					.map((profGroup) => ({
						...profGroup,
						materials: filterMaterials(profGroup.materials, listEntryKeys)
					}))
					.filter((profGroup) => profGroup.materials.length > 0)
			}))
			.filter((stepGroup) => stepGroup.professionGroups.length > 0);
	});

	// Count of completed entries in the Final Crafts list
	const completedEntriesCount = $derived.by(() => {
		if (!list?.entries) return 0;
		return list.entries.filter((entry) => {
			const key = isItemEntry(entry)
				? `item-${entry.itemId}`
				: isCargoEntry(entry)
					? `cargo-${entry.cargoId}`
					: `building-${entry.constructionRecipeId}`;
			const have = manualHave.get(key) ?? 0;
			return checkedOff.has(key) || have >= entry.quantity;
		}).length;
	});

	// Total remaining effort for the entire list
	const totalListEffort = $derived.by(() => {
		return requirements.reduce((sum, mat) => sum + (mat.effort ?? 0), 0);
	});

	function toggleSection(section: string) {
		const newSet = new Set(collapsedSections);
		if (newSet.has(section)) {
			newSet.delete(section);
		} else {
			newSet.add(section);
		}
		collapsedSections = newSet;
		// Save progress
		scheduleProgressSave();
	}

	function isSectionCollapsed(section: string): boolean {
		return collapsedSections.has(section);
	}

	function setHideCompleted(value: boolean) {
		hideCompleted = value;
		scheduleProgressSave();
	}

	function setViewMode(mode: ListViewMode) {
		viewMode = mode;
		scheduleProgressSave();
	}

	// Item/Building/Cargo search for adding
	type SearchTab = 'items' | 'buildings' | 'cargo';
	let searchTab = $state<SearchTab>('items');
	let searchQuery = $state('');
	let searchResults = $state<ReturnType<typeof searchItems>>([]);
	let buildingSearchResults = $state<ConstructionRecipe[]>([]);
	let cargoSearchResults = $state<Cargo[]>([]);
	let showAddModal = $state(false);
	let searchInputEl = $state<HTMLInputElement | null>(null);
	let itemQuantities = $state<Map<number, number>>(new Map());
	let itemRecipes = $state<Map<number, number | undefined>>(new Map()); // itemId -> selected recipeId
	let recentlyAdded = $state<Map<number, boolean>>(new Map()); // itemId -> show checkmark
	let buildingQuantities = $state<Map<number, number>>(new Map()); // constructionRecipeId -> quantity
	let recentlyAddedBuildings = $state<Map<number, boolean>>(new Map()); // constructionRecipeId -> show checkmark
	let cargoQuantities = $state<Map<number, number>>(new Map()); // cargoId -> quantity
	let recentlyAddedCargo = $state<Map<number, boolean>>(new Map()); // cargoId -> show checkmark

	// Focus search input when add modal opens
	$effect(() => {
		if (showAddModal && searchInputEl) {
			// Small delay to ensure DOM is ready
			setTimeout(() => searchInputEl?.focus(), 0);
		}
	});

	// Inventory source selection modal
	let showSourceModal = $state(false);
	let selectedSourceIds = $state<string[]>([]);

	// External inventory modal
	let showExternalModal = $state(false);
	let externalSyncing = $state<string | null>(null); // externalRefId currently syncing

	// Recipe selection modal
	let showRecipeModal = $state(false);
	let recipeModalItemId = $state<number | null>(null);
	let recipeModalMaterialKey = $state<string | null>(null);
	let selectedModalRecipeId = $state<number | undefined>(undefined);
	let recipeModalIsTopLevel = $state(false); // true if editing a top-level list entry

	// Auto-sync on mount (wait for game data to be loaded)
	$effect(() => {
		if (list && gameData.isInitialized) {
			// Initialize selected sources from list
			selectedSourceIds = [...list.enabledSourceIds];

			// Load saved progress from IndexedDB
			loadProgress();

			// Auto-sync if stale
			handleAutoSync();
		}
	});

	// Periodic auto-refresh while viewing the list
	$effect(() => {
		// Only set up interval if list is loaded and auto-refresh is enabled
		if (!list || list.autoRefreshEnabled === false) return;
		if (settings.autoRefreshMinutes === 0) return;

		// Check every minute if inventory is stale
		const intervalMs = 60 * 1000; // Check every minute
		const intervalId = setInterval(() => {
			handleAutoSync();
		}, intervalMs);

		// Cleanup on unmount or when dependencies change
		return () => clearInterval(intervalId);
	});

	async function loadProgress() {
		if (!listId) return;

		const progress = await getListProgress(listId);
		if (progress) {
			// Convert legacy number-keyed data to string-keyed format
			const newManualHave = new Map<string, number>();
			for (const [itemId, qty] of progress.manualHave) {
				newManualHave.set(`item-${itemId}`, qty);
			}
			// Also load cargo manual have if present
			if (progress.manualHaveCargo) {
				for (const [cargoId, qty] of progress.manualHaveCargo) {
					newManualHave.set(`cargo-${cargoId}`, qty);
				}
			}
			// Also load building manual have if present
			if (progress.manualHaveBuilding) {
				for (const [buildingId, qty] of progress.manualHaveBuilding) {
					newManualHave.set(`building-${buildingId}`, qty);
				}
			}
			manualHave = newManualHave;

			const newCheckedOff = new Set<string>();
			for (const itemId of progress.checkedOff) {
				newCheckedOff.add(`item-${itemId}`);
			}
			// Also load cargo checked off if present
			if (progress.checkedOffCargo) {
				for (const cargoId of progress.checkedOffCargo) {
					newCheckedOff.add(`cargo-${cargoId}`);
				}
			}
			// Also load building checked off if present
			if (progress.checkedOffBuilding) {
				for (const buildingId of progress.checkedOffBuilding) {
					newCheckedOff.add(`building-${buildingId}`);
				}
			}
			checkedOff = newCheckedOff;

			// Load recipe preferences
			if (progress.recipePreferences) {
				recipePreferences = new Map(progress.recipePreferences);
			}

			hideCompleted = progress.hideCompleted;
			viewMode = progress.viewMode;
			collapsedSections = new Set(progress.collapsedSections);
		}

		progressLoaded = true;
		// Calculate requirements after loading progress
		calculateRequirements();
	}

	// Recalculate when list entries change
	$effect(() => {
		if (list?.entries && gameData.isInitialized) {
			calculateRequirements();
		}
	});

	async function handleAutoSync() {
		// Skip auto-sync if disabled for this list
		if (list?.autoRefreshEnabled === false) return;

		isSyncing = true;
		try {
			let didSync = await syncIfStale();

			// Also sync stale external inventories for this list
			if (list?.externalInventoryRefs?.length) {
				const staleRefs = getStaleExternalRefs(list.id, settings.autoRefreshMinutes);
				for (const ref of staleRefs) {
					try {
						if (ref.type === 'player') {
							await syncExternalPlayerInventory(ref.entityId, ref.name);
						} else {
							await syncExternalClaimInventory(ref.entityId, ref.name);
						}
						didSync = true;
					} catch (e) {
						console.error(`Failed to auto-sync external ${ref.type} ${ref.entityId}:`, e);
					}
				}
			}

			if (didSync) {
				lastSyncMessage = 'Inventory synced automatically';
				setTimeout(() => (lastSyncMessage = null), 3000);
				// Recalculate requirements with new inventory data
				await calculateRequirements();
			}
		} catch (e) {
			console.error('Auto-sync failed:', e);
		} finally {
			isSyncing = false;
		}
	}

	async function toggleAutoRefresh() {
		if (!list) return;
		const newValue = list.autoRefreshEnabled === false;
		await updateListAutoRefresh(list.id, newValue);
	}

	async function toggleUsePackages() {
		if (!list) return;
		await updateListUsePackages(list.id, !list.usePackages);
		// Recalculate requirements after toggling
		await calculateRequirements();
	}

	async function handleShare() {
		if (!list) return;

		// Check if list already has a valid (non-expired) share
		if (list.shareToken && list.shareExpiresAt && list.shareExpiresAt > Date.now()) {
			shareUrl = `${window.location.origin}/share/${list.shareToken}`;
			showShareModal = true;
			return;
		}

		isSharing = true;
		shareError = null;

		try {
			const response = await fetch('/api/share', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(list)
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({ message: 'Failed to share' }));
				throw new Error(data.message || 'Failed to create share link');
			}

			const data = await response.json();
			shareUrl = `${window.location.origin}${data.shareUrl}`;

			// Save share info to the list
			const expiresAt = new Date(data.expiresAt).getTime();
			await updateListShare(list.id, data.token, expiresAt);

			showShareModal = true;
		} catch (e) {
			shareError = e instanceof Error ? e.message : 'Failed to create share link';
			showShareModal = true;
		} finally {
			isSharing = false;
		}
	}

	function copyShareUrl() {
		if (shareUrl) {
			navigator.clipboard.writeText(shareUrl);
			shareCopied = true;
			setTimeout(() => {
				shareCopied = false;
			}, 2000);
		}
	}

	async function handleManualSync() {
		isSyncing = true;
		try {
			await syncAllInventories();
			lastSyncMessage = 'Inventory refreshed';
			setTimeout(() => (lastSyncMessage = null), 3000);
			await calculateRequirements();
		} catch (e) {
			console.error('Manual sync failed:', e);
			lastSyncMessage = 'Sync failed';
		} finally {
			isSyncing = false;
		}
	}

	async function calculateRequirements() {
		if (!list) return;

		isCalculating = true;
		try {
			// Convert string-keyed maps to number-keyed for the API (items only, cargo doesn't have inventory)
			const itemManualHave = new Map<number, number>();
			for (const [key, qty] of manualHave) {
				if (key.startsWith('item-')) {
					const itemId = parseInt(key.substring(5), 10);
					if (!isNaN(itemId)) itemManualHave.set(itemId, qty);
				}
			}

			// checkedOff is already a Set<string> with keys like 'item-123', 'cargo-456'
			const newRequirements = await calculateListRequirements(list.id, itemManualHave, checkedOff, recipePreferences);

			// Build set of final craft keys (list entries) - these should NOT be auto-unchecked
			const finalCraftKeys = new Set<string>();
			for (const entry of list.entries) {
				if (isItemEntry(entry)) {
					finalCraftKeys.add(`item-${entry.itemId}`);
				} else if (isCargoEntry(entry)) {
					finalCraftKeys.add(`cargo-${entry.cargoId}`);
				} else if (isBuildingEntry(entry)) {
					finalCraftKeys.add(`building-${entry.constructionRecipeId}`);
				}
			}

			// Auto-uncheck materials whose baseRequired changed (excluding final crafts)
			let checkedOffChanged = false;
			const newCheckedOff = new Set(checkedOff);
			for (const mat of newRequirements) {
				const matKey = getMaterialKey(mat);
				const prevRequired = prevBaseRequired.get(matKey);

				// If this material is checked off, not a final craft, and its requirement changed, uncheck it
				if (
					checkedOff.has(matKey) &&
					!finalCraftKeys.has(matKey) &&
					prevRequired !== undefined &&
					prevRequired !== mat.baseRequired
				) {
					newCheckedOff.delete(matKey);
					checkedOffChanged = true;
				}
			}

			// Update checkedOff if any were auto-unchecked
			if (checkedOffChanged) {
				checkedOff = newCheckedOff;
				scheduleProgressSave();
			}

			// Update prevBaseRequired for next comparison
			const newPrevBaseRequired = new Map<string, number>();
			for (const mat of newRequirements) {
				newPrevBaseRequired.set(getMaterialKey(mat), mat.baseRequired);
			}
			prevBaseRequired = newPrevBaseRequired;

			requirements = newRequirements;
			stepGroups = groupRequirementsByStep(requirements);
			professionGroups = groupRequirementsByProfession(requirements);
			combinedGroups = groupRequirementsByStepWithProfessions(requirements);
		} catch (e) {
			console.error('Failed to calculate requirements:', e);
		} finally {
			isCalculating = false;
		}
	}

	function handleSearch(query: string) {
		searchQuery = query;
		if (query.length >= 2) {
			searchResults = searchItems(query, 50);
			buildingSearchResults = searchConstructionRecipes(query, 50);
			cargoSearchResults = searchCargos(query, 50);
		} else {
			searchResults = [];
			buildingSearchResults = [];
			cargoSearchResults = [];
		}
	}

	function getItemQuantity(itemId: number): number {
		return itemQuantities.get(itemId) ?? 1;
	}

	function setItemQuantity(itemId: number, quantity: number) {
		const newMap = new Map(itemQuantities);
		newMap.set(itemId, Math.max(1, quantity));
		itemQuantities = newMap;
	}

	function handleQuantityWheel(itemId: number, event: WheelEvent) {
		event.preventDefault();
		const currentQty = getItemQuantity(itemId);
		const delta = event.deltaY < 0 ? 1 : -1;
		setItemQuantity(itemId, currentQty + delta);
	}

	function getSelectedRecipe(itemId: number): number | undefined {
		return itemRecipes.get(itemId);
	}

	function setSelectedRecipe(itemId: number, recipeId: number | undefined) {
		const newMap = new Map(itemRecipes);
		newMap.set(itemId, recipeId);
		itemRecipes = newMap;
	}

	// Get recipes sorted by cost (cheapest first)
	function getSortedRecipes(itemId: number) {
		const recipes = findRecipesForItem(itemId);
		return [...recipes].sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity));
	}

	// Format cost for display
	function formatCost(cost: number | undefined): string {
		if (cost === undefined) return '';
		if (cost >= 1000000) return `${(cost / 1000000).toFixed(1)}M`;
		if (cost >= 1000) return `${(cost / 1000).toFixed(1)}K`;
		if (cost >= 10) return cost.toFixed(0);
		if (cost >= 1) return cost.toFixed(1);
		return cost.toFixed(2);
	}

	// Format quantity for display (integers)
	function formatQty(qty: number): string {
		if (qty >= 1000000) return `${(qty / 1000000).toFixed(1)}M`;
		if (qty >= 10000) return `${(qty / 1000).toFixed(1)}K`;
		if (qty >= 1000) return qty.toLocaleString();
		return qty.toString();
	}

	// Format effort for display
	function formatEffort(effort: number | undefined): string {
		if (effort === undefined || effort === 0) return '';
		if (effort >= 1000000) return `${(effort / 1000000).toFixed(1)}M`;
		if (effort >= 10000) return `${(effort / 1000).toFixed(1)}K`;
		if (effort >= 1000) return effort.toLocaleString();
		return effort.toString();
	}

	// Get the best default recipe for an item
	function getDefaultRecipeId(itemId: number): number | undefined {
		const item = getItemById(itemId);
		if (item?.defaultRecipeId) return item.defaultRecipeId;
		const recipes = findRecipesForItem(itemId);
		return recipes[0]?.id;
	}

	function isRecentlyAdded(itemId: number): boolean {
		return recentlyAdded.get(itemId) ?? false;
	}

	async function handleAddItem(itemId: number) {
		if (!list) return;
		const quantity = getItemQuantity(itemId);
		// Use selected recipe or default to cheapest recipe
		const recipeId = getSelectedRecipe(itemId) ?? getDefaultRecipeId(itemId);
		await addItemToList(list.id, itemId, quantity, recipeId);

		// Show checkmark animation
		const newAdded = new Map(recentlyAdded);
		newAdded.set(itemId, true);
		recentlyAdded = newAdded;

		// Reset checkmark after delay
		setTimeout(() => {
			const resetAdded = new Map(recentlyAdded);
			resetAdded.delete(itemId);
			recentlyAdded = resetAdded;
		}, 1500);
	}

	// Building quantity helpers
	function getBuildingQuantity(recipeId: number): number {
		return buildingQuantities.get(recipeId) ?? 1;
	}

	function setBuildingQuantity(recipeId: number, quantity: number) {
		const newMap = new Map(buildingQuantities);
		newMap.set(recipeId, Math.max(1, quantity));
		buildingQuantities = newMap;
	}

	function handleBuildingQuantityWheel(recipeId: number, event: WheelEvent) {
		event.preventDefault();
		const currentQty = getBuildingQuantity(recipeId);
		const delta = event.deltaY < 0 ? 1 : -1;
		setBuildingQuantity(recipeId, currentQty + delta);
	}

	function isBuildingRecentlyAdded(recipeId: number): boolean {
		return recentlyAddedBuildings.get(recipeId) ?? false;
	}

	async function handleAddBuilding(recipeId: number) {
		if (!list) return;
		const quantity = getBuildingQuantity(recipeId);
		await addBuildingToList(list.id, recipeId, quantity);

		// Show checkmark animation
		const newAdded = new Map(recentlyAddedBuildings);
		newAdded.set(recipeId, true);
		recentlyAddedBuildings = newAdded;

		// Reset checkmark after delay
		setTimeout(() => {
			const resetAdded = new Map(recentlyAddedBuildings);
			resetAdded.delete(recipeId);
			recentlyAddedBuildings = resetAdded;
		}, 1500);
	}

	// Cargo quantity helpers
	function getCargoQuantity(cargoId: number): number {
		return cargoQuantities.get(cargoId) ?? 1;
	}

	function setCargoQuantity(cargoId: number, quantity: number) {
		const newMap = new Map(cargoQuantities);
		newMap.set(cargoId, Math.max(1, quantity));
		cargoQuantities = newMap;
	}

	function handleCargoQuantityWheel(cargoId: number, event: WheelEvent) {
		event.preventDefault();
		const currentQty = getCargoQuantity(cargoId);
		const delta = event.deltaY < 0 ? 1 : -1;
		setCargoQuantity(cargoId, currentQty + delta);
	}

	function isCargoRecentlyAdded(cargoId: number): boolean {
		return recentlyAddedCargo.get(cargoId) ?? false;
	}

	async function handleAddCargo(cargoId: number) {
		if (!list) return;
		const quantity = getCargoQuantity(cargoId);
		await addCargoToList(list.id, cargoId, quantity);

		// Show checkmark animation
		const newAdded = new Map(recentlyAddedCargo);
		newAdded.set(cargoId, true);
		recentlyAddedCargo = newAdded;

		// Reset checkmark after delay
		setTimeout(() => {
			const resetAdded = new Map(recentlyAddedCargo);
			resetAdded.delete(cargoId);
			recentlyAddedCargo = resetAdded;
		}, 1500);
	}

	function closeAddModal() {
		showAddModal = false;
		searchTab = 'items';
		searchQuery = '';
		searchResults = [];
		buildingSearchResults = [];
		cargoSearchResults = [];
		itemQuantities = new Map();
		itemRecipes = new Map();
		recentlyAdded = new Map();
		buildingQuantities = new Map();
		recentlyAddedBuildings = new Map();
		cargoQuantities = new Map();
		recentlyAddedCargo = new Map();
	}

	async function handleRemoveItem(itemId: number) {
		if (!list) return;
		await removeItemFromList(list.id, itemId);
	}

	async function handleRemoveEntry(entryId: string) {
		if (!list) return;
		await removeEntryFromList(list.id, entryId);
	}

	async function handleQuantityChange(itemId: number, quantity: number) {
		if (!list) return;
		await updateItemQuantity(list.id, itemId, quantity);
	}

	async function handleEntryQuantityChange(entryId: string, quantity: number) {
		if (!list) return;
		await updateEntryQuantity(list.id, entryId, quantity);
		await calculateRequirements();
	}

	function openSourceModal() {
		if (list) {
			selectedSourceIds = [...list.enabledSourceIds];
		}
		showSourceModal = true;
	}

	async function saveSourceSelection() {
		if (!list) return;
		await updateListSources(list.id, selectedSourceIds);
		showSourceModal = false;
		await calculateRequirements();
	}

	function toggleSource(sourceId: string) {
		// If empty (meaning "all"), populate with all source IDs first
		if (selectedSourceIds.length === 0) {
			const allIds = inventory.sources.map((s) => s.id);
			// Remove the one being unchecked
			selectedSourceIds = allIds.filter((id) => id !== sourceId);
		} else if (selectedSourceIds.includes(sourceId)) {
			selectedSourceIds = selectedSourceIds.filter((id) => id !== sourceId);
		} else {
			selectedSourceIds = [...selectedSourceIds, sourceId];
		}
	}

	function toggleAllSources(claimId: string, enable: boolean) {
		const claimSources = sourcesByClaim.value.get(claimId) || [];
		const claimSourceIds = claimSources.map((s) => s.id);

		if (enable) {
			// If empty (all), just stay empty or add these
			if (selectedSourceIds.length === 0) {
				// Already all selected, nothing to do
				return;
			}
			const newIds = new Set([...selectedSourceIds, ...claimSourceIds]);
			selectedSourceIds = [...newIds];
		} else {
			// If empty (meaning "all"), populate with all IDs first, then remove claim's sources
			if (selectedSourceIds.length === 0) {
				const allIds = inventory.sources.map((s) => s.id);
				selectedSourceIds = allIds.filter((id) => !claimSourceIds.includes(id));
			} else {
				selectedSourceIds = selectedSourceIds.filter((id) => !claimSourceIds.includes(id));
			}
		}
	}

	// External inventory handlers
	async function handleAddExternalRef(ref: ExternalInventoryRef) {
		if (!list) return;
		await addExternalRefToList(list.id, ref);
		// Add the new sources to selectedSourceIds
		const externalRefId = `${ref.type}:${ref.entityId}`;
		const newSources = getExternalSourcesByRef(externalRefId);
		if (selectedSourceIds.length > 0) {
			// If we have specific sources selected, add the new ones
			const newIds = new Set([...selectedSourceIds, ...newSources.map((s) => s.id)]);
			selectedSourceIds = [...newIds];
		}
		showExternalModal = false;
		await calculateRequirements();
	}

	async function handleRemoveExternalRef(externalRefId: string) {
		if (!list) return;
		await removeExternalRefFromList(list.id, externalRefId);
		await calculateRequirements();
	}

	async function handleSyncExternalRef(ref: ExternalInventoryRef) {
		const externalRefId = `${ref.type}:${ref.entityId}`;
		externalSyncing = externalRefId;
		try {
			if (ref.type === 'player') {
				await syncExternalPlayerInventory(ref.entityId, ref.name);
			} else {
				await syncExternalClaimInventory(ref.entityId, ref.name);
			}
			await calculateRequirements();
		} catch (e) {
			console.error(`Failed to sync external ${ref.type}:`, e);
		} finally {
			externalSyncing = null;
		}
	}

	function toggleExternalSource(sourceId: string) {
		// Same logic as toggleSource
		if (selectedSourceIds.length === 0) {
			const allIds = inventory.sources.map((s) => s.id);
			selectedSourceIds = allIds.filter((id) => id !== sourceId);
		} else if (selectedSourceIds.includes(sourceId)) {
			selectedSourceIds = selectedSourceIds.filter((id) => id !== sourceId);
		} else {
			selectedSourceIds = [...selectedSourceIds, sourceId];
		}
	}

	function toggleAllExternalSources(externalRefId: string, enable: boolean) {
		const externalSources = getExternalSourcesByRef(externalRefId);
		const externalSourceIds = externalSources.map((s) => s.id);

		if (enable) {
			if (selectedSourceIds.length === 0) {
				return; // Already all selected
			}
			const newIds = new Set([...selectedSourceIds, ...externalSourceIds]);
			selectedSourceIds = [...newIds];
		} else {
			if (selectedSourceIds.length === 0) {
				const allIds = inventory.sources.map((s) => s.id);
				selectedSourceIds = allIds.filter((id) => !externalSourceIds.includes(id));
			} else {
				selectedSourceIds = selectedSourceIds.filter((id) => !externalSourceIds.includes(id));
			}
		}
	}

	function openRecipeModal(mat: MaterialRequirement, isTopLevel = false) {
		if (mat.nodeType !== 'item' || !mat.itemId) return;

		const recipes = findRecipesForItem(mat.itemId);
		// Filter to valid recipes (same logic as RecipePopover)
		const validRecipes = recipes.filter(r => {
			const hasItemIngredients = r.ingredients.length > 0;
			const hasCargoIngredients = (r.cargoIngredients?.length ?? 0) > 0;
			if (!hasItemIngredients && !hasCargoIngredients) return false;
			if (hasItemIngredients && !r.ingredients.every(ing => getItemById(ing.itemId) !== undefined)) return false;
			// Check if it's a downgrade recipe
			if (!mat.itemId) return false;
			const outputItem = getItemById(mat.itemId);
			if (!outputItem || outputItem.tier === -1) return true;
			return !r.ingredients.some(ing => {
				const ingItem = getItemById(ing.itemId);
				if (!ingItem || ingItem.tier === -1) return false;
				return ingItem.tier > outputItem.tier;
			});
		});

		if (validRecipes.length <= 1) return;

		recipeModalItemId = mat.itemId;
		recipeModalMaterialKey = getMaterialKey(mat);
		recipeModalIsTopLevel = isTopLevel;

		// For top-level items, get current recipe from entry; for sub-materials, use preferences
		if (isTopLevel && list) {
			const entry = list.entries.find(e => isItemEntry(e) && e.itemId === mat.itemId);
			selectedModalRecipeId = (entry && isItemEntry(entry) ? entry.recipeId : undefined) ?? getDefaultRecipeId(mat.itemId);
		} else {
			selectedModalRecipeId = recipePreferences.get(recipeModalMaterialKey) ?? getDefaultRecipeId(mat.itemId);
		}
		showRecipeModal = true;
	}

	async function applyRecipeSelection() {
		if (!recipeModalMaterialKey || selectedModalRecipeId === undefined) return;

		if (recipeModalIsTopLevel && list && recipeModalItemId) {
			// For top-level items, update the entry's recipeId
			await updateEntryRecipe(list.id, recipeModalItemId, selectedModalRecipeId);
		} else {
			// For sub-materials, update recipe preferences
			const newMap = new Map(recipePreferences);
			newMap.set(recipeModalMaterialKey, selectedModalRecipeId);
			recipePreferences = newMap;
			scheduleProgressSave();
		}

		calculateRequirements(); // Recalculate with new recipe

		closeRecipeModal();
	}

	function closeRecipeModal() {
		showRecipeModal = false;
		recipeModalItemId = null;
		recipeModalMaterialKey = null;
		selectedModalRecipeId = undefined;
		recipeModalIsTopLevel = false;
	}

	function formatLastSync(): string {
		if (!settings.inventoryLastSync) return 'Never';
		const diff = Date.now() - settings.inventoryLastSync;
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'Just now';
		if (mins === 1) return '1 minute ago';
		if (mins < 60) return `${mins} minutes ago`;
		const hours = Math.floor(mins / 60);
		if (hours === 1) return '1 hour ago';
		return `${hours} hours ago`;
	}
</script>

{#if !list}
	<div class="flex flex-col items-center justify-center p-8">
		<p class="text-gray-400">List not found</p>
		<a href="/lists" class="mt-4 text-blue-400 hover:underline">Back to Lists</a>
	</div>
{:else}
	<div class="space-y-6">
		<!-- Header -->
		<div class="flex items-start justify-between">
			<div>
				<div class="flex items-center gap-2">
					<a href="/lists" class="text-gray-400 hover:text-white" aria-label="Back to lists">
						<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M15 19l-7-7 7-7"
							/>
						</svg>
					</a>
					<h2 class="text-xl font-semibold text-white">{list.name}</h2>
				</div>
				{#if list.description}
					<p class="mt-1 text-sm text-gray-400">{list.description}</p>
				{/if}
			</div>

			<div class="flex items-center gap-2">
				<!-- Inventory Sources Button -->
				<button
					onclick={openSourceModal}
					class="rounded-lg bg-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-600"
				>
					<span class="flex items-center gap-2">
						<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
							/>
						</svg>
						Inventory Sources
						{#if list.enabledSourceIds.length > 0}
							<span class="rounded-full bg-blue-600 px-2 py-0.5 text-xs"
								>{list.enabledSourceIds.length}</span
							>
						{:else}
							<span class="rounded-full bg-gray-600 px-2 py-0.5 text-xs">All</span>
						{/if}
					</span>
				</button>

				<!-- Auto-refresh Toggle -->
				<button
					onclick={toggleAutoRefresh}
					class="flex items-center gap-2 rounded-lg bg-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-600"
					title={list.autoRefreshEnabled !== false
						? 'Auto-refresh enabled'
						: 'Auto-refresh disabled'}
				>
					<span class="text-gray-400">Auto Refresh</span>
					<div
						class="relative h-5 w-9 rounded-full transition-colors {list.autoRefreshEnabled !==
						false
							? 'bg-blue-600'
							: 'bg-gray-600'}"
					>
						<div
							class="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all {list.autoRefreshEnabled !==
							false
								? 'left-4'
								: 'left-0.5'}"
						></div>
					</div>
				</button>

				<!-- Use Packages Toggle -->
				<button
					onclick={toggleUsePackages}
					class="flex items-center gap-2 rounded-lg bg-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-600"
					title={list.usePackages
						? 'Using packages from inventory to satisfy material requirements'
						: 'Packages in inventory will not be used as materials'}
				>
					<span class="text-gray-400">Use Packages</span>
					<div
						class="relative h-5 w-9 rounded-full transition-colors {list.usePackages
							? 'bg-blue-600'
							: 'bg-gray-600'}"
					>
						<div
							class="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all {list.usePackages
								? 'left-4'
								: 'left-0.5'}"
						></div>
					</div>
				</button>

				<!-- Refresh Button -->
				<button
					onclick={handleManualSync}
					disabled={isSyncing}
					class="rounded-lg bg-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-600 disabled:opacity-50"
					title="Last sync: {formatLastSync()}"
				>
					{#if isSyncing}
						<span class="flex items-center gap-2">
							<span
								class="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent"
							></span>
							Syncing...
						</span>
					{:else}
						<span class="flex items-center gap-2">
							<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
								/>
							</svg>
							Refresh
						</span>
					{/if}
				</button>

				<!-- Share Button -->
				<button
					onclick={handleShare}
					disabled={isSharing || !list?.entries.length}
					class="rounded-lg bg-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-600 disabled:opacity-50"
					title="Share this list"
				>
					{#if isSharing}
						<span class="flex items-center gap-2">
							<span
								class="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent"
							></span>
							Sharing...
						</span>
					{:else}
						<span class="flex items-center gap-2">
							<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
								/>
							</svg>
							Share
						</span>
					{/if}
				</button>

				<!-- Add Item Button -->
				<button
					onclick={() => (showAddModal = true)}
					class="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
				>
					+ Add Item
				</button>
			</div>
		</div>

		<!-- Options bar -->
		<div class="flex items-center justify-between gap-4">
			<button
				onclick={() => setHideCompleted(!hideCompleted)}
				class="flex items-center gap-2 text-sm text-gray-300 hover:text-white"
			>
				<span>Hide completed</span>
				<div
					class="relative h-5 w-9 rounded-full transition-colors {hideCompleted
						? 'bg-blue-600'
						: 'bg-gray-600'}"
				>
					<div
						class="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all {hideCompleted
							? 'left-4'
							: 'left-0.5'}"
					></div>
				</div>
			</button>

			<!-- View Mode Selector -->
			<div class="flex items-center rounded-lg bg-gray-800 p-1">
				<button
					onclick={() => setViewMode('step')}
					class="rounded-md px-3 py-1 text-sm transition-colors {viewMode === 'step'
						? 'bg-blue-600 text-white'
						: 'text-gray-400 hover:text-white'}"
				>
					Step
				</button>
				<button
					onclick={() => setViewMode('profession')}
					class="rounded-md px-3 py-1 text-sm transition-colors {viewMode === 'profession'
						? 'bg-blue-600 text-white'
						: 'text-gray-400 hover:text-white'}"
				>
					Profession
				</button>
				<button
					onclick={() => setViewMode('combined')}
					class="rounded-md px-3 py-1 text-sm transition-colors {viewMode === 'combined'
						? 'bg-blue-600 text-white'
						: 'text-gray-400 hover:text-white'}"
				>
					Combined
				</button>
			</div>
		</div>

		<!-- Sync message -->
		{#if lastSyncMessage}
			<div class="rounded-lg bg-green-900/50 px-4 py-2 text-sm text-green-300">
				{lastSyncMessage}
			</div>
		{/if}

		<!-- Total Effort Summary (Top) -->
		{#if totalListEffort > 0}
			<div class="flex items-center justify-between rounded-lg bg-gray-800 px-4 py-2">
				<span class="text-sm text-gray-400">Total Remaining Effort:</span>
				<span class="text-lg font-semibold tabular-nums text-cyan-400">{formatEffort(totalListEffort)}</span>
			</div>
		{/if}

		<!-- Sections Container -->
		<div class="space-y-2">
			{#if list.entries.length > 0}
				{#if isCalculating}
					<div class="flex items-center gap-2 rounded-lg bg-gray-800 px-4 py-3 text-gray-400">
						<span
							class="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent"
						></span>
						Calculating materials...
					</div>
				{:else}
					<!-- STEP VIEW -->
					{#if viewMode === 'step'}
						{#each filteredStepGroups as group (group.step)}
							{@const completedInGroup =
								stepGroups
									.find((g) => g.step === group.step)
									?.materials.filter((m) => isEffectivelyComplete(m)).length || 0}
							{@const totalInGroup =
								stepGroups.find((g) => g.step === group.step)?.materials.length || 0}
							{@const sectionId = `step-${group.step}`}
							{@const headerColor =
								group.step === 1
									? 'bg-amber-900/50 hover:bg-amber-900/70'
									: 'bg-blue-900/40 hover:bg-blue-900/60'}
							{@const textColor = group.step === 1 ? 'text-amber-200' : 'text-blue-200'}
							{@const iconColor = group.step === 1 ? 'text-amber-400' : 'text-blue-400'}
							<div class="overflow-hidden rounded-lg bg-gray-800">
								<button
									type="button"
									onclick={() => toggleSection(sectionId)}
									class="flex w-full items-center justify-between {headerColor} px-4 py-2 text-left"
								>
									<div class="flex items-center gap-2">
										<svg
											class="h-4 w-4 {iconColor} transition-transform {isSectionCollapsed(sectionId)
												? ''
												: 'rotate-90'}"
											fill="none"
											stroke="currentColor"
											viewBox="0 0 24 24"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width="2"
												d="M9 5l7 7-7 7"
											/>
										</svg>
										<span class="font-medium {textColor}"
											>{group.label} ({group.materials.length} items)</span
										>
										{#if completedInGroup > 0}
											<span class="text-xs text-green-400"
												>{completedInGroup}/{totalInGroup} done</span
											>
										{/if}
									</div>
								</button>

								{#if !isSectionCollapsed(sectionId)}
									<div class="divide-y divide-gray-700">
										{#each group.materials as mat, i (getMaterialKey(mat))}
											{@const matIconUrl = getMaterialIconUrl(mat)}
											{@const effectiveHave = getEffectiveHave(mat)}
											{@const isComplete = isEffectivelyComplete(mat)}
											{@const prevTier = i > 0 ? group.materials[i - 1].tier : null}
											<!-- Tier divider if tier changed -->
											{#if prevTier !== null && mat.tier !== prevTier}
												<div class="bg-gray-750 px-4 py-1 text-xs text-gray-500">
													Tier {mat.tier}
												</div>
											{/if}
											{@render materialRow(mat, matIconUrl, effectiveHave, isComplete, i)}
										{/each}
									</div>
								{/if}
							</div>
						{/each}

					<!-- PROFESSION VIEW -->
					{:else if viewMode === 'profession'}
						{#each filteredProfessionGroups as group (group.profession)}
							{@const completedInGroup =
								professionGroups
									.find((g) => g.profession === group.profession)
									?.materials.filter((m) => isEffectivelyComplete(m)).length || 0}
							{@const totalInGroup =
								professionGroups.find((g) => g.profession === group.profession)?.materials.length || 0}
							{@const sectionId = `prof-${group.profession}`}
							<div class="overflow-hidden rounded-lg bg-gray-800">
								<button
									type="button"
									onclick={() => toggleSection(sectionId)}
									class="flex w-full items-center justify-between bg-emerald-900/40 hover:bg-emerald-900/60 px-4 py-2 text-left"
								>
									<div class="flex items-center gap-2">
										<svg
											class="h-4 w-4 text-emerald-400 transition-transform {isSectionCollapsed(sectionId)
												? ''
												: 'rotate-90'}"
											fill="none"
											stroke="currentColor"
											viewBox="0 0 24 24"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width="2"
												d="M9 5l7 7-7 7"
											/>
										</svg>
										<span class="font-medium text-emerald-200"
											>{group.profession} ({group.materials.length} items)</span
										>
										{#if completedInGroup > 0}
											<span class="text-xs text-green-400"
												>{completedInGroup}/{totalInGroup} done</span
											>
										{/if}
									</div>
								</button>

								{#if !isSectionCollapsed(sectionId)}
									<div class="divide-y divide-gray-700">
										{#each group.materials as mat, i (getMaterialKey(mat))}
											{@const matIconUrl = getMaterialIconUrl(mat)}
											{@const effectiveHave = getEffectiveHave(mat)}
											{@const isComplete = isEffectivelyComplete(mat)}
											{@const prevTier = i > 0 ? group.materials[i - 1].tier : null}
											<!-- Tier divider if tier changed -->
											{#if prevTier !== null && mat.tier !== prevTier}
												<div class="bg-gray-750 px-4 py-1 text-xs text-gray-500">
													Tier {mat.tier}
												</div>
											{/if}
											{@render materialRow(mat, matIconUrl, effectiveHave, isComplete, i)}
										{/each}
									</div>
								{/if}
							</div>
						{/each}

					<!-- COMBINED VIEW (Step -> Profession) -->
					{:else if viewMode === 'combined'}
						{#each filteredCombinedGroups as stepGroup (stepGroup.step)}
							{@const sectionId = `combined-step-${stepGroup.step}`}
							{@const headerColor =
								stepGroup.step === 1
									? 'bg-amber-900/50 hover:bg-amber-900/70'
									: 'bg-blue-900/40 hover:bg-blue-900/60'}
							{@const textColor = stepGroup.step === 1 ? 'text-amber-200' : 'text-blue-200'}
							{@const iconColor = stepGroup.step === 1 ? 'text-amber-400' : 'text-blue-400'}
							<div class="overflow-hidden rounded-lg bg-gray-800">
								<button
									type="button"
									onclick={() => toggleSection(sectionId)}
									class="flex w-full items-center justify-between {headerColor} px-4 py-2 text-left"
								>
									<div class="flex items-center gap-2">
										<svg
											class="h-4 w-4 {iconColor} transition-transform {isSectionCollapsed(sectionId)
												? ''
												: 'rotate-90'}"
											fill="none"
											stroke="currentColor"
											viewBox="0 0 24 24"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width="2"
												d="M9 5l7 7-7 7"
											/>
										</svg>
										<span class="font-medium {textColor}"
											>{stepGroup.label} ({stepGroup.professionGroups.reduce((sum, pg) => sum + pg.materials.length, 0)} items)</span
										>
									</div>
								</button>

								{#if !isSectionCollapsed(sectionId)}
									<div class="divide-y divide-gray-700">
										{#each stepGroup.professionGroups as profGroup (profGroup.profession)}
											{@const profSectionId = `combined-${stepGroup.step}-${profGroup.profession}`}
											{@const completedInProf = profGroup.materials.filter((m) => isEffectivelyComplete(m)).length}
											<!-- Profession sub-header -->
											<button
												type="button"
												onclick={() => toggleSection(profSectionId)}
												class="flex w-full items-center gap-2 bg-gray-700/50 hover:bg-gray-700 px-6 py-1.5 text-left"
											>
												<svg
													class="h-3 w-3 text-emerald-400 transition-transform {isSectionCollapsed(profSectionId)
														? ''
														: 'rotate-90'}"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M9 5l7 7-7 7"
													/>
												</svg>
												<span class="text-sm text-emerald-300"
													>{profGroup.profession} ({profGroup.materials.length})</span
												>
												{#if completedInProf > 0}
													<span class="text-xs text-green-400"
														>{completedInProf}/{profGroup.materials.length} done</span
													>
												{/if}
											</button>

											{#if !isSectionCollapsed(profSectionId)}
												{#each profGroup.materials as mat, i (getMaterialKey(mat))}
													{@const matIconUrl = getMaterialIconUrl(mat)}
													{@const effectiveHave = getEffectiveHave(mat)}
													{@const isComplete = isEffectivelyComplete(mat)}
													{@const prevTier = i > 0 ? profGroup.materials[i - 1].tier : null}
													<!-- Tier divider if tier changed -->
													{#if prevTier !== null && mat.tier !== prevTier}
														<div class="bg-gray-750 px-6 py-1 text-xs text-gray-500">
															Tier {mat.tier}
														</div>
													{/if}
													{@render materialRow(mat, matIconUrl, effectiveHave, isComplete, i)}
												{/each}
											{/if}
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					{/if}
				{/if}
			{/if}

			<!-- 3. ITEMS SECTION (Final crafts - at the bottom) -->
			<div class="overflow-hidden rounded-lg bg-gray-800">
				<div class="flex items-center justify-between bg-purple-900/40 px-4 py-2">
					<button
						type="button"
						onclick={() => toggleSection('items')}
						class="flex items-center gap-2 hover:text-white"
					>
						<svg
							class="h-4 w-4 text-purple-400 transition-transform {isSectionCollapsed('items')
								? ''
								: 'rotate-90'}"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M9 5l7 7-7 7"
							/>
						</svg>
						<span class="font-medium text-purple-200">Final Crafts ({list.entries.length})</span>
						{#if completedEntriesCount > 0}
							<span class="text-xs text-green-400"
								>{completedEntriesCount}/{list.entries.length} done</span
							>
						{/if}
					</button>
					<button
						type="button"
						onclick={() => (showAddModal = true)}
						class="rounded bg-purple-600 px-2 py-1 text-xs text-white hover:bg-purple-700"
					>
						+ Add
					</button>
				</div>

				{#if !isSectionCollapsed('items')}
					<div class="divide-y divide-gray-700">
						{#if list.entries.length === 0}
							<div class="px-4 py-3 text-sm text-gray-400">
								No items yet. Click + Add to get started.
							</div>
						{:else}
							{@const visibleEntries = hideCompleted
								? list.entries.filter((e) => {
									const key = isItemEntry(e)
										? `item-${e.itemId}`
										: isCargoEntry(e)
											? `cargo-${e.cargoId}`
											: `building-${e.constructionRecipeId}`;
									const have = manualHave.get(key) ?? 0;
									return !checkedOff.has(key) && have < e.quantity;
								})
								: list.entries}
							{#each visibleEntries as entry, i (entry.id)}
								{@const entryKey = isItemEntry(entry)
									? `item-${entry.itemId}`
									: isCargoEntry(entry)
										? `cargo-${entry.cargoId}`
										: `building-${entry.constructionRecipeId}`}
								{@const entryItem = isItemEntry(entry) ? getItemById(entry.itemId) : null}
								{@const entryCargo = isCargoEntry(entry) ? getCargoById(entry.cargoId) : null}
								{@const entryBuilding = isBuildingEntry(entry) ? getConstructionRecipeById(entry.constructionRecipeId) : null}
								{@const entryBuildingDesc = entryBuilding ? getBuildingDescriptionById(entryBuilding.buildingDescriptionId) : null}
								{@const entryName = entryItem?.name ?? entryCargo?.name ?? entryBuilding?.name ?? `Entry #${entry.id}`}
								{@const iconAsset = entryItem?.iconAssetName ?? entryCargo?.iconAssetName ?? entryBuildingDesc?.iconAssetName}
								{@const iconUrl = iconAsset ? getItemIconUrl(iconAsset) : null}
								{@const haveQty = manualHave.get(entryKey) ?? 0}
								{@const isComplete = checkedOff.has(entryKey) || haveQty >= entry.quantity}
								{@const isStriped = settings.stripedRows && i % 2 === 1}
									<div
										class="hover:bg-gray-750 flex items-center gap-3 px-4 py-2 {isComplete ? 'opacity-50' : ''}"
										style:background-color={isStriped ? 'rgba(55, 65, 81, 0.8)' : undefined}
									>
										<!-- Checkbox -->
										<button
											type="button"
											onclick={() => toggleCheckedOffByKey(entryKey)}
											class="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border {isComplete
												? 'border-green-500 bg-green-600'
												: 'border-gray-500 hover:border-gray-400'}"
											aria-label={checkedOff.has(entryKey)
												? 'Unmark as complete'
												: 'Mark as complete'}
										>
											{#if isComplete}
												<svg
													class="h-3 w-3 text-white"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="3"
														d="M5 13l4 4L19 7"
													/>
												</svg>
											{/if}
										</button>
										<!-- Icon + Name (with Recipe Popover for items only) -->
										{#if isItemEntry(entry)}
											{@const recipes = findRecipesForItem(entry.itemId)}
											{@const validRecipes = recipes.filter(r => {
												const hasItemIngredients = r.ingredients.length > 0;
												const hasCargoIngredients = (r.cargoIngredients?.length ?? 0) > 0;
												if (!hasItemIngredients && !hasCargoIngredients) return false;
												if (hasItemIngredients && !r.ingredients.every(ing => getItemById(ing.itemId) !== undefined)) return false;
												const outputItem = getItemById(entry.itemId);
												if (!outputItem || outputItem.tier === -1) return true;
												return !r.ingredients.some(ing => {
													const ingItem = getItemById(ing.itemId);
													if (!ingItem || ingItem.tier === -1) return false;
													return ingItem.tier > outputItem.tier;
												});
											})}
											<RecipePopover itemId={entry.itemId}>
												<div class="flex min-w-0 flex-1 cursor-help items-center gap-3">
													<div class="flex h-8 w-8 flex-shrink-0 items-center justify-center">
														{#if iconUrl}
															<img src={iconUrl} alt="" class="h-7 w-7 object-contain" />
														{:else}
															<span class="text-gray-500">?</span>
														{/if}
													</div>
													<div class="min-w-0 flex-1 flex items-center gap-1">
														<span class="text-sm text-white">{entryName}</span>
														{#if validRecipes.length > 1}
															{@const currentRecipeId = entry.recipeId}
															{@const sortedRecipes = validRecipes.sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity))}
															{@const defaultRecipeId = sortedRecipes[0]?.id}
															{@const isNonDefault = currentRecipeId !== undefined && currentRecipeId !== defaultRecipeId}
															<button
																type="button"
																onclick={() => {
																	// Create a minimal MaterialRequirement-like object
																	const mockMat = {
																		nodeType: 'item' as const,
																		itemId: entry.itemId,
																		item: entryItem
																	};
																	openRecipeModal(mockMat as any, true);
																}}
																class="relative flex-shrink-0 p-0.5 rounded border text-xs transition-colors
																	{isNonDefault
																		? 'bg-blue-900/40 border-blue-500 text-blue-300'
																		: 'bg-gray-700 border-gray-600 text-gray-400 hover:bg-gray-600'}"
																title="Select recipe"
																aria-label="Select recipe for {entryName}"
															>
																<svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
																	<path d="m15 12-8.5 8.5c-.83.83-2.17.83-3 0 0 0 0 0 0 0a2.12 2.12 0 0 1 0-3L12 9"/>
																	<path d="M17.64 15 22 10.64"/>
																	<path d="m20.91 11.7-1.25-1.25c-.6-.6-.93-1.4-.93-2.25v-.86L16.01 4.6a5.56 5.56 0 0 0-3.94-1.64H9l.92.82A6.18 6.18 0 0 1 12 8.4v1.56l2 2h2.47l2.26 1.91"/>
																</svg>
																{#if isNonDefault}
																	<span class="absolute -top-0.5 -right-0.5 inline-block w-1.5 h-1.5 rounded-full bg-blue-400"></span>
																{/if}
															</button>
														{/if}
														<span class="ml-1 text-sm text-purple-400 tabular-nums"
															>x{formatQty(entry.quantity)}</span
														>
													</div>
												</div>
											</RecipePopover>
										{:else if isBuildingEntry(entry) && entryBuilding}
											<!-- Building entry with recipe popover -->
											<BuildingRecipePopover recipe={entryBuilding}>
												<div class="flex min-w-0 flex-1 cursor-help items-center gap-3">
													<div class="flex h-8 w-8 flex-shrink-0 items-center justify-center">
														{#if iconUrl}
															<img src={iconUrl} alt="" class="h-7 w-7 object-contain" />
														{:else}
															<span class="text-gray-500">🏠</span>
														{/if}
													</div>
													<div class="min-w-0 flex-1">
														<span class="text-sm text-white">{entryName}</span>
														<span class="ml-1 text-xs text-purple-400">(Building)</span>
														<span class="ml-1 text-sm text-purple-400 tabular-nums"
															>x{formatQty(entry.quantity)}</span
														>
													</div>
												</div>
											</BuildingRecipePopover>
										{:else if isCargoEntry(entry)}
											<!-- Cargo entry with recipe popover -->
											{@const cargoRecipes = findRecipesForCargo(entry.cargoId)}
											{#if cargoRecipes.length > 0}
												<CargoRecipePopover cargoId={entry.cargoId}>
													<div class="flex min-w-0 flex-1 cursor-help items-center gap-3">
														<div class="flex h-8 w-8 flex-shrink-0 items-center justify-center">
															{#if iconUrl}
																<img src={iconUrl} alt="" class="h-7 w-7 object-contain" />
															{:else}
																<span class="text-gray-500">📦</span>
															{/if}
														</div>
														<div class="min-w-0 flex-1">
															<span class="text-sm text-white">{entryName}</span>
															<span class="ml-1 text-xs text-amber-400">(Cargo)</span>
															<span class="ml-1 text-sm text-purple-400 tabular-nums"
																>x{formatQty(entry.quantity)}</span
															>
														</div>
													</div>
												</CargoRecipePopover>
											{:else}
												<div class="flex min-w-0 flex-1 items-center gap-3">
													<div class="flex h-8 w-8 flex-shrink-0 items-center justify-center">
														{#if iconUrl}
															<img src={iconUrl} alt="" class="h-7 w-7 object-contain" />
														{:else}
															<span class="text-gray-500">📦</span>
														{/if}
													</div>
													<div class="min-w-0 flex-1">
														<span class="text-sm text-white">{entryName}</span>
														<span class="ml-1 text-xs text-amber-400">(Cargo)</span>
														<span class="ml-1 text-sm text-purple-400 tabular-nums"
															>x{formatQty(entry.quantity)}</span
														>
													</div>
												</div>
											{/if}
										{:else}
											<!-- Unknown entry type -->
											<div class="flex min-w-0 flex-1 items-center gap-3">
												<div class="flex h-8 w-8 flex-shrink-0 items-center justify-center">
													<span class="text-gray-500">?</span>
												</div>
												<div class="min-w-0 flex-1">
													<span class="text-sm text-white">{entryName}</span>
													<span class="ml-1 text-sm text-purple-400 tabular-nums"
														>x{formatQty(entry.quantity)}</span
													>
												</div>
											</div>
										{/if}
										<!-- Have / Need + Controls -->
										<div class="flex items-center gap-2 text-sm">
											<div
												class="flex items-center overflow-hidden rounded-md border border-gray-600 bg-gray-900/50"
											>
												<input
													type="number"
													value={haveQty}
													onchange={(e) =>
														setManualHaveByKey(entryKey, parseInt(e.currentTarget.value) || 0)}
													min="0"
													class="w-16 [appearance:textfield] bg-transparent px-2 py-1 text-right text-sm text-white focus:bg-gray-800 focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
													title="Amount you have"
												/>
												<span class="px-1 text-gray-500">/</span>
												<input
													type="number"
													value={entry.quantity}
													onchange={(e) =>
														handleEntryQuantityChange(
															entry.id,
															parseInt(e.currentTarget.value) || 1
														)}
													min="1"
													class="w-16 [appearance:textfield] bg-transparent px-2 py-1 text-left text-sm text-purple-300 focus:bg-gray-800 focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
													title="Amount to craft"
												/>
											</div>
											<div class="h-5 w-5 flex-shrink-0">
												{#if isComplete}
													<svg
														class="h-5 w-5 text-green-500"
														fill="none"
														stroke="currentColor"
														viewBox="0 0 24 24"
													>
														<path
															stroke-linecap="round"
															stroke-linejoin="round"
															stroke-width="2"
															d="M5 13l4 4L19 7"
														/>
													</svg>
												{/if}
											</div>
											<button
												onclick={() => handleRemoveEntry(entry.id)}
												class="rounded p-1 text-gray-400 hover:bg-gray-700 hover:text-red-400"
												aria-label="Remove entry"
											>
												<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M6 18L18 6M6 6l12 12"
													/>
												</svg>
											</button>
										</div>
									</div>
							{/each}
						{/if}
					</div>
				{/if}
			</div>

			<!-- Total Effort Summary (Bottom) -->
			{#if totalListEffort > 0}
				<div class="flex items-center justify-between rounded-lg bg-gray-800 px-4 py-2">
					<span class="text-sm text-gray-400">Total Remaining Effort:</span>
					<span class="text-lg font-semibold tabular-nums text-cyan-400">{formatEffort(totalListEffort)}</span>
				</div>
			{/if}
		</div>
	</div>

	<!-- Add Item Modal -->
	{#if showAddModal}
		<div class="fixed inset-0 z-50 flex items-center justify-center p-4">
			<button
				type="button"
				class="absolute inset-0 bg-black/70"
				onclick={closeAddModal}
				aria-label="Close modal"
			></button>

			<div
				class="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg bg-gray-800 shadow-xl"
			>
				<!-- Header -->
				<div class="flex items-center justify-between border-b border-gray-700 p-4">
					<h3 class="text-lg font-semibold text-white">Add to List</h3>
					<button
						type="button"
						onclick={closeAddModal}
						class="rounded p-1 text-gray-400 hover:bg-gray-700 hover:text-white"
						aria-label="Close"
					>
						<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M6 18L18 6M6 6l12 12"
							/>
						</svg>
					</button>
				</div>

				<!-- Tabs -->
				<div class="flex border-b border-gray-700">
					<button
						type="button"
						onclick={() => (searchTab = 'items')}
						class="flex-1 px-4 py-2 text-sm font-medium transition-colors {searchTab === 'items'
							? 'border-b-2 border-blue-500 text-blue-400'
							: 'text-gray-400 hover:text-white'}"
					>
						Items
						{#if searchResults.length > 0}
							<span class="ml-1 text-xs">({searchResults.length})</span>
						{/if}
					</button>
					<button
						type="button"
						onclick={() => (searchTab = 'buildings')}
						class="flex-1 px-4 py-2 text-sm font-medium transition-colors {searchTab === 'buildings'
							? 'border-b-2 border-blue-500 text-blue-400'
							: 'text-gray-400 hover:text-white'}"
					>
						Buildings
						{#if buildingSearchResults.length > 0}
							<span class="ml-1 text-xs">({buildingSearchResults.length})</span>
						{/if}
					</button>
					<button
						type="button"
						onclick={() => (searchTab = 'cargo')}
						class="flex-1 px-4 py-2 text-sm font-medium transition-colors {searchTab === 'cargo'
							? 'border-b-2 border-blue-500 text-blue-400'
							: 'text-gray-400 hover:text-white'}"
					>
						Cargo
						{#if cargoSearchResults.length > 0}
							<span class="ml-1 text-xs">({cargoSearchResults.length})</span>
						{/if}
					</button>
				</div>

				<!-- Search -->
				<div class="border-b border-gray-700 p-4">
					<input
						bind:this={searchInputEl}
						type="text"
						value={searchQuery}
						oninput={(e) => handleSearch(e.currentTarget.value)}
						placeholder={searchTab === 'items' ? 'Search items by name...' : searchTab === 'buildings' ? 'Search buildings by name...' : 'Search cargo by name...'}
						class="w-full rounded-lg border border-gray-600 bg-gray-700 px-4 py-3 text-lg text-white placeholder-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
					/>
					{#if searchQuery.length > 0 && searchQuery.length < 2}
						<p class="mt-2 text-sm text-gray-400">Type at least 2 characters to search</p>
					{/if}
				</div>

				<!-- Results -->
				<div class="flex-1 overflow-auto p-4">
					{#if searchTab === 'items'}
						<!-- Items Tab -->
						{#if searchResults.length > 0}
							<div class="space-y-2">
								{#each searchResults as item (item.id)}
									{@const searchIconUrl = getItemIconUrl(item.iconAssetName)}
									{@const isInList = list?.entries.some((e) => isItemEntry(e) && e.itemId === item.id)}
									{@const recipes = getSortedRecipes(item.id)}
									{@const selectedRecipeId =
										getSelectedRecipe(item.id) ?? getDefaultRecipeId(item.id)}
									<div class="rounded-lg bg-gray-700 p-3">
										<div class="flex items-center gap-3">
											<!-- Icon -->
											<div class="flex h-10 w-10 items-center justify-center rounded bg-gray-600">
												{#if searchIconUrl}
													<img src={searchIconUrl} alt="" class="h-8 w-8 object-contain" />
												{:else}
													<span class="text-lg text-gray-400">?</span>
												{/if}
											</div>

											<!-- Item info -->
											<div class="min-w-0 flex-1">
												<p class="truncate font-medium text-white">{item.name}</p>
												<p class="text-xs text-gray-400">
													{item.tag || 'Unknown'} · T{item.tier}
													{#if isInList}
														<span class="ml-2 text-green-400">In list</span>
													{/if}
												</p>
											</div>

											<!-- Quantity and Add -->
											<div class="flex items-center gap-2">
												<input
													type="number"
													value={getItemQuantity(item.id)}
													onchange={(e) =>
														setItemQuantity(item.id, parseInt(e.currentTarget.value) || 1)}
													onwheel={(e) => handleQuantityWheel(item.id, e)}
													min="1"
													class="w-20 rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-center text-white focus:border-blue-500 focus:outline-none"
												/>
												<button
													type="button"
													onclick={() => handleAddItem(item.id)}
													class="rounded-lg px-3 py-1.5 text-white transition-all duration-300 {isRecentlyAdded(
														item.id
													)
														? 'bg-green-600'
														: 'bg-blue-600 hover:bg-blue-700'}"
													title={isRecentlyAdded(item.id) ? 'Added!' : 'Add to list'}
													aria-label={isRecentlyAdded(item.id) ? 'Added to list' : 'Add to list'}
												>
													{#if isRecentlyAdded(item.id)}
														<svg
															class="h-5 w-5"
															fill="none"
															stroke="currentColor"
															viewBox="0 0 24 24"
														>
															<path
																stroke-linecap="round"
																stroke-linejoin="round"
																stroke-width="2"
																d="M5 13l4 4L19 7"
															/>
														</svg>
													{:else}
														<svg
															class="h-5 w-5"
															fill="none"
															stroke="currentColor"
															viewBox="0 0 24 24"
														>
															<path
																stroke-linecap="round"
																stroke-linejoin="round"
																stroke-width="2"
																d="M12 4v16m8-8H4"
															/>
														</svg>
													{/if}
												</button>
											</div>
										</div>

										<!-- Recipe selector (only if multiple recipes) -->
										{#if recipes.length > 1}
											<div class="mt-2 flex items-center gap-2">
												<span class="text-xs text-gray-400">Recipe:</span>
												<select
													value={selectedRecipeId}
													onchange={(e) =>
														setSelectedRecipe(item.id, parseInt(e.currentTarget.value))}
													class="flex-1 rounded border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-white focus:border-blue-500 focus:outline-none"
												>
													{#each recipes as recipe, i (recipe.id)}
														<option value={recipe.id}>
															{recipe.craftingStationName || recipe.name} (×{recipe.outputQuantity}){#if recipe.cost !== undefined}
																· {formatCost(
																	recipe.cost
																)}{/if}{#if i === 0 && recipe.cost !== undefined}
																★{/if}
														</option>
													{/each}
												</select>
											</div>
										{:else if recipes.length === 1}
											<p class="mt-1 text-xs text-gray-500">
												{recipes[0].craftingStationName || recipes[0].name} (×{recipes[0]
													.outputQuantity}){#if recipes[0].cost !== undefined}
													· Cost: {formatCost(recipes[0].cost)}{/if}
											</p>
										{:else}
											<p class="mt-1 text-xs text-gray-500">
												No recipe (raw material){#if item.materialCost !== undefined}
													· Cost: {formatCost(item.materialCost)}{/if}
											</p>
										{/if}
									</div>
								{/each}
							</div>
						{:else if searchQuery.length >= 2}
							<p class="py-8 text-center text-gray-400">No items found matching "{searchQuery}"</p>
						{:else}
							<p class="py-8 text-center text-gray-400">Start typing to search for items</p>
						{/if}
					{:else if searchTab === 'buildings'}
						<!-- Buildings Tab -->
						{#if buildingSearchResults.length > 0}
							<div class="space-y-2">
								{#each buildingSearchResults as recipe (recipe.id)}
									{@const building = getBuildingDescriptionById(recipe.buildingDescriptionId)}
									{@const buildingIconUrl = building?.iconAssetName ? getItemIconUrl(building.iconAssetName) : null}
									{@const isInList = list?.entries.some((e) => isBuildingEntry(e) && e.constructionRecipeId === recipe.id)}
									<div class="rounded-lg bg-gray-700 p-3">
										<div class="flex items-center gap-3">
											<!-- Icon -->
											<div class="flex h-10 w-10 items-center justify-center rounded bg-gray-600">
												{#if buildingIconUrl}
													<img src={buildingIconUrl} alt="" class="h-8 w-8 object-contain" />
												{:else}
													<span class="text-lg text-gray-400">🏠</span>
												{/if}
											</div>

											<!-- Building info -->
											<div class="min-w-0 flex-1">
												<p class="truncate font-medium text-white">{recipe.name}</p>
												<p class="text-xs text-gray-400">
													Construction
													{#if isInList}
														<span class="ml-2 text-green-400">In list</span>
													{/if}
												</p>
											</div>

											<!-- Quantity and Add -->
											<div class="flex items-center gap-2">
												<input
													type="number"
													value={getBuildingQuantity(recipe.id)}
													onchange={(e) =>
														setBuildingQuantity(recipe.id, parseInt(e.currentTarget.value) || 1)}
													onwheel={(e) => handleBuildingQuantityWheel(recipe.id, e)}
													min="1"
													class="w-20 rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-center text-white focus:border-blue-500 focus:outline-none"
												/>
												<button
													type="button"
													onclick={() => handleAddBuilding(recipe.id)}
													class="rounded-lg px-3 py-1.5 text-white transition-all duration-300 {isBuildingRecentlyAdded(
														recipe.id
													)
														? 'bg-green-600'
														: 'bg-blue-600 hover:bg-blue-700'}"
													title={isBuildingRecentlyAdded(recipe.id) ? 'Added!' : 'Add to list'}
													aria-label={isBuildingRecentlyAdded(recipe.id) ? 'Added to list' : 'Add to list'}
												>
													{#if isBuildingRecentlyAdded(recipe.id)}
														<svg
															class="h-5 w-5"
															fill="none"
															stroke="currentColor"
															viewBox="0 0 24 24"
														>
															<path
																stroke-linecap="round"
																stroke-linejoin="round"
																stroke-width="2"
																d="M5 13l4 4L19 7"
															/>
														</svg>
													{:else}
														<svg
															class="h-5 w-5"
															fill="none"
															stroke="currentColor"
															viewBox="0 0 24 24"
														>
															<path
																stroke-linecap="round"
																stroke-linejoin="round"
																stroke-width="2"
																d="M12 4v16m8-8H4"
															/>
														</svg>
													{/if}
												</button>
											</div>
										</div>

										<!-- Show consumed items/cargo summary -->
										{#if recipe.consumedItemStacks.length > 0 || recipe.consumedCargoStacks.length > 0}
											<div class="mt-2 text-xs text-gray-500">
												{#if recipe.consumedItemStacks.length > 0}
													<span>{recipe.consumedItemStacks.length} item{recipe.consumedItemStacks.length > 1 ? 's' : ''}</span>
												{/if}
												{#if recipe.consumedCargoStacks.length > 0}
													{#if recipe.consumedItemStacks.length > 0} · {/if}
													<span>{recipe.consumedCargoStacks.length} cargo</span>
												{/if}
												{#if recipe.consumedBuilding > 0}
													<span class="ml-1 text-amber-400">(upgrade)</span>
												{/if}
											</div>
										{/if}
									</div>
								{/each}
							</div>
						{:else if searchQuery.length >= 2}
							<p class="py-8 text-center text-gray-400">No buildings found matching "{searchQuery}"</p>
						{:else}
							<p class="py-8 text-center text-gray-400">Start typing to search for buildings</p>
						{/if}
					{:else}
						<!-- Cargo Tab -->
						{#if cargoSearchResults.length > 0}
							<div class="space-y-2">
								{#each cargoSearchResults as cargo (cargo.id)}
									{@const cargoIconUrl = cargo.iconAssetName ? getItemIconUrl(cargo.iconAssetName) : null}
									{@const isInList = list?.entries.some((e) => isCargoEntry(e) && e.cargoId === cargo.id)}
									<div class="rounded-lg bg-gray-700 p-3">
										<div class="flex items-center gap-3">
											<!-- Icon -->
											<div class="flex h-10 w-10 items-center justify-center rounded bg-gray-600">
												{#if cargoIconUrl}
													<img src={cargoIconUrl} alt="" class="h-8 w-8 object-contain" />
												{:else}
													<span class="text-lg text-gray-400">?</span>
												{/if}
											</div>

											<!-- Cargo info -->
											<div class="min-w-0 flex-1">
												<p class="truncate font-medium text-white">{cargo.name}</p>
												<p class="text-xs text-gray-400">
													{cargo.tag || 'Cargo'} · T{cargo.tier}
													{#if isInList}
														<span class="ml-2 text-green-400">In list</span>
													{/if}
												</p>
											</div>

											<!-- Quantity and Add -->
											<div class="flex items-center gap-2">
												<input
													type="number"
													value={getCargoQuantity(cargo.id)}
													onchange={(e) =>
														setCargoQuantity(cargo.id, parseInt(e.currentTarget.value) || 1)}
													onwheel={(e) => handleCargoQuantityWheel(cargo.id, e)}
													min="1"
													class="w-20 rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-center text-white focus:border-blue-500 focus:outline-none"
												/>
												<button
													type="button"
													onclick={() => handleAddCargo(cargo.id)}
													class="rounded-lg px-3 py-1.5 text-white transition-all duration-300 {isCargoRecentlyAdded(
														cargo.id
													)
														? 'bg-green-600'
														: 'bg-blue-600 hover:bg-blue-700'}"
													title={isCargoRecentlyAdded(cargo.id) ? 'Added!' : 'Add to list'}
													aria-label={isCargoRecentlyAdded(cargo.id) ? 'Added to list' : 'Add to list'}
												>
													{#if isCargoRecentlyAdded(cargo.id)}
														<svg
															class="h-5 w-5"
															fill="none"
															stroke="currentColor"
															viewBox="0 0 24 24"
														>
															<path
																stroke-linecap="round"
																stroke-linejoin="round"
																stroke-width="2"
																d="M5 13l4 4L19 7"
															/>
														</svg>
													{:else}
														<svg
															class="h-5 w-5"
															fill="none"
															stroke="currentColor"
															viewBox="0 0 24 24"
														>
															<path
																stroke-linecap="round"
																stroke-linejoin="round"
																stroke-width="2"
																d="M12 4v16m8-8H4"
															/>
														</svg>
													{/if}
												</button>
											</div>
										</div>
									</div>
								{/each}
							</div>
						{:else if searchQuery.length >= 2}
							<p class="py-8 text-center text-gray-400">No cargo found matching "{searchQuery}"</p>
						{:else}
							<p class="py-8 text-center text-gray-400">Start typing to search for cargo</p>
						{/if}
					{/if}
				</div>

				<!-- Footer -->
				<div class="border-t border-gray-700 p-4">
					<button
						type="button"
						onclick={closeAddModal}
						class="w-full rounded-lg bg-gray-700 px-4 py-2 text-white hover:bg-gray-600"
					>
						Done
					</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- Inventory Source Selection Modal -->
	{#if showSourceModal}
		<div class="fixed inset-0 z-50 flex items-center justify-center p-4">
			<button
				type="button"
				class="absolute inset-0 bg-black/70"
				onclick={() => (showSourceModal = false)}
				aria-label="Close modal"
			></button>

			<div
				class="relative max-h-[80vh] w-full max-w-lg overflow-auto rounded-lg bg-gray-800 p-6 shadow-xl"
			>
				<div class="flex items-center justify-between">
					<h3 class="text-lg font-semibold text-white">Select Inventory Sources</h3>
					<button
						type="button"
						onclick={() => (showExternalModal = true)}
						class="rounded-lg bg-green-600 px-3 py-1.5 text-sm text-white hover:bg-green-700"
					>
						+ Add External
					</button>
				</div>
				<p class="mt-1 text-sm text-gray-400">
					Choose which inventories to include when calculating materials for this list.
					{#if selectedSourceIds.length === 0}
						<span class="text-blue-400">All sources are currently included.</span>
					{/if}
				</p>

				<div class="mt-4 space-y-4">
					<!-- Your Inventory Section -->
					{#if localSourcesByClaim.value.size > 0}
						<div class="border-b border-gray-600 pb-2">
							<span class="text-xs font-semibold uppercase tracking-wider text-gray-500"
								>Your Inventory</span
							>
						</div>
					{/if}

					{#each [...localSourcesByClaim.value.entries()] as [claimId, sources] (claimId)}
						{@const claimName =
							claimId === 'player'
								? 'Player Inventory'
								: sources[0]?.claimName ||
									settings.accessibleClaims.find((c) => c.entityId === claimId)?.name ||
									claimId}
						{@const allSelected = sources.every(
							(s) => selectedSourceIds.length === 0 || selectedSourceIds.includes(s.id)
						)}

						<div class="rounded-lg border border-gray-600 p-3">
							<label class="flex cursor-pointer items-center gap-2">
								<input
									type="checkbox"
									checked={allSelected}
									onchange={() => toggleAllSources(claimId, !allSelected)}
									class="rounded border-gray-500 bg-gray-700 text-blue-600 focus:ring-blue-500"
								/>
								<span class="font-medium text-white">{claimName}</span>
							</label>
							<div class="mt-2 space-y-1">
								{#each sources as source (source.id)}
									<label
										class="flex cursor-pointer items-center gap-2 rounded p-1 hover:bg-gray-700"
									>
										<input
											type="checkbox"
											checked={selectedSourceIds.length === 0 ||
												selectedSourceIds.includes(source.id)}
											onchange={() => toggleSource(source.id)}
											class="rounded border-gray-500 bg-gray-700 text-blue-600 focus:ring-blue-500"
										/>
										<span class="text-sm text-gray-300">{source.nickname || source.name}</span>
									</label>
								{/each}
							</div>
						</div>
					{/each}

					{#if localSourcesByClaim.value.size === 0}
						<p class="text-center text-gray-400">
							No inventory sources available. Refresh inventory to load sources.
						</p>
					{/if}

					<!-- External Sources Section -->
					{#if list?.externalInventoryRefs && list.externalInventoryRefs.length > 0}
						<div class="border-b border-gray-600 pb-2 pt-4">
							<span class="text-xs font-semibold uppercase tracking-wider text-gray-500"
								>External Sources</span
							>
						</div>

						{#each list.externalInventoryRefs as ref (`${ref.type}:${ref.entityId}`)}
							{@const externalRefId = `${ref.type}:${ref.entityId}`}
							{@const sources = getExternalSourcesByRef(externalRefId)}
							{@const allSelected = sources.every(
								(s) => selectedSourceIds.length === 0 || selectedSourceIds.includes(s.id)
							)}
							{@const isSyncing = externalSyncing === externalRefId}
							{@const syncError = externalSyncState.errors.get(externalRefId)}

							<div class="rounded-lg border border-gray-600 p-3">
								<div class="flex items-center justify-between">
									<label class="flex cursor-pointer items-center gap-2">
										<input
											type="checkbox"
											checked={allSelected}
											onchange={() => toggleAllExternalSources(externalRefId, !allSelected)}
											class="rounded border-gray-500 bg-gray-700 text-blue-600 focus:ring-blue-500"
										/>
										<span class="font-medium text-white">
											{ref.type === 'player' ? '👤' : '🏰'}
											{ref.name}
										</span>
									</label>
									<div class="flex items-center gap-2">
										<button
											type="button"
											onclick={() => handleSyncExternalRef(ref)}
											disabled={isSyncing}
											class="rounded px-2 py-1 text-xs text-gray-400 hover:bg-gray-700 hover:text-white disabled:opacity-50"
											title="Sync inventory"
										>
											{#if isSyncing}
												<span
													class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
												></span>
											{:else}
												↻
											{/if}
										</button>
										<button
											type="button"
											onclick={() => handleRemoveExternalRef(externalRefId)}
											class="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-900/50 hover:text-red-300"
											title="Remove"
										>
											✕
										</button>
									</div>
								</div>

								{#if syncError}
									<p class="mt-1 text-xs text-red-400">{syncError}</p>
								{/if}

								{#if sources.length > 0}
									<div class="mt-2 space-y-1">
										{#each sources as source (source.id)}
											<label
												class="flex cursor-pointer items-center gap-2 rounded p-1 hover:bg-gray-700"
											>
												<input
													type="checkbox"
													checked={selectedSourceIds.length === 0 ||
														selectedSourceIds.includes(source.id)}
													onchange={() => toggleExternalSource(source.id)}
													class="rounded border-gray-500 bg-gray-700 text-blue-600 focus:ring-blue-500"
												/>
												<span class="text-sm text-gray-300"
													>{source.nickname || source.name}</span
												>
											</label>
										{/each}
									</div>
								{:else}
									<p class="mt-2 text-xs text-gray-400">
										No inventory data. Click sync to fetch.
									</p>
								{/if}

								{#if ref.lastFetched}
									<p class="mt-1 text-xs text-gray-500">
										Last synced: {new Date(ref.lastFetched).toLocaleTimeString()}
									</p>
								{/if}
							</div>
						{/each}
					{/if}
				</div>

				<div class="mt-6 flex justify-end gap-3">
					<button
						type="button"
						onclick={() => (showSourceModal = false)}
						class="rounded-lg px-4 py-2 text-gray-400 hover:bg-gray-700 hover:text-white"
					>
						Cancel
					</button>
					<button
						type="button"
						onclick={saveSourceSelection}
						class="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
					>
						Save Selection
					</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- External Inventory Modal -->
	{#if showExternalModal && list}
		<ExternalInventoryModal
			listId={list.id}
			existingRefs={list.externalInventoryRefs ?? []}
			onClose={() => (showExternalModal = false)}
			onAdd={handleAddExternalRef}
		/>
	{/if}

	<!-- Share Modal -->
	{#if showShareModal}
		<div class="fixed inset-0 z-50 flex items-center justify-center p-4">
			<button
				type="button"
				class="absolute inset-0 bg-black/70"
				aria-label="Close share modal"
				onclick={() => {
					showShareModal = false;
					shareError = null;
					shareCopied = false;
				}}
			></button>
			<div class="relative w-full max-w-md rounded-lg bg-gray-800 p-6 shadow-xl">
				{#if shareError}
					<h3 class="text-lg font-semibold text-red-400">Share Failed</h3>
					<p class="mt-2 text-sm text-gray-300">{shareError}</p>
					<button
						onclick={() => {
							showShareModal = false;
							shareError = null;
						}}
						class="mt-4 w-full rounded-lg bg-gray-700 py-2 text-gray-300 hover:bg-gray-600"
					>
						Close
					</button>
				{:else}
					<h3 class="text-lg font-semibold text-white">Share List</h3>
					<p class="mt-2 text-sm text-gray-400">
						Anyone with this link can view your list. Link expires in 1 week.
					</p>
					<div class="mt-4 flex gap-2">
						<input
							type="text"
							readonly
							value={shareUrl}
							class="flex-1 rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-white"
						/>
						<button
							onclick={copyShareUrl}
							class="rounded-lg px-4 py-2 text-white transition-colors {shareCopied
								? 'bg-green-600'
								: 'bg-blue-600 hover:bg-blue-700'}"
						>
							{#if shareCopied}
								<span class="flex items-center gap-1">
									<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
									</svg>
									Copied!
								</span>
							{:else}
								Copy
							{/if}
						</button>
					</div>
					<button
						onclick={() => {
							showShareModal = false;
							shareCopied = false;
						}}
						class="mt-4 w-full rounded-lg bg-gray-700 py-2 text-gray-300 hover:bg-gray-600"
					>
						Close
					</button>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Recipe Selection Modal -->
	{#if showRecipeModal && recipeModalItemId}
		{@const item = getItemById(recipeModalItemId)}
		{@const recipes = findRecipesForItem(recipeModalItemId)}
		{@const validRecipes = recipes.filter(r => {
			const hasItemIngredients = r.ingredients.length > 0;
			const hasCargoIngredients = (r.cargoIngredients?.length ?? 0) > 0;
			if (!hasItemIngredients && !hasCargoIngredients) return false;
			if (hasItemIngredients && !r.ingredients.every(ing => getItemById(ing.itemId) !== undefined)) return false;
			if (!recipeModalItemId) return false;
			const outputItem = getItemById(recipeModalItemId);
			if (!outputItem || outputItem.tier === -1) return true;
			return !r.ingredients.some(ing => {
				const ingItem = getItemById(ing.itemId);
				if (!ingItem || ingItem.tier === -1) return false;
				return ingItem.tier > outputItem.tier;
			});
		})}
		{@const sortedRecipes = validRecipes.sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity))}

		<div class="fixed inset-0 z-50 flex items-center justify-center p-4">
			<button type="button" class="absolute inset-0 bg-black/70" onclick={closeRecipeModal} aria-label="Close modal"></button>

			<div class="relative max-h-[80vh] w-full max-w-2xl overflow-auto rounded-lg bg-gray-800 shadow-xl">
				<!-- Header -->
				<div class="flex items-center justify-between border-b border-gray-700 p-4">
					<h3 class="text-lg font-semibold text-white">Select Recipe for {item?.name}</h3>
					<button onclick={closeRecipeModal} class="rounded p-1 text-gray-400 hover:text-white" aria-label="Close">
						<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
						</svg>
					</button>
				</div>

				<!-- Recipe cards -->
				<div class="space-y-3 p-4">
					{#each sortedRecipes as recipe, i (recipe.id)}
						{@const isSelected = selectedModalRecipeId === recipe.id}
						{@const isDefault = i === 0}
						<label class="block cursor-pointer">
							<div class="rounded-lg border p-3 transition-colors
								{isSelected
									? 'bg-blue-900/40 border-blue-500 ring-2 ring-blue-500'
									: 'bg-gray-700 border-gray-600 hover:bg-gray-650'}">
								<div class="flex items-start justify-between">
									<div class="flex items-center gap-3">
										<input
											type="radio"
											name="recipe-select"
											value={recipe.id}
											checked={isSelected}
											onchange={() => selectedModalRecipeId = recipe.id}
											class="mt-1"
										/>
										<div>
											<div class="flex items-center gap-2">
												<span class="font-medium text-white">
													{recipe.craftingStationName || 'Crafting'}
													{#if recipe.craftingStationTier}
														<span class="text-gray-400">T{recipe.craftingStationTier}</span>
													{/if}
												</span>
												{#if isDefault}
													<span class="rounded bg-green-900/50 px-2 py-0.5 text-xs text-green-300">
														★ Cheapest
													</span>
												{/if}
											</div>
											<div class="mt-1 text-sm text-gray-400">
												Output: ×{recipe.outputQuantity}
											</div>
										</div>
									</div>
									{#if recipe.cost !== undefined}
										<span class="text-green-400 font-medium">{formatCost(recipe.cost)}</span>
									{/if}
								</div>

								<!-- Ingredients -->
								<div class="mt-3 space-y-1 pl-8">
									{#each recipe.ingredients as ing}
										{@const ingItem = getItemById(ing.itemId)}
										{@const ingIcon = ingItem ? getItemIconUrl(ingItem.iconAssetName) : null}
										<div class="flex items-center gap-2 text-sm">
											<div class="h-5 w-5 flex items-center justify-center bg-gray-800 rounded">
												{#if ingIcon}
													<img src={ingIcon} alt="" class="h-4 w-4 object-contain" />
												{/if}
											</div>
											<span class="text-gray-300">{ingItem?.name || `Item #${ing.itemId}`}</span>
											<span class="text-blue-400">×{ing.quantity}</span>
										</div>
									{/each}
									{#if recipe.cargoIngredients}
										{#each recipe.cargoIngredients as cargoIng}
											{@const cargo = getCargoById(cargoIng.cargoId)}
											{@const cargoIcon = cargo ? getItemIconUrl(cargo.iconAssetName) : null}
											<div class="flex items-center gap-2 text-sm">
												<div class="h-5 w-5 flex items-center justify-center bg-gray-800 rounded">
													{#if cargoIcon}
														<img src={cargoIcon} alt="" class="h-4 w-4 object-contain" />
													{/if}
												</div>
												<span class="text-gray-300">{cargo?.name || `Cargo #${cargoIng.cargoId}`}</span>
												<span class="text-amber-400">×{cargoIng.quantity}</span>
											</div>
										{/each}
									{/if}
								</div>
							</div>
						</label>
					{/each}
				</div>

				<!-- Footer -->
				<div class="border-t border-gray-700 p-4 flex justify-end gap-3">
					<button
						type="button"
						onclick={closeRecipeModal}
						class="rounded-lg px-4 py-2 text-gray-400 hover:bg-gray-700"
					>
						Cancel
					</button>
					<button
						type="button"
						onclick={applyRecipeSelection}
						class="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
					>
						Apply
					</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- Material Row Snippet -->
	{#snippet materialRow(mat: MaterialRequirement, matIconUrl: string | null, effectiveHave: number, isComplete: boolean, rowIndex: number = 0)}
		{@const matKey = getMaterialKey(mat)}
		{@const matName = getMaterialName(mat)}
		{@const isCargo = mat.nodeType === 'cargo'}
		{@const isChecked = checkedOff.has(matKey) || isComplete}
		{@const isStriped = settings.stripedRows && rowIndex % 2 === 1}
		<div
			class="hover:bg-gray-750 flex items-center gap-3 px-4 py-2 {isComplete ? 'opacity-50' : ''}"
			style:background-color={isStriped ? 'rgba(55, 65, 81, 0.8)' : undefined}
		>
			<!-- Checkbox -->
			<button
				type="button"
				onclick={() => toggleCheckedOffByKey(matKey)}
				class="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border {isChecked
					? 'border-green-500 bg-green-600'
					: 'border-gray-500 hover:border-gray-400'}"
				aria-label={checkedOff.has(matKey)
					? 'Unmark as complete'
					: 'Mark as complete'}
			>
				{#if isChecked}
					<svg
						class="h-3 w-3 text-white"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="3"
							d="M5 13l4 4L19 7"
						/>
					</svg>
				{/if}
			</button>
			<!-- Icon + Name (with Recipe Popover for items only) -->
			{#if isItemMaterial(mat) && mat.itemId !== undefined}
				{@const recipes = findRecipesForItem(mat.itemId)}
				{@const validRecipes = recipes.filter(r => {
					const hasItemIngredients = r.ingredients.length > 0;
					const hasCargoIngredients = (r.cargoIngredients?.length ?? 0) > 0;
					if (!hasItemIngredients && !hasCargoIngredients) return false;
					if (hasItemIngredients && !r.ingredients.every(ing => getItemById(ing.itemId) !== undefined)) return false;
					if (!mat.itemId) return false;
					const outputItem = getItemById(mat.itemId);
					if (!outputItem || outputItem.tier === -1) return true;
					return !r.ingredients.some(ing => {
						const ingItem = getItemById(ing.itemId);
						if (!ingItem || ingItem.tier === -1) return false;
						return ingItem.tier > outputItem.tier;
					});
				})}
				<RecipePopover itemId={mat.itemId}>
					<div class="flex w-full cursor-help items-center gap-3">
						<div class="flex h-8 w-8 flex-shrink-0 items-center justify-center">
							{#if matIconUrl}
								<img src={matIconUrl} alt="" class="h-7 w-7 object-contain" />
							{:else}
								<span class="text-gray-500">?</span>
							{/if}
						</div>
						<div class="flex flex-1 items-center gap-1 min-w-0">
							<span class="truncate text-sm text-white">{matName}</span>
							{#if validRecipes.length > 1}
								{@const currentRecipeId = recipePreferences.get(matKey)}
								{@const sortedRecipes = validRecipes.sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity))}
								{@const defaultRecipeId = sortedRecipes[0]?.id}
								{@const isNonDefault = currentRecipeId !== undefined && currentRecipeId !== defaultRecipeId}
								<button
									type="button"
									onclick={() => openRecipeModal(mat)}
									class="relative flex-shrink-0 p-0.5 rounded border text-xs transition-colors
										{isNonDefault
											? 'bg-blue-900/40 border-blue-500 text-blue-300'
											: 'bg-gray-700 border-gray-600 text-gray-400 hover:bg-gray-600'}"
									title="Select recipe"
									aria-label="Select recipe for {matName}"
								>
									<svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
										<path d="m15 12-8.5 8.5c-.83.83-2.17.83-3 0 0 0 0 0 0 0a2.12 2.12 0 0 1 0-3L12 9"/>
										<path d="M17.64 15 22 10.64"/>
										<path d="m20.91 11.7-1.25-1.25c-.6-.6-.93-1.4-.93-2.25v-.86L16.01 4.6a5.56 5.56 0 0 0-3.94-1.64H9l.92.82A6.18 6.18 0 0 1 12 8.4v1.56l2 2h2.47l2.26 1.91"/>
									</svg>
									{#if isNonDefault}
										<span class="absolute -top-0.5 -right-0.5 inline-block w-1.5 h-1.5 rounded-full bg-blue-400"></span>
									{/if}
								</button>
							{/if}
						</div>
						{#if import.meta.env.DEV && mat.item?.materialCost !== undefined}
							<span
								class="w-12 flex-shrink-0 text-right text-xs text-green-400"
								title="Material cost: {mat.item.materialCost.toFixed(2)}"
								>{formatCost(mat.item.materialCost)}</span
							>
						{/if}
					</div>
				</RecipePopover>
			{:else if mat.nodeType === 'building' && mat.constructionRecipe}
				<!-- Building with recipe popover -->
				<BuildingRecipePopover recipe={mat.constructionRecipe}>
					<div class="flex w-full cursor-help items-center gap-3">
						<div class="flex h-8 w-8 flex-shrink-0 items-center justify-center">
							{#if matIconUrl}
								<img src={matIconUrl} alt="" class="h-7 w-7 object-contain" />
							{:else}
								<span class="text-gray-500">🏠</span>
							{/if}
						</div>
						<span class="flex-1 truncate text-sm text-white">{matName}</span>
						<span class="text-xs text-purple-400">(Building)</span>
					</div>
				</BuildingRecipePopover>
			{:else if mat.nodeType === 'cargo' && mat.cargoId !== undefined}
				<!-- Cargo with recipe popover if craftable -->
				{@const cargoRecipes = findRecipesForCargo(mat.cargoId)}
				{#if cargoRecipes.length > 0}
					<CargoRecipePopover cargoId={mat.cargoId}>
						<div class="flex w-full cursor-help items-center gap-3">
							<div class="flex h-8 w-8 flex-shrink-0 items-center justify-center">
								{#if matIconUrl}
									<img src={matIconUrl} alt="" class="h-7 w-7 object-contain" />
								{:else}
									<span class="text-gray-500">📦</span>
								{/if}
							</div>
							<span class="flex-1 truncate text-sm text-white">{matName}</span>
							<span class="text-xs text-amber-400">(Cargo)</span>
						</div>
					</CargoRecipePopover>
				{:else}
					<div class="flex w-full items-center gap-3">
						<div class="flex h-8 w-8 flex-shrink-0 items-center justify-center">
							{#if matIconUrl}
								<img src={matIconUrl} alt="" class="h-7 w-7 object-contain" />
							{:else}
								<span class="text-gray-500">📦</span>
							{/if}
						</div>
						<span class="flex-1 truncate text-sm text-white">{matName}</span>
						<span class="text-xs text-amber-400">(Cargo)</span>
					</div>
				{/if}
			{:else}
				<!-- Unknown type -->
				<div class="flex w-full items-center gap-3">
					<div class="flex h-8 w-8 flex-shrink-0 items-center justify-center">
						<span class="text-gray-500">?</span>
					</div>
					<span class="flex-1 truncate text-sm text-white">{matName}</span>
				</div>
			{/if}
			{#if isItemMaterial(mat) && mat.itemId !== undefined}
				<HaveBreakdownTooltip
					itemId={mat.itemId}
					listSourceIds={list?.enabledSourceIds ?? []}
					manualAmount={getManualHaveByKey(matKey)}
					isCheckedOff={checkedOff.has(matKey)}
					parentContributions={mat.parentContributions}
				>
					{#if import.meta.env.DEV && mat.rootContributions?.length}
						<!-- DEV: Wrap with DevRequirementBreakdown for Shift+hover -->
						<DevRequirementBreakdown contributions={mat.rootContributions}>
							<span
								class="w-16 flex-shrink-0 text-right text-sm text-blue-400 tabular-nums border-b border-dashed border-yellow-600/50"
								>x{formatQty(mat.baseRequired)}</span
							>
						</DevRequirementBreakdown>
					{:else}
						<span
							class="w-16 flex-shrink-0 text-right text-sm text-blue-400 tabular-nums"
							>x{formatQty(mat.baseRequired)}</span
						>
					{/if}
				</HaveBreakdownTooltip>
			{:else}
				<!-- Cargo - show cargo inventory sources -->
				<HaveBreakdownTooltip
					cargoId={mat.cargoId}
					listSourceIds={list?.enabledSourceIds ?? []}
					manualAmount={getManualHaveByKey(matKey)}
					isCheckedOff={checkedOff.has(matKey)}
					parentContributions={mat.parentContributions}
				>
					{#if import.meta.env.DEV && mat.rootContributions?.length}
						<DevRequirementBreakdown contributions={mat.rootContributions}>
							<span
								class="w-16 flex-shrink-0 text-right text-sm text-blue-400 tabular-nums border-b border-dashed border-yellow-600/50"
								>x{formatQty(mat.baseRequired)}</span
							>
						</DevRequirementBreakdown>
					{:else}
						<span
							class="w-16 flex-shrink-0 text-right text-sm text-blue-400 tabular-nums"
							>x{formatQty(mat.baseRequired)}</span
						>
					{/if}
				</HaveBreakdownTooltip>
			{/if}
			<!-- Have / Need / Remaining -->
			<div class="flex flex-shrink-0 items-center gap-2 text-sm">
				{#if mat.remaining < mat.baseRequired && !isComplete}
					<span class="w-12 text-right text-xs text-orange-400 tabular-nums"
						>({formatQty(mat.remaining)})</span
					>
				{/if}
				<div
					class="flex items-center overflow-hidden rounded-md border border-gray-600 bg-gray-900/50"
				>
					<input
						type="number"
						value={manualHave.get(matKey) ?? mat.have}
						onchange={(e) =>
							setManualHaveByKey(matKey, parseInt(e.currentTarget.value) || 0)}
						min="0"
						class="w-16 [appearance:textfield] bg-transparent px-2 py-1 text-right text-sm text-white focus:bg-gray-800 focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
						title="Amount you have"
					/>
					<span class="px-1 text-gray-500">/</span>
					<span
						class="min-w-[3rem] px-2 py-1 text-left {isComplete
							? 'text-green-400'
							: effectiveHave > 0
								? 'text-yellow-400'
								: 'text-gray-400'}"
					>
						{formatQty(mat.baseRequired)}
					</span>
				</div>
				<!-- Effort display -->
				{#if mat.effort !== undefined && mat.effort > 0}
					<span
						class="w-14 flex-shrink-0 text-right text-xs text-cyan-400 tabular-nums"
						title="{mat.actionsRequired ?? 0} actions per craft"
					>
						{formatEffort(mat.effort)}
					</span>
				{:else}
					<span class="w-14 flex-shrink-0"></span>
				{/if}
				<div class="h-5 w-5 flex-shrink-0">
					{#if isComplete}
						<svg
							class="h-5 w-5 text-green-500"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M5 13l4 4L19 7"
							/>
						</svg>
					{/if}
				</div>
			</div>
		</div>
	{/snippet}
{/if}
