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
