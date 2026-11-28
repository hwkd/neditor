// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';

import type { Block } from './index.ts';
import { createEditor } from './index.ts';
import type { NEditor } from './editor.ts';
import { getSelectionRange, setSelectionRange } from './view/selection.ts';

/**
 * Defects the 28 November audit found on the main editing paths: the slash
 * menu and the keyboard's way out of a display equation, Mod+K on a link, and
 * typing over a block selection. Each test is the finding's own scenario, and
 * each failed against the unfixed code.
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

function press(target: Element, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);

  return event.defaultPrevented;
}

/** Types `value` at the end of `host` the way DOM-first input arrives. */
function typeInto(host: HTMLElement, value: string): void {
  host.focus();
  host.textContent = value;
  setSelectionRange(host, value.length, value.length);
  host.dispatchEvent(
    new InputEvent('input', { inputType: 'insertText', data: value.at(-1), bubbles: true }),
  );
}

const slashMenu = (): HTMLElement => document.querySelector<HTMLElement>('.neditor-slash-menu')!;
const linkEditor = (): HTMLElement => document.querySelector<HTMLElement>('.neditor-link-editor')!;

describe('a display equation is literal, as a code block is', () => {
  // BL-1: ` /` in TeX opened the menu, and the Enter after ` b` turned the
  // equation into a bulleted list holding "x = a ".
  test('a `/` in an equation is just a slash', () => {
    const editor = mount([block({ id: 'e', type: 'math', content: [] })]);
    const host = hostOf(editor, 'e');
    typeInto(host, 'x = a /');

    expect(slashMenu().hidden).toBe(true);
    press(host, 'Enter');
    expect(editor.getDocument().blocks.map((b) => b.type)).toEqual(['math']);
  });

  // The same guard's sibling: Enter in an equation is a line break, so a
  // document ending in one gave the keyboard no way below it.
  test('ArrowDown at the end of a trailing equation opens a paragraph below it', () => {
    const editor = mount([block({ id: 'e', type: 'math', content: text('E = mc^2') })]);
    const host = hostOf(editor, 'e');
    host.focus();
    setSelectionRange(host, 8, 8);

    expect(press(host, 'ArrowDown')).toBe(true);
    expect(editor.getDocument().blocks.map((b) => b.type)).toEqual(['math', 'paragraph']);
  });
});

describe('Mod+K with a caret in a link edits that link', () => {
  const linked = (): Block =>
    block({
      id: 'a',
      content: [{ text: 'Hello ' }, { text: 'world', link: 'https://example.com/' }, { text: '!' }],
    });

  // TY-1: the key was swallowed and nothing opened, so the keys meant for the
  // URL field (Mod+A, Backspace, Enter) emptied and split the paragraph.
  test.each([
    ['inside it', 8],
    ['at its end', 11],
    ['at its start', 6],
  ])('a caret %s opens the editor on the whole link', (_name, offset) => {
    const editor = mount([linked()]);
    const host = hostOf(editor, 'a');
    editor.focusRange('a', offset, offset);

    expect(press(host, 'k', { ctrlKey: true, metaKey: true })).toBe(true);
    const dialog = linkEditor();
    const field = dialog.querySelector<HTMLInputElement>('input')!;
    expect(dialog.hidden).toBe(false);
    expect(field.value).toBe('https://example.com/');
    expect(dialog.querySelector<HTMLElement>('.neditor-link-editor__button--remove')!.hidden).toBe(
      false,
    );

    // Applied to the whole link, and the caret the reader had comes back.
    field.value = 'https://example.org/';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(editor.getDocument().blocks[0]?.content).toEqual([
      { text: 'Hello ' },
      { text: 'world', link: 'https://example.org/' },
      { text: '!' },
    ]);
    expect(getSelectionRange(host)).toEqual({ start: offset, end: offset });

    // Undo gives back the link and that caret, not a range over it.
    editor.undo();
    expect(editor.getDocument().blocks[0]?.content[1]).toEqual({
      text: 'world',
      link: 'https://example.com/',
    });
    expect(getSelectionRange(hostOf(editor, 'a'))).toEqual({ start: offset, end: offset });
  });

  test('Escape gives back the caret, not the link selected', () => {
    const editor = mount([linked()]);
    const host = hostOf(editor, 'a');
    editor.focusRange('a', 8, 8);
    press(host, 'k', { ctrlKey: true, metaKey: true });

    linkEditor()
      .querySelector<HTMLInputElement>('input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(linkEditor().hidden).toBe(true);
    expect(getSelectionRange(host)).toEqual({ start: 8, end: 8 });
  });

  test('Remove takes the whole link off', () => {
    const editor = mount([linked()]);
    editor.focusRange('a', 8, 8);
    press(hostOf(editor, 'a'), 'k', { ctrlKey: true, metaKey: true });
    linkEditor().querySelector<HTMLButtonElement>('.neditor-link-editor__button--remove')!.click();

    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: 'Hello world!' }]);
  });

  // A caret in plain text has nothing to edit: the key is the browser's, as
  // Mod+Shift+E is where it does nothing.
  test('a caret in plain text opens nothing and keeps nothing from the browser', () => {
    const editor = mount([linked()]);
    const host = hostOf(editor, 'a');
    editor.focusRange('a', 2, 2);

    expect(press(host, 'k', { ctrlKey: true, metaKey: true })).toBe(false);
    expect(linkEditor().hidden).toBe(true);
  });
});

