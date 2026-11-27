# Changelog

## Unreleased

Found by the end-to-end suite (`apps/e2e`, `docs/e2e-progress.md`) and its audits. Behaviour
that changes what you store or what other applications receive is listed first.

### Added

- **Math.** Inline formulas (a run carrying `math: '<TeX>'`, one atom of offset)
  and display equations (the `math` block type), typed as `$…$` and `$$`,
  picked from the slash menu, or opened with `Mod+Shift+E` /
  `openMathEditor()`. The document stores TeX only; drawing it is the host's,
  through the new `renderMath` option (KaTeX in the demo), and without one the
  TeX is shown as source. See the README's Math section for the serialization
  and its limits.

  New exports: `MATH_ATOM`, `isMathRun`, `richMath`, `richToSourceText`,
  `isLiteralType`, and the types `MathRenderer`, `MathRenderOptions` and
  `RenderOptions`; a new method, `openMathEditor()`; a **∑** button on the
  selection toolbar.

### Changed output

- **Stored Markdown: `$…$` now reads as a formula.** Earlier versions wrote
  `$` bare, so text saved by them that fits the inline rule -- `$x$`, or
  `a $b c$ d` -- loads as a formula and is saved that way. A price range
  (`$5-$10`) does not: a closing `$` followed by a digit closes nothing.
- **Markdown: a `$` in text is written `\$`**, because `$…$` is now a
  formula -- in `toMarkdown` and so in the `text/plain` of every block copy,
  which other applications receive. `\$` is read as a literal `$` (before,
  the backslash was kept). Inside a backtick code span `$` is still written
  bare. A digit right after a formula is written as a numeric reference
  (`$x$&#50;`).
- **HTML (`blocksToHtml`, and the `text/html` of a copy):** a formula is
  `<span data-neditor-math="TeX">$TeX$</span>`, an equation
  `<div data-neditor-math-block="TeX">$$TeX$$</div>`. Copying a text range
  that holds a formula now writes this too, instead of the browser's copy of
  what the renderer drew.
- **`--neditor-danger`** is `rgb(174 44 39)` in the light theme, darkened from
  `rgb(212 76 71)`, and `rgb(255 165 158)` in the dark one, lightened from
  `rgb(255 115 105)`, so error text clears 4.5:1 on white, on the code tint
  behind an equation, and on that tint inside a selected block.

