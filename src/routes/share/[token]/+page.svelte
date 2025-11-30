<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		importSharedList,
		calculateRequirementsFromEntries,
		type SharedListData
	} from '$lib/state/crafting.svelte';
	import {
		gameData,
		getItemById,
		getCargoById,
		getConstructionRecipeById,
		getBuildingDescriptionById
	} from '$lib/state/game-data.svelte';
	import { getItemIconUrl } from '$lib/utils/icons';
	import type { FlatMaterial } from '$lib/types/game';

	interface PageData {
		list: SharedListData;
		name: string;
		entryCount: number;
		expiresAt: string;
		createdAt: string;
	}

	let { data }: { data: PageData } = $props();

	// State
	let isImporting = $state(false);
	let importError = $state<string | null>(null);
	let requirements = $state<FlatMaterial[]>([]);
	let isCalculating = $state(true);

	// Calculate expiry info
	const expiresIn = $derived(() => {
		const now = new Date();
		const expires = new Date(data.expiresAt);
		const diff = expires.getTime() - now.getTime();
		const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
		if (days <= 0) return 'Expired';
		if (days === 1) return 'Expires tomorrow';
		return `Expires in ${days} days`;
	});

	// Get entry display info
	function getEntryDisplay(entry: SharedListData['entries'][0]) {
		if (entry.type === 'item') {
			const item = getItemById(entry.itemId!);
			return {
				name: item?.name ?? `Item #${entry.itemId}`,
				iconUrl: item?.iconAssetName ? getItemIconUrl(item.iconAssetName) : null,
				type: 'Item'
			};
		} else if (entry.type === 'cargo') {
			const cargo = getCargoById(entry.cargoId!);
			return {
				name: cargo?.name ?? `Cargo #${entry.cargoId}`,
				iconUrl: cargo?.iconAssetName ? getItemIconUrl(cargo.iconAssetName) : null,
				type: 'Cargo'
			};
		} else {
			const recipe = getConstructionRecipeById(entry.constructionRecipeId!);
			const building = recipe ? getBuildingDescriptionById(recipe.buildingDescriptionId) : null;
			return {
				name: building?.name ?? recipe?.name ?? `Building #${entry.constructionRecipeId}`,
				iconUrl: building?.iconAssetName ? getItemIconUrl(building.iconAssetName) : null,
				type: 'Building'
			};
		}
	}

	// Calculate material requirements once game data loads
	$effect(() => {
		if (!gameData.isLoading && data.list.entries.length > 0) {
			calculateRequirements();
		}
	});

	async function calculateRequirements() {
		isCalculating = true;
		try {
			requirements = await calculateRequirementsFromEntries(data.list.entries);
		} catch (e) {
			console.error('Failed to calculate requirements:', e);
			requirements = [];
		} finally {
			isCalculating = false;
		}
	}

	async function handleImport() {
		isImporting = true;
		importError = null;

		try {
			const imported = await importSharedList(data.list);
			goto(`/lists/${imported.id}`);
		} catch (e) {
			importError = e instanceof Error ? e.message : 'Failed to import list';
			isImporting = false;
		}
	}

	function formatQty(n: number): string {
		if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
		if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
		return n.toString();
	}

	function getMaterialName(mat: FlatMaterial): string {
		if (mat.nodeType === 'cargo') {
			return mat.cargo?.name ?? `Cargo #${mat.cargoId}`;
		}
		if (mat.nodeType === 'building') {
			return mat.building?.name ?? `Building #${mat.buildingId}`;
		}
		return mat.item?.name ?? `Item #${mat.itemId}`;
	}

	function getMaterialIcon(mat: FlatMaterial): string | null {
		if (mat.nodeType === 'cargo' && mat.cargo?.iconAssetName) {
			return getItemIconUrl(mat.cargo.iconAssetName);
		}
		if (mat.nodeType === 'building' && mat.building?.iconAssetName) {
			return getItemIconUrl(mat.building.iconAssetName);
		}
		if (mat.item?.iconAssetName) {
			return getItemIconUrl(mat.item.iconAssetName);
		}
		return null;
	}
