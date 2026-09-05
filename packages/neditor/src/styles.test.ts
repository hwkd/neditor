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

  /**
   * And the DOM-free entry does not, which is the whole reason it exists. A
   * triple-slash reference inside a dependency injects `lib.dom` into the
   * consumer's entire program with nothing on their side able to suppress it,
   * so on a runtime whose globals conflict with the DOM's -- a Cloudflare
   * Worker being the clear case -- one import broke the build, reported against
   * the consumer's own lines and naming nothing from this package.
   *
   * Reachability, not just the entry file: a shared chunk carries its own copy
   * of the banner, so an entry that merely *reaches* one is infected while
   * still compiling. Both mutations of the build gate passed until it asked
   * this question instead.
   */
  test.skipIf(!existsSync(new URL('../dist/model.d.mts', import.meta.url)))(
    'the model entry reaches no declaration that asks for the DOM',
    () => {
      const dist = new URL('../dist/', import.meta.url);
      const seen = new Set<string>();
      const pending = ['model.d.mts', 'model.d.cts'];

      while (pending.length > 0) {
        const name = pending.pop() as string;

        if (seen.has(name)) {
          continue;
        }

        seen.add(name);
        const source = readFileSync(new URL(name, dist), 'utf8');

        expect(source.includes(DTS_LIB_REFERENCE), `${name} asks for the DOM`).toBe(false);
        expect(
          /\b(HTMLElement|ShadowRoot|DocumentFragment)\b/.test(source),
          `${name} names a DOM type`,
        ).toBe(false);

        for (const [, specifier] of source.matchAll(/from\s*"(\.[^"]+)"/g)) {
          pending.push((specifier as string).replace(/^\.\//, '').replace(/\.(m|c)js$/, '.d.$1ts'));
        }
      }

      expect(seen.size).toBeGreaterThan(0);
    },
  );

  test('the package offers the DOM-free entry under its own export', () => {
    const exports = manifest.exports as Record<string, Record<string, Record<string, string>>>;

    expect(exports['./model']?.import?.types).toBe('./dist/model.d.mts');
    expect(exports['./model']?.import?.default).toBe('./dist/model.mjs');
    expect(exports['./model']?.require?.types).toBe('./dist/model.d.cts');
    expect(exports['./model']?.require?.default).toBe('./dist/model.cjs');
  });

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

describe('the stylesheet works on the engines the package says it supports', () => {
  /**
   * `browserslist` names Safari, which has never shipped unprefixed
   * `user-select` -- so all three rules were inert there: the drag handle's
   * glyph, the callout icon, and the guard that stops a drag or a block
   * selection from smearing a text selection across the document.
   */
  test('every user-select is paired with its -webkit- form', () => {
    const plain = [...NEDITOR_STYLES.matchAll(/^\s*user-select:/gm)];
    const prefixed = [...NEDITOR_STYLES.matchAll(/^\s*-webkit-user-select:/gm)];

    expect(plain.length).toBeGreaterThan(0);
    expect(prefixed.length, 'one -webkit-user-select per user-select').toBe(plain.length);
  });

  test('the prefixed form comes first, so the standard one wins where both are read', () => {
    for (const match of NEDITOR_STYLES.matchAll(/-webkit-user-select:[^;]+;\s*([a-z-]+):/g)) {
      expect(match[1]).toBe('user-select');
    }
  });
});

describe("sizes and directions that hold on somebody else's page", () => {
  /**
   * The editor pins its own base font-size so it looks the same everywhere.
   * Every size below it was then given in `rem`, which resolves against the
   * *host's* root instead -- so on the ubiquitous `html { font-size: 62.5% }`
   * reset, h2 and h3 rendered smaller than body text (15px and 12.5px against
   * 16px) and quotes and code collapsed to 10px and 8.5px. Measured in Chrome
   * after the change: 30 / 24 / 20 / 16px, in the order the scale intends.
   */
  test('every font-size resolves against the editor, not the host root', () => {
    expect(NEDITOR_STYLES).not.toMatch(/font-size:\s*[\d.]+rem/);
    expect(NEDITOR_STYLES).toMatch(/font-size:\s*[\d.]+em/);
  });

  test('so do the tokens the layout is built from', () => {
    expect(NEDITOR_STYLES).toContain('--neditor-indent: 1.5em');
    expect(NEDITOR_STYLES).toContain('--neditor-gutter-width: 2.75em');
  });

  /**
   * `calc(var(--neditor-gutter-width) + var(--neditor-depth) * var(--neditor-indent))`
   * looks reasonable and is a trap: a host setting the gutter to `0` -- unitless,
   * exactly as the README told them to -- makes it add a number to a length.
   * That is invalid only after `var()` substitution, which makes it
   * invalid-at-computed-value-time, so the whole declaration is dropped and
   * every level of nesting goes flush. Kept apart, a bare `0` is a fine padding.
   */
  test('the gutter and the indent are separate declarations', () => {
    expect(NEDITOR_STYLES).toContain('padding-inline-start: var(--neditor-gutter-width);');
    expect(NEDITOR_STYLES).toMatch(
      /margin-inline-start: calc\(\s*var\(--neditor-depth, 0\) \* var\(--neditor-indent\)/,
    );
    expect(NEDITOR_STYLES, 'summing them is what a unitless gutter width breaks').not.toMatch(
      /calc\(\s*var\(--neditor-gutter-width\)\s*\+/,
    );
  });

  test('and both are animated, now that the indent is the margin', () => {
    expect(NEDITOR_STYLES).toContain('margin-inline-start 120ms ease');
  });

  /**
   * `translateX` is physical, so the RTL mirroring has to be applied against
   * the editor's own direction. Keyed off a bare `[dir='rtl']` it matched an
   * LTR editor anywhere inside an RTL page, where `inset-inline-start` had
   * already resolved to the left -- mirroring something unmirrored and dropping
   * the drag handle on top of the first characters of every line.
   */
  test('the RTL gutter mirroring is scoped to the editor own direction', () => {
    expect(NEDITOR_STYLES).toContain(".neditor[dir='rtl'] .neditor-gutter");
    expect(NEDITOR_STYLES).toContain("[dir='rtl'] .neditor:not([dir]) .neditor-gutter");
    expect(NEDITOR_STYLES).not.toMatch(/\n\[dir='rtl'\] \.neditor-gutter \{/);
  });

  /**
   * The stylesheet is a template literal, so a backtick inside a CSS comment
   * ends the string and the file stops parsing. That has now happened three
   * times while writing comments into it, each time caught only by the build.
   */
  test('no comment in the stylesheet carries a backtick', () => {
    expect(NEDITOR_STYLES).not.toContain('`');
  });
});

describe('sizes that matter on a phone and for a broken image', () => {
  /**
   * iOS Safari zooms the page in whenever a focused input computes under 16px,
   * and does not zoom back out when it blurs -- so opening the link dialog on
   * an iPhone left the whole page magnified with no way back.
   */
  test.each([
    '.neditor-link-editor__input',
    '.neditor-image-editor__input',
    '.neditor-icon-picker__input',
  ])('%s is not smaller than the portal it sits in', (selector) => {
    const rule = NEDITOR_STYLES.slice(NEDITOR_STYLES.indexOf(`${selector} {`));
    const size = /font-size:\s*([\d.]+)em/.exec(rule.slice(0, rule.indexOf('}')));

    expect(size, `${selector} sets no font-size`).not.toBeNull();
    expect(Number(size![1]), `${selector} would make iOS zoom`).toBeGreaterThanOrEqual(1);
  });

  /**
   * The frame's only in-flow child is the `<img>`, and a src that fails to load
   * has no intrinsic size -- so the frame collapsed to nothing and took the
   * absolutely positioned edit button with it. A broken image could then not be
   * fixed or removed with a mouse at all.
   */
  test('the image frame keeps a height when the image has none', () => {
    const rule = NEDITOR_STYLES.slice(NEDITOR_STYLES.indexOf('.neditor-image__frame {'));

    expect(rule.slice(0, rule.indexOf('}'))).toMatch(/min-height:\s*[\d.]+em/);
  });
});

describe('the selection bar is drawn outside the box model', () => {
  /**
   * It was a `border-inline-start` plus a compensating outdent, and that
   * outdent could not be put anywhere safe. As its own `margin-inline-start` it
   * overrode the depth indent that had moved into that property, flattening a
   * selected nested block. Folded into the indent's calc it took the indent
   * down with it whenever a host set a unitless value. And either way the
   * border stayed out of the gutter's own sum, so the drag handle sat 2px
   * inside the text of every selected block. A pseudo-element takes no space,
   * so none of that arises.
   */
  test('the selected rule sets no margin, no border and no offset token', () => {
    const rule = NEDITOR_STYLES.slice(
      NEDITOR_STYLES.indexOf(".neditor-block[data-selected='true'] {"),
    );
    const body = rule.slice(0, rule.indexOf('}'));

    expect(body).not.toMatch(/margin-inline-start:/);
    expect(body).not.toMatch(/border-inline-start:/);
    expect(NEDITOR_STYLES).not.toContain('--neditor-selected-offset');
  });

  test('the bar itself is an absolutely positioned pseudo-element', () => {
    const rule = NEDITOR_STYLES.slice(
      NEDITOR_STYLES.indexOf(".neditor-block[data-selected='true']::before {"),
    );
    const body = rule.slice(0, rule.indexOf('}'));

    expect(body).toContain('position: absolute;');
    expect(body, 'logical, so it sits on the reading-start edge either way').toContain(
      'inset-inline-start: 0;',
    );
  });

  test('and the block is its positioning context', () => {
    const rule = NEDITOR_STYLES.slice(NEDITOR_STYLES.indexOf('.neditor-block {'));

    expect(rule.slice(0, rule.indexOf('}'))).toContain('position: relative;');
  });

  /**
   * A pseudo-element inherits `forced-color-adjust` from the element it belongs
   * to, and the selected block opts out -- so the bar's author colour would be
   * kept and painted onto the system Highlight. The forced-colors block
   * restates every other selection cue; it has to restate this one.
   */
  test('forced colours restate the bar rather than leaving it an author colour', () => {
    expect(NEDITOR_STYLES).toMatch(
      /forced-colors: active[\s\S]*\.neditor-block\[data-selected='true'\]::before \{[^}]*HighlightText/,
    );
  });

  test('the indent is the depth alone, with nothing subtracted from it', () => {
    expect(NEDITOR_STYLES).toContain(
      'margin-inline-start: calc(var(--neditor-depth, 0) * var(--neditor-indent));',
    );
  });
});
