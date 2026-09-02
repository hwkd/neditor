# @neditor/core

A Notion-like block editor in vanilla JavaScript. No framework, no runtime
dependencies, no build step required on your side.

```bash
pnpm add @neditor/core
```

## Browser support

**Chrome/Edge 92+, Firefox 90+, Safari 16.4+.** Node 18+ for the headless
serializers.

The build targets ES2022 and ships untranspiled, so this is a hard floor rather
than a recommendation. Two things set it:

- `Array.prototype.at()` — Chrome 92, Firefox 90, Safari 15.4.
- **RegExp lookbehind** in the Markdown table splitter and the italic input
  rules — Safari 16.4. This one is a parse-time `SyntaxError`, so on an older
  Safari the whole bundle fails to load, not just those code paths. If you need
  to go back further, transpile the package or rewrite those three patterns
  with capture groups.

`Intl.Segmenter` is used to take the first grapheme of a callout icon, but it
is feature-detected — Firefox below 125 keeps the whole string instead of
cutting an emoji in half.

**TypeScript 4.7+** if you consume the types. The package ships `.d.mts` and
`.d.cts` and points at them through `exports`; a compiler older than that
understands neither the extensions nor the map, so it reports the package as
untyped rather than as mistyped. This is the same kind of floor as the one
above — there is no compatibility copy of the declarations.

The declarations open with `/// <reference lib="dom" />`, because the public
types name `HTMLElement`, `ShadowRoot`, `Document`, `Node` and
`DocumentFragment`. A `tsconfig` without `"dom"` in `lib` — the server-side case
the headless serializers exist for — therefore typechecks the package without
having to add it.

## Usage

```js
import { createEditor } from '@neditor/core';

const editor = createEditor({
  element: '#editor',
  autofocus: true,
  onChange: (doc) => {
    localStorage.setItem('doc', JSON.stringify(doc));
  },
});
```

```html
<div id="editor"></div>
```

That is the whole setup. Styles are injected on mount, so there is no stylesheet
to import and no CSS loader to configure.

Because it is plain DOM, it drops into anything — React (`useEffect` + a ref),
Vue (`onMounted`), Svelte (`onMount`), Astro (a `<script>` tag), or a bare HTML
page over a CDN. Call `destroy()` when the host component unmounts.

## Options

| Option            | Type                          | Default              | Description                                                   |
| ----------------- | ----------------------------- | -------------------- | ------------------------------------------------------------- |
| `element`         | `HTMLElement \| string`       | —                    | Mount point, or a selector. Required.                         |
| `doc`             | `NEditorDocument`             | one empty paragraph  | Initial content.                                              |
| `editable`        | `boolean`                     | `true`               | Set `false` for a read-only view.                             |
| `autofocus`       | `boolean`                     | `false`              | Focus the first block on mount.                               |
| `injectStyles`    | `boolean`                     | `true`               | Set `false` to supply your own CSS.                           |
| `theme`           | `'light' \| 'dark' \| 'auto'` | `'auto'`             | `auto` follows `prefers-color-scheme`.                        |
| `toolbar`         | `boolean`                     | `true`               | Set `false` to suppress the selection toolbar.                |
| `historyLimit`    | `number`                      | `200`                | Undo steps retained.                                          |
| `dragHandles`     | `boolean`                     | `true`               | Set `false` to suppress the hover gutter.                     |
| `onChange`        | `(doc) => void`               | —                    | Shorthand for `editor.on('change', …)`.                       |
| `onError`         | `(error) => void`             | `console.error`      | Called when one of your listeners throws.                     |
| `label`           | `string`                      | `'Rich text editor'` | Accessible name. Ignored if the element already has one.      |
| `labels`          | `Partial<NEditorLabels>`      | English              | Accessible names, placeholders, menu entries, announcements.  |
| `portalContainer` | `HTMLElement \| ShadowRoot`   | the mount's root     | Where toolbars and popovers are appended.                     |
| `styleNonce`      | `string`                      | —                    | `nonce` for the injected `<style>`, for a strict `style-src`. |

## API

