import { expect, test } from '../helpers/test.ts';

test.describe('02 · typing & caret', () => {
  test('T1 typing updates the model without replacing the host, and the caret stays put', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    const host = await editor.content('p1').elementHandle();
    await editor.clickAt('p1', 5); // "Alpha| one"
    await editor.type('bet');
    // Typing mid-word keeps typing mid-word: the renderer never rewrote the host.
    await editor.type('ic');
    expect((await editor.texts())[0]).toBe('Alphabetic one');
    expect(await host!.evaluate((element) => element.isConnected)).toBe(true);
    expect(
      await editor.content('p1').evaluate((element, original) => element === original, host),
    ).toBe(true);
    expect((await editor.selection())?.range).toEqual({ start: 10, end: 10 });
    await expect(page.locator('#editor [data-block-id="p1"] .neditor-block__content')).toHaveText(
      'Alphabetic one',
    );
  });

  test('T2 the placeholder shows on the focused empty block only', async ({ editor, page }) => {
    await editor.load({ doc: 'paragraphs' });
    const placeholder = (id: string) =>
      editor.content(id).evaluate((element) => {
        const style = getComputedStyle(element, '::before');
        return { content: style.content, opacity: style.opacity };
      });

    await editor.clickAt('p1', 9);
    await page.keyboard.press('Enter'); // a new, empty, focused paragraph
    const fresh = (await editor.ids())[1]!;
    await expect
      .poll(() => placeholder(fresh))
      .toEqual({ content: `"Type '/' for commands"`, opacity: '1' });

    await editor.clickAt('p3', 2);
    await expect.poll(async () => (await placeholder(fresh)).opacity).toBe('0');
  });

  test('T3 Shift+Enter grows the block by a line and the next character lands after the break', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.clickAt('p1', 9);
    const before = (await editor.content('p1').boundingBox())!.height;
    await page.keyboard.press('Shift+Enter');
    const after = (await editor.content('p1').boundingBox())!.height;
    expect(after).toBeGreaterThan(before * 1.5);

    await editor.type('x');
    expect((await editor.texts())[0]).toBe('Alpha one\nx');
    // Still exactly two line boxes: the filler <br> is presentation only.
    const lines = (await editor.content('p1').boundingBox())!.height;
    expect(Math.round(lines)).toBe(Math.round(after));
  });

  test('T4 Enter splits at the caret, at the start, at the end, and over a selection', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });

    await editor.clickAt('p1', 5);
    await page.keyboard.press('Enter');
    expect((await editor.texts()).slice(0, 2)).toEqual(['Alpha', ' one']);
    const second = (await editor.ids())[1]!;
    expect(await editor.selection()).toMatchObject({
      blockId: second,
      range: { start: 0, end: 0 },
    });

    await editor.placeCaret('p2', 0);
    await page.keyboard.press('Enter');
    expect((await editor.texts()).slice(2, 4)).toEqual(['', 'Bravo two']);
    // The caret follows the text it was in front of, into the new block.
    const bravo = (await editor.ids())[3]!;
    expect(await editor.selection()).toMatchObject({ blockId: bravo, range: { start: 0, end: 0 } });

    await editor.caretAtEnd('p3');
    await page.keyboard.press('Enter');
    expect((await editor.texts()).at(-1)).toBe('');

    await editor.placeCaret('p3', 2, 8); // "Ch[arlie ]three"
    await page.keyboard.press('Enter');
    const texts = await editor.texts();
    expect(texts).toContain('Ch');
    expect(texts).toContain('three');
  });

  test('T5 lists and to-dos continue on Enter; Enter on an empty item leaves the list', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'lists' });

    await editor.caretAtEnd('b2');
    await page.keyboard.press('Enter');
    await editor.type('Bullet three');
    await editor.caretAtEnd('t2');
    await page.keyboard.press('Enter');
    await editor.type('Todo three');

    let outline = await editor.outline();
    expect(outline).toContain('bulleted_list:Bullet three');
    expect(outline).toContain('todo:Todo three');
    const todo = (await editor.doc()).blocks.find(
      (block) => block.type === 'todo' && block.content[0]?.text === 'Todo three',
    );
    expect(todo?.checked).toBe(false);

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter'); // on the new, empty to-do
    outline = await editor.outline();
    expect(outline.at(-1)).toBe('paragraph:');
  });

  test('T6 Enter in a callout or toggle opens a child; in a collapsed toggle it expands first', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'callout' });
    await editor.caretAtEnd('co');
    await page.keyboard.press('Enter');
    await editor.type('inside');
    expect(await editor.outline()).toEqual([
      'paragraph:Before',
      'callout:Callout text',
      '  paragraph:inside',
      'paragraph:After',
    ]);

    await editor.remount({}, 'toggle-collapsed');
    await editor.caretAtEnd('tg');
    await page.keyboard.press('Enter');
    await editor.type('new child');
    const doc = await editor.doc();
    expect(doc.blocks.find((block) => block.id === 'tg')?.collapsed).toBe(false);
    expect(await editor.outline()).toEqual([
      'paragraph:Before',
      'toggle:Toggle head',
      '  paragraph:new child',
      '  paragraph:Hidden child one',
      '  paragraph:Hidden child two',
      'paragraph:After',
    ]);
    await expect(editor.block('child1')).toBeVisible();
  });

  test('T7 focus() scrolls a far block into view', async ({ editor, page }) => {
    await editor.load({ doc: 'long', scroll: 1 });
    await expect(editor.block('p59')).not.toBeInViewport();
    await page.evaluate(() => window.__e2e.editor.focus('p59'));
    await expect(editor.block('p59')).toBeInViewport();
    await expect(editor.content('p59')).toBeFocused();
  });
});
