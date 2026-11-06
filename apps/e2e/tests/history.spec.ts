import { expect, MOD, test } from '../helpers/test.ts';

test.describe('13 · history', () => {
  test('H1 a burst of typing is one step; a pause over 600 ms starts another', async ({
    editor,
    page,
  }) => {
    await page.clock.install({ time: 0 });
    await editor.load({ doc: 'empty' });
    // Paused, so only runFor moves time. An installed clock otherwise keeps
    // pace with the real one, and on a loaded machine the real gap between two
    // type() calls alone crossed the 600 ms window and split the run.
    await page.clock.pauseAt(10_000);
    await editor.placeCaret('p1', 0);

    await editor.type('one');
    await page.clock.runFor(300);
    await editor.type(' two'); // inside the window: same run
    await page.clock.runFor(700);
    await editor.type(' three'); // after a pause: a new run

    await page.keyboard.press(`${MOD}+z`);
    expect(await editor.texts()).toEqual(['one two']);
    await page.keyboard.press(`${MOD}+z`);
    expect(await editor.texts()).toEqual(['']);
    expect(await editor.canUndo()).toBe(false);
  });

  test('H2 a caret move, a click, switching insert/delete, and another cell each end a run', async ({
    editor,
    page,
  }) => {
    await page.clock.install();
    await editor.load({ doc: 'paragraphs' });

    await editor.caretAtEnd('p1');
    await editor.type('AB');
    await page.keyboard.press('ArrowLeft');
    await editor.type('x');
    await page.keyboard.press(`${MOD}+z`);
    expect((await editor.texts())[0]).toBe('Alpha oneAB');

    await editor.clickAt('p2', 9);
    await editor.type('CD');
    await editor.clickAt('p2', 11);
    await editor.type('E');
    await page.keyboard.press(`${MOD}+z`);
    expect((await editor.texts())[1]).toBe('Bravo twoCD');

    await editor.caretAtEnd('p3');
    await editor.type('xyz');
    await page.keyboard.press('Backspace');
    await page.keyboard.press(`${MOD}+z`);
    expect((await editor.texts())[2]).toBe('Charlie threexyz');

    await editor.remount({}, 'table');
    await editor.placeCaret('tbl', 2, 2, { row: 1, column: 0 });
    await editor.type('!');
    await page.keyboard.press('Tab');
    await editor.type('?');
    await page.keyboard.press(`${MOD}+z`);
    const rows = (await editor.blockData('tbl'))!.rows!;
    expect(rows[1]![0]).toEqual([{ text: 'a1!' }]);
    expect(rows[1]![1]).toEqual([{ text: 'a2' }]);
  });

  test('H3 structural edits are always their own step', async ({ editor, page }) => {
    await page.clock.install();
    await editor.load({ doc: 'empty' });
    await editor.placeCaret('p1', 0);
    await editor.type('ab');
    await page.keyboard.press('Enter');
    await editor.type('cd');
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.press(`${MOD}+b`);

    await page.keyboard.press(`${MOD}+z`); // the mark
    expect((await editor.doc()).blocks[1]?.content).toEqual([{ text: 'cd' }]);
    await page.keyboard.press(`${MOD}+z`); // "cd"
    expect(await editor.texts()).toEqual(['ab', '']);
    await page.keyboard.press(`${MOD}+z`); // Enter
    expect(await editor.texts()).toEqual(['ab']);
    await page.keyboard.press(`${MOD}+z`); // "ab"
    expect(await editor.texts()).toEqual(['']);
  });

  test('H4 undo puts the caret back where the edit was made', async ({ editor, page }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.clickAt('p2', 5);
    await page.keyboard.press('Enter');
    await editor.type('moved on');
    await page.keyboard.press(`${MOD}+z`);
    await page.keyboard.press(`${MOD}+z`);
    expect(await editor.texts()).toEqual(['Alpha one', 'Bravo two', 'Charlie three']);
    expect(await editor.selection()).toMatchObject({ blockId: 'p2', range: { start: 5, end: 5 } });
  });

  test('H5 redo by Mod+Shift+Z and Mod+Y, in text and block mode; a new edit clears redo', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['b']));
    await page.keyboard.press('Backspace');
    await page.keyboard.press(`${MOD}+z`);
    expect(await editor.ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
    await page.keyboard.press(`${MOD}+Shift+z`);
    expect(await editor.ids()).toEqual(['a', 'c', 'd', 'e']);
    await page.keyboard.press(`${MOD}+z`);

    await editor.caretAtEnd('c');
    await page.keyboard.press(`${MOD}+y`);
    expect(await editor.ids()).toEqual(['a', 'c', 'd', 'e']);
    await page.keyboard.press(`${MOD}+z`);

    await editor.caretAtEnd('c');
    await editor.type('!');
    expect(await page.evaluate(() => window.__e2e.editor.canRedo)).toBe(false);
    await page.keyboard.press(`${MOD}+y`);
    expect((await editor.texts())[2]).toBe('Block C!');
  });

  test('H6 historyLimit caps how far back undo reaches', async ({ editor, page }) => {
    await editor.load({ doc: 'empty', historyLimit: 3 });
    await editor.placeCaret('p1', 0);

    for (let press = 0; press < 5; press += 1) {
      await page.keyboard.press('Enter');
    }

    for (let press = 0; press < 5; press += 1) {
      await page.keyboard.press(`${MOD}+z`);
    }

    expect(await editor.ids()).toHaveLength(3);
  });

  test('H7 setDocument is a reset: history clears, and the history event says so', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.caretAtEnd('p1');
    await editor.type('!');
    expect(await editor.canUndo()).toBe(true);
    await editor.clearLog();
    await editor.setDocument(await page.evaluate(() => window.__e2e.docs.five()));
    expect(await editor.canUndo()).toBe(false);
    const history = await editor.events('history');
    expect(history.at(-1)?.payload).toEqual({ canUndo: false, canRedo: false });
    await page.keyboard.press(`${MOD}+z`);
    expect(await editor.ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('H8 undo closes open menus and toolbars and leaves block selection', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.caretAtEnd('p1');
    await editor.type(' /');
    await expect(editor.portal('slash-menu')).toBeVisible();
    await page.keyboard.press(`${MOD}+z`);
    await expect(editor.portal('slash-menu')).toBeHidden();

    await editor.placeCaret('p2', 0, 5);
    await page.keyboard.press(`${MOD}+b`);
    await expect(editor.portal('toolbar')).toBeVisible();
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['p3']));
    await page.keyboard.press(`${MOD}+z`);
    expect(await editor.selected()).toEqual([]);
    // It restores the selection the bold was applied to (so the toolbar is back for it).
    expect(await editor.selection()).toMatchObject({ blockId: 'p2', range: { start: 0, end: 5 } });
    expect((await editor.blockData('p2'))?.content).toEqual([{ text: 'Bravo two' }]);
  });
});
