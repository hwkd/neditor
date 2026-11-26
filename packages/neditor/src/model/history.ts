import type { Block } from './document.ts';

/**
 * Undo/redo.
 *
 * Every structural edit in this package returns a *new* block array while
 * reusing the block objects it did not touch, so a history entry is just an
 * array of references — a snapshot costs one pointer per block, not a deep
 * copy. That makes plain snapshots cheaper here than a command log, and it
 * removes the whole class of bugs where an inverse operation is wrong.
 *
 * Entries pair the document with the selection that was live when it was
 * current, so undo puts the caret back where the user left it rather than at
 * the start of the block.
 */

export interface SelectionSnapshot {
  blockId: string;
  start: number;
  end: number;
  /**
   * Which table cell the offsets belong to, when the block is a table.
   *
   * Without it, undo restores the caret to the block's first host — so fixing a
   * typo in the last cell and pressing undo moved the caret to the header.
   */
  cell?: { row: number; column: number };
  /**
   * The reader made the selection from `end` back to `start` (Shift+←). Kept so
   * a restored selection goes on growing from the end the reader was moving.
   */
  backward?: true;
}

/** Where the reader was: a caret or text range, or a set of whole blocks. */
export type HistorySelection = Pick<
  HistoryEntry,
  'selection' | 'selectedBlocks' | 'selectionAnchor'
>;

export interface HistoryEntry {
  blocks: Block[];
  selection: SelectionSnapshot | null;
  /**
   * The blocks selected as units when the entry was recorded, if any.
   *
   * An edit made on a block selection has no caret for `selection` to record,
   * so undo had nothing to restore and fell back to the first block of the
   * document -- deleting block 7 of a long page and undoing scrolled the user
   * to the top.
   */
  selectedBlocks?: readonly string[];
  /**
   * The end the block selection grows from. Restored with the selection, so
   * Shift+Arrow after undo shrinks or grows it the way it did before the edit.
   */
  selectionAnchor?: string;
  /**
   * Where the edit this entry undoes left the reader, which is what redoing it
   * restores. Filled in by {@link History.settle} once the edit has placed its
   * caret.
   *
   * Without it redo restored the selection banked when undo was pressed --
   * after several undos, that is the caret the *following* edit started from:
   * redoing a bold put a bare caret after the text instead of selecting it
   * again, and redoing a typed word left the caret where a later arrow key had
   * moved it.
   */
  after?: HistorySelection;
}

export interface HistoryOptions {
  /** Entries kept before the oldest is dropped. */
  limit?: number;
  /** How long a run of same-kind edits keeps folding into one entry. */
  coalesceMs?: number;
  /** Injectable clock, so tests do not depend on wall time. */
  now?: () => number;
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

const DEFAULT_LIMIT = 200;

/**
 * Typing for this long without a break folds into a single undo step. Long
 * enough that a sentence undoes at once, short enough that a pause to think
 * becomes its own step.
 */
const DEFAULT_COALESCE_MS = 600;

export class History {
  readonly #undo: HistoryEntry[] = [];
  readonly #redo: HistoryEntry[] = [];
  readonly #limit: number;
  readonly #coalesceMs: number;
  readonly #now: () => number;

  /** Identifies the current run of foldable edits, e.g. `insert:block-3`. */
  #runKey: string | null = null;
  #runAt = 0;

  /** The entry the latest record went into, until it settles or history moves. */
  #settling: HistoryEntry | null = null;

  /**
   * The entry each redo entry was made from, so redoing puts that very entry
   * back -- with the selection it recorded before the edit, and the one the
   * edit left behind -- rather than one rebuilt from wherever the caret is now.
   */
  readonly #undone = new WeakMap<HistoryEntry, HistoryEntry>();

