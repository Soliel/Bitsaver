import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from '$env/static/private';

// Validate required environment variables at startup
if (!SUPABASE_URL) {
	throw new Error('SUPABASE_URL environment variable is required');
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
	throw new Error('SUPABASE_SERVICE_ROLE_KEY environment variable is required');
}

/**
 * Server-only Supabase client with service role key.
 * WARNING: This client bypasses RLS - keep credentials strictly server-side.
 *
 * This module uses $env/static/private which is build-time enforced to
 * only be importable in server-side code (+server.ts, +page.server.ts, etc.)
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
	auth: {
		autoRefreshToken: false,
		persistSession: false
	}
});

/**
 * Database row type for shared_lists table
 */
export interface SharedListRow {
	id: string;
	share_token: string;
	list_data: SerializedCraftingList;
	list_name: string;
	entry_count: number;
	created_at: string;
	expires_at: string;
	access_count: number;
}

/**
 * Serialized list format stored in database.
 * Contains only the essential data needed to reconstruct a list.
 */
export interface SerializedCraftingList {
	name: string;
	description?: string;
	entries: SerializedListEntry[];
}

/**
 * Serialized entry format - union of item, cargo, and building types.
 */
export interface SerializedListEntry {
	type: 'item' | 'cargo' | 'building';
	itemId?: number;
	cargoId?: number;
	constructionRecipeId?: number;
	quantity: number;
	recipeId?: number;
}