</script>

<svelte:head>
	<title>{data.name} - Shared List | BitHelper</title>
</svelte:head>

<div class="min-h-screen bg-gray-900 p-4 text-white">
	<div class="mx-auto max-w-4xl">
		<!-- Header -->
		<div class="mb-6 rounded-lg bg-gray-800 p-6">
			<div class="flex items-start justify-between gap-4">
				<div class="min-w-0 flex-1">
					<h1 class="text-2xl font-bold">{data.name}</h1>
					{#if data.list.description}
						<p class="mt-2 text-gray-400">{data.list.description}</p>
					{/if}
					<p class="mt-2 text-sm text-gray-500">
						{data.entryCount} {data.entryCount === 1 ? 'item' : 'items'} · {expiresIn()}
					</p>
				</div>
				<button
					onclick={handleImport}
					disabled={isImporting}
					class="flex-shrink-0 rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
				>
					{#if isImporting}
						<span class="flex items-center gap-2">
							<span class="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"></span>
							Importing...
						</span>
					{:else}
						Copy to My Lists
					{/if}
				</button>
			</div>

			{#if importError}
				<p class="mt-4 text-sm text-red-400">{importError}</p>
			{/if}
		</div>

		<!-- List Entries -->
		<div class="mb-6 rounded-lg bg-gray-800 p-4">
			<h2 class="mb-4 text-lg font-semibold text-gray-200">List Items</h2>

			{#if gameData.isLoading}
				<p class="text-gray-400">Loading game data...</p>
			{:else}
				<div class="space-y-2">
					{#each data.list.entries as entry}
						{@const display = getEntryDisplay(entry)}
						<div class="flex items-center gap-3 rounded-lg bg-gray-700/50 p-3">
							{#if display.iconUrl}
								<img src={display.iconUrl} alt="" class="h-8 w-8 rounded" />
							{:else}
								<div class="h-8 w-8 rounded bg-gray-600"></div>
							{/if}
							<div class="flex-1">
								<span class="font-medium">{display.name}</span>
								<span class="ml-2 text-xs text-gray-500">{display.type}</span>
							</div>
							<span class="text-gray-300">×{formatQty(entry.quantity)}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Material Requirements -->
		{#if !gameData.isLoading}
			<div class="rounded-lg bg-gray-800 p-4">
				<h2 class="mb-4 text-lg font-semibold text-gray-200">
					Materials Required
					<span class="ml-2 text-sm font-normal text-gray-500">(Import to track progress with your inventory)</span>
				</h2>

				{#if isCalculating}
					<div class="flex items-center gap-2 text-gray-400">
						<span class="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent"></span>
						Calculating requirements...
					</div>
				{:else if requirements.length === 0}
					<p class="text-gray-400">No craftable materials required.</p>
				{:else}
					<div class="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
						{#each requirements as mat}
							{@const iconUrl = getMaterialIcon(mat)}
							<div class="flex items-center gap-2 rounded bg-gray-700/50 p-2">
								{#if iconUrl}
									<img src={iconUrl} alt="" class="h-6 w-6 rounded" />
								{:else}
									<div class="h-6 w-6 rounded bg-gray-600"></div>
								{/if}
								<div class="min-w-0 flex-1">
									<div class="truncate text-sm">{getMaterialName(mat)}</div>
									<div class="text-xs text-gray-400">
										Step {mat.step} · {mat.profession}
									</div>
								</div>
								<span class="flex-shrink-0 text-sm text-gray-300">×{formatQty(mat.quantity)}</span>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}

		<!-- Back Link -->
		<div class="mt-6 text-center">
			<a href="/lists" class="text-gray-400 hover:text-white">
				← Browse your lists
			</a>
		</div>
	</div>
</div>
