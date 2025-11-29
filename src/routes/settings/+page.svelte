<script lang="ts">
	import { settings, setPlayer, setAccessibleClaims, setAutoRefresh, resetSettings } from '$lib/state/settings.svelte';
	import { refreshGameData, gameData } from '$lib/state/game-data.svelte';
	import { syncAllInventories, inventory } from '$lib/state/inventory.svelte';
	import { fetchPlayerAccessibleClaims, searchPlayers } from '$lib/services/api/inventory';
	import { clearAllCache } from '$lib/services/cache';
	import type { AccessibleClaim } from '$lib/types/app';

	let isRefreshing = $state(false);
	let isRefreshingClaims = $state(false);
	let isSyncing = $state(false);

	// Player search
	let playerQuery = $state(settings.playerName || settings.playerId || '');
	let playerResults = $state<Array<{ entityId: string; username: string }>>([]);
	let isSearching = $state(false);
	let showResults = $state(false);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	async function handleSearch() {
		if (playerQuery.length < 3) {
			playerResults = [];
			showResults = false;
			return;
		}

		isSearching = true;
		try {
			playerResults = await searchPlayers(playerQuery);
			showResults = playerResults.length > 0;
		} catch (e) {
			console.error('Failed to search players:', e);
			playerResults = [];
		} finally {
			isSearching = false;
		}
	}

	function debouncedSearch() {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(handleSearch, 300);
	}

	async function selectPlayer(player: { entityId: string; username: string }) {
		playerQuery = player.username;
		showResults = false;
		isRefreshingClaims = true;

		try {
			const claims = await fetchPlayerAccessibleClaims(player.entityId);
			const accessibleClaims: AccessibleClaim[] = claims.map(c => ({
				entityId: c.entityId,
				name: c.name,
				tier: c.tier
			}));

			setPlayer(player.entityId, player.username);
			setAccessibleClaims(accessibleClaims);
		} catch (e) {
			console.error('Failed to fetch player claims:', e);
			setPlayer(player.entityId, player.username);
		} finally {
			isRefreshingClaims = false;
		}
	}

	async function handleRefreshClaims() {
		if (!settings.playerId) return;

		isRefreshingClaims = true;
		try {
			const claims = await fetchPlayerAccessibleClaims(settings.playerId);
			const accessibleClaims: AccessibleClaim[] = claims.map(c => ({
				entityId: c.entityId,
				name: c.name,
				tier: c.tier
			}));
			setAccessibleClaims(accessibleClaims);
		} catch (e) {
			console.error('Failed to refresh claims:', e);
		} finally {
			isRefreshingClaims = false;
		}
	}

	async function handleSyncInventory() {
		isSyncing = true;
		try {
			await syncAllInventories();
		} catch (e) {
			console.error('Failed to sync inventory:', e);
		} finally {
			isSyncing = false;
		}
	}

	async function handleRefreshData() {
		isRefreshing = true;
		try {
			await clearAllCache();
			await refreshGameData();
		} catch (e) {
			console.error('Failed to refresh data:', e);
		} finally {
			isRefreshing = false;
		}
	}

	function handleReset() {
		if (confirm('Are you sure you want to reset all settings? This will clear your Player ID and all data.')) {
			resetSettings();
			playerQuery = '';
		}
	}

	function formatLastSync(): string {
		if (!settings.inventoryLastSync) return 'Never';
		return new Date(settings.inventoryLastSync).toLocaleString();
	}
</script>

