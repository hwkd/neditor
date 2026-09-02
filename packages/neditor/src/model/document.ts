import { sanitizeImageUrl } from '../util/url.ts';
import { createBlockId } from './ids.ts';
import type { Mark, RichText, TextRun } from './rich-text.ts';
import type { TableRows } from './table.ts';
import {
  cloneTableRows,
  createTableRows,
  normalizeTableRows,
  tableSetCell,
  tableSize,
} from './table.ts';
import {
  cloneRichText,
  isRichEmpty,
  normalizeRuns,
  richFromPlainText,
  richLength,
  richToPlainText,
} from './rich-text.ts';

/**
 * The document model.
 *
 * A page is a flat table of blocks joined by parent/child
 * pointers rather than a nested tree. We keep a flat, ordered list for the same
 * reason: every structural edit stays O(1)-ish and reorder never rewrites a
 * subtree. Nesting is expressed by `depth` so indent/outdent is a numeric edit
 * instead of a tree surgery.
 */

export type BlockType =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulleted_list'
  | 'numbered_list'
  | 'todo'
  | 'quote'
  | 'code'
  | 'callout'
  | 'toggle'
  | 'image'
  | 'table'
  | 'divider';

export interface Block {
  /** Stable, opaque identity. See {@link createBlockId}. */
  id: string;
  type: BlockType;
  /** Formatted text as a list of runs. See `model/rich-text.ts`. */
  content: RichText;
  /** Indentation level. 0 is top level. */
  depth: number;
  /** Only meaningful for `todo` blocks. */
  checked?: boolean;
  /** Only meaningful for `callout` blocks. A single emoji. */
  icon?: string;
  /** Only meaningful for `toggle` blocks. Hides everything nested under it. */
  collapsed?: boolean;
  /** Only meaningful for `image` blocks. Sanitized before it is stored. */
  src?: string;
  /** Only meaningful for `image` blocks. */
  alt?: string;
  /**
   * Only meaningful for `table` blocks. Row-major, always rectangular.
   * Row 0 is the header.
   */
  rows?: TableRows;
}

export interface NEditorDocument {
  blocks: Block[];
}

/** A block as it may arrive from storage, including the pre-rich-text shape. */
type LegacyBlock = Partial<Block> & { text?: unknown };

/** Block types that continue themselves when you press Enter. */
const CONTINUING_TYPES = new Set<BlockType>(['bulleted_list', 'numbered_list', 'todo']);

/** Block types that hold no text of their own and cannot receive a caret. */
const VOID_TYPES = new Set<BlockType>(['divider']);

/** Block types whose text lives somewhere other than `content`. */
const GRID_TYPES = new Set<BlockType>(['table']);

export function isTableType(type: BlockType): boolean {
  return GRID_TYPES.has(type);
}

/**
 * Block types that own what is nested under them.
 *
 * Pressing Enter in one of these opens a child rather than a sibling, which is
 * the only way to put the first block inside an empty callout or toggle.
 */
const CHILD_ACCEPTING_TYPES = new Set<BlockType>(['callout', 'toggle']);

export const DEFAULT_CALLOUT_ICON = '\u{1F4A1}';

/**
 * Deepest nesting a document may reach.
 *
 * Depth becomes an indent string in Markdown and a CSS length in the DOM, so an
 * absurd value from storage is a denial of service rather than a deep list.
 *
 * It bounds edits as well as loads. Enforcing it only on the way in made it a
 * silent data loss instead of a limit: the editor was happy to indent past 32,
 * and `normalizeDocument` then flattened every one of those levels back to 32
 * on the next load, so nesting the user could see disappeared on reload.
 * {@link normalizeDepths} applies it, which every structural edit runs through.
 */
export const MAX_DEPTH = 32;

/** Every type the editor can render. Anything else is coerced to a paragraph. */
const BLOCK_TYPES = new Set<BlockType>([
  'paragraph',
  'heading1',
  'heading2',
  'heading3',
  'bulleted_list',
  'numbered_list',
  'todo',
  'quote',
  'code',
  'callout',
  'toggle',
  'image',
  'table',
  'divider',
]);

