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

describe('the toggle chevron', () => {
  const chevron = (id: string) =>
    renderer.getView(id)!.root.querySelector<HTMLElement>('.neditor-block__chevron')!;

  test('reports its state with aria-expanded', () => {
    renderer.render([block({ id: 'a', type: 'toggle', collapsed: true })]);
    expect(chevron('a').getAttribute('aria-expanded')).toBe('false');

    renderer.render([block({ id: 'a', type: 'toggle', collapsed: false })]);
    expect(chevron('a').getAttribute('aria-expanded')).toBe('true');
  });

  test('does not point aria-controls at something that never hides', () => {
    // What expanding reveals is the toggle's children, and collapsing removes
    // those from the document entirely — so there is nothing to reference. The
    // id this used to name was the toggle's own text host, which is present and
    // visible in both states: following the reference reported the opposite of
    // what aria-expanded said.
    renderer.render([
      block({ id: 'a', type: 'toggle', collapsed: true, content: [{ text: 'h' }] }),
    ]);

    const controls = chevron('a').getAttribute('aria-controls');
    const host = renderer.getView('a')!.content!;

    expect(controls).not.toBe(host.id);
    expect(controls === null || root.querySelector(`#${controls}`) !== host).toBe(true);
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

  test('ignores a matching data-block-id outside this renderer', () => {
    renderer.render([block({ id: 'a' })]);
    // The embedding page is free to use the attribute for its own purposes, and
    // free to collide with an id this renderer happens to hold.
    const stray = document.createElement('div');
    stray.dataset.blockId = 'a';
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

describe('block selection is not announced through a prohibited attribute', () => {
  test('no aria-selected is written onto a role-less block', () => {
    renderer.render([block({ id: 'a' }), block({ id: 'b' })]);

    renderer.setSelected(new Set(['a']));

    // aria-selected is prohibited on role=generic, so browsers drop it; writing
    // it left every block carrying aria-selected="false" and told AT nothing.
    // The live region carries the announcement instead.
    for (const id of ['a', 'b']) {
      expect(renderer.getView(id)!.root.hasAttribute('aria-selected')).toBe(false);
    }
  });

  test('the data attribute the styles key on is still written', () => {
    renderer.render([block({ id: 'a' })]);

    renderer.setSelected(new Set(['a']));

    expect(renderer.getView('a')!.root.dataset.selected).toBe('true');
  });
});

describe('removing a block leaves the others where they are', () => {
  /**
   * Positioning compares each view against `root.children.item(index)`, and the
   * prune loop that removes dead views used to run *after* it. So while a
   * removed block's element was still sitting in the DOM, every index after it
   * was shifted, every later view failed the comparison, and every one was
   * re-inserted. `insertBefore` moves a node, and moving the node a caret is in
   * blurs it -- so deleting one block dropped the caret out of a block that had
   * not changed at all, in the one method written to protect it.
   */
  const moved = (before: () => void, blocks: Block[]): string[] => {
    const seen: string[] = [];
    const original = root.insertBefore.bind(root);
    before();
    root.insertBefore = ((node: Node, ref: Node | null) => {
      const id = (node as HTMLElement).dataset?.blockId;

      if (id) {
        seen.push(id);
      }

      return original(node, ref);
    }) as typeof root.insertBefore;
    renderer.render(blocks);
    root.insertBefore = original;

    return seen;
  };

  const three = [
    block({ id: 'a', content: [{ text: 'one' }] }),
    block({ id: 'b', content: [{ text: 'two' }] }),
    block({ id: 'c', content: [{ text: 'three' }] }),
  ];

  test('a survivor after the removal is not re-inserted', () => {
    const touched = moved(() => renderer.render(three), [three[0]!, three[2]!]);

    expect(touched, 'c did not move relative to a, so it must not be touched').toEqual([]);
    expect(rendered()).toEqual(['a', 'c']);
  });

  test('and it keeps the caret', () => {
    renderer.render(three);
    const host = renderer.getView('c')!.content!;
    host.focus();

    expect(document.activeElement).toBe(host);

    renderer.render([three[0]!, three[2]!]);

    expect(document.activeElement, 'the caret must survive a removal above it').toBe(host);
  });

  test('a genuine reorder does still move the block', () => {
    const touched = moved(() => renderer.render(three), [three[2]!, three[0]!, three[1]!]);

    expect(touched).toContain('c');
    expect(rendered()).toEqual(['c', 'a', 'b']);
  });
});

describe('a reorder moves the other blocks around the one holding focus', () => {
  /*
   * R13-KEY-2. A node is moved by taking it out and putting it back, and taking
   * out the element focus is in blurs it: a peer's `setDocument` that moved the
   * reader's block, or moved a block from above it to below (which positioning
   * from the top does by moving the reader's block up past it), left focus on
   * `<body>` and the next keys typed nothing. happy-dom keeps focus on a node
   * that is taken out and put back, so what is pinned here is the cause: the
   * focused block's element is never removed from the root. The keys landing
   * is pinned in every engine by `api.spec.ts` AP12.
   */
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const blocksIn = (order: readonly string[]): Block[] =>
    order.map((id) => block({ id, content: [{ text: id.toUpperCase() }] }));

  /** Every element taken out of the root while `act` runs. */
  const detached = (act: () => void): Node[] => {
    const seen: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        seen.push(...record.removedNodes);
      }
    });
    observer.observe(root, { childList: true });
    act();
    seen.push(...observer.takeRecords().flatMap((record) => [...record.removedNodes]));
    observer.disconnect();

    return seen;
  };

  /** Every order of `items`. */
  const permutations = <T>(items: readonly T[]): T[][] =>
    items.length <= 1
      ? [[...items]]
      : items.flatMap((item, index) =>
          permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
            item,
            ...rest,
          ]),
        );

  test('the literal case: c moved, and a moved from above it to below it', () => {
    for (const order of [
      ['b', 'c', 'a', 'd', 'e'],
      ['b', 'c', 'd', 'e', 'a'],
      ['c', 'a', 'b', 'd', 'e'],
    ]) {
      renderer.render(blocksIn(ids));
      const host = renderer.getView('c')!.content!;
      host.focus();

      const removed = detached(() => renderer.render(blocksIn(order)));

      expect(rendered()).toEqual(order);
      expect(removed, `${order.join('')}: the focused block was taken out`).not.toContain(
        renderer.getView('c')!.root,
      );
      expect(document.activeElement).toBe(host);
    }
  });

  test('from every order to every order, with focus in each block', () => {
    const orders = permutations(ids);
    // Every target order from two starting orders, focus in every block:
    // 2 × 120 × 5 renders, each checked for the order and the pinned element.
    for (const start of [ids, ['e', 'c', 'a', 'd', 'b']]) {
      for (const order of orders) {
        for (const focused of ids) {
          renderer.render(blocksIn(start));
          const pinned = renderer.getView(focused)!.root;
          renderer.getView(focused)!.content!.focus();

          const removed = detached(() => renderer.render(blocksIn(order)));

          expect(rendered()).toEqual(order);
          expect(
            removed.includes(pinned),
            `${start.join('')} → ${order.join('')} (${focused})`,
          ).toBe(false);
        }
      }
    }
  });

  test('with blocks added and removed in the same render', () => {
    renderer.render(blocksIn(ids));
    const pinned = renderer.getView('c')!.root;
    renderer.getView('c')!.content!.focus();

    const removed = detached(() => renderer.render(blocksIn(['x', 'e', 'c', 'y', 'a'])));

    expect(rendered()).toEqual(['x', 'e', 'c', 'y', 'a']);
    expect(removed).not.toContain(pinned);
  });

  test('focus on a control inside a block pins its block too', () => {
    const todo = (id: string): Block => block({ id, type: 'todo', checked: false });
    renderer.render([todo('t1'), todo('t2'), todo('t3')]);
    const pinned = renderer.getView('t3')!.root;
    const checkbox = pinned.querySelector<HTMLElement>('.neditor-block__checkbox')!;
    checkbox.focus();
    expect(document.activeElement).toBe(checkbox);

    const removed = detached(() => renderer.render([todo('t3'), todo('t1'), todo('t2')]));

    expect(rendered()).toEqual(['t3', 't1', 't2']);
    expect(removed).not.toContain(pinned);
    expect(document.activeElement).toBe(checkbox);
  });

  test('a table cell holding focus pins its table', () => {
    const table = block({
      id: 'tb',
      type: 'table',
      rows: [
        [[{ text: 'h' }], [{ text: 'i' }]],
        [[{ text: 'x' }], [{ text: 'y' }]],
      ],
    });
    renderer.render([...blocksIn(['a', 'b']), table]);
    const pinned = renderer.getView('tb')!.root;
    renderer.getView('tb')!.cells![1]![1]!.focus();

    const removed = detached(() => renderer.render([table, ...blocksIn(['a', 'b'])]));

    expect(rendered()).toEqual(['tb', 'a', 'b']);
    expect(removed).not.toContain(pinned);
  });

  test('read through the shadow root of a shadow mount', () => {
    // `document.activeElement` is only the shadow host there.
    document.body.replaceChildren();
    const outer = document.createElement('div');
    document.body.append(outer);
    const shadow = outer.attachShadow({ mode: 'open' });
    root = document.createElement('div');
    shadow.append(root);
    renderer = new Renderer(root, hooks, DEFAULT_LABELS);
    renderer.render(blocksIn(ids));
    const pinned = renderer.getView('c')!.root;
    renderer.getView('c')!.content!.focus();
    expect(shadow.activeElement).toBe(renderer.getView('c')!.content);

    const removed = detached(() => renderer.render(blocksIn(['c', 'a', 'b', 'd', 'e'])));

    expect(rendered()).toEqual(['c', 'a', 'b', 'd', 'e']);
    expect(removed).not.toContain(pinned);
  });

  test('a move that does not reach the focused block makes the same moves as with no focus', () => {
    // Positioning from the top never moves the focused block in these, so the
    // pinned order must not move anything the plain one did not.
    for (const order of [
      ['e', 'a', 'b', 'c', 'd'],
      ['a', 'b', 'd', 'c', 'e'],
      ['a', 'b', 'c', 'e', 'd'],
    ]) {
      const moves = (focus: boolean): string[] => {
        renderer.render(blocksIn(ids));

        if (focus) {
          renderer.getView('c')!.content!.focus();
        } else {
          (document.activeElement as HTMLElement | null)?.blur();
        }

        const seen: string[] = [];
        const original = root.insertBefore.bind(root);
        root.insertBefore = ((node: Node, ref: Node | null) => {
          seen.push((node as HTMLElement).dataset?.blockId ?? '?');
          return original(node, ref);
        }) as typeof root.insertBefore;
        renderer.render(blocksIn(order));
        root.insertBefore = original;

        return seen;
      };

      expect({ order, moves: moves(true) }).toEqual({ order, moves: moves(false) });
    }
  });

  test('with focus on a page button, the block the reader’s range is in stays', () => {
    // A host's own toolbar button holds focus while it acts on the range
    // (`api.spec.ts` AP11); taken out and put back, the block lost it.
    renderer.render(blocksIn(ids));
    const button = document.createElement('button');
    document.body.append(button);
    const text = renderer.getView('c')!.content!.firstChild!;
    document.getSelection()!.setBaseAndExtent(text, 0, text, 1);
    button.focus();
    expect(document.activeElement).toBe(button);
    const pinned = renderer.getView('c')!.root;

    const removed = detached(() => renderer.render(blocksIn(['c', 'a', 'b', 'd', 'e'])));

    expect(rendered()).toEqual(['c', 'a', 'b', 'd', 'e']);
    expect(removed).not.toContain(pinned);
    expect(document.getSelection()!.anchorNode).toBe(text);
  });

  test('the root itself holding focus (block selection) pins nothing', () => {
    // Every pin reaches the same order, so the order alone cannot tell; the
    // moves can. From a-e to b-e,a the plain top-down loop moves b, c, d and e
    // in front of a; pinning any of b, c, d or e would move fewer.
    const order = ['b', 'c', 'd', 'e', 'a'];
    const moves = (rootFocused: boolean): string[] => {
      root.tabIndex = -1;
      renderer.render(blocksIn(ids));

      if (rootFocused) {
        root.focus();
      } else {
        (document.activeElement as HTMLElement | null)?.blur();
      }

      const seen: string[] = [];
      const original = root.insertBefore.bind(root);
      root.insertBefore = ((node: Node, ref: Node | null) => {
        seen.push((node as HTMLElement).dataset?.blockId ?? '?');
        return original(node, ref);
      }) as typeof root.insertBefore;
      renderer.render(blocksIn(order));
      root.insertBefore = original;

      expect(rendered()).toEqual(order);

      return seen;
    };

    const withRoot = moves(true);
    expect(document.activeElement).toBe(root);
    expect(withRoot).toEqual(moves(false));
    expect(moves(false)).toEqual(['b', 'c', 'd', 'e']);
  });

  test('the other children of the root stay after the blocks', () => {
    // The editor keeps its live region, gutter and drop indicator in the root
    // after the blocks; moving the blocks around a pinned one must not leave
    // one of them in between.
    renderer.render(blocksIn(ids));
    const extra = document.createElement('span');
    root.append(extra);
    renderer.getView('a')!.content!.focus();

    renderer.render(blocksIn(['b', 'c', 'd', 'e', 'a']));

    expect(
      [...root.children].map((child) => (child as HTMLElement).dataset.blockId ?? 'extra'),
    ).toEqual(['b', 'c', 'd', 'e', 'a', 'extra']);
  });
});

describe('a read-only empty image offers nothing to author', () => {
  /*
   * An image block with no source draws an "Add an image" button. Disabling it
   * in a read-only view stopped it acting, but it was still drawn and still
   * exposed as a button named "Add an image" -- an authoring prompt in a view
   * that takes no authoring, which is what the placeholders were already
   * withheld for. Read-only, the empty figure is drawn with no control at all.
   */
  const empty = (): Block => block({ id: 'im', type: 'image', src: '', alt: '' });
  const add = (): HTMLButtonElement | null =>
    root.querySelector<HTMLButtonElement>('.neditor-image__placeholder');

  test('rendered read-only, the empty figure has no button in it', () => {
    renderer.setEditable(false);

    renderer.render([empty()]);

    const figure = renderer.getView('im')!.root.querySelector('figure');
    expect(figure).not.toBeNull();
    expect(figure!.querySelector('button')).toBeNull();
  });

  test('turning read-only takes the button away, and turning back restores it', () => {
    renderer.render([empty()]);
    expect(add()).not.toBeNull();

    renderer.setEditable(false);
    expect(add()).toBeNull();

    renderer.setEditable(true);
    expect(add()).not.toBeNull();
    expect(add()!.disabled).toBe(false);
    expect(add()!.textContent).toBe(DEFAULT_LABELS.imageAdd);
  });

  test('the restored button sits before the caption and still opens the editor', () => {
    const opened: [string, HTMLElement][] = [];
    renderer = new Renderer(
      root,
      { ...hooks, onEditImage: (id, anchor) => opened.push([id, anchor]) },
      DEFAULT_LABELS,
    );
    renderer.setEditable(false);
    renderer.render([empty()]);

    renderer.setEditable(true);
    add()!.click();

    expect(add()!.nextElementSibling?.tagName).toBe('FIGCAPTION');
    expect(opened).toEqual([['im', add()]]);
  });

  test('a re-render while read-only does not bring it back', () => {
    renderer.render([empty()]);
    renderer.setEditable(false);

    renderer.render([{ ...empty(), content: [{ text: 'caption' }] }]);

    expect(add()).toBeNull();
  });

  test('an image losing its source while read-only is rebuilt without one', () => {
    renderer.setEditable(false);
    renderer.render([block({ id: 'im', type: 'image', src: 'https://a.test/x.png' })]);

    renderer.render([empty()]);

    expect(renderer.getView('im')!.root.querySelector('img')).toBeNull();
    expect(add()).toBeNull();
  });

  test('flipping twice does not draw two', () => {
    renderer.render([empty()]);

    renderer.setEditable(true);
    renderer.setEditable(false);
    renderer.setEditable(true);
    renderer.setEditable(true);

    expect(root.querySelectorAll('.neditor-image__placeholder')).toHaveLength(1);
  });
});
