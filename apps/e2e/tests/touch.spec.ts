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

  /*
   * R14-RV1-5: a press that selects a block does not bring it into view,
   * and the long press is one. A block the window's bottom edge cuts,
   * pressed long on its first line: selected, and the page where it was --
   * revealed, it moved under the finger.
   */
  test('a long press on a block cut by the window’s edge selects it and scrolls nothing', async ({
    editor,
    page,
  }) => {
    await page.clock.install();
    await editor.load({ doc: 'long' });
    const finger = await Finger.attach(page);
    const downs = () => page.evaluate(() => window.__e2e.pointerDowns);
    const y = await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const blocks = ed.getDocument().blocks;
      blocks.splice(20, 0, {
        id: 'tall',
        type: 'paragraph',
        depth: 0,
        content: [{ text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(12) }],
      });
      ed.setDocument({ blocks });
      const block = ed.element.querySelector('[data-block-id="tall"]')!;
      window.scrollTo(
        0,
        block.getBoundingClientRect().top + window.scrollY - (window.innerHeight - 40),
      );
      return window.scrollY;
    });
    const box = (await editor.content('tall').boundingBox())!;
    const seen = await downs();
    await finger.down(box.x + 40, box.y + 12);
    await expect.poll(downs).toBe(seen + 1);
    await page.clock.runFor(700);
    expect(await editor.selected()).toEqual(['tall']);
    expect(await page.evaluate(() => window.scrollY)).toBe(y);
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

  test('TO3b a handle drag held at the bottom edge scrolls, so a block can move more than a screen', async ({
    editor,
    page,
  }) => {
    // Was STR-6: the handle is `touch-action: none`, so the page cannot be
    // panned during the drag, and nothing else scrolled it: a block could not
    // be moved further than the screen it started on.
    await editor.load({ doc: 'long', toolbar: 0 });
    const finger = await Finger.attach(page);
    await tapBlock(editor, finger, 'p1');
    await expect(editor.gutter).toHaveAttribute('data-visible', 'true');
    const handle = await centre(editor.handle);
    const height = page.viewportSize()!.height;
    await finger.down(handle.x, handle.y);
    await finger.path(handle, { x: handle.x, y: height - 2 }, 16);

    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(height);
    await finger.path({ x: handle.x, y: height - 2 }, { x: handle.x, y: height / 2 }, 4);
    await finger.up();

    const ids = await editor.ids();
    expect(ids.indexOf('p1')).toBeGreaterThan(30);
    expect(ids).toHaveLength(60);
  });

  test('TO4 a swipe that becomes a scroll leaves no gesture, and no selection, behind it', async ({
    editor,
    page,
  }) => {
    // Was FINDING F11, fixed; see docs/e2e-progress.md.
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

  /*
   * R14-RV4B-1's `pointercancel` half: TO4 on a page that stops the cancel
   * above the editor. Heard only in the document's bubble phase, the cancel
   * never reached it, and the swipe's press stayed down until the next
   * press: a block selection made by Escape outlived a host's `focus()` on
   * another block. Stopped with the press as well (the press is marked in
   * the capture phase) and alone. The scroll takeover is the browser's:
   * e2e.
   */
  test('TO4c a swipe that becomes a scroll ends its gesture on a page that stops the cancel', async ({
    editor,
    page,
  }) => {
    for (const stopped of [['pointerdown', 'pointercancel'], ['pointercancel']]) {
      const label = `${stopped.join(' and ')} stopped`;
      await editor.load({ doc: 'long' });
      await page.evaluate((stopped) => {
        for (const type of stopped) {
          document.querySelector('#stage')!.addEventListener(type, (event) => {
            event.stopPropagation();
          });
        }
      }, stopped);
      const finger = await Finger.attach(page);
      await tapBlock(editor, finger, 'p2');
      await editor.settle();
      expect(await editor.selection(), `${label}: the tap placed the caret`).toMatchObject({
        blockId: 'p2',
      });
      const box = (await editor.content('p6').boundingBox())!;
      const start = { x: box.x + 40, y: box.y + box.height / 2 };
      await finger.down(start.x, start.y);
      await finger.path(start, { x: start.x, y: start.y - 200 }, 40);
      await finger.up();
      await editor.settle();

      expect(await page.evaluate(() => window.scrollY), `${label}: scrolled`).toBeGreaterThan(50);
      await expect(editor.root, label).not.toHaveAttribute('data-selecting', 'true');
      expect(await editor.selection(), `${label}: the caret is where the tap put it`).toMatchObject(
        { blockId: 'p2' },
      );
      await page.keyboard.press('Escape');
      expect(await editor.selected(), `${label}: Escape selects the block`).toEqual(['p2']);
      // Past the grace a release gives a gesture still placing focus, a
      // host's `focus()` on another block is the reader choosing its text:
      // the block selection ends. With the press still down, it stayed --
      // p2 selected with the caret in p4, both modes at once.
      await page.waitForTimeout(350);
      await editor.content('p4').evaluate((host) => (host as HTMLElement).focus());
      expect(await editor.selected(), `${label}: a host's focus() ends it`).toEqual([]);
      expect(await editor.selection(), label).toMatchObject({ blockId: 'p4' });
    }
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

  /*
   * R5-PTR-6. The gutter is offered on the touch's pointerdown, and the
   * browser hit-tests the tap's compatibility click after that: a tap -- or a
   * long press -- just beside the text, where the `+` was not yet drawn,
   * pressed it and opened an empty paragraph. A second, separate tap on the
   * `+` is a press on it and still adds. Hit-testing of the compatibility
   * click: e2e (the unit test in editor.test.ts replays the order).
   */
  test('TO5 the tap that offers the gutter does not press the + it revealed', async ({
    editor,
    page,
  }) => {
    const finger = await Finger.attach(page);
    let before: string[] = [];

    for (const hold of [0, 900]) {
      for (const dx of [4, 12]) {
        // Fresh each time, as the probe ran it: once the gutter is drawn, a
        // tap at x+12 is a tap on the `+` itself.
        await editor.load({ doc: 'paragraphs' });
        before = await editor.ids();
        const block = (await editor.block(before[1]!).boundingBox())!;
        await expect(editor.gutter).toHaveAttribute('data-visible', 'false');
        await finger.down(block.x + dx, block.y + block.height / 2);
        if (hold) await page.waitForTimeout(hold);
        await finger.up();
        await editor.settle();
        await expect(editor.gutter, `hold ${hold}, x+${dx}`).toHaveAttribute(
          'data-visible',
          'true',
        );
        expect(await editor.ids(), `hold ${hold}, x+${dx}`).toEqual(before);
      }
    }

    // Now the `+` is drawn under the finger, and a tap on it is a press on it.
    await page.evaluate(() => window.__e2e.editor.clearBlockSelection());
    const plus = await centre(editor.gutter.locator('.neditor-gutter__add'));
    await finger.down(plus.x, plus.y);
    await finger.up();
    await editor.settle();
    expect(await editor.ids()).toHaveLength(before.length + 1);
  });

  /*
   * R7-PTR-1. The gutter shown for p2 is not the gutter drawn beside p2 once
   * the layout has moved under it. The probe: a tap on p2's text offers the
   * gutter; the phone turns, the long first paragraph wraps onto fewer lines
   * and p2 moves up with no event the gutter hears; a tap beside p2's text
   * re-places the `+` under the finger -- and its click added a paragraph.
   * A real resize and the tap's own hit-tested click: e2e.
   */
  test('TO5b a tap that moves the + under the finger after the phone turns adds nothing', async ({
    editor,
    page,
  }) => {
    const finger = await Finger.attach(page);
    await editor.load({ doc: 'paragraphs' });
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const doc = ed.getDocument();
      doc.blocks[0]!.content = [
        {
          text: 'A long first paragraph that wraps over several lines on a phone held upright, and onto fewer lines once the phone is turned on its side.',
        },
      ];
      ed.setDocument(doc);
    });
    const ids = await editor.ids();
    const second = editor.content(ids[1]!);

    await tapBlock(editor, finger, ids[1]!);
    await editor.settle();
    await expect(editor.gutter).toHaveAttribute('data-visible', 'true');
    const drawn = (await editor.gutter.boundingBox())!.y;

    await page.setViewportSize({ width: 844, height: 390 });
    await editor.settle();
    const text = (await second.boundingBox())!;
    expect(text.y, 'precondition: p2 moved under the gutter').toBeLessThan(drawn - 10);

    // Whichever control the click lands on -- the `+` added a paragraph, the
    // handle selected the block -- it is the tail of the press that put it
    // there.
    await finger.down(text.x - 8, text.y + 10);
    await finger.up();
    await editor.settle();
    expect(await editor.ids()).toEqual(ids);
    expect(await editor.selected()).toEqual([]);
  });

  // UX P3-2, measured at phone width: the gutter's + and handle were 20 by 24 a
  // pixel apart, the to-do box 16 by 16, the chevron 24 by 20, the callout
  // icon 21 by 24. WCAG 2.2's 2.5.8 asks 24 by 24 of each. Measured by what a
  // press lands on, since the to-do box, chevron and icon keep the box they draw.
  test('TO6 every control the renderer draws takes a press over 24 by 24 CSS pixels', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'kitchen-sink' });
    const finger = await Finger.attach(page);
    const reach = (selector: string) =>
      page.evaluate((selector) => {
        const element = document.querySelector<HTMLElement>(selector)!;
        element.scrollIntoView({ block: 'center' });
        const box = element.getBoundingClientRect();
        const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
        const lands = (dx: number, dy: number) => {
          const target = document.elementFromPoint(x + dx, y + dy);
          return target !== null && element.contains(target);
        };
        // The band through the centre a press still lands on, each way.
        let across = 0;
        let down = 0;
        while (lands(-across - 0.5, 0) && lands(across + 0.5, 0)) across += 0.5;
        while (lands(0, -down - 0.5) && lands(0, down + 0.5)) down += 0.5;
        return { across: 2 * across + 1, down: 2 * down + 1 };
      }, selector);

    for (const selector of [
      '.neditor-block__checkbox',
      '.neditor-block__chevron',
      '.neditor-block__icon',
    ]) {
      const { across, down } = await reach(selector);
      expect(across, `${selector} across`).toBeGreaterThanOrEqual(24);
      expect(down, `${selector} down`).toBeGreaterThanOrEqual(24);
    }

    await tapBlock(editor, finger, (await editor.ids())[0]!);
    await expect(editor.gutter).toHaveAttribute('data-visible', 'true');
    for (const button of await editor.gutter.locator('button').all()) {
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(24);
      expect(box.height).toBeGreaterThanOrEqual(24);
    }
  });
});
