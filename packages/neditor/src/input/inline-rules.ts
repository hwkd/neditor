import type { Mark, RichText } from '../model/rich-text.ts';
import { sanitizeUrl } from '../util/url.ts';

/**
 * Inline Markdown rules.
 *
 * These fire the moment the closing delimiter is typed, so `**word**` becomes
 * bold text as you finish it rather than on a later pass. A rule reports
 * *offsets* rather
 * than replacement text, so the editor can strip the delimiters and apply the
 * mark while leaving any formatting already inside the span intact.
 */

interface InlineRule {
  /**
   * The last character of the rule's closing delimiter.
   *
   * Every pattern is anchored at the caret with `$`, which in JavaScript is
   * the end of the string and nothing else, so the character there has to be
   * this one. Checking it first is what stops the link patterns from being run
   * over text with no `)` in it at all — on a long line of unpaired brackets
   * they spend the length of the window on every keystroke.
   */
  readonly closer: string;
  /** Anchored at the caret. Capture group 1 is the inner text. */
  readonly pattern: RegExp;
  /**
   * The length of the opening delimiter, which group 1 follows directly.
   *
   * Measured rather than searched for: the inner text's first occurrence in
   * the match is not always where it starts. In `<u>u</u>` it is the tag's
   * own `u`, so the offsets deleted the content's `u` -- and with it whatever
   * formatting it had, which is how a bold, underlined run came back from
   * `<u>**u**</u>` underlined only.
   */
  readonly open: number;
  readonly mark?: Mark;
  /** Capture group 2 is the href. */
  readonly isLink?: boolean;
  /** The `](<…>)` form, whose destination is delimited rather than run-length. */
  readonly angled?: boolean;
  /**
   * `<https://…>`. While one is open nothing closes inside it but a code span
   * that opened before its `<`.
   */
  readonly autolink?: boolean;
}

/**
 * An emphasis body: at least one character, and neither end whitespace.
 *
 * This is the part of CommonMark's flanking rule that matters here. Without it
 * an opening delimiter followed by a space, or a closing one preceded by a
 * space, still matched -- so ordinary prose lost the characters the user typed.
 * `3 * 4 * 5` became `3  4  5` with " 4 " in italics, `SELECT * FROM a; SELECT
 * * FROM b` lost both asterisks, and `use _id and _rev fields` came out as
 * `use id and rev fields`. Every one of those is literal text in every
 * Markdown reader, and this fires on each keystroke, so the characters
 * disappeared as they were typed.
 *
 * Written per delimiter because the class has to exclude that delimiter too.
 * A span may cross a soft break, as it may in CommonMark: the writer keeps a
 * run with a line break in it whole, so the break keeps the run's mark.
 */
const body = (delimiter: string): string =>
  `([^${delimiter}\\s](?:[^${delimiter}]*[^${delimiter}\\s])?)`;

const INLINE_RULES: readonly InlineRule[] = [
  // Bold before italic: `**x**` must not be read as an italic `*x*`.
  { closer: '*', pattern: new RegExp(`\\*\\*${body('*')}\\*\\*$`), open: 2, mark: 'bold' },
  { closer: '_', pattern: new RegExp(`__${body('_')}__$`), open: 2, mark: 'bold' },
  // Only the opening `*` of a longer run is refused, so `***x***` closes as
  // bold and then as italic. A word character before it is not a reason to
  // refuse: CommonMark restricts intra-word emphasis to `_`, and `toMarkdown`
  // writes `*x*` whatever precedes it, so refusing left `Chapter*One*` sitting
  // in the text as literal asterisks.
  { closer: '*', pattern: new RegExp(`(?<!\\*)\\*${body('*')}\\*$`), open: 1, mark: 'italic' },
  { closer: '_', pattern: new RegExp(`(?<![_\\w])_${body('_')}_$`), open: 1, mark: 'italic' },
  { closer: '~', pattern: new RegExp(`~~${body('~')}~~$`), open: 2, mark: 'strikethrough' },
  // Backticks deliberately keep their spaces: a code span is delimited by
  // backtick runs rather than by flanking, so `` ` a ` `` really is code in
  // CommonMark. Emphasis is the construct with the flanking rule. Matched by
  // `codeSpanAt`, which pairs runs by length; the pattern is the shape of its
  // single-backtick case.
  { closer: '`', pattern: /`([^`]+)`$/, open: 1, mark: 'code' },
  // Markdown has no underline, so `toMarkdown` writes the HTML tag; this is
  // what reads it back rather than leaving seven junk characters in the text.
  { closer: '>', pattern: /<u>([^<]+)<\/u>$/, open: 3, mark: 'underline' },
  // `toMarkdown` writes a marked run whose text starts or ends with whitespace
  // as HTML: `**bold **` is not emphasis in any dialect, and `a**bold&#32;**b`
  // is literal asterisks in CommonMark (the closer is not right-flanking), but
  // any reader that allows inline HTML renders `a<strong>bold </strong>b` as
  // written.
  { closer: '>', pattern: /<strong>([^<]+)<\/strong>$/, open: 8, mark: 'bold' },
  { closer: '>', pattern: /<em>([^<]+)<\/em>$/, open: 4, mark: 'italic' },
  { closer: '>', pattern: /<s>([^<]+)<\/s>$/, open: 3, mark: 'strikethrough' },
  { closer: '>', pattern: /<code>([^<]+)<\/code>$/, open: 6, mark: 'code' },
  // An autolink is the URL it holds, as plain text: the writer spells a bare
  // URL this way so that nothing written against it joins it in GFM. Not the
  // `](<…>)` of a destination, which is a link's own spelling.
  // Never one whose `<` follows another: once the inner one closed, its URL
  // would stand behind the outer `<` and the second `>` would close it again,
  // taking both outer brackets (`<<https://a.test/>>`).
  { closer: '>', pattern: /(?<!\]\(|<)<(https?:\/\/[^\s<>]*)>$/i, open: 1, autolink: true },
  // The angle-bracket form first: it is how a destination holding a `)` — the
  // character that would otherwise close the link — is written.
  {
    closer: ')',
    pattern: /\[([^\]]+)\]\(<([^<>\n]*)>\)$/,
    open: 1,
    isLink: true,
    angled: true,
  },
  // Never one that opens with `<`: that is the form above, not yet closed. Its
  // destination may hold a `)`, and this rule fired at it --
  // `[x](<mailto:a@b.test?s=(v2)>)` linked to `https://%3Cmailto:a@b.test/…`.
  // It may hold balanced parentheses, as CommonMark allows: Wikipedia's
  // `…/Foo_(bar)` ended at the first `)`. `linkOpener` finds the `](` whose
  // `(` the closing one balances, so the pattern only has to match from there.
  { closer: ')', pattern: /^\[([^\]]+)\]\(([^\s<][^\s]*)\)$/, open: 1, isLink: true },
];

