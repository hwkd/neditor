// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';

import type { Block } from './index.ts';
import { blockText, createEditor } from './index.ts';
import type { NEditor } from './editor.ts';

/**
 * Input the editor did not author.
 *
 * Two rules meet here. The first is that content from outside the editor —
 * dropped or pasted — only ever enters through the parser, so the browser
 * never writes foreign markup into a live editing host. The second is that the
 * Markdown shortcuts read the text before the caret as something the user just
 * typed, which is only true when the input event actually inserted something.
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

function caretTo(host: HTMLElement, offset: 0 | 'end'): void {
  host.focus();
  const range = document.createRange();
  range.selectNodeContents(host);
  range.collapse(offset !== 'end');

  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** A native drag landing on `target`. Returns the event, to read its default. */
function drop(target: EventTarget, html: string, plain = ''): DragEvent {
  const data = new DataTransfer();
  data.setData('text/html', html);
  data.setData('text/plain', plain);

  const event = new DragEvent('drop', { bubbles: true, cancelable: true });
  // happy-dom drops `dataTransfer` from the event init, so it is attached the
  // way a real drag delivers it.
  Object.defineProperty(event, 'dataTransfer', { value: data });
  target.dispatchEvent(event);

  return event;
}

/**
 * Rewrites the host the way the browser would have, then reports the edit.
 *
 * The caret is collapsed in one call rather than cleared and re-added: an
 * empty selection is a selection *outside* every block, which closes the slash
 * menu on its own and would hide whether the input path ever reached it.
 */
function inputTo(host: HTMLElement, text: string, inputType: string): void {
  host.textContent = text;
  host.focus();

  const node = host.firstChild ?? host;
  getSelection()?.collapse(node, node === host ? 0 : text.length);
  host.dispatchEvent(new InputEvent('input', { inputType, bubbles: true }));
}

const slashMenuOpen = (): boolean =>
  document.querySelector<HTMLElement>('.neditor-slash-menu')?.hidden === false;

const slashOptionCount = (): number => document.querySelectorAll('[role="option"]').length;

describe('a drop from outside the editor', () => {
  const HOSTILE =
    '<iframe src="https://evil.test/x"></iframe>' +
    '<form action="https://evil.test/steal"><input type="password" name="p"></form>';

  test('is cancelled, so the browser never writes the dragged markup', () => {
    const editor = mount([block({ content: [{ text: 'hello' }] })]);
    const host = hosts(editor)[0]!;
    caretTo(host, 'end');

    const event = drop(host, HOSTILE);

    // The whole defence: the default action *is* the injection. Letting it
    // stand puts an iframe in a live host, and #syncFromDom then reads it back
    // as the block's own content, so no later render takes it out again.
    expect(event.defaultPrevented).toBe(true);
    expect(editor.element.querySelector('iframe')).toBe(null);
    expect(editor.element.querySelector('form')).toBe(null);
    expect(editor.element.querySelector('input')).toBe(null);
    expect(JSON.stringify(editor.getDocument())).not.toContain('evil.test');
  });

  test('is cancelled even where no block can be resolved', () => {
    const editor = mount([block({ content: [{ text: 'hello' }] })]);

    // The gutter, the padding around the blocks, the root itself: a drop we
    // cannot place is a drop to refuse, not one to hand back to the browser.
    const event = drop(editor.element, HOSTILE);

    expect(event.defaultPrevented).toBe(true);
    expect(blockText(editor.getDocument().blocks[0]!)).toBe('hello');
  });

  test('is cancelled on a read-only editor', () => {
    const editor = mount([block({ content: [{ text: 'hello' }] })], { editable: false });
    const host = hosts(editor)[0]!;

    const event = drop(host, HOSTILE);

    expect(event.defaultPrevented).toBe(true);
    expect(blockText(editor.getDocument().blocks[0]!)).toBe('hello');
  });

  test('enters through the parser, keeping marks and dropping markup', () => {
    const editor = mount([block({})]);
    const host = hosts(editor)[0]!;
    caretTo(host, 0);

    drop(host, '<p><strong>bold</strong> text</p>');

    const content = editor.getDocument().blocks[0]!.content;

    expect(blockText(editor.getDocument().blocks[0]!)).toBe('bold text');
    expect(content[0]?.marks).toEqual(['bold']);
  });

  test('splits into blocks the same way a paste does', () => {
    const editor = mount([block({})]);
    const host = hosts(editor)[0]!;
    caretTo(host, 0);

    drop(host, '<h1>Title</h1><p>body</p>');

    const types = editor.getDocument().blocks.map((each) => each.type);

    expect(types).toContain('heading1');
    expect(editor.getDocument().blocks.map(blockText).join('|')).toContain('Title');
  });

  test('stops arriving once the editor is destroyed', () => {
    const editor = mount([block({ content: [{ text: 'hello' }] })]);
    const host = hosts(editor)[0]!;
    editors.pop();
    editor.destroy();

    expect(drop(host, HOSTILE).defaultPrevented).toBe(false);
  });
});

