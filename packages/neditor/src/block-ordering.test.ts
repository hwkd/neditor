// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { Block } from './index.ts';
import { blockText, createEditor, withHiddenDescendants } from './index.ts';
import type { NEditor } from './editor.ts';
import { MAX_DEPTH } from './model/document.ts';

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

/** The rendered host showing `text`: a reader can only press keys in a block on screen. */
const hostOf = (editor: NEditor, text: string): HTMLElement =>
  hosts(editor).find((h) => h.textContent === text)!;

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

  /*
   * R14-RV4B-1: the release is heard in the document's capture phase, so a
   * page that stops it above the editor (a container with drag handling of
   * its own) cannot leave the drag live. Heard in the bubble phase, a
   * stopped `pointerup` never dropped the block, and a stopped
   * `pointercancel` left the drag to commit at a later, unrelated release.
   * The real browsers' versions are pinned in S6b and TO4c.
   */
  describe('on a page that stops the release above the editor', () => {
    const dragOver = (stopped: string, end: () => void) => {
      const stage = document.createElement('div');
      document.body.append(stage);
      stage.addEventListener(stopped, (event) => {
        event.stopPropagation();
      });
      const host = document.createElement('div');
      stage.append(host);
      const editor = createEditor({ element: host, doc: { blocks: nested().slice(1) } });
      editors.push(editor);
      editor.element
        .querySelector('.neditor-block')!
        .dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerId: 3 }));
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
      expect(editor.element.dataset.dragging).toBe('true');
      end();

      return { editor, handle };
    };

    test('a stopped pointerup still drops the block', () => {
      const { editor } = dragOver('pointerup', () => {
        document
          .querySelector('.neditor-gutter__handle')!
          .dispatchEvent(
            new PointerEvent('pointerup', { bubbles: true, pointerId: 3, clientY: 400 }),
          );
      });

      expect(editor.element.dataset.dragging).not.toBe('true');
      expect(texts(editor)).toEqual(['last', 'toggle', 'hidden']);
    });

    test('a stopped pointercancel still ends the drag, and a later release moves nothing', () => {
      const { editor, handle } = dragOver('pointercancel', () => {
        document
          .querySelector('.neditor-gutter__handle')!
          .dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 3 }));
      });

      expect(editor.element.dataset.dragging).not.toBe('true');
      handle.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, pointerId: 3, clientY: 400 }),
      );
      expect(texts(editor)).toEqual(['toggle', 'hidden', 'last']);
    });
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

/**
 * Round 10 of the math audit (not a math defect). Removing blocks above a
 * collapsed toggle can pull the toggle shallower, and the depth re-clamp used
 * to look only at the block immediately above: the toggle's hidden child came
 * up one level with it, but the toggle's *sibling* after that run stayed where
 * it was -- now one level deeper than the toggle, so inside it. The block
 * vanished under a collapsed toggle it had never been part of, and the reader
 * had no way to tell where it went.
 */
