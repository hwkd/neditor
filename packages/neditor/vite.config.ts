import { defineConfig } from 'vite-plus';

/**
 * The public types name DOM globals — `HTMLElement` and `ShadowRoot` on the
 * options, `Document`, `Node`, `Element` and `DocumentFragment` across the
 * serializers — so the emitted declarations do not stand up on their own. The
 * consumer whose `tsconfig` omits the `dom` lib is precisely the Node-only
 * server the README sends at the headless serializers, and without this they
 * cannot typecheck the package at all: each of those names resolves to nothing.
 *
 * The directive lives on the declaration output rather than in `src`, because
 * the bundler rewrites the entry and would not carry a triple-slash comment
 * through from there.
 */
const DTS_LIB_REFERENCE = '/// <reference lib="dom" />';

export default defineConfig({
  pack: {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    // Off deliberately: tsdown embeds every source file in the map, so shipping
    // one publishes the full commented source alongside the bundle.
    sourcemap: false,
    clean: true,
    // Declarations only. The bundler still opens the JavaScript with the blank
    // line the (absent) `js` banner would have occupied; one byte is a fair
    // price for keeping this declarative rather than rewriting files by hand
    // in a build hook.
    banner: { dts: DTS_LIB_REFERENCE },
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