export function isBlockType(value: unknown): value is BlockType {
  return typeof value === 'string' && BLOCK_TYPES.has(value as BlockType);
}

/** Marks that a code block ignores, since its text is already monospace. */
const CODE_BLOCK_STRIPS_MARKS = true;

export function isContinuingType(type: BlockType): boolean {
  return CONTINUING_TYPES.has(type);
}

export function isVoidType(type: BlockType): boolean {
  return VOID_TYPES.has(type);
}

export function acceptsChildren(type: BlockType): boolean {
  return CHILD_ACCEPTING_TYPES.has(type);
}

/**
 * Whether a block's text can be merged with a neighbour's.
 *
 * A table keeps its text in `rows` and an image in `src`/`alt`, neither of which
 * `content` can carry — so merging one into a paragraph does not join two texts,
 * it destroys a block. Backspace and Delete must select such a neighbour rather
 * than absorb it.
 */
export function canMergeText(type: BlockType): boolean {
  return !isVoidType(type) && !isTableType(type) && type !== 'image';
}

/**
 * The contiguous run of blocks nested under `id`.
 *
 * Depth is a number rather than a tree, so a block's children are simply the
 * blocks that follow it while staying deeper than it.
 */
export function descendantsOf(blocks: readonly Block[], id: string): string[] {
  const index = findBlockIndex(blocks, id);
  const parent = blocks[index];

  if (!parent) {
    return [];
  }

  const out: string[] = [];

  for (const block of blocks.slice(index + 1)) {
    if (block.depth <= parent.depth) {
      break;
    }

    out.push(block.id);
  }

  return out;
}

/**
 * Blocks hidden inside a collapsed toggle.
 *
 * One threshold is enough: everything deeper than the outermost collapsed
 * toggle is hidden, including any toggle nested within it.
 */
export function hiddenBlockIds(blocks: readonly Block[]): Set<string> {
  const hidden = new Set<string>();
  let hideBelow: number | null = null;

  for (const block of blocks) {
    if (hideBelow !== null && block.depth > hideBelow) {
      hidden.add(block.id);
      continue;
    }

    hideBelow = block.type === 'toggle' && block.collapsed === true ? block.depth : null;
  }

  return hidden;
}

/** The blocks a reader can actually see. */
export function visibleBlocks(blocks: readonly Block[]): Block[] {
  const hidden = hiddenBlockIds(blocks);

  return blocks.filter((block) => !hidden.has(block.id));
}

/**
 * Grows a selection to cover blocks it hides.
 *
 * A collapsed toggle's children are invisible, so any operation on the toggle —
 * move, delete, copy — has to carry them along or they are silently orphaned.
 *
 * What matters is which selected block does the hiding, not whether a block
 * happens to be hidden by something else. Testing descendants against the
 * document-wide hidden set instead pulls a grandchild out from under a
 * collapsed toggle that is *not* selected: select an expanded toggle holding a
 * collapsed one and the set became {outer, grandchild}, so deleting it took a
 * block the user could neither see nor select and left the collapsed toggle
 * behind, empty.
 *
 * A collapsed toggle hides its whole contiguous run, so one pass is enough —
 * a toggle nested inside another is already covered by the outer one's run.
 */
export function withHiddenDescendants(
  blocks: readonly Block[],
  ids: Iterable<string>,
): Set<string> {
  const out = new Set(ids);

  for (const id of [...out]) {
    const block = findBlock(blocks, id);

    if (block?.type !== 'toggle' || block.collapsed !== true) {
      continue;
    }

    for (const child of descendantsOf(blocks, id)) {
      out.add(child);
    }
  }

  return out;
}

/**
 * Moves a selection one *visible* slot up or down.
 *
 * The step is measured in visible blocks rather than array entries, because
 * those are two different orders. A collapsed toggle occupies one slot however
 * many blocks it hides: what moves carries its hidden children, and so does the
 * block it steps over. Stepping in raw array coordinates instead swaps a
 * collapsed toggle with its own first child — which then pops out as a
 * top-level block — or drops a neighbour into the gap between a toggle and the
 * children it hides, where the next depth clamp adopts it.
 */
