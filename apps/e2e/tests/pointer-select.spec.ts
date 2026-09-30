import { expect, MOD, test } from '../helpers/test.ts';
import { FIREFOX_BLOCK_CLIPBOARD } from '../helpers/clipboard.ts';

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

    // Back into the anchor block: the selection shrinks to that block alone.
    await page.mouse.move(start.x + 20, start.y, { steps: 12 });
    expect(await editor.selected()).toEqual(['a']);
    await page.mouse.up();
    await expect(editor.root).not.toHaveAttribute('data-selecting', 'true');
    await page.keyboard.press('Escape');

    await editor.dragText(['b', 2], ['d', 2]);
    expect(await editor.selected()).toEqual(['b', 'c', 'd']);
    await page.keyboard.press('Backspace');
    expect(await editor.ids()).toEqual(['a', 'e']);
  });

  test('P2 a release below the last block selects through the last block', async ({
    editor,
    page,
    browserName,
  }) => {
    test.fail(
      browserName === 'webkit',
      'FINDING F7: WebKit leaves focus and a live text selection in the last block host after the release, while block selection is active',
    );
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
    browserName,
  }) => {
    await editor.load({ doc: 'five', editable: false });
    await editor.dragText(['a', 1], ['b', 3]);
    expect(await editor.selected()).toEqual(['a', 'b']);

    test.fail(browserName === 'firefox', FIREFOX_BLOCK_CLIPBOARD);
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
});
