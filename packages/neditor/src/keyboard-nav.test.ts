// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';

import type { Block } from './index.ts';
import { blockText, createEditor, resolveLabels } from './index.ts';
import type { NEditor } from './editor.ts';

/**
 * Keyboard navigation and history findings from the 9 Nov 2026 browser audit
 * (STR-1, STR-4, STR-9, STR-10, TXT-3, TXT-4, TXT-12, TXT-13, TXT-14, A11Y-5).
 * Each case is the auditor's literal scenario where happy-dom can observe it.
 *
 * What happy-dom cannot observe is pinned in the e2e suite instead: it lays
 * nothing out, so the visual-line tests behind ↑/↓ and the caret's x
 * position, and the rendered-ness check that picks the element Tab leaves
 * to, have no answer here (see `typing.spec.ts`, `a11y.spec.ts`).
 */

const editors: NEditor[] = [];

afterEach(() => {
  while (editors.length > 0) {
    editors.pop()?.destroy();
  }

  document.body.replaceChildren();
});

function block(over: Partial<Block> & { id: string }): Block {
  return { type: 'paragraph', depth: 0, content: [], ...over } as Block;
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

const cellOf = (editor: NEditor, coords: string): HTMLElement =>
  editor.element.querySelector<HTMLElement>(`[data-cell="${coords}"]`)!;

/** The text node and offset holding character `offset` of a host. */
function at(host: HTMLElement, offset: number): [Node, number] {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let last: Text | null = null;

  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (remaining <= node.length) {
      return [node, remaining];
    }

    remaining -= node.length;
    last = node;
  }

  return last ? [last, last.length] : [host, 0];
}

/** Selects from `anchor` to `focus` (character offsets): backward when focus < anchor. */
function select(host: HTMLElement, anchor: number, focus = anchor): void {
  host.focus();
  getSelection()!.setBaseAndExtent(...at(host, anchor), ...at(host, focus));
}

function press(target: Element, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);

  return event.defaultPrevented;
}

const MOD = { metaKey: true, ctrlKey: true };

const live = (editor: NEditor): string =>
  editor.element.querySelector('.neditor-live-region')?.textContent ?? '';

/** Lets the microtask that records where an edit left the caret run. */
const settled = (): Promise<void> => Promise.resolve();

/** The live selection's two ends as character offsets into the host holding them. */
function ends(host: HTMLElement): { anchor: number; focus: number } {
  const selection = getSelection()!;
  const offset = (node: Node, within: number): number => {
    const range = document.createRange();
    range.selectNodeContents(host);
    range.setEnd(node, within);
    return range.toString().length;
  };

  return {
    anchor: offset(selection.anchorNode!, selection.anchorOffset),
    focus: offset(selection.focusNode!, selection.focusOffset),
  };
}

describe('STR-1: Shift+↓/↑ from a range that already reaches the block edge', () => {
  const five = (): Block[] =>
    ['a', 'b', 'c', 'd', 'e'].map((id) =>
      block({ id, content: text(`Block ${id.toUpperCase()}`) }),
    );

  test('Shift+↓ with the focus at the end of the block extends into block selection', () => {
    const editor = mount(five());
    // Click mid-b, Shift+↓: the browser extends the range to the end, b@3-7.
    select(hostOf(editor, 'b'), 3, 7);

    expect(press(hostOf(editor, 'b'), 'ArrowDown', { shiftKey: true })).toBe(true);
    expect(editor.getSelectedBlocks()).toEqual(['b', 'c']);
  });

  test('Shift+↑ with the focus at the start does the same upwards', () => {
    const editor = mount(five());
    select(hostOf(editor, 'c'), 3, 0);

    expect(press(hostOf(editor, 'c'), 'ArrowUp', { shiftKey: true })).toBe(true);
    expect(editor.getSelectedBlocks()).toEqual(['b', 'c']);
  });

  test('the anchor at the edge is not enough: the focus end still has to get there', () => {
    const editor = mount(five());
    // Backward from the end: the anchor is at 7, the focus mid-block.
    select(hostOf(editor, 'b'), 7, 3);

    expect(press(hostOf(editor, 'b'), 'ArrowDown', { shiftKey: true })).toBe(false);
    expect(editor.getSelectedBlocks()).toEqual([]);
  });
});

describe('STR-10: modified arrows in a table cell mean what they mean in any block', () => {
  const table = (): Block[] => [
    block({ id: 'P', content: text('Para') }),
    block({
      id: 'T',
      type: 'table',
      rows: [
        [text('H1'), text('H2')],
        [text('a1'), text('a2')],
      ],
    }),
    block({ id: 'N', content: text('Next') }),
  ];

  test('Shift+↓ at the end of a header cell extends into block selection, not to the next row', () => {
    const editor = mount(table());
    const cell = cellOf(editor, '0:0');
    select(cell, 2);

    press(cell, 'ArrowDown', { shiftKey: true });

    expect(editor.getSelectedBlocks()).toEqual(['T', 'N']);
  });

  test('Mod+Shift+↑ at offset 0 of a lower-row cell moves the table, keeping the cell', () => {
    const editor = mount(table());
    const cell = cellOf(editor, '1:0');
    select(cell, 0);

    press(cell, 'ArrowUp', { shiftKey: true, ...MOD });

    expect(editor.getDocument().blocks.map((b) => b.id)).toEqual(['T', 'P', 'N']);
    expect(editor.getSelectionState()).toMatchObject({ blockId: 'T', cell: { row: 1, column: 0 } });
  });

  test('Mod+Shift+↓ at the end of a header cell moves the table down', () => {
    const editor = mount(table());
    const cell = cellOf(editor, '0:1');
    select(cell, 2);

    press(cell, 'ArrowDown', { shiftKey: true, ...MOD });

    expect(editor.getDocument().blocks.map((b) => b.id)).toEqual(['P', 'N', 'T']);
  });
});

