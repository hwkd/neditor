import { expect, test } from '../helpers/test.ts';

// Its own file: a launch option forces a worker of its own, which
// `test.use` may only ask for at the top of a file.
test.use({
  launchOptions: { firefoxUserPrefs: { 'layout.word_select.eat_space_to_next_word': true } },
});

// Skipped by `browserName` alone, a worker option: Chromium and WebKit set
// up no page and no editor for it.
test.skip(({ browserName }) => browserName !== 'firefox', 'a Firefox pref');

test.describe('10 · pointer selection across blocks', () => {
  /*
   * The far end is taken as the browser took the anchor: with Firefox's
   * `layout.word_select.eat_space_to_next_word` (on by default in Windows)
   * a double-click takes the word and the spaces after it, and so does
   * every word the editor's drawing reaches. Without that, a drag from
   * "dog " under a peer's edit ended at "keeps" where Firefox's own ended
   * at "keeps ". A pref of Firefox's own: Firefox only, e2e.
   */
  test('P17g a double-click drag keeps its trailing space under a peer’s update', async ({
    editor,
    page,
  }) => {
    const text = 'The quick brown fox jumps over the lazy dog and keeps going on';
    const run = async (peer: boolean) => {
      await editor.load({ doc: 'paragraphs', toolbar: 0 });
      await page.evaluate((text) => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks[1]!.content = [{ text }];
        ed.setDocument(doc);
      }, text);
      const at = (offset: number) =>
        editor.content('p2').evaluate((host, offset) => {
          const range = host.ownerDocument.createRange();
          range.setStart(host.firstChild!, offset);
          range.setEnd(host.firstChild!, offset + 1);
          const box = range.getBoundingClientRect();
          return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        }, offset);
      const press = await at(41);
      const to = await at(50);
      await page.mouse.move(press.x, press.y);
      await page.mouse.down({ clickCount: 1 });
      await page.mouse.up({ clickCount: 1 });
      await page.mouse.down({ clickCount: 2 });
      for (let i = 1; i <= 8; i += 1) {
        await page.mouse.move(press.x + ((to.x - press.x) * i) / 8, press.y);
        if (peer && i === 2) {
          await page.evaluate(() => {
            const ed = window.__e2e.editor;
            const doc = ed.getDocument();
            doc.blocks[1]!.content = [...doc.blocks[1]!.content, { text: '!' }];
            ed.setDocument(doc);
          });
        }
      }
      await page.mouse.up({ clickCount: 2 });
      await editor.settle();
      return (await editor.selection())?.range;
    };

    const native = await run(false);
    expect(native).toEqual({ start: 40, end: 54 });
    expect(await run(true)).toEqual(native);
  });
});
