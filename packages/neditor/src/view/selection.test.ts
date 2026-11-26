// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';

import { richDelete } from '../model/rich-text.ts';
import { codePointStart, graphemeEnd, graphemeStart } from '../util/grapheme.ts';
import {
  carryOffset,
  carryRange,
  getCaretOffset,
  getSelectionEnds,
  getSelectionRange,
  isCaretAtEnd,
  offsetWithin,
  readSelection,
  readSelectionAnchor,
  readSelectionEnds,
  setSelectionRange,
} from './selection.ts';

/**
 * The parts of caret arithmetic that other code trusts without checking.
 *
 * `getCaretOffset` answers a number whatever is asked of it, and `richDelete`
 * accepts any pair of numbers — so a caller holding a stale offset gets a
 * plausible-looking result rather than an error. That combination is what let
 * a slash command delete the text in front of it.
 */

describe('the two facts the slash-command strip has to survive', () => {
  /**
   * `#applySlashCommand` deletes `[context.start, getCaretOffset(content))`. If
   * the caret is no longer after the `/`, that range runs backwards — and
   * `richDelete` normalises it, so the command applied and silently ate the
   * head of the block instead of the query. The strip clamps to `context.start`
   * now.
   *
   * The end-to-end trigger needs a caret that has left the host while the menu
   * stays open, which happy-dom does not model — it keeps the selection in the
   * element regardless of focus, so `getCaretOffset` there still answers the
   * live offset. The two halves of the hazard are pinned here instead, at the
   * level where they are real and observable in this environment.
   */
  test('getCaretOffset answers 0 when the caret is not in the host it is asked about', () => {
    const mine = document.createElement('div');
    const other = document.createElement('div');
    mine.contentEditable = 'true';
    other.contentEditable = 'true';
    mine.textContent = 'hello /';
    other.textContent = 'elsewhere';
    document.body.append(mine, other);

    const range = document.createRange();
    range.setStart(other.firstChild!, 4);
    range.collapse(true);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(getCaretOffset(mine)).toBe(0);

    mine.remove();
    other.remove();
  });

  test('richDelete normalises a backwards range rather than refusing it', () => {
    // Which is what turns a stale caret offset into a deletion of the text
    // before the slash, rather than into nothing happening.
    expect(richDelete([{ text: 'hello /' }], 6, 0)).toEqual([{ text: '/' }]);
  });
});

describe('the ends of a range that leaves a shadow root', () => {
  /**
   * R14-RV3-3. A drag from a block in a shadow root out into the page's own
   * text: the document's selection is retargeted there -- both ends on the
   * shadow host or beyond it, and WebKit reports it collapsed -- so nothing
   * read from it names the block the range starts in. The composed range
   * does, in whichever of its two call shapes the engine has; the shape it
   * does not know answers with the retargeted range again. happy-dom has no
   * composed ranges, so the selection is a stand-in that answers as the
   * engines were measured to; the drag itself is pinned in read-only.spec.ts
   * (RO6j, in a shadow root).
   */
  const leaving = (understood: 'dictionary' | 'variadic' | 'neither') => {
    const outer = document.createElement('div');
    const page = document.createElement('p');
    page.textContent = 'text of the page';
    document.body.append(outer, page);
    const root = outer.attachShadow({ mode: 'open' });
    const block = document.createElement('div');
    block.textContent = 'text of a block';
    root.append(block);
    Object.defineProperty(root, 'getSelection', { value: undefined, configurable: true });
    const inside = block.firstChild!;
    const beyond = page.firstChild!;
    const retargeted = document.createRange();
    retargeted.setStart(outer, 0);
    const original = window.getSelection;
    window.getSelection = () =>
      ({
        rangeCount: 1,
        anchorNode: outer,
        focusNode: beyond,
        isCollapsed: true,
        getRangeAt: () => retargeted,
        getComposedRanges(...args: unknown[]) {
          const first = args[0] as { shadowRoots?: ShadowRoot[] } | ShadowRoot | undefined;
          const shape = Array.isArray((first as { shadowRoots?: unknown })?.shadowRoots)
            ? 'dictionary'
            : 'variadic';

          return [
            {
              startContainer: shape === understood ? inside : outer,
              startOffset: 0,
              endContainer: beyond,
              endOffset: 4,
              collapsed: false,
            },
          ];
        },
      }) as unknown as Selection;

    return {
      block,
      inside,
      outer,
      beyond,
      restore: () => {
        window.getSelection = original;
        outer.remove();
        page.remove();
      },
    };
  };

  for (const shape of ['dictionary', 'variadic'] as const) {
    test(`one end in the root, read through getComposedRanges (${shape} form)`, () => {
      const { block, inside, beyond, restore } = leaving(shape);

      try {
        expect(readSelectionEnds(block)).toEqual({ start: inside, end: beyond });
      } finally {
        restore();
      }
    });
  }

  test('a composed range that reaches into the root in neither form is not trusted', () => {
    const { block, outer, beyond, restore } = leaving('neither');

    try {
      // The selection's own ends, which name no block.
      expect(readSelectionEnds(block)).toEqual({ start: outer, end: beyond });
    } finally {
      restore();
    }
  });

  test('outside a shadow root the ends are the selection’s own', () => {
    const first = document.createElement('p');
    const second = document.createElement('p');
    first.textContent = 'one';
    second.textContent = 'two';
    document.body.append(first, second);

    try {
      const selection = window.getSelection()!;
      selection.setBaseAndExtent(second.firstChild!, 2, first.firstChild!, 1);
      // As the reader made it: backward, the anchor in the second.
      expect(readSelectionEnds(first)).toEqual({
        start: second.firstChild,
        end: first.firstChild,
      });
      selection.removeAllRanges();
      expect(readSelectionEnds(first)).toBeNull();
    } finally {
      first.remove();
      second.remove();
    }
  });
});

