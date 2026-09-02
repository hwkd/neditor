import { describe, expect, test } from 'vitest';

import { INLINE_SPAN_LIMIT, matchInlineRule } from './inline-rules.ts';

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
  ])('%s becomes %s as %s', (input: string, expected: string, mark: string) => {
    expect(apply(input)).toEqual({ text: expected, mark, link: undefined });
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
