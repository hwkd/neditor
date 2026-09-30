import type { CDPSession, Locator, Page } from '@playwright/test';
import { expect, test } from '../helpers/test.ts';
import type { EditorPage } from '../helpers/editor.ts';

/**
 * Raw touch through the DevTools protocol, so the browser itself derives the
 * pointer events (pointerType "touch", pointercancel on a scroll takeover)
 * rather than a script faking them. Runs in the `chromium-touch` project.
 */
class Finger {
  private constructor(private readonly cdp: CDPSession) {}

  static async attach(page: Page): Promise<Finger> {
    return new Finger(await page.context().newCDPSession(page));
  }

  async down(x: number, y: number): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y }],
    });
  }

  async move(x: number, y: number): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
  }

  async up(): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  async path(
    from: { x: number; y: number },
    to: { x: number; y: number },
    steps = 8,
  ): Promise<void> {
    for (let step = 1; step <= steps; step += 1) {
      await this.move(
        from.x + ((to.x - from.x) * step) / steps,
        from.y + ((to.y - from.y) * step) / steps,
      );
    }
  }
}

async function centre(locator: Locator): Promise<{ x: number; y: number }> {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function tapBlock(editor: EditorPage, finger: Finger, id: string): Promise<void> {
  const point = await editor.pointAt(editor.content(id), 2);
  await finger.down(point.x, point.y);
  await finger.up();
}

test.describe('23 · touch', () => {
  test('TO1 a tap offers the gutter for that block, and it stays after the finger lifts', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    const finger = await Finger.attach(page);
    await tapBlock(editor, finger, 'c');
    await expect(editor.gutter).toHaveAttribute('data-visible', 'true');
    const gutter = (await editor.gutter.boundingBox())!;
    const block = (await editor.content('c').boundingBox())!;
    expect(Math.abs(gutter.y - block.y)).toBeLessThanOrEqual(8);
    // Lifted, and a moment later: still offered.
    await editor.settle();
    await expect(editor.gutter).toHaveAttribute('data-visible', 'true');

    await tapBlock(editor, finger, 'e');
    const moved = (await editor.gutter.boundingBox())!;
    expect(moved.y).toBeGreaterThan(gutter.y);
  });

  test('TO2 a 500 ms press selects the block; drifting over 10 px is a scroll, not a press', async ({
    editor,
    page,
  }) => {
    // Asserted while the finger is still down. What follows the lift is the
    // platform's gesture recogniser: emulated Chromium sends a compatibility
    // mousedown/click after any release, which ends block selection, where
    // Android and iOS send none after a long press (observation O1, plan R4).
    await page.clock.install();
    await editor.load({ doc: 'five' });
    const finger = await Finger.attach(page);
    const downs = () => page.evaluate(() => window.__e2e.pointerDowns);

    const point = await editor.pointAt(editor.content('b'), 2);
    let seen = await downs();
    await finger.down(point.x, point.y);
    // The renderer handles the touch asynchronously; start the clock only once it has.
    await expect.poll(downs).toBe(seen + 1);
    await page.clock.runFor(400);
    expect(await editor.selected()).toEqual([]);
    await page.clock.runFor(200);
    expect(await editor.selected()).toEqual(['b']);
    await finger.up();

    await page.evaluate(() => window.__e2e.editor.clearBlockSelection());
    const other = await editor.pointAt(editor.content('d'), 2);
    seen = await downs();
    await finger.down(other.x, other.y);
    await expect.poll(downs).toBe(seen + 1);
    await finger.move(other.x + 15, other.y);
    await page.clock.runFor(600);
    expect(await editor.selected()).toEqual([]);
    await finger.up();
  });

  test('TO3 dragging the handle by touch moves the block, and does not scroll the page', async ({
    editor,
    page,
  }) => {
    // The tap that offers the gutter also places the caret in the block being
    // dragged -- the ordinary touch path to F12.
    // Was FINDING F12: the drag selected the block without taking focus, so the
    // caret stayed live in the moved block while it was block-selected, and the
    // next keystroke replaced a block the reader could see a caret in. The
    // drop keeps the block selected (as G5 does for a selection), so it must
    // leave block mode whole: focus on the root, no caret in any host.
    await editor.load({ doc: 'five' });
    const finger = await Finger.attach(page);
    await tapBlock(editor, finger, 'a');
    await expect(editor.gutter).toHaveAttribute('data-visible', 'true');
    const scrollBefore = await page.evaluate(() => window.scrollY);

    const handle = await centre(editor.handle);
    const target = (await editor.block('d').boundingBox())!;
    await finger.down(handle.x, handle.y);
    await finger.path(handle, { x: handle.x, y: target.y + target.height * 0.75 }, 12);
    await finger.up();

    expect(await editor.ids()).toEqual(['b', 'c', 'd', 'a', 'e']);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    expect(await editor.selected()).toEqual(['a']);
    expect(await editor.selection()).toBeNull();
    expect(await editor.invariants()).toEqual([]);
  });

  test('TO4 a swipe that becomes a scroll leaves no gesture, and no selection, behind it', async ({
    editor,
    page,
  }) => {
    test.fail(
      true,
      'FINDING F11: the pointermoves Chromium delivers before pointercancel can cross a block edge; the text drag selects blocks, and pointercancel ends the drag without undoing the selection it made',
    );
    await editor.load({ doc: 'long' });
    const finger = await Finger.attach(page);
    const box = (await editor.content('p6').boundingBox())!;
    const start = { x: box.x + 40, y: box.y + box.height / 2 };
    // A finger's pace: 5 px steps, upwards, so the page scrolls down.
    await finger.down(start.x, start.y);
    await finger.path(start, { x: start.x, y: start.y - 200 }, 40);
    await finger.up();

    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(50);
    await expect(editor.root).not.toHaveAttribute('data-dragging', 'true');
    await expect(editor.root).not.toHaveAttribute('data-selecting', 'true');
    expect(await editor.selected()).toEqual([]);
  });

  test('TO4b after a scroll the next tap is an ordinary one', async ({ editor, page }) => {
    await editor.load({ doc: 'long' });
    const finger = await Finger.attach(page);
    const box = (await editor.content('p6').boundingBox())!;
    const start = { x: box.x + 40, y: box.y + box.height - 3 };
    await finger.down(start.x, start.y);
    await finger.path(start, { x: start.x, y: start.y - 200 }, 40);
    await finger.up();
    await editor.settle();
    const visible = await page.evaluate(() => {
      const blocks = [...document.querySelectorAll<HTMLElement>('.neditor-block')];
      return blocks.find((block) => block.getBoundingClientRect().top > 100)?.dataset.blockId;
    });
    await tapBlock(editor, finger, visible!);
    await expect(editor.gutter).toHaveAttribute('data-visible', 'true');
    await expect(editor.root).not.toHaveAttribute('data-dragging', 'true');
  });
});
