// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';

import { asElement, hasInputType, isElement, isNode, isTextNode } from './dom.ts';

/**
 * The realm-safety contract.
 *
 * `instanceof Node` compares against the constructor of the realm the *script*
 * loaded in, so a node from an iframe's document — the CMS and theme-preview
 * pattern — is rejected even though it is a perfectly valid node.
 *
 * A genuine second realm cannot be built under happy-dom (it shares its
 * constructors between Windows), so these tests pin the property that actually
 * matters instead: the helpers accept anything shaped like a node, and would
 * therefore accept a foreign one. A rewrite to `instanceof` fails every case
 * marked "foreign" below.
 */

/** What a node from another realm looks like to a check in this one. */
const foreignElement = { nodeType: 1, nodeName: 'DIV' } as unknown as Element;
const foreignText = { nodeType: 3, nodeName: '#text' } as unknown as Text;

describe('isNode', () => {
  test('accepts a real node', () => {
    expect(isNode(document.createElement('div'))).toBe(true);
    expect(isNode(document.createTextNode('x'))).toBe(true);
  });

  test('accepts a foreign node, which is the whole point', () => {
    expect(isNode(foreignElement)).toBe(true);
    expect(isNode(foreignText)).toBe(true);
  });

  test('rejects non-nodes', () => {
    for (const value of [null, undefined, 'div', 42, {}, { nodeType: 1 }, { nodeName: 'DIV' }]) {
      expect(isNode(value)).toBe(false);
    }
  });
});

describe('isElement', () => {
  test('accepts a real element and rejects a text node', () => {
    expect(isElement(document.createElement('div'))).toBe(true);
    expect(isElement(document.createTextNode('x'))).toBe(false);
  });

  test('accepts a foreign element', () => {
    expect(isElement(foreignElement)).toBe(true);
    expect(isElement(foreignText)).toBe(false);
  });
});

describe('isTextNode', () => {
  test('accepts a real text node and rejects an element', () => {
    expect(isTextNode(document.createTextNode('x'))).toBe(true);
    expect(isTextNode(document.createElement('div'))).toBe(false);
  });

  test('accepts a foreign text node', () => {
    expect(isTextNode(foreignText)).toBe(true);
    expect(isTextNode(foreignElement)).toBe(false);
  });
});

describe('asElement', () => {
  test('returns an element unchanged', () => {
    const el = document.createElement('div');

    expect(asElement(el)).toBe(el);
  });

  test('returns the parent of a text node', () => {
    const el = document.createElement('div');
    el.append('hello');

    expect(asElement(el.firstChild)).toBe(el);
  });

  test('returns null for a non-node', () => {
    expect(asElement('div')).toBeNull();
    expect(asElement(null)).toBeNull();
  });

  test('accepts a foreign element', () => {
    expect(asElement(foreignElement)).toBe(foreignElement);
  });
});

describe('hasInputType', () => {
  test('recognises an input event by shape, not by constructor', () => {
    expect(hasInputType({ inputType: 'insertText' } as unknown as Event)).toBe(true);
    expect(hasInputType(new Event('input'))).toBe(false);
  });
});
