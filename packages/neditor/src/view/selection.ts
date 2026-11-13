/**
 * Selection helpers.
 *
 * A contenteditable reports the selection as (node, offset) pairs inside
 * whatever text nodes the browser happens to have created. With rich text those
 * nodes are also nested inside `<strong>`, `<a>` and friends. Every caller here
 * wants plain character offsets into the block instead, so this module is the
 * only place that has to reason about the tree.
 */

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

/** What a caller needs to read from the selection, wherever it had to come from. */
export interface SelectionReading {
  /** Start to end, in document order. */
  range: Range;
  /** Where the reader started, which for a backward selection is the end. */
  anchorNode: Node;
  focusNode: Node;
  isCollapsed: boolean;
}

type ComposedRanges = (...args: unknown[]) => readonly StaticRange[];

/**
 * The selection as seen from inside `node`'s tree.
 *
 * In a shadow root that has no `getSelection` of its own -- WebKit, and
 * Firefox -- the document's selection is retargeted: WebKit reports the
 * shadow host, not the caret inside it, so every offset read from it was 0 and
 * a shadow-mounted editor could not tell where its caret was (the e2e finding
 * F10: Enter split at the start, marks never applied, the toolbar never
 * showed). `getComposedRanges` is the standard way to see through that
 * boundary. It is tried in both of its shapes -- the dictionary form, and the
 * variadic one Safari first shipped -- and only trusted when it actually
 * reaches into this root.
 */
export function readSelection(node: Node): SelectionReading | null {
  const root = node.getRootNode() as ShadowRoot & { getSelection?: () => Selection | null };
  const doc = node.ownerDocument ?? (node as Document);
  const selection = root.getSelection?.() ?? doc.defaultView?.getSelection() ?? null;

  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const isShadow = 'host' in root;

  if (isShadow && !root.getSelection && !root.contains(selection.anchorNode)) {
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

      if (first && root.contains(first.startContainer) && root.contains(first.endContainer)) {
        const range = doc.createRange();
        range.setStart(first.startContainer, first.startOffset);
        range.setEnd(first.endContainer, first.endOffset);
        // A composed range has no direction; the selection still knows it.
        const backward = (selection as Selection & { direction?: string }).direction === 'backward';

        return {
          range,
          anchorNode: backward ? first.endContainer : first.startContainer,
          focusNode: backward ? first.startContainer : first.endContainer,
          isCollapsed: range.collapsed,
        };
      }
    }
  }

  if (!selection.anchorNode || !selection.focusNode) {
    return null;
  }

  return {
    range: selection.getRangeAt(0),
    anchorNode: selection.anchorNode,
    focusNode: selection.focusNode,
    isCollapsed: selection.isCollapsed,
  };
}

/**
 * An inline formula's element: one character of offset, whatever it draws.
 *
 * The model holds a formula as a single atom character (`MATH_ATOM`), while
 * the renderer may draw it as a whole tree of KaTeX glyphs -- so a plain text
 * count put every caret after a formula hundreds of characters too far, and
 * Enter split the block somewhere else entirely. Every conversion here counts
 * the atom as one and never looks inside it.
 */
const ATOM_SELECTOR = '[data-neditor-math]';

const SHOW_ELEMENT = 0x1;
const SHOW_TEXT = 0x4;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;
const FILTER_SKIP = 3;

function isAtom(node: Node | null): node is Element {
  return node?.nodeType === 1 && (node as Element).hasAttribute('data-neditor-math');
}

function indexIn(parent: Node, child: Node): number {
  return Array.prototype.indexOf.call(parent.childNodes, child);
}

/** The formula `node` is inside, below `element`, if it is in one. */
function atomAround(element: HTMLElement, node: Node): Element | null {
  for (let at: Node | null = node; at && at !== element; at = at.parentNode) {
    if (isAtom(at)) {
      return at;
    }
  }

  return null;
}

