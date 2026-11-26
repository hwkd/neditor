import type { Locator } from '@playwright/test';
import { EditorPage, expect, MOD, test } from '../helpers/test.ts';

test.describe('10 · pointer selection across blocks', () => {
  test('P1 dragging text into another block selects whole blocks; back to the start shrinks to text', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    const start = await editor.pointAt(editor.content('a'), 3);
    const end = await editor.pointAt(editor.content('c'), 3);

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 });
    await expect(editor.root).toHaveAttribute('data-selecting', 'true');
    expect(await editor.selected()).toEqual(['a', 'b', 'c']);

    // Back into the anchor block: text again, from the press to the pointer.
    // Was STR-12: the block was left selected whole, so typing replaced it.
    await page.mouse.move(start.x + 20, start.y, { steps: 12 });
    expect(await editor.selected()).toEqual([]);
    const range = (await editor.selection())!;
    expect(range.blockId).toBe('a');
    expect(range.range.start).toBe(3);
    expect(range.range.end).toBeGreaterThan(3);
    await page.mouse.up();
    await expect(editor.root).not.toHaveAttribute('data-selecting', 'true');
    await editor.type('Q');
    expect(await editor.texts()).toEqual([
      expect.stringMatching(/^BloQ/),
      'Block B',
      'Block C',
      'Block D',
      'Block E',
    ]);
    await page.keyboard.press(`${MOD}+z`);

    await editor.dragText(['b', 2], ['d', 2]);
    expect(await editor.selected()).toEqual(['b', 'c', 'd']);
    await page.keyboard.press('Backspace');
    expect(await editor.ids()).toEqual(['a', 'e']);
  });

  test('P2 a release below the last block selects through the last block', async ({
    editor,
    page,
  }) => {
    // Was FINDING F7, fixed; see docs/e2e-progress.md.
    await editor.load({ doc: 'five' });
    const start = await editor.pointAt(editor.content('c'), 2);
    const last = (await editor.block('e').boundingBox())!;
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(last.x + 40, last.y + last.height + 30, { steps: 12 });
    await page.mouse.up();
    expect(await editor.selected()).toEqual(['c', 'd', 'e']);
    expect(await editor.invariants()).toEqual([]);
  });

  test('P3 read-only: pointer selection works and the blocks can be copied', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five', editable: false });
    await editor.dragText(['a', 1], ['b', 3]);
    expect(await editor.selected()).toEqual(['a', 'b']);

    // Was FINDING F8, fixed; see docs/e2e-progress.md.
    await page.keyboard.press(`${MOD}+c`);
    await page.locator('#paste-target').click();
    await page.keyboard.press(`${MOD}+v`);
    await expect(page.locator('#paste-target')).toHaveValue('Block A\n\nBlock B');
    expect(await editor.ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('P4 clicking under the last block reuses an empty last block, or appends one', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    const root = (await editor.root.boundingBox())!;
    await page.mouse.click(root.x + root.width / 2, root.y + root.height - 4);
    expect(await editor.outline()).toEqual([
      'paragraph:Alpha one',
      'paragraph:Bravo two',
      'paragraph:Charlie three',
      'paragraph:',
    ]);
    const appended = (await editor.ids())[3]!;
    expect(await editor.focusedBlock()).toBe(appended);

    await page.mouse.click(root.x + root.width / 2, root.y + root.height - 4);
    expect(await editor.ids()).toHaveLength(4);
    expect(await editor.focusedBlock()).toBe(appended);
  });

  test('P5 clicking into text ends a block selection', async ({ editor, page }) => {
    await editor.load({ doc: 'five' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['b', 'c']));
    await editor.clickAt('d', 3);
    expect(await editor.selected()).toEqual([]);
    expect(await editor.selection()).toMatchObject({ blockId: 'd', range: { start: 3, end: 3 } });
  });

  // e2e only: which element a margin or a padding band hit-tests to, and where
  // the nearest text is, are layout questions happy-dom cannot answer.
  test('P6 a click in the margin above a heading or the top padding lands in the nearest block, never appends', async ({
    editor,
    page,
  }) => {
    // Was TXT-1: every press whose target was the root appended a paragraph to
    // the END of the document and scrolled ~970px there.
    await editor.load({ doc: 'paragraphs', toolbar: 0 });
    const paragraph = (id: string, text: string) => ({
      id,
      type: 'paragraph' as const,
      content: [{ text }],
      depth: 0,
    });
    const blocks = [
      paragraph('intro', 'Intro paragraph'),
      { id: 'h', type: 'heading2' as const, content: [{ text: 'Section heading' }], depth: 0 },
      ...Array.from({ length: 50 }, (_, i) => paragraph(`x${i}`, `Body ${i}`)),
      paragraph('end', 'The end'),
    ];
    await editor.setDocument({ blocks });
    await editor.clearLog();

    const intro = (await editor.block('intro').boundingBox())!;
    const heading = (await editor.block('h').boundingBox())!;
    const band = heading.y - (intro.y + intro.height);
    expect(band, 'the heading has a top margin to click in').toBeGreaterThan(4);

    // The lower half of the band is nearer the heading.
    await page.mouse.click(heading.x + 120, heading.y - band / 4);
    expect(await editor.ids()).toHaveLength(blocks.length);
    expect((await editor.selection())?.blockId).toBe('h');
    expect(await editor.canUndo()).toBe(false);
    expect(await editor.events('change')).toEqual([]);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    // The root's own top padding means the first block, at the point nearest
    // the press -- the start of a line clicked left of the text.
    const root = (await editor.root.boundingBox())!;
    await page.mouse.click(intro.x + 120, (root.y + intro.y) / 2);
    expect(await editor.ids()).toHaveLength(blocks.length);
    expect((await editor.selection())?.blockId).toBe('intro');

    // The text goes where the caret is.
    await editor.type('Z');
    expect((await editor.texts())[0]).toContain('Z');
    expect(await editor.ids()).toHaveLength(blocks.length);
  });

  test('P7 the checkbox toggles and leaves the caret or the block selection as it was', async ({
    editor,
    page,
  }) => {
    // Was STR-2: the root's mousedown cleared the block selection, the
    // checkbox kept focus on the root, and nothing placed a caret -- neither
    // mode, every key dead.
    await editor.load({ doc: 'lists' });
    await editor.clickAt('b1', 2);
    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual(['b1']);

    await editor.block('t1').locator('.neditor-block__checkbox').click();
    expect((await editor.blockData('t1'))?.checked).toBe(true);
    expect(await editor.selected()).toEqual(['b1']);
    await page.keyboard.press('ArrowDown');
    expect(await editor.selected()).toEqual(['b2']);

    await editor.clickAt('n1', 3);
    await editor.block('t2').locator('.neditor-block__checkbox').click();
    expect((await editor.blockData('t2'))?.checked).toBe(false);
    expect(await editor.selected()).toEqual([]);
    expect(await editor.selection()).toMatchObject({ blockId: 'n1', range: { start: 3, end: 3 } });
    await editor.type('Z');
    expect((await editor.texts())[2]).toBe('NumZber one');
  });

  test('P8 a list marker, a divider and a table border each leave the editor in a mode', async ({
    editor,
    page,
  }) => {
    // Was STR-2 / TXT-15: each of these is in a block but outside its host,
    // so the press focused the root and placed nothing.
    await editor.load({ doc: 'kitchen-sink' });

    for (const id of ['bl', 'nl']) {
      await editor.clickAt('end', 2);
      const marker = editor.block(id).locator('.neditor-block__marker');
      await marker.scrollIntoViewIfNeeded();
      await marker.click();
      expect(await editor.selected()).toEqual([]);
      expect(await editor.selection()).toMatchObject({ blockId: id, range: { start: 0, end: 0 } });
    }

    const divider = editor.block('hr');
    await divider.scrollIntoViewIfNeeded();
    await divider.click();
    expect(await editor.selected()).toEqual(['hr']);

    await page.keyboard.press('Escape');
    const table = editor.block('tbl').locator('table');
    await table.scrollIntoViewIfNeeded();
    const box = (await table.boundingBox())!;
    // The outer border of the bottom-right corner, not inside any cell.
    await page.mouse.click(box.x + box.width - 0.5, box.y + box.height - 0.5);
    const state = await editor.selection();
    expect(await editor.selected()).toEqual([]);
    expect(state?.blockId).toBe('tbl');
    expect(state?.cell).toBeDefined();
  });

  test('P9 Escape mid text drag ends the gesture only: the selection stays and the editor keeps focus', async ({
    editor,
    page,
  }) => {
    // Was STR-7: the root's block-mode Escape ran too (selection cleared,
    // "Left the editor"), and the drag carried on -- the next move re-selected
    // and took focus back. WebKit briefly held a caret beside the selection.
    await editor.load({ doc: 'five' });
    const b = await editor.pointAt(editor.content('b'), 2);
    const d = await editor.pointAt(editor.content('d'), 2);
    const e = await editor.pointAt(editor.content('e'), 2);
    await page.mouse.move(b.x, b.y);
    await page.mouse.down();
    await page.mouse.move(d.x, d.y, { steps: 8 });
    expect(await editor.selected()).toEqual(['b', 'c', 'd']);
    await editor.clearLog();

    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual(['b', 'c', 'd']);
    await expect(editor.root).toBeFocused();
    await expect(editor.root).not.toHaveAttribute('data-selecting', 'true');
    expect(await editor.announcements()).not.toContain('Left the editor');
    expect(await editor.invariants()).toEqual([]);

    await page.mouse.move(e.x, e.y, { steps: 6 });
    expect(await editor.selected()).toEqual(['b', 'c', 'd']);
    expect(await editor.invariants()).toEqual([]);
    await page.mouse.up();
    expect(await editor.selected()).toEqual(['b', 'c', 'd']);
    await expect(editor.root).toBeFocused();
  });

  // e2e only: scrolling and the frames that drive it are not in happy-dom.
  test('P10 a text drag held at the bottom edge scrolls the page and keeps selecting', async ({
    editor,
    page,
  }) => {
    // Was STR-6: holding at the edge for a second left scrollY at 0.
    await editor.load({ doc: 'long', toolbar: 0 });
    const start = await editor.pointAt(editor.content('p2'), 3);
    const height = page.viewportSize()!.height;
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, height - 2, { steps: 10 });

    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(600);
    // The selection followed the blocks the scroll brought under the pointer,
    // well past the ones that were on screen when the press began.
    const selected = await editor.selected();
    expect(selected[0]).toBe('p2');
    expect(selected.length).toBeGreaterThan(30);

    await page.mouse.up();
    const settled = await page.evaluate(() => window.scrollY);
    await editor.settle();
    await editor.settle();
    expect(await page.evaluate(() => window.scrollY)).toBe(settled);
  });

  // e2e only: what a marker hit-tests to, and where a drag's pointer is over,
  // are layout.
  test('P11 a drag that starts on a list marker selects text in its item, and is text again when it comes back', async ({
    editor,
    page,
  }) => {
    // Was R2-UI-1: the press had no host to anchor at, so within the item it
    // selected nothing and, after a detour into n2, the release left [n1, n2]
    // selected -- typing replaced both.
    await editor.load({ doc: 'lists', toolbar: 0 });
    const marker = (await editor.block('n1').locator('.neditor-block__marker').boundingBox())!;
    const inN1 = await editor.pointAt(editor.content('n1'), 6);
    const n2 = await editor.pointAt(editor.content('n2'), 4);

    await page.mouse.move(marker.x + marker.width / 2, marker.y + marker.height / 2);
    await page.mouse.down();
    await page.mouse.move(inN1.x, inN1.y, { steps: 6 });
    expect(await editor.selection()).toMatchObject({ blockId: 'n1', range: { start: 0, end: 6 } });
    await page.mouse.move(n2.x, n2.y, { steps: 6 });
    expect(await editor.selected()).toEqual(['n1', 'n2']);
    await page.mouse.move(inN1.x, inN1.y, { steps: 6 });
    await page.mouse.up();

    expect(await editor.selected()).toEqual([]);
    expect(await editor.selection()).toMatchObject({ blockId: 'n1', range: { start: 0, end: 6 } });
    await editor.type('Q');
    expect((await editor.texts()).slice(2, 4)).toEqual(['Q one', 'Number two']);
  });

  // e2e only: margins, padding and which element they hit-test to are layout.
  test('P12 a press outside every host drags, keeps a range on a right-click, and Shift extends it', async ({
    editor,
    page,
  }) => {
    // Was R2-UI-2: the press's mousedown was cancelled to place the caret,
    // which also cancelled the browser's drag selection; and it ignored the
    // button and Shift.
    await editor.load({ doc: 'paragraphs', toolbar: 0 });
    const t = (text: string) => [{ text }];
    await editor.setDocument({
      blocks: [
        { id: 'p1', type: 'paragraph', content: t('First paragraph here'), depth: 0 },
        { id: 'h', type: 'heading1', content: t('A big heading'), depth: 0 },
        { id: 'p2', type: 'paragraph', content: t('Second paragraph text'), depth: 0 },
        { id: 'p3', type: 'paragraph', content: t('Third paragraph text'), depth: 0 },
      ],
    });
    const root = (await editor.root.boundingBox())!;
    const p1 = (await editor.content('p1').boundingBox())!;
    const heading = (await editor.content('h').boundingBox())!;
    const bandY = heading.y - 3;
    expect(
      await page.evaluate(
        ([x, y]) => document.elementFromPoint(x!, y!)?.classList.contains('neditor'),
        [heading.x + 20, bandY],
      ),
      'the band above the heading is the root',
    ).toBe(true);

    // A drag from the root's top padding into p2 crosses blocks.
    const inP2 = await editor.pointAt(editor.content('p2'), 6);
    await page.mouse.move(p1.x + 2, (root.y + p1.y) / 2);
    await page.mouse.down();
    await page.mouse.move(inP2.x, inP2.y, { steps: 12 });
    await page.mouse.up();
    expect(await editor.selected()).toEqual(['p1', 'h', 'p2']);

    // A drag from the band across the heading's own text selects that text.
    const inHeading = await editor.pointAt(editor.content('h'), 8);
    await page.mouse.move(heading.x + 2, bandY);
    await page.mouse.down();
    await page.mouse.move(inHeading.x, inHeading.y, { steps: 10 });
    await page.mouse.up();
    expect(await editor.selected()).toEqual([]);
    expect(await editor.selection()).toMatchObject({ blockId: 'h', range: { start: 0, end: 8 } });

    // A click there that jitters a pixel or two is still a click: the band is
    // no block's, and the paragraph above it is not what was aimed at.
    await page.mouse.move(heading.x + 40, bandY);
    await page.mouse.down();
    await page.mouse.move(heading.x + 41, bandY - 1, { steps: 2 });
    await page.mouse.up();
    expect(await editor.selected()).toEqual([]);
    expect((await editor.selection())?.blockId).toBe('h');

    // A right-click there leaves the range a context menu is for.
    await editor.placeCaret('p3', 4, 6);
    await page.mouse.click(heading.x + 100, bandY, { button: 'right' });
    await page.waitForTimeout(100);
    expect(await editor.selection()).toMatchObject({ blockId: 'p3', range: { start: 4, end: 6 } });

    // And on the root's top padding and the gutter's background, with a range
    // a drag made. Was R3-PTR-2: Chromium selects a word of its choosing in
    // contextmenu's own default action, after the editor had put the range
    // back -- one that began outside the editor, so the next key was lost.
    for (const where of ['top padding', 'gutter background'] as const) {
      // A click first, as a reader dismisses the menu: in headless Chromium a
      // drag straight after a right-click collapses, editor or no editor.
      await editor.clickAt('p1', 1);
      await editor.dragText(['p2', 0], ['p2', 6], 4);
      expect(await editor.selection()).toMatchObject({
        blockId: 'p2',
        range: { start: 0, end: 6 },
      });
      const block = (await editor.block('p2').boundingBox())!;
      const point =
        where === 'top padding'
          ? { x: block.x + 120, y: root.y + 3 }
          : { x: block.x + 18, y: block.y + 2 };

      if (where === 'gutter background') {
        await page.mouse.move(block.x + 100, block.y + 10);
        await page.mouse.move(point.x, point.y, { steps: 3 });
      }

      await page.mouse.click(point.x, point.y, { button: 'right' });
      await page.waitForTimeout(100);
      expect(await editor.selection(), where).toMatchObject({
        blockId: 'p2',
        range: { start: 0, end: 6 },
      });
      await editor.type('Z');
      expect((await editor.texts())[2], where).toBe('Z paragraph text');
      await page.keyboard.press(`${MOD}+z`);
      expect((await editor.texts())[2]).toBe('Second paragraph text');
    }

    // Shift+click there, with the caret in another block, leaves it be.
    await editor.clickAt('p3', 4);
    await page.keyboard.down('Shift');
    await page.mouse.click(heading.x + 100, bandY);
    await page.keyboard.up('Shift');
    expect(await editor.selection()).toMatchObject({ blockId: 'p3', range: { start: 4, end: 4 } });

    // And with the caret in the heading, extends it to the point nearest.
    await editor.clickAt('h', 8);
    const atTwo = await editor.pointAt(editor.content('h'), 2);
    await page.keyboard.down('Shift');
    await page.mouse.click(atTwo.x, bandY);
    await page.keyboard.up('Shift');
    expect(await editor.selection()).toMatchObject({ blockId: 'h', range: { start: 2, end: 8 } });
    await editor.type('Z');
    expect((await editor.texts())[1]).toBe('A Zading');

    // Two more places Chromium's own range went wrong (R3-PTR-2, the demo's
    // grid): the gutter's handle, and the root's side padding beside a block
    // that follows a divider -- there the range ran from the divider into the
    // next block, and the release promoted it to both blocks selected.
    await editor.setDocument({
      blocks: [
        { id: 'p1', type: 'paragraph', depth: 0, content: t('Alpha one') },
        { id: 'd', type: 'divider', depth: 0, content: [] },
        { id: 'c', type: 'paragraph', depth: 0, content: t('Note text here') },
        { id: 'p3', type: 'paragraph', depth: 0, content: t('Charlie three') },
      ],
    });
    await page.addStyleTag({ content: '#editor{padding:24px 20px}' });
    const side = (await editor.root.boundingBox())!;

    for (const where of ['handle', 'side padding'] as const) {
      await editor.clickAt('p3', 2);
      await editor.dragText(['p1', 0], ['p1', 5], 3);
      expect(await editor.selection()).toMatchObject({
        blockId: 'p1',
        range: { start: 0, end: 5 },
      });

      if (where === 'handle') {
        await editor.hoverBlock('c');
        const handle = (await editor.handle.boundingBox())!;
        await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      } else {
        const next = (await editor.block('c').boundingBox())!;
        await page.mouse.move(side.x + 4, next.y + 4);
      }

      await page.mouse.down({ button: 'right' });
      await page.mouse.up({ button: 'right' });
      await page.waitForTimeout(100);
      expect(await editor.selected(), where).toEqual([]);
      expect(await editor.selection(), where).toMatchObject({
        blockId: 'p1',
        range: { start: 0, end: 5 },
      });
    }
  });

  // e2e only: focus moved by a page's own menu, and the engines' own
  // contextmenu defaults, are not in happy-dom.
  test('P12b a page with its own context menu keeps the focus it gave that menu', async ({
    editor,
    page,
    browserName,
  }) => {
    // Was R4-PTR-1: the range a right-click beside the text held was put
    // back again ~15ms later whatever had happened since, which pulled focus
    // back out of the page's own menu and into the editor -- the reader's
    // typing in the menu's search field replaced their range ("Aqqha one").
    for (const cancel of [true, false]) {
      for (const where of ['side padding', 'gutter background', 'handle'] as const) {
        const label = `${where}${cancel ? '' : ', not cancelled'}`;
        await editor.load({ doc: 'paragraphs', toolbar: 0 });
        await page.evaluate((cancel) => {
          document.addEventListener('contextmenu', (event) => {
            if (cancel) {
              event.preventDefault();
            }
            document.querySelector<HTMLInputElement>('#after')!.focus();
          });
        }, cancel);
        await editor.clickAt('p1', 1);
        await page.keyboard.press('Shift+ArrowRight');
        await page.keyboard.press('Shift+ArrowRight');

        const root = (await editor.root.boundingBox())!;
        const block = (await editor.block('p2').boundingBox())!;
        let point = { x: root.x + 3, y: block.y + block.height / 2 };

        if (where === 'gutter background') {
          point = { x: block.x + 18, y: block.y + 2 };
          await page.mouse.move(block.x + 100, block.y + 10);
          await page.mouse.move(point.x, point.y, { steps: 3 });
        } else if (where === 'handle') {
          await editor.hoverBlock('p2');
          const handle = (await editor.handle.boundingBox())!;
          point = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
        }

        await page.mouse.click(point.x, point.y, { button: 'right' });
        await page.waitForTimeout(60);
        await expect(page.locator('#after'), label).toBeFocused();
        await page.keyboard.type('qq');

        // Not cancelled, headless Chromium's own menu is open and takes the
        // keys (the round 2 build measured the same); the others type.
        if (cancel || browserName !== 'chromium') {
          expect(await page.locator('#after').inputValue(), label).toBe('qq');
        }
        expect((await editor.texts())[0], label).toBe('Alpha one');
      }
    }
  });

  // e2e only: the gutter's box and the gap beside its handle are layout.
  test('P13 a click in the gutter beside the handle puts the caret in the block', async ({
    editor,
    page,
  }) => {
    // Was R2-NAV-11: the gutter's own background between the handle and the
    // text was exempt with its controls, so the press focused the root and
    // the next character was lost.
    await editor.load({ doc: 'paragraphs' });
    await editor.hoverBlock('p2');
    const handle = (await editor.gutter.locator('.neditor-gutter__handle').boundingBox())!;
    const text = (await editor.content('p2').boundingBox())!;
    const x = (handle.x + handle.width + text.x) / 2;
    const y = handle.y + handle.height / 2;
    expect(text.x - (handle.x + handle.width), 'a gap beside the handle').toBeGreaterThan(1);
    expect(
      await page.evaluate(
        ([x, y]) => document.elementFromPoint(x!, y!)?.classList.contains('neditor-gutter'),
        [x, y],
      ),
    ).toBe(true);

    await page.mouse.click(x, y);
    expect(await editor.selected()).toEqual([]);
    expect(await editor.selection()).toMatchObject({ blockId: 'p2', range: { start: 0, end: 0 } });
    await editor.type('Q');
    expect((await editor.texts())[1]).toBe('QBravo two');
  });

  // e2e only: scrollbars, and whether an engine draws classic ones at all,
  // are not in happy-dom. Headless Chromium hides its scrollbars and Firefox
  // overlays them, so each case runs where a scrollbar takes up room.
  test('P14 a press on a scrollbar scrolls and leaves the caret where it was', async ({
    editor: shared,
    page: sharedPage,
    browserName,
    playwright,
    baseURL,
  }) => {
    // Was R2-UI-3: the root's mousedown took the press for one beside a block
    // and moved the caret into a table cell, or into the block level with it.
    // Headless Chromium is launched with its scrollbars hidden; a browser of
    // its own without that switch draws classic ones.
    const own =
      browserName === 'chromium'
        ? await playwright.chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] })
        : null;

    try {
      const page = own
        ? await (await own.newContext({ baseURL, viewport: sharedPage.viewportSize() })).newPage()
        : sharedPage;
      const editor = own ? new EditorPage(page) : shared;
      const bar = (element: Element) => {
        const box = element as HTMLElement;
        const style = getComputedStyle(box);
        return {
          x:
            box.offsetWidth -
            box.clientWidth -
            parseFloat(style.borderLeftWidth) -
            parseFloat(style.borderRightWidth),
          y:
            box.offsetHeight -
            box.clientHeight -
            parseFloat(style.borderTopWidth) -
            parseFloat(style.borderBottomWidth),
        };
      };

      // A fixed-height root that scrolls itself: its thumb, then its track.
      await editor.load({ doc: 'long', toolbar: 0 });
      await page.addStyleTag({
        content:
          '#editor{height:300px;overflow-y:auto}#editor::-webkit-scrollbar{width:14px;background:#ddd}#editor::-webkit-scrollbar-thumb{background:#888}',
      });
      const vertical = (await editor.root.evaluate(bar)).x;

      if (vertical > 0) {
        await editor.clickAt('p1', 5);
        await editor.type('X');
        const box = (await editor.root.boundingBox())!;
        const x = box.x + box.width - 1 - vertical / 2;
        await page.mouse.move(x, box.y + 20);
        await page.mouse.down();
        await page.mouse.move(x, box.y + 150, { steps: 10 });
        await page.mouse.up();
        await page.mouse.click(x, box.y + box.height - 20);
        await page.waitForTimeout(300);

        expect(await editor.root.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        expect(await editor.selection()).toMatchObject({
          blockId: 'p1',
          range: { start: 6, end: 6 },
        });
        await editor.type('Y');
        expect((await editor.texts())[1]).toBe('ParagXYraph number 1');
      }

      // The same root in RTL, where the bar is on the left, and drawn scaled.
      // Was R3-PTR-5: WebKit draws the RTL bar on the left but reports only
      // the border as `clientLeft`, and a scale mixed drawn and layout sizes
      // -- at 0.6 a drag on the thumb moved the caret, at 1.5 a click on the
      // padding beside the text was taken for the scrollbar.
      for (const [dir, scale] of [
        ['rtl', 1],
        [undefined, 0.6],
        [undefined, 1.5],
      ] as const) {
        await page.setViewportSize({ width: 1600, height: 1000 });
        await editor.load({ doc: 'long', toolbar: 0, dir });
        await page.addStyleTag({
          content: `#editor{height:300px;overflow-y:auto}#editor::-webkit-scrollbar{width:14px;background:#ddd}#editor::-webkit-scrollbar-thumb{background:#888}#stage{transform:scale(${scale});transform-origin:0 0}`,
        });
        const width = (await editor.root.evaluate(bar)).x;

        if (width <= 0) {
          continue;
        }

        const label = `${dir ?? 'ltr'} at ${scale}`;
        await editor.clickAt('p1', 5);
        const box = (await editor.root.boundingBox())!;
        const drawn = (width + 1) * scale;
        const x = dir === 'rtl' ? box.x + drawn / 2 + 0.5 : box.x + box.width - drawn / 2 - 0.5;
        await page.mouse.move(x, box.y + 20 * scale);
        await page.mouse.down();
        await page.mouse.move(x, box.y + 150 * scale, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(150);
        expect(await editor.root.evaluate((element) => element.scrollTop), label).toBeGreaterThan(
          0,
        );
        expect(await editor.selection(), label).toMatchObject({
          blockId: 'p1',
          range: { start: 5, end: 5 },
        });

        // Inside the client area, beside the text: a press for the text.
        await editor.root.evaluate((element) => {
          element.scrollTop = 0;
        });
        await editor.settle();
        const near =
          dir === 'rtl'
            ? box.x + box.width - 0.95 * (box.width - drawn)
            : box.x + 0.95 * (box.width - drawn);
        await editor.clickAt('p3', 2);
        await page.mouse.click(near, box.y + 3 * scale);
        expect((await editor.selection())?.blockId, label).toBe('p0');
      }

      // Under `zoom` rather than a transform. Was R4-PTR-5: WebKit reports
      // `clientLeft` 2 for the root's 1px border at zoom 0.6, which read an
      // LTR box as having its bar on the left: a press on the real one, at
      // the right, moved the caret.
      for (const zoom of [0.6, 0.8, 1.25]) {
        await editor.load({ doc: 'long', toolbar: 0, dragHandles: 0 });
        await page.addStyleTag({
          content: `#editor{height:300px;overflow-y:auto}#editor::-webkit-scrollbar{width:14px;background:#ddd}#editor::-webkit-scrollbar-thumb{background:#888}#stage{zoom:${zoom}}`,
        });

        // A pixel or two is the rounding of a zoomed box (Firefox overlays its
        // bar); the bar here is 14px drawn at the zoom.
        if ((await editor.root.evaluate(bar)).x <= 2) {
          continue;
        }

        const label = `zoom ${zoom}`;
        await editor.clickAt('p1', 1);
        const before = await editor.selection();
        const box = (await editor.root.boundingBox())!;
        await page.mouse.click(box.x + box.width - 3, box.y + 40);
        expect(await editor.selection(), label).toEqual(before);
        // WebKit animates the scroll a press on the track starts, and p3
        // measured while it ran was somewhere else by the click (1 run in
        // 15 landed in p4 or p5). Let it come to rest, and start from the
        // top as the scale loop above does.
        let last = -1;
        await expect
          .poll(
            async () => {
              const now = await editor.root.evaluate((element) => element.scrollTop);
              const still = now === last;
              last = now;
              return still;
            },
            { intervals: [100] },
          )
          .toBe(true);
        await editor.root.evaluate((element) => {
          element.scrollTop = 0;
        });
        await editor.settle();

        // And the padding at the left, where an LTR box has no bar, is the text's.
        const p3 = (await editor.block('p3').boundingBox())!;
        await page.mouse.click(box.x + 4, p3.y + p3.height / 2);
        expect((await editor.selection())?.blockId, label).toBe('p3');
      }

      await page.setViewportSize(sharedPage.viewportSize()!);

      // A table wider than the editor: its horizontal thumb, then its track.
      await editor.load({ doc: 'table', toolbar: 0 });
      const t = (text: string) => [{ text }];
      const row = (prefix: string) => Array.from({ length: 14 }, (_, i) => t(`${prefix}${i}`));
      await editor.setDocument({
        blocks: [
          { id: 'before', type: 'paragraph', content: t('Before the table'), depth: 0 },
          { id: 'tbl', type: 'table', content: [], depth: 0, rows: [row('H'), row('a')] },
          { id: 'after', type: 'paragraph', content: t('After the table'), depth: 0 },
        ],
      });
      await page.addStyleTag({
        content:
          '.neditor-table::-webkit-scrollbar{height:14px;background:#ddd}.neditor-table::-webkit-scrollbar-thumb{background:#888}',
      });
      const wrapper = editor.block('tbl').locator('.neditor-table');
      const horizontal = (await wrapper.evaluate(bar)).y;

      if (horizontal > 0) {
        await editor.clickAt('after', 4);
        const box = (await wrapper.boundingBox())!;
        const y = box.y + box.height - horizontal / 2;
        await page.mouse.move(box.x + 30, y);
        await page.mouse.down();
        await page.mouse.move(box.x + 200, y, { steps: 10 });
        await page.mouse.up();
        expect(await wrapper.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
        await page.mouse.click(box.x + box.width - 30, y);
        await page.waitForTimeout(300);
        expect(await editor.selection()).toMatchObject({
          blockId: 'after',
          range: { start: 4, end: 4 },
        });
      }

      test.skip(vertical <= 0 && horizontal <= 0, 'no classic scrollbars in this engine');
    } finally {
      await own?.close();
    }
  });

  // e2e only: scrolling and the frames that drive it are not in happy-dom.
  test('P15 a text drag back over its own block keeps scrolling at the top edge', async ({
    editor,
    page,
  }) => {
    // Was R2-UI-4: returning to the anchor block stopped the autoscroll, so
    // held at the top edge the page stuck with the blocks above off-screen.
    await editor.load({ doc: 'long', toolbar: 0 });
    const start = await editor.pointAt(editor.content('p2'), 3);
    const height = page.viewportSize()!.height;
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, height - 3, { steps: 10 });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(400);

    await page.mouse.move(start.x, 3, { steps: 10 });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    expect(await editor.selected()).toEqual(['p0', 'p1', 'p2']);
    await page.mouse.up();
  });

  // e2e only: which element scrolls is layout.
  test('P16b a drag held at the bottom of a pane in a component’s shadow tree scrolls the pane', async ({
    editor,
    page,
  }) => {
    // Was R10-PTR-1: the climb for what scrolls the editor went from the
    // stage to the component's host by `parentElement` and never met the
    // shadow pane the stage is slotted into (Ionic's `<ion-content>`), so a
    // drag held at the pane's bottom edge scrolled nothing. The probe: a
    // 400px pane in `<x-pane>`'s shadow tree, 40 paragraphs slotted in, a
    // press in the second dragged to 4px above the pane's bottom and held.
    await editor.load({ doc: 'paragraphs', toolbar: 0 });
    await page.evaluate(async () => {
      const stage = document.querySelector<HTMLElement>('#stage')!;
      stage.style.margin = '0';
      customElements.define(
        'x-pane',
        class extends HTMLElement {
          constructor() {
            super();
            this.attachShadow({ mode: 'open' }).innerHTML =
              '<div id="scroll" style="height:400px;overflow:auto"><slot></slot></div>';
          }
        },
      );
      const pane = document.createElement('x-pane');
      document.body.insertBefore(pane, document.body.firstChild);
      pane.append(stage);
      await window.__e2e.remount({ toolbar: false }, 'paragraphs');
      const ed = window.__e2e.editor;
      ed.setDocument({
        blocks: Array.from({ length: 40 }, (_, i) => ({
          id: `p${i}`,
          type: 'paragraph' as const,
          depth: 0,
          content: [{ text: `Paragraph number ${i} with text` }],
        })),
      });
    });
    await editor.settle();
    const paneScroll = () =>
      page.evaluate(
        () => document.querySelector('x-pane')!.shadowRoot!.querySelector('#scroll')!.scrollTop,
      );
    const bottom = await page.evaluate(
      () =>
        document
          .querySelector('x-pane')!
          .shadowRoot!.querySelector('#scroll')!
          .getBoundingClientRect().bottom,
    );
    const start = await editor.pointAt(editor.content('p1'), 2);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, bottom - 30, { steps: 8 });
    await page.mouse.move(start.x, bottom - 4, { steps: 4 });
    await expect.poll(paneScroll).toBeGreaterThan(200);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect((await editor.selected()).length).toBeGreaterThan(12);
    await page.mouse.up();
  });

  // e2e only: which element scrolls is layout.
  test('P16 a drag held at the edge scrolls a scrolling body, and the page around a pane taller than it', async ({
    editor,
    page,
  }) => {
    // Was R2-UI-5: the walk for a scroller stopped short of <body>, and took
    // only the nearest one -- an app shell's body never scrolled, and a pane
    // taller than the window scrolled to its end with its bottom off-screen.
    await editor.load({ doc: 'long', toolbar: 0 });
    await page.addStyleTag({
      content:
        'html{overflow:hidden;height:100%}body{overflow-y:auto;height:100%;box-sizing:border-box}',
    });
    await editor.settle();
    const height = page.viewportSize()!.height;
    let start = await editor.pointAt(editor.content('p2'), 3);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, height - 3, { steps: 10 });
    await expect.poll(() => page.evaluate(() => document.body.scrollTop)).toBeGreaterThan(400);
    expect((await editor.selected()).length).toBeGreaterThan(20);
    await page.mouse.up();

    await editor.load({ doc: 'long', toolbar: 0 });
    await page.evaluate(() => {
      document.body.classList.add('scrolling');
      const stage = document.querySelector<HTMLElement>('#stage')!;
      stage.style.height = '1000px';
      stage.style.overflowY = 'auto';
      window.scrollTo(0, stage.getBoundingClientRect().top + window.scrollY - 50);
    });
    await editor.settle();
    const before = await page.evaluate(() => window.scrollY);
    start = await editor.pointAt(editor.content('p2'), 3);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, height - 3, { steps: 10 });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before + 100);
    // The page went first: the pane's bottom was below the window, and
    // scrolling the pane only moved text nobody could see.
    expect(
      await page.evaluate(() => {
        const stage = document.querySelector<HTMLElement>('#stage')!;
        return stage.scrollHeight - stage.clientHeight - stage.scrollTop;
      }),
      'the pane still has room to scroll',
    ).toBeGreaterThan(1);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before + 200);
    await page.mouse.up();
  });

  // e2e only: the drag is real pointer input, and its end is what is checked.
  test('P17 an undo or a new document mid text drag ends the drag', async ({ editor, page }) => {
    // Was R2-UI-9: only handle drags ended with the document; a text drag
    // kept data-selecting and re-selected against the new order on the next
    // move.
    await editor.load({ doc: 'five', toolbar: 0 });
    await editor.clickAt('e', 2);
    await page.keyboard.press(`${MOD}+Shift+ArrowUp`);
    await page.keyboard.press(`${MOD}+Shift+ArrowUp`);
    expect(await editor.ids()).toEqual(['a', 'b', 'e', 'c', 'd']);

    const a = await editor.pointAt(editor.content('a'), 2);
    const b = await editor.pointAt(editor.content('b'), 2);
    const d = await editor.pointAt(editor.content('d'), 2);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    expect(await editor.selected()).toEqual(['a', 'b']);
    await expect(editor.root).toHaveAttribute('data-selecting', 'true');

    await page.keyboard.press(`${MOD}+z`);
    await expect(editor.root).not.toHaveAttribute('data-selecting', 'true');
    await page.mouse.move(d.x, d.y, { steps: 6 });
    expect(await editor.selected()).toEqual([]);
    await page.mouse.up();
    expect(await editor.selected()).toEqual([]);

    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    expect(await editor.selected()).toEqual(['a', 'b']);
    await page.evaluate(() => {
      const t = (text: string) => [{ text }];
      window.__e2e.editor.setDocument({
        blocks: ['x', 'y', 'z'].map((id) => ({
          id,
          type: 'paragraph' as const,
          content: t(`Block ${id}`),
          depth: 0,
        })),
      });
    });
    await expect(editor.root).not.toHaveAttribute('data-selecting', 'true');
    await page.mouse.move(d.x, d.y, { steps: 6 });
    expect(await editor.selected()).toEqual([]);
    await page.mouse.up();
  });

  /*
   * b8's case made deterministic: a mouse drag across "Bravo two" with a peer
   * appending to that very block while the button is down. The render
   * rebuilds the block's text, and the editor writes the reader's selection
   * back into it (`#carryTextSelection`). Written while the drag had begun
   * but the pointer had not yet left the first character -- the selection
   * still a caret -- Chromium's own drag selection ended there: every later
   * move put a caret under the pointer, and the release selected nothing
   * (6-8 in 30 with a peer typing every 200 ms). Written once the drag held a
   * range, it went on. So a press whose host the carry wrote into is drawn by
   * the editor from then on, from the carried anchor, as a drag back in its
   * own block is: the same range as with no peer, in every engine. And it is
   * the editor's drag again, so carried on into the next block it selects
   * both blocks, as with no peer -- ended by the update, it stayed a range in
   * its own block in Firefox and WebKit. Real pointer input and Chromium's
   * drag selection: e2e.
   */
  test('P17b a text drag goes on selecting across a peer’s update to its own block', async ({
    editor,
    page,
  }) => {
    for (const when of ['none', 'still a caret', 'a range', 'on into p3'] as const) {
      await editor.load({ doc: 'paragraphs', toolbar: 0 });
      const start = await editor.pointAt(editor.content('p2'), 0);
      const end = await editor.pointAt(editor.content(when === 'on into p3' ? 'p3' : 'p2'), 8);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      const step = (end.x - start.x) / 12;
      for (let i = 1; i <= 12; i += 1) {
        // Two pixels in, the drag has begun on the first character; four
        // steps in, it holds a range.
        const y = start.y + ((end.y - start.y) * i) / 12;
        await page.mouse.move(start.x + (i === 1 ? 2 : i * step), i === 1 ? start.y : y);
        if ((when !== 'a range' && when !== 'none' && i === 1) || (when === 'a range' && i === 4)) {
          await page.evaluate(() => {
            const ed = window.__e2e.editor;
            const doc = ed.getDocument();
            doc.blocks[1]!.content = [...doc.blocks[1]!.content, { text: '!' }];
            ed.setDocument(doc);
          });
        }
      }
      await page.mouse.up();
      await editor.settle();
      if (when === 'on into p3') {
        expect(await editor.selected(), when).toEqual(['p2', 'p3']);
        continue;
      }
      expect((await editor.selection())?.range, when).toEqual({ start: 0, end: 8 });
      expect(await editor.selected(), when).toEqual([]);
    }
  });

  /*
   * R14-PTR-2, p10's literal case: a press at 50 of "The quick brown fox
   * jumps over the lazy dog near the river bank", dragged back to 30, a
   * peer appending " and more" to the block, and the drag on to 10. The
   * editor draws the resumed drag from its anchor; WebKit in a shadow root
   * reports a mouse's selection with no direction, every range forward, and
   * taken as the range's reported anchor the anchor was 30, and the release
   * selected [10,30] -- in WebKit's shadow mount only. There, and only
   * there, the anchor is the end of the range nearer the press
   * (`#anchorEndOf`), read before the render. A forward drag, the control.
   * Shadow roots and real drags: e2e.
   */
  test('P17b2 a backward drag a peer’s update redraws goes on from its press in a shadow root', async ({
    editor,
    page,
  }) => {
    const text = 'The quick brown fox jumps over the lazy dog near the river bank';
    const load = async (mount: 'plain' | 'shadow', content = text) => {
      await editor.load({ doc: 'paragraphs', toolbar: 0, mount });
      await page.evaluate((text) => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks[1]!.content = [{ text }];
        ed.setDocument(doc);
      }, content);
    };
    // A point `across` of the way over the character at `offset`: its
    // middle is the caret nearer it, so a range runs between whole
    // characters; a quarter across is the caret before it in every engine.
    const pointOn = (offset: number, across = 0.5) =>
      editor.content('p2').evaluate(
        (host, { offset, across }) => {
          const range = host.ownerDocument.createRange();
          range.setStart(host.firstChild!, offset);
          range.setEnd(host.firstChild!, offset + 1);
          const box = range.getBoundingClientRect();
          return { x: box.left + box.width * across, y: box.top + box.height / 2 };
        },
        { offset, across },
      );
    // Appends " and more", or deletes the word given.
    const peer = (deleted: string | null = null) =>
      page.evaluate((deleted) => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        const was = doc.blocks[1]!.content[0]!.text;
        doc.blocks[1]!.content = [
          { text: deleted === null ? `${was} and more` : was.replace(deleted, '') },
        ];
        ed.setDocument(doc);
      }, deleted);

    for (const mount of ['plain', 'shadow'] as const) {
      for (const [from, via, to] of [
        [50, 30, 10],
        [10, 30, 50],
      ] as const) {
        const label = `${mount}, ${from} to ${to}`;
        await load(mount);
        const [a, b, c] = [await pointOn(from), await pointOn(via), await pointOn(to)];
        await page.mouse.move(a.x, a.y);
        await page.mouse.down();
        // A pixel to the left first, as p10 does: headless Chromium's own
        // drag from a character's middle nudged right selects nothing, with
        // or without the editor (a bare contenteditable too).
        await page.mouse.move(a.x - 1, a.y);
        await page.mouse.move(b.x, b.y, { steps: 8 });
        await peer();
        await page.mouse.move(c.x, c.y, { steps: 8 });
        await page.mouse.up();
        await editor.settle();
        const range = (await editor.selection())?.range;
        // Each end within a character of the press and the release: where
        // a glyph's middle rounds is the engine's (Chromium and Firefox put
        // the press at 50, WebKit at 51).
        expect(range, label).toBeDefined();
        const [lo, hi] = [Math.min(from, to), Math.max(from, to)];
        expect(
          Math.abs(range!.start - lo),
          `${label}: ${JSON.stringify(range)}`,
        ).toBeLessThanOrEqual(1);
        expect(Math.abs(range!.end - hi), `${label}: ${JSON.stringify(range)}`).toBeLessThanOrEqual(
          1,
        );
      }

      // Only where the selection reports no direction. A press seven tenths
      // across the character at 30, one character dragged, the peer's
      // update, and on to 55: Chromium anchors that drag at 30, before the
      // character, while the caret read under the press is 31, after it --
      // so "the end nearer the press" asked of every engine (this fix's
      // first version) took 31 for the anchor and released [31,55] where
      // round 13, and the same drag with no peer, hold [30,55]. Compared
      // with that drag rather than with a number: where a press rounds is
      // the engine's.
      const released: Record<string, unknown> = {};
      for (const update of ['none', 'peer'] as const) {
        await load(mount);
        const [a, b, c] = [
          await pointOn(30, 0.7),
          await pointOn(31, 0.25),
          await pointOn(55, 0.25),
        ];
        await page.mouse.move(a.x, a.y);
        await page.mouse.down();
        await page.mouse.move(a.x - 1, a.y);
        await page.mouse.move(b.x, b.y, { steps: 6 });
        await editor.settle();
        if (update === 'peer') await peer();
        await page.mouse.move(c.x, c.y, { steps: 8 });
        await page.mouse.up();
        await editor.settle();
        released[update] = (await editor.selection())?.range;
      }
      expect(released.peer, `${mount}, one character forward`).toEqual(released.none);
      expect(released.peer, `${mount}, one character forward`).toMatchObject({ end: 55 });

      // And a multi-click drag whose unit the update took away: "brown"
      // double-clicked, dragged back to "quick", the peer deletes "brown ",
      // and the drag on to "he". With no word left to select by it goes on
      // by character from its anchor -- the end of the range, where the
      // double-clicked word was: [4,15] is carried to [4,9] and released
      // [1,9]. Taken as the range's reported anchor, WebKit in a shadow root
      // went on from 4 and released [1,4].
      await load(mount);
      const [word, back] = [await pointOn(12), await pointOn(6, 0.25)];
      await page.mouse.click(word.x, word.y);
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.move(back.x, back.y, { steps: 6 });
      await editor.settle();
      expect((await editor.selection())?.range, `${mount}, by word`).toEqual({ start: 4, end: 15 });
      await peer('brown ');
      const on = await pointOn(1, 0.25);
      await page.mouse.move(on.x, on.y, { steps: 8 });
      await page.mouse.up();
      await editor.settle();
      expect((await editor.selection())?.range, `${mount}, its word deleted`).toEqual({
        start: 1,
        end: 9,
      });

      // The other way, pressed near the end of a long word: "extraordinary"
      // of "An extraordinary ox walks" from its last "a", dragged on to "ox"
      // -- [3,19], the press nearer the range's end than its start -- the
      // peer deletes "extraordinary ", and the drag on by character to the
      // "k" of "walks". A multi-click's anchor is the side of its own word
      // the range kept, the start here, whichever end the press is nearer:
      // [3,5] carried, [3,9] released. By the nearer end it went on from 5.
      await load(mount, 'An extraordinary ox walks');
      const [late, ox] = [await pointOn(13), await pointOn(18, 0.25)];
      await page.mouse.click(late.x, late.y);
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.move(ox.x, ox.y, { steps: 6 });
      await editor.settle();
      expect((await editor.selection())?.range, `${mount}, by word, forward`).toEqual({
        start: 3,
        end: 19,
      });
      await peer('extraordinary ');
      const further = await pointOn(9, 0.25);
      await page.mouse.move(further.x, further.y, { steps: 8 });
      await page.mouse.up();
      await editor.settle();
      expect((await editor.selection())?.range, `${mount}, its word deleted, forward`).toEqual({
        start: 3,
        end: 9,
      });
    }
  });

  /*
   * R13-RV3-PTR-1, d2's case: a double-click on "quick" dragged to "dog",
   * and a triple-click held on "quick" with a pixel of jitter, with a peer
   * appending to the block while the button is down. Every engine selects
   * by word, or by paragraph, from such a press, and every engine's own
   * selection lost that when the carry wrote the reader's range back: in
   * Chromium and WebKit "quick ... lazy d" and "The qu", character by
   * character from then on, and in Firefox the same once the editor drew
   * the drag itself (`#resumeTextDrag`). The editor draws it by the press's
   * own unit, as with no peer: here a release just inside the "d" of "dog",
   * whose caret is the boundary before it -- read as the word before that
   * caret, the drag ended at "lazy ". Real multi-click input: e2e.
   */
  test('P17c a double- or triple-click drag keeps its word or paragraph across a peer’s update', async ({
    editor,
    page,
  }) => {
    const text = 'The quick brown fox jumps over the lazy dog and keeps going on';
    for (const clicks of [2, 3] as const) {
      for (const peer of ['none', 'append', 'prepend'] as const) {
        const label = `${clicks} clicks, peer: ${peer}`;
        await editor.load({ doc: 'paragraphs', toolbar: 0 });
        await page.evaluate((text) => {
          const ed = window.__e2e.editor;
          const doc = ed.getDocument();
          doc.blocks[1]!.content = [{ text }];
          ed.setDocument(doc);
        }, text);
        const from = await editor.pointAt(editor.content('p2'), 6);
        // The drag ends just inside the "d" of "dog": the caret nearest the
        // pointer is the boundary before it, the character under it the "d".
        const shift = peer === 'prepend' ? 1 : 0;
        let to = await editor.pointAt(editor.content('p2'), 40);
        await page.mouse.move(from.x, from.y);
        for (let n = 1; n < clicks; n += 1) {
          await page.mouse.down({ clickCount: n });
          await page.mouse.up({ clickCount: n });
        }
        await page.mouse.down({ clickCount: clicks });
        for (let i = 1; i <= 10; i += 1) {
          // A double-click drags to "dog"; a triple-click is held, jittering.
          const x = clicks === 2 ? from.x + ((to.x - from.x) * i) / 10 : from.x + (i % 2);
          await page.mouse.move(x, from.y + (clicks === 2 ? 0 : 1));
          if (peer !== 'none' && i === 2) {
            await page.evaluate((peer) => {
              const ed = window.__e2e.editor;
              const doc = ed.getDocument();
              const own = doc.blocks[1]!.content;
              doc.blocks[1]!.content =
                peer === 'append' ? [...own, { text: '!' }] : [{ text: '!' }, ...own];
              ed.setDocument(doc);
            }, peer);
            to = await editor.pointAt(editor.content('p2'), 40 + shift);
          }
        }
        await page.mouse.up({ clickCount: clicks });
        await editor.settle();
        // The paragraph the press selected is carried as the reader's range
        // is: the peer's "!" put exactly at its start stays out of it, as
        // text put at a range's start does. The pointer's own paragraph, the
        // far side, is whole, the "!" put at its end included.
        expect((await editor.selection())?.range, label).toEqual(
          clicks === 2
            ? { start: 4 + shift, end: 43 + shift }
            : { start: shift, end: text.length + (peer === 'none' ? 0 : 1) },
        );
      }
    }
  });

  /*
   * R14-PTR-3, p17's literal cases: the paragraph "alpha one\n\ngamma
   * three\ndelta four", a press on its last line -- in the gutter beside it
   * (a drag the editor places) or on its text with a peer's edit landing a
   * line up (a drag the editor resumes) -- dragged up onto the blank line
   * and released. The editor draws such a drag from the caret under the
   * pointer, and the format toolbar its own range drew sat over the line
   * above: hit there, the caret was missed, the range collapsed to its
   * anchor and the release selected nothing (Chromium 15 of 30 heights,
   * Firefox 10). A hit test that misses the host is asked again past the
   * editor's own portals. R14-PTR-4 with it: the code block
   * "\nalpha beta\ngamma delta", "gamma" triple-clicked, dragged out through
   * the paragraph above and back (or under a peer's edit) onto the blank
   * first line: the paragraph at offset 0 began at 1 (`farUnit`), and the
   * drag lost the blank line -- "alpha beta\ngamma delta" in every engine --
   * or, hit on the toolbar, kept only "gamma delta". The toolbar drawn and
   * real drags: e2e.
   */
  test('P17c2 a drag the editor draws onto a blank line reaches it past its own toolbar', async ({
    editor,
    page,
  }) => {
    const text = 'alpha one\n\ngamma three\ndelta four';
    // Onto the blank line in one move, at three heights of it, and in
    // eight moves to its middle (p17's own). In one move the pointer lands
    // under the toolbar drawn over the line above the range: with the range
    // a miss leaves as it was drawn (R14-FX-1) and nothing asked past the
    // toolbar, the placed drag stopped a line short in every engine,
    // [14,..] for [10,..]; collapsing on the miss, round 13 released
    // nothing. And with the page styling the toolbar ("styled"): a
    // stylesheet's `pointer-events: auto !important` on the portals, which
    // only an `!important` of the editor's own gets past for the hit test,
    // and an inline one on the toolbar, which it gets back afterwards,
    // value and priority.
    // And in a shadow root -- open, closed, and an open one inside a
    // closed one ("nested"): what is on top at the point is asked of the
    // page, which answers with the outermost shadow host, and the toolbar
    // is found by going into the roots it is known to be in, outermost
    // first -- a closed root gives no `shadowRoot` to follow, and followed
    // that way the toolbar in one was never found: the drag stopped a line
    // short again, [14,..] (R14-RV3-2).
    for (const [mode, mount] of [
      ['placed', undefined],
      ['peer', undefined],
      ['styled', undefined],
      ['placed', 'shadow'],
      ['placed', 'closed'],
      ['placed', 'nested'],
    ] as const) {
      for (const [down, steps] of [
        [0.1, 1],
        [0.4, 1],
        [0.7, 1],
        [0.5, 8],
      ] as const) {
        const label = `${mode}${mount ? `, in a ${mount} root` : ''}, ${down} down the blank line in ${steps}`;
        await editor.load({ doc: 'paragraphs', ...(mount ? { mount } : {}) });
        await page.evaluate((text) => {
          const ed = window.__e2e.editor;
          const doc = ed.getDocument();
          doc.blocks[1]!.content = [{ text }];
          ed.setDocument(doc);
        }, text);
        // Each line's middle: the first letter's; and the blank line, from
        // the bottom of the line above it to the top of the one below.
        // (Through the editor's own element: no locator sees into a closed
        // root.)
        const lines = await page.evaluate((down) => {
          const host = window.__e2e.editor.element.querySelector(
            '[data-block-id="p2"] .neditor-block__content',
          )!;
          const node = host.firstChild!;
          const box = (offset: number) => {
            const range = host.ownerDocument.createRange();
            range.setStart(node, offset);
            range.setEnd(node, offset + 1);
            return range.getBoundingClientRect();
          };
          const middle = (offset: number) => (box(offset).top + box(offset).bottom) / 2;
          return {
            left: host.getBoundingClientRect().left,
            blank: box(0).bottom + (box(11).top - box(0).bottom) * down,
            gamma: middle(11),
            delta: middle(23),
          };
        }, down);
        const inline = () =>
          editor.portal('toolbar').evaluate((toolbar) => {
            const style = (toolbar as HTMLElement).style;
            return `${style.getPropertyValue('pointer-events')} ${style.getPropertyPriority('pointer-events')}`;
          });
        if (mode === 'styled') {
          await page.addStyleTag({ content: '.neditor-portal{pointer-events:auto !important}' });
          await editor.portal('toolbar').evaluate((toolbar) => {
            (toolbar as HTMLElement).style.setProperty('pointer-events', 'auto', 'important');
          });
        }
        const x = lines.left + 40;
        const pressX = mode === 'peer' ? x : lines.left - 6;
        await page.mouse.move(pressX, lines.delta);
        await page.mouse.down();
        await page.mouse.move(pressX - 1, lines.delta);
        await page.mouse.move(x, lines.gamma, { steps: 6 });
        if (mode === 'peer') {
          await page.evaluate(() => {
            const ed = window.__e2e.editor;
            const doc = ed.getDocument();
            doc.blocks[1]!.content = [{ text: `${doc.blocks[1]!.content[0]!.text} peer` }];
            ed.setDocument(doc);
          });
        }
        await editor.settle();
        await page.mouse.move(x, lines.blank, { steps });
        await editor.settle();
        await page.mouse.up();
        await editor.settle();
        const range = (await editor.selection())?.range;
        expect(range?.start, label).toBe(10);
        // To the press: the start of the last line beside it, or a few
        // letters into it.
        expect(range?.end, label).toBeGreaterThanOrEqual(23);
        if (mode === 'styled') expect(await inline(), label).toBe('auto important');
      }
    }

    // Only a hit test that missed is asked again past the portals: the same
    // placed drag carried along its own line, the toolbar it draws above it
    // and never under the pointer, writes no `pointer-events` on any portal
    // -- a page watching them (a MutationObserver over its own body) hears
    // nothing of a drag that needed nothing. Toggled on every move, as this
    // fix first was, it heard two records a portal a move.
    await editor.load({ doc: 'paragraphs' });
    const along = await page.evaluate((text) => {
      const ed = window.__e2e.editor;
      const doc = ed.getDocument();
      doc.blocks[1]!.content = [{ text }];
      ed.setDocument(doc);
      const host = ed.element.querySelector('[data-block-id="p2"] .neditor-block__content')!;
      const range = document.createRange();
      range.setStart(host.firstChild!, 23);
      range.setEnd(host.firstChild!, 24);
      const box = range.getBoundingClientRect();
      const state = { toggles: 0 };
      (window as unknown as { __portalWrites: typeof state }).__portalWrites = state;
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          const element = record.target as HTMLElement;
          if (
            /pointer-events/.test(record.oldValue ?? '') ||
            element.style.getPropertyValue('pointer-events') !== ''
          ) {
            state.toggles += 1;
          }
        }
      });
      for (const portal of document.querySelectorAll('.neditor-portal')) {
        observer.observe(portal, {
          attributes: true,
          attributeFilter: ['style'],
          attributeOldValue: true,
        });
      }
      return { left: host.getBoundingClientRect().left, y: (box.top + box.bottom) / 2 };
    }, text);
    await page.mouse.move(along.left - 6, along.y);
    await page.mouse.down();
    await page.mouse.move(along.left - 7, along.y);
    await page.mouse.move(along.left + 60, along.y, { steps: 12 });
    await editor.settle();
    await expect(editor.portal('toolbar')).toBeVisible();
    await page.mouse.move(along.left + 70, along.y, { steps: 4 });
    await page.mouse.up();
    await editor.settle();
    expect((await editor.selection())?.range).toMatchObject({ start: 23 });
    expect((await editor.selection())?.range.end).toBeGreaterThan(26);
    expect(
      await page.evaluate(
        () => (window as unknown as { __portalWrites: { toggles: number } }).__portalWrites.toggles,
      ),
    ).toBe(0);

    const code = '\nalpha beta\ngamma delta';
    for (const route of ['detour', 'peer'] as const) {
      await editor.load({ doc: 'code' });
      await page.evaluate((code) => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks[1]!.content = [{ text: code }];
        ed.setDocument(doc);
      }, code);
      const at = await editor.content('code').evaluate((host) => {
        const node = host.firstChild!;
        const box = (offset: number) => {
          const range = host.ownerDocument.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + 1);
          return range.getBoundingClientRect();
        };
        const press = box(14);
        const first = box(1);
        return {
          x: press.left + press.width / 2,
          y: press.top + press.height / 2,
          blankX: first.left + 2,
          blankY: first.top - first.height / 2,
        };
      });
      const above = await editor.content('p1').boundingBox();
      for (let click = 1; click < 3; click += 1) {
        await page.mouse.click(at.x, at.y, { clickCount: click });
      }
      await page.mouse.down({ clickCount: 3 });
      await page.mouse.move(at.x - 1, at.y);
      if (route === 'detour') {
        await page.mouse.move(at.blankX, above!.y + above!.height / 2, { steps: 10 });
      } else {
        await page.mouse.move(at.x - 3, at.y - 6, { steps: 3 });
        await page.evaluate(() => {
          const ed = window.__e2e.editor;
          const doc = ed.getDocument();
          doc.blocks[1]!.content = [{ text: `${doc.blocks[1]!.content[0]!.text} more` }];
          ed.setDocument(doc);
        });
      }
      await page.mouse.move(at.blankX, at.blankY, { steps: 10 });
      await page.mouse.up();
      await editor.settle();
      expect(await editor.selection(), route).toMatchObject({
        blockId: 'code',
        range: { start: 0, end: code.length },
      });
    }
  });

  /*
   * R13-RV4-PTR-1/-3/-4, PE-a, PE-b: a multi-click drag the editor draws
   * ends where the same drag ends with no peer. Its anchor is the word or
   * paragraph the browser itself selected for the press, read before the
   * first move and carried (`#noteDragUnit`) -- never re-derived: a
   * segmenter's word, or the end of the carried range, cut "dog" from a
   * backward drag, and dropped the line break Chromium and WebKit take with
   * a paragraph. Its far end is the word or paragraph at the caret nearest
   * the pointer, Chromium's and WebKit's rule: stopped at the character
   * under the pointer, a release on the right half of a word's last letter
   * left out the space they take. Firefox runs on from there to the next
   * word's end, a documented limit pinned here. And a drag that crossed
   * into the next block and came back, with no peer at all, is drawn by the
   * same unit: it went on by character from the press. Real multi-click
   * input: e2e.
   */
  test('P17e a multi-click drag ends where it does with no peer', async ({
    browserName,
    editor,
    page,
  }) => {
    const text = 'The quick brown fox jumps over the lazy dog and keeps going on';
    const lines = 'first line here\nsecond line x\nthird line goes on\nlast';
    const drag = async (
      body: string,
      clicks: 2 | 3,
      from: number,
      to: { offset: number; side: 'left' | 'right' },
      how: 'none' | 'peer' | 'via p3',
    ): Promise<unknown> => {
      await editor.load({ doc: 'paragraphs', toolbar: 0 });
      await page.evaluate((body) => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks[1]!.content = [{ text: body }];
        ed.setDocument(doc);
      }, body);
      const box = (offset: number) =>
        editor.content('p2').evaluate((host, offset) => {
          const range = host.ownerDocument.createRange();
          range.setStart(host.firstChild!, offset);
          range.setEnd(host.firstChild!, offset + 1);
          const rect = range.getBoundingClientRect();
          return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
        }, offset);
      const start = await box(from);
      const end = await box(to.offset);
      const endX = to.side === 'left' ? end.left + 1 : end.right - 1;
      const p3 = await editor.pointAt(editor.content('p3'), 3);
      await page.mouse.move(start.left + 1, start.y);
      for (let n = 1; n < clicks; n += 1) {
        await page.mouse.down({ clickCount: n });
        await page.mouse.up({ clickCount: n });
      }
      await page.mouse.down({ clickCount: clicks });
      for (let i = 1; i <= 8; i += 1) {
        if (how === 'via p3' && i === 4) {
          await page.mouse.move(p3.x, p3.y, { steps: 3 });
        }
        await page.mouse.move(
          start.left + 1 + ((endX - start.left - 1) * i) / 8,
          start.y + ((end.y - start.y) * i) / 8,
        );
        if (how === 'peer' && i === 2) {
          await page.evaluate(() => {
            const ed = window.__e2e.editor;
            const doc = ed.getDocument();
            doc.blocks[1]!.content = [...doc.blocks[1]!.content, { text: '!' }];
            ed.setDocument(doc);
          });
        }
      }
      await page.mouse.up({ clickCount: clicks });
      await editor.settle();
      return (await editor.selection())?.range;
    };

    const cases = [
      ['backward, from "dog" to "fox"', text, 2, 41, { offset: 17, side: 'left' }],
      ['backward, onto the space after "fox"', text, 2, 41, { offset: 19, side: 'left' }],
      [
        'released on the right half of "over"’s last letter',
        text,
        2,
        6,
        { offset: 29, side: 'right' },
      ],
      ['a triple-click on a line, down a line', lines, 3, 18, { offset: 35, side: 'left' }],
    ] as const;

    for (const [label, body, clicks, from, to] of cases) {
      const native = await drag(body, clicks, from, to, 'none');
      // Firefox's own drag runs on over a run of spaces at the caret to the
      // next word; the editor's takes the spaces as the word, as Chromium's
      // and WebKit's do: the documented limit.
      const firefox = browserName === 'firefox';
      const limit = label.startsWith('released')
        ? { start: 4, end: 31 }
        : label.includes('space')
          ? { start: 19, end: 43 }
          : null;
      expect(await drag(body, clicks, from, to, 'peer'), label).toEqual(
        firefox && limit ? limit : native,
      );
      // A drag the editor does not draw is the browser's alone: redrawn at
      // the release by the editor's rule, Firefox's own went [4,34] to [4,31].
      if (firefox && limit) {
        expect(native, `${label}, no peer`).toEqual(
          label.startsWith('released') ? { start: 4, end: 34 } : { start: 16, end: 43 },
        );
      }
    }

    const direct = await drag(text, 2, 6, { offset: 41, side: 'left' }, 'none');
    expect(direct).toEqual({ start: 4, end: 43 });
    expect(await drag(text, 2, 6, { offset: 41, side: 'left' }, 'via p3'), 'via p3').toEqual(
      direct,
    );

    // Without `Intl.Segmenter` the far end goes by character, and the
    // anchor, the browser's own, stays whole: "dog" was cut to "do".
    await page.addInitScript(() => {
      delete (Intl as { Segmenter?: unknown }).Segmenter;
    });
    expect(
      await drag(text, 2, 41, { offset: 17, side: 'left' }, 'peer'),
      'no Intl.Segmenter',
    ).toEqual({ start: 17, end: 43 });
  });

  /*
   * R13-RV5-PTR-1 and the far end over a grown anchor. A press with a gesture
   * of its own before it, a peer's edit while the button is down, and the
   * release compared with the same gesture with no peer:
   * - Shift+double-click at "over" after a click at offset 2, dragged back
   *   to "brown": Chromium and WebKit extend the reader's range from its
   *   anchor and go on by character ([2,11]); Firefox anchors afresh on the
   *   word pressed ([10,30]). Taken as the unit, the whole extended range
   *   [2,27] never shrank.
   * - From a caret at 0: Shift+triple-click on "over", dragged back to
   *   "brown", re-anchors on the paragraph in every engine ([0,43]); and
   *   Shift+double-click on "The", dragged on to "brown", which Firefox
   *   re-anchors on the word ([0,15]) and Chromium and WebKit extend by
   *   character ([0,11]). Each new unit starts where the reader's range did,
   *   so asked by that end alone it passed for an extension and went by
   *   character: [0,11] for both (R13-RV6-PTR-1). The whole range the press
   *   left is asked, from either end ("triple from the end": asked by the
   *   end alone, [0,11]), and its direction: from a caret at 9,
   *   Shift+double-click on "quick" in Firefox re-anchors forward on the
   *   very [4,9] the reader's backward range covered, and asked by the ends
   *   alone it went by character to "la", [4,37] for [4,39]
   *   (R13-RV7-PTR-1).
   * - "X Y" put inside the double-clicked "jumps", the release back inside
   *   it: the anchor grew to "juX Ymps" and stays whole; drawn to the
   *   pointer's own word alone, it was "juX".
   * Real input: e2e.
   */
  test('P17f a multi-click drag after Shift, or over an anchor a peer grew', async ({
    editor,
    page,
  }) => {
    const text = 'The quick brown fox jumps over the lazy dog';
    const gestures = {
      shift: { caret: [2, 0.5], press: [27, 0.5], clicks: 2, to: 11 },
      'triple from 0': { caret: [0, 0.05], press: [27, 0.5], clicks: 3, to: 11 },
      'triple from the end': { caret: [42, 0.95], press: [27, 0.5], clicks: 3, to: 11 },
      'double from 0': { caret: [0, 0.05], press: [1, 0.5], clicks: 2, to: 11 },
      'double over a backward range': { caret: [9, 0.05], press: [4, 0.25], clicks: 2, to: 37 },
      grown: { caret: null, press: [21, 0.5], clicks: 2, to: 30 },
    } as const;
    const run = async (
      kind: keyof typeof gestures,
      peer: boolean,
    ): Promise<{ start: number; end: number } | undefined> => {
      const gesture = gestures[kind];
      await editor.load({ doc: 'paragraphs', toolbar: 0 });
      await page.evaluate((text) => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks[1]!.content = [{ text }];
        ed.setDocument(doc);
      }, text);
      const at = (offset: number, part: number) =>
        editor.content('p2').evaluate(
          (host, [offset, part]) => {
            const range = host.ownerDocument.createRange();
            range.setStart(host.firstChild!, offset);
            range.setEnd(host.firstChild!, offset + 1);
            const box = range.getBoundingClientRect();
            return { x: box.left + box.width * part, y: box.top + box.height / 2 };
          },
          [offset, part] as const,
        );
      const press = await at(gesture.press[0], gesture.press[1]);
      let to = await at(gesture.to, 0.25);
      if (gesture.caret) {
        const first = await at(gesture.caret[0], gesture.caret[1]);
        await page.mouse.click(first.x, first.y);
        await page.keyboard.down('Shift');
      }
      await page.mouse.move(press.x, press.y);
      for (let n = 1; n < gesture.clicks; n += 1) {
        await page.mouse.down({ clickCount: n });
        await page.mouse.up({ clickCount: n });
      }
      await page.mouse.down({ clickCount: gesture.clicks });
      if (gesture.caret) await page.keyboard.up('Shift');
      for (let i = 1; i <= 8; i += 1) {
        await page.mouse.move(press.x + ((to.x - press.x) * i) / 8, press.y);
        if (peer && i === 2) {
          await page.evaluate((kind) => {
            const ed = window.__e2e.editor;
            const doc = ed.getDocument();
            const own = doc.blocks[1]!.content.map((run) => run.text).join('');
            doc.blocks[1]!.content = [
              { text: kind === 'grown' ? `${own.slice(0, 22)}X Y${own.slice(22)}` : `${own} zz` },
            ];
            ed.setDocument(doc);
          }, kind);
          // Back inside the grown word: on its "u".
          if (kind === 'grown') to = await at(21, 0.25);
        }
      }
      await page.mouse.up({ clickCount: gesture.clicks });
      await editor.settle();
      return (await editor.selection())?.range;
    };

    expect(await run('shift', true), 'Shift').toEqual(await run('shift', false));
    // The paragraph the pointer is in is whole: the peer's " zz" with it.
    expect(await run('triple from 0', false)).toEqual({ start: 0, end: text.length });
    expect(await run('triple from 0', true), 'triple').toEqual({ start: 0, end: text.length + 3 });
    expect(await run('double from 0', true), 'double').toEqual(await run('double from 0', false));
    // From the end: the reader's range ends where the paragraph does.
    expect(await run('triple from the end', true), 'triple from the end').toEqual({
      start: 0,
      end: text.length + 3,
    });
    // Firefox re-anchors forward on "quick" over the reader's backward
    // [4,9]; the same ends, another direction.
    expect(await run('double over a backward range', true), 'backward').toEqual(
      await run('double over a backward range', false),
    );
    expect(await run('grown', true), 'grown').toEqual({ start: 20, end: 28 });
  });

  /*
   * R13-RV7-PTR-2 and R13-RV8-PTR-1, no peer at all: a Shift press dragged
   * on to "la", from a caret at 9 -- a Shift+click, or a Shift+double-click,
   * which Chromium and WebKit treat as an extension too -- and from a range
   * the reader made by dragging: [4,9] Shift+clicked at 2, the backward
   * [9,4] Shift+clicked at 20, [4,20] Shift+clicked inside it at 11.
   * Carried down into the next block and back, the drag is the editor's to
   * draw again (`returned`); it drew from the press point, then from the
   * reader's anchor, where the browser's own drag is anchored where the
   * browser put the anchor at the press: Firefox keeps the reader's,
   * Chromium and Safari on macOS take the end farther from the click
   * ([9,37], [4,37] and [20,37]; Firefox [4,37] and [9,37] for the first
   * two, and a press inside a range is a drag of its text there). The
   * editor anchors where the browser did, read once the press has acted, as
   * the end of its range farther from the press. Real input: e2e.
   */
  test('P17h a Shift drag back from another block keeps the browser’s anchor', async ({
    browserName,
    editor,
    page,
  }) => {
    const text = 'The quick brown fox jumps over the lazy dog';
    const run = async (
      clicks: 1 | 2,
      via: boolean,
      before: readonly [number, number] = [9, 9],
      pressAt = 4,
      mount: 'plain' | 'shadow' = 'plain',
      peerFirst = false,
    ) => {
      await editor.load({ doc: 'paragraphs', toolbar: 0, mount });
      await page.evaluate((text) => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks[1]!.content = [{ text }];
        ed.setDocument(doc);
      }, text);
      const at = (offset: number, part: number) =>
        editor.content('p2').evaluate(
          (host, [offset, part]) => {
            const range = host.ownerDocument.createRange();
            range.setStart(host.firstChild!, offset);
            range.setEnd(host.firstChild!, offset + 1);
            const box = range.getBoundingClientRect();
            return { x: box.left + box.width * part, y: box.top + box.height / 2 };
          },
          [offset, part] as const,
        );
      const from = await at(before[0], 0.05);
      const until = await at(before[1], 0.05);
      const press = await at(pressAt, 0.25);
      const to = await at(37, 0.3);
      const p3 = await editor.pointAt(editor.content('p3'), 3);
      // The reader's range: a caret, or one dragged out either way.
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(until.x, until.y, { steps: 4 });
      await page.mouse.up();
      await page.keyboard.down('Shift');
      await page.mouse.move(press.x, press.y);
      for (let n = 1; n < clicks; n += 1) {
        await page.mouse.down({ clickCount: n });
        await page.mouse.up({ clickCount: n });
      }
      await page.mouse.down({ clickCount: clicks });
      await page.keyboard.up('Shift');
      // A peer's "zz " put in front before the first move: the text under
      // the press is redrawn while it still holds the browser's range.
      if (peerFirst) {
        await page.evaluate(() => {
          const ed = window.__e2e.editor;
          const doc = ed.getDocument();
          doc.blocks[1]!.content = [{ text: 'zz ' }, ...doc.blocks[1]!.content];
          ed.setDocument(doc);
        });
      }
      for (let i = 1; i <= 8; i += 1) {
        if (via && i === 4) {
          await page.mouse.move(p3.x, p3.y, { steps: 3 });
          expect(await editor.selected(), 'away, a block selection').toEqual(['p2', 'p3']);
        }
        await page.mouse.move(press.x + ((to.x - press.x) * i) / 8, press.y);
      }
      await page.mouse.up({ clickCount: clicks });
      await editor.settle();
      return (await editor.selection())?.range;
    };

    const direct = await run(1, false);
    expect(direct).toEqual({ start: 9, end: 37 });
    expect(await run(1, true), 'Shift+click').toEqual(direct);
    // Firefox anchors a Shift+double-click afresh on the word pressed.
    const double = await run(2, false);
    expect(double).toEqual(browserName === 'firefox' ? { start: 4, end: 39 } : direct);
    expect(await run(2, true), 'Shift+double-click').toEqual(double);

    const firefox = browserName === 'firefox';
    for (const [label, before, pressAt, chromium, gecko] of [
      ['[4,9] Shift+clicked at 2', [4, 9], 2, { start: 9, end: 37 }, { start: 4, end: 37 }],
      ['[9,4] Shift+clicked at 20', [9, 4], 20, { start: 4, end: 37 }, { start: 9, end: 37 }],
      ['[4,20] Shift+clicked at 11', [4, 20], 11, { start: 20, end: 37 }, null],
    ] as const) {
      // A press inside a range is the start of a drag of that text in
      // Firefox, Shift or not: not a selection at all.
      if (firefox && gecko === null) continue;
      const native = await run(1, false, before, pressAt);
      expect(native, label).toEqual(firefox ? gecko : chromium);
      expect(await run(1, true, before, pressAt), `${label}, via p3`).toEqual(native);
    }

    // In a shadow root WebKit reports the backward range a Shift+click made
    // as forward; read as its anchor, the caret at 9 came back [4,37], and
    // [4,20] Shift+clicked at 11 came back [11,37]. The end farther from the
    // press is the anchor in every engine (R13-RV9-PTR-1).
    for (const [before, pressAt] of [
      [[9, 9], 4],
      [[4, 20], 11],
    ] as const) {
      if (firefox && pressAt === 11) continue;
      const label = `shadow, from ${before.join('-')} at ${pressAt}`;
      const native = await run(1, false, before, pressAt, 'shadow');
      expect(await run(1, true, before, pressAt, 'shadow'), label).toEqual(native);
    }

    // A peer's update before the first move: the anchor the browser chose is
    // read before the redraw (`#noteDragAnchor`, from `setDocument`), kept by
    // which end of the range it is (`anchorEnd`), and handed to that end of
    // the carried range -- three characters on, past the peer's "zz ".
    // Read after it, from the carried range, it was the end nearer the
    // press; asked of the carried range's direction, WebKit in a shadow root
    // put it at the start.
    for (const mount of ['plain', 'shadow'] as const) {
      const native = await run(1, false, [9, 9], 4, mount);
      const label = `${mount}, a peer before the first move`;
      expect(await run(1, true, [9, 9], 4, mount, true), label).toEqual({
        start: native!.start + 3,
        end: native!.end,
      });
    }
  });

  /*
   * R13-RV9-PTR-2: Shift extends a range within its own host and otherwise
   * leaves it. "Alpha" selected in p1, then a Shift+click in p2, a Shift
   * drag in p2, and a Shift drag carried down into p3 and back: Chromium
   * and WebKit grew the range to the edge of p1 facing the press ([0,5] to
   * [0,9], all of "Alpha one", the next key deleting text never selected),
   * Firefox dropped it for a caret at p2's start, and the editor drew a
   * range in p2 the reader never anchored. The same for a caret; for a
   * link in the other block, whose click selected the link and opened the
   * link editor (R13-RV10, item 2); and for a table's other cell, another
   * host: "ab" of "abcd" selected stays selected, and "x" makes "xcd" --
   * the whole cell selected could not tell the cell from the table
   * (R13-RV10-PTR-1). Real Shift input: e2e.
   */
  test('P17i a Shift press in another block leaves the reader’s range alone', async ({
    editor,
    page,
  }) => {
    for (const how of ['click', 'drag', 'drag via p3', 'caret, click', 'link'] as const) {
      await editor.load({ doc: 'paragraphs', toolbar: 0 });
      if (how === 'link') {
        await page.evaluate(() => {
          const ed = window.__e2e.editor;
          const doc = ed.getDocument();
          doc.blocks[1]!.content = [
            { text: 'Brav' },
            { text: 'o two', link: 'https://example.com/' },
          ];
          ed.setDocument(doc);
        });
      }
      const from = await editor.pointAt(editor.content('p1'), 0);
      const until = await editor.pointAt(editor.content('p1'), 5);
      if (how === 'caret, click') {
        await page.mouse.click(until.x, until.y);
      } else {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(until.x, until.y, { steps: 4 });
        await page.mouse.up();
      }
      const before = await editor.selection();
      expect(before?.blockId, how).toBe('p1');
      // Inside the link's text, which every engine hits as the link.
      const press = await editor.pointAt(editor.content('p2'), how === 'link' ? 6 : 4);
      const to = await editor.pointAt(editor.content('p2'), 8);
      const p3 = await editor.pointAt(editor.content('p3'), 3);
      await page.keyboard.down('Shift');
      await page.mouse.move(press.x, press.y);
      await page.mouse.down();
      if (how !== 'click' && how !== 'caret, click') {
        if (how === 'drag via p3') await page.mouse.move(p3.x, p3.y, { steps: 4 });
        await page.mouse.move(to.x, to.y, { steps: 4 });
      }
      await page.mouse.up();
      await page.keyboard.up('Shift');
      await editor.settle();
      expect(await editor.selection(), how).toEqual(before);
      expect(await editor.selected(), how).toEqual([]);
      await expect(editor.portal('link-editor'), how).toBeHidden();
    }

    await editor.load({ doc: 'table', toolbar: 0 });
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const doc = ed.getDocument();
      doc.blocks[1]!.rows![1]![0] = [{ text: 'abcd' }];
      ed.setDocument(doc);
    });
    await editor.clickAt('before', 3);
    const cell = editor.cell('tbl', 1, 0);
    const a = await editor.pointAt(cell, 0);
    const b = await editor.pointAt(cell, 2);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 3 });
    await page.mouse.up();
    const inCell = await editor.selection();
    expect(inCell?.range).toEqual({ start: 0, end: 2 });
    const other = await editor.pointAt(editor.cell('tbl', 1, 2), 1);
    await page.keyboard.down('Shift');
    await page.mouse.click(other.x, other.y);
    await page.keyboard.up('Shift');
    expect(await editor.selection(), 'another cell').toEqual(inCell);
    await page.keyboard.type('x');
    await expect(cell).toHaveText('xcd');
  });

  /*
   * R13-RV10-PTR-3, -4: a Shift press with no range of the reader's to
   * extend -- focus on a page button with a range left in p1, focus in the
   * link editor's field, a block selection, nothing selected at all -- is a
   * plain press: the caret where it lands, and a Shift drag from there
   * selects as a plain drag does, in every engine. Left to the browser, the
   * stale range swallowed the press and the next key; from the link editor
   * Firefox put the caret at the start of the block pressed, and Backspace
   * merged it into the block above. Real Shift input: e2e.
   */
  test('P17j a Shift press with no range of the reader’s is a plain press', async ({
    editor,
    page,
  }) => {
    for (const before of ['page button', 'link editor', 'block selection', 'nothing'] as const) {
      for (const drag of [false, true]) {
        const label = `${before}${drag ? ', drag' : ''}`;
        await editor.load({ doc: 'paragraphs', toolbar: 0 });
        if (before === 'page button') {
          await page.evaluate(() => {
            const button = document.createElement('button');
            button.id = 'page-button';
            button.textContent = 'Save';
            document.body.prepend(button);
          });
          await editor.dragText(['p1', 0], ['p1', 5]);
          await page.locator('#page-button').click();
        } else if (before === 'link editor') {
          await editor.dragText(['p1', 0], ['p1', 5]);
          await page.keyboard.press(`${MOD}+k`);
          await expect(editor.portal('link-editor').getByRole('textbox')).toBeFocused();
        } else if (before === 'block selection') {
          await editor.clickAt('p1', 2);
          await page.keyboard.press('Escape');
          expect(await editor.selected(), label).toEqual(['p1']);
        }
        const press = await editor.pointAt(editor.content('p3'), 4);
        const to = await editor.pointAt(editor.content('p3'), 9);
        await page.keyboard.down('Shift');
        await page.mouse.move(press.x, press.y);
        await page.mouse.down();
        if (drag) await page.mouse.move(to.x, to.y, { steps: 5 });
        await page.mouse.up();
        await page.keyboard.up('Shift');
        await editor.settle();
        expect(await editor.selected(), label).toEqual([]);
        expect(await editor.selection(), label).toMatchObject({
          blockId: 'p3',
          range: { start: 4, end: drag ? 9 : 4 },
        });
        if (!drag) {
          // The key goes where the caret is: nothing merged, nothing lost.
          await page.keyboard.press('Backspace');
          expect(await editor.ids(), label).toEqual(['p1', 'p2', 'p3']);
          await expect(editor.content('p3'), label).toHaveText('Chalie three');
        }
      }
    }
  });

  /*
   * R13-RV11-PTR-1 to -4. A press never reveals the block it lands in:
   * revealed (`scrollIntoView`), a block taller than the window moved under
   * a Shift press with nothing to extend, and the drag from it selected
   * 1,491 characters for six; a plain press in the gutter beside it jumped
   * the page. (It reveals the caret it placed where that is off screen:
   * P17m.) Beside the text,
   * a Shift press with nothing to extend is a plain press too: the start
   * of a list item for its marker, a paragraph below the last block, the
   * nearest cell for a table's border -- it was swallowed, with the next
   * key. A Shift press cancelled on another block spends its flag on its own
   * click, so a page's later `click()` on a link still opens the editor; and
   * a Shift+click on a link in the reader's own block extends the range, as
   * one beside it does, where every engine put a caret and the editor opened
   * the link editor. Real input: e2e.
   */
  test('P17l a press does not reveal its block, and a Shift press beside the text with nothing to extend is a plain one', async ({
    editor,
    page,
  }) => {
    const pageButton = async () => {
      await page.evaluate(() => {
        const button = document.createElement('button');
        button.id = 'page-button';
        button.textContent = 'Save';
        Object.assign(button.style, { position: 'fixed', right: '10px', bottom: '10px' });
        document.body.append(button);
      });
      await page.locator('#page-button').click();
    };
    const long = Array.from({ length: 120 }, (_, i) => `word${i} lorem ipsum dolor sit`).join(' ');
    const tall = async () => {
      await editor.load({ doc: 'paragraphs', toolbar: 0 });
      await page.evaluate((long) => {
        const p = (id: string, text: string) => ({
          id,
          type: 'paragraph' as const,
          content: [{ text }],
          depth: 0,
        });
        window.__e2e.editor.setDocument({
          blocks: [
            ...Array.from({ length: 30 }, (_, i) => p(`g${i}`, `pre ${i}`)),
            p('p2', long),
            ...Array.from({ length: 30 }, (_, i) => p(`f${i}`, `filler ${i}`)),
          ],
        });
      }, long);
      await pageButton();
      await editor.content('p2').evaluate((host) => {
        window.scrollTo(0, host.getBoundingClientRect().top + window.scrollY - 400);
      });
      await editor.settle();
      return page.evaluate(() => window.scrollY);
    };

    const y0 = await tall();
    const a = await editor.pointAt(editor.content('p2'), 60);
    const b = await editor.pointAt(editor.content('p2'), 66);
    await page.keyboard.down('Shift');
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await editor.settle();
    expect(await page.evaluate(() => window.scrollY), 'Shift drag').toBe(y0);
    expect((await editor.selection())?.range, 'Shift drag').toEqual({ start: 60, end: 66 });

    const y1 = await tall();
    const gutter = await editor.content('p2').evaluate((host) => {
      const box = host.getBoundingClientRect();
      return { x: box.left - 8, y: box.top + 60 };
    });
    await page.mouse.click(gutter.x, gutter.y);
    await editor.settle();
    expect(await page.evaluate(() => window.scrollY), 'gutter press').toBe(y1);
    expect((await editor.selection())?.blockId, 'gutter press').toBe('p2');

    // Beside the text, nothing to extend.
    const shiftClick = async (point: { x: number; y: number }) => {
      await page.keyboard.down('Shift');
      await page.mouse.click(point.x, point.y);
      await page.keyboard.up('Shift');
      await editor.settle();
    };
    await editor.load({ doc: 'paragraphs', toolbar: 0 });
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const doc = ed.getDocument();
      doc.blocks[1] = { ...doc.blocks[1]!, type: 'bulleted_list' };
      ed.setDocument(doc);
    });
    await pageButton();
    await shiftClick(
      await editor
        .block('p2')
        .locator('.neditor-block__marker')
        .evaluate((m) => {
          const box = m.getBoundingClientRect();
          return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        }),
    );
    expect(await editor.selection(), 'marker').toMatchObject({
      blockId: 'p2',
      range: { start: 0, end: 0 },
    });

    await editor.load({ doc: 'paragraphs', toolbar: 0 });
    await pageButton();
    await shiftClick(
      await editor.content('p3').evaluate((host) => {
        const box = host.getBoundingClientRect();
        const root = host.closest('.neditor')!.getBoundingClientRect();
        return { x: box.left + 30, y: Math.min(root.bottom - 4, box.bottom + 30) };
      }),
    );
    expect(await editor.ids(), 'below the last block').toHaveLength(4);
    expect((await editor.selection())?.blockId, 'below the last block').toBe(
      (await editor.ids())[3],
    );

    await editor.load({ doc: 'table', toolbar: 0 });
    await pageButton();
    const left = (await editor.cell('tbl', 1, 0).boundingBox())!;
    const right = (await editor.cell('tbl', 1, 1).boundingBox())!;
    await shiftClick({ x: (left.x + left.width + right.x) / 2, y: left.y + left.height / 2 });
    expect((await editor.selection())?.blockId, 'table border').toBe('tbl');

    // The flag is the press's own click, and no later one.
    await editor.load({ doc: 'paragraphs', toolbar: 0 });
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const doc = ed.getDocument();
      doc.blocks[1]!.content = [
        { text: 'Bravo ' },
        { text: 'linked', link: 'https://example.com/' },
      ];
      ed.setDocument(doc);
    });
    await editor.dragText(['p1', 0], ['p1', 5]);
    await shiftClick(await editor.pointAt(editor.content('p3'), 4));
    expect((await editor.selection())?.range, 'cancelled').toEqual({ start: 0, end: 5 });
    await page.evaluate(() =>
      window.__e2e.editor.element.querySelector<HTMLElement>('a.neditor-link')!.click(),
    );
    await expect(editor.portal('link-editor'), 'a later click()').toBeVisible();

    // A Shift+click on a link in the reader's own block extends the range.
    await editor.load({ doc: 'paragraphs', toolbar: 0 });
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const doc = ed.getDocument();
      doc.blocks[1]!.content = [
        { text: 'Bravo two ' },
        { text: 'linked', link: 'https://example.com/' },
        { text: ' tail' },
      ];
      ed.setDocument(doc);
    });
    await editor.dragText(['p2', 0], ['p2', 5]);
    await shiftClick(await editor.pointAt(editor.content('p2'), 12));
    expect(await editor.selection(), 'same block').toMatchObject({
      blockId: 'p2',
      range: { start: 0, end: 12 },
    });
    await expect(editor.portal('link-editor'), 'same block').toBeHidden();
  });

  /*
   * R13-RV12-PTR-1 to -4 and the WebKit link click. A press reveals the
   * caret it placed only where that caret is off screen, by the least
   * scroll: beside an image taller than the window its caption's caret was
   * left below the fold, and the first letter typed jumped the page; beside
   * a table scrolled sideways, in a cell out of sight. Beside a tall block
   * holding the reader's range, a Shift press stays put. A Shift+click on a
   * link in the reader's own block extends the range from its end farther
   * from the click, so the reader's text stays in it ("te" Shift+clicked on
   * the link before it gave [8,13]); with ⌘/Ctrl it follows the link. A drag
   * the editor draws goes on across a peer's edit to another block. A plain
   * click on a link inside the reader's range opens the link editor in
   * WebKit too, where it closed again at once: the editor opens it in a task
   * after the click (P17o: the selection can still be dragged by the link).
   * Real input: e2e.
   */
  test('P17m a press reveals only an unseen caret, and Shift on a link extends from the farther end', async ({
    editor,
    page,
  }) => {
    const long = Array.from({ length: 120 }, (_, i) => `word${i} lorem ipsum dolor sit`).join(' ');
    const p = (id: string, text: string) => ({
      id,
      type: 'paragraph' as const,
      content: [{ text }],
      depth: 0,
    });
    const set = (blocks: unknown[]) =>
      page.evaluate((blocks) => window.__e2e.editor.setDocument({ blocks } as never), blocks);
    const linked = [
      p('p1', 'Alpha one'),
      {
        id: 'p2',
        type: 'paragraph',
        depth: 0,
        content: [
          { text: 'Bravo ' },
          { text: 'linked', link: 'https://example.com/' },
          { text: ' text more' },
        ],
      },
      p('p3', 'Charlie three'),
    ];
    const at = (id: string, offset: number) => editor.pointAt(editor.content(id), offset);
    const press = async (point: { x: number; y: number }, keys: string[] = []) => {
      for (const key of keys) await page.keyboard.down(key);
      await page.mouse.click(point.x, point.y);
      for (const key of keys.reverse()) await page.keyboard.up(key);
      await editor.settle();
    };
    const caretInView = () =>
      page.evaluate(() => {
        const range = getSelection()!.getRangeAt(0);
        const box = range.getClientRects()[0] ?? range.getBoundingClientRect();
        return box.bottom > 0 && box.top < innerHeight;
      });

    // An image taller than the window, its caption below the fold.
    await editor.load({ doc: 'paragraphs', toolbar: 0 });
    await page.addStyleTag({
      content: '.neditor-image__frame{min-height:1600px !important;display:block}',
    });
    await set([
      ...Array.from({ length: 20 }, (_, i) => p(`g${i}`, `pre ${i}`)),
      {
        id: 'im',
        type: 'image',
        depth: 0,
        src: 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
        alt: 'pic',
        content: [{ text: 'Caption text' }],
      },
      ...Array.from({ length: 20 }, (_, i) => p(`f${i}`, `filler ${i}`)),
    ]);
    const image = (await editor.block('im').boundingBox())!;
    await page.evaluate((top) => window.scrollTo(0, top + window.scrollY - 100), image.y);
    await editor.settle();
    const frame = (await editor.block('im').boundingBox())!;
    await page.mouse.click(frame.x + 8, 300);
    await editor.settle();
    expect((await editor.selection())?.blockId, 'image').toBe('im');
    expect(await caretInView(), 'image: the caret is shown').toBe(true);
    const typedFrom = await page.evaluate(() => window.scrollY);
    await page.keyboard.type('x');
    expect(await page.evaluate(() => window.scrollY), 'image: typing stays').toBe(typedFrom);

    // A table scrolled sideways: the cell the press lands in is shown -- in
    // a page drawn at half scale too, where the drawn distance scrolled the
    // table half as far as it had to go (R13-RV13-PTR-2).
    const row = (r: number) =>
      Array.from({ length: 8 }, (_, c) => [
        { text: `r${r}c${c}_unbreakable_long_cell_content_xxxxxxxxxx` },
      ]);
    for (const scale of [1, 0.5]) {
      await editor.load({ doc: 'paragraphs', toolbar: 0 });
      await set([
        p('p1', 'Alpha one'),
        { id: 't1', type: 'table', depth: 0, content: [], rows: [row(0), row(1), row(2)] },
        p('p3', 'Charlie'),
      ]);
      await page.evaluate((scale) => {
        const root = window.__e2e.editor.element;
        root.style.transform = `scale(${scale})`;
        root.style.transformOrigin = '0 0';
      }, scale);
      const wrapper = editor.block('t1').locator('.neditor-table');
      await wrapper.evaluate((w) => {
        w.scrollLeft = 900;
      });
      const box = (await wrapper.boundingBox())!;
      const block = (await editor.block('t1').boundingBox())!;
      const cell = (await editor.cell('t1', 1, 0).boundingBox())!;
      await page.mouse.click(Math.max(block.x + 2, box.x - 3), cell.y + cell.height / 2);
      await editor.settle();
      expect((await editor.selection())?.cell, `table at ${scale}`).toEqual({ row: 1, column: 0 });
      const shown = await page.evaluate(() => {
        const range = getSelection()!.getRangeAt(0);
        const caret = range.getClientRects()[0] ?? range.getBoundingClientRect();
        const node = range.startContainer;
        const element = (node.nodeType === 1 ? node : node.parentElement) as Element;
        const clip = element.closest('.neditor-table')!.getBoundingClientRect();
        return caret.right >= clip.left && caret.left <= clip.right;
      });
      expect(shown, `table at ${scale}: the caret is shown`).toBe(true);
    }

    // A Shift press beside a tall block holding the reader's range.
    await editor.load({ doc: 'paragraphs', toolbar: 0 });
    await set([
      ...Array.from({ length: 30 }, (_, i) => p(`g${i}`, `pre ${i}`)),
      p('p2', long),
      ...Array.from({ length: 30 }, (_, i) => p(`f${i}`, `filler ${i}`)),
    ]);
    await editor.content('p2').evaluate((host) => {
      window.scrollTo(0, host.getBoundingClientRect().top + window.scrollY - 400);
    });
    await editor.settle();
    await editor.dragText(['p2', 60], ['p2', 64]);
    const y0 = await page.evaluate(() => window.scrollY);
    const host = (await editor.content('p2').boundingBox())!;
    await press({ x: host.x - 4, y: 600 }, ['Shift']);
    expect(await page.evaluate(() => window.scrollY), 'Shift beside a tall block').toBe(y0);

    // Shift+click on a link: from the reader's range's farther end.
    for (const [label, from, to, click, want, mount] of [
      ['"te" before it', 13, 15, 8, { start: 8, end: 15 }, 'plain'],
      ['"et" backward, before it', 15, 13, 8, { start: 8, end: 15 }, 'plain'],
      ['"av" backward, after it', 4, 2, 9, { start: 2, end: 9 }, 'plain'],
      ['"et" backward, shadow', 15, 13, 8, { start: 8, end: 15 }, 'shadow'],
    ] as const) {
      await editor.load({ doc: 'paragraphs', toolbar: 0, mount });
      await set(linked);
      await editor.dragText(['p2', from], ['p2', to]);
      await press(await at('p2', click), ['Shift']);
      expect((await editor.selection())?.range, label).toEqual(want);
      await expect(editor.portal('link-editor'), label).toBeHidden();
    }

    // A Shift drag from a link in the reader's own block.
    await editor.load({ doc: 'paragraphs', toolbar: 0 });
    await set(linked);
    await editor.dragText(['p2', 0], ['p2', 3]);
    const from9 = await at('p2', 9);
    const to16 = await at('p2', 16);
    await page.keyboard.down('Shift');
    await page.mouse.move(from9.x, from9.y);
    await page.mouse.down();
    await page.mouse.move(to16.x, to16.y, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    expect((await editor.selection())?.range, 'Shift drag from a link').toEqual({
      start: 0,
      end: 16,
    });

    // ⌘/Ctrl+Shift+click follows the link, wherever the reader's range is.
    for (const where of ['p2', 'p1'] as const) {
      await editor.load({ doc: 'paragraphs', toolbar: 0 });
      await set(linked);
      await page.evaluate(() => {
        (window as unknown as { __opened: string[] }).__opened = [];
        window.open = ((url: string) => {
          (window as unknown as { __opened: string[] }).__opened.push(url);
          return null;
        }) as typeof window.open;
      });
      await editor.dragText([where, 0], [where, 3]);
      await press(await at('p2', 9), ['Shift', MOD]);
      expect(
        await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened),
        `⌘/Ctrl+Shift, range in ${where}`,
      ).toEqual(['https://example.com/']);
    }

    // A placed drag goes on across a peer's edit to another block.
    await editor.load({ doc: 'paragraphs', toolbar: 0 });
    await set([
      p('p1', 'Alpha one'),
      { ...p('l1', 'List item text more words'), type: 'bulleted_list' },
      p('p3', 'Charlie'),
    ]);
    const marker = (await editor.block('l1').locator('.neditor-block__marker').boundingBox())!;
    const end16 = await at('l1', 16);
    await page.mouse.move(marker.x + marker.width / 2, marker.y + marker.height / 2);
    await page.mouse.down();
    await page.mouse.move(marker.x + marker.width / 2 + 30, marker.y + marker.height / 2, {
      steps: 3,
    });
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const doc = ed.getDocument();
      doc.blocks[0]!.content = [{ text: 'Alpha one PEER' }];
      ed.setDocument(doc);
    });
    await page.mouse.move(end16.x, end16.y, { steps: 5 });
    await page.mouse.up();
    expect((await editor.selection())?.range, 'placed drag, a peer elsewhere').toEqual({
      start: 0,
      end: 16,
    });

    // A plain click on a link inside the reader's range opens the editor.
    await editor.load({ doc: 'paragraphs', toolbar: 0 });
    await set(linked);
    await editor.dragText(['p2', 0], ['p2', 9]);
    await press(await at('p2', 8));
    await expect(editor.portal('link-editor'), 'click inside the range').toBeVisible();
    await expect(editor.portal('link-editor').getByRole('textbox')).toBeFocused();
  });

  /*
   * R13-RV13-PTR-1: a selection is dragged by a link in it like any other
   * text -- into another block (copied through `#handleDrop`) and into a page
   * field -- and so is a selection that is exactly the link. Cancelling a
   * press on a link inside the reader's range (so that WebKit's click would
   * open the link editor) cost every engine that drag; the editor opens the
   * link editor in a task after the click instead. Firefox only: Chromium
   * and WebKit start no native drag of a selection under Playwright's
   * synthesized mouse.
   */
  test('P17o a selection can be dragged by a link in it', async ({ browserName, editor, page }) => {
    test.skip(browserName !== 'firefox', 'only Firefox starts a native selection drag here');
    for (const [label, from, to, target] of [
      ['into another block', 0, 16, 'p3'],
      ['into a page field', 0, 16, 'field'],
      ['exactly the link, into a page field', 6, 12, 'field'],
    ] as const) {
      await editor.load({ doc: 'paragraphs', toolbar: 0 });
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks[1]!.content = [
          { text: 'Bravo ' },
          { text: 'linked', link: 'https://example.com/' },
          { text: ' text more' },
        ];
        ed.setDocument(doc);
        const field = document.createElement('textarea');
        field.id = 'drop-field';
        Object.assign(field.style, { position: 'fixed', left: '20px', bottom: '20px' });
        document.body.append(field);
      });
      await editor.dragText(['p2', from], ['p2', to]);
      const grab = await editor.pointAt(editor.content('p2'), 9);
      const drop =
        target === 'p3'
          ? await editor.pointAt(editor.content('p3'), 12)
          : await page
              .locator('#drop-field')
              .boundingBox()
              .then((b) => ({ x: b!.x + 20, y: b!.y + 10 }));
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      await page.mouse.move(grab.x + 5, grab.y + 5, { steps: 3 });
      await page.mouse.move(drop.x, drop.y, { steps: 10 });
      await page.mouse.up();
      await editor.settle();
      const moved = from === 6 ? 'linked' : 'Bravo linked tex';
      if (target === 'p3') {
        await expect(editor.content('p3'), label).toContainText(moved);
      } else {
        await expect(page.locator('#drop-field'), label).toHaveValue(moved);
      }
      await expect(editor.portal('link-editor'), label).toBeHidden();
    }
  });

  /*
   * R13-RV14-PTR-1 and the lock: the link editor a click on a link opens in
   * a task after the click gives way to anything newer. A page's own click
   * listener that moves focus -- to a button of its own, or to a caret it
   * places through `focus()` -- keeps it, where the task took focus back into
   * the link's URL field; and one that locks and unlocks the editor leaves
   * the caret where the unlock gave it back. Real clicks: e2e.
   */
  test('P17p a page’s own click listener has the last word over a link click', async ({
    editor,
    page,
  }) => {
    for (const how of ['a page button', 'focus()', 'a lock and an unlock'] as const) {
      await editor.load({ doc: 'paragraphs', toolbar: 0 });
      await page.evaluate((how) => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks[1]!.content = [
          { text: 'Bravo ' },
          { text: 'linked', link: 'https://example.com/' },
          { text: ' text more' },
        ];
        ed.setDocument(doc);
        const button = document.createElement('button');
        button.id = 'page-button';
        button.textContent = 'Card';
        document.body.prepend(button);
        document.addEventListener('click', (event) => {
          if (!(event.target as Element).closest?.('a')) return;
          if (how === 'a page button') button.focus();
          else if (how === 'focus()') ed.focus('p3', 13);
          else {
            ed.setEditable(false);
            ed.setEditable(true);
          }
        });
      }, how);
      await editor.clickAt('p2', 2);
      const link = await editor.pointAt(editor.content('p2'), 8);
      await page.mouse.click(link.x, link.y);
      await page.waitForTimeout(100);
      await expect(editor.portal('link-editor'), how).toBeHidden();
      if (how === 'a page button') {
        await expect(page.locator('#page-button'), how).toBeFocused();
      } else if (how === 'focus()') {
        expect(await editor.selection(), how).toMatchObject({
          blockId: 'p3',
          range: { start: 13, end: 13 },
        });
      } else {
        expect((await editor.selection())?.blockId, how).toBe('p2');
      }
    }
  });

  /*
   * R13-RV15-PTR-1: a host that re-asserts `setEditable(true)` -- on every
   * render, or on each `selection` event -- switches nothing, and the link
   * editor a click on a link asks for still opens. Cancelled on every call,
   * it never did in Firefox and in Chromium's quick click. With a caret
   * before the link, and with a range around it. Real clicks: e2e.
   */
  test('P17q a host re-asserting setEditable(true) keeps the link editor a click opens', async ({
    editor,
    page,
  }) => {
    for (const before of ['a caret', 'a range around the link'] as const) {
      await editor.load({ doc: 'paragraphs', toolbar: 0 });
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks[1]!.content = [
          { text: 'Bravo ' },
          { text: 'linked', link: 'https://example.com/' },
          { text: ' text more' },
        ];
        ed.setDocument(doc);
      });
      if (before === 'a caret') {
        await editor.clickAt('p2', 2);
      } else {
        await editor.dragText(['p2', 0], ['p2', 9]);
      }
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        ed.on('selection', () => ed.setEditable(true));
      });
      const link = await editor.pointAt(editor.content('p2'), 8);
      await page.mouse.click(link.x, link.y);
      await expect(editor.portal('link-editor'), before).toBeVisible();
      await expect(editor.portal('link-editor').getByRole('textbox'), before).toBeFocused();
    }
  });

  /*
   * R14-PTR-1 (= R14-KEY-2), p2's and p2b's literal cases: a click on a link
   * revealed the link's whole block (`scrollIntoView`) before opening the
   * link editor. In a 2,262px block with the link 300px down the window the
   * page scrolled 300px and the link left the pointer; in a paragraph cut
   * at the window's bottom, 89px (158px in an iframe mount). A press never
   * reveals the host: the link is selected where it is, and only a link not
   * wholly in sight is brought into view, the least way -- one whose own
   * line the window's edge cuts, by the few pixels it lacks, as a press the
   * editor places beside that line is. Escape from the link editor
   * and its Apply put the range back the same way -- revealing the host
   * there scrolled the cut paragraph on Escape. A script's `click()` on a
   * link out of sight above the window brings the link on screen, which
   * revealing a host that covers the window did not. Scrolling: e2e.
   */
  test('P17r a click on a link does not bring its block into view, and the link editor closes where it opened', async ({
    editor: plain,
    page,
  }) => {
    const long = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(150);
    const setup = async (mount: 'plain' | 'iframe', before: string, after: string) => {
      await plain.load({ doc: 'long', mount });
      const editor =
        mount === 'iframe' ? new EditorPage(page, 0, page.frameLocator('#frame')) : plain;
      await editor.content('p1').evaluate(
        (_, { before, after }) => {
          const ed = (window.__e2e ?? window.parent.__e2e).editor;
          const blocks = ed.getDocument().blocks;
          blocks.splice(20, 0, {
            id: 'lk',
            type: 'paragraph',
            depth: 0,
            content: [
              { text: before },
              { text: 'here now', link: 'https://example.com/' },
              { text: after },
            ],
          });
          ed.setDocument({ blocks });
        },
        { before, after },
      );
      return editor;
    };
    const link = (editor: EditorPage) => editor.content('lk').locator('a.neditor-link');
    const scrollOf = (editor: EditorPage) =>
      editor.content('lk').evaluate(() => {
        let y = 0;
        for (let w: Window = window; ; w = w.parent) {
          y += w.scrollY;
          if (w === w.parent) return y;
        }
      });
    const linkTop = (editor: EditorPage) =>
      link(editor).evaluate((a) => Math.round(a.getBoundingClientRect().top));

    for (const [shape, mount, before, after, top] of [
      ['a block taller than the window', 'plain', 'Go ', long, 300],
      // Negative: from the bottom of the editor's own window.
      ['a paragraph cut at the bottom', 'plain', 'Go ', long.slice(0, 600), -40],
      ['a paragraph cut at the bottom', 'iframe', 'Go ', long.slice(0, 600), -40],
      // The link's own line cut: shown, by the few pixels it lacks.
      ['a link line cut at the bottom', 'iframe', 'Go ', long.slice(0, 600), -12],
    ] as const) {
      for (const close of ['Escape', 'Apply'] as const) {
        const label = `${shape}, ${mount}, ${close}`;
        const editor = await setup(mount, before, after);
        await link(editor).evaluate((a, top) => {
          const at = top < 0 ? window.innerHeight + top : top;
          window.scrollTo(0, a.getBoundingClientRect().top + window.scrollY - at);
        }, top);
        await editor.settle();
        const y0 = await scrollOf(editor);
        const box = (await link(editor).boundingBox())!;
        // Its upper half: all of a cut line that is sure to be in sight.
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 4);
        await expect(editor.portal('link-editor'), label).toBeVisible();
        const y = await scrollOf(editor);

        if (top === -12) {
          // As a press the editor places beside that line moves it (6-8px
          // measured, by engine); round 13 revealed the paragraph, 156px.
          expect(y - y0, `${label}: the click`).toBeGreaterThan(0);
          expect(y - y0, `${label}: the click`).toBeLessThanOrEqual(12);
        } else {
          expect(y, `${label}: the click`).toBe(y0);
        }

        if (close === 'Escape') {
          await page.keyboard.press('Escape');
        } else {
          await editor.portal('link-editor').getByRole('textbox').fill('https://example.org/');
          await page.keyboard.press('Enter');
        }
        await expect(editor.portal('link-editor'), label).toBeHidden();
        await editor.settle();
        expect(await scrollOf(editor), `${label}: ${close}`).toBe(y);
        expect((await editor.selection())?.range, label).toEqual({
          start: before.length,
          end: before.length + 8,
        });
      }
    }

    // A script's click on a link out of sight above the window.
    const editor = await setup('plain', long.slice(0, 2500), long);
    await link(editor).evaluate((a) => {
      window.scrollTo(0, a.getBoundingClientRect().top + window.scrollY + 600);
    });
    await editor.settle();
    await link(editor).evaluate((a) => (a as HTMLAnchorElement).click());
    await expect(editor.portal('link-editor')).toBeVisible();
    const shown = await linkTop(editor);
    expect(shown).toBeGreaterThanOrEqual(0);
    expect(shown).toBeLessThan(page.viewportSize()!.height);
  });

  /*
   * `#shiftPress` is spent by the first click after the press, and only a
   * pointer's own click (`detail` above 0) is the press's: a Shift press on
   * the reader's range, released outside the editor (no click on it), then
   * a page's `click()` on a link, opens the link editor; a Shift+click
   * cancelled on another block, then a script's click with a `detail` of 1,
   * does too.
   */
  test('P17n a Shift press’s flag is its own click’s alone', async ({ editor, page }) => {
    // A click with a `detail` of 1 is a pointer's own, whose press put focus
    // in the link's host (the link editor opens only while it is there).
    const link = (detail: number) =>
      page.evaluate((detail) => {
        const anchor = window.__e2e.editor.element.querySelector<HTMLElement>('a.neditor-link')!;
        if (detail > 0) anchor.closest<HTMLElement>('[contenteditable]')!.focus();
        anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
      }, detail);
    const linked = async () => {
      await editor.load({ doc: 'paragraphs', toolbar: 0 });
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks[1]!.content = [
          { text: 'Bravo ' },
          { text: 'linked', link: 'https://example.com/' },
          { text: ' text more' },
        ];
        ed.setDocument(doc);
      });
    };

    await linked();
    await editor.dragText(['p2', 0], ['p2', 3]);
    const start = await editor.pointAt(editor.content('p2'), 14);
    await page.keyboard.down('Shift');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(1050, 760, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await link(0);
    await expect(editor.portal('link-editor'), 'released outside').toBeVisible();

    await linked();
    await editor.dragText(['p1', 0], ['p1', 5]);
    const other = await editor.pointAt(editor.content('p3'), 4);
    await page.keyboard.down('Shift');
    await page.mouse.click(other.x, other.y);
    await page.keyboard.up('Shift');
    await link(1);
    await expect(editor.portal('link-editor'), 'a later click').toBeVisible();
  });

  /*
   * A read-only view keeps the browser's own Shift: its blocks are no
   * editing hosts and its selection crosses them, and the extension is
   * promoted to a block selection at the release, for copying. Cancelled
   * like an editable view's press on another host, it selected nothing.
   */
  test('P17k read-only: a Shift+click in another block selects both blocks', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs', toolbar: 0, editable: false });
    await editor.dragText(['p1', 0], ['p1', 5]);
    const press = await editor.pointAt(editor.content('p2'), 4);
    await page.keyboard.down('Shift');
    await page.mouse.click(press.x, press.y);
    await page.keyboard.up('Shift');
    await editor.settle();
    expect(await editor.selected()).toEqual(['p1', 'p2']);
  });

  /*
   * R14-RV1-1, the reviewer's a1 / a2 cases. A press still selecting text
   * in its own block when a peer's `setDocument` edits ANOTHER block: the
   * browser's own drag goes on in that block untouched, and the editor
   * goes on watching it for the block edge. Until round 14 any update
   * ended the watching (this test pinned that), so the drag could no
   * longer become a block selection once it crossed into the next block:
   * p2 to p3 released a range of p2's text, and a drag from p1 to p6 with a
   * peer typing every 200 ms did 3 to 8 times in 30. It is given back over
   * an update that leaves the blocks shown in their order -- the rule a
   * drag already across blocks goes by (P17d2) -- and over an edit to its
   * own block (drawn by the editor from there, P17b). An update that
   * reorders or removes a shown block still ends it: it stays the
   * browser's text drag in its block. A drag the editor draws has no drag
   * of the browser's behind it, and goes on over a reorder too.
   */
  test('P17d a text drag still in its own block when a peer edits another block goes on to cross blocks', async ({
    editor,
    page,
  }) => {
    // The drag as it is held across the blocks: what is selected, and
    // where focus is.
    const held: Record<string, { selected: string[]; focus: string }> = {};

    for (const update of [
      'nothing',
      'another block',
      'its own block',
      'a reorder',
      'a removal',
    ] as const) {
      await editor.load({ doc: 'five', toolbar: 0 });
      const start = await editor.pointAt(editor.content('b'), 0);
      const end = await editor.pointAt(editor.content('c'), 5);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + 2, start.y);
      await page.evaluate((update) => {
        if (update === 'nothing') return;
        const ed = window.__e2e.editor;
        const blocks = ed.getDocument().blocks;
        const index = update === 'its own block' ? 1 : 4;
        if (update === 'a reorder') blocks.splice(3, 0, ...blocks.splice(4, 1));
        else if (update === 'a removal') blocks.splice(4, 1);
        else blocks[index]!.content = [...blocks[index]!.content, { text: '!' }];
        ed.setDocument({ blocks });
      }, update);
      await page.mouse.move(end.x, end.y, { steps: 10 });
      await editor.settle();
      held[update] = await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const active = document.activeElement;
        const block = active?.closest('[data-block-id]')?.getAttribute('data-block-id');
        return {
          selected: ed.getSelectedBlocks(),
          focus: active === ed.element ? 'the root' : (block ?? active?.tagName ?? 'none'),
        };
      });
      await page.mouse.up();
      await editor.settle();

      if (update === 'a reorder' || update === 'a removal') {
        expect(await editor.selected(), update).toEqual([]);
        expect((await editor.selection())?.blockId, update).toBe('b');
      } else {
        expect(await editor.selected(), update).toEqual(['b', 'c']);
      }
    }

    // Given back, it is the drag it was, and nothing is written under it
    // while it is held: left marked as ended, the caret WebKit's own drag
    // keeps in the block under the pointer was taken out as it appeared,
    // and focus put on the root in the middle of the drag.
    expect(held['another block']).toEqual(held['nothing']);

    // A drag the editor draws -- a press beside "Block B", in its gutter --
    // goes on over a reorder of other blocks too, by the new order: its
    // anchor is in its own block's text, which the update left alone. D and
    // E change places, and the drag is carried down over the next two
    // blocks: C, and E where D was. (No gutter: its handle is drawn where
    // the press lands.)
    await editor.load({ doc: 'five', toolbar: 0, dragHandles: false });
    const beside = (await editor.content('b').boundingBox())!;
    const third = (await editor.content('d').boundingBox())!;
    await page.mouse.move(beside.x - 6, beside.y + beside.height / 2);
    await page.mouse.down();
    await page.mouse.move(beside.x - 7, beside.y + beside.height / 2);
    await page.mouse.move(beside.x + 40, beside.y + beside.height / 2, { steps: 4 });
    expect((await editor.selection())?.blockId, 'drawn, a reorder').toBe('b');
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const blocks = ed.getDocument().blocks;
      blocks.splice(3, 0, ...blocks.splice(4, 1));
      ed.setDocument({ blocks });
    });
    await page.mouse.move(third.x + 40, third.y + third.height / 2, { steps: 8 });
    expect(await editor.selected(), 'drawn, a reorder: held').toEqual(['b', 'c', 'e']);
    await page.mouse.up();
    await editor.settle();
    expect(await editor.selected(), 'drawn, a reorder').toEqual(['b', 'c', 'e']);

    // The reader's own undo with the button down is no peer's update: it
    // ends the drag as it always did (P17), and so it stays.
    await editor.load({ doc: 'five', toolbar: 0 });
    await editor.clickAt('e', 7);
    await editor.type('!');
    const start = await editor.pointAt(editor.content('b'), 0);
    const end = await editor.pointAt(editor.content('c'), 5);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 2, start.y);
    await page.keyboard.press(`${MOD}+z`);
    expect((await editor.texts())[4]).toBe('Block E');
    await page.mouse.move(end.x, end.y, { steps: 10 });
    await page.mouse.up();
    await editor.settle();
    expect(await editor.selected(), 'an undo').toEqual([]);
  });

  /*
   * Review 2 of round 14, m6 and its siblings. A drag given back over a
   * peer's update is the drag it was: held across blocks, the same blocks
   * are selected and focus is where it is with no peer at all. Every
   * update ends the drag first and marks the gesture as over, which arms
   * the check that takes a stray caret out while the button is down; a
   * drag given back and left so marked had the caret WebKit's own drag
   * keeps in the block under the pointer taken out as it appeared, and
   * focus put on the root in the middle of the drag. Each way a drag is
   * given back: the browser's own redrawn in the block a peer edited, one
   * the editor draws (back in its own block after crossing), and one
   * across blocks.
   */
  test('P17d5 a drag given back over a peer’s update is held as it is with no peer', async ({
    editor,
    page,
  }) => {
    const held = () =>
      page.evaluate(() => {
        const ed = window.__e2e.editor;
        const active = document.activeElement;
        const block = active?.closest('[data-block-id]')?.getAttribute('data-block-id');
        return {
          selected: ed.getSelectedBlocks(),
          focus: active === ed.element ? 'the root' : (block ?? active?.tagName ?? 'none'),
        };
      });
    const peer = (index: number) =>
      page.evaluate((index) => {
        const ed = window.__e2e.editor;
        const blocks = ed.getDocument().blocks;
        blocks[index]!.content = [...blocks[index]!.content, { text: '!' }];
        ed.setDocument({ blocks });
      }, index);

    for (const gesture of ['redrawn in its block', 'back in its block', 'across blocks'] as const) {
      const seen: (typeof held extends () => Promise<infer State> ? State : never)[] = [];

      for (const update of [false, true]) {
        await editor.load({ doc: 'five', toolbar: 0 });
        const start = await editor.pointAt(editor.content('b'), 2);
        const inside = await editor.pointAt(editor.content('b'), 5);
        const next = await editor.pointAt(editor.content('c'), 5);
        const last = await editor.pointAt(editor.content('d'), 5);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + 2, start.y);

        if (gesture === 'redrawn in its block') {
          if (update) await peer(1);
        } else if (gesture === 'back in its block') {
          await page.mouse.move(next.x, next.y, { steps: 6 });
          expect(await editor.selected(), gesture).toEqual(['b', 'c']);
          await page.mouse.move(inside.x, inside.y, { steps: 6 });
          expect(await editor.selected(), gesture).toEqual([]);
          if (update) await peer(4);
        } else {
          await page.mouse.move(next.x, next.y, { steps: 6 });
          expect(await editor.selected(), gesture).toEqual(['b', 'c']);
          if (update) await peer(4);
        }

        await page.mouse.move(last.x, last.y, { steps: 8 });
        await editor.settle();
        seen.push(await held());
        await page.mouse.up();
        await editor.settle();
        expect(await editor.selected(), gesture).toEqual(['b', 'c', 'd']);
      }

      expect(seen[0]!.selected, gesture).toEqual(['b', 'c', 'd']);
      expect(seen[1], gesture).toEqual(seen[0]);
    }
  });

  /*
   * R14-PTR-5, p12's literal case: `?doc=long`, a drag from p1 into p3 (a
   * block selection), a peer's `setDocument` editing p15, and the drag on to
   * p6. The update ended the drag (`#endTextDrag`), which stopped following
   * the pointer: p1-p3 at the release, in every engine. A drag across
   * blocks goes on over an update that leaves the shown blocks in their
   * order, its own among them -- an edit to its own block too, whose
   * press is carried by the text around it, so a drag back into that block
   * is a text range from the press again. A reorder still ends it: it
   * selected against the new order (`reorder-other`, the control). And the
   * pointer at rest: held at the window's bottom edge, the drag scrolls and
   * selects on animation frames with no move at all, and goes on doing so
   * after the update -- given the drag back but not the scroll, the
   * selection stood still until the hand moved.
   */
  test('P17d2 a drag across blocks goes on over a peer’s edit that keeps the order', async ({
    editor,
    page,
  }) => {
    for (const peer of [
      'far',
      'own',
      'own, back into it',
      'own, replaced whole',
      'reorder-other',
    ] as const) {
      await editor.load({ doc: 'long', toolbar: 0 });
      const press = await editor.pointAt(editor.content('p1'), 5);
      const via = await editor.pointAt(editor.content('p3'), 8);
      await page.mouse.move(press.x, press.y);
      await page.mouse.down();
      await page.mouse.move(press.x - 1, press.y);
      await page.mouse.move(via.x, via.y, { steps: 10 });
      expect(await editor.selected(), peer).toEqual(['p1', 'p2', 'p3']);
      await page.evaluate((peer) => {
        const ed = window.__e2e.editor;
        const blocks = ed.getDocument().blocks;
        if (peer === 'far') blocks[15]!.content = [{ text: 'peer typed here' }];
        else if (peer === 'reorder-other') blocks.splice(30, 0, ...blocks.splice(20, 1));
        else if (peer === 'own, replaced whole') blocks[1]!.content = [{ text: 'Other words' }];
        else blocks[1]!.content = [{ text: `XX ${blocks[1]!.content[0]!.text}` }];
        ed.setDocument({ blocks });
      }, peer);
      if (peer === 'own, back into it') {
        // "XX " went in before the press: from 8, the press's own place.
        const back = await editor.pointAt(editor.content('p1'), 14);
        await page.mouse.move(back.x, back.y, { steps: 10 });
        await page.mouse.up();
        await editor.settle();
        expect(await editor.selected(), peer).toEqual([]);
        expect(await editor.selection(), peer).toMatchObject({
          blockId: 'p1',
          range: { start: 8, end: 14 },
        });
        continue;
      }
      const to = await editor.pointAt(editor.content('p6'), 8);
      await page.mouse.move(to.x, to.y, { steps: 10 });
      await page.mouse.up();
      await editor.settle();
      expect(await editor.selected(), peer).toEqual(
        peer === 'reorder-other' ? ['p1', 'p2', 'p3'] : ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
      );
    }

    // By word: "number" of p1 double-clicked and dragged into p3, the peer's
    // "XX " put in front of p1, and back into p1 over "Paragraph". The word
    // is carried with the press ([10,16] to [13,19]), so the drag back is
    // by word from it: "Paragraph number". Dropped, it went by character
    // from the press.
    await editor.load({ doc: 'long', toolbar: 0 });
    const word = await editor.pointAt(editor.content('p1'), 12);
    const third = await editor.pointAt(editor.content('p3'), 8);
    await page.mouse.click(word.x + 2, word.y);
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.move(word.x + 3, word.y);
    await page.mouse.move(third.x, third.y, { steps: 10 });
    expect(await editor.selected(), 'by word').toEqual(['p1', 'p2', 'p3']);
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const blocks = ed.getDocument().blocks;
      blocks[1]!.content = [{ text: `XX ${blocks[1]!.content[0]!.text}` }];
      ed.setDocument({ blocks });
    });
    const paragraph = await editor.pointAt(editor.content('p1'), 6);
    await page.mouse.move(paragraph.x + 2, paragraph.y, { steps: 10 });
    await page.mouse.up();
    await editor.settle();
    expect(await editor.selected(), 'by word').toEqual([]);
    expect(await editor.selection(), 'by word').toMatchObject({
      blockId: 'p1',
      range: { start: 3, end: 19 },
    });

    // Nothing carries a press there is none of: a drag begun on a divider
    // ("hr", down to p2) goes on across blocks over a peer's edit all the
    // same -- up to p1 after it. (So does one whose own text the peer
    // replaced whole, above: its press has no place in the new text, and
    // the blocks are still the blocks.)
    await editor.load({ doc: 'divider', toolbar: 0 });
    const rule = (await editor.block('hr').boundingBox())!;
    const below = await editor.pointAt(editor.content('p2'), 3);
    await page.mouse.move(rule.x + 80, rule.y + rule.height / 2);
    await page.mouse.down();
    await page.mouse.move(rule.x + 79, rule.y + rule.height / 2);
    await page.mouse.move(below.x, below.y, { steps: 8 });
    expect(await editor.selected(), 'from a divider').toEqual(['hr', 'p2']);
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const blocks = ed.getDocument().blocks;
      blocks[2]!.content = [{ text: 'peer typed here' }];
      ed.setDocument({ blocks });
    });
    const above = await editor.pointAt(editor.content('p1'), 3);
    await page.mouse.move(above.x, above.y, { steps: 8 });
    await page.mouse.up();
    await editor.settle();
    expect(await editor.selected(), 'from a divider').toEqual(['p1', 'hr']);

    // Held at the bottom edge, the peer's far edit at once, and no move
    // after it: the frames alone go on selecting.
    await editor.load({ doc: 'long', toolbar: 0 });
    const press = await editor.pointAt(editor.content('p1'), 5);
    await page.mouse.move(press.x, press.y);
    await page.mouse.down();
    await page.mouse.move(press.x - 1, press.y);
    await page.mouse.move(press.x, page.viewportSize()!.height - 3, { steps: 10 });
    const held = await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const blocks = ed.getDocument().blocks;
      blocks[58]!.content = [{ text: 'peer typed here' }];
      ed.setDocument({ blocks });
      return ed.getSelectedBlocks().length;
    });
    expect(held, 'held at the edge').toBeLessThan(50);
    await expect
      .poll(async () => (await editor.selected()).length, { message: 'held at the edge' })
      .toBeGreaterThan(held + 5);
    await page.mouse.up();
  });

  /*
   * R14-FX-1, the fixer's p3-overlay cases: "alpha one\nbravo two\ngamma
   * three\ndelta four" with something of the page's own drawn over its
   * second line (a sticky bar), and a drag the editor draws carried up
   * under it. The caret under the pointer misses the host there -- the bar
   * is hit, and it is no portal of the editor's to ask past -- and the
   * range collapsed to its anchor: placed [23,32] released [32,32], a
   * double-clicked word's [26,37] its own word, in every engine and mount.
   * The range drawn stays as it is, drawn again to the caret found last --
   * under the pointer, or where a peer's update left the range, for a
   * pointer taken straight from the update under the bar (the browser's
   * own drag goes on moving it there otherwise, from the anchor it
   * reports). Every kind of drag the editor draws: one it placed (a press
   * in the gutter), one a peer's update gave back by character and by
   * word, each way, a word's and a paragraph's back from another block, a
   * Shift press's back from another block. The browser's own drag under
   * the same bar differs by engine and mount -- Chromium's and Safari's
   * read the text under the bar, and Firefox's in a shadow root; in a
   * plain page Firefox leaves the range where it was -- and is not
   * asserted. Hit testing: e2e.
   */
  test('P17c3 a drag the editor draws keeps its range under something the page draws over the text', async ({
    editor,
    page,
  }) => {
    const text = 'alpha one\nbravo two\ngamma three\ndelta four';
    const peer = () =>
      page.evaluate(() => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks[1]!.content = [{ text: `${doc.blocks[1]!.content[0]!.text} peer` }];
        ed.setDocument(doc);
      });

    for (const mount of ['plain', 'shadow'] as const) {
      for (const mode of [
        'placed',
        'placed, out and back at once',
        'peer',
        'peer, at once',
        'word, peer, at once',
        'word forward, peer, at once',
        'word',
        'paragraph',
        'shift',
      ] as const) {
        const label = `${mount}, ${mode}`;
        await editor.load({ doc: 'paragraphs', toolbar: 0, mount });
        // The bar: over the second line -- or the fourth, for the drag
        // that goes down the block.
        const barred = mode === 'word forward, peer, at once' ? 32 : 10;
        const at = await page.evaluate(
          ({ text, barred }) => {
            const ed = window.__e2e.editor;
            const doc = ed.getDocument();
            doc.blocks[1]!.content = [{ text }];
            ed.setDocument(doc);
            const content = (id: string) =>
              ed.element.querySelector<HTMLElement>(
                `[data-block-id="${id}"] .neditor-block__content`,
              )!;
            const host = content('p2');
            const box = (offset: number) => {
              const range = host.ownerDocument.createRange();
              range.setStart(host.firstChild!, offset);
              range.setEnd(host.firstChild!, offset + 1);
              return range.getBoundingClientRect();
            };
            const point = (offset: number, across = 0.5) => {
              const b = box(offset);
              return { x: b.left + b.width * across, y: (b.top + b.bottom) / 2 };
            };
            // Across the page, in the page.
            const line = box(barred);
            const bar = document.createElement('div');
            bar.style.cssText = `position:fixed;left:0;right:0;top:${line.top}px;height:${line.height}px;background:#f002;z-index:5`;
            document.body.append(bar);
            const below = content('p3').getBoundingClientRect();
            return {
              left: host.getBoundingClientRect().left,
              barY: (line.top + line.bottom) / 2,
              third: point(20).y,
              fourth: point(32).y,
              bravo: point(12),
              gamma: point(22),
              three: point(28),
              delta: point(34),
              line3: point(26, 0.25),
              line4: point(38, 0.25),
              belowY: (below.top + below.bottom) / 2,
            };
          },
          { text, barred },
        );
        // Where each drag is when it goes under the bar, straight up.
        let under = at.left + 30;

        if (mode === 'placed' || mode === 'placed, out and back at once') {
          await page.mouse.move(at.left - 6, at.fourth);
          await page.mouse.down();
          await page.mouse.move(at.left - 7, at.fourth);
          await page.mouse.move(under, at.third, { steps: 6 });
          // Out into the next block and straight back under the bar: the
          // range it drew before it left is not its range any more. No
          // caret is found, and the caret is the press's own place, 32 --
          // drawn to the caret it found before leaving, [23,32] came back.
          if (mode !== 'placed') {
            await page.mouse.move(under, at.belowY, { steps: 8 });
            expect(await editor.selected(), label).toEqual(['p2', 'p3']);
          }
        } else if (mode === 'peer' || mode === 'peer, at once') {
          await page.mouse.move(at.line4.x, at.line4.y);
          await page.mouse.down();
          await page.mouse.move(at.line4.x - 1, at.line4.y);
          await page.mouse.move(under, at.third, { steps: 6 });
          await editor.settle();
          await peer();
          // On along the line first, or straight under the bar from the
          // update: the drag the editor was just given has found no caret
          // of its own yet, and the range is drawn again as it was carried.
          // Left to stand, the browser's own drag went on with it from the
          // anchor it reports, and WebKit's in a shadow root released
          // [14,23] for [23,38].
          if (mode === 'peer') {
            under += 8;
            await page.mouse.move(under, at.third, { steps: 3 });
          }
        } else if (mode === 'word, peer, at once') {
          // The same by word: "delta" double-clicked and dragged back to
          // "three", the browser's own drag until the update.
          await page.mouse.click(at.delta.x, at.delta.y);
          await page.mouse.down({ clickCount: 2 });
          await page.mouse.move(at.delta.x - 1, at.delta.y);
          await page.mouse.move(at.three.x, at.three.y, { steps: 6 });
          await editor.settle();
          await peer();
          under = at.three.x;
        } else if (mode === 'word forward, peer, at once') {
          // And down the block: "bravo" to "gamma", the bar over the line
          // below.
          await page.mouse.click(at.bravo.x, at.bravo.y);
          await page.mouse.down({ clickCount: 2 });
          await page.mouse.move(at.bravo.x + 1, at.bravo.y);
          await page.mouse.move(at.gamma.x, at.gamma.y, { steps: 6 });
          await editor.settle();
          await peer();
          under = at.gamma.x;
        } else if (mode === 'word' || mode === 'paragraph') {
          const clicks = mode === 'word' ? 2 : 3;
          for (let click = 1; click < clicks; click += 1) {
            await page.mouse.click(at.delta.x, at.delta.y, { clickCount: click });
          }
          await page.mouse.down({ clickCount: clicks });
          await page.mouse.move(at.delta.x - 1, at.delta.y);
          await page.mouse.move(at.three.x, at.belowY, { steps: 8 });
          await page.mouse.move(at.three.x, at.three.y, { steps: 8 });
          under = at.three.x;
        } else {
          await page.mouse.click(at.line4.x, at.line4.y);
          await page.keyboard.down('Shift');
          await page.mouse.move(at.line3.x, at.line3.y);
          await page.mouse.down();
          await page.mouse.move(at.line3.x - 1, at.line3.y);
          await page.mouse.move(under, at.belowY, { steps: 8 });
          await page.mouse.move(at.line3.x, at.line3.y, { steps: 8 });
          under = at.line3.x - 1;
        }

        await editor.settle();
        // "three delta" for the word drag still the browser's own at the
        // update, whatever it reads as just then: between its moves
        // WebKit's backward word drag reports the range without the word
        // that was double-clicked, [26,32].
        const drawn =
          mode === 'word, peer, at once'
            ? { start: 26, end: 37 }
            : mode === 'word forward, peer, at once'
              ? { start: 10, end: 25 }
              : mode === 'placed, out and back at once'
                ? { start: 32, end: 32 }
                : (await editor.selection())?.range;
        expect(drawn, `${label}: before the bar`).toBeDefined();
        if (mode !== 'placed, out and back at once') {
          expect(drawn!.end - drawn!.start, `${label}: before the bar`).toBeGreaterThan(4);
        }
        // (At once is in one move: on the way there, any step still on the
        // third line finds a caret.)
        await page.mouse.move(under, at.barY, { steps: mode.endsWith('at once') ? 1 : 6 });
        await editor.settle();
        const held = (await editor.selection())?.range;
        await page.mouse.up();
        if (mode === 'shift') await page.keyboard.up('Shift');
        await editor.settle();
        const released = (await editor.selection())?.range;

        expect(held, `${label}: under the bar`).toEqual(drawn);
        expect(released, `${label}: released`).toEqual(drawn);
        expect(await editor.selected(), label).toEqual([]);
      }
    }
  });

  /*
   * R14-FX-2, the fixer's p5b case: a drag the editor draws through one
   * block taller than the window -- a press in the gutter beside its third
   * line -- held at the window's bottom edge scrolls and selects on
   * animation frames, with no move at all. A peer's update gave the drag
   * back (`#resumeTextDrag`) but not the scroll it had stopped, so the
   * selection stood still until the hand moved: 375px and [.., 3762] for
   * half a second where the same drag with no peer reached 1065px and
   * 6410. An edit to another block, and one to the tall block itself. The
   * frames and the edge band: e2e.
   */
  test('P17d3 a drag the editor draws, held at the window’s edge, goes on scrolling over a peer’s edit', async ({
    editor,
    page,
  }) => {
    const long = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(200);
    for (const edit of ['another block', 'its own block'] as const) {
      await editor.load({ doc: 'long', toolbar: 0 });
      await page.evaluate((long) => {
        const ed = window.__e2e.editor;
        const blocks = ed.getDocument().blocks;
        blocks[3]!.content = [{ text: long }];
        ed.setDocument({ blocks });
      }, long);
      const host = (await editor.content('p3').boundingBox())!;
      // Beside its third line: the gutter's own controls sit beside the first.
      await page.mouse.move(host.x - 6, host.y + 62);
      await page.mouse.down();
      await page.mouse.move(host.x - 7, host.y + 62);
      await page.mouse.move(host.x + 200, 600, { steps: 8 });
      await page.mouse.move(host.x + 200, page.viewportSize()!.height - 3, { steps: 6 });
      const held = await page.evaluate((edit) => {
        const ed = window.__e2e.editor;
        const blocks = ed.getDocument().blocks;
        const index = edit === 'another block' ? 50 : 3;
        blocks[index]!.content = [{ text: `${blocks[index]!.content[0]!.text} peer` }];
        ed.setDocument({ blocks });
        return { end: ed.getSelectionState()?.range.end ?? -1, y: window.scrollY };
      }, edit);
      expect(held.end, edit).toBeGreaterThan(0);
      expect(held.end, edit).toBeLessThan(long.length - 4000);
      await expect
        .poll(async () => (await editor.selection())?.range.end ?? -1, { message: edit })
        .toBeGreaterThan(held.end + 1000);
      expect(await page.evaluate(() => window.scrollY), edit).toBeGreaterThan(held.y + 200);
      await page.mouse.up();
    }

    // What is given back is what was there: a press that landed inside the
    // edge band does not scroll until the pointer moves past it towards the
    // edge (P18), and an update gives that back too. The press beside a
    // line 12px from the window's bottom, dragged along that line, a peer's
    // edit, and nothing scrolls -- given back as a pointer with no press to
    // hold it, it scrolled on at once. (No gutter: in Firefox the pointer
    // left resting at the window's edge by the drag above has it drawn
    // there at the load, and the press beside the text landed on its
    // handle.)
    await editor.load({ doc: 'long', toolbar: 0, dragHandles: 0 });
    await page.evaluate((long) => {
      const ed = window.__e2e.editor;
      const blocks = ed.getDocument().blocks;
      blocks[3]!.content = [{ text: long }];
      ed.setDocument({ blocks });
      // Firefox comes back to the same address where the drag above left it.
      window.scrollTo(0, 0);
    }, long);
    await editor.settle();
    const host = (await editor.content('p3').boundingBox())!;
    const low = page.viewportSize()!.height - 12;
    await page.mouse.move(host.x - 6, low);
    await page.mouse.down();
    await page.mouse.move(host.x - 7, low);
    await page.mouse.move(host.x + 120, low, { steps: 6 });
    await editor.settle();
    const pressed = await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const range = ed.getSelectionState()?.range;
      const blocks = ed.getDocument().blocks;
      blocks[50]!.content = [{ text: 'peer typed here' }];
      ed.setDocument({ blocks });
      return { y: window.scrollY, length: range ? range.end - range.start : -1 };
    });
    expect(pressed.length, 'a press in the band').toBeGreaterThan(4);
    for (let frame = 0; frame < 12; frame += 1) await editor.settle();
    expect(await page.evaluate(() => window.scrollY), 'a press in the band').toBe(pressed.y);
    await page.mouse.up();
  });

  /*
   * R14-FX-3, the fixer's p5-void-anchor cases: a drag across blocks whose
   * own block has no text to come back to -- begun on a divider or on a
   * picture, or left without its press by a peer's update (a table's cells
   * rebuilt, its own text replaced whole) -- carried back onto that block.
   * A drag back over a block with text is a text range from the press
   * again; with none, the drag did nothing there, and the blocks it had
   * last crossed stayed selected: "hr,p2" with the pointer back on the
   * rule. Back over its own block the selection is that block alone, and
   * moving away grows it again, either way. No offset is guessed. A
   * collapsed toggle as that block is one block to the reader, and its
   * hidden children go with it at the edit: Backspace takes them all.
   * `#blockIdAtY` is layout: e2e.
   */
  test('P17d4 a drag across blocks, back over its own block with no text to return to, selects that block alone', async ({
    editor,
    page,
  }) => {
    const centre = async (target: Locator, inset = 80) => {
      const box = (await target.boundingBox())!;
      return { x: box.x + Math.min(inset, box.width / 2), y: box.y + box.height / 2 };
    };
    const cell = (id: string, at: string) => editor.block(id).locator(`[data-cell="${at}"]`);

    for (const [shape, doc, press, away, edit, other, ids] of [
      ['a divider', 'divider', () => editor.block('hr'), 'p2', null, 'p1', ['p1', 'hr', 'p2']],
      [
        'a picture',
        'image',
        () => editor.block('img').locator('img'),
        'after',
        null,
        'before',
        ['before', 'img', 'after'],
      ],
      [
        'a table whose cells a peer rebuilt',
        'table',
        () => cell('tbl', '1:1'),
        'after',
        'row',
        'before',
        ['before', 'tbl', 'after'],
      ],
      [
        'a paragraph a peer replaced whole',
        'paragraphs',
        () => editor.content('p2'),
        'p3',
        'text',
        'p1',
        ['p1', 'p2', 'p3'],
      ],
      [
        'a collapsed toggle a peer replaced whole',
        'toggle-collapsed',
        () => editor.content('tg'),
        'after',
        'text',
        'before',
        ['before', 'tg', 'after'],
      ],
    ] as const) {
      await editor.load({ doc, toolbar: 0 });
      const own = ids[1];
      const start = await centre(press(), shape === 'a divider' || shape === 'a picture' ? 80 : 24);
      const there = await centre(editor.content(away), 24);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x - 1, start.y);
      await page.mouse.move(there.x, there.y, { steps: 8 });
      expect(await editor.selected(), shape).toEqual([own, ids[2]]);

      if (edit) {
        await page.evaluate(
          ({ edit, own }) => {
            const ed = window.__e2e.editor;
            const blocks = ed.getDocument().blocks;
            const block = blocks.find((candidate) => candidate.id === own)!;
            if (edit === 'row')
              block.rows!.push([[{ text: 'c1' }], [{ text: 'c2' }], [{ text: 'c3' }]]);
            else block.content = [{ text: 'Other words' }];
            ed.setDocument({ blocks });
          },
          { edit, own },
        );
      }

      // Back over its own block: that block alone.
      const back = await centre(press(), shape === 'a divider' || shape === 'a picture' ? 80 : 24);
      await page.mouse.move(back.x, back.y, { steps: 8 });
      await editor.settle();
      expect(await editor.selected(), `${shape}: back over it`).toEqual([own]);
      // Selected once, not at every move over it: a page listening to
      // `blockselection`, and the live region, hear it once.
      const heard = (await editor.events('blockselection')).length;
      await page.mouse.move(back.x + 6, back.y, { steps: 3 });
      await page.mouse.move(back.x, back.y, { steps: 3 });
      expect((await editor.events('blockselection')).length, `${shape}: once`).toBe(heard);
      // Away again, each way.
      const again = await centre(editor.content(away), 24);
      await page.mouse.move(again.x, again.y, { steps: 8 });
      expect(await editor.selected(), `${shape}: away again`).toEqual([own, ids[2]]);
      const up = await centre(editor.content(other), 24);
      await page.mouse.move(up.x, up.y, { steps: 8 });
      expect(await editor.selected(), `${shape}: the other way`).toEqual([ids[0], own]);
      const home = await centre(press(), shape === 'a divider' || shape === 'a picture' ? 80 : 24);
      await page.mouse.move(home.x, home.y, { steps: 8 });
      await page.mouse.up();
      await editor.settle();
      expect(await editor.selected(), `${shape}: released on it`).toEqual([own]);
      // And no caret in it. (Asked at the release: while the button is
      // down WebKit's own drag paints a range in a rebuilt table's new
      // cells, which the release takes out, as after any drag across
      // blocks.)
      expect(await editor.selection(), `${shape}: released on it`).toBeNull();

      if (doc === 'toggle-collapsed') {
        await page.keyboard.press('Backspace');
        expect(await editor.ids(), shape).toEqual(['before', 'after']);
      }
    }

    // The control: a block with text to come back to is a text range again.
    await editor.load({ doc: 'toggle-collapsed', toolbar: 0 });
    const head = await editor.pointAt(editor.content('tg'), 2);
    const after = await centre(editor.content('after'), 24);
    await page.mouse.move(head.x, head.y);
    await page.mouse.down();
    await page.mouse.move(head.x - 1, head.y);
    await page.mouse.move(after.x, after.y, { steps: 8 });
    expect(await editor.selected()).toEqual(['tg', 'after']);
    const word = await editor.pointAt(editor.content('tg'), 6);
    await page.mouse.move(word.x, word.y, { steps: 8 });
    await page.mouse.up();
    await editor.settle();
    expect(await editor.selected()).toEqual([]);
    expect(await editor.selection()).toMatchObject({ blockId: 'tg', range: { start: 2, end: 6 } });
  });

  /*
   * R14-RV1-2, the reviewer's b1 / b2 cases: a drag the editor draws (a
   * press in the gutter) through one block taller than the window, carried
   * out past the window's edge and held there. The caret under the pointer
   * was asked for at a point pulled into the block's box -- below the
   * window, for a block that goes on below it -- where no hit test
   * answers: it missed on every move, and the range stood still (collapsed,
   * until round 14) while the edge autoscroll ran on, [23,698] for
   * [23,1658]. The point is pulled into the part of the block its own
   * window shows: the bottom edge, the top edge, and an iframe mount's own
   * window. Firefox is not driven: Playwright's Firefox does not deliver a
   * move outside the window at its own place (round 13's build and this
   * one both end on the blocks at the top of the document).
   */
  test('P17c4 a drag the editor draws, carried out of the window through a tall block, goes on selecting', async ({
    editor,
    page,
    browserName,
  }) => {
    test.skip(browserName === 'firefox', 'Playwright’s Firefox moves outside the window elsewhere');
    const tall = Array.from({ length: 160 }, (_, i) => `line ${i} of a tall block`).join('\n');

    // The block of three that is tall, the edge, where the page starts, and
    // how far the drag is to get: on by 400 characters, or -- for the first
    // and the last block, past whose own edge the pointer is carried -- to
    // the block's first line with the page at its top, and to its last.
    for (const [edge, block, down, scrolled, reach] of [
      ['bottom', 'p2', true, 0, 'on'],
      ['top', 'p2', false, 2000, 'on'],
      ['iframe bottom', 'p2', true, 0, 'on'],
      ['first block, top', 'p1', false, 1500, 'start'],
      ['last block, bottom', 'p3', true, 600, 'end'],
    ] as const) {
      await editor.load({
        doc: 'paragraphs',
        toolbar: 0,
        ...(edge === 'iframe bottom' ? { mount: 'iframe' as const } : {}),
      });
      const at = await page.evaluate(
        ({ tall, block, scrolled }) => {
          const ed = window.__e2e.editor;
          const doc = ed.getDocument();
          doc.blocks.find((candidate) => candidate.id === block)!.content = [{ text: tall }];
          ed.setDocument(doc);
          const view = ed.element.ownerDocument.defaultView!;
          view.scrollTo(0, scrolled);
          const host = ed.element.querySelector(
            `[data-block-id="${block}"] .neditor-block__content`,
          )!;
          const box = host.getBoundingClientRect();
          const frame = view.frameElement?.getBoundingClientRect();
          // The frame's 1px border.
          const [fx, fy] = frame ? [frame.left + 1, frame.top + 1] : [0, 0];
          return { left: box.left + fx, top: fy, height: view.innerHeight };
        },
        { tall, block, scrolled },
      );
      const state = () =>
        page.evaluate(() => {
          const ed = window.__e2e.editor;
          const range = ed.getSelectionState()?.range;
          return {
            start: range?.start ?? -1,
            end: range?.end ?? -1,
            length: range ? range.end - range.start : -1,
            y: ed.element.ownerDocument.defaultView!.scrollY,
          };
        });
      const y0 = at.top + 200;
      await page.mouse.move(at.left - 6, y0);
      await page.mouse.down();
      await page.mouse.move(at.left - 7, y0);
      await page.mouse.move(at.left + 80, y0 + (down ? 60 : -60), { steps: 5 });
      await page.mouse.move(at.left + 80, down ? at.top + at.height - 30 : at.top + 30, {
        steps: 6,
      });
      await editor.settle();
      const inside = (await state()).length;
      expect(inside, edge).toBeGreaterThan(40);
      await page.mouse.move(at.left + 80, down ? at.top + at.height + 40 : at.top - 40, {
        steps: 6,
      });

      if (reach === 'on') {
        await expect
          .poll(async () => (await state()).length, { message: edge })
          .toBeGreaterThan(inside + 400);
      } else if (reach === 'start') {
        // "line 0 of a tall block" is 22 characters.
        await expect.poll(async () => (await state()).y, { message: edge }).toBe(0);
        await expect.poll(async () => (await state()).start, { message: edge }).toBeLessThan(23);
      } else {
        await expect
          .poll(async () => (await state()).end, { message: edge })
          .toBeGreaterThan(tall.length - 23);
      }

      await page.mouse.up();
      await editor.settle();
      expect((await state()).length, edge).toBeGreaterThan(inside + 400);
      expect(await editor.selected(), edge).toEqual([]);
    }
  });

  /*
   * R14-RV2-2, the reviewer's st2 / st3 cases: the same drag past an edge
   * that is inside the window -- the edge of a scroller the editor is in
   * (the page's own pane, 420px), and of the modal dialog of a dialog
   * mount, which scrolls itself. The point asked was pulled into the
   * window, not into what the scroller shows of the block, so past the
   * pane's edge the hit test missed the text the pane had clipped away, the
   * range stood still, and -- since a drag that misses does not scroll
   * (R14-RV1-3) -- so did the pane, 24 to 93px in. The point is pulled into
   * what can be seen: the window cut by every scroller that clips the
   * editor, inside its border. Driven in every engine, the window never
   * left -- and what fails where, measured by taking each part out: the
   * cut at the pane's bottom edge in all three; the cut at its top edge,
   * and the border (30px here, top and bottom) kept out of what shows, in
   * Chromium only -- Firefox and WebKit answer a point on a pane's border
   * with the text inside it, and need neither.
   */
  test('P17c7 a drag the editor draws, carried past the edge of a scroller, goes on selecting', async ({
    editor,
    page,
  }) => {
    const tall = Array.from({ length: 160 }, (_, i) => `line ${i} of a tall block`).join('\n');

    for (const [edge, block, down, scrolled, reach] of [
      ['a pane, bottom', 'p2', true, 100, 'on'],
      ['a pane, the first block, top', 'p1', false, 1500, 'start'],
      ['a pane, the last block, bottom', 'p3', true, 600, 'end'],
      ['a dialog, the last block, bottom', 'p3', true, 300, 'end'],
    ] as const) {
      const dialog = edge.startsWith('a dialog');
      await editor.load({
        doc: 'paragraphs',
        toolbar: 0,
        ...(dialog ? { mount: 'dialog' as const } : {}),
      });
      const at = await page.evaluate(
        ({ tall, block, scrolled, dialog }) => {
          const ed = window.__e2e.editor;
          const doc = ed.getDocument();
          doc.blocks.find((candidate) => candidate.id === block)!.content = [{ text: tall }];
          ed.setDocument(doc);
          const pane = document.querySelector<HTMLElement>(dialog ? 'dialog' : '#stage')!;
          if (!dialog) {
            // A border as thick as a line and more: a point on it is no
            // point of the text.
            pane.style.cssText =
              'height:420px;overflow:auto;border:30px solid #36c;margin-top:90px';
          }
          pane.scrollTop = scrolled;
          const host = ed.element.querySelector(
            `[data-block-id="${block}"] .neditor-block__content`,
          )!;
          const box = pane.getBoundingClientRect();
          return {
            left: host.getBoundingClientRect().left,
            // Inside the pane's border, where it shows the text; and its
            // box, border and all.
            top: box.top + pane.clientTop,
            bottom: Math.min(box.top + pane.clientTop + pane.clientHeight, window.innerHeight),
            outerTop: box.top,
            outerBottom: Math.min(box.bottom, window.innerHeight),
          };
        },
        { tall, block, scrolled, dialog },
      );
      const state = () =>
        page.evaluate((dialog) => {
          const range = window.__e2e.editor.getSelectionState()?.range;
          return {
            start: range?.start ?? -1,
            end: range?.end ?? -1,
            length: range ? range.end - range.start : -1,
            top: document.querySelector(dialog ? 'dialog' : '#stage')!.scrollTop,
          };
        }, dialog);
      const y0 = dialog ? at.top + 300 : (at.top + at.bottom) / 2;
      await page.mouse.move(at.left - 6, y0);
      await page.mouse.down();
      await page.mouse.move(at.left - 7, y0);
      await page.mouse.move(at.left + 80, y0 + (down ? 60 : -60), { steps: 5 });
      await page.mouse.move(at.left + 80, down ? at.bottom - 30 : at.top + 30, { steps: 6 });
      await editor.settle();
      const inside = (await state()).length;
      expect(inside, edge).toBeGreaterThan(40);
      // Past the pane's edge, border and all, in the window still: 40px,
      // or what the window has left below a dialog that fills it.
      const past = down
        ? Math.min(at.outerBottom + 40, page.viewportSize()!.height - 2)
        : Math.max(at.outerTop - 40, 2);
      await page.mouse.move(at.left + 80, past, { steps: 6 });

      if (reach === 'on') {
        await expect
          .poll(async () => (await state()).length, { message: edge })
          .toBeGreaterThan(inside + 400);
      } else if (reach === 'start') {
        await expect.poll(async () => (await state()).top, { message: edge }).toBe(0);
        await expect.poll(async () => (await state()).start, { message: edge }).toBeLessThan(23);
      } else {
        await expect
          .poll(async () => (await state()).end, { message: edge, timeout: 10_000 })
          .toBeGreaterThan(tall.length - 23);
      }

      await page.mouse.up();
      await editor.settle();
      expect(await editor.selected(), edge).toEqual([]);
    }
  });

  /*
   * R14-RV3-1 and R14-RV3-5, the reviewer's s1 / s2 cases: the pane that
   * scrolls the editor drawn at another size -- `transform: scale(1.5)`,
   * `zoom: 0.6` -- so its box on screen is not its layout box. What can be
   * seen of a block was measured with the pane's client sizes, which are
   * layout pixels, added to a box in drawn ones. Drawn larger, the lower
   * third of the pane counted as out of sight: a press beside the text
   * there put the caret one to four lines above the pointer (line 23 for
   * 24 and for 26), a placed drag ended [374,542] for [374,614], and the
   * press scrolled the pane 26px to show a caret that was on screen (62
   * and 134px before round 14). Drawn smaller, the edge of what shows was
   * taken to be past the pane's, and the drag carried past it stood still
   * again, [374,781] at 170px (R14-RV2-2). The pane's client box is
   * measured as it is drawn.
   */
  test('P17c9 in a pane drawn at another size a press and a drag land under the pointer', async ({
    editor,
    page,
  }) => {
    const tall = Array.from({ length: 160 }, (_, i) => `line ${i} of a tall block`).join('\n');
    // `low`: in a page that scrolls, the pane's bottom edge 4px off the
    // window's.
    const arrange = async (css: string, scrollTop: number, low = false) => {
      await editor.load({ doc: 'paragraphs', toolbar: 0, ...(low ? { scroll: true } : {}) });
      return page.evaluate(
        ({ tall, css, scrollTop, low }) => {
          const ed = window.__e2e.editor;
          const blocks = ed.getDocument().blocks.slice(0, 3);
          blocks[1]!.content = [{ text: tall }];
          ed.setDocument({ blocks });
          const stage = document.querySelector<HTMLElement>('#stage')!;
          stage.style.cssText = css;
          if (low) {
            stage.style.marginTop = `${window.innerHeight - 4 - stage.getBoundingClientRect().bottom}px`;
          }
          stage.scrollTop = scrollTop;
          const host = ed.element.querySelector('[data-block-id="p2"] .neditor-block__content')!;
          const box = stage.getBoundingClientRect();
          const drawn = box.height / stage.offsetHeight;
          return {
            left: host.getBoundingClientRect().left,
            // The pane's client box, as it is drawn.
            top: box.top + stage.clientTop * drawn,
            height: stage.clientHeight * drawn,
            bottom: box.bottom,
          };
        },
        { tall, css, scrollTop, low },
      );
    };
    // The line of p2 the browser's own hit test finds at a point of its text.
    const lineAt = (x: number, y: number) =>
      page.evaluate(
        ([x, y]) => {
          const position = document.caretPositionFromPoint?.(x!, y!);
          const range = position ? null : document.caretRangeFromPoint(x!, y!);
          const node = position?.offsetNode ?? range?.startContainer;
          const offset = position?.offset ?? range?.startOffset ?? 0;
          return node?.nodeType === 3
            ? node.textContent!.slice(0, offset).split('\n').length - 1
            : -1;
        },
        [x, y],
      );
    const focus = () =>
      page.evaluate(() => {
        const selection = getSelection()!;
        const node = selection.focusNode;
        return {
          line:
            node?.nodeType === 3
              ? node.textContent!.slice(0, selection.focusOffset).split('\n').length - 1
              : -1,
          scrolled: Math.round(document.querySelector('#stage')!.scrollTop),
        };
      });

    // Drawn one and a half times its size: a press beside the text in the
    // pane's lower third, and a placed drag down into it. And drawn taller
    // or wider only (`scale(1, 1.5)`, `scale(1.5, 1)`): up and down, it is
    // the drawn height to the layout height that scales the box, not the
    // width (the reviewer's C1 of round 14, review 4).
    for (const [down, scale] of [
      [0.75, '1.5'],
      [0.93, '1.5'],
      [0.75, '1, 1.5'],
      [0.93, '1, 1.5'],
      [0.75, '1.5, 1'],
      [0.93, '1.5, 1'],
    ] as const) {
      const pane = await arrange(
        `height:300px;overflow:auto;margin:0;max-width:600px;transform:scale(${scale});transform-origin:0 0`,
        400,
      );
      const y = pane.top + pane.height * down;
      const want = await lineAt(pane.left + 3, y);
      const label = `a press ${down} down a pane at scale(${scale})`;
      expect(want, label).toBeGreaterThan(20);
      await page.mouse.click(pane.left - 5, y);
      await editor.settle();
      expect(await focus(), label).toEqual({ line: want, scrolled: 400 });
    }

    let pane = await arrange(
      'height:300px;overflow:auto;margin:0;max-width:600px;transform:scale(1.5);transform-origin:0 0',
      400,
    );
    const from = pane.top + pane.height * 0.15;
    const to = pane.top + pane.height * 0.8;
    const want = await lineAt(pane.left + 3, to);
    await page.mouse.move(pane.left - 5, from);
    await page.mouse.down();
    await page.mouse.move(pane.left + 3, from + 8, { steps: 3 });
    await page.mouse.move(pane.left + 3, to, { steps: 10 });
    await editor.settle();
    expect(await focus(), 'a placed drag').toEqual({ line: want, scrolled: 400 });
    await page.mouse.up();

    // And where a caret does leave what the pane shows, the pane is
    // scrolled by what brings it back, in its own pixels: a caret on the
    // pane's last line but one, and Shift+Enter four times, each opening a
    // line below. Measured as drawn and scrolled unscaled, a pane at half
    // size moved half as far as the line had, and at one and a half, half
    // as far again.
    for (const [css, scale] of [
      [
        'height:600px;overflow:auto;margin:0;max-width:900px;transform:scale(0.5);transform-origin:0 0',
        0.5,
      ],
      [
        'height:300px;overflow:auto;margin:0;max-width:600px;transform:scale(1.5);transform-origin:0 0',
        1.5,
      ],
    ] as const) {
      pane = await arrange(css, 400, true);
      expect(await page.evaluate(() => window.scrollY), `drawn at ${scale}: the page`).toBe(0);
      await page.mouse.click(pane.left - 5, pane.top + pane.height * 0.93);
      await editor.settle();
      const start = (await focus()).scrolled;

      for (let press = 1; press <= 4; press += 1) {
        await page.keyboard.press('Shift+Enter');
        await editor.settle();
        // The caret's line, by its number: a caret on an empty line has no
        // box of its own in every engine.
        const caret = await page.evaluate(() => {
          const host = window.__e2e.editor.element.querySelector(
            '[data-block-id="p2"] .neditor-block__content',
          )!;
          const selection = getSelection()!;
          const text = host.textContent!;
          const range = document.createRange();
          range.selectNodeContents(host);
          range.setEnd(selection.focusNode!, selection.focusOffset);
          const line = range.toString().split('\n').length - 1;
          const box = host.getBoundingClientRect();
          const height = box.height / text.split('\n').length;
          return { bottom: box.top + (line + 1) * height, height };
        });
        const edge = pane.top + pane.height;
        const label = `drawn at ${scale}, Shift+Enter ${press}`;
        // (To half a line: it is the caret's own box that is brought in,
        // which is shorter than its line, by whole pixels of the pane's.)
        expect(caret.bottom, label).toBeLessThanOrEqual(edge + caret.height / 2);
        if (press > 2) expect(edge - caret.bottom, label).toBeLessThan(caret.height / 2);
      }

      expect((await focus()).scrolled, `drawn at ${scale}`).toBeGreaterThan(start + 40);
      // The page around the pane, which scrolls too, has nothing to bring
      // into view once the pane has: the caret is carried out to it by
      // what the pane moved as drawn.
      expect(await page.evaluate(() => window.scrollY), `drawn at ${scale}: the page`).toBe(0);

      // And up: the pane scrolled on by hand, the caret left above its top
      // edge, and one more line opened there.
      await page.evaluate(() => {
        document.querySelector('#stage')!.scrollTop += 800;
      });
      await page.keyboard.press('Shift+Enter');
      await editor.settle();
      const above = await page.evaluate(() => {
        const host = window.__e2e.editor.element.querySelector(
          '[data-block-id="p2"] .neditor-block__content',
        )!;
        const selection = getSelection()!;
        const range = document.createRange();
        range.selectNodeContents(host);
        range.setEnd(selection.focusNode!, selection.focusOffset);
        const line = range.toString().split('\n').length - 1;
        const box = host.getBoundingClientRect();
        const height = box.height / host.textContent!.split('\n').length;
        return { top: box.top + line * height, height };
      });
      expect(above.top, `drawn at ${scale}, up`).toBeGreaterThanOrEqual(
        pane.top - above.height / 2,
      );
      expect(above.top - pane.top, `drawn at ${scale}, up`).toBeLessThan(above.height / 2);
    }

    // Drawn larger, with a border as thick as a line: a placed drag carried
    // past the pane's top edge goes on selecting, to the block's first line.
    pane = await arrange(
      'height:300px;overflow:auto;border:30px solid #36c;margin:0;max-width:600px;transform:scale(1.5);transform-origin:0 0',
      1500,
    );
    const first = () =>
      page.evaluate(() => ({
        start: window.__e2e.editor.getSelectionState()?.range.start ?? -1,
        scrolled: document.querySelector('#stage')!.scrollTop,
      }));
    await page.mouse.move(pane.left - 5, pane.top + pane.height / 2);
    await page.mouse.down();
    await page.mouse.move(pane.left - 6, pane.top + pane.height / 2);
    await page.mouse.move(pane.left + 80, pane.top + pane.height / 2 - 40, { steps: 5 });
    await page.mouse.move(pane.left + 80, pane.top + 30, { steps: 6 });
    await editor.settle();
    const held = (await first()).start;
    expect(held, 'a thick border, drawn larger').toBeGreaterThan(400);
    // On the border, 15px into its 45.
    await page.mouse.move(pane.left + 80, pane.top - 15, { steps: 6 });
    await expect
      .poll(async () => (await first()).start, { message: 'a thick border, drawn larger' })
      .toBeLessThan(held - 400);
    await page.mouse.up();

    // Drawn at six tenths: a placed drag carried 40px past the pane's bottom
    // edge goes on selecting while the pane scrolls.
    pane = await arrange(
      'height:700px;overflow:auto;border:2px solid #36c;margin:60px 0 0 0;max-width:1000px;zoom:0.6',
      100,
    );
    const range = () =>
      page.evaluate(() => {
        const state = window.__e2e.editor.getSelectionState()?.range;
        return state ? state.end - state.start : -1;
      });
    const middle = pane.top + pane.height / 2;
    await page.mouse.move(pane.left - 5, middle);
    await page.mouse.down();
    await page.mouse.move(pane.left - 6, middle);
    await page.mouse.move(pane.left + 80, middle + 40, { steps: 5 });
    await page.mouse.move(pane.left + 80, pane.bottom - 30, { steps: 6 });
    await editor.settle();
    const inside = await range();
    expect(inside, 'drawn smaller').toBeGreaterThan(40);
    await page.mouse.move(pane.left + 80, pane.bottom + 40, { steps: 6 });
    await expect.poll(range, { message: 'drawn smaller' }).toBeGreaterThan(inside + 800);
    await page.mouse.up();
  });

  /*
   * R14-RV1-3, the reviewer's e1 / n1 cases: a page with a fixed header of
   * its own, 90px and above everything, and a drag the editor draws up
   * through one tall block, held under the header at the window's top edge.
   * The caret under the pointer misses there -- the header is hit -- so the
   * range stands as it was drawn (R14-FX-1); and the edge autoscroll ran on
   * all the same, and left the range 900 to 1,800px behind in 700 ms. While
   * that hit test misses the page does not scroll: it never scrolls away
   * from a range that cannot follow. With no header, the control, it
   * scrolls and selects; and carried from under the header to the window's
   * other edge, over text again, it scrolls again -- a miss is the last
   * move's, not the drag's.
   *
   * And the miss is not the editor's portals' to answer for. The format
   * toolbar is drawn above the range, under that header: nothing writes
   * `pointer-events` on any portal while the pointer is held over the place
   * -- every showing portal was taken out of the way on any miss, 73 to 75
   * writes in two thirds of a second; and asked of the portal's own tree
   * what is on top, Firefox answers for a shadow root with the topmost
   * element of that tree, the toolbar, whatever the page draws over it: 46
   * writes in a shadow root (R14-RV2-3). The page is asked, and the answer
   * followed into the shadow roots it names.
   */
  test('P17c5 a drag the editor draws does not scroll on under a header of the page’s', async ({
    editor,
    page,
  }) => {
    const tall = Array.from({ length: 160 }, (_, i) => `line ${i} of a tall block`).join('\n');

    for (const [label, header, mount] of [
      ['under a header', true, undefined],
      ['under a header, in a shadow root', true, 'shadow'],
      ['no header', false, undefined],
    ] as const) {
      await editor.load({ doc: 'paragraphs', ...(mount ? { mount } : {}) });
      const left = await page.evaluate(
        ({ tall, header }) => {
          const ed = window.__e2e.editor;
          const doc = ed.getDocument();
          doc.blocks[1]!.content = [{ text: tall }];
          ed.setDocument(doc);
          if (header) {
            const bar = document.createElement('div');
            bar.style.cssText =
              'position:fixed;left:0;right:0;top:0;height:90px;background:#222d;z-index:2147483647';
            document.body.append(bar);
          }
          window.scrollTo(0, 2500);
          const host = ed.element.querySelector('[data-block-id="p2"] .neditor-block__content')!;
          return host.getBoundingClientRect().left;
        },
        { tall, header },
      );
      await editor.settle();
      const state = () =>
        page.evaluate(() => ({
          y: window.scrollY,
          range: window.__e2e.editor.getSelectionState()?.range ?? null,
        }));
      const writes = () =>
        page.evaluate(
          () => (window as unknown as { __portalWrites: { writes: number } }).__portalWrites.writes,
        );
      await page.mouse.move(left - 6, 500);
      await page.mouse.down();
      await page.mouse.move(left - 7, 500);
      await page.mouse.move(left + 80, 300, { steps: 8 });
      await page.mouse.move(left + 80, 130, { steps: 6 });
      // Under the header, off the edge band still.
      await page.mouse.move(left + 80, 60, { steps: 6 });
      await editor.settle();
      const drawn = await state();
      expect(drawn.range, label).not.toBeNull();
      await expect(editor.portal('toolbar'), label).toBeVisible();
      await page.evaluate(() => {
        const count = { writes: 0 };
        (window as unknown as { __portalWrites: typeof count }).__portalWrites = count;
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            const element = record.target as HTMLElement;
            if (
              /pointer-events/.test(record.oldValue ?? '') ||
              element.style.getPropertyValue('pointer-events') !== ''
            ) {
              count.writes += 1;
            }
          }
        });
        // The page's tree and the editor's own, where its portals are.
        for (const tree of new Set([document.body, window.__e2e.editor.element.getRootNode()])) {
          observer.observe(tree, {
            subtree: true,
            attributes: true,
            attributeFilter: ['style'],
            attributeOldValue: true,
          });
        }
      });
      const toolbar = (await editor.portal('toolbar').boundingBox())!;

      if (header) {
        // Over the toolbar, where the header covers it.
        const over = { x: toolbar.x + toolbar.width / 2, y: Math.min(toolbar.y + 20, 84) };
        expect(over.y, label).toBeGreaterThan(toolbar.y);
        expect(over.y, label).toBeLessThan(toolbar.y + toolbar.height);
        await page.mouse.move(over.x, over.y, { steps: 5 });
        await page.mouse.move(over.x + 30, over.y, { steps: 10 });
        for (let frame = 0; frame < 6; frame += 1) await editor.settle();
        expect(await state(), label).toEqual(drawn);
        expect(await writes(), label).toBe(0);
        // And held at the window's very edge.
        await page.mouse.move(over.x + 30, 6, { steps: 4 });
        for (let frame = 0; frame < 12; frame += 1) await editor.settle();
        expect(await state(), label).toEqual(drawn);
        expect(await writes(), label).toBe(0);
        // Down to the other edge, over the text all the way.
        await page.mouse.move(left + 80, 300, { steps: 6 });
        await page.mouse.move(left + 80, page.viewportSize()!.height - 6, { steps: 6 });
        await expect.poll(async () => (await state()).y, { message: label }).toBeGreaterThan(2700);
      } else {
        // Clear of the toolbar, which is drawn up there too: under it, the
        // miss is asked past it, as it should be.
        const aside = toolbar.x + toolbar.width + 60;
        expect(aside, label).toBeLessThan(page.viewportSize()!.width - 20);
        await page.mouse.move(aside, 30, { steps: 3 });
        await page.mouse.move(aside, 6, { steps: 4 });
        await expect.poll(async () => (await state()).y, { message: label }).toBeLessThan(2200);
        expect((await state()).range!.start, label).toBeLessThan(drawn.range!.start - 200);
      }

      await page.mouse.up();
    }

    // Standing still is for the drag that missed, in the block it missed
    // in. Carried on out of that block it selects blocks, which no hit test
    // decides, and held at the window's edge it scrolls: a press on p5's
    // text, a peer's edit to p5 (the editor draws it from there), under a
    // bar of the page's over the start of the line, and down to the bottom
    // edge.
    await editor.load({ doc: 'long', toolbar: 0 });
    const line = (await editor.content('p5').boundingBox())!;
    await page.evaluate(
      ({ top, height, width }) => {
        const bar = document.createElement('div');
        bar.style.cssText = `position:fixed;left:0;width:${width}px;top:${top}px;height:${height}px;background:#f002;z-index:5`;
        document.body.append(bar);
      },
      { top: line.y, height: line.height, width: line.x + 60 },
    );
    const y = line.y + line.height / 2;
    await page.mouse.move(line.x + 120, y);
    await page.mouse.down();
    await page.mouse.move(line.x + 100, y, { steps: 3 });
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const blocks = ed.getDocument().blocks;
      blocks[5]!.content = [{ text: `${blocks[5]!.content[0]!.text} peer` }];
      ed.setDocument({ blocks });
    });
    await page.mouse.move(line.x + 80, y, { steps: 2 });
    await page.mouse.move(line.x + 30, y, { steps: 3 });
    await editor.settle();
    await page.mouse.move(line.x + 30, page.viewportSize()!.height - 3, { steps: 8 });
    const across = (await editor.selected()).length;
    expect(across, 'across blocks after a miss').toBeGreaterThan(5);
    await expect
      .poll(async () => (await editor.selected()).length, { message: 'across blocks after a miss' })
      .toBeGreaterThan(across + 5);
    await page.mouse.up();
  });

  /*
   * The reviewer's n3 case (round 14, review 2). The editor is in a frame
   * and its portals in the page that holds the frame -- `portalContainer`,
   * another document, with its own coordinates. A drag the editor draws
   * goes up under a bar of the frame's own page, where the hit test misses
   * at a point of the frame's; the same two numbers, read as a point of the
   * outer page, are inside the format toolbar drawn there. That toolbar is
   * not what is in the way: asked what the frame's point has on top, it
   * would be asked about a place the pointer is not at, and taken out of
   * the pointer's way for it. Only a portal of the host's own document is
   * asked.
   */
  test('P17c8 a miss in a frame is not asked of a toolbar the page outside it draws', async ({
    editor,
    page,
  }) => {
    const tall = Array.from({ length: 40 }, (_, i) => `line ${i} of a tall block`).join('\n');
    await page.setViewportSize({ width: 760, height: 700 });
    await editor.load({ doc: 'paragraphs', mount: 'iframe', portal: 'body', scroll: true });
    await page.evaluate((tall) => {
      const ed = window.__e2e.editor;
      const doc = ed.getDocument();
      doc.blocks[1]!.content = [{ text: tall }];
      ed.setDocument(doc);
      const frame = document.querySelector<HTMLIFrameElement>('#frame')!;
      window.scrollTo(0, frame.getBoundingClientRect().top + window.scrollY - 12);
      const inner = frame.contentDocument!;
      const bar = inner.createElement('div');
      bar.style.cssText =
        'position:fixed;left:0;right:0;top:150px;height:60px;background:#c004;z-index:9';
      inner.body.append(bar);
      const count = { writes: 0 };
      (window as unknown as { __portalWrites: typeof count }).__portalWrites = count;
      new MutationObserver((records) => {
        for (const record of records) {
          const element = record.target as HTMLElement;
          if (
            /pointer-events/.test(record.oldValue ?? '') ||
            element.style.getPropertyValue('pointer-events') !== ''
          ) {
            count.writes += 1;
          }
        }
      }).observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['style'],
        attributeOldValue: true,
      });
    }, tall);
    await editor.settle();
    const at = await page.evaluate(() => {
      const frame = document.querySelector('#frame')!.getBoundingClientRect();
      const host = window.__e2e.editor.element
        .querySelector('[data-block-id="p2"] .neditor-block__content')!
        .getBoundingClientRect();
      // The frame's 1px border.
      return { x: frame.left + 1, y: frame.top + 1, left: host.left };
    });
    // A point of the frame's, as the page's mouse reaches it.
    const move = (x: number, y: number, steps = 1) =>
      page.mouse.move(at.x + x, at.y + y, { steps });
    await move(at.left - 6, 330);
    await page.mouse.down();
    await move(at.left - 7, 330);
    await move(at.left + 150, 300, 4);
    await move(at.left + 150, 222, 6);
    await editor.settle();
    // The page's toolbar, in the page's own coordinates.
    const toolbar = (await page.locator('.neditor-portal.neditor-toolbar').boundingBox())!;
    const drawn = await page.evaluate(() => window.__e2e.editor.getSelectionState()?.range);
    expect(drawn).toBeTruthy();
    let under = 0;

    // Under the frame's bar (150 to 210 in the frame), at every point of the
    // frame's whose numbers are inside that rectangle.
    for (let y = 208; y >= 152; y -= 4) {
      for (const x of [
        toolbar.x + 20,
        toolbar.x + toolbar.width / 2,
        toolbar.x + toolbar.width - 20,
      ]) {
        if (y >= toolbar.y && y <= toolbar.y + toolbar.height && x > at.left) {
          under += 1;
          await move(x, y);
        }
      }
    }

    await editor.settle();
    expect(under).toBeGreaterThan(3);
    expect(
      await page.evaluate(
        () => (window as unknown as { __portalWrites: { writes: number } }).__portalWrites.writes,
      ),
    ).toBe(0);
    expect(await page.evaluate(() => window.__e2e.editor.getSelectionState()?.range)).toEqual(
      drawn,
    );
    await page.mouse.up();
  });

  /*
   * R14-RV1-4, the reviewer's q1 case: a drag the editor draws (a press in
   * the gutter beside "delta four", up to "gamma three": [26,32]), and the
   * reader's own Backspace with the button still down. The browser deletes
   * the range itself -- no commit, so nothing ended the drag as a letter
   * typed over the range does -- and the drag's anchor and the caret it
   * last found were places in the text as it had been: the next move drew
   * [18,32] under a bar of the page's and [30,32] in the text, from the
   * caret the Backspace left at 26. The reader's own edit in the host ends
   * a drag the editor is drawing. Never the browser's own drag, the
   * control: after a Backspace it still becomes a block selection when it
   * crosses into the next block.
   */
  test('P17c6 the reader’s own edit under a drag the editor draws ends that drag', async ({
    editor,
    page,
  }) => {
    const text = 'alpha one\nbravo two\ngamma three\ndelta four';

    for (const then of ['under a bar', 'on in the text'] as const) {
      await editor.load({ doc: 'paragraphs', toolbar: 0 });
      const at = await page.evaluate((text) => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks[1]!.content = [{ text }];
        ed.setDocument(doc);
        const host = ed.element.querySelector('[data-block-id="p2"] .neditor-block__content')!;
        const line = (offset: number) => {
          const range = document.createRange();
          range.setStart(host.firstChild!, offset);
          range.setEnd(host.firstChild!, offset + 1);
          return range.getBoundingClientRect();
        };
        const second = line(10);
        const bar = document.createElement('div');
        bar.style.cssText = `position:fixed;left:0;right:0;top:${second.top}px;height:${second.height}px;background:#f002;z-index:5`;
        document.body.append(bar);
        const middle = (offset: number) => (line(offset).top + line(offset).bottom) / 2;
        return {
          left: host.getBoundingClientRect().left,
          second: middle(10),
          third: middle(20),
          fourth: middle(32),
        };
      }, text);
      const x = at.left + 60;
      await page.mouse.move(at.left - 6, at.fourth);
      await page.mouse.down();
      await page.mouse.move(at.left - 7, at.fourth);
      await page.mouse.move(x, at.third, { steps: 6 });
      await editor.settle();
      expect((await editor.selection())?.range, then).toEqual({ start: 26, end: 32 });
      await page.keyboard.press('Backspace');
      expect((await editor.texts())[1], then).toBe('alpha one\nbravo two\ngamma delta four');
      if (then === 'under a bar') await page.mouse.move(x, at.second, { steps: 5 });
      else await page.mouse.move(x + 30, at.third - 2, { steps: 5 });
      await editor.settle();
      expect((await editor.selection())?.range, then).toEqual({ start: 26, end: 26 });
      await page.mouse.up();
      await editor.settle();
      expect((await editor.selection())?.range, then).toEqual({ start: 26, end: 26 });
    }

    await editor.load({ doc: 'five', toolbar: 0 });
    const from = await editor.pointAt(editor.content('b'), 2);
    const to = await editor.pointAt(editor.content('b'), 6);
    const next = await editor.pointAt(editor.content('c'), 4);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.keyboard.press('Backspace');
    expect((await editor.texts())[1]).toBe('BlB');
    await page.mouse.move(next.x, next.y, { steps: 6 });
    await page.mouse.up();
    await editor.settle();
    expect(await editor.selected()).toEqual(['b', 'c']);
  });

  /*
   * R14-RV1-5, the reviewer's h1 / h2 cases. Round 13 decided that no press
   * scrolls, except to show a caret it placed out of sight; a press that
   * selects a block still revealed the block (`#setBlockSelection`). A
   * click on the handle of a block the window's bottom edge cuts moved the
   * page 89px under the pointer -- the next click landed in the block's
   * text; a press on a rule cut by the edge, 3 to 13px; and in a read-only
   * view, a Shift+click many blocks on from the click before it brought
   * that first block back into view, 567px. A pointer press that selects
   * blocks reveals nothing, whatever modifier it is pressed with. The
   * keyboard does, the control: Enter on the handle brings the block into
   * view, as every key that selects a block does. (The long press is in
   * touch.spec.ts.)
   */
  test('P17s a press that selects a block does not bring it into view', async ({
    editor,
    page,
  }) => {
    const long = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(12);
    const cut = async () => {
      await editor.load({ doc: 'long' });
      await page.evaluate((long) => {
        const ed = window.__e2e.editor;
        const blocks = ed.getDocument().blocks;
        blocks.splice(20, 0, {
          id: 'tall',
          type: 'paragraph',
          depth: 0,
          content: [{ text: long }],
        });
        ed.setDocument({ blocks });
        const block = ed.element.querySelector('[data-block-id="tall"]')!;
        window.scrollTo(
          0,
          block.getBoundingClientRect().top + window.scrollY - (window.innerHeight - 50),
        );
      }, long);
      await editor.settle();
      const box = (await editor.content('tall').boundingBox())!;
      await page.mouse.move(box.x + 40, box.y + 10);
      await expect(editor.handle).toBeVisible();
      return page.evaluate(() => window.scrollY);
    };
    const scrolled = () => page.evaluate(() => window.scrollY);

    // The handle, by pointer.
    let y = await cut();
    await editor.handle.click();
    expect(await editor.selected(), 'a handle click').toEqual(['tall']);
    await editor.settle();
    expect(await scrolled(), 'a handle click').toBe(y);

    // With the modifier that adds a block to the selection: it adds this one.
    y = await cut();
    await editor.handle.click({ modifiers: ['ControlOrMeta'] });
    expect(await editor.selected(), 'a Mod+click on the handle').toEqual(['tall']);
    await editor.settle();
    expect(await scrolled(), 'a Mod+click on the handle').toBe(y);

    // And by keyboard.
    y = await cut();
    await editor.handle.focus();
    await page.keyboard.press('Enter');
    expect(await editor.selected(), 'Enter on the handle').toEqual(['tall']);
    await expect.poll(scrolled, { message: 'Enter on the handle' }).toBeGreaterThan(y + 40);

    // A rule with 8 of its pixels showing.
    await editor.load({ doc: 'long' });
    const rule = await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const blocks = ed.getDocument().blocks;
      blocks.splice(45, 0, { id: 'hr', type: 'divider', depth: 0, content: [] });
      ed.setDocument({ blocks });
      const block = ed.element.querySelector('[data-block-id="hr"]')!;
      window.scrollTo(
        0,
        block.getBoundingClientRect().top + window.scrollY - (window.innerHeight - 8),
      );
      return { x: block.getBoundingClientRect().left + 200, y: window.innerHeight - 4 };
    });
    await editor.settle();
    y = await scrolled();
    await page.mouse.click(rule.x, rule.y);
    expect(await editor.selected(), 'a press on a rule').toEqual(['hr']);
    await editor.settle();
    expect(await scrolled(), 'a press on a rule').toBe(y);

    // Shift+click on a handle, 28 blocks on from the block the selection
    // starts at: it is that first block, out of sight above, that was shown.
    await editor.load({ doc: 'long' });
    const start = (await editor.content('p2').boundingBox())!;
    await page.mouse.move(start.x + 40, start.y + start.height / 2);
    await editor.handle.click();
    expect(await editor.selected(), 'a Shift+click on a handle').toEqual(['p2']);
    await page.mouse.wheel(0, 700);
    await expect.poll(scrolled).toBeGreaterThan(600);
    await editor.settleScroll();
    const far = (await editor.content('p30').boundingBox())!;
    await page.mouse.move(far.x + 40, far.y + far.height / 2);
    await expect(editor.handle).toBeVisible();
    y = await scrolled();
    await editor.handle.click({ modifiers: ['Shift'] });
    await expect.poll(async () => (await editor.selected()).length).toBe(29);
    await editor.settle();
    expect(await scrolled(), 'a Shift+click on a handle').toBe(y);

    // A read-only view: a click in p2, the page wheeled on, Shift+click in p30.
    await editor.load({ doc: 'long', editable: false });
    const first = (await editor.content('p2').boundingBox())!;
    await page.mouse.click(first.x + 30, first.y + first.height / 2);
    await page.mouse.wheel(0, 700);
    await expect.poll(scrolled).toBeGreaterThan(600);
    await editor.settleScroll();
    y = await scrolled();
    const last = (await editor.content('p30').boundingBox())!;
    await page.keyboard.down('Shift');
    await page.mouse.click(last.x + 30, last.y + last.height / 2);
    await page.keyboard.up('Shift');
    await expect.poll(async () => (await editor.selected()).length).toBe(29);
    await editor.settle();
    expect(await scrolled(), 'a read-only Shift+click').toBe(y);
  });

  // e2e only: the edge bands, the autoscroll and the frames that drive it are
  // layout and timing happy-dom does not have.
  test('P18 a click beside the text in an edge band, with a pixel of jitter, scrolls nothing and selects nothing', async ({
    editor,
    page,
  }) => {
    // Was R3-PTR-1: the press the editor placed followed the pointer from its
    // first move, so a click on a list marker 28px from the bottom of the
    // window scrolled the page under the resting pointer, and the blocks the
    // scroll carried past it were selected -- the next key replaced them.
    const items = Array.from({ length: 60 }, (_, i) => ({
      id: `b${i}`,
      type: 'bulleted_list' as const,
      depth: 0,
      content: [{ text: `Item number ${i}` }],
    }));
    const height = page.viewportSize()!.height;

    for (const [band, targetY, jitter] of [
      ['bottom', height - 28, 1],
      ['top', 22, -1],
    ] as const) {
      await editor.load({ doc: 'long', toolbar: 0 });
      await editor.setDocument({ blocks: items });
      await editor.block('b30').evaluate((element, targetY) => {
        const box = element.getBoundingClientRect();
        window.scrollBy(0, (box.top + box.bottom) / 2 - targetY);
      }, targetY);
      await editor.settleScroll();
      const marker = (await editor.block('b30').locator('.neditor-block__marker').boundingBox())!;
      const x = marker.x + marker.width / 2;
      const y = marker.y + marker.height / 2;
      const before = await page.evaluate(() => window.scrollY);

      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + jitter);
      await page.waitForTimeout(120);
      await page.mouse.up();
      await editor.settle();

      expect(await page.evaluate(() => window.scrollY), `${band} band`).toBe(before);
      expect(await editor.selected(), `${band} band`).toEqual([]);
      expect(await editor.selection(), `${band} band`).toMatchObject({
        blockId: 'b30',
        range: { start: 0, end: 0 },
      });
      await editor.type('Q');
      expect((await editor.ids()).length).toBe(60);
      expect((await editor.texts())[30]).toBe('QItem number 30');

      // Past the threshold but away from the edge, still inside the band: the
      // press was in the band, and nothing has reached for the edge yet.
      const away = await page.evaluate(() => window.scrollY);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y - jitter * 8, { steps: 2 });
      await page.waitForTimeout(120);
      expect(await page.evaluate(() => window.scrollY), `${band} band, moved away`).toBe(away);
      await page.mouse.up();
    }

    // The gutter's own background, the same way (the auditor's second probe).
    await editor.load({ doc: 'long', toolbar: 0 });
    await editor.block('p22').evaluate((element, targetY) => {
      const box = element.getBoundingClientRect();
      window.scrollBy(0, (box.top + box.bottom) / 2 - targetY);
    }, height - 30);
    await editor.settleScroll();
    const text = await editor.pointAt(editor.content('p22'), 4);
    const block = (await editor.block('p22').boundingBox())!;
    await page.mouse.move(text.x, text.y);
    await page.mouse.move(block.x + 19, text.y, { steps: 3 });
    expect(
      await page.evaluate(
        ([x, y]) => document.elementFromPoint(x!, y!)?.classList.contains('neditor-gutter'),
        [block.x + 19, text.y],
      ),
      'the press lands on the gutter background',
    ).toBe(true);
    const before = await page.evaluate(() => window.scrollY);
    await page.mouse.down();
    await page.mouse.move(block.x + 20, text.y + 1);
    await page.waitForTimeout(250);
    await page.mouse.up();
    await editor.settle();
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
    expect(await editor.selected()).toEqual([]);
    expect(await editor.selection()).toMatchObject({ blockId: 'p22', range: { start: 0 } });

    // A real drag from there towards the edge still scrolls and selects.
    await page.mouse.move(block.x + 19, text.y);
    await page.mouse.down();
    await page.mouse.move(block.x + 19, height - 2, { steps: 6 });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before + 100);
    expect((await editor.selected()).length).toBeGreaterThan(2);
    await page.mouse.up();
  });

  // e2e only: which block a pointer is over is layout.
  test('P19 a drag the editor placed, moved below the editor in one quick step, selects to the last block', async ({
    editor,
    page,
  }) => {
    // Was R3-PTR-4: for such a drag a gap kept the block the pointer was last
    // over, and below the last block counted as a gap -- one move from a
    // marker to below the editor selected nothing, two selected half.
    for (const from of ['marker', 'padding'] as const) {
      for (const steps of [1, 2]) {
        await editor.load({ doc: 'lists', toolbar: 0 });
        const marker = (await editor.block('b1').locator('.neditor-block__marker').boundingBox())!;
        const root = (await editor.root.boundingBox())!;
        const text = await editor.pointAt(editor.content('b1'), 3);
        const start =
          from === 'marker'
            ? { x: marker.x + marker.width / 2, y: marker.y + marker.height / 2 }
            : { x: text.x, y: root.y + 4 };

        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(text.x + 20, root.y + root.height + 30, { steps });
        await editor.settle();
        expect(await editor.selected(), `${from}, ${steps} step(s)`).toEqual(await editor.ids());
        await page.mouse.up();
      }
    }
  });

  // e2e only: which block a pointer is over is layout.
  test('P19b a drag moved above the first block in one quick step selects to the first block', async ({
    editor,
    page,
  }) => {
    // Was R4-PTR-6: above the first block was no block at all, so a quick
    // step there kept the press's own block -- a caret (placed), part of it
    // (text), or in Firefox nothing -- where the same step below the last
    // block selected to the end. Both ends of the document now mirror.
    for (const from of ['padding', 'text'] as const) {
      for (const to of ['root padding', 'above the editor'] as const) {
        await editor.load({ doc: 'five', toolbar: 0, dragHandles: 0 });
        const ids = await editor.ids();
        const root = (await editor.root.boundingBox())!;
        const block = (await editor.block(ids[2]!).boundingBox())!;
        const start =
          from === 'padding'
            ? { x: root.x + 3, y: block.y + block.height / 2 }
            : await editor.pointAt(editor.content(ids[2]!), 3);
        const y = to === 'root padding' ? root.y + 2 : Math.max(2, root.y - 20);

        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + 40, y, { steps: 1 });
        await editor.settle();
        expect(await editor.selected(), `${from} to ${to}`).toEqual(ids.slice(0, 3));
        await page.mouse.up();
      }
    }
  });

  // e2e only: where a pointer beside the editor hit-tests to is layout.
  test('P20 a drag the editor placed, carried sideways out of the editor, selects to the edge of the line', async ({
    editor,
    page,
  }) => {
    // Was R3-PTR-3: the point beside the editor hit-tested the page, not the
    // text, so in Chromium the range collapsed onto the press.
    for (const [dir, text] of [
      [undefined, 'Alpha one'],
      ['rtl', 'שלום עולם'],
    ] as const) {
      const ranges: Record<string, unknown> = {};

      for (const from of ['padding', 'text'] as const) {
        for (const side of ['left', 'right'] as const) {
          await editor.load({ doc: 'paragraphs', toolbar: 0, dir });
          await editor.setDocument({
            blocks: [
              { id: 'p1', type: 'paragraph', depth: 0, content: [{ text }] },
              { id: 'p2', type: 'paragraph', depth: 0, content: [{ text: 'Bravo two' }] },
            ],
          });
          const root = (await editor.root.boundingBox())!;
          const host = (await editor.content('p1').boundingBox())!;
          const middle = await editor.pointAt(editor.content('p1'), 5);
          const y = from === 'padding' ? (root.y + host.y) / 2 : middle.y;
          const x = side === 'left' ? 2 : page.viewportSize()!.width - 5;

          await page.mouse.move(middle.x, y);
          await page.mouse.down();
          await page.mouse.move(middle.x - 5, middle.y, { steps: 2 });
          await page.mouse.move(x, middle.y, { steps: 6 });
          ranges[`${from} ${side}`] = (await editor.selection())?.range;
          await page.mouse.up();
        }
      }

      // From the padding it draws what a drag from the text itself draws.
      expect(ranges['padding left'], `${dir ?? 'ltr'} left`).toEqual(ranges['text left']);
      expect(ranges['padding right'], `${dir ?? 'ltr'} right`).toEqual(ranges['text right']);
      expect(ranges['padding left']).not.toEqual({ start: 5, end: 5 });
      expect(ranges['padding right']).not.toEqual({ start: 5, end: 5 });
    }
  });

  // e2e only: frames, the page around them and their scrolling are layout.
  test('P21 a drag held at the bottom of the window scrolls the page around an iframe mount that reaches below it', async ({
    page,
  }) => {
    // Was R3-PTR-6: the walk for a scroller ended at the frame's own page, so
    // with the frame's bottom below the window nothing that could bring it
    // into view was ever scrolled.
    const editor = new EditorPage(page, 0, page.frameLocator('#frame'));

    for (const from of ['text', 'padding'] as const) {
      await editor.load({ doc: 'long', mount: 'iframe', toolbar: 0, scroll: 1 });
      await page.locator('#frame').evaluate((frame) => {
        window.scrollBy(0, frame.getBoundingClientRect().top - 420);
      });
      await editor.settleScroll();
      const frame = (await page.locator('#frame').boundingBox())!;
      const height = page.viewportSize()!.height;
      expect(frame.y + frame.height, 'the frame reaches below the window').toBeGreaterThan(height);
      const start =
        from === 'text'
          ? await editor.pointAt(editor.content('p2'), 3)
          : { x: frame.x + 300, y: frame.y + 13 };
      const before = await page.evaluate(() => window.scrollY);

      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x, start.y + 80, { steps: 5 });
      await page.mouse.move(start.x, height - 3, { steps: 6 });
      await expect
        .poll(() => page.evaluate(() => window.scrollY), { message: from })
        .toBeGreaterThan(before + 100);
      // And it keeps selecting the blocks the scroll brings under the pointer.
      await expect.poll(async () => (await editor.selected()).length).toBeGreaterThan(12);
      await page.mouse.up();
    }
  });

  /*
   * R11-PTR-4. A frame drawn at another scale (`transform: scale()`) shows
   * its window at that scale, so a box in the page around it maps into the
   * frame as `(y - offset) / scale`, and the frame moves under a resting
   * pointer by the distance it moved over the scale. Added unscaled, a drag
   * held in the middle of a frame at `scale(0.5)` read as past the page's
   * bottom edge and scrolled it 248px; and once the page had scrolled the
   * frame's top away, a drag held at the window's top edge read as nowhere
   * near the page's and scrolled nothing. The probe: a 1400x1200 frame at
   * `scale(0.5)` from its top left, 60 paragraphs, a text drag from a
   * paragraph a third of the way down the drawn frame held where the
   * unscaled reading put the page's bottom edge (mid-frame); then the page
   * scrolled 300px past the frame's top and a drag held 2px below the
   * window's top, which brings the frame's top back. The unscaled frame is
   * the control. Layout: e2e.
   */
  test('P21b a drag in a frame drawn at half scale scrolls the page only from its edges', async ({
    page,
  }) => {
    for (const scale of [0.5, 1]) {
      const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
      await editor.load({ doc: 'long', mount: 'iframe', toolbar: 0 });
      await page.evaluate((scale) => {
        document.getElementById('stage')!.style.maxWidth = 'none';
        document.getElementById('frame')!.style.cssText =
          `display:block;width:1400px;height:1200px;border:0;transform:scale(${scale});` +
          `transform-origin:0 0;margin-bottom:${-1200 * (1 - scale)}px`;
        document.body.style.minHeight = '4000px';
      }, scale);
      await editor.settle();
      const frames = (n: number) =>
        page.evaluate(
          (n) =>
            new Promise<void>((resolve) => {
              const step = (left: number) =>
                left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
              step(n);
            }),
          n,
        );
      const scrolls = () =>
        page.evaluate(() => ({
          outer: Math.round(window.scrollY),
          inner: Math.round(
            (document.getElementById('frame') as HTMLIFrameElement).contentWindow!.scrollY,
          ),
        }));
      const paragraphAt = async (y: number) => {
        for (let i = 0; i < 60; i++) {
          const box = (await editor.content(`p${i}`).boundingBox())!;
          if (box.y > y - 40 && box.y + box.height < y + 40) return box;
        }
        throw new Error(`no paragraph near ${y}`);
      };

      // Held mid-frame: nothing is at an edge, so nothing scrolls.
      const frame = (await page.locator('#frame').boundingBox())!;
      // At half scale, where reading the page's box into the frame unscaled
      // put the page's bottom edge band; the control holds mid-window.
      const height = page.viewportSize()!.height;
      const held = scale === 1 ? height / 2 : frame.y + (height - frame.y - 24) * scale;
      const from = await paragraphAt(frame.y + frame.height / 3);
      const before = await scrolls();
      await page.mouse.move(from.x + 20, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + 40, held, { steps: 12 });
      await frames(40);
      expect(await scrolls(), `scale ${scale}: a drag held mid-frame scrolls nothing`).toEqual(
        before,
      );
      await page.mouse.up();

      // The page scrolled past the frame's top: a drag held at the window's
      // top brings it back.
      await page.evaluate(() =>
        window.scrollBy(0, document.getElementById('frame')!.getBoundingClientRect().top + 300),
      );
      await editor.settleScroll();
      const top = (await scrolls()).outer;
      const start = await paragraphAt(150);
      await page.mouse.move(start.x + 20, start.y + start.height / 2);
      await page.mouse.down();
      await page.mouse.move(start.x + 40, 2, { steps: 12 });
      await expect
        .poll(async () => (await scrolls()).outer, {
          message: `scale ${scale}: held at the window's top`,
        })
        .toBeLessThan(top - 250);
      await page.mouse.up();
    }
  });
});
