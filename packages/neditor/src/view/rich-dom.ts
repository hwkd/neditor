import type { Block, BlockType } from '../model/document.ts';
import { DEFAULT_CALLOUT_ICON, computeListNumbers, createBlock } from '../model/document.ts';
import type { Mark, RichText, TextRun } from '../model/rich-text.ts';
import {
  isRichEmpty,
  normalizeRuns,
  richDelete,
  richLength,
  richToPlainText,
} from '../model/rich-text.ts';
import type { TableRows } from '../model/table.ts';
import { normalizeTableRows } from '../model/table.ts';
import { normalizeControlCharacters } from '../input/line-breaks.ts';
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
const COMMENT_NODE = 8;
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
    // A link's underline is how links look, not a mark on its text: Google
    // Docs underlines a span inside every `<a>`, and Chromium and WebKit copy
    // a link out of this editor with its computed `text-decoration` inlined,
    // so a pasted link came back underlined too and its Markdown read
    // `[<u>docs</u>](…)`. Neither direction is read on or inside an `<a href>`
    // -- its `none` says nothing either -- and a `<u>` there is still one.
    if (!inLink(element)) {
      set('underline', decoration.includes('underline'));
    }

    set('strikethrough', decoration.includes('line-through'));
  }

  return { add: [...add], remove: [...remove] };
}

const IN_LINK = new WeakMap<Element, boolean>();

/**
 * Whether an element is an `<a href>` or inside one. Remembered per element
 * and filled in down the chain, as {@link whiteSpaceOf} is, so a deep chain of
 * styled spans is walked once rather than once per span.
 */
function inLink(element: Element): boolean {
  const chain: Element[] = [];
  let inside = false;

  for (let at: Element | null = element; at; at = at.parentElement) {
    const known = IN_LINK.get(at);

    if (known !== undefined) {
      inside = known;
      break;
    }

    chain.push(at);
  }

  for (const at of chain.reverse()) {
    inside ||= tagNameOf(at) === 'A' && at.hasAttribute('href');
    IN_LINK.set(at, inside);
  }

  return inside;
}

/* -------------------------------------------------------------------------- */
/* Render                                                                      */
/* -------------------------------------------------------------------------- */

