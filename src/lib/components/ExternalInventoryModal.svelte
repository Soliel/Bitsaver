<script lang="ts">
	import { searchPlayers, searchClaims } from '$lib/services/api/inventory';
	import type { ExternalInventoryRef } from '$lib/types/app';

	interface Props {
		listId: string;
		existingRefs: ExternalInventoryRef[];
		onClose: () => void;
		onAdd: (ref: ExternalInventoryRef) => void;
	}

	let { listId, existingRefs, onClose, onAdd }: Props = $props();

	type TabType = 'player' | 'claim';
	let activeTab = $state<TabType>('player');
	let query = $state('');
	let playerResults = $state<Array<{ entityId: string; username: string }>>([]);
	let claimResults = $state<Array<{ entityId: string; name: string }>>([]);
	let isSearching = $state(false);
	let isAdding = $state<string | null>(null);
	let error = $state<string | null>(null);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	function isAlreadyAdded(type: TabType, entityId: string): boolean {
		return existingRefs.some((r) => r.type === type && r.entityId === entityId);
	}

	async function handleSearch() {
		if (query.length < 2) {
			playerResults = [];
			claimResults = [];
			return;
		}

		isSearching = true;
		error = null;

		try {
			if (activeTab === 'player') {
				playerResults = await searchPlayers(query);
			} else {
				claimResults = await searchClaims(query);
			}
		} catch (e) {
			console.error('Search failed:', e);
			error = e instanceof Error ? e.message : 'Search failed';
			playerResults = [];
			claimResults = [];
		} finally {
			isSearching = false;
		}
	}

	function debouncedSearch() {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(handleSearch, 300);
	}

	function switchTab(tab: TabType) {
		activeTab = tab;
		query = '';
		playerResults = [];
		claimResults = [];
		error = null;
	}

	async function handleAddPlayer(player: { entityId: string; username: string }) {
		if (isAlreadyAdded('player', player.entityId)) return;

		isAdding = player.entityId;
		try {
			const ref: ExternalInventoryRef = {
				type: 'player',
				entityId: player.entityId,
				name: player.username,
				addedAt: Date.now()
			};
			onAdd(ref);
		} finally {
			isAdding = null;
		}
	}

	async function handleAddClaim(claim: { entityId: string; name: string }) {
		if (isAlreadyAdded('claim', claim.entityId)) return;

		isAdding = claim.entityId;
		try {
			const ref: ExternalInventoryRef = {
				type: 'claim',
				entityId: claim.entityId,
				name: claim.name,
				addedAt: Date.now()
			};
			onAdd(ref);
		} finally {
			isAdding = null;
		}
	}
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center p-4">
	<button
		type="button"
		class="absolute inset-0 bg-black/70"
		onclick={onClose}
		aria-label="Close modal"
	></button>

	<div
		class="relative max-h-[80vh] w-full max-w-lg overflow-auto rounded-lg bg-gray-800 p-6 shadow-xl"
	>
		<h3 class="text-lg font-semibold text-white">Add External Inventory</h3>
		<p class="mt-1 text-sm text-gray-400">
			Search for another player or settlement to include their inventory in this list.
		</p>

		<!-- Tabs -->
		<div class="mt-4 flex border-b border-gray-600">
			<button
				type="button"
				class="px-4 py-2 text-sm font-medium transition-colors {activeTab === 'player'
					? 'border-b-2 border-blue-500 text-blue-400'
					: 'text-gray-400 hover:text-white'}"
				onclick={() => switchTab('player')}
			>
				Player
			</button>
			<button
				type="button"
				class="px-4 py-2 text-sm font-medium transition-colors {activeTab === 'claim'
					? 'border-b-2 border-blue-500 text-blue-400'
					: 'text-gray-400 hover:text-white'}"
				onclick={() => switchTab('claim')}
			>
				Settlement
			</button>
		</div>

		<!-- Search Input -->
		<div class="mt-4">
			<label for="external-search" class="block text-sm font-medium text-gray-300">
				{activeTab === 'player' ? 'Player Name' : 'Settlement Name'}
			</label>
			<div class="relative mt-1">
				<input
					id="external-search"
					type="text"
					bind:value={query}
					oninput={debouncedSearch}
					placeholder={activeTab === 'player'
						? 'Search for a player...'
						: 'Search for a settlement...'}
					autocomplete="off"
					class="w-full rounded-lg border border-gray-600 bg-gray-700 px-4 py-2 pr-10 text-white placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
				/>
				{#if isSearching}
					<div class="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
						<div
							class="h-5 w-5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent"
						></div>
					</div>
				{/if}
			</div>
			{#if query.length > 0 && query.length < 2}
				<p class="mt-1 text-sm text-gray-400">Type at least 2 characters to search</p>
			{/if}
		</div>

		<!-- Results -->
		<div class="mt-4 max-h-64 overflow-y-auto">
			{#if error}
				<p class="text-center text-sm text-red-400">{error}</p>
			{:else if activeTab === 'player' && playerResults.length > 0}
				<ul class="space-y-2">
					{#each playerResults as player (player.entityId)}
						{@const alreadyAdded = isAlreadyAdded('player', player.entityId)}
						<li
							class="flex items-center justify-between rounded-lg border border-gray-600 p-3 {alreadyAdded
								? 'bg-gray-700/50'
								: ''}"
						>
							<div>
								<span class="font-medium text-white">{player.username}</span>
								<span class="ml-2 text-xs text-gray-400">{player.entityId}</span>
							</div>
							{#if alreadyAdded}
								<span class="text-xs text-gray-400">Already added</span>
							{:else}
								<button
									type="button"
									class="rounded-lg bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
									disabled={isAdding === player.entityId}
									onclick={() => handleAddPlayer(player)}
								>
									{#if isAdding === player.entityId}
										<span
											class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
										></span>
									{:else}
										Add
									{/if}
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			{:else if activeTab === 'claim' && claimResults.length > 0}
				<ul class="space-y-2">
					{#each claimResults as claim (claim.entityId)}
						{@const alreadyAdded = isAlreadyAdded('claim', claim.entityId)}
						<li
							class="flex items-center justify-between rounded-lg border border-gray-600 p-3 {alreadyAdded
								? 'bg-gray-700/50'
								: ''}"
						>
							<div>
								<span class="font-medium text-white">{claim.name}</span>
								<span class="ml-2 text-xs text-gray-400">{claim.entityId}</span>
							</div>
							{#if alreadyAdded}
								<span class="text-xs text-gray-400">Already added</span>
							{:else}
								<button
									type="button"
									class="rounded-lg bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
									disabled={isAdding === claim.entityId}
									onclick={() => handleAddClaim(claim)}
								>
									{#if isAdding === claim.entityId}
										<span
											class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
										></span>
									{:else}
										Add
									{/if}
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			{:else if query.length >= 2 && !isSearching}
				<p class="text-center text-gray-400">
					No {activeTab === 'player' ? 'players' : 'settlements'} found
				</p>
			{:else if query.length === 0}
				<p class="text-center text-gray-400">
					Enter a name to search for {activeTab === 'player' ? 'players' : 'settlements'}
				</p>
			{/if}
		</div>

		<!-- Close Button -->
		<div class="mt-6 flex justify-end">
			<button
				type="button"
				onclick={onClose}
				class="rounded-lg px-4 py-2 text-gray-400 hover:bg-gray-700 hover:text-white"
			>
				Close
			</button>
		</div>
	</div>
</div>
