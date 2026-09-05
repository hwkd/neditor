// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';

import { richDelete } from '../model/rich-text.ts';
import { getCaretOffset } from './selection.ts';

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
