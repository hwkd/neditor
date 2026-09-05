// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';

import type { Block } from './index.ts';
import { createEditor } from './index.ts';
import type { NEditor } from './editor.ts';

/**
 * The surface an embedding application actually touches.
 *
 * Everything here is a promise the package makes to a host it knows nothing
 * about: that `editable: false` really means the document does not change, that
 * `destroy()` is final, that mounting inside a shadow root gives you a working
 * editor and not a pile of unstyled boxes, and that what a screen reader is
 * handed matches what is on the screen. None of these can be checked from
 * inside a feature — they are only visible from the outside, which is why they
 * were the ones missed.
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

/** Mounts into a shadow root, the way a custom element embeds the editor. */
function mountInShadow(
  blocks: Block[],
  options: Record<string, unknown> = {},
): { editor: NEditor; shadow: ShadowRoot } {
  const wrapper = document.createElement('div');
  document.body.append(wrapper);
  const shadow = wrapper.attachShadow({ mode: 'open' });
  const host = document.createElement('div');
  shadow.append(host);
  const editor = createEditor({ element: host, doc: { blocks }, ...options });
  editors.push(editor);

  return { editor, shadow };
}

function caretTo(host: HTMLElement, offset: 'end'): void {
  host.focus();
  const range = document.createRange();
  range.selectNodeContents(host);
  range.collapse(offset === 'end' ? false : true);

  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function press(host: HTMLElement, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  host.dispatchEvent(event);

  return event.defaultPrevented;
}

const chevronOf = (editor: NEditor): HTMLElement =>
  editor.element.querySelector<HTMLElement>('.neditor-block__chevron')!;

describe('read-only means the document does not change', () => {
  // The negative tests below assert "nothing happened", which on its own cannot
  // tell "read-only blocked the write" from "the control never worked at all".
  // Each has a positive half here that gives it meaning.
  test('an editable toggle chevron collapses the block', () => {
    const editor = mount([
      block({ type: 'toggle', content: [{ text: 'Details' }] }),
      block({ content: [{ text: 'hidden' }], depth: 1 }),
    ]);

    chevronOf(editor).click();

    expect(editor.getDocument().blocks[0]?.collapsed).toBe(true);
  });

  test('a read-only toggle chevron cannot collapse it', () => {
    const editor = mount(
      [
        block({ type: 'toggle', content: [{ text: 'Details' }] }),
        block({ content: [{ text: 'hidden' }], depth: 1 }),
      ],
      { editable: false },
    );

    chevronOf(editor).click();

    expect(editor.getDocument().blocks[0]?.collapsed).toBe(false);
  });

  test('it fires no change, so a persistence layer has nothing to write back', () => {
    const editor = mount([block({ type: 'toggle', content: [{ text: 'Details' }] })], {
      editable: false,
    });
    const changes: unknown[] = [];
    editor.on('change', (doc) => changes.push(doc));

    chevronOf(editor).click();

    // The reader's copy overwriting the author's is the whole cost of this bug:
    // an editable:false view is not supposed to have an opinion about content.
    expect(changes).toHaveLength(0);
    expect(editor.canUndo).toBe(false);
  });

  test('a read-only callout icon cannot be repainted through the public method', () => {
    const editor = mount([block({ type: 'callout', content: [{ text: 'note' }], icon: '💡' })], {
      editable: false,
    });

    editor.setCalloutIcon(editor.getDocument().blocks[0]!.id, '🔥');

    expect(editor.getDocument().blocks[0]?.icon).toBe('💡');
  });

  test('setEditable(true) hands the controls back', () => {
    const editor = mount([block({ type: 'toggle', content: [{ text: 'Details' }] })], {
      editable: false,
    });

    editor.setEditable(true);
    chevronOf(editor).click();

    expect(editor.getDocument().blocks[0]?.collapsed).toBe(true);
  });
});

describe('destroy is final', () => {
  test('it leaves the mount point empty', () => {
    const editor = mount([block({ content: [{ text: 'gone' }] })]);
    const host = editor.element;

    editor.destroy();

    expect(host.children).toHaveLength(0);
  });

  test('setDocument cannot put the view back', () => {
    const editor = mount([block({ content: [{ text: 'before' }] })]);
    const host = editor.element;
    editor.destroy();

    editor.setDocument({ blocks: [block({ content: [{ text: 'after' }] })] });

    // Every listener is unhooked and the `neditor` class is off the root, so
    // anything rendered here is unstyled, uneditable, and — because the second
    // destroy() returns early — impossible to remove again.
    expect(host.children).toHaveLength(0);
    expect(host.querySelector('.neditor-live-region')).toBe(null);
  });

  test('setDocument does not replace the document either', () => {
    const editor = mount([block({ content: [{ text: 'before' }] })]);
    editor.destroy();

    editor.setDocument({ blocks: [block({ content: [{ text: 'after' }] })] });

    expect(editor.getDocument().blocks[0]?.content[0]?.text).toBe('before');
  });

  test('a late setEditable cannot rebuild the view', () => {
    // The shape a framework wrapper hits: a prop update lands after unmount.
    const editor = mount([block({ content: [{ text: 'gone' }] })]);
    const host = editor.element;
    editor.destroy();

    editor.setEditable(true);

    expect(host.children).toHaveLength(0);
  });

  test('a second destroy is still a no-op', () => {
    const editor = mount([block({ content: [{ text: 'gone' }] })]);
    const host = editor.element;

    editor.destroy();
    editor.destroy();

    expect(host.children).toHaveLength(0);
  });
});

describe('mounted inside a shadow root', () => {
  test('the portals land in the tree that has the styles, not the body', () => {
    const { shadow } = mountInShadow([block({ content: [{ text: 'x' }] })]);

    // document.body is outside the shadow tree, so a stylesheet injected into
    // that tree never reaches a portal appended to the body: every menu,
    // toolbar and popover renders with no tokens, no layout, no position.
    expect(shadow.querySelectorAll('.neditor-portal').length).toBeGreaterThan(0);
    expect(document.body.querySelectorAll('.neditor-portal')).toHaveLength(0);
  });

  test('the stylesheet is injected into that tree', () => {
    const { shadow } = mountInShadow([block({ content: [{ text: 'x' }] })]);

    expect(shadow.querySelectorAll('style[data-neditor-styles]')).toHaveLength(1);
  });

  test('an explicit portalContainer in another tree is styled too', () => {
    const holder = document.createElement('div');
    document.body.append(holder);
    const other = holder.attachShadow({ mode: 'open' });

    const { shadow } = mountInShadow([block({ content: [{ text: 'x' }] })], {
      portalContainer: other,
    });

    // Two trees, two stylesheets: the blocks are styled where they are mounted
    // and the floating UI where the caller put it.
    expect(shadow.querySelectorAll('style[data-neditor-styles]')).toHaveLength(1);
    expect(other.querySelectorAll('style[data-neditor-styles]')).toHaveLength(1);
    expect(other.querySelectorAll('.neditor-portal').length).toBeGreaterThan(0);
  });

  test('injectStyles: false still leaves the portals where the host can style them', () => {
    const { shadow } = mountInShadow([block({ content: [{ text: 'x' }] })], {
      injectStyles: false,
    });

    expect(shadow.querySelectorAll('style[data-neditor-styles]')).toHaveLength(0);
    expect(shadow.querySelectorAll('.neditor-portal').length).toBeGreaterThan(0);
  });

  test('an ordinary mount still portals to the body', () => {
    mount([block({ content: [{ text: 'x' }] })]);

    expect(document.body.querySelectorAll('.neditor-portal').length).toBeGreaterThan(0);
  });
});

describe('an image announces its alt text', () => {
  const imageBlock = (): Block =>
    block({ type: 'image', src: 'https://a.test/x.png', alt: 'A ginger cat' });

  test('the picture is not inside the button that edits it', () => {
    const editor = mount([imageBlock()]);
    const trigger = editor.element.querySelector<HTMLElement>('.neditor-image__trigger')!;

    // `button` makes its children presentational and an author aria-label beats
    // name-from-content, so an <img> in here is announced as neither an image
    // nor its alt text — the label swallows both.
    expect(trigger.querySelector('img')).toBe(null);
    expect(editor.element.querySelector('img')?.alt).toBe('A ginger cat');
  });

  test('the button is still a named, focusable control', () => {
    const editor = mount([imageBlock()]);
    const trigger = editor.element.querySelector<HTMLButtonElement>('.neditor-image__trigger')!;

    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('aria-label')).toBeTruthy();
    expect(trigger.disabled).toBe(false);
  });

  test('a read-only image offers no control that does nothing', () => {
    const editor = mount([imageBlock()], { editable: false });
    const trigger = editor.element.querySelector<HTMLButtonElement>('.neditor-image__trigger')!;

    // The popover it opens is refused while read-only, so left enabled this is
    // a tab stop that answers with silence.
    expect(trigger.disabled).toBe(true);
    expect(editor.element.querySelector('img')?.alt).toBe('A ginger cat');
  });

  test('the empty-state placeholder is disabled the same way, and reversibly', () => {
    const editor = mount([block({ type: 'image' })], { editable: false });
    const add = () =>
      editor.element.querySelector<HTMLButtonElement>('.neditor-image__placeholder')!;

    expect(add().disabled).toBe(true);

    editor.setEditable(true);

    expect(add().disabled).toBe(false);
  });
});

