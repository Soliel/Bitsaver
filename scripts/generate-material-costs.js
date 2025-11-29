/**
 * Generate material_costs.json for pre-computed item costs and default recipes
 *
 * Bottom-up algorithm:
 * 1. Initialize: Build dependency graph, track pending ingredient counts
 * 2. Base costs: Items with no recipes get tier cost
 * 3. Extraction costs: Extracted items get tier * rarity cost
 * 4. Propagate upward: Only calculate items when ALL ingredients have costs
 * 5. Item lists: Process item list references
 * 6. Cycles: Handle circular dependencies with iterative convergence
 *
 * Run: node scripts/generate-material-costs.js
 */

import { readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GAME_DATA_DIR = join(__dirname, '../static/game_data');
const OUTPUT_PATH = join(GAME_DATA_DIR, 'material_costs.json');

// Cost calculation: 10^(tier - 1)
function tierToCost(tier) {
	const effectiveTier = tier === -1 ? 1 : tier;
	return Math.pow(10, effectiveTier - 1);
}

// Rarity multipliers for extraction costs
const RARITY_MULTIPLIER = {
	0: 1,   // Common
	1: 2,   // Uncommon
	2: 4,   // Rare
	3: 8,   // Epic
	4: 16,  // Legendary
	5: 32   // Mythic
};

// Minimum cost floor
const MIN_COST = 1;
const CONVERGENCE_THRESHOLD = 0.0001;

// Very high penalty for package/unpack recipes so they're never selected as defaults
const PACKAGE_UNPACK_PENALTY = 1e15;

// Check if a recipe is a package or unpack recipe by name
function isPackageOrUnpackRecipe(recipeName) {
	if (!recipeName) return false;
	return recipeName.includes('Package') || recipeName.includes('Unpack');
}

// Load and parse JSON file
async function loadJson(filename) {
	const filePath = join(GAME_DATA_DIR, filename);
	const content = await readFile(filePath, 'utf-8');
	return JSON.parse(content);
}

// Hash content for cache invalidation
function hashContent(content) {
	return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Tarjan's Strongly Connected Components Algorithm
 * Returns array of SCCs (each SCC is an array of item IDs)
 */
function findSCCs(graph) {
	const index = new Map();
	const lowlink = new Map();
	const onStack = new Set();
	const stack = [];
	const sccs = [];
	let currentIndex = 0;

	function strongConnect(node) {
		index.set(node, currentIndex);
		lowlink.set(node, currentIndex);
		currentIndex++;
		stack.push(node);
		onStack.add(node);

		const neighbors = graph.get(node) || [];
		for (const neighbor of neighbors) {
			if (!index.has(neighbor)) {
				strongConnect(neighbor);
				lowlink.set(node, Math.min(lowlink.get(node), lowlink.get(neighbor)));
			} else if (onStack.has(neighbor)) {
				lowlink.set(node, Math.min(lowlink.get(node), index.get(neighbor)));
			}
		}

		if (lowlink.get(node) === index.get(node)) {
			const scc = [];
			let w;
			do {
				w = stack.pop();
				onStack.delete(w);
				scc.push(w);
			} while (w !== node);
			sccs.push(scc);
		}
	}

	for (const node of graph.keys()) {
		if (!index.has(node)) {
			strongConnect(node);
		}
	}

	return sccs;
}

async function generateMaterialCosts() {
	console.log('Loading game data...');

	// Load all required data files
	const [items, resources, extractionRecipes, craftingRecipes, itemLists] = await Promise.all([
		loadJson('item_desc.json'),
		loadJson('resource_desc.json'),
		loadJson('extraction_recipe_desc.json'),
		loadJson('crafting_recipe_desc.json'),
		loadJson('item_list_desc.json')
	]);

	console.log(`  Loaded ${items.length} items`);
	console.log(`  Loaded ${resources.length} resources`);
	console.log(`  Loaded ${extractionRecipes.length} extraction recipes`);
	console.log(`  Loaded ${craftingRecipes.length} crafting recipes`);
	console.log(`  Loaded ${itemLists.length} item lists`);

	// Build lookup maps
	const itemMap = new Map(items.map((i) => [i.id, i]));
	const resourceMap = new Map(resources.map((r) => [r.id, r]));
	const itemListMap = new Map(itemLists.map((l) => [l.id, l]));

	// Build recipes by output item ID (only Item type outputs with Item type ingredients)
	const recipesByOutput = new Map();
	for (const recipe of craftingRecipes) {
		for (const output of recipe.crafted_item_stacks || []) {
			if (output.item_type === 'Item') {
				if (!recipesByOutput.has(output.item_id)) {
					recipesByOutput.set(output.item_id, []);
				}
				recipesByOutput.get(output.item_id).push({
					id: recipe.id,
					name: recipe.name,
					ingredients: (recipe.consumed_item_stacks || [])
						.filter((i) => i.item_type === 'Item')
						.map((i) => ({ itemId: i.item_id, quantity: i.quantity })),
					outputQuantity: output.quantity
				});
			}
		}
	}

	// Track which items have extraction recipes
	const hasExtraction = new Set();
	for (const recipe of extractionRecipes) {
		for (const stack of recipe.extracted_item_stacks || []) {
			if (stack.item_stack?.item_type === 'Item') {
				hasExtraction.add(stack.item_stack.item_id);
			}
		}
	}

	// ===== PHASE 1: Build dependency graph =====
	console.log('\nPhase 1: Building dependency graph...');

	// dependents: ingredientId -> Set of itemIds that use this ingredient
	const dependents = new Map();
	// dependsOn: itemId -> Set of ingredientIds it needs (for cycle detection)
	const dependsOn = new Map();
	// recipePendingCounts: recipeId -> number of ingredients without costs
	const recipePendingCounts = new Map();
	// itemRecipes: itemId -> Set of recipeIds that produce this item
	const itemRecipes = new Map();
	// recipeToItem: recipeId -> itemId it produces
	const recipeToItem = new Map();
	// itemInQueue: itemId -> boolean (to avoid duplicate queue entries)
	const itemInQueue = new Set();

	for (const [outputId, recipes] of recipesByOutput) {
		itemRecipes.set(outputId, new Set());
		const allIngredients = new Set();

		for (const recipe of recipes) {
			if (recipe.ingredients.length === 0) continue;

			itemRecipes.get(outputId).add(recipe.id);
			recipeToItem.set(recipe.id, outputId);
			recipePendingCounts.set(recipe.id, recipe.ingredients.length);

			for (const ing of recipe.ingredients) {
				allIngredients.add(ing.itemId);

				if (!dependents.has(ing.itemId)) {
					dependents.set(ing.itemId, new Set());
				}
				dependents.get(ing.itemId).add(recipe.id);
			}
		}

		if (allIngredients.size > 0) {
			dependsOn.set(outputId, allIngredients);
		}
	}

	console.log(`  ${dependsOn.size} items have crafting dependencies`);
	console.log(`  ${dependents.size} items are used as ingredients`);
	console.log(`  ${recipePendingCounts.size} recipes tracked`);

	// Cost tracking
	const costs = new Map();           // itemId -> cost
	const sources = new Map();         // itemId -> 'tier' | 'extraction' | 'crafting'
	const defaultRecipes = new Map();  // itemId -> recipeId
	const recipeCosts = new Map();     // recipeId -> cost
	const workQueue = [];              // Items ready to have their cost calculated

	// Initialize all costs to Infinity
	for (const item of items) {
		costs.set(item.id, Infinity);
		sources.set(item.id, 'none');
	}

	// Helper: When an item gets a cost, check if any recipe depending on it is ready
	function onItemCostSet(itemId) {
		const depRecipes = dependents.get(itemId);
		if (!depRecipes) return;

		for (const recipeId of depRecipes) {
			const pending = recipePendingCounts.get(recipeId);
			if (pending !== undefined && pending > 0) {
				recipePendingCounts.set(recipeId, pending - 1);
				if (pending - 1 === 0) {
					// This recipe is now ready - add its output item to queue if not already there
					const outputItemId = recipeToItem.get(recipeId);
					if (outputItemId !== undefined && !itemInQueue.has(outputItemId)) {
						workQueue.push(outputItemId);
						itemInQueue.add(outputItemId);
					}
				}
			}
		}
	}

	// ===== PHASE 2: Base costs for items with no real recipes =====
	console.log('\nPhase 2: Setting base costs for items with no recipes...');
	let baseCostCount = 0;

	for (const item of items) {
		const hasExtr = hasExtraction.has(item.id);
		// Check if item has any crafting recipe with actual ingredients
		const trackedRecipes = itemRecipes.get(item.id);
		const hasCraftingWithIngredients = trackedRecipes && trackedRecipes.size > 0;

		if (!hasCraftingWithIngredients && !hasExtr) {
			// No way to obtain this item through crafting (with ingredients) or extraction
			const cost = tierToCost(item.tier);
			costs.set(item.id, cost);
			sources.set(item.id, 'tier');
			baseCostCount++;
			onItemCostSet(item.id);
		}
	}
	console.log(`  Set ${baseCostCount} items with tier-based costs`);

	// ===== PHASE 3: Extraction costs =====
	console.log('\nPhase 3: Processing extraction recipes...');
	let extractionCount = 0;

	for (const recipe of extractionRecipes) {
		const resource = resourceMap.get(recipe.resource_id);
		if (!resource) continue;

		const baseCost = tierToCost(resource.tier);

		// Calculate total probability for normalization
		const totalProb = (recipe.extracted_item_stacks || []).reduce(
			(sum, stack) => sum + (stack.probability || 1),
			0
		);

		for (const stack of recipe.extracted_item_stacks || []) {
			if (stack.item_stack?.item_type !== 'Item') continue;

			const itemId = stack.item_stack.item_id;
			const item = itemMap.get(itemId);
			if (!item) continue;

			const probability = (stack.probability || 1) / totalProb;
			const rarityMult = RARITY_MULTIPLIER[item.rarity] || 1;

			// Effective cost = (tier cost * rarity multiplier) / probability
			const effectiveCost = Math.max(MIN_COST, (baseCost * rarityMult) / probability);

			// Use cheapest extraction if multiple recipes produce same item
			if (effectiveCost < costs.get(itemId)) {
				costs.set(itemId, effectiveCost);
				sources.set(itemId, 'extraction');
				extractionCount++;
				onItemCostSet(itemId);
			}
		}
	}
	console.log(`  Set ${extractionCount} items with extraction costs`);

	// ===== PHASE 4: Propagate costs upward =====
	console.log('\nPhase 4: Propagating costs through crafting tree...');
	let craftingCount = 0;
	let iterations = 0;

	while (workQueue.length > 0) {
		iterations++;
		const itemId = workQueue.shift();

		const recipes = recipesByOutput.get(itemId);
		if (!recipes) continue;

		let minCost = Infinity;
		let bestRecipeId = null;

		for (const recipe of recipes) {
			// Skip recipes with no Item ingredients
			if (recipe.ingredients.length === 0) continue;

			let recipeCost = 0;
			let valid = true;

			for (const ing of recipe.ingredients) {
				const ingCost = costs.get(ing.itemId);
				if (ingCost === undefined || ingCost === Infinity) {
					valid = false;
					break;
				}
				recipeCost += ingCost * ing.quantity;
			}

			if (!valid) continue;

			let costPerItem = Math.max(MIN_COST, recipeCost / recipe.outputQuantity);

			// Apply massive penalty to package/unpack recipes so they're never selected as defaults
			if (isPackageOrUnpackRecipe(recipe.name)) {
				costPerItem *= PACKAGE_UNPACK_PENALTY;
			}

			recipeCosts.set(recipe.id, costPerItem);

			if (costPerItem < minCost) {
				minCost = costPerItem;
				bestRecipeId = recipe.id;
			}
		}

		if (bestRecipeId !== null && minCost < Infinity) {
			// Only update if crafting is cheaper than current cost
			if (minCost < costs.get(itemId)) {
				costs.set(itemId, minCost);
				sources.set(itemId, 'crafting');
				defaultRecipes.set(itemId, bestRecipeId);
				craftingCount++;
				onItemCostSet(itemId);
			}
		}
	}
	console.log(`  Set ${craftingCount} items with crafting costs (${iterations} iterations)`);

	// ===== PHASE 5: Handle circular dependencies =====
	// Items with recipes that still have pending ingredients are in cycles
	console.log('\nPhase 5: Detecting circular dependencies...');

	// Find items that are in cycles (have recipes with pending dependencies)
	const cyclicItems = new Set();
	for (const [recipeId, pending] of recipePendingCounts) {
		if (pending > 0) {
			const outputItemId = recipeToItem.get(recipeId);
			if (outputItemId !== undefined && costs.get(outputItemId) === Infinity) {
				cyclicItems.add(outputItemId);
			}
		}
	}

	if (cyclicItems.size > 0) {
		console.log(`  Found ${cyclicItems.size} items in cycles`);

		// Use Tarjan's to find SCCs for better convergence
		const sccs = findSCCs(dependsOn);
		const cycleSCCs = sccs.filter(scc => scc.length > 1);

		for (const scc of cycleSCCs) {
			// Initialize with tier costs
			for (const itemId of scc) {
				if (costs.get(itemId) === Infinity) {
					const item = itemMap.get(itemId);
					if (item) {
						costs.set(itemId, tierToCost(item.tier));
					}
				}
			}

			// Iterative convergence
			const MAX_ITERATIONS = 100;
			let totalChange = Infinity;
			let iteration = 0;

			while (totalChange > CONVERGENCE_THRESHOLD && iteration < MAX_ITERATIONS) {
				totalChange = 0;
				iteration++;

				for (const itemId of scc) {
					const recipes = recipesByOutput.get(itemId);
					if (!recipes) continue;

					const oldCost = costs.get(itemId);
					let minCost = Infinity;
					let bestRecipeId = null;

					for (const recipe of recipes) {
						if (recipe.ingredients.length === 0) continue;

						let recipeCost = 0;
						let valid = true;

						for (const ing of recipe.ingredients) {
							const ingCost = costs.get(ing.itemId);
							if (ingCost === undefined || ingCost === Infinity) {
								valid = false;
								break;
							}
							recipeCost += ingCost * ing.quantity;
						}

						if (!valid) continue;

						let costPerItem = Math.max(MIN_COST, recipeCost / recipe.outputQuantity);

						// Apply massive penalty to package/unpack recipes so they're never selected as defaults
						if (isPackageOrUnpackRecipe(recipe.name)) {
							costPerItem *= PACKAGE_UNPACK_PENALTY;
						}

						recipeCosts.set(recipe.id, costPerItem);

						if (costPerItem < minCost) {
							minCost = costPerItem;
							bestRecipeId = recipe.id;
						}
					}

					if (bestRecipeId !== null && minCost < Infinity && minCost !== oldCost) {
						costs.set(itemId, minCost);
						sources.set(itemId, 'crafting');
						defaultRecipes.set(itemId, bestRecipeId);

						if (oldCost !== Infinity && oldCost > 0) {
							const relativeChange = Math.abs(oldCost - minCost) / oldCost;
							totalChange = Math.max(totalChange, relativeChange);
						} else {
							totalChange = Infinity;
						}
					}
				}
			}

			if (iteration >= MAX_ITERATIONS) {
				console.log(`    Warning: SCC with ${scc.length} items did not converge`);
			}
		}
	} else {
		console.log('  No circular dependencies found');
	}

	// ===== PHASE 6: Handle item list references =====
	// Item list reference items (e.g., "Breezy Fin Darter Products") have item_list_id != 0
	// These items, when consumed, produce random items from the list
	// We propagate the reference item's cost to items inside the list
	console.log('\nPhase 6: Processing item list references...');
	let itemListUpdates = 0;

	for (const item of items) {
		if (item.item_list_id === 0) continue;

		const list = itemListMap.get(item.item_list_id);
		if (!list) continue;

		// Get the item list reference's cost (from crafting or other source)
		const listItemCost = costs.get(item.id);
		if (listItemCost === undefined || listItemCost === Infinity) continue;

		// For each possibility in the list, distribute costs to items inside
		for (const poss of list.possibilities || []) {
			if (poss.probability <= 0) continue;

			// Calculate expected cost per "roll" of this possibility
			// If probability is 0.5, you need ~2 rolls to get this possibility
			// Each roll costs listItemCost
			const expectedRollsNeeded = 1 / poss.probability;
			const totalCostForPossibility = listItemCost * expectedRollsNeeded;

			// Count total item quantity in this possibility to distribute cost
			let totalQuantity = 0;
			for (const itemStack of poss.items || []) {
				if (itemStack.item_type === 'Item') {
					totalQuantity += itemStack.quantity;
				}
			}

			if (totalQuantity === 0) continue;

			// Distribute cost proportionally to items based on quantity
			const costPerUnit = totalCostForPossibility / totalQuantity;

			for (const itemStack of poss.items || []) {
				if (itemStack.item_type !== 'Item') continue;

				// Each unit of this item costs costPerUnit
				const itemCost = Math.max(MIN_COST, costPerUnit);
				const currentCost = costs.get(itemStack.item_id);
				const currentSource = sources.get(itemStack.item_id);

				// Update if cost is lower, OR if cost is equal but source was just 'tier'
				// (item_list is a more specific source than tier)
				const shouldUpdate =
					currentCost !== undefined &&
					(itemCost < currentCost || (itemCost === currentCost && currentSource === 'tier'));

				if (shouldUpdate) {
					costs.set(itemStack.item_id, itemCost);
					sources.set(itemStack.item_id, 'item_list');
					itemListUpdates++;
				}
			}
		}
	}
	console.log(`  Updated ${itemListUpdates} items from item lists`);

	// ===== PHASE 7: Fallback tier costs for remaining items =====
	console.log('\nPhase 7: Setting fallback costs...');
	let fallbackCount = 0;

	for (const item of items) {
		if (costs.get(item.id) === Infinity) {
			costs.set(item.id, tierToCost(item.tier));
			sources.set(item.id, 'tier');
			fallbackCount++;
		}
	}
	console.log(`  Set ${fallbackCount} items with fallback tier costs`);

	// ===== Build output =====
	console.log('\nBuilding output...');

	const itemsOutput = {};
	for (const [itemId, cost] of costs) {
		const entry = {
			materialCost: Math.max(MIN_COST, cost),
			source: sources.get(itemId)
		};
		const defaultRecipeId = defaultRecipes.get(itemId);
		if (defaultRecipeId !== undefined) {
			entry.defaultRecipeId = defaultRecipeId;
		}
		itemsOutput[itemId] = entry;
	}

	const recipesOutput = {};
	for (const [recipeId, cost] of recipeCosts) {
		recipesOutput[recipeId] = { cost: Math.max(MIN_COST, cost) };
	}

	// Calculate source hash from input files
	const sourceContent = JSON.stringify({
		items: items.length,
		resources: resources.length,
		extractionRecipes: extractionRecipes.length,
		craftingRecipes: craftingRecipes.length,
		itemLists: itemLists.length
	});

	const output = {
		version: '2.0',
		generatedAt: new Date().toISOString(),
		sourceHash: hashContent(sourceContent),
		stats: {
			totalItems: costs.size,
			bySource: {
				tier: [...sources.values()].filter((s) => s === 'tier').length,
				extraction: [...sources.values()].filter((s) => s === 'extraction').length,
				crafting: [...sources.values()].filter((s) => s === 'crafting').length,
				item_list: [...sources.values()].filter((s) => s === 'item_list').length
			},
			recipesWithCosts: recipeCosts.size,
			itemsWithDefaultRecipe: defaultRecipes.size,
			circularDependencies: cyclicItems.size
		},
		items: itemsOutput,
		recipes: recipesOutput
	};

	await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));
	console.log(`\nOutput written to ${OUTPUT_PATH}`);
	console.log(`Stats:`, output.stats);
}

generateMaterialCosts().catch((err) => {
	console.error('Failed to generate material costs:', err);
	process.exit(1);
});
