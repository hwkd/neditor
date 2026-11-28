import { expect, MOD, test } from '../helpers/test.ts';
import type { Block } from '@neditor/core';
import type { EditorPage } from '../helpers/editor.ts';

test.describe('02 · typing & caret', () => {
  test('T1 typing updates the model without replacing the host, and the caret stays put', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    const host = await editor.content('p1').elementHandle();
    await editor.clickAt('p1', 5); // "Alpha| one"
    await editor.type('bet');
    // Typing mid-word keeps typing mid-word: the renderer never rewrote the host.
    await editor.type('ic');
    expect((await editor.texts())[0]).toBe('Alphabetic one');
    expect(await host!.evaluate((element) => element.isConnected)).toBe(true);
    expect(
      await editor.content('p1').evaluate((element, original) => element === original, host),
    ).toBe(true);
    expect((await editor.selection())?.range).toEqual({ start: 10, end: 10 });
    await expect(page.locator('#editor [data-block-id="p1"] .neditor-block__content')).toHaveText(
      'Alphabetic one',
    );
  });

  test('T2 the placeholder shows on the focused empty block only', async ({ editor, page }) => {
    await editor.load({ doc: 'paragraphs' });
    const placeholder = (id: string) =>
      editor.content(id).evaluate((element) => {
        const style = getComputedStyle(element, '::before');
        return { content: style.content, opacity: style.opacity };
      });

    await editor.clickAt('p1', 9);
    await page.keyboard.press('Enter'); // a new, empty, focused paragraph
    const fresh = (await editor.ids())[1]!;
    await expect
      .poll(() => placeholder(fresh))
      // Drawn with empty alternative text, so it is not the block's name (UI-9).
      .toEqual({ content: `"Type '/' for commands" / ""`, opacity: '1' });

    await editor.clickAt('p3', 2);
    await expect.poll(async () => (await placeholder(fresh)).opacity).toBe('0');
  });

  test('T3 Shift+Enter grows the block by a line and the next character lands after the break', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.clickAt('p1', 9);
    const before = (await editor.content('p1').boundingBox())!.height;
    await page.keyboard.press('Shift+Enter');
    const after = (await editor.content('p1').boundingBox())!.height;
    expect(after).toBeGreaterThan(before * 1.5);

    await editor.type('x');
    expect((await editor.texts())[0]).toBe('Alpha one\nx');
    // Still exactly two line boxes: the filler <br> is presentation only.
    const lines = (await editor.content('p1').boundingBox())!.height;
    expect(Math.round(lines)).toBe(Math.round(after));
  });

  /*
   * R10-KEY-4 / R10-PTR-3. Shift+Enter, and Enter in a code block, write the
   * line break into the model and place the caret themselves, and that
   * placement revealed the whole block: in a block taller than the window
   * `block: 'nearest'` does nothing once the block covers it, so the new line
   * opened on the window's last line was left at or below its bottom edge.
   * The caret's own line is revealed, the least way. The probe: 60 lines in
   * the second block, its top 300px above the window, the last line wholly
   * in the window clicked at its end. Layout and scrolling: e2e.
   */
  for (const [type, key] of [
    ['paragraph', 'Shift+Enter'],
    ['quote', 'Shift+Enter'],
    ['code', 'Enter'],
  ] as const) {
    test(`T3b ${key} on the window’s last line of a tall ${type} shows the new line`, async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'paragraphs' });
      await page.evaluate((type) => {
        const ed = window.__e2e.editor;
        const blocks = ed.getDocument().blocks;
        blocks[1]!.content = [
          { text: Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') },
        ];
        blocks[1]!.type = type;
        ed.setDocument({ blocks });
        ed.clearHistory();
      }, type);
      const host = editor.content('p2');
      await host.evaluate((element) => {
        window.scrollBy(0, element.getBoundingClientRect().top + 300);
      });
      await editor.settleScroll();
      // The last line wholly in the window, brought to 4px above its bottom,
      // so the line Enter opens under it is below the window whatever the
      // block's line height.
      const end = await host.evaluate((element) => {
        const text = element.firstChild as Text;
        const range = document.createRange();
        let last = -1;
        let bottom = 0;
        for (let i = 0; i < 59; i++) {
          const at = text.data.indexOf(`line ${i}\n`);
          range.setStart(text, at);
          range.setEnd(text, at + 1);
          if (range.getBoundingClientRect().bottom <= innerHeight - 2) {
            last = at + `line ${i}`.length;
            bottom = range.getBoundingClientRect().bottom;
          }
        }
        window.scrollBy(0, bottom - (innerHeight - 4));
        return last;
      });
      await editor.settleScroll();
      const point = await editor.pointAt(host, end);
      await page.mouse.click(point.x + 1, point.y);
      await editor.settle();
      const before = await page.evaluate(() => window.scrollY);

      await page.keyboard.press(key);
      await editor.settleScroll();
      expect((await editor.texts())[1]).toContain('\n\n');
      const line = await host.evaluate((element, at) => {
        const range = document.createRange();
        range.setStart(element.firstChild!, at);
        range.setEnd(element.firstChild!, at + 1);
        const box = range.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom };
      }, end + 1);
      expect(line.top, 'the new line is on screen').toBeGreaterThanOrEqual(0);
      expect(line.bottom, 'the new line is on screen').toBeLessThanOrEqual(
        page.viewportSize()!.height,
      );
      expect(
        Math.abs((await page.evaluate(() => window.scrollY)) - before),
        'the page moved no more than a line',
      ).toBeLessThan(30);
      await editor.type('x');
      expect((await editor.texts())[1]).toContain(`\nx\n`);
    });
  }

  test('T4 Enter splits at the caret, at the start, at the end, and over a selection', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });

    await editor.clickAt('p1', 5);
    await page.keyboard.press('Enter');
    expect((await editor.texts()).slice(0, 2)).toEqual(['Alpha', ' one']);
    const second = (await editor.ids())[1]!;
    expect(await editor.selection()).toMatchObject({
      blockId: second,
      range: { start: 0, end: 0 },
    });

    await editor.placeCaret('p2', 0);
    await page.keyboard.press('Enter');
    expect((await editor.texts()).slice(2, 4)).toEqual(['', 'Bravo two']);
    // The caret follows the text it was in front of, into the new block.
    const bravo = (await editor.ids())[3]!;
    expect(await editor.selection()).toMatchObject({ blockId: bravo, range: { start: 0, end: 0 } });

    await editor.caretAtEnd('p3');
    await page.keyboard.press('Enter');
    expect((await editor.texts()).at(-1)).toBe('');

    await editor.placeCaret('p3', 2, 8); // "Ch[arlie ]three"
    await page.keyboard.press('Enter');
    const texts = await editor.texts();
    expect(texts).toContain('Ch');
    expect(texts).toContain('three');
  });

  test('T5 lists and to-dos continue on Enter; Enter on an empty item leaves the list', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'lists' });

    await editor.caretAtEnd('b2');
    await page.keyboard.press('Enter');
    await editor.type('Bullet three');
    await editor.caretAtEnd('t2');
    await page.keyboard.press('Enter');
    await editor.type('Todo three');

    let outline = await editor.outline();
    expect(outline).toContain('bulleted_list:Bullet three');
    expect(outline).toContain('todo:Todo three');
    const todo = (await editor.doc()).blocks.find(
      (block) => block.type === 'todo' && block.content[0]?.text === 'Todo three',
    );
    expect(todo?.checked).toBe(false);

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter'); // on the new, empty to-do
    outline = await editor.outline();
    expect(outline.at(-1)).toBe('paragraph:');
  });

  test('T6 Enter in a callout or toggle opens a child; in a collapsed toggle it expands first', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'callout' });
    await editor.caretAtEnd('co');
    await page.keyboard.press('Enter');
    await editor.type('inside');
    expect(await editor.outline()).toEqual([
      'paragraph:Before',
      'callout:Callout text',
      '  paragraph:inside',
      'paragraph:After',
    ]);

    await editor.remount({}, 'toggle-collapsed');
    await editor.caretAtEnd('tg');
    await page.keyboard.press('Enter');
    await editor.type('new child');
    const doc = await editor.doc();
    expect(doc.blocks.find((block) => block.id === 'tg')?.collapsed).toBe(false);
    expect(await editor.outline()).toEqual([
      'paragraph:Before',
      'toggle:Toggle head',
      '  paragraph:new child',
      '  paragraph:Hidden child one',
      '  paragraph:Hidden child two',
      'paragraph:After',
    ]);
    await expect(editor.block('child1')).toBeVisible();
  });

  test('T7 focus() scrolls a far block into view', async ({ editor, page }) => {
    await editor.load({ doc: 'long', scroll: 1 });
    await expect(editor.block('p59')).not.toBeInViewport();
    await page.evaluate(() => window.__e2e.editor.focus('p59'));
    await expect(editor.block('p59')).toBeInViewport();
    await expect(editor.content('p59')).toBeFocused();
  });

  test('T14 deleting the word after a soft break keeps the empty line, and the next character lands on it', async ({
    editor,
    page,
  }) => {
    // TXT-8. Firefox's word and line deletions took the filler <br> with the
    // word, so the block lost its last line and `Z` landed before the break.
    // A line box and where a typed character lands are layout: e2e only.
    // The word, and on macOS the line, back to the break.
    const deletions =
      process.platform === 'darwin' ? ['Alt+Backspace', 'Meta+Backspace'] : ['Control+Backspace'];
    await editor.load({ doc: 'paragraphs' });

    for (const deletion of deletions) {
      await editor.setDocument({
        blocks: [
          { id: 'x', type: 'paragraph', depth: 0, content: [{ text: 'line one\nword' }] },
          { id: 'n', type: 'paragraph', depth: 0, content: [{ text: 'Next' }] },
        ],
      });
      await editor.clickAt('x', 13);
      const tall = (await editor.content('x').boundingBox())!.height;

      await page.keyboard.press(deletion);

      expect((await editor.texts())[0]).toBe('line one\n');
      expect((await editor.content('x').boundingBox())!.height).toBe(tall);
      await editor.type('Z');
      expect((await editor.texts())[0]).toBe('line one\nZ');
    }
  });

  test('T15 typing over the whole text of a link replaces it and keeps the link', async ({
    editor,
    page,
  }) => {
    // TXT-10. Each engine's own type-over gave a one-letter link (Chromium,
    // WebKit) or none at all (Firefox). Which side of an anchor a typed
    // character lands on is each engine's typing style: e2e only.
    await editor.load({ doc: 'paragraphs' });
    await editor.setDocument({
      blocks: [
        {
          id: 'x',
          type: 'paragraph',
          depth: 0,
          content: [{ text: 'see ' }, { text: 'docs', link: 'https://e.com/' }, { text: ' end' }],
        },
      ],
    });
    await editor.clickAt('x', 2);
    // Arrowed to the link's edge: a press at offset 4 is a pixel from the
    // anchor, and Chromium's hit test on Linux puts it on the link, whose
    // click opens the link editor (ci-2).
    for (let i = 0; i < 2; i += 1) {
      await page.keyboard.press('ArrowRight');
    }
    expect(await editor.selection()).toMatchObject({ range: { start: 4, end: 4 } });
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Shift+ArrowRight');
    }
    await editor.type('XYZ');

    expect((await editor.blockData('x'))?.content).toEqual([
      { text: 'see ' },
      { text: 'XYZ', link: 'https://e.com/' },
      { text: ' end' },
    ]);
    await expect(editor.content('x').locator('a')).toHaveText('XYZ');

    // One undo step for the whole replacement.
    await page.keyboard.press(`${MOD}+z`);
    expect((await editor.blockData('x'))?.content).toEqual([
      { text: 'see ' },
      { text: 'docs', link: 'https://e.com/' },
      { text: ' end' },
    ]);

    // Typing at the end of a link, with nothing selected, is still the
    // engine's own business (TXT-11, won't fix): not asserted.
  });

  test('T15b the link continuation ends on a mark toggle or a moved caret', async ({
    editor,
    page,
  }) => {
    // R2-EDIT-1 and R2-EDIT-2. The continuation is for the next character
    // typed at the same caret only. Mod+B showed bold and typed into the link
    // plain; a caret taken away and brought back still typed into the link,
    // where `getSelectionState().link` said there was none. Once it is over,
    // which side of the anchor the next character lands on is the engine's
    // own (TXT-11: Firefox types inside, the others outside), so each case is
    // held against the same keys at an ordinary link's end, in this engine.
    const link = 'https://e.com/';
    const load = async (text: string): Promise<void> => {
      await editor.setDocument({
        blocks: [
          {
            id: 'x',
            type: 'paragraph',
            depth: 0,
            content: [{ text: 'see ' }, { text, link }, { text: ' end' }],
          },
          { id: 'y', type: 'paragraph', depth: 0, content: [{ text: 'Another one' }] },
        ],
      });
    };
    /** `XY` typed over "docs": the continuation waits at offset 6. */
    const typedOver = async (): Promise<void> => {
      await load('docs');
      await editor.clickAt('x', 2);
      // Arrowed to the link's edge: a press at offset 4 is a pixel from the
      // anchor, and Chromium's hit test on Linux puts it on the link, whose
      // click opens the link editor (ci-2).
      for (let i = 0; i < 2; i += 1) {
        await page.keyboard.press('ArrowRight');
      }
      expect(await editor.selection()).toMatchObject({ range: { start: 4, end: 4 } });
      for (let i = 0; i < 4; i += 1) {
        await page.keyboard.press('Shift+ArrowRight');
      }
      await editor.type('XY');
    };
    /** The same text and caret with no type-over before it. */
    const ordinary = async (): Promise<void> => {
      await load('XY');
      await editor.placeCaret('x', 6);
    };
    const after = async (
      arrange: () => Promise<void>,
      steps: () => Promise<void>,
    ): Promise<unknown> => {
      await arrange();
      await steps();
      await editor.type('Qr');
      return (await editor.blockData('x'))?.content;
    };

    await editor.load({ doc: 'paragraphs' });

    // With nothing in between it goes on into the link.
    expect(await after(typedOver, async () => {})).toEqual([
      { text: 'see ' },
      { text: 'XYQr', link },
      { text: ' end' },
    ]);

    // Mod+B: the armed bold applies, exactly as at any link's end.
    const bold = async (): Promise<void> => {
      await page.keyboard.press(`${MOD}+b`);
      expect((await editor.selection())?.marks).toEqual(['bold']);
    };
    expect(await after(typedOver, bold)).toEqual([
      { text: 'see ' },
      { text: 'XY', link },
      { text: 'Qr', marks: ['bold'] },
      { text: ' end' },
    ]);
    expect(await after(ordinary, bold)).toEqual(await after(typedOver, bold));

    // A click in another block and back to the same offset, the auditor's
    // route (a click on the anchor itself would open the link popover).
    const away = async (): Promise<void> => {
      await editor.clickAt('y', 3);
      await editor.clickAt('x', 2);
      for (let i = 0; i < 4; i += 1) {
        await page.keyboard.press('ArrowRight');
      }
      expect(await editor.selection()).toMatchObject({ range: { start: 6, end: 6 } });
    };
    expect(await after(typedOver, away)).toEqual(await after(ordinary, away));

    // ← then →, back to the same offset.
    const leftRight = async (): Promise<void> => {
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowRight');
    };
    expect(await after(typedOver, leftRight)).toEqual(await after(ordinary, leftRight));
  });

  test('T16 Backspace in an empty line after an image removes the line and selects the image', async ({
    editor,
    page,
  }) => {
    // TXT-5: the line stayed, and a second Backspace deleted the picture.
    await editor.load({ doc: 'paragraphs' });
    await editor.setDocument({
      blocks: [
        { id: 'img', type: 'image', depth: 0, content: [], src: '/sample.png', alt: 'pic' },
        { id: 'e', type: 'paragraph', depth: 0, content: [] },
        { id: 'z', type: 'paragraph', depth: 0, content: [{ text: 'Zed' }] },
      ],
    });
    await editor.content('e').click();
    await page.keyboard.press('Backspace');
    expect(await editor.ids()).toEqual(['img', 'z']);
    expect(await editor.selected()).toEqual(['img']);

    await page.keyboard.press(`${MOD}+z`);
    expect(await editor.ids()).toEqual(['img', 'e', 'z']);
    expect((await editor.selection())?.blockId).toBe('e');
  });

  test('T17 a held Backspace selects an image and stops there', async ({ editor, page }) => {
    // TXT-6. Auto-repeat deleted the image the first press only selected,
    // then went on into the paragraph above it. Real key repeat: e2e only.
    await editor.load({ doc: 'paragraphs' });
    await editor.setDocument({
      blocks: [
        { id: 'a', type: 'paragraph', depth: 0, content: [{ text: 'top' }] },
        {
          id: 'img',
          type: 'image',
          depth: 0,
          content: [{ text: 'cap' }],
          src: '/sample.png',
          alt: 'p',
        },
        { id: 'd', type: 'paragraph', depth: 0, content: [{ text: 'ab' }] },
      ],
    });
    // The picture loads after the document is set, and its height moves `d`:
    // a click aimed before it arrived landed short of the end in WebKit, so
    // one press deleted `a`, the next met `b` and the line was never empty.
    await expect
      .poll(() =>
        editor.root
          .locator('img.neditor-image__img')
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBeGreaterThan(0);
    await editor.clickAt('d', 2);
    expect(await editor.selection()).toMatchObject({ blockId: 'd', range: { start: 2, end: 2 } });

    // keyboard.down on a key already down is a repeat, as the OS sends it.
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.down('Backspace');
    }
    await page.keyboard.up('Backspace');

    // Two repeats emptied `ab`, the third removed the empty line and selected
    // the image (TXT-5), and the rest were the same press still held.
    expect(await editor.ids()).toEqual(['a', 'img']);
    expect(await editor.texts()).toEqual(['top', 'cap']);
    expect(await editor.selected()).toEqual(['img']);

    // A new press is a request to delete it.
    await page.keyboard.press('Backspace');
    expect(await editor.ids()).toEqual(['a']);
    expect(await editor.texts()).toEqual(['top']);
  });
});