/**
 * A real ←/→ press: keydown, then whatever the browser's own caret movement
 * does (`browser`, happy-dom having none), then keyup. The editor no longer
 * cancels the key: it lets the browser move and crosses only a move that went
 * nowhere (R2-NAV-2), so the crossing is asserted after the keyup.
 */
function arrow(
  target: Element,
  key: 'ArrowLeft' | 'ArrowRight',
  browser?: () => void,
  init: KeyboardEventInit = {},
): boolean {
  const down = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(down);

  if (!down.defaultPrevented) {
    browser?.();
  }

  document.activeElement?.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));

  return down.defaultPrevented;
}

describe('TXT-3: ←/→ cross the edge of a host', () => {
  test('→ at the end of a paragraph goes to the start of the next', () => {
    const editor = mount([
      block({ id: 'p1', content: text('Alpha one') }),
      block({ id: 'p2', content: text('Beta two') }),
    ]);
    select(hostOf(editor, 'p1'), 9);

    expect(arrow(hostOf(editor, 'p1'), 'ArrowRight')).toBe(false);
    expect(editor.getSelectionState()).toMatchObject({
      blockId: 'p2',
      range: { start: 0, end: 0 },
    });
  });

  test('← at the start goes to the end of the previous, over a divider', () => {
    const editor = mount([
      block({ id: 'p1', content: text('Alpha one') }),
      block({ id: 'hr', type: 'divider' }),
      block({ id: 'p2', content: text('Beta two') }),
    ]);
    select(hostOf(editor, 'p2'), 0);

    expect(arrow(hostOf(editor, 'p2'), 'ArrowLeft')).toBe(false);
    expect(editor.getSelectionState()).toMatchObject({
      blockId: 'p1',
      range: { start: 9, end: 9 },
    });
  });

  test('table cells are steps in reading order', () => {
    const editor = mount([
      block({
        id: 'T',
        type: 'table',
        rows: [
          [text('H1'), text('H2')],
          [text('a1'), text('a2')],
        ],
      }),
      block({ id: 'N', content: text('Next') }),
    ]);
    select(cellOf(editor, '0:1'), 2);
    arrow(cellOf(editor, '0:1'), 'ArrowRight');

    expect(editor.getSelectionState()).toMatchObject({ cell: { row: 1, column: 0 } });

    select(cellOf(editor, '1:1'), 2);
    arrow(cellOf(editor, '1:1'), 'ArrowRight');

    expect(editor.getSelectionState()?.blockId).toBe('N');
  });

  test('mid-text, over a range, or with a modifier the arrow stays the browser’s', () => {
    const editor = mount([
      block({ id: 'p1', content: text('Alpha one') }),
      block({ id: 'p2', content: text('Beta two') }),
    ]);
    const host = hostOf(editor, 'p1');

    select(host, 4);
    expect(arrow(host, 'ArrowRight')).toBe(false);
    expect(editor.getSelectionState()).toMatchObject({ blockId: 'p1', range: { start: 4 } });
    select(host, 2, 9);
    expect(arrow(host, 'ArrowRight')).toBe(false);
    expect(editor.getSelectionState()).toMatchObject({ blockId: 'p1', range: { end: 9 } });
    select(host, 9);
    expect(arrow(host, 'ArrowRight', undefined, { shiftKey: true })).toBe(false);
    expect(arrow(host, 'ArrowRight', undefined, { altKey: true })).toBe(false);
    expect(editor.getSelectionState()).toMatchObject({ blockId: 'p1', range: { start: 9 } });
  });

  test('at the very end of the document → does nothing', () => {
    const editor = mount([block({ id: 'p1', content: text('Only') })]);
    select(hostOf(editor, 'p1'), 4);

    expect(arrow(hostOf(editor, 'p1'), 'ArrowRight')).toBe(false);
    expect(editor.getSelectionState()).toMatchObject({ blockId: 'p1', range: { start: 4 } });
  });
});

/*
 * R2-NAV-2 (round 2 of the 9 Nov audit). Under bidi the logical start of a
 * host is not on the side its direction says: Hebrew in an LTR editor starts
 * at the right, so → at offset 0 points *out* of the text, and the browser
 * (Firefox) cannot move -- while the round-1 rule, "→ is forward in LTR",
 * waited for offset 9 and never crossed. happy-dom has no caret movement of
 * its own, so each case states what the browser did.
 */
