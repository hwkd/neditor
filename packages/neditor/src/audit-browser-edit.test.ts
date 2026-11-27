// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';

import type { Block } from './index.ts';
import { blockText, blocksFromHtml, createEditor } from './index.ts';
import type { NEditor } from './editor.ts';

/**
 * The 9 Nov 2026 browser audit, text-editing paths: copy and cut of a text
 * range, paste into a code block and a list item, Backspace and Delete next to
 * a block that cannot merge text, a held key, a composed slash query, the
 * trailing-break filler, inline rules in a code run, and typing over a link.
 *
 * Each scenario is the auditor's literal input. Where happy-dom cannot observe
 * the defect -- caret geometry, an engine's own typing style -- the matching
 * case is in `apps/e2e/tests`, and the test here pins the artifact instead.
 */

const editors: NEditor[] = [];

afterEach(() => {
  while (editors.length > 0) {
    editors.pop()?.destroy();
  }

  document.body.replaceChildren();
});

let next = 0;

function block(over: Partial<Block>): Block {
  return { id: `b${(next += 1)}`, type: 'paragraph', depth: 0, content: [], ...over } as Block;
}

const text = (value: string): Block['content'] => (value ? [{ text: value }] : []);

function mount(blocks: Block[], options: Record<string, unknown> = {}): NEditor {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createEditor({ element: host, doc: { blocks }, ...options });
  editors.push(editor);

  return editor;
}

const hostOf = (editor: NEditor, id: string): HTMLElement =>
  editor.element.querySelector<HTMLElement>(`[data-block-id="${id}"] .neditor-block__content`)!;

const contentOf = (editor: NEditor, id: string): Block['content'] =>
  editor.getDocument().blocks.find((candidate) => candidate.id === id)!.content;

const outline = (editor: NEditor): string[] =>
  editor.getDocument().blocks.map((b) => `${'  '.repeat(b.depth)}${b.type}:${blockText(b)}`);

function key(target: Element, name: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', {
    key: name,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);

  return event.defaultPrevented;
}

function clipboard(target: Element, type: 'copy' | 'cut' | 'paste', data: DataTransfer): boolean {
  const event = new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true });
  target.dispatchEvent(event);

  return event.defaultPrevented;
}

function plainClipboard(plain: string): DataTransfer {
  const data = new DataTransfer();
  data.setData('text/plain', plain);

  return data;
}

/** Collapses the caret at the very end of a host's text, past any filler. */
function caretAtEndOf(host: HTMLElement): void {
  host.focus();
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let last: Node | null = null;

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    last = node;
  }

  // One call, not cleared and re-added: an empty selection is one outside
  // every block, which closes an open slash menu on its own.
  if (last) {
    getSelection()!.collapse(last, last.textContent!.length);
  } else {
    getSelection()!.collapse(host, 0);
  }
}

function input(host: HTMLElement, inputType: string, data: string | null = null): void {
  host.dispatchEvent(new InputEvent('input', { inputType, data, bubbles: true }));
}

