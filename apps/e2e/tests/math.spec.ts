import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import katex from 'katex';
import { expect, MOD, test } from '../helpers/test.ts';
import { shape, writeClipboard } from '../helpers/clipboard.ts';

async function axe(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

/** The atom an inline formula occupies in the model. */
const ATOM = '￼';

test.describe('30 · math', () => {
  test.describe('inline formulas', () => {
    test('M1 typing $…$ makes a formula, drawn by the renderer, and typing goes on after it', async ({
      editor,
    }) => {
      await editor.load({ doc: 'empty', math: 'katex' });
      await editor.placeCaret('p1', 0);
      await editor.type('Let $x^2$');

      expect((await editor.blockData('p1'))?.content).toEqual([
        { text: 'Let ' },
        { text: ATOM, math: 'x^2' },
      ]);
      await expect(editor.content('p1').locator('.neditor-math .katex')).toHaveCount(1);
      expect((await editor.selection())?.range).toEqual({ start: 5, end: 5 });

      await editor.type(' ok');
      expect((await editor.blockData('p1'))?.content).toEqual([
        { text: 'Let ' },
        { text: ATOM, math: 'x^2' },
        { text: ' ok' },
      ]);
      expect(await editor.markdown()).toBe('Let $x^2$ ok');
    });

    test('M1b prose with dollars stays prose', async ({ editor }) => {
      await editor.load({ doc: 'empty', math: 'katex' });
      await editor.placeCaret('p1', 0);
      await editor.type('costs $5 and $6 total');

      expect((await editor.blockData('p1'))?.content).toEqual([{ text: 'costs $5 and $6 total' }]);
      expect(await editor.markdown()).toBe('costs \\$5 and \\$6 total');
    });

    test('M2 clicking a formula edits its TeX in a popover; undo and redo step through it', async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'math', math: 'katex' });
      await editor.content('m1').locator('.neditor-math').first().click();

      const dialog = editor.portal('math-editor');
      const field = dialog.getByRole('textbox');
      await expect(dialog).toBeVisible();
      await expect(field).toHaveValue('\\pi r^2');
      await expect(field).toBeFocused();

      await field.fill('\\tau r^2 / 2');
      await expect(dialog.locator('.katex')).toHaveCount(1);
      await field.press('Enter');

      await expect(dialog).toBeHidden();
      expect((await editor.blockData('m1'))?.content[1]).toEqual({
        text: ATOM,
        math: '\\tau r^2 / 2',
      });
      expect((await editor.selection())?.range).toEqual({ start: 6, end: 6 });

      await page.keyboard.press(`${MOD}+z`);
      expect((await editor.blockData('m1'))?.content[1]?.math).toBe('\\pi r^2');
      await page.keyboard.press(`${MOD}+Shift+z`);
      expect((await editor.blockData('m1'))?.content[1]?.math).toBe('\\tau r^2 / 2');
    });

    test('M3 Mod+Shift+E opens the formula beside the caret; Escape gives the caret back', async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'math', math: 'katex' });
      await editor.placeCaret('m1', 12);
      await page.keyboard.press(`${MOD}+Shift+e`);

      const dialog = editor.portal('math-editor');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('textbox')).toHaveValue('r');

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      expect(await editor.focusedBlock()).toBe('m1');
      expect(await editor.canUndo()).toBe(false);
    });

    test('M3b Mod+Shift+E on selected text turns it into a formula', async ({ editor, page }) => {
      await editor.load({ doc: 'paragraphs', math: 'katex' });
      await editor.placeCaret('p1', 6, 9);
      await page.keyboard.press(`${MOD}+Shift+e`);

      const field = editor.portal('math-editor').getByRole('textbox');
      await expect(field).toHaveValue('one');
      await field.fill('\\omega');
      await field.press('Enter');

      expect((await editor.blockData('p1'))?.content).toEqual([
        { text: 'Alpha ' },
        { text: ATOM, math: '\\omega' },
      ]);
    });

    test('M4 the caret steps over a formula as one character', async ({ editor, page }) => {
      await editor.load({ doc: 'math', math: 'katex' });
      await editor.placeCaret('m1', 5);
      await page.keyboard.press('ArrowRight');
      expect((await editor.selection())?.range).toEqual({ start: 6, end: 6 });
      await page.keyboard.press('ArrowRight');
      expect((await editor.selection())?.range).toEqual({ start: 7, end: 7 });
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      expect((await editor.selection())?.range).toEqual({ start: 5, end: 5 });
    });

    test('M5 Backspace deletes a formula whole, and undo brings its TeX back', async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'math', math: 'katex' });
      await editor.placeCaret('m1', 6);
      await page.keyboard.press('Backspace');

      expect((await editor.blockData('m1'))?.content).toEqual([
        { text: 'Area  and ' },
        { text: ATOM, math: 'r' },
        { text: ' end' },
      ]);

      await page.keyboard.press(`${MOD}+z`);
      expect((await editor.blockData('m1'))?.content[1]).toEqual({ text: ATOM, math: '\\pi r^2' });
    });

    test('M6 read-only, a formula is only something to look at', async ({ editor }) => {
      await editor.load({ doc: 'math', math: 'katex', editable: false });
      await editor.content('m1').locator('.neditor-math').first().click();
      await expect(editor.portal('math-editor')).toBeHidden();
      expect(await editor.canUndo()).toBe(false);
    });
  });

  test.describe('display equations', () => {
    test('M7 typing $$ makes an equation; its picture follows the TeX and stands in once the caret leaves', async ({
      editor,
    }) => {
      await editor.load({ doc: 'math', math: 'katex' });
      await editor.caretAtEnd('p2');
      await editor.press('Enter');
      await editor.type('$$');

      const id = (await editor.ids())[3]!;
      expect((await editor.blockData(id))?.type).toBe('math');

      await editor.type('a^2 + b^2');
      // Enter is a line of TeX, not a new block.
      await editor.press('Enter');
      await editor.type('= c^2');
      expect((await editor.blockData(id))?.content).toEqual([{ text: 'a^2 + b^2\n= c^2' }]);

      const box = editor.block(id).locator('.neditor-math-block');
      const preview = box.locator('.neditor-math-block__preview');
      await expect(preview.locator('.katex-display')).toHaveCount(1);
      await expect(editor.content(id)).toBeVisible();

      // Away from it, only the picture shows -- and the source can still take the caret.
      await editor.placeCaret('p2', 0);
      await expect(box).toHaveAttribute('data-rendered', 'true');
      const hidden = await editor
        .content(id)
        .evaluate((host) => host.getBoundingClientRect().width);
      expect(hidden).toBeLessThanOrEqual(1);
      await expect(preview).toBeVisible();

      await preview.click();
      expect(await editor.focusedBlock()).toBe(id);
      await expect(editor.content(id)).toBeVisible();

      expect(await editor.markdown()).toContain('$$\na^2 + b^2\n= c^2\n$$');
    });

    test('M8 typing in an equation is one undo step, and its picture follows undo', async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'math', math: 'katex' });
      await editor.caretAtEnd('eq');
      await editor.type(' + 1');
      expect(await editor.texts()).toContain('E = mc^2 + 1');

      await page.keyboard.press(`${MOD}+z`);
      expect((await editor.blockData('eq'))?.content).toEqual([{ text: 'E = mc^2' }]);
      await expect(
        editor.block('eq').locator('.neditor-math-block__preview .katex-display'),
      ).toHaveCount(1);
    });

    test('M8b no inline rule fires inside an equation', async ({ editor }) => {
      await editor.load({ doc: 'math', math: 'katex' });
      await editor.caretAtEnd('eq');
      await editor.type(' $x$ *y*');
      expect((await editor.blockData('eq'))?.content).toEqual([{ text: 'E = mc^2 $x$ *y*' }]);
    });
  });

  test.describe('clipboard', () => {
    test('M9 copying formulas and an equation into another editor reproduces them', async ({
      editor,
      page,
    }) => {
      await editor.load({ mount: 'two', doc: 'math', math: 'katex' });
      await page.evaluate(() => window.__e2e.editor.selectBlocks(['m1', 'eq', 'p2']));
      await page.keyboard.press(`${MOD}+c`);

      const second = editor.other();
      await second.content('p1').click();
      await page.keyboard.press(`${MOD}+v`);

      expect(shape(await second.doc())).toEqual(shape(await editor.doc()));
      await expect(second.root.locator('.neditor-math .katex')).toHaveCount(2);
    });

    test('M10 KaTeX pasted from another page arrives as its TeX', async ({
      editor,
      page,
      browserName,
    }) => {
      const inline = katex.renderToString('\\frac{1}{2}');
      const display = katex.renderToString('\\sum_{i=1}^n i', { displayMode: true });

      await editor.load({ doc: 'empty', math: 'katex' });
      await editor.placeCaret('p1', 0);
      await writeClipboard(page, {
        html: `<p>Half is ${inline}.</p><p>${display}</p>`,
        text: 'Half is 1/2.',
      });
      await page.keyboard.press(`${MOD}+v`);

      const blocks = (await editor.doc()).blocks;

      // WebKit's clipboard sanitizer drops the never-rendered <annotation>
      // that holds the TeX (measured: the classes and the MathML survive, the
      // annotation does not), so there is nothing to recover. What is pinned
      // there is the fallback: the formula as drawn, once -- not its MathML
      // copy and its HTML copy run together ("1221").
      if (browserName === 'webkit') {
        expect(blocks.every((block) => block.type === 'paragraph')).toBe(true);
        expect(blocks[0]?.content.some((run) => run.math !== undefined)).toBe(false);
        expect(blocks[0]?.content.map((run) => run.text).join('')).not.toContain('1221');
        return;
      }

      expect(blocks.map((block) => [block.type, block.content])).toEqual([
        ['paragraph', [{ text: 'Half is ' }, { text: ATOM, math: '\\frac{1}{2}' }, { text: '.' }]],
        ['math', [{ text: '\\sum_{i=1}^n i' }]],
      ]);
    });

    test('M11 pasted Markdown with formulas reads them back', async ({ editor, page }) => {
      await editor.load({ doc: 'empty', math: 'katex' });
      await editor.placeCaret('p1', 0);
      await writeClipboard(page, { text: 'See $a_1 + b_2$.\n\n$$\n\\|x\\|\n$$' });
      await page.keyboard.press(`${MOD}+v`);

      const blocks = (await editor.doc()).blocks;
      expect(blocks.map((block) => [block.type, block.content])).toEqual([
        ['paragraph', [{ text: 'See ' }, { text: ATOM, math: 'a_1 + b_2' }, { text: '.' }]],
        ['math', [{ text: '\\|x\\|' }]],
      ]);
    });
  });

  test('M12 without a renderer, formulas show their TeX and still work', async ({ editor }) => {
    await editor.load({ doc: 'math' });
    await expect(editor.content('m1').locator('.neditor-math .neditor-math__source')).toHaveText([
      '\\pi r^2',
      'r',
    ]);
    // The source is the only view of the equation, so it is never hidden.
    await expect(editor.content('eq')).toBeVisible();
    await expect(editor.block('eq').locator('.neditor-math-block__preview')).toBeHidden();

    await editor.caretAtEnd('p2');
    await editor.type(' $y$');
    expect((await editor.blockData('p2'))?.content).toEqual([
      { text: 'After ' },
      { text: ATOM, math: 'y' },
    ]);
  });
  test('M13 axe (WCAG 2.1 AA) finds nothing in KaTeX math, read-only, or with the popover open', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'math', math: 'katex' });
    expect(await axe(page)).toEqual([]);

    await editor.content('m1').locator('.neditor-math').first().click();
    await expect(editor.portal('math-editor')).toBeVisible();
    expect(await axe(page)).toEqual([]);

    await editor.load({ doc: 'math', math: 'katex', editable: false });
    expect(await axe(page)).toEqual([]);
  });
});
