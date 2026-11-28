# @neditor/core

A block-based rich-text editor in vanilla JavaScript. No framework, no runtime
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
- **RegExp lookbehind** in the Markdown table splitter, the italic input
  rules and the autolink input rule — Safari 16.4. This one is a parse-time
  `SyntaxError`, so on an older Safari the whole bundle fails to load, not just
  those code paths. If you need to go back further, transpile the package or
  rewrite those four patterns with capture groups.

These floors are derived from the language features the build uses; they are
not tested. The end-to-end suite (`apps/e2e`) runs in current Chromium,
Firefox and WebKit only, so an older engine above the floor is supported in
principle but unverified.

`Intl.Segmenter` is used to take the first grapheme of a callout icon, but it
is feature-detected — Firefox below 125 keeps the whole string instead of
cutting an emoji in half.

**A shadow-root mount needs Safari 17.** Safari has no
`ShadowRoot.getSelection()`, and its document selection is retargeted to the
shadow host, so the editor reads the caret inside a shadow tree through
`Selection.getComposedRanges()`, which Safari ships from 17. On Safari 16.4–16.x
an editor mounted in a shadow root cannot see its own caret: input rules never
fire and `Enter` splits at the start of the block. Mounts in the light DOM or in
an iframe are unaffected, and Chrome and Firefox need nothing extra.

**Page setups.** Pointer, keyboard and selection behaviour is built and tested
with real input for pages where:

- the editor's own pointer, key, focus and selection events reach it: a page
  that cancels them or stops their propagation before the editor hears them
  can leave a gesture or a guard open;
- one editor holds the reader's selection at a time: several editors on a page
  work, but a selection or gesture carried from one into another is not
  specified;
- the editor and its frame are drawn at their layout size: under a `transform`
  or `zoom` around them, pointer placement is best effort, and WebKit's `zoom`
  is not measured at all;