describe('CLIP-1: a text range is copied from the model, not the rendered DOM', () => {
  const linked = (): Block[] => [
    block({
      id: 'src',
      content: [
        { text: 'See the ' },
        { text: 'docs', link: 'https://example.com/docs' },
        { text: ' for details.' },
      ],
    }),
    block({ id: 'dst', content: text('Plain paragraph') }),
  ];

  test('writes the literal characters, the runs as HTML, and the runs themselves', () => {
    const editor = mount([block({ id: 'p', content: text('Alpha one x\ny  z') })]);
    editor.focusRange('p', 6, 16);

    const data = new DataTransfer();

    expect(clipboard(hostOf(editor, 'p'), 'copy', data)).toBe(true);
    // The characters selected -- not Markdown, so nothing escaped or fenced.
    expect(data.getData('text/plain')).toBe('one x\ny  z');
    // A break other applications read under white-space: normal, and spaces
    // they keep because the phrase says it preserves them (R2-PARSE-4).
    expect(data.getData('text/html')).toBe(
      '<span style="white-space: pre-wrap;">one x<br>y  z</span>',
    );
    expect(JSON.parse(data.getData('application/x-neditor'))).toEqual({
      blocks: [{ type: 'paragraph', depth: 0, content: [{ text: 'one x\ny  z' }] }],
    });
  });

  test('a copied link pastes back as a link, with no underline mark', () => {
    const editor = mount(linked());
    editor.focusRange('src', 4, 12);
    const data = new DataTransfer();
    clipboard(hostOf(editor, 'src'), 'copy', data);

    editor.focusRange('dst', 15, 15);
    clipboard(hostOf(editor, 'dst'), 'paste', data);

    expect(contentOf(editor, 'dst')).toEqual([
      { text: 'Plain paragraphthe ' },
      { text: 'docs', link: 'https://example.com/docs' },
    ]);
  });

  test('a soft break and a double space survive the round trip', () => {
    const editor = mount([
      block({ id: 'src', content: text('Alpha one x\ny  z') }),
      block({ id: 'dst', content: text('Charlie three') }),
    ]);
    editor.focusRange('src', 6, 16);
    const data = new DataTransfer();
    clipboard(hostOf(editor, 'src'), 'copy', data);

    editor.focusRange('dst', 13, 13);
    clipboard(hostOf(editor, 'dst'), 'paste', data);

    expect(contentOf(editor, 'dst')).toEqual([{ text: 'Charlie threeone x\ny  z' }]);
  });

  test('pasted into a code block, the copied range is its characters', () => {
    const editor = mount([
      block({ id: 'src', content: [{ text: 'a ' }, { text: '*b*', marks: ['bold'] }] }),
      block({ id: 'code', type: 'code', content: text('x') }),
    ]);
    editor.focusRange('src', 0, 5);
    const data = new DataTransfer();
    clipboard(hostOf(editor, 'src'), 'copy', data);

    editor.focusRange('code', 1, 1);
    clipboard(hostOf(editor, 'code'), 'paste', data);

    expect(contentOf(editor, 'code')).toEqual([{ text: 'xa *b*' }]);
  });

  test('cut removes the range as one undo step', () => {
    const editor = mount(linked());
    editor.focusRange('src', 4, 12);
    const data = new DataTransfer();

    expect(clipboard(hostOf(editor, 'src'), 'cut', data)).toBe(true);
    expect(contentOf(editor, 'src')).toEqual([{ text: 'See  for details.' }]);
    expect(editor.getSelectionState()?.range).toEqual({ start: 4, end: 4 });
    expect(data.getData('text/plain')).toBe('the docs');

    editor.undo();

    expect(contentOf(editor, 'src')).toEqual(linked()[0]!.content);
    expect(editor.canUndo).toBe(false);
  });

  test('read-only copies the range, and a cut there deletes nothing', () => {
    const editor = mount(linked(), { editable: false });
    editor.focusRange('src', 4, 12);
    const data = new DataTransfer();
    clipboard(hostOf(editor, 'src'), 'cut', data);

    expect(data.getData('text/plain')).toBe('the docs');
    expect(contentOf(editor, 'src')).toEqual(linked()[0]!.content);
  });

  test('a collapsed caret is left to the browser', () => {
    const editor = mount(linked());
    editor.focusRange('src', 4, 4);
    const data = new DataTransfer();

    expect(clipboard(hostOf(editor, 'src'), 'copy', data)).toBe(false);
    expect(data.getData('text/plain')).toBe('');
  });

  test('a block copy still writes Markdown and its bare marker', () => {
    const editor = mount(linked());
    editor.selectBlocks(['src']);
    const data = new DataTransfer();
    clipboard(editor.element, 'copy', data);

    expect(data.getData('text/plain')).toBe(
      'See the [docs](https://example.com/docs) for details.',
    );
    expect(data.getData('application/x-neditor')).toBe('1');
  });

  test('our type from another page is untrusted: links sanitised, marks checked, ids fresh', () => {
    const editor = mount([block({ id: 'dst', content: text('x') })]);
    const data = new DataTransfer();
    data.setData('text/html', '<b>html</b>');
    data.setData(
      'application/x-neditor',
      JSON.stringify({
        blocks: [
          {
            id: 'dst',
            type: 'paragraph',
            content: [
              { text: 'bad', link: 'javascript:alert(1)', marks: ['blink', 'italic'] },
              { text: '!', link: 'https://ok.test/' },
            ],
          },
        ],
      }),
    );
    editor.focusRange('dst', 1, 1);
    clipboard(hostOf(editor, 'dst'), 'paste', data);

    expect(contentOf(editor, 'dst')).toEqual([
      { text: 'x' },
      { text: 'bad', marks: ['italic'] },
      { text: '!', link: 'https://ok.test/' },
    ]);
    expect(editor.getDocument().blocks).toHaveLength(1);
  });

  test('anything but one paragraph in our type falls back to the HTML', () => {
    const editor = mount([block({ id: 'dst', content: text('x') })]);
    const data = new DataTransfer();
    data.setData('text/html', '<b>html</b>');
    data.setData(
      'application/x-neditor',
      JSON.stringify({ blocks: [{ type: 'heading1', content: [{ text: 'no' }] }] }),
    );
    editor.focusRange('dst', 1, 1);
    clipboard(hostOf(editor, 'dst'), 'paste', data);

    expect(contentOf(editor, 'dst')).toEqual([{ text: 'x' }, { text: 'html', marks: ['bold'] }]);
  });

  test('the HTML alone reads back as the same runs', () => {
    const editor = mount([
      block({
        id: 'p',
        content: [
          { text: 'a ' },
          { text: 'bold', marks: ['bold'] },
          { text: '\nline ' },
          { text: 'docs', link: 'https://example.com/docs' },
          { text: '\n' },
        ],
      }),
    ]);
    editor.focusRange('p', 0, 17);
    const data = new DataTransfer();
    clipboard(hostOf(editor, 'p'), 'copy', data);

    expect(blocksFromHtml(document, data.getData('text/html')).map((b) => b.content)).toEqual([
      contentOf(editor, 'p'),
    ]);
  });
});

