import { expect, EditorPage, MOD, test } from '../helpers/test.ts';

async function gutterGeometry(editor: EditorPage, id: string) {
  await editor.hoverBlock(id);
  await expect(editor.gutter).toHaveAttribute('data-visible', 'true');
  const gutter = (await editor.gutter.boundingBox())!;
  const content = (await editor.content(id).boundingBox())!;
  return { gutter, content };
}

test.describe('09 · gutter & block drag', () => {
  test('G1 the gutter sits beside the hovered block: top-level, nested, and after scrolling', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'nested' });

    for (const id of ['l0', 'l2']) {
      const { gutter, content } = await gutterGeometry(editor, id);
      expect(Math.abs(gutter.y - content.y)).toBeLessThanOrEqual(6);
      // Just to the left of where this block's text begins, indented with it.
      expect(gutter.x + gutter.width).toBeLessThanOrEqual(content.x + 1);
      expect(content.x - (gutter.x + gutter.width)).toBeLessThan(40);
    }

    await editor.remount({}, 'long');
    await page.evaluate(() => window.scrollTo(0, 600));
    const block = (await editor.block('p30').boundingBox())!;
    await page.mouse.move(block.x + 60, block.y + block.height / 2);
    await expect(editor.gutter).toHaveAttribute('data-visible', 'true');
    const gutter = (await editor.gutter.boundingBox())!;
    expect(Math.abs(gutter.y - block.y)).toBeLessThanOrEqual(8);
  });

  test('G1b in RTL the gutter sits on the right of the text', async ({ editor }) => {
    await editor.load({ doc: 'paragraphs', dir: 'rtl' });
    const { gutter, content } = await gutterGeometry(editor, 'p2');
    expect(gutter.x).toBeGreaterThanOrEqual(content.x + content.width - 1);
  });

  test('G2 + inserts an empty paragraph below the block and its children, at the same depth, and focuses it', async ({
    editor,
  }) => {
    await editor.load({ doc: 'nested' });
    await editor.hoverBlock('l1');
    await editor.addButton.click();
    const outline = await editor.outline();
    // After l1's child l2, not between them: there the child would change
    // parent to the empty line (and a collapsed toggle's would spill out).
    expect(outline[2]).toBe('    bulleted_list:Level two');
    expect(outline[3]).toBe('  paragraph:');
    const inserted = (await editor.ids())[3]!;
    expect(await editor.focusedBlock()).toBe(inserted);
    await editor.type('typed');
    expect((await editor.outline())[3]).toBe('  paragraph:typed');
  });

  test('G3 handle: click selects, Shift+click extends, Mod+click toggles', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await editor.hoverBlock('b');
    await editor.handle.click();
    expect(await editor.selected()).toEqual(['b']);

    await editor.hoverBlock('d');
    await editor.handle.click({ modifiers: ['Shift'] });
    expect(await editor.selected()).toEqual(['b', 'c', 'd']);

    await editor.hoverBlock('c');
    await editor.handle.click({ modifiers: ['ControlOrMeta'] });
    expect(await editor.selected()).toEqual(['b', 'd']);
    await expect(editor.root).toBeFocused();
    await page.keyboard.press('Escape');
  });

  test('G4 dragging a handle shows the indicator at the gap under the pointer and moves the block', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await editor.dragBlock('a', 'd', 'after', { release: false });
    await expect(editor.root).toHaveAttribute('data-dragging', 'true');
    const indicator = editor.root.locator('.neditor-drop-indicator');
    await expect(indicator).toBeVisible();
    const line = (await indicator.boundingBox())!;
    const d = (await editor.block('d').boundingBox())!;
    const e = (await editor.block('e').boundingBox())!;
    // Between d and e: not "past the last block", which is all happy-dom can answer.
    expect(line.y).toBeGreaterThanOrEqual(d.y + d.height / 2);
    expect(line.y).toBeLessThanOrEqual(e.y + e.height / 2);

    await page.mouse.up();
    await expect(editor.root).not.toHaveAttribute('data-dragging', 'true');
    expect(await editor.ids()).toEqual(['b', 'c', 'd', 'a', 'e']);
    await page.keyboard.press(`${MOD}+z`);
    expect(await editor.ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('G5 a handle inside a multi-selection drags the whole selection, which survives the drop', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['b', 'c']));
    await editor.dragBlock('b', 'e', 'after');
    expect(await editor.ids()).toEqual(['a', 'd', 'e', 'b', 'c']);
    // The compatibility click aimed at the captured handle must not collapse it.
    expect(await editor.selected()).toEqual(['b', 'c']);
  });

  test('G6 dropping back into its own gap changes nothing and records nothing', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await page.evaluate(() => window.__e2e.editor.clearHistory());
    await editor.clearLog();
    await editor.dragBlock('b', 'b', 'before');
    expect(await editor.ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(await editor.events('change')).toEqual([]);
    expect(await editor.canUndo()).toBe(false);
  });

  test('G7 Escape abandons a drag; so does pointercancel; releasing outside the window ends it', async ({
    editor,
    page,
    browserName,
  }) => {
    await editor.load({ doc: 'five' });
    await editor.dragBlock('a', 'd', 'after', { release: false });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(await editor.ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
    await expect(editor.root).not.toHaveAttribute('data-dragging', 'true');
    await expect(editor.root.locator('.neditor-drop-indicator')).toBeHidden();

    await editor.dragBlock('a', 'd', 'after', { release: false });
    // The browser taking the gesture over: the event is what the UA sends then.
    await editor.handle.evaluate((handle) => {
      const pointerId = window.__e2e.lastPointerId;
      handle.dispatchEvent(
        new PointerEvent('pointercancel', { bubbles: true, pointerId, pointerType: 'mouse' }),
      );
    });
    await page.mouse.up();
    expect(await editor.ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
    await expect(editor.root).not.toHaveAttribute('data-dragging', 'true');

    // Pointer capture: a release far outside the page still ends the drag.
    // Playwright's Firefox delivers no event at all for a release outside the
    // viewport, so there is nothing to observe there.
    test.skip(
      browserName === 'firefox',
      'Playwright Firefox dispatches no pointerup outside the viewport',
    );
    await editor.dragBlock('e', 'a', 'before', { release: false });
    await page.mouse.move(-40, -40, { steps: 4 });
    await page.mouse.up();
    await expect(editor.root).not.toHaveAttribute('data-dragging', 'true');
    // And the next gesture is an ordinary one.
    await editor.hoverBlock('c');
    await editor.handle.click();
    expect(await editor.selected()).toEqual(['c']);
  });

  test('G8 a nested block dragged to the top is pulled to depth 0; a collapsed toggle brings its children', async ({
    editor,
  }) => {
    await editor.load({ doc: 'nested' });
    await editor.dragBlock('l2', 'l0', 'before');
    expect(await editor.outline()).toEqual([
      'bulleted_list:Level two',
      'bulleted_list:Level zero',
      '  bulleted_list:Level one',
      'paragraph:After the list',
    ]);

    await editor.remount({}, 'toggle-collapsed');
    await editor.dragBlock('tg', 'after', 'after');
    expect(await editor.ids()).toEqual(['before', 'after', 'tg', 'child1', 'child2']);
  });

  test('G10 dragging the block you are typing in leaves block mode whole, with no caret behind', async ({
    editor,
  }) => {
    // Was FINDING F12: the drag selected the block without taking focus, so the
    // caret stayed live in the moved block while it was block-selected, and the
    // next keystroke replaced a block the reader could see a caret in. The
    // drop keeps the block selected (as G5 does for a selection), so it must
    // leave block mode whole: focus on the root, no caret in any host.
    await editor.load({ doc: 'five' });
    await editor.clickAt('a', 3);
    await editor.dragBlock('a', 'd', 'after');
    expect(await editor.ids()).toEqual(['b', 'c', 'd', 'a', 'e']);
    expect(await editor.selected()).toEqual(['a']);
    await expect(editor.root).toBeFocused();
    expect(await editor.selection()).toBeNull();
    expect(await editor.invariants()).toEqual([]);
  });

  test('G11 Escape mid drag ends the drag only: the blocks stay selected and the editor keeps focus', async ({
    editor,
    page,
  }) => {
    // Was STR-7: the document's capture listener abandoned the drag and the
    // root's block-mode Escape then ran as well -- selection cleared, focus
    // gone, "Left the editor" announced.
    await editor.load({ doc: 'five' });
    await editor.dragBlock('b', 'd', 'after', { release: false });
    expect(await editor.selected()).toEqual(['b']);
    await editor.clearLog();

    await page.keyboard.press('Escape');
    await expect(editor.root).not.toHaveAttribute('data-dragging', 'true');
    expect(await editor.selected()).toEqual(['b']);
    await expect(editor.root).toBeFocused();
    expect(await editor.announcements()).not.toContain('Left the editor');
    await page.mouse.up();
    expect(await editor.ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(await editor.selected()).toEqual(['b']);
  });

  test('G12 undo mid drag ends the drag; the release moves nothing', async ({ editor, page }) => {
    // Was STR-8: the gap indexed the document the drag started over, so after
    // the undo the release committed a move into a stale position.
    await editor.load({ doc: 'five' });
    await editor.clickAt('e', 2);
    await page.keyboard.press(`${MOD}+Shift+ArrowUp`);
    expect(await editor.ids()).toEqual(['a', 'b', 'c', 'e', 'd']);

    await editor.dragBlock('a', 'c', 'after', { release: false });
    await expect(editor.root).toHaveAttribute('data-dragging', 'true');
    await page.keyboard.press(`${MOD}+z`);
    expect(await editor.ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
    await expect(editor.root).not.toHaveAttribute('data-dragging', 'true');
    await expect(editor.root.locator('.neditor-drop-indicator')).toBeHidden();

    await page.mouse.up();
    expect(await editor.ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(await editor.invariants()).toEqual([]);
  });

  // e2e only: scrolling and the frames that drive it are not in happy-dom.
  test('G13 a handle drag held at the bottom edge scrolls, so a block can move past the first screen', async ({
    editor,
    page,
  }) => {
    // Was STR-6: holding at the edge for a second left scrollY at 0.
    await editor.load({ doc: 'long', toolbar: 0 });
    await editor.hoverBlock('p1');
    const handle = (await editor.handle.boundingBox())!;
    const x = handle.x + handle.width / 2;
    const height = page.viewportSize()!.height;
    await page.mouse.move(x, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, handle.y + handle.height / 2 + 10, { steps: 2 });
    await page.mouse.move(x, height - 2, { steps: 10 });

    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(600);
    // Back off the edge to stop, then drop.
    await page.mouse.move(x, height / 2, { steps: 4 });
    const stopped = await page.evaluate(() => window.scrollY);
    await editor.settle();
    expect(await page.evaluate(() => window.scrollY)).toBe(stopped);
    await page.mouse.up();

    const ids = await editor.ids();
    // Paragraphs are ~31px; the first screen holds about 25 of them.
    expect(ids.indexOf('p1')).toBeGreaterThan(30);
    expect(ids).toHaveLength(60);
  });

  // e2e only: scrollable overflow and where a click lands are layout.
  test('G14 before the first hover the gutter adds no height, so the first hover does not move the page', async ({
    page,
  }) => {
    // Was UI-4: unplaced, the gutter sat at its static position below the
    // last block, ~21px of overflow that the first hover took away -- in a
    // frame scrolled to its end the page jumped and the click missed.
    const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
    await editor.load({ doc: 'kitchen-sink', mount: 'iframe' });
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    const box = (await page.locator('#frame').boundingBox())!;
    await page.mouse.move(box.x + 4, box.y + 100);
    await page.mouse.wheel(0, 2000);
    await expect
      .poll(() => frame.evaluate(() => window.scrollY + window.innerHeight))
      .toBe(await frame.evaluate(() => document.documentElement.scrollHeight));
    const before = await frame.evaluate(() => ({
      height: document.documentElement.scrollHeight,
      scrollY: window.scrollY,
    }));

    const point = await editor.pointAt(editor.content('end'), 3);
    await page.mouse.move(point.x, point.y, { steps: 5 });
    await expect(editor.gutter).toHaveAttribute('data-visible', 'true');
    expect(
      await frame.evaluate(() => ({
        height: document.documentElement.scrollHeight,
        scrollY: window.scrollY,
      })),
    ).toEqual(before);

    await page.mouse.down();
    await page.mouse.up();
    await editor.type('X');
    expect((await editor.texts()).at(-1)).toBe('TheX end');
  });

  test('G9 no gutter with dragHandles:false or in read-only', async ({ editor }) => {
    await editor.load({ doc: 'paragraphs', dragHandles: false });
    await editor.hoverBlock('p2');
    await expect(editor.root.locator('.neditor-gutter')).toHaveCount(0);

    await editor.load({ doc: 'paragraphs', editable: false });
    await editor.hoverBlock('p2');
    await expect(editor.gutter).not.toHaveAttribute('data-visible', 'true');
  });

  /*
   * The reviewer's g3 case (round 14, review 2): the pointer resting on
   * p5, the gutter beside it, and a peer's update that puts a block in at
   * the top. Every block moved down one line and the gutter stayed where
   * it was drawn -- beside p4 now, and still p5's: the handle clicked
   * there selected p5, and Backspace deleted a block the handle was not
   * beside. `setDocument` points the gutter at its block again after its
   * render, as an edit of the reader's own does. Where no pointer is, there
   * is no gutter to point: the update draws none.
   */
  test('G16 after a peer’s update the handle acts on the block it is drawn beside', async ({
    editor,
    page,
  }) => {
    // Read in the same task as the update, before any hover of the
    // browser's own can come: is the gutter shown, and where.
    const insertAbove = () =>
      page.evaluate(() => {
        const ed = window.__e2e.editor;
        const blocks = ed.getDocument().blocks;
        blocks.unshift({
          id: 'new',
          type: 'paragraph',
          depth: 0,
          content: [{ text: 'a peer inserted this' }],
        });
        ed.setDocument({ blocks });
        const gutter = ed.element.querySelector<HTMLElement>('.neditor-gutter')!;
        const block = ed.element.querySelector<HTMLElement>('[data-block-id="p5"]')!;
        return {
          visible: gutter.dataset.visible,
          top: gutter.style.top,
          beside: `${block.offsetTop}px`,
        };
      });
    // The handle's middle, and the block whose box that is in.
    const handle = () =>
      page.evaluate(() => {
        const ed = window.__e2e.editor;
        const box = ed.element.querySelector('.neditor-gutter__handle')!.getBoundingClientRect();
        const y = (box.top + box.bottom) / 2;
        const beside = [...ed.element.querySelectorAll<HTMLElement>('[data-block-id]')].find(
          (block) => {
            const line = block.getBoundingClientRect();
            return y >= line.top && y <= line.bottom;
          },
        );
        return { x: box.left + box.width / 2, y, beside: beside?.dataset.blockId ?? null };
      });

    for (const wait of [0, 100]) {
      await editor.load({ doc: 'long', toolbar: 0 });
      const line = (await editor.content('p5').boundingBox())!;
      await page.mouse.move(line.x + 100, line.y + line.height / 2);
      await page.mouse.move(line.x + 120, line.y + line.height / 2);
      await expect(editor.gutter).toHaveAttribute('data-visible', 'true');
      const shown = await insertAbove();
      // Still shown, and beside p5 where p5 now is: every engine hovers the
      // block under the resting pointer again a moment later, which is what
      // the click below finds.
      expect(shown.visible, `after ${wait} ms`).toBe('true');
      expect(shown.top, `after ${wait} ms`).toBe(shown.beside);
      if (wait) await page.waitForTimeout(wait);
      const before = await handle();
      // Straight onto the handle, in one move.
      await page.mouse.move(before.x, before.y);
      const { beside } = await handle();
      expect(beside, `after ${wait} ms`).not.toBeNull();
      await page.mouse.down();
      await page.mouse.up();
      await editor.settle();
      expect(await editor.selected(), `after ${wait} ms`).toEqual([beside]);
      await page.keyboard.press('Backspace');
      const ids = await editor.ids();
      expect(ids, `after ${wait} ms`).toHaveLength(60);
      expect(ids, `after ${wait} ms`).not.toContain(beside);
    }

    await editor.load({ doc: 'long', toolbar: 0 });
    await page.mouse.move(4, 4);
    await expect(editor.gutter).not.toHaveAttribute('data-visible', 'true');
    await insertAbove();
    await editor.settle();
    await expect(editor.gutter).not.toHaveAttribute('data-visible', 'true');
  });

  // e2e only: scrollable overflow is layout.
  test('G15 before the first hover the gutter adds no width either, in either direction', async ({
    editor,
    page,
  }) => {
    // Was R2-UI-8: UI-4 gave the unplaced gutter a block offset and left its
    // inline one to the static position, which in an RTL editor is past the
    // root's start edge -- a 390px page scrolled sideways until the first hover.
    await page.setViewportSize({ width: 390, height: 844 });

    for (const dir of [undefined, 'rtl', 'page-rtl'] as const) {
      await editor.load({ doc: 'kitchen-sink', dir });
      const gutter = (await editor.gutter.boundingBox())!;
      const root = (await editor.root.boundingBox())!;
      expect(gutter.x, `${dir ?? 'ltr'}: the gutter's left`).toBeGreaterThanOrEqual(root.x - 1);
      expect(gutter.x + gutter.width, `${dir ?? 'ltr'}: the gutter's right`).toBeLessThanOrEqual(
        root.x + root.width + 1,
      );
      const before = await page.evaluate(() => document.documentElement.scrollWidth);
      await editor.hoverBlock('para');
      await expect(editor.gutter).toHaveAttribute('data-visible', 'true');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(before);
    }
  });
});
