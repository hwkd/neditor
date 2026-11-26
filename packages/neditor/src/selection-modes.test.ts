// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { Block } from './index.ts';
import { blockText, blocksFromMarkdown, createEditor, toMarkdown } from './index.ts';
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

function release(host: Element, key: string): void {
  host.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
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

    // The invariant is "never neither mode". Undo used to land a caret in the
    // first block here; it now restores the block selection the edit was made
    // on (history entries record it), which is a mode in its own right -- the
    // test above shows the next Cmd+Z still lands from it.
    expect(editor.element.contains(document.activeElement)).toBe(true);
    expect(editor.getSelectedBlocks()).toEqual(['a']);
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

describe("a host's setDocument keeps the block selection it can", () => {
  // The auditor's literal case (R8-KEY-3): a click in "Block B", Escape to
  // select it, and a peer's edit to "Block C" arriving through setDocument.
  // Cleared outright, the selection left the root holding focus with nothing
  // selected and no caret -- neither mode -- and every key fell on the floor
  // (WebKit's Backspace navigated the page away).
  const threeBlocks = (): Block[] => [
    block({ id: 'a', content: [{ text: 'Block A' }] }),
    block({ id: 'b2', content: [{ text: 'Block B' }] }),
    block({ id: 'c', content: [{ text: 'Block C' }] }),
  ];
  const peer = (editor: NEditor, change: (blocks: Block[]) => Block[]): { blocks: Block[] } => ({
    blocks: change(editor.getDocument().blocks),
  });

  test('blocks the new document still shows stay selected, and keys act on them', () => {
    const editor = mount(threeBlocks());
    hosts(editor)[1]!.focus();
    press(hosts(editor)[1]!, 'Escape');
    expect(editor.getSelectedBlocks()).toEqual(['b2']);

    editor.setDocument(
      peer(editor, (blocks) =>
        blocks.map((b) => (b.id === 'c' ? { ...b, content: [{ text: 'Block C (peer)' }] } : b)),
      ),
    );

    expect(editor.getSelectedBlocks()).toEqual(['b2']);
    expect(document.activeElement).toBe(editor.element);

    // Still block mode: ↓ moves the selection on, Backspace deletes it.
    press(editor.element, 'ArrowDown');
    expect(editor.getSelectedBlocks()).toEqual(['c']);
    press(editor.element, 'Backspace');
    expect(texts(editor)).toEqual(['Block A', 'Block B']);
  });

  // R12-KEY-4: when none survive, the root lets go. Round 11 handed the
  // caret to the block after by id -- one the reader never chose -- and the
  // key they pressed for the selection edited it.
  test('when none survive, the root lets go: no caret in a block the reader did not choose', () => {
    const editor = mount(threeBlocks());
    editor.selectBlocks(['b2']);

    editor.setDocument(peer(editor, (blocks) => blocks.filter((b) => b.id !== 'b2')));

    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(editor.getSelectionState()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  test('focus somewhere else is left alone', () => {
    const editor = mount(threeBlocks());
    const field = document.createElement('input');
    document.body.append(field);
    editor.selectBlocks(['b2']);
    field.focus();

    editor.setDocument(peer(editor, (blocks) => blocks.filter((b) => b.id !== 'b2')));

    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(document.activeElement).toBe(field);
  });

  // R9-KEY-4, the auditor's literal case: Escape on "Block B", a click into a
  // field on the page, and a peer deleting "Block B". The reader is typing in
  // the field; "No blocks selected" spoken over it described an editor they
  // had already left.
  test('focus somewhere else hears nothing from the live region', () => {
    const editor = mount(threeBlocks());
    const field = document.createElement('input');
    document.body.append(field);
    hosts(editor)[1]!.focus();
    press(hosts(editor)[1]!, 'Escape');
    expect(editor.getSelectedBlocks()).toEqual(['b2']);
    field.focus();
    const before = live(editor);

    editor.setDocument(peer(editor, (blocks) => blocks.filter((b) => b.id !== 'b2')));

    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(document.activeElement).toBe(field);
    expect(live(editor)).toBe(before);
    expect(live(editor)).not.toBe('No blocks selected');
  });

  test('from the root, the let-go still says the selection is gone', () => {
    const editor = mount(threeBlocks());
    editor.selectBlocks(['b2']);

    editor.setDocument(peer(editor, (blocks) => blocks.filter((b) => b.id !== 'b2')));

    expect(live(editor)).toBe('No blocks selected');
  });
});

describe('where no id says where the reader was, the editor lets go rather than guess', () => {
  // The rule since round 10: identity decides. A block selection carried
  // across `setDocument` keeps the blocks the new document still has by id;
  // where there is none, the selection ends and the root lets go of focus
  // (since round 12 also where blocks beside it survive: R12-KEY-4). Every guess by position or content tried before selected, typed
  // into or deleted a block the reader never chose (R9-RV-SEL-1, R9-RV2-SEL-1,
  // R10-KEY-1, R10-KEY-2).
  const threeBlocks = (): Block[] => [
    block({ id: 'a', content: [{ text: 'Block A' }] }),
    block({ id: 'b2', content: [{ text: 'Block B' }] }),
    block({ id: 'c', content: [{ text: 'Block C' }] }),
  ];
  const reload = (editor: NEditor): void =>
    editor.setDocument({ blocks: blocksFromMarkdown(toMarkdown(editor.getDocument())) });
  const echo = (editor: NEditor): void => {
    editor.on('change', () => {
      editor.setDocument(
        { blocks: blocksFromMarkdown(toMarkdown(editor.getDocument())) },
        { silent: true },
      );
    });
  };
  // Neither mode, and not the root: focus has left the editor, and a key
  // pressed now reaches nothing in it.
  const letGo = (editor: NEditor): void => {
    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(editor.getSelectionState()).toBeNull();
    expect(editor.element.contains(document.activeElement)).toBe(false);
    expect(document.activeElement).toBe(document.body);
  };
  const blanks = (n: number, prefix: string): Block[] =>
    Array.from({ length: n }, (_, i) => block({ id: `${prefix}${i}` }));
  const para = (id: string, text: string): Block => block({ id, content: [{ text }] });

  function selectByKeys(editor: NEditor, id: string, extend: number): void {
    const host = editor.element.querySelector(`[data-block-id="${id}"] .neditor-block__content`)!;
    (host as HTMLElement).focus();
    press(host, 'Escape');

    for (let step = 0; step < extend; step += 1) {
      press(editor.element, 'ArrowDown', { shiftKey: true });
    }
  }

  // R10-KEY-1, p07's "sections" case: [Gamma 1, ∅, Gamma 2] selected, every
  // blank paragraph dropped by the reload. The old index named "Epsilon 1",
  // and "x" was typed into it.
  test('a Markdown reload: no caret in "Epsilon 1", nothing selected, focus let go', () => {
    const editor = mount([
      block({ id: 't', type: 'heading1', content: [{ text: 'Title' }] }),
      ...blanks(1, 'x'),
      para('a1', 'Alpha 1'),
      ...blanks(1, 'y'),
      para('b1', 'Beta 1'),
      ...blanks(1, 'z'),
      para('g1', 'Gamma 1'),
      block({ id: 'ge' }),
      para('g2', 'Gamma 2'),
      ...blanks(1, 'w'),
      para('d1', 'Delta 1'),
      ...blanks(1, 'v'),
      para('e1', 'Epsilon 1'),
      para('f1', 'Zeta 1'),
    ]);
    selectByKeys(editor, 'g1', 2);
    expect(editor.getSelectedBlocks()).toEqual(['g1', 'ge', 'g2']);

    reload(editor);

    letGo(editor);
    expect(texts(editor)).toContain('Epsilon 1');
  });

  // R10-KEY-1, p07's "window" case: seventy blank paragraphs above "Unique".
  // The caret landed sixty-nine blocks down, in "Line 68".
  test('seventy blank lines above: no caret sixty-nine blocks down', () => {
    const editor = mount([
      block({ id: 't', type: 'heading1', content: [{ text: 'Title' }] }),
      ...blanks(70, 'k'),
      para('u', 'Unique'),
      para('n1', 'Next one'),
      ...Array.from({ length: 80 }, (_, i) => para(`m${i}`, `Line ${i}`)),
    ]);
    selectByKeys(editor, 'u', 0);
    expect(editor.getSelectedBlocks()).toEqual(['u']);

    reload(editor);

    letGo(editor);
  });

  // R10-KEY-1, p06's A case: [First, ∅, Second] selected below two blank
  // lines; the caret went to "Quiet".
  const firstSecond = (): Block[] => [
    block({ id: 'h', type: 'heading1', content: [{ text: 'Heading' }] }),
    block({ id: 'e1' }),
    block({ id: 'e2' }),
    para('p1', 'First'),
    block({ id: 'e3' }),
    para('p2', 'Second'),
    para('q', 'Quiet'),
    para('r', 'Rest'),
  ];

  test('a selection spanning a blank line, reloaded: no caret in "Quiet"', () => {
    const editor = mount(firstSecond());
    selectByKeys(editor, 'p1', 2);
    expect(editor.getSelectedBlocks()).toEqual(['p1', 'e3', 'p2']);

    reload(editor);

    letGo(editor);
  });

  // The same block, unchanged, under a new id is not found either: content
  // is not identity (the template case below is why).
  test('the same blocks under new ids, nothing else changed: none selected', () => {
    const editor = mount(threeBlocks());
    selectByKeys(editor, 'b2', 0);

    reload(editor);

    letGo(editor);
    expect(texts(editor)).toEqual(['Block A', 'Block B', 'Block C']);
  });

  // R10-KEY-2, p11's literal case: a daily note made from a template, its
  // "Notes" heading selected, and the host switching to yesterday's note.
  // `renamed` was true for any document with no id in common, so yesterday's
  // "Notes" heading was selected, and Backspace deleted it.
  const note = (p: string, day: string, tasks: string[], notes: string[]): Block[] => [
    block({ id: `${p}h`, type: 'heading1', content: [{ text: day }] }),
    block({ id: `${p}t`, type: 'heading2', content: [{ text: 'Tasks' }] }),
    ...tasks.map((text, i) => block({ id: `${p}k${i}`, type: 'todo', content: [{ text }] })),
    block({ id: `${p}n`, type: 'heading2', content: [{ text: 'Notes' }] }),
    ...notes.map((text, i) => para(`${p}p${i}`, text)),
    block({ id: `${p}d`, type: 'divider' }),
  ];
  const today = (): Block[] =>
    note('a', 'Tuesday 10 November', ['Ship the release', 'Call Sam'], ['Meeting went long.']);
  const yesterday = (): Block[] =>
    note('y', 'Monday 9 November', ['Write the changelog'], ['Quiet day.', 'Read the audit.']);

  test('switching to another note from the same template selects nothing of it', () => {
    const editor = mount(today());
    selectByKeys(editor, 'an', 0);
    expect(editor.getSelectedBlocks()).toEqual(['an']);

    editor.setDocument({ blocks: yesterday() });

    letGo(editor);
    // Backspace has nothing to act on: the root does not hold focus, and
    // even pressed at it, no block is selected.
    press(editor.element, 'Backspace');
    expect(texts(editor)).toContain('Notes');
    expect(editor.getDocument().blocks.map((b) => b.id)).toContain('yn');
  });

  // R10-KEY-2, p20: the switch made from a sidebar link, focus already on it.
  test('switching from a link on the page: nothing selected, the link keeps focus', () => {
    const editor = mount(today());
    const link = document.createElement('a');
    link.href = '#yesterday';
    link.textContent = 'Yesterday';
    document.body.prepend(link);
    selectByKeys(editor, 'an', 0);
    link.focus();
    const before = live(editor);

    editor.setDocument({ blocks: yesterday() });

    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(document.activeElement).toBe(link);
    // Nothing is said over the link either.
    expect(live(editor)).toBe(before);
  });

  // R12-KEY-4: the blocks beside a selection a peer deleted are still there
  // by id, and are still blocks the reader did not choose. Round 8's
  // hand-back put the caret in the one after (else the end of the one
  // before), and the reader's Backspace, Delete or letter edited it.
  test('a neighbour by id after it does not take the caret, past a new divider', () => {
    const editor = mount(threeBlocks());
    editor.selectBlocks(['b2']);

    editor.setDocument({
      blocks: [para('a', 'Block A'), block({ id: 'n2', type: 'divider' }), para('c', 'Block C')],
    });

    letGo(editor);
    expect(press(document.body, 'Backspace')).toBe(true);
  });

  test('nor the one before it when nothing after survives', () => {
    const editor = mount(threeBlocks());
    editor.selectBlocks(['c']);

    editor.setDocument({
      blocks: [para('a', 'Block A'), para('b2', 'Block B'), block({ id: 'n3', type: 'divider' })],
    });

    letGo(editor);
    expect(press(document.body, 'Backspace')).toBe(true);
  });

  // R12-KEY-4, p12's literal case: "Beta" selected with a click and Escape,
  // and a peer deleting it with every id kept. The caret went to the start
  // of "Gamma": Backspace made "AlphaGamma", Delete ate the "G", "x" typed
  // "xGamma", Enter opened a paragraph above it. Let go, every one of those
  // keys lands on the page, and Backspace there is guarded.
  test('a peer deleting the selected block: no key reaches its neighbours', () => {
    const editor = mount(['Alpha', 'Beta', 'Gamma', 'Delta'].map((t, i) => para(`b${i}`, t)));
    selectByKeys(editor, 'b1', 0);
    expect(editor.getSelectedBlocks()).toEqual(['b1']);

    editor.setDocument(
      { blocks: editor.getDocument().blocks.filter((b) => b.id !== 'b1') },
      { silent: true },
    );

    letGo(editor);
    for (const key of ['Backspace', 'Delete', 'x', 'Enter']) {
      const prevented = press(document.body, key);
      expect(prevented).toBe(key === 'Backspace');
    }
    expect(texts(editor)).toEqual(['Alpha', 'Gamma', 'Delta']);
  });

  // Surviving selected ids still stay selected: only a selection with none
  // left lets go.
  test('a selection with a survivor keeps it, and keeps the root focused', () => {
    const editor = mount(['Alpha', 'Beta', 'Gamma', 'Delta'].map((t, i) => para(`b${i}`, t)));
    selectByKeys(editor, 'b1', 1);
    expect(editor.getSelectedBlocks()).toEqual(['b1', 'b2']);

    editor.setDocument({ blocks: editor.getDocument().blocks.filter((b) => b.id !== 'b1') });

    expect(editor.getSelectedBlocks()).toEqual(['b2']);
    expect(document.activeElement).toBe(editor.element);
  });

  // A selected block the new document hides in a collapsed toggle is not
  // shown, so it is not kept, and the toggle that hides it is not the
  // reader's choice either: the root lets go.
  test('a selected block now folded away: the root lets go', () => {
    const editor = mount(threeBlocks());
    editor.selectBlocks(['c']);

    editor.setDocument({
      blocks: [
        para('a', 'Block A'),
        block({ id: 'b2', type: 'toggle', collapsed: true, content: [{ text: 'Block B' }] }),
        block({ id: 'c', depth: 1, content: [{ text: 'Block C' }] }),
      ],
    });

    letGo(editor);
    expect(editor.getDocument().blocks.map((b) => b.id)).toEqual(['a', 'b2', 'c']);
  });

  // R9-KEY-1's p19 shape, decided again: a divider and a paragraph, Escape on
  // the paragraph, and a peer deleting it. The divider was selected, and
  // Backspace deleted a block nobody chose. Now nothing is selected.
  test('a document of a divider alone: nothing selected, focus let go', () => {
    const editor = mount([block({ id: 'dv', type: 'divider' }), para('p', 'Para')]);
    selectByKeys(editor, 'p', 0);
    expect(editor.getSelectedBlocks()).toEqual(['p']);

    editor.setDocument({ blocks: editor.getDocument().blocks.filter((b) => b.id !== 'p') });

    letGo(editor);
    expect(editor.getDocument().blocks.map((b) => b.type)).toEqual(['divider']);
  });

  // happy-dom focuses anything, so a host that refuses focus -- read-only, or
  // inert outside a modal dialog -- is simulated here; the read-only case is
  // pinned in a real browser in read-only.spec.ts. Survivors by id that
  // cannot take a caret are not selected in its place: that too is a block
  // the reader did not choose.
  test('when no survivor takes focus, nothing is selected and focus is let go', () => {
    const editor = mount(threeBlocks());
    editor.selectBlocks(['b2']);
    const real = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'focus')!
      .value as HTMLElement['focus'];
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      if (!this.classList.contains('neditor-block__content')) {
        Reflect.apply(real, this, [options]);
      }
    });

    try {
      editor.setDocument({ blocks: [para('a', 'Block A'), para('c', 'Block C')] });
    } finally {
      spy.mockRestore();
    }

    letGo(editor);
    expect(editor.getDocument().blocks.map((b) => b.id)).toEqual(['a', 'c']);
  });

  test('focus somewhere else is left alone, and hears nothing', () => {
    const editor = mount(threeBlocks());
    const field = document.createElement('input');
    document.body.append(field);
    editor.selectBlocks(['b2']);
    field.focus();
    const before = live(editor);

    reload(editor);

    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(document.activeElement).toBe(field);
    expect(live(editor)).toBe(before);
  });

  test('from the root, the live region says the selection is gone', () => {
    const editor = mount(threeBlocks());
    editor.selectBlocks(['b2']);

    reload(editor);

    expect(live(editor)).toBe('No blocks selected');
  });

  // R10-KEY-1, p06's B and C cases: a host that writes every `change` out as
  // Markdown and loads it straight back, [First, ∅, Second] selected, and a
  // block-mode Tab or Mod+Shift+↓. The echo renamed every block, and the
  // caret went to "Quiet" or "Rest", where the next key was typed.
  for (const [label, key, init, order, depths] of [
    ['Tab', 'Tab', {}, ['Heading', 'First', 'Second', 'Quiet', 'Rest'], [0, 1, 1, 0, 0]],
    [
      'Mod+Shift+↓',
      'ArrowDown',
      { shiftKey: true, ctrlKey: true, metaKey: true },
      ['Heading', 'Quiet', 'First', 'Second', 'Rest'],
      [0, 0, 0, 0, 0],
    ],
  ] as const) {
    test(`a block-mode ${label} under a Markdown echo: the edit is made, then focus is let go`, () => {
      const editor = mount(firstSecond());
      echo(editor);
      selectByKeys(editor, 'p1', 2);
      expect(editor.getSelectedBlocks()).toEqual(['p1', 'e3', 'p2']);

      expect(press(editor.element, key, init)).toBe(true);

      const after = editor.getDocument().blocks;
      expect(after.map(blockText)).toEqual(order);
      expect(after.map((b) => b.depth)).toEqual(depths);
      letGo(editor);
    });
  }

  // The sibling the rule keeps: a host that echoes with the ids it was given
  // (a normalising store) leaves the selection where it was, by id.
  test('an echo that keeps the ids keeps the selection, and the root keeps focus', () => {
    const editor = mount(firstSecond());
    editor.on('change', () => {
      editor.setDocument(editor.getDocument(), { silent: true });
    });
    selectByKeys(editor, 'p1', 2);

    press(editor.element, 'Tab');

    expect(editor.getSelectedBlocks()).toEqual(['p1', 'e3', 'p2']);
    expect(document.activeElement).toBe(editor.element);
  });

  // R10-KEY-1, p08's "twins" case: one-character twins either side of the
  // selected block, a blank line between each, and "q" typed over it under a
  // Markdown echo. Nothing finds the new "q" unambiguously; by position the
  // caret went to "Delta", and "u" was typed into it.
  test('typing over a block between one-character twins under an echo: no caret in "Delta"', () => {
    const editor = mount([
      para('a', 'Alpha'),
      block({ id: 'e1' }),
      para('t1', 'q'),
      block({ id: 'e2' }),
      para('s', 'Select me'),
      block({ id: 'e3' }),
      para('t2', 'q'),
      para('d', 'Delta'),
    ]);
    echo(editor);
    selectByKeys(editor, 's', 0);

    press(editor.element, 'q');

    expect(texts(editor)).toEqual(['Alpha', 'q', 'q', 'q', 'Delta']);
    letGo(editor);
  });

  // p08's "noTwins" case. Round 9 found the new paragraph by its content here,
  // and round 10 kept that search for this one path; R11-KEY-4 showed the
  // search cannot be bounded so that it never finds an old twin instead
  // (below), so nothing is searched: the "q" is in the document, and focus is
  // let go as after every other block-mode edit under such a host.
  test('without twins the character is typed, and focus is let go', () => {
    const editor = mount([
      para('a', 'Alpha'),
      block({ id: 'e1' }),
      block({ id: 'e2' }),
      para('s', 'Select me'),
      para('d', 'Delta'),
      para('f', 'Foxtrot'),
    ]);
    echo(editor);
    selectByKeys(editor, 's', 0);

    press(editor.element, 'q');

    expect(texts(editor)).toEqual(['Alpha', 'q', 'Delta', 'Foxtrot']);
    letGo(editor);
  });

  // R11-KEY-4, p10's literal case: seventy blank paragraphs Markdown drops,
  // "Pick me" selected between "Mike" and "Zulu", and the same three blocks
  // twice further down with a one-character "q" in the middle. The content
  // search looked within 64 blocks of the same position in both documents:
  // the new "q" had left that window, an old "q" from beyond it had entered,
  // the counts agreed, and the caret went to the old one -- "Z" was typed 49
  // blocks below.
  test('seventy blank lines dropped above twins: the caret goes to no old "q"', () => {
    const blocks: Block[] = [...blanks(70, 'blank')];
    blocks.push(para('m0', 'Mike'), para('x', 'Pick me'), para('z0', 'Zulu'));
    for (let i = 73; i < 119; i += 1) {
      blocks.push(para(`f${i}`, `filler ${i}`));
    }
    blocks.push(para('m1', 'Mike'), para('q1', 'q'), para('z1', 'Zulu'));
    for (let i = 122; i < 179; i += 1) {
      blocks.push(para(`g${i}`, `more ${i}`));
    }
    blocks.push(para('m2', 'Mike'), para('q2', 'q'), para('z2', 'Zulu'));
    const editor = mount(blocks);
    echo(editor);
    selectByKeys(editor, 'x', 0);

    press(editor.element, 'q');

    const now = texts(editor);
    expect(now.slice(0, 3)).toEqual(['Mike', 'q', 'Zulu']);
    expect(now.filter((text) => text === 'q')).toHaveLength(3);
    letGo(editor);
  });
});

describe('a setDocument under a panel holding focus takes its selection and focus out', () => {
  // R11-KEY-1 / R7-KEY-1, p15. WebKit keeps the selection in a cell while
  // F10's toolbar holds focus -- and once the toolbar closes, types into it
  // with focus on <body>. A selection one of the editor's own panels left
  // behind is dropped before the render; happy-dom keeps a selection whatever
  // holds focus, which is the state those engines leave, so the drop itself
  // is pinned here and the typing in tables.spec.ts (TB5h, TB5h2).
  //
  // R11-RV-KEY-3, q9/q10's literal case: hidden by `setDocument`, the F10
  // toolbar's button kept focus in WebKit, and the next Backspace went back in
  // history. The control is blurred, so focus is on <body>, and the guard
  // armed. happy-dom never moves focus off a hidden element, which is exactly
  // WebKit's state.
  const helloPrev = (): NEditor =>
    mount([
      block({ id: 'p', content: [{ text: 'Prev' }] }),
      block({ id: 'z', content: [{ text: 'Hello world' }] }),
    ]);
  const rangeCount = (): number => getSelection()?.rangeCount ?? 0;

  test('the link editor: its range in the block goes, focus goes to <body>, Backspace is held off', () => {
    const editor = helloPrev();
    expect(editor.focusRange('z', 6, 11)).toBe(true);
    editor.openLinkEditor();
    const fields = document.querySelectorAll<HTMLInputElement>('.neditor-link-editor input');
    fields[fields.length - 1]!.focus();
    expect(rangeCount()).toBe(1);

    editor.setDocument({
      blocks: [
        block({ id: 'p', content: [{ text: 'Prev' }] }),
        block({ id: 'z', content: [{ text: 'Hello there' }] }),
      ],
    });

    expect(rangeCount()).toBe(0);
    expect(editor.getSelectionState()).toBeNull();
    expect(document.activeElement).toBe(document.body);
    expect(press(document.body, 'Backspace')).toBe(true);
  });

  test('the F10 table toolbar: the caret in its cell goes, its button is blurred, Backspace is held off', () => {
    const editor = mount([
      block({ id: 'p', content: [{ text: 'Prev' }] }),
      block({
        id: 't',
        type: 'table',
        rows: [
          [[{ text: 'a1' }], [{ text: 'b1' }]],
          [[{ text: 'a2' }], [{ text: 'b2' }]],
        ],
      }),
    ]);
    expect(editor.focusRange('t', 2, 2, { row: 1, column: 0 })).toBe(true);
    const cell = editor.element.querySelector<HTMLElement>('[data-cell="1:0"]')!;
    expect(press(cell, 'F10')).toBe(true);
    const button = document.activeElement as HTMLElement;
    expect(button.classList.contains('neditor-table-toolbar__button')).toBe(true);

    const doc = editor.getDocument();
    doc.blocks[0] = { ...doc.blocks[0]!, content: [{ text: 'peer' }] };
    editor.setDocument(doc);

    expect(rangeCount()).toBe(0);
    expect(document.activeElement).toBe(document.body);
    expect(press(document.body, 'Backspace')).toBe(true);
  });

  // R11-RV-KEY-1, q13/q18's literal case: a host's own toolbar -- a plain
  // <button> that takes focus, running `toggleMark('bold')` from its click,
  // as the README's "drive your own toolbar" shows -- and a peer's update
  // landing while it is pressed. Round 11's first version dropped the
  // reader's selection whenever focus was outside the root, and the click
  // bolded nothing (0/6 in every engine). A page control keeps it.
  test('a host-page Bold button: an update from a peer during the press leaves the range it bolds', () => {
    const editor = mount([
      block({ id: 'a', content: [{ text: 'Alpha' }] }),
      block({ id: 'b', content: [{ text: 'Bravo charlie' }] }),
      block({ id: 'c', content: [{ text: 'Echo' }] }),
    ]);
    const bold = document.createElement('button');
    bold.textContent = 'Bold';
    bold.addEventListener('click', () => editor.toggleMark('bold'));
    document.body.append(bold);
    expect(editor.focusRange('b', 6, 13)).toBe(true);
    bold.focus();

    const doc = editor.getDocument();
    doc.blocks[2] = { ...doc.blocks[2]!, content: [{ text: 'Echo (peer)' }] };
    editor.setDocument(doc);
    bold.click();

    expect(editor.getDocument().blocks[1]!.content).toEqual([
      { text: 'Bravo ' },
      { text: 'charlie', marks: ['bold'] },
    ]);
    expect(document.activeElement).not.toBe(document.body);
    bold.remove();
  });

  // The sibling the rule keeps: the reader's own caret, in the block holding
  // focus, stays where it is.
  test('focus in the block: the caret stays', () => {
    const editor = helloPrev();
    expect(editor.focusRange('z', 6, 6)).toBe(true);

    editor.setDocument({
      blocks: [
        block({ id: 'p', content: [{ text: 'Prev (peer)' }] }),
        block({ id: 'z', content: [{ text: 'Hello world' }] }),
      ],
    });

    expect(editor.getSelectionState()).toMatchObject({ blockId: 'z', range: { start: 6, end: 6 } });
    expect(document.activeElement).toBe(hosts(editor)[1]);
  });
});

describe("a peer's update to the very host the reader is in carries their caret by identity", () => {
  // R12-KEY-7, p5's literal case: "world" selected in the focused block, and a
  // peer putting "NEW " in front of it with the id kept. The render rebuilt
  // the host's children and the browser dropped the range to offset 0: "X"
  // typed next made "XNEW Hello world" in every engine and mount. Each end is
  // carried by the text around it -- its offset while the text before it is
  // unchanged, else its distance from the end while the text after it is --
  // and where neither holds for an end, the host lets go. happy-dom keeps a
  // selection through `replaceChildren` no better than a browser does, so the
  // offsets are what is pinned here; the typing is pinned in
  // block-selection.spec.ts in all three engines.
  const one = (text: string): NEditor => mount([block({ id: 'z', content: [{ text }] })]);
  const peer = (editor: NEditor, text: string): void =>
    editor.setDocument({ blocks: [block({ id: 'z', content: [{ text }] })] }, { silent: true });
  const range = (editor: NEditor): unknown => editor.getSelectionState()?.range ?? null;

  test('a range after the peer\'s text keeps its text: "world" is still selected', () => {
    const editor = one('Hello world');
    expect(editor.focusRange('z', 6, 11)).toBe(true);

    peer(editor, 'NEW Hello world');

    expect(range(editor)).toEqual({ start: 10, end: 15 });
    expect(document.activeElement).toBe(hosts(editor)[0]);
  });

  test("a caret after the peer's text keeps its distance from the end", () => {
    const editor = one('Hello world');
    expect(editor.focusRange('z', 11, 11)).toBe(true);

    peer(editor, 'NEW Hello world');

    expect(range(editor)).toEqual({ start: 15, end: 15 });
  });

  test("a caret before the peer's text keeps its offset", () => {
    const editor = one('Hello world');
    expect(editor.focusRange('z', 5, 5)).toBe(true);

    peer(editor, 'Hello world, again');

    expect(range(editor)).toEqual({ start: 5, end: 5 });
  });

  // An insertion exactly at a caret satisfies both rules: the caret keeps
  // its offset, before the inserted text.
  test('text inserted exactly at the caret goes after it', () => {
    const editor = one('Hello world');
    expect(editor.focusRange('z', 5, 5)).toBe(true);

    peer(editor, 'Hello there world');

    expect(range(editor)).toEqual({ start: 5, end: 5 });
  });

  // R12-KEY-5's WebKit shadow shape, by offsets: the whole block selected
  // (Shift+Home) and a peer prefixing it. A range's start goes after text
  // inserted at it and its end before, so the range is still exactly the
  // reader's text -- Bold covered the peer's "NEW " and left out "last line".
  test("a whole-block range under a prefix is still exactly the reader's text", () => {
    const editor = one('alpha\nlast line');
    expect(editor.focusRange('z', 0, 15)).toBe(true);

    peer(editor, 'NEW alpha\nlast line');

    expect(range(editor)).toEqual({ start: 4, end: 19 });
  });

  test('a backward range stays backward', () => {
    const editor = one('Hello world');
    const host = hosts(editor)[0]!;
    host.focus();
    const text = host.firstChild!;
    getSelection()!.setBaseAndExtent(text, 11, text, 6);
    expect(getSelection()!.anchorOffset).toBe(11);

    peer(editor, 'NEW Hello world');

    const after = getSelection()!;
    expect(range(editor)).toEqual({ start: 10, end: 15 });
    expect(after.anchorOffset).toBe(15);
    expect(after.focusOffset).toBe(10);
  });

  // The text changed, the marks did: the offsets are the same characters.
  test('a peer bolding the block keeps the caret where it was', () => {
    const editor = one('Hello world');
    expect(editor.focusRange('z', 7, 7)).toBe(true);

    editor.setDocument(
      { blocks: [block({ id: 'z', content: [{ text: 'Hello world', marks: ['bold'] }] })] },
      { silent: true },
    );

    expect(range(editor)).toEqual({ start: 7, end: 7 });
  });

  // Neither side of the caret is what it was: nothing says where the reader
  // is, so the host lets go, the range goes with it, and Backspace on the page
  // is guarded as after every let-go.
  test('text changed on both sides of the caret: the host lets go', () => {
    const editor = one('Hello world');
    expect(editor.focusRange('z', 5, 5)).toBe(true);

    peer(editor, 'Goodbye moon');

    expect(editor.getSelectionState()).toBeNull();
    expect(getSelection()?.rangeCount ?? 0).toBe(0);
    expect(document.activeElement).toBe(document.body);
    expect(press(document.body, 'Backspace')).toBe(true);
    expect(texts(editor)).toEqual(['Goodbye moon']);
  });

  test('a range with one end that cannot be placed lets go too', () => {
    const editor = one('Hello world');
    expect(editor.focusRange('z', 2, 8)).toBe(true);

    peer(editor, 'Hexxo worxd');

    expect(editor.getSelectionState()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  // p10's same-cell case: the caret at the end of "a1" in a table cell, and a
  // peer rewriting that cell to "a1!". "XY" was typed at the cell's start.
  test('a table cell: the caret is carried within its own cell', () => {
    const editor = mount([
      block({
        id: 't',
        type: 'table',
        rows: [
          [[{ text: 'h1' }], [{ text: 'h2' }]],
          [[{ text: 'a1' }], [{ text: 'b1' }]],
        ],
      }),
    ]);
    expect(editor.focusRange('t', 2, 2, { row: 1, column: 0 })).toBe(true);

    const doc = editor.getDocument();
    doc.blocks[0]!.rows![1]![0] = [{ text: 'a1!' }];
    editor.setDocument(doc, { silent: true });

    expect(editor.getSelectionState()).toMatchObject({
      blockId: 't',
      cell: { row: 1, column: 0 },
      range: { start: 2, end: 2 },
    });
  });

  // A peer's edit to another cell redraws nothing the caret is in.
  test('another cell changing leaves the caret alone', () => {
    const editor = mount([
      block({
        id: 't',
        type: 'table',
        rows: [
          [[{ text: 'h1' }], [{ text: 'h2' }]],
          [[{ text: 'a1' }], [{ text: 'b1' }]],
        ],
      }),
    ]);
    expect(editor.focusRange('t', 1, 1, { row: 1, column: 0 })).toBe(true);

    const doc = editor.getDocument();
    doc.blocks[0]!.rows![0]![1] = [{ text: 'peer' }];
    editor.setDocument(doc, { silent: true });

    expect(editor.getSelectionState()).toMatchObject({
      cell: { row: 1, column: 0 },
      range: { start: 1, end: 1 },
    });
  });
});

describe("a range kept in a host the reader left is dropped when a peer's update redraws it", () => {
  // R12-KEY-3, p7's literal case. WebKit focuses no button on a click: the
  // reader pressed a page button with the caret at the end of block z, focus
  // went to <body>, and WebKit kept the selection in z -- and types into it
  // from there. A peer prefixing z rebuilt its children; WebKit's anchor and
  // focus then said `DIV:4` while its live range said `DIV:0`, the editor
  // read 0..0, and "X" was typed into "bold twoX" (Backspace and Enter
  // likewise). The range goes, and the reader's Backspace, which WebKit would
  // now aim at the page, is guarded. happy-dom keeps a selection in a host
  // without focus, the state WebKit leaves; the typing is pinned in WebKit in
  // block-selection.spec.ts.
  const twoBlocks = (): NEditor =>
    mount([
      block({ id: 'p', content: [{ text: 'Prev' }] }),
      block({ id: 'z', content: [{ text: 'alpha\nlast line' }] }),
    ]);
  const leaveFor = (target: HTMLElement | null): void => {
    if (target) {
      target.focus();
    } else {
      (document.activeElement as HTMLElement).blur();
    }
  };

  test('focus on <body>: the range in the redrawn block goes, and Backspace is held off', () => {
    const editor = twoBlocks();
    expect(editor.focusRange('z', 15, 15)).toBe(true);
    leaveFor(null);
    expect(getSelection()?.rangeCount).toBe(1);

    const doc = editor.getDocument();
    doc.blocks[1] = { ...doc.blocks[1]!, content: [{ text: 'NEW alpha\nlast line' }] };
    editor.setDocument(doc, { silent: true });

    expect(getSelection()?.rangeCount ?? 0).toBe(0);
    expect(editor.getSelectionState()).toBeNull();
    expect(press(document.body, 'Backspace')).toBe(true);
  });

  test('focus on a page button: the range goes, and nothing is armed for a control the reader chose', () => {
    const editor = twoBlocks();
    const button = document.createElement('button');
    document.body.append(button);
    expect(editor.focusRange('z', 11, 15)).toBe(true);
    leaveFor(button);

    const doc = editor.getDocument();
    doc.blocks[1] = { ...doc.blocks[1]!, content: [{ text: 'NEW alpha\nlast line' }] };
    editor.setDocument(doc, { silent: true });

    expect(getSelection()?.rangeCount ?? 0).toBe(0);
    expect(document.activeElement).toBe(button);
    button.remove();
    expect(press(document.body, 'Backspace')).toBe(false);
  });

  // R11-RV-KEY-1's sibling: an update to *another* block leaves the range
  // where a host's own button acts on it.
  test('an update to another block leaves it exactly where it was', () => {
    const editor = twoBlocks();
    expect(editor.focusRange('z', 11, 15)).toBe(true);
    leaveFor(null);

    const doc = editor.getDocument();
    doc.blocks[0] = { ...doc.blocks[0]!, content: [{ text: 'Prev (peer)' }] };
    editor.setDocument(doc, { silent: true });

    expect(editor.getSelectionState()?.range).toEqual({ start: 11, end: 15 });
    expect(press(document.body, 'Backspace')).toBe(false);
  });

  // R13-KEY-1, k6's cases: the range's block taken away rather than redrawn
  // -- deleted, or every id renamed. WebKit was typing into it as into one
  // the update only redrew, and Backspace went back in history.
  for (const [label, edit] of [
    ['deleted', (blocks: Block[]) => [blocks[0]!]],
    ['renamed', (blocks: Block[]) => blocks.map((b, i) => ({ ...b, id: `n${i}` }))],
  ] as const) {
    test(`focus on <body>, the block ${label}: Backspace is held off`, () => {
      const editor = twoBlocks();
      expect(editor.focusRange('z', 11, 15)).toBe(true);
      leaveFor(null);

      editor.setDocument({ blocks: edit(editor.getDocument().blocks) }, { silent: true });

      expect(press(document.body, 'Backspace')).toBe(true);
    });
  }
});

describe('a lock under a range WebKit kept for a page button', () => {
  // R13-KEY-1, k12's literal case: the caret at the end of z, a page button
  // WebKit gave no focus (focus on <body>, the range kept in z, which WebKit
  // types into), and the button locking the editor. Locked, the block takes
  // no Backspace, and it went back in history: the lock guards it. Unlocked
  // over the same range, WebKit types into it again, and Backspace is the
  // editor's again -- also when the unlock lands with the window in the
  // background (a save finishing while the reader is in another tab), which
  // left the guard over a range letters still reached. happy-dom keeps a
  // selection in a host without focus, the state WebKit leaves; Backspace
  // itself is pinned in WebKit in read-only.spec.ts (RO6g).
  const leave = (editor: NEditor): void => {
    expect(editor.focusRange('z', 15, 15)).toBe(true);
    (document.activeElement as HTMLElement).blur();
    expect(getSelection()?.rangeCount).toBe(1);
  };
  const two = (): NEditor =>
    mount([
      block({ id: 'p', content: [{ text: 'Prev' }] }),
      block({ id: 'z', content: [{ text: 'alpha\nlast line' }] }),
    ]);

  test('the lock holds Backspace off', () => {
    const editor = two();
    leave(editor);
    editor.setEditable(false);
    expect(press(document.body, 'Backspace')).toBe(true);
  });

  test('an unlock over the same range hands Backspace back', () => {
    const editor = two();
    leave(editor);
    editor.setEditable(false);
    editor.setEditable(true);
    expect(press(document.body, 'Backspace')).toBe(false);
  });

  test('an unlock in a background tab hands it back too', () => {
    const editor = two();
    leave(editor);
    editor.setEditable(false);
    const spy = vi.spyOn(document, 'hasFocus').mockReturnValue(false);

    try {
      editor.setEditable(true);
    } finally {
      spy.mockRestore();
    }

    expect(getSelection()?.rangeCount).toBe(1);
    expect(press(document.body, 'Backspace')).toBe(false);
  });

  test('an unlock after a peer took the block away keeps it held off', () => {
    const editor = two();
    leave(editor);
    editor.setEditable(false);
    editor.setDocument({ blocks: [editor.getDocument().blocks[0]!] }, { silent: true });
    editor.setEditable(true);
    expect(press(document.body, 'Backspace')).toBe(true);
  });

  test('a read-only editor locked again guards nothing: nothing was typed', () => {
    const editor = two();
    leave(editor);
    editor.setEditable(false);
    // The reader places themselves, which spends the guard.
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(press(document.body, 'Backspace')).toBe(false);

    editor.setEditable(false);
    expect(press(document.body, 'Backspace')).toBe(false);
  });

  test('focus on a field of the page is the reader elsewhere: nothing is armed', () => {
    const editor = two();
    const input = document.createElement('input');
    document.body.append(input);
    expect(editor.focusRange('z', 15, 15)).toBe(true);
    input.focus();
    editor.setEditable(false);
    input.remove();
    expect(press(document.body, 'Backspace')).toBe(false);
  });

  // The unlock hands Backspace back wherever the selection still is in one
  // of the editor's hosts (`#resumeKeptSelection`): Safari's Shift+← extends
  // a read-only selection with focus on <body>. R14-KEY-1, k16's literal
  // case: "wo" kept, Shift+← during the lock made it "two", and after the
  // unlock three Backspaces deleted nothing while "Q" replaced the range.
  // WebKit types into the selection wherever it is, so the key is the
  // editor's. (Round 13 handed it back only over the very range the lock
  // found.) The keys themselves are pinned in WebKit in read-only.spec.ts
  // (RO6g).
  for (const [label, start, end] of [
    ['its start moved', 4, 10],
    ['its end moved', 6, 12],
    ['both ends moved', 4, 12],
    ['collapsed', 8, 8],
    ['unmoved', 6, 10],
  ] as const) {
    test(`an unlock over a kept range, ${label}, hands Backspace back`, () => {
      const editor = two();
      expect(editor.focusRange('z', 6, 10)).toBe(true);
      (document.activeElement as HTMLElement).blur();
      expect(getSelection()?.rangeCount).toBe(1);
      editor.setEditable(false);
      const text = editor.element.querySelector(
        '[data-block-id="z"] .neditor-block__content',
      )!.firstChild!;
      getSelection()!.setBaseAndExtent(text, start, text, end);
      editor.setEditable(true);
      expect(editor.getSelectionState()?.range).toEqual({ start, end });
      expect(press(document.body, 'Backspace')).toBe(false);
    });
  }

  // Into the other block is still one of the editor's hosts.
  test('an unlock over a kept range moved into another block hands Backspace back', () => {
    const editor = two();
    expect(editor.focusRange('z', 6, 10)).toBe(true);
    (document.activeElement as HTMLElement).blur();
    editor.setEditable(false);
    const text = editor.element.querySelector(
      '[data-block-id="p"] .neditor-block__content',
    )!.firstChild!;
    getSelection()!.setBaseAndExtent(text, 1, text, 3);
    editor.setEditable(true);
    expect(press(document.body, 'Backspace')).toBe(false);
  });

  // The guard stays where nothing of the editor's takes the key: the
  // selection gone, or moved out of the editor.
  for (const label of ['gone', 'outside the editor'] as const) {
    test(`an unlock over a kept range now ${label} keeps Backspace held off`, () => {
      const editor = two();
      expect(editor.focusRange('z', 6, 10)).toBe(true);
      (document.activeElement as HTMLElement).blur();
      editor.setEditable(false);
      const outside = document.createElement('p');
      outside.textContent = 'page text';
      document.body.append(outside);
      const selection = getSelection()!;

      if (label === 'gone') {
        selection.removeAllRanges();
      } else {
        selection.setBaseAndExtent(outside.firstChild!, 1, outside.firstChild!, 4);
      }

      editor.setEditable(true);
      expect(press(document.body, 'Backspace')).toBe(true);
      outside.remove();
    });
  }
});

describe("a peer's update carries the caret by identity: the review's cases", () => {
  const one = (text: string, type: Block['type'] = 'paragraph'): Block =>
    block({ id: 'z', type, content: [{ text }] });
  const range = (editor: NEditor): unknown => editor.getSelectionState()?.range ?? null;

  // R12-RV-KEY-1, a2's literal case: "Hello there world" typed, the window in
  // the background (`document.hasFocus()` false -- another tab, another
  // window) when a peer appends "!". Judged by window focus, the reader was
  // "not typing", the range was dropped, and Chromium typed " you" at offset
  // 0 while Firefox and WebKit lost it. The focus chain decides instead: the
  // host still holds focus in its tree. Playwright emulates window focus for
  // every page, so the background state is pinned here with `hasFocus`
  // answering false, and in Chromium in block-selection.spec.ts (B34).
  test('a window in the background: the caret is still carried', () => {
    const editor = mount([one('Hello there world')]);
    expect(editor.focusRange('z', 11, 11)).toBe(true);
    const spy = vi.spyOn(document, 'hasFocus').mockReturnValue(false);

    try {
      editor.setDocument({ blocks: [one('Hello there world!')] }, { silent: true });
    } finally {
      spy.mockRestore();
    }

    expect(range(editor)).toEqual({ start: 11, end: 11 });
    expect(document.activeElement).toBe(hosts(editor)[0]);
  });

  // R12-RV-KEY-4a, c1's "delete-around" row: "Hello world" with the caret at
  // 5, a peer deleting "lo wo" around it. Neither side of the caret was
  // unchanged, so the block let go; but nothing was put in its place -- the
  // caret goes where the deleted text was.
  test('a deletion around the caret puts it where the text was', () => {
    const editor = mount([one('Hello world')]);
    expect(editor.focusRange('z', 5, 5)).toBe(true);

    editor.setDocument({ blocks: [one('Helrld')] }, { silent: true });

    expect(range(editor)).toEqual({ start: 3, end: 3 });
    expect(document.activeElement).toBe(hosts(editor)[0]);
  });

  // c1's "replace-word": text put in across the caret still lets go.
  test('text replaced across the caret still lets go', () => {
    const editor = mount([one('Hello world')]);
    expect(editor.focusRange('z', 3, 3)).toBe(true);

    editor.setDocument({ blocks: [one('Howdy world')] }, { silent: true });

    expect(editor.getSelectionState()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  // R12-RV-KEY-3, c1's "to-heading" and "to-heading+text" rows: the block a
  // peer turns into a heading keeps its id and its text, but the render
  // swaps its host element, and the caret fell to <body>. Same id, still a
  // text block: the new host takes the caret, carried.
  for (const [label, text, expected] of [
    ['same text', 'Hello world', 5],
    ['text added after', 'Hello world!', 5],
    ['text added before', 'NEW Hello world', 9],
  ] as const) {
    test(`a paragraph a peer makes a heading keeps the caret (${label})`, () => {
      const editor = mount([block({ id: 'a', content: [{ text: 'Before' }] }), one('Hello world')]);
      expect(editor.focusRange('z', 5, 5)).toBe(true);
      const old = hosts(editor)[1]!;

      editor.setDocument(
        { blocks: [block({ id: 'a', content: [{ text: 'Before' }] }), one(text, 'heading1')] },
        { silent: true },
      );

      const now = hosts(editor)[1]!;
      expect(now).not.toBe(old);
      expect(document.activeElement).toBe(now);
      expect(editor.getSelectionState()).toMatchObject({
        blockId: 'z',
        range: { start: expected, end: expected },
      });
      expect(press(document.body, 'Backspace')).toBe(false);
    });
  }

  // Not a text block any more, or not there: nothing is carried, and the
  // page is guarded as before.
  test('a paragraph a peer makes a divider: no caret, guarded', () => {
    const editor = mount([block({ id: 'a', content: [{ text: 'Before' }] }), one('Hello world')]);
    expect(editor.focusRange('z', 5, 5)).toBe(true);

    editor.setDocument(
      {
        blocks: [
          block({ id: 'a', content: [{ text: 'Before' }] }),
          block({ id: 'z', type: 'divider' }),
        ],
      },
      { silent: true },
    );

    expect(editor.getSelectionState()).toBeNull();
    expect(press(document.body, 'Backspace')).toBe(true);
  });

  // c2's literal cases: a table whose shape a peer changes keeps round 11's
  // let-go. Cells have no ids; a row above moves "alpha" to row 2, and the
  // editor does not follow it by coordinates or content.
  for (const [label, rows] of [
    [
      'a row added',
      [
        ['Name', 'Value'],
        ['alpha', 'one'],
        ['beta', 'two'],
      ],
    ],
    [
      'a row above',
      [
        ['Name', 'Value'],
        ['zero', '0'],
        ['alpha', 'one'],
      ],
    ],
    [
      'a column added',
      [
        ['Name', 'Value', 'Extra'],
        ['alpha', 'one', ''],
      ],
    ],
  ] as const) {
    test(`a table reshaped by a peer (${label}) lets go`, () => {
      const table = (cells: readonly (readonly string[])[]): Block =>
        block({
          id: 't',
          type: 'table',
          rows: cells.map((row) => row.map((text) => (text ? [{ text }] : []))),
        });
      const editor = mount([
        table([
          ['Name', 'Value'],
          ['alpha', 'one'],
        ]),
      ]);
      expect(editor.focusRange('t', 3, 3, { row: 1, column: 0 })).toBe(true);

      editor.setDocument({ blocks: [table(rows)] }, { silent: true });

      expect(editor.getSelectionState()).toBeNull();
      expect(document.activeElement).toBe(document.body);
      expect(press(document.body, 'Backspace')).toBe(true);
    });
  }
});

describe('a composition live in the host a peer redraws is never let go of', () => {
  // R12-RV-KEY-2, c3's and c5's literal case. The reader composing "にほ"
  // after "Hello", and a peer appending "!" to the committed text -- the
  // host never heard the composing text, which is not committed and fires
  // no `change`. The model held "Hello にほ world", the peer's text has no
  // "にほ", so both sides of the caret looked changed and the host let go
  // mid-composition: the composed word and everything typed after it were
  // lost. The carry is made against the text the composition started from,
  // at the offset it started at, and never lets go. happy-dom runs no IME:
  // the browser's per-candidate input is replayed by hand; the commit itself
  // is pinned in Chromium in block-selection.spec.ts (B35).
  const compose = (host: HTMLElement, at: number, text: string): void => {
    host.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const node = host.firstChild as Text;
    node.insertData(at, text);
    getSelection()!.setBaseAndExtent(node, at + text.length, node, at + text.length);
    host.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: text }),
    );
  };

  for (const [label, peer, expected] of [
    ['text after the composition', 'Hello world!', 5],
    ['text before it', 'NEW Hello world', 9],
    ['text on both sides of it', 'Hey there', 2],
  ] as const) {
    test(`a peer's update to ${label}: the caret stays in the host, where the composition began`, () => {
      const editor = mount([block({ id: 'z', content: [{ text: 'Hello world' }] })]);
      expect(editor.focusRange('z', 5, 5)).toBe(true);
      const host = hosts(editor)[0]!;
      compose(host, 5, 'にほ');
      expect(blockText(editor.getDocument().blocks[0]!)).toBe('Helloにほ world');

      editor.setDocument(
        { blocks: [block({ id: 'z', content: [{ text: peer }] })] },
        { silent: true },
      );

      expect(document.activeElement).toBe(host);
      expect(editor.getSelectionState()?.range).toEqual({ start: expected, end: expected });
      expect(press(document.body, 'Backspace')).toBe(false);
    });
  }
});

describe('a carried caret never lands inside a character', () => {
  // R12-RV2-KEY-1, p1 and p2's literal case: "X😀😁😂Y" with the caret after
  // "😀", and "X😁😂"... deleted by a peer down to "X😂Y" -- through a
  // `setDocument`, and across a lock. The caret went between the halves of
  // "😂"; Firefox then typed a lone surrogate into the model. The typing is
  // pinned in block-selection.spec.ts (B32b).
  const text = (t: string): Block[] => [block({ id: 'z', content: [{ text: t }] })];

  test('a peer deleting emoji around the caret', () => {
    const editor = mount(text('X😀😁😂Y'));
    expect(editor.focusRange('z', 3, 3)).toBe(true);

    editor.setDocument({ blocks: text('X😂Y') }, { silent: true });

    expect(editor.getSelectionState()?.range).toEqual({ start: 1, end: 1 });
  });

  test('the same deletion across a lock and an unlock', () => {
    const editor = mount(text('X😀😁😂Y'));
    expect(editor.focusRange('z', 3, 3)).toBe(true);

    editor.setEditable(false);
    editor.setDocument({ blocks: text('X😂Y') }, { silent: true });
    editor.setEditable(true);

    expect(editor.getSelectionState()?.range).toEqual({ start: 1, end: 1 });
  });
});

describe('a peer typing at the start of a range in repeated text stays outside it', () => {
  // R12-RV7-KEY-1, n5's literal case: "world" selected, a peer typing "w"
  // before it. The range took the "w" and "Q" typed over it left "hello Q".
  test('"hello world" with "world" selected, a "w" typed before it', () => {
    const editor = mount([block({ id: 'z', content: [{ text: 'hello world' }] })]);
    expect(editor.focusRange('z', 6, 11)).toBe(true);

    editor.setDocument(
      { blocks: [block({ id: 'z', content: [{ text: 'hello wworld' }] })] },
      { silent: true },
    );

    expect(editor.getSelectionState()?.range).toEqual({ start: 7, end: 12 });
  });

  // The peer typing "wide " a key at a time: each key stays out of the range.
  test('"wide " typed a key at a time', () => {
    const editor = mount([block({ id: 'z', content: [{ text: 'hello world' }] })]);
    expect(editor.focusRange('z', 6, 11)).toBe(true);

    for (const text of [
      'hello wworld',
      'hello wiworld',
      'hello widworld',
      'hello wideworld',
      'hello wide world',
    ]) {
      editor.setDocument({ blocks: [block({ id: 'z', content: [{ text }] })] }, { silent: true });
    }

    expect(editor.getSelectionState()?.range).toEqual({ start: 11, end: 16 });
  });
});

describe('a peer deleting text in repeated text never makes a range longer', () => {
  // R12-RV6-KEY-1, n1's literal case through setDocument: "ha ha ha!", the
  // second "ha" selected, a peer deleting "ha ". The range became {0,5}. The
  // deletion could have been the selected "ha" itself, so what every reading
  // agrees on is a caret where it began (rv7's intersection rule).
  test('the second "ha" is no longer than it was', () => {
    const editor = mount([block({ id: 'z', content: [{ text: 'ha ha ha!' }] })]);
    expect(editor.focusRange('z', 3, 5)).toBe(true);

    editor.setDocument(
      { blocks: [block({ id: 'z', content: [{ text: 'ha ha!' }] })] },
      { silent: true },
    );

    expect(editor.getSelectionState()?.range).toEqual({ start: 3, end: 3 });
  });

  // n2's case: the same "ha" selected backward (Shift+← from after it).
  test('made backward, it is no longer than it was either', () => {
    const editor = mount([block({ id: 'z', content: [{ text: 'ha ha ha!' }] })]);
    const host = hosts(editor)[0]!;
    host.focus();
    const text = host.firstChild!;
    getSelection()!.setBaseAndExtent(text, 5, text, 3);

    editor.setDocument(
      { blocks: [block({ id: 'z', content: [{ text: 'ha ha!' }] })] },
      { silent: true },
    );

    expect(editor.getSelectionState()?.range).toEqual({ start: 3, end: 3 });
  });
});

describe('a peer extending the character before the caret leaves the caret after it', () => {
  // R12-RV3-KEY-1, g1's and g2's literal cases: "नम" with the caret after
  // "म", a peer adding the matra "ा" to it. Snapped back, the caret went
  // before "म" and the next letter split the word ("नQमाY"); a range over
  // "म" collapsed. The pinned typing is in block-selection.spec.ts (B32c).
  const text = (t: string): Block[] => [block({ id: 'z', content: [{ text: t }] })];

  test('a caret', () => {
    const editor = mount(text('नमY'));
    expect(editor.focusRange('z', 2, 2)).toBe(true);

    editor.setDocument({ blocks: text('नमाY') }, { silent: true });

    expect(editor.getSelectionState()?.range).toEqual({ start: 3, end: 3 });
  });

  test('a range over the character covers it extended', () => {
    const editor = mount(text('XeY'));
    expect(editor.focusRange('z', 1, 2)).toBe(true);

    editor.setDocument({ blocks: text('Xe\u0301Y') }, { silent: true });

    expect(editor.getSelectionState()?.range).toEqual({ start: 1, end: 3 });
  });

  test('across a lock and an unlock', () => {
    const editor = mount(text('नमY'));
    expect(editor.focusRange('z', 2, 2)).toBe(true);

    editor.setEditable(false);
    editor.setDocument({ blocks: text('नमाY') }, { silent: true });
    editor.setEditable(true);

    expect(editor.getSelectionState()?.range).toEqual({ start: 3, end: 3 });
  });
});

describe('a composition a peer redrew is recorded where the caret was carried', () => {
  // R12-RV2-KEY-4, the order the reviewer could not observe: the carry runs
  // before the composition is re-anchored, which notes the caret as the
  // place undoing the composed word returns to. Re-anchored first, the note
  // was taken from the redrawn host -- offset 0 -- and the undo put the caret
  // at the block's start. (Chromium's B35 lands right either way; this is
  // where the swap fails.)
  test('undo after the commit puts the caret where the composition was carried', () => {
    const editor = mount([block({ id: 'z', content: [{ text: 'Hello world' }] })]);
    expect(editor.focusRange('z', 5, 5)).toBe(true);
    const host = hosts(editor)[0]!;
    host.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    (host.firstChild as Text).insertData(5, 'にほ');
    getSelection()!.setBaseAndExtent(host.firstChild!, 7, host.firstChild!, 7);
    host.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: 'にほ' }),
    );

    editor.setDocument(
      { blocks: [block({ id: 'z', content: [{ text: 'NEW Hello world' }] })] },
      { silent: true },
    );
    expect(editor.getSelectionState()?.range).toEqual({ start: 9, end: 9 });

    const node = host.firstChild as Text;
    node.insertData(9, '日本');
    getSelection()!.setBaseAndExtent(node, 11, node, 11);
    host.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本' }));
    expect(blockText(editor.getDocument().blocks[0]!)).toBe('NEW Hello日本 world');

    expect(editor.undo()).toBe(true);
    expect(blockText(editor.getDocument().blocks[0]!)).toBe('NEW Hello world');
    expect(editor.getSelectionState()?.range).toEqual({ start: 9, end: 9 });
  });
});

describe('setEditable(false) then true puts the caret back by id', () => {
  // R12-RV-KEY-4b, e1's literal case: the caret at the end of "Bravo two", a
  // host locking the editor round a save and unlocking it -- in the same task
  // or 100 ms later. Round 12 took focus off the block on the lock (KEY-2),
  // and nothing gave it back: the reader's "X" landed nowhere, where before
  // it had reached the block in Firefox and WebKit. Put back by id, at the
  // offsets it had -- while the reader has not placed themselves elsewhere.
  const doc = (): Block[] => [
    block({ id: 'a', content: [{ text: 'Alpha one' }] }),
    block({ id: 'b', content: [{ text: 'Bravo two' }] }),
  ];

  test('a lock and an unlock: the caret is back where it was', () => {
    const editor = mount(doc());
    expect(editor.focusRange('b', 9, 9)).toBe(true);

    editor.setEditable(false);
    expect(document.activeElement).toBe(document.body);
    editor.setEditable(true);

    expect(document.activeElement).toBe(hosts(editor)[1]);
    expect(editor.getSelectionState()).toMatchObject({ blockId: 'b', range: { start: 9, end: 9 } });
    expect(press(document.body, 'Backspace')).toBe(false);
  });

  test('a range comes back as a range, and the text changed meanwhile carries it', () => {
    const editor = mount(doc());
    expect(editor.focusRange('b', 6, 9)).toBe(true);

    editor.setEditable(false);
    editor.setDocument(
      {
        blocks: [
          block({ id: 'a', content: [{ text: 'Alpha one' }] }),
          block({ id: 'b', content: [{ text: 'NEW Bravo two' }] }),
        ],
      },
      { silent: true },
    );
    editor.setEditable(true);

    expect(editor.getSelectionState()).toMatchObject({
      blockId: 'b',
      range: { start: 10, end: 13 },
    });
  });

  test('the reader placed themselves meanwhile: nothing is moved', () => {
    const editor = mount(doc());
    expect(editor.focusRange('b', 9, 9)).toBe(true);

    editor.setEditable(false);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    editor.setEditable(true);

    // (happy-dom keeps the old selection in the blurred block; focus says
    // where the reader is.)
    expect(document.activeElement).toBe(document.body);
  });

  test('the block gone meanwhile: nothing anywhere else takes the caret', () => {
    const editor = mount(doc());
    expect(editor.focusRange('b', 9, 9)).toBe(true);

    editor.setEditable(false);
    editor.setDocument({ blocks: [block({ id: 'a', content: [{ text: 'Alpha one' }] })] });
    editor.setEditable(true);

    expect(document.activeElement).toBe(document.body);
    expect(editor.getSelectionState()).toBeNull();
    expect(press(document.body, 'Backspace')).toBe(true);
  });

  // R12-RV2-KEY-4, r3's literal case: the reader moves to a toggle's
  // chevron during the lock -- they have placed themselves -- and a peer
  // then removes the toggle, which drops that focus on the page and arms the
  // guard again. The unlock must not hand back the caret from before the
  // lock: placing themselves forgot it.
  test('the reader moved to a control, and focus fell back to the page: nothing is moved', () => {
    const editor = mount([
      block({ id: 'a', content: [{ text: 'Hello world' }] }),
      block({ id: 't', type: 'toggle', content: [{ text: 'Toggle' }] }),
      block({ id: 'c', depth: 1, content: [{ text: 'child' }] }),
    ]);
    expect(editor.focusRange('a', 11, 11)).toBe(true);

    editor.setEditable(false);
    editor.element.querySelector<HTMLElement>('.neditor-block__chevron')!.focus();
    editor.setDocument({ blocks: [block({ id: 'a', content: [{ text: 'Hello world' }] })] });
    expect(document.activeElement).toBe(document.body);
    expect(press(document.body, 'Backspace')).toBe(true);
    editor.setEditable(true);

    expect(document.activeElement).toBe(document.body);
  });

  // R12-RV4-KEY-1, g3's literal case: the reader's caret inside "क्म" (as
  // Firefox leaves it after typing the virama), a lock and an unlock with no
  // change at all. The unlock carried the offsets anyway, and the snap moved
  // the caret from 2 to 3. Unchanged text is put back exactly as it was.
  test('unchanged text: the caret comes back exactly, even inside a character', () => {
    const editor = mount([block({ id: 'z', content: [{ text: 'क्मल end' }] })]);
    expect(editor.focusRange('z', 2, 2)).toBe(true);

    editor.setEditable(false);
    editor.setEditable(true);

    expect(editor.getSelectionState()?.range).toEqual({ start: 2, end: 2 });
  });

  // R12-RV6-KEY-1, n3's literal case on the lock path: the second "ha" of
  // "ha ha ha!" selected, a lock, a peer deleting "ha ", the unlock. The
  // range came back as {0,5}, and "Q" typed over it left "Q!".
  test('a range put back across a deletion in repeated text is no longer than it was', () => {
    const editor = mount([block({ id: 'z', content: [{ text: 'ha ha ha!' }] })]);
    expect(editor.focusRange('z', 3, 5)).toBe(true);

    editor.setEditable(false);
    editor.setDocument(
      { blocks: [block({ id: 'z', content: [{ text: 'ha ha!' }] })] },
      { silent: true },
    );
    editor.setEditable(true);

    expect(editor.getSelectionState()?.range).toEqual({ start: 3, end: 3 });
  });

  // R12-RV8-KEY-1 on the lock path (v2): "😀!" selected in "ok 👍😀!", a
  // lock, the peer deleting 👍, the unlock. A reading that cut 👍's pair
  // was counted, and the range came back as "!" alone.
  // R12-RV11-KEY-1 on the lock path: a range that starts inside a character
  // of the reader's own (Firefox, "क्" typed before "म"), and a peer's
  // insertion that leaves nothing of it, give back a caret at the
  // character's start.
  test('a range from inside a character, emptied across a lock, is a caret at its start', () => {
    const editor = mount([block({ id: 'z', content: [{ text: 'क्म' }] })]);
    expect(editor.focusRange('z', 2, 3)).toBe(true);

    editor.setEditable(false);
    editor.setDocument(
      { blocks: [block({ id: 'z', content: [{ text: 'क्म्म' }] })] },
      { silent: true },
    );
    editor.setEditable(true);

    expect(editor.getSelectionState()?.range).toEqual({ start: 0, end: 0 });
  });

  test('a range put back across a deletion that shares a code unit with it', () => {
    const editor = mount([block({ id: 'z', content: [{ text: 'ok 👍😀!' }] })]);
    expect(editor.focusRange('z', 5, 8)).toBe(true);

    editor.setEditable(false);
    editor.setDocument(
      { blocks: [block({ id: 'z', content: [{ text: 'ok 😀!' }] })] },
      { silent: true },
    );
    editor.setEditable(true);

    expect(editor.getSelectionState()?.range).toEqual({ start: 3, end: 6 });
  });

  test('a block selection is not brought back', () => {
    const editor = mount(doc());
    hosts(editor)[1]!.focus();
    press(hosts(editor)[1]!, 'Escape');

    editor.setEditable(false);
    editor.setEditable(true);

    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(document.activeElement).toBe(document.body);
  });
});

describe('setEditable(false) under the reader leaves no Backspace for the page', () => {
  // R12-KEY-2, p13's literal cases: the reader typing in a block, holding a
  // block selection, or in the F10 toolbar or the link editor, and the host
  // switching the editor read-only (a lock, a peer's permission change).
  // Focus fell to <body> -- or the root kept it with nothing selected -- and
  // WebKit's next Backspace went back in history. happy-dom has no history;
  // the cancel is pinned here and the navigation in read-only.spec.ts.
  const doc = (): Block[] => [
    block({ id: 'a', content: [{ text: 'Alpha' }] }),
    block({ id: 'b', content: [{ text: 'Bravo' }] }),
  ];

  test('a caret in a block: focus goes to <body>, Backspace is held off', () => {
    const editor = mount(doc());
    expect(editor.focus('a', 3)).toBe(true);

    editor.setEditable(false);

    expect(document.activeElement).toBe(document.body);
    expect(press(document.body, 'Backspace')).toBe(true);
  });

  test('a block selection: it ends, the root lets go, Backspace is held off', () => {
    const editor = mount(doc());
    hosts(editor)[1]!.focus();
    press(hosts(editor)[1]!, 'Escape');
    expect(editor.getSelectedBlocks()).toEqual(['b']);
    expect(document.activeElement).toBe(editor.element);

    editor.setEditable(false);

    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(document.activeElement).toBe(document.body);
    expect(press(document.body, 'Backspace')).toBe(true);
    expect(texts(editor)).toEqual(['Alpha', 'Bravo']);
  });

  test('the link editor: its field is blurred, Backspace is held off', () => {
    const editor = mount(doc());
    expect(editor.focusRange('b', 0, 5)).toBe(true);
    editor.openLinkEditor();
    const fields = document.querySelectorAll<HTMLInputElement>('.neditor-link-editor input');
    fields[fields.length - 1]!.focus();

    editor.setEditable(false);

    expect(document.activeElement).toBe(document.body);
    expect(press(document.body, 'Backspace')).toBe(true);
  });

  test('the F10 table toolbar: its button is blurred, Backspace is held off', () => {
    const editor = mount([
      block({
        id: 't',
        type: 'table',
        rows: [
          [[{ text: 'a1' }], [{ text: 'b1' }]],
          [[{ text: 'a2' }], [{ text: 'b2' }]],
        ],
      }),
    ]);
    expect(editor.focusRange('t', 2, 2, { row: 1, column: 0 })).toBe(true);
    const cell = editor.element.querySelector<HTMLElement>('[data-cell="1:0"]')!;
    expect(press(cell, 'F10')).toBe(true);
    expect(
      (document.activeElement as HTMLElement).classList.contains('neditor-table-toolbar__button'),
    ).toBe(true);

    editor.setEditable(false);

    expect(document.activeElement).toBe(document.body);
    expect(press(document.body, 'Backspace')).toBe(true);
  });

  // Focus that was never the editor's arms nothing, and neither does a
  // second switch with focus already on the page.
  test('focus in a page field: untouched, nothing armed', () => {
    const editor = mount(doc());
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();

    editor.setEditable(false);

    expect(document.activeElement).toBe(field);
    field.remove();
    expect(press(document.body, 'Backspace')).toBe(false);
  });

  test('focus already on the page: nothing armed', () => {
    const editor = mount(doc());

    editor.setEditable(false);
    editor.setEditable(false);

    expect(press(document.body, 'Backspace')).toBe(false);
  });

  // A control the read-only view keeps focusable keeps focus: the reader is
  // on it, not on the page.
  test('focus on a toggle chevron stays there, and arms nothing', () => {
    const editor = mount([
      block({ id: 'g', type: 'toggle', content: [{ text: 'Toggle' }] }),
      block({ id: 'c', depth: 1, content: [{ text: 'Child' }] }),
    ]);
    const chevron = editor.element.querySelector<HTMLElement>('.neditor-block__chevron')!;
    chevron.focus();
    expect(document.activeElement).toBe(chevron);

    editor.setEditable(false);

    expect(document.activeElement).toBe(chevron);
    expect(press(document.body, 'Backspace')).toBe(false);
  });
});

describe('a Backspace that lands on the page after the editor let go is not a Back', () => {
  // R10-RV-KEY-2, the reviewer's literal case: "Bravo" selected with a click
  // and Escape, and the host reloading from Markdown -- every id new, so the
  // editor lets go of focus (`#letGo`). With focus on <body>, WebKit's
  // Backspace goes back in history: the page the reader was editing left.
  // Round 9 deleted "Bravo" instead. happy-dom has no history to go back in,
  // so what is pinned is the cancel; the navigation itself is pinned in
  // WebKit (block-selection.spec.ts, B24).
  const bravo = (): NEditor =>
    mount(
      ['Title', 'Alpha', 'Bravo', 'Charlie'].map((text) =>
        block({ id: text.toLowerCase(), content: [{ text }] }),
      ),
    );
  const reload = (editor: NEditor): void =>
    editor.setDocument({ blocks: blocksFromMarkdown(toMarkdown(editor.getDocument())) });
  const letGoFromBravo = (): NEditor => {
    const editor = bravo();
    const host = hosts(editor)[2]!;
    host.focus();
    press(host, 'Escape');
    expect(editor.getSelectedBlocks()).toEqual(['bravo']);
    reload(editor);
    expect(document.activeElement).toBe(document.body);
    return editor;
  };

  test('the next Backspace on <body> is cancelled, and changes nothing', () => {
    const editor = letGoFromBravo();
    const before = texts(editor);

    expect(press(document.body, 'Backspace')).toBe(true);
    expect(texts(editor)).toEqual(before);
  });

  test('aimed at the document element too', () => {
    letGoFromBravo();

    expect(press(document.documentElement, 'Backspace')).toBe(true);
  });

  // R11-KEY-2, p1's literal case: after a reload lets go, the reader presses
  // Backspace afresh and holds it -- one fresh keydown, then repeats. Kept
  // only through a press that was itself a repeat, the guard was spent by the
  // fresh press, and the first repeat navigated WebKit back.
  test('a fresh press held after it let go: every repeat is cancelled', () => {
    const editor = letGoFromBravo();
    const before = texts(editor);

    expect(press(document.body, 'Backspace')).toBe(true);
    for (let i = 0; i < 4; i += 1) {
      expect(press(document.body, 'Backspace', { repeat: true })).toBe(true);
    }
    release(document.body, 'Backspace');
    expect(texts(editor)).toEqual(before);
  });

  // R11-RV-KEY-2, q4's and q3's literal sequences. Spent by the Backspace's
  // keyup or by any other key, the guard let the next Backspace go Back: the
  // second press (the natural answer to one that did nothing), "x" then
  // Backspace, ArrowDown then Backspace, and a word typed over a block
  // selection under a Markdown echo ("q" typed over it, "uick" on <body>).
  // Every Backspace aimed at the page is cancelled until the reader puts
  // focus or the pointer somewhere.
  for (const [label, keys] of [
    ['a second press', ['Backspace', 'Backspace']],
    ['"x" then Backspace', ['x', 'Backspace']],
    ['ArrowDown then Backspace', ['ArrowDown', 'Backspace']],
    ['"uick" then Backspace', ['u', 'i', 'c', 'k', 'Backspace']],
    ['Alt, Shift or Meta with Backspace', ['Backspace', 'Backspace', 'Backspace']],
  ] as const) {
    test(`still armed after keys and keyups: ${label}`, () => {
      letGoFromBravo();
      const modifiers = [{ altKey: true }, { shiftKey: true }, { metaKey: true }];

      const cancelled = keys.map((key, i) => {
        const init = label.startsWith('Alt') ? modifiers[i]! : {};
        const prevented = press(document.body, key, init);
        release(document.body, key);
        return key === 'Backspace' ? prevented : null;
      });

      expect(cancelled.filter((value) => value !== null)).toEqual(
        keys.filter((key) => key === 'Backspace').map(() => true),
      );
    });
  }

  // What spends it: the reader putting focus or the pointer somewhere.
  test('a pointerdown spends it', () => {
    letGoFromBravo();
    expect(press(document.body, 'Backspace')).toBe(true);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(press(document.body, 'Backspace')).toBe(false);
  });

  test('a focusin spends it', () => {
    letGoFromBravo();
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    expect(press(field, 'Backspace')).toBe(false);
    field.blur();
    field.remove();
    expect(press(document.body, 'Backspace')).toBe(false);
  });

  // R12-KEY-6: the Tab key itself does not spend it -- the focus it moves
  // does. In a modal dialog with nothing focused, WebKit's Tab focused the
  // `<dialog>` element itself, and the Backspace after it went back in
  // history. happy-dom moves no focus on a Tab, so the focus it would move
  // is dispatched by hand; the WebKit sequence is pinned in
  // block-selection.spec.ts.
  for (const [label, init] of [
    ['Tab', {}],
    ['Shift+Tab', { shiftKey: true }],
  ] as const) {
    test(`${label} that moves no focus leaves it armed`, () => {
      letGoFromBravo();
      expect(press(document.body, 'Backspace')).toBe(true);
      press(document.body, 'Tab', init);
      expect(press(document.body, 'Backspace')).toBe(true);
    });

    test(`${label} onto a control spends it`, () => {
      letGoFromBravo();
      const button = document.createElement('button');
      document.body.append(button);
      press(document.body, 'Tab', init);
      button.focus();
      button.blur();
      button.remove();
      expect(press(document.body, 'Backspace')).toBe(false);
    });
  }

  test('focus arriving on a <dialog> element does not spend it, and Backspace there is cancelled', () => {
    letGoFromBravo();
    const dialog = document.createElement('dialog');
    dialog.tabIndex = -1;
    document.body.append(dialog);
    press(document.body, 'Tab');
    dialog.focus();
    expect(document.activeElement).toBe(dialog);

    expect(press(dialog, 'Backspace')).toBe(true);
    dialog.remove();
  });

  test('destroy spends it', () => {
    const editor = letGoFromBravo();
    expect(press(document.body, 'Backspace')).toBe(true);
    editor.destroy();

    expect(press(document.body, 'Backspace')).toBe(false);
  });

  test('a Backspace aimed anywhere but the page itself is never touched', () => {
    letGoFromBravo();
    const field = document.createElement('div');
    field.contentEditable = 'true';
    document.body.append(field);

    expect(press(field, 'Backspace')).toBe(false);
  });

  // Escape twice is left exactly as it was: the reader chose to leave.
  test('Escape twice does not arm it', () => {
    const editor = bravo();
    const host = hosts(editor)[2]!;
    host.focus();
    press(host, 'Escape');
    press(editor.element, 'Escape');
    expect(editor.element.contains(document.activeElement)).toBe(false);

    expect(press(document.body, 'Backspace')).toBe(false);
  });

  // R11-KEY-3, p3's literal case: a host whose `change` listener reloads from
  // Markdown after a debounce (0, 20 or 200 ms), and a Backspace held on a
  // block selection or at the end of a block. The press deleted and placed
  // the caret by id; the reload then renamed every block and took the
  // focused host out from under the caret, focus fell to <body> with no
  // `#letGo` to arm the guard, and the held key's repeats went back in
  // history. `setDocument` arms it itself when the render drops focus that
  // was in the editor onto the page.
  for (const mode of ['blocks', 'text'] as const) {
    test(`a debounced reload that drops the focused host arms it (${mode})`, async () => {
      const editor = mount(
        ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map((text) =>
          block({ id: text[0]!.toLowerCase(), content: [{ text }] }),
        ),
      );
      let reloaded: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        reloaded = resolve;
      });
      const reload = (): void => {
        setTimeout(() => {
          editor.setDocument(
            { blocks: blocksFromMarkdown(toMarkdown(editor.getDocument())) },
            { silent: true },
          );
          reloaded();
        }, 0);
      };
      editor.on('change', reload);
      const host = hosts(editor)[2]!;
      host.focus();

      // Before the reload, focus is in a block: "Delta", placed by id after
      // the block delete (third of the four left), or still "Charlie".
      const [selectedFirst, before] = {
        blocks: (): [string[], string[]] => {
          press(host, 'Escape');
          const selected = editor.getSelectedBlocks();
          press(editor.element, 'Backspace');
          return [selected, ['Alpha', 'Bravo', 'Delta', 'Echo']];
        },
        // happy-dom deletes nothing on a Backspace keydown, so the edit the
        // browser makes is the host's own reload, as after a typed edit.
        text: (): [string[], string[]] => {
          reload();
          return [[], ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']];
        },
      }[mode]();
      expect(selectedFirst).toEqual(mode === 'blocks' ? ['c'] : []);
      expect(document.activeElement).toBe(hosts(editor)[2]);
      expect(blockText(editor.getDocument().blocks[2]!)).toBe(
        mode === 'blocks' ? 'Delta' : 'Charlie',
      );

      await done;
      expect(texts(editor)).toEqual(before);
      expect(document.activeElement).toBe(document.body);
      expect(press(document.body, 'Backspace', { repeat: true })).toBe(true);
      expect(press(document.body, 'Backspace', { repeat: true })).toBe(true);
      release(document.body, 'Backspace');
      expect(press(document.body, 'Backspace')).toBe(true);
    });
  }

  // Focus that was never the editor's is not touched, and arms nothing.
  test('a setDocument while focus is on a page field does not arm it', () => {
    const editor = bravo();
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();

    editor.setDocument({ blocks: blocksFromMarkdown(toMarkdown(editor.getDocument())) });
    field.remove();

    expect(document.activeElement).toBe(document.body);
    expect(press(document.body, 'Backspace')).toBe(false);
  });

  // Nor focus already on the page: the reader left before the update came.
  test('a setDocument with focus already on <body> does not arm it', () => {
    const editor = bravo();
    hosts(editor)[2]!.focus();
    hosts(editor)[2]!.blur();
    expect(document.activeElement).toBe(document.body);

    editor.setDocument({ blocks: blocksFromMarkdown(toMarkdown(editor.getDocument())) });

    expect(press(document.body, 'Backspace')).toBe(false);
  });

  // Nor a render the focused host survives by id: focus stays in it.
  test('a setDocument that keeps the focused host does not arm it', () => {
    const editor = bravo();
    hosts(editor)[2]!.focus();

    editor.setDocument(editor.getDocument());

    expect(document.activeElement).toBe(hosts(editor)[2]);
    (document.activeElement as HTMLElement).blur();
    expect(press(document.body, 'Backspace')).toBe(false);
  });

  // A peer deleting the selected block with ids kept lets go (R12-KEY-4),
  // and arms it like any other let-go.
  test('a peer deleting the selection with ids kept arms it', () => {
    const editor = bravo();
    editor.selectBlocks(['bravo']);
    editor.setDocument({
      blocks: editor.getDocument().blocks.filter((b) => b.id !== 'bravo'),
    });
    expect(editor.getSelectionState()).toBeNull();
    expect(document.activeElement).toBe(document.body);

    expect(press(document.body, 'Backspace')).toBe(true);
  });
});

