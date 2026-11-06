// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';

import type { Block, TextRun } from './index.ts';
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
  // Written `<…>` because of the paren; the plain rule used to close it at the
  // first `)` and read the `<` as part of a host.
  'mailto link with paren': [
    b({ content: t('call', { link: 'mailto:a@x.test?subject=Re:%20(draft)' }) }),
  ],
  // Base64 wrapped at 76 columns, as mail and many generators write it. The
  // newline went into the model, the writer percent-encoded it, and the
  // reader refused the `%`, so the image came back as a paragraph of base64.
  'image with wrapped base64': [
    b({ type: 'image', src: 'data:image/png;base64,iVBORw0KGgo\nAAAANSUhEUg==', alt: 'logo' }),
  ],
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
  // What a block ends with: kept by HTML and JSON, a documented Markdown gap
  // that the writer drops rather than writes.
  'paragraph ending in a line break': [b({ content: t('x\n') }), b({ content: t('after') })],
  'paragraph ending in spaces': [b({ content: t('x  ') }), b({ content: t('after') })],
  'long block with bold': [
    b({ content: [{ text: 'x'.repeat(2100) }, { text: 'bold', marks: ['bold'] }] }),
  ],
  // A link destination is literal: none of these delimiters is emphasis there.
  'link destination with dunder': [
    b({
      content: t('init', {
        link: 'https://docs.python.org/3/reference/datamodel.html#object.__init__',
      }),
    }),
  ],
  'link destination with stars': [b({ content: t('a', { link: 'https://a.test/**y**' }) })],
  'link destination with underscores': [b({ content: t('a', { link: 'https://a.test/_x_' }) })],
  'link destination with tildes': [b({ content: t('a', { link: 'https://a.test/~~x~~' }) })],
  'link destination with paren and dunder': [
    b({ content: t('a', { link: 'https://a.test/(a)/__x__' }) }),
  ],
  // A backslash survives `sanitizeUrl` in a query, and a destination reads
  // escapes as CommonMark does, so the writer has to escape it in turn.
  'link destination with a backslash before a paren': [
    b({ content: t('a', { link: 'https://a.test/?q=a\\(b' }) }),
  ],
  'link destination with a backslash before punctuation': [
    b({ content: t('a', { link: 'https://a.test/?q=a\\$b\\_c' }) }),
  ],
  'link destination with a trailing backslash': [
    b({ content: t('a', { link: 'https://a.test/?q=a\\' }) }),
  ],
  // A backtick in a destination is part of the URL. This reader once paired
  // backtick runs before it looked for links, and some readers still do: there,
  // unescaped, it opened a code span that ran to the next backtick in the line
  // and swallowed the link's `)`. The writer escapes it for them; this reader,
  // like CommonMark, reads it in the destination either way.
  'link destination with a backtick, before inline code': [
    b({
      content: [
        { text: 'a', link: 'https://x.test/?q=`' },
        { text: ' and ' },
        { text: 'code', marks: ['code'] },
      ],
    }),
  ],
  'link destination in angle brackets with a backtick, before inline code': [
    b({
      content: [
        { text: 'a', link: 'https://x.test/?q=(`b)' },
        { text: ' and ' },
        { text: 'code', marks: ['code'] },
      ],
    }),
  ],
  'link destination with two backticks, before inline code': [
    b({
      content: [
        { text: 'a', link: 'https://x.test/?q=``' },
        { text: ' ' },
        { text: 'x', marks: ['code'] },
        { text: ' ' },
        { text: 'b', link: 'https://x.test/?q=``' },
      ],
    }),
  ],
  // Code span content is written literally, as CommonMark reads it.
  'inline code with delimiters': [
    b({ content: [{ text: 'a ' }, { text: '**b** _c_ ~~d~~ <u>e</u>', marks: ['code'] }] }),
  ],
  'inline code with a backslash': [b({ content: t('C:\\dir\\*x\\', { marks: ['code'] }) })],
  'inline code with a backtick': [b({ content: t('a`b', { marks: ['code'] }) })],
  'inline code opening and closing with backticks': [
    b({ content: t('``x`', { marks: ['code'] }) }),
  ],
  'inline code with a link inside it': [b({ content: t('[x](y) ](z', { marks: ['code'] }) })],
  'inline code that is one backtick': [b({ content: t('`', { marks: ['code'] }) })],
  'inline code between words': [
    b({ content: [{ text: 'a' }, { text: 'b c', marks: ['code'] }, { text: 'd' }] }),
  ],
  'inline code beside bold': [
    b({
      content: [
        { text: 'x', marks: ['bold'] },
        { text: '*', marks: ['code'] },
        { text: 'y', marks: ['bold'] },
      ],
    }),
  ],
  // Outside a table a pipe is nothing, and the code span is literal: an
  // escape written for it would be shown to every reader.
  'inline code with a pipe outside a table': [
    b({ content: [{ text: 'see ' }, { text: 'a|b', marks: ['code'] }] }),
  ],
  'inline code in a link': [b({ content: t('f()', { marks: ['code'], link: 'https://a.test/' }) })],
  'inline code with a pipe in a table cell': [
    b({
      type: 'table',
      rows: [
        [t('a|b', { marks: ['code'] }), t('h')],
        [t('c'), t('d')],
      ],
    }),
  ],
  // GFM splits a row on every unescaped pipe, a link destination's included.
  'link destination with a pipe in a table cell': [
    b({
      type: 'table',
      rows: [
        [t('a', { link: 'https://fonts.googleapis.com/css?family=Roboto|Open+Sans' }), t('h')],
        [t('c'), t('d')],
      ],
    }),
  ],
  // An empty item hangs the list below it; it is a block of its own.
  'empty bullet with child': [
    b({ type: 'bulleted_list', content: [] }),
    b({ type: 'bulleted_list', content: t('child'), depth: 1 }),
  ],
  'empty numbered with child': [
    b({ type: 'numbered_list', content: [] }),
    b({ type: 'numbered_list', content: t('child'), depth: 1 }),
  ],
  'empty todo with child': [
    b({ type: 'todo', content: [], checked: true }),
    b({ type: 'todo', content: t('child'), checked: false, depth: 1 }),
  ],
  'whitespace-only todo': [b({ type: 'todo', content: t(' '), checked: true })],
  // Leading whitespace is text, not indentation.
  'paragraph with leading spaces': [
    b({ content: t('Intro') }),
    b({ content: t('    indented by four spaces') }),
  ],
  'paragraph with a leading tab': [b({ content: t('\tx') })],
  'heading with leading spaces': [b({ type: 'heading1', content: t('  hi') })],
  'todo with leading spaces': [b({ type: 'todo', content: t('  x'), checked: true })],
  'paragraph of only spaces': [b({ content: t('Intro') }), b({ content: t('   ') })],
  'leading spaces before a marker': [b({ content: t('  - not a list') })],
  'leading spaces before a reference': [b({ content: t(' &#32;x') })],
  'a literal reference at the start': [b({ content: t('&#32;x') })],
  'a literal escaped ampersand reference': [b({ content: t('&#38;x') })],
  // A leading line break is text too, and so is the whitespace after it. The
  // reader trimmed the soft-break-joined line, so the break and everything up
  // to the first visible character went; a block of nothing but a break went
  // with them.
  'paragraph led by a line break': [b({ content: t('\nfoo') })],
  'paragraph led by a line break and spaces': [b({ content: t('\n  b') })],
  'paragraph of only a line break': [
    b({ content: t('p') }),
    b({ content: t('\n') }),
    b({ content: t('q') }),
  ],
  'heading led by a line break': [b({ type: 'heading1', content: t('\nx') })],
  'bullet led by a line break and a space': [b({ type: 'bulleted_list', content: t('\n x') })],
  'quote of two line breaks': [b({ type: 'quote', content: t('\n\n') })],
  'bullet led by a line break and a triangle': [
    b({ type: 'bulleted_list', content: t('\n\u25BE x') }),
  ],
  'paragraph led by a line break and a reference': [b({ content: t('\n&#32;x') })],
  'bullet with leading spaces and a triangle': [
    b({ type: 'bulleted_list', content: t('  \u25BE x') }),
  ],
  'callout with leading spaces': [b({ type: 'callout', content: t('  note'), icon: '💡' })],
  'toggle with leading spaces': [b({ type: 'toggle', content: t('  t'), collapsed: false })],
  // A label is one line in Markdown: a break in one is written as a space.
  'image alt with a line break': [
    b({ type: 'image', src: 'https://a.test/x.png', alt: 'line1\nline2' }),
  ],
  'callout icon with a line break': [b({ type: 'callout', content: t('c'), icon: 'x\ny' })],
  // The placeholder the slash menu inserts, before a picture is chosen.
  'image with no source yet': [b({ type: 'image', src: '', alt: '' })],
  'image with alt and no source yet': [b({ type: 'image', src: '', alt: 'cat' })],
  'collapsed toggle with a child': [
    b({ type: 'toggle', content: t('t'), collapsed: true }),
    b({ content: t('kid'), depth: 1 }),
  ],
  'expanded toggle with a child': [
    b({ type: 'toggle', content: t('t'), collapsed: false }),
    b({ content: t('kid'), depth: 1 }),
  ],
};

