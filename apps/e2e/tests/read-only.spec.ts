import { EditorPage, expect, MOD, test } from '../helpers/test.ts';
import { writeClipboard } from '../helpers/clipboard.ts';

test.describe('17 · read-only', () => {
  test('RO1 nothing is editable, and typing, deleting and pasting change nothing', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'kitchen-sink', editable: false });
    await expect(editor.root.locator('[contenteditable="true"]')).toHaveCount(0);
    const before = await editor.doc();

    await writeClipboard(page, { text: 'pasted' });
    await editor.clickAt('para', 2); // plain text, not the link
    await page.keyboard.type('typed');
    // Delete rather than Backspace: Playwright's WebKit still maps Backspace
    // outside an editable field to history.back(), which Safari no longer does.
    await page.keyboard.press('Delete');
    await page.keyboard.press('Enter');
    await page.keyboard.press(`${MOD}+v`);
    expect(page.url()).toContain('doc=kitchen-sink');

    expect(await editor.doc()).toEqual(before);
    expect(await editor.events('change')).toEqual([]);
    await expect(editor.content('para')).not.toContainText('typed');
  });

  test('RO2 controls do not write: checkbox, icon and image are inert; the chevron only changes the view', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'kitchen-sink', editable: false });
    const before = await editor.doc();

    await editor.block('td').locator('.neditor-block__checkbox').click();
    // Disabled rather than a tab stop that answers with silence.
    await expect(editor.block('co').locator('.neditor-block__icon')).toBeDisabled();
    await expect(editor.portal('icon-picker')).toBeHidden();
    await expect(editor.block('img').locator('.neditor-image__trigger')).toBeDisabled();

    await editor.block('tg').locator('.neditor-block__chevron').click();
    await expect(editor.block('tgc')).toHaveCount(0);
    await expect(editor.block('tg').locator('.neditor-block__chevron')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await editor.block('tg').locator('.neditor-block__chevron').click();
    await expect(editor.block('tgc')).toBeVisible();

    expect(await editor.doc()).toEqual(before);
    expect(await editor.events('change')).toEqual([]);
    expect(await editor.canUndo()).toBe(false);
    await page.keyboard.press(`${MOD}+z`);
  });

  test('RO3 no toolbar, gutter or menu ever appears', async ({ editor, page }) => {
    await editor.load({ doc: 'kitchen-sink', editable: false });
    await editor.dragText(['para', 0], ['para', 5]);
    await editor.hoverBlock('h2');
    await editor.content('h3').click();
    await page.keyboard.type('/');
    await page.keyboard.press(`${MOD}+k`);
    await editor.cell('tbl', 1, 0).click();
    await expect(page.locator('.neditor-portal:not([hidden])')).toHaveCount(0);
    await expect(editor.gutter).not.toHaveAttribute('data-visible', 'true');
  });

  test('RO4 a plain click on a link opens it in a new tab', async ({ editor, context }) => {
    await context.route(/^https:\/\/example\.com\//, (route) =>
      route.fulfill({ contentType: 'text/html', body: 'stub' }),
    );
    await editor.load({ doc: 'links', editable: false });
    const opened = context.waitForEvent('page');
    await editor.content('p1').locator('a').click();
    const tab = await opened;
    expect(tab.url()).toBe('https://example.com/docs');
    expect(await tab.evaluate(() => window.opener)).toBeNull();
    await tab.close();
  });

  test('RO6 setEditable(false) at runtime closes what was open; true restores editing', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'toggle-open' });
    await editor.placeCaret('before', 0, 6);
    await page.keyboard.press(`${MOD}+k`);
    await expect(editor.portal('link-editor')).toBeVisible();
    await page.evaluate(() => window.__e2e.editor.setEditable(false));
    await expect(page.locator('.neditor-portal:not([hidden])')).toHaveCount(0);
    await expect(editor.root.locator('[contenteditable="true"]')).toHaveCount(0);

    // A reader collapses the toggle; returning to editing discards that view state.
    await editor.block('tg').locator('.neditor-block__chevron').click();
    await expect(editor.block('child1')).toHaveCount(0);
    await page.evaluate(() => window.__e2e.editor.setEditable(true));
    await expect(editor.block('child1')).toBeVisible();

    await editor.caretAtEnd('after');
    await editor.type('!');
    expect((await editor.texts()).at(-1)).toBe('After!');
  });

  /*
   * R12-KEY-2, p13's literal cases (WebKit), in each mount: the reader typing
   * at the end of a block, holding a block selection (Escape), in the link
   * editor, or in the F10 table toolbar, and the host switching the editor
   * read-only. Focus fell to <body> -- or the root kept it with nothing
   * selected -- and the next Backspace went back in history. The switch now
   * does what `setDocument` does when focus leaves the editor: a panel's
   * control is blurred, a block selection ends with the root letting go, and
   * a Backspace on the page is guarded. Navigation: e2e.
   */
  test('RO6b setEditable(false) under the reader leaves no Backspace that leaves the page', async ({
    editor,
    page,
  }) => {
    for (const mount of ['plain', 'shadow', 'iframe'] as const) {
      const mounted =
        mount === 'iframe' ? new EditorPage(page, 0, page.frameLocator('#frame')) : editor;
      for (const state of ['caret', 'block selection', 'link editor', 'F10 toolbar'] as const) {
        const label = `${mount}: ${state}`;
        await page.goto('about:blank');
        await mounted.load({ doc: state === 'F10 toolbar' ? 'table' : 'paragraphs', mount });
        const url = page.url();
        if (state === 'F10 toolbar') {
          const box = (await mounted.cell('tbl', 1, 0).boundingBox())!;
          await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
          await page.keyboard.press('F10');
        } else {
          const first = (await mounted.doc()).blocks[0]!.id;
          await mounted.content(first).click();
          await page.keyboard.press('End');
          if (state === 'block selection') {
            await page.keyboard.press('Escape');
            expect(await mounted.selected(), label).toEqual([first]);
          }
          if (state === 'link editor') {
            for (let i = 0; i < 3; i += 1) await page.keyboard.press('Shift+ArrowLeft');
            await page.keyboard.press(`${MOD}+k`);
            await expect(mounted.portal('link-editor'), label).toBeVisible();
          }
        }
        const before = await mounted.doc();

        await page.evaluate(() => window.__e2e.editor.setEditable(false));
        expect(await mounted.selected(), label).toEqual([]);
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);
        expect(page.url(), label).toBe(url);
        expect(await mounted.doc(), label).toEqual(before);
      }
    }
  });

  /*
   * R12-RV-KEY-4b, e1's literal case: the caret at the end of "Bravo two", a
   * host locking the editor round a save -- `setEditable(false)` then `true`,
   * in the same task or 100 ms later. Round 12's lock took focus off the
   * block (RO6b) and the unlock gave nothing back: "X" reached nothing, where
   * Firefox and WebKit had typed it. While the reader has not placed
   * themselves, the unlock puts the caret back by id. A block selection is
   * not brought back. Real focus: e2e.
   */
  test('RO6c a lock and an unlock under the reader give the caret back to its block', async ({
    editor,
    page,
  }) => {
    for (const mount of ['plain', 'shadow', 'iframe'] as const) {
      const mounted =
        mount === 'iframe' ? new EditorPage(page, 0, page.frameLocator('#frame')) : editor;
      for (const gap of [0, 100]) {
        const label = `${mount}, ${gap} ms`;
        await mounted.load({ doc: 'paragraphs', mount });
        const id = (await mounted.doc()).blocks[1]!.id;
        await mounted.content(id).click();
        await page.keyboard.press('End');
        const before = (await mounted.texts())[1];

        await page.evaluate(async (gap) => {
          const ed = window.__e2e.editor;
          ed.setEditable(false);
          if (gap) await new Promise((resolve) => setTimeout(resolve, gap));
          ed.setEditable(true);
        }, gap);
        await page.keyboard.type('X');
        expect((await mounted.texts())[1], label).toBe(`${before}X`);
      }
    }
  });

  /*
   * R13-KEY-1, k12's literal case (WebKit): a page button "Save" whose click
   * locks the editor; the caret at the end of p2 (or "o" selected before it),
   * the click, Backspace. WebKit takes no focus for the button -- focus stays
   * on `<body>` -- and keeps typing into the block, so the reader's Backspace
   * was the editor's until the lock; locked, it went back in history. The
   * lock guards it as it guards a focused block's. Unlocked again before the
   * press, the key is the editor's once more, as before the lock: WebKit
   * deletes the character; with its block deleted by a peer meanwhile, it
   * reaches nothing. In a dialog mount (the button in the dialog) WebKit
   * focuses the `<dialog>` instead, where Backspace goes back too. Other
   * engines focus the button, where Backspace does nothing. Navigation and
   * WebKit's kept selection: e2e.
   */
  test('RO6g a lock under a range WebKit kept for a page button leaves no Backspace that leaves the page', async ({
    editor,
    page,
    browserName,
  }) => {
    for (const mount of ['plain', 'shadow', 'dialog'] as const) {
      for (const select of [false, true]) {
        for (const unlock of [false, true, 'after a peer deleted p2'] as const) {
          const label = `${mount}, ${select ? 'range' : 'caret'}, ${unlock ? `unlocked ${unlock}` : 'locked'}`;
          await page.goto('about:blank');
          await editor.load({ doc: 'paragraphs', mount });
          const url = page.url();
          await page.evaluate(() => {
            const button = document.createElement('button');
            button.id = 'save';
            button.textContent = 'Save';
            button.onclick = () => window.__e2e.editor.setEditable(false);
            // In a modal dialog, everything outside it is inert.
            (document.querySelector('#dialog') ?? document.body).prepend(button);
          });
          await editor.content('p2').click();
          await page.keyboard.press('End');
          if (select) await page.keyboard.press('Shift+ArrowLeft');
          await page.locator('#save').click();
          if (unlock) {
            await page.evaluate((peer) => {
              const ed = window.__e2e.editor;
              if (peer) {
                const doc = ed.getDocument();
                doc.blocks.splice(1, 1);
                ed.setDocument(doc);
              }
              ed.setEditable(true);
            }, unlock !== true);
          }
          const texts = await editor.texts();

          await page.keyboard.press('Backspace');
          await page.waitForTimeout(300);
          expect(page.url(), label).toBe(url);
          // Unlocked over the same range, WebKit's Backspace deletes in it as
          // before the lock; with its block gone, it reaches nothing.
          expect(await editor.texts(), label).toEqual(
            unlock === true && browserName === 'webkit'
              ? ['Alpha one', 'Bravo tw', 'Charlie three']
              : texts,
          );
        }
      }
    }
  });

  /*
   * R14-KEY-1, k16's literal case (WebKit): "wo" selected at the end of p2,
   * the page button locks the editor, and Shift+← -- which Safari applies to
   * the read-only selection from `<body>`, making it "two" -- before the
   * unlock. WebKit types into the moved range as into the kept one, so the
   * unlock hands Backspace back wherever the range is in one of the editor's
   * hosts: guarded only at the exact offsets the lock found, three
   * Backspaces deleted nothing while "Q" replaced "two". Shift+→ (to "o")
   * the same. Other engines focus the button, where the keys reach nothing.
   */
  test('RO6g3 an unlock over a range WebKit kept and the reader moved during the lock hands Backspace back', async ({
    editor,
    page,
    browserName,
  }) => {
    for (const mount of ['plain', 'shadow'] as const) {
      for (const [key, expected] of [
        ['Shift+ArrowLeft', 'Bravo '],
        ['Shift+ArrowRight', 'Bravo tw'],
      ] as const) {
        const label = `${mount}, ${key}`;
        await page.goto('about:blank');
        await editor.load({ doc: 'paragraphs', mount });
        const url = page.url();
        await page.evaluate(() => {
          const button = document.createElement('button');
          button.id = 'save';
          button.textContent = 'Save';
          button.onclick = () => window.__e2e.editor.setEditable(false);
          document.body.prepend(button);
        });
        await editor.content('p2').click();
        await page.keyboard.press('End');
        await page.keyboard.press('Shift+ArrowLeft');
        await page.keyboard.press('Shift+ArrowLeft');
        await page.locator('#save').click();
        await page.keyboard.press(key);
        await page.evaluate(() => window.__e2e.editor.setEditable(true));
        const texts = await editor.texts();

        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);
        expect(page.url(), label).toBe(url);
        expect(await editor.texts(), label).toEqual(
          browserName === 'webkit' ? ['Alpha one', expected, 'Charlie three'] : texts,
        );
      }
    }
  });

  /*
   * R14-RV1-7, the reviewer's s1 case: a mouse drag from p1 into p3 (a block
   * selection), a host's `setEditable(false)` landing with the button still
   * down -- alone, or with the unlock straight after it -- and the drag on
   * to p6. The lock ends the selection and the drag; the reader is still
   * moving the mouse. WebKit goes on drawing its own drag selection from
   * the block under the pointer: read at the release as a gesture of the
   * reader's, the range it drew across the read-only blocks became a block
   * selection again, "p3,p4,p5,p6", and after the unlock the caret it put
   * in p3 stayed with focus, "p3[18,18]". Chromium and Firefox held and
   * released nothing. A drag a lock ended stays ended until the next
   * press, in every engine.
   */
  test('RO6j a lock in the middle of a drag ends it until the next press', async ({
    editor,
    page,
  }) => {
    // And a drag that had not left its own block yet: the browser's own
    // goes on across the read-only blocks, in every engine, and its range
    // was promoted at the release -- "p1,p2,p3,p4" from a drag the lock had
    // ended inside p1. A gesture a lock ended selects nothing: no blocks,
    // and no range of the browser's across blocks either (R14-RV2), which
    // the next `selectionchange` -- a Shift+arrow's -- promoted all the
    // same, 81 characters over p1 to p5.
    for (const mount of ['plain', 'shadow', 'iframe'] as const) {
      const mounted =
        mount === 'iframe' ? new EditorPage(page, 0, page.frameLocator('#frame')) : editor;
      const label = `${mount}: a lock, the drag still in its block`;
      await editor.load({ doc: 'long', mount });
      const inside = await mounted.pointAt(mounted.content('p1'), 2);
      const further = await mounted.pointAt(mounted.content('p1'), 8);
      const beyond = await mounted.pointAt(mounted.content('p4'), 8);
      await page.mouse.move(inside.x, inside.y);
      await page.mouse.down();
      await page.mouse.move(further.x, further.y, { steps: 4 });
      await page.evaluate(() => window.__e2e.editor.setEditable(false));
      await page.mouse.move(beyond.x, beyond.y, { steps: 8 });
      await page.mouse.up();
      await editor.settle();
      expect(await editor.selected(), label).toEqual([]);
      if (mount === 'plain') {
        expect(
          await page.evaluate(() => getSelection()!.toString().length),
          `${label}: the range left`,
        ).toBe(0);
      }
      await page.keyboard.press('Shift+ArrowDown');
      await editor.settle();
      expect(await editor.selected(), `${label}: Shift+↓`).toEqual([]);
    }

    // The same, with the host putting focus in a control of its own as it
    // locks (`setEditable(false); button.focus()` in one call, as a "Done"
    // button's handler does). A focus move is no new gesture: reset by the
    // focus, the lock's flag was gone at the release, which promoted the
    // browser's range across the read-only blocks -- p2..p6 in WebKit,
    // p1..p6 in Firefox, every time (R14-RV5-1).
    for (const control of ['button', 'focusable div'] as const) {
      const label = `a lock that focuses a ${control} of the page`;
      await editor.load({ doc: 'long' });
      await page.evaluate((control) => {
        const element = document.createElement(control === 'button' ? 'button' : 'div');
        element.id = 'done';
        element.textContent = 'Done';
        if (control !== 'button') element.tabIndex = -1;
        document.querySelector('#stage')!.before(element);
      }, control);
      const inside = await editor.pointAt(editor.content('p1'), 2);
      const further = await editor.pointAt(editor.content('p1'), 8);
      const beyond = await editor.pointAt(editor.content('p6'), 8);
      await page.mouse.move(inside.x, inside.y);
      await page.mouse.down();
      await page.mouse.move(further.x, further.y, { steps: 4 });
      await page.evaluate(() => {
        window.__e2e.editor.setEditable(false);
        document.getElementById('done')!.focus();
      });
      expect(await page.evaluate(() => document.activeElement?.id), `${label}: focused`).toBe(
        'done',
      );
      await page.mouse.move(beyond.x, beyond.y, { steps: 8 });
      await page.mouse.up();
      await editor.settle();
      expect(await editor.selected(), label).toEqual([]);
      await page.keyboard.press('Shift+ArrowDown');
      await editor.settle();
      expect(await editor.selected(), `${label}: Shift+↓`).toEqual([]);
    }

    // A lock, and the drag released in its own block: a range inside one
    // block is the browser's own, and stays -- for the reader to copy.
    await editor.load({ doc: 'long' });
    {
      const start = await editor.pointAt(editor.content('p1'), 2);
      const on = await editor.pointAt(editor.content('p1'), 6);
      const stop = await editor.pointAt(editor.content('p1'), 12);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(on.x, on.y, { steps: 4 });
      await page.evaluate(() => window.__e2e.editor.setEditable(false));
      await page.mouse.move(stop.x, stop.y, { steps: 4 });
      await page.mouse.up();
      await editor.settle();
      expect(await editor.selected(), 'a lock, released in its block').toEqual([]);
      expect(
        await page.evaluate(() => getSelection()!.toString().length),
        'a lock, released in its block: the range',
      ).toBeGreaterThan(0);
    }

    // With the unlock straight after the lock, the browser's own drag goes
    // on in p1, which can be typed in again, as it does in every engine:
    // only what a drag across blocks leaves behind is taken out.
    await editor.load({ doc: 'long' });
    const inside = await editor.pointAt(editor.content('p1'), 2);
    const further = await editor.pointAt(editor.content('p1'), 8);
    const beyond = await editor.pointAt(editor.content('p4'), 8);
    await page.mouse.move(inside.x, inside.y);
    await page.mouse.down();
    await page.mouse.move(further.x, further.y, { steps: 4 });
    await page.evaluate(() => {
      window.__e2e.editor.setEditable(false);
      window.__e2e.editor.setEditable(true);
    });
    await page.mouse.move(beyond.x, beyond.y, { steps: 8 });
    await page.mouse.up();
    await editor.settle();
    expect(await editor.selected(), 'a lock and the unlock, still in its block').toEqual([]);
    expect(await editor.selection(), 'a lock and the unlock, still in its block').toMatchObject({
      blockId: 'p1',
      range: { start: 2, end: 18 },
    });

    // The lock ends a drag of the editor's. A press in the page's own text
    // above it, dragged down into the blocks, is the page's: a lock in the
    // middle of it lets go of nothing that the page's reader selected.
    const withPageText = async (mount?: 'shadow') => {
      await editor.load({ doc: 'long', mount });
      await page.evaluate(() => {
        const text = document.createElement('p');
        text.id = 'outside';
        text.textContent = 'Some text of the page, above the editor.';
        // In the page's own tree, whatever tree the editor is in.
        document.querySelector('#stage')!.before(text);
      });
      const box = (await page.locator('#outside').boundingBox())!;
      return { x: box.x + 20, y: box.y + box.height / 2 };
    };
    let outside = await withPageText();
    const into = await editor.pointAt(editor.content('p2'), 8);
    await page.mouse.move(outside.x, outside.y);
    await page.mouse.down();
    await page.mouse.move(outside.x + 40, outside.y, { steps: 3 });
    await page.evaluate(() => window.__e2e.editor.setEditable(false));
    await page.mouse.move(into.x, into.y, { steps: 8 });
    await page.mouse.up();
    await editor.settle();
    expect(await editor.selected(), 'a press in the page’s text').toEqual([]);
    expect(
      await page.evaluate(() => getSelection()!.toString().length),
      'a press in the page’s text: its range',
    ).toBeGreaterThan(30);

    // The other way round -- a drag of the editor's, in p1, the lock, and
    // the pointer carried up out of the editor into that text -- is the
    // gesture the lock ended: the range the browser ran from p1 out over
    // the blocks above it is let go of like one between two blocks. Out
    // of a shadow root too: the selection's own ends are retargeted to the
    // shadow host there, name no block, and Firefox and WebKit kept the
    // range, 9 and 22 characters (R14-RV3-3); its composed range is read.
    for (const mount of [undefined, 'shadow'] as const) {
      const label = `out of the editor${mount ? ', in a shadow root' : ''}`;
      outside = await withPageText(mount);
      const pressed = await editor.pointAt(editor.content('p1'), 8);
      await page.mouse.move(pressed.x, pressed.y);
      await page.mouse.down();
      await page.mouse.move(pressed.x - 20, pressed.y, { steps: 4 });
      await page.evaluate(() => window.__e2e.editor.setEditable(false));
      await page.mouse.move(outside.x + 40, outside.y, { steps: 8 });
      // (What the page's selection reports of a range out of a shadow root
      // differs by engine; the release is what is asked.)
      expect(
        await page.evaluate(() => getSelection()!.toString().length),
        `${label}: held`,
      ).toBeGreaterThan(mount ? 0 : 20);
      await page.mouse.up();
      await editor.settle();
      expect(await editor.selected(), label).toEqual([]);
      expect(
        await page.evaluate(() => getSelection()!.toString().length),
        `${label}: the range left`,
      ).toBe(0);
    }

    // And a press whose text drag something else had ended already --
    // Escape, a peer's reorder of two blocks far away -- when the lock
    // lands: the button is still down, the browser goes on across the
    // read-only blocks, and the lock found no drag to end, so the release
    // read that range: "p1,p2,p3,p4" (round 14, review 2's x1). A lock
    // during a press that began as a text press in this editor ends the
    // gesture, whether its drag was still live or not.
    // The gesture stays ended until the next press, and no longer: in the
    // read-only view the lock left, a click in p2 and a Shift+click in p5
    // select the four blocks, as in any read-only view.
    await editor.load({ doc: 'long' });
    const ended = await editor.pointAt(editor.content('p1'), 2);
    await page.mouse.move(ended.x, ended.y);
    await page.mouse.down();
    await page.mouse.move(ended.x + 40, ended.y, { steps: 4 });
    await page.evaluate(() => window.__e2e.editor.setEditable(false));
    await page.mouse.up();
    await editor.settle();
    const second = await editor.pointAt(editor.content('p2'), 3);
    const fifth = await editor.pointAt(editor.content('p5'), 3);
    await page.mouse.click(second.x, second.y);
    await page.keyboard.down('Shift');
    await page.mouse.click(fifth.x, fifth.y);
    await page.keyboard.up('Shift');
    await editor.settle();
    expect(await editor.selected(), 'the next press').toEqual(['p2', 'p3', 'p4', 'p5']);

    for (const first of ['Escape', 'a reorder'] as const) {
      const label = `${first}, then a lock`;
      await editor.load({ doc: 'long' });
      const start = (await editor.content('p1').boundingBox())!;
      const end = (await editor.content('p4').boundingBox())!;
      await page.mouse.move(start.x + 20, start.y + start.height / 2);
      await page.mouse.down();
      await page.mouse.move(start.x + 60, start.y + start.height / 2, { steps: 4 });
      if (first === 'Escape') {
        await page.keyboard.press('Escape');
      } else {
        await page.evaluate(() => {
          const ed = window.__e2e.editor;
          const blocks = ed.getDocument().blocks;
          blocks.splice(22, 0, ...blocks.splice(20, 1));
          ed.setDocument({ blocks });
        });
      }
      await page.evaluate(() => window.__e2e.editor.setEditable(false));
      await page.mouse.move(end.x + 60, end.y + end.height / 2, { steps: 8 });
      expect(
        await page.evaluate(() => getSelection()!.toString().length),
        `${label}: held`,
      ).toBeGreaterThan(30);
      await page.mouse.up();
      await editor.settle();
      expect(await editor.selected(), label).toEqual([]);
      expect(
        await page.evaluate(() => getSelection()!.toString().length),
        `${label}: the range left`,
      ).toBe(0);
      await page.keyboard.press('Shift+ArrowDown');
      await editor.settle();
      expect(await editor.selected(), `${label}: Shift+↓`).toEqual([]);
    }

    for (const then of ['a lock', 'a lock and the unlock'] as const) {
      await editor.load({ doc: 'long' });
      const from = await editor.pointAt(editor.content('p1'), 5);
      const via = await editor.pointAt(editor.content('p3'), 8);
      const to = await editor.pointAt(editor.content('p6'), 8);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 2, from.y);
      await page.mouse.move(via.x, via.y, { steps: 8 });
      expect(await editor.selected(), then).toEqual(['p1', 'p2', 'p3']);
      await page.evaluate((then) => {
        window.__e2e.editor.setEditable(false);
        if (then !== 'a lock') window.__e2e.editor.setEditable(true);
      }, then);
      expect(await editor.selected(), then).toEqual([]);
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await page.mouse.up();
      await editor.settle();
      expect(await editor.selected(), then).toEqual([]);
      expect(await editor.selection(), then).toBeNull();
      // Focus is on the page, where the lock left it, and guarded: WebKit's
      // caret is taken out of the block it took focus in by letting go of
      // that focus (`#letGo`), not by focusing the editor's root, which
      // with nothing selected takes keys in neither mode -- and WebKit's
      // Backspace on it goes back in history.
      expect(
        await page.evaluate(() => document.activeElement === document.body),
        `${then}: focus`,
      ).toBe(true);
      const url = page.url();
      await page.keyboard.press('Backspace');
      await editor.settle();
      expect(page.url(), `${then}: Backspace`).toBe(url);

      // And the next press is a press like any other.
      await page.evaluate(() => window.__e2e.editor.setEditable(true));
      await editor.clickAt('p4', 3);
      expect(await editor.selection(), then).toMatchObject({
        blockId: 'p4',
        range: { start: 3, end: 3 },
      });
    }
  });

  /*
   * RO6j on a page that stops `pointerdown` from reaching the document (a
   * container with drag handling of its own). Two halves of one rule: the
   * press is heard in the document's capture phase, which no page can stop.
   * (R14-RV4-2) `#lockEnded` was reset in the bubble phase, which such a
   * page never reaches, so the next gesture's release still counted as one
   * a lock had ended, and a double-click in p2 and Shift+click in p4
   * selected nothing. (Round 14, review 4) The press itself was marked
   * there too (`#pointerDown`): a press that never got there was no press
   * of the editor's, and the lock's release promoted the browser's range
   * across the read-only blocks -- p1, p2 and p3 selected after a lock, in
   * every engine. In every mount: a shadow root, open (the press's path
   * shows the root), closed (the document sees only the root's outermost
   * host), an open root inside a closed one (two boundaries between the
   * two), and an iframe, whose own page stops the press. Points are read
   * through the editor's own element, since no locator sees into a closed
   * root, and lifted out of the frame.
   */
  test('RO6j2 a lock in the middle of a drag, on a page that stops the press', async ({
    editor,
    page,
  }) => {
    const at = (id: string, offset: number) =>
      page.evaluate(
        ([id, offset]) => {
          const root = window.__e2e.editor.element;
          const host = root.querySelector(`[data-block-id="${id}"] .neditor-block__content`)!;
          const range = root.ownerDocument.createRange();
          range.setStart(host.firstChild!, offset as number);
          range.setEnd(host.firstChild!, (offset as number) + 1);
          const box = range.getBoundingClientRect();
          const frame = root.ownerDocument.defaultView!.frameElement;
          const outer = frame?.getBoundingClientRect();
          const dx = frame && outer ? outer.left + frame.clientLeft : 0;
          const dy = frame && outer ? outer.top + frame.clientTop : 0;
          return { x: box.left + 1 + dx, y: (box.top + box.bottom) / 2 + dy };
        },
        [id, offset] as const,
      );

    for (const mount of ['plain', 'shadow', 'closed', 'nested', 'iframe'] as const) {
      const label = `${mount}: a lock, propagation stopped`;
      await editor.load({ doc: 'long', mount });
      // Above the editor in its own document: the page's stage, or the
      // frame's body.
      await page.evaluate(() => {
        const doc = window.__e2e.editor.element.ownerDocument;
        (doc.querySelector('#stage') ?? doc.body).addEventListener('pointerdown', (event) => {
          event.stopPropagation();
        });
      });
      const held = await at('p1', 2);
      const across = await at('p3', 8);
      await page.mouse.move(held.x, held.y);
      await page.mouse.down();
      await page.mouse.move(held.x + 20, held.y, { steps: 3 });
      await page.mouse.move(across.x, across.y, { steps: 6 });
      await page.evaluate(() => window.__e2e.editor.setEditable(false));
      await page.mouse.move(across.x + 20, across.y + 30, { steps: 3 });
      await page.mouse.up();
      await editor.settle();
      expect(await page.evaluate(() => window.__e2e.editor.getSelectedBlocks()), label).toEqual([]);

      // The gesture stays ended until the next press, and no longer.
      const word = await at('p2', 3);
      const fourth = await at('p4', 8);
      await page.mouse.dblclick(word.x, word.y);
      await page.keyboard.down('Shift');
      await page.mouse.click(fourth.x, fourth.y);
      await page.keyboard.up('Shift');
      await editor.settle();
      expect(
        await page.evaluate(() => window.__e2e.editor.getSelectedBlocks()),
        `${label}: the next press`,
      ).toEqual(['p2', 'p3', 'p4']);
    }
  });

  /*
   * R14-RV2-1, the reviewer's ro1 / ro2 / ro4 cases: a read-only view, and
   * a press across blocks with an update landing in the middle of it -- a
   * peer's `setDocument` typing in p15, one reordering two blocks far away,
   * a host's `setEditable(false)` that switches nothing. A read-only view's
   * blocks are no editing hosts, so the browser's own selection runs across
   * them and is read at the release. The first version of R14-RV1-7 gated
   * that read on a flag every ended drag sets, so any update in the middle
   * of the press left the release reading nothing: the blocks the reader
   * had dragged over were not selected, 10 to 23 drags in 60 with a peer
   * typing every 200 ms, and a Shift+click with an update between its
   * press and release selected none. Only a real lock ends the gesture.
   * And the drag is watched again over an update that keeps the blocks'
   * order, as in an editable view (R14-RV1-1), so it selects blocks as it
   * goes. Plain, shadow and iframe mounts.
   */
  test('RO6k a read-only view’s press across blocks selects them whatever lands in the middle of it', async ({
    editor: plain,
    page,
  }) => {
    for (const mount of ['plain', 'shadow', 'iframe'] as const) {
      const editor =
        mount === 'iframe' ? new EditorPage(page, 0, page.frameLocator('#frame')) : plain;

      for (const update of ['a far edit', 'a far reorder', 'a lock that switches nothing']) {
        const label = `${mount}, ${update}`;
        await plain.load({ doc: 'long', editable: false, mount });
        const from = await editor.pointAt(editor.content('p1'), 2);
        const still = await editor.pointAt(editor.content('p1'), 8);
        const to = await editor.pointAt(editor.content('p6'), 8);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(still.x, still.y, { steps: 4 });
        await page.evaluate((update) => {
          const ed = window.__e2e.editor;
          const blocks = ed.getDocument().blocks;
          if (update === 'a far edit') blocks[15]!.content = [{ text: 'peer' }];
          else if (update === 'a far reorder') blocks.splice(22, 0, ...blocks.splice(20, 1));
          if (update === 'a lock that switches nothing') ed.setEditable(false);
          else ed.setDocument({ blocks });
        }, update);
        await page.mouse.move(to.x, to.y, { steps: 8 });
        await plain.settle();
        // Live, where the drag is still watched: not over a reorder, which
        // ends the watching and leaves the release to read the range.
        if (update !== 'a far reorder') {
          expect(await editor.selected(), `${label}: held`).toEqual([
            'p1',
            'p2',
            'p3',
            'p4',
            'p5',
            'p6',
          ]);
        }
        await page.mouse.up();
        await plain.settle();
        expect(await editor.selected(), `${label}: released`).toEqual([
          'p1',
          'p2',
          'p3',
          'p4',
          'p5',
          'p6',
        ]);
      }

      // A click in p1, and Shift+click in p4 with a peer's update between
      // the press and the release.
      await plain.load({ doc: 'long', editable: false, mount });
      const first = await editor.pointAt(editor.content('p1'), 3);
      const fourth = await editor.pointAt(editor.content('p4'), 8);
      await page.mouse.click(first.x, first.y);
      await page.keyboard.down('Shift');
      await page.mouse.move(fourth.x, fourth.y);
      await page.mouse.down();
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const blocks = ed.getDocument().blocks;
        blocks[15]!.content = [{ text: 'peer' }];
        ed.setDocument({ blocks });
      });
      await page.mouse.up();
      await page.keyboard.up('Shift');
      await plain.settle();
      expect(await editor.selected(), `${mount}, Shift+click`).toEqual(['p1', 'p2', 'p3', 'p4']);
    }
  });

  /*
   * R14-RV3-6, a deterministic form of the reviewer's ro1 race: a read-only
   * view, a drag from p1 into p3 (blocks selected as it goes), one peer's
   * reorder of two blocks far away, and the drag on to p6. The reorder ends
   * the drag at the blocks it held, as it does in an editable view; the
   * button is still down, and WebKit's own drag goes on from there: at the
   * release a native range, 1,073 characters from the editor's root to p6,
   * stood beside the three selected blocks -- both selection modes at once,
   * 45 to 52 drags in 60 with a peer reordering every 170 ms, and still
   * there 1.2 s later. Chromium and Firefox left none. At a release that
   * finds blocks selected, no range is left in the editor. The reorder
   * before the drag crossed a block, the control, still leaves the release
   * to select what the browser's range covers.
   */
  test('RO6m a read-only drag a reorder ended leaves no range beside its blocks', async ({
    editor,
    page,
  }) => {
    for (const when of ['after', 'before'] as const) {
      await editor.load({ doc: 'long', editable: false });
      const from = await editor.pointAt(editor.content('p1'), 3);
      const via = await editor.pointAt(editor.content('p3'), 8);
      const to = await editor.pointAt(editor.content('p6'), 8);
      const reorder = () =>
        page.evaluate(() => {
          const ed = window.__e2e.editor;
          const blocks = ed.getDocument().blocks;
          blocks.splice(22, 0, ...blocks.splice(20, 1));
          ed.setDocument({ blocks });
        });
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 20, from.y, { steps: 3 });
      if (when === 'before') await reorder();
      await page.mouse.move(via.x, via.y, { steps: 6 });
      if (when === 'after') {
        expect(await editor.selected(), when).toEqual(['p1', 'p2', 'p3']);
        await reorder();
      }
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await page.mouse.up();
      await editor.settle();
      expect(await editor.selected(), `${when}: released`).toEqual(
        when === 'after' ? ['p1', 'p2', 'p3'] : ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
      );
      expect(
        await page.evaluate(() => getSelection()!.toString().length),
        `${when}: the range left`,
      ).toBe(0);
    }
  });

  /*
   * Round 14, review 3: a read-only view, p1 to p3 selected by a drag, and a
   * Shift+click in p6. The block selection let go of the DOM selection and
   * focused the root, and WebKit keeps a caret of its own there, in the root
   * and in no block; its Shift+click extended from that caret, and the
   * release left a native range of 1,073 characters from the root to p6,
   * which the next Shift+↓ grew on past the editor. Chromium and Firefox
   * left no range (a caret at the press, or nothing). A Shift press with no
   * text of the reader's in a block to extend is a plain press -- the
   * round-13 rule -- in a read-only view too. A range in a block's text is
   * still extended across blocks (P17k), the control.
   */
  test('RO6n a read-only Shift+click after a block selection extends nothing', async ({
    editor,
    page,
    browserName,
  }) => {
    await editor.load({ doc: 'long', editable: false });
    const from = await editor.pointAt(editor.content('p1'), 3);
    const via = await editor.pointAt(editor.content('p3'), 8);
    const far = await editor.pointAt(editor.content('p6'), 5);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, from.y, { steps: 3 });
    await page.mouse.move(via.x, via.y, { steps: 8 });
    await page.mouse.up();
    await editor.settle();
    expect(await editor.selected()).toEqual(['p1', 'p2', 'p3']);
    await page.keyboard.down('Shift');
    await page.mouse.click(far.x, far.y);
    await page.keyboard.up('Shift');
    await editor.settle();
    expect(await editor.selected(), 'released').toEqual([]);
    expect(
      await page.evaluate(() => getSelection()!.toString().length),
      'released: the range',
    ).toBe(0);
    await page.keyboard.press('Shift+ArrowDown');
    await editor.settle();
    expect(await editor.selected(), 'Shift+↓').toEqual([]);
    expect(await page.evaluate(() => getSelection()!.toString().length), 'Shift+↓: the range').toBe(
      0,
    );

    // The control: a range in p1's text, and a Shift+click in p4.
    await editor.load({ doc: 'long', editable: false });
    await editor.dragText(['p1', 0], ['p1', 5]);
    const fourth = await editor.pointAt(editor.content('p4'), 5);
    await page.keyboard.down('Shift');
    await page.mouse.click(fourth.x, fourth.y);
    await page.keyboard.up('Shift');
    await editor.settle();
    expect(await editor.selected(), 'from a range in a block').toEqual(['p1', 'p2', 'p3', 'p4']);

    // And a range of the page's own, above the editor, Shift+clicked on into
    // p2: the page's selection, extended by the browser, and none of the
    // editor's to take away. (WebKit's own Shift+click from a caret in
    // the page's text selects nothing there, round 13 too: 0 characters.)
    await editor.load({ doc: 'long', editable: false });
    await page.evaluate(() => {
      const text = document.createElement('p');
      text.id = 'outside';
      text.textContent = 'Some text of the page, above the editor.';
      document.querySelector('#stage')!.before(text);
    });
    const outside = (await page.locator('#outside').boundingBox())!;
    await page.mouse.click(outside.x + 20, outside.y + outside.height / 2);
    const second = await editor.pointAt(editor.content('p2'), 5);
    await page.keyboard.down('Shift');
    await page.mouse.click(second.x, second.y);
    await page.keyboard.up('Shift');
    await editor.settle();
    if (browserName !== 'webkit') {
      expect(
        await page.evaluate(() => getSelection()!.toString().length),
        'from the page’s text',
      ).toBeGreaterThan(30);
    }
  });

  /*
   * R14-RV4-1, the reviewer's b1 case: blocks selected -- b by its handle in
   * an editable view, a to c by a drag in a read-only one -- and then a drag
   * of the reader's from the page's own text, above the editor, down into
   * block d. The range is the reader's, and the page's to keep; the
   * release-time drop of R14-RV3-6 found blocks selected and a range across
   * them, and let it go: nothing was selected, and a read-only Mod+C copied
   * nothing. The drop is for a gesture pressed in this editor. One move
   * from the page's text into d: drawn over the page's text first, the
   * range ends the block selection before it reaches the editor
   * (R14-RV4-B2). In one move it ends it too: a range the reader began
   * outside the editor ends the block selection whatever its focus --
   * asked only of a range wholly outside, the one move into d left b (an
   * editable view in Chromium) or a to c (read-only, Chromium and WebKit)
   * selected beside the reader's range, and `getSelectedBlocks()` answered
   * with them (R14-RV5-5). The range stays, and a copy is the browser's.
   * In a shadow root too, where the anchor is read through the composed
   * range: Chromium and WebKit give the selection no direction there, and
   * the end the page's own selection names outside the tree is the one.
   */
  test('RO6o a range drawn from the page’s text into the blocks is the reader’s to keep', async ({
    editor,
    page,
  }) => {
    for (const [mount, editable] of [
      [undefined, true],
      [undefined, false],
      ['shadow', true],
      ['shadow', false],
    ] as const) {
      const label = `${mount ?? 'plain'}, ${editable ? 'editable' : 'read-only'}`;
      await editor.load({ doc: 'five', toolbar: 0, editable, mount });
      await page.evaluate(() => {
        const text = document.createElement('p');
        text.id = 'outside';
        text.textContent = 'Some page text that the reader can select here, above the editor.';
        document.querySelector('#stage')!.before(text);
      });
      if (editable) {
        await editor.hoverBlock('b');
        await editor.handle.click();
        expect(await editor.selected(), label).toEqual(['b']);
      } else {
        const a = await editor.pointAt(editor.content('a'), 2);
        const c = await editor.pointAt(editor.content('c'), 5);
        await page.mouse.move(a.x, a.y);
        await page.mouse.down();
        await page.mouse.move(a.x + 20, a.y, { steps: 3 });
        await page.mouse.move(c.x, c.y, { steps: 6 });
        await page.mouse.up();
        await editor.settle();
        expect(await editor.selected(), label).toEqual(['a', 'b', 'c']);
      }
      const outside = (await page.locator('#outside').boundingBox())!;
      const d = await editor.pointAt(editor.content('d'), 5);
      await page.mouse.move(outside.x + 20, outside.y + outside.height / 2);
      await page.mouse.down();
      await page.mouse.move(d.x, d.y);
      await page.mouse.up();
      await editor.settle();
      // Read through the composed range in a shadow root: what the page's
      // own selection reports of a range into one differs by engine
      // (Firefox: collapsed in d; WebKit, read-only: no range at all), and
      // WebKit's stops at an editable editor's edge.
      expect(
        await page.evaluate(() => {
          const selection = getSelection()!;
          const tree = window.__e2e.editor.element.getRootNode();
          if (!('host' in tree)) return selection.toString().length > 30;
          const [range] = (
            selection as Selection & {
              getComposedRanges(options: { shadowRoots: ShadowRoot[] }): StaticRange[];
            }
          ).getComposedRanges({ shadowRoots: [tree as ShadowRoot] });
          return range !== undefined && !range.collapsed && !tree.contains(range.startContainer);
        }),
        `${label}: the reader's range`,
      ).toBe(true);
      expect(await editor.selected(), `${label}: no blocks beside it`).toEqual([]);
      await page.evaluate(() => {
        window.addEventListener('copy', (event) => {
          (window as unknown as { __copied: boolean }).__copied = event.defaultPrevented;
        });
      });
      await page.keyboard.press('ControlOrMeta+c');
      expect(
        await page.evaluate(() => (window as unknown as { __copied?: boolean }).__copied),
        `${label}: Mod+C is the browser's`,
      ).toBe(false);
    }
  });

  /*
   * The other way round -- a read-only drag pressed in b and carried up out
   * of the editor into the page's text -- is the editor's own gesture: it
   * selects a and b, as in a plain mount, and the browser's range beside
   * them is let go of at the release (R14-RV3-6). In a WebKit shadow root
   * the selection's ends are retargeted out of the tree, and read so (round
   * 14, review 4), the range looked wholly outside the editor and ended
   * the drag's block selection as it went: nothing selected and an
   * 81-character range across the page and the blocks at the release. Its
   * anchor is in b.
   */
  test('RO6o3 a read-only drag carried out of a shadow-mounted editor keeps its blocks', async ({
    editor,
    page,
  }) => {
    for (const mount of [undefined, 'shadow'] as const) {
      const label = mount ?? 'plain';
      await editor.load({ doc: 'five', toolbar: 0, editable: false, mount });
      await page.evaluate(() => {
        const text = document.createElement('p');
        text.id = 'outside';
        text.textContent = 'Some page text that the reader can select here, above the editor.';
        document.querySelector('#stage')!.before(text);
      });
      const outside = (await page.locator('#outside').boundingBox())!;
      const b = await editor.pointAt(editor.content('b'), 3);
      await page.mouse.move(b.x, b.y);
      await page.mouse.down();
      await page.mouse.move(b.x + 30, b.y, { steps: 2 });
      await page.mouse.move(outside.x + 60, outside.y + outside.height / 2, { steps: 3 });
      await page.mouse.up();
      await editor.settle();
      expect(await editor.selected(), label).toEqual(['a', 'b']);
      expect(
        await page.evaluate(() => {
          const selection = getSelection()!;
          return selection.isCollapsed ? 0 : selection.toString().length;
        }),
        `${label}: no range beside the blocks`,
      ).toBe(0);
    }

    // Out to a blank corner of the element that holds the editor's host --
    // a row beside a field. WebKit ends the range at an element boundary
    // there, (row, 0), and retargets its anchor out of the shadow tree to
    // the host's own place in that row, (row, 1): the same node at another
    // offset. Read as naming that end, the anchor was the page's, and the
    // drag's own a,b ended mid-drag (round 14, review 6, C).
    for (const mount of [undefined, 'shadow'] as const) {
      const label = `${mount ?? 'plain'}, beside a field`;
      await editor.load({ doc: 'five', toolbar: 0, editable: false, mount });
      await page.evaluate(() => {
        const host = document.querySelector('#stage')!.firstElementChild as HTMLElement;
        const row = document.createElement('div');
        row.id = 'row';
        row.style.cssText = 'display: flex; gap: 16px; align-items: center; padding: 30px';
        const field = document.createElement('input');
        field.style.width = '60px';
        host.style.cssText += '; width: 420px; flex: none';
        host.before(row);
        row.append(field, host);
      });
      const row = (await page.locator('#row').boundingBox())!;
      const b = await editor.pointAt(editor.content('b'), 2);
      await page.mouse.move(b.x, b.y);
      await page.mouse.down();
      await page.mouse.move(b.x + 3, b.y + 1, { steps: 2 });
      await page.mouse.move(row.x + 5, row.y + 8, { steps: 10 });
      await page.mouse.up();
      await editor.settle();
      expect(await editor.selected(), label).toEqual(['a', 'b']);
    }
  });

  /*
   * R14-RV5-B1: the same drag, from the page's text into block d, with no
   * block selection before it, in a shadow root. At the release Firefox
   * moves the selection's own anchor into the shadow root, to a@0 -- the
   * composed range still runs from the page's text to d -- and the release
   * promoted a range the reader began outside the editor to the blocks a
   * to d: Mod+C copied the four blocks. A range with an end outside the
   * editor is never promoted. Open, closed and nested roots, both modes;
   * points are read through the editor's own element, since no locator
   * sees into a closed root.
   */
  test('RO6o2 a range drawn from the page’s text into a shadow-mounted editor selects no blocks', async ({
    editor,
    page,
  }) => {
    for (const mount of ['plain', 'shadow', 'closed', 'nested'] as const) {
      for (const editable of [true, false]) {
        const label = `${mount}, ${editable ? 'editable' : 'read-only'}`;
        await editor.load({ doc: 'five', toolbar: 0, editable, mount });
        await page.evaluate(() => {
          const text = document.createElement('p');
          text.id = 'outside';
          text.textContent = 'Some page text that the reader can select here, above the editor.';
          document.querySelector('#stage')!.before(text);
          window.addEventListener('copy', (event) => {
            (window as unknown as { __copied: boolean }).__copied = event.defaultPrevented;
          });
        });
        const outside = (await page.locator('#outside').boundingBox())!;
        const d = await page.evaluate(() => {
          const root = window.__e2e.editor.element;
          const box = root
            .querySelector('[data-block-id="d"] .neditor-block__content')!
            .getBoundingClientRect();
          return { x: box.left + 30, y: (box.top + box.bottom) / 2 };
        });
        const y = outside.y + outside.height / 2;
        await page.mouse.move(outside.x + 20, y);
        await page.mouse.down();
        await page.mouse.move(outside.x + 120, y, { steps: 4 });
        await page.mouse.move(d.x, d.y, { steps: 12 });
        await page.mouse.up();
        await editor.settle();
        expect(await page.evaluate(() => window.__e2e.editor.getSelectedBlocks()), label).toEqual(
          [],
        );
        await page.keyboard.press('ControlOrMeta+c');
        expect(
          await page.evaluate(() => (window as unknown as { __copied?: boolean }).__copied),
          `${label}: Mod+C is the browser's`,
        ).toBe(false);
      }
    }
  });

  /*
   * The reviewer's a4 case (round 14, review 4): two read-only editors,
   * blocks selected in the first by a drag, then a drag from the second
   * editor's qd into the first's d. The second editor selects its blocks as
   * the drag goes; WebKit's own drag goes on from that editor's root, and
   * its range -- 74 characters from the second editor's root to d -- was
   * left beside them at the release: an end at the root was taken for one
   * outside the editor, the same place as an end in the other editor's
   * block. The root is a place of its own.
   */
  test('RO6r a drag from one read-only editor into another leaves no range beside its blocks', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five', mount: 'two', editable: false });
    await page.evaluate(() => {
      const blocks = window.__e2e.docs
        .five()
        .blocks.map((block) => ({ ...block, id: `q${block.id}` }));
      window.__e2e.editors[1]!.setDocument({ blocks });
    });
    const second = editor.other();
    const drag = async (
      from: { x: number; y: number },
      to: { x: number; y: number },
    ): Promise<void> => {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 20, from.y, { steps: 3 });
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await page.mouse.up();
      await editor.settle();
    };
    await drag(
      await editor.pointAt(editor.content('a'), 1),
      await editor.pointAt(editor.content('c'), 5),
    );
    expect(await editor.selected()).toEqual(['a', 'b', 'c']);
    await drag(
      await second.pointAt(second.content('qd'), 1),
      await editor.pointAt(editor.content('d'), 5),
    );
    expect(await second.selected()).toEqual(['qa', 'qb', 'qc', 'qd']);
    expect(await page.evaluate(() => getSelection()!.toString().length), 'the range').toBe(0);
  });

  /*
   * R14-RV4-B1, the reviewer's b2 case: a read-only triple-click on "Block
   * B" selects its paragraph. Chromium and WebKit end that paragraph at
   * offset 0 of the next block's text, and the release promoted the range
   * across the two blocks: "b,c" selected, Mod+C "Block B" and "Block C".
   * Firefox, and every engine in an editable view, give b[0,7]. A block the
   * range reaches only at the start of its text -- no character of it
   * selected -- is not in it; left with one block, the range is that
   * block's own. At several points of the line.
   */
  test('RO6q a read-only triple-click selects its paragraph, not the next block', async ({
    editor,
    page,
    browserName,
  }) => {
    for (const offset of [1, 3, 5]) {
      await editor.load({ doc: 'five', toolbar: 0, editable: false });
      const point = await editor.pointAt(editor.content('b'), offset);
      await page.mouse.click(point.x, point.y, { clickCount: 3 });
      await editor.settle();
      expect(await editor.selected(), `at ${offset}`).toEqual([]);
      expect(await editor.selection(), `at ${offset}`).toMatchObject({
        blockId: 'b',
        range: { start: 0, end: 7 },
      });
    }

    // A block with no text is not a block reached at the start of its text:
    // a click in b, and Shift+click on an empty paragraph or a divider,
    // select up to and with it, as before.
    for (const [target, selected] of [
      ['c', ['b', 'c']],
      ['d', ['b', 'c', 'd']],
    ] as const) {
      await editor.load({ doc: 'five', toolbar: 0, editable: false });
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const blocks = ed.getDocument().blocks;
        blocks[2]!.content = [];
        blocks[3] = { id: 'd', type: 'divider', depth: 0, content: [] };
        ed.setDocument({ blocks });
      });
      const b = await editor.pointAt(editor.content('b'), 2);
      const box = (await editor.block(target).boundingBox())!;
      await page.mouse.click(b.x, b.y);
      await page.keyboard.down('Shift');
      await page.mouse.click(box.x + 40, box.y + box.height / 2);
      await page.keyboard.up('Shift');
      await editor.settle();
      expect(await editor.selected(), `Shift+click on ${target}`).toEqual(selected);
    }

    // R14-RV5-3: and the triple-click on b with a block that has no text
    // after it -- an empty paragraph, a divider, a picture with no caption.
    // Chromium and WebKit end the paragraph at the start of that block, as
    // they end a Shift+click beside it, and "b,c" was selected: Mod+C
    // copied "Block B" with an empty line, "---" or "![grey]()". Only the
    // gesture tells the two apart: a block with no text is in the range
    // when the press was on it. The Shift+click on it still selects both.
    const textless = {
      empty: { type: 'paragraph', content: [] },
      divider: { type: 'divider', content: [] },
      picture: { type: 'image', content: [], src: '/sample.png', alt: 'grey' },
    } as const;
    for (const [kind, c] of Object.entries(textless)) {
      const swap = (c: object) =>
        page.evaluate((c) => {
          const ed = window.__e2e.editor;
          const blocks = ed.getDocument().blocks;
          blocks[2] = { id: 'c', depth: 0, ...c } as (typeof blocks)[number];
          ed.setDocument({ blocks });
        }, c);
      await editor.load({ doc: 'five', toolbar: 0, editable: false });
      await swap(c);
      const point = await editor.pointAt(editor.content('b'), 3);
      await page.mouse.click(point.x, point.y, { clickCount: 3 });
      await editor.settle();
      expect(await editor.selected(), `triple-click before ${kind}`).toEqual([]);
      expect(await editor.selection(), `triple-click before ${kind}`).toMatchObject({
        blockId: 'b',
        range: { start: 0, end: 7 },
      });

      await editor.load({ doc: 'five', toolbar: 0, editable: false });
      await swap(c);
      const b = await editor.pointAt(editor.content('b'), 2);
      const box = (await editor.block('c').boundingBox())!;
      await page.mouse.click(b.x, b.y);
      await page.keyboard.down('Shift');
      await page.mouse.click(box.x + 40, box.y + Math.min(box.height / 2, 12));
      await page.keyboard.up('Shift');
      await editor.settle();
      expect(await editor.selected(), `Shift+click on ${kind}`).toEqual(['b', 'c']);
    }

    // Left with one block, the range is that block's own: from where it
    // starts, and the way the reader made it (round 14, review 5, C).
    // A click in b at 2 and a Shift+click beside c's text, at its start:
    // b[2,7], not b[0,7].
    await editor.load({ doc: 'five', toolbar: 0, editable: false });
    const besideC = async () => {
      const box = (await editor.block('c').boundingBox())!;
      return { x: box.x + 20, y: box.y + box.height / 2 };
    };
    {
      const b = await editor.pointAt(editor.content('b'), 2);
      const c = await besideC();
      await page.mouse.click(b.x, b.y);
      await page.keyboard.down('Shift');
      await page.mouse.click(c.x, c.y);
      await page.keyboard.up('Shift');
      await editor.settle();
      expect(await editor.selected(), 'beside c, from b at 2').toEqual([]);
      expect(await editor.selection(), 'beside c, from b at 2').toMatchObject({
        blockId: 'b',
        range: { start: 2, end: 7 },
      });
    }
    // The other way round -- a click beside c's text, a Shift+click in b at
    // 2 -- is backward, anchored at b's end: Shift+← moves its focus, to
    // b[1,7], where a forward range would shrink to b[2,6].
    await editor.load({ doc: 'five', toolbar: 0, editable: false });
    {
      const c = await besideC();
      const b = await editor.pointAt(editor.content('b'), 2);
      await page.mouse.click(c.x, c.y);
      await page.keyboard.down('Shift');
      await page.mouse.click(b.x, b.y);
      await page.keyboard.up('Shift');
      await editor.settle();
      expect(await editor.selection(), 'from beside c, to b at 2').toMatchObject({
        blockId: 'b',
        range: { start: 2, end: 7 },
      });
      await page.keyboard.press('Shift+ArrowLeft');
      await editor.settle();
      expect(await editor.selected(), 'then Shift+←').toEqual([]);
      expect(await editor.selection(), 'then Shift+←').toMatchObject({
        blockId: 'b',
        range: { start: 1, end: 7 },
      });
    }

    // Where no gesture says, a block with no text stays in the range: no
    // press pointed anywhere. Firefox's read-only Shift+↓ from b at 2 runs
    // its range to a last block that is a divider or a picture with no
    // caption, at its start, and selects b and that block, as round 13 did
    // (Chromium and WebKit move no caret there: a caret in b stays).
    for (const [kind, c] of Object.entries(textless)) {
      if (kind === 'empty') {
        // Firefox stops in b's own last line there: "ock B\n", no block.
        continue;
      }
      await editor.load({ doc: 'five', toolbar: 0, editable: false });
      await page.evaluate((c) => {
        const ed = window.__e2e.editor;
        const blocks = ed.getDocument().blocks.slice(0, 2);
        blocks.push({ id: 'c', depth: 0, ...c } as unknown as (typeof blocks)[number]);
        ed.setDocument({ blocks });
      }, c);
      const b = await editor.pointAt(editor.content('b'), 2);
      await page.mouse.click(b.x, b.y);
      await page.keyboard.press('Shift+ArrowDown');
      await editor.settle();
      expect(await editor.selected(), `Shift+↓ onto a last ${kind}`).toEqual(
        browserName === 'firefox' ? ['b', 'c'] : [],
      );
    }
  });

  /*
   * R14-RV5-4: the one-block range above is the block's own host's -- for a
   * table, the cell's. A block id does not name an editable host: read
   * through `getView(id).content`, WebKit's read-only triple-click in the
   * last cell, "b3", before the next block was written as a caret in the
   * first cell, H1. The cell is resolved from the range. And a table after
   * a triple-clicked paragraph whose first cell is empty is still a block
   * with text: reached only at its start, it is not in the range.
   */
  test('RO6q2 a read-only triple-click in a table’s last cell selects that cell’s text', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table', toolbar: 0, editable: false });
    const point = await editor.pointAt(editor.cell('tbl', 2, 2), 1);
    await page.mouse.click(point.x, point.y, { clickCount: 3 });
    await editor.settle();
    expect(await editor.selected()).toEqual([]);
    expect(await editor.selection()).toMatchObject({
      blockId: 'tbl',
      cell: { row: 2, column: 2 },
      range: { start: 0, end: 2 },
    });

    await editor.load({ doc: 'five', toolbar: 0, editable: false });
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const blocks = ed.getDocument().blocks;
      blocks[2] = {
        id: 'c',
        type: 'table',
        depth: 0,
        content: [],
        rows: [
          [[], [{ text: 'y1' }]],
          [[{ text: 'x2' }], [{ text: 'y2' }]],
        ],
      } as (typeof blocks)[number];
      ed.setDocument({ blocks });
    });
    const b = await editor.pointAt(editor.content('b'), 3);
    await page.mouse.click(b.x, b.y, { clickCount: 3 });
    await editor.settle();
    expect(await editor.selected(), 'before a table with an empty first cell').toEqual([]);
    expect(await editor.selection(), 'before a table with an empty first cell').toMatchObject({
      blockId: 'b',
      range: { start: 0, end: 7 },
    });
  });

  /*
   * R14-RV6-2: the cell is the range's host only when the range holds
   * nothing after it. A click in a cell and a Shift+click beside the next
   * block's text make a range that starts in that cell and runs over every
   * cell after it; written into the start cell up to its end, a click in
   * "H2" at 1 and a Shift+click beside "After the table" selected "2", and
   * Mod+C copied "2" (three engines; round 13 selected the table and the
   * next block). The range is the table's: the table is selected as a
   * block. From the last cell the range holds nothing after its cell, and
   * is that cell's text (RO6q2).
   */
  test('RO6q3 a read-only range from a cell over the rest of the table selects the table', async ({
    editor,
    page,
  }) => {
    for (const [row, column, expected] of [
      [0, 1, 'table'],
      [1, 1, 'table'],
      [2, 2, 'cell'],
    ] as const) {
      const label = `from ${row}:${column}`;
      await editor.load({ doc: 'table', toolbar: 0, editable: false });
      const cell = await editor.pointAt(editor.cell('tbl', row, column), 1);
      const box = (await editor.block('after').boundingBox())!;
      await page.mouse.click(cell.x, cell.y);
      await page.keyboard.down('Shift');
      await page.mouse.click(box.x + 20, box.y + box.height / 2);
      await page.keyboard.up('Shift');
      await editor.settle();

      if (expected === 'table') {
        expect(await editor.selected(), label).toEqual(['tbl']);
      } else {
        expect(await editor.selected(), label).toEqual([]);
        expect(await editor.selection(), label).toMatchObject({
          blockId: 'tbl',
          cell: { row, column },
          range: { start: 1, end: 2 },
        });
      }
    }
  });

  /*
   * R14-RV6-1: a collapsed toggle's children are in the document but not on
   * screen, and the triple-click's range, read over the document, held
   * [toggle, hidden child, next block]: the next block was left out (RO6q)
   * and two ids were left, so Chromium and WebKit selected the toggle as a
   * block -- Mod+C copied "- ▸ Block B" and the hidden child -- where an
   * open toggle's text was selected. The range is read over the blocks on
   * screen. A closed toggle with a child that has text and one without, and
   * an open one, before a paragraph, an empty paragraph and a divider; and
   * a range that does take the toggle in as a block still carries its
   * child, which Mod+C copies.
   */
  test('RO6q4 a read-only triple-click on a toggle selects its text, not the blocks it hides', async ({
    editor,
    page,
  }) => {
    const toggles = {
      'closed, hidden text': {
        collapsed: true,
        kid: { type: 'paragraph', content: [{ text: 'hidden kid' }] },
      },
      'closed, hidden divider': { collapsed: true, kid: { type: 'divider', content: [] } },
      open: { collapsed: false, kid: null },
    } as const;
    const next = {
      paragraph: { type: 'paragraph', content: [{ text: 'Block C' }] },
      empty: { type: 'paragraph', content: [] },
      divider: { type: 'divider', content: [] },
    } as const;
    const swap = (toggle: (typeof toggles)[keyof typeof toggles], c: object) =>
      page.evaluate(
        ([toggle, c]) => {
          const ed = window.__e2e.editor;
          type Blocks = ReturnType<typeof ed.getDocument>['blocks'];
          const blocks = [
            { id: 'a', depth: 0, type: 'paragraph', content: [{ text: 'Block A' }] },
            {
              id: 'b',
              depth: 0,
              type: 'toggle',
              collapsed: toggle.collapsed,
              content: [{ text: 'Block B' }],
            },
            ...(toggle.kid ? [{ id: 'k', depth: 1, ...toggle.kid }] : []),
            { id: 'c', depth: 0, ...c },
            { id: 'd', depth: 0, type: 'paragraph', content: [{ text: 'Block D' }] },
          ] as Blocks;
          ed.setDocument({ blocks });
        },
        [toggle, c] as const,
      );

    for (const [kind, toggle] of Object.entries(toggles)) {
      for (const [after, c] of Object.entries(next)) {
        const label = `${kind}, before ${after}`;
        await editor.load({ doc: 'five', toolbar: 0, editable: false });
        await swap(toggle, c);
        const point = await editor.pointAt(editor.content('b'), 3);
        await page.mouse.click(point.x, point.y, { clickCount: 3 });
        await editor.settle();
        expect(await editor.selected(), label).toEqual([]);
        expect(await editor.selection(), label).toMatchObject({
          blockId: 'b',
          range: { start: 0, end: 7 },
        });
      }
    }

    // From a, a Shift+click beside c's text: a and the closed toggle as
    // blocks, and the copy carries what the toggle hides.
    await editor.load({ doc: 'five', toolbar: 0, editable: false });
    await swap(toggles['closed, hidden text'], next.paragraph);
    await page.evaluate(() => {
      window.addEventListener('copy', (event) => {
        (window as unknown as { __copied: string }).__copied =
          event.clipboardData?.getData('text/plain') ?? '';
      });
    });
    const a = await editor.pointAt(editor.content('a'), 2);
    const box = (await editor.block('c').boundingBox())!;
    await page.mouse.click(a.x, a.y);
    await page.keyboard.down('Shift');
    await page.mouse.click(box.x + 20, box.y + box.height / 2);
    await page.keyboard.up('Shift');
    await editor.settle();
    expect(await editor.selected(), 'a to the toggle').toEqual(['a', 'b']);
    await page.keyboard.press('ControlOrMeta+c');
    expect(
      await page.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? ''),
      'Mod+C',
    ).toContain('hidden kid');
  });

  /*
   * R14-RV7-1's pointer half and R14-RV7-2. A block is left out of a
   * released range only where something of the block left is selected. A
   * click at the end of b's text and a Shift+click beside c make a range
   * from b's end to c's start that holds no character of either: c was
   * left out, the range written into b, and nothing was selected (three
   * engines; round 13 selected b and c). The same from the end of a
   * table's last cell. And a range that starts in a table but in no cell
   * -- a click in the table block's band below its grid -- was read as
   * starting in the first cell: the Shift+click beside the next block
   * wrote a range over "H1", and Mod+C copied "H1" (Chromium and WebKit;
   * Firefox puts that click's caret at the end of the last cell). It starts
   * beside the last cell before it, from that cell's end, which holds
   * nothing of the table, so both blocks are selected.
   */
  test('RO6q5 a read-only Shift+click from the end of a block’s text beside the next selects both', async ({
    editor,
    page,
  }) => {
    const shiftClickBeside = async (id: string) => {
      const box = (await editor.block(id).boundingBox())!;
      await page.keyboard.down('Shift');
      await page.mouse.click(box.x + 20, box.y + box.height / 2);
      await page.keyboard.up('Shift');
      await editor.settle();
    };

    await editor.load({ doc: 'five', toolbar: 0, editable: false });
    const b = (await editor.content('b').boundingBox())!;
    await page.mouse.click(b.x + b.width + 28, b.y + b.height / 2);
    await editor.settle();
    expect(await editor.selection(), 'the click').toMatchObject({
      blockId: 'b',
      range: { start: 7, end: 7 },
    });
    await shiftClickBeside('c');
    expect(await editor.selected(), 'from the end of b').toEqual(['b', 'c']);

    await editor.load({ doc: 'table', toolbar: 0, editable: false });
    const last = (await editor.cell('tbl', 2, 2).boundingBox())!;
    await page.mouse.click(last.x + last.width - 2, last.y + last.height / 2);
    await editor.settle();
    expect(await editor.selection(), 'the click in b3').toMatchObject({
      blockId: 'tbl',
      cell: { row: 2, column: 2 },
      range: { start: 2, end: 2 },
    });
    await shiftClickBeside('after');
    expect(await editor.selected(), 'from the end of the last cell').toEqual(['tbl', 'after']);

    await editor.load({ doc: 'table', toolbar: 0, editable: false });
    await page.evaluate(() => {
      window.addEventListener('copy', (event) => {
        (window as unknown as { __copied: string }).__copied =
          event.clipboardData?.getData('text/plain') ?? '';
      });
    });
    const table = (await editor.block('tbl').boundingBox())!;
    const grid = (await editor.block('tbl').locator('table').boundingBox())!;
    expect(
      table.y + table.height - (grid.y + grid.height),
      'a band below the grid',
    ).toBeGreaterThan(1);
    await page.mouse.click(last.x + last.width / 2, table.y + table.height - 1);
    await editor.settle();
    await shiftClickBeside('after');
    expect(await editor.selected(), 'from below the grid').toEqual(['tbl', 'after']);
    await page.keyboard.press('ControlOrMeta+c');
    const copied = await page.evaluate(
      () => (window as unknown as { __copied?: string }).__copied ?? '',
    );
    expect(copied, 'Mod+C').toContain('| H1 | H2 | H3 |');
    expect(copied, 'Mod+C').toContain('After the table');

    // A press in no block -- below the last one -- names no block, so a
    // last block with no text the range reaches stays in it (review 7: a
    // rule that left such a block out wherever the press was not on it
    // turned a click in b at 2 and a Shift+click below a last divider or
    // empty paragraph into b[2,7]; round 13 selected b and c, as this does).
    for (const c of [
      { type: 'divider', content: [] },
      { type: 'paragraph', content: [] },
    ] as const) {
      await editor.load({ doc: 'five', toolbar: 0, editable: false });
      await page.evaluate((c) => {
        const ed = window.__e2e.editor;
        type Blocks = ReturnType<typeof ed.getDocument>['blocks'];
        const blocks = ed.getDocument().blocks.slice(0, 2);
        ed.setDocument({ blocks: [...blocks, { id: 'c', depth: 0, ...c }] as Blocks });
      }, c);
      const at = await editor.pointAt(editor.content('b'), 2);
      await page.mouse.click(at.x, at.y);
      const root = (await editor.root.boundingBox())!;
      const lastBlock = (await editor.block('c').boundingBox())!;
      const below = lastBlock.y + lastBlock.height + 10;
      expect(below, 'room below the last block').toBeLessThan(root.y + root.height - 1);
      await page.keyboard.down('Shift');
      await page.mouse.click(lastBlock.x + 40, below);
      await page.keyboard.up('Shift');
      await editor.settle();
      expect(await editor.selected(), `below a last ${c.type}`).toEqual(['b', 'c']);
    }
  });

  /*
   * A block with no text the reader clicked first is where the selection
   * begins (review 8). R14-RV8-1: Shift+clicked back into the block before
   * it, the release left the textless block out because the press was not
   * on it, and Mod+C copied "ck B". R14-RV8-2: after a click on a divider or
   * a picture, the Shift press took out the browser's caret there (in the
   * block, in no host) and selected nothing; round 13 selected both blocks.
   */
  test('RO6q8 a read-only Shift+click from a block with no text selects both blocks', async ({
    editor,
    page,
  }) => {
    const kinds = {
      'empty paragraph': { type: 'paragraph', content: [] },
      'empty image': { type: 'image', content: [], src: '', alt: '' },
      divider: { type: 'divider', content: [] },
      picture: { type: 'image', content: [], src: '/sample.png', alt: 'grey' },
    } as const;

    for (const [kind, x] of Object.entries(kinds)) {
      for (const [target, expected] of [
        ['b', ['b', 'x']],
        ['c', ['x', 'c']],
      ] as const) {
        await editor.load({ doc: 'five', toolbar: 0, editable: false });
        await page.evaluate((x) => {
          const ed = window.__e2e.editor;
          type Blocks = ReturnType<typeof ed.getDocument>['blocks'];
          const text = (id: string, t: string) => ({
            id,
            depth: 0,
            type: 'paragraph',
            content: [{ text: t }],
          });
          ed.setDocument({
            blocks: [
              text('a', 'Block A'),
              text('b', 'Block B'),
              { id: 'x', depth: 0, ...x },
              text('c', 'Block C'),
            ] as Blocks,
          });
        }, x);
        if (kind === 'picture') {
          await expect
            .poll(() =>
              editor
                .block('x')
                .locator('img')
                .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
            )
            .toBe(true);
        }
        // Beside the picture, in the block's padding: a press on the picture
        // itself places no caret in any engine, so nothing extends from it
        // (R15-SEL-2, a documented limit).
        const box = (await editor.block('x').boundingBox())!;
        await page.mouse.click(box.x + 40, box.y + box.height / 2);
        await editor.settle();
        const at = await editor.pointAt(editor.content(target), 3);
        await page.keyboard.down('Shift');
        await page.mouse.click(at.x, at.y);
        await page.keyboard.up('Shift');
        await editor.settle();
        expect(await editor.selected(), `${kind}, Shift+click in ${target}`).toEqual([...expected]);
      }
    }
  });

  /*
   * Round 15. R15-SEL-1: a range across blocks a page button builds through
   * the Selection API from its own press is the API's, and selects every
   * block it reaches, as round 13 did; read at that press's release with
   * the pointer's rule, b:2..c:0 was cut to "ock B". R15-SEL-P3-1: such a
   * range reveals the block it reaches, its focus end.
   */
  test('RO6q9 an API range from a page press selects its blocks; a drag into the page stays the page’s', async ({
    editor,
    page,
    browserName,
  }) => {
    for (const editable of [false, true]) {
      await editor.load({ doc: 'five', toolbar: 0, editable });
      await page.evaluate(() => {
        const button = document.createElement('button');
        button.id = 'api-range';
        button.textContent = 'Select b to c';
        button.style.cssText = 'position:fixed;right:8px;bottom:8px';
        button.addEventListener('mousedown', (event) => {
          event.preventDefault();
          const root = window.__e2e.editor.element;
          const text = (id: string) =>
            root.querySelector(`[data-block-id="${id}"] .neditor-block__content`)!.firstChild!;
          document.getSelection()!.setBaseAndExtent(text('b'), 2, text('c'), 0);
        });
        document.body.append(button);
      });
      await page.locator('#api-range').click();
      await editor.settle();
      // WebKit keeps such a range inside one host in an editable view, as
      // in round 13.
      if (!(editable && browserName === 'webkit')) {
        expect(await editor.selected(), `${editable ? 'editable' : 'read-only'}`).toEqual([
          'b',
          'c',
        ]);
      }
    }

    await editor.load({ doc: 'long', toolbar: 0, editable: false });
    await page.evaluate(() => {
      const root = window.__e2e.editor.element;
      const ids = window.__e2e.editor.getDocument().blocks.map((b) => b.id);
      const text = (id: string) =>
        root.querySelector(`[data-block-id="${id}"] .neditor-block__content`)!.firstChild!;
      (window as unknown as { __last: string }).__last = ids.at(-1)!;
      document.getSelection()!.setBaseAndExtent(text(ids[1]!), 1, text(ids.at(-1)!), 1);
    });
    await editor.settle();
    const last = await page.evaluate(() => (window as unknown as { __last: string }).__last);
    await expect(editor.block(last), 'the focus end is revealed').toBeInViewport();

    // A drag from the last block into the page's own text below the editor
    // takes in that text, and stays the page's range, in a shadow mount too
    // (R16-2, R17-1: a rule for WebKit's triple-click on the last block cut
    // it to the block, and Mod+C copied "ock E"; reverted, see AGENTS.md).
    for (const mount of ['plain', 'shadow'] as const) {
      await editor.load({ doc: 'five', toolbar: 0, editable: false, mount });
      await page.evaluate(() => {
        const below = document.createElement('p');
        below.id = 'page-below';
        below.textContent = 'Page text below';
        document.body.append(below);
      });
      const start = await editor.pointAt(editor.content('e'), 2);
      const end = (await page.locator('#page-below').boundingBox())!;
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x + 40, end.y + end.height / 2, { steps: 8 });
      await page.mouse.up();
      await editor.settle();
      expect(await editor.selected(), `${mount}, into the page: no blocks`).toEqual([]);
      // Where the range really ends: the composed range, since Chromium's
      // document selection is retargeted at a shadow root's host.
      expect(
        await page.evaluate(() => {
          const root = window.__e2e.editor.element.getRootNode();
          const selection = document.getSelection() as Selection & {
            getComposedRanges(options: { shadowRoots: Node[] }): StaticRange[];
          };
          const shadowRoots = root instanceof ShadowRoot ? [root] : [];
          const range = selection.getComposedRanges({ shadowRoots })[0];
          return range
            ? document.getElementById('page-below')!.contains(range.endContainer)
            : false;
        }),
        `${mount}, into the page: the range ends in the page's text`,
      ).toBe(true);
    }
  });

  /*
   * A toggle the reader closed with its chevron (review 7). R14-RV7-3: a
   * block selection that takes it in carries the children it hides, as a
   * toggle collapsed in the document does: expanded by the document alone,
   * the click in a and the Shift+click beside c selected a and the toggle,
   * and Mod+C copied "Block A" and an open toggle with no children. The
   * copy writes the document, so the toggle goes as the document has it,
   * open, with its children under it. And the range is read over what the
   * reader is shown: its text range stays text (R14-RV6-1's rule, with the
   * reader's own override; read over the document's idea of what is hidden,
   * the children were counted and the toggle was selected as a block).
   */
  test('RO6q6 a toggle the reader closed: its text stays text, and taken in it copies its children', async ({
    editor,
    page,
  }) => {
    const seed = async () => {
      await editor.load({ doc: 'five', toolbar: 0, editable: false });
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        type Blocks = ReturnType<typeof ed.getDocument>['blocks'];
        ed.setDocument({
          blocks: [
            { id: 'a', depth: 0, type: 'paragraph', content: [{ text: 'Block A' }] },
            { id: 'b', depth: 0, type: 'toggle', collapsed: false, content: [{ text: 'Block B' }] },
            { id: 'k1', depth: 1, type: 'paragraph', content: [{ text: 'kid one' }] },
            { id: 'k2', depth: 1, type: 'paragraph', content: [{ text: 'kid two' }] },
            { id: 'c', depth: 0, type: 'paragraph', content: [{ text: 'Block C' }] },
            { id: 'd', depth: 0, type: 'paragraph', content: [{ text: 'Block D' }] },
          ] as Blocks,
        });
      });
      await editor.block('b').locator('.neditor-block__chevron').click();
      await expect(editor.block('k1')).toHaveCount(0);
    };
    const shiftClickBesideC = async () => {
      const box = (await editor.block('c').boundingBox())!;
      await page.keyboard.down('Shift');
      await page.mouse.click(box.x + 20, box.y + box.height / 2);
      await page.keyboard.up('Shift');
      await editor.settle();
    };

    await seed();
    const point = await editor.pointAt(editor.content('b'), 3);
    await page.mouse.click(point.x, point.y, { clickCount: 3 });
    await editor.settle();
    expect(await editor.selected(), 'triple-click').toEqual([]);
    expect(await editor.selection(), 'triple-click').toMatchObject({
      blockId: 'b',
      range: { start: 0, end: 7 },
    });

    await seed();
    const b = await editor.pointAt(editor.content('b'), 2);
    await page.mouse.click(b.x, b.y);
    await shiftClickBesideC();
    expect(await editor.selected(), 'from b at 2').toEqual([]);
    expect(await editor.selection(), 'from b at 2').toMatchObject({
      blockId: 'b',
      range: { start: 2, end: 7 },
    });

    await seed();
    await page.evaluate(() => {
      window.addEventListener('copy', (event) => {
        (window as unknown as { __copied: string }).__copied =
          event.clipboardData?.getData('text/plain') ?? '';
      });
    });
    const a = await editor.pointAt(editor.content('a'), 2);
    await page.mouse.click(a.x, a.y);
    await shiftClickBesideC();
    expect(await editor.selected(), 'a to the toggle').toEqual(['a', 'b']);
    await page.keyboard.press('ControlOrMeta+c');
    const copied = await page.evaluate(
      () => (window as unknown as { __copied?: string }).__copied ?? '',
    );
    expect(copied, 'Mod+C').toContain('Block B');
    expect(copied, 'Mod+C').toContain('kid one');
    expect(copied, 'Mod+C').toContain('kid two');
    expect(copied, 'Mod+C').not.toContain('Block C');
    // The reader's override is a view state the harness's own check (what
    // is drawn is the document's visible blocks) does not know of; a fresh
    // load ends the test on the document's view.
    await editor.load({ doc: 'five', toolbar: 0, editable: false });
  });

  /*
   * R14-RV1-5 for the table a released range selects (R14-RV6-2): a press
   * does not reveal what it selects. A click in a cell of a 40-row table,
   * the page wheeled on until "After the table" shows and the cell does
   * not, and a Shift+click beside it: the table is selected where it is,
   * and nothing scrolls (revealed, the page jumped about 500px under the
   * pointer).
   */
  test('RO6q7 a read-only Shift+click that selects a tall table does not scroll', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five', toolbar: 0, editable: false });
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      type Blocks = ReturnType<typeof ed.getDocument>['blocks'];
      const text = (text: string) => [{ text }];
      ed.setDocument({
        blocks: [
          { id: 'before', depth: 0, type: 'paragraph', content: text('Before') },
          {
            id: 'tbl',
            depth: 0,
            type: 'table',
            content: [],
            rows: Array.from({ length: 40 }, (_, i) => [0, 1, 2].map((c) => text(`r${i}c${c}`))),
          },
          { id: 'after', depth: 0, type: 'paragraph', content: text('After the table') },
          ...Array.from({ length: 12 }, (_, i) => ({
            id: `p${i}`,
            depth: 0,
            type: 'paragraph',
            content: text(`filler ${i}`),
          })),
        ] as Blocks,
      });
    });
    await editor.settle();
    const cell = await editor.pointAt(editor.cell('tbl', 0, 1), 2);
    await page.mouse.click(cell.x, cell.y);
    await page.mouse.move(500, 400);
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 120);
    }
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(600);
    await editor.settleScroll();
    const y = await page.evaluate(() => window.scrollY);
    const cellBox = (await editor.cell('tbl', 0, 1).boundingBox())!;
    expect(cellBox.y + cellBox.height, 'the cell scrolled away').toBeLessThan(0);
    const after = (await editor.block('after').boundingBox())!;
    await page.keyboard.down('Shift');
    await page.mouse.click(after.x + 20, after.y + after.height / 2);
    await page.keyboard.up('Shift');
    await editor.settle();
    expect(await editor.selected()).toEqual(['tbl']);
    expect(await page.evaluate(() => window.scrollY)).toBe(y);
  });

  /*
   * R14-RV7-1. A range a key made selects every block it reaches; only a
   * pointer's release leaves one out. The browser's own read-only
   * Shift+→ from a word double-clicked at the end of b runs the range to
   * the start of c's text, and with c left out, as a triple-click's next
   * block is, the key never crossed the edge: b[6,7] after every press,
   * in every engine (round 13 selected b and c at the first press).
   * Firefox moves a caret by key too: Shift+→ from b's end, Shift+← from
   * c's start -- which dropped c, the block the range began in -- and
   * Shift+↑ from the start of the block after a table.
   */
  test('RO6s a read-only Shift+arrow across a block edge selects the blocks', async ({
    editor,
    page,
    browserName,
  }) => {
    await editor.load({ doc: 'five', toolbar: 0, editable: false });
    const word = await editor.pointAt(editor.content('b'), 6);
    await page.mouse.click(word.x, word.y, { clickCount: 2 });
    await editor.settle();
    expect(await editor.selection(), 'the double-click').toMatchObject({
      blockId: 'b',
      range: { start: 6, end: 7 },
    });
    await page.keyboard.press('Shift+ArrowRight');
    await editor.settle();
    expect(await editor.selected(), 'Shift+→ from "B"').toEqual(['b', 'c']);

    if (browserName !== 'firefox') {
      return;
    }

    const caretThenKey = async (doc: string, id: string, offset: number, key: string) => {
      await editor.load({ doc, toolbar: 0, editable: false });
      const at = await editor.pointAt(editor.content(id), offset);
      await page.mouse.click(at.x + (offset === 0 ? -0.5 : 0.5), at.y);
      await editor.settle();
      expect(await editor.selection(), `the click in ${id}`).toMatchObject({
        blockId: id,
        range: { start: offset, end: offset },
      });
      await page.keyboard.press(key);
      await editor.settle();
    };
    await caretThenKey('five', 'b', 7, 'Shift+ArrowRight');
    expect(await editor.selected(), 'Shift+→ from the end of b').toEqual(['b', 'c']);
    await caretThenKey('five', 'c', 0, 'Shift+ArrowLeft');
    expect(await editor.selected(), 'Shift+← from the start of c').toEqual(['b', 'c']);
    await caretThenKey('table', 'after', 0, 'Shift+ArrowUp');
    expect(await editor.selected(), 'Shift+↑ from after the table').toEqual(['tbl', 'after']);
  });

  /*
   * R14-RV4-B2: a block selection, and then a selection the reader makes in
   * the page's own text, outside the editor. Both were shown; the block
   * selection was still the editor's answer to `getSelectedBlocks()`, and
   * the next drag from the page into the blocks met it (RO6o). A range the
   * reader makes outside the editor ends the block selection. A press that
   * makes no range does not: a host toolbar's button reads
   * `getSelectedBlocks()` from its click, the control.
   */
  test('RO6p a selection made in the page’s text ends the block selection; a button click does not', async ({
    editor,
    page,
  }) => {
    for (const editable of [true, false]) {
      const label = editable ? 'editable' : 'read-only';
      await editor.load({ doc: 'five', toolbar: 0, editable });
      await page.evaluate(() => {
        const text = document.createElement('p');
        text.id = 'outside';
        text.textContent = 'Some page text that the reader can select here, below the editor.';
        document.querySelector('#stage')!.after(text);
        const button = document.createElement('button');
        button.id = 'count';
        button.textContent = 'Count';
        button.onclick = () => {
          button.dataset.read = window.__e2e.editor.getSelectedBlocks().join(',');
        };
        text.after(button);
        // What the editor puts on the clipboard for a copy: nothing of its
        // own, read after every handler, is the browser's copy of the
        // page's selection.
        window.addEventListener('copy', (event) => {
          (window as unknown as { __copied: string }).__copied =
            event.clipboardData?.getData('text/plain') ?? '';
        });
      });
      const select = async () => {
        if (editable) {
          await editor.hoverBlock('b');
          await editor.handle.click();
        } else {
          const b = await editor.pointAt(editor.content('b'), 2);
          const c = await editor.pointAt(editor.content('c'), 5);
          await page.mouse.move(b.x, b.y);
          await page.mouse.down();
          await page.mouse.move(b.x + 20, b.y, { steps: 3 });
          await page.mouse.move(c.x, c.y, { steps: 6 });
          await page.mouse.up();
        }
        await editor.settle();
        return editor.selected();
      };
      const blocks = await select();
      expect(blocks.length, label).toBeGreaterThan(0);

      // The control: a page button reads the blocks, and they stay.
      await page.locator('#count').click();
      await editor.settle();
      expect(await page.locator('#count').getAttribute('data-read'), `${label}: the button`).toBe(
        blocks.join(','),
      );
      expect(await editor.selected(), `${label}: after the button`).toEqual(blocks);

      // And a click in the page's text that selects nothing: a caret, or
      // nothing at all, outside the editor.
      const outside = (await page.locator('#outside').boundingBox())!;
      const y = outside.y + outside.height / 2;
      await page.mouse.click(outside.x + 60, y);
      await editor.settle();
      expect(await editor.selected(), `${label}: after a click in the page's text`).toEqual(blocks);

      // A range drawn in the page's text.
      await page.mouse.move(outside.x + 20, y);
      await page.mouse.down();
      await page.mouse.move(outside.x + 220, y, { steps: 6 });
      await page.mouse.up();
      await editor.settle();
      expect(await editor.selected(), `${label}: the page's range`).toEqual([]);
      const text = await page.evaluate(() => getSelection()!.toString());
      expect(text.length, `${label}: the page's range`).toBeGreaterThan(10);
      await page.keyboard.press('ControlOrMeta+c');
      expect(
        await page.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? ''),
        `${label}: Mod+C writes nothing of the editor's`,
      ).toBe('');
      expect(await page.evaluate(() => getSelection()!.toString()), `${label}: Mod+C`).toBe(text);
    }
  });

  /*
   * RO6p in a shadow root (R14-RV5-2). Chromium's `ShadowRoot.getSelection()`
   * reports nothing for a selection outside its tree, so read through it, a
   * range in the page's text below the editor, one from the text above it
   * to the text below (over the editor), and Mod+A on the page all left the
   * blocks selected beside the page's range. The selection is read as the
   * page's, through the composed range. Open, closed and nested roots, both
   * modes; a page button's click still keeps the blocks. Points are read
   * through the editor's own element: no locator sees into a closed root.
   */
  test('RO6p3 a selection made in the page’s text ends a shadow-mounted editor’s block selection', async ({
    editor,
    page,
  }) => {
    const at = (id: string, offset: number) =>
      page.evaluate(
        ([id, offset]) => {
          const root = window.__e2e.editor.element;
          const host = root.querySelector(`[data-block-id="${id}"] .neditor-block__content`)!;
          const range = root.ownerDocument.createRange();
          range.setStart(host.firstChild!, offset as number);
          range.setEnd(host.firstChild!, (offset as number) + 1);
          const box = range.getBoundingClientRect();
          return { x: box.left + 1, y: (box.top + box.bottom) / 2 };
        },
        [id, offset] as const,
      );
    const selected = () => page.evaluate(() => window.__e2e.editor.getSelectedBlocks());

    for (const mount of ['shadow', 'closed', 'nested'] as const) {
      for (const editable of [true, false]) {
        for (const how of ['below', 'across', 'select all'] as const) {
          const label = `${mount}, ${editable ? 'editable' : 'read-only'}, ${how}`;
          await editor.load({ doc: 'five', toolbar: 0, editable, mount });
          await page.evaluate(() => {
            const stage = document.querySelector('#stage')!;
            const above = document.createElement('p');
            above.id = 'above';
            above.textContent = 'Page text above the editor.';
            const below = document.createElement('p');
            below.id = 'below';
            below.textContent = 'Page text below the editor, long enough to drag in.';
            stage.before(above);
            stage.after(below);
            const button = document.createElement('button');
            button.id = 'count';
            button.textContent = 'Count';
            below.after(button);
          });
          if (editable) {
            await page.evaluate(() => window.__e2e.editor.focus('b'));
            await page.keyboard.press('Escape');
            await page.keyboard.press('Shift+ArrowDown');
          } else {
            const a = await at('a', 1);
            const c = await at('c', 3);
            await page.mouse.move(a.x, a.y);
            await page.mouse.down();
            await page.mouse.move(a.x + 20, a.y, { steps: 3 });
            await page.mouse.move(c.x, c.y, { steps: 6 });
            await page.mouse.up();
          }
          await editor.settle();
          const blocks = editable ? ['b', 'c'] : ['a', 'b', 'c'];
          expect(await selected(), `${label}: before`).toEqual(blocks);
          await page.locator('#count').click();
          await editor.settle();
          expect(await selected(), `${label}: after a page button`).toEqual(blocks);

          const above = (await page.locator('#above').boundingBox())!;
          const below = (await page.locator('#below').boundingBox())!;
          const ay = above.y + above.height / 2;
          const by = below.y + below.height / 2;
          if (how === 'below') {
            await page.mouse.move(below.x + 10, by);
            await page.mouse.down();
            await page.mouse.move(below.x + 200, by, { steps: 6 });
            await page.mouse.up();
          } else if (how === 'across') {
            await page.mouse.move(above.x + 5, ay);
            await page.mouse.down();
            await page.mouse.move(above.x + 50, ay, { steps: 3 });
            await page.mouse.move(below.x + 120, by, { steps: 12 });
            await page.mouse.up();
          } else {
            await page.mouse.click(below.x + 10, by);
            await page.keyboard.press('ControlOrMeta+a');
          }
          await editor.settle();
          expect(
            await page.evaluate(() => getSelection()!.toString().length),
            `${label}: the page's range`,
          ).toBeGreaterThan(10);
          expect(await selected(), label).toEqual([]);
        }
      }
    }
  });

  /*
   * RO6p's rule with a second editor on the page (round 14, review 4's a4):
   * the page has one selection, so a range the reader draws in the other
   * editor ends this one's block selection -- across the other editor's
   * blocks, or from them into this one's. Before R14-RV4-B2 both editors
   * showed blocks, and WebKit also kept a native range of 74 characters
   * across the two.
   */
  test('RO6p2 a range drawn in another editor on the page ends this one’s block selection', async ({
    browserName,
    editor,
    page,
  }) => {
    const second = editor.other(1);
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 20, from.y, { steps: 3 });
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await page.mouse.up();
      await editor.settle();
    };
    for (const into of [false, true]) {
      const label = into ? 'from the second editor into the first' : 'across the second editor';
      await editor.load({ doc: 'five', mount: 'two', editable: false });
      await page.evaluate(() => {
        const blocks = window.__e2e.docs
          .five()
          .blocks.map((block) => ({ ...block, id: `q${block.id}` }));
        window.__e2e.editors[1]!.setDocument({ blocks });
      });
      await drag(
        await editor.pointAt(editor.content('a'), 1),
        await editor.pointAt(editor.content('c'), 3),
      );
      expect(await editor.selected(), `${label}: before`).toEqual(['a', 'b', 'c']);

      await drag(
        await second.pointAt(second.content(into ? 'qd' : 'qa'), 1),
        into
          ? await editor.pointAt(editor.content('d'), 3)
          : await second.pointAt(second.content('qc'), 3),
      );
      expect(await editor.selected(), label).toEqual([]);
      expect(await second.selected(), `${label}: the second editor`).toEqual(
        into ? ['qa', 'qb', 'qc', 'qd'] : ['qa', 'qb', 'qc'],
      );
      expect(
        await page.evaluate(() => {
          const selection = getSelection()!;
          return selection.isCollapsed ? 0 : selection.toString().length;
        }),
        `${label}: no native range beside the blocks`,
      ).toBe(0);
    }

    // Straight from the second editor's qd into the first's d, with no move
    // inside the second first (round 14, review 5's a4): no event saw the
    // range wholly outside the first editor, so its blocks stayed beside
    // the reader's range. A range the reader began outside this editor ends
    // its block selection whatever its focus (R14-RV5-5) -- where there is
    // one: WebKit's runs from the second editor's root into d. Chromium and
    // Firefox present none -- the second editor selects its blocks on the
    // first move out of qd, and a block selection holds no range, as an
    // editable editor's drag never does -- so the first editor hears only a
    // caret in qd, which, like a click on a page button, ends nothing: a
    // documented limit, asserted here by its cause.
    for (const steps of [1, 2]) {
      const label = `straight into the first, in ${steps} move${steps > 1 ? 's' : ''}`;
      await editor.load({ doc: 'five', mount: 'two', editable: false });
      await page.evaluate(() => {
        const blocks = window.__e2e.docs
          .five()
          .blocks.map((block) => ({ ...block, id: `q${block.id}` }));
        window.__e2e.editors[1]!.setDocument({ blocks });
      });
      await drag(
        await editor.pointAt(editor.content('a'), 1),
        await editor.pointAt(editor.content('c'), 3),
      );
      expect(await editor.selected(), `${label}: before`).toEqual(['a', 'b', 'c']);
      const from = await second.pointAt(second.content('qd'), 2);
      const into = await editor.pointAt(editor.content('d'), 3);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(into.x, into.y, { steps });
      await page.mouse.up();
      await editor.settle();
      expect(await second.selected(), `${label}: the second editor`).toEqual([
        'qa',
        'qb',
        'qc',
        'qd',
      ]);
      if (browserName === 'webkit') {
        expect(await editor.selected(), label).toEqual([]);
      } else {
        expect(
          await page.evaluate(() => {
            const selection = getSelection()!;
            return selection.rangeCount === 0 || selection.isCollapsed;
          }),
          `${label}: no range was drawn`,
        ).toBe(true);
      }
    }
  });

  /*
   * R14-RV2-B2, the reviewer's ro3 case: hosts re-assert the state they
   * have on every render. A `setEditable` that switches nothing changes
   * nothing: `setEditable(false)` on a read-only view let go of the blocks
   * the reader had selected to copy, and `setEditable(true)` on an editable
   * one ran the same switch. The selection, the caret, an open panel and
   * the events all stay as they were.
   */
  test('RO6l a setEditable that switches nothing changes nothing', async ({ editor, page }) => {
    await editor.load({ doc: 'long', editable: false });
    const from = await editor.pointAt(editor.content('p1'), 2);
    const to = await editor.pointAt(editor.content('p3'), 8);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, from.y, { steps: 3 });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    await editor.settle();
    expect(await editor.selected()).toEqual(['p1', 'p2', 'p3']);
    let heard = (await editor.events()).length;
    await page.evaluate(() => window.__e2e.editor.setEditable(false));
    await editor.settle();
    expect(await editor.selected(), 'read-only, again').toEqual(['p1', 'p2', 'p3']);
    expect((await editor.events()).length, 'read-only, again: events').toBe(heard);

    // Editable, with blocks selected; and with the link editor open.
    await editor.load({ doc: 'links' });
    await editor.clickAt('p2', 3);
    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual(['p2']);
    // (Once the Escape's own events are in.)
    await editor.settle();
    await editor.settle();
    heard = (await editor.events()).length;
    await page.evaluate(() => window.__e2e.editor.setEditable(true));
    await editor.settle();
    expect(await editor.selected(), 'editable, again').toEqual(['p2']);
    expect((await editor.events()).length, 'editable, again: events').toBe(heard);
    await editor.content('p1').locator('a.neditor-link').click();
    await expect(editor.portal('link-editor')).toBeVisible();
    await page.evaluate(() => window.__e2e.editor.setEditable(true));
    await editor.settle();
    await expect(editor.portal('link-editor')).toBeVisible();
    await expect(editor.portal('link-editor').getByRole('textbox')).toBeFocused();
  });

  /*
   * RO6g's limit: only a lock that takes editing away guards a kept range. In
   * an editor that was read-only already, "two" double-clicked (to copy), a
   * page button, and a host re-rendering with `setEditable(false)` again:
   * nothing was being typed, and Backspace is Safari's own, as it was before
   * round 13 -- here, Back. WebKit only: the other engines focus the button.
   */
  test('RO6g2 setEditable(false) again on a read-only editor guards nothing', async ({
    editor,
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'webkit', 'only WebKit gives a page button no focus');
    await page.goto('about:blank');
    await editor.load({ doc: 'paragraphs', editable: false });
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'rerender';
      button.textContent = 'Re-render';
      button.onclick = () => window.__e2e.editor.setEditable(false);
      document.body.prepend(button);
    });
    const point = await editor.pointAt(editor.content('p2'), 7);
    await page.mouse.dblclick(point.x, point.y);
    await page.locator('#rerender').click();

    await page.keyboard.press('Backspace');
    await expect.poll(() => page.url()).toBe('about:blank');
  });

  /*
   * R13-KEY-3, k4's literal case (WebKit): Tab onto the image trigger or the
   * callout icon, the host locks the editor, Backspace. The lock disables
   * that button, and WebKit takes focus off a disabled control only lazily:
   * when the guard was decided focus was still on the button, so none was
   * armed, and the Backspace then on `<body>` went back. The lock blurs it.
   * Navigation: e2e.
   */
  test('RO6h a lock that disables the focused image or callout control leaves no Backspace that leaves the page', async ({
    editor,
    page,
  }) => {
    for (const mount of ['plain', 'shadow', 'iframe'] as const) {
      const mounted =
        mount === 'iframe' ? new EditorPage(page, 0, page.frameLocator('#frame')) : editor;
      for (const [doc, selector] of [
        ['image', '.neditor-image__trigger'],
        ['callout', '.neditor-block__icon'],
      ] as const) {
        const label = `${mount}: ${doc}`;
        await page.goto('about:blank');
        await mounted.load({ doc, mount });
        const url = page.url();
        const control = mounted.root.locator(selector).first();
        await mounted.root.locator('.neditor-block__content').first().click();
        for (let i = 0; i < 6; i += 1) {
          await page.keyboard.press('Tab');
          const focused = await control.evaluate(
            (el) => (el.getRootNode() as Document | ShadowRoot).activeElement === el,
          );
          if (focused) break;
        }
        await expect(control, label).toBeFocused();
        const before = await mounted.doc();

        await page.evaluate(() => window.__e2e.editor.setEditable(false));
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);
        expect(page.url(), label).toBe(url);
        expect(await mounted.doc(), label).toEqual(before);
      }
    }
  });

  /*
   * R13-KEY-4, k7's literal case: the host saves on Mod+S, locking the
   * editor and unlocking it 50 ms later; the reader clicks the image's
   * caption, presses End, types "1", Mod+S, then "2". The unlock gave the
   * caret back to a paragraph but not to a caption, so "2" was lost. An
   * image's caption is given back as any block's text is. Real focus: e2e.
   */
  test('RO6i a lock and an unlock round a save give the caret back to an image caption', async ({
    editor,
    page,
  }) => {
    for (const id of ['img', 'before'] as const) {
      await editor.load({ doc: 'image' });
      await page.evaluate(() => {
        document.addEventListener(
          'keydown',
          (event) => {
            if (event.key === 's' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              const ed = window.__e2e.editor;
              ed.setEditable(false);
              setTimeout(() => ed.setEditable(true), 50);
            }
          },
          true,
        );
      });
      const before = (await editor.texts())[id === 'img' ? 1 : 0];
      await editor.content(id).click();
      await page.keyboard.press('End');
      await page.keyboard.type('1');
      await page.keyboard.press(`${MOD}+s`);
      await page.waitForTimeout(200);
      await page.keyboard.type('2');
      expect((await editor.texts())[id === 'img' ? 1 : 0], id).toBe(`${before}12`);
    }

    // A block that became an image or stopped being one during the lock is
    // not the text the reader was typing in: nothing is given back.
    for (const [id, type] of [
      ['img', 'paragraph'],
      ['before', 'image'],
    ] as const) {
      await editor.load({ doc: 'image' });
      await editor.content(id).click();
      await page.keyboard.press('End');
      await page.evaluate(
        ({ id, type }) => {
          const ed = window.__e2e.editor;
          ed.setEditable(false);
          const doc = ed.getDocument();
          const block = doc.blocks.find((candidate) => candidate.id === id)!;
          block.type = type;
          if (type === 'image') {
            block.src = '/sample.png';
            block.alt = 'A picture';
          } else {
            delete block.src;
            delete block.alt;
          }
          ed.setDocument(doc);
          ed.setEditable(true);
        },
        { id, type },
      );
      expect(await editor.hasFocus(), `${id} became ${type}`).toBe(false);
    }
  });

  /*
   * R13-PTR-1's lock variant, its other half (p1's table case): the caret in
   * cell 1:1 with the table toolbar showing, a lock and an unlock. The
   * unlock gives the caret back and draws again the toolbar that was showing
   * -- now by its own decision (`#redrawToolbars`), not by the focus and the
   * `selectionchange` its write causes, which no longer draw anything. Real
   * focus: e2e.
   */
  test('RO6c2 a lock and an unlock under a caret in a cell draw its table toolbar again', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await editor.cell('tbl', 1, 1).click();
    const toolbar = editor.portal('table-toolbar');
    await expect(toolbar).toBeVisible();
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      ed.setEditable(false);
      ed.setEditable(true);
    });
    await editor.settle();
    await page.waitForTimeout(60);
    expect((await editor.selection())?.cell).toEqual({ row: 1, column: 1 });
    await expect(toolbar).toBeVisible();
  });

  /*
   * R12-RV2-KEY-3, r1's literal case: `?doc=long`, the caret at the end of the
   * fourth block, a lock, the reader scrolling away with the wheel, the
   * unlock. Putting the caret back revealed it: scrollY went 1231 -> 174, and
   * in an iframe mount the page around the frame jumped too. The caret is
   * put back where it was without scrolling anything; the next letter still
   * reaches it. Scrolling: e2e.
   */
  test('RO6d an unlock gives the caret back without scrolling to it', async ({ editor, page }) => {
    for (const mount of ['plain', 'iframe'] as const) {
      const mounted =
        mount === 'iframe' ? new EditorPage(page, 0, page.frameLocator('#frame')) : editor;
      await mounted.load({ doc: 'long', mount, scroll: mount === 'iframe' ? 1 : undefined });
      const id = (await mounted.doc()).blocks[3]!.id;
      const before = (await mounted.texts())[3];
      const block = mounted.content(id);
      await block.scrollIntoViewIfNeeded();
      await block.click();
      await page.keyboard.press('End');
      await page.evaluate(() => window.__e2e.editor.setEditable(false));

      const box = (await mounted.root.boundingBox())!;
      await page.mouse.move(box.x + 40, Math.max(box.y, 0) + 40);
      for (let i = 0; i < 6; i += 1) {
        await page.mouse.wheel(0, 500);
      }
      const scrolls = () =>
        page.evaluate(() => {
          const frame = document.querySelector<HTMLIFrameElement>('#frame');
          return [window.scrollY, frame?.contentWindow?.scrollY ?? 0];
        });
      // Settled: the wheel scrolls smoothly, and a read mid-animation is
      // not where the reader stopped.
      let away = await scrolls();
      for (;;) {
        await page.waitForTimeout(150);
        const now = await scrolls();
        if (now[0] === away[0] && now[1] === away[1]) break;
        away = now;
      }
      expect(away, mount).not.toEqual([0, 0]);

      await page.evaluate(() => window.__e2e.editor.setEditable(true));
      await page.waitForTimeout(100);
      expect(await scrolls(), mount).toEqual(away);
      await page.keyboard.type('Q');
      expect((await mounted.texts())[3], mount).toBe(`${before}Q`);
    }
  });

  /*
   * R12-RV2-KEY-2, r4's literal case: an iframe mount, a second same-origin
   * frame on the page with an input, the caret in the first block, a lock,
   * the reader clicking into the other frame's input, the unlock. The
   * editor's own document answers `<body>` whenever focus is outside its
   * frame, so the unlock took focus back from the other frame and "Q" was
   * typed into the block. Focus anywhere in any document around the frame
   * is the reader's. Focus across frames: e2e.
   */
  test('RO6e an unlock takes no focus back from another frame on the page', async ({ page }) => {
    const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
    await editor.load({ doc: 'paragraphs', mount: 'iframe' });
    await page.evaluate(async () => {
      const other = document.createElement('iframe');
      other.id = 'f2';
      other.srcdoc = '<input id=i2>';
      other.style.height = '40px';
      const loaded = new Promise((resolve) =>
        other.addEventListener('load', resolve, { once: true }),
      );
      document.body.prepend(other);
      await loaded;
    });
    const id = (await editor.doc()).blocks[0]!.id;
    const before = (await editor.texts())[0];
    await editor.content(id).click();
    await page.keyboard.press('End');
    await page.evaluate(() => window.__e2e.editor.setEditable(false));
    await page.frameLocator('#f2').locator('#i2').click();

    await page.evaluate(() => window.__e2e.editor.setEditable(true));
    await page.keyboard.type('Q');

    await expect(page.frameLocator('#f2').locator('#i2')).toHaveValue('Q');
    expect((await editor.texts())[0]).toBe(before);
  });

  /*
   * R12-RV3-KEY-2, n1b's literal case: the harness, with an iframe mount,
   * embedded in a page of another origin; the caret at the end of the first
   * block, a lock, a click into an input in the cross-origin top page, the
   * unlock, then "Q". The frames this script can climb stop at the harness,
   * so focus in the top page read as "on the page" and a press there spent
   * nothing: the unlock took the caret back and "Q" went into the block.
   * Past a cross-origin page the window's own focus decides. With no click,
   * the caret still comes back. Every engine loads the frame (Chromium with
   * its local-network checks off, launched here for that).
   */
  test('RO6f an unlock in a cross-origin embed takes no focus back from the top page', async ({
    playwright,
    browserName,
  }, testInfo) => {
    const base = String(testInfo.project.use.baseURL);
    const top = 'http://outer.test/outer.html';
    const browser = await playwright[browserName].launch({
      args:
        browserName === 'chromium'
          ? [
              '--disable-features=PrivateNetworkAccessForNavigations,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks,PrivateNetworkAccessForIframes',
            ]
          : [],
    });
    try {
      for (const how of ['click the top input', 'stay'] as const) {
        const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
        const page = await context.newPage();
        await page.route(top, (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><input id=topi><br><iframe id=h src="${base}/?doc=paragraphs&mount=iframe" style="width:1000px;height:700px"></iframe>`,
          }),
        );
        await page.goto(top);
        await expect.poll(() => page.frames().some((f) => /mount=iframe/.test(f.url()))).toBe(true);
        const harness = page.frames().find((f) => /mount=iframe/.test(f.url()))!;
        await harness.waitForFunction(() => window.__e2e?.ready === true);
        const text = () =>
          harness.evaluate(() =>
            window.__e2e.lib.blockText(window.__e2e.editor.getDocument().blocks[0]!),
          );
        const before = await text();
        await page
          .frameLocator('#h')
          .frameLocator('#frame')
          .locator('.neditor-block__content')
          .first()
          .click();
        await page.keyboard.press('End');

        await harness.evaluate(() => window.__e2e.editor.setEditable(false));
        if (how === 'click the top input') {
          await page.locator('#topi').click();
        }
        await harness.evaluate(() => window.__e2e.editor.setEditable(true));
        await page.keyboard.type('Q');

        if (how === 'click the top input') {
          await expect(page.locator('#topi'), how).toHaveValue('Q');
          expect(await text(), how).toBe(before);
        } else {
          expect(await text(), how).toBe(`${before}Q`);
        }
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });

  /*
   * R9-KEY-7. A read-only host is not focusable, so `focus(id)` left focus on
   * `<body>` and answered `true`. happy-dom focuses anything, which is why
   * this is pinned here.
   */
  test('RO7 focus() and focusRange() answer false, and focus stays where it was', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs', editable: false });
    const result = await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const id = ed.getDocument().blocks[0]!.id;
      return { focus: ed.focus(id), range: ed.focusRange(id, 0, 2) };
    });

    expect(result.focus).toBe(false);
    expect(result.range).toBe(false);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  });

  /*
   * R9-KEY-1 and -7 together, p12's case: a read-only block selection made
   * through the API, and a peer deleting its block. Trusting `focus()`, the
   * hand-back stopped at a caret that never landed -- the root focused with
   * nothing selected. With no block able to take a caret, the selection ends
   * and the root lets go of focus (round 10): selecting the block now in its
   * place was a guess at a block the reader never chose.
   */
  test('RO8 a read-only block selection a peer deletes ends, and focus leaves the editor', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty', editable: false });
    await page.evaluate(() =>
      window.__e2e.editor.setDocument({
        blocks: (
          [
            ['a', 'Block A'],
            ['b2', 'Block B'],
            ['c', 'Block C'],
          ] as const
        ).map(([id, text]) => ({ id, type: 'paragraph' as const, depth: 0, content: [{ text }] })),
      }),
    );
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['b2']));
    await expect(editor.root).toBeFocused();

    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const doc = ed.getDocument();
      doc.blocks.splice(1, 1);
      ed.setDocument(doc);
    });

    expect(await editor.selected()).toEqual([]);
    expect(await editor.hasFocus()).toBe(false);
    // Neither mode is never where it is left: no caret either.
    expect(await editor.selection()).toBeNull();
  });
});
