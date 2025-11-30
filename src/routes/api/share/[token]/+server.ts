import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabase } from '$lib/server/supabase';
import { isValidTokenFormat } from '$lib/server/share-tokens';

/**
 * GET /api/share/[token] - Retrieve a shared list
 *
 * Response: { list, name, entryCount, expiresAt, createdAt }
 * Errors: 404 for invalid, expired, or non-existent tokens
 */
export const GET: RequestHandler = async ({ params }) => {
	const { token } = params;

	// Early format validation to avoid DB lookup for garbage
	if (!isValidTokenFormat(token)) {
		// Generic error - don't reveal that format was wrong
		error(404, 'Share not found or has expired');
	}

	// Fetch from database (only non-expired shares)
	const { data, error: dbError } = await supabase
		.from('shared_lists')
		.select('list_data, list_name, entry_count, expires_at, created_at')
		.eq('share_token', token)
		.gt('expires_at', new Date().toISOString())
		.single();

	if (dbError || !data) {
		// Generic error - don't reveal if token exists but expired
		error(404, 'Share not found or has expired');
	}

	return json({
		list: data.list_data,
		name: data.list_name,
		entryCount: data.entry_count,
		expiresAt: data.expires_at,
		createdAt: data.created_at
	});
};
