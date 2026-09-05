// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';

import { NEDITOR_STYLES } from './styles.ts';
import { DEFAULT_LABELS, pluralLabel, resolveLabels } from './labels.ts';
import { SLASH_COMMANDS, SlashMenu, createSlashCommands, filterCommands } from './ui/slash-menu.ts';

/**
 * Localisation and bidirectionality.
 *
 * A non-English application must be able to replace every string the editor
 * produces, search the menus in its own words, and read right to left. Each of
 * these covers a place where an English or left-to-right assumption had been
 * baked in past the labels option.
 */

const FRENCH_HEADING = {
  label: 'Titre 1',
  description: 'Grand titre de section.',
  // Capitalised on purpose: a translator writes keywords the way the language
  // does, and the filter lower-cases the needle only.
  keywords: ['Titre', 'Grand'],
} as const;

const frenchLabels = () => resolveLabels({ slashCommands: { heading1: { ...FRENCH_HEADING } } });

describe('plural forms', () => {
  const forms = {
    zero: DEFAULT_LABELS.noBlocksSelected,
    one: DEFAULT_LABELS.blockSelected,
    other: DEFAULT_LABELS.blocksSelected,
  };

  test('zero reads as a sentence, not as the plural with a 0 in it', () => {
    expect(pluralLabel(forms, 0)).toBe('No blocks selected');
  });

  test('one and many keep the wording they have today', () => {
    expect(pluralLabel(forms, 1)).toBe('1 block selected');
    expect(pluralLabel(forms, 4)).toBe('4 blocks selected');
  });

  test('the count is substituted into every form, not only the plural', () => {
    // Plenty of languages put the number in the singular and the zero form too,
    // and cannot express them otherwise.
    const french = {
      zero: 'Aucun bloc sélectionné',
      one: '{count} bloc sélectionné',
      other: '{count} blocs sélectionnés',
    };

    expect(pluralLabel(french, 0)).toBe('Aucun bloc sélectionné');
    expect(pluralLabel(french, 1)).toBe('1 bloc sélectionné');
    expect(pluralLabel(french, 3)).toBe('3 blocs sélectionnés');
  });
});

describe('slash menu commands', () => {
  test('the built-in menu is unchanged English', () => {
    expect(SLASH_COMMANDS.map((command) => command.label)).toEqual([
      'Text',
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Bulleted list',
      'Numbered list',
      'To-do list',
      'Quote',
      'Code',
      'Callout',
      'Toggle list',
      'Image',
      'Table',
      'Divider',
    ]);

    expect(SLASH_COMMANDS[0]).toEqual({
      type: 'paragraph',
      label: 'Text',
      description: 'Just start writing with plain text.',
      icon: 'T',
      keywords: ['text', 'paragraph', 'plain'],
    });
  });

  test('a translated entry keeps its icon and its place in the menu', () => {
    const commands = createSlashCommands(frenchLabels());

    expect(commands[1]).toEqual({
      type: 'heading1',
      icon: 'H1',
      label: 'Titre 1',
      description: 'Grand titre de section.',
      keywords: ['Titre', 'Grand'],
    });
  });

  test('translating one entry leaves the other thirteen alone', () => {
    const labels = frenchLabels();

    // Merged per entry, like the placeholders: overriding one command must not
    // blank the rest of the set.
    expect(labels.slashCommands.paragraph?.label).toBe('Text');
    expect(labels.slashCommands.divider?.description).toBe('Visually divide blocks.');

    const commands = createSlashCommands(labels);

    expect(commands).toHaveLength(SLASH_COMMANDS.length);
    expect(commands[0]?.label).toBe('Text');
    expect(commands[2]?.label).toBe('Heading 2');
  });

  test('filtering matches the translated label and keywords', () => {
    const commands = createSlashCommands(frenchLabels());

    expect(filterCommands('titre', commands).map((command) => command.type)).toEqual(['heading1']);
    // Matched through the keyword alone: the label does not contain "grand".
    expect(filterCommands('grand', commands).map((command) => command.type)).toEqual(['heading1']);
  });

  test('the English a translation replaced stops matching', () => {
    const commands = createSlashCommands(frenchLabels());

    expect(filterCommands('heading', commands).map((command) => command.type)).toEqual([
      'heading2',
      'heading3',
    ]);
  });

  test('filtering with no list given still searches the built-in English', () => {
    expect(filterCommands('quote').map((command) => command.type)).toEqual(['quote']);
    expect(filterCommands('')).toEqual(SLASH_COMMANDS);
  });

  test('the menu renders and filters the labels it was constructed with', () => {
    const hooks = { onSelect: () => {}, onDismiss: () => {}, onActiveChange: () => {} };
    const menu = new SlashMenu(document, hooks, frenchLabels());

    menu.setQuery('titre');

    const rendered = [...menu.element.querySelectorAll('.neditor-slash-menu__label')].map(
      (node) => node.textContent,
    );

    expect(rendered).toEqual(['Titre 1']);
  });
});

