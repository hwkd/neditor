// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';

import type { Block } from './index.ts';
import { blockText, createEditor } from './index.ts';
import type { NEditor } from './editor.ts';

/**
 * The editor has exactly two selection modes: a text caret, and a selection of
 * whole blocks. They are mutually exclusive, and nothing used to enforce it.
 *
 * Both live at once and the next printable key is routed by the invisible
 * block selection, which replaces blocks the reader no longer knows are
 * selected. Neither live — a caret that could not be placed, a block selection
 * dropped without one — and the editor swallows every key instead.
 *
 * The rule these tests hold to: entering one mode leaves the other, placing a
 * caret reports whether it worked, and an empty block selection is no block
 * selection at all rather than a mode with nothing in it.
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

const texts = (editor: NEditor): string[] => editor.getDocument().blocks.map(blockText);

const idFor = (editor: NEditor, text: string): string =>
  editor.getDocument().blocks.find((b) => blockText(b) === text)!.id;

const hosts = (editor: NEditor): HTMLElement[] => [
  ...editor.element.querySelectorAll<HTMLElement>('.neditor-block__content'),
];

const live = (editor: NEditor): string | null | undefined =>
  editor.element.querySelector('.neditor-live-region')?.textContent;

function press(host: Element, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  host.dispatchEvent(event);

  return event.defaultPrevented;
}

/** Clicks the drag handle of the block the pointer last hovered. */
function clickHandle(editor: NEditor, index: number, init: MouseEventInit = {}): void {
  const target = editor.element.querySelectorAll('.neditor-block')[index]!;
  target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerId: 7 }));
  editor.element
    .querySelector('.neditor-gutter__handle')!
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
}

function abc(): Block[] {
  return [
    block({ content: [{ text: 'a' }] }),
    block({ content: [{ text: 'b' }] }),
    block({ content: [{ text: 'c' }] }),
  ];
}

describe('placing a caret leaves block selection', () => {
  test('a printable key after focus() types instead of deleting the selection', () => {
    const editor = mount(abc());
    editor.selectBlocks([idFor(editor, 'a'), idFor(editor, 'b')]);

    editor.focus(idFor(editor, 'c'), 1);

    // The caret is visibly in c, so the key belongs to c. Routed by the block
    // selection nobody could see any more, it deleted a and b and replaced
    // them with a paragraph holding the character.
    expect(editor.getSelectedBlocks()).toEqual([]);
    press(hosts(editor)[2]!, 'x');
    expect(texts(editor)).toEqual(['a', 'b', 'c']);
  });

  test('focusRange() leaves it too', () => {
    const editor = mount(abc());
    editor.selectBlocks([idFor(editor, 'a'), idFor(editor, 'b')]);

    editor.focusRange(idFor(editor, 'c'), 0, 1);

    expect(editor.getSelectedBlocks()).toEqual([]);
    press(hosts(editor)[2]!, 'x');
    expect(texts(editor)).toEqual(['a', 'b', 'c']);
  });

  test('setBlockType() leaves it, having just put the caret in the block', () => {
    const editor = mount(abc());
    editor.selectBlocks([idFor(editor, 'a'), idFor(editor, 'b')]);

    editor.setBlockType(idFor(editor, 'c'), 'heading1');

    expect(editor.getSelectedBlocks()).toEqual([]);
    press(hosts(editor)[2]!, 'x');
    expect(texts(editor)).toEqual(['a', 'b', 'c']);
  });

  test('the block selection event fires when a caret takes over', () => {
    const editor = mount(abc());
    const seen: string[][] = [];
    editor.on('blockselection', ({ ids }) => seen.push(ids));

    editor.selectBlocks([idFor(editor, 'a')]);
    editor.focus(idFor(editor, 'c'));

    // An embedder driving its own block-selection UI has to hear the mode end,
    // or it paints a selection the editor no longer has.
    expect(seen).toEqual([[idFor(editor, 'a')], []]);
  });
});

