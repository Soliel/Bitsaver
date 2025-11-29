<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import AppShell from '$lib/components/layout/AppShell.svelte';
	import PlayerSetup from '$lib/components/onboarding/PlayerSetup.svelte';
	import { initializeGameData } from '$lib/state/game-data.svelte';
	import { initializeInventory } from '$lib/state/inventory.svelte';
	import { initializeCrafting } from '$lib/state/crafting.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { browser } from '$app/environment';

	let { children } = $props();

	// Initialize app data on mount
	if (browser) {
		$effect(() => {
			initializeGameData();
			initializeInventory();
			initializeCrafting();
		});
	}

	// Check if user needs onboarding
	const needsOnboarding = $derived(!settings.playerId);
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>BitSaver - Bitcraft Crafting Helper</title>
</svelte:head>

{#if needsOnboarding}
	<div class="flex min-h-screen items-center justify-center bg-gray-900 p-4">
		<PlayerSetup />
	</div>
{:else}
	<AppShell>
		{@render children()}
	</AppShell>
{/if}
