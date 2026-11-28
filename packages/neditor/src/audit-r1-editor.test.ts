// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { Block } from './index.ts';
import { createEditor } from './index.ts';
import type { NEditor } from './editor.ts';
import { setSelectionRange } from './view/selection.ts';

/**
 * Defects the 28 November whole-product audit (round 1) found in the editor's
 * keys, events, drop and viewport listening. Each test is the finding's own
 * scenario.
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

function press(target: Element, key: string): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);

  return event.defaultPrevented;
}

function drop(target: EventTarget, html: string, plain = ''): DragEvent {
  const data = new DataTransfer();
  data.setData('text/html', html);
  data.setData('text/plain', plain);
  const event = new DragEvent('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: data });
  target.dispatchEvent(event);

  return event;
}

describe('Delete in an empty paragraph', () => {
  // R1-TYPING P3-1: the next block merged into the empty paragraph and took
  // its type, so a code block became the paragraph "let a".
  test('removes the empty line and leaves a code block a code block', () => {
    const editor = mount([
      block({ id: 'e', content: [] }),
      block({ id: 'c', type: 'code', content: text('let a') }),
    ]);

    editor.focus('e', 0);
    press(hostOf(editor, 'e'), 'Delete');

    const blocks = editor.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['code']);
    expect(blocks[0]?.content).toEqual(text('let a'));
    expect(editor.getSelectionState()?.blockId).toBe('c');
  });

  test('and a heading stays a heading; one undo restores both', () => {
    const editor = mount([
      block({ id: 'e', content: [] }),
      block({ id: 'h', type: 'heading1', content: text('Title') }),
    ]);

    editor.focus('e', 0);
    press(hostOf(editor, 'e'), 'Delete');
    expect(editor.getDocument().blocks.map((b) => b.type)).toEqual(['heading1']);

    editor.undo();
    expect(editor.getDocument().blocks.map((b) => b.id)).toEqual(['e', 'h']);
  });

  test('before a paragraph it still merges', () => {
    const editor = mount([
      block({ id: 'e', content: [] }),
      block({ id: 'p', content: text('after') }),
    ]);

    editor.focus('e', 0);
    press(hostOf(editor, 'e'), 'Delete');

    expect(editor.getDocument().blocks.map((b) => b.id)).toEqual(['e']);
    expect(editor.getDocument().blocks[0]?.content).toEqual(text('after'));
  });
});

describe('events that report no change', () => {
  // R1-API P3-1.
  test('clearHistory() on an empty history emits no `history` event', () => {
    const editor = mount([block({ content: text('a') })]);
    const seen = vi.fn<() => void>();
    editor.on('history', seen);

    editor.clearHistory();
    expect(seen).not.toHaveBeenCalled();
  });

  test('clearHistory() with undo steps still emits once', () => {
    const editor = mount([block({ id: 'a', content: text('a') })]);
    editor.setBlockType('a', 'heading1');
    const seen = vi.fn<() => void>();
    editor.on('history', seen);

    editor.clearHistory();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(editor.canUndo).toBe(false);
  });

  test('selectBlocks() with the set already selected emits no `blockselection`', () => {
    const editor = mount([block({ id: 'a', content: text('a') }), block({ id: 'b' })]);
    editor.selectBlocks(['a', 'b']);
    const seen = vi.fn<() => void>();
    editor.on('blockselection', seen);

    editor.selectBlocks(['b', 'a']);
    expect(seen).not.toHaveBeenCalled();

    editor.selectBlocks(['a']);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  // R2 VE-1: the early return that silenced the event also skipped taking
  // focus back, so a page button calling this twice kept focus and the next
  // Backspace deleted nothing.
  test('selectBlocks() with the same set from a page button still gives the root focus', () => {
    const editor = mount([block({ id: 'a', content: text('a') }), block({ id: 'b' })]);
    const root = document.querySelector('.neditor') as HTMLElement;
    const button = document.createElement('button');
    document.body.append(button);

    editor.selectBlocks(['a', 'b']);
    button.focus();
    expect(document.activeElement).toBe(button);

    editor.selectBlocks(['a', 'b']);
    expect(document.activeElement).toBe(root);
    button.remove();
  });
});

describe('the visual viewport', () => {
  // R1-UX P3-5: a phone keyboard changes only the visual viewport.
  test('is listened to while mounted and let go of on destroy', () => {
    const viewport = new EventTarget();
    const add = vi.spyOn(viewport, 'addEventListener');
    const remove = vi.spyOn(viewport, 'removeEventListener');
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });

    try {
      const editor = mount([block({ content: text('a') })]);
      expect(add.mock.calls.map((call) => call[0]).sort()).toEqual(['resize', 'scroll']);

      editor.destroy();
      expect(remove.mock.calls.map((call) => call[0]).sort()).toEqual(['resize', 'scroll']);
    } finally {
      Reflect.deleteProperty(window, 'visualViewport');
    }
  });
});

describe('a drop on a block with no text host', () => {
  // R1-CLIPBOARD P3: cancelled with nothing inserted.
  test('on a divider inserts the payload after it', () => {
    const editor = mount([
      block({ id: 'p', content: text('before') }),
      block({ id: 'd', type: 'divider' }),
    ]);
    const divider = editor.element.querySelector('[data-block-id="d"]')!;

    const event = drop(divider, '<p>dropped</p>', 'dropped');
    expect(event.defaultPrevented).toBe(true);

    const blocks = editor.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'divider', 'paragraph']);
    expect(blocks[2]?.content).toEqual(text('dropped'));
  });

  test("on an image's picture inserts it after the image, in one undo step", () => {
    const editor = mount([
      block({ id: 'i', type: 'image', src: 'https://example.test/a.png', alt: 'a' }),
    ]);
    const picture = editor.element.querySelector('[data-block-id="i"] .neditor-image__trigger')!;

    drop(picture, '<p>dropped</p>', 'dropped');
    expect(editor.getDocument().blocks.map((b) => b.type)).toEqual(['image', 'paragraph']);

    editor.undo();
    expect(editor.getDocument().blocks.map((b) => b.type)).toEqual(['image']);
  });

  test('read-only inserts nothing', () => {
    const editor = mount([block({ id: 'd', type: 'divider' })], { editable: false });
    const divider = editor.element.querySelector('[data-block-id="d"]')!;

    const event = drop(divider, '<p>dropped</p>', 'dropped');
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getDocument().blocks).toHaveLength(1);
  });
});

describe('a drag over a block with no text host', () => {
  function dragOver(target: Element): boolean {
    const event = new Event('dragover', { bubbles: true, cancelable: true });
    target.dispatchEvent(event);

    return event.defaultPrevented;
  }

  // The browser delivers a drop only where a dragover was cancelled.
  test('is accepted over a divider and a picture, not over text or read-only', () => {
    const doc = [
      block({ id: 'p', content: text('text') }),
      block({ id: 'd', type: 'divider' }),
      block({ id: 'i', type: 'image', src: 'https://example.test/a.png', alt: 'a' }),
    ];
    const editor = mount(doc);

    expect(dragOver(editor.element.querySelector('[data-block-id="d"] hr')!)).toBe(true);
    expect(dragOver(editor.element.querySelector('.neditor-image__trigger')!)).toBe(true);
    expect(dragOver(hostOf(editor, 'p'))).toBe(false);

    editor.setEditable(false);
    expect(dragOver(editor.element.querySelector('[data-block-id="d"] hr')!)).toBe(false);
  });
});

describe('two editors on one element', () => {
  // R1-API P3-5.
  test('the second mount throws, and a mount after destroy works', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const first = createEditor({ element: host });
    editors.push(first);

    expect(() => createEditor({ element: host })).toThrow(/already mounted/);
    expect(host.querySelectorAll('.neditor-block')).toHaveLength(1);

    first.destroy();
    const again = createEditor({ element: host });
    editors.push(again);
    expect(host.querySelectorAll('.neditor-block')).toHaveLength(1);
  });
});

describe('marks at a caret', () => {
  // R1-TYPING P3-5: Chromium kept armed marks after a Backspace moved the
  // caret, because no `selectionchange` reached the editor before the read.
  test('armed marks answer for their own caret only, read at once', () => {
    const editor = mount([block({ id: 'a', content: text('abcd') })]);
    editor.focus('a', 2);
    editor.toggleMark('bold');
    expect(editor.getSelectionState()?.marks).toEqual(['bold']);

    // The caret moves and no event is delivered before the read.
    setSelectionRange(hostOf(editor, 'a'), 1, 1);
    expect(editor.getSelectionState()?.marks).toEqual([]);
  });
});
