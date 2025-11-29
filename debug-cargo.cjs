const fs = require('fs');
const craftingRecipes = JSON.parse(fs.readFileSync('static/game_data/crafting_recipe_desc.json'));
const skills = JSON.parse(fs.readFileSync('static/game_data/skill_desc.json'));
const items = JSON.parse(fs.readFileSync('static/game_data/item_desc.json'));

const skillMap = new Map(skills.map(s => [s.id, s.name]));
const itemMap = new Map(items.map(i => [i.id, i]));

// Find ALL recipes that produce Fish Oil (1110010)
console.log('All recipes that produce Basic Fish Oil (1110010):');
for (const recipe of craftingRecipes) {
  if (!recipe.crafted_item_stacks) continue;
  const output = recipe.crafted_item_stacks.find(s => s.item_id === 1110010);
  if (output) {
    const skill = skillMap.get(recipe.level_requirements?.[0]?.skill_id);
    console.log('\nRecipe ID:', recipe.id, '- Name:', recipe.name);
    console.log('  Skill:', skill || 'None');
    console.log('  Consumed items:');
    for (const c of recipe.consumed_item_stacks || []) {
      const item = itemMap.get(c.item_id);
      console.log(`    - ${c.item_id} x${c.quantity} (${c.item_type}) - ${item?.name || 'Unknown'}`);
    }
    console.log('  Output:', output.quantity);

    // Count Item vs Cargo inputs
    const itemInputs = (recipe.consumed_item_stacks || []).filter(c => c.item_type === 'Item');
    const cargoInputs = (recipe.consumed_item_stacks || []).filter(c => c.item_type === 'Cargo');
    console.log(`  Item inputs: ${itemInputs.length}, Cargo inputs: ${cargoInputs.length}`);
  }
}

// Also check what "Ocean Fish Products" produce
console.log('\n\n=== What can be made from Oceanfish Products? ===');
for (const recipe of craftingRecipes) {
  if (!recipe.consumed_item_stacks) continue;
  const input = recipe.consumed_item_stacks.find(s => {
    if (s.item_type !== 'Item') return false;
    const item = itemMap.get(s.item_id);
    return item && item.tag && item.tag.includes('Oceanfish');
  });
  if (input) {
    const inputItem = itemMap.get(input.item_id);
    const skill = skillMap.get(recipe.level_requirements?.[0]?.skill_id);
    console.log('\nRecipe:', recipe.id, '-', recipe.name);
    console.log('  Input:', inputItem?.name);
    console.log('  Skill:', skill);
    for (const out of recipe.crafted_item_stacks || []) {
      if (out.item_type === 'Item') {
        const outItem = itemMap.get(out.item_id);
        console.log('  Output:', outItem?.name);
      }
    }
  }
}