describe('where the page’s selection was begun, seen from a shadow root', () => {
  /**
   * R14-RV5-2 and -5. A range the reader begins outside the editor ends its
   * block selection, wherever its focus is, so the editor has to know which
   * end the reader began at -- through a shadow root, where the document's
   * own selection is retargeted (Chromium, WebKit) or, at a drag's release,
   * moved (Firefox puts its anchor on the first block). Read from the
   * document's selection, never the root's own: Chromium's reports nothing
   * for a range outside its tree. The composed range has the ends; the
   * selection's direction says which is the anchor, and where it says
   * "none" (Chromium and WebKit, for a mouse's selection) the selection's
   * own anchor or focus names an end outside the tree as it is. happy-dom
   * has no composed ranges, so the selection is a stand-in that answers as
   * the engines were measured to (fix14/rv5/m1-anchor.txt); the drags are
   * pinned in read-only.spec.ts (RO6o, RO6o3, RO6p3).
   */
  const mounted = (selection: {
    rangeCount?: number;
    direction?: string;
    anchor: (nodes: { page: Node; block: Node; outer: Node }) => [Node, number];
    focus: (nodes: { page: Node; block: Node; outer: Node }) => [Node, number];
    composed: ((nodes: { page: Node; block: Node; outer: Node }) => StaticRange) | null;
  }) => {
    const outer = document.createElement('div');
    const page = document.createElement('p');
    page.textContent = 'text of the page';
    document.body.append(page, outer);
    const root = outer.attachShadow({ mode: 'open' });
    const block = document.createElement('div');
    block.textContent = 'text of a block';
    root.append(block);
    // Chromium's own: a selection outside the tree is none of its business.
    Object.defineProperty(root, 'getSelection', {
      value: () => ({ rangeCount: 0, anchorNode: null, focusNode: null }),
      configurable: true,
    });
    const nodes = { page: page.firstChild!, block: block.firstChild!, outer };
    const [anchorNode, anchorOffset] = selection.anchor(nodes);
    const [focusNode, focusOffset] = selection.focus(nodes);
    const range = document.createRange();
    range.setStart(page.firstChild!, 0);
    const original = window.getSelection;
    window.getSelection = () =>
      ({
        rangeCount: selection.rangeCount ?? 1,
        direction: selection.direction,
        anchorNode,
        anchorOffset,
        focusNode,
        focusOffset,
        isCollapsed: false,
        getRangeAt: () => range,
        getComposedRanges: () => (selection.composed ? [selection.composed(nodes)] : []),
      }) as unknown as Selection;

    return {
      block,
      nodes,
      restore: () => {
        window.getSelection = original;
        outer.remove();
        page.remove();
      },
    };
  };
  // Identity, not an object match: happy-dom's `isEqualNode` finds any two
  // text nodes equal, so `toEqual` passed with the wrong end.
  const expectEnds = (
    reading: ReturnType<typeof readSelectionAnchor>,
    expected: { anchor: Node | null; start: Node; end: Node; collapsed: boolean },
  ) => {
    expect(reading).not.toBeNull();
    expect(reading!.anchor).toBe(expected.anchor);
    expect(reading!.start).toBe(expected.start);
    expect(reading!.end).toBe(expected.end);
    expect(reading!.collapsed).toBe(expected.collapsed);
  };
  const fromPage = ({ page, block }: { page: Node; block: Node }) =>
    ({
      startContainer: page,
      startOffset: 2,
      endContainer: block,
      endOffset: 4,
      collapsed: false,
    }) as unknown as StaticRange;

  test('a direction names the anchor: forward the start, backward the end', () => {
    expect.hasAssertions();
    for (const [direction, expected] of [
      ['forward', 'page'],
      ['backward', 'block'],
    ] as const) {
      const { block, nodes, restore } = mounted({
        direction,
        // Firefox at the release: its own anchor moved onto the first block.
        anchor: ({ block }) => [block, 0],
        focus: ({ block }) => [block, 4],
        composed: fromPage,
      });

      try {
        expectEnds(readSelectionAnchor(block), {
          anchor: nodes[expected],
          start: nodes.page,
          end: nodes.block,
          collapsed: false,
        });
      } finally {
        restore();
      }
    }
  });

  test('with no direction, the end the selection names outside the tree is that end', () => {
    // Chromium: the anchor in the page's text as it is, the focus
    // retargeted to the host.
    let mount = mounted({
      direction: 'none',
      anchor: ({ page }) => [page, 2],
      focus: ({ outer }) => [outer.parentNode!, 1],
      composed: fromPage,
    });

    try {
      expect(readSelectionAnchor(mount.block)?.anchor).toBe(mount.nodes.page);
    } finally {
      mount.restore();
    }

    // WebKit, a drag pressed in the block and carried out into the page's
    // text above: the focus is the page's end, so the anchor is the other.
    mount = mounted({
      direction: 'none',
      anchor: ({ outer }) => [outer.parentNode!, 0],
      focus: ({ page }) => [page, 2],
      composed: fromPage,
    });

    try {
      expect(readSelectionAnchor(mount.block)?.anchor).toBe(mount.nodes.block);
    } finally {
      mount.restore();
    }

    // WebKit, a read-only drag pressed in the block and carried out to a
    // blank corner of the element that holds the host (round 14, review 6,
    // C; fix14/rv6/out-c3-names-beside.txt): the anchor retargeted to the
    // host's own place in that element, the focus at its start -- the same
    // node, another offset. Only the focus names an end, the start, so the
    // anchor is the block's end; named by node alone, the anchor named the
    // start too and was read as the page's.
    mount = mounted({
      direction: 'none',
      anchor: ({ outer }) => [
        outer.parentNode!,
        [...outer.parentNode!.childNodes].indexOf(outer as ChildNode),
      ],
      focus: ({ outer }) => [outer.parentNode!, 0],
      composed: ({ outer, block }) =>
        ({
          startContainer: outer.parentNode!,
          startOffset: 0,
          endContainer: block,
          endOffset: 0,
          collapsed: false,
        }) as unknown as StaticRange,
    });

    try {
      expect(
        [...mount.nodes.outer.parentNode!.childNodes].indexOf(mount.nodes.outer as ChildNode),
      ).toBeGreaterThan(0);
      expect(readSelectionAnchor(mount.block)?.anchor).toBe(mount.nodes.block);
    } finally {
      mount.restore();
    }

    // Neither names an end: nothing says, and the caller asks both ends.
    mount = mounted({
      direction: 'none',
      anchor: ({ outer }) => [outer.parentNode!, 1],
      focus: ({ outer }) => [outer.parentNode!, 1],
      composed: fromPage,
    });

    try {
      expectEnds(readSelectionAnchor(mount.block), {
        anchor: null,
        start: mount.nodes.page,
        end: mount.nodes.block,
        collapsed: false,
      });
    } finally {
      mount.restore();
    }
  });

  test('WebKit’s read-only drag into the tree has no range of the document’s, and is read', () => {
    const { block, nodes, restore } = mounted({
      rangeCount: 0,
      direction: 'none',
      anchor: ({ page }) => [page, 2],
      focus: ({ outer }) => [outer.parentNode!, 1],
      composed: fromPage,
    });

    try {
      expect(readSelectionAnchor(block)?.anchor).toBe(nodes.page);
    } finally {
      restore();
    }
  });

  test('a range wholly outside the tree has no anchor to name, and both its ends', () => {
    expect.hasAssertions();
    const { block, nodes, restore } = mounted({
      direction: 'none',
      anchor: ({ page }) => [page, 2],
      focus: ({ page }) => [page, 9],
      composed: ({ page }) =>
        ({
          startContainer: page,
          startOffset: 2,
          endContainer: page,
          endOffset: 9,
          collapsed: false,
        }) as unknown as StaticRange,
    });

    try {
      expectEnds(readSelectionAnchor(block), {
        anchor: null,
        start: nodes.page,
        end: nodes.page,
        collapsed: false,
      });
    } finally {
      restore();
    }
  });

  test('outside a shadow root the anchor is the selection’s own', () => {
    const first = document.createElement('p');
    const second = document.createElement('p');
    first.textContent = 'one';
    second.textContent = 'two';
    document.body.append(first, second);

    try {
      const selection = window.getSelection()!;
      selection.setBaseAndExtent(second.firstChild!, 2, first.firstChild!, 1);
      expectEnds(readSelectionAnchor(first), {
        anchor: second.firstChild,
        start: second.firstChild!,
        end: first.firstChild!,
        collapsed: false,
      });
      selection.removeAllRanges();
      expect(readSelectionAnchor(first)).toBeNull();
    } finally {
      first.remove();
      second.remove();
    }
  });
});

describe('reading the caret inside a shadow root in Safari', () => {
  /**
   * Safari has no `ShadowRoot.getSelection`, and its document selection is
   * retargeted out of the shadow tree -- measured in WebKit 26 it reports the
   * host's parent at offset 0 -- so every caret read in a shadow-root mount came
   * back as "not in this block". Inline rules never fired, and Enter split the
   * block at its start, pushing the whole text into a new block.
   * `Selection.getComposedRanges` is the one API there that reports the real
   * position. happy-dom has neither half of that behaviour, so both are stubbed
   * exactly as WebKit answered them.
   */
  const safariShadow = (): { element: HTMLElement; restore: () => void } => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const element = document.createElement('div');
    element.contentEditable = 'true';
    element.textContent = 'shadow text';
    root.append(element);

    const real = { node: element.firstChild!, offset: 11 };
    const own = Object.getOwnPropertyDescriptor(root, 'getSelection');
    Object.defineProperty(root, 'getSelection', { value: undefined, configurable: true });

    const retargeted = {
      rangeCount: 1,
      isCollapsed: true,
      anchorNode: document.body,
      focusNode: document.body,
      getRangeAt: () => {
        const range = document.createRange();
        range.setStart(document.body, 0);
        return range;
      },
      getComposedRanges: (options: { shadowRoots: ShadowRoot[] }) =>
        options.shadowRoots.includes(root)
          ? [
              {
                startContainer: real.node,
                startOffset: real.offset,
                endContainer: real.node,
                endOffset: real.offset,
                collapsed: true,
              },
            ]
          : [],
      removeAllRanges: () => {},
      addRange: () => {},
      collapse: () => {},
    };
    const getSelection = window.getSelection;
    window.getSelection = () => retargeted as unknown as Selection;

    return {
      element,
      restore: () => {
        window.getSelection = getSelection;
        if (own) {
          Object.defineProperty(root, 'getSelection', own);
        } else {
          delete (root as { getSelection?: unknown }).getSelection;
        }
        host.remove();
      },
    };
  };

  test('the caret offset comes from the composed range', () => {
    const { element, restore } = safariShadow();

    try {
      expect(getSelectionRange(element)).toEqual({ start: 11, end: 11 });
      expect(isCaretAtEnd(element)).toBe(true);
    } finally {
      restore();
    }
  });
});

