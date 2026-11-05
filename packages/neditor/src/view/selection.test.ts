// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';

import { richDelete } from '../model/rich-text.ts';
import { getCaretOffset, getSelectionRange, isCaretAtEnd, setSelectionRange } from './selection.ts';

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
