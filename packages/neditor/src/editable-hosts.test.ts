// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';

import type { Block } from './index.ts';
import { createEditor } from './index.ts';
import type { NEditor } from './editor.ts';

/**
 * Which editable host does an id mean?
 *
 * A table has one contenteditable per cell, so a block id alone does not name a
 * host. Every path that answered the question with the view's `content` — which
 * for a table is hard-wired to cell 0:0 — landed the caret, the popover or the
 * edit in the header row. The other half of the same question is *whether* a
 * node belongs to a host at all: a chevron sits inside a block without being
 * text, and an element in the embedding page is not ours however it is tagged.
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

function cell(editor: NEditor, coords: string): HTMLElement {
  return editor.element.querySelector<HTMLElement>(`[data-cell="${coords}"]`)!;
}

/** Selects `[start, end)` of a host's first text node, the way a mouse would. */
function selectIn(host: HTMLElement, start: number, end: number): void {
  const text = host.firstChild ?? host;
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  host.focus();
}

/**
 * Moves the caret without emptying the selection first.
 *
 * A browser moves a selection; it never passes through having none. Clearing
 * and re-adding a range fires an extra `selectionchange` with nothing selected,
 * which discards armed formatting for a reason the editor never had to reach.
 */
function moveCaret(host: HTMLElement, offset: number): void {
  const text = host.firstChild ?? host;
  getSelection()?.setBaseAndExtent(text, offset, text, offset);
}

/**
 * Moves the caret with no `selectionchange` at all.
 *
 * The state `beforeinput` has to defend against on its own: the caret is
 * somewhere new and the editor's selection bookkeeping has not run for it yet.
 */
function moveCaretSilently(host: HTMLElement, offset: number): void {
  const text = host.firstChild ?? host;
  const live = getSelection()?.getRangeAt(0);
  live?.setStart(text, offset);
  live?.setEnd(text, offset);
}

function press(host: HTMLElement, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  host.dispatchEvent(event);

  return event.defaultPrevented;
}

function paste(host: HTMLElement, html: string, plain = ''): void {
  const data = new DataTransfer();
  data.setData('text/html', html);
  data.setData('text/plain', plain);
  host.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
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

const grid = (): Block =>
  block({
    type: 'table',
    rows: [
      [[{ text: 'A' }], [{ text: 'B' }]],
      [[{ text: 'C' }], [{ text: 'D' }]],
    ],
  });

const linkEditorInput = (): HTMLInputElement =>
  document.querySelector<HTMLInputElement>('.neditor-link-editor__input')!;

const linkEditorApply = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('.neditor-link-editor__button')!;

describe('the link popover addresses the cell it was opened from', () => {
  const linked = (): Block =>
    block({
      type: 'table',
      rows: [
        [[{ text: 'A' }], [{ text: 'B' }]],
        [[{ text: 'C' }], [{ text: 'D', link: 'https://a.test/' }]],
      ],
    });

  test('clicking a link in a cell rewrites that cell, not the header', () => {
    const editor = mount([linked()]);
    const anchor = cell(editor, '1:1').querySelector<HTMLAnchorElement>('a.neditor-link')!;

    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    linkEditorInput().value = 'https://b.test/';
    linkEditorApply().click();

    const rows = editor.getDocument().blocks[0]?.rows;

    expect(rows?.[1]?.[1]).toEqual([{ text: 'D', link: 'https://b.test/' }]);
    // The header used to absorb the rewrite: the click resolved the right cell
    // and then threw it away by focusing the block instead of the host.
    expect(rows?.[0]?.[0]).toEqual([{ text: 'A' }]);
  });

  test('cancelling the popover restores the caret to the cell it came from', () => {
    const editor = mount([grid()]);
    selectIn(cell(editor, '1:1'), 0, 1);

    editor.openLinkEditor();
    linkEditorInput().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );

    expect((document.activeElement as HTMLElement | null)?.dataset.cell).toBe('1:1');
  });
});

