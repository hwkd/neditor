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
 * DOM constants spelled out, rather than read off the global scope.
 *
 * Every entry point here is handed the Document to work in, so the serializers
 * run wherever a DOM implementation can be passed to them — which is exactly
 * what the README promises for the server. Reaching for the global `Node` or
 * `NodeFilter` quietly broke that: under a shim handed in as an argument those
 * globals do not exist, and `blocksFromHtml` threw `ReferenceError: NodeFilter
 * is not defined` before reading a single node. The values are fixed by the DOM
 * standard, so writing them out is not a guess about any one implementation.
 */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const SHOW_ELEMENT = 0x1;
const SHOW_TEXT = 0x4;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;
const FILTER_SKIP = 3;

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
/**
 * Elements a reader wants treated as absent, along with everything inside them.
 *
 * This replaced cloning the subtree and deleting the unwanted parts out of the
 * copy. That is the same answer, but a list item holds the whole list below it,
 * so cloning one per level is quadratic in the nesting depth: 10 KB of pasted
 * nested `<ul>` took 15 seconds and 1.4 GB inside the paste handler. Skipping
 * during the walk reads each node once.
 */
type SkipPredicate = (element: Element, tag: string) => boolean;

/** A list nested inside a list item is the *next* block, not this one's text. */
const isNestedList: SkipPredicate = (_element, tag) => tag === 'UL' || tag === 'OL';

function hasContentAfter(node: Node, root: Node, skip?: SkipPredicate): boolean {
  const walker = root.ownerDocument?.createTreeWalker(root, SHOW_TEXT | SHOW_ELEMENT, {
    // FILTER_REJECT skips the element *and* its subtree, so a following
    // <script> never counts as content.
    //
    // `skip` is rejected here as well as in `walk`, or the two disagree about
    // what "content" is: a <br> whose only follower is a nested list kept its
    // newline here while the walk that produced the runs never saw the list.
    acceptNode: (candidate) => {
      const tag = tagNameOf(candidate);

      return SKIP_TAGS.has(tag) ||
        (candidate.nodeType === ELEMENT_NODE && skip?.(candidate as Element, tag) === true)
        ? FILTER_REJECT
        : FILTER_ACCEPT;
    },
  });

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
    if (current.nodeType === TEXT_NODE && (current.nodeValue ?? '').trim().length > 0) {
      return true;
    }
  }

  return false;
}

/**
 * True when a whitespace-only text node merely separates block elements.
 *
 * Whitespace between two inline elements is a real space and must survive; the
 * same characters between two paragraphs are indentation from the source. The
 * edge of the parent is a boundary too — the newline before the first `<p>` is
 * still indentation — but only where a block element is actually on the other
 * side. Counting a missing sibling as a block on its own threw away the content
 * of anything holding nothing but whitespace: `<p> </p>` and `<td> </td>` came
 * back empty, so a space-only block or table cell was lost on every copy-paste.
 */