describe('a block-mode delete, cut or duplicate under a renaming host lands by id or not at all', () => {
  // R10-KEY-3, p19's literal case: forty paragraphs, "Paragraph 10" selected,
  // and a host that answers every `change` with a Markdown reload. The
  // landing looked its neighbours up by id in the committed array and read a
  // miss as position 0: every block counted as before the deletion, and the
  // caret went to the end of "Paragraph 39" -- the page scrolled, and the next
  // key was typed there.
  const forty = (): Block[] =>
    Array.from({ length: 40 }, (_, i) =>
      block({ id: `p${i}`, content: [{ text: `Paragraph ${i}` }] }),
    );
  const echoing = (): NEditor => {
    const editor = mount(forty());
    editor.on('change', () => {
      editor.setDocument(
        { blocks: blocksFromMarkdown(toMarkdown(editor.getDocument())) },
        { silent: true },
      );
    });
    const host = hosts(editor)[10]!;
    host.focus();
    press(host, 'Escape');
    expect(editor.getSelectedBlocks()).toEqual(['p10']);

    return editor;
  };
  const letGo = (editor: NEditor): void => {
    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(editor.getSelectionState()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  };

  for (const key of ['Delete', 'Backspace'] as const) {
    test(`${key}: no caret at the end of "Paragraph 39"; "Block deleted"`, () => {
      const editor = echoing();

      press(editor.element, key);

      expect(texts(editor)).toHaveLength(39);
      expect(texts(editor)).not.toContain('Paragraph 10');
      letGo(editor);
      expect(live(editor)).toBe('Block deleted');
    });
  }

  test('a cut the same, and it says "Block cut"', () => {
    const editor = echoing();
    const event = new ClipboardEvent('cut', {
      bubbles: true,
      cancelable: true,
      clipboardData: new DataTransfer(),
    });

    editor.element.dispatchEvent(event);

    expect(texts(editor)).not.toContain('Paragraph 10');
    letGo(editor);
    expect(live(editor)).toBe('Block cut');
  });

  // The copies were renamed by the echo, so `#setBlockSelection` found none
  // of them, and the count read from the selection that followed said "0
  // blocks duplicated" while the caret went back to "Paragraph 10".
  test('Mod+D counts the copies it made, and selects none it cannot name', () => {
    const editor = echoing();

    press(editor.element, 'd', { ctrlKey: true, metaKey: true });

    expect(texts(editor).filter((text) => text === 'Paragraph 10')).toHaveLength(2);
    letGo(editor);
    expect(live(editor)).toBe('Block duplicated. No blocks selected');
  });

  test('two duplicated: "2 blocks duplicated"', () => {
    const editor = echoing();
    press(editor.element, 'ArrowDown', { shiftKey: true });
    expect(editor.getSelectedBlocks()).toHaveLength(2);

    press(editor.element, 'd', { ctrlKey: true, metaKey: true });

    expect(live(editor)).toBe('2 blocks duplicated. No blocks selected');
  });

  // The sibling on the clipboard path: a paste over the selection selects
  // the pasted blocks by id. Renamed by the echo, none was found, and the
  // root was left focused with nothing selected and no caret.
  test('a paste over the selection: the pasted blocks or nothing, never neither mode', () => {
    const editor = echoing();
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'Pasted one\n\nPasted two');

    editor.element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
    );

    expect(texts(editor).slice(9, 12)).toEqual(['Paragraph 9', 'Pasted one', 'Pasted two']);
    letGo(editor);
  });

  test('a paste with no echo still selects what it pasted', () => {
    const editor = mount(forty());
    editor.selectBlocks(['p10']);
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'Pasted one\n\nPasted two');

    editor.element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
    );

    expect(editor.getSelectedBlocks()).toHaveLength(2);
    expect(document.activeElement).toBe(editor.element);
  });

  // A host that gives each new block an id of its own and keeps the rest: the
  // originals are still selected when the copies come back renamed, and the
  // caret went into the original "Paragraph 10" -- not where the copies are,
  // and not what Mod+D selects. The copies by id or nothing.
  test('a host that renames only new blocks: the copies or nothing, never the original', () => {
    const editor = mount(forty());
    let next = 0;
    const known = new Set(editor.getDocument().blocks.map((b) => b.id));
    editor.on('change', () => {
      const blocks = editor.getDocument().blocks.map((b) => {
        if (known.has(b.id)) {
          return b;
        }

        const id = `srv${next++}`;
        known.add(id);
        return { ...b, id };
      });
      editor.setDocument({ blocks }, { silent: true });
    });
    editor.selectBlocks(['p10']);

    press(editor.element, 'd', { ctrlKey: true, metaKey: true });

    expect(texts(editor).filter((text) => text === 'Paragraph 10')).toHaveLength(2);
    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(editor.getSelectionState()).toBeNull();
    expect(document.activeElement).toBe(document.body);
    expect(live(editor)).toBe('Block duplicated. No blocks selected');
  });

  // `#focusNearChange`, the undo path's last resort, is the same family: a
  // landing by id or none. With nothing able to take the caret, the root that
  // held focus is let go of rather than left focused in neither mode.
  test('an undo with nowhere to put the caret lets go of the root', () => {
    const editor = mount(forty());
    editor.setBlockType('p10', 'heading1');
    editor.element.focus();
    expect(document.activeElement).toBe(editor.element);
    const real = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'focus')!
      .value as HTMLElement['focus'];
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      if (!this.classList.contains('neditor-block__content')) {
        Reflect.apply(real, this, [options]);
      }
    });

    try {
      expect(editor.undo()).toBe(true);
    } finally {
      spy.mockRestore();
    }

    expect(editor.getDocument().blocks[10]!.type).toBe('paragraph');
    expect(document.activeElement).toBe(document.body);
  });

  // The landing without an echo is unchanged: the block that moved up into
  // the gap, and the copies selected under their own ids.
  test('without an echo: the caret at the start of "Paragraph 11", copies selected', () => {
    const editor = mount(forty());
    editor.selectBlocks(['p10']);

    press(editor.element, 'Delete');

    expect(editor.getSelectionState()).toMatchObject({ blockId: 'p11', range: { start: 0 } });

    editor.selectBlocks(['p11']);
    press(editor.element, 'd', { ctrlKey: true, metaKey: true });

    expect(editor.getSelectedBlocks()).toHaveLength(1);
    expect(editor.getSelectedBlocks()[0]).not.toBe('p11');
    expect(live(editor)).toMatch(/^Block duplicated\. Paragraph selected, Paragraph 11$/);
  });
});

