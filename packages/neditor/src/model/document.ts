import { sanitizeImageUrl } from '../util/url.ts';
import { createBlockId } from './ids.ts';
import type { Mark, RichText, TextRun } from './rich-text.ts';
import { INLINE_SPAN_LIMIT } from '../input/inline-rules.ts';
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
  /** Stable, opaque identity, assigned by `createBlock`. */
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
  return descendantsFrom(blocks, findBlockIndex(blocks, id));
}

/**
 * `descendantsOf` for a caller that already knows the block's position.
 *
 * Walks the tail in place. `blocks.slice(index + 1)` copied it first, which is
 * a second pass over the document per call and, for a caller in a loop, a
 * second document-sized allocation per iteration.
 */
function descendantsFrom(blocks: readonly Block[], index: number): string[] {
  const parent = blocks[index];

  if (!parent) {
    return [];
  }

  const out: string[] = [];

  for (let at = index + 1; at < blocks.length; at += 1) {
    const block = blocks[at]!;

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
  // Indexed once. `findBlock` is a linear scan, and calling it per selected id
  // made every select-all gesture -- copy, cut, delete, duplicate, indent,
  // paste-over, drag-drop, Cmd+Shift+Arrow -- cost selection x document.
  //
  // The index holds POSITIONS, not blocks. Holding blocks left the other half
  // of the same defect in place: `descendantsOf` takes an id, so it scanned for
  // the block all over again, once per selected collapsed toggle. That is the
  // same selection x document cost on a document of collapsed sections, and the
  // guard below missed it for as long as its fixture was plain paragraphs --
  // select-all over 16k such blocks cost 149ms against 1.2ms for the same count
  // of paragraphs, and doubling the document quadrupled it.
  //
  // First position wins, matching the `findBlockIndex` this replaces. Documents
  // reaching here are normalized, and `normalizeDocument` reassigns duplicate
  // ids, so the two only differ on a document that cannot occur.
  const indexById = new Map<string, number>();

  for (let at = 0; at < blocks.length; at += 1) {
    const { id } = blocks[at]!;

    if (!indexById.has(id)) {
      indexById.set(id, at);
    }
  }

  for (const id of [...out]) {
    const at = indexById.get(id);

    if (at === undefined) {
      continue;
    }

    const block = blocks[at]!;

    if (block.type !== 'toggle' || block.collapsed !== true) {
      continue;
    }

    for (const child of descendantsFrom(blocks, at)) {
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

      // A code block is literal text in both serializers: `toMarkdown` writes a
      // fence, whose content CommonMark reads back verbatim, and
      // `blocksFromHtml` takes a <pre> as its text. Formatting held here
      // survived in the model and in nothing else -- `blocksToHtml` wrote an
      // <a> inside the <pre> that reading the same clipboard back discarded --
      // so it is dropped at the boundary rather than kept until a round trip
      // silently loses it.
      if (normalized.type === 'code') {
        normalized.content = normalizeRuns(normalized.content.map((run) => ({ text: run.text })));
      }

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

/**
 * Same own keys, each holding the same value by reference.
 *
 * `sameBlocks` compares blocks by reference, so a block rebuilt with identical
 * contents reads as an edit. That is the deliberate conservative direction for
 * content -- proving deep equality costs more than the spurious history entry
 * -- but the scalar patches below are cheap to check and were the ones users
 * hit: picking the callout icon already set, applying an image dialog with
 * nothing changed, setting the link already there, or converting a block to the
 * type it already is each banked an undo entry and emitted a byte-identical
 * `change` for an autosave listener to write back as a new revision.
 */
function sameFields(a: Block, b: Block): boolean {
  const keys = Object.keys(a);
  const record = a as unknown as Record<string, unknown>;
  const other = b as unknown as Record<string, unknown>;

  return (
    keys.length === Object.keys(b).length && keys.every((key) => Object.is(record[key], other[key]))
  );
}

export function updateBlock(
  blocks: readonly Block[],
  id: string,
  patch: Partial<Omit<Block, 'id'>>,
): Block[] {
  return blocks.map((block) => {
    if (block.id !== id) {
      return block;
    }

    const next = { ...block, ...patch };

    return sameFields(block, next) ? block : next;
  });
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
      // A code block is uniformly monospace, so inline marks would be noise --
      // and a link fares no better: neither serializer can carry one through a
      // fence or a <pre>, so keeping it here only defers losing it.
      next.content = normalizeRuns(next.content.map((run) => ({ text: run.text })));
    }

    // Converting a block to the type it already is changes nothing, and the
    // caller should not record history for it. `cloneTableRows` above makes a
    // table's `rows` a fresh array, so a table-to-table conversion still reads
    // as an edit -- the conservative direction, and the same one `sameBlocks`
    // takes for content.
    return sameFields(block, next) ? block : next;
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
 * above it, nor deeper than 32.
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
 *
 * Deliberately not the toggle markers, which are escaped in the `bulleted_list`
 * case alone. A bullet is written `- text`, so a bullet whose text is a bare
 * `▾` was indistinguishable from the empty toggle written `- ▾`: the text was read
 * as the marker and destroyed. Escaping there keeps the marker a marker;
 * escaping here would put a stray backslash into every other reader's prose.
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
// A soft break follows as `\` + newline, which the reader rejoins before
// testing for a prefix: `1.` then Shift+Enter came back a numbered list.
const LEADING_ORDINAL = /^(\s*)(\d+)([.)])(?=\s|$|\\\n)/;
// `![…](…)` alone is an image line; a paragraph opening with a `!` and a
// linked label came back as one, the text gone.
const LEADING_BANG = /^(\s*)!(?=\[)/;

/**
 * Escapes run text for Markdown.
 *
 * A soft line break becomes a trailing backslash — CommonMark's hard break —
 * which `blocksFromMarkdown` rejoins. A literal backslash escapes to two, so
 * the trailing count stays unambiguous.
 */
function escapeMarkdownText(text: string): string {
  return text
    .replace(INLINE_ESCAPE, (char) => `\\${char}`)
    .replace(REFERENCE_AMPERSAND, '\\&')
    .replaceAll('\n', '\\\n');
}

/**
 * An `&` that would begin a character reference.
 *
 * The reader decodes numeric references where the writer puts them, for
 * whitespace (see {@link protectEdgeWhitespace}), and every other reader
 * decodes named ones too -- so `&amp;` typed as text showed as `&` there. Text
 * holding either shape is escaped so it comes back as typed; every other `&` is
 * written bare.
 */
const REFERENCE_AMPERSAND = /&(?=#(?:\d+|[xX][0-9a-fA-F]+);|[a-zA-Z][a-zA-Z0-9]{0,31};)/g;

/**
 * Writes whitespace at either edge of a block's text as numeric references.
 *
 * Leading whitespace on a line is indentation -- depth, to this reader -- and
 * every reader trims the rest, so written bare it was simply lost: Enter in the
 * middle of "Alpha one" leaves " one", and a Markdown copy or save read it back
 * as "one". A numeric reference is how CommonMark itself spells a character that
 * must not be read as syntax, so other readers render it correctly too.
 */
function protectEdgeWhitespace(markdown: string): string {
  // A newline at an edge arrives here as the soft-break marker, `\` + newline,
  // and was lost the same way (the e2e audit's F14: Shift+Enter at the end of a
  // block). One backslash before the newline is the marker; any before it are
  // escaped literal backslashes, which these patterns never swallow.
  const encode = (run: string) =>
    run.replace(/\\\n|[^\S\n]/g, (token) =>
      token === '\\\n' ? '&#10;' : `&#${token.codePointAt(0) ?? 32};`,
    );

  return markdown.replace(/^(?:\\\n|[^\S\n])+/, encode).replace(/(?:\\\n|[^\S\n])+$/, encode);
}

/** Stops a paragraph that begins with `#`, `-` or `1.` becoming that block. */
function escapeLeadingMarker(text: string): string {
  return text
    .replace(LEADING_ORDINAL, '$1$2\\$3')
    .replace(LEADING_MARKER, '$1\\$2')
    .replace(LEADING_BANG, '$1\\!');
}

/**
 * Escapes a block marker at the start of each line after a soft break.
 *
 * This reader rejoins those lines into one block, but every other one reads a
 * continuation line that opens with `#`, `-`, `>` or `1.` as a new heading or
 * list -- and `---` under a line as a heading underline. Image captions follow
 * a hard break, so the same goes for them.
 */
function escapeContinuations(markdown: string): string {
  return (
    markdown
      .replace(/(\\\n[^\S\n]*)(\d+)([.)])(?=\s|$|\\\n)/g, '$1$2\\$3')
      // `=` too: `===` under a line is a heading underline, as `---` is.
      .replace(/(\\\n[^\S\n]*)([#>+=-])/g, '$1\\$2')
      // And the whitespace a line starts with, which every reader strips; the
      // reader here decodes references at the start of a line for this.
      .replace(
        /(\\\n)([^\S\n]+)/g,
        (_match, lineBreak: string, run: string) =>
          lineBreak + run.replace(/[^\S\n]/g, (char) => `&#${char.codePointAt(0) ?? 32};`),
      )
  );
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

/**
 * The HTML spelling of each mark, for a run a delimiter cannot express: edge
 * whitespace or a line break, code that needs an escape, or a run whose
 * delimiters would not be flanking where it sits (see runToMarkdown).
 */
const MARK_TAGS: Record<Mark, string> = {
  code: 'code',
  bold: 'strong',
  italic: 'em',
  strikethrough: 's',
  underline: 'u',
};

/** Delimiters applied from the innermost mark outwards. */
const MARK_DELIMITERS: ReadonlyArray<readonly [Mark, string, string]> = [
  ['code', '`', '`'],
  ['bold', '**', '**'],
  ['italic', '*', '*'],
  ['strikethrough', '~~', '~~'],
  ['underline', '<u>', '</u>'],
];

/**
 * The longest text a single emphasis or link span is written across.
 *
 * The reader will not look further back than `INLINE_SPAN_LIMIT` characters for
 * an opening delimiter, so a longer span is one it can never close: bolding a
 * 350-word paragraph and exporting it gave back the raw `**` at each end with
 * the formatting gone. Comfortably under the reader's bound, which also has to
 * cover the delimiters and any escaping this adds.
 */
const SAFE_SPAN = Math.floor(INLINE_SPAN_LIMIT * 0.75);

/**
 * Splits at the last space at or before `SAFE_SPAN`, or nowhere if there is none.
 *
 * `emitted` is what the span will actually cost the reader -- the escaped text
 * plus its delimiters -- and it is what the limit applies to. Testing the raw
 * text against `SAFE_SPAN` instead split runs between 1501 and 1996 characters
 * that the reader would have read whole, putting an unmarked space into text
 * that had none.
 */
function splitLongSpan(text: string, emitted: number): [string, string] | null {
  if (emitted <= INLINE_SPAN_LIMIT) {
    return null;
  }

  // At a space or a line break: a long run of lines with no space in reach --
  // paths, identifiers -- otherwise went out as one span the reader could not
  // close, and came back as raw markup.
  const at = Math.max(text.lastIndexOf(' ', SAFE_SPAN), text.lastIndexOf('\n', SAFE_SPAN));

  // A single unbroken token longer than the bound cannot be split without
  // changing the text, so it is written whole and does not round-trip. Nothing
  // a person types looks like that.
  return at <= 0 ? null : [text.slice(0, at), text.slice(at)];
}

/** What a run is written next to, and how the block it is in handles breaks. */
interface RunContext {
  /** The character before the run in its block, or '' at the start. */
  before?: string;
  /** The character after it, or '' at the end. */
  after?: string;
  /**
   * One span per line: a heading is a single line in every other reader, so a
   * span written whole across a break there split its delimiters between the
   * heading and the paragraph after it. The break's own mark is the price.
   */
  splitLines?: boolean;
  /** Write HTML tags whatever the text: the run's delimiters would merge with a neighbour's. */
  tagged?: boolean;
}

const PUNCTUATION = /[\p{P}\p{S}]/u;
const SPACE = /\s/u;

/**
 * Whether `*`-style delimiters around a run would open and close it.
 *
 * CommonMark's flanking rule, in the part that bites: a delimiter against
 * punctuation also needs whitespace or punctuation on its outer side, so
 * `word**(x)**` is literal asterisks there. Judged on the run's neighbours in
 * the text, which is conservative -- the character actually written beside a
 * delimiter may be another run's delimiter, punctuation -- and wrong only
 * towards writing HTML where `**` would have done.
 */
function flanks(text: string, before: string, after: string): boolean {
  const first = text[0] ?? '';
  const last = text.at(-1) ?? '';
  const outside = (char: string) => char === '' || SPACE.test(char) || PUNCTUATION.test(char);

  return (
    (!PUNCTUATION.test(first) || outside(before)) && (!PUNCTUATION.test(last) || outside(after))
  );
}

/**
 * Wraps a run in its Markdown delimiters.
 *
 * Whitespace at the edge of a marked run stays inside the mark: it used to be
 * written outside the delimiters, and the mark on it was lost -- invisible for
 * bold, a visible gap in an underline, a strike, a code span or a link. `**`,
 * `*` and `~~` cannot open or close against whitespace, and CommonMark strips a
 * space from each side of a code span, so such a run is written as HTML tags
 * instead (`a<strong>bold </strong>b`), which this reader reads back and any
 * reader that allows inline HTML renders as written -- one that escapes raw
 * HTML, as markdown-it does by default, shows the tags. (Numeric references inside `**` were tried first:
 * `a**bold&#32;**b` is literal asterisks in CommonMark, whose closer there is
 * not right-flanking.) A link's text holds the whitespace as it is.
 */
function runToMarkdown(run: TextRun, context: RunContext = {}): string {
  if (context.splitLines && run.text.includes('\n')) {
    return run.text
      .split('\n')
      .map((line) => runToMarkdown({ ...run, text: line }))
      .join('\\\n');
  }

  const escaped = escapeMarkdownText(run.text);
  const marks = new Set(run.marks ?? []);

  if (escaped.length === 0 || (marks.size === 0 && !run.link)) {
    return escaped;
  }

  // HTML where a delimiter cannot say it. Emphasis cannot open or close
  // against whitespace -- a space or a line break -- and CommonMark takes a
  // backtick span's content literally, so a code run that needed an escape, or
  // holds a line break (written `\` + newline), would show the backslash.
  const edged = /^\s|\s$/.test(run.text);
  const literalCode = !marks.has('code') || (escaped === run.text && !run.text.includes('`'));
  // Inside a link the delimiters sit against `[` and `]`, which always flank.
  const emphasis = marks.has('bold') || marks.has('italic') || marks.has('strikethrough');
  // Judged on what the delimiters will actually touch, which for a code run is
  // its backtick: `**`x`**1` is literal asterisks.
  const inner = marks.has('code') ? '`' : run.text;
  const flanking =
    !emphasis || run.link !== undefined || flanks(inner, context.before ?? '', context.after ?? '');
  const tagged = context.tagged || edged || !literalCode || !flanking;
  let core = escaped;

  for (const [mark, open, close] of MARK_DELIMITERS) {
    if (marks.has(mark)) {
      core = tagged ? `<${MARK_TAGS[mark]}>${core}</${MARK_TAGS[mark]}>` : `${open}${core}${close}`;
    }
  }

  if (run.link) {
    core = `[${core}](${destinationToMarkdown(run.link)})`;
  }

  // And one span per readable length: a span whose opening delimiter the reader
  // cannot reach is one it leaves in the prose as literal characters. Measured
  // on what was actually emitted rather than on the raw text, so a run only
  // splits when it really is too long for the reader.
  if ((run.marks?.length || run.link) && core.length > INLINE_SPAN_LIMIT) {
    const split = splitLongSpan(run.text, core.length);

    if (split) {
      return split.map((part) => runToMarkdown({ ...run, text: part }, context)).join('');
    }
  }

  return core;
}

/** A GFM table. Row 0 is the header, which the delimiter row follows. */
function tableToMarkdown(block: Block, indent: string): string {
  const rows = block.rows ?? [];
  const { columns } = tableSize(rows);

  // A literal pipe would end the cell, so it has to be escaped.
  // Cells are trimmed on the way back, so their edge whitespace is protected too.
  const line = (cells: readonly RichText[]): string =>
    `${indent}| ${cells.map((cell) => protectEdgeWhitespace(richToMarkdown(cell))).join(' | ')} |`;

  const divider = `${indent}| ${Array.from({ length: columns }, () => '---').join(' | ')} |`;
  const [header, ...body] = rows;

  return header ? [line(header), divider, ...body.map(line)].join('\n') : `${indent}`;
}

/** The character a run's delimiters sit against on one side: a code run's is its backtick. */
function innerEdge(run: TextRun | undefined, side: 'first' | 'last'): string {
  if (!run) {
    return '';
  }

  return run.marks?.includes('code')
    ? '`'
    : ((side === 'first' ? run.text[0] : run.text.at(-1)) ?? '');
}

export function richToMarkdown(
  content: readonly TextRun[],
  options: { splitLines?: boolean } = {},
): string {
  let previous = '';

  return content
    .map((run, index) => {
      const context: RunContext = {
        before: content[index - 1]?.text.at(-1) ?? '',
        after: content[index + 1]?.text[0] ?? '',
        splitLines: options.splitLines,
      };
      let written = runToMarkdown(run, context);

      // `**(**` then `**`(`**` is `**(****`(`**`: the two closing and opening
      // delimiters are one run of four to CommonMark, punctuation on both sides
      // lets it open as well as close, and the rule of three then leaves the
      // first span unclosed. Only measured between punctuation -- between
      // letters (`**a*****b***`) the same run resolves as written.
      if (
        written.startsWith('*') &&
        /(?:^|[^\\])(?:\\\\)*\*$/.test(previous) &&
        PUNCTUATION.test(innerEdge(content[index - 1], 'last')) &&
        PUNCTUATION.test(innerEdge(run, 'first'))
      ) {
        written = runToMarkdown(run, { ...context, tagged: true });
      }

      // `!` straight before a link makes it an image in every other reader. An
      // even run of backslashes before it is escaped backslashes, not an escape.
      const bang = content[index + 1]?.link ? /(\\*)!$/.exec(written) : null;

      previous = bang && (bang[1] ?? '').length % 2 === 0 ? `${written.slice(0, -1)}\\!` : written;

      return previous;
    })
    .join('');
}

/** Serializes the document to Markdown. Useful for copy/paste and export. */
export function toMarkdown(doc: NEditorDocument): string {
  const numbers = computeListNumbers(doc.blocks);

  return doc.blocks
    .map((block) => {
      const indent = '  '.repeat(block.depth);
      // A code block is literal: its text must not be re-escaped as Markdown.
      const text =
        block.type === 'code'
          ? blockText(block)
          : protectEdgeWhitespace(
              escapeContinuations(
                richToMarkdown(block.content, { splitLines: block.type.startsWith('heading') }),
              ),
            );
      // An empty block is a bare marker. The space after it is what makes the
      // marker readable, not what makes it a marker, and trailing whitespace
      // does not survive the trip back — ours trims it, and so does every other
      // tool the text passes through.
      const marked = (marker: string, body: string = text): string =>
        body.length === 0 ? `${indent}${marker}` : `${indent}${marker} ${body}`;

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
        // A bullet is the one block whose text can still be misread, because a
        // toggle is written as a bullet led by a triangle. Escaped here and
        // nowhere else: `\▾` is not an escape any CommonMark reader honours,
        // so escaping the triangle in ordinary prose would put a literal
        // backslash into everyone else's rendering of "press ▾ to expand".
        case 'bulleted_list':
          // `^(\s*)` like the other leading-marker escapes in this file, not a
          // bare `^`: the reader's bullet prefix eats the marker and every
          // space after it, so a triangle behind whitespace still lands where a
          // toggle's marker is read. Anchored tighter, `-  ▾ x` came back as a
          // toggle with the triangle eaten.
          // The prefix skips escaped soft breaks as well as spaces: a leading
          // newline is written `\` + newline, so a bare `\s*` stopped at that
          // backslash, wrote no escape, and the triangle behind it was read as
          // a toggle marker.
          return marked('-', text.replace(/^((?:\\\n|\s)*)([\u25B8\u25BE])/, '$1\\$2'));
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
        // The caption follows after a hard break: every other reader shows the
        // picture with the caption beneath it, and this one reads it back.
        case 'image': {
          const image = `${indent}![${escapeMarkdownLabel(block.alt ?? '')}](${destinationToMarkdown(
            block.src ?? '',
          )})`;

          // The caption's first line follows a break too, so its marker is escaped.
          return text.length === 0 ? image : `${image}\\\n${escapeLeadingMarker(text)}`;
        }
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
