// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';

import type { Block } from './index.ts';
import { blockText, createEditor } from './index.ts';
import type { NEditor } from './editor.ts';

/**
 * The state an editor keeps *outside* the document: the selection anchor, the
 * platform's shortcut modifier, the attributes it writes onto the element it
 * was handed, and the depth invariant a merge has to leave behind.
 *
 * None of it is content, which is why none of it was covered: every one of
 * these defects survived a suite that only ever asked what the blocks said.
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

function mountOn(element: HTMLElement, options: Record<string, unknown> = {}): NEditor {
  const editor = createEditor({ element, ...options });
  editors.push(editor);

  return editor;
}

function mount(blocks: Block[], options: Record<string, unknown> = {}): NEditor {
  const element = document.createElement('div');
  document.body.append(element);

  return mountOn(element, { doc: { blocks }, ...options });
}

const hosts = (editor: NEditor): HTMLElement[] => [
  ...editor.element.querySelectorAll<HTMLElement>('.neditor-block__content'),
];

const texts = (editor: NEditor): string[] => editor.getDocument().blocks.map(blockText);

const depths = (editor: NEditor): number[] => editor.getDocument().blocks.map((b) => b.depth);

const live = (editor: NEditor): string | null | undefined =>
  editor.element.querySelector('.neditor-live-region')?.textContent;

const idFor = (editor: NEditor, text: string): string =>
  editor.getDocument().blocks.find((b) => blockText(b) === text)!.id;

function caretTo(host: HTMLElement, offset: 0 | 'end'): void {
  host.focus();
  const range = document.createRange();
  range.selectNodeContents(host);
  range.collapse(offset === 0);

  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);

  return event.defaultPrevented;
}

/** Hovers a block so the gutter points at it, then clicks its handle. */
function clickHandle(editor: NEditor, index: number, init: MouseEventInit = {}): void {
  const target = editor.element.querySelectorAll('.neditor-block')[index]!;
  target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerId: 3 }));
  editor.element
    .querySelector('.neditor-gutter__handle')!
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
}

function touch(type: string, target: EventTarget, init: PointerEventInit = {}): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerType: 'touch',
      pointerId: 4,
      ...init,
    }),
  );
}

/**
 * Runs `body` with the mount's window reporting another platform.
 *
 * `navigator.platform` is what the editor reads to decide whether Ctrl belongs
 * to it or to the system, and it is read once, when the editor is constructed —
 * so the swap has to be in place before the mount.
 */
function onPlatform(platform: string, body: () => void): void {
  const original = Object.getOwnPropertyDescriptor(navigator, 'platform');
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });

  try {
    body();
  } finally {
    if (original) {
      Object.defineProperty(navigator, 'platform', original);
    } else {
      delete (navigator as unknown as Record<string, unknown>).platform;
    }
  }
}

const nested = (): Block[] => [
  block({ content: [{ text: 'parent' }] }),
  block({ depth: 1, content: [{ text: 'child' }] }),
  block({ depth: 2, content: [{ text: 'grandchild' }] }),
];

describe('the selection anchor is pruned with the selection', () => {
  test('Shift+click after deleting the selection selects, rather than doing nothing', () => {
    const editor = mount([
      block({ content: [{ text: 'a' }] }),
      block({ content: [{ text: 'b' }] }),
      block({ content: [{ text: 'c' }] }),
      block({ content: [{ text: 'd' }] }),
    ]);

    editor.selectBlocks([idFor(editor, 'b'), idFor(editor, 'c')]);
    press(editor.element, 'Backspace');

    expect(texts(editor)).toEqual(['a', 'd']);

    // The anchor pointed at `b`, which no longer exists: `blockIdRange` answers
    // [] for a dead id, and the empty range then read as "deselect everything"
    // — so this gesture selected nothing at all and the next keystroke fell on
    // the floor.
    clickHandle(editor, 1, { shiftKey: true });

    expect(editor.getSelectedBlocks()).toEqual([idFor(editor, 'd')]);
  });

  test('a plain click still selects after the same deletion', () => {
    // The other half of the pair: proves the gesture above really reached the
    // shift branch rather than being swallowed somewhere earlier.
    const editor = mount([
      block({ content: [{ text: 'a' }] }),
      block({ content: [{ text: 'b' }] }),
    ]);

    editor.selectBlocks([idFor(editor, 'b')]);
    press(editor.element, 'Backspace');
    clickHandle(editor, 0);

    expect(editor.getSelectedBlocks()).toEqual([idFor(editor, 'a')]);
  });
});

