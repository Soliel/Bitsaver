import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
	plugins: [svelte({ hot: false })],
	test: {
		include: ['src/**/*.{test,spec}.{js,ts}'],
		globals: true,
		environment: 'node',
		coverage: {
			provider: 'v8',
			include: ['src/lib/**/*.ts'],
			exclude: ['src/lib/**/*.svelte.ts'] // Exclude svelte state files for now
		}
	},
	resolve: {
		alias: {
			$lib: '/home/soliel/code/bithelper/src/lib'
		}
	}
});
