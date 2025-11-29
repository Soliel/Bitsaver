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
	<title>Bitsaver - Bitcraft Crafting Calculator & Material Planner</title>
	<meta name="description" content="Plan your Bitcraft crafting efficiently. Calculate materials, track inventory across claims, and optimize your crafting lists with Bitsaver - the essential Bitcraft companion tool." />
	<meta name="keywords" content="Bitcraft, crafting calculator, material planner, inventory tracker, Bitcraft tools, Bitcraft helper, crafting list" />

	<!-- Open Graph / Facebook -->
	<meta property="og:type" content="website" />
	<meta property="og:title" content="Bitsaver - Bitcraft Crafting Calculator" />
	<meta property="og:description" content="Plan your Bitcraft crafting efficiently. Calculate materials, track inventory, and optimize your crafting lists." />

	<!-- Twitter -->
	<meta name="twitter:card" content="summary" />
	<meta name="twitter:title" content="Bitsaver - Bitcraft Crafting Calculator" />
	<meta name="twitter:description" content="Plan your Bitcraft crafting efficiently. Calculate materials, track inventory, and optimize your crafting lists." />
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
