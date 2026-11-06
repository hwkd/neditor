# Whole-package audit of @neditor/core and the demo, 6 Nov

What was audited: the whole of `packages/neditor` and `apps/web` at `13f18fe` on
`fix/browser-sweep` — function, accessibility, security, performance, lifecycle,
the public API and types, documentation, and visuals. Sources of truth were
`AGENTS.md`, `packages/neditor/README.md` and the intent comments in the code.

Each round paired read-only code auditors with runtime evidence from real
engines: Chromium 156, Firefox 155 and WebKit 26.5 driven by Playwright with
real keyboard, mouse, clipboard and touch-gesture input; axe-core 4.14; a
random-input fuzzer checking model/DOM agreement, depth, id uniqueness and the
selection-mode invariant after every action, then a full undo back to the seed;
large-document timing; and listener/DOM leak counts across mount and destroy.

Left out: real Android/iOS devices (touch was emulated through Chromium's
gesture pipeline), Safari 16.x (only WebKit 26.5 was available), screen readers
(accessibility trees and axe only).

## Round 1

Five auditors (editing core; parsing and security; UI and accessibility;
lifecycle, API and performance; docs against code) plus the runtime probes.
Fixes were made test-first and mutation-checked, by the lead and two fix agents
on disjoint file sets.

| Id                     | Pri | Surface             | What happened                                                                                                                                                                                                                                                                                        | State |
| ---------------------- | --- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| PARSE-1                | P0  | Paste/drop          | Pasted HTML ran script: nodes cloned out of the inert template were adopted into the live document, where an `<img>`/`<video>` loads and its `onerror` runs. Confirmed in Chromium and WebKit. Foreign HTML is now parsed in an inert `createHTMLDocument('')` and every scratch node is made there. | Fixed |
| PARSE-2                | P1  | Markdown reader     | Two label regexes backtracked exponentially; a ~90-character plain-text paste could hang the tab for minutes. Branches made disjoint.                                                                                                                                                                | Fixed |
| R7                     | P1  | Block selection     | A Tab that could not indent moved focus into a block while the block selection stayed live, so the next key replaced the block's text. Found by the WebKit fuzzer, reproduced in all three engines. The selection now ends first.                                                                    | Fixed |
| EDIT-1                 | P1  | Enter               | Enter at the start of a heading turned its text into a paragraph; on a checked to-do the check stayed with the empty line. The block now keeps id, type and payload and an empty line opens above.                                                                                                   | Fixed |
| A11Y-1 / EDIT-2        | P1  | Block delete        | Deleting a selection whose neighbour was a divider or hidden child left the editor in neither mode; even Cmd+Z did nothing. Focus now goes to the nearest visible block that can hold a caret, else that neighbour is block-selected.                                                                | Fixed |
| R1                     | P2  | Forced colours      | Selected blocks went blank: Chromium's readability backplate (white) behind inherited HighlightText (white). Descendants now opt out with explicit system colours.                                                                                                                                   | Fixed |
| R4                     | P2  | Slash menu a11y     | The block became `role="combobox"` with no accessible name (axe). It borrows the menu's label while open.                                                                                                                                                                                            | Fixed |
| EDIT-3                 | P2  | Undo                | Undoing a block-selection edit put the caret in the first block and scrolled to the top. History entries now record the block selection and undo restores it.                                                                                                                                        | Fixed |
| EDIT-4                 | P2  | Slash menu          | ` /` in a code block or image caption opened the menu; Enter turned code into a paragraph and deleted an image's picture. The menu no longer opens there.                                                                                                                                            | Fixed |
| EDIT-5 / LIFE-1        | P2  | Read-only           | `setEditable(false)` left the slash menu open and it still edited. It closes, and the command checks `#canEdit()`.                                                                                                                                                                                   | Fixed |
| LIFE-2                 | P2  | Read-only           | A drag in flight when `setEditable(false)` ran still moved blocks; a long press still selected. Both end on the switch; the drop commit checks `#canEdit()`.                                                                                                                                         | Fixed |
| EDIT-6 / DOCS-1        | P2  | Gutter +            | The new paragraph went between a parent and its children; a collapsed toggle's hidden children came out from under it. It goes after the subtree.                                                                                                                                                    | Fixed |
| EDIT-7                 | P2  | Backspace           | Backspace-outdent of a collapsed toggle left its hidden children behind, nested out of sight. Expands like Shift+Tab.                                                                                                                                                                                | Fixed |
| EDIT-8                 | P2  | Tables              | Cmd+Shift+Arrow in a cell moved the caret to the header cell. Restored through the resolved host.                                                                                                                                                                                                    | Fixed |
| EDIT-9                 | P2  | API                 | `setBlockType(p, 'divider')` and table→paragraph deleted the text. Divider opens a paragraph for it; a table's cells are flattened into text.                                                                                                                                                        | Fixed |
| LIFE-3                 | P2  | Events              | Every IME candidate fired `change` (four events for a cancelled composition). One per composition, none when cancelled.                                                                                                                                                                              | Fixed |
| LIFE-4                 | P2  | Table toolbar       | Did not follow a scroll and floated over other content. Re-placed on scroll.                                                                                                                                                                                                                         | Fixed |
| A11Y-2                 | P2  | RTL tables          | "Insert column left" inserted on the right in an RTL table. Swapped by the table's direction.                                                                                                                                                                                                        | Fixed |
| A11Y-3                 | P2  | Dialogs a11y        | The URL error was read on every open and the real rejection was silent. Described only when invalid, announced with `role="alert"`.                                                                                                                                                                  | Fixed |
| A11Y-4 / DOCS-2        | P2  | Contrast            | Error text 4.26:1; placeholder on the code tint 4.46:1; inline code in a callout 4.49:1 (README claims all ≥4.5). Tokens darkened, tests cover every ground.                                                                                                                                         | Fixed |
| A11Y-5                 | P2  | Slash menu          | The highlighted command was a 1.1:1 tint. Accent outline.                                                                                                                                                                                                                                            | Fixed |
| A11Y-6                 | P2  | Read-only           | Authoring placeholders shown to readers and in accessible names. Scoped to editable hosts.                                                                                                                                                                                                           | Fixed |
| DOCS-3                 | P2  | Docs                | README's Safari 16.4 floor implied shadow-root mounts work there; they need `getComposedRanges` (Safari 17). Documented.                                                                                                                                                                             | Fixed |
| PARSE-3                | P2  | Paste perf          | Quadratic walk over empty block children (88 KB took 7.7 s). Last-content node found once.                                                                                                                                                                                                           | Fixed |
| PARSE-4                | P2  | Markdown perf       | `…*$` regexes quadratic on long runs. Back-scans.                                                                                                                                                                                                                                                    | Fixed |
| PARSE-5                | P2  | Markdown            | `__init__` inside a link destination came back as `init`; typing a URL fired emphasis. Destinations are literal in the reader.                                                                                                                                                                       | Fixed |
| PARSE-6                | P2  | HTML round trip     | An empty parent list item vanished and its child lost its depth. An empty item in a list we wrote (`data-neditor-list`) is now read back as a block of its own.                                                                                                                                      | Fixed |
| PARSE-7                | P2  | Markdown round trip | Leading spaces became indentation. Encoded as numeric references.                                                                                                                                                                                                                                    | Fixed |
| PARSE-8                | P2  | Markdown round trip | A newline in alt text lost the image. Written as a space (registered as a deliberate known failure: the break cannot survive).                                                                                                                                                                       | Fixed |
| EDIT-10                | P3  | Code blocks         | A merge into a code block kept marks the model drops on save. Stripped.                                                                                                                                                                                                                              | Fixed |
| EDIT-11                | P3  | History             | Re-applying the link already there banked an undo step. Equal content is not committed; docstring corrected.                                                                                                                                                                                         | Fixed |
| EDIT-12                | P3  | Announcements       | `setBlockType` announced a change for an unknown id or the same type.                                                                                                                                                                                                                                | Fixed |
| LIFE-5                 | P3  | Options             | `historyLimit: NaN` kept every entry. NaN falls back to the default (the "0.5 keeps zero" part did not hold: `Math.max(1, 0.5)` keeps one).                                                                                                                                                          | Fixed |
| LIFE-6                 | P3  | destroy             | Left `data-neditor-theme` and an empty `class`; `setEditable` worked after destroy.                                                                                                                                                                                                                  | Fixed |
| LIFE-7                 | P3  | Emitter             | A throwing `onError` escaped into the edit and skipped the `history` event.                                                                                                                                                                                                                          | Fixed |
| LIFE-8                 | P3  | Perf                | The document was deep-cloned per keystroke with no `change` listener.                                                                                                                                                                                                                                | Fixed |
| LIFE-9 / DOCS-6        | P3  | README              | `setDocument(doc, {silent})`, `off`, `element`, `editable`, and several shortcuts and rules were undocumented.                                                                                                                                                                                       | Fixed |
| DOCS-4 / DOCS-5        | P3  | AGENTS.md           | Two lines contradicted the code (where hidden-descendant expansion happens; where portals are appended).                                                                                                                                                                                             | Fixed |
| DOCS-7                 | P3  | Docs                | With text selected, leaving takes three Escapes, not two. Documented.                                                                                                                                                                                                                                | Fixed |
| DOCS-8                 | P3  | Input rules         | `***` became a divider at once, so `***bold italic***` could not start a paragraph. Waits for a space.                                                                                                                                                                                               | Fixed |
| DOCS-9                 | P3  | Events              | `blockselection` ids were in call order, not document order.                                                                                                                                                                                                                                         | Fixed |
| DOCS-10 / DOCS-11 / R6 | P3  | Demo                | Tabs lacked the tabs pattern; panels were unfocusable scroll regions; muted text 3.1–4.3:1.                                                                                                                                                                                                          | Fixed |
| DOCS-12 / DOCS-13      | P3  | Demo                | ⌘-only shortcut copy on Windows/Linux; the Undo button lost focus to the editor when pressed from the keyboard.                                                                                                                                                                                      | Fixed |
| DOCS-14                | P3  | Comments            | `hasFocus` docstrings named swatches the dialogs do not have.                                                                                                                                                                                                                                        | Fixed |
| PARSE-9                | P3  | Inline rules        | `<u>**u**</u>` lost its bold: the delimiter offset came from `indexOf`.                                                                                                                                                                                                                              | Fixed |
| PARSE-10               | P3  | Round trip          | An empty image placeholder came back as a paragraph or literal `![]()`.                                                                                                                                                                                                                              | Fixed |
| PARSE-11               | P3  | Tests               | The round-trip suite ignored `collapsed`.                                                                                                                                                                                                                                                            | Fixed |
| R2                     | P3  | Forced colours      | Callouts and code blocks lost their only edge.                                                                                                                                                                                                                                                       | Fixed |
| R3                     | P3  | RTL                 | Code (block and inline) was laid out RTL, reordering its punctuation. LTR isolates.                                                                                                                                                                                                                  | Fixed |
| R5                     | P3  | Table toolbar a11y  | "⤫ col" was not in its name "Delete this column" (2.5.3). Glyph is "⤫ column".                                                                                                                                                                                                                       | Fixed |
| A11Y-7                 | P3  | Read-only           | The callout icon stayed an enabled tab stop that did nothing. Disabled.                                                                                                                                                                                                                              | Fixed |
| A11Y-8                 | P3  | RTL gutter          | Mirroring keyed off `[dir]` attributes put the handle over the text in nested-direction pages. Logical margin.                                                                                                                                                                                       | Fixed |
| A11Y-9                 | P3  | RTL portals         | Portals ignored the editor's direction. `dir` copied on focus; arrow roving and alignment follow it.                                                                                                                                                                                                 | Fixed |
| A11Y-10                | P3  | Non-text contrast   | Pressed toolbar state was hue only; input borders 1.2–1.4:1.                                                                                                                                                                                                                                         | Fixed |
| N1                     | P3  | Link dialog         | The error was squeezed between the input and Apply and clipped. Wraps to its own line.                                                                                                                                                                                                               | Fixed |
| N2                     | P3  | Ids                 | Two copies of the package on one page produced duplicate ids. Counters live on `globalThis` under a registered symbol.                                                                                                                                                                               | Fixed |
| N3                     | P3  | RTL                 | Callout padding was a physical shorthand. Logical.                                                                                                                                                                                                                                                   | Fixed |

