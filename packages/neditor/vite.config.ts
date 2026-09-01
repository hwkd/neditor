import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
  },
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      // `include` alone makes v8 count every matching file, not just the ones
      // the tests happened to import — which is what flattered the number
      // badly: 95% became 31% once every source file was counted.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
