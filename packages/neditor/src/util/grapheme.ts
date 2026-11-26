/**
 * First user-perceived character of a string.
 *
 * A callout icon is one character *as a reader sees it*, which is not one code
 * point: `⚠️` is U+26A0 plus a variation selector, and skin-tone emoji are
 * longer still. Indexing or spreading would keep only the first half and render
 * as a different glyph, so this segments by grapheme.
 */
export function firstGrapheme(text: string): string | undefined {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  const segmenter = globalThis.Intl?.Segmenter;

  if (segmenter) {
    const first = new segmenter(undefined, { granularity: 'grapheme' })
      .segment(trimmed)
      [Symbol.iterator]()
      .next();

    return first.done ? undefined : first.value.segment;
  }

  // Without Intl.Segmenter, keep the whole string rather than cut it wrong.
  return trimmed;
}

/**
 * The grapheme cluster of `text` holding the code unit at `offset`, as
 * `[start, end)`, or null without `Intl.Segmenter`.
 *
 * `containing()` asks for that one segment: walking the segments up to the
 * offset cost 41 ms a call in Chromium on a 100,000-character block.
 */
function clusterAt(text: string, offset: number): [number, number] | null {
  const Segmenter = globalThis.Intl?.Segmenter;

  if (!Segmenter) {
    return null;
  }

  const segmenter = new Segmenter(undefined, { granularity: 'grapheme' });
  const found = segmenter.segment(text).containing(offset);

  if (!found) {
    return null;
  }

  // WebKit answers, at the first code unit of a cluster that starts with a
  // surrogate pair, a span reaching back over the cluster before it as well
  // ("X😀".containing(1) is "X😀", at 0). Its ends are still boundaries, so
  // the clusters inside it are read by walking the span alone -- one cluster
  // in every other engine, where this costs one step.
  let start = found.index;
  let end = found.index + found.segment.length;

  for (const part of segmenter.segment(found.segment)) {
    const at = found.index + part.index;

    if (at > offset) {
      break;
    }

    start = at;
    end = at + part.segment.length;
  }

  return [start, end];
}

/**
 * `offset`, or the code point boundary just before it where it falls between
 * the two halves of a surrogate pair -- for an offset that is not meant to be
 * a grapheme boundary, but must never cut a code point.
 */
export function codePointStart(text: string, offset: number): number {
  return offset > 0 && offset < text.length && splitsPair(text, offset) ? offset - 1 : offset;
}

/** `offset`, or the code point boundary just after it where it splits a surrogate pair. */
export function codePointEnd(text: string, offset: number): number {
  return offset > 0 && offset < text.length && splitsPair(text, offset) ? offset + 1 : offset;
}

/** Whether `offset` falls between the two halves of a surrogate pair. */
function splitsPair(text: string, offset: number): boolean {
  const here = text.charCodeAt(offset);
  const before = text.charCodeAt(offset - 1);

  return here >= 0xdc00 && here <= 0xdfff && before >= 0xd800 && before <= 0xdbff;
}

/**
 * The grapheme boundary of `text` at or before `offset`: where a caret can
 * stand without cutting a character a reader sees as one -- a surrogate
 * pair, a flag, a letter and its combining marks, an emoji joined by ZWJ.
 * Without `Intl.Segmenter`, at least never between the halves of a pair.
 */
export function graphemeStart(text: string, offset: number): number {
  if (offset <= 0) {
    return 0;
  }

  if (offset >= text.length) {
    return text.length;
  }

  const cluster = clusterAt(text, offset);

  if (cluster) {
    return cluster[0];
  }

  return splitsPair(text, offset) ? offset - 1 : offset;
}

/**
 * The grapheme boundary of `text` at or after `offset`: the end of the
 * character that holds it, where `offset` cuts one, else `offset` itself.
 */
export function graphemeEnd(text: string, offset: number): number {
  if (offset <= 0) {
    return 0;
  }

  if (offset >= text.length) {
    return text.length;
  }

  const cluster = clusterAt(text, offset);

  if (cluster) {
    return cluster[0] === offset ? offset : cluster[1];
  }

  return splitsPair(text, offset) ? offset + 1 : offset;
}

