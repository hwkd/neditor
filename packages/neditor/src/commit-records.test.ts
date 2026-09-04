// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';

import type { Block } from './index.ts';
import { blockText, createEditor, sameBlocks } from './index.ts';
import type { NEditor } from './editor.ts';

/**
 * One edit, one history entry — and no entry at all for an edit that never
 * happened.
 *
 * Every structural operation in the model is pure and returns a *fresh* array
 * even when it changed nothing, so the array's identity tells `#commit` nothing
 * about whether the document moved. Two failures followed from that. A move
 * against the edge of the document banked a full undo step and fired `change`,
 * so a held Cmd+Shift+Arrow evicted the user's real history within seconds and
 * an autosave listener wrote an identical revision each repeat. And a caller
 * that recorded its own snapshot before committing pushed the same document
 * twice, which cost the user a second Ctrl+Z that visibly did nothing.
 *
 * The rule these tests hold to: `#commit` is the only recorder on the
 * structural path, it takes the run key from its caller rather than being
 * front-run, and it records nothing when the blocks it was handed are the
 * blocks it already had.
 */

const editors: NEditor[] = [];

afterEach(() => {
  while (editors.length > 0) {
    editors.pop()?.destroy();
  }

  document.body.replaceChildren();
});

function block(over: Partial<Block>): Block {
  return {
    id: Math.random().toString(36).slice(2),
    type: 'paragraph',
    depth: 0,
    content: [],
    ...over,
  } as Block;
}

function mount(blocks: Block[], options: Record<string, unknown> = {}): NEditor {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createEditor({ element: host, doc: { blocks }, ...options });
  editors.push(editor);

  return editor;
}

const hosts = (editor: NEditor): HTMLElement[] => [
  ...editor.element.querySelectorAll<HTMLElement>('.neditor-block__content'),
];

const texts = (editor: NEditor): string[] => editor.getDocument().blocks.map(blockText);

const idFor = (editor: NEditor, text: string): string =>
  editor.getDocument().blocks.find((b) => blockText(b) === text)!.id;

function caretTo(host: HTMLElement, offset: number): void {
  const text = host.firstChild ?? host;
  const range = document.createRange();
  range.setStart(text, offset);
  range.setEnd(text, offset);
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  host.focus();
}

function press(host: HTMLElement | Element, key: string, init: KeyboardEventInit = {}): void {
  host.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
  );
}

function type(host: HTMLElement, data: string): void {
  host.dispatchEvent(
    new InputEvent('beforeinput', {
      inputType: 'insertText',
      data,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/** Counts what reached listeners, which is what an autosave consumer sees. */
interface Tally {
  changes: number;
  history: number;
}

function watch(editor: NEditor): Tally {
  const tally: Tally = { changes: 0, history: 0 };

  editor.on('change', () => {
    tally.changes += 1;
  });
  editor.on('history', () => {
    tally.history += 1;
  });

  return tally;
}

/**
 * Drags a block by its handle and releases it past the end of the document.
 *
 * Every rect is zero-sized under happy-dom, so `#dropGapFor` answers with the
 * gap past the last block for any downward pointer. Dragging the last block
 * there is a genuine no-op that still travels the whole pointer path — the one
 * `moveBlocks` call no per-call-site guard ever covered.
 */
function dragToEnd(editor: NEditor, blockIndex: number): void {
  const target = [...editor.element.querySelectorAll('.neditor-block')][blockIndex]!;
  target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerId: 7 }));

  const handle = editor.element.querySelector('.neditor-gutter__handle')!;
  handle.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      button: 0,
      clientY: 0,
    }),
  );
  document.dispatchEvent(
    new PointerEvent('pointermove', { bubbles: true, pointerId: 7, clientY: 400 }),
  );
  document.dispatchEvent(
    new PointerEvent('pointerup', { bubbles: true, pointerId: 7, clientY: 400 }),
  );
}

const three = (): Block[] => [
  block({ content: [{ text: 'first' }] }),
  block({ content: [{ text: 'second' }] }),
  block({ content: [{ text: 'third' }] }),
];

describe('sameBlocks reads the blocks, not the array', () => {
  test('a fresh copy of the same blocks is the same document', () => {
    const blocks = three();

    expect(sameBlocks(blocks, [...blocks])).toBe(true);
  });

  test('reordering the same blocks is a different document', () => {
    const blocks = three();

    expect(sameBlocks(blocks, [blocks[1]!, blocks[0]!, blocks[2]!])).toBe(false);
  });

  test('a rebuilt block is treated as a change, not proven equal', () => {
    const blocks = three();
    const rebuilt = [{ ...blocks[0]! }, blocks[1]!, blocks[2]!];

    // Deliberately conservative: proving deep equality costs more than the
    // spurious entry it would save, so only reuse-by-reference counts.
    expect(sameBlocks(blocks, rebuilt)).toBe(false);
  });

  test('dropping a block is a change', () => {
    const blocks = three();

    expect(sameBlocks(blocks, blocks.slice(0, 2))).toBe(false);
  });
});

