// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from 'vitest';

import type { Block } from '../model/document.ts';
import { DEFAULT_LABELS } from '../labels.ts';
import type { RendererHooks } from './renderer.ts';
import { Renderer } from './renderer.ts';

/**
 * Renderer tests.
 *
 * This module had no test file at all, which is how five separate mutations to
 * it survived a green suite. The invariant below is the one the whole editor
 * rests on: the renderer **reconciles**, it never re-renders. Writing content
 * unconditionally would destroy the caret on every keystroke, and nothing
 * anywhere asserted otherwise.
 */

/** These tests exercise rendering, not the callbacks, so the hooks are inert. */
const hooks: RendererHooks = {
  onToggleTodo: () => {},
  onToggleCollapsed: () => {},
  onPickIcon: () => {},
  onEditImage: () => {},
};

let root: HTMLElement;
let renderer: Renderer;

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
  renderer = new Renderer(root, hooks, DEFAULT_LABELS);
});

function block(over: Partial<Block>): Block {
  return { id: 'b1', type: 'paragraph', depth: 0, content: [], ...over } as Block;
}

const rendered = (): string[] =>
  [...root.querySelectorAll<HTMLElement>('.neditor-block')].map((el) => el.dataset.blockId ?? '');

describe('reconcile, never re-render', () => {
  test('a text edit reuses the very same DOM nodes', () => {
    renderer.render([block({ id: 'a', content: [{ text: 'hello' }] })]);
    const before = renderer.getView('a')!;
    const contentBefore = before.content!;
    const textNodeBefore = contentBefore.firstChild;

    renderer.render([block({ id: 'a', content: [{ text: 'hello world' }] })]);

    // Same host element: replacing it is what collapses the DOM selection and
    // sends the caret to the start of the block on every keystroke.
    expect(renderer.getView('a')!.content).toBe(contentBefore);
    expect(contentBefore.textContent).toBe('hello world');
    // The text node itself may be rewritten, but the host must not be.
    expect(textNodeBefore).toBeTruthy();
  });

  test('re-rendering identical content touches nothing at all', () => {
    const doc = [block({ id: 'a', content: [{ text: 'stable' }] })];
    renderer.render(doc);
    const content = renderer.getView('a')!.content!;
    const textNode = content.firstChild;

    renderer.render([block({ id: 'a', content: [{ text: 'stable' }] })]);

    // contentKey matched, so #updateView must skip replaceChildren entirely —
    // the original text node has to survive, caret and all.
    expect(renderer.getView('a')!.content!.firstChild).toBe(textNode);
  });

  test('a mark change rebuilds the runs even though the text is identical', () => {
    renderer.render([block({ id: 'a', content: [{ text: 'word' }] })]);
    expect(renderer.getView('a')!.content!.querySelector('strong')).toBeNull();

    renderer.render([block({ id: 'a', content: [{ text: 'word', marks: ['bold'] }] })]);

    // Plain text is not a sufficient fingerprint: same characters, different
    // element nesting.
    expect(renderer.getView('a')!.content!.querySelector('strong')?.textContent).toBe('word');
  });

  test('syncFromDom marks the view current so the next render leaves it alone', () => {
    renderer.render([block({ id: 'a', content: [{ text: 'typed' }] })]);
    const content = renderer.getView('a')!.content!;

    // The browser already wrote this; the model is catching up.
    renderer.syncFromDom('a', [{ text: 'typed by hand' }]);
    content.textContent = 'typed by hand';
    const textNode = content.firstChild;

    renderer.render([block({ id: 'a', content: [{ text: 'typed by hand' }] })]);

    expect(content.firstChild).toBe(textNode);
  });
});

describe('keyed reconcile', () => {
  test('blocks render in model order after a reorder', () => {
    const a = block({ id: 'a', content: [{ text: 'A' }] });
    const b = block({ id: 'b', content: [{ text: 'B' }] });
    const c = block({ id: 'c', content: [{ text: 'C' }] });
    renderer.render([a, b, c]);
    const viewA = renderer.getView('a')!.root;

    renderer.render([c, a, b]);

    // An append-instead-of-insertBefore regression leaves the old on-screen
    // order while the model says otherwise.
    expect(rendered()).toEqual(['c', 'a', 'b']);
    // ...and it must be a move, not a rebuild.
    expect(renderer.getView('a')!.root).toBe(viewA);
  });

  test('a removed block loses its view', () => {
    renderer.render([block({ id: 'a' }), block({ id: 'b' })]);

    renderer.render([block({ id: 'a' })]);

    expect(rendered()).toEqual(['a']);
    expect(renderer.getView('b')).toBeUndefined();
    expect(root.querySelector('[data-block-id="b"]')).toBeNull();
  });

  test('a type change rebuilds the view with the new semantic element', () => {
    renderer.render([block({ id: 'a', content: [{ text: 'Title' }] })]);
    expect(renderer.getView('a')!.content!.tagName).toBe('DIV');

    renderer.render([block({ id: 'a', type: 'heading1', content: [{ text: 'Title' }] })]);

    // Real heading semantics, not a div wearing an ARIA role.
    expect(renderer.getView('a')!.content!.tagName).toBe('H1');
  });
});

