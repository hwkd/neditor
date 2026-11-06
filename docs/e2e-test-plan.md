# neditor end-to-end test suite — plan

Status: **implemented** in `apps/e2e` — see [e2e-progress.md](e2e-progress.md) for per-spec status,
the spike results and the defects the suite found. Decisions taken 2026-09-30:

| #   | Question                                                                 | Decision                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Should e2e gate releases?                                                | **Yes, in two steps.** Until the P0 set is stable, e2e runs in its own `.github/workflows/e2e.yml` on every push and PR, but nothing depends on it. After 20 consecutive green runs on `main` with no retries used, the job moves into `ci.yml`, and from then on `release.yml` gates every publish on it with no further change. |
| D2  | Test the README's browser floors (Chrome 92 / Firefox 90 / Safari 16.4)? | **No.** Test the current Chromium, Firefox and WebKit only. When the suite lands, the README's "Browser support" section says so plainly: the floors are derived from language features, not tested.                                                                                                                              |
| D3  | Clipboard where headless support is weak                                 | **The Phase 0 spike decides per engine.** Where a real Mod+C / Mod+V round trip, including `application/x-neditor`, works, the spec runs there. Where it does not, the case is tagged Chromium-only with a comment naming the engine gap. It never falls back to synthetic `ClipboardEvent`s, which the unit tests already cover. |

## 1. Why this suite, and what it is not

`packages/neditor` has ~20 happy-dom test files that already pin the model, the
serializers and most editor paths. They cannot see what a real browser does,
and the unit tests themselves list the gaps:

| Gap happy-dom cannot observe                                       | Where it is admitted                                                          |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Layout (every rect is zero, drop gap always "past the last block") | `commit-records.test.ts:115`, `portal-gestures.test.ts:668,746`               |
| Selection vs focus (selection kept regardless of focus)            | `view/selection.test.ts:24-26`, AGENTS.md                                     |
| The newline-after-`<pre>` parsing rule                             | `view/rich-dom.test.ts:1529,1554`                                             |
| Native drag/drop: `dataTransfer`, coordinates, caret-from-point    | `foreign-input.test.ts:69,209`                                                |
| Shadow-DOM event retargeting                                       | `portal-gestures.test.ts:473-478`                                             |
| Pointer capture and the compatibility click after a drag           | `portal-gestures.test.ts:410`                                                 |
| A genuine second realm (iframe)                                    | `util/dom.test.ts:13`                                                         |
| Real clipboard round trips                                         | every paste test hand-builds a `ClipboardEvent`                               |
| IME composition                                                    | synthetic `CompositionEvent`s in `editor.test.ts`                             |
| Cross-block pointer selection                                      | AGENTS.md: "never verify one by building that range with the Selection API"   |
| Scrolling / `scrollIntoView`, trailing `<br>` line box             | `public-surface.test.ts:303-315,603-640`                                      |
| Touch: `pointercancel`, no hover, `touch-action`                   | AGENTS.md; README ("verified with synthetic pointer events, not on hardware") |

**Scope rule:** e2e covers (a) every user-facing feature at least once through
real input, and (b) in depth, the behaviours in the table above. It does **not**
re-test pure model/serializer logic already covered by unit tests (list
numbering, `normalizeDocument` bounds, inline-rule edge cases); those appear
only as a single end-to-end smoke of the path.

## 2. Tooling decision

**Standalone `@playwright/test`** in a new private workspace package, `apps/e2e`.

Considered and rejected as the primary tool: Vitest browser mode (Vite+ ships
`@vitest/browser`; the Playwright provider is opt-in). It would reuse `vp test`,
but it runs inside an iframe the runner owns, which fights exactly the things
this suite exists for — iframe/shadow mounting, top-level CSP headers, native
drag between page regions, new-tab link opening, CDP sessions for IME and touch,
and multi-editor pages. It stays an option later for fast component-level
browser tests.

Consequences:

- `apps/e2e/package.json` (private), devDeps `@playwright/test`, `@axe-core/playwright`
  added to the pnpm catalog. `vitest` stays pinned and untouched.
- Browsers installed with `vp exec playwright install --with-deps` (Vite+ docker guide).
- Tests run against the **built package** (`packages/neditor/dist`), i.e. what
  consumers get — it also catches `exports`-map and code-split-chunk mistakes.
  An `E2E_SOURCE=1` switch may alias `@neditor/core` to `src/` for a fast local
  loop (this is a package alias, not the forbidden `vite` alias).
