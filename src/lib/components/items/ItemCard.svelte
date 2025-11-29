<script lang="ts">
	import type { Item } from '$lib/types/game';
	import { getItemIconUrl } from '$lib/utils/icons';

	interface Props {
		item: Item;
		onclick?: () => void;
		selected?: boolean;
	}

	let { item, onclick, selected = false }: Props = $props();

	let iconError = $state(false);

	// Tier colors (dark theme)
	const tierColors: Record<number, string> = {
		1: 'bg-gray-600 text-gray-200',
		2: 'bg-green-800 text-green-200',
		3: 'bg-blue-800 text-blue-200',
		4: 'bg-purple-800 text-purple-200',
		5: 'bg-orange-800 text-orange-200',
		6: 'bg-red-800 text-red-200',
		7: 'bg-pink-800 text-pink-200',
		8: 'bg-indigo-800 text-indigo-200',
		9: 'bg-yellow-800 text-yellow-200',
		10: 'bg-amber-800 text-amber-200'
	};

	const tierColor = tierColors[item.tier] || 'bg-gray-600 text-gray-200';
	const iconUrl = getItemIconUrl(item.iconAssetName);
</script>

<button
	type="button"
	{onclick}
	class="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-all hover:bg-gray-600 {selected
		? 'border-blue-500 bg-gray-600 ring-2 ring-blue-500'
		: 'border-gray-600'}"
>
	<!-- Item icon -->
	<div class="flex h-10 w-10 items-center justify-center rounded bg-gray-600">
		{#if iconUrl && !iconError}
			<img
				src={iconUrl}
				alt={item.name}
				class="h-8 w-8 object-contain"
				onerror={() => iconError = true}
			/>
		{:else}
			<span class="text-lg">📦</span>
		{/if}
	</div>

	<div class="min-w-0 flex-1">
		<p class="truncate font-medium text-white">{item.name}</p>
		<p class="text-xs text-gray-400">{item.tag || 'Unknown'}</p>
	</div>

	<span class="rounded px-2 py-1 text-xs font-medium {tierColor}">
		T{item.tier}
	</span>
</button>