describe('a kept block selection keeps the end it was extended from', () => {
  // R9-KEY-2, p13's literal case: a caret in "d", Escape, Shift+↑ twice --
  // [b, c, d], made from d -- and a peer deleting d. The anchor passed to the
  // first id kept, the far end, so Shift+↑ shrank the selection to [b].
  const fiveBlocks = (): Block[] =>
    ['a', 'b', 'c', 'd', 'e'].map((id) =>
      block({ id, content: [{ text: `Block ${id.toUpperCase()}` }] }),
    );

  function selectUpFromD(editor: NEditor): void {
    hosts(editor)[3]!.focus();
    press(hosts(editor)[3]!, 'Escape');
    press(editor.element, 'ArrowUp', { shiftKey: true });
    press(editor.element, 'ArrowUp', { shiftKey: true });
    expect(editor.getSelectedBlocks()).toEqual(['b', 'c', 'd']);
  }

  test('Shift+↑ grows from the survivor nearest the lost anchor', () => {
    const editor = mount(fiveBlocks());
    selectUpFromD(editor);

    editor.setDocument({ blocks: editor.getDocument().blocks.filter((b) => b.id !== 'd') });
    expect(editor.getSelectedBlocks()).toEqual(['b', 'c']);

    press(editor.element, 'ArrowUp', { shiftKey: true });
    expect(editor.getSelectedBlocks()).toEqual(['a', 'b', 'c']);
  });

  test('Shift+↓ shrinks towards it', () => {
    const editor = mount(fiveBlocks());
    selectUpFromD(editor);

    editor.setDocument({ blocks: editor.getDocument().blocks.filter((b) => b.id !== 'd') });

    press(editor.element, 'ArrowDown', { shiftKey: true });
    expect(editor.getSelectedBlocks()).toEqual(['c']);
  });

  // A selection made with the anchor at its top: the nearest survivor is
  // then the block after it, and Shift+↓ goes on growing downwards.
  test('the mirror: made downwards from b, b deleted', () => {
    const editor = mount(fiveBlocks());
    hosts(editor)[1]!.focus();
    press(hosts(editor)[1]!, 'Escape');
    press(editor.element, 'ArrowDown', { shiftKey: true });
    press(editor.element, 'ArrowDown', { shiftKey: true });
    expect(editor.getSelectedBlocks()).toEqual(['b', 'c', 'd']);

    editor.setDocument({ blocks: editor.getDocument().blocks.filter((b) => b.id !== 'b') });

    press(editor.element, 'ArrowDown', { shiftKey: true });
    expect(editor.getSelectedBlocks()).toEqual(['c', 'd', 'e']);
  });

  // R9-RV-SEL-3 (MB): an anchor in the middle -- [b, c, d] made from c by the
  // API -- and c deleted. b and d are equally near, and the tie goes to the
  // earlier block: with b the anchor, Shift+↓ moves the far end to e.
  test('a tie goes to the earlier survivor', () => {
    const editor = mount(fiveBlocks());
    editor.selectBlocks(['c', 'b', 'd']);

    editor.setDocument({ blocks: editor.getDocument().blocks.filter((b) => b.id !== 'c') });
    expect(editor.getSelectedBlocks()).toEqual(['b', 'd']);

    press(editor.element, 'ArrowDown', { shiftKey: true });
    expect(editor.getSelectedBlocks()).toEqual(['b', 'd', 'e']);
  });
});

