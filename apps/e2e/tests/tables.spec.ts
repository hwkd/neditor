import { expect, MOD, test } from '../helpers/test.ts';
import type { EditorPage } from '../helpers/editor.ts';

const cellText = async (editor: EditorPage, row: number, column: number) =>
  ((await editor.blockData('tbl'))?.rows?.[row]?.[column] ?? []).map((run) => run.text).join('');

const caretCell = async (editor: EditorPage) => {
  const state = await editor.selection();
  return state?.cell ? `${state.cell.row}:${state.cell.column}` : null;
};

test.describe('16 · tables', () => {
  test('TB1 Tab and Shift+Tab walk the cells; Tab past the last adds a row', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await editor.placeCaret('tbl', 0, 0, { row: 0, column: 0 });

    const visited = [await caretCell(editor)];
    for (let press = 0; press < 8; press += 1) {
      await page.keyboard.press('Tab');
      visited.push(await caretCell(editor));
    }
    expect(visited).toEqual(['0:0', '0:1', '0:2', '1:0', '1:1', '1:2', '2:0', '2:1', '2:2']);

    await page.keyboard.press('Shift+Tab');
    expect(await caretCell(editor)).toBe('2:1');
    await page.keyboard.press('Tab');

    await page.keyboard.press('Tab');
    expect((await editor.blockData('tbl'))?.rows).toHaveLength(4);
    expect(await caretCell(editor)).toBe('3:0');
    await expect(editor.liveRegion).toHaveText('Row added');
    await editor.type('new');
    expect(await cellText(editor, 3, 0)).toBe('new');
  });

  test('TB1b Shift+Tab from the first cell leaves the table without indenting it', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await editor.placeCaret('tbl', 0, 0, { row: 0, column: 0 });
    await page.keyboard.press('Shift+Tab');
    expect(await caretCell(editor)).toBeNull();
    expect((await editor.blockData('tbl'))?.depth).toBe(0);
  });

  test('TB2 Enter breaks the line inside a cell, and the cell grows', async ({ editor, page }) => {
    await editor.load({ doc: 'table' });
    await editor.placeCaret('tbl', 2, 2, { row: 1, column: 1 });
    const before = (await editor.cell('tbl', 1, 1).boundingBox())!.height;
    await page.keyboard.press('Enter');
    const after = (await editor.cell('tbl', 1, 1).boundingBox())!.height;
    expect(after).toBeGreaterThan(before * 1.5);
    await editor.type('x');
    expect(await cellText(editor, 1, 1)).toBe('a2\nx');
    expect((await editor.doc()).blocks).toHaveLength(3);
  });

  test('TB3 Up/Down move between rows and leave the table at its edges; Backspace at a cell start is swallowed', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await editor.placeCaret('tbl', 0, 0, { row: 1, column: 2 });
    await page.keyboard.press('ArrowUp');
    expect(await caretCell(editor)).toBe('0:2');
    // (Not Home: on macOS WebKit and Firefox follow the platform, where Home does not move the caret.)
    await editor.placeCaret('tbl', 0, 0, { row: 0, column: 2 });
    await page.keyboard.press('ArrowUp');
    expect((await editor.selection())?.blockId).toBe('before');

    await editor.placeCaret('tbl', 2, 2, { row: 2, column: 0 });
    await page.keyboard.press('ArrowDown');
    expect((await editor.selection())?.blockId).toBe('after');

    await editor.placeCaret('tbl', 0, 0, { row: 1, column: 1 });
    await page.keyboard.press('Backspace');
    expect(await cellText(editor, 1, 1)).toBe('a2');
    expect(await cellText(editor, 1, 0)).toBe('a1');
    expect(await caretCell(editor)).toBe('1:1');
  });

  const COMMANDS: Array<
    [name: string, announce: string, rows: number, columns: number, focus: string]
  > = [
    ['Insert row above', 'Row inserted above', 4, 3, '2:1'],
    ['Insert row below', 'Row inserted below', 4, 3, '1:1'],
    ['Delete this row', 'Row deleted', 2, 3, '1:1'],
    ['Insert column left', 'Column inserted left', 3, 4, '1:2'],
    ['Insert column right', 'Column inserted right', 3, 4, '1:1'],
    ['Delete this column', 'Column deleted', 3, 2, '1:1'],
  ];

  for (const [name, announce, rows, columns, focus] of COMMANDS) {
    test(`TB4 "${name}" from the table toolbar`, async ({ editor }) => {
      await editor.load({ doc: 'table' });
      await editor.placeCaret('tbl', 0, 0, { row: 1, column: 1 });
      const toolbar = editor.portal('table-toolbar');
      await expect(toolbar).toBeVisible();
      const bar = (await toolbar.boundingBox())!;
      const table = (await editor.block('tbl').boundingBox())!;
      expect(bar.y + bar.height).toBeLessThanOrEqual(table.y + 1);

      await toolbar.getByRole('button', { name }).click();
      const grid = (await editor.blockData('tbl'))!.rows!;
      expect(grid).toHaveLength(rows);
      expect(grid[0]).toHaveLength(columns);
      await expect(editor.liveRegion).toHaveText(announce);
      expect(await caretCell(editor)).toBe(focus);
    });
  }

  test('TB5 F10 enters the toolbar; arrows and Home/End rove; Escape returns to the cell', async ({
    editor,
    page,
  }) => {
    // Was FINDING F13, fixed; see docs/e2e-progress.md.
    await editor.load({ doc: 'table' });
    await editor.placeCaret('tbl', 1, 1, { row: 2, column: 2 });
    // The toolbar follows the asynchronous selectionchange. F10 before it is
    // shown focuses a hidden button and drops focus -- a race no person can
    // win, so wait for it the way a person would.
    await expect(editor.portal('table-toolbar')).toBeVisible();
    const buttons = editor.portal('table-toolbar').getByRole('button');
    await page.keyboard.press('F10');
    await expect(buttons.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(buttons.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft'); // wraps
    await expect(buttons.nth(5)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(buttons.nth(0)).toBeFocused();
    await page.keyboard.press('End');
    await expect(buttons.nth(5)).toBeFocused();
    await page.keyboard.press('Escape');
    expect(await caretCell(editor)).toBe('2:2');
    await expect(editor.cell('tbl', 2, 2)).toBeFocused();
  });

  test('TB6 deleting the last row or column empties the grid rather than removing the table', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await editor.setDocument({
      blocks: [{ id: 'tbl', type: 'table', depth: 0, content: [], rows: [[[{ text: 'only' }]]] }],
    });
    await editor.placeCaret('tbl', 0, 0, { row: 0, column: 0 });
    await editor.portal('table-toolbar').getByRole('button', { name: 'Delete this row' }).click();
    expect((await editor.blockData('tbl'))?.rows).toEqual([[[]]]);
    await page.keyboard.type('x');
    await editor
      .portal('table-toolbar')
      .getByRole('button', { name: 'Delete this column' })
      .click();
    expect((await editor.blockData('tbl'))?.rows).toEqual([[[]]]);
    expect(await editor.ids()).toEqual(['tbl']);
  });

  test('TB7 Escape in a cell selects the table; Mod+A takes the cell, then every block', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await editor.placeCaret('tbl', 1, 1, { row: 1, column: 0 });
    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual(['tbl']);

    await editor.placeCaret('tbl', 1, 1, { row: 1, column: 0 });
    await page.keyboard.press(`${MOD}+a`);
    expect(await editor.selection()).toMatchObject({
      cell: { row: 1, column: 0 },
      range: { start: 0, end: 2 },
    });
    await page.keyboard.press(`${MOD}+a`);
    expect(await editor.selected()).toEqual(['before', 'tbl', 'after']);
  });

  test('TB8 the table toolbar shows even with toolbar:false; a wide table scrolls inside itself', async ({
    editor,
  }) => {
    await editor.load({ doc: 'table', toolbar: false });
    await editor.placeCaret('tbl', 0, 0, { row: 0, column: 0 });
    await expect(editor.portal('table-toolbar')).toBeVisible();

    const wide = Array.from({ length: 3 }, (_, row) =>
      Array.from({ length: 30 }, (_, column) => [{ text: `row ${row} column ${column}` }]),
    );
    await editor.setDocument({
      blocks: [{ id: 'tbl', type: 'table', depth: 0, content: [], rows: wide }],
    });
    const overflow = await editor
      .block('tbl')
      .locator('.neditor-table')
      .evaluate((element) => ({
        scrolls: element.scrollWidth > element.clientWidth,
        page: document.documentElement.scrollWidth <= window.innerWidth,
      }));
    expect(overflow).toEqual({ scrolls: true, page: true });
    await editor.placeCaret('tbl', 0, 0, { row: 1, column: 29 });
    await editor.type('!');
    expect((await editor.blockData('tbl'))?.rows?.[1]?.[29]).toEqual([
      { text: '!row 1 column 29' },
    ]);
  });

  test('TB9 table Markdown is a GFM table', async ({ editor }) => {
    await editor.load({ doc: 'table' });
    expect(await editor.markdown()).toContain(
      '| H1 | H2 | H3 |\n| --- | --- | --- |\n| a1 | a2 | a3 |\n| b1 | b2 | b3 |',
    );
  });
});
