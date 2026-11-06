// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';

import type { Block } from './index.ts';
import { NEDITOR_STYLES, createEditor } from './index.ts';
import type { NEditor } from './editor.ts';
import { DEFAULT_LABELS } from './labels.ts';
import { ImageEditor } from './ui/image-editor.ts';
import { LinkEditor } from './ui/link-editor.ts';
import { createPortal, positionPortal } from './ui/portal.ts';
import { TableToolbar } from './ui/table-toolbar.ts';

/**
 * Accessibility defects found by looking at the editor in real browsers:
 * forced colours, right-to-left, contrast and what a screen reader is told.
 *
 * Several of them cannot be observed here at all. happy-dom has no forced-colours
 * mode, no readability backplate, no layout and no bidi algorithm, and it does
 * not map a `dir` attribute onto the computed `direction`. Where that is the
 * case the test pins the artifact that decides the behaviour -- the rule in the
 * stylesheet, the attribute on the element -- and says so.
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

function press(target: HTMLElement, key: string): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);

  return event.defaultPrevented;
}

/** The declarations of the first rule whose selector list is exactly `selector`. */
function ruleBody(selector: string, from = 0): string {
  const at = NEDITOR_STYLES.indexOf(`${selector} {`, from);

  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);

  return NEDITOR_STYLES.slice(at, NEDITOR_STYLES.indexOf('}', at));
}

/** The forced-colours block alone, so a rule outside it cannot satisfy a test. */
function forcedColours(): string {
  const start = NEDITOR_STYLES.indexOf('@media (forced-colors: active)');
  const end = NEDITOR_STYLES.indexOf('@media (prefers-reduced-motion', start);

  expect(start).toBeGreaterThan(-1);

  return NEDITOR_STYLES.slice(start, end);
}

/* ------------------------------------------------------ forced colours -- */

describe('a selected block stays legible under forced colours', () => {
  /**
   * Measured in Chromium with forced colours emulated: the selected block is
   * painted Highlight with HighlightText, and its descendants were handed back
   * to `forced-color-adjust: auto`. Chromium then draws its readability
   * backplate -- Canvas, white -- behind every run of their text, while the
   * text itself still inherits HighlightText, also white. The selected text
   * was white on white. No engine here has forced colours, so this pins the
   * rule that decides it.
   */
  test('descendants opt out too, and state their colours in system terms', () => {
    const css = forcedColours();
    const at = css.indexOf(".neditor-block[data-selected='true'] *,");

    expect(at, 'the descendant rule').toBeGreaterThan(-1);

    const body = css.slice(at, css.indexOf('}', at));

    expect(body).toContain('forced-color-adjust: none;');
    expect(body).toContain('color: HighlightText;');
    expect(body).toContain('background-color: transparent;');
    expect(body).toContain('border-color: HighlightText;');
    expect(body).toContain('text-decoration-color: HighlightText;');
  });

  test('nothing inside a selection is handed back to the backplate', () => {
    expect(NEDITOR_STYLES).not.toContain('forced-color-adjust: auto');
  });

  /**
   * The reason `auto` was introduced must stay solved: a completed to-do's text
   * and a list bullet kept their author colours on Highlight at about 1.2:1.
   * The to-do rule is `.neditor-block[data-checked] .neditor-block__content`,
   * which a bare `*` does not out-rank, so the content element is named.
   */
  test('the completed to-do and the bullet cannot keep an author colour', () => {
    const css = forcedColours();
    const at = css.indexOf(".neditor-block[data-selected='true'] *,");
    const selectors = css.slice(at, css.indexOf('{', at));

    expect(selectors).toContain(".neditor-block[data-selected='true'] .neditor-block__content,");
    expect(selectors).toContain(".neditor-block[data-selected='true'] *::before");
    expect(selectors).toContain(".neditor-block[data-selected='true'] *::after");
  });

  test('a checked box is drawn inverted on the Highlight, not erased by it', () => {
    const css = forcedColours();

    expect(css).toMatch(
      /\.neditor-block\[data-selected='true'\] \.neditor-block__checkbox\[aria-checked='true'\] \{[^}]*background-color: HighlightText;/,
    );
    expect(css).toMatch(
      /\.neditor-block\[data-selected='true'\] \.neditor-block__checkbox\[aria-checked='true'\]::after \{[^}]*background-color: Highlight;/,
    );
  });
});

