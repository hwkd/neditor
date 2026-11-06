// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';

import type { Block } from './index.ts';
import { blockText, createEditor } from './index.ts';
import type { NEditor } from './editor.ts';

/**
 * Round 5 of the 2026-11-06 audit: the remaining ways a structural edit hid a
 * block -- or the text and caret the reader was looking at -- inside a
 * collapsed toggle, and a Shift+Tab that was swallowed at depth 0. Each
 * scenario is the auditor's literal input.
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

const textOf = (editor: NEditor, id: string): string =>
  blockText(editor.getDocument().blocks.find((b) => b.id === id)!);

const activeId = (): string | undefined =>
  (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-block-id]')?.dataset
    .blockId;

describe('pasting a collapsed toggle into text keeps the text after the caret, and the caret, on screen', () => {
  test('the tail of the paragraph does not fold into the pasted toggle', () => {
    const editor = mount([
      block({ id: 'p', content: text('abcdef') }),
      block({ id: 'z', content: text('Z') }),
    ]);
    caret(hostOf(editor, 'p'), 3);
    hostOf(editor, 'p').dispatchEvent(
      pasteEvent('<p>one</p><details><summary>X</summary><p>inner</p></details>', 'one\nX'),
    );

    const tail = editor.getDocument().blocks.find((b) => blockText(b).endsWith('def'))!;

    expect(textOf(editor, 'p')).toBe('abcone');
    expect(visibleIds(editor)).toContain(tail.id);
    expect(activeId()).toBe(tail.id);
  });

  test('into an empty last paragraph, focus lands and the next key reaches the editor', () => {
    const editor = mount([block({ id: 'x', content: text('x') }), block({ id: 'a' })]);
    caret(hostOf(editor, 'a'), 0);
    hostOf(editor, 'a').dispatchEvent(
      pasteEvent('<details><summary>Answer</summary><p>42</p></details>', 'Answer'),
    );

    const answer = editor.getDocument().blocks.find((b) => blockText(b) === '42')!;

    expect(visibleIds(editor)).toContain(answer.id);
    expect(activeId()).toBe(answer.id);
  });
});

describe('the other block-set edits keep visible blocks visible', () => {
  test('typing over a selection either side of a collapsed toggle', () => {
    const editor = mount([
      block({ id: 'a', content: text('A') }),
      block({ id: 't', type: 'toggle', collapsed: true, content: text('T') }),
      block({ id: 'c', depth: 1, content: text('hidden') }),
      block({ id: 'C', content: text('C') }),
      block({ id: 'k', depth: 1, content: text('kid') }),
    ]);
    editor.selectBlocks(['a', 'C']);
    press(editor.element, 'q');

    expect(editor.getDocument().blocks.some((b) => b.id === 'C')).toBe(false);
    expect(visibleIds(editor)).toContain('k');
  });

  test('Cmd+D on a collapsed toggle and a later child', () => {
    const editor = mount([
      block({ id: 't', type: 'toggle', collapsed: true, content: text('T') }),
      block({ id: 'c', depth: 1, content: text('hidden') }),
      block({ id: 'm', content: text('M') }),
      block({ id: 'x', depth: 1, content: text('X') }),
      block({ id: 'f', depth: 1, content: text('F') }),
    ]);
    editor.selectBlocks(['t', 'x']);
    press(editor.element, 'd', { metaKey: true, ctrlKey: true });

    expect(editor.getDocument().blocks.length).toBe(8);
    expect(visibleIds(editor)).toContain('f');
  });

  test('a paste that needs two toggles opened opens both', () => {
    const editor = mount([
      block({ id: 'p', content: text('P') }),
      block({ id: 'r', depth: 1, content: text('R') }),
      block({ id: 'q', depth: 2, content: text('Q') }),
    ]);
    editor.selectBlocks(['p', 'r']);
    editor.element.dispatchEvent(
      pasteEvent(
        '<details><summary>O</summary><details><summary>I</summary><p>x</p></details></details>',
        'O',
      ),
    );

    expect(visibleIds(editor)).toContain('q');
  });
});

describe('Shift+Tab on a collapsed toggle at depth 0 is the way out, not an edit', () => {
  const doc = (): Block[] => [
    block({ id: 'a', content: text('A') }),
    block({ id: 't', type: 'toggle', collapsed: true, content: text('T') }),
    block({ id: 'c', depth: 1, content: text('hidden') }),
    block({ id: 'g', depth: 2, content: text('grand') }),
  ];
  const unchanged = ['paragraph:0:A', 'toggle:0:T[c]', 'paragraph:1:hidden', 'paragraph:2:grand'];

  test('with the caret in the toggle', () => {
    const editor = mount(doc());
    caret(hostOf(editor, 't'), 1);

    expect(press(hostOf(editor, 't'), 'Tab', { shiftKey: true })).toBe(false);
    expect(shape(editor)).toEqual(unchanged);
  });

  test('with the toggle selected', () => {
    const editor = mount(doc());
    editor.selectBlocks(['t']);

    expect(press(editor.element, 'Tab', { shiftKey: true })).toBe(false);
    expect(shape(editor)).toEqual(unchanged);
  });
});