describe('focus reports whether it placed a caret', () => {
  test('true for a block that can hold one', () => {
    const editor = mount(abc());

    expect(editor.focus(idFor(editor, 'b'))).toBe(true);
    expect(editor.focusRange(idFor(editor, 'b'), 0, 1)).toBe(true);
  });

  test('false for a block with no caret to give', () => {
    const editor = mount([
      block({ content: [{ text: 'a' }] }),
      block({ type: 'divider' }),
      block({ type: 'toggle', collapsed: true, content: [{ text: 'toggle' }] }),
      block({ depth: 1, content: [{ text: 'hidden' }] }),
    ]);
    const blocks = editor.getDocument().blocks;

    // A divider has no editable host, a block inside a collapsed toggle has no
    // rendered view at all, and an unknown id has neither. Silence let the
    // caller believe the editor was back in text mode.
    expect(editor.focus(blocks[1]!.id)).toBe(false);
    expect(editor.focus(idFor(editor, 'hidden'))).toBe(false);
    expect(editor.focus('no-such-block')).toBe(false);
    expect(editor.focusRange('no-such-block', 0, 1)).toBe(false);
  });

  test('a failed focus leaves the block selection it could not replace', () => {
    const editor = mount([block({ content: [{ text: 'a' }] }), block({ type: 'divider' })]);
    const dividerId = editor.getDocument().blocks[1]!.id;
    editor.selectBlocks([idFor(editor, 'a')]);

    expect(editor.focus(dividerId)).toBe(false);
    expect(editor.getSelectedBlocks()).toEqual([idFor(editor, 'a')]);
  });
});

describe('Enter always lands in one mode or the other', () => {
  test('it skips past a selected block that cannot hold a caret', () => {
    const editor = mount([
      block({ content: [{ text: 'a' }] }),
      block({ type: 'divider' }),
      block({ content: [{ text: 'c' }] }),
    ]);
    const blocks = editor.getDocument().blocks;
    editor.selectBlocks([blocks[0]!.id, blocks[1]!.id]);

    press(editor.element, 'Enter');

    // The selection ends on the divider, and Enter aimed straight at it: one
    // silent focus() later there was neither a caret nor a selection left.
    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(editor.getSelectionState()?.blockId).toBe(blocks[0]!.id);
  });

  test('a selection that can hold no caret at all keeps the selection', () => {
    const editor = mount([block({ type: 'divider' }), block({ content: [{ text: 'a' }] })]);
    const dividerId = editor.getDocument().blocks[0]!.id;
    editor.selectBlocks([dividerId]);

    press(editor.element, 'Enter');

    // Nowhere to put a caret, so block selection stands. Being in one mode
    // beats being in neither: Backspace still reaches the selected block.
    expect(editor.getSelectedBlocks()).toEqual([dividerId]);
    press(editor.element, 'Backspace');
    expect(texts(editor)).toEqual(['a']);
  });

  test('Enter on a selected collapsed toggle puts the caret in the toggle itself', () => {
    const editor = mount([
      block({ type: 'toggle', collapsed: true, content: [{ text: 'toggle' }] }),
      block({ depth: 1, content: [{ text: 'hidden' }] }),
    ]);
    editor.selectBlocks([idFor(editor, 'toggle')]);

    press(editor.element, 'Enter');

    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(editor.getSelectionState()?.blockId).toBe(idFor(editor, 'toggle'));
  });
});

describe('an empty block selection is no block selection', () => {
  test('deselecting the only selected block hands the caret back', () => {
    const editor = mount(abc());

    clickHandle(editor, 0);
    expect(editor.getSelectedBlocks()).toEqual([idFor(editor, 'a')]);

    clickHandle(editor, 0, { metaKey: true });

    // Neither mode: the root kept the focus with nothing selected and no
    // caret, and every keystroke fell on the floor.
    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(editor.getSelectionState()?.blockId).toBe(idFor(editor, 'a'));
  });

  test('it is announced as a sentence, not as "0 blocks selected"', () => {
    const editor = mount(abc());

    clickHandle(editor, 0);
    clickHandle(editor, 0, { metaKey: true });

    expect(live(editor)).toBe('No blocks selected');
  });

  test('the zero announcement is localisable like every other', () => {
    const editor = mount(abc(), { labels: { noBlocksSelected: 'Aucun bloc sélectionné' } });

    editor.selectBlocks([idFor(editor, 'a')]);
    editor.selectBlocks([]);

    expect(live(editor)).toBe('Aucun bloc sélectionné');
  });

  test('selectBlocks([]) returns to text editing, as documented', () => {
    const editor = mount(abc());
    editor.selectBlocks([idFor(editor, 'b')]);

    editor.selectBlocks([]);

    expect(editor.getSelectionState()?.blockId).toBe(idFor(editor, 'b'));
  });

  test('clearing a selection that never existed does not grab the focus', () => {
    const editor = mount(abc());

    editor.clearBlockSelection();

    // Nothing was selected, so this is not an exit from anywhere: an editor the
    // reader has not clicked into must not steal the caret, nor announce.
    expect(document.activeElement).toBe(document.body);
    expect(live(editor)).toBe('');
  });
});