describe('CLIP-7: line endings pasted into a code block', () => {
  test('CRLF and a lone CR are one newline each', () => {
    const editor = mount([block({ id: 'code', type: 'code' })]);
    editor.focusRange('code', 0, 0);
    clipboard(hostOf(editor, 'code'), 'paste', plainClipboard('if (x) {\r\n  y();\r}'));

    expect(contentOf(editor, 'code')).toEqual([{ text: 'if (x) {\n  y();\n}' }]);
  });

  test('and when dropped', () => {
    const editor = mount([block({ id: 'code', type: 'code' })]);
    editor.focusRange('code', 0, 0);
    const event = new DragEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: plainClipboard('a\r\nb') });
    hostOf(editor, 'code').dispatchEvent(event);

    expect(contentOf(editor, 'code')).toEqual([{ text: 'a\nb' }]);
  });
});

describe('CLIP-9: plain lines pasted into a list item are more items', () => {
  const LINES = 'line one\nline two\nline three';

  test('into the middle of a bullet, as Enter makes them', () => {
    const editor = mount([
      block({ id: 'b1', type: 'bulleted_list', content: text('Bullet one') }),
      block({ id: 'b2', type: 'bulleted_list', content: text('Bullet two') }),
    ]);
    editor.focusRange('b1', 6, 6);
    clipboard(hostOf(editor, 'b1'), 'paste', plainClipboard(LINES));

    expect(outline(editor)).toEqual([
      'bulleted_list:Bulletline one',
      'bulleted_list:line two',
      'bulleted_list:line three one',
      'bulleted_list:Bullet two',
    ]);
    expect(editor.getDocument().blocks[0]!.id).toBe('b1');

    editor.undo();

    expect(outline(editor)).toEqual(['bulleted_list:Bullet one', 'bulleted_list:Bullet two']);
  });

  test('into a checked to-do, at its depth: the item keeps its check, the new ones are open', () => {
    const editor = mount([
      block({ id: 'p', content: text('parent') }),
      block({ id: 't', type: 'todo', depth: 1, checked: true, content: text('Todo two') }),
    ]);
    editor.focusRange('t', 8, 8);
    clipboard(hostOf(editor, 't'), 'paste', plainClipboard(LINES));

    expect(outline(editor)).toEqual([
      'paragraph:parent',
      '  todo:Todo twoline one',
      '  todo:line two',
      '  todo:line three',
    ]);
    expect(editor.getDocument().blocks.map((b) => b.checked)).toEqual([
      undefined,
      true,
      false,
      false,
    ]);
  });

  // Merge audit, 27 Nov: at offset 0 the new items went after the to-do, so
  // its check and id went with "line one" and the reader's text to a new,
  // open item. Enter at offset 0 puts the new item in front.
  test('at the start of a checked to-do, in front of it: it keeps its check, id and text', () => {
    const editor = mount([
      block({ id: 't', type: 'todo', depth: 0, checked: true, content: text('Todo') }),
    ]);
    editor.focusRange('t', 0, 0);
    clipboard(hostOf(editor, 't'), 'paste', plainClipboard(LINES));

    expect(outline(editor)).toEqual(['todo:line one', 'todo:line two', 'todo:line threeTodo']);
    expect(editor.getDocument().blocks.map((b) => [b.checked, b.id === 't'])).toEqual([
      [false, false],
      [false, false],
      [true, true],
    ]);

    editor.undo();

    expect(outline(editor)).toEqual(['todo:Todo']);
  });

  test('into an empty numbered item, which stays an item', () => {
    const editor = mount([block({ id: 'n', type: 'numbered_list' })]);
    editor.focusRange('n', 0, 0);
    clipboard(hostOf(editor, 'n'), 'paste', plainClipboard(LINES));

    expect(outline(editor)).toEqual([
      'numbered_list:line one',
      'numbered_list:line two',
      'numbered_list:line three',
    ]);
    expect(editor.getDocument().blocks[0]!.id).toBe('n');
  });

  test('lines with structure of their own keep it', () => {
    const editor = mount([block({ id: 'b', type: 'bulleted_list', content: text('item') })]);
    editor.focusRange('b', 4, 4);
    clipboard(hostOf(editor, 'b'), 'paste', plainClipboard('one\n# Title'));

    expect(outline(editor)).toEqual(['bulleted_list:itemone', 'heading1:Title']);
  });

  test('a paragraph is not a list item: lines pasted there stay paragraphs', () => {
    const editor = mount([block({ id: 'p', content: text('Bravo two') })]);
    editor.focusRange('p', 5, 5);
    clipboard(hostOf(editor, 'p'), 'paste', plainClipboard(LINES));

    expect(outline(editor)).toEqual([
      'paragraph:Bravoline one',
      'paragraph:line two',
      'paragraph:line three two',
    ]);
  });
});

