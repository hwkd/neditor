import type { BlockType } from './model/document.ts';

/**
 * One entry in the slash menu.
 *
 * The icon and the menu order are presentation and stay in the menu itself;
 * everything a translator has to touch lives here.
 */
export interface SlashCommandLabel {
  /** Name of the entry, and the first thing typing filters against. */
  label: string;
  /** The line under the label. */
  description: string;
  /** Extra terms the filter matches by prefix, beyond the label. */
  keywords: readonly string[];
}

/**
 * Every user-visible string the editor produces.
 *
 * Most are accessible names rather than visible text, which is why they cannot
 * be reached with CSS: a non-English application would otherwise ship an
 * English screen-reader experience with no way to change it.
 */
export interface NEditorLabels {
  /** Accessible name for the editor itself. */
  editor: string;

  /** Placeholder shown in an empty block, per type. */
  placeholders: Partial<Record<BlockType, string>>;
  /** Placeholder in an empty table header cell. */
  tableHeaderCell: string;

  /** Block controls. */
  toggleCollapse: string;
  calloutIcon: string;
  imageEdit: string;
  imageAdd: string;

  /** Gutter. */
  gutterAdd: string;
  gutterHandle: string;

  /** Formatting toolbar. */
  bold: string;
  italic: string;
  underline: string;
  strikethrough: string;
  code: string;
  link: string;
  /**
   * The toolbar button and shortcut that turn the selection into an inline
   * equation, and the name of the popover that edits one.
   */
  inlineMath: string;

  /** Inline equation popover. */
  mathTex: string;
  mathPlaceholder: string;
  /**
   * Announced when a renderer rejects the TeX, and shown in place of the
   * preview. The TeX is still kept: an equation half-typed is not an error to
   * throw away.
   */
  mathError: string;

  /** Link and image popovers. */
  linkPlaceholder: string;
  /**
   * Shown and announced when a URL is rejected.
   *
   * The rejection used to be a red border and nothing else: silent to a screen
   * reader, and dropped entirely under forced colours, so for those users the
   * dialog simply refused to close with no reason given.
   */
  invalidUrl: string;
  linkUrl: string;
  /** The image popover's source field; not `linkUrl`, which names a link. */
  imageUrl: string;
  imageUrlPlaceholder: string;
  imageAltPlaceholder: string;
  imageAlt: string;
  apply: string;
  remove: string;

  /** Icon picker. */
  iconDialog: string;
  iconPlaceholder: string;
  iconCustom: string;

  /** Slash menu. */
  slashMenu: string;
  /**
   * Slash menu entries, keyed by the block type each one inserts.
   *
   * Filtering runs over these, so a translated menu is searchable in its own
   * language rather than only in English.
   */
  slashCommands: Partial<Record<BlockType, SlashCommandLabel>>;

  /** Formatting toolbar's own name. */
  formatToolbar: string;

  /** Table toolbar. */
  tableToolbar: string;
  insertRowAbove: string;
  insertRowBelow: string;
  deleteRow: string;
  /** Visible text on the delete-row button, beside its accessible name. */
  deleteRowGlyph: string;
  insertColumnLeft: string;
  insertColumnRight: string;
  deleteColumn: string;
  /**
   * Visible text on the delete-column button, beside its accessible name.
   *
   * Every word in it should also be a word of `deleteColumn` (and likewise
   * for the row pair), or the button fails WCAG 2.5.3 label-in-name.
   */
  deleteColumnGlyph: string;
  /**
   * The word printed in the corner of a code block.
   *
   * Drawn by the stylesheet, from an attribute the renderer sets. It used to be
   * a literal in the CSS, which put an English word on every code block in
   * every language with no way to reach it: `labels` did not cover it, and a
   * pseudo-element's content is not in the DOM to be translated afterwards.
   */
  codeBlockLabel: string;
  /** The word printed in the corner of a display equation, as for a code block. */
  mathBlockLabel: string;

