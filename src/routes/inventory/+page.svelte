<script lang="ts">
	import {
		inventory,
		syncAllInventories,
		toggleSource,
		enableAllSources,
		disableAllSources,
		sourcesByType,
		aggregatedInventory
	} from '$lib/state/inventory.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { gameData, getItemById } from '$lib/state/game-data.svelte';

	// Group labels
	const typeLabels: Record<string, string> = {
		player: 'Player Inventory',
		bank: 'Banks',
		deployable: 'Deployables',
		claim_building: 'Claim Buildings'
	};

	// Calculate aggregated item count
	const totalItems = $derived(aggregatedInventory.size);
	const totalQuantity = $derived.by(() => {
		let total = 0;
		for (const item of aggregatedInventory.values()) {
			total += item.totalQuantity;
		}
		return total;
	});

	// Get sources by type reactively
	const getSourcesForType = (type: string) => sourcesByType.value.get(type as any) || [];
</script>

<div class="space-y-6">
	<!-- Status & Actions -->
	<div class="flex flex-wrap items-center justify-between gap-4 rounded-lg bg-gray-700 p-4 shadow">
		<div>
			<h2 class="font-semibold text-white">Inventory Sources</h2>
			<p class="text-sm text-gray-400">
				{inventory.sources.length} sources configured,
				{inventory.sources.filter((s) => s.enabled).length} enabled
			</p>
		</div>

		<div class="flex gap-2">
			<button
				onclick={syncAllInventories}
				disabled={inventory.isSyncing || (!settings.playerId && settings.accessibleClaims.length === 0)}
				class="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
			>
				{#if inventory.isSyncing}
					Syncing...
				{:else}
					Sync All
				{/if}
			</button>
			<button
				onclick={enableAllSources}
				class="rounded-lg bg-gray-100 px-4 py-2 text-gray-700 hover:bg-gray-200"
			>
				Enable All
			</button>
			<button
				onclick={disableAllSources}
				class="rounded-lg bg-gray-100 px-4 py-2 text-gray-700 hover:bg-gray-200"
			>
				Disable All
			</button>
		</div>
	</div>

	{#if !settings.playerId && settings.accessibleClaims.length === 0}
		<div class="rounded-lg border-2 border-dashed border-amber-600 bg-amber-900/30 p-6">
			<h3 class="font-semibold text-amber-300">No Sources Configured</h3>
			<p class="mt-2 text-amber-400">
				Configure your player in
				<a href="/settings" class="font-medium underline">Settings</a>
				to sync your inventory.
			</p>
		</div>
	{/if}

	{#if inventory.error}
		<div class="rounded-lg bg-red-900/50 p-4 text-red-300">
			<strong>Error:</strong>
			{inventory.error}
		</div>
	{/if}

	<!-- Source Groups -->
	<div class="grid gap-6 lg:grid-cols-2">
		{#each ['player', 'bank', 'deployable', 'claim_building'] as sourceType}
			{@const sources = getSourcesForType(sourceType)}
			{#if sources.length > 0}
				<div class="rounded-lg bg-gray-700 shadow">
					<div class="border-b border-gray-600 p-4">
						<h3 class="font-semibold text-white">{typeLabels[sourceType]}</h3>
						<p class="text-sm text-gray-400">{sources.length} sources</p>
					</div>

					<div class="divide-y divide-gray-600">
						{#each sources as source (source.id)}
							<label class="flex cursor-pointer items-center gap-3 p-4 hover:bg-gray-600">
								<input
									type="checkbox"
									checked={source.enabled}
									onchange={() => toggleSource(source.id)}
									class="h-4 w-4 rounded border-gray-500 bg-gray-800 text-blue-600 focus:ring-blue-500"
								/>
								<div class="min-w-0 flex-1">
									<p class="truncate font-medium text-white">
										{source.nickname || source.name}
									</p>
									{#if source.claimName}
										<p class="text-xs text-gray-400">{source.claimName}</p>
									{/if}
								</div>
								{#if source.lastSynced}
									<span class="text-xs text-gray-500">
										{new Date(source.lastSynced).toLocaleTimeString()}
									</span>
								{/if}
							</label>
						{/each}
					</div>
				</div>
			{/if}
		{/each}
	</div>

	{#if inventory.sources.length === 0 && (settings.playerId || settings.accessibleClaims.length > 0)}
		<div class="rounded-lg bg-gray-700 p-8 text-center shadow">
			<p class="text-gray-300">No sources found. Click "Sync All" to fetch your inventory.</p>
		</div>
	{/if}

	<!-- Aggregated Inventory Summary -->
	{#if totalItems > 0}
		<div class="rounded-lg bg-gray-700 p-6 shadow">
			<h3 class="mb-4 font-semibold text-white">Aggregated Inventory</h3>

			<div class="mb-4 flex gap-4 text-sm text-gray-300">
				<span><strong>{totalItems}</strong> unique items</span>
				<span><strong>{totalQuantity.toLocaleString()}</strong> total quantity</span>
			</div>

			<div class="max-h-96 overflow-auto">
				<table class="w-full">
					<thead class="sticky top-0 bg-gray-800">
						<tr>
							<th class="px-4 py-2 text-left text-sm font-medium text-gray-300">Item</th>
							<th class="px-4 py-2 text-right text-sm font-medium text-gray-300">Quantity</th>
							<th class="px-4 py-2 text-right text-sm font-medium text-gray-300">Sources</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-gray-600">
						{#each Array.from(aggregatedInventory.values()).slice(0, 50) as item (item.itemId)}
							{@const itemInfo = getItemById(item.itemId)}
							<tr class="hover:bg-gray-600">
								<td class="px-4 py-2">
									<span class="font-medium text-white">{itemInfo?.name || `Item #${item.itemId}`}</span>
								</td>
								<td class="px-4 py-2 text-right font-mono text-gray-300">
									{item.totalQuantity.toLocaleString()}
								</td>
								<td class="px-4 py-2 text-right text-sm text-gray-400">
									{item.sources.length} source{item.sources.length !== 1 ? 's' : ''}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
				{#if aggregatedInventory.size > 50}
					<p class="p-4 text-center text-sm text-gray-400">
						Showing 50 of {aggregatedInventory.size} items
					</p>
				{/if}
			</div>
		</div>
	{/if}
</div>
