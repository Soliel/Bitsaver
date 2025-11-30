<script lang="ts">
	import { crafting, createList, deleteList, setActiveList } from '$lib/state/crafting.svelte';

	let showCreateModal = $state(false);
	let newListName = $state('');
	let newListDescription = $state('');

	async function handleCreateList() {
		if (newListName.trim()) {
			const list = await createList(newListName.trim(), newListDescription.trim() || undefined);
			showCreateModal = false;
			newListName = '';
			newListDescription = '';
		}
	}

	function handleDeleteList(listId: string, listName: string) {
		if (confirm(`Are you sure you want to delete "${listName}"?`)) {
			deleteList(listId);
		}
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleDateString();
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h2 class="text-xl font-semibold text-white">Crafting Lists</h2>
			<p class="text-sm text-gray-400">
				Create and manage your crafting goals
			</p>
		</div>
		<button
			onclick={() => (showCreateModal = true)}
			class="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
		>
			+ New List
		</button>
	</div>

	<!-- Lists Grid -->
	{#if crafting.lists.length === 0}
		<div class="rounded-lg bg-gray-700 p-8 text-center shadow">
			<div class="text-4xl">📋</div>
			<h3 class="mt-4 font-semibold text-white">No Crafting Lists Yet</h3>
			<p class="mt-2 text-gray-400">
				Create your first crafting list to start tracking materials.
			</p>
			<button
				onclick={() => (showCreateModal = true)}
				class="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
			>
				Create Your First List
			</button>
		</div>
	{:else}
		<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
			{#each crafting.lists as list (list.id)}
				<div class="rounded-lg bg-gray-700 shadow">
					<div class="p-4">
						<div class="flex items-start justify-between">
							<div class="min-w-0 flex-1">
								<h3 class="truncate font-semibold text-white">{list.name}</h3>
								{#if list.description}
									<p class="mt-1 line-clamp-2 text-sm text-gray-400">{list.description}</p>
								{/if}
							</div>

							<!-- Dropdown menu -->
							<div class="relative">
								<button
									class="rounded p-1 text-gray-400 hover:bg-gray-600 hover:text-white"
									aria-label="List options"
									onclick={(e) => {
										const target = e.currentTarget as HTMLElement;
										const menu = target.nextElementSibling;
										if (menu) {
											menu.classList.toggle('hidden');
										}
									}}
								>
									<svg class="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
										<path
											d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z"
										/>
									</svg>
								</button>
								<div class="absolute right-0 z-10 mt-1 hidden w-32 rounded-lg bg-gray-800 shadow-lg">
									<button
										onclick={() => handleDeleteList(list.id, list.name)}
										class="block w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-gray-700"
									>
										Delete
									</button>
								</div>
							</div>
						</div>

						<div class="mt-4 flex items-center justify-between text-sm text-gray-400">
							<span>{list.entries.length} items</span>
							<span>Updated {formatDate(list.updatedAt)}</span>
						</div>
					</div>

					<div class="border-t border-gray-600 p-4">
						<a
							href="/lists/{list.id}"
							class="block w-full rounded-lg bg-gray-600 px-4 py-2 text-center font-medium text-white hover:bg-gray-500"
						>
							Open List
						</a>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<!-- Create List Modal -->
{#if showCreateModal}
	<div class="fixed inset-0 z-50 flex items-center justify-center p-4">
		<!-- Backdrop -->
		<button
			type="button"
			class="absolute inset-0 bg-black/70"
			onclick={() => (showCreateModal = false)}
			aria-label="Close modal"
		></button>

		<!-- Modal -->
		<div class="relative w-full max-w-md rounded-lg bg-gray-800 p-6 shadow-xl">
			<h3 class="text-lg font-semibold text-white">Create New List</h3>

			<form onsubmit={(e) => { e.preventDefault(); handleCreateList(); }} class="mt-4 space-y-4">
				<div>
					<label for="list-name" class="block text-sm font-medium text-gray-300">
						List Name
					</label>
					<input
						id="list-name"
						type="text"
						bind:value={newListName}
						placeholder="e.g., Iron Tools"
						required
						class="mt-1 w-full rounded-lg border border-gray-600 bg-gray-700 px-4 py-2 text-white placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
					/>
				</div>

				<div>
					<label for="list-description" class="block text-sm font-medium text-gray-300">
						Description (optional)
					</label>
					<textarea
						id="list-description"
						bind:value={newListDescription}
						placeholder="What are you crafting?"
						rows="3"
						class="mt-1 w-full rounded-lg border border-gray-600 bg-gray-700 px-4 py-2 text-white placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
					></textarea>
				</div>

				<div class="flex justify-end gap-3">
					<button
						type="button"
						onclick={() => (showCreateModal = false)}
						class="rounded-lg px-4 py-2 text-gray-400 hover:bg-gray-700 hover:text-white"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={!newListName.trim()}
						class="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
					>
						Create List
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