describe('a move against the edge of the document is not an edit', () => {
  test('the caret path banks nothing at the top', () => {
    const editor = mount(three());
    const host = hosts(editor)[0]!;
    caretTo(host, 0);
    const tally = watch(editor);

    press(host, 'ArrowUp', { metaKey: true, shiftKey: true });

    expect(texts(editor)).toEqual(['first', 'second', 'third']);
    expect(tally).toEqual({ changes: 0, history: 0 });
    expect(editor.canUndo).toBe(false);
  });

  test('the block-selection path banks nothing at the bottom', () => {
    const editor = mount(three());
    editor.selectBlocks([idFor(editor, 'third')]);
    const tally = watch(editor);

    press(editor.element, 'ArrowDown', { metaKey: true, shiftKey: true });

    expect(texts(editor)).toEqual(['first', 'second', 'third']);
    expect(tally).toEqual({ changes: 0, history: 0 });
    expect(editor.canUndo).toBe(false);
  });

  test('a move that lands still records exactly one entry', () => {
    // The control the two tests above need: they would also pass against an
    // editor whose move keys did nothing at all.
    const editor = mount(three());
    const host = hosts(editor)[1]!;
    caretTo(host, 0);
    const tally = watch(editor);

    press(host, 'ArrowUp', { metaKey: true, shiftKey: true });

    expect(texts(editor)).toEqual(['second', 'first', 'third']);
    expect(tally).toEqual({ changes: 1, history: 1 });
  });

  test('auto-repeat at the edge does not evict the real undo history', () => {
    const editor = mount(three());

    // One genuine edit to protect: 'second' swaps down past 'third'.
    caretTo(hosts(editor)[1]!, 0);
    press(hosts(editor)[1]!, 'ArrowDown', { metaKey: true, shiftKey: true });
    expect(texts(editor)).toEqual(['first', 'third', 'second']);

    // Then a key held against the top of the document, where nothing can move.
    const top = hosts(editor)[0]!;
    caretTo(top, 0);

    for (let i = 0; i < 12; i += 1) {
      press(top, 'ArrowUp', { metaKey: true, shiftKey: true });
    }

    expect(texts(editor)).toEqual(['first', 'third', 'second']);

    // A single undo has to reach the document the user started with: those 12
    // repeats each used to push an entry, burying the edit that mattered.
    expect(editor.undo()).toBe(true);
    expect(texts(editor)).toEqual(['first', 'second', 'third']);
    expect(editor.canUndo).toBe(false);
  });
});

describe('a drag dropped where it already was is not an edit', () => {
  test('releasing the last block past the end banks nothing', () => {
    const editor = mount(three());
    const tally = watch(editor);

    dragToEnd(editor, 2);

    expect(texts(editor)).toEqual(['first', 'second', 'third']);
    expect(tally).toEqual({ changes: 0, history: 0 });
    expect(editor.canUndo).toBe(false);
  });

  test('the same gesture on another block still moves it', () => {
    // Proves the gesture above really reached `#endDrag` rather than falling
    // apart somewhere in the pointer path.
    const editor = mount(three());
    const tally = watch(editor);

    dragToEnd(editor, 0);

    expect(texts(editor)).toEqual(['second', 'third', 'first']);
    expect(tally).toEqual({ changes: 1, history: 1 });
  });
});

