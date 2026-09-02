import type { Block, BlockType } from '../model/document.ts';
import { DEFAULT_CALLOUT_ICON, computeListNumbers, createBlock } from '../model/document.ts';
import type { Mark, RichText, TextRun } from '../model/rich-text.ts';
import { isRichEmpty, normalizeRuns, richDelete, richToPlainText } from '../model/rich-text.ts';
import type { TableRows } from '../model/table.ts';
import { normalizeTableRows } from '../model/table.ts';
import { sanitizeImageUrl, sanitizeUrl } from '../util/url.ts';

/**
 * The bridge between runs and the DOM.
 *
 * Rendering is deterministic — the same runs always produce the same element
 * nesting — so a re-render never reshuffles the tree and the caret can be
 * restored by character offset. Parsing is deliberately permissive: it reads
 * back not only what we rendered but whatever a paste or the browser's own
 * editing left behind, mapping it onto the same small mark vocabulary.
 */

/** Applied innermost-first, so the resulting nesting is stable. */
const MARK_ELEMENTS: ReadonlyArray<readonly [Mark, string]> = [
  ['code', 'code'],
  ['bold', 'strong'],
  ['italic', 'em'],
  ['strikethrough', 's'],
  ['underline', 'u'],
];

/**
 * Elements whose contents are not document text.
 *
 * A pasted `<script>` never executes here — it is parsed into an inert
 * template — but its source would otherwise be read out as visible text.
 */
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'HEAD',
  'TITLE',
  'META',
  'LINK',
  'OBJECT',
  'IFRAME',
  'SVG',
]);

/**
 * Elements that end a line.
 *
 * Pasting two paragraphs must not run them together. Splitting a paste across
 * several blocks is a separate feature; until then the break is a newline.
 */
const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'LI',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'PRE',
  'TABLE',
  'TR',
  // Cells break the line too: without these, columns concatenate with no
  // separator whenever a table is reached as inline content.
  'TD',
  'TH',
  'UL',
  'OL',
  'FIGCAPTION',
  'DT',
  'DD',
  'SECTION',
  'ARTICLE',
]);

/** Tags that imply a mark, including the ones browsers and pastes produce. */
const TAG_MARKS: Readonly<Record<string, Mark>> = {
  STRONG: 'bold',
  B: 'bold',
  EM: 'italic',
  I: 'italic',
  U: 'underline',
  INS: 'underline',
  S: 'strikethrough',
  DEL: 'strikethrough',
  STRIKE: 'strikethrough',
  CODE: 'code',
  KBD: 'code',
  SAMP: 'code',
  TT: 'code',
};

/**
 * A node's tag name, always uppercase.
 *
 * `tagName` only reports uppercase inside the HTML namespace. An `<svg>` and
 * everything under it keeps its source case, so comparing the raw value against
 * SKIP_TAGS walks straight into an SVG `<style>` or `<title>` and reads its
 * source out as document text.
 */
function tagNameOf(node: Node): string {
  return node.nodeName.toUpperCase();
}

/** The marks a pasted element turns on and off, from its tag and inline styles. */
interface MarkChange {
  add: Mark[];
  remove: Mark[];
}

/**
 * Reads an element's formatting, letting an inline style override its tag.
 *
 * A tag is only the default: `font-weight: normal` on a `<b>` really does mean
 * not bold. Google Docs wraps its entire clipboard payload in
 * `<b style="font-weight:normal" id="docs-internal-guid-…">`, so treating the
 * tag as the last word makes every Google Docs paste arrive bold.
 */