function isBetweenBlocks(node: Node): boolean {
  const isBlock = (sibling: Node | null): boolean =>
    sibling !== null && sibling.nodeType === ELEMENT_NODE && BLOCK_TAGS.has(tagNameOf(sibling));
  const edge = (sibling: Node | null): boolean => sibling === null || isBlock(sibling);
  const previous = node.previousSibling;
  const next = node.nextSibling;

  return (isBlock(previous) || isBlock(next)) && edge(previous) && edge(next);
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

/**
 * How deep the readers will follow nested *blocks* before they stop descending.
 *
 * The descent is recursive, so without a bound a deeply nested paste overflows
 * the stack and throws `RangeError` out of the `paste` handler. Eight times the
 * depth the model can even represent -- `MAX_DEPTH` is 32, so everything below
 * that already flattens to the same level -- and far enough under the limit
 * (around 1,500 levels) to leave room for a smaller stack than this one.
 *
 * Content past the bound is not dropped: it is read as text and emitted as one
 * block, which costs a single pass rather than one per remaining level.
 */
const MAX_BLOCK_NESTING = 1024;

/**
 * The list descent gets a tighter one, and its own counter.
 *
 * `visitList` and `visitListItem` call each other through `parseRichText`, so a
 * level of nested list costs about twice the frames a wrapper does -- measured:
 * with every bound removed, wrappers, toggles and inline spans all survive 3,200
 * levels and lists give out at half that. Meanwhile a list nested past
 * `MAX_DEPTH` is already flattened by the model, so there is nothing to lose in
 * stopping early. Separate counters rather than one shared threshold, or a list
 * inside a few hundred wrappers would refuse to descend at all.
 */
const MAX_LIST_NESTING = 256;

/**
 * The same bound for the inline walk, which is a separate budget on purpose.
 *
 * Formatting wrappers nest far deeper than block structure does in real
 * clipboard payloads -- Google Docs ships hundreds of them around one
 * paragraph, and this package pins 512 -- while costing about a third of the
 * frames per level that the block descent does. One shared threshold would have
 * to be set for the block path and would then truncate legitimate formatting.
 */
const MAX_INLINE_NESTING = 2048;

let blockNesting = 0;
let listNesting = 0;
let inlineNesting = 0;

/**
 * The text of a subtree, gathered with a cursor.
 *
 * Not `textContent`: the DOM implementation this package is tested against
 * computes that by recursing per level, so reading it off the very subtree the
 * bound above exists to protect overflowed the stack anyway -- the bound held
 * and the salvage step blew up instead. A TreeWalker steps, so it does not.
 */
function subtreeText(node: Node): string {
  const walker = node.ownerDocument?.createTreeWalker(node, SHOW_TEXT | SHOW_ELEMENT, {
    acceptNode: (candidate) =>
      SKIP_TAGS.has(tagNameOf(candidate))
        ? FILTER_REJECT
        : candidate.nodeType === TEXT_NODE
          ? FILTER_ACCEPT
          : FILTER_SKIP,
  });

  if (!walker) {
    return '';
  }

  let text = '';

  for (let found = walker.nextNode(); found !== null; found = walker.nextNode()) {
    text += found.nodeValue ?? '';
  }

  return text;
}

function walk(
  node: Node,
  marks: Mark[],
  link: string | undefined,
  root: Node,
  out: TextRun[],
  skip?: SkipPredicate,
): void {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === TEXT_NODE) {
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
      if (hasContentAfter(child, root, skip)) {
        out.push({ text: '\n', marks: [...marks], link });
      }

      continue;
    }

    if (child.nodeType !== ELEMENT_NODE) {
      continue;
    }

    const element = child as Element;
    const tag = tagNameOf(element);

    if (SKIP_TAGS.has(tag) || skip?.(element, tag) === true) {
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

    // The inline walk recurses per element too, and shares the stack with the
    // block descent above it, so it takes the same bound. Past it the subtree's
    // text is taken whole rather than dropped -- one pass, no further frames.
    if (inlineNesting >= MAX_INLINE_NESTING) {
      const remainder = subtreeText(element);

      if (remainder.length > 0) {
        out.push({ text: remainder, marks: [...nextMarks], link: nextLink });
      }
    } else {
      inlineNesting += 1;

      try {
        walk(element, nextMarks, nextLink, root, out, skip);
      } finally {
        inlineNesting -= 1;
      }
    }

    if (isBlock && hasContentAfter(element, root, skip)) {
      breakLine(out, marks, link);
    }
  }
}

