/**
 * Selection helpers.
 *
 * A contenteditable reports the selection as (node, offset) pairs inside
 * whatever text nodes the browser happens to have created. With rich text those
 * nodes are also nested inside `<strong>`, `<a>` and friends. Every caller here
 * wants plain character offsets into the block instead, so this module is the
 * only place that has to reason about the tree.
 */

import { codePointEnd, codePointStart, graphemeEnd, graphemeStart } from '../util/grapheme.ts';

export interface OffsetRange {
  start: number;
  end: number;
}

function selectionOf(element: HTMLElement): Selection | null {
  // A shadow root has its own getSelection; the document's would report the
  // host element rather than the caret inside it.
  const root = element.getRootNode() as ShadowRoot & { getSelection?: () => Selection | null };

  return root.getSelection?.() ?? element.ownerDocument.defaultView?.getSelection() ?? null;
}

/**
 * The part of `Selection` the editor writes through.
 *
 * Only writes: every read goes through {@link readSelection}, which is where a
 * shadow root's retargeting is seen through. A real `Selection` is one.
 */
export interface TreeSelection {
  removeAllRanges(): void;
  setBaseAndExtent(anchor: Node, anchorOffset: number, focus: Node, focusOffset: number): void;
}

/**
 * The selection to write to for the tree `node` lives in.
 *
 * A shadow root has its own `getSelection` in Chromium; elsewhere the
 * document's selection is the one there is. Writing to it reaches into a shadow
 * root in every engine as long as it is done with `setBaseAndExtent` -- WebKit
 * drops a range given to `addRange` there (see {@link setSelectionRange}).
 * Reading it is another matter, and is {@link readSelection}'s job: WebKit
 * reports the host's parent at offset 0, so there the caret is only visible
 * through `getComposedRanges`. (A view that also *read* through composed
 * ranges used to live here; nothing read through it, so it went.)
 */
export function selectionFor(node: Node): TreeSelection | null {
  const root = node.getRootNode() as ShadowRoot & { getSelection?: () => Selection | null };

  return root.getSelection?.() ?? node.ownerDocument?.defaultView?.getSelection() ?? null;
}

/** What a caller needs to read from the selection, wherever it had to come from. */
export interface SelectionReading {
  /** Start to end, in document order. */
  range: Range;
  /** Where the reader started, which for a backward selection is the end. */
  anchorNode: Node;
  anchorOffset: number;
  /** The end that moves -- the one Shift+Arrow extends. */
  focusNode: Node;
  focusOffset: number;
  isCollapsed: boolean;
  /**
   * True where nothing said which end is the anchor: the selection was read
   * through a composed range, which has no direction, and the selection
   * itself reported none -- WebKit in a shadow root, for a selection a mouse
   * made (a `direction` of "none"; its Shift+arrow says "backward"). The
   * anchor above is then the range's start whichever way it was made.
   */
  undirected?: true;
}

type ComposedRanges = (...args: unknown[]) => readonly StaticRange[];

/**
 * The selection as seen from inside `node`'s tree.
 *
 * In a shadow root that has no `getSelection` of its own -- WebKit and
 * Firefox -- WebKit retargets the document's selection: it reports the shadow
 * host, not the caret inside it, so every offset read from it was 0 and
 * a shadow-mounted editor could not tell where its caret was (the e2e finding
 * F10: Enter split at the start, marks never applied, the toolbar never
 * showed). Firefox has no `ShadowRoot.getSelection` either, but its document
 * selection is not retargeted: it already reports the nodes inside the shadow
 * root, which is why the composed read below runs only when the anchor is not
 * in this root. `getComposedRanges` is the standard way to see through the
 * boundary. It is tried in both of its shapes -- the dictionary form, and the
 * variadic one Safari first shipped -- and only trusted when it actually
 * reaches into this root.
 */
export function readSelection(node: Node): SelectionReading | null {
  const root = node.getRootNode() as ShadowRoot & { getSelection?: () => Selection | null };
  const doc = node.ownerDocument ?? (node as Document);
  const selection = root.getSelection?.() ?? doc.defaultView?.getSelection() ?? null;

  if (!selection || selection.rangeCount === 0 || !touchable(doc, selection)) {
    return null;
  }

  const isShadow = 'host' in root;

  if (isShadow && !root.getSelection && !root.contains(selection.anchorNode)) {
    const first = composedRange(
      selection,
      root,
      (range) => root.contains(range.startContainer) && root.contains(range.endContainer),
    );

    if (first) {
      // A static range is not kept up to date as the tree changes, and the
      // selection it was read from can be stale already (`clampOffset`).
      const startOffset = clampOffset(first.startContainer, first.startOffset);
      const endOffset = clampOffset(first.endContainer, first.endOffset);
      const range = doc.createRange();
      range.setStart(first.startContainer, startOffset);
      range.setEnd(first.endContainer, endOffset);
      // A composed range has no direction; the selection still knows it --
      // unless a mouse made it, which WebKit reports as "none"
      // (`undirected`).
      const direction = (selection as Selection & { direction?: string }).direction;
      const backward = direction === 'backward';

      return {
        range,
        anchorNode: backward ? first.endContainer : first.startContainer,
        anchorOffset: backward ? endOffset : startOffset,
        focusNode: backward ? first.startContainer : first.endContainer,
        focusOffset: backward ? startOffset : endOffset,
        isCollapsed: range.collapsed,
        ...(backward || direction === 'forward' ? {} : { undirected: true as const }),
      };
    }
  }

  if (!selection.anchorNode || !selection.focusNode) {
    return null;
  }

  const { anchorNode, focusNode } = selection;
  const anchorOffset = clampOffset(anchorNode, selection.anchorOffset);
  const focusOffset = clampOffset(focusNode, selection.focusOffset);

  if (anchorOffset === selection.anchorOffset && focusOffset === selection.focusOffset) {
    return {
      range: selection.getRangeAt(0),
      anchorNode,
      anchorOffset,
      focusNode,
      focusOffset,
      isCollapsed: selection.isCollapsed,
    };
  }

  // A stale WebKit selection (`clampOffset`): the ends name an offset the
  // node no longer has, and the live range disagrees with them -- measured,
  // `DIV:4` against a range at `DIV:0`. Read half from each, one reading held
  // two carets: typing went to the end, Backspace merged into the block above
  // and Enter opened a paragraph above. The range is built from the clamped
  // ends instead, and the position is written back, so the browser types
  // where the editor reads -- but only into a host that holds focus. Setting
  // the selection in a contenteditable focuses it in every engine, and WebKit
  // keeps a stale selection in the block the reader left for a page button or
  // the table toolbar: written back from a peer's `setDocument`, it pulled
  // focus into that block and their Space was typed there. A selection in a
  // host without focus is no caret anyone types at, so the clamped reading
  // stands on its own.
  const range = orderedRange(doc, anchorNode, anchorOffset, focusNode, focusOffset);

  if (hostHoldsFocus(anchorNode, focusNode)) {
    try {
      selectionFor(node)?.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
    } catch {
      // Nothing better to write: the reading stands on its own.
    }
  }

  return { range, anchorNode, anchorOffset, focusNode, focusOffset, isCollapsed: range.collapsed };
}

