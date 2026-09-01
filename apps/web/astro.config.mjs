// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  vite: {
    optimizeDeps: {
      // Keep the linked workspace package out of the pre-bundle cache so
      // `vp pack --watch` rebuilds show up in the dev server immediately.
      exclude: ['@neditor/core'],
    },
  },
});