```ts
editor.getDocument(): NEditorDocument   // deep copy of the current document
editor.setDocument(doc): void           // replace the content
editor.getMarkdown(): string            // serialize to Markdown

editor.toggleMark(mark): void           // 'bold' | 'italic' | 'underline' | …
editor.setLink(href | null): boolean    // false if the URL is unsafe
editor.openLinkEditor(): void
editor.getSelectionState(): SelectionState | null

editor.undo(): boolean                  // false when there is nothing to undo
editor.redo(): boolean
editor.canUndo: boolean                 // getters, for driving your own buttons
editor.canRedo: boolean
editor.clearHistory(): void

editor.getSelectedBlocks(): string[]     // block-level selection, in document order
editor.selectBlocks(ids): void          // pass [] to return to text editing
editor.clearBlockSelection(): void      // same thing: the caret comes back

editor.setBlockType(id, type): void
editor.toggleTodo(id): void
editor.focus(id?, offset?): boolean      // false when nothing there can hold a caret
editor.focusRange(id, start, end, cell?): boolean
editor.setEditable(editable): void
editor.destroy(): void

editor.on('change', (doc) => {})        // returns an unsubscribe function
editor.on('focus', ({ blockId }) => {})
editor.on('selection', (state) => {})   // null when the caret leaves the editor
editor.on('history', ({ canUndo, canRedo }) => {})
editor.on('blockselection', ({ ids }) => {})
```

`editable: false` is a hard contract: the document does not change. The controls
the renderer draws stay reachable — a keyboard reader has to be able to move
through them — but a read-only to-do checkbox, toggle chevron or image button
does nothing rather than firing a `change` your persistence layer would write
back as the author's revision. The image controls say so, too: they are
`disabled`, not silently inert.

`destroy()` is final and idempotent. It unhooks every listener and takes the
views out of the page, and afterwards `setDocument`, `setEditable` and the edit
methods do nothing — the instance often outlives the mount point by a callback
or two, and rendering into a root that has no listeners left produces content
nothing can edit, style, or remove.

Every getter returns a copy, so callers cannot mutate editor state by reference.
`getSelectionState()` gives you what you need to drive your own toolbar:

```js
editor.on('selection', (state) => {
  boldButton.classList.toggle('is-active', state?.marks.includes('bold') ?? false);
});
```

## Rich text

Marks: `bold`, `italic`, `underline`, `strikethrough`, `code`, plus links.
They compose freely — text can be bold, italic and linked at once.

Select text and the format toolbar appears, or use the keyboard:

| Key                        | Action             |
| -------------------------- | ------------------ |
| `⌘`/`Ctrl` + `B`           | Bold               |
| `⌘`/`Ctrl` + `I`           | Italic             |
| `⌘`/`Ctrl` + `U`           | Underline          |
| `⌘`/`Ctrl` + `E`           | Inline code        |
| `⌘`/`Ctrl` + `Shift` + `X` | Strikethrough      |
| `⌘`/`Ctrl` + `K`           | Add or edit a link |

With nothing selected, a mark shortcut _arms_ the formatting and the next text
you type picks it up — the same as any word processor. A partially bold
selection reports Bold as inactive, so pressing it bolds the remainder rather
than clearing what is already bold.

Clicking a link opens the link editor; `⌘`/`Ctrl`-click follows it. In read-only
mode links navigate normally.

The link editor, the callout icon picker and the image popover all take focus,
and all three close on a pointer that lands anywhere outside them — leaving
focus wherever that pointer put it, rather than dragging the caret back. Closing
one from the inside does restore the range it was opened for, which is why
`Escape` only dismisses the popover the current block (or table cell) opened:
pressed anywhere else it does its usual job of stepping up from text to the
block.

### Inline Markdown

These convert the moment you type the closing delimiter:

`**bold**` `__bold__` `*italic*` `_italic_` `` `code` `` `~~strike~~` `[text](url)`

### Block Markdown

Typing these at the start of a paragraph converts the block:

`# ` `## ` `### ` `- ` `* ` `1. ` `> ` `[] ` ` ``` ` `---`

Both sets fire on **typing only**. A rule reads the text before the caret and
takes it as something you have just finished typing, which a deletion leaves
there without anyone having typed it: backspacing the word after a `# ` would
otherwise convert the block and swallow the prefix you were clearing. The slash
menu is the exception once it is open — it tracks the text either way, so
backspacing narrows the query and deleting the `/` closes the menu.