/**
 * Whether the editing host holding both ends of a selection is the element
 * that has focus in their tree.
 *
 * The focused element itself, never an ancestor: an editor root holding
 * block selection contains every block's host, and is not one.
 */
function hostHoldsFocus(anchorNode: Node, focusNode: Node): boolean {
  const root = anchorNode.getRootNode() as Document | ShadowRoot;
  const active = 'activeElement' in root ? root.activeElement : null;

  return (
    active !== null &&
    (active as HTMLElement).isContentEditable === true &&
    active.contains(anchorNode) &&
    active.contains(focusNode)
  );
}

/** The range between two boundary points, whichever of them comes first. */
function orderedRange(
  doc: Document,
  anchorNode: Node,
  anchorOffset: number,
  focusNode: Node,
  focusOffset: number,
): Range {
  const range = doc.createRange();
  range.setStart(anchorNode, anchorOffset);
  range.collapse(true);

  if (range.comparePoint(focusNode, focusOffset) < 0) {
    range.setStart(focusNode, focusOffset);
    range.setEnd(anchorNode, anchorOffset);
  } else {
    range.setEnd(focusNode, focusOffset);
  }

  return range;
}

/**
 * The selection's first range as seen through `root`, in whichever shape of
 * `getComposedRanges` the engine has -- the dictionary form, or the variadic
 * one Safari first shipped -- and only one that `reaches` where the caller
 * needs it to: a form the engine does not know answers with the retargeted
 * range, or throws.
 */
function composedRange(
  selection: Selection,
  root: ShadowRoot,
  reaches: (range: StaticRange) => boolean,
): StaticRange | null {
  const composed = (selection as Selection & { getComposedRanges?: ComposedRanges })
    .getComposedRanges;

  for (const args of [[{ shadowRoots: [root] }], [root]]) {
    let ranges: readonly StaticRange[] | undefined;

    try {
      ranges = composed?.apply(selection, args);
    } catch {
      continue;
    }

    const first = ranges?.[0];

    if (first && reaches(first)) {
      return first;
    }
  }

  return null;
}

/**
 * The two ends of the selection, wherever they are, as seen from inside
 * `node`'s tree: for a range that leaves a shadow root -- one end in it, the
 * other in the page around it. `readSelection` reads a selection inside the
 * tree; out of a shadow root that has no `getSelection` of its own, the
 * selection's ends are retargeted to the shadow host -- WebKit reports such
 * a range collapsed there -- and name nothing inside. The composed range
 * does. Null with no selection, or one this script cannot touch.
 */
export function readSelectionEnds(node: Node): { start: Node; end: Node } | null {
  const root = node.getRootNode() as ShadowRoot & { getSelection?: () => Selection | null };
  const doc = node.ownerDocument ?? (node as Document);
  const selection = root.getSelection?.() ?? doc.defaultView?.getSelection() ?? null;

  if (!selection || selection.rangeCount === 0 || !touchable(doc, selection)) {
    return null;
  }

  if ('host' in root) {
    const composed = composedRange(
      selection,
      root,
      (range) => root.contains(range.startContainer) || root.contains(range.endContainer),
    );

    if (composed) {
      return { start: composed.startContainer, end: composed.endContainer };
    }
  }

  const { anchorNode, focusNode } = selection;

  return anchorNode && focusNode ? { start: anchorNode, end: focusNode } : null;
}

/** Where a selection was begun, and its two ends ({@link readSelectionAnchor}). */
export interface SelectionAnchorReading {
  /** The end the reader began at; null where nothing says which end that is. */
  anchor: Node | null;
  /** Both ends, in no particular order. */
  start: Node;
  end: Node;
  collapsed: boolean;
}

/**
 * Where the page's selection was begun -- its anchor -- and both its ends,
 * wherever they are, as seen from inside `node`'s tree: for a selection that
 * lies outside a shadow root wholly or in part, too.
 *
 * Read from the document's selection, never a shadow root's own: Chromium's
 * `ShadowRoot.getSelection()` reports nothing for a range outside its tree.
 * Out of a shadow root the ends are the composed range's, whose direction
 * is the selection's -- where it reports one. Chromium and WebKit report
 * "none" for a selection a mouse made; their own anchor and focus are then
 * asked, which are retargeted out of the shadow tree but name an end
 * outside it as it is, so the end of the composed range one of them names
 * -- the same node at the same offset -- says which is which: WebKit
 * retargets an end in the tree to the host's place in its parent, and a
 * drag out to a blank corner of that parent ends there at another offset,
 * which, named by node alone, read the drag's own anchor as the page's.
 * Firefox reports a direction, and at the release of a
 * drag from the page into a shadow root moves its own anchor into the tree
 * (to the editor's first block), which is why that is asked last. Null with
 * no selection, one this script cannot touch, or a shadow tree no composed
 * range sees into.
 */