describe('placing a caret uses the one write Safari honours in a shadow root', () => {
  // WebKit drops `addRange` for a range inside a shadow tree without a word --
  // and the next keystroke with it -- while `setBaseAndExtent` lands. Every
  // caret the editor restores after an edit went through `addRange`, so in a
  // shadow-root mount in Safari each one was lost. happy-dom honours both, so
  // what is pinned is which call is made.
  test('setSelectionRange sets base and extent rather than adding a range', () => {
    const element = document.createElement('div');
    element.textContent = 'abcdef';
    document.body.append(element);
    const selection = window.getSelection()!;
    const calls: string[] = [];
    const add = selection.addRange.bind(selection);
    const set = selection.setBaseAndExtent.bind(selection);
    selection.addRange = (range: Range) => {
      calls.push('addRange');
      add(range);
    };
    selection.setBaseAndExtent = (a: Node, ao: number, f: Node, fo: number) => {
      calls.push('setBaseAndExtent');
      set(a, ao, f, fo);
    };

    try {
      setSelectionRange(element, 2, 4);

      expect(calls).toEqual(['setBaseAndExtent']);
      expect(getSelectionRange(element)).toEqual({ start: 2, end: 4 });
    } finally {
      delete (selection as { addRange?: unknown }).addRange;
      delete (selection as { setBaseAndExtent?: unknown }).setBaseAndExtent;
      element.remove();
    }
  });
});

describe('a selection the page cannot touch is no selection', () => {
  /**
   * Firefox's Quick Find (a `/` typed with focus on the page) leaves the
   * document's selection in the find bar's own content. Its containers are
   * no `Node` this page can hold: `element.contains(range.startContainer)`
   * threw a `TypeError` out of the editor's `selectionchange` listener and
   * into the host page's error reporting. happy-dom has no find bar, so the
   * selection is a stub whose ends cannot be read -- the same throw, at the
   * same place.
   */
  const unreachable = (): (() => void) => {
    const throws = (): never => {
      throw new TypeError('Node.contains: Argument 1 does not implement interface Node.');
    };
    const range = {
      get startContainer(): never {
        return throws();
      },
      get endContainer(): never {
        return throws();
      },
      startOffset: 0,
      endOffset: 0,
      collapsed: true,
    };
    const stub = {
      rangeCount: 1,
      get anchorNode(): never {
        return throws();
      },
      get focusNode(): never {
        return throws();
      },
      anchorOffset: 0,
      focusOffset: 0,
      isCollapsed: true,
      getRangeAt: () => range,
      removeAllRanges: () => {},
    };
    // Both ways in: a node in the document reads through `Document.getSelection`.
    const getSelection = window.getSelection;
    const own = Object.getOwnPropertyDescriptor(document, 'getSelection');
    window.getSelection = () => stub as unknown as Selection;
    Object.defineProperty(document, 'getSelection', {
      value: () => stub,
      configurable: true,
    });

    return () => {
      window.getSelection = getSelection;
      if (own) {
        Object.defineProperty(document, 'getSelection', own);
      } else {
        delete (document as { getSelection?: unknown }).getSelection;
      }
    };
  };

  test('every reader answers null rather than throwing', () => {
    const element = document.createElement('div');
    element.textContent = 'abcdef';
    document.body.append(element);
    const restore = unreachable();

    try {
      expect(readSelection(element)).toBeNull();
      expect(getSelectionRange(element)).toBeNull();
      expect(getSelectionEnds(element)).toBeNull();
      expect(readSelectionEnds(element)).toBeNull();
      expect(getCaretOffset(element)).toBe(0);
    } finally {
      restore();
      element.remove();
    }
  });

  test('a range whose ends the page can touch still reads', () => {
    const element = document.createElement('div');
    element.textContent = 'abcdef';
    document.body.append(element);

    try {
      setSelectionRange(element, 1, 3);

      expect(getSelectionRange(element)).toEqual({ start: 1, end: 3 });
    } finally {
      element.remove();
    }
  });
});

