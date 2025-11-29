<script lang="ts">
	import { page } from '$app/state';
	import { inventory } from '$lib/state/inventory.svelte';
	import { gameData } from '$lib/state/game-data.svelte';

	interface Props {
		onToggleSidebar?: () => void;
	}

	let { onToggleSidebar }: Props = $props();

	// Get page title from path
	const pageTitle = $derived.by(() => {
		const path = page.url.pathname;
		if (path === '/') return 'Dashboard';
		if (path.startsWith('/items')) return 'Items';
		if (path.startsWith('/lists')) return 'Crafting Lists';
		if (path.startsWith('/inventory')) return 'Inventory';
		if (path.startsWith('/settings')) return 'Settings';
		return 'BitSaver';
	});
</script>

<header class="flex h-16 items-center justify-between border-b border-gray-700 bg-gray-900 px-6">
	<div class="flex items-center gap-4">
		<button
			onclick={onToggleSidebar}
			class="rounded p-2 text-gray-400 hover:bg-gray-800 hover:text-white lg:hidden"
			aria-label="Toggle sidebar"
		>
			<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M4 6h16M4 12h16M4 18h16"
				/>
			</svg>
		</button>
		<h1 class="text-xl font-semibold text-white">{pageTitle}</h1>
	</div>

	<div class="flex items-center gap-4">
		{#if gameData.isLoading}
			<span class="text-sm text-gray-400">Loading data...</span>
		{/if}

		{#if inventory.isSyncing}
			<span class="text-sm text-blue-400">Syncing inventory...</span>
		{:else if inventory.lastSync}
			<span class="text-xs text-gray-500">
				Last sync: {new Date(inventory.lastSync).toLocaleTimeString()}
			</span>
		{/if}
	</div>
</header>
