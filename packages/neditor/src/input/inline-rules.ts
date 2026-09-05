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
 */
const body = (delimiter: string): string =>
  `([^${delimiter}\\s\\n](?:[^${delimiter}\\n]*[^${delimiter}\\s\\n])?)`;

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
  { closer: '`', pattern: /`([^`\n]+)`$/, mark: 'code' },
  // Markdown has no underline, so `toMarkdown` writes the HTML tag; this is
  // what reads it back rather than leaving seven junk characters in the text.
  { closer: '>', pattern: /<u>([^<\n]+)<\/u>$/, mark: 'underline' },
  // The angle-bracket form first: it is how a destination holding a `)` — the
  // character that would otherwise close the link — is written.
  { closer: ')', pattern: /\[([^\]\n]+)\]\(<([^<>\n]*)>\)$/, isLink: true, angled: true },
  { closer: ')', pattern: /\[([^\]\n]+)\]\(([^)\s]+)\)$/, isLink: true },
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
 * admits there. Reading it off directly costs two scans and cannot be wrong,
 * where guessing was and enumerating needed a bound.
 */
function linkOpener(window: string, angled: boolean): number {
  if (angled) {
    const pair = window.lastIndexOf('](<');

    return pair === -1 ? -1 : window.lastIndexOf('[', pair);
  }

  // The destination admits neither `)` nor whitespace, so whichever comes first
  // going back from the closing `)` bounds how far the whole `](…)` can reach.
  let stop = window.length - 2;

  while (stop >= 0 && !/[)\s]/.test(window[stop] ?? '')) {
    stop -= 1;
  }

  // Within that reach the label opens at the first `](` that HAS a `[` before
  // it. Taking the first one unconditionally gave up on the whole rule when a
  // stray `](` preceded a real link, because that one opens nothing — so
  // `a] (b) [see](https://x.test/)` lost its link entirely.
  for (let pair = window.indexOf('](', stop + 1); pair !== -1 && pair < window.length - 1;) {
    const opener = window.lastIndexOf('[', pair);

    if (opener !== -1) {
      return opener;
    }

    pair = window.indexOf('](', pair + 2);
  }

  return -1;
}

export function matchInlineRule(textBeforeCaret: string): InlineRuleMatch | null {
  // One character past the window, so the lookbehinds see what really precedes
  // a candidate opening delimiter rather than the cut.
  const offset = Math.max(0, textBeforeCaret.length - INLINE_SPAN_LIMIT - 1);
  const window = offset === 0 ? textBeforeCaret : textBeforeCaret.slice(offset);
  const closer = textBeforeCaret.at(-1);

  for (const rule of INLINE_RULES) {
    // A rule that does not end in this character cannot match here, and running
    // it anyway is not free: the link patterns walk the window from every `[`
    // in it, which is most of the cost of parsing a line of stray brackets.
    if (rule.closer !== closer) {
      continue;
    }

    // Both link patterns need a `](` somewhere behind the caret, and can only
    // start at the `[` that opens it. Finding that with two index lookups keeps
    // the regex off the rest of the window — left to walk back from every `[`
    // it turned a line of unpaired brackets, `[0, 1) [1, 2) ...`, into a
    // second of work per paste, because every `)` restarted the scan.
    // A link pattern can only start at the `[` that opens the destination's
    // `](`, so that one position is computed rather than the window walked from
    // every bracket in it — which is what keeps a line of unpaired brackets off
    // the quadratic path. It is computed and not guessed: a destination may
    // hold `](` of its own (`[see](<https://…?q=[foo](bar)>)`, which this
    // editor writes itself), so taking the last one put the opener inside the
    // URL, and trying candidates in turn needed a cap that lost the link
    // outright once a URL carried enough of them.
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

    const index = searchedFrom + match.index;

    // A match starting on the cut is the one place the lookbehind has no
    // context, so it is not trusted; it would span the window entirely anyway.
    if (offset > 0 && index === 0) {
      continue;
    }

    let link: string | undefined;

    if (rule.isLink) {
      const href = sanitizeUrl(match[2] ?? '');

      // An unsafe or unparseable URL leaves the literal text alone.
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
