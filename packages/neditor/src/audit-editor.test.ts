// @vitest-environment happy-dom
import { afterEach, describe, expect, onTestFinished, test } from 'vitest';

import type { Block } from './index.ts';
import { blockText, createEditor } from './index.ts';
import type { NEditor } from './editor.ts';

/**
 * Defects the 2026-11-06 audit found in the editor controller, each pinned from
 * the scenario the auditor (or the real-browser fuzzer) reproduced. Each defect
 * test was run against the unfixed code and failed there; the few controls
 * that guard the other side of a fix (a Tab that does indent) pass either way.
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
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  const range = document.createRange();

  if (node) {
    range.setStart(node, Math.min(offset, node.textContent!.length));
  } else {
    range.setStart(host, 0);
  }

  range.collapse(true);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
}

function press(target: Element, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);

  return event.defaultPrevented;
}

/** Types `value` at the end of `host` the way DOM-first input arrives. */
function typeInto(host: HTMLElement, value: string): void {
  host.textContent = value;
  caret(host, value.length);
  host.dispatchEvent(
    new InputEvent('input', { inputType: 'insertText', data: value.at(-1), bubbles: true }),
  );
}

const shape = (editor: NEditor): string[] =>
  editor
    .getDocument()
    .blocks.map(
      (b) =>
        `${b.type}:${b.depth}:${blockText(b)}${b.checked ? '[x]' : ''}${b.collapsed ? '[c]' : ''}`,
    );

const slashMenu = (): HTMLElement => document.querySelector<HTMLElement>('.neditor-slash-menu')!;

describe('a Tab that changes nothing ends block selection before focus moves on', () => {
  // Found by the WebKit fuzzer, then reproduced in all three engines: Tab on a
  // block selection that cannot indent is not swallowed (the keyboard-trap
  // rule), the browser moves focus into the first block, and the selection
  // stayed live -- so the next character replaced the selected block's text.
  test('Tab on the first block leaves no block selection behind', () => {
    const editor = mount([
      block({ id: 'a', content: text('Title') }),
      block({ content: text('b') }),
    ]);
    editor.selectBlocks(['a']);

    expect(press(editor.element, 'Tab')).toBe(false);
    expect(editor.getSelectedBlocks()).toEqual([]);
  });

  test('so does Shift+Tab at depth 0', () => {
    const editor = mount([block({ id: 'a', content: text('Title') })]);
    editor.selectBlocks(['a']);

    expect(press(editor.element, 'Tab', { shiftKey: true })).toBe(false);
    expect(editor.getSelectedBlocks()).toEqual([]);
  });

  test('a Tab that does indent keeps the selection', () => {
    const editor = mount([block({ content: text('a') }), block({ id: 'b', content: text('b') })]);
    editor.selectBlocks(['b']);

    expect(press(editor.element, 'Tab')).toBe(true);
    expect(editor.getSelectedBlocks()).toEqual(['b']);
  });
});

describe('the slash-menu combobox is named', () => {
  // axe: aria-input-field-name. role="combobox" was put on the block with no
  // accessible name, in all three engines.
  test('the block carries a name while the menu is open, and loses it on close', () => {
    const editor = mount([block({ id: 'p', content: [] })]);
    const host = hostOf(editor, 'p');
    typeInto(host, '/');

    expect(host.getAttribute('role')).toBe('combobox');
    expect(host.getAttribute('aria-label')).toBeTruthy();

    press(host, 'Escape');

    expect(host.hasAttribute('role')).toBe(false);
    expect(host.hasAttribute('aria-label')).toBe(false);
  });
});

