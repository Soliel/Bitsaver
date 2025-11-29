<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { crafting, removeItemFromList, updateItemQuantity, updateListSources, calculateListRequirements, groupRequirementsByStep } from '$lib/state/crafting.svelte';
	import { inventory, syncIfStale, syncAllInventories, sourcesByClaim } from '$lib/state/inventory.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { gameData, getItemById, searchItems, findRecipesForItem } from '$lib/state/game-data.svelte';
	import { addItemToList } from '$lib/state/crafting.svelte';
	import { getItemIconUrl } from '$lib/utils/icons';
	import RecipePopover from '$lib/components/RecipePopover.svelte';
	import type { MaterialRequirement, StepGroup } from '$lib/types/app';

	// Get list from URL param
	const listId = $derived($page.params.id);
	const list = $derived(crafting.lists.find(l => l.id === listId));

	// Inventory state
	let isSyncing = $state(false);
	let lastSyncMessage = $state<string | null>(null);

	// Material requirements state
	let requirements = $state<MaterialRequirement[]>([]);
	let stepGroups = $state<StepGroup[]>([]);
	let isCalculating = $state(false);

	// Display options
	let hideCompleted = $state(false);
	let collapsedSections = $state<Set<string>>(new Set());

	// Manual tracking: user-entered "have" quantities and checked-off items
	let manualHave = $state<Map<number, number>>(new Map()); // itemId -> manual quantity
	let checkedOff = $state<Set<number>>(new Set()); // itemId -> manually marked complete

	function getManualHave(itemId: number): number | undefined {
		return manualHave.get(itemId);
	}

	let recalcTimeout: ReturnType<typeof setTimeout> | null = null;

	function setManualHave(itemId: number, qty: number) {
		const newMap = new Map(manualHave);
		if (qty <= 0) {
			newMap.delete(itemId);
		} else {
			newMap.set(itemId, qty);
		}
		manualHave = newMap;

		// Debounce recalculation to avoid excessive calls while typing
		if (recalcTimeout) clearTimeout(recalcTimeout);
		recalcTimeout = setTimeout(() => {
			calculateRequirements();
		}, 300);
	}

	function isCheckedOff(itemId: number): boolean {
		return checkedOff.has(itemId);
	}

	function toggleCheckedOff(itemId: number) {
		const newSet = new Set(checkedOff);
		if (newSet.has(itemId)) {
			newSet.delete(itemId);
		} else {
			newSet.add(itemId);
		}
		checkedOff = newSet;
		// Recalculate to propagate check-off through the tree
		calculateRequirements();
	}

	// Get effective "have" amount (manual override or from inventory)
	function getEffectiveHave(mat: MaterialRequirement): number {
		const manual = manualHave.get(mat.itemId);
		return manual !== undefined ? manual : mat.have;
	}

	// Check if material is effectively complete (remaining after propagation is 0)
	function isEffectivelyComplete(mat: MaterialRequirement): boolean {
		if (checkedOff.has(mat.itemId)) return true;
		return mat.remaining === 0;
	}

	// Filter step groups to exclude final items and apply hide completed
	const filteredStepGroups = $derived.by(() => {
		const listItemIds = new Set(list?.items.map(i => i.itemId) || []);

		return stepGroups.map(group => {
			// Filter out final items and optionally completed items
			let materials = group.materials.filter(mat => !listItemIds.has(mat.itemId));
			if (hideCompleted) {
				materials = materials.filter(m => !isEffectivelyComplete(m));
			}

			return {
				...group,
				materials
			};
		}).filter(group => group.materials.length > 0); // Remove empty groups
	});

	function toggleSection(section: string) {
		const newSet = new Set(collapsedSections);
		if (newSet.has(section)) {
			newSet.delete(section);
		} else {
			newSet.add(section);
		}
		collapsedSections = newSet;
	}

	function isSectionCollapsed(section: string): boolean {
		return collapsedSections.has(section);
	}

	// Item search for adding
	let searchQuery = $state('');
	let searchResults = $state<ReturnType<typeof searchItems>>([]);
	let showAddModal = $state(false);
	let itemQuantities = $state<Map<number, number>>(new Map());
	let itemRecipes = $state<Map<number, number | undefined>>(new Map()); // itemId -> selected recipeId
	let recentlyAdded = $state<Map<number, boolean>>(new Map()); // itemId -> show checkmark

	// Inventory source selection modal
	let showSourceModal = $state(false);
	let selectedSourceIds = $state<string[]>([]);

	// Auto-sync on mount (wait for game data to be loaded)
	$effect(() => {
		if (list && gameData.isInitialized) {
			// Initialize selected sources from list
			selectedSourceIds = [...list.enabledSourceIds];

			// Auto-sync if stale
			handleAutoSync();

			// Calculate requirements
			calculateRequirements();
		}
	});

	// Recalculate when list items change
	$effect(() => {
		if (list?.items && gameData.isInitialized) {
			calculateRequirements();
		}
	});

	async function handleAutoSync() {
		isSyncing = true;
		try {
			const didSync = await syncIfStale();
			if (didSync) {
				lastSyncMessage = 'Inventory synced automatically';
				setTimeout(() => lastSyncMessage = null, 3000);
			}
		} catch (e) {
			console.error('Auto-sync failed:', e);
		} finally {
			isSyncing = false;
		}
	}

	async function handleManualSync() {
		isSyncing = true;
		try {
			await syncAllInventories();
			lastSyncMessage = 'Inventory refreshed';
			setTimeout(() => lastSyncMessage = null, 3000);
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
			requirements = await calculateListRequirements(list.id, manualHave, checkedOff);
			stepGroups = groupRequirementsByStep(requirements);
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
		} else {
			searchResults = [];
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

	function closeAddModal() {
		showAddModal = false;
		searchQuery = '';
		searchResults = [];
		itemQuantities = new Map();
		itemRecipes = new Map();
		recentlyAdded = new Map();
	}

	async function handleRemoveItem(itemId: number) {
		if (!list) return;
		await removeItemFromList(list.id, itemId);
	}

	async function handleQuantityChange(itemId: number, quantity: number) {
		if (!list) return;
		await updateItemQuantity(list.id, itemId, quantity);
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
			const allIds = inventory.sources.map(s => s.id);
			// Remove the one being unchecked
			selectedSourceIds = allIds.filter(id => id !== sourceId);
		} else if (selectedSourceIds.includes(sourceId)) {
			selectedSourceIds = selectedSourceIds.filter(id => id !== sourceId);
		} else {
			selectedSourceIds = [...selectedSourceIds, sourceId];
		}
	}

	function toggleAllSources(claimId: string, enable: boolean) {
		const claimSources = sourcesByClaim.value.get(claimId) || [];
		const claimSourceIds = claimSources.map(s => s.id);

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
				const allIds = inventory.sources.map(s => s.id);
				selectedSourceIds = allIds.filter(id => !claimSourceIds.includes(id));
			} else {
				selectedSourceIds = selectedSourceIds.filter(id => !claimSourceIds.includes(id));
			}
		}
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
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
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
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
						</svg>
						Inventory Sources
						{#if list.enabledSourceIds.length > 0}
							<span class="rounded-full bg-blue-600 px-2 py-0.5 text-xs">{list.enabledSourceIds.length}</span>
						{:else}
							<span class="rounded-full bg-gray-600 px-2 py-0.5 text-xs">All</span>
						{/if}
					</span>
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
							<span class="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent"></span>
							Syncing...
						</span>
					{:else}
						<span class="flex items-center gap-2">
							<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
							</svg>
							Refresh
						</span>
					{/if}
				</button>

				<!-- Add Item Button -->
				<button
					onclick={() => showAddModal = true}
					class="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
				>
					+ Add Item
				</button>
			</div>
		</div>

		<!-- Options bar -->
		<div class="flex items-center gap-4">
			<label class="flex cursor-pointer items-center gap-2 text-sm text-gray-300">
				<input
					type="checkbox"
					bind:checked={hideCompleted}
					class="h-4 w-4 rounded border-gray-600 bg-gray-700 text-blue-600 focus:ring-blue-500"
				/>
				Hide completed rows
			</label>
		</div>

		<!-- Sync message -->
		{#if lastSyncMessage}
			<div class="rounded-lg bg-green-900/50 px-4 py-2 text-sm text-green-300">
				{lastSyncMessage}
			</div>
		{/if}

		<!-- Sections Container -->
		<div class="space-y-2">
			{#if list.items.length > 0}
				{#if isCalculating}
					<div class="flex items-center gap-2 rounded-lg bg-gray-800 px-4 py-3 text-gray-400">
						<span class="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent"></span>
						Calculating materials...
					</div>
				{:else}
					<!-- STEP-BASED SECTIONS -->
					{#each filteredStepGroups as group (group.step)}
						{@const completedInGroup = stepGroups.find(g => g.step === group.step)?.materials.filter(m => isEffectivelyComplete(m)).length || 0}
						{@const totalInGroup = stepGroups.find(g => g.step === group.step)?.materials.length || 0}
						{@const sectionId = `step-${group.step}`}
						{@const headerColor = group.step === 1 ? 'bg-amber-900/50 hover:bg-amber-900/70' : 'bg-blue-900/40 hover:bg-blue-900/60'}
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
										class="h-4 w-4 {iconColor} transition-transform {isSectionCollapsed(sectionId) ? '' : 'rotate-90'}"
										fill="none" stroke="currentColor" viewBox="0 0 24 24"
									>
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
									</svg>
									<span class="font-medium {textColor}">{group.label} ({group.materials.length} items)</span>
									{#if completedInGroup > 0}
										<span class="text-xs text-green-400">{completedInGroup}/{totalInGroup} done</span>
									{/if}
								</div>
							</button>

							{#if !isSectionCollapsed(sectionId)}
								<div class="divide-y divide-gray-700">
									{#each group.materials as mat, i (mat.itemId)}
										{@const matIconUrl = mat.item ? getItemIconUrl(mat.item.iconAssetName) : null}
										{@const effectiveHave = getEffectiveHave(mat)}
										{@const isComplete = isEffectivelyComplete(mat)}
										{@const prevTier = i > 0 ? group.materials[i - 1].tier : null}
										<!-- Tier divider if tier changed -->
										{#if prevTier !== null && mat.tier !== prevTier}
											<div class="px-4 py-1 text-xs text-gray-500 bg-gray-750">
												Tier {mat.tier}
											</div>
										{/if}
										<div class="flex items-center gap-3 px-4 py-2 hover:bg-gray-750 {isComplete ? 'opacity-50' : ''}">
											<!-- Checkbox -->
											<button
												type="button"
												onclick={() => toggleCheckedOff(mat.itemId)}
												class="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border {isCheckedOff(mat.itemId) ? 'border-green-500 bg-green-600' : 'border-gray-500 hover:border-gray-400'}"
												aria-label={isCheckedOff(mat.itemId) ? 'Unmark as complete' : 'Mark as complete'}
											>
												{#if isCheckedOff(mat.itemId)}
													<svg class="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
														<path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
													</svg>
												{/if}
											</button>
											<!-- Icon + Name with Recipe Popover -->
											<RecipePopover itemId={mat.itemId}>
												<div class="flex w-full items-center gap-3 cursor-help">
													<div class="flex h-8 w-8 flex-shrink-0 items-center justify-center">
														{#if matIconUrl}
															<img src={matIconUrl} alt="" class="h-7 w-7 object-contain" />
														{:else}
															<span class="text-gray-500">?</span>
														{/if}
													</div>
													<span class="text-sm text-white truncate flex-1">{mat.item?.name || `Item #${mat.itemId}`}</span>
													{#if import.meta.env.DEV && mat.item?.materialCost !== undefined}
														<span class="w-12 flex-shrink-0 text-xs text-green-400 text-right" title="Material cost: {mat.item.materialCost.toFixed(2)}">{formatCost(mat.item.materialCost)}</span>
													{/if}
													<span class="w-16 flex-shrink-0 text-sm text-blue-400 text-right tabular-nums">x{formatQty(mat.baseRequired)}</span>
												</div>
											</RecipePopover>
											<!-- Have / Need / Remaining -->
											<div class="flex items-center gap-2 text-sm flex-shrink-0">
												{#if mat.remaining < mat.baseRequired && !isComplete}
													<span class="text-xs text-orange-400 tabular-nums w-12 text-right">({formatQty(mat.remaining)})</span>
												{/if}
												<div class="flex items-center rounded-md bg-gray-900/50 border border-gray-600 overflow-hidden">
													<input
														type="number"
														value={getManualHave(mat.itemId) ?? mat.have}
														onchange={(e) => setManualHave(mat.itemId, parseInt(e.currentTarget.value) || 0)}
														min="0"
														class="w-16 bg-transparent px-2 py-1 text-right text-sm text-white focus:outline-none focus:bg-gray-800 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
														title="Amount you have"
													/>
													<span class="px-1 text-gray-500">/</span>
													<span class="px-2 py-1 min-w-[3rem] text-left {isComplete ? 'text-green-400' : effectiveHave > 0 ? 'text-yellow-400' : 'text-gray-400'}">
														{formatQty(mat.baseRequired)}
													</span>
												</div>
												<div class="w-5 h-5 flex-shrink-0">
												{#if isComplete}
													<svg class="h-5 w-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
														<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
													</svg>
												{/if}
											</div>
											</div>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{/each}
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
							class="h-4 w-4 text-purple-400 transition-transform {isSectionCollapsed('items') ? '' : 'rotate-90'}"
							fill="none" stroke="currentColor" viewBox="0 0 24 24"
						>
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
						</svg>
						<span class="font-medium text-purple-200">Final Crafts ({list.items.length})</span>
						{#if list.items.some(i => isCheckedOff(i.itemId) || (getManualHave(i.itemId) ?? 0) >= i.quantity)}
							<span class="text-xs text-green-400">{list.items.filter(i => isCheckedOff(i.itemId) || (getManualHave(i.itemId) ?? 0) >= i.quantity).length}/{list.items.length} done</span>
						{/if}
					</button>
					<button
						type="button"
						onclick={() => showAddModal = true}
						class="rounded bg-purple-600 px-2 py-1 text-xs text-white hover:bg-purple-700"
					>
						+ Add
					</button>
				</div>

				{#if !isSectionCollapsed('items')}
					<div class="divide-y divide-gray-700">
						{#if list.items.length === 0}
							<div class="px-4 py-3 text-sm text-gray-400">No items yet. Click + Add to get started.</div>
						{:else}
							{#each list.items as listItem (listItem.id)}
								{@const item = getItemById(listItem.itemId)}
								{@const iconUrl = item ? getItemIconUrl(item.iconAssetName) : null}
								{@const haveQty = getManualHave(listItem.itemId) ?? 0}
								{@const isComplete = isCheckedOff(listItem.itemId) || haveQty >= listItem.quantity}
								{#if !hideCompleted || !isComplete}
									<div class="flex items-center gap-3 px-4 py-2 hover:bg-gray-750 {isComplete ? 'opacity-50' : ''}">
										<!-- Checkbox -->
										<button
											type="button"
											onclick={() => toggleCheckedOff(listItem.itemId)}
											class="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border {isCheckedOff(listItem.itemId) ? 'border-green-500 bg-green-600' : 'border-gray-500 hover:border-gray-400'}"
											aria-label={isCheckedOff(listItem.itemId) ? 'Unmark as complete' : 'Mark as complete'}
										>
											{#if isCheckedOff(listItem.itemId)}
												<svg class="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
													<path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
												</svg>
											{/if}
										</button>
										<!-- Icon + Name with Recipe Popover -->
										<RecipePopover itemId={listItem.itemId}>
											<div class="flex items-center gap-3 flex-1 min-w-0 cursor-help">
												<div class="flex h-8 w-8 flex-shrink-0 items-center justify-center">
													{#if iconUrl}
														<img src={iconUrl} alt="" class="h-7 w-7 object-contain" />
													{:else}
														<span class="text-gray-500">?</span>
													{/if}
												</div>
												<div class="min-w-0 flex-1">
													<span class="text-sm text-white">{item?.name || `Item #${listItem.itemId}`}</span>
													<span class="ml-1 text-sm text-purple-400 tabular-nums">x{formatQty(listItem.quantity)}</span>
												</div>
											</div>
										</RecipePopover>
										<!-- Have / Need + Controls -->
										<div class="flex items-center gap-2 text-sm">
											<div class="flex items-center rounded-md bg-gray-900/50 border border-gray-600 overflow-hidden">
												<input
													type="number"
													value={haveQty}
													onchange={(e) => setManualHave(listItem.itemId, parseInt(e.currentTarget.value) || 0)}
													min="0"
													class="w-16 bg-transparent px-2 py-1 text-right text-sm text-white focus:outline-none focus:bg-gray-800 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
													title="Amount you have"
												/>
												<span class="px-1 text-gray-500">/</span>
												<input
													type="number"
													value={listItem.quantity}
													onchange={(e) => handleQuantityChange(listItem.itemId, parseInt(e.currentTarget.value) || 1)}
													min="1"
													class="w-16 bg-transparent px-2 py-1 text-left text-sm text-purple-300 focus:outline-none focus:bg-gray-800 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
													title="Amount to craft"
												/>
											</div>
											<div class="w-5 h-5 flex-shrink-0">
												{#if isComplete}
													<svg class="h-5 w-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
														<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
													</svg>
												{/if}
											</div>
											<button
												onclick={() => handleRemoveItem(listItem.itemId)}
												class="rounded p-1 text-gray-400 hover:bg-gray-700 hover:text-red-400"
												aria-label="Remove item"
											>
												<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
													<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
												</svg>
											</button>
										</div>
									</div>
								{/if}
							{/each}
						{/if}
					</div>
				{/if}
			</div>
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

			<div class="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg bg-gray-800 shadow-xl">
				<!-- Header -->
				<div class="flex items-center justify-between border-b border-gray-700 p-4">
					<h3 class="text-lg font-semibold text-white">Add Items to List</h3>
					<button
						type="button"
						onclick={closeAddModal}
						class="rounded p-1 text-gray-400 hover:bg-gray-700 hover:text-white"
						aria-label="Close"
					>
						<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>

				<!-- Search -->
				<div class="border-b border-gray-700 p-4">
					<input
						type="text"
						value={searchQuery}
						oninput={(e) => handleSearch(e.currentTarget.value)}
						placeholder="Search items by name..."
						class="w-full rounded-lg border border-gray-600 bg-gray-700 px-4 py-3 text-lg text-white placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
						autofocus
					/>
					{#if searchQuery.length > 0 && searchQuery.length < 2}
						<p class="mt-2 text-sm text-gray-400">Type at least 2 characters to search</p>
					{/if}
				</div>

				<!-- Results -->
				<div class="flex-1 overflow-auto p-4">
					{#if searchResults.length > 0}
						<div class="space-y-2">
							{#each searchResults as item (item.id)}
								{@const searchIconUrl = getItemIconUrl(item.iconAssetName)}
								{@const isInList = list?.items.some(li => li.itemId === item.id)}
								{@const recipes = getSortedRecipes(item.id)}
								{@const selectedRecipeId = getSelectedRecipe(item.id) ?? getDefaultRecipeId(item.id)}
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
												onchange={(e) => setItemQuantity(item.id, parseInt(e.currentTarget.value) || 1)}
												onwheel={(e) => handleQuantityWheel(item.id, e)}
												min="1"
												class="w-20 rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-center text-white focus:border-blue-500 focus:outline-none"
											/>
											<button
												type="button"
												onclick={() => handleAddItem(item.id)}
												class="rounded-lg px-3 py-1.5 text-white transition-all duration-300 {isRecentlyAdded(item.id) ? 'bg-green-600' : 'bg-blue-600 hover:bg-blue-700'}"
												title={isRecentlyAdded(item.id) ? 'Added!' : 'Add to list'}
												aria-label={isRecentlyAdded(item.id) ? 'Added to list' : 'Add to list'}
											>
												{#if isRecentlyAdded(item.id)}
													<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
														<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
													</svg>
												{:else}
													<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
														<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
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
												onchange={(e) => setSelectedRecipe(item.id, parseInt(e.currentTarget.value))}
												class="flex-1 rounded border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-white focus:border-blue-500 focus:outline-none"
											>
												{#each recipes as recipe, i (recipe.id)}
													<option value={recipe.id}>
														{recipe.craftingStationName || recipe.name} (×{recipe.outputQuantity}){#if recipe.cost !== undefined} · {formatCost(recipe.cost)}{/if}{#if i === 0 && recipe.cost !== undefined} ★{/if}
													</option>
												{/each}
											</select>
										</div>
									{:else if recipes.length === 1}
										<p class="mt-1 text-xs text-gray-500">
											{recipes[0].craftingStationName || recipes[0].name} (×{recipes[0].outputQuantity}){#if recipes[0].cost !== undefined} · Cost: {formatCost(recipes[0].cost)}{/if}
										</p>
									{:else}
										<p class="mt-1 text-xs text-gray-500">No recipe (raw material){#if item.materialCost !== undefined} · Cost: {formatCost(item.materialCost)}{/if}</p>
									{/if}
								</div>
							{/each}
						</div>
					{:else if searchQuery.length >= 2}
						<p class="py-8 text-center text-gray-400">No items found matching "{searchQuery}"</p>
					{:else}
						<p class="py-8 text-center text-gray-400">Start typing to search for items</p>
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
				onclick={() => showSourceModal = false}
				aria-label="Close modal"
			></button>

			<div class="relative max-h-[80vh] w-full max-w-lg overflow-auto rounded-lg bg-gray-800 p-6 shadow-xl">
				<h3 class="text-lg font-semibold text-white">Select Inventory Sources</h3>
				<p class="mt-1 text-sm text-gray-400">
					Choose which inventories to include when calculating materials for this list.
					{#if selectedSourceIds.length === 0}
						<span class="text-blue-400">All sources are currently included.</span>
					{/if}
				</p>

				<div class="mt-4 space-y-4">
					{#each [...sourcesByClaim.value.entries()] as [claimId, sources] (claimId)}
						{@const claimName = claimId === 'player' ? 'Player Inventory' : (sources[0]?.claimName || claimId)}
						{@const allSelected = sources.every(s => selectedSourceIds.length === 0 || selectedSourceIds.includes(s.id))}

						<div class="rounded-lg border border-gray-600 p-3">
							<div class="flex items-center justify-between">
								<span class="font-medium text-white">{claimName}</span>
								<button
									type="button"
									onclick={() => toggleAllSources(claimId, !allSelected)}
									class="text-sm text-blue-400 hover:text-blue-300"
								>
									{allSelected ? 'Deselect All' : 'Select All'}
								</button>
							</div>
							<div class="mt-2 space-y-1">
								{#each sources as source (source.id)}
									<label class="flex items-center gap-2 cursor-pointer p-1 hover:bg-gray-700 rounded">
										<input
											type="checkbox"
											checked={selectedSourceIds.length === 0 || selectedSourceIds.includes(source.id)}
											onchange={() => toggleSource(source.id)}
											class="rounded border-gray-500 bg-gray-700 text-blue-600 focus:ring-blue-500"
										/>
										<span class="text-sm text-gray-300">{source.nickname || source.name}</span>
									</label>
								{/each}
							</div>
						</div>
					{/each}

					{#if sourcesByClaim.value.size === 0}
						<p class="text-center text-gray-400">
							No inventory sources available. Refresh inventory to load sources.
						</p>
					{/if}
				</div>

				<div class="mt-6 flex justify-end gap-3">
					<button
						type="button"
						onclick={() => showSourceModal = false}
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
{/if}
