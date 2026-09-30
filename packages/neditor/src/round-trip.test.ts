// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';

import type { Block } from './index.ts';
import {
  blocksFromHtml,
  blocksFromMarkdown,
  blocksToHtml,
  normalizeDocument,
  toMarkdown,
} from './index.ts';

/**
 * Round-trip properties.
 *
 * `toMarkdown` output is parsed again by `blocksFromMarkdown`, and `blocksToHtml`
 * output by `blocksFromHtml` — that is how the clipboard and every save/reload
 * cycle work. So both pairs must be inverses, and where they are not, a user
 * silently loses content.
 *
 * The suite is green, but it is not claiming the editor round-trips everything:
 * `KNOWN_MARKDOWN_FAILURES` and `KNOWN_HTML_FAILURES` below are an inventory of
 * cases that are currently broken, each tagged with its audit finding. The test
 * asserts BOTH directions — untagged cases must round-trip, and tagged cases
 * must still fail. So fixing one of them turns this suite red and tells you to
 * delete its line, and the registry can never quietly go stale.
 */

let counter = 0;
const b = (over: Partial<Block>): Block =>
  ({ id: `b${++counter}`, type: 'paragraph', depth: 0, content: [], ...over }) as Block;
const t = (text: string, extra: Record<string, unknown> = {}) => [{ text, ...extra }];

