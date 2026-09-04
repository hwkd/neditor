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

// SlashCommandLabel is reachable through NEditorLabels.slashCommands, so it is
// re-exported for the same reason NEditorTheme is: a name a consumer's own
// signatures can hold is part of the surface, and without it declaration emit
// hands them a type they cannot write down.
export type { NEditorLabels, SlashCommandLabel } from './labels.ts';
export { DEFAULT_LABELS, resolveLabels } from './labels.ts';
export { NEditor } from './editor.ts';
// Reachable through NEditorOptions and SelectionState, so they have to be
// importable: `import type { NEditorTheme }` otherwise fails with TS2459.
export type { PortalTheme as NEditorTheme } from './ui/portal.ts';
export type { OffsetRange } from './view/selection.ts';
export type { NEditorEvents, NEditorOptions, SelectionState } from './editor.ts';

/**
 * Where a table cell sits, row-major, as `focusRange` takes it.
 *
 * A plain re-export of the interface `editor.ts` exports. It was once derived
 * instead — `NonNullable<Parameters<NEditor['focusRange']>[3]>` — so the public
 * name could not drift from the parameter it stands for. That reads well from
 * inside and is broken from outside: the alias exports a name, not the
 * interface the signature actually names, so declaration emit called that one
 * `CellCoords$1` and every consumer naming it failed with TS4023. Export the
 * interface itself, or there is nothing for a consumer to name. `scripts/
 * check-dts.mjs` compiles a consumer against the packed tarball to keep it so.
 */
export type { CellCoords } from './editor.ts';

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
  moveVisibleBlocks,
  normalizeDepths,
  normalizeDocument,
  removeBlocks,
  richToMarkdown,
  sameBlocks,
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
