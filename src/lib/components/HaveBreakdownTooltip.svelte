<script lang="ts">
	import { inventory, getAggregatedInventoryForSources, getAggregatedCargoForSources } from '$lib/state/inventory.svelte';
	import { getItemById } from '$lib/state/game-data.svelte';
	import { getItemIconUrl } from '$lib/utils/icons';
	import type { ParentContribution } from '$lib/types/app';

	interface Props {
		itemId?: number; // Optional - not present for cargo
		cargoId?: number; // Optional - for cargo items
		listSourceIds: string[]; // The list's enabled source IDs
		manualAmount: number | undefined; // Manual override if set
		isCheckedOff: boolean;
		parentContributions?: ParentContribution[]; // Coverage from parent items
		children: import('svelte').Snippet;
	}

	let { itemId, cargoId, listSourceIds, manualAmount, isCheckedOff, parentContributions, children }: Props = $props();

	let showPopover = $state(false);
	let isHovering = $state(false);
	let shiftHeld = $state(false);
	let triggerEl = $state<HTMLDivElement | null>(null);
	let popoverStyle = $state('');

	// Determine if this is for cargo or item
	const isCargo = $derived(cargoId !== undefined);

	// Get source breakdown for this item or cargo (aggregated by source)
	const breakdown = $derived.by(() => {
		// Aggregate by sourceId in case same source has multiple entries
		const bySource = new Map<string, { id: string; name: string; claimName?: string; quantity: number }>();

		if (cargoId !== undefined) {
			// Handle cargo
			const aggregated = getAggregatedCargoForSources(listSourceIds);
			const cargoAgg = aggregated.get(cargoId);
			if (!cargoAgg) return [];

			for (const source of cargoAgg.sources) {
				const sourceInfo = inventory.sources.find((s) => s.id === source.sourceId);
				const existing = bySource.get(source.sourceId);

				if (existing) {
					existing.quantity += source.quantity;
				} else {
					bySource.set(source.sourceId, {
						id: source.sourceId,
						name: sourceInfo?.nickname || sourceInfo?.name || source.sourceId,
						claimName: sourceInfo?.claimName,
						quantity: source.quantity
					});
				}
			}
		} else if (itemId !== undefined) {
			// Handle item
			const aggregated = getAggregatedInventoryForSources(listSourceIds);
			const itemAgg = aggregated.get(itemId);
			if (!itemAgg) return [];

			for (const source of itemAgg.sources) {
				const sourceInfo = inventory.sources.find((s) => s.id === source.sourceId);
				const existing = bySource.get(source.sourceId);

				if (existing) {
					existing.quantity += source.quantity;
				} else {
					bySource.set(source.sourceId, {
						id: source.sourceId,
						name: sourceInfo?.nickname || sourceInfo?.name || source.sourceId,
						claimName: sourceInfo?.claimName,
						quantity: source.quantity
					});
				}
			}
		}

		return Array.from(bySource.values()).filter(s => s.quantity > 0);
	});

	const totalFromInventory = $derived(breakdown.reduce((sum, s) => sum + s.quantity, 0));

	// Enrich parent contributions with item details
	const parentDetails = $derived.by(() => {
		if (!parentContributions || parentContributions.length === 0) return [];
		return parentContributions.map(c => {
			const item = getItemById(c.parentItemId);
			return {
				...c,
				name: item?.name || `Item #${c.parentItemId}`,
				iconUrl: item ? getItemIconUrl(item.iconAssetName) : null
			};
		});
	});

	const hasContent = $derived(
		breakdown.length > 0 || manualAmount !== undefined || isCheckedOff || parentDetails.length > 0
	);

	function updatePosition() {
		if (!triggerEl) return;
		const rect = triggerEl.getBoundingClientRect();
		const popoverWidth = 240;

		let left = rect.left;
		let top = rect.top - 8;

		// Ensure popover doesn't go off-screen
		if (left + popoverWidth > window.innerWidth - 16) {
			left = window.innerWidth - popoverWidth - 16;
		}
		if (left < 16) {
			left = 16;
		}

		popoverStyle = `left: ${left}px; bottom: ${window.innerHeight - top}px;`;
	}

	function updatePopoverVisibility() {
		// Show popover only when hovering AND shift is NOT held (in DEV, shift shows the other popover)
		if (hasContent && isHovering && !shiftHeld) {
			updatePosition();
			showPopover = true;
		} else {
			showPopover = false;
		}
	}

	function handleMouseEnter() {
		isHovering = true;
		updatePopoverVisibility();
	}

	function handleMouseLeave() {
		isHovering = false;
		showPopover = false;
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Shift') {
			shiftHeld = true;
			updatePopoverVisibility();
		}
	}

	function handleKeyUp(e: KeyboardEvent) {
		if (e.key === 'Shift') {
			shiftHeld = false;
			updatePopoverVisibility();
		}
	}
