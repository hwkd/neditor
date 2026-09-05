/**
 * `@neditor/core/model` — the document, without the editor.
 *
 * ```ts
 * import { blocksFromMarkdown, normalizeDocument, toMarkdown } from '@neditor/core/model';
 *
 * const doc = normalizeDocument({ blocks: blocksFromMarkdown('# Title\n\nBody') });
 * const markdown = toMarkdown(doc);
 * ```
 *
 * Nothing reachable from here touches the DOM, and — unlike the main entry —
 * the declarations this emits name no DOM type, so they carry no
 * `/// <reference lib="dom" />`. That directive is infectious: a triple-slash
 * reference in a dependency pulls `lib.dom` into the consumer's whole program
 * with no way to suppress it, which breaks a Cloudflare Workers or other edge
 * build the moment one file imports the package — the conflicting globals are
 * reported against the consumer's own code, naming nothing from here.
 *
 * The main entry still needs it, because `NEditorOptions` names `HTMLElement`
 * and the serializers name `Document` and `Node`; a consumer who mounts an
 * editor has a DOM by definition. This entry is for the ones who do not: a
 * server rendering stored documents to Markdown, a worker validating them, a
 * build step converting them.
 */

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
export type { InlineRuleMatch } from './input/inline-rules.ts';
export { blocksFromMarkdown, parseInlineMarkdown } from './input/markdown.ts';

export { sanitizeImageUrl, sanitizeUrl } from './util/url.ts';

// Deliberately not `NEDITOR_STYLES`. It is only a string, but it lives beside
// `injectStyles`, whose signature names `Document | ShadowRoot | Element` —
// and re-exporting its neighbour put that declaration into this entry's shared
// chunk, which is exactly the DOM dependency this entry exists to avoid.
// A server that wants the stylesheet reads the `dist/styles.css` the package
// already ships, or takes it from the main entry where the DOM is a given.
