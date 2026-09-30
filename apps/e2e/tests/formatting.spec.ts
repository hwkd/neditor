import { expect, MOD, test } from '../helpers/test.ts';

async function shiftSelect(page: import('@playwright/test').Page, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press('Shift+ArrowRight');
  }
}

test.describe('06 · formatting & toolbar', () => {
  test('F1 a mouse selection and a Shift+Arrow selection both raise the toolbar above the text', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    const toolbar = editor.portal('toolbar');

    await editor.dragText(['p2', 0], ['p2', 5]);
    await expect(toolbar).toBeVisible();
    expect((await editor.selection())?.range).toEqual({ start: 0, end: 5 });
    let bar = (await toolbar.boundingBox())!;
    let text = (await editor.content('p2').boundingBox())!;
    expect(bar.y + bar.height).toBeLessThanOrEqual(text.y + 1);
    expect(bar.y).toBeGreaterThanOrEqual(0);

    await page.keyboard.press('ArrowRight');
    await expect(toolbar).toBeHidden();

    await editor.placeCaret('p3', 0);
    await shiftSelect(page, 7);
    await expect(toolbar).toBeVisible();
    bar = (await toolbar.boundingBox())!;
    text = (await editor.content('p3').boundingBox())!;
    expect(bar.y + bar.height).toBeLessThanOrEqual(text.y + 1);
  });

  const MARKS: Array<[mark: string, shortcut: string]> = [
    ['bold', `${MOD}+b`],
    ['italic', `${MOD}+i`],
    ['underline', `${MOD}+u`],
    ['strikethrough', `${MOD}+Shift+x`],
    ['code', `${MOD}+e`],
  ];

  for (const [mark, shortcut] of MARKS) {
    test(`F2 ${mark}: the toolbar button and ${shortcut} both toggle it, without losing the selection`, async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'paragraphs' });
      await editor.placeCaret('p1', 0, 5);
      const button = editor.portal('toolbar').locator(`[data-mark="${mark}"]`);
      await expect(button).toBeVisible();
      await button.click();
      expect((await editor.blockData('p1'))?.content[0]).toEqual({ text: 'Alpha', marks: [mark] });
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      expect((await editor.selection())?.range).toEqual({ start: 0, end: 5 });
      await expect(editor.content('p1')).toBeFocused();

      await page.keyboard.press(shortcut);
      expect((await editor.blockData('p1'))?.content).toEqual([{ text: 'Alpha one' }]);
      await expect(button).toHaveAttribute('aria-pressed', 'false');
    });
  }

  test('F3 pressed only when the whole range has the mark; a partial range gets the rest', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'formatted' });
    await editor.placeCaret('p1', 0, 10); // "plain bold"
    const bold = editor.portal('toolbar').locator('[data-mark="bold"]');
    await expect(bold).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press(`${MOD}+b`);
    expect((await editor.blockData('p1'))?.content.slice(0, 1)).toEqual([
      { text: 'plain bold', marks: ['bold'] },
    ]);
    await expect(bold).toHaveAttribute('aria-pressed', 'true');
  });

  test('F4 a mark armed at a collapsed caret applies to the next typing; moving the caret disarms it', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.caretAtEnd('p2');
    await page.keyboard.press(`${MOD}+b`);
    expect((await editor.selection())?.marks).toEqual(['bold']);
    await editor.type(' X');
    expect((await editor.blockData('p2'))?.content).toEqual([
      { text: 'Bravo two' },
      { text: ' X', marks: ['bold'] },
    ]);

    await editor.caretAtEnd('p3');
    await page.keyboard.press(`${MOD}+i`);
    // Human-paced: Chromium coalesces selectionchange, so two presses inside
    // one frame that end where they started are, to the editor, no move at all.
    await page.keyboard.press('ArrowLeft');
    await editor.settle();
    await page.keyboard.press('ArrowRight');
    await editor.settle();
    await editor.type('y');
    expect((await editor.blockData('p3'))?.content).toEqual([{ text: 'Charlie threey' }]);
  });

  test('F5 marks compose, and the link is the outermost element', async ({ editor, page }) => {
    await editor.load({ doc: 'links' });
    await editor.placeCaret('p1', 8, 12); // "docs", already linked
    await page.keyboard.press(`${MOD}+b`);
    await page.keyboard.press(`${MOD}+i`);
    expect((await editor.blockData('p1'))?.content[1]).toEqual({
      text: 'docs',
      marks: ['bold', 'italic'],
      link: 'https://example.com/docs',
    });
    await expect(editor.content('p1').locator('a.neditor-link > em > strong')).toHaveText('docs');
    await expect(editor.content('p1').locator('a.neditor-link')).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
  });

  test('F6 the toolbar hides on Escape, on scroll, in block mode, and never shows with toolbar:false', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'long' });
    const toolbar = editor.portal('toolbar');

    await editor.placeCaret('p1', 0, 5);
    await expect(toolbar).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(toolbar).toBeHidden();
    expect(await editor.selected()).toEqual([]); // the first Escape only hid it

    await editor.placeCaret('p1', 0, 5);
    await editor.settle();
    await expect(toolbar).toBeVisible();
    await page.mouse.wheel(0, 150);
    await expect(toolbar).toBeHidden();
    await editor.settleScroll();

    // A block still on screen after the scroll, so placing the caret does not
    // scroll again (which would, correctly, hide the toolbar once more).
    await editor.placeCaret('p10', 0, 5);
    await editor.settle();
    await expect(toolbar).toBeVisible();
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['p10']));
    await expect(toolbar).toBeHidden();

    await editor.remount({ toolbar: false }, 'paragraphs');
    await editor.dragText(['p1', 0], ['p1', 5]);
    expect((await editor.selection())?.range).toEqual({ start: 0, end: 5 });
    await expect(page.locator('.neditor-toolbar:not([hidden])')).toHaveCount(0);
  });

  test('F7 undoing a format restores the same selection', async ({ editor, page }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.placeCaret('p2', 0, 5);
    await page.keyboard.press(`${MOD}+b`);
    await page.keyboard.press('End');
    await page.keyboard.press(`${MOD}+z`);
    expect((await editor.blockData('p2'))?.content).toEqual([{ text: 'Bravo two' }]);
    expect(await editor.selection()).toMatchObject({ blockId: 'p2', range: { start: 0, end: 5 } });
  });
});
