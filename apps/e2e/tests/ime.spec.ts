import type { CDPSession, Page } from '@playwright/test';
import { expect, MOD, test } from '../helpers/test.ts';

/**
 * A real IME composition through the DevTools protocol: the browser raises
 * compositionstart/update/end and the matching beforeinput/input exactly as it
 * does for a system input method. Chromium only (plan R3).
 */
class Ime {
  private constructor(private readonly cdp: CDPSession) {}

  static async attach(page: Page): Promise<Ime> {
    return new Ime(await page.context().newCDPSession(page));
  }

  /** Step through the candidate strings, then commit `committed`. */
  async compose(steps: string[], committed: string): Promise<void> {
    for (const text of steps) {
      await this.cdp.send('Input.imeSetComposition', {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
    }

    await this.cdp.send('Input.insertText', { text: committed });
  }

  async start(text: string): Promise<void> {
    await this.cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
  }

  /**
   * A key the IME consumes, as the browser reports it to the page: keyCode 229
   * ("Process"). Playwright's own keyboard would send a plain Enter, which a
   * real input method never lets through mid-composition.
   */
  async imeKey(code: string): Promise<void> {
    for (const type of ['rawKeyDown', 'keyUp'] as const) {
      await this.cdp.send('Input.dispatchKeyEvent', {
        type,
        key: 'Process',
        code,
        windowsVirtualKeyCode: 229,
      });
    }
  }

  /** Abandon the candidate, as Escape in an IME does. */
  async cancel(): Promise<void> {
    await this.cdp.send('Input.imeSetComposition', {
      text: '',
      selectionStart: 0,
      selectionEnd: 0,
    });
    await this.cdp.send('Input.insertText', { text: '' });
  }
}

test.describe('22 · IME composition', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP IME is Chromium-only (plan R3)');
  });

  test('IM1 Japanese and Korean compositions commit the right text, one undo step per word', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    const ime = await Ime.attach(page);

    await editor.caretAtEnd('p1');
    await ime.compose(['に', 'にほ', 'にほん'], '日本');
    expect((await editor.texts())[0]).toBe('Alpha one日本');
    await expect(editor.content('p1')).toHaveText('Alpha one日本');

    await editor.caretAtEnd('p2');
    await ime.compose(['ㅎ', '하', '한'], '한');
    await ime.compose(['ㄱ', '그', '글'], '글');
    expect((await editor.texts())[1]).toBe('Bravo two한글');

    // Syllables composed back to back are one run, as typed letters are; the
    // composition in another block is a step of its own.
    await page.keyboard.press(`${MOD}+z`);
    expect((await editor.texts())[1]).toBe('Bravo two');
    expect((await editor.texts())[0]).toBe('Alpha one日本');
    await page.keyboard.press(`${MOD}+z`);
    expect((await editor.texts())[0]).toBe('Alpha one');
  });

  test('IM1b a cancelled candidate changes and records nothing', async ({ editor, page }) => {
    await editor.load({ doc: 'paragraphs' });
    const ime = await Ime.attach(page);
    await editor.caretAtEnd('p1');
    await editor.clearLog();
    await ime.start('にほ');
    await ime.cancel();
    expect((await editor.texts())[0]).toBe('Alpha one');
    expect(await editor.canUndo()).toBe(false);
  });

  test('IM2 Enter while composing does not split the block', async ({ editor, page }) => {
    await editor.load({ doc: 'paragraphs' });
    const ime = await Ime.attach(page);
    await editor.caretAtEnd('p1');
    await ime.start('にほ');
    await ime.imeKey('Enter');
    await ime.compose([], '日本');
    expect(await editor.ids()).toEqual(['p1', 'p2', 'p3']);
    expect((await editor.texts())[0]).toBe('Alpha one日本');
  });

  test('IM3 undo after a composition returns the caret to where the composition began', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    const ime = await Ime.attach(page);
    // History exists in another block first, so "where the caret was" is a real question.
    await editor.caretAtEnd('p1');
    await editor.type('!');
    await editor.clickAt('p3', 7);
    await ime.compose(['か', 'かん'], '漢');
    expect((await editor.texts())[2]).toBe('Charlie漢 three');

    await page.keyboard.press(`${MOD}+z`);
    expect((await editor.texts())[2]).toBe('Charlie three');
    expect(await editor.selection()).toMatchObject({ blockId: 'p3', range: { start: 7, end: 7 } });
  });

  test('IM4 an armed mark applies to composed text', async ({ editor, page }) => {
    await editor.load({ doc: 'paragraphs' });
    const ime = await Ime.attach(page);
    await editor.caretAtEnd('p2');
    await page.keyboard.press(`${MOD}+b`);
    await ime.compose(['に', 'にほ'], '日本');
    expect((await editor.blockData('p2'))?.content).toEqual([
      { text: 'Bravo two' },
      { text: '日本', marks: ['bold'] },
    ]);
  });

  test('IM5 Markdown shortcuts do not fire on composed text (documented gap, pinned)', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    const ime = await Ime.attach(page);
    await editor.placeCaret('p1', 0);
    await ime.compose(['#'], '# ');
    await ime.compose(['**b'], '**b**');
    expect(await editor.outline()).toEqual(['paragraph:# **b**']);
  });
});
