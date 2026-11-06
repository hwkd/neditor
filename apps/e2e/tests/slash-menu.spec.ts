import type { Locator } from '@playwright/test';
import { expect, test } from '../helpers/test.ts';
import type { EditorPage } from '../helpers/editor.ts';

const options = (editor: EditorPage): Locator =>
  editor.portal('slash-menu').locator('[role=option]');
const active = (editor: EditorPage): Locator =>
  editor.portal('slash-menu').locator('[role=option][aria-selected=true]');

async function openMenu(editor: EditorPage, query = ''): Promise<void> {
  await editor.placeCaret('p1', 0);
  await editor.type(`/${query}`);
  await expect(editor.portal('slash-menu')).toBeVisible();
}

test.describe('05 · slash menu', () => {
  test('SL1 opens at block start and after a space; not after a letter or in a cell', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await openMenu(editor);
    await page.keyboard.press('Escape');
    await expect(editor.portal('slash-menu')).toBeHidden();

    await editor.type(' word /');
    await expect(editor.portal('slash-menu')).toBeVisible();
    await page.keyboard.press('Escape');

    await editor.type('x/');
    await expect(editor.portal('slash-menu')).toBeHidden();

    await editor.remount({}, 'table');
    await editor.placeCaret('tbl', 0, 0, { row: 1, column: 0 });
    await editor.type('/');
    await expect(editor.portal('slash-menu')).toBeHidden();
  });

  test('SL2 filters by label and keyword prefix, narrows on Backspace, closes on no match or a deleted slash', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await openMenu(editor, 'h1');
    await expect(options(editor)).toHaveText([/Heading 1/]);

    await page.keyboard.press('Backspace'); // "/h"
    expect(await options(editor).count()).toBeGreaterThan(3);

    await page.keyboard.press('Backspace'); // "/"
    await editor.type('acc'); // keyword prefix of "accordion"
    await expect(options(editor)).toHaveText([/Toggle list/]);

    await editor.type('zzz');
    await expect(editor.portal('slash-menu')).toBeHidden();

    await editor.setDocument(await editor.page.evaluate(() => window.__e2e.docs.empty()));
    await openMenu(editor);
    await page.keyboard.press('Backspace');
    await expect(editor.portal('slash-menu')).toBeHidden();
  });

  test('SL3 arrows wrap; Enter and Tab apply; Escape closes and unwires the combobox', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await openMenu(editor);
    const count = await options(editor).count();
    await expect(active(editor)).toHaveText(/Text/);
    await page.keyboard.press('ArrowUp'); // wraps to the last
    await expect(active(editor)).toHaveText(/Divider/);
    await page.keyboard.press('ArrowDown'); // wraps to the first
    await expect(active(editor)).toHaveText(/Text/);
    expect(count).toBe(14);

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect((await editor.doc()).blocks[0]?.type).toBe('heading1');

    await editor.setDocument(await editor.page.evaluate(() => window.__e2e.docs.empty()));
    await openMenu(editor, 'quo');
    await page.keyboard.press('Tab');
    expect((await editor.doc()).blocks[0]?.type).toBe('quote');

    await editor.setDocument(await editor.page.evaluate(() => window.__e2e.docs.empty()));
    await openMenu(editor);
    await expect(editor.content('p1')).toHaveAttribute('role', 'combobox');
    await page.keyboard.press('Escape');
    await expect(editor.portal('slash-menu')).toBeHidden();
    for (const attribute of [
      'role',
      'aria-expanded',
      'aria-controls',
      'aria-activedescendant',
      'aria-haspopup',
    ]) {
      await expect(editor.content('p1')).not.toHaveAttribute(attribute);
    }
    // Escape closed the menu; it did not also step up to block selection.
    expect(await editor.selected()).toEqual([]);
  });

  test('SL4 aria-activedescendant follows the highlight on every path', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await openMenu(editor);
    const host = editor.content('p1');
    const listId = await editor.portal('slash-menu').locator('[role=listbox]').getAttribute('id');
    await expect(host).toHaveAttribute('aria-controls', listId!);
    await expect(host).toHaveAttribute('aria-expanded', 'true');
    await expect(host).toHaveAttribute('aria-haspopup', 'listbox');

    const agrees = async () => {
      const id = await host.getAttribute('aria-activedescendant');
      const activeId = await active(editor).getAttribute('id');
      expect(id).toBe(activeId);
      await expect(active(editor)).toHaveCount(1);
    };

    await agrees();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await agrees();
    await editor.type('list'); // filtering resets the highlight
    await agrees();
    // A real pointer crossing an item (not locator.hover, which waits for the
    // list to stop re-rendering under it -- see FINDING F3).
    const box = (await options(editor).nth(1).boundingBox())!;
    await page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 4 });
    await expect(options(editor).nth(1)).toHaveAttribute('aria-selected', 'true');
    await agrees();
  });

  test('SL5 a mouse click on an item applies the command', async ({ editor, page }) => {
    // Was FINDING F3, fixed; see docs/e2e-progress.md.
    await editor.load({ doc: 'empty' });
    await openMenu(editor);
    const box = (await options(editor).nth(2).boundingBox())!;
    await page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 3 });
    await page.mouse.down();
    await page.mouse.up();
    expect((await editor.doc()).blocks[0]?.type).toBe('heading2');
  });

  test('SL5b a click with one pixel of jitter still applies the command', async ({
    editor,
    page,
  }) => {
    // Was FINDING F3, fixed; see docs/e2e-progress.md.
    await editor.load({ doc: 'empty' });
    await openMenu(editor);
    const box = (await options(editor).nth(2).boundingBox())!;
    const x = box.x + 30;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y, { steps: 3 });
    await page.mouse.down();
    await page.mouse.move(x + 1, y);
    await page.mouse.up();
    expect((await editor.doc()).blocks[0]?.type).toBe('heading2');
  });

  const COMMANDS: Array<[label: string, type: string, selector: string]> = [
    ['Text', 'paragraph', 'div.neditor-block__content'],
    ['Heading 1', 'heading1', 'h1.neditor-block__content'],
    ['Heading 2', 'heading2', 'h2.neditor-block__content'],
    ['Heading 3', 'heading3', 'h3.neditor-block__content'],
    ['Bulleted list', 'bulleted_list', '.neditor-block__marker'],
    ['Numbered list', 'numbered_list', '.neditor-block__marker'],
    ['To-do list', 'todo', 'button.neditor-block__checkbox[role=checkbox]'],
    ['Quote', 'quote', 'blockquote.neditor-block__content'],
    ['Code', 'code', 'pre.neditor-block__pre > code.neditor-block__content'],
    ['Callout', 'callout', 'button.neditor-block__icon'],
    ['Toggle list', 'toggle', 'button.neditor-block__chevron[aria-expanded]'],
    ['Image', 'image', 'button.neditor-image__placeholder'],
    ['Table', 'table', 'table th .neditor-block__content[data-cell="0:0"]'],
    ['Divider', 'divider', 'hr.neditor-block__divider'],
  ];

  for (const [label, type, selector] of COMMANDS) {
    test(`SL6 /${label} makes a ${type}`, async ({ editor, page }) => {
      await editor.load({ doc: 'empty' });
      await openMenu(editor, label.toLowerCase());
      await expect(active(editor)).toContainText(label);
      await page.keyboard.press('Enter');
      const first = (await editor.doc()).blocks[0]!;
      expect(first.type).toBe(type);
      await expect(editor.blocks.first().locator(selector)).toHaveCount(1);

      if (type === 'image') {
        await page.keyboard.press('Escape'); // it opened the image editor
      }
    });
  }

  test('SL7 /divider keeps trailing text; /table rehouses text into cell 0:0; /code strips marks', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'formatted' });
    await editor.placeCaret('p1', 0);
    await editor.type('/divider');
    await page.keyboard.press('Enter');
    let outline = await editor.outline();
    expect(outline.slice(0, 2)).toEqual(['divider:', 'paragraph:plain bold and italic']);
    const kept = (await editor.doc()).blocks[1]!.content;
    expect(kept).toContainEqual({ text: 'bold', marks: ['bold'] });
    expect((await editor.selection())?.blockId).toBe((await editor.ids())[1]);

    await editor.placeCaret('p2', 0);
    await editor.type('/table');
    await page.keyboard.press('Enter');
    const table = (await editor.blockData('p2'))!;
    expect(table.type).toBe('table');
    expect(table.rows?.[0]?.[0]).toEqual([{ text: 'Second paragraph' }]);
    expect(table.rows).toHaveLength(3);

    await editor.remount({}, 'formatted');
    await editor.placeCaret('p1', 0);
    await editor.type('/code');
    await page.keyboard.press('Enter');
    outline = await editor.outline();
    expect((await editor.blockData('p1'))?.content).toEqual([{ text: 'plain bold and italic' }]);
  });

  test('SL7b /image opens the image editor with its URL field focused', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await openMenu(editor, 'image');
    await page.keyboard.press('Enter');
    await expect(editor.portal('image-editor')).toBeVisible();
    await expect(editor.portal('image-editor').locator('input').first()).toBeFocused();
    await page.keyboard.press('Escape');
  });

  test('SL8 closes on outside pointer, scroll, resize, block selection and moving to another block', async ({
    editor,
    page,
  }) => {
    // `long` so the page itself scrolls; the editor starts on screen.
    await editor.load({ doc: 'long' });
    const reopen = async () => {
      await editor.placeCaret('p1', 0);
      await editor.settle();
      await editor.type('/');
      await expect(editor.portal('slash-menu')).toBeVisible();
    };
    const undoSlash = async () => {
      await editor.setDocument(await page.evaluate(() => window.__e2e.docs.long()));
    };

    await reopen();
    await page.locator('#after').click();
    await expect(editor.portal('slash-menu')).toBeHidden();

    await undoSlash();
    await reopen();
    await page.mouse.wheel(0, 200);
    await expect(editor.portal('slash-menu')).toBeHidden();

    await undoSlash();
    await reopen();
    await page.setViewportSize({ width: 1000, height: 760 });
    await expect(editor.portal('slash-menu')).toBeHidden();

    await undoSlash();
    await reopen();
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['p2']));
    await expect(editor.portal('slash-menu')).toBeHidden();

    // Open it low in the document and click above it, so the click cannot land on the menu.
    await undoSlash();
    await editor.placeCaret('p3', 0);
    await editor.settle();
    await editor.type('/');
    await expect(editor.portal('slash-menu')).toBeVisible();
    await editor.clickAt('p1', 3);
    await expect(editor.portal('slash-menu')).toBeHidden();
    // FINDING F5 (minor, not asserted): arrowing the caret back past the "/"
    // leaves the menu open until the next input event, and ArrowUp/Down belong
    // to the menu while it is open, so keyboard caret moves cannot close it.
  });

  test('SL9 near the bottom of the viewport the menu flips above the caret', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'long' });
    // Scroll so that p20 sits near the bottom edge, with the page room above it.
    await editor.block('p20').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      window.scrollBy(0, rect.bottom - window.innerHeight + 30);
    });
    await editor.placeCaret('p20', 0);
    await editor.type('/');
    await expect(editor.portal('slash-menu')).toBeVisible();
    const menu = (await editor.portal('slash-menu').boundingBox())!;
    const block = (await editor.content('p20').boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(block.y + block.height).toBeGreaterThan(viewport.height - 120);
    expect(menu.y + menu.height).toBeLessThanOrEqual(block.y + 1);
    expect(menu.y).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('Escape');
  });
});