function marksForElement(element: Element): MarkChange {
  const add = new Set<Mark>();
  const remove = new Set<Mark>();
  const set = (mark: Mark, on: boolean): void => {
    (on ? add : remove).add(mark);
    (on ? remove : add).delete(mark);
  };

  const tagMark = TAG_MARKS[tagNameOf(element)];

  if (tagMark) {
    add.add(tagMark);
  }

  const style = (element as HTMLElement).style as CSSStyleDeclaration | undefined;

  if (!style) {
    return { add: [...add], remove: [...remove] };
  }

  // Word, Google Docs and browser-native formatting all emit styled spans.
  const weight = style.fontWeight;

  if (weight) {
    set('bold', weight === 'bold' || weight === 'bolder' || Number.parseInt(weight, 10) >= 600);
  }

  if (style.fontStyle) {
    set('italic', style.fontStyle === 'italic' || style.fontStyle === 'oblique');
  }

  // Shorthand and longhand both turn up in pasted markup, and either one is the
  // element's own decoration — including `none`, which clears what `<u>` or
  // `<s>` implied.
  const decoration = `${style.textDecorationLine} ${style.textDecoration}`.trim();

  if (decoration) {
    set('underline', decoration.includes('underline'));
    set('strikethrough', decoration.includes('line-through'));
  }

  return { add: [...add], remove: [...remove] };
}

/* -------------------------------------------------------------------------- */
/* Render                                                                      */
/* -------------------------------------------------------------------------- */

function renderRun(doc: Document, run: TextRun): Node {
  let node: Node = doc.createTextNode(run.text);
  const marks = new Set(run.marks ?? []);

  for (const [mark, tag] of MARK_ELEMENTS) {
    if (marks.has(mark)) {
      const wrapper = doc.createElement(tag);
      wrapper.append(node);
      node = wrapper;
    }
  }

  // Sanitized again on the way out: the model guarantees this, but an href is
  // the last place to take a guarantee on trust.
  const href = run.link ? sanitizeUrl(run.link) : null;

  if (href) {
    const anchor = doc.createElement('a');
    anchor.className = 'neditor-link';
    anchor.setAttribute('href', href);
    anchor.setAttribute('rel', 'noopener noreferrer');
    anchor.append(node);
    node = anchor;
  }

  return node;
}

/**
 * Builds the DOM for a block's content.
 *
 * Empty content yields an empty fragment rather than an empty text node, so the
 * `:empty` placeholder rule still matches.
 */
export function renderRichText(doc: Document, content: readonly TextRun[]): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  let last: TextRun | undefined;

  for (const run of content) {
    if (run.text.length > 0) {
      fragment.append(renderRun(doc, run));
      last = run;
    }
  }

  // A newline at the very end of a block gets no line box of its own: under
  // `white-space: pre-wrap` the break ends the last line and there is nothing
  // after it to fill another, so Shift+Enter (and Enter in a table cell) left
  // the block exactly the same height and the caret with nowhere to go — the
  // next character landed in front of the break instead of after it. A
  // trailing <br> is what gives that empty last line a box.
  //
  // It is filler, not content, and `parseRichText` already reads a trailing
  // <br> back as nothing, so the newline is never counted twice on the way in.
  if (last?.text.endsWith('\n')) {
    fragment.append(doc.createElement('br'));
  }

  return fragment;
}

/* -------------------------------------------------------------------------- */
/* Parse                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * True when real content follows this node's own subtree.
 *
 * A trailing `<br>` is the filler contenteditable appends to keep an empty
 * line selectable; it is presentation, not content, and must not become a
 * newline. Block elements reuse it to decide whether they end a line.
 */
function hasContentAfter(node: Node, root: Node): boolean {
  const walker = root.ownerDocument?.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      // FILTER_REJECT skips the element *and* its subtree, so a following
      // <script> never counts as content.
      acceptNode: (candidate) =>
        SKIP_TAGS.has(tagNameOf(candidate)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    },
  );

  if (!walker) {
    return false;
  }

  walker.currentNode = node;

  // Step over this node's own descendants before looking ahead.
  let next: Node | null = walker.nextSibling();

  while (next === null) {
    const parent = walker.parentNode();

    if (parent === null || parent === root) {
      return false;
    }

    next = walker.nextSibling();
  }

  for (let current: Node | null = next; current; current = walker.nextNode()) {
    if (current.nodeName === 'BR') {
      return true;
    }

    // Whitespace between block tags is formatting, not content.
    if (current.nodeType === Node.TEXT_NODE && (current.nodeValue ?? '').trim().length > 0) {
      return true;
    }
  }

  return false;
}

