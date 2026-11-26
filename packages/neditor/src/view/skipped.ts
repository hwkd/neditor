/**
 * Elements whose contents are not document text.
 *
 * A pasted `<script>` never executes here — it is parsed into an inert
 * template — but its source would otherwise be read out as visible text.
 *
 * Shared by the HTML reader and the math reader, which must agree on what a
 * reader keeps: judged by `<svg>` alone, a MathJax frame holding a
 * `<noscript>` counted its text as the formula's drawing, and the formula --
 * whose only reading was its assistive copy -- was lost.
 */
export const SKIP_TAGS: ReadonlySet<string> = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'HEAD',
  'TITLE',
  'META',
  'LINK',
  'OBJECT',
  'IFRAME',
  'SVG',
]);
