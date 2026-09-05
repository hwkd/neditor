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
- **`#commit` is the only recorder, and a no-op is not an edit.** Pass it a run key and a pre-edit selection rather than calling `#recordHistory` yourself and committing afterwards: that pushes the same document twice, and the extra Ctrl+Z restores what the user is already looking at. It also refuses to record when nothing moved, which it can only tell because the pure ops reuse untouched blocks — `sameBlocks` compares the blocks, never the array, since every op hands back a fresh one even for a no-op. Without that test, Cmd+Shift+Arrow at the edge of the document banked an undo step and fired `change` per repeat, so a held key emptied the real history and an autosave listener wrote the same revision over and over. The one path that records on its own is `#syncFromDom`, because typing must not re-render, and it carries its own `richEquals` version of the same test.
- **Two selection modes, never both**: a text range inside one block, or a set of whole blocks (`#selected`). Entering block selection drops the DOM selection and focuses the root, which is why the root carries `tabindex="-1"` and why block keystrokes are routed before the text handlers. Anything that changes the document must leave the invariant intact — `#pruneBlockSelection` drops ids the new document no longer has. The other direction is enforced too: placing a caret ends block selection, so `focus`/`focusRange` clear `#selected` before they place one — and they return `false` when they cannot, because a silent failure leaves the editor in _neither_ mode, where every key falls on the floor. An empty set is never a mode: `#setBlockSelection([])` leaves block selection and hands the caret back.
- **Every block is its own `contenteditable`.** That is what keeps the reconciling renderer and caret restoration simple, but it means a browser will never extend a selection across two blocks: `Selection` stays inside one editing host. Any cross-block gesture must be synthesized — pointer drags via `#updateTextDrag`, `Shift`+arrow via `#extendFromTextToBlocks`. Never write a feature that waits for a cross-block DOM range from user input, and never verify one by building that range with the Selection API — it proves nothing a mouse can reproduce.
- **Never put an ARIA role on a block's content element.** The tag is chosen for its semantics (`h1`, `blockquote`, `code`); `role="textbox"` would win over it and erase heading and quote navigation for every screen reader. `contenteditable` already exposes an editable field on top of the element's own role. Same for `aria-multiline` — Shift+Enter really does insert a newline.
- **Tab must never be swallowed unconditionally.** It may only `preventDefault()` when the indent actually changes something; otherwise the editor is a keyboard trap (WCAG 2.1.2). The guaranteed exits are Shift+Tab at depth 0 and Escape twice — keep both working.
- **`toMarkdown` output is parsed again by `blocksFromMarkdown`.** Anything emitted unescaped is silently reinterpreted — `2 * 3 * 4` came back italic with characters missing. Run text goes through `escapeMarkdownText`, and `parseInlineMarkdown` matches rules against a projection where escaped characters are replaced by a placeholder, so offsets stay aligned with the content. Change one side and you must change the other.
- **Never brand-check DOM values with `instanceof`.** The editor is mounted into foreign documents on purpose (iframes, shadow roots); `instanceof Node` compares against the script's own realm and silently rejects perfectly valid nodes. Use the duck-typed helpers in `util/dom.ts`.
- **The clipboard is symmetric and must stay that way**: `blocksToHtml` and `blocksFromHtml` are round-trip partners, as are `toMarkdown` and `blocksFromMarkdown`. Nesting is carried by real `<ul>`/`<ol>` nesting and, for non-list blocks, a `data-neditor-depth` attribute — never by `margin-left` alone, which looks right but does not parse back. Any change to one side needs the round-trip tests in `rich-dom.test.ts` extended, and they must assert depth, not just text.
- **A block can have more than one editable host.** A table cell is a `.neditor-block__content` like any other, tagged `data-cell="row:column"`, so `#resolve` returns the host the event actually came from and every caret, selection and input path works against it unchanged. Read and write that host's text through `#contentOf` / `#commitResolved` / `#focusResolved` rather than `block.content` — reaching for `block.content` directly is what silently breaks tables.
- **A block's payload is more than its `content`.** A table keeps its text in
  `rows`, an image its picture in `src`/`alt`, a divider holds no text at all —
  so any edit that moves a block by moving its text keeps a fraction of it.
  Merging a pasted table into a paragraph dropped every row, which made pasting
  one into a non-empty block a silent no-op; one `Backspace` in an image caption
  reached `setBlockType(..., 'paragraph')`, which deletes `src`. `canMergeText`
  is the test: a block that fails it is spliced in whole, selected rather than
  retyped, and never handed text it has nowhere to draw. A conversion that _can_
  hold the text rehouses it instead of hiding it — `setBlockType(..., 'table')`
  moves `content` into the first cell, the same way `/divider` already opens a
  paragraph for the text it cannot keep.
