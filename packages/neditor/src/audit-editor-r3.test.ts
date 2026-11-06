// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';

import type { Block } from './index.ts';
import { blockText, createEditor } from './index.ts';
import type { NEditor } from './editor.ts';

/**
 * Round 3 of the 2026-11-06 audit: defects in round 2's fixes and their
 * siblings. Each scenario is the auditor's.
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
  return { id: `s${(next += 1)}`, type: 'paragraph', depth: 0, content: [], ...over } as Block;
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

const live = (): string => document.querySelector('[aria-live]')?.textContent ?? '';

describe('a long press takes the text side back as well as selecting the block', () => {
  // Chromium's own long press focuses the host and selects a word after the
  // editor has selected the block; the exemption kept the block selection but
  // left focus and the word selection where the browser put them, so a soft
  // keyboard's insertText replaced the word -- both modes live at once.
  test('focus arriving during the press goes back to the root, with no text range', async () => {
    const editor = mount([block({ id: 'a', content: text('Marks compose') })]);
    const host = hostOf(editor, 'a');
    host.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerType: 'touch',
        button: 0,
        clientX: 5,
        clientY: 5,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 650));

    expect(editor.getSelectedBlocks()).toEqual(['a']);
    caret(host, 0); // the browser's long-press focus and word selection

    expect(editor.getSelectedBlocks()).toEqual(['a']);
    expect(document.activeElement).toBe(editor.element);
    expect(getSelection()!.rangeCount === 0 || String(getSelection()) === '').toBe(true);
  });
});

describe('a finished drag leaves focus where block selection keeps it', () => {
  // The press focused the handle button, and the swallowed click was what
  // would have focused the root: Escape then could not leave and Cmd+Z could
  // not undo the move.
  test('after a drag, focus is on the root and Cmd+Z undoes the move', () => {
    const editor = mount([
      block({ id: 'a', content: text('a') }),
      block({ id: 'b', content: text('b') }),
      block({ id: 'c', content: text('c') }),
    ]);
    const views = [...editor.element.querySelectorAll<HTMLElement>('.neditor-block')];
    views.forEach((view, index) => {
      Object.defineProperty(view, 'getBoundingClientRect', {
        value: () => new DOMRect(0, index * 40, 400, 40),
      });
      Object.defineProperty(view, 'offsetTop', { value: index * 40 });
      Object.defineProperty(view, 'offsetHeight', { value: 40 });
    });
    views[0]!
      .querySelector('.neditor-block__content')!
      .dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    const handle = editor.element.querySelector<HTMLElement>('.neditor-gutter__handle')!;
    handle.focus();
    handle.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerType: 'mouse',
        button: 0,
        pointerId: 1,
        clientX: 5,
        clientY: 5,
      }),
    );
    document.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerType: 'mouse',
        pointerId: 1,
        clientX: 5,
        clientY: 100,
      }),
    );
    document.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerType: 'mouse',
        pointerId: 1,
        clientX: 5,
        clientY: 118,
      }),
    );
    document.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        pointerType: 'mouse',
        pointerId: 1,
        clientX: 5,
        clientY: 118,
      }),
    );
    const moved = editor.getDocument().blocks.map((b) => b.id);

    expect(moved).not.toEqual(['a', 'b', 'c']);
    expect(document.activeElement).toBe(editor.element);
    press(document.activeElement!, 'z', { metaKey: true, ctrlKey: true });
    expect(editor.getDocument().blocks.map((b) => b.id)).toEqual(['a', 'b', 'c']);
  });

  test('Escape leaves even if focus was left on a control inside the editor', () => {
    const editor = mount([block({ id: 'a', content: text('a') })]);
    editor.selectBlocks(['a']);
    const handle = editor.element.querySelector<HTMLElement>('.neditor-gutter__handle')!;
    handle.focus();
    press(handle, 'Escape');

    expect(editor.element.contains(document.activeElement)).toBe(false);
  });
});

describe('moving a block never tucks a visible block under a collapsed toggle', () => {
  const doc = (): Block[] => [
    block({ id: 'a', content: text('A') }),
    block({ id: 't', type: 'toggle', collapsed: true, content: text('T') }),
    block({ id: 'c', depth: 1, content: text('hidden') }),
    block({ id: 'p', content: text('P') }),
    block({ id: 'q', depth: 1, content: text('Q') }),
  ];

  test('Cmd+Shift+Up on P', () => {
    const editor = mount(doc());
    editor.selectBlocks(['p']);
    press(editor.element, 'ArrowUp', { shiftKey: true, metaKey: true, ctrlKey: true });

    expect(visibleIds(editor)).toContain('q');
  });

  test('Cmd+Shift+Down on P', () => {
    const editor = mount([...doc(), block({ id: 'z', content: text('Z') })]);
    editor.selectBlocks(['p']);
    press(editor.element, 'ArrowDown', { shiftKey: true, metaKey: true, ctrlKey: true });

    expect(visibleIds(editor)).toContain('q');
  });
});

describe('a no-op Tab from a selected divider or table moves on from the right place', () => {
  test('Tab from a selected divider continues from the block before it', () => {
    const editor = mount([
      block({ id: 'a', content: text('a') }),
      block({ id: 'b', content: text('b') }),
      block({ id: 'c', depth: 1, content: text('c') }),
      block({ id: 'd', type: 'divider', depth: 2 }),
      block({ id: 'e', content: text('e') }),
    ]);
    editor.selectBlocks(['d']);

    expect(press(editor.element, 'Tab')).toBe(false);
    expect(document.activeElement).toBe(hostOf(editor, 'c'));
  });

  test('Shift+Tab from a selected divider continues from the block after it', () => {
    const editor = mount([
      block({ id: 'a', content: text('a') }),
      block({ id: 'd', type: 'divider' }),
      block({ id: 'e', content: text('e') }),
    ]);
    editor.selectBlocks(['d']);

    expect(press(editor.element, 'Tab', { shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(hostOf(editor, 'e'));
  });

  test('Tab from a selected table continues from its last cell', () => {
    const editor = mount([
      block({
        id: 't',
        type: 'table',
        rows: [
          [text('1'), text('2')],
          [text('3'), text('4')],
        ],
      } as Partial<Block>),
      block({ id: 'p', content: text('p') }),
    ]);
    editor.selectBlocks(['t']);

    expect(press(editor.element, 'Tab')).toBe(false);
    expect(document.activeElement).toBe(editor.element.querySelector('[data-cell="1:1"]'));
  });
});

describe('flattening a table rehouses text, and invents none', () => {
  const empty = (): Block['content'] => [];

  test('an empty table becomes an empty paragraph', () => {
    const editor = mount([
      block({
        id: 't',
        type: 'table',
        rows: [
          [empty(), empty()],
          [empty(), empty()],
        ],
      } as Partial<Block>),
    ]);
    editor.setBlockType('t', 'paragraph');

    expect(editor.getDocument().blocks[0]!.content).toEqual([]);
  });

  test('an empty table becomes a divider with no stray paragraph', () => {
    const editor = mount([
      block({ id: 't', type: 'table', rows: [[empty(), empty()]] } as Partial<Block>),
    ]);
    editor.setBlockType('t', 'divider');

    expect(shape(editor)).toEqual(['divider:0:']);
  });

  test('empty cells add no separators', () => {
    const editor = mount([
      block({
        id: 't',
        type: 'table',
        rows: [
          [text('a'), empty()],
          [empty(), empty()],
          [empty(), text('b')],
        ],
      } as Partial<Block>),
    ]);
    editor.setBlockType('t', 'paragraph');

    expect(blockText(editor.getDocument().blocks[0]!)).toBe('a\nb');
  });
});

describe('a delete that falls back to selecting a neighbour says both', () => {
  test('the live region names the deletion and the new selection', () => {
    const editor = mount([
      block({ id: 'p', content: text('p') }),
      block({ id: 'd', type: 'divider' }),
    ]);
    editor.selectBlocks(['p']);
    press(editor.element, 'Backspace');

    expect(live()).toMatch(/deleted/i);
    expect(live()).toMatch(/selected/i);
  });
});
