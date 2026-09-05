// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';

import type { Block } from './index.ts';
import { createEditor } from './index.ts';
import { positionPortal } from './ui/portal.ts';
import type { NEditor } from './editor.ts';

/**
 * Portals and pointer gestures, which are the two things the editor cannot see.
 *
 * A portal renders outside the editor root and takes focus away from it, so no
 * listener on the root ever hears that the user moved on: dismissal has to be
 * driven from the document, and it has to know which block the popover belongs
 * to before it hands the caret back. A pointer gesture is not one event either
 * — a drag ends by firing a click, and a touch pointer ends by firing the same
 * `pointerleave` a mouse uses to say "gone" — so the handlers have to be told
 * which half of the gesture they are looking at.
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

const cell = (editor: NEditor, coords: string): HTMLElement =>
  editor.element.querySelector<HTMLElement>(`[data-cell="${coords}"]`)!;

const portal = (className: string): HTMLElement =>
  document.querySelector<HTMLElement>(`.${className}`)!;

const gutterOf = (editor: NEditor): HTMLElement =>
  editor.element.querySelector<HTMLElement>('.neditor-gutter')!;

/** Selects `[start, end)` of a host's first text node, the way a mouse would. */
function selectIn(host: HTMLElement, start: number, end: number): void {
  const text = host.firstChild ?? host;
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  host.focus();
}

function press(host: HTMLElement, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  host.dispatchEvent(event);

  return event.defaultPrevented;
}

function pointer(type: string, target: EventTarget, init: PointerEventInit = {}): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerType: 'mouse',
      pointerId: 1,
      ...init,
    }),
  );
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

const optionIds = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.id);

describe('the slash menu announces the option it will commit', () => {
  test('an arrow key moves aria-activedescendant with the highlight', () => {
    const editor = mount([block({})]);
    const content = hosts(editor)[0]!;
    content.focus();
    typeSlash(content);

    const options = optionIds();

    expect(content.getAttribute('aria-activedescendant')).toBe(options[0]);

    press(content, 'ArrowDown');

    // The menu consumes arrow keys itself and returns before any of the
    // editor's own key handling runs, so nothing downstream can refresh the
    // attribute: a reader announced "Text" for every press while the highlight
    // walked the list, and Enter committed a type it had never named.
    expect(document.querySelector<HTMLElement>('[data-active="true"]')?.id).toBe(options[1]);
    expect(content.getAttribute('aria-activedescendant')).toBe(options[1]);
  });

  test('ArrowUp wrapping to the end of the list is announced too', () => {
    const editor = mount([block({})]);
    const content = hosts(editor)[0]!;
    content.focus();
    typeSlash(content);

    press(content, 'ArrowUp');

    expect(content.getAttribute('aria-activedescendant')).toBe(optionIds().at(-1));
  });

  test('the announced option is the one Enter commits', () => {
    const editor = mount([block({ id: 'only' })]);
    const content = hosts(editor)[0]!;
    content.focus();
    typeSlash(content);

    press(content, 'ArrowDown');

    const announced = document.getElementById(content.getAttribute('aria-activedescendant') ?? '');
    const label = announced?.querySelector('.neditor-slash-menu__label')?.textContent;

    press(content, 'Enter');

    expect(label).toBe('Heading 1');
    expect(editor.getDocument().blocks[0]?.type).toBe('heading1');
  });

  test('a mouse crossing an option announces that option', () => {
    const editor = mount([block({})]);
    const content = hosts(editor)[0]!;
    content.focus();
    typeSlash(content);

    const third = [...document.querySelectorAll<HTMLElement>('[role="option"]')][2]!;
    const id = third.id;
    third.dispatchEvent(new MouseEvent('mouseenter'));

    // Hover moves the highlight without any key ever being pressed, so this is
    // the one path that reaches nothing in the editor at all.
    expect(content.getAttribute('aria-activedescendant')).toBe(id);
  });

  test('the highlight is announced against the filtered list, not the full one', () => {
    const editor = mount([block({})]);
    const content = hosts(editor)[0]!;
    content.focus();
    typeSlash(content);

    content.textContent = '/head';
    getSelection()?.collapse(content.firstChild, 5);
    content.dispatchEvent(
      new InputEvent('input', { inputType: 'insertText', data: 'd', bubbles: true }),
    );

    press(content, 'ArrowDown');

    // Option ids are positions in the list as it stands, so an announcement
    // that survived the filter would now name a different command entirely.
    const announced = document.getElementById(content.getAttribute('aria-activedescendant') ?? '');

    expect(announced?.querySelector('.neditor-slash-menu__label')?.textContent).toBe('Heading 2');
  });
});