- **Hidden blocks travel with whatever hides them.** A collapsed toggle's children are still in `#blocks` but absent from the rendered view, so `#setBlockSelection` grows every selection through `withHiddenDescendants`. Any new operation on a block set must go through a selection, or apply that expansion itself — otherwise a move or delete silently orphans blocks the user cannot see. Navigation and geometry (`focus`, caret stepping, drop gaps, `#blockIdAtY`) run over `#visible()`, while ranges and edits run over the full `#blocks`.
- **Depth is re-clamped, not trusted**: `normalizeDepths` runs after every multi-block edit so no block is ever more than one level below its predecessor. New structural operations should end with it.
- Drop indicators and the gutter position themselves with `offsetTop`/`offsetLeft` against the root, not `getBoundingClientRect`, so they survive page scrolling. The gutter's space is reserved by padding on `.neditor-block`, not on the root — a host stylesheet with higher specificity (Astro's scoped styles, for one) would win against the root.
- `parseRichText` is a **trust boundary**: it also consumes pasted HTML. Anything not in `SKIP_TAGS` contributes text, and only `sanitizeUrl`-approved hrefs become links. Add new element handling there, not in the editor.
- **Foreign content enters through the parser or not at all — and pasting is not the only way in.** A drop carries the same flavours as a clipboard, and the browser's default for one is to write the dragged fragment straight into a live editing host; because typing is DOM-first, `#syncFromDom` then reads that fragment back as the block's own content, the model agrees with the DOM, and nothing later renders it away. So an `<iframe>`, a password form or a fixed full-viewport overlay dragged in from another page _persists_. `#handleDrop` cancels the drop unconditionally — before any check that might give up — and re-enters the payload through `#insertForeignContent`, the single path paste also takes; `#handleBeforeInput` refuses `UNPARSED_INPUT_TYPES` as the backstop for anything that slips past either handler. Any new way content can arrive belongs on that path, never on the browser's default.
- **Input rules fire on insertion, not on deletion.** `#tryBlockRule`, `#tryInlineRule` and `#tryOpenSlashMenu` read the text before the caret and treat it as text just typed; a deletion leaves the identical text there without anyone having typed it, so backspacing the word after a `# ` converted the block and ate the prefix. `#handleInput` gates them on `isInsertion(event)`. `#updateSlashQuery` is deliberately ahead of that gate — an open menu reads the text rather than acting on it, and must still narrow on Backspace and close when the `/` goes.
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
  end event. That capture has a tail: the compatibility `click` after
  `pointerup` is dispatched at the capturing element, so the handle's own click
  hook runs after every drag and collapsed a dragged multi-block selection down
  to the block whose handle was grabbed. A drag and the click it produces are
  one gesture — `#endDrag` arms `#clickEndedDrag` and `#selectFromHandle`
  consumes it, exactly once, so a press that never moved still selects.

- **Touch has no hover, so nothing hover-revealed is reachable by it.** The
  gutter is offered on touch `pointerdown` instead, and a long press stands in
  for the click-to-select the mouse gets. Anything new that reveals on hover
  needs its own touch path, and its control needs `touch-action: none` or the
  browser claims the drag for scrolling. The same asymmetry runs the other way:
  a touch pointer stops existing when the finger lifts and the UA says so with
  `pointerout`/`pointerleave`, the very events a mouse uses for "gone". So a
  hover handler that retracts something must ask `pointerType` first — hiding
  the gutter on any `pointerleave` took it away in the frame it was offered,
  and touch could never reach the `+` or the handle at all.

