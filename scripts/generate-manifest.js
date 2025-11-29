/**
 * Generate manifest.json for game data files
 * Creates hashes of all game data JSON files for cache invalidation
 *
 * Run: node scripts/generate-manifest.js
 */

import { createHash } from 'crypto';
import { readFile, writeFile, readdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GAME_DATA_DIR = join(__dirname, '../static/game_data');
const MANIFEST_PATH = join(GAME_DATA_DIR, 'manifest.json');

// Files we care about for the app
const TRACKED_FILES = [
	'item_desc.json',
	'crafting_recipe_desc.json',
	'skill_desc.json',
	'tool_type_desc.json',
	'building_type_desc.json',
	'material_costs.json'
];

async function hashFile(filePath) {
	const content = await readFile(filePath);
	return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

async function generateManifest() {
	console.log('Generating game data manifest...');

	const files = {};
	const hashes = [];

	for (const filename of TRACKED_FILES) {
		const filePath = join(GAME_DATA_DIR, filename);
		try {
			const hash = await hashFile(filePath);
			files[filename] = hash;
			hashes.push(hash);
			console.log(`  ${filename}: ${hash}`);
		} catch (err) {
			console.warn(`  Warning: Could not hash ${filename}: ${err.message}`);
		}
	}

	// Combined hash of all file hashes
	const combinedHash = createHash('sha256').update(hashes.join('')).digest('hex').slice(0, 16);

	const manifest = {
		version: new Date().toISOString().split('T')[0],
		hash: combinedHash,
		generatedAt: new Date().toISOString(),
		files
	};

	await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
	console.log(`\nManifest written to ${MANIFEST_PATH}`);
	console.log(`Combined hash: ${combinedHash}`);
}

generateManifest().catch((err) => {
	console.error('Failed to generate manifest:', err);
	process.exit(1);
});
