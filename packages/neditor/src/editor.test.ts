// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';

import type { Block, NEditorDocument } from './index.ts';
import { blockText, createEditor, normalizeDocument, toMarkdown } from './index.ts';
import type { NEditor } from './editor.ts';

/**
 * Editor-level regression tests.
 *
 * Everything here was a real defect found in the pre-release audit. They drive
 * the editor the way a browser does — real elements, real events — because each
 * of these bugs lived in the wiring between features, not in any one function.
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

function caretTo(host: HTMLElement, offset: number | 'end'): void {
  host.focus();
  const range = document.createRange();
  range.selectNodeContents(host);

  if (offset === 'end') {
    range.collapse(false);
  } else if (offset === 0) {
    range.collapse(true);
  }

  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function press(host: HTMLElement, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  host.dispatchEvent(event);

  return event.defaultPrevented;
}

describe('links from an untrusted document', () => {
  test('a javascript: href never reaches the model or the DOM', () => {
    const stored = {
      blocks: [
        block({ content: [{ text: 'click', link: 'javascript:alert(1)' }] as Block['content'] }),
      ],
    };

    const editor = mount(stored.blocks);

    expect(normalizeDocument(stored).blocks[0]?.content[0]?.link).toBeUndefined();
    expect(editor.element.querySelector('a')).toBe(null);
    expect(toMarkdown(editor.getDocument())).not.toContain('javascript:');
  });

  test.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
  ])('%s is stripped while its text survives', (href: string) => {
    const doc = normalizeDocument({
      blocks: [block({ content: [{ text: 'text', link: href }] as Block['content'] })],
    });

    expect(doc.blocks[0]?.content[0]?.link).toBeUndefined();
    expect(blockText(doc.blocks[0]!)).toBe('text');
  });

  test('a safe href is preserved', () => {
    const doc = normalizeDocument({
      blocks: [block({ content: [{ text: 'x', link: 'https://a.test/' }] as Block['content'] })],
    });

    expect(doc.blocks[0]?.content[0]?.link).toBe('https://a.test/');
  });
});

describe('a malformed stored document cannot break the editor', () => {
  test('marks that are not an array degrade instead of throwing', () => {
    expect(() =>
      normalizeDocument({
        blocks: [block({ content: [{ text: 'a', marks: 5 }] as unknown as Block['content'] })],
      }),
    ).not.toThrow();
  });

  test('an absurd depth is clamped, so Markdown cannot blow up', () => {
    const doc = normalizeDocument({ blocks: [block({ depth: 1e12 })] });

    expect(doc.blocks[0]?.depth).toBe(0);
    expect(() => toMarkdown(doc)).not.toThrow();
  });

  test('an unknown block type degrades to a paragraph', () => {
    const doc = normalizeDocument({
      blocks: [block({ type: 'constructor' as Block['type'], content: [{ text: 'x' }] })],
    });

    expect(doc.blocks[0]?.type).toBe('paragraph');
    expect(() => toMarkdown(doc)).not.toThrow();
  });

  test('imported depths are pulled back to the indent invariant', () => {
    const doc = normalizeDocument({
      blocks: [block({ depth: 9 }), block({ depth: 9 })],
    });

    expect(doc.blocks.map((b) => b.depth)).toEqual([0, 1]);
  });
});

describe('merging never destroys a block that holds no mergeable text', () => {
  test('Delete before a table selects it rather than deleting it', () => {
    const editor = mount([
      block({ content: [{ text: 'hello' }] }),
      block({ type: 'table', rows: [[[{ text: 'A' }], [{ text: 'B' }]]] }),
    ]);

    caretTo(hosts(editor)[0]!, 'end');
    press(hosts(editor)[0]!, 'Delete');

    const after = editor.getDocument().blocks;

    expect(after.map((b) => b.type)).toEqual(['paragraph', 'table']);
    expect(after[1]?.rows?.[0]?.[0]).toEqual([{ text: 'A' }]);
    expect(editor.getSelectedBlocks()).toHaveLength(1);
  });

  test('Backspace after an image selects it rather than absorbing it', () => {
    const editor = mount([
      block({ type: 'image', src: 'https://a.test/x.png', alt: 'a' }),
      block({ content: [{ text: 'text' }] }),
    ]);

    const paragraph = hosts(editor).at(-1)!;
    caretTo(paragraph, 0);
    press(paragraph, 'Backspace');

    const after = editor.getDocument().blocks;

    expect(after.map((b) => b.type)).toEqual(['image', 'paragraph']);
    expect(after[0]?.src).toBe('https://a.test/x.png');
  });

  test('Backspace does not merge into a block hidden by a collapsed toggle', () => {
    const editor = mount([
      block({ type: 'toggle', content: [{ text: 'parent' }], collapsed: true }),
      block({ depth: 1, content: [{ text: 'hidden child' }] }),
      block({ content: [{ text: 'visible' }] }),
    ]);

    const visible = hosts(editor).at(-1)!;
    caretTo(visible, 0);
    press(visible, 'Backspace');

    const after = editor.getDocument().blocks;

    // Merged into the toggle it can see, not the child it cannot.
    expect(blockText(after[0]!)).toBe('parentvisible');
    expect(blockText(after[1]!)).toBe('hidden child');
  });

  test('Delete at the end of a table cell does not reach the block handler', () => {
    const editor = mount([
      block({ type: 'table', rows: [[[{ text: 'A' }]]] }),
      block({ content: [{ text: 'after' }] }),
    ]);

    const cell = editor.element.querySelector<HTMLElement>('[data-cell="0:0"]')!;
    caretTo(cell, 'end');

    expect(press(cell, 'Delete')).toBe(true);
    expect(editor.getDocument().blocks).toHaveLength(2);
  });
});

describe('read-only', () => {
  test('setEditable is reversible', () => {
    const editor = mount([block({ content: [{ text: 'x' }] })]);

    editor.setEditable(false);
    expect(hosts(editor)[0]?.contentEditable).toBe('false');

    editor.setEditable(true);
    expect(editor.editable).toBe(true);
    expect(hosts(editor)[0]?.contentEditable).toBe('true');
  });

  test('every table cell is locked, not just the first', () => {
    const editor = mount([
      block({
        type: 'table',
        rows: [
          [[{ text: 'A' }], [{ text: 'B' }]],
          [[{ text: 'C' }], [{ text: 'D' }]],
        ],
      }),
    ]);

    editor.setEditable(false);

    const cells = [...editor.element.querySelectorAll<HTMLElement>('[data-cell]')];

    expect(cells).toHaveLength(4);
    expect(cells.every((cell) => cell.contentEditable === 'false')).toBe(true);
  });

  test('an editable to-do checkbox toggles the document', () => {
    // The read-only test below asserts `checked === false` after a click, which
    // on its own cannot tell "read-only blocked the write" from "checkboxes
    // never worked at all". This is the positive half that gives it meaning.
    const editor = mount([block({ type: 'todo', content: [{ text: 'task' }], checked: false })]);

    editor.element.querySelector<HTMLElement>('.neditor-block__checkbox')?.click();

    expect(editor.getDocument().blocks[0]?.checked).toBe(true);
  });

  test('a read-only to-do checkbox cannot change the document', () => {
    const editor = mount([block({ type: 'todo', content: [{ text: 'task' }], checked: false })], {
      editable: false,
    });

    editor.element.querySelector<HTMLElement>('.neditor-block__checkbox')?.click();

    expect(editor.getDocument().blocks[0]?.checked).toBe(false);
  });

  test('a read-only editor swallows the keystroke rather than letting it land', () => {
    const editor = mount([block({ content: [{ text: 'x' }] })], { editable: false });
    const host = hosts(editor)[0]!;
    const event = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: 'z',
      bubbles: true,
      cancelable: true,
    });

    host.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});

describe('IME composition', () => {
  test('keys are ignored while a candidate is open', () => {
    const editor = mount([block({ content: [{ text: 'abc' }] })]);
    const host = hosts(editor)[0]!;
    caretTo(host, 'end');

    host.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));

    // Enter here commits the candidate; splitting the block would lose it.
    expect(press(host, 'Enter')).toBe(false);
    expect(editor.getDocument().blocks).toHaveLength(1);
  });

  test('isComposing on the event alone is enough to stand down', () => {
    const editor = mount([block({ content: [{ text: 'abc' }] })]);
    const host = hosts(editor)[0]!;
    caretTo(host, 'end');

    expect(press(host, 'Enter', { isComposing: true } as KeyboardEventInit)).toBe(false);
    expect(editor.getDocument().blocks).toHaveLength(1);
  });

  test('the committed text is read back into the model', () => {
    const editor = mount([block({ content: [] })]);
    const host = hosts(editor)[0]!;
    host.focus();

    host.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    host.textContent = '日本語';
    host.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本語' }));

    expect(blockText(editor.getDocument().blocks[0]!)).toBe('日本語');
  });
});

describe('paste', () => {
  function paste(host: HTMLElement, html: string, plain = ''): void {
    const data = new DataTransfer();
    data.setData('text/html', html);
    data.setData('text/plain', plain);
    host.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }

  test('a pasted table keeps its cells instead of becoming a blank grid', () => {
    const editor = mount([block({})]);
    const host = hosts(editor)[0]!;
    caretTo(host, 0);

    paste(
      host,
      '<table><tr><th>h1</th><th>h2</th></tr><tr><td>a</td><td>b</td></tr></table><p>x</p>',
    );

    const table = editor.getDocument().blocks.find((b) => b.type === 'table');

    expect(table?.rows?.map((row) => row.map((cell) => cell.map((r) => r.text).join('')))).toEqual([
      ['h1', 'h2'],
      ['a', 'b'],
    ]);
  });

  test('a pasted image keeps its source', () => {
    const editor = mount([block({})]);
    const host = hosts(editor)[0]!;
    caretTo(host, 0);

    paste(host, '<figure><img src="https://a.test/x.png" alt="alt"></figure><p>after</p>');

    const image = editor.getDocument().blocks.find((b) => b.type === 'image');

    expect(image?.src).toBe('https://a.test/x.png');
    expect(image?.alt).toBe('alt');
  });

  test('indented source HTML does not paste blank leading lines', () => {
    const editor = mount([block({})]);
    const host = hosts(editor)[0]!;
    caretTo(host, 0);

    paste(host, '<blockquote>\n  <p>one</p>\n  <p>two</p>\n</blockquote>');

    const text = editor.getDocument().blocks.map(blockText).join('|');

    expect(text).not.toMatch(/^\s*\n/);
    expect(text).toContain('one');
    expect(text).toContain('two');
  });
});

describe('listeners', () => {
  test('a throwing listener neither escapes nor silences the others', () => {
    const seen: string[] = [];
    const errors: unknown[] = [];

    const editor = mount([block({ content: [{ text: 'x' }] })], {
      onError: (error: unknown) => errors.push(error),
    });

    editor.on('change', () => {
      throw new Error('listener exploded');
    });
    editor.on('change', () => seen.push('second'));

    expect(() =>
      editor.setDocument({ blocks: [block({ content: [{ text: 'y' }] })] }),
    ).not.toThrow();
    expect(seen).toEqual(['second']);
    expect(errors).toHaveLength(1);
  });

  test('the edit that emitted still completes', () => {
    const editor = mount([block({ content: [{ text: 'ab' }] })], { onError: () => {} });
    editor.on('change', () => {
      throw new Error('boom');
    });

    const host = hosts(editor)[0]!;
    caretTo(host, 'end');
    press(host, 'Enter');

    expect(editor.getDocument().blocks).toHaveLength(2);
  });
});

describe('lifecycle', () => {
  test('getDocument returns a copy that cannot be written back through', () => {
    const editor = mount([block({ type: 'table', rows: [[[{ text: 'A' }]]] })]);
    const snapshot = editor.getDocument();

    snapshot.blocks[0]!.rows![0]![0]![0]!.text = 'mutated';

    expect(editor.getDocument().blocks[0]?.rows?.[0]?.[0]?.[0]?.text).toBe('A');
  });

  test('destroy is idempotent', () => {
    const editor = mount([block({})]);

    expect(() => {
      editor.destroy();
      editor.destroy();
    }).not.toThrow();
  });

  test('two editors on one page do not answer for each other', () => {
    const a = mount([block({ id: 'shared', content: [{ text: 'first' }] })]);
    const b = mount([block({ id: 'shared', content: [{ text: 'second' }] })]);

    const hostB = hosts(b)[0]!;
    caretTo(hostB, 'end');
    press(hostB, 'Enter');

    expect(a.getDocument().blocks).toHaveLength(1);
    expect(b.getDocument().blocks).toHaveLength(2);
  });
});

describe('clipboard geometry', () => {
  test('copying a nested block above a shallower one still produces markdown', () => {
    const editor = mount([
      block({ content: [{ text: 'root' }] }),
      block({ depth: 1, content: [{ text: 'child' }] }),
      block({ content: [{ text: 'sibling' }] }),
    ]);

    const ids = editor
      .getDocument()
      .blocks.slice(1)
      .map((b) => b.id);
    editor.selectBlocks(ids);

    const data = new DataTransfer();
    editor.element.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
    );

    expect(data.getData('text/plain')).toContain('child');
    expect(data.getData('text/plain')).toContain('sibling');
  });
});

describe('document identity', () => {
  test('an empty document is still editable', () => {
    const editor = mount([]);
    const doc: NEditorDocument = editor.getDocument();

    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]?.type).toBe('paragraph');
  });
});

describe('table cell routing', () => {
  const table = (): Block =>
    block({
      type: 'table',
      rows: [
        [[{ text: 'A' }], [{ text: 'B' }]],
        [[{ text: 'C' }], [{ text: 'D' }]],
      ],
    });

  function cell(editor: NEditor, coords: string): HTMLElement {
    return editor.element.querySelector<HTMLElement>(`[data-cell="${coords}"]`)!;
  }

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

  test('a mark applied in a cell lands in that cell, not the block', () => {
    const editor = mount([table()]);
    const target = cell(editor, '1:1');
    selectIn(target, 0, 1);

    editor.toggleMark('bold');

    const rows = editor.getDocument().blocks[0]?.rows;

    expect(rows?.[1]?.[1]).toEqual([{ text: 'D', marks: ['bold'] }]);
    expect(editor.getDocument().blocks[0]?.content).toEqual([]);
  });

  test('a mark can be cleared again from inside a cell', () => {
    const editor = mount([table()]);
    selectIn(cell(editor, '0:0'), 0, 1);
    editor.toggleMark('bold');

    selectIn(cell(editor, '0:0'), 0, 1);
    editor.toggleMark('bold');

    expect(editor.getDocument().blocks[0]?.rows?.[0]?.[0]).toEqual([{ text: 'A' }]);
  });

  test('a link applied in a cell reaches the cell', () => {
    const editor = mount([table()]);
    selectIn(cell(editor, '1:0'), 0, 1);

    expect(editor.setLink('https://a.test/')).toBe(true);
    expect(editor.getDocument().blocks[0]?.rows?.[1]?.[0]).toEqual([
      { text: 'C', link: 'https://a.test/' },
    ]);
  });

  test('undo puts the caret back in the cell it was in', () => {
    const editor = mount([table()]);
    const target = cell(editor, '1:1');
    selectIn(target, 0, 1);
    editor.toggleMark('bold');

    editor.undo();

    expect((document.activeElement as HTMLElement)?.dataset.cell).toBe('1:1');
  });

  test('Cmd+A inside a cell selects the cell text, not every block', () => {
    const editor = mount([table(), block({ content: [{ text: 'after' }] })]);
    const target = cell(editor, '0:0');
    target.focus();
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(true);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);

    press(target, 'a', { metaKey: true });

    // The table's own content is always empty, so the "empty block" shortcut
    // used to escalate straight to selecting the whole document.
    expect(editor.getSelectedBlocks()).toHaveLength(0);
  });
});

describe('block-type specific editing', () => {
  test('Enter inside a code block breaks the line rather than the block', () => {
    const editor = mount([block({ type: 'code', content: [{ text: 'const a = 1;' }] })]);
    const host = hosts(editor)[0]!;
    caretTo(host, 'end');

    press(host, 'Enter');

    const after = editor.getDocument().blocks;

    expect(after).toHaveLength(1);
    expect(after[0]?.type).toBe('code');
    expect(blockText(after[0]!)).toBe('const a = 1;\n');
  });

  test('clicking below a trailing table appends a paragraph', () => {
    const editor = mount([block({ type: 'table', rows: [[[{ text: 'A' }]]] })]);

    editor.element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    // A table keeps its text in `rows`, so the "last block is empty" check used
    // to be true and the caret landed in the header cell instead.
    const after = editor.getDocument().blocks;

    expect(after.map((b) => b.type)).toEqual(['table', 'paragraph']);
  });

  test('clicking below a captionless image appends a paragraph', () => {
    const editor = mount([block({ type: 'image', src: 'https://a.test/x.png' })]);

    editor.element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    expect(editor.getDocument().blocks.map((b) => b.type)).toEqual(['image', 'paragraph']);
  });
});

describe('embedding', () => {
  test('setDocument can replace content without echoing a change', () => {
    const seen: string[] = [];
    const editor = mount([block({ content: [{ text: 'a' }] })]);
    editor.on('change', () => seen.push('change'));

    // The loop this prevents: socket -> setDocument -> onChange -> socket.
    editor.setDocument({ blocks: [block({ content: [{ text: 'b' }] })] }, { silent: true });

    expect(seen).toHaveLength(0);
    expect(blockText(editor.getDocument().blocks[0]!)).toBe('b');

    editor.setDocument({ blocks: [block({ content: [{ text: 'c' }] })] });
    expect(seen).toHaveLength(1);
  });

  test('portals go where the caller asks, for a modal dialog or shadow root', () => {
    const container = document.createElement('div');
    document.body.append(container);

    mount([block({})], { portalContainer: container });

    // A modal <dialog> is promoted to the top layer and paints above any
    // z-index, so body-mounted portals are invisible inside one.
    expect(container.querySelectorAll('.neditor-portal').length).toBeGreaterThan(0);
    expect(document.body.querySelector(':scope > .neditor-portal')).toBe(null);
  });

  test('a style nonce is applied, for a strict style-src policy', () => {
    document.head.replaceChildren();
    mount([block({})], { styleNonce: 'abc123' });

    expect(document.head.querySelector('style[data-neditor-styles]')?.getAttribute('nonce')).toBe(
      'abc123',
    );
  });

  test('an event whose target is from another realm still resolves its block', () => {
    // instanceof compares against the script's own realm, so a node from an
    // iframe document is rejected by every such check even though it is valid.
    // The duck-typed contract itself is pinned in util/dom.test.ts; this covers
    // the editor actually routing one.
    const editor = mount([block({ id: 'blk', content: [{ text: 'a' }] })]);
    const host = hosts(editor)[0]!;
    const event = new MouseEvent('mousedown', { bubbles: true });

    // A real node, but presented the way a foreign one arrives: no shared
    // constructor, only the node interface.
    Object.defineProperty(event, 'target', {
      value: {
        nodeType: 1,
        nodeName: 'DIV',
        parentElement: host,
        closest: (s: string) => host.closest(s),
      },
      configurable: true,
    });

    expect(() => editor.element.dispatchEvent(event)).not.toThrow();
    expect(editor.getDocument().blocks[0]?.id).toBe('blk');
  });
});

describe('public surface', () => {
  test('getSelectionState returns marks the caller cannot write back through', () => {
    const editor = mount([block({ content: [{ text: 'abc' }] })]);
    const host = hosts(editor)[0]!;
    caretTo(host, 0);
    editor.toggleMark('bold');

    const state = editor.getSelectionState();
    (state?.marks as string[] | undefined)?.splice(0);

    // The array is the live armed-formatting state; aliasing it let a caller
    // silently rearm or clear formatting.
    expect(editor.getSelectionState()?.marks).toEqual(['bold']);
  });
});

describe('touch', () => {
  function touch(type: string, target: EventTarget, init: PointerEventInit = {}): void {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType: 'touch',
        pointerId: 1,
        ...init,
      }),
    );
  }

  test('a long press selects the block, since touch has no hover', async () => {
    const editor = mount([block({ content: [{ text: 'a' }] })]);
    const host = hosts(editor)[0]!;

    touch('pointerdown', host, { clientX: 10, clientY: 10 });
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(editor.getSelectedBlocks()).toHaveLength(1);
  });

  test('a press that drifts is a scroll, not a selection', async () => {
    const editor = mount([block({ content: [{ text: 'a' }] })]);
    const host = hosts(editor)[0]!;

    touch('pointerdown', host, { clientX: 10, clientY: 10 });
    touch('pointermove', document, { clientX: 10, clientY: 90 });
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(editor.getSelectedBlocks()).toHaveLength(0);
  });

  test('lifting the finger before the delay does not select', async () => {
    const editor = mount([block({ content: [{ text: 'a' }] })]);
    const host = hosts(editor)[0]!;

    touch('pointerdown', host, { clientX: 10, clientY: 10 });
    touch('pointerup', document, { clientX: 10, clientY: 10 });
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(editor.getSelectedBlocks()).toHaveLength(0);
  });

  test('a cancelled drag releases rather than wedging the editor', () => {
    const editor = mount([
      block({ content: [{ text: 'a' }] }),
      block({ content: [{ text: 'b' }] }),
    ]);
    const target = editor.element.querySelector('.neditor-block')!;

    target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerId: 2 }));
    const handle = editor.element.querySelector('.neditor-gutter__handle')!;
    handle.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: 2,
        button: 0,
        clientY: 0,
      }),
    );
    document.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerId: 2, clientY: 200 }),
    );

    // pointerup never follows a pointercancel, so without this the drag stays
    // live forever and every later pointer event is misrouted.
    document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 2 }));

    expect(editor.element.dataset.dragging).toBeUndefined();
    expect(editor.element.querySelector<HTMLElement>('.neditor-drop-indicator')?.hidden).toBe(true);
  });
});

describe('public API methods that had no coverage', () => {
  test('getMarkdown serializes the live document', () => {
    const editor = mount([
      block({ type: 'heading1', content: [{ text: 'Title' }] }),
      block({ content: [{ text: 'bold', marks: ['bold'] }] }),
      block({ type: 'bulleted_list', content: [{ text: 'one' }] }),
    ]);

    // The documented export path: a regression returning empty or truncated
    // Markdown would silently produce empty files for every consumer.
    expect(editor.getMarkdown()).toBe('# Title\n\n**bold**\n\n- one');
  });

  test('getMarkdown reflects an edit rather than the mount-time document', () => {
    const editor = mount([block({ id: 'a', content: [{ text: 'before' }] })]);

    editor.setDocument({
      blocks: [{ id: 'a', type: 'paragraph', depth: 0, content: [{ text: 'after' }] }],
    });

    expect(editor.getMarkdown()).toBe('after');
  });

  test('setCalloutIcon stores one grapheme, not one code point', () => {
    const editor = mount([block({ id: 'c', type: 'callout', content: [{ text: 'note' }] })]);

    // U+26A0 plus a variation selector. Indexing or spreading keeps only the
    // first half and renders as a different glyph.
    editor.setCalloutIcon('c', '⚠️');

    expect(editor.getDocument().blocks[0]?.icon).toBe('⚠️');
  });

  test('setCalloutIcon takes only the first grapheme of a longer string', () => {
    const editor = mount([block({ id: 'c', type: 'callout', content: [{ text: 'note' }] })]);

    editor.setCalloutIcon('c', 'AB');

    expect(editor.getDocument().blocks[0]?.icon).toBe('A');
  });

  test('focus(id, offset) places the caret at that offset', () => {
    const editor = mount([
      block({ id: 'a', content: [{ text: 'first' }] }),
      block({ id: 'b', content: [{ text: 'second' }] }),
    ]);

    editor.focus('b', 3);

    const state = editor.getSelectionState();
    expect(state?.blockId).toBe('b');
    expect(state?.range.start).toBe(3);
  });

  test('focusRange selects a span rather than collapsing', () => {
    const editor = mount([block({ id: 'a', content: [{ text: 'hello world' }] })]);

    editor.focusRange('a', 6, 11);

    const state = editor.getSelectionState();
    expect(state?.blockId).toBe('a');
    expect(state?.range).toEqual({ start: 6, end: 11 });
  });

  test('focusRange clamps past the end of the content', () => {
    const editor = mount([block({ id: 'a', content: [{ text: 'abc' }] })]);

    editor.focusRange('a', 1, 99);

    expect(editor.getSelectionState()?.range.end).toBe(3);
  });
});
