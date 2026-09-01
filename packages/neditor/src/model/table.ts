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

export interface TableSize {
  readonly rows: number;
  readonly columns: number;
}

export function tableSize(rows: TableRows): TableSize {
  return { rows: rows.length, columns: rows[0]?.length ?? 0 };
}

export function createTableRows(rowCount = 3, columnCount = 3): TableRows {
  const rows = Math.max(MIN_TABLE_SIZE, Math.trunc(rowCount));
  const columns = Math.max(MIN_TABLE_SIZE, Math.trunc(columnCount));

  return Array.from({ length: rows }, () => Array.from({ length: columns }, (): RichText => []));
}

/** Coerces anything grid-shaped into a rectangular, non-empty table. */
export function normalizeTableRows(value: unknown): TableRows {
  if (!Array.isArray(value) || value.length === 0) {
    return createTableRows();
  }

  const rows = value.filter(Array.isArray) as unknown[][];

  if (rows.length === 0) {
    return createTableRows();
  }

  // The widest row sets the width; short rows are padded rather than dropped.
  const columns = Math.max(MIN_TABLE_SIZE, ...rows.map((row) => row.length));

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

/** Inserts an empty row. `at` is clamped, so `length` appends. */
export function tableInsertRow(rows: TableRows, at: number): TableRows {
  const { columns } = tableSize(rows);
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

export function tableInsertColumn(rows: TableRows, at: number): TableRows {
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