describe("the editor's own focus leaves block selection before anyone hears it", () => {
  // R9-RV-SEL-2, p06's literal case: a host's own button whose click calls
  // `editor.focus('a', 2)` while a block is selected. The click is within the
  // pointer's grace period, so `#handleFocusIn` kept the selection, and the
  // `focus` event reached listeners with both modes live.
  test('a focus() from a click: `focus` is heard with the block selection already gone', () => {
    const editor = mount(abc());
    editor.selectBlocks([idFor(editor, 'c')]);
    const heard: string[][] = [];
    const order: string[] = [];
    editor.on('focus', () => {
      heard.push(editor.getSelectedBlocks());
      order.push('focus');
    });
    editor.on('blockselection', ({ ids }) => order.push(`blockselection[${ids.length}]`));

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    expect(editor.focus(idFor(editor, 'a'), 0)).toBe(true);

    expect(heard).toEqual([[]]);
    expect(order).toEqual(['blockselection[0]', 'focus']);
    expect(editor.getSelectedBlocks()).toEqual([]);
  });

  test('focusRange the same', () => {
    const editor = mount(abc());
    editor.selectBlocks([idFor(editor, 'c')]);
    const heard: string[][] = [];
    editor.on('focus', () => heard.push(editor.getSelectedBlocks()));

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    expect(editor.focusRange(idFor(editor, 'a'), 0, 1)).toBe(true);

    expect(heard).toEqual([[]]);
  });

  test('within the grace period a focus that fails still changes nothing', () => {
    const editor = mount(abc());
    editor.selectBlocks([idFor(editor, 'c')]);
    hosts(editor)[0]!.focus = () => {};

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    expect(editor.focus(idFor(editor, 'a'))).toBe(false);
    expect(editor.getSelectedBlocks()).toEqual([idFor(editor, 'c')]);
  });
});

