/**
 * Game data loader
 * Fetches and parses JSON files from /game_data/
 */

// Bump this version when data loading logic changes to force cache refresh
export const DATA_LOADER_VERSION = 9;

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

interface RawExtractionRecipe {
	id: number;
	resource_id: number;
	level_requirements?: Array<{
		skill_id: number;
		level: number;
	}>;
	tool_requirements?: Array<{
		tool_type: number;
		level: number;
		power: number;
	}>;
	extracted_item_stacks?: Array<{
		item_stack: {
			item_id: number;
			quantity: number;
			item_type: string;
		};
		probability: number;
	}>;
}

interface RawResource {
	id: number;
	name: string;
	on_destroy_yield?: Array<{
		item_id: number;
		quantity: number;
		item_type: string;
	}>;
}

interface RawCargo {
	id: number;
	name: string;
	tag: string;
}

interface RawItemList {
	id: number;
	name: string;
	possibilities: Array<{
		probability: number;
		items: Array<{
			item_id: number;
			quantity: number;
			item_type: string;
		}>;
	}>;
}

interface RawItemWithListId {
	id: number;
	item_list_id: number;
}

// Cargo tag to skill mapping (for cargo not in resource on_destroy_yield)
const CARGO_TAG_TO_SKILL: Record<string, string> = {
	'Ocean Fish': 'Fishing',
	'Lake Fish': 'Fishing'
};

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
	extractionRecipes: Map<number, Recipe[]>;
	cargoToSkill: Map<number, string>;
	itemToCargoSkill: Map<number, string>;
	itemFromListToSkill: Map<number, string>;
	skills: Map<number, SkillInfo>;
	toolTypes: Map<number, ToolTypeInfo>;
	buildingTypes: Map<number, BuildingTypeInfo>;
}> {
	// Fetch all JSON files in parallel (including optional material costs)
	const [rawItems, rawRecipes, rawExtractionRecipes, rawResources, rawCargos, rawItemLists, rawSkills, rawToolTypes, rawBuildingTypes, materialCosts] =
		await Promise.all([
			fetchJson<RawItem[]>('item_desc.json'),
			fetchJson<RawRecipe[]>('crafting_recipe_desc.json'),
			fetchJson<RawExtractionRecipe[]>('extraction_recipe_desc.json'),
			fetchJson<RawResource[]>('resource_desc.json'),
			fetchJson<RawCargo[]>('cargo_desc.json'),
			fetchJson<RawItemList[]>('item_list_desc.json'),
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

	// Parse extraction recipes
	const extractionRecipes = parseExtractionRecipes(rawExtractionRecipes, skills, toolTypes);

	// Build cargoToSkill mapping: cargo_id -> skill_name
	const cargoToSkill = buildCargoToSkillMap(rawResources, rawCargos, rawExtractionRecipes, skills);

	// Build itemToCargoSkill mapping: output item ID -> cargo source skill name
	// For items produced by processing Cargo (e.g., Fish Oil from Fish Cargo)
	const itemToCargoSkill = buildItemToCargoSkillMap(rawRecipes, cargoToSkill, rawCargos);

	// Build itemFromListToSkill mapping: items inside item lists -> source skill
	// For items that come from opening item list reference items (e.g., Fish Oil from "Breezy Fin Darter Products")
	const itemFromListToSkill = buildItemFromListToSkillMap(rawItems, rawRecipes, rawItemLists, skills);

	// Merge material costs into items and recipes if available
	if (materialCosts) {
		mergeMaterialCosts(items, recipes, materialCosts);
	}

	return { items, recipes, extractionRecipes, cargoToSkill, itemToCargoSkill, itemFromListToSkill, skills, toolTypes, buildingTypes };
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

/**
 * Parse extraction recipes from raw JSON, grouped by output item ID
 */
function parseExtractionRecipes(
	rawRecipes: RawExtractionRecipe[],
	skills: Map<number, SkillInfo>,
	toolTypes: Map<number, ToolTypeInfo>
): Map<number, Recipe[]> {
	const recipesByItem = new Map<number, Recipe[]>();

	for (const raw of rawRecipes) {
		// Skip recipes with no extracted items
		if (!raw.extracted_item_stacks || raw.extracted_item_stacks.length === 0) {
			continue;
		}

		// Parse level requirements with skill names
		const levelRequirements: LevelRequirement[] = (raw.level_requirements || []).map((lr) => {
			const skill = skills.get(lr.skill_id);
			return {
				level: lr.level,
				skillId: lr.skill_id,
				skillName: skill?.name || 'Unknown',
				skillIcon: '',
				skillTitle: skill?.title || ''
			};
		});

		// Parse tool requirements
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

		// Create a recipe entry for each extracted item
		for (const extracted of raw.extracted_item_stacks) {
			const itemStack = extracted.item_stack;
			if (itemStack.item_type !== 'Item') continue;

			const recipe: Recipe = {
				id: raw.id,
				name: `Extract from resource ${raw.resource_id}`,
				outputItemId: itemStack.item_id,
				outputQuantity: itemStack.quantity,
				ingredients: [], // Extraction recipes don't have item ingredients
				levelRequirements,
				toolRequirements
			};

			// Add to map grouped by output item ID
			const existing = recipesByItem.get(recipe.outputItemId) || [];
			// Avoid duplicate recipes for the same item (same recipe can appear multiple times)
			if (!existing.some(r => r.id === recipe.id)) {
				existing.push(recipe);
				recipesByItem.set(recipe.outputItemId, existing);
			}
		}
	}

	return recipesByItem;
}

/**
 * Build a mapping from cargo ID to gathering skill name
 * Traces: Resource -> on_destroy_yield (Cargo) -> extraction recipe -> skill
 * Also includes tag-based mappings for cargo not in resource yields (e.g., fish)
 */
function buildCargoToSkillMap(
	rawResources: RawResource[],
	rawCargos: RawCargo[],
	rawExtractionRecipes: RawExtractionRecipe[],
	skills: Map<number, SkillInfo>
): Map<number, string> {
	const cargoToSkill = new Map<number, string>();

	// Build resource_id -> skill_name lookup from extraction recipes
	const resourceToSkill = new Map<number, string>();
	for (const recipe of rawExtractionRecipes) {
		if (recipe.level_requirements && recipe.level_requirements.length > 0) {
			const skillId = recipe.level_requirements[0].skill_id;
			const skill = skills.get(skillId);
			if (skill) {
				resourceToSkill.set(recipe.resource_id, skill.name);
			}
		}
	}

	// For each resource, map cargo yields to their gathering skill
	for (const resource of rawResources) {
		const skillName = resourceToSkill.get(resource.id);
		if (!skillName) continue;

		for (const yieldItem of resource.on_destroy_yield || []) {
			if (yieldItem.item_type === 'Cargo') {
				// Map this cargo ID to the gathering skill
				cargoToSkill.set(yieldItem.item_id, skillName);
			}
		}
	}

	// Add tag-based mappings for cargo not in resource yields (e.g., fish cargo)
	for (const cargo of rawCargos) {
		if (!cargoToSkill.has(cargo.id) && CARGO_TAG_TO_SKILL[cargo.tag]) {
			cargoToSkill.set(cargo.id, CARGO_TAG_TO_SKILL[cargo.tag]);
		}
	}

	return cargoToSkill;
}

/**
 * Build a mapping from output item ID to cargo source skill name
 * For items produced by recipes that consume Cargo (e.g., Fish Oil from Fish Cargo)
 */
function buildItemToCargoSkillMap(
	rawRecipes: RawRecipe[],
	cargoToSkill: Map<number, string>,
	rawCargos: RawCargo[]
): Map<number, string> {
	const itemToCargoSkill = new Map<number, string>();

	// Build cargo lookup for tag-based fallback
	const cargoById = new Map<number, RawCargo>();
	for (const cargo of rawCargos) {
		cargoById.set(cargo.id, cargo);
	}

	for (const raw of rawRecipes) {
		// Skip recipes with no output
		if (!raw.crafted_item_stacks || raw.crafted_item_stacks.length === 0) {
			continue;
		}

		// Skip recipes from excluded buildings
		if (raw.building_requirement && EXCLUDED_BUILDING_TYPES.has(raw.building_requirement.building_type)) {
			continue;
		}

		// Get the output item ID (Item type only)
		const outputStack = raw.crafted_item_stacks.find((s) => s.item_type === 'Item');
		if (!outputStack) {
			continue;
		}

		// Check if recipe consumes Cargo
		const cargoInputs = (raw.consumed_item_stacks || []).filter((s) => s.item_type === 'Cargo');
		if (cargoInputs.length === 0) {
			continue;
		}

		// Find the cargo source skill
		// First try cargoToSkill, then fall back to tag-based mapping
		for (const cargoInput of cargoInputs) {
			let skillName = cargoToSkill.get(cargoInput.item_id);

			// Fall back to tag-based mapping if not in cargoToSkill
			if (!skillName) {
				const cargo = cargoById.get(cargoInput.item_id);
				if (cargo && CARGO_TAG_TO_SKILL[cargo.tag]) {
					skillName = CARGO_TAG_TO_SKILL[cargo.tag];
				}
			}

			if (skillName) {
				itemToCargoSkill.set(outputStack.item_id, skillName);
				break;
			}
		}
	}

	return itemToCargoSkill;
}

/**
 * Build mapping: items inside item lists -> source skill
 * For items produced by opening item list reference items
 * Example: Fish Oil comes from opening "Breezy Fin Darter Products" which is crafted with Fishing
 */
function buildItemFromListToSkillMap(
	rawItems: RawItem[],
	rawRecipes: RawRecipe[],
	rawItemLists: RawItemList[],
	skills: Map<number, SkillInfo>
): Map<number, string> {
	const itemFromListToSkill = new Map<number, string>();

	// Build item list lookup
	const itemListById = new Map<number, RawItemList>();
	for (const list of rawItemLists) {
		itemListById.set(list.id, list);
	}

	// Find items that have item_list_id (these are "item list reference" items)
	// and find recipes that produce them to get the source skill
	const itemListRefToSkill = new Map<number, string>();

	// First, find recipes that produce item list reference items and get their skill
	for (const raw of rawRecipes) {
		if (!raw.crafted_item_stacks || raw.crafted_item_stacks.length === 0) continue;
		if (raw.building_requirement && EXCLUDED_BUILDING_TYPES.has(raw.building_requirement.building_type)) continue;

		// Get skill from recipe
		const skillId = raw.level_requirements?.[0]?.skill_id;
		if (!skillId) continue;
		const skill = skills.get(skillId);
		if (!skill) continue;

		// Check if output is an item
		const outputStack = raw.crafted_item_stacks.find((s) => s.item_type === 'Item');
		if (!outputStack) continue;

		// Store skill for this output item (might be an item list reference)
		// Only store if not already set (prefer first/simplest recipe)
		if (!itemListRefToSkill.has(outputStack.item_id)) {
			itemListRefToSkill.set(outputStack.item_id, skill.name);
		}
	}

	// Now map items inside item lists to their source skill
	for (const rawItem of rawItems) {
		// Cast to get item_list_id (not in base RawItem type)
		const item = rawItem as unknown as RawItemWithListId;
		if (!item.item_list_id || item.item_list_id === 0) continue;

		// Get the item list
		const list = itemListById.get(item.item_list_id);
		if (!list) continue;

		// Get the skill that produces this item list reference
		const skillName = itemListRefToSkill.get(item.id);
		if (!skillName) continue;

		// Map all items inside this list to the source skill
		for (const poss of list.possibilities || []) {
			for (const itemStack of poss.items || []) {
				if (itemStack.item_type !== 'Item') continue;
				// Only set if not already mapped (prefer more direct mappings)
				if (!itemFromListToSkill.has(itemStack.item_id)) {
					itemFromListToSkill.set(itemStack.item_id, skillName);
				}
			}
		}
	}

	return itemFromListToSkill;
}
