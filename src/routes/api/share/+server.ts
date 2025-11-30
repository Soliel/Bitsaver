import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { supabase } from '$lib/server/supabase';
import { generateShareToken } from '$lib/server/share-tokens';
import { validateAndSanitizeList } from '$lib/server/validation';

// Rate limiting (in-memory, resets on deploy/restart)
const requestCounts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX_REQUESTS = 10; // 10 shares per hour per IP

/**
 * POST /api/share - Create a new shared list
 *
 * Request body: CraftingList object
 * Response: { shareUrl, token, expiresAt }
 */
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	try {
		// Rate limiting by IP
		const clientIp = getClientAddress();
		const ipHash = await hashIp(clientIp);

		if (!checkRateLimit(ipHash)) {
			error(429, 'Too many requests. Please try again later.');
		}

		// Check content length to prevent large payloads
		const contentLength = request.headers.get('content-length');
		if (contentLength && parseInt(contentLength) > 100_000) {
			error(413, 'Request too large');
		}

		// Parse request body
		const body = await request.json().catch(() => null);

		if (!body) {
			error(400, 'Invalid request body');
		}

		// Validate and sanitize the list
		const result = validateAndSanitizeList(body);

		if (!result.valid) {
			error(400, result.error || 'Invalid list data');
		}

		const sanitizedList = result.sanitized!;

		// Generate secure token
		const shareToken = generateShareToken();

		// Calculate expiry (7 days from now)
		const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

		// Insert into database
		const { data, error: dbError } = await supabase
			.from('shared_lists')
			.insert({
				share_token: shareToken,
				list_data: sanitizedList,
				list_name: sanitizedList.name,
				entry_count: sanitizedList.entries.length,
				expires_at: expiresAt
			})
			.select('share_token, expires_at')
			.single();

		if (dbError) {
			console.error('Database error creating share:', dbError);
			error(500, 'Failed to create share link');
		}

		// Cleanup expired shares (fire and forget - don't block response)
		supabase
			.from('shared_lists')
			.delete()
			.lt('expires_at', new Date().toISOString())
			.then(({ error: cleanupError }) => {
				if (cleanupError) {
					console.error('Failed to cleanup expired shares:', cleanupError);
				}
			});

		return json({
			shareUrl: `/share/${data.share_token}`,
			token: data.share_token,
			expiresAt: data.expires_at
		});
	} catch (e) {
		// Re-throw SvelteKit errors
		if (e && typeof e === 'object' && 'status' in e) throw e;

		console.error('Share creation error:', e);
		error(500, 'Internal server error');
	}
};

/**
 * Check rate limit for an IP hash.
 * Returns true if request is allowed.
 */
function checkRateLimit(ipHash: string): boolean {
	const now = Date.now();
	const record = requestCounts.get(ipHash);

	if (!record || record.resetAt < now) {
		// First request in window or window expired
		requestCounts.set(ipHash, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
		return true;
	}

	if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
		return false;
	}

	record.count++;
	return true;
}

/**
 * Hash an IP address for privacy-preserving rate limiting.
 * Uses SHA-256 with a salt to prevent reverse lookup.
 */
async function hashIp(ip: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(ip + 'bitsaver-share-salt-v1');
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}