const CORPUS: Record<string, Block[]> = {
  'plain paragraph': [b({ content: t('hello world') })],
  'bold run': [b({ content: [{ text: 'a ' }, { text: 'bold', marks: ['bold'] }] })],
  'italic after space': [b({ content: [{ text: 'a ' }, { text: 'it', marks: ['italic'] }] })],
  'italic after word char': [
    b({ content: [{ text: 'Chapter' }, { text: 'One', marks: ['italic'] }] }),
  ],
  'bold+italic': [b({ content: [{ text: 'a' }, { text: 'b', marks: ['bold', 'italic'] }] })],
  underline: [b({ content: t('u', { marks: ['underline'] }) })],
  strike: [b({ content: t('s', { marks: ['strikethrough'] }) })],
  'inline code': [b({ content: t('c', { marks: ['code'] }) })],
  'simple link': [b({ content: t('site', { link: 'https://a.test/' }) })],
  'link with paren': [b({ content: t('Mercury', { link: 'https://a.test/M_(planet)' }) })],
  heading1: [b({ type: 'heading1', content: t('Title') })],
  'empty heading1': [b({ type: 'heading1', content: [] })],
  'empty quote': [b({ type: 'quote', content: [] })],
  'empty todo': [b({ type: 'todo', content: [], checked: false })],
  'empty bulleted': [b({ type: 'bulleted_list', content: [] })],
  'empty callout': [b({ type: 'callout', content: [], icon: '\u{1F4A1}' })],
  'empty toggle': [b({ type: 'toggle', content: [], collapsed: false })],
  quote: [b({ type: 'quote', content: t('quoted') })],
  'quote starting with emoji': [b({ type: 'quote', content: t('\u{1F525} hot take') })],
  'callout emoji icon': [b({ type: 'callout', content: t('note'), icon: '\u{1F4A1}' })],
  'callout arrow icon': [b({ type: 'callout', content: t('note'), icon: '→' })],
  'bulleted list': [b({ type: 'bulleted_list', content: t('one') })],
  'nested list': [
    b({ type: 'bulleted_list', content: t('one') }),
    b({ type: 'bulleted_list', content: t('two'), depth: 1 }),
  ],
  'numbered list': [b({ type: 'numbered_list', content: t('first') })],
  todo: [b({ type: 'todo', content: t('task'), checked: true })],
  divider: [b({ type: 'divider', content: [] })],
  'paragraph of dashes': [b({ content: t('---') })],
  'paragraph of asterisks': [b({ content: t('***') })],
  'code block': [b({ type: 'code', content: t('const a = 1;') })],
  'code block with fence': [b({ type: 'code', content: t('```js\nx = 1\n```') })],
  image: [b({ type: 'image', src: 'https://a.test/x.png', alt: 'cat' })],
  'image with paren in src': [b({ type: 'image', src: 'https://a.test/a(1).png', alt: 'cat' })],
  table: [
    b({
      type: 'table',
      rows: [
        [t('h1'), t('h2')],
        [t('a'), t('b')],
      ],
    }),
  ],
  'table with pipe in cell': [
    b({
      type: 'table',
      rows: [
        [t('a|b'), t('c')],
        [t('d'), t('e')],
      ],
    }),
  ],
  'text with asterisks': [b({ content: t('2 * 3 * 4') })],
  'text with underscore': [b({ content: t('snake_case_name') })],
  'text with brackets': [b({ content: t('array[0] and [x](y)') })],
  'soft break': [b({ content: t('line one\nline two') })],
  'empty paragraph between': [b({ content: t('A') }), b({ content: [] }), b({ content: t('B') })],
  // F1 (e2e finding): the reader trims every line, so whitespace at either edge
  // of a block's text was lost -- and Enter mid-sentence leaves exactly that.
  'leading space': [b({ content: t(' one') })],
  'trailing space': [b({ content: t('one ') })],
  'tab-led paragraph': [b({ content: t('\tTab') })],
  'edge spaces in a heading': [b({ type: 'heading1', content: t(' Title ') })],
  'bullet with a leading space': [b({ type: 'bulleted_list', content: t(' one') })],
  'bold run after a leading space': [
    b({ content: [{ text: ' ' }, { text: 'bold', marks: ['bold'] }] }),
  ],
  'edge whitespace in a table cell': [
    b({
      type: 'table',
      rows: [
        [t(' a '), t('b')],
        [t('c'), t(' ')],
      ],
    }),
  ],
  // The escape that makes the one above possible must not eat this.
  'literal numeric reference': [b({ content: t('write &#32; or &#x20; for a space') })],
  // Found auditing F1: decoding references everywhere corrupted hrefs.
  'link whose href holds a numeric reference': [
    b({ content: t('x', { link: 'https://a.test/?q=a&#38;b' }) }),
  ],
  'code span holding a numeric reference': [b({ content: t('&#169;', { marks: ['code'] }) })],
  // F14 (found auditing F1): a newline at either edge of a block -- Shift+Enter
  // at the end of one -- was dropped the same way edge spaces were.
  'trailing newline': [b({ content: t('a\n') })],
  'leading newline': [b({ content: t('\na') })],
  'newlines and spaces at both edges': [b({ content: t(' \na b\n ') })],
  'trailing literal backslash then newline': [b({ content: t('a\\\n') })],
  // A11 (audit): whitespace at the edge of a marked run was written outside
  // its delimiters, so the mark on it was lost -- invisible for bold, visible
  // as a gap in an underline, a strike, a code span or a link.
  'bold run with edge spaces, mid-text': [
    b({ content: [{ text: 'a' }, { text: ' x ', marks: ['bold'] }, { text: 'b' }] }),
  ],
  'bold run with edge spaces, whole block': [b({ content: t(' x ', { marks: ['bold'] }) })],
  'bold on a lone space': [
    b({ content: [{ text: 'a' }, { text: ' ', marks: ['bold'] }, { text: 'b' }] }),
  ],
  'italic run with edge spaces, mid-text': [
    b({ content: [{ text: 'a' }, { text: ' x ', marks: ['italic'] }, { text: 'b' }] }),
  ],
  'italic run with edge spaces, whole block': [b({ content: t(' x ', { marks: ['italic'] }) })],
  'italic on a lone space': [
    b({ content: [{ text: 'a' }, { text: ' ', marks: ['italic'] }, { text: 'b' }] }),
  ],
  'strikethrough run with edge spaces, mid-text': [
    b({ content: [{ text: 'a' }, { text: ' x ', marks: ['strikethrough'] }, { text: 'b' }] }),
  ],
  'strikethrough run with edge spaces, whole block': [
    b({ content: t(' x ', { marks: ['strikethrough'] }) }),
  ],
  'strikethrough on a lone space': [
    b({ content: [{ text: 'a' }, { text: ' ', marks: ['strikethrough'] }, { text: 'b' }] }),
  ],
  'underline run with edge spaces, mid-text': [
    b({ content: [{ text: 'a' }, { text: ' x ', marks: ['underline'] }, { text: 'b' }] }),
  ],
  'underline run with edge spaces, whole block': [
    b({ content: t(' x ', { marks: ['underline'] }) }),
  ],
  'underline on a lone space': [
    b({ content: [{ text: 'a' }, { text: ' ', marks: ['underline'] }, { text: 'b' }] }),
  ],
  'code run with edge spaces, mid-text': [
    b({ content: [{ text: 'a' }, { text: ' x ', marks: ['code'] }, { text: 'b' }] }),
  ],
  'code run with edge spaces, whole block': [b({ content: t(' x ', { marks: ['code'] }) })],
  'code on a lone space': [
    b({ content: [{ text: 'a' }, { text: ' ', marks: ['code'] }, { text: 'b' }] }),
  ],
  'link text with edge spaces': [
    b({ content: [{ text: 'a' }, { text: ' x ', link: 'https://a.test/' }, { text: 'b' }] }),
  ],
  'bold and underlined, edge spaces': [
    b({ content: [{ text: 'a' }, { text: ' x ', marks: ['bold', 'underline'] }, { text: 'b' }] }),
  ],
  'bold link, edge spaces': [
    b({
      content: [
        { text: 'a' },
        { text: ' x ', marks: ['bold'], link: 'https://a.test/' },
        { text: 'b' },
      ],
    }),
  ],
  'italic code, edge spaces': [
    b({ content: [{ text: 'a' }, { text: ' x ', marks: ['code', 'italic'] }, { text: 'b' }] }),
  ],
  // F15 (found fixing A11): an emphasis rule fired inside a link destination
  // before its `)` arrived, so `_y_` in a URL came back as `y`.
  'link whose destination holds underscores': [
    b({ content: t('x', { link: 'https://a.test/_y_/z' }) }),
  ],
  'link whose destination holds asterisks': [
    b({ content: t('x', { link: 'https://a.test/*y*' }) }),
  ],
  'link whose destination holds backticks': [
    b({ content: t('x', { link: 'https://a.test/`y`' }) }),
  ],
  // A11 (audit): the caption was not written to Markdown at all.
  'image with a caption': [
    b({ type: 'image', src: 'https://a.test/x.png', alt: 'cat', content: t('A cat') }),
  ],
  'image with a formatted caption': [
    b({
      type: 'image',
      src: 'https://a.test/x.png',
      alt: 'cat',
      content: [
        { text: 'See ' },
        { text: 'this', marks: ['bold'] },
        { text: ' ' },
        { text: 'link', link: 'https://a.test/' },
      ],
    }),
  ],
  'image with a caption edged in spaces': [
    b({ type: 'image', src: 'https://a.test/x.png', alt: 'cat', content: t(' cap ') }),
  ],
  'empty image with a caption': [b({ type: 'image', src: '', alt: '', content: t('coming soon') })],
  // F4 (e2e finding): an image with no source came back as literal "![]()".
  'empty image': [b({ type: 'image', src: '', alt: '' })],
  'empty image with alt': [b({ type: 'image', src: '', alt: 'pending' })],
  'long block with bold': [
    b({ content: [{ text: 'x'.repeat(2100) }, { text: 'bold', marks: ['bold'] }] }),
  ],
};