describe('TXT-5: an empty line next to a block that cannot merge text', () => {
  const picture = { type: 'image' as const, src: '/sample.png', alt: 'pic', content: text('Head') };
  const grid = { type: 'table' as const, rows: [[[{ text: 'c' }]]] };

  test.each([
    ['an image', picture],
    ['a table', grid],
  ])('Backspace in it after %s removes it and selects the block, as one step', (_, payload) => {
    const editor = mount([
      block({ id: 'A', ...payload }),
      block({ id: 'E' }),
      block({ id: 'Z', content: text('Zed') }),
    ]);
    editor.focus('E', 0);

    expect(key(hostOf(editor, 'E'), 'Backspace')).toBe(true);
    expect(editor.getDocument().blocks.map((b) => b.id)).toEqual(['A', 'Z']);
    expect(editor.getSelectedBlocks()).toEqual(['A']);

    editor.undo();

    expect(editor.getDocument().blocks.map((b) => b.id)).toEqual(['A', 'E', 'Z']);
    expect(editor.canUndo).toBe(false);
    expect(editor.getSelectionState()?.blockId).toBe('E');
  });

  test('Delete in it before an image removes it and selects the image', () => {
    const editor = mount([
      block({ id: 'Z', content: text('Zed') }),
      block({ id: 'E' }),
      block({ id: 'A', ...picture }),
    ]);
    editor.focus('E', 0);

    expect(key(hostOf(editor, 'E'), 'Delete')).toBe(true);
    expect(editor.getDocument().blocks.map((b) => b.id)).toEqual(['Z', 'A']);
    expect(editor.getSelectedBlocks()).toEqual(['A']);
    expect(editor.getDocument().blocks[1]).toMatchObject({ src: '/sample.png' });
  });

  test('a line with text is kept, and only the block is selected', () => {
    const editor = mount([block({ id: 'A', ...picture }), block({ id: 'B', content: text('b') })]);
    editor.focus('B', 0);
    key(hostOf(editor, 'B'), 'Backspace');

    expect(editor.getDocument().blocks.map((b) => b.id)).toEqual(['A', 'B']);
    expect(editor.getSelectedBlocks()).toEqual(['A']);
  });

  test('an image with an empty caption is a picture, not an empty line', () => {
    const editor = mount([
      block({ id: 'I', type: 'image', src: '/sample.png', alt: '' }),
      block({ id: 'T', ...grid }),
    ]);
    editor.focus('I', 0);
    key(hostOf(editor, 'I'), 'Delete');

    expect(editor.getDocument().blocks.map((b) => b.id)).toEqual(['I', 'T']);
    expect(editor.getSelectedBlocks()).toEqual(['T']);
  });
});

describe('TXT-6: a held Backspace stops at the block it selected', () => {
  test('auto-repeat does not delete the image a press selected; a new press does', () => {
    const editor = mount([
      block({ id: 'A', content: text('top') }),
      block({ id: 'I', type: 'image', src: '/sample.png', alt: 'p', content: text('cap') }),
      block({ id: 'D', content: text('ab') }),
    ]);
    // `ab` was emptied by the first repeats -- native deletions -- and the
    // next repeat reached the start of the block.
    editor.focus('D', 0);
    key(hostOf(editor, 'D'), 'Backspace', { repeat: true });

    expect(editor.getSelectedBlocks()).toEqual(['I']);

    for (let index = 0; index < 4; index += 1) {
      expect(key(editor.element, 'Backspace', { repeat: true })).toBe(true);
    }

    expect(outline(editor)).toEqual(['paragraph:top', 'image:cap', 'paragraph:ab']);

    key(editor.element, 'Backspace');

    expect(outline(editor)).toEqual(['paragraph:top', 'paragraph:ab']);
  });

  test('Delete held into a table, the same', () => {
    const editor = mount([
      block({ id: 'D', content: text('ab') }),
      block({ id: 'T', type: 'table', rows: [[[{ text: 'c' }]]] }),
    ]);
    editor.focus('D', 2);
    key(hostOf(editor, 'D'), 'Delete');
    key(editor.element, 'Delete', { repeat: true });

    expect(editor.getDocument().blocks.map((b) => b.id)).toEqual(['D', 'T']);
  });

  test('a block selected some other way still deletes on a repeat', () => {
    const editor = mount([block({ id: 'A', content: text('a') }), block({ id: 'B' })]);
    editor.selectBlocks(['A']);
    key(editor.element, 'Backspace', { repeat: true });

    expect(editor.getDocument().blocks.map((b) => b.id)).toEqual(['B']);
  });
});

