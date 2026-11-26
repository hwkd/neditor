import { expect, test } from '../helpers/test.ts';

/**
 * A smoke test of the Astro demo site in apps/web. playwright.config.ts starts
 * its dev server on :4391, and a server that fails to start fails the whole
 * run, as any web server in that config does. DEMO_URL points the spec at a
 * demo running elsewhere; if that one is unreachable, these two skip.
 */
const DEMO_URL = process.env.DEMO_URL ?? 'http://localhost:4391/';

test.describe('27 · demo site smoke', () => {
  test.use({ invariants: false });

  test.beforeEach(async ({ request }) => {
    const up = await request
      .get(DEMO_URL)
      .then((response) => response.ok())
      .catch(() => false);
    test.skip(!up, `the demo site is not running at ${DEMO_URL} (start it with: vp dev)`);
  });

  test('DS1 the demo loads cleanly and renders every seeded block type', async ({ page }) => {
    await page.goto(DEMO_URL);
    const editor = page.locator('#editor.neditor');
    await expect(editor).toBeVisible();
    const types = await editor
      .locator(':scope > .neditor-block')
      .evaluateAll((blocks) =>
        [...new Set(blocks.map((block) => (block as HTMLElement).dataset.blockType ?? ''))].sort(
          (a, b) => a.localeCompare(b),
        ),
      );
    expect(types).toEqual(
      [
        'bulleted_list',
        'callout',
        'divider',
        'heading1',
        'heading2',
        'image',
        'paragraph',
        'quote',
        'table',
        'todo',
        'toggle',
      ].sort(),
    );
    await expect
      .poll(() => editor.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
  });

  test('DS2 undo/redo buttons follow history without stealing the caret; the inspector tracks edits', async ({
    page,
  }) => {
    await page.goto(DEMO_URL);
    const undo = page.locator('[data-action="undo"]');
    const redo = page.locator('[data-action="redo"]');
    const markdown = page.locator('[data-output="markdown"]');
    await expect(undo).toBeDisabled();

    await page.locator('[data-block-id="seed-13"] .neditor-block__content').click();
    await page.keyboard.type('smoke test');
    await expect(undo).toBeEnabled();
    await expect(markdown).toContainText('smoke test');

    await undo.click();
    await expect(markdown).not.toContainText('smoke test');
    await expect(redo).toBeEnabled();
    // The caret stayed in the document, so typing goes on where it was.
    await page.keyboard.type('!');
    await expect(markdown).toContainText('!');

    await page.getByRole('tab', { name: 'JSON' }).click();
    await expect(page.locator('[data-output="json"]')).toBeVisible();
    await expect(page.locator('[data-output="json"]')).toContainText('"seed-13"');
  });

  // e2e only: the demo page, real focus and Firefox's form-state restoration.
  test('DS3 pressing Undo from the keyboard until the history is empty hands focus to Redo', async ({
    page,
  }) => {
    // Was A11Y-3: the last undo disabled the button, focus() on it did
    // nothing, focus stayed in the document and the next Space typed there.
    await page.goto(DEMO_URL);
    const undo = page.locator('[data-action="undo"]');
    const redo = page.locator('[data-action="redo"]');
    const markdown = page.locator('[data-output="markdown"]');
    await page.locator('[data-block-id="seed-13"] .neditor-block__content').click();
    await page.keyboard.type('hello');
    await expect(undo).toBeEnabled();

    await undo.focus();
    await page.keyboard.press('Space');
    await expect(undo).toBeDisabled();
    await expect(redo).toBeFocused();
    await expect(markdown).not.toContainText('hello');

    // The next Space redoes rather than typing a space into the document.
    await page.keyboard.press('Space');
    await expect(markdown).toContainText('hello');
    await expect(redo).toBeDisabled();
    await expect(undo).toBeFocused();
  });

  test('DS4 a reload does not bring back enabled history buttons', async ({ page }) => {
    // Was A11Y-6 (Firefox): form-state restoration re-enabled the buttons
    // from before the reload, over a history that no longer existed.
    await page.goto(DEMO_URL);
    await page.locator('[data-block-id="seed-13"] .neditor-block__content').click();
    await page.keyboard.type('abc');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('[data-action="redo"]')).toBeEnabled();

    await page.reload();
    await page.locator('#editor.neditor').waitFor();
    await expect(page.locator('[data-action="undo"]')).toBeDisabled();
    await expect(page.locator('[data-action="redo"]')).toBeDisabled();
  });
});