describe('a peer deleting the selected block never selects its twin', () => {
  // R9-RV2-SEL-1, the reviewer's literal cases: a host with stable ids, a
  // block selected beside an identical one, and a peer deleting the selected
  // block. Matched by content, the selection moved onto the twin, and the
  // next Backspace deleted a block nobody chose. A selection carried across
  // `setDocument` is never found by content now (R10-KEY-2).
  for (const [label, type, twinsFirst] of [
    ['todo', 'todo', false],
    ['paragraph', 'paragraph', false],
    ['paragraph, twin above', 'paragraph', true],
    ['divider', 'divider', false],
  ] as const) {
    test(`${label}`, () => {
      const twin = (id: string): Block =>
        block({ id, type, content: type === 'divider' ? [] : [{ text: 'same' }] });
      const editor = mount([
        block({ id: 'a', content: [{ text: 'Alpha' }] }),
        ...(twinsFirst ? [twin('t2'), twin('t1')] : [twin('t1'), twin('t2')]),
        block({ id: 'd', content: [{ text: 'Delta' }] }),
      ]);
      editor.selectBlocks(['t1']);

      editor.setDocument({ blocks: editor.getDocument().blocks.filter((b) => b.id !== 't1') });

      expect(editor.getSelectedBlocks()).toEqual([]);
      press(editor.element, 'Backspace');
      expect(editor.getDocument().blocks.map((b) => b.id)).toContain('t2');
    });
  }

  // The same with nothing else alike: the peer replaced the selected block by
  // an identical one under a new id, every other id kept. Ids are the truth
  // wherever any survives, so the copy is not taken for it.
  test('a block replaced by an identical copy under a new id, other ids kept', () => {
    const editor = mount([
      block({ id: 'a', content: [{ text: 'Alpha' }] }),
      block({ id: 't1', content: [{ text: 'same' }] }),
      block({ id: 'd', content: [{ text: 'Delta' }] }),
    ]);
    editor.selectBlocks(['t1']);

    editor.setDocument({
      blocks: editor.getDocument().blocks.map((b) => (b.id === 't1' ? { ...b, id: 'copy' } : b)),
    });

    expect(editor.getSelectedBlocks()).toEqual([]);
  });
});