describe('TXT-7: a slash query composed through an IME', () => {
  test('narrows the menu when the composition ends', () => {
    const editor = mount([block({ id: 'X', content: text('Some words ') })]);
    const host = hostOf(editor, 'X');
    caretAtEndOf(host);
    host.append(document.createTextNode('/'));
    caretAtEndOf(host);
    input(host, 'insertText', '/');

    const options = (): number =>
      document.querySelector<HTMLElement>('.neditor-slash-menu')?.hidden === false
        ? document.querySelectorAll('[role="option"]').length
        : 0;

    expect(options()).toBeGreaterThan(1);

    host.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    host.append(document.createTextNode('quo'));
    caretAtEndOf(host);
    input(host, 'insertCompositionText', 'quo');

    expect(options()).toBeGreaterThan(1);

    host.dispatchEvent(new CompositionEvent('compositionend', { data: 'quo', bubbles: true }));

    expect(options()).toBe(1);
    expect(document.querySelector('[role="option"]')?.textContent).toContain('Quote');
  });

  test('a composed query that matches nothing closes it, and Enter does not retype the block', () => {
    const editor = mount([block({ id: 'X', content: text('Some words ') })]);
    const host = hostOf(editor, 'X');
    caretAtEndOf(host);
    host.append(document.createTextNode('/'));
    caretAtEndOf(host);
    input(host, 'insertText', '/');

    host.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    host.append(document.createTextNode('引用'));
    caretAtEndOf(host);
    input(host, 'insertCompositionText', '引用');
    host.dispatchEvent(new CompositionEvent('compositionend', { data: '引用', bubbles: true }));

    expect(document.querySelector<HTMLElement>('.neditor-slash-menu')?.hidden).toBe(true);

    key(host, 'Enter');

    expect(outline(editor)[0]).toBe('paragraph:Some words /引用');
  });
});

describe('TXT-8: a deletion that leaves a trailing newline keeps its filler', () => {
  // happy-dom lays nothing out, so the missing line box cannot be seen here;
  // what is pinned is the artifact that gives it one. The caret is checked in
  // Firefox in `apps/e2e/tests/typing.spec.ts`.
  test('the <br> goes back after the text, and the caret stays put', () => {
    const editor = mount([block({ id: 'X', content: text('line one\nword') })]);
    const host = hostOf(editor, 'X');
    // What Firefox leaves after Alt+Backspace: the word and the filler gone.
    host.replaceChildren(document.createTextNode('line one\n'));
    caretAtEndOf(host);
    input(host, 'deleteWordBackward');

    expect(contentOf(editor, 'X')).toEqual([{ text: 'line one\n' }]);
    expect(host.lastChild?.nodeName).toBe('BR');
    expect(host.childNodes).toHaveLength(2);
    expect(getSelection()?.anchorNode).toBe(host.firstChild);
    expect(getSelection()?.anchorOffset).toBe(9);
    expect(editor.getSelectionState()?.range).toEqual({ start: 9, end: 9 });
  });

  test('a filler that survived is not doubled', () => {
    const editor = mount([block({ id: 'X', content: text('line one\nx') })]);
    const host = hostOf(editor, 'X');
    host.replaceChildren(document.createTextNode('line one\n'), document.createElement('br'));
    caretAtEndOf(host);
    input(host, 'deleteContentBackward');

    expect(host.querySelectorAll('br')).toHaveLength(1);
  });
});

