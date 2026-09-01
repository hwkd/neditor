import type { BlockType } from '../model/document.ts';

/**
 * Markdown input rules.
 *
 * A prefix becomes a block type the moment you type the trailing
 * space (`# ` becomes a heading). The rule set is data, not control flow, so
 * new shortcuts are one array entry.
 */

export interface InputRule {
  /** Must match from the start of the block text. */
  readonly pattern: RegExp;
  readonly type: BlockType;
}

export const INPUT_RULES: readonly InputRule[] = [
  { pattern: /^# $/, type: 'heading1' },
  { pattern: /^## $/, type: 'heading2' },
  { pattern: /^### $/, type: 'heading3' },
  { pattern: /^[-*+] $/, type: 'bulleted_list' },
  { pattern: /^\d+[.)] $/, type: 'numbered_list' },
  { pattern: /^> $/, type: 'quote' },
  { pattern: /^\[[ xX]?\] $/, type: 'todo' },
  { pattern: /^```$/, type: 'code' },
  { pattern: /^(?:---|\*\*\*)$/, type: 'divider' },
];

export interface InputRuleMatch {
  readonly type: BlockType;
  /** Text remaining after the prefix is consumed. */
  readonly rest: string;
}

/**
 * Tests the text before the caret against every rule.
 *
 * Only the prefix is examined, so a rule fires exactly once, as the caret
 * leaves the prefix, and never mid-sentence.
 */
export function matchInputRule(textBeforeCaret: string, fullText: string): InputRuleMatch | null {
  for (const rule of INPUT_RULES) {
    if (rule.pattern.test(textBeforeCaret)) {
      return { type: rule.type, rest: fullText.slice(textBeforeCaret.length) };
    }
  }

  return null;
}