Checked and found clean in round 1: 17 of 18 fuzz runs (8 Chromium, 6 Firefox,
3 WebKit, 100–150 random actions each) broke no invariant and undid back to the
seed exactly; no listener, portal, style or live-region leak across 50
mount/destroy cycles or a destroy with a popover open; typing latency stays
10–15 ms at 5,000 blocks and structural edits grow linearly (~40 ms at 5,000);
sanitizeUrl and sanitizeImageUrl against scheme, control-character and
protocol-relative tricks; 9,000 random HTML round trips; destroy's 24
listener pairs; packaging and exports; dark-theme contrast; reduced motion;
320 px layout. Harness artefacts that were not editor bugs are noted in the
session log (macOS End scrolls the page; headless Firefox focus and
off-window release; WebKit test-shell crashes and Backspace-navigates).

## Round 2

Four fresh auditors on round 1's fixes (the working tree against `13f18fe`):
editor fixes; parser fixes and security; UI and styles with real-browser and
axe probes; docs and comments. Fixed test-first and mutation-checked by the
lead and two fix agents on disjoint file sets.

| Id                    | Pri | Surface         | What happened                                                                                                                                                                                                                                                                                                                                                                                              | State                                                         |
| --------------------- | --- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| R2-EDIT-1 / R2-DOCS-1 | P2  | API             | `setBlockType(table, 'divider')` still lost every cell: EDIT-9 flattened tables for every target except divider. Flattened first, then the divider's paragraph receives it.                                                                                                                                                                                                                                | Fixed                                                         |
| R2-DOCS-2             | P2  | Keyboard        | After R7, a no-op Tab from a block selection left focus on the root, so the browser's Tab went to the first block of the document (Shift+Tab out of the editor). The caret now goes back into the selected block first; verified in Chromium and Firefox that it lands where Tab from text would.                                                                                                          | Fixed                                                         |
| R2-EDIT-2             | P2  | Selection modes | R7 closed only the Tab route: focus returning to a block any other way (Tab back in, a host's `.focus()`) kept the selection live and Backspace deleted the selected block under a caret elsewhere. `#handleFocusIn` ends it, except while a drag or long press is setting it.                                                                                                                             | Fixed                                                         |
| R2-EDIT-3             | P2  | Hidden blocks   | Deleting or merging a block right after a collapsed toggle's subtree tucked that block's children under the toggle, out of sight. Removal paths now open a collapsed toggle that would hide a block that was visible (the `#splitBlock` precedent).                                                                                                                                                        | Fixed                                                         |
| R2-UI-1               | P2  | Contrast        | Inside a selected block the tints stack: inline code in a selected callout 3.92:1 dark (axe, all three engines), placeholders in selected code blocks 4.27:1 / 3.92:1. Tests cover the selected grounds; tokens retuned; axe now 0 in all engines.                                                                                                                                                         | Fixed                                                         |
| R2-PARSE-1            | P2  | Markdown        | PARSE-7 skipped line breaks: a block beginning with a line break lost it and the whitespace after it; `"\n"` alone vanished. Leading breaks are written as `&#10;`.                                                                                                                                                                                                                                        | Fixed                                                         |
| R2-EDIT-4             | P3  | API             | Same-type `setBlockType` no longer ended block selection (generalised past EDIT-12's evidence). It skips the commit but still places the caret.                                                                                                                                                                                                                                                            | Fixed                                                         |
| R2-EDIT-5             | P3  | Undo            | A restored block selection lost its anchor, so Shift+Arrow grew it the wrong way. The anchor is recorded and restored.                                                                                                                                                                                                                                                                                     | Fixed                                                         |
| R2-EDIT-6             | P3  | Announcements   | When the delete fallback selected a neighbour, its count announcement replaced "Block deleted". Announced last.                                                                                                                                                                                                                                                                                            | Fixed                                                         |
| R2-EDIT-7             | P3  | Events          | LIFE-3's comparison read the block captured before the final sync. Judged by the committed block.                                                                                                                                                                                                                                                                                                          | Fixed                                                         |
| R2-EDIT-8 / R2-DOCS-3 | P3  | Public docs     | `contentFor` sat between the `NEditor` docstring and the class, so the emitted `.d.ts` lost the class comment. Moved.                                                                                                                                                                                                                                                                                      | Fixed                                                         |
| R2-EDIT-9 / R2-DOCS-4 | P3  | Tests           | The NaN limit test passed with its fix reverted (30 edits, under the default); the floor test could not fail; a header claimed every test failed first. Rewritten (210 edits), the floor and its test removed, header made accurate; mutation-checked.                                                                                                                                                     | Fixed                                                         |
| R2-DOCS-5             | P3  | Comments / API  | A stale `#travel` comment contradicted the code beneath it; `editable` reported true after `destroy()`.                                                                                                                                                                                                                                                                                                    | Fixed                                                         |
| R2-DOCS-6             | P3  | Audit log       | The PARSE-6 row described a write-side change that was really a read-side one.                                                                                                                                                                                                                                                                                                                             | Fixed                                                         |
| R2-DOCS-nits          | P3  | README          | The three-Escape note now says it applies only when the toolbar shows; the read-only paragraph names the callout icon.                                                                                                                                                                                                                                                                                     | Fixed                                                         |
| R2-UI-2               | P3  | RTL             | A11Y-9 gave the dialogs `dir=rtl`, so URL fields bidi-reordered (`?https://…`). URL inputs are `dir=ltr`.                                                                                                                                                                                                                                                                                                  | Fixed                                                         |
| R2-UI-3               | P3  | Link dialog     | N1's wrap pushed Remove to a second line at 320px. The input grows from a zero basis; verified 320–1280px at 16 and 20px root sizes.                                                                                                                                                                                                                                                                       | Fixed                                                         |
| R2-UI-4               | P3  | Dialogs a11y    | From the Apply button, the error was spoken twice (focus + description, and the alert). The alert fires only when the field already had focus; a separate hidden live region carries it.                                                                                                                                                                                                                   | Fixed                                                         |
| R2-UI-5               | P3  | RTL             | A direction flip while focused was not followed until the next focus. Re-read as each portal opens.                                                                                                                                                                                                                                                                                                        | Fixed                                                         |
| R2-UI-6               | P3  | Forced colours  | "Add an image" had no edge (the sibling R2 missed).                                                                                                                                                                                                                                                                                                                                                        | Fixed                                                         |
| R2-UI-7               | P3  | Demo            | The panels' focus ring was clipped by the inspector's overflow. Inset ring.                                                                                                                                                                                                                                                                                                                                | Fixed                                                         |
| R2-UI-8               | P3  | Gutter          | The handle sat short of the text by the mount's own padding (20 px in the demo): the inset is measured from the root's padding edge. Added.                                                                                                                                                                                                                                                                | Fixed                                                         |
| R2-PARSE-2            | P3  | Docs            | The reader decodes leading `&#N;` whitespace references in any Markdown (needed for the round trip; CommonMark agrees). Documented in the README.                                                                                                                                                                                                                                                          | Fixed                                                         |
| R2-PARSE-3            | P3  | Inline rules    | The literal-destination test was looser than the link patterns: code spans containing `[x](` lost formatting, closed labels still counted, an unclosed `](<` silenced formatting for 2000 characters. Now exactly what a link could still close; on the paste path a lookahead checks the angled form closes. While typing an unclosed `](<` stays open by design (nobody knows yet whether `>)` follows). | Fixed                                                         |
| R2-PARSE-4            | P3  | HTML reader     | Query-based branches read `<noscript>` content (a figure's caption and image, a toggle's summary, a quote's list). Filtered through `SKIP_TAGS`. A `<tr>` inside `<noscript>` inside a table is not fixable here: the browser's own parser closes the noscript before the row, so the row is really a row.                                                                                                 | Partly fixed (table case is the HTML parser's tree, not ours) |
| R2-N1                 | P3  | Markdown        | A block ending in a line break or spaces loses them in Markdown. CommonMark itself drops both; registered as documented gaps beside "empty paragraph", documented in the README; JSON and HTML keep them.                                                                                                                                                                                                  | Won't fix (documented Markdown limitation)                    |

Checked and found clean in round 2: no foreign-content path to live behaviour
across 41 paste shapes and 84 parser-level loading variants in three engines;
the `&#N;` encoding for every `\s` character; the PARSE-3 flag and all new
loops grow linearly; 12k random HTML round trips; forced colours for every
selected block type; gutter alignment at depth 0–3 in LTR, RTL, CSS-only RTL
and nested-direction pages at four gutter widths; code isolates; RTL portal
alignment at 1280 and 320 px; read-only placeholders across `setEditable` and
`setDocument`; the demo tabs pattern; every other round-1 README and AGENTS.md
claim. One wall-clock test ("nested spans over one stretch stay under a
second") failed once under load average 31; alone it runs 700–850 ms against a
658–683 ms baseline at `13f18fe`, which also spiked past the budget once — load,
not a regression.

## Round 3

Three fresh auditors (editor, UI and docs, parser) reviewed the round-2 fixes by
function and rule, with real-browser probes in all three engines. 19 findings.

| Id         | Pri | Surface         | What happened                                                                                                                                                                                                                                                      | State |
| ---------- | --- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| R3-EDIT-1  | P2  | Long press      | The browser's own long-press focus landed in the block after the timer selected it, so a soft keyboard's `insertText` replaced the native word selection while the block stayed selected: both modes at once. That focus now hands the text side back to the root. | Fixed |
| R3-EDIT-2  | P2  | Drag            | After a handle drag, focus sat on the handle with the blocks selected: Escape could not leave and Cmd+Z could not undo the move. `#endDrag` puts focus back on the root after an active drag.                                                                      | Fixed |
| R3-EDIT-3  | P2  | Hidden blocks   | Moving a block up past a collapsed toggle handed its children into the toggle, where they vanished. Every delete, merge and move commit now goes through `keepVisible`, which opens such a toggle.                                                                 | Fixed |
| R3-EDIT-4  | P3  | Keyboard        | Tab out of a block selection assumed every block takes a caret at its end; a divider or table did not. The exit walks back to the nearest block that can, a table's last cell included.                                                                            | Fixed |
| R3-EDIT-5  | P3  | Type conversion | Converting a table flattened empty cells into runs of whitespace. Empty cells are skipped.                                                                                                                                                                         | Fixed |
| R3-EDIT-6  | P3  | Announcements   | Deleting a block whose fallback selects a neighbour spoke the neighbour, then overwrote it at once with the deletion. One combined announcement.                                                                                                                   | Fixed |
| R3-UI-1    | P3  | RTL             | R2-UI-2's `dir=ltr` on URL fields put a right-to-left placeholder on the wrong side. The field is LTR only while it holds a value.                                                                                                                                 | Fixed |
| R3-UI-2    | P3  | Contrast        | The pressed toolbar glyph on its hover tint was 4.14:1, against the README's AA claim. The light accent is darker (5.26:1 on white, 4.73:1 on the tint).                                                                                                           | Fixed |
| R3-UI-3    | P3  | Read-only       | An empty image in a read-only editor still drew a disabled "Add an image" prompt. Not drawn there.                                                                                                                                                                 | Fixed |
| R3-UI-4    | P3  | Markdown        | A block ending in a hard break or spaces wrote markup that came back as something else. `trimBlockEnd` drops them (still a documented gap: Markdown cannot hold them).                                                                                             | Fixed |
| R3-UI-5    | P3  | AGENTS.md       | The portal-direction sentence still said "on focus" only. Updated.                                                                                                                                                                                                 | Fixed |
| R3-CODE    | P3  | Markdown        | Code-span content was backslash-escaped, which CommonMark shows literally to every other reader. Written literally inside a fence longer than any backtick run; the reader finds spans up front with `codeSpans`. AGENTS.md updated.                               | Fixed |
| R3-PARSE-1 | P2  | HTML paste perf | `queryContent`'s fallback was cubic on nested `<details>` over a `<noscript>` full of summaries (ratio 104). Replaced by memoised `firstSummary`/`firstCaption`.                                                                                                   | Fixed |
| R3-PARSE-2 | P3  | Inline rules    | `closesLabel` treated the `[` before `[]` as opening the label, unlike the link rule. Now the last `[`; 0 disagreements over 597,870 fuzzed strings.                                                                                                               | Fixed |
| R3-PARSE-3 | P3  | Tests           | Three mutants of the angled-destination logic survived. Three tests added, each kills its mutant.                                                                                                                                                                  | Fixed |
| R3-PARSE-4 | P3  | Markdown paste  | A pasted plain `](` that never closes silenced the marks after it. The paste lookahead covers the plain form too; typing still holds it open.                                                                                                                      | Fixed |
| R3-PARSE-5 | P2  | Markdown paste  | Backslash-escaped characters in a link destination became `%00` (`Mercury_\(planet\)`). Read literally; the writer now escapes backslashes in destinations so they round-trip.                                                                                     | Fixed |
| R3-PARSE-6 | P3  | Inline perf     | The "linear" claim failed on long lines where no rule fires (1.8 s on 240k chars). `retire` folds when nothing is parked; 0.4 s, growth test added.                                                                                                                | Fixed |
| R3-PARSE-7 | P3  | HTML reader     | A `<details>` with no summary took a nested toggle's. The summary search stops at a nested `<details>`.                                                                                                                                                            | Fixed |

Left as they were, pre-existing and outside this round's scope: a table cell
ending in a newline writes a hard break; backslash escapes in an image `src`
are not resolved; a code span inside a link destination keeps its backslashes.
Checked and found clean in round 3: long press, drag, Escape and undo after a
drag, Tab out of dividers and tables, and moves past collapsed toggles in three
engines; RTL placeholders; the accent on every light pairing; read-only images;
every new parser loop's growth.

## Round 4

Three fresh auditors (editor, UI and docs, parser) reviewed the round-3 fixes,
with mutation runs against copies of the source and real-browser probes. 10
findings, 9 distinct (R4-UI-1 is R4-EDIT-2 reached from an empty block).

| Id                  | Pri | Surface         | What happened                                                                                                                                                                                                                                                                              | State                                                                                 |
| ------------------- | --- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| R4-EDIT-1           | P2  | Hidden blocks   | Tab after a collapsed toggle made the block its child and hid it; the focus that followed could not land, leaving the editor in neither mode. Shift+Tab and Backspace-outdent on a nested collapsed toggle hid its next sibling. All three indent commits go through `keepVisible`.        | Fixed                                                                                 |
| R4-EDIT-2 / R4-UI-1 | P2  | Paste           | A pasted collapsed toggle (any FAQ accordion copied from the web) landed in front of the target's children, which vanished into it — over a block selection, into text, or into an empty block. Both paste commits go through `keepVisible`; the toggle's own pasted children stay folded. | Fixed                                                                                 |
| R4-EDIT-3           | P3  | Tests           | Two `keepVisible` call sites (drag commit, Delete removing a divider) survived mutation. Pinned, each test fails with its wrap removed.                                                                                                                                                    | Fixed                                                                                 |
| R4-PARSE-1          | P2  | Markdown        | A backtick in a link's query opened a code span that swallowed the link's `)` once any later backtick appeared on the line. The writer escapes `` ` `` in destinations. The reader is right as it is: CommonMark gives code spans precedence over links (its own example is pinned).       | Fixed (writer); reader fixed in round 5 (R5-PARSE-4 reversed the "Not a bug" verdict) |
| R4-PARSE-2          | P2  | HTML paste perf | A wrapped `<summary>` cloned the whole `<details>` at every level: 500 levels took 3.1 s. The summary is detached from the inert tree instead, and the four memoised answers about its ancestors are forgotten. 3008 generated cases unchanged; growth test added.                         | Fixed                                                                                 |
| R4-PARSE-3          | P3  | Tests           | The `richToMarkdown` map fix and two `codeSpans` rules (no line crossing, all-space padding) had no test. Added, each mutation-checked.                                                                                                                                                    | Fixed                                                                                 |
| R4-PARSE-4          | P3  | README          | The reason given for the `<…>` destination form had been made false by R3-PARSE-5. Restated, with the escapes now written.                                                                                                                                                                 | Fixed                                                                                 |
| R4-PARSE-5          | P3  | Comment         | The `firstDescendant` docstring named two memoised questions; there are four.                                                                                                                                                                                                              | Fixed                                                                                 |
| R4-PARSE-6          | P3  | Markdown table  | A `\|` in a link destination inside a table cell split the row and lost the link. Written `\|` in cells; the round-trip `shape()` now compares cell marks and links too.                                                                                                                   | Fixed                                                                                 |

Checked and found clean in round 4: the long-press and drag focus fixes for
table cells, to-dos and captions; `#focusForTabExit` from every block kind;
table flattening; the combined delete announcement; URL field direction in
RTL and `dir="auto"` mounts; every accent pairing and README contrast figure;
read-only images; `trimBlockEnd` over 26 cases; the `retire` fold (0
differences against a no-fold copy over 1,900 lines); every round-3 sentence
in AGENTS.md and the README. Verified in Chromium, Firefox and WebKit: Tab in
text and block mode into a collapsed toggle opens it and keeps focus or
selection, undo folds it again; a pasted collapsed toggle leaves the next
block on screen.

## Round 5

Two fresh auditors (editor, parser) reviewed the round-4 fixes, with mutation
runs on copies of the source. 10 findings; most were older defects in the code
the fixes touched, and one reversed a round-4 verdict.

| Id         | Pri | Surface                 | What happened                                                                                                                                                                                                                                                                                                                                                                                                                                       | State |
| ---------- | --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| R5-EDIT-1  | P2  | Paste                   | `keepVisible` protected only ids the reader could already see, but a paste moves the text after the caret into the last pasted block -- a fresh id, and the caret's destination. Pasting an FAQ into the middle of a paragraph folded the rest of it out of sight; into an empty last paragraph, focus could not land (BODY, keys ignored). `keepVisible` takes `alsoShow` ids; the paste passes its last block.                                    | Fixed |
| R5-EDIT-2  | P2  | Typing over a selection | Typing over a selection either side of a collapsed toggle hid the later block's child; Delete over the same selection did not. Goes through `keepVisible`.                                                                                                                                                                                                                                                                                          | Fixed |
| R5-EDIT-3  | P2  | Duplicate               | Cmd+D on a gapped selection inserted a copied collapsed toggle in front of the last block's later siblings, which folded into it. Goes through `keepVisible`.                                                                                                                                                                                                                                                                                       | Fixed |
| R5-EDIT-4  | P2  | Keyboard exit           | Shift+Tab on a collapsed toggle at depth 0 left the toggle but outdented its hidden children (each was clamped on its own), so the guaranteed exit was swallowed and the toggle emptied. `indentTargets` drops an anchor that cannot move together with what it hides; selected visible children still move on their own (the model's existing contract, pinned by `blocks.test.ts`). Pre-existing at `13f18fe`.                                    | Fixed |
| R5-EDIT-5  | P3  | Tests                   | No test pinned `keepVisible` opening nested toggles. Pinned.                                                                                                                                                                                                                                                                                                                                                                                        | Fixed |
| R5-PARSE-1 | P2  | Markdown links          | `[call](<mailto:a@x.test?subject=Re:%20(draft)>)` -- the writer's own output -- came back as an `https://` link to the address's domain with `>)` in the text: the plain rule accepted a destination starting with `<`. CommonMark's never does; nor does ours now. Pre-existing.                                                                                                                                                                   | Fixed |
| R5-PARSE-2 | P2  | Markdown images         | A pasted base64 image wrapped across lines kept the newline in `src`, was written `%0A`, and the reader then refused it: the image became a paragraph of base64. `sanitizeImageUrl` strips ASCII whitespace from base64 data URLs. README's "written as it is" and "faithful in both formats" corrected (the caption is HTML-only). Pre-existing.                                                                                                   | Fixed |
| R5-PARSE-3 | P3  | Tests                   | Only one of `detachSummary`'s four memo invalidations was pinned. The block-level one is now; the summary and caption ones are unobservable today and say so.                                                                                                                                                                                                                                                                                       | Fixed |
| R5-PARSE-4 | P3  | Markdown reader         | Round 4 called the reader right to open a code span at a backtick inside a link destination, citing an example whose backtick is in the link text. CommonMark parses the destination at `]` first, so it is a link. The reader now finds spans as each run is reached (`codeSpanFinder`) and skips runs inside a closing destination. This exposed an older quadratic in the destination callback (318 ms at 20k links), fixed; growth tests added. | Fixed |
| R5-PARSE-5 | P3  | Comments                | Three comments still described the cloned `<details>` body or claimed `sanitizeUrl` had already encoded `<`/`>`. Corrected, and AGENTS.md's code-span sentence updated.                                                                                                                                                                                                                                                                             | Fixed |

Left alone, outside the measured case: `toMarkdown` on a hand-built `src`
holding a newline (never normalised) still writes `%0A`; a non-ASCII space in a
data URL passes the safety pattern unstripped. Checked and found clean in round
5: undo/redo of every round-4 path in one step with the fold restored; the
husk removal; nested toggles opening inner first; setBlockType, slash and input
rules, `+`, cut, multi-block drag, setDocument and toggleCollapsed; detachSummary
mutates only the inert tree and grows linearly; every destination escape in
paragraphs and cells; 4,000 fuzzed destinations with mailto, `#` and relative
URLs. Verified in Chromium, Firefox and WebKit: Shift+Tab on a collapsed
depth-0 toggle changes nothing and moves focus on; an FAQ pasted mid-heading
leaves the rest of the heading on screen with the caret in it.

## Round 6

Two fresh auditors (editor, parser) reviewed the round-5 fixes, with mutation
runs on copies of the source. 5 findings.

| Id         | Pri | Surface             | What happened                                                                                                                                                                                                                                                                                                                                                                                                                                                   | State |
| ---------- | --- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| R6-EDIT-1  | P2  | Tab / keyboard exit | `indentTargets` asked only "can this go below 0", so for Tab it never dropped an anchor: Tab on a collapsed toggle with nothing to nest under staircased its hidden answers one press at a time, each press swallowed and an undo step nobody could see. It now asks the clamp itself (indent the anchors alone, keep those that moved). Pre-existing at `13f18fe`.                                                                                             | Fixed |
| R6-EDIT-2  | P3  | Duplicate           | The copy of a block that followed a collapsed toggle could land inside the toggle's collapsed copy, hidden and dropped from the new selection, depending on whether anything followed it. The copies of what the reader selected are passed as `alsoShow`.                                                                                                                                                                                                      | Fixed |
| R6-EDIT-3  | P2  | Paste into a toggle | Lines pasted into a collapsed toggle's summary landed between the toggle and its hidden answers, which then showed under the pasted text while the toggle was left empty. Paste now nests under a toggle or callout as Enter does, and the toggle opens on the pasted lines. Pre-existing.                                                                                                                                                                      | Fixed |
| R6-PARSE-1 | P2  | Markdown links      | Regression from R5-PARSE-1: once the plain rule stopped matching at the outer `[`, it searched on to an inner `[foo](https://y.test/)` inside a bracketed destination, so `[see](<https://x.test/?q=[foo](https://y.test/)>)` -- the writer's own output -- came back pointing at `?q=foo`. A plain link inside a still-open bracketed destination is skipped; typing holds it as it holds marks. The old test passed only because `sanitizeUrl` refuses `bar`. | Fixed |
| R6-PARSE-2 | P3  | Comments            | Two test comments still said this reader pairs code spans before links. Restated.                                                                                                                                                                                                                                                                                                                                                                               | Fixed |

Checked and found clean in round 6: `keepVisible` with multi-level pasted
toggles, a replaced target, a divider, table or image as the last block, and
one-step undo; type-over needs no `alsoShow`; Shift+Tab on mixed selections
and deeper hidden children; Backspace-outdent; both exits; `codeSpanFinder`
against CommonMark over 30+ inputs; 16 adversarial shapes grow linearly;
`sanitizeImageUrl` (svg refused, non-base64 refused, upper-case `BASE64`,
idempotent) and all its callers; the README image and Markdown sections.
Link-heavy lines still grow linearly after R6-PARSE-1 (8x input, 4.5-9.3x
time). Verified in Chromium and WebKit: two lines pasted into a collapsed
toggle's summary nest under it and open it, its answers stay its children, and
one undo restores the fold; in all three engines a duplicated collapsed toggle
is on screen and selected.

## Round 7

Two fresh auditors (editor, parser) reviewed the round-6 fixes. 5 findings:
older defects in the paths round 6 touched, except that round 6's nesting made
part of R7-EDIT-1 worse and R6-PARSE-1's skip caused the link half of
R7-PARSE-1 (none of R7-PARSE-1 occurs at `13f18fe`); the parser auditor found no
P2.

| Id         | Pri | Surface                       | What happened                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | State |
| ---------- | --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| R7-EDIT-1  | P2  | Paste at the start of a block | A table, image or divider pasted at offset 0 moved the block's text into a fresh block and deleted the original as a husk: a heading became a paragraph, a to-do lost its check, a callout its icon, a collapsed toggle its fold (exposing its answers). Round 6's nesting then indented the result under an unrelated block. It now goes in front and leaves the block exactly as it was, as Enter does. All four losses pre-existing at `13f18fe`; the nesting under an unrelated block came from round 6. | Fixed |
| R7-EDIT-2  | P2  | Paste over a toggle           | Selecting a collapsed toggle's whole summary and pasting a list item, a heading or two lines replaced the toggle, and its answers showed under the replacement; the leftover `collapsed` then hid them again if it was turned back into a toggle. A toggle or callout is never replaced or removed as a husk -- the paste merges into its text and nests the rest -- and a replaced block keeps none of its old type's fields. Pre-existing.                                                                 | Fixed |
| R7-EDIT-3  | P3  | Tab at the depth ceiling      | A collapsed toggle at depth 31 could go to 32 but its hidden child could not, so Tab pulled the child out of the fold beside it. `indentTargets` also asks whether the hidden children can shift. Pre-existing.                                                                                                                                                                                                                                                                                              | Fixed |
| R7-PARSE-1 | P3  | Typing after inline code      | Typing passed code text to the rules raw, so a `](<` inside a code run held every later link and mark on the line open, where pasting the same Markdown formatted them. Typing now projects code runs as the reader does.                                                                                                                                                                                                                                                                                    | Fixed |
| R7-PARSE-2 | P3  | Comment                       | Two merged paragraphs said the link pattern "can only start at" the computed `[`, but it searches forward from it -- which is what the round-6 skip guards. Restated, with a note not to anchor it.                                                                                                                                                                                                                                                                                                          | Fixed |

Checked and found clean in round 7: `indentTargets` on multi-anchor and
dependent selections, the first block, MAX depth anchors, mixed toggles, and
text/block agreement (0 `change` events for every no-op); the duplicate's
index mapping; paste into callouts and open toggles at every position, single
lines, drop; the round-6 parser skip against nested and multiple inner pairs,
bracketed destinations that never close, the 2000-character window, escapes,
code in labels, tables and images, with linear growth and a 4,000-case
round-trip fuzz at zero failures. One full-suite run during this round had two
failures that did not recur on two reruns (load average 15; the wall-clock
growth tests); recorded as passed on retry. Verified in Chromium and WebKit: a
table pasted at the start of a collapsed toggle goes in front of it and the
toggle keeps its fold, answers and caret; a list item pasted over the whole
summary leaves a toggle. In all three engines, a link and bold typed after
inline code holding `](<` form.

## Round 8

Two fresh auditors: one on the round-7 editor fixes, one cross-checking every
documentation claim, the audit log and the public type surface against the
code. 5 findings, all P3; no defect in any round-7 fix.

| Id        | Pri | Surface   | What happened                                                                                                                                                                                                                                                                       | State              |
| --------- | --- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| R8-EDIT-1 | P3  | Tests     | Removing the `destination` callback from typing's code-projected match passed the suite; without it a link typed through a code run lost the run's text from its URL. Pinned.                                                                                                       | Fixed              |
| R8-EDIT-2 | P3  | Tests     | The offset-0 paste branch's relative depths and caret offset were unpinned: flattening the nesting or moving the caret to 1 passed. Pinned with a nested list after a divider and an offset assertion.                                                                              | Fixed              |
| R8-DOCS-1 | P3  | Comments  | Three docstrings in `inline-rules.ts` still said typing never goes through `matchInlineRuleAhead` or needs `destination`. Restated; two public docstrings no longer `{@link}` unexported symbols.                                                                                   | Fixed              |
| R8-DOCS-2 | P3  | README    | The new list of what Markdown cannot carry left out table-cell edges: whitespace or a break at either end of a cell is dropped, and a break inside one is written in a form only this reader rejoins. Added; the tables sentence is qualified. Behaviour unchanged since `13f18fe`. | Fixed (documented) |
| R8-DOCS-3 | P3  | Audit log | The round-7 intro called all five findings older defects; part of R7-EDIT-1 came from round 6. Corrected.                                                                                                                                                                           | Fixed              |

Also fixed while here: the wall-clock test "nested spans over one stretch stay
under a second" failed repeatedly on a loaded machine with nothing wrong. It is
now a growth test (8x nesting, best of three, bound 20): the current parser
measures 7-10, the parser before `0dcfc8f` measures 33. The fuzzer's WebKit
Backspace guard (a harness, not the editor) let a Backspace on the editor's own
checkbox button reach WebKit's test-shell "go back"; seed 81 failed that way
and passes with the guard fixed.

Checked and found clean in round 8: every round-7 fix fails its test when
mutated; the offset-0 paste branch over selections, image captions, a pasted
collapsed toggle in front, undo and redo; replace and husk rules for toggles
and callouts; the replace branch keeps every field the editor relies on; the
ceiling filter on nested toggles; `projectCode` offsets in table cells and
across line breaks. Public types are identical in their exports to `13f18fe`
apart from the documented optional `HistoryEntry` fields; no internal symbol
leaks. Every README contrast figure and every probed README and AGENTS.md
claim holds; every State column still holds.

## Round 9

One fresh auditor reviewed the round-8 changes (tests, docstrings, README
limits, the log and the growth test), with mutation runs and CPU-time
benchmarks. 3 findings, all P3; none a behaviour defect.

| Id   | Pri | Surface   | What happened                                                                                                                                                                                                                                                                                                                                                     | State |
| ---- | --- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| R9-1 | P3  | Tests     | Deleting the offset-0 paste branch's `focus` call passed: a collapsed caret at 0 survives the render unaided. Pinned with a selection that starts at 0 (`getSelectionState()` was `null` without the call).                                                                                                                                                       | Fixed |
| R9-2 | P3  | Audit log | The corrected round-7 intro still missed that R6-PARSE-1's skip caused the link half of R7-PARSE-1. Restated.                                                                                                                                                                                                                                                     | Fixed |
| R9-3 | P3  | Docs      | `parseInlineMarkdown`'s docstring and the README said paste and typing "cannot diverge"; they deliberately differ where a link destination never closes on the line, which only the reader can see. Restated in both. Never true: escapes already diverged at `13f18fe`, and round 2's lookahead and round 5's code-span pass widened it (completed in round 10). | Fixed |

Checked and found clean in round 9: every round-8 test asserts what its title
says and fails under its mutant; the growth test's shape is the original
finding's, and in CPU time the current parser measures 3.5-10.6 against 27-35
for the parser before `0dcfc8f`, so the bound of 20 separates them -- in wall
time at load 38-51 neither side is reliable, which is what failed in round 8;
the `LineAhead` docstrings match both callers; the README table-cell limits
match the writer and reader exactly, unchanged since `13f18fe`.

## Round 10

One fresh auditor reviewed the round-9 changes, with a 49-input corpus typed
DOM-first and compared against the Markdown reader. 2 findings, both P3, both
documentation; no behaviour defect.

| Id    | Pri | Surface   | What happened                                                                                                                                                                                                                                                                                                                                                                                                                                                               | State |
| ----- | --- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| R10-1 | P3  | Docs      | The restated parity claim still named one difference between pasting and typing; there are three. Code spans (a paste reads them as CommonMark does; typed `*a*` inside backticks is italic before the closing backtick) and backslash escapes (honoured on paste, literal when typed) were missing, and the docstring contradicted its own next paragraph. All three are named in the README and the docstring. Typing's behaviour is the documented design, not a defect. | Fixed |
| R10-2 | P3  | Audit log | R9-3 said the claim was "stale since round 2"; it was never true, since escapes already diverged at `13f18fe`. Restated. While here, the R7-EDIT-1 row now says all four losses were pre-existing, as the auditor measured.                                                                                                                                                                                                                                                 | Fixed |

Checked and found clean in round 10: the round-9 test asserts its title and
fails when the `focus` call is deleted or moved (only the default-argument form
is an equivalent mutant); 41 of the 49 corpus inputs type and paste
identically -- every mark, `***a***`, angled links, links with marks, code
inside emphasis and in labels, a backtick in a destination, unclosed
delimiters, flanking cases, unsafe URLs -- and `blocksFromMarkdown` agrees with
`parseInlineMarkdown` on all 49; the round-7 intro and round-9 table are
accurate.

## Stopping

The skill's limit is ten rounds, and round 10 still found two items, so the loop
stops here rather than at a clean round. Findings per round went
**57 → 26 → 19 → 9 → 10 → 5 → 5 → 5 → 3 → 2**. From round 8 on, every finding
was P3, and none was a defect in the previous round's code: they were tests
that a mutation slipped past, and sentences in comments, the README or this log
that a fix had made incomplete. That is what keeps coming back, and why: the
rationale for this package lives in prose (AGENTS.md says so), and each fix
moves a sentence somewhere -- a docstring, the README, a log row -- which the
next auditor then holds to the code. The P2 behaviour defects stopped at round
7: the hidden-block family (`keepVisible`, `indentTargets`, paste into toggles)
took rounds 3-7 to close because each fix exposed a sibling path, and the
Markdown destination and code-span contract took rounds 3-6.

## Final checks, 6 Nov

- **Format, lint and types** (`vp run ready`): all 85 files formatted; no
  warnings, lint errors or type errors in 74 files. `astro check` on the demo:
  0 errors, 0 warnings, 0 hints. Declaration checks: a consumer can name every
  public type, and the model entry compiles with no DOM lib.
- **Unit tests**: `@neditor/core` 37 files, 2023 tests, all passing (1637 at
  the end of round 3). Wall-clock and growth-ratio tests failed in two runs
  while an unrelated process held the shared machine at load 30-42; each passed
  on rerun at lower load, and the one stopwatch test is now a growth test.
- **Browser tests** (Playwright, real Chromium, Firefox and WebKit, against
  the built package in the demo): core flows 29/29 in Chromium and Firefox,
  12/12 in WebKit; feature suites 33 + 19, 33 + 17, 33 + 17 with no failures;
  touch 6/6 (Chromium mobile emulation); 5/5 XSS paste shapes run no handler in
  Chromium and WebKit; 8 seeded 100-150-step fuzz runs end with no invariant
  broken and undo restoring the seed (WebKit seed 91 printed nothing on its
  first run and passed on retry); axe 0 violations; every round 4-7 probe
  passes. One probe hung once under load and passed on rerun.
- **Seen running**: the demo at 1280 x 900 and 390 x 844 (2x, touch), no
  horizontal overflow and no console errors at either size.
- **Not tested**: real Safari and real iOS/Android devices (WebKit and
  Chromium emulation only); real screen readers (accessibility was checked
  through axe, the accessibility tree and live-region text, not by listening);
  real IME and soft keyboards (CDP composition and `insertText` only); the OS
  clipboard (pastes were synthetic `DataTransfer` events, which Firefox
  ignores, so Firefox paste was checked in happy-dom only); Windows High
  Contrast on real hardware (forced colours emulated).

## For the owner

- **Behaviour changes to know about**: lines pasted into a toggle's or a
  callout's own text now become its children, as Enter makes them; a table,
  image or divider pasted at the start of a block goes in front and leaves the
  block untouched; a toggle or callout is never replaced by a paste; editing
  next to a collapsed toggle opens it rather than hiding the block. All are in
  the README and AGENTS.md.
- **Markdown limits, documented rather than fixed**: an empty paragraph,
  whitespace or a break at the end of a block, and whitespace or a break at
  either end of a table cell do not survive Markdown; a break inside a cell is
  written in a form only this reader rejoins. JSON and HTML keep all of them.
- **Growth tests on loaded machines**: they compare the code against itself on
  a smaller input, which is robust to steady load but not to a machine at load 40. If CI runners are that busy, measuring `process.cpuUsage()` instead of
  wall time would make them immune.
- `.claude/launch.json` (the demo's port moved to 4399 for this session) is
  left uncommitted, as asked earlier.
