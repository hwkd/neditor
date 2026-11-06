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
  /**
   * How many characters the opening delimiter has, which is where capture
   * group 1 starts in the match. Stated rather than searched for: the first
   * occurrence of the inner text in the match is not always it, because the
   * delimiter can spell the same characters -- see `matchInlineRule`.
   */
  readonly open: number;
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
  // CommonMark. Emphasis is the construct with the flanking rule.
  { closer: '`', pattern: /`([^`\n]+)`$/, open: 1, mark: 'code' },
  // Markdown has no underline, so `toMarkdown` writes the HTML tag; this is
  // what reads it back rather than leaving seven junk characters in the text.
  { closer: '>', pattern: /<u>([^<\n]+)<\/u>$/, open: 3, mark: 'underline' },
  // The angle-bracket form first: it is how a destination holding a `)` — the
  // character that would otherwise close the link — is written.
  {
    closer: ')',
    pattern: /\[([^\]\n]+)\]\(<([^<>\n]*)>\)$/,
    open: 1,
    isLink: true,
    angled: true,
  },
  // A plain destination never begins with `<`: that character opens the form
  // above, and one that fails to close is no link at all. Admitting it here
  // closed the bracketed destination the writer emits for a URL holding a
  // paren at its first `)` -- `[call](<mailto:a@x.test?subject=Re:%20(draft)>)`
  // came back as a link to `https://%3Cmailto:a@x.test/…` with `>)` left over.
  { closer: ')', pattern: /\[([^\]\n]+)\]\(([^<)\s][^)\s]*)\)$/, open: 1, isLink: true },
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

/**
 * Whether the `]` at `close` ends a label the link patterns accept.
 *
 * Both spell a label `\[([^\]\n]+)\]`: a `[`, then at least one character
 * that is neither `]` nor a line break. Any earlier `[` used to count, so a
 * `[x]` already closed, or a `[` on the line before, opened a label for a
 * `](` long after it. The label opens at the *last* `[` before the `]`,
 * because that is where {@link linkOpener} starts the link pattern -- so
 * `[a[]` and `[[]` are empty labels, exactly as `[]` is. Counting the earlier
 * `[` held marks off a destination that could never become a link.
 *
 * The scan stops at the first `]` behind the hinge, so the label scans of
 * successive hinges never cover the same text twice.
 */
function closesLabel(window: string, close: number): boolean {
  for (let at = close - 1; at >= 0; at -= 1) {
    const char = window[at];

    if (char === ']' || char === '\n') {
      return false;
    }

    if (char === '[') {
      return at < close - 1;
    }
  }

  return false;
}

/**
 * Whether the caret is inside a link destination that has not closed yet.
 *
 * Every rule fires the moment its closing delimiter is typed, and a link only
 * closes on its final `)`, so while a destination is still being typed -- or
 * replayed character by character from pasted Markdown -- the emphasis rules
 * saw ordinary text: `#object.__init__` became `#object.init` with `init` in
 * bold before the link existed, and `**y**`, `_x_` and `~~x~~` in a URL went
 * the same way. A link destination is literal in CommonMark; no mark rule
 * applies inside one.
 *
 * "Open" means what the two link patterns would accept as a destination if a
 * `)` were typed now, and nothing looser: after a `](<` with no `<`, `>` or
 * line break since, or after a `](` not followed by `<` with no `)` or
 * whitespace since -- and in both cases with a label the patterns accept
 * closing at that `](`. A looser
 * test is not a safe one: it suppressed the marks of text that could never be
 * a destination at all.
 *
 * `before` excludes a hinge at or past that offset. The code rule passes its
 * opening backtick: a code span binds tighter than a link, so a `](` inside
 * the span being closed opens nothing, and ``Write `[label](` `` is code.
 *
 * `ahead` is what the Markdown reader knows and typing does not: whether the
 * rest of the line closes a destination open here, in either form. A `](<` or
 * a `](` that never closes is not a link, so the prose after it keeps its
 * marks -- `**see [docs](x**` with no `)` is bold in CommonMark. While typing
 * the answer is unknown and the destination is held open: the `)` may be the
 * next thing typed, and a typed angled destination may hold spaces.
 */
