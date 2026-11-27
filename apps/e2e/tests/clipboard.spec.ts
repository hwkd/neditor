import { expect, MOD, test } from '../helpers/test.ts';
import { copyFromPage, shape, writeClipboard } from '../helpers/clipboard.ts';
import { afterFailedLoads, READER_COPIES, recordArrivingHtml } from '../helpers/hostile.ts';

/*
 * Safari's own copies, for the WebKit ports that are not Apple's (r1 ci-9).
 * These tests pin what the reader makes of Safari's copy of a drag, and the
 * README supports Safari. The Linux WebKit port CI runs is not Safari: for
 * the same drags its serializer writes an emptied `<details>` that declares
 * `white-space`, which the edge rule keeps as written (C30d), or HTML with no
 * text in it at all (C30f). So on Apple's WebKit (macOS) the drag is copied
 * live, and on any other WebKit port the markup Safari wrote for that very
 * drag is pasted instead, through a real copy and paste (`copyFromPage`, which
 * no engine cleans). Recorded with the tests' own drags and copy in
 * Playwright's WebKit on macOS, as each paste's `clipboardData` held it,
 * byte for byte.
 */
const SAFARI_BLOCK_STYLE =
  'color: rgb(17, 17, 17); font-family: system-ui, sans-serif; font-size: medium; font-style: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; white-space: normal; widows: 2; word-spacing: 0px; -webkit-tap-highlight-color: rgba(0, 0, 0, 0.4); -webkit-text-stroke-width: 0px; background-color: rgb(255, 255, 255); text-decoration: none;';