describe('#pruneBlockSelection holds the selection to the visible document', () => {
  test('collapsing a toggle drops the blocks it hides from the selection', () => {
    const editor = mount([
      block({ type: 'toggle', content: [{ text: 'toggle' }] }),
      block({ depth: 1, content: [{ text: 'inside' }] }),
      block({ content: [{ text: 'after' }] }),
    ]);

    const seen: string[][] = [];
    editor.on('blockselection', ({ ids }) => {
      seen.push(ids);
    });

    editor.selectBlocks([idFor(editor, 'inside'), idFor(editor, 'after')]);
    editor.toggleCollapsed(idFor(editor, 'toggle'));

    // A selection may only ever hold blocks the reader can see, and the host
    // has to be told the moment that stops being true — otherwise it is still
    // holding an id for a block that is no longer on screen, and the next edit
    // it makes from that list moves something invisible.
    expect(seen.slice(0, 2)).toEqual([
      [idFor(editor, 'inside'), idFor(editor, 'after')],
      [idFor(editor, 'after')],
    ]);
  });
});

describe('a merge re-clamps the depths it disturbs', () => {
  test('Delete at the end pulls the orphaned grandchild back one level', () => {
    const editor = mount(nested());

    caretTo(hosts(editor)[0]!, 'end');
    press(hosts(editor)[0]!, 'Delete');

    // `child` was the only bridge between depth 0 and depth 2. Removing it with
    // a bare filter left `grandchild` two levels below its predecessor, which
    // is the one thing the flat model promises never to hold.
    expect(texts(editor)).toEqual(['parentchild', 'grandchild']);
    expect(depths(editor)).toEqual([0, 1]);
  });

  test('Backspace at the start outdents instead, so it cannot open the same gap', () => {
    // The mirror image of the case above, and the reason only `#deleteAtEnd`
    // needed the clamp: Backspace never merges a nested block, it outdents it,
    // so the block it eventually removes is always at depth 0.
    const editor = mount(nested());

    caretTo(hosts(editor)[1]!, 0);
    press(hosts(editor)[1]!, 'Backspace');

    expect(texts(editor)).toEqual(['parent', 'child', 'grandchild']);
    expect(depths(editor)).toEqual([0, 0, 1]);
  });

  test('Delete over a divider that bridged two levels re-clamps too', () => {
    const editor = mount([
      block({ content: [{ text: 'parent' }] }),
      block({ type: 'divider', depth: 1 }),
      block({ depth: 2, content: [{ text: 'grandchild' }] }),
    ]);

    caretTo(hosts(editor)[0]!, 'end');
    press(hosts(editor)[0]!, 'Delete');

    expect(texts(editor)).toEqual(['parent', 'grandchild']);
    expect(depths(editor)).toEqual([0, 1]);
  });
});