export function moveVisibleBlocks(
  blocks: readonly Block[],
  ids: ReadonlySet<string>,
  direction: 1 | -1,
): Block[] {
  const moving = withHiddenDescendants(blocks, ids);
  const visible = visibleBlocks(blocks);
  const selected = visible.filter((block) => moving.has(block.id));
  const first = selected[0];
  const last = selected.at(-1);

  if (!first || !last) {
    return [...blocks];
  }

  const from = findBlockIndex(visible, first.id);
  const to = findBlockIndex(visible, last.id);

  if (from === -1 || to === -1) {
    return [...blocks];
  }

  // Nothing to step over: already against the edge of the document.
  if (!visible[direction === -1 ? from - 1 : to + 1]) {
    return [...blocks];
  }

  // The landing gap, in full-document coordinates. Going up that is the slot
  // the block above occupies; going down it is the slot two below, which is the
  // first position past the stepped-over block *and* everything it hides.
  const landing = direction === -1 ? visible[from - 1] : visible[to + 2];

  return moveBlocks(blocks, moving, landing ? findBlockIndex(blocks, landing.id) : blocks.length);
}

/** Plain-text projection of a block, for measuring and for input rules. */
export function blockText(block: Block): string {
  if (block.type === 'table') {
    return (block.rows ?? []).map((row) => row.map(richToPlainText).join('\t')).join('\n');
  }

  return richToPlainText(block.content);
}

export function blockLength(block: Block): number {
  return richLength(block.content);
}

export function createBlock(
  type: BlockType = 'paragraph',
  content: RichText | string = [],
  depth = 0,
): Block {
  const block: Block = {
    id: createBlockId(),
    type,
    content: typeof content === 'string' ? richFromPlainText(content) : normalizeRuns(content),
    depth,
  };

  if (type === 'todo') {
    block.checked = false;
  }

  if (type === 'callout') {
    block.icon = DEFAULT_CALLOUT_ICON;
  }

  if (type === 'toggle') {
    block.collapsed = false;
  }

  if (type === 'image') {
    block.src = '';
    block.alt = '';
  }

  if (type === 'table') {
    block.rows = createTableRows();
  }

  return block;
}

export function createEmptyDocument(): NEditorDocument {
  return { blocks: [createBlock('paragraph')] };
}

/** Deep copy, so callers cannot mutate editor state by reference. */
export function cloneDocument(doc: NEditorDocument): NEditorDocument {
  return { blocks: doc.blocks.map(cloneBlock) };
}

/** Deep copy of one block, including a table's grid. */
export function cloneBlock(block: Block): Block {
  const copy: Block = { ...block, content: cloneRichText(block.content) };

  if (block.rows) {
    copy.rows = cloneTableRows(block.rows);
  }

  return copy;
}

/** Coerces anything that might be block content into canonical runs. */
function normalizeContent(input: unknown, legacyText: unknown): RichText {
  if (Array.isArray(input)) {
    return normalizeRuns(input as TextRun[]);
  }

  // Documents written before rich text stored a plain `text` string.
  if (typeof legacyText === 'string') {
    return richFromPlainText(legacyText);
  }

  if (typeof input === 'string') {
    return richFromPlainText(input);
  }

  return [];
}

/**
 * Normalizes a document coming from the outside world: fills in missing
 * fields, migrates the pre-rich-text `text` string, and guarantees at least one
 * editable block.
 */
/** A stored id, or a fresh one when it is missing, empty, or already taken. */
function uniqueId(id: unknown, seen: Set<string>): string {
  const candidate = typeof id === 'string' && id.length > 0 && !seen.has(id) ? id : createBlockId();

  seen.add(candidate);

  return candidate;
}