describe('R2-NAV-2: ←/→ cross where the browser could not move', () => {
  const hebrew = (): Block[] => [
    block({ id: 'p1', content: text('first') }),
    block({ id: 'p2', content: text('שלום עולם') }),
    block({ id: 'p3', content: text('third') }),
  ];

  test('stuck at the logical start, → in an LTR host goes back to the previous block', () => {
    const editor = mount(hebrew());
    select(hostOf(editor, 'p2'), 0);

    arrow(hostOf(editor, 'p2'), 'ArrowRight');

    expect(editor.getSelectionState()).toMatchObject({ blockId: 'p1', range: { start: 5 } });
  });

  test('stuck at the logical end, ← in an LTR host goes on to the next block', () => {
    const editor = mount(hebrew());
    select(hostOf(editor, 'p2'), 9);

    arrow(hostOf(editor, 'p2'), 'ArrowLeft');

    expect(editor.getSelectionState()).toMatchObject({ blockId: 'p3', range: { start: 0 } });
  });

  test('a press the browser moved the caret for is the browser’s, even at an edge', () => {
    const editor = mount(hebrew());
    const host = hostOf(editor, 'p2');
    select(host, 0);

    // Into the text: the browser steps one character on.
    arrow(host, 'ArrowLeft', () => select(host, 1));

    expect(editor.getSelectionState()).toMatchObject({ blockId: 'p2', range: { start: 1 } });
  });

  test('a key someone else cancelled crosses nothing', () => {
    const editor = mount(hebrew());
    const host = hostOf(editor, 'p2');
    select(host, 9);
    const cancel = (event: Event) => event.preventDefault();
    document.addEventListener('keydown', cancel);

    try {
      arrow(host, 'ArrowRight');
    } finally {
      document.removeEventListener('keydown', cancel);
    }

    expect(editor.getSelectionState()).toMatchObject({ blockId: 'p2', range: { start: 9 } });
  });

  test('an empty block, both ends at once, crosses the way the key points', () => {
    const editor = mount([
      block({ id: 'a', content: text('one') }),
      block({ id: 'e' }),
      block({ id: 'z', content: text('two') }),
    ]);
    select(hostOf(editor, 'e'), 0);
    arrow(hostOf(editor, 'e'), 'ArrowRight');
    expect(editor.getSelectionState()?.blockId).toBe('z');

    select(hostOf(editor, 'e'), 0);
    arrow(hostOf(editor, 'e'), 'ArrowLeft');
    expect(editor.getSelectionState()?.blockId).toBe('a');
  });

  test('without a keyup, the check still runs once the browser has had its turn', async () => {
    const editor = mount(hebrew());
    select(hostOf(editor, 'p2'), 9);

    hostOf(editor, 'p2').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    expect(editor.getSelectionState()?.blockId).toBe('p2');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(editor.getSelectionState()).toMatchObject({ blockId: 'p3', range: { start: 0 } });
  });
});

/*
 * R2-NAV-12. On macOS ⌘↑/↓ go to the start or end of the document and ⌥↑/↓
 * to the start or end of the paragraph; round 1 made them step one block at a
 * block's edge. They are the browser's again.
 */
describe('R2-NAV-12: modified ↑/↓ are the platform’s', () => {
  test.each([
    ['ArrowUp', { metaKey: true }, 0],
    ['ArrowUp', { altKey: true }, 0],
    ['ArrowDown', { metaKey: true }, 7],
    ['ArrowDown', { altKey: true }, 7],
    ['ArrowDown', { ctrlKey: true }, 7],
  ] as const)('%s with %o at the block’s edge stays in the block', (key, init, offset) => {
    const editor = mount(
      ['a', 'b', 'c'].map((id) => block({ id, content: text(`Block ${id.toUpperCase()}`) })),
    );
    select(hostOf(editor, 'b'), offset);

    expect(press(hostOf(editor, 'b'), key, init)).toBe(false);
    expect(editor.getSelectionState()).toMatchObject({ blockId: 'b', range: { start: offset } });
  });
});

describe('TXT-4: ↑ into a table enters its last row', () => {
  test('from the paragraph below, ↑ lands in the last row, not the header cell 0:0', () => {
    const editor = mount([
      block({
        id: 'tbl',
        type: 'table',
        rows: [
          [text('H1'), text('H2')],
          [text('c1'), text('c2')],
        ],
      }),
      block({ id: 'z', content: text('Last') }),
    ]);
    select(hostOf(editor, 'z'), 0);

    expect(press(hostOf(editor, 'z'), 'ArrowUp')).toBe(true);
    expect(editor.getSelectionState()).toMatchObject({
      blockId: 'tbl',
      cell: { row: 1, column: 0 },
    });
  });

  test('from the paragraph above, ↓ lands in the first row', () => {
    const editor = mount([
      block({ id: 'a', content: text('Above') }),
      block({
        id: 'tbl',
        type: 'table',
        rows: [
          [text('H1'), text('H2')],
          [text('c1'), text('c2')],
        ],
      }),
    ]);
    select(hostOf(editor, 'a'), 5);
    press(hostOf(editor, 'a'), 'ArrowDown');

    expect(editor.getSelectionState()).toMatchObject({ cell: { row: 0, column: 0 } });
  });
});

