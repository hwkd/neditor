import { describe, expect, test } from 'vitest';

import { sanitizeUrl } from '../util/url.ts';
import type { RichText } from './rich-text.ts';
import {
  cloneRichText,
  isRichEmpty,
  normalizeRuns,
  richActiveLink,
  richActiveMarks,
  richConcat,
  richDelete,
  richEquals,
  richFromPlainText,
  richInsert,
  richLength,
  richLinkAt,
  richMarksAt,
  richSetLink,
  richSetMark,
  richSlice,
  richSplit,
  richToPlainText,
  richToggleMark,
  sortMarks,
} from './rich-text.ts';

/** `Hello world` with `world` bold. */
const HELLO: RichText = [{ text: 'Hello ' }, { text: 'world', marks: ['bold'] }];

describe('normalizeRuns', () => {
  test('drops empty runs', () => {
    expect(normalizeRuns([{ text: '' }, { text: 'a' }, { text: '' }])).toEqual([{ text: 'a' }]);
  });

  test('merges adjacent runs with identical formatting', () => {
    expect(normalizeRuns([{ text: 'a' }, { text: 'b' }])).toEqual([{ text: 'ab' }]);
    expect(
      normalizeRuns([
        { text: 'a', marks: ['bold'] },
        { text: 'b', marks: ['bold'] },
      ]),
    ).toEqual([{ text: 'ab', marks: ['bold'] }]);
  });

  test('does not merge runs that differ in marks or link', () => {
    expect(normalizeRuns([{ text: 'a', marks: ['bold'] }, { text: 'b' }])).toHaveLength(2);
    expect(
      normalizeRuns([
        { text: 'a', link: 'https://a.test/' },
        { text: 'b', link: 'https://b.test/' },
      ]),
    ).toHaveLength(2);
  });

  test('marks are sorted and deduped, so equal formatting is deeply equal', () => {
    const a = normalizeRuns([{ text: 'x', marks: ['italic', 'bold', 'bold'] }]);
    const b = normalizeRuns([{ text: 'x', marks: ['bold', 'italic'] }]);

    expect(a).toEqual(b);
    expect(a[0]?.marks).toEqual(['bold', 'italic']);
  });

  test('an empty mark list is omitted rather than stored', () => {
    expect(normalizeRuns([{ text: 'x', marks: [] }])).toEqual([{ text: 'x' }]);
  });

  test('merging across a dropped empty run still collapses', () => {
    expect(normalizeRuns([{ text: 'a' }, { text: '' }, { text: 'b' }])).toEqual([{ text: 'ab' }]);
  });

  test('sortMarks is stable regardless of input order', () => {
    expect(sortMarks(['code', 'bold', 'italic'])).toEqual(['bold', 'italic', 'code']);
  });
});

describe('measurement and conversion', () => {
  test('plain text round-trips', () => {
    expect(richToPlainText(HELLO)).toBe('Hello world');
    expect(richLength(HELLO)).toBe(11);
    expect(richToPlainText(richFromPlainText('abc'))).toBe('abc');
  });

  test('empty text produces no runs', () => {
    expect(richFromPlainText('')).toEqual([]);
    expect(isRichEmpty([])).toBe(true);
    expect(isRichEmpty([{ text: '' }])).toBe(true);
    expect(isRichEmpty(HELLO)).toBe(false);
  });

  test('cloning severs shared references', () => {
    const clone = cloneRichText(HELLO);
    clone[0]!.text = 'changed';

    expect(HELLO[0]?.text).toBe('Hello ');
  });
});

