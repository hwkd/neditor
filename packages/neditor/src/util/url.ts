/** Schemes that are safe to put in an `href` we render into the document. */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * Normalizes a user-supplied link, or returns null when it is not safe.
 *
 * A link travels with the document, so it can arrive from a paste, an import,
 * or another user. `javascript:` and `data:` hrefs execute when clicked, so
 * anything outside {@link SAFE_SCHEMES} is rejected rather than escaped.
 */
export function sanitizeUrl(input: string): string | null {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return null;
  }

  // In-page and site-relative links carry no scheme and cannot execute.
  //
  // `//host/path` is *not* one of them. It carries no scheme either, but the
  // leading `//` opens an authority: it leaves the site while reading as a
  // local path, so it falls through to be resolved and checked like any other
  // absolute destination.
  if (trimmed.startsWith('#') || (trimmed.startsWith('/') && !trimmed.startsWith('//'))) {
    return trimmed;
  }

  // `example.com` is what people actually type; assume https rather than
  // letting it resolve as a relative path. A protocol-relative `//example.com`
  // is resolved the same way — https is the scheme a browser on an https page
  // would have supplied, and pinning it means the href stored in the document
  // names the site it actually reaches.
  //
  // Only where the token can actually be a host, though. Assuming it always is
  // turned every bare word into a site: `bar` became `https://bar/` and `./rel`
  // became `https://./rel`, so a Markdown relative destination resolved to
  // somewhere that does not exist, and `[foo](bar)` sitting inside a longer
  // URL started matching as a link of its own.
  const hasScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed);
  const authority = trimmed.startsWith('//') ? trimmed.slice(2) : trimmed;
  const host = authority.split(/[/?#]/, 1)[0] ?? '';

  if (!hasScheme && !/^[^.\s]+(\.[^.\s]+)+$/.test(host)) {
    return null;
  }

  const candidate = hasScheme ? trimmed : `https:${trimmed.startsWith('//') ? '' : '//'}${trimmed}`;

  let parsed: URL;

  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  return SAFE_SCHEMES.has(parsed.protocol) ? parsed.href : null;
}

/** Image sources may also be inline data, which cannot execute in an `<img>`. */
const SAFE_IMAGE_DATA =
  /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon);base64,[a-z0-9+/=\s]+$/i;

/**
 * Normalizes an image source, or returns null when it is not safe.
 *
 * `data:image/svg+xml` is deliberately excluded: an SVG can carry script, and
 * while it stays inert inside an `<img>`, the same string reaching an `<object>`
 * or a new tab would not.
 */
export function sanitizeImageUrl(input: string): string | null {
  const trimmed = input.trim();

  if (SAFE_IMAGE_DATA.test(trimmed)) {
    return trimmed;
  }

  const url = sanitizeUrl(trimmed);

  if (url === null) {
    return null;
  }

  // mailto: and tel: are valid links but never images.
  return /^(?:https?:|\/|#)/.test(url) ? url : null;
}