describe('a selection offset its node no longer has', () => {
  /**
   * R10-FMT-3 and R10-RV-KEY-1 (WebKit). A caret at the end of a block
   * holding five children (`alpha\n`, bold, `\n`, bold, `\nlast line`), and a
   * host's `setDocument` redrawing the block, same id, with one text child.
   * Measured in WebKit: the selection still reported `anchorOffset` 4 on the
   * block's element, while `getRangeAt(0)` -- the live range -- said offset 0.
   * Raw, the offset threw `IndexSizeError` from every range built on it
   * (`setDocument` after drawing, then every keystroke). Clamped alone, one
   * reading held two carets: the ends said the end, the range said the start,
   * so typing went to the end while Backspace merged into the block above and
   * Enter opened a paragraph above. happy-dom keeps its selection up to date,
   * so WebKit's answer is stubbed exactly as it came: the stale offset, and a
   * live range at the start. A stale reading is written back, so the
   * selection the browser types into agrees with the one the editor read --
   * but only into a host that holds focus (R11-KEY-1, below).
   */
  const stale = (
    anchorNode: Node,
    anchorOffset: number,
    focusNode = anchorNode,
    focusOffset = anchorOffset,
  ): { written: unknown[][]; restore: () => void } => {
    const written: unknown[][] = [];
    const reported = {
      rangeCount: 1,
      isCollapsed: anchorNode === focusNode && anchorOffset === focusOffset,
      anchorNode,
      anchorOffset,
      focusNode,
      focusOffset,
      // As WebKit answered: the live range at the start of the anchor's node.
      getRangeAt: () => {
        const range = document.createRange();
        range.setStart(anchorNode, 0);
        return range;
      },
      setBaseAndExtent: (...args: unknown[]) => written.push(args),
      removeAllRanges: () => {},
      addRange: () => {},
    };
    const spies = [
      vi.spyOn(window, 'getSelection').mockReturnValue(reported as unknown as Selection),
      vi.spyOn(document, 'getSelection').mockReturnValue(reported as unknown as Selection),
    ];

    return {
      written,
      restore: () => {
        for (const spy of spies) {
          spy.mockRestore();
        }
      },
    };
  };

  /** A block's editing host, holding focus as the reader's caret does. */
  const focusedHost = (): HTMLElement => {
    const element = document.createElement('div');
    element.contentEditable = 'true';
    document.body.append(element);
    element.focus();

    return element;
  };

  test('an element offset past its children reads as its end, range and ends alike', () => {
    const element = focusedHost();
    element.textContent = 'Hello world';
    const { written, restore } = stale(element, 4);

    try {
      expect(element.childNodes.length).toBe(1);
      expect(getSelectionEnds(element)).toEqual({ anchor: 11, focus: 11 });
      // The range too: read from the live range, the caret was at 0.
      expect(getSelectionRange(element)).toEqual({ start: 11, end: 11 });
      expect(getCaretOffset(element)).toBe(11);
      expect(isCaretAtEnd(element)).toBe(true);
      expect(readSelection(element)).toMatchObject({
        anchorOffset: 1,
        focusOffset: 1,
        isCollapsed: true,
      });
      expect(offsetWithin(element, element, 4)).toBe(11);
      // And the browser is told, so the next key acts where the editor read.
      expect(written.at(-1)).toEqual([element, 1, element, 1]);
    } finally {
      restore();
      element.remove();
    }
  });

  test('a backward selection with a stale anchor keeps its direction', () => {
    const element = focusedHost();
    element.textContent = 'abc';
    const { written, restore } = stale(element.firstChild!, 10, element.firstChild!, 1);

    try {
      expect(getSelectionEnds(element)).toEqual({ anchor: 3, focus: 1 });
      expect(getSelectionRange(element)).toEqual({ start: 1, end: 3 });
      expect(readSelection(element)).toMatchObject({ isCollapsed: false });
      expect(written.at(-1)).toEqual([element.firstChild, 3, element.firstChild, 1]);
    } finally {
      restore();
      element.remove();
    }
  });

  /**
   * R11-KEY-1 (WebKit), p5's literal case: the caret at the end of that
   * five-child block, the reader at a page button (clicked, or focused from
   * the keyboard), and a peer's `setDocument` redrawing the block with one
   * child. Setting a selection inside a contenteditable focuses it in every
   * engine, so the write-back pulled focus from the button into the block,
   * and the reader's Space and "xy" were typed there ("Hello world xy"). A
   * stale selection in a host that does not hold focus is read, clamped, and
   * left alone. happy-dom moves no focus on a selection write, so what is
   * pinned is that nothing is written; the focus itself is pinned in WebKit
   * (api.spec.ts).
   */
  for (const [label, arrange] of [
    [
      'a page button',
      () => {
        const button = document.createElement('button');
        document.body.append(button);
        button.focus();
        return () => button.remove();
      },
    ],
    [
      // F10's toolbar: a portal outside the editor, holding focus.
      'a toolbar button in a portal',
      () => {
        const portal = document.createElement('div');
        portal.setAttribute('role', 'toolbar');
        const button = document.createElement('button');
        portal.append(button);
        document.body.append(portal);
        button.focus();
        return () => portal.remove();
      },
    ],
    [
      // Block selection: the editor's root holds focus, and contains the
      // block, but is no editing host.
      'the editor root, holding a block selection',
      (element: HTMLElement) => {
        const root = document.createElement('div');
        root.tabIndex = -1;
        element.replaceWith(root);
        root.append(element);
        root.focus();
        return () => root.remove();
      },
    ],
    ['nothing (<body>)', () => () => {}],
  ] as const) {
    test(`a stale selection in a block while focus is on ${label} is read, never written`, () => {
      const element = document.createElement('div');
      element.contentEditable = 'true';
      element.textContent = 'Hello world';
      document.body.append(element);
      const cleanup = arrange(element);
      const active = document.activeElement;
      const { written, restore } = stale(element, 4);

      try {
        expect(getSelectionEnds(element)).toEqual({ anchor: 11, focus: 11 });
        expect(getSelectionRange(element)).toEqual({ start: 11, end: 11 });
        expect(written).toEqual([]);
        expect(document.activeElement).toBe(active);
      } finally {
        restore();
        cleanup();
        element.remove();
      }
    });
  }

  // The sibling the rule keeps: a host in a shadow root holding focus there
  // is written back to, as in the page (its own tree's activeElement).
  test('a stale selection in a focused host inside a shadow root is written back', () => {
    const outer = document.createElement('div');
    document.body.append(outer);
    const root = outer.attachShadow({ mode: 'open' });
    const element = document.createElement('div');
    element.contentEditable = 'true';
    element.textContent = 'Hello world';
    root.append(element);
    element.focus();
    const { written, restore } = stale(element, 4);

    try {
      expect(root.activeElement).toBe(element);
      expect(getSelectionEnds(element)).toEqual({ anchor: 11, focus: 11 });
      expect(written.at(-1)).toEqual([element, 1, element, 1]);
    } finally {
      restore();
      outer.remove();
    }
  });

  test('an offset in bounds is read as it is, from the live range, and nothing is written', () => {
    const element = document.createElement('div');
    element.append('ab', document.createElement('br'), 'cd');
    document.body.append(element);
    const { written, restore } = stale(element, 1, element.lastChild!, 1);

    try {
      expect(getSelectionEnds(element)).toEqual({ anchor: 2, focus: 3 });
      // A selection that is not stale is the browser's own, live range and all.
      expect(getSelectionRange(element)).toEqual({ start: 0, end: 0 });
      expect(written).toEqual([]);
    } finally {
      restore();
      element.remove();
    }
  });

  // The same in a shadow-root mount, where WebKit's caret is read through
  // `getComposedRanges`: a static range is no more up to date.
  test('a composed range past its node reads as its end', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const element = document.createElement('div');
    element.textContent = 'X';
    root.append(element);
    const own = Object.getOwnPropertyDescriptor(root, 'getSelection');
    Object.defineProperty(root, 'getSelection', { value: undefined, configurable: true });
    const reported = {
      rangeCount: 1,
      isCollapsed: true,
      anchorNode: document.body,
      focusNode: document.body,
      getRangeAt: () => {
        const range = document.createRange();
        range.setStart(document.body, 0);
        return range;
      },
      getComposedRanges: () => [
        {
          startContainer: element,
          startOffset: 4,
          endContainer: element,
          endOffset: 4,
          collapsed: true,
        },
      ],
    };
    const getSelection = window.getSelection;
    window.getSelection = () => reported as unknown as Selection;

    try {
      expect(getSelectionRange(element)).toEqual({ start: 1, end: 1 });
      expect(getSelectionEnds(element)).toEqual({ anchor: 1, focus: 1 });
    } finally {
      window.getSelection = getSelection;
      if (own) {
        Object.defineProperty(root, 'getSelection', own);
      } else {
        delete (root as { getSelection?: unknown }).getSelection;
      }
      host.remove();
    }
  });
});

describe('carryOffset: an end of the selection across a change to the text around it', () => {
  // R12-KEY-7. Identity, never a guess: the end keeps its offset while the
  // text before it is unchanged, else its distance from the end while the
  // text after it is; otherwise null.
  test('text added after it: the offset is kept', () => {
    expect(carryOffset('Hello world', 'Hello world!', 5, 'before')).toBe(5);
  });

  test('text added before it: the distance from the end is kept', () => {
    expect(carryOffset('Hello world', 'NEW Hello world', 6, 'before')).toBe(10);
    expect(carryOffset('Hello world', 'NEW Hello world', 11, 'before')).toBe(15);
  });

  test('text removed before it', () => {
    expect(carryOffset('NEW Hello world', 'Hello world', 10, 'before')).toBe(6);
  });

  test('text changed on both sides: null', () => {
    expect(carryOffset('Hello world', 'Goodbye moon', 5, 'before')).toBeNull();
    expect(carryOffset('Hello world', 'Hexxo worxd', 5, 'after')).toBeNull();
  });

  // An insertion exactly at the end satisfies both: `side` decides.
  test('an insertion exactly at it goes after it for "before", before it for "after"', () => {
    expect(carryOffset('ab', 'aXb', 1, 'before')).toBe(1);
    expect(carryOffset('ab', 'aXb', 1, 'after')).toBe(2);
    expect(carryOffset('alpha', 'NEW alpha', 0, 'after')).toBe(4);
    expect(carryOffset('alpha', 'NEW alpha', 0, 'before')).toBe(0);
  });

  test('the text emptied: every offset goes to 0', () => {
    expect(carryOffset('abc', '', 0, 'before')).toBe(0);
    expect(carryOffset('abc', '', 3, 'before')).toBe(0);
    // Deleted around it: where the deleted text was.
    expect(carryOffset('abc', '', 1, 'before')).toBe(0);
  });

  test('unchanged text: every offset is its own', () => {
    for (let offset = 0; offset <= 5; offset += 1) {
      expect(carryOffset('Hello', 'Hello', offset, 'before')).toBe(offset);
      expect(carryOffset('Hello', 'Hello', offset, 'after')).toBe(offset);
    }
  });
});

describe('carryOffset: a deletion around the end, by a common prefix and suffix', () => {
  // R12-RV-KEY-4a: the caret inside text a peer deleted, with nothing put in
  // its place, goes where that text was. Text inserted or replaced across it
  // still says nothing.
  test('a pure deletion around it: the length of the common prefix', () => {
    expect(carryOffset('Hello world', 'Helrld', 5, 'before')).toBe(3);
    expect(carryOffset('Hello world', 'Helrld', 5, 'after')).toBe(3);
    expect(carryOffset('abcdef', 'af', 3, 'before')).toBe(1);
  });

  test('text replaced across it: null', () => {
    expect(carryOffset('Hello world', 'Howdy world', 3, 'before')).toBeNull();
    expect(carryOffset('abcdef', 'aXf', 3, 'before')).toBeNull();
  });

  // A composition is never let go of: `always` answers the start of the
  // changed text where nothing else does.
  test('`always`: the start of the changed text instead of null', () => {
    expect(carryOffset('Hello world', 'Hey there', 5, 'before')).toBeNull();
    expect(carryOffset('Hello world', 'Hey there', 5, 'before', true)).toBe(2);
    expect(carryOffset('Hello world', 'Hello world!', 5, 'before', true)).toBe(5);
  });
});