function insideDestination(window: string, before: number, ahead: LineAhead): boolean {
  const angled = window.lastIndexOf('](<');

  // Only the last `](<` can be open: any earlier one holds this one's `<`.
  if (
    angled !== -1 &&
    angled < before &&
    ahead.angledCloses !== false &&
    !/[<>\n]/.test(window.slice(angled + 3)) &&
    closesLabel(window, angled)
  ) {
    return true;
  }

  // The native search first: in a line with no `](` at all -- most prose --
  // that is the whole cost. No hinge sits before the first one, so the walk
  // back can stop there.
  const first = window.indexOf('](');

  if (first === -1 || ahead.plainCloses === false) {
    return false;
  }

  // Back from the caret over what a plain destination admits. Every `](` on
  // the way is a hinge the destination could open at -- it may hold `](` of
  // its own -- so one whose label fails does not end the walk.
  for (let at = window.length - 1; at > first; at -= 1) {
    const char = window[at]!;

    if (char === ')' || /\s/.test(char)) {
      return false;
    }

    // A `<` straight after the hinge makes it the bracketed form's, asked above.
    if (
      char === '(' &&
      window[at - 1] === ']' &&
      window[at + 1] !== '<' &&
      at - 1 < before &&
      closesLabel(window, at - 1)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Whether the caret sits in a link destination, counting only the hinges
 * before `before`.
 *
 * The question the code rule asks of itself, for the Markdown reader's code
 * spans, which it finds by backtick runs rather than by the rule's pattern. The
 * reader asks it as each run is reached, with the run not yet in the text: a
 * run that begins in a destination that closes is part of the URL and opens no
 * span. Not part of the package's public surface.
 */
export function insideLinkDestination(
  textBeforeCaret: string,
  before: number,
  ahead: LineAhead,
): boolean {
  const offset = Math.max(0, textBeforeCaret.length - INLINE_SPAN_LIMIT - 1);
  const window = offset === 0 ? textBeforeCaret : textBeforeCaret.slice(offset);

  return insideDestination(window, before - offset, ahead);
}

/**
 * Tests the text before the caret for a completed inline span.
 *
 * `textBeforeCaret` is the block's plain-text projection up to the caret, so
 * offsets returned here are block offsets.
 */
export function matchInlineRule(textBeforeCaret: string): InlineRuleMatch | null {
  return matchInlineRuleAhead(textBeforeCaret, {});
}

/**
 * What a caller knows about the line beyond the text before the caret.
 *
 * The Markdown reader has the whole line and fills in all three. Typing has
 * only what is before the caret, so it supplies `destination` alone, and only
 * when the block holds a code run: its text is then a projection too.
 *
 * Not part of the package's public surface.
 */
export interface LineAhead {
  /**
   * Whether the rest of the line closes an angle-bracketed destination open at
   * the caret: whether its first `<`, `>` or line break is a `>` followed by
   * `)`. `undefined` when unknown, which holds the destination open.
   */
  readonly angledCloses?: boolean;
  /**
   * The same for a plain destination: whether the first `)` or whitespace
   * from the caret on is a `)`.
   */
  readonly plainCloses?: boolean;
  /**
   * The text a destination really holds, given its offsets in
   * `textBeforeCaret`. The reader matches against a projection in which an
   * escaped character is a placeholder, so the captured destination is not
   * the URL -- `Mercury_\(planet\)` was captured with a placeholder for each
   * paren and became `Mercury_%00planet%00`. Typing projects a code run's
   * characters the same way and passes this for the same reason. Without it
   * the capture is taken as the URL, which is right only for unprojected text.
   */
  readonly destination?: (from: number, to: number) => string;
}

/**
 * {@link matchInlineRule}, told what else is known about the line.
 *
 * The Markdown reader passes the lookahead and a `destination` reader. Typing
 * goes through {@link matchInlineRule} when the block holds no code run, and
 * here with only `destination` when it does, because its text is then a
 * projection with code characters as placeholders. Not part of the package's
 * public surface.
 */
export function matchInlineRuleAhead(
  textBeforeCaret: string,
  ahead: LineAhead,
): InlineRuleMatch | null {
  // One character past the window, so the lookbehinds see what really precedes
  // a candidate opening delimiter rather than the cut.
  const offset = Math.max(0, textBeforeCaret.length - INLINE_SPAN_LIMIT - 1);
  const window = offset === 0 ? textBeforeCaret : textBeforeCaret.slice(offset);
  const closer = textBeforeCaret.at(-1);
  let inDestination: boolean | undefined;

  for (const rule of INLINE_RULES) {
    // A rule that does not end in this character cannot match here, and running
    // it anyway is not free: the link patterns walk the window from every `[`
    // in it, which is most of the cost of parsing a line of stray brackets.
    if (rule.closer !== closer) {
      continue;
    }

    // Both link patterns need a `](` behind the caret. `linkOpener` finds the
    // earliest `[` a match could start at with two index scans, so the regex
    // is not restarted from every bracket in the window -- that turned a line
    // of unpaired brackets, `[0, 1) [1, 2) ...`, into a second of work per
    // paste. It is computed, not guessed: a destination may hold `](` of its
    // own (`[see](<https://…?q=[foo](bar)>)`, which this editor writes), so
    // taking the last one put the opener inside the URL, and trying
    // candidates in turn needed a cap that lost the link once a URL carried
    // enough of them. The pattern is not anchored there: it searches forward
    // from that `[`, which is what finds `[b](…)` after a `](<` that never
    // closes -- and also an inner pair inside one that does, which the check
    // below refuses. Do not anchor it.
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

    // A plain link inside a bracketed destination that is still open is part
    // of that URL: CommonMark parses the destination at the outer `]`. Since
    // the plain form stopped admitting `<`, its pattern no longer matched at
    // the outer `[` and searched on to the inner pair, so
    // `[see](<https://x.test/?q=[foo](https://y.test/)>)` -- this editor's own
    // output -- came back as a link to `?q=foo`. The angled branch of the
    // destination test is the whole question here: the window ends in `)`.
    if (rule.isLink && !rule.angled && insideDestination(window, index, ahead)) {
      continue;
    }

    // Asked only once a mark rule has matched, which in prose is rare, and
    // cached for the rules after it: the answer depends on the caret alone.
    // The code rule asks its own question -- a hinge inside the span it is
    // closing does not count -- and is the only rule closing on a backtick,
    // so nothing else could share its answer.
    if (
      !rule.isLink &&
      (rule.mark === 'code'
        ? insideDestination(window, index, ahead)
        : (inDestination ??= insideDestination(window, window.length, ahead)))
    ) {
      continue;
    }

    // A match starting on the cut is the one place the lookbehind has no
    // context, so it is not trusted; it would span the window entirely anyway.
    if (offset > 0 && index === 0) {
      continue;
    }

    let link: string | undefined;

    if (rule.isLink) {
      const captured = match[2] ?? '';
      // The destination is the end of the match, before `)` or `>)`.
      const to = offset + window.length - (rule.angled ? 2 : 1);
      const href = sanitizeUrl(
        ahead.destination ? ahead.destination(to - captured.length, to) : captured,
      );

      // An unsafe or unparseable URL leaves the literal text alone.
      if (!href) {
        continue;
      }

      link = href;
    }

    // The delimiters are whatever surrounds the captured inner text -- found by
    // the rule's own opening length, never by `whole.indexOf(inner)`. For
    // `<u>u</u>` that found the `u` inside `<u>`: the plain text came out the
    // same, but the content's own `u` was deleted as delimiter, and any
    // formatting it carried with it (`<u>**u**</u>` lost its bold).
    const openLength = rule.open;
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