  /** Live-region announcements. `{count}` and `{type}` are substituted. */
  blocksSelected: string;
  blockSelected: string;
  /** Zero is its own sentence, not the plural with a `0` in front of it. */
  noBlocksSelected: string;
  blocksDeleted: string;
  blockDeleted: string;
  toggleCollapsed: string;
  toggleExpanded: string;
  /** Announced when a to-do is ticked or unticked. */
  todoChecked: string;
  todoUnchecked: string;
  /**
   * Announced when block selection lands on a single block.
   *
   * The count alone said "1 block selected" for every block, so arrowing
   * through a document repeated one identical sentence and nothing ever
   * identified what Backspace was about to delete. `{type}` is the reader-facing
   * type name, `{text}` the start of the block's own text.
   */
  blockSelectedNamed: string;
  /**
   * For a block with nothing in it: an empty paragraph, a table with no text in
   * any cell, an image with no picture. `{type}` is substituted.
   */
  emptyBlockSelectedNamed: string;
  /**
   * For a block that is not empty but has no text to read out: a divider, an
   * image with a picture and neither alt text nor caption. `{type}` is
   * substituted. (An image with alt text is named by it, through
   * `blockSelectedNamed`.)
   */
  textlessBlockSelectedNamed: string;
  /**
   * What a block is called as the `{type}` of a selection announcement, per
   * type. A type with no entry here is called by its slash-menu label.
   *
   * The menu's "Text" is an instruction to start writing, not a name: as the
   * name of a selected block it read "Text selected, Block B", which sounds
   * like a text selection. Merged per entry, and a host that translates a
   * type's slash command without naming it here keeps its own translation
   * rather than this English default.
   */
  blockTypeNames: Partial<Record<BlockType, string>>;
  /**
   * Announced when selected blocks are cut. `{count}` is substituted. Left
   * out by a host that supplies any announcement older than these, its
   * `blockDeleted` / `blocksDeleted` stand in -- their English defaults when
   * it gave none, so a cut is never announced as nothing.
   */
  blockCut: string;
  blocksCut: string;
  /**
   * Announced when selected blocks move one place (⌘/Ctrl+Shift+↑/↓). Left out
   * by a host that supplies any announcement older than these, nothing is
   * announced.
   */
  blocksMovedUp: string;
  blocksMovedDown: string;
  /** Announced when Tab or Shift+Tab indents or outdents selected blocks; as above. */
  blocksIndented: string;
  blocksOutdented: string;
  /**
   * Announced when selected blocks are duplicated, before the selection of the
   * copies. `{count}` is substituted. Left out by a host that supplies any
   * announcement older than these, the selection is announced alone.
   */
  blockDuplicated: string;
  blocksDuplicated: string;
  rowAdded: string;
  rowInsertedAbove: string;
  rowInsertedBelow: string;
  rowDeleted: string;
  columnInsertedLeft: string;
  columnInsertedRight: string;
  columnDeleted: string;
  changedTo: string;
  undone: string;
  redone: string;
  leftEditor: string;
}

/**
 * Every block type the slash menu offers, so a partial override can always fall
 * back to a complete set rather than dropping an entry from the menu.
 */