/**
 * True when a whitespace-only text node merely separates block elements.
 *
 * Whitespace between two inline elements is a real space and must survive; the
 * same characters between two paragraphs are indentation from the source.
 */
function isBetweenBlocks(node: Node): boolean {
  const isBlock = (sibling: Node | null): boolean =>
    sibling === null ||
    (sibling.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(tagNameOf(sibling)));

  return isBlock(node.previousSibling) && isBlock(node.nextSibling);
}

/** Appends a newline unless the output is empty or already ends with one. */
function breakLine(out: TextRun[], marks: Mark[], link: string | undefined): void {
  const previous = out.at(-1);

  // Matches a newline followed by any trailing whitespace, so a run ending
  // "\n  " still counts as already broken. (trimEnd would strip the newline
  // being looked for and defeat the check entirely.)
  if (previous && !/\n[^\S\n]*$/.test(previous.text)) {
    out.push({ text: '\n', marks: [...marks], link });
  }
}

function walk(
  node: Node,
  marks: Mark[],
  link: string | undefined,
  root: Node,
  out: TextRun[],
): void {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.nodeValue ?? '';

      // Indentation between block elements is source formatting, not content.
      // Without this, pretty-printed HTML pastes with blank leading lines.
      if (text.trim().length === 0 && isBetweenBlocks(child)) {
        continue;
      }

      if (text.length > 0) {
        out.push({ text, marks: [...marks], link });
      }

      continue;
    }

    if (tagNameOf(child) === 'BR') {
      if (hasContentAfter(child, root)) {
        out.push({ text: '\n', marks: [...marks], link });
      }

      continue;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }

    const element = child as Element;
    const tag = tagNameOf(element);

    if (SKIP_TAGS.has(tag)) {
      continue;
    }

    // A block element breaks the line on both edges: before it when something
    // precedes it, and after it when something follows. `breakLine` collapses
    // the two where blocks are adjacent, so they never double up.
    const isBlock = BLOCK_TAGS.has(tag);

    if (isBlock) {
      breakLine(out, marks, link);
    }

    const { add, remove } = marksForElement(element);
    const nextMarks = [...marks, ...add].filter((mark) => !remove.includes(mark));
    let nextLink = link;

    if (tag === 'A') {
      // An unsafe href is dropped, but its text is kept.
      nextLink = sanitizeUrl(element.getAttribute('href') ?? '') ?? undefined;
    }

    walk(element, nextMarks, nextLink, root, out);

    if (isBlock && hasContentAfter(element, root)) {
      breakLine(out, marks, link);
    }
  }
}

/** Reads a rendered (or pasted) subtree back into canonical runs. */
export function parseRichText(root: Node): RichText {
  const out: TextRun[] = [];
  walk(root, [], undefined, root, out);
  return normalizeRuns(out);
}

/* -------------------------------------------------------------------------- */
/* Block-level serialization                                                   */
/* -------------------------------------------------------------------------- */

/** The element a block type becomes on the clipboard. */
const BLOCK_TAGS_OUT: Readonly<Record<BlockType, string>> = {
  paragraph: 'p',
  heading1: 'h1',
  heading2: 'h2',
  heading3: 'h3',
  bulleted_list: 'li',
  numbered_list: 'li',
  todo: 'li',
  quote: 'blockquote',
  code: 'pre',
  // A callout is a blockquote elsewhere; the attribute is what makes it exact.
  callout: 'blockquote',
  toggle: 'details',
  image: 'figure',
  table: 'table',
  divider: 'hr',
};

/** Marks a blockquote as a callout and carries its icon. */
const CALLOUT_ATTR = 'data-neditor-callout';

/** `<thead>` for the header row, `<tbody>` for the rest. */
function tableSections(doc: Document, rows: TableRows): HTMLElement[] {
  const [header, ...body] = rows;

  if (!header) {
    return [];
  }

  const buildRow = (cells: readonly RichText[], tag: string): HTMLElement => {
    const tr = doc.createElement('tr');

    for (const cell of cells) {
      const container = doc.createElement(tag);
      container.append(renderRichText(doc, cell));
      tr.append(container);
    }

    return tr;
  };

  const thead = doc.createElement('thead');
  thead.append(buildRow(header, 'th'));

  const sections = [thead];

  if (body.length > 0) {
    const tbody = doc.createElement('tbody');

    for (const row of body) {
      tbody.append(buildRow(row, 'td'));
    }

    sections.push(tbody);
  }

  return sections;
}

