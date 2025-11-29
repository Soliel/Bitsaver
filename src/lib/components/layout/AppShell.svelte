<script lang="ts">
	import Sidebar from './Sidebar.svelte';
	import Header from './Header.svelte';
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();

	let sidebarCollapsed = $state(false);
	let mobileMenuOpen = $state(false);

	function toggleSidebar() {
		if (window.innerWidth < 1024) {
			mobileMenuOpen = !mobileMenuOpen;
		} else {
			sidebarCollapsed = !sidebarCollapsed;
		}
	}
</script>

<div class="flex h-screen bg-gray-900">
	<!-- Desktop sidebar -->
	<div class="hidden lg:block">
		<Sidebar collapsed={sidebarCollapsed} />
	</div>

	<!-- Mobile sidebar overlay -->
	{#if mobileMenuOpen}
		<div class="fixed inset-0 z-40 lg:hidden">
			<!-- Backdrop -->
			<button
				class="fixed inset-0 bg-black/50"
				onclick={() => (mobileMenuOpen = false)}
				aria-label="Close menu"
			></button>

			<!-- Sidebar -->
			<div class="fixed inset-y-0 left-0 z-50 w-64">
				<Sidebar collapsed={false} />
			</div>
		</div>
	{/if}

	<!-- Main content area -->
	<div class="flex flex-1 flex-col overflow-hidden">
		<Header onToggleSidebar={toggleSidebar} />

		<main class="flex-1 overflow-auto bg-gray-800 p-6">
			{@render children()}
		</main>
	</div>
</div>