/** Currently broken through `toMarkdown` -> `blocksFromMarkdown`. */
const KNOWN_MARKDOWN_FAILURES: Record<string, string> = {
  // Markdown has no way to express an empty paragraph: the writer emits a blank
  // line and the reader skips blank lines. The HTML path preserves them.
  'empty paragraph between': 'documented gap: Markdown cannot express an empty paragraph',
  // CommonMark drops both: trailing spaces end a line, and a hard break at the
  // very end of a block is not a break. Encoding them would write Markdown no
  // other reader understands, so the writer drops them too -- the break used
  // to be written as a trailing backslash, which every other reader showed
  // as a literal `\`. `document.test.ts` pins what is written.
  'paragraph ending in a line break':
    'documented gap: Markdown ignores a line break that ends a block',
  'paragraph ending in spaces': 'documented gap: Markdown strips the spaces that end a block',
  // A label is one line, and the writer collapses a break in one to a space so
  // the block survives at all; the image or callout comes back with its label
  // on one line. `document.test.ts` pins that it does come back.
  'image alt with a line break': 'deliberate: a line break in an alt text is written as a space',
  'callout icon with a line break': 'deliberate: a line break in an icon is written as a space',
};

/** Currently broken through `blocksToHtml` -> `blocksFromHtml`. */
const KNOWN_HTML_FAILURES: Record<string, string> = {};