describe('read-only is a hard contract for the slash menu and a drag in flight', () => {
  test('setEditable(false) closes the slash menu, and the menu cannot edit', () => {
    const changes: unknown[] = [];
    const editor = mount([block({ id: 'p', content: [] })], {
      onChange: (d: unknown) => changes.push(d),
    });
    const host = hostOf(editor, 'p');
    typeInto(host, 'hello /');
    changes.length = 0;

    editor.setEditable(false);

    expect(slashMenu().hidden).toBe(true);
    expect(host.hasAttribute('role')).toBe(false);
    slashMenu()
      .querySelector<HTMLElement>('[role="option"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(editor.getDocument().blocks[0]!.type).toBe('paragraph');
    expect(changes).toHaveLength(0);
  });
});

describe('destroy gives the element back and stays final', () => {
  test('no theme attribute and no empty class are left behind', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = createEditor({ element: host, theme: 'dark' });
    editor.destroy();

    expect(host.outerHTML).toBe('<div></div>');
  });

  test('setEditable after destroy is refused', () => {
    const editor = mount([block({ content: text('a') })], { editable: false });
    editor.destroy();
    editor.setEditable(true);

    expect(editor.editable).toBe(false);
  });
});

describe('the blockselection event reports document order', () => {
  test('selectBlocks given out of order emits ids in document order', () => {
    const editor = mount([
      block({ id: 'a', content: text('a') }),
      block({ id: 'b', content: text('b') }),
    ]);
    const seen: string[][] = [];
    editor.on('blockselection', ({ ids }) => seen.push([...ids]));
    editor.selectBlocks(['b', 'a']);

    expect(seen.at(-1)).toEqual(['a', 'b']);
  });
});

describe('the slash menu stays out of blocks it would destroy', () => {
  test('a `/` in a code block is just a slash', () => {
    const editor = mount([block({ id: 'c', type: 'code', content: [] })]);
    const host = hostOf(editor, 'c');
    typeInto(host, 'cd /');

    expect(slashMenu().hidden).toBe(true);
    press(host, 'Enter');
    expect(editor.getDocument().blocks[0]!.type).toBe('code');
  });

  test('a `/` in an image caption does not open a menu that would drop the picture', () => {
    const editor = mount([
      block({ id: 'i', type: 'image', src: 'https://e.com/a.png', content: [] } as Partial<Block>),
    ]);
    const host = hostOf(editor, 'i');
    typeInto(host, 'caption /');

    expect(slashMenu().hidden).toBe(true);
    press(host, 'Enter');
    expect(editor.getDocument().blocks[0]).toMatchObject({
      type: 'image',
      src: 'https://e.com/a.png',
    });
  });
});

describe('the + button inserts below the whole block, children included', () => {
  const plus = (editor: NEditor, id: string): void => {
    editor.element
      .querySelector(`[data-block-id="${id}"]`)!
      .dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    editor.element.querySelector<HTMLElement>('.neditor-gutter__add')!.click();
  };

  test('a collapsed toggle keeps its hidden children', () => {
    const editor = mount([
      block({ id: 't', type: 'toggle', collapsed: true, content: text('T') }),
      block({ depth: 1, content: text('hidden1') }),
      block({ depth: 1, content: text('hidden2') }),
      block({ content: text('after') }),
    ]);
    plus(editor, 't');

    expect(shape(editor)).toEqual([
      'toggle:0:T[c]',
      'paragraph:1:hidden1',
      'paragraph:1:hidden2',
      'paragraph:0:',
      'paragraph:0:after',
    ]);
  });

  test('a list item keeps its sub-items', () => {
    const editor = mount([
      block({ id: 'l', type: 'bulleted_list', content: text('parent') }),
      block({ type: 'bulleted_list', depth: 1, content: text('child') }),
    ]);
    plus(editor, 'l');

    expect(shape(editor)).toEqual([
      'bulleted_list:0:parent',
      'bulleted_list:1:child',
      'paragraph:0:',
    ]);
  });
});

describe('Backspace-outdent carries hidden children like Shift+Tab does', () => {
  test('a nested collapsed toggle outdents with its children', () => {
    const editor = mount([
      block({ content: text('P') }),
      block({ id: 't', type: 'toggle', collapsed: true, depth: 1, content: text('T') }),
      block({ depth: 2, content: text('x') }),
      block({ depth: 2, content: text('y') }),
    ]);
    const host = hostOf(editor, 't');
    caret(host, 0);
    press(host, 'Backspace');

    expect(shape(editor)).toEqual([
      'paragraph:0:P',
      'toggle:0:T[c]',
      'paragraph:1:x',
      'paragraph:1:y',
    ]);
  });
});

