/**
 * Clean up asset paths to handle various formats from game data
 * @param path - Raw icon asset path from game data
 * @param quantity - Optional quantity for HexCoin variants
 * @returns Cleaned path suitable for URL construction
 */
export function cleanAssetPath(path: string, quantity?: number): string {
	// HexCoin has quantity-based icon variants
	if (path.startsWith('Items/HexCoin')) {
		if (!quantity || quantity < 3) {
			return 'OldGeneratedIcons/Items/HexCoin';
		} else if (quantity < 10) {
			return 'OldGeneratedIcons/Items/HexCoin3';
		} else if (quantity < 500) {
			return 'OldGeneratedIcons/Items/HexCoin10';
		} else {
			return 'OldGeneratedIcons/Items/HexCoin500';
		}
	}

	// Buildings need GeneratedIcons/Other/ prefix
	if (path.startsWith('Buildings/')) {
		return 'GeneratedIcons/Other/' + path;
	}

	// Paths not starting with GeneratedIcons use OldGeneratedIcons
	if (!path.startsWith('GeneratedIcons/')) {
		return 'OldGeneratedIcons/' + path;
	}

	// Fix duplicate path like "GeneratedIcons/Other/GeneratedIcons/..."
	return path.replace('GeneratedIcons/Other/GeneratedIcons', 'GeneratedIcons');
}

/**
 * Get the full URL for an item icon
 * @param iconAssetName - The icon asset name from game data
 * @param quantity - Optional quantity for HexCoin variants
 * @returns The full URL to the icon, or null if no icon name provided
 */
export function getItemIconUrl(iconAssetName: string | undefined, quantity?: number): string | null {
	if (!iconAssetName) return null;

	const cleanedPath = cleanAssetPath(iconAssetName, quantity);
	return `/assets/${cleanedPath}.webp`;
}
