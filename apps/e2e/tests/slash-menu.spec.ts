import type { Locator } from '@playwright/test';
import { EditorPage, expect, test } from '../helpers/test.ts';

const options = (editor: EditorPage): Locator =>
  editor.portal('slash-menu').locator('[role=option]');
const active = (editor: EditorPage): Locator =>
  editor.portal('slash-menu').locator('[role=option][aria-selected=true]');

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
    expect(count).toBe(15);

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
    ['Equation', 'math', '.neditor-math-block > div.neditor-block__content[spellcheck=false]'],
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

  test('SL8 closes on outside pointer, a scroll that takes the caret off screen, block selection and moving to another block', async ({
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

    // A resize that leaves the caret on screen moves the menu, not closes it:
    // the menu describes the caret, and the caret is still there.
    await undoSlash();
    await reopen();
    await page.setViewportSize({ width: 1000, height: 760 });
    await editor.settle();
    await expect(editor.portal('slash-menu')).toBeVisible();
    await page.keyboard.press('Escape');

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

  // e2e only: the defect is the browser's own scroll-into-view of the caret,
  // which happy-dom neither performs nor lays out.
  test('SL10 a "/" on a half-visible line survives the scroll that brings the caret into view', async ({
    editor,
    page,
  }) => {
    // Was UI-1: the ~9px scroll-into-view closed the menu a frame after it
    // opened, and the query stayed in the text as literal characters.
    await editor.load({ doc: 'long', scroll: 1 });
    const height = page.viewportSize()!.height;
    await editor.content('p30').evaluate((element, height) => {
      const box = element.getBoundingClientRect();
      window.scrollTo(0, box.top + window.scrollY - (height - box.height / 2));
    }, height);
    await editor.settleScroll();
    const box = (await editor.content('p30').boundingBox())!;
    expect(box.y + box.height).toBeGreaterThan(height);
    await page.mouse.click(box.x + 1, box.y + 4);
    await editor.settle();

    await editor.type('/');
    await editor.settleScroll();
    const menu = editor.portal('slash-menu');
    await expect(menu).toBeVisible();
    // Laid out against where the caret is now, not where it was.
    const block = (await editor.content('p30').boundingBox())!;
    const placed = (await menu.boundingBox())!;
    expect(placed.y + placed.height).toBeLessThanOrEqual(block.y + 1);

    await editor.type('quo');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Enter');
    expect((await editor.outline())[30]).toBe('quote:Paragraph number 30');
  });

  /*
   * R8-PTR-1. The same scroll-into-view, in an editor whose scroller is not
   * clipped by the pane it is declared in -- a fixed sheet, a modal dialog.
   * "On screen" clipped the caret's host by that pane too, read it as
   * scrolled away, and closed the menu (Firefox and WebKit, the sheet), the
   * query left as text. The probe: the first tail paragraph under the
   * scroller's bottom edge cut to its top 10px, a click at its end, " /".
   * Layout and the browser's own scroll: e2e.
   */
  test('SL10b a "/" survives that scroll in a fixed sheet or a modal dialog inside a scrolling pane', async ({
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
      const host = editor.content(id);
      const box = (await host.boundingBox())!;
      const end = await editor.pointAt(host, (await host.textContent())!.length);
      await page.mouse.click(end.x, box.y + 4);
      await editor.settle();

      const scroller = page.locator(shell === 'fixed sheet' ? '#scroller' : '#dialog');
      const before = await scroller.evaluate((element) => element.scrollTop);
      await editor.type(' /');
      // Until the browser's scroll-into-view has happened and stopped: the
      // menu has to outlive it, not merely open before it.
      let last = -1;
      await expect
        .poll(
          async () => {
            const now = await scroller.evaluate((element) => element.scrollTop);
            const still = now === last && now > before;
            last = now;
            return still;
          },
          { intervals: [100] },
        )
        .toBe(true);
      await editor.settle();
      await expect(editor.portal('slash-menu'), shell).toBeVisible();
      await page.keyboard.press('Escape');
    }
  });

  /*
   * R9-PTR-1. A fixed sheet whose pane has a `transform` scrolls with the
   * pane, but the clip climb stopped at the sheet, so a "/" menu stayed
   * drawn over the page after its paragraph had left the pane. The probe's
   * shape (a `translateZ(0)` pane 150px down, a 330px sheet at 180/180),
   * " /" typed at the end of "Head paragraph 2", the pane wheeled 400px
   * from beside the sheet. Layout and scrolling: e2e.
   */
  test('SL10c a "/" menu goes with a fixed sheet its pane’s transform scrolls away', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await page.evaluate(paneWithSheet, 'transform: translateZ(0)');
    await editor.settle();
    const host = editor.content('h2');
    const end = await editor.pointAt(host, 'Head paragraph 2'.length);
    await page.mouse.click(end.x, end.y);
    await editor.type(' /');
    const menu = editor.portal('slash-menu');
    await expect(menu).toBeVisible();

    const pane = (await page.locator('#pane').boundingBox())!;
    await page.mouse.move(pane.x + 20, pane.y + pane.height - 15);
    await page.mouse.wheel(0, 400);
    await editor.settleScroll();
    expect((await host.boundingBox())!.y, 'precondition: above the pane').toBeLessThan(pane.y);
    await expect(menu).toBeHidden();
  });

  /*
   * R10-RV-PTR-1. In an iframe mount drawn at half scale (`transform:
   * scale(0.5)`) the page around the frame shows its window at half size, so
   * that window cuts what is on screen only through the scale. Cut in the
   * page's own pixels, a "/" drawn at the outer y 420 read as off screen
   * once the page was wheeled 40-60px, and the menu closed, leaving the "/"
   * as text. The probe: a 2000x1500 frame at `scale(0.5)` from its top left,
   * 40 paragraphs before a table, " /" typed at the end of paragraph 30, the
   * page wheeled 60px. Layout and frames: e2e.
   */
  /*
   * R11-RV-PTR-1. Every portal of an iframe mount chooses its side by what
   * the page around the frame shows of it (`setAnchorBand`), and only its
   * side: a portal bigger than that part is placed against its anchor on the
   * side with more of it seen and clamped to its own viewport alone. Clamped
   * into the seen part itself, the 320px slash menu with 200px of the frame
   * on screen was pulled up over its own caret line (372..692 over
   * 569..587) and its top past the frame's, which clips it -- the option
   * Enter applies was out of sight. The probe: a 900x600 frame with only its
   * top 200px in the window, or in a 200px pane of the page; the end of the
   * second paragraph clicked, Enter, "/"; and in the same layout the icon
   * picker and the image editor opened from a callout's icon and an image
   * near the frame's top. Layout and frames: e2e.
   */
  test('SL10e a portal bigger than what shows of its frame stays beside its anchor, its first control seen', async ({
    page,
  }) => {
    const PNG =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

    for (const layout of ['partly in the window', 'in a 200px pane'] as const) {
      const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
      await editor.load({ doc: 'empty', mount: 'iframe' });
      await page.evaluate(
        ({ layout, PNG }) => {
          const frame = document.getElementById('frame')!;
          frame.style.cssText = 'display:block;width:900px;height:600px;border:0';
          const stage = document.getElementById('stage')!;
          stage.style.maxWidth = 'none';
          if (layout === 'in a 200px pane') {
            stage.id = 'pane';
            stage.style.cssText = 'height:200px;overflow:auto;margin:0';
            const after = document.createElement('div');
            after.style.height = '400px';
            stage.append(after);
          } else {
            const top = frame.getBoundingClientRect().top;
            stage.style.marginTop = `${innerHeight - 200 - top + 16}px`;
            document.body.style.minHeight = '3000px';
          }
          const p = (id: string, text: string) => ({
            id,
            type: 'paragraph' as const,
            depth: 0,
            content: [{ text }],
          });
          window.__e2e.editor.setDocument({
            blocks: [
              p('p0', 'Paragraph number 0 with some words in it'),
              p('p1', 'Paragraph number 1 with some words in it'),
              { id: 'co', type: 'callout', depth: 0, icon: '💡', content: [{ text: 'Note' }] },
              { id: 'img', type: 'image', depth: 0, content: [], src: PNG, alt: 'dot' },
              ...[2, 3, 4, 5, 6, 7].map((i) => p(`p${i}`, `Paragraph number ${i}`)),
            ],
          });
        },
        { layout, PNG },
      );
      await editor.settle();
      const height = page.viewportSize()!.height;
      // What shows of the frame now: a focus moved into a portal the page has
      // to scroll to (Firefox) moves the frame.
      const seenNow = async () => {
        const frameBox = (await page.locator('#frame').boundingBox())!;
        const pane =
          layout === 'in a 200px pane' ? await page.locator('#pane').boundingBox() : null;
        return {
          top: Math.max(0, frameBox.y, pane?.y ?? 0),
          bottom: Math.min(
            height,
            frameBox.y + frameBox.height,
            pane ? pane.y + pane.height : height,
          ),
        };
      };
      const seen = await seenNow();
      expect(seen.bottom - seen.top, `${layout}: precondition`).toBeLessThanOrEqual(201);
      const check = async (
        label: string,
        portal: ReturnType<EditorPage['portal']>,
        anchor: Locator,
        first: Locator,
      ) => {
        await expect(portal, `${layout}, ${label}`).toBeVisible();
        await editor.settle();
        const box = (await portal.boundingBox())!;
        const at = (await anchor.boundingBox())!;
        expect(
          box.y >= at.y + at.height - 1 || box.y + box.height <= at.y + 1,
          `${layout}, ${label}: beside its anchor, not over it`,
        ).toBe(true);
        const now = await seenNow();
        // Its middle: Firefox scrolls a focused control into view by a pane's
        // edge, a pixel or two either way.
        const control = (await first.boundingBox())!;
        const middle = control.y + control.height / 2;
        expect(middle, `${layout}, ${label}: its first control is seen`).toBeGreaterThan(now.top);
        expect(middle, `${layout}, ${label}: its first control is seen`).toBeLessThan(now.bottom);
      };

      const p1 = (await editor.content('p1').boundingBox())!;
      await page.mouse.click(p1.x + p1.width - 3, p1.y + p1.height / 2);
      await page.keyboard.press('Enter');
      await page.keyboard.type('/');
      const menu = editor.portal('slash-menu');
      const line = editor.scope.locator('.neditor-block__content:focus');
      await check('slash menu', menu, line, menu.locator('[aria-selected="true"]'));
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');

      const iconControl = editor.block('co').locator('.neditor-block__icon');
      const icon = (await iconControl.boundingBox())!;
      expect(icon.y + icon.height, `${layout}: precondition, the icon is seen`).toBeLessThan(
        seen.bottom,
      );
      await page.mouse.click(icon.x + icon.width / 2, icon.y + icon.height / 2);
      const picker = editor.portal('icon-picker');
      // Its field, which comes first and takes the focus as it opens.
      await check('icon picker', picker, iconControl, picker.getByRole('textbox'));
      await page.keyboard.press('Escape');

      const trigger = editor.block('img').locator('.neditor-image__trigger');
      const shot = (await trigger.boundingBox())!;
      expect(shot.y, `${layout}: precondition, the image is seen`).toBeLessThan(seen.bottom - 4);
      await page.mouse.click(shot.x + shot.width / 2, Math.min(shot.y + 2, seen.bottom - 4));
      const dialog = editor.portal('image-editor');
      await check('image editor', dialog, trigger, dialog.getByRole('textbox').first());
      await page.keyboard.press('Escape');
    }
  });

  /*
   * R12-PTR-1. With `portalContainer` in the page around an iframe mount the
   * portals are `position: fixed` in that page, drawn over a scrolling pane
   * the frame sits in, which clips the frame and not them. Each was still
   * placed by what the pane showed of the frame (`setAnchorBand`, cut by the
   * pane): a "/" on a line with a little more of the pane below it than
   * above put the 320px menu below its caret and past the window (613..933
   * in an 800px window), and its third option on was highlighted out of
   * sight. Only what clips the page a portal is drawn in cuts its band. The
   * probe: 40 paragraphs in a 1100px frame in a 300px pane at the window's
   * y 450, " /" at the end of the line drawn at 586. Layout and frames: e2e.
   */
  test('SL10f a "/" menu drawn in the page around a frame in a pane is placed by that page, not the pane', async ({
    page,
  }) => {
    const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
    await editor.load({ doc: 'empty', mount: 'iframe', portal: 'body' });
    await page.evaluate(() => {
      window.__e2e.editor.setDocument({
        blocks: Array.from({ length: 40 }, (_, i) => ({
          id: `b${i}`,
          type: 'paragraph' as const,
          depth: 0,
          content: [{ text: `Line number ${i} with some words` }],
        })),
      });
      const frame = document.querySelector<HTMLIFrameElement>('#frame')!;
      frame.style.cssText = 'display:block;width:900px;height:1100px;border:0';
      const stage = document.getElementById('stage')!;
      stage.id = 'pane';
      stage.style.cssText =
        'height:300px;overflow:auto;border:2px solid #888;box-sizing:border-box;margin:0';
      stage.style.marginTop = `${450 - stage.getBoundingClientRect().top}px`;
      const line = frame.contentDocument!.querySelector(
        '[data-block-id="b10"] .neditor-block__content',
      )!;
      stage.scrollTop += frame.getBoundingClientRect().top + line.getBoundingClientRect().top - 580;
    });
    await editor.settle();
    const height = page.viewportSize()!.height;
    const pane = (await page.locator('#pane').boundingBox())!;
    const host = editor.content('b10');
    const line = (await host.boundingBox())!;
    const above = line.y - pane.y;
    const below = pane.y + pane.height - (line.y + line.height);
    expect(below, 'precondition: the pane shows more below the line').toBeGreaterThan(above);
    expect(below, 'precondition: but not room for the menu').toBeLessThan(320);
    expect(line.y, 'precondition: the window has room above').toBeGreaterThan(340);

    const end = await editor.pointAt(host, 'Line number 10 with some words'.length);
    await page.mouse.click(end.x + 2, end.y);
    await page.keyboard.type(' /');
    const menu = page.locator('.neditor-portal.neditor-slash-menu');
    await expect(menu).toBeVisible();
    await editor.settle();
    const box = (await menu.boundingBox())!;
    expect(
      box.y >= line.y + line.height - 1 || box.y + box.height <= line.y + 1,
      'beside its line, not over it',
    ).toBe(true);
    expect(box.y, 'in the window').toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, 'in the window').toBeLessThanOrEqual(height);

    for (let i = 1; i <= 5; i++) {
      await page.keyboard.press('ArrowDown');
      const option = (await menu.locator('[aria-selected="true"]').boundingBox())!;
      expect(
        option.y + option.height,
        `↓×${i}: the highlighted option is seen`,
      ).toBeLessThanOrEqual(height);
      expect(option.y, `↓×${i}: the highlighted option is seen`).toBeGreaterThanOrEqual(0);
    }
  });

  test('SL10d a "/" menu in a frame drawn at half scale survives a small scroll of the page', async ({
    page,
  }) => {
    const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
    await editor.load({ doc: 'table', mount: 'iframe' });
    await page.evaluate(() => {
      document.getElementById('frame')!.style.cssText =
        'width:2000px;height:1500px;border:0;transform:scale(0.5);transform-origin:0 0;display:block';
      document.body.style.minHeight = '3000px';
      const ed = window.__e2e.editor;
      const doc = ed.getDocument();
      doc.blocks = [
        ...Array.from({ length: 40 }, (_, i) => ({
          id: `f${i}`,
          type: 'paragraph' as const,
          depth: 0,
          content: [{ text: `Filler paragraph ${i}` }],
        })),
        ...doc.blocks,
      ];
      ed.setDocument(doc);
    });
    await editor.settle();
    const host = editor.content('f30');
    // Just past the end of its text, lifted through the frame's half scale
    // (`pointAt` lifts by the offset only).
    const end = await host.evaluate((element) => {
      const text = element.firstChild as Text;
      const range = document.createRange();
      range.setStart(text, text.length - 1);
      range.setEnd(text, text.length);
      const box = range.getBoundingClientRect();
      return { x: box.right + 2, y: (box.top + box.bottom) / 2 };
    });
    const frame = (await page.locator('#frame').boundingBox())!;
    await page.mouse.click(frame.x + end.x * 0.5, frame.y + end.y * 0.5);
    await expect(host).toBeFocused();
    await editor.type(' /');
    const menu = editor.portal('slash-menu');
    await expect(menu).toBeVisible();

    await page.mouse.move(550, 300);
    await page.mouse.wheel(0, 60);
    await editor.settleScroll();
    expect(
      await page.evaluate(() => window.scrollY),
      'precondition: the page moved',
    ).toBeGreaterThan(0);
    expect(
      (await host.boundingBox())!.y,
      'precondition: the "/" is still on screen',
    ).toBeGreaterThan(0);
    await expect(menu).toBeVisible();
  });

  /*
   * R9-PTR-4. The menu was judged on screen by its whole block, so in a
   * paragraph taller than the window it stayed clamped at the window's top
   * after its "/" had scrolled away, where an Enter meant for the text
   * applied a command. The probe: 900 words, a "/" typed after "word3 ", the
   * page wheeled 600px. A wheel that leaves the "/" on screen keeps the
   * menu. Layout: e2e.
   */
  test('SL8b a "/" menu goes when its text scrolls away in a paragraph taller than the window', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await page.evaluate(() => {
      const words = Array.from({ length: 900 }, (_, i) => `word${i}`).join(' ');
      const para = (id: string, text: string) => ({
        id,
        type: 'paragraph' as const,
        depth: 0,
        content: [{ text }],
      });
      window.__e2e.editor.setDocument({
        blocks: [para('top', 'Intro'), para('long', words), para('end', 'End')],
      });
    });
    await editor.settle();
    const host = editor.content('long');
    const point = await editor.pointAt(host, 'word0 word1 word2 word3 '.length);
    await page.mouse.click(point.x, point.y);
    await editor.type('/');
    const menu = editor.portal('slash-menu');
    await expect(menu).toBeVisible();

    await page.mouse.move(500, 500);
    await page.mouse.wheel(0, 40);
    await editor.settleScroll();
    await expect(menu, 'the "/" still on screen').toBeVisible();

    await page.mouse.wheel(0, 560);
    await editor.settleScroll();
    const box = (await host.boundingBox())!;
    expect(box.y + box.height, 'precondition: the block fills the window').toBeGreaterThan(
      page.viewportSize()!.height,
    );
    await expect(menu).toBeHidden();
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

  // BL P3-1, the finding's literal input: " /quo" then Shift+Enter made the
  // paragraph a quote. Shift+Enter is a soft break in every block.
  test('SL11 Shift+Enter with the menu open is a soft break, not a choice', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.caretAtEnd('p1');
    const before = (await editor.blockData('p1'))!.content.map((run) => run.text).join('');
    await editor.type(' /quo');
    await expect(editor.portal('slash-menu')).toBeVisible();
    await page.keyboard.press('Shift+Enter');
    await expect(editor.portal('slash-menu')).toBeHidden();
    await editor.type('x');
    const block = (await editor.blockData('p1'))!;
    expect(block.type).toBe('paragraph');
    expect(block.content.map((run) => run.text).join('')).toBe(`${before} /quo\nx`);
  });
});