describe('richEquals', () => {
  test('identical content compares equal', () => {
    expect(richEquals(HELLO, [{ text: 'Hello ' }, { text: 'world', marks: ['bold'] }])).toBe(true);
  });

  test('differing text, marks or link compare unequal', () => {
    expect(richEquals(HELLO, [{ text: 'Hello ' }, { text: 'worlds', marks: ['bold'] }])).toBe(
      false,
    );
    expect(richEquals(HELLO, [{ text: 'Hello ' }, { text: 'world', marks: ['italic'] }])).toBe(
      false,
    );
    expect(richEquals(HELLO, [{ text: 'Hello ' }, { text: 'world' }])).toBe(false);
    expect(
      richEquals(
        [{ text: 'a', link: 'https://a.test/' }],
        [{ text: 'a', link: 'https://b.test/' }],
      ),
    ).toBe(false);
  });

  test('different run counts compare unequal', () => {
    expect(richEquals(HELLO, [{ text: 'Hello world' }])).toBe(false);
    expect(richEquals([], HELLO)).toBe(false);
    expect(richEquals([], [])).toBe(true);
  });
});

describe('richSlice', () => {
  test('slices within a single run', () => {
    expect(richSlice(HELLO, 0, 5)).toEqual([{ text: 'Hello' }]);
  });

  test('slices across a run boundary, preserving marks', () => {
    expect(richSlice(HELLO, 4, 8)).toEqual([{ text: 'o ' }, { text: 'wo', marks: ['bold'] }]);
  });

  test('clamps out-of-range offsets', () => {
    expect(richSlice(HELLO, -10, 999)).toEqual(HELLO);
    expect(richSlice(HELLO, 5, 5)).toEqual([]);
    expect(richSlice(HELLO, 8, 3)).toEqual([]);
  });

  test('a slice of the whole range equals the input', () => {
    expect(richSlice(HELLO, 0, richLength(HELLO))).toEqual(HELLO);
  });
});

describe('splice operations', () => {
  test('split produces two halves that concatenate back', () => {
    const [left, right] = richSplit(HELLO, 6);

    expect(richToPlainText(left)).toBe('Hello ');
    expect(richToPlainText(right)).toBe('world');
    expect(richConcat(left, right)).toEqual(HELLO);
  });

  test('insert keeps the inserted formatting distinct', () => {
    const result = richInsert(HELLO, 6, richFromPlainText('big ', ['italic']));

    expect(richToPlainText(result)).toBe('Hello big world');
    expect(result[1]).toEqual({ text: 'big ', marks: ['italic'] });
  });

  test('inserting matching formatting merges instead of fragmenting', () => {
    const result = richInsert(HELLO, 11, richFromPlainText('!', ['bold']));

    expect(result).toEqual([{ text: 'Hello ' }, { text: 'world!', marks: ['bold'] }]);
  });

  test('delete removes a range and rejoins the sides', () => {
    expect(richDelete(HELLO, 5, 6)).toEqual([
      { text: 'Hello' },
      { text: 'world', marks: ['bold'] },
    ]);
  });

  test('deleting an entire run leaves the neighbours merged', () => {
    const content: RichText = [{ text: 'a' }, { text: 'B', marks: ['bold'] }, { text: 'c' }];

    expect(richDelete(content, 1, 2)).toEqual([{ text: 'ac' }]);
  });

  test('concat merges compatible runs at the seam', () => {
    expect(richConcat([{ text: 'ab' }], [{ text: 'cd' }])).toEqual([{ text: 'abcd' }]);
  });
});

