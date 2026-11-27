import { describe, expect, test } from 'vitest';

import { createBlock } from './document.ts';
import type { HistoryEntry } from './history.ts';
import { History } from './history.ts';

/** A controllable clock, so coalescing is tested without wall time. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1000;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

function entry(label: string): HistoryEntry {
  return { blocks: [createBlock('paragraph', label)], selection: null };
}

function label(entry: HistoryEntry | null): string | null {
  return entry?.blocks[0]?.content[0]?.text ?? null;
}

describe('History', () => {
  test('starts empty', () => {
    const history = new History();

    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.undo(entry('now'))).toBe(null);
    expect(history.redo(entry('now'))).toBe(null);
  });

  test('undo walks back through recorded states', () => {
    const history = new History();

    history.record(entry('a'));
    history.record(entry('b'));

    expect(label(history.undo(entry('c')))).toBe('b');
    expect(label(history.undo(entry('b')))).toBe('a');
    expect(history.canUndo).toBe(false);
  });

  test('redo replays what undo walked back over', () => {
    const history = new History();

    history.record(entry('a'));
    const undone = history.undo(entry('b'));

    expect(label(undone)).toBe('a');
    expect(history.canRedo).toBe(true);
    expect(label(history.redo(entry('a')))).toBe('b');
    expect(history.canRedo).toBe(false);
  });

  test('a full undo/redo cycle returns to where it started', () => {
    const history = new History();

    history.record(entry('one'));
    history.record(entry('two'));

    const back1 = history.undo(entry('three'))!;
    const back2 = history.undo(back1)!;

    expect(label(back2)).toBe('one');

    const forward1 = history.redo(back2)!;
    const forward2 = history.redo(forward1)!;

    expect(label(forward1)).toBe('two');
    expect(label(forward2)).toBe('three');
  });

  test('a new edit discards the redo branch', () => {
    const history = new History();

    history.record(entry('a'));
    history.undo(entry('b'));

    expect(history.canRedo).toBe(true);

    history.record(entry('c'));

    expect(history.canRedo).toBe(false);
  });

  test('the selection travels with the entry', () => {
    const history = new History();
    const selection = { blockId: 'b1', start: 3, end: 7 };

    history.record({ blocks: [], selection });

    expect(history.undo({ blocks: [], selection: null })?.selection).toEqual(selection);
  });

  test('the oldest entry is dropped past the limit', () => {
    const history = new History({ limit: 2 });

    history.record(entry('a'));
    history.record(entry('b'));
    history.record(entry('c'));

    expect(label(history.undo(entry('d')))).toBe('c');
    expect(label(history.undo(entry('c')))).toBe('b');
    expect(history.canUndo).toBe(false);
  });

  test('clear empties both stacks', () => {
    const history = new History();

    history.record(entry('a'));
    history.undo(entry('b'));
    history.clear();

    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });
});

describe('coalescing', () => {
  test('a run of same-key edits folds into one entry', () => {
    const time = clock();
    const history = new History({ coalesceMs: 600, now: time.now });

    history.record(entry('empty'), 'insert:b1');
    time.advance(100);
    history.record(entry('h'), 'insert:b1');
    time.advance(100);
    history.record(entry('he'), 'insert:b1');

    // One undo returns to before the whole run, not one character back.
    expect(label(history.undo(entry('hel')))).toBe('empty');
    expect(history.canUndo).toBe(false);
  });

  test('a pause longer than the window starts a new entry', () => {
    const time = clock();
    const history = new History({ coalesceMs: 600, now: time.now });

    history.record(entry('empty'), 'insert:b1');
    time.advance(700);
    history.record(entry('hello'), 'insert:b1');

    expect(label(history.undo(entry('hello world')))).toBe('hello');
    expect(label(history.undo(entry('hello')))).toBe('empty');
  });

  test('a different key breaks the run', () => {
    const time = clock();
    const history = new History({ coalesceMs: 600, now: time.now });

    history.record(entry('empty'), 'insert:b1');
    time.advance(10);
    history.record(entry('typed'), 'insert:b2');

    expect(label(history.undo(entry('later')))).toBe('typed');
    expect(label(history.undo(entry('typed')))).toBe('empty');
  });

  test('a null key never folds, even back to back', () => {
    const time = clock();
    const history = new History({ coalesceMs: 600, now: time.now });

    history.record(entry('a'), null);
    history.record(entry('b'), null);

    expect(label(history.undo(entry('c')))).toBe('b');
    expect(label(history.undo(entry('b')))).toBe('a');
  });

  test('breakRun ends the run explicitly', () => {
    const time = clock();
    const history = new History({ coalesceMs: 600, now: time.now });

    history.record(entry('empty'), 'insert:b1');
    history.breakRun();
    history.record(entry('typed'), 'insert:b1');

    expect(label(history.undo(entry('typed more')))).toBe('typed');
    expect(label(history.undo(entry('typed')))).toBe('empty');
  });

  test('undo breaks the run, so redo is not folded away', () => {
    const time = clock();
    const history = new History({ coalesceMs: 600, now: time.now });

    history.record(entry('a'), 'insert:b1');
    history.undo(entry('b'));
    history.record(entry('c'), 'insert:b1');

    expect(label(history.undo(entry('d')))).toBe('c');
  });

  test('a coalesced edit still discards the redo branch', () => {
    const time = clock();
    const history = new History({ coalesceMs: 600, now: time.now });

    history.record(entry('a'), 'insert:b1');
    history.undo(entry('b'));
    expect(history.canRedo).toBe(true);

    // Same key, but the run was broken by undo, so this is a fresh entry.
    history.record(entry('c'), 'insert:b1');
    expect(history.canRedo).toBe(false);
  });
});

describe('the limit is a number of entries, whatever it was given', () => {
  // `Math.max(1, NaN)` is NaN, and `length > NaN` is never true: a limit read
  // from a bad config string kept every entry the editor ever recorded.
  test('NaN keeps the default bound', () => {
    const history = new History({ limit: Number.NaN });
    for (let i = 0; i < 300; i++) {
      history.record({ blocks: [], selection: null });
    }
    let n = 0;
    while (history.undo({ blocks: [], selection: null })) {
      n += 1;
    }

    expect(n).toBe(200);
  });

  test('a limit below one still keeps exactly one entry', () => {
    const history = new History({ limit: 0.5 });
    history.record({ blocks: [], selection: null });
    history.record({ blocks: [], selection: null });

    expect(history.undo({ blocks: [], selection: null })).not.toBeNull();
    expect(history.undo({ blocks: [], selection: null })).toBeNull();
  });
});

describe('redo restores where the redone edit left the reader (TXT-12)', () => {
  const at = (blockId: string, start: number, end = start) => ({ blockId, start, end });

  test('a settled edit redoes to its settled selection, not to the caret at undo time', () => {
    const history = new History();
    // Bold "world": recorded with the range it started from, settled on it.
    history.record({ blocks: entry('plain').blocks, selection: at('p', 6, 11) });
    history.settle({ selection: at('p', 6, 11) });
    // Enter at the end, from a bare caret the arrow key left.
    history.record({ blocks: entry('bold').blocks, selection: at('p', 11) });
    history.settle({ selection: at('q', 0) });

    const enterUndone = history.undo({ blocks: entry('split').blocks, selection: at('q', 0) });
    // The second undo is pressed with the caret where the first one put it.
    history.undo({ blocks: entry('bold').blocks, selection: enterUndone!.selection });

    const plain = { blocks: entry('plain').blocks, selection: at('p', 6, 11) };
    expect(history.redo(plain)?.selection).toEqual(at('p', 6, 11));
    // And redoing the Enter comes back to the new block, where it left the caret.
    const bold = { blocks: entry('bold').blocks, selection: at('p', 6, 11) };
    expect(history.redo(bold)?.selection).toEqual(at('q', 0));
  });

  test('undo after redo still restores where the edit began', () => {
    const history = new History();
    history.record({ blocks: entry('a').blocks, selection: at('p', 3) });
    history.settle({ selection: at('p', 8) });

    history.undo({ blocks: entry('b').blocks, selection: at('p', 8) });
    history.redo({ blocks: entry('a').blocks, selection: at('p', 0) });

    const again = history.undo({ blocks: entry('b').blocks, selection: at('p', 8) });
    expect(again?.selection).toEqual(at('p', 3));
  });

  test('two edits recorded before a settle: the first ends where the second began', () => {
    const history = new History();
    // A keystroke and the input rule it fires, in one task.
    history.record({ blocks: entry('a').blocks, selection: at('p', 1) });
    history.record({ blocks: entry('b').blocks, selection: at('p', 2) });
    history.settle({ selection: at('p', 0) });

    history.undo({ blocks: entry('c').blocks, selection: at('p', 0) });
    history.undo({ blocks: entry('b').blocks, selection: at('p', 2) });

    expect(history.redo({ blocks: entry('a').blocks, selection: null })?.selection).toEqual(
      at('p', 2),
    );
  });

  test('a settle that arrives after an undo describes nothing', () => {
    const history = new History();
    history.record({ blocks: entry('a').blocks, selection: at('p', 1) });
    history.undo({ blocks: entry('b').blocks, selection: at('p', 4) });
    history.settle({ selection: at('x', 9) });

    expect(history.redo({ blocks: entry('a').blocks, selection: null })?.selection).toEqual(
      at('p', 4),
    );
  });
});
