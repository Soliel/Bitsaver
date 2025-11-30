import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { supabase } from '$lib/server/supabase';
import { isValidTokenFormat } from '$lib/server/share-tokens';

export const load: PageServerLoad = async ({ params }) => {
	const { token } = params;

	// Validate token format before hitting DB
	if (!isValidTokenFormat(token)) {
		error(404, 'Share not found or has expired');
	}

	// Fetch from database
	const { data, error: dbError } = await supabase
		.from('shared_lists')
		.select('list_data, list_name, entry_count, expires_at, created_at')
		.eq('share_token', token)
		.gt('expires_at', new Date().toISOString())
		.single();

	if (dbError || !data) {
		error(404, 'Share not found or has expired');
	}

	return {
		list: data.list_data,
		name: data.list_name,
		entryCount: data.entry_count,
		expiresAt: data.expires_at,
		createdAt: data.created_at
	};
};