describe('armed formatting belongs to one host', () => {
  test('moving the caret to another cell at the same offset disarms it', () => {
    const editor = mount([grid()]);
    selectIn(cell(editor, '0:0'), 0, 0);
    editor.toggleMark('bold');

    // Same block, same offset, different host: the caret has left the place the
    // mark was armed for, and offset 0 of the cell below is not that place.
    moveCaret(cell(editor, '1:0'), 0);

    expect(editor.getSelectionState()?.marks).toEqual([]);
  });

  test('typing in another cell does not pick up formatting armed elsewhere', () => {
    const editor = mount([grid()]);
    selectIn(cell(editor, '0:0'), 0, 0);
    editor.toggleMark('bold');

    const other = cell(editor, '1:0');
    moveCaretSilently(other, 0);
    type(other, 'x');

    const runs = (editor.getDocument().blocks[0]?.rows ?? []).flat().flat();

    expect(runs.filter((run) => run.marks !== undefined)).toEqual([]);
  });

  test('a mark armed in a cell still applies in that same cell', () => {
    const editor = mount([grid()]);
    const target = cell(editor, '0:0');
    selectIn(target, 1, 1);
    editor.toggleMark('bold');

    type(target, 'x');

    expect(editor.getDocument().blocks[0]?.rows?.[0]?.[0]).toEqual([
      { text: 'A' },
      { text: 'x', marks: ['bold'] },
    ]);
  });
});

describe('pasting into a table cell', () => {
  test('marks and links survive the flattening', () => {
    const editor = mount([grid()]);
    const target = cell(editor, '1:1');
    selectIn(target, 0, 1);

    paste(target, '<p>a <strong>b</strong> <a href="https://a.test/">c</a></p>', 'a b c');

    expect(editor.getDocument().blocks[0]?.rows?.[1]?.[1]).toEqual([
      { text: 'a ' },
      { text: 'b', marks: ['bold'] },
      { text: ' ' },
      { text: 'c', link: 'https://a.test/' },
    ]);
  });

  test('several pasted blocks still collapse into the one cell', () => {
    const editor = mount([grid()]);
    const target = cell(editor, '0:1');
    selectIn(target, 0, 1);

    paste(target, '<p>one</p><p>two</p>', 'one\ntwo');

    expect(editor.getDocument().blocks).toHaveLength(1);
    expect(editor.getDocument().blocks[0]?.rows?.[0]?.[1]).toEqual([{ text: 'one\ntwo' }]);
  });
});

describe('controls inside a block are not text', () => {
  test.each([
    [
      'a toggle chevron',
      () => block({ type: 'toggle', content: [{ text: 'T' }] }),
      '.neditor-block__chevron',
    ],
    [
      'a callout icon',
      () => block({ type: 'callout', content: [{ text: 'C' }] }),
      '.neditor-block__icon',
    ],
    [
      'an image button',
      () => block({ type: 'image', src: 'https://a.test/x.png' }),
      '.neditor-image__trigger',
    ],
  ])('Enter on %s does not split the block', (_name, source, selector) => {
    const editor = mount([source()]);
    const control = editor.element.querySelector<HTMLElement>(selector)!;

    const prevented = press(control, 'Enter');

    // Resolving the control to the block's own content made Enter a split, and
    // swallowed the keystroke that should have activated the control.
    expect(prevented).toBe(false);
    expect(editor.getDocument().blocks).toHaveLength(1);
  });
});

describe('nodes the editor does not own', () => {
  test('a matching data-block-id elsewhere in the page cannot select blocks', () => {
    const editor = mount([
      block({ id: 'b1', content: [{ text: 'one' }] }),
      block({ id: 'b2', content: [{ text: 'two' }] }),
      block({ id: 'b3', content: [{ text: 'three' }] }),
    ]);

    // `data-block-id` is an ordinary attribute; the embedding page may well use
    // it, and its values are none of this editor's business.
    const stray = document.createElement('div');
    stray.dataset.blockId = 'b3';
    stray.textContent = 'host page';
    document.body.append(stray);

    const range = document.createRange();
    range.setStart(hosts(editor)[0]!.firstChild!, 0);
    range.setEnd(stray.firstChild!, 4);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));

    expect(editor.getSelectedBlocks()).toEqual([]);
  });

  test('an unknown data-block-id inside the editor is not a block range', () => {
    const editor = mount([
      block({ id: 'b1', content: [{ text: 'one' }] }),
      block({ id: 'b2', content: [{ text: 'two' }] }),
    ]);

    const stray = document.createElement('span');
    stray.dataset.blockId = 'not-a-block';
    stray.textContent = 'x';
    hosts(editor)[1]!.append(stray);

    const seen: unknown[] = [];
    editor.on('selection', (payload) => seen.push(payload));

    const range = document.createRange();
    range.setStart(hosts(editor)[0]!.firstChild!, 0);
    range.setEnd(stray.firstChild!, 1);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    seen.length = 0;
    document.dispatchEvent(new Event('selectionchange'));

    // An empty range is not a selection: promoting it swallowed the event and
    // left every downstream listener describing a selection that had moved on.
    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(seen).toHaveLength(1);
  });
});
