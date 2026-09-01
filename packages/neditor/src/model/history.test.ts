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