/** The list element consecutive items of this type belong in, if any. */
function listWrapperFor(type: BlockType): string | null {
  if (type === 'numbered_list') {
    return 'ol';
  }

  return type === 'bulleted_list' || type === 'todo' ? 'ul' : null;
}

/**
 * Serializes blocks to HTML for the clipboard.
 *
 * Built through the DOM rather than string concatenation, so text is escaped by
 * construction. Consecutive list items become one `<ul>`/`<ol>`, and a deeper
 * item opens a real nested list inside the previous `<li>` — a `margin-left`
 * would look right but would not survive being parsed back.
 */
export function blocksToHtml(doc: Document, blocks: readonly Block[]): string {
  const host = doc.createElement('div');
  const numbers = computeListNumbers(blocks);

  /** Open lists, innermost last. */
  let open: Array<{ list: HTMLElement; type: BlockType; depth: number }> = [];

  for (const block of blocks) {
    const wrapper = listWrapperFor(block.type);

    if (!wrapper) {
      open = [];
      const element = doc.createElement(BLOCK_TAGS_OUT[block.type]);

      if (block.depth > 0) {
        // The attribute is what round-trips; the margin is for other editors.
        element.dataset.neditorDepth = String(block.depth);
        element.style.marginLeft = `${block.depth * 1.5}em`;
      }

      if (block.type === 'image') {
        const image = doc.createElement('img');
        image.setAttribute('src', block.src ?? '');
        image.setAttribute('alt', block.alt ?? '');
        element.append(image);

        if (!isRichEmpty(block.content)) {
          const caption = doc.createElement('figcaption');
          caption.append(renderRichText(doc, block.content));
          element.append(caption);
        }

        host.append(element);
        continue;
      }

      if (block.type === 'table') {
        element.append(...tableSections(doc, block.rows ?? []));
        host.append(element);
        continue;
      }

      if (block.type === 'callout') {
        element.setAttribute(CALLOUT_ATTR, block.icon ?? DEFAULT_CALLOUT_ICON);
      }

      if (block.type === 'toggle') {
        // <details open> is the expanded state, so collapsed is its absence.
        if (!block.collapsed) {
          element.setAttribute('open', '');
        }

        const summary = doc.createElement('summary');
        summary.append(renderRichText(doc, block.content));
        element.append(summary);
      } else if (block.type !== 'divider') {
        element.append(renderRichText(doc, block.content));
      }

      host.append(element);
      continue;
    }

    // Close any list deeper than this block, or of a different kind at its level.
    while (
      open.length > 0 &&
      (open[open.length - 1]!.depth > block.depth ||
        (open[open.length - 1]!.depth === block.depth &&
          open[open.length - 1]!.type !== block.type))
    ) {
      open.pop();
    }

    let current = open[open.length - 1];

    if (!current || current.depth < block.depth) {
      const list = doc.createElement(wrapper);

      if (block.type === 'numbered_list') {
        list.setAttribute('start', String(numbers.get(block.id) ?? 1));
      }

      // A deeper list belongs inside the item it hangs off.
      const parentItem = current?.list.lastElementChild;

      if (parentItem) {
        parentItem.append(list);
      } else {
        host.append(list);
      }

      current = { list, type: block.type, depth: block.depth };
      open.push(current);
    }

    const item = doc.createElement('li');

    if (block.depth > 0) {
      // Structural nesting alone is lost the moment a non-list block resets the
      // stack, so the depth is recorded on the item as well.
      item.dataset.neditorDepth = String(block.depth);
    }

    if (block.type === 'todo') {
      // Plain text, because a real <input> would not survive most paste targets.
      item.append(doc.createTextNode(block.checked ? '\u2611 ' : '\u2610 '));
    }

    item.append(renderRichText(doc, block.content));
    current.list.append(item);
  }

  return host.innerHTML;
}