## Block selection and drag handles

Hovering a block reveals a gutter to its left: **+** inserts a paragraph below,
and the **⠿** handle selects on click and reorders on drag. Dragging shows a drop
indicator, and `Escape` mid-drag abandons it. Dragging a handle that belongs to an
existing selection moves the whole selection.

On touch there is no hover to reveal any of this, so a tap on a block shows the
gutter for it and a **long press** (500 ms, allowing 10 px of drift) selects the
block — drifting further is a scroll, not a press. The gutter shown that way
stays until the next tap moves it, because a touch pointer ends by firing the
same `pointerleave` a mouse sends on its way out. The handle sets
`touch-action: none` so a drag on it is not stolen for scrolling, and the drag
takes pointer capture, so a finger that leaves the window still ends the drag
rather than leaving it live. Pointer capture also aims the click that follows a
drag at the handle; that click is treated as the tail of the drag, not a new
one, so dropping a multi-block selection does not collapse it.

The long press was verified with synthetic pointer events, not on hardware; on a
real device it shares the gesture with the browser's own long-press text
selection, so check it on your target platforms before relying on it.

Dragging from one block's text into another selects whole blocks as you go.
Every block is its own `contenteditable`, and browsers confine a selection to a
single editing host, so the gesture is tracked directly rather than read back
from a DOM range that never spans blocks.

Blocks can also be selected as units from the keyboard. `Escape` in text steps up
to the block containing the caret; `Shift`+`↑`/`↓` at a block edge extends into
whole blocks; `⌘A` takes the block's text, and a second `⌘A` takes every block.

With blocks selected:

| Key                            | Action                                    |
| ------------------------------ | ----------------------------------------- |
| `↑` / `↓`                      | Move the selection.                       |
| `Shift` + `↑`/`↓`              | Extend it.                                |
| `⌘`/`Ctrl` + `Shift` + `↑`/`↓` | Move the blocks themselves.               |
| `Tab` / `Shift` + `Tab`        | Indent / outdent together.                |
| `Backspace` / `Delete`         | Delete them.                              |
| `⌘`/`Ctrl` + `D`               | Duplicate them.                           |
| `⌘`/`Ctrl` + `C` / `X`         | Copy or cut, as Markdown and HTML.        |
| Any character                  | Replace them with a paragraph holding it. |
| `Enter`                        | Drop back into the text of the last one.¹ |
| `Escape`                       | Back to text editing.                     |

¹ The last one that has text: a divider has no caret to take, so `Enter` walks
back through the selection and, if none of it can hold one, keeps the selection.

The two modes are mutually exclusive, in both directions: entering block selection
takes the caret out of the document, so the format toolbar hides and keystrokes
address blocks rather than characters — and placing a caret leaves block
selection, so `focus()`, `focusRange()` and `setBlockType()` end it rather than
leaving an invisible selection to swallow the next key. Both return `false` when
there is nowhere to put the caret. An empty selection is not a mode: deselecting
the last block returns to the text rather than holding the root focused with
nothing selected.

Depth is re-clamped after every structural change, so a block can never end up
indented under nothing — dragging a nested item to the top pulls it to the root.

The gutter reserves `--neditor-gutter-width` on the left of each block. Set it to
`0` to reclaim that space; the handles will then overlap the text.

```js
editor.on('blockselection', ({ ids }) => {
  deleteButton.disabled = ids.length === 0;
});
```

## Accessibility

Blocks keep their semantic element — a heading is an `<h1>`, a quote a
`<blockquote>` — so heading navigation and document structure work. Nothing
overrides those with `role="textbox"`.

**Keyboard.** Every control is reachable: the toggle chevron, the callout icon
and the image are real tab stops, and `F10` inside a table moves focus into the
row/column toolbar, where arrows move between commands and `Escape` returns to
the cell.

**Getting out.** `Tab` indents, but only when indenting is possible — a `Tab`
that would change nothing moves focus onward instead, so the editor is never a
keyboard trap. `Shift`+`Tab` at the outermost level always leaves. `Escape`
twice — once to select the block, once more — also releases focus.