describe('Ctrl belongs to the system on macOS', () => {
  const marksOf = (editor: NEditor, id: string): readonly string[] =>
    editor.getDocument().blocks.find((b) => b.id === id)?.content[0]?.marks ?? [];

  test('Ctrl+B is left alone, so the caret binding still works', () => {
    onPlatform('MacIntel', () => {
      const editor = mount([block({ id: 'a', content: [{ text: 'word' }] })]);
      editor.focusRange('a', 0, 4);

      // Ctrl+B is "back one character" in every native macOS text field, along
      // with Ctrl+E, Ctrl+A and Ctrl+K. Answering it with bold both loses the
      // binding and applies formatting the user never asked for.
      expect(press(hosts(editor)[0]!, 'b', { ctrlKey: true })).toBe(false);
      expect(marksOf(editor, 'a')).toEqual([]);
    });
  });

  test('Cmd+B still bolds there', () => {
    onPlatform('MacIntel', () => {
      const editor = mount([block({ id: 'a', content: [{ text: 'word' }] })]);
      editor.focusRange('a', 0, 4);

      expect(press(hosts(editor)[0]!, 'b', { metaKey: true })).toBe(true);
      expect(marksOf(editor, 'a')).toEqual(['bold']);
    });
  });

  test('Ctrl+B still bolds everywhere else', () => {
    onPlatform('Win32', () => {
      const editor = mount([block({ id: 'a', content: [{ text: 'word' }] })]);
      editor.focusRange('a', 0, 4);

      expect(press(hosts(editor)[0]!, 'b', { ctrlKey: true })).toBe(true);
      expect(marksOf(editor, 'a')).toEqual(['bold']);
    });
  });

  test('Ctrl+A on macOS reaches the caret rather than selecting every block', () => {
    onPlatform('MacIntel', () => {
      const editor = mount([
        block({ id: 'a', content: [{ text: 'one' }] }),
        block({ content: [{ text: 'two' }] }),
      ]);

      // The whole block is already selected, which is exactly the state where
      // Cmd+A escalates to selecting every block. Ctrl+A is the system's "start
      // of line" and must not escalate anything.
      editor.focusRange('a', 0, 3);
      press(hosts(editor)[0]!, 'a', { ctrlKey: true });

      expect(editor.getSelectedBlocks()).toEqual([]);
    });
  });
});

describe('touch offers the gutter on the same terms hover does', () => {
  const gutter = (editor: NEditor): HTMLElement | null =>
    editor.element.querySelector('.neditor-gutter');

  test('a read-only editor does not reveal the add and drag controls', () => {
    const editor = mount([block({ content: [{ text: 'a' }] })], { editable: false });

    touch('pointerdown', hosts(editor)[0]!, { clientX: 10, clientY: 10 });

    // Hover stands down for `editable: false`; a finger is not a second way in
    // to controls that edit a document the reader is not allowed to edit.
    expect(gutter(editor)?.dataset.visible).toBe('false');
  });

  test('an editable one still does', () => {
    const editor = mount([block({ content: [{ text: 'a' }] })]);

    touch('pointerdown', hosts(editor)[0]!, { clientX: 10, clientY: 10 });

    expect(gutter(editor)?.dataset.visible).toBe('true');
  });
});

