import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here('./fixtures'),
  // The demo's sample image, so image specs load a real picture.
  publicDir: here('../web/public'),
  resolve: {
    // E2E_SOURCE=1 runs against the package source for a fast local loop;
    // CI always tests the built `dist`, which is what consumers install.
    alias: process.env.E2E_SOURCE
      ? { '@neditor/core': here('../../packages/neditor/src/index.ts') }
      : {},
  },
  server: {
    // E2E_PORT moves the harness off its default, for a machine where another
    // checkout's harness already holds it -- `reuseExistingServer` would
    // otherwise test that checkout's code.
    port: Number(process.env.E2E_PORT ?? 4390),
    strictPort: true,
  },
  build: {
    target: 'es2022',
  },
});
