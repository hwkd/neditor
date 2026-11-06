import { test as base, expect } from '@playwright/test';
import { EditorPage } from './editor.ts';

export { expect };
export { EditorPage, MOD } from './editor.ts';

interface Fixtures {
  editor: EditorPage;
  /** Console errors and page errors seen during the test. */
  consoleErrors: string[];
  /** Runs the harness's invariant check after every test. Opt out with `test.use({ invariants: false })`. */
  invariants: boolean;
  _afterEach: void;
}

export const test = base.extend<Fixtures>({
  invariants: [true, { option: true }],

  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
    });
    page.on('pageerror', (error) => errors.push(String(error)));
    await use(errors);
  },

  editor: async ({ page }, use) => {
    await use(new EditorPage(page));
  },

  _afterEach: [
    async ({ page, invariants, consoleErrors }, use, testInfo) => {
      await use();

      if (testInfo.status !== testInfo.expectedStatus) {
        return; // the test already failed; don't bury its message
      }

      const allowConsole = testInfo.annotations.some(
        (note) => note.type === 'allow-console-errors',
      );

      if (!allowConsole) {
        expect(consoleErrors, 'console errors during the test').toEqual([]);
      }

      if (!invariants || page.isClosed()) {
        return;
      }

      const hasHarness = await page.evaluate(() => Boolean(window.__e2e?.ready)).catch(() => false);

      if (hasHarness) {
        const violations = await page.evaluate(() => window.__e2e.checkInvariants());
        expect(violations, 'editor invariants after the test').toEqual([]);
        const errors = await page.evaluate(() => window.__e2e.errors.map(String));
        expect(errors, 'listener / window errors').toEqual([]);
      }
    },
    { auto: true },
  ],
});