- **Markdown (`toMarkdown`, and the `text/plain` of a block copy).**
  - Whitespace and newlines at the edge of a block's text are written as
    numeric character references (`&#32;`, `&#10;`); before, they were
    dropped. Stored Markdown and plain-text pastes now contain these wherever a
    block starts or ends with whitespace.
  - A formatted run whose text starts or ends with whitespace is written as
    HTML (`a<strong>bold </strong>b`, `<em>`, `<s>`, `<code>`, `<u>`), because
    `**`, `*` and `~~` cannot hold edge whitespace; before, the whitespace was
    moved outside and lost its formatting.
  - A code run that needs escaping or holds a line break is written as
    `<code>…</code>`: other readers showed the backslashes of `` `snake\_case` ``.
  - A formatted run or link containing a line break is written as one span,
    not one per line.
  - A line break in a heading or a table cell is written `<br>`, which every
    reader renders as a break; neither may span lines, and as `\` + newline
    it ended the heading (or split the table row) in every other reader. It is
    read back as a line break; the old spelling still reads.
  - A block nested under a numbered item is indented to the item's content
    column (three spaces under `1. `, four under `10. `), and a nested code
    block's body is indented as far as its fence. Other readers ended the list
    at the first line that fell short. Markdown from earlier versions reads at
    the same depths -- or at the one it was written at, where the old reader
    took a tab at the start of a nested block's text for more indentation. A
    nested code block from them is unindented only when every line that is
    not empty starts with the fence's own indentation, which is also how
    CommonMark reads it.
  - A formatted run is also written as HTML where CommonMark's flanking rule
    would leave `**` or `*` literal: against punctuation with a letter on the
    far side (`word<strong>(x)</strong>`), around a code span next to a letter,
    `~~` around `**` next to a letter, and where two runs' delimiters would
    touch between punctuation (or as `***a****b*`, which micromark misreads,
    or `*a****b*****c**`, which CommonMark's rule of three leaves literal).
  - A bare `http://` or `https://` URL is written as an autolink,
    `<https://a.test/x_y>`. GFM links a bare URL up to the next space and took
    in whatever this writer put against it: an escape's backslash
    (`https://a.test/\~x`), a line break's, the `&#32;` of a trailing space.
    GFM's trailing punctuation stays outside the autolink. A URL holding `*`, a
    backtick, a bracket or `~~` (or `~` in struck text, or a `$` when a
    formula or a code span holding `$` follows it in the block) keeps the escaped
    spelling, as does a `www.` URL, where a `_` between two letters or digits
    is written bare; GFM readers still link those with the backslashes in.
    CommonMark readers render the autolink as a link where they showed text.
  - A formatted run written as HTML that ends a block with a line break keeps
    the break (and anything after it) inside the tag as `&#10;`; the closing tag alone on a line ended
    a list item early in micromark.
  - In a heading, a trailing run of `#` is escaped (`# a \#`): other readers
    drop it as a closing sequence. In a list item or a quote, text that opens
    with a block marker is escaped (`- 1\. x`, `> \# x`, `- \---`): other
    readers started a nested list, a heading or a rule there.
  - Named entities in the text (`&amp;`, `&copy;`) are escaped, and so is a
    `!` straight before a link, which other readers took for an image.
  - Leading spaces after a soft break are written as `&#32;`, and a line after
    one that opens with `=` is escaped, so it is not a setext heading
    underline.
  - In a link or image destination, a backslash is doubled, a `|` is written
    `\|`, a backtick `` \` ``, a `](` as `\](`, and an `&` that begins a
    reference `\&`: the first was read back as an escape, the second ended a
    table cell, two of the third closed a code span and were dropped from the
    URL, the fourth made a link (or emphasis) out of part of the URL, and other
    readers decoded the fifth.
  - A block marker at the start of a line after a soft break is escaped
    (`\# not a heading`). So are `=` and `:-` there: under a line, `===` is a
    heading underline and `:---` a GFM table's delimiter row.
- **Markdown.** An image's caption is written after the image, following a hard
  break, instead of being dropped. A caption that opens with `=` or `:-` is
  escaped (under the image line, `===` made the image a heading elsewhere and
  `:---` a table header in GFM readers). A backtick
  or `<` in its alt text (or in a callout's icon) is escaped, so other readers cannot pair it with one in the
  caption, and so are `*`, `_`, `~` and `&`, which other readers took for
  emphasis or an entity (GFM read alt `*a*` as `a`); a line break there is written as a space: written raw it split
  the image line and the image came back as two paragraphs. An image with no source yet is written
  `![alt]()` instead of being lost.
- **Markdown reader.** Numeric character references are decoded at the edges
  of a block's text, where this writer puts them, and nowhere else. `<strong>`,
  `<em>`, `<s>` and `<code>` are read as marks, as `<u>` already was -- when
  typed, too. Inline formatting may span a soft line break, typed or pasted,
  as in CommonMark. Numeric references are also decoded at the start of a line
  after a soft break, where the writer now puts them.
- **Clipboard HTML.** An image with no source is written as
  `<figure data-neditor-image>` instead of a broken `<img src="">`.
- **Touch.** A finger dragged across blocks no longer selects them (the browser
  scrolls); long press is the touch way into block selection.
- **Stored depths (`normalizeDocument`).** A depth past the 32-level limit is
  no longer cut to 32 before the tree is read, so `[0, 35, 40]` loads as
  `[0, 1, 2]` -- a collapsed toggle stored that deep keeps what it hides --
  where it loaded as `[0, 1, 1]`, and showed its child. Documents the editor
  wrote load unchanged.
- **`normalizeDepths`**, called directly, reads a depth that is not a positive
  number as the root, as `normalizeDocument` already did: a `NaN` depth made
  every block after it nest one level further, `-2` then `-1` came back a
  parent and its child, and numeric strings were compared as text.
- **Clipboard: a block copy keeps its nesting** when a later block is shallower
  than the first (`sliceDocument`, so the `text/html` and `text/plain` of a
  block copy): copying `A(2) B(3) C(1) D(2)` wrote D beside C instead of
  under it.

### Changed types

- `BlockType` has a new member, `'math'`: an exhaustive `switch` over block
  types needs a case for it.
- `NEditorLabels` has new required keys (`inlineMath`, `mathTex`,
  `mathPlaceholder`, `mathError`, `mathBlockLabel`), and `slashCommands` and
  `placeholders` gain a `math` entry. A partial object passed as `labels` is
  filled in by `resolveLabels`, so only a complete `NEditorLabels` written out
  by hand needs them.
- `TextRun` has a new optional field, `math`. `renderRichText` and
  `richToMarkdown` take a new, optional, last argument.

### Changed behaviour

- **Code blocks are literal, like equations.** The selection toolbar is not
  offered in one, `toggleMark` and `openLinkEditor` do nothing there and
  `setLink` returns `false`: marks and links in a code block were dropped
  when the document was saved.
- **A pasted code block or equation stands as a block of its own.** Pasted
  into a paragraph, its text was merged into the paragraph's.
- **Pasted at the very start of a block with text, several blocks -- or one
  that cannot merge, a table, an image, a divider, a code block or an
  equation -- go in front of it** and leave it itself: its type, id, check,
  icon and children. A last pasted block of prose at the paste's top level
  joins its text to the start of the block. The block was split at the caret
  instead and its text rebuilt as a new block: a heading lost its level, a
  checked to-do its check, both their ids, and a toggle or callout its
  children, which passed to another block. The same holds for an empty block
  with blocks nested under it, a list item or a to-do with sub-items, and for
  a table or another block that cannot merge pasted into an empty toggle or
  callout at the deepest level. Otherwise an empty toggle or callout takes
  the paste, as typed there: its first line of prose becomes the block's text
  and the rest, a table too, nests under it -- or, at the deepest level,
  follows it, as Enter there does.
- **Pasted blocks keep their own shape, from the depth of the block they land
  in** -- at the caret, at the start of a block, into an empty one or over
  selected blocks -- and lines pasted into a toggle's or a callout's own text
  become its children, as Enter makes them, opening a collapsed one. A paste
  that started nested (`<ul><ul><li>`, a drag begun in a sub-item) went in as
  a child of the block before it, inside a collapsed toggle there where
  nobody saw it, and one pasted mid-text into a collapsed toggle hid the
  reader's own text after the caret. A collapsed toggle a paste brings (a
  closed `<details>`) opens when the reader's own blocks, or the text after
  the caret, would otherwise end up hidden under it.
- **A block a paste replaces keeps none of its old type's fields**, and
  neither a block with children under it nor a toggle or callout is ever
  replaced, even with no text: pasted into an empty to-do that has sub-items,
  a table goes in front of it, and into an empty toggle, under it. A table
  that replaced an empty to-do kept `checked`, and one that replaced an empty
  toggle kept `collapsed` and took its children. A replaced block keeps its id
  and depth.

- **`Cmd`/`Ctrl`+`Shift`+arrow steps over a block together with what is nested
  under it** (`moveVisibleBlocks`), when that block is at the selection's depth
  or deeper: the moved block landed between it and its children, which then
  belonged to the moved block. A selection spanning depths is measured from its
  shallowest block, and going up it goes back to the first block at that depth
  or above. Moving past a shallower block is still one step, which is how a
  block leaves a list. A block whose parent sat in a gap of the selection stays
  with that parent, and the end of the selection that moves is brought into
  view.
- **A duplicate goes after the original's children** (`duplicateBlocks`, and
  `Cmd`/`Ctrl`+`D`), which stay the original's: it went between the block and
  its children, which went to the copy. Copies keep their own nesting from the
  selection's shallowest depth, so a list item duplicated with the heading or
  toggle after it is no longer given to that block.
