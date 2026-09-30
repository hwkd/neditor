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

describe('audit 2: what other readers see, and what this one must not misread', () => {
  // Checked against commonmark.js 0.31: `a**bold&#32;**b` is literal asterisks
  // there -- the closer is preceded by punctuation and followed by a letter, so
  // it is not right-flanking. Runs with edge whitespace are written as HTML
  // tags, which CommonMark renders as written.
  test.each([
    [
      [{ text: 'a' }, { text: 'bold ', marks: ['bold'] }, { text: 'b' }],
      'a<strong>bold </strong>b',
    ],
    [[{ text: 'a' }, { text: ' it', marks: ['italic'] }, { text: 'b' }], 'a<em> it</em>b'],
    [[{ text: 'a' }, { text: 'x ', marks: ['strikethrough'] }, { text: 'b' }], 'a<s>x </s>b'],
    [[{ text: 'a' }, { text: ' x ', marks: ['code'] }, { text: 'b' }], 'a<code> x </code>b'],
    [[{ text: 'a' }, { text: ' ', marks: ['bold'] }, { text: 'b' }], 'a<strong> </strong>b'],
    [[{ text: 'a ' }, { text: 'bold', marks: ['bold'] }, { text: ' b' }], 'a **bold** b'],
  ] as const)('%j is written %s', (content, markdown) => {
    const blocks = [b({ content: content as never })];
    expect(toMarkdown({ blocks })).toBe(markdown);
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  // B12. CommonMark takes a backtick code span's content literally, so the
  // backslash escapes the writer put there were shown: `snake\_case` on GitHub.
  // A code run that needs escaping is written as <code>, where they are honoured.
  test.each([
    ['snake_case', 'a<code>snake\\_case</code>b'],
    ['a*b<c', 'a<code>a\\*b\\<c</code>b'],
    ['one\ntwo', 'a<code>one\\\ntwo</code>b'],
    ['plain', 'a`plain`b'],
  ])('code %j is written %s', (text, markdown) => {
    const blocks = [b({ content: [{ text: 'a' }, { text, marks: ['code'] }, { text: 'b' }] })];
    expect(toMarkdown({ blocks })).toBe(markdown);
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  test('a whitespace-only bold run is written once, not a reference per space', () => {
    const blocks = [
      b({ content: [{ text: 'a' }, { text: ' '.repeat(3000), marks: ['bold'] }, { text: 'b' }] }),
    ];
    expect(toMarkdown({ blocks }).length).toBeLessThan(3100);
  });

  test('a paragraph opening with "!" and a link is not read back as an image', () => {
    const one = [b({ content: [{ text: '!' }, { text: 'a', link: 'https://i.test/x.png' }] })];
    const two = [
      b({
        content: [
          { text: '!' },
          { text: 'a', link: 'https://i.test/x.png' },
          { text: '\nsecond line' },
        ],
      }),
    ];
    expect(shape(throughMarkdown(one))).toEqual(shape(start(one)));
    expect(shape(throughMarkdown(two))).toEqual(shape(start(two)));
  });

  test('"1." before a line break stays a paragraph', () => {
    const blocks = [b({ content: t('1.\nnext') })];
    expect(shape(throughMarkdown(blocks))).toEqual(shape(start(blocks)));
  });

  test('a continuation line that opens with a block marker is escaped for other readers', () => {
    const blocks = [
      b({ content: t('first\n# not a heading\n- not a list\n---') }),
      b({ type: 'image', src: 'https://a.test/x.png', alt: 'cat', content: t('# caption') }),
    ];
    const markdown = toMarkdown({ blocks });
    expect(markdown).toContain('\\# not a heading');
    expect(markdown).toContain('\\- not a list');
    expect(markdown).toContain('\\---');
    expect(markdown).toContain('\\# caption');
    expect(shape(throughMarkdown(blocks))).toEqual(shape(start(blocks)));
  });

  test('code spans holding an unclosed "](" are still code', () => {
    for (const line of ['a `](` b', 'x `[a](b` y', '`see ](x`']) {
      const runs = blocksFromMarkdown(line)[0]?.content ?? [];
      expect(runs.some((run) => run.marks?.includes('code'))).toBe(true);
    }
  });

  test('an unclosed "](<" does not suppress emphasis for the rest of the line', () => {
    // A destination never holds whitespace -- the writer percent-encodes it in
    // the angled form too -- so a space ends the question.
    const runs = blocksFromMarkdown('see [a](<b and *y*')[0]?.content ?? [];
    expect(runs.at(-1)).toEqual({ text: 'y', marks: ['italic'] });
  });

  test('the open-destination check is linear', () => {
    const line = `${']('.repeat(1000)}${' *'.repeat(1000)}`;
    const began = performance.now();
    blocksFromMarkdown(line.repeat(10));
    // A budget, not a ratio: the check works on a bounded window, so what it
    // cost was a constant factor (3.6 s here) rather than a growth rate. Set
    // well clear of the ~50 ms it takes, which a loaded machine has tripled.
    expect(performance.now() - began).toBeLessThan(1500);
  });
});

describe('audit 3', () => {
  const lines = Array.from({ length: 90 }, (_, index) => `src/components/Widget${index}.tsx`).join(
    '\n',
  );

  // A regression from keeping multi-line runs whole: with no space in reach the
  // writer could not split a long run, and the reader cannot close a span that
  // long, so it came back as raw markup.
  test.each(['code', 'bold'] as const)(
    'a long %s run of lines with no spaces round-trips',
    (mark) => {
      const blocks = [b({ content: [{ text: lines, marks: [mark] }] })];
      expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
    },
  );

  // An ATX heading is one line in every other reader, so a span written whole
  // across a break there split its delimiters between heading and paragraph.
  test('a heading writes each line of a formatted run as its own span', () => {
    const blocks = [b({ type: 'heading1', content: t('Title\nsub', { marks: ['bold'] }) })];
    expect(toMarkdown({ blocks })).toBe('# **Title**\\\n**sub**');
    const back = throughMarkdown(blocks)[0]!;
    expect(back.content.filter((run) => run.text !== '\n')).toEqual([
      { text: 'Title', marks: ['bold'] },
      { text: 'sub', marks: ['bold'] },
    ]);
  });

  test('a named entity in the text is escaped, and comes back as typed', () => {
    const blocks = [b({ content: t('a &amp; b &copy; c & d') })];
    expect(toMarkdown({ blocks })).toBe('a \\&amp; b \\&copy; c & d');
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  // CommonMark: `**` after a letter and before punctuation cannot open.
  test.each([
    [[{ text: 'word' }, { text: '(x)', marks: ['bold'] }], 'word<strong>(x)</strong>'],
    [[{ text: '(x)', marks: ['italic'] }, { text: 'word' }], '<em>(x)</em>word'],
    [[{ text: 'a (' }, { text: 'x', marks: ['bold'] }, { text: ') b' }], 'a (**x**) b'],
    [[{ text: 'a ' }, { text: '(x)', marks: ['bold'] }, { text: ' b' }], 'a **(x)** b'],
    // The delimiter sits against what is written inside it, not the run's text:
    // a code span's backtick is punctuation.
    [
      [{ text: 'x y', marks: ['bold', 'code'] }, { text: '1' }],
      '<strong><code>x y</code></strong>1',
    ],
    [[{ text: 'a' }, { text: 'b', marks: ['italic', 'code'] }], 'a<em><code>b</code></em>'],
    [[{ text: 'a ' }, { text: 'x y', marks: ['bold', 'code'] }, { text: ' b' }], 'a **`x y`** b'],
    // Two runs' delimiters that touch are one delimiter run to CommonMark, and
    // between punctuation it can both open and close, so the rule of three
    // leaves it unmatched. The second run is written as HTML.
    [
      [
        { text: '(', marks: ['bold'] },
        { text: '(', marks: ['bold', 'code'] },
      ],
      '**(**<strong><code>(</code></strong>',
    ],
    [
      [
        { text: '<', marks: ['bold', 'italic'] },
        { text: '_', marks: ['italic'] },
      ],
      '***\\<***<em>\\_</em>',
    ],
    // Between letters it cannot, and the delimiters are kept.
    [
      [
        { text: 'a', marks: ['bold'] },
        { text: 'b', marks: ['bold', 'italic'] },
      ],
      '**a*****b***',
    ],
    // Except `***a***` then `*b*`, which micromark -- remark, and so most of
    // the ecosystem -- reads as `<em><strong>a</strong>**b</em>`.
    [
      [
        { text: 'a', marks: ['bold', 'italic'] },
        { text: 'b', marks: ['italic'] },
      ],
      '***a***<em>b</em>',
    ],
  ] as const)('%j is written %s', (content, markdown) => {
    const blocks = [b({ content: content as never })];
    expect(toMarkdown({ blocks })).toBe(markdown);
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  test('a "!" right before a link is escaped, so it is not an image', () => {
    const blocks = [b({ content: [{ text: 'x!' }, { text: 'l', link: 'https://a.test/' }] })];
    expect(toMarkdown({ blocks })).toBe('x\\![l](https://a.test/)');
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  test('a literal backslash before that "!" does not stop it being escaped', () => {
    const blocks = [b({ content: [{ text: 'x\\!' }, { text: 'l', link: 'https://a.test/' }] })];
    expect(toMarkdown({ blocks })).toBe('x\\\\\\![l](https://a.test/)');
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  test('"===" on a continuation line is escaped, so it is not a heading underline', () => {
    const blocks = [b({ content: t('a\n===') })];
    expect(toMarkdown({ blocks })).toBe('a\\\n\\===');
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  test('leading spaces after a line break are kept, for other readers too', () => {
    const blocks = [b({ content: t('a\n  b') })];
    expect(toMarkdown({ blocks })).toBe('a\\\n&#32;&#32;b');
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });
});

/**
 * Best of three, so one slow run on a loaded machine does not decide it.
 *
 * Timed as a ratio between two sizes rather than against a budget: a budget is
 * a statement about the machine, and the absolute version of this test failed
 * on an unmodified tree while passing on code that was still quadratic.
 */
const bestOf = (work: () => void): number => {
  let best = Infinity;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const began = performance.now();
    work();
    best = Math.min(best, performance.now() - began);
  }

  return best;
};

/**
 * How much longer sixteen times the input takes: about 16x for linear work,
 * about 256x for quadratic. The line is drawn wide between them, because
 * allocation makes honest linear work come out at 30x or so at these sizes, and
 * more when the whole suite is running beside it.
 */
const LINEAR = 90;
const growth = (work: (size: number) => void, size: number): number => {
  let least = Infinity;

  // A loaded machine only ever makes the ratio worse, so the lowest of a few
  // measurements is the honest one; quadratic work is over the line every time.
  for (let attempt = 0; attempt < 3 && least >= LINEAR; attempt += 1) {
    work(size);
    const small = bestOf(() => work(size));
    const large = bestOf(() => work(size * 16));
    least = Math.min(least, large / Math.max(small, 1));
  }

  return least;
};
describe('audit 4', () => {
  test('a long soft-broken paragraph parses in linear time', () => {
    expect(
      growth((size) => {
        blocksFromMarkdown(
          Array.from({ length: size }, (_, index) => `line ${index} text\\`).join('\n'),
        );
      }, 5000),
    ).toBeLessThan(LINEAR);
  });

  test('a long run of references in the middle of a line parses in linear time', () => {
    expect(
      growth((size) => {
        blocksFromMarkdown(`a ${'&#32;'.repeat(size)} b`);
      }, 2500),
    ).toBeLessThan(LINEAR);
  });

  test('a long run of backslashes before a link is written in linear time', () => {
    expect(
      growth((size) => {
        toMarkdown({
          blocks: [
            b({ content: [{ text: '\\'.repeat(size) }, { text: 'x', link: 'https://a.test/' }] }),
          ],
        });
      }, 4000),
    ).toBeLessThan(LINEAR);
  });

  test('a long formatted run of short lines is written in linear time', () => {
    expect(
      growth((size) => {
        toMarkdown({
          blocks: [
            b({
              content: [
                { text: Array.from({ length: size }, () => 'ab').join('\n'), marks: ['bold'] },
              ],
            }),
          ],
        });
      }, 10000),
    ).toBeLessThan(LINEAR);
  });

  // CommonMark decodes no reference inside a code span, and neither does this
  // reader, so inline code about HTML needs no escape and no HTML fallback.
  test.each(['&nbsp;', 'a &amp;&amp; b', '&#32;'])('code %j stays a backtick span', (text) => {
    const blocks = [
      b({ content: [{ text: 'use ' }, { text, marks: ['code'] }, { text: ' here' }] }),
    ];
    expect(toMarkdown({ blocks })).toBe(`use \`${text}\` here`);
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  // A heading writes one span per line, and each line's delimiters meet the
  // same neighbours a paragraph's would.
  test.each([
    [[{ text: 'a' }, { text: '(x)\ny', marks: ['bold'] }], '# a<strong>(x)</strong>\\\n**y**'],
    [[{ text: 'y\n(x)', marks: ['bold'] }, { text: 'a' }], '# **y**\\\n<strong>(x)</strong>a'],
    [
      [
        { text: '(', marks: ['bold'] },
        { text: '(\nx', marks: ['bold', 'code'] },
      ],
      '# **(**<strong><code>(</code></strong>\\\n**`x`**',
    ],
  ] as const)('heading %j is written %s', (content, markdown) => {
    expect(toMarkdown({ blocks: [b({ type: 'heading1', content: content as never })] })).toBe(
      markdown,
    );
  });

  // GFM: `~~` follows the same flanking rule, and against `**` it touches
  // punctuation. Between letters that also keeps two runs' tildes from meeting;
  // between punctuation they would, and `~~~~` is no delimiter at all.
  test.each([
    [
      [{ text: 'a' }, { text: 'x', marks: ['bold', 'strikethrough'] }, { text: 'b' }],
      'a<s><strong>x</strong></s>b',
    ],
    [
      [{ text: 'a ' }, { text: 'x', marks: ['bold', 'strikethrough'] }, { text: ' b' }],
      'a ~~**x**~~ b',
    ],
    [
      [
        { text: 'one', marks: ['strikethrough'] },
        { text: 'two', marks: ['strikethrough', 'italic'] },
      ],
      '~~one~~<s><em>two</em></s>',
    ],
    [
      [
        { text: '(', marks: ['strikethrough'] },
        { text: ')', marks: ['strikethrough', 'italic'] },
      ],
      '~~(~~<s><em>)</em></s>',
    ],
  ] as const)('%j is written %s', (content, markdown) => {
    const blocks = [b({ content: content as never })];
    expect(toMarkdown({ blocks })).toBe(markdown);
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  // CommonMark 4.2: a run of `#` after a space closes an ATX heading.
  test.each([
    ['a #', '# a \\#'],
    ['#', '# \\#'],
    ['a ##', '# a \\##'],
    ['a#', '# a#'],
  ])('heading %j is written %j', (text, markdown) => {
    const blocks = [b({ type: 'heading1', content: t(text) })];
    expect(toMarkdown({ blocks })).toBe(markdown);
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  // Inside a list item or a quote, every other reader starts a new block at a marker.
  test.each([
    ['bulleted_list', '1. x', '- 1\\. x'],
    ['bulleted_list', '---', '- \\---'],
    ['numbered_list', '- x', '1. \\- x'],
    ['quote', '# x', '> \\# x'],
    ['quote', '> x', '> \\> x'],
  ] as const)('%s %j is written %j', (type, text, markdown) => {
    const blocks = [b({ type, content: t(text) })];
    expect(toMarkdown({ blocks })).toBe(markdown);
    const back = throughMarkdown(blocks)[0];
    expect(back?.type).toBe(type);
    expect(back?.content).toEqual(start(blocks)[0]?.content);
  });
});

describe('audit 5', () => {
  const B = ['bold'] as const;
  const I = ['italic'] as const;
  const X = ['bold', 'italic'] as const;

  // Pairs of touching runs resolve between letters; chains do not. `*a*` +
  // `***b***` + `**c**` is a run of four then a run of five, both able to open
  // and close, and four plus five is a multiple of three: CommonMark's rules 9
  // and 10 leave `***b***` literal. Checked against commonmark.js and micromark.
  test.each([
    [[I, X, B], '*a*<em><strong>b</strong></em>**c**'],
    [[B, I, X, B], '**a***b*<em><strong>c</strong></em>**d**'],
    [[I, X, B, I], '*a*<em><strong>b</strong></em>**c***d*'],
    [[I, X, B, X], '*a*<em><strong>b</strong></em>**c*****d***'],
    // The chains that do resolve are left as delimiters.
    [[B, X, B], '**a*****b*****c**'],
    [[I, B, I], '*a***b***c*'],
  ] as const)('the chain %j is written %s', (chain, markdown) => {
    const blocks = [
      b({ content: chain.map((marks, index) => ({ text: 'abcd'[index]!, marks: [...marks] })) }),
    ];
    expect(toMarkdown({ blocks })).toBe(markdown);
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  // GFM links a bare URL and takes a backslash as part of it: `x\_y` linked to
  // `x%5C_y` and showed the backslash. A `_` between two letters or digits is
  // no delimiter in CommonMark, so inside a URL it is written bare -- and the
  // reader, like GFM, takes no `_` inside a bare URL for a delimiter.
  test.each([
    ['see https://a.test/x_y now', 'see https://a.test/x_y now'],
    ['www.a.test/a_b_c', 'www.a.test/a_b_c'],
    ['HTTPS://A.TEST/x_y and Www.a.test/x_y', 'HTTPS://A.TEST/x_y and Www.a.test/x_y'],
    ['snake_case and https://a.test/x_y', 'snake\\_case and https://a.test/x_y'],
    // Not between letters: still escaped, so CommonMark does not read emphasis.
    ['https://a.test/_x_/', 'https://a.test/\\_x\\_/'],
  ])('%j is written %j', (text, markdown) => {
    const blocks = [b({ content: t(text) })];
    expect(toMarkdown({ blocks })).toBe(markdown);
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  // A closing tag alone on the last line of a list item or a quote is an HTML
  // block to micromark, which ends the item there. The break is written as a
  // reference inside the tag, as one at the very edge of a block already is.
  test.each(['bulleted_list', 'quote', 'paragraph'] as const)(
    'a formatted run ending in a line break at the end of a %s keeps its tag on the line',
    (type) => {
      const blocks = [b({ type, content: [{ text: 'abc\n', marks: ['bold'] }] })];
      expect(toMarkdown({ blocks })).toMatch(/<strong>abc&#10;<\/strong>$/);
      expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
    },
  );

  // Only the break needs moving: a space before it is safe inside the tag, and
  // written as `&#32;` against a URL it is taken into the link by GFM.
  test('spaces before that break stay as they are', () => {
    const blocks = [b({ content: [{ text: 'see https://a.test/ \n', marks: ['bold'] }] })];
    expect(toMarkdown({ blocks })).toBe('<strong>see https://a.test/ &#10;</strong>');
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  test.each([
    ['spaces', ' '],
    ['line breaks', '\n'],
  ])('a long run of %s inside a paragraph is written in linear time', (_name, unit) => {
    expect(
      growth((size) => {
        toMarkdown({ blocks: [b({ content: t(`a${unit.repeat(size)}b`) })] });
      }, 2500),
    ).toBeLessThan(LINEAR);
  });
});

describe('audit 10', () => {
  // The punctuation clause of the touching rule on its own: the two cases in
  // audit 3's table are also caught by the rule of three added later, and
  // passed with this clause removed. This one has junctions of four and four.
  test('touching delimiters between punctuation, where the rule of three says nothing', () => {
    const blocks = [
      b({
        content: [
          { text: 'a"_)', marks: ['bold'] },
          { text: '!', marks: ['bold', 'code'] },
          { text: '*a*(', marks: ['bold'] },
        ],
      }),
    ];
    expect(toMarkdown({ blocks })).toBe('**a"\\_)**<strong><code>!</code></strong>**\\*a\\*(**');
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  // The href was read off the projection the rules match against, where an
  // escaped character is a placeholder: it came back as a NUL in the URL.
  test.each([
    ['[x](https://a.test/a\\_b)', 'https://a.test/a_b'],
    [
      '[wiki](https://en.wikipedia.org/wiki/Foo_\\(bar\\))',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ],
    ['[x](https://a.test/?a=1\\&b=2)', 'https://a.test/?a=1&b=2'],
    ['[x](<https://a.test/a\\_b>)', 'https://a.test/a_b'],
  ])('%s links to %s', (markdown, href) => {
    expect(blocksFromMarkdown(markdown)[0]?.content).toEqual([
      { text: markdown.slice(1, markdown.indexOf(']')), link: href },
    ]);
  });

  test('an image destination is unescaped the same way', () => {
    expect(blocksFromMarkdown('![alt](https://a.test/a\\_b.png)')[0]?.src).toBe(
      'https://a.test/a_b.png',
    );
  });

  // Backslashes, in both forms of a destination; a pipe, which would end a
  // table cell; and an entity, which other readers decode even there.
  test.each([
    ['https://a.test/?q=a\\_b', '[x](https://a.test/?q=a\\\\_b)'],
    ['https://a.test/?q=a\\', '[x](https://a.test/?q=a\\\\)'],
    ['https://a.test/?q=(a\\)', '[x](<https://a.test/?q=(a\\\\)>)'],
    ['https://a.test/?q=a|b', '[x](https://a.test/?q=a\\|b)'],
    ['https://a.test/?q=a&amp;b', '[x](https://a.test/?q=a\\&amp;b)'],
  ])('a link to %s is written %s', (href, markdown) => {
    const blocks = [b({ content: [{ text: 'x', link: href }] })];
    expect(toMarkdown({ blocks })).toBe(markdown);
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  test.each(['https://a.test/?q=a|b', 'https://a.test/?q=a\\|b'])(
    'a link to %s in a table cell stays in its cell',
    (href) => {
      const blocks = [
        b({
          type: 'table',
          rows: [
            [[{ text: 'x', link: href }], [{ text: 'z' }]],
            [[{ text: '1' }], [{ text: '2' }]],
          ] as never,
        }),
      ];
      expect(throughMarkdown(blocks)[0]?.rows).toEqual(start(blocks)[0]?.rows);
    },
  );

  // More runs inside the destination than the reader keeps to hand: the href
  // was read before they were recalled, from whatever tail was left.
  test('a destination holding many code spans and an escape keeps its link', () => {
    const markdown = `[click](https://good.test/?${'`a`b'.repeat(20)}\`a\`//evil.test/${'`a`b'.repeat(15)}\\_c)`;
    const content = blocksFromMarkdown(markdown)[0]?.content ?? [];
    expect(new Set(content.map((run) => run.link))).toEqual(
      new Set([`https://good.test/?${'ab'.repeat(20)}a//evil.test/${'ab'.repeat(15)}_c`]),
    );
  });

  test('a destination that unescapes to nothing usable is not a link', () => {
    // `/\x` is `//x` to a browser: a protocol-relative URL, which is refused.
    // The projection shows `/` + placeholder + `x`, which passes on its own.
    expect(blocksFromMarkdown('[x](/\\\\x)')[0]?.content).toEqual(t('[x](/\\x)'));
  });

  // Line-wrapped base64 is accepted as a source; percent-encoding the breaks
  // wrote one the reader then refused, and the image came back as a paragraph.
  test('an image whose data: source holds whitespace survives', () => {
    const blocks = [
      b({ type: 'image', src: 'data:image/png;base64,iVBORw0KGgo\nAAAA', alt: 'cat' }),
    ];
    const back = throughMarkdown(blocks)[0];
    expect(back?.type).toBe('image');
    expect(back?.src).toBe('data:image/png;base64,iVBORw0KGgoAAAA');
  });

  test('an image whose source holds a backslash round-trips', () => {
    const blocks = [b({ type: 'image', src: 'https://a.test/?q=a\\_b', alt: 'a' })];
    expect(throughMarkdown(blocks)[0]?.src).toBe('https://a.test/?q=a\\_b');
  });
});

describe('audit 12', () => {
  // Every escape the writer puts in a destination has to leave it a link to
  // the rule that decides there is one, which looks at the projection.
  test.each([
    // `\&` in the host: the placeholder made the URL unparseable.
    ['https://a&amp;b.test/x', '[x](https://a\\&amp;b.test/x)'],
    // A backtick in a query is not percent-encoded by the URL parser, and two
    // of them closed a code span inside the destination.
    ['https://a.test/?q=`y`', '[x](https://a.test/?q=\\`y\\`)'],
    // The angle form with a `)` in it: the plain rule fired at that paren with
    // `<mailto:…` for a destination, which was "fixed up" into an https URL.
    [
      'mailto:team@example.com?subject=Feedback%20(v2)',
      '[x](<mailto:team@example.com?subject=Feedback%20(v2)>)',
    ],
  ])('a link to %s is written %s', (href, markdown) => {
    const blocks = [b({ content: [{ text: 'x', link: href }] })];
    expect(toMarkdown({ blocks })).toBe(markdown);
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  test('a destination that opens with "<" and does not close is not a link', () => {
    expect(blocksFromMarkdown('[x](<mailto:a@b.test?s=(v2)')[0]?.content).toEqual(
      t('[x](<mailto:a@b.test?s=(v2)'),
    );
  });

  // An escaped character is a placeholder to the rules, and it stands for
  // punctuation: `www.` after one is a URL, as it is after the character itself.
  test.each(['\\[1\\]www.a.test/_y_', '\\(www.a.test/_y_'])(
    '%s keeps its underscores',
    (markdown) => {
      expect(blocksFromMarkdown(markdown)[0]?.content).toEqual(t(markdown.replaceAll('\\', '')));
    },
  );
});

describe('audit 13', () => {
  // A closed angle form whose URL is refused is not a link, and neither is
  // anything inside it: the plain rule used to retry from a `[` in the URL.
  test.each(['[y](<.[x](/q>)', '[y](<javascript:void[x](//evil.test/>)'])(
    '%s is not a link',
    (markdown) => {
      expect(blocksFromMarkdown(markdown)[0]?.content).toEqual(t(markdown));
    },
  );

  // An unclosed one is just text, and a link after it is a link, as in CommonMark.
  test('a link after an unclosed angle form is still a link', () => {
    expect(blocksFromMarkdown('[y](<a[x](/q)')[0]?.content).toEqual([
      { text: '[y](<a' },
      { text: 'x', link: '/q' },
    ]);
  });

  test('an image destination that opens with "<" and does not close is not an image', () => {
    const block = blocksFromMarkdown('![a](<u:p@b.test/x.png)')[0];
    expect(block?.type).toBe('paragraph');
  });

  test('an image with no destination yet is still an image', () => {
    expect(blocksFromMarkdown('![a]()')[0]?.type).toBe('image');
  });
});

describe('audit 14', () => {
  // A `](` inside a destination is a link's hinge to the rules: a link-shaped
  // `[foo](b.ar)` in a query was made into a link of its own and its brackets
  // taken out of the URL, and a closed `](b)` made the rest of the destination
  // look like prose, so `*x*` after it was emphasised. The writer escapes the
  // bracket, and no `](` is left for a rule to find.
  test.each([
    ['https://a.test/?q=[foo](b.ar)', '[see](<https://a.test/?q=[foo\\](b.ar)>)'],
    ['mailto:a@b.test?subject=[x](/y)', '[see](<mailto:a@b.test?subject=[x\\](/y)>)'],
    ['https://a.test/?q=](b)*x*', '[see](<https://a.test/?q=\\](b)*x*>)'],
    ['mailto:a@b.test?subject=](b)_x_', '[see](<mailto:a@b.test?subject=\\](b)_x_>)'],
  ])('a link to %s is written %s', (href, markdown) => {
    const blocks = [b({ content: [{ text: 'see', link: href }] })];
    expect(toMarkdown({ blocks })).toBe(markdown);
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  test('and in a table cell', () => {
    const blocks = [
      b({
        type: 'table',
        rows: [
          [[{ text: 'see', link: 'https://a.test/?q=[foo](b.ar)|](b)*x*' }], [{ text: 'z' }]],
          [[{ text: '1' }], [{ text: '2' }]],
        ] as never,
      }),
    ];
    expect(throughMarkdown(blocks)[0]?.rows).toEqual(start(blocks)[0]?.rows);
  });
});

describe('audit 15', () => {
  // A label is inline content to other readers: a backtick in the alt text
  // paired with one in the caption and the image was gone, and `<!a` with a
  // `>` later on the line was an HTML declaration.
  test.each([
    ['the ` key', '![the \\` key](https://a.test/x.png)\\\npress `Esc`'],
    ['x <!a', '![x \\<!a](https://a.test/x.png)\\\npress `Esc`'],
  ])('an image with alt %j is written %j', (alt, markdown) => {
    const blocks = [
      b({
        type: 'image',
        src: 'https://a.test/x.png',
        alt,
        content: [{ text: 'press ' }, { text: 'Esc', marks: ['code'] }],
      }),
    ];
    expect(toMarkdown({ blocks })).toBe(markdown);
    const back = throughMarkdown(blocks)[0];
    expect(back?.alt).toBe(alt);
    expect(back?.content).toEqual(start(blocks)[0]?.content);
  });

  test('a callout icon holding a backtick is escaped too', () => {
    const blocks = [
      b({
        type: 'callout',
        icon: '`',
        content: [{ text: 'run ' }, { text: 'x', marks: ['code'] }],
      }),
    ];
    expect(toMarkdown({ blocks })).toBe('> [!\\`] run `x`');
    expect(throughMarkdown(blocks)[0]?.icon).toBe('`');
  });

  // Foreign Markdown: a plain destination may hold `<` after its first
  // character, and nothing but the link closes inside it.
  test.each([
    ['[a](/p?a<b&q=*x*)', '/p?a<b&q=*x*'],
    ['[a](/p?a<b&q=_x_)', '/p?a<b&q=_x_'],
    ['[a](https://a.test/?q=<em>y</em>&r=1)', 'https://a.test/?q=%3Cem%3Ey%3C/em%3E&r=1'],
  ])('%s links to %s', (markdown, href) => {
    expect(blocksFromMarkdown(markdown)[0]?.content).toEqual([{ text: 'a', link: href }]);
  });

  // An unclosed angle form holds no whitespace, so prose after one is prose.
  test('emphasis after an unclosed angle destination still closes', () => {
    expect(blocksFromMarkdown('see [a](<b c *x*')[0]?.content).toEqual([
      { text: 'see [a](<b c ' },
      { text: 'x', marks: ['italic'] },
    ]);
  });
});

describe('audit 16', () => {
  // An alt attribute pasted from HTML can be wrapped. Written raw, the break
  // split the image line in two and the image came back as two paragraphs.
  test.each(['A chart of revenue\nby quarter', 'a\r\n  b', 'a\rb'])(
    'an alt text holding %j keeps its image',
    (alt) => {
      const blocks = [b({ type: 'image', src: 'https://a.test/x.png', alt })];
      const back = throughMarkdown(blocks);
      expect(back).toHaveLength(1);
      expect(back[0]?.type).toBe('image');
      expect(back[0]?.alt).toBe(alt.replace(/\s*[\r\n]+\s*/g, ' '));
    },
  );

  test('a callout icon holding a line break keeps its callout', () => {
    const blocks = [b({ type: 'callout', icon: 'a\nb', content: t('text') })];
    const back = throughMarkdown(blocks);
    expect(back).toHaveLength(1);
    expect(back[0]?.type).toBe('callout');
    expect(back[0]?.icon).toBe('a b');
  });

  // The other edge of `inOpenDestination`'s plain form: a closed angle form
  // that was refused is over, and emphasis after it is emphasis.
  test('emphasis straight after a closed angle form that is not a link still closes', () => {
    expect(blocksFromMarkdown('[a](<b>*x*')[0]?.content).toEqual([
      { text: '[a](<b>' },
      { text: 'x', marks: ['italic'] },
    ]);
  });
});

describe('audit 17', () => {
  // The pattern that collapsed a break in a label led with `\s*`, which was
  // retried from every character of a whitespace run holding no break at all.
  test('a long run of spaces in an alt text is written in linear time', () => {
    expect(
      growth((size) => {
        toMarkdown({
          blocks: [b({ type: 'image', src: 'https://a.test/x.png', alt: `a${' '.repeat(size)}b` })],
        });
      }, 2500),
    ).toBeLessThan(LINEAR);
  });

  test.each([
    ['a \n\t b', 'a b'],
    ['\na', ' a'],
    ['a\n', 'a '],
    ['a\n\n \n b', 'a b'],
    ['a  b', 'a  b'],
    // Only the whitespace around a break goes: a label's own edges are kept.
    [' a\nb', ' a b'],
    ['a\nb ', 'a b '],
  ])('a label %j is written with %j', (alt, written) => {
    expect(toMarkdown({ blocks: [b({ type: 'image', src: '/x.png', alt })] })).toBe(
      `![${written}](/x.png)`,
    );
  });

  // A carriage return is a line break to every reader, this one included, so
  // written raw it split the block -- and took a table apart.
  test.each(['a\rb', 'a\r\nb'])('a paragraph holding %j stays one block', (text) => {
    const back = throughMarkdown([b({ content: t(text) })]);
    expect(back).toHaveLength(1);
    expect(back[0]?.content).toEqual(t('a\nb'));
  });

  test('a table cell holding a carriage return keeps its table', () => {
    const blocks = [
      b({
        type: 'table',
        rows: [
          [[{ text: 'a\rb' }], [{ text: 'c' }]],
          [[{ text: 'd\r\ne' }], [{ text: 'f' }]],
        ] as never,
      }),
    ];
    const back = throughMarkdown(blocks);
    expect(back).toHaveLength(1);
    expect(back[0]?.rows).toEqual([
      [[{ text: 'a\nb' }], [{ text: 'c' }]],
      [[{ text: 'd\ne' }], [{ text: 'f' }]],
    ]);
  });

  test('an image caption holding a carriage return stays with its image', () => {
    const back = throughMarkdown([
      b({ type: 'image', src: '/x.png', alt: 'x', content: t('a\rb') }),
    ]);
    expect(back).toHaveLength(1);
    expect(back[0]?.content).toEqual(t('a\nb'));
  });

  test('a carriage return in a later run is rewritten too', () => {
    const back = throughMarkdown([
      b({ content: [{ text: 'x' }, { text: 'a\rb', marks: ['bold'] }] }),
    ]);
    expect(back).toHaveLength(1);
    expect(back[0]?.content).toEqual([{ text: 'x' }, { text: 'a\nb', marks: ['bold'] }]);
  });

  // In a code block too, and not only in the middle: a trailing one joined the
  // newline before the closing fence into one CRLF, and the last break was gone.
  test.each([
    ['a\r', 'a\n'],
    ['a\r\nb', 'a\nb'],
    ['\ra\r', '\na\n'],
  ])('a code block holding %j comes back as %j', (text, expected) => {
    const back = throughMarkdown([b({ type: 'code', content: t(text) })]);
    expect(back).toHaveLength(1);
    expect(back[0]?.content).toEqual(t(expected));
  });
});
