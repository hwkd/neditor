<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# neditor

A monorepo for an independently built, Notion-like block editor, packaged as a reusable, framework-free library.

- `packages/neditor` — `@neditor/core`. Vanilla TypeScript, compiled to vanilla JS. **Never add a framework dependency here**, and keep `dependencies` empty: the package must stay drop-in for any web app.
- `apps/web` — Astro 7 site that consumes the package and serves as the dev harness.

## Conventions

- The document model in `src/model/document.ts` is a **flat, ordered block list**. Nesting is the numeric `depth` field, not a tree. Structural edits are pure functions returning new arrays — keep them that way, it is what will make undo/redo cheap.
- The renderer **reconciles**; it does not re-render. Writing `textContent` on every keystroke destroys the caret, so `#updateView` only touches the DOM when it has genuinely drifted from the model. Text-only edits update the model and deliberately skip a render.
- Text is a list of **runs** (`model/rich-text.ts`), not a string: formatting is interval arithmetic over character offsets, never DOM surgery. Every operation there is pure, offset-based, and ends in `normalizeRuns`, so structurally equal content is deeply equal. Nothing in that module may touch the DOM — that translation lives in `view/rich-dom.ts`.
- Typing is **DOM-first**: the browser edits the contenteditable and `#handleInput` reads it back with `parseRichText`. That is what keeps IME, autocorrect and spellcheck working, and it is why the renderer must be told (`syncFromDom`) that the DOM is already ahead of the last render. Formatting commands go the other way — model first, then re-render and restore the selection by offset.
- **History is snapshot-based** (`model/history.ts`), which only works because every edit returns a new block array while reusing untouched blocks. Anything that mutates `#blocks` in place would silently corrupt the undo stack — don't. Entries are recorded _before_ an edit, and `#commit` does it for you; `#applyBlocks` is the deliberate escape hatch that skips history and exists for undo/redo itself.
- **Two selection modes, never both**: a text range inside one block, or a set of whole blocks (`#selected`). Entering block selection drops the DOM selection and focuses the root, which is why the root carries `tabindex="-1"` and why block keystrokes are routed before the text handlers. Anything that changes the document must leave the invariant intact — `#pruneBlockSelection` drops ids the new document no longer has.
- **Every block is its own `contenteditable`.** That is what keeps the reconciling renderer and caret restoration simple, but it means a browser will never extend a selection across two blocks: `Selection` stays inside one editing host. Any cross-block gesture must be synthesized — pointer drags via `#updateTextDrag`, `Shift`+arrow via `#extendFromTextToBlocks`. Never write a feature that waits for a cross-block DOM range from user input, and never verify one by building that range with the Selection API — it proves nothing a mouse can reproduce.
- **Never put an ARIA role on a block's content element.** The tag is chosen for its semantics (`h1`, `blockquote`, `code`); `role="textbox"` would win over it and erase heading and quote navigation for every screen reader. `contenteditable` already exposes an editable field on top of the element's own role. Same for `aria-multiline` — Shift+Enter really does insert a newline.
- **Tab must never be swallowed unconditionally.** It may only `preventDefault()` when the indent actually changes something; otherwise the editor is a keyboard trap (WCAG 2.1.2). The guaranteed exits are Shift+Tab at depth 0 and Escape twice — keep both working.
- **`toMarkdown` output is parsed again by `blocksFromMarkdown`.** Anything emitted unescaped is silently reinterpreted — `2 * 3 * 4` came back italic with characters missing. Run text goes through `escapeMarkdownText`, and `parseInlineMarkdown` matches rules against a projection where escaped characters are replaced by a placeholder, so offsets stay aligned with the content. Change one side and you must change the other.
- **Never brand-check DOM values with `instanceof`.** The editor is mounted into foreign documents on purpose (iframes, shadow roots); `instanceof Node` compares against the script's own realm and silently rejects perfectly valid nodes. Use the duck-typed helpers in `util/dom.ts`.
- **The clipboard is symmetric and must stay that way**: `blocksToHtml` and `blocksFromHtml` are round-trip partners, as are `toMarkdown` and `blocksFromMarkdown`. Nesting is carried by real `<ul>`/`<ol>` nesting and, for non-list blocks, a `data-neditor-depth` attribute — never by `margin-left` alone, which looks right but does not parse back. Any change to one side needs the round-trip tests in `rich-dom.test.ts` extended, and they must assert depth, not just text.
- **A block can have more than one editable host.** A table cell is a `.neditor-block__content` like any other, tagged `data-cell="row:column"`, so `#resolve` returns the host the event actually came from and every caret, selection and input path works against it unchanged. Read and write that host's text through `#contentOf` / `#commitResolved` / `#focusResolved` rather than `block.content` — reaching for `block.content` directly is what silently breaks tables.
- **Hidden blocks travel with whatever hides them.** A collapsed toggle's children are still in `#blocks` but absent from the rendered view, so `#setBlockSelection` grows every selection through `withHiddenDescendants`. Any new operation on a block set must go through a selection, or apply that expansion itself — otherwise a move or delete silently orphans blocks the user cannot see. Navigation and geometry (`focus`, caret stepping, drop gaps, `#blockIdAtY`) run over `#visible()`, while ranges and edits run over the full `#blocks`.
- **Depth is re-clamped, not trusted**: `normalizeDepths` runs after every multi-block edit so no block is ever more than one level below its predecessor. New structural operations should end with it.
- Drop indicators and the gutter position themselves with `offsetTop`/`offsetLeft` against the root, not `getBoundingClientRect`, so they survive page scrolling. The gutter's space is reserved by padding on `.neditor-block`, not on the root — a host stylesheet with higher specificity (Astro's scoped styles, for one) would win against the root.
- `parseRichText` is a **trust boundary**: it also consumes pasted HTML. Anything not in `SKIP_TAGS` contributes text, and only `sanitizeUrl`-approved hrefs become links. Add new element handling there, not in the editor.
- Floating UI is portalled to `document.body`, so it sits outside `.neditor` and does not inherit its custom properties. Use `ui/portal.ts`: it applies the `neditor-portal` class the theme tokens key off, and `positionPortal` measures the real element rather than estimating. Never call `scrollIntoView` inside a fixed portal — it scrolls the page to the portal's layout origin.
- Styles live as a string in `src/styles.ts` and are injected at runtime. This is what lets the package work with no CSS loader. Theme through the custom properties on `.neditor`.

