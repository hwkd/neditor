import { describe, expect, test } from 'vitest';

import { sanitizeImageUrl, sanitizeReadImageUrl, sanitizeReadUrl, sanitizeUrl } from './url.ts';

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

  test('line-wrapped base64 is accepted and unwrapped', () => {
    expect(sanitizeImageUrl('data:image/png;base64,iVBORw0KGgo\n AAAA')).toBe(
      'data:image/png;base64,iVBORw0KGgoAAAA',
    );
  });

  test('drops the whitespace a wrapped base64 payload carries', () => {
    // Base64 wrapped at 76 columns is common, and a browser decoding it skips
    // ASCII whitespace. Kept in the model, the newline was percent-encoded by
    // the Markdown writer and refused by the reader, so the image came back as
    // a paragraph of base64.
    expect(sanitizeImageUrl('data:image/png;base64,iVBORw0KGgo\nAAAANSUhEUg==')).toBe(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
    );
    expect(sanitizeImageUrl('data:image/png;base64,iVBO Rw0K\r\n\tGgo=')).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
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

describe('a disguise the URL parser sees through but a string test does not', () => {
  /**
   * The site-relative branch exists so `/path` stays local, and it deliberately
   * excludes `//host` because the leading `//` opens an authority. But browsers
   * strip TAB, LF and CR from a URL and fold a backslash into a slash for
   * special schemes *before* parsing, so `/\host` and `/<TAB>/host` reach an
   * attacker's origin while a `startsWith('/')` test still reads them as local.
   * A consumer branching on the sanitizer's output -- a client-side router, an
   * external-link interstitial, a link-rewriting pass -- routed the attacker's
   * destination down the trusted path.
   */
  const BACKSLASH = String.fromCharCode(92);

  test.each([
    ['a backslash after the slash', `/${BACKSLASH}evil.example/x`],
    ['a doubled backslash', `/${BACKSLASH}${BACKSLASH}evil.example/x`],
    ['a backslash then a slash', `/${BACKSLASH}/evil.example/x`],
    ['an embedded tab', '/\t/evil.example/x'],
    ['an embedded newline', '/\n/evil.example/x'],
    ['an embedded carriage return', '/\r/evil.example/x'],
  ])('%s resolves to the host it actually reaches', (_name, input) => {
    expect(sanitizeUrl(input)).toBe('https://evil.example/x');
  });

  test('the stored href names the same origin the browser would open', () => {
    for (const input of [`/${BACKSLASH}evil.example/x`, '/\t/evil.example/x']) {
      const stored = sanitizeUrl(input)!;

      expect(new URL(stored).origin).toBe(new URL(input, 'https://site.test/page').origin);
    }
  });

  test('an image source cannot use the disguise either', () => {
    expect(sanitizeImageUrl(`/${BACKSLASH}evil.example/p.png`)).toBe('https://evil.example/p.png');
  });

  test('genuinely local links are untouched', () => {
    expect(sanitizeUrl('/docs/page')).toBe('/docs/page');
    expect(sanitizeUrl('#section')).toBe('#section');
    expect(sanitizeUrl('/a/b?q=1#f')).toBe('/a/b?q=1#f');
  });

  test('a backslash in a local path folds the way the browser folds it', () => {
    expect(sanitizeUrl(`/notes${BACKSLASH}file.txt`)).toBe('/notes/file.txt');
  });

  test('a scheme is left to the URL parser, which folds only where it should', () => {
    expect(sanitizeUrl('mailto:a@b.test')).toBe('mailto:a@b.test');
    expect(sanitizeUrl('https://a.test/x')).toBe('https://a.test/x');
  });
});

describe('a scheme-less address is an email address', () => {
  // `[mail](me@example.com)` linked to `https://me@example.com/` -- a page on
  // example.com, with `me` as its user name. An address alone becomes mailto:.
  test.each([
    ['me@example.com', 'mailto:me@example.com'],
    ['first.last+tag@mail.example.co.uk', 'mailto:first.last+tag@mail.example.co.uk'],
    ['  me@example.com  ', 'mailto:me@example.com'],
    // R2-PARSE-10: a query is how a mailto: carries a subject; it became
    // `https://me@example.com/?subject=hi`, a page on example.com.
    ['me@example.com?subject=hi', 'mailto:me@example.com?subject=hi'],
    ['me@example.com?q', 'mailto:me@example.com?q'],
  ])('%j', (input, expected) => {
    expect(sanitizeUrl(input)).toBe(expected);
  });

  test.each([
    // A path or a port says it is a URL -- whose user name is then dropped.
    ['me@example.com/x', 'https://example.com/x'],
    ['me@example.com:8080', 'https://example.com:8080/'],
    // Left over from an unclosed angled destination: never an address.
    ['<u@x.test', 'https://x.test/'],
  ])('%j is still read as a URL', (input, expected) => {
    expect(sanitizeUrl(input)).toBe(expected);
  });

  test('a host with no dot is neither', () => {
    expect(sanitizeUrl('me@localhost')).toBe(null);
  });

  // R3-FMT-8: a query with a space in it, or a fragment, failed the address
  // test and fell through to the host test, which then dropped `me@` as a
  // user name: the address was gone and the link opened the website.
  test.each([
    ['me@example.com?subject=Hello there', 'mailto:me@example.com?subject=Hello%20there'],
    ['me@example.com#x', 'mailto:me@example.com#x'],
    ['me@example.com?subject=a<b', 'mailto:me@example.com?subject=a%3Cb'],
    ['me@example.com?', 'mailto:me@example.com?'],
    ['a.b@c.d.e?x=1#y', 'mailto:a.b@c.d.e?x=1#y'],
  ])('%j keeps its address', (input, expected) => {
    expect(sanitizeUrl(input)).toBe(expected);
  });

  test('a query that only mentions an address is still a website', () => {
    expect(sanitizeUrl('www.example.com?ref=me@x.com')).toBe(
      'https://www.example.com/?ref=me@x.com',
    );
  });

  test('never an image', () => {
    expect(sanitizeImageUrl('me@example.com')).toBe(null);
  });
});

describe('a user name before the host is dropped', () => {
  // R2-PARSE-10: `https://google.com@evil.test` reads as Google and opens
  // evil.test. The href keeps the host it reaches and nothing that disguises it.
  test.each([
    ['https://google.com@evil.test', 'https://evil.test/'],
    ['//google.com@evil.test', 'https://evil.test/'],
    ['http://user:pass@a.test/x?y#z', 'http://a.test/x?y#z'],
    ['https://:pass@a.test/', 'https://a.test/'],
  ])('%j', (input, expected) => {
    expect(sanitizeUrl(input)).toBe(expected);
  });

  test('a mailto: address is not a user name', () => {
    expect(sanitizeUrl('mailto:me@example.com')).toBe('mailto:me@example.com');
  });

  test('nor is an image source left holding one', () => {
    expect(sanitizeImageUrl('https://a.test@evil.test/x.png')).toBe('https://evil.test/x.png');
  });
});

describe('a destination read out of content is never taken for a host', () => {
  // CB1: `[Contributing](CONTRIBUTING.md)` pasted from a README linked to
  // `https://contributing.md/`, a stranger's domain, because a file name
  // passes the host test: `.md`, `.py`, `.zip` and `.png` look like TLDs.
  test.each(['README.md', 'setup.py', 'release.zip', 'logo.png', 'CHANGELOG.md', 'example.com'])(
    '%j is a relative path there, so no link',
    (input) => {
      expect(sanitizeReadUrl(input)).toBeNull();
      expect(sanitizeReadImageUrl(input)).toBeNull();
    },
  );

  test('typed, a bare host is still assumed to be one', () => {
    // What people type into the link editor: `example.com/docs`.
    expect(sanitizeUrl('example.com/docs')).toBe('https://example.com/docs');
    expect(sanitizeImageUrl('example.com/a.png')).toBe('https://example.com/a.png');
  });

  test.each([
    'https://a.test/x',
    'mailto:hi@a.test',
    '/docs',
    '#anchor',
    '//evil.example/x',
    '/\\evil.example',
    'me@example.com',
    'javascript:alert(1)',
    'https://google.com@evil.test',
  ])('%j reads as it does typed', (input) => {
    expect(sanitizeReadUrl(input)).toBe(sanitizeUrl(input));
  });
});
