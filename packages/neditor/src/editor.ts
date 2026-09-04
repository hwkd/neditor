import { matchInlineRule } from './input/inline-rules.ts';
import { matchInputRule } from './input/input-rules.ts';
import { blocksFromMarkdown } from './input/markdown.ts';
import type { Block, BlockType, NEditorDocument } from './model/document.ts';
import {
  DEFAULT_CALLOUT_ICON,
  acceptsChildren,
  blockIdRange,
  canMergeText,
  blockText,
  cloneBlock,
  cloneDocument,
  createBlock,
  createEmptyDocument,
  findBlock,
  findBlockIndex,
  indentBlock,
  duplicateBlocks,
  indentBlocks,
  insertBlockAfter,
  insertBlockAt,
  isContinuingType,
  isRichEmpty,
  isVoidType,
  moveBlocks,
  moveVisibleBlocks,
  normalizeDepths,
  normalizeDocument,
  removeBlock,
  removeBlocks,
  sameBlocks,
  sliceDocument,
  setBlockType,
  toMarkdown,
  typeAfterSplit,
  updateBlock,
  visibleBlocks,
  withHiddenDescendants,
} from './model/document.ts';
import type { HistoryEntry, HistoryState, SelectionSnapshot } from './model/history.ts';
import type { TableRows } from './model/table.ts';
import {
  tableDeleteColumn,
  tableDeleteRow,
  tableInsertColumn,
  tableInsertRow,
  tableSetCell,
  tableSize,
  tableStep,
} from './model/table.ts';
import { History } from './model/history.ts';
import type { Mark, RichText } from './model/rich-text.ts';
import {
  richActiveLink,
  richActiveMarks,
  richConcat,
  richDelete,
  richEquals,
  richFromPlainText,
  richInsert,
  richLength,
  richMarksAt,
  richSetLink,
  richSlice,
  richSplit,
  richToPlainText,
  richToggleMark,
  sortMarks,
} from './model/rich-text.ts';
import type { NEditorLabels } from './labels.ts';
import { formatLabel, pluralLabel, resolveLabels } from './labels.ts';
import { injectStyles } from './styles.ts';
import { FormatToolbar } from './ui/format-toolbar.ts';
import { Gutter } from './ui/gutter.ts';
import { IconPicker } from './ui/icon-picker.ts';
import { ImageEditor } from './ui/image-editor.ts';
import { LinkEditor } from './ui/link-editor.ts';
import type { PortalTheme } from './ui/portal.ts';
import type { SlashCommand } from './ui/slash-menu.ts';
import { SlashMenu } from './ui/slash-menu.ts';
import type { TableCommand } from './ui/table-toolbar.ts';
import { TableToolbar } from './ui/table-toolbar.ts';
import { Renderer } from './view/renderer.ts';
import { blocksFromHtml, blocksToHtml, parseRichText } from './view/rich-dom.ts';
import type { OffsetRange } from './view/selection.ts';
import {
  getCaretOffset,
  getSelectionRange,
  isCaretAtEnd,
  isCaretAtStart,
  offsetsOfNode,
  setCaretOffset,
  setSelectionRange,
} from './view/selection.ts';
import { Emitter } from './util/emitter.ts';
import { asElement, hasInputType, isNode } from './util/dom.ts';
import { firstGrapheme } from './util/grapheme.ts';
import { sanitizeImageUrl, sanitizeUrl } from './util/url.ts';

export interface NEditorOptions {
  /** Mount point, or a selector resolved against `document`. */
  element: HTMLElement | string;
  /** Initial content. Defaults to a single empty paragraph. */
  doc?: NEditorDocument;
  /** Set false for a read-only view. Defaults to true. */
  editable?: boolean;
  /** Focus the first block on mount. Defaults to false. */
  autofocus?: boolean;
  /** Set false to supply your own stylesheet. Defaults to true. */
  injectStyles?: boolean;
  /** Defaults to `auto`, which follows `prefers-color-scheme`. */
  theme?: PortalTheme;
  /** Set false to suppress the floating selection toolbar. Defaults to true. */
  toolbar?: boolean;
  /** Undo steps retained. Defaults to 200. */
  historyLimit?: number;
  /** Set false to suppress the hover gutter and drag handles. Defaults to true. */
  dragHandles?: boolean;
  /** Convenience alias for `editor.on('change', ...)`. */
  onChange?: (doc: NEditorDocument) => void;
  /** Called when a listener throws. Defaults to console.error. */
  onError?: (error: unknown) => void;
  /** Accessible name for the editor. Ignored if the element already has one. */
  label?: string;
  /**
   * Overrides for the editor's user-visible strings.
   *
   * Most are accessible names, which CSS cannot reach — without these a
   * non-English application ships an English screen-reader experience.
   */
  labels?: Partial<NEditorLabels>;
  /**
   * Where the floating toolbars, menus and popovers are appended.
   *
   * Defaults to the document body. A modal `<dialog>` is promoted to the top
   * layer and paints above any z-index, so pass the dialog itself to keep them
   * visible; a shadow root works the same way.
   */
  portalContainer?: HTMLElement | ShadowRoot;
  /** `nonce` for the injected `<style>`, for a strict `style-src` policy. */
  styleNonce?: string;
}

/** Where a table cell sits, row-major, as `data-cell="row:column"` carries it. */
export interface CellCoords {
  readonly row: number;
  readonly column: number;
}

/** A DOM position, as the caret-from-a-point APIs hand one back. */
interface CaretPoint {
  readonly node: Node;
  readonly offset: number;
}

/**
 * The two names a document or shadow root gives "which caret is at (x, y)".
 *
 * Both are optional: the supported browsers implement one or the other, and a
 * test double or a non-browser DOM may implement neither.
 */
interface CaretSource {
  caretPositionFromPoint?: (
    x: number,
    y: number,
    options?: { shadowRoots?: readonly ShadowRoot[] },
  ) => { offsetNode: Node | null; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
}

/**
 * Where the floating UI belongs when the caller does not name a container.
 *
 * `document.body` is outside a shadow root, and a stylesheet injected into that
 * root does not reach it: every menu, toolbar and popover would render with no
 * tokens, no layout and no `position: fixed` at all. The mount point's own root
 * node is the tree the editor was put into, which is the tree its floating UI
 * has to live in too.
 */
function defaultPortalContainer(element: HTMLElement): HTMLElement | ShadowRoot {
  const root = element.getRootNode();

  // Duck-typed, not `instanceof ShadowRoot`: the editor is mounted into foreign
  // documents on purpose and a realm check would reject a perfectly real one.
  return 'host' in root ? (root as ShadowRoot) : element.ownerDocument.body;
}

/**
 * Every node a pointer actually went through, innermost first.
 *
 * `event.target` is not that node for a listener on the document: an event
 * that crossed a shadow boundary is *retargeted*, and target is reported as
 * the shadow host. Since {@link defaultPortalContainer} puts the popovers in
 * that same shadow root, a `contains` check against the host answers "outside"
 * for a pointer that landed squarely inside one — so clicking into the link
 * editor's own input dismissed it and threw the edit away. The composed path
 * is the un-retargeted truth, and it is checked whole rather than at its first
 * entry so a popover holding a shadow root of its own is still recognised.
 *
 * Non-`Node` entries — the `Window` at the end of every path — are dropped,
 * and a path that comes back empty falls back to the target, so a synthetic
 * event without `composedPath` still dismisses the way it always did.
 */
function composedTargets(event: Event): readonly Node[] {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  const nodes = path.filter((entry): entry is Node => isNode(entry));

  if (nodes.length > 0) {
    return nodes;
  }

  return isNode(event.target) ? [event.target] : [];
}

/** True when two hosts are the same cell — or both are a block's own content. */
function sameCell(a: CellCoords | undefined, b: CellCoords | undefined): boolean {
  return a?.row === b?.row && a?.column === b?.column;
}

/**
 * Whether this platform's shortcut modifier is Cmd rather than Ctrl.
 *
 * macOS gives Ctrl to the system's emacs-style caret bindings — Ctrl+B back a
 * character, Ctrl+E end of line, Ctrl+A start of line, Ctrl+K kill to the end —
 * and every native text field honours them. Treating Ctrl as a second Cmd
 * everywhere swallowed all four and typed bold, a link and a select-all
 * instead, which is both a broken caret and a shortcut collision no one asked
 * for. Elsewhere Ctrl is the shortcut modifier and Meta is a window-manager key
 * that means nothing here, so both keep being accepted there.
 *
 * Read from the mount point's own window rather than a global: the editor is
 * mounted into foreign documents on purpose. `userAgentData` first, since
 * `platform` is deprecated and frozen; both are anchored so a UA string that
 * merely mentions a platform later on cannot match.
 */
function isApplePlatform(view: (Window & typeof globalThis) | null): boolean {
  const agent = view?.navigator as
    | (Navigator & { userAgentData?: { platform?: string } })
    | undefined;

  const platform = agent?.userAgentData?.platform ?? agent?.platform ?? '';

  return /^(mac|iphone|ipad|ipod)/i.test(platform);
}

/** One editable host: a block's own content, or a single table cell. */
interface ResolvedTarget {
  readonly block: Block;
  readonly content: HTMLElement;
  readonly cell?: CellCoords;
}

/**
 * An open popover, described by the two questions anyone dismissing it asks.
 *
 * These are `role="dialog"` portals: they render outside the editor root and
 * take focus away from it, so nothing in the editor's own event path can tell
 * that the pointer landed elsewhere or that the caret is now in another block.
 * Both answers live behind this shape so no call site has to guess.
 */
interface AnchoredPopover {
  /** True when the popover was opened from that editing host. */
  ownedBy(blockId: string, cell: CellCoords | undefined): boolean;
  /** True when a node is inside the popover, so a gesture is not "outside". */
  contains(node: Node | null): boolean;
  close(restoreFocus: boolean): void;
}

/**
 * Which label announces each command once it has run.
 *
 * Separate from the button titles: a toolbar reads "Insert row above" as an
 * offer, a live region reads it after the fact and needs the past tense.
 */
type StringLabel = {
  [K in keyof NEditorLabels]: NEditorLabels[K] extends string ? K : never;
}[keyof NEditorLabels];

const TABLE_COMMAND_ANNOUNCEMENTS: Readonly<Record<TableCommand, StringLabel>> = {
  insertRowAbove: 'rowInsertedAbove',
  insertRowBelow: 'rowInsertedBelow',
  deleteRow: 'rowDeleted',
  insertColumnLeft: 'columnInsertedLeft',
  insertColumnRight: 'columnInsertedRight',
  deleteColumn: 'columnDeleted',
};

/** Applies a row or column command to a grid. */
function applyTableCommand(
  rows: TableRows,
  command: TableCommand,
  row: number,
  column: number,
): TableRows {
  switch (command) {
    case 'insertRowAbove':
      return tableInsertRow(rows, row);
    case 'insertRowBelow':
      return tableInsertRow(rows, row + 1);
    case 'deleteRow':
      return tableDeleteRow(rows, row);
    case 'insertColumnLeft':
      return tableInsertColumn(rows, column);
    case 'insertColumnRight':
      return tableInsertColumn(rows, column + 1);
    default:
      return tableDeleteColumn(rows, column);
  }
}

/**
 * True when a command handed back the grid it was given.
 *
 * `tableInsertRow` and `tableInsertColumn` refuse at their caps by returning a
 * copy of the rows and nothing else, so at the cap every cell is still the very
 * object it was. That is the only shape this has to catch, and identity per
 * cell — the comparison `sameBlocks` makes for blocks — catches it without
 * calling a delete that rebuilt an emptied row a no-op too.
 */
function sameRows(a: TableRows, b: TableRows): boolean {
  return (
    a.length === b.length &&
    a.every((row, index) => {
      const other = b[index];

      return (
        other !== undefined &&
        row.length === other.length &&
        row.every((cell, column) => cell === other[column])
      );
    })
  );
}

/** Reads the `row:column` a cell host carries, if it is one. */
function parseCellCoords(host: HTMLElement): CellCoords | undefined {
  const parts = host.dataset.cell?.split(':').map(Number);

  if (!parts || parts.length !== 2 || !parts.every(Number.isInteger)) {
    return undefined;
  }

  return { row: parts[0] ?? 0, column: parts[1] ?? 0 };
}

/**
 * Flattens blocks into one run of rich text, one line each.
 *
 * A table cell holds text rather than structure, so pasted blocks collapse into
 * it — but the marks and links come along, exactly as they do when a paragraph
 * is pasted into any other host.
 */
function richFromBlocks(blocks: readonly Block[]): RichText {
  const parts: RichText[] = [];

  for (const block of blocks) {
    if (parts.length > 0) {
      parts.push(richFromPlainText('\n'));
    }

    // A table keeps its text in `rows`, so it has no runs of its own to carry.
    parts.push(block.type === 'table' ? richFromPlainText(blockText(block)) : block.content);
  }

  return richConcat(...parts);
}

/** Formatting that applies to the current selection. */
export interface SelectionState {
  readonly blockId: string;
  readonly range: OffsetRange;
  readonly marks: readonly Mark[];
  readonly link: string | null;
  /**
   * Which table cell the selection is in, absent outside a table.
   *
   * `focusRange` takes this as its fourth argument and resolves a table without
   * it to the first cell, so leaving it out of the state made the documented
   * save/restore pair silently wrong inside a table: restoring put the caret in
   * the header and the next `toggleMark` formatted that cell instead.
   */
  readonly cell?: CellCoords;
}

export interface NEditorEvents {
  change: NEditorDocument;
  focus: { blockId: string };
  selection: SelectionState | null;
  history: HistoryState;
  /** Blocks selected as whole units. Empty when editing text. */
  blockselection: { ids: string[] };
}

/** Caret target meaning "the end of the block". */
const CARET_END = Number.POSITIVE_INFINITY;

/** Pointer travel before a handle press becomes a drag rather than a click. */
const DRAG_THRESHOLD_PX = 4;

/** How long a touch must rest on a block before it selects it. */
const LONG_PRESS_MS = 500;

/** How far a touch may drift and still count as a press rather than a drag. */
const LONG_PRESS_TOLERANCE_PX = 10;

/** Keys that deliberately reposition the caret, ending a typing run. */
const CARET_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/**
 * What a run of typing is scoped to: one editable host, not merely one block.
 *
 * A table is one block with a host per cell, so keying a run by block id alone
 * folds a correction in the last cell into the sentence typed in the first.
 */
function hostScope(id: string, cell?: CellCoords): string {
  return cell ? `${id}:${cell.row}:${cell.column}` : id;
}

/**
 * Groups a burst of same-kind input in one host into a single undo step.
 *
 * Typing folds with typing and deleting with deleting, but never across each
 * other, so typing a word and then correcting it stays two undo steps.
 */
function inputRunKey(event: Event, scope: string): string | null {
  const inputType = hasInputType(event) ? event.inputType : '';

  if (inputType.startsWith('insert')) {
    return `insert:${scope}`;
  }

  if (inputType.startsWith('delete')) {
    return `delete:${scope}`;
  }

  return null;
}

/**
 * True when this input event added text rather than removing or reformatting it.
 *
 * An event that does not say what it did is not taken to be a deletion: a
 * synthesized `input` and a realm without `InputEvent` both look like that, and
 * refusing them would silently disable the Markdown shortcuts for either.
 */
function isInsertion(event: Event): boolean {
  return !hasInputType(event) || event.inputType.startsWith('insert');
}

/**
 * Input types that would write markup the editor never parsed.
 *
 * A drop or a paste hands the browser a fragment authored somewhere else — an
 * `<iframe>`, a password form, a fixed overlay covering the page — and the
 * browser's default is to put it straight into a live editing host. Worse, it
 * then *persists*: `#syncFromDom` reads the host back as the block's own
 * content, so the model agrees with the DOM and no later render removes it.
 * Each of these has an editor-owned path that parses the payload instead, so
 * reaching `beforeinput` at all means something slipped past one of them.
 *
 * `insertReplacementText` is deliberately absent: that is the spellchecker
 * correcting a word, which is text the user's own document already held.
 */
const UNPARSED_INPUT_TYPES: ReadonlySet<string> = new Set([
  'insertFromDrop',
  'insertFromPaste',
  'insertFromPasteAsQuotation',
  'insertHTML',
]);

/** Single-letter shortcuts, all under the platform modifier. */
const MARK_SHORTCUTS: Readonly<Record<string, Mark>> = {
  b: 'bold',
  i: 'italic',
  u: 'underline',
  e: 'code',
};

/**
 * A Notion-like block editor.
 *
 * Plain DOM and plain classes: no framework, no virtual DOM, no runtime
 * dependencies. Mount it anywhere an `HTMLElement` exists.
 */
export class NEditor {
  readonly #root: HTMLElement;
  readonly #document: Document;
  /** The tree the floating UI is appended to, which is not always the body. */
  readonly #portalRoot: HTMLElement | ShadowRoot;
  readonly #renderer: Renderer;
  readonly #slashMenu: SlashMenu;
  readonly #toolbar: FormatToolbar;
  readonly #linkEditor: LinkEditor;
  readonly #emitter = new Emitter<NEditorEvents>();
  readonly #useToolbar: boolean;
  readonly #history: History;
  readonly #labels: NEditorLabels;
  readonly #gutter: Gutter;
  readonly #iconPicker: IconPicker;
  readonly #imageEditor: ImageEditor;
  readonly #tableToolbar: TableToolbar;
  readonly #dropIndicator: HTMLElement;
  readonly #liveRegion: HTMLElement;
  readonly #useGutter: boolean;