- Projects: `chromium`, `firefox`, `webkit` (README floor: Chrome 92 / Firefox 90
  / Safari 16.4 — Playwright only gives latest engines, so the floor itself is
  **not** tested; say so in the README). Plus `chromium-touch`
  (`hasTouch`, mobile viewport) for touch specs.
- Tags: `@cdp` (Chromium-only: IME, raw touch), `@clipboard` (see risk R1),
  `@visual` (screenshot baselines, Linux CI only), `@slow`.
- `Mod` key: use Playwright's `ControlOrMeta`. The editor picks Cmd on Apple
  platforms and Ctrl elsewhere, and Playwright maps `ControlOrMeta` the same way
  per host, so the suite is correct on macOS dev machines and Linux CI.

## 3. Test harness

### 3.1 Fixture pages (`apps/e2e/fixtures/`, served by `vp dev`)

One framework-free page, `index.html` + `harness.ts`, configured by query string
so every spec can mount exactly what it needs:

| Param                                                    | Values                                                                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `doc`                                                    | name of a seed in `fixtures/docs/` (`empty`, `kitchen-sink`, `lists`, `nested`, `toggle-collapsed`, `table`, `image`, `long-2000`, `malicious`) |
| `editable`                                               | `0` / `1`                                                                                                                                       |
| `theme`                                                  | `light` / `dark` / `auto`                                                                                                                       |
| `mount`                                                  | `plain` (default) / `shadow` / `iframe` / `dialog` / `two` (two editors)                                                                        |
| `dir`                                                    | `rtl` on the editor, or `page-rtl` on `<html>` only                                                                                             |
| `toolbar`, `dragHandles`, `historyLimit`, `injectStyles` | option passthrough                                                                                                                              |
| `labels`                                                 | `fr` (a full override set, to test localisation)                                                                                                |
| `scroll`                                                 | `1` pads the page above/below the editor so it scrolls                                                                                          |

The page also contains, outside the editor: a focusable button before and after
it (to prove Tab leaves), a `draggable` **foreign source** element whose
`dragstart` sets a chosen `text/html` / `text/plain` payload (for real native
drops), and a plain `<textarea>` paste target (to read what the editor wrote to
the clipboard).

`harness.ts` exposes `window.__e2e`:

```ts
{
  editor: NEditor;                 // or editors[] for mount=two
  events: Array<{ type; payload; t }>;   // every change/focus/selection/history/blockselection
  announcements: string[];         // MutationObserver on .neditor-live-region (it blanks then sets)
  errors: unknown[];               // onError + window 'error'
  lib: typeof import('@neditor/core');  // parseRichText, normalizeDepths, toMarkdown… for invariants
  remount(options): void;
}
```

### 3.2 Page object (`apps/e2e/helpers/editor.ts`)

