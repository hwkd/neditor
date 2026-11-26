import { expect, MOD, test } from '../helpers/test.ts';

const BLOCK_RULES: Array<[prefix: string, type: string, checked?: boolean]> = [
  ['# ', 'heading1'],
  ['## ', 'heading2'],
  ['### ', 'heading3'],
  ['- ', 'bulleted_list'],
  ['* ', 'bulleted_list'],
  ['+ ', 'bulleted_list'],
  ['1. ', 'numbered_list'],
  ['1) ', 'numbered_list'],
  ['> ', 'quote'],
  ['[] ', 'todo', false],
  ['[ ] ', 'todo', false],
  // A checked box, as GitHub task-list syntax means it.
  ['[x] ', 'todo', true],
  ['```', 'code'],
];

test.describe('04 · Markdown input rules', () => {
  for (const [prefix, type, checked] of BLOCK_RULES) {
    test(`R1 typing "${prefix}" converts an empty paragraph to ${type}`, async ({ editor }) => {
      await editor.load({ doc: 'empty' });
      await editor.placeCaret('p1', 0);
      await editor.type(prefix);
      const block = (await editor.doc()).blocks[0]!;
      expect(block.type).toBe(type);
      expect(block.content).toEqual([]);
      expect((await editor.selection())?.range).toEqual({ start: 0, end: 0 });

      if (checked !== undefined) {
        expect(block.checked).toBe(checked);
      }

      await editor.type('after');
      expect((await editor.texts())[0]).toBe('after');
    });
  }

  test('R1b a rule keeps the text that followed the caret, formatting included', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'formatted' });
    await editor.placeCaret('p1', 0);
    await editor.type('# ');
    const block = (await editor.blockData('p1'))!;
    expect(block.type).toBe('heading1');
    expect(block.content).toContainEqual({ text: 'bold', marks: ['bold'] });
    await expect(page.locator('[data-block-id="p1"] h1')).toBeVisible();
  });

  // `***` fires on its trailing space: firing on the third `*` made a
  // paragraph that opens with ***bold italic*** impossible to type.
  for (const trigger of ['---', '*** ']) {
    test(`R2 "${trigger}" makes a divider and a paragraph for the caret`, async ({ editor }) => {
      await editor.load({ doc: 'empty' });
      await editor.placeCaret('p1', 0);
      await editor.type(trigger);
      const outline = await editor.outline();
      expect(outline).toEqual(['divider:', 'paragraph:']);
      await expect(editor.root.locator('hr.neditor-block__divider')).toHaveCount(1);
      const caret = await editor.selection();
      expect(caret?.blockId).toBe((await editor.ids())[1]);
      await editor.type('next');
      expect(await editor.outline()).toEqual(['divider:', 'paragraph:next']);
    });
  }

  test('R3 block rules fire only in paragraphs, never in a table cell', async ({ editor }) => {
    await editor.load({ doc: 'kitchen-sink' });
    await editor.placeCaret('qt', 0);
    await editor.type('# ');
    expect((await editor.blockData('qt'))?.type).toBe('quote');
    expect((await editor.texts())[8]).toBe('# A quote');

    await editor.placeCaret('tbl', 0, 0, { row: 1, column: 0 });
    await editor.type('# ');
    const table = (await editor.blockData('tbl'))!;
    expect(table.type).toBe('table');
    expect(table.rows?.[1]?.[0]).toEqual([{ text: '# one' }]);
  });

  test('R4 a deletion never fires a rule', async ({ editor, page }) => {
    await editor.load({ doc: 'empty' });
    await editor.placeCaret('p1', 0);
    // Typed with the space last would convert; type the text first, then the
    // prefix in front of it, so "# " exists only once the word is deleted.
    await editor.type('word');
    await editor.placeCaret('p1', 0);
    await editor.type('#');
    await page.keyboard.press('ArrowRight'); // "#w|ord"
    await page.keyboard.press('Backspace'); // "#|ord"
    await page.keyboard.press('Delete');
    await page.keyboard.press('Delete');
    await page.keyboard.press('Delete');
    expect(await editor.outline()).toEqual(['paragraph:#']);

    // The literal case from the finding: backspacing the word after "# ".
    await editor.setDocument({
      blocks: [{ id: 'q', type: 'paragraph', depth: 0, content: [{ text: '# word' }] }],
    });
    await editor.caretAtEnd('q');

    for (let index = 0; index < 4; index += 1) {
      await page.keyboard.press('Backspace');
    }

    expect(await editor.outline()).toEqual(['paragraph:# ']);
  });

  const INLINE: Array<[typed: string, expected: object[]]> = [
    ['**b**', [{ text: 'b', marks: ['bold'] }]],
    ['__b__', [{ text: 'b', marks: ['bold'] }]],
    ['*i*', [{ text: 'i', marks: ['italic'] }]],
    ['_i_', [{ text: 'i', marks: ['italic'] }]],
    ['~~s~~', [{ text: 's', marks: ['strikethrough'] }]],
    ['`c`', [{ text: 'c', marks: ['code'] }]],
    ['<u>u</u>', [{ text: 'u', marks: ['underline'] }]],
    ['[t](https://x.y)', [{ text: 't', link: 'https://x.y/' }]],
    ['[t](<https://x.y/a)b>)', [{ text: 't', link: 'https://x.y/a)b' }]],
  ];

  for (const [typed, expected] of INLINE) {
    test(`R5 typing ${typed} applies the mark and the next text is plain`, async ({ editor }) => {
      await editor.load({ doc: 'empty' });
      await editor.placeCaret('p1', 0);
      await editor.type(`go ${typed}`);
      await editor.type(' next');
      expect((await editor.blockData('p1'))?.content).toEqual([
        { text: 'go ' },
        ...expected,
        { text: ' next' },
      ]);
    });
  }

  test('R6 near-misses stay literal: spaced asterisks, unsafe links, code blocks', async ({
    editor,
  }) => {
    await editor.load({ doc: 'code' });
    await editor.caretAtEnd('p1');
    await editor.type(' 2 * 3 * 4');
    expect((await editor.blockData('p1'))?.content).toEqual([{ text: 'Before code 2 * 3 * 4' }]);

    await editor.caretAtEnd('p2');
    await editor.type(' [t](javascript:alert(1))');
    expect((await editor.blockData('p2'))?.content).toEqual([
      { text: 'After code [t](javascript:alert(1))' },
    ]);

    await editor.caretAtEnd('code');
    await editor.type(' **not bold**');
    expect((await editor.blockData('code'))?.content).toEqual([
      { text: 'const x = 1; **not bold**' },
    ]);
  });

  test('R6b inline rules do work in a table cell', async ({ editor }) => {
    await editor.load({ doc: 'table' });
    await editor.placeCaret('tbl', 2, 2, { row: 1, column: 1 });
    await editor.type(' **x**');
    expect((await editor.blockData('tbl'))?.rows?.[1]?.[1]).toEqual([
      { text: 'a2 ' },
      { text: 'x', marks: ['bold'] },
    ]);
  });

  test('R7 one undo after a rule restores the typed text', async ({ editor, page }) => {
    await editor.load({ doc: 'empty' });
    await editor.placeCaret('p1', 0);
    await editor.type('# ');
    expect((await editor.doc()).blocks[0]?.type).toBe('heading1');
    await page.keyboard.press(`${MOD}+z`);
    expect(await editor.outline()).toEqual(['paragraph:# ']);

    await editor.setDocument({ blocks: [{ id: 'q', type: 'paragraph', depth: 0, content: [] }] });
    await editor.placeCaret('q', 0);
    await editor.type('**b**');
    await page.keyboard.press(`${MOD}+z`);
    expect((await editor.blockData('q'))?.content).toEqual([{ text: '**b**' }]);
  });

  test('R8 a delimiter typed into an inline code run is code, and closes nothing', async ({
    editor,
  }) => {
    // TXT-9: `*` at the end of `a*b` in code italicised the `b` and ate both
    // asterisks; `*q*` typed inside a code run italicised `q`. Where a typed
    // character lands -- inside the code element or not -- is the engine's
    // call, so this drives real keys.
    await editor.load({ doc: 'paragraphs', toolbar: 0 });
    await editor.setDocument({
      blocks: [
        {
          id: 'x',
          type: 'paragraph',
          depth: 0,
          content: [{ text: 'x ' }, { text: 'a*b', marks: ['code'] }],
        },
      ],
    });
    await editor.clickAt('x', 5);
    await editor.type('*');
    expect((await editor.blockData('x'))?.content).toEqual([
      { text: 'x ' },
      { text: 'a*b*', marks: ['code'] },
    ]);

    await editor.setDocument({
      blocks: [
        {
          id: 'x',
          type: 'paragraph',
          depth: 0,
          content: [{ text: 'x ' }, { text: 'ab', marks: ['code'] }],
        },
      ],
    });
    await editor.clickAt('x', 3);
    await editor.type('*q*');
    expect((await editor.blockData('x'))?.content).toEqual([
      { text: 'x ' },
      { text: 'a*q*b', marks: ['code'] },
    ]);
  });

  test('R9 a backtick typed into a code run does not pair with one already in it', async ({
    editor,
    page,
  }) => {
    // MRG-3, the auditor's literal sequence: the code rule paired the typed
    // backtick with the one inside ``a`b`` and deleted it.
    await editor.load({ doc: 'empty' });
    await editor.content('p1').click();
    await page.keyboard.type('Use a`b', { delay: 10 });
    for (let i = 0; i < 3; i += 1) {
      await page.keyboard.press('Shift+ArrowLeft');
    }
    await page.keyboard.press(`${MOD}+e`);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type(' and `c` ok', { delay: 10 });

    // Every backtick typed is still there; which of the typed characters the
    // engine puts in the code run is its own typing style (TXT-11).
    const content = (await editor.blockData('p1'))!.content;
    expect(content.map((run) => run.text).join('')).toBe('Use a`b and `c` ok');
    expect(content).toContainEqual(
      expect.objectContaining({ text: expect.stringMatching(/^a`b/), marks: ['code'] }),
    );
  });
});
