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

  test('H9 undoing the gutter + far down the page stays there (STR-4)', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'long' });
    await editor.content('p40').scrollIntoViewIfNeeded();
    await editor.settleScroll();
    await editor.hoverBlock('p40');
    await editor.addButton.click();
    await editor.type('x');
    const scrolled = await page.evaluate(() => window.scrollY);
    expect(scrolled, 'precondition: the page is scrolled').toBeGreaterThan(400);

    await page.keyboard.press(`${MOD}+z`);
    await page.keyboard.press(`${MOD}+z`);
    expect(await editor.ids()).toHaveLength(60);
    expect(await editor.selection()).toMatchObject({ blockId: 'p40' });
    await editor.settle();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(400);
  });

  test('H10 Mod+Z with a toggle chevron focused undoes the chevron press (STR-9)', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'toggle-collapsed' });
    const chevron = editor.block('tg').locator('.neditor-block__chevron');
    // The keyboard route to the chevron: Shift+Tab from the toggle's text.
    await editor.clickAt('tg', 3);
    await page.keyboard.press('Shift+Tab');
    await expect(chevron).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(editor.block('child1')).toBeVisible();
    await expect(chevron).toBeFocused();

    await page.keyboard.press(`${MOD}+z`);
    expect((await editor.blockData('tg'))?.collapsed).toBe(true);
    await expect(editor.block('child1')).toBeHidden();
  });

  test('H11 redo comes back to where the redone edit left the caret (TXT-12)', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty', toolbar: 0 });
    await editor.clickAt('p1', 0);
    await editor.type('Hello world');
    for (let i = 0; i < 5; i += 1) {
      await page.keyboard.press('Shift+ArrowLeft');
    }
    await page.keyboard.press(`${MOD}+b`);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await editor.type('Title');

    await page.keyboard.press(`${MOD}+z`); // Title
    await page.keyboard.press(`${MOD}+z`); // Enter
    await page.keyboard.press(`${MOD}+z`); // bold
    await page.keyboard.press(`${MOD}+Shift+z`);
    expect(await editor.selection()).toMatchObject({ range: { start: 6, end: 11 } });
    await page.keyboard.press(`${MOD}+Shift+z`);
    await page.keyboard.press(`${MOD}+Shift+z`);
    expect(await editor.texts()).toEqual(['Hello world', 'Title']);
    expect(await editor.selection()).toMatchObject({ range: { start: 5, end: 5 } });
  });

  test('H12 a backward selection keeps its direction across Mod+B and its undo (TXT-13)', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs', toolbar: 0 });
    await editor.clickAt('p2', 6);
    for (let i = 0; i < 3; i += 1) {
      await page.keyboard.press('Shift+ArrowLeft');
    }
    await page.keyboard.press(`${MOD}+b`);
    await page.keyboard.press('Shift+ArrowLeft');
    expect((await editor.selection())?.range).toEqual({ start: 2, end: 6 });

    await page.keyboard.press(`${MOD}+z`);
    expect((await editor.selection())?.range).toEqual({ start: 3, end: 6 });
    await page.keyboard.press('Shift+ArrowLeft');
    expect((await editor.selection())?.range).toEqual({ start: 2, end: 6 });
  });

  /*
   * R2-NAV-9. The link is applied with focus in its dialog, where a real
   * browser has no text selection to record, so undo put the caret at 0.
   * E2E only: happy-dom keeps a selection in an element whatever holds
   * focus, so a unit test records the right range with the fix removed.
   */
  test('H13 undoing a link applied from its dialog selects the linked text again', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.placeCaret('p2', 6, 9);
    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type('example.com');
    await page.keyboard.press('Enter');
    expect((await editor.blockData('p2'))?.content.at(-1)).toMatchObject({ text: 'two' });
    expect((await editor.blockData('p2'))?.content.at(-1)?.link).toBeTruthy();

    // Somewhere else first, so the caret undo restores is undo's own.
    await editor.clickAt('p1', 2);
    await page.keyboard.press(`${MOD}+z`);

    expect((await editor.blockData('p2'))?.content).toEqual([{ text: 'Bravo two' }]);
    expect(await editor.selection()).toMatchObject({
      blockId: 'p2',
      range: { start: 6, end: 9 },
    });
  });
});