`EditorPage` wraps a page + editor index: `block(id)`, `content(id)`,
`cell(id, r, c)`, `blocksInOrder()`, `doc()`, `markdown()`, `selected()`,
`lastAnnouncement()`, `caret()` (block id / cell / offset from
`getSelectionState`), `gutter()`, `portal(name)`, `clickAt(id, offset)` (a real
click at the character's rect via `Range.getBoundingClientRect`),
`dragText(from, to)`, `dragHandle(id, toGap)`.

### 3.3 Rules for writing specs (from AGENTS.md)

1. **The action under test is always real input** — `keyboard.type/press`,
   `mouse`, `dragTo`, `touchscreen`/CDP. Programmatic setup (`setDocument`,
   `focusRange`) is fine for _arranging_ state, never for the step being tested.
2. **Never build a cross-block DOM range with the Selection API** to test a
   cross-block gesture. It proves nothing a mouse can reproduce.
3. **Assert on the model and the screen**: `getDocument()` _and_ the DOM/visible
   result _and_, for edits, that one undo returns exactly the previous document.
4. **Time is controlled, not waited for**: history coalescing (600 ms, `Date.now`)
   and long press (500 ms, `setTimeout`) use `page.clock`. No `waitForTimeout`.
5. **Take the literal scenario** from the finding or README line being covered,
   and for every spec that pins a previously-fixed defect, **mutation-check it**:
   revert the fix locally, watch the spec fail, restore. Record it in the PR.

### 3.4 Invariant check after every test (auto fixture)

A Playwright fixture runs these after each test on every mounted editor, so
every spec is also a regression net for the core invariants:

- **Mode exclusivity**: block selection non-empty ⇒ focus is on the root and no
  DOM selection lies inside a content host; empty ⇒ no `[data-selected]`.
- **Model ↔ DOM**: visible blocks render in model order; each host's
  `parseRichText` equals the model's runs (cells against `rows`); `data-depth`
  equals `depth`; hidden descendants of collapsed toggles are absent from the DOM.
- **Depth**: `normalizeDepths(doc)` deep-equals `doc`.
- **Round trip**: `blocksFromMarkdown(toMarkdown(doc))` equals the doc up to the
  known-failure registry in `round-trip.test.ts` (empty paragraphs, etc.).
- The live region is the root's last child; read-only ⇒ no portal visible.
- No `pageerror`, no `console.error`, `__e2e.errors` empty (unless expected).

## 4. Spec catalogue

Priority: **P0** = must land before the suite gates CI; **P1** = next; **P2** =
nice-to-have. IDs are for tracking in PRs.

### 01 · Mount & lifecycle — `mount.spec.ts` (P0)

- M1 Mount by selector and by element; a missing selector throws the documented message.
- M2 No `doc` ⇒ one empty paragraph; `autofocus` puts the caret in the first block.
- M3 Root gets `.neditor`, `tabindex=-1`, `aria-label` (or keeps an existing one), `role="group"` only on a role-less div/span/custom element.
- M4 Styles injected once per root node, as the **first** child of `<head>`; two editors ⇒ still one `<style data-neditor-styles>`.
- M5 `destroy()` removes views, gutter, live region and every portal; restores `aria-label`/`role`/`tabindex`; second `destroy()` is a no-op; typing, `setDocument`, `setEditable` afterwards change nothing and put no contenteditable back.
- M6 Two editors on one page: independent history, independent slash menus (unique listbox ids), portals do not cross-talk.

### 02 · Typing & caret — `typing.spec.ts` (P0)

- T1 Type into a paragraph: model updates, **the content element is not replaced** (same node handle before/after) and the caret stays where it was — typing mid-word keeps typing mid-word.
- T2 Placeholder shows only on the focused empty block.
- T3 Shift+Enter inserts `\n`; the block **grows by one line box** (real height check) and the next character lands _after_ the break (trailing-`<br>` rule).
- T4 Enter splits at the caret / at start / at end / over a selection (selection deleted first); caret lands at the new block start.
- T5 Lists and to-dos continue on Enter; Enter on an empty list item leaves the list.
- T6 Enter in a callout or toggle opens a **child** (depth+1); in a collapsed toggle it expands first.
- T7 Focus scrolls the target into view on a long, scrolled page (`scroll=1`).

### 03 · Structural keys — `structure-keys.spec.ts` (P0)

- S1 Backspace ladder at block start: outdent → revert to paragraph → merge upward (caret at join, marks kept).
- S2 Backspace after a divider deletes it; before an image/table selects it.
- S3 Backspace at the start of an **image caption** selects the image; `src`/`alt` survive.
- S4 Delete at end: merges next text / removes a following divider / selects a following table or image / no-op at document end.
- S5 Tab indents up to previous depth + 1; Shift+Tab outdents.
- S6 **No keyboard trap**: Tab that cannot indent and Shift+Tab at depth 0 move focus to the harness buttons after/before the editor.
- S7 Mod+Shift+↑/↓ moves the block one visible slot, keeps caret offset, steps over a collapsed toggle as a unit; at the document edge: no `change` event, `canUndo` unchanged (hold the key: 10 repeats ⇒ zero events).
- S8 ↑/↓ at a boundary move between blocks, skipping dividers and hidden children.
- S9 Mod+Enter toggles a to-do (and behaves as Enter elsewhere).

### 04 · Markdown input rules — `input-rules.spec.ts` (P0, table-driven)

- R1 Each block prefix typed into an empty paragraph: `# ` `## ` `### ` `- ` `* ` `+ ` `1. ` `1) ` `> ` `[] ` `[ ] ` `[x] ` ` ``` ` `---` `***` → expected type, prefix removed, caret at 0. `[x] ` yields an **unchecked** to-do (current behaviour, pin it).
- R2 `---` makes a divider **plus** a paragraph holding the rest, with the caret there.
- R3 Rules fire only in paragraphs (`# ` in a quote stays literal) and never in table cells.
- R4 **Deletion never fires a rule**: paragraph `# word`, Backspace ×4 → still a paragraph reading `# `.
- R5 Each inline rule: `**b**` `__b__` `*i*` `_i_` `~~s~~` `` `c` `` `<u>u</u>` `[t](https://x.y)` `[t](<https://x.y/a)b>)` → mark applied, delimiters gone, next typed text is **plain**.
- R6 `2 * 3 * 4` stays literal; `[t](javascript:alert(1))` stays literal text; no inline rules inside a code block; inline rules **do** work in a table cell.
- R7 One undo after a rule restores the typed literal text.

### 05 · Slash menu — `slash-menu.spec.ts` (P0)

- SL1 Opens on `/` at block start or after a space; not after a letter, not in a table cell.
- SL2 Filters by label substring and keyword prefix (`/h1`, `/acc` → Toggle); no match closes; Backspace narrows; deleting the `/` closes.
- SL3 ↑/↓ wrap; Enter and Tab apply; Escape closes and removes the combobox attributes.
- SL4 While open the host is `role=combobox` with `aria-expanded`, `aria-controls`, and `aria-activedescendant` **equal to the highlighted option on every path**: arrows, filtering, mouse hover.
- SL5 Mouse hover + click applies.
- SL6 All 14 commands (table-driven): resulting block type and DOM structure (`h1`, `blockquote`, `pre>code`, checkbox button, chevron, icon button, figure, table, hr).
- SL7 `/divider` keeps trailing text in a new paragraph; `/image` opens the image editor focused; `/table` moves the block's text into cell 0:0; `/code` strips marks.
- SL8 Closes on outside pointerdown, page scroll, window resize, entering block selection, caret moving to another block.
- SL9 Positioning: opened on the last visible line flips **above** the caret and stays inside the viewport.

### 06 · Formatting & toolbar — `formatting.spec.ts` (P0)

- F1 A real mouse-drag selection and a Shift+Arrow selection both show the toolbar, above the selection, inside the viewport.
- F2 Each button and each shortcut (Mod+B/I/U/E, Mod+Shift+X) toggles its mark; toolbar clicks do not move focus or lose the selection.
- F3 `aria-pressed` true only when the mark covers the whole selection; on a partially bold range, Bold bolds the rest.
- F4 Armed marks: collapsed caret + Mod+B, type → bold text; moving the caret disarms.
- F5 Marks compose (bold+italic+link); DOM nesting order `a > strong > em …`.
- F6 Hides on collapse, Escape, scroll, entering block mode; `toolbar:false` never shows it.
- F7 Undoing a format restores the same selection.

### 07 · Links — `links.spec.ts` (P0)

- L1 Mod+K and the toolbar link button open the editor with the input focused; Enter applies; bare `example.com` ⇒ `https://example.com/`.
- L2 `javascript:`/`data:` rejected: `aria-invalid`, visible error, dialog stays open, document unchanged.
- L3 Empty input / Remove unlinks; Remove hidden when there is no link.
- L4 Escape cancels and restores the selection.
- L5 Plain click on a link (editable) selects it and opens the editor; Mod+click opens a **new page** with `window.opener === null`; the current page never navigates.
- L6 A document loaded with `javascript:` hrefs renders no unsafe `href` anywhere in the DOM.
- L7 Pointerdown outside the dialog closes it **without** pulling focus back (focus lands where clicked).

### 08 · Block selection (keyboard) — `block-selection.spec.ts` (P0)

- B1 Escape in text selects the block; Escape again blurs the editor and announces "Left the editor".
- B2 Shift+↑ at block start / Shift+↓ at end extends into whole blocks.
- B3 Mod+A: first press selects the block text, second selects all blocks (empty block: straight to all).
- B4 ↑/↓ move, Shift+↑/↓ grow/shrink from the anchor, Mod+Shift+↑/↓ move blocks.
- B5 Tab/Shift+Tab indent the group; a no-op Tab lets focus leave.
- B6 Backspace/Delete: blocks gone, caret placement, "N blocks deleted"; deleting everything leaves one empty paragraph.
- B7 Mod+D duplicates below and selects the copies.
- B8 A printable key replaces the selection with a paragraph holding that character.
- B9 Enter returns to the last selected block that can hold a caret (skips a divider; all-divider selection stays selected).
- B10 Selected blocks show `data-selected` and the accent bar (computed `::before`); no `aria-selected`.
- B11 A collapsed toggle in the selection carries its hidden children through delete, move, duplicate and copy.

### 09 · Gutter & block drag — `gutter-drag.spec.ts` (P0)

- G1 Hover shows the gutter aligned to the block (`top` within 2 px of the block's text line) — also after page scroll, for nested blocks, and in RTL (gutter on the right).
- G2 `+` inserts an empty paragraph below at the same depth and focuses it.
- G3 Handle click selects; Shift+click extends; Mod+click toggles.
- G4 Drag a block by its handle: 4 px threshold, drop indicator visible **at the gap under the pointer** (real layout — the case happy-dom always answers "past the last block"), root `data-dragging` during, moved on release, one undo restores.
- G5 Dragging a handle inside a multi-selection moves the whole selection, and **the selection survives** the click that follows the drag.
- G6 Drop back into its own gap: no `change`, no history entry.
- G7 Escape mid-drag abandons; `pointercancel` (dispatched via CDP) ends the drag; releasing outside the viewport still ends it (pointer capture).
- G8 Dragging a nested item to the top clamps depth to 0; dragging a collapsed toggle carries its children.
- G9 `dragHandles:false` and read-only ⇒ no gutter.

### 10 · Pointer text selection across blocks — `pointer-select.spec.ts` (P0)

- P1 Real mouse drag from mid-text of block A into block C selects blocks A–C (`data-selecting` during, cleared after); dragging back to A shrinks to A's text.
- P2 Release below the last block selects through the last block.
- P3 Works in read-only (and Mod+C then copies, see 11).
- P4 Clicking the empty area under the last block focuses an empty last block, or appends a paragraph.
- P5 Clicking into text clears a block selection.

### 11 · Clipboard — `clipboard.spec.ts` (P0, `@clipboard`)

Real copy/paste: grant `clipboard-read/write`, press Mod+C / Mod+V, read the
system clipboard through the harness `<textarea>` or `navigator.clipboard.read()`.
Foreign payloads are written with `navigator.clipboard.write(new ClipboardItem({ 'text/html', 'text/plain' }))`
and then pasted with a **real** Mod+V.

- C1 Copy a block selection ⇒ `text/plain` is Markdown, `text/html` has nested `<ul>/<ol>`; paste into the second editor (`mount=two`) reproduces blocks with depth, marks, checked state, callout icon, toggle state, image, table.
- C2 Cut deletes the blocks; cut in read-only copies and deletes nothing.
- C3 Single paragraph pastes inline mid-sentence; multi-block paste merges first/last with the split text; paste into an empty block replaces it (no blank line above).
- C4 Table / image / divider on the clipboard are spliced in whole; trailing text gets its own paragraph.
- C5 Paste over a block selection replaces it; every paste is one undo step.
- C6 Foreign HTML corpus (`fixtures/clipboard/`: Google Docs with the `font-weight:normal` `<b>` wrapper, Word, GitHub-rendered Markdown, a web page with `<details>`): expected structure and marks.
- C7 **Sanitisation**: `<script>`, `<style>`, `<iframe>`, `on*` attributes and `javascript:`/`data:` hrefs never reach the DOM or the model; link text is kept.
- C8 Plain-text Markdown, including a GFM table and a ragged table ⇒ real blocks.
- C9 Into a code block: our own copy ⇒ the block's text (no fences, no escape backslashes); plain text from another app ⇒ inserted verbatim.
- C10 Into a table cell ⇒ flattened text, marks kept.
- C11 **`<pre>` newline rule (real parser)**: a code block whose text starts with `\n` survives copy → paste unchanged.
- C12 Native text-mode copy of a partial, formatted range pastes back with its marks.

### 12 · Drop — `drop.spec.ts` (P0, security)

Real native DnD: `page.dragAndDrop('#foreign-source', target)` with the payload
set in the source's `dragstart`.

- D1 Hostile payloads — `<iframe>`, `<form><input type=password>`, a `position:fixed` full-viewport overlay, `<img onerror>` — leave **no** such element in the editor DOM or model, before and after a re-render and after undo/redo.
- D2 The safe text of the payload is inserted at the drop point (real `caretPositionFromPoint`/`caretRangeFromPoint`, per engine).
- D3 Read-only: drop changes nothing and the browser default is still cancelled.
- D4 File-only drop and empty drop: selection untouched, no `change`.
- D5 Dragging selected text within the editor copies rather than moves (documented behaviour, pinned).

### 13 · History — `history.spec.ts` (P0)

- H1 With `page.clock`: typing with gaps < 600 ms is one undo step; a 700 ms pause makes two.
- H2 Caret move, click, switching insert↔delete, and moving to another table cell each end a run.
- H3 Enter, type change, indent, paste, mark are each one step.
- H4 Undo restores the selection at the time of the edit (caret back where Enter was pressed; formatted text reselected).
- H5 Mod+Z, Mod+Shift+Z, Ctrl+Y (non-Apple) work in text and block mode; a new edit clears redo.
- H6 `historyLimit: 3` keeps only three steps.
- H7 `setDocument` clears history; the `history` event keeps the demo's buttons' `disabled` state correct.
- H8 Undo/redo close any open slash menu, popover and toolbar, and leave block selection.

### 14 · To-do, toggle, callout — `special-blocks.spec.ts` (P1)

- K1 Checkbox click toggles, caret not moved, "Checked"/"Unchecked" announced, strikethrough style, undoable.
- K2 Chevron collapses: children leave the DOM, `aria-expanded` flips; a caret inside a hidden child moves to the toggle's end.
- K3 Keyboard: Tab reaches the chevron and the callout icon; Space/Enter activate them.
- K4 Icon picker: opens below the icon; a preset sets the icon; custom input keeps the first grapheme (`⚠️` intact, a ZWJ family emoji intact); empty input dismisses; Escape returns the caret to the callout; outside click closes without refocusing.

### 15 · Images — `images.spec.ts` (P1)

- I1 `/image` → editor focused; `/sample.png` renders and actually loads (`naturalWidth > 0`).
- I2 `javascript:` and `data:image/svg+xml` rejected with a visible error; base64 `data:image/png` accepted.
- I3 Alt text is the image's accessible name (`getByRole('img', { name })`), i.e. the trigger is a sibling overlay, not a wrapper.
- I4 Remove / empty URL turns the block into a paragraph.
- I5 Caption is rich text (marks, links); Backspace at caption start selects the image.
- I6 Read-only: both image buttons `disabled`.

### 16 · Tables — `tables.spec.ts` (P0 for navigation, P1 for the rest)

- TB1 Tab/Shift+Tab walk cells; Tab past the last cell adds a row ("Row added"); Shift+Tab from the first cell leaves the editor.
- TB2 Enter inserts a newline in the cell and the cell grows (trailing `<br>`).
- TB3 ↑/↓ move between rows and leave the table at its edges; Backspace at a cell start is swallowed.
- TB4 Table toolbar appears above the table; each of the six commands works, is announced, and focus returns to the right cell (adjusted for above/left inserts).
- TB5 F10 moves focus into the toolbar; ←/→/Home/End rove; Escape returns to the cell.
- TB6 Deleting the last row/column empties rather than removes.
- TB7 Escape in a cell selects the table; Mod+A: cell, then all blocks.
- TB8 `toolbar:false` still shows the table toolbar; a wide table scrolls horizontally without breaking the page.
- TB9 Typing runs are per cell for undo.

### 17 · Read-only — `read-only.spec.ts` (P0)

- RO1 No host is `contenteditable=true`; typing, Backspace, paste and drop change nothing and fire no `change`.
- RO2 Checkbox, chevron, icon, image buttons: document unchanged, no `change`, `canUndo` false; the chevron still expands/collapses the **view**.
- RO3 Toolbars, gutter, popovers never appear.
- RO4 Links open in a new tab on plain click.
- RO5 Block selection by pointer drag and Mod+C still work.
- RO6 `setEditable(false)` at runtime closes open popovers and toolbars; back to `true` restores editing and resets reader-only expansions.

### 18 · Popover ownership & viewport — `popovers.spec.ts` (P1)

- PO1 Open the link editor from block A, click into block B, press Escape: B's block is selected; the caret does **not** jump to A.
- PO2 Escape inside a table cell only dismisses a popover that cell opened.
- PO3 Page scroll closes slash menu, link/image editors, icon picker and format toolbar, but **not** the table toolbar; scrolling _inside_ a portal closes nothing.
- PO4 Every portal is positioned inside the viewport near all four edges, and at a 375 px mobile width.

### 19 · Embedding — `embedding.spec.ts` (P1)

- E1 `mount=shadow`: stylesheet inside the shadow root; portals are appended there with computed `position: fixed` and the theme tokens resolved; outside-click dismissal works with real retargeting; drops resolve the caret through the shadow root.
- E2 `mount=iframe` (editor module from the parent realm, mounted into the iframe's document): typing, paste, drop and popovers all work — the duck-typed `util/dom.ts` guards under a genuine second realm.
- E3 `mount=dialog` with `portalContainer` = the modal `<dialog>`: the format toolbar is on top (`elementFromPoint` at its centre hits it).

### 20 · Theming & visual — `theming.spec.ts` (P2, mostly `@visual`)

- V1 `theme=auto` follows `emulateMedia({ colorScheme })`; `light`/`dark` force it; portals carry the same theme.
- V2 Dark theme on a light host page has an opaque surface (text/background contrast ≥ 4.5:1 measured from computed colours).
- V3 `forcedColors: 'active'` and `reducedMotion: 'reduce'` rules apply (no transitions).
- V4 `dir=rtl` mirrors indentation, markers, quote bar and gutter; `page-rtl` with an LTR editor is not mirrored.
- V5 Host sets `--neditor-gutter-width: 0` (unitless): nested blocks are **still indented** (custom-property whole-declaration failure).
- V6 Screenshot baselines: kitchen-sink document in light and dark, slash menu open, table toolbar open.

### 21 · Accessibility — `a11y.spec.ts` (P0 for scans and keyboard escape)

- A1 axe scan (WCAG 2.1 AA) with no violations: default, read-only, slash menu open, each popover open, block selection active.
- A2 ARIA snapshot of the kitchen-sink doc: headings keep heading roles, quotes blockquote; **no** `role=textbox`/`aria-multiline` on content; to-do checkbox `aria-labelledby` its text.
- A3 Announcement table: each trigger in README's list produces its live-region string (captured from `__e2e.announcements`).
- A4 Keyboard-only journey: Tab into the editor, build one of each block type via `/`, reach the chevron and icon by Tab, leave via Shift+Tab and via Escape×2 — no step needs a mouse.
- A5 `labels=fr`: accessible names, placeholders, announcements and slash filtering on translated keywords all use French.

### 22 · IME & composition — `ime.spec.ts` (P1, `@cdp`)

Uses CDP `Input.imeSetComposition` / `Input.insertText` for a real composition.

- IM1 Japanese and Korean compositions commit the right text; one undo step per committed word; a cancelled candidate records nothing.
- IM2 Enter while composing does not split the block.
- IM3 Undo after a composition begun with the caret in a _different_ block returns to that pre-composition caret (literal scenario from the finding).
- IM4 Armed marks apply to composed text.
- IM5 Markdown shortcuts do **not** fire on composed text (documented gap; pin current behaviour so a fix is a conscious change).

### 23 · Touch — `touch.spec.ts` (P1, `chromium-touch`, `@cdp`)

Raw touch via CDP `Input.dispatchTouchEvent`, time via `page.clock`.

- TO1 A tap on a block shows the gutter, and it **stays** after the finger lifts (touch `pointerleave` does not hide it).
- TO2 A 500 ms press with < 10 px drift selects the block; > 10 px drift cancels it (a scroll, not a press).
- TO3 Dragging the handle by touch moves the block (`touch-action: none` — the page does not scroll).
- TO4 A touch drag that turns into a scroll (`pointercancel`) leaves no drag live: the next tap behaves normally.

### 24 · Public API & events — `api.spec.ts` (P1)

- AP1 `change` fires once per edit and never for no-ops or read-only view changes; `focus`, `selection` (marks, link, cell), `blockselection`, `history` payloads correct.
- AP2 A throwing listener goes to `onError` and the editor keeps working.
- AP3 `getDocument()` returns a copy (mutating it changes nothing on screen).
- AP4 `setDocument(malicious)` renders no unsafe `href`/`src`; `{ silent: true }` emits no `change`.
- AP5 `focus()`/`focusRange()` return `false` for a divider, a hidden block, an unknown id — and leave the editor in a valid mode.
- AP6 `selectBlocks([])` returns the caret; `setBlockType` announces "Changed to …" and ends block selection.

### 25 · UI-built document round trip — `round-trip.spec.ts` (P1)

- RT1 Build the kitchen-sink document using only keyboard and slash menu; `getMarkdown()` matches a golden file.
- RT2 Feed that Markdown back through `setDocument(blocksFromMarkdown(...))`: DOM identical to the UI-built one.

### 26 · Packaging & consumer paths — `package.spec.ts` (P1)

Files from `packages/neditor/dist` served through `page.route`, so headers are controllable.

- PK1 CDN-style page importing `dist/index.mjs` directly: the code-split `markdown-*.mjs` chunk resolves and pasting Markdown works.
- PK2 Strict CSP `style-src 'nonce-…'`: with `styleNonce` the editor is styled; without it the style is blocked; `injectStyles:false` + `dist/styles.css` renders the same as injected (computed-style comparison on a sample of elements).
- PK3 `@neditor/core/model` works inside a Web Worker (no DOM): Markdown in, Markdown out.

### 27 · Demo site smoke — `demo.spec.ts` (P2)

- DS1 `apps/web` index loads with no console errors; every seed block type renders; `/sample.png` loads.
- DS2 Undo/Redo buttons enable/disable and work without stealing the caret; the Markdown/JSON inspector tabs switch and update on typing.

### 28 · Robustness & performance — `perf.spec.ts` (P2, `@slow`, Chromium only)

- PF1 `long-2000` document: typing latency p95 under a budget (from `performance.mark`s in the harness), measured, not guessed.
- PF2 Pasting 1 MB of HTML and a 1024-deep nested list completes within a budget, with no page crash.
- PF3 Table at 1000 rows: Tab past the last cell lets focus leave instead of adding a row.

**Size estimate:** ~28 spec files, ~230 test cases, of which ~110 are P0.

## 5. CI

- An `e2e` job: install, `pnpm --filter @neditor/core run build`,
  `vp exec playwright install --with-deps`, `pnpm --filter e2e exec playwright test`,
  sharded ×3 across the browser projects. Upload the HTML report and traces
  (`trace: 'retain-on-failure'`) as artifacts.
- Where it lives follows D1. It starts in a standalone `e2e.yml` that nothing
  depends on. It moves into `ci.yml` after 20 consecutive green runs on `main`,
  at which point `release.yml`, which reuses `ci.yml`, gates publishing on it.
- Retries: `retries: 1` in CI with a flake report; a test that needs its retry
  twice in a week is quarantined with `test.fixme` plus an issue, not left to
  retry silently. (Unit CI uses `--retry=3` only for wall-clock ratio tests;
  e2e has none, because time is `page.clock`-controlled.)
- `@visual` runs only on the Linux Chromium shard, where baselines are recorded.
- Root `ready` stays fast; add `vp run e2e` as a separate script.

## 6. Phases

| Phase              | Content                                                                                              | Exit criterion                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 0 — Spike (≈1 day) | `apps/e2e` package, harness, `EditorPage`, invariant fixture; prove R1–R3 below in all three engines | One spec per risky mechanism green in CI                                |
| 1 — P0 core        | 01–13, 16 (navigation), 17, 21 (A1, A4), in the standalone `e2e.yml`                                 | Green on 3 engines, 20 consecutive `main` runs with no retries used     |
| 1b — Gate          | Move the job into `ci.yml`, which gates releases (D1)                                                | Next release is blocked by a deliberately broken branch, then unblocked |
| 2 — P1             | 14, 15, 16 (rest), 18, 19, 22, 23, 24, 25, 26                                                        | Each spec stable for a week before it joins the gating set              |
| 3 — P2             | 20, 27, 28, visual baselines                                                                         | Baselines reviewed and committed                                        |

## 7. Risks and open questions

- **R1 Clipboard across engines.** Chromium supports real Mod+C/Mod+V with
  permissions. Firefox and WebKit headless support is partial. Whether the custom
  `application/x-neditor` type survives the system clipboard in each engine has
  to be established in Phase 0. The fallback for engines where it does not
  survive: dispatch a trusted `paste` built from `navigator.clipboard.read()`
  output, or mark the case Chromium-only. Do not quietly switch to synthetic
  `ClipboardEvent`s, which the unit tests already cover.
- **R2 Native DnD.** Playwright's `dragAndDrop` drives real HTML5 drag in
  Chromium and Firefox. Its WebKit support must be checked in the spike.
- **R3 CDP-only paths.** IME and raw touch are Chromium-only, so Firefox and
  WebKit composition stay untested. Accept that gap and say so in the README.
- **R4 Long press on real hardware.** The README warns that long press competes
  with the browser's own long-press text selection. CDP touch is closer to a
  real device than synthetic pointer events, but it is still not hardware. A
  manual check on a device stays in the release checklist.
- **R5 Browser floors.** Playwright ships current engines, so Safari 16.4, Chrome
  92 and Firefox 90 are not tested. Testing them would need BrowserStack or
  similar. Out of scope unless requested.
- **R6 Where fixtures live.** The plan puts them in `apps/e2e`, not in `apps/web`,
  so that test-only pages do not ship with the demo site. The demo gets only
  the smoke spec (27).
