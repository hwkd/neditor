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

A monorepo for a block-based rich-text editor, packaged as a reusable, framework-free library.

- `packages/neditor` — `@neditor/core`. Vanilla TypeScript, compiled to vanilla JS. **Never add a framework dependency here**, and keep `dependencies` empty: the package must stay drop-in for any web app.
- `apps/web` — Astro 7 site that consumes the package and serves as the dev harness.

## Conventions

- **The supported page setups are the README's (Browser support → Page setups).** A defect outside them that cannot lose or change the reader's content is a known limit: record it, don't build for it. Every rule below holds inside that bound.
- The document model in `src/model/document.ts` is a **flat, ordered block list**. Nesting is the numeric `depth` field, not a tree. Structural edits are pure functions returning new arrays — keep them that way, it is what will make undo/redo cheap.
- The renderer **reconciles**; it does not re-render. Writing `textContent` on every keystroke destroys the caret, so `#updateView` only touches the DOM when it has genuinely drifted from the model. Text-only edits update the model and deliberately skip a render. Moving a node takes it out and puts it back, which blurs the element focus is in, ends a composition in it and collapses every range inside it, so a reorder **never moves the block the reader is in** (`#readersBlock`: the one holding focus in the mount's own root node -- a shadow root's `activeElement`, not the document's -- climbed from a cell or a control to its block, else the one the selection is in, for a page's own toolbar button holding focus): `#positionAround` places the blocks before it from the root's start and each one after it right after the one before. Positioned from the top, a peer's reorder that moved the reader's block up, or a block from above it to below, left focus on `<body>` and the next keys typed nothing (R13-KEY-2). Where the top-down loop would not have moved that block anyway, both make the same moves.
- Text is a list of **runs** (`model/rich-text.ts`), not a string: formatting is interval arithmetic over character offsets, never DOM surgery. Every operation there is pure, offset-based, and ends in `normalizeRuns`, so structurally equal content is deeply equal. Nothing in that module may touch the DOM — that translation lives in `view/rich-dom.ts`.
- Typing is **DOM-first**: the browser edits the contenteditable and `#handleInput` reads it back with `parseRichText`. That is what keeps IME, autocorrect and spellcheck working, and it is why the renderer must be told (`syncFromDom`) that the DOM is already ahead of the last render. Formatting commands go the other way — model first, then re-render and restore the selection by offset. So does one kind of typing: a character typed over a non-collapsed range in one host (`#typeOver`), because each engine has its own rule for whose formatting the replacement inherits — over exactly a link's text Chromium kept the link for one letter and Firefox for none. The replacement takes the first replaced character's marks and link, and after a link, the next character typed from that same caret into that same text joins it (every engine types _outside_ an anchor at its end; Google Docs keeps the link the same way). Only that: `#typingOver` ends on everything else -- a selection moved off the offset, a click or a caret key even back onto it, Escape, a blur, a mark toggle (Mod+B lit bold and typed into the link plain), any other edit, undo/redo, `setDocument`, read-only, `destroy`. It never takes over a composition and never a collapsed caret otherwise; a composition gets the same formatting when it ends instead (`#formatComposed`, inside the composition's one undo step), and it runs the input rules itself, since no `input` event follows a cancelled `beforeinput`.
- **History is snapshot-based** (`model/history.ts`), which only works because every edit returns a new block array while reusing untouched blocks. Anything that mutates `#blocks` in place would silently corrupt the undo stack — don't. Entries are recorded _before_ an edit, and `#commit` does it for you; `#applyBlocks` is the deliberate escape hatch that skips history and exists for undo/redo itself. An entry also learns where its edit _left_ the reader (`after`, filled by `History.settle` from a microtask `#recordHistory` queues, or by the next record in the same task), and redo restores that, not the caret at the moment undo was pressed — after several undos that was the caret the following edit started from. A commit made with no caret in the text (a pointer path: the gutter `+`, a chevron; or with focus in a popover, as the link dialog's Apply is) passes a selection snapshot of the block, or the range, it acts on, and an entry with nothing to restore lands the caret where the document changed (`#focusNearChange`), never on block 0.
- **`#commit` is the only recorder, and a no-op is not an edit.** Pass it a run key and a pre-edit selection rather than calling `#recordHistory` yourself and committing afterwards: that pushes the same document twice, and the extra Ctrl+Z restores what the user is already looking at. It also refuses to record when nothing moved, which it can only tell because the pure ops reuse untouched blocks — `sameBlocks` compares the blocks, never the array, since every op hands back a fresh one even for a no-op. Without that test, Cmd+Shift+Arrow at the edge of the document banked an undo step and fired `change` per repeat, so a held key emptied the real history and an autosave listener wrote the same revision over and over. The one path that records on its own is `#syncFromDom`, because typing must not re-render, and it carries its own `richEquals` version of the same test.
- **Two selection modes, never both**: a text range inside one block, or a set of whole blocks (`#selected`). Entering block selection drops the DOM selection and focuses the root, which is why the root carries `tabindex="-1"` and why block keystrokes are routed before the text handlers. Anything that changes the document must leave the invariant intact — `#pruneBlockSelection` drops ids the new document no longer has, and a host's `setDocument` keeps the ids it still shows the same way (`#keepBlockSelection`; cleared outright, it left the root focused in neither mode). **The editor never guesses where the reader was: identity decides.** A lost anchor passes to the survivor nearest it in the order the selection was made in, never to the first id kept -- that was the far end, and Shift+Arrow ran the other way. When none of the selected ids is still shown and the root held focus, the selection ends and the root lets go of focus (`#letGo`, the rule a panel that held focus already followed: typing that lands nowhere loses nothing), announcing nothing when focus was elsewhere: the reader is elsewhere. That holds whether every id is new (a Markdown reload, a document made with ids of its own) or a peer deleted just the selected blocks: the blocks beside them are still there by id, and handing the caret to the next one (rounds 8-11) let the key pressed for the selection edit a block the reader never chose ("AlphaGamma", "xGamma"). The same rule inside a block (`#carryTextSelection`): a peer's update that rewrites the very host the reader is typing in carries the caret by the text around it (`carryOffset` -- its offset while the text before it is unchanged, else its distance from the end while the text after it is; a range by what every reading of the edit agrees on, `carryRange` -- a pure deletion or insertion in repeated text has an interval of valid readings (from the longest common suffix's start to the longest common prefix's end), less those that cut a code point (`wholeReadings` -- matched code unit by code unit, "ok 👍😀!" less its 👍 was also read as losing the 👍's second half and the 😀's first, which share a code unit, and the range lost its 😀, and "🈀😀" less its 😀 emptied a selected 🈀; in well-formed text no editor's edit cuts a pair, so the true reading is kept, but where either text holds a lone surrogate every reading counts, since an edit can complete one into a pair and the true reading then cuts the new pair ("\ud83d" made "😀\ud83d"); none passing proves nothing ("🈀𐀀x" made "🀀x" is a replacement that only looks pure) and keeps them all; only the two extreme readings matter, since the ends' images move one way as the reading does). Characters are deliberately not asked: a peer's own Backspace takes one code point of a conjunct, a syllable's jamo or a letter's mark, and filtering by grapheme excluded the true reading and took unselected text into the range (231 of 334,000 fuzzed edits); so a selected character can be left partly behind -- NFD "é" with the "á" after it deleted is "Q\u0301b" once typed over --, the decided price, and the range's start goes as far right and its end as far left as any reading puts them, so it never covers text the reader did not select nor a peer's text at its edge, whichever reading was true; any single reading was wrong about half the time (carried one end at a time, "ha ha ha!" less a "ha " grew the range to "ha ha"; read from the common prefix, a "w" typed before a selected "world" went inside it; slid before the range, a removed duplicate "the " took the reader's "the"). The cost, accepted: an ambiguous edit leaves selected text out -- all of it, as a caret where the selection began for a deletion, or before every place an insertion could have gone, as "a👍👍👍b" less a 👍 leaves "a👍👍|b" -- a tie between two readings of an insertion is nothing too where a kept reading puts the meeting point strictly inside the inserted text ("ha" selected and made "haha" put both images at 2, inside the peer's "ah" in the reading "h|ah|a"), asked over the inserted text's length; elsewhere it stays where the readings meet (one "0" of "1000000" selected and a "0" typed: moved to the front for nothing, "1Q0000000"). That caret is never settled forward past that place, where the peer's text joins the character before it, and never left inside a character: it goes to the start of the character that place falls in (`graphemeStart`, before every reading; put back by code point, Firefox typed into the reader's "á" and WebKit at its end, in the peer's text) -- whether the settle moved it forward or left it at a place inside a character the reader's own keys made (`settled >= first`; with `>` that case was unpinned and Q split the reader's "क्"). This places a caret; it filters no reading. Settled inside a character, a range's ends only move inward, except over a mark the peer put on its last character in every reading; a replacement is read once (prefix and suffix), an end in replaced text letting go; a range's start goes after text inserted exactly at it, its end before; inside text deleted with nothing put in its place, where it was -- the common prefix's length; an answer inside a character a reader sees as one (counted in UTF-16 code units, a deletion's common prefix cut "😂" in half and Firefox typed a lone surrogate into the model) never moves over the reader's own text -- a whole character of the reader's the counting cut goes back to its edge on the side it stood on, a peer's own new text extending the reader's character (a matra: "नQमाY" was the next letter split off) is crossed alone, to the character's end, and a character that joins the reader's text on both sides of the answer (a deletion between "🇺" and "🇸", a virama or ZWJ inserted) leaves the answer where it is (snapped, a range start grew back over "🇺" and the "Q" typed over the range deleted it); an offset already inside a character before the edit, where the reader's own keys left it (Firefox after a virama typed before a consonant, "क्|मल"), is carried unsnapped -- except where an insertion leaves nothing of a range that starts there: the caret it becomes is snapped to the character's start, like every caret before all of an insertion ("क्" typed before "म", "म" selected, "क्म" made "क्म्म": "Qक्म्म", not "कQ्म्म"); every answer is kept off the middle of a surrogate pair (`codePointStart`), and an unlock over unchanged text puts the offsets back as they were; both ask `Intl.Segmenter`'s `containing()` for the one cluster, since walking the segments cost 41 ms a call on a 100,000-character block -- and walk only the span it answers, because WebKit's answer at a cluster that starts with a surrogate pair reaches back over the cluster before it ("X😀".containing(1) is "X😀"), and the caret went back over the "X"), and where text was put in across an end the host lets go (`#letGo(host)`); left alone, the redraw dropped the caret to offset 0 and the next letters were typed at the block's start. "Typing in" is focus (`#typingIn`: the host holds focus in its tree -- an iframe mount's own document lets go of the block whenever focus goes anywhere around the frame, measured in every engine), never `document.hasFocus()`, which is false for a background tab and dropped the caret of a reader who had only looked away. A host the render _replaced_ -- same id, still a text block (a paragraph a peer made a heading) -- takes the caret in its new element the same way; a table a peer reshapes is not followed into (its cells have no ids, and nothing is matched by coordinates or content). A composition live in the host is never let go of and its range never dropped: its text is in the model and in no peer's document (it is uncommitted, no `change`), so it is carried from the offset it began at against the text it began from, to the start of the changed text where nothing else says (`carryOffset`'s `always`), and the browser commits it there. `setEditable(true)` gives back the caret `setEditable(false)` took off a block (`#lockedCaret`), by id and carried, only while the guard it armed is unspent (placing themselves forgets it) and focus is on the page in every document -- around an iframe mount, on the page or on the editor's own frame (`#focusOnPageAround`: the frame's own document answers `<body>` with focus in another frame; where the frames end at a page of another origin, `#crossOriginAbove`, the window's own focus too -- so there alone a background tab's unlock gives nothing back) -- and without revealing it: the reader may have scrolled away during the lock; it draws again only the toolbar showing at the lock, the format toolbar only while its range is on screen (`#redrawToolbars`); an image's caption is given back to a block that is still an image (R13-KEY-4), never to one that became or stopped being one. A range kept in a host the reader is _not_ typing in (a page button WebKit did not focus) is dropped when its host is redrawn: WebKit's reading of it disagreed with its live range afterwards and typed into the middle of the block, and in a shadow mount the composed range was clamped onto the new children. A host the update did not touch keeps its range, which a host's own toolbar button acts on. Every guess tried there selected, typed into or deleted a block the reader never chose, two rounds running: by position, the old index named the block after the blank paragraphs Markdown dropped (seventy above: sixty-nine blocks down); by content, a switch to another note from the same template selected its own "Notes" heading for Backspace to delete; selecting a surviving divider handed Backspace a block nobody chose. The edits made in block mode land the same way when a `change` listener renames the document under them: a delete's or cut's caret is looked up by id in the committed array (`splitAt` -- a miss is in neither list, never position 0, which sent the caret forty blocks down), a duplicate selects its copies by id or none, Tab and Mod+Shift+↑/↓ keep the selection by id or let go (in `setDocument`), and announcements count what the commit did, never what survived the echo. Nothing is searched by content, not even the paragraph a key typed over a block selection just made (`#replaceSelectionWithText`): renamed under the edit, it is in the document and the root lets go like every other path -- the last content search, bounded to a window of blocks at the same position in both documents, mapped the new "q" onto an old twin 49 blocks down once Markdown dropped more blank lines above than the window held. Ids also mean a host must not give a different document the ids of the one it replaces (two notes cloned from one template): to the editor they are the same blocks, and the README says so. Never fall back to index 0. WebKit goes back in history on a Backspace with focus on `<body>`, so `#letGo` arms `#backAfterLetGo`, and so does a `setDocument` whose render drops focus that was in the editor onto the page -- a host reloading after a debounce takes the focused block away with no `#letGo`, and a panel that held focus is closed (its control blurred first: WebKit kept focus on the hidden F10 toolbar's zero-size button, where Backspace went back) -- or drops a range WebKit was typing into from `<body>` (a page button WebKit gave no focus) or takes that range's host away (deleted, renamed, a table rebuilt: R13-KEY-1), and so does `setEditable(false)`, which blurs a focused panel control, a block that can no longer be typed in and a control it disables (the image trigger, the callout icon: WebKit moves focus off a disabled button only lazily, and the guard found it still there, R13-KEY-3), ends a block selection by `#letGo`, and, when it takes editing away, guards a range WebKit kept in a block with focus on the page (one selected in a read-only view, to copy, was never typed into) -- an unlock that finds a selection still in one of the editor's hosts hands Backspace back to it (`#resumeKeptSelection`), since WebKit types into it again -- not only at the offsets the lock found: Safari's Shift+arrow moves a read-only selection from `<body>`, and an unlock after it cancelled every Backspace while "Q" replaced the range (R14-KEY-1); a selection gone or outside the editor keeps the guard -- asked without the window's focus, since an unlock landing in a background tab otherwise left Backspace cancelled over a range letters still reached. "On the page" is asked of the document the focus was in (`#focusOnPage(doc)`): a `portalContainer` in the page around an iframe mount puts the panels there, and closed, they leave focus on _that_ page's `<body>`. `#guardBackspace` (capture phase, on the editor's document and every `#outerDocuments` document) then cancels every Backspace aimed at the page -- `<body>`, the document element or a `<dialog>` element -- with any modifier, until the reader places themselves: a pointerdown, a focusin onto anything but the page, a `<dialog>` or the mount's own frame (`#spendBackGuard`, on the same documents), or `destroy` spends it, and nothing else does -- not the Backspace's keyup, not another key, not the Tab key itself (WebKit's Tab with nothing focused in a modal dialog focuses the `<dialog>`, where Backspace goes back too; it is the focus a Tab moves that spends it). Spent by those, a held key's first repeat, a second press, "x" then Backspace, or a word typed over a block selection under an echo went back. Escape twice does not arm it: there the reader left on purpose. "The end of" a table is its last cell (`#focusAt`, which `#focusFirst` goes through): `focus(table, end)` is the end of the first. The other direction is enforced too: placing a caret ends block selection, so `focus`/`focusRange` clear `#selected` as their host takes focus -- `#placingFocus` makes `#handleFocusIn` end it before the `focus` event even inside a pointer's grace period, since a host's own button calling `focus()` from its click is in that period -- and `#handleFocusIn` ends it when focus reaches a block by any other route (Tab back in, a host's `.focus()`) — except while a pointer is down or within `POINTER_FOCUS_GRACE_MS` of its release, where a gesture (a drag, a long press) is still setting it and `#takeStrayCaretOut` takes any caret the browser put back out again — and they return `false` when they cannot, because a silent failure leaves the editor in _neither_ mode, where every key falls on the floor. "Cannot" is measured, not assumed: the host must hold focus afterwards (`focusHost`, which asks twice: Firefox's first `focus()` into a frame that does not hold focus -- Escape from a table toolbar portalled into the page around an iframe mount -- focuses only the frame, and the old code was rescued by the caret it set next), since a read-only host is not focusable and everything outside a modal `<dialog>` is inert, and both answered `true` with focus on `<body>`. A focus that did not land changes nothing else -- block selection, caret, scroll -- so a caller can try the next block. happy-dom focuses anything, so that half is pinned in `read-only.spec.ts` and `api.spec.ts`. An empty set is never a mode: `#setBlockSelection([])` leaves block selection and hands the caret back. Nor is a press outside every host: `#handleRootMouseDown` puts the caret in the text nearest the press (the start of a list item for its marker, the nearest cell for a table's border), selects a divider, leaves the mode exactly as it was for the to-do checkbox, and appends a paragraph only for a press below the last block — treating every press on the root as one appended a block at the end of the document from a click in the margin above a heading. The gutter's own background is such a press too; only its controls are exempt. Placing that caret cancels the mousedown, and with it the browser's drag selection, so `#armPlacedTextDrag` hands the press a text drag anchored at the caret it placed (`placed: true`, drawn by `#returnTextDrag` from the first move past `DRAG_THRESHOLD_PX` -- until then it is a click (`TextDrag.still`), so a press with a pixel of jitter near the window's edge neither scrolls nor selects) — without one, a drag from a list marker selected nothing and one that detoured through another block came back as a block selection. Only a plain primary press places anything: a right or middle press keeps the caret and the range (WebKit selects the nearest word before `contextmenu` anyway, which `#handleContextMenu` puts back; Chromium picks its own range in the menu's default action, after every listener, so the held range is restored once more, at the button's release before it is read, or in a task -- the gutter's buttons hold it the same way -- but only while the event was not cancelled and the range's host still holds focus: a page with a menu of its own cancels it and moves focus into that menu, and the second restore pulled focus back and let the reader's typing replace their range), `Shift` extends a range within its own host and otherwise leaves it, and a press on a scrollbar (`onScrollbar`) is the scroller's alone -- the vertical bar's side read from `direction` alone, since WebKit's `clientLeft` under `zoom` is not the border width. A drag carried past either end of the document in one quick step is at that end (`#blockIdAtY` answers the first block above it as it answers the last below it).
- **Every block is its own `contenteditable`.** That is what keeps the reconciling renderer and caret restoration simple, but it means a browser will never extend a selection across two blocks: `Selection` stays inside one editing host. Any cross-block gesture must be synthesized — pointer drags via `#updateTextDrag`, `Shift`+arrow via `#extendFromTextToBlocks`. Never write a feature that waits for a cross-block DOM range from user input, and never verify one by building that range with the Selection API — it proves nothing a mouse can reproduce.
- **Never put an ARIA role on a block's content element.** The tag is chosen for its semantics (`h1`, `blockquote`, `code`); `role="textbox"` would win over it and erase heading and quote navigation for every screen reader. `contenteditable` already exposes an editable field on top of the element's own role. Same for `aria-multiline` — Shift+Enter really does insert a newline.
- **Tab must never be swallowed unconditionally.** It may only `preventDefault()` when it actually changes something — an indent, a step to the next table cell, a row added under a last row that has text in it; a Tab that would change nothing moves focus onward, and that includes the last cell of a table whose last row is empty. Otherwise the editor is a keyboard trap (WCAG 2.1.2). The guaranteed exits are Shift+Tab at depth 0 and Escape twice — keep both working. Both need every gesture to end at its release: an Escape that finds a press still down ends only that gesture ("A pointer gesture can end without `pointerup`"), so a release a page stopped above the editor left the click that placed the caret down for good, and Escape twice then Tab never left (R14-RV4B-1) -- which is why the release is heard in the capture phase. Escape twice only _blurs_, and blurring does not move the browser's sequential-focus starting point (nor does moving the selection after the root), so the Tab after it went straight back in: the second Escape arms `#exitArmed`, and `#handleExitKeyDown` takes the next Tab / Shift+Tab to the next / previous tabbable element outside the editor and its portals, continuing past a shadow root's host when the root holds nothing else. Only that Tab spends it: keys that move no focus (scrolling with ↓, Space, Page Down) leave it armed, and a pointerdown or a focusin disarms it. The search reads each tree through the open shadow roots inside it (`composedTabOrder` -- `querySelectorAll` stops at a shadow boundary, and a web component's own button beside the editor was passed over; a host that delegates focus is a stop itself, and a host with `tabindex=-1` takes its shadow tree out of the order with it, as the browser's own Tab does), climbs past a shadow host and, same-origin, past a frame element, and the key is taken only once `focus()` has really landed — inside a modal `<dialog>` everything outside is inert and `focus()` on it fails silently, which left a swallowed Tab with focus on `<body>`. With nowhere to land, the browser keeps the key, but from a starting point outside the editor: `#placeExitStop` focuses a transient `tabindex=-1` stand-in beside the outermost element the search reached (not beside the root, or Chromium and WebKit wrap to the start of the shadow root or frame). It goes on its blur, on focus arriving anywhere else, on the next key pressed while it holds focus, and on `destroy` -- never on blur alone: with nothing before the editor Firefox headless keeps focus on it through Shift+Tab, and it stayed in the page. Tab order is read from markup (`inTabOrder`), not `tabIndex`: Chromium reports -1 for a contenteditable host Tab stops on.
- **The browser's arrows stop at the edge of every block, so the editor carries them across.** `↑`/`↓` leave a host from its first / last _visual_ line (`isOnEdgeLine` measures line boxes, so wraps count as well as `\n`), into the row above / below in a table, else the nearest visible caret-holding block, keeping the caret's x (`caretX`, then `#caretFromPoint` on the target's edge line). At a soft wrap the end of one line and the start of the next are one offset and only the browser knows which the caret is drawn at, so the line is never guessed from the offset: `softWrapLine` asks the browser (its `Selection.modify` to the line's start honours the affinity the DOM selection does not carry) -- from the arrow keys, and F10 and the Escape back from its toolbar, only, since the move resets the browser's own column for ↑/↓; the floating UI measures both lines instead (`selectionBoxes`) --, and `#leavesHost` passes the answer to `isOnEdgeLine` -- the upper side of the first wrap is the first line, the lower side of the last wrap the last. Where the browser cannot say, `isOnEdgeLine` measures one character past the caret, the wrap point is no edge line, and the browser moves (to the block's end from its last line, which costs a press). The column is read the same way, and a caret the editor places at a wrap is drawn on the line it meant (`placeCaretOnLine`) -- set through the Selection API it is drawn at the start of the lower line, and the next ↓ skipped one. The column is the run's (`#goal`), kept while the caret is where the last press left it, so a short block on the way does not pull it over; anything else that puts the caret or changes the document ends it -- any pointerdown in the root, `focus`/`focusRange` (the editor's own crossings note the run again after theirs), `#applyBlocks`, `setDocument`, `setEditable`, `destroy` -- ends it (without that, a host's `focus()` back where a run ended went on with that run's column). It is noted after the browser's move whenever the press was left to the browser (inside a block, off the end of the document), but it is aimed for only where the editor moves the caret, from one host into the next: inside a host the browser's own vertical move is authoritative, by the browser's own column, which is where the caret entered the host, so in any multi-line host entered on a short line it can sit away from the run's (documented, R5-KEY-1). Putting the caret back under the run's column after it (round 3) undid the browser's move to a block's end, and a run of ↓ through a wrapped paragraph or cell stuck at the start of its last line for good. Modified ↑/↓ (⌘, ⌥, Ctrl) are the platform's and never cross. `←`/`→` are not cancelled: the browser moves first, and a press that left the caret exactly where it was (`#checkArrowMove`, after the default action -- a task, the keyup or the next keydown, `#afterDefault`) crosses -- forward from the logical end, backward from the start, wherever bidi drew them, by the key in the host's direction for an empty host. Never from mid-text: Firefox's ← from the start of a wrapped line moves the caret to the end of the line above without changing its offset, and treating a mid-text non-move as "held against the drawn end of a mixed-direction line" took the caret out of the block at every soft wrap. Mixed-direction text whose ends Firefox's visual arrows never reach is the documented price (↑/↓ still leave). Asking the host's direction for the logical edge sent the key pointing into English-in-RTL text to the previous block. A held key's repeats can all arrive before the deferred check's timer (Chromium puts input first), so the keydown that flushes a crossing is judged from the host the caret is now in, not the one the event was aimed at -- judged there it checked nothing, and every crossing cost a second press. Where nothing is laid out (happy-dom) the line test answers `null` and the caret has to be at the edge itself, and there is no browser move, so unit tests state what the browser did; the visual behaviour is pinned in `typing.spec.ts`. With `Shift` the _focus_ end decides whether a range extends into block selection, never collapsedness; with Mod+Shift the block moves, in a table cell too — `#handleTableKeys` does not take the arrows.
- **`toMarkdown` output is parsed again by `blocksFromMarkdown`.** Anything emitted unescaped is silently reinterpreted — `2 * 3 * 4` came back italic with characters missing. Run text goes through `escapeMarkdownText`, and `parseInlineMarkdown` matches rules against a projection where escaped characters -- and numeric references at a block's edges, which is where the writer puts edge whitespace -- are replaced by a placeholder, so offsets stay aligned with the content. A matched span's own text stays visible to the rules around it, exactly as it does while typing: making it opaque was tried, and pasted text stopped matching typed text. The one exception is code, and it is made on both sides at once: the reader projects a code span away the moment it closes, and typing projects an existing code run the same way (`matchTypedInlineRule`), so a backtick inside code never pairs with one typed after it. Nothing else closes while a backtick run is open behind it, or open where its closing delimiter starts (``*y `a*b` z*`` is emphasis around code), typed or pasted; an autolink, a `<code>` tag and a formula share the code span's precedence instead, so the one that opened first wins (``$5 use the `$` sign`` is a formula, typed or pasted; a code span typed whole inside a formula's TeX is made first and its backticks are lost). Change one side and you must change the other.
- **A closed shadow root can only be reached from inside it.** `host.shadowRoot` is null for one, so anything that walks into shadow trees from what a hit test or `activeElement` answered stops at the first closed root. Start from a node known to be inside (`getRootNode()`, asked with `isShadowRoot` from `util/dom.ts`) and climb out through each root's `host` instead. The e2e harness mounts `?mount=closed` and `?mount=nested` (an open root inside a closed one) for this; no locator sees into them, so a test reaches the DOM through `editor.element`.
- **Never brand-check DOM values with `instanceof`.** The editor is mounted into foreign documents on purpose (iframes, shadow roots); `instanceof Node` compares against the script's own realm and silently rejects perfectly valid nodes. Use the duck-typed helpers in `util/dom.ts`.
- **The clipboard is symmetric and must stay that way**: `blocksToHtml` and `blocksFromHtml` are round-trip partners, as are `toMarkdown` and `blocksFromMarkdown`. Nesting is carried by real `<ul>`/`<ol>` nesting and, for non-list blocks, a `data-neditor-depth` attribute — never by `margin-left` alone, which looks right but does not parse back. Any change to one side needs the round-trip tests in `rich-dom.test.ts` extended, and they must assert depth, not just text. A line break in a block's text goes out as `<br>` and every text-holding element is marked `white-space: pre-wrap`, because every other application collapses a raw newline or a run of spaces; the reader keeps whitespace only where a style (or a `<pre>` or `<textarea>` -- not `<code>`, `<kbd>` or `<samp>`, whose default is `normal`) preserves it, decided per text node by its own parent, and collapses it as a browser draws it everywhere else. For a block whose HTML declares no `white-space` on it or around it (`declaresWhiteSpace`; Chromium and WebKit always write one), the `plain` option (the clipboard's `text/plain`, written as drawn) decides instead, because Firefox copies a page's classes rather than its computed style: every block -- a paragraph, a loose `<div>`'s text, a cell, a code block -- is matched at a cursor into the plain text by its non-whitespace characters and moves it on, and each whitespace gap is kept as written where the plain text holds exactly that gap. Never search the plain text for a block: a search costs the block's length per position tried, which periodic text made quadratic, and it finds an identical block elsewhere. A block the cursor misses is looked for at a bounded number of line starts past it and then taken to stand on as many lines as it holds, so the look-ahead for the next block starts past them: a window that never moved found nothing after 64 misses in a row (Firefox writes a `<q>` with its quote marks), and one found back at the cursor gives those lines back. Firefox indents each line of a list item, a `<dd>` or a quote by four spaces per enclosing `<ul>`, `<ol>`, `<dd>` and `<blockquote>` (`plainIndent`) -- the element the text stands in, not the block, for the lead (`blockWhitespace`'s `holder`: a quote in a quote, a list in a cell), a `type="cite"` quote counted like any other, though Firefox starts its lines with `>` and nothing is matched past that (a known limit: read collapsed) -- and exactly that indentation after a line start is Firefox's, never the block's own lead. A gap whose plain text shows it is decided by `holdsIndented` alone, since the spaces after a `<br>` in a `normal` item can be exactly as many; an empty line carries none, and two paragraphs in one block stand a blank line apart there -- and where there is no indentation at all, a table cell or the bare `<li>`s of a drag begun inside a list. Such a block is matched line by line past the indentation of the element each line starts in (`blockWhitespace`'s `solids`, the element each solid character stands in, used only when its count is the text read's): a list, quote or definition in a cell is indented by Firefox though the cell is not, and taking that indentation after the blank line for the cell's own drawn spaces pasted four undrawn ones. Each gap is split at its first line feed: what ends the line above is the collapsed reading's where a block ends there (Firefox writes a `<dd>`'s trailing space drawn or not), unless the whole gap matched by the rule before the split (`asBefore`), so nothing read right then is lost, and within one block (`lineBlock`) it stands where the plain text holds exactly it, and the line below is matched from the line feed on -- judged whole, the one rode along with the other. A table row whose first cell is empty or missed is placed at the start of the first line after the last match (`placeRow`), and a row's tabs are found by binary search over positions taken once per payload: a walk from a point that rows share crossed a long line once per row. A claim moves only where the look-ahead starts, never what it can reach -- a block not found past the claimed lines is also looked for on the same bounded number of lines from the cursor's -- and a table cell after its row's first claims none, since Firefox writes a whole row on one line: a flag's alt text in every first cell claimed rows × columns lines, and every block after the table missed. Such a cell that misses is tried once more right after the next tab on its row's line (`nextCellStart`), which moves the row past that tab whatever its cells match, so one cell spelled differently costs the cells after it in the row nothing. Every block is asked about a lone space at its start, and about one that starts a line after a `<br>` or at a block inside it (`lineStart`), since Firefox writes no leading space it did not draw -- except at the very start of a copy, where a drag begun on the first letter of a block whose source starts with spaces (`<p>  Hello</p>`) writes them collapsed to one, which is pasted: a known limit, because a drag begun after the period of `Sentence.  Next` writes the space it drew and selected as the same HTML and the same plain text --, but only a cell about one at its end: Firefox writes the one a pretty-printed `<li>` ends with whether it was drawn or not. This writer's output from before the mark is read raw only when it carries one of the marks that writer emitted (`data-neditor-depth`, `-list`, `-checked`, `-callout`; never the live renderer's formula, display-equation or code-label marks, which a page range copied across an editor carries), which a document of plain paragraphs does not; HTML stored from it needs `blocksFromHtml(doc, html, { whitespace: 'preserve' })`. The text-range writer (`richTextToHtml`) marks its phrase `pre-wrap` the same way, and writes a range from a code block as a `<pre>`. The line break a drag crossed at either edge of a copy is not content (`dropSelectionEdges`): an `Apple-interchange-newline` break that is the fragment's first or last leaf, however deep, with every element that held nothing else (whatever `white-space` the engine wrote on it; never a table's part), and a block at an edge whose subtree draws nothing (`drawsNothing`: no text but collapsible whitespace, no `<br>`, picture or control), which is Firefox's emptied block -- it keeps the inline elements and the indentation the block had, and can be a `<pre>` or a `<details>` -- never decided by the plain text, whose leading newlines on a pretty-printed page are the source's, and never looked for inside a table. An end a ProseMirror copy's `data-pm-slice` marks closed keeps its empty blocks: they are whole blocks the reader selected. A `<details>` anywhere on an open copy's start edge -- the first element, its first child and so on down through any element, a page's wrapper, Chromium's `<slot>` and WebKit's content `<span>` around a nested one and an editor's content `<div>` included; asking only the first element missed every wrapped FAQ -- with no summary of its own (`firstSummary`, which finds one in WebKit's content slot) and something drawn is a drag begun in its body, or WebKit's hoisted start tags of the closed ones a drag crossed: it is marked `HEADLESS_DETAILS` and read as a container -- marked rather than unwrapped, so its content keeps the `white-space` the engine wrote on it and nothing is moved. That is safe only because the writer marks every block `white-space`, which keeps its empty paragraphs; drop the mark and copied empty lines vanish at the edges.
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
  paragraph for the text it cannot keep. The public `setBlockType` does both in
  the other direction too: to `divider` it opens that paragraph, and from a
  table it flattens the cells into the block's text.
- **Hidden blocks travel with whatever hides them.** A collapsed toggle's children are still in `#blocks` but absent from the rendered view. `#selected` holds only the ids the reader can see; the expansion happens at the edit, in `#selectionForEdit()`, which grows the set through `withHiddenDescendants` -- by what the document hides and by what a read-only reader's chevron hides (`#readerExpanded`), since a toggle the reader closed was copied without its children (R14-RV7-3). Any new operation on a block set must take its ids from `#selectionForEdit()` (never `#selected` or `getSelectedBlocks()` directly), or apply that expansion itself — otherwise a move or delete silently orphans blocks the user cannot see. Single-block paths are no exception: Backspace-outdent and the gutter's `+` both have to account for a block's hidden children. The reverse also holds: a removal, a move, an indent or a paste changes what precedes a block, and if that is now the end of a collapsed toggle's subtree the block vanishes into it — so does a block indented after one. Every delete, merge, move, indent, paste, type-over and duplicate commit goes through `keepVisible`, which opens such a toggle; a new structural commit belongs on that list, and the focus that follows it depends on it, since a caret cannot land in a hidden block. What the reader was looking at can also travel in a block with a fresh id — a paste moves the text after the caret into its last block, the caret's destination — so pass such ids as `alsoShow`, as paste does for its last block and duplicate does for the copies of what the reader selected. Paste asks only when that block holds something the reader already had (the text after the caret) or sits in a fold that was already in the document: a closed `<details>` pastes as a collapsed toggle and stays one, and the caret goes to the end of the nearest pasted block still on screen. The opposite case is an indent that cannot happen: `indentBlocks` clamps each block on its own (at depth 0, and one level below its predecessor as already moved), so a collapsed toggle that cannot move must not hand its hidden children over to move alone — `indentTargets` asks the clamp itself which anchors move -- and, at the depth ceiling, whether their hidden children can move with them -- and drops the rest together with what they hide, which keeps a Tab or Shift+Tab that changes nothing visible a true no-op, never a swallowed key. Paste follows Enter: lines pasted into a toggle's or a callout's own text after its start become its children (at the very start of one with text they go in front, as Enter there puts its new block); a block that cannot merge, pasted at the very start of a block with text, goes in front of it and leaves it exactly as it was; and a toggle or callout is never replaced or removed as an empty husk, because it is still its children's parent — pasted into while empty, it takes the paste as its own text and children instead (at `MAX_DEPTH`, its text and siblings, as Enter there; a first block that cannot merge goes in front of it). A block a paste does replace keeps none of its old type's fields. Plain lines -- `text/plain` with no HTML, read as nothing but depth-0 paragraphs -- pasted into a list item or a to-do become further items of its type at its depth, as Enter makes them; the item keeps its own type, check and id, and is not replaced even when empty. Navigation and geometry (`focus`, caret stepping, drop gaps, `#blockIdAtY`) run over `#visible()`, while ranges and edits run over the full `#blocks`.
- **Depth is re-clamped, not trusted**: `normalizeDepths` runs after every multi-block edit so no block is ever more than one level below its predecessor. New structural operations should end with it. The re-clamp repairs depths without changing the tree: a block's parent is the nearest shallower block above it, before and after (up to `MAX_DEPTH`: a chain deeper than that is flattened onto it; a depth that is not a positive number is the root). Clamping each block against its predecessor alone moved a collapsed toggle up a level and left its sibling behind, deeper than the toggle and so hidden inside it. The other side of that rule is that the re-clamp believes the depths it is handed: an op that shifts a block must clamp the shift itself, as `indentBlock` and `indentBlocks` do, or a parent shifted past its own child reads as that child's sibling. For the same reason `normalizeDocument` does not cap a stored depth before the re-clamp reads the tree. "Directly after" a block means after everything nested under it: a move steps over the block it passes together with that block's children (going up, back to the first block at the selection's shallowest depth or above), except a block shallower than the selection, which is one slot, because that is how a block leaves a list and its children cannot be adopted -- and going down it also passes a block whose parent sat in a gap of the selection, which stays with that parent; a duplicate goes after the original's children.
- Drop indicators and the gutter position themselves vertically with `offsetTop` against the root, not `getBoundingClientRect`, so they survive page scrolling. The gutter's inline position is not measured at all: it is the sum of the computed `padding-inline-start` of the root and of the block and the block's `margin-inline-start` (its depth), read as logical properties so it holds in both writing directions. The gutter's space is reserved by padding on `.neditor-block`, not on the root — a host stylesheet with higher specificity (Astro's scoped styles, for one) would win against the root. And the gutter names a block by id, so whatever moves the layout points it again afterwards (`#refreshGutter`, after the render in `#applyBlocks` and in `setDocument`): after a peer's `setDocument` put a block in above, the handle stood beside the block that had moved into its place while still naming the old one, and a click on it and Backspace deleted a block it was not beside (R14-RV2-B3). A gutter that is not showing names none, and nothing is drawn.
- `parseRichText` is a **trust boundary**: it also consumes pasted HTML. Anything not in `SKIP_TAGS` contributes text, and only `sanitizeUrl`-approved hrefs become links. Add new element handling there, not in the editor. Foreign HTML is parsed in an **inert document** (`doc.implementation.createHTMLDocument('')`), and every scratch node the readers make is made there: a node cloned out of the template into a container the live document owns is adopted by it, and an adopted `<img>` or `<video>` loads — its `onerror` runs in the host page even though nothing is ever attached. Never thread the caller's document into the readers.
- **The clipboard reader builds nothing in the live document.** The paste is parsed in a template, whose contents are inert, but every wrapper, fragment or copy the reader makes afterwards adopts what it is handed, and an image or media element adopted into the live document loads and runs its `onload` or `onerror` -- in every engine, on paste, on drop and from `blocksFromHtml` called by a host. `readBlocksFromHtml` makes a document with no browsing context per read (`inertDocument`) and passes it down as `doc`; past the template the markup is parsed in, anything that creates an element or fragment during a read takes that `doc`, never the caller's document. Not a pasted node's `ownerDocument` either: that is inert in a browser but the live document in happy-dom, where the unit tests that pin this could no longer tell the two apart. (A `cloneNode` copy stays in its source's document -- the template's, or the read's own -- which is inert either way in a browser.) The e2e guards are `C7b` (paste, written from a page's own `copy` event, which no engine cleans) and `D1b` (drop), each in every engine.
- **Foreign content enters through the parser or not at all — and pasting is not the only way in.** A drop carries the same flavours as a clipboard, and the browser's default for one is to write the dragged fragment straight into a live editing host; because typing is DOM-first, `#syncFromDom` then reads that fragment back as the block's own content, the model agrees with the DOM, and nothing later renders it away. So an `<iframe>`, a password form or a fixed full-viewport overlay dragged in from another page _persists_. `#handleDrop` cancels the drop unconditionally — before any check that might give up — and re-enters the payload through `#insertForeignContent`, the single path paste also takes; `#handleBeforeInput` refuses `UNPARSED_INPUT_TYPES` as the backstop for anything that slips past either handler. Any new way content can arrive belongs on that path, never on the browser's default.
- **Input rules fire on insertion, not on deletion.** `#tryBlockRule`, `#tryInlineRule` and `#tryOpenSlashMenu` read the text before the caret and treat it as text just typed; a deletion leaves the identical text there without anyone having typed it, so backspacing the word after a `# ` converted the block and ate the prefix. `#handleInput` gates them on `isInsertion(event)`. `#updateSlashQuery` is deliberately ahead of that gate — an open menu reads the text rather than acting on it, and must still narrow on Backspace and close when the `/` goes. It is also asked on `compositionend`, because `#handleInput` stands down while composing and a query composed through an IME was otherwise never read. A character typed _into_ an inline code run closes no span (`#tryInlineRule` asks only the character that completes the match): typing a line from scratch never puts that character in code, so this cannot split typing from pasting -- hiding a code run's whole text from the rules would, and was reverted for exactly that.
- Floating UI is portalled to the mount's root node (`document.body` for an ordinary mount, the shadow root otherwise, or `portalContainer`), so it sits outside `.neditor` and inherits neither its custom properties nor its direction — `#syncPortalDirection` copies `dir` across on focus and again as each portal opens. Use `ui/portal.ts`: it applies the `neditor-portal` class the theme tokens key off, and `positionPortal` measures the real element rather than estimating -- and lifts an anchor measured in the editor's window through the frames to the portal's own (`setAnchorView`), by each frame's offset and its drawn-over-layout scale, since a `transform` or `zoom` around the frame scales everything inside it (WebKit under `zoom` excepted, a documented limit), for a `portalContainer` in the page around an iframe mount -- and chooses the side of the anchor it goes on by what the pages around an iframe mount show of the frame (`setAnchorBand`, answered by `#frameBand`), not by the frame's whole window, which a pane around the frame or a page's window shorter than the frame cuts -- only what clips the page the portal is drawn in, though: a `portalContainer` in the page around the frame is cut by neither that page's panes nor the frame; the band chooses the side only, and the portal is clamped to its own viewport, never across its anchor. Never call `scrollIntoView` inside a fixed portal — it scrolls the page to the portal's layout origin. Portals follow the ground scrolling under them through `#handleViewportChange`, which listens in the capture phase on the document _and_ on every shadow root the editor is drawn inside -- climbed through the flat tree (`flatParent`: the `<slot>` an element is assigned to before its parent, so the shadow pane of an `<ion-content>` the editor is slotted into counts) and read once, at mount -- and, for an iframe mount, on every same-origin document around the frame and the shadow roots the frame is drawn in: a scroll inside a shadow tree is not composed, and the document never hears it. The clip climb (`clipChainOf`), the drag's auto-scroll (`#scrollTargets`) and these listeners climb the same flat tree; keep them in agreement.
- Styles live as a string in `src/styles.ts` and are injected at runtime. This is what lets the package work with no CSS loader. Theme through the custom properties on `.neditor`.