export function normalizeDocument(doc: Partial<NEditorDocument> | undefined): NEditorDocument {
  // Ids address every model operation and key the renderer's view map, so a
  // duplicate makes one block unrenderable while `updateBlock` writes to both.
  // Nothing downstream can recover from it, so it is repaired at the boundary.
  const seen = new Set<string>();

  // `blocks` is the one field a caller cannot get wrong quietly: an object map
  // or a JSON string has no `.filter`, so trusting the declared type threw a
  // TypeError out of `createEditor` instead of degrading. Every other field
  // here is coerced rather than trusted; so is this one.
  const stored: LegacyBlock[] = Array.isArray(doc?.blocks) ? (doc.blocks as LegacyBlock[]) : [];

  const blocks = stored
    .filter((block): block is LegacyBlock => Boolean(block))
    .map((block) => {
      // An unknown type would reach lookup tables and element factories, so it
      // degrades to the one type that can hold any content.
      const type = isBlockType(block.type) ? block.type : 'paragraph';
      const normalized: Block = {
        id: uniqueId(block.id, seen),
        type,
        content: isVoidType(type) ? [] : normalizeContent(block.content, block.text),
        depth: Number.isFinite(block.depth)
          ? Math.min(MAX_DEPTH, Math.max(0, Math.trunc(block.depth as number)))
          : 0,
      };

      if (normalized.type === 'todo') {
        normalized.checked = block.checked === true;
      }

      if (normalized.type === 'callout') {
        normalized.icon =
          typeof block.icon === 'string' && block.icon.length > 0
            ? block.icon
            : DEFAULT_CALLOUT_ICON;
      }

      if (normalized.type === 'toggle') {
        normalized.collapsed = block.collapsed === true;
      }

      if (normalized.type === 'image') {
        // An unsafe src is dropped rather than rendered.
        normalized.src = typeof block.src === 'string' ? (sanitizeImageUrl(block.src) ?? '') : '';
        normalized.alt = typeof block.alt === 'string' ? block.alt : '';
      }

      if (normalized.type === 'table') {
        normalized.rows = normalizeTableRows(block.rows);
      }

      return normalized;
    });

  // Imported documents have never been through the indent invariant that every
  // internal edit maintains, so establish it here rather than trusting it.
  return blocks.length > 0 ? { blocks: normalizeDepths(blocks) } : createEmptyDocument();
}

export function findBlockIndex(blocks: readonly Block[], id: string): number {
  return blocks.findIndex((block) => block.id === id);
}

export function findBlock(blocks: readonly Block[], id: string): Block | undefined {
  return blocks.find((block) => block.id === id);
}

/* -------------------------------------------------------------------------- */
/* Pure structural edits. Every one returns a new array.                       */
/* -------------------------------------------------------------------------- */

export function insertBlockAt(blocks: readonly Block[], index: number, block: Block): Block[] {
  const next = [...blocks];
  next.splice(Math.max(0, Math.min(index, next.length)), 0, block);
  return next;
}

export function insertBlockAfter(blocks: readonly Block[], afterId: string, block: Block): Block[] {
  const index = findBlockIndex(blocks, afterId);
  return insertBlockAt(blocks, index === -1 ? blocks.length : index + 1, block);
}

export function removeBlock(blocks: readonly Block[], id: string): Block[] {
  return blocks.filter((block) => block.id !== id);
}

export function updateBlock(
  blocks: readonly Block[],
  id: string,
  patch: Partial<Omit<Block, 'id'>>,
): Block[] {
  return blocks.map((block) => (block.id === id ? { ...block, ...patch } : block));
}

/** Converts a block to another type, clearing state that does not apply. */
export function setBlockType(blocks: readonly Block[], id: string, type: BlockType): Block[] {
  return blocks.map((block) => {
    if (block.id !== id) {
      return block;
    }

    const next: Block = { ...block, type, content: block.content };

    if (type === 'todo') {
      next.checked = block.checked ?? false;
    } else {
      delete next.checked;
    }

    if (type === 'callout') {
      next.icon = block.icon ?? DEFAULT_CALLOUT_ICON;
    } else {
      delete next.icon;
    }

    if (type === 'toggle') {
      next.collapsed = block.collapsed ?? false;
    } else {
      delete next.collapsed;
    }

    if (type === 'image') {
      next.src = block.src ?? '';
      next.alt = block.alt ?? '';
    } else {
      delete next.src;
      delete next.alt;
    }

    if (type === 'table') {
      next.rows = block.rows ? cloneTableRows(block.rows) : createTableRows();

      // A table draws its rows and nothing else, so text carried in from the
      // old type would disappear from the page while still sitting in the
      // model — invisible to the reader, and dropped by `toMarkdown` and
      // `blocksToHtml` alike. It moves into the first cell instead, which is
      // also where `focus(id)` puts the caret.
      if (!block.rows) {
        next.rows = tableSetCell(next.rows, 0, 0, block.content);
      }
    } else {
      delete next.rows;
    }

    // `content` is the whole payload of a text block, and none of a grid's or a
    // divider's: leaving text there is how it goes missing.
    if (isVoidType(type) || isTableType(type)) {
      next.content = [];
    } else if (type === 'code' && CODE_BLOCK_STRIPS_MARKS) {
      // A code block is uniformly monospace, so inline marks would be noise.
      next.content = normalizeRuns(next.content.map((run) => ({ text: run.text, link: run.link })));
    }

    return next;
  });
}