describe('a re-clamp never hides a block under a collapsed toggle', () => {
  const visibleText = (editor: NEditor): string[] => hosts(editor).map((h) => h.textContent ?? '');

  /** `parent > toggle (collapsed) > hidden`, then `sibling` beside the toggle. */
  function underParent(): Block[] {
    return [
      block({ content: [{ text: 'root' }] }),
      block({ depth: 1, content: [{ text: 'parent' }] }),
      block({ depth: 2, type: 'toggle', collapsed: true, content: [{ text: 'toggle' }] }),
      block({ depth: 3, content: [{ text: 'hidden' }] }),
      block({ depth: 2, content: [{ text: 'sibling' }] }),
    ];
  }

  /** The same shape one level down, under a `branch > leaf` pair to select. */
  function underBranch(): Block[] {
    return [
      block({ content: [{ text: 'root' }] }),
      block({ depth: 1, content: [{ text: 'branch' }] }),
      block({ depth: 2, content: [{ text: 'leaf' }] }),
      block({ depth: 3, type: 'toggle', collapsed: true, content: [{ text: 'toggle' }] }),
      block({ depth: 4, content: [{ text: 'hidden' }] }),
      block({ depth: 3, content: [{ text: 'sibling' }] }),
    ];
  }

  test('deleting the parent keeps the sibling beside the toggle', () => {
    const editor = mount(underParent());
    editor.selectBlocks([idFor(editor, 'parent')]);

    press(editor.element, 'Backspace');

    expect(texts(editor)).toEqual(['root', 'toggle', 'hidden', 'sibling']);
    expect(depths(editor)).toEqual([0, 1, 2, 1]);
    expect(visibleText(editor)).toEqual(['root', 'toggle', 'sibling']);
  });

  test('pasting fewer, shallower blocks over the selection keeps it too', () => {
    const editor = mount(underBranch());
    editor.selectBlocks([idFor(editor, 'branch'), idFor(editor, 'leaf')]);

    const data = new DataTransfer();
    data.setData('text/plain', 'pasted');
    editor.element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );

    expect(texts(editor)).toEqual(['root', 'pasted', 'toggle', 'hidden', 'sibling']);
    expect(depths(editor)).toEqual([0, 1, 2, 3, 2]);
    expect(visibleText(editor)).toEqual(['root', 'pasted', 'toggle', 'sibling']);
  });

  test('typing over the selection keeps it too', () => {
    const editor = mount(underBranch());
    editor.selectBlocks([idFor(editor, 'branch'), idFor(editor, 'leaf')]);

    press(editor.element, 'x');

    expect(texts(editor)).toEqual(['root', 'x', 'toggle', 'hidden', 'sibling']);
    expect(depths(editor)).toEqual([0, 1, 2, 3, 2]);
    expect(visibleText(editor)).toEqual(['root', 'x', 'toggle', 'sibling']);
  });

  test('undo brings the original shape back in one step', () => {
    const editor = mount(underParent());
    editor.selectBlocks([idFor(editor, 'parent')]);
    press(editor.element, 'Backspace');

    editor.undo();

    expect(texts(editor)).toEqual(['root', 'parent', 'toggle', 'hidden', 'sibling']);
    expect(depths(editor)).toEqual([0, 1, 2, 3, 2]);
    expect(editor.canUndo).toBe(false);
  });
});

describe("moving a block past a sibling takes it past the sibling's children", () => {
  const collapsed = (editor: NEditor, text: string): boolean | undefined =>
    editor.getDocument().blocks.find((b) => blockText(b) === text)?.collapsed;

  test('down past a parent', () => {
    const editor = mount([
      block({ type: 'toggle', collapsed: true, content: [{ text: 'T' }] }),
      block({ depth: 1, content: [{ text: 'H' }] }),
      block({ content: [{ text: 'P' }] }),
      block({ depth: 1, content: [{ text: 'C' }] }),
    ]);
    caretTo(hostOf(editor, 'T'), 0);

    press(hostOf(editor, 'T'), 'ArrowDown', { metaKey: true, shiftKey: true });

    expect(texts(editor)).toEqual(['P', 'C', 'T', 'H']);
    expect(depths(editor)).toEqual([0, 1, 0, 1]);
    expect(collapsed(editor, 'T')).toBe(true);
  });

  test('up past a parent', () => {
    const editor = mount([
      block({ content: [{ text: 'P' }] }),
      block({ depth: 1, content: [{ text: 'C' }] }),
      block({ type: 'toggle', collapsed: true, content: [{ text: 'T' }] }),
      block({ depth: 1, content: [{ text: 'H' }] }),
    ]);
    caretTo(hostOf(editor, 'T'), 0);

    press(hostOf(editor, 'T'), 'ArrowUp', { metaKey: true, shiftKey: true });

    expect(texts(editor)).toEqual(['T', 'H', 'P', 'C']);
    expect(depths(editor)).toEqual([0, 1, 0, 1]);
    expect(collapsed(editor, 'T')).toBe(true);
  });

  // The other half of the rule, which already held: a block shallower than
  // the mover is one slot, which is how a block leaves its list.
  test('a child still moves out of its list one slot at a time', () => {
    const editor = mount([
      block({ content: [{ text: 'P' }] }),
      block({ depth: 1, content: [{ text: 'C' }] }),
      block({ content: [{ text: 'N' }] }),
    ]);
    caretTo(hostOf(editor, 'C'), 0);

    press(hostOf(editor, 'C'), 'ArrowDown', { metaKey: true, shiftKey: true });

    expect(texts(editor)).toEqual(['P', 'N', 'C']);
  });

  test('a block below that is shallower than the mover is passed one slot', () => {
    const editor = mount([
      block({ content: [{ text: 'A' }] }),
      block({ depth: 1, content: [{ text: 'a1' }] }),
      block({ content: [{ text: 'B' }] }),
      block({ depth: 1, content: [{ text: 'b1' }] }),
    ]);
    caretTo(hostOf(editor, 'a1'), 0);

    press(hostOf(editor, 'a1'), 'ArrowDown', { metaKey: true, shiftKey: true });

    expect(texts(editor)).toEqual(['A', 'B', 'a1', 'b1']);
    expect(depths(editor)).toEqual([0, 0, 1, 1]);
  });
});