describe('undoing an edit made in block-selection mode leaves somewhere to type', () => {
  /**
   * An edit made with blocks selected has no caret to record -- block selection
   * drops the range and focuses the root -- so the history entry carries a null
   * selection. `#travel` then clears the block selection and restores nothing,
   * leaving the root focused with neither a caret nor a selection. That is
   * neither mode: `#handleKeyDown` resolves nothing from the root and drops
   * every later keystroke, so the *second* Ctrl+Z did nothing and the editor
   * was dead until the user clicked back into it.
   *
   * `#setBlockSelection` already guards this exact dead end when the last block
   * is deselected, and says so in a comment. This is the other way in.
   */
  const moveDown = (editor: NEditor): void => {
    press(editor.element, 'ArrowDown', { metaKey: true, shiftKey: true });
  };

  test('a second undo still lands, rather than being swallowed', () => {
    const editor = mount([
      block({ id: 'a', content: [{ text: 'one' }] }),
      block({ id: 'b', content: [{ text: 'two' }] }),
      block({ id: 'c', content: [{ text: 'three' }] }),
    ]);

    editor.selectBlocks(['a']);
    moveDown(editor);
    moveDown(editor);

    expect(editor.getDocument().blocks.map((one) => one.id)).toEqual(['b', 'c', 'a']);

    editor.undo();

    expect(editor.getDocument().blocks.map((one) => one.id)).toEqual(['b', 'a', 'c']);

    // The keystroke path, not the API: it is the DOM handler that was dropping
    // keys, so calling editor.undo() directly would not have shown this at all.
    // Dispatched at whatever holds focus, which is what a browser does -- and
    // the whole defect is that nothing useful held it.
    press(document.activeElement ?? editor.element, 'z', { metaKey: true });

    expect(editor.getDocument().blocks.map((one) => one.id)).toEqual(['a', 'b', 'c']);
  });

  test('and the editor still has somewhere to type', () => {
    const editor = mount([
      block({ id: 'a', content: [{ text: 'one' }] }),
      block({ id: 'b', content: [{ text: 'two' }] }),
    ]);

    editor.selectBlocks(['a']);
    moveDown(editor);
    editor.undo();

    expect(document.activeElement, 'focus must not be left on the root').not.toBe(editor.element);
    expect(editor.element.contains(document.activeElement)).toBe(true);
    expect(editor.getSelectionState()).not.toBeNull();
  });
});

describe('a gesture that leaves block mode, or enters it, leaves only one mode behind', () => {
  /**
   * The literal scenario from the e2e finding (F6): one block selected, Tab
   * with nothing above it to nest under. The key is rightly not swallowed --
   * the editor must not be a keyboard trap -- so the browser moves focus on,
   * and the next tab stop is the first block's own host. Nothing ended block
   * selection on the way, so the reader saw a caret in that block and the next
   * character was routed to the invisible selection: it replaced the block.
   * happy-dom performs no default action, so the focus move is done by hand,
   * exactly as the browser does it after the unprevented keydown.
   */
  test('a Tab that changes nothing ends block selection before focus moves on', () => {
    const editor = mount(abc());
    editor.selectBlocks([idFor(editor, 'a')]);

    const prevented = press(editor.element, 'Tab');

    expect(prevented, 'the Tab must still be free to leave').toBe(false);
    expect(editor.getSelectedBlocks()).toEqual([]);

    hosts(editor)[0]!.focus();
    press(hosts(editor)[0]!, 'x');

    expect(texts(editor)).toEqual(['a', 'b', 'c']);
  });

  test('a Tab that does indent keeps the selection it indented', () => {
    const editor = mount(abc());
    editor.selectBlocks([idFor(editor, 'b')]);

    expect(press(editor.element, 'Tab')).toBe(true);
    expect(editor.getSelectedBlocks()).toEqual([idFor(editor, 'b')]);
  });

  /**
   * F12: the handle drag entered block selection without taking focus, so when
   * the dragged block was the one holding the caret, focus and the DOM range
   * stayed in its host. The reader saw a caret in the block they had just
   * moved, and the next keystroke replaced it. A handle drag has no native
   * selection gesture to protect, so it enters block mode the whole way.
   */
  test('dragging the block that holds the caret takes the caret out of it', () => {
    const editor = mount(abc());
    const a = idFor(editor, 'a');
    expect(editor.focus(a, 1)).toBe(true);

    const view = editor.element.querySelectorAll('.neditor-block')[0]!;
    view.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerId: 7 }));
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

    // Mid-drag: one mode already.
    expect(editor.getSelectedBlocks()).toEqual([a]);
    expect(document.activeElement).toBe(editor.element);
    expect(document.getSelection()?.rangeCount ?? 0).toBe(0);

    document.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, pointerId: 7, clientY: 400 }),
    );

    expect(texts(editor)).toEqual(['b', 'c', 'a']);
    expect(editor.getSelectedBlocks()).toEqual([a]);
    expect(document.activeElement).toBe(editor.element);
    expect(editor.getSelectionState(), 'no caret is left for the reader to type at').toBeNull();
  });
});

