// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';

import type { Block } from './index.ts';
import { blockText, createEditor, withHiddenDescendants } from './index.ts';
import type { NEditor } from './editor.ts';

/**
 * The two block orderings.
 *
 * `#blocks` is every block in the document; `#visible()` leaves out everything
 * inside a collapsed toggle. They are different sequences, so an index taken
 * from one and read in the other lands on an unrelated block — and because
 * `findBlockIndex` answers -1 for a block it cannot see, `list[-1 + 1]` used to
 * resolve to the very first block of the document rather than fail.
 *
 * The rule these tests hold to: selection anchors live in visible space, hidden
 * descendants are pulled in only at the moment of the edit.
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

const depths = (editor: NEditor): number[] => editor.getDocument().blocks.map((b) => b.depth);

const idFor = (editor: NEditor, text: string): string =>
  editor.getDocument().blocks.find((b) => blockText(b) === text)!.id;

const selectedText = (editor: NEditor): string[] => {
  const doc = editor.getDocument();

  return editor.getSelectedBlocks().map((id) => blockText(doc.blocks.find((b) => b.id === id)!));
};

function caretTo(host: HTMLElement, offset: number | 'end'): void {
  host.focus();
  const range = document.createRange();
  range.selectNodeContents(host);
  range.collapse(offset !== 'end');

  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function press(host: HTMLElement | Element, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  host.dispatchEvent(event);

  return event.defaultPrevented;
}

/** A collapsed toggle holding one hidden child, with a paragraph either side. */
function nested(): Block[] {
  return [
    block({ content: [{ text: 'first' }] }),
    block({ type: 'toggle', collapsed: true, content: [{ text: 'toggle' }] }),
    block({ depth: 1, content: [{ text: 'hidden' }] }),
    block({ content: [{ text: 'last' }] }),
  ];
}

describe('a selection only grows to cover what it actually hides', () => {
  test('an expanded toggle does not drag a nested toggle’s children out from under it', () => {
    const blocks = [
      block({ type: 'toggle', collapsed: false, content: [{ text: 'outer' }] }),
      block({ type: 'toggle', collapsed: true, depth: 1, content: [{ text: 'inner' }] }),
      block({ depth: 2, content: [{ text: 'grandchild' }] }),
    ];

    const grown = withHiddenDescendants(blocks, [blocks[0]!.id]);

    // The old rule tested every descendant against the document-wide hidden
    // set, so it picked up the grandchild while skipping the collapsed toggle
    // that actually hides it — an orphan waiting to happen.
    expect(grown.has(blocks[2]!.id)).toBe(grown.has(blocks[1]!.id));
    expect([...grown]).toEqual([blocks[0]!.id]);
  });

  test('a collapsed toggle still carries everything it hides', () => {
    const blocks = [
      block({ type: 'toggle', collapsed: true, content: [{ text: 'outer' }] }),
      block({ type: 'toggle', collapsed: true, depth: 1, content: [{ text: 'inner' }] }),
      block({ depth: 2, content: [{ text: 'grandchild' }] }),
      block({ content: [{ text: 'after' }] }),
    ];

    const grown = withHiddenDescendants(blocks, [blocks[0]!.id]);

    expect([...grown].sort()).toEqual([blocks[0]!.id, blocks[1]!.id, blocks[2]!.id].sort());
  });

  test('deleting an expanded toggle never destroys a block nested two levels down', () => {
    const editor = mount([
      block({ type: 'toggle', collapsed: false, content: [{ text: 'outer' }] }),
      block({ type: 'toggle', collapsed: true, depth: 1, content: [{ text: 'inner' }] }),
      block({ depth: 2, content: [{ text: 'grandchild' }] }),
    ]);

    editor.selectBlocks([idFor(editor, 'outer')]);
    press(editor.element, 'Backspace');

    // The grandchild was never selected and cannot even be seen; deleting the
    // outer toggle must not take it while leaving its own parent behind.
    expect(texts(editor)).toEqual(['inner', 'grandchild']);
  });
});

