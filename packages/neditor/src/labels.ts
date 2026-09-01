import type { BlockType } from './model/document.ts';

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

  /** Formatting toolbar's own name. */
  formatToolbar: string;

  /** Table toolbar. */
  tableToolbar: string;
  insertRowAbove: string;
  insertRowBelow: string;
  deleteRow: string;
  insertColumnLeft: string;
  insertColumnRight: string;
  deleteColumn: string;

  /** Live-region announcements. `{count}` and `{type}` are substituted. */
  blocksSelected: string;
  blockSelected: string;
  blocksDeleted: string;
  blockDeleted: string;
  toggleCollapsed: string;
  toggleExpanded: string;
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

  formatToolbar: 'Text formatting',

  tableToolbar: 'Table',
  insertRowAbove: 'Insert row above',
  insertRowBelow: 'Insert row below',
  deleteRow: 'Delete this row',
  insertColumnLeft: 'Insert column left',
  insertColumnRight: 'Insert column right',
  deleteColumn: 'Delete this column',

  blocksSelected: '{count} blocks selected',
  blockSelected: '1 block selected',
  blocksDeleted: '{count} blocks deleted',
  blockDeleted: 'Block deleted',
  toggleCollapsed: 'Toggle collapsed',
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
  return {
    ...DEFAULT_LABELS,
    ...overrides,
    placeholders: { ...DEFAULT_LABELS.placeholders, ...overrides?.placeholders },
  };
}

/** Substitutes `{name}` placeholders in a label. */
export function formatLabel(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}
