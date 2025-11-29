<script lang="ts">
	import { settings, setPlayer, setAccessibleClaims } from '$lib/state/settings.svelte';
	import { searchPlayers, fetchPlayerAccessibleClaims } from '$lib/services/api/inventory';
	import type { AccessibleClaim } from '$lib/types/app';

	let query = $state('');
	let results = $state<Array<{ entityId: string; username: string }>>([]);
	let isSearching = $state(false);
	let isLoadingClaims = $state(false);
	let showResults = $state(false);
	let selectedIndex = $state(-1);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	async function handleSearch() {
		if (query.length < 3) {
			results = [];
			showResults = false;
			return;
		}

		isSearching = true;
		try {
			results = await searchPlayers(query);
			showResults = results.length > 0;
			selectedIndex = -1;
		} catch (e) {
			console.error('Failed to search players:', e);
			results = [];
		} finally {
			isSearching = false;
		}
	}

	function debouncedSearch() {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(handleSearch, 300);
	}

	async function selectPlayer(player: { entityId: string; username: string }) {
		query = player.username;
		showResults = false;
		isLoadingClaims = true;

		try {
			// Fetch accessible claims for the player
			const claims = await fetchPlayerAccessibleClaims(player.entityId);
			const accessibleClaims: AccessibleClaim[] = claims.map(c => ({
				entityId: c.entityId,
				name: c.name,
				tier: c.tier
			}));

			// Set player info and claims
			setPlayer(player.entityId, player.username);
			setAccessibleClaims(accessibleClaims);
		} catch (e) {
			console.error('Failed to fetch player claims:', e);
			// Still set the player even if claims fetch fails
			setPlayer(player.entityId, player.username);
		} finally {
			isLoadingClaims = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!showResults || results.length === 0) return;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, results.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
		} else if (e.key === 'Enter' && selectedIndex >= 0) {
			e.preventDefault();
			selectPlayer(results[selectedIndex]);
		} else if (e.key === 'Escape') {
			showResults = false;
		}
	}

	async function handleManualSubmit() {
		if (query.trim()) {
			isLoadingClaims = true;
			const playerId = query.trim();

			try {
				// Try to fetch claims for the ID
				const claims = await fetchPlayerAccessibleClaims(playerId);
				const accessibleClaims: AccessibleClaim[] = claims.map(c => ({
					entityId: c.entityId,
					name: c.name,
					tier: c.tier
				}));

				setPlayer(playerId);
				setAccessibleClaims(accessibleClaims);
			} catch (e) {
				console.error('Failed to fetch player claims:', e);
				setPlayer(playerId);
			} finally {
				isLoadingClaims = false;
			}
		}
	}
</script>

<div class="mx-auto max-w-md">
	<div class="rounded-xl bg-gray-800 p-8 shadow-lg">
		<div class="mb-6 text-center">
			<div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-blue-900">
				<svg class="h-8 w-8 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
				</svg>
			</div>
			<h2 class="text-xl font-semibold text-white">Welcome to Bithelper</h2>
			<p class="mt-2 text-gray-400">Enter your Bitcraft player name to get started</p>
		</div>

		<div class="relative">
			<label for="player-search" class="block text-sm font-medium text-gray-300">
				Player Name or ID
			</label>
			<div class="relative mt-1">
				<input
					id="player-search"
					type="text"
					bind:value={query}
					oninput={debouncedSearch}
					onkeydown={handleKeydown}
					onfocus={() => { if (results.length > 0) showResults = true; }}
					onblur={() => setTimeout(() => { showResults = false; }, 200)}
					placeholder="Search for your player..."
					autocomplete="off"
					class="w-full rounded-lg border border-gray-600 bg-gray-700 px-4 py-3 pr-10 text-white placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
				/>
				{#if isSearching}
					<div class="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
						<div class="h-5 w-5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent"></div>
					</div>
				{/if}
			</div>

			{#if showResults && results.length > 0}
				<ul class="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-gray-600 bg-gray-700 shadow-lg">
					{#each results as player, i (player.entityId)}
						<li>
							<button
								type="button"
								class="w-full px-4 py-3 text-left hover:bg-gray-600 {selectedIndex === i ? 'bg-gray-600' : ''}"
								onmousedown={() => selectPlayer(player)}
							>
								<span class="font-medium text-white">{player.username}</span>
								<span class="ml-2 text-sm text-gray-400">({player.entityId})</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}

			{#if query.length > 0 && query.length < 3}
				<p class="mt-2 text-sm text-gray-400">Type at least 3 characters to search</p>
			{/if}
		</div>

		<div class="mt-6">
			<button
				onclick={handleManualSubmit}
				disabled={!query.trim() || isLoadingClaims}
				class="w-full rounded-lg bg-blue-600 px-4 py-3 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
			>
				{#if isLoadingClaims}
					<span class="flex items-center justify-center gap-2">
						<span class="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"></span>
						Loading...
					</span>
				{:else}
					Continue
				{/if}
			</button>
		</div>

		<p class="mt-4 text-center text-sm text-gray-500">
			You can also enter a player entity ID directly if you know it
		</p>
	</div>
</div>