describe('TXT-14: a document that ends in a divider has a keyboard way below it', () => {
  const doc = (): Block[] => [
    block({ id: 'A', content: text('Text') }),
    block({ id: 'hr', type: 'divider' }),
  ];

  test('↓ at the end of the last text block opens a paragraph after the divider', () => {
    const editor = mount(doc());
    select(hostOf(editor, 'A'), 4);

    expect(press(hostOf(editor, 'A'), 'ArrowDown')).toBe(true);

    const blocks = editor.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'divider', 'paragraph']);
    expect(editor.getSelectionState()?.blockId).toBe(blocks[2]!.id);

    // One step, like any other edit.
    editor.undo();
    expect(editor.getDocument().blocks).toHaveLength(2);
  });

  test('Enter on the block-selected trailing divider opens a paragraph after it', () => {
    const editor = mount(doc());
    editor.selectBlocks(['hr']);

    press(editor.element, 'Enter');

    const blocks = editor.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'divider', 'paragraph']);
    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(editor.getSelectionState()?.blockId).toBe(blocks[2]!.id);
  });

  test('so does ↓ on it', () => {
    const editor = mount(doc());
    editor.selectBlocks(['hr']);

    press(editor.element, 'ArrowDown');

    expect(editor.getDocument().blocks.map((b) => b.type)).toEqual([
      'paragraph',
      'divider',
      'paragraph',
    ]);
  });

  test('a divider with text after it still just hands Enter back as before', () => {
    const editor = mount([...doc(), block({ id: 'B', content: text('After') })]);
    editor.selectBlocks(['hr']);

    press(editor.element, 'Enter');

    expect(editor.getDocument().blocks).toHaveLength(3);
    expect(editor.getSelectedBlocks()).toEqual(['hr']);
  });
});

describe('STR-4: undo with no caret recorded stays where the document changed', () => {
  const long = (): Block[] =>
    Array.from({ length: 45 }, (_, i) => block({ id: `p${i}`, content: text(`Paragraph ${i}`) }));

  test('the gutter + beside p40, type, undo twice: the caret is in p40, not p0', async () => {
    const editor = mount(long());
    const row = editor.element.querySelector<HTMLElement>('[data-block-id="p40"]')!;
    row.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    // The + is pressed with the pointer: no caret anywhere in the text.
    getSelection()!.removeAllRanges();
    editor.element.querySelector<HTMLElement>('.neditor-gutter__add')!.click();
    await settled();

    const created = editor.getDocument().blocks[41]!;
    expect(blockText(created)).toBe('');

    editor.undo();
    editor.undo();

    expect(editor.getDocument().blocks).toHaveLength(45);
    expect(editor.getSelectionState()).toMatchObject({
      blockId: 'p40',
      range: { start: 'Paragraph 40'.length },
    });
  });

  test('a caret left behind in p0 before scrolling down is not where the + was pressed', async () => {
    const editor = mount(long());
    select(hostOf(editor, 'p0'), 3);
    const row = editor.element.querySelector<HTMLElement>('[data-block-id="p40"]')!;
    row.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    editor.element.querySelector<HTMLElement>('.neditor-gutter__add')!.click();
    await settled();

    editor.undo();

    expect(editor.getSelectionState()?.blockId).toBe('p40');
  });

  test('a toggle opened by its chevron undoes back to the toggle', () => {
    const editor = mount([
      ...long().slice(0, 30),
      block({ id: 'tg', type: 'toggle', content: text('Toggle'), collapsed: true }),
      block({ id: 'kid', content: text('child'), depth: 1 }),
    ]);
    getSelection()!.removeAllRanges();
    editor.toggleCollapsed('tg');
    getSelection()!.removeAllRanges();

    editor.undo();

    // At the end of its text, where the chevron's own focus fallback puts it.
    expect(editor.getSelectionState()).toMatchObject({ blockId: 'tg', range: { start: 6 } });
  });

  test('any other edit with nothing recorded falls back to the first block that changed', () => {
    const editor = mount([
      ...long().slice(0, 30),
      block({ id: 'todo', type: 'todo', content: text('Task') }),
    ]);
    getSelection()!.removeAllRanges();
    editor.toggleTodo('todo');
    getSelection()!.removeAllRanges();

    editor.undo();

    expect(editor.getSelectionState()?.blockId).toBe('todo');
  });
});

describe('STR-9: undo from a control inside a block', () => {
  test('Mod+Z with the toggle chevron focused undoes the chevron press', () => {
    const editor = mount([
      block({ id: 'tg', type: 'toggle', content: text('Toggle'), collapsed: true }),
      block({ id: 'kid', content: text('child'), depth: 1 }),
    ]);
    const chevron = editor.element.querySelector<HTMLElement>('.neditor-block__chevron')!;
    chevron.focus();
    chevron.click();

    expect(editor.getDocument().blocks[0]!.collapsed).toBe(false);

    expect(press(chevron, 'z', MOD)).toBe(true);
    expect(editor.getDocument().blocks[0]!.collapsed).toBe(true);

    press(editor.element.querySelector('.neditor-block__chevron')!, 'z', {
      ...MOD,
      shiftKey: true,
    });
    expect(editor.getDocument().blocks[0]!.collapsed).toBe(false);
  });

  test('read-only, the key is left alone', () => {
    const editor = mount(
      [
        block({ id: 'tg', type: 'toggle', content: text('Toggle'), collapsed: true }),
        block({ id: 'kid', content: text('child'), depth: 1 }),
      ],
      { editable: false },
    );
    const chevron = editor.element.querySelector<HTMLElement>('.neditor-block__chevron')!;

    expect(press(chevron, 'z', MOD)).toBe(false);
  });
});

