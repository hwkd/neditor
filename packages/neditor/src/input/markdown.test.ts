import { describe, expect, test } from 'vitest';

import { blockText, createBlock, toMarkdown } from '../model/document.ts';
import { richFromPlainText, richSetMark, richToPlainText } from '../model/rich-text.ts';
import { blocksFromMarkdown, parseInlineMarkdown } from './markdown.ts';

const types = (md: string) => blocksFromMarkdown(md).map((b) => b.type);
const texts = (md: string) => blocksFromMarkdown(md).map(blockText);
const depths = (md: string) => blocksFromMarkdown(md).map((b) => b.depth);

describe('parseInlineMarkdown', () => {
  test('plain text stays plain', () => {
    expect(parseInlineMarkdown('hello world')).toEqual([{ text: 'hello world' }]);
  });

  test('marks are applied and delimiters removed', () => {
    expect(parseInlineMarkdown('a **b** c')).toEqual([
      { text: 'a ' },
      { text: 'b', marks: ['bold'] },
      { text: ' c' },
    ]);
    expect(parseInlineMarkdown('`x`')).toEqual([{ text: 'x', marks: ['code'] }]);
    expect(parseInlineMarkdown('~~x~~')).toEqual([{ text: 'x', marks: ['strikethrough'] }]);
  });

  test('links are parsed and sanitized', () => {
    expect(parseInlineMarkdown('see [docs](https://a.test/)')).toEqual([
      { text: 'see ' },
      { text: 'docs', link: 'https://a.test/' },
    ]);
  });

  test('an unsafe link stays literal text', () => {
    expect(richToPlainText(parseInlineMarkdown('[x](javascript:alert(1))'))).toBe(
      '[x](javascript:alert(1))',
    );
  });

  test('several spans in one line all convert', () => {
    const runs = parseInlineMarkdown('**a** and *b* and `c`');

    expect(runs.filter((r) => r.marks?.includes('bold'))).toHaveLength(1);
    expect(runs.filter((r) => r.marks?.includes('italic'))).toHaveLength(1);
    expect(runs.filter((r) => r.marks?.includes('code'))).toHaveLength(1);
    expect(richToPlainText(runs)).toBe('a and b and c');
  });

  test('an underscore inside a word is left alone', () => {
    expect(richToPlainText(parseInlineMarkdown('snake_case_name'))).toBe('snake_case_name');
  });

  test('unmatched delimiters are left alone', () => {
    expect(richToPlainText(parseInlineMarkdown('2 * 3 = 6'))).toBe('2 * 3 = 6');
    expect(richToPlainText(parseInlineMarkdown('**unclosed'))).toBe('**unclosed');
  });

  test('typing and pasting produce the same result', () => {
    // parseInlineMarkdown replays the typing rules, so this must hold.
    expect(parseInlineMarkdown('a **b**')).toEqual([
      { text: 'a ' },
      { text: 'b', marks: ['bold'] },
    ]);
  });
});