describe('arrow keys walk the blocks a reader can see', () => {
  test('ArrowDown on a collapsed toggle steps to the next visible block', () => {
    const editor = mount(nested());
    editor.selectBlocks([idFor(editor, 'toggle')]);

    press(editor.element, 'ArrowDown');

    // The moving edge used to be the hidden child, which is nowhere in the
    // visible list — so the step landed on the first block of the document.
    expect(selectedText(editor)).toEqual(['last']);
  });

  test('ArrowUp on a collapsed toggle steps to the previous visible block', () => {
    const editor = mount(nested());
    editor.selectBlocks([idFor(editor, 'toggle')]);

    press(editor.element, 'ArrowUp');

    expect(selectedText(editor)).toEqual(['first']);
  });

  test('Shift+ArrowDown on a collapsed toggle extends downward, not upward', () => {
    const editor = mount(nested());
    editor.selectBlocks([idFor(editor, 'toggle')]);

    press(editor.element, 'ArrowDown', { shiftKey: true });

    expect(selectedText(editor)).toEqual(['toggle', 'last']);
  });

  test('Backspace only deletes blocks the selection actually highlighted', () => {
    const editor = mount(nested());
    editor.selectBlocks([idFor(editor, 'toggle')]);

    press(editor.element, 'ArrowDown', { shiftKey: true });
    press(editor.element, 'Backspace');

    // 'first' was never highlighted, so it must survive.
    expect(texts(editor)).toEqual(['first']);
  });

  test('Shift+ArrowUp from text below a collapsed toggle selects the toggle, not its child', () => {
    const editor = mount(nested());
    const last = hosts(editor).at(-1)!;
    caretTo(last, 0);

    press(last, 'ArrowUp', { shiftKey: true });

    expect(selectedText(editor)).toEqual(['toggle', 'last']);
  });

  test('Shift+ArrowDown from text above a collapsed toggle stops at the toggle', () => {
    const editor = mount(nested());
    const first = hosts(editor)[0]!;
    caretTo(first, 'end');

    press(first, 'ArrowDown', { shiftKey: true });

    expect(selectedText(editor)).toEqual(['first', 'toggle']);
  });
});

describe('moving a block steps over a collapsed toggle, never into it', () => {
  test('Cmd+Shift+Down on a collapsed toggle carries its hidden child', () => {
    const editor = mount(nested().slice(1));
    const toggle = hosts(editor)[0]!;
    caretTo(toggle, 'end');

    press(toggle, 'ArrowDown', { metaKey: true, shiftKey: true });

    // Swapping with the next entry of the flat array swapped the toggle with
    // its own child, which then popped out as a visible top-level block.
    expect(texts(editor)).toEqual(['last', 'toggle', 'hidden']);
    expect(depths(editor)).toEqual([0, 0, 1]);
  });

  test('Cmd+Shift+Up past a collapsed toggle clears it rather than landing inside', () => {
    const editor = mount(nested().slice(1));
    const last = hosts(editor).at(-1)!;
    caretTo(last, 'end');

    press(last, 'ArrowUp', { metaKey: true, shiftKey: true });

    expect(texts(editor)).toEqual(['last', 'toggle', 'hidden']);
    expect(depths(editor)).toEqual([0, 0, 1]);
  });

  test('Cmd+Shift+Down on a selected collapsed toggle carries its hidden child', () => {
    const editor = mount(nested().slice(1));
    editor.selectBlocks([idFor(editor, 'toggle')]);

    press(editor.element, 'ArrowDown', { metaKey: true, shiftKey: true });

    expect(texts(editor)).toEqual(['last', 'toggle', 'hidden']);
    expect(depths(editor)).toEqual([0, 0, 1]);
  });

  test('a move that has nowhere to go changes nothing and costs no undo step', () => {
    const editor = mount(nested().slice(1));
    let changes = 0;
    editor.on('change', () => {
      changes += 1;
    });

    editor.selectBlocks([idFor(editor, 'toggle')]);
    press(editor.element, 'ArrowUp', { metaKey: true, shiftKey: true });

    expect(changes).toBe(0);
    expect(texts(editor)).toEqual(['toggle', 'hidden', 'last']);
  });

  test('Cmd+Shift+Up with a block selected below a collapsed toggle clears the whole toggle', () => {
    const editor = mount(nested().slice(1));
    editor.selectBlocks([idFor(editor, 'last')]);

    press(editor.element, 'ArrowUp', { metaKey: true, shiftKey: true });

    expect(texts(editor)).toEqual(['last', 'toggle', 'hidden']);
    expect(depths(editor)).toEqual([0, 0, 1]);
  });
});

