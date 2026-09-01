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
  const selection = selectionOf(element);

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
  const selection = selectionOf(element);

  if (!selection) {
    return;
  }

  const from = locate(element, start);
  const to = locate(element, end);
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