/** Reads a rendered (or pasted) subtree back into canonical runs. */
export function parseRichText(root: Node, skip?: SkipPredicate): RichText {
  const out: TextRun[] = [];
  walk(root, [], undefined, root, out, skip);
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

/**
 * Marks a list this serializer wrote, whose items declare their own type.
 *
 * Reading a checkbox out of an item's text is a guess, and the right guess for
 * foreign markup: a bullet written `[x] done` elsewhere really is a to-do. It
 * is the wrong guess for our own output, where a bulleted item that merely
 * begins with "[x]" is a bullet whose text begins with "[x]" — turning it into
 * a to-do also eats those characters, so copying a document and pasting it back
 * silently rewrote the line. Inside a list we wrote, the marker below is the
 * only thing that makes a to-do.
 */
const LIST_ATTR = 'data-neditor-list';

/** A to-do's state, recorded exactly so the textual box is never parsed back. */
const TODO_ATTR = 'data-neditor-checked';

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
        if (block.type === 'code') {
          // Inside a `<code>`, which is both the conventional markup for a code
          // block and the thing that makes it survive a round trip. HTML tree
          // construction drops a single newline straight after a `<pre>` start
          // tag, so a code block whose first line was blank came back one line
          // shorter every time it was copied and pasted. Measured in Chrome:
          // `<pre>\nX` reads back as "X", `<pre><code>\nX` as "\nX". Doubling
          // the newline instead would have worked in a browser and been wrong
          // under the DOM this package is tested against, which does not
          // implement that rule.
          const code = doc.createElement('code');
          code.append(renderRichText(doc, block.content));
          element.append(code);
        } else {
          element.append(renderRichText(doc, block.content));
        }
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
      list.setAttribute(LIST_ATTR, '');

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
      // Plain text, because a real <input> would not survive most paste targets
      // — and the attribute beside it, because reading that text back is a
      // guess we should never have to make about our own output.
      item.setAttribute(TODO_ATTR, String(block.checked === true));
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

/**
 * Elements below which a wrapper's formatting is somebody else's to apply.
 *
 * Most of these become one block whose whole subtree `parseRichText` reads at
 * once — the roots the block readers hand it: `pushBlock` for a heading, a
 * paragraph, a list item or a quote, the cell reader for a table, the caption
 * of an image, the summary of a toggle. A wrapper inside one of those is read
 * where it stands, so copying its formatting around the runs beneath it would
 * apply it twice; only a wrapper *outside* the block needs a copy, which is
 * what `pushFormattingInward` exists to provide.
 *
 * `<details>` is here for a different reason with the same answer: its body is
 * re-visited as a copy of itself with the summary taken out, so a wrapper
 * inside is reached again there and pushed inward then — and the summary, read
 * from the original, never sees it at all.
 *
 * The elements the visitor descends *through* — `<div>`, `<section>`, a
 * `<figure>` with no usable image — are deliberately absent: their children are
 * read one block at a time, and a wrapper among them is this pass's to take.
 */
const SEALED_TAGS = new Set([
  ...Object.keys(HEADING_TYPES),
  'P',
  'LI',
  'BLOCKQUOTE',
  'PRE',
  'TD',
  'TH',
  'CAPTION',
  'FIGCAPTION',
  'SUMMARY',
  'DETAILS',
]);

/**
 * The first descendant of a kind, in document order, remembered per element.
 *
 * Both questions asked here — does this hold a block, where is its image — are
 * asked again at every level of a wrapper chain, because `visitBlocks` descends
 * into a wrapper and immediately asks them of the next one down. Answering by
 * scanning the subtree each time is quadratic in the depth of the chain, and
 * the depth is the pasted document's to choose: `<b>` nested 640 deep is four
 * kilobytes of clipboard. Every answer is derived from the answers about the
 * children, so a whole chain costs one walk instead of one per level.
 *
 * Keying the memo on the element is safe because every element it ever sees was
 * parsed into a detached template by `blocksFromHtml` moments earlier, or
 * cloned below — none of them is reachable by a caller who could edit it behind
 * this file's back. The moves made while distributing formatting keep the
 * answers true as well: a run only ever moves into a fresh shell beside it,
 * which adds no element of either kind and reorders nothing.
 */
function firstDescendant(
  element: Element,
  matches: (candidate: Element) => boolean,
  seen: WeakMap<Element, Element | null>,
): Element | null {
  const remembered = seen.get(element);

  if (remembered !== undefined) {
    return remembered;
  }

  interface Frame {
    element: Element;
    index: number;
    found: Element | null;
  }

  // An explicit stack rather than recursion: one frame per level of a hostile
  // chain is not a call stack to spend, and this walk is the deepest one here.
  const stack: Frame[] = [{ element, index: 0, found: null }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];

    if (!frame) {
      break;
    }

    // A hit ends the frame early; the children it skipped stay unanswered
    // until something asks about them directly.
    const child = frame.found ? undefined : frame.element.children[frame.index];

    if (!child) {
      seen.set(frame.element, frame.found);
      stack.pop();

      const parent = stack[stack.length - 1];

      if (parent && frame.found) {
        parent.found = frame.found;
      }

      continue;
    }

    frame.index += 1;

    // Checked before descending, so the answer is the first in document order.
    const known = matches(child) ? child : seen.get(child);

    if (known === undefined) {
      stack.push({ element: child, index: 0, found: null });
      continue;
    }

    if (known) {
      frame.found = known;
    }
  }

  return seen.get(element) ?? null;
}

const BLOCK_LEVEL_DESCENDANTS = new WeakMap<Element, Element | null>();
const IMAGE_DESCENDANTS = new WeakMap<Element, Element | null>();

function containsBlockLevel(element: Element): boolean {
  return (
    firstDescendant(
      element,
      (candidate) => BLOCK_LEVEL_TAGS.has(tagNameOf(candidate)),
      BLOCK_LEVEL_DESCENDANTS,
    ) !== null
  );
}

/** The image a `<figure>` or a wrapper shows, in the order a query would find it. */
function firstImage(element: Element): Element | null {
  return firstDescendant(element, (candidate) => tagNameOf(candidate) === 'IMG', IMAGE_DESCENDANTS);
}

function containsImage(element: Element): boolean {
  return firstImage(element) !== null;
}

/**
 * Whether the image here is one `pushImage` will actually take.
 *
 * Holding an `<img>` is not the same question: `pushImage` refuses a source
 * `sanitizeImageUrl` rejects — empty, `javascript:`, or a bare relative path —
 * and `visitBlocks` then recurses into the figure and splits it like anything
 * else. Sealing on the weaker question sealed a subtree that does get split.
 */