describe('TXT-12: redo restores where the redone edit left the caret', () => {
  test('undoing a bold and an Enter, then redoing the bold, selects the word again', async () => {
    const editor = mount([block({ id: 'p', content: text('Hello world') })]);
    const host = hostOf(editor, 'p');
    select(host, 11, 6);
    press(host, 'b', MOD);
    await settled();
    // →, then Enter at the end: a later edit that starts from a bare caret.
    select(hostOf(editor, 'p'), 11);
    press(hostOf(editor, 'p'), 'Enter');
    await settled();

    editor.undo();
    editor.undo();
    expect(editor.getDocument().blocks[0]!.content).toEqual(text('Hello world'));

    editor.redo();

    expect(editor.getDocument().blocks[0]!.content).toEqual([
      { text: 'Hello ' },
      { text: 'world', marks: ['bold'] },
    ]);
    expect(editor.getSelectionState()?.range).toEqual({ start: 6, end: 11 });
  });

  test('undo still goes back to where each edit began', async () => {
    const editor = mount([block({ id: 'p', content: text('Hello world') })]);
    select(hostOf(editor, 'p'), 6, 11);
    press(hostOf(editor, 'p'), 'b', MOD);
    await settled();
    select(hostOf(editor, 'p'), 11);
    press(hostOf(editor, 'p'), 'Enter');
    await settled();

    editor.undo();
    expect(editor.getSelectionState()?.range).toEqual({ start: 11, end: 11 });
    editor.undo();
    expect(editor.getSelectionState()?.range).toEqual({ start: 6, end: 11 });
    editor.redo();
    editor.redo();
    editor.undo();
    expect(editor.getSelectionState()?.range).toEqual({ start: 11, end: 11 });
  });
});

describe('TXT-13: a backward selection keeps its direction', () => {
  test('across Mod+B, and across its undo', () => {
    const editor = mount([block({ id: 'p', content: text('Alpha one two') })]);
    // Shift+← ×3 from 6: anchor 6, focus 3.
    select(hostOf(editor, 'p'), 6, 3);

    press(hostOf(editor, 'p'), 'b', MOD);

    expect(ends(hostOf(editor, 'p'))).toEqual({ anchor: 6, focus: 3 });

    editor.undo();

    expect(editor.getSelectionState()?.range).toEqual({ start: 3, end: 6 });
    expect(ends(hostOf(editor, 'p'))).toEqual({ anchor: 6, focus: 3 });
  });

  test('a forward one stays forward', () => {
    const editor = mount([block({ id: 'p', content: text('Alpha one two') })]);
    select(hostOf(editor, 'p'), 3, 6);

    press(hostOf(editor, 'p'), 'b', MOD);

    expect(ends(hostOf(editor, 'p'))).toEqual({ anchor: 3, focus: 6 });
  });
});

describe('Tab in the last cell of a table', () => {
  test('adds a row when the last row has text', () => {
    const editor = mount([block({ id: 'T', type: 'table', rows: [[text('H')], [text('a')]] })]);
    select(cellOf(editor, '1:0'), 1);

    expect(press(cellOf(editor, '1:0'), 'Tab')).toBe(true);
    expect(editor.getDocument().blocks[0]!.rows).toHaveLength(3);
  });

  test('moves focus on, unswallowed, when the last row is empty', () => {
    const editor = mount([
      block({
        id: 'T',
        type: 'table',
        rows: [
          [text('H'), text('I')],
          [[], []],
        ],
      }),
    ]);
    select(cellOf(editor, '1:1'), 0);

    expect(press(cellOf(editor, '1:1'), 'Tab')).toBe(false);
    expect(editor.getDocument().blocks[0]!.rows).toHaveLength(2);
    // Nor did it fall through to the block's own Tab, which indents.
    expect(editor.getDocument().blocks[0]!.depth).toBe(0);
  });
});

