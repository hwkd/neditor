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
    backtick, a bracket or `~~` (or `~` in struck text) keeps the escaped
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
  caption, and a line break there is written as a space: written raw it split
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
  is text, with no link made out of a `[…](` inside it.
- A carriage return in a block's text, a table cell or a caption (pasted HTML
  can carry one as `&#13;`) was written raw. Every reader takes it for a line
  break, so the block came back split, and a table came back as paragraphs. It
  is written as the line break it is read as -- in a code block too, where one
  ending the text used to take the last line break with it.
- Markdown reader: `<https://…>` (an autolink) is read, and typed, as the
  plain URL it holds, where it stayed text with its brackets; nothing closes
  inside one. A plain link or image destination may hold balanced
  parentheses, so a pasted `[wiki](https://en.wikipedia.org/wiki/Foo_(bar))`
  links to the whole URL instead of ending at the first `)`.
- A quote whose text opens with a link labelled `!…` was read back as a
  callout.
- A long line with no finished span (160 KB of `a) `: 1.3 s) was quadratic to
  parse.
- HTML clipboard: a to-do whose text started with whitespace, or was only a
  line break, lost it; an empty list item with a list nested under it was
  dropped; and a list item holding only whitespace came back empty.
