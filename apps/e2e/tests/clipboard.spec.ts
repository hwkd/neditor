import { expect, MOD, test } from '../helpers/test.ts';
import { shape, writeClipboard } from '../helpers/clipboard.ts';

test.describe('11 · clipboard', () => {
  test.describe('block-mode copy round trips', () => {
    // Was FINDING F8 in Firefox, fixed; see docs/e2e-progress.md.

    test('C1 copying every block and pasting into another editor reproduces the document', async ({
      editor,
      page,
    }) => {
      await editor.load({ mount: 'two', doc: 'kitchen-sink' });
      await editor.placeCaret('h1', 0);
      await page.keyboard.press(`${MOD}+a`);
      await page.keyboard.press(`${MOD}+a`);
      expect((await editor.selected()).length).toBe(17);
      await page.keyboard.press(`${MOD}+c`);

      const second = editor.other();
      await second.content('p1').click();
      await page.keyboard.press(`${MOD}+v`);

      expect(shape(await second.doc())).toEqual(shape(await editor.doc()));
    });

    test('C1b the clipboard carries Markdown as text and nested lists as HTML', async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'nested' });
      await page.evaluate(() => window.__e2e.editor.selectBlocks(['l0', 'l1', 'l2']));
      await page.keyboard.press(`${MOD}+c`);
      await page.locator('#paste-target').click();
      await page.keyboard.press(`${MOD}+v`);
      await expect(page.locator('#paste-target')).toHaveValue(
        '- Level zero\n\n  - Level one\n\n    - Level two',
      );

      // Read the HTML flavour the editor wrote, from inside a second real copy.
      await page.evaluate(() => window.__e2e.editor.selectBlocks(['l0', 'l1', 'l2']));
      const written = page.evaluate(
        () =>
          new Promise<string>((resolve) =>
            document.addEventListener(
              'copy',
              (event) => queueMicrotask(() => resolve(event.clipboardData!.getData('text/html'))),
              {
                once: true,
              },
            ),
          ),
      );
      await page.keyboard.press(`${MOD}+c`);
      const markup = await written;
      expect(markup).toMatch(/<ul[^>]*>\s*<li[^>]*>Level zero\s*<ul/);
    });

    test('C2 cut removes the blocks; in read-only it only copies', async ({ editor, page }) => {
      await editor.load({ doc: 'five' });
      await page.evaluate(() => window.__e2e.editor.selectBlocks(['b', 'c']));
      await page.keyboard.press(`${MOD}+x`);
      expect(await editor.ids()).toEqual(['a', 'd', 'e']);
      await page.locator('#paste-target').click();
      await page.keyboard.press(`${MOD}+v`);
      await expect(page.locator('#paste-target')).toHaveValue('Block B\n\nBlock C');

      await editor.load({ doc: 'five', editable: false });
      await page.evaluate(() => window.__e2e.editor.selectBlocks(['b', 'c']));
      await page.keyboard.press(`${MOD}+x`);
      expect(await editor.ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
      await page.locator('#paste-target').fill('');
      await page.locator('#paste-target').click();
      await page.keyboard.press(`${MOD}+v`);
      await expect(page.locator('#paste-target')).toHaveValue('Block B\n\nBlock C');
    });

    test('C9 our own blocks pasted into a code block arrive as their text, without fences or escapes', async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'code' });
      await editor.setDocument({
        blocks: [
          { id: 'src', type: 'paragraph', depth: 0, content: [{ text: 'a * b' }] },
          { id: 'src2', type: 'heading2', depth: 0, content: [{ text: 'Title' }] },
          { id: 'code', type: 'code', depth: 0, content: [{ text: 'x' }] },
        ],
      });
      await page.evaluate(() => window.__e2e.editor.selectBlocks(['src', 'src2']));
      await page.keyboard.press(`${MOD}+c`);
      await editor.caretAtEnd('code');
      await page.keyboard.press(`${MOD}+v`);
      const code = (await editor.blockData('code'))!.content.map((run) => run.text).join('');
      expect(code).not.toContain('\\*');
      expect(code).not.toContain('##');
      expect(code).toContain('a * b');
      expect(code).toContain('Title');
    });

    test('C11 a code block that starts with a newline survives copy and paste (the <pre> rule)', async ({
      editor,
      page,
    }) => {
      await editor.load({ mount: 'two', doc: 'empty' });
      await editor.setDocument({
        blocks: [{ id: 'code', type: 'code', depth: 0, content: [{ text: '\nline two\n' }] }],
      });
      await page.evaluate(() => window.__e2e.editor.selectBlocks(['code']));
      await page.keyboard.press(`${MOD}+c`);
      const second = editor.other();
      await second.content('p1').click();
      await page.keyboard.press(`${MOD}+v`);
      expect(shape(await second.doc())).toEqual(shape(await editor.doc()));
    });
  });

  test('C12 a native copy of formatted text pastes back with its marks', async ({
    editor,
    page,
  }) => {
    await editor.load({ mount: 'two', doc: 'formatted' });
    await editor.placeCaret('p1', 0, 10); // "plain bold"
    await page.keyboard.press(`${MOD}+c`);
    const second = editor.other();
    await second.content('p1').click();
    await page.keyboard.press(`${MOD}+v`);
    expect((await second.doc()).blocks[0]?.content).toEqual([
      { text: 'plain ' },
      { text: 'bold', marks: ['bold'] },
    ]);
  });

  test('C3 one paragraph pastes inline; several split around the caret; an empty block is replaced', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await writeClipboard(page, { text: 'INSERT' });
    await editor.placeCaret('p1', 5);
    await page.keyboard.press(`${MOD}+v`);
    expect((await editor.texts())[0]).toBe('AlphaINSERT one');
    expect((await editor.selection())?.range).toEqual({ start: 11, end: 11 });

    await writeClipboard(page, { html: '<p>first</p><p>last</p>', text: 'first\n\nlast' });
    await editor.placeCaret('p2', 5);
    await page.keyboard.press(`${MOD}+v`);
    expect(await editor.texts()).toEqual([
      'AlphaINSERT one',
      'Bravofirst',
      'last two',
      'Charlie three',
    ]);

    await editor.remount({}, 'empty');
    await writeClipboard(page, { html: '<h2>Title</h2><p>body</p>' });
    await editor.placeCaret('p1', 0);
    await page.keyboard.press(`${MOD}+v`);
    expect(await editor.outline()).toEqual(['heading2:Title', 'paragraph:body']);
  });

  test('C4 tables, images and dividers are spliced in whole', async ({ editor, page }) => {
    await editor.load({ doc: 'paragraphs' });
    await writeClipboard(page, { html: '<p>a</p><hr><p>b</p>' });
    await editor.placeCaret('p2', 5);
    await page.keyboard.press(`${MOD}+v`);
    expect(await editor.outline()).toEqual([
      'paragraph:Alpha one',
      'paragraph:Bravoa',
      'divider:',
      'paragraph:b two',
      'paragraph:Charlie three',
    ]);

    await editor.remount({}, 'paragraphs');
    await writeClipboard(page, { html: '<table><tr><th>h</th></tr><tr><td>c</td></tr></table>' });
    await editor.placeCaret('p1', 5);
    await page.keyboard.press(`${MOD}+v`);
    const outline = await editor.outline();
    expect(outline[0]).toBe('paragraph:Alpha');
    expect(outline[1]).toMatch(/^table:/);
    expect(outline[2]).toBe('paragraph: one');
    const table = (await editor.doc()).blocks[1]!;
    expect(table.rows).toEqual([[[{ text: 'h' }]], [[{ text: 'c' }]]]);

    await editor.remount({}, 'paragraphs');
    await writeClipboard(page, {
      html: '<figure><img src="/sample.png" alt="pic"><figcaption>cap</figcaption></figure>',
    });
    await editor.placeCaret('p3', 7);
    await page.keyboard.press(`${MOD}+v`);
    expect(await editor.outline()).toEqual([
      'paragraph:Alpha one',
      'paragraph:Bravo two',
      'paragraph:Charlie',
      'image:cap',
      'paragraph: three',
    ]);
  });

  test('C5 a paste over a block selection replaces it, as one undo step', async ({
    editor,
    page,
  }) => {
    // Was FINDING F8, fixed; see docs/e2e-progress.md.
    await editor.load({ doc: 'five' });
    await writeClipboard(page, { html: '<h3>new</h3><p>stuff</p>' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['b', 'c']));
    await page.keyboard.press(`${MOD}+v`);
    expect(await editor.outline()).toEqual([
      'paragraph:Block A',
      'heading3:new',
      'paragraph:stuff',
      'paragraph:Block D',
      'paragraph:Block E',
    ]);
    expect((await editor.selected()).length).toBe(2);
    await page.keyboard.press(`${MOD}+z`);
    expect(await editor.ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('C6 content from Google Docs, Word and web pages keeps its structure and marks', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    const googleDocs =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:700">Bold</span><span style="font-weight:400"> normal</span></p><ul><li dir="ltr"><p dir="ltr"><span>item</span></p></li></ul></b>';
    await writeClipboard(page, { html: googleDocs, text: 'Bold normal\nitem' });
    await editor.placeCaret('p1', 0);
    await page.keyboard.press(`${MOD}+v`);
    let doc = await editor.doc();
    // WebKit's clipboard re-serialises a leading space as U+00A0; compare the words.
    const plain = (runs: (typeof doc.blocks)[number]['content']) =>
      runs.map((run) => ({ ...run, text: run.text.replace(/\u00a0/g, ' ') }));
    expect(plain(doc.blocks[0]!.content)).toEqual([
      { text: 'Bold', marks: ['bold'] },
      { text: ' normal' },
    ]);
    expect(await editor.outline()).toContain('bulleted_list:item');

    await editor.remount({}, 'empty');
    const word =
      '<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><p class=MsoNormal><b>Word</b> <i>text</i><o:p></o:p></p><h1>Head</h1></body></html>';
    await writeClipboard(page, { html: word });
    await editor.placeCaret('p1', 0);
    await page.keyboard.press(`${MOD}+v`);
    doc = await editor.doc();
    expect(plain(doc.blocks[0]!.content)).toEqual([
      { text: 'Word', marks: ['bold'] },
      { text: ' ' },
      { text: 'text', marks: ['italic'] },
    ]);
    expect(await editor.outline()).toContain('heading1:Head');
  });

  test('C6b a pasted <details> becomes a collapsed toggle with its body nested under it', async ({
    editor,
    page,
    browserName,
  }) => {
    test.skip(
      browserName === 'webkit',
      'WebKit’s clipboard sanitiser drops the body of a closed <details> before any page sees it',
    );
    await editor.load({ doc: 'empty' });
    await writeClipboard(page, { html: '<details><summary>Sum</summary><p>body</p></details>' });
    await editor.placeCaret('p1', 0);
    await page.keyboard.press(`${MOD}+v`);
    expect(await editor.outline()).toEqual(['toggle:Sum', '  paragraph:body']);
    expect((await editor.doc()).blocks[0]?.collapsed).toBe(true);
  });

  test('C7 pasted markup is parsed, never inserted: scripts, frames, styles and handlers never land', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    const hostile =
      '<p>safe<script>window.__pwned=1</script><img src="x" onerror="window.__pwned=2"><iframe src="https://example.com/"></iframe><a href="javascript:window.__pwned=3">click</a><style>body{display:none}</style></p><p onclick="window.__pwned=4">two</p>';
    await writeClipboard(page, { html: hostile, text: 'safe click\ntwo' });
    await editor.placeCaret('p1', 0);
    await page.keyboard.press(`${MOD}+v`);

    // Each engine's clipboard sanitises and re-serialises HTML on its own
    // terms, so assert what must never land rather than the exact text.
    const text = (await editor.texts()).join('\n');
    expect(text).toContain('safe');
    expect(text).toContain('click');
    expect(text).toContain('two');
    expect(text).not.toContain('__pwned');
    expect(text).not.toContain('display:none');
    const root = editor.root;
    await expect(root.locator('script, iframe, object, style, [onclick], [onerror]')).toHaveCount(
      0,
    );
    // Chromium's sanitiser resolves src="x" to an absolute http URL, which is a
    // legitimate image; anything else would have been refused.
    const srcs = await root
      .locator('img')
      .evaluateAll((images) => images.map((image) => image.getAttribute('src')));
    expect(srcs.every((src) => /^https?:\/\//.test(src ?? ''))).toBe(true);
    await expect(root.locator('a[href^="javascript"]')).toHaveCount(0);
    await root.locator('.neditor-block__content').first().click();
    expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
    await expect(page.locator('body')).toBeVisible();
  });

  test('C8 plain-text Markdown becomes real blocks, including a ragged GFM table', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await writeClipboard(page, {
      text: '# Title\n- item\n- [x] done\n> quote\n---\n| a | b |\n| - | - |\n| 1 |\n```\ncode here\n```',
    });
    await editor.placeCaret('p1', 0);
    await page.keyboard.press(`${MOD}+v`);
    const outline = await editor.outline();
    expect(outline.slice(0, 5)).toEqual([
      'heading1:Title',
      'bulleted_list:item',
      'todo:done',
      'quote:quote',
      'divider:',
    ]);
    const doc = await editor.doc();
    const table = doc.blocks.find((block) => block.type === 'table')!;
    expect(table.rows).toEqual([
      [[{ text: 'a' }], [{ text: 'b' }]],
      [[{ text: '1' }], []],
    ]);
    expect(doc.blocks.find((block) => block.type === 'todo')?.checked).toBe(true);
    expect(outline).toContain('code:code here');
  });

  test('C9b plain text from another app pastes into a code block verbatim', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'code' });
    await writeClipboard(page, { text: '**not bold** \\# kept\n  indented' });
    await editor.caretAtEnd('code');
    await page.keyboard.press(`${MOD}+v`);
    expect((await editor.blockData('code'))?.content).toEqual([
      { text: 'const x = 1;**not bold** \\# kept\n  indented' },
    ]);
  });

  test('C10 blocks pasted into a table cell are flattened to text, marks kept', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await writeClipboard(page, { html: '<p><b>bold</b></p><p>two</p>' });
    await editor.placeCaret('tbl', 2, 2, { row: 1, column: 0 });
    await page.keyboard.press(`${MOD}+v`);
    expect((await editor.blockData('tbl'))?.rows?.[1]?.[0]).toEqual([
      { text: 'a1' },
      { text: 'bold', marks: ['bold'] },
      { text: '\ntwo' },
    ]);
  });
});