**Announcements.** A polite live region reports block selection, deletion,
block-type changes, toggle state, table row and column edits, and undo/redo. The
command menu is a combobox on the block being typed in, and its
`aria-activedescendant` follows the highlight on every path that moves it —
arrow keys, filtering, and the mouse crossing an item — so the option announced
is always the one `Enter` will commit.
Selected blocks carry `aria-selected` and a border, not colour alone, and the
stylesheet has a `forced-colors` block for Windows High Contrast.

**Contrast.** Every text token meets WCAG 1.4.3 in both themes: muted text
5.6:1, placeholders 4.8:1, inline code 5.0:1, and the primary button 4.6:1 in
light, 7.5:1 in dark.

The accent is a foreground as well as a fill — it colours the active toolbar
glyph — so dark mode re-tunes `--neditor-accent` and `--neditor-on-accent`
together instead of inheriting the light pair, which reads 3.3:1 against the
raised dark surface. Theme both tokens together for the same reason: the
checkmark and the button label take their colour from the second, and a light
custom accent leaves white ink on white.

**Localisation.** Every accessible name, placeholder, slash-menu entry and live
announcement is overridable through `labels`, which matters because most of them
never surface as text CSS could reach:

```js
createEditor({
  element: '#editor',
  labels: { editor: 'Éditeur', bold: 'Gras', blocksSelected: '{count} blocs sélectionnés' },
});
```

`DEFAULT_LABELS` and the `NEditorLabels` type are exported; anything you leave
out keeps its default. `placeholders` and `slashCommands` merge per entry, so
translating one of them does not blank the rest.

Two sets of _visible_ button glyphs are not reachable that way. The format
toolbar's `B`, `I`, `U`, `S` and `</>` are typographic mnemonics rather than
words, and the table toolbar's `⤫ row` and `⤫ col` are English text that should
be in `labels` and is not. Both toolbars take their accessible names from
`labels`, so a screen reader announces the translation; only the glyph a sighted
user reads stays English.

Two other things are still missing, and you should decide whether they matter
for your audience: list blocks are not wrapped in a real `<ul>`/`<ol>`, so the
bullet or number is announced as text instead of as list structure, and the
icon picker names each preset button with the emoji itself, which a screen
reader renders in its own locale rather than yours.

## Undo and redo

`⌘`/`Ctrl` + `Z` undoes, `⌘⇧Z` or `Ctrl+Y` redoes. Undo from the browser's Edit
menu and trackpad gestures is routed into the same history rather than letting
the browser mutate the DOM behind the model's back.

Undo works in **runs**, not keystrokes: a burst of typing in one editing host
collapses into a single step. A run ends when you pause for longer than 600ms,
move the caret, click, switch between inserting and deleting, or move to another
table cell — so typing a sentence and then correcting a word stay two separate
undos. Anything structural (Enter, a block type change, indent, paste, applying a
mark) is always its own step.

A keystroke that changes nothing takes no step and emits no `change`. Pressing
`⌘⇧↑` against the top of the document, or dropping a dragged block back in its
own gap, leaves the history exactly as it was — otherwise holding the key down
would push out the edits you actually wanted back.

Each step restores the selection that was live when it was made, so undoing a
format puts the same text back under the cursor, and undoing a split puts the
caret back where you pressed Enter.

To drive your own buttons:

```js
editor.on('history', ({ canUndo, canRedo }) => {
  undoButton.disabled = !canUndo;
  redoButton.disabled = !canRedo;
});
```

`setDocument()` is a reset rather than an edit, so it clears history — the user
cannot undo into content they never saw.

Entries are snapshots, not inverse commands. Every edit in this package returns a
new block array while reusing the blocks it did not touch, so a snapshot costs
one pointer per block and there is no inverse operation to get wrong.

## Keyboard

| Key                             | Action                                                   |
| ------------------------------- | -------------------------------------------------------- |
| `Enter`                         | Split the block. Lists and to-dos continue themselves.   |
| `Enter` on an empty list item   | Leave the list.                                          |
| `Shift` + `Enter`               | Soft line break inside the block.                        |
| `Backspace` at the start        | Outdent, then revert to paragraph, then merge upward.    |
| `Backspace` in an image caption | Select the image. Reverting it would delete the picture. |
| `Delete` at the end             | Merge the next block in.                                 |
| `Tab` / `Shift` + `Tab`         | Indent / outdent.                                        |
| `↑` / `↓` at a boundary         | Move to the previous / next block.                       |
| `⌘`/`Ctrl` + `Shift` + `↑`/`↓`  | Move the block itself.                                   |
| `⌘`/`Ctrl` + `Enter`            | Toggle a to-do.                                          |
| `⌘`/`Ctrl` + `Z`                | Undo.                                                    |
| `⌘⇧Z` / `Ctrl` + `Y`            | Redo.                                                    |
| `Escape`                        | Step up from text to the block.                          |
| `/`                             | Open the command menu.                                   |