describe('a drop lands where the pointer let go', () => {
  const HOSTILE =
    '<iframe src="https://evil.test/x"></iframe>' +
    '<script>alert(1)</script>' +
    '<a href="javascript:alert(1)">go</a>' +
    '<p>tail</p>';

  const DROP_X = 10;
  const DROP_Y = 20;

  type CaretApi = 'caretPositionFromPoint' | 'caretRangeFromPoint';

  interface CaretPoint {
    node: Node;
    offset: number;
  }

  const textOf = (host: HTMLElement): Node => host.firstChild ?? host;

  function selectIn(host: HTMLElement, start: number, end: number): void {
    const range = document.createRange();
    range.setStart(textOf(host), start);
    range.setEnd(textOf(host), end);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    host.focus();
  }

  /**
   * A drop that lands at a real place on screen.
   *
   * happy-dom gives a `DragEvent` no client coordinates and the document
   * neither spelling of "which caret is at (x, y)", so both halves of what a
   * browser delivers are stood in for: the drop happens at (DROP_X, DROP_Y),
   * and the engine answers that one point with `caret`. Only that point, so a
   * handler reading the wrong coordinates gets nothing; and restored after the
   * dispatch, so nothing else inherits a caret API that is not really there.
   */
  function dropAt(
    target: EventTarget,
    caret: CaretPoint | null,
    html: string,
    api: CaretApi = 'caretPositionFromPoint',
  ): DragEvent {
    const data = new DataTransfer();
    data.setData('text/html', html);

    const event = new DragEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: data });
    Object.defineProperty(event, 'clientX', { value: DROP_X });
    Object.defineProperty(event, 'clientY', { value: DROP_Y });

    const answer = (x: number, y: number): unknown => {
      if (!caret || x !== DROP_X || y !== DROP_Y) {
        return null;
      }

      if (api === 'caretPositionFromPoint') {
        return { offsetNode: caret.node, offset: caret.offset };
      }

      const range = document.createRange();
      range.setStart(caret.node, caret.offset);
      range.collapse(true);

      return range;
    };

    Object.defineProperty(document, api, { configurable: true, value: answer });

    try {
      target.dispatchEvent(event);
    } finally {
      Reflect.deleteProperty(document, api);
    }

    return event;
  }

  test.each<CaretApi>(['caretPositionFromPoint', 'caretRangeFromPoint'])(
    'through %s, at the pointer rather than at the caret left behind',
    (api: CaretApi) => {
      const editor = mount([
        block({ content: [{ text: 'first' }] }),
        block({ content: [{ text: 'second' }] }),
      ]);
      const [from, into] = hosts(editor);
      caretTo(from!, 'end');

      dropAt(into!, { node: textOf(into!), offset: 3 }, '<p>XX</p>', api);

      const blocks = editor.getDocument().blocks;

      // Cancelling the native insertion costs the caret the browser would have
      // placed. Taking none from the coordinates instead left the drop reading
      // a selection from before the drag: the payload appeared in a block the
      // user never pointed at, or at offset 0 of the one they did.
      expect(blockText(blocks[0]!)).toBe('first');
      expect(blockText(blocks[1]!)).toBe('secXXond');
    },
  );

  test('does not swallow the text selected in the block it lands in', () => {
    const editor = mount([block({ content: [{ text: 'second' }] })]);
    const host = hosts(editor)[0]!;
    selectIn(host, 0, 6);

    dropAt(host, { node: textOf(host), offset: 3 }, '<p>XX</p>');

    // A drop inserts; it never replaces. Reading the range out of the stale
    // selection handed the whole block to `richDelete` first, so dropping onto
    // a paragraph you had selected destroyed it.
    expect(blockText(editor.getDocument().blocks[0]!)).toBe('secXXond');
  });

  test('collapses the selection even where no caret can be had from the point', () => {
    const editor = mount([block({ content: [{ text: 'second' }] })]);
    const host = hosts(editor)[0]!;
    selectIn(host, 0, 6);

    // The plain helper: no coordinates on the event, no caret API on the
    // document. An engine that can answer neither still must not let a drop
    // turn into a replacement.
    drop(host, '<p>XX</p>');

    expect(blockText(editor.getDocument().blocks[0]!)).toBe('XXsecond');
  });

  test('still enters only through the parser once it has a point', () => {
    const editor = mount([block({ content: [{ text: 'second' }] })]);
    const host = hosts(editor)[0]!;

    const event = dropAt(host, { node: textOf(host), offset: 3 }, HOSTILE);

    // Placing the caret is a new step in front of the parse, not a way round
    // it: the payload still becomes blocks, and the markup still never lands.
    expect(event.defaultPrevented).toBe(true);
    expect(editor.element.querySelector('iframe')).toBe(null);
    expect(editor.element.querySelector('script')).toBe(null);
    expect(editor.element.innerHTML).not.toContain('javascript:');
    expect(JSON.stringify(editor.getDocument())).not.toContain('javascript:');
    expect(JSON.stringify(editor.getDocument())).not.toContain('evil.test');
  });
});