/**
 * How far back from the caret a rule may reach.
 *
 * Every pattern is anchored at the caret, so an unbounded scan costs the length
 * of the block on each keystroke — and on each character of a paste, which made
 * parsing a long line quadratic. A span longer than this is not emphasis anyone
 * typed, and the previous answer to the cost was worse: lines past a couple of
 * thousand characters were not parsed at all and kept their raw `**` markup.
 */
export const INLINE_SPAN_LIMIT = 2000;

/**
 * What can open a bare URL, for the writer (`bareUrls` in `model/document.ts`).
 *
 * Deliberately looser than the reader's `BARE_URL_IN_TOKEN`, which also asks
 * what comes before: the writer only uses it to leave a `_` between two letters
 * or digits bare, and that one cannot open a span in any reader whether or not
 * a URL is there.
 */
export const BARE_URL_START = /https?:\/\/|www\./i;

/** `\s`, by character code: the scans below ask it of every character they pass. */
function isSpace(code: number): boolean {
  return (
    code === 32 || (code >= 9 && code <= 13) || (code > 127 && /\s/.test(String.fromCharCode(code)))
  );
}

/** Whether a destination's parentheses balance, never closing more than opened. */
function balancedParens(destination: string): boolean {
  let depth = 0;

  for (let at = 0; at < destination.length; at += 1) {
    const code = destination.charCodeAt(at);

    if (code === 40) {
      depth += 1;
    } else if (code === 41 && --depth < 0) {
      return false;
    }
  }

  return depth === 0;
}

/**
 * The length of the backtick run the text leaves open, or 0 if none: runs
 * pair as in CommonMark, an open run closed only by one of the same length.
 * Showing autolink syntax in code -- `` `<https://example.com>` `` -- lost its
 * brackets without this, and counting single backticks lost them again inside
 * a double-backtick span, whose two runs make an even count.
 *
 * Only what is behind the caret is known, so a run whose closer never arrives
 * still reads as open here.
 */
function openCodeRun(text: string, before: number = text.length): number {
  return openCodeRunAt(text, before).length;
}

/** {@link openCodeRun}, with where the open run starts (-1 when none is open). */
function openCodeRunAt(
  text: string,
  before: number = text.length,
): { readonly at: number; readonly length: number } {
  let open = 0;
  let openAt = -1;
  let at = text.indexOf('`');

  while (at !== -1 && at < before) {
    let end = at;

    while (end < before && text.charCodeAt(end) === 96) {
      end += 1;
    }

    if (open === 0) {
      open = end - at;
      openAt = at;
    } else if (end - at === open) {
      open = 0;
      openAt = -1;
    }

    at = end < before ? text.indexOf('`', end) : -1;
  }

  return { at: openAt, length: open };
}

/**
 * Whether the text ends inside an autolink whose `>` has not arrived.
 *
 * Its text is the URL as it stands, so no span closes in it but a code span
 * that opened before its `<`: `<https://a/*x*>` would otherwise lose its
 * asterisks a character before the `>` arrived.
 */
function inOpenAutolink(window: string): boolean {
  const at = window.lastIndexOf('<');

  return at !== -1 && /^<https?:\/\/[^\s<>]*$/i.test(window.slice(at));
}

