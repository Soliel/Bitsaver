import type { SerializedCraftingList, SerializedListEntry } from './supabase';

// Maximum sizes to prevent abuse
const MAX_LIST_NAME_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_ENTRIES = 100;
const MAX_QUANTITY_PER_ENTRY = 1_000_000;

export interface ValidationResult {
	valid: boolean;
	error?: string;
	sanitized?: SerializedCraftingList;
}

interface EntryValidationResult {
	valid: boolean;
	error?: string;
	sanitized?: SerializedListEntry;
}

/**
 * Validate and sanitize a CraftingList for sharing.
 *
 * Security considerations:
 * - Strips sensitive data (sourceIds, timestamps, list ID)
 * - Limits payload size to prevent DoS
 * - Validates all numeric IDs are positive integers
 * - Sanitizes string content (removes control characters)
 */
export function validateAndSanitizeList(list: unknown): ValidationResult {
	// Type check the input
	if (!list || typeof list !== 'object') {
		return { valid: false, error: 'Invalid list format' };
	}

	const listObj = list as Record<string, unknown>;

	// Validate name
	if (!listObj.name || typeof listObj.name !== 'string') {
		return { valid: false, error: 'List name is required' };
	}

	if (listObj.name.length > MAX_LIST_NAME_LENGTH) {
		return { valid: false, error: `List name exceeds ${MAX_LIST_NAME_LENGTH} characters` };
	}

	// Validate description (optional)
	if (
		listObj.description !== undefined &&
		listObj.description !== null &&
		typeof listObj.description !== 'string'
	) {
		return { valid: false, error: 'Invalid description format' };
	}

	const description = listObj.description as string | undefined;
	if (description && description.length > MAX_DESCRIPTION_LENGTH) {
		return { valid: false, error: `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters` };
	}

	// Validate entries
	if (!Array.isArray(listObj.entries)) {
		return { valid: false, error: 'Entries must be an array' };
	}

	if (listObj.entries.length > MAX_ENTRIES) {
		return { valid: false, error: `List exceeds maximum of ${MAX_ENTRIES} entries` };
	}

	if (listObj.entries.length === 0) {
		return { valid: false, error: 'List must have at least one entry' };
	}

	// Validate each entry
	const sanitizedEntries: SerializedListEntry[] = [];

	for (let i = 0; i < listObj.entries.length; i++) {
		const entry = listObj.entries[i];
		const entryResult = validateEntry(entry, i);
		if (!entryResult.valid) {
			return { valid: false, error: entryResult.error };
		}
		sanitizedEntries.push(entryResult.sanitized!);
	}

	// Build sanitized output
	const sanitized: SerializedCraftingList = {
		name: sanitizeString(listObj.name as string),
		entries: sanitizedEntries
	};

	if (description) {
		sanitized.description = sanitizeString(description);
	}

	return { valid: true, sanitized };
}

function validateEntry(entry: unknown, index: number): EntryValidationResult {
	if (!entry || typeof entry !== 'object') {
		return { valid: false, error: `Entry ${index}: Invalid format` };
	}

	const e = entry as Record<string, unknown>;

	// Validate type
	if (!['item', 'cargo', 'building'].includes(e.type as string)) {
		return { valid: false, error: `Entry ${index}: Invalid type` };
	}

	// Validate quantity
	if (typeof e.quantity !== 'number' || e.quantity <= 0) {
		return { valid: false, error: `Entry ${index}: Quantity must be positive` };
	}

	if (e.quantity > MAX_QUANTITY_PER_ENTRY) {
		return { valid: false, error: `Entry ${index}: Quantity exceeds maximum` };
	}

	if (!Number.isInteger(e.quantity)) {
		return { valid: false, error: `Entry ${index}: Quantity must be an integer` };
	}

	const sanitized: SerializedListEntry = {
		type: e.type as 'item' | 'cargo' | 'building',
		quantity: e.quantity
	};

	// Type-specific validation
	if (e.type === 'item') {
		if (!isValidId(e.itemId)) {
			return { valid: false, error: `Entry ${index}: Invalid item ID` };
		}
		sanitized.itemId = e.itemId as number;

		if (e.recipeId !== undefined && e.recipeId !== null) {
			if (!isValidId(e.recipeId)) {
				return { valid: false, error: `Entry ${index}: Invalid recipe ID` };
			}
			sanitized.recipeId = e.recipeId as number;
		}
	} else if (e.type === 'cargo') {
		if (!isValidId(e.cargoId)) {
			return { valid: false, error: `Entry ${index}: Invalid cargo ID` };
		}
		sanitized.cargoId = e.cargoId as number;
	} else if (e.type === 'building') {
		if (!isValidId(e.constructionRecipeId)) {
			return { valid: false, error: `Entry ${index}: Invalid construction recipe ID` };
		}
		sanitized.constructionRecipeId = e.constructionRecipeId as number;
	}

	return { valid: true, sanitized };
}

function isValidId(id: unknown): boolean {
	return typeof id === 'number' && Number.isInteger(id) && id > 0 && id < Number.MAX_SAFE_INTEGER;
}

/**
 * Remove control characters from string (except newlines/tabs for descriptions)
 */
function sanitizeString(str: string): string {
	return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}
