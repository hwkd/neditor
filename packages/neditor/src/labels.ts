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
  /** Visible text on the delete-column button, beside its accessible name. */
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
  /** For a block with no text of its own -- a divider, an empty paragraph. */
  emptyBlockSelectedNamed: string;
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

  linkPlaceholder: 'Paste a link or type a URL',
  invalidUrl: 'That is not a URL this editor can use',
  linkUrl: 'Link URL',
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
  deleteColumnGlyph: '⤫ col',
  codeBlockLabel: 'code',

  blocksSelected: '{count} blocks selected',
  blockSelected: '1 block selected',
  noBlocksSelected: 'No blocks selected',
  blocksDeleted: '{count} blocks deleted',
  blockDeleted: 'Block deleted',
  toggleCollapsed: 'Toggle collapsed',
  todoChecked: 'Checked',
  todoUnchecked: 'Unchecked',
  blockSelectedNamed: '{type} selected, {text}',
  emptyBlockSelectedNamed: 'Empty {type} selected',
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
};

/** Fills in whatever the caller did not override. */
export function resolveLabels(overrides?: Partial<NEditorLabels>): NEditorLabels {
  // A host that translated the whole interface before `blockSelectedNamed`
  // existed has no entry for it, and falling through to the English default
  // put one English sentence back into an otherwise translated live region --
  // on the commonest announcement there is. Their own `blockSelected` is the
  // closest thing they gave us, so it stands in until they translate the new
  // one. The named form takes `{type}` and `{text}`, which `formatLabel`
  // leaves alone when the string does not use them.
  const named =
    overrides?.blockSelectedNamed ??
    (overrides?.blockSelected === undefined ? undefined : overrides.blockSelected);
  const emptyNamed =
    overrides?.emptyBlockSelectedNamed ??
    (overrides?.blockSelected === undefined ? undefined : overrides.blockSelected);

  return {
    ...DEFAULT_LABELS,
    ...overrides,
    ...(named === undefined ? {} : { blockSelectedNamed: named }),
    ...(emptyNamed === undefined ? {} : { emptyBlockSelectedNamed: emptyNamed }),
    placeholders: { ...DEFAULT_LABELS.placeholders, ...overrides?.placeholders },
    // Per entry, like placeholders: translating one command must not blank the
    // other thirteen.
    slashCommands: { ...DEFAULT_LABELS.slashCommands, ...overrides?.slashCommands },
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