describe("moves and duplicates are measured from the selection's root", () => {
  test('a selection ending on a header steps over the next section whole', () => {
    const editor = mount([
      block({ content: [{ text: 'A' }] }),
      block({ depth: 1, content: [{ text: 'a1' }] }),
      block({ depth: 1, content: [{ text: 'a2' }] }),
      block({ type: 'toggle', collapsed: true, content: [{ text: 'B' }] }),
      block({ depth: 1, content: [{ text: 'b1' }] }),
      block({ type: 'toggle', content: [{ text: 'C' }] }),
      block({ depth: 1, content: [{ text: 'c1' }] }),
    ]);
    editor.selectBlocks([idFor(editor, 'a2'), idFor(editor, 'B')]);

    press(editor.element, 'ArrowDown', { metaKey: true, shiftKey: true });

    expect(texts(editor)).toEqual(['A', 'a1', 'C', 'c1', 'a2', 'B', 'b1']);
    expect(editor.getDocument().blocks[5]?.collapsed).toBe(true);
  });

  test('a nested item moves up past its sibling, staying in its list', () => {
    const editor = mount([
      block({ content: [{ text: 'R' }] }),
      block({ depth: 1, content: [{ text: 's1' }] }),
      block({ depth: 1, content: [{ text: 's2' }] }),
    ]);
    caretTo(hostOf(editor, 's2'), 0);

    press(hostOf(editor, 's2'), 'ArrowUp', { metaKey: true, shiftKey: true });

    expect(texts(editor)).toEqual(['R', 's2', 's1']);
    expect(depths(editor)).toEqual([0, 1, 1]);
  });

  test('a parent moving down passes its first child and keeps its second', () => {
    const editor = mount([
      block({ type: 'toggle', content: [{ text: 'A' }] }),
      block({ depth: 1, content: [{ text: 'a1' }] }),
      block({ depth: 1, content: [{ text: 'a2' }] }),
      block({ content: [{ text: 'B' }] }),
    ]);
    caretTo(hostOf(editor, 'A'), 0);

    press(hostOf(editor, 'A'), 'ArrowDown', { metaKey: true, shiftKey: true });

    expect(texts(editor)).toEqual(['a1', 'A', 'a2', 'B']);
    expect(depths(editor)).toEqual([0, 0, 1, 0]);
  });

  test('duplicating an item and the header after it does not hand the copy to the header', () => {
    const editor = mount([
      block({ content: [{ text: 'A' }] }),
      block({ depth: 1, content: [{ text: 'a1' }] }),
      block({ depth: 1, content: [{ text: 'a2' }] }),
      block({ type: 'toggle', collapsed: true, content: [{ text: 'B' }] }),
      block({ depth: 1, content: [{ text: 'b1' }] }),
      block({ content: [{ text: 'Z' }] }),
    ]);
    editor.selectBlocks([idFor(editor, 'a2'), idFor(editor, 'B')]);

    press(editor.element, 'd', { metaKey: true });

    const blocks = editor.getDocument().blocks;
    expect(blocks.map(blockText)).toEqual(['A', 'a1', 'a2', 'B', 'b1', 'a2', 'B', 'b1', 'Z']);
    expect(blocks.map((b) => b.depth)).toEqual([0, 1, 1, 0, 1, 0, 0, 1, 0]);
    expect(blocks[3]?.collapsed).toBe(true);
    // The copies are what is selected, the copied toggle still folded.
    expect(blocks[6]?.collapsed).toBe(true);
    expect(editor.getSelectedBlocks()).toEqual([blocks[5]!.id, blocks[6]!.id]);
  });
});

