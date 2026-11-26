import type { Locator } from '@playwright/test';
import { EditorPage, expect, MOD, test } from '../helpers/test.ts';

async function inViewport(portal: Locator, width: number, height: number): Promise<void> {
  const box = (await portal.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
}

test.describe('18 · popover ownership & viewport', () => {
  test('PO1 Escape after clicking away acts on the new block; the caret does not jump back', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await editor.placeCaret('a', 0, 5);
    await page.keyboard.press(`${MOD}+k`);
    await expect(editor.portal('link-editor')).toBeVisible();

    await editor.clickAt('d', 3);
    await expect(editor.portal('link-editor')).toBeHidden();
    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual(['d']);
  });

  test('PO2 Escape in one table cell does not dismiss a popover another cell opened', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await editor.placeCaret('tbl', 0, 2, { row: 1, column: 0 });
    await page.keyboard.press(`${MOD}+k`);
    await expect(editor.portal('link-editor')).toBeVisible();
    await editor.cell('tbl', 2, 2).click();
    await expect(editor.portal('link-editor')).toBeHidden();
    await page.keyboard.press('Escape');
    // The Escape belonged to cell 2:2: it stepped up to the table.
    expect(await editor.selected()).toEqual(['tbl']);
  });

  test('PO3 a page scroll keeps the slash menu open until its caret leaves the screen, and keeps the table toolbar and a focused link editor open; a scroll inside a portal closes nothing', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'kitchen-sink', scroll: 1 });
    await editor.placeCaret('tbl', 0, 0, { row: 1, column: 0 });
    await editor.settle();
    await expect(editor.portal('table-toolbar')).toBeVisible();
    await page.mouse.wheel(0, 40);
    await editor.settle();
    await expect(editor.portal('table-toolbar')).toBeVisible();

    await editor.placeCaret('end', 0);
    await editor.settle();
    await editor.type('/');
    await expect(editor.portal('slash-menu')).toBeVisible();
    // Scroll the menu's own list: the menu stays.
    const list = editor.portal('slash-menu').locator('[role=listbox]');
    await list.evaluate((element) => {
      element.scrollTop = 120;
      element.dispatchEvent(new Event('scroll'));
    });
    await editor.settle();
    await expect(editor.portal('slash-menu')).toBeVisible();
    // A page scroll moves the menu with its caret (UI-1: closing on any scroll
    // lost it to the browser's own scroll-into-view of the caret)...
    await page.mouse.wheel(0, 40);
    await editor.settleScroll();
    await expect(editor.portal('slash-menu')).toBeVisible();
    // ...and closes it once the caret's block has left the screen.
    await editor.content('end').evaluate((element) => {
      window.scrollBy(0, element.getBoundingClientRect().bottom + 10);
    });
    await expect(editor.portal('slash-menu')).toBeHidden();

    await editor.placeCaret('para', 0, 5);
    await editor.settle();
    await page.keyboard.press(`${MOD}+k`);
    await expect(editor.portal('link-editor')).toBeVisible();
    // The link dialog holds focus, so it is being typed into: it follows its
    // anchor rather than closing and sending the rest of the URL into the
    // document (and a resize is what an opening soft keyboard looks like).
    await page.evaluate(() => window.scrollBy(0, 30));
    await editor.settle();
    await expect(editor.portal('link-editor')).toBeVisible();
    await expect(editor.portal('link-editor').getByRole('textbox')).toBeFocused();
  });

  for (const [width, height] of [
    [1100, 800],
    [375, 667],
    // UI-6: the slash menu had no max-width and overflowed a 320px screen.
    [320, 568],
  ] as const) {
    test(`PO4 every portal stays inside a ${width}×${height} viewport`, async ({
      editor,
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await editor.load({ doc: 'kitchen-sink' });

      // Blocks near the top, so placing the caret does not scroll the page
      // under the portals being measured.
      await editor.placeCaret('para', 0, 5);
      await editor.settle();
      await inViewport(editor.portal('toolbar'), width, height);
      await page.keyboard.press(`${MOD}+k`);
      await inViewport(editor.portal('link-editor'), width, height);
      await page.keyboard.press('Escape');

      await editor.placeCaret('h2', 0);
      await editor.settle();
      await editor.type('/');
      await inViewport(editor.portal('slash-menu'), width, height);
      await page.keyboard.press('Escape');

      await editor.clickControl(editor.block('img').locator('.neditor-image__trigger'));
      await inViewport(editor.portal('image-editor'), width, height);
      await page.keyboard.press('Escape');

      await editor.clickControl(editor.block('co').locator('.neditor-block__icon'));
      await inViewport(editor.portal('icon-picker'), width, height);
      await page.keyboard.press('Escape');

      await editor.placeCaret('tbl', 0, 0, { row: 1, column: 1 });
      await editor.settle();
      await inViewport(editor.portal('table-toolbar'), width, height);
    });
  }

  // e2e only: where Tab goes is focus navigation, which happy-dom does not do.
  test('PO5 Tab or Shift+Tab out of a dialog closes it, so a later Apply cannot link a stale range', async ({
    editor,
    page,
    browserName,
  }) => {
    // Was UI-2 / A11Y-2: the dialog stayed open and owned after focus left it,
    // and clicking Apply later linked the saved range -- over "XYZ " typed in
    // the meantime.
    await editor.load({ doc: 'paragraphs' });
    const dialog = editor.portal('link-editor');
    await editor.clickAt('p1', 0);
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Shift+ArrowRight');
    }
    await page.keyboard.press(`${MOD}+k`);
    await expect(dialog).toBeVisible();
    await editor.type('https://a.test/');

    await page.keyboard.press('Shift+Tab');
    await expect(dialog).toBeHidden();
    // Not handed back to the block: focus is where the reader sent it.
    expect(await editor.hasFocus()).toBe(false);
    await editor.clickAt('p1', 0);
    await editor.type('XYZ ');
    expect((await editor.blockData('p1'))?.content).toEqual([{ text: 'XYZ Alpha one' }]);

    for (const [open, portal] of [
      [
        () => editor.clickControl(editor.block('img').locator('.neditor-image__trigger')),
        'image-editor',
      ],
      [
        () => editor.clickControl(editor.block('co').locator('.neditor-block__icon')),
        'icon-picker',
      ],
    ] as const) {
      await editor.load({ doc: portal === 'image-editor' ? 'image' : 'callout' });
      await open();
      await expect(editor.portal(portal)).toBeVisible();
      await page.keyboard.press('Shift+Tab');
      // The icon picker opens on its custom-icon field, after the grid.
      for (let i = 0; i < 40 && (await editor.portal(portal).isVisible()); i += 1) {
        await page.keyboard.press('Shift+Tab');
      }
      await expect(editor.portal(portal)).toBeHidden();
    }

    // Forwards, off the end of the page and back in. Playwright's Firefox keeps
    // focus on the last control instead of leaving the document.
    test.skip(browserName === 'firefox', 'Playwright Firefox does not Tab out of the page');
    await editor.load({ doc: 'paragraphs' });
    await editor.placeCaret('p1', 0, 4);
    await page.keyboard.press(`${MOD}+k`);
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 10 && (await dialog.isVisible()); i += 1) {
      await page.keyboard.press('Tab');
    }
    await expect(dialog).toBeHidden();
  });

  test('PO6 focus leaving for an outside field takes the format toolbar with it', async ({
    editor,
    page,
  }) => {
    // Was UI-3 (WebKit): no selectionchange fires there, so the toolbar stayed
    // drawn over the page, its buttons acting on a selection the reader left.
    await editor.load({ doc: 'paragraphs' });
    await editor.clickAt('p2', 3);
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await expect(editor.portal('toolbar')).toBeVisible();
    await page.locator('#after').click();
    await expect(editor.portal('toolbar')).toBeHidden();

    // A move into the editor's own portals is not leaving.
    await editor.placeCaret('p2', 0, 5);
    await expect(editor.portal('toolbar')).toBeVisible();
    await page.keyboard.press(`${MOD}+k`);
    await expect(editor.portal('link-editor')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(editor.portal('toolbar')).toBeVisible();
  });

  test('PO7 a block control reached by Tab takes the keys; the text it came from does not', async ({
    editor,
    page,
  }) => {
    // Was UI-7 (WebKit): Tab onto the callout icon or the toggle chevron left
    // the selection in the block before, and typing W there read "BeforeW".
    for (const [doc, control] of [
      ['callout', '.neditor-block__icon'],
      ['toggle-open', '.neditor-block__chevron'],
    ] as const) {
      await editor.load({ doc });
      // A caret placed by the mouse, as in the finding: one placed through the
      // API did not reproduce it.
      await editor.clickAt('before', 'Before'.length);
      await page.keyboard.press('Tab');
      await expect(editor.root.locator(control)).toBeFocused();
      await editor.type('W');
      expect((await editor.texts())[0]).toBe('Before');
    }
  });

  // e2e only: where Tab and Shift+Tab move focus is focus navigation.
  test('PO8 Shift+Tab back from a block control finds the caret, or the range, where it was', async ({
    editor,
    page,
  }) => {
    // Was R2-UI-7: the selection the control dropped was gone for good, so
    // every engine came back at offset 0 -- natively they all keep it.
    for (const [doc, control] of [
      ['toggle-open', '.neditor-block__chevron'],
      ['callout', '.neditor-block__icon'],
    ] as const) {
      await editor.load({ doc });
      await editor.clickAt('before', 3);
      await page.keyboard.press('Tab');
      await expect(editor.root.locator(control)).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      expect(await editor.selection()).toMatchObject({
        blockId: 'before',
        range: { start: 3, end: 3 },
      });
      await editor.type('X');
      expect((await editor.texts())[0]).toBe('BefXore');

      await editor.load({ doc });
      await editor.clickAt('before', 1);
      await page.keyboard.press('Shift+ArrowRight');
      await page.keyboard.press('Shift+ArrowRight');
      await page.keyboard.press('Tab');
      await expect(editor.root.locator(control)).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      expect(await editor.selection()).toMatchObject({
        blockId: 'before',
        range: { start: 1, end: 3 },
      });
    }
  });

  // e2e only: a scroll inside a shadow root, and where a portal is drawn.
  test('PO9 the floating UI follows a scroller inside a shadow root', async ({ editor }) => {
    // Was R2-UI-6: scroll events are not composed, and only the document was
    // listened to, so a root scrolling inside its shadow tree left every
    // portal where it opened while the text moved under it.
    await editor.load({ doc: 'long', mount: 'shadow' });
    await editor.root.evaluate((element) => {
      (element as HTMLElement).style.height = '300px';
      (element as HTMLElement).style.overflowY = 'auto';
    });
    await editor.settle();
    const host = editor.content('p3');
    await editor.caretAtEnd('p3');
    await editor.type(' /');
    const menu = editor.portal('slash-menu');
    await expect(menu).toBeVisible();
    const before = { menu: (await menu.boundingBox())!.y, host: (await host.boundingBox())!.y };

    await editor.root.evaluate((element) => {
      element.scrollTop += 60;
    });
    await editor.settleScroll();
    await expect(menu).toBeVisible();
    const after = { menu: (await menu.boundingBox())!.y, host: (await host.boundingBox())!.y };
    expect(before.host - after.host).toBeGreaterThan(40);
    expect(Math.abs(before.menu - after.menu - (before.host - after.host))).toBeLessThan(2);
  });

  // e2e only: a frame's document and its parent's are two real documents.
  test('PO10 a press or focus in the page around an iframe mount closes its link editor; a window switch does not', async ({
    page,
    context,
  }) => {
    // Was R2-UI-11: the frame's document heard neither event, so the dialog
    // stayed open over the frame after the reader had moved on.
    const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
    const dialog = editor.portal('link-editor');
    const open = async () => {
      await editor.load({ doc: 'paragraphs', mount: 'iframe' });
      await editor.clickAt('p1', 0);
      for (let i = 0; i < 5; i += 1) {
        await page.keyboard.press('Shift+ArrowRight');
      }
      await page.keyboard.press(`${MOD}+k`);
      await expect(dialog).toBeVisible();
      await editor.type('https://c.test/');
    };

    await open();
    const other = await context.newPage();
    await other.bringToFront();
    await page.bringToFront();
    await expect(dialog).toBeVisible();
    await other.close();

    await page.locator('#after').click();
    await expect(dialog).toBeHidden();

    await open();
    await page.locator('#before').focus();
    await expect(dialog).toBeHidden();
  });
  test('PO11 focus or a press outside the editor takes both toolbars with it, in every mount', async ({
    page,
    browserName,
  }) => {
    // Was R3-PTR-6 and R3-PTR-7: in an iframe mount a press or focus in the
    // host page closed the popovers but left the format and table toolbars
    // drawn, and in Firefox and WebKit the table toolbar stayed after focus
    // moved to a page input in any mount -- no selectionchange says so.
    for (const mount of ['plain', 'iframe', 'shadow'] as const) {
      const editor = new EditorPage(
        page,
        0,
        mount === 'iframe' ? page.frameLocator('#frame') : undefined,
      );

      for (const leave of ['click', 'focus'] as const) {
        const away = async () => {
          if (leave === 'click') {
            await page.locator('#after').click();
            await page.keyboard.type('hi');
          } else {
            await page.locator('#before').focus();
          }
        };

        await editor.load({ doc: 'paragraphs', mount });
        await editor.dragText(['p1', 0], ['p1', 5], 5);
        await expect(editor.portal('toolbar'), `${mount} ${leave}`).toBeVisible();
        await away();
        await expect(editor.portal('toolbar'), `${mount} ${leave}`).toBeHidden();

        await editor.load({ doc: 'table', mount });
        await editor.cell('tbl', 1, 1).click();
        await expect(editor.portal('table-toolbar'), `${mount} ${leave}`).toBeVisible();
        await away();
        await expect(editor.portal('table-toolbar'), `${mount} ${leave}`).toBeHidden();

        // Back in the cell, it is drawn again -- though the frame keeps its
        // caret, so no selectionchange says so. Not in Firefox's frame: a
        // click there after focus left for the page focuses nothing in the
        // frame at all, and keys typed after it are lost with or without
        // the editor (measured against the round 2 build too).
        if (!(mount === 'iframe' && browserName === 'firefox')) {
          await editor.cell('tbl', 1, 1).click();
          await expect(editor.portal('table-toolbar'), `${mount} ${leave}`).toBeVisible();
        }
      }
    }
  });
  // e2e only: a frame's document and the page around it are two real
  // documents, and where a portal is drawn is layout.
  test('PO12 an iframe mount whose portals live in the page around it: the toolbars and the link editor work there', async ({
    page,
  }) => {
    // Was R4-PTR-3: the outer page's handlers took the editor's own portals
    // for "outside" -- "insert row below" hid the toolbar and did nothing, F10
    // left focus on <body>, the bold button did nothing, and Mod+K's link
    // editor closed as its field took focus. And every portal was placed by
    // the frame's coordinates in the page's viewport, off by the frame's
    // offset: the table toolbar sat clamped in the page's corner.
    const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
    const outer = (name: string) => page.locator(`.neditor-portal.neditor-${name}`);
    const toolbar = outer('table-toolbar');
    const buttons = toolbar.getByRole('button');
    const rows = async () => (await editor.blockData('tbl'))?.rows?.length;

    await editor.load({ doc: 'table', mount: 'iframe', portal: 'body' });
    await expect(editor.portal('table-toolbar'), 'the portals are not in the frame').toHaveCount(0);
    await editor.cell('tbl', 1, 1).click();
    await expect(toolbar).toBeVisible();

    const box = (await toolbar.boundingBox())!;
    const table = (await editor.block('tbl').boundingBox())!;
    expect(Math.abs(box.x - table.x), 'lined up with the table').toBeLessThan(2);
    expect(
      box.y + box.height <= table.y + 1 || box.y >= table.y + table.height - 1,
      'beside the table, not over it',
    ).toBe(true);

    await buttons.nth(1).click();
    expect(await rows()).toBe(4);
    await expect(toolbar).toBeVisible();

    await editor.cell('tbl', 1, 1).click();
    await page.keyboard.press('F10');
    await expect(buttons.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    expect(await rows()).toBe(5);

    await editor.placeCaret('before', 0, 6);
    await expect(outer('toolbar')).toBeVisible();
    await outer('toolbar').getByRole('button').first().click();
    expect((await editor.blockData('before'))?.content[0]).toEqual({
      text: 'Before',
      marks: ['bold'],
    });

    await editor.placeCaret('before', 7, 10);
    await page.keyboard.press(`${MOD}+k`);
    await expect(outer('link-editor')).toBeVisible();
    await expect(outer('link-editor').getByRole('textbox')).toBeFocused();
    await page.keyboard.type('example.com');
    await page.keyboard.press('Enter');
    await expect(outer('link-editor')).toBeHidden();
    expect((await editor.blockData('before'))?.content.find((run) => run.link)).toEqual({
      text: 'the',
      link: 'https://example.com/',
    });
  });

  /*
   * R5-PTR-1. The anchor was lifted out of the frame by the frame's offset
   * alone, so under a `transform: scale(0.7)` on the frame's ancestor the
   * table toolbar was drawn over the rows, and under `zoom: 1.5` far above
   * them. The probe's scenario. Layout: e2e only.
   */
  for (const how of ['scale(0.7)', 'zoom: 1.5'] as const) {
    test(`PO12b an iframe mount under ${how}: the outer page's table toolbar sits against the table`, async ({
      page,
      browserName,
    }) => {
      test.skip(
        how === 'zoom: 1.5' && browserName === 'webkit',
        'WebKit lays a zoomed frame out at the zoomed width and reports its rects in other units: a documented limit',
      );
      const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
      const toolbar = page.locator('.neditor-portal.neditor-table-toolbar');

      await editor.load({ doc: 'table', mount: 'iframe', portal: 'body' });
      await page.evaluate((how) => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        const filler = Array.from({ length: 9 }, (_, i) => ({
          id: `x${i}`,
          type: 'paragraph' as const,
          depth: 0,
          content: [{ text: `Filler ${i}` }],
        }));
        doc.blocks.unshift(...filler);
        ed.setDocument(doc);
        const stage = document.querySelector<HTMLElement>('#stage')!;
        if (how === 'scale(0.7)') {
          stage.style.transform = 'scale(0.7)';
          stage.style.transformOrigin = '0 0';
        } else {
          stage.style.setProperty('zoom', '1.5');
        }
      }, how);

      /** Where something inside the frame is drawn, in the page's viewport. */
      const drawn = (selector: string) =>
        page.evaluate((selector) => {
          const frame = document.querySelector<HTMLIFrameElement>('#frame')!;
          const outer = frame.getBoundingClientRect();
          const scale = outer.width / frame.offsetWidth;
          const inner = frame.contentDocument!.querySelector(selector)!.getBoundingClientRect();
          return {
            x: outer.left + (frame.clientLeft + inner.left) * scale,
            y: outer.top + (frame.clientTop + inner.top) * scale,
            bottom: outer.top + (frame.clientTop + inner.bottom) * scale,
          };
        }, selector);

      const cell = await drawn('[data-cell="1:1"]');
      await page.mouse.click(cell.x + 5, (cell.y + cell.bottom) / 2);
      expect(await editor.selection(), 'precondition: the click reached the cell').toMatchObject({
        cell: { row: 1, column: 1 },
      });
      await expect(toolbar).toBeVisible();

      const table = await drawn('.neditor-block[data-block-id="tbl"]');
      const bar = (await toolbar.boundingBox())!;
      expect(Math.abs(bar.x - table.x), 'lined up with the table').toBeLessThan(3);
      expect(
        Math.abs(table.y - (bar.y + bar.height) - 8),
        'just above the table, not over its rows or far from it',
      ).toBeLessThan(4);
    });
  }

  /*
   * R12-PTR-1. The same portals in the page around an iframe mount whose
   * frame sits in a scrolling pane of that page: drawn `position: fixed`
   * there, over the pane, they are placed by that page's window. Placed by
   * what the pane showed of the frame (`setAnchorBand`, cut by the pane),
   * the icon picker of a callout whose icon sat 150px above the pane's
   * bottom found no room below it there and flipped above, though the
   * window had room below it (460..593 for an icon at 600, the pane at
   * 450..750). The probe: 20 paragraphs, a callout and 30 more in a 2600px
   * frame in a 300px pane at the window's y 450, the icon brought to y 600
   * and clicked. Layout and frames: e2e.
   */
  test('PO12c an iframe mount in a pane of the page whose portals live in that page: the icon picker keeps its side', async ({
    page,
  }) => {
    const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
    await editor.load({ doc: 'empty', mount: 'iframe', portal: 'body' });
    await page.evaluate(() => {
      const p = (id: string, text: string) => ({
        id,
        type: 'paragraph' as const,
        depth: 0,
        content: [{ text }],
      });
      window.__e2e.editor.setDocument({
        blocks: [
          ...Array.from({ length: 20 }, (_, i) => p(`b${i}`, `Before paragraph ${i}`)),
          { id: 'co', type: 'callout', depth: 0, icon: '💡', content: [{ text: 'Callout text' }] },
          ...Array.from({ length: 30 }, (_, i) => p(`a${i}`, `After ${i}`)),
        ],
      });
      const frame = document.querySelector<HTMLIFrameElement>('#frame')!;
      frame.style.cssText = 'display:block;width:900px;height:2600px;border:0';
      const stage = document.getElementById('stage')!;
      stage.id = 'pane';
      stage.style.cssText =
        'height:300px;overflow:auto;border:2px solid #888;box-sizing:border-box;margin:0';
      stage.style.marginTop = `${450 - stage.getBoundingClientRect().top}px`;
      const icon = frame.contentDocument!.querySelector(
        '[data-block-id="co"] .neditor-block__icon',
      )!;
      stage.scrollTop += frame.getBoundingClientRect().top + icon.getBoundingClientRect().top - 600;
    });
    await editor.settle();
    const height = page.viewportSize()!.height;
    const control = editor.block('co').locator('.neditor-block__icon');
    const icon = (await control.boundingBox())!;
    const pane = (await page.locator('#pane').boundingBox())!;
    expect(icon.y + icon.height, 'precondition: the icon is in the pane').toBeLessThan(
      pane.y + pane.height,
    );

    await page.mouse.click(icon.x + icon.width / 2, icon.y + icon.height / 2);
    const picker = page.locator('.neditor-portal.neditor-icon-picker');
    await expect(picker).toBeVisible();
    await editor.settle();
    const box = (await picker.boundingBox())!;
    expect(
      pane.y + pane.height - (icon.y + icon.height),
      'precondition: the pane has no room for it below the icon',
    ).toBeLessThan(box.height);
    expect(box.y, 'below the icon, its preferred side').toBeGreaterThanOrEqual(
      icon.y + icon.height - 1,
    );
    expect(box.y + box.height, 'in the window').toBeLessThanOrEqual(height);
  });

  // e2e only: where focus goes on Tab and on a click is the browser's.
  test('PO13 leaving the table toolbar after F10 takes it with it, in every mount', async ({
    page,
  }) => {
    // Was R4-PTR-4: F10 moves focus out of the root, so the root's focusout
    // had already run, and nothing heard the reader leave the toolbar: it
    // stayed drawn, and its buttons edited the table the reader had left.
    for (const mount of ['plain', 'shadow', 'iframe'] as const) {
      const editor = new EditorPage(
        page,
        0,
        mount === 'iframe' ? page.frameLocator('#frame') : undefined,
      );
      const toolbar = editor.portal('table-toolbar');

      for (const leave of ['click', 'Tab'] as const) {
        const label = `${mount} ${leave}`;
        await editor.load({ doc: 'table', mount });
        await editor.cell('tbl', 1, 1).click();
        await expect(toolbar, label).toBeVisible();
        await page.keyboard.press('F10');
        await expect(toolbar.getByRole('button').nth(0), label).toBeFocused();

        if (leave === 'click') {
          await page.locator('#after').click();
        } else {
          await page.keyboard.press('Tab');
        }

        // Headless Firefox keeps focus on the last stop when Tab has nowhere
        // to go; then the reader has not left, and the toolbar rightly stays.
        const stayed = await toolbar.evaluate((element) => {
          const tree = element.getRootNode() as Document | ShadowRoot;
          return element.contains(tree.activeElement);
        });

        if (stayed) {
          await expect(toolbar, label).toBeVisible();
        } else {
          await expect(toolbar, label).toBeHidden();
        }
      }
    }
  });

  /*
   * R7-KEY-1. Round 6 handed focus back from a panel `setDocument` closed,
   * with the panel's range selected, and the rest of the URL the reader was
   * typing overwrote the document: "Read the documentation first" became
   * "Read the //example.com first", and `change` carried it out. A panel that
   * closes takes its keystrokes with it; focus is left outside the editor
   * (README: a deliberate loss of focus, not of text). The probe's document
   * and panels, the update landing part-way through the typing. Real
   * keystrokes after a real focus move: e2e (editor-lifecycle.test.ts has the
   * same scenarios with the browser's default action spelled out).
   */
  /*
   * R12-KEY-1, p3's and p2's literal cases, for every panel that takes focus:
   * an iframe mount whose `portalContainer` is the page around the frame, the
   * link editor (Mod+K), the image editor (a click on the picture) or the icon
   * picker (a click on the callout's icon) open with focus in it, a peer's
   * `setDocument`, then Backspace twice. The panel closed and left focus on
   * the outer page's <body>; the guard was armed and listened for only in
   * the frame's document, and WebKit's first Backspace went Back. Navigation
   * and the outer page's focus: e2e.
   */
  test('PO15 a panel in the page around an iframe mount closed by a peer leaves Backspace on the page', async ({
    page,
  }) => {
    const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
    const outer = (name: string) => page.locator(`.neditor-portal.neditor-${name}`);
    const cases = [
      ['link editor', 'paragraphs', 'link-editor'],
      ['image editor', 'image', 'image-editor'],
      ['icon picker', 'callout', 'icon-picker'],
    ] as const;

    for (const [label, doc, name] of cases) {
      await page.goto('about:blank');
      await editor.load({ doc, mount: 'iframe', portal: 'body' });
      const url = page.url();
      if (name === 'link-editor') {
        const first = (await editor.doc()).blocks[0]!.id;
        await editor.placeCaret(first, 0, 4);
        await page.keyboard.press(`${MOD}+k`);
      } else if (name === 'image-editor') {
        await editor.clickControl(editor.block('img').locator('.neditor-image__trigger'));
      } else {
        await editor.clickControl(editor.block('co').locator('.neditor-block__icon'));
      }
      await expect(outer(name), label).toBeVisible();
      await expect(outer(name).getByRole('textbox').first(), label).toBeFocused();
      await page.keyboard.type('ab');

      const before = await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const next = ed.getDocument();
        next.blocks[next.blocks.length - 1]!.content = [{ text: 'peer' }];
        ed.setDocument(next);
        return ed.getDocument();
      });
      await expect(outer(name), label).toBeHidden();

      await page.keyboard.press('Backspace');
      await page.waitForTimeout(300);
      expect(page.url(), label).toBe(url);
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(300);
      expect(page.url(), label).toBe(url);
      expect(await editor.doc(), label).toEqual(before);
    }
  });

  test('PO14 typing meant for a panel a host’s setDocument closed never reaches the document', async ({
    editor,
    page,
  }) => {
    for (const panel of ['link editor', 'image editor', 'icon picker'] as const) {
      await editor.load({ doc: 'empty' });
      await page.evaluate(() => {
        const t = (text: string) => [{ text }];
        const ed = window.__e2e.editor;
        ed.setDocument({
          blocks: [
            { id: 'p', type: 'paragraph', depth: 0, content: t('Read the documentation first') },
            { id: 'img', type: 'image', depth: 0, content: t('Cap'), src: '', alt: '' },
            { id: 'co', type: 'callout', depth: 0, content: t('Callout'), icon: '💡' },
          ],
        });
        ed.clearHistory();
      });

      let typed: [string, string];
      if (panel === 'link editor') {
        const point = await editor.pointAt(editor.content('p'), 12);
        await page.mouse.dblclick(point.x, point.y);
        await page.keyboard.press(`${MOD}+k`);
        await expect(editor.portal('link-editor').getByRole('textbox'), panel).toBeFocused();
        typed = ['https:', '//example.com'];
      } else if (panel === 'image editor') {
        await editor.clickControl(editor.block('img').locator('.neditor-image__placeholder'));
        await expect(
          editor.portal('image-editor').getByRole('textbox').first(),
          panel,
        ).toBeFocused();
        typed = ['https://exa', 'mple.com/pic.png'];
      } else {
        await editor.clickControl(editor.block('co').locator('.neditor-block__icon'));
        await expect(editor.portal('icon-picker').getByRole('textbox'), panel).toBeFocused();
        typed = ['ro', 'cket'];
      }

      const before = await editor.doc();
      await page.keyboard.type(typed[0], { delay: 20 });
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        ed.setDocument(ed.getDocument());
      });
      await editor.clearLog();
      await page.keyboard.type(typed[1], { delay: 20 });
      await editor.settle();

      expect(await editor.hasFocus(), panel).toBe(false);
      expect(await editor.doc(), panel).toEqual(before);
      expect(await editor.events('change'), panel).toEqual([]);
    }
  });
  /*
   * Round 14, review 4 (D2): what the toolbars count as on screen is the
   * window cut by every scroller that clips the editor -- inside its
   * border, where the scroller shows its content, and as it is drawn. Cut
   * by the border box instead, a word scrolled under a pane's 30px border,
   * wholly out of sight, kept its format toolbar drawn beside nothing, at
   * every scale and in every engine. The pane drawn at 1, 1.5 and 0.5; the
   * word under its top border and under its bottom one.
   */
  test('PO16 a range scrolled under a pane’s border takes the format toolbar with it', async ({
    editor,
    page,
  }) => {
    const tall = Array.from({ length: 160 }, (_, i) => `line ${i} of a tall block`).join('\n');

    for (const scale of [1, 1.5, 0.5]) {
      for (const edge of ['top', 'bottom'] as const) {
        const label = `scale ${scale}, under the ${edge} border`;
        await editor.load({ doc: 'paragraphs' });
        const middle = await page.evaluate(
          ({ tall, scale }) => {
            const ed = window.__e2e.editor;
            const blocks = ed.getDocument().blocks.slice(0, 3);
            blocks[1]!.content = [{ text: tall }];
            ed.setDocument({ blocks });
            const stage = document.querySelector<HTMLElement>('#stage')!;
            stage.style.cssText = `height:${scale < 1 ? 600 : 300}px;overflow:auto;margin:0;max-width:${scale < 1 ? 900 : 600}px;border:30px solid #36c;transform:scale(${scale});transform-origin:0 0`;
            stage.scrollTop = 600;
            const box = stage.getBoundingClientRect();
            return (box.top + box.bottom) / 2;
          },
          { tall, scale },
        );
        // A word in the middle of the pane.
        const word = await page.evaluate((y) => {
          const host = window.__e2e.editor.element.querySelector(
            '[data-block-id="p2"] .neditor-block__content',
          )!;
          const node = host.firstChild!;
          const range = document.createRange();
          for (
            let at = 0;
            at < node.textContent!.length;
            at = node.textContent!.indexOf('\n', at) + 1
          ) {
            range.setStart(node, at);
            range.setEnd(node, at + 4);
            const box = range.getBoundingClientRect();
            if (box.bottom > y)
              return { x: box.left + box.width / 2, y: (box.top + box.bottom) / 2 };
          }
          return null;
        }, middle);
        await page.mouse.dblclick(word!.x, word!.y);
        await expect(editor.portal('toolbar'), label).toBeVisible();
        // Scrolled so the word's line sits under the border, half way in.
        await page.evaluate(
          ({ edge, scale }) => {
            const stage = document.querySelector<HTMLElement>('#stage')!;
            const line = getSelection()!.getRangeAt(0).getBoundingClientRect();
            const box = stage.getBoundingClientRect();
            const border = 30 * scale;
            const target = edge === 'top' ? box.top + border / 2 : box.bottom - border / 2;
            stage.scrollTop += ((line.top + line.bottom) / 2 - target) / scale;
          },
          { edge, scale },
        );
        await expect(editor.portal('toolbar'), label).toBeHidden();
      }
    }
  });

  // PO16 one page out: an iframe mount in a bordered scrolling pane of the
  // page around it. What that pane shows of the frame was cut by its border
  // box (`#frameBand`), so a word scrolled under the pane's 30px border, out
  // of sight, kept its toolbar -- in every engine, at every scale (round 14).
  // Just inside the border, in sight, it keeps it: the border is cut as it is
  // drawn, at the pane's scale, not in its layout pixels.
  test('PO16b a range scrolled under the border of a pane around the frame takes the toolbar with it', async ({
    page,
  }) => {
    const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
    const tall = Array.from({ length: 160 }, (_, i) => `line ${i} of a tall block`).join('\n');

    for (const scale of [1, 1.5, 0.5]) {
      for (const edge of ['top', 'bottom'] as const) {
        const label = `scale ${scale}, under the ${edge} border`;
        await editor.load({ doc: 'paragraphs', mount: 'iframe' });
        const middle = await page.evaluate(
          ({ tall, scale }) => {
            const ed = window.__e2e.editor;
            const blocks = ed.getDocument().blocks.slice(0, 3);
            blocks[1]!.content = [{ text: tall }];
            ed.setDocument({ blocks });
            // The frame as tall as its page: only the outer pane scrolls.
            const frame = document.querySelector<HTMLIFrameElement>('#frame')!;
            frame.style.height = `${frame.contentDocument!.documentElement.scrollHeight + 20}px`;
            const stage = document.querySelector<HTMLElement>('#stage')!;
            stage.style.cssText = `height:${scale < 1 ? 600 : 300}px;overflow:auto;margin:0;max-width:${scale < 1 ? 900 : 600}px;border:30px solid #36c;transform:scale(${scale});transform-origin:0 0`;
            stage.scrollTop = 600;
            const box = stage.getBoundingClientRect();
            return (box.top + box.bottom) / 2;
          },
          { tall, scale },
        );
        // A word in the middle of the pane, in the page's coordinates.
        const word = await page.evaluate((y) => {
          const frame = document.querySelector<HTMLIFrameElement>('#frame')!;
          const outer = frame.getBoundingClientRect();
          const k = outer.height / frame.offsetHeight;
          const host = window.__e2e.editor.element.querySelector(
            '[data-block-id="p2"] .neditor-block__content',
          )!;
          const node = host.firstChild!;
          const range = host.ownerDocument.createRange();
          for (
            let at = 0;
            at < node.textContent!.length;
            at = node.textContent!.indexOf('\n', at) + 1
          ) {
            range.setStart(node, at);
            range.setEnd(node, at + 4);
            const box = range.getBoundingClientRect();
            if (outer.top + (frame.clientTop + box.bottom) * k > y) {
              return {
                x: outer.left + (frame.clientLeft + box.left + box.width / 2) * k,
                y: outer.top + (frame.clientTop + (box.top + box.bottom) / 2) * k,
              };
            }
          }
          return null;
        }, middle);
        await page.mouse.dblclick(word!.x, word!.y);
        await expect(editor.portal('toolbar'), label).toBeVisible();
        // Scrolled so the word's line sits just inside the border (6 drawn
        // pixels in), then under it, half way in.
        for (const where of ['inside', 'under'] as const) {
          await page.evaluate(
            ({ edge, scale, where }) => {
              const frame = document.querySelector<HTMLIFrameElement>('#frame')!;
              const outer = frame.getBoundingClientRect();
              const k = outer.height / frame.offsetHeight;
              const line = frame
                .contentWindow!.getSelection()!
                .getRangeAt(0)
                .getBoundingClientRect();
              const middle = outer.top + (frame.clientTop + (line.top + line.bottom) / 2) * k;
              const half = ((line.bottom - line.top) * k) / 2;
              const stage = document.querySelector<HTMLElement>('#stage')!;
              const box = stage.getBoundingClientRect();
              const border = 30 * scale;
              const into = where === 'under' ? border / 2 : border + 6 + half;
              const target = edge === 'top' ? box.top + into : box.bottom - into;
              stage.scrollTop += (middle - target) / scale;
            },
            { edge, scale, where },
          );
          if (where === 'inside') {
            // Settled first: a toolbar on its way out would still be visible.
            await editor.settle();
            await expect(editor.portal('toolbar'), `${label}: just inside`).toBeVisible();
          } else {
            await expect(editor.portal('toolbar'), label).toBeHidden();
          }
        }
      }
    }
  });
});
