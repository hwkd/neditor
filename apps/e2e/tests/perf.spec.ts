import { expect, MOD, test } from '../helpers/test.ts';
import { writeClipboard } from '../helpers/clipboard.ts';

// Budgets are generous on purpose: they catch an order-of-magnitude regression
// (a render per keystroke over 2000 blocks), not a few milliseconds of noise.
const KEYSTROKE_P95_MS = 50;
const HUGE_PASTE_MS = 5_000;

test.describe('28 · robustness & performance @slow', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'measured on Chromium only (plan 28)');
  });

  test('PF1 typing in a 2000-block document stays fast', async ({ editor, page }) => {
    await editor.load({ doc: 'long-2000' });
    await editor.caretAtEnd('p1000');
    await page.evaluate(() => {
      const samples: number[] = [];
      (window as unknown as { samples: number[] }).samples = samples;
      const root = window.__e2e.editor.element;
      root.addEventListener('beforeinput', () => performance.mark('key'), true);
      root.addEventListener('input', () => {
        const start = performance.getEntriesByName('key').at(-1);
        if (start) {
          samples.push(performance.now() - start.startTime);
        }
      });
    });
    await page.keyboard.type('the quick brown fox jumps over the lazy dog');
    const samples = await page.evaluate(() =>
      (window as unknown as { samples: number[] }).samples.sort((a, b) => a - b),
    );
    expect(samples.length).toBeGreaterThan(30);
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    test.info().annotations.push({ type: 'p95 keystroke ms', description: p95.toFixed(2) });
    expect(p95).toBeLessThan(KEYSTROKE_P95_MS);
    expect((await editor.blockData('p1000'))?.content[0]?.text).toContain('lazy dog');
  });

  test('PF2 a 1 MB paste and a 1024-deep list finish within budget without crashing', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    const big = '<p>' + 'lorem ipsum dolor sit amet '.repeat(40) + '</p>';
    await writeClipboard(page, { html: big.repeat(Math.ceil(1_000_000 / big.length)) });
    await editor.placeCaret('p1', 0);
    let start = Date.now();
    await page.keyboard.press(`${MOD}+v`);
    await expect
      .poll(async () => (await editor.ids()).length, { timeout: HUGE_PASTE_MS })
      .toBeGreaterThan(900);
    expect(Date.now() - start).toBeLessThan(HUGE_PASTE_MS);

    await editor.remount({}, 'empty');
    const deep = '<ul><li>x'.repeat(1024) + '</li></ul>'.repeat(1024);
    await writeClipboard(page, { html: deep });
    await editor.placeCaret('p1', 0);
    start = Date.now();
    await page.keyboard.press(`${MOD}+v`);
    await expect
      .poll(async () => (await editor.ids()).length, { timeout: HUGE_PASTE_MS })
      .toBeGreaterThan(100);
    expect(Date.now() - start).toBeLessThan(HUGE_PASTE_MS);
    const depths = (await editor.doc()).blocks.map((block) => block.depth);
    expect(Math.max(...depths)).toBeLessThanOrEqual(32);
  });

  test('PF3 at 1000 rows, Tab past the last cell lets focus leave instead of growing the table', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await page.evaluate(() => {
      const rows = Array.from({ length: 1000 }, (_, row) => [[{ text: `r${row}` }]]);
      window.__e2e.editor.setDocument({
        blocks: [{ id: 'tbl', type: 'table', depth: 0, content: [], rows }],
      });
    });
    await editor.placeCaret('tbl', 0, 0, { row: 999, column: 0 });
    await page.keyboard.press('Tab');
    expect((await editor.blockData('tbl'))?.rows).toHaveLength(1000);
    expect((await editor.selection())?.cell).toBeUndefined();
  });
});
