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
    ['<u>u</u>', 'u'],
    ['<u>u>u</u>', 'u>u'],
    ['<u>></u>', '>'],
  ])('%s strips exactly its own delimiters', (input, inner) => {
    expect(matchInlineRule(input)).toMatchObject({
      start: 0,
      end: input.length,
      openLength: 3,
      closeLength: 4,
      mark: 'underline',
    });
    expect(input.slice(3, input.length - 4)).toBe(inner);
  });

  test('formatting inside an underline whose text starts like its tag survives', () => {
    // Typed or pasted, `**u**` closes first, so the underline's content is an
    // already-bold `u`. Taking the delimiter's `u` for the content deleted the
    // bold one and underlined the plain one.
    expect(blocksFromMarkdown('<u>**u**</u>')[0]?.content).toEqual([
      { text: 'u', marks: ['bold', 'underline'] },
    ]);
  });

  test('a link whose label repeats in its destination', () => {
    // `[t](t)`: the label occurs first, but a destination holding the label's
    // text before the label itself cannot, so pin the offsets outright.
    expect(matchInlineRule('[ab](https://ab.test/)')).toMatchObject({
      start: 0,
      openLength: 1,
      closeLength: '](https://ab.test/)'.length,
    });
  });
});

describe('a link destination is literal', () => {
  /**
   * Every rule fires the moment its closing delimiter is typed, and a link
   * only closes on its final `)` -- so a destination still being typed was
   * ordinary text to the emphasis rules, and `#object.__init__` became
   * `#object.init` with `init` in bold before the link existed. CommonMark
   * gives a destination no emphasis at all, and neither does this now: while
   * the caret is inside an open `](`, no mark rule fires.
   */
  const destination = (url: string): string | undefined =>
    blocksFromMarkdown(`[t](${url})`)[0]?.content.find((run) => run.link)?.link;

  test.each([
    'https://docs.python.org/3/reference/datamodel.html#object.__init__',
    'https://a.test/**y**',
    'https://a.test/*y*',
    'https://a.test/_x_',
    'https://a.test/__x__',
    'https://a.test/~~x~~',
  ])('%s', (url) => {
    expect(destination(url)).toBe(url);
  });

  test('a code span in a destination is not one either', () => {
    // The sanitizer percent-encodes the backticks; what matters is that they
    // are still there to encode, rather than spent as a code span.
    expect(destination('https://a.test/`x`')).toBe('https://a.test/%60x%60');
  });

  test.each(['https://a.test/(a)/__x__', 'https://a.test/a b/*y*'])(
    'in angle brackets: %s',
    (url) => {
      const href = blocksFromMarkdown(`[t](<${url}>)`)[0]?.content.find((run) => run.link)?.link;

      expect(href).toBe(url.replace(' ', '%20'));
    },
  );

  test('typing a destination does not fire a rule partway', () => {
    expect(matchInlineRule('[t](https://a.test/#object.__init__')).toBeNull();
    expect(matchInlineRule('[t](<https://a.test/a b/**y**')).toBeNull();
  });

  test('emphasis after a closed link, or outside one, still fires', () => {
    expect(apply('[t](https://a.test/) **b**')).toMatchObject({ mark: 'bold' });
    expect(apply('see ](x) **b**')).toMatchObject({ mark: 'bold' });
    expect(apply('[t](x and **b**')).toMatchObject({ mark: 'bold' });
    expect(apply('[t](<x> **b**')).toMatchObject({ mark: 'bold' });
    expect(apply('**b**')).toMatchObject({ mark: 'bold' });
  });

  test('a label is not a destination', () => {
    expect(blocksFromMarkdown('[**b**](https://a.test/)')[0]?.content).toEqual([
      { text: 'b', marks: ['bold'], link: 'https://a.test/' },
    ]);
  });
});