describe('blocksFromMarkdown', () => {
  test('blank input yields no blocks', () => {
    expect(blocksFromMarkdown('')).toEqual([]);
    expect(blocksFromMarkdown('\n\n  \n')).toEqual([]);
  });

  test('each line becomes a block', () => {
    expect(types('one\ntwo')).toEqual(['paragraph', 'paragraph']);
    expect(texts('one\ntwo')).toEqual(['one', 'two']);
  });

  test('blank lines separate rather than becoming blocks', () => {
    expect(texts('one\n\n\ntwo')).toEqual(['one', 'two']);
  });

  test.each([
    ['# H', 'heading1'],
    ['## H', 'heading2'],
    ['### H', 'heading3'],
    ['- item', 'bulleted_list'],
    ['* item', 'bulleted_list'],
    ['1. item', 'numbered_list'],
    ['7) item', 'numbered_list'],
    ['> quote', 'quote'],
    ['- [ ] task', 'todo'],
    ['[x] task', 'todo'],
    ['---', 'divider'],
    ['***', 'divider'],
  ])('%s becomes %s', (line: string, type: string) => {
    expect(types(line)).toEqual([type]);
  });

  test('the prefix is stripped from the text', () => {
    expect(texts('## Title')).toEqual(['Title']);
    expect(texts('- item')).toEqual(['item']);
    expect(texts('- [x] done')).toEqual(['done']);
  });

  test('to-do checked state is read from the marker', () => {
    expect(blocksFromMarkdown('- [x] done')[0]?.checked).toBe(true);
    expect(blocksFromMarkdown('- [ ] open')[0]?.checked).toBe(false);
  });

  test('a heading prefix is matched longest-first', () => {
    expect(types('### deep')).toEqual(['heading3']);
    expect(texts('### deep')).toEqual(['deep']);
  });

  test('inline marks are parsed inside a block', () => {
    const blocks = blocksFromMarkdown('- **bold** item');

    expect(blocks[0]?.type).toBe('bulleted_list');
    expect(blocks[0]?.content[0]).toEqual({ text: 'bold', marks: ['bold'] });
  });

  test('indentation becomes depth', () => {
    expect(depths('- a\n  - b\n    - c')).toEqual([0, 1, 2]);
  });

  test('a tab counts as one level', () => {
    expect(depths('- a\n\t- b')).toEqual([0, 1]);
  });

  test('a fenced block becomes one code block, verbatim', () => {
    const blocks = blocksFromMarkdown('```\nconst a = **1**;\nline two\n```');

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('code');
    expect(blockText(blocks[0]!)).toBe('const a = **1**;\nline two');
  });

  test('an unterminated fence still yields its content', () => {
    const blocks = blocksFromMarkdown('```\nunclosed');

    expect(blocks[0]?.type).toBe('code');
    expect(blockText(blocks[0]!)).toBe('unclosed');
  });

  test('a realistic document round-trips into the right shapes', () => {
    const blocks = blocksFromMarkdown(
      ['# Title', '', 'Some **bold** prose.', '', '- one', '- two', '', '> quoted', '', '---'].join(
        '\n',
      ),
    );

    expect(blocks.map((b) => b.type)).toEqual([
      'heading1',
      'paragraph',
      'bulleted_list',
      'bulleted_list',
      'quote',
      'divider',
    ]);
  });
});

describe('callouts and toggles', () => {
  test('a quote led by an emoji is a callout', () => {
    const blocks = blocksFromMarkdown('> 💡 remember this');

    expect(blocks[0]?.type).toBe('callout');
    expect(blocks[0]?.icon).toBe('💡');
    expect(blockText(blocks[0]!)).toBe('remember this');
  });

  test('a multi-code-point emoji survives intact', () => {
    // ⚠️ is U+26A0 plus a variation selector.
    expect(blocksFromMarkdown('> ⚠️ careful')[0]?.icon).toBe('⚠️');
  });

  test('a plain quote stays a quote', () => {
    const blocks = blocksFromMarkdown('> just quoted');

    expect(blocks[0]?.type).toBe('quote');
    expect(blockText(blocks[0]!)).toBe('just quoted');
  });

  test('the toggle markers set the collapsed state', () => {
    expect(blocksFromMarkdown('- ▸ hidden')[0]).toMatchObject({
      type: 'toggle',
      collapsed: true,
    });
    expect(blocksFromMarkdown('- ▾ shown')[0]).toMatchObject({
      type: 'toggle',
      collapsed: false,
    });
    expect(blockText(blocksFromMarkdown('- ▸ hidden')[0]!)).toBe('hidden');
  });

  test('a plain bullet stays a bullet', () => {
    expect(blocksFromMarkdown('- ordinary')[0]?.type).toBe('bulleted_list');
  });

  test('inline marks still apply inside both', () => {
    expect(blocksFromMarkdown('> 💡 a **b**')[0]?.content.at(-1)).toEqual({
      text: 'b',
      marks: ['bold'],
    });
    expect(blocksFromMarkdown('- ▾ a **b**')[0]?.content.at(-1)).toEqual({
      text: 'b',
      marks: ['bold'],
    });
  });

  test('both round-trip through toMarkdown', () => {
    const source = blocksFromMarkdown(
      ['> 📌 pinned note', '- ▸ collapsed toggle', '- ▾ open toggle'].join('\n'),
    );
    const round = blocksFromMarkdown(toMarkdown({ blocks: source }));

    expect(round.map((b) => b.type)).toEqual(source.map((b) => b.type));
    expect(round.map(blockText)).toEqual(source.map(blockText));
    expect(round.map((b) => b.icon)).toEqual(source.map((b) => b.icon));
    expect(round.map((b) => b.collapsed)).toEqual(source.map((b) => b.collapsed));
  });
});