describe('carryOffset never cuts a character a reader sees as one', () => {
  // R12-RV2-KEY-1, p1's literal cases. The common prefix and suffix were
  // counted in UTF-16 code units, and every emoji in U+1F600..U+1F64F shares
  // its high surrogate: "X😀😁😂Y" with the caret after "😀", a peer leaving
  // "X😂Y", put the caret between the two halves of "😂" -- Firefox wrote a
  // lone surrogate into the model, and the others snapped past the emoji. A
  // flag and a letter with its combining mark were cut the same way. Every
  // answer is snapped back to a grapheme boundary of the new text.
  test('a surrogate pair at the cut', () => {
    expect(carryOffset('X😀😁😂Y', 'X😂Y', 3, 'before')).toBe(1);
    expect(carryOffset('ab😀😁😂cd', 'ab😂cd', 5, 'before')).toBe(2);
    expect(carryOffset('X😀😁😂Y', 'Xq😂Y', 3, 'before', true)).toBe(1);
  });

  test('a flag at the cut', () => {
    const flags = 'X\u{1F1EB}\u{1F1F7}\u{1F1FA}\u{1F1F8}\u{1F1FA}\u{1F1E6}Y';
    expect(carryOffset(flags, 'X\u{1F1FA}\u{1F1E6}Y', 5, 'before')).toBe(1);
  });

  test('a combining mark at the cut', () => {
    expect(carryOffset('Xe\u0301e\u0300e\u0302Y', 'Xe\u0302Y', 3, 'before')).toBe(1);
  });

  // The rules that keep an offset or a distance from the end can land inside
  // one too: a mark the peer put right after the caret, or a joiner before
  // the text after it.
  // R12-RV3-KEY-1, g1's literal cases: a peer extending the character the
  // caret is just after -- a combining mark, VS16, a skin tone, a ZWJ and a
  // person, a Hangul vowel jamo, a Devanagari matra. The text before the
  // caret is unchanged, so its offset is kept; snapped back, it went before
  // the reader's own character, and the next letter split their word
  // ("नQमाY"). A kept offset goes forward, to the end of the character that
  // now holds it -- and one already on a boundary never moves.
  for (const [label, before, at, after, expected] of [
    ['a combining mark', 'XeY', 2, 'Xe\u0301Y', 3],
    ['VS16', 'X\u2764Y', 2, 'X\u2764\uFE0FY', 3],
    ['a skin tone', 'X👍Y', 3, 'X👍🏽Y', 5],
    ['a ZWJ and a person', 'X👨Y', 3, 'X👨\u200d👩Y', 6],
    ['a Hangul vowel jamo', 'X\u1100Y', 2, 'X\u1100\u1161Y', 3],
    ['a Devanagari matra', 'नमY', 2, 'नमाY', 3],
  ] as const) {
    test(`a kept offset goes past ${label} the peer added to the character before it`, () => {
      expect(carryOffset(before, after, at, 'before')).toBe(expected);
    });
  }

  test('a kept offset already on a boundary never moves', () => {
    expect(carryOffset('Hello world', 'Hello world!', 5, 'before')).toBe(5);
    expect(carryOffset('X😀Y', 'X😀YZ', 3, 'before')).toBe(3);
    expect(carryOffset('XéY', 'XéYZ', 2, 'after')).toBe(2);
  });

  // The distance from the end kept snaps back: the end of the text after it
  // is unchanged, so its start is where the reader's text resumes.
  test('the distance from the end kept snaps back', () => {
    expect(carryOffset('a😀', '😀\u200d😀', 1, 'after')).toBe(0);
  });
});

describe('carryOffset leaves a caret the reader put inside a character where it was', () => {
  // R12-RV4-KEY-1, g1's literal cases (Firefox): a virama typed before a
  // consonant ("कमल", caret at 1, U+094D) leaves the caret at 2, inside the
  // cluster "क्म"; so does Backspace on the consonant after a virama. Firefox
  // types correctly from there. The snapping moved such a caret even where
  // nothing around it changed: a peer appending "!" put the next letter after
  // "म". Only a cut the peer's edit made is snapped; an offset that was
  // already inside a cluster is carried as it is -- never between the halves
  // of a surrogate pair.
  test('a peer appending: the offset is kept as it was', () => {
    expect(carryOffset('क्मल end', 'क्मल end!', 2, 'before')).toBe(2);
  });

  test('a peer prepending: the distance from the end is kept as it was', () => {
    expect(carryOffset('क्मल end', '! क्मल end', 2, 'before')).toBe(4);
    expect(carryOffset('क्मल end', '! क्मल end', 2, 'after')).toBe(4);
  });

  test('a range from inside the cluster keeps both ends', () => {
    expect(carryOffset('क्मल end', 'क्मल end!', 2, 'after')).toBe(2);
    expect(carryOffset('क्मल end', 'क्मल end!', 3, 'before')).toBe(3);
  });

  test('after Backspace on the consonant after a virama', () => {
    expect(carryOffset('क्ल end', 'क्ल end!', 2, 'before')).toBe(2);
  });

  test('a deletion around it: where the text was, unsnapped', () => {
    expect(carryOffset('क्मलXYZ', 'क्मलZ', 2, 'before')).toBe(2);
  });

  test('never between the halves of a surrogate pair', () => {
    // 3 is inside "😀" + U+0301, and the peer deleted that character: the
    // common prefix of the two texts ends inside "😁". Left there, the next
    // letter split the pair; it goes before the pair instead.
    expect(carryOffset('a😀\u0301😁b', 'a😁b', 3, 'before')).toBe(1);
  });
});

describe("carryOffset never moves an end over the reader's own text", () => {
  // R12-RV5-KEY-1 and -2, j1's and j2's literal steps: the caret placed with
  // → by whole characters from the block's start (`right`), a range grown
  // with Shift+→ (`extend`), and a peer's edit that JOINS the reader's text
  // on both sides of an end into one character -- a deletion between them,
  // or a joiner (a virama, a ZWJ) inserted at the end. The snap moved the
  // end over the reader's own text: a range start grew back over "🇺" and the
  // "Q" typed over the range deleted it ("aQ"); a caret jumped forward over
  // "म" ("abक्मQलcd"). Where the character holding an end is made of the
  // reader's text on both sides of it, the end is not snapped at all; a range
  // therefore neither grows nor shrinks (nothing is emptied). Snapped are
  // only an end the peer's own new text extends (forward or back over that
  // text alone) and an end the code-unit arithmetic cut out of a whole
  // character of the reader's that is still there (to that character's
  // edge).
  const steps = (text: string, count: number, from = 0): number => {
    let at = from;
    for (let step = 0; step < count && at < text.length; step += 1) {
      at = graphemeEnd(text, at + 1);
    }
    return at;
  };
  const typed = (before: string, after: string, right: number, extend: number): string | null => {
    const start = steps(before, right);
    const end = steps(before, extend, start);
    const collapsed = start === end;
    const s = carryOffset(before, after, start, collapsed ? 'before' : 'after');
    const e = collapsed ? s : carryOffset(before, after, end, 'before');
    return s === null || e === null ? null : `${after.slice(0, s)}Q${after.slice(e)}`;
  };

  for (const [label, before, right, extend, after, wanted] of [
    ['devanagari caret', 'abक्मलcd', 3, 0, 'abक्लcd', ['abक्Qलcd']],
    ['devanagari range', 'abक्मलcd', 3, 2, 'abक्लcd', ['abक्Qd']],
    ['zwj caret', 'a👩\u200dx👧b', 3, 0, 'a👩\u200d👧b', ['a👩\u200dQ👧b']],
    ['zwj range', 'a👩\u200dx👧b', 3, 2, 'a👩\u200d👧b', ['a👩\u200dQ']],
    ['flag caret', 'a🇺x🇸b', 3, 0, 'a🇺🇸b', ['a🇺Q🇸b']],
    ['flag range', 'a🇺x🇸b', 3, 2, 'a🇺🇸b', ['a🇺Q']],
    ['hangul caret', 'a\u1100x\u1161b', 3, 0, 'a\u1100\u1161b', ['a\u1100Q\u1161b']],
    ['hangul range', 'a\u1100x\u1161b', 3, 2, 'a\u1100\u1161b', ['a\u1100Q']],
    [
      'virama inserted, caret',
      'abकमलcd',
      3,
      0,
      'abक\u094dमलcd',
      ['abक\u094dQमलcd', 'abकQ\u094dमलcd'],
    ],
    ['virama inserted, range', 'abकमलcd', 3, 1, 'abक\u094dमलcd', ['abक\u094dQलcd']],
    ['zwj inserted, caret', 'a👩👧b', 2, 0, 'a👩\u200d👧b', ['a👩\u200dQ👧b', 'a👩Q\u200d👧b']],
    ['zwj inserted, range', 'a👩👧b', 2, 1, 'a👩\u200d👧b', ['a👩\u200dQb']],
  ] as const) {
    test(`${label}: "Q" typed lands among the reader's own text`, () => {
      expect(wanted).toContain(typed(before, after, right, extend));
    });
  }

  // What the rule keeps: a peer's mark extending the reader's character (the
  // caret goes past it), and a whole character of the reader's cut by the
  // arithmetic (to its edge) -- rv2's and rv3's cases, here as typing.
  test('a mark the peer adds still takes the caret past it; a cut character is still whole', () => {
    expect(typed('XeY', 'Xe\u0301Y', 2, 0)).toBe('Xe\u0301QY');
    expect(typed('XeY', 'Xe\u0301Y', 1, 1)).toBe('XQY');
    expect(typed('X😀😁😂Y', 'X😂Y', 2, 0)).toBe('XQ😂Y');
    expect(typed('Xe\u0301e\u0300e\u0302Y', 'Xe\u0302Y', 2, 0)).toBe('XQe\u0302Y');
  });
});