const SAFARI_HEADING_STYLE = SAFARI_BLOCK_STYLE.replace(' font-size: medium;', '').replace(
  ' font-weight: 400;',
  '',
);
const SAFARI_COPIES = {
  "ended at the start of a closed details' summary": {
    html: '<!DOCTYPE html><p id="s0">one</p><details></summary><br class="Apple-interchange-newline">',
    text: 'one\n\n',
  },
  'a drag across closed details': {
    html:
      `<!DOCTYPE html><details style="${SAFARI_BLOCK_STYLE}"><details style="${SAFARI_BLOCK_STYLE}">` +
      `<h3 data-first="" style="${SAFARI_HEADING_STYLE}">FAQ</h3>` +
      `<details style="${SAFARI_BLOCK_STYLE}"><summary>How do I install it?</summary></span></details>` +
      `<details style="${SAFARI_BLOCK_STYLE}"><summary>Does it work offline?</summary></span></details>` +
      `<p data-last="" style="${SAFARI_BLOCK_STYLE}">Still stuck? Open an issue.</p>`,
    text: 'FAQ\n\nHow do I install it?\nDoes it work offline?\nStill stuck? Open an issue.',
  },
} as const;
/** Pastes Safari's recorded copy rather than this port's own (see `SAFARI_COPIES`). */
const replaysSafari = (browserName: string): boolean =>
  browserName === 'webkit' && process.platform !== 'darwin';

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

  // Written from the page's own copy event, which no engine cleans: through
  // the async clipboard API, Firefox and WebKit strip the handler, and only
  // Chromium could tell a broken reader. The drop spec (D1b) is the other way
  // in.
  for (const [index, [html, text]] of READER_COPIES.entries()) {
    test(`C7b.${index + 1} no copy the reader makes of pasted markup runs its handlers: ${html}`, async ({
      editor,
      page,
      consoleErrors,
    }) => {
      // The images are meant to fail, and Chromium and WebKit log that
      // (Firefox logs nothing); nothing else may be logged.
      test.info().annotations.push({
        type: 'allow-console-errors',
        description: 'failed image loads, by design',
      });
      await editor.load({ doc: 'empty' });
      const arrived = await recordArrivingHtml(page);
      await copyFromPage(page, MOD, { html, text: 'PLAIN' });
      await editor.placeCaret('p1', 0);
      await page.keyboard.press(`${MOD}+v`);
      // This markup arrived, handler and all -- not the plain text, not what
      // an earlier test left on the clipboard, not a copy an engine cleaned: a
      // test the payload never reached proves nothing.
      expect(await arrived()).toEqual([expect.stringContaining('onerror=')]);
      expect((await editor.texts()).join('')).toBe(text);
      await afterFailedLoads(page);
      expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
      expect(consoleErrors.filter((error) => !/failed to load resource/i.test(error))).toEqual([]);
    });
  }

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

  test.describe('a text range is copied from the model (CLIP-1)', () => {
    // The browser's own copy inlined the editor's computed styles, which the
    // reader then believed. Real Mod+C and Mod+V against the system clipboard,
    // which is what serialises a selection: e2e only.

    test('C13 a link copied and pasted back is a link, with no underline', async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'links' });
      await editor.clickAt('p1', 4);
      for (let i = 0; i < 8; i += 1) {
        await page.keyboard.press('Shift+ArrowRight');
      }
      await page.keyboard.press(`${MOD}+c`);
      await editor.clickAt('p2', 15);
      await page.keyboard.press(`${MOD}+v`);

      expect((await editor.blockData('p2'))?.content).toEqual([
        { text: 'Plain paragraphthe ' },
        { text: 'docs', link: 'https://example.com/docs' },
      ]);

      // Anywhere else, the characters that were selected.
      await page.locator('#paste-target').click();
      await page.keyboard.press(`${MOD}+v`);
      await expect(page.locator('#paste-target')).toHaveValue('the docs');
    });

    test('C14 a checked to-do’s text pasted over itself gains no strikethrough', async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'lists' });
      await editor.clickAt('t2', 1);
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Shift+End');
      await page.keyboard.press(`${MOD}+c`);
      await page.keyboard.press(`${MOD}+v`);
      await editor.block('t2').getByRole('checkbox').click();

      const todo = await editor.blockData('t2');
      expect(todo?.checked).toBe(false);
      // Exact: a subset match let the stray mark through.
      expect(todo?.content).toEqual([{ text: 'Todo two' }]);
    });

    test('C15 a soft break and a double space survive copy and paste', async ({ editor, page }) => {
      // Firefox wrote both as single spaces.
      await editor.load({ doc: 'paragraphs' });
      await editor.clickAt('p1', 9);
      await editor.type(' x');
      await page.keyboard.press('Shift+Enter');
      await editor.type('y  z');
      await editor.placeCaret('p1', 6, 16);
      await page.keyboard.press(`${MOD}+c`);
      await editor.clickAt('p3', 13);
      await page.keyboard.press(`${MOD}+v`);

      expect((await editor.texts())[2]).toBe('Charlie threeone x\ny  z');
    });

    test('C16 cut takes the range out as one undo step', async ({ editor, page }) => {
      await editor.load({ doc: 'links' });
      await editor.clickAt('p1', 4);
      for (let i = 0; i < 8; i += 1) {
        await page.keyboard.press('Shift+ArrowRight');
      }
      await page.keyboard.press(`${MOD}+x`);
      expect((await editor.texts())[0]).toBe('See  for details.');

      await editor.clickAt('p2', 0);
      await page.keyboard.press(`${MOD}+v`);
      expect((await editor.blockData('p2'))?.content).toEqual([
        { text: 'the ' },
        { text: 'docs', link: 'https://example.com/docs' },
        { text: 'Plain paragraph' },
      ]);

      await page.keyboard.press(`${MOD}+z`);
      await page.keyboard.press(`${MOD}+z`);
      expect((await editor.blockData('p1'))?.content).toEqual([
        { text: 'See the ' },
        { text: 'docs', link: 'https://example.com/docs' },
        { text: ' for details.' },
      ]);
      expect(await editor.canUndo()).toBe(false);
    });
  });

  test('C17 Windows and classic Mac line endings pasted into a code block are newlines', async ({
    editor,
    page,
  }) => {
    // CLIP-7.
    await editor.load({ doc: 'code' });
    await editor.setDocument({ blocks: [{ id: 'code', type: 'code', depth: 0, content: [] }] });
    await writeClipboard(page, { text: 'if (x) {\r\n  y();\r}' });
    await editor.content('code').click();
    await page.keyboard.press(`${MOD}+v`);

    expect((await editor.blockData('code'))?.content).toEqual([{ text: 'if (x) {\n  y();\n}' }]);
  });

  test('C18 plain lines pasted into a list item become items, as Enter makes them', async ({
    editor,
    page,
  }) => {
    // CLIP-9: the text after the caret fell out of the list with the last line.
    await editor.load({ doc: 'lists' });
    await writeClipboard(page, { text: 'line one\nline two\nline three' });
    await editor.clickAt('b1', 6);
    await page.keyboard.press(`${MOD}+v`);

    expect((await editor.outline()).slice(0, 4)).toEqual([
      'bulleted_list:Bulletline one',
      'bulleted_list:line two',
      'bulleted_list:line three one',
      'bulleted_list:Bullet two',
    ]);
    expect((await editor.selection())?.range).toEqual({ start: 10, end: 10 });
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

  // Real copies only: Chromium and WebKit inline the link's computed
  // `text-decoration` into the HTML they write, which happy-dom never does.
  // The editor writes its own clipboard for a range copied out of it (C13), so
  // the reader's half of the rule is reached through another application's
  // HTML: Google Docs underlines a link through a styled span inside it.
  test('C19 a Google Docs link pastes as a link, not underlined', async ({ editor, page }) => {
    await editor.load({ doc: 'empty' });
    await writeClipboard(page, {
      html:
        '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1">' +
        '<span style="font-weight:400;">See </span>' +
        '<a href="https://example.com/docs" style="text-decoration:none;">' +
        '<span style="color:#1155cc;font-weight:400;text-decoration:underline;' +
        '-webkit-text-decoration-skip:none;text-decoration-skip-ink:none;">the docs</span></a></b>',
      text: 'See the docs',
    });
    await editor.content('p1').click();
    await page.keyboard.press(`${MOD}+v`);
    const pasted = (await editor.doc()).blocks[0]!.content;

    expect(pasted.find((run) => run.link)).toEqual({
      text: 'the docs',
      link: 'https://example.com/docs',
    });
    expect(pasted.some((run) => run.marks?.includes('underline'))).toBe(false);
    expect(await editor.markdown()).toContain('[the docs](https://example.com/docs)');
  });

  // What another application draws is layout, which happy-dom has none of: a
  // plain contenteditable is the stand-in for Gmail or any rich-text field.
  test('C20 a block copy keeps soft breaks and runs of spaces in another rich-text field', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await editor.setDocument({
      blocks: [
        { id: 'a', type: 'paragraph', content: [{ text: 'two  spaces   three' }], depth: 0 },
        { id: 'c', type: 'paragraph', content: [{ text: 'soft\nbreak para' }], depth: 0 },
        { id: 'b', type: 'quote', content: [{ text: 'line\nbreak' }], depth: 0 },
      ],
    });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['a', 'c', 'b']));
    await page.keyboard.press(`${MOD}+c`);
    await page.evaluate(() => {
      const field = document.createElement('div');

      field.id = 'rich';
      field.contentEditable = 'true';
      field.style.cssText = 'min-height: 40px; border: 1px solid';
      document.body.prepend(field);
    });
    await page.locator('#rich').click();
    await page.keyboard.press(`${MOD}+v`);

    const drawn = await page.locator('#rich').evaluate((field) => (field as HTMLElement).innerText);

    expect(drawn).toContain('two  spaces   three');
    expect(drawn).toContain('soft\nbreak para');
    expect(drawn).toContain('line\nbreak');
  });

  // Firefox copies a page's paragraph with its source line-wrapping and
  // indentation as they are; the selection has to be a real mouse drag.
  test('C21 a line-wrapped page paragraph, selected and copied, pastes as one line', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await page.evaluate(() => {
      const div = document.createElement('div');

      div.id = 'foreign';
      div.innerHTML =
        '<p id="w1">The quick brown fox jumps over\n    the lazy dog, and then it\n    runs away.</p>\n<p id="w2">Second paragraph\n    also wrapped.</p>';
      document.body.prepend(div);
    });
    const first = (await page.locator('#w1').boundingBox())!;
    const second = (await page.locator('#w2').boundingBox())!;
    await page.mouse.move(first.x + 1, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(second.x + second.width - 1, second.y + second.height / 2, {
      steps: 10,
    });
    await page.mouse.up();
    await page.keyboard.press(`${MOD}+c`);
    await editor.content('p1').click();
    await page.keyboard.press(`${MOD}+v`);

    expect(await editor.texts()).toEqual([
      'The quick brown fox jumps over the lazy dog, and then it runs away.',
      'Second paragraph also wrapped.',
    ]);
  });

  // A drag begun just past the end of a line is how a reader often starts a
  // selection; Chromium and WebKit mark the line break it crossed with an
  // `Apple-interchange-newline` break at the start of the copy, which read as
  // content opened the paste with an empty line. Firefox writes no marker.
  test('C30 a drag begun past the end of the line above pastes no empty line', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await page.evaluate(() => {
      const div = document.createElement('div');

      div.id = 'foreign';
      div.innerHTML = '<p id="s1">alpha one</p><p id="s2">beta two</p>';
      document.body.prepend(div);
    });
    const first = (await page.locator('#s1').boundingBox())!;
    const second = (await page.locator('#s2').boundingBox())!;
    await page.mouse.move(first.x + first.width - 2, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(second.x + second.width - 2, second.y + second.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await page.keyboard.press(`${MOD}+c`);
    await editor.content('p1').click();
    await page.keyboard.press(`${MOD}+v`);

    expect(await editor.texts()).toEqual(['beta two']);
  });

  // The same break, written where C30 did not look (R5-FMT-3): Chromium and
  // WebKit put it inside the first block when that block is a list item;
  // Firefox writes the block the drag left, emptied, and on a pretty-printed
  // page its plain text starts with the source's newlines, so asking it kept
  // that block. Pasted mid-paragraph, either split the reader's paragraph.
  // The drag and the clipboard are the browser's own, which is why this is
  // e2e: each engine writes the copy differently.
  for (const [name, html] of [
    ['a list item', '<ul><li id="s1">alpha one</li><li id="s2">beta two</li></ul>'],
    [
      'a pretty-printed page',
      '<div><p id="s1">alpha one</p>\n    <p id="s2">\n      beta two\n    </p></div>',
    ],
  ] as const) {
    test(`C30b a drag begun past the end of the line above, from ${name}, pastes mid-paragraph`, async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'empty' });
      await editor.setDocument({
        blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text: 'XXYY' }] }],
      });
      await page.evaluate((html) => {
        const div = document.createElement('div');

        div.id = 'foreign';
        div.innerHTML = html;
        document.body.prepend(div);
      }, html);
      // Just inside the end of a block's last letter, wherever its source
      // whitespace puts it.
      const endOf = (id: string) =>
        page.locator(id).evaluate((element) => {
          const text = element.firstChild as Text;
          const last = text.data.trimEnd().length;
          const range = element.ownerDocument.createRange();

          range.setStart(text, last - 1);
          range.setEnd(text, last);
          const rect = range.getBoundingClientRect();

          return { x: rect.right - 1, y: rect.top + rect.height / 2 };
        });
      const start = await endOf('#s1');
      const end = await endOf('#s2');
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 8 });
      await page.mouse.up();
      await page.keyboard.press(`${MOD}+c`);
      await editor.clickAt('z', 2);
      await page.keyboard.press(`${MOD}+v`);

      expect(await editor.outline()).toEqual(['paragraph:XXbeta twoYY']);
    });
  }

  // A drag ended at the start of the line below -- the usual way to select
  // whole paragraphs. Firefox writes that line's block, emptied, at the end of
  // the copy; kept, it took the reader's `YY` as its tail and retyped it as a
  // heading (R5-FMT-3c).
  test("C30c a drag ended at the start of the line below leaves the reader's text its type", async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await editor.setDocument({
      blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text: 'XXYY' }] }],
    });
    await page.evaluate(() => {
      const div = document.createElement('div');

      div.id = 'foreign';
      div.innerHTML = '<p id="s1">alpha one</p><p id="s2">beta two</p><h3 id="s3">gamma three</h3>';
      document.body.prepend(div);
    });
    const start = await editor.pointAt(page.locator('#s2'), 0);
    const end = await editor.pointAt(page.locator('#s3'), 0);
    await page.mouse.move(start.x - 1, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x - 1, end.y, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.press(`${MOD}+c`);
    await editor.clickAt('z', 2);
    await page.keyboard.press(`${MOD}+v`);

    expect(await editor.outline()).toEqual(['paragraph:XXbeta twoYY']);
  });

  // C30's edges again, from blocks that hold inline markup or sit in a
  // pretty-printed source: Firefox writes the emptied block with the inline
  // elements it held (`<p><a href=…></a></p>`, `<h2><span></span></h2>`), or
  // with the source's indentation, or as an empty `<pre>` -- and only a bare
  // `<p></p>` was recognised, so the paste split the reader's paragraph or
  // retyped its tail as a heading or a code block (R6-FMT-1). The drag and the
  // clipboard are the browser's own, which is why this is e2e.
  const markupPage =
    '<p id="s1">Read the <a href="https://x.test/">release notes</a></p>\n<p id="s2">Install it with <code>npm i</code> and restart.</p>\n<h2 id="s3"><span>Configuration</span></h2>\n<pre id="s4">port = 80</pre>\n<p id="s5">Done.</p>';
  const prettyPage =
    '<div>\n  <p id="s1">\n    alpha <span>one</span>\n  </p>\n  <p id="s2">\n    <span>beta</span> two\n  </p>\n  <h2 id="s3">\n    <span>gamma</span> three\n  </h2>\n</div>';
  // R7-FMT-1: an emptied `<details>` (or the `<summary>` or `<p>` in one) was
  // not dropped with it, and read as a toggle.
  const detailsBodyPage =
    '<details open><summary>Summary line</summary><p id="s1">alpha one</p></details><p id="s2">beta two</p><p id="s3">gamma</p>';
  const detailsSummaryPage =
    '<details><summary id="s1">alpha one</summary><p>hidden</p></details><p id="s2">beta two</p><p id="s3">gamma</p>';
  const detailsEndPage =
    '<p id="s0">alpha one</p><details><summary id="s1">Summary line</summary><p>hidden</p></details><p>after</p>';
  type Where = 'past-end' | 'before-start' | { before: string };
  for (const [name, html, from, to, pasted, notIn] of [
    [
      'begun past the end of a paragraph that ends in a link',
      markupPage,
      ['s1', 'past-end'],
      ['s2', { before: ' it with' }],
      'XXInstallYY',
    ],
    [
      'ended at the start of a heading whose text is in a span',
      markupPage,
      ['s3', 'before-start'],
      ['s2', { before: 'restart.' }],
      'XXrestart.YY',
    ],
    [
      'ended at the start of a code block',
      markupPage,
      ['s4', 'before-start'],
      ['s3', { before: 'Configuration' }],
      'XXConfigurationYY',
    ],
    [
      'begun past the end of a pretty-printed paragraph',
      prettyPage,
      ['s1', 'past-end'],
      ['s2', { before: ' two' }],
      'XXbetaYY',
    ],
    [
      'ended at the start of a pretty-printed heading',
      prettyPage,
      ['s2', { before: 'two' }],
      ['s3', 'before-start'],
      'XXtwoYY',
    ],
    [
      'begun past the end of a paragraph in an open details',
      detailsBodyPage,
      ['s1', 'past-end'],
      ['s2', { before: ' two' }],
      'XXbetaYY',
    ],
    [
      "begun past the end of a closed details' summary",
      detailsSummaryPage,
      ['s1', 'past-end'],
      ['s2', { before: ' two' }],
      'XXbetaYY',
    ],
    // Chromium writes the rest of the page after a drag that ends inside a
    // `<details>` -- its serializer's, and not taken.
    [
      "ended at the start of a closed details' summary",
      detailsEndPage,
      ['s0', { before: 'one' }],
      ['s1', { before: 'Summary' }],
      'XXoneYY',
      'chromium',
    ],
  ] as [string, string, [string, Where], [string, Where], string, string?][]) {
    test(`C30d a drag ${name} pastes mid-paragraph`, async ({ editor, page, browserName }) => {
      test.skip(browserName === notIn, 'the browser writes the rest of the page');
      await editor.load({ doc: 'empty' });
      await editor.setDocument({
        blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text: 'XXYY' }] }],
      });
      const safari =
        name in SAFARI_COPIES && replaysSafari(browserName)
          ? SAFARI_COPIES[name as keyof typeof SAFARI_COPIES]
          : undefined;
      if (safari) {
        await copyFromPage(page, MOD, safari);
      } else {
        await page.evaluate((html) => {
          const div = document.createElement('div');

          div.id = 'foreign';
          div.innerHTML = html;
          document.body.prepend(div);
        }, html);
        // Measured on the block's text, whatever source whitespace is around it.
        const point = ([id, where]: [string, Where]) =>
          page.evaluate(
            ({ id, where }) => {
              const element = document.getElementById(id)!;
              const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
              const nodes: Text[] = [];

              for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                nodes.push(node as Text);
              }

              const text = nodes.map((node) => node.data).join('');
              const charRect = (offset: number) => {
                let at = offset;
                const node = nodes.find((candidate) => {
                  if (at < candidate.data.length) {
                    return true;
                  }

                  at -= candidate.data.length;
                  return false;
                })!;
                const range = document.createRange();

                range.setStart(node, at);
                range.setEnd(node, at + 1);

                return range.getBoundingClientRect();
              };

              if (where === 'past-end') {
                const rect = charRect(text.trimEnd().length - 1);
                return { x: rect.right + 6, y: rect.top + rect.height / 2 };
              }

              if (where === 'before-start') {
                const rect = charRect(text.length - text.trimStart().length);
                return {
                  x: element.getBoundingClientRect().left - 3,
                  y: rect.top + rect.height / 2,
                };
              }

              const rect = charRect(text.indexOf(where.before));
              return { x: rect.left + 1, y: rect.top + rect.height / 2 };
            },
            { id, where },
          );
        const start = await point(from);
        const end = await point(to);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(end.x, end.y, { steps: 10 });
        await page.mouse.up();
        await page.keyboard.press(`${MOD}+c`);
      }
      await editor.clickAt('z', 2);
      await page.keyboard.press(`${MOD}+v`);

      expect(await editor.outline()).toEqual([`paragraph:${pasted}`]);
    });
  }

  // WebKit sanitizes this payload on the way in (every `mso-` style goes), so
  // the same list arrives in two shapes; both are lists.
  test('C22 a Word list pastes as a list, nesting kept and markers dropped', async ({
    editor,
    page,
  }) => {
    const item = (marker: string, text: string, level: number) =>
      `<p class=MsoListParagraphCxSpMiddle style='margin-left:${36 * level}.0pt;mso-add-space:auto;text-indent:-18.0pt;mso-list:l0 level${level} lfo1'><![if !supportLists]><span style='font-family:Symbol'><span style='mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><![endif]><span lang=EN-US>${text}<o:p></o:p></span></p>`;
    await editor.load({ doc: 'empty' });
    await writeClipboard(page, {
      html: `<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><!--StartFragment-->${item('·', 'Bullet one', 1)}${item('o', 'Bullet nested', 2)}<p class=MsoNormal>Between<o:p></o:p></p>${item('1.', 'Numbered one', 1)}<!--EndFragment--></body></html>`,
      text: '·  Bullet one\no  Bullet nested\nBetween\n1.  Numbered one',
    });
    await editor.content('p1').click();
    await page.keyboard.press(`${MOD}+v`);

    expect(await editor.outline()).toEqual([
      'bulleted_list:Bullet one',
      '  bulleted_list:Bullet nested',
      'paragraph:Between',
      'numbered_list:Numbered one',
    ]);
  });

  // US and Mac Word write the indent in inches, and WebKit's sanitized form
  // keeps only that indent to say how deep an item is (R2-PARSE-5).
  test('C22b a Word list indented in inches keeps its nesting', async ({ editor, page }) => {
    const item = (marker: string, text: string, level: number) =>
      `<p class=MsoListParagraphCxSpMiddle style='margin-left:${0.5 * level}in;mso-add-space:auto;text-indent:-.25in;mso-list:l0 level${level} lfo1'><![if !supportLists]><span style='font-family:Symbol'><span style='mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><![endif]><span lang=EN-US>${text}<o:p></o:p></span></p>`;
    await editor.load({ doc: 'empty' });
    await writeClipboard(page, {
      html: `<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><!--StartFragment-->${item('·', 'One', 1)}${item('o', 'Nested', 2)}${item('§', 'Deeper', 3)}${item('viii.', 'Roman', 1)}<!--EndFragment--></body></html>`,
      text: '·  One\no  Nested\n§  Deeper\nviii.  Roman',
    });
    await editor.content('p1').click();
    await page.keyboard.press(`${MOD}+v`);

    expect(await editor.outline()).toEqual([
      'bulleted_list:One',
      '  bulleted_list:Nested',
      '    bulleted_list:Deeper',
      'numbered_list:Roman',
    ]);
  });

  // What another application draws is layout, which happy-dom has none of: a
  // plain contenteditable stands in for it, as in C20 (R2-PARSE-4).
  test('C23 a text range from a code block keeps its indent in another rich-text field', async ({
    editor,
    page,
  }) => {
    const code = 'x = 0\ndef f():\n    return  1';
    await editor.load({ doc: 'empty' });
    await editor.setDocument({
      blocks: [{ id: 'c', type: 'code', content: [{ text: code }], depth: 0 }],
    });
    await editor.placeCaret('c', 6, code.length);
    await page.keyboard.press(`${MOD}+c`);
    await page.evaluate(() => {
      const field = document.createElement('div');

      field.id = 'rich';
      field.contentEditable = 'true';
      field.style.cssText = 'min-height: 40px; border: 1px solid';
      document.body.prepend(field);
    });
    await page.locator('#rich').click();
    await page.keyboard.press(`${MOD}+v`);

    const drawn = await page.locator('#rich').evaluate((field) => (field as HTMLElement).innerText);

    expect(drawn.replace(/ /g, ' ')).toContain('def f():\n    return  1');
  });

  // Firefox copies a page's classes, not its computed style, so a stylesheet's
  // `code { white-space: break-spaces }` arrives as a bare <code>; the selection
  // has to be a real mouse drag (R2-PARSE-1).
  test('C24 code on a page keeps its spaces, however the engine copies it', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await page.evaluate(() => {
      const div = document.createElement('div');

      div.id = 'foreign';
      div.innerHTML =
        '<style>#foreign code { white-space: break-spaces; font-family: monospace }</style>' +
        '<p id="w1">Run <code>npm  install  --save</code> now, then\n    <span style="white-space: pre">x  y</span>\n    as well.</p>';
      document.body.prepend(div);
    });
    const box = (await page.locator('#w1').boundingBox())!;
    await page.mouse.move(box.x + 1, box.y + 4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height - 4, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.press(`${MOD}+c`);
    await editor.content('p1').click();
    await page.keyboard.press(`${MOD}+v`);

    const [pasted] = await editor.texts();

    expect(pasted).toContain('npm  install  --save');
    // The inline `pre` keeps its own spaces; the source indentation around it
    // is still layout (R2-PARSE-2).
    expect(pasted).toContain('then x  y as well.');
  });

  // A real copy of a page region, by a real mouse drag across it: what each
  // engine writes to the clipboard -- Firefox's classes and drawn plain text,
  // Chromium's and WebKit's computed styles, WebKit's converted spaces -- is
  // what is under test, and happy-dom can only be handed a guess at it.
  const copyRegion = async (page: import('@playwright/test').Page, html: string): Promise<void> => {
    await page.evaluate((markup) => {
      const div = document.createElement('div');

      div.id = 'foreign';
      div.innerHTML = markup;
      document.body.prepend(div);
    }, html);
    const first = (await page.locator('#foreign [data-first]').boundingBox())!;
    const last = (await page.locator('#foreign [data-last]').boundingBox())!;
    await page.mouse.move(first.x + 1, first.y + 4);
    await page.mouse.down();
    await page.mouse.move(last.x + last.width - 1, last.y + last.height - 4, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.press(`${MOD}+c`);
  };

  // R3-FMT-3: Firefox copies `class="pw"`, not `white-space: pre-wrap`, and a
  // `<div>`'s text was the one place the plain text was never asked.
  test('C25 chat messages a stylesheet made pre-wrap keep their lines and spaces', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await copyRegion(
      page,
      '<style>#foreign .pw { white-space: pre-wrap }</style>' +
        '<div class="msg"><b data-first>Ann</b><div class="pw">first line\nsecond  line</div></div>' +
        '<div class="msg"><b>Bob</b><div class="pw" data-last>ok\n\nthanks</div></div>',
    );
    await editor.content('p1').click();
    await page.keyboard.press(`${MOD}+v`);

    expect(await editor.texts()).toEqual([
      'Ann',
      'first line\nsecond  line',
      'Bob',
      'ok\n\nthanks',
    ]);
  });

  // R3-FMT-1: `code` is `white-space: normal` by default; a source-wrapped one
  // is drawn on one line, and pastes as it was drawn.
  test('C26 source-wrapped code in a page paragraph pastes on one line', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await copyRegion(
      page,
      '<p data-first data-last>Run <code>npm\n      install</code> now, then <code>a  b</code>.</p>',
    );
    await editor.content('p1').click();
    await page.keyboard.press(`${MOD}+v`);

    expect(await editor.texts()).toEqual(['Run npm install now, then a b.']);
  });

  // R3-FMT-2: WebKit writes the space it did not draw at a line's or a
  // block's end as an `Apple-converted-space`; kept, it came back as `&#32;`
  // in every export.
  test('C27 a space no one could see at the end of a line stays unseen', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await copyRegion(
      page,
      '<p data-first>line one <br>line two </p><h2>Title </h2><p>a <b>bold </b></p><table><tr><td>cell </td><td data-last>two</td></tr></table>',
    );
    await editor.content('p1').click();
    await page.keyboard.press(`${MOD}+v`);

    const blocks = (await editor.doc()).blocks;

    expect(
      blocks.slice(0, 3).map((block) => block.content.map((run) => run.text).join('')),
    ).toEqual(['line one\nline two', 'Title', 'a bold']);
    expect(blocks[3]?.rows?.[0]?.map((cell) => cell.map((run) => run.text).join(''))).toEqual([
      'cell',
      'two',
    ]);
  });

  // R4-FMT-1: in a block a style preserves, the source newline after a child
  // paragraph (`<p>Name</p>\n</td>`) is formatting the walk drops -- but the
  // last-newline rule still saw it and took the cell's last letter instead.
  // Chromium and WebKit lose the letter on this copy; Firefox lost it on a
  // select-all copy of such a region, whose clipboard the unit tests hold
  // (`rich-dom.test.ts`).
  test('C28 pretty-printed blocks in a pre-wrap region keep their last letters', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await copyRegion(
      page,
      '<div style="white-space: pre-wrap"><p data-first>before</p>\n<table>\n<tr>\n<td><p>Name</p>\n</td>\n<td><p>Value</p>\n</td>\n</tr>\n</table>\n<ul>\n<li><p>alpha</p>\n</li>\n<li><p>beta</p>\n</li>\n</ul>\n<blockquote><p data-last>quoted</p>\n</blockquote></div>',
    );
    await editor.content('p1').click();
    await page.keyboard.press(`${MOD}+v`);

    const blocks = (await editor.doc()).blocks;
    const text = (runs: { text: string }[]): string => runs.map((run) => run.text).join('');

    expect(
      blocks.map((block) => block.rows?.map((row) => row.map(text)) ?? text(block.content)),
    ).toEqual(['before', [['Name', 'Value']], 'alpha', 'beta', 'quoted']);
  });

  // R4-FMT-6a: Firefox writes a tab before every cell but a row's first, and
  // the leading-space rule asked for a line start, so a pre-wrap cell's
  // ` f ` read `f` there; Chromium and WebKit write the style and kept it.
  test('C29 a pre-wrap cell keeps the spaces at its edges', async ({ editor, page }) => {
    await editor.load({ doc: 'empty' });
    await copyRegion(
      page,
      '<style>#foreign .pw { white-space: pre-wrap }</style><p data-first>before</p><table><tr><td class="pw">a  b</td><td class="pw"> f </td></tr></table><p data-last>after</p>',
    );
    await editor.content('p1').click();
    await page.keyboard.press(`${MOD}+v`);

    const table = (await editor.doc()).blocks.find((block) => block.type === 'table');

    expect(
      table?.rows?.map((row) => row.map((cell) => cell.map((run) => run.text).join(''))),
    ).toEqual([['a  b', ' f ']]);
  });

  // R6-FMT-2: only a cell was asked about a space at its edge, so the
  // leading space a `pre-wrap` verse draws collapsed in Firefox; Chromium and
  // WebKit write the style and kept it.
  test('C29b a pre-wrap block keeps the space it starts with', async ({ editor, page }) => {
    await editor.load({ doc: 'empty' });
    await copyRegion(
      page,
      '<style>#foreign .verse { white-space: pre-wrap }</style><p data-first class="verse">First line</p><p class="verse"> second, set in</p><p data-last class="verse">third</p>',
    );
    await editor.content('p1').click();
    await page.keyboard.press(`${MOD}+v`);

    expect(await editor.texts()).toEqual(['First line', ' second, set in', 'third']);
  });

  // R6-FMT-3: Firefox writes an image's alt text into the plain text, so the
  // cell holding it was not found there -- and nor was any cell after it in
  // its row, which then lost its spaces.
  test('C29c a cell after one spelled differently keeps its spaces', async ({ editor, page }) => {
    await editor.load({ doc: 'empty' });
    await copyRegion(
      page,
      '<style>#foreign .cmd { white-space: pre-wrap }</style><p data-first>before</p><table><tr><td><img src="/sample.png" alt="warning" width="12" height="12"> force</td><td class="cmd">tool  --force   now</td></tr></table><p data-last>after</p>',
    );
    await editor.content('p1').click();
    await page.keyboard.press(`${MOD}+v`);

    const table = (await editor.doc()).blocks.find((block) => block.type === 'table');

    expect(
      table?.rows?.map((row) => row.map((cell) => cell.map((run) => run.text).join(''))),
    ).toEqual([['force', 'tool  --force   now']]);
  });

  // R7-FMT-2: a row whose first cell was empty or held only a picture had no
  // place in Firefox's plain text, and a row after one whose last cell
  // missed was placed on that row's line -- either way the later cells lost
  // their spaces.
  const picture = (alt: string) => `<img src="/sample.png" alt="${alt}" width="12" height="12">`;
  for (const [name, rows, expected] of [
    [
      'a picture alone',
      `<tr><th>Flag</th><th>Command</th></tr><tr><td>${picture('FR')}</td><td class="cmd">git  push   origin</td></tr><tr><td>${picture('DE')}</td><td class="cmd">git  pull</td></tr>`,
      [
        ['Flag', 'Command'],
        ['', 'git  push   origin'],
        ['', 'git  pull'],
      ],
    ],
    [
      'nothing',
      `<tr><td></td><td>${picture('yes')} ok</td><td class="cmd">tool  --force   now</td></tr>`,
      [['', 'ok', 'tool  --force   now']],
    ],
    [
      'a picture before its text, after a row whose last cell missed',
      `<tr><td class="cmd">npm  run</td><td>${picture('ok')} Passed</td></tr><tr><td>${picture('w')} two</td><td class="cmd">npm  test</td></tr>`,
      [
        ['npm  run', 'Passed'],
        ['two', 'npm  test'],
      ],
    ],
  ] as [string, string, string[][]][]) {
    test(`C29d a row whose first cell holds ${name} keeps its cells' spaces`, async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'empty' });
      await copyRegion(
        page,
        `<style>#foreign .cmd { white-space: pre-wrap }</style><p data-first>before</p><table>${rows}</table><p data-last>after</p>`,
      );
      await editor.content('p1').click();
      await page.keyboard.press(`${MOD}+v`);

      const table = (await editor.doc()).blocks.find((block) => block.type === 'table');

      expect(
        table?.rows?.map((row) => row.map((cell) => cell.map((run) => run.text).join(''))),
      ).toEqual(expected);
    });
  }

  // R7-FMT-4: Firefox indents each line of a list item, a definition and a
  // quote in its plain text, so a drawn leading space, or a line break, in
  // one a stylesheet made pre-wrap was lost -- and four undrawn spaces at
  // the start of an item were kept. Chromium and WebKit write the style.
  test('C29e a pre-wrap quote or list item keeps its leading space and its lines', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await copyRegion(
      page,
      '<style>#foreign .pw { white-space: pre-wrap }</style><p data-first>start</p><blockquote class="pw"> reply</blockquote><ul class="pw"><li> item one</li></ul><blockquote class="pw">line one\nline two</blockquote><ul><li>    li four</li></ul><p data-last>end</p>',
    );
    await editor.content('p1').click();
    await page.keyboard.press(`${MOD}+v`);

    expect(await editor.texts()).toEqual([
      'start',
      ' reply',
      ' item one',
      'line one\nline two',
      'li four',
      'end',
    ]);
  });

  // R8-FMT-3..6: Firefox writes no indentation on an empty line and a blank
  // line between two paragraphs of one item, indents a quote in a quote by
  // its own depth, and leaves out the undrawn spaces after a `<br>` -- which
  // were kept when there were exactly as many as its indentation -- while a
  // drawn space after a `<br>` was never asked about. Chromium and WebKit
  // write the style.
  test('C29f breaks, blank lines and nested indentation in a pre-wrap item or quote', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await copyRegion(
      page,
      '<style>#foreign .pw { white-space: pre-wrap }</style><p data-first>start</p><ul><li class="pw">a\n\nb</li></ul><ul><li>one<br>    two</li></ul><blockquote><blockquote class="pw"> deep  q</blockquote></blockquote><ul><li><p>first</p><p class="pw"> second  p</p></li></ul><p class="pw">one<br> two</p><p data-last>end</p>',
    );
    await editor.content('p1').click();
    await page.keyboard.press(`${MOD}+v`);

    expect(await editor.texts()).toEqual([
      'start',
      'a\n\nb',
      'one\ntwo',
      ' deep  q',
      'first\n second  p',
      'one\n two',
      'end',
    ]);
  });

  // R9-FMT-2: with no list, quote or definition in the copy Firefox indents
  // nothing, and the blank line it writes between two paragraphs of one
  // block -- a table cell, the bare `<li>`s of a drag begun inside a list --
  // was allowed only where it indents, so the second paragraph's drawn
  // leading spaces were dropped. Chromium and WebKit write the style.
  test('C29g a second paragraph in a pre-wrap cell or item keeps the spaces it starts with', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await copyRegion(
      page,
      '<style>#foreign .pw { white-space: pre-wrap }</style><p data-first>start</p><table><tr><td class="pw"><p>First paragraph</p><p>  indented second</p></td><td>z</td></tr></table><p data-last>end</p>',
    );
    await editor.content('p1').click();
    await page.keyboard.press(`${MOD}+v`);

    const table = (await editor.doc()).blocks.find((block) => block.type === 'table');

    expect(
      table?.rows?.map((row) => row.map((cell) => cell.map((run) => run.text).join(''))),
    ).toEqual([['First paragraph\n  indented second', 'z']]);

    await editor.load({ doc: 'empty' });
    await copyRegion(
      page,
      '<style>#foreign .pw { white-space: pre-wrap }</style><ul><li class="pw" data-first><p>First paragraph</p><p>  indented second</p></li><li class="pw" data-last>Next item</li></ul>',
    );
    await editor.content('p1').click();
    await page.keyboard.press(`${MOD}+v`);

    expect(await editor.outline()).toEqual([
      'bulleted_list:First paragraph\n  indented second',
      'bulleted_list:Next item',
    ]);
  });

  // R9-RV-FMT-1, R9-RV-FMT-3: a list or quote inside a cell is indented in
  // Firefox's plain text though the cell is not, and that indentation was
  // taken for the cell's own drawn spaces after a blank line, or never asked
  // after a `<br>`. Each line is matched past the indentation of the element
  // it starts in. Chromium and WebKit write the style.
  test('C29h a list or quote in a cell keeps only the spaces it drew', async ({ editor, page }) => {
    await editor.load({ doc: 'empty' });
    await copyRegion(
      page,
      '<style>#foreign .pw { white-space: pre-wrap }</style><p data-first>Intro</p><table><tr><td><p>First para</p><ul><li>    item text</li></ul><blockquote>    quoted text</blockquote><ul><li>one<br>    two</li></ul><ul><li class="pw">  item drawn</li></ul></td><td>zed</td></tr></table><p data-last>Outro text</p>',
    );
    await editor.content('p1').click();
    await page.keyboard.press(`${MOD}+v`);

    const table = (await editor.doc()).blocks.find((block) => block.type === 'table');

    expect(
      table?.rows?.map((row) => row.map((cell) => cell.map((run) => run.text).join(''))),
    ).toEqual([['First para\nitem text\nquoted text\none\ntwo\n  item drawn', 'zed']]);
  });

  // R8-FMT-1, R8-FMT-2: a drag begun in a `<details>`' body leaves its
  // summary out, and the `<details>` read as an empty toggle split and
  // indented the paragraph the copy was pasted into; WebKit writes the start
  // tags of every closed `<details>` a drag crosses first, so a whole FAQ
  // pasted inside empty collapsed toggles. The drag and the clipboard are
  // the browser's own.
  test('C30e a drag begun in a details body pastes its answers as paragraphs', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await editor.setDocument({
      blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text: 'XXYY' }] }],
    });
    await copyRegion(
      page,
      '<p>Intro text</p><details open><summary>Question one</summary><p data-first>Answer one</p><p>Answer more</p></details><p data-last>Outro text</p>',
    );
    await editor.clickAt('z', 2);
    await page.keyboard.press(`${MOD}+v`);

    expect(await editor.outline()).toEqual([
      'paragraph:XXAnswer one',
      'paragraph:Answer more',
      'paragraph:Outro textYY',
    ]);
  });

  // R9-FMT-1: only the copy's first element was asked, so a FAQ inside the
  // page's own wrapper, or a `<details>` nested in another's body (inside
  // Chromium's `<slot>` or WebKit's `<span>`), still pasted its answer
  // indented under an empty toggle.
  for (const [name, html, expected] of [
    [
      'inside a page wrapper',
      '<p>Intro text</p><div class="faq"><details open><summary>Question</summary><p data-first>Answer text</p></details><p>Rest in wrapper</p></div><p data-last>Outro text</p>',
      ['paragraph:XXAnswer text', 'paragraph:Rest in wrapper', 'paragraph:Outro textYY'],
    ],
    [
      'nested in another',
      '<p>Intro text</p><details open><summary>Outer question</summary><details open><summary>Inner question</summary><p data-first>Inner body</p></details><p>Outer rest</p></details><p data-last>Outro text</p>',
      ['paragraph:XXInner body', 'paragraph:Outer rest', 'paragraph:Outro textYY'],
    ],
  ] as const) {
    test(`C30e a drag begun in the body of a details ${name} pastes paragraphs`, async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'empty' });
      await editor.setDocument({
        blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text: 'XXYY' }] }],
      });
      await copyRegion(page, html);
      await editor.clickAt('z', 2);
      await page.keyboard.press(`${MOD}+v`);

      expect(await editor.outline()).toEqual(expected);
    });
  }

  // R9-RV-FMT-4: a drag begun after `Sentence.` selects the space drawn
  // after it; WebKit writes that space as a lone converted space at the very
  // start of the copy, which collapsed, while Chromium's copy kept it.
  // Firefox writes the source's two spaces and one in its plain text, the
  // same bytes a drag begun on the first letter of `<p>  Next</p>` writes,
  // and keeps it too (R9-FMT-3, a known limit for that other drag).
  test('C30g a drag begun at a drawn space pastes it mid-paragraph', async ({ editor, page }) => {
    await editor.load({ doc: 'empty' });
    await editor.setDocument({
      blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text: 'XXYY' }] }],
    });
    await page.evaluate(() => {
      const div = document.createElement('div');

      div.id = 'foreign';
      div.innerHTML = '<p id="a">Sentence.  Next words</p><p id="b">Second line</p>';
      document.body.prepend(div);
    });
    const [from, to] = await page.evaluate(() => {
      const text = document.getElementById('a')!.firstChild!;
      const dot = document.createRange();

      dot.setStart(text, 8);
      dot.setEnd(text, 9);
      const end = document.createRange();

      end.selectNodeContents(document.getElementById('b')!);
      const a = dot.getBoundingClientRect();
      const b = [...end.getClientRects()].at(-1)!;

      return [
        { x: a.right - 1, y: a.top + a.height / 2 },
        { x: b.right - 1, y: b.top + b.height / 2 },
      ];
    });
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.mouse.up();
    expect(await page.evaluate(() => getSelection()?.toString())).toMatch(/^ Next words/);
    await page.keyboard.press(`${MOD}+c`);
    await editor.clickAt('z', 2);
    await page.keyboard.press(`${MOD}+v`);

    expect((await editor.texts()).map((text) => text.replace(/\u00a0/g, ' '))).toEqual([
      'XX Next words',
      'Second lineYY',
    ]);
  });

  test('C30f a drag across closed details pastes every question at its depth', async ({
    editor,
    page,
    browserName,
  }) => {
    await editor.load({ doc: 'empty' });
    await editor.setDocument({
      blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text: 'XXYY' }] }],
    });
    if (replaysSafari(browserName)) {
      await copyFromPage(page, MOD, SAFARI_COPIES['a drag across closed details']);
    } else {
      await copyRegion(
        page,
        '<h3 data-first>FAQ</h3><details><summary>How do I install it?</summary><p>Run the installer.</p></details><details><summary>Does it work offline?</summary><p>Yes.</p></details><p data-last>Still stuck? Open an issue.</p>',
      );
    }
    await editor.clickAt('z', 2);
    await page.keyboard.press(`${MOD}+v`);

    // Chromium and Firefox write each closed body's emptied `<p>`, read as
    // an empty child; what is pinned is that nothing wraps the questions.
    const blocks = (await editor.doc()).blocks;

    expect(blocks[0]).toMatchObject({ type: 'paragraph', depth: 0 });
    expect(blocks[0]!.content.map((run) => run.text).join('')).toBe('XXFAQ');
    expect(
      blocks
        .filter((block) => block.type === 'toggle')
        .map((block) => [block.depth, block.content.map((run) => run.text).join('')]),
    ).toEqual([
      [0, 'How do I install it?'],
      [0, 'Does it work offline?'],
    ]);
    expect(blocks.at(-1)).toMatchObject({ type: 'paragraph', depth: 0 });
    expect(
      blocks
        .at(-1)!
        .content.map((run) => run.text)
        .join(''),
    ).toBe('Still stuck? Open an issue.YY');
  });
});
