import { sanitizeImageUrl } from '../util/url.ts';
import { createBlockId } from './ids.ts';
import type { Mark, RichText, TextRun } from './rich-text.ts';
import { BARE_URL_START, INLINE_SPAN_LIMIT } from '../input/inline-rules.ts';
import { normalizeControlCharacters } from '../input/line-breaks.ts';
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
  isMathRun,
  MATH_ATOM,
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
  | 'math'
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
  'math',
  'callout',
  'toggle',
  'image',
  'table',
  'divider',
]);

export function isBlockType(value: unknown): value is BlockType {
  return typeof value === 'string' && BLOCK_TYPES.has(value as BlockType);
}

/**
 * Block types whose text is source, not prose: a code block's code, and a
 * display equation's TeX.
 *
 * Their text is literal in both serializers -- a fence in Markdown, a `<pre>`
 * or an attribute in HTML -- so it carries no marks, no links and no inline
 * formulas, none of which either serializer could write back. No inline rule
 * reinterprets it, Enter adds a line rather than a block, and spellcheck stays
 * out of it.
 */
const LITERAL_TYPES = new Set<BlockType>(['code', 'math']);

export function isLiteralType(type: BlockType): boolean {
  return LITERAL_TYPES.has(type);
}

/**
 * Content as a block of `type` can hold it.
 *
 * Literal text has no formatting, so marks and links go; an inline formula
 * becomes its TeX -- written `$…$` in a code block, where the source of the
 * prose it came from is what reads true, and bare in a display equation, which
 * is TeX already and where a `$` would end math mode. Every other type holds
 * runs as they are.
 */
export function contentForType(type: BlockType, content: readonly TextRun[]): RichText {
  if (!isLiteralType(type)) {
    return normalizeRuns(content);
  }

  if (type === 'code') {
    return normalizeRuns(
      content.map((run) => (isMathRun(run) ? { text: `$${run.math}$` } : { text: run.text })),
    );
  }

  // Bare TeX runs into its neighbours, and TeX reads a control word up to the
  // first non-letter: `\alpha` beside `b` would be `\alphab`, one undefined
  // command. A space ends a control word and is otherwise ignored in math
  // mode, so one goes between a formula and whatever it touches.
  let text = '';

  content.forEach((run, index) => {
    if (!isMathRun(run)) {
      text += run.text;
      return;
    }

    const next = content[index + 1];
    // One character each side, never a pattern over the text built so far.
    const before = text.length > 0 && !/\s/.test(text.at(-1) ?? '') ? ' ' : '';
    const after = next && !/\s/.test(next.text[0] ?? '') ? ' ' : '';
    text += `${before}${run.math ?? ''}${after}`;
  });

  return richFromPlainText(text);
}

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
 * Moves a selection past the next *visible* block up or down -- past that
 * block's visible children too, when it is not shallower than the selection.
 *
 * The step is measured in visible blocks rather than array entries, because
 * those are two different orders. A collapsed toggle occupies one slot however
 * many blocks it hides: what moves carries its hidden children, and so does the
 * block it steps over. Stepping in raw array coordinates instead swaps a
 * collapsed toggle with its own first child — which then pops out as a
 * top-level block — or drops a neighbour into the gap between a toggle and the
 * children it hides, where the next depth clamp adopts it.
 *
 * A selection with gaps in it moves as one contiguous group, the way
 * {@link moveBlocks} lands one: the step is taken from its first or last block
 * (and its depth from its shallowest), and the blocks that sat in its gaps are
 * left behind.
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
  //
  // A block passed at the selection's depth or deeper is stepped over whole:
  // its visible children too, as it already was with the hidden ones. One slot
  // past a block with children is the gap between it and them, and whatever
  // lands there adopts them: the children changed parent for a move that never
  // touched them. A block shallower than the selection -- a parent above, the
  // next section below -- is still one slot, which is how a block moves into
  // and out of a list; its children are no deeper than the mover, so none can
  // be adopted. The selection's depth is its shallowest block's: a selection
  // that starts inside a list and ends on a section header steps over the next
  // section whole, the way that header alone would.
  const depth = selected.reduce((low, block) => Math.min(low, block.depth), Infinity);
  let landingAt = direction === -1 ? from - 1 : to + 2;

  if (direction === -1) {
    // The block above may be the last of a sibling's children: go back to the
    // first block above at the selection's depth or shallower -- that sibling,
    // or a parent, which is one slot as it is.
    while (landingAt > 0 && visible[landingAt]!.depth > depth) {
      landingAt -= 1;
    }
  } else if (visible[to + 1]!.depth >= depth) {
    // The block below goes past with everything nested under it. That covers
    // an unselected child of a selected block too: one slot past it is the gap
    // before its own children, and they went to the mover.
    const over = visible[to + 1]!.depth;

    while (visible[landingAt] && visible[landingAt]!.depth > over) {
      landingAt += 1;
    }
  }

  const landing = visible[landingAt];

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
    return normalizeRuns(withLineBreaks(input as TextRun[]));
  }

  // Documents written before rich text stored a plain `text` string.
  if (typeof legacyText === 'string') {
    return richFromPlainText(plainCharacters(legacyText));
  }

  if (typeof input === 'string') {
    return richFromPlainText(plainCharacters(input));
  }

  return [];
}

/**
 * Text with `\r\n` and lone `\r` as `\n`, the model's only line break, and
 * no control character but the tab (see {@link normalizeControlCharacters}).
 *
 * A stored `\r` rendered as a break, was written to Markdown as a hard break
 * and stepped over by the caret as a character of its own, so a document from
 * a Windows tool that had kept its line endings did not read back as it was
 * written. This is the door the stored document and `application/x-neditor`
 * come through; the plain-text, HTML and Markdown readers apply the same rule
 * to what they read, so a paste holds nothing a reload would take away.
 */
function plainCharacters(text: string): string {
  return normalizeControlCharacters(text);
}

/**
 * Runs whose text has been through {@link plainCharacters}. Anything that is
 * not a run passes through for `normalizeRuns` to judge.
 */