describe('boxes whose only edge was a background keep one under forced colours', () => {
  /**
   * Forced colours replace every background with Canvas, so the callout, the
   * code block and inline code -- each bounded by nothing but a tint -- melted
   * into the page.
   */
  /*
   * The "Add an image" button is the same kind of box -- a callout tint and no
   * border -- and was missed when the other three were given one.
   */
  test.each([
    '.neditor-callout',
    '.neditor-block__pre',
    '.neditor-block__content code',
    '.neditor-image__placeholder',
  ])('%s gets a border', (selector) => {
    const css = forcedColours();
    const at = css.indexOf(selector);

    expect(at, `${selector} is not restated`).toBeGreaterThan(-1);
    expect(css.slice(at, css.indexOf('}', at))).toContain('border: 1px solid CanvasText;');
  });
});

/* ---------------------------------------------------------- direction -- */

describe('code reads left to right inside a right-to-left editor', () => {
  /**
   * Measured in Chromium: a code block in a `dir="rtl"` editor took the RTL
   * base direction, so the trailing `";` of a line of JavaScript was moved to
   * the far end -- `;"blocks usually scroll...`. happy-dom has no bidi, so the
   * declaration is what is pinned.
   */
  test('the code block content element has its own LTR direction', () => {
    const body = ruleBody('.neditor-block__content:is(code)');

    expect(body).toContain('direction: ltr;');
    expect(body).toContain('unicode-bidi: isolate;');
    expect(body, 'start of an LTR box, not a physical side').toContain('text-align: start;');
  });

  /** Measured the same way: `foo(bar);` inline in an RTL paragraph read `;foo(bar)`. */
  test('inline code is an LTR isolate as well', () => {
    const body = ruleBody('.neditor-block__content code');

    expect(body).toContain('direction: ltr;');
    expect(body).toContain('unicode-bidi: isolate;');
  });

  test('the "code" label stays with the pre, so it keeps the reading-start side', () => {
    expect(ruleBody('.neditor-block__pre')).not.toContain('direction:');
    expect(ruleBody('.neditor-block__pre::before')).toContain('inset-inline-start: 1rem;');
  });
});

