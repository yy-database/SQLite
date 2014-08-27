// Nifty project configuration for SQLite (hybrid cargo + pnpm).
import { defineConfig } from '@doki-land/nifty';

export default defineConfig({
    format: {
        preset: 'nifty',
        style: {
            indentStyle: 'space',
            indentWidth: 4,
            lineWidth: 144,
            quoteStyle: 'single',
        },
        includes: ['package.json', 'nifty.config.ts', 'scripts/**', 'projects/sqlite.ts/**'],
        excludes: [
            '**/node_modules/**',
            '**/dist/**',
            '**/target/**',
            '**/.vite/**',
            '**/pnpm-lock.yaml',
            '**/*.md',
            '**/*.css',
            '**/*.html',
            'projects/sqlite.ts/platforms/sqlite-wasm/pkg/**',
        ],
    },
});
