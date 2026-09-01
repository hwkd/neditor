import { defineConfig } from 'vite-plus';

export default defineConfig({
  // Monorepo task running with content-hash caching.
  run: {
    cache: true,
  },

  // `vp dev` at the root targets the Astro app; `vp pack` targets the library.
  defaultPackage: {
    dev: './apps/web',
    build: './apps/web',
    preview: './apps/web',
    pack: './packages/neditor',
  },

  lint: {
    plugins: ['typescript'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    ignorePatterns: ['**/dist/**', '**/.astro/**', '**/node_modules/**'],
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
    overrides: [
      {
        files: ['**/*.test.ts'],
        plugins: ['vitest'],
        rules: {
          'typescript/no-explicit-any': 'off',
        },
      },
    ],
  },

  fmt: {
    semi: true,
    singleQuote: true,
  },

  staged: {
    '*': 'vp check --fix',
  },
});
