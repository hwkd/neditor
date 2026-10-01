import type { Mark } from '../model/rich-text.ts';
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
  readonly mark?: Mark;
  /** Capture group 2 is the href. */
  readonly isLink?: boolean;
  /** The `](<…>)` form, whose destination is delimited rather than run-length. */
  readonly angled?: boolean;
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
  { closer: '*', pattern: new RegExp(`\\*\\*${body('*')}\\*\\*$`), mark: 'bold' },
  { closer: '_', pattern: new RegExp(`__${body('_')}__$`), mark: 'bold' },
  // Only the opening `*` of a longer run is refused, so `***x***` closes as
  // bold and then as italic. A word character before it is not a reason to
  // refuse: CommonMark restricts intra-word emphasis to `_`, and `toMarkdown`
  // writes `*x*` whatever precedes it, so refusing left `Chapter*One*` sitting
  // in the text as literal asterisks.
  { closer: '*', pattern: new RegExp(`(?<!\\*)\\*${body('*')}\\*$`), mark: 'italic' },
  { closer: '_', pattern: new RegExp(`(?<![_\\w])_${body('_')}_$`), mark: 'italic' },
  { closer: '~', pattern: new RegExp(`~~${body('~')}~~$`), mark: 'strikethrough' },
  // Backticks deliberately keep their spaces: a code span is delimited by
  // backtick runs rather than by flanking, so `` ` a ` `` really is code in
  // CommonMark. Emphasis is the construct with the flanking rule.
  { closer: '`', pattern: /`([^`]+)`$/, mark: 'code' },
  // Markdown has no underline, so `toMarkdown` writes the HTML tag; this is
  // what reads it back rather than leaving seven junk characters in the text.
  { closer: '>', pattern: /<u>([^<]+)<\/u>$/, mark: 'underline' },
  // `toMarkdown` writes a marked run whose text starts or ends with whitespace
  // as HTML: `**bold **` is not emphasis in any dialect, and `a**bold&#32;**b`
  // is literal asterisks in CommonMark (the closer is not right-flanking), but
  // any reader that allows inline HTML renders `a<strong>bold </strong>b` as
  // written.
  { closer: '>', pattern: /<strong>([^<]+)<\/strong>$/, mark: 'bold' },
  { closer: '>', pattern: /<em>([^<]+)<\/em>$/, mark: 'italic' },
  { closer: '>', pattern: /<s>([^<]+)<\/s>$/, mark: 'strikethrough' },
  { closer: '>', pattern: /<code>([^<]+)<\/code>$/, mark: 'code' },
  // The angle-bracket form first: it is how a destination holding a `)` — the
  // character that would otherwise close the link — is written.
  { closer: ')', pattern: /\[([^\]]+)\]\(<([^<>\n]*)>\)$/, isLink: true, angled: true },
  // Never one that opens with `<`: that is the form above, not yet closed. Its
  // destination may hold a `)`, and this rule fired at it --
  // `[x](<mailto:a@b.test?s=(v2)>)` linked to `https://%3Cmailto:a@b.test/…`.
  // It may hold balanced parentheses, as CommonMark allows: Wikipedia's
  // `…/Foo_(bar)` ended at the first `)`. `linkOpener` finds the `](` whose
  // `(` the closing one balances, so the pattern only has to match from there.
  { closer: ')', pattern: /^\[([^\]]+)\]\(([^\s<][^\s]*)\)$/, isLink: true },
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

/**
 * Whether the text ends inside a link destination whose `)` has not arrived.
 *
 * Only the last `](` can be the open one, so the pattern runs on the tail from
 * there -- run unanchored over the window, it retried from every `](` in it and
 * a pasted line of them took seconds. Neither spelling of a destination the
 * writer emits holds whitespace (it percent-encodes it in the `<…>` form too),
 * and stopping at it is what keeps an unclosed `](<` from swallowing the rest
 * of a line of prose.
 *
 * The cost is foreign Markdown: the angled link rule itself admits a space, so
 * in `[a](<https://a.test/my docs/__init__.py>)` the text after the space is
 * not protected and `__init__` is emboldened out of the URL. Telling that
 * destination from prose needs the `>)` that has not been typed yet; the
 * reader could look ahead and typing cannot, and the two are kept identical.
 */
/** `\s`, by character code: the scans below ask it of every character they pass. */
function isSpace(code: number): boolean {
  return (
    code === 32 || (code >= 9 && code <= 13) || (code > 127 && /\s/.test(String.fromCharCode(code)))
  );
}

function inOpenDestination(window: string): boolean {
  const at = window.lastIndexOf('](');

  if (at === -1) {
    return false;
  }

  const tail = window.slice(at + 2);

  if (tail.startsWith('<')) {
    return /^<[^<>\s]*$/.test(tail);
  }

  // The plain form is the link rule's own: no `<` to open it, any after, no
  // whitespace, and parentheses that may nest -- it is still open until a `)`
  // finds no `(` of its own to close. (Forbidding `<` throughout let a span
  // close in `/p?a<b&q=*x*`.)
  let depth = 0;

  for (let at = 0; at < tail.length; at += 1) {
    const code = tail.charCodeAt(at);

    if (isSpace(code)) {
      return false;
    }

    if (code === 40) {
      depth += 1;
    } else if (code === 41 && depth-- === 0) {
      return false;
    }
  }

  return true;
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
}

/**
 * Tests the text before the caret for a completed inline span.
 *
 * `textBeforeCaret` is the block's plain-text projection up to the caret, so
 * offsets returned here are block offsets.
 */
/**
 * Where the link that ends at the caret begins, or -1 if none does.
 *
 * Both patterns are anchored at the caret, so the destination is the last thing
 * in the window and its shape says exactly which `](` opened it: `](<` for the
 * angle-bracket form, and for the plain form the one immediately before a run
 * of characters that are neither `)` nor whitespace — which is all the pattern
 * admits there. Reading it off directly costs two scans, where guessing was
 * wrong and enumerating needed a bound.
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
const ESCAPED_PLACEHOLDER = String.fromCharCode(0);
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

export function matchInlineRule(
  textBeforeCaret: string,
  options: {
    /**
     * The text is the Markdown reader's projection, in which a NUL stands for
     * an escaped character. Never set for typed text, where a NUL is a NUL.
     */
    readonly projection?: boolean;
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
  // Code spans are left alone: they take precedence over links in CommonMark,
  // so `` `](` `` is code. The writer escapes a backtick in a destination (the
  // URL parser percent-encodes one in a path but not in a query), so a code
  // span cannot close inside a destination we wrote.
  const inDestination = inOpenDestination(window);

  for (const rule of INLINE_RULES) {
    if (inDestination && !rule.isLink && rule.mark !== 'code') {
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

    if (rule.isLink) {
      const opener = linkOpener(window, rule.angled === true);

      if (opener === -1) {
        continue;
      }

      searchedFrom = opener;
      match = rule.pattern.exec(window.slice(opener));
    } else {
      match = rule.pattern.exec(window);
    }
    const whole = match?.[0];
    const inner = match?.[1];

    if (!match || whole === undefined || inner === undefined || inner.length === 0) {
      continue;
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
      const destination = match[2] ?? '';
      const href = sanitizeUrl(
        options.projection ? destination.replaceAll(ESCAPED_PLACEHOLDER, 'a') : destination,
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

    // The delimiters are whatever surrounds the captured inner text.
    const openLength = whole.indexOf(inner);
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