</script>

<svelte:window onkeydown={handleKeyDown} onkeyup={handleKeyUp} />

<div
	bind:this={triggerEl}
	onmouseenter={handleMouseEnter}
	onmouseleave={handleMouseLeave}
	role="tooltip"
	class="inline-block"
>
	{@render children()}
</div>

{#if showPopover && hasContent}
	<div
		class="fixed z-[9999] w-60 rounded-lg bg-gray-900 border border-gray-600 shadow-xl p-3"
		style={popoverStyle}
	>
		<div class="text-xs text-gray-400 mb-2 font-medium">{isCargo ? 'Cargo Sources' : 'Item Sources'}</div>

		{#if isCheckedOff}
			<div class="flex items-center gap-2 text-sm text-green-400 mb-2">
				<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
				</svg>
				Marked as complete
			</div>
		{/if}

		{#if manualAmount !== undefined}
			<div class="flex items-center justify-between text-sm mb-2">
				<span class="text-yellow-400">Manual override</span>
				<span class="text-yellow-400 font-medium">{manualAmount}</span>
			</div>
			{#if breakdown.length > 0}
				<div class="text-xs text-gray-500 mb-2">
					(Inventory shows {totalFromInventory})
				</div>
			{/if}
		{:else if breakdown.length > 0}
			<div class="space-y-1.5">
				{#each breakdown as source (source.id)}
					<div class="flex items-center justify-between text-sm">
						<span class="text-gray-300 truncate mr-2" title={source.claimName ? `${source.claimName} - ${source.name}` : source.name}>
							{source.name}
						</span>
						<span class="text-blue-400 font-medium flex-shrink-0">{source.quantity}</span>
					</div>
				{/each}
			</div>
			{#if breakdown.length > 1}
				<div class="mt-2 pt-2 border-t border-gray-700 flex items-center justify-between text-sm">
					<span class="text-gray-400">Total from inventory</span>
					<span class="text-white font-medium">{totalFromInventory}</span>
				</div>
			{/if}
		{:else if parentDetails.length === 0}
			<div class="text-sm text-gray-500">No inventory</div>
		{/if}

		{#if parentDetails.length > 0}
			<div class="mt-2 pt-2 border-t border-gray-700">
				<div class="text-xs text-gray-400 mb-1.5">Covered by intermediate crafts</div>
				<div class="space-y-1.5">
					{#each parentDetails as parent (parent.parentItemId)}
						<div class="flex items-center gap-2 text-sm">
							{#if parent.iconUrl}
								<img src={parent.iconUrl} alt="" class="h-4 w-4 object-contain flex-shrink-0" />
							{/if}
							<span class="text-purple-300 truncate flex-1" title={parent.name}>
								{parent.name}
							</span>
							<span class="text-gray-400 text-xs flex-shrink-0">
								(x{parent.parentQuantityUsed})
							</span>
							<span class="text-purple-400 font-medium flex-shrink-0">
								{parent.coverage}
							</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</div>
{/if}
