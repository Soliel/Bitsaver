<script lang="ts">
	import { getItemById, getCargoById, findRecipesForCargo } from '$lib/state/game-data.svelte';
	import { getItemIconUrl } from '$lib/utils/icons';

	interface Props {
		cargoId: number;
		children: import('svelte').Snippet;
	}

	let { cargoId, children }: Props = $props();

	let showPopover = $state(false);
	let triggerEl = $state<HTMLDivElement | null>(null);
	let popoverStyle = $state('');

	// Get all recipes that produce this cargo
	const allRecipes = $derived(findRecipesForCargo(cargoId));

	// Filter to valid recipes and sort by cost
	const recipes = $derived(
		allRecipes
			.filter(r => {
				const hasItemIngredients = r.ingredients.length > 0;
				const hasCargoIngredients = (r.cargoIngredients?.length ?? 0) > 0;
				if (!hasItemIngredients && !hasCargoIngredients) return false;
				if (hasItemIngredients && !r.ingredients.every(ing => getItemById(ing.itemId) !== undefined)) return false;
				return true;
			})
			.sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity))
	);
	const hasRecipe = $derived(recipes.length > 0);
	const recipe = $derived(recipes[0]); // Use cheapest recipe for display

	// Format cost for display
	function formatCost(cost: number | undefined): string {
		if (cost === undefined) return '';
		if (cost >= 1000000) return `${(cost / 1000000).toFixed(1)}M`;
		if (cost >= 1000) return `${(cost / 1000).toFixed(1)}K`;
		if (cost >= 10) return cost.toFixed(0);
		if (cost >= 1) return cost.toFixed(1);
		return cost.toFixed(2);
	}

	function updatePosition() {
		if (!triggerEl) return;
		const rect = triggerEl.getBoundingClientRect();
		const popoverWidth = 256; // w-64 = 16rem = 256px

		// Position above the element, aligned to left
		let left = rect.left;
		let top = rect.top - 8; // 8px gap (mb-2)

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
		if (hasRecipe) {
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

{#if showPopover && recipe}
	<div
		class="fixed z-[9999] w-64 rounded-lg bg-gray-900 border border-gray-600 shadow-xl p-3"
		style={popoverStyle}
	>
		<!-- Header -->
		<div class="text-xs text-gray-400 mb-2">
			<div class="flex items-center justify-between">
				<div>
					{#if recipe.craftingStationName}
						<span class="text-amber-400">{recipe.craftingStationName}</span>
						{#if recipe.craftingStationTier}
							<span class="text-gray-500"> T{recipe.craftingStationTier}</span>
						{/if}
					{:else}
						<span class="text-gray-500">Cargo Recipe</span>
					{/if}
					{#if recipe.outputQuantity > 1}
						<span class="text-gray-500 ml-1">(x{recipe.outputQuantity})</span>
					{/if}
				</div>
				{#if recipe.cost !== undefined}
					<span class="text-green-400 font-medium">{formatCost(recipe.cost)}</span>
				{/if}
			</div>
		</div>

		<!-- Ingredients -->
		<div class="space-y-1.5">
			{#each recipe.ingredients as ingredient (ingredient.itemId)}
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
			{#if recipe.cargoIngredients?.length}
				{#each recipe.cargoIngredients as cargoIng (cargoIng.cargoId)}
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
			{/if}
		</div>

		{#if recipes.length > 1}
			<div class="mt-2 pt-2 border-t border-gray-700 text-xs text-gray-500">
				+{recipes.length - 1} more recipe{recipes.length > 2 ? 's' : ''}
			</div>
		{/if}
	</div>
{/if}