describe('block-mode clipboard events find the editor wherever the browser sends them', () => {
  /**
   * F8 (e2e finding, Firefox). In block mode focus is on the root, which is not
   * editable, and Firefox dispatches clipboard events at <body> in that case
   * rather than at the focused element. The root's listeners never ran: copy
   * and cut wrote nothing, paste inserted nothing, and nothing said so.
   */
  function clipboard(type: string, target: EventTarget, data: Record<string, string> = {}) {
    const transfer = new DataTransfer();

    for (const [format, value] of Object.entries(data)) {
      transfer.setData(format, value);
    }

    const event = new ClipboardEvent(type, {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    });
    target.dispatchEvent(event);

    return { event, transfer };
  }

  test('a copy dispatched at the body copies the selected blocks', () => {
    const editor = mount(abc());
    editor.selectBlocks([idFor(editor, 'a'), idFor(editor, 'b')]);
    expect(document.activeElement).toBe(editor.element);

    const { event, transfer } = clipboard('copy', document.body);

    expect(event.defaultPrevented).toBe(true);
    expect(transfer.getData('text/plain')).toBe('a\n\nb');
  });

  test('a cut dispatched at the body cuts them', () => {
    const editor = mount(abc());
    editor.selectBlocks([idFor(editor, 'b')]);

    clipboard('cut', document.body);

    expect(texts(editor)).toEqual(['a', 'c']);
  });

  test('a paste dispatched at the body replaces them', () => {
    const editor = mount(abc());
    editor.selectBlocks([idFor(editor, 'b')]);

    clipboard('paste', document.body, { 'text/plain': 'pasted' });

    expect(texts(editor)).toEqual(['a', 'pasted', 'c']);
  });

  test('but not when focus is somewhere else on the page', () => {
    const editor = mount(abc());
    editor.selectBlocks([idFor(editor, 'b')]);
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();

    const { event, transfer } = clipboard('copy', document.body);

    expect(event.defaultPrevented).toBe(false);
    expect(transfer.getData('text/plain')).toBe('');
    clipboard('paste', document.body, { 'text/plain': 'pasted' });
    expect(texts(editor)).toEqual(['a', 'b', 'c']);
  });

  test('and an event that reaches the root is handled once, not twice', () => {
    const editor = mount(abc());
    editor.selectBlocks([idFor(editor, 'b')]);

    // A second handling would paste over its own result: the same text, so
    // the text cannot tell -- but two history entries, so one undo can.
    clipboard('paste', editor.element, { 'text/plain': 'x' });
    expect(texts(editor)).toEqual(['a', 'x', 'c']);

    editor.undo();
    expect(texts(editor)).toEqual(['a', 'b', 'c']);
  });
});