<div class="mx-auto max-w-2xl space-y-6">
	<!-- Player Configuration -->
	<div class="rounded-lg bg-gray-700 p-6 shadow">
		<h2 class="mb-4 text-lg font-semibold text-white">Player Configuration</h2>

		<div class="space-y-4">
			<div class="relative">
				<label for="player-search" class="block text-sm font-medium text-gray-300">
					Player Name
				</label>
				<div class="mt-1 flex gap-2">
					<div class="relative flex-1">
						<input
							id="player-search"
							type="text"
							bind:value={playerQuery}
							oninput={debouncedSearch}
							onfocus={() => { if (playerResults.length > 0) showResults = true; }}
							onblur={() => setTimeout(() => { showResults = false; }, 200)}
							placeholder="Search for your player..."
							autocomplete="off"
							class="w-full rounded-lg border border-gray-600 bg-gray-800 px-4 py-2 text-white placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
						/>
						{#if isSearching}
							<div class="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
								<div class="h-4 w-4 animate-spin rounded-full border-2 border-blue-400 border-t-transparent"></div>
							</div>
						{/if}

						{#if showResults && playerResults.length > 0}
							<ul class="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-lg border border-gray-600 bg-gray-700 shadow-lg">
								{#each playerResults as player (player.entityId)}
									<li>
										<button
											type="button"
											class="w-full px-4 py-2 text-left hover:bg-gray-600"
											onmousedown={() => selectPlayer(player)}
										>
											<span class="font-medium text-white">{player.username}</span>
											<span class="ml-2 text-sm text-gray-400">({player.entityId})</span>
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				</div>
			</div>

			{#if settings.playerId}
				<div class="rounded-lg bg-green-900/50 p-3 text-sm text-green-300">
					<div class="flex items-center justify-between">
						<div>
							<span class="font-medium">{settings.playerName || 'Player'}</span>
							<span class="ml-2 text-green-400/70">({settings.playerId})</span>
						</div>
					</div>
				</div>
			{/if}
		</div>
	</div>

	<!-- Accessible Claims -->
	<div class="rounded-lg bg-gray-700 p-6 shadow">
		<div class="mb-4 flex items-center justify-between">
			<h2 class="text-lg font-semibold text-white">Accessible Claims</h2>
			<button
				onclick={handleRefreshClaims}
				disabled={!settings.playerId || isRefreshingClaims}
				class="rounded-lg bg-gray-600 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-500 disabled:opacity-50"
			>
				{#if isRefreshingClaims}
					<span class="flex items-center gap-2">
						<span class="h-3 w-3 animate-spin rounded-full border-2 border-gray-400 border-t-transparent"></span>
						Refreshing...
					</span>
				{:else}
					Refresh Claims
				{/if}
			</button>
		</div>

		{#if settings.accessibleClaims.length > 0}
			<div class="space-y-2">
				{#each settings.accessibleClaims as claim (claim.entityId)}
					<div class="flex items-center justify-between rounded-lg border border-gray-600 p-3">
						<div>
							<span class="font-medium text-white">{claim.name}</span>
							<span class="ml-2 rounded bg-gray-600 px-2 py-0.5 text-xs text-gray-300">T{claim.tier}</span>
						</div>
						<code class="text-xs text-gray-400">{claim.entityId}</code>
					</div>
				{/each}
			</div>
		{:else}
			<p class="text-sm text-gray-400">
				{#if settings.playerId}
					No claims with inventory access found for this player.
				{:else}
					Set your player to see accessible claims.
				{/if}
			</p>
		{/if}
	</div>

	<!-- Inventory Settings -->
	<div class="rounded-lg bg-gray-700 p-6 shadow">
		<h2 class="mb-4 text-lg font-semibold text-white">Inventory Settings</h2>

		<div class="space-y-4">
			<div class="flex items-center justify-between rounded-lg border border-gray-600 p-4">
				<div>
					<p class="font-medium text-white">Inventory Sources</p>
					<p class="text-sm text-gray-400">
						{inventory.sources.length} sources loaded
					</p>
					<p class="text-xs text-gray-500">Last sync: {formatLastSync()}</p>
				</div>
				<button
					onclick={handleSyncInventory}
					disabled={isSyncing || !settings.playerId}
					class="rounded-lg bg-gray-600 px-4 py-2 text-white hover:bg-gray-500 disabled:opacity-50"
				>
					{#if isSyncing}
						Syncing...
					{:else}
						Sync Now
					{/if}
				</button>
			</div>

			<div>
				<label for="auto-refresh" class="block text-sm font-medium text-gray-300">
					Auto-refresh Interval
				</label>
				<select
					id="auto-refresh"
					value={settings.autoRefreshMinutes}
					onchange={(e) => setAutoRefresh(parseInt(e.currentTarget.value))}
					class="mt-1 w-full rounded-lg border border-gray-600 bg-gray-800 px-4 py-2 text-white focus:border-blue-500 focus:outline-none"
				>
					<option value="0">Disabled</option>
					<option value="5">5 minutes</option>
					<option value="10">10 minutes</option>
					<option value="15">15 minutes</option>
					<option value="30">30 minutes</option>
				</select>
				<p class="mt-1 text-xs text-gray-400">
					Automatically sync inventory when entering a list if data is older than this.
				</p>
			</div>
		</div>
	</div>

	<!-- Data Management -->
	<div class="rounded-lg bg-gray-700 p-6 shadow">
		<h2 class="mb-4 text-lg font-semibold text-white">Data Management</h2>

		<div class="space-y-4">
			<div class="flex items-center justify-between rounded-lg border border-gray-600 p-4">
				<div>
					<p class="font-medium text-white">Game Data Cache</p>
					<p class="text-sm text-gray-400">
						{gameData.items.size} items, {gameData.recipes.size} recipe groups
					</p>
				</div>
				<button
					onclick={handleRefreshData}
					disabled={isRefreshing}
					class="rounded-lg bg-gray-600 px-4 py-2 text-white hover:bg-gray-500 disabled:opacity-50"
				>
					{#if isRefreshing}
						Refreshing...
					{:else}
						Refresh Data
					{/if}
				</button>
			</div>

			<div class="rounded-lg border border-red-800 bg-red-900/30 p-4">
				<p class="font-medium text-red-300">Danger Zone</p>
				<p class="mt-1 text-sm text-red-400">Reset all settings and clear cached data.</p>
				<button
					onclick={handleReset}
					class="mt-3 rounded-lg bg-red-600 px-4 py-2 text-white hover:bg-red-700"
				>
					Reset All Settings
				</button>
			</div>
		</div>
	</div>
</div>