function hasUsableImage(element: Element): boolean {
  const image = tagNameOf(element) === 'IMG' ? element : firstImage(element);

  return sanitizeImageUrl(image?.getAttribute('src') ?? '') !== null;
}

/**
 * An element that only styles the content inside it, rather than laying it out.
 *
 * Its formatting travels down to the content inside, but only where a block is
 * there to receive it: an `<a>` around a lone `<img>` has nothing to push into
 * and a copy of it would only wrap the image again, for ever. A block element's
 * formatting stays behind either way — a copy of one placed around inline
 * content would read back as a line break.
 */
function isInlineWrapper(element: Element): boolean {
  const tag = tagNameOf(element);

  return !BLOCK_TAGS.has(tag) && (tag === 'A' || marksForElement(element).add.length > 0);
}

/**
 * Wrappers whose formatting is already in among the blocks they hold.
 *
 * The distribution takes up the whole chain at once, so the wrappers below the
 * top of it are spent by the time `visitBlocks` walks through them. Without
 * this they still read as formatting waiting to be pushed inward, and pushing
 * it again re-clones and rescans everything below them once per level — which
 * is the whole cost this pass exists to avoid, and would double the marks on
 * nothing.
 */
const DISTRIBUTED = new WeakSet<Element>();

/**
 * Whether descending into this element takes the walk out of the chain's reach.
 *
 * A `<figure>` around an image becomes the image, and only its caption is read
 * — from the caption element, so nothing above that is part of the parse. With
 * no image to show, the same figure is descended into block by block instead,
 * and a wrapper inside it is reached and pushed inward there.
 */
/** Whether the element is itself block-level, as opposed to merely holding one. */
function isBlockLevel(element: Element): boolean {
  return BLOCK_TAGS.has(tagNameOf(element));
}

function sealsFormatting(element: Element, tag: string): boolean {
  // A seal says `parseRichText` will read this whole subtree as one block's
  // text. For most of SEALED_TAGS that holds by construction, but `visitBlocks`
  // dispatches neither FIGCAPTION nor SUMMARY by name — holding a block, they
  // fall through to `containsBlockLevel` and are split like anything else. Left
  // sealed there, the same caption parsed differently depending only on whether
  // an inline wrapper happened to reach it first. `FIGURE` already carried this
  // qualification; these two needed the same one.
  // A `<summary>` is not among them, despite holding blocks the same way: it is
  // never reached by `visitBlocks` at all, because `visitDetails` strips it out
  // of the body clone and reads it whole with `parseRichText`. Unsealing it
  // split a toggle's title into marked / plain / marked around its own
  // indentation — the discontinuity the seal exists to prevent.
  if (tag === 'FIGCAPTION') {
    return !containsBlockLevel(element);
  }

  // `DETAILS` needs the same question asked of its BODY. `visitDetails` takes
  // the summary out and re-runs `visitBlocks` over what is left, so it is that
  // remainder which decides whether the subtree reads as one block — a block in
  // the summary says nothing about it, and asking of the whole element got the
  // two cases backwards.
  if (tag === 'DETAILS') {
    return ![...element.children].some(
      (child) =>
        tagNameOf(child) !== 'SUMMARY' && (isBlockLevel(child) || containsBlockLevel(child)),
    );
  }

  return SEALED_TAGS.has(tag) || (tag === 'FIGURE' && hasUsableImage(element));
}

/** What a chain of inline wrappers leaves on the content inside it. */
interface InlineFormatting {
  /** Each mark the chain mentioned, on or off as its outermost mention left it. */
  marks: Map<Mark, boolean>;
  /** The outermost anchor's href, or null where the chain holds no anchor. */
  link: string | null;
  /** Marks a container only implied, which a tag inside it may still overrule. */
  readonly soft: ReadonlySet<Mark>;
}

/**
 * That formatting, extended by one wrapper nested inside the chain.
 *
 * The wrapper nearest the content is not the one that wins. Each wrapper's copy
 * used to go around the runs the wrapper outside it had already wrapped, which
 * left the outermost formatting innermost and therefore last to be read — so an
 * inner element that turns a mark off never overrode the ancestor that turned it
 * on, and the outermost anchor kept the link. Whichever way round is more
 * defensible, it is the behaviour every paste has today, and this is a rewrite
 * of how the distribution runs, not of what it produces.
 */