describe('a popover is dismissed by a pointer that lands outside it', () => {
  function openLink(editor: NEditor, host: HTMLElement): HTMLElement {
    selectIn(host, 0, 3);
    editor.openLinkEditor();

    return portal('neditor-link-editor');
  }

  test('the link popover closes on a pointer elsewhere in the page', () => {
    const editor = mount([block({ content: [{ text: 'abc' }] })]);
    const popover = openLink(editor, hosts(editor)[0]!);

    expect(popover.hidden).toBe(false);

    pointer('pointerdown', document.body);

    // Nothing on the editor root can hear this click: the popover is a
    // role="dialog" in document.body, and without a dismissal it stays open for
    // the rest of the session still pointing at the block it was opened from.
    expect(popover.hidden).toBe(true);
  });

  test('a pointer inside the link popover leaves it open', () => {
    const editor = mount([block({ content: [{ text: 'abc' }] })]);
    const popover = openLink(editor, hosts(editor)[0]!);

    pointer('pointerdown', popover.querySelector('input')!);

    expect(popover.hidden).toBe(false);
  });

  test('dismissing from outside does not drag the caret back', () => {
    const editor = mount([
      block({ content: [{ text: 'abc' }] }),
      block({ content: [{ text: 'def' }] }),
    ]);
    const [first, second] = hosts(editor);
    const popover = openLink(editor, first!);

    pointer('pointerdown', second!);

    expect(popover.hidden).toBe(true);
    // The pointer is placing focus itself; restoring the popover's range would
    // take the caret off the block the user just pointed at.
    expect(document.activeElement).not.toBe(first);
  });

  test('the icon picker closes on a pointer elsewhere in the page', () => {
    const editor = mount([block({ type: 'callout', content: [{ text: 'note' }] })]);
    const icon = editor.element.querySelector<HTMLElement>('.neditor-block__icon')!;

    icon.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const popover = portal('neditor-icon-picker');

    expect(popover.hidden).toBe(false);

    pointer('pointerdown', document.body);

    expect(popover.hidden).toBe(true);
  });

  test('the image popover closes on a pointer elsewhere in the page', () => {
    const editor = mount([block({ type: 'image' })]);
    const placeholder = editor.element.querySelector<HTMLElement>('.neditor-image__placeholder')!;

    placeholder.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const popover = portal('neditor-image-editor');

    expect(popover.hidden).toBe(false);

    pointer('pointerdown', document.body);

    expect(popover.hidden).toBe(true);
  });

  test('a pointer inside the image popover leaves it open', () => {
    const editor = mount([block({ type: 'image' })]);
    const placeholder = editor.element.querySelector<HTMLElement>('.neditor-image__placeholder')!;

    placeholder.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const popover = portal('neditor-image-editor');
    pointer('pointerdown', popover.querySelector('input')!);

    expect(popover.hidden).toBe(false);
  });
});

describe('Escape dismisses only the popover this host opened', () => {
  test('Escape in another block leaves a popover it never opened', () => {
    const editor = mount([
      block({ id: 'a', content: [{ text: 'abc' }] }),
      block({ id: 'b', content: [{ text: 'def' }] }),
    ]);
    const [first, second] = hosts(editor);
    selectIn(first!, 0, 3);
    editor.openLinkEditor();

    // The caret moves on without a pointer, so nothing has dismissed the
    // popover: it is stale, and still none of this block's business.
    editor.focus('b', 0);
    press(second!, 'Escape');

    // Escape stepped up from the text to the block, exactly as it does with
    // nothing open. Closing the other block's popover would have restored its
    // range instead, teleporting the caret two blocks away.
    expect(editor.getSelectedBlocks()).toEqual(['b']);
    expect(portal('neditor-link-editor').hidden).toBe(false);
    expect(document.activeElement).not.toBe(first);
  });

  test('Escape in the block that opened the popover still dismisses it', () => {
    const editor = mount([block({ id: 'a', content: [{ text: 'abc' }] })]);
    const host = hosts(editor)[0]!;
    selectIn(host, 0, 3);
    editor.openLinkEditor();

    press(host, 'Escape');

    expect(portal('neditor-link-editor').hidden).toBe(true);
    expect(document.activeElement).toBe(host);
    expect(editor.getSelectedBlocks()).toEqual([]);
  });

  test('Escape in another cell of the same table leaves that cell alone', () => {
    const editor = mount([
      block({
        id: 'grid',
        type: 'table',
        rows: [
          [[{ text: 'A' }], [{ text: 'B' }]],
          [[{ text: 'C' }], [{ text: 'D' }]],
        ],
      }),
    ]);

    selectIn(cell(editor, '0:0'), 0, 1);
    editor.openLinkEditor();

    // A cell is its own editing host, so the block id alone does not say whose
    // popover this is: restoring its range would jump the caret to the header.
    const other = cell(editor, '1:1');
    selectIn(other, 0, 1);
    press(other, 'Escape');

    expect(portal('neditor-link-editor').hidden).toBe(false);
    expect(editor.getSelectedBlocks()).toEqual(['grid']);
    expect(document.activeElement).not.toBe(cell(editor, '0:0'));
  });
});