describe('typing over a block selection takes every way a character is typed', () => {
  /** Runs `body` with the mount's window reporting another platform. */
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

  /** A keydown whose AltGr state is stated, not read from `altKey` as happy-dom does. */
  function keyOn(target: Element, init: KeyboardEventInit, altGraph = false): boolean {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    const own = event.getModifierState.bind(event);
    Object.defineProperty(event, 'getModifierState', {
      value: (key: string) => (key === 'AltGraph' ? altGraph : own(key)),
    });
    target.dispatchEvent(event);

    return event.defaultPrevented;
  }

  const selected = (): NEditor => {
    const editor = mount([
      block({ id: 'a', content: text('one') }),
      block({ id: 'b', content: text('two') }),
    ]);
    editor.selectBlocks(['a', 'b']);
    expect(editor.getSelectedBlocks(), 'precondition').toEqual(['a', 'b']);

    return editor;
  };

  const texts = (editor: NEditor): string[] =>
    editor.getDocument().blocks.map((b) => b.content.map((run) => run.text).join(''));

  // TY-2: an IME's keydown is "Process" (keyCode 229, which is all WebKit's
  // says), a dead key's "Dead", and the root holds no composition: the
  // composed text was lost and the blocks stayed selected. The selection is
  // replaced by an empty paragraph with the caret in it before the default
  // action, so the composition starts there.
  test.each([
    ['an IME', { key: 'Process', keyCode: 229 }],
    ['WebKit’s IME', { key: 'k', keyCode: 229 }],
    ['a dead key', { key: 'Dead' }],
  ])('%s keydown opens an empty paragraph and leaves the key to the browser', (_name, init) => {
    const editor = selected();

    expect(keyOn(editor.element, init)).toBe(false);
    expect(texts(editor)).toEqual(['']);
    expect(editor.getSelectedBlocks()).toEqual([]);
    expect(document.activeElement).toBe(hostOf(editor, editor.getDocument().blocks[0]!.id));
  });

  test('Option on a Mac types its character over the selection', () => {
    onPlatform('MacIntel', () => {
      const editor = selected();

      expect(keyOn(editor.element, { key: 'å', altKey: true })).toBe(true);
      expect(texts(editor)).toEqual(['å']);
    });
  });

  test('AltGr elsewhere types its character, though the event says Ctrl+Alt', () => {
    onPlatform('Win32', () => {
      const editor = selected();

      expect(keyOn(editor.element, { key: '@', ctrlKey: true, altKey: true }, true)).toBe(true);
      expect(texts(editor)).toEqual(['@']);
    });
  });

  test('plain Alt elsewhere is the browser’s, and replaces nothing', () => {
    onPlatform('Win32', () => {
      const editor = selected();

      expect(keyOn(editor.element, { key: 'f', altKey: true })).toBe(false);
      expect(texts(editor)).toEqual(['one', 'two']);
      expect(editor.getSelectedBlocks()).toEqual(['a', 'b']);
    });
  });
});
