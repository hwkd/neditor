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
  test('a block selection is announced, not written as a prohibited attribute', () => {
    const editor = mount([block({ content: [{ text: 'a' }] })]);
    const id = editor.getDocument().blocks[0]!.id;
    editor.selectBlocks([id]);

    const root = editor.element.querySelector(`[data-block-id="${id}"]`);

    // This test previously asserted aria-selected="true". That was wrong: the
    // attribute is prohibited on role=generic, which is what a bare block <div>
    // is, so browsers drop it — it announced nothing and left every unselected
    // block carrying aria-selected="false" forever. Giving the block a role
    // that carries it would displace the heading and list semantics the content
    // element exists to provide, the same trade that made role="textbox" wrong.
    expect(root?.hasAttribute('aria-selected')).toBe(false);

    const live = editor.element.querySelector('[aria-live]');

    // And it says *which* block. This asserted "1 block selected", which is
    // what every block in the document announced -- so arrowing through
    // block-selection mode repeated one identical sentence and nothing
    // identified what Backspace was about to delete.
    expect(live?.textContent).toContain('a');
    expect(live?.textContent).not.toBe('1 block selected');
  });

  test('a second selected block goes back to the count', () => {
    const editor = mount([
      block({ id: 'x', content: [{ text: 'Alpha' }] }),
      block({ id: 'y', content: [{ text: 'Bravo' }] }),
    ]);
    editor.selectBlocks(['x', 'y']);

    expect(editor.element.querySelector('[aria-live]')?.textContent).toContain('2 blocks selected');
  });

  test('each block in turn announces its own text, not the same sentence', () => {
    const editor = mount([
      block({ id: 'x', content: [{ text: 'Alpha' }] }),
      block({ id: 'y', type: 'heading1', content: [{ text: 'Bravo' }] }),
    ]);
    const live = editor.element.querySelector('[aria-live]')!;

    editor.selectBlocks(['x']);
    const first = live.textContent;
    editor.selectBlocks(['y']);
    const second = live.textContent;

    expect(first).toContain('Alpha');
    expect(second).toContain('Bravo');
    expect(first).not.toBe(second);
  });

  test('a block with no text of its own is still identified by type', () => {
    const editor = mount([block({ id: 'd', type: 'divider' })]);
    editor.selectBlocks(['d']);

    const spoken = editor.element.querySelector('[aria-live]')?.textContent ?? '';

    expect(spoken.length).toBeGreaterThan(0);
    expect(spoken).not.toBe('1 block selected');
  });

  test('the stylesheet gives selection a non-colour cue and honours forced colors', () => {
    expect(NEDITOR_STYLES).toContain('forced-colors: active');
    expect(NEDITOR_STYLES).toMatch(/\[data-selected='true'\][^}]*box-shadow/);
    expect(NEDITOR_STYLES).toContain(':focus-visible');
  });

  test('the forced-colors opt-out stops at the selected block', () => {
    // forced-color-adjust is inherited, so opting the block out took its whole
    // subtree with it: the bullet of a selected list and the text of a selected
    // completed to-do kept their author colour on the system Highlight, at
    // roughly 1.2:1. Descendants have to be handed back to the system palette.
    expect(NEDITOR_STYLES).toMatch(
      /\.neditor-block\[data-selected='true'\] \*\s*\{\s*forced-color-adjust: auto;/,
    );
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

  test('the drag handle takes its name from the labels', () => {
    const editor = mount([block({ content: [{ text: 'a' }] })], {
      labels: { gutterHandle: 'Glisser pour déplacer, cliquer pour sélectionner' },
    });

    const handle = editor.element.querySelector('.neditor-gutter__handle');

    expect(handle?.getAttribute('aria-label')).toBe(
      'Glisser pour déplacer, cliquer pour sélectionner',
    );
    expect(handle?.getAttribute('title')).toBe('Glisser pour déplacer, cliquer pour sélectionner');
  });

  test('the slash menu is built from the labels', () => {
    const editor = mount([block({})], {
      labels: {
        slashCommands: {
          paragraph: {
            label: 'Texte',
            description: 'Commencez simplement à écrire.',
            keywords: ['texte'],
          },
        },
      },
    });
    const content = editor.element.querySelector<HTMLElement>('.neditor-block__content')!;
    content.focus();

    typeSlash(content);

    expect(document.querySelector('[role="option"] .neditor-slash-menu__label')?.textContent).toBe(
      'Texte',
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

describe('ARIA the element is actually allowed to carry', () => {
  /**
   * The rule this file already holds elsewhere, applied to two attributes that
   * were breaking it: an ARIA attribute a role does not permit is dropped by
   * browsers, so it announces nothing while looking like coverage.
   */
  test('no aria-readonly on hosts whose roles forbid it', () => {
    for (const editable of [true, false]) {
      const editor = mount(
        [
          block({ id: 'h', type: 'heading1', content: [{ text: 'Title' }] }),
          block({ id: 'p', content: [{ text: 'Body' }] }),
          block({ id: 'q', type: 'quote', content: [{ text: 'Quoted' }] }),
        ],
        { editable },
      );

      expect(
        editor.element.querySelectorAll('[aria-readonly]'),
        `editable: ${editable}`,
      ).toHaveLength(0);
    }
  });

  test('contenteditable still says whether the field takes input', () => {
    expect(
      mount([block({ content: [{ text: 'x' }] })], { editable: false })
        .element.querySelector('.neditor-block__content')
        ?.getAttribute('contenteditable'),
    ).toBe('false');
  });

  test('the root carries a role that permits the name it is given', () => {
    const editor = mount([block({})], { label: 'Article body' });

    expect(editor.element.getAttribute('aria-label')).toBe('Article body');
    // `generic` -- a div with no role -- prohibits aria-label outright.
    expect(editor.element.getAttribute('role')).toBe('group');
  });

  test("destroy() takes back the role it added, and leaves the page's own", () => {
    const host = document.createElement('div');
    document.body.append(host);
    const mine = createEditor({ element: host, doc: { blocks: [block({})] } });
    mine.destroy();

    expect(host.hasAttribute('role')).toBe(false);

    host.setAttribute('role', 'application');
    const theirs = createEditor({ element: host, doc: { blocks: [block({})] } });
    theirs.destroy();

    expect(host.getAttribute('role')).toBe('application');
    host.remove();
  });
});

describe('two editors on one page do not collide in the document', () => {
  /**
   * Block ids are unique per document, and keeping them stable across a
   * published/draft pair is the point of them -- so two editors over the same
   * document emitted the same DOM `id` twice. Every `aria-labelledby` resolves
   * to the first match in the document, so the second editor's to-do announced
   * the first editor's text.
   */
  test("a to-do is named by its own text, not the other editor's", () => {
    const first = mount([
      block({ id: 'task-1', type: 'todo', checked: true, content: [{ text: 'Ship v1' }] }),
    ]);
    const second = mount([
      block({ id: 'task-1', type: 'todo', content: [{ text: 'Ship v2 instead' }] }),
    ]);

    const labelledBy = second.element
      .querySelector('.neditor-block__checkbox')!
      .getAttribute('aria-labelledby')!;
    const named = document.getElementById(labelledBy);

    expect(named).not.toBeNull();
    expect(named!.textContent).toBe('Ship v2 instead');
    expect(second.element.contains(named)).toBe(true);
    expect(first.element.contains(named)).toBe(false);
  });

  test('the page holds no duplicate ids', () => {
    mount([block({ id: 'same', content: [{ text: 'one' }] })]);
    mount([block({ id: 'same', content: [{ text: 'two' }] })]);

    const ids = [...document.querySelectorAll('[id]')].map((one) => one.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('a rejected URL is signalled by more than a colour', () => {
  /**
   * `markInvalid` set a data attribute whose only effect was a red border. A
   * screen reader was told nothing, and under forced colours the border is
   * replaced by a system colour -- so for those users the dialog simply refused
   * to close, with no reason given anywhere.
   */
  const openLink = (): { input: HTMLInputElement; popover: HTMLElement } => {
    const editor = mount([block({ id: 'p', content: [{ text: 'Hello world' }] })]);
    editor.focusRange('p', 0, 5);
    editor.openLinkEditor();
    const popover = document.querySelector<HTMLElement>('.neditor-link-editor')!;

    return { input: popover.querySelector('input')!, popover };
  };

  test('a bad URL sets aria-invalid and shows a reason', () => {
    const { input, popover } = openLink();

    expect(input.getAttribute('aria-invalid')).toBeNull();

    input.value = 'My Document.pdf';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(input.getAttribute('aria-invalid')).toBe('true');

    const described = document.getElementById(input.getAttribute('aria-describedby') ?? '');

    expect(described, 'the input must point at a message that exists').not.toBeNull();
    expect(described!.hidden).toBe(false);
    expect(described!.textContent?.length).toBeGreaterThan(0);
    expect(popover.hidden, 'and the dialog stays open for a correction').toBe(false);
  });

  test('reopening the dialog clears the rejection', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'Hello world' }] })]);
    editor.focusRange('p', 0, 5);
    editor.openLinkEditor();

    // This editor's own portal. Querying the document would find the first
    // dialog on the page, which is a different editor's in a shared suite.
    const input = document.querySelectorAll<HTMLInputElement>('.neditor-link-editor input')[
      document.querySelectorAll('.neditor-link-editor').length - 1
    ]!;

    input.value = 'not a url';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(input.getAttribute('aria-invalid')).toBe('true');

    editor.focusRange('p', 6, 11);
    editor.openLinkEditor();

    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(document.getElementById(input.getAttribute('aria-describedby') ?? '')?.hidden).toBe(
      true,
    );
  });

  test('forced colours restate the rejection, which they previously dropped', () => {
    expect(NEDITOR_STYLES).toMatch(
      /forced-colors: active[\s\S]*neditor-link-editor__input\[data-invalid='true'\]/,
    );
    expect(NEDITOR_STYLES).toMatch(/forced-colors: active[\s\S]*neditor-link-editor__error/);
  });
});

describe('a to-do says what it just became', () => {
  test('checking one announces, as every sibling state change does', () => {
    const editor = mount([block({ id: 't', type: 'todo', content: [{ text: 'Buy milk' }] })]);
    const live = editor.element.querySelector('[aria-live]')!;

    editor.toggleTodo('t');

    expect(live.textContent?.length).toBeGreaterThan(0);
    const checked = live.textContent;

    editor.toggleTodo('t');

    expect(live.textContent).not.toBe(checked);
  });
});

describe('the root takes a role only where there is none to take', () => {
  /**
   * A bare `<div>` has the `generic` role, which prohibits an accessible name
   * -- that is why the root needs one at all. Writing `role="group"`
   * unconditionally threw away the implicit role of any semantic element a host
   * mounted into.
   */
  test.each(['main', 'section', 'article', 'nav', 'form', 'aside'])(
    'a <%s> host keeps its own role',
    (tag) => {
      const host = document.createElement(tag);
      document.body.append(host);
      const editor = createEditor({ element: host, doc: { blocks: [block({})] } });

      expect(host.hasAttribute('role')).toBe(false);

      editor.destroy();
      host.remove();
    },
  );

  test.each(['div', 'span'])('a <%s> host gets one, because it has none', (tag) => {
    const host = document.createElement(tag);
    document.body.append(host);
    const editor = createEditor({ element: host, doc: { blocks: [block({})] } });

    expect(host.getAttribute('role')).toBe('group');

    editor.destroy();

    expect(host.hasAttribute('role')).toBe(false);
    host.remove();
  });
});

describe('a mount with no implicit role gets one, whatever its tag', () => {
  /**
   * Listing the generic elements was the wrong way round: it withheld the role
   * from anything not on the list, including a custom element -- which is
   * exactly the mount a web component uses, and which has no implicit role
   * either. The list names the elements that *have* a role worth keeping.
   */
  test.each(['div', 'span', 'my-editor', 'label'])('a <%s> host is named', (tag) => {
    const host = document.createElement(tag);
    document.body.append(host);
    const editor = createEditor({ element: host, doc: { blocks: [block({})] } });

    expect(host.getAttribute('role'), `<${tag}> has no implicit role to lose`).toBe('group');

    editor.destroy();
    host.remove();
  });

  test.each(['main', 'section', 'article', 'nav', 'form', 'aside', 'blockquote'])(
    'a <%s> host keeps the role it already has',
    (tag) => {
      const host = document.createElement(tag);
      document.body.append(host);
      const editor = createEditor({ element: host, doc: { blocks: [block({})] } });

      expect(host.hasAttribute('role')).toBe(false);

      editor.destroy();
      host.remove();
    },
  );
});
