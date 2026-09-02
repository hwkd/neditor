import { describe, expect, test } from 'vitest';

import { richFromPlainText, richToPlainText } from './rich-text.ts';
import type { TableRows } from './table.ts';
import {
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  cloneTableRows,
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
} from './table.ts';

/** A grid built from plain strings, for readable assertions. */
function grid(...rows: string[][]): TableRows {
  // Wrapped rather than passed by reference: `map` would hand the index to the
  // second parameter.
  return rows.map((row) => row.map((cell) => richFromPlainText(cell)));
}

const text = (rows: TableRows): string[][] => rows.map((row) => row.map(richToPlainText));

describe('createTableRows', () => {
  test('defaults to a 3x3 grid of empty cells', () => {
    expect(tableSize(createTableRows())).toEqual({ rows: 3, columns: 3 });
    expect(createTableRows()[0]?.[0]).toEqual([]);
  });

  test('never produces a degenerate table', () => {
    expect(tableSize(createTableRows(0, 0))).toEqual({ rows: 1, columns: 1 });
    expect(tableSize(createTableRows(-5, -5))).toEqual({ rows: 1, columns: 1 });
  });

  test('rows do not share cell arrays', () => {
    const rows = createTableRows(2, 2);

    expect(rows[0]).not.toBe(rows[1]);
  });
});

describe('normalizeTableRows', () => {
  test('anything unusable becomes a default grid', () => {
    expect(tableSize(normalizeTableRows(null))).toEqual({ rows: 3, columns: 3 });
    expect(tableSize(normalizeTableRows([]))).toEqual({ rows: 3, columns: 3 });
    expect(tableSize(normalizeTableRows('nope'))).toEqual({ rows: 3, columns: 3 });
  });

  test('ragged rows are padded to the widest, never truncated', () => {
    const rows = normalizeTableRows(grid(['a'], ['b', 'c', 'd']));

    expect(tableSize(rows)).toEqual({ rows: 2, columns: 3 });
    expect(text(rows)).toEqual([
      ['a', '', ''],
      ['b', 'c', 'd'],
    ]);
  });

  test('cell content is normalized too', () => {
    const rows = normalizeTableRows([[[{ text: 'a' }, { text: 'b' }]]]);

    expect(rows[0]?.[0]).toEqual([{ text: 'ab' }]);
  });
});

describe('reading and writing cells', () => {
  test('setCell replaces exactly one cell', () => {
    const rows = tableSetCell(grid(['a', 'b'], ['c', 'd']), 1, 0, richFromPlainText('X'));

    expect(text(rows)).toEqual([
      ['a', 'b'],
      ['X', 'd'],
    ]);
  });

  test('setCell does not mutate the input', () => {
    const rows = grid(['a']);
    tableSetCell(rows, 0, 0, richFromPlainText('X'));

    expect(text(rows)).toEqual([['a']]);
  });

  test('an out-of-range write is a no-op, not a crash', () => {
    const rows = grid(['a']);

    expect(text(tableSetCell(rows, 9, 9, richFromPlainText('X')))).toEqual([['a']]);
  });

  test('tableCell reads back what was written', () => {
    const rows = tableSetCell(grid(['a']), 0, 0, richFromPlainText('X'));

    expect(richToPlainText(tableCell(rows, 0, 0) ?? [])).toBe('X');
    expect(tableCell(rows, 5, 5)).toBeUndefined();
  });

  test('cloning severs shared references', () => {
    const rows = grid(['a']);
    const copy = cloneTableRows(rows);
    copy[0]![0]![0]!.text = 'changed';

    expect(text(rows)).toEqual([['a']]);
  });
});

describe('rows', () => {
  test('insert puts an empty row at the index', () => {
    expect(text(tableInsertRow(grid(['a'], ['b']), 1))).toEqual([['a'], [''], ['b']]);
  });

  test('insert at the length appends', () => {
    expect(text(tableInsertRow(grid(['a']), 1))).toEqual([['a'], ['']]);
    expect(text(tableInsertRow(grid(['a']), 99))).toEqual([['a'], ['']]);
  });

  test('the new row is as wide as the table', () => {
    expect(tableSize(tableInsertRow(grid(['a', 'b', 'c']), 0))).toEqual({ rows: 2, columns: 3 });
  });

  test('delete removes the row at the index', () => {
    expect(text(tableDeleteRow(grid(['a'], ['b'], ['c']), 1))).toEqual([['a'], ['c']]);
  });

  test('deleting the last row empties it rather than leaving no table', () => {
    const rows = tableDeleteRow(grid(['a', 'b']), 0);

    expect(tableSize(rows)).toEqual({ rows: 1, columns: 2 });
    expect(text(rows)).toEqual([['', '']]);
  });
});

