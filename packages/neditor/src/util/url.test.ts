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