describe('A11Y-5: what block-selection edits announce', () => {
  const five = (): Block[] =>
    ['a', 'b', 'c', 'd', 'e'].map((id) =>
      block({ id, content: text(`Block ${id.toUpperCase()}`) }),
    );

  test('Escape from a paragraph names it a paragraph, not "Text"', () => {
    const editor = mount(five());
    select(hostOf(editor, 'b'), 0);

    press(hostOf(editor, 'b'), 'Escape');

    expect(live(editor)).toBe('Paragraph selected, Block B');
  });

  test('moving, indenting, outdenting and duplicating each say so', () => {
    const editor = mount(five());
    editor.selectBlocks(['b', 'c']);

    press(editor.element, 'ArrowDown', { shiftKey: true, ...MOD });
    expect(live(editor)).toBe('Moved down');
    press(editor.element, 'ArrowUp', { shiftKey: true, ...MOD });
    expect(live(editor)).toBe('Moved up');
    press(editor.element, 'Tab');
    expect(live(editor)).toBe('Indented');
    press(editor.element, 'Tab', { shiftKey: true });
    expect(live(editor)).toBe('Outdented');
    press(editor.element, 'd', MOD);
    // Two sentences, punctuated as two (R2-NAV-7).
    expect(live(editor)).toBe('2 blocks duplicated. 2 blocks selected');
  });

  test('a single duplicate is two sentences, not one run together', () => {
    const editor = mount(five());
    editor.selectBlocks(['b']);

    press(editor.element, 'd', MOD);

    expect(live(editor)).toBe('Block duplicated. Paragraph selected, Block B');
  });

  test('a move against the edge of the document announces nothing', () => {
    const editor = mount(five());
    editor.selectBlocks(['a']);
    const before = live(editor);

    press(editor.element, 'ArrowUp', { shiftKey: true, ...MOD });

    expect(live(editor)).toBe(before);
  });

  test('a cut is announced as a cut', () => {
    const editor = mount(five());
    editor.selectBlocks(['b', 'c']);
    const event = new Event('cut', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { setData: () => undefined } });

    editor.element.dispatchEvent(event);

    expect(live(editor)).toBe('2 blocks cut');
  });

  /*
   * R2-NAV-7, the probe's host: it translated the live region before the cut,
   * move, indent and duplicate announcements existed.
   */
  const fr = {
    blockDeleted: 'Bloc supprimé',
    blocksDeleted: '{count} blocs supprimés',
    blockSelected: '1 bloc sélectionné',
    blocksSelected: '{count} blocs sélectionnés',
    blockSelectedNamed: '{type} sélectionné, {text}',
    emptyBlockSelectedNamed: '{type} vide sélectionné',
    undone: 'Annulé',
  };

  const cut = (editor: NEditor): void => {
    const event = new Event('cut', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { setData: () => undefined } });
    editor.element.dispatchEvent(event);
  };

  test('a host that translated "deleted" hears its own words for a cut, never English', () => {
    const one = mount(five(), { labels: fr });
    one.selectBlocks(['b']);
    cut(one);
    expect(live(one)).toMatch(/^Bloc supprimé/);

    const two = mount(five(), { labels: fr });
    two.selectBlocks(['b', 'c']);
    cut(two);
    expect(live(two)).toMatch(/^2 blocs supprimés/);
  });

  test('…and nothing English for a move, an indent or a duplicate', () => {
    const editor = mount(five(), { labels: fr });
    editor.selectBlocks(['b', 'c']);
    const said: string[] = [];

    for (const [key, init] of [
      ['ArrowDown', { shiftKey: true, ...MOD }],
      ['Tab', {}],
      ['Tab', { shiftKey: true }],
      ['d', MOD],
    ] as const) {
      press(editor.element, key, init);
      said.push(live(editor));
    }

    expect(said).toEqual(['', '', '', '2 blocs sélectionnés']);
  });

  test('a host that translated nothing still hears every English default', () => {
    const editor = mount(five(), { labels: {} });
    editor.selectBlocks(['b', 'c']);

    press(editor.element, 'ArrowDown', { shiftKey: true, ...MOD });

    expect(live(editor)).toBe('Moved down');
  });

  // R4-KEY-2, the probe's hosts: each customised one English label that is
  // not an announcement, and heard silence for a move, an indent and an
  // outdent, a bare selection for a duplicate, and "Block deleted" for a cut.
  test.each([
    ['a placeholder', { placeholders: { paragraph: 'Write something…' } }],
    ['the editor’s name', { editor: 'Release notes' }],
    ['the image URL field', { imageUrl: 'Picture address' }],
  ] as const)('a host that customised only %s hears every English sentence', (_, labels) => {
    const editor = mount(five(), { labels });
    editor.selectBlocks(['b']);
    const said: string[] = [];

    for (const [key, init] of [
      ['ArrowDown', { shiftKey: true, ...MOD }],
      ['Tab', {}],
      ['Tab', { shiftKey: true }],
      ['d', MOD],
    ] as const) {
      press(editor.element, key, init);
      said.push(live(editor));
    }
    cut(editor);
    said.push(live(editor));

    expect(said.slice(0, 3)).toEqual(['Moved down', 'Indented', 'Outdented']);
    expect(said[3]).toMatch(/^Block duplicated/);
    expect(said[4]).toMatch(/^Block cut/);
  });

  test('a host that translated the paragraph command keeps its own word', () => {
    const labels = resolveLabels({
      slashCommands: { paragraph: { label: 'Texte', description: '', keywords: [] } },
    });

    expect(labels.blockTypeNames.paragraph).toBeUndefined();
    expect(resolveLabels().blockTypeNames.paragraph).toBe('Paragraph');
    expect(
      resolveLabels({
        slashCommands: { paragraph: { label: 'Texte', description: '', keywords: [] } },
        blockTypeNames: { paragraph: 'Paragraphe' },
      }).blockTypeNames.paragraph,
    ).toBe('Paragraphe');
  });
});

/*
 * R2-NAV-8. A selected block is named by what it holds: an image by its alt
 * text, a divider and a picture with nothing to read are not "empty", and the
 * English type name is never capitalised mid-sentence.
 */