/**
 * Where the label opens that the `]` at `close` ends, if the link patterns
 * accept one there; -1 if not.
 *
 * Both spell a label `\[([^\]]+)\]`, and {@link linkOpener} starts them at the
 * last `[` before the `]`: so the label opens there, holds no `]`, and is at
 * least one character long -- `[a[]` and `[[]` are empty labels, exactly as
 * `[]` is. Stops at the first `]` behind the hinge, so the label scans of
 * successive hinges never cover the same text twice.
 */
function labelStart(window: string, close: number): number {
  for (let at = close - 1; at >= 0; at -= 1) {
    const code = window.charCodeAt(at);

    if (code === 93) {
      return -1;
    }

    if (code === 91) {
      return at < close - 1 ? at : -1;
    }
  }

  return -1;
}

/**
 * What the Markdown reader knows about the line past the caret, and typing
 * does not: whether a destination open at the caret closes later on it.
 */
export interface DestinationAhead {
  /** Whether a `>)` ends the `](<` form before any `<`, `>` or line break. */
  readonly angledCloses: () => boolean;
  /**
   * Whether a `)` ends the plain form before any whitespace, given the
   * parentheses its destination holds open at the caret.
   */
  readonly plainCloses: (depth: number) => boolean;
}

/**
 * Whether the text ends inside a link destination whose `)` has not arrived.
 *
 * Only a `](` behind a label the link patterns accept can open one (see
 * {@link labelStart}). Any `](` used to count, so a `[x]` already closed, an
 * empty `[]` or no `[` at all held the marks off text that could never become
 * a link: `ref [x] then f](g*h*` lost its italic. The nearest such hinge
 * decides, and it has to be in the caret's own token, since a destination
 * holds no whitespace; a hinge without a label is passed over rather than
 * ending the search, since a foreign destination may hold a `](` of its own.
 *
 * The plain form holds no whitespace, so a space ends it. The `](<` form is
 * delimited instead: the angled link rule admits a space, so a space does not
 * end it, and only a `<`, a `>` or a line break does. Stopping at the space
 * left the rest of a foreign destination unprotected -- in
 * `[a](<https://a.test/my docs/__init__.py>)` the `__init__` was emboldened
 * out of the URL, pasted or typed. The writer never emits a space there (it
 * percent-encodes one), so this only ever reads foreign Markdown; the price is
 * that an unclosed `](<` holds the marks off the rest of a typed line, which
 * the reader, knowing the line, does not.
 *
 * `ahead` is the other half of the same question, which only the Markdown
 * reader can answer: a destination that never closes on the line is not a
 * link, so the prose behind it keeps its marks -- `**see [docs](x**` is bold
 * in CommonMark. Typing passes none, and holds the destination open: the `)`
 * may be the next thing typed.
 *
 * `before` passes over any hinge at or after that offset. The code rule gives
 * its opening backtick: a code span binds tighter than a link, so a `](` inside
 * the span being closed opens nothing, and ``Write `[label](` `` is code.
 *
 * `labelBefore` passes over any hinge whose label opens at or after that
 * offset. The formula rule gives its opening `$`: a link whose `[` came first
 * holds the formula's dollars as its own (`[Save $](https://a.test/?q=$)` is
 * a link), and one whose `[` is inside the TeX is the TeX's (`$[0,1](x$)`).
 */
function inOpenDestination(
  window: string,
  ahead?: DestinationAhead,
  before: number = window.length,
  labelBefore: number = window.length,
): boolean {
  // Only the last `](<` can be open in the angled form: an earlier one would
  // hold this one's `<`, which that form does not admit.
  const angled = window.lastIndexOf('](<');
  const angledLabel = angled === -1 ? -1 : labelStart(window, angled);

  if (
    angled !== -1 &&
    angled + 2 <= before &&
    window.lastIndexOf('<') === angled + 2 &&
    window.lastIndexOf('>') < angled &&
    window.lastIndexOf('\n') < angled &&
    angledLabel !== -1 &&
    angledLabel < labelBefore
  ) {
    return ahead?.angledCloses() ?? true;
  }

  let at = window.lastIndexOf('](');
  // Everything from here to the caret is known to hold no whitespace, so each
  // character is looked at once however many hinges are passed over. A label
  // may hold spaces, and `labelStart` reads past them.
  let clean = window.length;

  for (; at !== -1; at = at === 0 ? -1 : window.lastIndexOf('](', at - 1)) {
    for (let index = clean - 1; index >= at + 2; index -= 1) {
      if (isSpace(window.charCodeAt(index))) {
        return false;
      }
    }

    clean = at;

    if (at + 2 <= before) {
      const label = labelStart(window, at);

      if (label !== -1 && label < labelBefore) {
        break;
      }
    }
  }

  if (at === -1) {
    return false;
  }

  const tail = window.slice(at + 2);

  // The angled form was answered above; a `](<` that reaches here is not open.
  if (tail.startsWith('<')) {
    return false;
  }

  // The plain form is the link rule's own: no `<` to open it, any after, no
  // whitespace, and parentheses that may nest -- it is still open until a `)`
  // finds no `(` of its own to close. (Forbidding `<` throughout let a span
  // close in `/p?a<b&q=*x*`.)
  let depth = 0;

  for (let index = 0; index < tail.length; index += 1) {
    const code = tail.charCodeAt(index);

    if (code === 40) {
      depth += 1;
    } else if (code === 41 && depth-- === 0) {
      return false;
    }
  }

  return ahead?.plainCloses(depth) ?? true;
}