describe('deleting a block selection always leaves a mode', () => {
  test('the block after is a divider: the caret goes to a neighbour that can hold one', () => {
    const editor = mount([
      block({ id: 'one', content: text('one') }),
      block({ id: 'two', content: text('two') }),
      block({ id: 'd', type: 'divider' }),
    ]);
    editor.selectBlocks(['two']);
    press(editor.element, 'Backspace');

    const caretInBlock = document.activeElement?.classList.contains('neditor-block__content');
    const blockMode = editor.getSelectedBlocks().length > 0;

    expect(caretInBlock || blockMode).toBe(true);
    // And undo is reachable from wherever that left focus.
    press(document.activeElement!, 'z', { ctrlKey: true, metaKey: true });
    expect(shape(editor)).toEqual(['paragraph:0:one', 'paragraph:0:two', 'divider:0:']);
  });

  test('nothing around can hold a caret: the neighbour is selected instead', () => {
    const editor = mount([
      block({ id: 'p', content: text('p') }),
      block({ id: 'd', type: 'divider' }),
    ]);
    editor.selectBlocks(['p']);
    press(editor.element, 'Backspace');

    expect(editor.getSelectedBlocks()).toEqual(['d']);
  });
});

describe('Enter at the start of a non-empty block pushes it down unchanged', () => {
  test('a heading stays a heading', () => {
    const editor = mount([block({ id: 'h', type: 'heading1', content: text('Title') })]);
    const host = hostOf(editor, 'h');
    caret(host, 0);
    press(host, 'Enter');

    expect(shape(editor)).toEqual(['paragraph:0:', 'heading1:0:Title']);
    expect(editor.getDocument().blocks[1]!.id).toBe('h');
    expect(document.activeElement).toBe(hostOf(editor, 'h'));
  });

  test('a checked to-do keeps its check and its text together', () => {
    const editor = mount([
      block({ id: 't', type: 'todo', checked: true, content: text('Done task') }),
    ]);
    const host = hostOf(editor, 't');
    caret(host, 0);
    press(host, 'Enter');

    expect(shape(editor)).toEqual(['todo:0:', 'todo:0:Done task[x]']);
  });
});

describe('setBlockType keeps the text it cannot show, and announces only real changes', () => {
  test('to divider opens a paragraph for the text, as /divider does', () => {
    const editor = mount([block({ id: 'p', content: text('keep me') })]);
    editor.setBlockType('p', 'divider');

    expect(shape(editor)).toEqual(['divider:0:', 'paragraph:0:keep me']);
  });

  test('a table turned into a paragraph keeps its cell text', () => {
    const editor = mount([
      block({
        id: 't',
        type: 'table',
        rows: [
          [text('a'), text('b')],
          [text('c'), text('d')],
        ],
      } as Partial<Block>),
    ]);
    editor.setBlockType('t', 'paragraph');

    expect(blockText(editor.getDocument().blocks[0]!)).toBe('a b\nc d');
  });

  test('an unknown id or the same type announces nothing', () => {
    const editor = mount([block({ id: 'h', type: 'heading1', content: text('H') })]);
    const live =
      editor.element.parentElement!.querySelector('[aria-live]') ??
      document.querySelector('[aria-live]');
    const before = live?.textContent;
    editor.setBlockType('nope', 'heading2');
    editor.setBlockType('h', 'heading1');

    expect(live?.textContent).toBe(before);
  });
});

describe('an edit that leaves the content equal is not an edit', () => {
  test('re-applying the link already there banks nothing', () => {
    const changes: unknown[] = [];
    const editor = mount(
      [block({ id: 'p', content: [{ text: 'site', link: 'https://e.com/' }] })],
      {
        onChange: (d: unknown) => changes.push(d),
      },
    );
    editor.focusRange('p', 0, 4);
    editor.setLink('https://e.com/');

    expect(editor.canUndo).toBe(false);
    expect(changes).toHaveLength(0);
  });
});

