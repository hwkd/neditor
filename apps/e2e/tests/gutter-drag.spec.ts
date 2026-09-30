import { expect, MOD, test } from '../helpers/test.ts';
import type { EditorPage } from '../helpers/editor.ts';

async function gutterGeometry(editor: EditorPage, id: string) {
  await editor.hoverBlock(id);
  await expect(editor.gutter).toHaveAttribute('data-visible', 'true');
  const gutter = (await editor.gutter.boundingBox())!;
  const content = (await editor.content(id).boundingBox())!;
  return { gutter, content };
}

test.describe('09 · gutter & block drag', () => {
  test('G1 the gutter sits beside the hovered block: top-level, nested, and after scrolling', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'nested' });

    for (const id of ['l0', 'l2']) {
      const { gutter, content } = await gutterGeometry(editor, id);
      expect(Math.abs(gutter.y - content.y)).toBeLessThanOrEqual(6);
      // Just to the left of where this block's text begins, indented with it.
      expect(gutter.x + gutter.width).toBeLessThanOrEqual(content.x + 1);
      expect(content.x - (gutter.x + gutter.width)).toBeLessThan(40);
    }

    await editor.remount({}, 'long');
    await page.evaluate(() => window.scrollTo(0, 600));
    const block = (await editor.block('p30').boundingBox())!;
    await page.mouse.move(block.x + 60, block.y + block.height / 2);
    await expect(editor.gutter).toHaveAttribute('data-visible', 'true');
    const gutter = (await editor.gutter.boundingBox())!;
    expect(Math.abs(gutter.y - block.y)).toBeLessThanOrEqual(8);
  });

  test('G1b in RTL the gutter sits on the right of the text', async ({ editor }) => {
    await editor.load({ doc: 'paragraphs', dir: 'rtl' });
    const { gutter, content } = await gutterGeometry(editor, 'p2');
    expect(gutter.x).toBeGreaterThanOrEqual(content.x + content.width - 1);
  });

  test('G2 + inserts an empty paragraph below at the same depth and focuses it', async ({
    editor,
  }) => {
    await editor.load({ doc: 'nested' });
    await editor.hoverBlock('l1');
    await editor.addButton.click();
    const outline = await editor.outline();
    expect(outline[2]).toBe('  paragraph:');
    const inserted = (await editor.ids())[2]!;
    expect(await editor.focusedBlock()).toBe(inserted);
    await editor.type('typed');
    expect((await editor.outline())[2]).toBe('  paragraph:typed');
  });

  test('G3 handle: click selects, Shift+click extends, Mod+click toggles', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await editor.hoverBlock('b');
    await editor.handle.click();
    expect(await editor.selected()).toEqual(['b']);

    await editor.hoverBlock('d');
    await editor.handle.click({ modifiers: ['Shift'] });
    expect(await editor.selected()).toEqual(['b', 'c', 'd']);

    await editor.hoverBlock('c');
    await editor.handle.click({ modifiers: ['ControlOrMeta'] });
    expect(await editor.selected()).toEqual(['b', 'd']);
    await expect(editor.root).toBeFocused();
    await page.keyboard.press('Escape');
  });

  test('G4 dragging a handle shows the indicator at the gap under the pointer and moves the block', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await editor.dragBlock('a', 'd', 'after', { release: false });
    await expect(editor.root).toHaveAttribute('data-dragging', 'true');
    const indicator = editor.root.locator('.neditor-drop-indicator');
    await expect(indicator).toBeVisible();
    const line = (await indicator.boundingBox())!;
    const d = (await editor.block('d').boundingBox())!;
    const e = (await editor.block('e').boundingBox())!;
    // Between d and e: not "past the last block", which is all happy-dom can answer.
    expect(line.y).toBeGreaterThanOrEqual(d.y + d.height / 2);
    expect(line.y).toBeLessThanOrEqual(e.y + e.height / 2);

    await page.mouse.up();
    await expect(editor.root).not.toHaveAttribute('data-dragging', 'true');
    expect(await editor.ids()).toEqual(['b', 'c', 'd', 'a', 'e']);
    await page.keyboard.press(`${MOD}+z`);
    expect(await editor.ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('G5 a handle inside a multi-selection drags the whole selection, which survives the drop', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['b', 'c']));
    await editor.dragBlock('b', 'e', 'after');
    expect(await editor.ids()).toEqual(['a', 'd', 'e', 'b', 'c']);
    // The compatibility click aimed at the captured handle must not collapse it.
    expect(await editor.selected()).toEqual(['b', 'c']);
  });

  test('G6 dropping back into its own gap changes nothing and records nothing', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await page.evaluate(() => window.__e2e.editor.clearHistory());
    await editor.clearLog();
    await editor.dragBlock('b', 'b', 'before');
    expect(await editor.ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(await editor.events('change')).toEqual([]);
    expect(await editor.canUndo()).toBe(false);
  });

  test('G7 Escape abandons a drag; so does pointercancel; releasing outside the window ends it', async ({
    editor,
    page,
    browserName,
  }) => {
    await editor.load({ doc: 'five' });
    await editor.dragBlock('a', 'd', 'after', { release: false });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(await editor.ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
    await expect(editor.root).not.toHaveAttribute('data-dragging', 'true');
    await expect(editor.root.locator('.neditor-drop-indicator')).toBeHidden();

    await editor.dragBlock('a', 'd', 'after', { release: false });
    // The browser taking the gesture over: the event is what the UA sends then.
    await editor.handle.evaluate((handle) => {
      const pointerId = window.__e2e.lastPointerId;
      handle.dispatchEvent(
        new PointerEvent('pointercancel', { bubbles: true, pointerId, pointerType: 'mouse' }),
      );
    });
    await page.mouse.up();
    expect(await editor.ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
    await expect(editor.root).not.toHaveAttribute('data-dragging', 'true');

    // Pointer capture: a release far outside the page still ends the drag.
    // Playwright's Firefox delivers no event at all for a release outside the
    // viewport, so there is nothing to observe there.
    test.skip(
      browserName === 'firefox',
      'Playwright Firefox dispatches no pointerup outside the viewport',
    );
    await editor.dragBlock('e', 'a', 'before', { release: false });
    await page.mouse.move(-40, -40, { steps: 4 });
    await page.mouse.up();
    await expect(editor.root).not.toHaveAttribute('data-dragging', 'true');
    // And the next gesture is an ordinary one.
    await editor.hoverBlock('c');
    await editor.handle.click();
    expect(await editor.selected()).toEqual(['c']);
  });

  test('G8 a nested block dragged to the top is pulled to depth 0; a collapsed toggle brings its children', async ({
    editor,
  }) => {
    await editor.load({ doc: 'nested' });
    await editor.dragBlock('l2', 'l0', 'before');
    expect(await editor.outline()).toEqual([
      'bulleted_list:Level two',
      'bulleted_list:Level zero',
      '  bulleted_list:Level one',
      'paragraph:After the list',
    ]);

    await editor.remount({}, 'toggle-collapsed');
    await editor.dragBlock('tg', 'after', 'after');
    expect(await editor.ids()).toEqual(['before', 'after', 'tg', 'child1', 'child2']);
  });

  test('G10 dragging the block you are typing in leaves block mode whole, with no caret behind', async ({
    editor,
  }) => {
    // Was FINDING F12: the drag selected the block without taking focus, so the
    // caret stayed live in the moved block while it was block-selected, and the
    // next keystroke replaced a block the reader could see a caret in. The
    // drop keeps the block selected (as G5 does for a selection), so it must
    // leave block mode whole: focus on the root, no caret in any host.
    await editor.load({ doc: 'five' });
    await editor.clickAt('a', 3);
    await editor.dragBlock('a', 'd', 'after');
    expect(await editor.ids()).toEqual(['b', 'c', 'd', 'a', 'e']);
    expect(await editor.selected()).toEqual(['a']);
    await expect(editor.root).toBeFocused();
    expect(await editor.selection()).toBeNull();
    expect(await editor.invariants()).toEqual([]);
  });

  test('G9 no gutter with dragHandles:false or in read-only', async ({ editor }) => {
    await editor.load({ doc: 'paragraphs', dragHandles: false });
    await editor.hoverBlock('p2');
    await expect(editor.root.locator('.neditor-gutter')).toHaveCount(0);

    await editor.load({ doc: 'paragraphs', editable: false });
    await editor.hoverBlock('p2');
    await expect(editor.gutter).not.toHaveAttribute('data-visible', 'true');
  });
});