describe('TXT-9 and MRG-3: a character typed into a code run closes nothing', () => {
  test('`*` typed at the end of a code run `a*b` stays in it', () => {
    const editor = mount([block({ id: 'X', content: [{ text: 'a*b', marks: ['code'] }] })]);
    const host = hostOf(editor, 'X');
    host.querySelector('code')!.firstChild!.textContent = 'a*b*';
    caretAtEndOf(host);
    input(host, 'insertText', '*');

    expect(contentOf(editor, 'X')).toEqual([{ text: 'a*b*', marks: ['code'] }]);
  });

  test('a backtick typed into ``a`b`` in code keeps both backticks', () => {
    // MRG-3's literal sequence: `Use a`b`, the last three selected and made
    // code, then ` and `` typed -- which every engine puts in the code run.
    const editor = mount([
      block({ id: 'X', content: [{ text: 'Use ' }, { text: 'a`b', marks: ['code'] }] }),
    ]);
    const host = hostOf(editor, 'X');
    const code = host.querySelector('code')!;

    for (const char of ' and `c` ok') {
      code.firstChild!.textContent += char;
      caretAtEndOf(host);
      input(host, 'insertText', char);
    }

    expect(contentOf(editor, 'X')).toEqual([
      { text: 'Use ' },
      { text: 'a`b and `c` ok', marks: ['code'] },
    ]);
  });

  test('a span typed in plain text around a code run still applies', () => {
    const editor = mount([
      block({
        id: 'X',
        content: [{ text: '*a ' }, { text: 'x', marks: ['code'] }, { text: ' b' }],
      }),
    ]);
    const host = hostOf(editor, 'X');
    host.append(document.createTextNode('*'));
    caretAtEndOf(host);
    input(host, 'insertText', '*');

    expect(contentOf(editor, 'X')).toEqual([
      { text: 'a ', marks: ['italic'] },
      { text: 'x', marks: ['italic', 'code'] },
      { text: ' b', marks: ['italic'] },
    ]);
  });
});

describe('TXT-10: typing over a selection is written model-first', () => {
  function beforeInput(host: HTMLElement, data: string): boolean {
    const event = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data,
      bubbles: true,
      cancelable: true,
    });
    host.dispatchEvent(event);

    return event.defaultPrevented;
  }

  const linked = (): Block =>
    block({
      id: 'X',
      content: [{ text: 'see ' }, { text: 'docs', link: 'https://e.com/' }, { text: ' end' }],
    });

  test('the text typed over a whole link stays the link, as one undo step', () => {
    const editor = mount([linked()]);
    editor.focusRange('X', 4, 8);

    for (const char of 'XYZ') {
      expect(beforeInput(hostOf(editor, 'X'), char)).toBe(true);
    }

    expect(contentOf(editor, 'X')).toEqual([
      { text: 'see ' },
      { text: 'XYZ', link: 'https://e.com/' },
      { text: ' end' },
    ]);
    expect(editor.getSelectionState()?.range).toEqual({ start: 7, end: 7 });

    editor.undo();

    expect(contentOf(editor, 'X')).toEqual(linked().content);
    expect(editor.canUndo).toBe(false);
  });

  test('the replacement takes the first replaced character’s marks', () => {
    const editor = mount([
      block({
        id: 'X',
        content: [
          { text: 'ab', marks: ['bold'] },
          { text: 'cd', marks: ['italic'] },
        ],
      }),
    ]);
    editor.focusRange('X', 1, 3);
    beforeInput(hostOf(editor, 'X'), 'Q');

    expect(contentOf(editor, 'X')).toEqual([
      { text: 'aQ', marks: ['bold'] },
      { text: 'd', marks: ['italic'] },
    ]);
  });

  test('an edit by any other path ends the continuation', () => {
    const editor = mount([linked()]);
    editor.focusRange('X', 4, 8);
    beforeInput(hostOf(editor, 'X'), 'X');

    const host = hostOf(editor, 'X');
    host.append(document.createTextNode('!'));
    caretAtEndOf(host);
    input(host, 'insertText', '!');
    editor.focusRange('X', 5, 5);

    expect(beforeInput(hostOf(editor, 'X'), 'Z')).toBe(false);
  });

  test('a collapsed caret is left to the browser', () => {
    const editor = mount([linked()]);
    editor.focusRange('X', 2, 2);

    expect(beforeInput(hostOf(editor, 'X'), 'q')).toBe(false);
  });

  test('typed-over text still runs the shortcuts', () => {
    const editor = mount([block({ id: 'X', content: text('*abx') })]);
    editor.focusRange('X', 3, 4);
    beforeInput(hostOf(editor, 'X'), '*');

    expect(contentOf(editor, 'X')).toEqual([{ text: 'ab', marks: ['italic'] }]);
  });
});

/**
 * Round 2 of the same audit. Text typed over a link's whole text keeps going
 * into the link -- Google Docs does the same -- but only for the next character
 * typed at the same caret. Everything else ends it.
 */