describe('a destination is open only where a link pattern could still close it', () => {
  /**
   * The test for "the caret is inside a link destination" was looser than the
   * patterns it stands in for. Any earlier `[` counted as the label's opener,
   * even one an intervening `]` or line break had already closed; a `](`
   * inside the very code span being closed counted, although a code span binds
   * tighter than a link; and an angle-bracketed destination stayed open across
   * a `<` it cannot hold, and across any amount of prose behind a `](<` that
   * never closes. Each of those suppressed a mark the text really had.
   */
  test('a code span holding "[label](" is code', () => {
    expect(matchInlineRule('Write `[label](`')).toMatchObject({ start: 6, mark: 'code' });
    expect(blocksFromMarkdown('Start a link with `[text](` and close it')[0]?.content).toEqual([
      { text: 'Start a link with ' },
      { text: '[text](', marks: ['code'] },
      { text: ' and close it' },
    ]);
  });

  test('a code span opened inside a destination is still part of it', () => {
    expect(matchInlineRule('[t](https://a.test/`x`')).toBeNull();
  });

  test('a "[" closed by a "]" before the hinge opens no label', () => {
    expect(apply('ref [x] then f](g*h*')).toMatchObject({
      mark: 'italic',
      text: 'ref [x] then f](gh',
    });
  });

  test('a "[" on an earlier line opens no label', () => {
    expect(apply('[a\nb](c*d*')).toMatchObject({ mark: 'italic', text: '[a\nb](cd' });
  });

  test('an earlier hinge with a real label still holds the destination open', () => {
    // The nearest `](` has no label of its own, but the destination of the one
    // before it may hold a `](`.
    expect(matchInlineRule('[a](b](c*d*')).toBeNull();
  });

  test('a "[" right before the "]" opens an empty label, as the link rule reads it', () => {
    // The link rule opens a label at the last `[` before its `]`, so `[a[]`
    // and `[[]` are empty labels and their `](` can never become a link. The
    // destination test counted the earlier `[` instead, and held marks off a
    // destination that could never exist.
    expect(apply('[a[](x)')).toBeNull();
    expect(apply('[a[](**b**')).toMatchObject({ mark: 'bold', text: '[a[](b' });
    expect(apply('[[](**b**')).toMatchObject({ mark: 'bold', text: '[[](b' });
    expect(apply('[a[](x*y*')).toMatchObject({ mark: 'italic', text: '[a[](xy' });
    // The angled hinge asks the same question.
    expect(apply('[a[](<x **y**')).toMatchObject({ mark: 'bold', text: '[a[](<x y' });
  });

  test('an angle-bracketed destination ends at a "<"', () => {
    expect(apply('[a](<b <c **d**')).toMatchObject({ mark: 'bold' });
  });

  test('pasted prose behind a "](<" that never closes keeps its marks', () => {
    expect(blocksFromMarkdown('Use [a](<b to open, then **bold** later')[0]?.content).toEqual([
      { text: 'Use [a](<b to open, then ' },
      { text: 'bold', marks: ['bold'] },
      { text: ' later' },
    ]);
  });

  test('an escaped ">" does not close the destination', () => {
    expect(blocksFromMarkdown('[a](<b **c** \\>) x')[0]?.content).toEqual([
      { text: '[a](<b ' },
      { text: 'c', marks: ['bold'] },
      { text: ' >) x' },
    ]);
  });

  test('a "](<" that does close keeps its destination literal', () => {
    const href = blocksFromMarkdown('[t](<https://a.test/a b/**y**>) and **z**')[0]?.content;

    expect(href).toEqual([
      { text: 't', link: 'https://a.test/a%20b/**y**' },
      { text: ' and ' },
      { text: 'z', marks: ['bold'] },
    ]);
  });

  test('an angled hinge with no label holds nothing open', () => {
    // `](<` is a destination only after a label the link pattern accepts.
    expect(matchInlineRule('see ](<**b**')).toMatchObject({ mark: 'bold' });
  });

  test('a ">" with no ")" after it does not close the destination', () => {
    expect(blocksFromMarkdown('[a](<b **c**> x')[0]?.content).toEqual([
      { text: '[a](<b ' },
      { text: 'c', marks: ['bold'] },
      { text: '> x' },
    ]);
  });

  test('a ">)" on the next line does not close the destination', () => {
    // An angled destination is one line, so the break ends it unclosed.
    expect(blocksFromMarkdown('[a](<b **c**\\\nd>)')[0]?.content).toEqual([
      { text: '[a](<b ' },
      { text: 'c', marks: ['bold'] },
      { text: '\nd>)' },
    ]);
  });

  test('pasted prose behind a plain "](" that never closes keeps its marks', () => {
    // A plain destination ends at the first `)` or whitespace. When that is
    // not a `)`, the hinge opens no link, and CommonMark reads the bold.
    expect(blocksFromMarkdown('**see [docs](x**')[0]?.content).toEqual([
      { text: 'see [docs](x', marks: ['bold'] },
    ]);
    expect(blocksFromMarkdown('[a](b**c** d')[0]?.content).toEqual([
      { text: '[a](b' },
      { text: 'c', marks: ['bold'] },
      { text: ' d' },
    ]);
    // An escaped paren is part of the destination, not its end.
    expect(blocksFromMarkdown('[a](b**c**\\) d')[0]?.content).toEqual([
      { text: '[a](b' },
      { text: 'c', marks: ['bold'] },
      { text: ') d' },
    ]);
  });

  test('a plain destination that does close keeps it literal', () => {
    expect(blocksFromMarkdown('[a](https://a.test/**y**) **z**')[0]?.content).toEqual([
      { text: 'a', link: 'https://a.test/**y**' },
      { text: ' ' },
      { text: 'z', marks: ['bold'] },
    ]);
  });

  test('while typing, a plain destination is still held open', () => {
    expect(matchInlineRule('**see [docs](x**')).toBeNull();
  });

  test('while typing, an angled destination is still held open', () => {
    // At the keystroke there is no telling whether a `>)` will follow, and the
    // destination of a typed link may hold a space.
    expect(matchInlineRule('Use [a](<b to open, then **bold**')).toBeNull();
  });
});

