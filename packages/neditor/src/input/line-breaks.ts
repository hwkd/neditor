/**
 * Every line break as `\n`.
 *
 * Text from Windows arrives as `\r\n`, and from classic Mac OS or some
 * terminals as a lone `\r`. The model's only line break is `\n`: a `\r` left in
 * it is a character the renderer draws as a break, the writer emits as one and
 * the caret steps over -- Firefox put typed text between the `\r` and the `\n`
 * of a pasted CRLF -- so it is folded at every way plain text comes in.
 */
export function normalizeLineBreaks(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

/** C0 but TAB and LF, DEL, and C1: no character a model's text may hold. */
function isControl(code: number): boolean {
  return (code < 32 && code !== 9 && code !== 10) || (code >= 0x7f && code <= 0x9f);
}

/**
 * Text as the model holds it: {@link normalizeLineBreaks}, then a vertical tab
 * or a form feed as a line break too -- PowerPoint's `line1\vline2` is two
 * lines -- and every other control character dropped: C0 but the tab and the
 * line feed, DEL, and C1.
 *
 * None of them is prose, and one is worse than invisible: NUL is the
 * placeholder the inline rules project an escaped character to, so a NUL that
 * reached the model stood in for a character that is not there. Each reader
 * applies this where text enters -- the plain-text and HTML readers, the
 * Markdown reader, `normalizeDocument` -- because a control character that
 * only a reload removes is a document that saves differently from how it
 * loads.
 */
export function normalizeControlCharacters(text: string): string {
  const folded = normalizeLineBreaks(text);
  let out = '';
  let from = 0;

  for (let at = 0; at < folded.length; at += 1) {
    const code = folded.charCodeAt(at);

    if (isControl(code)) {
      // VT (11) and FF (12) end a line; CR is already folded into LF.
      out += folded.slice(from, at) + (code === 11 || code === 12 ? '\n' : '');
      from = at + 1;
    }
  }

  return from === 0 ? folded : out + folded.slice(from);
}
