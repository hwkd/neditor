import { expect, MOD, test } from '../helpers/test.ts';
import { shape } from '../helpers/clipboard.ts';

/** What RT1 types, and the Markdown it must produce. */
const GOLDEN = [
  '# Title',
  'Some **bold**, *italic*, `code` and [a link](https://example.com/) text',
  '- one',
  '  - nested',
  '- two',
  '1. first',
  '2. second',
  '- [ ] task',
  '- [x] done',
  '> quote',
  '---',
  'end',
  '```\ncode();\nmore();\n```',
].join('\n\n');

test.describe('25 · a document built through the UI round-trips', () => {
  test('RT1 typing every construct produces exactly the golden Markdown', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await editor.placeCaret('p1', 0);
    const type = (text: string) => editor.type(text);
    const enter = () => page.keyboard.press('Enter');

    await type('# Title');
    await enter();
    await type('Some **bold**, *italic*, `code` and [a link](https://example.com/) text');
    await enter();
    await type('- one');
    await enter();
    await page.keyboard.press('Tab');
    await type('nested');
    await enter();
    await page.keyboard.press('Shift+Tab');
    await type('two');
    await enter();
    await enter(); // leave the list
    await type('1. first');
    await enter();
    await type('second');
    await enter();
    await enter();
    await type('[] task');
    await enter();
    await type('done');
    await page.keyboard.press(`${MOD}+Enter`);
    await enter();
    await enter();
    await type('> quote');
    await enter();
    await type('---');
    await type('end');
    await enter();
    await type('```');
    await type('code();');
    await page.keyboard.press('Shift+Enter');
    await type('more();');

    expect(await editor.markdown()).toBe(GOLDEN);
  });

  test('RT2 the golden Markdown, read back, renders the same blocks and the same DOM', async ({
    editor,
    page,
  }) => {
    await editor.load({ mount: 'two', doc: 'empty' });
    const second = editor.other();
    await page.evaluate((markdown) => {
      const { editors, lib } = window.__e2e;
      editors[0]!.setDocument({ blocks: lib.blocksFromMarkdown(markdown) });
      editors[1]!.setDocument({ blocks: lib.blocksFromMarkdown(markdown) });
    }, GOLDEN);
    expect(shape(await second.doc())).toEqual(shape(await editor.doc()));
    expect(await editor.markdown()).toBe(GOLDEN);

    // Same markup once the per-block ids are taken out.
    const markup = (index: number) =>
      page.evaluate((index) => {
        const root = window.__e2e.editors[index]!.element.cloneNode(true) as HTMLElement;
        root
          .querySelectorAll('.neditor-gutter, .neditor-live-region, .neditor-drop-indicator')
          .forEach((node) => node.remove());
        return root.innerHTML.replace(/ (data-block-id|id|aria-labelledby)="[^"]*"/g, '');
      }, index);
    expect(await markup(1)).toBe(await markup(0));
  });

  test('RT3 whitespace at the edge of a block survives the Markdown round trip', async ({
    page,
    editor,
  }) => {
    test.fail(
      true,
      'FINDING F1: the reader trims leading and trailing whitespace of every text block',
    );
    await editor.load({ doc: 'empty' });
    const back = await page.evaluate(() => {
      const { lib } = window.__e2e;
      const doc = {
        blocks: [
          lib.createBlock('paragraph', [{ text: ' one' }]),
          lib.createBlock('bulleted_list', [{ text: 'two ' }]),
        ],
      };
      return lib.blocksFromMarkdown(lib.toMarkdown(doc)).map((block) => lib.blockText(block));
    });
    expect(back).toEqual([' one', 'two ']);
  });

  test('RT4 an image with no source round-trips as an image, not as text', async ({
    page,
    editor,
  }) => {
    test.fail(
      true,
      'FINDING F4: an empty image is written as ![]() and read back as a paragraph of literal text',
    );
    await editor.load({ doc: 'empty' });
    const back = await page.evaluate(() => {
      const { lib } = window.__e2e;
      const doc = { blocks: [lib.createBlock('image')] };
      return lib
        .blocksFromMarkdown(lib.toMarkdown(doc))
        .map((block) => `${block.type}:${lib.blockText(block)}`);
    });
    expect(back).toEqual(['image:']);
  });
});