- **A popover has no owner unless it is given one.** The link, icon and image
  popovers are `role="dialog"` portals: they render outside the editor root and
  take focus away from it, so no listener on the root ever hears that the user
  moved on, and nothing was calling the `contains` methods they already had.
  Dismissal is therefore driven from the document — `#handleDocumentPointerDown`
  closes every open popover the pointer landed outside of, without restoring
  focus, because the pointer is placing it itself. The other half is that
  closing one hands the caret back to the block it was opened from, so "is one
  open" is never the question to ask: every entry from `#openPopovers()` also
  answers `ownedBy`, down to the table cell, and Escape dismisses only the
  popover its own editing host opened. Asking the global question let an Escape
  in an unrelated block teleport the caret across the document.

- **A Markdown table needs its delimiter row at index 1, and only there.** A row
  of dashes anywhere else is content — `---` is a common "no value" placeholder,
  and treating it as alignment deleted a row. Lines that fail the check are not
  a table at all and are handed back as paragraphs, never consumed into nothing.

- **`editable: false` and `destroy()` are contracts, not hints, and one
  predicate answers both.** The renderer keeps drawing its controls in a
  read-only view — the chevron and the checkbox are focusable precisely so a
  keyboard reader can reach them — so reaching one must not be permission to
  write: `toggleCollapsed` was the one that still committed, fired `change` for
  a persistence layer to write back as the author's revision, and lit up
  `canUndo` in a document nobody could edit. A destroyed editor says no for the
  other reason, which is why `#canEdit()` asks both questions in one place. The
  DOM half is `#render`: it is the only place views are built, so it is the only
  place that has to refuse — a `setDocument` after teardown otherwise put
  contenteditable hosts back into a root with no listeners and no `neditor`
  class, and the second `destroy()` returns early, so nothing could remove them
  again.

- **The floating UI belongs in the tree the editor was mounted in.** Styles are
  injected into the mount point's root node so a shadow-rooted editor is styled,
  but the six portals were appended to `document.body`, which that stylesheet
  does not reach — inside a shadow root every menu, toolbar and popover rendered
  with no tokens, no layout and no `position: fixed`. `portalContainer` now
  defaults to that same root node, and the stylesheet is injected into the
  portals' tree as well, because an explicit container can be a third tree
  again.

- **A control is an offer, and an offer that cannot be taken is a lie.** A
  `<button>` wrapped around an `<img>` is the sharp version: `button` makes its
  children presentational and an author `aria-label` beats name-from-content, so
  the alt text the image popover carefully collects was never announced to
  anyone. The picture is a sibling with the trigger laid over it. The same rule
  covers read-only: both image buttons are `disabled` there rather than left as
  tab stops that answer with silence.

- **A newline at the end of a block has no line box of its own.** Under
  `white-space: pre-wrap` the last break ends the last line and there is nothing
  after it to fill another, so Shift+Enter (and Enter in a table cell) left the
  block exactly the same height and the next character landed _in front of_ the
  break. `renderRichText` appends a trailing `<br>` as filler. It is safe to add
  because the parse side already treats a trailing `<br>` as the browser's own
  filler and reads it back as nothing — which is also why each block's runs must
  keep being parsed with that block's own element as the root, or a following
  paragraph would turn the filler into a second newline.

## Invariants the remediation established

These came out of fixing 64 audited defects. Most of them were violated in several
places at once, so they are stated as rules rather than as notes about one call site.

- **Selection anchors live in visible space; hidden descendants are expanded only at
  the edit.** `#blocks` and `#visible()` are different orders, and `findBlockIndex`
  returns `-1` for a block the other list does not hold — which silently reads as
  `visible[0]`, the top of the document. `#selected` therefore holds only ids the
  reader can see, and `#selectionForEdit()` grows the set at the moment of a delete,
  move, copy or indent. A lookup that finds nothing must fail, never fall back to 0.

- **A block id does not name an editable host.** A table has one host per cell, so
  anything that resolves "where does this id point" needs the cell too — `focusRange`
  takes one, `#pending` carries one, and `#resolve` returns `null` rather than
  substituting `getView(id).content` (which for a table is always cell 0:0).

