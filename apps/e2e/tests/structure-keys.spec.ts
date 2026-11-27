import { expect, MOD, test } from '../helpers/test.ts';

test.describe('03 · structural keys', () => {
  test('S1 Backspace at block start: outdent, then revert to paragraph, then merge', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'nested' });
    await editor.placeCaret('l1', 0);

    await page.keyboard.press('Backspace');
    expect((await editor.blockData('l1'))?.depth).toBe(0);
    await page.keyboard.press('Backspace');
    expect((await editor.blockData('l1'))?.type).toBe('paragraph');
    await page.keyboard.press('Backspace');
    expect(await editor.outline()).toContain('bulleted_list:Level zeroLevel one');
    expect(await editor.selection()).toMatchObject({
      blockId: 'l0',
      range: { start: 10, end: 10 },
    });
  });

  test('S1b merging keeps the marks of both halves', async ({ editor, page }) => {
    await editor.load({ doc: 'formatted' });
    await editor.placeCaret('p2', 0);
    await page.keyboard.press('Backspace');
    const merged = (await editor.blockData('p1'))!.content;
    expect(merged).toEqual([
      { text: 'plain ' },
      { text: 'bold', marks: ['bold'] },
      { text: ' and ' },
      { text: 'italic', marks: ['italic'] },
      { text: 'Second paragraph' },
    ]);
  });

  test('S2 Backspace after a divider deletes it; before an image or table it selects', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'divider' });
    await editor.placeCaret('p2', 0);
    await page.keyboard.press('Backspace');
    expect(await editor.ids()).toEqual(['p1', 'p2']);

    await editor.remount({}, 'image');
    await editor.placeCaret('after', 0);
    await page.keyboard.press('Backspace');
    expect(await editor.selected()).toEqual(['img']);
    expect((await editor.blockData('after'))?.content).toEqual([{ text: 'After the image' }]);

    await editor.remount({}, 'table');
    await editor.placeCaret('after', 0);
    await page.keyboard.press('Backspace');
    expect(await editor.selected()).toEqual(['tbl']);
  });

  test('S3 Backspace at the start of an image caption selects the image and keeps it', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'image' });
    await editor.placeCaret('img', 0);
    await page.keyboard.press('Backspace');
    expect(await editor.selected()).toEqual(['img']);
    expect(await editor.blockData('img')).toMatchObject({
      type: 'image',
      src: '/sample.png',
      alt: 'A blue gradient',
    });
  });

  test('S4 Delete at the end merges, removes a divider, selects a table, and stops at the end', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.caretAtEnd('p1');
    await page.keyboard.press('Delete');
    expect(await editor.texts()).toEqual(['Alpha oneBravo two', 'Charlie three']);

    await editor.remount({}, 'divider');
    await editor.caretAtEnd('p1');
    await page.keyboard.press('Delete');
    expect(await editor.ids()).toEqual(['p1', 'p2']);

    await editor.remount({}, 'table');
    await editor.caretAtEnd('before');
    await page.keyboard.press('Delete');
    expect(await editor.selected()).toEqual(['tbl']);

    await editor.remount({}, 'paragraphs');
    await editor.caretAtEnd('p3');
    await editor.clearLog();
    await page.keyboard.press('Delete');
    expect(await editor.texts()).toEqual(['Alpha one', 'Bravo two', 'Charlie three']);
    expect(await editor.events('change')).toEqual([]);
  });

  test('S5 Tab indents up to one level below the previous block; Shift+Tab outdents', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.placeCaret('p2', 0);
    await page.keyboard.press('Tab');
    expect((await editor.blockData('p2'))?.depth).toBe(1);
    await expect(editor.block('p2')).toHaveAttribute('data-depth', '1');
    // The indent animates (120 ms on margin-inline-start), so wait for it to land.
    await expect
      .poll(() =>
        editor
          .block('p2')
          .evaluate((element) => parseFloat(getComputedStyle(element).marginInlineStart)),
      )
      .toBeCloseTo(24, 0);

    // Cannot go deeper than p1 + 1, so the key is not swallowed: focus moves on.
    await page.keyboard.press('Tab');
    expect((await editor.blockData('p2'))?.depth).toBe(1);
    await expect(editor.content('p2')).not.toBeFocused();

    await editor.placeCaret('p2', 0);
    await page.keyboard.press('Shift+Tab');
    expect((await editor.blockData('p2'))?.depth).toBe(0);
  });

  test('S6 the editor is never a keyboard trap', async ({ editor, page }) => {
    await editor.load({ doc: 'empty' });
    await editor.placeCaret('p1', 0);
    // Nothing above to indent under: Tab moves on instead of being swallowed.
    await page.keyboard.press('Tab');
    await expect(page.locator('#after')).toBeFocused();
    expect((await editor.blockData('p1'))?.depth).toBe(0);

    await editor.remount({}, 'paragraphs');
    await editor.placeCaret('p1', 0);
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#before')).toBeFocused();
  });

  /*
   * R14-RV4B-1. The guaranteed exit on a page that stops the release above
   * the editor (a container with drag handling of its own; in an iframe
   * mount, the frame's own body). The release was heard only in the
   * document's bubble phase, so `#pointerDown` stayed set from the first
   * click in a block on: Escape in the block selected nothing, the second
   * Escape only selected it, and the Tab after went nowhere -- a keyboard
   * trap (WCAG 2.1.2), in every engine and mount. Stopping `pointerup`
   * alone did that already in round 13; round 14's press, marked in the
   * capture phase (RO6j2), made stopping both do it too. And the rest of
   * the release with it: a drag across blocks kept `data-selecting` and
   * went on selecting under a pointer with no button down. Real clicks and
   * keys, real focus: e2e. Points are read through the editor's own
   * element, since no locator sees into a closed root, and lifted out of
   * the frame.
   */
  test('S6b Escape twice leaves the editor on a page that stops the release', async ({
    editor,
    page,
  }) => {
    for (const mount of ['plain', 'shadow', 'closed', 'nested', 'iframe'] as const) {
      for (const stopped of [['pointerdown', 'pointerup'], ['pointerup']]) {
        const label = `${mount}, ${stopped.join(' and ')} stopped`;
        await editor.load({ doc: 'long', mount });
        await page.evaluate((stopped) => {
          const doc = window.__e2e.editor.element.ownerDocument;
          for (const type of stopped) {
            (doc.querySelector('#stage') ?? doc.body).addEventListener(type, (event) => {
              event.stopPropagation();
            });
          }
        }, stopped);
        const at = (id: string, offset: number) =>
          page.evaluate(
            ([id, offset]) => {
              const root = window.__e2e.editor.element;
              const host = root.querySelector(`[data-block-id="${id}"] .neditor-block__content`)!;
              const range = root.ownerDocument.createRange();
              range.setStart(host.firstChild!, offset as number);
              range.setEnd(host.firstChild!, (offset as number) + 1);
              const box = range.getBoundingClientRect();
              const frame = root.ownerDocument.defaultView!.frameElement;
              const outer = frame?.getBoundingClientRect();
              const dx = frame && outer ? outer.left + frame.clientLeft : 0;
              const dy = frame && outer ? outer.top + frame.clientTop : 0;
              return { x: box.left + 1 + dx, y: (box.top + box.bottom) / 2 + dy };
            },
            [id, offset] as const,
          );
        const gesture = () =>
          page.evaluate(() => {
            const ed = window.__e2e.editor;
            return { selected: ed.getSelectedBlocks(), selecting: ed.element.dataset.selecting };
          });

        // Everything the release ends, ends: a drag across blocks, released,
        // is over -- no `data-selecting` left on the root, and the pointer
        // moving on with no button down selects nothing more. Left live, it
        // went on following the pointer to p6.
        const from = await at('p2', 3);
        const to = await at('p4', 5);
        const beyond = await at('p6', 5);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(from.x + 20, from.y, { steps: 3 });
        await page.mouse.move(to.x, to.y, { steps: 8 });
        await page.mouse.up();
        await editor.settle();
        expect(await gesture(), `${label}: the drag released`).toEqual({
          selected: ['p2', 'p3', 'p4'],
          selecting: undefined,
        });
        await page.mouse.move(beyond.x, beyond.y, { steps: 8 });
        await editor.settle();
        expect(await gesture(), `${label}: and over`).toEqual({
          selected: ['p2', 'p3', 'p4'],
          selecting: undefined,
        });

        const point = await at('p2', 3);
        await page.mouse.click(point.x, point.y);
        await editor.settle();
        expect(await editor.selection(), `${label}: the click placed the caret`).toMatchObject({
          blockId: 'p2',
        });

        await page.keyboard.press('Escape');
        expect(await editor.selected(), `${label}: Escape selects the block`).toEqual(['p2']);
        await page.keyboard.press('Escape');
        expect(await editor.hasFocus(), `${label}: the second lets go`).toBe(false);
        await page.keyboard.press('Tab');
        await expect(page.locator('#after'), `${label}: Tab leaves`).toBeFocused();
      }
    }
  });

  test('S7 Mod+Shift+Arrow moves a block; at the edge it records nothing', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.placeCaret('p2', 3);
    await page.keyboard.press(`${MOD}+Shift+ArrowUp`);
    expect(await editor.ids()).toEqual(['p2', 'p1', 'p3']);
    expect((await editor.selection())?.blockId).toBe('p2');

    await page.evaluate(() => window.__e2e.editor.clearHistory());
    await editor.clearLog();

    for (let press = 0; press < 10; press += 1) {
      await page.keyboard.press(`${MOD}+Shift+ArrowUp`);
    }

    expect(await editor.ids()).toEqual(['p2', 'p1', 'p3']);
    expect(await editor.events('change')).toEqual([]);
    expect(await editor.canUndo()).toBe(false);

    await page.keyboard.press(`${MOD}+Shift+ArrowDown`);
    await page.keyboard.press(`${MOD}+Shift+ArrowDown`);
    expect(await editor.ids()).toEqual(['p1', 'p3', 'p2']);
  });

  test('S7c Mod+Shift+Arrow keeps the caret offset in both directions', async ({
    editor,
    page,
  }) => {
    // Was FINDING F2, fixed; see docs/e2e-progress.md.
    await editor.load({ doc: 'paragraphs' });
    await editor.placeCaret('p2', 3);
    await page.keyboard.press(`${MOD}+Shift+ArrowDown`);
    expect(await editor.selection()).toMatchObject({ blockId: 'p2', range: { start: 3, end: 3 } });
    await page.keyboard.press(`${MOD}+Shift+ArrowUp`);
    expect(await editor.selection()).toMatchObject({ blockId: 'p2', range: { start: 3, end: 3 } });
  });

  test('S7b moving past a collapsed toggle steps over it as one unit', async ({ editor, page }) => {
    await editor.load({ doc: 'toggle-collapsed' });
    await editor.placeCaret('after', 0);
    await page.keyboard.press(`${MOD}+Shift+ArrowUp`);
    expect(await editor.ids()).toEqual(['before', 'after', 'tg', 'child1', 'child2']);
  });

  test('S8 ArrowUp/Down at a boundary moves between blocks, skipping dividers and hidden children', async ({
    editor,
    page,
  }) => {
    // The caret keeps its x: from the start of one line to the start of the
    // next, and from the end of a longer one to the end of a shorter one.
    await editor.load({ doc: 'divider' });
    await editor.placeCaret('p2', 0);
    await page.keyboard.press('ArrowUp');
    expect(await editor.selection()).toMatchObject({ blockId: 'p1', range: { start: 0, end: 0 } });
    await page.keyboard.press('ArrowDown');
    expect((await editor.selection())?.blockId).toBe('p2');

    await editor.remount({}, 'toggle-collapsed');
    await editor.caretAtEnd('after');
    await page.keyboard.press('ArrowUp');
    const landed = await editor.selection();
    expect(landed?.blockId).toBe('tg');
    // Under the end of "After": inside "Toggle head", not at either end of it.
    expect(landed?.range.start).toBeGreaterThan(0);
    expect(landed?.range.start).toBeLessThan('Toggle head'.length);
  });

  test('S9 Mod+Enter toggles a to-do, and is a plain split elsewhere', async ({ editor, page }) => {
    await editor.load({ doc: 'lists' });
    await editor.placeCaret('t1', 3);
    await page.keyboard.press(`${MOD}+Enter`);
    expect((await editor.blockData('t1'))?.checked).toBe(true);
    await expect(editor.block('t1')).toHaveAttribute('data-checked', 'true');
    expect(await editor.texts()).toContain('Todo one');

    await editor.placeCaret('b1', 6);
    await page.keyboard.press(`${MOD}+Enter`);
    expect(await editor.texts()).toContain('Bullet');
  });
});
