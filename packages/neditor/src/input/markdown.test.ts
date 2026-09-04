import { describe, expect, test } from 'vitest';

import type { Block } from '../model/document.ts';
import { blockText, createBlock, toMarkdown } from '../model/document.ts';
import {
  richFromPlainText,
  richSetLink,
  richSetMark,
  richToPlainText,
} from '../model/rich-text.ts';
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

  /** 60 bold spans is 119 runs: far more than the scan works on at a time. */
  const spans = Array.from({ length: 60 }, (_, index) => `**b${index}**`).join(' ');
  const spanText = Array.from({ length: 60 }, (_, index) => `b${index}`).join(' ');

  test.each([
    ['strikethrough', `~~${spans}~~`],
    ['underline', `<u>${spans}</u>`],
  ] as const)('a %s span closes over more runs than the scan holds', (mark, source) => {
    // Setting runs aside by count put the opening delimiter out of reach, so
    // the span never closed: the mark was dropped and the delimiters were left
    // sitting in the visible text.
    const runs = parseInlineMarkdown(source);

    expect(richToPlainText(runs)).toBe(spanText);
    expect(runs.every((run) => run.marks?.includes(mark))).toBe(true);
    expect(runs.filter((run) => run.marks?.includes('bold'))).toHaveLength(60);
  });

  test('a link label closes over more runs than the scan holds', () => {
    const runs = parseInlineMarkdown(`[${spans}](https://a.test/)`);

    expect(richToPlainText(runs)).toBe(spanText);
    expect(runs.every((run) => run.link === 'https://a.test/')).toBe(true);
    expect(runs.filter((run) => run.marks?.includes('bold'))).toHaveLength(60);
  });

  test('a delimiter that never closes does not make the rest quadratic', () => {
    // An unmatched `[` is what a link label reaches back over, so the scan has
    // to keep it in hand — but keeping the runs behind it in hand as well made
    // every span after it cost the whole stretch, and this took half a minute.
    const source = `[ ${'*a* '.repeat(250)}[ `.repeat(24);
    const started = performance.now();
    const runs = parseInlineMarkdown(source);

    // An order of magnitude off the ~200ms this takes, and far under the many
    // seconds the same input cost when the working set grew with the window.
    expect(performance.now() - started).toBeLessThan(2000);
    expect(runs.filter((run) => run.marks?.includes('italic'))).toHaveLength(6000);
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
  test('a quote whose first token is a bracketed icon is a callout', () => {
    const blocks = blocksFromMarkdown('> [!💡] remember this');

    expect(blocks[0]?.type).toBe('callout');
    expect(blocks[0]?.icon).toBe('💡');
    expect(blockText(blocks[0]!)).toBe('remember this');
  });

  test('a multi-code-point emoji survives intact', () => {
    // ⚠️ is U+26A0 plus a variation selector.
    expect(blocksFromMarkdown('> [!⚠️] careful')[0]?.icon).toBe('⚠️');
  });

  test('an icon that is not an emoji at all still names a callout', () => {
    expect(blocksFromMarkdown('> [!→] onwards')[0]).toMatchObject({
      type: 'callout',
      icon: '→',
    });
  });

  test('a quote that merely opens with an emoji is not a callout', () => {
    // The emoji is the user's text, not an icon, and reading it as one both
    // retyped the block and ate the character.
    const blocks = blocksFromMarkdown('> 🔥 hot take');

    expect(blocks[0]?.type).toBe('quote');
    expect(blockText(blocks[0]!)).toBe('🔥 hot take');
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

  test('an escaped marker is text, not a toggle', () => {
    // `- ▾` is the empty toggle, so a bullet whose text reads `▾` has to be
    // written some other way; `toMarkdown` escapes it.
    expect(blocksFromMarkdown('- \\\u25BE')[0]).toMatchObject({ type: 'bulleted_list' });
    expect(blockText(blocksFromMarkdown('- \\\u25BE')[0]!)).toBe('\u25BE');
  });

  test('inline marks still apply inside both', () => {
    expect(blocksFromMarkdown('> [!💡] a **b**')[0]?.content.at(-1)).toEqual({
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
      ['> [!📌] pinned note', '- ▸ collapsed toggle', '- ▾ open toggle'].join('\n'),
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

/**
 * The property the clipboard depends on: `toMarkdown` output parsed again is
 * the document it came from. Each case below is a way the two used to disagree.
 */
describe('markdown round trip', () => {
  const round = (blocks: Block[]): Block[] => blocksFromMarkdown(toMarkdown({ blocks }));
  const only = (blocks: Block[]): Block => {
    const back = round(blocks);

    expect(back).toHaveLength(1);

    return back[0]!;
  };

  test('a code fence inside a code block does not end it', () => {
    const source = '```js\nx = 1\n```';

    expect(blockText(only([createBlock('code', source)]))).toBe(source);
  });

  test('a fence longer than the block is still what closes it', () => {
    const blocks = blocksFromMarkdown('````\n```\nx\n```\n````');

    expect(blocks).toHaveLength(1);
    expect(blockText(blocks[0]!)).toBe('```\nx\n```');
  });

  test('a link destination holding a paren survives', () => {
    const link = 'https://a.test/M_(planet)';
    const content = richSetLink(richFromPlainText('Mercury'), 0, 7, link);
    const block = only([{ ...createBlock('paragraph'), content }]);

    expect(blockText(block)).toBe('Mercury');
    expect(block.content[0]?.link).toBe(link);
  });

  test('an image source holding a paren survives', () => {
    const image = { ...createBlock('image'), src: 'https://a.test/a(1).png', alt: 'cat' };

    expect(only([image])).toMatchObject({
      type: 'image',
      src: 'https://a.test/a(1).png',
      alt: 'cat',
    });
  });

  test('an image alt holding a bracket survives', () => {
    const image = { ...createBlock('image'), src: 'https://a.test/x.png', alt: 'a ] b [c]' };

    expect(only([image]).alt).toBe('a ] b [c]');
  });

  test('a paragraph of dashes is not read back as a divider', () => {
    expect(only([createBlock('paragraph', '---')])).toMatchObject({ type: 'paragraph' });
    expect(blockText(only([createBlock('paragraph', '---')]))).toBe('---');
  });

  test.each(['-', '#', '>', '+', '1.', '---', '--- x'])(
    'a paragraph reading %s stays a paragraph',
    (text: string) => {
      const block = only([createBlock('paragraph', text)]);

      expect(block.type).toBe('paragraph');
      expect(blockText(block)).toBe(text);
    },
  );

  test.each([
    ['heading1', {}],
    ['heading2', {}],
    ['heading3', {}],
    ['quote', {}],
    ['bulleted_list', {}],
    ['numbered_list', {}],
    ['todo', { checked: true }],
    ['callout', { icon: '★' }],
    ['toggle', { collapsed: true }],
  ] as const)('an empty %s keeps its type', (type, extra) => {
    // The marker is written with nothing after it, and a marker that needs a
    // trailing space to be read back is a marker any trim silently destroys.
    expect(only([{ ...createBlock(type), ...extra }])).toMatchObject({ type, ...extra });
  });

  test.each(['\u25B8', '\u25BE'])('a bullet whose whole text is %s stays a bullet', (marker) => {
    // The empty toggle is written `- ▾`, so an unescaped marker in the text
    // of a bullet came back as a toggle with nothing in it at all.
    const block = only([createBlock('bulleted_list', marker)]);

    expect(block.type).toBe('bulleted_list');
    expect(blockText(block)).toBe(marker);
  });

  test.each(['\u25B8', '\u25BE'])('a toggle whose text opens with %s keeps both', (marker) => {
    const block = only([{ ...createBlock('toggle', `${marker} later`), collapsed: false }]);

    expect(block).toMatchObject({ type: 'toggle', collapsed: false });
    expect(blockText(block)).toBe(`${marker} later`);
  });

  test('italic after a word character survives', () => {
    const content = richSetMark(richFromPlainText('ChapterOne'), 7, 10, 'italic', true);
    const block = only([{ ...createBlock('paragraph'), content }]);

    expect(blockText(block)).toBe('ChapterOne');
    expect(block.content.at(-1)?.marks).toEqual(['italic']);
  });

  test('bold and italic on the same run survive together', () => {
    let content = richSetMark(richFromPlainText('ab'), 1, 2, 'bold', true);
    content = richSetMark(content, 1, 2, 'italic', true);

    const block = only([{ ...createBlock('paragraph'), content }]);

    expect(blockText(block)).toBe('ab');
    expect(block.content.at(-1)?.marks).toEqual(['bold', 'italic']);
  });

  test('a quote that starts with an emoji is not retyped as a callout', () => {
    const quote = createBlock('quote', '🔥 hot take');
    const block = only([quote]);

    expect(block.type).toBe('quote');
    expect(blockText(block)).toBe('🔥 hot take');
  });

  test.each(['💡', '→', '★', ']'])('a callout keeps the icon %s', (icon: string) => {
    const callout = { ...createBlock('callout', 'note'), icon };

    expect(only([callout])).toMatchObject({ type: 'callout', icon });
    expect(blockText(only([callout]))).toBe('note');
  });

  test('a paragraph past the inline scan limit still parses its markup', () => {
    // The scan used to bail out past a couple of thousand characters, leaving
    // the raw `**` in the text of any long paragraph.
    const long = 'x'.repeat(2100);
    const content = richSetMark(richFromPlainText(`${long}bold`), 2100, 2104, 'bold', true);
    const block = only([{ ...createBlock('paragraph'), content }]);

    expect(blockText(block)).toBe(`${long}bold`);
    expect(block.content.at(-1)).toEqual({ text: 'bold', marks: ['bold'] });
  });

  test('a long line of emphasis stays linear, not quadratic', () => {
    const started = performance.now();
    const runs = parseInlineMarkdown('**b** '.repeat(4000));

    // Two orders of magnitude off the ~40ms this takes, and well under the six
    // seconds it took when the cost of a span grew with the spans before it.
    expect(performance.now() - started).toBeLessThan(2000);
    expect(runs.filter((run) => run.marks?.includes('bold'))).toHaveLength(4000);
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

describe('a span that reaches back is bounded work, not unbounded', () => {
  const nested = (n: number): string => '['.repeat(n) + '*a* '.repeat(n) + '](u)'.repeat(n);

  test('nested spans over one stretch stay under a second', () => {
    // Each closing delimiter used to drag the whole reach back and rebuild it,
    // so this shape was quadratic: 176KB took 47s inside the paste handler.
    const source = Array.from({ length: 50 }, () => nested(400)).join('\n');
    const started = performance.now();

    blocksFromMarkdown(source);

    expect(performance.now() - started).toBeLessThan(4000);
  });

  test('a genuinely long span still closes', () => {
    // The budget must stay well clear of anything a person would write: this
    // is one strikethrough wrapping 400 bold spans, about 3KB.
    const inner = Array.from({ length: 400 }, (_, i) => `**b${i}**`).join(' ');
    const runs = blocksFromMarkdown(`~~${inner}~~`)[0]!.content;

    expect(runs.some((run) => (run.marks ?? []).includes('strikethrough'))).toBe(true);
    expect(runs.map((run) => run.text).join('')).not.toContain('~~');
  });

  test('ordinary documents never reach the budget at all', () => {
    const links = Array.from({ length: 500 }, (_, i) => `[l${i}](https://a.test/${i})`).join(' ');
    const started = performance.now();
    const runs = blocksFromMarkdown(links)[0]!.content;

    expect(runs.filter((run) => run.link).length).toBe(500);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('a backslash before a triangle', () => {
  test('is a literal backslash in ordinary imported Markdown', () => {
    // `\▾` is not an escape any CommonMark reader honours, so eating the
    // backslash destroyed a real one that no round trip could bring back.
    const runs = blocksFromMarkdown('press \\▾ to expand')[0]!.content;

    expect(runs.map((run) => run.text).join('')).toBe('press \\▾ to expand');
  });

  test('is an escape at the head of a bullet, where the writer emits one', () => {
    const block = blocksFromMarkdown('- \\▾ collapsed')[0]!;

    expect(block.type).toBe('bulleted_list');
    expect(block.content.map((run) => run.text).join('')).toBe('▾ collapsed');
  });

  test('an unescaped triangle there still means a toggle', () => {
    expect(blocksFromMarkdown('- ▾ collapsed')[0]!.type).toBe('toggle');
  });

  test('ASCII escapes are unaffected', () => {
    expect(
      blocksFromMarkdown('\\* not italic \\*')[0]!
        .content.map((r) => r.text)
        .join(''),
    ).toBe('* not italic *');
  });
});

describe('a destination that holds its own "]("', () => {
  const href = (source: string): string | undefined =>
    blocksFromMarkdown(source)[0]?.content.find((run) => run.link)?.link;

  test.each(['https://www.google.com/search?q=[foo](bar)', 'https://a.test/x?ids[](1)'])(
    'round-trips through the angle-bracket form: %s',
    (url) => {
      // The writer emits these in angle brackets; the reader used to resolve the
      // inner `[foo](bar)` as a link of its own and hand back a different,
      // still-valid-looking URL.
      expect(href(`[see](<${url}>)`)).toBe(url);
    },
  );
});

describe('a destination carrying many "](" pairs', () => {
  const url = (n: number): string =>
    'https://x.test/q?z=' + Array.from({ length: n }, (_, i) => `[${i}](p${i})`).join('');
  const href = (source: string): string | undefined =>
    blocksFromMarkdown(source)[0]?.content.find((run) => run.link)?.link;

  test.each([1, 7, 8, 12, 40])('parses with %i of them', (n) => {
    // Enumerating candidate openers needed a bound, and past it the link was
    // not merely mis-resolved but lost outright, leaving the raw Markdown as
    // visible block text. The opener is computed now, so there is no cliff.
    expect(href(`[see](<${url(n)}>)`)).toBe(url(n));
  });

  test('and survives a serializer round trip', () => {
    const source = toMarkdown({
      blocks: [{ id: 'p', type: 'paragraph', depth: 0, content: [{ text: 'see', link: url(12) }] }],
    });

    expect(href(source)).toBe(url(12));
  });
});