describe('a printable key in block mode under a Markdown echo is typed, and focus is let go', () => {
  // R9-RV2-SEL-3, the reviewer's literal cases (p06): a Markdown echo, the
  // paragraph the character lands in beside a one-character twin, and an
  // empty paragraph above that the echo drops. The caret went to the end of
  // the *old* "q", and the next key was typed into it. Rounds 9 and 10 looked
  // for the new paragraph by content; R11-KEY-4 found that search could take
  // an old twin out of its window, so no block is looked for: the character
  // is in the document, and the root lets go of focus.
  for (const [label, blocks, after] of [
    ['twin after, shifted', ['Notes', '', 'Beta', 'q'], ['Notes', 'q', 'q']],
    ['twin before, shifted', ['Notes', '', 'q', 'Beta', 'Zed'], ['Notes', 'q', 'q', 'Zed']],
    ['twin before, not shifted', ['Notes', 'q', 'Beta', 'Zed'], ['Notes', 'q', 'q', 'Zed']],
  ] as const) {
    test(`no caret in either "q": ${label}`, () => {
      const editor = mount(
        blocks.map((text, i) =>
          block({ id: text === 'Beta' ? 'B' : `p${i}`, content: text ? [{ text }] : [] }),
        ),
      );
      editor.on('change', () => {
        editor.setDocument(
          { blocks: blocksFromMarkdown(toMarkdown(editor.getDocument())) },
          { silent: true },
        );
      });
      editor.selectBlocks(['B']);

      press(editor.element, 'q');

      expect(texts(editor)).toEqual(after);
      expect(editor.getSelectionState()).toBeNull();
      expect(editor.getSelectedBlocks()).toEqual([]);
      expect(document.activeElement).toBe(document.body);
    });
  }

  // R9-RV-SEL-4, p08's literal case: a host that writes every change out as
  // Markdown and loads it straight back (every id new), [Beta, Gamma] selected,
  // and "x" typed. The paragraph holding "x" was renamed under the editor, the
  // focus aimed at its old id failed, and the editor was in neither mode: the
  // root kept focus and the next key was lost. Neither mode is still never
  // the answer; the root lets go, so the next key goes to the page.
  test('the character is typed, and the root lets go rather than holding neither mode', () => {
    const editor = mount([
      block({ id: 'a', content: [{ text: 'Alpha' }] }),
      block({ id: 'b2', content: [{ text: 'Beta' }] }),
      block({ id: 'c', content: [{ text: 'Gamma' }] }),
      block({ id: 'd', content: [{ text: 'Delta' }] }),
    ]);
    editor.on('change', () => {
      editor.setDocument(
        { blocks: blocksFromMarkdown(toMarkdown(editor.getDocument())) },
        { silent: true },
      );
    });
    editor.selectBlocks(['b2', 'c']);

    press(editor.element, 'x');

    expect(texts(editor)).toEqual(['Alpha', 'x', 'Delta']);
    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(editor.getSelectionState()).toBeNull();
    expect(editor.element.contains(document.activeElement)).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });
});

