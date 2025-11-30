import { randomBytes } from 'crypto';

/**
 * Generate a cryptographically secure share token.
 *
 * Security properties:
 * - 256 bits of entropy (32 bytes)
 * - URL-safe base64 encoding (no +, /, or = characters)
 * - No predictable patterns
 * - Cannot be enumerated (2^256 possible values)
 *
 * @returns 43-character URL-safe token
 */
export function generateShareToken(): string {
	const bytes = randomBytes(32);

	// Convert to URL-safe base64 (replace +, /, remove =)
	return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Validate token format without database lookup.
 * Rejects obviously invalid tokens early to avoid unnecessary DB queries.
 *
 * @param token - The token string to validate
 * @returns true if token has valid format
 */
export function isValidTokenFormat(token: string): boolean {
	// Must be 43 characters (32 bytes in URL-safe base64 without padding)
	if (token.length !== 43) return false;

	// Must contain only URL-safe base64 characters
	if (!/^[A-Za-z0-9_-]+$/.test(token)) return false;

	return true;
}
