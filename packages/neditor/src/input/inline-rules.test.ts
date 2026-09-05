import { describe, expect, test } from 'vitest';

import { INLINE_SPAN_LIMIT, matchInlineRule } from './inline-rules.ts';
import { blocksFromMarkdown } from './markdown.ts';

/** Reproduces what the editor does with a match: strip delimiters, keep inner. */
function apply(input: string): { text: string; mark?: string; link?: string } | null {
  const match = matchInlineRule(input);

  if (!match) {
    return null;
  }

  const inner = input.slice(match.start + match.openLength, match.end - match.closeLength);
  const rest = input.slice(0, match.start) + inner;

  return { text: rest, mark: match.mark, link: match.link };
}

describe('inline markdown rules', () => {
  test.each([
    ['**bold**', 'bold', 'bold'],
    ['__bold__', 'bold', 'bold'],
    ['*italic*', 'italic', 'italic'],
    ['_italic_', 'italic', 'italic'],
    ['~~gone~~', 'gone', 'strikethrough'],
    ['`code`', 'code', 'code'],
    ['<u>under</u>', 'under', 'underline'],
  ])('%s becomes %s as %s', (input: string, expected: string, mark: string) => {
    expect(apply(input)).toEqual({ text: expected, mark, link: undefined });
  });

  test('every rule is still reached through the character it closes on', () => {
    // A rule is only tried when the caret sits on the character its closing
    // delimiter ends with, which is what keeps the link patterns off a line
    // with no `)` in it. Get that character wrong for a rule and the rule
    // simply stops firing, silently — so each one is named here.
    const closers = new Map([
      ['*', '**b**'],
      ['_', '__b__'],
      ['~', '~~b~~'],
      ['`', '`b`'],
      ['>', '<u>b</u>'],
      [')', '[b](https://a.test/)'],
    ]);

    for (const [closer, source] of closers) {
      expect([closer, source.at(-1)]).toEqual([closer, closer]);
      expect([source, matchInlineRule(source) !== null]).toEqual([source, true]);
    }
  });

  test('bold wins over italic on a doubled delimiter', () => {
    expect(matchInlineRule('**x**')?.mark).toBe('bold');
  });

  test('preceding text is preserved and offsets point at the delimiter', () => {
    const match = matchInlineRule('hello **world**');

    expect(match?.start).toBe(6);
    expect(match?.end).toBe(15);
    expect(match?.openLength).toBe(2);
    expect(match?.closeLength).toBe(2);
    expect(apply('hello **world**')?.text).toBe('hello world');
  });

  test('only fires when the closing delimiter is at the caret', () => {
    expect(matchInlineRule('**bold** trailing')).toBe(null);
    expect(matchInlineRule('**unclosed')).toBe(null);
  });

  test('an empty span does not fire', () => {
    expect(matchInlineRule('****')).toBe(null);
    expect(matchInlineRule('``')).toBe(null);
  });

  test('an italic delimiter inside a word does not fire', () => {
    // `snake_case_name` must survive being typed.
    expect(matchInlineRule('snake_case_')).toBe(null);
  });

  test('an asterisk after a word character does fire', () => {
    // CommonMark restricts intra-word emphasis to `_`, and `toMarkdown` writes
    // `*x*` whatever precedes it — refusing here left the asterisks in the text.
    expect(apply('Chapter*One*')).toEqual({ text: 'ChapterOne', mark: 'italic', link: undefined });
  });

  test('bold closes before the italic wrapped around it', () => {
    expect(matchInlineRule('a***b**')?.mark).toBe('bold');
    // ...leaving `a*b*`, which is the italic half of the same span.
    expect(matchInlineRule('a*b*')?.mark).toBe('italic');
  });

  test('a span longer than the window does not fire', () => {
    const inside = `*${'x'.repeat(INLINE_SPAN_LIMIT - 2)}*`;
    const beyond = `*${'x'.repeat(INLINE_SPAN_LIMIT + 10)}*`;

    // The bound is what lets the parser scan a long line at all; without it the
    // scan is quadratic and long lines used not to be parsed whatsoever.
    expect(matchInlineRule(inside)?.mark).toBe('italic');
    expect(matchInlineRule(beyond)).toBe(null);
  });

  test('offsets stay absolute once the window has moved', () => {
    const prefix = 'y'.repeat(INLINE_SPAN_LIMIT);
    const match = matchInlineRule(`${prefix} **b**`);

    expect(match?.start).toBe(prefix.length + 1);
    expect(match?.end).toBe(prefix.length + 6);
  });

  test('a delimiter spanning a newline does not fire', () => {
    expect(matchInlineRule('*a\nb*')).toBe(null);
  });

  describe('links', () => {
    test('captures text and href', () => {
      expect(apply('[docs](https://a.test/x)')).toEqual({
        text: 'docs',
        mark: undefined,
        link: 'https://a.test/x',
      });
    });

    test('offsets cover the whole markup', () => {
      const match = matchInlineRule('[a](b.test)');

      expect(match?.start).toBe(0);
      expect(match?.openLength).toBe(1);
      expect(match?.closeLength).toBe('](b.test)'.length);
    });

    test('a bare host is upgraded to https', () => {
      expect(apply('[a](example.com)')?.link).toBe('https://example.com/');
    });

    test('an unsafe href leaves the literal text alone', () => {
      expect(matchInlineRule('[click](javascript:alert(1))')).toBe(null);
    });

    test('an angle-bracketed destination keeps its parens', () => {
      expect(apply('[Mercury](<https://a.test/M_(planet)>)')).toEqual({
        text: 'Mercury',
        mark: undefined,
        link: 'https://a.test/M_(planet)',
      });
    });

    test('an empty label does not fire', () => {
      expect(matchInlineRule('[](https://a.test/)')).toBe(null);
    });
  });
});