export function moveBlock(blocks: readonly Block[], id: string, delta: number): Block[] {
  const index = findBlockIndex(blocks, id);

  if (index === -1) {
    return [...blocks];
  }

  const target = index + delta;

  if (target < 0 || target >= blocks.length) {
    return [...blocks];
  }

  const next = [...blocks];
  const [moved] = next.splice(index, 1);

  if (moved) {
    next.splice(target, 0, moved);
  }

  // Re-clamped like every other structural op. Without this a block moved above
  // its parent keeps a depth nothing supports — the first block in the document
  // sitting at depth 1, indented under nothing.
  return normalizeDepths(next);
}

/** Clamps indentation so a block can never be more than one level below its predecessor. */
export function indentBlock(blocks: readonly Block[], id: string, delta: number): Block[] {
  const index = findBlockIndex(blocks, id);
  const block = blocks[index];

  if (!block) {
    return [...blocks];
  }

  const previous = index > 0 ? blocks[index - 1] : undefined;
  // `normalizeDepths` would clamp to MAX_DEPTH below anyway, but not before
  // this function had already decided the depth changed — and a Tab that only
  // rebuilds the block at the depth it was reads as an edit to `sameBlocks`,
  // which is an undo entry for a keystroke that did nothing.
  const maxDepth = Math.min(MAX_DEPTH, previous ? previous.depth + 1 : 0);
  const depth = Math.max(0, Math.min(block.depth + delta, maxDepth));

  if (depth === block.depth) {
    return [...blocks];
  }

  // Re-clamped like every other structural op: outdenting a parent otherwise
  // leaves its children two levels deep, and they jump left later when an
  // unrelated edit happens to re-normalize.
  return normalizeDepths(updateBlock(blocks, id, { depth }));
}

/**
 * The block type a new block should get when Enter is pressed inside `type`.
 * Lists and to-dos continue themselves; everything else falls back to a paragraph.
 */
export function typeAfterSplit(type: BlockType): BlockType {
  return isContinuingType(type) ? type : 'paragraph';
}

/**
 * Numbers consecutive `numbered_list` blocks at the same depth, the way an
 * ordered list restarts once another block type interrupts it.
 */
export function computeListNumbers(blocks: readonly Block[]): Map<string, number> {
  const numbers = new Map<string, number>();
  const counters = new Map<number, number>();

  for (const block of blocks) {
    if (block.type !== 'numbered_list') {
      // Only the levels this block interrupts. Clearing everything meant an
      // indented note under item 1 restarted the outer list at 1 again.
      for (const depth of [...counters.keys()]) {
        if (depth >= block.depth) {
          counters.delete(depth);
        }
      }

      continue;
    }

    // A deeper list restarts; shallower siblings reset anything nested below.
    for (const depth of [...counters.keys()]) {
      if (depth > block.depth) {
        counters.delete(depth);
      }
    }

    const next = (counters.get(block.depth) ?? 0) + 1;
    counters.set(block.depth, next);
    numbers.set(block.id, next);
  }

  return numbers;
}

/* -------------------------------------------------------------------------- */
/* Multi-block operations                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Clamps every block so it is never more than one level deeper than the block
 * above it, nor deeper than {@link MAX_DEPTH}.
 *
 * Depth is stored per block rather than as a tree, which keeps reordering
 * cheap but means a move can leave an orphan indented under nothing. Re-running
 * this after any structural change restores the invariant.
 *
 * The ceiling belongs here rather than only in `normalizeDocument`, because
 * this is the one function every structural edit ends in: a limit applied on
 * load alone is not a limit, it is a document that changes shape when reloaded.
 */
