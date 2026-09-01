/**
 * @neditor/core — a framework-agnostic, Notion-like block editor.
 *
 * ```ts
 * import { createEditor } from '@neditor/core';
 *
 * const editor = createEditor({ element: '#editor', autofocus: true });
 * editor.on('change', (doc) => localStorage.setItem('doc', JSON.stringify(doc)));
 * ```
 */

export type { NEditorLabels } from './labels.ts';
export { DEFAULT_LABELS, resolveLabels } from './labels.ts';
export { NEditor } from './editor.ts';
// Reachable through NEditorOptions and SelectionState, so they have to be
// importable: `import type { NEditorTheme }` otherwise fails with TS2459.
export type { PortalTheme as NEditorTheme } from './ui/portal.ts';
export type { OffsetRange } from './view/selection.ts';
export type { NEditorEvents, NEditorOptions, SelectionState } from './editor.ts';

export type { Block, BlockType, NEditorDocument } from './model/document.ts';
export type { HistoryEntry, HistoryState, SelectionSnapshot } from './model/history.ts';
export {
  DEFAULT_CALLOUT_ICON,
  acceptsChildren,
  blockIdRange,
  blockText,
  cloneBlock,
  cloneDocument,
  computeListNumbers,
  createBlock,
  createEmptyDocument,
  descendantsOf,
  duplicateBlocks,
  hiddenBlockIds,
  indentBlocks,
  isTableType,
  moveBlocks,
  normalizeDepths,
  normalizeDocument,
  removeBlocks,
  richToMarkdown,
  sliceDocument,
  toMarkdown,
  visibleBlocks,
  withHiddenDescendants,
} from './model/document.ts';

export type { TableRows, TableSize } from './model/table.ts';
export {
  createTableRows,
  normalizeTableRows,
  tableCell,
  tableDeleteColumn,
  tableDeleteRow,
  tableInsertColumn,
  tableInsertRow,
  tableSetCell,
  tableSize,
  tableStep,
} from './model/table.ts';
export type { Mark, RichText, TextRun } from './model/rich-text.ts';
export {
  MARKS,
  isRichEmpty,
  normalizeRuns,
  richActiveLink,
  richActiveMarks,
  richConcat,
  richDelete,
  richEquals,
  richFromPlainText,
  richInsert,
  richLength,
  richSetLink,
  richSetMark,
  richSlice,
  richSplit,
  richToPlainText,
  richToggleMark,
} from './model/rich-text.ts';

export { INPUT_RULES, matchInputRule } from './input/input-rules.ts';
export type { InputRule, InputRuleMatch } from './input/input-rules.ts';

export { matchInlineRule } from './input/inline-rules.ts';
export { blocksFromMarkdown, parseInlineMarkdown } from './input/markdown.ts';
export type { InlineRuleMatch } from './input/inline-rules.ts';

export { SLASH_COMMANDS, filterCommands } from './ui/slash-menu.ts';
export type { SlashCommand } from './ui/slash-menu.ts';

export {
  blocksFromHtml,
  blocksToHtml,
  parseRichText,
  parseRichTextFromHtml,
  renderRichText,
} from './view/rich-dom.ts';
export { sanitizeImageUrl, sanitizeUrl } from './util/url.ts';

export { NEDITOR_STYLES, injectStyles } from './styles.ts';

import { NEditor } from './editor.ts';
import type { NEditorOptions } from './editor.ts';

/** Convenience factory. Equivalent to `new NEditor(options)`. */
export function createEditor(options: NEditorOptions): NEditor {
  return new NEditor(options);
}
