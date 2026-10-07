import type { Locator, Page } from '@playwright/test';
import { expect, MOD, test } from '../helpers/test.ts';

/** Resolve any CSS colour to [r, g, b, a] through a canvas, then WCAG luminance. */
async function colours(page: Page, pairs: Array<[string, string]>): Promise<number[]> {
  return page.evaluate((pairs) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const rgba = (colour: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = colour;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const luminance = ([r, g, b]: number[]) => {
      const channel = (value: number) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
    };
    return pairs.map(([fg, bg]) => {
      const [a, b] = [luminance(rgba(fg)), luminance(rgba(bg))];
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
  }, pairs);
}

const style = (locator: Locator, property: string) =>
  locator.evaluate(
    (element, property) => getComputedStyle(element).getPropertyValue(property),
    property,
  );

test.describe('20 · theming & visual', () => {
  test('V1 auto follows the colour scheme; light and dark force it; portals match the editor', async ({
    editor,
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await editor.load({ doc: 'paragraphs' });
    const light = await style(editor.content('p1'), 'color');
    await page.emulateMedia({ colorScheme: 'dark' });
    const dark = await style(editor.content('p1'), 'color');
    expect(dark).not.toBe(light);

    await editor.load({ doc: 'paragraphs', theme: 'light' });
    expect(await style(editor.content('p1'), 'color')).toBe(light);
    await editor.placeCaret('p1', 0, 5);
    await expect(editor.portal('toolbar')).toHaveAttribute('data-neditor-theme', 'light');

    await page.emulateMedia({ colorScheme: 'light' });
    await editor.load({ doc: 'paragraphs', theme: 'dark' });
    expect(await style(editor.content('p1'), 'color')).toBe(dark);
    await editor.placeCaret('p1', 0, 5);
    await expect(editor.portal('toolbar')).toHaveAttribute('data-neditor-theme', 'dark');
    const surface = await style(editor.portal('toolbar'), 'background-color');
    expect(surface).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('V2 a dark editor on a light page owns its ground, and its text is readable on it', async ({
    editor,
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await editor.load({ doc: 'kitchen-sink', theme: 'dark' });
    const ground = await style(editor.root, 'background-color');
    expect(ground).not.toBe('rgba(0, 0, 0, 0)');
    const pairs: Array<[string, string]> = [];

    for (const id of ['para', 'h1', 'qt', 'end']) {
      pairs.push([await style(editor.content(id), 'color'), ground]);
    }

    const ratios = await colours(page, pairs);
    for (const ratio of ratios) {
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('V3 forced colours restate selection in system colours; reduced motion removes transitions', async ({
    editor,
    page,
  }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await editor.load({ doc: 'five' });
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['b']));
    const [selected, highlight] = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.cssText = 'forced-color-adjust: none; background: Highlight';
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return [
        getComputedStyle(document.querySelector('[data-block-id="b"]')!).backgroundColor,
        value,
      ];
    });
    expect(selected).toBe(highlight);

    await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'reduce' });
    await editor.load({ doc: 'five' });
    const durations = await style(editor.block('a'), 'transition-duration');
    expect(durations.split(',').every((value) => parseFloat(value) === 0)).toBe(true);
  });

  test('V4 dir="rtl" mirrors indentation, markers and the gutter; an LTR editor in an RTL page is left alone', async ({
    editor,
  }) => {
    await editor.load({ doc: 'nested', dir: 'rtl' });
    const indent = await editor.block('l1').evaluate((element) => {
      const computed = getComputedStyle(element);
      return { left: parseFloat(computed.marginLeft), right: parseFloat(computed.marginRight) };
    });
    expect(indent.right).toBeGreaterThan(0);
    expect(indent.left).toBe(0);
    const marker = (await editor.block('l0').locator('.neditor-block__marker').boundingBox())!;
    const text = (await editor.content('l0').boundingBox())!;
    expect(marker.x).toBeGreaterThan(text.x);
    await editor.hoverBlock('l0');
    const gutter = (await editor.gutter.boundingBox())!;
    expect(gutter.x).toBeGreaterThanOrEqual(text.x + text.width - 1);

    await editor.load({ doc: 'nested', dir: 'page-rtl' });
    const ltr = await editor
      .block('l1')
      .evaluate((element) => parseFloat(getComputedStyle(element).marginLeft));
    expect(ltr).toBeGreaterThan(0);
    await editor.hoverBlock('l0');
    const ltrGutter = (await editor.gutter.boundingBox())!;
    const ltrText = (await editor.content('l0').boundingBox())!;
    expect(ltrGutter.x + ltrGutter.width).toBeLessThanOrEqual(ltrText.x + 1);
  });

  test('V5 a unitless zero gutter width does not take the nesting indent with it', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'nested' });
    await page.addStyleTag({ content: '.neditor { --neditor-gutter-width: 0 }' });
    const measure = () =>
      editor.block('l1').evaluate((element) => {
        const computed = getComputedStyle(element);
        return {
          indent: parseFloat(computed.marginInlineStart),
          gutter: parseFloat(computed.paddingInlineStart),
        };
      });
    // Both properties animate (120 ms), so wait for the gutter to land.
    await expect.poll(async () => (await measure()).gutter).toBe(0);
    expect((await measure()).indent).toBeGreaterThan(0);
  });

  test.describe('V6 screenshot baselines', () => {
    test.beforeEach(({ browserName }) => {
      // Recorded on Linux Chromium only (plan §5): fonts differ everywhere else.
      test.skip(
        browserName !== 'chromium' || process.platform !== 'linux',
        'visual baselines are Linux Chromium only',
      );
    });

    for (const theme of ['light', 'dark'] as const) {
      test(`kitchen sink, ${theme}`, async ({ editor, page }) => {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        await editor.load({ doc: 'kitchen-sink', theme });
        await page.evaluate(() => document.fonts.ready);
        await expect(editor.root).toHaveScreenshot(`kitchen-sink-${theme}.png`, {
          maxDiffPixelRatio: 0.01,
        });
      });
    }

    test('slash menu and table toolbar', async ({ editor, page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await editor.load({ doc: 'kitchen-sink', theme: 'light' });
      await editor.placeCaret('h2', 0);
      await editor.type('/');
      await expect(editor.portal('slash-menu')).toHaveScreenshot('slash-menu.png', {
        maxDiffPixelRatio: 0.01,
      });
      await page.keyboard.press('Escape');
      await page.keyboard.press(`${MOD}+z`);
      await editor.placeCaret('tbl', 0, 0, { row: 1, column: 0 });
      await editor.settle();
      await expect(editor.portal('table-toolbar')).toHaveScreenshot('table-toolbar.png', {
        maxDiffPixelRatio: 0.01,
      });
    });
  });
});