export function normalizeDepths(blocks: readonly Block[]): Block[] {
  let previousDepth = -1;

  return blocks.map((block) => {
    const depth = Math.max(0, Math.min(block.depth, previousDepth + 1, MAX_DEPTH));
    previousDepth = depth;

    return depth === block.depth ? block : { ...block, depth };
  });
}

/**
 * Whether two block arrays are the same document.
 *
 * Every operation in this module returns a *fresh* array even when it changed
 * nothing — `moveBlock` against the top of the document, a drag dropped back
 * into its own gap, `indentBlock` at depth 0 — so the array's own identity
 * proves nothing at all. The blocks' identities do: an untouched block is
 * reused by reference (`normalizeDepths` included), so the same objects, in the
 * same order, in an array of the same length is by construction the same
 * document. That is one pointer compare per block, cheap enough to run before
 * every commit, which is where it belongs: a caller that cannot tell a no-op
 * from an edit records undo history for keystrokes that did nothing.
 *
 * It is deliberately conservative in the other direction. A rebuilt-but-equal
 * block counts as a change, because proving deep equality costs more than the
 * spurious history entry it would save.
 */
export function sameBlocks(a: readonly Block[], b: readonly Block[]): boolean {
  return a === b || (a.length === b.length && a.every((block, index) => block === b[index]));
}

/** Ids from `fromId` to `toId` inclusive, in document order. */
export function blockIdRange(blocks: readonly Block[], fromId: string, toId: string): string[] {
  const from = findBlockIndex(blocks, fromId);
  const to = findBlockIndex(blocks, toId);

  if (from === -1 || to === -1) {
    return [];
  }

  return blocks.slice(Math.min(from, to), Math.max(from, to) + 1).map((block) => block.id);
}

/**
 * Removes blocks, always leaving something to type in.
 *
 * A document with no blocks has no caret, so clearing everything yields a
 * single empty paragraph instead.
 */
export function removeBlocks(blocks: readonly Block[], ids: ReadonlySet<string>): Block[] {
  const kept = blocks.filter((block) => !ids.has(block.id));

  return kept.length > 0 ? normalizeDepths(kept) : [createBlock('paragraph')];
}

/**
 * Moves blocks to a gap in the list.
 *
 * `gapIndex` is a position in the *original* array — 0 is above the first
 * block, `blocks.length` is below the last — because that is what a drop
 * indicator between two blocks actually identifies. Blocks removed from above
 * the gap shift it, which is what `removedBefore` corrects for.
 */
export function moveBlocks(
  blocks: readonly Block[],
  ids: ReadonlySet<string>,
  gapIndex: number,
): Block[] {
  const moving = blocks.filter((block) => ids.has(block.id));

  if (moving.length === 0) {
    return [...blocks];
  }

  const rest = blocks.filter((block) => !ids.has(block.id));
  const gap = Math.max(0, Math.min(gapIndex, blocks.length));
  const removedBefore = blocks.slice(0, gap).filter((block) => ids.has(block.id)).length;

  rest.splice(gap - removedBefore, 0, ...moving);

  return normalizeDepths(rest);
}

/** Copies blocks, with fresh ids, directly below the lowest one selected. */
export function duplicateBlocks(
  blocks: readonly Block[],
  ids: ReadonlySet<string>,
): { blocks: Block[]; ids: string[] } {
  const selected = blocks.filter((block) => ids.has(block.id));

  if (selected.length === 0) {
    return { blocks: [...blocks], ids: [] };
  }

  const copies = selected.map((block) => ({ ...cloneBlock(block), id: createBlockId() }));

  const lastIndex = blocks.reduce((last, block, index) => (ids.has(block.id) ? index : last), 0);

  const next = [...blocks];
  next.splice(lastIndex + 1, 0, ...copies);

  return { blocks: normalizeDepths(next), ids: copies.map((block) => block.id) };
}

/** Indents or outdents several blocks together, preserving their relative shape. */
export function indentBlocks(
  blocks: readonly Block[],
  ids: ReadonlySet<string>,
  delta: number,
): Block[] {
  const shifted = blocks.map((block) =>
    ids.has(block.id) ? { ...block, depth: Math.max(0, block.depth + delta) } : block,
  );

  return normalizeDepths(shifted);
}