/* -------------------------------------------------------------------------- */
/* Block-level parsing                                                         */
/* -------------------------------------------------------------------------- */

const HEADING_TYPES: Readonly<Record<string, BlockType>> = {
  H1: 'heading1',
  H2: 'heading2',
  H3: 'heading3',
  // Nothing deeper exists yet; collapsing beats discarding the structure.
  H4: 'heading3',
  H5: 'heading3',
  H6: 'heading3',
};

/** Wrappers that carry no meaning of their own; their children are the blocks. */
const CONTAINER_TAGS = new Set([
  'DIV',
  'SECTION',
  'ARTICLE',
  'MAIN',
  'BODY',
  'HTML',
  'HEADER',
  'FOOTER',
  'NAV',
  'DL',
  'DT',
  'DD',
]);

/**
 * Tags `visitBlocks` turns into a block of their own.
 *
 * Finding one inside an unrecognised element is what separates a wrapper that
 * only styles text from one that carries the document, so the second kind can
 * be descended into rather than flattened into a single paragraph.
 */
const BLOCK_LEVEL_TAGS = new Set([
  ...Object.keys(HEADING_TYPES),
  ...CONTAINER_TAGS,
  'P',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'DETAILS',
  'PRE',
  'TABLE',
  'FIGURE',
  'HR',
]);

const BLOCK_LEVEL_SELECTOR = [...BLOCK_LEVEL_TAGS].join(',');

/**
 * Elements a wrapper's formatting has to be carried *through*, not around.
 *
 * Each of these is found by walking from its parent — the table reader queries
 * the child axis, and the caption and summary readers parse the element itself
 * — so moving one inside a `<b>` would hide its rows, or leave its text outside
 * the marks that reach it.
 */
const STRUCTURE_TAGS = new Set([
  ...BLOCK_LEVEL_TAGS,
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'TD',
  'TH',
  'CAPTION',
  'COLGROUP',
  'COL',
  'FIGCAPTION',
  'SUMMARY',
]);

function containsBlockLevel(element: Element): boolean {
  return element.querySelector(BLOCK_LEVEL_SELECTOR) !== null;
}

/**
 * The children of an inline wrapper, with its formatting moved inside the
 * blocks it holds: `<b><p>x</p></b>` becomes `<p><b>x</b></p>`.
 *
 * Descending into the wrapper is the only way to see those blocks, and
 * `visitBlocks` reads formatting from each block's own subtree — so without
 * this, descending would silently drop the marks (or href) the wrapper carried.
 * The copy goes around each innermost run of inline content, which leaves the
 * document's own formatting nested inside it and therefore winning.
 */
function pushFormattingInward(doc: Document, wrapper: Element): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  const distribute = (parent: Node): void => {
    /** The inline nodes waiting for a copy of the wrapper around them. */
    let run: Node[] = [];

    // One copy around the whole run, not one per node: a space between two
    // elements would read as separating blocks once it had a copy of its own,
    // and be dropped as indentation.
    const wrapRun = (): void => {
      const first = run[0];

      if (!first) {
        return;
      }

      const shell = wrapper.cloneNode(false) as Element;

      parent.insertBefore(shell, first);
      shell.append(...run);
      run = [];
    };

    for (const child of [...parent.childNodes]) {
      const element = child.nodeType === Node.ELEMENT_NODE ? (child as Element) : null;

      if (element && (STRUCTURE_TAGS.has(tagNameOf(element)) || containsBlockLevel(element))) {
        wrapRun();
        distribute(element);
        continue;
      }

      // Indentation between two blocks joins a run already under way, but never
      // starts one — on its own it is source formatting, not content.
      if (!element && run.length === 0 && (child.nodeValue ?? '').trim().length === 0) {
        continue;
      }

      run.push(child);
    }

    wrapRun();
  };

  fragment.append(...[...(wrapper.cloneNode(true) as Element).childNodes]);
  distribute(fragment);

  return fragment;
}