describe('a plain destination does not begin with "<"', () => {
  /**
   * A `<` after `](` opens the bracketed form, and CommonMark's plain form
   * excludes it as a first character, so a bracketed destination that has not
   * closed is not a plain one either. Typing `[a](<u@x.test)` made a link to
   * `https://%3Cu@x.test/` on the `)`, which the user meant as part of the URL.
   */
  test('the ")" of an unfinished bracketed destination closes nothing', () => {
    expect(matchInlineRule('[a](<u@x.test)')).toBeNull();
    expect(matchInlineRule('[call](<mailto:a@x.test?subject=Re:%20(draft)')).toBeNull();
  });

  test('the bracketed destination still closes on ">)"', () => {
    expect(apply('[call](<mailto:a@x.test?subject=Re:%20(draft)>)')).toEqual({
      text: 'call',
      mark: undefined,
      link: 'mailto:a@x.test?subject=Re:%20(draft)',
    });
  });

  test('while typing, a "](" inside an unfinished bracketed destination waits', () => {
    // The same hold as for marks: the `>)` that makes the inner pair part of
    // the URL may be the next thing typed. Firing here replaced the user's
    // half-typed `[see](<https://x.test/?q=[foo](https://y.test/)` with a link
    // to y.test before they could finish the outer one.
    expect(matchInlineRule('[a](<x[b](https://y.test/)')).toBeNull();
    expect(matchInlineRule('[see](<https://x.test/?q=[foo](https://y.test/)')).toBeNull();
  });

  test('a later "](" is a link of its own once the line says the bracket never closes', () => {
    expect(blocksFromMarkdown('[a](<x[b](https://y.test/)')[0]?.content).toEqual([
      { text: '[a](<x' },
      { text: 'b', link: 'https://y.test/' },
    ]);
  });
});
