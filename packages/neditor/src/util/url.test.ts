import { describe, expect, test } from 'vitest';

import { sanitizeImageUrl, sanitizeUrl } from './url.ts';

/**
 * The README makes explicit promises about which sources are accepted, and
 * these are the tests that hold it to them. Without this, widening the regex to
 * make one paste work would break the guarantee with a green suite.
 */

describe('sanitizeUrl', () => {
  test.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)  ',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '',
    '   ',
  ])('rejects %s', (input: string) => {
    expect(sanitizeUrl(input)).toBe(null);
  });

  test.each([
    ['https://a.test/x', 'https://a.test/x'],
    ['http://a.test/', 'http://a.test/'],
    ['mailto:hi@a.test', 'mailto:hi@a.test'],
    ['tel:+15551234', 'tel:+15551234'],
    ['/docs', '/docs'],
    ['#anchor', '#anchor'],
  ])('accepts %s', (input: string, expected: string) => {
    expect(sanitizeUrl(input)).toBe(expected);
  });

  test('a bare host is upgraded to https rather than treated as a path', () => {
    expect(sanitizeUrl('example.com/docs')).toBe('https://example.com/docs');
  });

  describe('protocol-relative destinations', () => {
    // `//host/path` carries no scheme, so the site-relative fast path used to
    // hand it straight back. It is not site-relative: it leaves the site while
    // reading as a local path, which is exactly the disguise a link arriving
    // from a paste or another user's document would want.
    test('are resolved rather than passed through as local paths', () => {
      expect(sanitizeUrl('//evil.example/x')).toBe('https://evil.example/x');
      expect(sanitizeUrl('//evil.example:8080/a?b=1#c')).toBe('https://evil.example:8080/a?b=1#c');
    });

    test('resolve to what a browser on an https page would have loaded', () => {
      const relative = (href: string) => new URL(href, 'https://site.test/page').href;

      for (const href of ['//other.test/x', '//other.test:8080/a?b=1#c']) {
        expect(sanitizeUrl(href)).toBe(relative(href));
      }
    });

    test('the allowlist still decides, so a bare `//` is rejected', () => {
      expect(sanitizeUrl('//')).toBe(null);
    });

    test('genuinely site-relative paths are untouched', () => {
      expect(sanitizeUrl('/docs')).toBe('/docs');
      expect(sanitizeUrl('/docs//deep')).toBe('/docs//deep');
    });

    test('an image source gets the same treatment', () => {
      expect(sanitizeImageUrl('//cdn.example/logo.png')).toBe('https://cdn.example/logo.png');
    });
  });
});

describe('sanitizeImageUrl', () => {
  test('accepts the schemes an <img> can safely load', () => {
    expect(sanitizeImageUrl('https://a.test/x.png')).toBe('https://a.test/x.png');
    expect(sanitizeImageUrl('/local.png')).toBe('/local.png');
  });

  test('accepts base64 image data, which the README promises', () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

    expect(sanitizeImageUrl(png)).toBe(png);
    expect(sanitizeImageUrl('data:image/webp;base64,UklGRg==')).toBe(
      'data:image/webp;base64,UklGRg==',
    );
  });

  test('refuses SVG data, which can carry script', () => {
    // Inert inside an <img>, but the same string in an <object> or a new tab
    // is not — so it never enters the model.
    expect(sanitizeImageUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBe(null);
    expect(sanitizeImageUrl('data:image/svg+xml,<svg onload="alert(1)"/>')).toBe(null);
  });

  test.each([
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'mailto:hi@a.test',
    'tel:+15551234',
    '',
  ])('rejects %s as an image source', (input: string) => {
    expect(sanitizeImageUrl(input)).toBe(null);
  });
});

describe('a scheme-less destination must look like a host', () => {
  test.each(['bar', './rel', 'foo/baz', 'notahost'])('%j is not a URL', (input) => {
    // Assuming any bare token was a host turned `bar` into `https://bar/` and
    // `./rel` into `https://./rel`, so a Markdown relative destination resolved
    // somewhere that does not exist — and `[foo](bar)` sitting inside a longer
    // URL began matching as a link of its own.
    expect(sanitizeUrl(input)).toBeNull();
  });

  test.each([
    ['example.com', 'https://example.com/'],
    ['example.com/p?q=1', 'https://example.com/p?q=1'],
    ['//evil.example/x', 'https://evil.example/x'],
  ])('%j still resolves', (input, expected) => {
    expect(sanitizeUrl(input)).toBe(expected);
  });

  test.each([
    ['/relative', '/relative'],
    ['#frag', '#frag'],
  ])('%j stays as written', (input, expected) => {
    expect(sanitizeUrl(input)).toBe(expected);
  });
});
