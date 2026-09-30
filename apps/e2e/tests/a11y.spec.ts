import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, MOD, test } from '../helpers/test.ts';

async function axe(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

test.describe('21 · accessibility', () => {
  test.describe('A1 axe (WCAG 2.1 AA) finds nothing', () => {
    test('default kitchen-sink document', async ({ editor, page }) => {
      await editor.load({ doc: 'kitchen-sink' });
      expect(await axe(page)).toEqual([]);
    });

    test('dark theme', async ({ editor, page }) => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await editor.load({ doc: 'kitchen-sink', theme: 'dark' });
      expect(await axe(page)).toEqual([]);
    });

    test('read-only', async ({ editor, page }) => {
      await editor.load({ doc: 'kitchen-sink', editable: false });
      expect(await axe(page)).toEqual([]);
    });

    test('slash menu open', async ({ editor, page }) => {
      // Was FINDING F9, fixed; see docs/e2e-progress.md.
      await editor.load({ doc: 'empty' });
      await editor.placeCaret('p1', 0);
      await editor.type('/');
      await expect(editor.portal('slash-menu')).toBeVisible();
      expect(await axe(page)).toEqual([]);
    });

    test('format toolbar and link editor open', async ({ editor, page }) => {
      await editor.load({ doc: 'paragraphs' });
      await editor.placeCaret('p1', 0, 5);
      await expect(editor.portal('toolbar')).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await page.keyboard.press(`${MOD}+k`);
      await expect(editor.portal('link-editor')).toBeVisible();
      expect(await axe(page)).toEqual([]);
    });

    test('image editor and icon picker open', async ({ editor, page }) => {
      await editor.load({ doc: 'kitchen-sink' });
      await editor.clickControl(editor.block('img').locator('.neditor-image__trigger'));
      await expect(editor.portal('image-editor')).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await page.keyboard.press('Escape');
      await editor.clickControl(editor.block('co').locator('.neditor-block__icon'));
      await expect(editor.portal('icon-picker')).toBeVisible();
      expect(await axe(page)).toEqual([]);
    });

    test('block selection and table toolbar', async ({ editor, page }) => {
      await editor.load({ doc: 'kitchen-sink' });
      await page.evaluate(() => window.__e2e.editor.selectBlocks(['bl', 'bl2']));
      expect(await axe(page)).toEqual([]);
      await editor.placeCaret('tbl', 0, 0, { row: 1, column: 0 });
      await expect(editor.portal('table-toolbar')).toBeVisible();
      expect(await axe(page)).toEqual([]);
    });
  });

  test('A2 blocks keep their own semantics; content never takes role="textbox"', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'kitchen-sink' });
    await expect(page.getByRole('heading', { level: 1, name: 'Heading one' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Heading two' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'Heading three' })).toBeVisible();
    await expect(page.getByRole('blockquote')).toHaveCount(1);
    await expect(page.getByRole('checkbox', { name: 'To-do' })).toBeChecked();
    await expect(page.getByRole('button', { name: 'Expand or collapse' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(page.getByRole('img', { name: 'A blue gradient' })).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(1);
    await expect(
      editor.root.locator('[role="textbox"], [aria-multiline], [aria-selected]'),
    ).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Rich text editor' })).toBeVisible();
  });

  test('A3 the live region announces each state change', async ({ editor, page }) => {
    await editor.load({ doc: 'kitchen-sink' });
    const region = editor.liveRegion;
    await expect(region).toHaveAttribute('role', 'status');
    await expect(region).toHaveAttribute('aria-live', 'polite');

    await editor.block('td').locator('.neditor-block__checkbox').click();
    await expect(region).toHaveText('Unchecked');
    await editor.block('tg').locator('.neditor-block__chevron').click();
    await expect(region).toHaveText('Toggle collapsed');
    await editor.block('tg').locator('.neditor-block__chevron').click();
    await expect(region).toHaveText('Toggle expanded');

    await editor.placeCaret('end', 0);
    await page.keyboard.press(`${MOD}+z`);
    await expect(region).toHaveText('Undone');
    await page.keyboard.press(`${MOD}+Shift+z`);
    await expect(region).toHaveText('Redone');

    await page.evaluate(() => window.__e2e.editor.setBlockType('end', 'heading1'));
    await expect(region).toHaveText('Changed to Heading 1');

    await page.evaluate(() => window.__e2e.editor.selectBlocks(['qt']));
    await expect(region).toHaveText('Quote selected, A quote');
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['hr']));
    await expect(region).toHaveText('Empty Divider selected');

    // The same message twice is announced twice (blanked, then set).
    await editor.clearLog();
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['qt']));
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['hr']));
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['qt']));
    await expect
      .poll(() => editor.announcements())
      .toEqual(['Quote selected, A quote', 'Empty Divider selected', 'Quote selected, A quote']);
  });

  test('A4 a keyboard-only journey: in, build, reach every control, and out', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await page.locator('#before').focus();
    await page.keyboard.press('Tab');
    await expect(editor.content('p1')).toBeFocused();

    await editor.type('Title');
    await page.keyboard.press('Enter');
    await editor.type('/toggle');
    await page.keyboard.press('Enter');
    await editor.type('Details');
    await page.keyboard.press('Enter'); // a child of the toggle
    await editor.type('Hidden inside');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Backspace'); // an empty nested block outdents
    await editor.type('/callout');
    await page.keyboard.press('Enter');
    await editor.type('Note');
    expect(await editor.outline()).toEqual([
      'paragraph:Title',
      'toggle:Details',
      '  paragraph:Hidden inside',
      'callout:Note',
    ]);

    // Shift+Tab at depth 0 from the callout's text reaches its icon button.
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Change icon' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(editor.portal('icon-picker')).toBeVisible();
    await page.keyboard.press('Escape');

    // The toggle's chevron is reachable the same way, and Space operates it.
    const toggle = (await editor.doc()).blocks.find((block) => block.type === 'toggle')!;
    await editor.caretAtEnd(toggle.id);
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Expand or collapse' })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Expand or collapse' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    // Out: Escape twice from text releases focus.
    await editor.caretAtEnd(toggle.id);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    expect(await editor.hasFocus()).toBe(false);
  });

  test('A5 every name, placeholder, menu entry and announcement can be translated', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty', labels: 'fr' });
    await expect(page.getByRole('group', { name: 'Éditeur de texte' })).toBeVisible();
    await editor.placeCaret('p1', 0);
    const placeholder = await editor
      .content('p1')
      .evaluate((element) => getComputedStyle(element, '::before').content);
    expect(placeholder).toContain('Tapez « / » pour les commandes');

    await editor.type('/titre');
    await expect(
      editor.portal('slash-menu').getByRole('listbox', { name: 'Types de bloc' }),
    ).toBeVisible();
    await expect(editor.portal('slash-menu').getByRole('option')).toHaveText([/Titre 1/]);
    await page.keyboard.press('Enter');
    await editor.type('Bonjour');
    await page.keyboard.press(`${MOD}+a`);
    await expect(page.getByRole('toolbar', { name: 'Mise en forme' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Gras' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(editor.liveRegion).toHaveText('Titre 1 sélectionné, Bonjour');
  });
});
