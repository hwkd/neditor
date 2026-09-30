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
  - A block marker at the start of a line after a soft break is escaped
    (`\# not a heading`), and so is a `!` opening a paragraph with `![`.
- **Markdown.** An image's caption is written after the image, following a hard
  break, instead of being dropped. An image with no source yet is written
  `![alt]()` instead of being lost.
- **Markdown reader.** Numeric character references are decoded at the edges
  of a block's text, where this writer puts them, and nowhere else. `<strong>`,
  `<em>`, `<s>` and `<code>` are read as marks, as `<u>` already was -- when
  typed, too.
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
  had no accessible name.
- A text selection could be left inside a block while blocks were selected
  (WebKit drags), and a touch swipe that became a scroll could leave blocks
  selected.
