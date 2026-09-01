# neditor

A monorepo for reverse-engineering Notion's editor and shipping the result as a
reusable package that any web app can drop in.

- **[`packages/neditor`](packages/neditor)** — `@neditor/core`, the editor.
  Vanilla JavaScript, no framework, no runtime dependencies.
- **[`apps/web`](apps/web)** — an Astro site that consumes the package and doubles
  as the development harness.

## Requirements

- Node.js >= 22.12
- pnpm 11 (`corepack enable`)
- [Vite+](https://viteplus.dev) as the toolchain. The global `vp` CLI delegates to
  the `vite-plus` version pinned in this repo, so a global install is optional:
  every command below also works as `pnpm exec vp …`.

```bash
curl -fsSL https://vite.plus | bash   # installs the global `vp`
```

## Getting started

```bash
pnpm install
vp run dev
```

`vp run dev` starts the Astro dev server on <http://localhost:4321> and, in
parallel, rebuilds `@neditor/core` on change.

## Commands

| Command                       | What it does                                           |
| ----------------------------- | ------------------------------------------------------ |
| `vp run ready`                | Format, lint, type-check, test, and build everything.  |
| `vp check --fix`              | Format and autofix, then lint and type-check.          |
| `vp run -r test`              | Run the test suites.                                   |
| `vp run -r build`             | Build the package, then the site, in dependency order. |
| `vp -C apps/web dev`          | Run only the Astro dev server.                         |
| `vp -C packages/neditor pack` | Build only the library.                                |

Vite+ owns formatting (Oxfmt), linting (Oxlint), type checking (tsgolint), testing
(Vitest), task caching, and library builds (tsdown). Configuration lives in the
root [`vite.config.ts`](vite.config.ts); per-package Vite/Vitest/tsdown settings
live in each package's own `vite.config.ts`.

## Layout

```
.
├── vite.config.ts          Vite+ config: lint, format, tasks, defaults
├── pnpm-workspace.yaml     Workspace globs, dependency catalog, overrides
├── tsconfig.json           Base TypeScript config
├── apps/
│   └── web/                Astro 7 site (the demo and dev harness)
└── packages/
    └── neditor/            @neditor/core — the editor package
```

## Toolchain notes

A few decisions worth knowing before changing dependencies:

- **TypeScript is pinned to 6.x, not 7.** `@astrojs/check` peer-depends on
  `typescript@^5 || ^6`. `vp check` type-checks through tsgolint, which ships
  inside Vite+ and is unaffected by this pin.
- **`vite` is deliberately _not_ aliased to `@voidzero-dev/vite-plus-core`.** The
  Vite+ docs suggest that override for standalone Vite projects; here Astro 7
  drives its own Vite 8, and the alias would resolve `vite` to a 0.x version that
  Astro cannot use. `vitest` _is_ pinned to the exact version Vite+ bundles, so
  the project and `vp test` always share one copy.
- **The library is written in TypeScript and published as vanilla JavaScript.**
  `vp pack` emits ESM, CJS, and type declarations. Consumers need no TypeScript,
  no build step, and no framework.

## Status

The package is a working foundation, not a finished Notion clone. Rich text
(bold, italic, underline, strikethrough, inline code and links), the selection
toolbar, inline and block Markdown input rules, the slash menu, nesting,
undo/redo, block selection with drag handles, callouts, collapsible toggles,
images, tables, and a sanitized multi-block clipboard all work. See the
package README for the known gaps (list semantics, IME input rules, Markdown
round-tripping of empty paragraphs). See [`packages/neditor/README.md`](packages/neditor/README.md#roadmap)
for the full list.