function formattingWithin(
  format: InlineFormatting,
  wrapper: Element,
  weak = false,
): InlineFormatting {
  const marks = new Map(format.marks);
  const soft = new Set(format.soft);
  const { add, remove } = marksForElement(wrapper);

  // Nearest wrapper wins, except over a mark only a container implied: a
  // `<footer style="text-decoration: underline">` says nothing about
  // strikethrough, but the shorthand reads as turning it off, and locking that
  // in dropped the `<s>` inside it.
  const decide = (mark: Mark, on: boolean): void => {
    if (marks.has(mark) && !soft.has(mark)) {
      return;
    }

    marks.set(mark, on);

    if (weak) {
      soft.add(mark);
    } else {
      soft.delete(mark);
    }
  };

  for (const mark of remove) {
    decide(mark, false);
  }

  for (const mark of add) {
    decide(mark, true);
  }

  // An anchor without an href stands for one whose link is dropped, exactly as
  // a copy of it would have: `sanitizeUrl` refuses the empty string.
  const href = tagNameOf(wrapper) === 'A' ? (wrapper.getAttribute('href') ?? '') : null;

  return { link: format.link ?? href, marks, soft };
}

/**
 * The inline style that turns off every mark the chain turned off.
 *
 * A wrapper says "not bold" the way Google Docs does, with a style rather than
 * a tag, so the copy that stands in for it has to say it the same way — and it
 * has to say it at all, because the wrappers between this run and the block it
 * sits in are still there and may well be turning that mark back on.
 *
 * `marksForElement` reads underline and strikethrough out of one declaration,
 * so a chain that turns either off has by then decided both, and writing the
 * pair out together says exactly what it decided.
 */
function formattingOff(marks: Map<Mark, boolean>, soft: ReadonlySet<Mark>): string {
  const off: string[] = [];

  // A soft mark is one a container only implied — `text-decoration: underline`
  // reads as strikethrough OFF, which is an artefact of the shorthand, not a
  // decision. Writing it into the shell as an explicit declaration puts it
  // deeper in the tree than a tag still standing outside, where it wins and
  // cancels that tag: the same `<s>`-swallowing this weak/firm split exists to
  // prevent, reappearing at the emission end after being fixed at the
  // accumulation end.
  const decided = (mark: Mark): boolean | undefined =>
    soft.has(mark) ? undefined : marks.get(mark);

  if (decided('bold') === false) {
    off.push('font-weight:normal');
  }

  if (decided('italic') === false) {
    off.push('font-style:normal');
  }

  if (decided('underline') === false || decided('strikethrough') === false) {
    const lines = [
      marks.get('underline') === true ? 'underline' : '',
      marks.get('strikethrough') === true ? 'line-through' : '',
    ].filter((line) => line.length > 0);

    off.push(`text-decoration:${lines.length > 0 ? lines.join(' ') : 'none'}`);
  }

  return off.join(';');
}

/**
 * The elements that put a chain's formatting around one run, or null for none.
 *
 * One element per mark still on, rather than one copy per wrapper: `<b>` inside
 * `<b>` inside `<b>` says nothing the outermost one did not, so copying every
 * wrapper around every run makes the output quadratic in a nesting depth the
 * paste chose for free. `parseRichText` sorts and dedupes the marks it reads,
 * which is what makes these canonical elements indistinguishable from the
 * copies they stand in for.
 */
function formattingShell(
  doc: Document,
  format: InlineFormatting,
): { outer: Element; inner: Element } | null {
  const parts: Element[] = [];
  const off = formattingOff(format.marks, format.soft);

  if (off.length > 0) {
    const span = doc.createElement('span');

    // Outermost of the copy, so the marks still on are applied after it.
    span.setAttribute('style', off);
    parts.push(span);
  }

  if (format.link !== null) {
    const anchor = doc.createElement('a');

    // Deliberately unsanitized: `parseRichText` is the one place an href
    // becomes a link, and it drops an unsafe one there exactly as it would
    // have from the wrapper this stands in for.
    anchor.setAttribute('href', format.link);
    parts.push(anchor);
  }

  for (const [mark, tag] of MARK_ELEMENTS) {
    if (format.marks.get(mark) === true) {
      parts.push(doc.createElement(tag));
    }
  }

  const outer = parts[0];

  if (!outer) {
    return null;
  }

  let inner = outer;

  for (const part of parts.slice(1)) {
    inner.append(part);
    inner = part;
  }

  return { inner, outer };
}