describe('columns', () => {
  test('insert adds a cell to every row', () => {
    expect(text(tableInsertColumn(grid(['a', 'b'], ['c', 'd']), 1))).toEqual([
      ['a', '', 'b'],
      ['c', '', 'd'],
    ]);
  });

  test('insert at the width appends', () => {
    expect(text(tableInsertColumn(grid(['a']), 1))).toEqual([['a', '']]);
  });

  test('delete removes the column from every row', () => {
    expect(text(tableDeleteColumn(grid(['a', 'b', 'c'], ['d', 'e', 'f']), 1))).toEqual([
      ['a', 'c'],
      ['d', 'f'],
    ]);
  });

  test('deleting the last column empties it rather than leaving no table', () => {
    const rows = tableDeleteColumn(grid(['a'], ['b']), 0);

    expect(tableSize(rows)).toEqual({ rows: 2, columns: 1 });
    expect(text(rows)).toEqual([[''], ['']]);
  });

  test('the grid stays rectangular through every operation', () => {
    let rows = createTableRows(2, 2);
    rows = tableInsertColumn(rows, 0);
    rows = tableInsertRow(rows, 1);
    rows = tableDeleteColumn(rows, 2);

    const widths = new Set(rows.map((row) => row.length));

    expect(widths.size).toBe(1);
  });
});

/**
 * A grid is the only place a small document expands into a large one: squaring
 * off ragged rows multiplies the two dimensions, and the renderer builds a cell
 * element and its own contenteditable host for every product. Depth has
 * MAX_DEPTH for the same reason.
 */
describe('a grid is bounded in both directions', () => {
  test('a ragged document cannot be padded into a grid nobody wrote', () => {
    // A few kB of JSON: one wide row and a column of stubs. Squaring that off
    // without a cap turns 1,400 written cells into 240,000 rendered ones, and
    // the ratio is the attacker's to choose.
    const wide = Array.from({ length: 200 }, () => []);
    const hostile = [wide, ...Array.from({ length: 1199 }, () => [[]])];
    const { rows, columns } = tableSize(normalizeTableRows(hostile));

    expect(rows).toBe(MAX_TABLE_ROWS);
    expect(columns).toBe(MAX_TABLE_COLUMNS);
  });

  test('createTableRows will not build a grid the model would reject', () => {
    // Public API: the counts are arguments, not facts.
    expect(tableSize(createTableRows(MAX_TABLE_ROWS + 10, MAX_TABLE_COLUMNS + 10))).toEqual({
      rows: MAX_TABLE_ROWS,
      columns: MAX_TABLE_COLUMNS,
    });
  });

  test('editing stops at the cap, so nothing is truncated on reload', () => {
    // A cap enforced only on load is a data loss, not a limit.
    const full = createTableRows(MAX_TABLE_ROWS, MAX_TABLE_COLUMNS);

    expect(tableSize(tableInsertRow(full, full.length))).toEqual({
      rows: MAX_TABLE_ROWS,
      columns: MAX_TABLE_COLUMNS,
    });
    expect(tableSize(tableInsertColumn(full, 0))).toEqual({
      rows: MAX_TABLE_ROWS,
      columns: MAX_TABLE_COLUMNS,
    });
    expect(tableSize(normalizeTableRows(full))).toEqual({
      rows: MAX_TABLE_ROWS,
      columns: MAX_TABLE_COLUMNS,
    });
  });

  test('a refused insert still returns a fresh grid', () => {
    // Every operation in this module hands back new arrays; the caps must not
    // be the one path that leaks the caller's rows back to it.
    const full = createTableRows(MAX_TABLE_ROWS, 2);
    const next = tableInsertRow(full, 0);

    expect(next).not.toBe(full);
    expect(next[0]).not.toBe(full[0]);
  });

  test('a row count no one would write is truncated, not thrown on', () => {
    // Ran last on purpose: this is the input that used to reach
    // `Math.max(...rows.map(…))` with an argument per row and take the call
    // stack with it, which is a crash rather than a failed assertion.
    const many = Array.from({ length: 200_000 }, () => [[]]);

    expect(tableSize(normalizeTableRows(many)).rows).toBe(MAX_TABLE_ROWS);
  });
});

describe('tableStep', () => {
  const rows = grid(['a', 'b'], ['c', 'd']);

  test('walks the grid in reading order', () => {
    expect(tableStep(rows, 0, 0, 1)).toEqual({ row: 0, column: 1 });
    expect(tableStep(rows, 0, 1, 1)).toEqual({ row: 1, column: 0 });
    expect(tableStep(rows, 1, 0, -1)).toEqual({ row: 0, column: 1 });
  });

  test('returns null past either end, which is what grows the table', () => {
    expect(tableStep(rows, 0, 0, -1)).toBe(null);
    expect(tableStep(rows, 1, 1, 1)).toBe(null);
  });
});