## Dependency constraints

- **TypeScript stays on 6.x.** `@astrojs/check` peer-depends on `^5 || ^6`.
- **Do not alias `vite` to `@voidzero-dev/vite-plus-core`.** Astro 7 drives its own Vite 8; the alias resolves `vite` to a 0.x version Astro cannot use. `vitest` is pinned to the exact version Vite+ bundles and should stay pinned.
- `vp pack` emits `index.mjs` / `index.cjs` / `index.d.mts` / `index.d.cts`. The `exports` map in `packages/neditor/package.json` matches those names — update both together.

## Validation

Run `vp run ready` (check, test, build). `vp -C apps/web run check` additionally type-checks `.astro` files via `astro check`.

- **A pointer gesture can end without `pointerup`.** `pointercancel` fires when
  the browser takes a gesture over — a touch that becomes a scroll, a lost
  window focus. Any state a drag opens has to be closed on both events, or the
  drag stays live forever and every later pointer event is misrouted. The drag
  also takes pointer capture so a finger leaving the window still delivers the
  end event.

- **Touch has no hover, so nothing hover-revealed is reachable by it.** The
  gutter is offered on touch `pointerdown` instead, and a long press stands in
  for the click-to-select the mouse gets. Anything new that reveals on hover
  needs its own touch path, and its control needs `touch-action: none` or the
  browser claims the drag for scrolling.

- **A Markdown table needs its delimiter row at index 1, and only there.** A row
  of dashes anywhere else is content — `---` is a common "no value" placeholder,
  and treating it as alignment deleted a row. Lines that fail the check are not
  a table at all and are handed back as paragraphs, never consumed into nothing.