describe('images and tables', () => {
  test('a lone image line becomes an image block', () => {
    const blocks = blocksFromMarkdown('![a cat](https://a.test/cat.png)');

    expect(blocks[0]).toMatchObject({
      type: 'image',
      src: 'https://a.test/cat.png',
      alt: 'a cat',
    });
  });

  test('an unsafe image source stays literal text', () => {
    expect(blocksFromMarkdown('![x](javascript:alert(1))')[0]?.type).toBe('paragraph');
  });

  test('an image inside a sentence is not a block', () => {
    expect(blocksFromMarkdown('see ![x](https://a.test/x.png) here')[0]?.type).toBe('paragraph');
  });

  test('a GFM table becomes one table block', () => {
    const blocks = blocksFromMarkdown(['| a | b |', '| --- | --- |', '| c | d |'].join('\n'));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('table');
    expect(blocks[0]?.rows?.map((row) => row.map(richToPlainText))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  test('the alignment row is dropped, not read as content', () => {
    const rows = blocksFromMarkdown(['| a |', '| :---: |', '| b |'].join('\n'))[0]?.rows;

    expect(rows).toHaveLength(2);
  });

  test('cells keep their inline formatting', () => {
    const rows = blocksFromMarkdown(['| **bold** |', '| --- |', '| x |'].join('\n'))[0]?.rows;

    expect(rows?.[0]?.[0]).toEqual([{ text: 'bold', marks: ['bold'] }]);
  });

  test('an escaped pipe stays inside its cell', () => {
    const rows = blocksFromMarkdown(['| a \\| b | c |', '| --- | --- |'].join('\n'))[0]?.rows;

    expect(rows?.[0]?.map(richToPlainText)).toEqual(['a | b', 'c']);
  });

  test('a table ends where the pipes stop', () => {
    const blocks = blocksFromMarkdown(
      ['| a |', '| --- |', '| b |', '', 'after the table'].join('\n'),
    );

    expect(blocks.map((b) => b.type)).toEqual(['table', 'paragraph']);
  });

  test('two separated tables stay separate blocks', () => {
    const blocks = blocksFromMarkdown(
      ['| a |', '| --- |', '', 'gap', '', '| b |', '| --- |'].join('\n'),
    );

    expect(blocks.map((b) => b.type)).toEqual(['table', 'paragraph', 'table']);
  });

  test('both round-trip through toMarkdown', () => {
    const source = blocksFromMarkdown(
      [
        '![alt text](https://a.test/x.png)',
        '',
        '| h1 | h2 |',
        '| --- | --- |',
        '| **a** | b |',
      ].join('\n'),
    );
    const round = blocksFromMarkdown(toMarkdown({ blocks: source }));

    expect(round.map((b) => b.type)).toEqual(['image', 'table']);
    expect(round[0]).toMatchObject({ src: 'https://a.test/x.png', alt: 'alt text' });
    expect(round[1]?.rows?.map((row) => row.map(richToPlainText))).toEqual([
      ['h1', 'h2'],
      ['a', 'b'],
    ]);
    expect(round[1]?.rows?.[1]?.[0]).toEqual([{ text: 'a', marks: ['bold'] }]);
  });
});

describe('round-trip fidelity', () => {
  const paragraph = (text: string): string => {
    const md = toMarkdown({ blocks: [createBlock('paragraph', text)] });
    return blockText(blocksFromMarkdown(md)[0]!);
  };

  test.each([
    '2 * 3 * 4',
    '# 1 in the docs',
    'snake_case_name',
    'a | b',
    'C:\\path\\to',
    '5 < 6 > 4',
    '- not a list',
    '> not a quote',
    '1. not a list',
    'a `backtick` and [brackets]',
    '~~~ and ***',
  ])('%s survives escaping unchanged', (text: string) => {
    // Output is parsed again by blocksFromMarkdown, so anything unescaped is
    // silently reinterpreted.
    expect(paragraph(text)).toBe(text);
  });

  test('a paragraph that looks like a heading stays a paragraph', () => {
    const md = toMarkdown({ blocks: [createBlock('paragraph', '# not a heading')] });

    expect(blocksFromMarkdown(md)[0]?.type).toBe('paragraph');
  });

  test('underline survives, rather than leaving junk characters behind', () => {
    const content = richSetMark(richFromPlainText('under'), 0, 5, 'underline', true);
    const back = blocksFromMarkdown(
      toMarkdown({ blocks: [{ ...createBlock('paragraph'), content }] }),
    );

    expect(blockText(back[0]!)).toBe('under');
    expect(back[0]?.content[0]?.marks).toEqual(['underline']);
  });

  test('a soft line break stays one block', () => {
    const back = blocksFromMarkdown(
      toMarkdown({ blocks: [createBlock('paragraph', 'line one\nline two')] }),
    );

    expect(back).toHaveLength(1);
    expect(blockText(back[0]!)).toBe('line one\nline two');
  });

  test('a literal trailing backslash is not read as a break', () => {
    const back = blocksFromMarkdown(
      toMarkdown({
        blocks: [createBlock('paragraph', 'ends with\\'), createBlock('paragraph', 'next')],
      }),
    );

    expect(back).toHaveLength(2);
    expect(blockText(back[0]!)).toBe('ends with\\');
  });

  test('code and table keep their depth', () => {
    const nested = blocksFromMarkdown(
      toMarkdown({
        blocks: [createBlock('paragraph', 'x'), createBlock('code', 'const a = 1;', 1)],
      }),
    );

    expect(nested.map((b) => b.depth)).toEqual([0, 1]);
    expect(blocksFromMarkdown('  | a |\n  | --- |')[0]?.depth).toBe(1);
  });

  test('a code block is never escaped, and comes back verbatim', () => {
    const source = 'const a = **not bold**; // 2 * 3';
    const back = blocksFromMarkdown(toMarkdown({ blocks: [createBlock('code', source)] }));

    expect(blockText(back[0]!)).toBe(source);
  });

  test('a callout icon that is not an emoji still round-trips', () => {
    const callout = { ...createBlock('callout', 'starred'), icon: '★' };
    const back = blocksFromMarkdown(toMarkdown({ blocks: [callout] }));

    expect(back[0]?.type).toBe('callout');
    expect(back[0]?.icon).toBe('★');
  });

  test('an escaped pipe stays inside its cell, and marks survive', () => {
    const source = blocksFromMarkdown('| **a** \\| b |\n| --- |');
    const back = blocksFromMarkdown(toMarkdown({ blocks: source }));
    const cell = back[0]?.rows?.[0]?.[0];

    expect(back[0]?.type).toBe('table');
    expect(richToPlainText(cell ?? [])).toBe('a | b');
    expect(cell?.[0]?.marks).toEqual(['bold']);
  });
});

describe('table rows that look like alignment', () => {
  test('a body row of dashes is content, not alignment', () => {
    const rows = blocksFromMarkdown(
      ['| name | value |', '| --- | --- |', '| a | --- |', '| --- | --- |'].join('\n'),
    )[0]?.rows;

    // Only the row after the header is alignment. `---` is a common "no value"
    // placeholder, and dropping it silently deleted a row of the table.
    expect(rows).toHaveLength(3);
    expect(rows?.[2]?.map(richToPlainText)).toEqual(['---', '---']);
  });

  test('the real alignment row is still dropped', () => {
    const rows = blocksFromMarkdown(['| a |', '| :---: |', '| b |'].join('\n'))[0]?.rows;

    expect(rows).toHaveLength(2);
  });

  test('lines that are nothing but alignment come back as text', () => {
    const blocks = blocksFromMarkdown('| --- | --- |');

    // Consuming them into nothing lost the user's content outright.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('paragraph');
    expect(blockText(blocks[0]!)).toBe('| --- | --- |');
  });
});