describe('a newline at the end of a block gets a line box', () => {
  test('Shift+Enter at the end of a paragraph leaves a trailing break', () => {
    const editor = mount([block({ content: [{ text: 'one' }] })]);
    const host = editor.element.querySelector<HTMLElement>('.neditor-block__content')!;
    caretTo(host, 'end');

    press(host, 'Enter', { shiftKey: true });

    // Under `white-space: pre-wrap` a trailing newline ends the last line and
    // there is nothing after it to fill another, so without the <br> the block
    // never grew and the next character landed in front of the break.
    expect(editor.getDocument().blocks[0]?.content[0]?.text).toBe('one\n');
    expect(host.innerHTML).toBe('one\n<br>');
  });

  test('Enter at the end of a table cell leaves one too', () => {
    const editor = mount([
      block({
        type: 'table',
        rows: [
          [[{ text: 'A' }], [{ text: 'B' }]],
          [[{ text: 'C' }], [{ text: 'D' }]],
        ],
      }),
    ]);
    const cell = editor.element.querySelector<HTMLElement>('[data-cell="1:0"]')!;
    caretTo(cell, 'end');

    press(cell, 'Enter');

    expect(cell.innerHTML).toBe('C\n<br>');
  });

  test('a break in the middle of a block adds no filler', () => {
    const editor = mount([block({ content: [{ text: 'one\ntwo' }] })]);
    const host = editor.element.querySelector<HTMLElement>('.neditor-block__content')!;

    expect(host.innerHTML).toBe('one\ntwo');
  });

  test('an empty block still renders nothing, so the placeholder shows', () => {
    const editor = mount([block({})]);
    const host = editor.element.querySelector<HTMLElement>('.neditor-block__content')!;

    expect(host.innerHTML).toBe('');
  });
});