/** Code units read on either side of an offset to find its word (`wordAt`). */
const WORD_WINDOW = 256;

/** Past this, a window that still cuts the word is taken as it is. */
const WORD_WINDOW_CAP = 16_384;

let wordSegmenter: Intl.Segmenter | null | undefined;

/**
 * The word of `text` holding the code unit at `offset`, as `[start, end)`:
 * a run of letters, a run of spaces, a punctuation mark --
 * `Intl.Segmenter`'s word segments, which are ICU's, as Chromium's and
 * WebKit's own double-click words are; Firefox's differ in places. Past the
 * end, the last one; in empty text, or without `Intl.Segmenter`,
 * `[offset, offset]`.
 *
 * Read in a window around the offset, widened while the word touches a cut
 * edge: `containing()` costs time in proportion to the offset, which was
 * 157 ms a call at offset 30,000 of Thai in Firefox -- every pointer move of
 * a long block's drag.
 */
export function wordAt(text: string, offset: number): [number, number] {
  const at = Math.min(Math.max(offset, 0), text.length - 1);

  if (wordSegmenter === undefined) {
    const Segmenter = globalThis.Intl?.Segmenter;
    wordSegmenter = Segmenter ? new Segmenter(undefined, { granularity: 'word' }) : null;
  }

  if (!wordSegmenter || at < 0) {
    return [offset, offset];
  }

  for (let reach = WORD_WINDOW; ; reach *= 2) {
    const from = codePointStart(text, Math.max(at - reach, 0));
    const to = codePointEnd(text, Math.min(at + reach, text.length));
    const found = wordSegmenter.segment(text.slice(from, to)).containing(at - from);

    if (!found) {
      return [offset, offset];
    }

    const start = from + found.index;
    const end = start + found.segment.length;
    const cut = (start === from && from > 0) || (end === to && to < text.length);

    if (!cut || reach >= WORD_WINDOW_CAP) {
      return [start, end];
    }
  }
}

/**
 * The word or paragraph of `text` a multi-click drag reaches at the caret
 * `at`: the one holding the character after the caret, in either direction
 * -- a word by `wordAt` (a run of spaces is one), a paragraph between line
 * breaks. Taken as the browser took the drag's own `anchor`: with the line
 * break that ends it where the anchor's paragraph ends in one (Chromium and
 * WebKit; Firefox's does not), and with the spaces after a word where the
 * anchor's word has them -- Firefox's `layout.word_select.eat_space_to_next_word`,
 * on by default in Windows, and Chromium's own double-click in Windows; the
 * same code either way, since it asks the anchor, not the platform. Without
 * `Intl.Segmenter`, a word is the caret itself: the far end goes by
 * character, the anchor stays whole. In mixed-direction text the caret at
 * the visual edge of a run is ambiguous, and the word after it can be the
 * one visually on the other side (a documented limit, the editor's
 * `#resumeTextDrag`).
 */
export function farUnit(
  text: string,
  at: number,
  paragraph: boolean,
  anchor: { start: number; end: number; text: string },
): [number, number] {
  const own = anchor.text.slice(anchor.start, anchor.end);

  if (paragraph) {
    const end = lineEnd(text, at);
    const withBreak = own.endsWith('\n') && end < text.length;

    // From the line break before the caret -- none at offset 0, where
    // `lastIndexOf` would clamp its start to 0 and find a break that opens
    // the text: a drag onto the blank first line of "\nalpha" drew [1, ...]
    // for [0, ...] and lost the line (R14-PTR-4).
    const start = at === 0 ? 0 : text.lastIndexOf('\n', at - 1) + 1;

    return [start, withBreak ? end + 1 : end];
  }

  const [start, end] = wordAt(text, at);

  if (/\S\s+$/u.test(own) && /\S/u.test(text.slice(start, end))) {
    let past = end;

    while (past < text.length && /\s/u.test(text[past]!) && text[past] !== '\n') {
      past += 1;
    }

    return [start, past];
  }

  return [start, end];
}

/** Where the line of `text` holding `offset` ends: its next line break, or the end. */
function lineEnd(text: string, offset: number): number {
  const at = text.indexOf('\n', offset);

  return at === -1 ? text.length : at;
}
