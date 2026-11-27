// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { Block } from './index.ts';
import { createEditor } from './index.ts';
import { positionPortal, setAnchorBand } from './ui/portal.ts';
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

  /**
   * F3 (e2e finding). Every mouseenter rebuilt the whole list, so the option
   * under a resting pointer was replaced by a new element -- which Chromium
   * then sent a fresh mouseenter, and so on every ~50 ms. A press landed on
   * the list rather than an option, and a pixel of movement between down and
   * up split the click across two elements: the command never ran. Hover
   * moves the highlight on the options that are already there.
   */
  test('hovering an option moves the highlight without replacing the options', () => {
    const editor = mount([block({})]);
    const content = hosts(editor)[0]!;
    content.focus();
    typeSlash(content);

    const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    const before = options();
    const third = before[2]!;
    third.dispatchEvent(new MouseEvent('mouseenter'));
    third.dispatchEvent(new MouseEvent('mouseenter'));

    const after = options();
    expect(after).toHaveLength(before.length);
    expect(after.every((option, index) => option === before[index])).toBe(true);
    expect(third.getAttribute('aria-selected')).toBe('true');
    expect(before.filter((option) => option.getAttribute('aria-selected') === 'true')).toEqual([
      third,
    ]);
    expect(content.getAttribute('aria-activedescendant')).toBe(third.id);

    third.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(editor.getDocument().blocks[0]?.type).toBe('heading2');
  });

  test('arrowing keeps the same option elements as well', () => {
    const editor = mount([block({})]);
    const content = hosts(editor)[0]!;
    content.focus();
    typeSlash(content);

    const before = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    press(content, 'ArrowDown');
    const after = [...document.querySelectorAll<HTMLElement>('[role="option"]')];

    expect(after.every((option, index) => option === before[index])).toBe(true);
    expect(before[1]!.dataset.active).toBe('true');
    expect(before[0]!.dataset.active).toBeUndefined();
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
  test('Escape in another block acts on that block, not on a popover it never opened', () => {
    const editor = mount([
      block({ id: 'a', content: [{ text: 'abc' }] }),
      block({ id: 'b', content: [{ text: 'def' }] }),
    ]);
    const [first, second] = hosts(editor);
    selectIn(first!, 0, 3);
    editor.openLinkEditor();

    // The caret moves on without a pointer. Focus leaving the dialog for
    // anywhere else is leaving it (UI-2), so it closes -- and closes without
    // handing the caret back, which is the teleport this test is about.
    editor.focus('b', 0);
    expect(portal('neditor-link-editor').hidden).toBe(true);
    expect(document.activeElement).toBe(second);
    press(second!, 'Escape');

    // Escape stepped up from the text to the block, exactly as it does with
    // nothing open. Closing the other block's popover would have restored its
    // range instead, teleporting the caret two blocks away.
    expect(editor.getSelectedBlocks()).toEqual(['b']);
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

  test('Escape in another cell of the same table acts on that cell, not on the popover', () => {
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
    // Focus going to the other cell is leaving the dialog, which closes
    // without restoring the range it held (UI-2).
    const other = cell(editor, '1:1');
    selectIn(other, 0, 1);
    expect(portal('neditor-link-editor').hidden).toBe(true);
    press(other, 'Escape');

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

  test('a scroll dismisses a dialog the user has left', () => {
    const popover = openIconPicker();

    // Left without going anywhere: focus on nothing, the way the window losing
    // focus leaves it. Focus arriving somewhere else closes the dialog by
    // itself (UI-2), so that is no longer a way to leave one open.
    (document.activeElement as HTMLElement).blur();
    const elsewhere = document.activeElement;

    expect(popover.hidden).toBe(false);

    // From an element, which is where the scroll of a mounted pane comes from
    // -- and scroll events do not bubble, which is why the listener captures.
    document.body.dispatchEvent(new Event('scroll', { bubbles: false }));

    expect(popover.hidden).toBe(true);
    // A scroll is not the user choosing where to go, so focus stays put rather
    // than being pulled back into the block the dialog was opened from.
    expect(document.activeElement).toBe(elsewhere);
  });

  test('so does a resize', () => {
    const popover = openIconPicker();
    (document.activeElement as HTMLElement).blur();

    expect(popover.hidden).toBe(false);
    window.dispatchEvent(new Event('resize'));

    expect(popover.hidden).toBe(true);
  });

  /**
   * R10-PTR-1. An editor slotted into a web component whose shadow tree holds
   * the scrolling pane (Ionic's `<ion-content>`): a scroll in that tree is not
   * composed, so the document never hears it, and the editor listened only on
   * the shadow roots of its own root node -- which, slotted from the light
   * DOM, it has none of. The pane is reached through the slot, as the browser
   * lays it out, and is heard there; and let go of on `destroy`. happy-dom
   * assigns no slots (`assignedSlot` is undefined), so the assignment a
   * browser makes is stated on the mount point; the layout half -- the
   * toolbars and the drag's auto-scroll -- is pinned in e2e (TB5v, F8d, P16b).
   */
  const slottedEditor = (): { editor: NEditor; pane: HTMLElement; shadow: ShadowRoot } => {
    const component = document.createElement('div');
    const shadow = component.attachShadow({ mode: 'open' });
    const pane = document.createElement('div');
    const slot = document.createElement('slot');
    pane.append(slot);
    shadow.append(pane);
    document.body.append(component);

    const host = document.createElement('div');
    component.append(host);
    Object.defineProperty(host, 'assignedSlot', { value: slot, configurable: true });
    const editor = createEditor({
      element: host,
      doc: { blocks: [block({ type: 'callout', content: [{ text: 'note' }] })] },
    });
    editors.push(editor);

    return { editor, pane, shadow };
  };

  test('a scroll in the shadow pane an editor is slotted into is heard', () => {
    const { editor, pane } = slottedEditor();
    editor.element
      .querySelector<HTMLElement>('.neditor-block__icon')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const popover = portal('neditor-icon-picker');
    (document.activeElement as HTMLElement).blur();
    expect(popover.hidden).toBe(false);

    pane.dispatchEvent(new Event('scroll', { bubbles: false, composed: false }));

    expect(popover.hidden).toBe(true);
  });

  test('and the listener on that shadow root goes with destroy', () => {
    const { editor, shadow } = slottedEditor();
    const remove = vi.spyOn(shadow, 'removeEventListener');

    editor.destroy();

    expect(remove.mock.calls.map(([type]) => type)).toContain('scroll');
  });
});

describe('a dialog being typed into moves with the page instead of closing', () => {
  /**
   * The dialogs take focus. Dismissing one on a scroll handed focus back to the
   * block it came from in the middle of a word, so the rest of a URL being
   * typed into the image editor landed in the caption -- and a following Tab
   * indented the document. A resize is what an opening software keyboard looks
   * like on Android, so there a dialog closed the moment its own input was
   * focused, and none of the three could be used at all. A portal is
   * `position: fixed` and was placed once, which is why it was dismissed; it
   * is re-pinned against its anchor instead.
   */
  const scroll = (): void => {
    document.body.dispatchEvent(new Event('scroll', { bubbles: false }));
  };

  test('the image editor keeps its input and the typing stays in it', () => {
    const editor = mount([
      block({
        id: 'img',
        type: 'image',
        src: 'https://e.com/a.png',
        alt: 'a',
        content: [{ text: 'cap' }],
      }),
    ]);
    editor.element
      .querySelector<HTMLElement>('.neditor-image__trigger')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const popover = portal('neditor-image-editor');
    const input = popover.querySelector<HTMLInputElement>('input')!;

    expect(document.activeElement).toBe(input);

    scroll();

    expect(popover.hidden).toBe(false);
    expect(document.activeElement, 'focus must not be handed back to the caption').toBe(input);
    expect(editor.getDocument().blocks[0]!.content).toEqual([{ text: 'cap' }]);
  });

  test('the link editor survives a resize, which is what a keyboard opening looks like', () => {
    const editor = mount([block({ content: [{ text: 'abc' }] })]);
    selectIn(hosts(editor)[0]!, 0, 3);
    editor.openLinkEditor();
    const popover = portal('neditor-link-editor');
    const input = popover.querySelector<HTMLInputElement>('input')!;

    window.dispatchEvent(new Event('resize'));

    expect(popover.hidden).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  test('the icon picker follows its anchor to where it scrolled', () => {
    const editor = mount([block({ type: 'callout', content: [{ text: 'note' }] })]);
    const icon = editor.element.querySelector<HTMLElement>('.neditor-block__icon')!;
    let top = 300;
    // happy-dom computes no layout, so the anchor reports where it is by hand.
    icon.getBoundingClientRect = () => new DOMRect(40, top, 24, 24);
    icon.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const popover = portal('neditor-icon-picker');
    const before = Number.parseInt(popover.style.top, 10);

    top = 200;
    scroll();

    expect(popover.hidden).toBe(false);
    expect(Number.parseInt(popover.style.top, 10)).toBe(before - 100);
  });

  test('a dialog whose anchor is gone is dismissed', () => {
    const editor = mount([block({ type: 'callout', content: [{ text: 'note' }] })]);
    const icon = editor.element.querySelector<HTMLElement>('.neditor-block__icon')!;
    icon.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const popover = portal('neditor-icon-picker');

    icon.remove();
    scroll();

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

  /**
   * R11-PTR-3. In an iframe mount the portal's own viewport is the frame's
   * window, which reaches past what the page around the frame shows -- a
   * frame in a scrolling pane, or taller than the page's window. The table
   * toolbar, preferring to go above a caret near the top of what the pane
   * showed, found room in the frame's window and was drawn above the pane,
   * which clips the frame. The editor tells every portal the part that can
   * be seen (`setAnchorBand`), and the toolbar flips below there.
   *
   * R11-RV-PTR-1. The band chooses the side and nothing else. Clamped into a
   * band smaller than itself, the 320px slash menu with 200px of the frame on
   * screen was pulled up over its own caret and its top past the frame's,
   * which clips it: the option Enter applies was out of sight. Where neither
   * side fits, the side with more of it seen, against the anchor, clamped to
   * the portal's own viewport only. The rest -- the band itself, measured
   * through real frames -- is pinned in e2e (TB5za, SL10e).
   */
  test("a band narrower than the window chooses the portal's side, and only its side", () => {
    const element = document.createElement('div');
    element.style.position = 'fixed';
    document.body.append(element);
    let size = 36;
    element.getBoundingClientRect = () => new DOMRect(0, 0, 200, size);
    const top = () => Number.parseInt(element.style.top, 10);

    positionPortal(element, new DOMRect(20, 100, 1, 20), { prefer: 'above' });
    expect(top(), 'the window has room above').toBe(56);

    let band = { top: 90, bottom: 500 };
    setAnchorBand(element, () => band);
    positionPortal(element, new DOMRect(20, 100, 1, 20), { prefer: 'above' });
    expect(top(), 'the band has none above: below').toBe(128);

    // The literal case: a 320px menu, a caret line at 60..80, 200px seen.
    size = 320;
    band = { top: 0, bottom: 200 };
    positionPortal(element, new DOMRect(20, 60, 1, 20), { prefer: 'below' });
    expect(top(), 'neither side fits: below, which has more, against the caret').toBe(88);

    size = 36;
    band = { top: 470, bottom: 500 };
    positionPortal(element, new DOMRect(20, 480, 1, 20), { prefer: 'above' });
    expect(top(), 'neither side fits: above, which has more, against the anchor').toBe(436);

    size = 320;
    band = { top: 0, bottom: 100 };
    positionPortal(element, new DOMRect(20, 90, 1, 10), { prefer: 'above' });
    expect(top(), "more room above, but it would cross the viewport's top: below").toBe(108);

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

  test('nor is one from another realm', () => {
    // Mounted in an iframe, the scrolled element is that realm's, and an
    // `instanceof Element` check here read every scroll inside the slash menu
    // as the page moving -- so arrowing past the fold closed it again.
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
    const list = menu.querySelector('.neditor-slash-menu__list') ?? menu;
    const event = new Event('scroll', { bubbles: false });
    // A real element, presented the way a foreign one arrives: the node
    // interface, but none of this realm's constructors.
    Object.defineProperty(event, 'target', {
      value: { nodeType: 1, nodeName: 'DIV', closest: (s: string) => list.closest(s) },
      configurable: true,
    });
    list.dispatchEvent(event);

    expect(menu.hidden).toBe(false);
  });
});

describe('hovering the slash menu does not rebuild it', () => {
  /**
   * `mouseenter` on an option re-rendered the whole list. The pointer was then
   * over a brand-new element, which Chromium and WebKit answer with another
   * `mouseenter` -- so a pointer resting on the menu rebuilt it several times a
   * second, forever, and a click never landed: the option under the press was
   * replaced before the release. Clicking a command did nothing in Chrome or
   * Safari. happy-dom fires no boundary events for a DOM change, so what is
   * pinned is the cause: hovering must keep the option elements it hovered.
   */
  const openMenu = (): { editor: NEditor; menu: HTMLElement } => {
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
  const options = (menu: HTMLElement): HTMLElement[] => [
    ...menu.querySelectorAll<HTMLElement>('[role="option"]'),
  ];

  test('entering an option highlights it in place', () => {
    const { menu } = openMenu();
    const before = options(menu);

    before[2]!.dispatchEvent(new MouseEvent('mouseenter'));
    const after = options(menu);

    expect(after[2], 'the hovered option must be the same element').toBe(before[2]);
    expect(after.map((o) => o.getAttribute('aria-selected'))).toEqual(
      after.map((_, i) => String(i === 2)),
    );
    expect(after.filter((o) => o.dataset.active === 'true')).toEqual([after[2]]);
  });

  test('the block announces the hovered option', () => {
    const { editor, menu } = openMenu();
    const host = hosts(editor)[0]!;

    options(menu)[3]!.dispatchEvent(new MouseEvent('mouseenter'));

    expect(host.getAttribute('aria-activedescendant')).toBe(options(menu)[3]!.id);
  });

  test('a click after hovering applies the hovered command', () => {
    const { editor, menu } = openMenu();
    const target = options(menu)[1]!;

    target.dispatchEvent(new MouseEvent('mouseenter'));
    // The element the press began on, as a real click requires.
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(editor.getDocument().blocks[0]!.type).toBe('heading1');
  });

  test('the arrow keys still move the highlight and keep it in view', () => {
    const { editor, menu } = openMenu();
    const host = hosts(editor)[0]!;

    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

    expect(options(menu)[1]!.getAttribute('aria-selected')).toBe('true');
    expect(host.getAttribute('aria-activedescendant')).toBe(options(menu)[1]!.id);
  });
});

describe('a right-click outside every host keeps the range through the browser default', () => {
  // Chromium selects a word of its own in contextmenu's default action, which
  // runs after every listener -- with a press on the root's padding, a range
  // that begins outside the editor, so the next key was lost (R3-PTR-2). The
  // default is played here by a document listener registered after the
  // editor's, which is where it runs relative to the editor's own restore.
  const rightClickRoot = (editor: NEditor, during: () => void) => {
    const onMenu = () => during();
    document.addEventListener('contextmenu', onMenu);

    try {
      editor.element.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 2, pointerId: 1 }),
      );
      editor.element.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 }),
      );
      editor.element.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
      );
    } finally {
      document.removeEventListener('contextmenu', onMenu);
    }
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const outside = () => {
    const div = document.createElement('div');
    div.className = 'outside';
    div.textContent = 'page text';
    document.body.prepend(div);
    return div;
  };

  test('a range the default moved outside the editor is put back', async () => {
    const editor = mount([
      block({ content: [{ text: 'Alpha one' }] }),
      block({ content: [{ text: 'Bravo two' }] }),
    ]);
    const host = hosts(editor)[1]!;
    const page = outside();
    selectIn(host, 0, 5);

    rightClickRoot(editor, () => {
      getSelection()?.setBaseAndExtent(page.firstChild!, 2, host, 0);
    });
    await tick();

    const selection = getSelection()!;
    expect(selection.anchorNode).toBe(host.firstChild);
    expect(selection.anchorOffset).toBe(0);
    expect(selection.focusNode).toBe(host.firstChild);
    expect(selection.focusOffset).toBe(5);
  });

  // R4-PTR-1: a page with its own context menu cancels the event and moves
  // focus into that menu. The deferred restore then pulled focus back into
  // the editor ~15ms later, and the reader's typing in the page's menu
  // replaced their range. happy-dom moves no focus on setBaseAndExtent, so
  // what is pinned is the restore itself: it must not run. The page's menu
  // also selects something of its own, which a restore would overwrite.
  for (const cancel of [true, false]) {
    test(`a page menu that takes focus keeps it (${cancel ? 'cancelled' : 'not cancelled'})`, async () => {
      const editor = mount([
        block({ content: [{ text: 'Alpha one' }] }),
        block({ content: [{ text: 'Bravo two' }] }),
      ]);
      const host = hosts(editor)[0]!;
      selectIn(host, 1, 3);
      const page = outside();
      const field = document.createElement('input');
      document.body.append(field);
      const onMenu = (event: Event) => {
        if (cancel) event.preventDefault();
      };
      document.addEventListener('contextmenu', onMenu);

      try {
        rightClickRoot(editor, () => {
          field.focus();
          getSelection()?.setBaseAndExtent(page.firstChild!, 0, page.firstChild!, 4);
        });
      } finally {
        document.removeEventListener('contextmenu', onMenu);
      }
      // The release, which runs the pending restore when it comes first.
      document.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, button: 2, pointerId: 1 }),
      );
      await tick();

      expect(document.activeElement).toBe(field);
      expect(getSelection()!.anchorNode).toBe(page.firstChild);
      expect(getSelection()!.focusOffset).toBe(4);
    });
  }

  test('a cancelled menu that leaves focus in the text is not restored over', async () => {
    const editor = mount([
      block({ content: [{ text: 'Alpha one' }] }),
      block({ content: [{ text: 'Bravo two' }] }),
    ]);
    const host = hosts(editor)[1]!;
    selectIn(host, 0, 5);
    const onMenu = (event: Event) => event.preventDefault();
    document.addEventListener('contextmenu', onMenu);

    try {
      // A page menu that selects for itself without moving focus: Chromium's
      // default never runs for a cancelled event, so there is nothing to undo.
      rightClickRoot(editor, () => {
        getSelection()?.setBaseAndExtent(host.firstChild!, 6, host.firstChild!, 9);
      });
    } finally {
      document.removeEventListener('contextmenu', onMenu);
    }
    await tick();

    expect(getSelection()!.anchorOffset).toBe(6);
    expect(getSelection()!.focusOffset).toBe(9);
  });

  test('a press after the menu wins over the pending restore', async () => {
    const editor = mount([
      block({ content: [{ text: 'Alpha one' }] }),
      block({ content: [{ text: 'Bravo two' }] }),
    ]);
    const [first, second] = hosts(editor);
    selectIn(second!, 0, 5);

    rightClickRoot(editor, () => {
      // The reader has already moved on before the queued restore runs.
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      selectIn(first!, 1, 3);
    });
    await tick();

    expect(getSelection()!.anchorNode).toBe(first!.firstChild);
    expect(getSelection()!.focusOffset).toBe(3);
  });
});

describe('the table toolbar is drawn only while its cell holds focus', () => {
  // Firefox and WebKit leave the caret in the cell when focus goes to a page
  // field, and Firefox fires selectionchange for that field: the toolbar came
  // straight back over a table the reader had left (R3-PTR-7).
  test('focus leaving for a page field hides it, and a later selectionchange does not redraw it', () => {
    const editor = mount([
      block({
        id: 't',
        type: 'table',
        rows: [[[{ text: 'a1' }], [{ text: 'a2' }]]],
      } as Partial<Block>),
    ]);
    const toolbar = portal('neditor-table-toolbar');
    const target = cell(editor, '0:1');
    selectIn(target, 1, 1);
    document.dispatchEvent(new Event('selectionchange'));
    expect(toolbar.hidden).toBe(false);

    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    target.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: input }));
    expect(toolbar.hidden).toBe(true);

    // The caret is still in the cell, as those engines leave it.
    const range = document.createRange();
    range.setStart(target.firstChild!, 1);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    expect(toolbar.hidden).toBe(true);

    // Focus back in the cell draws it again, selection change or not.
    target.focus();
    expect(toolbar.hidden).toBe(false);
  });

  // R4-PTR-4: after F10 focus is in the toolbar, outside the root, so the
  // root's focusout had already run and nothing heard the reader leave the
  // toolbar itself. It stayed drawn, and its buttons edited the table the
  // reader had left and pulled focus back. happy-dom fires no focusout for a
  // focus move, so each one is dispatched as the engines do.
  const intoToolbar = () => {
    const editor = mount([
      block({
        id: 't',
        type: 'table',
        rows: [[[{ text: 'a1' }], [{ text: 'a2' }]]],
      } as Partial<Block>),
    ]);
    const toolbar = portal('neditor-table-toolbar');
    const target = cell(editor, '0:1');
    selectIn(target, 1, 1);
    document.dispatchEvent(new Event('selectionchange'));
    press(target, 'F10');
    const button = document.activeElement as HTMLElement;
    expect(toolbar.contains(button)).toBe(true);

    return { editor, toolbar, button };
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  test('focus leaving the toolbar for a page field hides it', () => {
    const { toolbar, button } = intoToolbar();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    button.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: input }));

    expect(toolbar.hidden).toBe(true);
  });

  test('focus going back to the cell keeps it', async () => {
    const { editor, toolbar, button } = intoToolbar();
    const target = cell(editor, '0:1');
    target.focus();
    button.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: target }));
    await tick();

    expect(toolbar.hidden).toBe(false);
  });

  test('Tab past the end of the page hides it; a window switch does not', async () => {
    // A window switch: the button stays focused within its document.
    const { toolbar, button } = intoToolbar();
    button.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    await tick();
    expect(toolbar.hidden).toBe(false);
    expect(document.activeElement).toBe(button);

    // Tab into the browser's own controls: nothing on the page holds focus.
    button.blur();
    button.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    await tick();
    expect(toolbar.hidden).toBe(true);
  });
});