/**
 * The code span the backtick run ending at the caret closes, as a match of the
 * code rule's shape: group 1 is the content. Null when the run closes nothing.
 *
 * A code span is delimited by backtick runs, and a run closes only the open
 * one of its own length, as in CommonMark. Matching a single backtick back to
 * the nearest other one ignored that: in `` `` a`b `` `` the inner backtick
 * closed a span at once with the second of the opening pair, so the code came
 * out as ` ab ` with its backtick moved out after it -- typed and pasted, since
 * the reader replays this. A span opened by two or more backticks also drops
 * one space from each end when both ends have one, which is how CommonMark
 * lets such a span begin or end with a backtick; a single-backtick span keeps
 * its spaces, as it always has here.
 *
 * Typing only knows what is behind the caret, so a run is read as it stands
 * when its last backtick arrives: a span is closed by `` `a` `` before a
 * second backtick could be typed after it.
 */
function codeSpanAt(window: string): { match: RegExpExecArray; open: number } | null {
  let closing = window.length - 1;

  while (closing > 0 && window.charCodeAt(closing - 1) === 96) {
    closing -= 1;
  }

  const length = window.length - closing;
  const open = openCodeRunAt(window, closing);

  if (open.length !== length || closing - (open.at + length) < 1) {
    return null;
  }

  let content = window.slice(open.at + length, closing);
  let pad = 0;

  if (
    length > 1 &&
    content.length > 2 &&
    content.startsWith(' ') &&
    content.endsWith(' ') &&
    content.trim() !== ''
  ) {
    content = content.slice(1, -1);
    pad = 1;
  }

  const match = Object.assign([window.slice(open.at), content], {
    index: open.at,
    input: window,
    groups: undefined,
  }) as RegExpExecArray;

  return { match, open: length + pad };
}

export interface InlineRuleMatch {
  /** Offset of the opening delimiter. */
  readonly start: number;
  /** Offset just past the closing delimiter, i.e. the caret. */
  readonly end: number;
  /** Characters to strip from the front. */
  readonly openLength: number;
  /** Characters to strip from the back. */
  readonly closeLength: number;
  readonly mark?: Mark;
  readonly link?: string;
  /**
   * An inline formula: the TeX between the dollars, as the text holds it.
   *
   * The span becomes one formula rather than marked text, so its delimiters
   * are not stripped from the inner text -- the whole of `[start, end)` is
   * replaced. The Markdown reader takes the TeX from its source instead, where
   * an escape is still the backslash TeX needs (`$a\_b$`).
   */
  readonly math?: string;
}

/** `$`, by character code. */
const DOLLAR = 36;
/** U+FFFC, the character a finished formula occupies (see `MATH_ATOM`). */
const ATOM = 0xfffc;
/** A label made of formulas alone. Anchored at both ends, so it is linear. */
const ONLY_ATOMS = /^\uFFFC+$/;

/**
 * What a code span's `$` is projected to for the formula rule: by the
 * Markdown reader as the span closes, and by typing for a code run
 * (`matchInlineRuleInRuns`). A barrier to a formula, as the atom is, but
 * not the atom: in a link destination it is the `$` it stands for, and a
 * real formula there is no URL's characters at all.
 */
export const CODE_DOLLAR = '\uFFFF';
const CODE_DOLLAR_CODE = 0xffff;

/** Whether the character at `index` is escaped by an odd run of backslashes. */
function escapedAt(text: string, index: number): boolean {
  let slashes = 0;

  while (text.charCodeAt(index - 1 - slashes) === 92) {
    slashes += 1;
  }

  return slashes % 2 === 1;
}

/**
 * An inline formula, `$TeX$`, that the `$` at the end of the window closes.
 *
 * Pandoc's rule, as far as the text before the caret can tell it: the opening
 * `$` has a non-space character after it and the closing one a non-space
 * character before it, so `costs $5 and $6` is prose. Pandoc's third
 * condition -- no digit straight after the closing `$`, which keeps `$5-$10`
 * a price -- needs the character that has not been typed yet: the Markdown
 * reader asks it, and the editor takes a typed formula back when a digit
 * follows. A `$` doubled is display math (`$$`), never an inline delimiter,
 * and one escaped by a backslash is TeX's literal dollar -- `$a\$b$` is one
 * formula.
 *
 * The opener is the nearest unescaped `$` behind the closer: TeX cannot hold a
 * bare `$` (it ends math mode), so a formula can never contain one, and a
 * nearer `$` that fails as an opener means there is no formula here at all.
 * Walked back one character at a time and stopped at the first line break,
 * which no inline formula crosses; that and the open-code-span test before
 * the opener are each bounded by the window, as every rule here is.
 *
 * Not inside an open code span: `` `$x$` `` is code, the same precedence the
 * autolink and tag rules give a code span. Not around a finished formula
 * either: a formula holds TeX, not other formulas. A finished code span's `$` is
 * code, and both callers project it to `CODE_DOLLAR` (the Markdown reader as
 * the span closes, typing in `matchInlineRuleInRuns`), which is the same
 * barrier: so it opens nothing, stops the walk, and is no `$` to double the
 * opener after it -- `` `x$`$y$ `` is code and then a formula.
 */
