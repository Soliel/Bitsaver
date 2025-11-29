<script lang="ts">
	import { searchItems, itemsArray } from '$lib/state/game-data.svelte';
	import type { Item } from '$lib/types/game';
	import ItemCard from './ItemCard.svelte';

	interface Props {
		onSelect?: (item: Item) => void;
		placeholder?: string;
	}

	let { onSelect, placeholder = 'Search items...' }: Props = $props();

	let query = $state('');
	let isOpen = $state(false);
	let results = $derived(query.length >= 2 ? searchItems(query, 10) : []);

	function handleSelect(item: Item) {
		if (onSelect) {
			onSelect(item);
		}
		query = '';
		isOpen = false;
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			isOpen = false;
		}
	}
</script>

<div class="relative">
	<div class="relative">
		<input
			type="text"
			bind:value={query}
			onfocus={() => (isOpen = true)}
			onkeydown={handleKeydown}
			{placeholder}
			class="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-4 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
		/>
		<svg
			class="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400"
			fill="none"
			stroke="currentColor"
			viewBox="0 0 24 24"
		>
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width="2"
				d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
			/>
		</svg>
	</div>

	{#if isOpen && query.length >= 2}
		<div
			class="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-gray-200 bg-white shadow-lg"
		>
			{#if results.length > 0}
				<div class="p-2 space-y-1">
					{#each results as item (item.id)}
						<ItemCard {item} onclick={() => handleSelect(item)} />
					{/each}
				</div>
			{:else}
				<div class="p-4 text-center text-gray-500">
					No items found for "{query}"
				</div>
			{/if}
		</div>
	{/if}
</div>

<!-- Backdrop to close dropdown when clicking outside -->
{#if isOpen}
	<button
		type="button"
		class="fixed inset-0 z-40"
		onclick={() => (isOpen = false)}
		aria-label="Close search"
	></button>
{/if}
