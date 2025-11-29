<script lang="ts">
	import type { RootItemContribution } from '$lib/types/app';

	interface Props {
		contributions: RootItemContribution[];
		children: import('svelte').Snippet;
	}

	let { contributions, children }: Props = $props();
	let showPopover = $state(false);
	let triggerEl = $state<HTMLElement | null>(null);
	let popoverStyle = $state('');

	function updatePosition() {
		if (!triggerEl) return;
		const rect = triggerEl.getBoundingClientRect();
		const popoverWidth = 256;

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

	function handleMouseEnter() {
		if (contributions.length > 0) {
			updatePosition();
			showPopover = true;
		}
	}

	function handleMouseLeave() {
		showPopover = false;
	}

	const total = $derived(contributions.reduce((sum, c) => sum + c.contribution, 0));
</script>

<span
	bind:this={triggerEl}
	onmouseenter={handleMouseEnter}
	onmouseleave={handleMouseLeave}
	role="tooltip"
	class="inline-block cursor-help"
>
	{@render children()}
</span>

{#if showPopover}
	<div
		class="fixed z-[9999] w-64 rounded-lg bg-gray-900 border border-yellow-600 shadow-xl p-3"
		style={popoverStyle}
	>
		<div class="text-xs text-yellow-400 mb-2 font-medium flex items-center gap-1">
			<span>🔧</span> DEV: Requirement Sources
		</div>
		<div class="space-y-1.5">
			{#each contributions as contrib (contrib.rootItemId + '-' + contrib.contribution)}
				<div class="flex items-center justify-between text-sm">
					<span class="text-gray-300 truncate mr-2" title="{contrib.rootItemName} x{contrib.quantity}">
						{contrib.rootItemName} <span class="text-gray-500">x{contrib.quantity}</span>
					</span>
					<span class="text-blue-400 font-medium flex-shrink-0">+{contrib.contribution}</span>
				</div>
			{/each}
		</div>
		{#if contributions.length > 1}
			<div class="mt-2 pt-2 border-t border-gray-700 flex justify-between text-sm">
				<span class="text-gray-400">Total</span>
				<span class="text-white font-medium">{total}</span>
			</div>
		{/if}
	</div>
{/if}