export const DEFAULT_SLASH_COMMANDS: Record<BlockType, SlashCommandLabel> = {
  paragraph: {
    label: 'Text',
    description: 'Just start writing with plain text.',
    keywords: ['text', 'paragraph', 'plain'],
  },
  heading1: {
    label: 'Heading 1',
    description: 'Big section heading.',
    keywords: ['heading', 'h1', 'title', 'large'],
  },
  heading2: {
    label: 'Heading 2',
    description: 'Medium section heading.',
    keywords: ['heading', 'h2', 'subtitle', 'medium'],
  },
  heading3: {
    label: 'Heading 3',
    description: 'Small section heading.',
    keywords: ['heading', 'h3', 'small'],
  },
  bulleted_list: {
    label: 'Bulleted list',
    description: 'Create a simple bulleted list.',
    keywords: ['bullet', 'list', 'unordered', 'ul'],
  },
  numbered_list: {
    label: 'Numbered list',
    description: 'Create a list with numbering.',
    keywords: ['number', 'list', 'ordered', 'ol'],
  },
  todo: {
    label: 'To-do list',
    description: 'Track tasks with a checkbox.',
    keywords: ['todo', 'task', 'checkbox', 'check'],
  },
  quote: {
    label: 'Quote',
    description: 'Capture a quote.',
    keywords: ['quote', 'blockquote', 'cite'],
  },
  code: {
    label: 'Code',
    description: 'Capture a code snippet.',
    keywords: ['code', 'snippet', 'pre', 'monospace'],
  },
  math: {
    label: 'Equation',
    description: 'Display a TeX equation on its own line.',
    keywords: ['math', 'equation', 'tex', 'latex', 'katex', 'formula'],
  },
  callout: {
    label: 'Callout',
    description: 'Make writing stand out.',
    keywords: ['callout', 'note', 'info', 'aside', 'tip', 'warning'],
  },
  toggle: {
    label: 'Toggle list',
    description: 'Hide content inside a collapsible block.',
    keywords: ['toggle', 'collapse', 'details', 'accordion', 'fold'],
  },
  image: {
    label: 'Image',
    description: 'Embed a picture by URL.',
    keywords: ['image', 'picture', 'photo', 'img', 'embed'],
  },
  table: {
    label: 'Table',
    description: 'Add a simple table.',
    keywords: ['table', 'grid', 'rows', 'columns'],
  },
  divider: {
    label: 'Divider',
    description: 'Visually divide blocks.',
    keywords: ['divider', 'separator', 'hr', 'line'],
  },
};

/**
 * The live region's sentences: every label that is announced rather than
 * shown. A group of its own because whether a host translates the live
 * region is asked of exactly these keys (`resolveLabels`).
 */
const DEFAULT_ANNOUNCEMENTS = {
  blocksSelected: '{count} blocks selected',
  blockSelected: '1 block selected',
  noBlocksSelected: 'No blocks selected',
  blocksDeleted: '{count} blocks deleted',
  blockDeleted: 'Block deleted',
  toggleCollapsed: 'Toggle collapsed',
  todoChecked: 'Checked',
  todoUnchecked: 'Unchecked',
  blockSelectedNamed: '{type} selected, {text}',
  // The type leads, as it does in the named form: mid-sentence, a type name
  // spelt for the start of one read "Empty Table selected".
  emptyBlockSelectedNamed: '{type} selected, empty',
  textlessBlockSelectedNamed: '{type} selected',
  blockTypeNames: { paragraph: 'Paragraph' },
  blockCut: 'Block cut',
  blocksCut: '{count} blocks cut',
  blocksMovedUp: 'Moved up',
  blocksMovedDown: 'Moved down',
  blocksIndented: 'Indented',
  blocksOutdented: 'Outdented',
  blockDuplicated: 'Block duplicated',
  blocksDuplicated: '{count} blocks duplicated',
  toggleExpanded: 'Toggle expanded',
  rowAdded: 'Row added',
  rowInsertedAbove: 'Row inserted above',
  rowInsertedBelow: 'Row inserted below',
  rowDeleted: 'Row deleted',
  columnInsertedLeft: 'Column inserted left',
  columnInsertedRight: 'Column inserted right',
  columnDeleted: 'Column deleted',
  changedTo: 'Changed to {type}',
  undone: 'Undone',
  redone: 'Redone',
  leftEditor: 'Left the editor',
} satisfies Partial<NEditorLabels>;

