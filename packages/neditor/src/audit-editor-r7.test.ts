// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';

import type { Block } from './index.ts';
import { blockText, createEditor } from './index.ts';
import type { NEditor } from './editor.ts';

/**
 * Round 7 of the 2026-11-06 audit: pastes that destroyed the block they landed
 * at the start of or replaced -- a toggle, callout, to-do or heading -- and a
 * Tab at the depth ceiling that emptied a fold. Each scenario is the
 * auditor's literal input.
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
  return { id: `s${(next += 1)}`, type: 'paragraph', depth: 0, content: [], ...over } as Block;
}

const text = (value: string): Block['content'] => [{ text: value }];

function mount(blocks: Block[], options: Record<string, unknown> = {}): NEditor {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createEditor({ element: host, doc: { blocks }, ...options });
  editors.push(editor);

  return editor;
}

const hostOf = (editor: NEditor, id: string): HTMLElement =>
  editor.element.querySelector<HTMLElement>(`[data-block-id="${id}"] .neditor-block__content`)!;

function caret(host: HTMLElement, offset: number): void {
  host.focus();
  const node = document.createTreeWalker(host, NodeFilter.SHOW_TEXT).nextNode();
  const range = document.createRange();
  range.setStart(node ?? host, node ? Math.min(offset, node.textContent!.length) : 0);
  range.collapse(true);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
}

function press(target: Element, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);

  return event.defaultPrevented;
}

const shape = (editor: NEditor): string[] =>
  editor
    .getDocument()
    .blocks.map((b) => `${b.type}:${b.depth}:${blockText(b)}${b.collapsed ? '[c]' : ''}`);

const visibleIds = (editor: NEditor): string[] =>
  [...editor.element.querySelectorAll<HTMLElement>('.neditor-block')].map(
    (v) => v.dataset.blockId!,
  );

function pasteEvent(html: string, plain = ''): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  const data: Record<string, string> = { 'text/html': html, 'text/plain': plain };
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) => data[type] ?? '',
      types: Object.keys(data),
      items: [],
      files: [],
    },
  });

  return event;
}

const TABLE = '<table><tr><td>a</td><td>b</td></tr></table>';

describe('a block that cannot merge, pasted at the start of a block, goes before it as Enter would', () => {
  test('a collapsed toggle keeps its id, type, fold and answers', () => {
    const editor = mount([
      block({ id: 'i', content: text('Intro') }),
      block({ id: 't', type: 'toggle', collapsed: true, content: text('Question') }),
      block({ id: 'a', depth: 1, content: text('answer') }),
    ]);
    caret(hostOf(editor, 't'), 0);
    hostOf(editor, 't').dispatchEvent(pasteEvent(TABLE, 'a\tb'));

    expect(shape(editor)).toEqual([
      'paragraph:0:Intro',
      'table:0:a\tb',
      'toggle:0:Question[c]',
      'paragraph:1:answer',
    ]);
    expect(editor.getDocument().blocks[2]?.id).toBe('t');
    expect(visibleIds(editor)).not.toContain('a');
  });

  test('a callout keeps its icon', () => {
    const editor = mount([
      block({ id: 'i', content: text('Intro') }),
      block({ id: 'c', type: 'callout', icon: '⚠️', content: text('Note') }),
    ]);
    caret(hostOf(editor, 'c'), 0);
    hostOf(editor, 'c').dispatchEvent(pasteEvent(TABLE, 'a\tb'));

    const callout = editor.getDocument().blocks.find((b) => b.id === 'c');

    expect(shape(editor)).toEqual(['paragraph:0:Intro', 'table:0:a\tb', 'callout:0:Note']);
    expect(callout?.icon).toBe('⚠️');
  });

  test('a checked to-do stays checked, and a heading a heading', () => {
    const editor = mount([
      block({ id: 'i', content: text('Intro') }),
      block({ id: 'd', type: 'todo', checked: true, content: text('Ship it') }),
      block({ id: 'h', type: 'heading2', content: text('Title') }),
    ]);
    caret(hostOf(editor, 'd'), 0);
    hostOf(editor, 'd').dispatchEvent(pasteEvent('<hr>', ''));
    caret(hostOf(editor, 'h'), 0);
    hostOf(editor, 'h').dispatchEvent(pasteEvent(TABLE, 'a\tb'));

    const blocks = editor.getDocument().blocks;

    expect(shape(editor)).toEqual([
      'paragraph:0:Intro',
      'divider:0:',
      'todo:0:Ship it',
      'table:0:a\tb',
      'heading2:0:Title',
    ]);
    expect(blocks.find((b) => b.id === 'd')?.checked).toBe(true);
    expect(blocks.find((b) => b.id === 'h')).toBeDefined();
  });

  test('the caret stays at the start of the block', () => {
    const editor = mount([
      block({ id: 'i', content: text('Intro') }),
      block({ id: 'h', type: 'heading2', content: text('Title') }),
    ]);
    caret(hostOf(editor, 'h'), 0);
    hostOf(editor, 'h').dispatchEvent(pasteEvent(TABLE, 'a\tb'));

    expect(document.activeElement).toBe(hostOf(editor, 'h'));
    expect(editor.getSelectionState()).toMatchObject({
      blockId: 'h',
      range: { start: 0, end: 0 },
    });
  });

  test('a selection that starts at 0 is replaced, and the caret lands at the start', () => {
    // A collapsed caret at 0 survives the render on its own, so only a
    // selection proves the branch places the caret itself.
    const editor = mount([
      block({ id: 'i', content: text('Intro') }),
      block({ id: 'h', type: 'heading2', content: text('Title') }),
    ]);
    const host = hostOf(editor, 'h');
    host.focus();
    const node = document.createTreeWalker(host, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 2);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    host.dispatchEvent(pasteEvent(TABLE, 'a\tb'));

    expect(shape(editor)).toEqual(['paragraph:0:Intro', 'table:0:a\tb', 'heading2:0:tle']);
    expect(editor.getSelectionState()).toMatchObject({
      blockId: 'h',
      range: { start: 0, end: 0 },
    });
  });

  test('what goes in front keeps its own nesting, relative to the block', () => {
    const editor = mount([
      block({ id: 'a', content: text('A') }),
      block({ id: 'p', depth: 1, content: text('Para') }),
    ]);
    caret(hostOf(editor, 'p'), 0);
    hostOf(editor, 'p').dispatchEvent(
      pasteEvent('<hr><ul><li>x<ul><li>y</li></ul></li></ul>', 'x\n  y'),
    );

    expect(shape(editor)).toEqual([
      'paragraph:0:A',
      'divider:1:',
      'bulleted_list:1:x',
      'bulleted_list:2:y',
      'paragraph:1:Para',
    ]);
  });
});

describe('pasting over the whole summary of a toggle keeps the toggle', () => {
  const faq = (): Block[] => [
    block({ id: 'i', content: text('Intro') }),
    block({ id: 't', type: 'toggle', collapsed: true, content: text('Question') }),
    block({ id: 'a1', depth: 1, content: text('a1') }),
    block({ id: 'a2', depth: 1, content: text('a2') }),
    block({ id: 'z', content: text('Z') }),
  ];

  function selectAll(host: HTMLElement): void {
    host.focus();
    const range = document.createRange();
    range.selectNodeContents(host);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  }

  test('a copied list item becomes its summary text', () => {
    const editor = mount(faq());
    selectAll(hostOf(editor, 't'));
    hostOf(editor, 't').dispatchEvent(
      pasteEvent('<ul><li>Better question</li></ul>', 'Better question'),
    );

    expect(shape(editor)).toEqual([
      'paragraph:0:Intro',
      'toggle:0:Better question[c]',
      'paragraph:1:a1',
      'paragraph:1:a2',
      'paragraph:0:Z',
    ]);
  });

  test('two lines: the first is the summary, the second nests beside the answers', () => {
    const editor = mount(faq());
    selectAll(hostOf(editor, 't'));
    hostOf(editor, 't').dispatchEvent(pasteEvent('<p>New</p><p>question</p>', 'New\nquestion'));

    const blocks = editor.getDocument().blocks;

    expect(blocks.find((b) => b.id === 't')?.type).toBe('toggle');
    expect(blockText(blocks.find((b) => b.id === 't')!)).toBe('New');
    expect(blocks.filter((b) => b.id === 'a1' || b.id === 'a2').map((b) => b.depth)).toEqual([
      1, 1,
    ]);
    expect(visibleIds(editor)).toEqual(expect.arrayContaining(['a1', 'a2']));
  });
});

describe('an empty toggle is not a husk', () => {
  test('a table pasted into its empty summary nests under it, and its answers stay', () => {
    const editor = mount([
      block({ id: 'i', content: text('Intro') }),
      block({ id: 't', type: 'toggle', collapsed: true }),
      block({ id: 'a1', depth: 1, content: text('a1') }),
    ]);
    caret(hostOf(editor, 't'), 0);
    hostOf(editor, 't').dispatchEvent(pasteEvent(TABLE, 'a\tb'));

    const blocks = editor.getDocument().blocks;

    expect(blocks.find((b) => b.id === 't')?.type).toBe('toggle');
    expect(blocks.find((b) => b.id === 'a1')?.depth).toBe(1);
    expect(blocks.find((b) => b.type === 'table')?.depth).toBe(1);
  });
});

describe("a replaced block keeps none of its old type's fields", () => {
  test('pasting a heading over an empty checked to-do', () => {
    const editor = mount([
      block({ id: 'x', content: text('x') }),
      block({ id: 'd', type: 'todo', checked: true }),
    ]);
    caret(hostOf(editor, 'd'), 0);
    hostOf(editor, 'd').dispatchEvent(pasteEvent('<h2>Heading</h2><p>more</p>', 'Heading\nmore'));

    const replaced = editor.getDocument().blocks.find((b) => b.id === 'd')!;

    expect(replaced.type).toBe('heading2');
    expect('checked' in replaced).toBe(false);
  });
});

describe('Tab at the depth ceiling does not empty a fold', () => {
  test('a collapsed toggle whose hidden child cannot go one deeper stays put', () => {
    const chain = Array.from({ length: 32 }, (_, i) =>
      block({ id: `d${i}`, depth: i, content: text(`d${i}`) }),
    );
    const editor = mount([
      ...chain,
      block({ id: 't', type: 'toggle', depth: 31, collapsed: true, content: text('T') }),
      block({ id: 'h', depth: 32, content: text('hidden') }),
    ]);
    caret(hostOf(editor, 't'), 1);

    expect(press(hostOf(editor, 't'), 'Tab')).toBe(false);
    expect(shape(editor).slice(-2)).toEqual(['toggle:31:T[c]', 'paragraph:32:hidden']);
  });
});

describe('typing reads a code run as code, as the Markdown reader does', () => {
  // DOM-first, as the browser does it: append to the last text node, then
  // fire `input`.
  function typeAtEnd(host: HTMLElement, value: string): void {
    for (const char of value) {
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      let last: Text | null = null;

      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        last = node as Text;
      }

      if (!last || last.parentElement !== host) {
        last = document.createTextNode('');
        const filler = host.querySelector('br:last-child');

        if (filler) {
          host.insertBefore(last, filler);
        } else {
          host.append(last);
        }
      }

      last.data += char;
      const range = document.createRange();
      range.setStart(last, last.data.length);
      range.collapse(true);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      host.focus();
      host.dispatchEvent(
        new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true }),
      );
    }
  }

  test('a "](<" inside code holds no destination open', () => {
    const editor = mount([
      block({
        id: 'p',
        content: [{ text: 'Type ' }, { text: '[text](<', marks: ['code'] }, { text: ' then' }],
      }),
    ]);
    typeAtEnd(hostOf(editor, 'p'), ' see [docs](https://y.test/) and **b**');

    const content = editor.getDocument().blocks[0]!.content;

    expect(content).toContainEqual({ text: 'docs', link: 'https://y.test/' });
    expect(content).toContainEqual({ text: 'b', marks: ['bold'] });
    expect(content).toContainEqual({ text: '[text](<', marks: ['code'] });
  });

  test('a destination that runs through a code run is read from the real text', () => {
    // The rules match a projection in which `q` is a placeholder; the URL must
    // not be: captured from the projection it became `https://x.test/` and
    // the `q` was deleted with the destination text.
    const editor = mount([
      block({
        id: 'p',
        content: [{ text: '[l](https://x.test/' }, { text: 'q', marks: ['code'] }],
      }),
    ]);
    typeAtEnd(hostOf(editor, 'p'), ')');

    expect(editor.getDocument().blocks[0]!.content).toContainEqual({
      text: 'l',
      link: 'https://x.test/q',
    });
  });
});

// The rest are from the 14 Nov audit of the math merge, kept here beside the
// paste cases they extend: a no-op paste, the depth ceiling, and the equation
// popover's direction.

describe('a paste that changes nothing records nothing', () => {
  // Each of these parses, as plain text with no HTML, to one empty block that
  // merges as no text at all: the document comes back exactly as it was.
  test.each(['## ', '# ', '- ', '> ', '1. ', '- [ ] '])('%j mid-paragraph', (plain) => {
    const editor = mount([block({ id: 'p', content: text('abcd') })]);
    const before = editor.getDocument();
    let changes = 0;
    editor.on('change', () => (changes += 1));
    caret(hostOf(editor, 'p'), 2);
    hostOf(editor, 'p').dispatchEvent(pasteEvent('', plain));

    expect(editor.getDocument()).toEqual(before);
    expect(changes).toBe(0);
    expect(editor.canUndo).toBe(false);
  });

  // Merge audit, 27 Nov: into an empty block of the same type, the paste
  // replaces it, and the replacement was rebuilt equal to it.
  test.each([
    ['## ', 'heading2'],
    ['# ', 'heading1'],
    ['> ', 'quote'],
  ] as const)('%j into an empty %s', (plain, type) => {
    const editor = mount([block({ id: 'h', type, content: [] })]);
    const before = editor.getDocument();
    let changes = 0;
    editor.on('change', () => (changes += 1));
    caret(hostOf(editor, 'h'), 0);
    hostOf(editor, 'h').dispatchEvent(pasteEvent('', plain));

    expect(editor.getDocument()).toEqual(before);
    expect(changes).toBe(0);
    expect(editor.canUndo).toBe(false);
  });
});

describe('a callout at the depth ceiling cannot take a paste as children', () => {
  test('a table pasted into an empty one goes in front, as for any block', () => {
    // A chain of paragraphs, each one level deeper, so the callout really sits
    // at MAX_DEPTH (32) after `normalizeDepths`.
    const chain = Array.from({ length: 32 }, (_, depth) =>
      block({ id: `d${depth}`, depth, content: text(`d${depth}`) }),
    );
    const editor = mount([...chain, block({ id: 'c', type: 'callout', depth: 32, content: [] })]);
    caret(hostOf(editor, 'c'), 0);
    hostOf(editor, 'c').dispatchEvent(pasteEvent(TABLE, 'a\tb'));

    // Not `callout:32:` followed by a sibling table -- an empty husk above
    // nothing of its own, which is what the paste into its text was meant to
    // avoid.
    expect(shape(editor).slice(32)).toEqual(['table:32:a\tb', 'callout:32:']);
    expect(editor.getDocument().blocks[33]?.id).toBe('c');
  });

  test('prose pasted into an empty toggle there is its text, and its siblings after', () => {
    // Only a first block that cannot merge goes in front. Prose merges, as
    // Enter at the ceiling makes siblings: put in front, the toggle's title
    // became the paste's *last* line.
    const chain = Array.from({ length: 32 }, (_, depth) =>
      block({ id: `d${depth}`, depth, content: text(`d${depth}`) }),
    );
    const editor = mount([...chain, block({ id: 't', type: 'toggle', depth: 32, content: [] })]);
    caret(hostOf(editor, 't'), 0);
    hostOf(editor, 't').dispatchEvent(pasteEvent('<p>a</p><p>b</p>', 'a\n\nb'));

    expect(shape(editor).slice(32)).toEqual(['toggle:32:a', 'paragraph:32:b']);
    expect(editor.getDocument().blocks[32]?.id).toBe('t');
  });
});

describe('the equation popover follows a direction change made while the editor has focus', () => {
  test('opening it re-reads the direction', () => {
    const editor = mount([block({ id: 'p', content: text('x') })]);
    const host = hostOf(editor, 'p');
    caret(host, 1);
    const real = window.getComputedStyle.bind(window);
    window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
      const style = real(element, pseudo);
      return element === editor.element
        ? new Proxy(style, { get: (t, k) => (k === 'direction' ? 'rtl' : Reflect.get(t, k)) })
        : style;
    }) as typeof window.getComputedStyle;

    try {
      editor.openMathEditor();

      expect(document.querySelector<HTMLElement>('.neditor-math-editor')!.hidden).toBe(false);
      expect(document.querySelector<HTMLElement>('.neditor-math-editor')!.dir).toBe('rtl');
    } finally {
      window.getComputedStyle = real;
    }
  });
});