describe('beforeinput carrying content the editor never parsed', () => {
  function beforeInput(host: HTMLElement, inputType: string): boolean {
    const event = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true });
    host.dispatchEvent(event);

    return event.defaultPrevented;
  }

  test.each(['insertFromDrop', 'insertFromPaste', 'insertFromPasteAsQuotation', 'insertHTML'])(
    '%s is refused',
    (inputType: string) => {
      const editor = mount([block({ content: [{ text: 'hello' }] })]);
      const host = hosts(editor)[0]!;
      caretTo(host, 'end');

      expect(beforeInput(host, inputType)).toBe(true);
    },
  );

  test('a spellcheck correction is not refused', () => {
    const editor = mount([block({ content: [{ text: 'teh' }] })]);
    const host = hosts(editor)[0]!;
    caretTo(host, 'end');

    // insertReplacementText is the spellchecker fixing a word the document
    // already held. Refusing it would break spellcheck to close a hole it is
    // not part of.
    expect(beforeInput(host, 'insertReplacementText')).toBe(false);
  });
});

describe('Markdown shortcuts fire on insertion only', () => {
  test('deleting the word after a "# " leaves a paragraph holding the prefix', () => {
    const editor = mount([block({ content: [{ text: '# x' }] })]);
    const host = hosts(editor)[0]!;

    inputTo(host, '# ', 'deleteContentBackward');

    const first = editor.getDocument().blocks[0]!;

    expect(first.type).toBe('paragraph');
    expect(blockText(first)).toBe('# ');
  });

  test('deleting the character after "**bold**" applies no mark', () => {
    const editor = mount([block({ content: [{ text: '**bold**x' }] })]);
    const host = hosts(editor)[0]!;

    inputTo(host, '**bold**', 'deleteContentBackward');

    const first = editor.getDocument().blocks[0]!;

    expect(blockText(first)).toBe('**bold**');
    expect(first.content.some((run) => (run.marks?.length ?? 0) > 0)).toBe(false);
  });

  test('deleting the character after a "/" does not open the slash menu', () => {
    const editor = mount([block({ content: [{ text: '/x' }] })]);
    const host = hosts(editor)[0]!;

    inputTo(host, '/', 'deleteContentBackward');

    expect(slashMenuOpen()).toBe(false);
  });

  test('typing the space that completes "# " still makes a heading', () => {
    const editor = mount([block({ content: [{ text: '#' }] })]);
    const host = hosts(editor)[0]!;

    inputTo(host, '# ', 'insertText');

    expect(editor.getDocument().blocks[0]!.type).toBe('heading1');
  });

  test('typing "**bold**" still applies the mark', () => {
    const editor = mount([block({ content: [{ text: '**bold*' }] })]);
    const host = hosts(editor)[0]!;

    inputTo(host, '**bold**', 'insertText');

    const first = editor.getDocument().blocks[0]!;

    expect(blockText(first)).toBe('bold');
    expect(first.content[0]?.marks).toEqual(['bold']);
  });

  test('an open slash menu still tracks the query through a deletion', () => {
    const editor = mount([block({})]);
    const host = hosts(editor)[0]!;

    inputTo(host, '/', 'insertText');
    expect(slashMenuOpen()).toBe(true);

    const all = slashOptionCount();

    inputTo(host, '/he', 'insertText');
    expect(slashOptionCount()).toBeLessThan(all);

    // The menu reads the text rather than acting on it, so it is the one thing
    // here a deletion must still reach. Without it the query would stay stuck
    // at "he", and deleting the "/" would leave the menu open over a block
    // that no longer has one.
    inputTo(host, '/', 'deleteContentBackward');
    expect(slashOptionCount()).toBe(all);

    inputTo(host, '', 'deleteContentBackward');
    expect(slashMenuOpen()).toBe(false);
  });
});

