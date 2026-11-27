// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';

import type { Block } from './index.ts';
import { blockText, createEditor } from './index.ts';
import type { NEditor } from './editor.ts';

/**
 * Round 2 of the 2026-11-06 audit: defects in round 1's own fixes, and in the
 * code those fixes touched. Each scenario is the auditor's.
 */

const editors: NEditor[] = [];

afterEach(() => {
  while (editors.length > 0) {
    editors.pop()?.destroy();
  }

  document.body.replaceChildren();
});

let next = 0;

function block(over: Partial<Block>): Block {
  return { id: `r${(next += 1)}`, type: 'paragraph', depth: 0, content: [], ...over } as Block;
}

const text = (value: string): Block['content'] => [{ text: value }];

function mount(blocks: Block[], options: Record<string, unknown> = {}): NEditor {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createEditor({ element: host, doc: { blocks }, ...options });
  editors.push(editor);

  return editor;
}

const hostOf = (editor: NEditor, id: string): HTMLElement =>
  editor.element.querySelector<HTMLElement>(`[data-block-id="${id}"] .neditor-block__content`)!;

function caret(host: HTMLElement, offset: number): void {
  host.focus();
  const node = document.createTreeWalker(host, NodeFilter.SHOW_TEXT).nextNode();
  const range = document.createRange();
  range.setStart(node ?? host, node ? Math.min(offset, node.textContent!.length) : 0);
  range.collapse(true);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
}

function press(target: Element, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);

  return event.defaultPrevented;
}

const shape = (editor: NEditor): string[] =>
  editor
    .getDocument()
    .blocks.map((b) => `${b.type}:${b.depth}:${blockText(b)}${b.collapsed ? '[c]' : ''}`);

const visibleIds = (editor: NEditor): string[] =>
  [...editor.element.querySelectorAll<HTMLElement>('.neditor-block')].map(
    (v) => v.dataset.blockId!,
  );

describe('a table turned into a divider keeps its text', () => {
  test('the cells land in the paragraph the divider opens', () => {
    const editor = mount([
      block({ id: 't', type: 'table', rows: [[text('keep'), text('me')]] } as Partial<Block>),
    ]);
    editor.setBlockType('t', 'divider');

    expect(shape(editor)).toEqual(['divider:0:', 'paragraph:0:keep me']);
  });
});

