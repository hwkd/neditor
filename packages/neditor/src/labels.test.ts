// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';

import { NEDITOR_STYLES } from './styles.ts';
import { DEFAULT_LABELS, pluralLabel, resolveLabels } from './labels.ts';
import type { NEditorLabels, SlashCommandLabel } from './labels.ts';
import { createEditor } from './index.ts';
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
      'Equation',
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

  test('translating one entry leaves the other fourteen alone', () => {
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

  test('the defaults hold for a consumer who passes nothing', () => {
    const labels = resolveLabels({});

    expect(labels.deleteRowGlyph).toBe('⤫ row');
    // "column", not "col": the button is named "Delete this column", and a
    // visible word that is not a word of the name fails WCAG 2.5.3.
    expect(labels.deleteColumnGlyph).toBe('⤫ column');
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

  /*
   * R2-NAV-7: the cut, move, indent and duplicate announcements arrived after
   * the live region was translatable, and a host that had translated it heard
   * "Block cut" in English.
   */
  test('their "deleted" stands in for "cut", and the newer sentences say nothing English', () => {
    const labels = resolveLabels({
      blockDeleted: 'Bloc supprimé',
      blocksDeleted: '{count} blocs supprimés',
      blockSelected: '1 bloc sélectionné',
    });

    expect(labels.blockCut).toBe('Bloc supprimé');
    expect(labels.blocksCut).toBe('{count} blocs supprimés');
    expect(labels.textlessBlockSelectedNamed).toBe('1 bloc sélectionné');
    for (const key of [
      'blocksMovedUp',
      'blocksMovedDown',
      'blocksIndented',
      'blocksOutdented',
      'blockDuplicated',
      'blocksDuplicated',
    ] as const) {
      expect({ [key]: labels[key] }).toEqual({ [key]: '' });
    }
  });

  test('a newer sentence the host did translate is theirs', () => {
    const labels = resolveLabels({ blockDeleted: 'Bloc supprimé', blockCut: 'Bloc coupé' });

    expect(labels.blockCut).toBe('Bloc coupé');
  });

  // R3-KEY-5: "translating" is not a hand-written list of the live region's
  // labels -- one left out the table announcements -- and needs an older one.
  test('a host that supplies no older announcement keeps every English sentence', () => {
    for (const labels of [
      resolveLabels(),
      resolveLabels({}),
      resolveLabels({ blocksIndented: 'Tabbed in', blockTypeNames: { quote: 'Quotation' } }),
    ]) {
      expect(labels.blockCut).toBe(DEFAULT_LABELS.blockCut);
      expect(labels.blocksMovedUp).toBe(DEFAULT_LABELS.blocksMovedUp);
      expect(labels.blockDuplicated).toBe(DEFAULT_LABELS.blockDuplicated);
    }
  });

  // `labels` is a runtime option: a JavaScript host or a stored translation file
  // gives the one field it translates, and the type cannot insist on the rest.
  // Merged per entry only, `keywords` was `undefined`, and every query that
  // missed the translated label threw out of the filter on each keystroke.
  test('an entry that gives only its label keeps the default description and keywords', () => {
    const labels = resolveLabels({
      slashCommands: { heading1: { label: 'Titre 1' } as SlashCommandLabel },
    });

    expect(labels.slashCommands.heading1).toEqual({
      ...DEFAULT_LABELS.slashCommands.heading1,
      label: 'Titre 1',
    });

    const commands = createSlashCommands(labels);

    expect(() => filterCommands('hea', commands)).not.toThrow();
    expect(filterCommands('hea', commands).map((command) => command.type)).toContain('heading1');
    expect(filterCommands('tit', commands).map((command) => command.type)).toEqual(['heading1']);
  });

  // R4-KEY-2: an older announcement, not any older label. A host that rewords
  // one English placeholder, or names the editor, has not translated the live
  // region, and lost the move / indent / duplicate sentences and heard "Block
  // deleted" for a cut.
  test('a host that customised a label outside the live region keeps every English sentence', () => {
    for (const overrides of [
      { placeholders: { paragraph: 'Write something…' } },
      { editor: 'Release notes' },
      { imageUrl: 'Picture address' },
      { bold: 'Strong', slashCommands: { quote: { label: 'Q', description: '', keywords: [] } } },
    ] satisfies Partial<NEditorLabels>[]) {
      const labels = resolveLabels(overrides);

      expect(labels.blockCut).toBe(DEFAULT_LABELS.blockCut);
      expect(labels.blocksCut).toBe(DEFAULT_LABELS.blocksCut);
      expect(labels.blocksMovedUp).toBe(DEFAULT_LABELS.blocksMovedUp);
      expect(labels.blocksIndented).toBe(DEFAULT_LABELS.blocksIndented);
      expect(labels.blockDuplicated).toBe(DEFAULT_LABELS.blockDuplicated);
    }
  });

  test('a host that translated any older announcement is translating', () => {
    for (const overrides of [
      { undone: 'Annulé' },
      { rowInsertedAbove: 'Ligne insérée au-dessus' },
      { leftEditor: 'Sorti de l’éditeur' },
      { blocksSelected: '{count} blocs sélectionnés' },
      { toggleCollapsed: 'Replié' },
    ] satisfies Partial<NEditorLabels>[]) {
      const labels = resolveLabels(overrides);

      expect(labels.blocksMovedUp).toBe('');
      expect(labels.blockDuplicated).toBe('');
      expect(labels.blockCut).toBe(DEFAULT_LABELS.blockDeleted);
    }
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

describe('the image editor names its own field', () => {
  // It borrowed the link popover's `linkUrl`, so a screen reader announced the
  // picture's source as "Link URL" -- a field for a link the user never made.
  test('the source input is announced as an image URL', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = createEditor({
      element: host,
      doc: {
        blocks: [{ id: 'i', type: 'image', depth: 0, content: [], src: 'https://e.com/a.png' }],
      },
    });
    host
      .querySelector<HTMLElement>('.neditor-image__trigger')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const input = document.querySelector('.neditor-image-editor input');

    expect(input?.getAttribute('aria-label')).toBe('Image URL');
    editor.destroy();
    host.remove();
  });

  test('and a translation can replace it', () => {
    expect(resolveLabels({ imageUrl: "URL de l'image" }).imageUrl).toBe("URL de l'image");
  });
});
