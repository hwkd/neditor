import { sanitizeUrl } from '../util/url.ts';

/**
 * Rich text.
 *
 * A block's content is an ordered list of runs, each a slice of text carrying a
 * set of marks and an optional link. Notion uses the same shape: text is a flat
 * sequence of annotated spans, not a tree of nested elements. That matters
 * because formatting is then *interval arithmetic* — bolding a selection splits
 * runs at two offsets and flips a flag — rather than DOM surgery over nested
 * `<strong>`/`<em>` elements that may only partially overlap the selection.
 *
 * Every function here is pure and offset-based. The DOM never appears; that
 * translation lives in `view/rich-dom.ts`.
 */

/** Canonical mark order, so two equal mark sets always compare equal. */
export const MARKS = ['bold', 'italic', 'underline', 'strikethrough', 'code'] as const;

export type Mark = (typeof MARKS)[number];

export interface TextRun {
  text: string;
  /** Sorted and deduped by {@link sortMarks}. Omitted when empty. */
  marks?: Mark[];
  /** Already sanitized by `sanitizeUrl` before it reaches the model. */
  link?: string;
}

export type RichText = TextRun[];

const MARK_ORDER = new Map<Mark, number>(MARKS.map((mark, index) => [mark, index]));

export function isMark(value: unknown): value is Mark {
  return typeof value === 'string' && MARK_ORDER.has(value as Mark);
}

/** Dedupes and orders marks so run comparison is a plain string check. */
export function sortMarks(marks: readonly Mark[]): Mark[] {
  // Stored documents are untrusted: `marks` may be any shape at all.
  return [...new Set(Array.isArray(marks) ? marks : [])]
    .filter(isMark)
    .sort((a, b) => (MARK_ORDER.get(a) ?? 0) - (MARK_ORDER.get(b) ?? 0));
}

/** Identity of a run's formatting, ignoring its text. */
function formatKey(run: TextRun): string {
  return `${(run.marks ?? []).join(',')}|${run.link ?? ''}`;
}

function makeRun(
  text: string,
  marks: readonly Mark[] | undefined,
  link: string | undefined,
): TextRun {
  const run: TextRun = { text };
  const sorted = sortMarks(marks ?? []);

  if (sorted.length > 0) {
    run.marks = sorted;
  }

  // Every run in the system is built here, which makes this the one place that
  // can guarantee no unsafe href ever enters the model — including runs coming
  // straight out of a database via normalizeDocument.
  const safeLink = typeof link === 'string' ? sanitizeUrl(link) : null;

  if (safeLink) {
    run.link = safeLink;
  }

  return run;
}

/**
 * Canonical form: no empty runs, marks sorted, adjacent runs with identical
 * formatting merged. Every operation ends with this so that structurally equal
 * content is also deeply equal.
 */
export function normalizeRuns(runs: readonly TextRun[]): RichText {
  const out: RichText = [];

  for (const raw of runs) {
    if (typeof raw?.text !== 'string' || raw.text.length === 0) {
      continue;
    }

    const run = makeRun(raw.text, raw.marks, raw.link);
    const previous = out.at(-1);

    if (previous && formatKey(previous) === formatKey(run)) {
      previous.text += run.text;
      continue;
    }

    out.push(run);
  }

  return out;
}

export function richFromPlainText(text: string, marks?: readonly Mark[], link?: string): RichText {
  return text.length === 0 ? [] : normalizeRuns([makeRun(text, marks, link)]);
}

export function richToPlainText(content: readonly TextRun[]): string {
  let text = '';

  for (const run of content) {
    text += run.text;
  }

  return text;
}

export function richLength(content: readonly TextRun[]): number {
  let length = 0;

  for (const run of content) {
    length += run.text.length;
  }

  return length;
}

export function isRichEmpty(content: readonly TextRun[]): boolean {
  return richLength(content) === 0;
}

/**
 * Structural equality of two canonical run lists.
 *
 * Both sides come out of {@link normalizeRuns}, so comparing runs pairwise is
 * exact — there is no other way to express the same content.
 */
