# Changelog

## Unreleased

Found by the end-to-end suite (`apps/e2e`, `docs/e2e-progress.md`) and its audits. Behaviour
that changes what you store or what other applications receive is listed first.

### Changed output

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
    not one per line -- except in a heading, which every other reader ends at
    the line, so there each line is its own span and a mark on the break itself
    is not kept. (A line break in a heading has no Markdown spelling: other
    readers show the `\` and start a paragraph on the next line.)
  - A formatted run is also written as HTML where CommonMark's flanking rule
    would leave `**` or `*` literal: against punctuation with a letter on the
    far side (`word<strong>(x)</strong>`), around a code span next to a letter,
    `~~` around `**` next to a letter, and where two runs' delimiters would
    touch between punctuation (or as `***a****b*`, which micromark misreads,
    or `*a****b*****c**`, which CommonMark's rule of three leaves literal).
  - A `_` between two letters or digits inside a bare URL is written bare
    (`https://a.test/x_y`): GFM links a bare URL and took the escape's
    backslash into it. Any other escaped character written against a bare URL
    (`https://a.test/~x`, a URL ending a block before a trailing space) is
    still taken into the link by GFM readers; CommonMark readers are
    unaffected.
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
  - A block marker at the start of a line after a soft break is escaped
    (`\# not a heading`), and so is a `!` opening a paragraph with `![`.
- **Markdown.** An image's caption is written after the image, following a hard
  break, instead of being dropped. An image with no source yet is written
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

### Fixed

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
  a bare URL (`https://…` or `www.…`, up to the next whitespace) is no longer
  one; a span that opens before the URL (`_see https://a.test_`) still is.