describe('a merge into a code block drops marks the block cannot hold', () => {
  test('Backspace at the start of a bold paragraph after a code block', () => {
    const editor = mount([
      block({ id: 'c', type: 'code', content: text('x') }),
      block({ id: 'p', content: [{ text: 'bold', marks: ['bold'] }] }),
    ]);
    const host = hostOf(editor, 'p');
    caret(host, 0);
    press(host, 'Backspace');

    expect(editor.getDocument().blocks[0]!.content).toEqual([{ text: 'xbold' }]);
  });
});

describe('Cmd+Shift+Arrow in a table cell keeps the caret in that cell', () => {
  test('moving the table up leaves the caret in cell 2:1', () => {
    const rows = [
      [text('h1'), text('h2')],
      [text('a1'), text('a2')],
      [text('b1'), text('bbbb')],
    ];
    const editor = mount([
      block({ content: text('above') }),
      block({ id: 'tb', type: 'table', rows } as Partial<Block>),
    ]);
    const cell = editor.element.querySelector<HTMLElement>('[data-cell="2:1"]')!;
    caret(cell, 2);
    press(cell, 'ArrowUp', { shiftKey: true, metaKey: true, ctrlKey: true });

    expect(editor.getDocument().blocks[0]!.id).toBe('tb');
    expect(editor.getSelectionState()?.cell).toEqual({ row: 2, column: 1 });
  });
});

describe('undo after an edit made on a block selection restores that selection', () => {
  // The edit had no caret to record, so undo fell back to the first block of
  // the document -- in a long document, deleting block 7 and undoing threw the
  // user to the top.
  test('delete block 7, undo: block 7 is back and selected', () => {
    const blocks = Array.from({ length: 10 }, (_, i) =>
      block({ id: `p${i}`, content: text(`p${i}`) }),
    );
    const editor = mount(blocks);
    editor.selectBlocks(['p7']);
    press(editor.element, 'Backspace');
    editor.undo();

    expect(editor.getDocument().blocks).toHaveLength(10);
    expect(editor.getSelectedBlocks()).toEqual(['p7']);
  });

  test('a move undone keeps the moved blocks selected where they return', () => {
    const blocks = Array.from({ length: 5 }, (_, i) =>
      block({ id: `m${i}`, content: text(`m${i}`) }),
    );
    const editor = mount(blocks);
    editor.selectBlocks(['m3']);
    press(editor.element, 'ArrowUp', { shiftKey: true, metaKey: true, ctrlKey: true });
    editor.undo();

    expect(editor.getDocument().blocks.map((b) => b.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(editor.getSelectedBlocks()).toEqual(['m3']);
  });
});

describe('historyLimit is validated', () => {
  // `Math.max(1, NaN)` is NaN and `length > NaN` is never true, so a limit
  // read from a bad config string kept every entry.
  test('NaN falls back to the default bound of 200', () => {
    const editor = mount([block({ id: 'p', content: text('x') })], { historyLimit: Number.NaN });
    for (let i = 0; i < 210; i++) {
      editor.setBlockType('p', i % 2 === 0 ? 'heading1' : 'paragraph');
    }
    let undos = 0;
    while (editor.undo()) {
      undos += 1;
    }

    expect(undos).toBe(200);
  });
});

describe('a composition reports one change, and none when it is cancelled', () => {
  // onChange received every half-composed candidate -- ["abcに","abcにほ","abc",
  // "abc"] for a composition that ended where it began -- so an autosave or a
  // collaboration layer persisted and broadcast IME candidates on every word.
  const compose = (steps: string[]): { seen: string[]; editor: NEditor } => {
    const seen: string[] = [];
    const editor = mount([block({ id: 'a', content: text('abc') })], {
      onChange: (d: { blocks: Block[] }) => seen.push(blockText(d.blocks[0]!)),
    });
    const host = hostOf(editor, 'a');
    host.focus();
    host.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));

    for (const step of steps) {
      host.textContent = step;
      caret(host, step.length);
      host.dispatchEvent(
        new InputEvent('input', { inputType: 'insertCompositionText', bubbles: true }),
      );
    }

    host.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));

    return { seen, editor };
  };

  test('a cancelled candidate fires nothing', () => {
    expect(compose(['abcに', 'abcにほ', 'abc']).seen).toEqual([]);
  });

  test('a committed word fires once, with the word', () => {
    expect(compose(['abcに', 'abcにほ', 'abc日本']).seen).toEqual(['abc日本']);
  });
});

