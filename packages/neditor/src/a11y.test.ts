// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';

import type { Block } from './index.ts';
import { NEDITOR_STYLES, createEditor } from './index.ts';
import type { NEditor } from './editor.ts';

/**
 * Accessibility regressions.
 *
 * Each of these was a conformance failure found in the pre-release audit. They
 * assert the observable result — the role, the name, the tab stop — rather than
 * the implementation, so a refactor that preserves behaviour keeps passing.
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

/** Types a "/" with a real caret behind it, which is what opens the menu. */
function typeSlash(content: HTMLElement): void {
  content.textContent = '/';

  const range = document.createRange();
  range.selectNodeContents(content);
  range.collapse(false);
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);

  content.dispatchEvent(
    new InputEvent('input', { inputType: 'insertText', data: '/', bubbles: true }),
  );
}

function press(host: HTMLElement, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  host.dispatchEvent(event);

  return event.defaultPrevented;
}

describe('document semantics', () => {
  test('a heading is exposed as a heading, not a textbox', () => {
    const editor = mount([block({ type: 'heading1', content: [{ text: 'Title' }] })]);
    const content = editor.element.querySelector('.neditor-block__content')!;

    // role="textbox" would win over the host-language role and hide the
    // heading from heading navigation entirely.
    expect(content.tagName).toBe('H1');
    expect(content.getAttribute('role')).toBe(null);
  });

  test.each([
    ['heading2', 'H2'],
    ['heading3', 'H3'],
    ['quote', 'BLOCKQUOTE'],
  ])('%s keeps its semantic element with no overriding role', (type: string, tag: string) => {
    const editor = mount([block({ type: type as Block['type'], content: [{ text: 'x' }] })]);
    const content = editor.element.querySelector('.neditor-block__content')!;

    expect(content.tagName).toBe(tag);
    expect(content.getAttribute('role')).toBe(null);
  });

  test('aria-multiline no longer claims single-line, since Shift+Enter inserts one', () => {
    const editor = mount([block({ content: [{ text: 'x' }] })]);
    const content = editor.element.querySelector('.neditor-block__content')!;

    expect(content.getAttribute('aria-multiline')).toBe(null);
  });

  test('a list marker is announced rather than hidden', () => {
    const editor = mount([block({ type: 'bulleted_list', content: [{ text: 'item' }] })]);
    const marker = editor.element.querySelector('.neditor-block__marker')!;

    // These blocks are not wrapped in a real <ul>, so the bullet is the only
    // signal that this is a list item.
    expect(marker.getAttribute('aria-hidden')).toBe('false');
  });

  test('the editor has an accessible name, and a caller-supplied one wins', () => {
    expect(mount([block({})]).element.getAttribute('aria-label')).toBe('Rich text editor');
    expect(mount([block({})], { label: 'Article body' }).element.getAttribute('aria-label')).toBe(
      'Article body',
    );
  });

  test('a code block is not spellchecked', () => {
    const editor = mount([block({ type: 'code', content: [{ text: 'const a = 1;' }] })]);
    const content = editor.element.querySelector<HTMLElement>('.neditor-block__content')!;

    expect(content.spellcheck).toBe(false);
  });
});

describe('accessible names', () => {
  test('the to-do checkbox is named by its own text', () => {
    const editor = mount([block({ type: 'todo', content: [{ text: 'Buy milk' }] })]);
    const checkbox = editor.element.querySelector('.neditor-block__checkbox')!;
    const labelledBy = checkbox.getAttribute('aria-labelledby')!;

    expect(document.getElementById(labelledBy)?.textContent).toBe('Buy milk');
  });

  test('the image is a focusable, named control', () => {
    const editor = mount([block({ type: 'image', src: 'https://a.test/x.png', alt: 'A cat' })]);
    const trigger = editor.element.querySelector<HTMLElement>('.neditor-image__trigger')!;

    // A bare <img> with a click listener cannot be focused, which left alt text
    // impossible to correct without a mouse.
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('aria-label')).toBeTruthy();
    expect(editor.element.querySelector('img')?.alt).toBe('A cat');
  });
});

