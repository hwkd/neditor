import { sanitizeUrl } from '../util/url.ts';

/**
 * Rich text.
 *
 * A block's content is an ordered list of runs, each a slice of text carrying a
 * set of marks and an optional link. Text is therefore a flat
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
  /** Sorted and deduped by the model. Omitted when empty. */
  marks?: Mark[];
  /** Already sanitized by `sanitizeUrl` before it reaches the model. */
  link?: string;
  /**
   * Inline math: the TeX source of one formula.
   *
   * A formula is an *atom*: its run's `text` is always the single character
   * {@link MATH_ATOM}, whatever the TeX says, so a formula is one character of
   * offset arithmetic -- a caret stands before it or after it, and no slice,
   * mark or split can land inside it. The TeX is the whole payload; what a
   * renderer draws for it is view-only and never read back. An atom carries no
   * marks and no link, and never merges with a neighbour, even an identical
   * one: `\alpha` beside `b` is two formulas, and one `\alphab` is not TeX.
   */
  math?: string;
}

export type RichText = TextRun[];

/**
 * The character an inline formula occupies in a block's text.
 *
 * U+FFFC OBJECT REPLACEMENT CHARACTER is what it is for. It is no delimiter to
 * any inline rule, not whitespace, and not something a person types, so a rule
 * reading the text before the caret sees a formula as one opaque symbol.
 */
export const MATH_ATOM = '￼';

/** Whether a run is an inline formula. */
export function isMathRun(run: TextRun | undefined): boolean {
  return typeof run?.math === 'string';
}

/**
 * Canonical inline TeX: one line, no edge whitespace.
 *
 * Inline math is written `$…$`, and that spelling can neither hold a line break
 * nor open or close against whitespace -- so a formula that did would be one
 * the Markdown writer could not write back. Neither means anything in TeX,
 * where a line break is a space and space at the edge of math mode is ignored.
 * Split and trimmed rather than matched with `\s*[\r\n]+\s*`, which is retried
 * from every character of a long whitespace run.
 */
export function normalizeInlineTex(tex: string): string {
  return (/[\r\n]/.test(tex) ? tex.split(/[\r\n]+/).join(' ') : tex).trim();
}

/** One inline formula, or nothing when the TeX is empty. */
export function richMath(tex: string): RichText {
  return normalizeRuns([{ text: MATH_ATOM, math: tex }]);
}

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
  math?: unknown,
): TextRun {
  // A formula is its TeX and nothing else: the atom character, no marks, no
  // link. Stored documents are untrusted, so a `math` that is not a string is
  // no formula, and the run is read as the text it carries.
  if (typeof math === 'string') {
    return { text: MATH_ATOM, math: normalizeInlineTex(math) };
  }

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
    // A formula is one atom whatever its stored `text` says, and an empty one
    // is nothing: there is no TeX to keep and nothing a renderer could draw.
    if (typeof raw?.math === 'string') {
      const atom = makeRun(MATH_ATOM, undefined, undefined, raw.math);

      if (atom.math !== '') {
        out.push(atom);
      }

      continue;
    }

    if (typeof raw?.text !== 'string' || raw.text.length === 0) {
      continue;
    }

    const run = makeRun(raw.text, raw.marks, raw.link);
    const previous = out.at(-1);

    if (previous && !isMathRun(previous) && formatKey(previous) === formatKey(run)) {
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

/**
 * The text of the content, offset for offset: each formula is one
 * {@link MATH_ATOM}. This is what carets, input rules and slices measure.
 */
export function richToPlainText(content: readonly TextRun[]): string {
  let text = '';

  for (const run of content) {
    text += run.text;
  }

  return text;
}

/**
 * The text a person would read off the content: each formula as `$TeX$`.
 *
 * Not offset-aligned with the content, so never for measuring. It is for the
 * places that turn rich text into plain text for good -- pasting into a code
 * block, announcing a selection.
 */
export function richToSourceText(content: readonly TextRun[]): string {
  let text = '';

  for (const run of content) {
    text += isMathRun(run) ? `$${run.math}$` : run.text;
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
      run.math === other.math &&
      (run.marks ?? []).join(',') === (other.marks ?? []).join(',')
    );
  });
}

export function cloneRichText(content: readonly TextRun[]): RichText {
  return content.map((run) => makeRun(run.text, run.marks, run.link, run.math));
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
      out.push(makeRun(run.text.slice(sliceStart, sliceEnd), run.marks, run.link, run.math));
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
  // Ordered first: richSlice clamps rather than rejects, so a reversed range
  // makes the two slices overlap and this concatenation *duplicates* the text
  // in between instead of deleting anything. Reachable from the editor when the
  // caret moves left while the slash menu is still open.
  const from = Math.max(0, Math.min(start, end));
  const to = Math.min(total, Math.max(start, end));

  return richConcat(richSlice(content, 0, from), richSlice(content, to, total));
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

function withMark(run: TextRun, mark: Mark, active: boolean): TextRun {
  const current = run.marks ?? [];
  const next = active ? [...current, mark] : current.filter((existing) => existing !== mark);

  return makeRun(run.text, next, run.link, run.math);
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
    richSlice(content, start, end).map((run) =>
      makeRun(run.text, run.marks, href ?? undefined, run.math),
    ),
    richSlice(content, end, total),
  );
}

/** Marks carried by every character in `[start, end)`. Empty for an empty range. */
export function richActiveMarks(content: readonly TextRun[], start: number, end: number): Mark[] {
  // A formula carries no marks, so counting one would make every range holding
  // a formula read as unformatted: bolding "a $x$ b" twice bolded it both
  // times. Formatting is the text's, and a range of formulas alone has none.
  const runs = richSlice(content, start, end).filter((run) => !isMathRun(run));
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
  // Formulas carry no link, for the reason they carry no marks.
  const runs = richSlice(content, start, end).filter((run) => !isMathRun(run));
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
 *
 * `code` is the one mark that needs the character to the *right* as well.
 * Bold has a delimiter the reader supplies by eye, so growing a bold word is
 * what the writer meant; a code span is a container, and there is no way to
 * type your way out of one that always extends. Inside the span both
 * neighbours are code and the mark is kept, so a caret placed mid-span still
 * reports itself as code.
 */
export function richMarksAt(content: readonly TextRun[], offset: number): Mark[] {
  if (offset <= 0) {
    return [];
  }

  const inherited = richActiveMarks(content, offset - 1, offset);

  if (!inherited.includes('code')) {
    return inherited;
  }

  // At the end of the content the slice is empty, so the span ends here too.
  return richActiveMarks(content, offset, offset + 1).includes('code')
    ? inherited
    : inherited.filter((mark) => mark !== 'code');
}

export function richLinkAt(content: readonly TextRun[], offset: number): string | null {
  return richActiveLink(content, offset, offset + 1);
}
