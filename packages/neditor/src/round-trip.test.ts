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

  // An ATX heading is one line in every other reader, so a break inside one
  // is `<br>`: the span stays whole, and the break keeps its mark.
  test('a heading writes a break inside a formatted run as <br>', () => {
    const blocks = [b({ type: 'heading1', content: t('Title\nsub', { marks: ['bold'] }) })];
    expect(toMarkdown({ blocks })).toBe('# **Title<br>sub**');
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
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

  // A heading's break is `<br>`, inside the span, and the span's delimiters
  // meet the same neighbours a paragraph's would. Each comes back exactly.
  test.each([
    [[{ text: 'a' }, { text: '(x)\ny', marks: ['bold'] }], '# a<strong>(x)<br>y</strong>'],
    [[{ text: 'y\n(x)', marks: ['bold'] }, { text: 'a' }], '# <strong>y<br>(x)</strong>a'],
    [
      [
        { text: '(', marks: ['bold'] },
        { text: '(\nx', marks: ['bold', 'code'] },
      ],
      '# **(**<strong><code>(<br>x</code></strong>',
    ],
  ] as const)('heading %j is written %s', (content, markdown) => {
    const blocks = [b({ type: 'heading1', content: content as never })];
    expect(toMarkdown({ blocks })).toBe(markdown);
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
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
  // `x%5C_y` and showed the backslash. An http(s) URL is written as an autolink,
  // where nothing is escaped; a `www.` one has no autolink spelling, so a `_`
  // between two letters or digits in it is written bare, which is no delimiter
  // in CommonMark -- and the reader takes no `_` inside a bare URL for one.
  test.each([
    ['see https://a.test/x_y now', 'see <https://a.test/x_y> now'],
    ['www.a.test/a_b_c', 'www.a.test/a_b_c'],
    ['HTTPS://A.TEST/x_y and Www.a.test/x_y', '<HTTPS://A.TEST/x_y> and Www.a.test/x_y'],
    ['snake_case and https://a.test/x_y', 'snake\\_case and <https://a.test/x_y>'],
    // Not between letters either: inside an autolink nothing is a delimiter.
    ['https://a.test/_x_/', '<https://a.test/_x_/>'],
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
    expect(toMarkdown({ blocks })).toBe('<strong>see <https://a.test/> &#10;</strong>');
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
    // A part between two breaks loses the whitespace on both its sides.
    ['a\n x \nb', 'a x b'],
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

describe('audit 19', () => {
  // A carriage return in a heading is a break like any other: `<br>`.
  test('a carriage return in a heading is written as a break', () => {
    const blocks = [b({ type: 'heading1', content: [{ text: 'a\rb', marks: ['bold'] }] })];
    expect(toMarkdown({ blocks })).toBe('# **a<br>b**');
  });

  // The two bounds of an open destination, which is what keeps an unclosed
  // `](` from switching emphasis off for the rest of the line: whitespace ends
  // the plain form, and a `<` ends the angle form.
  test.each([
    ['[a](b and *x*', [{ text: '[a](b and ' }, { text: 'x', marks: ['italic'] }]],
    ['[a](<b<c*x*', [{ text: '[a](<b<c' }, { text: 'x', marks: ['italic'] }]],
  ])('%s still emphasises', (markdown, content) => {
    expect(blocksFromMarkdown(markdown)[0]?.content).toEqual(content);
  });
});

describe('audit 20', () => {
  // A caption of `=` under an image line is a setext underline to other
  // readers: the image became a heading and the caption was gone.
  test.each(['===', '='])('an image caption %j is escaped', (caption) => {
    const blocks = [b({ type: 'image', src: '/x.png', alt: 'cat', content: t(caption) })];
    expect(toMarkdown({ blocks })).toBe(`![cat](/x.png)\\\n\\${caption}`);
    expect(throughMarkdown(blocks)[0]?.content).toEqual(t(caption));
  });

  // Boundaries a mutation pass found nothing held in place. Each row is the
  // exact Markdown, and the block must come back as it went in.
  test.each([
    // References: hex in either case, and a named one with a digit in it.
    ['paragraph', '&#x41;', '\\&#x41;'],
    ['paragraph', '&#X41;', '\\&#X41;'],
    ['paragraph', 'a &frac12; b', 'a \\&frac12; b'],
    // An ordinal closed by a paren is a list marker too.
    ['paragraph', '1) x', '1\\) x'],
    ['paragraph', 'a\n1. x', 'a\\\n1\\. x'],
    // A `_` is left bare only between ASCII letters or digits, in a URL.
    ['paragraph', 'https://a.test/x_1', '<https://a.test/x_1>'],
    ['paragraph', 'http://a.test/x_y', '<http://a.test/x_y>'],
    ['paragraph', 'awww.a/a__b__c', 'awww.a/a\\_\\_b\\_\\_c'],
    ['paragraph', 'awww.é_b_é', 'awww.é\\_b\\_é'],
    // A closing sequence follows a tab as well as a space, at every level.
    ['heading1', 'a\t#', '# a\t\\#'],
    ['heading2', 'a #', '## a \\#'],
    ['heading3', 'a #', '### a \\#'],
    // Every trailing whitespace character is a reference, whatever its length.
    ['paragraph', 'a  ', 'a&#32;&#32;'],
    ['paragraph', 'a\u00a0', 'a&#160;'],
    ['paragraph', 'a\u3000', 'a&#12288;'],
  ] as const)('%s %j is written %j', (type, text, markdown) => {
    const blocks = [b({ type, content: t(text) })];
    expect(toMarkdown({ blocks })).toBe(markdown);
    const back = throughMarkdown(blocks)[0];
    expect(back?.type).toBe(type);
    expect(back?.content).toEqual(t(text));
  });

  test('a code run with edge whitespace still has its reference escaped', () => {
    const blocks = [b({ content: [{ text: ' &#x41;', marks: ['code'] }] })];
    expect(toMarkdown({ blocks })).toBe('<code> \\&#x41;</code>');
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  test.each([
    ['\\_', '\\\\_'],
    ['a[b', 'a\\[b'],
  ])('a label %j is written %j', (label, written) => {
    const image = [b({ type: 'image', src: '/x.png', alt: label })];
    expect(toMarkdown({ blocks: image })).toBe(`![${written}](/x.png)`);
    expect(throughMarkdown(image)[0]?.alt).toBe(label);

    const callout = [b({ type: 'callout', icon: label, content: t('x') })];
    expect(toMarkdown({ blocks: callout })).toBe(`> [!${written}] x`);
    expect(throughMarkdown(callout)[0]?.icon).toBe(label);
  });

  test.each([
    ['/a<b', '[x](</a%3Cb>)'],
    ['/a>b', '[x](</a%3Eb>)'],
  ])('a link to %s is written %s and is still a link', (href, markdown) => {
    const blocks = [b({ content: [{ text: 'x', link: href }] })];
    expect(toMarkdown({ blocks })).toBe(markdown);
    expect(throughMarkdown(blocks)[0]?.content).toEqual([
      { text: 'x', link: markdown.slice(5, -2) },
    ]);
  });

  // The length bound, at its edges. The reader reaches back 2000 characters,
  // so a span written as exactly that is left whole and one character more is
  // split -- on the first pass and on every later one.
  test.each([
    ['a span written as exactly the limit', 'a'.repeat(1996)],
    ['one character over, with a space to split at', `${'ab '.repeat(665)}ab`],
    ['a remainder that is itself over the limit', `${'ab '.repeat(1166)}a`],
    ['a remainder written as exactly one over', `${'ab '.repeat(1166)}${'ab '.repeat(165)}ab`],
  ])('%s round-trips', (_name, text) => {
    const blocks = [b({ content: [{ text: 'p ' }, { text, marks: ['bold'] }] })];
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  test('a tail that cannot be split is still written with its mark', () => {
    const blocks = [
      b({ content: [{ text: 'p ' }, { text: `aaa ${'x'.repeat(2500)}`, marks: ['bold'] }] }),
    ];
    const markdown = toMarkdown({ blocks });
    expect(markdown.startsWith('p **aaa**<strong> xxx')).toBe(true);
    expect(markdown.endsWith('xxx</strong>')).toBe(true);
  });

  // The reader, on typed or foreign text.
  test.each([
    // Any whitespace ends a URL's token, not only a space.
    ['https://a.test/\t_y_', [{ text: 'https://a.test/\t' }, { text: 'y', marks: ['italic'] }]],
    // The open destination is the last `](`, not the first.
    ['[a](b)[c](/p*x*q*)', [{ text: '[a](b)' }, { text: 'c', link: '/p*x*q*' }]],
    // An angle destination holds no `<`.
    ['[a](<https://a.test/x<y>)', [{ text: '[a](<https://a.test/x<y>)' }]],
    // A reference is decoded up to U+10FFFF, and never to a NUL or half a pair.
    ['a&#1114111;', [{ text: `a${String.fromCodePoint(0x10ffff)}` }]],
    ['&#0;', [{ text: '&#0;' }]],
    ['&#55357;', [{ text: '&#55357;' }]],
    // A decoded character is text: two placeholders for an astral one, so
    // offsets stay aligned, and never a delimiter.
    ['&#128512;*a*', [{ text: '\u{1F600}' }, { text: 'a', marks: ['italic'] }]],
    ['&#42;a*', [{ text: '*a*' }]],
  ])('%j is read as %j', (markdown, content) => {
    expect(blocksFromMarkdown(markdown)[0]?.content).toEqual(content);
  });

  test('an even number of trailing backslashes is not a soft break', () => {
    expect(blocksFromMarkdown('C:\\\\dir\\\\\nnext').map((block) => block.content)).toEqual([
      t('C:\\dir\\'),
      t('next'),
    ]);
  });
});

describe('audit 21', () => {
  // A GFM delimiter row needs no pipe: `:---` under a line makes that line a
  // one-column table header. The `-`-led spellings were already escaped.
  test.each([':---', ':-', ':-:'])('an image caption %j is not a table delimiter', (caption) => {
    const blocks = [b({ type: 'image', src: '/x.png', alt: 'cat', content: t(caption) })];
    expect(toMarkdown({ blocks })).toBe(`![cat](/x.png)\\\n:\\${caption.slice(1)}`);
    expect(throughMarkdown(blocks)[0]?.content).toEqual(t(caption));
  });

  test.each([':---', ':-', ':-:'])('nor is %j on the line after a soft break', (line) => {
    const blocks = [b({ content: t(`a\n${line}`) })];
    expect(toMarkdown({ blocks })).toBe(`a\\\n:\\${line.slice(1)}`);
    expect(throughMarkdown(blocks)[0]?.content).toEqual(t(`a\n${line}`));
  });

  test('on every such line, not only the first', () => {
    const blocks = [b({ content: t('a\n:-\n:---') })];
    expect(toMarkdown({ blocks })).toBe('a\\\n:\\-\\\n:\\---');
    expect(throughMarkdown(blocks)[0]?.content).toEqual(t('a\n:-\n:---'));
  });

  test('a caption whose colon is not followed by a hyphen is left alone', () => {
    const blocks = [b({ type: 'image', src: '/x.png', alt: 'cat', content: t(':b') })];
    expect(toMarkdown({ blocks })).toBe('![cat](/x.png)\\\n:b');
    expect(throughMarkdown(blocks)[0]?.content).toEqual(t(':b'));
  });

  test('a colon that is not followed by a hyphen is left alone', () => {
    expect(toMarkdown({ blocks: [b({ content: t('a\n:b') })] })).toBe('a\\\n:b');
  });

  // Only a triangle that opens a bullet's text can be taken for a toggle's
  // marker, and the reader only unescapes one there.
  test('a triangle inside a bullet is not escaped', () => {
    const blocks = [b({ type: 'bulleted_list', content: t('press \u25BE now') })];
    expect(toMarkdown({ blocks })).toBe('- press \u25BE now');
    expect(throughMarkdown(blocks)[0]?.content).toEqual(t('press \u25BE now'));
  });
});

describe('open items', () => {
  const shape = (blocks: Block[]) =>
    blocks.map(({ type, depth, content }) => ({ type, depth, content }));

  // A code block under a list item: its body has to be indented as far as
  // its fence, or every other reader ends the item at the first body line.
  test.each([
    [1, 'a\nb', '- p\n\n  ```\n  a\n  b\n  ```'],
    [1, '  x\ny', '- p\n\n  ```\n    x\n  y\n  ```'],
    [1, 'a\n\nb', '- p\n\n  ```\n  a\n\n  b\n  ```'],
  ] as const)('a code block at depth %i holding %j is written %j', (depth, code, markdown) => {
    const blocks = [
      b({ type: 'bulleted_list', content: t('p') }),
      b({ type: 'code', depth, content: t(code) }),
    ];
    expect(toMarkdown({ blocks })).toBe(markdown);
    expect(shape(throughMarkdown(blocks))).toEqual(shape(start(blocks)));
  });

  test('two levels down, under nested bullets', () => {
    const blocks = [
      b({ type: 'bulleted_list', content: t('p') }),
      b({ type: 'bulleted_list', depth: 1, content: t('q') }),
      b({ type: 'code', depth: 2, content: t('a\n  b') }),
    ];
    expect(toMarkdown({ blocks })).toBe('- p\n\n  - q\n\n    ```\n    a\n      b\n    ```');
    expect(shape(throughMarkdown(blocks))).toEqual(shape(start(blocks)));
  });

  // What older versions wrote -- the body at the margin -- still reads back.
  test('a nested code block with an unindented body still reads', () => {
    const back = blocksFromMarkdown('- p\n\n  ```\na\n  b\n  ```');
    expect(back[1]?.type).toBe('code');
    expect(back[1]?.content).toEqual(t('a\n  b'));
    expect(back[1]?.depth).toBe(1);
  });

  // GFM table rows are single lines: a break written as `\` + newline inside a
  // cell split the row. `<br>` is how GFM tables spell one.
  test.each([
    ['a\nb', '| a<br>b | c |'],
    ['a\\\nb', '| a\\\\<br>b | c |'],
    ['x <br> y', '| x \\<br\\> y | c |'],
  ])('a cell holding %j is written in its row as %j', (text, row) => {
    const blocks = [
      b({
        type: 'table',
        rows: [
          [[{ text }], [{ text: 'c' }]],
          [[{ text: '1' }], [{ text: '2' }]],
        ] as never,
      }),
    ];
    expect(toMarkdown({ blocks }).split('\n')[0]).toBe(row);
    expect(throughMarkdown(blocks)[0]?.rows).toEqual(start(blocks)[0]?.rows);
  });

  test('a marked run across a break in a cell keeps its mark', () => {
    const blocks = [
      b({
        type: 'table',
        rows: [
          [
            [{ text: 'a\nb', marks: ['bold'] }],
            [{ text: 'k', marks: ['code'] }, { text: '\n' }, { text: 'm', marks: ['code'] }],
          ],
          [[{ text: 'x\ny', marks: ['code'] }], [{ text: '2' }]],
        ] as never,
      }),
    ];
    expect(throughMarkdown(blocks)[0]?.rows).toEqual(start(blocks)[0]?.rows);
  });

  test('a <br> in a foreign table cell is a line break', () => {
    expect(blocksFromMarkdown('| a<br>b | c<br/>d |\n| --- | --- |')[0]?.rows?.[0]).toEqual([
      t('a\nb'),
      t('c\nd'),
    ]);
  });

  // An escaped one is text: only a `<` behind an even run of backslashes counts.
  test('an escaped <br> in a cell is text', () => {
    expect(blocksFromMarkdown('| a\\<br>b | c\\\\<br>d |\n| --- | --- |')[0]?.rows?.[0]).toEqual([
      t('a<br>b'),
      t('c\\\nd'),
    ]);
  });

  // A quote opening with a link whose text starts with `!` was read back as a
  // callout with an icon cut out of the link.
  test('a quote opening with a link that starts with "!" stays a quote', () => {
    const blocks = [b({ type: 'quote', content: [{ text: '!a] b', link: '/u' }, { text: ' c' }] })];
    expect(toMarkdown({ blocks })).toBe('> [\\!a\\] b](/u) c');
    const back = throughMarkdown(blocks)[0];
    expect(back?.type).toBe('quote');
    expect(back?.content).toEqual(start(blocks)[0]?.content);
  });

  test('a cell full of backslashes is read in linear time', () => {
    expect(
      growth((size) => {
        blocksFromMarkdown(`| ${'\\'.repeat(size)}a | b |\n| --- | --- |`);
      }, 4000),
    ).toBeLessThan(LINEAR);
  });

  // A numbered item's content starts after `1. `, so its children are
  // indented that far: at two spaces every other reader ended the list there.
  test('a block nested under a numbered item is indented to its content', () => {
    const blocks = [
      b({ type: 'numbered_list', content: t('p') }),
      b({ type: 'paragraph', depth: 1, content: t('q') }),
      b({ type: 'code', depth: 1, content: t('a\nb') }),
      b({ type: 'bulleted_list', depth: 1, content: t('r') }),
      b({ type: 'paragraph', depth: 2, content: t('s') }),
    ];
    expect(toMarkdown({ blocks })).toBe(
      '1. p\n\n   q\n\n   ```\n   a\n   b\n   ```\n\n   - r\n\n     s',
    );
    expect(shape(throughMarkdown(blocks))).toEqual(shape(start(blocks)));
  });

  test('and under a two-digit number, four spaces', () => {
    const blocks = [
      ...Array.from({ length: 10 }, (_, index) =>
        b({ type: 'numbered_list', content: t(`n${index}`) }),
      ),
      b({ type: 'paragraph', depth: 1, content: t('child') }),
    ];
    expect(toMarkdown({ blocks }).endsWith('10. n9\n\n    child')).toBe(true);
    expect(shape(throughMarkdown(blocks))).toEqual(shape(start(blocks)));
  });

  // What older versions wrote -- two spaces a level, whatever the parent --
  // still reads at the same depths.
  test.each([
    ['1. p\n\n  q', [0, 1]],
    ['- a\n\n  - b\n\n    c', [0, 1, 2]],
    ['- a\n\n - b', [0, 0]],
    ['- a\n\n   - b\n\n  c', [0, 1, 1]],
  ])('%j reads at depths %j', (markdown, depths) => {
    expect(blocksFromMarkdown(markdown).map((block) => block.depth)).toEqual(depths);
  });

  // CommonMark admits balanced parentheses in a plain destination, which is
  // how Wikipedia's URLs are pasted: the link used to end at the first `)`.
  test.each([
    [
      '[wiki](https://en.wikipedia.org/wiki/Foo_(bar))',
      [{ text: 'wiki', link: 'https://en.wikipedia.org/wiki/Foo_(bar)' }],
    ],
    ['[a](https://a.test/x_(b_(c)))', [{ text: 'a', link: 'https://a.test/x_(b_(c))' }]],
    // Unbalanced, it is no destination at all, as in CommonMark.
    ['[a](https://a.test/(b)', [{ text: '[a](https://a.test/(b)' }]],
    // Parentheses around a link are prose.
    ['(see [a](/b))', [{ text: '(see ' }, { text: 'a', link: '/b' }, { text: ')' }]],
    ['[a](/b)(c)', [{ text: 'a', link: '/b' }, { text: '(c)' }]],
    [
      '[a](/b)[c](/d)',
      [
        { text: 'a', link: '/b' },
        { text: 'c', link: '/d' },
      ],
    ],
    // And nothing closes inside the destination while a paren is open.
    ['[a](/p_(x_y)_z)', [{ text: 'a', link: '/p_(x_y)_z' }]],
  ])('%s is read as %j', (markdown, content) => {
    expect(blocksFromMarkdown(markdown)[0]?.content).toEqual(content);
  });

  test('an image line with balanced parentheses in its source is an image', () => {
    const block = blocksFromMarkdown('![cat](https://a.test/c_(1).png)')[0];
    expect(block?.type).toBe('image');
    expect(block?.src).toBe('https://a.test/c_(1).png');
  });

  test('a line of links and parentheses parses in linear time', () => {
    expect(
      growth((size) => {
        blocksFromMarkdown('[a](b)(c)'.repeat(size));
      }, 200),
    ).toBeLessThan(LINEAR);
  });

  // GFM links a bare URL up to the next whitespace or `<`, so anything written
  // against one went into the link: an escape's backslash, a line break's, the
  // reference for a trailing space. A bare URL is written as an autolink,
  // inside which nothing is escaped and against which nothing can join; GFM's
  // trailing punctuation and unbalanced parentheses stay outside it.
  test.each([
    ['see https://a.test/~x now', 'see <https://a.test/~x> now'],
    ['https://a.test/docs\nnext', '<https://a.test/docs>\\\nnext'],
    ['see https://a.test ', 'see <https://a.test>&#32;'],
    ['see https://a.test/x.', 'see <https://a.test/x>.'],
    ['go (https://a.test/x)', 'go (<https://a.test/x>)'],
    ['https://en.wikipedia.org/wiki/Foo_(bar)', '<https://en.wikipedia.org/wiki/Foo_(bar)>'],
    ['https://a.test/x_y, then', '<https://a.test/x_y>, then'],
    ['HTTPS://A.TEST/x~y', '<HTTPS://A.TEST/x~y>'],
    // GFM leaves an entity-shaped `&…;` out of the end of the link too.
    ['see https://a.test/x&amp;', 'see <https://a.test/x>\\&amp;'],
    // A backslash ends it: this reader resolves escapes before autolinks.
    ['http://a.b/c\\:', '<http://a.b/c>\\\\:'],
    // A scheme with nothing after it links nowhere, and is left alone.
    ['see http:// now', 'see http:// now'],
    // A `www.` URL has no autolink spelling, and is left as it was.
    ['www.a.test/x_y', 'www.a.test/x_y'],
  ])('%j is written %j', (text, markdown) => {
    const blocks = [b({ content: t(text) })];
    expect(toMarkdown({ blocks })).toBe(markdown);
    expect(throughMarkdown(blocks)[0]?.content).toEqual(t(text));
  });

  test.each([
    [[{ text: 'https://a.test/x_y', marks: ['bold'] }], '**<https://a.test/x_y>**'],
    [
      [{ text: 'a' }, { text: 'https://a.test/x', marks: ['bold'] }, { text: 'b' }],
      'a<strong><https://a.test/x></strong>b',
    ],
    // Link text and code are not bare URLs.
    [[{ text: 'https://a.test', link: 'https://a.test/' }], '[https://a.test](https://a.test/)'],
    [[{ text: 'https://a.test/x', marks: ['code'] }], '`https://a.test/x`'],
  ] as const)('%j is written %s', (content, markdown) => {
    const blocks = [b({ content: content as never })];
    expect(toMarkdown({ blocks })).toBe(markdown);
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  test.each([
    ['<https://a.test/x_y>', [{ text: 'https://a.test/x_y' }]],
    ['<https://a.test/*x*>', [{ text: 'https://a.test/*x*' }]],
    ['a <https://a.test/x_y_> b', [{ text: 'a https://a.test/x_y_ b' }]],
    // The angle form of a destination is not an autolink.
    ['[a](<https://a.test/x>)', [{ text: 'a', link: 'https://a.test/x' }]],
    // Whitespace ends an unclosed one, and what follows is prose.
    ['<https://a.test/x *y*', [{ text: '<https://a.test/x ' }, { text: 'y', marks: ['italic'] }]],
    // Only an absolute http(s) URL is one; `<u>` and the rest are tags.
    ['<b>x', [{ text: '<b>x' }]],
  ])('%j is read as %j', (markdown, content) => {
    expect(blocksFromMarkdown(markdown)[0]?.content).toEqual(content);
  });

  // Inside `<code>…</code>` GFM autolinks a URL as it does anywhere, so the
  // escape after it went into the link; in a backtick span it does not.
  test.each([
    [[{ text: 'see http://a.b~x', marks: ['code'] }], '<code>see <http://a.b~x></code>'],
    [[{ text: 'see http://a.b', marks: ['code'] }], '`see http://a.b`'],
  ] as const)('code %j is written %s', (content, markdown) => {
    const blocks = [b({ content: content as never })];
    expect(toMarkdown({ blocks })).toBe(markdown);
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  // The `](<…>)` of a destination is a link's own spelling, not an autolink:
  // taken for one, a URL holding an unbalanced `)` lost its link.
  test('a link whose URL holds an unbalanced paren keeps its link', () => {
    const blocks = [b({ content: [{ text: 'a', link: 'https://a.test/x)y' }] })];
    expect(toMarkdown({ blocks })).toBe('[a](<https://a.test/x)y>)');
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  // An autolink's text is plain once it closes, so what follows can pair with
  // it: a URL holding a delimiter or a bracket keeps the escaped spelling.
  test.each([
    [[{ text: 'https://a.test/*x' }, { text: 'y', marks: ['italic'] }], 'https://a.test/\\*x*y*'],
    [[{ text: 'https://a.test/)![a](b' }, { text: ')' }], 'https://a.test/)!\\[a\\](b)'],
    [[{ text: 'https://a.test/`x' }, { text: 'y', marks: ['code'] }], 'https://a.test/\\`x`y`'],
  ] as const)('%j is written %s', (content, markdown) => {
    const blocks = [b({ content: content as never })];
    expect(toMarkdown({ blocks })).toBe(markdown);
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  // A `|` ends it, so a URL in a table cell does not split the cell.
  test('a URL holding a pipe in a table cell stays in its cell', () => {
    const blocks = [
      b({
        type: 'table',
        rows: [
          [[{ text: 'https://a.test/x_y_| a |' }], [{ text: 'c' }]],
          [[{ text: '1' }], [{ text: '2' }]],
        ] as never,
      }),
    ];
    expect(toMarkdown({ blocks }).split('\n')[0]).toBe('| <https://a.test/x_y>\\_\\| a \\| | c |');
    expect(throughMarkdown(blocks)[0]?.rows).toEqual(start(blocks)[0]?.rows);
  });

  test('a struck URL holding a tilde keeps the escaped spelling', () => {
    const blocks = [b({ content: [{ text: 'https://a.test/~x', marks: ['strikethrough'] }] })];
    expect(toMarkdown({ blocks })).toBe('~~https://a.test/\\~x~~');
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  // Through the HTML clipboard. A to-do is written `☐ ` and its text; the
  // reader stripped the box and every space after it, so a to-do whose text
  // starts with whitespace, or is only a line break, lost it.
  test.each(['\tx', '  3.', '\n', ' a'])(
    'a to-do holding %j survives the HTML clipboard',
    (text) => {
      const blocks = [b({ type: 'todo', checked: true, content: t(text) })];
      expect(throughHtml(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
    },
  );

  // In a list this editor wrote, an empty item is a block. Another editor's
  // HTML may use one only to hold a nested list, which is why foreign ones go.
  test.each(['bulleted_list', 'numbered_list', 'todo'] as const)(
    'an empty %s with a nested item survives the HTML clipboard',
    (type) => {
      const blocks = [b({ type, content: [] }), b({ type, depth: 1, content: t('child') })];
      expect(shape(throughHtml(blocks))).toEqual(shape(start(blocks)));
    },
  );

  // Text that is only whitespace, ahead of a nested list, reads as the HTML's
  // own formatting: the writer puts it in a span so it reads as text.
  test.each([' ', '\t\n  '])('a list item holding only %j survives the HTML clipboard', (text) => {
    const blocks = [
      b({ type: 'bulleted_list', content: t(text) }),
      b({ type: 'bulleted_list', depth: 1, content: t('child') }),
    ];
    expect(shape(throughHtml(blocks))).toEqual(shape(start(blocks)));
  });
});

describe('audit 24', () => {
  const shape = (blocks: Block[]) =>
    blocks.map(({ type, depth, content }) => ({ type, depth, content }));

  // The reader closes an autolink only within its window, so one longer than
  // that was never read back and gained a pair of brackets on every save.
  test('a URL too long for the reader to close keeps the escaped spelling', () => {
    const url = `https://a.test/?q=${'x'.repeat(2100)}`;
    const blocks = [b({ content: t(`see ${url} end`) })];
    expect(toMarkdown({ blocks })).toBe(`see ${url} end`);
    expect(throughMarkdown(throughMarkdown(blocks))[0]?.content).toEqual(t(`see ${url} end`));
  });

  test('one that fits is still an autolink', () => {
    const url = `https://a.test/?q=${'x'.repeat(1900)}`;
    const blocks = [b({ content: t(`see ${url} end`) })];
    expect(toMarkdown({ blocks })).toBe(`see <${url}> end`);
    expect(throughMarkdown(blocks)[0]?.content).toEqual(t(`see ${url} end`));
  });

  // A `<br>` in a backtick span is code, in a heading or a table cell as
  // anywhere: GFM shows it, and so did this reader before it read `<br>` there.
  test.each([
    [
      '# The `<br>` element',
      [{ text: 'The ' }, { text: '<br>', marks: ['code'] }, { text: ' element' }],
    ],
    ['# a ``x <br> y`` b', [{ text: 'a ' }, { text: 'x <br> y', marks: ['code'] }, { text: ' b' }]],
    ['# a<br>b', [{ text: 'a\nb' }]],
  ])('%j is read as %j', (markdown, content) => {
    expect(blocksFromMarkdown(markdown)[0]?.content).toEqual(content);
  });

  test('and in a table cell', () => {
    expect(
      blocksFromMarkdown('| Tag | Use |\n| --- | --- |\n| `<br>` | a<br>b |')[0]?.rows?.[1],
    ).toEqual([[{ text: '<br>', marks: ['code'] }], t('a\nb')]);
  });

  // A code span takes precedence over an autolink, as in CommonMark: showing
  // autolink syntax in code is what documentation does.
  test.each([
    [
      'Autolinks look like `<https://example.com>`.',
      [
        { text: 'Autolinks look like ' },
        { text: '<https://example.com>', marks: ['code'] },
        { text: '.' },
      ],
    ],
    [
      'Prefix `<https://a.test/x` here',
      [{ text: 'Prefix ' }, { text: '<https://a.test/x', marks: ['code'] }, { text: ' here' }],
    ],
  ])('%j is read as %j', (markdown, content) => {
    expect(blocksFromMarkdown(markdown)[0]?.content).toEqual(content);
  });

  // Markdown from `main` wrote a nested block's leading space raw, so a child
  // one level below it sat one column short of two more.
  test('nested depths written by main still read', () => {
    expect(blocksFromMarkdown('- a\n\n   b\n\n    - c').map((block) => block.depth)).toEqual([
      0, 1, 2,
    ]);
  });

  // `main` also wrote a leading tab raw after the indentation: it is not
  // indentation, though the text loses it as it always did.
  test('a tab after the indentation is not more indentation', () => {
    expect(blocksFromMarkdown('- a\n\n  \tb\n\n    - c').map((block) => block.depth)).toEqual([
      0, 1, 2,
    ]);
  });

  // An unbalanced destination is no link: the pattern took the first `](`
  // after the `[`, while the parentheses were balanced against the last.
  test('[x](https://w.test/a](b) is no link', () => {
    expect(blocksFromMarkdown('[x](https://w.test/a](b)')[0]?.content).toEqual(
      t('[x](https://w.test/a](b)'),
    );
  });

  // Balanced, it is one link to the whole destination, as in CommonMark; it
  // used to end at the inner `)` and italicise the `y` after it.
  test('[x](https://x.test/a](b)/_y_) is one link', () => {
    expect(blocksFromMarkdown('[x](https://x.test/a](b)/_y_)')[0]?.content).toEqual([
      { text: 'x', link: 'https://x.test/a](b)/_y_' },
    ]);
  });

  // Fixes that nothing pinned.
  test('nothing closes in a destination while a paren in it is open', () => {
    expect(blocksFromMarkdown('[x](/wiki/F_(b)_c_)')[0]?.content).toEqual([
      { text: 'x', link: '/wiki/F_(b)_c_' },
    ]);
  });

  test('an image line whose parens do not balance is no image', () => {
    expect(blocksFromMarkdown('![a](https://a.test/x.png)(c)')[0]?.type).toBe('paragraph');
  });

  test('a URL holding ~~ keeps the escaped spelling', () => {
    const blocks = [
      b({ content: [{ text: 'https://a.test/x~~a' }, { text: 'c', marks: ['strikethrough'] }] }),
    ];
    expect(throughMarkdown(blocks)[0]?.content).toEqual(start(blocks)[0]?.content);
  });

  // A nested fence the document ends inside is unindented too.
  test('an unclosed nested fence', () => {
    const back = blocksFromMarkdown('1. a\n\n   ```\n   x\n   y');
    expect(shape(back)).toEqual(
      shape([
        b({ type: 'numbered_list', content: t('a') }),
        b({ type: 'code', depth: 1, content: t('x\ny') }),
      ]),
    );
  });

  // The writer indents a nested code block with spaces, so only spaces come
  // off: a tab at the start of a line of older output is the code's own.
  test.each([
    ['- p\n\n  ```\n\t (x\n  ```', '\t (x'],
    ['- p\n\n  ```\n\t\n  a\n  ```', '\t\n  a'],
    ['- p\n\n  ```\n \n  a\n  ```', ' \n  a'],
  ])('%j reads its code as %j', (markdown, code) => {
    expect(blocksFromMarkdown(markdown)[1]?.content).toEqual(t(code));
  });
});

describe('audit 25', () => {
  // A code span that opened inside an autolink closes nothing: the autolink
  // started first, and CommonMark links the whole of it.
  test.each([
    ['<https://a.test/`x`>', [{ text: 'https://a.test/`x`' }]],
    // A backtick inside the autolink opens nothing either.
    ['<https://a.test/`x>', [{ text: 'https://a.test/`x' }]],
    ['`a` <https://a.test/x>', [{ text: 'a', marks: ['code'] }, { text: ' https://a.test/x' }]],
  ])('%j is read as %j', (markdown, content) => {
    expect(blocksFromMarkdown(markdown)[0]?.content).toEqual(content);
  });

  // The window edge exactly: a URL of the limit less two is the longest the
  // reader can close as an autolink.
  test.each([1997, 1998, 1999, 2000])('a %i-character URL survives three saves', (length) => {
    const url = `https://a.test/?q=${'x'.repeat(length - 'https://a.test/?q='.length)}`;
    const blocks = [b({ content: t(`see ${url} end`) })];
    expect(throughMarkdown(throughMarkdown(throughMarkdown(blocks)))[0]?.content).toEqual(
      t(`see ${url} end`),
    );
  });

  // An escaped backtick opens no code span, so a `<br>` after one is a break.
  test.each([['# a \\`<br>\\` b', [{ text: 'a `\n` b' }]]])(
    '%j is read as %j',
    (markdown, content) => {
      expect(blocksFromMarkdown(markdown)[0]?.content).toEqual(content);
    },
  );

  test('and in a table cell', () => {
    expect(blocksFromMarkdown('| a \\`<br>\\` b |\n| --- |')[0]?.rows?.[0]).toEqual([
      t('a `\n` b'),
    ]);
  });

  // A list item's child sits at its content column, so one a column short of
  // that is the item's sibling, as in CommonMark.
  test('an off-by-one item under a list item is its sibling', () => {
    expect(blocksFromMarkdown('1. Step\n   - a\n    - b').map((block) => block.depth)).toEqual([
      0, 1, 1,
    ]);
  });

  // A fence indented with a tab, as editors that indent lists with tabs write
  // it: its body loses that tab.
  test('a tab-indented fence in a list', () => {
    const back = blocksFromMarkdown('- item\n\t```js\n\tconst a = 1;\n\t\treturn a;\n\t```');
    expect(back[1]?.content).toEqual(t('const a = 1;\n\treturn a;'));
  });
});

describe('audit 26', () => {
  // The backticks of a code span refused inside an autolink stay text, and
  // pair with nothing later: `with` is not swallowed into a span they open.
  test.each([
    [
      'Compare <http://host/`path` with `other`.',
      [
        { text: 'Compare <http://host/`path` with ' },
        { text: 'other', marks: ['code'] },
        { text: '.' },
      ],
    ],
    [
      'Call <https://api.test/`v`/items> with `GET`.',
      [
        { text: 'Call https://api.test/`v`/items with ' },
        { text: 'GET', marks: ['code'] },
        { text: '.' },
      ],
    ],
    // An autolink inside a double-backtick code span is code, brackets and all.
    [
      'x ``<https://a.test/>`` y',
      [{ text: 'x ' }, { text: '<https://a.test/>', marks: ['code'] }, { text: ' y' }],
    ],
    // An autolink's `<` right after another `<` opens none: the second `>`
    // would close the URL a second time and take both outer brackets with it.
    ['see <<https://a.test/>> now', [{ text: 'see <<https://a.test/>> now' }]],
  ])('%j is read as %j', (markdown, content) => {
    expect(blocksFromMarkdown(markdown)[0]?.content).toEqual(content);
  });

  // Runs pair by length, so a single backtick inside a double-backtick span
  // leaves it open, and the autolink in it keeps its brackets. (Where the
  // backticks go is the per-character pairing `main` already had.)
  test('an autolink after a lone backtick in a double-backtick span', () => {
    const content = blocksFromMarkdown('x ``a` <https://a.test/>`` y')[0]?.content ?? [];
    expect(content.map((run) => run.text).join('')).toContain('<https://a.test/>');
  });

  // A tab-indented line's column is an estimate (a tab counts two), so the
  // two-columns-a-level rule still applies to it under a list item.
  test('a tab-indented item under a list item nests', () => {
    expect(blocksFromMarkdown('1. a\n   - b\n\t\t- c').map((block) => block.depth)).toEqual([
      0, 1, 2,
    ]);
  });

  // What counts as a list item for that rule: both ordinal spellings, and not
  // emphasis that happens to start with a bullet character.
  test.each([
    ['1. Step\n   1. a\n    - b', [0, 1, 1]],
    ['1. Step\n   1) a\n    - b', [0, 1, 1]],
    ['1. Step\n   *emph*\n    - b', [0, 1, 2]],
  ])('%j nests as %j', (markdown, depths) => {
    expect(blocksFromMarkdown(markdown).map((block) => block.depth)).toEqual(depths);
  });
});