describe('a drop that carries nothing', () => {
  function select(host: HTMLElement, start: number, end: number): void {
    host.focus();
    const range = document.createRange();
    const text = host.firstChild ?? host;
    range.setStart(text, start);
    range.setEnd(text, end);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function drop(host: HTMLElement, entries: Record<string, string>): void {
    const data = new DataTransfer();
    for (const [type, value] of Object.entries(entries)) {
      data.setData(type, value);
    }
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: data, configurable: true });
    Object.defineProperty(event, 'clientX', { value: 5, configurable: true });
    Object.defineProperty(event, 'clientY', { value: 5, configurable: true });
    host.dispatchEvent(event);
  }

  test('leaves the selection alone when there is no payload', () => {
    const editor = mount([block({ content: [{ text: 'abcdef' }] })]);
    const host = editor.element.querySelector<HTMLElement>('.neditor-block__content')!;
    select(host, 0, 6);

    // A file drag carries only `Files`: nothing is inserted, so nothing should
    // be lost either. Placing the caret first collapsed the selection.
    drop(host, {});

    expect(document.getSelection()?.isCollapsed).toBe(false);
    expect(editor.getDocument().blocks[0]?.content[0]?.text).toBe('abcdef');
  });

  test.each([
    ['a dragged blank line', { 'text/html': '<div><br></div>', 'text/plain': '\n' }],
    [
      'the same wrapped as Chrome sends it',
      { 'text/html': "<meta charset='utf-8'><div><br></div>", 'text/plain': '\n' },
    ],
    ['an empty paragraph', { 'text/html': '<p></p>' }],
    ['whitespace only', { 'text/plain': '   ' }],
    ['a comment', { 'text/html': '<!-- nothing -->' }],
    [
      'markup that is all dropped by the sanitizer',
      { 'text/html': '<script>x</script><style>p{}</style>' },
    ],
  ])('leaves the selection alone for %s', (_label, payload) => {
    const editor = mount([block({ content: [{ text: 'abcdef' }] })]);
    const host = editor.element.querySelector<HTMLElement>('.neditor-block__content')!;
    select(host, 0, 6);

    // Non-empty, but it parses to nothing. Guarding on the payload's LENGTH
    // caught only the empty-string case and still threw the selection away for
    // every one of these.
    drop(host, payload);

    expect(document.getSelection()?.isCollapsed).toBe(false);
    expect(editor.getDocument().blocks[0]?.content[0]?.text).toBe('abcdef');
    expect(editor.canUndo).toBe(false);
  });

  test('still inserts, and still moves the caret, when there is one', () => {
    const editor = mount([block({ content: [{ text: 'abcdef' }] })]);
    const host = editor.element.querySelector<HTMLElement>('.neditor-block__content')!;
    select(host, 0, 6);

    drop(host, { 'text/plain': 'X' });

    expect(
      editor
        .getDocument()
        .blocks.map((b) => blockText(b))
        .join(''),
    ).toContain('X');
  });
});

