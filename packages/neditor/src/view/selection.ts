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
  anchorOffset: number;
  focusNode: Node;
  focusOffset: number;
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
          anchorOffset: backward ? first.endOffset : first.startOffset,
          focusNode: backward ? first.startContainer : first.endContainer,
          focusOffset: backward ? first.startOffset : first.endOffset,
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
    anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode,
    focusOffset: selection.focusOffset,
    isCollapsed: selection.isCollapsed,
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
