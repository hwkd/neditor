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

/**
 * What WebKit's sanitized clipboard leaves of M10's paste: the formulas as
 * KaTeX drew them, each read once (its MathML copy skipped), not their TeX.
 */
const WEBKIT_FALLBACK: unknown[] = [
  // KaTeX draws a fraction's denominator first, and a zero-width space after
  // it. WebKit's serializer writes the space before the formula as a no-break
  // space in an `Apple-converted-space`, which the reader takes back as the
  // space it was (the rich-dom suite's "Safari's converted spaces").
  ['paragraph', [{ text: 'Half is 21\u200B.' }]],
  ['paragraph', [{ text: 'i=1\u2211n\u200Bi' }]],
];

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
      // The caret it was opened from, collapsed -- not the formula, selected.
      expect((await editor.selection())?.range).toEqual({ start: 12, end: 12 });
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

    test('M1c a typed price range is prose: the digit after the second $ takes the formula back', async ({
      editor,
    }) => {
      await editor.load({ doc: 'empty', math: 'katex' });
      await editor.placeCaret('p1', 0);
      await editor.type('Prices run $5-$10 a seat');

      expect((await editor.blockData('p1'))?.content).toEqual([
        { text: 'Prices run $5-$10 a seat' },
      ]);
      expect(await editor.markdown()).toBe('Prices run \\$5-\\$10 a seat');
    });

    test('M5b after a formula that ends a block, a click and End both put the caret after it, and typing lands there', async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'math', math: 'katex' });
      const box = (await editor.content('m2').boundingBox())!;

      await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
      expect((await editor.selection())?.range).toEqual({ start: 11, end: 11 });
      await editor.press('End');
      expect((await editor.selection())?.range).toEqual({ start: 11, end: 11 });
      await editor.type('z');

      expect((await editor.blockData('m2'))?.content).toEqual([
        { text: 'Ends with ' },
        { text: ATOM, math: 'y' },
        { text: 'z' },
      ]);
    });

    test('M5e the toolbar offers ∑ for text, and nothing over a lone formula or in an equation', async ({
      editor,
    }) => {
      await editor.load({ doc: 'math', math: 'katex' });
      const toolbar = editor.portal('toolbar');

      await editor.placeCaret('m1', 0, 4);
      await expect(toolbar).toBeVisible();
      await toolbar.locator('.neditor-toolbar__button--math').click();
      await expect(editor.portal('math-editor').getByRole('textbox')).toHaveValue('Area');
      await editor.press('Escape');

      await editor.placeCaret('m1', 0, 4);
      await expect(toolbar).toBeVisible();
      await editor.placeCaret('m1', 5, 6);
      await expect(toolbar).toBeHidden();

      await editor.placeCaret('m1', 0, 4);
      await expect(toolbar).toBeVisible();
      await editor.placeCaret('eq', 0, 3);
      await expect(toolbar).toBeHidden();
    });

    test('M5d after a formula that ends a block, one Backspace deletes it', async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'math', math: 'katex' });
      const box = (await editor.content('m2').boundingBox())!;

      // Past the formula: WebKit settles this after the separator, Chromium's
      // End does the same; a caret there is still at the formula's end.
      await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
      await editor.press('End');
      expect((await editor.selection())?.range).toEqual({ start: 11, end: 11 });
      await page.keyboard.press('Backspace');

      expect((await editor.blockData('m2'))?.content).toEqual([{ text: 'Ends with ' }]);
    });

    for (const [name, chord] of [
      ['a word', process.platform === 'darwin' ? 'Alt+Backspace' : 'Control+Backspace'],
      ['to the line start', process.platform === 'darwin' ? 'Meta+Backspace' : 'Shift+Home'],
    ] as const) {
      test(`M5f after a formula that ends a block, deleting ${name} takes the formula with it`, async ({
        editor,
        page,
      }) => {
        await editor.load({ doc: 'math', math: 'katex' });
        await editor.placeCaret('m2', 11);
        await editor.press('End');

        if (chord === 'Shift+Home') {
          await page.keyboard.press(chord);
          await page.keyboard.press('Backspace');
        } else {
          await page.keyboard.press(chord);
        }

        // A line deletion takes the line. A word deletion takes the formula
        // alone, the formula being the word, in every engine: Firefox's own
        // word rule on macOS asks for the word before the formula too (its
        // target range reaches past it), and left to the browser ⌥⌫ took
        // "Ends with " with it, as it took "Area " in mid-text (M5h).
        expect((await editor.blockData('m2'))?.content).toEqual(
          name === 'a word' ? [{ text: 'Ends with ' }] : [],
        );
      });
    }

    test('M5h in mid-text, a word deletion either way takes the formula alone, in every engine', async ({
      editor,
      page,
    }) => {
      const word = process.platform === 'darwin' ? 'Alt' : 'Control';
      await editor.load({ doc: 'math', math: 'katex' });
      // Just after the first formula: "Area ⟨π r²⟩| and ⟨r⟩ end".
      await editor.placeCaret('m1', 6);
      await page.keyboard.press(`${word}+Backspace`);

      expect((await editor.blockData('m1'))?.content).toEqual([
        { text: 'Area  and ' },
        { text: ATOM, math: 'r' },
        { text: ' end' },
      ]);

      // Just before it, from a fresh document.
      await editor.load({ doc: 'math', math: 'katex' });
      await editor.placeCaret('m1', 5);
      await page.keyboard.press(`${word}+Delete`);

      expect((await editor.blockData('m1'))?.content).toEqual([
        { text: 'Area  and ' },
        { text: ATOM, math: 'r' },
        { text: ' end' },
      ]);
    });

    test('M5g from past the separator, a word deletion takes the formula alone, in every engine', async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'math', math: 'katex' });
      await editor.placeCaret('m2', 11);
      // The caret after the separator image, where WebKit's click and
      // Chromium's End put it, and where Firefox's own word deletion did
      // nothing.
      await editor.content('m2').evaluate((host) => {
        const separator = host.querySelector('.neditor-math__separator')!;
        const index = [...host.childNodes].indexOf(separator) + 1;
        host.ownerDocument.getSelection()!.setBaseAndExtent(host, index, host, index);
      });
      await page.keyboard.press(
        process.platform === 'darwin' ? 'Alt+Backspace' : 'Control+Backspace',
      );

      expect((await editor.blockData('m2'))?.content).toEqual([{ text: 'Ends with ' }]);
    });

    test('M5c the caret before a formula that starts a block, and between two formulas, takes typing', async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'empty', math: 'katex' });
      await page.evaluate(() =>
        window.__e2e.editor.setDocument({
          blocks: [
            {
              id: 'p1',
              type: 'paragraph',
              depth: 0,
              content: [
                { text: '\uFFFC', math: 'a' },
                { text: '\uFFFC', math: 'b' },
              ],
            },
          ],
        }),
      );

      await editor.placeCaret('p1', 0);
      await editor.type('x');
      await editor.placeCaret('p1', 2);
      await editor.type('y');

      expect((await editor.blockData('p1'))?.content).toEqual([
        { text: 'x' },
        { text: ATOM, math: 'a' },
        { text: 'y' },
        { text: ATOM, math: 'b' },
      ]);
    });

    test('M2b undo after a popover edit puts the caret back in the block it was made in', async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'math', math: 'katex' });
      await editor.content('m2').locator('.neditor-math').click();
      const field = editor.portal('math-editor').getByRole('textbox');
      await field.fill('y^2');
      await field.press('Enter');

      await page.keyboard.press(`${MOD}+z`);
      expect((await editor.blockData('m2'))?.content[1]?.math).toBe('y');
      expect(await editor.focusedBlock()).toBe('m2');
    });

    test('M2c copying text that holds a formula copies its TeX, not its picture', async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'math', math: 'katex' });
      await editor.placeCaret('m1', 0, 11);
      await page.keyboard.press(`${MOD}+c`);
      await page.locator('#paste-target').click();
      await page.keyboard.press(`${MOD}+v`);

      await expect(page.locator('#paste-target')).toHaveValue('Area $\\pi r^2$ and ');
    });

    test('M6b under dir="rtl" a formula still reads left to right', async ({ editor }) => {
      await editor.load({ doc: 'math', math: 'katex', dir: 'rtl' });

      for (const selector of ['.neditor-math', '.neditor-math-block__preview']) {
        expect(
          await editor.root
            .locator(selector)
            .first()
            .evaluate((element) => getComputedStyle(element).direction),
        ).toBe('ltr');
      }
    });

    test('M6c invalid TeX in the popover is said in words, and the field is marked invalid', async ({
      editor,
    }) => {
      await editor.load({ doc: 'math', math: 'katex' });
      await editor.content('m1').locator('.neditor-math').first().click();
      const field = editor.portal('math-editor').getByRole('textbox');

      // TeX that draws has nothing to be told about: a hidden error the field
      // named was still read as its description.
      await expect(field).not.toHaveAttribute('aria-invalid', 'true');
      await expect(field).toHaveAccessibleDescription('');

      await field.fill('\\frac{');
      await expect(field).toHaveAttribute('aria-invalid', 'true');
      await expect(field).toHaveAccessibleDescription('This TeX could not be rendered');
    });

    test('M6 read-only, a formula is only something to look at', async ({ editor }) => {
      await editor.load({ doc: 'math', math: 'katex', editable: false });
      await editor.content('m1').locator('.neditor-math').first().click();
      await expect(editor.portal('math-editor')).toBeHidden();
      expect(await editor.canUndo()).toBe(false);
    });

    /** Thirty filler paragraphs on each side of `body`, so the page scrolls. */
    async function scrolling(page: Page, body: unknown): Promise<void> {
      await page.evaluate((body) => {
        const fill = (tag: string) =>
          Array.from({ length: 30 }, (_, i) => ({
            id: `${tag}${i}`,
            type: 'paragraph',
            depth: 0,
            content: [{ text: `filler ${i}` }],
          }));
        window.__e2e.editor.setDocument({
          blocks: [...fill('f'), body, ...fill('g')],
        } as never);
      }, body);
    }

    const LONG = {
      id: 't',
      type: 'paragraph',
      depth: 0,
      content: [
        { text: 'The area is ' },
        { text: ATOM, math: '\\pi r^2' },
        {
          text: ', and the rest of this sentence wraps onto a second line of the paragraph because it is long enough to do that at this width.',
        },
      ],
    };

    // MA1: closed by any scroll, the popover threw away the TeX being typed
    // and the rest of it went into the prose.
    test('M6d a scroll keeps the popover being typed in, and the TeX goes on into it', async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'math', math: 'katex' });
      await scrolling(page, LONG);
      await editor.content('t').scrollIntoViewIfNeeded();
      await editor.content('t').locator('.neditor-math').click();
      const dialog = editor.portal('math-editor');
      const field = dialog.getByRole('textbox');
      await expect(field).toBeFocused();
      // To the field's end: on macOS `End` scrolls rather than moving the caret.
      await page.keyboard.press('ArrowRight');
      await page.keyboard.type('+1');

      const box = await editor.content('t').boundingBox();
      await page.mouse.move(box!.x + 20, box!.y - 40);
      await page.mouse.wheel(0, 120);
      await editor.settleScroll();
      await page.keyboard.type('zz');

      await expect(dialog).toBeVisible();
      await expect(field).toHaveValue('\\pi r^2+1zz');
      await field.press('Enter');
      expect((await editor.blockData('t'))?.content[1]).toEqual({
        text: ATOM,
        math: '\\pi r^2+1zz',
      });
    });

    // MA1's likeliest form: the click's reveal of a block the window cuts
    // scrolled the page, and that scroll closed the popover the click opened.
    test('M6e a click on a formula in a block the window cuts opens it and moves nothing', async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'math', math: 'katex' });
      await scrolling(page, LONG);
      await page.evaluate(() => {
        const host = document.querySelector('[data-block-id="t"] .neditor-block__content')!;
        scrollBy(0, host.getBoundingClientRect().bottom - innerHeight - 15);
      });
      await editor.settleScroll();
      const before = await page.evaluate(() => scrollY);

      await editor.content('t').locator('.neditor-math').click();
      await editor.settleScroll();

      const dialog = editor.portal('math-editor');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('textbox')).toBeFocused();
      expect(await page.evaluate(() => scrollY)).toBe(before);
      await page.keyboard.type('+1');
      expect((await editor.blockData('t'))?.content).toEqual(LONG.content);
    });

    // MA2: Escape and Apply revealed the whole host, and a block taller than
    // the window scrolled the page by 430px.
    test('M6f Escape and Apply in a block taller than the window move nothing', async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'math', math: 'katex' });
      await scrolling(page, {
        id: 't',
        type: 'paragraph',
        depth: 0,
        content: [{ text: 'tall '.repeat(1200) }],
      });
      await page.evaluate(() => {
        const host = document.querySelector('[data-block-id="t"] .neditor-block__content')!;
        scrollBy(0, host.getBoundingClientRect().top - 600);
      });
      await editor.settleScroll();
      const box = await editor.content('t').boundingBox();
      await page.mouse.click(box!.x + 30, box!.y + 8);
      await editor.settleScroll();
      const before = await page.evaluate(() => scrollY);
      const dialog = editor.portal('math-editor');

      await page.keyboard.press(`${MOD}+Shift+e`);
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await editor.settleScroll();
      expect(await page.evaluate(() => scrollY), 'Escape').toBe(before);

      await page.keyboard.press(`${MOD}+Shift+e`);
      await page.keyboard.type('y');
      await page.keyboard.press('Enter');
      await expect(dialog).toBeHidden();
      await editor.settleScroll();
      expect(await page.evaluate(() => scrollY), 'Apply').toBe(before);
      expect((await editor.blockData('t'))?.content.some((run) => run.math === 'y')).toBe(true);
    });

    // MA3: a Shift+click on a formula opened its popover over a caret after
    // it, and the reader's range was gone. Shift extends the range over it.
    test('M6g a Shift+click on a formula extends the range over it', async ({ editor }) => {
      await editor.load({ doc: 'math', math: 'katex' });
      // "Are" selected; the second formula, ⟨r⟩, is at 11.
      await editor.placeCaret('m1', 0, 3);
      await editor
        .content('m1')
        .locator('.neditor-math')
        .nth(1)
        .click({ modifiers: ['Shift'] });
      await editor.settle();

      await expect(editor.portal('math-editor')).toBeHidden();
      expect((await editor.selection())?.range).toEqual({ start: 0, end: 12 });
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

      const copied = (await editor.doc()).blocks.filter((block) =>
        ['m1', 'eq', 'p2'].includes(block.id),
      );
      expect(shape(await second.doc())).toEqual(shape({ blocks: copied }));
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
        expect(blocks.map((block) => [block.type, block.content])).toEqual(WEBKIT_FALLBACK);
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
