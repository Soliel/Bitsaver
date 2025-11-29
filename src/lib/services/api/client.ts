/**
 * Base API client for Bitjita with rate limiting
 * Rate limit: 250 requests per minute
 */

import { dev } from '$app/environment';

// Use proxy in development to avoid CORS issues
const API_BASE = dev ? '/api/bitjita' : 'https://bitjita.com/api';
const APP_IDENTIFIER = 'bithelper';

// Rate limiting configuration
const RATE_LIMIT_DELAY_MS = 250; // 240 req/min to stay under 250 limit
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Request queue for rate limiting
type QueuedRequest = {
	execute: () => Promise<void>;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

const requestQueue: QueuedRequest[] = [];
let isProcessingQueue = false;
let lastRequestTime = 0;

/**
 * Process the request queue with rate limiting
 */
async function processQueue(): Promise<void> {
	if (isProcessingQueue) return;
	isProcessingQueue = true;

	while (requestQueue.length > 0) {
		const request = requestQueue.shift();
		if (!request) continue;

		// Ensure minimum delay between requests
		const now = Date.now();
		const timeSinceLastRequest = now - lastRequestTime;
		if (timeSinceLastRequest < RATE_LIMIT_DELAY_MS) {
			await sleep(RATE_LIMIT_DELAY_MS - timeSinceLastRequest);
		}

		try {
			await request.execute();
			lastRequestTime = Date.now();
		} catch (error) {
			// Error already handled in execute()
		}
	}

	isProcessingQueue = false;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * API error class
 */
export class ApiError extends Error {
	constructor(
		message: string,
		public status: number,
		public endpoint: string
	) {
		super(message);
		this.name = 'ApiError';
	}
}

/**
 * Request options
 */
export interface RequestOptions {
	params?: Record<string, string | number | boolean | undefined>;
	signal?: AbortSignal;
	skipQueue?: boolean; // For high-priority requests
}

/**
 * Make an API request with rate limiting
 */
export async function apiRequest<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
	return new Promise((resolve, reject) => {
		const execute = async () => {
			let lastError: Error | null = null;

			for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
				try {
					const result = await executeRequest<T>(endpoint, options);
					resolve(result);
					return;
				} catch (error) {
					lastError = error as Error;

					// Don't retry on 4xx errors (client errors)
					if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
						reject(error);
						return;
					}

					// Wait before retrying
					if (attempt < MAX_RETRIES - 1) {
						await sleep(RETRY_DELAY_MS * (attempt + 1));
					}
				}
			}

			reject(lastError || new Error('Request failed after retries'));
		};

		if (options.skipQueue) {
			execute();
		} else {
			requestQueue.push({ execute, resolve: resolve as (value: unknown) => void, reject });
			processQueue();
		}
	});
}

/**
 * Execute a single request
 */
async function executeRequest<T>(endpoint: string, options: RequestOptions): Promise<T> {
	// Build URL - handle both absolute and relative base URLs
	let urlString = `${API_BASE}${endpoint}`;

	// Add query parameters
	if (options.params) {
		const params = new URLSearchParams();
		Object.entries(options.params).forEach(([key, value]) => {
			if (value !== undefined) {
				params.set(key, String(value));
			}
		});
		const queryString = params.toString();
		if (queryString) {
			urlString += `?${queryString}`;
		}
	}

	const response = await fetch(urlString, {
		method: 'GET',
		headers: {
			Accept: 'application/json',
			'x-app-identifier': APP_IDENTIFIER
		},
		signal: options.signal
	});

	if (!response.ok) {
		const message = await response.text().catch(() => response.statusText);
		throw new ApiError(message, response.status, endpoint);
	}

	return response.json();
}

/**
 * Get queue status for debugging/UI
 */
export function getQueueStatus(): { pending: number; isProcessing: boolean } {
	return {
		pending: requestQueue.length,
		isProcessing: isProcessingQueue
	};
}

/**
 * Clear the request queue (useful for cleanup)
 */
export function clearQueue(): void {
	while (requestQueue.length > 0) {
		const request = requestQueue.shift();
		if (request) {
			request.reject(new Error('Request cancelled'));
		}
	}
}
