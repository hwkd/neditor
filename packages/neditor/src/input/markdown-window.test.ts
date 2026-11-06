import { describe, expect, test, vi } from 'vitest';

import { INLINE_SPAN_LIMIT } from './inline-rules.ts';

// Records how much text the Markdown reader hands the rules on each call. The
// cost of a call is that length -- the rules slice their window off it, which
// flattens it -- so the reader keeping it bounded is what keeps a long line
// linear. Timing could only see that past about 100 KB; this sees it at any size.
const seen = vi.hoisted(() => ({ longest: 0 }));

vi.mock('./inline-rules.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./inline-rules.ts')>();

  return {
    ...actual,
    matchInlineRule: (...args: Parameters<typeof actual.matchInlineRule>) => {
      seen.longest = Math.max(seen.longest, args[0].length);
      return actual.matchInlineRule(...args);
    },
  };
});

const { parseInlineMarkdown } = await import('./markdown.ts');

describe('the text the rules are handed stays bounded', () => {
  // A line with no finished span parks nothing, and the cut used to wait for
  // a parked run: the text grew to the whole line.
  test.each([
    ['closing characters and no span', 'a) '],
    ['refused spans in bare URLs', 'https://a.test/_b '],
  ])('on a long line of %s', (_name, unit) => {
    seen.longest = 0;
    parseInlineMarkdown(unit.repeat(Math.ceil((20 * INLINE_SPAN_LIMIT) / unit.length)));
    expect(seen.longest).toBeLessThanOrEqual(3 * (INLINE_SPAN_LIMIT + 1));
  });

  // What the rules look back over is kept whole: a bare URL that started 1,500
  // characters before the `_` still protects it, though the line is cut while
  // the URL is being read.
  test('without cutting into the window the rules look back over', () => {
    const line = `${'a) '.repeat(1000)}https://a.test/${'x'.repeat(1500)}/_y_`;
    expect(parseInlineMarkdown(line)).toEqual([{ text: line }]);
  });

  // And a span opened long before is still read: the cut never passes it.
  test('without cutting an opening delimiter that is still in reach', () => {
    seen.longest = 0;
    const content = parseInlineMarkdown(`_${'a) '.repeat(500)}b_ ${'c) '.repeat(4000)}*d*`);
    expect(content[0]).toEqual({ text: `${'a) '.repeat(500)}b`, marks: ['italic'] });
    expect(content.at(-1)).toEqual({ text: 'd', marks: ['italic'] });
    expect(seen.longest).toBeLessThanOrEqual(3 * (INLINE_SPAN_LIMIT + 1));
  });
});