describe('a long press cannot select a block the document no longer holds', () => {
  test('a document swap during the press produces no phantom selection', async () => {
    const editor = mount([block({ content: [{ text: 'a' }] })]);

    const seen: string[][] = [];
    editor.on('blockselection', ({ ids }) => {
      seen.push(ids);
    });

    touch('pointerdown', hosts(editor)[0]!, { clientX: 10, clientY: 10 });
    editor.setDocument({ blocks: [block({ content: [{ text: 'b' }] })] });
    await new Promise((resolve) => setTimeout(resolve, 600));

    // The press was armed against a block that is gone by the time the timer
    // fires. `#setBlockSelection` holds every id up against the visible
    // document, which is what keeps a dead one out of the set — and out of an
    // event whose ids the getter would then contradict.
    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe('destroy() gives the element back the way it found it', () => {
  test('a text drag in flight does not leave the blocks unselectable', () => {
    const element = document.createElement('div');
    document.body.append(element);

    const editor = mountOn(element, {
      doc: {
        blocks: [
          block({ content: [{ text: 'a' }] }),
          block({ content: [{ text: 'b' }] }),
          block({ content: [{ text: 'c' }] }),
        ],
      },
    });

    hosts(editor)[0]!.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 5, clientY: 0 }),
    );
    document.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerId: 5, clientY: 400 }),
    );

    expect(element.dataset.selecting).toBe('true');

    // No pointerup: the editor is torn down mid-gesture, which is exactly what
    // a route change does. `data-selecting` carries `user-select: none` for
    // every block, so leaving it behind hands the next mount an element whose
    // text cannot be selected and no gesture left to end it.
    editor.destroy();

    expect(element.dataset.selecting).toBeUndefined();

    const remounted = mountOn(element, { doc: { blocks: [block({ content: [{ text: 'a' }] })] } });

    expect(remounted.element.dataset.selecting).toBeUndefined();
  });

  test('a block drag in flight does not leave the drag styling on', () => {
    const element = document.createElement('div');
    document.body.append(element);

    const editor = mountOn(element, {
      doc: {
        blocks: [block({ content: [{ text: 'a' }] }), block({ content: [{ text: 'b' }] })],
      },
    });

    editor.element
      .querySelector('.neditor-block')!
      .dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerId: 6 }));
    editor.element.querySelector('.neditor-gutter__handle')!.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: 6,
        button: 0,
        clientY: 0,
      }),
    );
    document.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerId: 6, clientY: 400 }),
    );

    expect(element.dataset.dragging).toBe('true');

    editor.destroy();

    expect(element.dataset.dragging).toBeUndefined();
  });

  test('a second mount can name itself, because the first took its name back', () => {
    const element = document.createElement('div');
    document.body.append(element);

    mountOn(element, { doc: { blocks: [block({})] }, label: 'First document' }).destroy();

    const second = mountOn(element, { doc: { blocks: [block({})] }, label: 'Second document' });

    // The constructor only names an element that has no name yet, so a label
    // left behind is not cosmetic: every later mount silently keeps the first
    // one's accessible name, in the first one's language.
    expect(second.element.getAttribute('aria-label')).toBe('Second document');
  });

  test("an application's own aria-label is not the editor's to remove", () => {
    const element = document.createElement('div');
    element.setAttribute('aria-label', 'Page body');
    document.body.append(element);

    mountOn(element, { doc: { blocks: [block({})] } }).destroy();

    expect(element.getAttribute('aria-label')).toBe('Page body');
  });
});

describe('announcements name the block type in the reader’s language', () => {
  test('the changed-to announcement uses the localised name, not the internal id', () => {
    const editor = mount([block({ id: 'a', content: [{ text: 'x' }] })], {
      labels: {
        changedTo: 'Changé en {type}',
        slashCommands: {
          bulleted_list: {
            label: 'Liste à puces',
            description: 'Créer une liste à puces.',
            keywords: ['liste'],
          },
        },
      },
    });

    editor.setBlockType('a', 'bulleted_list');

    // Substituting the `BlockType` itself announced "Changé en bulleted list":
    // half the sentence translated, half of it an internal identifier, with no
    // override that could ever reach it.
    expect(live(editor)).toBe('Changé en Liste à puces');
  });
});

describe('a reset closes what described the document it replaced', () => {
  /**
   * `#travel` closes every popover before undoing, under the note that
   * transient UI describes the pre-undo document. `setEditable` closes them
   * too. `setDocument` -- a strictly larger reset -- closed only the block
   * selection, so a link editor open across a socket or autosave restore
   * applied the user's URL to the NEW document at the OLD offsets.
   */
  test('setDocument closes the link editor rather than retargeting it', () => {
    const editor = mount([block({ id: 'a', content: [{ text: 'hello world' }] })]);
    editor.focusRange('a', 0, 5);
    editor.openLinkEditor();

    const popover = document.querySelector<HTMLElement>('.neditor-link-editor')!;

    expect(popover.hidden).toBe(false);

    // Block ids survive a revision reload by design, which is what made this
    // land on real text rather than failing to resolve.
    editor.setDocument({
      blocks: [block({ id: 'a', content: [{ text: 'ACCOUNT NUMBER 1234' }] })],
    });

    expect(popover.hidden, 'the popover describes a document that is gone').toBe(true);

    const input = popover.querySelector<HTMLInputElement>('input')!;
    input.value = 'https://example.com';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(editor.getMarkdown()).toBe('ACCOUNT NUMBER 1234');
    expect(editor.getDocument().blocks[0]?.content.some((run) => run.link)).toBe(false);
  });
});

