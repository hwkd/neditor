import { EditorPage, expect, MOD, test } from '../helpers/test.ts';

async function shiftSelect(page: import('@playwright/test').Page, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press('Shift+ArrowRight');
  }
}

/**
 * R9-PTR-1's shape, as the probe built it: a 400px scrolling pane 150px down
 * a page that scrolls, with `trigger` on it, and a 330px scrolling
 * `position: fixed` sheet at 180/180 declared in it, between fillers, holding
 * the editor, which gets three paragraphs before the table and 25 after it.
 */
const paneWithSheet = (trigger: string): void => {
  const ed = window.__e2e.editor;
  const doc = ed.getDocument();
  const para = (id: string, text: string) => ({
    id,
    type: 'paragraph' as const,
    depth: 0,
    content: [{ text }],
  });
  doc.blocks = [
    ...Array.from({ length: 3 }, (_, i) => para(`h${i}`, `Head paragraph ${i}`)),
    ...doc.blocks,
    ...Array.from({ length: 25 }, (_, i) => para(`z${i}`, `Tail paragraph ${i}`)),
  ];
  ed.setDocument(doc);
  const stage = document.querySelector<HTMLElement>('#stage')!;
  const filler = (height: number) => {
    const element = document.createElement('div');
    element.style.height = `${height}px`;
    return element;
  };
  const pane = document.createElement('div');
  pane.id = 'pane';
  pane.style.cssText = `position:relative;margin:150px auto 0;width:760px;height:400px;overflow:auto;${trigger}`;
  document.body.insertBefore(pane, document.body.firstChild);
  document.body.style.paddingBottom = '1200px';
  stage.style.margin = '0';
  const sheet = document.createElement('div');
  sheet.id = 'sheet';
  sheet.style.cssText =
    'position:fixed;left:180px;top:180px;width:740px;height:330px;overflow:auto;background:#fff';
  pane.append(filler(300), sheet, filler(1500));
  sheet.append(stage);
};

/**
 * R8-PTR-1's two app shells, as the probe built them: a scrolling pane in
 * the top 40% of the window with a `position: fixed` bottom sheet declared
 * inside it holding the editor (`#scroller`), and a page pane below a 300px
 * header with the modal `<dialog>` (the top layer) declared inside it. The
 * pane around either does not clip the editor.
 */
const appShell = (shell: 'fixed sheet' | 'modal dialog'): void => {
  const ed = window.__e2e.editor;
  const doc = ed.getDocument();
  doc.blocks.push(
    ...Array.from({ length: 30 }, (_, i) => ({
      id: `z${i}`,
      type: 'paragraph' as const,
      depth: 0,
      content: [{ text: `Tail paragraph ${i} with a few more words` }],
    })),
  );
  ed.setDocument(doc);
  document.body.style.margin = '0';
  const pane = document.createElement('main');
  const spacer = document.createElement('div');
  spacer.style.height = '2000px';
  pane.append(spacer);
  document.body.append(pane);

  if (shell === 'fixed sheet') {
    pane.style.cssText = 'position:absolute;top:0;left:0;right:0;height:40vh;overflow:auto';
    const sheet = document.createElement('section');
    sheet.id = 'scroller';
    sheet.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;height:55vh;background:#fff;overflow:auto';
    pane.append(sheet);
    sheet.append(document.querySelector('#editor')!);
  } else {
    pane.style.cssText = 'position:absolute;top:300px;left:0;right:0;bottom:0;overflow:auto';
    const dialog = document.querySelector<HTMLDialogElement>('#dialog')!;
    dialog.close();
    pane.append(document.querySelector('#stage')!);
    dialog.style.maxHeight = '80vh';
    dialog.style.overflow = 'auto';
    dialog.style.margin = '40px auto';
    dialog.showModal();
  }
};

/**
 * Scrolls the first tail paragraph below the scroller's bottom edge up until
 * only its top 10px show, and answers its id.
 */