/**
 * Arrow keys across block edges (the 9 Nov audit, TXT-3 / TXT-4).
 *
 * E2E only: which visual line a caret is on, where a line wraps and the
 * caret's x position are layout, and happy-dom computes none. Every block is
 * its own editing host, so the browser's own arrows stop dead at its edge;
 * each case here is one the editor has to carry across itself.
 */
test.describe('02b · arrows across block edges', () => {
  const p = (
    id: string,
    text: string,
    type: Block['type'] = 'paragraph',
    extra: Partial<Block> = {},
  ): Block => ({
    id,
    type,
    depth: 0,
    content: text ? [{ text }] : [],
    ...extra,
  });

  /** Where the caret is: block, offset and its x as drawn. */
  const caret = async (editor: EditorPage) => {
    const state = await editor.selection();
    const host = state?.cell
      ? editor.cell(state.blockId, state.cell.row, state.cell.column)
      : editor.content(state?.blockId ?? '');
    const offset = state?.range.start ?? 0;
    const point = await editor.pointAt(host, offset);

    return { id: state?.blockId, cell: state?.cell, offset, ...point };
  };

  test('T8 ↑/↓ leave a one-line block in one press and keep the caret over the same x', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.clickAt('p2', 4); // "Brav|o two"
    const start = await caret(editor);

    await page.keyboard.press('ArrowUp');
    const up = await caret(editor);
    expect(up.id).toBe('p1');
    expect(Math.abs(up.x - start.x)).toBeLessThan(12);

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const down = await caret(editor);
    expect(down.id).toBe('p3');
    expect(Math.abs(down.x - start.x)).toBeLessThan(12);
  });

  test('T9 a wrapped block is walked line by line, and left from its first or last line', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    await editor.setDocument({ blocks: [p('a', 'Above'), p('w', long), p('z', 'Below here')] });
    const box = (await editor.content('w').boundingBox())!;
    const line = (await editor.content('a').boundingBox())!.height;
    expect(box.height, 'precondition: the block wraps').toBeGreaterThan(line * 2.5);

    // Down from the first line stays in the block, on the next line.
    await editor.clickAt('w', 3);
    await page.keyboard.press('ArrowDown');
    const second = await caret(editor);
    expect(second.id).toBe('w');
    expect(second.y).toBeGreaterThan(box.y + line);

    // From the last line, one press leaves.
    await editor.clickAt('w', long.length - 2);
    await page.keyboard.press('ArrowDown');
    expect((await caret(editor)).id).toBe('z');

    // Up into it lands on its last line, not at its start or end.
    await editor.clickAt('z', 2);
    await page.keyboard.press('ArrowUp');
    const last = await caret(editor);
    expect(last.id).toBe('w');
    expect(last.y).toBeGreaterThan(box.y + box.height - line);
    expect(last.offset).toBeLessThan(long.length);

    // And up from its first line leaves upward in one press.
    await editor.clickAt('w', 6);
    await page.keyboard.press('ArrowUp');
    expect((await caret(editor)).id).toBe('a');
  });

  /*
   * R2-NAV-1. At a soft wrap the end of one line and the start of the next are
   * one offset. Measuring only the text between caret and edge called the
   * start of line 2 the first line, so ↑ from there left the block and line 1
   * was skipped; the end of line 2 was the last line, and ↓ skipped line 3. T9
   * clicked mid-line and never stood on a wrap point: these do, by every route
   * a reader gets there -- a click at the line's start, the platform's
   * line-start / line-end keys, ↓ from x=0, a click past the line's end.
   */
  test('T9b at a wrap point the caret is on the line it is drawn on, not the one before', async ({
    editor,
    page,
  }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    await editor.load({ doc: 'empty' });
    const long =
      'The quick brown fox jumps over the lazy dog and keeps running across the wide open field until the sun goes down behind the distant hills while the farmer watches quietly from his porch with a cup of tea.';
    await editor.setDocument({ blocks: [p('a', 'Above'), p('w', long), p('z', 'Below')] });
    const starts = await editor.content('w').evaluate((element) => {
      const node = element.firstChild as Text;
      const found = [0];
      let top: number | null = null;

      for (let index = 0; index < node.data.length; index++) {
        const range = element.ownerDocument.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const rect = range.getClientRects()[0];

        if (!rect) {
          continue;
        }

        if (top === null) {
          top = rect.top;
        } else if (rect.top > top + 4) {
          found.push(index);
          top = rect.top;
        }
      }

      return found;
    });
    expect(starts.length, 'precondition: three lines').toBe(3);
    const lineOf = (offset: number) => starts.filter((start) => start <= offset).length - 1;
    const [, second, third] = starts as [number, number, number];
    const lineStart = process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home';
    const lineEnd = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End';

    // A click just left of line 2's first character, then ↑.
    const left = await editor.pointAt(editor.content('w'), second);
    await page.mouse.click(left.x - 3, left.y);
    expect((await caret(editor)).offset, 'precondition: on the wrap point').toBe(second);
    await page.keyboard.press('ArrowUp');
    let at = await caret(editor);
    expect(at.id).toBe('w');
    expect(lineOf(at.offset)).toBe(0);

    // The line-start key on line 2, then ↑.
    await editor.clickAt('w', second + 6);
    await page.keyboard.press(lineStart);
    expect((await caret(editor)).offset).toBe(second);
    await page.keyboard.press('ArrowUp');
    at = await caret(editor);
    expect(at.id).toBe('w');
    expect(lineOf(at.offset)).toBe(0);

    // ↓ from x=0 above lands at the start of line 2; ↑ goes back to line 1.
    await editor.clickAt('a', 0);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    expect(await caret(editor)).toMatchObject({ id: 'w', offset: second });
    await page.keyboard.press('ArrowUp');
    at = await caret(editor);
    expect(at.id).toBe('w');
    expect(lineOf(at.offset)).toBe(0);

    // The line-end key on line 2, then ↓: line 3, not the block below.
    await editor.clickAt('w', second + 6);
    await page.keyboard.press(lineEnd);
    expect((await caret(editor)).offset).toBe(third);
    await page.keyboard.press('ArrowDown');
    at = await caret(editor);
    expect(at.id).toBe('w');
    expect(lineOf(at.offset)).toBe(2);

    // A click just past line 2's end, then ↓. (`pointAt(third)` is the start
    // of line 3: a click beside it is the lower side, which the next case is.)
    const right = await editor.content('w').evaluate((element, offset) => {
      const range = element.ownerDocument.createRange();
      range.setStart(element.firstChild!, offset - 1);
      range.setEnd(element.firstChild!, offset);
      const rect = range.getClientRects()[0]!;
      return { x: rect.right, y: (rect.top + rect.bottom) / 2 };
    }, third);
    await page.mouse.click(right.x + 3, right.y);
    expect((await caret(editor)).offset, 'precondition: on the wrap point').toBe(third);
    await page.keyboard.press('ArrowDown');
    at = await caret(editor);
    expect(at.id).toBe('w');
    expect(lineOf(at.offset)).toBe(2);

    // From the start of the last line, which is the lower side of the last
    // wrap, ↓ leaves in one press (R4-KEY-1: it used to be the browser's, to
    // the end of the block, and a run then stuck there). The column is the
    // line's start, where the caret was drawn -- not the end of line 2, where
    // Chromium and Firefox put a collapsed range's box.
    await editor.clickAt('w', third + 6);
    await page.keyboard.press(lineStart);
    expect((await caret(editor)).offset).toBe(third);
    const drawn = await editor.pointAt(editor.content('w'), third);
    await page.keyboard.press('ArrowDown');
    at = await caret(editor);
    expect(at.id).toBe('z');
    expect(Math.abs(at.x - drawn.x)).toBeLessThan(12);

    // And from the end of the first line, the upper side of the first wrap,
    // ↑ leaves in one press, at that line end's column.
    await editor.clickAt('w', 6);
    await page.keyboard.press(lineEnd);
    expect((await caret(editor)).offset, 'precondition: on the first wrap').toBe(second);
    const end = await editor.content('w').evaluate((element, offset) => {
      const range = element.ownerDocument.createRange();
      range.setStart(element.firstChild!, offset - 1);
      range.setEnd(element.firstChild!, offset);
      return range.getClientRects()[0]!.right;
    }, second);
    await page.keyboard.press('ArrowUp');
    at = await caret(editor);
    expect(at.id).toBe('a');
    expect(at.offset, 'past the end of a short line: its end').toBe('Above'.length);
    expect(end, 'precondition: the line end is right of "Above"').toBeGreaterThan(at.x);

    // Mid-line, as before: one press leaves from the first and last line.
    await editor.clickAt('w', 6);
    await page.keyboard.press('ArrowUp');
    expect((await caret(editor)).id).toBe('a');
    await editor.clickAt('w', long.length - 3);
    await page.keyboard.press('ArrowDown');
    expect((await caret(editor)).id).toBe('z');
  });

  /*
   * R2-NAV-10. A run of ↑/↓ aims for the column it started from: through a
   * two-letter block the caret was clamped to that block's end, and the next
   * block was entered there. And on a code block's empty last line, Firefox
   * and WebKit measured the caret from the end of the line above.
   */
  test('T9c a run of ↑/↓ keeps its column through a short block and off an empty line', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await editor.setDocument({
      blocks: [
        p('p1', 'A long first line of text'),
        p('p2', 'ab'),
        p('p3', 'A long third line of text'),
        p('cd', 'line one\n', 'code'),
        p('p4', 'After the code block'),
      ],
    });

    await editor.clickAt('p1', 20);
    const start = await caret(editor);
    await page.keyboard.press('ArrowDown');
    expect(await caret(editor)).toMatchObject({ id: 'p2', offset: 2 });
    await page.keyboard.press('ArrowDown');
    const third = await caret(editor);
    expect(third.id).toBe('p3');
    expect(Math.abs(third.x - start.x)).toBeLessThan(12);

    // A click starts a new run: from p2's end, ↓ aims at p2's end.
    await editor.clickAt('p2', 2);
    const short = await caret(editor);
    await page.keyboard.press('ArrowDown');
    expect(Math.abs((await caret(editor)).x - short.x)).toBeLessThan(12);

    // The code block's empty trailing line starts where its first line does
    // (inset by the block's padding), not at the end of "line one".
    const lineStart = await editor.pointAt(editor.content('cd'), 0);
    await editor.placeCaret('cd', 9);
    await page.keyboard.press('ArrowDown');
    const below = await caret(editor);
    expect(below.id).toBe('p4');
    expect(Math.abs(below.x - lineStart.x)).toBeLessThan(12);
  });

  const WRAPPING =
    'The quick brown fox jumps over the lazy dog and keeps running across the wide open field until the sun goes down behind the distant hills while the farmer watches quietly from his porch with a cup of tea.';

  /** Offsets where each laid-out line of `id` starts. */
  const lineStarts = (editor: EditorPage, id: string) =>
    editor.content(id).evaluate((element) => {
      const node = element.firstChild as Text;
      const found = [0];
      let top: number | null = null;

      for (let index = 0; index < node.data.length; index++) {
        const range = element.ownerDocument.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const rect = range.getClientRects()[0];

        if (rect && top === null) {
          top = rect.top;
        } else if (rect && top !== null && rect.top > top + 4) {
          found.push(index);
          top = rect.top;
        }
      }

      return found;
    });

  /** The right edge of the character before `offset`: where a caret at a line's end is drawn. */
  const lineEndX = (editor: EditorPage, id: string, offset: number) =>
    editor.content(id).evaluate((element, offset) => {
      const range = element.ownerDocument.createRange();
      range.setStart(element.firstChild!, offset - 1);
      range.setEnd(element.firstChild!, offset);
      return range.getClientRects()[0]!.right;
    }, offset);

  /*
   * R3-KEY-1. Firefox's ← from the start of a wrapped line moves the caret to
   * the end of the line above without changing its offset. Round 2 read a
   * press that kept the offset, mid-text, at the drawn end of a line, as one
   * the browser could not move -- and took the caret out of the block at every
   * soft wrap. Only a logical end crosses now.
   */
  test('T9d ←/→ walk over a soft wrap without leaving the block', async ({ editor, page }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    await editor.load({ doc: 'empty' });
    await editor.setDocument({ blocks: [p('p0', 'Above'), p('p1', WRAPPING), p('p2', 'Below')] });
    const starts = await lineStarts(editor, 'p1');
    expect(starts.length, 'precondition: three lines').toBe(3);
    const [, second, third] = starts as [number, number, number];
    const lineStart = process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home';

    // The line-start key on line 2, then ←.
    await editor.clickAt('p1', second + 6);
    await page.keyboard.press(lineStart);
    await page.keyboard.press('ArrowLeft');
    expect((await caret(editor)).id).toBe('p1');

    // A click just left of line 2's first character, then ←.
    const left = await editor.pointAt(editor.content('p1'), second);
    await page.mouse.click(left.x - 3, left.y);
    await page.keyboard.press('ArrowLeft');
    expect((await caret(editor)).id).toBe('p1');

    // Walked one press at a time across each wrap, both ways.
    await editor.clickAt('p1', second + 2);
    for (let index = 0; index < 5; index++) {
      await page.keyboard.press('ArrowLeft');
      expect((await caret(editor)).id, `← ${index + 1} from line 2`).toBe('p1');
    }
    expect((await caret(editor)).offset).toBeLessThan(second);

    await editor.clickAt('p1', third - 3);
    for (let index = 0; index < 5; index++) {
      await page.keyboard.press('ArrowRight');
      expect((await caret(editor)).id, `→ ${index + 1} from line 2`).toBe('p1');
    }
    expect((await caret(editor)).offset).toBeGreaterThan(third);

    // The logical ends still cross.
    await editor.placeCaret('p1', WRAPPING.length);
    await page.keyboard.press('ArrowRight');
    expect(await editor.selection()).toMatchObject({ blockId: 'p2', range: { start: 0 } });
  });

  /*
   * R3-KEY-2. At a wrap the end of one line and the start of the next are one
   * offset, and the column of a run was measured there before the browser
   * moved, as the start of the next line. After the line-end key, ↓ ↓ then
   * entered the next block at its start. Where the caret is ambiguous the
   * column is taken from where the browser's own move put it.
   */
  test('T9e a run that starts at the end of a wrapped line keeps that line end’s column', async ({
    editor,
    page,
  }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    await editor.load({ doc: 'empty' });
    const two =
      'The quick brown fox jumps over the lazy dog and keeps running across the wide open field until the sun goes down.';
    const next =
      'Next paragraph with plenty of text so that every column has a character above it here.';
    await editor.setDocument({ blocks: [p('p1', two), p('p2', next), p('p3', 'tail')] });
    const starts = await lineStarts(editor, 'p1');
    expect(starts.length, 'precondition: two lines').toBe(2);
    const end = await lineEndX(editor, 'p1', starts[1]!);
    const lineEnd = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End';

    await editor.clickAt('p1', 10);
    await page.keyboard.press(lineEnd);
    expect((await caret(editor)).offset, 'precondition: on the wrap point').toBe(starts[1]);
    await page.keyboard.press('ArrowDown');
    expect((await caret(editor)).id).toBe('p1');
    await page.keyboard.press('ArrowDown');
    const below = await caret(editor);
    expect(below.id).toBe('p2');

    // The next paragraph wraps too, and the column is past its first line's
    // end: the caret is that line's last position, which is a wrap point
    // itself -- so where it is drawn is asked of the browser, by extending to
    // the start of the line it is on.
    const target = await editor.content('p2').evaluate((element, x) => {
      const first = element.ownerDocument.createRange();
      first.selectNodeContents(element);
      const line = first.getClientRects()[0]!;
      const doc = element.ownerDocument as Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offset: number } | null;
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      const y = (line.top + line.bottom) / 2;
      return (
        doc.caretPositionFromPoint?.(x, y)?.offset ?? doc.caretRangeFromPoint?.(x, y)?.startOffset
      );
    }, end);
    expect(below.offset).toBe(target);
    const lineBegins = await editor.content('p2').evaluate((element) => {
      const selection = element.ownerDocument.getSelection()!;
      selection.modify('extend', 'backward', 'lineboundary');
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      range.setEnd(selection.focusNode!, selection.focusOffset);
      return range.toString().length;
    });
    expect(lineBegins, 'drawn on the first line').toBe(0);
  });

  /*
   * R3-KEY-4, the probe's run. Off the end of the document ↓ is the
   * browser's, and the run's column was recorded before that move, so the
   * run ended there and ↑ started a new one from the end of the line.
   *
   * Inside a block the browser moves by its own column, which is wherever
   * the editor last put the caret, and that move stands (R4-KEY-1: putting
   * the caret back under the run's column undid the browser's moves to a
   * block's end, and a run stuck on a wrap). What the run keeps is the
   * column it leaves the block by: up through the code block the caret goes
   * where the browser takes it, and the block above is still entered under
   * the run's column.
   */
  test('T9f a run keeps its column off the end of the document and through a code block', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await editor.setDocument({
      blocks: [
        p('a', 'Alpha paragraph with a long enough line to aim at a column'),
        p('s', 'ab'),
        p('t', '', 'table', {
          rows: [
            [[{ text: 'cell one wide text' }], [{ text: 'cell two wide text here' }]],
            [[{ text: 'x' }], [{ text: 'second row right cell' }]],
          ],
        }),
        p('c', 'const x = 1;\n', 'code'),
        p('l', 'List item with some text in it to aim', 'bulleted_list'),
        { id: 'dv', type: 'divider', depth: 0, content: [] },
        p('z', 'Zulu paragraph with a long enough line to aim at a column'),
      ],
    });

    await editor.clickAt('a', 40);
    const start = await caret(editor);

    for (let index = 0; index < 9; index++) {
      await page.keyboard.press('ArrowDown');
    }
    expect(await caret(editor), 'precondition: at the end of the document').toMatchObject({
      id: 'z',
      offset: 57,
    });

    const up: { id?: string; offset: number; x: number }[] = [];
    for (let index = 0; index < 6; index++) {
      await page.keyboard.press('ArrowUp');
      up.push(await caret(editor));
    }

    expect(up.map((at) => at.id)).toEqual(['l', 'c', 'c', 't', 't', 's']);
    // Up off the code block's empty last line: its first line, wherever the
    // browser's own move put the caret on it. Deliberately loose (R5-KEY-1,
    // Won't fix): inside a block the browser moves by its own column, which
    // is where the caret entered the block -- the empty last line's start --
    // not the run's, and engines disagree on where that lands on the line
    // above. Putting the caret back under the run's column after the
    // browser's move was round 4's trap (R4-KEY-1), so all that is pinned is
    // that the press stayed in the block, on its first line.
    expect(up[2]!.offset).toBeLessThanOrEqual(12);

    await page.keyboard.press('ArrowUp');
    const back = await caret(editor);
    expect(back.id).toBe('a');
    expect(Math.abs(back.x - start.x)).toBeLessThan(12);
  });

  /*
   * R4-KEY-1. A run of ↓ from column 0 through a wrapped paragraph stopped
   * at the start of its last line for good, and ↑ from a far column at the
   * end of a wrapped first line: the caret there is on a wrap, the press was
   * handed to the browser, the browser moved to the block's end, and the
   * editor put the caret back under the run's column -- where it had been.
   * The same in a wrapped table cell. A run walks every line once and leaves.
   * Layout and the browser's own line movement: e2e only.
   */
  test.describe('T9g a run through a wrapped block never sticks on a wrap', () => {
    const WRAP =
      'The quick brown fox jumps over the lazy dog and keeps running across the wide open field until the sun goes down behind the distant hills while the farmer watches.';
    const LONG = 'Zulu paragraph with a line that runs all the way to the right edge of the editor';
    const CELL =
      'a cell with enough words in it that it wraps over several lines inside its narrow column of the table here';
    const lineStart = process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home';
    const lineEnd = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End';

    /** Offsets where each laid-out line of `host` starts. */
    const startsOf = (host: ReturnType<EditorPage['content']>) =>
      host.evaluate((element) => {
        const node = element.firstChild as Text;
        const found = [0];
        let top: number | null = null;

        for (let index = 0; index < node.data.length; index++) {
          const range = element.ownerDocument.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          const rect = range.getClientRects()[0];

          if (rect && top === null) {
            top = rect.top;
          } else if (rect && top !== null && rect.top > top + 4) {
            found.push(index);
            top = rect.top;
          }
        }

        return found;
      });

    /**
     * Presses `key` until the caret reaches `target` (at most `limit` times),
     * and answers the offsets it stood at in the wrapped host on the way.
     * Every press has to move the caret: one that leaves it where it was is
     * the trap. Which line an offset is on is not read from it -- at a wrap
     * it is on either -- so the stops are counted: one per line, in order,
     * is every line walked once, none skipped and no press spent.
     */
    const walk = async (
      editor: EditorPage,
      page: import('@playwright/test').Page,
      key: 'ArrowUp' | 'ArrowDown',
      target: string,
      wrapped: { id: string; cell?: string; starts: number[] },
      limit = 10,
    ) => {
      const seen: string[] = [];
      const stops: number[] = [];

      for (let index = 0; index < limit; index++) {
        await page.keyboard.press(key);
        const at = await caret(editor);
        const where = `${at.id}${at.cell ? `@${at.cell.row}:${at.cell.column}` : ''}:${at.offset}`;
        expect(where, `stuck after ${seen.join(' ')}`).not.toBe(seen.at(-1));
        seen.push(where);

        const cell = at.cell ? `${at.cell.row}:${at.cell.column}` : undefined;
        if (at.id === wrapped.id && cell === wrapped.cell) {
          stops.push(at.offset);
        }

        if (at.id === target) {
          const order = [...stops].sort((one, two) =>
            key === 'ArrowDown' ? one - two : two - one,
          );
          expect(stops, 'in reading order').toEqual(order);
          expect(stops, `one stop per line of ${wrapped.starts.length}`).toHaveLength(
            wrapped.starts.length,
          );
          return seen;
        }
      }

      throw new Error(`never reached ${target}: ${seen.join(' ')}`);
    };

    test('a paragraph, ↓ from column 0 and ↑ from the far right', async ({ editor, page }) => {
      await page.setViewportSize({ width: 700, height: 800 });
      await editor.load({ doc: 'empty' });
      await editor.setDocument({
        blocks: [p('a', 'Alpha first paragraph'), p('w', WRAP), p('z', LONG)],
      });
      const starts = await startsOf(editor.content('w'));
      expect(starts.length, 'precondition: wrapped').toBeGreaterThan(1);

      await editor.clickAt('a', 3);
      await page.keyboard.press(lineStart);
      const down = await walk(editor, page, 'ArrowDown', 'z', { id: 'w', starts });
      expect(down).toHaveLength(starts.length + 1);

      await editor.clickAt('z', 3);
      await page.keyboard.press(lineEnd);
      const up = await walk(editor, page, 'ArrowUp', 'a', { id: 'w', starts });
      expect(up).toHaveLength(starts.length + 1);
    });

    test('a paragraph whose first line is short, ↑ from the far right', async ({
      editor,
      page,
    }) => {
      await page.setViewportSize({ width: 700, height: 800 });
      await editor.load({ doc: 'empty' });
      const text =
        'Short first line then https://example.com/averyveryverylongpathsegmentthatwillnotfitontheline/and/more and some more text after it.';
      await editor.setDocument({
        blocks: [p('a', 'Alpha first paragraph'), p('w', text), p('z', LONG)],
      });
      const starts = await startsOf(editor.content('w'));
      expect(starts.length, 'precondition: wrapped').toBeGreaterThan(1);

      await editor.clickAt('z', 3);
      await page.keyboard.press(lineEnd);
      await walk(editor, page, 'ArrowUp', 'a', { id: 'w', starts });
    });

    test('a table cell, ↓ from column 0 and ↑ from the far right', async ({ editor, page }) => {
      await page.setViewportSize({ width: 700, height: 800 });
      await editor.load({ doc: 'empty' });
      await editor.setDocument({
        blocks: [
          p('a', 'Alpha'),
          p('t', '', 'table', {
            rows: [
              [[{ text: 'top left' }], [{ text: 'top right' }]],
              [[{ text: CELL }], [{ text: CELL }]],
              [[{ text: 'bottom left' }], [{ text: 'bottom right' }]],
            ],
          }),
          p('z', LONG),
        ],
      });
      const left = await startsOf(editor.cell('t', 1, 0));
      const right = await startsOf(editor.cell('t', 1, 1));
      expect(left.length, 'precondition: the cell wraps').toBeGreaterThan(2);

      await editor.clickAt('a', 2);
      await page.keyboard.press(lineStart);
      await walk(editor, page, 'ArrowDown', 'z', { id: 't', cell: '1:0', starts: left });

      await editor.clickAt('z', 3);
      await page.keyboard.press(lineEnd);
      await walk(editor, page, 'ArrowUp', 'a', { id: 't', cell: '1:1', starts: right });
    });
  });

  /*
   * R4-KEY-4. A run went on while the caret was where its last press left it,
   * and a click that put it back there exactly -- past the end of the same
   * short line -- continued the old run's column. A click starts a new run.
   * Caret geometry: e2e only (happy-dom measures no column, so no run).
   */
  test('T9h a click back onto where a run ended starts a new run', async ({ editor, page }) => {
    await editor.load({ doc: 'empty' });
    await editor.setDocument({
      blocks: [
        p('a', 'Alpha paragraph with a long enough line to aim at a column'),
        p('s', 'ab'),
        p('z', 'Zulu paragraph with a long enough line to aim at a column'),
      ],
    });

    await editor.clickAt('a', 45);
    await page.keyboard.press('ArrowDown');
    expect(await caret(editor), 'precondition: the run ended at the end of "ab"').toMatchObject({
      id: 's',
      offset: 2,
    });

    await editor.clickAt('z', 5);
    const end = await editor.pointAt(editor.content('s'), 2);
    await page.mouse.click(end.x + 6, end.y);
    const clicked = await caret(editor);
    expect(clicked, 'precondition: back where the run ended').toMatchObject({ id: 's', offset: 2 });

    await page.keyboard.press('ArrowDown');
    const below = await caret(editor);
    expect(below.id).toBe('z');
    expect(Math.abs(below.x - clicked.x)).toBeLessThan(12);
  });

  /*
   * R5-KEY-2, the probe's scenario. Only a press in the root and a key reset
   * the run, so a host that called `focus()` at the place the run ended --
   * or reloaded the document under the caret, or edited it -- went on with
   * the old run's column: ↓ entered the next block at column 70 instead of
   * under "Tiny"'s end. Each of them starts a new run. Caret geometry: e2e
   * only (happy-dom measures no column, so no run).
   */
  test('T9i the host’s focus(), setDocument and an edit start a new run', async ({
    editor,
    page,
  }) => {
    const A = 'Alpha paragraph with a line that is long enough to aim at any column here';
    const Z = 'Zulu paragraph with a line that is long enough to aim at any column here';
    await editor.load({ doc: 'empty' });

    const hosts: [string, () => unknown][] = [
      ['focus', () => window.__e2e.editor.focus('q', 4)],
      ['focusRange', () => window.__e2e.editor.focusRange('q', 4, 4)],
      [
        'setDocument',
        () => {
          const ed = window.__e2e.editor;
          ed.setDocument(ed.getDocument());
        },
      ],
      // An edit that leaves the caret alone (`setBlockType` focuses its block).
      ['an edit', () => window.__e2e.editor.toggleTodo('t')],
    ];

    for (const [how, run] of hosts) {
      await editor.setDocument({
        blocks: [p('a', A), p('q', 'Tiny'), p('z', Z), p('t', 'Done', 'todo')],
      });
      await editor.clickAt('a', 70);
      await page.keyboard.press('ArrowDown');
      expect(await caret(editor), `${how} precondition: the run ended at "Tiny|"`).toMatchObject({
        id: 'q',
        offset: 4,
      });

      await page.evaluate(run);
      const here = await caret(editor);
      expect(here, `${how} precondition: still where the run ended`).toMatchObject({
        id: 'q',
        offset: 4,
      });

      await page.keyboard.press('ArrowDown');
      const below = await caret(editor);
      expect(below.id, how).toBe('z');
      expect(Math.abs(below.x - here.x), how).toBeLessThan(12);
    }
  });

  test('T10 a Shift+Enter break and a code block are lines too', async ({ editor, page }) => {
    await editor.load({ doc: 'empty' });
    await editor.setDocument({
      blocks: [
        p('a', 'Above'),
        p('br', 'one\ntwo'),
        p('code', 'a = 1\nb = 2', 'code'),
        p('z', 'Below'),
      ],
    });

    await editor.clickAt('br', 1);
    await page.keyboard.press('ArrowDown');
    expect(await caret(editor)).toMatchObject({ id: 'br' });
    expect((await caret(editor)).offset).toBeGreaterThanOrEqual(4);
    await page.keyboard.press('ArrowDown');
    expect((await caret(editor)).id).toBe('code');
    expect((await caret(editor)).offset).toBeLessThanOrEqual(5);
    await page.keyboard.press('ArrowDown');
    expect((await caret(editor)).id).toBe('code');
    await page.keyboard.press('ArrowDown');
    expect((await caret(editor)).id).toBe('z');

    await page.keyboard.press('ArrowUp');
    const back = await caret(editor);
    expect(back.id).toBe('code');
    expect(back.offset).toBeGreaterThanOrEqual(6);
  });

  test('T11 an image caption and a table are stops on the way, each in one press', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await editor.setDocument({
      blocks: [
        p('a', 'Above the image'),
        p('img', 'A caption', 'image', { src: '/sample.png', alt: 'A blue gradient' }),
        p('m', 'Between them'),
        p('tbl', '', 'table', {
          rows: [
            [[{ text: 'H1' }], [{ text: 'H2' }]],
            [[{ text: 'c1' }], [{ text: 'c2' }]],
          ],
        }),
        p('z', 'Below the table, long enough to reach under the second column'),
      ],
    });

    // Measured once the picture has loaded: a load landing after the
    // measurements moved everything below it, and the click went elsewhere.
    await expect
      .poll(() =>
        editor
          .block('img')
          .locator('img')
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBeGreaterThan(0);
    await editor.settle();

    // Up from below a table enters its last row, under the caret (TXT-4).
    const column = (await editor.cell('tbl', 1, 1).boundingBox())!;
    const under = await editor.pointAt(editor.content('z'), 0);
    const zBox = (await editor.content('z').boundingBox())!;
    await page.mouse.click(column.x + column.width / 2, zBox.y + (under.y - zBox.y));
    await page.keyboard.press('ArrowUp');
    expect(await caret(editor)).toMatchObject({ id: 'tbl', cell: { row: 1, column: 1 } });
    await page.keyboard.press('ArrowUp');
    expect(await caret(editor)).toMatchObject({ id: 'tbl', cell: { row: 0, column: 1 } });
    await page.keyboard.press('ArrowUp');
    expect((await caret(editor)).id).toBe('m');
    await page.keyboard.press('ArrowUp');
    expect((await caret(editor)).id).toBe('img');
    await page.keyboard.press('ArrowUp');
    expect((await caret(editor)).id).toBe('a');
    await page.keyboard.press('ArrowDown');
    expect((await caret(editor)).id).toBe('img');
  });

  test('T12 ←/→ at the edge of a block step into the next, and over a divider', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'divider' });
    await editor.clickAt('p1', 5);
    await page.keyboard.press('ArrowRight');
    expect(await editor.selection()).toMatchObject({ blockId: 'p2', range: { start: 0, end: 0 } });
    await page.keyboard.press('ArrowLeft');
    expect(await editor.selection()).toMatchObject({ blockId: 'p1', range: { start: 5, end: 5 } });
    // Mid-text the arrow is the browser's.
    await page.keyboard.press('ArrowLeft');
    expect(await editor.selection()).toMatchObject({ blockId: 'p1', range: { start: 4, end: 4 } });
  });

  test('T13 right to left, the key that moves forward is ←', async ({ editor, page }) => {
    await editor.load({ doc: 'empty', dir: 'rtl' });
    await editor.setDocument({ blocks: [p('a', 'שלום עולם'), p('m', 'מילה שנייה')] });
    // Arranged through the API: a click at the edge of a line is ambiguous
    // under bidi, and which end it picks is not what is being tested.
    await editor.placeCaret('a', 9);
    await page.keyboard.press('ArrowLeft');
    expect(await editor.selection()).toMatchObject({ blockId: 'm', range: { start: 0, end: 0 } });
    await page.keyboard.press('ArrowRight');
    expect(await editor.selection()).toMatchObject({ blockId: 'a', range: { start: 9, end: 9 } });
    // → at the logical end is backward in this direction: the browser's own.
    await editor.placeCaret('a', 9);
    await page.keyboard.press('ArrowRight');
    expect(await editor.selection()).toMatchObject({ blockId: 'a', range: { start: 8, end: 8 } });
  });

  /*
   * R2-NAV-2. Which end of the text an arrow is stopped at is where bidi drew
   * it, not the host's direction: English in an RTL editor and Hebrew in an
   * LTR one start at the far side. At the logical start the key pointing into
   * the text jumped to the previous block, the other was stuck, and Firefox
   * could never leave all-Hebrew text in an LTR editor at all. From each end,
   * one key must step into the text and the other out of the block.
   */
  for (const [dir, text] of [
    ['rtl', 'Hello world'],
    ['ltr', 'שלום עולם'],
  ] as const) {
    test(`T13b text against its editor's direction (${dir}): each end has a way in and a way out`, async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'empty', ...(dir === 'rtl' ? { dir } : {}) });
      await editor.setDocument({ blocks: [p('a', 'first'), p('m', text), p('z', 'third')] });

      for (const offset of [0, text.length]) {
        const out: string[] = [];

        for (const key of ['ArrowLeft', 'ArrowRight']) {
          await editor.placeCaret('m', offset);
          await page.keyboard.press(key);
          const state = await editor.selection();

          if (state?.blockId === 'm') {
            expect(state.range.start, `${key} from ${offset} moved within the text`).not.toBe(
              offset,
            );
          } else {
            out.push(state?.blockId ?? 'none');
          }
        }

        // Out the logical way: before the text from its start, after it from its end.
        expect(out, `from offset ${offset}`).toEqual([offset === 0 ? 'a' : 'z']);
      }
    });
  }

  /*
   * The probe's walks: from either end, either key, pressed until the caret
   * leaves the block. Text in one direction always leaves by the arrow.
   *
   * Mixed-direction text is a documented limit (R3-KEY-1): Firefox moves
   * visually, and in an RTL line with English in it the press that stops
   * moving can be mid-text, where nothing crosses -- reading a held caret
   * there as "at the drawn end of the line" took the caret out of the block at
   * every soft wrap. What must hold is that nothing traps it: the arrow walks
   * until it leaves or the browser stops moving it, and from there ↓ leaves.
   */
  for (const [dir, text] of [
    ['rtl', 'שלום עולם'],
    ['rtl', 'Hello world'],
    ['ltr', 'שלום עולם'],
    ['ltr', 'abc שלום def'],
    ['rtl', 'abc שלום def'],
  ] as const) {
    const mixed = /[a-z]/.test(text) && /[֐-׿]/.test(text);

    test(`T13e ←/→ held through ${JSON.stringify(text)} (${dir}) ${mixed ? 'never trap the caret' : 'always leave the block'}`, async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'empty', ...(dir === 'rtl' ? { dir } : {}) });
      await editor.setDocument({ blocks: [p('a', 'first'), p('m', text), p('z', 'third')] });

      for (const key of ['ArrowLeft', 'ArrowRight']) {
        for (const offset of [0, text.length]) {
          await editor.placeCaret('m', offset);
          let presses = 0;
          let stopped = false;

          while (!stopped && (await editor.selection())?.blockId === 'm') {
            const before = (await editor.selection())?.range.start;
            await page.keyboard.press(key);
            presses += 1;
            const after = await editor.selection();
            stopped =
              presses > text.length + 2 || (after?.blockId === 'm' && after.range.start === before);
          }

          if (!mixed) {
            expect(
              (await editor.selection())?.blockId,
              `${key} from ${offset} left within ${presses} presses`,
            ).not.toBe('m');
          } else if ((await editor.selection())?.blockId === 'm') {
            expect(
              presses,
              `${key} from ${offset} stopped rather than looping`,
            ).toBeLessThanOrEqual(text.length + 2);
            await page.keyboard.press('ArrowDown');
            expect((await editor.selection())?.blockId, `↓ after ${key} from ${offset}`).toBe('z');
          }
        }
      }
    });
  }

  test('T13c a held arrow crosses one block edge per repeat, and walks on through the next', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await editor.setDocument({ blocks: [p('a', 'ab'), p('b', 'cd'), p('c', 'ef')] });
    await editor.placeCaret('a', 0);
    const seen: string[] = [];

    // Auto-repeat is ~30ms apart; a frame between presses stands in for it.
    for (let index = 0; index < 7; index++) {
      await page.keyboard.down('ArrowRight');
      await editor.settle();
      const state = await editor.selection();
      seen.push(`${state?.blockId}:${state?.range.start}`);
    }

    await page.keyboard.up('ArrowRight');
    expect(seen).toEqual(['a:1', 'a:2', 'b:0', 'b:1', 'b:2', 'c:0', 'c:1']);
  });

  /*
   * R2-NAV-12. Modified, the vertical arrows are the platform's: on macOS ⌘↑/↓
   * go to the start or end of the document and ⌥↑/↓ to the paragraph's. At a
   * block's edge round 1 made them step one block instead.
   */
  for (const key of [`${MOD}+ArrowUp`, 'Alt+ArrowUp', `${MOD}+ArrowDown`, 'Alt+ArrowDown']) {
    test(`T13d ${key} at a block's edge does not step into the next block`, async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'five' });
      await editor.clickAt('c', 4);

      for (let index = 0; index < 3; index++) {
        await page.keyboard.press(key);
      }

      expect((await editor.selection())?.blockId).toBe('c');
    });
  }
  /**
   * R1-TYPING P3-5. The input rule leaves the caret after `bold` with the mark
   * switched off, armed for that caret only. A Backspace moves the caret, and
   * Chromium kept the armed marks in `getSelectionState()` where Firefox and
   * WebKit dropped them: the state is the model's, in every engine.
   */
  test("T14 the marks at a caret after a Backspace are the model's, in every engine", async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await editor.clickAt('p1', 0);
    await page.keyboard.type('**bold**');
    expect((await editor.selection())?.marks).toEqual([]);

    await page.keyboard.press('Backspace');
    expect((await editor.texts())[0]).toBe('bol');
    expect((await editor.selection())?.marks).toEqual(['bold']);
  });
});