describe('R2-NAV-8: a selected block is called what it is', () => {
  const none = (): Block['content'] => [];
  const picture = { type: 'image', src: '/sample.png' } as const;

  test.each([
    [block({ id: 'x', ...picture, alt: 'A blue gradient' }), 'Image selected, A blue gradient'],
    [
      block({ id: 'x', ...picture, alt: 'A blue gradient', content: text('Caption') }),
      'Image selected, A blue gradient',
    ],
    [block({ id: 'x', ...picture, content: text('Caption') }), 'Image selected, Caption'],
    [block({ id: 'x', ...picture }), 'Image selected'],
    [block({ id: 'x', type: 'image' }), 'Image selected, empty'],
    [block({ id: 'x', type: 'divider' }), 'Divider selected'],
    [
      block({
        id: 'x',
        type: 'table',
        rows: [
          [none(), none()],
          [none(), none()],
        ],
      }),
      'Table selected, empty',
    ],
    [block({ id: 'x' }), 'Paragraph selected, empty'],
  ])('%#: says %j', (target, said) => {
    const editor = mount([block({ id: 'p', content: text('One') }), target]);

    editor.selectBlocks(['x']);

    expect(live(editor)).toBe(said);
  });

  test('a host that translated "1 block selected" hears it for a divider, not English', () => {
    const editor = mount([block({ id: 'x', type: 'divider' })], {
      labels: { blockSelected: '1 bloc sélectionné' },
    });

    editor.selectBlocks(['x']);

    expect(live(editor)).toBe('1 bloc sélectionné');
  });
});

// R2-NAV-9 (undo after a link applied from its dialog) is pinned in history.spec.ts,
// H13: happy-dom keeps a selection in an element whatever holds focus, so the
// same test here recorded the right range with the fix removed. Its direction
// (R3-KEY-6, below) is observable here: the restore writes it explicitly.

/*
 * R3-KEY-9. Chromium runs input ahead of timers, so a held arrow's repeats
 * arrive back to back and the check each one left for after the browser's
 * move runs at the next keydown instead. That keydown was dispatched at the
 * host focus was in when it fired -- the one the crossing then left -- and it
 * was judged there: the selection was no longer in that host, nothing was
 * checked for it, and every crossing cost a second press.
 */
describe('R3-KEY-9: a held arrow whose repeats arrive before any timer', () => {
  const repeat = (target: Element): void => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  };

  test('the keydown that carried the last press across is a press from where it landed', () => {
    const editor = mount([
      block({ id: 'a', content: text('ab') }),
      block({ id: 'e' }),
      block({ id: 'c', content: text('cd') }),
    ]);
    select(hostOf(editor, 'a'), 2);

    // At the end of "ab": the browser cannot move.
    repeat(hostOf(editor, 'a'));
    expect(editor.getSelectionState()?.blockId).toBe('a');

    // Fired while focus was still in "ab". Its flush crosses into the empty
    // block, and the press itself is one from there: the browser has nothing
    // to move over, so that is checked in turn.
    repeat(hostOf(editor, 'a'));
    expect(editor.getSelectionState()).toMatchObject({ blockId: 'e', range: { start: 0 } });

    // Fired at the empty block, which focus is now in: one press, one block.
    repeat(hostOf(editor, 'e'));
    expect(editor.getSelectionState()).toMatchObject({ blockId: 'c', range: { start: 0 } });
  });
});

/*
 * R3-KEY-8. The stand-in that moves the browser's Tab starting point out of
 * the editor went only on its own `blur`. Firefox headless never moves focus
 * off it when there is nothing before the editor -- no blur, and it stayed
 * in the page holding focus across every further Shift+Tab.
 */
describe('R3-KEY-8: the exit stand-in does not outlive its one Tab', () => {
  const stops = (): number => document.querySelectorAll('.neditor-exit-stop').length;

  /** Escape twice, then Shift+Tab: with nothing laid out, nothing is tabbable outside. */
  const exitBackward = (editor: NEditor): HTMLElement => {
    select(hostOf(editor, 'p'), 1);
    press(hostOf(editor, 'p'), 'Escape');
    press(editor.element, 'Escape');
    press(document.activeElement ?? document.body, 'Tab', { shiftKey: true });

    return document.querySelector<HTMLElement>('.neditor-exit-stop')!;
  };

  test('the next key it is not spending takes it away, with focus still on it', () => {
    const editor = mount([block({ id: 'p', content: text('One') })]);
    const stop = exitBackward(editor);
    expect(document.activeElement, 'precondition: the stand-in holds focus').toBe(stop);

    press(stop, 'Tab', { shiftKey: true });

    expect(stops()).toBe(0);
  });

  test('focus arriving anywhere else takes it away, blur or none', () => {
    const editor = mount([block({ id: 'p', content: text('One') })]);
    exitBackward(editor);
    expect(stops(), 'precondition: the stand-in is placed').toBe(1);
    const other = document.createElement('button');
    document.body.append(other);

    // Only the focusin: the blur is what Firefox headless never sent.
    other.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));

    expect(stops()).toBe(0);
  });

  test('destroy takes it away', () => {
    const editor = mount([block({ id: 'p', content: text('One') })]);
    exitBackward(editor);
    expect(stops(), 'precondition: the stand-in is placed').toBe(1);

    editor.destroy();

    expect(stops()).toBe(0);
  });
});