describe('carryRange: the part of a range every reading of the edit agrees on', () => {
  // R12-RV6-KEY-1 and R12-RV7-KEY-1/-2. A pure deletion or insertion in
  // repeated text can be read in more than one place, and any single reading
  // is wrong about half the time: the prefix-first one put a peer's "w" typed
  // before "world" inside the selected "world" ("hello Q"), and slid or not,
  // a duplicate "the " removed took the reader's selected "the" with it or
  // the one beside it ("Q cat"). The valid readings form one interval, and
  // the range is carried to what all of them agree on: its start as far
  // right, its end as far left, as any reading puts them. That never covers
  // text the reader did not select, nor the peer's text at an edge; the cost
  // is that an ambiguous edit can leave some selected text out.
  const steps = (text: string, count: number, from = 0): number => {
    let at = from;
    for (let step = 0; step < count && at < text.length; step += 1) {
      at = graphemeEnd(text, at + 1);
    }
    return at;
  };
  // The caret placed with → (`right`, or End and ← for a negative `extend`)
  // and the range grown with Shift+→ or Shift+←, as the probes do.
  const typed = (before: string, after: string, right: number, extend: number): string | null => {
    const one = steps(before, right);
    let two = one;
    if (extend >= 0) {
      two = steps(before, extend, one);
    } else {
      for (let step = 0; step < -extend; step += 1) two = graphemeStart(before, two - 1);
    }
    const range = carryRange(before, after, Math.min(one, two), Math.max(one, two));
    return range && `${after.slice(0, range.start)}Q${after.slice(range.end)}`;
  };

  for (const [label, before, right, extend, after, wanted] of [
    // n5: the peer's text typed at the range's start stays outside it.
    ['"w" typed before "world"', 'hello world', 6, 5, 'hello wworld', ['hello wQ']],
    ['"wide " typed before "world"', 'hello world', 6, 5, 'hello wide world', ['hello wide Q']],
    ['"1" typed before "10"', 'Total: 10', 7, 2, 'Total: 110', ['Total: 1Q']],
    ['"w" before "world", backward', 'hello world', 11, -5, 'hello wworld', ['hello wQ']],
    ['"x" before "world" (no repeat)', 'hello world', 6, 5, 'hello xworld', ['hello xQ']],
    // n4 and n7: a deletion takes no text the reader did not select.
    ['the duplicate "the " removed', 'the the cat', 4, 3, 'the cat', ['the Qcat']],
    ['the third "ha" selected, " ha" removed', 'ha ha ha!', 6, 2, 'ha ha!', ['ha haQ!']],
    ['the second "ha" selected, "ha " removed', 'ha ha ha!', 3, 2, 'ha ha!', ['ha Qha!']],
    ['a selected x of "xx" removed', 'xx', 1, 1, 'x', ['xQ']],
    ['the last x of a list removed', 'x, x, x', 6, 1, 'x, x', ['x, xQ']],
    ['the end in a deleted repeat', 'abxaxaa ', 0, 5, 'abxaa ', ['Qaa ']],
    ['trailing spaces', 'b b   ', 0, 5, 'b b ', ['Q ']],
    // rv6's cases: no unselected text taken. Where the deletion could have
    // been the selected text itself, the range is left as a caret where the
    // selection began (the 👍 run, rv6's "a👍Qb", now leaves the 👍).
    ['laughter', 'ha ha ha!', 3, 2, 'ha ha!', ['ha Qha!']],
    ['dots', 'a....b', 3, 1, 'a...b', ['a..Q.b']],
    ['spaces', 'x    y', 3, 1, 'x   y', ['x  Q y']],
    ['indentation', 'if x:    y', 7, 1, 'if x:   y', ['if x:  Q y']],
    ['emoji run', 'a👍👍👍b', 3, 1, 'a👍👍b', ['a👍👍Qb']],
    // R12-RV8-KEY-1, v1's literal rows: the deleted emoji's first code unit
    // is the next one's too, and readings that cut a surrogate pair were
    // counted, which no editor's edit makes; the range lost its 😀
    // ("ok 😀Q"). Not so for a character: a peer's own Backspace can take one
    // code point of a letter and its mark, a conjunct or a syllable's jamo,
    // and reading that it did not took unselected text in. So "é" less the
    // "á" after it can be "e" and "\u0301a" less, and only what both
    // readings keep is replaced -- the reader's mark, the vowel sign, the
    // final jamo are left over ("Q\u0301b", "eQ", "कQ", "가Q"). That is the
    // decided price, not a defect.
    ['"😀!" selected, 👍 deleted', 'ok 👍😀!', 4, 2, 'ok 😀!', ['ok Q']],
    ['"😀 there" selected, 👋 deleted', 'Hi 👋😀 there', 4, 7, 'Hi 😀 there', ['Hi Q']],
    ['"😀" selected, 👋 deleted', 'Hi 👋😀 there', 4, 1, 'Hi 😀 there', ['Hi Q there']],
    ['"😀" selected backward, 👋 deleted', 'Hi 👋😀 there', 5, -1, 'Hi 😀 there', ['Hi Q there']],
    ['NFD é selected, á deleted after it', 'e\u0301a\u0301b', 0, 1, 'e\u0301b', ['Q\u0301b']],
    ['NFD è selected, é deleted before it', 'e\u0301e\u0300', 1, 1, 'e\u0300', ['eQ']],
    ['कु selected, कि deleted', 'किकु', 1, 1, 'कु', ['कQ']],
    [
      'jamo 각 selected, 가 deleted',
      '\u1100\u1161\u1100\u1161\u11a8',
      1,
      1,
      '\u1100\u1161\u11a8',
      ['\u1100\u1161Q'],
    ],
  ] as const) {
    test(`${label}: no unselected text taken, no peer text at an edge`, () => {
      expect(wanted).toContain(typed(before, after, right, extend));
    });
  }

  // Where every reading of an insertion leaves nothing of the range, it is a
  // caret at the leftmost place any reading could have put the inserted
  // text: before all of it, so never inside the peer's text whichever reading
  // was true. "aaa" with the first "a" selected, the peer typing "aa".
  // R12-RV9-KEY-2: an exact tie is nothing too where some reading puts the
  // place the readings meet strictly inside the peer's text. "ha" selected
  // and the peer making it "haha": the start's image in one reading met the
  // end's in another at 2, which in the reading "h|ah|a" is inside the
  // peer's "ah" ("haQha" once typed over).
  test('an insertion that leaves nothing of the range: a caret before all of it', () => {
    expect(carryRange('aaa', 'aaaaa', 0, 1)).toEqual({ start: 0, end: 0 });
    expect(carryRange('ha', 'haha', 0, 2)).toEqual({ start: 0, end: 0 });
    expect(carryRange('ab', 'abab', 0, 2)).toEqual({ start: 0, end: 0 });
    expect(carryRange(' x', ' x x', 0, 2)).toEqual({ start: 0, end: 0 });
  });

  // R12-RV10-KEY-1: a tie no reading puts inside the peer's text stays where
  // the readings meet. One "0" of "1000000" selected and another typed: the
  // two readings meet at 6, between two "0"s in every reading, and moved to
  // the first place any reading could have put the "0", the caret went to
  // the front ("1Q0000000" where the reader was at "100000Q00"). A single code
  // unit can hold no caret inside it, and a surrogate pair holds one only in
  // a reading that cuts it.
  test('an insertion tie no reading puts inside the peer text keeps its place', () => {
    expect(carryRange('1000000', '10000000', 5, 6)).toEqual({ start: 6, end: 6 });
    expect(carryRange('hello', 'helllo', 2, 3)).toEqual({ start: 3, end: 3 });
    expect(carryRange('lol 😂😂😂', 'lol 😂😂😂😂', 8, 10)).toEqual({ start: 10, end: 10 });
    const run = 'a'.repeat(100000);
    expect(carryRange(run, `${run}a`, 50000, 50001)).toEqual({ start: 50001, end: 50001 });
  });

  // R12-RV10-KEY-2: and the caret before all of it is never inside a
  // character. Where the peer's text there begins with a vowel sign or a
  // mark joined to the character before it, settled forward over it the
  // caret stood inside the peer's text in a later reading (fz9), and put
  // back by code point it stood inside the reader's character: Firefox typed
  // there and split it ("aQ́ée"), WebKit typed at its end, in the
  // peer's text. The start of that character is before every reading.
  test('the caret before every reading of an insertion is never inside a character', () => {
    expect(carryRange('्किक', '्किकििक', 3, 4)).toEqual({
      start: 1,
      end: 1,
    });
    expect(carryRange('éaeée', 'éaé́aeée', 2, 3)).toEqual({
      start: 0,
      end: 0,
    });
    expect(carryRange('áe', 'áée', 2, 3)).toEqual({ start: 0, end: 0 });
    expect(carryRange('ãe', 'ãẽe', 2, 3)).toEqual({ start: 0, end: 0 });
  });

  // R12-RV11-KEY-1: also where the settle leaves the caret at a place
  // inside a character that the reader's own keys made. Firefox lets a
  // range start between "क्" typed before "म" and the "म" (offset 2); the
  // peer making "क्म" "क्म्म" leaves nothing of it, and that place, carried
  // unsnapped anywhere else, is snapped to the character's start here.
  test('a collapse inside a character of the reader’s own goes to its start', () => {
    expect(carryRange('क्म', 'क्म्म', 2, 3)).toEqual({
      start: 0,
      end: 0,
    });
  });

  // A deletion that leaves nothing: a caret where the selection began, in the
  // reading where the deletion was the selection itself ("the Qcat").
  // The tie: "ab" selected in "abab" and one "ab" deleted, the start's image
  // in one reading meets the end's in another; the caret is where the
  // selection began in the reading where the deletion was the selection.
  test('a deletion that leaves nothing of the range: a caret where it began', () => {
    expect(carryRange('the the cat', 'the cat', 4, 7)).toEqual({ start: 4, end: 4 });
    expect(carryRange('abab', 'ab', 2, 4)).toEqual({ start: 2, end: 2 });
    expect(carryRange('abab', 'ab', 0, 2)).toEqual({ start: 0, end: 0 });
  });

  // R12-RV8-KEY-1's units: only readings that keep every code point whole
  // count. Read code unit by code unit, "😀😁" less "😀" could also have lost
  // "\ude00\ud83d" (the range came back empty), and the 👋 before "😀 there"
  // its last code unit and the 😀's first ("Hi 😀Q"). Characters are not
  // asked: a 😀 taken out of a ZWJ sequence is one such reading, and the
  // code points alone decide that "😁" selected after it is "😁".
  test('a reading that would cut a code point is not a reading', () => {
    expect(carryRange('😀😁', '😁', 2, 4)).toEqual({ start: 0, end: 2 });
    expect(carryRange('Hi 👋😀 there', 'Hi 😀 there', 5, 13)).toEqual({ start: 3, end: 11 });
    expect(carryRange('😀\u200d😀😁', '😀\u200d😁', 5, 7)).toEqual({ start: 3, end: 5 });
    // The other side: 🈀 and 😀 share their last code unit, so the 😀 deleted
    // after a selected 🈀 could be read as the 🈀's last code unit and the
    // 😀's first, and the selection was emptied.
    expect(carryRange('🈀😀', '🈀', 0, 2)).toEqual({ start: 0, end: 2 });
  });

  // R12-RV9-KEY-1: a lone surrogate the peer completes into a pair. In
  // "\ud83d" with it selected, "😀\ud83d" is the peer's "😀" before it or its
  // "\ud83d\ude00" after the first code unit -- the true one, and it cuts
  // what is now a pair. Filtered out, the range went to the lone surrogate
  // after the 😀, which the reader may not have selected. Wherever either text
  // holds a lone surrogate every reading counts, as before.
  test('every reading counts where a text holds a lone surrogate', () => {
    expect(carryRange('\ud83d', '😀\ud83d', 0, 1)).toEqual({ start: 0, end: 0 });
    expect(carryRange('ab\ud83d', 'ab😀b\ud83d', 1, 3)).toEqual({ start: 1, end: 1 });
  });

  // Settled inside a character, an end may only move inward. f3's case:
  // "कá" selected in "aकá🇸्" and "aक" or "कa" deleted -- what both readings
  // keep is the mark alone, and snapped back, the start took the unselected
  // "a". "á" selected with an "a" typed before it is "á" still; a lone mark
  // selected with a virama put in front of it (one character with it now) is
  // the mark alone, not the peer's virama too. f8's case for the end: "a🏽"
  // selected in "a🏽🇺🏽", and the peer's "🏽🇺" or "🇺🏽" deleted -- in the first
  // reading the "🏽" left is the unselected one; settled outward over it, the
  // end took it.
  test('a character at an edge settles inward only', () => {
    expect(carryRange('aक' + 'a\u0301' + '🇸\u094d', 'a\u0301🇸\u094d', 1, 4)).toEqual({
      start: 1,
      end: 2,
    });
    expect(carryRange('aa\u0301', 'aaa\u0301', 1, 3)).toEqual({ start: 2, end: 4 });
    expect(carryRange('\u0301', '\u094d\u0301', 0, 1)).toEqual({ start: 1, end: 2 });
    expect(carryRange('a🏽🇺🏽', 'a🏽', 0, 3)).toEqual({ start: 0, end: 1 });
  });

  // What one reading of an unambiguous edit keeps: text put in exactly at
  // the start goes before the range, at the end after it, strictly inside it
  // grows it.
  test('insertions at the edges stay outside; inside, the range grows by them', () => {
    expect(carryRange('Hello world', 'NEW Hello world', 6, 11)).toEqual({ start: 10, end: 15 });
    expect(carryRange('alpha\nlast line', 'NEW alpha\nlast line', 0, 15)).toEqual({
      start: 4,
      end: 19,
    });
    expect(carryRange('Hello world', 'Hello world!', 6, 11)).toEqual({ start: 6, end: 11 });
    expect(carryRange('Hello world', 'Hello wide world', 0, 11)).toEqual({ start: 0, end: 16 });
    expect(carryRange('Hexxo worxd', 'Hexxo worxd', 2, 8)).toEqual({ start: 2, end: 8 });
    expect(carryRange('Hello world', 'Hexxo worxd', 2, 8)).toBeNull();
  });

  // The property, over pure insertions and deletions with the true edit
  // known: small alphabets, so repeated text is the rule, and a real PRNG
  // (mulberry32) rather than a short-cycled LCG.
  const mulberry32 = (seed: number) => (): number => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Plain repeated text, emoji that share their first code unit, NFD marks,
  // Devanagari and Hangul jamo (R12-RV8-KEY-1). Ranges are made of whole
  // pieces, as a reader selects; edits sometimes of single code points, as
  // a peer's Backspace in a conjunct, a syllable or on a mark makes them.
  const ALPHABETS: readonly (readonly string[])[] = [
    ['a', 'b'],
    ['a', ' '],
    ['a', 'b', ' '],
    ['x', '.'],
    ['😀', '😁', '👍', '👋', '🈀', 'x'],
    ['e\u0301', 'a\u0301', 'e\u0300', 'e', 'x'],
    ['कि', 'कु', 'क', 'ष', ' '],
    ['\u1100\u1161', '\u1100\u1161\u11a8', '\u1100\u1161\u11ab', 'x'],
  ];
  // Whether exactly one reading of a pure edit keeps every code point whole
  // (by brute force, every x tried).
  const unique = (before: string, after: string, deleting: boolean, size: number): boolean => {
    const shorter = deleting ? after : before;
    const longer = deleting ? before : after;
    const whole = (text: string, at: number): boolean => codePointStart(text, at) === at;
    let readings = 0;
    for (let x = 0; x <= shorter.length; x += 1) {
      const fits =
        longer.slice(0, x) === shorter.slice(0, x) && longer.slice(x + size) === shorter.slice(x);
      if (fits && whole(longer, x) && whole(longer, x + size) && whole(shorter, x)) readings += 1;
    }
    return readings === 1;
  };

  test(
    'within the true image: no unselected text, no peer text at an edge, never longer',
    { timeout: 30_000 },
    () => {
      const random = mulberry32(12);
      const pick = (n: number): number => Math.floor(random() * n);
      const failures: string[] = [];

      for (let run = 0; run < 40000 && failures.length < 5; run += 1) {
        const alphabet = ALPHABETS[pick(ALPHABETS.length)]!;
        const parts = (n: number): string[] =>
          Array.from({ length: n }, () => alphabet[pick(alphabet.length)]!);
        const pieces = parts(1 + pick(10));
        const before = pieces.join('');
        // Ranges on the boundaries of the pieces they are made of, as a
        // reader's keys make them; edits there, or in half the runs on any
        // code point boundary, inserting single code points of the pieces.
        const marks = [0];
        for (const piece of pieces) marks.push(marks.at(-1)! + piece.length);
        const cutting = pick(2) === 0;
        const editMarks = cutting
          ? Array.from({ length: before.length + 1 }, (_, i) => i).filter(
              (i) => codePointStart(before, i) === i,
            )
          : marks;
        const at = editMarks[pick(editMarks.length)]!;
        const later = editMarks.filter((mark) => mark > at);
        const deleting = pick(2) === 0 && later.length > 0;
        const codePoints = alphabet.flatMap((piece) => Array.from(piece));
        const inserted = deleting
          ? ''
          : cutting
            ? Array.from({ length: 1 + pick(2) }, () => codePoints[pick(codePoints.length)]!).join(
                '',
              )
            : parts(1 + pick(2)).join('');
        const size = deleting ? later[pick(later.length)]! - at : inserted.length;
        const after = deleting
          ? before.slice(0, at) + before.slice(at + size)
          : before.slice(0, at) + inserted + before.slice(at);
        // Where each code unit of the new text came from: its index in the old
        // text, or -1 for the peer's.
        // (Indexed by code unit: Array.from(after) would count code points.)
        const units = Array.from({ length: after.length }, (_, i) => i);
        const origin = deleting
          ? units.map((i) => (i < at ? i : i + size))
          : units.map((i) => (i < at ? i : i < at + size ? -1 : i - size));
        const startMarks = marks.slice(0, -1);
        const start = startMarks[pick(startMarks.length)]!;
        const ends = marks.filter((mark) => mark > start);
        const end = ends[pick(ends.length)]!;
        // The true image of the range under the edit that was made: text put
        // in exactly at its start goes before it, exactly at its end after it,
        // strictly inside it into it; a deletion takes what it took.
        const image = (offset: number, side: 'before' | 'after'): number => {
          if (deleting) {
            return offset <= at ? offset : offset >= at + size ? offset - size : at;
          }
          return offset < at || (offset === at && side === 'before') ? offset : offset + size;
        };
        const trueStart = image(start, 'after');
        const trueEnd = Math.max(trueStart, image(end, 'before'));
        const range = carryRange(before, after, start, end);

        if (!range) {
          continue;
        }

        const covered = origin.slice(range.start, range.end);
        const label = `${JSON.stringify(before)} -> ${JSON.stringify(after)} [${start},${end}) -> [${range.start},${range.end})`;

        // The decided exception: the peer's text put on the last selected
        // character (a mark, a final jamo -- one character with it now) goes
        // with the range, up to that character's end and no further.
        const markedEnd =
          trueEnd > trueStart &&
          range.end > trueEnd &&
          range.end <= graphemeEnd(after, trueEnd) &&
          origin.slice(trueEnd, range.end).every((o) => o === -1)
            ? range.end
            : trueEnd;

        // Within the true image: never text the reader did not select, never
        // the peer's text inserted at an edge of the range, never longer.
        if (range.end > range.start && (range.start < trueStart || range.end > markedEnd)) {
          failures.push(`outside the true image [${trueStart},${trueEnd}): ${label}`);
        }

        if (covered.some((o) => o !== -1 && (o < start || o >= end))) {
          failures.push(`unselected: ${label}`);
        }

        if (range.end - range.start > markedEnd - trueStart) {
          failures.push(`longer than the truth: ${label}`);
        }

        // Unambiguous by code points -- only the true reading keeps every
        // code point whole -- and with every edge of the true image a
        // character boundary (an end inside one settles inward), it is
        // exactly the true image.
        if (
          (range.start !== trueStart || range.end !== trueEnd) &&
          graphemeStart(after, trueStart) === trueStart &&
          graphemeStart(after, trueEnd) === trueEnd &&
          unique(before, after, deleting, size)
        ) {
          failures.push(
            `not the true image [${trueStart},${trueEnd}) where only one reading is: ${label}`,
          );
        }
      }

      expect(failures).toEqual([]);
    },
  );
});

