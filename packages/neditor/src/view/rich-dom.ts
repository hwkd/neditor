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

/** Marks a pasted element implies, from its tag and its inline styles. */
function marksForElement(element: Element): Mark[] {
  const marks: Mark[] = [];
  const tagMark = TAG_MARKS[element.tagName];

  if (tagMark) {
    marks.push(tagMark);
  }

  const style = (element as HTMLElement).style as CSSStyleDeclaration | undefined;

  if (!style) {
    return marks;
  }

  // Word, Google Docs and browser-native formatting all emit styled spans.
  const weight = style.fontWeight;

  if (weight === 'bold' || weight === 'bolder' || Number.parseInt(weight, 10) >= 600) {
    marks.push('bold');
  }

  if (style.fontStyle === 'italic' || style.fontStyle === 'oblique') {
    marks.push('italic');
  }

  const decoration = `${style.textDecorationLine} ${style.textDecoration}`;

  if (decoration.includes('underline')) {
    marks.push('underline');
  }

  if (decoration.includes('line-through')) {
    marks.push('strikethrough');
  }

  return marks;
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

  for (const run of content) {
    if (run.text.length > 0) {
      fragment.append(renderRun(doc, run));
    }
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
        SKIP_TAGS.has(candidate.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
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
    (sibling.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((sibling as Element).tagName));

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

    if (child.nodeName === 'BR') {
      if (hasContentAfter(child, root)) {
        out.push({ text: '\n', marks: [...marks], link });
      }

      continue;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }

    const element = child as Element;

    if (SKIP_TAGS.has(element.tagName)) {
      continue;
    }

    // A block element breaks the line on both edges: before it when something
    // precedes it, and after it when something follows. `breakLine` collapses
    // the two where blocks are adjacent, so they never double up.
    const isBlock = BLOCK_TAGS.has(element.tagName);

    if (isBlock) {
      breakLine(out, marks, link);
    }

    const nextMarks = [...marks, ...marksForElement(element)];
    let nextLink = link;

    if (element.tagName === 'A') {
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

function pushBlock(out: Block[], type: BlockType, element: Element, depth: number): void {
  const runs = parseRichText(withoutNestedLists(element));

  // An empty <p> is a blank line, not a block.
  if (isRichEmpty(runs) && type !== 'divider') {
    return;
  }

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

/** A `<figure>` carries the caption; a bare `<img>` is just the image. */
function pushImage(out: Block[], element: Element, depth: number): boolean {
  const image = element.tagName === 'IMG' ? element : element.querySelector('img');
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

function visitListItem(item: Element, fallback: BlockType, depth: number, out: Block[]): void {
  const itemDepth = depthOf(item, depth);
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

  if (!isRichEmpty(runs)) {
    const block = createBlock(type, runs, itemDepth);

    if (type === 'todo') {
      block.checked = checked;
    }

    out.push(block);
  }

  // A list nested inside the item continues one level deeper.
  for (const child of item.children) {
    if (child.tagName === 'UL' || child.tagName === 'OL') {
      visitList(child, itemDepth + 1, out);
    }
  }
}

function visitList(list: Element, depth: number, out: Block[]): void {
  const fallback: BlockType = list.tagName === 'OL' ? 'numbered_list' : 'bulleted_list';

  for (const child of list.children) {
    if (child.tagName === 'LI') {
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
    const tag = element.tagName;

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
      const icon = element.getAttribute(CALLOUT_ATTR);

      if (icon === null) {
        pushBlock(out, 'quote', element, depth);
      } else {
        pushCallout(out, element, depth, icon.length > 0 ? icon : DEFAULT_CALLOUT_ICON);
      }

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
      visitBlocks(doc, element, depth, out);
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
