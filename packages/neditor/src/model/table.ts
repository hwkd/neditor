import type { RichText } from './rich-text.ts';
import { cloneRichText, normalizeRuns } from './rich-text.ts';

/**
 * Table geometry.
 *
 * A table is one block holding a rectangular grid of rich text, rather than a
 * container of blocks. Cells hold text, not arbitrary structure, so the flat
 * block list stays flat and every other feature — undo, selection, the
 * clipboard — keeps working on the table as a single unit.
 *
 * Every operation returns a new grid and guarantees the result is rectangular
 * and non-empty, so the renderer never has to reason about ragged rows.
 */

export type TableRows = RichText[][];

export const MIN_TABLE_SIZE = 1;

/**
 * The largest grid a table may hold.
 *
 * A grid is the one place in the model where a small document expands into a
 * large one. {@link normalizeTableRows} squares off ragged rows, so a stored
 * table declaring one row of 5,000 cells and 5,000 rows of one cell is a few
 * hundred kilobytes of JSON that becomes 25 million cells — and the renderer
 * builds an element and its own contenteditable host per cell, so the page is
 * gone long before the last one is created.
 *
 * Depth has `MAX_DEPTH` for exactly this reason; a grid multiplies where depth
 * only adds, so it needs the bound more. Like that one it binds edits too, not
 * just loads: a cap enforced only on the way in would truncate on reload a
 * table the editor had been happy to grow.
 */
export const MAX_TABLE_ROWS = 1000;
export const MAX_TABLE_COLUMNS = 64;

export interface TableSize {
  readonly rows: number;
  readonly columns: number;
}

export function tableSize(rows: TableRows): TableSize {
  return { rows: rows.length, columns: rows[0]?.length ?? 0 };
}

/** A dimension inside `[MIN_TABLE_SIZE, max]`. NaN falls back to the minimum. */
function clamp(value: number, max: number): number {
  return Math.min(max, Math.max(MIN_TABLE_SIZE, Math.trunc(value) || MIN_TABLE_SIZE));
}

export function createTableRows(rowCount = 3, columnCount = 3): TableRows {
  // Public API, so the counts are arguments rather than facts. Bounded the same
  // way a stored grid is: `Array.from({ length: 1e9 })` is not a table.
  const rows = clamp(rowCount, MAX_TABLE_ROWS);
  const columns = clamp(columnCount, MAX_TABLE_COLUMNS);

  return Array.from({ length: rows }, () => Array.from({ length: columns }, (): RichText => []));
}

/** Coerces anything grid-shaped into a rectangular, non-empty table. */
export function normalizeTableRows(value: unknown): TableRows {
  if (!Array.isArray(value) || value.length === 0) {
    return createTableRows();
  }

  const rows = (value.filter(Array.isArray) as unknown[][]).slice(0, MAX_TABLE_ROWS);

  if (rows.length === 0) {
    return createTableRows();
  }

  // The widest row sets the width; short rows are padded rather than dropped.
  //
  // Folded rather than spread. `Math.max(...rows.map(…))` passes one argument
  // per row and overflows the call stack somewhere north of 100,000 of them,
  // which is a RangeError out of `setDocument` for a document that merely has a
  // lot of rows. The slice above already keeps it under that today; the fold is
  // what stops raising MAX_TABLE_ROWS from quietly reintroducing the crash.
  const columns = Math.min(
    MAX_TABLE_COLUMNS,
    rows.reduce((widest, row) => Math.max(widest, row.length), MIN_TABLE_SIZE),
  );

  return rows.map((row) =>
    Array.from({ length: columns }, (_, index) => normalizeRuns((row[index] ?? []) as RichText)),
  );
}

export function cloneTableRows(rows: TableRows): TableRows {
  return rows.map((row) => row.map(cloneRichText));
}

export function tableCell(rows: TableRows, row: number, column: number): RichText | undefined {
  return rows[row]?.[column];
}

export function tableSetCell(
  rows: TableRows,
  row: number,
  column: number,
  content: RichText,
): TableRows {
  if (!rows[row] || rows[row][column] === undefined) {
    return rows.map((current) => [...current]);
  }

  return rows.map((current, rowIndex) =>
    current.map((cell, columnIndex) =>
      rowIndex === row && columnIndex === column ? normalizeRuns(content) : cell,
    ),
  );
}

/**
 * Inserts an empty row. `at` is clamped, so `length` appends.
 *
 * At {@link MAX_TABLE_ROWS} the grid is returned unchanged, so the editor
 * cannot build a table that `normalizeTableRows` would truncate on reload.
 */
export function tableInsertRow(rows: TableRows, at: number): TableRows {
  const { columns } = tableSize(rows);

  if (rows.length >= MAX_TABLE_ROWS) {
    return rows.map((row) => [...row]);
  }

  const next = rows.map((row) => [...row]);
  next.splice(
    Math.max(0, Math.min(at, next.length)),
    0,
    Array.from({ length: Math.max(MIN_TABLE_SIZE, columns) }, (): RichText => []),
  );

  return next;
}

/** Removes a row. The last remaining row is kept, emptied instead. */
export function tableDeleteRow(rows: TableRows, at: number): TableRows {
  if (rows.length <= MIN_TABLE_SIZE) {
    return createTableRows(MIN_TABLE_SIZE, tableSize(rows).columns);
  }

  return rows.filter((_, index) => index !== at).map((row) => [...row]);
}

/** Inserts an empty column, up to {@link MAX_TABLE_COLUMNS}. */
export function tableInsertColumn(rows: TableRows, at: number): TableRows {
  if (tableSize(rows).columns >= MAX_TABLE_COLUMNS) {
    return rows.map((row) => [...row]);
  }

  return rows.map((row) => {
    const next = [...row];
    next.splice(Math.max(0, Math.min(at, next.length)), 0, []);
    return next;
  });
}

/** Removes a column. The last remaining column is kept, emptied instead. */
export function tableDeleteColumn(rows: TableRows, at: number): TableRows {
  if (tableSize(rows).columns <= MIN_TABLE_SIZE) {
    return createTableRows(rows.length, MIN_TABLE_SIZE);
  }

  return rows.map((row) => row.filter((_, index) => index !== at));
}

/**
 * The cell reached by moving `delta` cells in reading order.
 *
 * Returns null past either end, which is what tells the caller to append a row
 * or step out of the table.
 */
export function tableStep(
  rows: TableRows,
  row: number,
  column: number,
  delta: number,
): { row: number; column: number } | null {
  const { columns } = tableSize(rows);

  if (columns === 0) {
    return null;
  }

  const index = row * columns + column + delta;

  if (index < 0 || index >= rows.length * columns) {
    return null;
  }

  return { row: Math.floor(index / columns), column: index % columns };
}