describe('destroy() gives the element back the way it found it', () => {
  test('a tabindex the editor added is removed again', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = createEditor({ element: host, doc: { blocks: [block({})] } });

    expect(host.getAttribute('tabindex')).toBe('-1');

    editor.destroy();

    expect(host.hasAttribute('tabindex'), 'the host takes focus and answers nothing').toBe(false);
    host.remove();
  });

  test('a tabindex the page already had is put back, not removed', () => {
    const host = document.createElement('div');
    host.tabIndex = 3;
    document.body.append(host);
    const editor = createEditor({ element: host, doc: { blocks: [block({})] } });
    editor.destroy();

    expect(host.tabIndex).toBe(3);
    host.remove();
  });
});

describe('a destroyed editor is done changing', () => {
  /**
   * `#travel` asked `#editable` where every other mutator asks `#canEdit()`,
   * which is `#editable && !#destroyed`. So `undo()` rewrote the document of a
   * destroyed editor and returned true while `canUndo` said false -- and
   * nothing rendered it, so an application holding the reference to serialize
   * later wrote out a document one edit behind what its user last saw.
   */
  test('undo() and redo() stop, and agree with canUndo and canRedo', () => {
    const editor = mount([block({ id: 'b', content: [{ text: 'hi' }] })]);
    editor.setBlockType('b', 'heading1');
    const before = editor.getMarkdown();
    editor.destroy();

    expect(editor.canUndo).toBe(false);
    expect(editor.undo(), 'undo() must not claim it did something').toBe(false);
    expect(editor.canRedo).toBe(false);
    expect(editor.redo()).toBe(false);
    expect(editor.getMarkdown()).toBe(before);
  });
});

describe('setBlockType refuses a type that is not one', () => {
  test('an unknown type is rejected rather than stored', () => {
    const editor = mount([block({ id: 'b', content: [{ text: 'text' }] })]);
    const changes: unknown[] = [];
    editor.on('change', (doc) => changes.push(doc));

    editor.setBlockType('b', 'heading_1' as never);

    expect(editor.getDocument().blocks[0]?.type).toBe('paragraph');
    expect(changes).toHaveLength(0);
  });

  test('a real type still converts', () => {
    const editor = mount([block({ id: 'b', content: [{ text: 'text' }] })]);
    editor.setBlockType('b', 'heading1');

    expect(editor.getDocument().blocks[0]?.type).toBe('heading1');
  });
});

describe('block selection is a mutator, and answers to destroy() like one', () => {
  test('selectBlocks after destroy does not touch the page selection', () => {
    const editor = mount([block({ id: 'a', content: [{ text: 'one' }] })]);
    editor.destroy();

    const other = document.createElement('div');
    other.contentEditable = 'true';
    other.textContent = 'somewhere else';
    document.body.append(other);
    other.focus();
    const range = document.createRange();
    range.selectNodeContents(other);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    editor.selectBlocks(['a']);
    editor.clearBlockSelection();

    expect(selection.rangeCount, 'a destroyed editor must not wipe the page caret').toBe(1);
    expect(document.activeElement).toBe(other);
    other.remove();
  });
});

describe('one focus move is one focus event', () => {
  /**
   * `focus()` dispatches `focusin` synchronously, which `#handleFocusIn`
   * already turns into a `focus` event -- and then it emitted the same payload
   * again, so every caret move between blocks delivered two while `focusRange`
   * delivered one.
   */
  test('focus() emits once, like focusRange()', () => {
    const editor = mount([
      block({ id: 'a', content: [{ text: 'hello' }] }),
      block({ id: 'b', content: [{ text: 'world' }] }),
    ]);
    const seen: string[] = [];
    editor.on('focus', (event) => seen.push(event.blockId));

    editor.focus('b');

    expect(seen).toEqual(['b']);

    seen.length = 0;
    editor.focusRange('a', 0, 2);

    expect(seen).toEqual(['a']);
  });
});