export const DEFAULT_LABELS: NEditorLabels = {
  editor: 'Rich text editor',

  placeholders: {
    paragraph: "Type '/' for commands",
    heading1: 'Heading 1',
    heading2: 'Heading 2',
    heading3: 'Heading 3',
    bulleted_list: 'List',
    numbered_list: 'List',
    todo: 'To-do',
    quote: 'Empty quote',
    code: 'Code',
    math: 'TeX, e.g. E = mc^2',
    callout: 'Callout',
    toggle: 'Toggle',
    image: 'Add a caption',
  },
  tableHeaderCell: 'Heading',

  toggleCollapse: 'Expand or collapse',
  calloutIcon: 'Change icon',
  imageEdit: 'Edit image source and alt text',
  imageAdd: 'Add an image',

  gutterAdd: 'Add a block below',
  gutterHandle: 'Drag to move, click to select',

  bold: 'Bold',
  italic: 'Italic',
  underline: 'Underline',
  strikethrough: 'Strikethrough',
  code: 'Code',
  link: 'Link',
  inlineMath: 'Inline equation',

  mathTex: 'TeX source',
  mathPlaceholder: 'e.g. x^2 + y^2',
  mathError: 'This TeX could not be rendered',

  linkPlaceholder: 'Paste a link or type a URL',
  invalidUrl: 'That is not a URL this editor can use',
  linkUrl: 'Link URL',
  imageUrl: 'Image URL',
  imageUrlPlaceholder: 'Paste an image URL',
  imageAltPlaceholder: 'Alt text, for screen readers',
  imageAlt: 'Alt text',
  apply: 'Apply',
  remove: 'Remove',

  iconDialog: 'Choose an icon',
  iconPlaceholder: 'Type or paste any emoji',
  iconCustom: 'Custom icon',

  slashMenu: 'Block types',
  slashCommands: DEFAULT_SLASH_COMMANDS,

  formatToolbar: 'Text formatting',

  tableToolbar: 'Table',
  insertRowAbove: 'Insert row above',
  insertRowBelow: 'Insert row below',
  deleteRow: 'Delete this row',
  deleteRowGlyph: '⤫ row',
  insertColumnLeft: 'Insert column left',
  insertColumnRight: 'Insert column right',
  deleteColumn: 'Delete this column',
  // The whole word: the name is "Delete this column", and a visible word that
  // is not a word of the name fails WCAG 2.5.3 -- a speech user saying
  // "col" matches nothing.
  deleteColumnGlyph: '⤫ column',
  codeBlockLabel: 'code',
  mathBlockLabel: 'TeX',

  ...DEFAULT_ANNOUNCEMENTS,
};

/** Announcements added after the live region was translatable (9 Nov 2026). */
const ANNOUNCED_LATER = [
  'blockCut',
  'blocksCut',
  'blocksMovedUp',
  'blocksMovedDown',
  'blocksIndented',
  'blocksOutdented',
  'blockDuplicated',
  'blocksDuplicated',
] as const satisfies readonly (keyof typeof DEFAULT_ANNOUNCEMENTS)[];

/** Every label introduced with `ANNOUNCED_LATER` (9 Nov 2026), announced or not. */
const INTRODUCED_LATER: ReadonlySet<string> = new Set<keyof NEditorLabels>([
  ...ANNOUNCED_LATER,
  'textlessBlockSelectedNamed',
  'blockTypeNames',
  'imageUrl',
]);

/**
 * The announcements a host could have translated before `ANNOUNCED_LATER`
 * existed. Supplying any of them is what says a host translates the live
 * region, and so would rather hear nothing than an English sentence among
 * its own.
 *
 * Stated as a predicate over the label's kind -- announced, and older than
 * this release -- rather than as a list. Each list so far was wrong in its own
 * direction: one hand-written list of announcements left out the table ones,
 * so a host that translated only those heard English; "any older label at
 * all" counted a host that renamed the editor or reworded one English
 * placeholder, and it lost the move, indent and duplicate sentences and heard
 * "Block deleted" for a cut.
 */
const OLDER_ANNOUNCEMENTS: ReadonlySet<string> = new Set(
  Object.keys(DEFAULT_ANNOUNCEMENTS).filter((key) => !INTRODUCED_LATER.has(key)),
);