/**
 * Moves the formatting of an inline wrapper — and of every wrapper nested
 * inside it — in among the blocks they hold: `<b><p>x</p></b>` becomes
 * `<p><b>x</b></p>`.
 *
 * Descending into the wrapper is the only way to see those blocks, and
 * `visitBlocks` reads formatting from each block's own subtree — so without
 * this, descending would silently drop the marks (or href) the wrapper carried.
 * The copy goes around each innermost run of inline content, which leaves the
 * document's own formatting nested inside it and therefore winning.
 *
 * The whole chain is distributed in one pass: every wrapper nested inside this
 * one has its formatting taken up here and is marked spent, so `visitBlocks`
 * walks through it without finding formatting to push inward all over again.
 * Handing back a fragment still topped by the next wrapper sent `visitBlocks`
 * straight back in here to clone and rescan the rest of the subtree one level
 * down: three nested walks over the same nodes, which a `<b>` chain 640 deep
 * turned into eleven seconds of frozen tab, synchronously on the paste event.
 */
function pushFormattingInward(doc: Document, wrapper: Element): DocumentFragment {
  const fragment = doc.createDocumentFragment();

  // A structure element is a container that happens to carry a style, not a
  // formatting wrapper: `<footer style="text-decoration: underline">` describes
  // the footer, and an explicit `<s>` inside it still means struck. Its marks
  // are therefore contributed weakly — they apply, but a tag inside may
  // overrule them. Taken as firmly as a wrapper's own, the footer's shorthand
  // (underline on, strikethrough off) silently swallowed that `<s>`.
  const empty: InlineFormatting = { link: null, marks: new Map(), soft: new Set() };
  const format = formattingWithin(empty, wrapper, STRUCTURE_TAGS.has(tagNameOf(wrapper)));

  fragment.append(...[...(wrapper.cloneNode(true) as Element).childNodes]);
  distributeFormatting(doc, fragment, format, false);

  return fragment;
}

/**
 * Puts a copy of the chain's formatting around each run of inline content
 * below `parent`, in place.
 *
 * `sealed` says the walk is already inside an element that will be read as one
 * block, whose whole subtree `parseRichText` sees at once. From there down, a
 * wrapper still standing is read where it stands, so its formatting must not be
 * copied around the runs beneath it as well — the copies exist for the runs a
 * block boundary would otherwise cut a wrapper off from.
 *
 * Nothing moves that does not have to: a shell goes in beside the run it takes,
 * and every other node keeps the parent it had. Rebuilding a child list instead
 * re-parents the whole subtree hanging off it, once per level of the chain,
 * which is a different route back to quadratic.
 */
/** A text node holding nothing but source layout. */
function isSourceWhitespace(node: Node): boolean {
  return node.nodeType !== ELEMENT_NODE && (node.nodeValue ?? '').trim().length === 0;
}

/**
 * The tags `visitBlocks` turns into a block by name, whatever they contain.
 *
 * This is a second copy of a decision `visitBlocks` makes in its own dispatch,
 * and it has drifted from it three times — each time by omitting tags, and each
 * time silently, because the shapes the tests happened to use were the ones
 * still covered. `startsBlock agrees with visitBlocks` in the tests walks every
 * entry here and fails if the two ever disagree again.
 */
const STANDALONE_BLOCK_TAGS = new Set([
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'DETAILS',
  'PRE',
  'TABLE',
  'FIGURE',
  'IMG',
  'HR',
  'P',
]);

/**
 * Whether `visitBlocks` will begin a new block here rather than read it inline.
 *
 * The run has to be closed at every structure element, but whitespace before
 * one is only source layout when a block really starts there — that is the one
 * case `visitBlocks` discards it. `<summary>`, `<figcaption>`, `<td>` and
 * `<tr>` are structure tags that hold no block of their own, so they are read
 * as inline content of the same block: dropping the whitespace in front of one
 * deleted the separator between two runs, or left it behind stripped of the
 * wrapper's marks.
 */
function startsBlock(element: Element, tag: string): boolean {
  // Deliberately not BLOCK_TAGS: `FIGCAPTION`, `TD` and `TR` are in it, but
  // `visitBlocks` buffers them as inline content when they hold no block of
  // their own — which is exactly when the whitespace in front of one is the
  // separator between two runs rather than layout to discard.
  return (
    CONTAINER_TAGS.has(tag) ||
    STANDALONE_BLOCK_TAGS.has(tag) ||
    containsBlockLevel(element) ||
    containsImage(element)
  );
}

/** Source layout a formatter left behind, as opposed to a space someone typed. */
function isIndentation(node: Node): boolean {
  return isSourceWhitespace(node) && (node.nodeValue ?? '').includes('\n');
}

