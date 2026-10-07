import type { Locator } from '@playwright/test';
import { expect, MOD, test } from '../helpers/test.ts';

async function inViewport(portal: Locator, width: number, height: number): Promise<void> {
  const box = (await portal.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
}

test.describe('18 · popover ownership & viewport', () => {
  test('PO1 Escape after clicking away acts on the new block; the caret does not jump back', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await editor.placeCaret('a', 0, 5);
    await page.keyboard.press(`${MOD}+k`);
    await expect(editor.portal('link-editor')).toBeVisible();

    await editor.clickAt('d', 3);
    await expect(editor.portal('link-editor')).toBeHidden();
    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual(['d']);
  });

  test('PO2 Escape in one table cell does not dismiss a popover another cell opened', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await editor.placeCaret('tbl', 0, 2, { row: 1, column: 0 });
    await page.keyboard.press(`${MOD}+k`);
    await expect(editor.portal('link-editor')).toBeVisible();
    await editor.cell('tbl', 2, 2).click();
    await expect(editor.portal('link-editor')).toBeHidden();
    await page.keyboard.press('Escape');
    // The Escape belonged to cell 2:2: it stepped up to the table.
    expect(await editor.selected()).toEqual(['tbl']);
  });

  test('PO3 a page scroll closes menus and popovers but not the table toolbar; a scroll inside a portal closes nothing', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'kitchen-sink', scroll: 1 });
    await editor.placeCaret('tbl', 0, 0, { row: 1, column: 0 });
    await editor.settle();
    await expect(editor.portal('table-toolbar')).toBeVisible();
    await page.mouse.wheel(0, 40);
    await editor.settle();
    await expect(editor.portal('table-toolbar')).toBeVisible();

    await editor.placeCaret('end', 0);
    await editor.settle();
    await editor.type('/');
    await expect(editor.portal('slash-menu')).toBeVisible();
    // Scroll the menu's own list: the menu stays.
    const list = editor.portal('slash-menu').locator('[role=listbox]');
    await list.evaluate((element) => {
      element.scrollTop = 120;
      element.dispatchEvent(new Event('scroll'));
    });
    await editor.settle();
    await expect(editor.portal('slash-menu')).toBeVisible();
    await page.mouse.wheel(0, 40);
    await expect(editor.portal('slash-menu')).toBeHidden();

    await editor.placeCaret('para', 0, 5);
    await editor.settle();
    await page.keyboard.press(`${MOD}+k`);
    await expect(editor.portal('link-editor')).toBeVisible();
    await page.evaluate(() => window.scrollBy(0, 30));
    await expect(editor.portal('link-editor')).toBeHidden();
  });

  for (const [width, height] of [
    [1100, 800],
    [375, 667],
  ] as const) {
    test(`PO4 every portal stays inside a ${width}×${height} viewport`, async ({
      editor,
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await editor.load({ doc: 'kitchen-sink' });

      // Blocks near the top, so placing the caret does not scroll (a scroll closes them).
      await editor.placeCaret('para', 0, 5);
      await editor.settle();
      await inViewport(editor.portal('toolbar'), width, height);
      await page.keyboard.press(`${MOD}+k`);
      await inViewport(editor.portal('link-editor'), width, height);
      await page.keyboard.press('Escape');

      await editor.placeCaret('h2', 0);
      await editor.settle();
      await editor.type('/');
      await inViewport(editor.portal('slash-menu'), width, height);
      await page.keyboard.press('Escape');

      await editor.clickControl(editor.block('img').locator('.neditor-image__trigger'));
      await inViewport(editor.portal('image-editor'), width, height);
      await page.keyboard.press('Escape');

      await editor.clickControl(editor.block('co').locator('.neditor-block__icon'));
      await inViewport(editor.portal('icon-picker'), width, height);
      await page.keyboard.press('Escape');

      await editor.placeCaret('tbl', 0, 0, { row: 1, column: 1 });
      await editor.settle();
      await inViewport(editor.portal('table-toolbar'), width, height);
    });
  }
});