describe('the package stylesheet is a default, not an override', () => {
  /**
   * The README tells consumers to theme the editor with `.neditor { --neditor-*: ... }`
   * from their own stylesheet. Appending ours last in `<head>` put it after
   * theirs, so on equal specificity -- which that recipe has, by construction --
   * ours won and their theming silently did nothing.
   */
  test('it is inserted before the stylesheets the page already had', () => {
    // injectStyles is a no-op once the marker is present, and earlier mounts in
    // this file leave one behind. Without clearing it the assertion never
    // exercises the insert at all -- it passed with the fix reverted.
    for (const stale of document.head.querySelectorAll('style[data-neditor-styles]')) {
      stale.remove();
    }

    const theirs = document.createElement('style');
    theirs.textContent = '.neditor { --neditor-accent: rgb(1 2 3); }';
    document.head.append(theirs);

    const editor = mount([block({ content: [{ text: 'themed' }] })]);
    const ours = document.head.querySelector('style[data-neditor-styles]');

    expect(ours, 'the package stylesheet must be injected').not.toBeNull();
    expect(
      Boolean(ours!.compareDocumentPosition(theirs) & Node.DOCUMENT_POSITION_FOLLOWING),
      "the page's own stylesheet must come after ours, so it wins on equal specificity",
    ).toBe(true);

    editor.destroy();
    theirs.remove();
  });
});

describe('editable: false covers every public mutator', () => {
  /**
   * `setBlockType` was the one that never asked. A host that keeps a block-type
   * control wired across an edit/preview toggle rewrote the read-only document
   * and fired `change` for it -- which the README names as the exact thing
   * `editable: false` promises not to do.
   */
  test('setBlockType does not rewrite a read-only document', () => {
    const editor = mount([block({ id: 'a', content: [{ text: 'hello' }] })], { editable: false });
    const changes: unknown[] = [];
    editor.on('change', (doc) => changes.push(doc));

    editor.setBlockType('a', 'heading1');

    expect(editor.getDocument().blocks[0]?.type).toBe('paragraph');
    expect(changes).toHaveLength(0);
    expect(editor.canUndo).toBe(false);
  });

  test('it still converts when the editor is editable', () => {
    const editor = mount([block({ id: 'a', content: [{ text: 'hello' }] })]);

    editor.setBlockType('a', 'heading1');

    expect(editor.getDocument().blocks[0]?.type).toBe('heading1');
  });
});