describe('R2-EDIT-1/2: a link continuation ends on anything but the next character', () => {
  function beforeInput(host: HTMLElement, data: string): boolean {
    const event = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data,
      bubbles: true,
      cancelable: true,
    });
    host.dispatchEvent(event);

    return event.defaultPrevented;
  }

  const LINK = 'https://example.com/docs';
  const linked = (): Block[] => [
    block({
      id: 'p1',
      content: [{ text: 'See the ' }, { text: 'docs', link: LINK }, { text: ' for details.' }],
    }),
    block({ id: 'p2', content: text('Another paragraph') }),
  ];

  /** Selects "docs" and types `XY` over it, leaving the caret at offset 10. */
  function typedOver(): NEditor {
    const editor = mount(linked());
    editor.focusRange('p1', 8, 12);

    for (const char of 'XY') {
      beforeInput(hostOf(editor, 'p1'), char);
    }

    expect(contentOf(editor, 'p1')).toEqual([
      { text: 'See the ' },
      { text: 'XY', link: LINK },
      { text: ' for details.' },
    ]);

    return editor;
  }

  const selectionChanged = (): void => {
    document.dispatchEvent(new Event('selectionchange'));
  };

  test('it does continue at the same caret', () => {
    const editor = typedOver();
    selectionChanged();

    expect(beforeInput(hostOf(editor, 'p1'), 'Z')).toBe(true);
    expect(contentOf(editor, 'p1')[1]).toEqual({ text: 'XYZ', link: LINK });
  });

  test('Mod+B ends it, so the armed bold is what the next characters get', () => {
    // R2-EDIT-1: bold was shown active and the text went into the link plain.
    const editor = typedOver();
    key(hostOf(editor, 'p1'), 'b', { metaKey: true });

    expect(editor.getSelectionState()?.marks).toEqual(['bold']);

    // The armed mark writes the first character; the browser carries it on
    // from there, as it does after any bold run (e2e: `typing.spec.ts` T15b).
    expect(beforeInput(hostOf(editor, 'p1'), 'b')).toBe(true);

    // What the same keys give at a link's end with no type-over before them.
    expect(contentOf(editor, 'p1')).toEqual([
      { text: 'See the ' },
      { text: 'XY', link: LINK },
      { text: 'b', marks: ['bold'] },
      { text: ' for details.' },
    ]);
  });

  test('a caret moved to another block and back ends it', () => {
    // R2-EDIT-2, the literal case: click p2, click back at offset 10, type Q.
    const editor = typedOver();
    editor.focusRange('p2', 3, 3);
    selectionChanged();
    editor.focusRange('p1', 10, 10);
    selectionChanged();

    expect(editor.getSelectionState()?.link).toBeNull();
    expect(beforeInput(hostOf(editor, 'p1'), 'Q')).toBe(false);
  });

  test('a caret moved within the block and back ends it', () => {
    const editor = typedOver();
    editor.focusRange('p1', 9, 9);
    selectionChanged();
    editor.focusRange('p1', 10, 10);
    selectionChanged();

    expect(beforeInput(hostOf(editor, 'p1'), 'Q')).toBe(false);
  });

  test('a caret key ends it, even one that comes back to the same offset', () => {
    // R2-EDIT-2 (D): ← then →. happy-dom moves no caret on a keydown, so the
    // caret really is back at offset 10 here and only the keys can end it.
    const editor = typedOver();
    key(hostOf(editor, 'p1'), 'ArrowLeft');
    key(hostOf(editor, 'p1'), 'ArrowRight');

    expect(beforeInput(hostOf(editor, 'p1'), 'Q')).toBe(false);
  });

  test('Escape ends it', () => {
    const editor = typedOver();
    asTheBrowserReportsIt(() => {
      // Into block selection, then straight back to the same caret.
      key(hostOf(editor, 'p1'), 'Escape');
      editor.focusRange('p1', 10, 10);
    });

    expect(beforeInput(hostOf(editor, 'p1'), 'Q')).toBe(false);
  });

  test('a click ends it, even at the same offset', () => {
    const editor = typedOver();
    hostOf(editor, 'p1').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(beforeInput(hostOf(editor, 'p1'), 'Q')).toBe(false);
  });

  /**
   * Runs `step` the way a browser reports it. happy-dom dispatches
   * `selectionchange` synchronously for every intermediate range a caret
   * placement passes through -- including an empty one -- so any placement
   * ends the continuation on its own and hides whether `step` did. A browser
   * queues the event and the handler reads the live caret, which is back at
   * offset 10 here; that is the one dispatch let through.
   */
  function asTheBrowserReportsIt(step: () => void): void {
    const swallow = (event: Event): void => event.stopImmediatePropagation();
    document.addEventListener('selectionchange', swallow, { capture: true });

    try {
      step();
    } finally {
      document.removeEventListener('selectionchange', swallow, { capture: true });
    }

    selectionChanged();
  }

  test('a blur ends it', () => {
    const editor = typedOver();
    asTheBrowserReportsIt(() => {
      hostOf(editor, 'p1').dispatchEvent(
        new FocusEvent('focusout', { bubbles: true, relatedTarget: null }),
      );
      editor.focusRange('p1', 10, 10);
    });

    expect(beforeInput(hostOf(editor, 'p1'), 'Q')).toBe(false);
  });

  test('undo and redo end it, though redo puts back the very same text', () => {
    const editor = typedOver();
    asTheBrowserReportsIt(() => {
      editor.undo();
      editor.redo();
    });

    expect(editor.getSelectionState()?.range).toEqual({ start: 10, end: 10 });
    expect(beforeInput(hostOf(editor, 'p1'), 'Q')).toBe(false);
  });

  test('a trip through read-only ends it', () => {
    const editor = typedOver();
    asTheBrowserReportsIt(() => {
      editor.setEditable(false);
      editor.setEditable(true);
      editor.focusRange('p1', 10, 10);
    });

    expect(beforeInput(hostOf(editor, 'p1'), 'Q')).toBe(false);
  });

  test('the harness itself lets a continuation through', () => {
    // The control for the three above: the same placement, nothing else.
    const editor = typedOver();
    asTheBrowserReportsIt(() => {
      editor.focusRange('p1', 10, 10);
    });

    expect(beforeInput(hostOf(editor, 'p1'), 'Q')).toBe(true);
  });
});