describe('dragging a collapsed toggle takes its hidden children with it', () => {
  test('a handle drag moves the whole subtree', () => {
    const editor = mount(nested().slice(1));
    const target = editor.element.querySelector('.neditor-block')!;

    target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerId: 3 }));

    const handle = editor.element.querySelector('.neditor-gutter__handle')!;
    handle.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: 3,
        button: 0,
        clientY: 0,
      }),
    );
    document.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerId: 3, clientY: 400 }),
    );
    document.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, pointerId: 3, clientY: 400 }),
    );

    // The drag used to start from a bare `new Set([blockId])`, so the child was
    // left behind and re-parented under whatever ended up above it.
    expect(texts(editor)).toEqual(['last', 'toggle', 'hidden']);
    expect(depths(editor)).toEqual([0, 0, 1]);
  });
});

describe('editing a block selection expands to the hidden children', () => {
  test('deleting a selected collapsed toggle takes its child', () => {
    const editor = mount(nested());
    editor.selectBlocks([idFor(editor, 'toggle')]);

    press(editor.element, 'Backspace');

    expect(texts(editor)).toEqual(['first', 'last']);
  });

  test('typing over a selected collapsed toggle takes its child', () => {
    const editor = mount(nested());
    editor.selectBlocks([idFor(editor, 'toggle')]);

    press(editor.element, 'x');

    expect(texts(editor)).toEqual(['first', 'x', 'last']);
  });

  test('copying a collapsed toggle copies what it hides', () => {
    const editor = mount(nested());
    editor.selectBlocks([idFor(editor, 'toggle')]);

    const data = new DataTransfer();
    editor.element.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
    );

    expect(data.getData('text/plain')).toContain('hidden');
  });

  test('Tab on a selected collapsed toggle indents its child too', () => {
    const editor = mount(nested());
    editor.selectBlocks([idFor(editor, 'toggle')]);

    press(editor.element, 'Tab');

    expect(depths(editor)).toEqual([0, 1, 2, 0]);
  });

  test('duplicating a collapsed toggle leaves only visible blocks selected', () => {
    const editor = mount(nested());
    editor.selectBlocks([idFor(editor, 'toggle')]);

    press(editor.element, 'd', { metaKey: true });

    expect(texts(editor)).toEqual(['first', 'toggle', 'hidden', 'toggle', 'hidden', 'last']);
    expect(editor.getSelectedBlocks()).toHaveLength(1);
  });
});

describe('the selection never holds a block the reader cannot see', () => {
  test('selectBlocks ignores a hidden id', () => {
    const editor = mount(nested());

    editor.selectBlocks([idFor(editor, 'hidden')]);

    expect(editor.getSelectedBlocks()).toEqual([]);
  });

  test('Select All selects only visible blocks', () => {
    const editor = mount(nested());
    editor.selectBlocks([idFor(editor, 'first')]);

    press(editor.element, 'a', { metaKey: true });

    expect(selectedText(editor)).toEqual(['first', 'toggle', 'last']);
  });

  test('collapsing a toggle over a selected child drops it from the selection', () => {
    const editor = mount([
      block({ type: 'toggle', collapsed: false, content: [{ text: 'toggle' }] }),
      block({ depth: 1, content: [{ text: 'child' }] }),
      block({ content: [{ text: 'last' }] }),
    ]);

    editor.selectBlocks([idFor(editor, 'child')]);
    editor.toggleCollapsed(idFor(editor, 'toggle'));

    // The child is off screen now, so it is no longer something the next
    // keystroke may act on — otherwise Backspace deletes a block nobody can see.
    expect(editor.getSelectedBlocks()).toEqual([]);

    press(editor.element, 'Backspace');

    expect(texts(editor)).toEqual(['toggle', 'child', 'last']);
  });
});
