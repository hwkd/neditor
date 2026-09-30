import { expect, MOD, test } from '../helpers/test.ts';
import { writeClipboard } from '../helpers/clipboard.ts';

test.describe('17 · read-only', () => {
  test('RO1 nothing is editable, and typing, deleting and pasting change nothing', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'kitchen-sink', editable: false });
    await expect(editor.root.locator('[contenteditable="true"]')).toHaveCount(0);
    const before = await editor.doc();

    await writeClipboard(page, { text: 'pasted' });
    await editor.clickAt('para', 2); // plain text, not the link
    await page.keyboard.type('typed');
    // Delete rather than Backspace: Playwright's WebKit still maps Backspace
    // outside an editable field to history.back(), which Safari no longer does.
    await page.keyboard.press('Delete');
    await page.keyboard.press('Enter');
    await page.keyboard.press(`${MOD}+v`);
    expect(page.url()).toContain('doc=kitchen-sink');

    expect(await editor.doc()).toEqual(before);
    expect(await editor.events('change')).toEqual([]);
    await expect(editor.content('para')).not.toContainText('typed');
  });

  test('RO2 controls do not write: checkbox, icon and image are inert; the chevron only changes the view', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'kitchen-sink', editable: false });
    const before = await editor.doc();

    await editor.block('td').locator('.neditor-block__checkbox').click();
    await editor.block('co').locator('.neditor-block__icon').click();
    await expect(editor.portal('icon-picker')).toBeHidden();
    await expect(editor.block('img').locator('.neditor-image__trigger')).toBeDisabled();

    await editor.block('tg').locator('.neditor-block__chevron').click();
    await expect(editor.block('tgc')).toHaveCount(0);
    await expect(editor.block('tg').locator('.neditor-block__chevron')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await editor.block('tg').locator('.neditor-block__chevron').click();
    await expect(editor.block('tgc')).toBeVisible();

    expect(await editor.doc()).toEqual(before);
    expect(await editor.events('change')).toEqual([]);
    expect(await editor.canUndo()).toBe(false);
    await page.keyboard.press(`${MOD}+z`);
  });

  test('RO3 no toolbar, gutter or menu ever appears', async ({ editor, page }) => {
    await editor.load({ doc: 'kitchen-sink', editable: false });
    await editor.dragText(['para', 0], ['para', 5]);
    await editor.hoverBlock('h2');
    await editor.content('h3').click();
    await page.keyboard.type('/');
    await page.keyboard.press(`${MOD}+k`);
    await editor.cell('tbl', 1, 0).click();
    await expect(page.locator('.neditor-portal:not([hidden])')).toHaveCount(0);
    await expect(editor.gutter).not.toHaveAttribute('data-visible', 'true');
  });

  test('RO4 a plain click on a link opens it in a new tab', async ({ editor, context }) => {
    await context.route(/^https:\/\/example\.com\//, (route) =>
      route.fulfill({ contentType: 'text/html', body: 'stub' }),
    );
    await editor.load({ doc: 'links', editable: false });
    const opened = context.waitForEvent('page');
    await editor.content('p1').locator('a').click();
    const tab = await opened;
    expect(tab.url()).toBe('https://example.com/docs');
    expect(await tab.evaluate(() => window.opener)).toBeNull();
    await tab.close();
  });

  test('RO6 setEditable(false) at runtime closes what was open; true restores editing', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'toggle-open' });
    await editor.placeCaret('before', 0, 6);
    await page.keyboard.press(`${MOD}+k`);
    await expect(editor.portal('link-editor')).toBeVisible();
    await page.evaluate(() => window.__e2e.editor.setEditable(false));
    await expect(page.locator('.neditor-portal:not([hidden])')).toHaveCount(0);
    await expect(editor.root.locator('[contenteditable="true"]')).toHaveCount(0);

    // A reader collapses the toggle; returning to editing discards that view state.
    await editor.block('tg').locator('.neditor-block__chevron').click();
    await expect(editor.block('child1')).toHaveCount(0);
    await page.evaluate(() => window.__e2e.editor.setEditable(true));
    await expect(editor.block('child1')).toBeVisible();

    await editor.caretAtEnd('after');
    await editor.type('!');
    expect((await editor.texts()).at(-1)).toBe('After!');
  });
});
