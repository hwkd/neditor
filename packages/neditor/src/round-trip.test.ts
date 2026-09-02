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
  'long block with bold': [
    b({ content: [{ text: 'x'.repeat(2100) }, { text: 'bold', marks: ['bold'] }] }),
  ],
};

/** Currently broken through `toMarkdown` -> `blocksFromMarkdown`. */
const KNOWN_MARKDOWN_FAILURES: Record<string, string> = {
  'italic after word char': '#46 the italic rule refuses to fire after a word character',
  'bold+italic': '#46 `a***b***` comes back as bold with stray asterisks in the text',
  'link with paren': '#49 the destination is not escaped, so the first `)` closes the link',
  'empty heading1': '#10 the marker loses its trailing space to trimEnd before matching',
  'empty quote': '#10',
  'empty todo': '#10 and the checked flag is lost with it',
  'empty bulleted': '#10',
  'empty callout': '#10',
  'empty toggle': '#10',
  'quote starting with emoji': '#48 the parser promotes any emoji-led quote to a callout',
  'callout arrow icon': '#48 an icon outside the pictographic classes demotes it to a quote',
  'paragraph of dashes': '#50 `-` is not escaped, so the text is read back as a divider',
  'code block with fence': '#11 the fence is never lengthened past an inner fence',
  'image with paren in src': '#51 the src is not escaped, so IMAGE_LINE stops matching',
  'empty paragraph between': 'documented gap: Markdown cannot express an empty paragraph',
  'long block with bold': '#47 past INLINE_LIMIT the delimiters are left in the text',
};

/** Currently broken through `blocksToHtml` -> `blocksFromHtml`. */
const KNOWN_HTML_FAILURES: Record<string, string> = {
  // Wider than the audit's #16, which named only empty paragraphs: pushBlock
  // drops ANY block whose runs are empty, so every empty non-paragraph block
  // is lost by the clipboard path too.
  'empty heading1': '#16 pushBlock drops a block whose runs are empty',
  'empty quote': '#16',
  'empty todo': '#16',
  'empty bulleted': '#16',
  'empty paragraph between': '#16 — and README:534 claims the HTML path keeps these',
};

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
    rows: block.rows
      ? block.rows.map((row) => row.map((cell) => cell.map((run) => run.text).join('')))
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