function matchMath(window: string, offset: number): InlineRuleMatch | null {
  const close = window.length - 1;

  if (close < 2 || escapedAt(window, close)) {
    return null;
  }

  const last = window.charCodeAt(close - 1);

  if (last === DOLLAR || isSpace(last)) {
    return null;
  }

  for (let at = close - 1; at >= 0; at -= 1) {
    const code = window.charCodeAt(at);

    if (code === 10 || code === 13 || code === ATOM || code === CODE_DOLLAR_CODE) {
      return null;
    }

    if (code !== DOLLAR || escapedAt(window, at)) {
      continue;
    }

    // The cut is the one place there is nothing to look behind, so a formula
    // opening there is not trusted -- as for every other rule.
    if (
      (at === 0 && offset > 0) ||
      window.charCodeAt(at - 1) === DOLLAR ||
      isSpace(window.charCodeAt(at + 1)) ||
      openCodeRun(window.slice(0, at)) !== 0
    ) {
      return null;
    }

    return {
      start: offset + at,
      end: offset + window.length,
      openLength: 1,
      closeLength: 1,
      math: window.slice(at + 1, close),
    };
  }

  return null;
}

/**
 * Where the link that ends at the caret begins, or -1 if none does.
 *
 * Both patterns are anchored at the caret, so the destination is the last thing
 * in the window and its shape says which `](` opened it: `](<` for the
 * angle-bracket form, and for the plain form the `(` that the closing `)`
 * balances -- the first one going back that nothing inside closes, since the
 * destination holds no whitespace and its parentheses nest. Reading it off
 * directly is one scan back, where guessing was wrong and enumerating needed a
 * bound.
 *
 * It is where the search starts, not a promise of where a match does: the
 * patterns are anchored at the caret alone, so when the link at this opener is
 * not one -- a plain destination opening with `<` -- the engine goes on to a
 * later `[`. In foreign Markdown that finds a link inside an unclosed angle
 * form, as CommonMark does; the writer escapes every `](` in a destination so
 * that its own output holds none to find.
 */
function linkOpener(window: string, angled: boolean): number {
  if (angled) {
    const pair = window.lastIndexOf('](<');

    return pair === -1 ? -1 : window.lastIndexOf('[', pair);
  }

  // The destination holds no whitespace, and its parentheses balance, so the
  // `(` that opens it is the first one going back from the closing `)` that
  // nothing inside closes. Its `]` and the `[` before that are the label's.
  // With no `](` behind the caret there is nothing to find, and the walk below
  // is the cost of every `)`: a line of them paid it in full each time.
  if (window.lastIndexOf('](') === -1) {
    return -1;
  }

  let depth = 0;

  for (let at = window.length - 2; at >= 0; at -= 1) {
    const code = window.charCodeAt(at);

    if (isSpace(code)) {
      return -1;
    }

    if (code === 41) {
      depth += 1;
    } else if (code === 40) {
      if (depth === 0) {
        return window.charCodeAt(at - 1) === 93 ? window.lastIndexOf('[', at - 1) : -1;
      }

      depth -= 1;
    }
  }

  return -1;
}

/** What the Markdown reader puts in its projection where a character was escaped. */
const ESCAPED_PLACEHOLDER = String.fromCharCode(0);

/**
 * A bare URL's start in the part of a token that precedes a span's opener.
 *
 * A protocol anywhere in it; `www.` opening the token or after `*`, `_`, `~`,
 * `(`, `[` or `]` -- or the placeholder the Markdown reader puts where a
 * character was escaped or a reference decoded, neither of which is a letter
 * -- so `awww.cute` is a word. Either case.
 *
 * This is not GFM's autolink grammar, and each attempt to make it so took
 * underscores out of real URLs: refusing a `_` straight after the scheme broke
 * `https://_dmarc.example.com/a_b_c` (a host may begin with one, and at the
 * closing `_` nothing says whether more host follows); refusing a URL after
 * `[` broke a link labelled with its own URL, `[https://a.test/_private_dir](…)`;
 * and refusing a protocol after a letter broke `**see**https://a.test/_y_`,
 * which is `seehttps://…` by the time its `_` closes because the finished
 * span's delimiters are gone. So where it is uncertain the line falls on the
 * side of the URL: text that other readers would have emphasised stays literal
 * with its underscores (`http://_a_`, `xhttps://a.test/_y_`), which loses
 * nothing, rather than a URL losing characters, which does.
 */
const BARE_URL_IN_TOKEN = new RegExp(
  `https?:\\/\\/|(?:^|[*_~([\\]${ESCAPED_PLACEHOLDER}])www\\.`,
  'i',
);