function distributeFormatting(
  doc: Document,
  parent: Node,
  format: InlineFormatting,
  sealed: boolean,
): void {
  /** The inline nodes waiting for a copy of the formatting around them. */
  let run: Node[] = [];

  // One copy around the whole run, not one per node: a space between two
  // elements would read as separating blocks once it had a copy of its own,
  // and be dropped as indentation.
  const wrapRun = (atBlock: boolean): void => {
    // Trailing indentation is no more content than leading indentation. Two
    // things narrow it, because distributing a wrapper has to produce what
    // writing it inside each block by hand produces — this function's stated
    // contract — and a broader rule broke that:
    //
    //   * only where a block boundary ended the run. At the parent's final
    //     flush the whitespace IS the block's whole content, and popping it
    //     left `<b><div>A</div><div><br> </div><div>B</div></b>` a block short.
    //   * only whitespace carrying a line break. That is what pretty-printing
    //     leaves behind; a bare space between two elements is the author's, and
    //     hand-writing keeps it.
    //   * never inside a sealed block. There `parseRichText` reads the whole
    //     subtree as one block's text, so nothing in it is invisible layout:
    //     popped out of the shell, the whitespace came back stripped of the
    //     wrapper's marks and href and split one run into three — a pasted
    //     table cell read `Cell` bold, `\n` plain, `para` bold.
    while (atBlock && !sealed && run.length > 0 && isIndentation(run[run.length - 1]!)) {
      run.pop();
    }

    const first = run[0];
    const nodes = run;

    run = [];

    const shell = first ? formattingShell(doc, format) : null;

    if (!first || !shell) {
      return;
    }

    parent.insertBefore(shell.outer, first);

    for (const node of nodes) {
      shell.inner.append(node);
    }
  };

  for (const child of [...parent.childNodes]) {
    const element = child.nodeType === ELEMENT_NODE ? (child as Element) : null;
    const tag = element ? tagNameOf(element) : '';

    if (element && (STRUCTURE_TAGS.has(tag) || containsBlockLevel(element))) {
      wrapRun(startsBlock(element, tag));

      // A wrapper of its own hands its formatting to the chain here and is
      // marked as spent — unless the walk is sealed, where it is read where it
      // stands and has nothing to hand over. Either way it stays exactly where
      // and what it was: `visitBlocks` starts a new paragraph at an element
      // holding blocks, so the content on either side of one must not run
      // together, and a block parsed whole still reads its tag and style.
      if (!STRUCTURE_TAGS.has(tag) && isInlineWrapper(element)) {
        if (sealed) {
          distributeFormatting(doc, element, format, true);
        } else {
          distributeFormatting(doc, element, formattingWithin(format, element), false);
          DISTRIBUTED.add(element);
        }

        continue;
      }

      distributeFormatting(doc, element, format, sealed || sealsFormatting(element, tag));
      continue;
    }

    // Indentation between two blocks joins a run already under way, but never
    // starts one — on its own it is source formatting, not content.
    if (run.length === 0 && isSourceWhitespace(child)) {
      continue;
    }

    run.push(child);
  }

  wrapRun(false);
}