  /** True where Cmd is the shortcut modifier and Ctrl belongs to the system. */
  readonly #applePlatform: boolean;

  /** True when the editor supplied the root's accessible name and owes it back. */
  readonly #ownsAriaLabel: boolean;

  /** Whether the `role` that makes that name legal is ours to take away. */
  #ownsRole = false;

  #blocks: Block[];
  #editable: boolean;
  #destroyed = false;

  /** Where the active `/` query began, so it can be erased on commit. */
  #slashContext: { blockId: string; start: number } | null = null;

  /** The range the link popover is editing, held while focus is in its input. */
  #linkContext: {
    blockId: string;
    start: number;
    end: number;
    cell?: CellCoords;
  } | null = null;

  /**
   * Formatting armed at a collapsed caret.
   *
   * Pressing ⌘B with nothing selected cannot change any existing character, so
   * the intent is parked here and applied to the next typed run. It is tied to
   * an exact host and position: a table has one host per cell, so offset 0 of
   * the header cell and offset 0 of the cell below it are different places.
   */
  #pending: {
    blockId: string;
    offset: number;
    marks: Mark[];
    cell?: CellCoords;
  } | null = null;

  /**
   * The selection as it stood before the browser applied the current edit.
   *
   * Captured in `beforeinput`, which is the last moment the DOM still holds the
   * pre-edit state, so undo can put the caret back exactly where it was.
   */
  #selectionBeforeInput: SelectionSnapshot | null = null;

  /**
   * Blocks selected as whole units.
   *
   * Mutually exclusive with a text selection: entering block selection takes
   * the caret out of the document so keystrokes address blocks, not characters.
   */
  #selected = new Set<string>();

  /** The end of a block selection that stays put while shift-arrow extends it. */
  #selectionAnchor: string | null = null;

  #drag: {
    ids: Set<string>;
    pointerId: number;
    startY: number;
    active: boolean;
    gap: number;
  } | null = null;

  /** True between pointerdown and pointerup anywhere, so drag-select can settle. */
  #pointerDown = false;

  /**
   * True while the next handle click is the tail of a drag, not a click.
   *
   * Armed when a drag ends and consumed by the handle's click hook. A drag and
   * the click it produces are one gesture; only the drag is allowed to act.
   */
  #clickEndedDrag = false;

  /**
   * A resting touch that will become a block selection.
   *
   * Touch has no hover, so the gutter never appears and its controls are
   * unreachable. A long press is the conventional stand-in for "select this".
   */
  #longPress: { timer: number; blockId: string; x: number; y: number } | null = null;

  /**
   * True while an IME composition is in flight.
   *
   * Input rules and the slash menu must not fire on half-composed text — the
   * model is only read back once the candidate is committed.
   */
  #composing = false;

  /**
   * A text drag that may grow into a block selection.
   *
   * Each block is its own contenteditable, and a browser will not extend a
   * selection across editing hosts — so dragging from one block into the next
   * produces no cross-block range to react to. The gesture is tracked here and
   * turned into a block selection once the pointer leaves the block it started
   * in.
   */
  #textDrag: {
    anchorBlockId: string;
    pointerId: number;
    currentId: string | null;
  } | null = null;

  constructor(options: NEditorOptions) {
    const element =
      typeof options.element === 'string'
        ? globalThis.document?.querySelector<HTMLElement>(options.element)
        : options.element;

    if (!element) {
      // Only a selector can miss; a passed element is either valid or nullish.
      const target =
        typeof options.element === 'string'
          ? `selector "${options.element}"`
          : 'the element passed to `element`';

      throw new Error(`[neditor] Mount element not found: ${target}`);
    }

    this.#root = element;
    this.#document = element.ownerDocument;
    this.#editable = options.editable ?? true;
    this.#useToolbar = options.toolbar ?? true;
    this.#history = new History({ limit: options.historyLimit });
    this.#useGutter = options.dragHandles ?? true;
    this.#applePlatform = isApplePlatform(this.#document.defaultView);
    this.#labels = resolveLabels(options.labels);
    this.#blocks = normalizeDocument(options.doc ?? createEmptyDocument()).blocks;

    // Resolved before the styles, because the two can land in different trees:
    // the blocks live where the editor was mounted, the floating UI wherever
    // `portalContainer` says.
    this.#portalRoot = options.portalContainer ?? defaultPortalContainer(element);

    if (options.injectStyles ?? true) {
      // Resolved from the mount point, so an editor inside a shadow root gets
      // its styles in that tree rather than a document head it cannot see.
      injectStyles(element, options.styleNonce);
      // And again for the portals' tree. `injectStyles` is idempotent per root,
      // so this is a no-op in the ordinary case where they are the same tree.
      injectStyles(this.#portalRoot, options.styleNonce);
    }

    const theme = options.theme ?? 'auto';
    this.#root.classList.add('neditor');
    this.#root.dataset.neditorTheme = theme;

    // Remembered, because `destroy()` has to give the element back the way it
    // found it. An accessible name left behind is not inert residue: the next
    // mount sees a labelled element and stands down, so its own `label` — a
    // different document, a different language — is silently dropped for the
    // life of the page.
    this.#ownsAriaLabel =
      !this.#root.hasAttribute('aria-label') && !this.#root.hasAttribute('aria-labelledby');

    if (this.#ownsAriaLabel) {
      this.#root.setAttribute('aria-label', options.label ?? this.#labels.editor);

      // A bare <div> has the `generic` role, and ARIA 1.2 lists aria-label
      // among the properties *prohibited* on it: the name is discarded, so the
      // documented `label` option produced no accessible name at all. `group`
      // is the lightest role that permits naming and does not displace the
      // heading, list and table semantics the blocks inside carry -- the same
      // reason `role="textbox"` is refused on the block hosts.
      this.#ownsRole = !this.#root.hasAttribute('role');

      if (this.#ownsRole) {
        this.#root.setAttribute('role', 'group');
      }
    }
    // Block selection has no caret, so the root itself must hold focus for
    // keystrokes to reach the editor.
    this.#root.tabIndex = -1;

    this.#renderer = new Renderer(
      this.#root,
      {
        onToggleTodo: (id) => {
          this.toggleTodo(id);
        },
        onToggleCollapsed: (id) => {
          this.toggleCollapsed(id);
        },
        onPickIcon: (id, anchor) => {
          this.#openIconPicker(id, anchor);
        },
        onEditImage: (id, anchor) => {
          this.#openImageEditor(id, anchor);
        },
      },
      this.#labels,
    );

    this.#imageEditor = new ImageEditor(
      this.#document,
      {
        onApply: (value) => {
          this.#applyImage(value.src, value.alt);
        },
        onRemove: () => {
          this.#removeImage();
        },
        onCancel: () => {
          this.#closeImageEditor();
        },
      },
      this.#labels,
    );

    this.#tableToolbar = new TableToolbar(
      this.#document,
      {
        onCommand: (command) => {
          this.#runTableCommand(command);
        },
        onDismiss: () => {
          const active = this.#activeCell;

          if (active) {
            this.#focusCell(active.blockId, active.row, active.column, CARET_END);
          }
        },
      },
      this.#labels,
    );

    this.#iconPicker = new IconPicker(
      this.#document,
      {
        onSelect: (icon) => {
          this.#applyIcon(icon);
        },
        onDismiss: () => {
          this.#closeIconPicker();
        },
      },
      this.#labels,
    );

    this.#gutter = new Gutter(
      this.#document,
      {
        onAdd: (blockId) => {
          this.#addBlockAfter(blockId);
        },
        onSelect: (blockId, event) => {
          this.#selectFromHandle(blockId, event);
        },
        onDragStart: (blockId, event) => {
          this.#beginDrag(blockId, event);
        },
      },
      this.#labels,
    );

    this.#dropIndicator = this.#document.createElement('div');
    this.#dropIndicator.className = 'neditor-drop-indicator';
    this.#dropIndicator.hidden = true;
    this.#dropIndicator.setAttribute('aria-hidden', 'true');

    // Structural edits move blocks around without changing the caret, so they
    // are invisible to a screen reader unless they are announced.
    this.#liveRegion = this.#document.createElement('div');
    this.#liveRegion.className = 'neditor-live-region';
    this.#liveRegion.setAttribute('role', 'status');
    this.#liveRegion.setAttribute('aria-live', 'polite');
    this.#root.append(this.#liveRegion);

    if (this.#useGutter) {
      // Children of the root, not of a block: the renderer only reorders the
      // views it tracks, so these stay put.
      this.#root.append(this.#gutter.element, this.#dropIndicator);
    }

    this.#renderer.setEditable(this.#editable);

    this.#slashMenu = new SlashMenu(
      this.#document,
      {
        onSelect: (command) => {
          this.#applySlashCommand(command);
        },
        onDismiss: () => {
          this.#closeSlashMenu();
        },
        onActiveChange: () => {
          this.#describeSlashMenu();
        },
      },
      this.#labels,
    );

    this.#toolbar = new FormatToolbar(
      this.#document,
      {
        onToggleMark: (mark) => {
          this.toggleMark(mark);
        },
        onEditLink: () => {
          this.openLinkEditor();
        },
      },
      this.#labels,
    );

    this.#linkEditor = new LinkEditor(
      this.#document,
      {
        onApply: (href) => {
          this.#applyLink(href);
        },
        onRemove: () => {
          this.#applyLink(null);
        },
        onCancel: () => {
          this.#closeLinkEditor();
        },
      },
      this.#labels,
    );

    for (const portal of [
      this.#slashMenu,
      this.#toolbar,
      this.#linkEditor,
      this.#iconPicker,
      this.#imageEditor,
      this.#tableToolbar,
    ]) {
      portal.setTheme(theme);
      this.#portalRoot.append(portal.element);
    }

    if (options.onError) {
      this.#emitter.setErrorHandler(options.onError);
    }

    if (options.onChange) {
      this.#emitter.on('change', options.onChange);
    }

    this.#root.addEventListener('compositionstart', this.#handleCompositionStart);
    this.#root.addEventListener('compositionend', this.#handleCompositionEnd);
    this.#root.addEventListener('beforeinput', this.#handleBeforeInput);
    this.#root.addEventListener('input', this.#handleInput);
    this.#root.addEventListener('keydown', this.#handleKeyDown);
    this.#root.addEventListener('focusin', this.#handleFocusIn);
    this.#root.addEventListener('mousedown', this.#handleRootMouseDown);
    this.#root.addEventListener('click', this.#handleClick);
    this.#root.addEventListener('paste', this.#handlePaste);
    this.#root.addEventListener('copy', this.#handleCopy);
    this.#root.addEventListener('cut', this.#handleCopy);
    this.#root.addEventListener('drop', this.#handleDrop);
    this.#root.addEventListener('pointerdown', this.#handleRootPointerDown);
    this.#root.addEventListener('pointerover', this.#handlePointerOver);
    this.#root.addEventListener('pointerleave', this.#handlePointerLeave);
    this.#document.addEventListener('pointermove', this.#handlePointerMove);
    this.#document.addEventListener('pointerup', this.#handlePointerUp);
    this.#document.addEventListener('pointercancel', this.#handlePointerCancel);
    this.#document.addEventListener('pointerdown', this.#handleDocumentPointerDown);
    this.#document.addEventListener('keydown', this.#handleDocumentKeyDown, true);
    this.#document.addEventListener('selectionchange', this.#handleSelectionChange);

    this.#render();

    if (options.autofocus) {
      this.focus();
    }
  }

  /* ------------------------------------------------------------ public -- */

  get element(): HTMLElement {
    return this.#root;
  }

  get editable(): boolean {
    return this.#editable;
  }

  /** Returns a deep copy, so callers cannot mutate editor state by reference. */
  getDocument(): NEditorDocument {
    return cloneDocument({ blocks: this.#blocks });
  }

  /**
   * Replaces the content. This is a reset, not an edit: history is cleared, so
   * the user cannot undo past content they never saw.
   */
  setDocument(doc: NEditorDocument, options: { silent?: boolean } = {}): void {
    if (this.#destroyed) {
      return;
    }

    this.#blocks = normalizeDocument(doc).blocks;
    this.#pending = null;
    this.#clearBlockSelection();
    this.#history.clear();
    this.#render();

    // `silent` exists for the case where the caller already knows: piping a
    // remote document in and echoing `change` back out is an unbounded loop.
    if (!options.silent) {
      this.#emitChange();
    }

    this.#emitHistory();
  }

  get canUndo(): boolean {
    return this.#history.canUndo;
  }

  get canRedo(): boolean {
    return this.#history.canRedo;
  }

  /** Reverts the last edit. Returns false when there is nothing to undo. */
  undo(): boolean {
    return this.#travel('undo');
  }

  /** Reapplies the last undone edit. Returns false when there is nothing to redo. */
  redo(): boolean {
    return this.#travel('redo');
  }

  clearHistory(): void {
    this.#history.clear();
    this.#emitHistory();
  }

  getMarkdown(): string {
    return toMarkdown({ blocks: this.#blocks });
  }

  setEditable(editable: boolean): void {
    this.#editable = editable;
    this.#renderer.setEditable(editable);

    if (!editable) {
      this.#toolbar.hide();
      this.#hideTableToolbar();
      this.#closeLinkEditor();
      this.#closeImageEditor();
      this.#closeIconPicker();
      this.#gutter.hide();
      this.#clearBlockSelection();
    }

    this.#render();
  }

  on<K extends keyof NEditorEvents>(
    event: K,
    listener: (payload: NEditorEvents[K]) => void,
  ): () => void {
    return this.#emitter.on(event, listener);
  }

  off<K extends keyof NEditorEvents>(
    event: K,
    listener: (payload: NEditorEvents[K]) => void,
  ): void {
    this.#emitter.off(event, listener);
  }

  /** Formatting state of the current selection, or null when it is elsewhere. */
  getSelectionState(): SelectionState | null {
    const target = this.#selectionTarget();

    if (!target) {
      return null;
    }

    const { block, range } = target;
    const content = this.#contentOf(target);
    const marks =
      range.start === range.end
        ? // Copied, not aliased: this is the live armed-formatting array, and a
          // caller sorting or splicing it would silently rearm formatting.
          [...(this.#pending?.marks ?? richMarksAt(content, range.start))]
        : richActiveMarks(content, range.start, range.end);

    return {
      blockId: block.id,
      range,
      marks,
      link: richActiveLink(content, range.start, range.end),
      ...(target.cell ? { cell: target.cell } : {}),
    };
  }

  /**
   * Toggles a mark over the selection.
   *
   * With a collapsed caret the mark is armed instead, so ⌘B then typing
   * produces bold text — the behaviour every writing tool has.
   */
  toggleMark(mark: Mark): void {
    const target = this.#selectionTarget();

    if (!target || !this.#editable) {
      return;
    }

    const { block, range } = target;

    if (range.start === range.end) {
      const current = this.#pending?.marks ?? richMarksAt(this.#contentOf(target), range.start);
      const marks = current.includes(mark)
        ? current.filter((existing) => existing !== mark)
        : sortMarks([...current, mark]);

      this.#pending = {
        blockId: block.id,
        offset: range.start,
        marks,
        ...(target.cell ? { cell: target.cell } : {}),
      };
      this.#toolbar.update({ marks, link: null });
      this.#emitter.emit('selection', this.getSelectionState());
      return;
    }

    this.#commitResolved(
      target,
      richToggleMark(this.#contentOf(target), range.start, range.end, mark),
    );
    this.#focusResolved(target, range.start, range.end);
    this.#syncToolbar();
  }

  /** Sets or clears a link over the selection. Returns false for an unsafe URL. */
  setLink(href: string | null): boolean {
    const target = this.#selectionTarget();

    if (!target || !this.#editable || target.range.start === target.range.end) {
      return false;
    }

    const url = href === null ? null : sanitizeUrl(href);

    if (href !== null && url === null) {
      return false;
    }

    const { range } = target;
    this.#commitResolved(target, richSetLink(this.#contentOf(target), range.start, range.end, url));
    this.#focusResolved(target, range.start, range.end);
    this.#syncToolbar();
    return true;
  }

  /** Opens the link popover for the current selection. */
  openLinkEditor(): void {
    const target = this.#selectionTarget();

    if (!target || !this.#editable || target.range.start === target.range.end) {
      return;
    }

    const { range, content } = target;
    this.#linkContext = {
      blockId: target.block.id,
      start: range.start,
      end: range.end,
      ...(target.cell ? { cell: target.cell } : {}),
    };
    this.#toolbar.hide();

    this.#linkEditor.open(
      this.#selectionRect() ?? content.getBoundingClientRect(),
      richActiveLink(this.#contentOf(target), range.start, range.end),
    );
  }

  /**
   * Focuses a block, or the first editable one when no id is given.
   *
   * Returns false when there is nowhere to put a caret — an unknown id, a block
   * inside a collapsed toggle, or a void one such as a divider. Silence was the
   * bug: the caller went on believing the editor was back in text mode while it
   * was in neither, and the next keystroke reached nothing at all.
   */
  focus(id?: string, offset = 0): boolean {
    const target = id ?? this.#visible().find((block) => !isVoidType(block.type))?.id;

    if (!target) {
      return false;
    }

    const view = this.#renderer.getView(target);

    if (!view?.content) {
      return false;
    }

    // A caret and a block selection are the two modes, and they exclude each
    // other: entering one leaves the other. Both at once routed the next
    // printable key to the block selection, which replaced blocks the reader
    // could no longer see were selected.
    this.#clearBlockSelection();

    view.content.focus({ preventScroll: true });
    setCaretOffset(view.content, offset);
    this.#emitter.emit('focus', { blockId: target });

    return true;
  }

  /**
   * Selects a range within a block, or within one of its table cells.
   *
   * A table has one editable host per cell, so `cell` says which one the
   * offsets belong to. Without it a table resolves to its first cell — the same
   * place {@link focus} lands — which is only ever right for the header.
   *
   * Reports failure the same way {@link focus} does, and leaves block selection
   * for the same reason.
   */
  focusRange(id: string, start: number, end: number, cell?: CellCoords): boolean {
    const host = this.#hostFor(id, cell);

    if (!host) {
      return false;
    }

    this.#clearBlockSelection();

    host.focus({ preventScroll: true });
    setSelectionRange(host, start, end);

    return true;
  }

  /** Converts a block to another type, the same edit the slash menu performs. */
  setBlockType(id: string, type: BlockType): void {
    // Every other public mutator asks this; this one did not, so a host that
    // kept a block-type control wired across an edit/preview toggle rewrote a
    // read-only document and fired `change` for it.
    if (!this.#canEdit()) {
      return;
    }

    this.#commit(setBlockType(this.#blocks, id, type));
    this.focus(id, CARET_END);
    this.#announce(formatLabel(this.#labels.changedTo, { type: this.#typeName(type) }));
  }

  /**
   * The reader-facing name of a block type.
   *
   * `BlockType` is an internal identifier, so substituting it into a translated
   * sentence announced half of it in English — "Changé en bulleted list" — no
   * matter how completely the host overrode `labels`. The slash menu already
   * carries a localisable name for every type, and it is the very name the user
   * picked from; the id, tidied up, survives only as a fallback for a label set
   * that dropped an entry.
   */
  #typeName(type: BlockType): string {
    return this.#labels.slashCommands[type]?.label ?? type.replaceAll('_', ' ');
  }

  /** Expands or collapses a toggle, hiding or revealing everything under it. */
  toggleCollapsed(id: string): void {
    const block = findBlock(this.#blocks, id);

    if (!block || block.type !== 'toggle' || !this.#canEdit()) {
      return;
    }

    const focused = this.#renderer.blockIdFromNode(this.#document.activeElement);
    const collapsed = block.collapsed !== true;
    this.#commit(updateBlock(this.#blocks, id, { collapsed }));
    this.#announce(collapsed ? this.#labels.toggleCollapsed : this.#labels.toggleExpanded);

    // Collapsing can hide the block the caret was in; catch it before it is lost.
    if (!focused || !this.#renderer.getView(focused)) {
      this.focus(id, CARET_END);
    }
  }

  /** Sets a callout's icon. Only the first character a reader sees is kept. */
  setCalloutIcon(id: string, icon: string): void {
    const block = findBlock(this.#blocks, id);
    const first = firstGrapheme(icon);

    if (!block || block.type !== 'callout' || first === undefined || !this.#canEdit()) {
      return;
    }

    this.#commit(updateBlock(this.#blocks, id, { icon: first }));
  }

  toggleTodo(id: string): void {
    const block = findBlock(this.#blocks, id);

    if (!block || block.type !== 'todo' || !this.#canEdit()) {
      return;
    }

    this.#commit(updateBlock(this.#blocks, id, { checked: !block.checked }));
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }

    this.#destroyed = true;
    this.#root.removeEventListener('compositionstart', this.#handleCompositionStart);
    this.#root.removeEventListener('compositionend', this.#handleCompositionEnd);
    this.#root.removeEventListener('beforeinput', this.#handleBeforeInput);
    this.#root.removeEventListener('input', this.#handleInput);
    this.#root.removeEventListener('keydown', this.#handleKeyDown);
    this.#root.removeEventListener('focusin', this.#handleFocusIn);
    this.#root.removeEventListener('mousedown', this.#handleRootMouseDown);
    this.#root.removeEventListener('click', this.#handleClick);
    this.#root.removeEventListener('paste', this.#handlePaste);
    this.#root.removeEventListener('copy', this.#handleCopy);
    this.#root.removeEventListener('cut', this.#handleCopy);
    this.#root.removeEventListener('drop', this.#handleDrop);
    this.#root.removeEventListener('pointerdown', this.#handleRootPointerDown);
    this.#root.removeEventListener('pointerover', this.#handlePointerOver);
    this.#root.removeEventListener('pointerleave', this.#handlePointerLeave);
    this.#document.removeEventListener('pointermove', this.#handlePointerMove);
    this.#document.removeEventListener('pointerup', this.#handlePointerUp);
    this.#document.removeEventListener('pointercancel', this.#handlePointerCancel);
    this.#document.removeEventListener('pointerdown', this.#handleDocumentPointerDown);
    this.#document.removeEventListener('keydown', this.#handleDocumentKeyDown, true);
    this.#document.removeEventListener('selectionchange', this.#handleSelectionChange);

    this.#cancelLongPress();
    this.#slashMenu.destroy();
    this.#toolbar.destroy();
    this.#linkEditor.destroy();
    this.#gutter.destroy();
    this.#liveRegion.remove();
    this.#iconPicker.destroy();
    this.#imageEditor.destroy();
    this.#tableToolbar.destroy();
    this.#dropIndicator.remove();
    this.#renderer.destroy();
    this.#emitter.clear();
    this.#root.classList.remove('neditor');

    // Gesture state, not decoration. Both are set mid-drag and cleared on
    // `pointerup`/`pointercancel`, so an editor destroyed while a finger is
    // still down leaves them on the element — and they carry `user-select:
    // none` for every block. Dead until something re-adds the `neditor` class,
    // which a remount into the same element does immediately: the new editor
    // comes up with its text unselectable and no gesture in flight to end.
    delete this.#root.dataset.selecting;
    delete this.#root.dataset.dragging;

    // Only the name this editor put there. An application's own aria-label was
    // never ours to remove.
    if (this.#ownsAriaLabel) {
      this.#root.removeAttribute('aria-label');
    }

    if (this.#ownsRole) {
      this.#root.removeAttribute('role');
    }
  }

  /* ------------------------------------------------------------ internal -- */

  /**
   * True when a public entry point may still change the document.
   *
   * Two different reasons say no, and every mutating control owes both an
   * answer. A read-only view must not be edited by the controls the renderer
   * still draws — the to-do checkbox and the toggle chevron are focusable
   * precisely so a keyboard reader can reach them, and reaching one is not
   * permission to write: `editable: false` is the contract that this document
   * does not change, and a `change` event a persistence layer writes back is
   * the reader's copy overwriting the author's.
   *
   * A destroyed editor says no for the other reason: it has no listeners, no
   * styles and no views left, so an edit would rebuild DOM that nothing can
   * take away again.
   */
  #canEdit(): boolean {
    return this.#editable && !this.#destroyed;
  }

  #render(): void {
    // `destroy()` is final. Rendering after it puts contenteditable hosts back
    // into a root that has had every listener removed and its `neditor` class
    // taken off, and the second `destroy()` returns early — so nothing could
    // ever remove them. This is the one place views are built, so it is the
    // one place that has to refuse.
    if (this.#destroyed) {
      return;
    }

    // A collapsed toggle's children are not in the document the reader sees.
    this.#renderer.render(this.#visible());

    // The renderer positions block views against the root's children, so the
    // live region is kept last rather than left where it was appended.
    this.#root.append(this.#liveRegion);
  }

  /** Applies a new block array, re-renders, and notifies listeners. */
  /** The blocks a reader can see: everything not inside a collapsed toggle. */
  #visible(): Block[] {
    return visibleBlocks(this.#blocks);
  }

  #applyBlocks(blocks: Block[]): void {
    this.#blocks = blocks;
    this.#render();
    this.#pruneBlockSelection();
    this.#refreshGutter();
    this.#emitChange();
  }

  /** Drops selected ids the new document no longer shows. */
  #pruneBlockSelection(): void {
    if (this.#selected.size === 0) {
      return;
    }

    // Visible rather than merely alive: an edit that collapsed a toggle over
    // these blocks has taken them off screen, and the selection may only ever
    // hold anchors the reader can see.
    const alive = new Set(this.#visible().map((block) => block.id));
    const kept = [...this.#selected].filter((id) => alive.has(id));

    if (kept.length === this.#selected.size) {
      return;
    }

    this.#selected = new Set(kept);

    // The anchor is part of the selection, so it is pruned with it. A dead one
    // is worse than none at all: `blockIdRange` answers [] for an id the
    // document no longer holds, so the next Shift+click extended from nowhere
    // and *cleared* the selection instead of growing it. Nothing downstream
    // repairs it either — the `#clearBlockSelection` that follows a delete
    // returns early on the empty set this has just left behind.
    if (this.#selectionAnchor !== null && !alive.has(this.#selectionAnchor)) {
      this.#selectionAnchor = kept[0] ?? null;
    }

    this.#renderer.setSelected(this.#selected);
    this.#emitter.emit('blockselection', { ids: kept });
  }

  /** Keeps the gutter pointing at its block after the layout moves. */
  #refreshGutter(): void {
    const id = this.#gutter.blockId;

    if (!id) {
      return;
    }

    if (findBlock(this.#blocks, id)) {
      this.#positionGutter(id);
    } else {
      this.#gutter.hide();
    }
  }

  /**
   * Applies a new block array as a single undoable edit.
   *
   * This is the *only* recorder on the structural path. A caller that wants its
   * edit keyed or wants undo to restore a particular selection passes them here
   * rather than calling `#recordHistory` itself: recording and then committing
   * pushes the same snapshot twice, and two identical entries make the first
   * Ctrl+Z look broken — it restores a document the user is already looking at.
   *
   * A commit that changes nothing is not an edit and records nothing. The pure
   * operations hand back a fresh array either way, so without this test an arrow
   * at the edge of the document cost a full history entry and a `change` event;
   * held down, auto-repeat evicted the real undo stack within seconds and an
   * autosave listener wrote an identical revision each time.
   */
  #commit(
    blocks: Block[],
    runKey: string | null = null,
    selection?: SelectionSnapshot | null,
  ): void {
    if (sameBlocks(this.#blocks, blocks)) {
      return;
    }

    this.#recordHistory(runKey, selection);
    this.#applyBlocks(blocks);
  }

  /**
   * Snapshots the state *before* an edit.
   *
   * `runKey` folds a burst of related edits — a run of typing in one block —
   * into one undo step; null forces the edit to stand alone.
   */
  #recordHistory(runKey: string | null = null, selection?: SelectionSnapshot | null): void {
    this.#history.record(
      { blocks: this.#blocks, selection: selection ?? this.#selectionSnapshot() },
      runKey,
    );
    this.#emitHistory();
  }

  #emitHistory(): void {
    this.#emitter.emit('history', this.#history.state);
  }

  #selectionSnapshot(): SelectionSnapshot | null {
    const target = this.#selectionTarget();

    if (!target) {
      return null;
    }

    return {
      blockId: target.block.id,
      start: target.range.start,
      end: target.range.end,
      ...(target.cell ? { cell: target.cell } : {}),
    };
  }

  #travel(direction: 'undo' | 'redo'): boolean {
    if (!this.#editable) {
      return false;
    }

    const current: HistoryEntry = {
      blocks: this.#blocks,
      selection: this.#selectionSnapshot(),
    };

    const entry = direction === 'undo' ? this.#history.undo(current) : this.#history.redo(current);

    if (!entry) {
      return false;
    }

    // Transient UI describes the pre-undo document; none of it survives.
    this.#pending = null;
    this.#closeSlashMenu();
    this.#linkContext = null;
    this.#linkEditor.close();
    this.#closeImageEditor();
    this.#toolbar.hide();
    this.#hideTableToolbar();
    this.#clearBlockSelection();

    this.#applyBlocks(entry.blocks);
    this.#restoreSelection(entry.selection);
    this.#emitHistory();
    this.#announce(direction === 'undo' ? this.#labels.undone : this.#labels.redone);

    return true;
  }

  /* ---------------------------------------------------- block selection -- */

  /** Ids of the blocks selected as units, in document order. */
  getSelectedBlocks(): string[] {
    return this.#orderedSelection();
  }

  /** Selects whole blocks. Pass an empty list to return to text editing. */
  selectBlocks(ids: readonly string[]): void {
    this.#setBlockSelection(ids);
  }

  /** Leaves block selection, handing the caret back to the text. */
  clearBlockSelection(): void {
    this.#setBlockSelection([]);
  }

  #orderedSelection(): string[] {
    return this.#blocks.filter((block) => this.#selected.has(block.id)).map((block) => block.id);
  }

  /**
   * The blocks an edit has to touch.
   *
   * The selection itself holds only what the reader can see; a collapsed toggle
   * in it stands for everything nested under it. Structural edits expand here,
   * at the moment they run, rather than carrying invisible ids around in the
   * selection where every later index lookup misses them.
   */
  #selectionForEdit(): Set<string> {
    return withHiddenDescendants(this.#blocks, this.#selected);
  }

  /**
   * Enters (or updates) block selection.
   *
   * `takeFocus` is false only while a drag-select is still in progress, where
   * clearing the DOM selection would abort the very gesture that is building
   * this selection.
   */
  #setBlockSelection(
    ids: readonly string[],
    anchorId?: string,
    options: { takeFocus?: boolean } = {},
  ): void {
    // Selection anchors live in visible space. A block inside a collapsed
    // toggle is not something the reader can point at, and an invisible id in
    // this set poisons every `findBlockIndex(visible, …)` downstream — that is
    // how an arrow key off a collapsed toggle used to teleport to block zero.
    // The hidden children are pulled back in by #selectionForEdit.
    const visible = new Set(this.#visible().map((block) => block.id));
    const anchors = [...new Set(ids)].filter((id) => visible.has(id));

    if (anchors.length === 0) {
      const previous = this.#orderedSelection();

      // Nothing was selected and nothing will be: this is not an exit from
      // anywhere, so leave the caret — or the deliberate lack of one — alone.
      if (previous.length === 0) {
        return;
      }

      // An empty selection is not a mode. Deselecting the last block leaves
      // block selection outright rather than holding the root focused with
      // nothing selected and no caret, which is neither mode and swallows
      // every key.
      this.#clearBlockSelection();
      this.#announceSelectionCount(0);
      this.#focusFirst([anchorId, ...previous]);
      return;
    }

    this.#selected = new Set(anchors);
    this.#selectionAnchor =
      anchorId !== undefined && visible.has(anchorId) ? anchorId : (anchors[0] ?? null);
    this.#renderer.setSelected(this.#selected);

    this.#pending = null;
    this.#toolbar.hide();
    this.#hideTableToolbar();
    this.#closeSlashMenu();

    if (options.takeFocus ?? true) {
      // Blocks, not characters, are the subject now: drop the caret and let the
      // root take the keystrokes.
      this.#selection()?.removeAllRanges();
      this.#root.focus({ preventScroll: true });
    }

    this.#emitter.emit('blockselection', { ids: [...this.#selected] });
    this.#announceSelectionCount(this.#selected.size);
  }

  /**
   * Announces how many blocks are selected.
   *
   * Zero is its own sentence. Reading it as the plural announced "0 blocks
   * selected", which describes a mode the editor is not supposed to have.
   */
  #announceSelectionCount(count: number): void {
    this.#announce(
      pluralLabel(
        {
          zero: this.#labels.noBlocksSelected,
          one: this.#labels.blockSelected,
          other: this.#labels.blocksSelected,
        },
        count,
      ),
    );
  }

  #clearBlockSelection(): void {
    if (this.#selected.size === 0) {
      return;
    }

    this.#selected = new Set();
    this.#selectionAnchor = null;
    this.#renderer.setSelected(this.#selected);
    this.#emitter.emit('blockselection', { ids: [] });
  }

  /**
   * Leaves block selection, putting the caret back into a block.
   *
   * Every selected block is a candidate, not just the one asked for: a
   * selection can end on a block that has no caret to give — a divider, an
   * image — and a single blind `focus()` there left neither a caret nor a
   * selection. If none of them can hold one, the selection stays. Being in one
   * mode beats being in neither.
   */
  #exitBlockSelection(blockId?: string, offset = 0): void {
    const ordered = this.#orderedSelection();

    this.#focusFirst(
      [blockId, ...(offset === CARET_END ? [...ordered].reverse() : ordered)],
      offset,
    );
  }

  /** Puts the caret in the first of `ids` that can take one. */
  #focusFirst(ids: readonly (string | undefined)[], offset = 0): boolean {
    for (const id of ids) {
      if (id !== undefined && this.focus(id, offset)) {
        return true;
      }
    }

    return false;
  }

  /** Handle click: plain selects, shift extends, modifier toggles. */
  #selectFromHandle(blockId: string, event: MouseEvent): void {
    // The drag took pointer capture on the handle, which retargets the
    // compatibility click that follows `pointerup` to it — so a drag ends by
    // firing this hook as if the handle had merely been clicked, and the
    // selection the user dragged collapses to the one block they grabbed.
    // The flag is armed by the drag and consumed here, so exactly one click is
    // swallowed and a press that never became a drag still selects.
    if (this.#clickEndedDrag) {
      this.#clickEndedDrag = false;
      return;
    }

    if (event.shiftKey && this.#selectionAnchor) {
      this.#setBlockSelection(
        blockIdRange(this.#blocks, this.#selectionAnchor, blockId),
        this.#selectionAnchor,
      );
      return;
    }

    if (event.metaKey || event.ctrlKey) {
      const next = new Set(this.#selected);

      if (next.has(blockId)) {
        next.delete(blockId);
      } else {
        next.add(blockId);
      }

      this.#setBlockSelection([...next], blockId);
      return;
    }

    this.#setBlockSelection([blockId], blockId);
  }

  #addBlockAfter(blockId: string): void {
    if (!this.#editable) {
      return;
    }

    const source = findBlock(this.#blocks, blockId);
    const created = createBlock('paragraph', [], source?.depth ?? 0);

    this.#clearBlockSelection();
    this.#commit(insertBlockAfter(this.#blocks, blockId, created));
    this.focus(created.id, 0);
  }

  #deleteSelectedBlocks(): void {
    const ordered = this.#orderedSelection();
    const firstId = ordered[0];

    if (!firstId) {
      return;
    }

    const index = findBlockIndex(this.#blocks, firstId);
    const next = removeBlocks(this.#blocks, this.#selectionForEdit());

    this.#commit(next);
    this.#clearBlockSelection();
    this.#announce(
      ordered.length === 1
        ? this.#labels.blockDeleted
        : formatLabel(this.#labels.blocksDeleted, { count: ordered.length }),
    );

    // The caret lands on whatever moved up into the gap.
    const target = next[Math.min(index, next.length - 1)];

    if (target) {
      this.focus(target.id, index < next.length ? 0 : CARET_END);
    }
  }

  #duplicateSelectedBlocks(): void {
    const result = duplicateBlocks(this.#blocks, this.#selectionForEdit());

    if (result.ids.length === 0) {
      return;
    }

    this.#commit(result.blocks);
    this.#setBlockSelection(result.ids);
  }

  /** Replaces the selected blocks with a fresh paragraph holding `char`. */
  #replaceSelectionWithText(char: string): void {
    const firstId = this.#orderedSelection()[0];

    if (!firstId) {
      return;
    }

    const index = findBlockIndex(this.#blocks, firstId);
    const created = createBlock('paragraph', char, this.#blocks[index]?.depth ?? 0);
    const removing = this.#selectionForEdit();
    const kept = this.#blocks.filter((block) => !removing.has(block.id));

    this.#commit(normalizeDepths(insertBlockAt(kept, index, created)));
    this.#clearBlockSelection();
    this.focus(created.id, CARET_END);
  }

  #moveSelectedBlocks(direction: 1 | -1): void {
    this.#moveVisible(this.#selected, direction);
  }

  /**
   * Moves blocks one visible slot.
   *
   * One slot as the reader sees it: what moves carries the children it hides,
   * and it steps clear over a collapsed toggle rather than into the gap between
   * that toggle and its own children, where the next depth clamp adopts it.
   */
  #moveVisible(ids: ReadonlySet<string>, direction: 1 | -1): void {
    // A move against the edge of the document comes back unchanged, and `#commit`
    // drops it — the same test that keeps a drag dropped into its own gap, or any
    // other op that hands back a fresh copy of what it was given, off the stack.
    this.#commit(moveVisibleBlocks(this.#blocks, ids, direction));
  }

  #stepBlockSelection(direction: 1 | -1): void {
    const visible = this.#visible();
    const edges = this.#selectedVisibleIndices(visible);
    const edge = direction === -1 ? edges[0] : edges.at(-1);

    if (edge === undefined) {
      return;
    }

    const target = visible[edge + direction];

    if (target) {
      this.#setBlockSelection([target.id], target.id);
    }
  }

  #extendBlockSelection(direction: 1 | -1): void {
    const visible = this.#visible();
    const edges = this.#selectedVisibleIndices(visible);
    const first = edges[0];
    const last = edges.at(-1);

    if (first === undefined || last === undefined) {
      return;
    }

    const anchorId = this.#selectionAnchor ?? visible[first]?.id;

    // The moving edge is whichever end is not the anchor.
    const target = visible[(visible[first]?.id === anchorId ? last : first) + direction];

    if (anchorId && target) {
      this.#setBlockSelection(blockIdRange(this.#blocks, anchorId, target.id), anchorId);
    }
  }

  /**
   * Where the selected blocks sit in the *visible* list.
   *
   * Positions rather than ids, so a step can never be taken by looking an id up
   * in a list it does not belong to: `findBlockIndex` answers -1 for a block it
   * cannot see, and `visible[-1 + 1]` is the first block of the document — the
   * teleport that made an arrow key on a collapsed toggle jump to the top.
   */
  #selectedVisibleIndices(visible: readonly Block[]): number[] {
    return visible.flatMap((block, index) => (this.#selected.has(block.id) ? [index] : []));
  }

  #handleBlockSelectionKeys(event: KeyboardEvent): void {
    const modifier = this.#shortcutModifier(event);
    const ordered = this.#orderedSelection();

    if (event.key === 'Escape') {
      event.preventDefault();

      // Escape from text selects the block; a second Escape leaves the editor.
      // That pair is the documented way out for a keyboard user, alongside
      // Shift+Tab at depth 0.
      this.#clearBlockSelection();
      this.#root.blur();
      this.#announce(this.#labels.leftEditor);
      return;
    }

    if (modifier) {
      const key = event.key.toLowerCase();

      if (key === 'a') {
        event.preventDefault();
        this.#setBlockSelection(this.#blocks.map((block) => block.id));
        return;
      }

      if (key === 'z') {
        event.preventDefault();

        if (event.shiftKey) {
          this.redo();
        } else {
          this.undo();
        }

        return;
      }

      if (key === 'y' && !event.shiftKey) {
        event.preventDefault();
        this.redo();
        return;
      }
    }

    if (!this.#editable) {
      return;
    }

    if (modifier && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      this.#duplicateSelectedBlocks();
      return;
    }

    switch (event.key) {
      case 'Enter':
        event.preventDefault();
        this.#exitBlockSelection(ordered.at(-1), CARET_END);
        return;

      case 'Backspace':
      case 'Delete':
        event.preventDefault();
        this.#deleteSelectedBlocks();
        return;

      case 'Tab': {
        const indented = indentBlocks(
          this.#blocks,
          this.#selectionForEdit(),
          event.shiftKey ? -1 : 1,
        );

        // Same escape as in text mode: a Tab that changes nothing moves focus.
        if (indented.every((next, index) => next.depth === this.#blocks[index]?.depth)) {
          return;
        }

        event.preventDefault();
        this.#commit(indented);
        return;
      }

      case 'ArrowUp':
      case 'ArrowDown': {
        event.preventDefault();
        const direction = event.key === 'ArrowUp' ? -1 : 1;

        if (modifier && event.shiftKey) {
          this.#moveSelectedBlocks(direction);
        } else if (event.shiftKey) {
          this.#extendBlockSelection(direction);
        } else {
          this.#stepBlockSelection(direction);
        }

        return;
      }

      default:
    }

    // Typing over a block selection replaces it, as in any list UI.
    if (!modifier && !event.altKey && event.key.length === 1) {
      event.preventDefault();
      this.#replaceSelectionWithText(event.key);
    }
  }

  /* ------------------------------------------------------------ images -- */

  #imageContext: string | null = null;

  #openImageEditor(id: string, anchor: HTMLElement): void {
    if (!this.#editable) {
      return;
    }

    const block = findBlock(this.#blocks, id);

    if (!block || block.type !== 'image') {
      return;
    }

    this.#imageContext = id;
    this.#toolbar.hide();
    this.#tableToolbar.hide();
    this.#imageEditor.open(anchor.getBoundingClientRect(), {
      src: block.src ?? '',
      alt: block.alt ?? '',
    });
  }

  #applyImage(src: string, alt: string): void {
    const id = this.#imageContext;
    const url = sanitizeImageUrl(src);

    if (!id) {
      this.#closeImageEditor();
      return;
    }

    if (!url) {
      this.#imageEditor.markInvalid();
      return;
    }

    this.#closeImageEditor();
    this.#commit(updateBlock(this.#blocks, id, { src: url, alt }));
    this.focus(id, CARET_END);
  }

  /** Removing the picture leaves an empty paragraph, not a hole. */
  #removeImage(): void {
    const id = this.#imageContext;
    this.#closeImageEditor();

    if (!id) {
      return;
    }

    this.#commit(setBlockType(this.#blocks, id, 'paragraph'));
    this.focus(id, 0);
  }

  #closeImageEditor(restoreFocus = true): void {
    const id = this.#imageContext;

    this.#imageEditor.close();
    this.#imageContext = null;

    // A pointer that dismissed the popover from outside is placing focus
    // itself; handing the caret back to the block would fight it.
    if (id && restoreFocus) {
      this.focus(id, CARET_END);
    }
  }

  /* ------------------------------------------------------------ tables -- */

  #activeCell: { blockId: string; row: number; column: number } | null = null;

  /** Shows the row and column controls whenever the caret is inside a table. */
  #syncTableToolbar(): void {
    const target = this.#selectionTarget();

    if (
      !target?.cell ||
      !this.#editable ||
      this.#selected.size > 0 ||
      this.#toolbar.isOpen ||
      this.#imageEditor.isOpen
    ) {
      this.#tableToolbar.hide();
      this.#activeCell = null;
      return;
    }

    const view = this.#renderer.getView(target.block.id);

    if (!view) {
      this.#tableToolbar.hide();
      return;
    }

    this.#activeCell = { blockId: target.block.id, ...target.cell };
    this.#tableToolbar.show(view.root.getBoundingClientRect());
  }

  #runTableCommand(command: TableCommand): void {
    const active = this.#activeCell;

    if (!active || !this.#editable) {
      return;
    }

    const block = findBlock(this.#blocks, active.blockId);
    const rows = block?.rows;

    if (!block || !rows) {
      return;
    }

    const next = applyTableCommand(rows, command, active.row, active.column);

    // An insert refused at its cap comes back with the grid untouched. Commit
    // that and the button banks an undo entry for a document that never
    // changed, while the live region tells a screen-reader user a row is there
    // that is not. The caret still goes home, so the toolbar keeps its promise
    // to hand editing back to the cell it was invoked from.
    if (!sameRows(rows, next)) {
      this.#commit(updateBlock(this.#blocks, block.id, { rows: next }));
      this.#announce(this.#labels[TABLE_COMMAND_ANNOUNCEMENTS[command]]);
    }

    // The grid may have shrunk under the caret, so clamp before restoring it.
    const size = tableSize(next);
    const row = Math.min(active.row, size.rows - 1);
    const column = Math.min(active.column, size.columns - 1);
    this.#focusCell(block.id, row, column, CARET_END);
  }

  /**
   * Table-specific keys. Returns true when the table consumed the event.
   *
   * A cell is a single paragraph, so Enter breaks the line rather than the
   * block, and Tab walks the grid in reading order.
   */
  #handleTableKeys(event: KeyboardEvent, target: ResolvedTarget): boolean {
    const cell = target.cell;
    const rows = target.block.rows;

    if (!cell || !rows) {
      return false;
    }

    switch (event.key) {
      case 'F10':
        event.preventDefault();
        // Taken from the event, not from #activeCell: that is set by the
        // selection sync, which has not necessarily run for a cell the user
        // reached with the keyboard alone.
        this.#activeCell = { blockId: target.block.id, row: cell.row, column: cell.column };
        this.#tableToolbar.focusFirst();
        return true;

      case 'Tab': {
        const next = tableStep(rows, cell.row, cell.column, event.shiftKey ? -1 : 1);

        if (next) {
          event.preventDefault();
          this.#focusCell(target.block.id, next.row, next.column, 0, CARET_END);
          return true;
        }

        // Shift+Tab out of the first cell releases focus rather than trapping
        // it; Tab past the last cell grows the table, as a spreadsheet does.
        //
        // Released by handling the key and declining to act on it, NOT by
        // returning false: false falls through to the block-level Tab handler,
        // which indents the block the caret is in — so releasing this way
        // silently indented the whole table and threw the caret to cell 0:0,
        // which for a 1000-row grid is 999 rows from where the user was.
        if (event.shiftKey) {
          return true;
        }

        const grown = tableInsertRow(rows, rows.length);

        // At MAX_TABLE_ROWS the grid comes back unchanged, and swallowing Tab
        // anyway made the last cell a keyboard trap that lied about it: an undo
        // entry for nothing, "row added" announced, and then a focus call for a
        // row that was never created. There is nowhere left to move inside the
        // table, so the key goes to the browser, which moves focus out.
        if (sameRows(rows, grown)) {
          return true;
        }

        event.preventDefault();
        this.#commit(updateBlock(this.#blocks, target.block.id, { rows: grown }));
        this.#focusCell(target.block.id, grown.length - 1, 0, 0);
        this.#announce(this.#labels.rowAdded);
        return true;
      }

      case 'Enter': {
        event.preventDefault();
        const range = getSelectionRange(target.content) ?? { start: 0, end: 0 };
        const current = this.#contentOf(target);
        const trimmed = richDelete(current, range.start, range.end);

        this.#commitResolved(
          target,
          richInsert(
            trimmed,
            range.start,
            richFromPlainText('\n', richMarksAt(trimmed, range.start)),
          ),
        );
        this.#focusResolved(target, range.start + 1);
        return true;
      }

      case 'Backspace':
        // There is no previous block to merge a cell into.
        if (isCaretAtStart(target.content)) {
          event.preventDefault();
          return true;
        }

        return false;

      case 'Delete':
        // Nor a next block to pull into it; without this the table itself is
        // passed to #deleteAtEnd as the block being edited.
        if (isCaretAtEnd(target.content)) {
          event.preventDefault();
          return true;
        }

        return false;

      case 'ArrowUp':
      case 'ArrowDown': {
        const direction = event.key === 'ArrowUp' ? -1 : 1;
        const atEdge =
          direction === -1 ? isCaretAtStart(target.content) : isCaretAtEnd(target.content);

        if (!atEdge || !rows[cell.row + direction]) {
          // Past the first or last row, fall through and leave the table.
          return false;
        }

        event.preventDefault();
        this.#focusCell(target.block.id, cell.row + direction, cell.column, CARET_END);
        return true;
      }

      default:
        return false;
    }
  }

  /* ---------------------------------------------------------- callouts -- */

  #iconContext: string | null = null;

  #openIconPicker(id: string, anchor: HTMLElement): void {
    if (!this.#editable) {
      return;
    }

    const block = findBlock(this.#blocks, id);

    if (!block || block.type !== 'callout') {
      return;
    }

    this.#iconContext = id;
    this.#toolbar.hide();
    this.#iconPicker.open(anchor.getBoundingClientRect(), block.icon ?? DEFAULT_CALLOUT_ICON);
  }

  #applyIcon(icon: string): void {
    const id = this.#iconContext;
    this.#closeIconPicker();

    if (id) {
      this.setCalloutIcon(id, icon);
      this.focus(id, CARET_END);
    }
  }

  #closeIconPicker(restoreFocus = true): void {
    const id = this.#iconContext;

    this.#iconPicker.close();
    this.#iconContext = null;

    // The picker took focus on open; hiding it would otherwise leave focus on
    // document.body and lose the user's place. The exception is a dismissal
    // from outside, where the pointer is already choosing where focus goes.
    if (id && restoreFocus) {
      this.focus(id, CARET_END);
    }
  }

  /* ------------------------------------------------------------ clipboard -- */

  #handleCopy = (event: ClipboardEvent): void => {
    if (this.#selected.size === 0 || !event.clipboardData) {
      return;
    }

    event.preventDefault();

    const doc = sliceDocument(this.#blocks, this.#selectionForEdit());
    event.clipboardData.setData('text/plain', toMarkdown(doc));
    event.clipboardData.setData('text/html', blocksToHtml(this.#document, doc.blocks));

    if (event.type === 'cut' && this.#editable) {
      this.#deleteSelectedBlocks();
    }
  };

  /* ----------------------------------------------------- gutter and drag -- */

  #handlePointerOver = (event: PointerEvent): void => {
    // Touch is handled on pointerdown; a synthesised hover would immediately
    // retarget the gutter away from the block the finger is on.
    if (!this.#useGutter || this.#drag || !this.#editable || event.pointerType === 'touch') {
      return;
    }

    const node = isNode(event.target) ? event.target : null;

    // Moving onto the controls themselves must not retarget them.
    if (this.#gutter.contains(node)) {
      return;
    }

    const id = this.#renderer.blockIdFromNode(node);

    if (id) {
      this.#positionGutter(id);
    } else {
      this.#gutter.hide();
    }
  };

  #handlePointerLeave = (event: PointerEvent): void => {
    // Only hover retracts the gutter. A touch pointer stops existing when the
    // finger lifts, and the UA reports that as pointerout/pointerleave — so
    // hiding here pulled the controls away the instant they were offered on
    // pointerdown, and the + and the handle could never be tapped at all.
    if (event.pointerType === 'touch' || this.#drag) {
      return;
    }

    this.#gutter.hide();
  };

  /** Points the gutter at a block, aligned to that block's indentation. */
  #positionGutter(id: string): void {
    const view = this.#renderer.getView(id);

    if (!view) {
      this.#gutter.hide();
      return;
    }

    // The block's inline-start padding is exactly where its text begins, and an
    // absolutely positioned child measures from the same edge — so this is
    // correct in both writing directions without any mirroring here.
    const indent = Number.parseFloat(
      this.#document.defaultView?.getComputedStyle(view.root).paddingInlineStart ?? '0',
    );

    this.#gutter.showFor(id, view.root.offsetTop, indent || 0);
  }

  #beginDrag(blockId: string, event: PointerEvent): void {
    // A fresh press on the handle is a fresh gesture, so whatever the last one
    // left armed is stale. Reset before the guard: a gesture that never became
    // a drag must not inherit a suppression from one that did.
    this.#clickEndedDrag = false;

    if (!this.#editable) {
      return;
    }

    // A handle press on an already-selected block drags the whole selection.
    const ids = this.#selected.has(blockId) ? new Set(this.#selected) : new Set([blockId]);

    this.#drag = {
      ids,
      pointerId: event.pointerId,
      startY: event.clientY,
      active: false,
      gap: -1,
    };

    // Captured so the drag still receives moves outside the window. Without it
    // a pointer released elsewhere never delivers pointerup and the editor is
    // wedged: the gutter stops tracking and every later move is misrouted.
    const handle = event.currentTarget ?? event.target;

    if (handle && 'setPointerCapture' in handle) {
      try {
        (handle as Element).setPointerCapture(event.pointerId);
      } catch {
        // Capture is best-effort; the document listeners are the real path.
      }
    }
  }

  #handlePointerMove = (event: PointerEvent): void => {
    const press = this.#longPress;

    // Drifting past the tolerance means this is a scroll or a drag, not a press.
    if (
      press &&
      (Math.abs(event.clientX - press.x) > LONG_PRESS_TOLERANCE_PX ||
        Math.abs(event.clientY - press.y) > LONG_PRESS_TOLERANCE_PX)
    ) {
      this.#cancelLongPress();
    }

    const drag = this.#drag;

    if (!drag || event.pointerId !== drag.pointerId) {
      this.#updateTextDrag(event);
      return;
    }

    if (!drag.active) {
      // Below the threshold this is still a click, not a drag.
      if (Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD_PX) {
        return;
      }

      drag.active = true;
      this.#gutter.setDragging(true);
      this.#root.dataset.dragging = 'true';
      this.#setBlockSelection([...drag.ids], [...drag.ids][0], { takeFocus: false });
    }

    const gap = this.#dropGapFor(event.clientY);

    if (gap !== drag.gap) {
      drag.gap = gap;
      this.#showDropIndicator(gap);
    }
  };

  /**
   * The browser took the gesture over — a touch became a scroll, or the window
   * lost focus. `pointerup` does not follow, so this is the only chance to let
   * go of the drag.
   */
  #handlePointerCancel = (event: PointerEvent): void => {
    this.#cancelLongPress();

    if (this.#drag && event.pointerId === this.#drag.pointerId) {
      this.#endDrag(null);
    }

    this.#pointerDown = false;
    this.#textDrag = null;
    delete this.#root.dataset.selecting;
  };

  #handlePointerUp = (event: PointerEvent): void => {
    this.#pointerDown = false;
    this.#textDrag = null;
    this.#cancelLongPress();
    delete this.#root.dataset.selecting;
    const drag = this.#drag;

    if (drag && event.pointerId === drag.pointerId) {
      this.#endDrag(drag.active && drag.gap >= 0 ? drag : null);
      return;
    }

    this.#promoteCrossBlockSelection();
  };

  /**
   * The popovers that are open right now, newest concern first.
   *
   * One list, so "is the pointer outside it" and "does this block own it" are
   * answered the same way everywhere. The format toolbar is not here: it has no
   * caret to hand back and is re-synced from the selection on its own.
   */
  #openPopovers(): readonly AnchoredPopover[] {
    const popovers: AnchoredPopover[] = [];

    if (this.#linkEditor.isOpen) {
      const context = this.#linkContext;

      popovers.push({
        // A table cell is its own editing host, so the row and column are part
        // of the answer: the link popover of one cell is not the caret's.
        ownedBy: (blockId, cell) => context?.blockId === blockId && sameCell(context.cell, cell),
        contains: (node) => this.#linkEditor.contains(node),
        close: (restoreFocus) => {
          this.#closeLinkEditor(restoreFocus);
        },
      });
    }

    if (this.#iconPicker.isOpen) {
      const id = this.#iconContext;

      popovers.push({
        ownedBy: (blockId) => id === blockId,
        contains: (node) => this.#iconPicker.contains(node),
        close: (restoreFocus) => {
          this.#closeIconPicker(restoreFocus);
        },
      });
    }

    if (this.#imageEditor.isOpen) {
      const id = this.#imageContext;

      popovers.push({
        ownedBy: (blockId) => id === blockId,
        contains: (node) => this.#imageEditor.contains(node),
        close: (restoreFocus) => {
          this.#closeImageEditor(restoreFocus);
        },
      });
    }

    return popovers;
  }

  /**
   * A pointer anywhere in the page — the only signal a portal gets that the
   * user has moved on.
   *
   * The popovers render outside the editor root, so no listener on the root
   * ever hears a click that lands elsewhere: without this they stay open for
   * the rest of the session, still pointing at the block they were opened
   * from. Focus is deliberately not restored, because the pointer that
   * dismissed them is placing it itself.
   */
  #handleDocumentPointerDown = (event: PointerEvent): void => {
    this.#pointerDown = true;

    const popovers = this.#openPopovers();

    if (popovers.length === 0) {
      return;
    }

    const path = composedTargets(event);

    for (const popover of popovers) {
      if (!path.some((node) => popover.contains(node))) {
        popover.close(false);
      }
    }
  };

  /** Remembers which block a text drag started in. */
  #handleRootPointerDown = (event: PointerEvent): void => {
    if (this.#drag || event.button !== 0) {
      return;
    }

    const node = isNode(event.target) ? event.target : null;

    if (this.#gutter.contains(node)) {
      return;
    }

    const anchorBlockId = this.#renderer.blockIdFromNode(node);

    this.#textDrag = anchorBlockId
      ? { anchorBlockId, pointerId: event.pointerId, currentId: anchorBlockId }
      : null;

    // Touch has no hover, so the controls have to be offered some other way.
    // Offered on exactly the terms hover offers them, though: `#handlePointerOver`
    // stands down for a read-only editor and for `dragHandles: false`, and a
    // touch is not a second, laxer way in — a reader who taps a paragraph is
    // not owed an add button and a drag handle for a document they cannot edit.
    if (event.pointerType === 'touch' && anchorBlockId) {
      if (this.#useGutter && this.#editable) {
        this.#positionGutter(anchorBlockId);
      }

      this.#startLongPress(anchorBlockId, event);
    }
  };

  #startLongPress(blockId: string, event: PointerEvent): void {
    this.#cancelLongPress();

    const view = this.#document.defaultView;

    if (!view || !this.#editable) {
      return;
    }

    this.#longPress = {
      blockId,
      x: event.clientX,
      y: event.clientY,
      timer: view.setTimeout(() => {
        this.#longPress = null;
        this.#setBlockSelection([blockId], blockId);
      }, LONG_PRESS_MS),
    };
  }

  #cancelLongPress(): void {
    if (this.#longPress) {
      this.#document.defaultView?.clearTimeout(this.#longPress.timer);
      this.#longPress = null;
    }
  }

  /**
   * Grows a text drag into a block selection once it crosses a block boundary.
   *
   * Falls back to the nearest block above the pointer, so dragging past the end
   * of the document still selects to the bottom.
   */
  #updateTextDrag(event: PointerEvent): void {
    const drag = this.#textDrag;

    if (!drag || event.pointerId !== drag.pointerId || !this.#pointerDown) {
      return;
    }

    const overId = this.#blockIdAtY(event.clientY) ?? drag.currentId;

    if (!overId || overId === drag.currentId) {
      return;
    }

    drag.currentId = overId;

    // Still inside the block it started in: leave the native text selection be.
    if (overId === drag.anchorBlockId && this.#selected.size === 0) {
      return;
    }

    const ids = blockIdRange(this.#blocks, drag.anchorBlockId, overId);

    if (ids.length <= 1 && this.#selected.size === 0) {
      return;
    }

    // Whole blocks are the unit now; stop the browser painting text over them.
    this.#root.dataset.selecting = 'true';
    this.#setBlockSelection(ids, drag.anchorBlockId);
  }

  /** The block under a viewport Y, or the last one above it. */
  #blockIdAtY(clientY: number): string | null {
    let above: string | null = null;

    for (const block of this.#visible()) {
      const view = this.#renderer.getView(block.id);

      if (!view) {
        continue;
      }

      const rect = view.root.getBoundingClientRect();

      if (clientY >= rect.top && clientY <= rect.bottom) {
        return block.id;
      }

      if (clientY > rect.bottom) {
        above = block.id;
      }
    }

    return above;
  }

  /** Steps from a text caret at a block edge into a block selection. */
  #extendFromTextToBlocks(blockId: string, direction: 1 | -1): void {
    // Stepped through the visible list: the raw array puts a block hidden
    // inside a collapsed toggle next to the caret, and Backspace would then
    // destroy something that was never on screen.
    const visible = this.#visible();
    const index = findBlockIndex(visible, blockId);
    const sibling = index === -1 ? undefined : visible[index + direction];

    this.#setBlockSelection(
      sibling ? blockIdRange(this.#blocks, blockId, sibling.id) : [blockId],
      blockId,
    );
  }

  /**
   * Abandons a drag on Escape.
   *
   * Bound to the document rather than the editor root because pressing the
   * handle can leave focus outside the editor, where a root listener would
   * never see the key.
   */
  #handleDocumentKeyDown = (event: KeyboardEvent): void => {
    if (this.#drag?.active && event.key === 'Escape') {
      event.preventDefault();
      this.#endDrag(null);
    }
  };

  #endDrag(commit: { ids: Set<string>; gap: number } | null): void {
    // A drag that actually moved is followed by a compatibility click on the
    // handle that holds the pointer capture. That click is the tail of this
    // gesture, not a new one, so the handle's click hook has to skip it —
    // abandoned and cancelled drags included, since they end the same way.
    this.#clickEndedDrag = this.#drag?.active ?? false;
    this.#drag = null;
    this.#gutter.setDragging(false);
    delete this.#root.dataset.dragging;
    this.#dropIndicator.hidden = true;

    if (commit) {
      // The drag carries visible anchors; a collapsed toggle's children join
      // here, or they stay behind and are re-parented under whatever follows.
      this.#commit(
        moveBlocks(this.#blocks, withHiddenDescendants(this.#blocks, commit.ids), commit.gap),
      );
    }
  }

  /** The gap the pointer is closest to, in original block coordinates. */
  #dropGapFor(clientY: number): number {
    // Measured against what is on screen, but reported in full-document
    // coordinates — so a drop below a collapsed toggle lands after its children.
    for (const block of this.#visible()) {
      const view = this.#renderer.getView(block.id);

      if (!view) {
        continue;
      }

      const rect = view.root.getBoundingClientRect();

      if (clientY < rect.top + rect.height / 2) {
        return findBlockIndex(this.#blocks, block.id);
      }
    }

    return this.#blocks.length;
  }

  #showDropIndicator(gap: number): void {
    const before = this.#blocks[gap];
    const view = before
      ? this.#renderer.getView(before.id)
      : this.#renderer.getView(this.#visible().at(-1)?.id ?? '');

    if (!view) {
      return;
    }

    // offsetTop is relative to the editor, so this survives page scrolling.
    this.#dropIndicator.style.top = `${before ? view.root.offsetTop : view.root.offsetTop + view.root.offsetHeight}px`;
    this.#dropIndicator.hidden = false;
  }

  /**
   * Converts a cross-block text selection into a block selection.
   *
   * A mouse drag can never produce one — the browser confines a selection to a
   * single editing host, and every block is its own. This covers only ranges an
   * embedder builds through the Selection API; the pointer gesture is handled
   * by {@link #updateTextDrag}.
   */
  #promoteCrossBlockSelection(): boolean {
    const selection = this.#selection();

    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return false;
    }

    const from = this.#renderer.blockIdFromNode(selection.anchorNode);
    const to = this.#renderer.blockIdFromNode(selection.focusNode);

    if (!from || !to || from === to) {
      return false;
    }

    const ids = blockIdRange(this.#blocks, from, to);

    // An id this editor does not own yields an empty range. Selecting nothing
    // still clears the caret and takes focus, so leave the selection be.
    if (ids.length === 0) {
      return false;
    }

    this.#setBlockSelection(ids, from);
    return true;
  }

  #restoreSelection(snapshot: SelectionSnapshot | null): void {
    // The block may not exist in the restored document.
    if (!snapshot || !findBlock(this.#blocks, snapshot.blockId)) {
      return;
    }

    this.focusRange(snapshot.blockId, snapshot.start, snapshot.end, snapshot.cell);
  }

  #commitContent(
    id: string,
    content: RichText,
    runKey: string | null = null,
    selection?: SelectionSnapshot | null,
  ): void {
    this.#commit(updateBlock(this.#blocks, id, { content }), runKey, selection);
  }

  /** Speaks a short message to assistive technology. */
  #announce(message: string): void {
    // Cleared first so an identical consecutive message is still spoken.
    this.#liveRegion.textContent = '';
    this.#liveRegion.textContent = message;
  }

  #emitChange(): void {
    this.#emitter.emit('change', this.getDocument());
  }

  /** The editable host a node sits in — a block's content, or one table cell. */
  #hostFromNode(node: Node | null): HTMLElement | null {
    const element = asElement(node);

    return element?.closest<HTMLElement>('.neditor-block__content') ?? null;
  }

  /** The editable host of a block, or of one named cell of its table. */
  #hostFor(id: string, cell?: CellCoords): HTMLElement | null {
    const view = this.#renderer.getView(id);

    return (cell ? view?.cells?.[cell.row]?.[cell.column] : view?.content) ?? null;
  }

  /**
   * Rebuilds a resolved target from ids alone.
   *
   * For state that outlives the event it came from — the link popover holds a
   * range while focus is in its input — where re-reading `getView(id).content`
   * would answer with a table's first cell whatever cell was recorded.
   */
  #targetFor(id: string, cell?: CellCoords): ResolvedTarget | null {
    const block = findBlock(this.#blocks, id);
    const content = this.#hostFor(id, cell);

    if (!block || !content) {
      return null;
    }

    return { block, content, ...(cell ? { cell } : {}) };
  }

  /**
   * Resolves the block and the editable host from an event target.
   *
   * A table has one host per cell, so `cell` says which. Everything downstream —
   * caret offsets, selection ranges, input parsing — then works against that
   * host without caring whether it is a block's own content or a cell.
   */
  #resolve(target: EventTarget | null): ResolvedTarget | null {
    const node = isNode(target) ? target : null;
    const id = this.#renderer.blockIdFromNode(node);

    if (!id) {
      return null;
    }

    const block = findBlock(this.#blocks, id);
    // Never guessed: a node inside a block but outside every editable host — a
    // toggle's chevron, a callout's icon, an image's button — is not text at
    // all, and answering with the block's own content would let Enter split a
    // block the user was only trying to activate a control in.
    const content = this.#hostFromNode(node);

    if (!block || !content) {
      return null;
    }

    return { block, content, cell: parseCellCoords(content) };
  }

  /** The rich text behind a resolved host: a cell's, or the block's own. */
  #contentOf(target: ResolvedTarget): RichText {
    return target.cell
      ? (target.block.rows?.[target.cell.row]?.[target.cell.column] ?? [])
      : target.block.content;
  }

  /**
   * Writes rich text back to wherever it came from, as one undoable edit.
   *
   * `runKey` and `selection` ride along to `#commit`, which is the recorder.
   * A caller with a run of its own states it here instead of snapshotting first
   * and committing second — that pushed the entry twice.
   */
  #commitResolved(
    target: ResolvedTarget,
    content: RichText,
    runKey: string | null = null,
    selection?: SelectionSnapshot | null,
  ): void {
    if (!target.cell) {
      this.#commitContent(target.block.id, content, runKey, selection);
      return;
    }

    const rows = tableSetCell(
      target.block.rows ?? [],
      target.cell.row,
      target.cell.column,
      content,
    );

    this.#commit(updateBlock(this.#blocks, target.block.id, { rows }), runKey, selection);
  }

  /** Places the caret in a table cell. */
  #focusCell(id: string, row: number, column: number, start: number, end = start): void {
    this.focusRange(id, start, end, { row, column });
  }

  /** Restores a selection to whichever host it came from. */
  #focusResolved(target: ResolvedTarget, start: number, end = start): void {
    this.focusRange(target.block.id, start, end, target.cell);
  }

  /** The editable host the selection sits in, when both ends share one. */
  #selectionTarget(): (ResolvedTarget & { range: OffsetRange }) | null {
    const selection = this.#selection();

    if (!selection || selection.rangeCount === 0) {
      return null;
    }

    // Both ends must be in the same host — the same block, and for a table the
    // same cell — or there is no single range to format.
    const host = this.#hostFromNode(selection.anchorNode);

    if (!host || host !== this.#hostFromNode(selection.focusNode)) {
      return null;
    }

    const resolved = this.#resolve(selection.anchorNode);

    if (!resolved) {
      return null;
    }

    const range = getSelectionRange(resolved.content);

    return range ? { ...resolved, range } : null;
  }

  /**
   * The selection for the tree this editor is mounted in.
   *
   * A shadow root exposes its own `getSelection`; the document's would report
   * the host element instead of the caret inside it.
   */
  #selection(): Selection | null {
    const root = this.#root.getRootNode() as ShadowRoot & { getSelection?: () => Selection | null };

    return root.getSelection?.() ?? this.#document.defaultView?.getSelection() ?? null;
  }

  #selectionRect(): DOMRect | null {
    const selection = this.#selection();

    if (!selection || selection.rangeCount === 0) {
      return null;
    }

    const rect = selection.getRangeAt(0).getBoundingClientRect();

    return rect.width > 0 || rect.height > 0 ? rect : null;
  }

  #syncToolbar(): void {
    if (this.#linkEditor.isOpen) {
      return;
    }

    if (!this.#useToolbar) {
      // The table controls are structural, so they stay even when the
      // formatting toolbar is turned off.
      this.#syncTableToolbar();
      return;
    }

    // Whole blocks are selected; there is no text range to format.
    if (this.#selected.size > 0) {
      this.#toolbar.hide();
      return;
    }

    const target = this.#selectionTarget();

    if (!target || !this.#editable || target.range.start === target.range.end) {
      this.#toolbar.hide();
      this.#syncTableToolbar();
      return;
    }

    const rect = this.#selectionRect();

    if (!rect) {
      this.#toolbar.hide();
      this.#syncTableToolbar();
      return;
    }

    const { range } = target;

    const content = this.#contentOf(target);

    this.#toolbar.show(rect, {
      marks: richActiveMarks(content, range.start, range.end),
      link: richActiveLink(content, range.start, range.end),
    });
  }

  /**
   * Applies armed formatting to text as it is typed.
   *
   * The browser would insert the character into whatever element the caret sits
   * in, which carries the *old* formatting, so this path takes over the insert
   * and writes the run itself.
   */
  /**
   * Reads an editable host back into the model without re-rendering.
   *
   * The DOM already shows this text, so the model is brought up to date and the
   * renderer is told its view is current. Returns the parsed runs.
   */
  #syncFromDom(resolved: ResolvedTarget, event?: Event): RichText {
    const { content, cell } = resolved;
    const id = resolved.block.id;
    const parsed = parseRichText(content);

    // An input event that changed nothing is not an edit worth undoing. This
    // path writes `#blocks` itself rather than going through `#commit` — the
    // DOM is already ahead, and re-rendering it would drop the caret — so it
    // carries its own copy of that test.
    if (event && !richEquals(this.#contentOf(resolved), parsed)) {
      this.#recordHistory(inputRunKey(event, hostScope(id, cell)), this.#selectionBeforeInput);
    }

    if (cell) {
      const rows = tableSetCell(resolved.block.rows ?? [], cell.row, cell.column, parsed);
      this.#blocks = updateBlock(this.#blocks, id, { rows });
      this.#renderer.syncCellFromDom(id, cell.row, cell.column, parsed);
    } else {
      this.#blocks = updateBlock(this.#blocks, id, { content: parsed });
      this.#renderer.syncFromDom(id, parsed);
    }

    return parsed;
  }

  #handleCompositionStart = (): void => {
    this.#composing = true;
  };

  /**
   * Reads the committed candidate back into the model.
   *
   * `compositionend` fires before the browser's final `input`, so the model is
   * synced here and the rules that were suppressed during composition are given
   * one chance to run against the finished text.
   */
  #handleCompositionEnd = (event: CompositionEvent): void => {
    this.#composing = false;

    const resolved = this.#resolve(event.target);

    if (!resolved || !this.#editable) {
      return;
    }

    // A committed candidate is one undoable edit, keyed like ordinary typing.
    this.#syncFromDom(resolved, new InputEvent('input', { inputType: 'insertText' }));
    this.#emitChange();
  };

  #handleBeforeInput = (event: InputEvent): void => {
    if (!this.#editable) {
      // Cancel rather than return: a host we failed to lock would otherwise let
      // the browser write text the model never sees.
      event.preventDefault();
      return;
    }

    // The last moment the DOM still holds the pre-edit state, so this is the
    // selection undo has to restore.
    this.#selectionBeforeInput = this.#selectionSnapshot();

    // The Edit menu and trackpad gestures reach undo through here, never keydown.
    if (event.inputType === 'historyUndo') {
      event.preventDefault();
      this.undo();
      return;
    }

    if (event.inputType === 'historyRedo') {
      event.preventDefault();
      this.redo();
      return;
    }

    // Content from outside the editor only ever enters through the parser. The
    // `paste` and `drop` handlers take over both gestures, so anything of this
    // kind arriving here is a path neither of them saw — a host that would not
    // resolve, an unusual browser ordering — and the safe answer to markup we
    // cannot account for is to refuse it, not to let the DOM win by default.
    if (UNPARSED_INPUT_TYPES.has(event.inputType)) {
      event.preventDefault();
      return;
    }

    const pending = this.#pending;

    if (!pending) {
      return;
    }

    if (event.inputType !== 'insertText' || typeof event.data !== 'string') {
      return;
    }

    const resolved = this.#resolve(event.target);
    const range = resolved ? getSelectionRange(resolved.content) : null;

    if (
      !resolved ||
      !range ||
      resolved.block.id !== pending.blockId ||
      !sameCell(resolved.cell, pending.cell)
    ) {
      return;
    }

    event.preventDefault();
    this.#pending = null;

    const inserted = event.data;
    const withoutSelection = richDelete(this.#contentOf(resolved), range.start, range.end);
    const next = richInsert(
      withoutSelection,
      range.start,
      richFromPlainText(inserted, pending.marks),
    );
    const caret = range.start + inserted.length;

    // Keyed and snapshotted through the commit, not before it: recording here
    // and committing after pushed the pre-edit document twice, and the first
    // Ctrl+Z then restored the document already on screen.
    this.#commitResolved(
      resolved,
      next,
      `insert:${hostScope(resolved.block.id, resolved.cell)}`,
      this.#selectionBeforeInput,
    );
    this.#focusResolved(resolved, caret);
  };

  #handleInput = (event: Event): void => {
    const resolved = this.#resolve(event.target);

    if (!resolved || !this.#editable) {
      return;
    }

    const { content, cell } = resolved;
    const id = resolved.block.id;

    // The browser already edited the DOM, so it is the source of truth here.
    // Reading it back keeps IME, autocorrect and spellcheck fixes working.
    const parsed = this.#syncFromDom(resolved, event);
    const block = findBlock(this.#blocks, id);

    if (!block) {
      return;
    }

    const target: ResolvedTarget = { ...resolved, block };

    // Half-composed text is not something to run markdown rules against.
    if (this.#composing) {
      this.#emitChange();
      return;
    }

    const caret = getCaretOffset(content);
    const beforeCaret = richToPlainText(parsed).slice(0, caret);

    // An open slash menu tracks the text in both directions: backspacing
    // narrows the query, and deleting the `/` closes the menu. It reads the
    // text rather than acting on it, so it runs before the gate below.
    if (!cell && this.#slashContext?.blockId === id) {
      this.#updateSlashQuery(beforeCaret, caret);
      this.#emitChange();
      return;
    }

    // Every rule below reads the text before the caret and treats it as
    // something just typed. A deletion leaves the very same text sitting there
    // without anyone having typed it — delete the word after a `# ` and the
    // prefix is suddenly "complete" — so the rules convert the block and eat
    // the prefix the user was in the middle of clearing. Only an insertion
    // arms them.
    if (!isInsertion(event)) {
      this.#emitChange();
      return;
    }

    // The slash menu and block rules act on a block; a cell has neither.
    if (!cell) {
      if (this.#tryOpenSlashMenu(id, beforeCaret, caret, content)) {
        this.#emitChange();
        return;
      }

      if (this.#tryBlockRule(block, beforeCaret)) {
        return;
      }
    }

    if (this.#tryInlineRule(target, beforeCaret)) {
      return;
    }

    this.#emitChange();
  };

  /** Block-level Markdown shortcuts. Only from a plain paragraph. */
  #tryBlockRule(block: Block, beforeCaret: string): boolean {
    if (block.type !== 'paragraph') {
      return false;
    }

    const match = matchInputRule(beforeCaret, blockText(block));

    if (!match) {
      return false;
    }

    // Slice rather than re-create, so formatting after the prefix survives.
    const rest = richSlice(block.content, beforeCaret.length, richLength(block.content));
    let blocks = updateBlock(this.#blocks, block.id, { content: rest });
    blocks = setBlockType(blocks, block.id, match.type);

    if (match.type === 'divider') {
      // A divider holds no caret, so give the user a paragraph to keep typing in.
      const paragraph = createBlock('paragraph', rest, block.depth);
      blocks = insertBlockAfter(blocks, block.id, paragraph);
      this.#commit(blocks);
      this.focus(paragraph.id, 0);
      return true;
    }

    this.#commit(blocks);
    this.focus(block.id, 0);
    return true;
  }

  /** Inline Markdown shortcuts: `**bold**`, `*italic*`, `` `code` ``, `[text](url)`. */
  #tryInlineRule(target: ResolvedTarget, beforeCaret: string): boolean {
    // A code block is literal; its text must not be reinterpreted.
    if (target.block.type === 'code') {
      return false;
    }

    const match = matchInlineRule(beforeCaret);

    if (!match) {
      return false;
    }

    const innerStart = match.start + match.openLength;
    const innerEnd = match.end - match.closeLength;

    if (innerEnd <= innerStart) {
      return false;
    }

    // Strip the closing delimiter first, so the opening offsets stay valid.
    let content = richDelete(this.#contentOf(target), innerEnd, match.end);
    content = richDelete(content, match.start, innerStart);

    const start = match.start;
    const end = start + (innerEnd - innerStart);

    if (match.link) {
      content = richSetLink(content, start, end, match.link);
    } else if (match.mark) {
      content = richToggleMark(content, start, end, match.mark);
    }

    this.#commitResolved(target, content);
    this.#focusResolved(target, end);

    // Text typed after a completed span should not inherit its formatting.
    this.#pending = {
      blockId: target.block.id,
      offset: end,
      marks: [],
      ...(target.cell ? { cell: target.cell } : {}),
    };
    return true;
  }

  #tryOpenSlashMenu(
    blockId: string,
    beforeCaret: string,
    caret: number,
    content: HTMLElement,
  ): boolean {
    if (!beforeCaret.endsWith('/')) {
      return false;
    }

    // Only at a word boundary, so a URL never opens the menu.
    const preceding = beforeCaret.at(-2);

    if (preceding !== undefined && preceding !== ' ') {
      return false;
    }

    this.#slashContext = { blockId, start: caret - 1 };
    this.#slashMenu.open(this.#selectionRect() ?? content.getBoundingClientRect());
    this.#describeSlashMenu(content);
    return true;
  }

  #updateSlashQuery(beforeCaret: string, caret: number): void {
    const context = this.#slashContext;

    if (!context) {
      return;
    }

    // Caret moved behind the `/`, or the `/` was deleted.
    if (caret <= context.start || beforeCaret.at(context.start) !== '/') {
      this.#closeSlashMenu();
      return;
    }

    // The re-render this triggers reports the highlight back through
    // `onActiveChange`, so the description follows the filtered list.
    this.#slashMenu.setQuery(beforeCaret.slice(context.start + 1));
  }

  /**
   * Wires the combobox relationship onto the block being typed in.
   *
   * The menu is a portal, so without this a screen reader has no way to know it
   * opened, what it contains, or which option is highlighted. It is called
   * again on every highlight change: the attribute is a pointer at one option
   * id, and a stale one has the reader announce "Text" for every arrow press
   * while the menu commits something else entirely.
   */
  #describeSlashMenu(content?: HTMLElement): void {
    const context = this.#slashContext;
    const host = content ?? (context ? this.#renderer.getView(context.blockId)?.content : null);

    if (!host) {
      return;
    }

    host.setAttribute('role', 'combobox');
    host.setAttribute('aria-expanded', 'true');
    host.setAttribute('aria-haspopup', 'listbox');
    host.setAttribute('aria-controls', this.#slashMenu.listId);

    const active = this.#slashMenu.activeOptionId;

    if (active) {
      host.setAttribute('aria-activedescendant', active);
    }
  }

  /** Closes the menu and removes the combobox wiring it added. */
  #closeSlashMenu(): void {
    const content = this.#slashContext
      ? this.#renderer.getView(this.#slashContext.blockId)?.content
      : undefined;

    this.#slashMenu.close();
    this.#slashContext = null;

    for (const attribute of [
      'role',
      'aria-expanded',
      'aria-haspopup',
      'aria-controls',
      'aria-activedescendant',
    ]) {
      content?.removeAttribute(attribute);
    }
  }

  #applySlashCommand(command: SlashCommand): void {
    const context = this.#slashContext;

    this.#closeSlashMenu();

    if (!context) {
      return;
    }

    const block = findBlock(this.#blocks, context.blockId);
    const content = this.#renderer.getView(context.blockId)?.content;

    if (!block || !content) {
      return;
    }

    // Strip the `/query` the user typed to summon the menu.
    const stripped = richDelete(block.content, context.start, getCaretOffset(content));
    let blocks = updateBlock(this.#blocks, block.id, { content: stripped });
    blocks = setBlockType(blocks, block.id, command.type);

    if (command.type === 'divider') {
      const paragraph = createBlock('paragraph', stripped, block.depth);
      blocks = insertBlockAfter(blocks, block.id, paragraph);
      this.#commit(blocks);
      this.focus(paragraph.id, 0);
      return;
    }

    this.#commit(blocks);
    this.focus(block.id, context.start);

    // An image block is useless until it has a source, so ask immediately.
    if (command.type === 'image') {
      const placeholder = this.#renderer
        .getView(block.id)
        ?.root.querySelector<HTMLElement>('.neditor-image__placeholder');

      if (placeholder) {
        this.#openImageEditor(block.id, placeholder);
      }
    }
  }

  /* ------------------------------------------------------------- links -- */

  #applyLink(href: string | null): void {
    const context = this.#linkContext;

    if (!context) {
      this.#closeLinkEditor();
      return;
    }

    const url = href === null ? null : sanitizeUrl(href);

    if (href !== null && url === null) {
      this.#linkEditor.markInvalid();
      return;
    }

    this.#linkEditor.close();
    this.#linkContext = null;

    const target = this.#targetFor(context.blockId, context.cell);

    if (!target) {
      return;
    }

    this.#commitResolved(
      target,
      richSetLink(this.#contentOf(target), context.start, context.end, url),
    );
    this.#focusResolved(target, context.start, context.end);
    this.#syncToolbar();
  }

  #closeLinkEditor(restoreFocus = true): void {
    const context = this.#linkContext;

    this.#linkEditor.close();
    this.#linkContext = null;

    // Restoring the range is right when the user dismissed this popover from
    // inside it, and wrong when a pointer landed somewhere else entirely: the
    // caret would be yanked back to whichever block the popover was opened
    // from, over the block the user just pointed at.
    if (context && restoreFocus) {
      // The cell was recorded when the popover opened; dropping it here put the
      // caret back in the table's header rather than the cell being edited.
      this.focusRange(context.blockId, context.start, context.end, context.cell);
      this.#syncToolbar();
    }
  }

  /** Clicking a link edits it; ⌘/Ctrl-click and read-only mode follow it. */
  #handleClick = (event: MouseEvent): void => {
    const node = asElement(event.target);
    const anchor = node?.closest<HTMLAnchorElement>('a.neditor-link');

    if (!anchor) {
      return;
    }

    // Cancel first. An unsafe href is exactly the case that must not reach the
    // browser, so returning early here would fail open.
    event.preventDefault();

    const href = sanitizeUrl(anchor.getAttribute('href') ?? '');

    if (!href) {
      return;
    }

    if (!this.#editable || event.metaKey || event.ctrlKey) {
      this.#document.defaultView?.open(href, '_blank', 'noopener,noreferrer');
      return;
    }

    // Resolved from the anchor itself: a table has one host per cell, and the
    // view's `content` is only ever the first of them.
    const target = this.#resolve(anchor);
    const offsets = target ? offsetsOfNode(target.content, anchor) : null;

    if (!target || !offsets) {
      return;
    }

    this.#focusResolved(target, offsets.start, offsets.end);
    this.openLinkEditor();
  };

  /* ------------------------------------------------------------ clipboard -- */

  #handlePaste = (event: ClipboardEvent): void => {
    if (!this.#editable || !event.clipboardData) {
      return;
    }

    // Always take over: an unhandled paste injects arbitrary markup that the
    // parser would have to guess at, and scripts along with it. Cancelled up
    // front, so a target we cannot resolve refuses the paste rather than
    // handing it back to the browser.
    event.preventDefault();

    const html = event.clipboardData.getData('text/html');
    const plain = event.clipboardData.getData('text/plain');

    if (this.#selected.size > 0) {
      this.#pasteOverBlockSelection(html, plain);
      return;
    }

    const resolved = this.#resolve(event.target);

    if (!resolved) {
      return;
    }

    this.#insertForeignContent(resolved, html, plain);
  };

  /**
   * A drag from another page or another app, refused as a native edit.
   *
   * The browser's default is to write the dragged fragment straight into the
   * host under the pointer — an `<iframe>`, a password form, a fixed overlay
   * across the whole viewport — and `#syncFromDom` then reads that back as the
   * block's own content, so the model agrees with the DOM and nothing later
   * renders it away. A drop carries the same flavours as a clipboard, so it is
   * parsed by the same code: dropped content becomes blocks, never markup.
   *
   * Cancelling the default costs the caret the browser would have placed, so
   * it is derived from the drop coordinates instead. Without that step the
   * payload lands wherever the selection was left before the drag — in another
   * block entirely, and over the top of any text still selected there.
   *
   * The cost is that dragging text inside the editor copies rather than moves,
   * because the native move is one gesture and cancelling the drop cancels
   * both halves of it. Losing a move is a great deal cheaper than keeping the
   * hole, and the block handles in the gutter still move blocks properly.
   */
  #handleDrop = (event: DragEvent): void => {
    // Unconditional, and first: every branch below that gives up is a case
    // where we could not account for the payload, which is a reason to drop it
    // on the floor rather than to let the default insertion happen.
    event.preventDefault();

    const data = event.dataTransfer;

    if (!this.#editable || !data) {
      return;
    }

    // Where the pointer let go, not where the caret happened to be. The
    // selection still holds whatever the user left behind before the drag
    // started, which is both the wrong place to insert and — when it is a
    // range — text this insertion would silently delete.
    const point = this.#caretFromPoint(event.clientX, event.clientY);
    const resolved = (point && this.#resolve(point.node)) ?? this.#resolve(event.target);

    if (!resolved) {
      return;
    }

    // Nothing to insert is not a reason to move the caret, so the caret is
    // placed from inside, once the payload is known to hold something. A file
    // drag carries only `Files` and a dragged blank line parses to nothing;
    // both used to collapse whatever the user had selected and insert nothing.
    this.#insertForeignContent(
      resolved,
      data.getData('text/html'),
      data.getData('text/plain'),
      () => this.#placeCaretForDrop(resolved, point),
    );
  };

  /**
   * The caret a viewport point names, in whichever spelling this engine ships.
   *
   * `caretPositionFromPoint` is the standard one and `caretRangeFromPoint` the
   * older WebKit name; the supported range spans browsers that have only one
   * or the other, so both are tried. A shadow root is asked before the
   * document because the document's answer stops at the host element, which
   * belongs to no block — and the standard call is additionally handed the
   * root, which is how a newer engine is told to look inside it.
   */
  #caretFromPoint(x: number, y: number): CaretPoint | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }

    const root = this.#root.getRootNode();
    const shadow = 'host' in root ? (root as ShadowRoot) : null;
    const options = shadow ? { shadowRoots: [shadow] } : undefined;

    for (const source of (shadow ? [shadow, this.#document] : [this.#document]) as CaretSource[]) {
      const position = source.caretPositionFromPoint?.(x, y, options);

      if (position && isNode(position.offsetNode)) {
        return { node: position.offsetNode, offset: position.offset };
      }

      const range = source.caretRangeFromPoint?.(x, y);

      if (range) {
        return { node: range.startContainer, offset: range.startOffset };
      }
    }

    return null;
  }

  /**
   * Collapses the selection to the point a drop landed on.
   *
   * Everything downstream of here reads the caret back out of the DOM, so this
   * is the whole of what makes dropped content appear under the pointer. When
   * the point cannot be resolved there is still one guarantee left to keep: a
   * drop inserts, it never overwrites, so a range standing in this host is
   * collapsed rather than handed to `richDelete`.
   */
  #placeCaretForDrop(target: ResolvedTarget, point: CaretPoint | null): void {
    if (point && target.content.contains(point.node)) {
      this.#selection()?.collapse(point.node, point.offset);
      return;
    }

    const existing = getSelectionRange(target.content);

    if (existing && existing.start !== existing.end) {
      setCaretOffset(target.content, existing.start);
    }
  }

  /**
   * The one way content from outside the editor enters a block.
   *
   * Paste and drop both land here, so neither can grow a path the other lacks:
   * the payload is parsed into blocks, and where those blocks go is decided by
   * what the target can actually hold.
   */
  #insertForeignContent(
    resolved: ResolvedTarget,
    html: string,
    plain: string,
    prepare?: () => void,
  ): void {
    const pasted = this.#parseClipboard(html, plain);

    if (pasted.length === 0) {
      return;
    }

    // What would be written is decided before anything is written, so a caller
    // that has to move the caret first — a drop, which lands where the pointer
    // let go rather than where the selection was — can be told there is nothing
    // to move it for. Testing the payload for emptiness instead only caught the
    // literally empty one: a dragged blank line arrives as `<div><br></div>`,
    // which is not empty, parses to nothing, and still threw the selection away.
    const inline = resolved.cell
      ? richFromBlocks(pasted)
      : resolved.block.type === 'code'
        ? // A code block is literal: pasted structure becomes text, never blocks.
          richFromPlainText(plain.length > 0 ? plain : pasted.map(blockText).join('\n'))
        : // A lone paragraph is a phrase, not a document: keep it in this block
          // so pasting mid-sentence still works.
          pasted.length === 1 && pasted[0]?.type === 'paragraph'
          ? pasted[0].content
          : null;

    if (inline !== null && isRichEmpty(inline)) {
      return;
    }

    prepare?.();

    // A cell holds text, so structure flattens rather than splitting the table.
    // Only the structure: marks and links render in a cell like anywhere else.
    if (inline !== null) {
      this.#pasteInline(resolved, inline);
      return;
    }

    this.#pasteBlocks(resolved.block, resolved.content, pasted);
  }

  /** HTML first, since it carries structure; Markdown is the fallback. */
  #parseClipboard(html: string, plain: string): Block[] {
    const fromHtml = html.length > 0 ? blocksFromHtml(this.#document, html) : [];

    return fromHtml.length > 0 ? fromHtml : blocksFromMarkdown(plain);
  }

  #pasteInline(target: ResolvedTarget, runs: RichText): void {
    if (isRichEmpty(runs)) {
      return;
    }

    const range = getSelectionRange(target.content) ?? { start: 0, end: 0 };
    const withoutSelection = richDelete(this.#contentOf(target), range.start, range.end);
    const next = richInsert(withoutSelection, range.start, runs);

    this.#commitResolved(target, next);
    this.#focusResolved(target, range.start + richLength(runs));
  }

  /**
   * Splices pasted blocks into the document at the caret.
   *
   * The first pasted block merges into the block being typed in and the last
   * one absorbs whatever followed the caret, so pasting into the middle of a
   * paragraph splits it rather than leaving an empty remnant.
   *
   * Both of those moves carry text and nothing else, which is only the whole of
   * a block when the block is text. A table, an image or a divider keeps its
   * payload beside `content`, so one is spliced in as a block of its own rather
   * than merged into a paragraph — and never handed text it cannot show.
   */
  #pasteBlocks(target: Block, content: HTMLElement, pasted: Block[]): void {
    const range = getSelectionRange(content) ?? { start: 0, end: 0 };
    const trimmed = richDelete(target.content, range.start, range.end);
    const [before, after] = richSplit(trimmed, range.start);
    const [first] = pasted;

    if (!first) {
      return;
    }

    // Pasting into a genuinely empty block replaces it outright. Retyping it
    // through setBlockType would rebuild the payload from the *target*, which
    // blanks a pasted table's rows and an image's src. A table or an image is
    // never empty here whatever its cells or caption say: its payload is not
    // text, so there is nothing for a paste to take the place of.
    const replaceable = isRichEmpty(trimmed) && canMergeText(target.type);

    // Only text merges into text. Merging a pasted table would keep its
    // (always empty) content and drop every row — for a lone table pasted into
    // a paragraph, a paste that changed nothing at all.
    const merges = replaceable || canMergeText(first.type);

    let created = pasted.slice(merges ? 1 : 0).map((block) => ({
      ...cloneBlock(block),
      depth: target.depth + block.depth,
    }));

    // Where the text that followed the caret lands, and the type it lands in.
    const tail = created.at(-1);
    const tailType = tail?.type ?? (replaceable ? first.type : target.type);

    // Appending that text to a divider or a table parks it in a field nothing
    // renders and `normalizeDocument` erases on the next load, so it gets a
    // block of its own — the rehousing `/divider` already does. A divider holds
    // no caret either, so it earns one even with no text to carry.
    const rehoused =
      canMergeText(tailType) || (isRichEmpty(after) && !isVoidType(tailType))
        ? null
        : createBlock(typeAfterSplit(target.type), after, target.depth);

    let targetContent = merges ? richConcat(before, first.content) : before;

    if (rehoused) {
      created = [...created, rehoused];
    } else if (tail) {
      created[created.length - 1] = { ...tail, content: richConcat(tail.content, after) };
    } else {
      targetContent = richConcat(targetContent, after);
    }

    let blocks: Block[];

    if (replaceable) {
      // The id is the target's and stays put; only the payload is replaced.
      const { id: _pastedId, ...payload } = cloneBlock(first);

      blocks = updateBlock(this.#blocks, target.id, {
        ...payload,
        depth: target.depth,
        content: targetContent,
      });
    } else {
      blocks = updateBlock(this.#blocks, target.id, { content: targetContent });
    }

    let at = findBlockIndex(blocks, target.id);

    for (const block of created) {
      at += 1;
      blocks = insertBlockAt(blocks, at, block);
    }

    // Pasting a block that could not merge leaves the target holding only the
    // text before the caret. At offset 0 there is none, and keeping the husk
    // would put an empty line above every table pasted at the start of one.
    if (!merges && isRichEmpty(targetContent) && canMergeText(target.type)) {
      blocks = removeBlock(blocks, target.id);
    }

    this.#commit(normalizeDepths(blocks));

    const last = created.at(-1);

    if (last) {
      this.focus(last.id, richLength(last.content) - richLength(after));
    } else {
      this.focus(target.id, richLength(before) + richLength(first.content));
    }
  }

  /** Replaces the selected blocks with the clipboard's blocks. */
  #pasteOverBlockSelection(html: string, plain: string): void {
    const pasted = this.#parseClipboard(html, plain);
    const firstId = this.#orderedSelection()[0];

    if (pasted.length === 0 || !firstId) {
      return;
    }

    const index = findBlockIndex(this.#blocks, firstId);
    const depth = this.#blocks[index]?.depth ?? 0;
    const created = pasted.map((block) => ({ ...block, depth: depth + block.depth }));

    const removing = this.#selectionForEdit();
    let blocks = this.#blocks.filter((block) => !removing.has(block.id));
    let at = index;

    for (const block of created) {
      blocks = insertBlockAt(blocks, at, block);
      at += 1;
    }

    this.#commit(normalizeDepths(blocks));
    this.#setBlockSelection(created.map((block) => block.id));
  }

  /* ------------------------------------------------------------ keyboard -- */

  /**
   * True when the key carries this platform's shortcut modifier.
   *
   * On macOS that is Cmd and only Cmd. Ctrl there is the system's own caret
   * modifier — Ctrl+B back a character, Ctrl+E end of line, Ctrl+K kill to the
   * end of the line — bindings every native text field honours, which an editor
   * that reads Ctrl as a second Cmd swallows and answers with bold, a link
   * editor and a select-all. Everywhere else Ctrl *is* the shortcut modifier
   * and Meta is a window-manager key with no meaning in a text field, so both
   * keep being accepted there and nothing about Windows or Linux changes.
   */
  #shortcutModifier(event: KeyboardEvent): boolean {
    return event.metaKey || (event.ctrlKey && !this.#applePlatform);
  }

  #handleKeyDown = (event: KeyboardEvent): void => {
    // A composing IME delivers Enter, Escape, Backspace and arrows as ordinary
    // keydowns (keyCode 229) while the candidate window is open. Acting on them
    // splits the block instead of committing the candidate, so the whole
    // handler stands down until composition ends.
    if (event.isComposing || event.keyCode === 229 || this.#composing) {
      return;
    }

    if (this.#slashMenu.handleKeyDown(event)) {
      return;
    }

    if (this.#selected.size > 0) {
      this.#handleBlockSelectionKeys(event);
      return;
    }

    const resolved = this.#resolve(event.target);

    if (!resolved || !this.#editable) {
      return;
    }

    const { block, content } = resolved;
    const modifier = this.#shortcutModifier(event);

    if (modifier && !event.altKey) {
      const key = event.key.toLowerCase();

      if (key === 'z') {
        event.preventDefault();

        if (event.shiftKey) {
          this.redo();
        } else {
          this.undo();
        }

        return;
      }

      if (key === 'y' && !event.shiftKey) {
        event.preventDefault();
        this.redo();
        return;
      }

      const mark = MARK_SHORTCUTS[key];

      if (mark && !event.shiftKey) {
        event.preventDefault();
        this.toggleMark(mark);
        return;
      }

      if (event.shiftKey && key === 'x') {
        event.preventDefault();
        this.toggleMark('strikethrough');
        return;
      }

      if (key === 'k') {
        event.preventDefault();
        this.openLinkEditor();
        return;
      }

      if (key === 'a' && !event.shiftKey) {
        // First press takes the block's text; a second one takes the blocks.
        const range = getSelectionRange(content);
        const length = richLength(this.#contentOf(resolved));

        if (length === 0 || (range && range.start === 0 && range.end === length)) {
          event.preventDefault();
          this.#setBlockSelection(this.#blocks.map((candidate) => candidate.id));
        }

        return;
      }
    }

    if (CARET_KEYS.has(event.key)) {
      this.#history.breakRun();
    }

    if (resolved.cell && this.#handleTableKeys(event, resolved)) {
      return;
    }

    switch (event.key) {
      case 'Escape': {
        // Only a popover this very host opened. Asking whether one is open
        // anywhere let an Escape typed in an unrelated block close a popover
        // it had never seen — and closing hands the caret back to the block
        // that opened it, so the key silently teleported the user away.
        const own = this.#openPopovers().find((popover) =>
          popover.ownedBy(block.id, resolved.cell),
        );

        if (own) {
          event.preventDefault();
          own.close(true);
        } else if (this.#toolbar.isOpen) {
          event.preventDefault();
          this.#toolbar.hide();
        } else {
          // Nothing transient left to dismiss: step up from text to the block.
          event.preventDefault();
          this.#setBlockSelection([block.id], block.id);
        }

        return;
      }

      case 'Enter':
        if (modifier && block.type === 'todo') {
          event.preventDefault();
          this.toggleTodo(block.id);
          return;
        }

        event.preventDefault();

        if (event.shiftKey || block.type === 'code') {
          this.#insertSoftBreak(block, content);
        } else {
          this.#splitBlock(block, content);
        }

        return;

      case 'Backspace':
        if (isCaretAtStart(content)) {
          event.preventDefault();
          this.#backspaceAtStart(block);
        }

        return;

      case 'Delete':
        if (isCaretAtEnd(content)) {
          event.preventDefault();
          this.#deleteAtEnd(block);
        }

        return;

      case 'Tab': {
        const ids = withHiddenDescendants(this.#blocks, [block.id]);
        const indented = indentBlocks(this.#blocks, ids, event.shiftKey ? -1 : 1);

        // Only swallow Tab when it actually indents. Otherwise the editor would
        // be a keyboard trap (WCAG 2.1.2): Shift+Tab at depth 0 is always
        // available as the way out.
        if (indented.every((next, index) => next.depth === this.#blocks[index]?.depth)) {
          return;
        }

        event.preventDefault();
        this.#commit(indented);
        this.focus(block.id, getCaretOffset(content));
        return;
      }

      case 'ArrowUp':
        if (modifier && event.shiftKey) {
          event.preventDefault();
          this.#moveVisible(new Set([block.id]), -1);
          this.focus(block.id, getCaretOffset(content));
        } else if (event.shiftKey && isCaretAtStart(content)) {
          // Shift-extending past the top of a block selects whole blocks: the
          // browser cannot carry a text selection into another editing host.
          event.preventDefault();
          this.#extendFromTextToBlocks(block.id, -1);
        } else if (isCaretAtStart(content)) {
          this.#moveCaretToSibling(block.id, -1, event);
        }

        return;

      case 'ArrowDown':
        if (modifier && event.shiftKey) {
          event.preventDefault();
          this.#moveVisible(new Set([block.id]), 1);
          this.focus(block.id, getCaretOffset(content));
        } else if (event.shiftKey && isCaretAtEnd(content)) {
          event.preventDefault();
          this.#extendFromTextToBlocks(block.id, 1);
        } else if (isCaretAtEnd(content)) {
          this.#moveCaretToSibling(block.id, 1, event);
        }

        return;

      default:
    }
  };

  #insertSoftBreak(block: Block, content: HTMLElement): void {
    const range = getSelectionRange(content) ?? { start: 0, end: 0 };
    const trimmed = richDelete(block.content, range.start, range.end);
    const next = richInsert(
      trimmed,
      range.start,
      richFromPlainText('\n', richMarksAt(trimmed, range.start)),
    );

    this.#commitContent(block.id, next);
    this.focusRange(block.id, range.start + 1, range.start + 1);
  }

  #splitBlock(block: Block, content: HTMLElement): void {
    // Enter on an empty list item leaves the list rather than extending it.
    if (isRichEmpty(block.content) && isContinuingType(block.type)) {
      this.#commit(setBlockType(this.#blocks, block.id, 'paragraph'));
      this.focus(block.id, 0);
      return;
    }

    const range = getSelectionRange(content) ?? { start: 0, end: 0 };
    const trimmed = richDelete(block.content, range.start, range.end);
    const [before, after] = richSplit(trimmed, range.start);

    // A callout or toggle owns what follows it, so Enter opens a child. It is
    // the only way to put the first block inside an empty one.
    const nested = acceptsChildren(block.type);
    const created = createBlock(
      typeAfterSplit(block.type),
      after,
      nested ? block.depth + 1 : block.depth,
    );

    let blocks = updateBlock(this.#blocks, block.id, { content: before });

    // A child of a collapsed toggle would be born hidden.
    if (nested && block.type === 'toggle' && block.collapsed) {
      blocks = updateBlock(blocks, block.id, { collapsed: false });
    }

    blocks = insertBlockAfter(blocks, block.id, created);

    this.#commit(blocks);
    this.focus(created.id, 0);
  }

  #backspaceAtStart(block: Block): void {
    // Outdent before any destructive edit.
    if (block.depth > 0) {
      this.#commit(indentBlock(this.#blocks, block.id, -1));
      this.focus(block.id, 0);
      return;
    }

    // Retyping to a paragraph is the "undo this block type" gesture, and it is
    // only non-destructive while the text *is* the block. An image's caption
    // sits beside a payload a paragraph cannot hold, so `setBlockType` drops
    // `src` and `alt`: one Backspace in the caption deleted the picture. Step
    // up to the block instead — deleting it stays one keystroke away, but it
    // has to be asked for.
    if (!canMergeText(block.type)) {
      this.#setBlockSelection([block.id], block.id);
      return;
    }

    if (block.type !== 'paragraph') {
      this.#commit(setBlockType(this.#blocks, block.id, 'paragraph'));
      this.focus(block.id, 0);
      return;
    }

    // Resolved over what the reader can see: merging into a block hidden inside
    // a collapsed toggle would make this paragraph vanish for no visible reason.
    const visible = this.#visible();
    const index = findBlockIndex(visible, block.id);
    const previous = index > 0 ? visible[index - 1] : undefined;

    if (!previous) {
      return;
    }

    // A divider has no text to merge into, so backspace just removes it.
    if (isVoidType(previous.type)) {
      this.#commit(removeBlock(this.#blocks, previous.id));
      this.focus(block.id, 0);
      return;
    }

    // A table or an image cannot absorb text. Select it instead of destroying it.
    if (!canMergeText(previous.type)) {
      this.#setBlockSelection([previous.id], previous.id);
      return;
    }

    const joinAt = richLength(previous.content);
    let blocks = updateBlock(this.#blocks, previous.id, {
      content: richConcat(previous.content, block.content),
    });
    // No re-clamp here, unlike `#deleteAtEnd`: this path is only ever reached
    // at depth 0 — anything deeper outdents above rather than merging — and
    // removing a depth-0 block leaves its successor at depth 1 at most, which
    // any predecessor can carry.
    blocks = removeBlock(blocks, block.id);

    this.#commit(blocks);
    this.focus(previous.id, joinAt);
  }

  #deleteAtEnd(block: Block): void {
    const visible = this.#visible();
    const index = findBlockIndex(visible, block.id);
    const next = visible[index + 1];

    if (!next) {
      return;
    }

    if (isVoidType(next.type)) {
      this.#commit(normalizeDepths(removeBlock(this.#blocks, next.id)));
      this.focus(block.id, CARET_END);
      return;
    }

    // A table or an image holds no mergeable text; selecting it is the only
    // non-destructive reading of Delete here.
    if (!canMergeText(next.type)) {
      this.#setBlockSelection([next.id], next.id);
      return;
    }

    const joinAt = richLength(block.content);
    let blocks = updateBlock(this.#blocks, block.id, {
      content: richConcat(block.content, next.content),
    });
    // Deleting the neighbour takes its depth step with it: anything nested
    // under it is left more than one level below this block, which is exactly
    // the state `normalizeDepths` exists to make impossible.
    blocks = normalizeDepths(removeBlock(blocks, next.id));

    this.#commit(blocks);
    this.focus(block.id, joinAt);
  }

  #moveCaretToSibling(id: string, direction: 1 | -1, event: KeyboardEvent): void {
    // Hidden blocks are not places a caret can go.
    const visible = this.#visible();
    const index = findBlockIndex(visible, id);
    const slice =
      direction === -1 ? visible.slice(0, Math.max(0, index)).reverse() : visible.slice(index + 1);
    const target = slice.find((block) => !isVoidType(block.type));

    if (!target) {
      return;
    }

    event.preventDefault();
    this.focus(target.id, direction === -1 ? CARET_END : 0);
  }

  #handleFocusIn = (event: FocusEvent): void => {
    const resolved = this.#resolve(event.target);

    if (resolved) {
      this.#emitter.emit('focus', { blockId: resolved.block.id });
    }
  };

  /** Clicking the empty space under the last block starts a new paragraph. */
  #handleRootMouseDown = (event: MouseEvent): void => {
    // Any click repositions the caret, which ends the current typing run.
    this.#history.breakRun();

    // The gutter has its own selection semantics; do not undo them here.
    if (this.#gutter.contains(isNode(event.target) ? event.target : null)) {
      return;
    }

    // Clicking into the document is a return to text editing.
    this.#clearBlockSelection();

    if (event.target !== this.#root || !this.#editable) {
      return;
    }

    const last = this.#visible().at(-1);

    if (last && canMergeText(last.type) && isRichEmpty(last.content)) {
      event.preventDefault();
      this.focus(last.id, 0);
      return;
    }

    event.preventDefault();
    const created = createBlock('paragraph');
    this.#commit([...this.#blocks, created]);
    this.focus(created.id, 0);
  };

  #handleSelectionChange = (): void => {
    // Focus is in the link input; the block selection is intentionally stale.
    if (this.#linkEditor.isOpen) {
      return;
    }

    // Only a programmatically built cross-host range reaches here; drags are
    // handled as they happen, and shift-arrow at a block edge in #handleKeyDown.
    if (!this.#pointerDown && this.#promoteCrossBlockSelection()) {
      return;
    }

    const target = this.#selectionTarget();

    // Armed formatting belongs to one exact caret position.
    if (
      this.#pending &&
      (!target ||
        target.block.id !== this.#pending.blockId ||
        !sameCell(target.cell, this.#pending.cell) ||
        target.range.start !== this.#pending.offset ||
        target.range.start !== target.range.end)
    ) {
      this.#pending = null;
    }

    if (this.#slashContext && target?.block.id !== this.#slashContext.blockId) {
      this.#closeSlashMenu();
    }

    this.#syncToolbar();
    this.#emitter.emit('selection', this.getSelectionState());
  };

  /** Hides both floating toolbars; used when either takes over. */
  #hideTableToolbar(): void {
    this.#tableToolbar.hide();
    this.#activeCell = null;
  }
}