/**
 * Whether a span whose opening delimiter is at `opener` opens inside a bare
 * URL: one that starts earlier in the same whitespace-delimited token.
 *
 * Typing `https://a.test/_y_` used to italicise the `y` and delete the
 * underscores, and `www.a.test/__init__` lost four. A span that opens *before*
 * the URL is still a span -- `_see https://a.test_` is italic in CommonMark and
 * in GFM, which leaves a trailing `_` out of the link -- so it is where the
 * opener sits that decides. It is the opener's token that is looked at, not the
 * caret's: a span may close words later, and
 * `http://localhost:9200/_cat/indices and …/my_index` lost an underscore from
 * each URL while only the second token was being asked about.
 *
 * It sees what `matchInlineRule` is given: a URL whose start is more than
 * `INLINE_SPAN_LIMIT` behind the caret, or that the Markdown reader has already
 * retired from the text it keeps, is not seen.
 */
function opensInBareUrl(window: string, opener: number): boolean {
  let token = opener;

  while (token > 0 && !/\s/.test(window[token - 1] ?? '')) {
    token -= 1;
  }

  return BARE_URL_IN_TOKEN.test(window.slice(token, opener));
}

/**
 * Tests the text before the caret for a completed inline span.
 *
 * `textBeforeCaret` is the block's plain-text projection up to the caret, so
 * offsets returned here are block offsets.
 */