describe('keyboard reachability', () => {
  test('the toggle chevron and callout icon are tab stops', () => {
    const editor = mount([
      block({ type: 'toggle', content: [{ text: 't' }] }),
      block({ type: 'callout', content: [{ text: 'c' }] }),
    ]);

    expect(editor.element.querySelector<HTMLElement>('.neditor-block__chevron')?.tabIndex).toBe(0);
    expect(editor.element.querySelector<HTMLElement>('.neditor-block__icon')?.tabIndex).toBe(0);
  });

  test('F10 in a cell moves focus into the table toolbar', () => {
    const editor = mount([block({ type: 'table', rows: [[[{ text: 'A' }], [{ text: 'B' }]]] })]);
    const cell = editor.element.querySelector<HTMLElement>('[data-cell="0:0"]')!;
    cell.focus();

    expect(press(cell, 'F10')).toBe(true);

    const active = document.activeElement as HTMLElement | null;

    expect(active?.classList.contains('neditor-table-toolbar__button')).toBe(true);
    expect(active?.tabIndex).toBe(0);
  });

  test('arrows rove within the toolbar and Escape returns to the cell', () => {
    const editor = mount([block({ type: 'table', rows: [[[{ text: 'A' }]]] })]);
    const cell = editor.element.querySelector<HTMLElement>('[data-cell="0:0"]')!;
    cell.focus();
    press(cell, 'F10');

    const first = document.activeElement as HTMLElement;
    press(first, 'ArrowRight');

    expect(document.activeElement).not.toBe(first);

    press(document.activeElement as HTMLElement, 'Escape');

    expect((document.activeElement as HTMLElement)?.dataset.cell).toBe('0:0');
  });

  test('the table toolbar survives toolbar:false', () => {
    const editor = mount([block({ type: 'table', rows: [[[{ text: 'A' }]]] })], {
      toolbar: false,
    });
    const cell = editor.element.querySelector<HTMLElement>('[data-cell="0:0"]')!;
    cell.focus();

    // Turning off the formatting toolbar must not make tables uneditable.
    expect(press(cell, 'F10')).toBe(true);
  });
});

describe('the editor is not a keyboard trap (WCAG 2.1.2)', () => {
  test('Shift+Tab at depth 0 releases focus instead of being swallowed', () => {
    const editor = mount([block({ content: [{ text: 'a' }] })]);
    const content = editor.element.querySelector<HTMLElement>('.neditor-block__content')!;
    content.focus();

    expect(press(content, 'Tab', { shiftKey: true })).toBe(false);
  });

  test('Tab that cannot indent releases focus', () => {
    // The first block has nothing above it, so it can never be indented.
    const editor = mount([block({ content: [{ text: 'a' }] })]);
    const content = editor.element.querySelector<HTMLElement>('.neditor-block__content')!;
    content.focus();

    expect(press(content, 'Tab')).toBe(false);
  });

  test('Tab still indents when indenting is possible', () => {
    const editor = mount([
      block({ content: [{ text: 'a' }] }),
      block({ content: [{ text: 'b' }] }),
    ]);
    const second = [...editor.element.querySelectorAll<HTMLElement>('.neditor-block__content')][1]!;
    second.focus();

    expect(press(second, 'Tab')).toBe(true);
    expect(editor.getDocument().blocks[1]?.depth).toBe(1);
  });

  test('Shift+Tab out of the first table cell releases focus', () => {
    const editor = mount([block({ type: 'table', rows: [[[{ text: 'A' }]]] })]);
    const cell = editor.element.querySelector<HTMLElement>('[data-cell="0:0"]')!;
    cell.focus();

    expect(press(cell, 'Tab', { shiftKey: true })).toBe(false);
  });

  test('a second Escape leaves the editor', () => {
    const editor = mount([block({ content: [{ text: 'a' }] })]);
    const content = editor.element.querySelector<HTMLElement>('.neditor-block__content')!;
    content.focus();

    press(content, 'Escape');
    expect(editor.getSelectedBlocks()).toHaveLength(1);

    press(editor.element, 'Escape');
    expect(editor.getSelectedBlocks()).toHaveLength(0);
  });
});

describe('announcements', () => {
  const live = (editor: NEditor) => editor.element.querySelector('.neditor-live-region');

  test('a live region exists and is polite', () => {
    const editor = mount([block({})]);

    expect(live(editor)?.getAttribute('role')).toBe('status');
    expect(live(editor)?.getAttribute('aria-live')).toBe('polite');
  });

  test('block selection is announced', () => {
    const editor = mount([
      block({ content: [{ text: 'a' }] }),
      block({ content: [{ text: 'b' }] }),
    ]);
    editor.selectBlocks(editor.getDocument().blocks.map((b) => b.id));

    expect(live(editor)?.textContent).toBe('2 blocks selected');
  });

  test('undo and redo are announced', () => {
    const editor = mount([block({ content: [{ text: 'a' }] })]);
    editor.setBlockType(editor.getDocument().blocks[0]!.id, 'heading1');

    editor.undo();
    expect(live(editor)?.textContent).toBe('Undone');

    editor.redo();
    expect(live(editor)?.textContent).toBe('Redone');
  });

  test('collapsing a toggle is announced', () => {
    const editor = mount([block({ type: 'toggle', content: [{ text: 't' }] })]);
    editor.toggleCollapsed(editor.getDocument().blocks[0]!.id);

    expect(live(editor)?.textContent).toBe('Toggle collapsed');
  });

  test('the live region never becomes a block position', () => {
    const editor = mount([block({ content: [{ text: 'a' }] })]);
    editor.setDocument({ blocks: [block({ content: [{ text: 'b' }] })] });

    // The renderer positions views against the root's children, so a stray
    // element in the middle would shift every block by one.
    expect(editor.element.lastElementChild?.className).toBe('neditor-live-region');
  });
});