  constructor(options: HistoryOptions = {}) {
    // `Math.max(1, NaN)` is NaN, and `length > NaN` is never true, so a limit
    // read from a bad config string kept every entry ever recorded. NaN and
    // non-numbers take the default; Infinity stays a deliberate "unlimited".
    const limit =
      typeof options.limit === 'number' && !Number.isNaN(options.limit)
        ? options.limit
        : DEFAULT_LIMIT;
    this.#limit = Math.max(1, limit);
    this.#coalesceMs = Math.max(0, options.coalesceMs ?? DEFAULT_COALESCE_MS);
    this.#now = options.now ?? Date.now;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  get state(): HistoryState {
    return { canUndo: this.canUndo, canRedo: this.canRedo };
  }

  /**
   * Records the state *before* an edit.
   *
   * `runKey` groups edits that should undo together — typing consecutive
   * characters into one block. Pass null for anything that must stand alone.
   * A continued run keeps the entry it already pushed, which is precisely the
   * state from before the run started.
   */
  record(entry: HistoryEntry, runKey: string | null = null): void {
    const now = this.#now();
    const continues =
      runKey !== null && runKey === this.#runKey && now - this.#runAt <= this.#coalesceMs;

    this.#runKey = runKey;
    this.#runAt = now;

    // Any new edit invalidates the redo branch, coalesced or not.
    this.#redo.length = 0;

    if (continues) {
      // The run's entry still holds the state from before it began; where the
      // run has got to is what the next settle reports.
      this.#settling = this.#undo.at(-1) ?? null;
      return;
    }

    // An edit recorded before the previous one settled happened in the same
    // breath -- an input rule converting the block the keystroke just typed
    // into -- so nothing can have moved in between: where this one starts is
    // exactly where that one left the reader.
    if (this.#settling) {
      this.#settling.after = {
        selection: entry.selection,
        ...(entry.selectedBlocks ? { selectedBlocks: entry.selectedBlocks } : {}),
        ...(entry.selectionAnchor !== undefined ? { selectionAnchor: entry.selectionAnchor } : {}),
      };
    }

    this.#settling = entry;
    this.#undo.push(entry);

    if (this.#undo.length > this.#limit) {
      this.#undo.shift();
    }
  }

  /** Ends the current run, so the next edit starts a fresh entry. */
  breakRun(): void {
    this.#runKey = null;
  }

  /**
   * Records where the latest edit left the reader, for redo to restore.
   *
   * Called once the edit has placed its caret. A no-op when it has already
   * settled, or an undo or redo has happened since the record, so a late call
   * cannot describe a document that has been travelled away from.
   */
  settle(after: HistorySelection): void {
    if (this.#settling) {
      this.#settling.after = after;
      this.#settling = null;
    }
  }

  /** Returns the state to restore, having banked `current` for redo. */
  undo(current: HistoryEntry): HistoryEntry | null {
    const entry = this.#undo.pop();

    if (!entry) {
      return null;
    }

    // Redo goes back to where the edit left the reader, when that is known:
    // `current` is wherever the caret is at the moment of undoing, which after
    // an earlier undo is the selection the *next* edit had started from.
    const after = entry.after;
    const known = after && (after.selection || (after.selectedBlocks?.length ?? 0) > 0);
    const redo: HistoryEntry = known ? { blocks: current.blocks, ...after } : current;

    this.#undone.set(redo, entry);
    this.#redo.push(redo);
    this.#settling = null;
    this.breakRun();

    return entry;
  }

  /** Returns the state to restore, having banked `current` for undo. */
  redo(current: HistoryEntry): HistoryEntry | null {
    const entry = this.#redo.pop();

    if (!entry) {
      return null;
    }

    // The entry undo took off the stack goes back on it, selections and all;
    // `current.blocks` is that entry's document, restored by the undo.
    const undone = this.#undone.get(entry);
    this.#undo.push(undone ? { ...undone, blocks: current.blocks } : current);
    this.#settling = null;
    this.breakRun();

    return entry;
  }

  clear(): void {
    this.#undo.length = 0;
    this.#redo.length = 0;
    this.#settling = null;
    this.breakRun();
  }
}