describe('marks', () => {
  test('setting a mark splits runs exactly at the range', () => {
    const result = richSetMark(richFromPlainText('abcdef'), 2, 4, 'bold', true);

    expect(result).toEqual([{ text: 'ab' }, { text: 'cd', marks: ['bold'] }, { text: 'ef' }]);
  });

  test('removing a mark rejoins the surrounding runs', () => {
    const bolded = richSetMark(richFromPlainText('abcdef'), 2, 4, 'bold', true);

    expect(richSetMark(bolded, 2, 4, 'bold', false)).toEqual([{ text: 'abcdef' }]);
  });

  test('marks compose without clobbering each other', () => {
    let content = richSetMark(richFromPlainText('abcd'), 0, 4, 'bold', true);
    content = richSetMark(content, 1, 3, 'italic', true);

    expect(content).toEqual([
      { text: 'a', marks: ['bold'] },
      { text: 'bc', marks: ['bold', 'italic'] },
      { text: 'd', marks: ['bold'] },
    ]);
  });

  test('activeMarks reports only marks shared by the whole range', () => {
    const content = richSetMark(richFromPlainText('abcd'), 0, 2, 'bold', true);

    expect(richActiveMarks(content, 0, 2)).toEqual(['bold']);
    expect(richActiveMarks(content, 0, 4)).toEqual([]);
    expect(richActiveMarks(content, 2, 4)).toEqual([]);
  });

  test('a partially marked range toggles on rather than off', () => {
    // "ab" bold, "cd" plain. Toggling 0..4 must bold everything.
    const partial = richSetMark(richFromPlainText('abcd'), 0, 2, 'bold', true);
    const toggled = richToggleMark(partial, 0, 4, 'bold');

    expect(toggled).toEqual([{ text: 'abcd', marks: ['bold'] }]);
    expect(richActiveMarks(toggled, 0, 4)).toEqual(['bold']);
  });

  test('a fully marked range toggles off', () => {
    const full = richSetMark(richFromPlainText('abcd'), 0, 4, 'bold', true);

    expect(richToggleMark(full, 0, 4, 'bold')).toEqual([{ text: 'abcd' }]);
  });

  test('an empty range is a no-op', () => {
    expect(richSetMark(HELLO, 3, 3, 'bold', true)).toEqual(HELLO);
    expect(richToggleMark(HELLO, 3, 3, 'bold')).toEqual(HELLO);
  });

  test('marksAt inherits formatting from the character to the left', () => {
    expect(richMarksAt(HELLO, 11)).toEqual(['bold']);
    expect(richMarksAt(HELLO, 6)).toEqual([]);
    expect(richMarksAt(HELLO, 0)).toEqual([]);
  });
});

describe('links', () => {
  const linked = richSetLink(richFromPlainText('see docs here'), 4, 8, 'https://example.test/');

  test('a link applies to exactly the selected range', () => {
    expect(linked).toEqual([
      { text: 'see ' },
      { text: 'docs', link: 'https://example.test/' },
      { text: ' here' },
    ]);
  });

  test('a link coexists with marks', () => {
    const bolded = richSetMark(linked, 4, 8, 'bold', true);

    expect(bolded[1]).toEqual({
      text: 'docs',
      marks: ['bold'],
      link: 'https://example.test/',
    });
  });

  test('clearing a link rejoins the text', () => {
    expect(richSetLink(linked, 4, 8, null)).toEqual([{ text: 'see docs here' }]);
  });

  test('activeLink requires the whole range to share one href', () => {
    expect(richActiveLink(linked, 4, 8)).toBe('https://example.test/');
    expect(richActiveLink(linked, 0, 8)).toBe(null);
    expect(richLinkAt(linked, 5)).toBe('https://example.test/');
    expect(richLinkAt(linked, 0)).toBe(null);
  });

  test('a link is not inherited by text typed after it', () => {
    // marksAt returns marks only; the link deliberately stops at the boundary.
    const typed = richInsert(linked, 8, richFromPlainText('!', richMarksAt(linked, 8)));

    expect(typed[2]).toEqual({ text: '! here' });
  });
});

describe('sanitizeUrl', () => {
  test.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>',
    'vbscript:x',
  ])('rejects %s', (input: string) => {
    expect(sanitizeUrl(input)).toBe(null);
  });

  test('rejects empty input', () => {
    expect(sanitizeUrl('   ')).toBe(null);
  });

  test('assumes https for a bare host', () => {
    expect(sanitizeUrl('example.com/docs')).toBe('https://example.com/docs');
  });

  test('preserves safe schemes', () => {
    expect(sanitizeUrl('http://a.test/')).toBe('http://a.test/');
    expect(sanitizeUrl('mailto:hi@a.test')).toBe('mailto:hi@a.test');
  });

  test('passes through relative and in-page links', () => {
    expect(sanitizeUrl('/docs')).toBe('/docs');
    expect(sanitizeUrl('#section')).toBe('#section');
  });
});
