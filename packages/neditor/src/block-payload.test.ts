// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';

import type { Block } from './index.ts';
import { blockText, blocksToHtml, createEditor, normalizeDocument, toMarkdown } from './index.ts';
import { setBlockType } from './model/document.ts';
import type { NEditor } from './editor.ts';

/**
 * A block is not the same thing as its text.
 *
 * `content` is the whole payload of a paragraph and only a fraction of a table,
 * an image or a divider: the rows, the source, the caption's picture all live
 * beside it. Every path that moved a block by moving its `content` — merging a
 * paste, retyping a block, converting a type — therefore kept the text and
 * silently dropped everything else, or handed text to a type with nowhere to
 * draw it. These are those paths.
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

function mount(blocks: Block[]): NEditor {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createEditor({ element: host, doc: { blocks } });
  editors.push(editor);

  return editor;
}

const hosts = (editor: NEditor): HTMLElement[] => [
  ...editor.element.querySelectorAll<HTMLElement>('.neditor-block__content'),
];

/** Puts the caret at a character offset, the way a click would. */
function caretTo(host: HTMLElement, offset: number | 'end'): void {
  host.focus();
  const text = host.firstChild;
  const range = document.createRange();
  range.selectNodeContents(host);

  if (offset === 'end') {
    range.collapse(false);
  } else if (text) {
    range.setStart(text, offset);
    range.collapse(true);
  } else {
    range.collapse(true);
  }

  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function press(host: HTMLElement, key: string): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
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

const types = (editor: NEditor): string[] => editor.getDocument().blocks.map((b) => b.type);
const texts = (editor: NEditor): string[] => editor.getDocument().blocks.map(blockText);
const cells = (block: Block | undefined): string[][] =>
  (block?.rows ?? []).map((row) => row.map((cell) => cell.map((run) => run.text).join('')));

describe('converting a type rehouses text the new type cannot draw', () => {
  test('a paragraph converted to a table keeps its text, in the first cell', () => {
    const paragraph = block({ content: [{ text: 'hello' }] });
    const [table] = setBlockType([paragraph], paragraph.id, 'table');

    expect(cells(table)[0]?.[0]).toBe('hello');
    // Not in both places: `content` is what a table never draws.
    expect(table?.content).toEqual([]);
  });

  test('an existing table keeps its own rows when retyped to a table', () => {
    const existing = block({ type: 'table', rows: [[[{ text: 'A' }], [{ text: 'B' }]]] });
    const [table] = setBlockType([existing], existing.id, 'table');

    expect(cells(table)).toEqual([['A', 'B']]);
  });

  test('/table on a paragraph does not hide its text from either serializer', () => {
    const editor = mount([block({ content: [{ text: 'hello' }] })]);

    editor.setBlockType(editor.getDocument().blocks[0]!.id, 'table');

    const doc = editor.getDocument();

    expect(toMarkdown(doc)).toContain('hello');
    expect(blocksToHtml(document, doc.blocks)).toContain('hello');
    expect(editor.element.textContent).toContain('hello');
  });
});

describe('Backspace never retypes a block whose payload is not its text', () => {
  test('Backspace at the start of an image caption keeps the picture', () => {
    const editor = mount([block({ type: 'image', src: 'https://a.test/x.png', alt: 'a' })]);
    const caption = hosts(editor)[0]!;

    caretTo(caption, 0);
    press(caption, 'Backspace');

    const after = editor.getDocument().blocks;

    expect(after[0]?.type).toBe('image');
    expect(after[0]?.src).toBe('https://a.test/x.png');
    expect(after[0]?.alt).toBe('a');
    // Selected instead: deleting the image stays available, but must be asked for.
    expect(editor.getSelectedBlocks()).toEqual([after[0]?.id]);
  });

  test('a caption with text is not lost with it', () => {
    const editor = mount([
      block({ type: 'image', src: 'https://a.test/x.png', content: [{ text: 'cap' }] }),
    ]);
    const caption = hosts(editor)[0]!;

    caretTo(caption, 0);
    press(caption, 'Backspace');

    const after = editor.getDocument().blocks[0];

    expect(after?.src).toBe('https://a.test/x.png');
    expect(blockText(after!)).toBe('cap');
  });

  test('a heading is still retyped to a paragraph, since its text is all it holds', () => {
    const editor = mount([block({ type: 'heading1', content: [{ text: 'title' }] })]);
    const host = hosts(editor)[0]!;

    caretTo(host, 0);
    press(host, 'Backspace');

    expect(types(editor)).toEqual(['paragraph']);
    expect(texts(editor)).toEqual(['title']);
  });
});

describe('pasting a block that is more than text', () => {
  test('a table pasted into a non-empty paragraph arrives instead of vanishing', () => {
    const editor = mount([block({ content: [{ text: 'abcd' }] })]);
    const host = hosts(editor)[0]!;

    caretTo(host, 2);
    paste(host, '<table><tr><th>h1</th></tr><tr><td>a</td></tr></table>');

    expect(types(editor)).toEqual(['paragraph', 'table', 'paragraph']);
    expect(texts(editor)[0]).toBe('ab');
    expect(cells(editor.getDocument().blocks[1])).toEqual([['h1'], ['a']]);
    expect(texts(editor)[2]).toBe('cd');
  });

  test('an image pasted into a non-empty paragraph keeps its source', () => {
    const editor = mount([block({ content: [{ text: 'abcd' }] })]);
    const host = hosts(editor)[0]!;

    caretTo(host, 'end');
    paste(host, '<figure><img src="https://a.test/x.png" alt="alt"></figure>');

    const after = editor.getDocument().blocks;

    expect(after.map((b) => b.type)).toEqual(['paragraph', 'image']);
    expect(after[1]?.src).toBe('https://a.test/x.png');
    expect(after[1]?.alt).toBe('alt');
  });

  test('pasting at offset 0 leaves no empty line above the paste', () => {
    const editor = mount([block({ content: [{ text: 'abcd' }] })]);
    const host = hosts(editor)[0]!;

    caretTo(host, 0);
    paste(host, '<table><tr><th>h1</th></tr></table>');

    expect(types(editor)).toEqual(['table', 'paragraph']);
    expect(texts(editor).at(-1)).toBe('abcd');
  });
});

describe('the text after the caret lands where it can be read', () => {
  test('it is not appended to a pasted divider', () => {
    const editor = mount([block({ content: [{ text: 'abcd' }] })]);
    const host = hosts(editor)[0]!;

    caretTo(host, 2);
    paste(host, '<p>one</p><hr>');

    const divider = editor.getDocument().blocks[1];

    expect(divider?.type).toBe('divider');
    expect(blockText(divider!)).toBe('');
    expect(types(editor)).toEqual(['paragraph', 'divider', 'paragraph']);
    expect(texts(editor)).toEqual(['abone', '', 'cd']);

    // The proof it was really rehoused: a divider's content is dropped on load,
    // so text parked there is gone the next time the document is opened.
    const reloaded = normalizeDocument(editor.getDocument());

    expect(reloaded.blocks.map(blockText)).toEqual(['abone', '', 'cd']);
  });

  test('it is not appended to a pasted table', () => {
    const editor = mount([block({ content: [{ text: 'abcd' }] })]);
    const host = hosts(editor)[0]!;

    caretTo(host, 2);
    paste(host, '<p>one</p><table><tr><th>h1</th></tr></table>');

    const after = editor.getDocument().blocks;

    expect(after.map((b) => b.type)).toEqual(['paragraph', 'table', 'paragraph']);
    expect(after.at(-1)).toBeDefined();
    expect(blockText(after.at(-1)!)).toBe('cd');
    // Not smuggled into the grid either.
    expect(cells(after[1])).toEqual([['h1']]);
  });

  test('a trailing list item keeps absorbing it, as before', () => {
    const editor = mount([block({ content: [{ text: 'abcd' }] })]);
    const host = hosts(editor)[0]!;

    caretTo(host, 2);
    paste(host, '<ul><li>one</li><li>two</li></ul>');

    expect(types(editor)).toEqual(['paragraph', 'bulleted_list']);
    expect(texts(editor)).toEqual(['abone', 'twocd']);
  });
});

describe('pasting into a code block inserts what was copied, not its Markdown', () => {
  /**
   * A code block is literal, so the paste path took `text/plain` in preference
   * to the parsed payload. That is only the same characters when the clipboard
   * came from somewhere with no richer form -- a terminal, a textarea. This
   * editor writes `text/plain` as `toMarkdown` output, so its own copy round
   * trip put the ``` fence lines of a copied code block into the code as
   * literal lines, and turned a copied `snake_case` into `snake\_case`:
   * characters the user never typed, in the one block type that shows them.
   */
  const intoCode = (html: string, plain: string): string => {
    const editor = mount([block({ id: 'k', type: 'code', content: [] })]);
    const host = editor.element.querySelector<HTMLElement>('.neditor-block__content')!;
    host.focus();
    paste(host, html, plain);

    return blockText(editor.getDocument().blocks[0]!);
  };

  test('a copied code block arrives without its fence', () => {
    expect(
      intoCode(
        '<pre><code>const a = 1;\nconst b = 2;</code></pre>',
        '```\nconst a = 1;\nconst b = 2;\n```',
      ),
    ).toBe('const a = 1;\nconst b = 2;');
  });

  test('a copied paragraph arrives without its escapes', () => {
    expect(intoCode('<p>use snake_case and 2 * 3</p>', 'use snake\\_case and 2 \\* 3')).toBe(
      'use snake_case and 2 * 3',
    );
  });

  /**
   * And plain text with no HTML beside it is still taken raw: there is nothing
   * better to use, and parsing it as Markdown would eat the punctuation this
   * block type exists to preserve.
   */
  test('plain text from outside is taken literally', () => {
    expect(intoCode('', 'rm -rf *.log && echo _done_')).toBe('rm -rf *.log && echo _done_');
  });
});

describe('an image pasted where an image cannot go still leaves something', () => {
  /**
   * A cell holds text, not blocks, so a pasted image had no runs to contribute
   * and the paste did nothing at all -- no content, no `change`, and no sign
   * that anything had been refused.
   */
  test('into a table cell it arrives as its caption, linked to itself', () => {
    const editor = mount([
      block({
        id: 'tbl',
        type: 'table',
        rows: [
          [[{ text: 'h0' }], [{ text: 'h1' }]],
          [[{ text: 'a' }], [{ text: 'b' }]],
        ],
      }),
    ]);
    const cell = editor.element.querySelector<HTMLElement>('[data-cell="1:0"]')!;
    cell.focus();
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(false);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    paste(
      cell,
      '<figure><img src="https://a.test/x.png" alt="A diagram"></figure>',
      '![A diagram](https://a.test/x.png)',
    );

    const text = (editor.getDocument().blocks[0]!.rows ?? [])[1]?.[0] ?? [];

    expect(text.map((run) => run.text).join('')).toContain('A diagram');
    expect(text.some((run) => run.link === 'https://a.test/x.png')).toBe(true);
  });
});
