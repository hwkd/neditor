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
  moveBlock,
  moveBlocks,
  normalizeDepths,
  normalizeDocument,
  removeBlock,
  removeBlocks,
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
import { formatLabel, resolveLabels } from './labels.ts';
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

/** One editable host: a block's own content, or a single table cell. */
interface ResolvedTarget {
  readonly block: Block;
  readonly content: HTMLElement;
  readonly cell?: { row: number; column: number };
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

/** Reads the `row:column` a cell host carries, if it is one. */
function parseCellCoords(host: HTMLElement): { row: number; column: number } | undefined {
  const parts = host.dataset.cell?.split(':').map(Number);

  if (!parts || parts.length !== 2 || !parts.every(Number.isInteger)) {
    return undefined;
  }

  return { row: parts[0] ?? 0, column: parts[1] ?? 0 };
}

/** Formatting that applies to the current selection. */
export interface SelectionState {
  readonly blockId: string;
  readonly range: OffsetRange;
  readonly marks: readonly Mark[];
  readonly link: string | null;
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
 * Groups a burst of same-kind input in one block into a single undo step.
 *
 * Typing folds with typing and deleting with deleting, but never across each
 * other, so typing a word and then correcting it stays two undo steps.
 */
function inputRunKey(event: Event, blockId: string): string | null {
  const inputType = hasInputType(event) ? event.inputType : '';

  if (inputType.startsWith('insert')) {
    return `insert:${blockId}`;
  }

  if (inputType.startsWith('delete')) {
    return `delete:${blockId}`;
  }

  return null;
}

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
    cell?: { row: number; column: number };
  } | null = null;

  /**
   * Formatting armed at a collapsed caret.
   *
   * Pressing ⌘B with nothing selected cannot change any existing character, so
   * the intent is parked here and applied to the next typed run. It is tied to
   * an exact position: move the caret and it is discarded.
   */
  #pending: { blockId: string; offset: number; marks: Mark[] } | null = null;

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
    this.#labels = resolveLabels(options.labels);
    this.#blocks = normalizeDocument(options.doc ?? createEmptyDocument()).blocks;

    if (options.injectStyles ?? true) {
      // Resolved from the mount point, so an editor inside a shadow root gets
      // its styles in that tree rather than a document head it cannot see.
      injectStyles(element, options.styleNonce);
    }

    const theme = options.theme ?? 'auto';
    this.#root.classList.add('neditor');
    this.#root.dataset.neditorTheme = theme;