describe('the gutter follows the direction the browser resolved', () => {
  /**
   * `translateX(-100%)` is physical, so it had to be mirrored by a selector
   * guessing the editor's direction from `[dir]` attributes. An LTR editor whose
   * LTR came from an intermediate wrapper -- `<html dir=rtl><div dir=ltr>` --
   * matched the guess and was mirrored anyway, putting the handle over the
   * text, and a direction set only in CSS was never mirrored at all. A logical
   * margin resolves against the element's real direction, whatever set it.
   */
  test('the offset is a logical margin, not a transform keyed off attributes', () => {
    const body = ruleBody('.neditor-gutter');

    expect(body).toContain('margin-inline-start: calc(-1 * var(--neditor-gutter-width));');
    expect(body).not.toMatch(/transform:/);
    expect(NEDITOR_STYLES).not.toMatch(/\[dir='rtl'\][^{]*\.neditor-gutter/);
  });
});

describe('portals honour their own computed direction', () => {
  /**
   * happy-dom does not derive `direction` from a `dir` attribute, so these set
   * the property directly as well. A real browser computes it from either; the
   * code asks `getComputedStyle`, which is the question both answer.
   */
  function rtl(element: HTMLElement): void {
    element.dir = 'rtl';
    element.style.direction = 'rtl';
  }

  function toolbar(): { bar: TableToolbar; buttons: HTMLButtonElement[] } {
    const bar = new TableToolbar(
      document,
      { onCommand: () => undefined, onDismiss: () => undefined },
      DEFAULT_LABELS,
    );
    document.body.append(bar.element);
    bar.show(new DOMRect(100, 100, 200, 20));

    return { bar, buttons: [...bar.element.querySelectorAll<HTMLButtonElement>('button')] };
  }

  test('in RTL, ArrowLeft moves to the next button, which is the one on the left', () => {
    const { bar, buttons } = toolbar();
    rtl(bar.element);
    bar.focusFirst();

    press(buttons[0]!, 'ArrowLeft');

    expect(document.activeElement).toBe(buttons[1]);

    press(buttons[1]!, 'ArrowRight');

    expect(document.activeElement).toBe(buttons[0]);
  });

  test('in LTR the arrows keep their meaning', () => {
    const { bar, buttons } = toolbar();
    bar.focusFirst();

    press(buttons[0]!, 'ArrowRight');

    expect(document.activeElement).toBe(buttons[1]);
  });

  test('an RTL portal lines its reading-start edge up with the anchor', () => {
    const element = createPortal(document, 'probe');
    document.body.append(element);
    element.hidden = false;
    const anchor = { left: 100, right: 300, top: 50, bottom: 70 };

    positionPortal(element, anchor, { prefer: 'below' });

    expect(element.style.left, 'LTR: left edge to left edge').toBe('100px');

    rtl(element);
    positionPortal(element, anchor, { prefer: 'below' });

    // happy-dom measures every box at zero width, so the right edge is `left`.
    expect(element.style.left, 'RTL: right edge to right edge').toBe('300px');
  });
});

/* -------------------------------------------------------------- names -- */

describe('visible text is part of the accessible name (WCAG 2.5.3)', () => {
  /**
   * axe reported `label-content-name-mismatch` on the delete-column button:
   * it read "⤫ col" while being named "Delete this column", and a speech user
   * saying "click col" matches nothing. axe compares whole words, so "col"
   * inside "column" does not count -- and neither does it here.
   */
  test('every word on a table toolbar button is a word of its name', () => {
    const bar = new TableToolbar(
      document,
      { onCommand: () => undefined, onDismiss: () => undefined },
      DEFAULT_LABELS,
    );

    for (const button of bar.element.querySelectorAll('button')) {
      const name = new Set(
        (button.getAttribute('aria-label') ?? '').toLowerCase().match(/\p{L}+/gu) ?? [],
      );

      for (const word of button.textContent?.toLowerCase().match(/\p{L}+/gu) ?? []) {
        expect(name.has(word), `"${button.textContent}" in "${[...name].join(' ')}"`).toBe(true);
      }
    }
  });
});

describe('a URL field reads left to right in a right-to-left dialog', () => {
  /**
   * Portals take the editor's direction, so under dir="rtl" the URL fields did
   * too, and the bidi algorithm reordered what they held: Chromium and WebKit
   * showed `https://example.com/docs?` as `?https://example.com/docs` and
   * `/sample.png` as `sample.png/`. happy-dom has no bidi, so the attribute
   * that decides it is what is pinned. The alt text is prose in the reader's
   * language and keeps inheriting.
   */
  /*
   * Only while the field holds a URL, though. Forcing it LTR unconditionally
   * also forced the *placeholder* LTR, which is prose in the reader's language:
   * in an RTL dialog a translated `imageUrlPlaceholder` was left-aligned with
   * its ellipsis on the wrong side, in all three engines, while the alt field
   * beside it rendered correctly. An empty field therefore carries no `dir` of
   * its own (an empty value is the same as none), and inherits the dialog's.
   * Not `unicode-bidi: plaintext`: Firefox stops painting the placeholder.
   */
  const hooks = { onApply: () => undefined, onRemove: () => undefined, onCancel: () => undefined };
  const at = new DOMRect(0, 0, 10, 10);
  const dirOf = (input: HTMLInputElement): string => input.getAttribute('dir') ?? '';

  function type(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function link(): { dialog: LinkEditor; input: HTMLInputElement } {
    const dialog = new LinkEditor(document, hooks, DEFAULT_LABELS);
    document.body.append(dialog.element);

    return { dialog, input: dialog.element.querySelector('input')! };
  }

  function image(): { dialog: ImageEditor; src: HTMLInputElement; alt: HTMLInputElement } {
    const dialog = new ImageEditor(document, hooks, DEFAULT_LABELS);
    document.body.append(dialog.element);
    const [src, alt] = dialog.element.querySelectorAll('input');

    return { dialog, src: src!, alt: alt! };
  }

  test('an empty link field inherits the direction, so its placeholder does', () => {
    const { dialog, input } = link();

    dialog.open(at, null);

    expect(dirOf(input)).toBe('');
  });

  test('a link field holding a URL is LTR', () => {
    const { dialog, input } = link();

    dialog.open(at, 'https://example.com/docs?');

    expect(dirOf(input)).toBe('ltr');
  });

  test('the link field follows what is typed into it, both ways', () => {
    const { dialog, input } = link();
    dialog.open(at, null);

    type(input, 'h');
    expect(dirOf(input)).toBe('ltr');

    type(input, '');
    expect(dirOf(input)).toBe('');
  });

  test('reopening the link field empty after a URL drops the LTR again', () => {
    const { dialog, input } = link();
    dialog.open(at, 'https://example.com');
    dialog.close();

    dialog.open(at, null);

    expect(dirOf(input)).toBe('');
  });

  test('an empty image URL field inherits the direction, so its placeholder does', () => {
    const { dialog, src, alt } = image();

    dialog.open(at, { src: '', alt: '' });

    expect(dirOf(src)).toBe('');
    expect(alt.hasAttribute('dir')).toBe(false);
  });

  test('an image URL field holding a source is LTR, and the alt field is left alone', () => {
    const { dialog, src, alt } = image();

    dialog.open(at, { src: '/sample.png', alt: 'نص بديل' });

    expect(dirOf(src)).toBe('ltr');
    expect(alt.hasAttribute('dir')).toBe(false);
  });

  test('the image URL field follows what is typed into it, both ways', () => {
    const { dialog, src, alt } = image();
    dialog.open(at, { src: '', alt: '' });

    type(src, '/');
    expect(dirOf(src)).toBe('ltr');

    type(src, '');
    expect(dirOf(src)).toBe('');

    // The alt text is prose in the reader's language and never gets a dir.
    type(alt, 'A cat');
    expect(alt.hasAttribute('dir')).toBe(false);
  });

  test('reopening the image URL field empty after a source drops the LTR again', () => {
    const { dialog, src } = image();
    dialog.open(at, { src: '/sample.png', alt: '' });
    dialog.close();

    dialog.open(at, { src: '', alt: '' });

    expect(dirOf(src)).toBe('');
  });
});

describe('the link dialog keeps its field on the first line', () => {
  /**
   * The dialog wraps so the error, at flex-basis 100%, takes a line of its
   * own. With the input at `flex: 1 1 auto` its intrinsic width was its basis,
   * so with Remove showing the row overflowed at 320px (375px with a 20px root
   * font) and the input dropped to a line of its own. happy-dom computes no
   * layout, so the basis is what is pinned: only the error may claim a line.
   */
  test('the input grows from a zero basis', () => {
    const body = ruleBody('.neditor-link-editor__input');

    expect(body).toMatch(/\bflex: 1 1 0(px)?;/);
    expect(body).not.toMatch(/flex(-basis)?:[^;]*\bauto\b/);
  });
});

describe('a URL dialog describes its field only once there is something to say', () => {
  /**
   * `aria-describedby` pointed at the hidden error from the moment the dialog
   * was built. Accessible-description computation follows a reference into a
   * hidden node, so every opening read "That is not a URL this editor can use"
   * before anything had been typed.
   *
   * A rejection is then said exactly once, and which mechanism says it depends
   * on where focus was. Enter in the URL field leaves focus where it is, so
   * the field's new description is not read and the alert has to speak. From
   * Apply -- or Enter in the alt field -- focus moves into the URL field, which
   * reads its description on arrival; filling the alert in the same tick as
   * well made the reader say the message twice.
   */
  type Dialog = LinkEditor | ImageEditor;

  function build(kind: 'link' | 'image'): {
    dialog: Dialog;
    input: HTMLInputElement;
    error: HTMLElement;
    alert: HTMLElement;
  } {
    // Rejects every URL, as the editor does for one it cannot use.
    const hooks = {
      onApply: () => dialog.markInvalid(),
      onRemove: () => undefined,
      onCancel: () => undefined,
    };
    const dialog: Dialog =
      kind === 'link'
        ? new LinkEditor(document, hooks, DEFAULT_LABELS)
        : new ImageEditor(document, hooks, DEFAULT_LABELS);
    document.body.append(dialog.element);

    if (dialog instanceof LinkEditor) {
      dialog.open(new DOMRect(0, 0, 10, 10), null);
    } else {
      dialog.open(new DOMRect(0, 0, 10, 10), { src: '', alt: '' });
    }

    const input = dialog.element.querySelector('input')!;
    input.value = 'My Document.pdf';

    return {
      dialog,
      input,
      error: dialog.element.querySelector<HTMLElement>('[class$="__error"]')!,
      alert: dialog.element.querySelector<HTMLElement>('[role="alert"]')!,
    };
  }

  const kinds = ['link', 'image'] as const;

  test.each(kinds)('%s: an untouched field has no description', (kind) => {
    const { input, alert } = build(kind);

    expect(input.hasAttribute('aria-describedby')).toBe(false);
    expect(alert, 'a live region exists before anything is written to it').not.toBeNull();
    expect(alert.textContent).toBe('');
  });

  test.each(kinds)('%s: Enter in the URL field is announced by the alert', (kind) => {
    const { input, error, alert } = build(kind);

    press(input, 'Enter');

    expect(document.activeElement).toBe(input);
    expect(alert.textContent).toBe(DEFAULT_LABELS.invalidUrl);
    // And the field carries it from now on, for when focus comes back to it.
    expect(input.getAttribute('aria-describedby')).toBe(error.id);
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(DEFAULT_LABELS.invalidUrl);
  });

  test.each(kinds)(
    '%s: from Apply, focus and the description say it, the alert does not',
    (kind) => {
      const { dialog, input, error, alert } = build(kind);
      const apply = dialog.element.querySelector<HTMLButtonElement>(
        '.neditor-link-editor__button:not(.neditor-link-editor__button--remove)',
      )!;

      apply.focus();
      expect(document.activeElement).toBe(apply);
      apply.click();

      expect(document.activeElement, 'focus moves to the field').toBe(input);
      expect(input.getAttribute('aria-describedby')).toBe(error.id);
      expect(error.hidden).toBe(false);
      expect(error.textContent).toBe(DEFAULT_LABELS.invalidUrl);
      // The visible message must not be a live region itself, or showing it
      // would announce it a second time.
      expect(error.closest('[role="alert"], [aria-live]')).toBeNull();
      expect(alert.textContent, 'nothing for the alert to say').toBe('');
    },
  );

  test('image: Enter in the alt field moves focus, so the alert stays quiet too', () => {
    const { dialog, input, alert } = build('image');
    const altField = dialog.element.querySelectorAll('input')[1]!;

    altField.focus();
    press(altField, 'Enter');

    expect(document.activeElement).toBe(input);
    expect(alert.textContent).toBe('');
  });

  test.each(kinds)('%s: a second rejection is announced again', async (kind) => {
    const { input, alert } = build(kind);
    press(input, 'Enter');

    // A live region speaks when its content changes. The message is the same
    // words both times, so it has to be written again, not left in place.
    const changes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => changes.push(...records));
    observer.observe(alert, { childList: true, characterData: true, subtree: true });

    press(input, 'Enter');
    await Promise.resolve();
    observer.disconnect();

    expect(changes.length).toBeGreaterThan(0);
    expect(alert.textContent).toBe(DEFAULT_LABELS.invalidUrl);
  });

  test.each(kinds)('%s: reopening takes the description away again', (kind) => {
    const { dialog, input, alert } = build(kind);
    press(input, 'Enter');
    dialog.close();

    if (dialog instanceof LinkEditor) {
      dialog.open(new DOMRect(0, 0, 10, 10), null);
    } else {
      dialog.open(new DOMRect(0, 0, 10, 10), { src: '', alt: '' });
    }

    expect(input.hasAttribute('aria-describedby')).toBe(false);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(alert.textContent).toBe('');
  });
});

/* ---------------------------------------------------------- read-only -- */

describe('a read-only document offers nothing it cannot do', () => {
  /** The selector the stylesheet draws placeholders with, minus the pseudo-element. */
  function placeholderSelector(): string {
    const match = /\n(\.neditor-block__content[^\n{]*):empty::before \{/.exec(NEDITOR_STYLES);

    expect(match, 'the placeholder rule').not.toBeNull();

    return `${match![1]}:empty`;
  }

  const blocks = (): Block[] => [
    block({ type: 'heading1' }),
    block({ type: 'image', src: 'https://example.com/a.png', alt: 'A' }),
    block({ type: 'table', rows: [[[], []]] }),
  ];

  /**
   * Generated content is part of an element's accessible name, so a read-only
   * figure with no caption was announced as "Add a caption" -- an instruction
   * nobody could follow -- and every empty heading as "Heading 1". happy-dom
   * paints no pseudo-elements, so this asks whether the stylesheet's own
   * selector matches the hosts the renderer produced.
   */
  test('placeholders are drawn only on hosts that take typing', () => {
    const editable = mount(blocks());
    const readOnly = mount(blocks(), { editable: false });
    const selector = placeholderSelector();

    const hosts = (editor: NEditor): HTMLElement[] => [
      ...editor.element.querySelectorAll<HTMLElement>('[data-placeholder]'),
    ];

    expect(hosts(editable).length).toBeGreaterThan(0);

    for (const host of hosts(editable)) {
      expect(host.matches(selector), `${host.tagName} while editable`).toBe(true);
    }

    for (const host of hosts(readOnly)) {
      expect(host.matches(selector), `${host.tagName} while read-only`).toBe(false);
    }
  });

  test('and come back when the document becomes editable again', () => {
    const editor = mount(blocks(), { editable: false });
    editor.setEditable(true);

    for (const host of editor.element.querySelectorAll<HTMLElement>('[data-placeholder]')) {
      expect(host.matches(placeholderSelector())).toBe(true);
    }
  });

  /**
   * The icon picker refuses to open while read-only, so an enabled callout icon
   * was a tab stop that did nothing when pressed -- unlike the two image
   * buttons beside it, which were already disabled for the same reason.
   */
  test('the callout icon is disabled while read-only, and enabled again after', () => {
    const editor = mount([block({ type: 'callout', content: [{ text: 'c' }] })], {
      editable: false,
    });
    const icon = (): HTMLButtonElement =>
      editor.element.querySelector<HTMLButtonElement>('.neditor-block__icon')!;

    expect(icon().disabled).toBe(true);

    editor.setEditable(true);

    expect(icon().disabled).toBe(false);
  });

  test('a disabled icon does not look pressable', () => {
    expect(NEDITOR_STYLES).toMatch(/\.neditor-block__icon:disabled[^{]*\{[^}]*cursor: default;/);
  });
});

describe('a read-only view shows no authoring prompt for an empty image', () => {
  /*
   * The README promises a read-only view shows no authoring prompts, and the
   * empty image's "Add an image" button was still drawn there -- disabled, but
   * exposed to assistive technology as a button by that name in all three
   * engines. The literal scenario: an empty image in an `editable: false`
   * editor, then the editor made editable again.
   */
  const named = (editor: NEditor, name: string): HTMLButtonElement[] =>
    [...editor.element.querySelectorAll('button')].filter(
      (button) => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === name,
    );

  test('no "Add an image" button exists while read-only, and it returns with editing', () => {
    const editor = mount([block({ type: 'image', src: '', alt: '' })], { editable: false });

    expect(named(editor, DEFAULT_LABELS.imageAdd)).toHaveLength(0);
    expect(editor.element.querySelector('figure.neditor-image')).not.toBeNull();

    editor.setEditable(true);

    const [add] = named(editor, DEFAULT_LABELS.imageAdd);
    expect(add).toBeDefined();
    expect(add!.disabled).toBe(false);

    editor.setEditable(false);

    expect(named(editor, DEFAULT_LABELS.imageAdd)).toHaveLength(0);
  });
});
