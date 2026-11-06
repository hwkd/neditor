// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';

import type { Block } from './index.ts';
import { blockText, createEditor } from './index.ts';
import type { NEditor } from './editor.ts';

/**
 * Round 6 of the 2026-11-06 audit: a Tab that restructured a fold nobody could
 * see, a duplicate born hidden, and a paste into a toggle's summary that
 * pulled its hidden answers out. Each scenario is the auditor's literal input.
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

describe('Tab on a collapsed toggle that cannot indent changes nothing', () => {
  const faq = (): Block[] => [
    block({ id: 't', type: 'toggle', collapsed: true, content: text('T') }),
    block({ id: 'c1', depth: 1, content: text('c1') }),
    block({ id: 'c2', depth: 1, content: text('c2') }),
    block({ id: 'c3', depth: 1, content: text('c3') }),
    block({ id: 'z', content: text('Z') }),
  ];
  const unchanged = [
    'toggle:0:T[c]',
    'paragraph:1:c1',
    'paragraph:1:c2',
    'paragraph:1:c3',
    'paragraph:0:Z',
  ];

  test('with the caret in the first block of the document', () => {
    const editor = mount(faq());
    let changes = 0;
    editor.on('change', () => (changes += 1));
    caret(hostOf(editor, 't'), 1);

    expect(press(hostOf(editor, 't'), 'Tab')).toBe(false);
    expect(shape(editor)).toEqual(unchanged);
    expect(changes).toBe(0);
  });

  test('with the toggle selected', () => {
    const editor = mount(faq());
    editor.selectBlocks(['t']);

    expect(press(editor.element, 'Tab')).toBe(false);
    expect(shape(editor)).toEqual(unchanged);
  });

  test('as the first child of a section', () => {
    const editor = mount([
      block({ id: 's', content: text('Section') }),
      block({ id: 'q', type: 'toggle', depth: 1, collapsed: true, content: text('Q') }),
      block({ id: 'a1', depth: 2, content: text('a1') }),
      block({ id: 'a2', depth: 2, content: text('a2') }),
    ]);
    caret(hostOf(editor, 'q'), 1);

    expect(press(hostOf(editor, 'q'), 'Tab')).toBe(false);
    expect(shape(editor)).toEqual([
      'paragraph:0:Section',
      'toggle:1:Q[c]',
      'paragraph:2:a1',
      'paragraph:2:a2',
    ]);
  });
});

describe('a duplicate is on screen', () => {
  test('the copy of a block that followed a collapsed toggle', () => {
    const editor = mount([
      block({ id: 't', type: 'toggle', collapsed: true, content: text('T') }),
      block({ id: 'c', depth: 1, content: text('hidden') }),
      block({ id: 'm', content: text('M') }),
      block({ id: 'x', depth: 1, content: text('X') }),
    ]);
    editor.selectBlocks(['t', 'x']);
    press(editor.element, 'd', { metaKey: true, ctrlKey: true });

    const copies = editor.getDocument().blocks.slice(4);
    const copyOfX = copies.find((b) => blockText(b) === 'X')!;

    expect(visibleIds(editor)).toContain(copyOfX.id);
    expect(editor.getSelectedBlocks()).toContain(copyOfX.id);
  });
});

describe('pasting lines into a toggle summary nests them, as Enter does', () => {
  test('a collapsed toggle keeps its answers and opens on the pasted ones', () => {
    const editor = mount([
      block({ id: 't', type: 'toggle', collapsed: true, content: text('Question') }),
      block({ id: 'a1', depth: 1, content: text('answer 1') }),
      block({ id: 'a2', depth: 1, content: text('answer 2') }),
      block({ id: 'z', content: text('Z') }),
    ]);
    caret(hostOf(editor, 't'), 8);
    hostOf(editor, 't').dispatchEvent(pasteEvent('<p> one</p><p>two</p>', ' one\ntwo'));

    expect(shape(editor)).toEqual([
      'toggle:0:Question one',
      'paragraph:1:two',
      'paragraph:1:answer 1',
      'paragraph:1:answer 2',
      'paragraph:0:Z',
    ]);
    expect(visibleIds(editor)).toContain('a1');
  });
});