- **`Tab` over a block selection indents every selected block that can**: when
  the first could not move, nothing did; now the rest go under it.
  `indentBlocks` clamps each block against the one above it as already moved,
  hands back a block it cannot move as the same object, with its children where
  they were (the first item of a nested list came back level with its child),
  and leaves a selected block put when it, or a block nested under it through
  selected blocks, would pass the 32-level limit. A collapsed toggle's hidden
  children count as selected with it, so a selected parent no longer indents
  away from such a toggle just under the limit.

### Fixed

- **Security** -- HTML paste and drop (also on earlier versions): an event
  handler on pasted or dropped markup could run, in every engine, and so could
  one in HTML a host passed to `blocksFromHtml` -- an image's, picture's or
  media element's `onload`, `onerror` or `onloadstart`, a `<details open>`'s
  `ontoggle`, and others. The markup is parsed in an inert template, but the
  reader copies what it reads into wrappers of its own -- a run cut at its
  pictures, an inline wrapper's or a container's formatting pushed into the
  blocks it holds (`<b><p>x</p><img src=… onerror></b>`) -- and it made those
  wrappers in the live document, which adopted the copies: their images and
  media were fetched at paste time, and their handlers ran whether the load
  succeeded or failed. Past that template, everything the reader builds is
  now made in a document with no browsing context, where nothing loads.
  Nothing pasted reached the document model either way.