function withLineBreaks(runs: readonly TextRun[]): TextRun[] {
  return runs.map((run) => {
    const text = (run as Partial<TextRun> | null)?.text;

    if (typeof text !== 'string') {
      return run;
    }

    const clean = plainCharacters(text);

    return clean === text ? run : { ...run, text: clean };
  });
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
        // Not capped at MAX_DEPTH here: `normalizeDepths` caps its output, and
        // capping the input first merged distinct stored depths, so `[0, 35,
        // 40]` lost its parent and child to two siblings -- a collapsed toggle
        // stored past the ceiling showed what it hides.
        depth: Number.isFinite(block.depth) ? Math.max(0, Math.trunc(block.depth as number)) : 0,
      };

      // A code block is literal text in both serializers: `toMarkdown` writes a
      // fence, whose content CommonMark reads back verbatim, and
      // `blocksFromHtml` takes a <pre> as its text. Formatting held here
      // survived in the model and in nothing else -- `blocksToHtml` wrote an
      // <a> inside the <pre> that reading the same clipboard back discarded --
      // so it is dropped at the boundary rather than kept until a round trip
      // silently loses it.
      // A display equation's TeX is literal the same way, written between
      // `$$` fences and carried in an attribute.
      if (isLiteralType(normalized.type)) {
        normalized.content = contentForType(normalized.type, normalized.content);
      }

      if (normalized.type === 'todo') {
        normalized.checked = block.checked === true;
      }

      if (normalized.type === 'callout') {
        // Cleaned like any text: a NUL in it went into every Markdown label.
        const icon = typeof block.icon === 'string' ? plainCharacters(block.icon) : '';

        normalized.icon = icon.length > 0 ? icon : DEFAULT_CALLOUT_ICON;
      }

      if (normalized.type === 'toggle') {
        normalized.collapsed = block.collapsed === true;
      }

      if (normalized.type === 'image') {
        // An unsafe src is dropped rather than rendered.
        normalized.src = typeof block.src === 'string' ? (sanitizeImageUrl(block.src) ?? '') : '';
        normalized.alt = typeof block.alt === 'string' ? plainCharacters(block.alt) : '';
      }

      if (normalized.type === 'table') {
        normalized.rows = normalizeTableRows(block.rows).map((row) =>
          row.map((cell) => normalizeRuns(withLineBreaks(cell))),
        );
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
 * contents reads as an edit. The scalar patches below are cheap to check and
 * were the ones users hit: picking the callout icon already set, applying an
 * image dialog with nothing changed, or converting a block to the type it
 * already is each banked an undo entry and emitted a byte-identical `change`
 * for an autosave listener to write back as a new revision.
 *
 * `content` is compared by reference here like every other field, and the
 * rich-text ops hand back a fresh run array even when nothing changed, so a
 * content patch is never caught by this test -- re-setting the link already on
 * a range reaches it as a new array. That case is the editor's to refuse, and
 * it does, before committing: `#commitResolved` drops content `richEquals`
 * finds equal to what the host already holds. Deep equality is deliberately
 * not asked here, where every caller would pay for it.
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
    } else if (isLiteralType(type)) {
      // A code block is uniformly monospace, so inline marks would be noise --
      // and a link fares no better: neither serializer can carry one through a
      // fence or a <pre>, so keeping it here only defers losing it. A display
      // equation is TeX, the same way. An inline formula keeps its TeX as text
      // rather than leaving an atom neither block can draw.
      next.content = contentForType(type, next.content);
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
 * It repairs depths without changing the tree they describe. A block's parent
 * is the nearest block above it that is shallower, and below the ceiling that
 * is the same block before and after: each block lands one level below its
 * parent's *new* depth. At the ceiling a deeper chain is flattened onto it,
 * and those blocks become siblings -- unavoidable, since MAX_DEPTH is as deep
 * as anything may go. A depth below zero, or one that is not a number, is
 * read as the root.
 * Clamping against the predecessor alone did not keep that. Delete the parent
 * of `toggle (2) > hidden (3)` followed by `sibling (2)` and the toggle and its
 * child came up a level while the sibling stayed at 2 -- now deeper than the
 * toggle, so inside it, and hidden outright when the toggle was collapsed. On a
 * document that already satisfies the invariant this is the identity, and every
 * block is reused, which `sameBlocks` relies on to see a no-op.
 *
 * The ceiling belongs here rather than only in `normalizeDocument`, because
 * this is the one function every structural edit ends in: a limit applied on
 * load alone is not a limit, it is a document that changes shape when reloaded.
 */
export function normalizeDepths(blocks: readonly Block[]): Block[] {
  // The open ancestors of the current block: their depths as given, which
  // strictly increase from the bottom, and the depths they were given here,
  // which do too until the ceiling holds several at MAX_DEPTH.
  const givenDepths: number[] = [];
  const newDepths: number[] = [];

  return blocks.map((block) => {
    // Below zero is the root. Read as given, -2 then -1 made the second a
    // child of the first; and `> 0` also sends NaN to the root, where compared
    // as given it was deeper than nothing and shallower than nothing, and
    // every block after it nested one level further.
    const given = block.depth > 0 ? block.depth : 0;

    while (givenDepths.length > 0 && givenDepths.at(-1)! >= given) {
      givenDepths.pop();
      newDepths.pop();
    }

    const depth = Math.min((newDepths.at(-1) ?? -1) + 1, MAX_DEPTH);
    givenDepths.push(given);
    newDepths.push(depth);

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
 *
 * The moved blocks land as one contiguous group, in document order, even when
 * they were not contiguous before: a selection with gaps in it gathers at the
 * drop, and the blocks that sat in its gaps stay where they were.
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

  const at = gap - removedBefore;

  // Not `splice(at, 0, ...moving)`: spread into one call, a selection of a
  // hundred thousand blocks passed the engine's limit on arguments.
  return normalizeDepths([...rest.slice(0, at), ...moving, ...rest.slice(at)]);
}

/**
 * Copies blocks, with fresh ids, below the lowest one selected and everything
 * nested under the selection.
 *
 * Directly below it put the copies between a parent and its children, and the
 * children went to the copy: duplicating an expanded toggle left the original
 * empty. A collapsed toggle's hidden run is selected along with it, so what
 * this protects is the visible children of a selected block that were not
 * selected themselves.
 */
export function duplicateBlocks(
  blocks: readonly Block[],
  ids: ReadonlySet<string>,
): { blocks: Block[]; ids: string[] } {
  const selected = blocks.filter((block) => ids.has(block.id));

  if (selected.length === 0) {
    return { blocks: [...blocks], ids: [] };
  }

  const floor = selected.reduce((low, block) => Math.min(low, block.depth), Infinity);

  // Re-rooted at the selection's shallowest depth, keeping their own tree: a
  // selection that starts deeper than it ends -- a list item and the section
  // header after it -- put its first copy at the item's depth right after the
  // header's run, where the header took it as a child.
  const copies = normalizeDepths(
    selected.map((block) => ({
      ...cloneBlock(block),
      id: createBlockId(),
      depth: block.depth - floor,
    })),
  ).map((block) => ({ ...block, depth: block.depth + floor }));

  const lastIndex = blocks.reduce((last, block, index) => (ids.has(block.id) ? index : last), 0);
  // Past every block deeper than the shallowest copy, so nothing after the
  // copies can be adopted by them. The last selected block's own subtree is
  // not enough: select a parent and its first child, and the second child,
  // just after them, went to the copy of the parent.
  let end = lastIndex;

  while (end + 1 < blocks.length && blocks[end + 1]!.depth > floor) {
    end += 1;
  }

  // Not `splice(..., ...copies)`, whose arguments the engine limits.
  const next = [...blocks.slice(0, end + 1), ...copies, ...blocks.slice(end + 1)];

  return { blocks: normalizeDepths(next), ids: copies.map((block) => block.id) };
}

/**
 * Indents or outdents several blocks, each one on its own.
 *
 * Each selected block moves by `delta` as far as it legally can -- at depth 0,
 * and one level below the block above it *as already moved* -- the clamp
 * `indentBlock` applies to one. A block that cannot move keeps its depth, and
 * is handed back as the same object, which `sameBlocks` relies on; so is
 * everything after it. Shifted blindly and re-clamped afterwards, the first
 * item of a nested list reached its own child's depth, the tree-keeping
 * re-clamp read the two as siblings, and the child came out from under it;
 * and a run whose first block could not move indented nothing, since each
 * block after it was clamped back against the unmoved one before it. So the
 * selection's relative shape is *not* preserved: outdenting a parent already
 * at the root together with its child flattens the two, and an indent can be
 * absorbed by the clamp for one block and not the next. The editor's
 * `indentTargets` asks this same clamp which blocks would move.
 *
 * A selected block also stays put when indenting it would take it, or a
 * selected block nested under it, past MAX_DEPTH: the re-clamp would put the
 * deeper one at its parent's depth, so a collapsed toggle at 31 went to 32 and
 * its hidden child landed beside it, in view, leaving the toggle empty.
 */
export function indentBlocks(
  blocks: readonly Block[],
  ids: ReadonlySet<string>,
  delta: number,
): Block[] {
  const pinned = delta > 0 ? pinnedAtCeiling(blocks, ids, delta) : new Set<number>();
  let previous = -1;

  const shifted = blocks.map((block, index) => {
    const depth =
      ids.has(block.id) && !pinned.has(index)
        ? Math.max(0, Math.min(block.depth + delta, previous + 1))
        : block.depth;
    previous = depth;

    return depth === block.depth ? block : { ...block, depth };
  });

  return normalizeDepths(shifted);
}

/**
 * Positions of selected blocks that may not indent by `delta`: each one that
 * would pass MAX_DEPTH, and every selected ancestor it is nested under through
 * an unbroken chain of selected blocks -- the ones that would carry it.
 */
function pinnedAtCeiling(
  blocks: readonly Block[],
  ids: ReadonlySet<string>,
  delta: number,
): Set<number> {
  const pinned = new Set<number>();
  const ancestors: number[] = [];

  for (let at = 0; at < blocks.length; at += 1) {
    const block = blocks[at]!;

    while (ancestors.length > 0 && blocks[ancestors.at(-1)!]!.depth >= block.depth) {
      ancestors.pop();
    }

    if (ids.has(block.id) && block.depth + delta > MAX_DEPTH) {
      pinned.add(at);

      for (let up = ancestors.length - 1; up >= 0; up -= 1) {
        const index = ancestors[up]!;

        if (!ids.has(blocks[index]!.id)) {
          break;
        }

        pinned.add(index);
      }
    }

    ancestors.push(at);
  }

  return pinned;
}

/** A document holding only the given blocks, for the clipboard. */
export function sliceDocument(blocks: readonly Block[], ids: ReadonlySet<string>): NEditorDocument {
  const selected = blocks.filter((block) => ids.has(block.id));

  // Re-rooted so pasting it elsewhere does not carry absolute depths. The
  // re-clamp does it by tree: subtracting the first block's depth flattened
  // any later, shallower block's children onto it -- copying `A(2) B(3) C(1)
  // D(2)` lost D from under C, which matters when C is a collapsed toggle.
  return { blocks: normalizeDepths(selected.map(cloneBlock)) };
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
const INLINE_ESCAPE = /[\\`*_[\]~|<>$]/g;

/**
 * What a backtick code span cannot hold bare: {@link INLINE_ESCAPE} less `$`.
 *
 * A `$` in prose is escaped because `$…$` is a formula, but no formula opens
 * inside an open code span -- the reader refuses one there, as it refuses an
 * autolink -- so `` `echo $HOME` `` stays a backtick span rather than turning
 * into `<code>` markup for the sake of a character that was never ambiguous.
 */
const CODE_SPAN_UNSAFE = /[\\`*_[\]~|<>]/;

/**
 * A line-leading construct, which only matters for the first run of a block.
 *
 * The marker is escaped whatever follows it: a paragraph reading `---` is a
 * divider, and one reading `#` an empty heading, so requiring a space after the
 * marker let both through and destroyed the paragraph.
 */
const LEADING_MARKER = /^([#>+-])/;
// A soft break follows as `\` + newline, which the reader rejoins before
// testing for a prefix: `1.` then Shift+Enter came back a numbered list.
const LEADING_ORDINAL = /^(\d+)([.)])(?=\s|$|\\\n)/;

/**
 * Escapes run text for Markdown.
 *
 * A soft line break becomes a trailing backslash — CommonMark's hard break —
 * which `blocksFromMarkdown` rejoins. A literal backslash escapes to two, so
 * the trailing count stays unambiguous.
 */
function escapeMarkdownText(text: string): string {
  const urls = text.includes('_') ? bareUrls(text) : [];
  let url = 0;

  return text
    .replace(INLINE_ESCAPE, (char, offset: number) => {
      if (char === '_' && urls.length > 0) {
        // Visited in order, so the lookup is a pointer that only moves on.
        while (url < urls.length && urls[url]![1] <= offset) {
          url += 1;
        }

        if (
          url < urls.length &&
          urls[url]![0] <= offset &&
          ASCII_WORD.test(text[offset - 1] ?? '') &&
          ASCII_WORD.test(text[offset + 1] ?? '')
        ) {
          return char;
        }
      }

      return `\\${char}`;
    })
    .replace(REFERENCE_AMPERSAND, '\\&')
    .replaceAll('\n', '\\\n');
}

const ASCII_WORD = /[A-Za-z0-9]/;

/**
 * An absolute http(s) URL up to the first character an autolink cannot hold --
 * or a backslash: CommonMark takes an autolink's text as it stands, but this
 * reader resolves escapes before it looks for one, so `<http://a/c\>` never
 * closed. The backslash is written escaped after the `>` instead. And a `|`,
 * which inside one would still end a table cell.
 */
const AUTOLINKABLE = /https?:\/\/[^\s<>\\|]*/gi;

/**
 * What an autolink's text may not hold: it is plain text once the autolink
 * closes, so a delimiter or a bracket in it could pair with one written after
 * it -- `<https://a.test/*x>*y*` italicised the `x` out of the URL. Such a
 * URL keeps the escaped spelling, which other readers link with the
 * backslashes in it; nothing else does. Inside a struck run a single `~` is
 * one too: the run's own `~~` cannot close over a body holding a tilde.
 */
const UNSAFE_IN_AUTOLINK = /[*`[\]]|~~/;
const UNSAFE_IN_STRUCK_AUTOLINK = /[*`[\]~]/;
/** Punctuation GFM leaves out of the end of a bare URL it links. */
const TRAILING_URL_PUNCTUATION = new Set(['?', '!', '.', ',', ':', '*', '_', '~']);

/**
 * Where GFM would end a bare URL that starts at `start` and runs to `end`.
 *
 * It leaves trailing punctuation out, a trailing `)` that nothing in the URL
 * opened, and an `&…;` that looks like an entity reference. Walked back from
 * the end, with the parentheses counted once.
 */
function gfmUrlEnd(text: string, start: number, end: number): number {
  let opens = 0;
  let closes = 0;

  for (let at = start; at < end; at += 1) {
    const code = text.charCodeAt(at);
    opens += code === 40 ? 1 : 0;
    closes += code === 41 ? 1 : 0;
  }

  for (;;) {
    const char = text[end - 1] ?? '';

    if (TRAILING_URL_PUNCTUATION.has(char)) {
      end -= 1;
    } else if (char === ')' && closes > opens) {
      end -= 1;
      closes -= 1;
    } else if (char === ';') {
      let at = end - 2;

      while (at > start && /[A-Za-z0-9]/.test(text[at] ?? '')) {
        at -= 1;
      }

      if (at < end - 2 && text[at] === '&') {
        end = at;
      } else {
        return end;
      }
    } else {
      return end;
    }
  }
}

/**
 * Escapes a run's text, writing each bare http(s) URL in it as an autolink.
 *
 * GFM links a bare URL up to the next whitespace or `<`, so whatever this
 * writer put directly against one went into the link: the backslash of an
 * escape (`https://a.test/\~x`) or of a line break, and the `&#32;` that
 * keeps a trailing space. Inside `<…>` nothing is escaped -- CommonMark takes
 * an autolink's text as it stands -- and the `>` ends it for every reader.
 * The reader takes `<https://…>` back as the plain text it holds. A `www.`
 * URL has no autolink spelling and is escaped as before.
 */
function escapeWithAutolinks(text: string, struck = false, dollarAfter = false): string {
  if (!/https?:\/\//i.test(text)) {
    return escapeMarkdownText(text);
  }

  let written = '';
  let from = 0;
  const matches = [...text.matchAll(AUTOLINKABLE)];
  // Whether a URL after each one in this text holds a `$`: an autolink writes
  // it bare, so it pairs with this one's as a later run's would (see
  // `RunContext.dollarAfter`). One pass from the end.
  const laterDollar: boolean[] = [];

  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const later = matches[index + 1];
    laterDollar[index] =
      later !== undefined &&
      (laterDollar[index + 1] === true ||
        text
          .slice(later.index, gfmUrlEnd(text, later.index, later.index + later[0].length))
          .includes('$'));
  }

  for (const [index, match] of matches.entries()) {
    const start = match.index;
    const end = gfmUrlEnd(text, start, start + match[0].length);

    // A scheme with nothing after it links nowhere, in GFM or here. And one
    // longer than the reader's window is one it cannot close: written as an
    // autolink it came back with its brackets, one more pair every save.
    const unsafe = struck ? UNSAFE_IN_STRUCK_AUTOLINK : UNSAFE_IN_AUTOLINK;
    const url = text.slice(start, end);

    // A `$` is unsafe only where the reader has a bare `$` after it to pair
    // with (see `RunContext.dollarAfter`): an OData `?$filter=` written
    // escaped is a link with a backslash in it to GFM.
    if (
      end - start <= match[0].indexOf('//') + 2 ||
      end - start > INLINE_SPAN_LIMIT - 2 ||
      unsafe.test(url) ||
      ((dollarAfter || laterDollar[index] === true) && url.includes('$'))
    ) {
      continue;
    }

    written += `${escapeMarkdownText(text.slice(from, start))}<${text.slice(start, end)}>`;
    from = end;
  }

  return written + escapeMarkdownText(text.slice(from));
}

/**
 * The `[start, end)` spans of `text` that are bare URLs, in order.
 *
 * GFM links a bare URL and takes a backslash as part of it, so `x\\_y` there
 * linked to `x%5C_y` and showed the backslash. An http(s) URL is written as an
 * autolink instead (`escapeWithAutolinks`), so this is for what is left: a
 * `www.` URL, which has no autolink spelling. A `_` between two letters or
 * digits cannot open or close emphasis in CommonMark, and cannot open a span in
 * this reader either (its `_` rules refuse an opener after a word character),
 * so that one is written bare: every `_` that could open is still escaped, and
 * a closer with nothing to close is text. Any other `_`, and `*` and `~`, are
 * escaped as before: CommonMark would read them as emphasis, and that is the
 * worse failure.
 */
function bareUrls(text: string): Array<readonly [number, number]> {
  if (!BARE_URL_START.test(text)) {
    return [];
  }

  return [...text.matchAll(new RegExp(`(?:${BARE_URL_START.source})\\S*`, 'gi'))].map(
    (match) => [match.index, match.index + match[0].length] as const,
  );
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

  const led = markdown.replace(/^(?:\\\n|[^\S\n])+/, encode);

  // The trailing run is walked back from the end rather than matched: as a
  // pattern ending in `$` it was retried from every character of a whitespace
  // run in the middle of the text, which is quadratic in a long one.
  // It is looked for behind the closing tags of a run written as HTML, too. A
  // break left there puts `</strong>` alone on the last line, which micromark
  // takes for an HTML block: inside a list item or a quote that ended the
  // block early and showed the backslash.
  let end = led.length;

  for (;;) {
    const tag = MARK_CLOSERS.find((candidate) => led.endsWith(candidate, end));

    if (!tag) {
      break;
    }

    end -= tag.length;
  }

  let start = end;
  let broken = false;

  for (;;) {
    const char = led[start - 1] ?? '';

    if (char === '\n') {
      // Always preceded by the one backslash that marks it.
      start -= 2;
      broken = true;
    } else if (char !== '' && /\s/.test(char)) {
      start -= 1;
    } else {
      break;
    }
  }

  if (start === end || (end < led.length && !broken)) {
    return led;
  }

  // Inside a tag only a break needs moving, so the spaces before the first one
  // stay as they are: as `&#32;` against a URL they are taken into GFM's link.
  const from = end < led.length ? led.indexOf('\\\n', start) : start;

  return led.slice(0, from) + encode(led.slice(from, end)) + led.slice(end);
}

/**
 * Stops text that begins with `#`, `-` or `1.` becoming that block.
 *
 * Anchored at the very start: every caller passes text that has been through
 * `protectEdgeWhitespace`, so whitespace in front of a marker is already a
 * reference and the marker behind it is no marker to any reader.
 */
function escapeLeadingMarker(text: string): string {
  return text.replace(LEADING_ORDINAL, '$1\\$2').replace(LEADING_MARKER, '\\$1');
}

/**
 * Escapes a run of `#` that would close an ATX heading.
 *
 * CommonMark 4.2: `# a #` is the heading "a" -- a trailing run of `#` after a
 * space, or alone, is an optional closing sequence and is dropped.
 */
function escapeClosingSequence(text: string): string {
  return text.replace(/(^|[ \t])(#+)$/, '$1\\$2');
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
      // And `:-`: a GFM delimiter row needs no pipe, so `:---` under a line
      // makes that line a one-column table's header.
      .replace(/(\\\n[^\S\n]*:)(?=-)/g, '$1\\')
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
 * A backtick and a `<` too: a label is inline content to other readers, so a
 * backtick in an alt text paired with one in the caption, or `<!a` with a `>`
 * later on the line, swallowed the `](` between them and the image was gone.
 * For the same reason `*`, `_` and `~` would emphasise in them, and an `&`
 * would decode an entity: GFM read alt `*a*` as `a`.
 */
const LABEL_ESCAPE = /[\\[\]`<*_~&]/g;

/**
 * A label is one line. An alt attribute pasted from HTML can be wrapped, and
 * written raw the break split the image line in two: the block came back as
 * two paragraphs. A break means a space there, so each run of breaks, with the
 * whitespace around it, is written as one.
 *
 * Split and trimmed rather than matched: `\s*[\r\n]+\s*` is retried from every
 * character of a whitespace run that holds no break at all, which made an alt
 * text of 80,000 spaces take three seconds to write.
 */
function oneLine(text: string): string {
  if (!/[\r\n]/.test(text)) {
    return text;
  }

  const parts = text.split(/[\r\n]+/);
  const last = parts.length - 1;

  return parts
    .map((part, index) =>
      index === 0 ? part.trimEnd() : index === last ? part.trimStart() : part.trim(),
    )
    .filter((part, index) => index === 0 || index === last || part !== '')
    .join(' ');
}

function escapeMarkdownLabel(text: string): string {
  return oneLine(text).replace(LABEL_ESCAPE, (char) => `\\${char}`);
}

/** Characters a destination cannot hold bare: the first `)` would close it. */
const DESTINATION_UNSAFE = /[()<>\s]/;

/**
 * Writes a link or image destination.
 *
 * Anything holding a paren or whitespace goes in angle brackets, where a paren
 * needs no escape and the reader's pattern for the form can tell where the
 * destination ends.
 *
 * Inside either form five things are escaped, all of which the reader takes
 * back out of the content (`parseInlineMarkdown`): a backslash is doubled, or
 * it and an escapable character after it are an escape (`?q=a\_b` came back as
 * `?q=a_b`, and one ending the URL escaped the `)`); a `|` would end a table
 * cell, in this reader and in GFM; two backticks would close a code span
 * inside the destination (`?q=`y`` came back as `?q=y`); and an `&` that
 * begins a reference is decoded by other readers even here, so `?a=1&amp;b`
 * reached them as `?a=1&b`. And the `]` of a `](`, which is a link's hinge to
 * the rules: `?q=[foo](b.ar)` was made a link of its own and lost its brackets,
 * and after a closed `](b)` the rest of the destination read as prose, so
 * `*x*` there was emphasised.
 */
function destinationToMarkdown(url: string): string {
  // A model that predates `sanitizeImageUrl` unwrapping base64 may still hold it wrapped.
  const source = /^data:/i.test(url) ? url.replace(/\s+/g, '') : url;
  const escaped = source
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('`', '\\`')
    .replaceAll('](', '\\](')
    .replace(REFERENCE_AMPERSAND, '\\&');

  if (!DESTINATION_UNSAFE.test(source)) {
    return escaped;
  }

  // `<`, `>` and whitespace would end the bracketed form or the line, so they
  // are percent-encoded. An absolute URL that came through `sanitizeUrl` has
  // them encoded already; a relative one (`/a b`) does not, and comes back as
  // `/a%20b` -- the same resource, but not the same string.
  return `<${escaped.replace(/[<>\s]/g, (char) => encodeURIComponent(char))}>`;
}

/**
 * A link's destination with the formula atom percent-encoded.
 *
 * The link rule refuses a destination holding the atom, which in its
 * projection is where a formula closed (`matchInlineRule`), and `sanitizeUrl`
 * keeps a relative href as it was written: `[x](/a\uFFFC)` came back as that
 * text. Encoded as `%`-escapes it is the same resource, as `/a b` is
 * `/a%20b`. Only a link's: an image line is read whole, never by that rule,
 * and keeps its source as written.
 */
function linkDestination(url: string): string {
  return url.includes(MATH_ATOM) ? url.replaceAll(MATH_ATOM, '%EF%BF%BC') : url;
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

const MARK_CLOSERS = Object.values(MARK_TAGS).map((tag) => `</${tag}>`);

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
 * How long a span is as the reader counts it: an escape is one character, as
 * it is in the projection the inline rules match against.
 */
function readLength(markdown: string): number {
  let escapes = 0;

  for (let at = 0; at < markdown.length - 1; at += 1) {
    if (markdown.charCodeAt(at) === 92) {
      escapes += 1;
      at += 1;
    }
  }

  return markdown.length - escapes;
}

/**
 * Where to cut a span that is too long: the last space or line break at or
 * before `SAFE_SPAN`, or 0 if there is none.
 *
 * A line break too, because a long run of lines with no space in reach --
 * paths, identifiers -- otherwise went out as one span the reader could not
 * close, and came back as raw markup. A single unbroken token longer than the
 * bound cannot be cut without changing the text, so it is written whole and
 * does not round-trip. Nothing a person types looks like that.
 */
function splitPoint(text: string): number {
  return Math.max(text.lastIndexOf(' ', SAFE_SPAN), text.lastIndexOf('\n', SAFE_SPAN), 0);
}

/** What a run is written next to, and how the block it is in handles breaks. */
interface RunContext {
  /** The character before the run in its block, or '' at the start. */
  before?: string;
  /** The character after it, or '' at the end. */
  after?: string;
  /** Write HTML tags whatever the text: the run's delimiters would merge with a neighbour's. */
  tagged?: boolean;
  /** The run is a piece already cut to length, or one that cannot be cut: do not split it. */
  whole?: boolean;
  /** The run is in a table cell, where an unescaped `|` ends the cell. */
  inTable?: boolean;
  /**
   * A later run in the block is written with a bare `$` the reader can pair
   * with: a formula's, one in a code run, one in a link's destination, or one
   * in a URL that may be written as an autolink. An autolink's text is plain
   * once it closes, so a `$` in it then opens a formula that swallows the rest
   * of the URL -- `<https://a.test/a$b> c$y$` read as a formula `b> c`, and
   * `<https://a.test/_a$b>\_ [l](https://c.test/$)` lost the link to one. A
   * later URL in the same run is asked of in `escapeWithAutolinks`.
   */
  dollarAfter?: boolean;
}

/**
 * An inline formula as Markdown: `$TeX$`, the TeX exactly as it stands.
 *
 * Nothing inside is escaped: this reader and Pandoc take the text between the
 * dollars literally, so an escape written here would be a backslash in the
 * TeX, and TeX is full of characters this writer escapes elsewhere (`\`,
 * `_`, `*`, `|`). The reader recovers the TeX from the source between the
 * delimiters for the same reason, not from what its rules made of it. Readers
 * that run Markdown first and find math afterwards -- GitHub's, or KaTeX's
 * auto-render over rendered HTML -- may still emphasise inside a formula;
 * there is no spelling that is literal to every reader.
 *
 * Two shapes cannot be written, and both are invalid TeX: a bare `$` inside
 * the formula, which ends math mode in TeX as it ends the span here, and an
 * unpaired backslash at its end, which escapes the closing `$`. Edge
 * whitespace and line breaks never reach this point: the model normalizes
 * them away (`normalizeInlineTex`), since `$` cannot open or close against
 * whitespace.
 *
 * In a table cell a `|` is the one escape: GFM splits the row on unescaped
 * pipes before any inline parsing, and `\|` is how it spells a literal pipe --
 * in code spans and formulas alike -- turning it back into `|` before the cell
 * is read. A TeX `\|` therefore goes out as `\\|`.
 */
function mathToMarkdown(tex: string, inTable: boolean): string {
  return `$${inTable ? tex.replaceAll('|', '\\|') : tex}$`;
}

const PUNCTUATION = /[\p{P}\p{S}]/u;
const SPACE = /\s/u;

/**
 * Whether `*`-style delimiters around a run would open and close it.
 *
 * CommonMark's flanking rule, in the part that bites: a delimiter against
 * punctuation also needs whitespace or punctuation on its outer side, so
 * `word**(x)**` is literal asterisks there. `text` is what the delimiters
 * enclose as written -- the caller passes a code run's backtick, or the `*` a
 * `~~` wraps -- while `before` and `after` are the neighbouring runs' text,
 * which is conservative on that side: the character actually written there may
 * be another run's delimiter, punctuation, so this errs towards HTML where `**`
 * would have done. Delimiters of two runs that touch are the caller's to catch.
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
  if (isMathRun(run)) {
    return mathToMarkdown(run.math ?? '', context.inTable === true);
  }

  const marks = new Set(run.marks ?? []);
  // Link text is not a bare URL: GFM autolinks nothing inside a link. A code
  // run's text is not either, in a backtick span -- but one written as
  // `<code>…</code>` is ordinary inline text to other readers, which autolink
  // a URL in it like any other.
  const escaped =
    run.link === undefined
      ? escapeWithAutolinks(run.text, marks.has('strikethrough'), context.dollarAfter === true)
      : escapeMarkdownText(run.text);

  if (escaped.length === 0 || (marks.size === 0 && !run.link)) {
    return escaped;
  }

  // HTML where a delimiter cannot say it. Emphasis cannot open or close
  // against whitespace -- a space or a line break -- and CommonMark takes a
  // backtick span's content literally, so a code run that needed an escape, or
  // holds a line break (written `\` + newline), would show the backslash.
  const edged = /^\s|\s$/.test(run.text);
  // A reference is not one of those escapes: nothing decodes `&nbsp;` inside a
  // backtick span, here or in CommonMark, so code about HTML stays a span.
  const bare = marks.has('code') && !/[\n`]/.test(run.text) && !CODE_SPAN_UNSAFE.test(run.text);
  const literalCode = !marks.has('code') || bare;
  // Inside a link the delimiters sit against `[` and `]`, which always flank.
  const emphasis = marks.has('bold') || marks.has('italic') || marks.has('strikethrough');
  // Judged on what the delimiters will actually touch, which for a code run is
  // its backtick: `**`x`**1` is literal asterisks.
  // `~~` outside `**` or `*` touches an asterisk, and GFM holds it to the same
  // rule: `a~~**x**~~b` is literal tildes.
  const stacked = marks.has('strikethrough') && (marks.has('bold') || marks.has('italic'));
  // And for any other run, what is written: an autolink's `<` is punctuation
  // where the URL's first letter was not.
  const inner = marks.has('code') ? '`' : stacked ? '*' : escaped;
  const flanking =
    !emphasis || run.link !== undefined || flanks(inner, context.before ?? '', context.after ?? '');
  const tagged = context.tagged || edged || !literalCode || !flanking;
  let core = bare && !tagged ? run.text : escaped;

  for (const [mark, open, close] of MARK_DELIMITERS) {
    if (marks.has(mark)) {
      core = tagged ? `<${MARK_TAGS[mark]}>${core}</${MARK_TAGS[mark]}>` : `${open}${core}${close}`;
    }
  }

  if (run.link) {
    const destination = destinationToMarkdown(linkDestination(run.link));
    const linked = `[${core}](${destination})`;

    // A link longer than the reader reaches is never read as one (a known
    // failure: a URL has no shorter spelling), and nothing then protects its
    // destination either, so the emphasis and formula rules read straight
    // through it -- a long signed URL holding `_x_` came back with both
    // underscores gone. Escaped, the URL survives as its text, and a link the
    // reader does reach reads the same: it takes the href from the content.
    core =
      linked.length > INLINE_SPAN_LIMIT
        ? `[${core}](${destination.replace(/[*_~$]/g, '\\$&')})`
        : linked;

    // A destination that leaves the reach no room for even one character of
    // label beside it, counted as the reader counts, makes every piece of a
    // split unreadable: cut at its spaces, the link went out once a word with
    // its URL each time and came back as all of those spellings. Kept whole,
    // its text comes back once. Only then: wherever a piece could be read,
    // the split below is what it always was.
    if (readLength(destination) + 5 > INLINE_SPAN_LIMIT) {
      return core;
    }
  }

  // And one span per readable length: a span whose opening delimiter the reader
  // cannot reach is one it leaves in the prose as literal characters. Measured
  // on what was actually emitted rather than on the raw text, so a run only
  // splits when it really is too long for the reader.
  if (core.length <= INLINE_SPAN_LIMIT || context.whole) {
    return core;
  }

  // Piece by piece rather than head-and-recurse: recursing on the tail escaped
  // what was left of the run once per piece, which is quadratic in a long one.
  // The limit applies to what is emitted -- the escaped text and its delimiters
  // -- so a rest that might fit is written and measured; testing the raw text
  // against `SAFE_SPAN` instead split runs the reader would have read whole.
  const pieces: string[] = [];
  let rest = run.text;
  let written = core;
  // Each piece is escaped on its own, so it has to be told what the pieces
  // after it hold: a `$`-holding URL starting later in the run is written
  // bare as an autolink and pairs with one this piece writes bare, exactly as
  // a later run's would (`RunContext.dollarAfter`). Where the last such URL
  // starts, found once; `consumed` is where `rest` starts in the run.
  let lastDollarUrl = -1;

  if (run.text.includes('$')) {
    for (const match of run.text.matchAll(AUTOLINKABLE)) {
      const end = gfmUrlEnd(run.text, match.index, match.index + match[0].length);

      if (run.text.slice(match.index, end).includes('$')) {
        lastDollarUrl = match.index;
      }
    }
  }

  let consumed = 0;

  for (;;) {
    if (written.length <= INLINE_SPAN_LIMIT) {
      pieces.push(written);
      break;
    }

    const at = splitPoint(rest);

    if (at === 0) {
      pieces.push(written);
      break;
    }

    pieces.push(
      runToMarkdown(
        { ...run, text: rest.slice(0, at) },
        { ...context, dollarAfter: context.dollarAfter === true || lastDollarUrl >= consumed + at },
      ),
    );
    rest = rest.slice(at);
    consumed += at;
    // Escaping never shortens, so a rest longer than the limit is known to be
    // too long without being written.
    written =
      rest.length > INLINE_SPAN_LIMIT && splitPoint(rest) > 0
        ? rest
        : runToMarkdown({ ...run, text: rest }, { ...context, whole: true });
  }

  return pieces.join('');
}

/**
 * The line breaks of a block that must stay on one line -- a heading, a table
 * cell -- as `<br>`, which every reader renders as a break and this one reads
 * back as one. The single backslash in front of a newline is always the
 * break's own: a literal one is doubled.
 */
function oneLineBreaks(markdown: string): string {
  return markdown.replaceAll('\\\n', '<br>');
}

/** A GFM table. Row 0 is the header, which the delimiter row follows. */
function tableToMarkdown(block: Block, indent: string): string {
  const rows = block.rows ?? [];
  const { columns } = tableSize(rows);

  // A literal pipe would end the cell, so it has to be escaped.
  // Cells are trimmed on the way back, so their edge whitespace is protected too.
  // A GFM row is one line, so a break inside a cell is `<br>`, which is how GFM
  // tables spell one: written as `\` + newline it split the row in every other
  // reader. The one backslash before a newline is always the break's own (a
  // literal one is doubled), so it is that backslash that goes.
  const cellToMarkdown = (cell: readonly TextRun[]): string =>
    oneLineBreaks(protectEdgeWhitespace(richToMarkdown(cell, { inTable: true })));
  const line = (cells: readonly RichText[]): string =>
    `${indent}| ${cells.map(cellToMarkdown).join(' | ')} |`;

  const divider = `${indent}| ${Array.from({ length: columns }, () => '---').join(' | ')} |`;
  const [header, ...body] = rows;

  return header ? [line(header), divider, ...body.map(line)].join('\n') : `${indent}`;
}

/**
 * True when `text` ends in `char` and that character is not escaped.
 *
 * Counted back from the end: a pattern like `(\\*)!$` retries from every
 * backslash in a long run of them, which is quadratic.
 */
function endsUnescaped(text: string, char: string): boolean {
  if (!text.endsWith(char)) {
    return false;
  }

  let slashes = 0;

  while (text.charCodeAt(text.length - 2 - slashes) === 92) {
    slashes += 1;
  }

  return slashes % 2 === 0;
}

/** How many unescaped `*` a written run starts or ends with. */
function asterisks(written: string, side: 'start' | 'end'): number {
  let count = 0;

  if (side === 'start') {
    while (written[count] === '*') {
      count += 1;
    }

    return count;
  }

  while (written[written.length - 1 - count] === '*') {
    count += 1;
  }

  // The first of them is text if the run before it is an escape.
  return count > 0 && !endsUnescaped(written.slice(0, written.length - count + 1), '*')
    ? count - 1
    : count;
}

/** CommonMark's rule of three, for two delimiter runs that can each open and close. */
function unpairable(left: number, right: number): boolean {
  return (left + right) % 3 === 0 && (left % 3 !== 0 || right % 3 !== 0);
}

/** The character a run's delimiters sit against on one side: a code run's is its backtick. */
function innerEdge(run: TextRun | undefined, side: 'first' | 'last'): string {
  if (!run) {
    return '';
  }

  if (isMathRun(run)) {
    return '$';
  }

  return run.marks?.includes('code')
    ? '`'
    : ((side === 'first' ? run.text[0] : run.text.at(-1)) ?? '');
}

export function richToMarkdown(
  content: readonly TextRun[],
  options: { readonly inTable?: boolean } = {},
): string {
  // A carriage return is a line break to every reader, this one included:
  // written raw it split the block in two, and took a table apart row by row.
  // It is written as the break it is read as.
  if (content.some((run) => run.text.includes('\r'))) {
    return richToMarkdown(
      content.map((run) => ({ ...run, text: run.text.replace(/\r\n?/g, '\n') })),
      options,
    );
  }

  let previous = '';
  // A formula's neighbours stand against its `$`, which is what flanking
  // has to judge -- not the atom character the model holds in its place.
  const edge = (run: TextRun | undefined, side: 'first' | 'last'): string =>
    isMathRun(run) ? '$' : ((side === 'first' ? run?.text[0] : run?.text.at(-1)) ?? '');
  // Whether a run at or after each index is written with a bare `$`: one
  // pass from the end, never a search per run.
  const dollarFrom: boolean[] = [];

  for (let index = content.length - 1; index >= 0; index -= 1) {
    const run = content[index]!;

    dollarFrom[index] =
      dollarFrom[index + 1] === true ||
      isMathRun(run) ||
      (run.marks?.includes('code') === true && run.text.includes('$')) ||
      run.link?.includes('$') === true ||
      (run.text.includes('$') && /https?:\/\//i.test(run.text));
  }

  const contextAt = (index: number): RunContext => ({
    before: edge(content[index - 1], 'last'),
    after: edge(content[index + 1], 'first'),
    inTable: options.inTable === true,
    dollarAfter: dollarFrom[index + 1] === true,
  });
  // Each run is written once here and looked at twice: as the run after the
  // one being decided, and then as that run itself.
  let upcoming = content[0] ? runToMarkdown(content[0], contextAt(0)) : '';

  return content
    .map((run, index) => {
      const context = contextAt(index);
      const next = content[index + 1];
      let written = upcoming;

      upcoming = next ? runToMarkdown(next, contextAt(index + 1)) : '';

      // `**(**` then `**`(`**` is `**(****`(`**`: the two closing and opening
      // delimiters are one run of four to CommonMark, punctuation on both sides
      // lets it open as well as close, and the rule of three then leaves the
      // first span unclosed. Only measured between punctuation -- between
      // letters a pair of runs (`**a*****b***`) resolves as written, with the
      // two exceptions below.
      // `~~(~~` then `~~*(*~~` needs no such condition: four tildes are not
      // a strikethrough delimiter in GFM, whatever they stand between.
      const touching =
        (written.startsWith('~') && endsUnescaped(previous, '~')) ||
        (written.startsWith('*') &&
          endsUnescaped(previous, '*') &&
          ((PUNCTUATION.test(innerEdge(content[index - 1], 'last')) &&
            PUNCTUATION.test(innerEdge(run, 'first'))) ||
            // And one pair between letters: `***a***` then `*b*`, which
            // micromark closes as `<em><strong>a</strong>**b</em>` where
            // commonmark.js reads it as written. The other five pairs of
            // bold, italic and both agree in both.
            (previous.endsWith('***') && !written.startsWith('**')) ||
            // And one chain: `*a*` + `***b***` + `**c**` is a run of four and
            // then a run of five, each able to open and close, and CommonMark
            // will not pair two such runs whose lengths sum to a multiple of
            // three unless both lengths are. commonmark.js leaves `***b***`
            // literal; of the chains of bold, italic and both up to four runs
            // long, the ones that fail are exactly the ones with this sum.
            unpairable(
              asterisks(previous, 'end') + asterisks(written, 'start'),
              asterisks(written, 'end') + asterisks(upcoming, 'start'),
            )));

      if (touching) {
        written = runToMarkdown(run, { ...context, tagged: true });
      }

      // A digit straight after a formula would stop its `$` closing -- Pandoc's
      // rule, which the reader follows so that `$5-$10` stays a price range --
      // so it is written as the reference the reader decodes in that one place.
      if (isMathRun(content[index - 1]) && /^[0-9]/.test(written)) {
        written = `&#${written.charCodeAt(0)};${written.slice(1)}`;
      }

      // `!` straight before a link makes it an image in every other reader. An
      // even run of backslashes before it is escaped backslashes, not an escape.
      previous =
        content[index + 1]?.link && endsUnescaped(written, '!')
          ? `${written.slice(0, -1)}\\!`
          : written;

      return previous;
    })
    .join('');
}

/** Serializes the document to Markdown. Useful for copy/paste and export. */
export function toMarkdown(doc: NEditorDocument): string {
  const numbers = computeListNumbers(doc.blocks);
  // Where the children of the latest block at each depth start. A child sits
  // at its parent's content column: two spaces in for most parents, but past
  // `1. ` -- three, or four for `10. ` -- under a numbered item, where at two
  // every other reader ended the list and left the child outside it.
  const columns: number[] = [];

  return doc.blocks
    .map((block) => {
      let column = 0;

      for (let level = 0; level < block.depth; level += 1) {
        column = columns[level] ?? column + 2;
      }

      columns.length = block.depth;
      columns[block.depth] =
        column +
        (block.type === 'numbered_list' ? String(numbers.get(block.id) ?? 1).length + 2 : 2);

      const indent = ' '.repeat(column);
      // A code block is literal: its text must not be re-escaped as Markdown.
      // Nor is a display equation's TeX.
      const text = isLiteralType(block.type)
        ? // Its carriage returns are line breaks too. One left at the end
          // joined the newline before the closing fence into a single CRLF.
          blockText(block).replace(/\r\n?/g, '\n')
        : protectEdgeWhitespace(escapeContinuations(richToMarkdown(block.content)));
      // An empty block is a bare marker. The space after it is what makes the
      // marker readable, not what makes it a marker, and trailing whitespace
      // does not survive the trip back — ours trims it, and so does every other
      // tool the text passes through.
      const marked = (marker: string, body: string = text): string =>
        body.length === 0 ? `${indent}${marker}` : `${indent}${marker} ${body}`;

      switch (block.type) {
        // To this reader only a paragraph can be mistaken for another block by
        // its first characters. Every other reader also starts a block at a
        // marker inside a list item or a quote (`- 1. x` is a nested list,
        // `> # x` a heading), so their text is escaped the same way below.
        case 'paragraph':
          return `${indent}${escapeLeadingMarker(text)}`;
        // An ATX heading is one line in every reader, so a break inside one is
        // `<br>`, which they all render as one -- written as `\` + newline it
        // ended the heading there, and a span across it left its delimiters on
        // both sides. (Splitting each span at the break kept the delimiters
        // whole but lost the break's own mark, and other readers still showed
        // the backslash and a paragraph.)
        case 'heading1':
          return marked('#', escapeClosingSequence(oneLineBreaks(text)));
        case 'heading2':
          return marked('##', escapeClosingSequence(oneLineBreaks(text)));
        case 'heading3':
          return marked('###', escapeClosingSequence(oneLineBreaks(text)));
        // A bullet is the one block whose text can still be misread, because a
        // toggle is written as a bullet led by a triangle. Escaped here and
        // nowhere else: `\▾` is not an escape any CommonMark reader honours,
        // so escaping the triangle in ordinary prose would put a literal
        // backslash into everyone else's rendering of "press ▾ to expand".
        case 'bulleted_list':
          // Anchored at the very start: a triangle behind whitespace or a line
          // break needs nothing, because `protectEdgeWhitespace` has already
          // written what precedes it as references, and `- &#32;▾ x` is not a
          // toggle to the reader. (This used to skip leading whitespace and
          // escaped breaks itself, from before the edge was protected.)
          return marked('-', escapeLeadingMarker(text.replace(/^([\u25B8\u25BE])/, '\\$1')));
        case 'numbered_list':
          return marked(`${numbers.get(block.id) ?? 1}.`, escapeLeadingMarker(text));
        case 'todo':
          return marked(`- [${block.checked ? 'x' : ' '}]`);
        // A quote whose text opens with a link labelled `!…` would read as a
        // callout's `[!icon]`; the `!` is escaped inside the label.
        case 'quote':
          return marked('>', escapeLeadingMarker(text).replace(/^\[!/, '[\\!'));
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

          // The body is indented as far as the fence. Under a list item, a
          // line at the margin ends the item in every other reader, which then
          // saw an empty code block and the body as a paragraph outside the
          // list. The reader strips up to the fence's indentation again.
          const body = indent
            ? text
                .split('\n')
                .map((line) => (line === '' ? line : `${indent}${line}`))
                .join('\n')
            : text;

          return `${indent}${fence}\n${body}\n${indent}${fence}`;
        }
        // A display equation is fenced by `$$` lines, which Pandoc, GitHub and
        // KaTeX's auto-render all read, and indented under a list item for the
        // reason a code block's body is. Its TeX goes between them as it
        // stands; the reader takes the lines back verbatim, as it does a code
        // fence's. A line of the TeX that is itself `$$` would close the fence
        // early -- in TeX it would end display math there too.
        case 'math': {
          const body = indent
            ? text
                .split('\n')
                .map((line) => (line === '' ? line : `${indent}${line}`))
                .join('\n')
            : text;

          return `${indent}$$\n${body}\n${indent}$$`;
        }
        // The caption follows after a hard break: every other reader shows the
        // picture with the caption beneath it, and this one reads it back.
        case 'image': {
          const image = `${indent}![${escapeMarkdownLabel(block.alt ?? '')}](${destinationToMarkdown(
            block.src ?? '',
          )})`;

          // The caption's first line follows a break too, so its marker is
          // escaped -- and a `=` or a `:-`, as on any continuation line: `===`
          // under the image line made the image a heading in every other
          // reader, and `:---` made it a table header in GFM ones.
          return text.length === 0
            ? image
            : `${image}\\\n${escapeLeadingMarker(text)
                .replace(/^=/, '\\=')
                .replace(/^:(?=-)/, ':\\')}`;
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
