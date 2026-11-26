import { expect, MOD, test } from '../helpers/test.ts';
import { EditorPage } from '../helpers/editor.ts';

/** `n` words of a-z prefixes from a seeded generator: the probes' text, line for line. */
const seededWords = (n: number, seed: number): string => {
  let state = seed;
  const next = () => (state = (state * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: n }, () =>
    'abcdefghijklmnopqrstuvwxyz'.slice(0, 1 + Math.floor(next() * 11)),
  ).join(' ');
};

const cellText = async (editor: EditorPage, row: number, column: number) =>
  ((await editor.blockData('tbl'))?.rows?.[row]?.[column] ?? []).map((run) => run.text).join('');

/**
 * R10-PTR-1's shape, as the probe built it: a web component (`<x-pane>`)
 * whose shadow tree holds the scrolling pane -- 450px tall, 150px down the
 * page, a 120px head, the `<slot>`, a 1200px tail -- the way Ionic's
 * `<ion-content>` does. The editor's stage is slotted in, or for `'fixed
 * sheet'` a `position: fixed` sheet holding it is, with the shadow pane its
 * containing block (`transform`). Remounted, since the editor reads the
 * tree it is drawn in when it mounts, and given two paragraphs before the
 * table.
 */
const slottedPane = async (variant: 'slotted' | 'fixed sheet'): Promise<void> => {
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
};

const caretCell = async (editor: EditorPage) => {
  const state = await editor.selection();
  return state?.cell ? `${state.cell.row}:${state.cell.column}` : null;
};