describe('a caret handed back to the end of a table goes to its last cell', () => {
  // R9-KEY-6, p14's literal case: a table, then the selected paragraph at the
  // end of the document, deleted by a peer. "The end of the block before" was
  // `focus(table, end)`, which resolves a table to its first cell: the caret
  // sat after "h1", and the next character went into the header.
  const tableThenPara = (): Block[] => [
    block({ id: 'a', content: [{ text: 'A' }] }),
    block({
      id: 't',
      type: 'table',
      rows: [
        [[{ text: 'h1' }], [{ text: 'h2' }]],
        [[{ text: 'c1' }], [{ text: 'c2' }]],
      ],
    }),
    block({ id: 'p', content: [{ text: 'Para' }] }),
  ];

  // `setDocument` no longer hands the caret to a neighbour at all
  // (R12-KEY-4): the table before a selection a peer deleted gets no caret.
  test('a peer deleting the block after it: no caret in the table', () => {
    const editor = mount(tableThenPara());
    editor.selectBlocks(['p']);

    editor.setDocument({ blocks: editor.getDocument().blocks.filter((b) => b.id !== 'p') });

    expect(editor.getSelectionState()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  // Siblings through the same helper: the landing after a block delete, and
  // Enter on a selected table (the end of the selection's last block).
  test('deleting the block after it', () => {
    const editor = mount(tableThenPara());
    editor.selectBlocks(['p']);

    press(editor.element, 'Backspace');

    expect(editor.getDocument().blocks.map((b) => b.id)).toEqual(['a', 't']);
    expect(editor.getSelectionState()).toMatchObject({
      blockId: 't',
      cell: { row: 1, column: 1 },
      range: { start: 2, end: 2 },
    });
  });

  test('Enter on the selected table', () => {
    const editor = mount(tableThenPara());
    editor.selectBlocks(['t']);

    press(editor.element, 'Enter');

    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(editor.getSelectionState()).toMatchObject({
      blockId: 't',
      cell: { row: 1, column: 1 },
      range: { start: 2, end: 2 },
    });
  });

  test('nor the block before it', () => {
    const editor = mount(tableThenPara());
    editor.selectBlocks(['a']);

    editor.setDocument({ blocks: editor.getDocument().blocks.filter((b) => b.id !== 'a') });

    expect(editor.getSelectionState()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});

describe('focus and focusRange report a host that did not take focus', () => {
  // R9-KEY-7. A read-only host is not focusable and everything outside an
  // open modal dialog is inert; both answered `true` with focus on `<body>`.
  // happy-dom focuses anything, so the refusal is simulated on the one host;
  // read-only.spec.ts pins the real one.
  function refuseFocus(host: HTMLElement): void {
    host.focus = () => {};
  }

  test('false, and nothing else changes', () => {
    const editor = mount(abc());
    editor.selectBlocks([idFor(editor, 'a')]);
    refuseFocus(hosts(editor)[1]!);

    expect(editor.focus(idFor(editor, 'b'))).toBe(false);
    expect(editor.focusRange(idFor(editor, 'b'), 0, 1)).toBe(false);

    // Still in block mode, on the root, with no caret dropped in "b".
    expect(editor.getSelectedBlocks()).toEqual([idFor(editor, 'a')]);
    expect(document.activeElement).toBe(editor.element);
    expect(editor.getSelectionState()).toBeNull();
  });

  test('a host that takes focus still answers true', () => {
    const editor = mount(abc());
    editor.selectBlocks([idFor(editor, 'a')]);

    expect(editor.focus(idFor(editor, 'b'), 1)).toBe(true);
    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(document.activeElement).toBe(hosts(editor)[1]);
  });

  test('Enter on a selection whose last block refuses focus moves on to one that takes it', () => {
    const editor = mount(abc());
    editor.selectBlocks([idFor(editor, 'b'), idFor(editor, 'c')]);
    refuseFocus(hosts(editor)[2]!);

    press(editor.element, 'Enter');

    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(document.activeElement).toBe(hosts(editor)[1]);
  });
});

/**
 * A read-only view's own pointer gesture across its blocks, made the way
 * the browser makes it: a press in the editor, the browser's range across
 * the blocks while the button is down (its `selectionchange` is not read
 * then), and the release, which reads the range as the gesture's
 * (`#handlePointerUp`). The gestures themselves are pinned in
 * read-only.spec.ts; the rules the release applies are engine-free.
 */
function releaseRange(
  editor: NEditor,
  pressOn: Element,
  [anchor, anchorOffset, focus, focusOffset]: [Node, number, Node, number],
): void {
  const pointer = { bubbles: true, composed: true, button: 0, pointerType: 'mouse' };
  pressOn.dispatchEvent(new PointerEvent('pointerdown', pointer));
  getSelection()!.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
  expect(editor.getSelectedBlocks(), 'nothing promoted while the button is down').toEqual([]);
  pressOn.dispatchEvent(new PointerEvent('pointerup', pointer));
}

/** A range the browser's own Shift+arrow, or an embedder, makes: no button down. */
function rangeByKey(anchor: Node, anchorOffset: number, focus: Node, focusOffset: number): void {
  getSelection()!.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
  document.dispatchEvent(new Event('selectionchange'));
}

const contentOf = (editor: NEditor, id: string): HTMLElement =>
  editor.element.querySelector<HTMLElement>(`[data-block-id="${id}"] .neditor-block__content`)!;

function copyText(editor: NEditor): string {
  const copy = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
  const written = new Map<string, string>();
  Object.defineProperty(copy, 'clipboardData', {
    value: { setData: (type: string, data: string) => written.set(type, data) },
  });
  editor.element.dispatchEvent(copy);

  return written.get('text/plain') ?? '';
}

describe('a range across blocks reaching a table only at the start of its text', () => {
  /**
   * R14-RV5-4's audit of the test above the one-block branch. At a
   * pointer's release a block the range reaches only at the start of its
   * text is not in it; a table's text starts in its first cell, but the
   * table has text when any cell does. Asked of the first cell alone, a
   * table whose first cell is empty counted as a block with no text, which
   * stays when the press was not on it -- "b" and the table were selected
   * for a range holding none of the table's characters.
   */
  test('a table whose first cell is empty is left out, and the range is the paragraph’s own', () => {
    const editor = mount(
      [
        block({ id: 'b', content: [{ text: 'Block B' }] }),
        block({
          id: 'c',
          type: 'table',
          rows: [
            [[], [{ text: 'y1' }]],
            [[{ text: 'x2' }], [{ text: 'y2' }]],
          ],
        }),
      ],
      { editable: false },
    );
    const paragraph = contentOf(editor, 'b');
    const second = editor.element.querySelector('[data-cell="0:1"]')!;
    releaseRange(editor, paragraph, [paragraph.firstChild!, 2, second.firstChild!, 0]);

    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(editor.getSelectionState()).toMatchObject({ blockId: 'b', range: { start: 2, end: 7 } });
  });
});

describe('a range across blocks left with one block', () => {
  /**
   * R14-RV6-2. A range that starts in a table cell and ends at the start of
   * the next block's text holds one block, the table -- but not one host:
   * written into the cell it starts in up to that cell's end, a range from
   * "H2" over every other cell was cut to "2" (a read-only Shift+click
   * beside the next block, in three engines; Mod+C copied "2"). Such a
   * range is the table's, selected as a block; only a range that holds
   * nothing after its start cell -- the last cell, or cells after it with
   * no text -- is that cell's own text range. The gestures are pinned in
   * read-only.spec.ts (RO6q3).
   */
  const table = (rows: string[][]) =>
    mount(
      [
        block({ id: 'before', content: [{ text: 'Before the table' }] }),
        block({
          id: 'tbl',
          type: 'table',
          rows: rows.map((row) => row.map((text) => (text ? [{ text }] : []))),
        }),
        block({ id: 'after', content: [{ text: 'After the table' }] }),
      ],
      { editable: false },
    );
  const releaseToAfter = (editor: NEditor, cell: string, offset: number) => {
    const from = editor.element.querySelector(`[data-cell="${cell}"]`)!;
    releaseRange(editor, from, [
      from.firstChild!,
      offset,
      contentOf(editor, 'after').firstChild!,
      0,
    ]);
  };
  const rows = [
    ['H1', 'H2', 'H3'],
    ['a1', 'a2', 'a3'],
    ['b1', 'b2', 'b3'],
  ];

  test('from a cell over the cells after it, the range is the table’s', () => {
    for (const cell of ['0:1', '1:1']) {
      const editor = table(rows);
      releaseToAfter(editor, cell, 1);

      expect(editor.getSelectedBlocks()).toEqual(['tbl']);
      expect(editor.getSelectionState()).toBeNull();
      editor.destroy();
    }
  });

  test('from the last cell, or from a cell whose cells after it hold no text, it is that cell’s', () => {
    let editor = table(rows);
    releaseToAfter(editor, '2:2', 1);

    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(editor.getSelectionState()).toMatchObject({
      blockId: 'tbl',
      cell: { row: 2, column: 2 },
      range: { start: 1, end: 2 },
    });
    editor.destroy();

    editor = table([
      ['H1', 'H2', ''],
      ['', '', ''],
    ]);
    releaseToAfter(editor, '0:1', 1);

    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(editor.getSelectionState()).toMatchObject({
      blockId: 'tbl',
      cell: { row: 0, column: 1 },
      range: { start: 1, end: 2 },
    });
  });

  /**
   * R14-RV7-1's pointer half. A click at the end of b's text and a
   * Shift+click beside c make a range from b's end to c's start, holding
   * no character of either: c left out and the range written into b, it
   * selected nothing. A block is left out only where something of the
   * block left is selected; otherwise the blocks are selected, as round 13
   * did. The same from the end of a table's last cell.
   */
  test('a range left with nothing of its block selected selects the blocks it reaches', () => {
    const editor = mount(
      [
        block({ id: 'b', content: [{ text: 'Block B' }] }),
        block({ id: 'c', content: [{ text: 'Block C' }] }),
      ],
      { editable: false },
    );
    const b = contentOf(editor, 'b');
    releaseRange(editor, contentOf(editor, 'c'), [
      b.firstChild!,
      7,
      contentOf(editor, 'c').firstChild!,
      0,
    ]);

    expect(editor.getSelectedBlocks()).toEqual(['b', 'c']);
    editor.destroy();

    const grid = table(rows);
    const last = grid.element.querySelector('[data-cell="2:2"]')!;
    releaseRange(grid, contentOf(grid, 'after'), [
      last.firstChild!,
      2,
      contentOf(grid, 'after').firstChild!,
      0,
    ]);

    expect(grid.getSelectedBlocks()).toEqual(['tbl', 'after']);
  });

  /**
   * R14-RV7-2. A range that starts in a table but in no cell -- below the
   * grid, where a click in the table block's own band leaves the browser's
   * caret after the grid -- was read as starting in the first cell, and a
   * Shift+click beside the next block wrote a range over "H1": Mod+C
   * copied "H1" (Chromium and WebKit). It starts beside the last cell that
   * ends before it, from that cell's end, which holds nothing of the
   * table, so the blocks are selected. Before the grid it starts at the
   * first cell, and the range over the cells is the table's.
   */
  test('a range that starts in a table but in no cell starts beside one', () => {
    let editor = table(rows);
    let wrapper = editor.element.querySelector('[data-block-id="tbl"] .neditor-table')!;
    let after = contentOf(editor, 'after');
    releaseRange(editor, after, [wrapper, wrapper.childNodes.length, after.firstChild!, 0]);

    expect(editor.getSelectedBlocks()).toEqual(['tbl', 'after']);
    expect(editor.getSelectionState()).toBeNull();
    editor.destroy();

    editor = table(rows);
    wrapper = editor.element.querySelector('[data-block-id="tbl"] .neditor-table')!;
    after = contentOf(editor, 'after');
    releaseRange(editor, after, [wrapper, 0, after.firstChild!, 0]);

    expect(editor.getSelectedBlocks()).toEqual(['tbl']);
  });

  /**
   * R14-RV6-1. A collapsed toggle's children are in the document, not on
   * screen, and a range read across blocks counted them: from the toggle's
   * text to the start of the next block's it held [toggle, hidden child,
   * next], the next was left out, and two ids were left -- so the toggle
   * was selected as a block (Chromium's and WebKit's read-only
   * triple-click; Mod+C copied the toggle with what it hides) where an open
   * toggle's text was selected. Selection anchors live in visible space:
   * the range is read over the blocks on screen, and a block selection that
   * does take the toggle in still carries its children at the edit
   * (`#selectionForEdit`).
   */
  test('a collapsed toggle’s hidden children do not make its text a block selection', () => {
    for (const hidden of ['hidden kid', '']) {
      const editor = mount(
        [
          block({ id: 'a', content: [{ text: 'Block A' }] }),
          block({ id: 'b', type: 'toggle', collapsed: true, content: [{ text: 'Block B' }] }),
          block({
            id: 'k',
            depth: 1,
            ...(hidden ? { content: [{ text: hidden }] } : { type: 'divider' }),
          }),
          block({ id: 'c', content: [{ text: 'Block C' }] }),
        ],
        { editable: false },
      );
      const content = (id: string) => contentOf(editor, id);
      releaseRange(editor, content('b'), [
        content('b').firstChild!,
        2,
        content('c').firstChild!,
        0,
      ]);

      expect(editor.getSelectedBlocks()).toEqual([]);
      expect(editor.getSelectionState()).toMatchObject({
        blockId: 'b',
        range: { start: 2, end: 7 },
      });

      // The toggle taken in as a block: its child goes with it.
      releaseRange(editor, content('a'), [
        content('a').firstChild!,
        2,
        content('c').firstChild!,
        0,
      ]);

      expect(editor.getSelectedBlocks()).toEqual(['a', 'b']);
      const markdown = copyText(editor);

      expect(markdown).toContain('Block B');
      expect(markdown).toContain(hidden || '---');
      editor.destroy();
    }
  });

  /**
   * R14-RV6-1 with a toggle the reader closed (review 7). `#readerExpanded`
   * hides the children as surely as the document's own `collapsed`, and
   * the range is read over what the reader is shown: read over the
   * document's own idea of what is hidden, the child was counted and the
   * toggle selected as a block.
   */
  test('a toggle the reader closed: its text range stays text', () => {
    const editor = mount(
      [
        block({ id: 'a', content: [{ text: 'Block A' }] }),
        block({ id: 'b', type: 'toggle', collapsed: false, content: [{ text: 'Block B' }] }),
        block({ id: 'k', depth: 1, content: [{ text: 'kid' }] }),
        block({ id: 'c', content: [{ text: 'Block C' }] }),
      ],
      { editable: false },
    );
    editor.toggleCollapsed('b');
    expect(editor.element.querySelector('[data-block-id="k"]')).toBeNull();
    const content = (id: string) => contentOf(editor, id);
    releaseRange(editor, content('b'), [content('b').firstChild!, 2, content('c').firstChild!, 0]);

    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(editor.getSelectionState()).toMatchObject({ blockId: 'b', range: { start: 2, end: 7 } });
  });

  /**
   * R14-RV5-3's other half. A block with no text reached at the start of
   * the range is left out at a release only where the gesture was not
   * pressed on it; with a press in b, the triple-click's case, it is left
   * out.
   */
  test('a block with no text at the end of a released range is out unless pressed on', () => {
    for (const type of ['divider', 'paragraph'] as const) {
      for (const pressed of ['b', 'c'] as const) {
        const editor = mount(
          [
            block({ id: 'a', content: [{ text: 'Block A' }] }),
            block({ id: 'b', content: [{ text: 'Block B' }] }),
            block({ id: 'c', type }),
          ],
          { editable: false },
        );
        const b = contentOf(editor, 'b');
        const c = editor.element.querySelector('[data-block-id="c"]')!;
        releaseRange(editor, pressed === 'b' ? b : c, [b.firstChild!, 2, c, c.childNodes.length]);

        expect(editor.getSelectedBlocks(), `${type}, pressed on ${pressed}`).toEqual(
          pressed === 'b' ? [] : ['b', 'c'],
        );
        expect(editor.getSelectionState()?.range ?? null, `${type}, pressed on ${pressed}`).toEqual(
          pressed === 'b' ? { start: 2, end: 7 } : null,
        );
        editor.destroy();
      }
    }
  });
});

describe('a released range no press in a block names', () => {
  /**
   * A release with no block pressed -- a touch, which arms no text drag, or
   * a press below the last block -- passes no `pressed` (read-only.spec.ts
   * RO6q5 drives the press below the last block). A block with no text
   * the range reaches stays in it, and a table with text reached only at
   * the start of its first cell, empty, is left out: it has text, so the
   * press is not asked.
   */
  const touchRelease = (anchor: Node, anchorOffset: number, focus: Node, focusOffset: number) => {
    const pointer = { bubbles: true, composed: true, button: 0, pointerType: 'touch' };
    const host = (anchor.nodeType === 1 ? anchor : anchor.parentNode) as Element;
    host.dispatchEvent(new PointerEvent('pointerdown', pointer));
    getSelection()!.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
    host.dispatchEvent(new PointerEvent('pointerup', pointer));
  };

  test('a last block with no text stays in it', () => {
    const editor = mount(
      [block({ id: 'b', content: [{ text: 'Block B' }] }), block({ id: 'c', type: 'divider' })],
      { editable: false },
    );
    const c = editor.element.querySelector('[data-block-id="c"]')!;
    touchRelease(contentOf(editor, 'b').firstChild!, 2, c, c.childNodes.length);

    expect(editor.getSelectedBlocks()).toEqual(['b', 'c']);
  });

  test('a table with text reached at its empty first cell’s start is left out', () => {
    const editor = mount(
      [
        block({ id: 'b', content: [{ text: 'Block B' }] }),
        block({
          id: 'c',
          type: 'table',
          rows: [
            [[], [{ text: 'y1' }]],
            [[{ text: 'x2' }], [{ text: 'y2' }]],
          ],
        }),
      ],
      { editable: false },
    );
    const first = editor.element.querySelector('[data-cell="0:0"]')!;
    touchRelease(contentOf(editor, 'b').firstChild!, 2, first, 0);

    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(editor.getSelectionState()).toMatchObject({ blockId: 'b', range: { start: 2, end: 7 } });
  });
});

describe('a range across blocks no pointer made', () => {
  /**
   * R14-RV7-1. Only a pointer's release leaves a block out. A range a key
   * made -- the browser's own read-only Shift+arrow, read at its
   * `selectionchange` -- or one an embedder built through the API selects
   * every block it reaches, as round 13 did: Shift+→ from a word
   * double-clicked at the end of b runs the range to c's start, and with c
   * left out the key never crossed the edge (b[6,7] after four presses, in
   * every engine); Firefox's Shift+← from c's start dropped c, the block
   * the range began in. The keys are pinned in read-only.spec.ts.
   */
  test('a range to the start of the next block’s text selects both blocks', () => {
    const editor = mount(
      [
        block({ id: 'b', content: [{ text: 'Block B' }] }),
        block({ id: 'c', content: [{ text: 'Block C' }] }),
      ],
      { editable: false },
    );
    const b = contentOf(editor, 'b').firstChild!;
    const c = contentOf(editor, 'c').firstChild!;
    rangeByKey(b, 6, c, 0);

    expect(editor.getSelectedBlocks()).toEqual(['b', 'c']);

    editor.selectBlocks([]);
    rangeByKey(c, 0, b, 7);

    expect(editor.getSelectedBlocks()).toEqual(['b', 'c']);
  });

  test('a range from a cell to the start of the next block selects the table and the block', () => {
    const editor = mount(
      [
        block({
          id: 'tbl',
          type: 'table',
          rows: [
            [[{ text: 'H1' }], [{ text: 'H2' }]],
            [[{ text: 'b1' }], [{ text: 'b2' }]],
          ],
        }),
        block({ id: 'after', content: [{ text: 'After the table' }] }),
      ],
      { editable: false },
    );
    const last = editor.element.querySelector('[data-cell="1:1"]')!.firstChild!;
    rangeByKey(last, 1, contentOf(editor, 'after').firstChild!, 0);

    expect(editor.getSelectedBlocks()).toEqual(['tbl', 'after']);
  });

  /**
   * A block with no text at the end of a range no gesture made stays in it:
   * Firefox's read-only Shift+↓ onto a divider (RO6q).
   */
  test('a block with no text at the end of a range no gesture made stays in it', () => {
    for (const type of ['divider', 'paragraph'] as const) {
      const editor = mount(
        [
          block({ id: 'a', content: [{ text: 'Block A' }] }),
          block({ id: 'b', content: [{ text: 'Block B' }] }),
          block({ id: 'c', type }),
        ],
        { editable: false },
      );
      const b = contentOf(editor, 'b');
      const c = editor.element.querySelector('[data-block-id="c"]')!;
      rangeByKey(b.firstChild!, 2, c, c.childNodes.length);

      expect(editor.getSelectedBlocks()).toEqual(['b', 'c']);
      editor.destroy();
    }
  });
});

describe('a toggle the reader closed, taken in as a block', () => {
  /**
   * R14-RV7-3. A read-only reader's chevron hides a toggle's children as
   * surely as the document's own `collapsed`, and a block selection that
   * takes the toggle in carries them (`#selectionForEdit`): expanded by the
   * document alone, Mod+C copied "Block A" and an open toggle with no
   * children. The copy writes the document, so the toggle is written open,
   * as the document has it, with its children under it.
   */
  test('copies the children it hides', () => {
    const editor = mount(
      [
        block({ id: 'a', content: [{ text: 'Block A' }] }),
        block({ id: 'b', type: 'toggle', collapsed: false, content: [{ text: 'Block B' }] }),
        block({ id: 'k1', depth: 1, content: [{ text: 'kid one' }] }),
        block({ id: 'k2', depth: 1, content: [{ text: 'kid two' }] }),
        block({ id: 'c', content: [{ text: 'Block C' }] }),
      ],
      { editable: false },
    );
    editor.toggleCollapsed('b');
    expect(editor.element.querySelector('[data-block-id="k1"]')).toBeNull();
    editor.selectBlocks(['a', 'b']);
    expect(editor.getSelectedBlocks()).toEqual(['a', 'b']);

    const copied = blocksFromMarkdown(copyText(editor));
    expect(copied.map(blockText)).toEqual(['Block A', 'Block B', 'kid one', 'kid two']);
    expect(copied.map((b) => b.depth)).toEqual([0, 0, 1, 1]);
    expect(copied[1]).toMatchObject({ type: 'toggle' });
    expect(copied[1]!.collapsed ?? false).toBe(false);
  });
});

describe('the release of a press the page made, with blocks selected', () => {
  /**
   * R14-RV4-1's gate. At the release of a read-only press in this editor
   * that finds blocks selected, the browser's range across them is let go
   * of. A press in the page's own text is not this editor's, and its range
   * is the reader's: dropped, Mod+C copied nothing. In a browser a range
   * begun outside the editor now ends the block selection at its own
   * `selectionchange` (R14-RV5-5), before any release -- so the gate is
   * pinned here, where the release can be made to come first: the
   * `selectionchange` between the range and the release is held back.
   */
  test('leaves the range the reader drew from the page into the blocks', () => {
    const editor = mount(
      [
        block({ id: 'a', content: [{ text: 'Block A' }] }),
        block({ id: 'b', content: [{ text: 'Block B' }] }),
        block({ id: 'c', content: [{ text: 'Block C' }] }),
      ],
      { editable: false },
    );
    const page = document.createElement('p');
    page.textContent = 'Some text of the page.';
    document.body.prepend(page);
    editor.selectBlocks(['a', 'b']);
    expect(editor.getSelectedBlocks()).toEqual(['a', 'b']);

    page.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    const c = editor.element.querySelector('[data-block-id="c"] .neditor-block__content')!;
    // happy-dom fires `selectionchange` as the selection is set; held back,
    // the release comes first.
    const holdBack = (event: Event) => event.stopImmediatePropagation();
    window.addEventListener('selectionchange', holdBack, true);
    getSelection()!.setBaseAndExtent(page.firstChild!, 2, c.firstChild!, 3);
    window.removeEventListener('selectionchange', holdBack, true);
    expect(editor.getSelectedBlocks()).toEqual(['a', 'b']);
    page.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true }));

    expect(getSelection()!.isCollapsed).toBe(false);
    expect(getSelection()!.anchorNode).toBe(page.firstChild);
  });
});
