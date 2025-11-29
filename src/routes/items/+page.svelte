<script lang="ts">
	import { gameData, deduplicatedItems } from '$lib/state/game-data.svelte';
	import ItemCard from '$lib/components/items/ItemCard.svelte';
	import type { Item } from '$lib/types/game';

	let searchQuery = $state('');
	let selectedTier = $state<number | null>(null);
	let selectedItem = $state<Item | null>(null);
	let displayCount = $state(50);
	let loadMoreRef = $state<HTMLDivElement | null>(null);

	// Filter items based on search and tier (using deduplicated list)
	const filteredItems = $derived.by(() => {
		let items = deduplicatedItems.value;

		// Filter by tier
		if (selectedTier !== null) {
			items = items.filter((item) => item.tier === selectedTier);
		}

		// Filter by search
		if (searchQuery.length >= 2) {
			const query = searchQuery.toLowerCase();
			items = items.filter((item) => item.name.toLowerCase().includes(query));
		}

		return items;
	});

	// Items to display (limited by displayCount for performance)
	const displayedItems = $derived(filteredItems.slice(0, displayCount));

	// Reset display count when filters change
	$effect(() => {
		// Track filter changes
		searchQuery;
		selectedTier;
		// Reset to initial count
		displayCount = 50;
	});

	// Intersection Observer for infinite scroll
	$effect(() => {
		if (!loadMoreRef) return;

		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting && displayCount < filteredItems.length) {
					displayCount = Math.min(displayCount + 50, filteredItems.length);
				}
			},
			{ rootMargin: '200px' }
		);

		observer.observe(loadMoreRef);

		return () => observer.disconnect();
	});

	// Available tiers
	const tiers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

	function handleItemSelect(item: Item) {
		selectedItem = item;
	}
</script>

<div class="space-y-6">
	<!-- Search and Filters -->
	<div class="rounded-lg bg-gray-700 p-4 shadow">
		<div class="flex flex-wrap items-center gap-4">
			<!-- Search -->
			<div class="flex-1">
				<input
					type="text"
					bind:value={searchQuery}
					placeholder="Search items by name..."
					class="w-full rounded-lg border border-gray-600 bg-gray-800 px-4 py-2 text-white placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
				/>
			</div>

			<!-- Tier filter -->
			<div class="flex items-center gap-2">
				<span class="text-sm text-gray-300">Tier:</span>
				<select
					bind:value={selectedTier}
					class="rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
				>
					<option value={null}>All</option>
					{#each tiers as tier}
						<option value={tier}>Tier {tier}</option>
					{/each}
				</select>
			</div>
		</div>

		<div class="mt-2 text-sm text-gray-400">
			Showing {displayedItems.length} of {filteredItems.length} items
			{#if filteredItems.length !== deduplicatedItems.length}
				<span class="text-gray-500">({deduplicatedItems.length} total)</span>
			{/if}
		</div>
	</div>

	<!-- Items Grid -->
	<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
		{#if gameData.isLoading}
			<div class="col-span-full rounded-lg bg-gray-700 p-8 text-center shadow">
				<div
					class="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-blue-400 border-t-transparent"
				></div>
				<p class="mt-4 text-gray-300">Loading items...</p>
			</div>
		{:else if filteredItems.length === 0}
			<div class="col-span-full rounded-lg bg-gray-700 p-8 text-center shadow">
				<p class="text-gray-300">
					{#if searchQuery || selectedTier !== null}
						No items match your filters
					{:else}
						No items loaded. Try refreshing the page.
					{/if}
				</p>
			</div>
		{:else}
			{#each displayedItems as item (item.id)}
				<div class="rounded-lg bg-gray-700 shadow">
					<ItemCard
						{item}
						onclick={() => handleItemSelect(item)}
						selected={selectedItem?.id === item.id}
					/>
				</div>
			{/each}
		{/if}
	</div>

	<!-- Load more trigger (invisible element for intersection observer) -->
	{#if displayCount < filteredItems.length}
		<div bind:this={loadMoreRef} class="h-1"></div>
	{/if}

	<!-- Selected Item Detail Panel -->
	{#if selectedItem}
		<div class="fixed inset-y-0 right-0 z-50 w-96 bg-gray-800 shadow-xl">
			<div class="flex h-full flex-col">
				<div class="flex items-center justify-between border-b border-gray-700 p-4">
					<h2 class="text-lg font-semibold text-white">{selectedItem.name}</h2>
					<button
						onclick={() => (selectedItem = null)}
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

				<div class="flex-1 overflow-auto p-4">
					<div class="space-y-4">
						<div>
							<p class="text-sm text-gray-400">Tier</p>
							<p class="text-lg font-medium text-white">Tier {selectedItem.tier}</p>
						</div>
						<div>
							<p class="text-sm text-gray-400">Category</p>
							<p class="text-lg font-medium text-white">{selectedItem.tag || 'Unknown'}</p>
						</div>
						<div>
							<p class="text-sm text-gray-400">Rarity</p>
							<p class="text-lg font-medium text-white">{selectedItem.rarityStr || 'Common'}</p>
						</div>
						<div>
							<p class="text-sm text-gray-400">Item ID</p>
							<p class="font-mono text-sm text-gray-300">{selectedItem.id}</p>
						</div>
					</div>

					<div class="mt-6">
						<a
							href="/items/{selectedItem.id}"
							class="block w-full rounded-lg bg-blue-600 px-4 py-2 text-center text-white hover:bg-blue-700"
						>
							View Full Details
						</a>
					</div>
				</div>
			</div>
		</div>

		<!-- Backdrop -->
		<button
			type="button"
			class="fixed inset-0 z-40 bg-black/50"
			onclick={() => (selectedItem = null)}
			aria-label="Close panel"
		></button>
	{/if}
</div>
