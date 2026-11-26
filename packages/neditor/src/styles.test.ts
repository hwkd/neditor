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
import { DEFAULT_LABELS } from './labels.ts';
import { NEDITOR_STYLES } from './styles.ts';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/* ------------------------------------------------------------- colour -- */

interface Colour {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Parses the forms the stylesheet uses: `rgb(r g b[ / a])`, `#rrggbb` and `transparent`. */
function parseColour(value: string): Colour {
  const text = value.trim();

  if (text === 'transparent') {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

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

const WHITE: Colour = { r: 255, g: 255, b: 255, a: 1 };

/** `top` composited over an opaque `ground` -- how a tint is actually seen. */
function over(top: Colour, ground: Colour): Colour {
  const mix = (a: number, b: number): number => a * top.a + b * (1 - top.a);

  return { r: mix(top.r, ground.r), g: mix(top.g, ground.g), b: mix(top.b, ground.b), a: 1 };
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
      // And on the hover tint over it, which is where it is under the pointer
      // that just pressed it: the light blue held 4.6:1 on white and 4.14:1
      // there, for 14px bold glyphs that are not large text.
      const hovered = over(parseColour(tokens['--neditor-hover'] as string), surface);
      expect(
        contrast(accent, hovered),
        `accent on a hovered toolbar button — ${selector}`,
      ).toBeGreaterThan(4.5);
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

  /**
   * The README promises every text token meets 1.4.3, and the checks above
   * only measured text against the page. Three pairings drawn on other grounds
   * fell short in the light theme: the URL error on a popover (4.26:1), a code
   * block's placeholder on its tint (4.46:1) and inline code inside a callout,
   * where two tints stack (4.49:1). The light surface is transparent, so it is
   * measured on the white a host page defaults to.
   */
  test('text holds 1.4.3 on the tinted grounds it is drawn on, too', () => {
    const blocks = blocksDefining(NEDITOR_STYLES, '--neditor-text');

    expect(blocks).toHaveLength(3);

    for (const { selector, tokens } of blocks) {
      const read = (token: string): Colour => parseColour(tokens[token] as string);
      const surface = over(read('--neditor-surface'), WHITE);
      const raised = over(read('--neditor-surface-raised'), surface);
      const codeBg = over(read('--neditor-code-bg'), surface);
      const callout = over(read('--neditor-callout-bg'), surface);
      const codeInCallout = over(read('--neditor-code-bg'), callout);

      for (const [what, ink, ground] of [
        ['URL error on a popover', read('--neditor-danger'), raised],
        ['placeholder in a code block', read('--neditor-placeholder'), codeBg],
        ['placeholder in a callout', read('--neditor-placeholder'), callout],
        ['inline code', read('--neditor-code-text'), codeBg],
        ['inline code in a callout', read('--neditor-code-text'), codeInCallout],
      ] as const) {
        expect(contrast(over(ink, ground), ground), `${what} — ${selector}`).toBeGreaterThan(4.5);
      }
    }
  });

  /**
   * A selected block is tinted with `--neditor-selection`, and every tint a
   * block draws inside itself -- the code block's, the callout's, a header
   * cell's, inline code's -- then stacks over that instead of over the page.
   * Non-paragraph placeholders show whenever the block is empty, so they are on
   * screen in a block selection, and Select All selects everything. Measured
   * there, the code block's placeholder was 4.27:1 in light and 3.92:1 in dark,
   * an empty callout's 4.31:1 and inline code in a callout 3.92:1 (axe flagged
   * that one in all three engines).
   *
   * Each pairing is one a renderer actually draws: a placeholder is never on
   * inline code, and muted text appears as captions and completed to-dos on the
   * block ground and as the code block's label on its tint.
   */
  test('text holds 1.4.3 inside a selected block, where the tints stack', () => {
    const blocks = blocksDefining(NEDITOR_STYLES, '--neditor-text');

    expect(blocks).toHaveLength(3);

    for (const { selector, tokens } of blocks) {
      const read = (token: string): Colour => parseColour(tokens[token] as string);
      const surface = over(read('--neditor-surface'), WHITE);
      const selected = over(read('--neditor-selection'), surface);
      const tint = (token: string, ground: Colour = selected): Colour => over(read(token), ground);
      const code = tint('--neditor-code-bg');
      const callout = tint('--neditor-callout-bg');
      const header = tint('--neditor-table-header-bg');

      for (const [what, token, ground] of [
        ['text', '--neditor-text', selected],
        ['text in a code block', '--neditor-text', code],
        ['text in a callout', '--neditor-text', callout],
        ['text in a header cell', '--neditor-text', header],
        ['a caption or completed to-do', '--neditor-text-muted', selected],
        ['the code block label', '--neditor-text-muted', code],
        ['the "Add an image" button', '--neditor-text-muted', callout],
        ['placeholder', '--neditor-placeholder', selected],
        ['placeholder in a code block', '--neditor-placeholder', code],
        ['placeholder in a callout', '--neditor-placeholder', callout],
        ['placeholder in a header cell', '--neditor-placeholder', header],
        ['inline code', '--neditor-code-text', tint('--neditor-code-bg')],
        ['inline code in a callout', '--neditor-code-text', tint('--neditor-code-bg', callout)],
        ['inline code in a header cell', '--neditor-code-text', tint('--neditor-code-bg', header)],
      ] as const) {
        expect(
          contrast(over(read(token), ground), ground),
          `${what}, selected — ${selector}`,
        ).toBeGreaterThan(4.5);
      }
    }
  });

  /**
   * 1.4.11 asks 3:1 of whatever marks a component's state or boundary. The
   * active slash option was marked only by the hover tint (1.11:1), a pressed
   * format button only by a hue (2.66:1 against an unpressed one), and the
   * three text inputs were bounded by the divider border (1.17:1).
   */
  test('component edges and states clear 1.4.11 in each theme', () => {
    const tokenOf = (selector: string, property: string): string => {
      const rule = NEDITOR_STYLES.slice(NEDITOR_STYLES.indexOf(`${selector} {`));
      const body = rule.slice(0, rule.indexOf('}'));
      const value = new RegExp(`${property}:[^;]*var\\((--[\\w-]+)\\)`).exec(body);

      expect(value, `${selector} sets no ${property} from a token`).not.toBeNull();

      return value![1] as string;
    };

    const checks = [
      ['.neditor-link-editor__input', 'border'],
      ['.neditor-image-editor__input', 'border'],
      ['.neditor-icon-picker__input', 'border'],
      [".neditor-slash-menu__item[data-active='true']", 'outline'],
      [".neditor-toolbar__button[data-active='true']", 'box-shadow'],
    ] as const;

    for (const { selector, tokens } of blocksDefining(NEDITOR_STYLES, '--neditor-text')) {
      const surface = over(parseColour(tokens['--neditor-surface'] as string), WHITE);
      const raised = over(parseColour(tokens['--neditor-surface-raised'] as string), surface);
      const hover = over(parseColour(tokens['--neditor-hover'] as string), raised);

      for (const [rule, property] of checks) {
        const token = tokenOf(rule, property);
        const ink = parseColour(tokens[token] as string);
        // The active option is also tinted, so its edge is measured on the tint.
        const ground = rule.includes('slash-menu') ? hover : raised;

        expect(
          contrast(over(ink, ground), ground),
          `${rule} ${property} (${token}) — ${selector}`,
        ).toBeGreaterThan(3);
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
    // From the defaults rather than a literal, so renaming a glyph -- "col"
    // became "column" for WCAG 2.5.3 -- cannot leave the README quoting the old.
    expect(readme).toContain(
      `\`${DEFAULT_LABELS.deleteRowGlyph}\` and \`${DEFAULT_LABELS.deleteColumnGlyph}\``,
    );
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
   * The gutter used to be shifted with a physical `translateX` and mirrored by
   * selectors guessing the editor's direction from `[dir]` attributes, which
   * guessed wrong for an LTR editor inside an LTR wrapper inside an RTL page.
   * It is a logical margin now; `visual-a11y.test.ts` holds the detail. This is
   * the guard against the guessing coming back.
   */
  test('nothing in the stylesheet infers the gutter direction from an attribute', () => {
    expect(NEDITOR_STYLES).not.toMatch(/\[dir='rtl'\][^{]*\.neditor-gutter/);
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

describe('rules whose effect happy-dom cannot observe, pinned as written', () => {
  const rule = (selector: string): string => {
    const start = NEDITOR_STYLES.indexOf(`${selector} {`);

    expect(start, `${selector} exists`).toBeGreaterThan(-1);
    return NEDITOR_STYLES.slice(start, NEDITOR_STYLES.indexOf('}', start));
  };

  /**
   * UI-9. Generated content is part of the accessible name, so an empty
   * caption named its figure "Add a caption". The alternative-text form keeps
   * the placeholder drawn and unread; the plain form stays first because a
   * declaration an engine rejects is dropped whole. The e2e suite checks the
   * name itself (images I8); happy-dom computes neither.
   */
  test('the placeholder is drawn with empty alternative text, after a plain fallback', () => {
    expect(rule(".neditor-block__content[contenteditable='true']:empty::before")).toMatch(
      /content: attr\(data-placeholder\);\s*content: attr\(data-placeholder\) \/ '';/,
    );
  });

  /** UI-6: 20em is wider than a 320px screen, and the menu overflowed it. */
  test('the slash menu is capped at the viewport, like the other popovers', () => {
    expect(rule('.neditor-slash-menu')).toContain('max-width: calc(100vw - 2rem);');
  });

  /**
   * UI-4: with no offset, the absolutely positioned gutter sat at its static
   * position below the last block until the first hover, adding overflow the
   * hover then removed. The e2e suite checks the layout (gutter-drag G14).
   */
  test('the gutter has an offset before it is first placed', () => {
    expect(rule('.neditor-gutter')).toMatch(/\n\s*top: 0;/);
  });

  /**
   * Round 14, review 4: a range the reader drew in the page across the editor
   * took in the live region's last announcement ("3 blocks selected"), and
   * Chromium's Mod+C copied it. The e2e suite checks the range and the copy
   * (accessibility A3b); happy-dom applies no user-select to a selection.
   * Not under a drag across blocks: with the blocks' text unselectable then,
   * the live region is the one place in the editor WebKit's own caret can
   * go, and without it the caret went to the page after the editor (read-only
   * RO6n, RO6r).
   */
  test('the live region cannot be selected, in WebKit either, except under a drag', () => {
    expect(rule('.neditor-live-region')).not.toContain('user-select');
    expect(rule(".neditor:not([data-selecting='true']) .neditor-live-region")).toMatch(
      /-webkit-user-select: none;\s*user-select: none;/,
    );
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