- A link longer than the inline rules reach (about 2,000 characters, as a
  signed or tracking URL can be) came back from `toMarkdown` as its Markdown
  text, and with characters missing from its URL: `_x_` in it read as
  italic. The writer now escapes `*`, `_`, `~` and `$` in such a destination,
  so the text survives; the link itself still cannot (HTML keeps it). A link
  whose URL leaves (about) no room for any label is also no longer split at
  its label's spaces, which wrote its URL once a word and came back as all of
  those spellings; with a little room, a long label still can be (see the
  README's Inline Markdown limits).
- Applying TeX the renderer refused, from the equation popover, said
  nothing to a screen reader: the popover closed with the error only ever
  named as the field's description. A live region now announces it.
- A formula whose TeX held a `](` or an autolink opener (`$[0,1](x$)`, an
  interval in parentheses; `$a<http://b$`) closed nothing, typed or pasted,
  so the writer's own Markdown came back as text. Only a link whose `[`, or
  an autolink whose `<`, came before the formula's `$` holds it now.
- Pasted Markdown with a link whose label is a formula alone
  (`[$x$](https://a.test/)`) lost its brackets and URL, keeping only the
  formula. It is now left as written, the formula inside it.
- A paste that changed nothing -- `## `, `- ` or `> ` as plain text, each an
  empty block, pasted mid-paragraph -- still recorded an undo step and fired
  `change`.
- A `Tab` that cannot indent, pressed with blocks selected, left the block
  selected behind a visible caret, so the next key replaced the block.
- Dragging, by its handle, the block holding the caret left that caret live, so
  the next key replaced the moved block.
- A mouse click on a slash-menu command did nothing in Chromium and WebKit.
- Copy, cut and paste over a block selection did nothing in Firefox.
- In a shadow root, WebKit could not read or place the caret: Enter split at the
  start, formatting did nothing, the toolbar never showed.
- F10 from a table cell could not reach the table toolbar in WebKit.
- A link whose URL contains `_x_` or `*x*` lost those characters through
  Markdown and while typing it.
- A paragraph whose text started with `1.` and a line break came back from
  Markdown as a numbered list.
- Cmd/Ctrl+Shift+↑ put the caret at the start of the block; on a table, either
  direction sent it to the first cell.
- Keyboard or screen-reader focus moved into a block while blocks were selected
  left the blocks selected behind a visible caret, so the next key replaced
  them.
- The slash menu stayed open after arrowing back over the `/`, and its combobox
  had no accessible name. With the popovers in another tree (`portalContainer`
  outside the editor's shadow root), its `aria-controls` and
  `aria-activedescendant` pointed at nothing; they use element references
  there. Element references only cross into an ancestor tree -- an editor in a
  shadow root with its menu on the page -- so a light-DOM editor whose
  `portalContainer` is a shadow root, or one in another document, still has no
  programmatic relation to its menu.
- A text selection could be left inside a block while blocks were selected
  (WebKit drags), and a touch swipe that became a scroll could leave blocks
  selected.
- Typing a delimiter pair around text that already carried that mark
  (`**__a__**`) took the mark off again, where pasting the same characters
  kept it: inline rules set a mark rather than toggling it.
- A long formatted run of lines with no spaces (a list of paths) was written as
  one span too long for the reader to close, and came back as raw markup; it is
  split at a line break.
- Parsing a long soft-broken paragraph took time quadratic in its length, and
  so did writing a long run of spaces inside a block.
- Typing or pasting a bare URL with `_x_` in it (`https://a.test/_y_`)
  italicised the `y` and deleted the underscores. A `_` span that opens inside
  a bare URL (`http://` or `https://` anywhere in a word, or `www.` at its
  start or after `*`, `_`, `~`, `(`, `[`, `]` or, in pasted Markdown, any
  backslash-escaped character; up to the next whitespace) is no
  longer one, wherever it closes; a span that
  opens before the URL (`_see https://a.test_`) still is. The test is broader
  than GFM's autolink rule on purpose, so `http://_a_` and a link label that
  is a URL (`[https://a.test/__init__](…)`) keep their underscores where other
  readers emphasise.
- A pasted link whose destination held a backslash escape
  (`[wiki](https://en.wikipedia.org/wiki/Foo_\(bar\))`) linked to a URL with a
  NUL where the escaped character was, and an image's destination kept the
  backslash. The escape is now resolved in both, and a destination with an
  escape in its host (`[x](https://exa\_mple.test/)`), which was not read as
  a link at all, now is.
- A link in a table cell whose URL holds a `|` split the cell in two and lost
  the link.
- An image whose `data:` source was line-wrapped base64 came back from Markdown
  as a paragraph of text. `sanitizeImageUrl` now returns such a source
  unwrapped.
- A link written in the `<…>` form whose URL holds a `)` and no `https:`
  (`mailto:team@example.com?subject=Feedback%20(v2)`) was read back, and typed,
  as a link to `https://%3Cmailto:…`. A link or image destination that opens
  with `<` is only ever the angle form, and a closed one whose URL is refused
  is not a link; a `[…](` inside it that runs past its `>` is no link either
  (within the inline rules' reach of about 2,000 characters). A link written
  whole inside its URL is still read as one (see the README's nested-link
  limit).
- A carriage return in a block's text, a table cell or a caption (pasted HTML
  can carry one as `&#13;`) was written raw. Every reader takes it for a line
  break, so the block came back split, and a table came back as paragraphs. It
  is written as the line break it is read as -- in a code block too, where one
  ending the text used to take the last line break with it.
- Markdown reader: `<https://…>` (an autolink) is read, and typed, as the
  plain URL it holds, where it stayed text with its brackets. No span closes
  inside one but a code span that opened before it, and neither it nor an HTML
  tag (`<em>`, `<strong>`, `<s>`, `<code>`, `<u>`) closes inside a code span
  (of any number of backticks) left open before it, so `` `<em>hi</em>` `` is
  code again; `<<https://…>>` is left as it is written. A plain link or image destination may hold balanced
  parentheses, so a pasted `[wiki](https://en.wikipedia.org/wiki/Foo_(bar))`
  links to the whole URL instead of ending at the first `)`.
- A quote whose text opens with a link labelled `!…` was read back as a
  callout.
- A long line with no finished span (160 KB of `a) `: 1.3 s) was quadratic to
  parse.
- HTML clipboard: a to-do whose text started with whitespace, or was only a
  line break, lost it; an empty list item with a list nested under it was
  dropped; and a list item holding only whitespace came back empty.
- HTML clipboard, from other applications (also on earlier versions): an
  image, table, code block, quote, heading or rule inside a list item was
  dropped or flattened into the item's text, and a paragraph after a nested
  list moved above it. An image counts as a block on its own, inside a link
  (GitHub's markup) or inside a paragraph (a loose list); one anywhere in the
  item's text -- beside words, in a wrapper, beside a task's checkbox -- is
  handed on as a child image rather than dropped with the text it sat in,
  among the item's blocks where the browser draws it (the text itself is
  read ahead of them; on `main`, one after a nested list went above it). An
  item whose blocks come before any text of its own takes its first paragraph
  that holds text as its text, so it keeps its place and number. They are now the item's children, in order; the item
  itself, its to-do box and its number stay, and bare text after one of them
  stays the item's text, on a line of its own rather than joined to the word
  before it. A list nested directly inside a list (Google Docs, and a browser's
  own indent command) was dropped with everything under it; it is a level
  deeper. A table's `<caption>`, which was dropped, is a paragraph above the
  table, and a checkbox to-do (GitHub's task lists) no longer keeps the space
  after the box. A space between two inline elements outside a paragraph
  (`<b>bold</b> <i>it</i>`, links side by side in a `<div>`) was dropped and
  joined the words. Whitespace there is now collapsed as a browser lays it
  out (`white-space: normal`): one space for each run of spaces and line
  breaks, none at the start or end of a line, across element edges; a
  no-break space is kept, and so is whitespace an inline style preserves
  (`white-space: pre`, `pre-wrap`, `break-spaces`, or `pre-line`'s line
  breaks), which is how Google Docs, VS Code and a browser's copy of a
  `pre-wrap` region mark theirs. The edges of an inline paste are the middle
  of a line, so a space there stays -- Firefox copies a selected trailing
  space as a bare one -- while layout around the fragment does not. Inside a
  paragraph whitespace is kept as it stands, which is how this editor's own
  clipboard writes a line break between two runs. Each `<br>` alone on a line
  after a block is a blank line, including after a line break a style
  preserved. A lone `<br>` between two top-level blocks is a blank paragraph,
  as a browser draws it -- VS Code writes empty lines that way, and Google
  Docs puts one between a paragraph and a following list or table, so a
  Google Docs paste now shows those blank lines; a `<br>` that ends an inline
  line -- after a wrapper holding blocks -- is not one. A paste's edges are its
  first and last text, loose or inside its first or last block, so Firefox's
  selected edge space there is kept too -- unless a block (a divider, an empty
  paragraph) comes before that first text or after that last, or the text is
  inside a wrapper whose formatting is pushed into the blocks it holds.
- HTML clipboard (also on earlier versions): list items a wrapper holds inside
  a list (`<ul><a href><li>…</li></a></ul>`, as framework-built pages render)
  were dropped, the whole list with them when every item was wrapped; they are
  items now, carrying the wrapper's link, and loose text or paragraphs directly
  in a list are read as blocks. An inline image followed by a `<br>`, as in an
  email's image line, no longer adds a blank paragraph after the image. Text in
  an element a browser lays out as a block but this reader had no name for --
  `<center>` (HTML email centres its lines with it), `<address>`, `<aside>`,
  `<form>` -- no longer runs into the text beside it. Text in a link or a
  bold, italic or similar wrapper that also holds an image (an icon in a
  link) keeps its link and formatting; it was read bare. So
  does one that also holds a block this reader has no name for, such as
  `<center>` in an email signature, and that block still keeps its lines. An image in a
  heading, a quote or a table cell -- a README's logo, a quoted screenshot, an
  email's banner -- is handed on as an image block after it rather than
  dropped -- in a quote, among its lists where it stands --
  and an image the reader cannot use (Outlook's
  `cid:`, Word's `file:`) no longer splits the sentence around it in two. A
  heading or table holding nothing but an image is that image. A `<figure>`
  is read as an image only when, its own caption aside, it holds one image and
  no text; any other -- a WordPress table block, a gallery, a bookmark card --
  is read block by block, where everything but its first image was lost (also
  on earlier versions). An image in a figure's or a table's caption -- a Wikipedia
  thumbnail's flag icon -- is handed on after it rather than dropped. A
  caption written before the picture no longer lends the figure its own
  image, which lost the picture and doubled the caption's; a second
  `<figcaption>` is content rather than dropped.
  An `<img>` with no usable `src` is read from its own `srcset` or its
  `<picture>`'s `<source>`s, largest candidate first, so a Medium article's
  pictures -- every one written without a `src` -- are no longer dropped on
  paste. A relative `srcset` candidate is passed over: a
  browser resolves `src` when it copies but not `srcset`, and the reader
  has no base URL to resolve one against.
- HTML clipboard (also on earlier versions): an inline `display` is read.
  Chromium writes it when it copies and drops the whitespace it does not
  draw, so a Shiki code block (nextjs.org, shadcn) read as one line, a flex
  row's links ran together (`HomeBrowse`), and Tailwind's code lines and
  Mintlify's paragraphs (`display: block` spans) joined. Each element item
  of a flex or grid container is now a line of its own, as both browsers'
  `innerText` read it -- including in an `inline-flex` container, whose
  items break the sentence it stays in (a component that splits one word
  across items, as GitLab's file-name truncation does, reads split) -- and
  a span declared a block is one, except inside an inline-block or
  inline-table, where it stays in the line (MathJax 2 draws every glyph as
  one, KaTeX every superscript) and only two stacked one on the other,
  each drawing text, are words apart (a fraction's parts); two table cells
  side by side are too (MediaWiki's contents: `10 Algebraic Proof`, joined
  on earlier versions); a link or other formatting around a
  container reaches each item. Inside a code block a `<div>` per line and a
  `<br>` now start lines too (a trailing `<br>` is the line's filler), an
  element declared inline stays in its line (Stripe's linked parameters), a
  newline beside a block is the blank line Chromium draws, and the newline
  that ends the last line draws none.
- HTML clipboard (also on earlier versions): a table nested in a table cell
  is read as that cell's text instead of being dropped with it, so an HTML
  email laid out in nested tables keeps its content; a list inside a wrapper
  in a list item is read as the item's text instead of being dropped; a line
  break followed only by a no-break space is kept.
- HTML clipboard (also on earlier versions): text split around a picture is
  read as it is without the picture -- in one pass, the picture marked where
  it stands -- so a styled element the reader takes as formatting
  (`<aside>`, `<center>`, `<address>`, a `<figcaption>`) keeps its bold,
  italic or link, a block inside it keeps its lines (`before<center>q<img>z
  </center>after` reads `before`/`q`, the picture, `z`/`after`, as the same
  text reads without it), and cells, rows, flex items, parts stacked in an
  inline box and comments between them stay as they are. It was read bare
  as soon as a picture was there, losing the marks, and on `main` its cells
  and flex items ran together.
- HTML clipboard (also on earlier versions): the bold, italic, underline or
  strikethrough a styled `<header>`, `<footer>`, `<nav>`, `<main>` or `<dl>`
  states now applies to what it holds. It was read plain unless the
  container also held both an image and a block. It applies weakly: an
  element inside that turns it off -- a paragraph, item, cell or
  span with `font-weight: 400`, as Chromium writes a Tailwind header's
  tagline -- wins, and so does a tag inside; a `text-decoration: none` below
  takes a decoration off, as it does everywhere in this reader. A chain of
  these nested a thousand deep reads in linear time; it was quadratic, and
  ran the heap out.
- HTML clipboard (also on earlier versions): a style the reader cannot
  resolve -- `inherit`, `unset`, `revert`, a `var()` with no fallback -- inside
  a mark keeps the mark (`<b><span style="font-weight: inherit">` is bold, as
  the browser draws it), `revert` on a mark's own tag keeps the tag's mark
  (the user agent's value: `<b style="font-weight: revert">` is bold), and
  `font-style: oblique <angle>` is italic. A weight or style written as a
  custom property is read as its fallback, which is what a browser draws for
  one the paste does not define: GitHub's `<strong>`
  (`font-weight: var(--base-text-weight-semibold, 600)`) reads bold. A
  decoration is read from its line keywords alone: a custom property named
  after one (`line-through var(--underline-color)`) no longer reads as an
  underline, and a keyword written in capitals counts in a DOM that keeps
  them.