/**
 * What to walk when descending into an element that is not a block itself.
 *
 * Its formatting travels down to the content inside, but only where a block is
 * there to receive it: an `<a>` around a lone `<img>` has nothing to push into
 * and a copy of it would only wrap the image again, for ever. A block element's
 * formatting stays behind either way — a copy of one placed around inline
 * content would read back as a line break.
 */
function contentsOf(doc: Document, element: Element): Node {
  const tag = tagNameOf(element);
  const inline = !BLOCK_TAGS.has(tag) && (tag === 'A' || marksForElement(element).add.length > 0);

  return inline && containsBlockLevel(element) ? pushFormattingInward(doc, element) : element;
}

/** A checkbox written as text, including what `blocksToHtml` emits. */
const TODO_PREFIX = /^\s*(?:\[([ xX])\]|☐|☑|✅)\s*/;

/** Strips a leading textual checkbox, reporting whether it was ticked. */
function extractTodoPrefix(runs: RichText): { runs: RichText; checked: boolean } | null {
  const match = TODO_PREFIX.exec(richToPlainText(runs));

  if (!match) {
    return null;
  }

  const marker = match[0];
  const checked = /[xX]/.test(match[1] ?? '') || marker.includes('☑') || marker.includes('✅');

  return { runs: richDelete(runs, 0, marker.length), checked };
}

/** A copy of `element` with nested lists removed, since those are their own blocks. */
function withoutNestedLists(element: Element): Element {
  const clone = element.cloneNode(true) as Element;

  for (const nested of clone.querySelectorAll('ul, ol')) {
    nested.remove();
  }

  return clone;
}

/**
 * Emits one block, empty or not.
 *
 * An empty `<p>` is a blank line the author put there, and the clipboard is a
 * round trip: `blocksToHtml` writes an empty block as an empty element, so
 * dropping it here loses a paragraph, heading or quote on every copy-paste.
 */
function pushBlock(out: Block[], type: BlockType, element: Element, depth: number): void {
  const runs = parseRichText(withoutNestedLists(element));

  out.push(createBlock(type, runs, depthOf(element, depth)));
}

/** Our own serializer records depth explicitly; other sources have none. */
function depthOf(element: Element, fallback: number): number {
  const declared = Number.parseInt((element as HTMLElement).dataset?.neditorDepth ?? '', 10);

  return Number.isFinite(declared) && declared >= 0 ? declared : fallback;
}

function pushCallout(out: Block[], element: Element, depth: number, icon: string): void {
  const runs = parseRichText(withoutNestedLists(element));
  const block = createBlock('callout', runs, depthOf(element, depth));
  block.icon = icon;
  out.push(block);
}

/**
 * A `<details>` becomes a toggle whose `<summary>` is its text.
 *
 * Whatever else it contains is nested one level deeper, so a `<details>` from
 * anywhere else keeps its structure rather than collapsing into one block.
 */
function visitDetails(doc: Document, element: Element, depth: number, out: Block[]): void {
  const summary = element.querySelector('summary');
  const block = createBlock(
    'toggle',
    summary ? parseRichText(summary) : [],
    depthOf(element, depth),
  );
  block.collapsed = !element.hasAttribute('open');
  out.push(block);

  const body = element.cloneNode(true) as Element;
  body.querySelector('summary')?.remove();

  visitBlocks(doc, body, block.depth + 1, out);
}