/** The parts of a block a round trip has to preserve. */
function shape(blocks: readonly Block[]): unknown {
  return blocks.map((block) => ({
    type: block.type,
    depth: block.depth ?? 0,
    text: (block.content ?? []).map((run) => run.text).join(''),
    marks: (block.content ?? []).map((run) => (run.marks ?? []).join('+')).join('|'),
    links: (block.content ?? []).map((run) => run.link ?? '').join('|'),
    src: block.src ?? '',
    alt: block.alt ?? '',
    icon: block.icon ?? '',
    checked: block.checked ?? null,
    collapsed: block.collapsed ?? null,
    // A cell's marks and links too: its text alone would let a lost link
    // through whenever the text happened to survive.
    rows: block.rows
      ? block.rows.map((row) =>
          row.map((cell) => ({
            text: cell.map((run) => run.text).join(''),
            marks: cell.map((run) => (run.marks ?? []).join('+')).join('|'),
            links: cell.map((run) => run.link ?? '').join('|'),
          })),
        )
      : null,
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

describe('link destinations holding a backtick or a pipe, generated', () => {
  /**
   * A small seeded fuzz over the two characters a destination has to escape
   * because of what else is on its line: a backtick, which a reader that pairs
   * code spans before links would match with one later in the line, and a
   * pipe, which a table row splits on. Each run
   * may be code, linked, or both, beside prose carrying the same characters,
   * in a paragraph and in a table cell. Seeded, so a failure names its case.
   */
  let seed = 7;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;

    return seed / 0x7fffffff;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const LINKS = [
    'https://x.test/',
    'https://x.test/?q=`',
    'https://x.test/?q=``',
    'https://x.test/?q=a`b`c',
    'https://x.test/?q=(`)',
    'https://x.test/?q=a|b',
    'https://x.test/?q=`|`',
    'https://x.test/?q=a\\`',
    // A mailto query keeps its parens, so the destination is bracketed.
    'mailto:a@x.test?subject=Re:%20(draft)',
    'mailto:a@x.test?subject=(`)',
    'mailto:a@x.test?subject=a|b',
    // A safe `[x](y)` inside a bracketed destination is part of the URL.
    'https://x.test/?q=[foo](https://y.test/)',
  ];
  // None begins with a space: a table cell is trimmed, as GFM trims it.
  const WORDS = ['a', 'b c', '`', 'x`y', '|', 'p|q', '(', ')', 'and'];
  const runs = (): TextRun[] =>
    Array.from({ length: 2 + Math.floor(random() * 4) }, (_, at): TextRun => ({
      text: `${at === 0 ? '' : ' '}${pick(WORDS)}z`,
      ...(random() < 0.35 ? { marks: ['code'] } : {}),
      ...(random() < 0.5 ? { link: pick(LINKS) } : {}),
    }));
  const cases = Array.from({ length: 300 }, (_, at) => {
    const blocks =
      at % 3 === 0
        ? [
            b({
              type: 'table',
              rows: [
                [runs(), runs()],
                [runs(), runs()],
              ],
            }),
          ]
        : [b({ content: runs() })];

    return [at, blocks] as const;
  });

  /**
   * Each character with its marks and link. Run boundaries are not compared:
   * the writer hoists whitespace out of a span, so a linked run that begins
   * with a space comes back as two runs, which is the documented behaviour and
   * not the question here. The whitespace's own formatting is dropped for the
   * same reason; its text is still compared.
   */
  const characters = (blocks: readonly Block[]): unknown =>
    blocks.map((block) => {
      const cells = block.rows ? block.rows.flat() : [block.content ?? []];

      return cells.map((cell) => ({
        text: cell.map((run) => run.text).join(''),
        formatted: cell.flatMap((run) =>
          // Every character generated here is ASCII.
          run.text
            .split('')
            .filter((char) => /\S/.test(char))
            .map((char) => `${char} ${(run.marks ?? []).join('+')} ${run.link ?? ''}`),
        ),
      }));
    });

  test.each(cases)('case %i round-trips through Markdown', (_at, blocks) => {
    const before = start(blocks);

    expect(characters(throughMarkdown(before))).toEqual(characters(before));
  });
});

describe('an image pasted with wrapped base64', () => {
  test('is still an image after a Markdown save', () => {
    // The finding's literal input: HTML in, Markdown out and back.
    const pasted = blocksFromHtml(
      document,
      '<p>before</p><img alt="logo" src="data:image/png;base64,iVBORw0KGgo\nAAAANSUhEUg==">',
    );
    const back = blocksFromMarkdown(toMarkdown({ blocks: pasted }));

    expect(back.map((block) => [block.type, block.src ?? null, block.alt ?? null])).toEqual([
      ['paragraph', null, null],
      ['image', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==', 'logo'],
    ]);
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
