/**
 * Contract tests for the theme tokens, the packaging metadata, and the parts of
 * the README that make a promise a machine can check.
 *
 * No `@vitest-environment` line on purpose: everything here is a string or a
 * file on disk, so the file also stands as proof that the stylesheet and the
 * Markdown writer are reachable without a DOM.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import { normalizeDocument, toMarkdown } from './model/document.ts';
import type { Block } from './model/document.ts';
import { NEDITOR_STYLES } from './styles.ts';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/* ------------------------------------------------------------- colour -- */

interface Colour {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Parses the two forms the stylesheet uses: `rgb(r g b[ / a])` and `#rrggbb`. */
function parseColour(value: string): Colour {
  const text = value.trim();
  const rgb = /^rgb\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)$/.exec(text);

  if (rgb) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: rgb[4] === undefined ? 1 : Number(rgb[4]),
    };
  }

  const hex = /^#([0-9a-f]{6})$/i.exec(text);

  if (hex) {
    const digits = hex[1] as string;

    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
      a: 1,
    };
  }

  throw new Error(`unsupported colour: ${value}`);
}

/** WCAG 2.x relative luminance. */
function luminance({ r, g, b }: Colour): number {
  const channel = (value: number): number => {
    const srgb = value / 255;

    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground: Colour, background: Colour): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a) as [
    number,
    number,
  ];

  return (light + 0.05) / (dark + 0.05);
}

interface TokenBlock {
  /** The selector the declarations hang off, for readable failures. */
  readonly selector: string;
  readonly tokens: Readonly<Record<string, string>>;
}

/**
 * Every declaration list that sets `token`.
 *
 * Custom-property values in this stylesheet never contain braces, so finding
 * the enclosing pair is a scan in each direction rather than a parser.
 */
function blocksDefining(css: string, token: string): TokenBlock[] {
  const found: TokenBlock[] = [];

  for (let at = css.indexOf(`${token}:`); at !== -1; at = css.indexOf(`${token}:`, at + 1)) {
    const open = css.lastIndexOf('{', at);
    const close = css.indexOf('}', at);
    const body = css.slice(open + 1, close);
    const tokens: Record<string, string> = {};

    for (const [, name, value] of body.matchAll(/(--[\w-]+):([^;]+);/g)) {
      // Values wrap across lines at different indents in the two dark blocks,
      // so compare them by content rather than by layout.
      tokens[name as string] = (value as string).replaceAll(/\s+/g, ' ').trim();
    }

    found.push({
      selector: css
        .slice(Math.max(0, open - 90), open)
        .trim()
        .replaceAll(/\s+/g, ' '),
      tokens,
    });
  }

  return found;
}

describe('theme tokens', () => {
  /**
   * `--neditor-accent` is a foreground twice over — the active toolbar glyph
   * takes its colour, and the primary button and the to-do tick are drawn in
   * `--neditor-on-accent` on top of it — so the pair has to clear 4.5:1 in
   * *both* directions, in every theme that redefines either half. Dark mode
   * inheriting the light-tuned blue put the active glyph at 3.3:1 on the raised
   * dark surface while the README promised 4.5:1.
   */
  test('every accent pairing clears WCAG 1.4.3 in each theme', () => {
    const blocks = blocksDefining(NEDITOR_STYLES, '--neditor-accent');

    // Light, `prefers-color-scheme: dark`, and the explicit `theme: 'dark'`.
    expect(blocks).toHaveLength(3);

    for (const { selector, tokens } of blocks) {
      const accent = parseColour(tokens['--neditor-accent'] as string);
      const onAccent = parseColour(tokens['--neditor-on-accent'] as string);
      const surface = parseColour(tokens['--neditor-surface-raised'] as string);

      expect(accent.a, `${selector}: accent must be opaque to reason about`).toBe(1);
      expect(surface.a, `${selector}: raised surface must be opaque`).toBe(1);

      // The active toolbar glyph, which sits on a portal's raised surface.
      expect(contrast(accent, surface), `accent on raised surface — ${selector}`).toBeGreaterThan(
        4.5,
      );
      // The link editor's Apply label, and the checkmark inside a checked to-do.
      expect(contrast(onAccent, accent), `on-accent on accent — ${selector}`).toBeGreaterThan(4.5);
    }
  });

  /**
   * The dark themes flip every foreground to white. If the surface under them
   * stays `transparent` -- as it is in the light block, where dark ink on a
   * host's default white is the safe assumption -- then white text is
   * composited onto whatever the host paints, and on an ordinary light-only
   * page the whole document renders at 1.00:1 and vanishes. `theme` defaults
   * to `'auto'`, so this was the out-of-the-box result for every visitor whose
   * OS was in dark mode.
   */
  test('a theme that flips the ink to white also owns the ground it sits on', () => {
    const blocks = blocksDefining(NEDITOR_STYLES, '--neditor-text');

    // Light, `prefers-color-scheme: dark`, and the explicit `theme: 'dark'`.
    expect(blocks).toHaveLength(3);

    for (const { selector, tokens } of blocks.slice(1)) {
      const surface = parseColour(tokens['--neditor-surface'] as string);

      expect(surface.a, `${selector}: a dark theme's surface must be opaque`).toBe(1);

      for (const [token, floor] of [
        ['--neditor-text', 4.5],
        ['--neditor-text-muted', 4.5],
        ['--neditor-placeholder', 3],
      ] as const) {
        const ink = parseColour(tokens[token] as string);

        expect(contrast(ink, surface), `${token} on ${selector}`).toBeGreaterThan(floor);
      }
    }
  });

  test('each dark theme redefines exactly what the other one does', () => {
    const [, media, attribute] = blocksDefining(NEDITOR_STYLES, '--neditor-accent') as [
      TokenBlock,
      TokenBlock,
      TokenBlock,
    ];

    expect(media.tokens).toEqual(attribute.tokens);
  });
});

