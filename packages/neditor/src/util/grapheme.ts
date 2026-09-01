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
