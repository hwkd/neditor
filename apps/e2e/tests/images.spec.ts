import { expect, MOD, test } from '../helpers/test.ts';

// A 1×1 transparent PNG.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test.describe('15 · images', () => {
  test('I1 /image opens the editor; a URL renders a real, loaded picture', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await editor.placeCaret('p1', 0);
    await editor.type('/image');
    await page.keyboard.press('Enter');
    const dialog = editor.portal('image-editor');
    await expect(dialog).toBeVisible();
    const url = dialog.getByRole('textbox', { name: 'Link URL' });
    await expect(url).toBeFocused();
    await url.fill('/sample.png');
    await dialog.getByRole('textbox', { name: 'Alt text' }).fill('A sample');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();

    const image = editor.root.locator('img.neditor-image__img');
    await expect(image).toHaveAttribute('src', '/sample.png');
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    // Focus moves to the caption.
    await expect(editor.root.locator('figcaption.neditor-block__content')).toBeFocused();
  });

  for (const unsafe of ['javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zy8+']) {
    test(`I2 "${unsafe.slice(0, 22)}…" is refused with a visible error`, async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'image-empty' });
      await editor.clickControl(editor.block('img').locator('.neditor-image__placeholder'));
      const dialog = editor.portal('image-editor');
      const url = dialog.getByRole('textbox', { name: 'Link URL' });
      await url.fill(unsafe);
      await page.keyboard.press('Enter');
      await expect(dialog).toBeVisible();
      await expect(url).toHaveAttribute('aria-invalid', 'true');
      await expect(dialog.locator('.neditor-image-editor__error')).toBeVisible();
      expect((await editor.blockData('img'))?.src).toBe('');
      await page.keyboard.press('Escape');
    });
  }

  test('I2b a base64 PNG data URL is accepted', async ({ editor, page }) => {
    await editor.load({ doc: 'image-empty' });
    await editor.clickControl(editor.block('img').locator('.neditor-image__placeholder'));
    await editor.portal('image-editor').getByRole('textbox', { name: 'Link URL' }).fill(PNG);
    await page.keyboard.press('Enter');
    expect((await editor.blockData('img'))?.src).toBe(PNG);
  });

  test('I3 the alt text is the picture’s accessible name; the trigger sits over it, not around it', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'image' });
    await expect(page.getByRole('img', { name: 'A blue gradient' })).toBeVisible();
    const structure = await editor.block('img').evaluate((view) => {
      const img = view.querySelector('img')!;
      const trigger = view.querySelector('.neditor-image__trigger')!;
      const a = img.getBoundingClientRect();
      const b = trigger.getBoundingClientRect();
      return {
        wrapped: trigger.contains(img),
        siblings: img.parentElement === trigger.parentElement,
        covers:
          b.left <= a.left + 1 &&
          b.right >= a.right - 1 &&
          b.top <= a.top + 1 &&
          b.bottom >= a.bottom - 1,
      };
    });
    expect(structure).toEqual({ wrapped: false, siblings: true, covers: true });
    await expect(
      page.getByRole('button', { name: 'Edit image source and alt text' }),
    ).toBeVisible();
  });

  test('I4 Remove, or an empty URL, turns the block back into a paragraph', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'image' });
    const trigger = editor.block('img').locator('.neditor-image__trigger');
    await editor.clickControl(trigger);
    await editor.portal('image-editor').getByRole('button', { name: 'Remove' }).click();
    expect(await editor.blockData('img')).toMatchObject({ type: 'paragraph' });

    await page.keyboard.press(`${MOD}+z`);
    await editor.clickControl(editor.block('img').locator('.neditor-image__trigger'));
    await editor.portal('image-editor').getByRole('textbox', { name: 'Link URL' }).fill('');
    await page.keyboard.press('Enter');
    expect((await editor.blockData('img'))?.type).toBe('paragraph');
  });

  test('I5 the caption is rich text; Backspace at its start selects the image', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'image' });
    await editor.placeCaret('img', 0, 1);
    await page.keyboard.press(`${MOD}+b`);
    expect((await editor.blockData('img'))?.content[0]).toEqual({ text: 'A', marks: ['bold'] });
    await editor.placeCaret('img', 0);
    await page.keyboard.press('Backspace');
    expect(await editor.selected()).toEqual(['img']);
    expect((await editor.blockData('img'))?.src).toBe('/sample.png');
  });

  test('I6 read-only disables both image buttons', async ({ editor }) => {
    await editor.load({ doc: 'image', editable: false });
    await expect(editor.block('img').locator('.neditor-image__trigger')).toBeDisabled();
    await editor.load({ doc: 'image-empty', editable: false });
    await expect(editor.block('img').locator('.neditor-image__placeholder')).toBeDisabled();
  });
});