/*
 * R3-KEY-5. The probe's host (the e2e harness's `labels=fr`) translated the
 * live region before cuts were announced, but not `blockDeleted`; a cut then
 * announced nothing at all. And the hand-written list of announcements that
 * said "this host translates" left out the table ones.
 */
describe('R3-KEY-5: which hosts translate, and what a cut says for them', () => {
  const harnessFrench = {
    editor: 'Éditeur de texte',
    bold: 'Gras',
    blocksSelected: '{count} blocs sélectionnés',
    blockSelected: '1 bloc sélectionné',
    blockSelectedNamed: '{type} sélectionné, {text}',
    emptyBlockSelectedNamed: '{type} vide sélectionné',
    leftEditor: "Sortie de l'éditeur",
  };

  const cut = (editor: NEditor): void => {
    const event = new Event('cut', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { setData: () => undefined } });
    editor.element.dispatchEvent(event);
  };

  test('a cut is announced as a deletion when the host translated neither', () => {
    const editor = mount(
      ['a', 'b', 'c'].map((id) => block({ id, content: text(id) })),
      { labels: harnessFrench },
    );
    editor.selectBlocks(['b']);
    cut(editor);
    expect(live(editor)).toBe('Block deleted');

    editor.selectBlocks(['a', 'c']);
    cut(editor);
    expect(live(editor)).toBe('2 blocks deleted');
  });

  test.each([
    ['rowInsertedAbove', 'Ligne insérée au-dessus'],
    ['columnDeleted', 'Colonne supprimée'],
    ['changedTo', 'Changé en {type}'],
  ] as const)('a host that supplied only %s is translating', (key, value) => {
    expect(resolveLabels({ [key]: value }).blocksMovedUp).toBe('');
  });

  // R4-KEY-2: only an announcement says the live region is translated. These
  // are customisations a host makes in English (R3 counted them, and a host
  // that named its editor lost the move sentences).
  test.each([
    ['editor', 'Éditeur'],
    ['placeholders', { paragraph: 'Écrivez…' }],
    ['bold', 'Gras'],
    ['imageUrl', 'Picture address'],
  ] as const)('a host that supplied only %s is not translating the live region', (key, value) => {
    expect(resolveLabels({ [key]: value }).blocksMovedUp).toBe('Moved up');
  });

  test('labels introduced with these announcements do not make a host a translator', () => {
    expect(resolveLabels({ blockCut: 'Snipped' }).blocksMovedUp).toBe('Moved up');
    expect(resolveLabels({ blockTypeNames: { heading1: 'Title' } }).blocksIndented).toBe(
      'Indented',
    );
    expect(resolveLabels({}).blockDuplicated).toBe('Block duplicated');
  });
});

/*
 * R3-KEY-6. A link applied from its dialog put the selection back forwards:
 * the next Shift+← shrank it from the far end. The probe's scenario: "today"
 * selected with Shift+← from its end, Mod+K, a URL, Enter.
 */
describe('R3-KEY-6: a link applied from its dialog keeps a backward selection backward', () => {
  const dialogInput = (): HTMLInputElement => {
    // This editor's own portal: the last one on the page.
    const inputs = document.querySelectorAll<HTMLInputElement>('.neditor-link-editor input');
    return inputs[inputs.length - 1]!;
  };

  test('after Apply, after undo, and after redo', async () => {
    const editor = mount([block({ id: 'x', content: text('Read this today please') })]);
    const host = hostOf(editor, 'x');
    select(host, 15, 10);

    press(host, 'k', MOD);
    const input = dialogInput();
    input.value = 'https://example.com';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settled();

    expect(editor.getDocument().blocks[0]!.content[1]).toMatchObject({ text: 'today' });
    expect(ends(host)).toEqual({ anchor: 15, focus: 10 });

    editor.undo();
    expect(editor.getDocument().blocks[0]!.content).toEqual(text('Read this today please'));
    expect(ends(host)).toEqual({ anchor: 15, focus: 10 });

    editor.redo();
    expect(ends(host)).toEqual({ anchor: 15, focus: 10 });
  });

  // R4-KEY-3, the probe's host: its own Link button calls the public setLink
  // over a backward selection, as its Bold button calls toggleMark.
  test('the public setLink keeps it backward too, as toggleMark does', () => {
    const editor = mount([block({ id: 'x', content: text('Hello wonderful world of links') })]);
    const host = hostOf(editor, 'x');

    select(host, 15, 10);
    expect(editor.setLink('https://example.com')).toBe(true);
    expect(editor.getDocument().blocks[0]!.content[1]).toMatchObject({ text: 'erful' });
    expect(ends(host)).toEqual({ anchor: 15, focus: 10 });

    select(host, 15, 10);
    editor.toggleMark('bold');
    expect(ends(host)).toEqual({ anchor: 15, focus: 10 });

    select(host, 15, 10);
    expect(editor.setLink(null)).toBe(true);
    expect(ends(host)).toEqual({ anchor: 15, focus: 10 });
  });

  test('and dismissing the dialog puts it back the way it was made', () => {
    const editor = mount([block({ id: 'x', content: text('Read this today please') })]);
    const host = hostOf(editor, 'x');
    select(host, 15, 10);

    press(host, 'k', MOD);
    dialogInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(ends(host)).toEqual({ anchor: 15, focus: 10 });
  });
});