/** What to walk when descending into an element that is not a block itself. */
function contentsOf(doc: Document, element: Element): Node {
  return !DISTRIBUTED.has(element) && isInlineWrapper(element) && containsBlockLevel(element)
    ? pushFormattingInward(doc, element)
    : element;
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
/**
 * First descendant matching `match`, not descending into anything `skip` hides.
 *
 * The pruning is the point: `querySelectorAll` over the whole subtree once per
 * nesting level is the quadratic term this file exists to avoid.
 */
function findWithin(
  root: Element,
  skip: SkipPredicate,
  match: (element: Element) => boolean,
): Element | null {
  for (const child of root.children) {
    const tag = tagNameOf(child);

    if (SKIP_TAGS.has(tag) || skip(child, tag)) {
      continue;
    }

    if (match(child)) {
      return child;
    }

    const deeper = findWithin(child, skip, match);

    if (deeper) {
      return deeper;
    }
  }

  return null;
}

/**
 * Emits one block, empty or not.
 *
 * An empty `<p>` is a blank line the author put there, and the clipboard is a
 * round trip: `blocksToHtml` writes an empty block as an empty element, so
 * dropping it here loses a paragraph, heading or quote on every copy-paste.
 */
function pushBlock(out: Block[], type: BlockType, element: Element, depth: number): void {
  const runs = parseRichText(element, isNestedList);

  out.push(createBlock(type, runs, depthOf(element, depth)));
}

/** Our own serializer records depth explicitly; other sources have none. */
function depthOf(element: Element, fallback: number): number {
  const declared = Number.parseInt((element as HTMLElement).dataset?.neditorDepth ?? '', 10);

  return Number.isFinite(declared) && declared >= 0 ? declared : fallback;
}

function pushCallout(out: Block[], element: Element, depth: number, icon: string): void {
  const runs = parseRichText(element, isNestedList);
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
/** Everything left below the bound, as one block rather than none. */
function pushRemainder(out: Block[], node: Node, depth: number): void {
  const text = subtreeText(node);

  if (text.trim().length > 0) {
    out.push(createBlock('paragraph', text, depth));
  }
}

function visitDetails(doc: Document, element: Element, depth: number, out: Block[]): void {
  const summary = element.querySelector('summary');
  const block = createBlock(
    'toggle',
    summary ? parseRichText(summary) : [],
    depthOf(element, depth),
  );
  block.collapsed = !element.hasAttribute('open');
  out.push(block);

  // The summary is skipped by identity rather than removed from a copy: a
  // <details> holds every nested <details> below it, so cloning one per level
  // was quadratic in the nesting depth exactly as the list case was.
  visitBlocks(doc, element, block.depth + 1, out, summary ?? undefined);
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
    icon === null && lists.length > 0 && isRichEmpty(parseRichText(element, isNestedList));

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
  // The remembered answer, not a fresh query: a `<figure>` with nothing usable
  // in it is asked this again for every wrapper the visitor descends through on
  // its way down, and a query walks the whole subtree each time.
  const image = tagNameOf(element) === 'IMG' ? element : firstImage(element);
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

/**
 * @param declared Whether the enclosing list is one we wrote, in which case
 * every to-do in it carries {@link TODO_ATTR} and the textual checkbox is
 * decoration rather than a signal to be read back.
 */
function visitListItem(
  item: Element,
  fallback: BlockType,
  depth: number,
  out: Block[],
  declared = false,
): void {
  // `visitList` and `visitListItem` call each other without passing through
  // `visitBlocks`, so the bound has to be taken here as well or a nested list
  // walks straight past `MAX_BLOCK_NESTING` entirely.
  if (listNesting >= MAX_LIST_NESTING) {
    pushRemainder(out, item, depthOf(item, depth));
    return;
  }

  listNesting += 1;

  try {
    visitListItemInner(item, fallback, depth, out, declared);
  } finally {
    listNesting -= 1;
  }
}

function visitListItemInner(
  item: Element,
  fallback: BlockType,
  depth: number,
  out: Block[],
  declared: boolean,
): void {
  const itemDepth = depthOf(item, depth);
  const nested = childLists(item);
  const checkbox = findWithin(
    item,
    isNestedList,
    (element) => tagNameOf(element) === 'INPUT' && element.getAttribute('type') === 'checkbox',
  );
  const state = item.getAttribute(TODO_ATTR);
  let runs = parseRichText(item, isNestedList);
  let type = fallback;
  let checked = false;

  if (state !== null) {
    // Our own marker: exact, and the text still carries the box we wrote.
    type = 'todo';
    checked = state === 'true';
    runs = extractTodoPrefix(runs)?.runs ?? runs;
  } else if (checkbox) {
    type = 'todo';
    checked = (checkbox as HTMLInputElement).checked || checkbox.hasAttribute('checked');
  } else if (!declared) {
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
  const declared = list.hasAttribute(LIST_ATTR);

  for (const child of list.children) {
    if (tagNameOf(child) === 'LI') {
      visitListItem(child, fallback, depth, out, declared);
    }
  }
}

/**
 * Walks a subtree, emitting one block per block-level element.
 *
 * Inline nodes between block elements are buffered and flushed as a paragraph,
 * so stray text at the top level is not silently dropped.
 */
function visitBlocks(doc: Document, node: Node, depth: number, out: Block[], exclude?: Node): void {
  if (blockNesting >= MAX_BLOCK_NESTING) {
    pushRemainder(out, node, depth);
    return;
  }

  blockNesting += 1;

  try {
    visitBlocksInner(doc, node, depth, out, exclude);
  } finally {
    blockNesting -= 1;
  }
}

function visitBlocksInner(
  doc: Document,
  node: Node,
  depth: number,
  out: Block[],
  exclude?: Node,
): void {
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
    if (child === exclude) {
      continue;
    }

    if (child.nodeType === TEXT_NODE) {
      if ((child.nodeValue ?? '').trim().length > 0) {
        buffer.push(child);
      }

      continue;
    }

    if (child.nodeType !== ELEMENT_NODE) {
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
        visitBlocks(doc, element, depth, out, exclude);
      }

      continue;
    }

    // <a href><img> and <p><img> are the commonest image markup on the web.
    // Without this the image is buffered as inline content and emits nothing.
    if (containsImage(element)) {
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
      visitBlocks(doc, element, depth, out, exclude);
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
  // Reset rather than trust the last run: an exception thrown out of a walk
  // unwinds the try/finally pairs, but a future caller that catches one would
  // otherwise inherit a counter that never came back to zero.
  blockNesting = 0;
  listNesting = 0;
  inlineNesting = 0;
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