function renderRun(doc: Document, run: TextRun, breaks: boolean): Node {
  let node: Node = doc.createTextNode(run.text);

  if (breaks && run.text.includes('\n')) {
    const lines = doc.createDocumentFragment();

    for (const [index, line] of run.text.split('\n').entries()) {
      if (index > 0) {
        lines.append(doc.createElement('br'));
      }

      if (line.length > 0) {
        lines.append(doc.createTextNode(line));
      }
    }

    node = lines;
  }

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
 *
 * `breaks` writes each line break as a `<br>` rather than a newline, for HTML
 * that leaves this editor: its own view draws a newline under `pre-wrap`, but
 * any other application collapses one in a paragraph to a space.
 */
export function renderRichText(
  doc: Document,
  content: readonly TextRun[],
  breaks = false,
): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  let last: TextRun | undefined;

  for (const run of content) {
    if (run.text.length > 0) {
      fragment.append(renderRun(doc, run, breaks));
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

/** How {@link richTextToHtml} writes a range. */
export interface RichTextHtmlOptions {
  /**
   * The range is from a code block: it is written as one, a `<pre>` exactly
   * as `blocksToHtml` writes the block, so another application shows it as
   * code and this reader reads it back as a code block.
   */
  readonly code?: boolean;
}

/**
 * Serializes a range of one block's text for the clipboard.
 *
 * The runs as `renderRichText` draws them, with no block element around them:
 * a text-range copy is a phrase, so it lands inline wherever it is pasted.
 * Each newline becomes a `<br>`, because every other application reads this
 * HTML under `white-space: normal`, where a bare newline is a space. The filler
 * `renderRichText` appends after a final newline stays: `parseRichText` reads a
 * trailing `<br>` as nothing, so it is what keeps the newline before it.
 *
 * The phrase is held in an inline element marked `white-space: pre-wrap`, as
 * the block writer marks every element that holds text: left unmarked, a run
 * of spaces, a tab, an indent or an edge space was collapsed by every other
 * application, and by this reader whenever WebKit drops our own type between
 * origins -- `def f():` + newline + `    return  1` came back unindented.
 */
export function richTextToHtml(
  doc: Document,
  content: readonly TextRun[],
  options: RichTextHtmlOptions = {},
): string {
  if (options.code) {
    return blocksToHtml(doc, [
      { id: 'range', type: 'code', depth: 0, content: content.map((run) => ({ text: run.text })) },
    ]);
  }

  const host = doc.createElement('span');
  host.style.whiteSpace = 'pre-wrap';
  host.append(renderRichText(doc, content));

  // NodeFilter.SHOW_TEXT, spelled out: the constant belongs to a realm, and
  // the document may be another one's.
  const walker = doc.createTreeWalker(host, 4);
  const texts: Text[] = [];

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    texts.push(node as Text);
  }

  for (const text of texts) {
    const lines = text.data.split('\n');

    if (lines.length === 1) {
      continue;
    }

    const parts: Node[] = [];

    lines.forEach((line, index) => {
      if (index > 0) {
        parts.push(doc.createElement('br'));
      }

      if (line.length > 0) {
        parts.push(doc.createTextNode(line));
      }
    });

    text.replaceWith(...parts);
  }

  return host.outerHTML;
}

/* -------------------------------------------------------------------------- */
/* Parse                                                                       */
/* -------------------------------------------------------------------------- */

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

/**
 * True when real content follows this node's own subtree.
 *
 * A trailing `<br>` is the filler contenteditable appends to keep an empty
 * line selectable; it is presentation, not content, and must not become a
 * newline. Only a `<br>` asks: a block's own line breaks are deferred until
 * text arrives (see `breakLine`). Every `<br>`, whatever follows it, makes the
 * deferred break before it stand -- after a block it is a blank line, not the
 * filler at the end of one.
 */
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

    // Whitespace between block tags is formatting, not content -- but a
    // no-break space is content, which `trim` would take for whitespace, and
    // so is any whitespace a style preserves: under `pre-wrap` the spaces
    // after a `<br>` are a line of their own, which is how this package's
    // writer spells a block ending in a break and a space.
    if (
      current.nodeType === TEXT_NODE &&
      (/[^ \t\n\r\f]/.test(current.nodeValue ?? '') ||
        ((current.nodeValue ?? '').length > 0 && whiteSpaceOf(current.parentElement) === 'pre'))
    ) {
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
    sibling !== null && sibling.nodeType === ELEMENT_NODE && startsLine(sibling as Element);
  const edge = (sibling: Node | null): boolean => sibling === null || isBlock(sibling);
  const previous = node.previousSibling;
  const next = node.nextSibling;

  return (isBlock(previous) || isBlock(next)) && edge(previous) && edge(next);
}

/**
 * Breaks that only stand if text follows them: `parseRichText` drops one with
 * no text after it once the walk is done, rather than every skipped block
 * looking ahead through the rest of the subtree for itself.
 */
const DEFERRED_BREAKS = new WeakSet<TextRun>();

/** The space a skipped inline element leaves, kept only between two words. */
const SKIPPED_SPACES = new WeakSet<TextRun>();

/** Blank paragraphs a lone `<br>` made between blocks; trimmed at a paste's ends. */
const BLANK_LINES = new WeakSet<Block>();

/**
 * The `<details>` a copy starts in without its summary, read as containers
 * rather than toggles ({@link dropSelectionEdges}).
 */
const HEADLESS_DETAILS = new WeakSet<Element>();

/**
 * Whether an element starts and ends a line of text: what `BLOCK_TAGS` names,
 * and everything a browser lays out as a block -- `<center>`, `<address>`,
 * `<aside>` and the rest, whose text otherwise ran into its neighbours'.
 */
function breaksLine(tag: string): boolean {
  return BLOCK_TAGS.has(tag) || DISPLAY_BLOCK_TAGS.has(tag);
}

const SOLID_RUNS = new WeakMap<TextRun[], { checked: number; solid: number }>();

/**
 * The last run holding more than collapsible spaces. Remembered per output as
 * it grows, so a long stretch of such runs is looked at once, not per break.
 */
function lastSolidRun(out: TextRun[]): TextRun | undefined {
  const memo = SOLID_RUNS.get(out) ?? { checked: 0, solid: -1 };

  for (; memo.checked < out.length; memo.checked += 1) {
    if (!/^[ \t\r\f]*$/.test(out[memo.checked]!.text)) {
      memo.solid = memo.checked;
    }
  }

  SOLID_RUNS.set(out, memo);

  return memo.solid === -1 ? undefined : out[memo.solid];
}

/** Appends a newline unless the output is empty or already ends with one. */
function breakLine(
  out: TextRun[],
  marks: Mark[],
  link: string | undefined,
  deferred = false,
): void {
  // While whitespace is collapsed, source whitespace is a run of its own and
  // no content: a break after `<br>` + layout, or beside an element holding
  // only spaces, looks past it -- or it added a line no browser shows.
  const previous = collapsing || collapsingSource ? lastSolidRun(out) : out.at(-1);

  // Matches a newline followed by any trailing whitespace, so a run ending
  // "\n  " still counts as already broken. (trimEnd would strip the newline
  // being looked for and defeat the check entirely.)
  if (previous && !/\n[^\S\n]*$/.test(previous.text)) {
    const run = { text: '\n', marks: [...marks], link };

    if (deferred) {
      DEFERRED_BREAKS.add(run);
    }

    out.push(run);
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
 * The first and last text of the paste `blocksFromHtml` is reading, other than
 * layout, each with its ancestors: wherever it sits -- loose at the root or
 * inside the first or last block, as Firefox puts a selected edge space -- the
 * run holding one is at the paste's edge, which lands mid-line. Collected once
 * per paste, so a run asks in the time it takes to look at its own nodes.
 */
let pasteFirst = new Set<Node>();
let pasteLast = new Set<Node>();

/**
 * Whether inline content has started a line that nothing has ended yet -- the
 * text an inline wrapper holding blocks ends with, or an inline image -- so a
 * `<br>` run after it ends that line rather than making a blank one.
 */
let lineOpen = false;

/** Set while `collapseWhitespace` parses, the only reader of its marks. */
let collapsing = false;

/**
 * Set while {@link readBlockText} parses a block whose whitespace a browser
 * collapses: `walk` then reads each run of source whitespace as one space,
 * without touching the tree it reads.
 */
let collapsingSource = false;

/**
 * Whether every block's text is read as it stands, as the reader did before
 * the writer marked its blocks `white-space: pre-wrap`: that writer put a soft
 * line break in a block as a raw newline. Set for `whitespace: 'preserve'`,
 * and for HTML that is recognisably that writer's (see `blocksFromHtml`).
 */
let legacyOwnHtml = false;

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

/**
 * A code block's text: `subtreeText`, except that a block inside it -- a
 * `<div>` per line, or a flex or grid item (see `startsLine`) -- is a line of
 * its own, joined to its neighbours by a newline wherever none already
 * separates them, and the whitespace between flex or grid items is not
 * drawn. Each text's line is its nearest such ancestor, remembered as the
 * walk goes so a deep tree is climbed once. A `<br>` is a newline where text
 * follows it on its line; the last one before a line ends, or before the
 * end, is that line's filler, as `parseRichText` reads one.
 */
function codeText(root: Element): string {
  // Inside code, a block that declares itself inline is drawn in its line:
  // Stripe wraps each linked API parameter in a `display: inline` <div>.
  const isCodeLine = (element: Element): boolean =>
    startsLine(element, true) && (isItem(element) || displayOf(element).outer !== 'inline');
  const lineOf = new Map<Node, Node | null>();
  const findLine = (node: Node): Node | null => {
    const chain: Node[] = [];
    let found: Node | null | undefined;

    let at: Node | null = node;

    while (found === undefined) {
      if (at === null || at === root) {
        found = null;
      } else if (lineOf.has(at)) {
        found = lineOf.get(at);
      } else if (at.nodeType === ELEMENT_NODE && isCodeLine(at as Element)) {
        found = at;
      } else {
        chain.push(at);
        at = at.parentNode;
      }
    }

    for (const at of chain) {
      lineOf.set(at, found ?? null);
    }

    return found ?? null;
  };

  const walker = root.ownerDocument.createTreeWalker(root, SHOW_TEXT | SHOW_ELEMENT, {
    acceptNode: (candidate) => {
      const tag = tagNameOf(candidate);

      return SKIP_TAGS.has(tag)
        ? FILTER_REJECT
        : candidate.nodeType === TEXT_NODE || tag === 'BR'
          ? FILTER_ACCEPT
          : FILTER_SKIP;
    },
  });
  let text = '';
  let lastLine: Node | null = null;
  // Whether the current line holds text not yet ended, and how many `<br>`s
  // stand on it since: the last of them ends it, so it is not one of its own.
  let open = false;
  let breaks = 0;

  for (let found = walker.nextNode(); found !== null; found = walker.nextNode()) {
    const isBreak = found.nodeType !== TEXT_NODE;
    const value = isBreak ? '' : (found.nodeValue ?? '');

    if (
      !isBreak &&
      (value === '' || (laysOutItems(found.parentNode) && !/[^ \t\n\r\f]/.test(value)))
    ) {
      continue;
    }

    const line = findLine(found);

    if (line !== lastLine) {
      // Leaving a line ends it once: its own last `<br>` does, or a newline.
      if (breaks > 0) {
        text += '\n'.repeat(breaks);
      } else if (open) {
        text += '\n';
      }

      open = false;
      breaks = 0;
      lastLine = line;
    }

    if (isBreak) {
      breaks += 1;
      continue;
    }

    // Text after `<br>`s on the same line: every one of them stands.
    text += '\n'.repeat(breaks) + value;
    breaks = 0;
    open = !text.endsWith('\n');
  }

  // The last `<br>` of all is the filler of the line it ends; with none, the
  // last newline ends the last line and draws none of its own -- nor does a
  // CR, vertical tab or form feed there, each a line break once the text is
  // cleaned (`normalizeControlCharacters`), as in any other block (R5-FMT-5).
  if (breaks > 0) {
    return text + '\n'.repeat(breaks - 1);
  }

  return text.replace(/(?:\r\n?|[\n\v\f])$/, '');
}

/**
 * A text node's source as {@link readBlockText} reads it while it collapses a
 * block: under `normal` each run of whitespace is one collapsible space; what
 * `pre` preserves, and the line breaks `pre-line` keeps, are marked so the
 * collapsing pass leaves them (the marks {@link collapseWhitespace} uses), and
 * so is a converted space. Asked per text node, by its own parent's style: a
 * block whose one inline element said `pre` used to be read raw throughout,
 * source indentation and all.
 *
 * A vertical tab, and a form feed that is not collapsed, is a line break (see
 * `normalizeControlCharacters`), marked as `pre-line`'s are: one that ends
 * the text ends its last line and draws none, where a bare `\n` would be
 * read as a `<br>` and stand (R4-FMT-6c).
 */
function sourceWhitespace(raw: string, mode: WhiteSpace, converted: boolean): string {
  const value = raw.replace(/[\uFDD0-\uFDD5]/g, (char) => LITERAL + char);
  const laid = (
    mode === 'pre'
      ? value.replace(/[ \t\n]/g, (char) => PRESERVED[char]!)
      : mode === 'pre-line'
        ? value
            .split('\n')
            .map((line) => line.replace(/[ \t\r\f]+/g, ' '))
            .join(LINE_BREAK)
        : value.replace(/[ \t\n\r\f]+/g, ' ')
  ).replace(/[\v\f]/g, LINE_BREAK);

  return converted ? laid.replace(/\u00a0/g, PRESERVED[' ']!) : laid;
}

/**
 * One text node's run, for {@link walk}: kept out of it because `walk`
 * recurses once per element, and every local it holds is paid for at every
 * level of the deepest tree it reads.
 */
function walkText(
  child: Node,
  parent: Node,
  marks: Mark[],
  link: string | undefined,
  out: TextRun[],
): void {
  // Safari writes a space at an element boundary as `&nbsp;` inside this span
  // when it copies. The class is its own record that the character was an
  // ordinary space, so it is read back as one; every other `&nbsp;` is kept.
  // A run of them -- the `&nbsp; &nbsp;` WebKit writes for three spaces -- or
  // one beside another space is a space that was drawn, so where whitespace
  // is being collapsed it is marked preserved: converted first and collapsed
  // second, three came back as one. A lone one is not: WebKit writes the
  // space it did not draw, at the end of a line or a block, the same way, and
  // kept, `Title ` arrived with a space no one could see.
  const convertedSpace =
    parent.nodeType === ELEMENT_NODE &&
    ((parent as Element).getAttribute('class') ?? '')
      .split(/\s+/)
      .includes('Apple-converted-space');
  const drawnRun = convertedSpace && isDrawnConvertedSpace(parent as Element);
  const value = child.nodeValue ?? '';
  // A lone converted space is an ordinary space from the start.
  const raw = convertedSpace && !drawnRun ? value.replace(/\u00a0/g, ' ') : value;
  const converted = convertedSpace ? raw.replace(/\u00a0/g, ' ') : raw;
  const text = collapsingSource
    ? sourceWhitespace(raw, whiteSpaceOf(child.parentElement), drawnRun)
    : drawnRun
      ? raw.replace(/\u00a0/g, collapsing ? PRESERVED[' ']! : ' ')
      : raw;

  // Indentation between block elements is source formatting, not content.
  // Without this, pretty-printed HTML pastes with blank leading lines. A
  // no-break space is content, though `trim` would take it for layout.
  if (!/[^ \t\n\r\f]/.test(converted) && isBetweenBlocks(child)) {
    return;
  }

  if (text.length > 0) {
    out.push({ text, marks: [...marks], link });

    if (/[^ \t\n\r\f\u200b]/.test(converted)) {
      solidTexts += 1;
    }
  }
}

function walk(
  node: Node,
  marks: Mark[],
  link: string | undefined,
  root: Node,
  out: TextRun[],
  skip?: SkipPredicate,
): void {
  // Where the last of these drawn apart from its neighbour ended.
  let apartEnd = -1;

  for (const child of [...node.childNodes]) {
    if (child.nodeType === TEXT_NODE) {
      walkText(child, node, marks, link, out);
      continue;
    }

    if (tagNameOf(child) === 'BR') {
      // A line ended by a block has its break waiting for text; a `<br>`
      // after it is a line of its own, so that break stands -- whether more
      // follows (each of several blank lines) or not (the last of them).
      // With nothing after it and no block before, it is the filler of the
      // line before, and adds nothing.
      const last = out.at(-1);

      if (last) {
        DEFERRED_BREAKS.delete(last);
      }

      if (hasContentAfter(child, root, skip)) {
        out.push({ text: '\n', marks: [...marks], link });
      } else if (collapsing) {
        // Nor is it filler after a line break a style preserved, however much
        // collapsible space sits between: the break is a line of its own then,
        // as after a block, and `collapseWhitespace` must not take it for the
        // end of the text. Only it reads the mark, so only it is given one.
        out.push({ text: STANDS, marks: [...marks], link });
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

    // A block skipped here is read elsewhere, but it still stands between the
    // text on either side of it: `<li>a<ul>…</ul>c</li>` read `ac`. Deferred,
    // because whether text follows is only known once the walk gets there.
    if (skip?.(element, tag) === true) {
      // A block breaks the line here as anywhere (`breaksLine`: a figure and a
      // rule included), and so does a link holding one; an image, linked or
      // not, does not.
      if (startsLine(element) || containsBlockLevel(element)) {
        breakLine(out, marks, link, true);
      } else if (/[ \t\n\r\f]/.test(subtreeText(element))) {
        // An inline one -- an image link -- keeps the space its whitespace
        // made in the sentence, or the words either side of it join.
        wordGap(out, marks, link);
      }

      continue;
    }

    // A block element breaks the line on both edges, where text stands on
    // that side: before it when something precedes it and text follows, and
    // after it when text follows. `breakLine` collapses the two where blocks
    // are adjacent, so they never double up; both wait for the text, so an
    // empty block after the last of it adds no line.
    const isBlock = startsLine(element);
    // A block inside an inline box stays in the line. Alone there it touches
    // the text beside it -- MathJax 2 draws every glyph as one -- but two
    // stacked one on the other with nothing written between, a fraction's
    // parts or a badge's two lines, are drawn apart: a word gap between them,
    // never a line break. Wikipedia writes a hidden `/` between its
    // fraction's parts, and that already keeps them apart. Two table cells
    // side by side are apart the same way: MediaWiki's contents set number
    // and title as cells, and Chromium drops the space between. Only text
    // counts: an empty one -- KaTeX's rule line or radical -- draws nothing,
    // so it takes no gap and passes on the one before it.
    const apart = !isBlock && (isStackedInBox(element) || displayOf(element).cell);
    const armed = apart && apartEnd === out.length;
    const solidBefore = solidTexts;
    let gapAt = -1;

    if (isBlock) {
      breakLine(out, marks, link, true);
    } else if (armed) {
      gapAt = out.length;
      wordGap(out, marks, link);
      gapAt = out.length > gapAt ? gapAt : -1;
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
        solidTexts += 1;
      }
    } else {
      inlineNesting += 1;

      try {
        walk(element, nextMarks, nextLink, root, out, skip);
      } finally {
        inlineNesting -= 1;
      }
    }

    // Deferred rather than looked ahead for: looking from every block climbed
    // to the root each time, quadratic in the depth of a structure read as
    // text.
    if (isBlock) {
      breakLine(out, marks, link, true);
    } else if (apart && solidTexts > solidBefore) {
      apartEnd = out.length;
    } else if (apart) {
      // Nothing drawn: the gap goes, and an armed neighbour stays armed.
      if (gapAt !== -1) {
        out.splice(gapAt, 1);

        // `lastSolidRun` remembers indices into `out`: those past the gap
        // moved down one. The gap itself was never solid.
        const memo = SOLID_RUNS.get(out);

        if (memo && memo.checked > gapAt) {
          memo.checked -= 1;
        }

        if (memo && memo.solid > gapAt) {
          memo.solid -= 1;
        }
      }

      if (armed) {
        apartEnd = out.length;
      }
    }
  }
}

/**
 * Whether an `Apple-converted-space` stands for spaces that were drawn: more
 * than one, or one beside a space in the text either side of it. Whitespace
 * there that holds a line break is source layout, and no such neighbour.
 */
function isDrawnConvertedSpace(span: Element): boolean {
  if ((span.textContent ?? '').length > 1) {
    return true;
  }

  const before = span.previousSibling;
  const after = span.nextSibling;
  const spaced = (run: string | undefined): boolean => run !== undefined && !/[\n\r]/.test(run);

  return (
    (before?.nodeType === TEXT_NODE &&
      spaced(/[ \t\n\r\f\u00a0]+$/.exec(before.nodeValue ?? '')?.[0])) ||
    (after?.nodeType === TEXT_NODE &&
      spaced(/^[ \t\n\r\f\u00a0]+/.exec(after.nodeValue ?? '')?.[0]))
  );
}

/** How many runs holding more than whitespace the walk has written. */
let solidTexts = 0;

/**
 * A space between two words, where one is not already there: dropped once the
 * walk is done if nothing follows it, or what follows starts with whitespace
 * or a line break of its own.
 */
function wordGap(out: TextRun[], marks: Mark[], link: string | undefined): void {
  const previous = out.at(-1)?.text ?? '';

  if (previous !== '' && !/[ \t\n\r\f]/.test(previous[previous.length - 1]!)) {
    const run = { text: ' ', marks: [...marks], link };

    SKIPPED_SPACES.add(run);
    out.push(run);
  }
}

/** Reads a rendered (or pasted) subtree back into canonical runs. */
export function parseRichText(root: Node, skip?: SkipPredicate): RichText {
  const out: TextRun[] = [];
  walk(root, [], undefined, root, out, skip);

  // Only the deferred breaks after the last text can lack text after them.
  // Dropped in one pass: a splice each was quadratic in how many there were.
  let lastText = -1;

  for (let index = out.length - 1; index >= 0 && lastText === -1; index -= 1) {
    if (!DEFERRED_BREAKS.has(out[index]!) && /[^ \t\n\r\f]/.test(out[index]!.text)) {
      lastText = index;
    }
  }

  // No control character but the tab and the line feed is text the model
  // holds (see `normalizeControlCharacters`): a page's `&#1;` went on into
  // `getDocument()` and every export, and only a reload took it away.
  return normalizeRuns(
    out
      .filter((run, index) => {
        if (DEFERRED_BREAKS.has(run)) {
          return index <= lastText;
        }

        if (SKIPPED_SPACES.has(run)) {
          const next = out[index + 1]?.text ?? '';

          return !/[ \t\n\r\f]/.test(next[0] ?? ' ');
        }

        return true;
      })
      .map((run) => {
        const text = normalizeControlCharacters(run.text);

        return text === run.text ? run : { ...run, text };
      }),
  );
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
      container.style.whiteSpace = 'pre-wrap';
      container.append(renderRichText(doc, cell, true));
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

  /**
   * A block's text for another application: each line break a `<br>`, and
   * the element holding it marked `white-space: pre-wrap`, so a run of spaces,
   * a tab or an edge space draws as it does here. Both used to be left raw,
   * which only this package's reader kept: Gmail, Google Docs or a plain
   * contenteditable collapsed them, and so did this reader whenever WebKit
   * dropped the `application/x-neditor` flag on a paste between origins. The
   * mark is also how `blocksFromHtml` tells this writer's blocks, which say
   * what they mean, from older ones, which kept the newline raw.
   */
  const textInto = (element: HTMLElement, content: RichText): void => {
    element.style.whiteSpace = 'pre-wrap';
    element.append(renderRichText(doc, content, true));
  };

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
        if (block.src) {
          const image = doc.createElement('img');
          image.setAttribute('src', block.src);
          image.setAttribute('alt', block.alt ?? '');
          element.append(image);
        } else {
          // An image block with no picture yet. `<img src="">` is a broken
          // image in every other application and one the reader rightly
          // ignores, so it lost the block; this marker is ours alone.
          element.dataset.neditorImage = '';
          element.dataset.neditorAlt = block.alt ?? '';
        }

        if (!isRichEmpty(block.content)) {
          const caption = doc.createElement('figcaption');
          textInto(caption, block.content);
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
        textInto(summary, block.content);
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
          textInto(element, block.content);
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

    item.style.whiteSpace = 'pre-wrap';
    const text = renderRichText(doc, block.content, true);

    // Text that is only whitespace reads as the HTML's own formatting, and an
    // item with nothing else in it but a nested list is read as a holder for
    // that list: in a span it is text.
    if (block.content.length > 0 && richToPlainText(block.content).trim() === '') {
      const span = doc.createElement('span');
      span.append(text);
      item.append(span);
    } else {
      item.append(text);
    }
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
 * The elements a browser lays out as blocks by default -- the HTML standard's
 * rendering section gives them `display: block`, `list-item` or a table
 * display. Everything else, unknown and custom elements included, is inline.
 * Whether a wrapper ends the line it is on is a question of layout, so it is
 * asked here rather than of `BLOCK_TAGS`, which names the structure this
 * reader knows and leaves out `<center>`, `<aside>` and `<form>`. Line breaks
 * in text ask both, through `breaksLine`.
 */
const DISPLAY_BLOCK_TAGS = new Set([
  'HTML',
  'BODY',
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'CENTER',
  'DIALOG',
  'DIR',
  'DIV',
  'DD',
  'DL',
  'DT',
  'DETAILS',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HGROUP',
  'HR',
  'LEGEND',
  'LI',
  'LISTING',
  'MAIN',
  'MENU',
  'NAV',
  'OL',
  'P',
  'PLAINTEXT',
  'PRE',
  'SEARCH',
  'SECTION',
  'SUMMARY',
  'UL',
  'XMP',
  'TABLE',
  'CAPTION',
  'COLGROUP',
  'COL',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'TD',
  'TH',
  'OPTGROUP',
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
 * `<figure>` that is not one image (`isImageFigure`) — are deliberately
 * absent: their children are read one block at a time, and a wrapper among
 * them is this pass's to take.
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
 * Each question asked through here — does this hold a block, where is its
 * image, its summary; one memo apiece — is asked again at every level of a
 * wrapper chain, because `visitBlocks` descends into a wrapper and immediately
 * asks it of the next one down. Answering by scanning the subtree each time is
 * quadratic in the depth of the chain, and the depth is the pasted document's
 * to choose: `<b>` nested 640 deep is four kilobytes of clipboard. Every answer
 * is derived from the answers about the children, so a whole chain costs one
 * walk instead of one per level.
 *
 * Keying the memo on the element is safe because every element it ever sees was
 * parsed into a detached template by `blocksFromHtml` moments earlier, or
 * cloned below — none of them is reachable by a caller who could edit it behind
 * this file's back. The moves made while distributing formatting keep the
 * answers true as well: a run only ever moves into a fresh shell beside it,
 * which adds no element any of the questions looks for and reorders nothing.
 * The one removal, {@link detachSummary}, can falsify answers, and forgets the
 * ones it can.
 *
 * A `SKIP_TAGS` element is never matched and never entered, exactly as the
 * walker rejects it, and one asked directly holds nothing: Chromium and WebKit
 * parse a `<noscript>` in the inert paste document into elements, and the
 * image, summary or list a query found in one was read as content.
 *
 * @param enters Whether the search goes below a child that is not itself a
 * match. Every call sharing one `seen` map must pass the same predicate, since
 * the memo records answers to that search and no other.
 */
function firstDescendant(
  element: Element,
  matches: (candidate: Element) => boolean,
  seen: WeakMap<Element, Element | null>,
  enters: (candidate: Element) => boolean = () => true,
): Element | null {
  if (SKIP_TAGS.has(tagNameOf(element))) {
    return null;
  }

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

    if (SKIP_TAGS.has(tagNameOf(child))) {
      continue;
    }

    // Checked before descending, so the answer is the first in document order.
    // A child the search does not enter answers "none" without being asked,
    // and is not remembered as such: its own answer, asked directly, is
    // another question.
    const known = matches(child) ? child : enters(child) ? seen.get(child) : null;

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

/**
 * The first `<img>` in document order, remembered per element. For the
 * picture a `<figure>` shows, which may come after its caption, ask
 * `pictureOf`.
 */
function firstImage(element: Element): Element | null {
  return firstDescendant(element, (candidate) => tagNameOf(candidate) === 'IMG', IMAGE_DESCENDANTS);
}

/**
 * A `<figure>`'s caption: its first `<figcaption>` child, which may come
 * before the picture. A second one is content, not the figure's caption.
 */
function ownCaption(figure: Element): Element | undefined {
  return [...figure.children].find((child) => tagNameOf(child) === 'FIGCAPTION');
}

/**
 * The image an element shows: itself, or for a `<figure>` the first image
 * outside its own caption -- an image in the caption, a flag icon, belongs to
 * the caption and is handed on after the figure -- or any other's first.
 * A figure's answer is assembled from its children's, which `firstImage`
 * remembers, so asking again costs its child count, not its subtree.
 */
function pictureOf(element: Element): Element | null {
  const tag = tagNameOf(element);

  if (tag === 'IMG') {
    return element;
  }

  if (tag !== 'FIGURE') {
    return firstImage(element);
  }

  const caption = ownCaption(element);

  for (const child of element.children) {
    const found = child === caption ? null : tagNameOf(child) === 'IMG' ? child : firstImage(child);

    if (found) {
      return found;
    }
  }

  return null;
}

function containsImage(element: Element): boolean {
  return firstImage(element) !== null;
}

const SUMMARY_DESCENDANTS = new WeakMap<Element, Element | null>();

/**
 * A toggle's summary: the first `<summary>` below it that is content, and not
 * one that belongs to a `<details>` nested inside it.
 *
 * A query answered this, and found the first `<summary>` anywhere below: in a
 * `<noscript>`, which made hidden text the title -- and, with toggles nested
 * over one, made every level search the whole subtree under it -- or in a
 * nested `<details>`, whose title the outer toggle then took while the inner
 * one was left with none. Remembered per element, a chain of toggles costs one
 * walk, and the walk enters neither.
 */
function firstSummary(element: Element): Element | null {
  return firstDescendant(
    element,
    (candidate) => tagNameOf(candidate) === 'SUMMARY',
    SUMMARY_DESCENDANTS,
    (candidate) => tagNameOf(candidate) !== 'DETAILS',
  );
}

const INHERITING_KEYWORDS = ['inherit', 'unset', 'revert', 'revert-layer'];

/** A URL that names its own scheme, or its own host. */
const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** What HTML counts as whitespace between attribute tokens. */
const HTML_SPACE = new Set([' ', '\t', '\n', '\r', '\f']);

/**
 * The best usable candidate in a `srcset`, split as the HTML standard splits
 * one: a URL runs to whitespace, so a `data:` URL keeps its comma, and only a
 * comma ending the URL or its descriptors separates candidates. The largest
 * width or density wins, as the sharpest copy of the picture.
 */
function srcsetSource(srcset: string): string | null {
  let best: string | null = null;
  let bestSize = -Infinity;
  let index = 0;

  while (index < srcset.length) {
    while (index < srcset.length && (HTML_SPACE.has(srcset[index]!) || srcset[index] === ',')) {
      index += 1;
    }

    const start = index;

    while (index < srcset.length && !HTML_SPACE.has(srcset[index]!)) {
      index += 1;
    }

    let end = index;
    let descriptor = '';

    if (srcset[end - 1] === ',') {
      while (end > start && srcset[end - 1] === ',') {
        end -= 1;
      }
    } else {
      const from = index;

      while (index < srcset.length && srcset[index] !== ',') {
        index += 1;
      }

      descriptor = srcset.slice(from, index);
    }

    // A browser resolves `src` when it copies, but writes `srcset` as the page
    // did: with no base URL to resolve it against, a relative candidate would
    // load from the editor's own site, or name a host.
    const candidate = srcset.slice(start, end);
    const url = ABSOLUTE_URL.test(candidate) ? sanitizeImageUrl(candidate) : null;
    // `640w` and `2x` both read as their number; no descriptor means `1x`.
    const size = Number.parseFloat(descriptor.trim());
    const weight = Number.isNaN(size) ? 1 : size;

    if (url !== null && weight > bestSize) {
      best = url;
      bestSize = weight;
    }
  }

  return best;
}

/**
 * The source an `<img>` shows. Its `src` first; without a usable one -- Medium
 * writes none -- the candidates the browser chose from instead: the image's
 * own `srcset`, then its `<picture>`'s `<source>`s, untyped ones first, since
 * they are the fallback every browser can show. Each passes the same gate.
 */
function imageSource(image: Element): string | null {
  const src = sanitizeImageUrl(image.getAttribute('src') ?? '');

  if (src !== null) {
    return src;
  }

  const own = srcsetSource(image.getAttribute('srcset') ?? '');
  const picture = image.parentNode;

  if (own !== null || picture === null || tagNameOf(picture) !== 'PICTURE') {
    return own;
  }

  const sources = [...picture.childNodes].filter(
    (node): node is Element => tagNameOf(node) === 'SOURCE',
  );

  for (const source of [
    ...sources.filter((candidate) => !candidate.hasAttribute('type')),
    ...sources.filter((candidate) => candidate.hasAttribute('type')),
  ]) {
    const found = srcsetSource(source.getAttribute('srcset') ?? '');

    if (found !== null) {
      return found;
    }
  }

  return null;
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
  const image = pictureOf(element);

  return image !== null && imageSource(image) !== null;
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

/** Whether the element is itself block-level, as opposed to merely holding one. */
function isBlockLevel(element: Element): boolean {
  return BLOCK_TAGS.has(tagNameOf(element));
}

/**
 * Whether descending into this element takes the walk out of the chain's reach.
 *
 * A `<figure>` that is one image becomes the image, and only its caption is
 * read -- from the caption element, so nothing above that is part of the
 * parse. Any other figure is descended into block by block instead, and a
 * wrapper inside it is reached and pushed inward there.
 */
function sealsFormatting(element: Element, tag: string): boolean {
  // A seal says `parseRichText` will read this whole subtree as one block's
  // text. For most of SEALED_TAGS that holds by construction, but `visitBlocks`
  // dispatches neither FIGCAPTION nor SUMMARY by name — holding a block, they
  // fall through to `containsBlockLevel` and are split like anything else. Left
  // sealed there, the same caption parsed differently depending only on whether
  // an inline wrapper happened to reach it first. `FIGURE` already carried this
  // qualification; these two needed the same one.
  // A `<summary>` is not among them, despite holding blocks the same way: it is
  // never reached by `visitBlocks` at all, because `visitDetails` skips it, or
  // takes it out of the tree, and reads it whole with `parseRichText`. Unsealing it
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

  return SEALED_TAGS.has(tag) || (tag === 'FIGURE' && isImageFigure(element));
}

/** What a chain of inline wrappers leaves on the content inside it. */
interface InlineFormatting {
  /**
   * Each mark the chain mentioned, on or off -- as its outermost mention left
   * it when built by `formattingWithin`, for formatting pushed into blocks, or
   * its nearest when built by `nearestFormatting`, for text read in place.
   */
  marks: Map<Mark, boolean>;
  /** The chain's anchor's href, outermost or nearest by the same rule; null if none. */
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
 * That formatting, extended by one wrapper inside it, the wrapper winning: how
 * `parseRichText` reads text where it stands. (`formattingWithin` lets the
 * outermost win instead, for formatting pushed into blocks.)
 */
function nearestFormatting(format: InlineFormatting, wrapper: Element): InlineFormatting {
  const marks = new Map(format.marks);
  const { add, remove } = marksForElement(wrapper);

  // `marksForElement` never names a mark in both.
  for (const mark of add) {
    marks.set(mark, true);
  }

  for (const mark of remove) {
    marks.set(mark, false);
  }

  const href = tagNameOf(wrapper) === 'A' ? (wrapper.getAttribute('href') ?? '') : null;

  return { link: href ?? format.link, marks, soft: new Set() };
}

const DISPLAY_BLOCK_DESCENDANTS = new WeakMap<Element, Element | null>();

/** Whether an element holds one a browser lays out as a block. */
function holdsDisplayBlock(element: Element): boolean {
  return (
    firstDescendant(
      element,
      (candidate) => DISPLAY_BLOCK_TAGS.has(tagNameOf(candidate)),
      DISPLAY_BLOCK_DESCENDANTS,
    ) !== null
  );
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

  // Copied without recursion: the depth is the pasted document's to choose,
  // and a list's wrapped items reach this once per wrapper.
  fragment.append(...[...(cloneDeep(wrapper) as Element).childNodes]);
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

    // A flex or grid item takes a copy of its own: one copy around them all
    // took them out of their container, and they ran together.
    if (element && isItem(element)) {
      wrapRun(false);
      run.push(child);
      wrapRun(false);
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

/**
 * First descendant matching `match`, in document order, not descending into
 * anything `skip` hides.
 *
 * The pruning is the point: `querySelectorAll` over the whole subtree once per
 * nesting level is the quadratic term this file exists to avoid. An explicit
 * stack, because the depth is the pasted document's to choose.
 */
function findWithin(
  root: Element,
  skip: SkipPredicate,
  match: (element: Element) => boolean,
): Element | null {
  const stack: Element[] = [...root.children].reverse();

  for (let element = stack.pop(); element; element = stack.pop()) {
    const tag = tagNameOf(element);

    if (SKIP_TAGS.has(tag) || skip(element, tag)) {
      continue;
    }

    if (match(element)) {
      return element;
    }

    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      stack.push(element.children[index]!);
    }
  }

  return null;
}

/** A deep copy made without recursion, for the same reason. */
function cloneDeep(node: Node): Node {
  const copy = node.cloneNode(false);
  const stack: Array<readonly [Node, Node]> = [[node, copy]];

  for (let pair = stack.pop(); pair; pair = stack.pop()) {
    const [source, target] = pair;

    for (const child of source.childNodes) {
      const childCopy = child.cloneNode(false);

      target.appendChild(childCopy);
      stack.push([child, childCopy]);
    }
  }

  return copy;
}

/**
 * Emits one block, empty or not.
 *
 * An empty `<p>` is a blank line the author put there, and the clipboard is a
 * round trip: `blocksToHtml` writes an empty block as an empty element, so
 * dropping it here loses a paragraph, heading or quote on every copy-paste.
 */
function pushBlock(
  out: Block[],
  type: BlockType,
  element: Element,
  depth: number,
  imagesAt?: number,
  skip: SkipPredicate = isNestedList,
  stripMarker: RegExp | null = null,
): void {
  let runs = readBlockText(element, skip);

  // A Word list marker left in the text (see `wordListItemSanitized`).
  if (stripMarker) {
    runs = richDelete(runs, 0, stripMarker.exec(richToPlainText(runs))?.[0].length ?? 0);
  }

  // Given a depth, the block hands its images on after it, as a list item
  // does: read as text, a heading's logo or a quote's screenshot was dropped.
  // Not one in what the text skips: a Word item's picture bullet is its
  // marker.
  const images =
    imagesAt !== undefined && containsImage(element)
      ? textImages(element, skip).filter(hasUsableImage)
      : [];

  // A break that followed the image ended the image's line, not the text's.
  if (images.length > 0 && richToPlainText(runs).startsWith('\n')) {
    runs = richDelete(runs, 0, 1);
  }

  // Holding nothing but images, it is those images: an empty heading above a
  // README's logo would be a block the source never had.
  if (images.length === 0 || !isRichEmpty(runs)) {
    out.push(createBlock(type, runs, depthOf(element, depth)));
  }

  for (const image of images) {
    pushImage(out, image, imagesAt!);
  }
}

/** Word's `mso-list:l0 level2 lfo1`: the paragraph is a list item at that level. */
const WORD_LIST_LEVEL = /(?:^|;)\s*mso-list\s*:\s*[^;]*?\blevel(\d+)/i;
/** The span Word keeps a list item's bullet or number in, as text. */
const WORD_LIST_MARKER = /(?:^|;)\s*mso-list\s*:\s*ignore\b/i;
/**
 * A number with its punctuation: `1.`, `(2)`, a multilevel `1.1.` or `2.10.`.
 */
const WORD_PUNCTUATED_NUMBER = /^\(?\d+(?:\.\d+)*[.)]$/;
/**
 * A letter or a roman numeral with its punctuation: `a)`, `(iv)`, and a
 * numeral of any length (`viii.`) -- three letters was the limit, so `viii.`
 * was a bullet. Sanitised, one is a marker only with Word's spacer after it
 * ({@link hasWordSpacer}): the first word of a List Paragraph with no
 * numbering is as likely `Yes.`, `Dr.`, `Mild.` (a numeral, letter for
 * letter) or `(c)` (R5-FMT-4).
 */
const WORD_PUNCTUATED_LETTER = /^\(?(?:[a-z]{1,3}|[ivxlcdm]+)[.)]$/i;
/**
 * A bare number: Word's "1 / 1.1 / 1.1.1" and legal `1.01` styles write no
 * punctuation. In a `mso-list:Ignore` span that is a number; sanitised, it is
 * one only with Word's spacer after it ({@link hasWordSpacer}), since there a
 * bare number is as likely the year or the figure a paragraph starts with
 * (`2024   Annual results`, R4-FMT-4).
 */
const WORD_BARE_NUMBER = /^\d+(?:\.\d+)*$/;
/** Either: what is numbered. */
const WORD_ORDERED_MARKER = /^(?:\(?(?:\d+(?:\.\d+)*|[a-z]{1,3}|[ivxlcdm]+)[.)]|\d+(?:\.\d+)*)$/i;
/** The Unicode bullets Word draws a bullet with, as text: `·` in Symbol, `•`. */
const WORD_BULLET_GLYPH = /^[\u00b7\u2022\u25aa\u25a0\u25e6\u25cb\u25cf\u2013\u27a2\u2713\u2714]$/;
/**
 * The characters that stand in for a bullet drawn in another font: `o` in
 * Courier New, and Wingdings' `§` (a square), `Ø` (an arrow), `ü` (a tick),
 * `v`, `q` and `n`, and a typed `*` or `-`. Each is also a character a
 * paragraph can start with -- `o  clock`, `§  12` -- so, sanitised, one is a
 * bullet only with Word's own spacer after it ({@link hasWordSpacer}).
 */
const WORD_BULLET_STAND_IN = /^[o\u00a7\u00d8\u00fcvqn*-]$/;
/**
 * The style of Word's spacer span, `font:7.0pt "Times New Roman"`, which
 * WebKit's sanitizer keeps as `font-size: 7pt`.
 */
const WORD_SPACER_STYLE = /(?:^|;)\s*font(?:-size)?\s*:\s*(?:[^;]*\s)?7(?:\.0+)?pt\b/i;

/** Whether the HTML being read is Word's own, `mso-` declarations and all. */
let wordMarkup = false;

/** What {@link wordListItem} says of a paragraph that is a Word list item. */
interface WordListItem {
  type: BlockType;
  level: number;
  /** What, at the start of its text, is the marker -- or null if none is. */
  strip: RegExp | null;
  /** What the text skips: the marker span, a picture bullet. */
  skip: SkipPredicate;
}

/** Word's marker span: text that only draws a list item's bullet or number. */
const isWordListMarker: SkipPredicate = (element, tag) =>
  isNestedList(element, tag) || WORD_LIST_MARKER.test(element.getAttribute('style') ?? '');

/**
 * Word writes a list item as a `<p>` with `mso-list:… levelN …` in its style,
 * and its bullet or number as text in a `mso-list:Ignore` span. The level is
 * the depth; the marker says which kind of list it is -- a number or letter
 * with its punctuation is numbered, anything else (`·`, `o`, `§`) a bullet.
 * Null for any other paragraph.
 */
function wordListItem(element: Element): WordListItem | null {
  const style = element.getAttribute('style') ?? '';
  const level = WORD_LIST_LEVEL.exec(style);

  if (!level) {
    return wordListItemSanitized(element, style);
  }

  const walker = element.ownerDocument.createTreeWalker(element, SHOW_ELEMENT);
  let marker = '';

  for (let found = walker.nextNode(); found !== null; found = walker.nextNode()) {
    if (WORD_LIST_MARKER.test((found as Element).getAttribute('style') ?? '')) {
      marker = subtreeText(found).replace(/[\s\u00a0]+/g, '');
      break;
    }
  }

  return {
    type: WORD_ORDERED_MARKER.test(marker) ? 'numbered_list' : 'bulleted_list',
    level: Math.max(1, Math.min(Number.parseInt(level[1]!, 10), MAX_LIST_NESTING)),
    strip: null,
    skip: isWordListMarker,
  };
}

/**
 * Emits a paragraph {@link wordListItem} recognised, without its marker, and
 * then the pictures in its text as the item's children, as a list item's are.
 */
function pushWordListItem(out: Block[], element: Element, depth: number, word: WordListItem): void {
  const itemDepth = depth + word.level - 1;

  pushBlock(out, word.type, element, itemDepth, itemDepth + 1, word.skip, word.strip);
}

/** Word's own class for a list paragraph, which WebKit's sanitizer keeps. */
const WORD_LIST_CLASS = /(?:^|\s)MsoListParagraph/;
/**
 * The marker and the run of spaces Word draws it apart with. Up to eight
 * characters, for a multilevel `1.1.1.` or a roman `viii.`.
 */
const WORD_TEXT_MARKER = /^[ \t\n\r\f]*([^\s\u00a0]{1,8})[\s\u00a0]{2,}/;
/** The same marker at the start of the text as read, with whatever gap is left. */
const WORD_LEADING_MARKER = /^[^\s\u00a0]{1,8}[\s\u00a0]+/;
/** A picture bullet's gap, left at the start of the text the picture is not in. */
const WORD_PICTURE_GAP = /^[\s\u00a0]+/;
/**
 * The paragraph's indent, in whichever unit Word wrote it: points in most
 * locales, inches from US and Mac Word (`.5in` a level), centimetres or
 * millimetres from metric ones, and pixels once a browser has computed it.
 */
const MARGIN_LEFT = /(?:^|;)\s*margin-left\s*:\s*(\d*\.?\d+)\s*(pt|in|cm|mm|px)\b/i;
/** Points per unit, for {@link MARGIN_LEFT}. */
const POINTS_PER: Readonly<Record<string, number>> = {
  pt: 1,
  in: 72,
  cm: 72 / 2.54,
  mm: 72 / 25.4,
  px: 0.75,
};

/**
 * The same item after WebKit has sanitized it: a paste from another app or
 * origin there comes through with every `mso-` declaration and the marker
 * span's style stripped, leaving Word's `MsoListParagraph` class, its indent
 * (36pt, or half an inch, a level) and the marker as the first text of the
 * paragraph. Only that class, with a marker and Word's wide gap after it, is
 * read as an item; the marker is then taken off the front of the text. A
 * picture bullet is a bullet-sized picture first in the paragraph, with
 * Word's spacer after it: a screenshot first, its caption after, is a picture
 * (R4-FMT-3), and so is an icon a note starts with (R5-FMT-4).
 *
 * Never in HTML that still carries `mso-` declarations, which is Word's own
 * and says what is an item: there a `MsoListParagraph` without `mso-list` is
 * Word's "List Paragraph" style with no numbering, and its first word --
 * `Caution:`, `Results.` -- is text. Nor is a first word a marker unless it
 * is a bullet glyph or a punctuated number, wherever it comes from, or a
 * letter, numeral or character that stands in for a bullet with Word's spacer
 * after it.
 */
function wordListItemSanitized(element: Element, style: string): WordListItem | null {
  if (wordMarkup || !WORD_LIST_CLASS.test(element.getAttribute('class') ?? '')) {
    return null;
  }

  const text = subtreeText(element);
  const marker = WORD_TEXT_MARKER.exec(text);
  const picture = marker ? null : leadingPicture(element);

  if (
    marker
      ? !isSanitizedWordMarker(marker[1]!, element)
      : !picture ||
        !isBulletSized(picture) ||
        !/^[\s\u00a0]{2,}/.test(text) ||
        !hasWordSpacer(element, picture)
  ) {
    return null;
  }

  const indent = MARGIN_LEFT.exec(style);
  const margin = indent
    ? Number.parseFloat(indent[1]!) * POINTS_PER[indent[2]!.toLowerCase()]!
    : 36;
  // Word indents a list 36pt (half an inch) a level.
  const level = Number.isFinite(margin) ? Math.round(margin / 36) : 1;

  return {
    type: marker && WORD_ORDERED_MARKER.test(marker[1]!) ? 'numbered_list' : 'bulleted_list',
    level: Math.max(1, Math.min(level, MAX_LIST_NESTING)),
    strip: picture ? WORD_PICTURE_GAP : WORD_LEADING_MARKER,
    skip: picture
      ? (candidate, tag) => isNestedList(candidate, tag) || candidate === picture
      : isNestedList,
  };
}

/**
 * Whether a sanitised paragraph's first word is a marker: a bullet glyph or a
 * punctuated number is; a bare number, a punctuated letter or numeral, or a
 * character that stands in for a bullet, is only with Word's spacer after it.
 */
function isSanitizedWordMarker(marker: string, element: Element): boolean {
  return (
    WORD_BULLET_GLYPH.test(marker) ||
    WORD_PUNCTUATED_NUMBER.test(marker) ||
    ((WORD_BARE_NUMBER.test(marker) ||
      WORD_PUNCTUATED_LETTER.test(marker) ||
      WORD_BULLET_STAND_IN.test(marker)) &&
      hasWordSpacer(element))
  );
}

/**
 * Whether the gap after a paragraph's first word -- or after the picture it
 * starts with -- is Word's spacer: the text node holding the word ends with
 * it, and the next text is inside an element styled at 7pt ({@link
 * WORD_SPACER_STYLE}). Typed spaces are never in one, however many there are
 * -- and Word's own spacer after a Wingdings bullet is `&nbsp; `, the same
 * characters two typed spaces make.
 */
function hasWordSpacer(element: Element, picture?: Element): boolean {
  const walker = element.ownerDocument.createTreeWalker(element, SHOW_TEXT);

  if (picture) {
    walker.currentNode = picture;
  } else {
    let word: Node | null = walker.nextNode();

    while (word !== null && !/[^\s\u00a0]/.test(word.nodeValue ?? '')) {
      word = walker.nextNode();
    }

    if (word === null || /^[\s\u00a0]*[^\s\u00a0]+[\s\u00a0]/.test(word.nodeValue ?? '')) {
      return false;
    }
  }

  let gap: Node | null = walker.nextNode();

  while (gap !== null && (gap.nodeValue ?? '') === '') {
    gap = walker.nextNode();
  }

  for (let at = gap?.parentNode ?? null; at !== null && at !== element; at = at.parentNode) {
    if (
      at.nodeType === ELEMENT_NODE &&
      WORD_SPACER_STYLE.test((at as Element).getAttribute('style') ?? '')
    ) {
      return true;
    }
  }

  return false;
}

/** The largest picture, in points, that is a bullet: 24px. */
const BULLET_POINTS = 18;

/** A picture's declared `width` and `height`, in the units {@link POINTS_PER} knows. */
const PICTURE_SIDE = {
  width: /(?:^|;)\s*width\s*:\s*(\d*\.?\d+)\s*(pt|in|cm|mm|px)\b/i,
  height: /(?:^|;)\s*height\s*:\s*(\d*\.?\d+)\s*(pt|in|cm|mm|px)\b/i,
};

/** A picture's `width` or `height`, in points, from its style or else its attribute. */
function pictureSide(image: Element, side: 'width' | 'height'): number | null {
  const declared = PICTURE_SIDE[side].exec(image.getAttribute('style') ?? '');

  if (declared) {
    return Number.parseFloat(declared[1]!) * POINTS_PER[declared[2]!.toLowerCase()]!;
  }

  const attribute = /^\s*(\d*\.?\d+)\s*(?:px)?\s*$/i.exec(image.getAttribute(side) ?? '');

  return attribute ? Number.parseFloat(attribute[1]!) * POINTS_PER.px! : null;
}

/**
 * Whether a picture is the size of a bullet: a stated size, no side of it
 * larger than 24px. One with no size it states is content, since nothing
 * says it is not a screenshot.
 */
function isBulletSized(image: Element): boolean {
  const sides = [pictureSide(image, 'width'), pictureSide(image, 'height')].filter(
    (side): side is number => side !== null,
  );

  return sides.length > 0 && sides.every((side) => side <= BULLET_POINTS);
}

/** The `<img>` a paragraph starts with, before any text, if it starts with one. */
function leadingPicture(element: Element): Element | null {
  const walker = element.ownerDocument.createTreeWalker(element, SHOW_TEXT | SHOW_ELEMENT);

  for (let found = walker.nextNode(); found !== null; found = walker.nextNode()) {
    if (found.nodeType === TEXT_NODE) {
      if (/[^\s\u00a0]/.test(found.nodeValue ?? '')) {
        return null;
      }
    } else if (tagNameOf(found) === 'IMG') {
      return found as Element;
    }
  }

  return null;
}

/**
 * How a block lays out its source whitespace: whether the block itself does so
 * under `white-space: normal` (an element inside it that says otherwise is
 * asked for its own text, in {@link sourceWhitespace}), whether any of its
 * text has whitespace that would collapse, and, for each edge of its text,
 * whether the whitespace there is a typed space rather than layout (present,
 * and holding no line break). Also whether a later text node starts a line
 * with whitespace -- after a `<br>`, or at the start or end of a block inside
 * it (`lineStart`, R8-FMT-6) -- and the element its first character that is
 * not whitespace stands in (`holder`, whose indentation Firefox gives the
 * block's first line: R8-FMT-5).
 *
 * One walk over each node's children by index, as `blocksFromHtml` makes its
 * own: stepping siblings with a tree walker costs the node's index in some
 * DOMs, and a block of many inline elements paid it once per element.
 */
function blockWhitespace(
  element: Element,
  skip?: SkipPredicate,
): {
  collapses: boolean;
  layout: boolean;
  start: boolean;
  end: boolean;
  lineStart: boolean;
  holder: Element | null;
  solids: SolidHolders | null;
} {
  const none = {
    collapses: false,
    layout: false,
    start: false,
    end: false,
    lineStart: false,
    holder: null,
    solids: null,
  };

  if (legacyOwnHtml || whiteSpaceOf(element) !== 'normal') {
    return none;
  }

  let first: string | null = null;
  let last: string | null = null;
  let layout = false;
  // Whether a text node after the first starts a line -- after a `<br>`, or
  // at the start or the end of a block inside -- with whitespace.
  let lineStart = false;
  let atLineStart = false;
  // The element the first character that is not whitespace stands in.
  let holder: Element | null = null;
  // Where the plain text decides: the element each solid character stands
  // in, by text node ({@link SolidHolders}).
  const solids: SolidHolders | null = plainArbiter ? { at: [], holders: [], total: 0 } : null;
  // `null` marks the end of a block inside, which ends its line.
  const stack: Array<Node | null> = [element];

  while (stack.length > 0) {
    const node = stack.pop();

    if (node === null || node === undefined) {
      atLineStart = true;
      continue;
    }

    if (node.nodeType === TEXT_NODE) {
      const value = node.nodeValue ?? '';

      if (value.length > 0) {
        lineStart ||= first !== null && atLineStart && /^[ \t\n\r\f]/.test(value);
        atLineStart = false;
        // WebKit writes the space a drag began at as a converted one, which
        // is read as the ordinary space it was (`walkText`): so is it here,
        // where the block's first text says whether a space starts it -- one
        // that stays at a paste's start, as Chromium's copy of it does
        // (R9-RV-FMT-4).
        first ??=
          node.parentElement !== null &&
          (node.parentElement.getAttribute('class') ?? '')
            .split(/\s+/)
            .includes('Apple-converted-space')
            ? value.replace(/\u00a0/g, ' ')
            : value;
        last = value;
        layout ||= COLLAPSIBLE.test(value);

        if (holder === null && /[^ \t\n\r\f]/.test(value)) {
          holder = node.parentElement;
        }

        if (solids) {
          let count = 0;

          for (let index = 0; index < value.length; index += 1) {
            const code = value.charCodeAt(index);

            if (!isBlank(code) && code !== 0xa0) {
              count += 1;
            }
          }

          if (count > 0 && node.parentElement) {
            solids.at.push(solids.total);
            solids.holders.push(node.parentElement);
            solids.total += count;
          }
        }
      }

      continue;
    }

    if (node !== element) {
      if (node.nodeType !== ELEMENT_NODE) {
        continue;
      }

      const tag = tagNameOf(node);

      if (SKIP_TAGS.has(tag) || skip?.(node as Element, tag)) {
        continue;
      }

      if (tag === 'BR') {
        atLineStart = true;
      } else if (breaksLine(tag)) {
        atLineStart = true;
        stack.push(null);
      }
    }

    const children = node.childNodes;

    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]!);
    }
  }

  const typed = (whitespace: string | undefined): boolean =>
    whitespace !== undefined && !/[\n\r]/.test(whitespace);

  return {
    collapses: true,
    layout,
    start: typed(/^[ \t\n\r\f]+/.exec(first ?? '')?.[0]),
    end: typed(/[ \t\n\r\f]+$/.exec(last ?? '')?.[0]),
    lineStart,
    holder,
    solids,
  };
}

/**
 * The element each solid character of a block's text stands in -- every
 * character but whitespace and the no-break space, as {@link solidsOf}
 * counts them -- as the solid index each text node's first one has
 * (`at`, ascending) and that text node's parent. `total` is how many there
 * are: where it differs from the count the text read holds, the two are not
 * the same characters, and none of it is used.
 */
interface SolidHolders {
  at: number[];
  holders: Element[];
  total: number;
}

/** The first line feed in `text` from `from` up to `to`, or -1. Costs that stretch. */
function firstLineFeed(text: string, from: number, to: number): number {
  for (let index = from; index < to; index += 1) {
    if (text.charCodeAt(index) === 10) {
      return index;
    }
  }

  return -1;
}

const LINE_BLOCKS = new WeakMap<Element, Element | null>();

/**
 * The nearest element at or above `element` that starts and ends a line
 * ({@link breaksLine}): two characters in the same one stand in one block.
 * Remembered per element, so a chain is walked once.
 */
function lineBlock(element: Element | null): Element | null {
  const walked: Element[] = [];
  let node = element;
  let found: Element | null = null;

  while (node) {
    const known = LINE_BLOCKS.get(node);

    if (known !== undefined) {
      found = known;
      break;
    }

    walked.push(node);

    if (breaksLine(tagNameOf(node))) {
      found = node;
      break;
    }

    node = node.parentElement;
  }

  for (const each of walked) {
    LINE_BLOCKS.set(each, found);
  }

  return found;
}

/** The element the `solid`th solid character stands in ({@link SolidHolders}). */
function solidHolder(solids: SolidHolders, solid: number): Element | null {
  let low = 0;
  let high = solids.at.length - 1;
  let found = -1;

  while (low <= high) {
    const middle = (low + high) >> 1;

    if (solids.at[middle]! <= solid) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return found === -1 ? null : solids.holders[found]!;
}

/**
 * Whether the last source text a block holds ends in a line break -- a
 * newline, or a CR, vertical tab or form feed, each read as one -- rather
 * than a `<br>`, an image, or text after it. Walked from the end, so it costs
 * what follows the last text. That text can be the formatting after a child
 * block, which the walk drops, so the caller asks the text read as well.
 */
function endsWithSourceNewline(element: Element, skip?: SkipPredicate): boolean {
  const stack: Node[] = [element];

  while (stack.length > 0) {
    const node = stack.pop()!;

    if (node.nodeType === TEXT_NODE) {
      const value = node.nodeValue ?? '';

      if (value.length > 0) {
        return /[\n\r\v\f]$/.test(value);
      }

      continue;
    }

    if (node !== element) {
      if (node.nodeType !== ELEMENT_NODE) {
        continue;
      }

      const tag = tagNameOf(node);

      if (SKIP_TAGS.has(tag) || skip?.(node as Element, tag)) {
        continue;
      }

      if (tag === 'BR' || tag === 'IMG') {
        return false;
      }
    }

    // Children in document order onto the stack, so the last is popped first.
    for (const child of node.childNodes) {
      stack.push(child);
    }
  }

  return false;
}

/** Whitespace a browser draws differently from how it stands in the source. */
const COLLAPSIBLE = /[\t\n\r\f]| {2}/;

/**
 * A block's text, as a browser draws it.
 *
 * Every block used to be read with its whitespace as it stands, because this
 * package's own clipboard wrote a soft line break as a raw newline inside the
 * block. It writes a `<br>` now, and marks its blocks `white-space: pre-wrap`,
 * so a block that does not say it preserves whitespace is one whose source
 * whitespace is layout: Firefox copies a page's `<p>` with its source
 * line-wrapping and indentation intact, and Word wraps its own source lines,
 * and both pasted as several lines with the indentation kept. Here each run of
 * whitespace is one space, none stands beside a line break, and none at either
 * edge of the block -- except a typed space at the paste's own edge, which
 * lands mid-line, as in the inline buffer.
 */
function readBlockText(element: Element, skip?: SkipPredicate): RichText {
  const whitespace = blockWhitespace(element, skip);

  if (!whitespace.collapses) {
    let runs = parseRichText(element, skip);

    // A source newline that ends a block a style preserves ends its last
    // line, as it does where the plain text decides (`arbitrate`) and in a
    // block that collapses: it draws no line after it. A `<br>` there is a
    // break somebody made, and this writer's own blocks hold no other kind.
    // Only if the text read ends in that newline: the last source text can
    // be the formatting after a child block (`<p>abc</p>\n</td>`), which the
    // walk drops, and then the last character is a letter (R4-FMT-1).
    if (
      !legacyOwnHtml &&
      richToPlainText(runs).endsWith('\n') &&
      endsWithSourceNewline(element, skip)
    ) {
      runs = richDelete(runs, richLength(runs) - 1, richLength(runs));
    }

    return plainArbiter ? arbitrate(null, runs) : runs;
  }

  let runs: RichText;

  collapsingSource = true;
  collapsing = true;

  try {
    runs = parseRichText(element, skip);
  } finally {
    collapsingSource = false;
    collapsing = false;
  }

  // A space at the paste's edge stays, since the paste lands mid-line -- but
  // only one somebody selected, never the indentation or line-wrapping of
  // the source, which is whitespace holding a line break.
  const edges = {
    start: pasteFirst.has(element) && whitespace.start,
    end: pasteLast.has(element) && whitespace.end,
  };
  const chars = runs.map((): string[] => []);
  // The run the pending space belongs to, or -1 for none.
  let space = -1;
  // Whether a space here would start a line: at the start, or after a break.
  let lineStart = !edges.start;
  // The run holding a preserved line break that so far ends the text.
  let lastBreak = -1;
  // Whether the next character is one the text held, marks and all.
  let literal = false;

  const content = (index: number, char: string): void => {
    if (space !== -1) {
      chars[space]!.push(' ');
    }

    space = -1;
    lineStart = false;
    lastBreak = -1;
    chars[index]!.push(char);
  };

  for (const [index, run] of runs.entries()) {
    for (const char of run.text) {
      if (literal) {
        literal = false;
        content(index, char);
      } else if (char === LITERAL) {
        literal = true;
      } else if (char === STANDS) {
        // A `<br>` after a preserved break: that break is a line of its own.
        lastBreak = -1;
      } else if (char === ' ') {
        if (space === -1 && !lineStart) {
          space = index;
        }
      } else if (char === '\n' || char === LINE_BREAK) {
        // A `<br>` or a `pre-line` break takes the collapsible space before it.
        space = -1;
        lineStart = true;
        lastBreak = char === LINE_BREAK ? index : -1;
        chars[index]!.push('\n');
      } else if (char === PRESERVED['\n']) {
        // A `pre` one leaves it, as Chromium lays it out.
        content(index, '\n');
        lineStart = true;
        lastBreak = index;
      } else {
        content(index, RESTORED[char] ?? char);
      }
    }
  }

  if (space !== -1 && edges.end) {
    chars[space]!.push(' ');
  }

  // A preserved line break that ends the text ends its line, as a trailing
  // `<br>` does: it draws no line after it.
  if (lastBreak !== -1 && !edges.end) {
    chars[lastBreak]!.pop();
  }

  const collapsed = normalizeRuns(
    runs
      .map((run, index) => ({ ...run, text: chars[index]!.join('') }))
      .filter((run) => run.text.length > 0),
  );

  // Asked whenever collapsing changed something the plain text can confirm:
  // whitespace a browser draws differently, or a space at a block's start --
  // a `pre-wrap` verse's ` second, set in` has nothing else, and Firefox
  // writes no leading space it did not draw (`<p> lead</p>` copies as
  // `lead`; R6-FMT-2) -- except at the very start of a copy: a drag begun on
  // the `H` of `<p>  Hello</p>` writes ` Hello`, and the paste's-edge space
  // the collapsed reading keeps stays. A known limit (R9-FMT-3), since a
  // drag begun after the period of `Sentence.  Next` writes the space it
  // drew and selected as the same HTML and plain text, byte for byte.
  // A space at the end only of a table cell -- a cell's
  // ` f ` read `f` (R4-FMT-6a) -- since Firefox writes the one a
  // pretty-printed `<li>first <code>x</code> </li>` ends with, drawn or not,
  // and asking every block pasted a trailing space nobody saw (R5-FMT-2).
  // And a space that starts a line inside it, after a `<br>` or at a block
  // inside it: `one<br> two` in a pre-wrap `<p>` had nothing else to say so
  // (R8-FMT-6), and Firefox leaves the space out where it is not drawn.
  const tag = tagNameOf(element);
  const cell = tag === 'TD' || tag === 'TH';
  const asked =
    (whitespace.layout || whitespace.start || whitespace.lineStart || (cell && whitespace.end)) &&
    !declaresWhiteSpace(element);

  return plainArbiter
    ? arbitrate(
        asked ? parseRichText(element, skip) : null,
        collapsed,
        whitespace.layout || cell,
        plainIndent(plainArbiter, element),
        // Where its text starts in a list, a quote or a definition the block
        // is not -- a quote in a quote, a list in a cell (R8-FMT-5).
        plainIndent(plainArbiter, whitespace.holder ?? element),
        whitespace.solids,
      )
    : collapsed;
}

/**
 * How far Firefox's plain text indents each line of an element's text: four
 * spaces for each `<ul>`, `<ol>`, `<dd>` and `<blockquote>` it is or is in
 * (measured: nested lists, an `<ol>`, a `<p>` or a table in a list item, a
 * list in a quote, a `<dd>` in a `<dd>`; a `<menu>`'s items, a `<dt>`, a
 * `<details>` and a margin are not indented). Its parent's indentation plus
 * its own, remembered, so a document is walked once however deep it nests.
 *
 * A `<blockquote type="cite">` is counted like any quote, though Firefox
 * starts each of its lines with `>` instead: no block's text is found past
 * that prefix, so such a quote's whitespace reads collapsed whatever this
 * answers (R8-FMT-8, a documented limit).
 */
function plainIndent(arbiter: PlainArbiter, element: Element | null): number {
  const { indents } = arbiter;
  const unknown: Element[] = [];
  let node = element;
  let indent = 0;

  while (node) {
    const known = indents.get(node);

    if (known !== undefined) {
      indent = known;
      break;
    }

    unknown.push(node);
    node = node.parentElement;
  }

  for (let index = unknown.length - 1; index >= 0; index -= 1) {
    const name = unknown[index]!.localName;

    if (name === 'ul' || name === 'ol' || name === 'dd' || name === 'blockquote') {
      indent += PLAIN_INDENT;
    }

    indents.set(unknown[index]!, indent);
  }

  return indent;
}

/** The spaces Firefox's plain text indents a line by for each level ({@link plainIndent}). */
const PLAIN_INDENT = 4;

/**
 * The clipboard's `text/plain`, while `blocksFromHtml` reads HTML it was given
 * with (see {@link HtmlReadOptions.plain}). Null otherwise. Asked only of a
 * block that does not say how its whitespace is drawn ({@link
 * declaresWhiteSpace}); every block moves its cursor on.
 *
 * Kept as its solid characters -- everything but whitespace -- and where each
 * stands, so a block is matched with one comparison of its own solid
 * characters, never a search.
 */
interface PlainArbiter {
  /** The plain text, spelled as {@link asPlain} spells it. */
  readonly text: string;
  /** Its characters other than {@link isBlank} whitespace, in order. */
  readonly solid: string;
  /** Where in `text` each character of `solid` stands. */
  readonly at: Int32Array;
  /** The index into `solid` of the first character of each line that has one. */
  readonly heads: Int32Array;
  /** Where in `text` each tab and line feed stands, in order. */
  readonly breaks: Int32Array;
  /** Where in `text` each line feed stands, in order. */
  readonly lineEnds: Int32Array;
  /** Each element's {@link plainIndent}, once asked. */
  readonly indents: Map<Node, number>;
  /** The index into `solid` of the first character no block has matched. */
  next: number;
  /**
   * The first of `heads` the look-ahead may try: past the lines the blocks
   * missed since the last match are taken to stand on. At or before the
   * cursor's line otherwise, where it does not count.
   */
  head: number;
}

let plainArbiter: PlainArbiter | null = null;

/**
 * How many lines past the cursor a block that is not at the cursor is looked
 * for. Firefox writes text a block does not hold -- an image's alt text, the
 * quotes a `<q>` draws -- and a block can hold text Firefox leaves out, so
 * one block not found must not lose every block after it. A bounded number of
 * line starts keeps the cost of a block it cannot find at its own length times
 * a constant.
 */
const RESYNC_LINES = 64;

/** Whitespace in plain text, after {@link asPlain}: a no-break space is a space. */
function isBlank(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

/** Text as a plain-text clipboard spells it: a no-break space is a space. */
function asPlain(text: string): string {
  return text.replace(/\u00a0/g, ' ');
}

function plainArbiterFor(plain: string): PlainArbiter {
  // Cleaned as the blocks' own text is, so the two still agree.
  const text = normalizeControlCharacters(asPlain(plain));
  const at = new Int32Array(text.length);
  const heads: number[] = [];
  const breaks: number[] = [];
  const lineEnds: number[] = [];
  let solid = '';
  let count = 0;
  let from = 0;
  let lineStart = true;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (isBlank(code)) {
      solid += text.slice(from, index);
      from = index + 1;
      lineStart ||= code === 10;

      if (code === 9 || code === 10) {
        breaks.push(index);
      }

      if (code === 10) {
        lineEnds.push(index);
      }

      continue;
    }

    if (lineStart) {
      heads.push(count);
      lineStart = false;
    }

    at[count] = index;
    count += 1;
  }

  solid += text.slice(from);

  return {
    text,
    solid,
    at: at.subarray(0, count),
    heads: Int32Array.from(heads),
    breaks: Int32Array.from(breaks),
    lineEnds: Int32Array.from(lineEnds),
    indents: new Map(),
    next: 0,
    head: 0,
  };
}

/** A text's solid characters and where each stands in it. */
function solidsOf(text: string): { solid: string; at: Int32Array } {
  const at = new Int32Array(text.length);
  let solid = '';
  let count = 0;
  let from = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (isBlank(text.charCodeAt(index))) {
      solid += text.slice(from, index);
      from = index + 1;
    } else {
      at[count] = index;
      count += 1;
    }
  }

  solid += text.slice(from);

  return { solid, at: at.subarray(0, count) };
}

/**
 * Where a block's solid characters stand in the plain text: at the cursor,
 * whatever whitespace lies between, or else at the start of one of the next
 * {@link RESYNC_LINES} lines. The index into the arbiter's `solid` of its
 * first character, or -1. The caller moves the cursor past it when found.
 *
 * Not found, the block is taken to stand on the `lines` lines -- as many as
 * it holds -- from the cursor's, and the look-ahead for the
 * block after it starts past them, while the cursor stays: that block is
 * still tried at the cursor first, for a block the plain text left out. A
 * window that never moved found nothing after 64 misses in a row
 * (R4-FMT-2), Firefox's `<q>`s for one.
 *
 * A claim changes only where the look-ahead starts, never what it can reach:
 * a block it does not find past the claimed lines is looked for on the
 * {@link RESYNC_LINES} lines from the cursor's as well, since the claim can
 * be wrong -- a block the plain text left out claims a line that belongs to
 * the next, and a table cell spelled differently (`<img alt="flag">
 * France`) claimed one per cell where Firefox writes the whole row on one,
 * and every block after the table missed (R5-FMT-1). Each lookup costs the
 * block's length times a constant, and a binary search for the cursor's
 * line.
 *
 * A table cell after its row's first that is not found is tried once more,
 * right after the next tab on its row's line ({@link nextCellStart}): once
 * one cell of a row was spelled differently, the cursor stayed before it and
 * every cell after it in the row missed (R6-FMT-3). That costs one more
 * comparison per cell, and a binary search for the tab moves the row on past
 * it. A row whose first cell is empty or not found is placed at the start of
 * the first line after the last block matched ({@link placeRow}).
 */
function locate(arbiter: PlainArbiter, solid: string, lines: number): number {
  if (solid.length === 0) {
    // An empty cell still has its tab, which the next cell is after; an
    // empty first cell places its row.
    if (cellColumn > 0) {
      nextCellStart(arbiter);
    } else if (cellColumn === 0) {
      placeRow(arbiter, Math.max(arbiter.head, firstAtOrAfter(arbiter.heads, arbiter.next)));
    }

    return -1;
  }

  // Found at the cursor, the blocks missed before it stood nowhere in the
  // plain text, and the lines they were taken to stand on are given back.
  if (arbiter.solid.startsWith(solid, arbiter.next)) {
    arbiter.head = 0;

    return arbiter.next;
  }

  const { heads } = arbiter;
  // The first line starting at or after the cursor.
  let low = 0;
  let high = heads.length;

  while (low < high) {
    const middle = (low + high) >>> 1;

    if (heads[middle]! < arbiter.next) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const from = Math.max(arbiter.head, low);
  const last = Math.min(heads.length, from + RESYNC_LINES);

  for (let index = from; index < last; index += 1) {
    // No reset here: every line a miss claimed is at or before this one,
    // and the cursor moves past it.
    if (arbiter.solid.startsWith(solid, heads[index]!)) {
      return heads[index]!;
    }
  }

  // The lines the misses claimed, from the cursor's: found there, they were
  // claimed wrongly, and are given back.
  const claimed = Math.min(from, low + RESYNC_LINES);

  for (let index = low; index < claimed; index += 1) {
    if (arbiter.solid.startsWith(solid, heads[index]!)) {
      arbiter.head = 0;

      return heads[index]!;
    }
  }

  // A cell after its row's first: once more, after the next tab.
  if (cellColumn > 0) {
    const start = nextCellStart(arbiter);

    if (start !== -1 && arbiter.solid.startsWith(solid, start)) {
      return start;
    }
  }

  // A block missed mid-line -- the text after an image Firefox wrote the alt
  // text of -- starts on the line the cursor is in, which is not among them.
  // A table cell after a row's first starts mid-line by definition, after
  // the tab Firefox writes, and claims none.
  const midLine = from === low && heads[low] !== arbiter.next;
  const claims = cellColumn > 0 ? 0 : Math.max(0, midLine ? lines - 1 : lines);

  // A row's first cell missed: its row is taken to start on the line it was
  // looked for from, and the tabs after its cells are looked for from there.
  if (cellColumn === 0) {
    placeRow(arbiter, from);
  }

  arbiter.head = Math.min(heads.length, from + claims);

  return -1;
}

/**
 * The column of the table cell being read, or -1 for any other block. A
 * block {@link locate} does not find claims the lines it holds, but a cell
 * after its row's first does not: Firefox's plain text writes a whole row on
 * one line.
 */
let cellColumn = -1;

/**
 * Where in the plain text the tab after the current row's next cell is
 * looked for: past the last cell of the row found, or past the tab of the
 * last one missed. -1 before the row has a place.
 */
let rowCursor = -1;

/** The index of the first of a sorted list's values at or after `value`. */
function firstAtOrAfter(list: Int32Array, value: number): number {
  let low = 0;
  let high = list.length;

  while (low < high) {
    const middle = (low + high) >>> 1;

    if (list[middle]! < value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

/**
 * Places a row whose first cell is empty or was not found at the start of
 * the line of `heads[line]` -- the first line at or after the cursor's that
 * holds a character, past any the blocks missed before it claimed -- or
 * nowhere. Firefox writes each row on a line of its own, so a cursor
 * mid-line is the end of the last row matched, never this one's start, and
 * an empty first cell starts its line with the tab the next cell is after
 * (R7-FMT-2).
 */
function placeRow(arbiter: PlainArbiter, line: number): void {
  const head = arbiter.heads[line];

  if (head === undefined) {
    rowCursor = -1;

    return;
  }

  const before = firstAtOrAfter(arbiter.lineEnds, arbiter.at[head]!) - 1;

  rowCursor = before < 0 ? 0 : arbiter.lineEnds[before]! + 1;
}

/**
 * The index into the arbiter's `solid` of the first character after the
 * next tab on the current row's line -- where the next cell starts, if that
 * cell holds anything -- or -1. Moves the row past that tab, or to the end
 * of the line when there is none. Every step is a binary search, so a row
 * placed again and again on one long line costs nothing per row (R7-FMT-3:
 * a walk to the tab crossed the line once per row).
 */
function nextCellStart(arbiter: PlainArbiter): number {
  const { text, breaks } = arbiter;

  if (rowCursor < 0) {
    return -1;
  }

  const tab = firstAtOrAfter(breaks, rowCursor);

  if (tab === breaks.length) {
    rowCursor = text.length;

    return -1;
  }

  const at = breaks[tab]!;

  if (text.charCodeAt(at) === 10) {
    rowCursor = at;

    return -1;
  }

  rowCursor = at + 1;

  // The cell's first character, unless another tab or the line's end comes
  // before it.
  const first = firstAtOrAfter(arbiter.at, at + 1);

  if (
    first === arbiter.at.length ||
    (tab + 1 < breaks.length && breaks[tab + 1]! < arbiter.at[first]!)
  ) {
    return -1;
  }

  return first;
}

/** How many of a text's lines hold a character other than whitespace. */
function solidLines(text: string): number {
  let count = 0;
  let open = false;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code === 10) {
      open = false;
    } else if (!open && !isBlank(code)) {
      open = true;
      count += 1;
    }
  }

  return count;
}

/** After a line feed, or the tab Firefox's plain text puts between two cells. */
function isLineOrCellStart(previous: number): boolean {
  return previous === 10 || previous === 9;
}

/** Whether `text` holds `part` at `from`, compared without allocating. */
function holdsAt(
  text: string,
  from: number,
  part: string,
  partFrom: number,
  length: number,
): boolean {
  if (from < 0 || from + length > text.length) {
    return false;
  }

  for (let index = 0; index < length; index += 1) {
    if (text.charCodeAt(from + index) !== part.charCodeAt(partFrom + index)) {
      return false;
    }
  }

  return true;
}

/**
 * Where the block matched at `found` would start its own leading spaces if
 * Firefox indented its line by `indent` ({@link plainIndent}): the line's
 * start plus `indent`, when the block is the first thing on its line and
 * the line starts with at least that many spaces. -1 otherwise -- mid-line,
 * after a cell's tab, or not indented that far. Costs two binary searches
 * and the indentation's length.
 */
function indentedFrom(arbiter: PlainArbiter, found: number, indent: number): number {
  if (indent === 0) {
    return -1;
  }

  const { text, at, lineEnds, breaks } = arbiter;
  const startsAt = at[found]!;
  // The first character after the last line feed before the block.
  const end = firstAtOrAfter(lineEnds, startsAt) - 1;
  const lineStart = end < 0 ? 0 : lineEnds[end]! + 1;
  // A solid character or a tab between it and the block: not its line's first.
  const previous = found > 0 ? at[found - 1]! : -1;
  const lastBreak = breaks[firstAtOrAfter(breaks, startsAt) - 1] ?? -1;

  if (previous >= lineStart || lastBreak >= lineStart || startsAt - lineStart < indent) {
    return -1;
  }

  for (let index = lineStart; index < lineStart + indent; index += 1) {
    if (text.charCodeAt(index) !== 32) {
      return -1;
    }
  }

  return lineStart + indent;
}

/**
 * Whether the plain text's gap `plainFrom`..`plainTo` is the source's gap
 * `rawFrom`..`rawTo` with `indent` spaces after each line feed -- Firefox's
 * indentation of the next line ({@link plainIndent}). Costs the shorter gap.
 *
 * Two lines Firefox writes differently: an empty one -- a line feed that the
 * next one follows -- with no indentation at all (R8-FMT-3), and between two
 * paragraphs of one block, where the source has one line feed, a blank line
 * before the indentation (R8-FMT-5) -- an indentation of 0 included, in a
 * table cell or a bare `<li>` (R9-FMT-2), where this is the exact match
 * otherwise. Neither reads a character of its own.
 */
function holdsIndented(
  plain: string,
  plainFrom: number,
  plainTo: number,
  raw: string,
  rawFrom: number,
  rawTo: number,
  indent: number,
): boolean {
  let cursor = plainFrom;

  for (let index = rawFrom; index < rawTo; index += 1) {
    const code = raw.charCodeAt(index);

    if (cursor >= plainTo || plain.charCodeAt(cursor) !== code) {
      return false;
    }

    cursor += 1;

    if (code === 10) {
      if (index + 1 < rawTo && raw.charCodeAt(index + 1) === 10) {
        continue;
      }

      if (cursor < plainTo && plain.charCodeAt(cursor) === 10) {
        cursor += 1;
      }

      if (plainTo - cursor < indent) {
        return false;
      }

      for (let step = 0; step < indent; step += 1) {
        if (plain.charCodeAt(cursor + step) !== 32) {
          return false;
        }
      }

      cursor += indent;
    }
  }

  return cursor === plainTo;
}

/**
 * Whether the plain text's gap `from`..`to` starts a line with Firefox's
 * `indent` spaces ({@link plainIndent}): a line feed followed by that many.
 * A gap that does is decided by {@link holdsIndented} alone, since the
 * source's spaces after a break can be exactly as many (R8-FMT-4); one that
 * does not, as any other. Costs the gap and one indentation.
 */
function showsIndent(plain: string, from: number, to: number, indent: number): boolean {
  if (indent === 0) {
    return false;
  }

  for (let index = from; index < to; index += 1) {
    if (plain.charCodeAt(index) !== 10 || to - index - 1 < indent) {
      continue;
    }

    let spaces = 0;

    while (spaces < indent && plain.charCodeAt(index + 1 + spaces) === 32) {
      spaces += 1;
    }

    if (spaces === indent) {
      return true;
    }

    index += spaces;
  }

  return false;
}

/**
 * Advances the plain-text cursor past a block read without a choice to make:
 * a code block, a table cell, a callout. Without it the block after one would
 * not be at the cursor.
 */
function passPlain(text: string): void {
  if (plainArbiter) {
    arbitrate(null, richFromText(text));
  }
}

function richFromText(text: string): RichText {
  return text.length > 0 ? [{ text }] : [];
}

/**
 * A block's collapsed reading, with each run of whitespace in it as it stands
 * in the source where the clipboard's plain text holds exactly that. Firefox
 * writes a page's classes into the HTML rather than their computed style, so a
 * `<p class="pw">` a stylesheet makes `pre-wrap` and a source-wrapped `<p>`
 * look the same -- but its `text/plain` is the text as drawn, which tells
 * them apart.
 *
 * The block is matched where it should stand -- at the cursor, the end of the
 * last block matched -- by its solid characters, so the comparison costs its
 * own length and an identical block elsewhere is never taken for it. Every
 * block moves the cursor on, `raw` or not: one that has nothing to decide
 * passes `null`.
 *
 * Then each gap between two of its solid characters is the source's when the
 * plain text's gap there is the same characters, and the collapsed reading's
 * otherwise -- so a paragraph's source line-wrapping collapses while the
 * double space in its pre-wrap code stands. At the block's edges the plain
 * text cannot tell the block's own whitespace from the gap between blocks
 * when a line break is involved, so only spaces and tabs count there: a
 * line's indentation, exactly, and what ends the line -- the last only when
 * `trailing` says the end was asked about too ({@link readBlockText}). A
 * pre-wrap block's last newline ends its last line, as a trailing `<br>`
 * does, and draws none.
 *
 * Firefox indents every line of a list item, a `<dd>` and a quote by
 * `indent` spaces ({@link plainIndent}). Where a line of the block starts
 * with exactly that many spaces they are Firefox's, not the block's: its
 * leading spaces are the ones after them, and a gap holding a line break
 * matches with them after each break (R7-FMT-4). Where they are not there,
 * the block is decided as any other. Where they are, such a gap matches only
 * with them: the spaces after a `<br>` in a `normal` item, exactly as many,
 * matched the plain text as they stand though nothing drew them (R8-FMT-4).
 * The leading spaces are counted past `leadIndent`, the indentation of the
 * element the text starts in, which can be deeper than the block's
 * (R8-FMT-5) -- and where it is, a line break matches past either.
 */
function arbitrate(
  raw: RichText | null,
  collapsed: RichText,
  trailing = true,
  indent = 0,
  leadIndent = indent,
  solids: SolidHolders | null = null,
): RichText {
  const arbiter = plainArbiter;

  if (!arbiter) {
    return collapsed;
  }

  const collapsedText = asPlain(richToPlainText(collapsed));
  const ours = solidsOf(collapsedText);
  const found = locate(arbiter, ours.solid, solidLines(collapsedText));

  if (found === -1) {
    return collapsed;
  }

  const count = ours.solid.length;
  const startsAt = arbiter.at[found]!;
  const endsAt = arbiter.at[found + count - 1]! + 1;

  arbiter.next = found + count;

  if (cellColumn >= 0) {
    rowCursor = Math.max(rowCursor, endsAt);
  }

  if (raw === null) {
    return collapsed;
  }

  const rawText = asPlain(richToPlainText(raw));
  const source = solidsOf(rawText);

  if (source.solid !== ours.solid) {
    return collapsed;
  }

  const plain = arbiter.text;
  // Pieces of the result, each a slice of the source (`raw`) or of the
  // collapsed reading, in order.
  const pieces: Array<{ raw: boolean; from: number; to: number }> = [];
  let anyRaw = false;
  const take = (fromRaw: boolean, from: number, to: number): void => {
    if (from >= to) {
      return;
    }

    const last = pieces.at(-1);

    if (last && last.raw === fromRaw && last.to === from) {
      last.to = to;
    } else {
      pieces.push({ raw: fromRaw, from, to });
    }

    anyRaw ||= fromRaw;
  };

  // The indentation of the line it starts, exactly -- or of the table cell,
  // which Firefox starts with a tab (R4-FMT-6a). Always after the cursor: the
  // run before the block is whitespace, and the last block matched ended in
  // a character that is not.
  const lead = source.at[0]!;
  const indented = indentedFrom(arbiter, found, leadIndent);
  const leadRaw =
    lead > 0 &&
    !/[\n\r]/.test(rawText.slice(0, lead)) &&
    (indented === -1
      ? (startsAt - lead === 0 || isLineOrCellStart(plain.charCodeAt(startsAt - lead - 1))) &&
        holdsAt(plain, startsAt - lead, rawText, 0, lead)
      : startsAt - indented === lead && holdsAt(plain, indented, rawText, 0, lead));

  if (leadRaw) {
    take(true, 0, lead);
  } else {
    take(false, 0, ours.at[0]!);
  }

  // Line by line, by the element each line starts in, where the block has no
  // indentation of its own and its characters are the ones counted there.
  const perLine = indent === 0 && solids !== null && solids.total === count ? solids : null;

  for (let index = 0; index < count; index += 1) {
    take(true, source.at[index]!, source.at[index]! + 1);

    if (index === count - 1) {
      break;
    }

    const rawFrom = source.at[index]! + 1;
    const rawTo = source.at[index + 1]!;
    const plainFrom = arbiter.at[found + index]! + 1;
    const plainTo = arbiter.at[found + index + 1]!;
    const deeper = leadIndent > indent;
    // With no indentation of its own -- a table cell, a bare `<li>` from a
    // drag begun inside a list -- a block can still hold a list, a quote or
    // a definition Firefox indents, so each line is matched past the
    // indentation of the element its first character stands in. Where that
    // is none, Firefox still writes the blank line between two paragraphs
    // (R9-FMT-2), which `holdsIndented` allows -- with no indentation it is
    // the exact match where the gap has no blank line. Where it is some, a
    // gap that shows it is decided by it alone, as a list item's own lines
    // are (R8-FMT-4): taking the blank line and then that indentation for
    // the block's drawn spaces pasted four undrawn ones (R9-RV-FMT-1), and
    // the spaces after a `<br>` in a `normal` item in a cell stood
    // (R9-RV-FMT-3). Where the characters cannot be placed, as before.
    // The whole gap as it was read before the per-line rule: by the
    // indentation of the block and of the element its text starts in.
    const asBefore = (): boolean =>
      showsIndent(plain, plainFrom, plainTo, indent) ||
      (deeper && showsIndent(plain, plainFrom, plainTo, leadIndent))
        ? holdsIndented(plain, plainFrom, plainTo, rawText, rawFrom, rawTo, indent) ||
          (deeper && holdsIndented(plain, plainFrom, plainTo, rawText, rawFrom, rawTo, leadIndent))
        : plainTo - plainFrom === rawTo - rawFrom &&
          holdsAt(plain, plainFrom, rawText, rawFrom, rawTo - rawFrom);
    let asDrawn: boolean;

    if (perLine) {
      const holder = solidHolder(perLine, index + 1);
      const next = plainIndent(arbiter, holder);
      const line = (pFrom: number, pTo: number, rFrom: number): boolean =>
        next === 0 || showsIndent(plain, pFrom, pTo, next)
          ? holdsIndented(plain, pFrom, pTo, rawText, rFrom, rawTo, next)
          : pTo - pFrom === rawTo - rFrom && holdsAt(plain, pFrom, rawText, rFrom, rawTo - rFrom);
      const oursFrom = ours.at[index]! + 1;
      const oursTo = ours.at[index + 1]!;
      const rawFeed = firstLineFeed(rawText, rawFrom, rawTo);
      const plainFeed = firstLineFeed(plain, plainFrom, plainTo);
      const oursFeed = firstLineFeed(collapsedText, oursFrom, oursTo);

      // Split at the first line feed (R9-RV2-FMT-1): judged whole, the
      // spaces ending the line above rode along with the line below -- a
      // `<dd>`'s trailing space, which Firefox writes drawn or not -- or,
      // left out of the plain text, cost the line below its drawn lead. What
      // ends a block there is the collapsed reading's, as a block's own end
      // is where it is not asked -- unless the whole gap matched as it was
      // read before (`asBefore`), so that nothing read right then is lost;
      // within one block it stands where the plain text holds exactly it (a
      // `pre-wrap` line's drawn trailing space). The rest is the line below,
      // from the line feed on.
      if (rawFeed > rawFrom && plainFeed !== -1 && oursFeed !== -1) {
        const before = rawFeed - rawFrom;
        const keepEnd =
          plainFeed - plainFrom === before &&
          holdsAt(plain, plainFrom, rawText, rawFrom, before) &&
          (lineBlock(solidHolder(perLine, index)) === lineBlock(holder) || asBefore());

        if (keepEnd) {
          take(true, rawFrom, rawFeed);
        } else {
          take(false, oursFrom, oursFeed);
        }

        if (line(plainFeed, plainTo, rawFeed)) {
          take(true, rawFeed, rawTo);
        } else {
          take(false, oursFeed, oursTo);
        }

        continue;
      }

      asDrawn = line(plainFrom, plainTo, rawFrom);
    } else {
      asDrawn = asBefore();
    }

    if (asDrawn) {
      take(true, rawFrom, rawTo);
    } else {
      take(false, ours.at[index]! + 1, ours.at[index + 1]!);
    }
  }

  // What ends its last line, exactly, up to the end of the line -- only when
  // the end was asked about at all: Firefox writes an undrawn trailing space
  // where it leaves out an undrawn leading one (R5-FMT-2). Not of a cell
  // before the tab, either, where Firefox writes it too (`cell \tc2`).
  const trailFrom = source.at[count - 1]! + 1;
  const trailTo = rawText.endsWith('\n') ? rawText.length - 1 : rawText.length;
  const trail = trailTo - trailFrom;
  const trailRaw =
    trailing &&
    trail > 0 &&
    !/[\n\r]/.test(rawText.slice(trailFrom, trailTo)) &&
    holdsAt(plain, endsAt, rawText, trailFrom, trail) &&
    (endsAt + trail === plain.length || plain.charCodeAt(endsAt + trail) === 10);

  if (trailRaw) {
    take(true, trailFrom, trailTo);
  } else {
    take(false, ours.at[count - 1]! + 1, collapsedText.length);
  }

  return anyRaw ? stitch(raw, collapsed, pieces) : collapsed;
}

/**
 * The runs made of `pieces` -- slices of `raw` and of `collapsed` by character
 * offset, each source's slices in order -- with each character's marks and
 * link. One pass over each source, however many pieces.
 */
function stitch(
  raw: RichText,
  collapsed: RichText,
  pieces: ReadonlyArray<{ raw: boolean; from: number; to: number }>,
): RichText {
  const cursors = [
    { runs: raw, run: 0, start: 0 },
    { runs: collapsed, run: 0, start: 0 },
  ];
  const out: TextRun[] = [];

  for (const piece of pieces) {
    const cursor = cursors[piece.raw ? 0 : 1]!;
    let from = piece.from;

    while (from < piece.to && cursor.run < cursor.runs.length) {
      const run = cursor.runs[cursor.run]!;
      const runEnd = cursor.start + run.text.length;

      if (from >= runEnd) {
        cursor.start = runEnd;
        cursor.run += 1;
        continue;
      }

      const to = Math.min(piece.to, runEnd);

      out.push({ ...run, text: run.text.slice(from - cursor.start, to - cursor.start) });
      from = to;
    }
  }

  return normalizeRuns(out);
}

/** Our own serializer records depth explicitly; other sources have none. */
function depthOf(element: Element, fallback: number): number {
  const declared = Number.parseInt((element as HTMLElement).dataset?.neditorDepth ?? '', 10);

  return Number.isFinite(declared) && declared >= 0 ? declared : fallback;
}

function pushCallout(out: Block[], element: Element, depth: number, icon: string): void {
  const runs = parseRichText(element, isNestedList);
  passPlain(richToPlainText(runs));
  const block = createBlock('callout', runs, depthOf(element, depth));
  block.icon = normalizeControlCharacters(icon) || DEFAULT_CALLOUT_ICON;
  out.push(block);
}

/** Everything left below the bound, as one block rather than none. */
function pushRemainder(out: Block[], node: Node, depth: number): void {
  const text = normalizeControlCharacters(subtreeText(node));

  if (text.trim().length > 0) {
    out.push(createBlock('paragraph', text, depth));
  }
}

/**
 * Takes a wrapped `summary` out of the tree below `details`.
 *
 * What {@link firstDescendant} remembers about each element from the summary
 * up to `details` may name something inside it -- a wrapper holding a block,
 * or an image, only because the summary did -- so those answers are forgotten
 * and asked afresh of the tree as it now stands. Nothing else below `details`
 * holds the summary, so nothing else can be affected; the elements above it
 * have already been answered and acted on.
 *
 * Only the block answer is observable today, and it is pinned: an inline
 * wrapper outside the toggle asks whether the elements below it hold a block
 * before the toggle is reached. Every other memo built on `firstDescendant`
 * is forgotten too, though nothing asks those questions of these elements
 * first, so that a question added earlier later cannot be answered with a
 * node that has left the tree.
 */
function detachSummary(summary: Element, details: Element): void {
  for (let at = summary.parentElement; at !== null; at = at.parentElement) {
    BLOCK_LEVEL_DESCENDANTS.delete(at);
    IMAGE_DESCENDANTS.delete(at);
    DISPLAY_BLOCK_DESCENDANTS.delete(at);
    LIST_ITEM_DESCENDANTS.delete(at);
    SUMMARY_DESCENDANTS.delete(at);

    if (at === details) {
      break;
    }
  }

  summary.remove();
}

/**
 * A `<details>` becomes a toggle whose `<summary>` is its text.
 *
 * Whatever else it contains is nested one level deeper, so a `<details>` from
 * anywhere else keeps its structure rather than collapsing into one block.
 */
function visitDetails(doc: Document, element: Element, depth: number, out: Block[]): void {
  const summary = firstSummary(element);
  const title = summary ? parseRichText(summary) : [];
  passPlain(richToPlainText(title));
  const block = createBlock('toggle', title, depthOf(element, depth));
  block.collapsed = !element.hasAttribute('open');
  out.push(block);

  // The summary is skipped by identity rather than removed from a copy: a
  // <details> holds every nested <details> below it, so cloning one per level
  // was quadratic in the nesting depth exactly as the list case was.
  //
  // Identity only reaches a direct child, though: `visitBlocksInner` tests it
  // against its own children, and the descents into lists, quotes and blocks
  // do not carry it. A `<summary>` wrapped in anything -- malformed, since the
  // element must be a details' first child, but what a stray `<span>` or
  // `<li>` around it produces, and what a hostile paste can repeat at will --
  // was therefore read as the title *and* again as body content, in the list
  // case concatenated into that item's own text. So that summary is taken out
  // of the tree instead, which works at any depth. Its text has already been
  // read, and the tree is the detached parse `blocksFromHtml` made, which the
  // formatting moves rearrange already.
  //
  // It used to be taken out of a copy of the whole element, and a <details>
  // holds every one nested below it, so wrapped summaries nested 180 deep
  // copied the document 180 times and ran out of heap. The copy also removed
  // its first `<summary>` by query, which could be a hidden one in a
  // `<noscript>` rather than the one just read as the title.
  if (summary && summary.parentElement !== element) {
    detachSummary(summary, element);
    visitBlocks(doc, element, block.depth + 1, out);

    return;
  }

  visitBlocks(doc, element, block.depth + 1, out, summary ?? undefined);
}

/** Reads a `<table>` into a grid; `normalizeTableRows` squares off ragged rows. */
function pushTable(out: Block[], element: Element, depth: number): void {
  const rows: TableRows = [];

  const children = [...element.children];

  // A table block has no caption, so the caption is the paragraph above it
  // rather than text that silently goes nowhere.
  const caption = children.find((child) => tagNameOf(child) === 'CAPTION');
  const captionRuns = caption ? parseRichText(caption) : [];
  passPlain(richToPlainText(captionRuns));

  if (!isRichEmpty(captionRuns)) {
    out.push(createBlock('paragraph', captionRuns, depthOf(element, depth)));
  }

  // And its images after it, as a heading's are.
  if (caption && containsImage(caption)) {
    for (const image of textImages(caption, () => false).filter(hasUsableImage)) {
      pushImage(out, image, depthOf(element, depth));
    }
  }

  // Rows and cells come from the children, so a nested table contributes no
  // rows to this one; it is read as its cell's text instead, which a cell is
  // made of -- stripped, it was text gone. Not by a `:scope >` query, which
  // walks -- recursively, in some DOMs -- the whole subtree: a table in a list
  // item has its cells read, and a cell can hold the rest of the list, so that
  // read every level below once per level.
  const rowElements = children.flatMap((child) => {
    const tag = tagNameOf(child);

    return tag === 'TR'
      ? [child]
      : tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT'
        ? [...child.children].filter((row) => tagNameOf(row) === 'TR')
        : [];
  });

  for (const row of rowElements) {
    const cells: RichText[] = [];

    // A row has no place in the plain text until one of its cells is found.
    rowCursor = -1;

    for (const cell of row.children) {
      const tag = tagNameOf(cell);

      // A cell is drawn as any block is: its source whitespace collapses
      // unless a style preserves it -- this writer marks its own cells
      // pre-wrap -- and the plain text decides one a stylesheet preserves.
      // Read as it stood, WebKit's undrawn space at a cell's end stayed.
      if (tag === 'TH' || tag === 'TD') {
        cellColumn = cells.length;

        try {
          cells.push(readBlockText(cell));
        } finally {
          cellColumn = -1;
        }
      }
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

  // A cell holds text, so its images -- an email's banner, laid out in a
  // table -- are handed on after the table rather than dropped; a table of
  // nothing but images is those images, with no empty table above them.
  const images: Element[] = [];

  for (const row of rowElements) {
    for (const cell of row.children) {
      const tag = tagNameOf(cell);

      if ((tag === 'TH' || tag === 'TD') && containsImage(cell)) {
        images.push(...textImages(cell, () => false).filter(hasUsableImage));
      }
    }
  }

  if (images.length === 0 || rows.some((row) => row.some((cell) => !isRichEmpty(cell)))) {
    out.push(block);
  }

  for (const image of images) {
    pushImage(out, image, block.depth);
  }
}

/**
 * A blockquote becomes a quote (or callout), with any list it held underneath.
 *
 * The quote's own text is read skipping every list in it, so without visiting
 * them separately a quoted list — the ordinary shape on GitHub, Wikipedia and
 * Stack Overflow — is dropped on the floor. Its images are handed on after it,
 * a level in, except those in its lists, which are the lists' own.
 */
function visitQuote(element: Element, depth: number, out: Block[]): void {
  const icon = element.getAttribute(CALLOUT_ATTR);
  const lists = outermostLists(element);
  const quoteDepth = depthOf(element, depth);

  const images =
    icon === null && containsImage(element)
      ? textImages(element, isNestedList).filter(hasUsableImage)
      : [];

  // A blockquote holding nothing but a list is that list, and one holding
  // nothing but an image -- a quoted screenshot -- is that image: an empty
  // quote above it would be a block the source never had. Our own callouts
  // keep theirs, since the marker says the block was really there.
  const bare =
    icon === null &&
    (lists.length > 0 || images.length > 0) &&
    isRichEmpty(parseRichText(element, isNestedList));

  if (!bare) {
    if (icon === null) {
      pushBlock(out, 'quote', element, depth, quoteDepth + 1);
    } else {
      pushCallout(out, element, depth, icon.length > 0 ? icon : DEFAULT_CALLOUT_ICON);
    }
  } else {
    for (const image of images) {
      pushImage(out, image, quoteDepth);
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
  const lists: Element[] = [];
  const walker = element.ownerDocument.createTreeWalker(element, SHOW_ELEMENT, {
    // A list is taken and not descended into, so each quote reads only its own
    // content. Querying the whole subtree instead read every level below once
    // per level, which a quote in a list item, nested, made quadratic.
    acceptNode: (candidate) => {
      const tag = tagNameOf(candidate);

      // Nor into anything the walker skips: a list in a `<noscript>` was
      // added after the quote as an item the page never showed.
      if (SKIP_TAGS.has(tag)) {
        return FILTER_REJECT;
      }

      if (tag === 'UL' || tag === 'OL') {
        lists.push(candidate as Element);
        return FILTER_REJECT;
      }

      return FILTER_ACCEPT;
    },
  });

  while (walker.nextNode()) {
    // The filter collects as the walk goes.
  }

  return lists;
}

/** A `<figure>` carries the caption; a bare `<img>` is just the image. */
function pushImage(out: Block[], element: Element, depth: number): boolean {
  // An `<img>` is itself; a `<figure>` arrives here once, already accepted by
  // `isImageFigure` or carrying our own marker.
  const image = pictureOf(element);
  const src = image === null ? null : imageSource(image);

  // Our own empty image block (see blocksToHtml) -- only ours: a foreign
  // `<img>` with no usable source is still skipped, not made a placeholder.
  const emptyOwn =
    !src && !image && tagNameOf(element) === 'FIGURE' && element.hasAttribute('data-neditor-image');

  // An unusable source would only render as a broken block. The caller
  // recurses into the element instead, so a <figure> keeps its other children.
  if (!src && !emptyOwn) {
    return false;
  }

  // Its own caption: a figure nested in it has its own.
  const caption = ownCaption(element);
  const block = createBlock(
    'image',
    caption ? parseRichText(caption) : [],
    depthOf(element, depth),
  );
  block.src = src ?? '';
  block.alt = normalizeControlCharacters(
    image?.getAttribute('alt') ?? element.getAttribute('data-neditor-alt') ?? '',
  );
  out.push(block);

  // An image in the caption -- a Wikipedia thumbnail's flag icon -- is handed
  // on after it, as one in a heading is; the caption holds text.
  if (caption && containsImage(caption)) {
    for (const inner of textImages(caption, () => false).filter(hasUsableImage)) {
      pushImage(out, inner, block.depth);
    }
  }

  return true;
}

/**
 * What a list item can hold besides its text: blocks of their own, as direct
 * children only. Each of these reads without descending into an inline wrapper
 * -- a heading or a quote parses its own text, a code block or a table reads
 * its own cells -- so formatting is never pushed inward from inside an item,
 * which a list item, read whole, has always been sealed against: done once per
 * level, it cloned everything below. A `<figure>` or `<img>` counts only with
 * an image the reader will take; any other is no block and splits nothing.
 */
const ITEM_BLOCK_TAGS = new Set([
  ...Object.keys(HEADING_TYPES),
  'BLOCKQUOTE',
  'PRE',
  'TABLE',
  'HR',
]);

function isItemBlock(element: Element): boolean {
  const tag = tagNameOf(element);

  if (ITEM_BLOCK_TAGS.has(tag)) {
    return true;
  }

  if (!hasUsableImage(element)) {
    return false;
  }

  // GitHub wraps every image in a link, and a loose list every line in a
  // paragraph: one holding nothing but the image is the image. Holding text,
  // or a task list's checkbox, it is the item's text.
  return (
    tag === 'IMG' ||
    tag === 'FIGURE' ||
    ((tag === 'P' || tag === 'A') &&
      holdsOnlyImage(element, tag === 'A' && !containsBlockLevel(element)))
  );
}

/**
 * The images in an element's own text, past whatever `skip` hides. `pushImage`
 * refuses any whose source is unusable.
 */
function textImages(root: Element, skip: SkipPredicate): Element[] {
  const images: Element[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, SHOW_ELEMENT, {
    acceptNode: (candidate) => {
      const tag = tagNameOf(candidate);

      return SKIP_TAGS.has(tag) || skip(candidate as Element, tag) ? FILTER_REJECT : FILTER_ACCEPT;
    },
  });

  for (let found = walker.nextNode(); found !== null; found = walker.nextNode()) {
    if (tagNameOf(found) === 'IMG') {
      images.push(found as Element);
    }
  }

  return images;
}

/**
 * Whether a `<figure>` is one picture: its own (first) caption aside, it holds a
 * single usable image -- bare, linked, in a `<picture>` -- and no text. Only
 * then is it read as an image block; any other figure is read block by block.
 * Our own image blocks are written this way, and so is every image figure
 * WordPress or Ghost writes; their tables, galleries and cards are not.
 */
function isImageFigure(figure: Element): boolean {
  if (!hasUsableImage(figure)) {
    return false;
  }

  let images = 0;
  const caption = ownCaption(figure);
  const walker = figure.ownerDocument.createTreeWalker(figure, SHOW_TEXT | SHOW_ELEMENT, {
    acceptNode: (candidate) =>
      SKIP_TAGS.has(tagNameOf(candidate)) || candidate === caption ? FILTER_REJECT : FILTER_ACCEPT,
  });

  // Left at the first text or the second image, either of which settles it.
  for (let found = walker.nextNode(); found !== null; found = walker.nextNode()) {
    if (found.nodeType === TEXT_NODE && /[^ \t\n\r\f]/.test(found.nodeValue ?? '')) {
      return false;
    }

    if (tagNameOf(found) === 'IMG' && ++images > 1) {
      return false;
    }
  }

  return images === 1;
}

/**
 * Whether an element holds no text and no checkbox. Walked, and left at the
 * first of either: `textContent` recurses through the subtree in some DOMs,
 * and counts a style sheet's source as text.
 *
 * @param strict Whether a space counts as text: it does in a link, which sits
 * in a sentence and whose space is the sentence's (`a<a><img> </a>b` read
 * `ab`), and not in a paragraph -- or in a link holding a block, which is no
 * part of a sentence. Whitespace carrying a line break is pretty-printing in
 * either, as around a link that is an item's only content.
 */
function holdsOnlyImage(element: Element, strict: boolean): boolean {
  const isText = (value: string, spaces: boolean): boolean =>
    value.trim().length > 0 || (spaces && value.length > 0 && !value.includes('\n'));

  const walker = element.ownerDocument.createTreeWalker(element, SHOW_TEXT | SHOW_ELEMENT, {
    acceptNode: (candidate) =>
      SKIP_TAGS.has(tagNameOf(candidate)) ? FILTER_REJECT : FILTER_ACCEPT,
  });

  for (let found = walker.nextNode(); found !== null; found = walker.nextNode()) {
    if (
      tagNameOf(found) === 'INPUT' ||
      (found.nodeType === TEXT_NODE && isText(found.nodeValue ?? '', strict))
    ) {
      return false;
    }
  }

  return true;
}

/**
 * The children a list item hands on as blocks of their own: its nested lists,
 * as always, and now its blocks.
 *
 * Read whole, a foreign item's image, table or code block went into its text
 * or nowhere (`<li>Open settings<br><img …></li>` lost the picture). Its
 * nested lists, its blocks, and a paragraph after the first of them are its
 * children, in order; everything else is its text, read in place. So bare text
 * after a block is still the item's, and the item -- its to-do, its number --
 * survives a block in front of its text.
 */
function itemBlocks(item: Element): Set<Element> {
  const blocks = new Set<Element>();

  for (const child of item.children) {
    const tag = tagNameOf(child);

    if (tag === 'UL' || tag === 'OL' || isItemBlock(child) || (tag === 'P' && blocks.size > 0)) {
      blocks.add(child);
    }
  }

  return blocks;
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
  const blocks = itemBlocks(item);
  // Read in place, never copied: an item holds the whole list below it.
  // Only what is visited as a block is skipped: a list the item does not hold
  // directly -- inside a wrapper, a paragraph, a toggle -- is never visited, so
  // skipping it dropped its text. It is read as the item's text instead.
  const skip: SkipPredicate = (element) => blocks.has(element);
  // But a checkbox in a nested list, however deep, is that list's own.
  const checkbox = findWithin(
    item,
    (element, tag) => isNestedList(element, tag) || blocks.has(element),
    (element) => tagNameOf(element) === 'INPUT' && element.getAttribute('type') === 'checkbox',
  );
  const state = item.getAttribute(TODO_ATTR);
  let runs = readBlockText(item, skip);
  let type = fallback;
  let checked = false;

  if (state !== null) {
    // Our own marker: exact, and the text still carries the box we wrote --
    // the glyph and one space, and nothing more. Stripping every space after
    // it, as a foreign checkbox is stripped, took the to-do's own leading
    // whitespace with it, and a to-do that was only a line break came back
    // empty.
    type = 'todo';
    checked = state === 'true';
    runs = /^[\u2610\u2611] /.test(richToPlainText(runs)) ? richDelete(runs, 0, 2) : runs;
  } else if (checkbox) {
    type = 'todo';
    checked = (checkbox as HTMLInputElement).checked || checkbox.hasAttribute('checked');
    // The space after the box is the box's, as it is after a textual `[ ]`:
    // GitHub's task lists put one there.
    runs = richDelete(runs, 0, /^\s*/.exec(richToPlainText(runs))?.[0].length ?? 0);
  } else if (!declared) {
    const todo = extractTodoPrefix(runs);

    if (todo) {
      type = 'todo';
      checked = todo.checked;
      runs = todo.runs;
    }
  }

  // Beside a foreign item's blocks, text that is only whitespace or a break is
  // the layout around them: `<li>\n<pre>…</pre>\n</li>` holds a code block,
  // not a line of nothing above it. Our own lists keep an item's whitespace.
  if (!declared && blocks.size > 0 && richToPlainText(runs).trim() === '') {
    runs = [];
  }

  // An item whose blocks come before any text of its own takes its first
  // paragraph as its text, rather than vanishing and renumbering the list:
  // GitHub writes `1. ![shot](a.png)` + `Click it.` as an image paragraph and
  // a text paragraph inside the item. The paragraph reads before the block,
  // as bare text after a block does.
  if (!declared && isRichEmpty(runs)) {
    for (const block of blocks) {
      if (tagNameOf(block) === 'P') {
        const text = readBlockText(block);

        // The first that holds text: a blank one is a blank line, and stays.
        if (richToPlainText(text).trim().length > 0) {
          blocks.delete(block);
          runs = text;
          break;
        }
      }
    }
  }

  // An empty item is a real blank bullet — unless it exists only to hold the
  // lists or blocks nested under it, which is how indentation alone is written
  // by other editors. Never by this one, which hangs a nested list off the item it
  // belongs to: in a list it wrote, an empty item is always a block. A to-do's
  // box is content of its own, so an empty to-do stays.
  if (!isRichEmpty(runs) || blocks.size === 0 || declared || type === 'todo') {
    const block = createBlock(type, runs, itemDepth);

    if (type === 'todo') {
      block.checked = checked;
    }

    out.push(block);
  }

  // An image in the item's text -- its own paragraph, a wrapper, a promoted
  // paragraph, a loose to-do's line -- is handed on as a child image, as a
  // bare one is. Read as text it was dropped: the text has no image.
  for (const image of textImages(item, skip)) {
    pushImage(out, image, itemDepth + 1);
  }

  // A list nested inside the item continues one level deeper, and so does
  // every other block it holds, in the order the item holds them.
  if (blocks.size > 0) {
    visitBlocks(item.ownerDocument, item, itemDepth + 1, out, undefined, (child) =>
      blocks.has(child as Element),
    );
  }
}

function visitList(list: Element, depth: number, out: Block[]): void {
  const fallback: BlockType = tagNameOf(list) === 'OL' ? 'numbered_list' : 'bulleted_list';

  visitListChildren(list, fallback, list.hasAttribute(LIST_ATTR), depth, out);
}

const LIST_ITEM_DESCENDANTS = new WeakMap<Element, Element | null>();

/**
 * A list's children: its items, the lists nested directly in it, and --
 * which pages built by frameworks render, valid or not -- items a wrapper
 * holds (`<ul><a href><li>…</li></a></ul>`), read through the wrapper with its
 * link and formatting pushed into them, and loose content, read as blocks at
 * the list's depth. Both were dropped, the whole list with them where every
 * item was wrapped.
 */
function visitListChildren(
  parent: Node,
  fallback: BlockType,
  declared: boolean,
  depth: number,
  out: Block[],
): void {
  const doc = parent.ownerDocument!;
  let loose: Node[] = [];

  const flushLoose = (): void => {
    const content = loose.some(
      (node) => node.nodeType === ELEMENT_NODE || /[^ \t\n\r\f]/.test(node.nodeValue ?? ''),
    );

    if (content) {
      const wrapper = doc.createElement('div');

      for (const node of loose) {
        wrapper.append(cloneDeep(node));
      }

      visitBlocks(doc, wrapper, depth, out);
    }

    loose = [];
  };

  for (const child of [...parent.childNodes]) {
    const tag = tagNameOf(child);

    if (child.nodeType !== ELEMENT_NODE && child.nodeType !== TEXT_NODE) {
      continue;
    }

    if (SKIP_TAGS.has(tag)) {
      continue;
    }

    if (
      child.nodeType === TEXT_NODE ||
      (tag !== 'LI' && tag !== 'UL' && tag !== 'OL' && !holdsListItem(child as Element))
    ) {
      loose.push(child);
      continue;
    }

    flushLoose();
    // An item, a nested list or a wrapper of items starts a line of its own.
    lineOpen = false;

    if (tag === 'LI') {
      visitListItem(child as Element, fallback, depth, out, declared);
      // And ends it: an item ending in an image leaves the line open.
      lineOpen = false;
    } else if (tag !== 'UL' && tag !== 'OL') {
      // A wrapper around items: the items continue this list, as deep. It
      // nests without passing through an item, so it takes the list bound.
      if (listNesting >= MAX_LIST_NESTING) {
        pushRemainder(out, child, depth);
        continue;
      }

      listNesting += 1;

      try {
        visitListChildren(contentsOf(doc, child as Element), fallback, declared, depth, out);
      } finally {
        listNesting -= 1;
      }
    } else {
      // A list directly inside a list -- what Google Docs and a browser's own
      // indent command write -- is the item before it continuing a level in.
      // It was skipped, with everything under it. It nests without passing
      // through an item, so it takes the list bound here.
      if (listNesting >= MAX_LIST_NESTING) {
        pushRemainder(out, child, depth + 1);
        continue;
      }

      listNesting += 1;

      try {
        visitList(child as Element, depth + 1, out);
      } finally {
        listNesting -= 1;
      }
    }
  }

  flushLoose();
}

function holdsListItem(element: Element): boolean {
  return (
    firstDescendant(
      element,
      (candidate) => tagNameOf(candidate) === 'LI',
      LIST_ITEM_DESCENDANTS,
    ) !== null
  );
}

/** Layout at a paste's edge: layout text, or an element holding no text at all. */
function isEdgeLayout(node: Node): boolean {
  return node.nodeType === ELEMENT_NODE
    ? tagNameOf(node) !== 'BR' && subtreeText(node).length === 0
    : isLayoutText(node);
}

/** Whether a node is or holds a `<br>`, walked without recursion. */
function holdsBreak(node: Node): boolean {
  if (tagNameOf(node) === 'BR') {
    return true;
  }

  if (node.nodeType !== ELEMENT_NODE) {
    return false;
  }

  const walker = node.ownerDocument!.createTreeWalker(node, SHOW_ELEMENT);

  for (let found = walker.nextNode(); found !== null; found = walker.nextNode()) {
    if (tagNameOf(found) === 'BR') {
      return true;
    }
  }

  return false;
}

/** A text node of collapsible whitespace that holds a line break. */
function isLayoutText(node: Node): boolean {
  const value = node.nodeType === TEXT_NODE ? (node.nodeValue ?? '') : '';

  return value.includes('\n') && /^[ \t\n\r\f]*$/.test(value);
}

/**
 * Marks for whitespace a style preserves, while `collapseWhitespace` works:
 * Unicode noncharacters, meant for process-internal use -- but text may carry
 * them all the same, so any the text already holds is escaped with
 * {@link LITERAL} first and read back as itself. A preserved newline is a
 * forced line break.
 */
const PRESERVED: Readonly<Record<string, string>> = {
  ' ': '\uFDD0',
  '\t': '\uFDD1',
  '\n': '\uFDD2',
};
const RESTORED: Readonly<Record<string, string>> = { '\uFDD0': ' ', '\uFDD1': '\t' };
/** A `pre-line` line break, which takes the collapsible space before it. */
const LINE_BREAK = '\uFDD4';
/** Put before a mark the text already held, so it reads as itself. */
const LITERAL = '\uFDD3';
/** A `<br>` after a preserved break: that break stands rather than ends the text. */
const STANDS = '\uFDD5';

type WhiteSpace = 'normal' | 'pre' | 'pre-line';

const WHITE_SPACE = new WeakMap<Element, WhiteSpace>();
const DECLARES_WHITE_SPACE = new WeakMap<Element, boolean>();

/**
 * Whether an element's own `style`, or an ancestor's, says how its whitespace
 * is drawn. Chromium and WebKit write the computed `white-space` on what they
 * copy, and that is believed, whatever the plain text says; Firefox writes
 * only what the page wrote inline, so the rest of its HTML is decided by the
 * plain text (see `arbitrate`) -- a block at a time, so one inline `pre` span
 * leaves the paragraph around it, and its stylesheet-preserved `<code>`, to
 * the plain text as before. Remembered per element, as {@link whiteSpaceOf}.
 */
function declaresWhiteSpace(element: Element | null): boolean {
  const chain: Element[] = [];
  let declares = false;

  for (let at = element; at; at = at.parentElement) {
    const known = DECLARES_WHITE_SPACE.get(at);

    if (known !== undefined) {
      declares = known;
      break;
    }

    chain.push(at);
  }

  for (const at of chain.reverse()) {
    declares ||= declaredWhiteSpace(at) !== null;
    DECLARES_WHITE_SPACE.set(at, declares);
  }

  return declares;
}

/**
 * Elements whose text is never collapsed unless they say so themselves: the
 * two whose browser default is `white-space: pre`. An inherited `normal` --
 * the computed style Chromium writes on the element around a copy -- does not
 * count; only a declaration on the element itself does.
 *
 * Not `<code>`, `<kbd>` or `<samp>`, whose default is `normal`: a page
 * paragraph's source-wrapped `<code>npm\n      install</code>` is drawn on
 * one line. GitHub's `code { white-space: break-spaces }` arrives from Firefox
 * as a bare `<code>` all the same -- it copies classes, not computed style --
 * and is told apart by the clipboard's plain text (see `arbitrate`), as any
 * other element a stylesheet preserves is.
 */
const PRESERVING_TAGS = new Set(['PRE', 'TEXTAREA']);

/**
 * How an element lays out its whitespace, from the nearest inline `style` that
 * says: Google Docs, VS Code and a browser's copy of a `pre-wrap` region mark
 * their text this way, and collapsing it lost tabs and runs of spaces.
 * `pre`, `pre-wrap` and `break-spaces` preserve it all; `pre-line` only its
 * line breaks. A {@link PRESERVING_TAGS} element with no declaration of its
 * own is `pre`. Remembered per element, so a deep chain is walked once.
 */
function whiteSpaceOf(element: Element | null): WhiteSpace {
  const chain: Element[] = [];
  let mode: WhiteSpace = 'normal';

  for (let at = element; at; at = at.parentElement) {
    const known = WHITE_SPACE.get(at);

    if (known) {
      mode = known;
      break;
    }

    chain.push(at);
  }

  for (const at of chain.reverse()) {
    mode = declaredWhiteSpace(at) ?? (PRESERVING_TAGS.has(tagNameOf(at)) ? 'pre' : mode);
    WHITE_SPACE.set(at, mode);
  }

  return mode;
}

/**
 * The value CSS applies for `property` among an element's own inline `style`
 * declarations, lower-cased: the last valid one, an `!important` one over any
 * that is not, and an invalid one ignored, as CSS ignores it. Null if none.
 */
function declaredValue(
  element: Element,
  property: 'white-space' | 'display',
  valid: (value: string) => boolean,
): string | null {
  const style = element.getAttribute('style') ?? '';

  if (!style.toLowerCase().includes(property)) {
    return null;
  }

  let declared: string | null = null;
  let important: string | null = null;
  const pattern = property === 'display' ? DISPLAY_DECLARATION : WHITE_SPACE_DECLARATION;

  for (const match of style.matchAll(pattern)) {
    let value = (match[1] ?? '').trim().toLowerCase();
    const isImportant = /!\s*important$/.test(value);

    if (isImportant) {
      value = value.slice(0, value.lastIndexOf('!')).trim();
    }

    if (!valid(value)) {
      continue;
    }

    if (isImportant) {
      important = value;
    } else {
      declared = value;
    }
  }

  return important ?? declared;
}

const WHITE_SPACE_DECLARATION = /(?:^|;)\s*white-space\s*:([^;]*)/gi;
const DISPLAY_DECLARATION = /(?:^|;)\s*display\s*:([^;]*)/gi;

/**
 * The `white-space` an element's own `style` declares, if any; `inherit`,
 * `unset` and `revert` inherit (null).
 */
function declaredWhiteSpace(element: Element): WhiteSpace | null {
  const value = declaredValue(
    element,
    'white-space',
    (candidate) => WHITE_SPACE_VALUES.has(candidate) || INHERITING.has(candidate),
  );

  return value === null ? null : (WHITE_SPACE_VALUES.get(value) ?? null);
}

/** Every keyword a `display` value is made of; one with another is invalid. */
const DISPLAY_KEYWORDS = new Set([
  'none',
  'contents',
  'block',
  'inline',
  'run-in',
  'flow',
  'flow-root',
  'table',
  'flex',
  'grid',
  'ruby',
  'list-item',
  'inline-block',
  'inline-table',
  'inline-flex',
  'inline-grid',
  'inline-list-item',
  'table-row-group',
  'table-header-group',
  'table-footer-group',
  'table-row',
  'table-cell',
  'table-column-group',
  'table-column',
  'table-caption',
  'ruby-base',
  'ruby-text',
  'ruby-base-container',
  'ruby-text-container',
  'initial',
  ...INHERITING_KEYWORDS,
]);

interface Display {
  /** Whether the element is a block in its parent's line, or sits in it. */
  outer: 'block' | 'inline' | null;
  /**
   * Whether it sits in its line as one box, whatever is inside it. Not an
   * inline flex or grid container: what is inside one is an item, and items
   * start lines (`isItem`) before any box is asked about.
   */
  box: boolean;
  /** Whether it lays its children out as flex or grid items. */
  items: boolean;
  /** Whether it is a table cell, drawn beside its neighbours. */
  cell: boolean;
}

const DISPLAYS = new WeakMap<Node, Display>();
const NO_DISPLAY: Display = { outer: null, box: false, items: false, cell: false };
const BLOCK_DISPLAYS = new Set(['block', 'list-item', 'flow-root', 'table', 'flex', 'grid']);
const INLINE_DISPLAYS = new Set([
  'inline',
  'inline-block',
  'inline-table',
  'inline-flex',
  'inline-grid',
  'inline-list-item',
]);

/**
 * What an element's own inline `style` says of its `display`. Chromium writes
 * it inline when it copies, and with it drops whitespace it does not draw --
 * between flex or grid items, and around blocks -- so read by tag alone a
 * Shiki code block (a grid of line spans) came out as one line, a flex row's
 * links ran together, and Mintlify's paragraphs (`display: block` spans)
 * joined. Remembered per element: a container with many items is asked once
 * per item.
 */
function displayOf(node: Node | null): Display {
  if (node === null || node.nodeType !== ELEMENT_NODE) {
    return NO_DISPLAY;
  }

  let known = DISPLAYS.get(node);

  if (known === undefined) {
    const value = declaredValue(node as Element, 'display', (candidate) =>
      candidate.split(/[ \t\n\r\f]+/).every((keyword) => DISPLAY_KEYWORDS.has(keyword)),
    );
    const keywords = value?.split(/[ \t\n\r\f]+/) ?? [];
    const inline = keywords.some((keyword) => INLINE_DISPLAYS.has(keyword));

    known = {
      outer: inline
        ? 'inline'
        : keywords.some((keyword) => BLOCK_DISPLAYS.has(keyword))
          ? 'block'
          : null,
      box:
        inline &&
        keywords.some((keyword) => /^(?:inline-)?(?:block|table|flow-root)$/.test(keyword)),
      items: keywords.some((keyword) => /^(?:inline-)?(?:flex|grid)$/.test(keyword)),
      cell: keywords.includes('table-cell'),
    };
    DISPLAYS.set(node, known);
  }

  return known;
}

function laysOutItems(node: Node | null): boolean {
  return displayOf(node).items;
}

/** An element its container lays out as a flex or grid item: a block. */
function isItem(element: Element): boolean {
  return tagNameOf(element) !== 'BR' && laysOutItems(element.parentNode);
}

/**
 * Whether an element starts and ends a line: a block by its tag
 * (`breaksLine`) or by its declared `display`, or an item of a flex or grid
 * container -- each element item is a block, as `innerText` reads it in both
 * browsers. Loose text in a container is not: it stays on the line beside it.
 * A declared inline display does not take a block tag back into its line
 * here: copied pages write it on blocks whose separators were generated
 * content (Wikipedia's `v t e`), and honouring it joined their words.
 */
function startsLine(element: Element, code = false): boolean {
  const tag = tagNameOf(element);

  return (
    breaksLine(tag) ||
    isItem(element) ||
    (tag !== 'BR' && displayOf(element).outer === 'block' && !inInlineBox(element, code))
  );
}

/** A block by its declared display that `inInlineBox` keeps in its line. */
function isStackedInBox(element: Element): boolean {
  return (
    tagNameOf(element) !== 'BR' &&
    displayOf(element).outer === 'block' &&
    inInlineBox(element, false)
  );
}

const IN_INLINE_BOX = new WeakMap<Node, boolean>();
const IN_INLINE_BOX_IN_CODE = new WeakMap<Node, boolean>();

/**
 * Whether an element is inside an inline-block, inline-table or inline
 * flow-root box, with no line-starting element between: a block in there
 * stacks inside the box, and the box sits in the line. KaTeX sets every
 * superscript, subscript and fraction part as a `display: block` span inside
 * an inline-table inside an inline-block, and MathJax 2 every glyph as one
 * inside an inline-block; reading those as lines broke every sentence
 * holding a formula. Each ancestor's answer for its children is remembered,
 * so a deep tree is climbed once -- separately for code, where a block tag
 * declared inline is drawn in its line (`codeText`), so can be the box.
 */
function inInlineBox(element: Element, code: boolean): boolean {
  const memo = code ? IN_INLINE_BOX_IN_CODE : IN_INLINE_BOX;
  const chain: Node[] = [];
  let found: boolean | undefined;
  let at: Node | null = element.parentNode;

  while (found === undefined) {
    if (at === null || at.nodeType !== ELEMENT_NODE) {
      found = false;
    } else if (memo.has(at)) {
      found = memo.get(at);
    } else if (
      // The code block's own <pre> is a stop whatever it declares: it is
      // the root the lines are read from, not a box inside them.
      (breaksLine(tagNameOf(at)) &&
        !(code && tagNameOf(at) !== 'PRE' && displayOf(at).outer === 'inline')) ||
      isItem(at as Element)
    ) {
      // Outside code a block tag is a block here whatever it declares: what
      // it holds is read by lines.
      found = false;
    } else if (displayOf(at).box) {
      found = true;
    } else {
      chain.push(at);
      at = at.parentNode;
    }
  }

  for (const node of chain) {
    memo.set(node, found === true);
  }

  return found === true;
}

const WHITE_SPACE_VALUES = new Map<string, WhiteSpace>([
  ['normal', 'normal'],
  ['nowrap', 'normal'],
  ['initial', 'normal'],
  ['pre', 'pre'],
  ['pre-wrap', 'pre'],
  ['break-spaces', 'pre'],
  ['pre-line', 'pre-line'],
]);

const INHERITING = new Set(INHERITING_KEYWORDS);

/**
 * Reads inline content outside any paragraph as a browser lays it out: under
 * `white-space: normal` each run of spaces, tabs and line breaks in the source
 * is one space, and none stands at the start or end of a line -- a line a
 * `<br>` ends, or the text's own, except where `edges` says the text is the
 * edge of a paste, which lands mid-line. What an inline `white-space` style
 * preserves is kept (see {@link whiteSpaceOf}), and a no-break space is not
 * whitespace here at all.
 *
 * Only foreign HTML reaches this -- this editor writes every block's text
 * inside a block element, where `parseRichText` reads whitespace as it stands,
 * because that is how it writes a line break between two runs. Collapsing
 * the text as a whole, rather than node by node, is what keeps a space that
 * ends one element from doubling one that starts the next.
 */
function collapseWhitespace(
  root: Element,
  edges: { start: boolean; end: boolean },
): { runs: RichText; endsLine: boolean } {
  const walker = root.ownerDocument.createTreeWalker(root, SHOW_TEXT);

  for (let found = walker.nextNode(); found !== null; found = walker.nextNode()) {
    const value = (found.nodeValue ?? '').replace(/[\uFDD0-\uFDD5]/g, (char) => LITERAL + char);
    const mode = whiteSpaceOf(found.parentElement);

    // What a style preserves is marked, so the pass below keeps it.
    found.nodeValue =
      mode === 'pre'
        ? value.replace(/[ \t\n]/g, (char) => PRESERVED[char]!)
        : mode === 'pre-line'
          ? value
              .split('\n')
              .map((line) => line.replace(/[ \t\r\f]+/g, ' '))
              .join(LINE_BREAK)
          : value.replace(/[ \t\n\r\f]+/g, ' ');
  }

  // Every unmarked space left is collapsible; every newline is a break the
  // walk wrote. The edges of a paste are the middle of a line, not its ends.
  collapsing = true;
  let runs: RichText;

  try {
    runs = parseRichText(root);
  } finally {
    collapsing = false;
  }

  const chars = runs.map((): string[] => []);
  let suppress = !edges.start;
  let lastSpace = -1;
  let lastPreservedBreak = -1;
  let literal = false;
  // Whether the last content ended its line -- a `<br>`, a preserved break --
  // so that nothing after the run continues it.
  let endsLine = false;

  for (const [index, run] of runs.entries()) {
    for (const char of run.text) {
      if (literal || char === LITERAL) {
        if (literal) {
          chars[index]!.push(char);
          suppress = false;
          lastSpace = -1;
          lastPreservedBreak = -1;
          endsLine = false;
        }

        literal = !literal;
      } else if (char === STANDS) {
        lastPreservedBreak = -1;
        endsLine = true;
      } else if (char === ' ') {
        if (!suppress) {
          chars[index]!.push(' ');
          suppress = true;
          lastSpace = index;
        }
      } else if (char === '\n' || char === PRESERVED['\n'] || char === LINE_BREAK) {
        // A `<br>` or a pre-line break takes the collapsible space before it;
        // a pre or pre-wrap one leaves it, as Chromium lays it out.
        if (lastSpace !== -1 && char !== PRESERVED['\n']) {
          chars[lastSpace]!.pop();
        }

        chars[index]!.push('\n');
        suppress = true;
        lastSpace = -1;
        lastPreservedBreak = char === '\n' ? -1 : index;
        endsLine = true;
      } else {
        chars[index]!.push(RESTORED[char] ?? char);
        suppress = false;
        lastSpace = -1;
        lastPreservedBreak = -1;
        endsLine = false;
      }
    }
  }

  if (lastSpace !== -1 && !edges.end) {
    chars[lastSpace]!.pop();
  }

  // A preserved line break that ends the text ends its line, as a trailing
  // `<br>` does: a block it ends draws no line after it.
  if (lastPreservedBreak !== -1 && !edges.end) {
    chars[lastPreservedBreak]!.pop();
  }

  return {
    runs: normalizeRuns(
      runs
        .map((run, index) => ({ ...run, text: chars[index]!.join('') }))
        .filter((run) => run.text.length > 0),
    ),
    endsLine,
  };
}

/**
 * Walks a subtree, emitting one block per block-level element.
 *
 * Inline nodes between block elements are buffered and flushed as a paragraph,
 * so stray text at the top level is not silently dropped.
 *
 * @param include Which children to visit, where only some are blocks: a list
 * item's, whose text the item has already read in place.
 */
function visitBlocks(
  doc: Document,
  node: Node,
  depth: number,
  out: Block[],
  exclude?: Node,
  include?: (child: Node) => boolean,
): void {
  if (blockNesting >= MAX_BLOCK_NESTING) {
    for (const rest of include ? [...node.childNodes].filter(include) : [node]) {
      pushRemainder(out, rest, depth);
    }

    return;
  }

  blockNesting += 1;

  try {
    visitBlocksInner(doc, node, depth, out, exclude, include);
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
  include?: (child: Node) => boolean,
): void {
  let buffer: Node[] = [];

  // A block ends the line it is on; it is applied once the block has been
  // visited, since what the block holds may have opened one of its own.
  let closeAfter = false;

  /**
   * Walks an inline wrapper's subtree in document order, without recursion:
   * each image is flushed past as a block of its own, and everything else is
   * buffered inside one shell carrying the formatting and link of the wrappers
   * above it -- worked out a level at a time, so a deep chain costs its depth
   * once rather than once per piece of text, and with the nearest wrapper
   * winning, as it does for text read where it stands.
   */
  const splitAroundImages = (wrapper: Element): void => {
    const empty: InlineFormatting = { link: null, marks: new Map(), soft: new Set() };
    const stack: Array<{ node: Node; format: InlineFormatting }> = [
      { node: wrapper, format: empty },
    ];

    while (stack.length > 0) {
      const { node, format } = stack.pop()!;
      const tag = tagNameOf(node);

      if (node !== wrapper && SKIP_TAGS.has(tag)) {
        continue;
      }

      // An image the reader cannot use is no block, so it splits nothing.
      if (tag === 'IMG') {
        if (hasUsableImage(node as Element)) {
          flushInline(true);
          pushImage(out, node as Element, depth);
          lineOpen = true;
        }

        continue;
      }

      if (node === wrapper || (node.nodeType === ELEMENT_NODE && containsImage(node as Element))) {
        const inner = nearestFormatting(format, node as Element);
        const children = node.childNodes;

        for (let index = children.length - 1; index >= 0; index -= 1) {
          stack.push({ node: children[index]!, format: inner });
        }

        continue;
      }

      // The piece is read detached, so what it inherited where it stood goes
      // with it: its `white-space`, and whether it is the paste's edge.
      let piece = cloneDeep(node);
      const mode = whiteSpaceOf(node.parentElement);

      if (mode !== 'normal') {
        const holder = doc.createElement('span');

        holder.setAttribute('style', `white-space: ${mode === 'pre' ? 'pre-wrap' : 'pre-line'}`);
        holder.appendChild(piece);
        piece = holder;
      }

      const shell = formattingShell(doc, format);

      if (shell) {
        shell.inner.appendChild(piece);
        piece = shell.outer;
      }

      if (pasteFirst.has(node)) {
        pasteFirst.add(piece);
      }

      if (pasteLast.has(node)) {
        pasteLast.add(piece);
      }

      buffer.push(piece);
    }
  };

  /**
   * @param continues Whether what comes next goes on with the line -- an inline
   * wrapper holding blocks or images, or an inline image -- rather than a
   * block that starts a new one.
   */
  const flushInline = (continues = false): void => {
    if (!continues) {
      closeAfter = true;
    }

    if (buffer.length === 0) {
      if (!continues) {
        lineOpen = false;
      }

      return;
    }

    // A space at a paste's edges stays: the paste lands mid-line.
    const edges = {
      start: buffer.some((inline) => pasteFirst.has(inline)),
      end: buffer.some((inline) => pasteLast.has(inline)),
    };

    // Layout text around the fragment itself (Firefox wraps it in newlines)
    // is no space someone typed -- but a space with no line break is: Firefox
    // copies a selected trailing space as `<b>Hello</b> `. A no-break space is
    // never layout.
    // An element with no text at all -- an icon's empty `<i>` -- is no edge
    // either: the layout beside it is still layout.
    while (edges.start && buffer.length > 0 && isEdgeLayout(buffer[0]!)) {
      buffer.shift();
    }

    while (edges.end && buffer.length > 0 && isEdgeLayout(buffer[buffer.length - 1]!)) {
      buffer.pop();
    }

    if (buffer.length === 0) {
      if (!continues) {
        lineOpen = false;
      }

      return;
    }

    const wrapper = doc.createElement('div');

    for (const inline of buffer) {
      // An element that is a flex or grid item is a block of its own, which
      // the copy, taken out of its container, would no longer know; the
      // whitespace between items is not drawn at all.
      const item = laysOutItems(inline.parentNode);

      if (item && inline.nodeType === TEXT_NODE && !/[^ \t\n\r\f]/.test(inline.nodeValue ?? '')) {
        continue;
      }

      let copy: Node = cloneDeep(inline);
      // A style on an ancestor outside the run still governs it.
      const mode = whiteSpaceOf(inline.parentElement);

      if (mode !== 'normal') {
        const holder = doc.createElement('span');

        holder.setAttribute('style', `white-space: ${mode === 'pre' ? 'pre-wrap' : 'pre-line'}`);
        holder.append(copy);
        copy = holder;
      }

      if (inline.nodeType === ELEMENT_NODE && isItem(inline as Element)) {
        const block = doc.createElement('div');

        block.append(copy);
        copy = block;
      }

      wrapper.append(copy);
    }

    // A lone `<br>` between two blocks is a blank line of its own, as two of
    // them already read as one block holding a line break. At either end of
    // the paste there is nothing for it to stand between, and
    // `blocksFromHtml` trims it.
    const blankLine = buffer.some(holdsBreak);
    // A run says how its whitespace is drawn when everything in it does: its
    // container declares it, or -- as Chromium and WebKit copy a phrase --
    // each element in it carries its own computed `white-space`. One inline
    // `pre` span among Firefox's bare text does not speak for the text.
    const declared = buffer.every(
      (inline) =>
        (inline.nodeType === TEXT_NODE && !/[^ \t\n\r\f]/.test(inline.nodeValue ?? '')) ||
        declaresWhiteSpace(
          inline.nodeType === ELEMENT_NODE ? (inline as Element) : inline.parentElement,
        ),
    );

    // Where it stands, for the indentation Firefox gives its lines.
    const runParent = buffer[0]!.parentElement;

    buffer = [];
    // Read as it stands before `collapseWhitespace` marks the copy's text, so
    // the plain text can decide a `<div class>` a stylesheet made pre-wrap as
    // it decides a paragraph (see `arbitrate`): a chat message or a comment is
    // the commonest of them. Asked, as a block is (`readBlockText`), about
    // whitespace a browser draws differently and about a space it starts
    // with, but not one it ends with (R6-FMT-2).
    // And about a space that starts a line after a `<br>`, which
    // `subtreeText` does not hold (R8-FMT-6).
    const asks = plainArbiter !== null && !declared;
    const source = asks ? subtreeText(wrapper) : '';
    const layout = COLLAPSIBLE.test(source);
    const lead = /^[ \t\n\r\f]+/.exec(source)?.[0];
    const raw =
      layout ||
      (lead !== undefined && !/[\n\r]/.test(lead)) ||
      (asks && blockWhitespace(wrapper).lineStart)
        ? parseRichText(wrapper)
        : null;
    const collapsed = collapseWhitespace(wrapper, edges);
    const opened = lineOpen;
    let runs = plainArbiter
      ? arbitrate(raw, collapsed.runs, layout, plainIndent(plainArbiter, runParent))
      : collapsed.runs;

    // A run that starts with a break on an open line -- after an inline
    // image, or a wrapper's own text -- ends that line rather than leaving a
    // blank one at its head.
    const stripped = opened && richToPlainText(runs).startsWith('\n');

    if (stripped) {
      runs = richDelete(runs, 0, 1);
    }

    if (!isRichEmpty(runs)) {
      out.push(createBlock('paragraph', runs, depth));
      lineOpen = !collapsed.endsLine;
    } else if (blankLine) {
      // A `<br>` that ends an open line is no blank line of its own -- but
      // when the line was ended by a break taken off the run's head, the
      // break that is left is one.
      if (!opened || stripped) {
        const block = createBlock('paragraph', [], depth);

        BLANK_LINES.add(block);
        out.push(block);
      }

      lineOpen = false;
    }

    if (!continues) {
      lineOpen = false;
    }
  };

  for (const child of [...node.childNodes]) {
    if (closeAfter) {
      lineOpen = false;
      closeAfter = false;
    }

    if (child === exclude || (include && !include(child))) {
      continue;
    }

    if (child.nodeType === TEXT_NODE) {
      // Whitespace too: between two inline elements it is content (`<b>bold</b>
      // <i>it</i>` read `boldit`), and `collapseWhitespace` reads it as a
      // browser does when the run is flushed -- on its own, nothing.
      buffer.push(child);

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
      pushBlock(out, heading, element, depth, depthOf(element, depth));
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

      if (HEADLESS_DETAILS.has(element)) {
        visitBlocks(doc, element, depth, out);
      } else {
        visitDetails(doc, element, depth, out);
      }

      continue;
    }

    if (tag === 'PRE') {
      flushInline();
      // `subtreeText`, not `textContent`: the latter includes the source of a
      // <script> or <style> that happens to sit inside the <pre>, so pasted
      // markup the sanitizer is supposed to drop arrived as document content
      // instead. It is inert -- parsing happens in a detached template and this
      // is text either way -- but it is still somebody else's code appearing in
      // the user's document.
      const code = normalizeControlCharacters(codeText(element));

      passPlain(code);
      out.push(createBlock('code', code, depthOf(element, depth)));
      continue;
    }

    if (tag === 'TABLE') {
      flushInline();
      pushTable(out, element, depth);
      continue;
    }

    // An inline `<img>` sits on a line, which a `<br>` after it ends; a
    // `<figure>` is a block.
    if (tag === 'IMG') {
      // One the reader cannot use (Outlook's `cid:`, Word's `file:`) is no
      // block, so it splits no sentence.
      if (hasUsableImage(element)) {
        flushInline(true);
        pushImage(out, element, depth);
        lineOpen = true;
      }

      continue;
    }

    if (tag === 'FIGURE') {
      flushInline();

      // A figure that is not one image -- a table with its caption, a
      // gallery of figures, a bookmark card -- is read block by block. Read
      // as its first image, everything else in it was lost.
      // Our own empty image block carries a marker and no picture yet.
      const image = isImageFigure(element) || element.hasAttribute('data-neditor-image');

      if (!image || !pushImage(out, element, depth)) {
        visitBlocks(doc, element, depth, out, exclude);
      }

      continue;
    }

    // <a href><img> and <p><img> are the commonest image markup on the web.
    // Without this the image is buffered as inline content and emits nothing.
    // An inline wrapper holding images and no block -- a link or bold around
    // an icon -- stays on its line: its images become image blocks, and its
    // text keeps the wrapper's link and marks, which visiting its children
    // bare lost.
    // Not one holding a display block either: that block's line breaks are
    // read from it where it stands, and copying its text out lost them.
    //
    // Nor a Word list item. A picture bullet sits in the marker span, which
    // the item's text skips, so it is the item's marker and no image; taken
    // for content, it kept the paragraph from being an item, left the
    // marker's spacer in the text and made a web picture an image block of
    // its own. Any other picture in the item is its child, as a list item's
    // is -- split around instead, the bullet beside it became an image too.
    const pictured = containsImage(element) && tag === 'P' ? wordListItem(element) : null;

    if (pictured) {
      flushInline();
      pushWordListItem(out, element, depth, pictured);
      continue;
    }

    if (
      containsImage(element) &&
      !DISPLAY_BLOCK_TAGS.has(tag) &&
      !containsBlockLevel(element) &&
      !holdsDisplayBlock(element)
    ) {
      splitAroundImages(element);
      continue;
    }

    if (containsImage(element)) {
      flushInline(!DISPLAY_BLOCK_TAGS.has(tag));
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

      const word = wordListItem(element);

      if (word) {
        pushWordListItem(out, element, depth, word);
      } else {
        pushBlock(out, 'paragraph', element, depth);
      }

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
      flushInline(!DISPLAY_BLOCK_TAGS.has(tag));
      visitBlocks(doc, contentsOf(doc, element), depth, out);
      continue;
    }

    // Anything else is inline: <strong>, <a>, <span>, unknown elements.
    buffer.push(element);
  }

  if (closeAfter) {
    lineOpen = false;
  }

  // Whether the line goes on past this is the caller's to say.
  flushInline(true);
}

/**
 * A document with no browsing context, to parse foreign markup into.
 *
 * Everything a parse builds -- the template, the fragment formatting is pushed
 * inward through, the scratch `<div>` an inline run is read from -- is created
 * here and never by the caller's document. A template's own content is inert,
 * but a node cloned out of it and appended to something the live document
 * made is adopted into the live document, and in a document that can load
 * things an `<img>`, `<video>` or `<audio>` starts loading the moment it
 * arrives: a pasted `<b><p>x</p><img src=/nope.png onerror=…></b>` ran its
 * handler in the page, in Chromium and WebKit both. A document created by
 * `createHTMLDocument` has no browsing context, so nothing adopted into it
 * fetches anything or runs anything, whatever attributes it carries.
 *
 * Derived from `doc` rather than the global `document`, so a parse mounted in
 * another realm stays in that realm.
 */
function inertDocument(doc: Document): Document {
  return doc.implementation.createHTMLDocument('');
}

/** How {@link blocksFromHtml} reads what the HTML does not say for itself. */
export interface HtmlReadOptions {
  /**
   * `'auto'` (the default) reads whitespace as a browser draws it: kept where
   * a style or a `<pre>` preserves it, collapsed everywhere else. `'preserve'`
   * reads every block's text as it stands, which is how HTML stored from
   * `blocksToHtml` up to 0.1.3 has to be read: that writer put a soft line
   * break in a block as a raw newline and a run of spaces as it stood, and
   * marked only nested and checked blocks, so HTML with no such block cannot
   * be told apart from a page's line-wrapped source.
   */
  readonly whitespace?: 'auto' | 'preserve';
  /**
   * The `text/plain` that came with the HTML, if any. Where the HTML declares
   * no `white-space` at all -- Firefox copies a page's classes, not their
   * computed style -- each block is matched where it stands in the plain
   * text, and each run of whitespace in it that the plain text holds exactly
   * as written is kept, because that text is what was drawn.
   */
  readonly plain?: string;
}

/**
 * Takes out what a browser writes for the line break a selection crossed to
 * start or end at a block's edge -- a drag begun just past the end of the line
 * above, or ended at the start of the line below. That break is outside the
 * text the reader selected, and read as content it opened (or closed) the
 * paste with an empty line, or split the paragraph it was pasted into.
 *
 * Chromium and WebKit write it as a `<br class="Apple-interchange-newline">`
 * that is the fragment's first or last leaf -- at its top level, or inside
 * the first block when the drag reaches a second one, the block is a list
 * item or it starts with a link (`<p><br class=...>beta two</p>`) -- so the
 * walk goes down through the first (or last) child at each level. A break of
 * that class anywhere else is a break like any other. The elements that held
 * nothing but that break go with it, whatever `white-space` the engine wrote
 * on them, up to the first that holds something else and never into a
 * table's parts: WebKit writes the break a drag begun in a closed
 * `<details>` crossed inside the `<details>` and its content slot.
 *
 * Firefox writes it as the block the selection left, emptied -- with the
 * inline elements it held still in it (`<p id="s1"><a href="…"></a></p>`,
 * `<h2><span></span></h2>`), or the source's indentation on a pretty-printed
 * page -- and its plain text cannot be asked: on a pretty-printed page it
 * starts with the source's own newlines. A block whose subtree draws nothing
 * ({@link drawsNothing}: no text but layout whitespace, no `<br>`, no picture
 * or control) draws no line in the page it was copied from, so at either
 * edge of a fragment that holds anything else it goes, unless it declares its
 * own `white-space`: this editor's writer marks every block that way, and an
 * empty paragraph it wrote is a line the reader copied. It is looked for down
 * the same edge as the break, since Chromium writes the list item a drag ended
 * at inside its list. Anything else at an edge is kept, and so is a fragment
 * of nothing but empty blocks.
 *
 * ProseMirror (and so Tiptap) says itself where its copy's edges are: its
 * first element carries `data-pm-slice="<openStart> <openEnd> …"`, and an end
 * whose open depth is 0 is closed -- a select-all copy -- so the empty blocks
 * there are whole blocks the reader selected, and are kept. An open end is a
 * drag's, and goes as any other.
 */
function dropSelectionEdges(fragment: DocumentFragment): void {
  const isLayout = (node: Node): boolean =>
    node.nodeType === COMMENT_NODE ||
    (node.nodeType === TEXT_NODE && (node.nodeValue ?? '').trim() === '') ||
    (node.nodeType === ELEMENT_NODE && NON_CONTENT_EDGE_TAGS.has((node as Element).localName));
  const isInterchange = (node: Node): boolean =>
    node.nodeType === ELEMENT_NODE &&
    (node as Element).localName === 'br' &&
    (node as Element).classList.contains('Apple-interchange-newline');
  // Remembered, since the walk down an edge asks it again at every level.
  const empty = new Map<Node, boolean>();
  const isEmptyBlock = (node: Node): boolean =>
    node.nodeType === ELEMENT_NODE &&
    EDGE_BLOCK_TAGS.has((node as Element).localName) &&
    declaredWhiteSpace(node as Element) === null &&
    drawsNothing(node, empty);
  const edgeChild = (parent: Node, from: 'start' | 'end'): Node | null => {
    let node = from === 'start' ? parent.firstChild : parent.lastChild;

    while (node && isLayout(node)) {
      node = from === 'start' ? node.nextSibling : node.previousSibling;
    }

    return node;
  };
  const edgeLeaf = (from: 'start' | 'end'): Node | null => {
    let node = edgeChild(fragment, from);

    for (let depth = 0; node && depth < MAX_BLOCK_NESTING; depth += 1) {
      const child = edgeChild(node, from);

      if (!child) {
        break;
      }

      node = child;
    }

    return node;
  };

  const crossed: Node[] = [];

  for (const from of ['start', 'end'] as const) {
    const leaf = edgeLeaf(from);

    if (leaf && isInterchange(leaf) && leaf.parentNode) {
      crossed.push(leaf.parentNode);
      leaf.parentNode.removeChild(leaf);
    }
  }

  // A fragment of nothing but empty blocks has no edge to tell them from: the
  // empty blocks are all there is, and are kept.
  if (!holdsContent(fragment)) {
    return;
  }

  // What held nothing but the break goes with it, up to the first element
  // that holds something else -- whatever `white-space` it declares, since
  // Chromium and WebKit write their computed style on every element they
  // copy. WebKit writes the break a drag begun in a closed `<details>`
  // crossed inside the `<details>` and its content slot (R7-FMT-1). Never a
  // table's part: a cell is the table's, however empty.
  for (let node of crossed) {
    for (let depth = 0; depth < MAX_BLOCK_NESTING; depth += 1) {
      const parent = node.parentNode;

      if (
        !parent ||
        node.nodeType !== ELEMENT_NODE ||
        TABLE_PART_TAGS.has((node as Element).localName) ||
        !drawsNothing(node, empty)
      ) {
        break;
      }

      parent.removeChild(node);
      node = parent;
    }
  }

  const closed = closedSliceEnds(edgeChild(fragment, 'start'));

  // A `<details>` on the copy's start edge with no summary of its own is a
  // drag begun in its body -- or one of the start tags WebKit writes first
  // for every closed `<details>` a drag crosses, around everything after
  // them. Read as a toggle it had an empty title and took the copy in under
  // it, splitting and indenting the reader's paragraph (R8-FMT-1, R8-FMT-2),
  // so its body is read in its place, at its depth. The whole start edge is
  // walked, through any element: the page's own wrapper (`<div class="faq">`,
  // `<section>`), Chromium's `<slot>` and WebKit's `<span>` holding a nested
  // `<details>`, an editor's content `<div>` (R9-FMT-1) -- asking only the
  // first element was not enough. Only on that edge, where the summary is what
  // the drag left behind: one with its summary -- a direct child, or in
  // WebKit's content slot, which `firstSummary` finds; the edge then runs
  // into that summary -- is a toggle as before, and so is a whole one a
  // closed ProseMirror slice starts with, one pasted after other content, and
  // one that draws nothing, which the edge rule below decides.
  //
  // Marked, not unwrapped: each stays in the tree as the container it is
  // read as ({@link HEADLESS_DETAILS}), so what it holds keeps the
  // `white-space` the engine wrote on it, and nothing is moved -- moving
  // one level at a time moved the rest of the chain with it at every level.
  for (
    let node = closed.start ? null : edgeChild(fragment, 'start'), depth = 0;
    depth < MAX_BLOCK_NESTING && node?.nodeType === ELEMENT_NODE;
    node = edgeChild(node, 'start'), depth += 1
  ) {
    if (
      (node as Element).localName === 'details' &&
      firstSummary(node as Element) === null &&
      !drawsNothing(node, empty)
    ) {
      HEADLESS_DETAILS.add(node as Element);
    }
  }

  // Down the same edge as the break: Chromium writes the list item a drag
  // ended at the start of inside its list (`<ul><li><p>two</p></li><li></li>`).
  for (const from of ['start', 'end'] as const) {
    if (closed[from]) {
      continue;
    }

    let node = edgeChild(fragment, from);

    for (let depth = 0; node && depth < MAX_BLOCK_NESTING; depth += 1) {
      if (isEmptyBlock(node)) {
        node.parentNode?.removeChild(node);
        break;
      }

      // Not into a table: a selection that crosses cells takes whole cells,
      // so a block in an edge cell that draws nothing is the cell's own, and
      // without it the cell's last text read as the paste's edge, keeping
      // the space a line end drops (`<td>t <div><span></span></div></td>`).
      if (node.nodeType === ELEMENT_NODE && (node as Element).localName === 'table') {
        break;
      }

      node = edgeChild(node, from);
    }
  }
}

/**
 * Which ends of a ProseMirror copy are closed, from the `data-pm-slice` its
 * first element carries (`"0 0 []"` for a select-all, `"1 1 []"` for a drag
 * inside one paragraph): an open depth of 0 is a closed end. Neither, for
 * anything else.
 */
function closedSliceEnds(first: Node | null): { start: boolean; end: boolean } {
  const slice =
    first?.nodeType === ELEMENT_NODE ? (first as Element).getAttribute('data-pm-slice') : null;
  const open = /^\s*(\d+)\s+(\d+)/.exec(slice ?? '');

  return { start: open?.[1] === '0', end: open?.[2] === '0' };
}

/**
 * Whether a node draws nothing in the page it was copied from: a comment,
 * whitespace that collapses (none at all where a style or a `<pre>` keeps
 * it), or an element holding only those -- through any inline or block
 * element, and past what is never read ({@link SKIP_TAGS}), but never a
 * `<br>` or anything {@link DRAWN_WITHOUT_TEXT}. A no-break space draws.
 *
 * Bounded as the readers are, since a hostile paste nests as deep as it likes:
 * past {@link MAX_BLOCK_NESTING} levels a node is taken to draw something, and
 * so is kept. Remembered in `known`, so asking again down an edge costs
 * nothing.
 */
function drawsNothing(node: Node, known: Map<Node, boolean>, depth = 0): boolean {
  if (node.nodeType === COMMENT_NODE) {
    return true;
  }

  if (node.nodeType === TEXT_NODE) {
    return !textDraws(node);
  }

  if (node.nodeType !== ELEMENT_NODE || depth > MAX_BLOCK_NESTING) {
    return false;
  }

  const remembered = known.get(node);

  if (remembered !== undefined) {
    return remembered;
  }

  const element = node as Element;
  const name = element.localName;
  const answer =
    !DRAWN_WITHOUT_TEXT.has(name) &&
    (SKIP_TAGS.has(tagNameOf(element)) ||
      [...element.childNodes].every((child) => drawsNothing(child, known, depth + 1)));

  known.set(node, answer);

  return answer;
}

/** Whether a text node draws anything: a character, or whitespace a style keeps. */
function textDraws(node: Node): boolean {
  const value = node.nodeValue ?? '';

  return (
    !/^[ \t\n\f\r]*$/.test(value) || (value !== '' && whiteSpaceOf(node.parentElement) !== 'normal')
  );
}

/**
 * Whether a fragment holds anything but blocks that draw nothing ({@link
 * dropSelectionEdges}) and what is around them: text that draws, a `<br>`, a
 * picture or a control, or a block that declares its own `white-space` --
 * which is never dropped, so it is something to tell the edges from.
 */
function holdsContent(fragment: DocumentFragment): boolean {
  const stack: Node[] = [];

  for (const child of fragment.childNodes) {
    stack.push(child);
  }

  while (stack.length > 0) {
    const node = stack.pop()!;

    if (node.nodeType === TEXT_NODE) {
      if (textDraws(node)) {
        return true;
      }

      continue;
    }

    if (node.nodeType !== ELEMENT_NODE) {
      continue;
    }

    const element = node as Element;
    const name = element.localName;

    if (
      DRAWN_WITHOUT_TEXT.has(name) ||
      (EDGE_BLOCK_TAGS.has(name) && declaredWhiteSpace(element) !== null)
    ) {
      return true;
    }

    if (NON_CONTENT_EDGE_TAGS.has(name) || SKIP_TAGS.has(tagNameOf(element))) {
      continue;
    }

    for (const child of element.childNodes) {
      stack.push(child);
    }
  }

  return false;
}

/**
 * The blocks a browser writes, emptied, for the one a selection left at its
 * edge. A `<details>` is one: the walk tests each block before it goes into
 * it, so an emptied `<p>` or `<summary>` inside one goes with its
 * `<details>`, which left behind read as a toggle -- it split the paragraph
 * a paste went into, or turned the reader's text into a collapsed toggle
 * (R7-FMT-1). An emptied `<summary>` needs no entry of its own: the toggle
 * an emptied one heads reads the same with it or without it.
 */
const EDGE_BLOCK_TAGS: ReadonlySet<string> = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'blockquote',
  'pre',
  'details',
]);

/** A table and the elements only a table holds. */
const TABLE_PART_TAGS: ReadonlySet<string> = new Set([
  'table',
  'caption',
  'colgroup',
  'col',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
]);

/**
 * What draws in a block that holds no text: a line break, a picture, a
 * player, a control, a rule, a formula, a table. A block holding one is never
 * an emptied one.
 */
const DRAWN_WITHOUT_TEXT: ReadonlySet<string> = new Set([
  'br',
  'img',
  'picture',
  'svg',
  'video',
  'audio',
  'canvas',
  'iframe',
  'object',
  'embed',
  'input',
  'select',
  'textarea',
  'button',
  'hr',
  'math',
  'table',
]);

/** What a browser writes around a copied fragment that holds no content. */
const NON_CONTENT_EDGE_TAGS: ReadonlySet<string> = new Set(['meta', 'style', 'link', 'title']);

/** Parses an HTML string into blocks, for a multi-block paste. */
export function blocksFromHtml(
  doc: Document,
  html: string,
  options: HtmlReadOptions = {},
): Block[] {
  // Never `doc`: every scratch node a reader makes is made by the document
  // threaded through it, and one the live document makes loads what it holds.
  const inert = inertDocument(doc);
  const template = inert.createElement('template');
  template.innerHTML = html;

  const out: Block[] = [];
  // Reset rather than trust the last run: an exception thrown out of a walk
  // unwinds the try/finally pairs, but a future caller that catches one would
  // otherwise inherit a counter that never came back to zero.
  blockNesting = 0;
  listNesting = 0;
  inlineNesting = 0;
  lineOpen = false;
  // Asked for, or ours from before the writer marked its blocks -- which can
  // only be recognised when a block of it carries a `data-neditor-*` mark:
  // see `legacyOwnHtml` and `HtmlReadOptions.whitespace`.
  legacyOwnHtml =
    options.whitespace === 'preserve' ||
    (/\sdata-neditor-/.test(html) && !/white-space:\s*pre-wrap/i.test(html));
  // Not in this editor's own HTML from before its writer marked every block:
  // an empty paragraph there is a line it wrote, and holds no `white-space`
  // to say so.
  if (!legacyOwnHtml) {
    dropSelectionEdges(template.content);
  }

  wordMarkup = /mso-/i.test(html);
  plainArbiter =
    options.plain !== undefined && !legacyOwnHtml ? plainArbiterFor(options.plain) : null;

  // The paste's first and last content -- text that is not layout, a line
  // break, an image. Only text is an edge: a paste that starts or ends with a
  // break or a picture does not start or end mid-line in its text. Nor does a
  // block before the first text that does not hold it -- a divider, an empty
  // paragraph -- or any block after the last: each starts a line there.
  //
  // One walk in document order, over each node's children by index: stepping
  // siblings costs the node's index in some DOMs, and a wide paste paid it
  // once per node.
  let first: Node | null = null;
  let last: Node | null = null;
  const blocksBeforeFirst: Node[] = [];
  let blockAfterLast = false;
  const stack: Node[] = [template.content];

  while (stack.length > 0) {
    const node = stack.pop()!;
    const tag = tagNameOf(node);

    if (node !== template.content) {
      if (SKIP_TAGS.has(tag)) {
        continue;
      }

      if ((node.nodeType === TEXT_NODE && !isLayoutText(node)) || tag === 'BR' || tag === 'IMG') {
        first ??= node;
        last = node;
        blockAfterLast = false;
      } else if (BLOCK_LEVEL_TAGS.has(tag)) {
        if (first === null) {
          blocksBeforeFirst.push(node);
        }

        blockAfterLast = true;
      }
    }

    const children = node.childNodes;

    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]!);
    }
  }

  const withAncestors = (node: Node | null): Set<Node> => {
    const nodes = new Set<Node>();

    for (let at = node?.nodeType === TEXT_NODE ? node : null; at; at = at.parentNode) {
      nodes.add(at);
    }

    return nodes;
  };

  pasteFirst = withAncestors(first);
  pasteLast = blockAfterLast ? new Set() : withAncestors(last);

  if (blocksBeforeFirst.some((block) => !pasteFirst.has(block))) {
    pasteFirst = new Set();
  }

  try {
    visitBlocks(inert, template.content, 0, out);
  } finally {
    pasteFirst = new Set();
    pasteLast = new Set();
    plainArbiter = null;
    wordMarkup = false;
  }

  // A blank line at either end stands between nothing.
  let from = 0;
  let to = out.length;

  while (from < to && BLANK_LINES.has(out[from]!)) {
    from += 1;
  }

  while (to > from && BLANK_LINES.has(out[to - 1]!)) {
    to -= 1;
  }

  return out.slice(from, to);
}

/** Parses an HTML string, for clipboard payloads. */
export function parseRichTextFromHtml(doc: Document, html: string): RichText {
  // An inert document's template, as in `blocksFromHtml`.
  const template = inertDocument(doc).createElement('template');
  template.innerHTML = html;

  return parseRichText(template.content);
}