    if (!this.#root.hasAttribute('aria-label') && !this.#root.hasAttribute('aria-labelledby')) {
      this.#root.setAttribute('aria-label', options.label ?? this.#labels.editor);
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

    const portalRoot = options.portalContainer ?? this.#document.body;

    for (const portal of [
      this.#slashMenu,
      this.#toolbar,
      this.#linkEditor,
      this.#iconPicker,
      this.#imageEditor,
      this.#tableToolbar,
    ]) {
      portal.setTheme(theme);
      portalRoot.append(portal.element);
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

      this.#pending = { blockId: block.id, offset: range.start, marks };
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

  /** Focuses a block, or the first editable one when no id is given. */
  focus(id?: string, offset = 0): void {
    const target = id ?? this.#visible().find((block) => !isVoidType(block.type))?.id;

    if (!target) {
      return;
    }

    const view = this.#renderer.getView(target);

    if (!view?.content) {
      return;
    }

    view.content.focus({ preventScroll: true });
    setCaretOffset(view.content, offset);
    this.#emitter.emit('focus', { blockId: target });
  }

  /** Selects a range within a block. */
  focusRange(id: string, start: number, end: number): void {
    const view = this.#renderer.getView(id);

    if (!view?.content) {
      return;
    }

    view.content.focus({ preventScroll: true });
    setSelectionRange(view.content, start, end);
  }

  /** Converts a block to another type, the same edit the slash menu performs. */
  setBlockType(id: string, type: BlockType): void {
    this.#commit(setBlockType(this.#blocks, id, type));
    this.focus(id, CARET_END);
    this.#announce(formatLabel(this.#labels.changedTo, { type: type.replace('_', ' ') }));
  }

  /** Expands or collapses a toggle, hiding or revealing everything under it. */
  toggleCollapsed(id: string): void {
    const block = findBlock(this.#blocks, id);

    if (!block || block.type !== 'toggle') {
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

    if (!block || block.type !== 'callout' || first === undefined) {
      return;
    }

    this.#commit(updateBlock(this.#blocks, id, { icon: first }));
  }

  toggleTodo(id: string): void {
    const block = findBlock(this.#blocks, id);

    if (!block || block.type !== 'todo' || !this.#editable) {
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
  }

  /* ------------------------------------------------------------ internal -- */

  #render(): void {
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

  /** Drops selected ids that the new document no longer contains. */
  #pruneBlockSelection(): void {
    if (this.#selected.size === 0) {
      return;
    }

    const alive = new Set(this.#blocks.map((block) => block.id));
    const kept = [...this.#selected].filter((id) => alive.has(id));

    if (kept.length === this.#selected.size) {
      return;
    }

    this.#selected = new Set(kept);
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

  /** Applies a new block array as a single undoable edit. */
  #commit(blocks: Block[]): void {
    this.#recordHistory();
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
    if (ids.length === 0) {
      this.#clearBlockSelection();
      return;
    }

    this.#setBlockSelection(ids);
  }

  clearBlockSelection(): void {
    this.#clearBlockSelection();
  }

  #orderedSelection(): string[] {
    return this.#blocks.filter((block) => this.#selected.has(block.id)).map((block) => block.id);
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
    // A collapsed toggle's children are invisible, so every operation on it has
    // to carry them or they are silently orphaned.
    this.#selected = withHiddenDescendants(this.#blocks, ids);
    this.#selectionAnchor = anchorId ?? ids[0] ?? null;
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

    const count = this.#selected.size;
    this.#announce(
      count === 1
        ? this.#labels.blockSelected
        : formatLabel(this.#labels.blocksSelected, { count }),
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

  /** Leaves block selection, putting the caret back into a block. */
  #exitBlockSelection(blockId?: string, offset = 0): void {
    const target = blockId ?? this.#orderedSelection()[0];
    this.#clearBlockSelection();

    if (target) {
      this.focus(target, offset);
    }
  }

  /** Handle click: plain selects, shift extends, modifier toggles. */
  #selectFromHandle(blockId: string, event: MouseEvent): void {
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
    const next = removeBlocks(this.#blocks, this.#selected);

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
    const result = duplicateBlocks(this.#blocks, this.#selected);

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
    const kept = this.#blocks.filter((block) => !this.#selected.has(block.id));

    this.#commit(normalizeDepths(insertBlockAt(kept, index, created)));
    this.#clearBlockSelection();
    this.focus(created.id, CARET_END);
  }

  #moveSelectedBlocks(direction: 1 | -1): void {
    const ordered = this.#orderedSelection();
    const firstId = ordered[0];
    const lastId = ordered.at(-1);

    if (!firstId || !lastId) {
      return;
    }

    // Gaps are in original coordinates: one above the first, two past the last.
    const gap =
      direction === -1
        ? findBlockIndex(this.#blocks, firstId) - 1
        : findBlockIndex(this.#blocks, lastId) + 2;

    if (gap < 0 || gap > this.#blocks.length) {
      return;
    }

    this.#commit(moveBlocks(this.#blocks, this.#selected, gap));
  }

  #stepBlockSelection(direction: 1 | -1): void {
    const ordered = this.#orderedSelection();
    const edge = direction === -1 ? ordered[0] : ordered.at(-1);

    if (!edge) {
      return;
    }

    const visible = this.#visible();
    const target = visible[findBlockIndex(visible, edge) + direction];

    if (target) {
      this.#setBlockSelection([target.id], target.id);
    }
  }

  #extendBlockSelection(direction: 1 | -1): void {
    const ordered = this.#orderedSelection();
    const anchorId = this.#selectionAnchor ?? ordered[0];

    if (!anchorId) {
      return;
    }

    // The moving edge is whichever end is not the anchor.
    const focusId = ordered[0] === anchorId ? (ordered.at(-1) ?? anchorId) : ordered[0];
    const visible = this.#visible();
    const target = visible[findBlockIndex(visible, focusId ?? anchorId) + direction];

    if (target) {
      this.#setBlockSelection(blockIdRange(this.#blocks, anchorId, target.id), anchorId);
    }
  }

  #handleBlockSelectionKeys(event: KeyboardEvent): void {
    const modifier = event.metaKey || event.ctrlKey;
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
        const indented = indentBlocks(this.#blocks, this.#selected, event.shiftKey ? -1 : 1);

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

  #closeImageEditor(): void {
    const id = this.#imageContext;

    this.#imageEditor.close();
    this.#imageContext = null;

    if (id) {
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
    this.#commit(updateBlock(this.#blocks, block.id, { rows: next }));
    this.#announce(this.#labels[TABLE_COMMAND_ANNOUNCEMENTS[command]]);

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
        if (event.shiftKey) {
          return false;
        }

        event.preventDefault();
        const grown = tableInsertRow(rows, rows.length);
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

  #closeIconPicker(): void {
    const id = this.#iconContext;

    this.#iconPicker.close();
    this.#iconContext = null;

    // The picker took focus on open; hiding it would otherwise leave focus on
    // document.body and lose the user's place.
    if (id) {
      this.focus(id, CARET_END);
    }
  }

  /* ------------------------------------------------------------ clipboard -- */

  #handleCopy = (event: ClipboardEvent): void => {
    if (this.#selected.size === 0 || !event.clipboardData) {
      return;
    }

    event.preventDefault();

    const doc = sliceDocument(this.#blocks, this.#selected);
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

  #handlePointerLeave = (): void => {
    if (!this.#drag) {
      this.#gutter.hide();
    }
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

  #handleDocumentPointerDown = (): void => {
    this.#pointerDown = true;
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
    if (event.pointerType === 'touch' && anchorBlockId) {
      this.#positionGutter(anchorBlockId);
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
    const sibling = this.#blocks[findBlockIndex(this.#blocks, blockId) + direction];

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
    this.#drag = null;
    this.#gutter.setDragging(false);
    delete this.#root.dataset.dragging;
    this.#dropIndicator.hidden = true;

    if (commit) {
      this.#commit(moveBlocks(this.#blocks, commit.ids, commit.gap));
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

    this.#setBlockSelection(blockIdRange(this.#blocks, from, to), from);
    return true;
  }

  #restoreSelection(snapshot: SelectionSnapshot | null): void {
    // The block may not exist in the restored document.
    if (!snapshot || !findBlock(this.#blocks, snapshot.blockId)) {
      return;
    }

    if (snapshot.cell) {
      this.#focusCell(
        snapshot.blockId,
        snapshot.cell.row,
        snapshot.cell.column,
        snapshot.start,
        snapshot.end,
      );
      return;
    }

    this.focusRange(snapshot.blockId, snapshot.start, snapshot.end);
  }

  #commitContent(id: string, content: RichText): void {
    this.#commit(updateBlock(this.#blocks, id, { content }));
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
    const content = this.#hostFromNode(node) ?? this.#renderer.getView(id)?.content;

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

  /** Writes rich text back to wherever it came from, as one undoable edit. */
  #commitResolved(target: ResolvedTarget, content: RichText): void {
    if (!target.cell) {
      this.#commitContent(target.block.id, content);
      return;
    }

    const rows = tableSetCell(
      target.block.rows ?? [],
      target.cell.row,
      target.cell.column,
      content,
    );

    this.#commit(updateBlock(this.#blocks, target.block.id, { rows }));
  }

  /** Places the caret in a table cell. */
  #focusCell(id: string, row: number, column: number, start: number, end = start): void {
    const host = this.#renderer.getView(id)?.cells?.[row]?.[column];

    if (!host) {
      return;
    }

    host.focus({ preventScroll: true });
    setSelectionRange(host, start, end);
  }

  /** Restores a selection to whichever host it came from. */
  #focusResolved(target: ResolvedTarget, start: number, end = start): void {
    if (target.cell) {
      this.#focusCell(target.block.id, target.cell.row, target.cell.column, start, end);
    } else {
      this.focusRange(target.block.id, start, end);
    }
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

    // An input event that changed nothing is not an edit worth undoing.
    if (event && !richEquals(this.#contentOf(resolved), parsed)) {
      const scope = cell ? `${id}:${cell.row}:${cell.column}` : id;
      this.#recordHistory(inputRunKey(event, scope), this.#selectionBeforeInput);
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

    const pending = this.#pending;

    if (!pending) {
      return;
    }

    if (event.inputType !== 'insertText' || typeof event.data !== 'string') {
      return;
    }

    const resolved = this.#resolve(event.target);
    const range = resolved ? getSelectionRange(resolved.content) : null;

    if (!resolved || !range || resolved.block.id !== pending.blockId) {
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

    this.#recordHistory(`insert:${resolved.block.id}`, this.#selectionBeforeInput);
    this.#commitResolved(resolved, next);
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

    // The slash menu and block rules act on a block; a cell has neither.
    if (!cell) {
      if (this.#slashContext?.blockId === id) {
        this.#updateSlashQuery(beforeCaret, caret);
        this.#emitChange();
        return;
      }

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

  /** Block-level Markdown shortcuts. Only from a plain paragraph, as in Notion. */
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
    this.#pending = { blockId: target.block.id, offset: end, marks: [] };
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

    this.#slashMenu.setQuery(beforeCaret.slice(context.start + 1));

    const content = this.#renderer.getView(context.blockId)?.content;

    if (content) {
      this.#describeSlashMenu(content);
    }
  }

  /**
   * Wires the combobox relationship onto the block being typed in.
   *
   * The menu is a portal, so without this a screen reader has no way to know it
   * opened, what it contains, or which option is highlighted.
   */
  #describeSlashMenu(content: HTMLElement): void {
    content.setAttribute('role', 'combobox');
    content.setAttribute('aria-expanded', 'true');
    content.setAttribute('aria-haspopup', 'listbox');
    content.setAttribute('aria-controls', this.#slashMenu.listId);

    const active = this.#slashMenu.activeOptionId;

    if (active) {
      content.setAttribute('aria-activedescendant', active);
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

    const block = findBlock(this.#blocks, context.blockId);

    this.#linkEditor.close();
    this.#linkContext = null;

    if (!block) {
      return;
    }

    const host = this.#renderer.getView(block.id)?.content;
    const target: ResolvedTarget | null = host
      ? { block, content: host, ...(context.cell ? { cell: context.cell } : {}) }
      : null;

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

  #closeLinkEditor(): void {
    const context = this.#linkContext;

    this.#linkEditor.close();
    this.#linkContext = null;

    if (context) {
      this.focusRange(context.blockId, context.start, context.end);
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

    const id = this.#renderer.blockIdFromNode(anchor);
    // Resolved from the anchor itself: a table has one host per cell, and the
    // view's `content` is only ever the first of them.
    const content = this.#hostFromNode(anchor);
    const offsets = content ? offsetsOfNode(content, anchor) : null;

    if (!id || !offsets) {
      return;
    }

    this.focusRange(id, offsets.start, offsets.end);
    this.openLinkEditor();
  };

  /* ------------------------------------------------------------ clipboard -- */

  #handlePaste = (event: ClipboardEvent): void => {
    if (!this.#editable || !event.clipboardData) {
      return;
    }

    // Always take over: an unhandled paste injects arbitrary markup that the
    // parser would have to guess at, and scripts along with it.
    const html = event.clipboardData.getData('text/html');
    const plain = event.clipboardData.getData('text/plain');

    if (this.#selected.size > 0) {
      event.preventDefault();
      this.#pasteOverBlockSelection(html, plain);
      return;
    }

    const resolved = this.#resolve(event.target);

    if (!resolved) {
      return;
    }

    event.preventDefault();

    const pasted = this.#parseClipboard(html, plain);

    if (pasted.length === 0) {
      return;
    }

    // A cell holds text, so structure flattens rather than splitting the table.
    if (resolved.cell) {
      const literal = plain.length > 0 ? plain : pasted.map(blockText).join('\n');
      this.#pasteInline(resolved, richFromPlainText(literal));
      return;
    }

    // A code block is literal: pasted structure becomes text, never blocks.
    if (resolved.block.type === 'code') {
      const literal = plain.length > 0 ? plain : pasted.map(blockText).join('\n');
      this.#pasteInline(resolved, richFromPlainText(literal));
      return;
    }

    const only = pasted.length === 1 ? pasted[0] : undefined;

    // A lone paragraph is a phrase, not a document: keep it in this block so
    // pasting mid-sentence still works.
    if (only && only.type === 'paragraph') {
      this.#pasteInline(resolved, only.content);
      return;
    }

    this.#pasteBlocks(resolved.block, resolved.content, pasted);
  };

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
   */
  #pasteBlocks(target: Block, content: HTMLElement, pasted: Block[]): void {
    const range = getSelectionRange(content) ?? { start: 0, end: 0 };
    const trimmed = richDelete(target.content, range.start, range.end);
    const [before, after] = richSplit(trimmed, range.start);
    const [first, ...rest] = pasted;

    if (!first) {
      return;
    }

    // Pasting into a genuinely empty block replaces it outright. Retyping it
    // through setBlockType would rebuild the payload from the *target*, which
    // blanks a pasted table's rows and an image's src.
    const replaceable = isRichEmpty(trimmed) && target.type !== 'table' && target.type !== 'image';

    // The id is the target's and stays put; only the payload is replaced.
    const { id: _pastedId, ...payload } = cloneBlock(first);

    let blocks = replaceable
      ? updateBlock(this.#blocks, target.id, {
          ...payload,
          depth: target.depth,
          content: rest.length === 0 ? richConcat(first.content, after) : first.content,
        })
      : updateBlock(this.#blocks, target.id, {
          content:
            rest.length === 0
              ? richConcat(before, first.content, after)
              : richConcat(before, first.content),
        });

    const created = rest.map((block, index) => ({
      ...cloneBlock(block),
      depth: target.depth + block.depth,
      content: index === rest.length - 1 ? richConcat(block.content, after) : block.content,
    }));

    let at = findBlockIndex(blocks, target.id);

    for (const block of created) {
      at += 1;
      blocks = insertBlockAt(blocks, at, block);
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

    let blocks = this.#blocks.filter((block) => !this.#selected.has(block.id));
    let at = index;

    for (const block of created) {
      blocks = insertBlockAt(blocks, at, block);
      at += 1;
    }

    this.#commit(normalizeDepths(blocks));
    this.#setBlockSelection(created.map((block) => block.id));
  }

  /* ------------------------------------------------------------ keyboard -- */

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
    const modifier = event.metaKey || event.ctrlKey;

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
      case 'Escape':
        if (this.#linkEditor.isOpen) {
          event.preventDefault();
          this.#closeLinkEditor();
        } else if (this.#toolbar.isOpen) {
          event.preventDefault();
          this.#toolbar.hide();
        } else {
          // Nothing transient left to dismiss: step up from text to the block.
          event.preventDefault();
          this.#setBlockSelection([block.id], block.id);
        }

        return;

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
          this.#commit(moveBlock(this.#blocks, block.id, -1));
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
          this.#commit(moveBlock(this.#blocks, block.id, 1));
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
    // Outdent before any destructive edit, matching Notion.
    if (block.depth > 0) {
      this.#commit(indentBlock(this.#blocks, block.id, -1));
      this.focus(block.id, 0);
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
      this.#commit(removeBlock(this.#blocks, next.id));
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
    blocks = removeBlock(blocks, next.id);

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
