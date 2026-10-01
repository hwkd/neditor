import type { Locator } from '@playwright/test';
import { expect, MOD, test } from '../helpers/test.ts';
import type { EditorPage } from '../helpers/editor.ts';

/** A real native drag from the harness's foreign source onto a text offset. */
async function dropAt(
  editor: EditorPage,
  id: string,
  offset: number,
  payload: { html?: string; text?: string },
) {
  await editor.page.evaluate((payload) => window.__e2e.setDragPayload(payload), payload);
  const host: Locator = editor.content(id);
  const point = await editor.pointAt(host, offset);
  const box = (await host.boundingBox())!;
  await editor.page.locator('#foreign-source').dragTo(host, {
    targetPosition: { x: point.x - box.x, y: point.y - box.y },
  });
}

const HOSTILE: Array<[name: string, html: string]> = [
  [
    'an iframe',
    '<p>frame<iframe src="https://example.com/" width="400" height="300"></iframe></p>',
  ],
  [
    'a password form',
    '<form action="https://evil.test/"><input type="password" name="pw"><button>Log in</button></form>',
  ],
  [
    'a fixed full-viewport overlay',
    '<div style="position:fixed;inset:0;background:red;z-index:99999">overlay</div>',
  ],
  ['an image with an error handler', '<img src="x" onerror="window.__pwned=1">caption'],
  ['a script', '<p>text<script>window.__pwned=2</script></p>'],
];

async function assertClean(editor: EditorPage): Promise<void> {
  const root = editor.root;
  await expect(
    root.locator(
      'iframe, form, input, button:not(.neditor-gutter__button), script, object, embed, [onerror], [onclick]',
    ),
  ).toHaveCount(0);
  const fixed = await root.evaluate(
    (element) =>
      [...element.querySelectorAll('*')].filter(
        (node) => getComputedStyle(node).position === 'fixed',
      ).length,
  );
  expect(fixed).toBe(0);
  expect(
    await editor.page.evaluate(() => (window as { __pwned?: number }).__pwned),
  ).toBeUndefined();
}

test.describe('12 · drop', () => {
  for (const [name, html] of HOSTILE) {
    test(`D1 dropping ${name} from another page leaves nothing live behind`, async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'paragraphs' });
      await dropAt(editor, 'p2', 5, { html, text: 'plain fallback' });
      await assertClean(editor);

      // It must not come back on a re-render either: undo, redo, and a full reload of the document.
      await page.keyboard.press(`${MOD}+z`);
      await assertClean(editor);
      await page.keyboard.press(`${MOD}+Shift+z`);
      await assertClean(editor);
      await editor.setDocument(await editor.doc());
      await assertClean(editor);
    });
  }

  test('D2 the safe part of a drop is inserted at the drop point', async ({ editor }) => {
    await editor.load({ doc: 'paragraphs' });
    await dropAt(editor, 'p2', 5, { html: '<i>ITALIC</i>', text: 'ITALIC' });
    expect((await editor.blockData('p2'))?.content).toEqual([
      { text: 'Bravo' },
      { text: 'ITALIC', marks: ['italic'] },
      { text: ' two' },
    ]);
    expect(await editor.texts()).toEqual(['Alpha one', 'BravoITALIC two', 'Charlie three']);
  });

  test('D3 in read-only a drop changes nothing, in the model or the page', async ({ editor }) => {
    await editor.load({ doc: 'paragraphs', editable: false });
    await dropAt(editor, 'p2', 5, { html: '<b>nope</b>', text: 'nope' });
    expect(await editor.texts()).toEqual(['Alpha one', 'Bravo two', 'Charlie three']);
    await expect(editor.content('p2')).toHaveText('Bravo two');
    expect(await editor.events('change')).toEqual([]);
  });

  test('D4 an empty drop and a file-only drop change nothing', async ({ editor, page }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.placeCaret('p1', 3);
    await editor.clearLog();
    await dropAt(editor, 'p2', 5, {});
    expect(await editor.texts()).toEqual(['Alpha one', 'Bravo two', 'Charlie three']);

    // A file cannot come from a page element; dispatch the drop the OS would.
    const fileDropCancelled = await editor.content('p3').evaluate((host) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['data'], 'notes.txt', { type: 'text/plain' }));
      const rect = host.getBoundingClientRect();
      const event = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: rect.left + 5,
        clientY: rect.top + rect.height / 2,
      });
      host.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(fileDropCancelled).toBe(true);
    expect(await editor.texts()).toEqual(['Alpha one', 'Bravo two', 'Charlie three']);
    expect(await editor.events('change')).toEqual([]);
    await page.keyboard.press('Escape');
  });

  test('D5 dragging selected text within the editor copies it rather than moving it', async ({
    editor,
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== 'firefox',
      'Playwright cannot start a native drag of a text selection from mouse input in Chromium or WebKit',
    );
    await editor.load({ doc: 'paragraphs' });
    await editor.placeCaret('p1', 0, 5); // "Alpha"
    const from = await editor.pointAt(editor.content('p1'), 2);
    const to = await editor.pointAt(editor.content('p3'), 7);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();

    const texts = await editor.texts();
    expect(texts[0]).toBe('Alpha one');
    expect(texts[2]).toBe('CharlieAlpha three');
  });
});