describe('the stylesheet reads in both directions', () => {
  test('no physical inline-axis property survives', () => {
    // dir="rtl" mirrors the logical properties for free; a physical one pins
    // the box to the wrong edge with no way for a consumer to override it.
    expect(NEDITOR_STYLES).not.toMatch(/text-align:\s*(left|right)/);
    expect(NEDITOR_STYLES).not.toMatch(/(?:padding|margin|border)-(?:left|right)\s*:/);
  });

  test('table cells align to the start of the line, not to the left', () => {
    expect(NEDITOR_STYLES).toMatch(/:is\(th, td\)[^}]*text-align: start;/);
  });
});

describe('every visible string is reachable through labels', () => {
  test('the table toolbar delete glyphs are overridable', () => {
    // These carry a word, not just a direction, so they were the last visible
    // text a translator could not reach.
    const labels = resolveLabels({ deleteRowGlyph: '⤫ Zeile', deleteColumnGlyph: '⤫ Spalte' });

    expect(labels.deleteRowGlyph).toBe('⤫ Zeile');
    expect(labels.deleteColumnGlyph).toBe('⤫ Spalte');
  });

  test('the defaults are unchanged for a consumer who passes nothing', () => {
    const labels = resolveLabels({});

    expect(labels.deleteRowGlyph).toBe('⤫ row');
    expect(labels.deleteColumnGlyph).toBe('⤫ col');
  });
});

describe('the code block label is drawn from the element, not the stylesheet', () => {
  /**
   * It was a literal in the CSS, so it read "code" on every page in every
   * language: `labels` did not cover it, and a pseudo-element's content is not
   * in the DOM for a consumer to translate afterwards.
   */
  test('the stylesheet reads it rather than printing its own', () => {
    expect(NEDITOR_STYLES).toContain('content: attr(data-neditor-code-label)');
    expect(NEDITOR_STYLES).not.toContain("content: 'code'");
  });

  test('and there is a default for it to read', () => {
    expect(DEFAULT_LABELS.codeBlockLabel).toBe('code');
  });
});

describe('a translation made before a label existed is not lost to English', () => {
  /**
   * `blockSelectedNamed` replaced `blockSelected` on the single-block path, so
   * a host that had translated the whole interface before it existed suddenly
   * heard one English sentence in an otherwise translated live region -- on the
   * commonest announcement there is.
   */
  test('their blockSelected stands in for the named form they never saw', () => {
    const labels = resolveLabels({ blockSelected: '1 Block ausgewählt' });

    expect(labels.blockSelectedNamed).toBe('1 Block ausgewählt');
    expect(labels.emptyBlockSelectedNamed).toBe('1 Block ausgewählt');
  });

  test('a host that translates the named form gets exactly that', () => {
    const labels = resolveLabels({
      blockSelected: '1 Block ausgewählt',
      blockSelectedNamed: '{type} ausgewählt, {text}',
    });

    expect(labels.blockSelectedNamed).toBe('{type} ausgewählt, {text}');
  });

  test('and a host that overrides nothing keeps the defaults', () => {
    expect(resolveLabels().blockSelectedNamed).toBe(DEFAULT_LABELS.blockSelectedNamed);
  });
});

describe('a one-form carrying a count is not announced with the placeholder bare', () => {
  /**
   * `blockSelected` commonly reads `{count} block selected`, and substituting
   * it for the named form put those literal characters into the live region --
   * the named forms are only ever used for a single block, and the call site
   * fills in `{type}` and `{text}`, not `{count}`.
   */
  test('the stand-in has its count filled in', () => {
    const labels = resolveLabels({ blockSelected: '{count} блок выделен' });

    expect(labels.blockSelectedNamed).toBe('1 блок выделен');
    expect(labels.emptyBlockSelectedNamed).toBe('1 блок выделен');
  });

  test('a one-form without a count is used as it stands', () => {
    expect(resolveLabels({ blockSelected: 'Ein Block ausgewählt' }).blockSelectedNamed).toBe(
      'Ein Block ausgewählt',
    );
  });
});