/**
 * Character offset of a DOM position within `element`.
 *
 * A position inside a formula -- a browser can put one there on a double
 * click, uneditable or not -- is no position the model has, so it snaps to
 * the formula's start, or for the end of a range to its end, so that the
 * range still covers it.
 */
function offsetOf(
  element: HTMLElement,
  container: Node,
  offset: number,
  bias: 'start' | 'end' = 'start',
): number {
  const atom = atomAround(element, container);

  if (atom?.parentNode) {
    offset = indexIn(atom.parentNode, atom) + (bias === 'end' ? 1 : 0);
    container = atom.parentNode;
  }

  const probe = element.ownerDocument.createRange();
  probe.selectNodeContents(element);
  probe.setEnd(container, offset);

  let length = probe.toString().length;

  for (const found of element.querySelectorAll(ATOM_SELECTOR)) {
    const parent = found.parentNode;

    // Wholly before the position: its drawn text was counted, and one
    // character stands for it instead.
    if (parent && probe.isPointInRange(parent, indexIn(parent, found) + 1)) {
      length += 1 - rangeAround(found).toString().length;
    }
  }

  return length;
}

function rangeAround(node: Node): Range {
  const range = node.ownerDocument!.createRange();
  range.selectNodeContents(node);
  return range;
}

/** Resolves a character offset to the DOM position that holds it. */
function locate(element: HTMLElement, offset: number): { node: Node; offset: number } {
  const walker = element.ownerDocument.createTreeWalker(element, SHOW_TEXT | SHOW_ELEMENT, {
    acceptNode: (node) =>
      isAtom(node)
        ? FILTER_ACCEPT
        : isAtom(node.parentNode)
          ? FILTER_REJECT
          : node.nodeType === 3
            ? FILTER_ACCEPT
            : FILTER_SKIP,
  });
  let remaining = Math.max(0, offset);
  let last: { node: Node; offset: number } = { node: element, offset: 0 };

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (isAtom(node)) {
      const parent = node.parentNode!;
      const index = indexIn(parent, node);

      if (remaining === 0) {
        return { node: parent, offset: index };
      }

      remaining -= 1;
      last = { node: parent, offset: index + 1 };
      continue;
    }

    const length = (node as Text).length;

    if (remaining <= length) {
      return { node, offset: remaining };
    }

    remaining -= length;
    last = { node, offset: length };
  }

  return last;
}

/** The length of `element`'s text, a formula counting as one character. */
function hostLength(element: HTMLElement): number {
  return offsetOf(element, element, element.childNodes.length);
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
  const end = offsetOf(element, range.endContainer, range.endOffset, 'end');

  return start <= end ? { start, end } : { start: end, end: start };
}

/** Character offset of the caret within `element`, or 0 when it is elsewhere. */
export function getCaretOffset(element: HTMLElement): number {
  return getSelectionRange(element)?.start ?? 0;
}

/** Selects `[start, end)` within `element`. */
export function setSelectionRange(element: HTMLElement, start: number, end: number): void {
  const selection = selectionOf(element);

  if (!selection) {
    return;
  }

  const from = locate(element, start);
  const to = locate(element, end);

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

  const range = element.ownerDocument.createRange();

  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);

  selection.removeAllRanges();
  selection.addRange(range);
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

  const parent = node.parentNode;

  if (!parent) {
    return null;
  }

  const index = indexIn(parent, node);

  return {
    start: offsetOf(element, parent, index),
    end: offsetOf(element, parent, index + 1, 'end'),
  };
}

/** True when the caret sits at the very start and nothing is selected. */
export function isCaretAtStart(element: HTMLElement): boolean {
  const range = getSelectionRange(element);
  return range !== null && range.start === range.end && range.start === 0;
}

/** True when the caret sits at the very end and nothing is selected. */
export function isCaretAtEnd(element: HTMLElement): boolean {
  const range = getSelectionRange(element);

  return range !== null && range.start === range.end && range.end === hostLength(element);
}