- **A formula is an atom, and its TeX is the whole of it.** An inline formula is
  one run, `{ text: MATH_ATOM, math: tex }`: one character of offset whatever it
  draws, no marks, no link, never merged with a neighbour (`\alpha` beside `b`
  is not `\alphab`). Its element is `contenteditable="false"` and carries the
  TeX in `data-neditor-math`; `parseRichText` reads that attribute and never
  looks inside, which is what keeps renderer output -- and any pasted math
  markup -- out of the model. `view/selection.ts` counts the element as one
  character in a single walk (never through a Range's `toString()`, which
  counts the drawing); any new offset code must do the same, or every caret
  after a formula lands hundreds of characters too far. A formula that ends a
  block is followed by an empty separator `<img>` and a filler `<br>`: without
  them Firefox dropped what was typed after it and WebKit put it in front. The
  separator is no text, so a deletion of it changes nothing the renderer sees:
  `Backspace` after a formula and `Delete` before one -- and a word deletion
  either way, the formula being the word -- are taken model-first
  (`#deleteFormula`), or the first press deleted the separator and nothing else
  (Firefox's word deletion, nothing at all). A deletion whose target ranges
  reach past the formula, read in model offsets (`offsetAt`), is the
  browser's: an IME taking back more than one character knows what it means. A display equation is a `math`
  block whose content is its TeX, literal like a code block's: `isLiteralType`
  is the test, `contentForType` is how anything enters one.
- **Rendering math is the host's, through `renderMath`, and its output is
  view-only.** `@neditor/core` stays dependency-free: no typesetter is bundled,
  and without one the TeX is drawn as source. A renderer is called with
  untrusted TeX and its string is assigned as HTML, so the README tells hosts it
  must be safe for any input. A display equation's picture lives outside its
  editing host, so typing never reaches it; `Renderer.syncFromDom` redraws it,
  because typing does not render.
- **A formula's TeX is written raw and read from the source.** `$…$` holds TeX
  unescaped, and `parseInlineMarkdown` takes it from the raw text between the
  dollars (`openSources`), not from the projection, where escapes have lost
  their backslashes and rules that fired inside the span have eaten their
  delimiters. A `$` in prose is escaped, so the only unescaped dollars the
  writer emits are formulas -- and, in URLs, an autolink's or a link
  destination's, an autolink being safe only because the writer refuses that
  spelling when a bare `$` follows in the block: a formula's, a code run's, a
  link destination's or another URL's (`dollarAfter` in `RunContext`, and
  `laterDollar` within a run) -- except in a code span, where a `$` stays bare
  and both the reader (as the span closes) and typing (`matchInlineRuleInRuns`)
  project it to `CODE_DOLLAR`, a barrier to a formula as the atom is, so it
  neither opens a formula nor doubles the opener of one written straight after
  it (`` `x$`$y$ ``); in a link destination it is read back as `$`, a real
  formula there makes no link (so the writer percent-encodes the atom in a
  link's destination, and `normalizeInlineTex` drops both barriers from TeX), and a `$` typed into a code run closes nothing. The reader follows Pandoc's rule that
  no digit follows a closing `$` (so `$5-$10` is a price), the writer spells a
  digit after a formula as a numeric reference, and typing refuses a closer
  with a digit already after the caret and, since it cannot see a character
  not yet typed, takes the formula back when a digit comes
  (`#takeBackFormula`, which withdraws its history entry rather than adding one). The typing path cannot recover what an earlier
  rule took out of the text, and that divergence is documented rather than
  hidden. So is the destination's: no formula closes inside an open link
  destination whose label's `[`, or an autolink whose `<`, came before its
  `$` -- one that opens inside the TeX is the TeX's, so `$[0,1](x$)` and
  `$a<http://b$` are formulas, and `[Save $](https://a.test/?q=$)` is a link
  -- but typing holds a labelled destination open in case its `)` is the next
  key, while the reader looks ahead along the line, so
  `[t](https://a.test/$y$ z` is a formula pasted and literal typed. An
  autolink has no such look ahead: `<https://a.test/$y$ z` stays text both
  ways. A link whose label is formulas alone is no link: a formula takes
  none, and the rule would take the URL with nothing left to carry it; the
  angled form refuses outright, so the plain rule does not retry from a `[`
  inside its URL that runs past the `>` -- within `INLINE_SPAN_LIMIT` (a link
  closed whole inside the URL is read as one, as below). A link longer than that, in
  either form, is beyond every rule's reach, and so is its destination: the
  writer's own long link comes back as its text -- a known failure, since a
  URL has no shorter spelling -- and the writer escapes `*`, `_`, `~` and `$`
  in its destination so that text survives. A link nested in a destination
  is read as a link first (outside an autolink still open, `<http(s)://` up
  to whitespace, where no link closes), and when the outer one closes the
  inner one is lost -- its brackets and URL drop out of the outer URL, its label stays
  (foreign Markdown only: the writer escapes every `](` in a destination);
  refusing it was tried, and it made
  the closed inner hinge hide the open outer destination and held links back
  while typing -- a documented limit, not a rule to retry. Invalid TeX the `$` spelling cannot carry is in the known-failure
  registry; the HTML path carries it in an attribute.

## Dependency constraints

- **TypeScript stays on 6.x.** `@astrojs/check` peer-depends on `^5 || ^6`.
- **Do not alias `vite` to `@voidzero-dev/vite-plus-core`.** Astro 7 drives its own Vite 8; the alias resolves `vite` to a 0.x version Astro cannot use. `vitest` is pinned to the exact version Vite+ bundles and should stay pinned.
- `vp pack` emits `index.mjs` / `index.cjs` / `index.d.mts` / `index.d.cts`. The `exports` map in `packages/neditor/package.json` matches those names — update both together.

## Validation

Run `vp run ready` (check, test, build). `vp -C apps/web run check` additionally type-checks `.astro` files via `astro check`.

- **A pointer gesture can end without `pointerup`.** `pointercancel` fires when
  the browser takes a gesture over — a touch that becomes a scroll, a lost
  window focus. Any state a drag opens has to be closed on both events, or the
  drag stays live forever and every later pointer event is misrouted. Both
  are heard in the document's capture phase, as the press is (`#disarmExit`),
  and for the same reason: a page that stops either above the editor (a
  container with drag handling of its own; in an iframe mount, the frame's
  own body) never let the bubble phase hear it, and from the first click on
  the press stayed down -- Escape in the block selected nothing, Escape twice
  then Tab never left the editor, a handle drag never dropped its block, and
  a text drag kept `data-selecting` and went on selecting under a pointer
  with no button down, in every engine and mount (R14-RV4B-1). The release
  runs before the page's own listeners for it, which then see the gesture
  over; it still runs before the compatibility `click`, which is a later
  event. Only a page that stops the release in its window's own capture
  phase is out of reach, as it is for the press and the moves between them
  (a read-only drag released on a textless block it never heard reach
  selects the pressed block's text). The drag
  also takes pointer capture so a finger leaving the window still delivers the
  end event. That capture has a tail: the compatibility `click` after
  `pointerup` is dispatched at the capturing element, so the handle's own click
  hook runs after every drag and collapsed a dragged multi-block selection down
  to the block whose handle was grabbed. A drag and the click it produces are
  one gesture — `#endDrag` arms `#clickEndedDrag` and `#selectFromHandle`
  consumes it, exactly once, so a press that never moved still selects.
  Escape is a third way a gesture ends, and it ends only the gesture:
  `#handleDocumentKeyDown` runs in the capture phase and stops the key, or the
  root's own block-mode Escape ran too and threw away the selection the drag
  had made. A handle drag also ends when the document changes under it —
  `#applyBlocks` and `setDocument` end it — because its gap is an index into
  the document it started over, and an undo mid-drag made the release commit a
  move into a stale position. A text drag ends there too (`#endTextDrag`):
  left live, it kept `data-selecting` and re-selected against the new order.
  A drag across blocks (`promoted`) is given back after a peer's
  `setDocument` that leaves the shown blocks in their order and its own
  block among them (`#resumePromotedDrag`) -- a content edit anywhere, its
  own block's included, whose press is carried by the text around it --
  since its selection is kept by id and its range is between ids: ended,
  it stopped following the pointer, and a drag from p1 to p6 over a peer's
  edit to p15 released p1-p3 (R14-PTR-5). The pointer it follows at rest
  is given back with it (`#promotedDragState`'s `follow`, read before
  `#endTextDrag` stops the scroll): held at the window's edge, which is
  how a long run is selected, it sends no move, and the selection stood
  still after each update until the hand moved. Where nothing carries
  the press -- its block's text replaced whole, its block become one
  with no text, a table's cells rebuilt, a drag begun on a divider --
  the drag goes on across blocks all the same and has no place in its
  own block to come back to as text: back over it, the selection is that
  block alone (`#returnTextDrag`), and one block and the next when it
  moves away again; no offset is guessed for a range. Until round 14 the
  drag did nothing there, and the blocks it had last crossed stayed
  selected, "hr,p2" with the pointer back on the rule (R14-FX-3). A
  collapsed toggle is one block there like any other, and its hidden
  children go with it at the edit (`#selectionForEdit`). A reorder, an added or removed shown block, a collapse that
  hides one, or its own block gone still end it, at the blocks it held.
  A drag that has not left its own block yet is watched again the same
  way (`#resumeTextDrag`, where the update left the press's own text
  alone): the browser's own drag there is untouched, and the editor only
  goes on watching it for the block edge, over an update that kept the
  blocks' order. Ended, it could no longer become a block selection once
  it crossed into the next block, and a drag from p1 to p6 with a peer
  typing in p15 released a range of p1's text 3 to 8 times in 30
  (R14-RV1-1). In a read-only view too, whose blocks hold no focus: its
  drag across blocks is promoted as it goes, over such an update, as an
  editable view's is (R14-RV2-1) -- whether the host holds focus is not
  asked at all: no input tried reached the question in an editable view
  with the answer no (the keyboard moves the selection with the focus, a
  script's `focus()` takes the selection off the block, and either ends
  the giving back before it), so the condition was removed rather than
  kept unpinned. Over an update that did not keep
  the order the two kinds part: the browser's own drag ends as it did
  before round 14 -- it stays the browser's, a text selection in its
  block, and in a read-only view the range across blocks the release
  promotes -- while a drag the editor draws (`placed`, `returned`) goes
  on, by the new order: its anchor is in its own block's text, which the
  update left alone, and the blocks it crosses into are read from the
  document as it is at each move. A real lock ends every drag for good:
  a `setEditable(false)` that takes editing away marks the gesture ended
  (`#lockEnded`) -- the gesture of a press that began as a text press in
  this editor, its drag live or ended already by Escape or a peer's
  reorder (`#textDragEscaped`): asked only for a live drag, such a press
  went on over the read-only blocks to release "p1,p2,p3,p4" -- and what the browser goes on selecting across blocks
  with the button still down is let go of at the release, before the
  release reads it (`#dropRangeAcrossBlocks`) -- promoted there, WebKit's
  own drag released "p3,p4,p5,p6" after a lock had let go of p1-p3, and
  only kept from that, the next `selectionchange`, a Shift+arrow's
  included, promoted its 81 characters over p1 to p5 all the same; a
  range inside one block is the browser's own and stays, and so does the
  range of a press in the page's own text, which no drag of the editor's
  began. The ends compared are the composed range's (`readSelectionEnds`,
  in `view/selection.ts`, beside the one reader of `getComposedRanges`'
  two call forms): out of a shadow mount the selection's own ends are
  retargeted to the shadow host, name no block, and the range stayed, 9
  characters in Firefox and 22 in WebKit, which reports it collapsed
  (R14-RV3-3). An end at the editor's root, in no block, is a place of
  its own: taken for one outside the editor, it named the same place as
  an end in another editor's block, and a drag from a second editor into
  this one kept 74 characters (WebKit). The flag has one reset, at the
  next press, in the document's capture phase (`#disarmExit`): the
  release reads it, and a release can be lost. Not a focus move, which
  `#disarmExit` also hears: it begins no gesture, and reset by one, a
  host that locks and focuses a button of its own in the same call let
  the release promote the browser's range across the read-only blocks,
  p2..p6 in WebKit and p1..p6 in Firefox (R14-RV5-1). Reset in the bubble
  phase, a page that stops `pointerdown` above the editor never reached
  it, and the next gesture's release was read as one a lock had ended
  (R14-RV4-2). A press in this editor is marked there too
  (`#pointerDown`): marked only in the bubble phase, a press such a page
  stopped was no press of the editor's, and a lock in the middle of its
  drag released p1 to p3 selected, in every engine (round 14, review 4).
  And it is cleared in the same phase, by the release (`#handlePointerUp`,
  `#handlePointerCancel`): marked in the capture phase and cleared in the
  bubble one, a page that stops both kept the press down from the first
  click on (R14-RV4B-1).
  The same letting go runs at a release that finds blocks
  selected, in a read-only view, of a gesture pressed in this editor
  (its text drag live, or ended with the button down): a read-only drag
  across blocks that a peer's reorder ended keeps its blocks while
  WebKit's own drag goes on from the editor's root, and left a range of
  1,073 characters beside them, both modes at once (R14-RV3-6). Not a
  press in the page's own text: a range the reader drew from there into
  the blocks is theirs, and dropped with blocks standing, nothing was
  selected and a read-only Mod+C copied nothing (R14-RV4-1). Not an
  editable view's: a drag the editor promotes there leaves at most
  WebKit's caret in a block, which the stray-caret check takes out (a
  reorder after promotion, and 40 drags under a peer reordering every
  170 ms, left no range in any engine). With no blocks selected the
  range is the release's to promote -- and, read as a pointer's (the
  release says so: `#promoteCrossBlockSelection`'s `release`, which no
  other caller passes), a block it reaches only at the start of its
  text, no character of it selected, is not in it
  (`#releaseLeavesOut`): Chromium and WebKit end a read-only
  triple-click's paragraph at offset 0 of the next block, which made "b,c"
  of a click on b (R14-RV4-B1). The range's blocks are read over the
  blocks on screen, as every selection anchor is: a collapsed toggle's
  hidden children counted, the triple-click on its text was left with
  the toggle and a child once the next block was out, and selected the
  toggle as a block -- Mod+C copied what it hides (R14-RV6-1); "on
  screen" counts a toggle a read-only reader closed with its chevron
  (`#readerExpanded`, through `#visible()`). A block selection that does
  take a toggle in carries what it hides at the edit
  (`#selectionForEdit`), hidden by the document or by the reader:
  expanded by the document alone, a toggle the reader closed was copied
  without its children (R14-RV7-3). The copy writes the document, so that
  toggle is written open, as the document has it, with its children
  under it. Left with one block, the range is that block's own
  (`#releaseWithin`) -- from where it starts, the way the reader made it,
  and in its own host: for a table, the cell the range starts in, when
  the range holds no text after that cell (read as the block's first
  cell, WebKit's triple-click in "b3" became a caret in "H1", R14-RV5-4);
  a start in no cell -- below the grid, where a click in the table
  block's own band leaves Chromium's and WebKit's caret -- is beside the
  last cell that ends before it, from that cell's end, else the first
  cell, from its start (read as the first cell, a Shift+click beside the
  next block from there wrote a range over "H1", and Mod+C copied "H1",
  R14-RV7-2) -- as Firefox and an editable view give it. Where that
  leaves nothing of the block selected -- a click at the end of b's text
  and a Shift+click beside c, whose range holds no character of either,
  or the same from the end of a table's last cell -- the block is not
  left out, and both are selected, as round 13 did: written into b, the
  range selected nothing (R14-RV7-1). A range that runs on from its
  cell over cells with text is the table's, selected as a block: cut to
  its start cell, a click in "H2" and a Shift+click beside the next
  block selected "2", and Mod+C copied "2" (R14-RV6-2). A table has text
  when any cell does (asked of its first cell alone, an empty one kept
  "b,c"). A block with no text at all -- an empty paragraph, a divider,
  a picture with no caption -- is reached only at its start by the same
  triple-click, which ends the paragraph exactly where a Shift+click
  beside that block does: only the gesture tells them apart, so the
  release passes the block it was pressed on, and such a block is in the
  range only when it is that one (R14-RV5-3: the triple-click copied
  "Block B" with an empty line, "---" or `![grey]()`). The press is the
  one block a gesture names: a drag that reaches another block is a block
  selection from that move on (`#updateTextDrag`) and leaves no range for
  the release to read (108 read-only drags onto, past and back from such
  a block, three engines). Nothing but a pointer's release leaves a block
  out: a range a key made -- the browser's own read-only Shift+arrow,
  read at its `selectionchange` -- or one built through the API selects
  every block it reaches, as round 13 did. Asked of a key's range, the
  rule held every read-only Shift+→ from a word double-clicked at the
  end of a block inside that block, since the range reaches the next
  block at the start of its text, and in Firefox Shift+← from a block's
  start dropped the block the range began in (R14-RV7-1). The pointer's
  release is passed explicitly, never inferred from `pressed`, which a
  release with no text drag lacks. A block with no text a key's range
  reaches stays in it too (Firefox's Shift+↓ runs onto a last divider).
  A range with an end outside the editor is never
  promoted, not even WebKit's read-only triple-click on the last block,
  which runs on past the blocks (Chromium's too after an announcement):
  telling that run-on from a drag into the page's text was tried for three
  rounds and stayed wrong (R15-SEL-4 to R17-2, reverted), so the copy takes
  the paragraph and the empty lines after it, a known limit. Its ends are read by `readSelectionEnds` -- the selection a
  shadow root gives of its own where it has one (Chromium's), else the
  document's, through that selection's composed range where one reaches
  into the tree, else by its own anchor and focus -- since at the
  release of a drag from the page's text into a shadow root Firefox moves
  the selection's own anchor into the tree, to the first block, and a..d
  were selected and copied (R14-RV5-B1). A range the reader began
  outside this editor -- in the page's own text, in another editor's --
  ends a block selection, wherever its focus is
  (`#rangeBegunElsewhere`, from `#handleSelectionChange`): both were
  shown, and the blocks were still `getSelectedBlocks()`'s answer
  (R14-RV4-B2); asked only of a range wholly outside the editor, a drag
  from there straight into the blocks was first seen with its focus in
  them, and the blocks stayed beside it (R14-RV5-5). The range is left
  as it is, the reader's to copy (R14-RV4-1). Its anchor is read as the
  page's selection, never a shadow root's own -- Chromium's
  `ShadowRoot.getSelection()` reports nothing for a range outside its
  tree, and a page range left a shadow mount's blocks selected
  (R14-RV5-2) -- through the composed range (`readSelectionAnchor`, in
  `view/selection.ts`), by the selection's direction, or, where it has
  none (Chromium and WebKit, for a mouse's), by the end the selection's
  own retargeted anchor or focus names outside the tree -- the same node
  at the same offset: WebKit retargets an end in the tree to the host's
  place in its parent, and a drag out to a blank corner of that parent
  ends there at another offset, which, named by node alone, read the
  drag's own anchor as the page's and ended its blocks; where nothing
  says, a range with both ends outside. Read retargeted, a read-only
  drag pressed in b and carried out of a WebKit shadow root lost its
  blocks as it went. A second editor on the page is no exception where
  there is a range to read: one drawn across the other editor's blocks,
  or from them into this one's, leaves this editor with none selected.
  So does the other editor's own drag across its blocks once it has
  selected text in the block it began in;
  one that leaves that block before selecting anything presents no range
  in Chromium and Firefox (WebKit makes one when that editor is editable),
  and this editor's blocks stay beside that one's, as they do for a click
  on a page button: a documented limit (round 14, reviews 5 and 9). A press that makes no range ends nothing, so a
  host toolbar's button can read the blocks from its own click. The caret WebKit's own drag leaves after a lock, once an
  unlock makes the block editable again, is taken out at the release too
  (`#lockEndedBlocks`, R14-RV1-7). Not
  while the button is down: WebKit keeps a caret of its
  own (a range, after a peer rebuilt the anchor block) in the block under
  the pointer through any held drag across blocks, nothing is drawn for
  it, keys act on the block selection, and the release takes it out
  (`#takeStrayCaretOut`); writing the selection under a held drag to
  remove it is not done (R14-RV1-6, a known limit) -- which is why a drag
  given back over an update is unmarked as ended (`#textDragEscaped`):
  left marked, that caret was taken out as it appeared and focus put on
  the root in the middle of the drag. The lock's flag is its
  own, not `#textDragEscaped`, which every ended drag sets -- a
  peer's `setDocument` in a read-only view too, where the browser's range
  across blocks is all there is to read at the release: gated by it, a
  read-only drag or Shift+click with any update in the middle of the
  press selected nothing, 10 to 23 times in 60 (R14-RV2-1). And a
  `setEditable` that switches nothing is no lock: it returns before any
  statement of the switch, so it changes no selection, drag, panel, focus
  or event -- `setEditable(false)` on every render of a read-only view
  let go of the blocks a reader had selected to copy (R14-RV2-B2).
  A press still selecting text in its own block when a peer's
  `setDocument` redrew that block, and the carry wrote the reader's
  selection into it, is given back drawn by the editor
  (`#resumeTextDrag`). No engine's own drag
  selection survives that write whole: Chromium's, written a caret mid-drag,
  put a caret under the pointer from then on and selected nothing
  (R13-RV2-PTR-3), and a double- or triple-click drag went on by character
  in Chromium and WebKit. So the editor draws it from the carried anchor, as
  a drag back in its own block (`returned`), and by the press's own unit
  (`TextDrag.unit`; the click count is the `mousedown`'s `detail`, a
  `pointerdown`'s being 0 in Chromium): the word or paragraph the browser
  itself selected for the press, read before the drag's first move
  (`#noteDragUnit`) and carried through each update by `carryRange`, never
  re-derived -- from the carried range's end it lost the double-clicked
  word on a backward drag, and a segmenter's paragraph dropped the line
  break Chromium and WebKit take (R13-RV4-PTR-3, -4). Its far end is the
  word or paragraph at the caret nearest the pointer (`farUnit`), taken as
  the anchor was (its line break, a word's trailing spaces): Chromium's and
  WebKit's own rule, with `Intl.Segmenter`'s words (`wordAt`, read in a
  window around the offset -- `containing()` costs time in proportion to it,
  157 ms a move in 30,000 characters of Thai) -- in text of one direction.
  Firefox runs on over a run of spaces at the caret to the next word,
  Firefox's and WebKit's words differ from ICU's at some punctuation,
  WebKit's backward drag in right-to-left text treats spaces differently,
  and in mixed-direction text the caret at a run's visual edge is
  ambiguous, so the word reached can be the visually opposite one (2-3
  points in 50-66 in Chromium and WebKit, where their own drags lose the
  double-clicked word at far more): documented limits, measured. A Shift
  multi-click that left the reader's range exactly as it held it at the
  press (`heldRange`: both ends and the direction) takes no unit, and the
  editor goes by character: Chromium's and WebKit's Shift+double-click,
  which extend the range, as they do when that range was made by a click
  or a drag (R13-RV5-PTR-1); made by a double- or triple-click, they keep
  its unit and the editor does not, a documented limit. A press that
  re-anchored -- every engine's Shift+triple-click, every Firefox Shift
  multi-click -- changed the range or its direction and takes its unit.
  Asked by the anchor end alone, a re-anchor starting where the old range
  did (Shift+triple-click from a caret at 0) passed for an extension
  (R13-RV6-PTR-1); by both ends without the direction, Firefox's forward
  "quick" over the reader's backward [4,9] did (R13-RV7-PTR-1). A Firefox
  re-anchor that leaves ends and direction both unchanged (Shift+double-
  click on the word the reader's forward range already was; Shift+triple-
  click in a one-word paragraph) cannot be told from an extension without
  asking which browser it is, and goes by character: a documented limit.
  Where the direction cannot be read (WebKit in a shadow root reports every
  range forward) the ends alone decide. A Shift press's drag is anchored
  where the browser anchored the selection for the press (`anchorPoint`,
  read by `#noteDragAnchor` once the press's default action has run: at the
  first move, or in `setDocument` before a peer's update redraws the host),
  which is where its own drag is anchored. That is not the reader's anchor:
  Firefox keeps it, but Chromium and Safari on macOS re-anchor a range at
  the end farther from the click. It is read without the range's direction
  -- the click is the focus, so the anchor is the end farther from the
  press -- and kept through a redraw as an end of the range (`anchorEnd`,
  read in `setDocument` before the render), since WebKit in a shadow root
  reports every range forward. Anchored at the press point, a Shift+click
  drag that went into the next block and came back was redrawn from the
  press, [4,37] for [9,37] (R13-RV7-PTR-2); at the reader's anchor, [4,20]
  Shift+clicked at 11 came back [4,37] for [20,37] (R13-RV8-PTR-1); at the
  range's reported anchor, in WebKit's shadow root, [4,37] and [11,37]
  (R13-RV9-PTR-1). Any other press's anchor is kept that way too
  (`#anchorEndOf`), but only where the selection reports no direction
  (`SelectionReading.undirected`: WebKit's `Selection.direction` is
  "none" for a selection a mouse made, and through a shadow root's
  composed range every such range reads forward): there a single press's
  is the end nearer the press, and a multi-click's the side of its unit
  the range kept, whichever end the press is nearer -- taken as the
  range's reported anchor, a drag from 50 back to 30 in WebKit's shadow
  root went on from 30 after a peer's update, [10,30] for [10,50]
  (R14-PTR-2). Everywhere else the reported anchor stands, as in round
  13: asked of every engine, the nearer end was wrong where the caret
  read under the press and the browser's own anchor fall on two sides of
  a letter -- Chromium, pressed seven tenths across one, one character
  dragged when the update landed, [31,55] for [30,55]. A primary Shift press on a host, in an editable view and
  not by touch, follows one rule (`#handleRootMouseDown`): (a) with the
  reader's caret or range in a host that holds focus (`#typingIn`), a press
  in that host is the browser's extension, and a press on another host --
  another table cell too -- is cancelled, with no drag and no link click
  (`#shiftPress`): Shift extends a range within its own host and
  otherwise leaves it. Left to the browser, Chromium and WebKit grew the
  reader's range to the edge of its own block facing the press ("Alpha" to
  "Alpha one"), Firefox dropped it for a caret at the other block's start
  (R13-RV9-PTR-2), and a link there opened the link editor. (b) With no
  such caret or range -- focus left on a page button with a stale range,
  the selection in the link editor's field, a block selection, nothing --
  the press is a plain one: the caret at the press (`#placeCaretNear`) and
  an editor-drawn drag from it (`#armPlacedTextDrag`), in every engine, on a
  host or beside one (the off-host path takes `#extendSelectionNear` only
  under (a): with nothing to extend, a Shift press on a list marker, below
  the last block or on a table's border was swallowed with the next key,
  R13-RV11-PTR-3). A press never reveals the host: `#placeCaretNear` and
  `#extendSelectionNear` place without `#reveal` -- revealed, a host
  taller than the window moved under a Shift press and the drag from it
  took 1,491 characters for six, and a plain press in the gutter beside
  one jumped 400px (R13-RV11-PTR-1). They reveal the caret's own box only
  where it is off screen, by the least scroll (`#revealPlacedCaret`:
  sideways in each scroller around it, a table's own included, then as
  `#revealBox`): the text nearest a press can be out of sight -- a caption
  below a picture taller than the window, a cell scrolled out of its table
  -- and left there, the first letter typed jumped the page
  (R13-RV12-PTR-1). Nor does a press that selects blocks reveal them
  (`#setBlockSelection`'s `reveal`): a click on the handle
  (`#selectFromHandle`, a pointer's own click, `detail` above 0, with
  Shift or Mod as without), a
  press on a block with no text (`#placeCaretNear`), a long press
  (`#startLongPress`), and the range across blocks a release promotes in
  a read-only view (`#handlePointerUp`), beside the drags, which never
  did. Revealed, the handle of a block cut by the window's edge moved the
  page 89px under the pointer, a rule 3 to 13px, and a read-only
  Shift+click 567px back to where its range began (R14-RV1-5). Every
  other way in is a key or the API and reveals as before: the arrows,
  Escape, Mod+A, Backspace and Delete onto a block, the
  handle operated by keyboard, undo and redo, paste and duplicate,
  `selectBlocks`, and a range across blocks a key or the Selection API
  made (`#handleSelectionChange`). What they reveal is the block the
  selection grows from (`#selectionAnchor`) -- except that range, which
  reveals the block it takes in, its focus end (R15-SEL-P3-1, -2: a
  read-only Firefox Shift+↓ left that block cut by the window's edge), and
  Shift+arrow on a block selection (`#extendBlockSelection`), which reveals
  the end it moves (`#setBlockSelection`'s `show`), growing or shrinking: revealed
  by its anchor, which never moves, six Shift+↓ from the window's last
  block selected p31-p36 out of sight and the page stood still
  (R14-RV2-B1). The first step out of the text is the same step
  (`#extendFromTextToBlocks`): revealing the block the caret was in,
  Shift+↑ from the window's first block took in p29 above the window with
  the page where it was, and Backspace deleted it unseen (R14-RV3-4). A Shift+click on a link in the reader's own host is
  extended by the editor (`#extendSelectionNear`): every engine puts a
  caret there instead, and the click opened the link editor
  (R13-RV11-PTR-4). The extension -- there and beside the text -- runs from
  the end of the reader's range farther from the press, without asking its
  direction, so the reader's text stays in it whichever side the press is
  on -- Chromium's and Safari's own Shift+click on macOS. Firefox's own
  plain-text Shift+click keeps the anchor, so there the two differ ("te"
  [13,15]: plain at 3 gives [3,13], on the link at 8 [8,15]): kept on
  purpose, since the farther end never drops the reader's selected text
  and needs no asking which browser it is (R13-RV13-PTR-3); kept by its
  anchor, "te" Shift+clicked on a link before it gave [8,13]
  (R13-RV12-PTR-3). A ⌘/Ctrl+Shift+click on a link
  follows it, as ⌘/Ctrl+click does, and takes neither Shift path
  (R13-RV12-PTR-2). Neither press under (a) is a link click (`#shiftPress`,
  spent by the first click after it and only by a pointer's own, `detail`
  above 0, so a page's `click()` after a press with no click still acts,
  R13-RV11-PTR-2). A click on a link opens the link editor in a task after
  the click (`#handleClick`, `#linkOpen`): WebKit collapses a range the
  press landed inside, and focuses the host, only after the click's
  listeners, which closed an editor opened in the click at once. Anything
  newer than the click drops the open: a press, a key, a new document, a
  lock (a real switch to read-only: a host re-asserting `setEditable(true)`
  on every render or `selection` event switches nothing, and cancelled on
  every call the link editor never opened, R13-RV15-PTR-1) before the task,
  or -- for
  a pointer's own click (`detail` above 0), whose press put focus in the
  link's host -- focus no longer there when it runs: a page's own click
  listener that moved focus to a control of its own, or placed the caret
  through `focus()`, had the last word, and the task took focus back into
  the URL field over it (R13-RV14-PTR-1). A script's `click()` put focus
  nowhere and still opens it. The task resolves the link afresh, so one
  gone from the document opens nothing -- after `destroy` too, which
  cancels nothing. It selects the link without revealing its host and
  brings only the link's own end into view where it is not wholly on
  screen (`#placeRangeInView`, as `#revealPlacedCaret`), and so do the
  link editor's Escape and Apply when they put the range back: revealed,
  a block taller than the window scrolled 100-300px and the link left the
  pointer, one cut at the window's edge 41-158px (R14-PTR-1). A link
  whose own line the window's edge cuts moves by what shows it, 2-10px
  measured, as a press the editor places there does. A script's
  `click()` too, measured: on a link scrolled out of sight above the
  window, revealing a host that covers the window moved nothing and left
  the link out of sight; its own box comes on screen. Cancelling such a press instead (round 13's first
  version) cost every engine the native drag of a selection by a link in
  it (R13-RV13-PTR-1). A drag the editor draws (`placed` or `returned`)
  goes on across a peer's update to another block (`#resumeTextDrag`),
  one that reorders the blocks included, by the new order:
  ended, it stopped following the pointer, with no drag of the browser's
  behind it (R13-RV12-PTR-4). So does the scroll that follows its pointer
  at rest (`#followAgain`), for an update to another block or to its own:
  held at the window's edge through one tall block, it stood still after
  each update until the hand moved (R14-FX-2). Where its caret under the pointer misses
  the host, it is read once more past the editor's own portals
  (`#throughPortals`: the portal on top at the point asked, by
  `elementFromPoint`, takes no pointer for that hit test, and gets its
  own inline `pointer-events` back, value and priority), since the format
  toolbar its own range draws sits over the line above, and a drag up
  onto a blank line hit it and collapsed at the release (R14-PTR-3,
  Chromium 15 of 30, Firefox 10; carried there in one move, every
  engine). Only after a miss and only a portal on top there: a drag that
  is not under one writes no style, so a page observing the portals
  hears nothing of it -- under a page's own header neither; taken out on
  any miss, the showing portals were written 73 to 75 times in two thirds
  of a second there. What is on top is asked of the host's document and
  followed into each shadow root the portal is in (its own
  `getRootNode()` chain, outermost first, `isShadowRoot`), while that
  root's host is what is on top: asked of the portal's own tree alone,
  Firefox answers for a shadow root with the topmost element of that tree
  whatever the page draws over it, and under a page's header the toolbar
  in a shadow root was written 46 times (R14-RV2-3); and read off the
  answer instead (`top.shadowRoot`), a closed root names nothing to
  follow, the toolbar in one was never found, and the drag stopped a line
  short under it (R14-RV3-2). The point asked is pulled into the host's box and
  into the part of it that can be seen (`#aimInHost`: the host's own
  window, an iframe mount's frame, cut by the client box of each scroller
  that clips the editor, inside its border and as it is drawn
  (`drawnClientBox`) -- for the line past the
  block's own edge too; not by the pages around an iframe mount, where
  the frame's hit test answers all the same): a drag
  carried past the window's edge through a block taller than the window
  was asked for below the window, where nothing answers, and its range
  stood still while the page scrolled on, [23,698] for [23,1658]
  (R14-RV1-2); pulled into the window only, the same drag past the edge
  of a pane or a dialog that scrolls the editor was asked for in text
  the pane had clipped away, and past the first or the last block's own
  edge for a line out of sight: the range stood still, and so, a miss
  not scrolling, did the pane, 24 to 93px in (R14-RV2-2). A scroller's
  client sizes are its own layout pixels and its bounding box the
  window's: one function carries the first into the second
  (`drawnClientBox`, by the ratio of the drawn box to the layout box --
  up and down, the drawn height to the layout height, so a pane drawn
  only taller or only wider is measured right), and every reader of
  "what the pane shows" goes through it: `#aimInHost`, `#revealBox`, and
  `#visibleBand`, which the toolbars' "on screen" and `#tallerThanBand`
  ask -- cut by the border box, a word scrolled under a pane's border,
  out of sight, kept its format toolbar drawn beside nothing (round 14,
  review 4) -- and `#frameBand`, its part for the panes of the pages
  around an iframe mount, where the same word under the border of a
  pane holding the frame kept its toolbar too. Added unscaled, a pane
  under `scale(1.5)` or a `zoom` counted its lower third as out of
  sight: a press beside the text there
  placed the caret one to four lines above the pointer and scrolled the
  pane for a caret that was on screen, and drawn smaller the edge was
  past the pane's own and the drag froze there again (R14-RV3-1,
  R14-RV3-5). `#revealBox` scrolls by the distance in the scroller's own
  pixels and carries the box outward by what that moved as drawn. A miss
  that is not the portals' -- something of the page's own drawn over the
  text, a sticky bar -- leaves the range exactly as it was drawn: drawn
  again to the caret found last (`TextDrag.lastFocus`: under the pointer,
  or, for a drag a peer's update has just given back, the far end of the
  range as it was carried, which for a word or a paragraph is a caret
  naming the unit at that end; forgotten when the drag leaves for other
  blocks), since the browser's own drag, where the press began one, goes
  on moving it under the bar -- from the anchor it reports, so WebKit's
  in a shadow root released [14,23] for [23,38] -- and never collapsed to
  the anchor, which let go of everything the drag had selected ([23,32]
  released [32,32], R14-FX-1). The browsers' own drags differ there:
  Chromium's and Safari's read the text under the bar, and Firefox's in a
  shadow root, while in a plain page it leaves the range. And while that
  hit test misses, the edge autoscroll stands still (`TextDrag.missed`,
  `#runAutoScroll`): under a page's fixed header at the window's edge the
  page scrolled on, 900 to 1,800px in 700 ms, away from a range that
  could not follow (R14-RV1-3); the next move that finds a caret starts
  it again. The reader's own DOM-first edit (`#handleInput`; it is in
  the drag's host, where the selection is, so no host is asked for)
  ends a drag the editor is drawing, as a letter typed over its range
  does through `#applyBlocks`: the anchor and the caret found last are
  places in the text as it was, and a Backspace mid-drag left the next
  move drawing [18,32] from a caret at 26 (R14-RV1-4); never the
  browser's own drag. That rule alone does not stand in for the first: with
  nothing asked past the toolbar, a drag carried onto the blank line in
  one move stopped a line short in every engine. A paragraph unit at
  offset 0 starts at 0 (`farUnit`): `lastIndexOf('\n', -1)` clamps and
  found the break opening "\nalpha", and the drag lost the blank first line
  (R14-PTR-4).
  Left to the browser, the stale range swallowed the press and the next key
  (R13-RV10-PTR-3), and from the link editor Firefox put the caret at the
  start of the block pressed, where Backspace merged it into the block
  above (R13-RV10-PTR-4). A read-only view keeps the browser's own Shift:
  its blocks are no hosts, and the native extension across them is
  promoted to a block selection -- a Shift+click's at the release, a
  Shift+arrow's at its `selectionchange`, every block it reaches -- from
  a range in a block's text. With none, the Shift press is a plain one there too
  (`#handleRootMouseDown`): a selection of the editor's own that is in
  no block -- the caret WebKit keeps in the root after a block selection
  focused it -- is taken out before the browser's default action. Left,
  WebKit's Shift+click extended from it, and the release left 1,073
  characters from the root to the block pressed, beside no block
  selection, which the next Shift+arrow grew on past the editor; Chromium
  and Firefox extend from nothing (round 14, review 3). A range of the
  page's own, outside the root, is the page's and is left to it. Where the editor draws by
  character, its caret-from-point rounding can differ from Chromium's drag
  by one character with the pointer exactly at a glyph's midpoint, as the
  base drawing does. Drawn once more at the release, since WebKit's own
  move undoes the drawing before the frame that redraws it, and
  by the same unit whenever the editor draws the drag, a drag back from
  another block too. A host the update did not touch keeps the browser's
  own drag, and the editor's ends as for any new document. A drag held at a
  scroll edge scrolls (`#followPointer`, on animation frames, since a
  resting pointer sends no moves) -- a text drag back over its own
  block included, since stopping there stranded the page with the anchor's
  neighbours off-screen; every way the gesture ends stops that too. What
  scrolls is `#autoScrollTarget`'s choice along `#scrollTargets`, nearest
  first, with each scroller's bands at the edges of the part of it on
  screen: an exhausted scroller hands on to the next one out, and one whose
  own edge is out of sight lets an outer one go first. `<body>` is in the
  chain only when it scrolls itself, i.e. when the root element's overflow
  is not `visible`. The chain ends at the outermost same-origin page:
  `#scrollTargets` walks out through frames, correcting the pointer for the
  frame moving under it. A press that lands inside an edge band does not
  scroll until the pointer moves past it towards that edge.

- **Touch has no hover, so nothing hover-revealed is reachable by it.** The
  gutter is offered on touch `pointerdown` instead, and a long press stands in
  for the click-to-select the mouse gets. The tap's compatibility `click` is
  hit-tested after the gutter is drawn, so it landed on the `+` the same tap
  had just revealed: `Gutter.markRevealedByPress` makes that click a no-op --
  marked only by a press that really drew the controls, revealing them or
  moving them under the finger (`Gutter.showFor` answers which; never "the
  block they already point at", whose drawn offset a resize or the text typed
  above can have made stale), and dying with its gesture: the next pointerdown
  anywhere and `pointercancel` clear it. Outliving its tap, it swallowed a
  later tap just off the visible `+` that WebKit retargets onto it. Anything new that reveals on hover
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
  focus, because the pointer is placing it itself. Leaving by keyboard is the
  same choice: `#handleDocumentFocusIn` closes a dialog when focus _arrives_
  outside it. Where focus lands, not where it left: Tab off the end of the page
  and a window switch both blur with no `relatedTarget`, and only the first is
  leaving. An iframe mount's own document hears nothing of the page around
  the frame, so the same two events are also listened to on every
  same-origin document above it (`#outerDocuments`), ignoring those aimed at
  the frame element itself, which is how focus comes back in. They also hide
  the format and table toolbars, which come back on focus-in
  (`#handleToolbarFocusIn`); the format toolbar is drawn only while its
  range's host holds focus (a range can be put there from outside: Firefox's
  Quick Find selects its match with focus left in the find bar, and the
  toolbar was drawn over the page; its own buttons keep focus in the host,
  since the portal cancels their mousedown), and the table toolbar only while
  its cell holds focus, or while it holds focus itself -- F10 (unmodified only:
  Shift+F10 is the context menu) draws it for its cell and moves focus in,
  noting the cell's selection so Escape can put it back (`#activeCell.selection`),
  and while it is operated a scroll still re-places it against that cell --
  even once the cell is out of sight, since hiding it would drop its focus on
  the page and a scroll is not a choice of where to go (the focused dialogs
  follow their anchor the same way). With only the caret in the cell it is
  the format toolbar's sibling instead: hidden once the cell leaves the
  screen (`#onScreen`, which clips against every scroller that clips the
  editor -- `#visibleBand`, the climb (`clipChainOf`, through the flat
  tree) stopping after a top-layer (`:modal`, `:popover-open`) ancestor,
  since the pane around a modal dialog clips nothing inside it, and after a
  `position: fixed` one fixed to the window -- but going on from a fixed or
  an absolute one's containing block (`containingBlockOf`: the browser's
  `offsetParent`, which a `transform`, `filter`, `will-change`, `contain`
  and the like make an ancestor of a fixed box, and which skips a scroller
  that is no containing block of an absolute one; `offsetParent` never
  names an element in a shadow tree the box is slotted into, so those are
  asked by their style, and `<body>`, which it reports for an absolute box
  with no positioned ancestor, is one only when it is a containing block
  itself) -- and the window, and in an iframe mount the windows of the
  pages around the frame and every scroller there that clips the frame (a
  frame in a scrolling pane of the page: `#frameBand`), carried through
  each frame's offset and drawn scale (`frameMapping`, read as `liftAnchor`
  reads it, composed by `framesAround`; a frame whose window is not its
  content box is skipped rather than guessed, and `#revealBox` steps out
  through the same mapping), not just the nearest; drag auto-scroll still
  takes every scroller, `#scrollTargets`, whose boxes in the pages around
  a frame map in by the same mapping, as does the pointer the frame moves
  under), drawn again when a scroll brings the
  cell back with the caret still in it (`#tableToolbarScrolledAway`) -- and
  hidden while the format toolbar is drawn for a range, in every engine, so a
  range has one toolbar and F10 is the keyboard's way to the other. F10 with
  any of the cell out of sight brings it to the middle of its nearest scroller
  that clips it first (`#centreInScroller`, measured: `scrollIntoView({ block:
'center' })` centred it in every ancestor and moved the page) and reveals the
  rest nearest -- and only reveals it when the clip climb ends at a window-fixed
  or top-layer panel with no scroller inside it, whose pane behind it moved
  while the cell stayed. A cell taller than the visible band is never wholly
  on screen, so there the selection is judged instead (`#tallSelectionView`):
  a caret wholly on screen, or a range any of which is, moves nothing (a range
  taller than the window is never wholly on screen either), and otherwise the
  caret, or the range's focus end, is centred -- never the cell's middle. A
  caret's own box is not to be trusted at a line start -- Chromium gives one
  on an empty line none, Firefox gives one just after any line break a box on
  the line above -- so `selectionBox` measures a caret by the character at
  its offset, the line break included (every engine draws that on the
  caret's own line), then the trailing filler `<br>`, and only then its own
  box -- except at a soft wrap, where the caret may be drawn at the end of
  the upper line (a click right of a line's end) and the character at its
  offset is on the lower one: there both are measured (`selectionBoxes`).
  The toolbar is anchored clear of both lines, and the slash menu and format
  toolbar stay while either is on screen. The browser is asked which only by
  the keys that move the caret or bring it into view -- the arrows, and F10
  and the Escape back from its toolbar (`#tallSelectionView`, which judges
  the caret by the line it is drawn on; judged by either, one drawn on the
  line just out of sight never came back while the other showed, and F10
  notes the side so that Escape puts the caret back on it, `placeCaretOnLine`:
  set by offset it is drawn on the lower line, and a caret on the window's
  last line scrolled 400px). Never from `selectionchange`, a scroll or a
  pointer: its `Selection.modify` moves the caret, and asked from the
  `selectionchange` that draws the toolbar it reset the column the browser
  keeps for ↑/↓ (Shift+↓ after ↑ stopped short) and Firefox scrolled the
  page on a triple-click. Without that, F10 fell back to the cell and scrolled the caret away;
  estimated from the text before a run of blank lines, by the glyph's height
  rather than the line's, it drifted 6px a line. The Escape back from the
  toolbar judges the restored selection the same way instead of revealing the
  whole cell (which lined up the cell's edge), and takes the selection out
  before its `focus()`, which WebKit otherwise reveals whatever
  `preventScroll` says. The toolbar's anchor, the row, gives way to the
  caret's line -- a range's when it fits, else its focus end's -- when the row
  is taller than the band. The room the table needs above or below is
  measured where the toolbar can be drawn (`#drawArea`) -- the visual
  viewport of the page it is drawn in, cut by the pages around that page
  (`#frameBand`), never by a scroller around the editor, which does not clip
  a portal (measured inside one, a table filling a pane got a row's toolbar
  over its own rows) -- in the frame's pixels, through the frame's offset and
  the scale it is drawn at, so the toolbar's own height and gap, measured in
  the page it is drawn in, are carried in at that scale (compared unscaled,
  a frame at `scale(0.5)` anchored a toolbar to a table it had no room
  beside, and the clamp drew it over the caret's row), and asked exactly as
  `positionPortal` asks, the toolbar and its gap with no margin (`#tableToolbarRoom`,
  which `#placeAfterBreak` leaves over the caret's line too) -- and measured in an iframe mount's own window, a row
  taller than the page's window but not the frame's anchored a toolbar drawn
  below the page's window. Every portal chooses the side of its anchor by
  what the pages around the page it is drawn in show of it (`setAnchorBand`,
  `#frameBand(drawnIn)`), not by its own viewport, the frame's window: a
  toolbar above a range near the top of a pane around the frame was drawn
  where the pane hides it. A portal a `portalContainer` puts in the page
  around the frame is `position: fixed` there, drawn over that page's panes
  and the frame alike, so neither cuts its band (cut by the pane, a slash
  menu went below its caret and past the window). The band chooses the side and nothing
  else: where neither side fits, the side more of it shows (above only where
  that does not cross the viewport's top), against the anchor and clamped to
  the portal's own viewport -- clamped into the band, a 320px slash menu
  with 200px of the frame on screen covered its own caret and hid the
  option Enter applies. The slash
  menu and the format toolbar are judged the same way, by their caret or
  range (`#selectionOnScreen`), never by a block that can outsize the window.
  A line break the editor writes into the model itself -- Enter in a cell or
  a code block, Shift+Enter -- places the caret through `#placeAfterBreak`,
  which in a host taller than the band reveals the caret's line the least
  way (`#revealBox`, with room over it for the table toolbar) instead of the
  host: `block: 'nearest'` does nothing for an element that covers the
  window, and with the host's top on screen it lined that top up.
  Leaving it
  is heard on the toolbar's own `focusout`
  (`#handleToolbarFocusOut`), since the root's has already run; focus going
  back into a shadow-mounted cell from a portal in the body is retargeted to
  the host, reads as leaving, and the cell's own focus-in draws the toolbar
  again. A host's `setDocument` closes every panel without moving focus, and
  one that held focus leaves it on the page, outside the editor, on purpose:
  the keys still on their way were meant for the panel, and handed back to
  the block with the panel's range selected they overwrote the document (a
  URL typed into the link editor replaced the text it was for). A selection
  one of the editor's own panels left in a host goes too, before anything
  reads it, since WebKit types into it with focus on `<body>`, and the
  panel's control is blurred, since WebKit leaves focus on a hidden button.
  Only the editor's own panels: a host's own toolbar button holds focus while
  it acts on the reader's selection, and dropping the selection for any focus
  outside the editor made it bold nothing. Formatting armed at the caret
  (`#pending`) survives while its block keeps its id and its text (its cell's,
  in a table); a caret that moved ends it through `selectionchange`. Toolbars for a caret or a range that survived in the host
  still holding focus are drawn again -- only one that was showing, and the
  format toolbar only while its range is on screen: re-synced from the
  selection alone, the toolbar Escape had dismissed came back with every
  peer's update, and Escape never got past it to the way out. That draw is
  the only one (`#redrawToolbars`, which `setEditable(true)` asks the same
  way, with the toolbars showing at the lock): a selection the editor writes
  back itself -- the carry, the unlock -- is noted (`#ownSelection`), and
  neither the `selectionchange` that write queues nor the focus it gives the
  host draws anything for it. Answered as the reader's, they drew the
  dismissed toolbar again after every peer's edit to the reader's _own_
  block, and drew one at the window's edge for a range scrolled or pushed
  out of sight (R13-PTR-1, -2). The note stands for exactly one event --
  every write measured causes one `selectionchange` in every engine, in
  place, into a replaced host, an unlock in the same task or later -- and
  the first one handled spends it, matching or not; an edit, an undo or a
  redo (`#applyBlocks`) and a caret the editor places (`#placeFocus`) end
  it too, should a write's event ever not come (none measured). Kept until the selection changed, it
  outlived its event and swallowed the toolbar for the range an undo after
  ⌘B restored (R13-RV-PTR-1). And a write is never noted over a change of
  the reader's still on its way: `#handleSelectionChange` records what each
  event found (`#handledSelection`), and a live selection that differs from
  it before the write (`#selectionChangePending`) is the reader's move,
  whose event the browser coalesces with the write's -- noted, the toolbar
  for a range the reader had just made never came (R13-RV-PTR-2). A lock
  with such a change pending counts the toolbar as showing. The editor's own
  writes and the lock's own change of the selection count as handled
  (`#selectionHandledHere`), so a second update in the same task, or WebKit
  dropping the selection when the lock blurs the block, is not taken for
  the reader. Only the document's own events are answered: Chromium fires
  `selectionchange` at an `<input>` or `<textarea>` whose value script sets
  (Firefox and WebKit at one the reader types in), it bubbles to the
  document, and taken for the reader's it drew the dismissed toolbar when a
  page updated a title, or spent a carry's note before the write's own event
  (R13-RV2-PTR-1). Every engine fires the editor's own at the document, in
  every mount; a field inside the editor's own shadow root is the exception:
  Chromium dispatches its events at the document too, a known limit. A
  `portalContainer` in the page around a frame puts the portals in an outer
  document, where those listeners hear them: an event on a portal is the
  editor's own (`#onOwnPortal`), never "outside". The other half
  is that
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
  covers read-only: the image trigger is `disabled` there rather than left as a
  tab stop that answers with silence, and an empty image's "Add an image"
  button is not drawn at all, because a disabled prompt is still an authoring
  prompt.

- **A newline at the end of a block has no line box of its own.** Under
  `white-space: pre-wrap` the last break ends the last line and there is nothing
  after it to fill another, so Shift+Enter (and Enter in a table cell) left the
  block exactly the same height and the next character landed _in front of_ the
  break. `renderRichText` appends a trailing `<br>` as filler. It is safe to add
  because the parse side already treats a trailing `<br>` as the browser's own
  filler and reads it back as nothing — which is also why each block's runs must
  keep being parsed with that block's own element as the root, or a following
  paragraph would turn the filler into a second newline. Only a render adds
  the filler, and typing is DOM-first, so the browser can take it out again:
  Firefox's word and line deletions did, and the next character landed in front
  of the break. `#handleInput` puts it back (`restoreTrailingFiller`) after any
  deletion that leaves the block ending in a newline, appended after every
  boundary a caret can name so the caret stays where the browser left it.

- **Safari's selection does not see into a shadow root, in either direction.**
  There is no `ShadowRoot.getSelection`, the document's selection is retargeted
  to the host's parent, and `addRange` with a range inside the shadow tree is
  dropped without a word — the next keystroke with it. So every caret read
  goes through `readSelection` (which falls back to `getComposedRanges` --
  a composed range has no direction, so the selection's own is asked, and
  where that says "none", as WebKit's does for a selection a mouse made,
  the reading is marked `undirected`: its anchor is only the range's
  start, and a caller that needs the true one asks something else, as
  `#anchorEndOf` asks the press -- and
  reads a selection whose ends the page cannot touch -- Firefox's Quick Find
  keeps it in the find bar -- as none, rather than throwing from
  `selectionchange`, and clamps an offset past its node's end to that end:
  WebKit went on reporting `DIV:4` after a render left the block one child,
  and `setDocument` threw `IndexSizeError` after drawing, as did every
  keystroke after it -- and writes the clamped position back only into a
  host that holds focus in its own tree: setting a selection inside a
  contenteditable focuses it in every engine, and a peer's `setDocument`
  pulled focus from a page button or the table toolbar into the block the
  reader had left, where their typing landed; `offsetOf` clamps too, for any caller's offset), and
  every caret write goes through `setBaseAndExtent` -- `setSelectionRange`, or
  the writable view `selectionFor` returns. Never read
  `document.getSelection()` or call `addRange` directly.

- **Hover must not rebuild what it hovers.** Chromium and WebKit answer a node
  replaced under a resting pointer with another `mouseenter`, so a hover
  handler that re-renders its own list loops several times a second, and a
  click never lands because the element under the press is gone before the
  release. The slash menu's options are highlighted in place.

- **A clipboard event may not be aimed at the element holding focus.** Block
  selection deliberately leaves nothing selected on the page, and Firefox then
  dispatches copy and cut to `<body>`. `#handleDocumentClipboard` answers for
  the root, but only while the root holds focus and its own listener has not
  already taken the event.

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
  The region is text in the root, so a range drawn in the page across the
  editor took in its last sentence and Chromium's Mod+C copied it: it is
  `user-select: none` -- except while `data-selecting` makes the blocks'
  text unselectable, when it is the one place in the editor WebKit's own
  caret under a held drag can go. Unselectable then too, that caret went to
  the page after the editor or a second editor's first block, and a
  read-only Shift+click extended from there over every block (round 14).

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

- **A fix generalised past its evidence takes away the case that was already
  right.** "text/plain is Markdown when we wrote it" became "prefer the parsed
  text wherever there is HTML", which broke pasting from every other
  application. The same shape appears in the emit removed because it fired
  twice, in the composition flag cleared whether or not its host had gone, and
  in `role="group"` written wherever there was no role attribute. Fix the case
  you measured; check what the wider rule costs before taking it.

- **The change nobody asked for is the one to review hardest.** The read-only
  toggle expansion came from a finding one of its two verifiers called "not a
  defect at any severity". It was built anyway, on the strength of the
  underlying complaint, and it produced three of the sixteen regressions in a
  23-commit range — more than any other single change.

- **A test written from a paraphrase measures the paraphrase.** The undo-after-
  composition test placed no caret, so it measured a composition that began in
  the block it was comparing against; the caret-after-undo test used a delete
  where the finding used a move, and the delete restores a caret of its own.
  Both passed with their fix reverted. Take the literal scenario from the
  finding, then mutate the fix and watch the test fail.

- **Ask whether the environment can even observe the thing.** happy-dom does not
  implement the newline-after-`<pre>` rule, keeps a selection in an element
  regardless of focus, and computes no layout. Where the test environment cannot
  see the defect, pin the artifact — the emitted markup, the declaration file,
  the stylesheet text — and say in the test why that is what is being asserted.

- **The complement of a hand-written list is unbounded.** Naming the elements
  that _do_ have an implicit ARIA role, so as to skip them, stamped `role="group"`
  onto every tag absent from the set — `<td>`, `<dd>`, `<p>`, `<summary>` —
  destroying real semantics on each. Naming the generic ones instead had
  withheld it from custom elements. A rule has to state its own predicate;
  "everything except this list I thought of" is not one.

- **Call a check exact only when it cannot be satisfied by accident.**
  `toMarkdown(parsed) === plain` was described in its own commit message as
  "exact rather than a guess". With no HTML in the payload, `parsed` comes from
  parsing that same plain text, so the comparison is a round trip against itself
  and true for anything Markdown-shaped. The test that should have caught it
  asserted the right invariant with an input that happened not to exercise it.

- **Read content where it stands, then cut the parse.** A run of pasted inline
  content holding pictures is read in one parse, each picture written as an
  `IMAGE_ATOM`, and split at the atoms afterwards; a heading's or quote's own
  text drops the lines its pictures stood on alone the same way. It used to be
  copied out piece by piece around each picture, and every piece lost a
  neighbour the walk judges it by -- its table cell, inline box, flex item,
  `white-space`, the comment beside it -- so the same words read apart without
  the picture and together with it. Four review rounds patched one lost
  neighbour each and exposed the next. A sentinel the walk writes into text
  (`\uFDD0`–`\uFDD7`) must be one `collapseWhitespace` escapes, and every
  reader of it must tell the text's own character from the sentinel.

- **Write the test before the fix when the fix is a retry.** Three attempts on
  the code-block paste rule and three on the mount role each shipped a new
  defect. On the fourth the tests were written first from the findings' literal
  inputs: nineteen failed, the fixes made them pass, and reverting each fix
  failed them again. That is the order that would have stopped attempts two and
  three.