/** Fills in whatever the caller did not override. */
export function resolveLabels(overrides?: Partial<NEditorLabels>): NEditorLabels {
  // A host that translated the whole interface before `blockSelectedNamed`
  // existed has no entry for it, and falling through to the English default
  // put one English sentence back into an otherwise translated live region --
  // on the commonest announcement there is. Their own `blockSelected` is the
  // closest thing they gave us, so it stands in until they translate the new
  // one. The named form takes `{type}` and `{text}`, which `formatLabel`
  // leaves alone when the string does not use them.
  // `{count}` is substituted here rather than left for the caller: the named
  // forms are only ever used for a single block, and the call site fills in
  // `{type}` and `{text}` -- so a host whose one-form reads `{count} блок
  // выделен` had the placeholder announced as the literal characters.
  const standIn = overrides?.blockSelected?.replaceAll('{count}', '1');
  const named = overrides?.blockSelectedNamed ?? standIn;
  const emptyNamed = overrides?.emptyBlockSelectedNamed ?? standIn;
  const textlessNamed = overrides?.textlessBlockSelectedNamed ?? standIn;
  // The announcements added after the live region was first translatable get
  // the same treatment: a host that translated it before they existed heard
  // "Block cut" in English after a cut. A cut is a deletion as far as the
  // document goes, so the sentence for that stands in -- the host's own, or
  // the English default where it gave none: a cut that says nothing at all
  // left a screen-reader user unsure anything happened. The others have no
  // sentence near enough to borrow, and are left unsaid -- a duplicate still
  // announces the copies' selection in the host's words.
  const translating = Object.entries(overrides ?? {}).some(
    ([key, value]) => value !== undefined && OLDER_ANNOUNCEMENTS.has(key),
  );
  const later = (
    key: (typeof ANNOUNCED_LATER)[number],
    standInFor?: string,
  ): Partial<NEditorLabels> =>
    overrides?.[key] !== undefined || !translating ? {} : { [key]: standInFor ?? '' };
  // The same reasoning for a type's name: a host that translated the slash
  // command for paragraphs but has never heard of `blockTypeNames` would
  // otherwise hear an English "Paragraph" in a French sentence. Its own
  // translation of the command stands in.
  const typeNames = Object.fromEntries(
    Object.entries(DEFAULT_LABELS.blockTypeNames).filter(
      ([type]) => overrides?.slashCommands?.[type as BlockType] === undefined,
    ),
  );

  return {
    ...DEFAULT_LABELS,
    ...overrides,
    ...(named === undefined ? {} : { blockSelectedNamed: named }),
    ...(emptyNamed === undefined ? {} : { emptyBlockSelectedNamed: emptyNamed }),
    ...(textlessNamed === undefined ? {} : { textlessBlockSelectedNamed: textlessNamed }),
    ...later('blockCut', overrides?.blockDeleted ?? DEFAULT_LABELS.blockDeleted),
    ...later('blocksCut', overrides?.blocksDeleted ?? DEFAULT_LABELS.blocksDeleted),
    ...later('blocksMovedUp'),
    ...later('blocksMovedDown'),
    ...later('blocksIndented'),
    ...later('blocksOutdented'),
    ...later('blockDuplicated'),
    ...later('blocksDuplicated'),
    placeholders: { ...DEFAULT_LABELS.placeholders, ...overrides?.placeholders },
    // Per entry, like placeholders: translating one command must not blank the
    // other thirteen.
    slashCommands: { ...DEFAULT_LABELS.slashCommands, ...overrides?.slashCommands },
    blockTypeNames: { ...typeNames, ...overrides?.blockTypeNames },
  };
}

/**
 * Picks the plural form for a count, then substitutes into it.
 *
 * English needs three forms here, not two. Zero is a different sentence — "No
 * blocks selected" — and a live region that reads "0 blocks selected" is how a
 * screen-reader user hears an empty selection otherwise.
 */
export function pluralLabel(
  forms: { readonly zero: string; readonly one: string; readonly other: string },
  count: number,
): string {
  const template = count === 0 ? forms.zero : count === 1 ? forms.one : forms.other;

  return formatLabel(template, { count });
}

/** Substitutes `{name}` placeholders in a label. */
export function formatLabel(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}
