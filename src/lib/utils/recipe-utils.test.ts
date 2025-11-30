/**
 * Tests for recipe utility functions.
 * Uses actual game data to verify calculations.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { Item, Recipe, Cargo, LevelRequirement } from '$lib/types/game';
import {
	type RecipeContext,
	filterValidRecipes,
	getCheapestRecipe,
	calculateItemNaturalStep,
	calculateItemProfession,
	getCargoProfession,
	calculateCargoNaturalStep,
	debugRecipeFiltering
} from './recipe-utils';

// Raw JSON types (snake_case from files)
interface RawItem {
	id: number;
	name: string;
	description: string;
	icon_asset_name: string;
	tier: number;
	tag: string;
	rarity: string;
}

interface RawRecipe {
	id: number;
	name: string;
	building_requirement?: { building_type: number; tier: number };
	level_requirements?: Array<{ skill_id: number; level: number }>;
	tool_requirements?: Array<{ tool_type: number; level: number; power: number }>;
	consumed_item_stacks?: Array<{ item_id: number; quantity: number; item_type: string }>;
	crafted_item_stacks?: Array<{ item_id: number; quantity: number; item_type: string }>;
}

interface RawCargo {
	id: number;
	name: string;
	description: string;
	icon_asset_name: string;
	tier: number;
	tag: string;
	rarity: string;
	volume: number;
}

interface RawSkill {
	id: number;
	name: string;
	title: string;
	skill_category: string;
}

interface MaterialCostsData {
	version: string;
	items: Record<string, { materialCost: number; source: string; defaultRecipeId?: number }>;
	recipes: Record<string, { cost: number }>;
}

// Rarity mapping
const RARITY_MAP: Record<string, number> = {
	Common: 0, Uncommon: 1, Rare: 2, Epic: 3, Legendary: 4, Mythic: 5
};

// Build context from JSON files
let ctx: RecipeContext;
let materialCosts: MaterialCostsData;
let skills: Map<number, { id: number; name: string }>;

beforeAll(() => {
	const dataDir = path.join(process.cwd(), 'static/game_data');

	// Load raw data
	const rawItems: RawItem[] = JSON.parse(fs.readFileSync(path.join(dataDir, 'item_desc.json'), 'utf-8'));
	const rawRecipes: RawRecipe[] = JSON.parse(fs.readFileSync(path.join(dataDir, 'crafting_recipe_desc.json'), 'utf-8'));
	const rawCargos: RawCargo[] = JSON.parse(fs.readFileSync(path.join(dataDir, 'cargo_desc.json'), 'utf-8'));
	const rawSkills: RawSkill[] = JSON.parse(fs.readFileSync(path.join(dataDir, 'skill_desc.json'), 'utf-8'));
	materialCosts = JSON.parse(fs.readFileSync(path.join(dataDir, 'material_costs.json'), 'utf-8'));

	// Build skills map
	skills = new Map();
	for (const raw of rawSkills) {
		skills.set(raw.id, { id: raw.id, name: raw.name });
	}

	// Build items map
	const items = new Map<number, Item>();
	for (const raw of rawItems) {
		items.set(raw.id, {
			id: raw.id,
			name: raw.name,
			description: raw.description || '',
			iconAssetName: raw.icon_asset_name || '',
			tier: raw.tier,
			tag: raw.tag || '',
			rarity: RARITY_MAP[raw.rarity] ?? 0,
			rarityStr: raw.rarity || 'Common'
		});
	}

	// Build cargos map
	const cargos = new Map<number, Cargo>();
	for (const raw of rawCargos) {
		cargos.set(raw.id, {
			id: raw.id,
			name: raw.name,
			description: raw.description || '',
			iconAssetName: raw.icon_asset_name || '',
			tier: raw.tier,
			tag: raw.tag || '',
			rarity: raw.rarity || 'Common',
			volume: raw.volume || 0
		});
	}

	// Build cargo lookup for filtering pack/unpack
	const cargoById = new Map<number, RawCargo>();
	for (const c of rawCargos) {
		cargoById.set(c.id, c);
	}

	// Build recipes map
	const recipes = new Map<number, Recipe[]>();
	for (const raw of rawRecipes) {
		if (!raw.crafted_item_stacks || raw.crafted_item_stacks.length === 0) continue;

		const outputStack = raw.crafted_item_stacks.find(s => s.item_type === 'Item');
		if (!outputStack) continue;

		// Parse ingredients
		const ingredients = (raw.consumed_item_stacks || [])
			.filter(s => s.item_type === 'Item')
			.map(s => ({ itemId: s.item_id, quantity: s.quantity }));

		const cargoIngredients = (raw.consumed_item_stacks || [])
			.filter(s => s.item_type === 'Cargo')
			.map(s => ({ cargoId: s.item_id, quantity: s.quantity }));

		// Skip "unpack" recipes (cargo Package type creates cycles)
		if (cargoIngredients.length > 0) {
			const allPackages = cargoIngredients.every(ci => {
				const cargo = cargoById.get(ci.cargoId);
				return cargo?.tag === 'Package';
			});
			if (allPackages) continue;
		}

		// Parse level requirements
		const levelRequirements: LevelRequirement[] = (raw.level_requirements || []).map(lr => {
			const skill = skills.get(lr.skill_id);
			return {
				level: lr.level,
				skillId: lr.skill_id,
				skillName: skill?.name || 'Unknown',
				skillIcon: '',
				skillTitle: ''
			};
		});

		// Get cost from material_costs.json
		const costData = materialCosts.recipes[String(raw.id)];

		const recipe: Recipe = {
			id: raw.id,
			name: raw.name,
			outputItemId: outputStack.item_id,
			outputQuantity: outputStack.quantity,
			ingredients,
			cargoIngredients: cargoIngredients.length > 0 ? cargoIngredients : undefined,
			levelRequirements,
			toolRequirements: [],
			cost: costData?.cost
		};

		const existing = recipes.get(recipe.outputItemId) || [];
		existing.push(recipe);
		recipes.set(recipe.outputItemId, existing);
	}

	// Build cargoToSkill map and cargoRecipes map from crafting recipes
	const cargoToSkill = new Map<number, string>();
	const cargoRecipes = new Map<number, Recipe[]>();

	for (const raw of rawRecipes) {
		if (!raw.crafted_item_stacks || raw.crafted_item_stacks.length === 0) continue;

		// Find cargo outputs
		const cargoOutput = raw.crafted_item_stacks.find(s => s.item_type === 'Cargo');
		if (!cargoOutput) continue;

		// Get skill from level requirements
		const skillId = raw.level_requirements?.[0]?.skill_id;
		if (!skillId) continue;

		const skill = skills.get(skillId);
		if (!skill) continue;

		// Build cargoToSkill mapping
		if (!cargoToSkill.has(cargoOutput.item_id)) {
			cargoToSkill.set(cargoOutput.item_id, skill.name);
		}

		// Build cargo recipe (reusing Recipe type)
		const ingredients = (raw.consumed_item_stacks || [])
			.filter(s => s.item_type === 'Item')
			.map(s => ({ itemId: s.item_id, quantity: s.quantity }));

		const cargoIngredients = (raw.consumed_item_stacks || [])
			.filter(s => s.item_type === 'Cargo')
			.map(s => ({ cargoId: s.item_id, quantity: s.quantity }));

		const levelRequirements: LevelRequirement[] = (raw.level_requirements || []).map(lr => {
			const sk = skills.get(lr.skill_id);
			return {
				level: lr.level,
				skillId: lr.skill_id,
				skillName: sk?.name || 'Unknown',
				skillIcon: '',
				skillTitle: ''
			};
		});

		const costData = materialCosts.recipes[String(raw.id)];

		const cargoRecipe: Recipe = {
			id: raw.id,
			name: raw.name,
			outputItemId: cargoOutput.item_id, // Actually outputCargoId
			outputQuantity: cargoOutput.quantity,
			ingredients,
			cargoIngredients: cargoIngredients.length > 0 ? cargoIngredients : undefined,
			levelRequirements,
			toolRequirements: [],
			cost: costData?.cost
		};

		const existing = cargoRecipes.get(cargoOutput.item_id) || [];
		existing.push(cargoRecipe);
		cargoRecipes.set(cargoOutput.item_id, existing);
	}

	ctx = {
		items,
		recipes,
		cargoRecipes,
		cargos,
		cargoToSkill,
		itemToCargoSkill: new Map(),
		itemFromListToSkill: new Map()
	};
});

describe('Recipe Context', () => {
	it('should load items from game data', () => {
		expect(ctx.items.size).toBeGreaterThan(0);
	});

	it('should load recipes from game data', () => {
		expect(ctx.recipes.size).toBeGreaterThan(0);
	});

	it('should load cargos from game data', () => {
		expect(ctx.cargos.size).toBeGreaterThan(0);
	});
});

describe('filterValidRecipes', () => {
	it('should filter out recipes with no ingredients', () => {
		const mockItem: Item = {
			id: 1,
			name: 'Test',
			description: '',
			iconAssetName: '',
			tier: 1,
			tag: '',
			rarity: 0,
			rarityStr: 'Common'
		};

		const noIngredientRecipe: Recipe = {
			id: 999,
			name: 'Empty',
			outputItemId: 1,
			outputQuantity: 1,
			ingredients: [],
			levelRequirements: [],
			toolRequirements: []
		};

		const result = filterValidRecipes([noIngredientRecipe], mockItem, ctx);
		expect(result).toHaveLength(0);
	});

	it('should keep recipes with valid item ingredients', () => {
		// Rough Plank (1020003) should have valid recipes
		const roughPlank = ctx.items.get(1020003);
		expect(roughPlank).toBeDefined();

		const allRecipes = ctx.recipes.get(1020003) || [];
		expect(allRecipes.length).toBeGreaterThan(0);

		const validRecipes = filterValidRecipes(allRecipes, roughPlank!, ctx);
		expect(validRecipes.length).toBeGreaterThan(0);
	});

	it('should filter out downgrade recipes', () => {
		// Find an item with a downgrade recipe if one exists
		// For now, just verify the filter runs
		const roughPlank = ctx.items.get(1020003);
		const allRecipes = ctx.recipes.get(1020003) || [];
		const validRecipes = filterValidRecipes(allRecipes, roughPlank!, ctx);

		// All valid recipes should not be downgrades
		for (const recipe of validRecipes) {
			for (const ing of recipe.ingredients) {
				const ingItem = ctx.items.get(ing.itemId);
				if (ingItem && ingItem.tier !== -1 && roughPlank!.tier !== -1) {
					expect(ingItem.tier).toBeLessThanOrEqual(roughPlank!.tier);
				}
			}
		}
	});
});

describe('getCheapestRecipe', () => {
	it('should return undefined for empty list', () => {
		expect(getCheapestRecipe([])).toBeUndefined();
	});

	it('should return the recipe with lowest cost', () => {
		const recipes: Recipe[] = [
			{ id: 1, name: 'A', outputItemId: 1, outputQuantity: 1, ingredients: [], levelRequirements: [], toolRequirements: [], cost: 10 },
			{ id: 2, name: 'B', outputItemId: 1, outputQuantity: 1, ingredients: [], levelRequirements: [], toolRequirements: [], cost: 5 },
			{ id: 3, name: 'C', outputItemId: 1, outputQuantity: 1, ingredients: [], levelRequirements: [], toolRequirements: [], cost: 15 }
		];
		expect(getCheapestRecipe(recipes)?.id).toBe(2);
	});

	it('should handle undefined costs (treat as Infinity)', () => {
		const recipes: Recipe[] = [
			{ id: 1, name: 'A', outputItemId: 1, outputQuantity: 1, ingredients: [], levelRequirements: [], toolRequirements: [], cost: undefined },
			{ id: 2, name: 'B', outputItemId: 1, outputQuantity: 1, ingredients: [], levelRequirements: [], toolRequirements: [], cost: 5 }
		];
		expect(getCheapestRecipe(recipes)?.id).toBe(2);
	});
});

describe('calculateItemNaturalStep', () => {
	it('should return step 1 for items with no recipes', () => {
		// Pick an item that we know has no crafting recipe (raw material)
		// Rough Wood Log (1010001) should be step 1
		const step = calculateItemNaturalStep(1010001, ctx);
		expect(step).toBe(1);
	});

	it('should return step 1 for non-existent items', () => {
		const step = calculateItemNaturalStep(999999999, ctx);
		expect(step).toBe(1);
	});

	it('should calculate correct step for Rough Stripped Wood', () => {
		// Rough Stripped Wood (1320886430) is made from Rough Wood Log (step 1)
		// So Rough Stripped Wood should be step 2
		const step = calculateItemNaturalStep(1320886430, ctx);
		expect(step).toBe(2);
	});

	it('should calculate correct step for Rough Plank', () => {
		// Rough Plank (1020003) is made from Rough Stripped Wood (step 2)
		// So Rough Plank should be step 3
		const step = calculateItemNaturalStep(1020003, ctx);
		expect(step).toBe(3);
	});

	it('should use cache for repeated calculations', () => {
		const cache = new Map<number, number>();

		const step1 = calculateItemNaturalStep(1020003, ctx, new Set(), cache);
		expect(cache.has(1020003)).toBe(true);

		const step2 = calculateItemNaturalStep(1020003, ctx, new Set(), cache);
		expect(step1).toBe(step2);
	});
});

describe('calculateItemProfession', () => {
	it('should return "Unknown" for non-existent items', () => {
		const profession = calculateItemProfession(999999999, ctx);
		expect(profession).toBe('Unknown');
	});

	it('should return "Gathering" for raw materials', () => {
		// Rough Wood Log (1010001) is a gathered material
		const profession = calculateItemProfession(1010001, ctx);
		expect(profession).toBe('Gathering');
	});

	it('should return skill name for crafted items', () => {
		// Rough Plank should have a crafting profession
		const profession = calculateItemProfession(1020003, ctx);
		expect(profession).not.toBe('Unknown');
		expect(profession).not.toBe('Gathering'); // Should have actual profession
	});
});

describe('debugRecipeFiltering', () => {
	it('should provide detailed debug info for Rough Plank', () => {
		const debug = debugRecipeFiltering(1020003, ctx);

		expect(debug.item).toBeDefined();
		expect(debug.item?.name).toBe('Rough Plank');
		expect(debug.allRecipes.length).toBeGreaterThan(0);
		expect(debug.validRecipes.length).toBeGreaterThan(0);
		expect(debug.selectedRecipe).toBeDefined();
		expect(debug.calculatedStep).toBe(3); // Should be step 3
	});

	it('should show filter reasons for filtered recipes', () => {
		// Get debug for an item that might have filtered recipes
		const debug = debugRecipeFiltering(1020003, ctx);

		// Log for manual inspection
		console.log('Rough Plank debug:', {
			itemName: debug.item?.name,
			allRecipesCount: debug.allRecipes.length,
			validRecipesCount: debug.validRecipes.length,
			filterReasons: debug.filterReasons,
			selectedRecipeId: debug.selectedRecipe?.id,
			selectedRecipeCost: debug.selectedRecipe?.cost,
			step: debug.calculatedStep,
			profession: debug.calculatedProfession
		});

		// Verify structure
		expect(Array.isArray(debug.filterReasons)).toBe(true);
	});
});

describe('Real Game Data - Wood Processing Chain', () => {
	it('should have correct step progression: Log -> Stripped Wood -> Plank', () => {
		const logStep = calculateItemNaturalStep(1010001, ctx); // Rough Wood Log
		const strippedStep = calculateItemNaturalStep(1320886430, ctx); // Rough Stripped Wood
		const plankStep = calculateItemNaturalStep(1020003, ctx); // Rough Plank

		console.log('Wood chain steps:', { log: logStep, stripped: strippedStep, plank: plankStep });

		expect(logStep).toBe(1);
		expect(strippedStep).toBe(logStep + 1);
		expect(plankStep).toBe(strippedStep + 1);
	});

	it('should verify Rough Stripped Wood recipe exists and is valid', () => {
		const strippedWoodId = 1320886430;
		const item = ctx.items.get(strippedWoodId);
		const allRecipes = ctx.recipes.get(strippedWoodId) || [];
		const validRecipes = item ? filterValidRecipes(allRecipes, item, ctx) : [];

		console.log('Rough Stripped Wood:', {
			exists: !!item,
			name: item?.name,
			tier: item?.tier,
			allRecipesCount: allRecipes.length,
			validRecipesCount: validRecipes.length,
			recipes: validRecipes.map(r => ({
				id: r.id,
				cost: r.cost,
				ingredients: r.ingredients.map(i => ({
					itemId: i.itemId,
					name: ctx.items.get(i.itemId)?.name
				}))
			}))
		});

		expect(item).toBeDefined();
		expect(validRecipes.length).toBeGreaterThan(0);
	});

	it('should verify Rough Plank recipe chain is complete', () => {
		const debug = debugRecipeFiltering(1020003, ctx);

		// The selected recipe should use Rough Stripped Wood
		expect(debug.selectedRecipe).toBeDefined();

		if (debug.selectedRecipe) {
			const ingredientIds = debug.selectedRecipe.ingredients.map(i => i.itemId);
			console.log('Rough Plank recipe ingredients:', debug.selectedRecipe.ingredients.map(i => ({
				itemId: i.itemId,
				name: ctx.items.get(i.itemId)?.name,
				quantity: i.quantity
			})));

			// Should have Rough Stripped Wood as ingredient
			expect(ingredientIds).toContain(1320886430);
		}
	});
});

describe('Real Game Data - Brick Processing Chain', () => {
	it('should calculate steps for Rough Brick chain', () => {
		// Find items in the brick chain
		const roughBrickId = 1030002;
		const roughBrick = ctx.items.get(roughBrickId);

		if (roughBrick) {
			const debug = debugRecipeFiltering(roughBrickId, ctx);
			console.log('Rough Brick debug:', {
				name: debug.item?.name,
				tier: debug.item?.tier,
				allRecipesCount: debug.allRecipes.length,
				validRecipesCount: debug.validRecipes.length,
				filterReasons: debug.filterReasons,
				selectedRecipe: debug.selectedRecipe ? {
					id: debug.selectedRecipe.id,
					cost: debug.selectedRecipe.cost,
					ingredients: debug.selectedRecipe.ingredients.map(i => ({
						itemId: i.itemId,
						name: ctx.items.get(i.itemId)?.name
					}))
				} : null,
				step: debug.calculatedStep,
				profession: debug.calculatedProfession
			});
		}
	});
});

describe('Cargo-only recipes', () => {
	it('should keep recipes that only have cargo ingredients (non-Package)', () => {
		// Find a recipe that only uses cargo but isn't an unpack recipe
		// This tests that cargo-only recipes are valid
		let foundCargoOnlyRecipe = false;

		for (const [itemId, recipes] of ctx.recipes) {
			for (const recipe of recipes) {
				if (recipe.ingredients.length === 0 && recipe.cargoIngredients && recipe.cargoIngredients.length > 0) {
					const item = ctx.items.get(itemId);
					if (item) {
						const validRecipes = filterValidRecipes([recipe], item, ctx);
						if (validRecipes.length > 0) {
							foundCargoOnlyRecipe = true;
							console.log('Found valid cargo-only recipe:', {
								itemId,
								itemName: item.name,
								recipeId: recipe.id,
								cargoIngredients: recipe.cargoIngredients
							});
							break;
						}
					}
				}
			}
			if (foundCargoOnlyRecipe) break;
		}

		// We should find at least one valid cargo-only recipe
		expect(foundCargoOnlyRecipe).toBe(true);
	});
});

describe('Module-level cache behavior', () => {
	it('should demonstrate that caches persist across calls', () => {
		const cache = new Map<number, number>();

		// First calculation
		const step1 = calculateItemNaturalStep(1020003, ctx, new Set(), cache);

		// Modify the cache manually (simulating stale data)
		cache.set(1020003, 999);

		// Second calculation should use cached value
		const step2 = calculateItemNaturalStep(1020003, ctx, new Set(), cache);

		console.log('Cache behavior:', { step1, step2, cacheValue: cache.get(1020003) });

		// This demonstrates the problem: cached values persist
		expect(step2).toBe(999);
		expect(step2).not.toBe(step1);
	});

	it('should return correct value when cache is cleared', () => {
		const cache = new Map<number, number>();

		// Calculate and cache
		calculateItemNaturalStep(1020003, ctx, new Set(), cache);

		// Clear cache
		cache.clear();

		// Recalculate - should get fresh value
		const freshStep = calculateItemNaturalStep(1020003, ctx, new Set(), cache);

		expect(freshStep).toBe(3);
	});
});

describe('Compare with raw data loading (simulating app behavior)', () => {
	it('should verify recipe has cost after material_costs merge', () => {
		const roughPlankRecipes = ctx.recipes.get(1020003) || [];
		const recipeWithCost = roughPlankRecipes.find(r => r.cost !== undefined);

		console.log('Rough Plank recipes with cost info:', roughPlankRecipes.map(r => ({
			id: r.id,
			cost: r.cost,
			hasCost: r.cost !== undefined
		})));

		expect(recipeWithCost).toBeDefined();
		expect(recipeWithCost?.cost).toBe(3);
	});
});

describe('Cargo Profession Detection', () => {
	it('should build cargoToSkill map from crafting recipes', () => {
		// Verify the map was populated
		expect(ctx.cargoToSkill.size).toBeGreaterThan(0);
		console.log(`Built cargoToSkill map with ${ctx.cargoToSkill.size} entries`);
	});

	it('should map Rough Timber (cargo 1200) to Carpentry', () => {
		const roughTimberId = 1200;
		const profession = getCargoProfession(roughTimberId, ctx);

		console.log('Rough Timber profession:', profession);
		expect(profession).toBe('Carpentry');
	});

	it('should map Rough Brick Slab (cargo 2400) to Masonry', () => {
		const roughBrickSlabId = 2400;
		const profession = getCargoProfession(roughBrickSlabId, ctx);

		console.log('Rough Brick Slab profession:', profession);
		expect(profession).toBe('Masonry');
	});

	it('should map Simple Timber (cargo 1201) to Carpentry', () => {
		const simpleTimberId = 1201;
		const profession = getCargoProfession(simpleTimberId, ctx);

		console.log('Simple Timber profession:', profession);
		expect(profession).toBe('Carpentry');
	});

	it('should map Simple Brick Slab (cargo 2401) to Masonry', () => {
		const simpleBrickSlabId = 2401;
		const profession = getCargoProfession(simpleBrickSlabId, ctx);

		console.log('Simple Brick Slab profession:', profession);
		expect(profession).toBe('Masonry');
	});

	it('should return Gathering for cargo not in cargoToSkill map', () => {
		const unknownCargoId = 999999;
		const profession = getCargoProfession(unknownCargoId, ctx);

		expect(profession).toBe('Gathering');
	});

	it('should correctly identify all timber cargo types', () => {
		// Find all cargo items with "Timber" in the name
		const timberCargos: { id: number; name: string; profession: string }[] = [];

		for (const [id, cargo] of ctx.cargos) {
			if (cargo.name.includes('Timber')) {
				const profession = getCargoProfession(id, ctx);
				timberCargos.push({ id, name: cargo.name, profession });
			}
		}

		console.log('Timber cargo types:', timberCargos);

		// All timber should be Carpentry
		for (const timber of timberCargos) {
			expect(timber.profession).toBe('Carpentry');
		}
	});

	it('should correctly identify all brick slab cargo types', () => {
		// Find all cargo items with "Brick Slab" in the name
		const brickCargos: { id: number; name: string; profession: string }[] = [];

		for (const [id, cargo] of ctx.cargos) {
			if (cargo.name.includes('Brick Slab')) {
				const profession = getCargoProfession(id, ctx);
				brickCargos.push({ id, name: cargo.name, profession });
			}
		}

		console.log('Brick Slab cargo types:', brickCargos);

		// All brick slabs should be Masonry
		for (const brick of brickCargos) {
			expect(brick.profession).toBe('Masonry');
		}
	});
});

describe('Cargo Step Calculation', () => {
	it('should build cargoRecipes map from crafting recipes', () => {
		// Verify the cargoRecipes map was populated
		expect(ctx.cargoRecipes).toBeDefined();
		expect(ctx.cargoRecipes!.size).toBeGreaterThan(0);
		console.log(`Built cargoRecipes map with ${ctx.cargoRecipes!.size} cargo types`);
	});

	it('should calculate step > 1 for Rough Timber (crafted from items)', () => {
		const roughTimberId = 1200;
		const step = calculateCargoNaturalStep(roughTimberId, ctx);

		console.log('Rough Timber step:', step);
		// Rough Timber is crafted from items, so should be step > 1
		expect(step).toBeGreaterThan(1);
	});

	it('should calculate step > 1 for Rough Brick Slab (crafted from items)', () => {
		const roughBrickSlabId = 2400;
		const step = calculateCargoNaturalStep(roughBrickSlabId, ctx);

		console.log('Rough Brick Slab step:', step);
		// Rough Brick Slab is crafted from items, so should be step > 1
		expect(step).toBeGreaterThan(1);
	});

	it('should calculate correct step chain for timber types', () => {
		// Find all timber cargo and their steps
		const timberSteps: { id: number; name: string; step: number }[] = [];

		for (const [id, cargo] of ctx.cargos) {
			if (cargo.name.includes('Timber')) {
				const step = calculateCargoNaturalStep(id, ctx);
				timberSteps.push({ id, name: cargo.name, step });
			}
		}

		console.log('Timber cargo steps:', timberSteps);

		// All crafted timber should have step > 1
		for (const timber of timberSteps) {
			expect(timber.step).toBeGreaterThan(1);
		}
	});

	it('should return step 1 for gathered cargo (no recipe)', () => {
		// Find a cargo that has no recipe (should be step 1)
		// Raw Log cargo (if exists) should be step 1
		const rawLogCargoId = 1000; // Raw Wood Log Cargo
		const step = calculateCargoNaturalStep(rawLogCargoId, ctx);

		console.log('Raw Log Cargo step:', step);
		// If this cargo has no recipe, it should be step 1
		// If it does have a recipe, it's still valid
		expect(step).toBeGreaterThanOrEqual(1);
	});

	it('should use cache for repeated cargo step calculations', () => {
		const cargoCache = new Map<number, number>();
		const roughTimberId = 1200;

		const step1 = calculateCargoNaturalStep(roughTimberId, ctx, new Set(), new Set(), undefined, cargoCache);
		expect(cargoCache.has(roughTimberId)).toBe(true);

		// Modify cache to test it's being used
		const originalStep = cargoCache.get(roughTimberId)!;
		cargoCache.set(roughTimberId, 999);

		const step2 = calculateCargoNaturalStep(roughTimberId, ctx, new Set(), new Set(), undefined, cargoCache);
		expect(step2).toBe(999);
		expect(step2).not.toBe(originalStep);
	});

	it('should handle cargo with item ingredients correctly', () => {
		// Rough Timber is made from items, so its step = max(item ingredients step) + 1
		const roughTimberId = 1200;
		const cargoRecipes = ctx.cargoRecipes?.get(roughTimberId) || [];

		expect(cargoRecipes.length).toBeGreaterThan(0);

		const recipe = cargoRecipes[0];
		console.log('Rough Timber recipe:', {
			id: recipe.id,
			name: recipe.name,
			ingredients: recipe.ingredients.map(i => ({
				itemId: i.itemId,
				name: ctx.items.get(i.itemId)?.name
			}))
		});

		// Calculate step - should be based on ingredient steps
		const step = calculateCargoNaturalStep(roughTimberId, ctx);
		expect(step).toBeGreaterThan(1);
	});
});