describe('a move down steps over the next block with everything under it', () => {
  test('an unselected child of a selected block is passed with its own children', () => {
    const editor = mount([
      block({ content: [{ text: 'P' }] }),
      block({ type: 'bulleted_list', depth: 1, content: [{ text: 'a' }] }),
      block({ type: 'toggle', content: [{ text: 'B' }] }),
      block({ type: 'bulleted_list', depth: 1, content: [{ text: 'c' }] }),
      block({ type: 'bulleted_list', depth: 2, content: [{ text: 'cx' }] }),
      block({ content: [{ text: 'Z' }] }),
    ]);
    editor.selectBlocks([idFor(editor, 'a'), idFor(editor, 'B')]);

    press(editor.element, 'ArrowDown', { metaKey: true, shiftKey: true });

    expect(texts(editor)).toEqual(['P', 'c', 'cx', 'a', 'B', 'Z']);
    expect(depths(editor)).toEqual([0, 1, 2, 1, 0, 0]);
  });

  test("a parent passes its first child together with that child's own child", () => {
    const editor = mount([
      block({ type: 'toggle', content: [{ text: 'A' }] }),
      block({ depth: 1, content: [{ text: 'a1' }] }),
      block({ depth: 2, content: [{ text: 'a1x' }] }),
      block({ depth: 1, content: [{ text: 'a2' }] }),
      block({ content: [{ text: 'B' }] }),
    ]);
    const host = hosts(editor)[0]!;
    caretTo(host, 0);

    press(host, 'ArrowDown', { metaKey: true, shiftKey: true });

    expect(texts(editor)).toEqual(['a1', 'a1x', 'A', 'a2', 'B']);
    expect(depths(editor)).toEqual([0, 1, 0, 1, 0]);
  });

  test('up: measured from the shallowest selected block, not the first', () => {
    const editor = mount([
      block({ content: [{ text: 'Q' }] }),
      block({ content: [{ text: 'P' }] }),
      block({ depth: 1, content: [{ text: 'p' }] }),
      block({ depth: 1, content: [{ text: 'x' }] }),
      block({ type: 'toggle', content: [{ text: 'H' }] }),
      block({ depth: 1, content: [{ text: 'h' }] }),
      block({ content: [{ text: 'N' }] }),
    ]);
    editor.selectBlocks([idFor(editor, 'x'), idFor(editor, 'H'), idFor(editor, 'h')]);

    press(editor.element, 'ArrowUp', { metaKey: true, shiftKey: true });

    expect(texts(editor)).toEqual(['Q', 'x', 'H', 'h', 'P', 'p', 'N']);
    expect(depths(editor)).toEqual([0, 1, 0, 1, 0, 1, 0]);
  });

  test('down: measured from the shallowest selected block, not the last', () => {
    const editor = mount([
      block({ content: [{ text: 'P' }] }),
      block({ depth: 1, content: [{ text: 'x' }] }),
      block({ type: 'toggle', content: [{ text: 'H' }] }),
      block({ depth: 1, content: [{ text: 'h' }] }),
      block({ content: [{ text: 'N' }] }),
      block({ depth: 1, content: [{ text: 'n' }] }),
      block({ content: [{ text: 'Z' }] }),
    ]);
    editor.selectBlocks([idFor(editor, 'x'), idFor(editor, 'H'), idFor(editor, 'h')]);

    press(editor.element, 'ArrowDown', { metaKey: true, shiftKey: true });

    expect(texts(editor)).toEqual(['P', 'N', 'n', 'x', 'H', 'h', 'Z']);
    expect(depths(editor)).toEqual([0, 0, 1, 1, 0, 1, 0]);
  });
});

