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
}

export interface HistoryEntry {
  blocks: Block[];
  selection: SelectionSnapshot | null;
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

  constructor(options: HistoryOptions = {}) {
    this.#limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
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
      return;
    }

    this.#undo.push(entry);

    if (this.#undo.length > this.#limit) {
      this.#undo.shift();
    }
  }

  /** Ends the current run, so the next edit starts a fresh entry. */
  breakRun(): void {
    this.#runKey = null;
  }

  /** Returns the state to restore, having banked `current` for redo. */
  undo(current: HistoryEntry): HistoryEntry | null {
    const entry = this.#undo.pop();

    if (!entry) {
      return null;
    }

    this.#redo.push(current);
    this.breakRun();

    return entry;
  }

  /** Returns the state to restore, having banked `current` for undo. */
  redo(current: HistoryEntry): HistoryEntry | null {
    const entry = this.#redo.pop();

    if (!entry) {
      return null;
    }

    this.#undo.push(current);
    this.breakRun();

    return entry;
  }

  clear(): void {
    this.#undo.length = 0;
    this.#redo.length = 0;
    this.breakRun();
  }
}