const cutAtBottom = (selector: string): string => {
  const scroller = document.querySelector<HTMLElement>(selector)!;
  const bottom = scroller.getBoundingClientRect().bottom;

  for (const element of document.querySelectorAll('[data-block-id^="z"] .neditor-block__content')) {
    if (element.getBoundingClientRect().top >= bottom) {
      scroller.scrollTop += element.getBoundingClientRect().top - (bottom - 10);
      return element.closest<HTMLElement>('[data-block-id]')!.dataset.blockId!;
    }
  }

  return '';
};

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

  test('F6 the toolbar hides on Escape, follows a scroll until its text leaves the screen, hides in block mode, and never shows with toolbar:false', async ({
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
    // Dismissed stays dismissed: a scroll does not bring it back.
    await page.mouse.wheel(0, 20);
    await editor.settleScroll();
    await expect(toolbar).toBeHidden();

    // While its text is on screen the toolbar moves with it (UI-1: any scroll
    // used to hide it).
    await editor.placeCaret('p10', 0, 5);
    await editor.settle();
    await expect(toolbar).toBeVisible();
    const before = (await toolbar.boundingBox())!;
    const scrolledFrom = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 60);
    await editor.settleScroll();
    await expect(toolbar).toBeVisible();
    const delta = (await page.evaluate(() => window.scrollY)) - scrolledFrom;
    expect(delta).toBeGreaterThan(0);
    expect(before.y - (await toolbar.boundingBox())!.y).toBeCloseTo(delta, 0);

    // Once the text has scrolled off, the toolbar goes with it.
    await page.mouse.wheel(0, 600);
    await expect(toolbar).toBeHidden();
    await editor.settleScroll();

    // A block still on screen after the scroll.
    await editor.placeCaret('p30', 0, 5);
    await editor.settle();
    await expect(toolbar).toBeVisible();
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['p30']));
    await expect(toolbar).toBeHidden();

    await editor.remount({ toolbar: false }, 'paragraphs');
    await editor.dragText(['p1', 0], ['p1', 5]);
    expect((await editor.selection())?.range).toEqual({ start: 0, end: 5 });
    await expect(page.locator('.neditor-toolbar:not([hidden])')).toHaveCount(0);
  });

  // e2e only: the scroll is the browser's own scroll-into-view of the
  // selection, which happy-dom neither performs nor lays out.
  test('F8 Shift+End on a half-visible line shows the toolbar after the scroll it brings', async ({
    editor,
    page,
  }) => {
    // Was UI-1 (WebKit): the scroll arrived after the selectionchange that
    // showed the toolbar, and the scroll handler hid it again for good.
    await editor.load({ doc: 'long', scroll: 1 });
    const height = page.viewportSize()!.height;
    await editor.content('p30').evaluate((element, height) => {
      const box = element.getBoundingClientRect();
      window.scrollTo(0, box.top + window.scrollY - (height - box.height / 2));
    }, height);
    await editor.settleScroll();
    const box = (await editor.content('p30').boundingBox())!;
    await page.mouse.click(box.x + 1, box.y + 4);
    await editor.settle();

    await page.keyboard.press('Shift+End');
    await editor.settleScroll();
    expect((await editor.selection())?.range).toEqual({ start: 0, end: 19 });
    await expect(editor.portal('toolbar')).toBeVisible();
  });

  /*
   * R8-PTR-1. The same Shift+End, in an editor whose scroller is not clipped
   * by the pane it is declared in -- a fixed sheet, a modal dialog. "On
   * screen" clipped the range's host by that pane too, and WebKit's late
   * scroll took the toolbar away for good (the sheet). The probe: the first
   * tail paragraph under the scroller's bottom edge cut to its top 10px, a
   * click at its start, Shift+End. Layout and the browser's own scroll: e2e.
   */
  test('F8b Shift+End shows the toolbar in a fixed sheet or a modal dialog inside a scrolling pane', async ({
    editor,
    page,
  }) => {
    for (const shell of ['fixed sheet', 'modal dialog'] as const) {
      await editor.load({ doc: 'table', ...(shell === 'modal dialog' ? { mount: 'dialog' } : {}) });
      await page.evaluate(appShell, shell);
      await editor.settle();
      const id = await page.evaluate(
        cutAtBottom,
        shell === 'fixed sheet' ? '#scroller' : '#dialog',
      );
      await editor.settleScroll();
      const box = (await editor.content(id).boundingBox())!;
      await page.mouse.click(box.x + 4, box.y + 4);
      await editor.settle();

      await page.keyboard.press('Shift+End');
      await editor.settleScroll();
      expect((await editor.selection())?.range.end, shell).toBeGreaterThan(0);
      await expect(editor.portal('toolbar'), shell).toBeVisible();
    }
  });

  /*
   * R7-KEY-4. `setDocument` hid the format toolbar with every other panel,
   * and with the range still selected in the block holding focus nothing
   * drew it again until the selection moved. The probe: a double-click on
   * "documentation", then the same document reloaded, silently. It comes
   * back for the range that survived, and focus stays where it was.
   * Selection geometry and focus: e2e.
   */
  test('F9 a host’s setDocument leaves the toolbar drawn for the range that survived it', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      ed.setDocument({
        blocks: [
          {
            id: 'p',
            type: 'paragraph',
            depth: 0,
            content: [{ text: 'Read the documentation first' }],
          },
        ],
      });
      ed.clearHistory();
    });
    const point = await editor.pointAt(editor.content('p'), 12);
    await page.mouse.dblclick(point.x, point.y);
    await editor.settle();
    await expect(editor.portal('toolbar')).toBeVisible();

    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      ed.setDocument(ed.getDocument(), { silent: true });
    });
    await editor.settle();
    await expect(editor.portal('toolbar')).toBeVisible();
    await expect(editor.content('p')).toBeFocused();
    expect((await editor.selection())?.range).toEqual({ start: 9, end: 22 });
  });

  /*
   * R8-KEY-1. F9's re-sync drew the toolbar from the selection alone, so a
   * range the page had scrolled out of sight got its toolbar back with a
   * peer's update, drawn at the window's clamp over whatever was there. The
   * probe: "Second paragraph here" selected from 7 for 9, the page wheeled
   * 900px on, a peer's edit to the last block. Only a toolbar that was
   * showing, for a range still on screen, is drawn again. Layout: e2e.
   */
  test('F9b a host’s setDocument draws no toolbar for a range scrolled out of sight', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty', scroll: 1 });
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const para = (id: string, text: string) => ({
        id,
        type: 'paragraph' as const,
        depth: 0,
        content: [{ text }],
      });
      ed.setDocument({
        blocks: [
          para('p', 'Read the doc first please'),
          para('q', 'Second paragraph here'),
          para('tail', 'tail'),
        ],
      });
      ed.clearHistory();
      ed.element.scrollIntoView({ block: 'center' });
    });
    await editor.settleScroll();
    const point = await editor.pointAt(editor.content('q'), 7);
    await page.mouse.click(point.x, point.y);
    await shiftSelect(page, 9);
    await editor.settle();
    const toolbar = editor.portal('toolbar');
    await expect(toolbar).toBeVisible();

    await page.mouse.move(900, 400);
    await page.mouse.wheel(0, 900);
    await editor.settleScroll();
    await expect(toolbar, 'scrolled away').toBeHidden();
    expect((await editor.content('q').boundingBox())!.y, 'precondition').toBeLessThan(0);

    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const doc = ed.getDocument();
      doc.blocks[2]!.content = [{ text: 'tail peer' }];
      ed.setDocument(doc);
    });
    await editor.settle();
    await expect(toolbar).toBeHidden();
    // The range itself survived; it is only out of sight.
    expect((await editor.selection())?.range).toEqual({ start: 7, end: 16 });
  });

  /*
   * R9-KEY-8, p06's literal case: a caret in "Alpha", a click on the page
   * outside, then Firefox's Quick Find (`/`, "Bet"). The match is selected in
   * "Beta text" while focus stays in the find bar, and the format toolbar was
   * drawn over the page for a range the reader was not editing. Quick Find is
   * Firefox's own, so this is too; the toolbar's ordinary appearance in every
   * engine is F1, F2 and F8.
   */
  for (const mount of ['plain', 'shadow', 'iframe', 'dialog'] as const) {
    test(`F10 Firefox's Quick Find selecting text in the editor draws no toolbar (${mount})`, async ({
      editor: plain,
      page,
      browserName,
    }) => {
      test.skip(browserName !== 'firefox', "Quick Find is Firefox's");
      const editor =
        mount === 'iframe' ? new EditorPage(page, 0, page.frameLocator('#frame')) : plain;
      await editor.load({ doc: 'empty', mount });
      await page.evaluate(() => {
        const para = (id: string, text: string) => ({
          id,
          type: 'paragraph' as const,
          depth: 0,
          content: [{ text }],
        });
        window.__e2e.editor.setDocument({
          blocks: [para('a', 'Alpha text'), para('b2', 'Beta text'), para('c', 'Gamma')],
        });
      });
      await editor.clickAt('a', 3);
      const viewport = page.viewportSize()!;
      await (mount === 'dialog'
        ? page.mouse.click(10, 10)
        : page.mouse.click(viewport.width - 20, viewport.height - 20));
      expect(await editor.hasFocus()).toBe(false);

      // Paced as the probe was: the find bar opens on `/` asynchronously, and
      // a letter typed before it is open goes to the page instead.
      for (const key of ['/', 'B', 'e', 't']) {
        await page.keyboard.press(key);
        await page.waitForTimeout(80);
      }

      // The find did select the match in the editor -- the case is real.
      await expect
        .poll(() => editor.selection())
        .toMatchObject({ blockId: 'b2', range: { start: 0, end: 3 } });
      await editor.settle();
      await expect(editor.portal('toolbar')).toBeHidden();
      await page.keyboard.press('Escape');
    });
  }

  /*
   * R9-PTR-1. A fixed sheet whose pane has a `transform` scrolls with the
   * pane, but the clip climb stopped at the sheet, so the toolbar for a
   * range stayed drawn over the page after its paragraph had left the pane.
   * The probe's shape (a `translateZ(0)` pane 150px down, a 330px sheet at
   * 180/180), "Head paragraph 2" selected with Shift+End from its start, the
   * pane wheeled 400px from beside the sheet. Layout and scrolling: e2e.
   */
  test('F8c the toolbar goes with a fixed sheet its pane’s transform scrolls away', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await page.evaluate(paneWithSheet, 'transform: translateZ(0)');
    await editor.settle();
    const host = editor.content('h2');
    const start = await editor.pointAt(host, 0);
    await page.mouse.click(start.x, start.y);
    await page.keyboard.press('Shift+End');
    const toolbar = editor.portal('toolbar');
    await expect(toolbar).toBeVisible();

    const pane = (await page.locator('#pane').boundingBox())!;
    await page.mouse.move(pane.x + 20, pane.y + pane.height - 15);
    await page.mouse.wheel(0, 400);
    await editor.settleScroll();
    expect((await host.boundingBox())!.y, 'precondition: above the pane').toBeLessThan(pane.y);
    await expect(toolbar).toBeHidden();
  });

  /*
   * R10-PTR-1. An editor slotted into a component whose shadow tree holds
   * the scrolling pane (Ionic's `<ion-content>`): the pane was neither on the
   * clip climb nor heard scrolling, so the toolbar stayed where it was drawn
   * after its range had scrolled out of the pane. Likewise a fixed sheet
   * slotted in whose containing block is the shadow pane. The probe: a 450px
   * pane in `<x-pane>`'s shadow tree, the editor slotted in (or in a fixed
   * sheet slotted in) with two paragraphs before a table, the first 14
   * characters of the second dragged over, the pane wheeled 360px. Layout and
   * scrolling: e2e.
   */
  test('F8d the toolbar goes with its range out of a pane in a component’s shadow tree', async ({
    editor,
    page,
  }) => {
    for (const variant of ['slotted', 'fixed sheet'] as const) {
      await editor.load({ doc: 'table' });
      await page.evaluate(async (variant) => {
        const stage = document.querySelector<HTMLElement>('#stage')!;
        customElements.define(
          'x-pane',
          class extends HTMLElement {
            constructor() {
              super();
              this.attachShadow({ mode: 'open' }).innerHTML =
                `<style>:host{display:block;margin-top:150px}</style>` +
                `<div id="scroll" style="height:450px;overflow:auto;${variant === 'fixed sheet' ? 'transform:translateZ(0);' : ''}">` +
                `<div style="height:120px">pane head</div><slot></slot><div style="height:1200px">pane tail</div></div>`;
            }
          },
        );
        const pane = document.createElement('x-pane');
        document.body.insertBefore(pane, document.body.firstChild);
        stage.style.margin = '0';
        if (variant === 'fixed sheet') {
          const sheet = document.createElement('div');
          sheet.style.cssText =
            'position:fixed;top:140px;left:20px;width:740px;height:280px;background:#fff';
          pane.append(sheet);
          sheet.append(stage);
        } else {
          pane.append(stage);
        }
        await window.__e2e.remount({}, 'table');
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks = [
          ...Array.from({ length: 2 }, (_, i) => ({
            id: `h${i}`,
            type: 'paragraph' as const,
            depth: 0,
            content: [{ text: `Head paragraph ${i} with some words to select` }],
          })),
          ...doc.blocks,
        ];
        ed.setDocument(doc);
      }, variant);
      await editor.settle();
      await editor.dragText(['h1', 0], ['h1', 14], 5);
      const toolbar = editor.portal('toolbar');
      await expect(toolbar, variant).toBeVisible();

      await page.mouse.move(400, 400);
      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, 120);
      }
      await editor.settleScroll();
      const above = await page.evaluate(() => {
        const scroll = document.querySelector('x-pane')!.shadowRoot!.querySelector('#scroll')!;
        const host = document.querySelector('[data-block-id="h1"] .neditor-block__content')!;
        return host.getBoundingClientRect().bottom <= scroll.getBoundingClientRect().top;
      });
      expect(above, `${variant}: precondition, the range left the pane`).toBe(true);
      await expect(toolbar, variant).toBeHidden();
    }
  });

  /*
   * R10-PTR-5. A `position: absolute` panel declared inside a scroller that
   * is not its containing block is neither clipped nor scrolled by it, but
   * the clip climb took the scroller as clipping: in Firefox and WebKit a
   * wheel over the pane hid the toolbar though its text had not moved. The
   * probe: a 160px pane holding 900px of filler and an absolute panel at
   * 330/260 holding the editor, "After the" selected, the pane wheeled.
   * Layout: e2e.
   */
  test('F8e the toolbar stays for a range in an absolute panel when a pane around it scrolls', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>('#stage')!;
      const pane = document.createElement('div');
      pane.id = 'pane';
      pane.style.cssText = 'height:160px;overflow:auto;width:300px';
      pane.innerHTML = '<div style="height:900px">pane content</div>';
      document.body.insertBefore(pane, document.body.firstChild);
      const sheet = document.createElement('div');
      sheet.style.cssText = 'position:absolute;left:330px;top:260px;width:740px;background:#fff';
      pane.append(sheet);
      stage.style.margin = '0';
      sheet.append(stage);
    });
    await editor.settle();
    await editor.dragText(['after', 0], ['after', 9], 5);
    const toolbar = editor.portal('toolbar');
    await expect(toolbar).toBeVisible();
    const before = (await editor.content('after').boundingBox())!.y;

    const pane = (await page.locator('#pane').boundingBox())!;
    await page.mouse.move(pane.x + 100, pane.y + 60);
    await page.mouse.wheel(0, 100);
    await editor.settleScroll();
    expect(
      await page.locator('#pane').evaluate((e) => e.scrollTop),
      'precondition',
    ).toBeGreaterThan(0);
    expect((await editor.content('after').boundingBox())!.y, 'the text did not move').toBeCloseTo(
      before,
      0,
    );
    await expect(toolbar).toBeVisible();
  });

  /*
   * R11-PTR-3's sibling. In an iframe mount whose frame sits in a scrolling
   * pane of the page around it, every portal was placed by the frame's own
   * window, which the pane cuts: the format toolbar, preferring to go above
   * a range near the top of what the pane showed, found room in the frame
   * and was drawn above the pane, which hides it (70..108 for a pane
   * showing 102..522, in every engine since round 9). The pane is part of
   * what each portal is placed inside (`setAnchorBand`). The probe: a
   * 900x1400 frame in a 420px pane scrolled 300px, the first paragraph
   * wholly under the pane's top, a word double-clicked. Layout: e2e.
   */
  test('F8f the toolbar for a range near the top of a pane around an iframe mount is drawn inside the pane', async ({
    page,
  }) => {
    const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
    await editor.load({ doc: 'long', mount: 'iframe' });
    await page.evaluate(() => {
      document.getElementById('frame')!.style.cssText =
        'display:block;width:900px;height:1400px;border:0';
      const stage = document.getElementById('stage')!;
      stage.id = 'pane';
      stage.style.cssText = 'height:420px;overflow:auto;border:2px solid #888;margin:0';
      stage.scrollTop = 300;
    });
    await editor.settle();
    const pane = (await page.locator('#pane').boundingBox())!;
    const shown = { top: pane.y + 2, bottom: pane.y + 2 + 420 };
    let id = '';
    for (let i = 0; i < 60 && !id; i++) {
      const box = (await editor.content(`p${i}`).boundingBox())!;
      if (box.y >= shown.top + 4) id = `p${i}`;
    }
    const word = await editor.pointAt(editor.content(id), 3);
    await page.mouse.dblclick(word.x, word.y);
    const toolbar = editor.portal('toolbar');
    await expect(toolbar).toBeVisible();
    const bar = (await toolbar.boundingBox())!;
    expect(bar.y, 'inside the pane').toBeGreaterThanOrEqual(shown.top - 1);
    expect(bar.y + bar.height, 'inside the pane').toBeLessThanOrEqual(shown.bottom + 1);
  });

  /*
   * R12-PTR-1, F8f's other half. With `portalContainer` in the page around
   * the frame the toolbar is `position: fixed` in that page and drawn over
   * the pane, which does not hide it: it goes above a range near the pane's
   * top, its preferred side, wherever the page's window has room. Placed by
   * what the pane showed of the frame instead (`setAnchorBand`, cut by the
   * pane), it flipped below the range. Same layout as F8f, the pane at the
   * window's y 250. Layout: e2e.
   */
  test('F8g the toolbar the page around a frame in a pane draws keeps its side above the range', async ({
    page,
  }) => {
    const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
    await editor.load({ doc: 'long', mount: 'iframe', portal: 'body' });
    await page.evaluate(() => {
      document.getElementById('frame')!.style.cssText =
        'display:block;width:900px;height:1400px;border:0';
      const stage = document.getElementById('stage')!;
      stage.id = 'pane';
      stage.style.cssText = 'height:420px;overflow:auto;border:2px solid #888;margin:0';
      stage.style.marginTop = `${250 - stage.getBoundingClientRect().top}px`;
      stage.scrollTop = 300;
    });
    await editor.settle();
    const pane = (await page.locator('#pane').boundingBox())!;
    const shown = { top: pane.y + 2, bottom: pane.y + 2 + 420 };
    let id = '';
    for (let i = 0; i < 60 && !id; i++) {
      const box = (await editor.content(`p${i}`).boundingBox())!;
      if (box.y >= shown.top + 4) id = `p${i}`;
    }
    const range = (await editor.content(id).boundingBox())!;
    expect(range.y - shown.top, 'precondition: no room above it in the pane').toBeLessThan(40);
    const word = await editor.pointAt(editor.content(id), 3);
    await page.mouse.dblclick(word.x, word.y);
    const toolbar = page.locator('.neditor-portal.neditor-toolbar');
    await expect(toolbar).toBeVisible();
    await editor.settle();
    const bar = (await toolbar.boundingBox())!;
    expect(bar.y + bar.height, 'above the range').toBeLessThanOrEqual(range.y + 1);
    expect(bar.y, 'in the window').toBeGreaterThanOrEqual(0);
  });

  /*
   * R9-PTR-4. The toolbar was judged on screen by its range's whole block,
   * so in a paragraph taller than the window it stayed clamped at the
   * window's top after the range had scrolled away -- and a peer's
   * `setDocument` drew it again there. The probes: 900 words with "word5"
   * double-clicked and the page wheeled 600px; 1400 words with offsets 6-8
   * selected, the page wheeled 900px, then a peer's edit to the last block.
   * A wheel that leaves the range on screen keeps the toolbar. Layout: e2e.
   */
  test('F9c the toolbar goes when its range scrolls away in a paragraph taller than the window', async ({
    editor,
    page,
  }) => {
    for (const probe of ['word', 'peer'] as const) {
      await editor.load({ doc: 'empty' });
      await page.evaluate(
        (count) => {
          const words = Array.from({ length: count }, (_, i) => `word${i}`).join(' ');
          const para = (id: string, text: string) => ({
            id,
            type: 'paragraph' as const,
            depth: 0,
            content: [{ text }],
          });
          const ed = window.__e2e.editor;
          ed.setDocument({ blocks: [para('a', 'Intro'), para('p', words), para('c', 'Gamma')] });
          ed.clearHistory();
        },
        probe === 'word' ? 900 : 1400,
      );
      await editor.settle();
      const host = editor.content('p');
      if (probe === 'word') {
        const point = await editor.pointAt(host, 'word0 word1 word2 word3 word4 word5'.length - 2);
        await page.mouse.dblclick(point.x, point.y);
      } else {
        const point = await editor.pointAt(host, 6);
        await page.mouse.click(point.x, point.y);
        await shiftSelect(page, 2);
      }
      await editor.settle();
      const toolbar = editor.portal('toolbar');
      await expect(toolbar, probe).toBeVisible();

      await page.mouse.move(500, 400);
      await page.mouse.wheel(0, 40);
      await editor.settleScroll();
      await expect(toolbar, `${probe}: the range still on screen`).toBeVisible();

      await page.mouse.wheel(0, probe === 'word' ? 560 : 860);
      await editor.settleScroll();
      const box = (await host.boundingBox())!;
      expect(box.y + box.height, `${probe}: precondition`).toBeGreaterThan(
        page.viewportSize()!.height,
      );
      await expect(toolbar, probe).toBeHidden();

      if (probe === 'peer') {
        await page.evaluate(() => {
          const ed = window.__e2e.editor;
          const doc = ed.getDocument();
          doc.blocks[2]!.content = [{ text: 'Gamma peer' }];
          ed.setDocument(doc);
        });
        await editor.settle();
        await expect(toolbar, 'after the peer’s edit').toBeHidden();
        expect((await editor.selection())?.range).toEqual({ start: 6, end: 8 });
      }
    }
  });

  /*
   * R13-PTR-2, p4's and p12's literal cases. `?doc=long`, a word in the
   * fourth block double-clicked, the page wheeled 1500px down, then a peer
   * putting "Peer. " in front of that very block, or a lock round trip; and
   * `?doc=paragraphs`, "two" double-clicked, a peer putting sixty lines in
   * front of it in p2, which pushes the range below the window; and p1's,
   * the toolbar showing at a lock and the page wheeled away before the
   * unlock. The editor
   * carries the range across and writes it back, and that write's
   * `selectionchange` (and, for the unlock, its focus) drew the toolbar
   * clamped to the window's edge for a range no one could see; its Bold
   * bolded the hidden word. Layout: e2e.
   */
  test('F9d the editor’s own write of a carried range off screen draws no toolbar', async ({
    editor,
    page,
  }) => {
    for (const what of ['peer', 'lock', 'scrolled during the lock'] as const) {
      await editor.load({ doc: 'long' });
      const host = editor.content('p3');
      const point = await editor.pointAt(host, 3);
      await page.mouse.dblclick(point.x, point.y);
      const toolbar = editor.portal('toolbar');
      await expect(toolbar, what).toBeVisible();
      if (what === 'scrolled during the lock') {
        await page.evaluate(() => window.__e2e.editor.setEditable(false));
      }
      await page.mouse.move(500, 400);
      await page.mouse.wheel(0, 1500);
      await editor.settleScroll();
      await expect(toolbar, `${what}: scrolled away`).toBeHidden();

      await page.evaluate((what) => {
        const ed = window.__e2e.editor;
        if (what === 'scrolled during the lock') {
          ed.setEditable(true);
          return;
        }
        if (what === 'lock') {
          ed.setEditable(false);
          ed.setEditable(true);
          return;
        }
        const doc = ed.getDocument();
        doc.blocks[3]!.content = [{ text: `Peer. ${doc.blocks[3]!.content[0]!.text}` }];
        ed.setDocument(doc);
      }, what);
      await editor.settle();
      await page.waitForTimeout(100);
      expect((await editor.selection())?.range, what).toEqual(
        what === 'peer' ? { start: 6, end: 15 } : { start: 0, end: 9 },
      );
      await expect(toolbar, what).toBeHidden();
    }

    await editor.load({ doc: 'paragraphs' });
    const point = await editor.pointAt(editor.content('p2'), 7);
    await page.mouse.dblclick(point.x, point.y);
    const toolbar = editor.portal('toolbar');
    await expect(toolbar).toBeVisible();
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const doc = ed.getDocument();
      const lines = Array.from({ length: 60 }, (_, i) => `peer line ${i}\n`).join('');
      doc.blocks[1]!.content = [{ text: `${lines}Bravo two` }];
      ed.setDocument(doc);
    });
    await editor.settle();
    await page.waitForTimeout(100);
    const range = await editor.content('p2').evaluate(() => {
      const selection = getSelection()!;
      return [selection.toString(), selection.getRangeAt(0).getBoundingClientRect().top];
    });
    expect(range[0]).toBe('two');
    expect(range[1], 'precondition: pushed below the window').toBeGreaterThan(
      page.viewportSize()!.height,
    );
    await expect(toolbar, 'pushed off').toBeHidden();
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