describe('the selection a host saves is the selection it gets back', () => {
  /**
   * `getSelectionState()` and `focusRange()` are the documented save/restore
   * pair for "stash the selection, open my own dialog, put it back". Inside a
   * table the state omitted the cell, and `focusRange` resolves a table without
   * one to its first cell -- so the restore silently moved the caret into the
   * header and the next `toggleMark` formatted that cell instead of the user's.
   */
  test('a selection inside a table cell restores to that cell', () => {
    const editor = mount([
      block({
        id: 'tbl',
        type: 'table',
        rows: [
          [[{ text: 'H1' }], [{ text: 'H2' }]],
          [[{ text: 'a1' }], [{ text: 'b1' }]],
        ],
      }),
    ]);
    const cell = editor.element.querySelector<HTMLElement>('[data-cell="1:1"]')!;
    cell.focus();
    const range = document.createRange();
    range.selectNodeContents(cell);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const state = editor.getSelectionState()!;

    expect(state.cell, 'the state must say which cell it was read from').toEqual({
      row: 1,
      column: 1,
    });

    editor.focusRange(state.blockId, state.range.start, state.range.end, state.cell);
    editor.toggleMark('bold');

    const rows = editor.getDocument().blocks[0]!.rows!;

    expect(rows[1]?.[1]?.[0]?.marks, 'the mark belongs to the cell the user was in').toEqual([
      'bold',
    ]);
    expect(rows[0]?.[0]?.[0]?.marks ?? []).toEqual([]);
  });
});

describe('labels reach the strings a reader actually sees', () => {
  test('a code block carries the label the host set', () => {
    const editor = mount([block({ type: 'code', content: [{ text: 'const x = 1;' }] })], {
      labels: { codeBlockLabel: 'code source' },
    });

    expect(
      editor.element.querySelector<HTMLElement>('.neditor-block__pre')?.dataset.neditorCodeLabel,
    ).toBe('code source');
  });

  test('and the default when it set nothing', () => {
    const editor = mount([block({ type: 'code', content: [{ text: 'x' }] })]);

    expect(
      editor.element.querySelector<HTMLElement>('.neditor-block__pre')?.dataset.neditorCodeLabel,
    ).toBe('code');
  });
});

describe('history state a host can bind a button to', () => {
  /**
   * `#travel` refuses outright while `editable` is false, so reporting the raw
   * stack depth described an editor that could be stepped back and an `undo()`
   * that returned false -- a toolbar button enabled and then inert.
   */
  test('a read-only editor reports no history to travel', () => {
    const editor = mount([block({ id: 'b', content: [{ text: 'hi' }] })]);
    editor.setBlockType('b', 'heading1');

    expect(editor.canUndo).toBe(true);

    editor.setEditable(false);

    expect(editor.canUndo).toBe(false);
    expect(editor.undo()).toBe(false);
    expect(editor.canRedo).toBe(false);
    expect(editor.redo()).toBe(false);
  });

  test('and says so, so a toolbar rendered from the event keeps up', () => {
    const editor = mount([block({ id: 'b', content: [{ text: 'hi' }] })]);
    editor.setBlockType('b', 'heading1');
    const seen: boolean[] = [];
    editor.on('history', (state) => seen.push(state.canUndo));

    editor.setEditable(false);

    expect(seen).toEqual([false]);

    editor.setEditable(true);

    expect(seen).toEqual([false, true]);
    expect(editor.canUndo).toBe(true);
  });
});

describe('a table command hands the caret back to the cell it was invoked from', () => {
  /**
   * The toolbar's stated promise, and four of its six commands kept it. "Insert
   * row above" and "insert column left" put the new row or column *at* the
   * active index, which pushes the user's own cell one along -- and the caret
   * restore reused the pre-edit indices, so it landed in the new blank cell
   * instead of the text they were editing.
   */
  const table = () =>
    block({
      id: 'tbl',
      type: 'table',
      rows: [
        [[{ text: 'A' }], [{ text: 'B' }]],
        [[{ text: 'C' }], [{ text: 'D' }]],
      ],
    });

  const clickToolbar = (editor: NEditor, label: string): void => {
    const cell = editor.element.querySelector<HTMLElement>('[data-cell="1:1"]')!;
    cell.focus();
    const range = document.createRange();
    range.selectNodeContents(cell);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));

    const button = [...document.querySelectorAll<HTMLElement>('.neditor-table-toolbar__button')]
      .reverse()
      .find((one) => one.getAttribute('aria-label') === label)!;

    button.click();
  };

  test.each([
    ['Insert row above', 'D'],
    ['Insert row below', 'D'],
    ['Insert column left', 'D'],
    ['Insert column right', 'D'],
  ])('%s leaves the caret in the cell that held its text', (label, expected) => {
    const editor = mount([table()]);
    clickToolbar(editor, label);

    const focused = document.activeElement as HTMLElement | null;

    expect(focused?.dataset.cell, `${label} moved the caret away`).toBeDefined();
    expect(focused?.textContent).toBe(expected);
  });
});
