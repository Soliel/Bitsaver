/**
 * Game data types from Bitjita API
 */

// Item from game data JSON
export interface Item {
	id: number;
	name: string;
	description: string;
	iconAssetName: string;
	tier: number; // 1-10, -1 for special items
	rarity: number;
	rarityStr: string;
	tag: string; // Category
	// Pre-computed material cost fields (from material_costs.json)
	materialCost?: number;
	defaultRecipeId?: number;
}

// Skill info (from skill_desc.json)
export interface SkillInfo {
	id: number;
	name: string;
	title: string;
	category: 'Profession' | 'Adventure' | 'None';
}

// Tool type info (from tool_type_desc.json)
export interface ToolTypeInfo {
	id: number;
	name: string;
	skillId: number;
}

// Building type info (from building_type_desc.json)
export interface BuildingTypeInfo {
	id: number;
	name: string;
	category: string;
}

// Full item with recipes
export interface ItemWithRecipes extends Item {
	craftingRecipes: Recipe[];
	extractionRecipes: Recipe[];
	recipesUsingItem: RecipeReference[];
	relatedSkills: Skill[];
	marketStats?: MarketStats;
	itemListPossibilities?: ItemListPossibility[];
}

// Recipe structure
export interface Recipe {
	id: number;
	name: string;
	outputItemId: number;
	outputQuantity: number;
	craftingStationId?: number;
	craftingStationName?: string;
	craftingStationTier?: number;
	ingredients: RecipeIngredient[];
	levelRequirements: LevelRequirement[];
	toolRequirements: ToolRequirement[];
	// Pre-computed cost (from material_costs.json)
	cost?: number;
}

export interface RecipeIngredient {
	itemId: number;
	quantity: number;
}

export interface LevelRequirement {
	level: number;
	skillId: number;
	skillName: string;
	skillIcon: string;
	skillTitle: string;
}

export interface ToolRequirement {
	level: number;
	power: number;
	toolType: number;
	name: string;
	skillId: number;
}

// Reference to a recipe (used in recipesUsingItem)
export interface RecipeReference {
	recipeId: number;
	itemId: number;
	itemName: string;
	quantity: number;
}

// Skill info
export interface Skill {
	id: number;
	name: string;
	icon: string;
	title: string;
	category: 'profession' | 'adventure';
}

// Market statistics
export interface MarketStats {
	lowestAsk?: number;
	highestBid?: number;
	volume24h?: number;
}

// Item list possibilities (for random drops)
export interface ItemListPossibility {
	itemId: number;
	chance: number;
}

// Building from /api/buildings
export interface Building {
	entityId: string;
	buildingDescriptionId: number;
	buildingName: string;
	buildingNickname?: string;
	iconAssetName: string;
	functions: BuildingFunction[];
}

export interface BuildingFunction {
	cargoSlots: number;
	storageSlots: number;
	craftingSlots: number;
	refiningSlots: number;
	housingSlots: number;
	itemSlotSize: number;
	cargoSlotSize: number;
	level: number;
	tradeOrders: number;
	concurrentCraftsPerPlayer: number;
	terraform: boolean;
	housingIncome: number;
	buffIds: number[];
	allowedItemIdPerSlot: number[];
	functionType: number;
	power: number;
}

// Material tree node for crafting calculations
export interface MaterialNode {
	item: Item;
	quantity: number;
	tier: number;
	children: MaterialNode[];
	recipeUsed?: Recipe;
}

// Flattened material for display
export interface FlatMaterial {
	itemId: number;
	item: Item;
	quantity: number;
	tier: number;
	step: number; // 1 = raw/gathered materials, 2+ = crafted from previous step
}

// Pre-computed material costs data (from material_costs.json)
export interface MaterialCostsData {
	version: string;
	generatedAt: string;
	sourceHash: string;
	stats: {
		totalItems: number;
		bySource: {
			tier: number;
			extraction: number;
			crafting: number;
			item_list: number;
		};
		recipesWithCosts: number;
		itemsWithDefaultRecipe: number;
		circularDependencies: number;
	};
	items: Record<
		string,
		{
			materialCost: number;
			source: 'tier' | 'extraction' | 'crafting' | 'item_list';
			defaultRecipeId?: number;
		}
	>;
	recipes: Record<string, { cost: number }>;
}