describe('one armed-formatting keystroke is one history entry', () => {
  test('the pre-edit document is recorded once, not twice', () => {
    const editor = mount([block({ content: [{ text: 'ab' }] })]);
    const host = hosts(editor)[0]!;
    caretTo(host, 2);
    editor.toggleMark('bold');
    const tally = watch(editor);

    type(host, 'X');

    expect(texts(editor)).toEqual(['abX']);
    expect(tally).toEqual({ changes: 1, history: 1 });
  });

  test('the first undo takes the character back and leaves nothing behind', () => {
    const editor = mount([block({ content: [{ text: 'ab' }] })]);
    const host = hosts(editor)[0]!;
    caretTo(host, 2);
    editor.toggleMark('bold');

    type(host, 'X');

    // The armed run really was written with its mark — otherwise this asserts
    // the undo behaviour of a path that never ran.
    expect(editor.getDocument().blocks[0]?.content.at(-1)).toEqual({
      text: 'X',
      marks: ['bold'],
    });

    expect(editor.undo()).toBe(true);
    expect(texts(editor)).toEqual(['ab']);

    // The second, identical snapshot: undoing it changed nothing on screen, so
    // Ctrl+Z looked broken.
    expect(editor.canUndo).toBe(false);
  });

  test('an armed insert in a table cell is one entry too', () => {
    const editor = mount([
      block({
        type: 'table',
        rows: [
          [[{ text: 'A' }], [{ text: 'B' }]],
          [[{ text: 'C' }], [{ text: 'D' }]],
        ],
      }),
    ]);
    const cell = editor.element.querySelector<HTMLElement>('[data-cell="1:1"]')!;
    caretTo(cell, 1);
    editor.toggleMark('italic');
    const tally = watch(editor);

    type(cell, 'z');

    expect(editor.getDocument().blocks[0]?.rows?.[1]?.[1]).toEqual([
      { text: 'D' },
      { text: 'z', marks: ['italic'] },
    ]);
    expect(tally).toEqual({ changes: 1, history: 1 });
    expect(editor.undo()).toBe(true);
    expect(editor.getDocument().blocks[0]?.rows?.[1]?.[1]).toEqual([{ text: 'D' }]);
    expect(editor.canUndo).toBe(false);
  });

  test('a run belongs to one host, not to the whole table', () => {
    // Both keystrokes land inside the coalescing window, so a run keyed by
    // block id alone folds the second cell's edit into the first cell's entry
    // and one undo takes back a character the user cannot see.
    const editor = mount([
      block({
        type: 'table',
        rows: [
          [[{ text: 'A' }], [{ text: 'B' }]],
          [[{ text: 'C' }], [{ text: 'D' }]],
        ],
      }),
    ]);

    const first = editor.element.querySelector<HTMLElement>('[data-cell="0:0"]')!;
    caretTo(first, 1);
    editor.toggleMark('bold');
    type(first, 'x');

    const second = editor.element.querySelector<HTMLElement>('[data-cell="1:1"]')!;
    caretTo(second, 1);
    editor.toggleMark('bold');
    type(second, 'y');

    editor.undo();

    const rows = editor.getDocument().blocks[0]?.rows ?? [];

    expect(rows[1]?.[1]).toEqual([{ text: 'D' }]);
    expect(rows[0]?.[0]).toEqual([{ text: 'A' }, { text: 'x', marks: ['bold'] }]);
  });
});

describe('an edit that sets a field to the value it already holds is not an edit', () => {
  /**
   * `#commit` recognises a no-op by reference, and every model operation
   * returned a freshly spread block whether or not the patch changed anything.
   * So re-picking the callout icon already showing, re-applying an image dialog
   * nobody touched, or re-setting the link already there each banked an undo
   * entry and emitted a `change` byte-identical to the document before it --
   * which an autosave listener writes back as the author's next revision.
   */
  test('re-picking the icon a callout already has banks nothing', () => {
    const editor = mount([
      block({ id: 'c', type: 'callout', icon: '💡', content: [{ text: 'note' }] }),
    ]);
    const changes: unknown[] = [];
    editor.on('change', (doc) => changes.push(doc));

    editor.setCalloutIcon('c', '💡');

    expect(editor.canUndo, 'a no-op icon pick must not be undoable').toBe(false);
    expect(changes).toHaveLength(0);
  });

  test('a different icon still records exactly one entry', () => {
    const editor = mount([
      block({ id: 'c', type: 'callout', icon: '💡', content: [{ text: 'note' }] }),
    ]);
    const changes: unknown[] = [];
    editor.on('change', (doc) => changes.push(doc));

    editor.setCalloutIcon('c', '🔥');

    expect(editor.canUndo).toBe(true);
    expect(changes).toHaveLength(1);
    expect(editor.getDocument().blocks[0]?.icon).toBe('🔥');
  });

  test('converting a block to the type it already is banks nothing', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'text' }] })]);
    const changes: unknown[] = [];
    editor.on('change', (doc) => changes.push(doc));

    editor.setBlockType('p', 'paragraph');

    expect(editor.canUndo).toBe(false);
    expect(changes).toHaveLength(0);
  });

  test('a real conversion still records exactly one entry', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'text' }] })]);

    editor.setBlockType('p', 'heading1');

    expect(editor.canUndo).toBe(true);
    expect(editor.getDocument().blocks[0]?.type).toBe('heading1');
  });
});
