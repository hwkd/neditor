/**
 * Realm-safe DOM checks.
 *
 * `instanceof Node` compares against the constructor of the realm the *script*
 * was loaded in. Mount the editor into an iframe's document — the CMS and
 * theme-preview pattern — and every such check fails against nodes that are
 * perfectly valid, silently disabling the gutter, drag selection, link clicks
 * and undo coalescing. Duck-typing the node interface works in any realm.
 */

/** DOM node type constants, without depending on a realm's `Node` global. */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

export function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Node).nodeType === 'number' &&
    typeof (value as Node).nodeName === 'string'
  );
}

export function isElement(value: unknown): value is Element {
  return isNode(value) && value.nodeType === ELEMENT_NODE;
}

export function isTextNode(value: unknown): value is Text {
  return isNode(value) && value.nodeType === TEXT_NODE;
}

/** The element a node sits in: itself when it is one, otherwise its parent. */
export function asElement(value: unknown): Element | null {
  if (isElement(value)) {
    return value;
  }

  return isNode(value) ? value.parentElement : null;
}

/** True for an `InputEvent`-shaped event, whatever realm produced it. */
export function hasInputType(event: Event): event is InputEvent {
  return typeof (event as InputEvent).inputType === 'string';
}
