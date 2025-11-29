<script lang="ts">
	import { page } from '$app/state';

	interface NavItem {
		href: string;
		label: string;
		icon: string;
	}

	const navItems: NavItem[] = [
		{ href: '/', label: 'Home', icon: '🏠' },
		{ href: '/items', label: 'Items', icon: '📦' },
		{ href: '/lists', label: 'Crafting Lists', icon: '📋' },
		{ href: '/inventory', label: 'Inventory', icon: '🏪' },
		{ href: '/settings', label: 'Settings', icon: '⚙️' }
	];

	let { collapsed = false }: { collapsed?: boolean } = $props();

	function isActive(href: string): boolean {
		if (href === '/') {
			return page.url.pathname === '/';
		}
		return page.url.pathname.startsWith(href);
	}
</script>

<aside class="flex h-full flex-col bg-gray-900 text-white transition-all duration-200 {collapsed ? 'w-16' : 'w-56'}">
	<div class="flex h-16 items-center justify-center border-b border-gray-700 px-4">
		{#if collapsed}
			<span class="text-xl font-bold">BH</span>
		{:else}
			<span class="text-xl font-bold">BitHelper</span>
		{/if}
	</div>

	<nav class="flex-1 py-4">
		<ul class="space-y-1 px-2">
			{#each navItems as item}
				<li>
					<a
						href={item.href}
						class="flex items-center gap-3 rounded-lg px-3 py-2 transition-colors
                           {isActive(item.href)
							? 'bg-blue-600 text-white'
							: 'text-gray-300 hover:bg-gray-800 hover:text-white'}"
					>
						<span class="text-lg">{item.icon}</span>
						{#if !collapsed}
							<span>{item.label}</span>
						{/if}
					</a>
				</li>
			{/each}
		</ul>
	</nav>

	<div class="border-t border-gray-700 p-4">
		{#if !collapsed}
			<p class="text-xs text-gray-500">Powered by Bitjita API</p>
		{/if}
	</div>
</aside>