A line break at the very end of a block renders a trailing `<br>` alongside the
newline. Under `white-space: pre-wrap` that last newline ends the line and has
nothing after it to fill another, so without the filler the block did not grow
and the next character landed in front of the break instead of after it. It is
presentation only: the model holds one `\n`, and reading the DOM back — a paste,
a `syncFromDom`, the clipboard — treats a trailing `<br>` as nothing.

## Block types

`paragraph`, `heading1`, `heading2`, `heading3`, `bulleted_list`,
`numbered_list`, `todo`, `quote`, `code`, `callout`, `toggle`, `image`, `table`,
`divider`

### Callouts and toggles

Both own the blocks nested under them, so `Enter` inside one opens a **child**
rather than a sibling — the only way to put the first block inside an empty one.

A **callout** carries an `icon`, any single emoji. Clicking it opens a small
picker with common choices and an input that takes anything else. Only the first
grapheme is kept, so `⚠️` survives intact rather than losing its variation
selector.

A **toggle** carries `collapsed`. Collapsing hides every block nested under it,
and those blocks then **travel with it**: selecting, moving, copying or deleting
a collapsed toggle carries its hidden children, because leaving behind blocks the
user cannot see is how documents get silently mangled.

```js
editor.toggleCollapsed(id);
editor.setCalloutIcon(id, '⚠️');
```

### Images

An **image** carries `src` and `alt`, and its `content` is the caption — ordinary
rich text, so it can hold links and formatting. Clicking the image (or the
placeholder on an empty one) opens a popover for the URL and the alt text.

The picture is an `<img>` in its own right, with the button that edits it laid
over it rather than wrapped around it: a `<button>` makes its children
presentational and its own label beats name-from-content, so an `<img>` inside
one is announced as neither an image nor its alt text.

Sources are sanitized: `http`, `https`, site-relative paths, and base64
`data:image/*` are accepted. `data:image/svg+xml` is deliberately refused — an
SVG can carry script, and although it stays inert inside an `<img>`, the same
string handed to an `<object>` or a new tab would not be.

There is no upload story in the package: an image is a URL. Wire your own upload
to `setDocument`, or build the block yourself.

### Tables

A **table** is one block holding a rectangular grid of rich text in `rows`, not a
container of other blocks. Cells hold text rather than arbitrary structure, which
is what keeps the flat block list flat — undo, block selection, drag handles and
the clipboard all keep treating a table as a single unit.

Row 0 is always the header. Every operation keeps the grid rectangular and
non-empty, so deleting the last row or column empties it rather than leaving a
table with nothing in it.

With the caret in a cell, a toolbar offers insert and delete for the current row
and column. `Tab` and `Shift`+`Tab` walk the cells in reading order, and `Tab`
past the last cell appends a row. `Enter` breaks the line inside a cell; `↑`/`↓`
step between rows and leave the table at its edges.

The grid operations are exported and pure, if you would rather drive them
yourself: `createTableRows`, `tableInsertRow`, `tableDeleteRow`,
`tableInsertColumn`, `tableDeleteColumn`, `tableSetCell`, `tableSize`,
`tableStep`.

## Document format

A document is a flat, ordered list of blocks — a table of blocks rather than a
nested tree — so reordering and indenting never rewrite a subtree. Nesting is the
numeric `depth` field.

A block's text is a list of _runs_: slices of text carrying marks and an optional
link. That is what makes formatting interval arithmetic (split at two offsets,
flip a flag) instead of DOM surgery over partially overlapping
`<strong>`/`<em>` elements.

