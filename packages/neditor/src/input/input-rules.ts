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
  /** For a to-do: whether the prefix wrote it as already done (`[x] `). */
  readonly checked?: boolean;
}

export const INPUT_RULES: readonly InputRule[] = [
  { pattern: /^# $/, type: 'heading1' },
  { pattern: /^## $/, type: 'heading2' },
  { pattern: /^### $/, type: 'heading3' },
  { pattern: /^[-*+] $/, type: 'bulleted_list' },
  { pattern: /^\d+[.)] $/, type: 'numbered_list' },
  { pattern: /^> $/, type: 'quote' },
  { pattern: /^\[ ?\] $/, type: 'todo' },
  // `[x]` is "done" here exactly as it is in the Markdown this editor reads
  // back; one rule for both spellings accepted the x and then dropped it.
  { pattern: /^\[[xX]\] $/, type: 'todo', checked: true },
  { pattern: /^```$/, type: 'code' },
  // `***` waits for a space: fired on the third star it took the opening of
  // `***bold italic***` and made a divider of it. `---` has no such reading.
  { pattern: /^(?:---|\*\*\* )$/, type: 'divider' },
];

export interface InputRuleMatch {
  readonly type: BlockType;
  /** Text remaining after the prefix is consumed. */
  readonly rest: string;
  /** Set when the rule created a to-do that starts done. */
  readonly checked?: boolean;
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
      const rest = fullText.slice(textBeforeCaret.length);

      return rule.checked ? { type: rule.type, rest, checked: true } : { type: rule.type, rest };
    }
  }

  return null;
}