export function readSelectionAnchor(node: Node): SelectionAnchorReading | null {
  const root = node.getRootNode() as Document | ShadowRoot;
  const doc = node.ownerDocument ?? (node as Document);
  const selection = doc.defaultView?.getSelection() ?? null;

  if (!selection || (selection.rangeCount > 0 && !touchable(doc, selection))) {
    return null;
  }

  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;

  if (!('host' in root)) {
    return selection.rangeCount > 0 && anchorNode && focusNode
      ? { anchor: anchorNode, start: anchorNode, end: focusNode, collapsed: selection.isCollapsed }
      : null;
  }

  // Asked even with no range in the document's own tree: WebKit reports
  // none for a read-only drag from the page into a shadow root, whose
  // composed range runs from the page's text into the block.

  const inTree = composedRange(
    selection,
    root,
    (range) => root.contains(range.startContainer) || root.contains(range.endContainer),
  );

  if (!inTree) {
    // No end in the tree, by any form that answers at all.
    const outside = composedRange(selection, root, () => true);

    return outside
      ? {
          anchor: null,
          start: outside.startContainer,
          end: outside.endContainer,
          collapsed: outside.collapsed,
        }
      : null;
  }

  const direction = (selection as Selection & { direction?: string }).direction;
  const names = (node: Node | null, offset: number, container: Node, at: number) =>
    node !== null && node === container && offset === at;
  let anchorAt: 'start' | 'end' | null =
    direction === 'forward' ? 'start' : direction === 'backward' ? 'end' : null;

  if (anchorAt === null) {
    const { startContainer, startOffset, endContainer, endOffset } = inTree;

    if (
      names(anchorNode, anchorOffset, startContainer, startOffset) ||
      names(focusNode, focusOffset, endContainer, endOffset)
    ) {
      anchorAt = 'start';
    } else if (
      names(anchorNode, anchorOffset, endContainer, endOffset) ||
      names(focusNode, focusOffset, startContainer, startOffset)
    ) {
      anchorAt = 'end';
    }
  }

  return {
    anchor:
      anchorAt === 'start'
        ? inTree.startContainer
        : anchorAt === 'end'
          ? inTree.endContainer
          : null,
    start: inTree.startContainer,
    end: inTree.endContainer,
    collapsed: inTree.collapsed,
  };
}

/**
 * Whether this script can touch the nodes the selection is in.
 *
 * Not always: Firefox's Quick Find leaves the page's selection in the find
 * bar's own content, and the range's containers there are no `Node` this
 * page can hold -- `contains` on one throws a `TypeError`, and from a
 * `selectionchange` listener that reached the host page's error reporting.
 * A selection the page cannot touch is no selection the editor has, so any
 * throw while reading or testing its ends answers false.
 */
