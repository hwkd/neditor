import { describe, expect, test } from 'vitest';
import { farUnit, wordAt } from './grapheme.ts';

// The unit a double-click drag the editor draws selects by (`#resumeTextDrag`).
describe('wordAt', () => {
  const text = 'The quick, brown';

  test('a word, a run of spaces and a punctuation mark are each one', () => {
    expect(wordAt(text, 4)).toEqual([4, 9]);
    expect(wordAt(text, 8)).toEqual([4, 9]);
    expect(wordAt(text, 9)).toEqual([9, 10]);
    expect(wordAt(text, 10)).toEqual([10, 11]);
  });

  test('past the end is the last word; empty text is the offset itself', () => {
    expect(wordAt(text, 99)).toEqual([11, 16]);
    expect(wordAt('', 0)).toEqual([0, 0]);
  });

  // Read in a window around the offset, which must never cut the word.
  test('far into a long text, and a word longer than the window, whole', () => {
    const long = 'ab '.repeat(20_000);
    expect(wordAt(long, 45_001)).toEqual([45_000, 45_002]);
    const word = 'x'.repeat(1_000);
    const text = `${'a '.repeat(500)}${word} b`;
    expect(wordAt(text, 1_500)).toEqual([1_000, 2_000]);
  });

  // Cut on one edge only: each edge is asked on its own.
  test('a long word at the start of the text, and at its end, whole', () => {
    expect(wordAt(`${'x'.repeat(1_000)} b`, 10)).toEqual([0, 1_000]);
    const tail = `${'a '.repeat(500)}${'x'.repeat(1_000)}`;
    expect(wordAt(tail, tail.length - 10)).toEqual([1_000, 2_000]);
  });
});

// The far end of a multi-click drag the editor draws (`#returnTextDrag`).
describe('farUnit', () => {
  // R14-PTR-4, p15's literal case: code "\nalpha beta\ngamma delta",
  // "gamma delta" triple-clicked, dragged onto the blank first line. At
  // offset 0, `lastIndexOf('\n', -1)` clamps to 0 and finds the break that
  // opens the text, so the paragraph started at 1 and the drag lost the
  // blank line: "alpha beta\ngamma delta" for the whole text.
  const code = '\nalpha beta\ngamma delta';
  const tripled = { start: 12, end: 23, text: code };

  test('the blank first line of a text that opens with a break starts at 0', () => {
    expect(farUnit(code, 0, true, tripled)).toEqual([0, 0]);
  });

  test('every other paragraph, and offset 0 of text with no break first, unchanged', () => {
    expect(farUnit(code, 1, true, tripled)).toEqual([1, 11]);
    expect(farUnit(code, 5, true, tripled)).toEqual([1, 11]);
    expect(farUnit(code, 12, true, tripled)).toEqual([12, 23]);
    expect(farUnit('alpha\nbeta', 0, true, { start: 6, end: 10, text: 'alpha\nbeta' })).toEqual([
      0, 5,
    ]);
    // A blank line in the middle, taken with its break where the anchor's is.
    const mid = 'a\n\nb';
    expect(farUnit(mid, 2, true, { start: 0, end: 2, text: mid })).toEqual([2, 3]);
  });

  test('a word at offset 0 is the first word', () => {
    expect(farUnit('alpha beta', 0, false, { start: 6, end: 10, text: 'alpha beta' })).toEqual([
      0, 5,
    ]);
  });
});
