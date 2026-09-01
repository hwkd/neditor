import type { Mark } from '../model/rich-text.ts';
import { sanitizeUrl } from '../util/url.ts';

/**
 * Inline Markdown rules.
 *
 * These fire the moment the closing delimiter is typed, the way Notion turns
 * `**word**` into bold text as you finish it. A rule reports *offsets* rather
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
  { pattern: /(?<![*\w])\*([^*\n]+)\*$/, mark: 'italic' },
  { pattern: /(?<![_\w])_([^_\n]+)_$/, mark: 'italic' },
  { pattern: /~~([^~\n]+)~~$/, mark: 'strikethrough' },
  { pattern: /`([^`\n]+)`$/, mark: 'code' },
  // Markdown has no underline, so `toMarkdown` writes the HTML tag; this is
  // what reads it back rather than leaving seven junk characters in the text.
  { pattern: /<u>([^<\n]+)<\/u>$/, mark: 'underline' },
  { pattern: /\[([^\]\n]+)\]\(([^)\s]+)\)$/, isLink: true },
];

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
  for (const rule of INLINE_RULES) {
    const match = rule.pattern.exec(textBeforeCaret);
    const whole = match?.[0];
    const inner = match?.[1];

    if (!match || whole === undefined || inner === undefined || inner.length === 0) {
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
      start: match.index,
      end: match.index + whole.length,
      openLength,
      closeLength,
      mark: rule.mark,
      link,
    };
  }

  return null;
}
