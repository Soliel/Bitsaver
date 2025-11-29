/**
 * User settings state
 * Persisted to localStorage
 */

import { browser } from '$app/environment';
import type { UserConfig, AccessibleClaim } from '$lib/types/app';

const STORAGE_KEY = 'bithelper-config';

// Default configuration
const defaultConfig: UserConfig = {
	playerId: undefined,
	playerName: undefined,
	accessibleClaims: [],
	inventoryLastSync: undefined,
	autoRefreshMinutes: 5,
	theme: 'dark'
};

// Load from localStorage
function loadConfig(): UserConfig {
	if (!browser) return defaultConfig;

	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) {
			return { ...defaultConfig, ...JSON.parse(stored) };
		}
	} catch (e) {
		console.error('Failed to load settings:', e);
	}

	return defaultConfig;
}

// State object - exported as object so properties can be mutated
export const settings = $state<UserConfig>(loadConfig());

// Save to localStorage whenever settings change
if (browser) {
	$effect.root(() => {
		$effect(() => {
			// Access all properties to track them
			const snapshot = {
				playerId: settings.playerId,
				playerName: settings.playerName,
				accessibleClaims: settings.accessibleClaims,
				inventoryLastSync: settings.inventoryLastSync,
				autoRefreshMinutes: settings.autoRefreshMinutes,
				theme: settings.theme
			};

			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
			} catch (e) {
				console.error('Failed to save settings:', e);
			}
		});
	});
}

// Actions
export function setPlayer(playerId: string, playerName?: string): void {
	settings.playerId = playerId;
	settings.playerName = playerName;
}

export function setAccessibleClaims(claims: AccessibleClaim[]): void {
	settings.accessibleClaims = claims;
}

export function updateInventorySyncTime(): void {
	settings.inventoryLastSync = Date.now();
}

export function isInventoryStale(): boolean {
	if (!settings.inventoryLastSync) return true;
	if (settings.autoRefreshMinutes === 0) return false;

	const staleThreshold = settings.autoRefreshMinutes * 60 * 1000;
	return Date.now() - settings.inventoryLastSync > staleThreshold;
}

export function setAutoRefresh(minutes: number): void {
	settings.autoRefreshMinutes = Math.max(0, minutes);
}

export function setTheme(theme: UserConfig['theme']): void {
	settings.theme = theme;
}

export function resetSettings(): void {
	settings.playerId = defaultConfig.playerId;
	settings.playerName = defaultConfig.playerName;
	settings.accessibleClaims = [...defaultConfig.accessibleClaims];
	settings.inventoryLastSync = defaultConfig.inventoryLastSync;
	settings.autoRefreshMinutes = defaultConfig.autoRefreshMinutes;
	settings.theme = defaultConfig.theme;
}