describe("graphemeStart and graphemeEnd survive WebKit's containing()", () => {
  // Measured (rv4/s4-containing-ri.mjs, s5-webkit-delete.mjs): WebKit's
  // `segment(text).containing(i)` answers, at the first code unit of a
  // cluster that starts with a surrogate pair, a span that reaches back over
  // the cluster before it too -- "X😀Y".containing(1) is "X😀", at 0.
  // Chromium, Firefox and Node answer "😀" at 1. Trusted, a caret carried to
  // just before an emoji or a flag went back over a character in WebKit
  // alone ("QX😀Y"). Node's segmenter is right, so WebKit's answer is
  // replayed here.
  const Real = Intl.Segmenter;
  class WebKitSegmenter extends Real {
    override segment(text: string): Intl.Segments {
      const segments = super.segment(text);
      const containing = segments.containing.bind(segments);
      return Object.assign(Object.create(segments) as Intl.Segments, {
        containing: (index = 0) => {
          const code = text.charCodeAt(index);
          const here = containing(index);
          if (!here || index === 0 || code < 0xd800 || code > 0xdbff || here.index !== index) {
            return here;
          }
          const before = containing(index - 1)!;
          return {
            index: before.index,
            input: text,
            segment: text.slice(before.index, here.index + here.segment.length),
          };
        },
        [Symbol.iterator]: () => segments[Symbol.iterator](),
      });
    }
  }

  test('a boundary before a surrogate pair is still a boundary', () => {
    const intl = Intl as { Segmenter: typeof Intl.Segmenter };
    intl.Segmenter = WebKitSegmenter as typeof Intl.Segmenter;
    try {
      expect(graphemeStart('x🇺🇸🇯🇫🇷', 1)).toBe(1);
      expect(graphemeEnd('x🇺🇸🇯🇫🇷', 1)).toBe(1);
      expect(graphemeStart('🇯🇺🇸🇫🇷', 6)).toBe(4);
      expect(graphemeStart('🇯🇺🇸🇫🇷', 4)).toBe(4);
      expect(carryOffset('X😀Y', 'NX😀Y', 1, 'before')).toBe(2);
    } finally {
      intl.Segmenter = Real;
    }
  });
});

describe('graphemeStart and graphemeEnd ask for one cluster, not every one before it', () => {
  // R12-RV3-KEY-cost: walking every segment up to the offset took 41 ms a call
  // in Chromium on a 100,000-character block. `containing()` asks for the one
  // segment. Both are linear in the text -- the segmenter copies it -- so the
  // growth of the two is the same and a growth ratio cannot tell them apart;
  // what differs is the constant, by two to three orders of magnitude
  // (measured in Node: 1.3 ms against 457 ms for 50 calls on 224,000
  // characters). Best of three, against a bound far from both.
  test('fifty calls near the end of a 224,000-character block take milliseconds', () => {
    const text = 'abcé😀 '.repeat(32000);
    let best = Infinity;

    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();

      for (let call = 0; call < 25; call += 1) {
        graphemeStart(text, text.length - 3);
        graphemeEnd(text, text.length - 3);
      }

      best = Math.min(best, performance.now() - started);
    }

    expect(best).toBeLessThan(150);
  });
});