describe('R2-EDIT-5: a composition over a link keeps the link', () => {
  const LINK = 'https://example.com/docs';
  const linked = (): Block[] => [
    block({
      id: 'p1',
      content: [{ text: 'See the ' }, { text: 'docs', link: LINK }, { text: ' for details.' }],
    }),
  ];

  function caretAt(host: HTMLElement, offset: number): void {
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let remaining = offset;

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent!.length;

      if (remaining <= length) {
        getSelection()!.collapse(node, remaining);
        return;
      }

      remaining -= length;
    }
  }

  function beforeInput(host: HTMLElement, data: string): boolean {
    const event = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data,
      bubbles: true,
      cancelable: true,
    });
    host.dispatchEvent(event);

    return event.defaultPrevented;
  }

  /**
   * A composition as the browser runs it, with the candidate written into the
   * host where the engine puts it. happy-dom has no IME; Chromium's own is
   * driven in `apps/e2e/tests/ime.spec.ts`.
   */
  function compose(host: HTMLElement, html: string, caret: number, data: string): void {
    host.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    host.innerHTML = html;
    caretAt(host, caret);
    input(host, 'insertCompositionText', data);
    host.dispatchEvent(new CompositionEvent('compositionend', { data, bubbles: true }));
  }

  test('a word composed over the link’s whole text is the link, as one undo step', () => {
    const editor = mount(linked());
    editor.focusRange('p1', 8, 12);
    // Chromium drops the anchor along with the text it held.
    compose(hostOf(editor, 'p1'), 'See the 日本 for details.', 10, '日本');

    expect(contentOf(editor, 'p1')).toEqual([
      { text: 'See the ' },
      { text: '日本', link: LINK },
      { text: ' for details.' },
    ]);
    expect(editor.getSelectionState()?.range).toEqual({ start: 10, end: 10 });

    // The candidate is the next character at the same caret, so Latin keys
    // typed after it go on into the link, as they do after a typed-over word.
    expect(beforeInput(hostOf(editor, 'p1'), 'a')).toBe(true);
    expect(contentOf(editor, 'p1')[1]).toEqual({ text: '日本a', link: LINK });

    editor.undo();

    expect(contentOf(editor, 'p1')).toEqual(linked()[0]!.content);
    expect(editor.canUndo).toBe(false);
  });

  test('a word composed after typing over the link joins it, and so does what follows', () => {
    const editor = mount(linked());
    editor.focusRange('p1', 8, 12);
    beforeInput(hostOf(editor, 'p1'), 'X');
    // Every engine composes outside the anchor at its end.
    compose(hostOf(editor, 'p1'), `See the <a href="${LINK}">X</a>日 for details.`, 10, '日');

    expect(contentOf(editor, 'p1')).toEqual([
      { text: 'See the ' },
      { text: 'X日', link: LINK },
      { text: ' for details.' },
    ]);
    expect(beforeInput(hostOf(editor, 'p1'), 'Z')).toBe(true);
    expect(contentOf(editor, 'p1')[1]).toEqual({ text: 'X日Z', link: LINK });
  });

  test('a word composed at a link’s end with no type-over before it is the browser’s', () => {
    const editor = mount(linked());
    editor.focusRange('p1', 12, 12);
    compose(hostOf(editor, 'p1'), `See the <a href="${LINK}">docs</a>日 for details.`, 13, '日');

    expect(contentOf(editor, 'p1')).toEqual([
      { text: 'See the ' },
      { text: 'docs', link: LINK },
      { text: '日 for details.' },
    ]);
  });
});