- `setDocument` and `setEditable` arrive between the reader's gestures, or
  during a text drag, which goes on (see
  [Block selection and drag handles](#block-selection-and-drag-handles)). A
  lock, reorder or page overlay that arrives while a press is still held ends
  or holds the gesture, and how beyond that is not specified.

Outside these, behaviour that cannot lose or change the reader's content is a
known limit rather than a bug.

**TypeScript 4.7+** if you consume the types. The package ships `.d.mts` and
`.d.cts` and points at them through `exports`; a compiler older than that
understands neither the extensions nor the map, so it reports the package as
untyped rather than as mistyped. This is the same kind of floor as the one
above — there is no compatibility copy of the declarations, and no
`typesVersions` fallback for the `./model` subpath either.

If you run [`arethetypeswrong`](https://arethetypeswrong.github.io) over this
package you will see two expected failures rather than none. `./model` does not
resolve under `node10`, which is the floor above stated as a matrix cell — the
main entry only resolves there because its `main` and `types` fields happen to
predate the map. And `./styles.css` does not resolve as types under any setting,
because it is a stylesheet: import it through a bundler that understands CSS, or
read the file.

The main entry's declarations open with `/// <reference lib="dom" />`, because
its public types name `HTMLElement`, `ShadowRoot`, `Document`, `Node` and
`DocumentFragment`. A `tsconfig` without `"dom"` in `lib` therefore typechecks
the package without having to add it.

That directive is infectious, and deliberately so: it pulls `lib.dom` into the
importing program, and nothing on the consumer's side can suppress it —
`skipLibCheck` hides errors inside the declarations but does not stop the lib
from being injected. On a runtime whose own globals conflict with the DOM's,
a Cloudflare Worker being the clear case, importing the main entry breaks the
build, and the errors are reported against your own lines while naming nothing
from this package.

So the DOM-free half is a separate entry:

```ts
import { blocksFromMarkdown, normalizeDocument, toMarkdown } from '@neditor/core/model';

const doc = normalizeDocument({ blocks: blocksFromMarkdown('# Title\n\nBody') });
const markdown = toMarkdown(doc);
```

`@neditor/core/model` is the document without the editor: the block model, rich
text, tables, history types, the Markdown reader and writer, the input rules and
the URL sanitisers. Its declarations name no DOM type and reach no declaration
that asks for one — `scripts/check-dts.mjs` compiles a consumer against the
packed tarball with `lib: ["es2022"]`, no `dom`, and `skipLibCheck` off, and
then walks everything those declarations import to prove none of them requests
it. Use it from a worker, an edge function, a server rendering stored documents,
or a build step; use the main entry wherever there is a DOM to mount into.

It does not export `NEDITOR_STYLES`. That constant lives beside `injectStyles`,
whose signature names `Document | ShadowRoot | Element`, and re-exporting its
neighbour dragged that declaration into the entry's shared chunk. A server that
wants the stylesheet reads the `dist/styles.css` the package already ships.

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

### From a CDN

Use a full, versioned path to `dist/index.mjs`:

```html
<script type="module">
  import { createEditor } from 'https://cdn.jsdelivr.net/npm/@neditor/core@0.1.3/dist/index.mjs';
  createEditor({ element: '#editor' });
</script>
```

Not the bare `https://cdn.jsdelivr.net/npm/@neditor/core`. The ESM build is code
split — `index.mjs` imports a sibling `./markdown-*.mjs` — and jsDelivr serves a
bare package URL with a 200 rather than a redirect, so the response URL stays at
`/npm/@neditor/`, the relative specifier resolves against that, and the chunk
404s. unpkg redirects into `dist/` and so happens to work either way; the
versioned path above works on both. Dropping the `@0.1.3` works too if you would
rather track latest — any path ending in `/dist/index.mjs` puts the base URL
inside `dist/`, which is the only thing that matters.
`https://cdn.jsdelivr.net/npm/@neditor/core/+esm` also works, because jsDelivr
inlines the chunk for that path.

## Options

| Option            | Type                                       | Default              | Description                                                       |
| ----------------- | ------------------------------------------ | -------------------- | ----------------------------------------------------------------- |
| `element`         | `HTMLElement \| string`                    | —                    | Mount point, or a selector. Required.                             |
| `doc`             | `NEditorDocument`                          | one empty paragraph  | Initial content.                                                  |
| `editable`        | `boolean`                                  | `true`               | Set `false` for a read-only view.                                 |
| `autofocus`       | `boolean`                                  | `false`              | Focus the first block on mount.                                   |
| `injectStyles`    | `boolean`                                  | `true`               | Set `false` to supply your own CSS.                               |
| `theme`           | `'light' \| 'dark' \| 'auto'`              | `'auto'`             | `auto` follows `prefers-color-scheme`.                            |
| `toolbar`         | `boolean`                                  | `true`               | Set `false` to suppress the selection toolbar.                    |
| `historyLimit`    | `number`                                   | `200`                | Undo steps retained; at least 1, so `0` keeps one.                |
| `dragHandles`     | `boolean`                                  | `true`               | Set `false` to suppress the hover gutter.                         |
| `onChange`        | `(doc) => void`                            | —                    | Shorthand for `editor.on('change', …)`.                           |
| `onError`         | `(error) => void`                          | `console.error`      | Called when one of your listeners throws.                         |
| `label`           | `string`                                   | `'Rich text editor'` | Accessible name. Ignored if the element already has one.          |
| `labels`          | `Partial<NEditorLabels>`                   | English              | Accessible names, placeholders, menu entries, announcements.      |
| `portalContainer` | `HTMLElement \| ShadowRoot`                | the mount's root     | Where the floating UI goes; in the top layer, pass it.            |
| `styleNonce`      | `string`                                   | —                    | `nonce` for the injected `<style>`, for a strict `style-src`.     |
| `renderMath`      | `(tex, { displayMode }) => string \| Node` | —                    | Draws TeX. See [Math](#math). Without it, TeX is shown as source. |

## API

```ts
editor.getDocument(): NEditorDocument   // deep copy of the current document
editor.setDocument(doc, { silent }?): void // replace the content; silent: no `change`
editor.element: HTMLElement             // the mount point
editor.editable: boolean                // current read-only state
editor.getMarkdown(): string            // serialize to Markdown

editor.toggleMark(mark): void           // 'bold' | 'italic' | 'underline' | …
editor.setLink(href | null): boolean    // false if refused: unsafe URL, no range, code or an equation, read-only
editor.openLinkEditor(): void
editor.openMathEditor(): void           // edit or insert an inline formula (Mod+Shift+E)
editor.getSelectionState(): SelectionState | null

editor.undo(): boolean                  // false when there is nothing to undo; takes focus
editor.redo(): boolean                  // likewise
editor.canUndo: boolean                 // getters, for driving your own buttons
editor.canRedo: boolean
editor.clearHistory(): void

editor.getSelectedBlocks(): string[]     // block-level selection, in document order
editor.selectBlocks(ids): void          // pass [] to return to text editing
editor.clearBlockSelection(): void      // same thing: the caret comes back

editor.setBlockType(id, type): void
editor.toggleTodo(id): void
editor.focus(id?, offset?): boolean      // false when nothing there took the caret
editor.focusRange(id, start, end, cell?): boolean
editor.setEditable(editable): void
editor.destroy(): void

editor.on('change', (doc) => {})        // returns an unsubscribe function
editor.off('change', listener)          // the same, by reference
editor.on('focus', ({ blockId }) => {})
editor.on('selection', (state) => {})   // null when the caret leaves the editor
editor.on('history', ({ canUndo, canRedo }) => {})
editor.on('blockselection', ({ ids }) => {}) // ids in document order
```

`setDocument(doc, { silent: true })` replaces the content without emitting
`change`. That is the call for loading a document your own `change` handler
produced -- a collaboration update, a reload -- which would otherwise echo back
into the same handler without end.

`setDocument` closes the editor's popovers and toolbars, since they describe the
document being replaced, and it never takes focus from where the reader is: focus
outside the editor stays there, and the one move it makes is out of the editor,
when what the reader was in is gone (below). When one of them held focus
(the link editor, the image and icon popovers, the table toolbar after `F10`),
focus leaves the editor -- to `<body>`, or wherever the browser puts it -- and
that is deliberate: the reader was typing into that panel, and the rest of what
they type was meant for it. Handed back to the block, the rest of a URL replaced
the text the link was for, and `change` carried the edit out. Typing that lands
nowhere loses nothing; the reader clicks or tabs back in. A `setEditable` call
that switches nothing -- `false` on a read-only editor, `true` on an editable
one, as a host re-asserting its state on every render makes -- changes nothing
at all: no selection, drag, panel, focus or event. `setEditable(false)`
takes focus out of the editor the same way -- off a focused panel, off a
block that can no longer be typed in, off a control it disables (the image
and callout buttons), and off the editor's root, ending a block selection --
with `Backspace` held off as below. So it does for a selection Safari keeps in
a block after a click on a page button, which Safari gives no focus while it
goes on typing into the block. `setEditable(true)` gives a caret it took back
to its block -- an image's caption included -- by id and at its offsets (carried as
below if a `setDocument` changed the text meanwhile), as long as the reader has
not clicked or put focus anywhere since -- in an iframe mount, anywhere in the
page around the frame either -- and without scrolling to it: a host that locks
the editor round a save does not cost the reader their place. It draws again
only the toolbar that was showing at the lock, and the format toolbar only while
its range is on screen, as `setDocument` does below. Inside a page of
another origin, whose focus the editor cannot read, it also needs the window
to have focus, so there -- and only there -- an unlock that lands while the tab
is in the background gives nothing back. A block selection is not given
back. In a modal `<dialog>`
the next `Escape` then reaches the dialog. The
selection one of those panels left in a block goes with it, because Safari
types into such a selection with focus on `<body>`, and focus is taken off the
hidden panel (Safari otherwise leaves it on an invisible button, where the next
`Backspace` goes back in history). Focus anywhere else is left alone, and so is
the reader's selection: a button of your own toolbar that takes focus still
acts on the range the reader made when what arrives during the press is an
update to another block. An update to the block the range is in, or one that
renames the blocks, takes the range with it, and the button acts on nothing:
the text the range was made in has been redrawn (Safari's own reading of a
selection in a redrawn block no longer agrees with itself, and the next key
went into the middle of the block).

An update that reorders the blocks -- the reader's own moved up or down,
others moved across it -- moves the other blocks around the one the reader
is in, so the caret, a range, a composition, and focus on a control in it
(the to-do checkbox, the callout icon) all stay where they were; with focus
on a button of your own, the block the reader's range is in stays put the
same way.

A caret or range in the block the reader is typing in, when a peer rewrites
that very block (or table cell) under the same id, is carried by the text
around it: each end keeps its offset while the text before it is unchanged,
else its distance from the end while the text after it is (text inserted
exactly at the edge of a range stays outside it), else -- text deleted around
it, nothing put in its place -- it goes where the deleted text was. In
repeated text a deletion or an insertion can be read in more than one place
("ha ha ha!" less a "ha " lost the first, the second or the third), and a
range is carried to what every reading agrees on. A reading must keep every
code point whole: "ok 👍😀!" less its 👍 is not read as losing the 👍's second
half and the 😀's first, which share a code unit. A reading that cuts a
character a reader sees as one still counts, because a peer's own edit can
cut one -- a Backspace takes one code point of a conjunct, of a Hangul
syllable or of a letter and its accent -- so a selected character can be
left partly behind ("कु" selected, "कि" before it deleted, and typing over
the range replaces only the vowel sign). The range never takes in text the
peer typed at its edge -- except a mark a peer adds to the range's last
character in every reading, which stays with that character ("cafe" selected
in "cafe!" and a combining acute added to its "e": the range is "café") --
and it is never longer than it should be. The cost is that where the edit is
ambiguous some of the selected text can be left out of the range -- or all of
it, leaving a caret: for a deletion where the selection began, for an
insertion before every place the inserted text could have gone, so never
inside the peer's text, and never inside a character: where that place falls
in one, at the character's start. Where two readings only just meet, the caret goes
before every place too if some reading puts the meeting point inside the
inserted text ("ha" selected and made "haha"), and otherwise stays where
they meet (one "0" of "1000000" selected and a "0" typed: the caret stays
between the same two "0"s). In text holding a lone surrogate every reading
counts, since a peer's edit can complete one into a pair. Counted by
offsets, an end can fall inside a character a reader sees as one (an emoji,
a flag, a letter and its accent), and then it never moves over the reader's own text: a caret whose character
a peer extends (an accent or a vowel sign added to it) goes past the peer's
addition only; a whole character of the reader's that the counting cut is
kept whole; and where the peer's edit joins the
reader's text on both sides of the caret into one character (a deletion
between them, a virama or ZWJ inserted there), the caret stays exactly
between that text, and a range neither grows nor shrinks. A caret the
reader's own typing left inside a character (a virama typed before a
consonant, in Firefox) is left there too -- unless a peer's insertion leaves
nothing of a range that starts there, and the caret it becomes goes to that
character's start ("क्" typed before "म", the "म" selected, the peer making
it "क्म्म": typing lands before the "क"). Where the caret is left inside a
character, the editor cannot tell where the browser will type: Chromium and
WebKit type at the end of that character, whatever offset they report. Where text
was put in across an end, nothing says where the reader was, and focus leaves
the editor as it does below. "Typing in" is read from focus, not from the
window: a reader in another tab when the update lands keeps their caret. A
block the peer turned into another text block (a paragraph into a heading)
keeps its id, so its new element takes the caret the same way, and a mouse
drag selecting in the block when the update lands goes on selecting from where
it began -- in a shadow root too, where Safari reports a selection the mouse
made as forward whichever way it was dragged, and the editor asks the press
instead -- and a drag across blocks goes on selecting blocks, and scrolling
where it is held at the window's edge, over any update that leaves the blocks
shown in the same order, its own among them (one that reorders, adds or
removes a shown block ends it at the blocks it held); a drag that has not
left its own block yet when an update edits another block still becomes
one when it does, in a read-only view too -- the browser's own drag over an
update that leaves the blocks shown in the same order (over one that does
not it stays the browser's drag: a text selection in its block, and in a
read-only view, where the browser's selection runs across blocks, the blocks
it covers at the release), and one the editor draws (begun beside the text, or
back in its own block after crossing) over an update to other blocks whatever
it does to their order: it goes on by the new one. A drag in a block an update
rewrote goes on by word or by
paragraph for a double- or triple-click drag, from
the word or paragraph the browser selected for the press, to the word or
paragraph at the caret nearest the pointer, as Chromium and Safari draw it in
text of one direction, with words as `Intl.Segmenter` finds them. The known
differences from the browser's own drag there: Firefox's runs on over a run of
spaces at the caret to the next word; Firefox and Safari split some words
differently at punctuation (`3.14`, `It's`); Safari's backward drag in
right-to-left text treats spaces differently; and in mixed-direction text, at
the visual edge of a run, the word reached can be the one on the other side --
where the browsers' own drags lose the double-clicked word far more often. A
Shift+double- or triple-click that leaves the reader's range and its direction
exactly as they were -- Chromium's and Safari's Shift+double-click, which extend
the range -- goes by character, as they draw it when that range was made by a
click or a drag; made by a double- or triple-click, they go on by its word or
paragraph and the editor by character. Firefox re-anchors every Shift double-
or triple-click on the word or paragraph pressed, and the editor follows it,
except where that word or paragraph is exactly the reader's range in the same
direction, where the editor goes by character. These are known differences,
and with the pointer exactly at the middle of a letter the editor's character
can be one off Chromium's. The editor's own toolbar drawn over the text is no
obstacle to such a drag: it reads the text under it. Carried past the edge of
what the block can be seen in -- the window, or a pane or a dialog that
scrolls the editor, at whatever size it is drawn (`transform: scale()`,
`zoom`) -- through a block taller than that, it goes on selecting
at the edge while the page or the pane scrolls, to the block's first line and
its last. Under something the page
draws over the text (a sticky bar) it keeps the range it had -- the browsers'
own drags differ there: Chromium's and Safari's read the text under the bar,
and so does Firefox's in a shadow root, while in a plain page it leaves the
range -- and there are two halves to that at the window's edge: held there
over text it can read, it goes on scrolling, over an update too; held there
under such a thing (a fixed header), the page does not scroll, since it would
scroll away from a range that cannot follow, and it scrolls again once the
pointer is over text. A sticky header or footer inside a pane that scrolls the
editor is the same thing: such a drag carried under it waits there, its range
held and nothing scrolling, until the pointer is back over text. The reader's own edit in the block with the button
still down (a `Backspace` over the range) ends such a drag. A
Shift drag carried into another block and back is
anchored where the browser anchored the selection for the press, as its own
drag is -- Firefox keeps the reader's anchor, while Chromium and Safari on macOS
take the end of the range farther from the click -- read as the end farther
from the press, so a shadow root, where Safari reports every selection as
forward, does not change it. A Shift press in a block other than the one
holding the reader's caret or range, while that block is being typed in, does
nothing -- not even follow a link: Shift extends a selection within its own
block, on a link there too, and another table cell is another block for this. A
Shift press with no such caret or range -- focus moved to a button on the page,
or into the link editor, a block selection, nothing selected -- is a plain
press, on the text or beside it: the caret where it lands (the start of a list
item for its marker, the nearest cell for a table's border, a new paragraph
below the last block), and a drag from it. A press scrolls only to show a
caret it placed out of sight (the caption under a picture taller than the
window, a cell scrolled out of its table), never the whole block. A Shift+click
on a link in the reader's block, or a Shift press beside the text, extends the
range from its end farther from the click, in every browser, so the text
already selected stays selected -- Chromium and Safari on macOS do the same on
plain text, while Firefox's own Shift+click keeps the range's anchor, so in
Firefox the two can differ; ⌘/Ctrl+Shift+click follows the link, as
⌘/Ctrl+click does. A click on a link opens the link editor just after the
click -- unless the page moved focus elsewhere in its own listener for a
pointer's click, or something newer happened first (a press, a key, a new
document, a switch to read-only) -- and a selection can still be dragged away by
a link inside it. Like a press, it never brings the whole block into view: it
scrolls only as far as shows the end of the link, where that is out of sight
(a script's `click()` on a link scrolled away) or cut by the window's edge (a
few pixels), and closing the link editor -- `Escape` or Apply -- puts the
selection back the same way. A read-only view keeps the browser's own Shift,
whose selection across blocks becomes a block selection to copy -- from a
range in a block's text, or from the caret a click on a divider, or beside a
picture, leaves (a press on the picture itself places no caret in any browser,
so a Shift+click from or onto it selects nothing: a known limit); after a block selection there is none, and a Shift+click is a plain
click. Shift+arrow selects every block its range
reaches, the next one as soon as the range reaches the start of its text. A
pointer's selection is read when the button comes up: a triple-click selects
its paragraph, not the next block, whose start some browsers end the paragraph
at -- in a table's cell, that cell's text; on a collapsed toggle, its text, not
the blocks it hides; on the last block, Safari (and Chrome right after a block
selection) runs the selection on past the editor, and a copy takes the empty
lines after the paragraph too, a known limit -- and an empty paragraph, a divider or a picture with no
caption after it is selected only when the press was on it, as a Shift+click on
it is, or when the selection began on it. A Shift+click beside the next block from the end of a block's text, which
selects no character of either, selects both. A selection from a table's cell
over the cells after it with text, to the next block, selects the table. A
range the reader begins outside the editor is never
made a block selection. A selection the reader begins in the page's own text,
outside the editor, ends a block selection, wherever it is drawn to -- into
the blocks too, where it stays the page's to copy -- in a shadow root as in the
page (not around an iframe mount, whose frame does not hear the page's
selection: there the block selection stays beside the page's range, and Mod+C
copies the page's range), and so does one begun in another editor on the same page: the page has one
selection, and it is no longer the blocks. The other editor's own drag across its
blocks ends it too once it has selected text in the block it began in; a drag
that leaves that block before selecting anything may leave the page no
selection to read, and then does not (Chromium and Firefox; WebKit makes one
when that editor is editable). Nor does a click on a page button. A composition
in progress (an IME) is never let go of: it is carried from where it began,
against the text before it -- the composing text is in no peer's document --
and the browser commits it there. A table whose shape a peer changes (a row or
column added or removed) is the exception: its cells have no ids, the editor
does not look for the reader's cell by its coordinates or its text, and focus
leaves the editor. A caret or
range that survives in the block holding focus keeps its toolbar -- the one
that was showing, while its range is still on screen: a toolbar `Escape`
dismissed stays dismissed, so a collaborator's updates between presses -- to
another block or to the very one the reader is in -- never hold `Escape` back
from the block and the way out, and no toolbar is drawn at the window's edge
for a range scrolled or pushed out of sight. The reader's own next change of
the selection draws it as usual, also when a collaborator's update lands
before the browser has reported that change, and so do undo and redo; a field
on the page whose value the page sets (a title the same update changed) is not
the reader's selection, and draws nothing (in Chromium, a field inside the
editor's own shadow root still does) -- and
formatting armed at
the caret (`⌘B` with nothing selected) stays armed while that block keeps its
id and its text.

The editor never guesses where the reader was: block ids decide, and nothing
else. A block selection keeps the blocks the new document still has under
their ids, and `Shift`+arrow keeps growing from the end it was made from. When
none of them is left and the editor held focus, the selection ends and focus
leaves the editor, as it does after a panel that held focus -- whether every id
is new (a reload from Markdown, a document made with ids of its own) or a peer
deleted just the selected blocks: the blocks beside them are still there by
id, but they are blocks the reader did not choose, and the key pressed for the
selection (`Backspace`, `Delete`, a letter) edited them. The reader clicks or
tabs back in, and a key pressed meanwhile lands nowhere. That includes
`Backspace`, held or pressed again after other keys: a browser can read
`Backspace` on the page as Back, so the editor cancels every one aimed at the
page -- its `<body>`, or a `<dialog>` that `Tab` focused -- until the reader
clicks, taps or puts focus on something else, as it does whenever a
`setDocument`, now or after a debounce, takes away the block or the panel that
held focus (in the page around an iframe mount too, where a `portalContainer`
puts the panels), takes away the block a selection Safari kept for a page
button was in, or `setEditable(false)` takes focus out of the editor or such a
selection's block out of editing (an unlock that finds that selection still in
one of the editor's blocks -- where it was, or moved by Safari's `Shift`+arrow
during the lock -- gives `Backspace` back to it). With
focus anywhere else the selection just ends, and nothing is announced.

Because ids decide, a different document must not reuse the ids of the one
it replaces. Two notes cloned from one template with the template's block ids
are, to the editor, the same blocks: switching from one to the other keeps a
block selection on the block with the same id -- the other note's "Notes"
heading -- and `Backspace` deletes it. Give each document its own ids (a
fresh `createBlock` per block, or `blocksFromMarkdown`), or call
`clearBlockSelection()` (or move focus out of the editor) before switching.

Guessing was tried and each guess cost something: found again by
its position, a selection below blank paragraphs Markdown dropped put the
caret blocks further down (seventy blank lines, sixty-nine blocks), and the
next key was typed into a block nobody chose; found again by its content, a
switch to another note made from the same template selected that note's own
"Notes" heading, and `Backspace` deleted it. The same holds for the edits made
on a block selection: when a `change` listener answers a delete, cut,
duplicate, indent or move by loading a document with new ids, the caret or the
selection that would follow is placed by id or not at all, and the
announcement still says what the edit did ("Block deleted", "2 blocks
duplicated"). A printable key typed over a block selection under such a
listener is typed into the document, and focus then leaves the editor too:
the paragraph it made has a new id, and looking for it by its content once
typed the next key into an identical paragraph forty-nine blocks away. So a host that renames blocks on
each update loses the block selection and focus on every one of them, and a
text caret the same way (a caret is kept only in a block whose id survives,
and in a table only while its shape does: a row or a column a peer adds or
removes redraws the table, and the cell the caret was in is no longer known
by its coordinates; within a surviving block -- whatever text type it now
has -- or a cell of a table that kept its shape, it is carried by the text
around it, above).
Keep block ids stable across your own round trips -- `blocksFromMarkdown`
makes new ones, so reuse the ids you already had where the content matches.

`undo()` and `redo()` put the caret (or the block selection) back where the edit
was made, so they move focus into the editor. A toolbar button that should keep
focus for repeated presses has to take it back itself.

`editable: false` is a hard contract: the document does not change. The controls
the renderer draws stay reachable — a keyboard reader has to be able to move
through them — but a read-only to-do checkbox, toggle chevron or image button
does nothing rather than firing a `change` your persistence layer would write
back as the author's revision. The image trigger and the callout icon say so,
too: they are `disabled`, not silently inert — and an empty image draws no "Add
an image" button at all, since a disabled prompt is still an authoring prompt.

`destroy()` is final and idempotent. It unhooks every listener and takes the
views out of the page, and afterwards `setDocument`, `setEditable` and the edit
methods do nothing — the instance often outlives the mount point by a callback
or two, and rendering into a root that has no listeners left produces content
nothing can edit, style, or remove. One editor mounts on an element at a time:
constructing a second on an element another editor holds throws until that one
is destroyed, since both would draw into the same root.

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

| Key                        | Action                                                       |
| -------------------------- | ------------------------------------------------------------ |
| `⌘`/`Ctrl` + `B`           | Bold                                                         |
| `⌘`/`Ctrl` + `I`           | Italic                                                       |
| `⌘`/`Ctrl` + `U`           | Underline                                                    |
| `⌘`/`Ctrl` + `E`           | Inline code                                                  |
| `⌘`/`Ctrl` + `Shift` + `X` | Strikethrough                                                |
| `⌘`/`Ctrl` + `K`           | Add or edit a link (with a caret in a link, that whole link) |

With nothing selected, a mark shortcut _arms_ the formatting and the next text
you type picks it up — the same as any word processor. A partially bold
selection reports Bold as inactive, so pressing it bolds the remainder rather
than clearing what is already bold.

Clicking a link opens the link editor; `⌘`/`Ctrl`-click opens it in a new tab
with `noopener,noreferrer`. In read-only mode every link click does the same —
the handler always cancels the native navigation, so an unsafe `href` can never
reach the browser by falling through.

The link editor, the callout icon picker and the image popover all take focus,
and all three close on a pointer that lands anywhere outside them, or when focus
arrives anywhere outside them (`Tab` or `Shift`+`Tab` out, a click into another
field) — leaving focus wherever it was put, rather than dragging the caret
back. In an editor mounted in an iframe, the page around the frame counts as
outside too, as long as the frame may reach it (same origin). The format and
table toolbars go the same way when focus or a press leaves for the page (or
the page around the frame) -- from the text, or from the table toolbar `F10`
moved focus into -- and come back with focus. A range put in the text from
outside, such as the match Firefox's Quick Find selects while focus stays in
its find bar, draws neither. Switching to
another window is not leaving: the popover is still there when you come back.
Closing
one from the inside does restore the range it was opened for, which is why
`Escape` only dismisses the popover the current block (or table cell) opened:
pressed anywhere else it does its usual job of stepping up from text to the
block.

### Inline Markdown

These convert the moment you type the closing delimiter:

`**bold**` `__bold__` `*italic*` `_italic_` `` `code` `` `~~strike~~` `<u>underline</u>` `$TeX$`
`[text](url)` `[text](<url with spaces>)`

A delimiter typed _into_ an inline code run is code, and closes nothing: a `*`
or a backtick typed at the end of `` `a*b` `` stays in it. (A span typed in plain
text around a code run still applies, as it does when the line is pasted.)

A link's destination is literal: `*`, `_` and `~` inside a URL are never read as
formatting, so `__init__` in a link stays `__init__` -- in a `<…>` destination
too, which may hold spaces: `[docs](<https://a.test/my docs/__init__.py>)` links
to `…/my%20docs/__init__.py`. Only a `](` after a non-empty `[label]` opens one,
so `ref [x] then f](g*h*` still italicises.

A code span's contents are literal the same way: nothing closes inside a code
span that is still open, so `` `__init__` ``, `` `f(*a*)` `` and
`` `[x](https://a.test/)` `` stay code with every character in place, and a
backtick inside a run already formatted as code never pairs with one typed
after it. That holds for a span opened after the emphasis around it too:
``*y `a*b` z*`` is italic around the code `a*b`, not an italic that closed on
the star inside it. The price is a stray backtick that never closes: until one
does, nothing after it converts for the rest of the block -- past a
`Shift`+`Enter` line break too, not just to the end of its line -- and neither
does an emphasis or link opened before it and closed after it, typed or pasted
(``*use ` with care*`` stays literal).

Code spans pair backtick runs by length, but a span typed with a single
backtick closes on the first backtick of a longer run inside it, which has not
arrived yet when it does: `` `a `` b` `` comes back as the code `a b`, where
CommonMark keeps the two backticks, and a paste reads it the same way. Open
such a span with a run longer than any inside it.

The HTML spellings the Markdown writer uses for formatting that starts or ends
with a space convert too: `<u>underline</u>`, `<strong>`, `<em>`, `<s>` and
`<code>`. Inside a link destination only the link itself and a code span that opened before it close
(a backtick that begins inside one is part of the URL, as in CommonMark), so `_x_`
in a URL is not italicised -- a plain destination ends at the first space, a `<…>`
one only at its `>`, a `<` or a line break -- and neither is a `_x_` that opens inside a bare URL, up to the next
whitespace; `_see https://a.test_`, which opens before it, still is. A bare URL here is
`http://` or `https://` anywhere in a word, or `www.` at its start or after `*`, `_`, `~`,
`(`, `[` or `]` (or, in pasted Markdown, after any backslash-escaped character), in either
case --
broader than what GFM links, on purpose: underscores kept where another reader would have
emphasised cost nothing, and underscores taken out of a URL do. A span may cross a line break made with `Shift`+`Enter`, as it may
in CommonMark, but an emphasis delimiter (`*`, `_`, `~`) cannot sit against the break.

An autolink, `<https://…>`, becomes the plain URL it holds when its `>` is typed, as
the writer spells a bare URL that way. While one is open nothing closes inside it except a
code span that opened before its `<`, and it does not close inside a code span left open
before it. A
plain link destination may hold balanced parentheses, as CommonMark allows
(`[wiki](https://en.wikipedia.org/wiki/Foo_(bar))`).

Every inline rule reaches back about 2,000 characters for its opener, typed or
pasted, and no further (pasted Markdown counts an escape such as `\_` as one
character). A span longer than that is never read as one -- a link too,
whichever form its destination takes. So a link whose URL is that long, such as
a signed or tracking URL, does not survive this editor's own Markdown: it comes
back as its Markdown text -- every character of its label and URL, though
formatting inside the label still applies -- with no link (HTML keeps it). A
long label is split into pieces the reader can reach, each written as a link
that repeats the URL, so beside a long URL it can be written many times over;
any piece that still does not fit (a word too long for the room beside the URL,
or, after a word of more than about 1,500 characters, that word and the rest of
the label) comes back as its own Markdown text, brackets and URL included. A URL that leaves (about) no room for any label is
written once, whole, for each stretch of the label that shares its formatting
(a bold word in the middle of a label makes three).

A link written inside another link's destination -- `[x](…)` inside a URL,
which only foreign Markdown can hold, since the writer escapes every `](` in a
destination -- is read as a link the moment its own `)` arrives, before the
outer link is known, where CommonMark would keep it as URL text. So when the
outer link then closes, the inner link's brackets and URL drop out of the outer
URL and only its label stays (`[a](https://a.test/[x](https://b.test/)y)` links
`a` to `https://a.test/xy`); when the outer one never forms, the inner one
generally stays a link of its own. The exception is text read as an autolink
still open -- after a `<http://` or `<https://`, an angled destination that
starts with one included, up to the next whitespace and within the reach above
-- where no link closes, so a `[x](…)` there stays text. Where the inner link
is refused (an unsafe URL), the formatting characters after it in the outer
URL are no longer protected.

### Block Markdown

Typing these at the start of a paragraph converts the block:

`# ` `## ` `### ` `- ` `* ` `+ ` `1. ` `1) ` `> ` `[] ` `[ ] ` `[x] ` ` ``` ` `$$` `---` `*** `

`[x] ` makes a to-do that starts checked. `---` becomes a divider the moment the
third dash is typed; `***` waits for the space after it, because `***` is also
how `***bold italic***` begins. None of these fire in a code block or a display
equation, and the slash menu does not open in either, or in an image caption,
where `/` is ordinary text and a command would retype the block.

` ``` ` opens a code block only when nothing after it on its line holds a
backtick, as a fence's info string may not in CommonMark: ` ``` ` typed in
front of ` npm install``` ` leaves a code span to be closed, and a pasted line
` ```npm install``` ` -- how chat apps write inline code -- is a paragraph
holding the code `npm install`, not a fence that swallows the lines after it.
Typed from the start of an empty line, ` ``` ` still converts at once, since
the rest of the line has not been typed yet.

Both sets fire on **typing only**. A rule reads the text before the caret and
takes it as something you have just finished typing, which a deletion leaves
there without anyone having typed it: backspacing the word after a `# ` would
otherwise convert the block and swallow the prefix you were clearing. The slash
menu is the exception once it is open — it tracks the text either way, so
backspacing narrows the query and deleting the `/` closes the menu.

## Block selection and drag handles

Hovering a block reveals a gutter to its left: **+** inserts a paragraph below
the block and everything nested under it (a collapsed toggle keeps its children),
and the **⠿** handle selects on click and reorders on drag. No press that
selects a block scrolls to it -- a click on the handle, a press on a divider or
a picture, a long press, a read-only view's `Shift`+click: the block is under
the pointer, and one the window's edge cuts stays where it is. The keyboard
does bring a block it selects into view, `Enter` on the handle included;
`Shift`+`↑`/`↓` brings the end of the selection it moves, growing or
shrinking, not the block the selection grows from -- from its first step out
of the text, which takes in the next block and shows it. A `setDocument` keeps the
gutter beside the block it was showing for, wherever that block now is (gone,
the gutter hides), and draws none where none was showing.
Dragging shows a drop
indicator, and `Escape` mid-drag abandons it and does nothing else: the dragged
blocks stay selected and focus stays in the editor. Dragging a handle that
belongs to an existing selection moves the whole selection, and a selection with
gaps in it moves as one contiguous group — the blocks land together at the drop,
in document order, and whatever sat between them stays where it was. Dropped
among a parent's children, the blocks join them at their depth, and a block
that was not moved keeps its parent -- the nearest shallower block above it --
unless that parent was moved; one whose parent was moved goes with the block
before it. Holding
the pointer near the top or bottom edge of the visible part of a scroll
container scrolls it, faster the closer the pointer is, so a block can be moved
further than one screen. The nearest scrolling ancestor goes first (a `<body>`
that scrolls itself counts); once it can go no further, or while its own edge
is off-screen -- a pane taller than the window -- the next one out scrolls
instead, ending at the page; for an editor in a same-origin iframe, at the page
around the frame, read at the scale the frame is drawn at (a frame under a
`transform: scale()` or `zoom` whose window cannot be read exactly ends the
walk there). A press that lands in an edge band does not scroll until the
pointer moves past it towards that edge. An undo, a redo or any other
change to the document mid-drag ends the drag, since the gap it was aiming at
belonged to the document before the change.

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

Dragging from one block's text into another with a mouse or pen selects whole
blocks as you go; dragging back into the block it started in turns it back into
a text selection, from where the press landed to the pointer -- or, where that
block has no text to come back to (a divider, a picture; a block whose text a
`setDocument` replaced whole mid-drag), selects that block alone. A press beside
the text -- on a list marker, a table's border, a block's margin or the editor's
padding -- puts the caret in the nearest text and starts the same gesture from
there once the pointer has moved a few pixels (before that it is a click). The
same edge autoscroll applies, and `Escape` ends the gesture while
keeping what it has selected; so does a change to the document mid-gesture,
an undo included. A `setEditable(false)` that takes editing away mid-gesture
ends it and the block selection with it -- or finds it ended already, by
`Escape` or an update, with the button still down -- and it stays ended until
the next press: what the browser goes on selecting with the button still down is not
taken up at the release, and no selection across blocks is left there, in a
shadow root or out of one (a
range inside one block is the browser's own, and stays). A `setEditable` call
that switches nothing is no lock: a read-only view's drag across blocks goes
on through it, and through a `setDocument`, and selects the blocks it covers
(one that reorders the blocks after the drag has begun selecting them ends it
at the blocks it held, as in an editable view, and the release leaves no
selection of the browser's beside them). A
known limit in Safari: while a drag across blocks is held, Safari keeps a
caret of its own (a range, after an update rebuilt the block the drag began
in) in the block under the pointer; nothing is drawn for it and keys act on
the block selection, and the release takes it out. Beside the text, a right or middle press leaves the caret
and any range where they were, `Shift` and a press extends a range to the
nearest point of its own block, and a press on a scrollbar only scrolls. A
finger doing the same is the browser's scroll, so touch
never starts one; a long press is the touch way into block selection.
Every block is its own `contenteditable`, and browsers confine a selection to a
single editing host, so the gesture is tracked directly rather than read back
from a DOM range that never spans blocks.

Blocks can also be selected as units from the keyboard. `Escape` in text steps up
to the block containing the caret; `Shift`+`↑`/`↓` once the selection's moving end
is at a block edge extends into whole blocks — so from the middle of a line the
first press selects to the edge and the second takes the blocks; `⌘A` takes the
block's text, and a second `⌘A` takes every block.

With blocks selected:

| Key                            | Action                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `↑` / `↓`                      | Move the selection.³                                                              |
| `Shift` + `↑`/`↓`              | Extend it.                                                                        |
| `⌘`/`Ctrl` + `Shift` + `↑`/`↓` | Move the blocks, as one contiguous group.⁴                                        |
| `Tab` / `Shift` + `Tab`        | Indent / outdent each one.²                                                       |
| `Backspace` / `Delete`         | Delete them.                                                                      |
| `⌘`/`Ctrl` + `D`               | Duplicate them, after what they hold.                                             |
| `⌘`/`Ctrl` + `C` / `X`         | Copy or cut, as Markdown and HTML.                                                |
| Any character                  | Replace them with a paragraph holding it (an IME or a dead key composes into it). |
| `Enter`                        | Drop back into the text of the last one.¹                                         |
| `Escape`                       | Leave the editor.                                                                 |

¹ The last one that has text: a divider has no caret to take, so `Enter` walks
back through the selection and, if none of it can hold one, keeps the selection
— unless that is a divider ending the document, when `Enter` opens a paragraph
after it.

² Each block moves one level on its own, as far as it can: never more than one
level below the block above it as that block now stands, nor past the depth
limit. So the selection's shape is not preserved: a block already at the root
stays there while its selected children come out to meet it, and when the
first block cannot indent, the rest indent under it. When nothing can move, `Tab` is not swallowed: the caret goes back into the
last selected block (the first, for `Shift`+`Tab`) and focus moves on from
there, exactly as it would from the text of that block.

³ `↓` on a divider that ends the document opens a paragraph after it: it is the
keyboard's only way below one.

⁴ A step passes the next block together with everything nested under it,
unless that block is shallower than the selection: then it is one step, which
is how a block moves out of a list.

Undoing an edit made on a block selection brings the selection back with the
blocks; deleting one lands the caret on the nearest block that can hold it (the
end of a table before it is its last cell), or selects that neighbour when none
can -- found by id: when a `change` listener has renamed them all, focus leaves
the editor instead (see `setDocument` above).

The two modes are mutually exclusive, in both directions: entering block selection
takes the caret out of the document, so the format toolbar hides and keystrokes
address blocks rather than characters — and placing a caret leaves block
selection, so `focus()`, `focusRange()` and `setBlockType()` end it rather than
leaving an invisible selection to swallow the next key. Both return `false` when
there is nowhere to put the caret, and whenever the block did not take focus --
in a read-only editor, or one made inert by a modal `<dialog>` elsewhere on the
page -- and then change nothing, block selection included. An empty selection is not a mode: deselecting
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
and the image are real tab stops in every engine, WebKit included (the last two
only while the editor is editable — read-only, they are `disabled` rather than
stops that do nothing), and `F10` inside a table moves focus into the
row/column toolbar, where arrows move between commands and `Escape` returns to
the cell, with the caret or range it had there (backward ranges included). The
toolbar follows its table while the page scrolls -- holding focus, even once the
table is out of sight, since a scroll does not move focus. Only `F10` itself: with
`Shift` (the keyboard's context menu), `Ctrl`, `Alt` or `⌘` the key is left to
the browser and the page. A table wider than a read-only view is a tab stop of
its own, a region named by `labels.tableScrollRegion` ("Scrollable table"),
which the arrow keys scroll sideways; it stops being one once the table fits or
the view is editable, where the cells are the stops. A read-only to-do's
checkbox stays in the tab order, since it is the to-do's state, and says
`aria-readonly="true"`. The callout icon picker opens in its field; `Tab` goes
on into its grid of icons, where the arrows, `Home` and `End` move.

**Touch.** Under a coarse pointer every control the renderer draws takes a press
over at least 24 by 24 CSS pixels (WCAG 2.2, 2.5.8): the gutter's `+` and handle
grow, and `--neditor-gutter-width` with them (to `3.375em`); the to-do box, the
toggle chevron and the callout icon keep the size they are drawn at and take the
press over a band around it. A mouse keeps the compact layout.

A known limit of read-only mode: its text cannot take a caret, so a click into
it focuses the nearest focusable thing, which is the editor as a whole (it
carries `tabindex="-1"` so that a block selection can hold focus, for copying),
and `Tab` then moves on from the editor's first control rather than from the
point that was clicked.

**Getting out.** `Tab` indents, but only when indenting is possible — a `Tab`
that would change nothing moves focus onward instead, so the editor is never a
keyboard trap. In a table, `Tab` past the last cell adds a row only when the last
row has something in it; from an empty last row it moves focus onward too.
`Shift`+`Tab` at the outermost level always leaves. `Escape` twice — once to
select the block, once more — also releases focus, and the `Tab` (or
`Shift`+`Tab`) that follows goes to the next (or previous) focusable element on
the page outside the editor, rather than back into it — past the frame or the
shadow host the editor is mounted in, into the open shadow roots of web
components beside it (a host that delegates focus counts as a stop itself), and
only to something that really takes focus. With nothing to go to, the browser's
own `Tab` goes on from outside the editor, to its toolbar or round the page. A
known limit: a closed shadow root cannot be read from outside it, so the editor
walks such a host's own children as though nothing were attached -- it passes
over the controls inside the closed tree, and for a host with `tabindex="-1"` it
can stop on a slotted control that the browser's `Tab` would skip.
Inside a modal `<dialog>` that is the dialog's own controls: everything outside
it is inert, so with no other control in the dialog the browser's `Tab` comes
back into the editor — Chromium straight to its first block, Firefox and Safari
by way of the dialog itself. Give such a dialog a button of its own (a Close or
Save) and that is where the way out lands. It is spent by that `Tab`: scrolling first with the arrow keys,
`Space` or `Page Down` keeps it, while a click or anything else that moves focus
hands `Tab` back to the browser.
With text selected and the format toolbar showing, the first `Escape` dismisses
the toolbar, so it takes three.

**Announcements.** A polite live region reports block selection, deletion,
cutting, moving, indenting, outdenting and duplicating selected blocks,
block-type changes, toggle state, table row and column edits, and undo/redo. A
selected block is announced by its type and the start of its text —
"Paragraph selected, Block B". The region is visually hidden and cannot be
selected, so a range the reader draws in the page across the editor, and a copy
of it, holds none of its sentences. The
command menu is a combobox on the block being typed in, and its
`aria-activedescendant` follows the highlight on every path that moves it —
arrow keys, filtering, and the mouse crossing an item — so the option announced
is always the one `Enter` will commit.
Selected blocks carry `data-selected="true"` and a 2px accent bar, not colour
alone. They deliberately do not carry `aria-selected`: it is prohibited on the
`generic` role a bare block `<div>` maps to, so browsers drop it, and a role
that would carry it would displace the heading and list semantics the content
element exists to provide. Selection is announced through the live region
instead. The stylesheet has a `forced-colors` block for Windows High Contrast.

**Contrast.** Every text token meets WCAG 1.4.3 in both themes, on every ground
it is drawn on — including inside a selected block, where the selection tint
stacks under the code and callout tints. In light: muted text 6.2:1,
placeholders 5.6:1 (5.1:1 on the code-block tint), inline code 5.6:1 (5.0:1
inside a callout), the error text 5.2:1 on its popover, and the primary button
5.3:1 (7.5:1 in dark); the accent as a pressed toolbar glyph holds 4.7:1 on its
hover tint. The lowest pairing anywhere is 4.6:1, inside a selected block. Component edges
and states clear 1.4.11: input borders, the pressed toolbar bar and the
highlighted command each reach 3:1. Placeholders are drawn only on hosts that
take typing, so a read-only view shows no authoring prompts.

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
out keeps its default. `placeholders`, `slashCommands` and `blockTypeNames` merge
per entry, so translating one of them does not blank the rest, and a
`slashCommands` entry merges field by field: one that gives only its `label`
keeps the default `description` and `keywords`. `blockTypeNames`
is what a selected block is called in announcements; a type without an entry is
called by its slash-menu label, and the one default entry (`paragraph:
'Paragraph'`, since the menu's "Text" is an instruction rather than a name) gives
way to your own translation of the paragraph command when you supply one.

The live-region announcements, and what stands in for one you leave out:

| Label                                                        | Default                                          | Left out by a host that translates the others  |
| ------------------------------------------------------------ | ------------------------------------------------ | ---------------------------------------------- |
| `blockSelected` / `blocksSelected` / `noBlocksSelected`      | `1 block selected` / `{count} blocks selected`   | —                                              |
| `blockSelectedNamed`                                         | `{type} selected, {text}`                        | your `blockSelected`                           |
| `emptyBlockSelectedNamed` — nothing in it                    | `{type} selected, empty`                         | your `blockSelected`                           |
| `textlessBlockSelectedNamed` — a divider, a picture, no text | `{type} selected`                                | your `blockSelected`                           |
| `blockDeleted` / `blocksDeleted`                             | `Block deleted` / `{count} blocks deleted`       | —                                              |
| `blockCut` / `blocksCut`                                     | `Block cut` / `{count} blocks cut`               | `blockDeleted` / `blocksDeleted`, yours or not |
| `blocksMovedUp` / `blocksMovedDown`                          | `Moved up` / `Moved down`                        | nothing is announced                           |
| `blocksIndented` / `blocksOutdented`                         | `Indented` / `Outdented`                         | nothing is announced                           |
| `blockDuplicated` / `blocksDuplicated`                       | `Block duplicated` / `{count} blocks duplicated` | the copies' selection alone                    |

An image is named by its alt text (`Image selected, A blue gradient`), and its
caption when it has none. "Translates the others" means supplies any
live-region announcement older than these — `blockSelected`, `blocksDeleted`,
`undone`, `toggleCollapsed`, a table's `rowInsertedAbove`, `leftEditor` and the
rest of the live region's sentences, but not the ones introduced with these
(the last four rows, `textlessBlockSelectedNamed` and `blockTypeNames`) — so a
host that translated the live region before the newer sentences existed never
has an English one read into it. Labels that are not announced do not count:
a host that names the editor, rewords a placeholder or sets `bold` or `imageUrl`
has not translated the live region, and keeps every English default. A cut is
the exception that is never silent: with no `blockDeleted` / `blocksDeleted` of
yours, their English defaults are announced.

One set of _visible_ button glyphs is not reachable that way: the format
toolbar's `B`, `I`, `U`, `S` and `</>`, which are typographic mnemonics rather
than words. The toolbar takes its accessible names from `labels`, so a screen
reader announces the translation; only the glyph a sighted user reads stays
English.

The table toolbar's `⤫ row` and `⤫ column` **are** in `labels`, as
`deleteRowGlyph` and `deleteColumnGlyph`, and so is the word printed in the
corner of a code block, as `codeBlockLabel`.

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
caret back where you pressed Enter — in the direction it was made, so a
selection grown with `Shift`+`←` keeps growing leftwards. Redo restores where the
redone edit left the caret: redoing a format selects the text again, redoing
typing puts the caret after what was typed. An edit made with the pointer and no
caret in the text (the gutter's `+`, a toggle's chevron) undoes back to the block
it was made beside, and anything with no selection to restore puts the caret
where the document changed — never back at the top of the page.

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

| Key                                               | Action                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Enter`                                           | Split the block. Lists and to-dos continue themselves.                                                 |
| `Enter` at the start of a block                   | Open an empty line above; the block keeps its text.                                                    |
| `Enter` in a code block                           | A newline. Leave with `↓` on its last line, or a click.                                                |
| `Enter` on an empty list item                     | Leave the list.                                                                                        |
| `Shift` + `Enter`                                 | Soft line break inside the block.                                                                      |
| `Backspace` at the start                          | Outdent, then revert to paragraph, then merge upward.                                                  |
| `Backspace` in an image caption                   | Select the image. Reverting it would delete the picture.                                               |
| `Backspace` after an image                        | Select it (an empty line is removed); a new press deletes it.³                                         |
| `Delete` at the end                               | Merge the next block in; from an empty paragraph, remove it instead, so the next block keeps its type. |
| `Backspace` after a divider / `Delete` before one | Delete the divider (it holds no text; undo brings it back).                                            |
| `Delete` before an image                          | Select it (an empty line is removed), as `Backspace` does.³                                            |
| `Tab` / `Shift` + `Tab`                           | Indent / outdent.                                                                                      |
| `↑` / `↓` on a first / last line                  | Move to the previous / next block, keeping the column.¹                                                |
| `←` / `→` at a block's edge                       | Move to the end / start of the previous / next block.²                                                 |
| `⌘`/`⌥`/`Ctrl` + `↑`/`↓`                          | The platform's own: start or end of the block, never across.                                           |
| `↓` at the end of the document                    | After a code block, equation, table or divider, open a paragraph.                                      |
| `⌘`/`Ctrl` + `Shift` + `↑`/`↓`                    | Move the block itself.                                                                                 |
| `⌘`/`Ctrl` + `Enter`                              | Toggle a to-do.                                                                                        |
| `⌘`/`Ctrl` + `Shift` + `E`                        | Insert or edit an inline equation.                                                                     |
| `⌘`/`Ctrl` + `Z`                                  | Undo.                                                                                                  |
| `⌘⇧Z` / `Ctrl` + `Y`                              | Redo.                                                                                                  |
| `Escape`                                          | Step up from text to the block.                                                                        |
| `/`                                               | Open the command menu.                                                                                 |

¹ Lines as laid out: a wrapped paragraph, a `Shift`+`Enter` break and a code
block's lines are each walked by the browser first, and the press on the first
(or last) line leaves the block. The caret lands under where it was, as nearly as
the target's text allows, and a run of presses keeps the column it started from
from block to block, so a short block on the way does not pull it over; a click
starts a new run, and so do an edit and the host's own `focus()`. Inside a block
the browser moves the caret line by line by its own column, not the run's: in any
block that has more than one line -- a wrapped paragraph, a `Shift`+`Enter` break,
a table cell, a code block -- that column is wherever the caret entered the block,
so after entering on a short line (or one that ends before the run's column) the
caret can sit at that line's end and walk on from there, away from the run's
column. The next block is still entered under the run's column. Where a
line wraps, its end and the next line's start are one position; the caret there
is on whichever line the browser drew it on, and the editor asks the browser
which: the end of a wrapped block's first line counts as its first line and the
start of its last line as its last, so `↑` or `↓` from there leaves in one press,
and the column is where the caret was drawn (the end of the line after `End` or a
click past it, the start of the next after `Home`). A table is entered in its first
row going down and its last going up, in the column under the caret; inside one,
`↑`/`↓` step between rows the same way. Dividers, and children hidden in a
collapsed toggle, are stepped over.

² Each block is its own editing field, so without this the browser's arrow stops
dead at its edge. The browser moves the caret first, and a press it could not
move steps out — from the end of the text forward, from its start backward,
wherever bidi has drawn those ends — so in English text in a right-to-left
editor, or Hebrew in a left-to-right one, each end has one key in and one out.
Only those ends: a press the browser could not move in the middle of the text
stays put, which is what keeps `←`/`→` inside a wrapped paragraph as they cross
its line breaks. One limit follows from it. In a line that mixes directions
Firefox moves by what is drawn, and its arrows can stop against the edge of the
line in the middle of the text without ever reaching either end; there, `↑`/`↓`
(and in most such lines the other arrow) still leave the block. A held arrow
crosses one edge per repeat. Table cells are steps in reading order, and
dividers are stepped over.

³ Or a table: neither holds text another block can merge with. Selecting it is
the safeguard, so it holds against auto-repeat — a held key stops at the block it
selected, and deleting it takes a fresh press.

A line break at the very end of a block renders a trailing `<br>` alongside the
newline. Under `white-space: pre-wrap` that last newline ends the line and has
nothing after it to fill another, so without the filler the block did not grow
and the next character landed in front of the break instead of after it. It is
presentation only: the model holds one `\n`, and reading the DOM back — a paste,
a `syncFromDom`, the clipboard — treats a trailing `<br>` as nothing. Typing is
done by the browser, which can take the filler out with a word or line deletion
(Firefox does); the editor puts it back after any deletion that leaves the block
ending in a newline.

Typing over selected text inside one block is done by the editor rather than the
browser, because every engine has its own rule for which formatting the new text
inherits: it takes the marks and the link of the first character it replaces, so
selecting a link's text and typing a new one keeps the link. Each character typed
next at that same caret joins it too, as in Google Docs; anything else ends that
— moving the caret (even back to the same place), a click, Escape, leaving the
editor, toggling a mark (so ⌘B there types bold text after the link), any other
edit, undo or redo. A word composed through an IME over the selection, or at that
caret, gets the same formatting.

## Block types

`paragraph`, `heading1`, `heading2`, `heading3`, `bulleted_list`,
`numbered_list`, `todo`, `quote`, `code`, `math`, `callout`, `toggle`, `image`,
`table`, `divider`

### Callouts and toggles

Both own the blocks nested under them, so `Enter` inside one opens a **child**
rather than a sibling — one way to put the first block inside an empty one (Tab
is another, and so is pasting several blocks after the start of its title).

A **callout** carries an `icon`, any single emoji. Clicking it opens a small
picker with common choices and an input that takes anything else. Only the first
grapheme is kept, so `⚠️` survives intact rather than losing its variation
selector.

A **toggle** carries `collapsed`. Collapsing hides every block nested under it,
and those blocks then **travel with it**: selecting, moving, copying or deleting
a collapsed toggle carries its hidden children, because leaving behind blocks the
user cannot see is how documents get silently mangled. In a read-only view, a
toggle the reader closed with its chevron carries them too; a copy writes the
document, so it is written open, as the document has it, with its children.

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
past the last cell appends a row — while the last row has something in it; past
an empty last row, `Tab` moves focus on. `Enter` breaks the line inside a cell;
`↑`/`↓` step between rows in the column under the caret and leave the table at
its edges, and `←`/`→` at a cell's edge go on to the next or previous cell. With
`Shift` or `⌘`/`Ctrl`+`Shift` held, the arrows act on the table as a block:
extending into block selection, or moving it.

The grid operations are exported and pure, if you would rather drive them
yourself: `createTableRows`, `tableInsertRow`, `tableDeleteRow`,
`tableInsertColumn`, `tableDeleteColumn`, `tableSetCell`, `tableSize`,
`tableStep`.

## Math

Math is TeX, and the document stores TeX and nothing else. There are two kinds:

- An **inline formula** is one run inside any block's text:
  `{ text: '\uFFFC', math: 'x^2' }`. It is an atom -- one character of offset,
  whatever it draws as -- so the caret steps over it, `Backspace` deletes it
  whole, and no formatting, link or split can land inside it. Formulas carry
  no marks and never merge, even with an identical neighbour.
- A **display equation** is a `math` block whose `content` is its TeX, as plain
  text, like a code block's.

`@neditor/core` has no dependencies, so it ships no typesetter. Pass one as
`renderMath` -- with [KaTeX](https://katex.org):

```js
import katex from 'katex';
import 'katex/dist/katex.min.css';

const editor = createEditor({
  element: '#editor',
  renderMath: (tex, { displayMode }) =>
    katex.renderToString(tex, { displayMode, throwOnError: true }),
});
```

It may return an HTML string or a node. Without one, everything still works --
formulas are typed, stored, copied and exported -- and each is shown as its TeX
source in monospace.

A renderer that throws is how the editor learns the TeX is invalid, so pass
KaTeX `throwOnError: true`. The throw is caught: the TeX is shown as source,
and `labels.mathError` is said in words -- under an equation, named as the
TeX field's description, and in the equation popover beside its field, which
is marked invalid. With `throwOnError: false` KaTeX draws the error itself, in
red, and nothing tells a screen reader.

In a shadow root the page's stylesheets do not apply, so KaTeX's CSS has to be
added to the shadow root as well (a `<link>` or an adopted stylesheet there);
without it KaTeX's MathML half is not hidden and every formula is drawn twice.

**Entering math.**

- Type `$x^2$`: the closing `$` makes the formula. As in Pandoc, the opening
  `$` needs a non-space after it, the closing one a non-space before it, and no
  digit may follow the closing one -- so `costs $5 and $6` and `$5-$10` stay
  prose. While typing, a `$` typed before a digit already there closes
  nothing; otherwise the next character has not arrived when the `$` does:
  the formula is made, and a digit typed straight after it takes it back, as if
  it had never been there (undo does not step through it). `$$` is never an
  inline delimiter, a `$` inside a code span is code -- it never opens a
  formula, and one may follow it directly (`` `x$`$y$ ``) -- and `\$` inside
  TeX is TeX's literal dollar.
- Type `$$` at the start of a paragraph, or pick **Equation** in the `/` menu,
  for a display equation. `Enter` inside one adds a line of TeX.
- `⌘`/`Ctrl` + `Shift` + `E` (or `editor.openMathEditor()`) opens the
  equation popover: it edits the formula beside the caret, turns selected text
  into a formula, or inserts a new one. Clicking a formula opens it too, and
  so does the **∑** button on the selection toolbar -- the way in on a touch
  screen.

**Editing.** A formula's TeX is edited in its popover, with a live preview;
`Enter` applies, `Escape` cancels, and **Remove** (or an empty field) deletes
it; `Escape` gives back the caret it was opened from (after the formula, when
it was opened by a click). A display equation is
edited in place: its TeX is an ordinary editable host, shown above the picture
while the caret is in it. Elsewhere only the picture shows, and clicking it --
or arrowing into the block -- puts the caret back in the TeX. Every edit is one
undo step, like any other, and applying a formula unchanged is no edit at all.
Formatting and links do not apply to an equation's TeX (or a code block's): the
toolbar does not offer them there, `toggleMark` and `openLinkEditor` do
nothing, and `setLink` returns `false`.

**Accessibility.** In an editable equation the TeX is the text assistive
technology reads and edits, and the picture beside it is `aria-hidden` and out
of the tab order, so an equation is not announced twice. Read-only there is
nothing to edit, so when there is a picture the picture is what is read (KaTeX
includes MathML for screen readers) and the visually hidden source is hidden
from assistive technology too. An inline formula is whatever your renderer
draws. Nothing here adds a role. Formulas read left to right whatever the
page's direction. Read-only, the popover does not open and a click on a
formula does nothing.

**Serialization.**

|                | Inline formula                               | Display equation                                   |
| -------------- | -------------------------------------------- | -------------------------------------------------- |
| `toMarkdown`   | `$TeX$`                                      | `$$` line, the TeX, `$$` line                      |
| `blocksToHtml` | `<span data-neditor-math="TeX">$TeX$</span>` | `<div data-neditor-math-block="TeX">$$TeX$$</div>` |

The TeX between the dollars is written exactly as it stands, and read back from
the source between them -- so `\_`, `\|` and `*` inside a formula survive in
this reader. A `$` in ordinary text is written escaped, `\$` (inside a backtick
code span it stays bare), and a digit straight after a formula as a numeric
reference (`$x$&#50;`), because a bare one would stop the formula closing. In a
table cell a `|` in TeX is written `\|`, as GFM requires. Pasted HTML is
recognised when it names its TeX: KaTeX output and MathML carrying an
`<annotation encoding="application/x-tex">`, a MathML `alttext`, MediaWiki's
math, and MathJax 2's `<script type="math/tex">` after what any of its output modes
drew (HTML-CSS, CommonHTML, SVG, NativeMML, PreviewHTML, PlainSource; displayed or
not),
or, with no script, the TeX annotation on the assistive MathML of a frame that
draws one formula (with no annotation either, a formula drawn as SVG reads as
that copy's text, the only text it has). A
display equation that is the whole of its paragraph becomes a `math` block. In a
list item it becomes one nested under the item only where that changes no order:
nothing the item keeps as its text stands before it on its line or follows it
anywhere in the item, since an item's text is read before the blocks under it (a
picture, which goes after the item's text, ends the line before it).
Anywhere else -- inside a line of text in a paragraph, a cell or a quote, or in a
list item with text after it (a `<div>` of it, a line after a picture, the
paragraph an item with no text of its own takes as its text) -- it becomes a
formula on a line of its own.

Copying a text range that holds a formula writes it the same way -- the TeX, not
the renderer's picture -- and pasting rendered math into a code block or an
equation takes the TeX the HTML names rather than the glyphs in its plain text.
A formula turned into an equation's text, or a code block's, keeps its TeX:
bare in an equation (spaced from its neighbours, so `\alpha` and `b` do not run
together), between dollars in code.

**What the renderer returns is never read back.** Every reader takes a formula's
TeX from its attribute or annotation and skips the markup that draws it, so no
renderer output -- and no math markup pasted from another page -- can persist in
the document as anything but TeX. The hook is called with TeX from the document,
which is untrusted, and a string it returns is inserted as HTML: it must produce
safe markup for any input. KaTeX does unless you enable its `trust` option.

**Limits.**

- Some TeX has no Markdown spelling, and does not round-trip through
  `toMarkdown` (HTML keeps it). Three shapes are invalid TeX anyway: a bare `$`
  inside a formula, a formula ending in an unpaired backslash, and an equation
  with a line that is exactly `$$`. One is not: in a table cell, a backtick in
  TeX beside a code span, which GFM pairs before anything else is read. Nor
  does an inline formula of about 2,000 characters or more, the furthest the
  inline reader looks back for an opening `$`. (A `](` or an autolink opener
  such as `<https://` inside TeX is the TeX's own: only a link whose `[`, or
  an autolink whose `<`, came before the formula holds its dollars as the
  URL's.)
- Inline TeX is one line with no edge whitespace: a line break becomes a space,
  and U+FFFC and U+FFFF, which mean nothing in TeX, are dropped.
- Safari strips the `<annotation>` from HTML on the clipboard, so KaTeX copied
  from another page there arrives as the text it drew, not as a formula.
- Markdown written before this version wrote `$` bare. Loaded now, a `$…$` in
  it that fits the rule above is a formula.
- Typing `$…$` is matched as the closing `$` arrives, like every inline rule:
  another rule that fires on the way -- `*b*` in `$a*b*c$` -- has already
  taken its delimiters out of the text when the formula closes. Pasted or loaded
  Markdown reads the TeX from its source and keeps them.
- One-line `$$TeX$$` from other writers is read as an equation; `$$` with TeX
  after it that ends on a later line is not.

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

A run can instead be an inline formula, `{ "text": "\uFFFC", "math": "x^2" }`
(see [Math](#math)).

Runs are canonical: marks are sorted, empty runs are dropped, and adjacent runs
with identical formatting are merged (formulas never are). Two documents that look the same are
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
hrefs are stripped while their text is kept. A destination with no scheme that
looks like a host (`example.com/docs`) becomes `https://…` where it is typed --
in the link editor, the image popover, `setLink`, or a Markdown link typed into
a block. Read out of content -- a pasted or dropped Markdown destination, an
HTML `href` or `src`, a stored document -- the same destination is a relative
path (`README.md`, `logo.png`), which names no host and has no page to resolve
against: an HTML link keeps its text and no link, and a Markdown link or image
stays the text it was written. A destination that is only an email address
(`me@example.com`), or an address and a query or fragment
(`me@example.com?subject=Hello there`), becomes `mailto:…` with the query
percent-encoded, typed or read alike. A user name or password in front of an
`http` or `https` host is dropped, because all it still does is disguise the
host: `https://google.com@evil.test` links to `https://evil.test/`.

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
Word's list paragraphs (`mso-list:… levelN`) become list items at their level --
numbered when the marker Word wrote is a number, with or without its full stop
(`1`, `1.1`, a legal `1.01`, a multilevel `1.1.`), or a letter or a roman
numeral (`viii.`) with its punctuation, bulleted otherwise, picture bullets
included -- without the marker; a picture in an item's text is the item's
child image. A `List Paragraph` without `mso-list` is Word's style with no
numbering, and stays a paragraph. WebKit strips the `mso-` styles from a paste
out of Word; where none are left, a `MsoListParagraph` is read as an item when
its text starts with a marker and Word's wide gap after it, and the level is
then read from the indent, in whichever unit Word wrote it (`pt`, `in`, `cm`,
`mm` or `px`). A marker there is a bullet glyph (`·`, `•`) or a number with
its punctuation (`1.`, `(2)`, `1.1.`); a bare number (`1`, `1.1`), a letter or
roman numeral with its punctuation (`a)`, `(iv)`, `viii.`), a character that
stands in for a Wingdings or Courier New bullet (`o`, `§`, `Ø`, `ü`, `v`, `q`,
`n`, `*`, `-`) or a picture no larger than 24px is one only with Word's spacer
after it, the 7pt span WebKit keeps and real Word lists always carry -- so
`2024   Annual results`, `o  clock`, `Yes.  We agree.`, `Dr.  Smith`,
`(c)  2024 Acme` and an icon a note starts with stay text, and a screenshot
first in the paragraph stays a picture. Any other first word -- `Caution:`,
`Results.` -- is text. A link's own underline is how links
look, not a mark: a `text-decoration: underline` on or inside an `<a href>` (as
Google Docs writes every link, and as a browser copies one) is not read as
underline, though a `<u>` there still is.

Whitespace is read as a browser draws it: in a block that does not say
otherwise -- a paragraph, a heading, a `<div>`, a table cell -- each run of
spaces, tabs and source line breaks is one space, and none stands at the start
or end of a line, so a page's line-wrapped, indented `<p>` source -- which
Firefox copies as it is -- pastes as one line. Text styled `white-space: pre`,
`pre-wrap` or `break-spaces` keeps its whitespace exactly, and `pre-line` its
line breaks, element by element: one such `<span>` keeps its own spaces, while
the source indentation around it still collapses. A block itself styled
`pre-line` is read as it stands, its spaces kept along with its line breaks,
since keeping a space a browser would have collapsed loses nothing -- and so
is one a stylesheet makes `pre-line`, a paragraph after a blank line in a table
cell or a bare list item included, since Firefox writes its plain text as
preformatted, byte for byte as its `pre-wrap` twin's, and the two cannot be
told apart (a known limit: the source spaces `pre-line` never drew are pasted). So does text in `<pre>` and
`<textarea>` unless the element itself says `white-space: normal`; `<code>`,
`<kbd>` and `<samp>` are drawn `normal` by default, like the paragraph around
them. Firefox copies a page's classes rather than its styles, so for a block
whose HTML does not say how its whitespace is drawn -- no inline `white-space`
on it or around it, as Chromium and WebKit always write -- the clipboard's
`text/plain`, which Firefox writes as the text was drawn, decides: each block is matched where it stands
in the plain text, and each run of whitespace in it is kept as written where the
plain text holds exactly that run there, so a paragraph or a chat message a
stylesheet made `pre-wrap`, ASCII art in a `pre`-styled one and GitHub's
space-preserving `code` keep their lines and spaces, while the source wrapping
beside them still collapses. A lone space a block starts with is asked about
too, since Firefox writes none it did not draw (`<p> lead</p>` copies as
`lead`): the indented line of a `pre-wrap` verse keeps it, and in a table cell
it counts as the start of a line, since Firefox writes a tab between cells.
The exception is the very start of a copy: a drag begun on the first letter
of a block whose source starts with spaces (`<p>  Hello</p>`, `<li>  Hello</li>`)
copies them collapsed to one, though none was drawn, and that one space is
pasted -- a known limit, because a drag begun after `Sentence.` in
`Sentence.  Next` copies the space it drew and selected in exactly the same
HTML and the same plain text.
A space that starts a line inside a block -- after a `<br>`, or at a paragraph
within it -- is asked about the same way (`one<br> two` in a `pre-wrap`
paragraph keeps it), and Firefox leaves it out where it was not drawn.
Firefox's plain text indents every line by four spaces for each `<ul>`, `<ol>`,
`<dd>` and `<blockquote>` the text is in -- counted for the element the text
stands in, so a quote in a quote or a list in a table cell is indented further
than its block -- so where a line starts with exactly that indentation it is
Firefox's, not the block's: a quote's or a list item's drawn leading space is
the one after it, a line break in a `pre-wrap` quote or item is matched with it
after the break (an empty line has none, and two paragraphs in one item or
quote stand a blank line apart -- as they do with no indentation at all, in a
table cell or in the bare `<li>`s of a drag begun inside a list, where the
second one's drawn leading spaces are kept too), and a `<li>    item`, or a `normal`
`<li>one<br>    two`, whose spaces were never drawn pastes without them --
even when there are exactly as many as Firefox's indentation. In a block with
no indentation of its own -- a table cell, a bare `<li>` -- each line is
matched past the indentation of the element it starts in, so a list, quote or
definition inside a cell reads the same way. Spaces that end a line where a block ends
there collapse, as any block's own end does, whatever the plain text holds,
since Firefox writes a `<dd>`'s trailing space drawn or not -- a `pre-wrap`
definition's drawn one included -- unless the gap to the next line matched
whole, as it did before each line was matched on its own; within one block they stand where
the plain text holds exactly them. Firefox starts each
line of a `<blockquote type="cite">` (a mail client's quoted reply) with `>`
instead, which none of its text is matched past, so the whitespace in one is
read collapsed even where a stylesheet drew it: a known limit. A
lone space a block ends with is asked about only in a table cell, and counts
only at the end of its row, since before the tab Firefox writes a cell's
trailing space whether it was drawn or not; any other block's collapses,
because Firefox writes the one a pretty-printed `<li>first <code>x</code> </li>`
ends with whether it was drawn or not. A block the plain text spells
differently -- an image's alt text, a `<q>`'s quote marks -- or leaves out is
read collapsed, and costs the blocks after it nothing: a table cell after it in
its row is looked for once more right after the next tab on the row's line, and
a row whose first cell is empty, holds only a picture or is spelled differently
is placed at the start of the first line after the last block matched, since
Firefox writes each row on a line of its own. A block's last newline -- or a vertical tab or form feed,
read as one -- ends its last line and adds none, a code block's included. A space WebKit converted to a no-break space at an element boundary is
read back as an ordinary space; a run of them, or one beside another space, is
never collapsed away, while a lone one -- WebKit writes the undrawn space at the
end of a line or a block that way too -- collapses like any space. A lone one
that starts the copy is the space a drag began at (after `Sentence.` in
`Sentence.  Next`), and stays, as the same space in Chromium's copy does.

A selection begun just past the end of a line (or ended at the start of one)
crosses a line break the reader did not select, and browsers write it into the
copy: Chromium and WebKit as a `<br class="Apple-interchange-newline">` that is
the fragment's first or last leaf -- at its top level, or inside the first
block, list item or link -- and Firefox as the block it left, emptied. Such a
break is dropped wherever it is that first or last leaf, together with every
element that held nothing else (WebKit writes the one a drag begun in a closed
`<details>` crossed inside the `<details>`), though never a table's cell, and a
break of that class anywhere else is an ordinary line break. A block whose content draws
nothing -- no text but the source's indentation, no `<br>`, no picture, player
or control, only empty inline elements or empty blocks inside it, as Firefox
writes the paragraph, heading, list item, `<pre>` or `<details>` a drag left
(`<p><a href="…"></a></p>`, `<h2><span></span></h2>`,
`<details><summary></summary></details>`) -- draws no line in the
page it came from, so one at either edge of the copy (or first or last inside
the list, quote or `<details>` at that edge, though not inside a table's cell) is dropped
without asking the plain text, which on a pretty-printed page starts with the
source's own newlines. Neither opens or closes the paste with an empty line,
nor splits the paragraph it is pasted into. Kept: a block element holding a
`<br>` (`<p><br></p>` is a line a reader can select) -- though a `<br>` that
is all a loose `<div>` holds, as Gmail and Outlook write an empty line
(`<div><br></div>`), or one standing alone between blocks, is a blank line
between the blocks around it, and at either end of the paste, with nothing to
stand between, it is trimmed --, a block that declares its own
`white-space` -- this editor's writer marks every block that way, so an empty
paragraph it wrote is pasted as the empty line it is -- whitespace a style or a
`<pre>` keeps, a no-break space, this editor's HTML from before it marked its
blocks, and a copy of nothing but empty blocks. ProseMirror (and so Tiptap)
says where its copy's edges are, in the `data-pm-slice="<openStart> <openEnd>
…"` its first element carries: an end it marks closed (`0`, as a select-all
copy does) is whole blocks the reader selected, and its empty blocks are kept;
an open end is a drag's, and its empty blocks go as any other's.

A drag begun in a `<details>`' body leaves its `<summary>` out of the copy, and
WebKit writes the start tags of every closed `<details>` a drag crosses at the
front, around everything after them. So a `<details>` on the copy's start edge
-- the first element, its first child and so on down, through the page's own
wrapper (a `<div class="faq">`, a `<section>`), Chromium's and WebKit's content
slot around a nested `<details>` and an editor's content `<div>` -- with no
summary of its own (nor one in WebKit's content slot) is read as its body, in
its place and at its depth: the answers paste as paragraphs, never as an empty
toggle the reader's text is indented into. One with its summary, one anywhere
after the start, one that draws nothing, and one a closed ProseMirror slice
starts with are toggles as before; a whole summary-less `<details>` at the very
start of a paste cannot be told from a drag's, and is read as its body too.

A known limit, Chromium: a drag that starts before a `<details>` and ends
anywhere inside it -- in its summary or in its open body, open or closed, in a
wrapper or not -- can copy the rest of the page after that `<details>` as HTML
-- text the reader never selected, though the plain text is only what was
selected -- and the paste then holds all of it. That HTML is what a copy
running to the end of the page would write, so the reader cannot tell it from
one; ending the drag outside the `<details>` takes only the selection.

No control character but the tab and the line feed enters the document: a
`\r\n` or a lone `\r` is a line break like `\n` -- spelled in Markdown as
`&#13;&#10;` too -- and so is a vertical tab or a form feed (PowerPoint's
`line1\vline2` is two lines, and one that ends a pasted block adds no line);
every other C0 control
-- a NUL, a bell, an escape --, DEL and the C1 controls are dropped. Pasted
plain text, pasted HTML, Markdown, a callout's icon and a stored document
through `normalizeDocument` are all cleaned the same way, so what is pasted is
what is saved and what is loaded again.

When the clipboard carries no HTML, the plain text is parsed as **Markdown** —
`# `, `- `, `1. `, `> `, `- [x] `, `---`, fenced code and `$$` equations, plus the
inline rules.
So do setext headings (a line of `===` or `---` directly under a paragraph's
line), `~~~` fences, and an image inside a line, which cuts a paragraph into
text, picture and text as an inline `<img>` does (a linked badge is its
picture; inside another link's label it is the inner link, so the outer
brackets stay text), and goes inside any other block, after its text -- on
paste only: typing makes no picture, so a typed
`![a](https://a.test/b.png)` is a `!` and a link to that address (with a
destination the link rule refuses, such as a bare `b`, it stays text). Indented code,
reference links and footnotes are read as text. Indentation is nesting: a line
indented under another becomes its child, so a pasted line's leading spaces
become its depth. A numbered list the model would draw with numbers other than
the ones written -- `5. five`, `<ol start="5">`, a lone `1986. A great year` --
is read as paragraphs that keep their numbers as text, because the model
numbers a list from 1.
One line becomes one block, so soft-wrapped prose arrives as several paragraphs.
Inline parsing replays the same rules used while typing, so pasting `**a**` and
typing it give the same result. Three things differ, because a paste sees the
whole line and typing only what is before the caret: a link destination that
never closes on its line (`**see [docs](x**`, or `[a](<b and *y*` with no `>)`)
is not a link, so the formatting after it applies, where typing waits for the
`)` that may be the next key; a backslash escape is honoured when pasted
(`\*a*` is literal `*a*`; in a link destination `\$` is `$`), where a typed
backslash stays a backslash -- including one inside a code span, which a paste
reads as an escape and CommonMark does not; and a rule that fires inside a
formula while it is typed has already taken its delimiters out of the TeX by
the time the closing `$` arrives (`$a*b*c$` typed is `abc`, pasted `a*b*c`).

Where the paste lands depends on its shape:

- A **single paragraph** is inserted at the caret, so pasting a phrase into the
  middle of a sentence still works -- even into an empty block, or over a
  block's whole text, which keeps its type. So is the text of any other single block of prose (a heading, quote,
  list item, to-do, toggle or callout), which takes the type of the block it
  lands in, except in an empty block, which it replaces (below).
- **Several blocks** splice into the document: the first merges into the block
  you are in, and the last absorbs whatever followed the caret. They keep their
  own shape, from the depth of the block you are in. Pasted into a toggle's or a
  callout's own text, they become its children, as Enter makes them, and a
  collapsed one opens (an empty one is never replaced: it takes the first as
  its own text and the rest as its children; at the start of one with text
  they go in front: the bullets below). A collapsed toggle the
  paste brings is opened if anything of yours would end up under it.
- A **table, image, divider, code block or equation** is spliced in whole
  rather than merged -- an equation's TeX is not prose, nor prose TeX -- because
  only its text would survive the merge, and the text that followed the caret
  gets a block of its own rather than being parked in a field a divider or a
  table never draws.
- At the **very start of a block with text** (or with blocks nested under it,
  but for an empty toggle or callout, whose paste nests under it as above),
  several blocks, or one that cannot merge, go in front of it instead, and it
  stays itself -- its type, id, check, icon and children. A last pasted block
  of prose at the paste's own top level joins its text to the start of it; one
  nested in what was pasted (a `<details>` body) stays where it was pasted.
- Into an **empty block** -- or one whose whole text is selected -- with
  nothing nested under it, anything but a single paragraph replaces it rather than leaving a blank
  line above: it becomes the first pasted block, keeping only its id and
  depth.
- With **blocks selected**, the paste replaces them.
- Lines follow `Enter`. Pasted into a toggle's or a callout's own text, they
  become its children. **Plain lines** — text with no Markdown structure of its
  own and no HTML beside it — pasted into a list item or a to-do become further
  items at its depth, and the item you pasted into keeps its type and its check.
- Into a **code block**, the paste is its text, with Windows and classic Mac line
  endings read as newlines.

Either way it is a single undo step.

Copying selected blocks writes Markdown to `text/plain` and HTML to `text/html`,
with genuinely nested `<ul>`/`<ol>` so depth survives a round trip through
another application. In the HTML a line break made with `Shift`+`Enter` is a
`<br>` and every element holding text is marked `white-space: pre-wrap`, so a
soft break, a run of spaces or a tab survives a paste into Gmail, Google Docs or
any other rich-text field -- and back into this editor when the browser drops
its private clipboard flag, as WebKit does between origins.

Copying (or cutting) **text** selected inside one block writes the characters
you selected to `text/plain` — not Markdown — and the runs as HTML, with each
line break a `<br>` and the phrase in a `white-space: pre-wrap` span, so its
spaces, tabs and indentation survive in other applications too. A range copied
out of a code block is written as a code block, a `<pre>`. It is written from the model rather than left to the
browser, whose copy carries the editor's computed styles: a link's underline
and a checked to-do's line-through read back as formatting. A paste into any
neditor reads the runs from an `application/x-neditor` entry beside them instead
of the HTML, so they merge in at the caret exactly as they were; that entry is
treated as untrusted, like a loaded document. A cut is one undo step.

Callouts and toggles have no Markdown of their own, so both degrade to something
readable that still parses back:

| Block                    | Markdown                                         | HTML                                              |
| ------------------------ | ------------------------------------------------ | ------------------------------------------------- |
| Callout                  | `> [!💡] text` — the icon is bracketed           | `<blockquote data-neditor-callout="💡">`          |
| Toggle                   | `- ▸ text` collapsed, `- ▾ text` open            | `<details>` / `<details open>` with a `<summary>` |
| Image                    | `![alt](src)`, then a hard break and the caption | `<figure><img><figcaption>`                       |
| Image with no source yet | `![alt]()`                                       | `<figure data-neditor-image>` (no broken `<img>`) |
| Table                    | a GFM table                                      | `<table>` with `<thead>` / `<tbody>`              |

Elsewhere a callout still reads as a quote and a toggle as a list item; a
`<details>` pasted from anywhere else becomes a toggle, with its body nested one
level under it. The callout's icon is bracketed rather than merely leading so
that the two directions agree: an emoji-led quote you wrote by hand stays a
quote, and an icon that is not an emoji still names a callout.

Tables are faithful in both formats — a GFM table pasted as plain text becomes a
real table, cell formatting included, and a ragged one is squared off rather
than rejected. An image keeps its source, alt text and caption in both. The delimiter row is read as GFM defines it, so `| - | - |`
works as well as `| --- | --- |`, with or without alignment colons.

One GFM allowance is not implemented: a row must keep its outer pipes. Deciding
that `a | b` starts a table means looking ahead to the next line for a delimiter
row, and this reader works a line at a time — so the stricter rule stands rather
than risk turning a sentence containing a pipe into a table.

The Markdown writer is defensive wherever the format is ambiguous, so what it
writes is what `blocksFromMarkdown` reads back:

- A code fence is one backtick longer than the longest run inside the block, so
  a snippet that itself contains ` ``` ` comes back as one code block rather
  than three.
- A nested block is indented to its parent's content column: two spaces under
  a bullet, three under `1. `, four under `10. `. A nested code block's body is
  indented as far as its fence, which the reader strips again. (Nesting under a
  quote, a callout or a paragraph has no CommonMark spelling: other readers
  read those children as top-level blocks, or past two levels as indented
  code; this reader reads them at their depth.)
- A line break inside a heading or a table cell is written `<br>`, which every
  reader renders as one, since neither may span lines. Markdown written by
  earlier versions (`\` + newline in a heading) still reads back.
- A bare `http://` or `https://` URL is written as an autolink, `<https://…>`,
  because GFM links a bare URL up to the next space and took in whatever was
  written against it -- an escape's backslash, a line break's, a trailing
  space's reference. GFM's trailing punctuation stays outside it. A URL
  holding `*`, a backtick, a bracket or `~~` (or a `~` in struck text, or a
  `$` when a formula or a code span holding a `$` follows it in the block) keeps
  the escaped spelling, because an autolink's text is plain once it closes;
  so does a `www.` URL, which has no autolink spelling. GFM readers still link
  those with the backslashes in.
- A link or image destination holding a paren, a space or an angle bracket is
  written in the `<…>` form, where a paren needs no escape. In either form a
  backslash is doubled and a `|`, a backtick, the `]` of a `](` and an `&` that
  begins a reference are backslash-escaped: the pipe would end a table cell,
  two backticks would close a code span, a `](` reads as a link of its own
  inside the URL, and other readers decode the reference. A relative URL holding a space or an angle
  bracket, or a link's holding U+FFFC, comes back percent-encoded (`/a b` as
  `/a%20b`, U+FFFC as `%EF%BF%BC`).
- In an alt text or a callout icon, `[`, `]`, `\`, a backtick and `<` are
  escaped, and unescaped on the way back: a `]` would close the label early and
  leak the rest of the line into the document as markup, and other readers
  pair a backtick or a `<` with one in the caption and lose the image. A line
  break in one (an alt attribute pasted from wrapped HTML) is written as a
  space, because a label is a single line.
- Whitespace and newlines at either edge of a block's text are written as
  numeric character references (`&#32;`, `&#10;`), because leading spaces are
  indentation and every reader trims the rest. Splitting "Alpha one" with
  `Enter` leaves " one", and `Shift`+`Enter` at the end of a block leaves a
  trailing newline; without this a Markdown copy or save lost both.
- Whitespace at the edge of a formatted run keeps its formatting. `**`, `*`
  and `~~` cannot open or close against whitespace, and CommonMark trims a
  code span's edge spaces, so such a run is written as HTML --
  `a<strong>bold </strong>b`, `<em>`, `<s>`, `<code>`, `<u>` -- which this
  reader reads back and any reader that allows inline HTML renders as written
  (one that escapes raw HTML, as markdown-it does by default, shows the tags). Link text holds the
  whitespace as it is.
- A formatted run or a link that contains a line break is written whole
  (`**one\` + newline + `two**`) and read back whole, as CommonMark allows --
  in a heading or a table cell too, with the break as `<br>`.
- CommonMark shows a backtick code span's content literally, backslashes
  included, so a code run that needs any escaping (`snake_case`, `a<b`) or holds
  a line break is written as `<code>…</code>`, where escapes are honoured.
- A line after a soft break (or an image's caption) that opens with `#`, `-`,
  `>`, `+`, `=`, `:-` or `1.` has the marker escaped, so other readers do not
  start a heading, a list or a table there, and a `!` straight before a link is escaped so the
  two are not read as an image.
- References are read back only where the writer puts them, at the edges of a
  block's text and at the start of a line after a soft break. Anywhere else, including code spans and link destinations,
  `&#…;` stays the text it is, and a literal one at an edge is escaped, so it
  comes back as typed.

## Headless use

The model and both serializers are pure and import-safe with no DOM, so a server
can read and write documents without a browser:

```js
import { blocksFromMarkdown, normalizeDocument, toMarkdown } from '@neditor/core/model';

const doc = normalizeDocument({ blocks: blocksFromMarkdown(markdown) });
const back = toMarkdown(doc);
```

`toMarkdown`, `blocksFromMarkdown`, `normalizeDocument` and the whole
`model/rich-text` surface need nothing but JavaScript. `blocksToHtml` and
`blocksFromHtml` take a `Document`, so on the server they need a DOM shim
(`happy-dom`, `jsdom`) passed in as the first argument.

`blocksFromHtml(doc, html, options)` takes an optional `HtmlReadOptions`:

| Option       | Type                   | Default  | Description                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whitespace` | `'auto' \| 'preserve'` | `'auto'` | `'auto'` reads whitespace as a browser draws it. `'preserve'` reads every block's text as it stands: pass it for HTML stored from `blocksToHtml` in 0.1.3 or earlier, which wrote a soft line break as a raw newline and spaces as they stood. Only such HTML with a nested or checked block is recognised on its own; a document of plain paragraphs is not. |
| `plain`      | `string`               | none     | The `text/plain` the HTML came with. For a block with no inline `white-space` on it or around it, each run of whitespace the plain text holds exactly as written, where the block stands in it, is kept (see [Copying and pasting](#copying-and-pasting)).                                                                                                    |

```js
import { blocksFromHtml } from '@neditor/core';

// HTML a 0.1.3 or earlier `blocksToHtml` wrote, read back as it was written.
const blocks = blocksFromHtml(document, stored, { whitespace: 'preserve' });
```

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

An override like this holds in every theme: the dark token blocks have the same
specificity as `.neditor` itself, and your stylesheet comes after the injected
one. So a colour tuned for a light page applies in dark mode too. To give dark
mode values of its own, match the editor's own conditions after the rule above:

```css
@media (prefers-color-scheme: dark) {
  .neditor:not([data-neditor-theme='light']) {
    --neditor-accent: #ff8a5c;
  }
}

.neditor[data-neditor-theme='dark'] {
  --neditor-accent: #ff8a5c;
}
```

The tokens, all on `.neditor` and `.neditor-portal`:

| Token                                                 | What it colours or sizes                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `--neditor-font`, `--neditor-font-mono`               | Text, and code and TeX.                                                   |
| `--neditor-text`, `--neditor-text-muted`              | Ink, and captions, completed to-dos and quiet controls.                   |
| `--neditor-placeholder`                               | Placeholders in empty blocks.                                             |
| `--neditor-surface`, `--neditor-surface-raised`       | The editor's ground (transparent in light, opaque in dark), and portals'. |
| `--neditor-border`, `--neditor-hover`                 | Dividers and edges, and the tint under a hovered control.                 |
| `--neditor-accent`, `--neditor-on-accent`             | Active glyphs, focus rings, primary buttons, a checked box, and its tick. |
| `--neditor-selection`                                 | The tint of a selected block.                                             |
| `--neditor-code-bg`, `--neditor-code-text`            | Code and equation grounds, and inline code.                               |
| `--neditor-danger`                                    | Error text: an invalid URL or TeX.                                        |
| `--neditor-callout-bg`                                | A callout's ground.                                                       |
| `--neditor-table-border`, `--neditor-table-header-bg` | Table rules, and the header row's ground.                                 |
| `--neditor-shadow`                                    | The portals' shadow.                                                      |
| `--neditor-indent`, `--neditor-gutter-width`          | One level of nesting, and the room reserved for the gutter.               |

A colour you change in either half of a pair (`--neditor-accent` and
`--neditor-on-accent`, the text and the surfaces) has to keep its contrast with
the other: the defaults are measured against each other, in both themes.

The floating toolbar, slash menu and link editor render outside the editor
element so they are never clipped. They carry the `.neditor-portal` class and
read the same tokens, so set custom properties on both selectors if you override
them globally. When the page scrolls, the slash menu and the format toolbar
follow the caret, and close once the caret or range itself has left the screen
(not its block, which can be taller than the window); the table
toolbar sits against the table, or against the caret's row when the table is
taller than the screen (against the caret's line when the row is too), and
goes with the caret's cell when that leaves the
screen -- the screen being what every scrolling container that clips the
editor leaves visible, the shadow pane of a web component the editor is
slotted into included (a pane behind a `position: fixed` sheet, a modal
dialog or popover does not, unless an ancestor between them makes the sheet
its containing block -- a `transform`, `filter`, `perspective`, `will-change`,
`contain` and the like -- so that the sheet scrolls with it; nor does a
scrolling pane around a `position: absolute` panel that is not its containing
block, nor a scrolling `<body>` under a panel placed against the page), and for
an editor in a same-origin iframe, what the windows of the pages around the
frame, and any scrolling pane there the frame sits in, leave visible too, at
the scale the frame is drawn at (a `transform: scale()` or `zoom` on it or
around it) -- every floating panel goes on the side of what it belongs to that
more of that part shows, not by the frame's whole window --
coming back with it (one `F10` gave focus keeps following
the cell instead, and `F10` on a cell not wholly on screen first brings it to
the middle of its own scroller, moving nothing around it; in a cell taller than
that scroller, the caret -- or any part of a range -- is what has to be on
screen, and the caret or the range's focus end is what is brought to the
middle, an empty line included -- a caret at a line's wrap is judged by the line
it is drawn on -- and `Escape` back to it moves nothing that is
already on screen; a cell in a fixed panel that does not scroll itself is not
scrolled at all). Enter in a cell taller than the screen -- and Shift+Enter, or
Enter in a code block, in a block that is -- scrolls the least that shows the
new line, never the whole block. With a range in a cell the format toolbar is drawn and the table toolbar
is not; `F10` reaches it. An editor reads the tree it is drawn in -- the
components it is slotted into -- when it is mounted; one moved into a
component later is not heard scrolling there until it is mounted again.

They are appended to the mount point's own root node, which is `document.body`
for an ordinary mount and the shadow root for an editor inside a custom element
— a shadow tree does not inherit the document's stylesheets, so a portal in the
body would render with none of this. Pass `portalContainer` to put them
somewhere else. An editor inside the top layer needs it: a modal `<dialog>`, an
open `popover` or a fullscreen element paints above any z-index, so portals
left in the body are drawn under it -- pass that dialog, popover or
fullscreen element itself (the default is not
changed for you); the stylesheet is injected into that
tree as well as the editor's. For an editor in a same-origin iframe that can be
the page around the frame: the portals are placed against the text through the
frame's offset and scale (a `transform: scale()` or CSS `zoom` on the frame or
around it), and a press or focus on them is still the editor's own. Drawn in
that page, they are not cut by the frame or by a scrolling pane of that page
the frame sits in: they choose their side by that page's window (and by the
pages around it, if it is a frame itself). A known
limit: WebKit lays a frame under a CSS `zoom` out at the zoomed width, clips it,
and reports the rects inside it in units of neither window, so there a portal
in the outer page is not placed against the text (a `transform` is). They
are placed as they open and as the frame's own document or a page around the
frame scrolls.

The layout uses logical properties throughout, so `dir="rtl"` on the editor
mirrors indentation, list markers, the quote bar and the drag handle correctly.
The floating UI takes the editor's direction too, and the table toolbar's
"insert column left/right" mean the reader's left and right. Code blocks stay
left to right, since code is.
The drag handle's mirroring keys off the editor's own direction, so an LTR
editor inside an RTL page is left alone rather than mirrored twice.

The direction is the container's, though — the renderer writes no `dir` on
individual blocks, so a document mixing Hebrew and English paragraphs renders
every one of them in the editor's direction. A paragraph whose text runs the
other way will have its punctuation placed at the wrong end. Set `dir` on the
editor to match the document you are showing; per-block direction is not
implemented.

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
