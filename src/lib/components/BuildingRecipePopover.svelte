<script lang="ts">
	import { getItemById, getCargoById, getBuildingDescriptionById } from '$lib/state/game-data.svelte';
	import { getItemIconUrl } from '$lib/utils/icons';
	import type { ConstructionRecipe } from '$lib/types/game';

	interface Props {
		recipe: ConstructionRecipe;
		children: import('svelte').Snippet;
	}

	let { recipe, children }: Props = $props();

	let showPopover = $state(false);
	let triggerEl = $state<HTMLDivElement | null>(null);
	let popoverStyle = $state('');

	// Get building description for display
	const building = $derived(getBuildingDescriptionById(recipe.buildingDescriptionId));

	// Check if this recipe has ingredients
	const hasIngredients = $derived(
		recipe.consumedItemStacks.length > 0 || recipe.consumedCargoStacks.length > 0
	);

	// Get consumed building info (for upgrades)
	const consumedBuilding = $derived(
		recipe.consumedBuilding ? getBuildingDescriptionById(recipe.consumedBuilding) : null
	);

	function updatePosition() {
		if (!triggerEl) return;
		const rect = triggerEl.getBoundingClientRect();
		const popoverWidth = 256; // w-64 = 16rem = 256px

		// Position above the element, aligned to left
		let left = rect.left;
		let top = rect.top - 8; // 8px gap

		// Ensure popover doesn't go off-screen to the right
		if (left + popoverWidth > window.innerWidth - 16) {
			left = window.innerWidth - popoverWidth - 16;
		}

		// Ensure popover doesn't go off-screen to the left
		if (left < 16) {
			left = 16;
		}

		popoverStyle = `left: ${left}px; bottom: ${window.innerHeight - top}px;`;
	}

	function handleMouseEnter() {
		if (hasIngredients || consumedBuilding) {
			updatePosition();
			showPopover = true;
		}
	}

	function handleMouseLeave() {
		showPopover = false;
	}
</script>

<div
	bind:this={triggerEl}
	onmouseenter={handleMouseEnter}
	onmouseleave={handleMouseLeave}
	role="button"
	tabindex="-1"
	class="flex-1 min-w-0"
>
	{@render children()}
</div>

{#if showPopover}
	<div
		class="fixed z-[9999] w-64 rounded-lg bg-gray-900 border border-gray-600 shadow-xl p-3"
		style={popoverStyle}
	>
		<!-- Header -->
		<div class="text-xs text-gray-400 mb-2">
			<div class="flex items-center justify-between">
				<span class="text-purple-400">Construction Recipe</span>
			</div>
		</div>

		<!-- Consumed Building (for upgrades) -->
		{#if consumedBuilding}
			<div class="mb-2 pb-2 border-b border-gray-700">
				<div class="text-xs text-gray-500 mb-1">Requires Building:</div>
				<div class="flex items-center gap-2">
					<div class="flex h-6 w-6 flex-shrink-0 items-center justify-center bg-gray-800 rounded">
						{#if consumedBuilding.iconAssetName}
							<img src={getItemIconUrl(consumedBuilding.iconAssetName)} alt="" class="h-5 w-5 object-contain" />
						{:else}
							<span class="text-xs text-gray-500">?</span>
						{/if}
					</div>
					<span class="text-sm text-purple-300 truncate flex-1">
						{consumedBuilding.name}
					</span>
				</div>
			</div>
		{/if}

		<!-- Item Ingredients -->
		{#if recipe.consumedItemStacks.length > 0 || recipe.consumedCargoStacks.length > 0}
			<div class="space-y-1.5">
				{#each recipe.consumedItemStacks as ingredient (ingredient.itemId)}
					{@const ingredientItem = getItemById(ingredient.itemId)}
					{@const ingredientIcon = ingredientItem ? getItemIconUrl(ingredientItem.iconAssetName) : null}
					<div class="flex items-center gap-2">
						<div class="flex h-6 w-6 flex-shrink-0 items-center justify-center bg-gray-800 rounded">
							{#if ingredientIcon}
								<img src={ingredientIcon} alt="" class="h-5 w-5 object-contain" />
							{:else}
								<span class="text-xs text-gray-500">?</span>
							{/if}
						</div>
						<span class="text-sm text-gray-300 truncate flex-1">
							{ingredientItem?.name || `Item #${ingredient.itemId}`}
						</span>
						<span class="text-sm text-blue-400 font-medium">x{ingredient.quantity}</span>
					</div>
				{/each}
				{#each recipe.consumedCargoStacks as cargoIng (cargoIng.cargoId)}
					{@const cargo = getCargoById(cargoIng.cargoId)}
					{@const cargoIcon = cargo ? getItemIconUrl(cargo.iconAssetName) : null}
					<div class="flex items-center gap-2">
						<div class="flex h-6 w-6 flex-shrink-0 items-center justify-center bg-gray-800 rounded">
							{#if cargoIcon}
								<img src={cargoIcon} alt="" class="h-5 w-5 object-contain" />
							{:else}
								<span class="text-xs text-gray-500">?</span>
							{/if}
						</div>
						<span class="text-sm text-gray-300 truncate flex-1">
							{cargo?.name || `Cargo #${cargoIng.cargoId}`}
						</span>
						<span class="text-sm text-amber-400 font-medium">x{cargoIng.quantity}</span>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}
