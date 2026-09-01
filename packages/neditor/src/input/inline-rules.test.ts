import { describe, expect, test } from 'vitest';

import { matchInlineRule } from './inline-rules.ts';

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

    test('an empty label does not fire', () => {
      expect(matchInlineRule('[](https://a.test/)')).toBe(null);
    });
  });
});
