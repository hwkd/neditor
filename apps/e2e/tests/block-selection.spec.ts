import { expect, MOD, test } from '../helpers/test.ts';

test.describe('08 · block selection (keyboard)', () => {
  test('B1 Escape selects the block; Escape again leaves the editor and says so', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await editor.placeCaret('b', 3);
    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual(['b']);
    await expect(editor.root).toBeFocused();
    await expect(editor.block('b')).toHaveAttribute('data-selected', 'true');
    await expect(editor.liveRegion).toHaveText('Text selected, Block B');

    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual([]);
    expect(await editor.hasFocus()).toBe(false);
    await expect(editor.liveRegion).toHaveText('Left the editor');
  });

  test('B2 Shift+Arrow at a block edge extends into whole blocks', async ({ editor, page }) => {
    await editor.load({ doc: 'five' });
    await editor.placeCaret('c', 0);
    await page.keyboard.press('Shift+ArrowUp');
    expect(await editor.selected()).toEqual(['b', 'c']);
    await expect(editor.liveRegion).toHaveText('2 blocks selected');

    await editor.caretAtEnd('c');
    await page.keyboard.press('Shift+ArrowDown');
    expect(await editor.selected()).toEqual(['c', 'd']);
  });

  test('B3 Mod+A takes the text, then every block; in an empty block it goes straight to blocks', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await editor.placeCaret('b', 2);
    await page.keyboard.press(`${MOD}+a`);
    expect(await editor.selection()).toMatchObject({ blockId: 'b', range: { start: 0, end: 7 } });
    expect(await editor.selected()).toEqual([]);
    await page.keyboard.press(`${MOD}+a`);
    expect(await editor.selected()).toEqual(['a', 'b', 'c', 'd', 'e']);

    await editor.remount({}, 'empty');
    await editor.placeCaret('p1', 0);
    await page.keyboard.press(`${MOD}+a`);
    expect(await editor.selected()).toEqual(['p1']);
  });

  test('B4 arrows move the selection, Shift grows and shrinks it from the anchor, Mod+Shift moves blocks', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['c']));
    await page.keyboard.press('ArrowDown');
    expect(await editor.selected()).toEqual(['d']);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    expect(await editor.selected()).toEqual(['b']);

    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    expect(await editor.selected()).toEqual(['b', 'c', 'd']);
    await page.keyboard.press('Shift+ArrowUp');
    expect(await editor.selected()).toEqual(['b', 'c']);

    await page.keyboard.press(`${MOD}+Shift+ArrowDown`);
    expect(await editor.ids()).toEqual(['a', 'd', 'b', 'c', 'e']);
    expect(await editor.selected()).toEqual(['b', 'c']);
    await page.keyboard.press(`${MOD}+z`);
    expect(await editor.ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('B5 Tab and Shift+Tab indent and outdent the whole group', async ({ editor, page }) => {
    await editor.load({ doc: 'five' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['b', 'c']));
    await page.keyboard.press('Tab');
    expect((await editor.doc()).blocks.map((block) => block.depth)).toEqual([0, 1, 1, 0, 0]);
    await page.keyboard.press('Shift+Tab');
    expect((await editor.doc()).blocks.map((block) => block.depth)).toEqual([0, 0, 0, 0, 0]);
  });

  test('B5b a Tab in block mode that changes nothing leaves block mode before focus moves on', async ({
    editor,
    page,
  }) => {
    // Was FINDING F6: focus reached the first block's host but the block
    // selection survived, so the character typed at the visible caret
    // replaced the whole block.
    await editor.load({ doc: 'five' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['a']));
    await page.keyboard.press('Tab'); // nothing above `a` to nest under
    await expect(editor.root).not.toBeFocused();
    expect(await editor.selected()).toEqual([]);
    expect(await editor.invariants()).toEqual([]);
    await page.keyboard.type('x');
    // Whatever mode the editor lands in, typing must not destroy "Block A".
    expect((await editor.texts())[0]).toContain('Block A');
  });

  test('B6 Backspace and Delete remove the blocks and place the caret; deleting everything leaves one paragraph', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['b', 'c']));
    await page.keyboard.press('Backspace');
    expect(await editor.ids()).toEqual(['a', 'd', 'e']);
    await expect(editor.liveRegion).toHaveText('2 blocks deleted');
    expect(await editor.selection()).toMatchObject({ blockId: 'd', range: { start: 0, end: 0 } });

    await page.evaluate(() => window.__e2e.editor.selectBlocks(['e']));
    await page.keyboard.press('Delete');
    await expect(editor.liveRegion).toHaveText('Block deleted');
    expect((await editor.selection())?.blockId).toBe('d');

    await page.evaluate(() => window.__e2e.editor.selectBlocks(['a', 'd']));
    await page.keyboard.press('Delete');
    expect(await editor.outline()).toEqual(['paragraph:']);
  });

  test('B7 Mod+D duplicates below and selects the copies', async ({ editor, page }) => {
    await editor.load({ doc: 'five' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['b', 'c']));
    await page.keyboard.press(`${MOD}+d`);
    expect(await editor.texts()).toEqual([
      'Block A',
      'Block B',
      'Block C',
      'Block B',
      'Block C',
      'Block D',
      'Block E',
    ]);
    const ids = await editor.ids();
    expect(await editor.selected()).toEqual([ids[3], ids[4]]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('B8 a printable key replaces the selection with a paragraph holding it', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['b', 'c']));
    await page.keyboard.type('xyz');
    expect(await editor.texts()).toEqual(['Block A', 'xyz', 'Block D', 'Block E']);
    expect(await editor.selected()).toEqual([]);
  });

  test('B9 Enter returns to the last selected block that can hold a caret', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'divider' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['p1', 'hr']));
    await page.keyboard.press('Enter');
    expect(await editor.selected()).toEqual([]);
    expect(await editor.selection()).toMatchObject({ blockId: 'p1', range: { start: 5, end: 5 } });

    await page.evaluate(() => window.__e2e.editor.selectBlocks(['hr']));
    await page.keyboard.press('Enter');
    expect(await editor.selected()).toEqual(['hr']);
  });

  test('B10 selected blocks are marked with an accent bar, not colour alone, and no aria-selected', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['b']));
    const bar = await editor.block('b').evaluate((element) => {
      const style = getComputedStyle(element, '::before');
      return { content: style.content, width: style.width };
    });
    expect(bar.content).not.toBe('none');
    expect(parseFloat(bar.width)).toBeGreaterThanOrEqual(2);
    await expect(editor.block('b')).not.toHaveAttribute('aria-selected');
    const unselected = await editor
      .block('a')
      .evaluate((element) => getComputedStyle(element, '::before').content);
    expect(unselected).toBe('none');
  });

  test('B11 a collapsed toggle carries its hidden children through delete, move and duplicate', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'toggle-collapsed' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['tg']));
    expect(await editor.selected()).toEqual(['tg']);

    await page.keyboard.press(`${MOD}+Shift+ArrowUp`);
    expect(await editor.ids()).toEqual(['tg', 'child1', 'child2', 'before', 'after']);

    await page.keyboard.press(`${MOD}+d`);
    expect(await editor.texts()).toEqual([
      'Toggle head',
      'Hidden child one',
      'Hidden child two',
      'Toggle head',
      'Hidden child one',
      'Hidden child two',
      'Before',
      'After',
    ]);

    await page.evaluate(() => window.__e2e.editor.selectBlocks(['tg']));
    await page.keyboard.press('Backspace');
    expect(await editor.texts()).toEqual([
      'Toggle head',
      'Hidden child one',
      'Hidden child two',
      'Before',
      'After',
    ]);
    expect(await editor.ids()).not.toContain('child1');
  });
});