describe('Tab indents every selected block that can', () => {
  test('a selection indents every block that can, under the first', () => {
    const editor = mount([
      block({ content: [{ text: 'A' }] }),
      block({ content: [{ text: 'B' }] }),
      block({ content: [{ text: 'C' }] }),
    ]);
    editor.selectBlocks(editor.getDocument().blocks.map((b) => b.id));

    press(editor.element, 'Tab');

    expect(depths(editor)).toEqual([0, 1, 1]);
  });

  test('a selection under a block that cannot move still indents the rest', () => {
    const editor = mount([
      block({ content: [{ text: 'a' }] }),
      block({ depth: 1, content: [{ text: 'b' }] }),
      block({ depth: 1, content: [{ text: 'c' }] }),
      block({ depth: 2, content: [{ text: 'd' }] }),
      block({ depth: 1, content: [{ text: 'e' }] }),
    ]);
    editor.selectBlocks([idFor(editor, 'b'), idFor(editor, 'c')]);

    press(editor.element, 'Tab');

    // b cannot go under a, which already holds it; c goes under b. d, c's
    // child, was not selected and keeps its depth, so it is now c's sibling
    // -- as Tab on c alone leaves it: a visible child moves only when selected.
    expect(depths(editor)).toEqual([0, 1, 2, 2, 1]);
  });
});

/**
 * `indentBlocks` hands back a block it cannot move as the same object, and
 * `sameBlocks` tells a no-op from an edit by reference. Both Tab paths already
 * compare depths before committing, so a rebuilt-but-equal block never reached
 * `#commit` from them; these pin that a Tab that moves nothing is no edit at
 * the editor's surface, whichever of the two guards answers.
 */
describe('a Tab that moves nothing is no edit', () => {
  const ceiling = (): Block[] => [
    ...Array.from({ length: MAX_DEPTH + 1 }, (_, i) =>
      block({ depth: i, content: [{ text: `b${i}` }] }),
    ),
    block({ depth: MAX_DEPTH, content: [{ text: 'c' }] }),
  ];

  function watch(editor: NEditor): () => number {
    let changes = 0;
    editor.on('change', () => {
      changes += 1;
    });

    return () => changes;
  }

  test('from the caret in a block at the ceiling beside a sibling', () => {
    const editor = mount(ceiling());
    const changes = watch(editor);
    const host = hosts(editor).at(-1)!;
    caretTo(host, 0);

    expect(press(host, 'Tab')).toBe(false);
    expect(depths(editor).at(-1)).toBe(MAX_DEPTH);
    expect(changes()).toBe(0);
    expect(editor.canUndo).toBe(false);
  });

  test('over a selected block at the ceiling beside a sibling', () => {
    const editor = mount(ceiling());
    const changes = watch(editor);
    editor.selectBlocks([idFor(editor, 'c')]);

    expect(press(editor.element, 'Tab')).toBe(false);
    expect(depths(editor).at(-1)).toBe(MAX_DEPTH);
    expect(changes()).toBe(0);
    expect(editor.canUndo).toBe(false);
  });

  test('over a selected first item that has a child', () => {
    const editor = mount([
      block({ content: [{ text: 'Item1' }] }),
      block({ depth: 1, content: [{ text: 'Sub' }] }),
    ]);
    const changes = watch(editor);
    editor.selectBlocks([idFor(editor, 'Item1')]);

    expect(press(editor.element, 'Tab')).toBe(false);
    expect(depths(editor)).toEqual([0, 1]);
    expect(changes()).toBe(0);
    expect(editor.canUndo).toBe(false);
  });
});