describe('selection is not signalled by colour alone', () => {
  test('a selected block carries aria-selected', () => {
    const editor = mount([block({ content: [{ text: 'a' }] })]);
    const id = editor.getDocument().blocks[0]!.id;
    editor.selectBlocks([id]);

    const root = editor.element.querySelector(`[data-block-id="${id}"]`);

    expect(root?.getAttribute('aria-selected')).toBe('true');

    editor.clearBlockSelection();
    expect(root?.getAttribute('aria-selected')).toBe('false');
  });

  test('the stylesheet gives selection a non-colour cue and honours forced colors', () => {
    expect(NEDITOR_STYLES).toContain('forced-colors: active');
    expect(NEDITOR_STYLES).toMatch(/\[data-selected='true'\][^}]*box-shadow/);
    expect(NEDITOR_STYLES).toContain(':focus-visible');
  });
});

describe('the slash menu is announced', () => {
  test('the listbox owns its options and the editable points at the active one', () => {
    const editor = mount([block({})]);
    const content = editor.element.querySelector<HTMLElement>('.neditor-block__content')!;
    content.focus();

    typeSlash(content);

    const listbox = document.querySelector('[role="listbox"]')!;
    const options = listbox.querySelectorAll('[role="option"]');

    expect(options.length).toBeGreaterThan(0);
    expect(listbox.getAttribute('aria-label')).toBeTruthy();
    expect(content.getAttribute('aria-expanded')).toBe('true');
    expect(content.getAttribute('aria-controls')).toBe(listbox.id);
    expect(content.getAttribute('aria-activedescendant')).toBe(options[0]?.id);
  });

  test('closing the menu removes the combobox wiring', () => {
    const editor = mount([block({})]);
    const content = editor.element.querySelector<HTMLElement>('.neditor-block__content')!;
    content.focus();
    typeSlash(content);

    press(content, 'Escape');

    expect(content.getAttribute('aria-expanded')).toBe(null);
    expect(content.getAttribute('aria-activedescendant')).toBe(null);
    expect(content.getAttribute('role')).toBe(null);
  });
});

describe('localisation', () => {
  test('accessible names come from the labels option', () => {
    const editor = mount(
      [
        block({ type: 'toggle', content: [{ text: 't' }] }),
        block({ type: 'callout', content: [{ text: 'c' }] }),
      ],
      {
        labels: {
          editor: 'Éditeur de texte',
          toggleCollapse: 'Développer ou réduire',
          calloutIcon: "Changer l'icône",
        },
      },
    );

    expect(editor.element.getAttribute('aria-label')).toBe('Éditeur de texte');
    expect(
      editor.element.querySelector('.neditor-block__chevron')?.getAttribute('aria-label'),
    ).toBe('Développer ou réduire');
    expect(editor.element.querySelector('.neditor-block__icon')?.getAttribute('aria-label')).toBe(
      "Changer l'icône",
    );
  });

  test('placeholders are overridable per block type', () => {
    const editor = mount([block({ type: 'heading1' })], {
      labels: { placeholders: { heading1: 'Titre' } },
    });

    expect(
      editor.element.querySelector<HTMLElement>('.neditor-block__content')?.dataset.placeholder,
    ).toBe('Titre');
  });

  test('unspecified labels keep their defaults', () => {
    const editor = mount([block({ type: 'todo', content: [{ text: 'x' }] })], {
      labels: { editor: 'Custom' },
    });

    // Only the editor name was overridden; the rest must survive the merge.
    expect(editor.element.getAttribute('aria-label')).toBe('Custom');
    expect(
      editor.element.querySelector<HTMLElement>('.neditor-block__content')?.dataset.placeholder,
    ).toBe('To-do');
  });

  test('announcements are localised, with counts substituted', () => {
    const editor = mount(
      [block({ content: [{ text: 'a' }] }), block({ content: [{ text: 'b' }] })],
      {
        labels: { blocksSelected: '{count} blocs sélectionnés' },
      },
    );

    editor.selectBlocks(editor.getDocument().blocks.map((b) => b.id));

    expect(editor.element.querySelector('.neditor-live-region')?.textContent).toBe(
      '2 blocs sélectionnés',
    );
  });
});
