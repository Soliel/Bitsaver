/**
 * Game data loader
 * Fetches and parses JSON files from /game_data/
 */

// Bump this version when data loading logic changes to force cache refresh
export const DATA_LOADER_VERSION = 4;

import type {
	Item,
	Recipe,
	RecipeIngredient,
	LevelRequirement,
	ToolRequirement,
	SkillInfo,
	ToolTypeInfo,
	BuildingTypeInfo,
	MaterialCostsData
} from '$lib/types/game';

// Manifest structure
export interface GameDataManifest {
	version: string;
	hash: string;
	generatedAt: string;
	files: Record<string, string>;
}

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
	building_requirement?: {
		building_type: number;
		tier: number;
	};
	level_requirements?: Array<{
		skill_id: number;
		level: number;
	}>;
	tool_requirements?: Array<{
		tool_type: number;
		level: number;
		power: number;
	}>;
	consumed_item_stacks?: Array<{
		item_id: number;
		quantity: number;
		item_type: string;
	}>;
	crafted_item_stacks?: Array<{
		item_id: number;
		quantity: number;
		item_type: string;
	}>;
}

interface RawSkill {
	id: number;
	name: string;
	title: string;
	skill_category: string;
}

interface RawToolType {
	id: number;
	name: string;
	skill_id: number;
}

interface RawBuildingType {
	id: number;
	name: string;
	category: string;
}

// Rarity string to number mapping
const RARITY_MAP: Record<string, number> = {
	Common: 0,
	Uncommon: 1,
	Rare: 2,
	Epic: 3,
	Legendary: 4,
	Mythic: 5
};

// Building types to exclude (not true crafting recipes)
const EXCLUDED_BUILDING_TYPES = new Set([
	127749503 // Scrap Bench - used for recrafting/recycling, not crafting
]);

/**
 * Fetch the manifest file
 */
export async function fetchManifest(): Promise<GameDataManifest> {
	const response = await fetch('/game_data/manifest.json', {
		cache: 'no-store' // Always fetch fresh manifest
	});
	if (!response.ok) {
		throw new Error(`Failed to fetch manifest: ${response.status}`);
	}
	return response.json();
}

/**
 * Fetch and parse a JSON file
 */
async function fetchJson<T>(filename: string): Promise<T> {
	const response = await fetch(`/game_data/${filename}`);
	if (!response.ok) {
		throw new Error(`Failed to fetch ${filename}: ${response.status}`);
	}
	return response.json();
}

/**
 * Fetch material costs data (optional - returns null if not available)
 */
async function fetchMaterialCosts(): Promise<MaterialCostsData | null> {
	try {
		const response = await fetch('/game_data/material_costs.json');
		if (!response.ok) return null;
		return response.json();
	} catch {
		return null;
	}
}

/**
 * Load all game data from JSON files
 */
export async function loadAllGameData(): Promise<{
	items: Map<number, Item>;
	recipes: Map<number, Recipe[]>;
	skills: Map<number, SkillInfo>;
	toolTypes: Map<number, ToolTypeInfo>;
	buildingTypes: Map<number, BuildingTypeInfo>;
}> {
	// Fetch all JSON files in parallel (including optional material costs)
	const [rawItems, rawRecipes, rawSkills, rawToolTypes, rawBuildingTypes, materialCosts] =
		await Promise.all([
			fetchJson<RawItem[]>('item_desc.json'),
			fetchJson<RawRecipe[]>('crafting_recipe_desc.json'),
			fetchJson<RawSkill[]>('skill_desc.json'),
			fetchJson<RawToolType[]>('tool_type_desc.json'),
			fetchJson<RawBuildingType[]>('building_type_desc.json'),
			fetchMaterialCosts()
		]);

	// Parse reference data first (needed for enriching recipes)
	const skills = parseSkills(rawSkills);
	const toolTypes = parseToolTypes(rawToolTypes);
	const buildingTypes = parseBuildingTypes(rawBuildingTypes);

	// Parse items
	const items = parseItems(rawItems);

	// Parse recipes with reference data for enrichment
	const recipes = parseRecipes(rawRecipes, skills, toolTypes, buildingTypes);

	// Merge material costs into items and recipes if available
	if (materialCosts) {
		mergeMaterialCosts(items, recipes, materialCosts);
	}

	return { items, recipes, skills, toolTypes, buildingTypes };
}

/**
 * Merge pre-computed material costs into items and recipes
 */
function mergeMaterialCosts(
	items: Map<number, Item>,
	recipes: Map<number, Recipe[]>,
	costs: MaterialCostsData
): void {
	// Merge costs into items
	for (const [idStr, costData] of Object.entries(costs.items)) {
		const itemId = parseInt(idStr, 10);
		const item = items.get(itemId);
		if (item) {
			item.materialCost = costData.materialCost;
			if (costData.defaultRecipeId !== undefined) {
				item.defaultRecipeId = costData.defaultRecipeId;
			}
		}
	}

	// Merge costs into recipes
	for (const [idStr, costData] of Object.entries(costs.recipes)) {
		const recipeId = parseInt(idStr, 10);
		// Find the recipe across all item recipe lists
		for (const recipeList of recipes.values()) {
			const recipe = recipeList.find((r) => r.id === recipeId);
			if (recipe) {
				recipe.cost = costData.cost;
				break;
			}
		}
	}
}

