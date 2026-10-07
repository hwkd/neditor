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
    // no-break space is content, which `trim` would take for whitespace.
    if (current.nodeType === TEXT_NODE && /[^ \t\n\r\f]/.test(current.nodeValue ?? '')) {
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
  const previous = collapsing ? lastSolidRun(out) : out.at(-1);

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
    startsLine(element) && (isItem(element) || displayOf(element).outer !== 'inline');
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
  // last newline ends the last line and draws none of its own.
  if (breaks > 0) {
    return text + '\n'.repeat(breaks - 1);
  }

  return text.endsWith('\n') ? text.slice(0, -1) : text;
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
      // Without this, pretty-printed HTML pastes with blank leading lines. A
      // no-break space is content, though `trim` would take it for layout.
      if (!/[^ \t\n\r\f]/.test(text) && isBetweenBlocks(child)) {
        continue;
      }

      if (text.length > 0) {
        out.push({ text, marks: [...marks], link });
      }

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
        // Only between two words: it is dropped once the walk is done if
        // nothing follows it, or what follows starts with whitespace or a
        // line break of its own.
        const previous = out.at(-1)?.text ?? '';

        if (previous !== '' && !/[ \t\n\r\f]/.test(previous[previous.length - 1]!)) {
          const run = { text: ' ', marks: [...marks], link };

          SKIPPED_SPACES.add(run);
          out.push(run);
        }
      }

      continue;
    }

    // A block element breaks the line on both edges, where text stands on
    // that side: before it when something precedes it and text follows, and
    // after it when text follows. `breakLine` collapses the two where blocks
    // are adjacent, so they never double up; both wait for the text, so an
    // empty block after the last of it adds no line.
    const isBlock = startsLine(element);

    if (isBlock) {
      breakLine(out, marks, link, true);
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

    // Deferred rather than looked ahead for: looking from every block climbed
    // to the root each time, quadratic in the depth of a structure read as
    // text.
    if (isBlock) {
      breakLine(out, marks, link, true);
    }
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

  return normalizeRuns(
    out.filter((run, index) => {
      if (DEFERRED_BREAKS.has(run)) {
        return index <= lastText;
      }

      if (SKIPPED_SPACES.has(run)) {
        const next = out[index + 1]?.text ?? '';

        return !/[ \t\n\r\f]/.test(next[0] ?? ' ');
      }

      return true;
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

    const text = renderRichText(doc, block.content);

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
): void {
  let runs = parseRichText(element, isNestedList);
  // Given a depth, the block hands its images on after it, as a list item
  // does: read as text, a heading's logo or a quote's screenshot was dropped.
  const images =
    imagesAt !== undefined && containsImage(element)
      ? textImages(element, isNestedList).filter(hasUsableImage)
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
  //
  // Identity only reaches a direct child, though: `visitBlocksInner` tests it
  // against its own children, and the descents into lists, quotes and blocks
  // do not carry it. A `<summary>` wrapped in anything -- which is malformed,
  // since the element must be a details' first child, but is what a stray
  // `<span>` or `<li>` around it produces -- was therefore read as the title
  // *and* again as body content, in the list case concatenated into that
  // item's own text. Those shapes take the copy, where removing it works at
  // any depth; the cost is one clone for markup nobody generates, and the
  // common case never reaches it.
  if (summary && summary.parentElement !== element) {
    const body = element.cloneNode(true) as Element;
    body.querySelector('summary')?.remove();
    visitBlocks(doc, body, block.depth + 1, out);

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

    for (const cell of row.children) {
      const tag = tagNameOf(cell);

      if (tag === 'TH' || tag === 'TD') {
        cells.push(parseRichText(cell));
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
  block.alt = image?.getAttribute('alt') ?? element.getAttribute('data-neditor-alt') ?? '';
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
  let runs = parseRichText(item, skip);
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
        const text = parseRichText(block);

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

/**
 * How an element lays out its whitespace, from the nearest inline `style` that
 * says: Google Docs, VS Code and a browser's copy of a `pre-wrap` region mark
 * their text this way, and collapsing it lost tabs and runs of spaces.
 * `pre`, `pre-wrap` and `break-spaces` preserve it all; `pre-line` only its
 * line breaks. Remembered per element, so a deep chain is walked once.
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
    mode = declaredWhiteSpace(at) ?? mode;
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
  /** Whether it lays its children out as flex or grid items. */
  items: boolean;
}

const DISPLAYS = new WeakMap<Node, Display>();
const NO_DISPLAY: Display = { outer: null, items: false };
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
      items: keywords.some((keyword) => /^(?:inline-)?(?:flex|grid)$/.test(keyword)),
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
function startsLine(element: Element): boolean {
  return breaksLine(tagNameOf(element)) || isItem(element) || displayOf(element).outer === 'block';
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

    buffer = [];
    const collapsed = collapseWhitespace(wrapper, edges);
    const opened = lineOpen;
    let runs = collapsed.runs;

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
      visitDetails(doc, element, depth, out);
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
      out.push(createBlock('code', codeText(element), depthOf(element, depth)));
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
  lineOpen = false;

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
    visitBlocks(doc, template.content, 0, out);
  } finally {
    pasteFirst = new Set();
    pasteLast = new Set();
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
  // A detached template never runs scripts or loads subresources.
  const template = doc.createElement('template');
  template.innerHTML = html;

  return parseRichText(template.content);
}