describe('a gutter offered to a finger stays until the finger moves on', () => {
  test('the gutter survives the pointerleave that follows a touch lifting', () => {
    const editor = mount([block({ content: [{ text: 'a' }] })]);
    const host = hosts(editor)[0]!;

    pointer('pointerdown', host, { pointerType: 'touch', clientX: 10, clientY: 10 });

    expect(gutterOf(editor).dataset.visible).toBe('true');

    pointer('pointerup', document, { pointerType: 'touch', clientX: 10, clientY: 10 });
    // A touch pointer stops existing when the finger lifts, and the UA reports
    // that as pointerout/pointerleave — the same event a mouse sends when it
    // leaves. Hiding on it took the + and the handle away in the same frame
    // they were offered, so touch could never reach either.
    editor.element.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'touch' }));

    expect(gutterOf(editor).dataset.visible).toBe('true');
  });

  test('a mouse leaving the editor still retracts the gutter', () => {
    const editor = mount([block({ content: [{ text: 'a' }] })]);
    const blockRoot = editor.element.querySelector('.neditor-block')!;

    pointer('pointerover', blockRoot);

    expect(gutterOf(editor).dataset.visible).toBe('true');

    editor.element.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));

    expect(gutterOf(editor).dataset.visible).toBe('false');
  });
});

describe('the click that ends a drag is part of the drag', () => {
  function handleOf(editor: NEditor): HTMLElement {
    pointer('pointerover', editor.element.querySelector('.neditor-block')!, { pointerId: 2 });

    return editor.element.querySelector<HTMLElement>('.neditor-gutter__handle')!;
  }

  function dragHandle(handle: HTMLElement, pointerId: number): void {
    pointer('pointerdown', handle, { pointerId, button: 0, clientY: 0 });
    pointer('pointermove', document, { pointerId, clientY: 200 });
    pointer('pointerup', document, { pointerId, clientY: 200 });
  }

  test('a dragged multi-block selection survives the synthetic click', () => {
    const editor = mount([
      block({ id: 'a', content: [{ text: 'a' }] }),
      block({ id: 'b', content: [{ text: 'b' }] }),
      block({ id: 'c', content: [{ text: 'c' }] }),
    ]);

    editor.selectBlocks(['a', 'b', 'c']);

    const handle = handleOf(editor);
    dragHandle(handle, 2);

    // The handle took the pointer capture, so the compatibility click that
    // follows pointerup is dispatched at it rather than wherever the pointer
    // came to rest — and the gutter's click hook selected the one block whose
    // handle was grabbed, throwing away the selection just dropped.
    handle.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(editor.getSelectedBlocks()).toHaveLength(3);
  });

  test('a handle press that never moved still selects its block', () => {
    const editor = mount([
      block({ id: 'a', content: [{ text: 'a' }] }),
      block({ id: 'b', content: [{ text: 'b' }] }),
    ]);

    const handle = handleOf(editor);
    pointer('pointerdown', handle, { pointerId: 2, button: 0, clientY: 0 });
    pointer('pointerup', document, { pointerId: 2, clientY: 0 });
    handle.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(editor.getSelectedBlocks()).toEqual(['a']);
  });

  test('only the drag its own click is swallowed', () => {
    const editor = mount([
      block({ id: 'a', content: [{ text: 'a' }] }),
      block({ id: 'b', content: [{ text: 'b' }] }),
      block({ id: 'c', content: [{ text: 'c' }] }),
    ]);

    editor.selectBlocks(['a', 'b', 'c']);

    const handle = handleOf(editor);
    dragHandle(handle, 2);
    handle.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // The next press is a new gesture. A suppression that outlived its own
    // click would make the handle look dead from here on.
    pointer('pointerdown', handle, { pointerId: 3, button: 0, clientY: 0 });
    pointer('pointerup', document, { pointerId: 3, clientY: 0 });
    handle.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(editor.getSelectedBlocks()).toHaveLength(1);
  });
});