- **The two selection modes are mutually exclusive.** Entering one leaves the other.
  `focus()` clears a block selection, an empty id list means "no block selection"
  rather than "block-selection mode with nothing in it", and a focus that cannot land
  reports failure instead of leaving the editor in neither mode.

- **`content` is not a block's whole payload.** `rows`, `src`, `alt`, `icon` and
  `checked` travel with it. Any merge, paste or type conversion that copies only
  `content` silently destroys the rest, and text moved into a block that cannot
  display it is gone as soon as `normalizeDocument` runs.

- **`#commit` is the only history recorder, and it must not record a no-op.** Every
  pure op returns a fresh array even when nothing changed, so identity is not a
  usable test — compare before recording. A caller that records for itself and then
  commits banks the same snapshot twice.

- **Anything the DOM does that the editor did not author has to be intercepted.**
  `paste` was handled and `drop` was not, so a native drag wrote attacker markup
  straight into a live contenteditable and `syncFromDom` then recorded it as correct.
  Input rules must also gate on `event.inputType`: they fired on deletions and
  silently converted blocks.

- **Writer and reader are one contract.** `toMarkdown` output is parsed by
  `blocksFromMarkdown`, and `blocksToHtml` by `blocksFromHtml`, so an escape the
  writer emits and the reader does not understand is data loss. `src/round-trip.test.ts`
  holds both properties over a corpus; a case that cannot round-trip belongs in its
  known-failure registry with a reason, never silently dropped.

- **ARIA that a role does not permit is not an accessibility feature.** `aria-selected`
  on a role-less block `<div>` is dropped by browsers, so it announced nothing while
  looking like coverage. Giving the block a role that carries it would displace the
  heading and list semantics the content element exists to provide — the same trade
  that made `role="textbox"` wrong. Announce through the live region instead.

- **A test that passes with the code removed is worse than no test.** Every fix here
  was mutation-checked: revert the change, watch the test fail, restore it. Two
  previous tests asserted a literal against itself and could not distinguish a working
  feature from a deleted one.

- **A comment that inverts the code is a defect, not an untidiness.** The rationale
  for most decisions here lives only in prose, so a stale docstring is the whole
  record being wrong: `index.ts` told a reader `CellCoords` was derived off the
  method and deliberately not re-exported, and recommended the exact change that
  had already been made because deriving it was broken from outside. Two escape
  sets likewise still claimed to hold the toggle triangles that had been taken
  out of them. Behaviour was right in all three; the executable guards held. When
  a fix moves an invariant, move the sentence that explains it.

- **A widget that flips its own ink has to own the ground it flips it onto.** The
  dark theme redefined every foreground and left `--neditor-surface` transparent,
  so on an ordinary light-only host page the whole document rendered at 1.00:1.
  The same rule in reverse governs the library stylesheet's position: it goes
  _first_ in the container, because it is a default and the page overrides it.

- **A test that runs on happy-dom cannot pin a browser rule happy-dom does not
  implement.** HTML tree construction drops one newline after `<pre>`; happy-dom
  does not, so four of five behavioural tests passed with the fix reverted and
  only the assertion on the emitted markup caught it. Where the environments
  differ, check the real browser and pin the artifact, not the behaviour.

- **A bound on the reader is a bound on the writer.** `INLINE_SPAN_LIMIT` caps how
  far back a rule reaches; the writer had no matching cap, so it emitted spans
  its own reader could never close and left the raw delimiters in the prose. Any
  limit on one half of a round trip is a limit on both.

- **`text/plain` is only the same characters when nothing richer exists.** This
  editor writes it as `toMarkdown` output, so preferring it on paste into a code
  block inserted fence lines and escape backslashes the user never typed.

- **CSS custom properties fail whole, not in part.** `calc(var(--gutter) + depth *
var(--indent))` is dropped entirely when a host sets the gutter to a unitless
  `0` -- the invalidity appears only after substitution, so the whole declaration
  goes, not the term. Keep separately-settable tokens in separate declarations.

- **Ask the whole question every sibling asks.** `setBlockType` omitted `#canEdit()`,
  `#travel` asked `#editable` without `!#destroyed`, and `setDocument` closed the
  block selection but none of the popovers that `#travel` and `setEditable` both
  close. Each was one path in a family that had agreed on the answer everywhere else.