describe('structural fingerprint', () => {
  test('changing an image src updates the rendered element', () => {
    renderer.render([block({ id: 'a', type: 'image', src: 'https://a.test/one.png' })]);

    renderer.render([block({ id: 'a', type: 'image', src: 'https://a.test/two.png' })]);

    // getAttribute, not .src: the property resolves to an absolute URL.
    const image = renderer.getView('a')!.root.querySelector('img');
    expect(image?.getAttribute('src')).toBe('https://a.test/two.png');
  });

  test('changing image alt updates the rendered element', () => {
    renderer.render([block({ id: 'a', type: 'image', src: 'https://a.test/x.png', alt: 'one' })]);

    renderer.render([block({ id: 'a', type: 'image', src: 'https://a.test/x.png', alt: 'two' })]);

    expect(renderer.getView('a')!.root.querySelector('img')?.getAttribute('alt')).toBe('two');
  });

  test('a table growing a column rebuilds its cells', () => {
    renderer.render([block({ id: 'a', type: 'table', rows: [[[{ text: 'x' }]]] })]);
    expect(renderer.getView('a')!.cells![0]).toHaveLength(1);

    renderer.render([
      block({ id: 'a', type: 'table', rows: [[[{ text: 'x' }], [{ text: 'y' }]]] }),
    ]);

    expect(renderer.getView('a')!.cells![0]).toHaveLength(2);
  });

  test('a cell edit reuses the cell host', () => {
    renderer.render([
      block({ id: 'a', type: 'table', rows: [[[{ text: 'x' }], [{ text: 'y' }]]] }),
    ]);
    const cell = renderer.getView('a')!.cells![0]![1]!;

    renderer.render([
      block({ id: 'a', type: 'table', rows: [[[{ text: 'x' }], [{ text: 'yy' }]]] }),
    ]);

    expect(renderer.getView('a')!.cells![0]![1]).toBe(cell);
    expect(cell.textContent).toBe('yy');
  });
});

describe('editable state covers every host', () => {
  test('setEditable reaches table cells, not just the first host', () => {
    renderer.render([
      block({ id: 'a', content: [{ text: 'p' }] }),
      block({ id: 't', type: 'table', rows: [[[{ text: 'x' }], [{ text: 'y' }]]] }),
    ]);

    renderer.setEditable(false);

    const hosts = [...root.querySelectorAll<HTMLElement>('.neditor-block__content')];
    expect(hosts.length).toBeGreaterThan(2);
    expect(hosts.every((h) => h.contentEditable === 'false')).toBe(true);
  });

  test('setEditable is reversible', () => {
    renderer.render([block({ id: 'a', content: [{ text: 'p' }] })]);

    renderer.setEditable(false);
    renderer.setEditable(true);

    expect(renderer.getView('a')!.content!.contentEditable).toBe('true');
  });

  test('a block rendered while read-only is created read-only', () => {
    renderer.setEditable(false);

    renderer.render([block({ id: 'a', content: [{ text: 'p' }] })]);

    expect(renderer.getView('a')!.content!.contentEditable).toBe('false');
  });
});

describe('selection marking', () => {
  test('setSelected marks and unmarks block roots', () => {
    renderer.render([block({ id: 'a' }), block({ id: 'b' })]);

    renderer.setSelected(new Set(['a']));
    expect(renderer.getView('a')!.root.dataset.selected).toBe('true');
    expect(renderer.getView('b')!.root.dataset.selected).toBeUndefined();

    renderer.setSelected(new Set());
    expect(renderer.getView('a')!.root.dataset.selected).toBeUndefined();
  });
});

describe('blockIdFromNode', () => {
  test('resolves a node inside a block to that block', () => {
    renderer.render([block({ id: 'a', content: [{ text: 'hello' }] })]);
    const inner = renderer.getView('a')!.content!.firstChild!;

    expect(renderer.blockIdFromNode(inner)).toBe('a');
  });

  test('returns undefined for a node outside any block', () => {
    renderer.render([block({ id: 'a' })]);
    const stray = document.createElement('div');
    document.body.append(stray);

    expect(renderer.blockIdFromNode(stray)).toBeUndefined();
  });
});

describe('destroy', () => {
  test('destroy clears the rendered blocks and the view map', () => {
    renderer.render([block({ id: 'a' }), block({ id: 'b' })]);

    renderer.destroy();

    expect(renderer.getView('a')).toBeUndefined();
    expect(root.querySelectorAll('.neditor-block')).toHaveLength(0);
  });
});