```json
{
  "blocks": [
    { "id": "…", "type": "heading1", "content": [{ "text": "Title" }], "depth": 0 },
    {
      "id": "…",
      "type": "paragraph",
      "content": [
        { "text": "See the " },
        { "text": "docs", "marks": ["bold"], "link": "https://example.com/" },
        { "text": " for details." }
      ],
      "depth": 0
    },
    { "id": "…", "type": "todo", "content": [], "depth": 0, "checked": false }
  ]
}
```

Runs are canonical: marks are sorted, empty runs are dropped, and adjacent runs
with identical formatting are merged. Two documents that look the same are
therefore deeply equal.

`normalizeDocument()` fills in missing fields, drops unknown marks, and migrates
the pre-rich-text `text: string` shape, so content from a database or an older
schema is safe to pass straight to `setDocument()`.

The rich-text operations are exported if you want to build content
programmatically: `richFromPlainText`, `richSlice`, `richSplit`, `richConcat`,
`richInsert`, `richDelete`, `richSetMark`, `richToggleMark`, `richSetLink`,
`richActiveMarks`, `richActiveLink`. All are pure and offset-based.

## Copying and pasting

Content arriving from outside the editor is **parsed, never inserted as
markup**. `<script>`, `<style>` and `<iframe>` are dropped entirely, and only
`http`, `https`, `mailto` and `tel` links survive — `javascript:` and `data:`
hrefs are stripped while their text is kept.

That covers dragging as well as pasting. A native drop is cancelled and its
payload re-entered through the same parser, because the browser's own default
is to write the dragged fragment straight into a live editing host — and the
editor would then read that fragment back as the block's own content, so
nothing later would render it away. The cost is that dragging text _inside_ the
editor copies rather than moves: the native move is one gesture, and refusing
the drop refuses both halves of it. Use the gutter's **⠿** handle to move
blocks.

The same holds for documents loaded with `setDocument`: `normalizeDocument`
sanitizes every link and image source, so a document written by another user is
safe to render. This is enforced at the point every run is constructed, not at
the paste boundary alone.

A paste becomes real blocks. `<h1>`–`<h6>`, `<p>`, `<ul>`/`<ol>` (including
nested lists), `<li>` with a checkbox, `<blockquote>`, `<pre>` and `<hr>` map
onto block types; `<b>`, `<i>`, `<u>`, `<s>`, `<code>` and inline
`font-weight` / `font-style` / `text-decoration` map onto marks, so content from
Word, Google Docs and other editors keeps both its structure and its formatting.

When the clipboard carries no HTML, the plain text is parsed as **Markdown** —
`# `, `- `, `1. `, `> `, `- [x] `, `---` and fenced code, plus the inline rules.
One line becomes one block, so soft-wrapped prose arrives as several paragraphs.
Inline parsing replays the same rules used while typing, so pasting `**a**` and
typing it cannot diverge.

Where the paste lands depends on its shape:

- A **single paragraph** is inserted at the caret, so pasting a phrase into the
  middle of a sentence still works.
- **Several blocks** splice into the document: the first merges into the block
  you are in, the last absorbs whatever followed the caret, and pasting into an
  empty block replaces it rather than leaving a blank line above.
- A **table, image or divider** is spliced in whole rather than merged, because
  only its text would survive the merge, and the text that followed the caret
  gets a paragraph of its own rather than being parked in a field a divider or
  a table never draws.
- With **blocks selected**, the paste replaces them.

Either way it is a single undo step.

Copying selected blocks writes Markdown to `text/plain` and HTML to `text/html`,
with genuinely nested `<ul>`/`<ol>` so depth survives a round trip through
another application.

Callouts and toggles have no Markdown of their own, so both degrade to something
readable that still parses back:

| Block   | Markdown                               | HTML                                              |
| ------- | -------------------------------------- | ------------------------------------------------- |
| Callout | `> [!💡] text` — the icon is bracketed | `<blockquote data-neditor-callout="💡">`          |
| Toggle  | `- ▸ text` collapsed, `- ▾ text` open  | `<details>` / `<details open>` with a `<summary>` |
| Image   | `![alt](src)` — the caption is dropped | `<figure><img><figcaption>`                       |
| Table   | a GFM table                            | `<table>` with `<thead>` / `<tbody>`              |

