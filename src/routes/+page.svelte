<script lang="ts">
	import { gameData } from '$lib/state/game-data.svelte';
	import { inventory, syncAllInventories } from '$lib/state/inventory.svelte';
	import { crafting } from '$lib/state/crafting.svelte';
	import { settings } from '$lib/state/settings.svelte';
</script>

<div class="mx-auto max-w-4xl space-y-6">
	<!-- Welcome Section -->
	<div class="rounded-lg bg-gradient-to-r from-blue-600 to-indigo-700 p-6 text-white shadow-lg">
		<h2 class="text-2xl font-bold">Welcome to BitSaver</h2>
		<p class="mt-2 text-blue-100">
			Your Teamcraft-style crafting assistant for Bitcraft. Track recipes, manage inventory, and
			plan your crafting.
		</p>
	</div>

	<!-- Status Cards -->
	<div class="grid gap-4 md:grid-cols-3">
		<!-- Game Data Status -->
		<div class="rounded-lg bg-gray-700 p-4 shadow">
			<div class="flex items-center justify-between">
				<h3 class="font-medium text-gray-300">Game Data</h3>
				{#if gameData.isLoading}
					<span class="text-sm text-blue-400">Loading...</span>
				{:else if gameData.isInitialized}
					<span class="text-sm text-green-400">Ready</span>
				{:else}
					<span class="text-sm text-gray-500">Not loaded</span>
				{/if}
			</div>
			<p class="mt-2 text-2xl font-bold text-white">{gameData.items.size}</p>
			<p class="text-sm text-gray-400">items cached</p>
		</div>

		<!-- Inventory Status -->
		<div class="rounded-lg bg-gray-700 p-4 shadow">
			<div class="flex items-center justify-between">
				<h3 class="font-medium text-gray-300">Inventory</h3>
				{#if inventory.isSyncing}
					<span class="text-sm text-blue-400">Syncing...</span>
				{:else if inventory.sources.length > 0}
					<span class="text-sm text-green-400">Connected</span>
				{:else}
					<span class="text-sm text-gray-500">Not configured</span>
				{/if}
			</div>
			<p class="mt-2 text-2xl font-bold text-white">{inventory.sources.length}</p>
			<p class="text-sm text-gray-400">sources configured</p>
		</div>

		<!-- Crafting Lists -->
		<div class="rounded-lg bg-gray-700 p-4 shadow">
			<div class="flex items-center justify-between">
				<h3 class="font-medium text-gray-300">Crafting Lists</h3>
				<a href="/lists" class="text-sm text-blue-400 hover:underline">View all</a>
			</div>
			<p class="mt-2 text-2xl font-bold text-white">{crafting.lists.length}</p>
			<p class="text-sm text-gray-400">active lists</p>
		</div>
	</div>

	<!-- Quick Actions -->
	<div class="rounded-lg bg-gray-700 p-6 shadow">
		<h3 class="mb-4 font-semibold text-white">Quick Actions</h3>
		<div class="flex flex-wrap gap-3">
			<a
				href="/items"
				class="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
			>
				<span>Browse Items</span>
			</a>
			<a
				href="/lists"
				class="inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-white hover:bg-green-700"
			>
				<span>New Crafting List</span>
			</a>
			<button
				onclick={() => syncAllInventories()}
				disabled={inventory.isSyncing || !settings.playerId}
				class="inline-flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
			>
				<span>Sync Inventory</span>
			</button>
		</div>
	</div>

	<!-- Recent Lists -->
	{#if crafting.lists.length > 0}
		<div class="rounded-lg bg-gray-700 p-6 shadow">
			<div class="mb-4 flex items-center justify-between">
				<h3 class="font-semibold text-white">Recent Crafting Lists</h3>
				<a href="/lists" class="text-sm text-blue-400 hover:underline">View all</a>
			</div>
			<div class="space-y-2">
				{#each crafting.lists.slice(0, 3) as list}
					<a
						href="/lists/{list.id}"
						class="block rounded-lg border border-gray-600 p-3 transition-colors hover:bg-gray-600"
					>
						<div class="flex items-center justify-between">
							<span class="font-medium text-white">{list.name}</span>
							<span class="text-sm text-gray-400">{list.items.length} items</span>
						</div>
						{#if list.description}
							<p class="mt-1 text-sm text-gray-400">{list.description}</p>
						{/if}
					</a>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Loading State -->
	{#if gameData.isLoading}
		<div class="rounded-lg bg-gray-700 p-6 shadow">
			<div class="flex items-center gap-3">
				<div class="h-5 w-5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent">
				</div>
				<span class="text-gray-300">Loading game data... {gameData.loadingProgress}%</span>
			</div>
			<div class="mt-3 h-2 overflow-hidden rounded-full bg-gray-600">
				<div
					class="h-full bg-blue-600 transition-all"
					style="width: {gameData.loadingProgress}%"
				></div>
			</div>
		</div>
	{/if}

	<!-- Error State -->
	{#if gameData.error}
		<div class="rounded-lg bg-red-900/50 p-4 text-red-300">
			<strong>Error:</strong>
			{gameData.error}
		</div>
	{/if}
</div>