describe('block selection made by a pointer stays the only mode', () => {
  /**
   * F7 (e2e finding, WebKit). A pointer drag that selected blocks and was
   * released below the last one ended with WebKit putting a text selection
   * back into that block's host, and focus with it -- after the editor had
   * already taken both away. Block selection is what the gesture produced, so
   * a caret that turns up inside a host while blocks are selected, with no
   * pointer down, is taken back out rather than left to contradict it.
   */
  test('a range the browser drops into a block, focus unmoved, is removed again', () => {
    const editor = mount(abc());
    editor.selectBlocks([idFor(editor, 'b'), idFor(editor, 'c')]);

    // Focus stays on the root; only the selection moves. (Focus moved into a
    // block without a pointer is the reader's choice -- the test below.)
    const c = hosts(editor)[2]!;
    getSelection()?.collapse(c.firstChild, 1);
    document.dispatchEvent(new Event('selectionchange'));

    expect(editor.getSelectedBlocks()).toEqual([idFor(editor, 'b'), idFor(editor, 'c')]);
    expect(document.activeElement).toBe(editor.element);
    expect(getSelection()?.rangeCount ?? 0).toBe(0);
  });

  test('the drag case: WebKit puts the caret back mid-drag, and the release takes it out', () => {
    const editor = mount(abc());
    const [a, , c] = hosts(editor);
    a!.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 4,
        pointerType: 'mouse',
        clientY: 0,
      }),
    );
    document.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 4,
        pointerType: 'mouse',
        clientY: 400,
      }),
    );
    expect(editor.getSelectedBlocks().length).toBeGreaterThan(1);

    // WebKit, with the button still down: focus and a range back in a host,
    // and no selectionchange after the release to catch it by.
    c!.focus();
    getSelection()?.collapse(c!.firstChild, 1);
    document.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, pointerId: 4, pointerType: 'mouse' }),
    );

    expect(document.activeElement).toBe(editor.element);
    expect(getSelection()?.rangeCount ?? 0).toBe(0);
  });

  /**
   * Found auditing F7. Focus moved into a block by the keyboard or a screen
   * reader -- no pointer involved -- is the reader choosing that text. Taking
   * the caret back out for the stale block selection would leave the next
   * printable key replacing a block the reader may not even be looking at.
   */
  test('focus moved into a block without a pointer ends block selection instead', () => {
    const editor = mount(abc());
    editor.selectBlocks([idFor(editor, 'b')]);
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();

    const a = hosts(editor)[0]!;
    a.focus();
    getSelection()?.collapse(a.firstChild, 1);
    document.dispatchEvent(new Event('selectionchange'));

    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(document.activeElement).toBe(a);
    press(a, 'x');
    expect(texts(editor)).toEqual(['a', 'b', 'c']);
  });

  /**
   * B11 (e2e audit 2). A focus that arrives just after a pointer is released is
   * the browser finishing that gesture -- a long press ending, a tap's
   * compatibility events -- not the reader choosing the text. It is left to the
   * stray-caret check, which keeps the block selection the gesture made.
   */
  test('focus arriving just after a pointer release does not end block selection', () => {
    const editor = mount(abc());
    editor.selectBlocks([idFor(editor, 'b')]);
    document.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 6, pointerType: 'touch' }),
    );
    document.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, pointerId: 6, pointerType: 'touch' }),
    );

    const b = hosts(editor)[1]!;
    b.focus();
    getSelection()?.collapse(b.firstChild, 1);
    document.dispatchEvent(new Event('selectionchange'));

    expect(editor.getSelectedBlocks()).toEqual([idFor(editor, 'b')]);
    expect(document.activeElement).toBe(editor.element);
  });

  test("another editor's caret is not this editor's business", () => {
    const first = mount(abc());
    const second = mount(abc());
    first.selectBlocks([idFor(first, 'b')]);

    const theirs = hosts(second)[0]!;
    theirs.focus();
    getSelection()?.collapse(theirs.firstChild, 1);
    document.dispatchEvent(new Event('selectionchange'));

    expect(document.activeElement).toBe(theirs);
    expect(second.getSelectionState()).toMatchObject({ blockId: idFor(second, 'a') });
  });

  test('a caret placed on purpose still ends block selection instead', () => {
    const editor = mount(abc());
    editor.selectBlocks([idFor(editor, 'b')]);

    editor.focus(idFor(editor, 'c'), 1);
    document.dispatchEvent(new Event('selectionchange'));

    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(editor.getSelectionState()).toMatchObject({ blockId: idFor(editor, 'c') });
  });

  /**
   * F11 (e2e finding, touch). Chromium delivers a few pointermoves before it
   * hands a touch to scrolling with pointercancel. A text drag begun near a
   * block edge crossed into the next block within them and selected both, and
   * the cancel ended the drag without undoing that -- so a swipe to scroll
   * left two blocks selected. On touch a drag across blocks is always the
   * browser's (it pans), and long-press is the touch path to block selection,
   * so a touch pointer never grows a text drag into blocks.
   */
  test('a touch moving across blocks does not select them', () => {
    const editor = mount(abc());
    hosts(editor)[0]!.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 9,
        pointerType: 'touch',
        clientY: 0,
      }),
    );
    document.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 9,
        pointerType: 'touch',
        clientY: 400,
      }),
    );

    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(editor.element.dataset.selecting).toBeUndefined();

    document.dispatchEvent(
      new PointerEvent('pointercancel', { bubbles: true, pointerId: 9, pointerType: 'touch' }),
    );
  });

  test('a mouse moving across blocks still selects them', () => {
    const editor = mount(abc());
    hosts(editor)[0]!.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 3,
        pointerType: 'mouse',
        clientY: 0,
      }),
    );
    document.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 3,
        pointerType: 'mouse',
        clientY: 400,
      }),
    );

    expect(editor.getSelectedBlocks().length).toBeGreaterThan(1);
    document.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, pointerId: 3, pointerType: 'mouse' }),
    );
  });
});
