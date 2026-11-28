import { describe, expect, test } from 'vitest';

import type { RichText } from '../model/rich-text.ts';
import {
  richDelete,
  richConcat,
  richFromPlainText,
  richSetLink,
  richSetMark,
  richToPlainText,
} from '../model/rich-text.ts';
import {
  INLINE_SPAN_LIMIT,
  matchInlineRule,
  matchInlineRuleInRuns,
  matchTypedInlineRule,
} from './inline-rules.ts';
import { blocksFromMarkdown, parseInlineMarkdown } from './markdown.ts';

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

  // A span may cross a soft break, as in CommonMark: the writer keeps a marked
  // run with a line break in it whole, so the break keeps its mark (B11). A
  // delimiter against the break itself is still against whitespace.
  test('a span may cross a soft break, but not open or close against one', () => {
    expect(matchInlineRule('*a\nb*')?.mark).toBe('italic');
    expect(matchInlineRule('*a\n*')).toBe(null);
    expect(matchInlineRule('*\nb*')).toBe(null);
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

// The placeholder is the Markdown reader's. In typed text a NUL is a NUL: it is
// not stood in for, so a link is never made to a host the text does not hold.
test("a NUL in typed text is not read as the reader's placeholder", () => {
  const nul = String.fromCharCode(0);
  expect(matchInlineRule(`[x](https://bank${nul}.test/)`)).toBeNull();
  expect(
    matchInlineRule(`[x](https://bank${nul}.test/)`, { projection: true })?.link,
  ).toBeDefined();
});

// Typing reads the block's literal text, which can hold backticks a paste
// brought in escaped -- so the run pairing is pinned here, where it is
// reachable, rather than through the parser, which pairs a doubled run one
// backtick at a time before an autolink can see it.
describe('an autolink inside a code span left open', () => {
  test.each([
    // A single backtick does not close a double run.
    ['``a` <https://a.test/>', false],
    ['``a`` <https://a.test/>', true],
    ['`a` <https://a.test/>', true],
    ['`a <https://a.test/>', false],
    // Nor a longer run a shorter one.
    ['`a`` b` <https://a.test/>', true],
  ])('%j closes an autolink: %s', (text, closes) => {
    expect(matchInlineRule(text) !== null).toBe(closes);
  });
});

// The backtick-run refusal is about a backtick opener: `<code>` after a closed
// span opens whatever the run before its own backtick was.
test('a <code> tag after a closed code span', () => {
  expect(matchInlineRule('`a `<code>x</code>')).not.toBeNull();
});

describe('the delimiters are measured, not searched for', () => {
  /**
   * The opening length was `whole.indexOf(inner)`: the first place the inner
   * text occurs in the match. For `<u>u</u>` that is the `u` inside `<u>`, so
   * the offsets named the delimiter's `u` as the content and the content's
   * `u` as part of the closing delimiter. The plain text comes out the same
   * either way -- the two `u`s are the same character -- which is why it went
   * unnoticed; what differs is which one is deleted, and with it any
   * formatting the content already had.
   */
  test.each([
    ['<u>u</u>', 3, 4, 'underline'],
    ['<u>u>u</u>', 3, 4, 'underline'],
    ['<s>s</s>', 3, 4, 'strikethrough'],
    ['<em>e</em>', 4, 5, 'italic'],
    ['<em>m</em>', 4, 5, 'italic'],
    ['<strong>s</strong>', 8, 9, 'bold'],
    ['<strong>g</strong>', 8, 9, 'bold'],
    ['<code>c</code>', 6, 7, 'code'],
    ['<code>e</code>', 6, 7, 'code'],
  ])('%s strips exactly its own delimiters', (input, open, close, mark) => {
    expect(matchInlineRule(input)).toMatchObject({
      start: 0,
      end: input.length,
      openLength: open,
      closeLength: close,
      mark,
    });
  });

  test.each([
    ['<u>**u**</u>', 'u', ['bold', 'underline']],
    ['<s>**s**</s>', 's', ['bold', 'strikethrough']],
    ['<em>**e**</em>', 'e', ['bold', 'italic']],
    ['<strong>*s*</strong>', 's', ['bold', 'italic']],
    ['<code>**c**</code>', 'c', ['bold', 'code']],
  ])('formatting inside %s survives', (source, text, marks) => {
    // Typed or pasted, the inner span closes first, so the tag's content is an
    // already-marked letter. Taking the delimiter's letter for the content
    // deleted the marked one and gave the tag's mark to the plain one.
    const runs = blocksFromMarkdown(source)[0]?.content ?? [];

    expect(runs).toHaveLength(1);
    expect(runs[0]?.text).toBe(text);
    expect([...(runs[0]?.marks ?? [])].sort()).toEqual(marks);
  });

  test('a link whose label repeats in its destination', () => {
    expect(matchInlineRule('[ab](https://ab.test/)')).toMatchObject({
      start: 0,
      openLength: 1,
      closeLength: '](https://ab.test/)'.length,
    });
  });
});

describe('a destination is open only behind a label the link rule accepts', () => {
  /**
   * Inside an open `](` no emphasis closes (the F15 fix), but "open" was any
   * `](` at all, so marks were held off text that could never become a link:
   * a `](` with no `[` behind it, or with a `[` already closed by a `]`, or
   * with an empty label. The link rule needs `[`, at least one character that
   * is not `]`, then `](`; a hinge that fails that opens nothing.
   */
  test('a "[" closed by a "]" before the hinge opens no label', () => {
    expect(apply('ref [x] then f](g*h*')).toMatchObject({
      mark: 'italic',
      text: 'ref [x] then f](gh',
    });
  });

  test('a "[" right before the "]" opens an empty label, as the link rule reads it', () => {
    // The link rule opens a label at the last `[` before its `]`, so `[a[]`
    // and `[[]` are empty labels and their `](` can never become a link.
    expect(apply('[a[](x)')).toBeNull();
    expect(apply('[a[](**b**')).toMatchObject({ mark: 'bold', text: '[a[](b' });
    expect(apply('[[](**b**')).toMatchObject({ mark: 'bold', text: '[[](b' });
    expect(apply('[a[](x*y*')).toMatchObject({ mark: 'italic', text: '[a[](xy' });
  });

  test('an angled hinge with no label holds nothing open', () => {
    expect(matchInlineRule('see ](<**b**')).toMatchObject({ mark: 'bold' });
    expect(apply('[a[](<x**y**')).toMatchObject({ mark: 'bold', text: '[a[](<xy' });
  });

  test('an earlier hinge with a real label still holds the destination open', () => {
    // The nearest `](` has no label of its own, but a destination may hold a
    // `](`, and the one before it does have one.
    expect(matchInlineRule('[a](b](c*d*')).toBeNull();
  });

  test('a line of hinges whose labels never open stays linear', () => {
    // Every `](` here fails the label test and is passed over, so each mark
    // that closes walks back over every hinge it might be in. That walk is
    // bounded by the rule window, never by the line.
    const started = performance.now();
    const runs = blocksFromMarkdown(`[${'](*a*'.repeat(20000)}`)[0]?.content ?? [];

    // `[]` is an empty label, so none of these is a link and every `*a*` is
    // emphasis.
    expect(runs.filter((run) => run.marks?.includes('italic'))).toHaveLength(20000);
    expect(performance.now() - started).toBeLessThan(4000);
  });

  test('a hinge with a label still holds while typing', () => {
    expect(matchInlineRule('[t](https://a.test/_y_')).toBeNull();
    expect(matchInlineRule('[t](<https://a.test/**y**')).toBeNull();
    expect(matchInlineRule('**see [docs](x**')).toBeNull();
  });
});

describe('a code span closes only where the link rule could not', () => {
  // A backtick that begins inside a destination is part of the URL in
  // CommonMark. While typing, a destination is held open -- the `)` may be the
  // next key -- so a pair of backticks in one waits, as `_y_` already did.
  test('one opened inside a destination waits for it', () => {
    expect(matchInlineRule('[t](https://a.test/`x`')).toBeNull();
    expect(matchInlineRule('[t](<https://a.test/`x`')).toBeNull();
  });

  test('one opened before the destination still closes', () => {
    // The span binds tighter than the link: its `](` is code, not a hinge.
    expect(apply('Write `[label](`')).toMatchObject({ mark: 'code', text: 'Write [label](' });
    expect(apply('`[a](x`')).toMatchObject({ mark: 'code', text: '[a](x' });
  });

  test('one after a destination that has closed still closes', () => {
    expect(apply('[a](https://x.test/) `c`')).toMatchObject({ mark: 'code' });
  });
});

describe('pasted prose behind a destination that never closes keeps its marks', () => {
  /**
   * Typing cannot know whether the `)` is about to arrive, so it holds the
   * destination open. The Markdown reader can: it has the rest of the line,
   * and a `](` whose destination never closes on it is not a link, so the
   * prose after it is prose -- `**see [docs](x**` is bold in CommonMark.
   */
  test('a plain destination', () => {
    expect(blocksFromMarkdown('**see [docs](x**')[0]?.content).toEqual([
      { text: 'see [docs](x', marks: ['bold'] },
    ]);
    expect(blocksFromMarkdown('[a](b**c** d')[0]?.content).toEqual([
      { text: '[a](b' },
      { text: 'c', marks: ['bold'] },
      { text: ' d' },
    ]);
  });

  test('an escaped paren is part of the destination, not its end', () => {
    expect(blocksFromMarkdown('[a](b**c**\\) d')[0]?.content).toEqual([
      { text: '[a](b' },
      { text: 'c', marks: ['bold'] },
      { text: ') d' },
    ]);
  });

  test('an angled destination', () => {
    expect(blocksFromMarkdown('[a](<b**x**)')[0]?.content).toEqual([
      { text: '[a](<b' },
      { text: 'x', marks: ['bold'] },
      { text: ')' },
    ]);
    // A `>` with no `)` after it closes nothing.
    expect(blocksFromMarkdown('[a](<b**c**> x')[0]?.content).toEqual([
      { text: '[a](<b' },
      { text: 'c', marks: ['bold'] },
      { text: '> x' },
    ]);
  });

  test('a destination that does close stays literal', () => {
    expect(blocksFromMarkdown('[a](https://a.test/**y**) **z**')[0]?.content).toEqual([
      { text: 'a', link: 'https://a.test/**y**' },
      { text: ' ' },
      { text: 'z', marks: ['bold'] },
    ]);
    expect(blocksFromMarkdown('[a](<https://a.test/**y**>) **z**')[0]?.content).toEqual([
      { text: 'a', link: 'https://a.test/**y**' },
      { text: ' ' },
      { text: 'z', marks: ['bold'] },
    ]);
    // Balanced parentheses do not end it early.
    expect(blocksFromMarkdown('[a](https://a.test/(_y_)) x')[0]?.content).toEqual([
      { text: 'a', link: 'https://a.test/(_y_)' },
      { text: ' x' },
    ]);
  });

  test('the lookahead is linear in the length of the line', () => {
    // Answered from a table built once per line: asked by scanning forward at
    // every closer, a long destination that never closes cost its length
    // squared.
    const time = (n: number): number => {
      const source = `[a](${'x*'.repeat(n)}`;
      let best = Infinity;

      for (let run = 0; run < 3; run += 1) {
        const started = performance.now();
        blocksFromMarkdown(source);
        best = Math.min(best, performance.now() - started);
      }

      return Math.max(best, 0.1);
    };

    const small = time(5000);
    const large = time(40000);

    expect(large / small, `${Math.round(small)}ms -> ${Math.round(large)}ms`).toBeLessThan(25);
    // Over 5 s on a shared CI runner, every retry: the time a growth test
    // needs, as the others have it, not vitest's 5 s default.
  }, 60_000);
});

/**
 * What the editor does with each typed character: append it to the runs as
 * plain text (a finished span arms an empty mark set, so what follows is
 * plain) and apply whatever {@link matchTypedInlineRule} says.
 */
function typeInto(start: RichText, typed: string): RichText {
  let content = start;

  for (const char of typed) {
    const caret = richToPlainText(content).length;

    content = richConcat(content, richFromPlainText(char));
    const match = matchTypedInlineRule(content, caret + 1);

    if (!match) {
      continue;
    }

    const innerStart = match.start + match.openLength;
    const innerEnd = match.end - match.closeLength;

    content = richDelete(content, innerEnd, match.end);
    content = richDelete(content, match.start, innerStart);
    const end = match.start + (innerEnd - innerStart);

    content = match.link
      ? richSetLink(content, match.start, end, match.link)
      : richSetMark(content, match.start, end, match.mark!, true);
  }

  return content;
}

describe('nothing closes inside a code span left open', () => {
  /**
   * Only the HTML tag rules refused to close while a backtick run was open, so
   * the emphasis rules fired inside code before its closing backtick arrived:
   * `__init__` became bold `init` and `f(*a*)` lost its asterisks, typed and
   * pasted alike. A code span binds tighter than emphasis and links in
   * CommonMark; every rule now asks, as the tag rules did.
   */
  test("the auditor's line, pasted", () => {
    expect(parseInlineMarkdown('The `__init__` method and `f(*a*)`')).toEqual([
      { text: 'The ' },
      { text: '__init__', marks: ['code'] },
      { text: ' method and ' },
      { text: 'f(*a*)', marks: ['code'] },
    ]);
  });

  test('and typed', () => {
    expect(typeInto([], 'The `__init__` method and `f(*a*)`')).toEqual(
      parseInlineMarkdown('The `__init__` method and `f(*a*)`'),
    );
  });

  test.each([
    ['`__init__', null],
    ['`f(*a*', null],
    ['`**b**', null],
    ['`~~s~~', null],
    ['`[x](https://a.test/)', null],
    ['`<u>x</u>', null],
  ])('%s closes nothing', (text, expected) => {
    expect(matchInlineRule(text)).toBe(expected);
  });

  test.each([
    'Use `[text](https://x.test)` to link.',
    'Write `**bold**` for bold and `_it_` for italics.',
    'Images are `![alt](https://x.test/a.png)`.',
    'Run `npm i` then `[x](y)`.',
    'Use `<u>x</u>` for underline.',
    'Use `*args, **kwargs` here',
  ])('%s keeps its code literal', (line) => {
    const runs = parseInlineMarkdown(line);
    const code = /`([^`]+)`/g;

    expect(runs.filter((run) => run.marks?.includes('code')).map((run) => run.text)).toEqual(
      [...line.matchAll(code)].map((found) => found[1]),
    );
    expect(runs.every((run) => run.link === undefined)).toBe(true);
    expect(typeInto([], line)).toEqual(runs);
  });

  test('a closed code span opens the line again', () => {
    expect(apply('`a` **b**')).toMatchObject({ mark: 'bold' });
    expect(apply('`a` [x](https://a.test/)')).toMatchObject({ link: 'https://a.test/' });
  });
});

describe('an angled destination is not ended by a space', () => {
  /**
   * The `](<` form admits a space -- its rule's destination is `[^<>\n]*` --
   * but the test for "the caret is in an open destination" stopped at the
   * first one, so whatever followed it was prose: typing
   * `[t](<https://a.test/a b/**y**>)` linked to `…/a%20b/y`, and pasting
   * `__init__.py` behind a space lost both pairs of underscores. The 6 Nov
   * audit fixed this and the merge of `main` dropped it.
   */
  test('typing a destination does not fire a rule partway', () => {
    expect(matchInlineRule('[t](https://a.test/#object.__init__')).toBeNull();
    expect(matchInlineRule('[t](<https://a.test/a b/**y**')).toBeNull();
  });

  test('typed, the link keeps its asterisks', () => {
    expect(typeInto([], '[t](<https://a.test/a b/**y**>)')).toEqual([
      { text: 't', link: 'https://a.test/a%20b/**y**' },
    ]);
  });

  test.each(['https://a.test/(a)/__x__', 'https://a.test/a b/*y*'])(
    'in angle brackets: %s',
    (url) => {
      const href = blocksFromMarkdown(`[t](<${url}>)`)[0]?.content.find((run) => run.link)?.link;

      expect(href).toBe(url.replace(' ', '%20'));
    },
  );

  test("the auditor's paste", () => {
    expect(
      blocksFromMarkdown('See [docs](<https://a.test/my docs/__init__.py>)')[0]?.content,
    ).toEqual([{ text: 'See ' }, { text: 'docs', link: 'https://a.test/my%20docs/__init__.py' }]);
  });

  test('a "](<" that does close keeps its destination literal', () => {
    expect(blocksFromMarkdown('[t](<https://a.test/a b/**y**>) and **z**')[0]?.content).toEqual([
      { text: 't', link: 'https://a.test/a%20b/**y**' },
      { text: ' and ' },
      { text: 'z', marks: ['bold'] },
    ]);
  });

  test('a line break, a ">" or a "<" still ends it', () => {
    expect(apply('[a](<b c\n**d**')).toMatchObject({ mark: 'bold' });
    expect(apply('[a](<b c> **d**')).toMatchObject({ mark: 'bold' });
    expect(apply('[a](<b c <**d**')).toMatchObject({ mark: 'bold' });
  });
});

describe('a backtick inside an existing code run is not a delimiter', () => {
  /**
   * The literal scenario: type ``Use a`b``, select ``a`b``, Mod+E, then type
   * `` and `c` ok``. The code rule read the block's plain text, paired the
   * backtick inside the code run with the first one typed after it, and
   * deleted it: `ab and ` came out as code and `c` ok` as text.
   */
  const formatted: RichText = [{ text: 'Use ' }, { text: 'a`b', marks: ['code'] }];

  test('the first backtick typed after it closes nothing', () => {
    const content = [...formatted, { text: ' and `' }];

    expect(matchTypedInlineRule(content, richToPlainText(content).length)).toBeNull();
  });

  test('typed through to the end', () => {
    expect(typeInto(formatted, ' and `c` ok')).toEqual([
      { text: 'Use ' },
      { text: 'a`b', marks: ['code'] },
      { text: ' and ' },
      { text: 'c', marks: ['code'] },
      { text: ' ok' },
    ]);
  });

  test('pasted, a closed code span is as opaque', () => {
    expect(parseInlineMarkdown('Use <code>a`b</code> and `c` ok')).toEqual([
      { text: 'Use ' },
      { text: 'a`b', marks: ['code'] },
      { text: ' and ' },
      { text: 'c', marks: ['code'] },
      { text: ' ok' },
    ]);
  });

  test('a link across a code run takes its href from the real text', () => {
    const content: RichText = [
      { text: '[t](https://a.test/' },
      { text: 'x', marks: ['code'] },
      { text: ')' },
    ];

    expect(matchTypedInlineRule(content, richToPlainText(content).length)).toMatchObject({
      link: 'https://a.test/x',
    });
  });

  test('text with no code run is matched as it stands', () => {
    expect(matchTypedInlineRule(richFromPlainText('a **b**'), 7)).toEqual(
      matchInlineRule('a **b**'),
    );
  });
});

describe('a backtick run closes only the open run of its own length', () => {
  /**
   * The code rule matched a single backtick back to the nearest other one, so
   * in `` `` a`b `` `` the inner backtick closed a span with the second of the
   * opening pair at once: the code came out ` ab ` with the backtick moved out
   * after it, typed and pasted. Runs pair by length, as in CommonMark, and a
   * span opened by two or more strips one space from each end.
   */
  test.each([
    ['A literal backtick: `` a`b ``.', 'a`b'],
    ['x ``a`b`` y', 'a`b'],
    ['`` ` ``', '`'],
    ['```a``b```', 'a``b'],
  ])('%s holds %j', (line, code) => {
    const runs = parseInlineMarkdown(line);

    expect(runs.filter((run) => run.marks?.includes('code')).map((run) => run.text)).toEqual([
      code,
    ]);
    expect(typeInto([], line)).toEqual(runs);
  });

  test('a single backtick does not close a double run', () => {
    expect(matchInlineRule('``a`')).toBeNull();
    expect(matchInlineRule('`` a`b `')).toBeNull();
  });

  test('a single-backtick span keeps its spaces, as it always has', () => {
    expect(apply('` a `')).toEqual({ text: ' a ', mark: 'code', link: undefined });
  });

  test('a run of only spaces is not stripped', () => {
    expect(parseInlineMarkdown('``  ``')).toEqual([{ text: '  ', marks: ['code'] }]);
  });
});

describe('nothing closes inside a code span opened after its opener', () => {
  /**
   * Only a code span open *before* an emphasis opener held the emphasis back,
   * so one opened after it and still open at the closing delimiter let the
   * emphasis close inside the code: `` *y `a*b` z* `` came back
   * `y {italic}|a{italic,code}|b{code}| z*`, typed and pasted alike -- a star
   * and a backtick deleted and the span split in two. CommonMark reads it as
   * emphasis around a code span, and so does this, on both paths.
   */
  test.each([
    ['*y `a*b` z*', 'italic', 'y ', 'a*b', ' z'],
    ['**y `a**b` z**', 'bold', 'y ', 'a**b', ' z'],
    ['_a `b_c` d_', 'italic', 'a ', 'b_c', ' d'],
    ['~~a `b~~c` d~~', 'strikethrough', 'a ', 'b~~c', ' d'],
  ])('%s is %s around the code', (line, mark, before, code, after) => {
    const runs = parseInlineMarkdown(line);

    expect(runs).toEqual([
      { text: before, marks: [mark] },
      { text: code, marks: [mark, 'code'] },
      { text: after, marks: [mark] },
    ]);
    expect(typeInto([], line)).toEqual(runs);
  });

  test('a link whose "](" falls inside the open span takes the span whole', () => {
    const line = '[a `b](c)` d](https://e.com)';
    const runs = parseInlineMarkdown(line);

    expect(runs.find((run) => run.marks?.includes('code'))?.text).toBe('b](c)');
    expect(runs.every((run) => run.link === 'https://e.com/')).toBe(true);
    expect(typeInto([], line)).toEqual(runs);
  });

  test('a closer inside the open span closes nothing', () => {
    expect(matchInlineRule('*y `a*')).toBeNull();
    expect(matchInlineRule('**y `a**')).toBeNull();
    expect(matchInlineRule('<em>a `b</em>')).toBeNull();
  });

  // The README's stated costs, pinned so a change to either is a decision.
  test('a stray backtick holds back an emphasis opened before it', () => {
    expect(parseInlineMarkdown('*use ` with care*')).toEqual([{ text: '*use ` with care*' }]);
    expect(typeInto([], '*use ` with care*')).toEqual([{ text: '*use ` with care*' }]);
  });

  test('a single-backtick span closes on the first of a longer run (R2-PARSE-8)', () => {
    expect(parseInlineMarkdown('`a `` b`')).toEqual([{ text: 'a  b', marks: ['code'] }]);
    expect(typeInto([], '`a `` b`')).toEqual(parseInlineMarkdown('`a `` b`'));
  });

  test('an autolink still owns a backtick in its URL', () => {
    expect(apply('<https://a.test/`x>')).toMatchObject({ text: 'https://a.test/`x' });
  });
});

describe('an angled destination that never becomes a link holds its text', () => {
  /**
   * The reader asks whether an open `](<` closes later on the line, and
   * whitespace has to carry that answer through rather than reset it.
   * Resetting it left every other test green while `` [a](<b c *y* d>) e ``
   * turned `y` italic: the destination is no URL, so no link forms, but
   * everything inside it was still a destination while the reader decided.
   */
  test('the literal case', () => {
    expect(parseInlineMarkdown('[a](<b c *y* d>) e')).toEqual([{ text: '[a](<b c *y* d>) e' }]);
  });
});

describe("a code run's dollar, typed against", () => {
  const typed = (content: Array<{ text: string; marks?: Array<'code'> }>) =>
    matchInlineRuleInRuns(
      content,
      content.reduce((length, run) => length + run.text.length, 0),
    );

  // Audit round 2: `x$` formatted as code and `$y$` typed after it read as
  // `$$` -- display math -- in the plain text, and no formula came, where the
  // Markdown reader (`` `x$`$y$ ``) makes one.
  // Merge audit, 27 Nov: the TeX was read from the projection, where a code
  // run's characters are NULs, so the code run's text was lost from it.
  test('a formula typed around a code run takes its TeX from the text', () => {
    expect(typed([{ text: '$a ' }, { text: 'b', marks: ['code'] }, { text: '$' }])).toMatchObject({
      start: 0,
      end: 5,
      math: 'a b',
    });
  });

  test('a formula typed straight after a code run ending in a dollar closes', () => {
    expect(matchInlineRule('x$$y$')).toBeNull();
    expect(typed([{ text: 'x$', marks: ['code'] }, { text: '$y$' }])).toMatchObject({
      start: 2,
      end: 5,
      math: 'y',
    });
    expect(typed([{ text: '$', marks: ['code'] }, { text: '$y$' }])).toMatchObject({
      start: 1,
      math: 'y',
    });
  });

  test('a typed $$ outside code is still display math, not an opener', () => {
    expect(typed([{ text: 'x$$y$' }])).toBeNull();
    expect(typed([{ text: 'x$', marks: ['code'] }, { text: '$$y$' }])).toBeNull();
  });

  test("a code run's dollar opens nothing and is not reached back over", () => {
    expect(typed([{ text: '$a', marks: ['code'] }, { text: ',$' }])).toBeNull();
    expect(typed([{ text: '$b ' }, { text: 'a$', marks: ['code'] }, { text: 'c$' }])).toBeNull();
  });

  test('typing and pasting agree', () => {
    const [pasted] = blocksFromMarkdown('`x$`$y$');

    expect(pasted?.content).toEqual([
      { text: 'x$', marks: ['code'] },
      { text: '\uFFFC', math: 'y' },
    ]);
  });

  test('every other rule sees the code run as it is', () => {
    expect(typed([{ text: 'a$', marks: ['code'] }, { text: ' **b**' }])).toMatchObject({
      start: 3,
      mark: 'bold',
    });
  });
});

describe('a dollar typed into a code run', () => {
  // Audit round 3: typed DOM-first at the end of a code run, the `$` went
  // into the run, and the formula rule paired it with the `$` of a price
  // before the run and swallowed the run into a formula; the reader reads
  // the same model's Markdown, `` Pay \$5 with `^a$` ``, as text and code.
  test('is code, and closes no formula', () => {
    expect(
      matchInlineRuleInRuns([{ text: 'Pay $5 with ' }, { text: '^a$', marks: ['code'] }], 15),
    ).toBeNull();
  });

  test('a formula typed after a code run still closes', () => {
    expect(
      matchInlineRuleInRuns([{ text: 'a ' }, { text: '^a', marks: ['code'] }, { text: ' $y$' }], 8),
    ).toMatchObject({ start: 5, end: 8, math: 'y' });
  });
});

describe('a formula inside a link destination', () => {
  // Audit round 3: a finished formula in an angled destination was read as
  // part of the URL -- its atom percent-encoded, typed, or taken for a code
  // span's `$` by the reader. Its TeX is no URL's characters.
  test('makes no link', () => {
    expect(
      matchInlineRuleInRuns(
        [{ text: '[x](<https://a.test/p q ' }, { text: '￼', math: 'y' }, { text: '>)' }],
        27,
      ),
    ).toBeNull();
  });
});

describe('the formula rule and the destination rules, together', () => {
  /**
   * The math work taught the typed matcher (`matchInlineRuleInRuns`) about
   * formulas and code runs; the editor audit taught `matchInlineRule` which
   * `](` really opens a destination (a label behind it), and gave the reader a
   * look ahead along the line. A `$` asks the destination question too -- no
   * formula closes inside an open destination -- so each side's answer now
   * reaches the other's rule. These pin the combination, typed and pasted.
   */
  const typed = (runs: Array<{ text: string; marks?: Array<'code'> }>) =>
    matchInlineRuleInRuns(
      runs,
      runs.reduce((length, run) => length + run.text.length, 0),
    );

  test('a "](" with no label behind it holds no formula open, typed or pasted', () => {
    // TeX's half-open interval: `]0,1](` is no link, so the `$` closes.
    expect(typed([{ text: '$x \\in ]0,1]($' }])).toMatchObject({
      start: 0,
      math: 'x \\in ]0,1](',
    });
    expect(parseInlineMarkdown('$x \\in ]0,1]($')).toEqual([{ text: '￼', math: 'x \\in ]0,1](' }]);
    expect(typed([{ text: 'ref [x] then f]($y$' }])).toMatchObject({ start: 16, math: 'y' });
    expect(parseInlineMarkdown('ref [x] then f]($y$')).toEqual([
      { text: 'ref [x] then f](' },
      { text: '￼', math: 'y' },
    ]);
  });

  test('a labelled destination holds a typed formula open; the reader sees whether it closes', () => {
    // Typing cannot know whether the `)` is the next key, so the dollars wait
    // inside the destination, as `_y_` does. The reader has the line: a
    // destination that never closes on it is no link, and the formula is a
    // formula -- the typing/pasting divergence the look ahead documents.
    expect(typed([{ text: '[t](https://a.test/$y$' }])).toBeNull();
    expect(parseInlineMarkdown('[t](https://a.test/$y$ z')).toEqual([
      { text: '[t](https://a.test/' },
      { text: '￼', math: 'y' },
      { text: ' z' },
    ]);
    // One that does close is a URL, dollars and all.
    expect(parseInlineMarkdown('[t](https://a.test/$y$)')).toEqual([
      { text: 't', link: 'https://a.test/$y$' },
    ]);
  });

  test("a code span's dollar in an angled destination is the URL's own, typed or pasted", () => {
    // The angled destination holds its spaces open (`inOpenDestination`), so
    // pasted, a code span opened inside it closes nothing: the backticks are
    // the URL's own characters, and the projection never reaches the href.
    // (The 16 Nov merge audit read this as a span closing in the destination,
    // which the browser audit's angled rule does not let happen.) Typed, the
    // code run's text is the `$` alone, and the link closes on `)`.
    expect(
      typed([{ text: '[x](<https://a.test/p q ' }, { text: '$', marks: ['code'] }, { text: '>)' }]),
    ).toMatchObject({ start: 0, link: 'https://a.test/p%20q%20$' });
    expect(parseInlineMarkdown('[x](<https://a.test/p q `$`>)')).toEqual([
      { text: 'x', link: 'https://a.test/p%20q%20%60$%60' },
    ]);
  });

  test('a backtick pair typed inside a held destination is the URL, not a code span', () => {
    // The closer is a backtick, so this pins the editor audit's rule, not the
    // formula's: the `$` between them is the URL's, not a code span's.
    expect(typed([{ text: '[t](https://a.test/`$`' }])).toBeNull();
  });

  test('a destination or autolink opened inside the TeX holds nothing', () => {
    // Asked of the whole window, a `](` or `<http://` that the formula itself
    // holds kept it open: `$[0,1](x$)` -- an interval in parentheses -- lost
    // its formula on the `)` after it, typed or pasted, and the writer emits
    // exactly that. Only one opened before the formula's `$` holds it.
    expect(typed([{ text: '$[a](b$' }])).toMatchObject({ start: 0, math: '[a](b' });
    expect(parseInlineMarkdown('(see $[0,1](x$)')).toEqual([
      { text: '(see ' },
      { text: '\uFFFC', math: '[0,1](x' },
      { text: ')' },
    ]);
    expect(typed([{ text: '$a<http://b$' }])).toMatchObject({ start: 0, math: 'a<http://b' });
    expect(parseInlineMarkdown('$a<http://b$')).toEqual([{ text: '\uFFFC', math: 'a<http://b' }]);
    // One opened before the formula still holds its dollars as its own --
    // judged by where its label opens, not where its `](` is: the `[` of
    // `[Save $](…)` came first, so the link is the link.
    expect(typed([{ text: '[Save $](https://a.test/?q=$' }])).toBeNull();
    expect(parseInlineMarkdown('[Save $](https://a.test/?q=$)')).toEqual([
      { text: 'Save $', link: 'https://a.test/?q=$' },
    ]);
    expect(typed([{ text: '<https://a.test/$y$' }])).toBeNull();
    expect(typed([{ text: '[t](https://a.test/$y$' }])).toBeNull();
    expect(parseInlineMarkdown('[t](https://a.test/$y$)')).toEqual([
      { text: 't', link: 'https://a.test/$y$' },
    ]);
  });

  test('so does an angled destination opened inside the TeX', () => {
    // The angled form is answered on its own (`inOpenDestination`), held open
    // across spaces, and asked the same question: whose label opened first.
    expect(typed([{ text: '$[a](<b c$' }])).toMatchObject({ start: 0, math: '[a](<b c' });
    expect(parseInlineMarkdown('(see $[0,1](<x y$)')).toEqual([
      { text: '(see ' },
      { text: '\uFFFC', math: '[0,1](<x y' },
      { text: ')' },
    ]);
    expect(typed([{ text: '[Save $](<https://a.test/?q=$' }])).toBeNull();
    expect(parseInlineMarkdown('[Save $](<https://a.test/a b?q=$>)')).toEqual([
      { text: 'Save $', link: 'https://a.test/a%20b?q=$' },
    ]);
  });

  test('a label of formulas alone makes no link, and loses nothing', () => {
    // A formula takes no link, so the rule took the brackets and the URL and
    // the link then had nothing to hang on: only the formula was left.
    expect(typed([{ text: '[' }, { text: '\uFFFC' }, { text: '](https://a.test/)' }])).toBeNull();
    expect(parseInlineMarkdown('[$x$](https://a.test/)')).toEqual([
      { text: '[' },
      { text: '\uFFFC', math: 'x' },
      { text: '](https://a.test/)' },
    ]);
    // With any text beside it, the text is the link.
    expect(parseInlineMarkdown('[a $x$](https://a.test/)')).toEqual([
      { text: 'a ', link: 'https://a.test/' },
      { text: '\uFFFC', math: 'x' },
    ]);
  });

  test("a code span's bracket beside a paren is no hinge", () => {
    // `` [t`]`(x `` holds no `](` in the source, and the span's `]` is
    // projected away once it closes (`projectCode`), so no destination opens
    // there and the formula after it closes. (The 16 Nov merge audit, where a
    // closed span's text stayed visible, made the reader look ahead on any
    // line with a `]` and a `(` for this.)
    expect(parseInlineMarkdown('[t`]`(x$y$')).toEqual([
      { text: '[t' },
      { text: ']', marks: ['code'] },
      { text: '(x' },
      { text: '\uFFFC', math: 'y' },
    ]);
  });

  test('typed over a long block of code dollars and hinges, the matcher stays linear', () => {
    // `matchInlineRuleInRuns` reads the runs once per keystroke and the rules
    // only within their window, so eight times the block costs about eight
    // times as much: never the square.
    const runsOf = (n: number) => {
      const runs: Array<{ text: string; marks?: Array<'code'> }> = [];

      for (let index = 0; index < n; index += 1) {
        runs.push({ text: '[a](b ' }, { text: 'x$', marks: ['code'] });
      }

      runs.push({ text: ' $y$' });
      return runs;
    };
    const elapsed = (n: number): number => {
      const runs = runsOf(n);
      let best = Infinity;

      for (let run = 0; run < 3; run += 1) {
        const started = performance.now();

        for (let key = 0; key < 20; key += 1) {
          typed(runs);
        }

        best = Math.min(best, performance.now() - started);
      }

      return Math.max(best, 0.1);
    };

    expect(typed(runsOf(3))).toMatchObject({ math: 'y' });

    // Up to four readings, keeping the best ratio, as `growthOf` does: one
    // reading under the full parallel suite failed on linear code (570 ms at
    // the long size), and a quadratic matcher is over the bound on every one.
    let short = Infinity;
    let long = Infinity;

    for (let round = 0; round < 4 && !(long / short < 20); round += 1) {
      short = Math.min(short, elapsed(2000));
      long = Math.min(long, elapsed(16000));
    }

    expect(long / short, `${Math.round(short)}ms -> ${Math.round(long)}ms`).toBeLessThan(20);
  });
});

describe("the image mode is the reader's alone", () => {
  test('typing reads no picture and no badge', () => {
    // Without the option a link behind a `!` is a link match, which the reader
    // refuses and typing applies: a typed `![a](https://…)` is a `!` and a
    // link to that address, never a picture. Only the reader asks for one.
    const typed = matchInlineRule('see ![a](https://a.test/b.png)');

    expect(typed).toMatchObject({ start: 5, link: 'https://a.test/b.png' });
    expect(typed?.image).toBeUndefined();
    expect(matchInlineRule('see ![](https://a.test/b.png)')).toBeNull();
    expect(matchInlineRule('[﷖](https://a.test/)')?.badge).toBeUndefined();

    const read = matchInlineRule('see ![a](https://a.test/b.png)', { images: true });

    expect(read).toMatchObject({ start: 4, openLength: 2, image: true });
    expect(matchInlineRule('[﷖](LICENSE)', { images: true })?.badge).toBe(true);
  });
});
