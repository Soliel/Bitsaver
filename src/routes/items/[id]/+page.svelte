<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { getItemWithRecipes, getItemById, gameData } from '$lib/state/game-data.svelte';
	import { getItemIconUrl } from '$lib/utils/icons';
	import type { ItemWithRecipes } from '$lib/types/game';

	const item = $derived.by(() => {
		const idParam = $page.params.id;
		if (!idParam) return undefined;
		const id = parseInt(idParam);
		if (isNaN(id)) return undefined;
		return getItemWithRecipes(id);
	});
</script>

<div class="space-y-6">
	{#if !item}
		<div class="rounded-lg bg-gray-700 p-8 text-center">
			<p class="text-xl text-gray-300">Item not found</p>
			<button
				onclick={() => goto('/items')}
				class="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
			>
				Back to Items
			</button>
		</div>
	{:else}
		<!-- Header -->
		<div class="rounded-lg bg-gray-700 p-6 shadow">
			<div class="flex items-start gap-6">
				<img
					src={getItemIconUrl(item.iconAssetName)}
					alt={item.name}
					class="h-24 w-24 rounded-lg bg-gray-800 object-contain p-2"
				/>
				<div class="flex-1">
					<h1 class="text-2xl font-bold text-white">{item.name}</h1>
					<p class="mt-2 text-gray-300">{item.description || 'No description available'}</p>
					<div class="mt-4 flex flex-wrap gap-4">
						<span class="rounded bg-gray-600 px-3 py-1 text-sm text-gray-200">
							Tier {item.tier}
						</span>
						<span class="rounded bg-gray-600 px-3 py-1 text-sm text-gray-200">
							{item.rarityStr || 'Common'}
						</span>
						<span class="rounded bg-gray-600 px-3 py-1 text-sm text-gray-200">
							{item.tag || 'Unknown'}
						</span>
						<span class="rounded bg-gray-600 px-3 py-1 font-mono text-sm text-gray-400">
							ID: {item.id}
						</span>
					</div>
				</div>
			</div>
		</div>

		<!-- Crafting Recipes -->
		{#if item.craftingRecipes.length > 0}
			<div class="rounded-lg bg-gray-700 p-6 shadow">
				<h2 class="mb-4 text-xl font-semibold text-white">Crafting Recipes</h2>
				<div class="space-y-4">
					{#each item.craftingRecipes as recipe (recipe.id)}
						<div class="rounded-lg bg-gray-800 p-4">
							<div class="flex items-center justify-between">
								<h3 class="font-medium text-white">{recipe.name}</h3>
								<span class="text-sm text-gray-400">
									Produces {recipe.outputQuantity}x
								</span>
							</div>

							{#if recipe.craftingStationName}
								<p class="mt-1 text-sm text-gray-400">
									Station: {recipe.craftingStationName}
									{#if recipe.craftingStationTier}
										(Tier {recipe.craftingStationTier})
									{/if}
								</p>
							{/if}

							{#if recipe.ingredients.length > 0}
								<div class="mt-3">
									<p class="text-sm text-gray-400">Ingredients:</p>
									<div class="mt-2 flex flex-wrap gap-2">
										{#each recipe.ingredients as ingredient (ingredient.itemId)}
											{@const ingredientItem = getItemById(ingredient.itemId)}
											<a
												href="/items/{ingredient.itemId}"
												class="flex items-center gap-2 rounded bg-gray-700 px-2 py-1 text-sm hover:bg-gray-600"
											>
												{#if ingredientItem}
													<img
														src={getItemIconUrl(ingredientItem.iconAssetName)}
														alt={ingredientItem.name}
														class="h-5 w-5"
													/>
													<span class="text-gray-200">{ingredient.quantity}x {ingredientItem.name}</span>
												{:else}
													<span class="text-gray-400">{ingredient.quantity}x Item #{ingredient.itemId}</span>
												{/if}
											</a>
										{/each}
									</div>
								</div>
							{/if}

							{#if recipe.levelRequirements.length > 0}
								<div class="mt-3">
									<p class="text-sm text-gray-400">Required Skills:</p>
									<div class="mt-1 flex flex-wrap gap-2">
										{#each recipe.levelRequirements as req (req.skillId)}
											<span class="rounded bg-gray-700 px-2 py-1 text-sm text-gray-300">
												{req.skillName} Lv.{req.level}
											</span>
										{/each}
									</div>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Extraction Recipes -->
		{#if item.extractionRecipes.length > 0}
			<div class="rounded-lg bg-gray-700 p-6 shadow">
				<h2 class="mb-4 text-xl font-semibold text-white">Extraction Recipes</h2>
				<div class="space-y-4">
					{#each item.extractionRecipes as recipe (recipe.id)}
						<div class="rounded-lg bg-gray-800 p-4">
							<div class="flex items-center justify-between">
								<h3 class="font-medium text-white">{recipe.name}</h3>
								<span class="text-sm text-gray-400">
									Produces {recipe.outputQuantity}x
								</span>
							</div>

							{#if recipe.toolRequirements.length > 0}
								<div class="mt-3">
									<p class="text-sm text-gray-400">Tool Requirements:</p>
									<div class="mt-1 flex flex-wrap gap-2">
										{#each recipe.toolRequirements as req (req.toolType)}
											<span class="rounded bg-gray-700 px-2 py-1 text-sm text-gray-300">
												{req.name} (Power {req.power})
											</span>
										{/each}
									</div>
								</div>
							{/if}

							{#if recipe.levelRequirements.length > 0}
								<div class="mt-3">
									<p class="text-sm text-gray-400">Required Skills:</p>
									<div class="mt-1 flex flex-wrap gap-2">
										{#each recipe.levelRequirements as req (req.skillId)}
											<span class="rounded bg-gray-700 px-2 py-1 text-sm text-gray-300">
												{req.skillName} Lv.{req.level}
											</span>
										{/each}
									</div>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Back Button -->
		<div>
			<button
				onclick={() => goto('/items')}
				class="rounded-lg bg-gray-600 px-4 py-2 text-white hover:bg-gray-500"
			>
				Back to Items
			</button>
		</div>
	{/if}
</div>