describe('a move with a gap in its selection takes no block from its parent', () => {
  test('down: a block whose parent sat in the gap stays with that parent', () => {
    const editor = mount([
      block({ content: [{ text: 'a' }] }),
      block({ content: [{ text: 'b' }] }),
      block({ depth: 1, content: [{ text: 'c' }] }),
      block({ depth: 1, content: [{ text: 'd' }] }),
      block({ depth: 1, content: [{ text: 'e' }] }),
    ]);
    editor.selectBlocks([idFor(editor, 'a'), idFor(editor, 'c')]);

    press(editor.element, 'ArrowDown', { metaKey: true, shiftKey: true });

    // d and e were b's children and still are: a and c land after them.
    expect(texts(editor)).toEqual(['b', 'd', 'e', 'a', 'c']);
    expect(depths(editor)).toEqual([0, 1, 1, 0, 1]);
  });
});

describe('a block-selection move brings the end it moves into view', () => {
  function revealed(run: () => void): string[] {
    const shown: string[] = [];
    const spy = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(function (this: HTMLElement) {
        const id = this.closest('[data-block-id]')?.getAttribute('data-block-id');

        if (id) {
          shown.push(id);
        }
      });

    try {
      run();
    } finally {
      spy.mockRestore();
    }

    return shown;
  }

  // One step can pass a whole section now, so the selection can land well
  // past the window's edge; happy-dom has no layout, so what is pinned is
  // which block is asked to come into view, last.
  const doc = (): Block[] => [
    block({ content: [{ text: 'P' }] }),
    block({ content: [{ text: 'Q' }] }),
    block({ type: 'toggle', content: [{ text: 'T' }] }),
    ...Array.from({ length: 5 }, (_, i) => block({ depth: 1, content: [{ text: `t${i}` }] })),
  ];

  test('down: the last selected block', () => {
    const editor = mount(doc());
    editor.selectBlocks([idFor(editor, 'P'), idFor(editor, 'Q')]);

    const shown = revealed(() =>
      press(editor.element, 'ArrowDown', { metaKey: true, shiftKey: true }),
    );

    expect(texts(editor).slice(-2)).toEqual(['P', 'Q']);
    expect(shown.at(-1)).toBe(idFor(editor, 'Q'));
  });

  test('up: the first selected block', () => {
    const editor = mount([...doc().slice(2), ...doc().slice(0, 2)]);
    editor.selectBlocks([idFor(editor, 'P'), idFor(editor, 'Q')]);

    const shown = revealed(() =>
      press(editor.element, 'ArrowUp', { metaKey: true, shiftKey: true }),
    );

    expect(texts(editor).slice(0, 2)).toEqual(['P', 'Q']);
    expect(shown.at(-1)).toBe(idFor(editor, 'P'));
  });
});

describe('Tab at the depth ceiling leaves a selected parent with its selected child', () => {
  test('a parent and its collapsed toggle child stay put when the toggle cannot indent', () => {
    // c30 lets R indent under it, but R carries T, and T carries the hidden
    // h past MAX_DEPTH: none of them may move.
    const editor = mount([
      ...Array.from({ length: MAX_DEPTH - 1 }, (_, i) =>
        block({ depth: i, content: [{ text: `c${i}` }] }),
      ),
      block({ depth: MAX_DEPTH - 2, content: [{ text: 'R' }] }),
      block({
        type: 'toggle',
        collapsed: true,
        depth: MAX_DEPTH - 1,
        content: [{ text: 'T' }],
      }),
      block({ depth: MAX_DEPTH, content: [{ text: 'h' }] }),
    ]);
    const before = depths(editor);
    editor.selectBlocks([idFor(editor, 'R'), idFor(editor, 'T')]);

    expect(press(editor.element, 'Tab')).toBe(false);
    expect(depths(editor)).toEqual(before);
    expect(editor.canUndo).toBe(false);
  });
});