describe('typing a line and pasting it give the same result', () => {
  /**
   * The README's promise: inline parsing replays the rules typing uses, so the
   * two cannot diverge. It is measured here the way it is used -- a character
   * at a time into a live editor, against parseInlineMarkdown -- because a
   * parse-only assertion held while an opaque-span projection in the reader
   * (since removed) made 1% of random lines come out differently.
   */
  function typeCharByChar(host: HTMLElement, text: string): void {
    for (const char of text) {
      // Appended at the end, as a browser does after a rule has fired (the
      // editor arms an empty mark set there, so what follows is plain).
      host.append(document.createTextNode(char));
      host.focus();
      getSelection()?.collapse(host.lastChild, 1);
      host.dispatchEvent(
        new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true }),
      );
    }
  }

  test.each([
    'a **b** c',
    '`x` and *y*',
    '**a**_b_',
    '`x`_y_',
    '`a *b` c*',
    '**a _b**_',
    '<u>a *b</u> c*',
    '[x](https://a.test/_y_)',
    '[t](https://a.test/?q=`x`)',
    '[t](<https://a.test/?q=`x`>) and `c`',
    'a `](` b',
    'a<strong>b </strong>c',
    '<em> i</em> and <s>x </s>',
    'a<code> c </code>b',
    // Pre-existing: typing toggled a mark the text already had, so a doubled
    // mark came out plain when typed and marked when pasted.
    '**__a__**',
    '<s><s>x</s></s>',
    '~~<s>a</s>~~',
    'one *two\nthree* four',
    // No `_` inside a bare URL is a delimiter, typed or pasted.
    'see https://a.test/_y_ and _z_',
    '_a https://a.test/x_y',
    'www.a.test/__init__ __b__',
    // An autolink is read as the URL it holds, typed or pasted.
    'see <https://a.test/x_y> and *z*',
    '<https://a.test/*x*>',
    '[a](<https://a.test/x>)',
  ])('%s', async (line) => {
    const { parseInlineMarkdown } = await import('./index.ts');
    const editor = mount([block({})]);
    const host = hosts(editor)[0]!;

    typeCharByChar(host, line);

    expect(editor.getDocument().blocks[0]!.content).toEqual(parseInlineMarkdown(line));
  });

  // Parity alone cannot pin this: typing and pasting share `matchInlineRule`, so
  // they agree with the rule or without it. These say what both must produce.
  test.each([
    // Opened inside the URL: not a span. Typing a URL used to eat these.
    ['https://a.test/_y_', [{ text: 'https://a.test/_y_' }]],
    ['www.a.test/__init__', [{ text: 'www.a.test/__init__' }]],
    ['(https://a.test/_y_)', [{ text: '(https://a.test/_y_)' }]],
    // A protocol URL is linked after punctuation too, quoted or not.
    ['"https://a.test/__init__.py"', [{ text: '"https://a.test/__init__.py"' }]],
    ['see:https://a.test/_y_', [{ text: 'see:https://a.test/_y_' }]],
    ['a=https://a.test/__init__', [{ text: 'a=https://a.test/__init__' }]],
    ["'https://a.test/_y_'", [{ text: "'https://a.test/_y_'" }]],
    // And whatever its case.
    ['HTTPS://a.test/_y_', [{ text: 'HTTPS://a.test/_y_' }]],
    ['WWW.a.test/_y_', [{ text: 'WWW.a.test/_y_' }]],
    // Opened before it: a span, as in CommonMark and GFM, which leaves a
    // trailing `_` out of the link.
    ['_see https://example.com_', [{ text: 'see https://example.com', marks: ['italic'] }]],
    ['__see www.example.com__', [{ text: 'see www.example.com', marks: ['bold'] }]],
    ['_https://a.test/x_', [{ text: 'https://a.test/x', marks: ['italic'] }]],
    [
      '(_https://a.test/x_)',
      [{ text: '(' }, { text: 'https://a.test/x', marks: ['italic'] }, { text: ')' }],
    ],
    // `www.` in the middle of a word opens no URL.
    ['_awww.cute_', [{ text: 'awww.cute', marks: ['italic'] }]],
    ['awww._x_', [{ text: 'awww.' }, { text: 'x', marks: ['italic'] }]],
    // micromark links `www.` after `]` as well.
    ['[1]www.a.test/_y_', [{ text: '[1]www.a.test/_y_' }]],
    // A protocol counts whatever precedes it. After a letter no reader links
    // it, but a finished span leaves one there: `**see**https://…` is
    // `seehttps://…` by the time the `_` closes, and GFM links that URL.
    ['xhttps://a.test/_y_', [{ text: 'xhttps://a.test/_y_' }]],
    ['1http://a.test/_y_', [{ text: '1http://a.test/_y_' }]],
    [
      '**see**https://a.test/_y_',
      [{ text: 'see', marks: ['bold'] }, { text: 'https://a.test/_y_' }],
    ],
    // The span opens in the URL and closes after whitespace: it is the token
    // the opener is in that decides, not the one the caret is in.
    [
      'GET http://localhost:9200/_cat/indices and http://localhost:9200/my_index/_search',
      [
        {
          text: 'GET http://localhost:9200/_cat/indices and http://localhost:9200/my_index/_search',
        },
      ],
    ],
    ['https://a.test/_x and y_', [{ text: 'https://a.test/_x and y_' }]],
    ['https://a.test/__x and y__', [{ text: 'https://a.test/__x and y__' }]],
    // Where the line is uncertain it falls on the side of the URL. A host may
    // begin with `_` (`_dmarc.example.com`), and at the closing `_` nothing
    // says whether more host follows; a link labelled with its own URL is the
    // common label. Keeping underscores other readers would have taken for
    // emphasis loses nothing; taking them out of a URL does.
    ['https://_dmarc.example.com/a_b_c', [{ text: 'https://_dmarc.example.com/a_b_c' }]],
    ['see http://_a_ now', [{ text: 'see http://_a_ now' }]],
    ['www._a_.example.com', [{ text: 'www._a_.example.com' }]],
    [
      '[https://a.test/_private_dir](https://a.test/)',
      [{ text: 'https://a.test/_private_dir', link: 'https://a.test/' }],
    ],
    [
      '[https://a.test/__init__](https://a.test/)',
      [{ text: 'https://a.test/__init__', link: 'https://a.test/' }],
    ],
    [
      '[www.a.test/__init__](https://a.test/)',
      [{ text: 'www.a.test/__init__', link: 'https://a.test/' }],
    ],
  ])('a `_` span and a bare URL: %s', async (line, content) => {
    const { parseInlineMarkdown } = await import('./index.ts');
    const editor = mount([block({})]);

    typeCharByChar(hosts(editor)[0]!, line);

    expect(editor.getDocument().blocks[0]!.content).toEqual(content);
    expect(parseInlineMarkdown(line)).toEqual(content);
  });

  // The README's first documented difference. An angled destination admits a
  // space, so a space no longer ends one: typing cannot know the `>)` is not
  // coming and holds the italic off, while a paste can see that it never does.
  test('an angled destination that never closes holds marks off only while typing', async () => {
    const { parseInlineMarkdown } = await import('./index.ts');
    const editor = mount([block({})]);
    const line = 'see [a](<b and *y*';

    typeCharByChar(hosts(editor)[0]!, line);

    expect(editor.getDocument().blocks[0]!.content).toEqual([{ text: line }]);
    expect(parseInlineMarkdown(line)).toEqual([
      { text: 'see [a](<b and ' },
      { text: 'y', marks: ['italic'] },
    ]);
  });
});