describe('a popover in a shadow root is not dismissed by its own pointer', () => {
  /** Mounts into a shadow root, the way a custom element embeds the editor. */
  function mountInShadow(blocks: Block[]): { editor: NEditor; shadow: ShadowRoot } {
    const wrapper = document.createElement('div');
    document.body.append(wrapper);
    const shadow = wrapper.attachShadow({ mode: 'open' });
    const host = document.createElement('div');
    shadow.append(host);
    const editor = createEditor({ element: host, doc: { blocks } });
    editors.push(editor);

    return { editor, shadow };
  }

  /**
   * A pointerdown as a listener on the *document* really receives one.
   *
   * happy-dom hands that listener the node that was actually hit, which is the
   * one thing a browser never does: an event that crossed a shadow boundary is
   * retargeted, and `target` is reported as the shadow host. The pair the DOM
   * spec requires is therefore built by hand — `target` pinned to the host by
   * dispatching there, `composedPath()` still answering with the real path from
   * the node outwards — because that pair is the whole of the bug.
   */
  function retargetedPointerDown(node: Node, host: Element): void {
    const path: EventTarget[] = [];

    for (let step: Node | null = node; step;) {
      path.push(step);
      step = step.parentNode ?? ((step as ShadowRoot).host as Node | undefined) ?? null;
    }

    path.push(window);

    const event = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: 'mouse',
      pointerId: 1,
    });

    Object.defineProperty(event, 'composedPath', { value: () => path });
    host.dispatchEvent(event);
  }

  function openLinkIn(shadow: ShadowRoot, editor: NEditor, host: HTMLElement): HTMLElement {
    selectIn(host, 0, 3);
    editor.openLinkEditor();

    return shadow.querySelector<HTMLElement>('.neditor-link-editor')!;
  }

  const shadowHosts = (shadow: ShadowRoot): HTMLElement[] => [
    ...shadow.querySelectorAll<HTMLElement>('.neditor-block__content'),
  ];

  test('a pointer in the popover input leaves it open', () => {
    const { editor, shadow } = mountInShadow([block({ content: [{ text: 'abc' }] })]);
    const popover = openLinkIn(shadow, editor, shadowHosts(shadow)[0]!);

    expect(popover.hidden).toBe(false);

    retargetedPointerDown(popover.querySelector('input')!, shadow.host);

    // The portal lives in the shadow root, so the document is told the pointer
    // landed on the host element and `contains` answers "outside" for a click
    // that landed squarely inside the field. Clicking in to type a URL closed
    // the editor and discarded the edit.
    expect(popover.hidden).toBe(false);
  });

  test('a pointer elsewhere in the shadow root still dismisses it', () => {
    const { editor, shadow } = mountInShadow([
      block({ content: [{ text: 'abc' }] }),
      block({ content: [{ text: 'def' }] }),
    ]);
    const [first, second] = shadowHosts(shadow);
    const popover = openLinkIn(shadow, editor, first!);

    retargetedPointerDown(second!, shadow.host);

    // Same retargeted target, opposite answer: reading the path rather than
    // the target must not cost the dismissal it was added for.
    expect(popover.hidden).toBe(true);
  });

  test('a pointer outside the shadow root still dismisses it', () => {
    const { editor, shadow } = mountInShadow([block({ content: [{ text: 'abc' }] })]);
    const popover = openLinkIn(shadow, editor, shadowHosts(shadow)[0]!);

    pointer('pointerdown', document.body);

    expect(popover.hidden).toBe(true);
  });
});