describe('a line of unpaired brackets is not a link scan', () => {
  test('stays fast when no `](` is present', () => {
    // Every `)` used to restart a scan back through the whole 2000-character
    // window from each `[`, so 21KB of half-open intervals cost ~1s per paste.
    const source = '*S* = [0, 1) [1, 2) [2, 3) [3, 4) [4, 5) '.repeat(512);
    const started = performance.now();

    blocksFromMarkdown(source);

    expect(performance.now() - started).toBeLessThan(400);
  });

  test('real links in the same shape still parse', () => {
    const runs = blocksFromMarkdown('a [0, 1) b [docs](https://a.test/x) c')[0]!.content;
    const link = runs.find((run) => run.link);

    expect(link?.link).toBe('https://a.test/x');
    expect(link?.text).toBe('docs');
  });

  test('an angle-bracketed destination still parses', () => {
    const runs = blocksFromMarkdown('[M](<https://a.test/M_(planet)>)')[0]!.content;

    expect(runs.find((run) => run.link)?.link).toBe('https://a.test/M_(planet)');
  });
});

describe('a stray "](" before a real link', () => {
  test('does not swallow the link', () => {
    // No `)` or whitespace separates the stray `](` from the real one, so the
    // reach covers both. Taking the first unconditionally found one that opens
    // nothing, and the rule was skipped: the link vanished and the markup
    // stayed as text. CommonMark reads `x](y` as literal and `[z](…)` as a link.
    const runs = blocksFromMarkdown('x](y[z](https://e.com)')[0]!.content;

    expect(runs.find((run) => run.link)?.link).toBe('https://e.com/');
    expect(runs.map((run) => run.text).join('')).toBe('x](yz');
  });

  test('several of them still resolve the right one', () => {
    const runs = blocksFromMarkdown('a](b](c[d](https://a.test/d)')[0]!.content;

    expect(runs.find((run) => run.link)?.link).toBe('https://a.test/d');
  });
});

describe('emphasis needs a delimiter that can actually open or close', () => {
  /**
   * CommonMark's flanking rule, in the part that matters: an opening delimiter
   * may not be followed by whitespace, and a closing one may not be preceded by
   * it. Without it these matched, and since the rule fires on every keystroke
   * the characters vanished as the user typed them -- in exactly the prose a
   * developer writes.
   */
  const literal = (source: string): string =>
    (blocksFromMarkdown(source)[0]?.content ?? []).map((run) => run.text).join('');

  test.each([
    ['a MongoDB field list', 'use _id and _rev fields'],
    ['a shell glob', 'rm -rf *.log and *.tmp'],
    ['two SQL wildcards', 'SELECT * FROM a; SELECT * FROM b'],
    ['multiplication', '3 * 4 * 5 = 60'],
    ['approximate ranges', 'ranges are ~~ 5 to ~~ 9'],
    ['a lone asterisk', 'a * b'],
    ['spaced double asterisks', 'x ** y ** z'],
  ])('%s survives verbatim', (_name, source) => {
    expect(literal(source)).toBe(source);
  });

  test('and nothing in them is marked', () => {
    for (const source of ['3 * 4 * 5 = 60', 'use _id and _rev fields']) {
      const runs = blocksFromMarkdown(source)[0]?.content ?? [];

      expect(runs.every((run) => (run.marks ?? []).length === 0)).toBe(true);
    }
  });

  test.each([
    ['**bold**', 'bold', 'bold'],
    ['*italic*', 'italic', 'italic'],
    ['_italic_', 'italic', 'italic'],
    ['~~struck~~', 'struck', 'strikethrough'],
    ['*a b*', 'a b', 'italic'],
  ])('%s still works', (source, text, mark) => {
    const runs = blocksFromMarkdown(source)[0]?.content ?? [];

    expect(runs).toHaveLength(1);
    expect(runs[0]?.text).toBe(text);
    expect(runs[0]?.marks).toEqual([mark]);
  });

  test('intra-word emphasis with an asterisk is still allowed', () => {
    const runs = blocksFromMarkdown('Chapter*One*')[0]?.content ?? [];

    expect(runs.at(-1)?.marks).toEqual(['italic']);
  });

  /**
   * Deliberately unchanged. A code span is delimited by backtick runs, not by
   * flanking, so `` ` a ` `` really is code in CommonMark -- the rule being
   * added here is emphasis's, and applying it to backticks would be a second
   * bug rather than a fix.
   */
  test('a code span keeps its spaces', () => {
    const runs = blocksFromMarkdown('press ` then ` again')[0]?.content ?? [];

    expect(runs.some((run) => (run.marks ?? []).includes('code'))).toBe(true);
  });
});