export function matchInlineRule(
  textBeforeCaret: string,
  options: {
    /**
     * The text is the Markdown reader's projection, in which a NUL stands for
     * an escaped character. Never set for typed text, where a NUL is a NUL.
     */
    readonly projection?: boolean;
    /**
     * Whether a link destination open at the caret closes later on the line
     * (see {@link DestinationAhead}). The Markdown reader knows; typing does
     * not, and leaves it out. Spelled out rather than named, so the public
     * signature names no type the entry points do not export.
     */
    readonly ahead?: {
      readonly angledCloses: () => boolean;
      readonly plainCloses: (depth: number) => boolean;
    };
  } = {},
): InlineRuleMatch | null {
  // One character past the window, so the lookbehinds see what really precedes
  // a candidate opening delimiter rather than the cut.
  const offset = Math.max(0, textBeforeCaret.length - INLINE_SPAN_LIMIT - 1);
  const window = offset === 0 ? textBeforeCaret : textBeforeCaret.slice(offset);
  const closer = textBeforeCaret.at(-1);
  // Inside a link destination nothing but the link itself may close. Rules
  // fire as each character arrives, so `_y_` in a URL was italicised -- and its
  // underscores deleted -- before the `)` that makes it a destination was
  // read: `https://a.test/_y_` came back as `https://a.test/y`, from the
  // editor's own Markdown and while typing alike (the e2e audit's F15).
  // Code spans ask their own version of this below: one that opened before the
  // destination's `](` takes precedence over the link, as in CommonMark, so
  // `` `](` `` is code; one that opened inside the destination is part of the
  // URL. The writer escapes a backtick in a destination (the URL parser
  // percent-encodes one in a path but not in a query), so a code span cannot
  // close inside a destination we wrote.
  const inDestination = inOpenDestination(window, options.ahead);
  const inAutolink = inOpenAutolink(window);

  // A `$` closes nothing but a formula, and nothing closes inside a link
  // destination or an autolink but the link itself or a code span: a URL may
  // hold dollars (`?price=$5$`), and they are its characters. Only a link
  // whose `[`, or an autolink whose `<`, came before the formula's own `$`,
  // though: one that opens inside the TeX is the TeX's, and asked of the whole
  // window, `$[0,1](x$)` -- a half-open interval in parentheses -- held its
  // formula open on the `)` after it, and `$a<http://b$` on its own text.
  if (closer === '$') {
    const formula = matchMath(window, offset);

    if (!formula) {
      return null;
    }

    const opener = formula.start - offset;

    return inOpenDestination(window, options.ahead, window.length, opener) ||
      (inAutolink && window.lastIndexOf('<') < opener)
      ? null
      : formula;
  }

  for (const rule of INLINE_RULES) {
    if (inDestination && !rule.isLink && rule.mark !== 'code') {
      continue;
    }

    // Nothing but the autolink itself, or a code span, closes in an open
    // autolink. Which of those two wins is which started first: decided below,
    // once a match says where it starts.
    if (inAutolink && !rule.autolink && rule.mark !== 'code') {
      continue;
    }

    // A rule that does not end in this character cannot match here, and running
    // it anyway is not free: the link patterns walk the window from every `[`
    // in it, which is most of the cost of parsing a line of stray brackets.
    if (rule.closer !== closer) {
      continue;
    }

    // The earliest `[` a link ending here can start at is the one that opens
    // the destination's `](`, so that position is computed rather than the
    // window walked from every bracket in it — which is what keeps a line of
    // unpaired brackets, `[0, 1) [1, 2) ...`, off the quadratic path (it was a
    // second of work per paste: every `)` restarted the scan). It is computed and not
    // guessed: a foreign destination may hold `](` of its own
    // (`[see](<https://…?q=[foo](bar)>)`), so taking the last one put the
    // opener inside the URL, and trying candidates in turn needed a cap that
    // lost the link outright once a URL carried enough of them.
    let searchedFrom = 0;
    let match: RegExpExecArray | null = null;
    // A code span's opening delimiter: its backtick run, and a stripped space.
    let codeOpen: number | undefined;

    if (rule.isLink) {
      const opener = linkOpener(window, rule.angled === true);

      if (opener === -1) {
        continue;
      }

      searchedFrom = opener;
      match = rule.pattern.exec(window.slice(opener));

      // The pattern takes the first `](` after the label; `linkOpener` balanced
      // the parentheses against the last. Only where they agree is it a link:
      // `[x](https://w.test/a](b)` is none, in CommonMark or here.
      if (match && !rule.angled && !balancedParens(match[2] ?? '')) {
        continue;
      }
    } else if (rule.mark === 'code' && closer === '`') {
      const span = codeSpanAt(window);

      match = span?.match ?? null;
      codeOpen = span?.open;
    } else {
      match = rule.pattern.exec(window);
    }
    const whole = match?.[0];
    const inner = match?.[1];

    if (!match || whole === undefined || inner === undefined || inner.length === 0) {
      continue;
    }

    // A link needs text to hang on, and a formula takes none (`makeRun`): a
    // label of nothing but formulas lost its brackets and its URL to the rule
    // and then the link to the atom, so `[$x$](https://a.test/)` kept only the
    // formula. The writer never spells one -- it has no link to write -- so
    // this only reads foreign Markdown, and leaves it as written.
    if (rule.isLink && ONLY_ATOMS.test(inner)) {
      // The angled form refuses outright, as for an unsafe href below: the
      // plain rule would retry from a `[` inside the refused URL, and
      // `[$x$](<javascript:void[x](//evil.test/>)` linked `x`.
      if (rule.angled) {
        return null;
      }

      continue;
    }

    // Code spans and autolinks share precedence, and the one that started
    // first wins: a code span that opened inside an open autolink closes
    // nothing (`<https://a.test/`x`>` is one link), and an autolink whose `<`
    // is inside an open code span is code. Asked only once a match exists, so
    // a line of backticks does not pay for it on every character.
    if (
      inAutolink &&
      rule.mark === 'code' &&
      searchedFrom + match.index > window.lastIndexOf('<')
    ) {
      continue;
    }

    // Every other rule shares that precedence: nothing closes inside a code
    // span that opened before it, as in CommonMark, where a code span binds
    // tighter than emphasis, links and inline HTML. Only the tag rules used to
    // ask, so `` `<em>hi</em>` `` stayed code while `` `__init__` `` lost its
    // underscores to bold before the closing backtick arrived, and
    // `` `[x](y)` `` became a link -- typed and pasted alike, since the reader
    // replays these rules. The cost is a backtick that never closes: typing
    // cannot know it will not, so a stray one holds the rest of the block
    // literal -- across soft breaks, not just to the end of its line -- and so
    // does a paste, which replays the same rules.
    //
    // The same holds for a code span that opened *after* the opener and is
    // still open where the closing delimiter starts: `` *y `a*b` z* `` is
    // emphasis around a code span, and closing the emphasis on the `*` inside
    // it took that star and the opening backtick out of the text and split the
    // span in two. An autolink and a `<code>` tag are the exceptions: each
    // shares the code span's precedence, so whichever opened first wins, and a
    // backtick after the opener is its own (the writer spells a code run that
    // holds a backtick `<code>a`b</code>`). This widens the cost above: a
    // stray backtick also holds back an emphasis opened before it, since
    // typing cannot know that it will never close either.
    if (
      !(rule.mark === 'code' && closer === '`') &&
      (openCodeRun(window, searchedFrom + match.index) !== 0 ||
        (!rule.autolink &&
          rule.mark !== 'code' &&
          openCodeRun(window, searchedFrom + match.index + rule.open + inner.length) !== 0))
    ) {
      continue;
    }

    // No code span opens while one is left open behind it. A backtick only
    // stays text that way when a refusal above kept its span from closing, so
    // the next one is that span's closer, and text too: `<http://host/`path`
    // with `other`` otherwise paired `path`'s second backtick with the next and
    // swallowed ` with ` into code. The run the opener ends is its own, not
    // one left open: `` ``a`` `` opens on its second backtick.
    if (rule.mark === 'code' && closer === '`') {
      let run = searchedFrom + match.index;

      while (run > 0 && window.charCodeAt(run - 1) === 96) {
        run -= 1;
      }

      if (openCodeRun(window, run) !== 0) {
        continue;
      }

      // A span whose opening run is inside a link destination is part of the
      // URL: CommonMark reads the destination when it reaches the `]`, before
      // the backtick. Closing here took both backticks out of the URL --
      // `[t](https://a.test/?q=`x`)` linked to `?q=x` -- typed or pasted. Only
      // a destination open before the run counts, so a `](` inside the span
      // opens nothing.
      if (inOpenDestination(window, options.ahead, run)) {
        continue;
      }
    }

    // Asked only once a `_` rule has matched: the answer needs a walk back to
    // the last whitespace, and a line of underscores would pay it per character.
    if (closer === '_' && opensInBareUrl(window, searchedFrom + match.index)) {
      continue;
    }

    const index = searchedFrom + match.index;

    // A match starting on the cut is the one place the lookbehind has no
    // context, so it is not trusted; it would span the window entirely anyway.
    if (offset > 0 && index === 0) {
      continue;
    }

    let link: string | undefined;

    if (rule.isLink) {
      // In the reader's projection an escaped character is a NUL. One in a
      // host made the URL unparseable, so the writer's own
      // `[x](https://a\&amp;b.test/)` was not a link. It stands for a
      // character, so there it is tested as one, and the reader then takes
      // the real href from the content. Only there: typing applies this href
      // as it is, and a literal NUL in a block's text must not become a link
      // to a host the text does not hold.
      // The reader projects a finished code span's `$` to `CODE_DOLLAR`,
      // which in a destination is the `$` it stands for. A code span that
      // opens inside a destination the rules hold open -- plain, or angled
      // with spaces in it -- closes nothing there: it is the URL's own
      // characters, backticks and all, so `[x](<https://a.test/p q `$`>)`
      // links to `…%60$%60`. A formula's atom is not: a formula already in
      // the text a typed link closes around is no URL's characters -- read
      // as a `$`, `[x](<https://a.test/p q $y$>)` linked to `…%20$`, and
      // typed, to `…%20%EF%BF%BC`. So there is no link.
      const destination = match[2] ?? '';

      if (destination.includes(String.fromCharCode(ATOM))) {
        if (rule.angled) {
          return null;
        }

        continue;
      }

      const href = sanitizeUrl(
        options.projection
          ? destination.replaceAll(ESCAPED_PLACEHOLDER, 'a').replaceAll(CODE_DOLLAR, '$')
          : destination,
      );

      // An unsafe or unparseable URL leaves the literal text alone -- all of
      // it, when it is a closed angle form: the plain rule below is anchored
      // only at the caret, and would retry from a `[` inside the refused URL
      // (`[y](<javascript:void[x](//evil.test/>)` linked `x`).
      if (!href && rule.angled) {
        return null;
      }

      if (!href) {
        continue;
      }

      link = href;
    }

    // The opening delimiter is the rule's own; the closing one is the rest.
    const openLength = codeOpen ?? rule.open;
    const closeLength = whole.length - openLength - inner.length;

    return {
      start: offset + index,
      end: offset + index + whole.length,
      openLength,
      closeLength,
      mark: rule.mark,
      link,
    };
  }

  return null;
}