describe('Escape closes a dialog from anywhere inside it', () => {
  /**
   * All three of these carry `role="dialog"`, and bound Escape to their text
   * input alone. Focus on a preset swatch or an Apply button -- and those
   * buttons are the last tab stops in the document, since the portals mount on
   * `document.body` -- and Escape did nothing, leaving the dialog open over the
   * editor with nowhere left to tab.
   */
  const escape = (from: HTMLElement): boolean =>
    !from.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );

  test('the icon picker closes from a preset swatch', () => {
    const editor = mount([block({ type: 'callout', content: [{ text: 'note' }] })]);
    editor.element
      .querySelector<HTMLElement>('.neditor-block__icon')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const popover = portal('neditor-icon-picker');
    const swatch = popover.querySelector<HTMLElement>('.neditor-icon-picker__icon')!;

    expect(popover.hidden).toBe(false);
    expect(escape(swatch), 'the dialog must consume the key it acts on').toBe(true);
    expect(popover.hidden).toBe(true);
  });

  test('the image editor closes from its Apply button', () => {
    const editor = mount([block({ type: 'image' })]);
    editor.element
      .querySelector<HTMLElement>('.neditor-image__placeholder')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const popover = portal('neditor-image-editor');
    const button = popover.querySelector<HTMLElement>('button')!;

    expect(popover.hidden).toBe(false);
    expect(escape(button)).toBe(true);
    expect(popover.hidden).toBe(true);
  });

  test('the link editor closes from its Apply button', () => {
    const editor = mount([block({ content: [{ text: 'linkable' }] })]);
    selectIn(hosts(editor)[0]!, 0, 4);
    editor.openLinkEditor();

    const popover = portal('neditor-link-editor');
    const button = popover.querySelector<HTMLElement>('button')!;

    expect(popover.hidden).toBe(false);
    expect(escape(button)).toBe(true);
    expect(popover.hidden).toBe(true);
  });

  test('the text input inside one still closes it too', () => {
    const editor = mount([block({ type: 'callout', content: [{ text: 'note' }] })]);
    editor.element
      .querySelector<HTMLElement>('.neditor-block__icon')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const popover = portal('neditor-icon-picker');

    expect(escape(popover.querySelector<HTMLElement>('input')!)).toBe(true);
    expect(popover.hidden).toBe(true);
  });
});

describe('floating UI answers to the ground it was placed against', () => {
  /**
   * Portals are `position: fixed` and are given viewport coordinates once, when
   * they open. Nothing listened for scroll or resize, so after any scroll they
   * sat over whatever content had moved under them -- still live, still acting
   * on the block they were opened from, and pointing at something else.
   */
  const openIconPicker = (): HTMLElement => {
    const editor = mount([block({ type: 'callout', content: [{ text: 'note' }] })]);
    editor.element
      .querySelector<HTMLElement>('.neditor-block__icon')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    return portal('neditor-icon-picker');
  };

  test('a scroll anywhere in the page dismisses an open popover', () => {
    const popover = openIconPicker();

    expect(popover.hidden).toBe(false);

    // From an element, which is where the scroll of a mounted pane comes from
    // -- and scroll events do not bubble, which is why the listener captures.
    document.body.dispatchEvent(new Event('scroll', { bubbles: false }));

    expect(popover.hidden).toBe(true);
  });

  test('so does a resize, which is what an opening keyboard looks like', () => {
    const popover = openIconPicker();

    expect(popover.hidden).toBe(false);

    window.dispatchEvent(new Event('resize'));

    expect(popover.hidden).toBe(true);
  });
});

describe('the portal measures the viewport the user can actually see', () => {
  /**
   * `innerHeight` does not shrink when a software keyboard opens -- that is
   * what `visualViewport` reports -- so the menu was placed into the space the
   * keyboard covers and never flipped above it.
   */
  test('a shrunken visual viewport pushes the menu above the anchor', () => {
    const element = document.createElement('div');
    element.style.position = 'fixed';
    document.body.append(element);
    element.getBoundingClientRect = () => new DOMRect(0, 0, 320, 320);

    const original = window.visualViewport;
    Object.defineProperty(window, 'visualViewport', {
      value: { width: 390, height: 408, offsetTop: 0 },
      configurable: true,
    });

    // A caret at y=300: 108px of visible viewport below it, not enough for a
    // 320px menu, but 300px above it -- which is where it has to go.
    positionPortal(element, new DOMRect(20, 300, 1, 20), { prefer: 'below' });

    const top = Number.parseInt(element.style.top, 10);

    expect(top + 320, 'the menu must not run under the keyboard').toBeLessThanOrEqual(408);

    Object.defineProperty(window, 'visualViewport', { value: original, configurable: true });
    element.remove();
  });
});