function touchable(doc: Document, selection: Selection): boolean {
  try {
    const range = selection.getRangeAt(0);

    for (const node of [
      selection.anchorNode,
      selection.focusNode,
      range.startContainer,
      range.endContainer,
    ]) {
      if (node) {
        doc.contains(node);
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * `offset` brought within `node`: no further than its text, for a character
 * node, or its child count, for any other.
 *
 * WebKit's `Selection` can report an offset its node no longer has. A render
 * that replaced a block's five children with one left `anchorOffset` at
 * `DIV:4`, and every `setStart`/`setEnd` given it threw `IndexSizeError`:
 * `setDocument` threw after drawing the new document -- no `change`, no
 * history -- and the next keystroke threw from the snapshot it takes first.
 * The position past the last child is where the reader's caret already was,
 * the end of the block, so that is what the stale offset is read as.
 */
function clampOffset(node: Node, offset: number): number {
  const length =
    node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 7 || node.nodeType === 8
      ? ((node as CharacterData).data?.length ?? 0)
      : node.childNodes.length;

  return Math.min(Math.max(offset, 0), length);
}

/** Character offset of a DOM position within `element`. */
function offsetOf(element: HTMLElement, container: Node, offset: number): number {
  const probe = element.ownerDocument.createRange();
  probe.selectNodeContents(element);
  probe.setEnd(container, clampOffset(container, offset));

  return probe.toString().length;
}

/** Resolves a character offset to the text node and offset that hold it. */
export function locate(element: HTMLElement, offset: number): { node: Node; offset: number } {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;

  if (!node) {
    return { node: element, offset: 0 };
  }

  let remaining = Math.max(0, offset);

  for (;;) {
    if (remaining <= node.length) {
      return { node, offset: remaining };
    }

    remaining -= node.length;
    const next = walker.nextNode() as Text | null;

    if (!next) {
      return { node, offset: node.length };
    }

    node = next;
  }
}

/** The current selection as offsets into `element`, or null when it is elsewhere. */
export function getSelectionRange(element: HTMLElement): OffsetRange | null {
  const range = readSelection(element)?.range;

  if (!range) {
    return null;
  }

  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) {
    return null;
  }

  const start = offsetOf(element, range.startContainer, range.startOffset);
  const end = offsetOf(element, range.endContainer, range.endOffset);

  return start <= end ? { start, end } : { start: end, end: start };
}

/** Character offset of the caret within `element`, or 0 when it is elsewhere. */
export function getCaretOffset(element: HTMLElement): number {
  return getSelectionRange(element)?.start ?? 0;
}

/**
 * Both ends of the selection as offsets into `element`, in the order the reader
 * made them: `anchor` stays put, `focus` is the end Shift+Arrow moves. Null
 * when either end is elsewhere.
 */
export function getSelectionEnds(element: HTMLElement): { anchor: number; focus: number } | null {
  const reading = readSelection(element);

  if (!reading || !element.contains(reading.anchorNode) || !element.contains(reading.focusNode)) {
    return null;
  }

  return {
    anchor: offsetOf(element, reading.anchorNode, reading.anchorOffset),
    focus: offsetOf(element, reading.focusNode, reading.focusOffset),
  };
}

/**
 * Selects `[start, end)` within `element`.
 *
 * `backward` puts the anchor at `end` and the focus at `start`, which is how a
 * selection made with Shift+← is held: restored forwards, the next Shift+←
 * shrank it from the other end instead of growing it.
 */
export function setSelectionRange(
  element: HTMLElement,
  start: number,
  end: number,
  backward = false,
): void {
  const selection = selectionOf(element);

  if (!selection) {
    return;
  }

  const from = locate(element, backward ? end : start);
  const to = locate(element, backward ? start : end);

  // Not removeAllRanges + addRange: WebKit ignores a range added inside a
  // shadow root, so every caret placed there went nowhere (the e2e finding
  // F10). setBaseAndExtent is honoured across the boundary in every engine.
  // Cleared first all the same: setting the range it already has fires no
  // selectionchange, and the editor keys its toolbars off that event -- so
  // re-selecting the text Escape had hidden the toolbar for left it hidden.
  if (typeof selection.setBaseAndExtent === 'function') {
    selection.removeAllRanges();
    selection.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
    return;
  }

  // A Range has no direction; without setBaseAndExtent there is none to keep.
  const range = element.ownerDocument.createRange();
  const first = backward ? to : from;
  const last = backward ? from : to;

  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset);

  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Where one end of the reader's selection stands in a host's new text, when
 * the text around it changed under it (a peer's update to the very block the
 * reader is typing in), or null when nothing says.
 *
 * Identity, never a guess: the end keeps its offset while the text before it
 * is what it was, and keeps its distance from the end while the text after it
 * is. Both can hold -- for an insertion exactly at the end, and anywhere in
 * repeated text ("ha ha| ha!" less a "ha ": either "ha" went) -- and `side`
 * says which reading wins: `'before'` (the offset kept) for a caret and a
 * range's end, `'after'` for a range's start. For a caret either reading
 * loses nothing. A range is carried by `carryRange` instead, which reads the
 * edit once for both ends. Where neither holds, the end is inside the
 * text that changed -- the span between the longest common prefix and the
 * longest common suffix. If that span is empty in the new text, the change
 * was a pure deletion around the end, and it goes where the deleted text was
 * (the prefix's length). Text inserted or replaced across it says nothing:
 * null -- unless `always`, for a composition, which is never let go of: then
 * the start of the changed text.
 *
 * Those offsets are counted in UTF-16 code units, and the answer can fall
 * inside a character a reader sees as one. Then:
 * - an end the reader's own keys had already put inside a character (Firefox
 *   after a virama typed before a consonant, "क्|मल") is left there;
 * - where the character holding the answer is a whole character of the
 *   reader's that the arithmetic cut (every emoji in U+1F600..U+1F64F shares
 *   its first half, so a deletion's common prefix ended inside "😂"), the
 *   answer goes to that character's edge on the side it stood on;
 * - where the peer's new text extends the reader's character (a mark, VS16, a
 *   skin tone, a vowel sign), it goes over that new text alone, to the
 *   character's edge -- snapped back over the reader's character instead,
 *   the next letter split their word ("नQमाY");
 * - where the character joins the reader's text on both sides of the answer
 *   (a deletion between "🇺" and "🇸", a virama or a ZWJ inserted between two
 *   of the reader's characters), it is not moved: either way it would go over
 *   the reader's own text, and a range start that went back over "🇺" had the
 *   "Q" typed over the range delete it.
 *
 * Never between the two halves of a surrogate pair (`codePointStart`).
 */
export function carryOffset(
  before: string,
  after: string,
  offset: number,
  side: 'before' | 'after',
  always = false,
): number | null {
  const kept = before.slice(0, offset) === after.slice(0, offset) ? offset : null;
  const tail = before.length - offset;
  const fromEnd =
    after.length >= tail && after.slice(after.length - tail) === before.slice(offset)
      ? after.length - tail
      : null;
  const { prefix, suffix } = commonEnds(before, after);
  let carried: number;

  if (kept !== null && (side === 'before' || fromEnd === null)) {
    carried = kept;
  } else if (fromEnd !== null) {
    carried = fromEnd;
  } else if (prefix + suffix === after.length || always) {
    carried = prefix;
  } else {
    return null;
  }

  return settle(before, after, offset, carried, carried === kept, prefix, suffix);
}

/** The longest common prefix of two texts, and the longest common suffix of what is left. */
function commonEnds(before: string, after: string): { prefix: number; suffix: number } {
  const shortest = Math.min(before.length, after.length);
  let prefix = 0;

  while (prefix < shortest && before[prefix] === after[prefix]) {
    prefix += 1;
  }

  let suffix = 0;

  while (
    suffix < shortest - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return { prefix, suffix };
}

/**
 * Where a carried offset settles when it falls inside a character a reader
 * sees as one (see `carryOffset`): `forward` says which edge it goes to when
 * only the peer's new text lies on one side of it.
 */
function settle(
  before: string,
  after: string,
  offset: number,
  carried: number,
  forward: boolean,
  prefix: number,
  suffix: number,
): number {
  // The reader's own keys put it inside a character: left where it was.
  if (graphemeStart(before, offset) !== offset) {
    return codePointStart(after, carried);
  }

  const start = graphemeStart(after, carried);

  if (start === carried) {
    return carried;
  }

  const end = graphemeEnd(after, carried);
  const cluster = after.slice(start, end);
  const shift = after.length - before.length;
  const changedEnd = after.length - suffix;

  // A whole character of the reader's, still there, that the arithmetic cut:
  // to its edge on the side of the end it stood on.
  if (end >= changedEnd) {
    const was = end - shift;
    const from = graphemeStart(before, Math.max(was - 1, 0));

    if (was <= before.length && from >= offset && before.slice(from, was) === cluster) {
      return start;
    }
  }

  if (start <= prefix) {
    const to = graphemeEnd(before, start + 1);

    if (
      graphemeStart(before, start) === start &&
      to <= offset &&
      before.slice(start, to) === cluster
    ) {
      return end;
    }
  }

  // Otherwise moved only over the peer's new text.
  const readers = (from: number, to: number): boolean => {
    for (let at = from; at < to; at += 1) {
      if (at < prefix || at >= changedEnd) {
        return true;
      }
    }

    return false;
  };
  const left = readers(start, carried);
  const right = readers(carried, end);

  if (!right && (left || forward)) {
    return end;
  }

  if (!left) {
    return start;
  }

  return codePointStart(after, carried);
}

/** Whether `text` holds no lone surrogate. */
function wellFormed(text: string): boolean {
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at);

    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(at + 1);

      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }

      at += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }

  return true;
}

/** The extreme readings `wholeReadings` keeps, and which between them it keeps. */
interface Readings {
  first: number;
  last: number;
  kept: (x: number) => boolean;
}

/**
 * The readings of a pure insertion or deletion of `size` code units
 * (`longer` holds it, `shorter` does not) between `first` and `last` that
 * keep every code point whole -- at every edge a code point boundary of both
 * texts -- else, where none does, all of them: the lowest and highest kept
 * (`first`, `last`) and `kept`, the test that tells which of the readings
 * between them are kept (always true where all are). In well-formed text no
 * editor's edit cuts a surrogate pair, so the true reading is kept; where
 * either text holds a lone surrogate every reading counts, since an edit can
 * complete one into a pair ("\ud83d" made "😀\ud83d" by "\ude00\ud83d" put
 * after it, a reading that cuts the new pair). None keeping every code point
 * whole is no proof of a lone surrogate either: "🈀𐀀x" made "🀀x" is a
 * replacement that only looks pure. Graphemes are not asked: a peer's own
 * Backspace takes one code point of a conjunct, a syllable's jamo or a
 * letter's mark, and a reading that cuts a character can be the true one --
 * excluding it took unselected text into the range. The readings kept are
 * not one interval, but the range is carried by the two extremes alone (its
 * ends' images move one way as the reading does); `kept` is asked only of a
 * tie, whether a reading between them puts it inside the inserted text.
 */
function wholeReadings(
  longer: string,
  shorter: string,
  first: number,
  last: number,
  size: number,
): Readings {
  const every: Readings = { first, last, kept: () => true };

  if (first >= last || !wellFormed(longer) || !wellFormed(shorter)) {
    return every;
  }

  const whole = (x: number): boolean =>
    codePointStart(longer, x) === x &&
    codePointStart(longer, x + size) === x + size &&
    codePointStart(shorter, x) === x;
  let low = first;
  let high = last;

  while (low <= last && !whole(low)) {
    low += 1;
  }

  while (high > low && !whole(high)) {
    high -= 1;
  }

  return low <= last ? { first: low, last: high, kept: whole } : every;
}

/**
 * Both ends of a range carried across the same change, or null when text was
 * put in across an end.
 *
 * A pure deletion or insertion in repeated text can be read in more than one
 * place -- "ha ha ha!" less a "ha " lost the first, the second or the third
 * -- and any single reading is wrong about half the time: carried one end at
 * a time, the two ends read it two ways and the range grew over text the
 * reader never selected ("Q!"); read once from the common prefix, a "w" a
 * peer typed before a selected "world" went inside the range ("hello Q").
 * The valid readings form one interval (from the longest common suffix's
 * start to the longest common prefix's end), less the readings that would
 * cut a code point (`wholeReadings`) -- matched code unit by code unit, the
 * 👍 deleted before a 😀 could be read as its last code unit and the 😀's
 * first, and the range lost its 😀 -- and the range is carried to what every
 * reading agrees on: its start as far right as any reading puts it, its end
 * as far left. That never covers text the reader did not select, nor the
 * peer's text at an edge, whichever reading was true; and text put in
 * exactly at the start goes before the range, at the end after it, as
 * decided. The cost is that an ambiguous edit can leave some of the selected
 * text out of the range -- part of a character too, since a reading that
 * cuts one is still counted: a peer's own Backspace can cut one (one code
 * point of a conjunct, of a syllable's jamo, a letter's mark), and leaving
 * it out took unselected text in. Where nothing is left, the range is a
 * caret: where it began, for a deletion (in the reading where the deletion
 * was the selected text itself, "the Qcat"); before every place an insertion
 * could have gone, so never inside the peer's text, and never forward past
 * that place nor inside a character there: at most the start of the
 * character it falls in. A tie between two readings of an insertion is
 * nothing too where a kept reading puts the meeting point strictly inside
 * the inserted text ("ha" made "haha"); elsewhere the caret stays where the
 * readings meet ("1000000" with a "0" typed, between the same two "0"s).
 *
 * A replacement is read once, from the common prefix and suffix: an end in
 * the replaced text says nothing, null. An end then settles inside a
 * character as `carryOffset`'s does.
 */
export function carryRange(
  before: string,
  after: string,
  start: number,
  end: number,
): OffsetRange | null {
  const { prefix, suffix } = commonEnds(before, after);
  const shortest = Math.min(before.length, after.length);
  const size = Math.abs(after.length - before.length);

  if (size > 0 && prefix + suffix === shortest) {
    // Every reading puts the change at some x in [first, last].
    let tail = 0;

    while (tail < shortest && before[before.length - 1 - tail] === after[after.length - 1 - tail]) {
      tail += 1;
    }

    const deleting = after.length < before.length;
    const { first, last, kept } = wholeReadings(
      deleting ? before : after,
      deleting ? after : before,
      shortest - tail,
      prefix,
      size,
    );
    // The image of an offset under the reading at x, and that reading's
    // common ends for `settle`.
    const image = (offset: number, x: number, side: 'before' | 'after'): number => {
      if (deleting) {
        return offset <= x ? offset : offset >= x + size ? offset - size : x;
      }

      return offset < x || (offset === x && side === 'before') ? offset : offset + size;
    };
    const ends = (x: number): [number, number] =>
      deleting ? [x, after.length - x] : [x, after.length - x - size];
    // Images move right as x does for a deletion, left for an insertion: the
    // start's rightmost and the end's leftmost are at the two extremes.
    const startAt = deleting ? last : first;
    const endAt = deleting ? first : last;
    const from = image(start, startAt, 'after');
    const to = image(end, endAt, 'before');

    // Nothing every reading agrees on. For an insertion a tie is nothing
    // too where a kept reading puts the place the readings meet strictly
    // inside the peer's text: "ha" made "haha" put the start's image in one
    // reading and the end's in another at 2, inside the peer's "ah" in the
    // reading "h|ah|a". Only there: one "0" of "1000000" selected and a "0"
    // typed meet at 6, between two "0"s in every reading, and moved to the
    // front the caret left the reader's place for nothing. Asking costs the
    // inserted text's length. The caret goes to `first`, never past it nor
    // inside a character: settled forward over peer text joined to the
    // character before it (a vowel sign, a mark), it stood inside that text
    // in a later reading, and put back by code point, inside the reader's
    // character, where Firefox typed into it and WebKit at its end, in the
    // peer's text -- so to the start of that character, before every
    // reading. That holds where the settle left the caret at `first` too,
    // which is the reader's own doing: a range Firefox let the reader start
    // inside a character ("क्" typed before "म", then "म" selected, offset 2)
    // is carried unsnapped elsewhere, but collapsed here it is snapped to the
    // character's start ("क्म" made "क्म्म": "Qक्म्म", not "कQ्म्म"). For
    // a deletion a tie already is the caret where the selection began (the
    // start's image in the reading where the deletion was the selection),
    // and the range below settles it inward as before.
    let insideAReading = false;

    if (!deleting && from === to) {
      for (let x = Math.max(first, from - size + 1); x < from && x <= last; x += 1) {
        if (kept(x)) {
          insideAReading = true;
          break;
        }
      }
    }

    if (!deleting && (from > to || insideAReading)) {
      const settled = settle(before, after, start, first, false, ...ends(first));
      const caret = settled >= first ? graphemeStart(after, first) : settled;

      return { start: caret, end: caret };
    }

    if (from > to) {
      const caret = settle(before, after, start, from, false, ...ends(startAt));

      return { start: caret, end: caret };
    }

    // Settled inside a character only inward, so what every reading agrees
    // on is all the range holds: a start never before `from`, an end never
    // past `to` -- except over text that is the peer's in every reading (a
    // mark the peer put on the last selected character, which the range
    // takes with it, as `carryOffset` does).
    const peerAlways = deleting ? null : ([last, first + size] as const);
    let settledStart = settle(before, after, start, from, false, ...ends(startAt));
    let settledEnd = settle(before, after, end, to, true, ...ends(endAt));

    if (settledStart < from) {
      settledStart = codePointEnd(after, from);
    }

    if (settledEnd > to && !(peerAlways && to >= peerAlways[0] && settledEnd <= peerAlways[1])) {
      settledEnd = codePointStart(after, to);
    }

    return settledStart <= settledEnd ? { start: settledStart, end: settledEnd } : null;
  }

  const changedBefore = before.length - suffix;
  const shift = after.length - before.length;
  // An end at the edge of the replaced text keeps to its own side of it: the
  // prefix's end stays there, the replaced text's end goes to the new text's.
  const map = (offset: number): number | null => {
    if (offset <= prefix) {
      return offset;
    }

    if (offset >= changedBefore) {
      return offset + shift;
    }

    return null;
  };
  const from = map(start);
  const to = map(end);

  if (from === null || to === null) {
    return null;
  }

  const settledStart = settle(before, after, start, from, false, prefix, suffix);
  const settledEnd = settle(before, after, end, to, true, prefix, suffix);

  return settledStart <= settledEnd ? { start: settledStart, end: settledEnd } : null;
}

/** Places the caret at `offset` characters into `element`. */
export function setCaretOffset(element: HTMLElement, offset: number): void {
  setSelectionRange(element, offset, offset);
}

/** Offsets spanned by a descendant node, in character offsets into `element`. */
export function offsetsOfNode(element: HTMLElement, node: Node): OffsetRange | null {
  if (!element.contains(node)) {
    return null;
  }

  const probe = element.ownerDocument.createRange();
  probe.selectNodeContents(element);
  probe.setEndBefore(node);
  const start = probe.toString().length;

  return { start, end: start + (node.textContent ?? '').length };
}

/** True when the caret sits at the very start and nothing is selected. */
export function isCaretAtStart(element: HTMLElement): boolean {
  const range = getSelectionRange(element);
  return range !== null && range.start === range.end && range.start === 0;
}

/** True when the caret sits at the very end and nothing is selected. */
export function isCaretAtEnd(element: HTMLElement): boolean {
  const range = getSelectionRange(element);

  return (
    range !== null && range.start === range.end && range.end === (element.textContent ?? '').length
  );
}

/** Character offset of a DOM position, or null when it is not inside `element`. */
export function offsetWithin(element: HTMLElement, node: Node, offset: number): number | null {
  return element.contains(node) ? offsetOf(element, node, offset) : null;
}

/* ------------------------------------------------------------ geometry -- */

/*
 * Lines as the reader sees them.
 *
 * Every block is its own editing host, so a browser's ↑/↓ stops at the edge of
 * one: on the first line ↑ only took the caret to offset 0, and a second press
 * was needed to leave. Leaving on the first press needs to know which line the
 * caret is on, and once a block wraps only layout knows that. These helpers
 * answer from the engine's line boxes and say `null` where there are none to
 * read (happy-dom computes no layout), so a caller can fall back to the logical
 * edge.
 */

function textRange(element: HTMLElement, start: number, end: number): Range {
  const from = locate(element, start);
  const to = locate(element, end);
  const range = element.ownerDocument.createRange();

  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);

  return range;
}

function boxes(range: Range): DOMRect[] {
  const list = typeof range.getClientRects === 'function' ? [...range.getClientRects()] : [];

  return list.filter((rect) => rect.width > 0 || rect.height > 0);
}

function isRtl(element: HTMLElement): boolean {
  return element.ownerDocument.defaultView?.getComputedStyle(element).direction === 'rtl';
}

/**
 * Whether the caret at `offset` sits on the first line of `element` (`-1`) or
 * on its last (`1`), counting soft wraps as well as hard breaks.
 *
 * A newline between the caret and that edge settles it without layout: even a
 * trailing one renders a line of its own (see `renderRichText`'s filler).
 * Otherwise the text between them is measured, and it is one line when every
 * box it draws overlaps the edge line vertically. `null` when nothing is laid
 * out to measure.
 *
 * At a soft wrap the end of one line and the start of the next are the same
 * offset, and which of the two the caret is drawn at is the browser's to know
 * (its affinity) -- the DOM selection does not say. Measuring only the text
 * between caret and edge called the start of line 2 the first line, so ↑ from
 * there left the block and skipped line 1. So the character on the far side
 * of the caret is measured too: where the offset is a wrap point the answer is
 * "not the edge line", and the browser, which does know, moves the caret.
 *
 * Unless the side is known: `side` is the line a caret at a wrap point is
 * drawn on, as `softWrapLine` answers it. A caret on the side facing away
 * from the edge is not on the edge line; one on the side facing it is on the
 * line of the characters between it and the edge, and only those are
 * measured. Left to the browser, that press went to the block's end.
 */
export function isOnEdgeLine(
  element: HTMLElement,
  offset: number,
  direction: 1 | -1,
  side: 'upper' | 'lower' | null = null,
): boolean | null {
  const text = element.textContent ?? '';
  const at = Math.max(0, Math.min(offset, text.length));
  const between = direction === -1 ? text.slice(0, at) : text.slice(at);

  if (between.includes('\n')) {
    return false;
  }

  if (between.length === 0) {
    return true;
  }

  const known = side !== null && isSoftWrap(element, at);

  if (known && side !== (direction === -1 ? 'upper' : 'lower')) {
    return false;
  }

  // One character past the caret, unless that is a hard break -- which the
  // caret is then on this side of, unambiguously -- or the side is known.
  const reach = !known;
  const from = reach && direction === 1 && at > 0 && text[at - 1] !== '\n' ? at - 1 : at;
  const to = reach && direction === -1 && at < text.length && text[at] !== '\n' ? at + 1 : at;
  const rects = boxes(
    direction === -1 ? textRange(element, 0, to) : textRange(element, from, text.length),
  );
  const edge = direction === -1 ? rects[0] : rects.at(-1);

  if (!edge) {
    return null;
  }

  return rects.every((rect) => rect.top < edge.bottom - 1 && rect.bottom > edge.top + 1);
}

/**
 * The horizontal position of a caret at `offset`, in viewport pixels.
 *
 * A collapsed range reports a box of its own inside a text node; where it
 * reports none -- at a node boundary, on an empty line -- the edge of the
 * neighbouring character stands in, on the side the caret touches.
 *
 * Two positions are a line start the collapsed box misplaces. At a soft wrap
 * Chromium and Firefox draw that box at the end of the previous line, so ↓
 * from the start of a last line entered the next block at its far end: the
 * next character's leading edge is used there, as it is for the line after a
 * hard break. And on an empty line after a break -- a code block's trailing
 * line -- Firefox and WebKit measure the box from the previous line's end, so
 * the start of the line box is used instead.
 */
export function caretX(element: HTMLElement, offset: number): number | null {
  const text = element.textContent ?? '';
  const at = Math.max(0, Math.min(offset, text.length));
  const rtl = isRtl(element);
  const lead = (rect: DOMRect): number => (rtl ? rect.right : rect.left);
  const afterBreak = at > 0 && text[at - 1] === '\n';
  const next =
    at < text.length && text[at] !== '\n' ? boxes(textRange(element, at, at + 1))[0] : undefined;

  if (next && afterBreak) {
    return lead(next);
  }

  if (next && at > 0) {
    const previous = boxes(textRange(element, at - 1, at)).at(-1);

    if (previous && next.top >= previous.bottom - 1) {
      return lead(next);
    }
  }

  if (afterBreak) {
    const start = lineStartX(element, rtl);

    if (start !== null) {
      return start;
    }
  }

  const own = boxes(textRange(element, at, at))[0];

  if (own) {
    return own.left;
  }

  if (next) {
    return lead(next);
  }

  if (at > 0 && !afterBreak) {
    const previous = boxes(textRange(element, at - 1, at)).at(-1);

    if (previous) {
      return rtl ? previous.left : previous.right;
    }
  }

  return null;
}

/**
 * Where a line of `element` starts, horizontally: the inline-start edge of its
 * content box. Only for start-aligned text, where that is where an empty line's
 * caret is drawn; `null` otherwise, and where nothing is laid out.
 */
function lineStartX(element: HTMLElement, rtl: boolean): number | null {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const align = style?.textAlign ?? '';
  const startAligned =
    align === 'start' ||
    align === 'justify' ||
    align === '' ||
    align === (rtl ? 'right' : 'left') ||
    align === (rtl ? '-webkit-right' : '-webkit-left');
  const rect = element.getBoundingClientRect();

  if (!style || !startAligned || (rect.width === 0 && rect.height === 0)) {
    return null;
  }

  const inset = (side: 'left' | 'right'): number =>
    (parseFloat(style.getPropertyValue(`padding-${side}`)) || 0) +
    (parseFloat(style.getPropertyValue(`border-${side}-width`)) || 0);

  return rtl ? rect.right - inset('right') : rect.left + inset('left');
}

/**
 * Whether `offset` is a soft wrap: the character before it and the one after
 * it are drawn on different lines with no newline between them. A caret there
 * is at the end of one line or the start of the next, and the DOM selection
 * does not say which -- only the browser knows (its affinity). `false` where
 * nothing is laid out.
 */
export function isSoftWrap(element: HTMLElement, offset: number): boolean {
  const text = element.textContent ?? '';

  if (offset <= 0 || offset >= text.length || text[offset] === '\n' || text[offset - 1] === '\n') {
    return false;
  }

  const previous = boxes(textRange(element, offset - 1, offset)).at(-1);
  const next = boxes(textRange(element, offset, offset + 1))[0];

  return previous !== undefined && next !== undefined && next.top >= previous.bottom - 1;
}

/**
 * The two places a caret at the soft wrap `offset` can be drawn: the end of
 * the upper line (beside the character before it) and the start of the lower
 * one (beside the character after it), each with its line's vertical middle.
 * `null` when `offset` is no soft wrap.
 */
export function softWrapSides(
  element: HTMLElement,
  offset: number,
): { upper: { x: number; middle: number }; lower: { x: number; middle: number } } | null {
  if (!isSoftWrap(element, offset)) {
    return null;
  }

  const rtl = isRtl(element);
  const previous = boxes(textRange(element, offset - 1, offset)).at(-1)!;
  const next = boxes(textRange(element, offset, offset + 1))[0]!;

  return {
    upper: {
      x: rtl ? previous.left : previous.right,
      middle: (previous.top + previous.bottom) / 2,
    },
    lower: { x: rtl ? next.right : next.left, middle: (next.top + next.bottom) / 2 },
  };
}

type ModifiableSelection = TreeSelection & {
  modify?: (alter: string, direction: string, granularity: string) => void;
};

/**
 * Which line the collapsed caret at the soft wrap `offset` is drawn on, asked
 * of the browser: `null` when `offset` is no soft wrap or the browser cannot
 * be asked.
 *
 * The DOM selection carries no affinity, but the browser's own line
 * movement honours it: `Selection.modify` to the line's start leaves a caret
 * at the start of the lower line where it is, and takes one at the end of the
 * upper line to that line's start -- from where moving to the line's end puts
 * it back, drawn where it was, which is where the line-end key and a click
 * past the line's end put it. Every engine has `modify`.
 */
export function softWrapLine(element: HTMLElement, offset: number): 'upper' | 'lower' | null {
  if (!isSoftWrap(element, offset)) {
    return null;
  }

  const selection = selectionFor(element) as ModifiableSelection | null;
  const before = getSelectionEnds(element);

  if (!selection?.modify || !before || before.anchor !== offset || before.focus !== offset) {
    return null;
  }

  try {
    selection.modify('move', 'backward', 'lineboundary');
    const moved = getSelectionEnds(element);

    if (moved?.anchor === offset && moved.focus === offset) {
      return 'lower';
    }

    if (moved && moved.focus < offset) {
      selection.modify('move', 'forward', 'lineboundary');
      const back = getSelectionEnds(element);

      if (back?.anchor === offset && back.focus === offset) {
        return 'upper';
      }
    }
  } catch {
    // An engine that refuses leaves the question open.
  }

  // Wherever that left it, the caret goes back to the offset it was at.
  setCaretOffset(element, offset);
  return null;
}

/**
 * Puts a collapsed caret at `offset`, drawn on the `upper` or `lower` line
 * when `offset` is a soft wrap.
 *
 * An offset set through the Selection API is drawn at the start of the lower
 * line, so a caret aimed past the end of a wrapped line -- ↓ into a wrapped
 * paragraph's first line, under a column further right than that line runs
 * -- appeared a line further down, and the next ↓ skipped the line. The
 * browser's own move to the end of a line draws it on that line, so the
 * caret is put one character back and moved there; where that does not come
 * back to `offset`, the plain offset stands.
 */
export function placeCaretOnLine(
  element: HTMLElement,
  offset: number,
  side: 'upper' | 'lower',
): void {
  const selection = selectionFor(element) as ModifiableSelection | null;

  if (side === 'upper' && selection?.modify && isSoftWrap(element, offset)) {
    try {
      setCaretOffset(element, offset - 1);
      selection.modify('move', 'forward', 'lineboundary');
      const ends = getSelectionEnds(element);

      if (ends?.anchor === offset && ends.focus === offset) {
        return;
      }
    } catch {
      // Refused: the plain offset below.
    }
  }

  setCaretOffset(element, offset);
}

/** The vertical middle of `element`'s first or last line, or null when unmeasured. */
export function lineMiddle(element: HTMLElement, line: 'first' | 'last'): number | null {
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  const rects = boxes(range);
  const rect = line === 'first' ? rects[0] : rects.at(-1);

  return rect ? (rect.top + rect.bottom) / 2 : null;
}