Elsewhere a callout still reads as a quote and a toggle as a list item; a
`<details>` pasted from anywhere else becomes a toggle, with its body nested one
level under it. The callout's icon is bracketed rather than merely leading so
that the two directions agree: an emoji-led quote you wrote by hand stays a
quote, and an icon that is not an emoji still names a callout.

Tables and images are faithful in both formats — a GFM table pasted as plain text
becomes a real table, cell formatting included, and a ragged one is squared off
rather than rejected.

The Markdown writer is defensive wherever the format is ambiguous, so what it
writes is what `blocksFromMarkdown` reads back:

- A code fence is one backtick longer than the longest run inside the block, so
  a snippet that itself contains ` ``` ` comes back as one code block rather
  than three.
- A link or image destination holding a paren, a space or an angle bracket is
  written in the `<…>` form rather than backslash-escaped. The reader matches
  its rules against a projection in which an escaped character is opaque, so it
  could never have found such a URL again.
- An alt text or callout icon containing `[` or `]` is escaped, and unescaped on
  the way back, so a `]` cannot close the label early and leak the rest of the
  line into the document as markup.

## Headless use

The model and both serializers are pure and import-safe with no DOM, so a server
can read and write documents without a browser:

```js
import { blocksFromMarkdown, normalizeDocument, toMarkdown } from '@neditor/core';

const doc = normalizeDocument({ blocks: blocksFromMarkdown(markdown) });
const back = toMarkdown(doc);
```

`toMarkdown`, `blocksFromMarkdown`, `normalizeDocument` and the whole
`model/rich-text` surface need nothing but JavaScript. `blocksToHtml` and
`blocksFromHtml` take a `Document`, so on the server they need a DOM shim
(`happy-dom`, `jsdom`) passed in as the first argument.

Importing the package on a server is safe: nothing touches `document` or
`window` at module scope, so SSR frameworks can import it freely.

## Theming

All colours are CSS custom properties on `.neditor`, so you can restyle without
touching the injected stylesheet:

```css
.neditor {
  --neditor-text: #1a1a1a;
  --neditor-accent: #d4380d;
  --neditor-font: 'Inter', sans-serif;
  --neditor-indent: 2rem;
}
```

The floating toolbar, slash menu and link editor render outside the editor
element so they are never clipped. They carry the `.neditor-portal` class and
read the same tokens, so set custom properties on both selectors if you override
them globally.

They are appended to the mount point's own root node, which is `document.body`
for an ordinary mount and the shadow root for an editor inside a custom element
— a shadow tree does not inherit the document's stylesheets, so a portal in the
body would render with none of this. Pass `portalContainer` to put them
somewhere else (a modal `<dialog>` is promoted to the top layer and paints above
any z-index, so pass the dialog itself); the stylesheet is injected into that
tree as well as the editor's.

The layout uses logical properties throughout, so `dir="rtl"` mirrors
indentation, list markers, the quote bar and the drag handle correctly.

Under a strict `style-src` policy an injected `<style>` is blocked, so either
pass `styleNonce`, or skip injection and use the stylesheet the package ships:

```js
import '@neditor/core/styles.css';
```

To take over completely, pass `injectStyles: false` and import `NEDITOR_STYLES`
as a starting point.

## Roadmap

Implemented: the block model, every block type above, rich text (bold,
italic, underline, strikethrough, code, links), the selection toolbar, the slash
menu, inline and block Markdown input rules, undo/redo with run coalescing,
block selection with drag handles, callouts, collapsible toggles, images,
tables, nesting, block splitting and merging, block movement, a sanitized
multi-block clipboard (HTML and Markdown, both ways), light/dark theming, and
touch support for the gutter, long-press selection and handle dragging.

Known gaps, deliberately out of scope for 0.1:

- **Lists are not real list elements.** A bullet or number is rendered as text
  rather than as `<ul>`/`<ol>` structure, so it is not announced as a list.
- **No IME-aware input rules.** Composition is handled — typing CJK works — but
  Markdown shortcuts do not fire on composed text.
- **Empty paragraphs are dropped by the Markdown round trip.** Markdown has no
  way to express one; the HTML path keeps them.

## License

MIT.

Notion is a trademark of Notion Labs, Inc. This project is an independent
implementation, is not affiliated with, endorsed by, or derived from Notion
Labs, Inc., and "Notion-like" is used only to describe the style of editor it
implements.