describe('a Tab that changes nothing moves on from the selected block', () => {
  // The selection used to be cleared with focus still on the root, so the
  // browser's own Tab went from there: to the first block of the document, and
  // for Shift+Tab out of the editor entirely -- not to the next or previous
  // block, as it does from text. happy-dom does not move focus on Tab, so what
  // is pinned is where focus sits when the browser takes over.
  const four = (): NEditor =>
    mount([
      block({ id: 'a', content: text('a') }),
      block({ id: 'b', content: text('b') }),
      block({ id: 'c', content: text('c') }),
    ]);

  test('Tab continues from the last selected block', () => {
    const editor = four();
    // Depth 0 after depth 0 can indent; make it unable to by selecting the first.
    editor.selectBlocks(['a']);

    expect(press(editor.element, 'Tab')).toBe(false);
    expect(document.activeElement).toBe(hostOf(editor, 'a'));
    expect(editor.getSelectedBlocks()).toEqual([]);
  });

  test('Shift+Tab continues from the first selected block', () => {
    const editor = four();
    editor.selectBlocks(['b', 'c']);

    expect(press(editor.element, 'Tab', { shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(hostOf(editor, 'b'));
    expect(editor.getSelectedBlocks()).toEqual([]);
  });
});

describe('focus arriving in a block ends block selection, however it arrives', () => {
  // Focus came back into "alpha" (by Tab from outside, a host's .focus(), an
  // assistive technology) while "beta" stayed selected, and Backspace then
  // deleted beta under a caret sitting in alpha.
  test('a host focusing another block leaves block selection', () => {
    const editor = mount([
      block({ id: 'a', content: text('alpha') }),
      block({ id: 'b', content: text('beta') }),
    ]);
    editor.selectBlocks(['b']);
    hostOf(editor, 'a').focus();

    expect(editor.getSelectedBlocks()).toEqual([]);
    press(hostOf(editor, 'a'), 'Backspace');
    expect(shape(editor)).toEqual(['paragraph:0:alpha', 'paragraph:0:beta']);
  });
});

describe('removing a block never tucks a visible block under a collapsed toggle', () => {
  // [toggle T (collapsed), C hidden, P, Q under P]: removing P left Q right
  // after the toggle's subtree at depth 1 -- a child of the collapsed toggle,
  // out of sight. The toggle opens instead, as it does when Enter gives it a
  // child; Q stays where the reader can see it.
  const doc = (): Block[] => [
    block({ id: 't', type: 'toggle', collapsed: true, content: text('T') }),
    block({ id: 'c', depth: 1, content: text('hidden') }),
    block({ id: 'p', content: text('P') }),
    block({ id: 'q', depth: 1, content: text('Q') }),
  ];

  test('deleting P as a block selection', () => {
    const editor = mount(doc());
    editor.selectBlocks(['p']);
    press(editor.element, 'Backspace');

    expect(visibleIds(editor)).toContain('q');
  });

  test('Backspace at the start of P', () => {
    const editor = mount(doc());
    caret(hostOf(editor, 'p'), 0);
    press(hostOf(editor, 'p'), 'Backspace');

    expect(visibleIds(editor)).toContain('q');
  });

  test('Delete at the end of the toggle', () => {
    const editor = mount(doc());
    caret(hostOf(editor, 't'), 1);
    press(hostOf(editor, 't'), 'Delete');

    expect(visibleIds(editor)).toContain('q');
  });
});

describe('setBlockType to the same type still leaves block selection', () => {
  test('the caret goes to the block, as for any other type', () => {
    const editor = mount([
      block({ id: 'h', type: 'heading1', content: text('H') }),
      block({ id: 'p', content: text('p') }),
    ]);
    editor.selectBlocks(['h', 'p']);
    editor.setBlockType('h', 'heading1');

    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(document.activeElement).toBe(hostOf(editor, 'h'));
  });
});

describe('an undone block selection keeps its anchor', () => {
  test('Shift+Down after undo shrinks it, as before the edit', () => {
    const editor = mount(
      Array.from({ length: 6 }, (_, i) => block({ id: `p${i}`, content: text(`p${i}`) })),
    );
    editor.selectBlocks(['p4']);
    press(editor.element, 'ArrowUp', { shiftKey: true });
    press(editor.element, 'ArrowUp', { shiftKey: true });
    press(editor.element, 'Backspace');
    editor.undo();
    press(editor.element, 'ArrowDown', { shiftKey: true });

    expect(editor.getSelectedBlocks()).toEqual(['p3', 'p4']);
  });
});

describe('a deletion is announced even when the fallback selects a neighbour', () => {
  test('the live region says the block was deleted', () => {
    const editor = mount([
      block({ id: 'p', content: text('p') }),
      block({ id: 'd', type: 'divider' }),
    ]);
    editor.selectBlocks(['p']);
    press(editor.element, 'Backspace');
    const live = document.querySelector('[aria-live]');

    expect(live?.textContent).toMatch(/deleted/i);
  });
});

describe('a composition is judged by what it committed', () => {
  // The comparison read the block captured before the final sync, i.e. the last
  // intermediate candidate: a word committed after a candidate equal to the
  // start text fired no change.
  test('candidates that pass back through the start text still report the word', () => {
    const seen: string[] = [];
    const editor = mount([block({ id: 'a', content: text('abc') })], {
      onChange: (d: { blocks: Block[] }) => seen.push(blockText(d.blocks[0]!)),
    });
    const host = hostOf(editor, 'a');
    host.focus();
    host.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));

    for (const step of ['abcに', 'abc']) {
      host.textContent = step;
      caret(host, step.length);
      host.dispatchEvent(
        new InputEvent('input', { inputType: 'insertCompositionText', bubbles: true }),
      );
    }

    host.textContent = 'abc日本';
    caret(host, 5);
    host.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本' }));

    expect(seen).toEqual(['abc日本']);
  });
});

describe('the portals follow a direction change made while the editor has focus', () => {
  test('opening the slash menu re-reads the direction', () => {
    const editor = mount([block({ id: 'p', content: [] })]);
    const host = hostOf(editor, 'p');
    caret(host, 0);
    const real = window.getComputedStyle.bind(window);
    window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
      const style = real(element, pseudo);
      return element === editor.element
        ? new Proxy(style, { get: (t, k) => (k === 'direction' ? 'rtl' : Reflect.get(t, k)) })
        : style;
    }) as typeof window.getComputedStyle;

    try {
      host.textContent = '/';
      caret(host, 1);
      host.dispatchEvent(
        new InputEvent('input', { inputType: 'insertText', data: '/', bubbles: true }),
      );

      expect(document.querySelector<HTMLElement>('.neditor-slash-menu')!.dir).toBe('rtl');
    } finally {
      window.getComputedStyle = real;
    }
  });
});

describe('the gutter lines up with the text inside a padded mount', () => {
  // The inset is measured from the root's padding edge, so the mount's own
  // padding has to be added; in the demo (20px) the handle sat 20px short.
  test('the root padding is part of the offset', () => {
    const editor = mount([block({ id: 'p', content: text('p') })]);
    const view = editor.element.querySelector<HTMLElement>('[data-block-id="p"]')!;
    const real = window.getComputedStyle.bind(window);
    window.getComputedStyle = ((element: Element) =>
      element === editor.element
        ? ({ paddingInlineStart: '20px', marginInlineStart: '0px' } as CSSStyleDeclaration)
        : element === view
          ? ({ paddingInlineStart: '44px', marginInlineStart: '0px' } as CSSStyleDeclaration)
          : real(element)) as typeof window.getComputedStyle;

    try {
      view
        .querySelector('.neditor-block__content')!
        .dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
      const gutter = editor.element.querySelector<HTMLElement>('.neditor-gutter')!;

      expect(Number.parseFloat(gutter.style.insetInlineStart)).toBe(64);
    } finally {
      window.getComputedStyle = real;
    }
  });
});

describe('editable is false once the editor is destroyed', () => {
  test('an editor destroyed while editable no longer reports itself editable', () => {
    const editor = mount([block({ content: text('a') })]);
    editor.destroy();

    expect(editor.editable).toBe(false);
  });
});