describe('control characters do not reach the model', () => {
  /**
   * R2-EDIT-6: the editor's own clipboard flavour is untrusted when another
   * page wrote it, and its runs went through `normalizeDocument`, which let a
   * NUL through -- the placeholder the inline rules project an escaped
   * character to. Every C0 control but TAB and LF is dropped there, from run
   * text, table cells and an image's alt text alike.
   */
  test('a NUL in a pasted application/x-neditor fragment', () => {
    const editor = mount([block({ id: 'dst', content: [{ text: 'x' }] })]);
    const data = new DataTransfer();
    data.setData('text/html', '<b>innocent</b>');
    data.setData(
      'application/x-neditor',
      JSON.stringify({
        blocks: [{ type: 'paragraph', depth: 0, content: [{ text: 'a\u0000b\u0007c\td\re' }] }],
      }),
    );
    editor.focusRange('dst', 1, 1);
    const event = new ClipboardEvent('paste', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    hosts(editor)[0]!.dispatchEvent(event);

    expect(editor.getDocument().blocks.map((b) => b.content)).toEqual([[{ text: 'xabc\td\ne' }]]);
  });

  test('a stored document: runs, legacy text, cells and alt', async () => {
    const { normalizeDocument } = await import('./index.ts');
    const doc = normalizeDocument({
      blocks: [
        { id: 'p', type: 'paragraph', depth: 0, content: [{ text: '\u0000a\u001f' }] },
        { id: 'l', type: 'paragraph', depth: 0, text: 'b\u0001' } as unknown as Block,
        {
          id: 't',
          type: 'table',
          depth: 0,
          content: [],
          rows: [[[{ text: 'c\u0000' }], [{ text: 'd' }]]],
        },
        {
          id: 'i',
          type: 'image',
          depth: 0,
          content: [{ text: 'cap\u0000' }],
          src: '',
          alt: 'e\u0000',
        },
      ],
    });
    const [p, l, t, i] = doc.blocks;

    expect(p!.content).toEqual([{ text: 'a' }]);
    expect(l!.content).toEqual([{ text: 'b' }]);
    expect(t!.type === 'table' && t!.rows?.[0]?.[0]).toEqual([{ text: 'c' }]);
    expect(i!.content).toEqual([{ text: 'cap' }]);
    expect(i!.type === 'image' && i!.alt).toBe('e');
  });

  /**
   * R3-FMT-9: only the stored document and our own flavour were cleaned, so a
   * control character pasted as plain text or HTML reached the model,
   * `getDocument()` and `toMarkdown`, and vanished only on reload -- saved was
   * not loaded. DEL and C1 were kept everywhere, a vertical tab or form feed
   * that means a line break was deleted, and a callout's icon kept its NUL.
   */
  const paste = (editor: NEditor, flavours: Record<string, string>, id = 'dst'): void => {
    const data = new DataTransfer();

    for (const [type, value] of Object.entries(flavours)) {
      data.setData(type, value);
    }

    editor.focusRange(id, 0, 0);
    hosts(editor)[0]!.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  };

  test("the auditor's plain text, from a textarea", async () => {
    const { toMarkdown } = await import('./index.ts');
    const editor = mount([block({ id: 'dst' })]);

    paste(editor, { 'text/plain': 'a\u0001b\u0007c\u001bd\te\u000bf **x\u0000y**' });

    const blocks = editor.getDocument().blocks;

    expect(blocks.map((b) => b.content)).toEqual([
      [{ text: 'abcd\te' }],
      [{ text: 'f ' }, { text: 'xy', marks: ['bold'] }],
    ]);
    expect(
      toMarkdown(editor.getDocument())
        .split('')
        .filter((char) => char < ' ' && char !== '\n' && char !== '\t'),
    ).toEqual([]);
  });

  test("the auditor's HTML, from a page", () => {
    const editor = mount([block({ id: 'dst' })]);

    paste(editor, {
      'text/html': '<p>x&#1;y&#7;z&#27;w <b>b&#11;old</b></p><p>two</p>',
      'text/plain': 'xyzw bold\n\ntwo',
    });

    expect(editor.getDocument().blocks.map((b) => b.content)).toEqual([
      [{ text: 'xyzw ' }, { text: 'b\nold', marks: ['bold'] }],
      [{ text: 'two' }],
    ]);
  });

  test('into a code block, as plain text', () => {
    const editor = mount([block({ id: 'dst', type: 'code' })]);

    paste(editor, { 'text/plain': 'a\u0000b\u007fc\u0085d\u000ce' });

    expect(editor.getDocument().blocks[0]!.content).toEqual([{ text: 'abcd\ne' }]);
  });

  test('DEL and C1 go, a vertical tab and a form feed are line breaks', async () => {
    const { blocksFromHtml, blocksFromMarkdown, normalizeDocument } = await import('./index.ts');

    expect(blocksFromMarkdown('a\u007fb\u0085c\u009fd').map(blockText)).toEqual(['abcd']);
    expect(blocksFromMarkdown('line1\u000bline2').map(blockText)).toEqual(['line1', 'line2']);
    expect(blocksFromHtml(document, '<pre>a\u000bb\u000cc\u0080</pre>').map(blockText)).toEqual([
      'a\nb\nc',
    ]);
    expect(
      normalizeDocument({
        blocks: [
          {
            id: 'p',
            type: 'paragraph',
            depth: 0,
            content: [{ text: 'a\u000bb\u000cc\u007f\u0090' }],
          },
        ],
      }).blocks[0]!.content,
    ).toEqual([{ text: 'a\nb\nc' }]);
  });

  test("a callout's icon", async () => {
    const { normalizeDocument } = await import('./index.ts');
    const [callout, empty] = normalizeDocument({
      blocks: [
        { id: 'c', type: 'callout', depth: 0, content: [], icon: 'x\u0000' },
        { id: 'd', type: 'callout', depth: 0, content: [], icon: '\u0000' },
      ],
    }).blocks;

    expect(callout!.icon).toBe('x');
    expect(empty!.icon).toBe('💡');
  });

  test('a CR LF spelled as references at a block edge is one line break', async () => {
    // R4-FMT-6b: each reference was decoded on its own, so the CR became a
    // line break and the LF a second one. The same characters typed are one.
    const { blocksFromMarkdown } = await import('./index.ts');

    expect(blocksFromMarkdown('x&#13;&#10;').map(blockText)).toEqual(['x\n']);
    expect(blocksFromMarkdown('x&#xD;&#xa;').map(blockText)).toEqual(['x\n']);
    expect(blocksFromMarkdown('&#13;&#10;x').map(blockText)).toEqual(['\nx']);
    // A lone CR is still a line break, and a CR before anything else too.
    expect(blocksFromMarkdown('x&#13;').map(blockText)).toEqual(['x\n']);
    expect(blocksFromMarkdown('x&#13;&#13;&#10;').map(blockText)).toEqual(['x\n\n']);
  });

  test('a vertical tab or form feed that ends a block adds no line', async () => {
    // R4-FMT-6c: one at the end read as a trailing soft break, which a
    // source newline there never is.
    const { blocksFromHtml } = await import('./index.ts');

    expect(
      blocksFromHtml(
        document,
        '<p>x&#11;</p><p>y&#12;</p><p style="white-space: pre-wrap;">z&#11;</p><p>a&#11;b</p>',
      ).map(blockText),
    ).toEqual(['x', 'y', 'z', 'a\nb']);
  });
});

describe('a paste keeps the characters it was given (CB1, CB3)', () => {
  const pastePlain = (editor: NEditor, text: string, offset: number): void => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    editor.focusRange('dst', offset, offset);
    hosts(editor)[0]!.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  };

  test('a dated line pasted into a sentence keeps its year', () => {
    const editor = mount([block({ id: 'dst', content: [{ text: 'X' }] })]);

    pastePlain(editor, '1986. A great year', 1);

    expect(editor.getDocument().blocks.map(blockText)).toEqual(['X1986. A great year']);
  });

  test('a README link to a file links to no stranger’s domain', () => {
    const editor = mount([block({ id: 'dst' })]);

    pastePlain(editor, 'See [Contributing](CONTRIBUTING.md)', 0);

    const [only] = editor.getDocument().blocks;
    expect(only!.content.some((run) => run.link !== undefined)).toBe(false);
    expect(blockText(only!)).toBe('See [Contributing](CONTRIBUTING.md)');
  });
});
