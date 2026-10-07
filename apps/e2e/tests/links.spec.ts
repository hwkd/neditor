import { expect, MOD, test } from '../helpers/test.ts';

test.describe('07 · links', () => {
  test.beforeEach(async ({ context }) => {
    // Never reach the network: any page a link opens gets a stub.
    await context.route(/^https:\/\/(example\.com|x\.y)\//, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>stub</title><p>stub</p>' }),
    );
  });

  test('L1 Mod+K and the toolbar button open the editor; a bare domain becomes https', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    const dialog = editor.portal('link-editor');
    const input = dialog.getByRole('textbox', { name: 'Link URL' });

    await editor.placeCaret('p2', 0, 5);
    await page.keyboard.press(`${MOD}+k`);
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await expect(input).toBeFocused();
    await expect(editor.portal('toolbar')).toBeHidden();
    await input.fill('example.com');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    expect((await editor.blockData('p2'))?.content[0]).toEqual({
      text: 'Bravo',
      link: 'https://example.com/',
    });
    expect(await editor.selection()).toMatchObject({ blockId: 'p2', range: { start: 0, end: 5 } });

    await editor.placeCaret('p3', 0, 7);
    await editor.portal('toolbar').locator('.neditor-toolbar__button--link').click();
    await expect(input).toBeFocused();
    await input.fill('https://x.y/path');
    await page.keyboard.press('Enter');
    expect((await editor.blockData('p3'))?.content[0]).toEqual({
      text: 'Charlie',
      link: 'https://x.y/path',
    });
  });

  for (const unsafe of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x']) {
    test(`L2 "${unsafe}" is refused with a visible, announced error`, async ({ editor, page }) => {
      await editor.load({ doc: 'paragraphs' });
      const dialog = editor.portal('link-editor');
      const input = dialog.getByRole('textbox', { name: 'Link URL' });
      await editor.placeCaret('p1', 0, 5);
      await page.keyboard.press(`${MOD}+k`);
      await input.fill(unsafe);
      await page.keyboard.press('Enter');
      await expect(dialog).toBeVisible();
      await expect(input).toHaveAttribute('aria-invalid', 'true');
      const errorId = await input.getAttribute('aria-describedby');
      await expect(page.locator(`[id="${errorId}"]`)).toBeVisible();
      await expect(page.locator(`[id="${errorId}"]`)).toHaveText(
        'That is not a URL this editor can use',
      );
      expect((await editor.blockData('p1'))?.content).toEqual([{ text: 'Alpha one' }]);
      await page.keyboard.press('Escape');
    });
  }

  test('L3 Remove and an empty URL both unlink; Remove is hidden without a link', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'links' });
    const dialog = editor.portal('link-editor');
    const remove = dialog.locator('.neditor-link-editor__button--remove');

    await editor.placeCaret('p1', 8, 12);
    await page.keyboard.press(`${MOD}+k`);
    await expect(dialog.getByRole('textbox')).toHaveValue('https://example.com/docs');
    await expect(remove).toBeVisible();
    await remove.click();
    expect((await editor.blockData('p1'))?.content).toEqual([
      { text: 'See the docs for details.' },
    ]);

    await page.keyboard.press(`${MOD}+z`);
    await editor.placeCaret('p1', 8, 12);
    await page.keyboard.press(`${MOD}+k`);
    await dialog.getByRole('textbox').fill('');
    await page.keyboard.press('Enter');
    expect((await editor.blockData('p1'))?.content).toEqual([
      { text: 'See the docs for details.' },
    ]);

    await editor.placeCaret('p2', 0, 5);
    await page.keyboard.press(`${MOD}+k`);
    await expect(remove).toBeHidden();
    await page.keyboard.press('Escape');
  });

  test('L4 Escape cancels and restores the selection', async ({ editor, page }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.placeCaret('p2', 1, 4);
    await page.keyboard.press(`${MOD}+k`);
    await editor.portal('link-editor').getByRole('textbox').fill('https://x.y/');
    await page.keyboard.press('Escape');
    await expect(editor.portal('link-editor')).toBeHidden();
    expect((await editor.blockData('p2'))?.content).toEqual([{ text: 'Bravo two' }]);
    expect(await editor.selection()).toMatchObject({ blockId: 'p2', range: { start: 1, end: 4 } });
    await expect(editor.content('p2')).toBeFocused();
  });

  test('L5 a plain click edits the link; Mod+click opens it in a new tab with no opener', async ({
    editor,
    page,
    context,
  }) => {
    await editor.load({ doc: 'links' });
    const link = editor.content('p1').locator('a.neditor-link');
    const url = page.url();

    await link.click();
    await expect(editor.portal('link-editor')).toBeVisible();
    await expect(editor.portal('link-editor').getByRole('textbox')).toHaveValue(
      'https://example.com/docs',
    );
    // The dialog holds focus; closing it hands back exactly the link's text.
    await page.keyboard.press('Escape');
    expect(await editor.selection()).toMatchObject({ blockId: 'p1', range: { start: 8, end: 12 } });

    const opened = context.waitForEvent('page');
    await link.click({ modifiers: ['ControlOrMeta'] });
    const tab = await opened;
    await tab.waitForLoadState();
    expect(tab.url()).toBe('https://example.com/docs');
    expect(await tab.evaluate(() => window.opener)).toBeNull();
    expect(page.url()).toBe(url);
    await tab.close();
  });

  test('L6 a document carrying unsafe URLs renders none of them', async ({ editor }) => {
    await editor.load({ doc: 'malicious' });
    const hrefs = await editor.root
      .locator('a')
      .evaluateAll((links) => links.map((a) => a.getAttribute('href')));
    expect(hrefs.filter((href) => href && !/^https?:|^mailto:|^tel:/.test(href))).toEqual([]);
    const srcs = await editor.root
      .locator('img')
      .evaluateAll((images) => images.map((img) => img.getAttribute('src')));
    expect(srcs).toEqual([]);
    expect(await editor.texts()).toEqual(['js link data link', '', '']);
  });

  test('L7 a pointer outside the dialog closes it and keeps the focus it placed', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.placeCaret('p2', 0, 5);
    await page.keyboard.press(`${MOD}+k`);
    await expect(editor.portal('link-editor')).toBeVisible();
    await page.locator('#after').click();
    await expect(editor.portal('link-editor')).toBeHidden();
    await expect(page.locator('#after')).toBeFocused();
  });
});
