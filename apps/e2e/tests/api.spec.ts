import { expect, MOD, test } from '../helpers/test.ts';

test.describe('24 · public API & events', () => {
  test('AP1 change fires once per edit, never for a no-op; the other events carry the right payloads', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.clearLog();

    await editor.clickAt('p2', 5);
    const focus = await editor.events('focus');
    expect(focus.at(-1)?.payload).toEqual({ blockId: 'p2' });

    await editor.type('x');
    expect(await editor.events('change')).toHaveLength(1);
    const history = await editor.events('history');
    expect(history.at(-1)?.payload).toEqual({ canUndo: true, canRedo: false });

    await editor.clearLog();
    await page.keyboard.press(`${MOD}+Shift+ArrowUp`);
    await page.keyboard.press(`${MOD}+Shift+ArrowUp`); // the second is against the top
    expect(await editor.events('change')).toHaveLength(1);

    await editor.clearLog();
    await editor.placeCaret('p3', 0, 7);
    // `selection` rides on the browser's asynchronous selectionchange.
    await expect
      .poll(async () => (await editor.events('selection')).at(-1)?.payload)
      .toMatchObject({ blockId: 'p3', range: { start: 0, end: 7 }, marks: [], link: null });

    // With a range selected the first Escape only hides the toolbar; then the
    // block is selected; then the editor is left.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    const blockEvents = (await editor.events('blockselection')).map((event) => event.payload);
    expect(blockEvents).toEqual([{ ids: ['p3'] }, { ids: [] }]);
    await expect.poll(async () => (await editor.events('selection')).at(-1)?.payload).toBeNull();
  });

  test('AP1b the selection event reports a table cell', async ({ editor }) => {
    await editor.load({ doc: 'table' });
    await editor.cell('tbl', 2, 1).click();
    const state = await editor.selection();
    expect(state).toMatchObject({ blockId: 'tbl', cell: { row: 2, column: 1 } });
  });

  test('AP2 a listener that throws goes to onError; the editor keeps working', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await page.evaluate(() => {
      window.__e2e.editor.on('change', () => {
        throw new Error('listener boom');
      });
    });
    await editor.caretAtEnd('p1');
    await editor.type('!');
    await editor.type('?');
    expect((await editor.texts())[0]).toBe('Alpha one!?');
    const errors = await page.evaluate(() => window.__e2e.errors.splice(0).map(String));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('listener boom');
  });

  test('AP3 getDocument returns a copy', async ({ editor, page }) => {
    await editor.load({ doc: 'paragraphs' });
    await page.evaluate(() => {
      const doc = window.__e2e.editor.getDocument();
      doc.blocks[0]!.content = [{ text: 'mutated' }];
      doc.blocks.pop();
    });
    expect(await editor.texts()).toEqual(['Alpha one', 'Bravo two', 'Charlie three']);
    await expect(editor.content('p1')).toHaveText('Alpha one');
  });

  test('AP4 setDocument sanitises what it renders; silent emits no change', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.clearLog();
    await page.evaluate(() => {
      window.__e2e.editor.setDocument(window.__e2e.docs.malicious(), { silent: true });
    });
    expect(await editor.events('change')).toEqual([]);
    const unsafe = await editor.root.evaluate(
      (root) =>
        [...root.querySelectorAll('[href], [src]')]
          .map((node) => node.getAttribute('href') ?? node.getAttribute('src') ?? '')
          .filter((value) => !/^(https?:|mailto:|tel:|\/)/.test(value)).length,
    );
    expect(unsafe).toBe(0);

    await page.evaluate(() => window.__e2e.editor.setDocument(window.__e2e.docs.five()));
    expect(await editor.events('change')).toHaveLength(1);
  });

  test('AP5 focus() and focusRange() refuse blocks that cannot hold a caret, and stay in a valid mode', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'toggle-collapsed' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['before']));
    const results = await page.evaluate(() => {
      const editor = window.__e2e.editor;
      return [editor.focus('child1'), editor.focus('nope'), editor.focusRange('child2', 0, 1)];
    });
    expect(results).toEqual([false, false, false]);
    expect(await editor.selected()).toEqual(['before']);

    await editor.remount({}, 'divider');
    expect(await page.evaluate(() => window.__e2e.editor.focus('hr'))).toBe(false);
    expect(await page.evaluate(() => window.__e2e.editor.focus('p2', 2))).toBe(true);
    expect(await editor.selection()).toMatchObject({ blockId: 'p2', range: { start: 2, end: 2 } });
  });

  test('AP6 selectBlocks([]) hands the caret back; setBlockType announces and ends block mode', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await editor.placeCaret('c', 3);
    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual(['c']);
    await page.evaluate(() => window.__e2e.editor.selectBlocks([]));
    expect(await editor.selected()).toEqual([]);
    expect((await editor.selection())?.blockId).toBe('c');

    await page.evaluate(() => window.__e2e.editor.selectBlocks(['b']));
    await page.evaluate(() => window.__e2e.editor.setBlockType('b', 'quote'));
    expect(await editor.selected()).toEqual([]);
    await expect(editor.liveRegion).toHaveText('Changed to Quote');
    await expect(editor.block('b').locator('blockquote')).toBeVisible();
    expect((await editor.selection())?.blockId).toBe('b');
  });
});