/**
 * R8-PTR-1's two app shells, as the probe built them: a scrolling pane in
 * the top 40% of the window with a `position: fixed` bottom sheet declared
 * inside it holding the editor, and a page pane below a 300px header with
 * the modal `<dialog>` (the top layer) declared inside it. In both the
 * editor's own scroller (the sheet, `#scroller`, or the dialog) is not
 * clipped by the pane around it.
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
 * R9-PTR-1's shape, as the probe built it: a 400px scrolling pane 150px down
 * a page that scrolls, with `trigger` on it, and a 330px scrolling
 * `position: fixed` sheet at 180/180 declared in it, between fillers, holding
 * the editor, which gets three paragraphs before the table and 25 after it.
 * Where `trigger` makes the pane the sheet's containing block (a transform,
 * `will-change`, `filter`, `contain: paint`), the sheet scrolls with the pane.
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

test.describe('16 · tables', () => {
  test('TB1 Tab and Shift+Tab walk the cells; Tab past the last adds a row', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await editor.placeCaret('tbl', 0, 0, { row: 0, column: 0 });

    const visited = [await caretCell(editor)];
    for (let press = 0; press < 8; press += 1) {
      await page.keyboard.press('Tab');
      visited.push(await caretCell(editor));
    }
    expect(visited).toEqual(['0:0', '0:1', '0:2', '1:0', '1:1', '1:2', '2:0', '2:1', '2:2']);

    await page.keyboard.press('Shift+Tab');
    expect(await caretCell(editor)).toBe('2:1');
    await page.keyboard.press('Tab');

    await page.keyboard.press('Tab');
    expect((await editor.blockData('tbl'))?.rows).toHaveLength(4);
    expect(await caretCell(editor)).toBe('3:0');
    await expect(editor.liveRegion).toHaveText('Row added');
    await editor.type('new');
    expect(await cellText(editor, 3, 0)).toBe('new');
  });

  test('TB1b Shift+Tab from the first cell leaves the table without indenting it', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await editor.placeCaret('tbl', 0, 0, { row: 0, column: 0 });
    await page.keyboard.press('Shift+Tab');
    expect(await caretCell(editor)).toBeNull();
    expect((await editor.blockData('tbl'))?.depth).toBe(0);
  });

  test('TB2 Enter breaks the line inside a cell, and the cell grows', async ({ editor, page }) => {
    await editor.load({ doc: 'table' });
    await editor.placeCaret('tbl', 2, 2, { row: 1, column: 1 });
    const before = (await editor.cell('tbl', 1, 1).boundingBox())!.height;
    await page.keyboard.press('Enter');
    const after = (await editor.cell('tbl', 1, 1).boundingBox())!.height;
    expect(after).toBeGreaterThan(before * 1.5);
    await editor.type('x');
    expect(await cellText(editor, 1, 1)).toBe('a2\nx');
    expect((await editor.doc()).blocks).toHaveLength(3);
  });

  /*
   * R10-PTR-3 / R10-KEY-4. Enter in a cell writes the line break into the
   * model and places the caret itself, and that placement revealed the whole
   * cell: in a cell taller than the window `block: 'nearest'` does nothing
   * once the cell covers it, so Enter on the window's last line left the new
   * line at or below its bottom edge; with the cell's top on screen it lined
   * that top up instead and scrolled the page by the cell's offset. The
   * caret's own line is revealed, the least way. The probe: 60 lines in
   * cell 1:0, its top 300px above the window or 100px down it, Enter at the
   * end of the last line wholly in the window. Layout and scrolling: e2e.
   */
  test('TB2b Enter on the window’s last line of a tall cell shows the new line and nothing more', async ({
    editor,
    page,
  }) => {
    for (const where of ['top above', 'top on screen'] as const) {
      await editor.load({ doc: 'table' });
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks.find((block) => block.id === 'tbl')!.rows![1]![0] = [
          { text: Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') },
        ];
        ed.setDocument(doc);
      });
      const cell = editor.cell('tbl', 1, 0);
      await cell.evaluate((element, where) => {
        const top = element.getBoundingClientRect().top;
        window.scrollBy(0, where === 'top above' ? top + 300 : top - 100);
      }, where);
      await editor.settleScroll();
      const end = await cell.evaluate((element) => {
        const text = element.firstChild as Text;
        const range = document.createRange();
        let last = -1;
        for (let i = 0; i < 59; i++) {
          const at = text.data.indexOf(`line ${i}\n`);
          range.setStart(text, at);
          range.setEnd(text, at + 1);
          if (range.getBoundingClientRect().bottom <= innerHeight - 2) {
            last = at + `line ${i}`.length;
          }
        }
        return last;
      });
      const point = await editor.pointAt(cell, end);
      await page.mouse.click(point.x + 1, point.y);
      await editor.settle();
      const before = await page.evaluate(() => window.scrollY);

      await page.keyboard.press('Enter');
      await editor.settleScroll();
      expect(await cellText(editor, 1, 0), where).toContain(`\n\n`);
      const line = await cell.evaluate((element, at) => {
        const range = document.createRange();
        range.setStart(element.firstChild!, at);
        range.setEnd(element.firstChild!, at + 1);
        const box = range.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom };
      }, end + 1);
      const height = page.viewportSize()!.height;
      expect(line.top, `${where}: the new line is on screen`).toBeGreaterThanOrEqual(0);
      expect(line.bottom, `${where}: the new line is on screen`).toBeLessThanOrEqual(height);
      expect(
        Math.abs((await page.evaluate(() => window.scrollY)) - before),
        `${where}: the page moved no more than a line`,
      ).toBeLessThan(30);
      const toolbar = editor.portal('table-toolbar');
      await expect(toolbar, where).toBeVisible();
      const bar = (await toolbar.boundingBox())!;
      expect(
        bar.y + bar.height <= line.top + 1 || bar.y >= line.bottom - 1,
        `${where}: the toolbar leaves the new line clear`,
      ).toBe(true);
    }
  });

  test('TB3 Up/Down move between rows and leave the table at its edges; Backspace at a cell start is swallowed', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await editor.placeCaret('tbl', 0, 0, { row: 1, column: 2 });
    await page.keyboard.press('ArrowUp');
    expect(await caretCell(editor)).toBe('0:2');
    // (Not Home: on macOS WebKit and Firefox follow the platform, where Home does not move the caret.)
    await editor.placeCaret('tbl', 0, 0, { row: 0, column: 2 });
    await page.keyboard.press('ArrowUp');
    expect((await editor.selection())?.blockId).toBe('before');

    await editor.placeCaret('tbl', 2, 2, { row: 2, column: 0 });
    await page.keyboard.press('ArrowDown');
    expect((await editor.selection())?.blockId).toBe('after');

    await editor.placeCaret('tbl', 0, 0, { row: 1, column: 1 });
    await page.keyboard.press('Backspace');
    expect(await cellText(editor, 1, 1)).toBe('a2');
    expect(await cellText(editor, 1, 0)).toBe('a1');
    expect(await caretCell(editor)).toBe('1:1');
  });

  const COMMANDS: Array<
    [name: string, announce: string, rows: number, columns: number, focus: string]
  > = [
    ['Insert row above', 'Row inserted above', 4, 3, '2:1'],
    ['Insert row below', 'Row inserted below', 4, 3, '1:1'],
    ['Delete this row', 'Row deleted', 2, 3, '1:1'],
    ['Insert column left', 'Column inserted left', 3, 4, '1:2'],
    ['Insert column right', 'Column inserted right', 3, 4, '1:1'],
    ['Delete this column', 'Column deleted', 3, 2, '1:1'],
  ];

  for (const [name, announce, rows, columns, focus] of COMMANDS) {
    test(`TB4 "${name}" from the table toolbar`, async ({ editor }) => {
      await editor.load({ doc: 'table' });
      await editor.placeCaret('tbl', 0, 0, { row: 1, column: 1 });
      const toolbar = editor.portal('table-toolbar');
      await expect(toolbar).toBeVisible();
      const bar = (await toolbar.boundingBox())!;
      const table = (await editor.block('tbl').boundingBox())!;
      expect(bar.y + bar.height).toBeLessThanOrEqual(table.y + 1);

      await toolbar.getByRole('button', { name }).click();
      const grid = (await editor.blockData('tbl'))!.rows!;
      expect(grid).toHaveLength(rows);
      expect(grid[0]).toHaveLength(columns);
      await expect(editor.liveRegion).toHaveText(announce);
      expect(await caretCell(editor)).toBe(focus);
    });
  }

  test('TB5 F10 enters the toolbar; arrows and Home/End rove; Escape returns to the cell', async ({
    editor,
    page,
  }) => {
    // Was FINDING F13, fixed; see docs/e2e-progress.md.
    await editor.load({ doc: 'table' });
    await editor.placeCaret('tbl', 1, 1, { row: 2, column: 2 });
    // The toolbar follows the asynchronous selectionchange. F10 draws it for
    // its own cell in any case (TB5b); here it is waited for the way a person
    // would see it.
    await expect(editor.portal('table-toolbar')).toBeVisible();
    const buttons = editor.portal('table-toolbar').getByRole('button');
    await page.keyboard.press('F10');
    await expect(buttons.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(buttons.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft'); // wraps
    await expect(buttons.nth(5)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(buttons.nth(0)).toBeFocused();
    await page.keyboard.press('End');
    await expect(buttons.nth(5)).toBeFocused();
    await page.keyboard.press('Escape');
    expect(await caretCell(editor)).toBe('2:2');
    await expect(editor.cell('tbl', 2, 2)).toBeFocused();
  });

  // e2e only: the order WebKit runs focusin and the selection move in, and
  // the format toolbar drawn for a real range, are not in happy-dom.
  test('TB5b F10 reaches the toolbar straight after Tab, and with a range in the cell', async ({
    editor,
    page,
  }) => {
    // Was R4-PTR-2: a range in the cell draws the format toolbar, which keeps
    // the table toolbar hidden, so F10 focused a hidden button and the key was
    // swallowed with focus left in the cell -- after every Tab in WebKit (its
    // whole-cell selection, and a focusin before the caret moved), and with a
    // Shift+arrow range in Chromium.
    const buttons = editor.portal('table-toolbar').getByRole('button');

    // R5-PTR-2: the Tab lands in a cell whose text is long enough that its
    // whole-cell selection draws the format toolbar. Into the fixture's
    // two-character cells it drew none, so this passed with the format
    // toolbar's F10 guard (`#syncToolbar`) removed.
    for (let i = 0; i < 3; i++) {
      await editor.load({ doc: 'table' });
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks.find((block) => block.id === 'tbl')!.rows![1]![1] = [
          { text: 'alpha bravo charlie' },
        ];
        ed.setDocument(doc);
      });
      await editor.cell('tbl', 1, 0).click();
      await page.keyboard.press('Tab');
      await page.keyboard.press('F10');
      await expect(buttons.nth(0), `after Tab, try ${i + 1}`).toBeFocused();
      // Waited out, not polled: the late selectionchange is what draws it.
      await editor.settle();
      await expect(editor.portal('toolbar')).toBeHidden();
      await page.keyboard.press('Escape');
      await expect(editor.cell('tbl', 1, 1)).toBeFocused();
    }

    await editor.load({ doc: 'table' });
    await editor.cell('tbl', 1, 1).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+ArrowLeft');
    await expect(editor.portal('toolbar')).toBeVisible();
    await page.keyboard.press('F10');
    await expect(buttons.nth(0)).toBeFocused();
    await expect(editor.portal('toolbar')).toBeHidden();
    // And the command acts on the cell F10 came from.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    expect((await editor.blockData('tbl'))?.rows).toHaveLength(4);
  });

  /*
   * R5-PTR-4. Escape from the toolbar put the caret at the cell's end,
   * losing a caret at 3, a range 6-11 and a backward one. The probe's three
   * selections; the backward one is checked by growing it with another
   * Shift+←, which only grows a range whose focus is at its start.
   */
  test('TB5c Escape from the table toolbar puts back the selection F10 left', async ({
    editor,
    page,
  }) => {
    for (const mode of ['caret at 3', 'range 6-11', 'backward range 11-6'] as const) {
      await editor.load({ doc: 'table' });
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks.find((block) => block.id === 'tbl')!.rows![1]![1] = [
          { text: 'alpha bravo charlie' },
        ];
        ed.setDocument(doc);
      });
      const at = mode === 'caret at 3' ? 3 : mode === 'range 6-11' ? 6 : 11;
      const point = await editor.pointAt(editor.cell('tbl', 1, 1), at);
      await page.mouse.click(point.x, point.y);
      for (let i = 0; i < (mode === 'caret at 3' ? 0 : 5); i++) {
        await page.keyboard.press(mode === 'range 6-11' ? 'Shift+ArrowRight' : 'Shift+ArrowLeft');
      }
      const before = (await editor.selection())?.range;
      expect(before, `${mode} precondition`).toEqual(
        mode === 'caret at 3' ? { start: 3, end: 3 } : { start: 6, end: 11 },
      );

      await page.keyboard.press('F10');
      await expect(editor.portal('table-toolbar').getByRole('button').nth(0)).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(editor.cell('tbl', 1, 1), mode).toBeFocused();
      expect((await editor.selection())?.range, mode).toEqual(before);

      if (mode === 'backward range 11-6') {
        await page.keyboard.press('Shift+ArrowLeft');
        expect((await editor.selection())?.range, 'the focus is still at the start').toEqual({
          start: 5,
          end: 11,
        });
      }
    }
  });

  /*
   * R6-KEY-2, under R7-PTR-4's rule. In a shadow mount with the portals in
   * the body, the focus Escape hands back to the cell reaches the toolbar's
   * focusout retargeted to the shadow host, which hides the toolbars; the
   * cell's own focusin draws them again (round 6's guard for the host as a
   * target changed nothing any input could see, and is gone). With a caret
   * handed back the table toolbar is drawn for it; with a range the format
   * toolbar is, and
   * the table toolbar is not -- one toolbar for a range in every engine, F10
   * being the keyboard's way to the other. The probe's literal scenario: cell
   * 1:0 reading "alpha beta gamma", caret at 11, Shift+← ×3. Focus
   * retargeting across a real shadow boundary: e2e only.
   */
  test('TB5g Escape from the table toolbar in a shadow mount with portals in the body draws the toolbar for what it hands back', async ({
    editor,
    page,
  }) => {
    for (const mode of ['range', 'caret'] as const) {
      await editor.load({ doc: 'table', mount: 'shadow', portal: 'body' });
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks.find((block) => block.id === 'tbl')!.rows![1]![0] = [
          { text: 'alpha beta gamma' },
        ];
        ed.setDocument(doc);
      });
      const point = await editor.pointAt(editor.cell('tbl', 1, 0), 11);
      await page.mouse.click(point.x, point.y);
      if (mode === 'range') {
        for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft');
      }
      const range = mode === 'range' ? { start: 8, end: 11 } : { start: 11, end: 11 };
      expect((await editor.selection())?.range, mode).toEqual(range);

      await page.keyboard.press('F10');
      await expect(editor.portal('table-toolbar').getByRole('button').nth(0), mode).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(editor.cell('tbl', 1, 0), mode).toBeFocused();
      expect((await editor.selection())?.range, mode).toEqual(range);
      await editor.settle();
      if (mode === 'range') {
        await expect(editor.portal('toolbar'), mode).toBeVisible();
        await expect(editor.portal('table-toolbar'), mode).toBeHidden();
      } else {
        await expect(editor.portal('table-toolbar'), mode).toBeVisible();
        await expect(editor.portal('toolbar'), mode).toBeHidden();
      }
    }
  });

  /*
   * R7-PTR-4. With a range in a cell, Firefox and WebKit drew both toolbars
   * and Chromium only the format toolbar, by the order of the selection
   * events a gesture fires. The code's own rule decides in every engine: the
   * format toolbar for a range, the table toolbar for a caret. And a scroll
   * away and back brings neither back for a range, as in any paragraph (the
   * table toolbar used to return in its place). The probe's three gestures
   * over "alpha" in cell 1:1. Real selection gestures: e2e.
   */
  test('TB5j a range in a cell draws the format toolbar and not the table toolbar', async ({
    editor,
    page,
  }) => {
    for (const how of ['drag', 'Shift+arrows', 'double-click'] as const) {
      await editor.load({ doc: 'table', scroll: 1 });
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks.find((block) => block.id === 'tbl')!.rows![1]![1] = [{ text: 'alpha beta' }];
        ed.setDocument(doc);
      });
      const cell = editor.cell('tbl', 1, 1);
      await cell.scrollIntoViewIfNeeded();
      await editor.settleScroll();
      const from = await editor.pointAt(cell, 0);
      const to = await editor.pointAt(cell, 5);
      if (how === 'drag') {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 5 });
        await page.mouse.up();
      } else if (how === 'Shift+arrows') {
        await page.mouse.click(from.x, from.y);
        for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight');
      } else {
        await page.mouse.dblclick(from.x + 6, from.y);
      }
      await editor.settle();
      expect((await editor.selection())?.range, how).toEqual({ start: 0, end: 5 });
      await expect(editor.portal('toolbar'), how).toBeVisible();
      await expect(editor.portal('table-toolbar'), how).toBeHidden();

      await page.mouse.move(600, 400);
      await page.mouse.wheel(0, 900);
      await editor.settleScroll();
      await page.mouse.wheel(0, -900);
      await editor.settleScroll();
      await expect(editor.portal('table-toolbar'), `${how}: back`).toBeHidden();
    }
  });

  /*
   * R7-KEY-1. Round 6's `setDocument` handed focus back from the table
   * toolbar to the cell with F10's range selected, so the Space or Enter
   * meant for a toolbar button typed over "beta". The toolbar closes and
   * takes the key with it: nothing reaches the cell, and no `change` goes
   * out. WebKit typed the key into the range left in the cell even with
   * focus on `<body>`, so that range goes too. The probe's scenario: Shift+→
   * ×4 from 6 in cell 0:0, F10, → to the next button, the update, the key.
   * Real keys after a real focus move: e2e.
   */
  test('TB5h a key meant for the table toolbar a host’s setDocument closed never reaches the cell', async ({
    editor,
    page,
  }) => {
    for (const key of ['Space', 'Enter'] as const) {
      await editor.load({ doc: 'empty' });
      await page.evaluate(() => {
        const t = (text: string) => [{ text }];
        const ed = window.__e2e.editor;
        ed.setDocument({
          blocks: [
            { id: 'p', type: 'paragraph', depth: 0, content: t('Read the documentation first') },
            {
              id: 'tbl',
              type: 'table',
              depth: 0,
              content: [],
              rows: [
                [t('alpha beta gamma'), t('x')],
                [t('r2'), t('y')],
              ],
            },
          ],
        });
        ed.clearHistory();
      });
      const point = await editor.pointAt(editor.cell('tbl', 0, 0), 6);
      await page.mouse.click(point.x, point.y);
      for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight');
      await page.keyboard.press('F10');
      const buttons = editor.portal('table-toolbar').getByRole('button');
      await expect(buttons.nth(0), key).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(buttons.nth(1), key).toBeFocused();

      const before = await editor.doc();
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        ed.setDocument(ed.getDocument());
      });
      await editor.clearLog();
      await page.keyboard.press(key);
      await editor.settle();

      expect(await editor.hasFocus(), key).toBe(false);
      expect(await editor.doc(), key).toEqual(before);
      expect(await editor.events('change'), key).toEqual([]);
    }
  });

  /*
   * R11-KEY-1, p15's literal case (WebKit). As TB5h, but the cell holds
   * formatted text -- `a `, bold `b`, ` c `, italic `d`, ` e` -- with the
   * caret at its end, F10, and a peer rewriting that cell as "peer text".
   * WebKit's selection kept a stale offset in the cell, and reading it after
   * the render wrote it back, which focused the cell: the toolbar's Space and
   * "q" were typed there ("peer text q"), and with the cell holding focus the
   * selection the panel left was never taken out. A plain cell has no stale
   * offset and was already right; both are pinned.
   */
  test('TB5h2 a peer rewriting a formatted cell under F10 pulls no focus into it', async ({
    editor,
    page,
  }) => {
    type Run = { text: string; marks?: ('bold' | 'italic')[] };
    const cases: [string, Run[]][] = [
      ['plain', [{ text: 'Hello there' }]],
      [
        'formatted',
        [
          { text: 'a ' },
          { text: 'b', marks: ['bold'] },
          { text: ' c ' },
          { text: 'd', marks: ['italic'] },
          { text: ' e' },
        ],
      ],
    ];
    for (const [label, cell] of cases) {
      await editor.load({ doc: 'empty' });
      await page.evaluate((cell) => {
        window.__e2e.editor.setDocument({
          blocks: [
            { id: 'p', type: 'paragraph', depth: 0, content: [{ text: 'Prev' }] },
            {
              id: 't',
              type: 'table',
              depth: 0,
              content: [],
              rows: [
                [cell, [{ text: 'B' }]],
                [[{ text: 'c' }], [{ text: 'd' }]],
              ],
            },
          ],
        });
      }, cell);
      const box = (await editor.cell('t', 0, 0).boundingBox())!;
      await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
      await page.keyboard.press('F10');
      await expect(editor.portal('table-toolbar').getByRole('button').nth(0), label).toBeFocused();

      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks[1]!.rows![0]![0] = [{ text: 'peer text' }];
        ed.setDocument(doc);
      });
      expect(await editor.hasFocus(), label).toBe(false);

      await page.keyboard.press('Space');
      await page.keyboard.type('q');
      const rows = (await editor.blockData('t'))!.rows!.map((row) =>
        row.map((runs) => runs.map((run) => run.text).join('')),
      );
      expect(rows, label).toEqual([
        ['peer text', 'B'],
        ['c', 'd'],
      ]);
    }
  });

  /*
   * R11-RV-KEY-3, q9's literal case (WebKit), in each mount: the caret at the
   * end of cell 1:0 of the table document, F10, a peer's `setDocument`
   * editing the last block, and Backspace. Hidden, the toolbar's button kept
   * focus -- zero-size, invisible -- and the Backspace went back in history.
   * The button is blurred and the guard armed: the page stays, and neither
   * that Backspace nor the next reaches the document. Navigation: e2e.
   *
   * R12-KEY-1, p3's literal case: an iframe mount whose `portalContainer` is
   * the page around the frame. Closed, the toolbar left focus on *that*
   * page's <body>, which the guard -- judged and listened for in the frame's
   * own document -- never heard, and the first Backspace went Back.
   */
  test('TB5h3 a Backspace after a peer’s update closed the F10 toolbar does not leave the page', async ({
    editor,
    page,
  }) => {
    for (const [mount, portal] of [
      ['plain', undefined],
      ['shadow', undefined],
      ['iframe', undefined],
      ['iframe', 'body'],
    ] as const) {
      const label = portal ? `${mount}, portal=${portal}` : mount;
      const mounted =
        mount === 'iframe' ? new EditorPage(page, 0, page.frameLocator('#frame')) : editor;
      await page.goto('about:blank');
      await mounted.load({ doc: 'table', mount, portal });
      const url = page.url();
      const box = (await mounted.cell('tbl', 1, 0).boundingBox())!;
      await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
      await page.keyboard.press('F10');
      const toolbar = portal
        ? page.locator('.neditor-portal.neditor-table-toolbar')
        : mounted.portal('table-toolbar');
      await expect(toolbar.getByRole('button').nth(0), label).toBeFocused();
      const before = await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks[doc.blocks.length - 1]!.content = [{ text: 'peer' }];
        ed.setDocument(doc);
        return ed.getDocument();
      });

      await page.keyboard.press('Backspace');
      await page.waitForTimeout(300);
      expect(page.url(), label).toBe(url);
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(300);
      expect(page.url(), label).toBe(url);
      expect(await mounted.doc(), label).toEqual(before);
    }
  });

  /*
   * R12-KEY-7, p10's same-cell case: the caret at the end of "a1" in cell
   * 1:0, and a peer rewriting that cell as "a1!". The redraw dropped the
   * caret to the cell's start and "XY" made "XYa1!". The text before the
   * caret is unchanged, so it keeps its offset. Typing: e2e.
   */
  test('TB5h4 a peer rewriting the cell the caret is in keeps the caret in place', async ({
    editor,
    page,
  }) => {
    for (const mount of ['plain', 'shadow', 'iframe'] as const) {
      const mounted =
        mount === 'iframe' ? new EditorPage(page, 0, page.frameLocator('#frame')) : editor;
      await mounted.load({ doc: 'table', mount });
      const box = (await mounted.cell('tbl', 1, 0).boundingBox())!;
      await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
      await page.keyboard.press('End');
      const cell = await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        const table = doc.blocks.find((block) => block.id === 'tbl')!;
        const text = table.rows![1]![0]!.map((run) => run.text).join('');
        table.rows![1]![0] = [{ text: `${text}!` }];
        ed.setDocument(doc, { silent: true });
        return text;
      });
      await page.keyboard.type('XY');
      const rows = (await mounted.blockData('tbl'))!.rows!;
      expect(rows[1]![0]!.map((run) => run.text).join(''), mount).toBe(`${cell}XY!`);
    }
  });

  /*
   * R7-KEY-4. `setDocument` hid the table toolbar with the panels, and with
   * the caret still in the cell nothing drew it again until the selection
   * moved; a cell scrolled away lost the note that brings it back with the
   * scroll. The probe's two cases: the caret at 4 in cell 0:0 and the same
   * document reloaded, then scrolled away, reloaded and scrolled back.
   * Layout and wheel scrolling: e2e.
   */
  test('TB5i the caret’s table toolbar survives a host’s setDocument, scrolled away or not', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await page.evaluate(() => {
      const t = (text: string) => [{ text }];
      const ed = window.__e2e.editor;
      ed.setDocument({
        blocks: [
          { id: 'p', type: 'paragraph', depth: 0, content: t('para') },
          { id: 'tbl', type: 'table', depth: 0, content: [], rows: [[t('alpha beta'), t('x')]] },
          ...Array.from({ length: 40 }, (_, i) => ({
            id: `f${i}`,
            type: 'paragraph' as const,
            depth: 0,
            content: t(`filler ${i}`),
          })),
        ],
      });
      ed.clearHistory();
    });
    const cell = editor.cell('tbl', 0, 0);
    const point = await editor.pointAt(cell, 4);
    await page.mouse.click(point.x, point.y);
    const toolbar = editor.portal('table-toolbar');
    await expect(toolbar).toBeVisible();
    const reload = () =>
      page.evaluate(() => {
        const ed = window.__e2e.editor;
        ed.setDocument(ed.getDocument());
      });

    await reload();
    await expect(toolbar, 'reloaded').toBeVisible();
    await expect(cell).toBeFocused();

    await page.mouse.move(600, 400);
    await page.mouse.wheel(0, 800);
    await editor.settleScroll();
    await expect(toolbar, 'scrolled away').toBeHidden();
    await reload();
    await page.mouse.wheel(0, -800);
    await editor.settleScroll();
    await expect(toolbar, 'reloaded away, scrolled back').toBeVisible();
    await expect(cell).toBeFocused();
  });

  /*
   * R7-PTR-2. "On screen" asked only the nearest scroller, so with the
   * editor's own scroller inside another one, the outer scroll took the cell
   * out of sight and the table toolbar stayed drawn over the host page above
   * it. The probe's ground: the editor in a 600px scroller inside a 320px
   * one, the caret in cell 1:1, the outer one wheeled until the cell is gone.
   * Nested layout and real wheel scrolling: e2e.
   */
  test('TB5k the caret’s table toolbar leaves with its cell when an outer scroller hides it', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const doc = ed.getDocument();
      const para = (id: string, text: string) => ({
        id,
        type: 'paragraph' as const,
        depth: 0,
        content: [{ text }],
      });
      doc.blocks = [
        ...Array.from({ length: 4 }, (_, i) => para(`h${i}`, `Head ${i}`)),
        ...doc.blocks,
        ...Array.from({ length: 30 }, (_, i) => para(`z${i}`, `Tail ${i}`)),
      ];
      ed.setDocument(doc);
      const outer = document.createElement('div');
      outer.id = 'outer';
      outer.style.cssText = 'height:320px; overflow:auto; margin-top:250px; display:flex; gap:8px';
      const inner = document.createElement('div');
      inner.style.cssText = 'height:600px; overflow:auto; flex: 1 1 auto';
      const side = document.createElement('div');
      side.id = 'side';
      side.style.cssText = 'height:1500px; width:150px; flex: none';
      document.querySelector('#stage')!.prepend(outer);
      outer.append(inner, side);
      inner.append(ed.element);
    });
    const cell = editor.cell('tbl', 1, 1);
    const point = await editor.pointAt(cell, 1);
    await page.mouse.click(point.x, point.y);
    const toolbar = editor.portal('table-toolbar');
    await expect(toolbar).toBeVisible();

    const side = (await page.locator('#side').boundingBox())!;
    await page.mouse.move(side.x + 50, 400);
    const hidden = () =>
      cell.evaluate((element) => {
        const clip = document.querySelector('#outer')!.getBoundingClientRect();
        return element.getBoundingClientRect().bottom <= clip.top;
      });
    for (let i = 0; i < 12 && !(await hidden()); i++) {
      await page.mouse.wheel(0, 60);
      await editor.settleScroll();
    }
    expect(await hidden(), 'precondition: the outer scroller hid the cell').toBe(true);
    await expect(toolbar).toBeHidden();
    await expect(cell).toBeFocused();
  });

  /*
   * R7-PTR-3. F10 with the caret's cell already scrolled out of what scrolls
   * it drew the toolbar at the window's clamp and moved focus into it there:
   * over the page above an inner scroller, outside a dialog. The cell comes
   * back first, to the middle of the scroller, and the toolbar is drawn
   * against its table -- inside the dialog. (Above a table at the very top of
   * an inner scroller it is drawn over the page there, as it is for a click:
   * the table anchor, not this path.) The
   * probes' two grounds: a 300px root scroller below the page's top, and a
   * modal dialog with a 320px scroll area. Layout: e2e.
   */
  test('TB5l F10 with the caret’s cell scrolled out of sight brings the cell back first', async ({
    editor,
    page,
  }) => {
    for (const ground of ['inner scroller', 'dialog'] as const) {
      await editor.load({ doc: 'table', ...(ground === 'dialog' ? { mount: 'dialog' } : {}) });
      await page.evaluate((ground) => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks.push(
          ...Array.from({ length: 40 }, (_, i) => ({
            id: `z${i}`,
            type: 'paragraph' as const,
            depth: 0,
            content: [{ text: `Tail ${i}` }],
          })),
        );
        ed.setDocument(doc);
        if (ground === 'dialog') {
          const dialog = document.querySelector<HTMLElement>('#dialog')!;
          dialog.style.maxHeight = '320px';
          dialog.style.overflow = 'auto';
        } else {
          ed.element.style.height = '300px';
          ed.element.style.overflow = 'auto';
          document.querySelector<HTMLElement>('#stage')!.style.marginTop = '250px';
        }
      }, ground);
      const scroller = page.locator(ground === 'dialog' ? '#dialog' : '#editor');
      const cell = editor.cell('tbl', 1, 1);
      await cell.scrollIntoViewIfNeeded();
      await editor.settleScroll();
      const point = await editor.pointAt(cell, 1);
      await page.mouse.click(point.x, point.y);
      await page.mouse.wheel(0, 400);
      await editor.settleScroll();
      const clip = (await scroller.boundingBox())!;
      expect((await cell.boundingBox())!.y + 30, `${ground}: precondition`).toBeLessThan(clip.y);
      await expect(editor.portal('table-toolbar'), ground).toBeHidden();

      await page.keyboard.press('F10');
      const toolbar = editor.portal('table-toolbar');
      await expect(toolbar.getByRole('button').nth(0), ground).toBeFocused();
      await editor.settleScroll();
      const box = (await cell.boundingBox())!;
      const bar = (await toolbar.boundingBox())!;
      expect(box.y, `${ground}: the cell is back`).toBeGreaterThanOrEqual(clip.y);
      expect(box.y + box.height, `${ground}: the cell is back`).toBeLessThanOrEqual(
        clip.y + clip.height,
      );
      // Drawn against its table, above or below it, not at the clamp.
      const table = (await editor.block('tbl').boundingBox())!;
      expect(
        Math.abs(bar.y + bar.height - table.y) < 16 ||
          Math.abs(bar.y - (table.y + table.height)) < 16,
        ground,
      ).toBe(true);
      if (ground === 'dialog') {
        expect(bar.y, 'inside the dialog').toBeGreaterThanOrEqual(clip.y);
      }
    }
  });

  /*
   * R8-PTR-1. "On screen" clipped by every scroller around the editor,
   * including ones that do not clip it -- the pane behind a fixed sheet, the
   * pane behind a modal dialog -- so a caret in a cell plainly on screen read
   * as scrolled away and the table toolbar never showed. The probe's two
   * shells, the caret clicked into cell 0:1. Layout: e2e.
   */
  test('TB5m the caret’s table toolbar shows in a fixed sheet or a modal dialog inside a scrolling pane', async ({
    editor,
    page,
  }) => {
    for (const shell of ['fixed sheet', 'modal dialog'] as const) {
      await editor.load({ doc: 'table', ...(shell === 'modal dialog' ? { mount: 'dialog' } : {}) });
      await page.evaluate(appShell, shell);
      await editor.settle();
      const cell = editor.cell('tbl', 0, 1);
      const point = await editor.pointAt(cell, 1);
      await page.mouse.click(point.x, point.y);
      await editor.settle();

      await expect(cell, shell).toBeFocused();
      await expect(editor.portal('table-toolbar'), shell).toBeVisible();
    }
  });

  /*
   * R8-PTR-2. F10 brought a scrolled-away cell back with
   * `scrollIntoView({ block: 'center' })`, which centres in every ancestor:
   * the page jumped, and the page around an iframe, though the scroller was
   * wholly on screen. The probe: a 320px root scroller (or a 420px frame)
   * in a page scrolled to 920, the caret in cell 1:1 wheeled out of it.
   * The cell is centred in its own scroller and nothing else moves.
   * Layout and scrolling: e2e.
   */
  test('TB5n F10 centres the cell in its own scroller and leaves the page where it was', async ({
    editor: plain,
    page,
  }) => {
    for (const ground of ['inner scroller', 'iframe'] as const) {
      const editor =
        ground === 'iframe' ? new EditorPage(page, 0, page.frameLocator('#frame')) : plain;
      await editor.load({ doc: 'table', ...(ground === 'iframe' ? { mount: 'iframe' } : {}) });
      await page.evaluate((ground) => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        const para = (id: string, text: string) => ({
          id,
          type: 'paragraph' as const,
          depth: 0,
          content: [{ text }],
        });
        doc.blocks = [
          ...Array.from({ length: 8 }, (_, i) => para(`h${i}`, `Head ${i}`)),
          ...doc.blocks,
          ...Array.from({ length: 30 }, (_, i) => para(`z${i}`, `Tail paragraph ${i}`)),
        ];
        ed.setDocument(doc);
        document.querySelector<HTMLElement>('#stage')!.style.margin = '1000px 0 1500px';
        if (ground === 'iframe') {
          document.querySelector<HTMLElement>('#frame')!.style.height = '420px';
        } else {
          Object.assign(ed.element.style, {
            height: '320px',
            overflow: 'auto',
            border: '2px solid red',
          });
        }
        window.scrollTo(0, 920);
      }, ground);
      await editor.settleScroll();
      const scroller = page.locator(ground === 'iframe' ? '#frame' : '#editor');
      const cell = editor.cell('tbl', 1, 1);
      // The cell 60px below the scroller's top, clicked, then wheeled away.
      await cell.evaluate((element, ground) => {
        const doc = element.ownerDocument;
        const box = ground === 'iframe' ? doc.scrollingElement! : doc.querySelector('#editor')!;
        const top = ground === 'iframe' ? 0 : box.getBoundingClientRect().top;
        box.scrollTop += element.getBoundingClientRect().top - top - 60;
      }, ground);
      await editor.settleScroll();
      const point = await editor.pointAt(cell, 1);
      await page.mouse.click(point.x, point.y);
      const clip = (await scroller.boundingBox())!;
      await page.mouse.move(clip.x + 200, clip.y + 100);
      await page.mouse.wheel(0, 500);
      await editor.settleScroll();
      expect((await cell.boundingBox())!.y + 36, `${ground}: precondition`).toBeLessThan(clip.y);
      const pageY = await page.evaluate(() => window.scrollY);

      await page.keyboard.press('F10');
      const toolbar = editor.portal('table-toolbar');
      await expect(toolbar.getByRole('button').nth(0), ground).toBeFocused();
      await editor.settleScroll();

      expect(await page.evaluate(() => window.scrollY), `${ground}: the page stays`).toBe(pageY);
      const box = (await cell.boundingBox())!;
      expect(
        Math.abs(box.y + box.height / 2 - (clip.y + clip.height / 2)),
        `${ground}: centred in its scroller`,
      ).toBeLessThan(8);
    }
  });

  /*
   * R8-PTR-3. A cell with only a sliver on screen counted as on screen, so
   * F10 took the nearest-edge reveal and drew the toolbar outside the
   * scroller or the dialog around it. The probe's "partial-top": the cell
   * scrolled up until 6px of it show under the scroller's top edge. Only
   * the whole cell on screen skips the centring. Layout: e2e.
   */
  test('TB5o F10 with only a sliver of the cell showing centres it, toolbar inside the scroller', async ({
    editor,
    page,
  }) => {
    for (const ground of ['inner scroller', 'dialog'] as const) {
      await editor.load({ doc: 'table', ...(ground === 'dialog' ? { mount: 'dialog' } : {}) });
      await page.evaluate((ground) => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        const para = (id: string, text: string) => ({
          id,
          type: 'paragraph' as const,
          depth: 0,
          content: [{ text }],
        });
        doc.blocks = [
          ...Array.from({ length: 8 }, (_, i) => para(`h${i}`, `Head ${i}`)),
          ...doc.blocks,
          ...Array.from({ length: 30 }, (_, i) => para(`z${i}`, `Tail paragraph ${i}`)),
        ];
        ed.setDocument(doc);
        if (ground === 'dialog') {
          const dialog = document.querySelector<HTMLElement>('#dialog')!;
          dialog.style.maxHeight = '400px';
          dialog.style.overflow = 'auto';
        } else {
          Object.assign(ed.element.style, {
            height: '320px',
            overflow: 'auto',
            border: '2px solid red',
          });
          document.querySelector<HTMLElement>('#stage')!.style.margin = '220px 0 1500px';
        }
      }, ground);
      const scroller = page.locator(ground === 'dialog' ? '#dialog' : '#editor');
      const cell = editor.cell('tbl', 1, 1);
      await cell.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      await editor.settleScroll();
      const point = await editor.pointAt(cell, 1);
      await page.mouse.click(point.x, point.y);
      await editor.settle();
      await scroller.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const target = document
          .querySelector('[data-block-id="tbl"] [data-cell="1:1"]')!
          .getBoundingClientRect();
        element.scrollTop += target.bottom - (box.top + element.clientTop + 6);
      });
      await editor.settleScroll();
      const clip = (await scroller.boundingBox())!;
      const before = (await cell.boundingBox())!;
      expect(before.y, `${ground}: precondition, cut by the top edge`).toBeLessThan(clip.y);
      expect(before.y + before.height, `${ground}: precondition, a sliver`).toBeGreaterThan(clip.y);

      await page.keyboard.press('F10');
      const toolbar = editor.portal('table-toolbar');
      await expect(toolbar.getByRole('button').nth(0), ground).toBeFocused();
      await editor.settleScroll();

      const box = (await cell.boundingBox())!;
      const bar = (await toolbar.boundingBox())!;
      expect(box.y, `${ground}: the whole cell is back`).toBeGreaterThanOrEqual(clip.y);
      expect(box.y + box.height, ground).toBeLessThanOrEqual(clip.y + clip.height);
      expect(bar.y, `${ground}: the toolbar is inside`).toBeGreaterThanOrEqual(clip.y);
      expect(bar.y + bar.height, ground).toBeLessThanOrEqual(clip.y + clip.height);
    }
  });

  /*
   * R9-PTR-1. The clip climb stopped at every `position: fixed` element, but
   * a fixed sheet whose pane has a `transform` (`translateZ(0)` included),
   * `will-change: transform`, `filter` or `contain: paint` is placed against
   * that pane and scrolls away with it: the pane dropped out of the chain,
   * and the caret's table toolbar stayed drawn over the page after its cell
   * had left the pane. The probe's shape: a 400px pane 150px down the page,
   * a 330px scrolling sheet declared in it at 180/180, the caret clicked
   * into cell 1:1, the pane wheeled twice by 250px from a point beside the
   * sheet (once by 400 in the probe; Firefox turns any one turn into 360,
   * which leaves the cell's top two pixels in sight). The window-fixed sheet and a `container-type` pane (no containing block
   * for fixed boxes) are the siblings that must keep the toolbar: their
   * sheet does not move. Layout and scrolling: e2e.
   */
  test('TB5p the caret’s table toolbar goes with a fixed sheet that its pane’s transform scrolls away', async ({
    editor,
    page,
  }) => {
    const shapes = [
      ['transform: translateZ(0)', 'goes'],
      ['will-change: transform', 'goes'],
      ['contain: paint', 'goes'],
      ['filter: blur(0)', 'goes'],
      ['', 'stays'],
      ['container-type: inline-size', 'stays'],
    ] as const;

    for (const [trigger, expected] of shapes) {
      const shape = trigger || 'window-fixed';
      await editor.load({ doc: 'table' });
      await page.evaluate(paneWithSheet, trigger);
      await editor.settle();
      const cell = editor.cell('tbl', 1, 1);
      const point = await editor.pointAt(cell, 1);
      await page.mouse.click(point.x, point.y);
      await editor.settle();
      const toolbar = editor.portal('table-toolbar');
      await expect(toolbar, shape).toBeVisible();

      const pane = (await page.locator('#pane').boundingBox())!;
      await page.mouse.move(pane.x + 20, pane.y + pane.height - 15);
      await page.mouse.wheel(0, 250);
      await page.mouse.wheel(0, 250);
      await editor.settleScroll();
      expect(await page.locator('#pane').evaluate((e) => e.scrollTop), shape).toBeGreaterThan(400);
      const seen = await cell.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + 10, box.top + box.height / 2);
        return box.top >= 0 && !!hit && element.contains(hit);
      });
      expect(seen, `${shape}: precondition`).toBe(expected === 'stays');
      if (expected === 'goes') {
        await expect(toolbar, shape).toBeHidden();
      } else {
        await expect(toolbar, shape).toBeVisible();
      }
      await expect(cell, shape).toBeFocused();

      // And it comes back with the cell.
      await page.mouse.wheel(0, -250);
      await page.mouse.wheel(0, -250);
      await editor.settleScroll();
      await expect(toolbar, `${shape}: back`).toBeVisible();
    }
  });

  /*
   * R9-PTR-2. A cell taller than its scroller, or than the window, is never
   * wholly on screen, so every F10 centred the cell's middle and scrolled
   * the caret away. The probe: cell 1:1 holding 16 lines in a 300px root
   * scroller (and 60 in the page), its top brought 250px (200px) down, a
   * click on "line 2". The caret is judged instead: on screen, F10 moves
   * nothing; scrolled away inside the still-covering cell, F10 brings the
   * caret, not the cell's middle, to the middle of its scroller. The toolbar
   * is drawn beside the caret's line, not over it. Layout: e2e.
   */
  test('TB5q F10 in a cell taller than its scroller keeps the caret on screen', async ({
    editor,
    page,
  }) => {
    for (const [ground, lines] of [
      ['inner scroller', 16],
      ['page', 60],
    ] as const) {
      await editor.load({ doc: 'table' });
      await page.evaluate(
        ([ground, lines]) => {
          const ed = window.__e2e.editor;
          const doc = ed.getDocument();
          const tbl = doc.blocks.find((block) => block.id === 'tbl')!;
          tbl.rows![1]![1] = [
            { text: Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n') },
          ];
          const para = (id: string, text: string) => ({
            id,
            type: 'paragraph' as const,
            depth: 0,
            content: [{ text }],
          });
          doc.blocks = [
            ...Array.from({ length: 6 }, (_, i) => para(`h${i}`, `Head ${i}`)),
            ...doc.blocks,
            ...Array.from({ length: 20 }, (_, i) => para(`z${i}`, `Tail ${i}`)),
          ];
          ed.setDocument(doc);
          if (ground === 'inner scroller') {
            Object.assign(document.querySelector<HTMLElement>('#editor')!.style, {
              height: '300px',
              overflow: 'auto',
              border: '2px solid red',
            });
            document.querySelector<HTMLElement>('#stage')!.style.margin = '100px auto 1500px';
          }
        },
        [ground, lines] as const,
      );
      const cell = editor.cell('tbl', 1, 1);
      await cell.evaluate((element, ground) => {
        const want = ground === 'page' ? 200 : 250;
        const top = element.getBoundingClientRect().top - want;
        if (ground === 'page') {
          window.scrollBy(0, top);
        } else {
          document.querySelector('#editor')!.scrollTop += top;
        }
      }, ground);
      await editor.settleScroll();
      const point = await editor.pointAt(cell, 'line 0\nline 1\nline '.length + 1);
      await page.mouse.click(point.x, point.y);
      await editor.settle();
      const line2 = () =>
        cell.evaluate((element) => {
          const text = element.firstChild as Text;
          const range = document.createRange();
          const at = text.data.indexOf('line 2');
          range.setStart(text, at);
          range.setEnd(text, at + 6);
          const box = range.getBoundingClientRect();
          return { top: box.top, bottom: box.bottom };
        });
      const toolbar = editor.portal('table-toolbar');

      // F10 and the Escape back from its toolbar both move nothing: the
      // Escape revealed the whole cell the nearest way, which in a cell this
      // tall lined its edge up with the scroller's (LEAD-9: the caret moved
      // about 100px, and Firefox and WebKit scrolled the page as well).
      const before = await line2();
      const pageY = await page.evaluate(() => window.scrollY);
      for (const press of [1, 2]) {
        await page.keyboard.press('F10');
        await expect(toolbar.getByRole('button').nth(0), `${ground} #${press}`).toBeFocused();
        await editor.settleScroll();
        const now = await line2();
        expect(Math.abs(now.top - before.top), `${ground} #${press}: nothing moved`).toBeLessThan(
          2,
        );
        const bar = (await toolbar.boundingBox())!;
        expect(
          bar.y + bar.height <= now.top + 1 || bar.y >= now.bottom - 1,
          `${ground} #${press}: the toolbar leaves the caret's line clear`,
        ).toBe(true);
        expect(bar.y, `${ground} #${press}: on screen`).toBeGreaterThanOrEqual(0);
        await page.keyboard.press('Escape');
        await expect(cell, `${ground} #${press}`).toBeFocused();
        await editor.settleScroll();
        const back = await line2();
        expect(
          Math.abs(back.top - before.top),
          `${ground} #${press}: Escape moved nothing`,
        ).toBeLessThan(2);
        expect(await page.evaluate(() => window.scrollY), `${ground} #${press}`).toBe(pageY);
      }

      // The caret scrolled out of sight with the rest of the cell still on
      // screen: F10 brings the caret, not the cell's middle, to the
      // scroller's middle.
      const clip = await cell.evaluate((element, ground) => {
        const scroller = ground === 'page' ? null : document.querySelector('#editor')!;
        const text = element.firstChild as Text;
        const range = document.createRange();
        range.setStart(text, text.data.indexOf('line 2'));
        const top = range.getBoundingClientRect().top;
        if (scroller) {
          scroller.scrollTop += top - scroller.getBoundingClientRect().top + 60;
          const box = scroller.getBoundingClientRect();
          return { top: box.top + scroller.clientTop, height: scroller.clientHeight };
        }
        window.scrollBy(0, top + 300);
        return { top: 0, height: window.innerHeight };
      }, ground);
      await editor.settleScroll();
      expect((await line2()).bottom, `${ground}: precondition`).toBeLessThan(clip.top);
      expect((await cell.boundingBox())!.height, `${ground}: precondition`).toBeGreaterThan(
        clip.height,
      );

      await page.keyboard.press('F10');
      await expect(toolbar.getByRole('button').nth(0), ground).toBeFocused();
      await editor.settleScroll();
      const back = await line2();
      expect(
        Math.abs((back.top + back.bottom) / 2 - (clip.top + clip.height / 2)),
        `${ground}: the caret is centred`,
      ).toBeLessThan(12);
      await page.keyboard.press('Escape');
    }
  });

  /*
   * R9-PTR-2, the anchor. In a row taller than the window there is no room
   * above or below the row, and the clamp held the toolbar at the window's
   * bottom edge -- over the caret's own line when that is where the caret
   * is. The probe's page ground (60 lines in cell 1:1), "line 40" brought to
   * 30px above the window's bottom and clicked, then F10: the toolbar is
   * drawn beside the caret's line, for the click and for F10. Layout: e2e.
   */
  test('TB5s in a row taller than the window the table toolbar leaves the caret’s line clear', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const doc = ed.getDocument();
      const tbl = doc.blocks.find((block) => block.id === 'tbl')!;
      tbl.rows![1]![1] = [{ text: Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') }];
      ed.setDocument(doc);
    });
    const cell = editor.cell('tbl', 1, 1);
    const line40 = () =>
      cell.evaluate((element) => {
        const text = element.firstChild as Text;
        const range = document.createRange();
        const at = text.data.indexOf('line 40');
        range.setStart(text, at);
        range.setEnd(text, at + 7);
        const box = range.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom };
      });
    const height = page.viewportSize()!.height;
    await page.evaluate((by) => window.scrollBy(0, by), (await line40()).bottom - (height - 30));
    await editor.settleScroll();
    const box = (await cell.boundingBox())!;
    expect(box.y, 'precondition: the row covers the window').toBeLessThan(0);
    expect(box.y + box.height, 'precondition').toBeGreaterThan(height);
    const point = await editor.pointAt(cell, (await cell.textContent())!.indexOf('line 40') + 2);
    await page.mouse.click(point.x, point.y);
    await editor.settle();
    const toolbar = editor.portal('table-toolbar');
    const clear = async (label: string) => {
      const line = await line40();
      const bar = (await toolbar.boundingBox())!;
      expect(
        bar.y + bar.height <= line.top + 1 || bar.y >= line.bottom - 1,
        `${label}: the caret's line is clear`,
      ).toBe(true);
      expect(line.bottom, `${label}: the caret is on screen`).toBeLessThanOrEqual(height);
    };
    await expect(toolbar).toBeVisible();
    await clear('click');

    await page.keyboard.press('F10');
    await expect(toolbar.getByRole('button').nth(0)).toBeFocused();
    await editor.settleScroll();
    await clear('F10');
  });

  /*
   * R9-RV-CLIP-1 and R9-RV2-CLIP-1/2. A caret at a line start is drawn
   * where no engine says: Chromium gives a caret on an empty line no box at
   * all, and Firefox gives one just after any line break a box on the line
   * above. Unmeasured, F10 centred the tall cell's middle and scrolled the
   * caret ~350px away; estimated from the text before a run of blank lines,
   * by the glyph's height rather than the line's, it drifted 6px a line --
   * the toolbar 190px above the caret, F10 scrolling a caret on screen and
   * leaving one off screen where it was. The caret is measured by the
   * character at its offset, the line break included; so is the line this
   * test expects, which is why one line's tolerance is too loose. The
   * probes: "top", 40 blank lines and "end" in cell 1:1, blank line 30
   * clicked at mid-window, then scrolled two lines below the window, then to
   * the third visible line; Enter at the end of "line 40" 60px above the
   * window's bottom, in column 1 and column 0; "line 20" at 3px (and at
   * 40px) with the caret arrowed to its start. Layout: e2e.
   */
  test('TB5t a caret at a line start of a tall cell is measured on its own line', async ({
    editor,
    page,
  }) => {
    const height = page.viewportSize()!.height;
    const toolbar = editor.portal('table-toolbar');
    const pageY = () => page.evaluate(() => window.scrollY);
    // The caret's own line: the character at its offset, a line break
    // included, which every engine draws on the caret's line.
    const caretLine = () =>
      page.evaluate(() => {
        const selection = document.getSelection()!;
        const node = selection.focusNode as Text;
        const range = document.createRange();
        range.setStart(node, selection.focusOffset);
        range.setEnd(node, Math.min(selection.focusOffset + 1, node.length));
        const box = range.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom };
      });
    // Drawn beside the caret's line: clear of it, and within one line of it.
    const beside = async (label: string) => {
      const line = await caretLine();
      const bar = (await toolbar.boundingBox())!;
      const above = line.top - (bar.y + bar.height);
      const below = bar.y - line.bottom;
      expect(
        (above >= -1 && above < 16) || (below >= -1 && below < 16),
        `${label}: the toolbar is drawn beside the caret's line (${above}, ${below})`,
      ).toBe(true);
    };
    const load = async (text: string, column = 1) => {
      await editor.load({ doc: 'table' });
      await page.evaluate(
        ([text, column]) => {
          const ed = window.__e2e.editor;
          const doc = ed.getDocument();
          doc.blocks.find((block) => block.id === 'tbl')!.rows![1]![column] = [{ text }];
          const para = (id: string, value: string) => ({
            id,
            type: 'paragraph' as const,
            depth: 0,
            content: [{ text: value }],
          });
          doc.blocks = [
            ...Array.from({ length: 3 }, (_, i) => para(`h${i}`, `Head ${i}`)),
            ...doc.blocks,
            ...Array.from({ length: 30 }, (_, i) => para(`z${i}`, `Tail ${i}`)),
          ];
          ed.setDocument(doc);
        },
        [text, column] as const,
      );
      return editor.cell('tbl', 1, column);
    };
    // Scrolls the line holding the character at `at` to `y`.
    const lineTo = (cell: Awaited<ReturnType<typeof load>>, at: number, y: number) =>
      cell.evaluate(
        (element, [at, y]) => {
          const range = document.createRange();
          range.setStart(element.firstChild!, at);
          range.setEnd(element.firstChild!, at + 1);
          window.scrollBy(0, range.getBoundingClientRect().top - y);
        },
        [at, y] as const,
      );
    const f10MovesNothing = async (label: string) => {
      const before = await pageY();
      await page.keyboard.press('F10');
      await expect(toolbar.getByRole('button').nth(0), label).toBeFocused();
      await editor.settleScroll();
      expect(await pageY(), `${label}: F10 moved nothing`).toBe(before);
      await beside(`${label}, F10`);
      await page.keyboard.press('Escape');
      await editor.settleScroll();
      expect(await pageY(), `${label}: Escape moved nothing`).toBe(before);
    };

    // A run of 40 blank lines; the caret on the 30th.
    {
      const label = 'blank run';
      const cell = await load(`top${'\n'.repeat(40)}end`);
      await lineTo(cell, 3 + 30, 400);
      await editor.settleScroll();
      const first = await cell.evaluate((element) => {
        const range = document.createRange();
        range.setStart(element.firstChild!, 33);
        range.setEnd(element.firstChild!, 34);
        const box = range.getBoundingClientRect();
        return { x: box.left, y: (box.top + box.bottom) / 2 };
      });
      await page.mouse.click(first.x + 4, first.y);
      await editor.settle();
      expect((await editor.selection())?.range.start, `${label}: precondition`).toBe(33);
      await expect(toolbar, label).toBeVisible();
      await beside(label);
      await f10MovesNothing(label);

      // Two lines below the window: F10 brings it to the middle.
      await expect(cell, label).toBeFocused();
      await page.evaluate((by) => window.scrollBy(0, by), (await caretLine()).top - (height + 48));
      await editor.settleScroll();
      expect((await caretLine()).top, `${label}: precondition`).toBeGreaterThan(height);
      await page.keyboard.press('F10');
      await expect(toolbar.getByRole('button').nth(0), label).toBeFocused();
      await editor.settleScroll();
      const back = await caretLine();
      expect(
        Math.abs((back.top + back.bottom) / 2 - height / 2),
        `${label}: the caret is centred`,
      ).toBeLessThan(12);
      await page.keyboard.press('Escape');
      await editor.settleScroll();

      // The third visible line: on screen, so F10 moves nothing.
      await page.evaluate((by) => window.scrollBy(0, by), (await caretLine()).top - 48);
      await editor.settleScroll();
      await f10MovesNothing(`${label}, third line`);
    }

    // Enter at the end of "line 40", 60px above the window's bottom.
    for (const column of [1, 0]) {
      const label = `Enter, column ${column}`;
      const text = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
      const cell = await load(text, column);
      const at = text.indexOf('line 40');
      await lineTo(cell, at, height - 60);
      await editor.settleScroll();
      const point = await editor.pointAt(cell, at + 'line 40'.length);
      await page.mouse.click(point.x, point.y);
      await page.keyboard.press('Enter');
      await editor.settle();
      await expect(toolbar, label).toBeVisible();
      const line = await caretLine();
      expect(line.bottom, `${label}: precondition, on screen`).toBeLessThanOrEqual(height);
      await beside(label);
      await f10MovesNothing(label);
    }

    // The start of "line 20": at 3px F10 moves nothing; at 40px the
    // toolbar is beside the line, not over it.
    for (const y of [3, 40]) {
      const label = `line start at ${y}px`;
      const text = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
      const cell = await load(text);
      const at = text.indexOf('line 20');
      await lineTo(cell, at, y);
      await editor.settleScroll();
      const point = await editor.pointAt(cell, at + 3);
      await page.mouse.click(point.x, point.y);
      for (let press = 0; press < 3; press += 1) {
        await page.keyboard.press('ArrowLeft');
      }
      await editor.settle();
      expect((await editor.selection())?.range.start, `${label}: precondition`).toBe(at);
      await expect(toolbar, label).toBeVisible();
      await beside(label);
      await f10MovesNothing(label);
    }
  });

  /*
   * R9-RV-CLIP-2. A range taller than the window is never wholly on screen,
   * so F10 centred the whole range and its focus end landed below the
   * window. The probe: 60 lines in cell 1:1, "line 5" at 100px, a click in
   * it, the range extended to "line 45" (Shift+click in the probe, Shift+↓
   * here), its focus end on screen near the bottom. Any of the range on
   * screen, F10 moves nothing; none of it, F10 brings the focus end -- where
   * the reader was extending it -- to the middle. Layout: e2e.
   */
  test('TB5u F10 with a range taller than the window keeps its focus end on screen', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const doc = ed.getDocument();
      doc.blocks.find((block) => block.id === 'tbl')!.rows![1]![1] = [
        { text: Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') },
      ];
      doc.blocks.push(
        ...Array.from({ length: 10 }, (_, i) => ({
          id: `z${i}`,
          type: 'paragraph' as const,
          depth: 0,
          content: [{ text: `Tail ${i}` }],
        })),
      );
      ed.setDocument(doc);
    });
    const cell = editor.cell('tbl', 1, 1);
    const text = (await cell.textContent())!;
    await cell.evaluate((element) => {
      const node = element.firstChild as Text;
      const range = document.createRange();
      const at = node.data.indexOf('line 5\n');
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      window.scrollBy(0, range.getBoundingClientRect().top - 100);
    });
    await editor.settleScroll();
    let point = await editor.pointAt(cell, text.indexOf('line 5\n') + 2);
    await page.mouse.click(point.x, point.y);
    // Down to "line 45" with Shift+↓, the browser keeping the focus end in
    // view. (The probe Shift+clicked there after a wheel; in WebKit that
    // gesture leaves the browser context unable to close, before this
    // change as after it, and the test's teardown timed out.)
    for (let line = 5; line < 45; line += 1) {
      await page.keyboard.press('Shift+ArrowDown');
    }
    await editor.settleScroll();
    const focusY = () =>
      page.evaluate(() => {
        const selection = document.getSelection()!;
        const range = document.createRange();
        range.setStart(selection.focusNode!, selection.focusOffset);
        return range.getBoundingClientRect().top;
      });
    const height = page.viewportSize()!.height;
    // The focus end's line near the window's bottom, where a toolbar clamped
    // against the whole range would sit on it.
    await page.evaluate((by) => window.scrollBy(0, by), (await focusY()) - (height - 40));
    await editor.settleScroll();
    expect((await editor.selection())?.range.end, 'precondition').toBe(text.indexOf('line 45') + 2);
    const box = (await cell.boundingBox())!;
    expect(box.y, 'precondition: the range starts above the window').toBeLessThan(0);
    const pageY = await page.evaluate(() => window.scrollY);

    const toolbar = editor.portal('table-toolbar');
    await page.keyboard.press('F10');
    await expect(toolbar.getByRole('button').nth(0)).toBeFocused();
    await editor.settleScroll();
    expect(await page.evaluate(() => window.scrollY), 'F10 moved nothing').toBe(pageY);
    const focusTop = await focusY();
    expect(focusTop).toBeLessThan(height);
    // Drawn beside the focus end's line, not clamped over it on a range
    // taller than the window.
    const bar = (await toolbar.boundingBox())!;
    expect(
      bar.y + bar.height <= focusTop + 1 || bar.y >= focusTop + 17,
      "the toolbar leaves the focus end's line clear",
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(cell).toBeFocused();
    await editor.settleScroll();
    expect(await page.evaluate(() => window.scrollY), 'Escape moved nothing').toBe(pageY);

    // None of the range on screen: the focus end comes to the middle.
    await page.evaluate((by) => window.scrollBy(0, by), (await focusY()) + 60);
    await editor.settleScroll();
    expect(await focusY(), 'precondition: the focus end above the window').toBeLessThan(0);
    await page.keyboard.press('F10');
    await expect(toolbar.getByRole('button').nth(0)).toBeFocused();
    await editor.settleScroll();
    expect(Math.abs((await focusY()) - height / 2), 'the focus end is centred').toBeLessThan(24);
    await page.keyboard.press('Escape');
    await expect(cell).toBeFocused();

    // Made backward -- from "line 45" up to "line 5" -- the range comes back
    // from the toolbar backward too: the next Shift+← grows it at its start,
    // where the reader was extending it. (Restored forward, the tall cell's
    // own Escape path shrank it at the end instead.)
    await cell.evaluate((element, at) => {
      const range = document.createRange();
      range.setStart(element.firstChild!, at);
      range.setEnd(element.firstChild!, at + 1);
      window.scrollBy(0, range.getBoundingClientRect().top - 600);
    }, text.indexOf('line 45'));
    await editor.settleScroll();
    point = await editor.pointAt(cell, text.indexOf('line 45') + 2);
    await page.mouse.click(point.x, point.y);
    for (let line = 45; line > 5; line -= 1) {
      await page.keyboard.press('Shift+ArrowUp');
    }
    await editor.settle();
    const made = (await editor.selection())!.range;
    expect(made.end - made.start, 'precondition: a range over 40 lines').toBeGreaterThan(300);
    await page.keyboard.press('F10');
    await expect(toolbar.getByRole('button').nth(0)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(cell).toBeFocused();
    expect((await editor.selection())?.range, 'the range is back').toEqual(made);
    await page.keyboard.press('Shift+ArrowLeft');
    expect((await editor.selection())?.range, 'grown at its start').toEqual({
      start: made.start - 1,
      end: made.end,
    });
  });

  /*
   * R9-PTR-3. F10 centred the cell in the nearest scroller of all, which for
   * a cell in a fixed panel that does not scroll itself is the pane behind
   * the panel: the pane scrolled and the cell stayed where it was. The
   * probe: a 600px pane scrolled to 900, a fixed panel at top 660 declared
   * in it, the caret arrowed down into cell 2:1, half below the window. With
   * nothing that can move the cell the page and the pane stay put, and the
   * toolbar still takes focus. Layout and scrolling: e2e.
   */
  test('TB5r F10 in a fixed panel that does not scroll moves nothing behind it', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>('#stage')!;
      const pane = document.createElement('div');
      pane.id = 'pane';
      pane.style.cssText = 'margin:20px auto 0;width:760px;height:600px;overflow:auto';
      document.body.insertBefore(pane, document.body.firstChild);
      const filler = document.createElement('div');
      filler.style.height = '3000px';
      const sheet = document.createElement('div');
      sheet.style.cssText = 'position:fixed;left:180px;top:660px;width:740px;background:#fff';
      pane.append(sheet, filler);
      stage.style.margin = '0';
      sheet.append(stage);
      pane.scrollTop = 900;
    });
    await editor.settle();
    const point = await editor.pointAt(editor.cell('tbl', 1, 1), 1);
    await page.mouse.click(point.x, point.y);
    await page.keyboard.press('ArrowDown');
    await expect(editor.cell('tbl', 2, 1)).toBeFocused();
    await editor.settle();
    const where = () =>
      page.evaluate(() => ({
        pane: document.querySelector('#pane')!.scrollTop,
        page: window.scrollY,
      }));
    const before = await where();
    expect(before.pane, 'precondition').toBe(900);

    await page.keyboard.press('F10');
    await expect(editor.portal('table-toolbar').getByRole('button').nth(0)).toBeFocused();
    await editor.settleScroll();
    expect(await where()).toEqual(before);
  });

  /*
   * R10-PTR-1. An editor slotted into a component whose shadow tree holds the
   * scrolling pane was invisible to the clip climb, which went from the
   * stage to the component's host by `parentElement` and never met the pane,
   * and to the scroll listeners, which heard only the editor's own root
   * node: the caret's table toolbar stayed drawn over the pane after its
   * cell had scrolled out of it. A fixed sheet slotted in, whose containing
   * block is the shadow pane, is the same shape -- `offsetParent` reports
   * `<body>` for it. The probe: the caret in cell 1:1, the pane wheeled
   * 480px (the cell above its top), then back. Layout and scrolling: e2e.
   */
  test('TB5v the caret’s table toolbar leaves with its cell from a pane in a component’s shadow tree', async ({
    editor,
    page,
  }) => {
    for (const variant of ['slotted', 'fixed sheet'] as const) {
      await editor.load({ doc: 'table' });
      await page.evaluate(slottedPane, variant);
      await editor.settle();
      const cell = editor.cell('tbl', 1, 1);
      const point = await editor.pointAt(cell, 1);
      await page.mouse.click(point.x, point.y);
      await editor.settle();
      const toolbar = editor.portal('table-toolbar');
      await expect(toolbar, variant).toBeVisible();

      const wheel = async (by: number) => {
        await page.mouse.move(400, 400);
        for (let i = 0; i < 4; i++) {
          await page.mouse.wheel(0, by);
        }
        await editor.settleScroll();
      };
      await wheel(120);
      const where = await page.evaluate(() => {
        const scroll = document.querySelector('x-pane')!.shadowRoot!.querySelector('#scroll')!;
        const cell = document.querySelector('[data-block-id="tbl"] [data-cell="1:1"]')!;
        return {
          scrolled: scroll.scrollTop,
          above: cell.getBoundingClientRect().bottom <= scroll.getBoundingClientRect().top,
        };
      });
      expect(where.scrolled, `${variant}: precondition`).toBeGreaterThan(300);
      expect(where.above, `${variant}: precondition, the cell left the pane`).toBe(true);
      await expect(toolbar, variant).toBeHidden();
      await expect(cell, variant).toBeFocused();

      await wheel(-120);
      await expect(toolbar, `${variant}: back`).toBeVisible();
    }
  });

  /*
   * R10-PTR-5. The clip climb took every scrolling ancestor as clipping, but
   * a `position: absolute` panel declared inside a scroller that is not its
   * containing block is neither clipped nor scrolled by it. The probe: a
   * 160px pane at the top of the page holding 900px of filler and an
   * absolute panel at 330/260 holding the editor, the caret in cell 1:1 --
   * below the pane's box and on screen: the toolbar never appeared. A wheel
   * over the pane moves nothing of the panel, and the toolbar stays. Layout:
   * e2e.
   */
  test('TB5w the caret’s table toolbar shows in an absolute panel a scroller around it does not clip', async ({
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
    const cell = editor.cell('tbl', 1, 1);
    const box = (await cell.boundingBox())!;
    const pane = (await page.locator('#pane').boundingBox())!;
    expect(box.y, 'precondition: the cell is below the pane').toBeGreaterThan(pane.y + pane.height);
    const point = await editor.pointAt(cell, 1);
    await page.mouse.click(point.x, point.y);
    await editor.settle();
    const toolbar = editor.portal('table-toolbar');
    await expect(toolbar).toBeVisible();

    await page.mouse.move(pane.x + 100, pane.y + 60);
    await page.mouse.wheel(0, 100);
    await editor.settleScroll();
    expect(
      await page.locator('#pane').evaluate((e) => e.scrollTop),
      'precondition',
    ).toBeGreaterThan(0);
    expect((await cell.boundingBox())!.y, 'the panel did not move').toBeCloseTo(box.y, 0);
    await expect(toolbar).toBeVisible();
  });

  /*
   * R11-PTR-5. An absolute panel with no positioned ancestor is placed
   * against the page, and `offsetParent` reports `<body>` for it -- which
   * scrolls and clips it only when it is a containing block itself. On a
   * page whose `<body>` scrolls (`html { overflow: hidden }`, an app shell),
   * the climb took that report as the panel's containing block and read the
   * panel as clipped by the body's scroller, below it: the caret's table
   * toolbar never showed. The probe: `html` hidden, `<body>` 300px tall from
   * 420px down and scrolling 1500px of content, the editor in a panel at
   * `position:absolute; top:20px` above it, a click in cell 1:1, F10.
   * Layout: e2e.
   */
  test('TB5wb the caret’s table toolbar shows in an absolute panel above a scrolling body', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await page.evaluate(() => {
      document.documentElement.style.cssText = 'overflow:hidden;height:100%';
      document.body.style.cssText = 'margin:420px 0 0;padding:0;height:300px;overflow:auto';
      const filler = document.createElement('div');
      filler.style.height = '1500px';
      document.body.prepend(filler);
      const panel = document.createElement('div');
      panel.id = 'panel';
      panel.style.cssText =
        'position:absolute;top:20px;left:20px;width:700px;background:#fff;border:1px solid #888';
      const stage = document.getElementById('stage')!;
      stage.style.margin = '0';
      panel.append(stage);
      document.body.append(panel);
    });
    await editor.settle();
    const cell = editor.cell('tbl', 1, 1);
    const body = (await page.locator('body').boundingBox())!;
    const box = (await cell.boundingBox())!;
    expect(box.y + box.height, 'precondition: the cell is above the body').toBeLessThan(body.y);
    const point = await editor.pointAt(cell, 1);
    await page.mouse.click(point.x, point.y);
    await expect(cell).toBeFocused();
    const toolbar = editor.portal('table-toolbar');
    await expect(toolbar).toBeVisible();
    await page.keyboard.press('F10');
    await expect(toolbar.getByRole('button').nth(0)).toBeFocused();
    expect(await page.evaluate(() => document.body.scrollTop), 'F10 moved nothing').toBe(0);
    expect((await cell.boundingBox())!.y, 'nor the panel').toBeCloseTo(box.y, 0);
  });

  /*
   * R10-PTR-2. A click to the right of a wrapped line's end puts the caret
   * at the wrap offset, drawn at the end of the clicked line; the character
   * at that offset is on the line below. Measured by it, a caret on the
   * window's last line read as below the window -- F10 scrolled the page
   * 398px -- and the toolbar, drawn above the caret's line, was drawn over
   * the clicked line itself. The browser is asked which line the caret is
   * drawn on (`softWrapLine`). The probe: cell 1:1 holding 900 words, the
   * page at 900, a click 3px inside the cell's right edge on the last line
   * wholly in the window, and on a line mid-window. Layout: e2e.
   */
  test('TB5x a caret drawn at the end of a wrapped line is measured on that line', async ({
    editor,
    page,
  }) => {
    for (const where of ['last line', 'mid-window'] as const) {
      await editor.load({ doc: 'table' });
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        const words = Array.from(
          { length: 900 },
          (_, i) => ['alpha', 'beta', 'gamma', 'delta', 'epsilon'][i % 5]! + i,
        ).join(' ');
        doc.blocks.find((block) => block.id === 'tbl')!.rows![1]![1] = [{ text: words }];
        doc.blocks.push(
          ...Array.from({ length: 20 }, (_, i) => ({
            id: `z${i}`,
            type: 'paragraph' as const,
            depth: 0,
            content: [{ text: `Tail ${i}` }],
          })),
        );
        ed.setDocument(doc);
        window.scrollTo(0, 900);
      });
      await editor.settleScroll();
      const cell = editor.cell('tbl', 1, 1);
      const line = await cell.evaluate((element, where) => {
        const text = element.firstChild as Text;
        const range = document.createRange();
        const lines: { start: number; top: number; bottom: number }[] = [];
        for (let i = 0; i < text.length; i++) {
          range.setStart(text, i);
          range.setEnd(text, i + 1);
          const box = range.getClientRects()[0];
          if (box && (lines.length === 0 || Math.abs(box.top - lines.at(-1)!.top) > 3)) {
            lines.push({ start: i, top: box.top, bottom: box.bottom });
          }
        }
        const k =
          where === 'last line'
            ? lines.filter((l) => l.bottom < innerHeight - 2).length - 1
            : lines.findIndex((l) => l.top > 380);
        return {
          ...lines[k]!,
          next: lines[k + 1]!.start,
          right: element.getBoundingClientRect().right,
        };
      }, where);
      await page.mouse.click(line.right - 3, (line.top + line.bottom) / 2);
      await editor.settle();
      const toolbar = editor.portal('table-toolbar');
      await expect(toolbar, where).toBeVisible();
      const offset = await page.evaluate(() => getSelection()!.focusOffset);
      expect(offset, `${where}: precondition, the caret is at the wrap`).toBe(line.next);
      const clear = async (label: string) => {
        const bar = (await toolbar.boundingBox())!;
        expect(
          bar.y + bar.height <= line.top + 1 || bar.y >= line.bottom - 1,
          `${where}, ${label}: the clicked line is clear`,
        ).toBe(true);
      };
      await clear('click');

      await page.keyboard.press('F10');
      await expect(toolbar.getByRole('button').nth(0), where).toBeFocused();
      await editor.settleScroll();
      expect(await page.evaluate(() => window.scrollY), `${where}: F10 moved nothing`).toBe(900);
      await clear('F10');
      await page.keyboard.press('Escape');
      await expect(cell, where).toBeFocused();
      await editor.settleScroll();
      expect(await page.evaluate(() => window.scrollY), `${where}: Escape moved nothing`).toBe(900);
    }
  });

  /*
   * R10-RV-PTR-1. A frame drawn at another scale (`transform: scale()` --
   * page builders, previews, a Storybook zoom) shows its window at that
   * scale, so the windows of the pages around it cut what is on screen, and
   * a reveal scrolls them, only through that scale. Cut in the outer page's
   * pixels unscaled, a caret drawn at the outer y 722 read as off screen --
   * a click in a cell drew no table toolbar -- and Enter at the outer y 711
   * scrolled the page ~590px. The probes: a 2000x1500 frame at `scale(0.5)`
   * from its top left, 40 paragraphs before the table, a click in cell 1:1;
   * then 60 lines in it and Enter at the end of "line 50" -- and 120 lines,
   * a cell taller than what the frame shows, where the new line itself is
   * revealed through the frame (`#revealBox`). Layout and frames: e2e.
   */
  test('TB5z in a frame drawn at half scale the toolbar shows and Enter scrolls no more than a line', async ({
    page,
  }) => {
    for (const probe of ['click', 'enter', 'enter in a taller cell'] as const) {
      const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
      await editor.load({ doc: 'table', mount: 'iframe' });
      await page.evaluate((probe) => {
        document.getElementById('frame')!.style.cssText =
          'width:2000px;height:1500px;border:0;transform:scale(0.5);transform-origin:0 0;display:block';
        document.body.style.minHeight = '3000px';
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        if (probe === 'click') {
          doc.blocks = [
            ...Array.from({ length: 40 }, (_, i) => ({
              id: `f${i}`,
              type: 'paragraph' as const,
              depth: 0,
              content: [{ text: `Filler paragraph ${i}` }],
            })),
            ...doc.blocks,
          ];
        } else {
          const lines = probe === 'enter' ? 60 : 120;
          doc.blocks.find((block) => block.id === 'tbl')!.rows![1]![1] = [
            { text: Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n') },
          ];
        }
        ed.setDocument(doc);
      }, probe);
      await editor.settle();
      const cell = editor.cell('tbl', 1, 1);
      const toolbar = editor.portal('table-toolbar');
      const height = page.viewportSize()!.height;

      if (probe === 'click') {
        const box = (await cell.boundingBox())!;
        expect(box.y + box.height, 'precondition: drawn inside the window').toBeLessThan(height);
        await page.mouse.click(box.x + 5, box.y + box.height / 2);
        await expect(cell).toBeFocused();
        await expect(toolbar, 'a cell on screen draws its toolbar').toBeVisible();
        continue;
      }

      // `pointAt` lifts by the frame's offset only; this frame is drawn at
      // half its size, so the point is lifted here.
      const point = await cell.evaluate((element) => {
        const text = element.firstChild as Text;
        const at = text.data.indexOf('line 50') + 'line 50'.length;
        const range = document.createRange();
        range.setStart(text, at - 1);
        range.setEnd(text, at);
        const box = range.getBoundingClientRect();
        return { x: box.right, y: (box.top + box.bottom) / 2 };
      });
      const frame = (await page.locator('#frame').boundingBox())!;
      const y = frame.y + point.y * 0.5;
      expect(y, 'precondition: the line is drawn inside the window').toBeLessThan(height);
      await page.mouse.click(frame.x + point.x * 0.5 + 1, y);
      await expect(cell).toBeFocused();
      const before = await page.evaluate(() => window.scrollY);
      await page.keyboard.press('Enter');
      await editor.settleScroll();
      expect((await cellText(editor, 1, 1)).includes('line 50\n\n'), 'the break').toBe(true);
      expect(
        Math.abs((await page.evaluate(() => window.scrollY)) - before),
        'the page moved no more than a line',
      ).toBeLessThan(30);
      const line = await cell.evaluate((element) => {
        const text = element.firstChild as Text;
        const at = text.data.indexOf('line 50\n\n') + 'line 50\n'.length;
        const range = document.createRange();
        range.setStart(text, at);
        range.setEnd(text, at + 1);
        const box = range.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom };
      });
      const top = (await page.locator('#frame').boundingBox())!.y;
      expect(top + line.top * 0.5, 'the new line is on screen').toBeGreaterThanOrEqual(0);
      expect(top + line.bottom * 0.5, 'the new line is on screen').toBeLessThanOrEqual(height);
      await expect(toolbar).toBeVisible();
    }
  });

  /*
   * R10-RV-PTR-2, R11-PTR-1 and R11-PTR-2. Which line of a wrap the caret is
   * drawn on can be asked of the browser only by moving the caret away and
   * back (`Selection.modify`), and asked anywhere but the arrow keys that
   * move does harm: from a scroll, Firefox's `modify` scrolled the caret into
   * view and pulled the page back under the reader's wheel; from the
   * `selectionchange` that draws the table toolbar, it reset the column the
   * browser keeps for ↑/↓ (TB5xd) and Firefox jumped the page on a
   * triple-click (TB5xe). So it is never asked outside them: the floating UI
   * measures both places a caret at a wrap can be drawn (`selectionBoxes`).
   * Counted at the source: `Selection.prototype.modify` is wrapped before the
   * page loads. The probe: TB5x's cell of 900 words, a click 3px inside its
   * right edge on a line mid-window (a caret at a wrap), Shift pressed and
   * released, F10 and Escape -- keys that bring the caret into view, and
   * may ask (TB5xf) -- then a 60px wheel and a resize. Layout: e2e.
   */
  test('TB5xb the browser is never asked where the caret is drawn outside the keys that move to it', async ({
    editor,
    page,
  }) => {
    await page.addInitScript(() => {
      const counts = { modify: 0 };
      (window as unknown as { __modify: typeof counts }).__modify = counts;
      // Read off the descriptor: the original, called with the selection's own `this`.
      const modify = Object.getOwnPropertyDescriptor(Selection.prototype, 'modify')!.value as (
        this: Selection,
        ...args: Parameters<Selection['modify']>
      ) => void;
      Selection.prototype.modify = function (...args: Parameters<Selection['modify']>) {
        counts.modify += 1;
        return modify.apply(this, args);
      };
    });
    await editor.load({ doc: 'table' });
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const doc = ed.getDocument();
      const words = Array.from(
        { length: 900 },
        (_, i) => ['alpha', 'beta', 'gamma', 'delta', 'epsilon'][i % 5]! + i,
      ).join(' ');
      doc.blocks.find((block) => block.id === 'tbl')!.rows![1]![1] = [{ text: words }];
      doc.blocks.push(
        ...Array.from({ length: 20 }, (_, i) => ({
          id: `z${i}`,
          type: 'paragraph' as const,
          depth: 0,
          content: [{ text: `Tail ${i}` }],
        })),
      );
      ed.setDocument(doc);
      window.scrollTo(0, 900);
    });
    await editor.settleScroll();
    const cell = editor.cell('tbl', 1, 1);
    const line = await cell.evaluate((element) => {
      const text = element.firstChild as Text;
      const range = document.createRange();
      let previous: DOMRect | null = null;
      for (let i = 0; i < text.length; i++) {
        range.setStart(text, i);
        range.setEnd(text, i + 1);
        const box = range.getClientRects()[0];
        if (box && previous && box.top > previous.bottom - 1 && previous.top > 380) {
          return {
            next: i,
            y: (previous.top + previous.bottom) / 2,
            right: element.getBoundingClientRect().right,
          };
        }
        previous = box ?? previous;
      }
      throw new Error('no wrap');
    });
    const count = () =>
      page.evaluate(() => (window as unknown as { __modify: { modify: number } }).__modify.modify);
    const before = await count();
    await page.mouse.click(line.right - 3, line.y);
    await editor.settle();
    await expect(editor.portal('table-toolbar')).toBeVisible();
    expect(
      await page.evaluate(() => getSelection()!.focusOffset),
      'precondition: at the wrap',
    ).toBe(line.next);
    expect(await count(), 'a click asks nothing').toBe(before);
    await page.keyboard.press('Shift');
    await editor.settle();
    expect(await count(), 'a key asks nothing').toBe(before);
    // F10 and the Escape back are keys that bring the caret into view, and
    // may ask which line it is drawn on (TB5xf); nothing they leave behind
    // asks again.
    await page.keyboard.press('F10');
    await expect(editor.portal('table-toolbar').getByRole('button').nth(0)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(cell).toBeFocused();
    await editor.settle();
    const afterKeys = await count();

    await page.mouse.move(500, 300);
    await page.mouse.wheel(0, 60);
    await editor.settleScroll();
    expect(await count(), 'a wheel asks nothing').toBe(afterKeys);
    await page.setViewportSize({ width: 1100, height: 700 });
    await editor.settle();
    await editor.settle();
    expect(await count(), 'a resize asks nothing').toBe(afterKeys);
  });

  /*
   * R10-RV-PTR-2, the composition. Asked while a composition is open, the
   * caret's move away and back would end it. Chromium only: the composition
   * is driven through CDP (`Input.imeSetComposition`). The probe: a 420px
   * window, cell 1:1 holding "aa bb", 60 q's, " tail" and 40 lines, a click
   * 3px inside its right edge on the first line (a caret at a wrap in a row
   * taller than the window), then か, かな, かなk, かなか composed and 仮名か
   * committed: no `Selection.modify` while composing.
   */
  test('TB5xc the browser is not asked where the caret is drawn during a composition', async ({
    editor,
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'composition through CDP');
    await page.setViewportSize({ width: 1100, height: 420 });
    await page.addInitScript(() => {
      const log: boolean[] = [];
      (window as unknown as { __modify: boolean[] }).__modify = log;
      let composing = false;
      document.addEventListener('compositionstart', () => (composing = true), true);
      document.addEventListener('compositionend', () => (composing = false), true);
      // Read off the descriptor: the original, called with the selection's own `this`.
      const modify = Object.getOwnPropertyDescriptor(Selection.prototype, 'modify')!.value as (
        this: Selection,
        ...args: Parameters<Selection['modify']>
      ) => void;
      Selection.prototype.modify = function (...args: Parameters<Selection['modify']>) {
        log.push(composing);
        return modify.apply(this, args);
      };
    });
    const cdp = await page.context().newCDPSession(page);
    await editor.load({ doc: 'table' });
    await page.evaluate(
      (text) => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks.find((block) => block.id === 'tbl')!.rows![1]![1] = [{ text }];
        ed.setDocument(doc);
      },
      `aa bb ${'q'.repeat(60)} tail` + '\nline'.repeat(40),
    );
    const cell = editor.cell('tbl', 1, 1);
    const box = (await cell.boundingBox())!;
    await page.mouse.click(box.x + box.width - 3, box.y + 12);
    await expect(cell).toBeFocused();
    await expect(editor.portal('table-toolbar')).toBeVisible();

    for (const [text, at] of [
      ['か', 1],
      ['かな', 2],
      ['かなk', 3],
      ['かなか', 3],
    ] as const) {
      await cdp.send('Input.imeSetComposition', {
        text,
        selectionStart: at,
        selectionEnd: at,
      });
      await editor.settle();
    }
    await cdp.send('Input.insertText', { text: '仮名か' });
    await editor.settle();
    expect(await cellText(editor, 1, 1)).toContain('仮名か');
    const during = await page.evaluate(() =>
      (window as unknown as { __modify: boolean[] }).__modify.filter(Boolean),
    );
    expect(during, 'no Selection.modify while composing').toEqual([]);
  });

  /*
   * R11-PTR-1. The `selectionchange` that draws the caret's table toolbar
   * asked the browser which line of a wrap the caret was on by moving it
   * away and back, and that move reset the column the browser keeps for a
   * run of vertical moves: after ↑ from near the end of a long line onto a
   * shorter one -- the caret at its end, a soft wrap -- Shift+↓ stopped 7-9
   * characters short of where it began, in every engine. The probe: a
   * 700x450 window, cell 1:1 holding 400 seeded words, the page scrolled so
   * a long line below a line at least 40px shorter is mid-window, a click
   * 2px inside the long line's end, ↑, Shift+↓. Layout: e2e.
   */
  test('TB5xd Shift+↓ after ↑ onto a shorter wrapped line comes back to the column it left', async ({
    editor,
    page,
  }) => {
    await page.setViewportSize({ width: 700, height: 450 });
    await editor.load({ doc: 'table' });
    await page.evaluate(
      (text) => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks.find((block) => block.id === 'tbl')!.rows![1]![1] = [{ text }];
        ed.setDocument(doc);
      },
      seededWords(400, 5),
    );
    const cell = editor.cell('tbl', 1, 1);
    const lines = () =>
      cell.evaluate((element) => {
        const text = element.firstChild as Text;
        const out: { top: number; bottom: number; endX: number }[] = [];
        for (let i = 0; i < text.length; i++) {
          const range = document.createRange();
          range.setStart(text, i);
          range.setEnd(text, i + 1);
          const box = [...range.getClientRects()].at(-1);
          if (!box) continue;
          const line = out.at(-1);
          if (!line || box.top >= line.bottom - 1) {
            out.push({ top: box.top, bottom: box.bottom, endX: box.right });
          } else if (text.data[i] !== ' ') {
            line.endX = Math.max(line.endX, box.right);
          }
        }
        return out;
      });
    const all = await lines();
    const pairs = all
      .map((_, i) => i)
      .filter((i) => i > 0 && i < all.length - 2 && all[i + 1]!.endX - all[i]!.endX > 40)
      .slice(0, 3);
    expect(pairs.length, 'precondition: a short line above a long one').toBeGreaterThan(0);

    for (const i of pairs) {
      await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 200)), all[i + 1]!.top);
      await editor.settleScroll();
      const now = await lines();
      await page.mouse.click(now[i + 1]!.endX - 2, (now[i + 1]!.top + now[i + 1]!.bottom) / 2);
      await expect(cell).toBeFocused();
      await expect(editor.portal('table-toolbar')).toBeVisible();
      const start = await page.evaluate(() => getSelection()!.focusOffset);
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('Shift+ArrowDown');
      await editor.settle();
      const { anchor, focus } = await page.evaluate(() => ({
        anchor: getSelection()!.anchorOffset,
        focus: getSelection()!.focusOffset,
      }));
      expect(anchor, `line ${i}: ↑ moved`).toBeLessThan(start);
      expect(focus, `line ${i}: Shift+↓ is back where the click put the caret`).toBe(start);
    }
  });

  /*
   * R11-RV-PTR-3. Judged by either of the two lines a caret at a soft wrap
   * can be drawn on, F10 never brought back a caret drawn on the line just
   * out of sight while the other line showed. F10 and the Escape back ask
   * the browser which line it is (`softWrapLine`), as only the keys that
   * bring the caret into view may. The probe: a 700x450 window, cell 1:1
   * holding 500 seeded words, the page at 200 (or 600), the first line
   * below y 200; a click 6px past that line's end (the caret drawn at the
   * end of the upper line), or 1px into the next line's start (the lower);
   * the page wheeled so that line is just out of the window and the other
   * just in it; F10, then Escape. Layout: e2e.
   */
  test('TB5xf F10 brings back a caret drawn on the line of a wrap that is out of sight', async ({
    editor,
    page,
  }) => {
    await page.setViewportSize({ width: 700, height: 450 });

    for (const side of ['upper', 'lower'] as const) {
      await editor.load({ doc: 'table' });
      await page.evaluate(
        ({ text, side }) => {
          const ed = window.__e2e.editor;
          const doc = ed.getDocument();
          doc.blocks.find((block) => block.id === 'tbl')!.rows![1]![1] = [{ text }];
          ed.setDocument(doc);
          window.scrollTo(0, side === 'upper' ? 200 : 600);
        },
        { text: seededWords(500, 5), side },
      );
      await editor.settleScroll();
      const cell = editor.cell('tbl', 1, 1);
      const lines = () =>
        cell.evaluate((element) => {
          const text = element.firstChild as Text;
          const out: { start: number; top: number; bottom: number; left: number; endX: number }[] =
            [];
          for (let i = 0; i < text.length; i++) {
            const range = document.createRange();
            range.setStart(text, i);
            range.setEnd(text, i + 1);
            const box = [...range.getClientRects()].at(-1);
            if (!box) continue;
            const line = out.at(-1);
            if (!line || box.top >= line.bottom - 1) {
              out.push({
                start: i,
                top: box.top,
                bottom: box.bottom,
                left: box.left,
                endX: box.right,
              });
            } else if (text.data[i] !== ' ') {
              line.endX = Math.max(line.endX, box.right);
            }
          }
          return out;
        });
      let all = await lines();
      const i = all.findIndex((line) => line.top > 200);
      const [upper, lower] = [all[i]!, all[i + 1]!];
      if (side === 'upper') {
        await page.mouse.click(upper.endX + 6, (upper.top + upper.bottom) / 2);
      } else {
        await page.mouse.click(lower.left + 1, (lower.top + lower.bottom) / 2);
      }
      await expect(cell).toBeFocused();
      expect(
        await page.evaluate(() => getSelection()!.focusOffset),
        `${side}: precondition, at the wrap`,
      ).toBe(lower.start);

      all = await lines();
      const dy =
        side === 'upper' ? Math.ceil(all[i]!.bottom + 2) : Math.floor(all[i + 1]!.top - 452);
      await page.mouse.move(350, 200);
      await page.mouse.wheel(0, dy);
      await editor.settleScroll();
      all = await lines();
      const drawn = () => (side === 'upper' ? all[i]! : all[i + 1]!);
      const other = side === 'upper' ? all[i + 1]! : all[i]!;
      expect(
        drawn().bottom <= 0 || drawn().top >= 450,
        `${side}: precondition, the caret's line is out of sight`,
      ).toBe(true);
      expect(
        other.top >= 0 && other.bottom <= 450,
        `${side}: precondition, the other line shows`,
      ).toBe(true);

      await page.keyboard.press('F10');
      await expect(editor.portal('table-toolbar').getByRole('button').nth(0)).toBeFocused();
      await editor.settleScroll();
      all = await lines();
      expect(drawn().top, `${side}: F10 brought the caret's line back`).toBeGreaterThanOrEqual(0);
      expect(drawn().bottom, `${side}: F10 brought the caret's line back`).toBeLessThanOrEqual(450);
      await page.keyboard.press('Escape');
      await expect(cell).toBeFocused();
      await editor.settleScroll();
      all = await lines();
      expect(drawn().top, `${side}: still there after Escape`).toBeGreaterThanOrEqual(0);
      expect(drawn().bottom, `${side}: still there after Escape`).toBeLessThanOrEqual(450);
    }
  });

  /*
   * R11-PTR-2. The same question asked from the `selectionchange` of a click
   * at a wrap made Firefox scroll the caret into view as a triple-click on
   * the next line selected the cell: the page jumped 718 → 1043. The probe:
   * a 700x450 window, cell 1:1 holding 400 seeded words, the page at 718, a
   * click 3px inside the cell's right edge on the third line in the window,
   * then a triple-click there on the fourth. Layout: e2e.
   */
  test('TB5xe a triple-click after a click at a wrap leaves the page where it is', async ({
    editor,
    page,
  }) => {
    await page.setViewportSize({ width: 700, height: 450 });
    await editor.load({ doc: 'table' });
    await page.evaluate(
      (text) => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks.find((block) => block.id === 'tbl')!.rows![1]![1] = [{ text }];
        ed.setDocument(doc);
        window.scrollTo(0, 718);
      },
      seededWords(400, 5),
    );
    await editor.settleScroll();
    const cell = editor.cell('tbl', 1, 1);
    const lines = await cell.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const out: { top: number; bottom: number }[] = [];
      for (const box of range.getClientRects()) {
        const line = out.at(-1);
        if (!line || Math.abs(line.top - box.top) >= 3) {
          out.push({ top: box.top, bottom: box.bottom });
        }
      }
      return out.filter((line) => line.top > 60 && line.bottom < 400);
    });
    const box = (await cell.boundingBox())!;
    const x = box.x + box.width - 3;
    await page.mouse.click(x, (lines[2]!.top + lines[2]!.bottom) / 2);
    await expect(cell).toBeFocused();
    await editor.settle();
    await page.mouse.click(x, (lines[3]!.top + lines[3]!.bottom) / 2, { clickCount: 3 });
    await editor.settleScroll();
    expect(await page.evaluate(() => window.scrollY), 'the page did not move').toBe(718);
  });

  /*
   * R10-PTR-4. In an iframe mount what is on screen was measured in the
   * frame's window only, which reaches past the page around it wherever the
   * page has scrolled the frame partly away: with the caret above the
   * page's window F10 moved nothing and focused a toolbar no one could see.
   * The band is cut by the windows of the pages around the frame, and a
   * scroll of those pages is heard as the ground moving: a short cell they
   * scroll away takes the caret's toolbar with it, as an inner scroller's
   * does (TB5k). The probe: 60 lines in cell 1:1, "line 0" brought 40px
   * below the frame's top, the frame 100px down the page, a click in "line
   * 0", the page wheeled until the caret is 60px above its window; a short
   * cell as the control. Layout and frames: e2e.
   */
  test('TB5y F10 in an iframe mount brings back a caret the page around the frame scrolled away', async ({
    page,
  }) => {
    for (const tall of [true, false]) {
      const label = tall ? 'tall cell' : 'short cell';
      const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
      await editor.load({ doc: 'table', mount: 'iframe' });
      await page.evaluate((tall) => {
        document.body.classList.add('scrolling');
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks.find((block) => block.id === 'tbl')!.rows![1]![1] = [
          {
            text: tall ? Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') : 'short',
          },
        ];
        ed.setDocument(doc);
      }, tall);
      const cell = editor.cell('tbl', 1, 1);
      await cell.evaluate((element) => {
        const range = document.createRange();
        range.setStart(element.firstChild!, 0);
        range.setEnd(element.firstChild!, 1);
        element.ownerDocument.defaultView!.scrollBy(0, range.getBoundingClientRect().top - 40);
      });
      await page.evaluate(() =>
        window.scrollTo(
          0,
          document.querySelector('#frame')!.getBoundingClientRect().top + scrollY - 100,
        ),
      );
      await editor.settleScroll();
      const point = await editor.pointAt(cell, 2);
      await page.mouse.click(point.x, point.y);
      await expect(cell, label).toBeFocused();
      const toolbar = editor.portal('table-toolbar');
      await expect(toolbar, label).toBeVisible();
      await page.mouse.move(20, 700);
      await page.mouse.wheel(0, Math.round(point.y + 60));
      await editor.settleScroll();
      expect((await editor.pointAt(cell, 2)).y, `${label}: precondition`).toBeLessThan(0);

      if (!tall) {
        // The page around the frame took the short cell out of sight, and
        // the toolbar with it -- heard as a scroll of the ground, as one
        // inside the frame is -- and brings them back together.
        await expect(toolbar, `${label}: gone with its cell`).toBeHidden();
        await page.mouse.wheel(0, -Math.round(point.y + 60));
        await editor.settleScroll();
        await expect(toolbar, `${label}: back with its cell`).toBeVisible();
        await page.mouse.wheel(0, Math.round(point.y + 60));
        await editor.settleScroll();
      }

      await page.keyboard.press('F10');
      await expect(toolbar.getByRole('button').nth(0), label).toBeFocused();
      await editor.settleScroll();
      const caret = await editor.pointAt(cell, 2);
      const height = page.viewportSize()!.height;
      expect(caret.y, `${label}: the caret is back on screen`).toBeGreaterThan(0);
      expect(caret.y, label).toBeLessThan(height);
      // In the top page's viewport, as Playwright measures inside a frame.
      const bar = (await toolbar.boundingBox())!;
      expect(bar.y, `${label}: the toolbar is on screen`).toBeGreaterThanOrEqual(0);
      await page.keyboard.press('Escape');
    }
  });

  /*
   * R11-PTR-3. An iframe mount whose frame is taller than what the page
   * around it shows -- a content-sized embed taller than the window, or a
   * frame in a scrolling pane of the page (a docs preview, a Storybook
   * canvas). What was shown, and the room above and below the table, were
   * measured in the frame's own window: a row taller than the page's window
   * but not the frame's was the toolbar's anchor, which was drawn by the
   * row, away from the caret (below the window in the probe, 1029..1065 with
   * the caret at 317); F10 focused it there, and Firefox and WebKit scrolled
   * the caret away to show it. And the toolbar, placed by the frame's window,
   * went above a caret near the top of the pane, where the pane hides it.
   * The band is cut by the page's window and the pane (`#visibleBand`,
   * `#frameBand`), and the toolbar is held inside it. The probe: a 900x1400
   * frame, the table between two paragraphs with 500 seeded words in cell
   * 1:0, a click in it mid-window; in the pane (420px tall) the caret then
   * brought 15px under the pane's top, and F10. Layout and frames: e2e.
   */
  test('TB5za the caret’s table toolbar stays beside the caret in a frame taller than what shows it', async ({
    page,
  }) => {
    for (const shape of ['taller than the window', 'in a scrolling pane'] as const) {
      const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
      await editor.load({ doc: 'table', mount: 'iframe' });
      await page.evaluate(
        ({ shape, text }) => {
          const frame = document.getElementById('frame')!;
          frame.style.cssText = 'display:block;width:900px;height:1400px;border:0';
          const stage = document.getElementById('stage')!;
          stage.style.maxWidth = 'none';
          if (shape === 'in a scrolling pane') {
            stage.id = 'pane';
            stage.style.cssText = 'height:420px;overflow:auto;border:2px solid #888;margin:0';
          }
          const ed = window.__e2e.editor;
          ed.setDocument({
            blocks: [
              { id: 'p0', type: 'paragraph', content: [{ text: 'Before' }], depth: 0 },
              {
                id: 'tbl',
                type: 'table',
                content: [],
                depth: 0,
                rows: [
                  [[{ text: 'A' }], [{ text: 'B' }]],
                  [[{ text }], [{ text: 'short' }]],
                ],
              },
              { id: 'p1', type: 'paragraph', content: [{ text: 'After' }], depth: 0 },
            ],
          });
        },
        { shape, text: seededWords(500, 3) },
      );
      await editor.settle();
      const height = page.viewportSize()!.height;
      const cell = editor.cell('tbl', 1, 0);
      const box = (await cell.boundingBox())!;
      expect(
        box.height,
        `${shape}: precondition, the row is taller than the window`,
      ).toBeGreaterThan(height);
      expect(box.height, `${shape}: precondition, but not than the frame`).toBeLessThan(1400);
      const pane =
        shape === 'in a scrolling pane' ? (await page.locator('#pane').boundingBox())! : null;
      const shown = pane
        ? { top: pane.y + 2, bottom: pane.y + 2 + 420 }
        : { top: 0, bottom: height };
      const caretLine = () =>
        cell.evaluate((element) => {
          // The character at the caret, or before it at the very end.
          const range = element.ownerDocument.getSelection()!.getRangeAt(0).cloneRange();
          const text = range.startContainer as Text;
          const at = range.startOffset < text.length ? range.startOffset : range.startOffset - 1;
          range.setStart(text, at);
          range.setEnd(text, at + 1);
          const line = range.getBoundingClientRect();
          const frame = element.ownerDocument.defaultView!.frameElement!.getBoundingClientRect();
          return { top: frame.top + line.top, bottom: frame.top + line.bottom };
        });
      const toolbar = editor.portal('table-toolbar');
      const beside = async (label: string) => {
        const line = await caretLine();
        const bar = (await toolbar.boundingBox())!;
        expect(bar.y, `${shape}, ${label}: the toolbar is shown`).toBeGreaterThanOrEqual(
          shown.top - 1,
        );
        expect(bar.y + bar.height, `${shape}, ${label}: the toolbar is shown`).toBeLessThanOrEqual(
          shown.bottom + 1,
        );
        const gap = bar.y >= line.bottom ? bar.y - line.bottom : line.top - (bar.y + bar.height);
        expect(gap, `${shape}, ${label}: beside the caret's line`).toBeGreaterThanOrEqual(-1);
        expect(gap, `${shape}, ${label}: beside the caret's line`).toBeLessThan(16);
      };

      await page.mouse.click(box.x + box.width / 2, Math.max(box.y + 20, shown.top + 230));
      await expect(cell).toBeFocused();
      await expect(toolbar).toBeVisible();
      await beside('click');

      if (pane) {
        const line = await caretLine();
        await page
          .locator('#pane')
          .evaluate((element, by) => (element.scrollTop += by), line.top - shown.top - 15);
        await editor.settle();
        await expect(toolbar).toBeVisible();
        await beside('pane scrolled');
      }

      const scrolled = () =>
        page.evaluate(() => [window.scrollY, document.getElementById('pane')?.scrollTop ?? 0]);
      const before = await scrolled();
      await page.keyboard.press('F10');
      await expect(toolbar.getByRole('button').nth(0)).toBeFocused();
      await editor.settle();
      expect(await scrolled(), `${shape}: F10 moved nothing`).toEqual(before);
      await beside('F10');
      await page.keyboard.press('Escape');
      await expect(cell).toBeFocused();

      // Enter on the last line the page shows: the new line is brought into
      // what shows it (`#revealBox`, through the pane), toolbar and all.
      const last = await cell.evaluate((element, bottom) => {
        const text = element.firstChild as Text;
        const frame = element.ownerDocument.defaultView!.frameElement!.getBoundingClientRect();
        const range = element.ownerDocument.createRange();
        let best = { x: 0, y: 0 };
        for (let i = 0; i < text.length; i++) {
          range.setStart(text, i);
          range.setEnd(text, i + 1);
          const box = range.getBoundingClientRect();
          if (frame.top + box.bottom < bottom - 4) {
            best = { x: frame.left + box.left, y: frame.top + (box.top + box.bottom) / 2 };
          }
        }
        return best;
      }, shown.bottom);
      await page.mouse.click(last.x, last.y);
      await expect(cell).toBeFocused();
      await page.keyboard.press('Enter');
      await editor.settle();
      await editor.settle();
      const line = await caretLine();
      expect(line.top, `${shape}: the new line is shown`).toBeGreaterThanOrEqual(shown.top - 1);
      expect(line.bottom, `${shape}: the new line is shown`).toBeLessThanOrEqual(shown.bottom + 1);
      await beside('Enter');
    }
  });

  /*
   * R11-RV-PTR-2. In a plain mount the toolbar is portalled to the page, and
   * no scroller around the editor clips it, so the room above and below a
   * table is measured where the toolbar can be drawn -- the window -- not
   * inside such a scroller. Measured inside one, a table filling a 190px
   * pane had no room, and each row's toolbar was drawn over the table's own
   * rows instead of above the pane, over the page. The probe: a 190px pane
   * holding a paragraph, a four-row table and two paragraphs, scrolled so
   * the table's top is 10px under the pane's, a click in each row.
   * Layout: e2e.
   */
  test('TB5zb a table filling a scrolling pane keeps its toolbar off its rows', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await page.evaluate(() => {
      const stage = document.getElementById('stage')!;
      stage.id = 'pane';
      stage.style.cssText = 'height:190px;overflow:auto;border:1px solid #888;margin:60px 0 0';
      const p = (id: string, text: string) => ({
        id,
        type: 'paragraph' as const,
        depth: 0,
        content: [{ text }],
      });
      window.__e2e.editor.setDocument({
        blocks: [
          p('a', 'Above'),
          {
            id: 'tbl',
            type: 'table',
            content: [],
            depth: 0,
            rows: Array.from({ length: 4 }, (_, r) => [
              [{ text: `r${r}c0` }],
              [{ text: `r${r}c1` }],
            ]),
          },
          p('b', 'Below'),
          p('c', 'More'),
        ],
      });
      const table = document.querySelector('[data-block-id="tbl"] table')!.getBoundingClientRect();
      stage.scrollTop += table.top - stage.getBoundingClientRect().top - 10;
    });
    await editor.settle();
    const toolbar = editor.portal('table-toolbar');
    const table = (await editor.block('tbl').locator('table').boundingBox())!;
    const pane = (await page.locator('#pane').boundingBox())!;
    expect(table.y + table.height, 'precondition: the table fits in the pane').toBeLessThan(
      pane.y + pane.height,
    );

    for (let row = 0; row < 4; row++) {
      const cell = editor.cell('tbl', row, 1);
      const box = (await cell.boundingBox())!;
      await page.mouse.click(box.x + box.width - 5, box.y + box.height / 2);
      await expect(cell).toBeFocused();
      await expect(toolbar).toBeVisible();
      const bar = (await toolbar.boundingBox())!;
      const rows = await editor
        .block('tbl')
        .locator('tr')
        .evaluateAll((trs) =>
          trs.map((tr) => {
            const rect = tr.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom };
          }),
        );
      const covered = rows.filter((r) => bar.y < r.bottom - 2 && bar.y + bar.height > r.top + 2);
      expect(covered, `row ${row}: the toolbar covers no row`).toEqual([]);
    }
  });

  /*
   * R12-PTR-1. With `portalContainer` in the page around an iframe mount the
   * toolbar is `position: fixed` in that page, drawn over a scrolling pane
   * the frame sits in. Its room above and below the table was still
   * measured inside that pane (`#frameBand`): a table filling the pane had
   * none, the row became the anchor, and each row's toolbar was drawn over
   * the rows above the caret's (303..339 over row 0 of a table at 308..568
   * in a pane at 300..600). It is measured in that page's window
   * (`#drawArea`), so the toolbar goes above the table, over the page. The
   * probe: 12 paragraphs, a 7-row table and 12 more in a 1400px frame in a
   * 300px pane at the window's y 300, the table's top 8px under the pane's,
   * a click in each row. Layout and frames: e2e.
   */
  test('TB5zc a table filling a pane around an iframe mount keeps the outer page’s toolbar off its rows', async ({
    page,
  }) => {
    const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
    const toolbar = page.locator('.neditor-portal.neditor-table-toolbar');
    await editor.load({ doc: 'table', mount: 'iframe', portal: 'body' });
    await page.evaluate(() => {
      const p = (id: string, text: string) => ({
        id,
        type: 'paragraph' as const,
        depth: 0,
        content: [{ text }],
      });
      window.__e2e.editor.setDocument({
        blocks: [
          ...Array.from({ length: 12 }, (_, i) => p(`b${i}`, `Before ${i}`)),
          {
            id: 'tbl',
            type: 'table',
            content: [],
            depth: 0,
            rows: Array.from({ length: 7 }, (_, r) => [
              [{ text: `r${r}c0` }],
              [{ text: `r${r}c1` }],
              [{ text: `r${r}c2` }],
            ]),
          },
          ...Array.from({ length: 12 }, (_, i) => p(`a${i}`, `After ${i}`)),
        ],
      });
      const frame = document.querySelector<HTMLIFrameElement>('#frame')!;
      frame.style.cssText = 'display:block;width:900px;height:1400px;border:0';
      const stage = document.getElementById('stage')!;
      stage.id = 'pane';
      stage.style.cssText =
        'height:300px;overflow:auto;border:2px solid #888;box-sizing:border-box;margin:0';
      stage.style.marginTop = `${300 - stage.getBoundingClientRect().top}px`;
      const table = frame
        .contentDocument!.querySelector('[data-block-id="tbl"] table')!
        .getBoundingClientRect();
      stage.scrollTop +=
        frame.getBoundingClientRect().top + table.top - (stage.getBoundingClientRect().top + 8);
    });
    await editor.settle();
    const height = page.viewportSize()!.height;
    const table = (await editor.block('tbl').locator('table').boundingBox())!;
    const pane = (await page.locator('#pane').boundingBox())!;
    expect(table.y, 'precondition: the table starts in the pane').toBeGreaterThan(pane.y);
    expect(table.y + table.height, 'precondition: the table fits in the pane').toBeLessThan(
      pane.y + pane.height,
    );

    for (let row = 0; row < 7; row++) {
      const cell = editor.cell('tbl', row, 1);
      const box = (await cell.boundingBox())!;
      await page.mouse.click(box.x + box.width - 5, box.y + box.height / 2);
      await expect(cell).toBeFocused();
      await expect(toolbar).toBeVisible();
      await editor.settle();
      const bar = (await toolbar.boundingBox())!;
      const rows = await editor
        .block('tbl')
        .locator('tr')
        .evaluateAll((trs) =>
          trs.map((tr) => {
            const rect = tr.getBoundingClientRect();
            const frame = tr.ownerDocument.defaultView!.frameElement!.getBoundingClientRect();
            return { top: frame.top + rect.top, bottom: frame.top + rect.bottom };
          }),
        );
      const covered = rows.filter((r) => bar.y < r.bottom - 2 && bar.y + bar.height > r.top + 2);
      expect(covered, `row ${row}: the toolbar covers no row`).toEqual([]);
      expect(bar.y, `row ${row}: in the window`).toBeGreaterThanOrEqual(0);
      expect(bar.y + bar.height, `row ${row}: in the window`).toBeLessThanOrEqual(height);
    }
  });

  /*
   * R12-PTR-1's sibling: the frame's own window does not clip a toolbar the
   * page around it draws either. A 300px frame at the window's y 300 holding
   * only a 7-row table: measured in the frame's window the table had no
   * room above or below it, the row became the anchor, and the toolbar was
   * drawn over the rows above the caret's (336..372 over a table at
   * 306..565, rounds 10 and 11 alike), with the page's window empty above
   * the frame. Measured in the page's window (`#drawArea`) it goes above
   * the table. Layout and frames: e2e.
   */
  test('TB5zd a table filling a short frame keeps the outer page’s toolbar off its rows', async ({
    page,
  }) => {
    const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
    const toolbar = page.locator('.neditor-portal.neditor-table-toolbar');
    await editor.load({ doc: 'table', mount: 'iframe', portal: 'body' });
    await page.evaluate(() => {
      window.__e2e.editor.setDocument({
        blocks: [
          {
            id: 'tbl',
            type: 'table',
            content: [],
            depth: 0,
            rows: Array.from({ length: 7 }, (_, r) => [
              [{ text: `r${r}c0` }],
              [{ text: `r${r}c1` }],
            ]),
          },
        ],
      });
      const frame = document.querySelector<HTMLIFrameElement>('#frame')!;
      frame.style.cssText = 'display:block;width:900px;height:300px;border:0';
      frame.contentDocument!.body.style.margin = '0';
      const stage = document.getElementById('stage')!;
      stage.style.cssText = 'margin:0;padding:0';
      stage.style.marginTop = `${300 - frame.getBoundingClientRect().top}px`;
    });
    await editor.settle();
    const frame = (await page.locator('#frame').boundingBox())!;
    const table = (await editor.block('tbl').locator('table').boundingBox())!;
    expect(table.y - frame.y, 'precondition: no room above it in the frame').toBeLessThan(40);
    expect(
      frame.y + frame.height - (table.y + table.height),
      'precondition: nor below it',
    ).toBeLessThan(40);

    const cell = editor.cell('tbl', 2, 1);
    const box = (await cell.boundingBox())!;
    await page.mouse.click(box.x + box.width - 5, box.y + box.height / 2);
    await expect(cell).toBeFocused();
    await expect(toolbar).toBeVisible();
    await editor.settle();
    const bar = (await toolbar.boundingBox())!;
    expect(bar.y + bar.height, 'above the table, over the page').toBeLessThanOrEqual(table.y + 1);
    expect(bar.y, 'in the window').toBeGreaterThanOrEqual(0);
  });

  /*
   * R12-RV-PTR-1/2. The room a toolbar drawn in the page around the frame
   * needs above or below the table is in that page's pixels, and the room
   * there is (`#drawArea`) measured in the frame's: through the frame's
   * offset and the scale it is drawn at. Compared unscaled, a frame at
   * `scale(0.5)` holding a 40-row table at the window's y 43..783 read a
   * room of 86 frame pixels above it as enough for the 52 the toolbar asked
   * (it is 43 of the page's, for a 44px toolbar and its gap), anchored the
   * toolbar to the table, and the clamp drew it at 756..792 over the last
   * row's caret -- in a content-sized frame and in one taller than the window
   * alike -- and at `scale(1.5)` the room above was understated, and the
   * toolbar went over the rows. Each shape pins one term: the scale either
   * way, the offset (a table ending 27px above the window's bottom, a frame
   * 30px down: unshifted, the window's whole bottom looked free), the scale
   * of the draw area itself. The placements are soft expectations, so a
   * failure names every shape it reaches. Layout and frames: e2e.
   */
  test('TB5ze the outer page’s table toolbar measures its room through the frame’s offset and scale', async ({
    page,
  }) => {
    const shapes = [
      {
        label: 'scale(0.5), 40 rows, last row typed in',
        scale: 0.5,
        rows: 40,
        top: 40,
        tall: false,
        row: 39,
        expect: 'beside its row',
      },
      {
        label: 'scale(0.5), a frame taller than the window',
        scale: 0.5,
        rows: 40,
        top: 40,
        tall: true,
        row: 39,
        expect: 'beside its row',
      },
      {
        label: 'scale(1.5), 13 rows at y 50',
        scale: 1.5,
        rows: 13,
        top: 50,
        tall: false,
        row: 6,
        expect: 'above the table',
      },
      {
        label: 'scale(0.5), 39 rows at y 60',
        scale: 0.5,
        rows: 39,
        top: 60,
        tall: false,
        row: 38,
        expect: 'above the table',
      },
      {
        label: 'unscaled, 20 rows at y 30',
        scale: 1,
        rows: 20,
        top: 30,
        tall: false,
        row: 19,
        expect: 'beside its row',
      },
    ] as const;

    for (const shape of shapes) {
      const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
      const toolbar = page.locator('.neditor-portal.neditor-table-toolbar');
      await editor.load({ doc: 'empty', mount: 'iframe', portal: 'body' });
      await page.evaluate((shape) => {
        window.__e2e.editor.setDocument({
          blocks: [
            {
              id: 'tbl',
              type: 'table',
              content: [],
              depth: 0,
              rows: Array.from({ length: shape.rows }, (_, r) => [
                [{ text: `r${r}c0` }],
                [{ text: `r${r}c1` }],
              ]),
            },
          ],
        });
        const frame = document.querySelector<HTMLIFrameElement>('#frame')!;
        const inner = frame.contentDocument!;
        inner.body.style.margin = '0';
        if (shape.tall) inner.body.style.paddingTop = '900px';
        const height = inner.getElementById('editor')!.getBoundingClientRect().bottom;
        frame.style.cssText =
          `display:block;width:900px;height:${Math.ceil(height + (shape.tall ? 900 : 2))}px;` +
          `border:0;transform:scale(${shape.scale});transform-origin:0 0`;
        document.body.style.minHeight = '3000px';
        const stage = document.getElementById('stage')!;
        stage.style.cssText = 'margin:0;padding:0';
        const lead = shape.tall ? inner.querySelector('table')!.getBoundingClientRect().top : 0;
        stage.style.marginTop = `${shape.top - frame.getBoundingClientRect().top - lead * shape.scale}px`;
      }, shape);
      await editor.settle();

      /** Rows and the clicked cell, drawn in the page's window. */
      const drawn = () =>
        page.evaluate((row) => {
          const frame = document.querySelector<HTMLIFrameElement>('#frame')!;
          const box = frame.getBoundingClientRect();
          const scale = box.height / frame.offsetHeight;
          const lift = (r: DOMRect) => ({
            top: box.top + r.top * scale,
            bottom: box.top + r.bottom * scale,
            x: box.left + ((r.left + r.right) / 2) * scale,
          });
          const doc = frame.contentDocument!;
          return {
            rows: [...doc.querySelectorAll('tr')].map((tr) => lift(tr.getBoundingClientRect())),
            cell: lift(doc.querySelector(`[data-cell="${row}:1"]`)!.getBoundingClientRect()),
          };
        }, shape.row);
      const before = await drawn();
      const height = page.viewportSize()!.height;
      const table = { top: before.rows[0]!.top, bottom: before.rows.at(-1)!.bottom };
      expect(
        table.top,
        `${shape.label}: precondition, the table starts in the window`,
      ).toBeGreaterThan(0);
      expect(table.bottom, `${shape.label}: precondition, and ends in it`).toBeLessThan(height);

      await page.mouse.click(before.cell.x, (before.cell.top + before.cell.bottom) / 2);
      await expect(editor.cell('tbl', shape.row, 1)).toBeFocused();
      await page.keyboard.type('typed');
      await expect(toolbar).toBeVisible();
      await editor.settle();
      const bar = (await toolbar.boundingBox())!;
      const { rows } = await drawn();
      const own = rows[shape.row]!;
      expect
        .soft(
          bar.y < own.bottom - 1 && bar.y + bar.height > own.top + 1,
          `${shape.label}: the toolbar is off the caret’s row`,
        )
        .toBe(false);
      expect.soft(bar.y, `${shape.label}: in the window`).toBeGreaterThanOrEqual(0);
      expect.soft(bar.y + bar.height, `${shape.label}: in the window`).toBeLessThanOrEqual(height);

      if (shape.expect === 'above the table') {
        expect
          .soft(bar.y + bar.height, `${shape.label}: above the table`)
          .toBeLessThanOrEqual(rows[0]!.top + 1);
      } else {
        expect
          .soft(bar.y + bar.height, `${shape.label}: beside its row`)
          .toBeLessThanOrEqual(own.top + 1);
        expect
          .soft(own.top - (bar.y + bar.height), `${shape.label}: beside its row`)
          .toBeLessThan(16);
      }
    }
  });

  /*
   * R12-RV2-PTR-1. Enter in a cell taller than the window brings the new line
   * into view the least way, with room over it for the table toolbar
   * (`#placeAfterBreak`, `#revealBox`). That room is the toolbar's height and
   * gap in the frame's pixels (`#tableToolbarRoom`), carried out through the
   * frame at its scale; a toolbar drawn in the page around a scaled frame is
   * measured in the page's pixels, and taken for frame pixels the room came
   * out scaled twice: at `scale(1.5)` Enter on the window's top line scrolled
   * 28px where 6 were needed and left the line at y 66, at `scale(0.5)` it
   * left the line at y 22, under the room, and the toolbar went below it.
   * The probe: a cell of 90 lines in a content-sized frame at that scale,
   * the page scrolled so line 30 is at the window's top, a click past its
   * end, Enter. The new line lands exactly the toolbar and its gap below the
   * window's top. Layout and frames: e2e.
   */
  test('TB5zf Enter on the window’s top line of a scaled frame leaves room for the outer page’s toolbar, and no more', async ({
    page,
  }) => {
    for (const scale of [1.5, 0.5]) {
      const label = `scale(${scale})`;
      const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
      const toolbar = page.locator('.neditor-portal.neditor-table-toolbar');
      await editor.load({ doc: 'empty', mount: 'iframe', portal: 'body' });
      await page.evaluate((scale) => {
        const text = Array.from({ length: 90 }, (_, i) => `line ${i}`).join('\n');
        window.__e2e.editor.setDocument({
          blocks: [
            { id: 'p', type: 'paragraph', depth: 0, content: [{ text: 'before' }] },
            {
              id: 'tbl',
              type: 'table',
              depth: 0,
              content: [],
              rows: [[[{ text }], [{ text: 'b' }]]],
            },
            { id: 'q', type: 'paragraph', depth: 0, content: [{ text: 'after' }] },
          ],
        });
        const frame = document.querySelector<HTMLIFrameElement>('#frame')!;
        const inner = frame.contentDocument!;
        inner.body.style.margin = '0';
        const height = Math.ceil(
          inner.getElementById('editor')!.getBoundingClientRect().bottom + 40,
        );
        frame.style.cssText =
          `display:block;width:900px;height:${height}px;border:0;transform:scale(${scale});` +
          `transform-origin:0 0;margin-bottom:${height * scale - height + 400}px`;
        document.getElementById('stage')!.style.margin = '0';
      }, scale);
      await editor.settle();

      /** Where `text` starts, or the caret's line, drawn in the page's window. */
      const line = (text: string | null) =>
        page.evaluate((text) => {
          const frame = document.querySelector<HTMLIFrameElement>('#frame')!;
          const box = frame.getBoundingClientRect();
          const scale = box.height / frame.offsetHeight;
          const doc = frame.contentDocument!;
          const node = doc.querySelector('[data-cell="0:0"]')!.firstChild as Text;
          const range = doc.createRange();
          if (text === null) {
            // The character at the caret: the line feed after the new line.
            const at = doc.getSelection()!.focusOffset;
            range.setStart(node, at);
            range.setEnd(node, at + 1);
          } else {
            const at = node.data.indexOf(text);
            range.setStart(node, at);
            range.setEnd(node, at + text.length);
          }
          const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
          return {
            top: box.top + rect.top * scale,
            bottom: box.top + rect.bottom * scale,
            right: box.left + rect.right * scale,
          };
        }, text);

      const at = await line('line 30');
      await page.evaluate((by) => window.scrollBy(0, by), at.top - 2);
      await editor.settle();
      const placed = await line('line 30');
      expect(Math.abs(placed.top - 2), `${label}: precondition, line 30 at the top`).toBeLessThan(
        2,
      );
      await page.mouse.click(placed.right + 6, (placed.top + placed.bottom) / 2);
      await expect(editor.cell('tbl', 0, 0)).toBeFocused();
      await expect(toolbar).toBeVisible();
      const room = (await toolbar.boundingBox())!.height + 8;
      const before = await page.evaluate(() => window.scrollY);
      expect(placed.bottom, `${label}: precondition, the new line needs a scroll`).toBeLessThan(
        room,
      );

      await page.keyboard.press('Enter');
      await editor.settle();
      await editor.settle();
      expect(await editor.selection(), label).toMatchObject({ cell: { row: 0, column: 0 } });
      const caret = await line(null);
      const scrolled = before - (await page.evaluate(() => window.scrollY));
      expect
        .soft(caret.top, `${label}: the new line has the toolbar’s room above it`)
        .toBeGreaterThanOrEqual(room - 1);
      expect.soft(caret.top, `${label}: and no more`).toBeLessThanOrEqual(room + 1);
      expect
        .soft(scrolled, `${label}: the page scrolled no more than that room`)
        .toBeLessThanOrEqual(room);
      const bar = (await toolbar.boundingBox())!;
      expect
        .soft(bar.y + bar.height, `${label}: the toolbar above the new line`)
        .toBeLessThanOrEqual(caret.top + 1);
    }
  });

  /*
   * R5-PTR-5. While the toolbar held focus the selection sync left it alone,
   * and a scroll is no selectionchange: the toolbar stayed where it was drawn,
   * over the rows the page had scrolled under it. Layout: e2e only.
   */
  test('TB5d the table toolbar F10 entered follows its table when the page scrolls', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table', scroll: 1 });
    await editor.cell('tbl', 1, 1).scrollIntoViewIfNeeded();
    await editor.cell('tbl', 1, 1).click();
    await page.keyboard.press('F10');
    const buttons = editor.portal('table-toolbar').getByRole('button');
    await expect(buttons.nth(0)).toBeFocused();

    const gap = async () => {
      const bar = (await editor.portal('table-toolbar').boundingBox())!;
      const table = (await editor.block('tbl').boundingBox())!;
      return Math.round(table.y - (bar.y + bar.height));
    };
    const before = await gap();
    await page.mouse.move(600, 400);
    await page.mouse.wheel(0, 150);
    await editor.settleScroll();
    await expect.poll(gap).toBe(before);
    await expect(buttons.nth(0)).toBeFocused();

    // R6-PTR-1. Holding focus, it keeps following its cell even once the
    // table is out of sight: hiding it would drop that focus on the page, and
    // a scroll is not a choice of where to go.
    await page.mouse.wheel(0, 900);
    await editor.settleScroll();
    expect((await editor.block('tbl').boundingBox())!.y + 200).toBeLessThan(0);
    await expect(editor.portal('table-toolbar')).toBeVisible();
    await expect(buttons.nth(0)).toBeFocused();
  });

  /*
   * R6-PTR-1. With only the caret in a cell, the toolbar was clamped to the
   * edge of the window once its table had scrolled away, drawn over unrelated
   * text -- or, for an inner scroller, over the host page above it. It goes
   * with its cell, as the format toolbar goes with its caret, and comes back
   * with it. The probe's two grounds: the page, and a fixed-height scroller
   * with the page still. Layout and real wheel scrolling: e2e only.
   */
  test('TB5f the caret’s table toolbar leaves with its cell and comes back with it', async ({
    editor,
    page,
  }) => {
    for (const ground of ['page', 'inner scroller'] as const) {
      await editor.load({ doc: 'table', scroll: ground === 'page' ? 1 : 0 });
      if (ground === 'inner scroller') {
        await page.evaluate(() => {
          const ed = window.__e2e.editor;
          const doc = ed.getDocument();
          doc.blocks.push(
            ...Array.from({ length: 30 }, (_, i) => ({
              id: `z${i}`,
              type: 'paragraph' as const,
              depth: 0,
              content: [{ text: `Tail ${i}` }],
            })),
          );
          ed.setDocument(doc);
          const host = ed.element.parentElement!;
          host.style.height = '260px';
          host.style.overflow = 'auto';
        });
      }
      const cell = editor.cell('tbl', 1, 1);
      await cell.scrollIntoViewIfNeeded();
      await editor.settleScroll();
      await cell.click();
      const toolbar = editor.portal('table-toolbar');
      await expect(toolbar, ground).toBeVisible();

      const box = (await cell.boundingBox())!;
      await page.mouse.move(box.x + 200, box.y);
      await page.mouse.wheel(0, ground === 'page' ? 900 : 250);
      await editor.settleScroll();
      await expect
        .poll(() =>
          cell.evaluate((element, inner) => {
            const scroller = inner ? element.closest('.neditor')!.parentElement! : null;
            const top = scroller ? scroller.getBoundingClientRect().top : 0;
            return element.getBoundingClientRect().bottom < top;
          }, ground === 'inner scroller'),
        )
        .toBe(true);
      await expect(toolbar, `${ground}: gone with its cell`).toBeHidden();
      await expect(cell, ground).toBeFocused();

      await page.mouse.wheel(0, ground === 'page' ? -900 : -250);
      await editor.settleScroll();
      await expect(toolbar, `${ground}: back with its cell`).toBeVisible();
      // Against its table again, above or below it, not over it.
      const bar = (await toolbar.boundingBox())!;
      const table = (await editor.block('tbl').boundingBox())!;
      expect(bar.y + bar.height <= table.y + 1 || bar.y >= table.y + table.height - 1, ground).toBe(
        true,
      );
    }
  });

  /*
   * R5-PTR-3. Shift+F10 is the keyboard's context menu, and Ctrl, Alt and
   * Meta with F10 are the platform's or the page's: each focused the table
   * toolbar and was swallowed.
   */
  test('TB5e a modified F10 is not the table toolbar’s', async ({ editor, page }) => {
    for (const key of ['Shift+F10', 'Control+F10', 'Alt+F10', 'Meta+F10']) {
      await editor.load({ doc: 'table' });
      await page.evaluate(() => {
        const seen: string[] = [];
        (window as unknown as { seen: string[] }).seen = seen;
        document.addEventListener('keydown', (event) => {
          if (event.key === 'F10') seen.push(String(event.defaultPrevented));
        });
      });
      await editor.cell('tbl', 1, 1).click();
      await page.keyboard.press(key);
      await expect(editor.cell('tbl', 1, 1), key).toBeFocused();
      expect(
        await page.evaluate(() => (window as unknown as { seen: string[] }).seen),
        key,
      ).toEqual(['false']);
    }
  });

  test('TB6 deleting the last row or column empties the grid rather than removing the table', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await editor.setDocument({
      blocks: [{ id: 'tbl', type: 'table', depth: 0, content: [], rows: [[[{ text: 'only' }]]] }],
    });
    await editor.placeCaret('tbl', 0, 0, { row: 0, column: 0 });
    await editor.portal('table-toolbar').getByRole('button', { name: 'Delete this row' }).click();
    expect((await editor.blockData('tbl'))?.rows).toEqual([[[]]]);
    await page.keyboard.type('x');
    await editor
      .portal('table-toolbar')
      .getByRole('button', { name: 'Delete this column' })
      .click();
    expect((await editor.blockData('tbl'))?.rows).toEqual([[[]]]);
    expect(await editor.ids()).toEqual(['tbl']);
  });

  test('TB7 Escape in a cell selects the table; Mod+A takes the cell, then every block', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await editor.placeCaret('tbl', 1, 1, { row: 1, column: 0 });
    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual(['tbl']);

    await editor.placeCaret('tbl', 1, 1, { row: 1, column: 0 });
    await page.keyboard.press(`${MOD}+a`);
    expect(await editor.selection()).toMatchObject({
      cell: { row: 1, column: 0 },
      range: { start: 0, end: 2 },
    });
    await page.keyboard.press(`${MOD}+a`);
    expect(await editor.selected()).toEqual(['before', 'tbl', 'after']);
  });

  test('TB8 the table toolbar shows even with toolbar:false; a wide table scrolls inside itself', async ({
    editor,
  }) => {
    await editor.load({ doc: 'table', toolbar: false });
    await editor.placeCaret('tbl', 0, 0, { row: 0, column: 0 });
    await expect(editor.portal('table-toolbar')).toBeVisible();

    const wide = Array.from({ length: 3 }, (_, row) =>
      Array.from({ length: 30 }, (_, column) => [{ text: `row ${row} column ${column}` }]),
    );
    await editor.setDocument({
      blocks: [{ id: 'tbl', type: 'table', depth: 0, content: [], rows: wide }],
    });
    const overflow = await editor
      .block('tbl')
      .locator('.neditor-table')
      .evaluate((element) => ({
        scrolls: element.scrollWidth > element.clientWidth,
        page: document.documentElement.scrollWidth <= window.innerWidth,
      }));
    expect(overflow).toEqual({ scrolls: true, page: true });
    await editor.placeCaret('tbl', 0, 0, { row: 1, column: 29 });
    await editor.type('!');
    expect((await editor.blockData('tbl'))?.rows?.[1]?.[29]).toEqual([
      { text: '!row 1 column 29' },
    ]);
  });

  test('TB10 Shift and Mod+Shift arrows in a cell extend and move, as in any block (STR-10)', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await editor.clickAt('before', 3);
    // Real input from the start: click into a cell, End to its end.
    const cell = editor.cell('tbl', 0, 1);
    const box = (await cell.boundingBox())!;
    await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
    expect(await caretCell(editor)).toBe('0:1');
    expect((await editor.selection())?.range.start).toBe(2);

    await page.keyboard.press('Shift+ArrowDown');
    expect(await editor.selected()).toEqual(['tbl', 'after']);

    await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
    await page.keyboard.press(`${MOD}+Shift+ArrowDown`);
    expect(await editor.ids()).toEqual(['before', 'after', 'tbl']);
    expect(await caretCell(editor)).toBe('0:1');

    const lower = (await editor.cell('tbl', 1, 0).boundingBox())!;
    await page.mouse.click(lower.x + 3, lower.y + lower.height / 2);
    expect((await editor.selection())?.range.start).toBe(0);
    await page.keyboard.press(`${MOD}+Shift+ArrowUp`);
    expect(await editor.ids()).toEqual(['before', 'tbl', 'after']);
    expect(await caretCell(editor)).toBe('1:0');
  });

  test('TB9 table Markdown is a GFM table', async ({ editor }) => {
    await editor.load({ doc: 'table' });
    expect(await editor.markdown()).toContain(
      '| H1 | H2 | H3 |\n| --- | --- | --- |\n| a1 | a2 | a3 |\n| b1 | b2 | b3 |',
    );
  });

  // e2e only: where the toolbar lands is layout.
  test('TB10 in a table taller than the screen the toolbar sits beside the caret row, never over its cell', async ({
    editor,
    page,
  }) => {
    // Was UI-5: anchored to the whole table it had no room above or below,
    // and the viewport clamp left it far from the caret, over the caret's cell.
    await editor.load({ doc: 'table' });
    const t = (text: string) => [{ text }];
    await editor.setDocument({
      blocks: [
        { id: 'before', type: 'paragraph', content: t('Before'), depth: 0 },
        {
          id: 'tbl',
          type: 'table',
          content: [],
          depth: 0,
          rows: Array.from({ length: 40 }, (_, r) => [t(`r${r}c0`), t(`r${r}c1`), t(`r${r}c2`)]),
        },
        { id: 'after', type: 'paragraph', content: t('After'), depth: 0 },
      ],
    });
    const height = page.viewportSize()!.height;
    const toolbar = editor.portal('table-toolbar');
    const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
      !(
        a.y + a.height <= b.y ||
        a.y >= b.y + b.height ||
        a.x + a.width <= b.x ||
        a.x >= b.x + b.width
      );

    for (const offset of [400, height - 40]) {
      await editor.cell('tbl', 20, 1).evaluate((element, offset) => {
        window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - offset);
      }, offset);
      await editor.settleScroll();
      const point = await editor.pointAt(editor.cell('tbl', 20, 1), 2);
      await page.mouse.click(point.x, point.y);
      await editor.settle();
      await expect(toolbar).toBeVisible();

      const bar = (await toolbar.boundingBox())!;
      const cell = (await editor.cell('tbl', 20, 1).boundingBox())!;
      expect(overlaps(bar, cell), `toolbar over the caret cell at ${offset}px`).toBe(false);
      // Next to the caret's row, not pinned to an edge of the screen.
      expect(Math.abs(bar.y + bar.height - cell.y)).toBeLessThan(cell.height + 16);
    }
  });

  // e2e only: where the toolbar lands is layout.
  test('TB11 a table that only just fits the screen keeps the toolbar off the caret row', async ({
    editor,
    page,
  }) => {
    // Was R2-UI-10: all of the table was on screen, so the toolbar was anchored
    // to it -- with no room above or below, the clamp pulled it back over the
    // last row, onto the caret's cell (390x700, 17 rows).
    await page.setViewportSize({ width: 390, height: 700 });
    await editor.load({ doc: 'table' });
    const t = (text: string) => [{ text }];
    await editor.setDocument({
      blocks: [
        { id: 'before', type: 'paragraph', content: t('Before'), depth: 0 },
        {
          id: 'tbl',
          type: 'table',
          content: [],
          depth: 0,
          rows: Array.from({ length: 17 }, (_, r) => [t(`r${r}c0`), t(`r${r}c1`), t(`r${r}c2`)]),
        },
        { id: 'after', type: 'paragraph', content: t('After'), depth: 0 },
      ],
    });
    await editor.block('tbl').evaluate((element) => {
      window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 30);
    });
    await editor.settleScroll();
    const table = (await editor.block('tbl').locator('table').boundingBox())!;
    expect(table.y, 'the whole table is on screen').toBeGreaterThanOrEqual(0);
    expect(table.y + table.height).toBeLessThanOrEqual(700);
    expect(700 - (table.y + table.height), 'too little room below for the toolbar').toBeLessThan(
      52,
    );

    const cell = editor.cell('tbl', 16, 1);
    const point = await editor.pointAt(cell, 2);
    await page.mouse.click(point.x, point.y);
    await editor.settle();
    const toolbar = editor.portal('table-toolbar');
    await expect(toolbar).toBeVisible();
    const bar = (await toolbar.boundingBox())!;
    const box = (await cell.boundingBox())!;
    expect(
      bar.y + bar.height <= box.y || bar.y >= box.y + box.height,
      `toolbar ${bar.y}..${bar.y + bar.height} against the caret row ${box.y}..${box.y + box.height}`,
    ).toBe(true);
  });

  // e2e only: what a scroller clips is layout.
  test('TB12 a table scrolled half out of a scrolling root anchors the toolbar to the caret row, inside the root', async ({
    editor,
    page,
  }) => {
    // Was R3-PTR-7: inside the window counted as on screen, so the toolbar was
    // anchored to the table's hidden top and drawn over the host page above
    // the scroller.
    await editor.load({ doc: 'table' });
    const t = (text: string) => [{ text }];
    await editor.setDocument({
      blocks: [
        ...Array.from({ length: 10 }, (_, i) => ({
          id: `p${i}`,
          type: 'paragraph' as const,
          depth: 0,
          content: t(`Para ${i}`),
        })),
        {
          id: 'tbl',
          type: 'table',
          depth: 0,
          content: [],
          rows: Array.from({ length: 8 }, (_, r) => [0, 1, 2].map((c) => t(`r${r}c${c}`))),
        },
        ...Array.from({ length: 10 }, (_, i) => ({
          id: `q${i}`,
          type: 'paragraph' as const,
          depth: 0,
          content: t(`After ${i}`),
        })),
      ],
    });
    await page.addStyleTag({
      content: '#stage{margin-top:260px}#editor{height:360px;overflow-y:auto}',
    });
    await editor.root.evaluate((root) => {
      const table = root.querySelector('[data-block-id="tbl"]')!;
      root.scrollTop += table.getBoundingClientRect().top - root.getBoundingClientRect().top + 110;
    });
    await editor.settleScroll();
    const root = (await editor.root.boundingBox())!;
    const table = (await editor.block('tbl').locator('table').boundingBox())!;
    expect(table.y, 'the table top is scrolled out of the root').toBeLessThan(root.y);
    expect(table.y, 'but still inside the window').toBeGreaterThan(0);

    await editor.cell('tbl', 5, 1).click();
    await editor.settle();
    const toolbar = editor.portal('table-toolbar');
    await expect(toolbar).toBeVisible();
    const bar = (await toolbar.boundingBox())!;
    const row = (await editor.cell('tbl', 5, 1).boundingBox())!;
    expect(bar.y, 'inside the scrolling root').toBeGreaterThanOrEqual(root.y);
    expect(Math.abs(bar.y + bar.height - row.y), 'beside the caret row').toBeLessThan(
      row.height + 16,
    );
  });
});
