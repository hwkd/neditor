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

/**
 * The part of `Selection` the editor reads and writes.
 *
 * A real `Selection` is one; so is the view Safari needs inside a shadow root,
 * which is why callers ask for this rather than for the platform type.
 */
export interface TreeSelection {
  readonly rangeCount: number;
  readonly isCollapsed: boolean;
  readonly anchorNode: Node | null;
  readonly focusNode: Node | null;
  getRangeAt(index: number): Range;
  removeAllRanges(): void;
  setBaseAndExtent(anchor: Node, anchorOffset: number, focus: Node, focusOffset: number): void;
  collapse(node: Node | null, offset?: number): void;
}

interface ComposedRange {
  readonly startContainer: Node;
  readonly startOffset: number;
  readonly endContainer: Node;
  readonly endOffset: number;
  readonly collapsed: boolean;
}

type ComposedRanges = (options: { shadowRoots: ShadowRoot[] } | ShadowRoot) => ComposedRange[];

/**
 * The selection of the tree `node` lives in, reporting positions inside it.
 *
 * A shadow root has its own `getSelection` in Chromium, and Firefox's document
 * selection already reports the nodes inside one. Safari does neither: there is
 * no `ShadowRoot.getSelection`, and the document's selection is retargeted out
 * of the shadow tree -- WebKit reports the host's parent at offset 0 -- so every
 * caret read in a shadow-root mount said "not in this block". Inline rules never
 * fired and Enter split blocks at their start. `getComposedRanges` (Safari 17)
 * is the one API there that names the real position; below that there is
 * nothing better to read, and the document's answer is returned as before.
 */
export function selectionFor(node: Node): TreeSelection | null {
  const root = node.getRootNode() as ShadowRoot & { getSelection?: () => Selection | null };
  const own = root.getSelection?.();

  if (own) {
    return own;
  }

  const selection = node.ownerDocument?.defaultView?.getSelection() ?? null;

  if (!selection || !('host' in root)) {
    return selection;
  }

  return composedView(selection, root) ?? selection;
}

function composedView(selection: Selection, root: ShadowRoot): TreeSelection | null {
  const get = (selection as Selection & { getComposedRanges?: ComposedRanges }).getComposedRanges;

  if (typeof get !== 'function') {
    return null;
  }

  let ranges: ComposedRange[];

  try {
    ranges = get.call(selection, { shadowRoots: [root] });
  } catch {
    // Safari 17 shipped the first draft, which took the roots as arguments.
    try {
      ranges = get.call(selection, root);
    } catch {
      return null;
    }
  }

  const range = ranges[0];
  const doc = root.ownerDocument;

  return {
    rangeCount: range ? 1 : 0,
    isCollapsed: range ? range.collapsed : true,
    // A composed range has no direction; start and end stand in for the ends.
    anchorNode: range?.startContainer ?? null,
    focusNode: range?.endContainer ?? null,
    getRangeAt: () => {
      const live = doc.createRange();

      if (range) {
        live.setStart(range.startContainer, range.startOffset);
        live.setEnd(range.endContainer, range.endOffset);
      }

      return live;
    },
    removeAllRanges: () => {
      selection.removeAllRanges();
    },
    setBaseAndExtent: (anchor, anchorOffset, focus, focusOffset) => {
      selection.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
    },
    collapse: (target, offset) => {
      selection.collapse(target, offset);
    },
  };
}

/** Character offset of a DOM position within `element`. */
function offsetOf(element: HTMLElement, container: Node, offset: number): number {
  const probe = element.ownerDocument.createRange();
  probe.selectNodeContents(element);
  probe.setEnd(container, offset);

  return probe.toString().length;
}

/** Resolves a character offset to the text node and offset that hold it. */
function locate(element: HTMLElement, offset: number): { node: Node; offset: number } {
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
  const selection = selectionFor(element);

  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);

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

/** Selects `[start, end)` within `element`. */
export function setSelectionRange(element: HTMLElement, start: number, end: number): void {
  const selection = selectionFor(element);

  if (!selection) {
    return;
  }

  const from = locate(element, start);
  const to = locate(element, end);

  // `setBaseAndExtent`, not `addRange`: WebKit silently drops a range added
  // inside a shadow tree -- and the next keystroke with it -- so every caret
  // restored after an edit was lost in a shadow-root mount in Safari.
  selection.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
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
