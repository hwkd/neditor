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
  /** Anchored at the caret. Capture group 1 is the inner text. */
  readonly pattern: RegExp;
  readonly mark?: Mark;
  /** Capture group 2 is the href. */
  readonly isLink?: boolean;
}

const INLINE_RULES: readonly InlineRule[] = [
  // Bold before italic: `**x**` must not be read as an italic `*x*`.
  { pattern: /\*\*([^*\n]+)\*\*$/, mark: 'bold' },
  { pattern: /__([^_\n]+)__$/, mark: 'bold' },
  // Only the opening `*` of a longer run is refused, so `***x***` closes as
  // bold and then as italic. A word character before it is not a reason to
  // refuse: CommonMark restricts intra-word emphasis to `_`, and `toMarkdown`
  // writes `*x*` whatever precedes it, so refusing left `Chapter*One*` sitting
  // in the text as literal asterisks.
  { pattern: /(?<!\*)\*([^*\n]+)\*$/, mark: 'italic' },
  { pattern: /(?<![_\w])_([^_\n]+)_$/, mark: 'italic' },
  { pattern: /~~([^~\n]+)~~$/, mark: 'strikethrough' },
  { pattern: /`([^`\n]+)`$/, mark: 'code' },
  // Markdown has no underline, so `toMarkdown` writes the HTML tag; this is
  // what reads it back rather than leaving seven junk characters in the text.
  { pattern: /<u>([^<\n]+)<\/u>$/, mark: 'underline' },
  // The angle-bracket form first: it is how a destination holding a `)` — the
  // character that would otherwise close the link — is written.
  { pattern: /\[([^\]\n]+)\]\(<([^<>\n]*)>\)$/, isLink: true },
  { pattern: /\[([^\]\n]+)\]\(([^)\s]+)\)$/, isLink: true },
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
export function matchInlineRule(textBeforeCaret: string): InlineRuleMatch | null {
  // One character past the window, so the lookbehinds see what really precedes
  // a candidate opening delimiter rather than the cut.
  const offset = Math.max(0, textBeforeCaret.length - INLINE_SPAN_LIMIT - 1);
  const window = offset === 0 ? textBeforeCaret : textBeforeCaret.slice(offset);

  for (const rule of INLINE_RULES) {
    const match = rule.pattern.exec(window);
    const whole = match?.[0];
    const inner = match?.[1];

    if (!match || whole === undefined || inner === undefined || inner.length === 0) {
      continue;
    }

    // A match starting on the cut is the one place the lookbehind has no
    // context, so it is not trusted; it would span the window entirely anyway.
    if (offset > 0 && match.index === 0) {
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
      start: offset + match.index,
      end: offset + match.index + whole.length,
      openLength,
      closeLength,
      mark: rule.mark,
      link,
    };
  }

  return null;
}
