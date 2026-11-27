// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';

import type { Block } from './index.ts';
import { blockText, createEditor } from './index.ts';
import type { NEditor } from './editor.ts';

/**
 * Round 4 of the 2026-11-06 audit: siblings of round 3's `keepVisible` fix
 * that still hid a visible block inside a collapsed toggle, and the two call
 * sites of it no test pinned. Each scenario is the auditor's literal input.
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

function pasteEvent(html: string, plain = ''): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  const data: Record<string, string> = { 'text/html': html, 'text/plain': plain };
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) => data[type] ?? '',
      types: Object.keys(data),
      items: [],
      files: [],
    },
  });

  return event;
}

function layOut(editor: NEditor): void {
  const views = [...editor.element.querySelectorAll<HTMLElement>('.neditor-block')];
  views.forEach((view, index) => {
    Object.defineProperty(view, 'getBoundingClientRect', {
      value: () => new DOMRect(0, index * 40, 400, 40),
    });
    Object.defineProperty(view, 'offsetTop', { value: index * 40 });
    Object.defineProperty(view, 'offsetHeight', { value: 40 });
  });
}

function pointer(target: EventTarget, type: string, clientY: number): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      pointerType: 'mouse',
      button: 0,
      pointerId: 1,
      clientX: 5,
      clientY,
    }),
  );
}

describe('indenting next to a collapsed toggle opens it rather than hiding the block', () => {
  const afterToggle = (): Block[] => [
    block({ id: 't', type: 'toggle', collapsed: true, content: text('T') }),
    block({ id: 'c', depth: 1, content: text('hidden') }),
    block({ id: 'p', content: text('P') }),
  ];

  test('Tab with the caret in P keeps P on screen, focused, and undoable', () => {
    const editor = mount(afterToggle());
    caret(hostOf(editor, 'p'), 1);

    expect(press(hostOf(editor, 'p'), 'Tab')).toBe(true);
    expect(shape(editor)).toEqual(['toggle:0:T', 'paragraph:1:hidden', 'paragraph:1:P']);
    expect(visibleIds(editor)).toEqual(['t', 'c', 'p']);
    expect(document.activeElement).toBe(hostOf(editor, 'p'));

    press(document.activeElement!, 'z', { metaKey: true, ctrlKey: true });
    expect(shape(editor)).toEqual(['toggle:0:T[c]', 'paragraph:1:hidden', 'paragraph:0:P']);
  });

  test('Tab on a selected P keeps P on screen and selected', () => {
    const editor = mount(afterToggle());
    editor.selectBlocks(['p']);

    expect(press(editor.element, 'Tab')).toBe(true);
    expect(visibleIds(editor)).toContain('p');
    expect(editor.getSelectedBlocks()).toEqual(['p']);
  });

  const nested = (): Block[] => [
    block({ id: 'a', content: text('A') }),
    block({ id: 't', type: 'toggle', depth: 1, collapsed: true, content: text('T') }),
    block({ id: 'c', depth: 2, content: text('hidden') }),
    block({ id: 's', depth: 1, content: text('S') }),
  ];

  test('Shift+Tab on a nested collapsed toggle keeps its next sibling on screen', () => {
    const editor = mount(nested());
    caret(hostOf(editor, 't'), 1);
    press(hostOf(editor, 't'), 'Tab', { shiftKey: true });

    expect(editor.getDocument().blocks.find((b) => b.id === 't')?.depth).toBe(0);
    expect(visibleIds(editor)).toContain('s');
  });

  test('Backspace at the start of a nested collapsed toggle does the same', () => {
    const editor = mount(nested());
    caret(hostOf(editor, 't'), 0);
    press(hostOf(editor, 't'), 'Backspace');

    expect(editor.getDocument().blocks.find((b) => b.id === 't')?.depth).toBe(0);
    expect(visibleIds(editor)).toContain('s');
  });
});

describe('pasting a collapsed toggle never swallows a block the reader could see', () => {
  test('over a selected block whose child follows it', () => {
    const editor = mount([
      block({ id: 'p', content: text('P') }),
      block({ id: 'q', depth: 1, content: text('Q') }),
    ]);
    editor.selectBlocks(['p']);
    editor.element.dispatchEvent(
      pasteEvent('<details><summary>X</summary><p>inner</p></details>', 'X'),
    );

    expect(visibleIds(editor)).toContain('q');
  });

  test('into the text of a block whose child follows it', () => {
    const editor = mount([
      block({ id: 'p', content: text('P') }),
      block({ id: 'q', depth: 1, content: text('Q') }),
    ]);
    caret(hostOf(editor, 'p'), 1);
    hostOf(editor, 'p').dispatchEvent(
      pasteEvent('<p>one</p><details><summary>X</summary><p>inner</p></details>', 'one\nX'),
    );

    expect(visibleIds(editor)).toContain('q');
  });

  test('into an empty block whose child follows it', () => {
    const editor = mount([
      block({ id: 'x', content: text('x') }),
      block({ id: 'a' }),
      block({ id: 'kid', depth: 1, content: text('kid') }),
    ]);
    caret(hostOf(editor, 'a'), 0);
    hostOf(editor, 'a').dispatchEvent(
      pasteEvent('<details><summary>Answer</summary><p>42</p></details>', 'Answer'),
    );

    expect(visibleIds(editor)).toContain('kid');
  });
});

describe('the two keepVisible call sites no test pinned', () => {
  test('dragging P to the top leaves its child on screen', () => {
    const editor = mount([
      block({ id: 't', type: 'toggle', collapsed: true, content: text('T') }),
      block({ id: 'c', depth: 1, content: text('hidden') }),
      block({ id: 'p', content: text('P') }),
      block({ id: 'q', depth: 1, content: text('Q') }),
    ]);
    layOut(editor);
    hostOf(editor, 'p').dispatchEvent(
      new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }),
    );
    const handle = editor.element.querySelector<HTMLElement>('.neditor-gutter__handle')!;
    pointer(handle, 'pointerdown', 45);

    for (const y of [30, 5, 2]) {
      pointer(document, 'pointermove', y);
    }

    pointer(document, 'pointerup', 2);

    expect(editor.getDocument().blocks[0]?.id).toBe('p');
    expect(visibleIds(editor)).toContain('q');
  });

  test('Delete at the end of a collapsed toggle, before a divider with a child', () => {
    const editor = mount([
      block({ id: 't', type: 'toggle', collapsed: true, content: text('T') }),
      block({ id: 'c', depth: 1, content: text('hidden') }),
      block({ id: 'd', type: 'divider' }),
      block({ id: 'x', depth: 1, content: text('X') }),
    ]);
    caret(hostOf(editor, 't'), 1);
    press(hostOf(editor, 't'), 'Delete');

    expect(editor.getDocument().blocks.some((b) => b.id === 'd')).toBe(false);
    expect(visibleIds(editor)).toContain('x');
  });
});
