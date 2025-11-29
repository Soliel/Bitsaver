import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const BITJITA_API_BASE = 'https://bitjita.com/api';
const APP_IDENTIFIER = 'bitsaver';

export const GET: RequestHandler = async ({ params, url }) => {
	const path = params.path || '';
	const targetUrl = new URL(`${BITJITA_API_BASE}/${path}`);

	// Forward query parameters
	url.searchParams.forEach((value, key) => {
		targetUrl.searchParams.set(key, value);
	});

	try {
		const response = await fetch(targetUrl.toString(), {
			method: 'GET',
			headers: {
				Accept: 'application/json',
				'x-app-identifier': APP_IDENTIFIER
			}
		});

		if (!response.ok) {
			const message = await response.text().catch(() => response.statusText);
			error(response.status, message);
		}

		const data = await response.json();
		return json(data);
	} catch (e) {
		console.error('API proxy error:', e);
		error(500, 'Failed to fetch from Bitjita API');
	}
};