describe('the slash menu is dismissed like every other popover', () => {
  /**
   * It was left out of `#openPopovers()`, so it was the one popover an outside
   * pointer never closed -- clicking away left it `position: fixed` at z-index
   * 1000 over the page, outliving the caret that opened it.
   */
  const openSlashMenu = (): { editor: NEditor; menu: HTMLElement } => {
    const editor = mount([block({ id: 'a', content: [] })]);
    const host = hosts(editor)[0]!;
    host.focus();
    host.textContent = '/';
    const range = document.createRange();
    range.setStart(host.firstChild!, 1);
    range.collapse(true);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    host.dispatchEvent(
      new InputEvent('input', { inputType: 'insertText', data: '/', bubbles: true }),
    );

    return { editor, menu: portal('neditor-slash-menu') };
  };

  test('a pointer elsewhere in the page closes it', () => {
    const { menu } = openSlashMenu();

    expect(menu.hidden).toBe(false);

    pointer('pointerdown', document.body);

    expect(menu.hidden).toBe(true);
  });

  test('a pointer inside it does not', () => {
    const { menu } = openSlashMenu();

    pointer('pointerdown', menu);

    expect(menu.hidden).toBe(false);
  });
});

describe('the gutter follows the block it belongs to', () => {
  /**
   * The block reserves the gutter with `padding-inline-start` and carries its
   * nesting depth in `margin-inline-start` -- they were one summed `calc` until
   * that broke on a unitless gutter width. `#positionGutter` still read only
   * the padding, so the controls stopped following a nested block and sat at
   * the left edge for every one of them.
   */
  test('it is offset by the block indent as well as the gutter reservation', () => {
    const editor = mount([
      block({ id: 'flat', type: 'bulleted_list', content: [{ text: 'top' }] }),
      block({ id: 'deep', type: 'bulleted_list', depth: 2, content: [{ text: 'nested' }] }),
    ]);

    // happy-dom computes no layout, so the two contributions are stubbed
    // directly; the point under test is that both are read, not either alone.
    const views = [...editor.element.querySelectorAll<HTMLElement>('.neditor-block')];
    const offsets = new Map<HTMLElement, string>([
      [views[0]!, '0px'],
      [views[1]!, '48px'],
    ]);
    const original = Object.getOwnPropertyDescriptor(window, 'getComputedStyle');
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: HTMLElement) =>
        offsets.has(element)
          ? { paddingInlineStart: '44px', marginInlineStart: offsets.get(element) }
          : { paddingInlineStart: '0px', marginInlineStart: '0px' },
    });

    const gutter = gutterOf(editor);
    pointer('pointerover', views[1]!.querySelector<HTMLElement>('.neditor-block__content')!);
    const nested = gutter.style.insetInlineStart;

    pointer('pointerover', views[0]!.querySelector<HTMLElement>('.neditor-block__content')!);
    const flat = gutter.style.insetInlineStart;

    if (original) {
      Object.defineProperty(window, 'getComputedStyle', original);
    }

    expect(Number.parseFloat(flat)).toBe(44);
    expect(
      Number.parseFloat(nested),
      'a nested block puts its controls further in, not at the left edge',
    ).toBe(92);
  });
});

describe('a popover scrolling its own contents is not the ground moving', () => {
  /**
   * The dismissal listener captures scrolls from anywhere, and the slash menu
   * scrolls its own option list to keep the active item in view -- so arrowing
   * past the fold closed the menu. Only a scroll outside the portals counts.
   */
  test('the slash menu survives scrolling its own list', () => {
    const editor = mount([block({ id: 'a', content: [] })]);
    const host = hosts(editor)[0]!;
    host.focus();
    host.textContent = '/';
    const range = document.createRange();
    range.setStart(host.firstChild!, 1);
    range.collapse(true);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    host.dispatchEvent(
      new InputEvent('input', { inputType: 'insertText', data: '/', bubbles: true }),
    );

    const menu = portal('neditor-slash-menu');

    expect(menu.hidden).toBe(false);

    const list = menu.querySelector('.neditor-slash-menu__list') ?? menu;
    list.dispatchEvent(new Event('scroll', { bubbles: false }));

    expect(menu.hidden, 'the menu scrolling itself must not dismiss it').toBe(false);
  });

  test('but a scroll of the page still dismisses it', () => {
    const editor = mount([block({ id: 'a', content: [] })]);
    const host = hosts(editor)[0]!;
    host.focus();
    host.textContent = '/';
    const range = document.createRange();
    range.setStart(host.firstChild!, 1);
    range.collapse(true);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    host.dispatchEvent(
      new InputEvent('input', { inputType: 'insertText', data: '/', bubbles: true }),
    );

    const menu = portal('neditor-slash-menu');
    editor.element.dispatchEvent(new Event('scroll', { bubbles: false }));

    expect(menu.hidden).toBe(true);
  });
});