/** Currently broken through `toMarkdown` -> `blocksFromMarkdown`. */
const KNOWN_MARKDOWN_FAILURES: Record<string, string> = {
  // Markdown has no way to express an empty paragraph: the writer emits a blank
  // line and the reader skips blank lines. The HTML path preserves them.
  'empty paragraph between': 'documented gap: Markdown cannot express an empty paragraph',
};

/** Currently broken through `blocksToHtml` -> `blocksFromHtml`. */
const KNOWN_HTML_FAILURES: Record<string, string> = {};

/** The parts of a block a round trip has to preserve. */
function shape(blocks: readonly Block[]): unknown {
  return blocks.map((block) => ({
    type: block.type,
    depth: block.depth ?? 0,
    // The runs themselves, not a summary of them. Runs are canonical after
    // normalizeDocument, so equal content is deeply equal -- and a summary
    // ("some run was bold") could not see which characters carried a mark,
    // which is how a mark falling off edge whitespace passed here unnoticed.
    content: block.content ?? [],
    src: block.src ?? '',
    alt: block.alt ?? '',
    icon: block.icon ?? '',
    checked: block.checked ?? null,
    rows: block.rows ?? null,
  }));
}

const start = (blocks: Block[]): Block[] => normalizeDocument({ blocks }).blocks;

const throughMarkdown = (blocks: Block[]): Block[] =>
  normalizeDocument({ blocks: blocksFromMarkdown(toMarkdown({ blocks })) }).blocks;

const throughHtml = (blocks: Block[]): Block[] =>
  normalizeDocument({ blocks: blocksFromHtml(document, blocksToHtml(document, blocks)) }).blocks;

function survives(blocks: Block[], through: (b: Block[]) => Block[]): boolean {
  const before = start(blocks);

  try {
    return JSON.stringify(shape(before)) === JSON.stringify(shape(through(before)));
  } catch {
    return false;
  }
}

