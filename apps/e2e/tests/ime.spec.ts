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

  // TY-2: over a block selection focus is on the root, which is no editing
  // host, so a composition had nowhere to start: the composed text was lost
  // and the blocks stayed selected. The IME's own keydown ("Process", 229)
  // opens an empty paragraph in their place, and the word is composed there.
  test('IM1c a word composed over a block selection replaces the blocks', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    const ime = await Ime.attach(page);
    await editor.placeCaret('p1', 2);
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.press(`${MOD}+a`);
    const selected = await editor.selected();
    expect(selected.length).toBeGreaterThan(1);

    await ime.imeKey('KeyK');
    await ime.compose(['か'], '火');

    expect(await editor.texts()).toEqual(['火']);
    expect(await editor.selected()).toEqual([]);

    // The composition is its own step, and the replacement the one before it.
    await page.keyboard.press(`${MOD}+z`);
    await page.keyboard.press(`${MOD}+z`);
    expect((await editor.ids()).slice(0, selected.length)).toEqual(selected);
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

  test('IM4b a word composed over a link, or after typing over one, is the link', async ({
    editor,
    page,
  }) => {
    // R2-EDIT-5. Latin keys typed over a link's whole text keep the link
    // (TXT-10), but a composition is the browser's to write: over the link it
    // dropped the anchor, and after a typed-over word it landed outside it
    // while Latin keys joined it.
    const link = 'https://e.com/';
    const fresh = async (): Promise<void> => {
      await editor.setDocument({
        blocks: [
          {
            id: 'x',
            type: 'paragraph',
            depth: 0,
            content: [{ text: 'see ' }, { text: 'docs', link }, { text: ' end' }],
          },
        ],
      });
      await editor.clickAt('x', 2);
      // Arrowed to the link's edge: a press at offset 4 is a pixel from the
      // anchor, and Chromium's hit test on Linux puts it on the link, whose
      // click opens the link editor (ci-2).
      for (let i = 0; i < 2; i += 1) {
        await page.keyboard.press('ArrowRight');
      }
      expect(await editor.selection()).toMatchObject({ range: { start: 4, end: 4 } });
      for (let i = 0; i < 4; i += 1) {
        await page.keyboard.press('Shift+ArrowRight');
      }
    };

    await editor.load({ doc: 'paragraphs' });
    const ime = await Ime.attach(page);

    await fresh();
    await ime.compose(['に', 'にほ'], '日本');
    expect((await editor.blockData('x'))?.content).toEqual([
      { text: 'see ' },
      { text: '日本', link },
      { text: ' end' },
    ]);
    await expect(editor.content('x').locator('a')).toHaveText('日本');
    // What is typed next at the same caret goes on into the link, as it does
    // after a typed-over word.
    await editor.type('ab');
    expect((await editor.blockData('x'))?.content?.[1]).toEqual({ text: '日本ab', link });
    // One undo step for the composed word and what followed it.
    await page.keyboard.press(`${MOD}+z`);
    expect((await editor.blockData('x'))?.content?.[1]).toEqual({ text: 'docs', link });

    await fresh();
    await editor.type('XY');
    await ime.compose(['に'], '日');
    await editor.type('Z');
    expect((await editor.blockData('x'))?.content).toEqual([
      { text: 'see ' },
      { text: 'XY日Z', link },
      { text: ' end' },
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

  test('IM6 a slash-menu query typed through an IME narrows the menu', async ({ editor, page }) => {
    // TXT-7: the composed query was never read, and Enter applied the
    // unfiltered first command ("Text"), deleting `/引用`.
    await editor.load({ doc: 'paragraphs', toolbar: 0 });
    const ime = await Ime.attach(page);
    const menu = editor.portal('slash-menu');
    await editor.setDocument({
      blocks: [{ id: 'x', type: 'paragraph', depth: 0, content: [{ text: 'Some words ' }] }],
    });
    await editor.caretAtEnd('x');
    await editor.type('/');
    await expect(menu).toBeVisible();
    const all = await menu.getByRole('option').count();

    await ime.compose(['q', 'qu'], 'quo');
    await expect(menu.getByRole('option')).toHaveCount(1);
    await expect(menu.getByRole('option')).toContainText('Quote');
    expect(all).toBeGreaterThan(1);
    await page.keyboard.press('Escape');

    // A query that matches nothing closes the menu; Enter is then a line break
    // in the paragraph's own terms, and keeps the text.
    await editor.setDocument({
      blocks: [{ id: 'x', type: 'paragraph', depth: 0, content: [{ text: 'Some words ' }] }],
    });
    await editor.caretAtEnd('x');
    await editor.type('/');
    await expect(menu).toBeVisible();
    await ime.compose(['い', 'いん'], '引用');
    await expect(menu).toBeHidden();
    await page.keyboard.press('Enter');
    expect(await editor.outline()).toEqual(['paragraph:Some words /引用', 'paragraph:']);
  });

  test('IM7 a composition survives a peer’s reorder that moves its block', async ({
    editor,
    page,
  }) => {
    // R13-KEY-2: moving the element a composition is in blurs it and ends the
    // composition; "Block Cに" was all that was left, and the rest went
    // nowhere. The renderer now moves the other blocks around it.
    for (const order of [
      ['c', 'a', 'b', 'd', 'e'],
      ['b', 'c', 'a', 'd', 'e'],
    ]) {
      await editor.load({ doc: 'five' });
      const ime = await Ime.attach(page);
      await editor.content('c').click();
      await page.keyboard.press('End');
      await ime.start('に');
      await page.evaluate((order) => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        const byId = new Map(doc.blocks.map((block) => [block.id, block]));
        ed.setDocument({ blocks: order.map((id) => byId.get(id)!) });
      }, order);
      await ime.compose(['にほ', 'にほん'], '日本');
      await page.keyboard.type('x');
      expect((await editor.blockData('c'))!.content, order.join('')).toEqual([
        { text: 'Block C日本x' },
      ]);
    }
  });
});