export function richEquals(a: readonly TextRun[], b: readonly TextRun[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  return a.every((run, index) => {
    const other = b[index];

    return (
      other !== undefined &&
      run.text === other.text &&
      run.link === other.link &&
      (run.marks ?? []).join(',') === (other.marks ?? []).join(',')
    );
  });
}

export function cloneRichText(content: readonly TextRun[]): RichText {
  return content.map((run) => makeRun(run.text, run.marks, run.link));
}

/** Half-open slice `[start, end)` in character offsets. Clamps out-of-range. */
export function richSlice(content: readonly TextRun[], start: number, end: number): RichText {
  const total = richLength(content);
  const from = Math.max(0, Math.min(start, total));
  const to = Math.max(from, Math.min(end, total));

  if (from === to) {
    return [];
  }

  const out: TextRun[] = [];
  let cursor = 0;

  for (const run of content) {
    const runStart = cursor;
    const runEnd = cursor + run.text.length;
    cursor = runEnd;

    if (runEnd <= from) {
      continue;
    }

    if (runStart >= to) {
      break;
    }

    const sliceStart = Math.max(0, from - runStart);
    const sliceEnd = Math.min(run.text.length, to - runStart);

    if (sliceEnd > sliceStart) {
      out.push(makeRun(run.text.slice(sliceStart, sliceEnd), run.marks, run.link));
    }
  }

  return normalizeRuns(out);
}

export function richSplit(content: readonly TextRun[], offset: number): [RichText, RichText] {
  const total = richLength(content);
  return [richSlice(content, 0, offset), richSlice(content, offset, total)];
}

export function richConcat(...parts: ReadonlyArray<readonly TextRun[]>): RichText {
  return normalizeRuns(parts.flat());
}

export function richInsert(
  content: readonly TextRun[],
  offset: number,
  insert: readonly TextRun[],
): RichText {
  const [before, after] = richSplit(content, offset);
  return richConcat(before, insert, after);
}

export function richDelete(content: readonly TextRun[], start: number, end: number): RichText {
  const total = richLength(content);
  return richConcat(richSlice(content, 0, start), richSlice(content, end, total));
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

function withMark(run: TextRun, mark: Mark, active: boolean): TextRun {
  const current = run.marks ?? [];
  const next = active ? [...current, mark] : current.filter((existing) => existing !== mark);

  return makeRun(run.text, next, run.link);
}

/** Adds or removes a mark across `[start, end)`. */
export function richSetMark(
  content: readonly TextRun[],
  start: number,
  end: number,
  mark: Mark,
  active: boolean,
): RichText {
  const total = richLength(content);

  if (start >= end) {
    return normalizeRuns(content);
  }

  return richConcat(
    richSlice(content, 0, start),
    richSlice(content, start, end).map((run) => withMark(run, mark, active)),
    richSlice(content, end, total),
  );
}

/**
 * Flips a mark across a range.
 *
 * The range is treated as marked only when *every* character carries the mark,
 * so a partially bold selection bolds the rest rather than unbolding — the
 * behaviour every word processor has.
 */
export function richToggleMark(
  content: readonly TextRun[],
  start: number,
  end: number,
  mark: Mark,
): RichText {
  const active = richActiveMarks(content, start, end).includes(mark);
  return richSetMark(content, start, end, mark, !active);
}

/** Sets or clears a link across `[start, end)`. */
export function richSetLink(
  content: readonly TextRun[],
  start: number,
  end: number,
  href: string | null,
): RichText {
  const total = richLength(content);

  if (start >= end) {
    return normalizeRuns(content);
  }

  return richConcat(
    richSlice(content, 0, start),
    richSlice(content, start, end).map((run) => makeRun(run.text, run.marks, href ?? undefined)),
    richSlice(content, end, total),
  );
}

/** Marks carried by every character in `[start, end)`. Empty for an empty range. */
export function richActiveMarks(content: readonly TextRun[], start: number, end: number): Mark[] {
  const runs = richSlice(content, start, end);
  const first = runs[0];

  if (!first) {
    return [];
  }

  let shared = new Set(first.marks ?? []);

  for (const run of runs.slice(1)) {
    const runMarks = new Set(run.marks ?? []);
    shared = new Set([...shared].filter((mark) => runMarks.has(mark)));
  }

  return sortMarks([...shared]);
}

/** The link shared by every character in `[start, end)`, if there is one. */
export function richActiveLink(
  content: readonly TextRun[],
  start: number,
  end: number,
): string | null {
  const runs = richSlice(content, start, end);
  const first = runs[0];

  if (!first?.link) {
    return null;
  }

  return runs.every((run) => run.link === first.link) ? first.link : null;
}

/**
 * Marks that newly typed text at `offset` should inherit.
 *
 * Formatting is continued from the character to the left, which is what makes
 * typing at the end of a bold word stay bold. A `code` mark is deliberately not
 * inherited past its end, and neither is a link — otherwise every character
 * typed after a link would silently join it.
 */
export function richMarksAt(content: readonly TextRun[], offset: number): Mark[] {
  if (offset <= 0) {
    return [];
  }

  return richActiveMarks(content, offset - 1, offset);
}

export function richLinkAt(content: readonly TextRun[], offset: number): string | null {
  return richActiveLink(content, offset, offset + 1);
}