describe('no change listener, no document copy', () => {
  // #emitChange deep-cloned the document on every keystroke whether or not
  // anything listened -- about 0.85 ms per keystroke at 2,000 blocks.
  test('typing with no listener does not build a change payload', () => {
    const editor = mount([block({ id: 'a', content: text('x') })]);
    let copies = 0;
    const original = editor.getDocument.bind(editor);
    editor.getDocument = () => {
      copies += 1;
      return original();
    };
    typeInto(hostOf(editor, 'a'), 'xy');

    expect(copies).toBe(0);
  });
});

describe('`***` at the start of a paragraph can still open bold italic', () => {
  // `***` became a divider the instant it was typed, so `***bold italic***`
  // could not be typed at the start of a paragraph at all. A trailing space
  // marks the rule as a divider; `---` keeps firing at once.
  test('`***` alone is not a divider, `*** ` is, and `---` still is', async () => {
    const { matchInputRule } = await import('./input/input-rules.ts');

    expect(matchInputRule('***', '***')).toBeNull();
    expect(matchInputRule('*** ', '*** ')?.type).toBe('divider');
    expect(matchInputRule('---', '---')?.type).toBe('divider');
  });
});

describe('the table toolbar follows its table through a scroll', () => {
  // Portals are position: fixed. The toolbar was repositioned only on
  // selectionchange, which a scroll never fires, so after scrolling it floated
  // over unrelated content while its buttons still acted on the old cell.
  test('a page scroll re-places it against the table', () => {
    const editor = mount([
      block({ id: 't', type: 'table', rows: [[text('a')]] } as Partial<Block>),
    ]);
    const root = editor.element.querySelector<HTMLElement>('[data-block-id="t"]')!;
    let top = 300;
    root.getBoundingClientRect = () => new DOMRect(20, top, 400, 60);
    const cell = editor.element.querySelector<HTMLElement>('[data-cell="0:0"]')!;
    caret(cell, 1);
    document.dispatchEvent(new Event('selectionchange'));
    const toolbar = document.querySelector<HTMLElement>('.neditor-table-toolbar')!;
    const before = toolbar.style.top;

    top = 100;
    document.body.dispatchEvent(new Event('scroll', { bubbles: false }));

    expect(toolbar.hidden).toBe(false);
    expect(toolbar.style.top).not.toBe(before);
  });
});

describe('right-to-left editors keep left and right where the reader sees them', () => {
  // happy-dom resolves `direction` to ltr whatever `dir` says, so the editor
  // root's computed style is stubbed; the browser behaviour is checked in
  // Chromium, Firefox and WebKit by the audit's real-browser probes.
  const rtlTable = (): NEditor => {
    const editor = mount([
      block({ id: 't', type: 'table', rows: [[text('X'), text('Y')]] } as Partial<Block>),
    ]);
    editor.element.dir = 'rtl';
    const real = window.getComputedStyle.bind(window);
    window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
      const style = real(element, pseudo);

      return element === editor.element
        ? new Proxy(style, {
            get: (target, key) => (key === 'direction' ? 'rtl' : Reflect.get(target, key)),
          })
        : style;
    }) as typeof window.getComputedStyle;
    onTestFinished(() => {
      window.getComputedStyle = real;
    });
    return editor;
  };

  test('"Insert column left" in an RTL table inserts on the visual left', () => {
    // Columns run right to left, so the visual left of cell 0:0 is logical
    // index 1. The command inserted at the logical index, i.e. on the right.
    const editor = rtlTable();
    const cell = editor.element.querySelector<HTMLElement>('[data-cell="0:0"]')!;
    caret(cell, 1);
    document.dispatchEvent(new Event('selectionchange'));
    const insertLeft = [
      ...document.querySelectorAll<HTMLElement>('.neditor-table-toolbar button'),
    ].find(
      (button) =>
        /column/i.test(button.getAttribute('aria-label') ?? '') &&
        /left/i.test(button.getAttribute('aria-label') ?? ''),
    )!;
    insertLeft.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const rows = editor.getDocument().blocks[0]!.rows!;
    expect(rows[0]!.map((c) => c.map((r) => r.text).join(''))).toEqual(['X', '', 'Y']);
  });

  test('the floating UI takes the editor direction', () => {
    const editor = rtlTable();
    editor.element.querySelector<HTMLElement>('[data-cell="0:0"]')!.focus();

    for (const portal of document.querySelectorAll<HTMLElement>('.neditor-portal')) {
      expect(portal.dir).toBe('rtl');
    }
  });
});