/** A document holding only the given blocks, for the clipboard. */
export function sliceDocument(blocks: readonly Block[], ids: ReadonlySet<string>): NEditorDocument {
  const selected = blocks.filter((block) => ids.has(block.id));
  const base = selected[0]?.depth ?? 0;

  // Re-root the copy so pasting it elsewhere does not carry absolute depths.
  // Clamped: a selection starting deeper than a later block would otherwise
  // yield a negative depth, and toMarkdown repeats an indent string by it.
  return {
    blocks: normalizeDepths(
      selected.map((block) => ({ ...cloneBlock(block), depth: Math.max(0, block.depth - base) })),
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Markdown serialization                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Characters that would be read back as markup if emitted bare.
 *
 * `toMarkdown` output is parsed again by `blocksFromMarkdown`, so anything that
 * is not escaped here is silently reinterpreted: `2 * 3 * 4` came back as
 * italic with two characters missing.
 */
const INLINE_ESCAPE = /[\\`*_[\]~|<>]/g;

/**
 * A line-leading construct, which only matters for the first run of a block.
 *
 * The marker is escaped whatever follows it: a paragraph reading `---` is a
 * divider, and one reading `#` an empty heading, so requiring a space after the
 * marker let both through and destroyed the paragraph.
 */
const LEADING_MARKER = /^(\s*)([#>+-])/;
const LEADING_ORDINAL = /^(\s*)(\d+)([.)])(?=\s|$)/;

/**
 * Escapes run text for Markdown.
 *
 * A soft line break becomes a trailing backslash — CommonMark's hard break —
 * which `blocksFromMarkdown` rejoins. A literal backslash escapes to two, so
 * the trailing count stays unambiguous.
 */
function escapeMarkdownText(text: string): string {
  return text.replace(INLINE_ESCAPE, (char) => `\\${char}`).replaceAll('\n', '\\\n');
}

/** Stops a paragraph that begins with `#`, `-` or `1.` becoming that block. */
function escapeLeadingMarker(text: string): string {
  return text.replace(LEADING_ORDINAL, '$1$2\\$3').replace(LEADING_MARKER, '$1\\$2');
}

/**
 * Escapes a bracketed label: an image's alt text, or a callout's icon.
 *
 * A `]` inside one closes it early and the rest leaks into the line as markup,
 * so the brackets are escaped and `blocksFromMarkdown` unescapes them back.
 */
const LABEL_ESCAPE = /[\\[\]]/g;

function escapeMarkdownLabel(text: string): string {
  return text.replace(LABEL_ESCAPE, (char) => `\\${char}`);
}

/** Characters a destination cannot hold bare: the first `)` would close it. */
const DESTINATION_UNSAFE = /[()<>\s]/;

/**
 * Writes a link or image destination.
 *
 * Anything holding a paren or a space goes in angle brackets rather than being
 * backslash-escaped: the reader matches its rules against a projection in which
 * an escaped character is opaque, so it could never read the URL back out.
 */
function destinationToMarkdown(url: string): string {
  if (!DESTINATION_UNSAFE.test(url)) {
    return url;
  }

  // `<` and `>` would close the bracketed form. A URL that reached us through
  // `sanitizeUrl` has them percent-encoded already, so this is a no-op there.
  return `<${url.replace(/[<>\s]/g, (char) => encodeURIComponent(char))}>`;
}

/**
 * A fence longer than any run of backticks in the code it wraps.
 *
 * Three backticks in the payload would otherwise close the block early, and the
 * reader would hand back three blocks where the user had one.
 */
function fenceFor(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);

  return '`'.repeat(Math.max(3, longest + 1));
}

/** Delimiters applied from the innermost mark outwards. */
const MARK_DELIMITERS: ReadonlyArray<readonly [Mark, string, string]> = [
  ['code', '`', '`'],
  ['bold', '**', '**'],
  ['italic', '*', '*'],
  ['strikethrough', '~~', '~~'],
  ['underline', '<u>', '</u>'],
];

/**
 * Wraps a run in its Markdown delimiters.
 *
 * Surrounding whitespace is hoisted outside the delimiters, because `**bold **`
 * does not parse as emphasis in any Markdown dialect.
 */
function runToMarkdown(run: TextRun): string {
  const escaped = escapeMarkdownText(run.text);
  const leading = /^[^\S\n]*/.exec(escaped)?.[0] ?? '';
  const trailing = /[^\S\n]*$/.exec(escaped)?.[0] ?? '';
  let core = escaped.slice(leading.length, escaped.length - trailing.length);

  if (core.length === 0) {
    return escaped;
  }

  const marks = new Set(run.marks ?? []);

  for (const [mark, open, close] of MARK_DELIMITERS) {
    if (marks.has(mark)) {
      core = `${open}${core}${close}`;
    }
  }

  if (run.link) {
    core = `[${core}](${destinationToMarkdown(run.link)})`;
  }

  return `${leading}${core}${trailing}`;
}

/** A GFM table. Row 0 is the header, which the delimiter row follows. */
function tableToMarkdown(block: Block, indent: string): string {
  const rows = block.rows ?? [];
  const { columns } = tableSize(rows);

  // A literal pipe would end the cell, so it has to be escaped.
  const line = (cells: readonly RichText[]): string =>
    `${indent}| ${cells.map((cell) => richToMarkdown(cell)).join(' | ')} |`;

  const divider = `${indent}| ${Array.from({ length: columns }, () => '---').join(' | ')} |`;
  const [header, ...body] = rows;

  return header ? [line(header), divider, ...body.map(line)].join('\n') : `${indent}`;
}

export function richToMarkdown(content: readonly TextRun[]): string {
  return content.map(runToMarkdown).join('');
}

/** Serializes the document to Markdown. Useful for copy/paste and export. */
export function toMarkdown(doc: NEditorDocument): string {
  const numbers = computeListNumbers(doc.blocks);

  return doc.blocks
    .map((block) => {
      const indent = '  '.repeat(block.depth);
      // A code block is literal: its text must not be re-escaped as Markdown.
      const text = block.type === 'code' ? blockText(block) : richToMarkdown(block.content);
      // An empty block is a bare marker. The space after it is what makes the
      // marker readable, not what makes it a marker, and trailing whitespace
      // does not survive the trip back — ours trims it, and so does every other
      // tool the text passes through.
      const marked = (marker: string): string =>
        text.length === 0 ? `${indent}${marker}` : `${indent}${marker} ${text}`;

      switch (block.type) {
        // Only a paragraph can be mistaken for another block by its first
        // characters; everywhere else the marker already disambiguates.
        case 'paragraph':
          return `${indent}${escapeLeadingMarker(text)}`;
        case 'heading1':
          return marked('#');
        case 'heading2':
          return marked('##');
        case 'heading3':
          return marked('###');
        case 'bulleted_list':
          return marked('-');
        case 'numbered_list':
          return marked(`${numbers.get(block.id) ?? 1}.`);
        case 'todo':
          return marked(`- [${block.checked ? 'x' : ' '}]`);
        case 'quote':
          return marked('>');
        // The icon is bracketed rather than merely leading, so a quote that
        // starts with an emoji stays a quote and an icon that is not an emoji
        // still names a callout. `[` is escaped in text, so the two can never
        // collide.
        case 'callout':
          return marked(`> [!${escapeMarkdownLabel(block.icon ?? DEFAULT_CALLOUT_ICON)}]`);
        // Markdown has no toggle; the marker degrades to a readable bullet.
        case 'toggle':
          return marked(`- ${block.collapsed ? '\u25B8' : '\u25BE'}`);
        case 'code': {
          const fence = fenceFor(text);

          return `${indent}${fence}\n${text}\n${indent}${fence}`;
        }
        case 'image':
          return `${indent}![${escapeMarkdownLabel(block.alt ?? '')}](${destinationToMarkdown(
            block.src ?? '',
          )})`;
        case 'table':
          return tableToMarkdown(block, indent);
        case 'divider':
          return `${indent}---`;
        default:
          return `${indent}${text}`;
      }
    })
    .join('\n\n');
}

export { isRichEmpty };