describe.each([
  ['markdown', throughMarkdown, KNOWN_MARKDOWN_FAILURES],
  ['html', throughHtml, KNOWN_HTML_FAILURES],
] as const)('%s round trip', (_name, through, known) => {
  const names = Object.keys(CORPUS);
  const expected = names.filter((name) => !known[name]).map((name) => [name] as const);
  const broken = names.filter((name) => known[name]).map((name) => [name, known[name]!] as const);

  test.each(expected)('%s round-trips', (name) => {
    const before = start(CORPUS[name]!);

    expect(shape(through(before))).toEqual(shape(before));
  });

  // If one of these starts passing, the defect is fixed: delete its registry
  // entry so the case is held to the real property from then on.
  test.each(broken)('KNOWN FAILURE: %s — %s', (name) => {
    expect(
      survives(CORPUS[name]!, through),
      `"${name}" now round-trips. Remove it from the known-failure registry.`,
    ).toBe(false);
  });
});

describe('round-trip coverage is not silently shrinking', () => {
  test('the corpus still covers every block type the editor can produce', () => {
    const covered = new Set(Object.values(CORPUS).flatMap((blocks) => blocks.map((x) => x.type)));

    for (const type of [
      'paragraph',
      'heading1',
      'quote',
      'code',
      'bulleted_list',
      'numbered_list',
      'todo',
      'callout',
      'toggle',
      'divider',
      'image',
      'table',
    ]) {
      expect(covered, `no round-trip case covers "${type}"`).toContain(type);
    }
  });

  test('every registry entry names a case that exists', () => {
    for (const name of [
      ...Object.keys(KNOWN_MARKDOWN_FAILURES),
      ...Object.keys(KNOWN_HTML_FAILURES),
    ]) {
      expect(CORPUS, `registry names "${name}", which is not in the corpus`).toHaveProperty(name);
    }
  });
});

describe('an empty image is ours to write, not a reading of foreign markup', () => {
  // F4 made `<figure data-neditor-image>` read back as an empty image block.
  // The marker is what licenses it: a page's own `<img src="">` or a figure
  // with no usable picture must still produce nothing, not a placeholder.
  test('a foreign image with no usable source still produces no block', () => {
    expect(blocksFromHtml(document, '<figure><img src=""></figure>')).toEqual([]);
    expect(blocksFromHtml(document, '<p><img src="javascript:alert(1)"></p>')).toEqual([]);
    expect(blocksFromMarkdown('![x](javascript:alert(1))').map((block) => block.type)).toEqual([
      'paragraph',
    ]);
  });
});

describe('numeric references are decoded only where the writer puts them', () => {
  // The writer emits references only at the edges of a block's text. Decoding
  // them anywhere else changed foreign text: a pasted code span, a link.
  test('mid-text, in code and in link destinations they stay literal', () => {
    const [code] = blocksFromMarkdown('use `&#169;` here');
    expect(code?.content).toEqual([
      { text: 'use ' },
      { text: '&#169;', marks: ['code'] },
      { text: ' here' },
    ]);

    const [link] = blocksFromMarkdown('see [x](https://a.test/?q=a&#38;b) now');
    expect(link?.content[1]).toEqual({ text: 'x', link: 'https://a.test/?q=a&#38;b' });

    const [prose] = blocksFromMarkdown('a &#32; b');
    expect(prose?.content).toEqual([{ text: 'a &#32; b' }]);
  });

  test('at the edges they are decoded', () => {
    const [block] = blocksFromMarkdown('&#32;one&#10;');
    expect(block?.content).toEqual([{ text: ' one\n' }]);
  });
});

describe('inside a link destination only the link rule applies', () => {
  test('typing the closing underscore of a URL does not italicise it', async () => {
    const { matchInlineRule } = await import('./index.ts');
    expect(matchInlineRule('[x](https://a.test/_y_')).toBeNull();
    expect(matchInlineRule('[x](<https://a.test/*y*')).toBeNull();
    expect(matchInlineRule('[x](https://a.test/_y_)')?.link).toBe('https://a.test/_y_');
  });

  test('outside one, emphasis still fires', async () => {
    const { matchInlineRule } = await import('./index.ts');
    expect(matchInlineRule('see _y_')?.mark).toBe('italic');
    expect(matchInlineRule('[x](https://a.test/) and _y_')?.mark).toBe('italic');
  });
});