describe('two copies of the package on one page do not share ids', () => {
  // The id counters were module-level, so a page loading two bundles -- a
  // widget beside the host app's own copy -- gave both editors
  // `neditor-1-…` and `neditor-link-error-1`, and each editor's
  // aria-labelledby / aria-describedby could resolve into the other. A real
  // second bundle cannot be loaded here (a query-string import duplicates one
  // module, not its dependencies), so the mechanism is pinned in two halves.
  test('two instances of the id module continue one numbering', async () => {
    type Ids = typeof import('./util/ids.ts');
    // Through a variable: a query-string specifier has no type declaration.
    const load = (copy: string): Promise<Ids> =>
      import(/* @vite-ignore */ `./util/ids.ts?${copy}`) as Promise<Ids>;
    const a = await load('copy-a');
    const b = await load('copy-b');

    expect(a.nextId).not.toBe(b.nextId);
    const first = a.nextId('probe');
    expect(b.nextId('probe')).toBe(first + 1);
  });

  test('the renderer and both dialogs number from that shared store', async () => {
    const { nextId } = await import('./util/ids.ts');
    const base = {
      renderer: nextId('renderer'),
      link: nextId('link-error'),
      image: nextId('image-error'),
    };
    const editor = mount([block({ id: 'x', type: 'todo', content: text('t') })]);

    expect(hostOf(editor, 'x').id).toBe(`neditor-${base.renderer + 1}-x-content`);
    expect(document.querySelector('.neditor-link-editor__error')!.id).toBe(
      `neditor-link-error-${base.link + 1}`,
    );
    expect(document.querySelector('.neditor-image-editor__error')!.id).toBe(
      `neditor-image-error-${base.image + 1}`,
    );
  });
});

describe('stylesheet layout the browser applies and happy-dom cannot', () => {
  // happy-dom computes no layout, so these pin the rules themselves; each was
  // seen wrong in Chromium first.
  const rule = async (selector: string): Promise<string> => {
    const { NEDITOR_STYLES } = await import('./styles.ts');
    const start = NEDITOR_STYLES.indexOf(`\n${selector} {`);
    return NEDITOR_STYLES.slice(start, NEDITOR_STYLES.indexOf('}', start));
  };

  test('the link dialog wraps, so its error takes its own line instead of being squeezed', async () => {
    // A non-wrapping flex row put the error between the input and Apply and
    // clipped its text to a few characters.
    expect(await rule('.neditor-link-editor')).toMatch(/flex-wrap:\s*wrap/);
    expect(await rule('.neditor-link-editor__error,\n.neditor-image-editor__error')).toMatch(
      /order:\s*1/,
    );
  });

  test('the callout pads by reading direction, not by physical side', async () => {
    // `padding: 0.75rem 1rem 0.75rem 0.75rem` kept the wide side on the right
    // in an RTL callout as well.
    const callout = await rule('.neditor-callout');

    expect(callout).not.toMatch(/padding:\s*[\d.]+rem\s+[\d.]+rem\s+[\d.]+rem\s+[\d.]+rem/);
    expect(callout).toMatch(/padding-inline:\s*0\.75rem 1rem/);
  });
});