/** Reads a `<table>` into a grid; `normalizeTableRows` squares off ragged rows. */
function pushTable(out: Block[], element: Element, depth: number): void {
  const rows: TableRows = [];

  // Scoped, so a nested table does not contribute its rows to this one — and
  // each cell is stripped of nested tables before its text is read.
  for (const row of element.querySelectorAll(
    ':scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr',
  )) {
    const cells: RichText[] = [];

    for (const cell of row.querySelectorAll(':scope > th, :scope > td')) {
      const clone = cell.cloneNode(true) as Element;

      for (const nested of clone.querySelectorAll('table')) {
        nested.remove();
      }

      cells.push(parseRichText(clone));
    }

    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  if (rows.length === 0) {
    return;
  }

  const block = createBlock('table', [], depthOf(element, depth));
  block.rows = normalizeTableRows(rows);
  out.push(block);
}

/**
 * A blockquote becomes a quote (or callout), with any list it held underneath.
 *
 * The quote's own text is read from a copy with every list stripped out, so
 * without visiting them separately a quoted list — the ordinary shape on
 * GitHub, Wikipedia and Stack Overflow — is dropped on the floor.
 */
function visitQuote(element: Element, depth: number, out: Block[]): void {
  const icon = element.getAttribute(CALLOUT_ATTR);
  const lists = outermostLists(element);
  const quoteDepth = depthOf(element, depth);

  // A blockquote holding nothing but a list is that list: an empty quote above
  // it would be a block the source never had. Our own callouts keep theirs,
  // since the marker says the block was really there.
  const bare =
    icon === null && lists.length > 0 && isRichEmpty(parseRichText(withoutNestedLists(element)));

  if (!bare) {
    if (icon === null) {
      pushBlock(out, 'quote', element, depth);
    } else {
      pushCallout(out, element, depth, icon.length > 0 ? icon : DEFAULT_CALLOUT_ICON);
    }
  }

  for (const list of lists) {
    visitList(list, bare ? quoteDepth : quoteDepth + 1, out);
  }
}

/**
 * The lists inside an element, outermost only.
 *
 * A list nested in one of them is left out: `visitList` descends into those
 * itself, and returning both would emit their items twice.
 */
function outermostLists(element: Element): Element[] {
  return [...element.querySelectorAll('ul, ol')].filter((list) => {
    const enclosing = list.parentElement?.closest('ul, ol') ?? null;

    return enclosing === null || !element.contains(enclosing);
  });
}

/** A `<figure>` carries the caption; a bare `<img>` is just the image. */
function pushImage(out: Block[], element: Element, depth: number): boolean {
  const image = tagNameOf(element) === 'IMG' ? element : element.querySelector('img');
  const src = sanitizeImageUrl(image?.getAttribute('src') ?? '');

  // An unusable source would only render as a broken block. The caller
  // recurses into the element instead, so a <figure> keeps its other children.
  if (!src) {
    return false;
  }

  const caption = element.querySelector('figcaption');
  const block = createBlock(
    'image',
    caption ? parseRichText(caption) : [],
    depthOf(element, depth),
  );
  block.src = src;
  block.alt = image?.getAttribute('alt') ?? '';
  out.push(block);

  return true;
}

/** The lists an element holds directly, which continue one level deeper. */
function childLists(element: Element): Element[] {
  return [...element.children].filter((child) => {
    const tag = tagNameOf(child);

    return tag === 'UL' || tag === 'OL';
  });
}

function visitListItem(item: Element, fallback: BlockType, depth: number, out: Block[]): void {
  const itemDepth = depthOf(item, depth);
  const nested = childLists(item);
  const clone = withoutNestedLists(item);
  const checkbox = clone.querySelector('input[type="checkbox"]');
  let runs = parseRichText(clone);
  let type = fallback;
  let checked = false;

  if (checkbox) {
    type = 'todo';
    checked = (checkbox as HTMLInputElement).checked || checkbox.hasAttribute('checked');
  } else {
    const todo = extractTodoPrefix(runs);

    if (todo) {
      type = 'todo';
      checked = todo.checked;
      runs = todo.runs;
    }
  }

  // An empty item is a real blank bullet — unless it exists only to hold the
  // list nested under it, which is how indentation alone is written.
  if (!isRichEmpty(runs) || nested.length === 0) {
    const block = createBlock(type, runs, itemDepth);

    if (type === 'todo') {
      block.checked = checked;
    }

    out.push(block);
  }

  // A list nested inside the item continues one level deeper.
  for (const child of nested) {
    visitList(child, itemDepth + 1, out);
  }
}

function visitList(list: Element, depth: number, out: Block[]): void {
  const fallback: BlockType = tagNameOf(list) === 'OL' ? 'numbered_list' : 'bulleted_list';

  for (const child of list.children) {
    if (tagNameOf(child) === 'LI') {
      visitListItem(child, fallback, depth, out);
    }
  }
}

/**
 * Walks a subtree, emitting one block per block-level element.
 *
 * Inline nodes between block elements are buffered and flushed as a paragraph,
 * so stray text at the top level is not silently dropped.
 */
function visitBlocks(doc: Document, node: Node, depth: number, out: Block[]): void {
  let buffer: Node[] = [];

  const flushInline = (): void => {
    if (buffer.length === 0) {
      return;
    }

    const wrapper = doc.createElement('div');

    for (const inline of buffer) {
      wrapper.append(inline.cloneNode(true));
    }

    buffer = [];
    const runs = parseRichText(wrapper);

    if (!isRichEmpty(runs)) {
      out.push(createBlock('paragraph', runs, depth));
    }
  };

  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.nodeValue ?? '').trim().length > 0) {
        buffer.push(child);
      }

      continue;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }

    const element = child as Element;
    const tag = tagNameOf(element);

    if (SKIP_TAGS.has(tag)) {
      continue;
    }

    if (tag === 'BR') {
      buffer.push(element);
      continue;
    }

    const heading = HEADING_TYPES[tag];

    if (heading) {
      flushInline();
      pushBlock(out, heading, element, depth);
      continue;
    }

    if (tag === 'UL' || tag === 'OL') {
      flushInline();
      visitList(element, depth, out);
      continue;
    }

    if (tag === 'LI') {
      flushInline();
      visitListItem(element, 'bulleted_list', depth, out);
      continue;
    }

    if (tag === 'BLOCKQUOTE') {
      flushInline();
      visitQuote(element, depth, out);
      continue;
    }

    if (tag === 'DETAILS') {
      flushInline();
      visitDetails(doc, element, depth, out);
      continue;
    }

    if (tag === 'PRE') {
      flushInline();
      out.push(createBlock('code', element.textContent ?? '', depthOf(element, depth)));
      continue;
    }

    if (tag === 'TABLE') {
      flushInline();
      pushTable(out, element, depth);
      continue;
    }

    if (tag === 'FIGURE' || tag === 'IMG') {
      flushInline();

      if (!pushImage(out, element, depth) && tag === 'FIGURE') {
        // No usable image, but the figure may still hold a caption or a table.
        visitBlocks(doc, element, depth, out);
      }

      continue;
    }

    // <a href><img> and <p><img> are the commonest image markup on the web.
    // Without this the image is buffered as inline content and emits nothing.
    if (element.querySelector('img')) {
      flushInline();
      visitBlocks(doc, contentsOf(doc, element), depth, out);
      continue;
    }

    if (tag === 'HR') {
      flushInline();
      out.push(createBlock('divider', [], depthOf(element, depth)));
      continue;
    }

    if (tag === 'P') {
      flushInline();
      pushBlock(out, 'paragraph', element, depth);
      continue;
    }

    if (CONTAINER_TAGS.has(tag)) {
      flushInline();
      visitBlocks(doc, element, depth, out);
      continue;
    }

    // A wrapper holding block content is structure, not formatting. Google Docs
    // wraps its entire clipboard payload in one <b>, and buffering that as
    // inline collapses every paragraph, heading and list item inside it into a
    // single paragraph.
    if (containsBlockLevel(element)) {
      flushInline();
      visitBlocks(doc, contentsOf(doc, element), depth, out);
      continue;
    }

    // Anything else is inline: <strong>, <a>, <span>, unknown elements.
    buffer.push(element);
  }

  flushInline();
}

/** Parses an HTML string into blocks, for a multi-block paste. */
export function blocksFromHtml(doc: Document, html: string): Block[] {
  // A detached template never runs scripts or loads subresources.
  const template = doc.createElement('template');
  template.innerHTML = html;

  const out: Block[] = [];
  visitBlocks(doc, template.content, 0, out);

  return out;
}

/** Parses an HTML string, for clipboard payloads. */
export function parseRichTextFromHtml(doc: Document, html: string): RichText {
  // A detached template never runs scripts or loads subresources.
  const template = doc.createElement('template');
  template.innerHTML = html;

  return parseRichText(template.content);
}
