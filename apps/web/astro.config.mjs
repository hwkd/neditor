// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  vite: {
    server: {
      // Set by the e2e suite (see apps/e2e/playwright.config.ts): a port Vite
      // cannot bind is an error rather than a move to another port, which
      // Playwright would not be watching. `vp run dev` keeps Vite's default.
      strictPort: Boolean(process.env.DEMO_STRICT_PORT),
    },
    optimizeDeps: {
      // Keep the linked workspace package out of the pre-bundle cache so
      // `vp pack --watch` rebuilds show up in the dev server immediately.
      exclude: ['@neditor/core'],
    },
  },
});