/**
 * Parse items from raw JSON
 */
function parseItems(rawItems: RawItem[]): Map<number, Item> {
	const items = new Map<number, Item>();

	for (const raw of rawItems) {
		const item: Item = {
			id: raw.id,
			name: raw.name,
			description: raw.description || '',
			iconAssetName: raw.icon_asset_name || '',
			tier: raw.tier,
			tag: raw.tag || '',
			rarity: RARITY_MAP[raw.rarity] ?? 0,
			rarityStr: raw.rarity || 'Common'
		};
		items.set(item.id, item);
	}

	return items;
}

/**
 * Parse recipes from raw JSON, grouped by output item ID
 */
function parseRecipes(
	rawRecipes: RawRecipe[],
	skills: Map<number, SkillInfo>,
	toolTypes: Map<number, ToolTypeInfo>,
	buildingTypes: Map<number, BuildingTypeInfo>
): Map<number, Recipe[]> {
	const recipesByItem = new Map<number, Recipe[]>();

	for (const raw of rawRecipes) {
		// Skip recipes with no output
		if (!raw.crafted_item_stacks || raw.crafted_item_stacks.length === 0) {
			continue;
		}

		// Skip recipes from excluded buildings (e.g., Scrap Bench)
		if (raw.building_requirement && EXCLUDED_BUILDING_TYPES.has(raw.building_requirement.building_type)) {
			continue;
		}

		// Only consider Item outputs (not Equipment, etc.)
		const outputStack = raw.crafted_item_stacks.find((s) => s.item_type === 'Item');
		if (!outputStack) {
			continue;
		}

		// Parse ingredients (only Item type - exclude Resources, Cargo, etc.)
		const ingredients: RecipeIngredient[] = (raw.consumed_item_stacks || [])
			.filter((s) => s.item_type === 'Item')
			.map((s) => ({
				itemId: s.item_id,
				quantity: s.quantity
			}));

		// Parse level requirements with skill names
		const levelRequirements: LevelRequirement[] = (raw.level_requirements || []).map((lr) => {
			const skill = skills.get(lr.skill_id);
			return {
				level: lr.level,
				skillId: lr.skill_id,
				skillName: skill?.name || 'Unknown',
				skillIcon: '', // Not available in JSON
				skillTitle: skill?.title || ''
			};
		});

		// Parse tool requirements with tool names
		const toolRequirements: ToolRequirement[] = (raw.tool_requirements || []).map((tr) => {
			const toolType = toolTypes.get(tr.tool_type);
			return {
				level: tr.level,
				power: tr.power,
				toolType: tr.tool_type,
				name: toolType?.name || 'Unknown',
				skillId: toolType?.skillId || 0
			};
		});

		// Get crafting station info
		const buildingType = raw.building_requirement
			? buildingTypes.get(raw.building_requirement.building_type)
			: undefined;

		const recipe: Recipe = {
			id: raw.id,
			name: raw.name,
			outputItemId: outputStack.item_id,
			outputQuantity: outputStack.quantity,
			craftingStationId: raw.building_requirement?.building_type,
			craftingStationName: buildingType?.name,
			craftingStationTier: raw.building_requirement?.tier,
			ingredients,
			levelRequirements,
			toolRequirements
		};

		// Add to map grouped by output item ID
		const existing = recipesByItem.get(recipe.outputItemId) || [];
		existing.push(recipe);
		recipesByItem.set(recipe.outputItemId, existing);
	}

	return recipesByItem;
}

/**
 * Parse skills from raw JSON
 */
function parseSkills(rawSkills: RawSkill[]): Map<number, SkillInfo> {
	const skills = new Map<number, SkillInfo>();

	for (const raw of rawSkills) {
		const skill: SkillInfo = {
			id: raw.id,
			name: raw.name,
			title: raw.title,
			category: raw.skill_category as SkillInfo['category']
		};
		skills.set(skill.id, skill);
	}

	return skills;
}

/**
 * Parse tool types from raw JSON
 */
function parseToolTypes(rawToolTypes: RawToolType[]): Map<number, ToolTypeInfo> {
	const toolTypes = new Map<number, ToolTypeInfo>();

	for (const raw of rawToolTypes) {
		const toolType: ToolTypeInfo = {
			id: raw.id,
			name: raw.name,
			skillId: raw.skill_id
		};
		toolTypes.set(toolType.id, toolType);
	}

	return toolTypes;
}

/**
 * Parse building types from raw JSON
 */
function parseBuildingTypes(rawBuildingTypes: RawBuildingType[]): Map<number, BuildingTypeInfo> {
	const buildingTypes = new Map<number, BuildingTypeInfo>();

	for (const raw of rawBuildingTypes) {
		const buildingType: BuildingTypeInfo = {
			id: raw.id,
			name: raw.name,
			category: raw.category
		};
		buildingTypes.set(buildingType.id, buildingType);
	}

	return buildingTypes;
}