/* --------------------------------------------------------- packaging -- */

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

const DTS_LIB_REFERENCE = '/// <reference lib="dom" />';

describe('published declarations', () => {
  /**
   * The declarations name `HTMLElement`, `Document`, `Node` and friends, so
   * without the directive a consumer whose `tsconfig` has no `dom` lib — the
   * headless server the README sends at the serializers — cannot typecheck the
   * package at all. `vite.config.ts` puts it there; this is the assertion that
   * it is still there once a build has run.
   */
  test.skipIf(!existsSync(new URL('../dist/index.d.mts', import.meta.url)))(
    'open with a DOM lib reference so a Node-only tsconfig can read them',
    () => {
      for (const name of ['index.d.mts', 'index.d.cts']) {
        const declarations = readFileSync(new URL(`../dist/${name}`, import.meta.url), 'utf8');

        expect(declarations.startsWith(DTS_LIB_REFERENCE), `${name} lacks the directive`).toBe(
          true,
        );
      }
    },
  );

  test('the build config still asks for that reference', () => {
    const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

    expect(config).toContain(DTS_LIB_REFERENCE);
    expect(config).toContain('banner: { dts: DTS_LIB_REFERENCE }');
  });

  /**
   * `types` is only ever read by the pre-`exports` resolver, which is the one
   * place TypeScript 4.7+ still needs a plain path. Older compilers cannot read
   * a `.d.mts` at all, which the README states as a floor rather than working
   * around with a duplicate declaration file — so the two have to keep agreeing.
   */
  test('the README states the TypeScript floor the entry points imply', () => {
    expect(manifest.types).toBe('./dist/index.d.mts');
    expect(readme).toContain('**TypeScript 4.7+**');
  });
});

/* ------------------------------------------------------------ README -- */

function block(overrides: Partial<Block>): Block {
  return { id: 'b', type: 'paragraph', content: [{ text: 'text' }], depth: 0, ...overrides };
}

function markdownFor(overrides: Partial<Block>): string {
  return toMarkdown(normalizeDocument({ blocks: [block(overrides)] }));
}

describe('README', () => {
  /**
   * The degradation table is the contract for anyone reading the clipboard, so
   * it drifts the moment the writer changes its markers — which is exactly what
   * happened when the callout moved from a bare emoji to a bracketed icon.
   */
  test('quotes the markers the Markdown writer actually emits', () => {
    const callout = markdownFor({ type: 'callout', icon: '💡' });
    const collapsed = markdownFor({ type: 'toggle', collapsed: true });
    const expanded = markdownFor({ type: 'toggle', collapsed: false });

    expect(callout).toBe('> [!💡] text');

    for (const marker of [callout, collapsed, expanded]) {
      expect(readme, `README does not quote \`${marker}\``).toContain(`\`${marker}\``);
    }
  });

  /**
   * `labels` covers every accessible name, but two toolbars draw visible glyphs
   * from constants instead. Claiming otherwise sends a translator looking for
   * an override that does not exist.
   */
  test('does not claim every visible string is overridable', () => {
    expect(readme).not.toContain('Every string is overridable');
    expect(readme).toContain('`⤫ row` and `⤫ col`');
  });
});