/**
 * A code run's text as the rules see it: each character that is not
 * whitespace replaced by the placeholder, so nothing in it can open or close a
 * span, while offsets stay aligned and the whitespace a destination or a bare
 * URL stops at stays where it is -- and each `$` by `CODE_DOLLAR`, which a
 * formula treats as a barrier, as it does a finished formula: never a
 * delimiter, and nothing it reaches back over. With `x$` formatted as code
 * and `$y$` typed after it, the plain text read `$$` -- display math -- and
 * no formula came, where pasting the same line made one.
 *
 * The Markdown reader does the same to a code span the moment it closes. Read
 * raw, a backtick inside an existing code run paired with the next one typed:
 * format ``a`b`` as code with Mod+E, type `` and `c` ``, and the code rule took
 * `b and ` for its span and deleted the backtick out of the code.
 */
export function projectCode(text: string): string {
  return text.replace(/\S/g, (char) => (char === '$' ? CODE_DOLLAR : ESCAPED_PLACEHOLDER));
}

/**
 * {@link matchInlineRule} for typed text, given the block's runs and the
 * caret: a code run's characters are projected away (see {@link projectCode}),
 * as the Markdown reader projects a code span it has closed, so typing a line
 * and pasting it agree on what an existing code run holds open.
 *
 * Typed backticks are not code yet, so the code rule itself sees what it
 * always saw. A link's href is read from the real text whenever its
 * destination crosses a projected run.
 */
export function matchTypedInlineRule(content: RichText, caret: number): InlineRuleMatch | null {
  let text = '';
  let projected = '';

  for (const run of content) {
    if (text.length >= caret) {
      break;
    }

    text += run.text;
    projected += run.marks?.includes('code') ? projectCode(run.text) : run.text;
  }

  text = text.slice(0, caret);
  projected = projected.slice(0, caret);

  if (projected === text) {
    return matchInlineRule(text);
  }

  const match = matchInlineRule(projected, { projection: true });

  if (!match?.link) {
    return match;
  }

  const innerEnd = match.end - match.closeLength;
  const closing = projected.slice(innerEnd, match.end);

  if (!closing.includes(ESCAPED_PLACEHOLDER) && !closing.includes(CODE_DOLLAR)) {
    return match;
  }

  const real = text.slice(innerEnd, match.end);
  const href = sanitizeUrl(closing.startsWith('](<') ? real.slice(3, -2) : real.slice(2, -1));

  return href ? { ...match, link: href } : null;
}

/** The math audit's name for {@link matchTypedInlineRule}, kept for its tests. */
export const matchInlineRuleInRuns = matchTypedInlineRule;
