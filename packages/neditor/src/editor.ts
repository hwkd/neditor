import { matchTypedInlineRule } from './input/inline-rules.ts';
import { matchInputRule } from './input/input-rules.ts';
import { blocksFromMarkdown } from './input/markdown.ts';
import { normalizeControlCharacters } from './input/line-breaks.ts';
import type { Block, BlockType, NEditorDocument } from './model/document.ts';
import {
  DEFAULT_CALLOUT_ICON,
  MAX_DEPTH,
  acceptsChildren,
  blockIdRange,
  canMergeText,
  blockText,
  contentForType,
  cloneBlock,
  cloneDocument,
  createBlock,
  createEmptyDocument,
  descendantsOf,
  findBlock,
  findBlockIndex,
  duplicateBlocks,
  indentBlocks,
  insertBlockAfter,
  insertBlockAt,
  isBlockType,
  isContinuingType,
  isLiteralType,
  isRichEmpty,
  isTableType,
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
import type { Mark, RichText, TextRun } from './model/rich-text.ts';
import {
  isMathRun,
  normalizeRuns,
  richActiveLink,
  richActiveMarks,
  richConcat,
  richDelete,
  richEquals,
  richFromPlainText,
  richInsert,
  richLength,
  richLinkAt,
  richMarksAt,
  richMath,
  richSetLink,
  richSetMark,
  richSlice,
  richSplit,
  richToPlainText,
  richToSourceText,
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
import { MathEditor } from './ui/math-editor.ts';
import type { AnchorRect, PortalTheme } from './ui/portal.ts';
import { PORTAL_GAP_PX, holdsFocus, pinAnchor, setAnchorBand, setAnchorView } from './ui/portal.ts';
import type { SlashCommand } from './ui/slash-menu.ts';
import { SlashMenu } from './ui/slash-menu.ts';
import type { TableCommand } from './ui/table-toolbar.ts';
import { TableToolbar } from './ui/table-toolbar.ts';
import type { MathRenderer } from './view/math.ts';
import { Renderer } from './view/renderer.ts';
import { blocksFromHtml, blocksToHtml, parseRichText, richTextToHtml } from './view/rich-dom.ts';
import type { OffsetRange } from './view/selection.ts';
import type { SelectionReading, TreeSelection } from './view/selection.ts';
import {
  carryOffset,
  carryRange,
  caretX,
  getCaretOffset,
  getSelectionEnds,
  getSelectionRange,
  selectionFor,
  readSelection,
  readSelectionAnchor,
  readSelectionEnds,
  isCaretAtEnd,
  isCaretAtStart,
  isOnEdgeLine,
  isSoftWrap,
  softWrapLine,
  softWrapSides,
  lineMiddle,
  offsetAt,
  offsetsOfNode,
  offsetWithin,
  placeCaretOnLine,
  locate,
  setCaretOffset,
  setSelectionRange,
} from './view/selection.ts';
import { Emitter } from './util/emitter.ts';
import { asElement, hasInputType, isElement, isNode, isShadowRoot } from './util/dom.ts';
import { farUnit, firstGrapheme } from './util/grapheme.ts';
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
   * Defaults to the mount point's own root node: `document.body` for an
   * ordinary mount, and the shadow root for an editor inside a custom element
   * -- where appending to the body instead would leave every popover outside
   * the tree that carries the styles. A modal `<dialog>`, an open `popover`
   * or a fullscreen element is promoted to the top layer and paints above any
   * z-index, portals in the body included, so for an editor inside one pass
   * that element itself to keep them visible.
   */
  portalContainer?: HTMLElement | ShadowRoot;
  /** `nonce` for the injected `<style>`, for a strict `style-src` policy. */
  styleNonce?: string;
  /**
   * Draws TeX for inline formulas and display equations.
   *
   * `@neditor/core` has no dependencies, so it ships no math typesetter: pass
   * one in. With KaTeX that is
   * `(tex, { displayMode }) => katex.renderToString(tex, { displayMode, throwOnError: true })`:
   * a throw is how the editor learns the TeX is invalid and says so in words,
   * where KaTeX's own red error under `throwOnError: false` reaches no screen
   * reader.
   * Without one, formulas still work -- they are typed, stored, copied and
   * exported as TeX -- and are shown as their TeX source.
   *
   * What it returns is drawn and never read back: the document stores TeX
   * alone. It is called with TeX from the document, which is untrusted, and a
   * string it returns is inserted as HTML, so it must produce safe markup for
   * any input (KaTeX does unless its `trust` option is enabled).
   */
  renderMath?: MathRenderer;
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

/** A press in a block's text that may grow into a block selection. */
interface TextDrag {
  readonly anchorBlockId: string;
  readonly pointerId: number;
  currentId: string | null;
  /**
   * The host and caret the press landed on -- for a press outside every host,
   * the caret the editor placed for it; for a press with Shift, the anchor
   * the browser gave the selection for it, the end of its range farther from
   * the press (`#noteDragAnchor`) -- handed back as text on return. A Shift
   * press on another host than the one holding the reader's caret or range,
   * while it holds focus, has no drag at all; one with no such caret or
   * range is a plain press, its drag placed by the editor
   * (`#handleRootMouseDown`).
   */
  readonly anchorHost: HTMLElement | null;
  anchorPoint: CaretPoint | null;
  /**
   * A press with Shift whose anchor is the browser's to choose, still to be
   * read once its default action has run (`#noteDragAnchor`).
   */
  anchorPending: boolean;
  /** Whether the press had Shift: its anchor is the browser's (`#noteDragAnchor`). */
  readonly shift: boolean;
  /**
   * Which end of the range the drag is anchored at (`#anchorEndOf`), read
   * just before a peer's update redraws the host (`setDocument`), so that
   * the same end of the carried range takes it (`#resumeTextDrag`): for a
   * press with Shift, and for any press where the selection reports no
   * direction. Null for a caret, where neither end is the anchor, and for
   * a press without Shift wherever the selection says which end it is.
   */
  anchorEnd: 'start' | 'end' | null;
  /** True while the gesture is a block selection rather than text. */
  promoted: boolean;
  /** True once it has come back to its own block as text after being one. */
  returned: boolean;
  /**
   * True when the press missed every host and the editor placed the caret
   * itself (`#handleRootMouseDown`). That press's default was cancelled, so
   * the browser draws no drag selection and does not autoscroll for it:
   * every move inside the anchor block is drawn here instead.
   */
  readonly placed: boolean;
  /** Where the press landed, in viewport coordinates. */
  readonly startX: number;
  readonly startY: number;
  /**
   * True while a press the editor placed has not yet travelled
   * `DRAG_THRESHOLD_PX`: until then it is a click, and moves neither draw a
   * range nor follow the pointer. A click on a list marker in the edge band
   * with a pixel of jitter otherwise started the autoscroll, and the scroll
   * carried the blocks past the resting pointer into a block selection.
   */
  still: boolean;
  /**
   * The press's click count, from its `mousedown` (a `pointerdown`'s `detail`
   * is 0): 2 selects by word, 3 or more by paragraph.
   */
  detail: number;
  /**
   * The word or paragraph the browser itself selected for a multi-click
   * press, by its own rules, read once before the drag's first move
   * (`#noteDragUnit`) and carried through every peer's update to the host
   * (`#resumeTextDrag`), with the host text it is an offset into. Whenever
   * the editor draws the drag it selects by that unit (`#returnTextDrag`).
   * Null for a press with Shift that left the reader's range, ends and
   * direction, as it was at the press (`heldRange`; Chromium's and WebKit's
   * Shift+double-click, and a Firefox re-anchor that happens to equal it):
   * that drag goes by character.
   */
  unit: { start: number; end: number; text: string } | null;
  /** Whether the unit has been read: only before the first move is it the browser's. */
  unitRead: boolean;
  /**
   * For a press with Shift, the reader's range in the pressed host as it
   * stood at the press's own `pointerdown`: its offsets and its direction
   * (`#noteDragUnit`).
   */
  heldRange: (OffsetRange & { backward: boolean }) | null;
  /**
   * The caret under the pointer a drag the editor draws last found in its
   * host (`#returnTextDrag`), for a move that finds none: the range is drawn
   * to it again. Forgotten when the drag leaves for other blocks; after a
   * peer's update that redraws the text, the far end of the range as it
   * was carried (`#resumeTextDrag`).
   */
  lastFocus: CaretPoint | null;
  /**
   * True while the last hit test of a drag the editor draws found no caret
   * in its host (`#returnTextDrag`): something of the page's is over the
   * text there. The edge autoscroll stands still meanwhile
   * (`#runAutoScroll`).
   */
  missed: boolean;
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

/**
 * Whether a press landed on a scrollbar of the element it was dispatched to.
 *
 * Engines with classic scrollbars send the press to the scroller itself: a
 * wide table's wrapper, or a fixed-height root. Its scrollbars are the part of
 * its border box that is neither border nor client area: as wide as the
 * difference between the two, at the bottom, and at the right -- or the left,
 * where an RTL box keeps its vertical one. Which side is read from the
 * direction alone: Chromium and WebKit both draw an RTL box's bar on the left
 * (Firefox overlays it, which takes no room), and `clientLeft` is no witness
 * -- WebKit reports only the border there for an RTL box, and at `zoom: 0.6`
 * reports 2 for a 1px border on an LTR one, which read its bar as on the left
 * and let a press on the real one move the caret. An element with no
 * scrolling overflow style has none, and an inline one reports no client box
 * at all, so both say no.
 *
 * Measured in the element's own CSS pixels: the press is mapped into them by
 * the ratio of its drawn box to its layout box, because a `transform: scale()`
 * or a `zoom` around the editor scales the first and not the client sizes --
 * at 1.5 a third of the root counted as scrollbar, and at 0.6 a drag on the
 * thumb moved the caret.
 */
function onScrollbar(event: MouseEvent): boolean {
  const element = asElement(event.target) as HTMLElement | null;
  const view = element?.ownerDocument?.defaultView;

  if (!element || !view || !(element.clientWidth > 0 || element.clientHeight > 0)) {
    return false;
  }

  const style = view.getComputedStyle(element);

  if (!/auto|scroll|overlay/.test(`${style.overflowX} ${style.overflowY}`)) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  const width = element.offsetWidth > 0 ? element.offsetWidth : rect.width;
  const height = element.offsetHeight > 0 ? element.offsetHeight : rect.height;
  const x = rect.width > 0 ? ((event.clientX - rect.left) * width) / rect.width : 0;
  const y = rect.height > 0 ? ((event.clientY - rect.top) * height) / rect.height : 0;
  const left = parseFloat(style.borderLeftWidth) || 0;
  const right = parseFloat(style.borderRightWidth) || 0;
  const top = parseFloat(style.borderTopWidth) || 0;
  const bottom = parseFloat(style.borderBottomWidth) || 0;

  if (x < left || x >= width - right || y < top || y >= height - bottom) {
    return false;
  }

  // Client sizes are whole pixels and the border box is not, so a sliver
  // under one pixel is rounding, not a scrollbar.
  const vertical = width - left - right - element.clientWidth;
  const horizontal = height - top - bottom - element.clientHeight;
  const onLeft = style.direction === 'rtl';

  return (
    (vertical >= 1 && (onLeft ? x < left + vertical : x >= width - right - vertical)) ||
    (horizontal >= 1 && y >= height - bottom - horizontal)
  );
}

/** A drag across blocks as a peer's update found it; see `#promotedDragState`. */
interface PromotedDragState {
  readonly visible: string[];
  readonly anchor: { text: string; offset: number } | null;
  readonly follow: FollowState | null;
}

/** The resting pointer a drag follows at a scroll edge; see `#followState`. */
interface FollowState {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly pressY: number | null;
}

/** True when two hosts are the same cell — or both are a block's own content. */
function sameCell(a: CellCoords | undefined, b: CellCoords | undefined): boolean {
  return a?.row === b?.row && a?.column === b?.column;
}

/**
 * Whether an editing host itself is the focused element of its own tree -- a
 * shadow root's, a frame's document's, or the page's.
 *
 * Asked of the host's own root rather than the page's, which retargets
 * anything inside a shadow tree to its host. Exactly the host, not a
 * descendant, as `#syncTableToolbar` asks it.
 */
function holdsOwnFocus(host: Element): boolean {
  const root = host.getRootNode();

  return 'activeElement' in root && (root as Document | ShadowRoot).activeElement === host;
}

/** A table's shape (its row lengths), or null for any other block. */
function tableShape(block: Block): string | null {
  return isTableType(block.type) ? (block.rows ?? []).map((row) => row.length).join(',') : null;
}

/**
 * Whether an event's target is the page itself, which no reader chose: its
 * document's `<body>` or root element, or a `<dialog>` element -- WebKit
 * focuses a modal dialog on a Tab that finds nothing in it to focus, and
 * goes back in history on a Backspace there as on `<body>`. Duck-typed: the
 * page can be another document's (an iframe mount's outer pages).
 */
function isPageTarget(target: EventTarget | null): boolean {
  if (!isElement(target)) {
    return false;
  }

  const doc = target.ownerDocument;

  return target === doc.body || target === doc.documentElement || target.localName === 'dialog';
}

/**
 * Focuses an editing host; true when it holds focus afterwards.
 *
 * Asked twice, because Firefox's first `focus()` on an element in a frame
 * that does not hold focus -- the reader in a portal in the page around an
 * iframe mount, Escape from its table toolbar -- focuses only the frame, and
 * leaves the frame's `<body>` focused inside it. The second lands. (The old
 * code never noticed: the caret it set next made Firefox focus the host.)
 * A host that cannot take focus at all -- read-only, inert -- refuses both.
 */
function focusHost(host: HTMLElement): boolean {
  host.focus({ preventScroll: true });

  if (!holdsOwnFocus(host)) {
    host.focus({ preventScroll: true });
  }

  return holdsOwnFocus(host);
}

/**
 * Of `kept`, the id nearest `lost` in `order` -- the earlier one on a tie --
 * or the first of `kept` when `order` does not hold `lost`; null for none.
 */
function nearestSurvivor(
  order: readonly Block[],
  lost: string,
  kept: readonly string[],
): string | null {
  const positions = new Map(order.map((block, position) => [block.id, position]));
  const from = positions.get(lost);

  if (from === undefined) {
    return kept[0] ?? null;
  }

  let nearest: string | null = null;
  let best = Number.POSITIVE_INFINITY;
  let bestPosition = Number.POSITIVE_INFINITY;

  for (const id of kept) {
    const position = positions.get(id);

    if (position === undefined) {
      continue;
    }

    const distance = Math.abs(position - from);

    if (distance < best || (distance === best && position < bestPosition)) {
      nearest = id;
      best = distance;
      bestPosition = position;
    }
  }

  return nearest ?? kept[0] ?? null;
}

/**
 * The ids of `visible` that `order` holds at or after `index` (in order), and
 * those it holds before it (nearest first) -- where a caret may land after an
 * edit that changed `order` at `index`.
 *
 * A block `order` does not hold is in neither list. It is not "position 0":
 * read that way, a host that renamed every block on `change` put every block
 * before a deletion at block 10, and the caret went to the end of the
 * document, forty blocks down, where the next key was typed.
 */
function splitAt(
  order: readonly Block[],
  visible: readonly Block[],
  index: number,
): { after: string[]; before: string[] } {
  const positions = new Map(order.map((block, position) => [block.id, position]));
  const after: string[] = [];
  const before: string[] = [];

  for (const block of visible) {
    const position = positions.get(block.id);

    if (position === undefined) {
      continue;
    }

    (position >= index ? after : before).push(block.id);
  }

  return { after, before: before.reverse() };
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
/** What an in-flight composition needs to remember; see `#composition`. */
/**
 * True when the element has no implicit ARIA role for a `group` to displace.
 *
 * The root needs a role at all because `generic` -- what a bare `<div>` has --
 * prohibits an accessible name. Getting the rule right took three attempts, and
 * the shape of the mistake is worth keeping: listing the generic elements
 * withheld the role from custom elements, which have none either; inverting
 * that to a list of semantic elements to skip then stamped `group` onto
 * everything absent from a hand-written set -- `<td>`, `<dd>`, `<p>`,
 * `<summary>`, `<label>` -- destroying real semantics on each. The complement
 * of a hand-written list is unbounded, so the rule names what it means instead.
 *
 * A custom element is included because its name must contain a hyphen and it
 * has no implicit role by definition; `<body>` because HTML-AAM maps it to
 * generic too and mounting a full-page editor on it is a real thing to do.
 *
 * This is an under-approximation and stays one deliberately. Other elements map
 * to generic as well -- `<pre>`, `<b>`, `<a>` without an href, an unknown
 * non-hyphenated tag -- and are not listed, because nobody mounts an editor in
 * them and because erring this way costs an accessible name on a host that
 * would never be used, while erring the other way destroys the semantics of
 * hosts that are. The two directions are not symmetric, and the first three
 * attempts at this rule all failed by choosing the wrong one.
 */
function hasGenericRole(element: HTMLElement): boolean {
  const tag = element.tagName;

  return tag === 'DIV' || tag === 'SPAN' || tag === 'BODY' || tag.includes('-');
}

/**
 * Marks a clipboard this editor wrote; see `#handleCopy`. A block copy writes
 * a bare marker here, a text-range copy the runs it took (`#copyTextRange`).
 */
const OWN_CLIPBOARD_TYPE = 'application/x-neditor';

/** A caret a read-only switch took off its block; see `#lockedCaret`. */
interface LockedCaret {
  readonly blockId: string;
  readonly cell?: CellCoords;
  readonly range: OffsetRange;
  readonly backward: boolean;
  /** The host's text when it was taken, to carry the offsets by. */
  readonly text: string;
  /** Its table's shape (`tableShape`): a cell is named by coordinates only. */
  readonly shape: string | null;
  /**
   * Which toolbar was showing when it was taken: an unlock draws again only
   * that one (`#redrawToolbars`), as `setDocument` does.
   */
  readonly formatShown: boolean;
  readonly tableShown: boolean;
  /**
   * Whether it was an image's caption: an unlock gives a caption back only
   * to a block that is still an image, and a block's text only to one that
   * is still not.
   */
  readonly caption: boolean;
  /**
   * A selection WebKit kept in the block while focus was on the page (a page
   * button it gave no focus), rather than a caret the reader was typing at:
   * the lock guarded Backspace for it, and an unlock that finds a selection
   * still in one of the editor's hosts hands the keys back to it
   * (`#resumeKeptSelection`) without moving focus.
   */
  readonly kept: boolean;
}

interface CompositionState {
  /** The editing host it started in, so a reset can ask whether it survived. */
  readonly host: HTMLElement;
  readonly content: RichText;
  readonly selection: SelectionSnapshot | null;
  readonly offset: number;
  readonly pending: {
    readonly blockId: string;
    readonly offset: number;
    readonly marks: readonly Mark[];
    readonly cell?: CellCoords;
  } | null;
  /**
   * What the composed word is written in when it ends, by the rule a typed one
   * follows (`#replacementFormatting`); null leaves it to the browser.
   */
  readonly formatting: Pick<TextRun, 'marks' | 'link'> | null;
}

/** Where a type-over of a link left the caret; see `#typeOver`. */
interface TypingOver {
  readonly blockId: string;
  readonly cell?: CellCoords;
  readonly offset: number;
  /** The host's text as the continuation left it, compared by identity. */
  readonly content: RichText;
  readonly marks?: Mark[];
  readonly link: string;
}

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

    if (block.type === 'table') {
      // A table keeps its text in `rows`, so it has no runs of its own. Its
      // cells' runs are joined, not their plain text: that is each formula as
      // an atom character with its TeX gone.
      (block.rows ?? []).forEach((row, rowIndex) => {
        if (rowIndex > 0) {
          parts.push(richFromPlainText('\n'));
        }

        row.forEach((cell, column) => {
          if (column > 0) {
            parts.push(richFromPlainText('\t'));
          }

          parts.push(cell);
        });
      });
    } else if (block.type === 'image') {
      // Nor does an image, and a cell cannot hold one -- but dropping it left
      // the paste doing nothing at all, with no change event and no sign that
      // anything had been refused. Its caption, then its alt text, then its
      // source, linked to itself: the information survives in the form a cell
      // can take, and in the order that describes the image best. The caption
      // as runs, so its formulas and formatting come too.
      const caption = isRichEmpty(block.content)
        ? richFromPlainText(block.alt || block.src || '')
        : block.content;

      parts.push(block.src ? richSetLink(caption, 0, richLength(caption), block.src) : caption);
    } else if (block.type === 'math') {
      // A cell holds one line of text, and a display equation is a formula
      // on a line of its own: in a cell it becomes that formula, inline.
      parts.push(richMath(richToPlainText(block.content)));
    } else {
      parts.push(block.content);
    }
  }

  // `richConcat(...parts)` spreads every block into one call, which the
  // engine caps; this is what it does, without the cap.
  return normalizeRuns(parts.flat());
}

/** Whether a block carries math: a display equation, or a formula in its runs or cells. */
function holdsMath(block: Block): boolean {
  return (
    block.type === 'math' ||
    block.content.some(isMathRun) ||
    (block.rows ?? []).some((row) => row.some((cell) => cell.some(isMathRun)))
  );
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

/**
 * Pointer travel before a handle press, or a press the editor placed beside the
 * text, becomes a drag rather than a click.
 */
const DRAG_THRESHOLD_PX = 4;

/** How long a touch must rest on a block before it selects it. */
const LONG_PRESS_MS = 500;

/**
 * How long after a pointer is released a focus change still belongs to it.
 *
 * A browser finishing a gesture -- a long press ending, a tap's compatibility
 * events -- can move focus into a block after the pointer is up. That is not
 * the reader choosing the text, so it must not end the block selection the
 * gesture made; a focus with no pointer near it (the keyboard, a screen reader)
 * is, and does.
 */
const POINTER_FOCUS_GRACE_MS = 300;

/** How far a touch may drift and still count as a press rather than a drag. */
const LONG_PRESS_TOLERANCE_PX = 10;

/**
 * The band along a scroll container's top and bottom edges where a drag held
 * still keeps scrolling, and the most it scrolls per frame -- reached at the
 * edge itself and beyond it, so the closer the pointer the faster the page.
 */
const AUTOSCROLL_EDGE_PX = 48;
const AUTOSCROLL_MAX_STEP_PX = 24;

/**
 * How far to autoscroll this frame for a pointer at viewport Y, against the
 * on-screen span `top`..`bottom` of a scroller: negative is up. Zero outside
 * the edge bands, and for a span too short to hold two of them.
 */
function edgeStep(clientY: number, top: number, bottom: number): number {
  const ramp = (into: number) =>
    Math.ceil(
      AUTOSCROLL_MAX_STEP_PX * Math.min(1, (AUTOSCROLL_EDGE_PX - into) / AUTOSCROLL_EDGE_PX),
    );

  if (bottom - top <= AUTOSCROLL_EDGE_PX * 2) {
    return 0;
  }

  if (clientY > bottom - AUTOSCROLL_EDGE_PX) {
    return ramp(bottom - clientY);
  }

  if (clientY < top + AUTOSCROLL_EDGE_PX) {
    return -ramp(clientY - top);
  }

  return 0;
}

/** The depth of the shallowest of some blocks: a fold, never a spread. */
export function shallowest(blocks: readonly Block[]): number {
  // Spread into `Math.min`, a paste of 140,000 list items overflowed the
  // call stack and pasted nothing.
  return blocks.reduce((least, block) => Math.min(least, block.depth), Infinity);
}

/**
 * The depths pasted blocks go in at, below a block at `base`: the paste's own
 * shape, each block measured from the shallowest one so far, with the first at
 * `base` and none more than one level below the one before it.
 *
 * Every way a paste lands uses this. Each had its own sum before, and each
 * was wrong somewhere: `base + depth` put a paste that starts nested
 * (`<ul><ul><li>`, a drag begun in a sub-item) inside the block before it --
 * a collapsed toggle there, where nobody saw it; rebasing on the first block
 * alone flattened everything after a shallower one; and measuring from the
 * shallowest block of the whole paste put a block that climbs back up (`a`
 * at 2, `b` at 1, `c` at 0) under the one before it -- `b` became `a`'s child,
 * and a block after a pasted collapsed toggle went inside it.
 */
export function pastedDepths(pasted: readonly Block[], base: number): number[] {
  const depths: number[] = [];
  let least = Infinity;

  for (const block of pasted) {
    least = Math.min(least, block.depth);
    const previous = depths.at(-1);
    depths.push(previous === undefined ? base : Math.min(base + block.depth - least, previous + 1));
  }

  return depths;
}

/**
 * Opens each collapsed toggle the paste brought that would hide one of
 * `shown`: the reader's own blocks after the paste, and the pasted block the
 * reader's text after the caret went into. Ending in a closed `<details>`, a
 * paste took the list item's sub-items under its fold, or the selected
 * toggle's visible child, and they were gone from view.
 */
function openPastedFolds(
  blocks: Block[],
  pasted: ReadonlySet<string>,
  shown: ReadonlyArray<string | undefined>,
): Block[] {
  const open = new Set<string>();

  for (const id of shown) {
    const at = id === undefined ? -1 : findBlockIndex(blocks, id);
    let depth = blocks[at]?.depth ?? 0;

    for (let index = at - 1; index >= 0 && depth > 0; index -= 1) {
      const block = blocks[index]!;

      if (block.depth < depth) {
        if (block.collapsed && pasted.has(block.id)) {
          open.add(block.id);
        }

        depth = block.depth;
      }
    }
  }

  return open.size === 0
    ? blocks
    : blocks.map((block) => (open.has(block.id) ? { ...block, collapsed: false } : block));
}

/** Keys pressed on their own only to change what the next key types. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock']);

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
 * Elements that can be focusable in sequential order. A candidate list, not
 * the answer: each is still asked for its effective `tabIndex`, `:disabled`,
 * `inert` and whether it renders (see `#tabbablesOutside`).
 */
const NATIVE_TABBABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'iframe',
  'summary',
  'audio[controls]',
  'video[controls]',
].join(', ');

const TABBABLE_SELECTOR = `${NATIVE_TABBABLE_SELECTOR}, [contenteditable], [tabindex]`;

/**
 * The candidate Tab stops of `scope` in the order sequential focus visits
 * them, split at `edge`, which is left out with everything inside it.
 *
 * Tree order, but through the open shadow roots in it: a host's shadow tree
 * stands where the host is, and a slot's assigned elements where the slot is,
 * as they are drawn. A host that delegates focus is a stop itself, ahead of
 * what is inside it -- `focus()` on it lands on its first control, which is
 * where a forward Tab goes, and its last control comes first going backward.
 * A host with a negative tabindex is no way in: its shadow tree is passed
 * over with it.
 *
 * A closed shadow root cannot be read -- `shadowRoot` is `null` from outside
 * it -- and that is a documented limit, not something this can work around:
 * such a host looks like an ordinary element, so the controls inside its
 * closed tree are never candidates, and its own light-DOM children are walked
 * in place, which for a host with `tabindex="-1"` offers a slotted control the
 * browser's Tab would pass over.
 */
function composedTabOrder(
  scope: Document | ShadowRoot,
  edge: Element,
): { before: HTMLElement[]; after: HTMLElement[] } {
  const before: HTMLElement[] = [];
  const after: HTMLElement[] = [];
  let passed = false;

  const visit = (elements: Iterable<Element>): void => {
    for (const element of elements) {
      if (element === edge) {
        passed = true;
        continue;
      }

      const shadow = element.shadowRoot;

      if (element.matches(TABBABLE_SELECTOR) || shadow?.delegatesFocus) {
        (passed ? after : before).push(element as HTMLElement);
      }

      // A shadow host taken out of the tab order by its own tabindex takes its
      // shadow tree with it, and what is slotted there: the browser's Tab
      // never stops inside one, delegating focus or not. Only a host -- an
      // ordinary element's tabindex=-1 leaves its children where they are.
      if (shadow && element.hasAttribute('tabindex') && (element as HTMLElement).tabIndex < 0) {
        continue;
      }

      const assigned =
        element.localName === 'slot'
          ? ((element as HTMLSlotElement).assignedElements?.({ flatten: true }) ?? [])
          : [];

      visit(shadow ? shadow.children : assigned.length > 0 ? assigned : element.children);
    }
  };

  visit(scope.children);

  return { before, after };
}

/** `element.closest('[inert]')`, across the shadow boundaries above it. */
function inInertTree(element: Element): boolean {
  for (let node: Element | null = element; node;) {
    if (node.hasAttribute('inert')) {
      return true;
    }

    const root: Node | null = node.parentElement ? null : node.getRootNode();
    node = node.parentElement ?? (root && 'host' in root ? (root as ShadowRoot).host : null);
  }

  return false;
}

/**
 * Whether Tab stops on `element`, by its markup: an explicit tabindex says so
 * itself, an editing host is a stop without one, and so is any other element
 * the selector matched natively. The `tabIndex` property cannot be asked
 * instead: Chromium reports -1 for a contenteditable `<div>` that Tab
 * nevertheless stops on.
 */
function inTabOrder(element: HTMLElement): boolean {
  if (element.hasAttribute('tabindex')) {
    return element.tabIndex >= 0;
  }

  if (element.hasAttribute('contenteditable') && !element.matches(NATIVE_TABBABLE_SELECTOR)) {
    return element.isContentEditable && !element.parentElement?.isContentEditable;
  }

  return true;
}

/**
 * Two announcements as one: the live region keeps only its last write. Joined
 * with a full stop unless the first already ends a sentence -- run together
 * with a space they read "Block duplicated Heading 2 selected". Either may be
 * empty (a host that leaves a newer announcement untranslated gets none).
 */
function joinSentences(first: string, second: string): string {
  if (first.length === 0 || second.length === 0) {
    return first || second;
  }

  return /[.!?。！？।]$/u.test(first) ? `${first} ${second}` : `${first}. ${second}`;
}

/**
 * Every element that scrolls `start`, nearest first: `start` itself and each
 * ancestor in the flat tree (`flatParent`) -- through the slot it is
 * assigned to, out of a shadow root to its host -- that scrolls vertically
 * and has something to scroll. The page's own scroller is not in it.
 *
 * `<body>` is one when it scrolls itself, which is only when the root
 * element's overflow is not `visible`; otherwise the body's overflow is the
 * viewport's, and the page is what moves. An app shell with
 * `html { overflow: hidden }` and a scrolling body was left out entirely,
 * so a drag held at the bottom of it scrolled nothing at all.
 *
 * `clipChainOf` asks a narrower question: which of them cut `start` off from
 * the window. A drag's auto-scroll asks this one -- what can move the
 * editor -- and takes the whole chain.
 */
function scrollersAround(start: Element): HTMLElement[] {
  return climbScrollers(start, false).scrollers;
}

/**
 * The scrollers that cut `start` off from the window, nearest first, and
 * whether the climb ended at an element drawn against the window itself
 * (`pinned`), which no scroller outside it can move.
 *
 * Not every ancestor that scrolls clips. A top-layer element (a modal
 * `<dialog>`, an open popover) is drawn against the window, outside every
 * ancestor's clip, so the climb stops at it -- after it, since it still clips
 * what is inside it. So is a `position: fixed` element (a bottom sheet
 * declared inside a scrolling pane) -- unless an ancestor makes it its
 * containing block (a `transform`, `filter`, `perspective`, `will-change`,
 * `contain` and the like), which then scrolls and clips it like any
 * absolutely positioned box. And a `position: absolute` element is scrolled
 * and clipped only by its containing block and what is around that, never by
 * a scroller between the two: a panel declared inside a pane that is not
 * positioned was read as clipped by the pane, so the caret's table toolbar
 * never showed and a wheel over the pane hid the format toolbar. Either way
 * the climb goes on from the containing block (`containingBlockOf`; none for
 * one fixed to the window, which pins it, or an absolute one placed against
 * the page). Stopped at every fixed element, a sheet in a `translateZ(0)`
 * pane read as on screen after the pane had scrolled it away, and its
 * toolbars stayed drawn over the page. Clipped by the pane behind a
 * window-fixed sheet, a caret on screen read as scrolled away: the caret's
 * table toolbar never showed, and the slash menu closed on the browser's own
 * scroll-into-view of the caret.
 *
 * The climb is the flat tree's (`flatParent`): an editor slotted into a web
 * component whose shadow tree holds the scrolling pane is clipped by that
 * pane, which `parentElement` never reaches.
 */
function clipChainOf(start: Element): { scrollers: HTMLElement[]; pinned: boolean } {
  return climbScrollers(start, true);
}

/**
 * The element `node` is drawn inside, in the flat tree -- the tree the
 * browser lays out and scrolls: the `<slot>` it is assigned to, else its
 * parent, else the host of the shadow root it is a child of. A node slotted
 * into a web component is laid out inside that component's shadow tree, so
 * the pane of an `<ion-content>` that scrolls it is reached through the slot,
 * never through `parentElement`. A closed shadow root's slots are not
 * reported (`assignedSlot` is null there), and the climb goes on from the
 * host as it always did.
 *
 * `hidden` counts the shadow trees entered through a slot and not yet left:
 * while it is above zero the element reached is not one of `node`'s
 * shadow-including ancestors, which `offsetParent` never reports.
 */
function flatParent(node: Element, hidden = 0): { parent: Element | null; hidden: number } {
  const slot = (node as Element & { assignedSlot?: Element | null }).assignedSlot ?? null;

  if (slot) {
    return { parent: slot, hidden: hidden + 1 };
  }

  if (node.parentElement) {
    return { parent: node.parentElement, hidden };
  }

  const root = node.getRootNode();

  return 'host' in root
    ? { parent: (root as ShadowRoot).host, hidden: Math.max(0, hidden - 1) }
    : { parent: null, hidden };
}

/**
 * Every shadow root the flat-tree climb from `start` passes through (see
 * `flatParent`): the editor's own and those of the components it is slotted
 * into. A `scroll` there is not composed, so a document listener never hears
 * a scroller inside one.
 */
function shadowRootsAround(start: Element): ShadowRoot[] {
  const roots: ShadowRoot[] = [];

  for (let node: Element | null = start; node; node = flatParent(node).parent) {
    const root = node.getRootNode();

    if ('host' in root && !roots.includes(root as ShadowRoot)) {
      roots.push(root as ShadowRoot);
    }
  }

  return roots;
}

/**
 * Whether `element` is the containing block of a `position` descendant by a
 * style of its own. Asked only of an element `offsetParent` cannot report --
 * one inside a shadow tree its descendant is slotted into -- and of `<body>`,
 * which it reports for an absolute element with no positioned ancestor
 * whether or not `<body>` contains it, since everywhere else the browser's
 * own answer is the one to trust.
 */
function establishesContainingBlock(element: Element, position: 'fixed' | 'absolute'): boolean {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);

  if (!style) {
    return false;
  }

  const set = (value: string | undefined): boolean =>
    value !== undefined && value !== '' && value !== 'none';

  return (
    (position === 'absolute' && style.position !== 'static' && style.position !== '') ||
    set(style.transform) ||
    set(style.translate) ||
    set(style.rotate) ||
    set(style.scale) ||
    set(style.perspective) ||
    set(style.filter) ||
    set(style.getPropertyValue('backdrop-filter')) ||
    /transform|perspective|filter/.test(style.willChange ?? '') ||
    /paint|layout|strict|content/.test(style.contain ?? '') ||
    style.getPropertyValue('content-visibility') === 'auto'
  );
}

/**
 * The containing block of the `fixed` or `absolute` element `node`: what
 * scrolls and clips it. Null for a fixed element drawn against the window,
 * and for an absolute one placed against the page itself.
 *
 * The browser names it as `offsetParent`, but only among `node`'s own
 * shadow-including ancestors: a sheet slotted into a component whose shadow
 * pane is its containing block is reported against `<body>`. So the flat tree
 * is climbed, and an element inside such a shadow tree is asked the question
 * itself (`establishesContainingBlock`); everywhere else the climb stops at
 * the browser's answer.
 */
function containingBlockOf(node: HTMLElement, position: 'fixed' | 'absolute'): Element | null {
  const reported = node.offsetParent;
  let hidden = 0;
  let current: Element = node;

  for (;;) {
    const step = flatParent(current, hidden);

    if (!step.parent) {
      break;
    }

    if (step.parent === reported) {
      // `<body>` is what an absolute element with no positioned ancestor
      // reports; it is placed against the page then, which `<body>` neither
      // scrolls nor clips unless it is a containing block itself -- a page
      // whose `<body>` scrolls (`html { overflow: hidden }`) read such a
      // panel as clipped by it, and its caret's table toolbar never showed.
      return position === 'absolute' &&
        reported === node.ownerDocument.body &&
        !establishesContainingBlock(reported, position)
        ? null
        : reported;
    }

    if (step.hidden > 0 && establishesContainingBlock(step.parent, position)) {
      return step.parent;
    }

    current = step.parent;
    hidden = step.hidden;
  }

  return reported;
}

/**
 * A scroller's client box -- inside its border, where its content is drawn
 * -- up and down, as it is drawn on screen, and the scale it is drawn at.
 *
 * `clientTop` and `clientHeight` are the scroller's own layout pixels; its
 * bounding box is in the window's. Under a `transform: scale()` or a `zoom`
 * on it or around it the two differ, and added together unscaled they put
 * the box's edge where it is not: drawn at 1.5, the lower third of a pane
 * counted as out of sight -- a press beside the text there placed its caret
 * one to four lines above the pointer, and scrolled the pane to show a
 * caret that was on screen -- and drawn at 0.6 the edge was past the
 * pane's own (R14-RV3-1, R14-RV3-5). The ratio of the drawn box to the
 * layout box carries one into the other, as `onScrollbar` does -- the
 * heights', since the box is measured up and down: a pane drawn only taller
 * (`scale(1, 1.5)`) put a press two lines off with the widths' ratio.
 * Every reader of what a scroller shows asks it: `#aimInHost`, `#revealBox`
 * and `#visibleBand`, with `#frameBand` for the panes of the pages around
 * an iframe mount.
 */
function drawnClientBox(scroller: HTMLElement): { top: number; bottom: number; scale: number } {
  const box = scroller.getBoundingClientRect();
  const scale = scroller.offsetHeight > 0 ? box.height / scroller.offsetHeight : 1;
  const top = box.top + scroller.clientTop * scale;

  return { top, bottom: top + scroller.clientHeight * scale, scale };
}

function climbScrollers(
  start: Element,
  clipping: boolean,
): { scrollers: HTMLElement[]; pinned: boolean } {
  const doc = start.ownerDocument;
  const win = doc.defaultView;
  const scrollers: HTMLElement[] = [];
  let node: Element | null = start;

  while (node && node !== doc.documentElement) {
    const style = win?.getComputedStyle(node);
    const overflow = style?.overflowY ?? '';
    const own =
      node !== doc.body ||
      (win?.getComputedStyle(doc.documentElement).overflowY ?? 'visible') !== 'visible';

    if (own && /auto|scroll|overlay/.test(overflow) && node.scrollHeight > node.clientHeight) {
      scrollers.push(node as HTMLElement);
    }

    if (clipping && inTopLayer(node)) {
      return { scrollers, pinned: true };
    }

    const position = style?.position;

    if (clipping && (position === 'fixed' || position === 'absolute') && 'offsetParent' in node) {
      const containing = containingBlockOf(node as HTMLElement, position);

      if (!containing) {
        return { scrollers, pinned: position === 'fixed' };
      }

      node = containing;
      continue;
    }

    node = flatParent(node).parent;
  }

  return { scrollers, pinned: false };
}

/** A box on screen, in viewport coordinates: a `DOMRect`, or one measured from a neighbour. */
type ScreenBox = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right' | 'height'>;

/**
 * Every box a selection `range` in `host` can be drawn at -- one, or two for
 * a caret at a soft wrap -- or none where nothing can be measured.
 *
 * A collapsed caret is measured by the character at its offset -- a line
 * break included: a range over the `\n` that ends a line has a box on that
 * line in every engine, an empty line's too -- then, at the very end, by the
 * trailing filler `<br>` that draws the last line (`renderRichText`), and
 * only then by its own box. Its own box cannot be trusted at a line start:
 * Chromium gives a caret on an empty line none at all (0×0 at the window's
 * origin), and Firefox gives one just after any `\n` a box on the line above.
 * Estimating an empty line from the nearest character with text, shifted by
 * the breaks between, measured it by the glyph's height rather than the
 * line's -- about 6px a line too high, 120px after twenty blank lines.
 *
 * A collapsed caret at a soft wrap can be drawn in two places: at the start
 * of the lower line, beside the character at its offset, or at the end of
 * the upper one, beside the character before it (a click or a tap past a
 * line's end, the line-end key). The DOM selection does not say which, and
 * the browser says only through its own line movement, which moves the
 * caret: asked on every `selectionchange`, it reset the column the browser
 * keeps for a run of ↑/↓ -- Shift+↓ after ↑ onto a shorter line stopped
 * several characters short -- and Firefox scrolled the caret into view from
 * a triple-click. So it is never asked here: both places are measured, the
 * upper first. Measured on the lower line alone, a caret drawn on the
 * window's last line read as below the window, and F10 scrolled the page
 * 400px.
 */
function selectionBoxes(host: HTMLElement, range: Range): ScreenBox[] {
  if (range.collapsed) {
    const probe = host.ownerDocument.createRange();

    probe.selectNodeContents(host);
    probe.setEnd(range.startContainer, range.startOffset);

    const at = probe.toString().length;
    const length = (host.textContent ?? '').length;
    const character = at < length ? characterBox(host, at) : null;

    if (character) {
      const upper = isSoftWrap(host, at) ? characterBox(host, at - 1) : null;

      return upper ? [upper, character] : [character];
    }

    const filler = host.lastChild;

    if (at === length && filler?.nodeName === 'BR') {
      probe.selectNode(filler);
      const box = probe.getBoundingClientRect();

      if (box.height > 0) {
        return [box];
      }
    }
  }

  const own = range.getBoundingClientRect();

  return own.width > 0 || own.height > 0 ? [own] : [];
}

/**
 * The box of a selection `range` in `host`, or null where nothing can be
 * measured: around every place it can be drawn (`selectionBoxes`), so a
 * caret at a soft wrap spans both lines -- what is anchored beside it clears
 * the one it is drawn on, whichever that is.
 */
function selectionBox(host: HTMLElement, range: Range): ScreenBox | null {
  return spanOf(selectionBoxes(host, range));
}

/** The box around all of `boxes`, or null for none. */
function spanOf(boxes: readonly ScreenBox[]): ScreenBox | null {
  if (boxes.length <= 1) {
    return boxes[0] ?? null;
  }

  const top = Math.min(...boxes.map((box) => box.top));
  const bottom = Math.max(...boxes.map((box) => box.bottom));

  return {
    top,
    bottom,
    left: Math.min(...boxes.map((box) => box.left)),
    right: Math.max(...boxes.map((box) => box.right)),
    height: bottom - top,
  };
}

/** The box of the character at `offset` in `host`'s text, or null when it draws none. */
function characterBox(host: HTMLElement, offset: number): DOMRect | null {
  const walker = host.ownerDocument.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let remaining = offset;

  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (remaining < node.length) {
      const range = host.ownerDocument.createRange();

      range.setStart(node, remaining);
      range.setEnd(node, remaining + 1);

      const rects = range.getClientRects();
      const box = rects[rects.length - 1] ?? range.getBoundingClientRect();

      return box.width > 0 || box.height > 0 ? box : null;
    }

    remaining -= node.length;
  }

  return null;
}

/**
 * Whether `element` is drawn in the top layer -- a modal `<dialog>`, an open
 * popover -- and so outside every ancestor's clip. Each pseudo-class is asked
 * on its own: an engine that does not know one throws on it.
 */
function inTopLayer(element: Element): boolean {
  for (const selector of [':modal', ':popover-open']) {
    try {
      if (element.matches(selector)) {
        return true;
      }
    } catch {
      // Not supported here; nothing this engine draws can match it.
    }
  }

  return false;
}

/**
 * The `<iframe>` element a window is shown in, in its parent's document, or
 * null at the top or across an origin boundary (where reading it throws).
 */
function frameElementOf(view: Window | null): Element | null {
  try {
    return view?.frameElement ?? null;
  } catch {
    return null;
  }
}

/**
 * How the window shown in `frame` maps into the window around it, vertically:
 * a y in the frame's window is drawn at `y * scale + offset` in the outer
 * one. The scale is the frame's drawn height over its layout height, as
 * `liftAnchor` in `ui/portal.ts` reads it -- a `transform: scale()` or a CSS
 * `zoom` on the frame or around it draws its whole window at that size, and
 * the border and padding between its edge and its window are in its own
 * pixels, so they are scaled too. Null where that cannot be read exactly:
 * no window, nothing laid out, or a window whose size is not the frame's
 * content box (WebKit lays a frame under a CSS `zoom` out at the zoomed
 * size, a documented limit) -- a caller skips the frame then rather than
 * guess.
 */
function frameMapping(
  frame: Element,
  inner: Window | null,
): { scale: number; offset: number } | null {
  const style = frame.ownerDocument.defaultView?.getComputedStyle(frame);
  const layout = frame as Partial<HTMLElement>;
  const rect = frame.getBoundingClientRect();
  const pad = (side: 'Top' | 'Bottom' | 'Left' | 'Right'): number =>
    parseFloat(style?.[`padding${side}`] ?? '') || 0;
  const contentHeight = frame.clientHeight - pad('Top') - pad('Bottom');
  const contentWidth = frame.clientWidth - pad('Left') - pad('Right');
  const scale = layout.offsetHeight ? rect.height / layout.offsetHeight : 0;

  if (
    !inner ||
    !(scale > 0) ||
    Math.abs(inner.innerHeight - contentHeight) > 1 ||
    Math.abs(inner.innerWidth - contentWidth) > 1
  ) {
    return null;
  }

  return { scale, offset: rect.top + (frame.clientTop + pad('Top')) * scale };
}

/**
 * The same-origin frames around the window `view`, innermost first, each
 * with how a y in `view` is drawn in the window that frame is in: at
 * `y * scale + offset`, composed through every frame inside it
 * (`frameMapping`), so a y in that window maps back as
 * `(y - offset) / scale`. The walk ends at the top, at an origin boundary,
 * and at a frame that cannot be read exactly: nothing beyond one is reached
 * by a guess.
 */
function framesAround(view: Window | null): { frame: Element; scale: number; offset: number }[] {
  const frames: { frame: Element; scale: number; offset: number }[] = [];
  let scale = 1;
  let offset = 0;

  for (
    let inner = view, frame = frameElementOf(inner);
    frame;
    inner = frame.ownerDocument.defaultView, frame = frameElementOf(inner)
  ) {
    const mapping = frameMapping(frame, inner);

    if (!mapping || !frame.ownerDocument.defaultView) {
      break;
    }

    offset = offset * mapping.scale + mapping.offset;
    scale *= mapping.scale;
    frames.push({ frame, scale, offset });
  }

  return frames;
}

/**
 * What a run of typing is scoped to: one editable host, not merely one block.
 *
 * A table is one block with a host per cell, so keying a run by block id alone
 * folds a correction in the last cell into the sentence typed in the first.
 */
function hostScope(id: string, cell?: CellCoords): string {
  return cell ? `${id}:${cell.row}:${cell.column}` : id;
}

/** Whether any character in `[start, end)` is in an inline code run. */
function hasCodeIn(content: RichText, start: number, end: number): boolean {
  let at = 0;

  for (const run of content) {
    const next = at + run.text.length;

    if (next > start && at < end && run.marks?.includes('code')) {
      return true;
    }

    at = next;
  }

  return false;
}

/**
 * Puts back the `<br>` that gives a block's final, empty line its box.
 *
 * `renderRichText` appends that filler after a trailing newline, but typing is
 * DOM-first, so only a render ever adds it -- and the browser can take it out
 * again. Firefox's word and line deletions do: after Alt+Backspace on the last
 * word of `line one⏎word` the host held `line one⏎` and nothing after it, the
 * block lost a line, and the next character landed in front of the newline.
 * Appended at the very end, after every boundary a caret can name, so the
 * caret stays exactly where the browser left it.
 */
function restoreTrailingFiller(host: HTMLElement, parsed: RichText): void {
  if (!parsed.at(-1)?.text.endsWith('\n')) {
    return;
  }

  let last = host.lastChild;

  // Down to the last node in tree order, past empty text: the filler can sit
  // inside a formatting element the browser wrote around it.
  while (last) {
    if (last.nodeType === 3 && (last.textContent ?? '').length === 0) {
      last = last.previousSibling;
    } else if (last.lastChild) {
      last = last.lastChild;
    } else {
      break;
    }
  }

  if (asElement(last)?.tagName === 'BR') {
    return;
  }

  host.append(host.ownerDocument.createElement('br'));
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
 * The ids an indent moves: each visible anchor with whatever it hides, minus
 * any anchor the indent cannot move.
 *
 * `indentBlocks` clamps each block on its own -- at depth 0, and at one level
 * below its predecessor. An anchor that cannot move would still hand its
 * hidden children over to move alone: Shift+Tab on a collapsed toggle at depth
 * 0 pulled them out of it, and Tab on one with nothing to nest under turned
 * its answers into a staircase, one press at a time, inside a fold nobody
 * could see -- each press swallowed, so the key that leaves the editor did
 * not. Whether an anchor can move is asked of the clamp itself, by indenting
 * the anchors alone, and then of its hidden children: they shift with it, so
 * at the depth ceiling an anchor that could go one deeper still stays when
 * they could not. Children the reader selected still move on their own.
 */
function indentTargets(
  blocks: readonly Block[],
  anchors: Iterable<string>,
  delta: number,
): Set<string> {
  const ids = new Set(anchors);
  const probe = indentBlocks(blocks, ids, delta);
  const movable = blocks
    .filter((block, index) => ids.has(block.id) && probe[index]?.depth !== block.depth)
    .filter((block) => {
      // At the depth ceiling an anchor can move where its hidden children
      // cannot: they would be clamped beside it, out of the fold.
      const shift = (findBlock(probe, block.id)?.depth ?? block.depth) - block.depth;
      const hidden = withHiddenDescendants(blocks, [block.id]);

      return blocks.every(
        (other) =>
          other.id === block.id ||
          !hidden.has(other.id) ||
          (other.depth + shift >= 0 && other.depth + shift <= MAX_DEPTH),
      );
    })
    .map((block) => block.id);

  return withHiddenDescendants(blocks, movable);
}

/**
 * `after`, with any collapsed toggle opened that would otherwise hide a block
 * the reader could see in `before`.
 *
 * Removing a block hands its children to whatever now precedes them. When
 * that is the end of a collapsed toggle's subtree they became its children,
 * out of sight: delete a paragraph that followed a collapsed toggle and the
 * paragraph's own sub-items vanished with no visible reason. Moves, indents
 * and pastes reach the same place by other routes: Tab after a collapsed
 * toggle makes the block its child, and a pasted collapsed toggle lands in
 * front of the target's children. The toggle opens instead -- the same answer
 * `#splitBlock` gives when Enter would give a collapsed toggle a hidden child.
 *
 * `alsoShow` names new blocks that must be visible too: what the reader was
 * looking at can travel in a block with a fresh id. A duplicate passes the
 * copies of the blocks the reader selected, which a copied collapsed toggle
 * would otherwise fold away. A paste moves the text after the caret into its
 * last block, which is also where the caret goes, and when that is a pasted
 * collapsed toggle's child both would vanish; it passes that block only when
 * it holds text the reader already had or sits in a fold that was already in
 * the document, and a closed `<details>` pasted last otherwise stays closed.
 */
function keepVisible(
  before: readonly Block[],
  after: Block[],
  alsoShow: readonly string[] = [],
): Block[] {
  const seen = new Set(visibleBlocks(before).map((block) => block.id));

  for (const id of alsoShow) {
    seen.add(id);
  }
  let result = after;

  // Each pass opens the innermost toggle hiding something; nested toggles can
  // need more than one, and each pass opens at least one or stops.
  for (;;) {
    const shown = new Set(visibleBlocks(result).map((block) => block.id));
    const lost = result.findIndex((block) => seen.has(block.id) && !shown.has(block.id));

    if (lost === -1) {
      return result;
    }

    let depth = result[lost]!.depth;
    let opened = false;

    for (let index = lost - 1; index >= 0 && depth > 0; index -= 1) {
      const candidate = result[index]!;

      if (candidate.depth < depth) {
        depth = candidate.depth;

        if (candidate.type === 'toggle' && candidate.collapsed) {
          result = updateBlock(result, candidate.id, { collapsed: false });
          opened = true;
          break;
        }
      }
    }

    if (!opened) {
      return result;
    }
  }
}

/**
 * A block-based rich-text editor.
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
  readonly #mathEditor: MathEditor;
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
  /** When a pointer was last released or cancelled; see POINTER_FOCUS_GRACE_MS. */
  #pointerReleasedAt = Number.NEGATIVE_INFINITY;
  /** The slash-menu combobox's name, in the host's own tree. */
  readonly #slashLabel: HTMLElement;
  readonly #useGutter: boolean;

  /** True where Cmd is the shortcut modifier and Ctrl belongs to the system. */
  readonly #applePlatform: boolean;

  /** True when the editor supplied the root's accessible name and owes it back. */
  readonly #ownsAriaLabel: boolean;
  readonly #originalClassAttribute: string | null;
  readonly #originalTheme: string | null;
  readonly #portals: readonly HTMLElement[];

  /** Whether the `role` that makes that name legal is ours to take away. */
  #ownsRole = false;

  /**
   * Toggles a read-only reader has opened, which is a view state and not an edit.
   *
   * Cleared whenever the document is replaced: these ids describe the document
   * being replaced, and a new one may not have them at all.
   */
  readonly #readerExpanded = new Map<string, boolean>();

  /** Whether the `tabindex` is ours to remove, and what it was if it is not. */
  #ownsTabIndex = false;
  #priorTabIndex = -1;

  #blocks: Block[];
  #editable: boolean;
  #destroyed = false;

  /** Where the active `/` query began, so it can be erased on commit. */
  #slashContext: { blockId: string; start: number } | null = null;

  /**
   * The range the link popover is editing, held while focus is in its input,
   * and which way the reader made it: put back forwards, the next Shift+←
   * shrank a backward selection from the far end.
   */
  #linkContext: {
    blockId: string;
    start: number;
    end: number;
    cell?: CellCoords;
    backward: boolean;
  } | null = null;

  /**
   * The range the inline equation popover will replace, held while focus is in
   * its input: one formula's atom when editing one, the selected text when
   * turning it into a formula, or a collapsed caret for a new one.
   */
  #mathContext: {
    blockId: string;
    start: number;
    end: number;
    cell?: CellCoords;
    existing: boolean;
    /**
     * The selection the popover was opened from, which is not always the
     * range it replaces: a caret beside a formula opens that formula. Escape
     * puts back this, not the formula's range -- restoring the range left
     * the formula selected, and the next keystroke replaced it.
     */
    selection: SelectionSnapshot;
  } | null = null;

  /**
   * A formula the `$` rule just made, until the next keystroke says whether it
   * was one: a digit straight after it means the dollars were a price
   * (`$5-$10`), which is Pandoc's third condition and the one typing cannot
   * ask in advance. See `#takeBackFormula`.
   */
  #ruleFormula: {
    blockId: string;
    cell?: CellCoords;
    offset: number;
    source: string;
    /** The document the rule replaced, which history recorded before it. */
    before: Block[];
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

  /**
   * True between pointerdown and pointerup anywhere, so drag-select can
   * settle. A press in this editor is marked in the document's capture
   * phase (`#disarmExit`), where a page cannot stop it; any other press in
   * the bubble phase (`#handleDocumentPointerDown`). Cleared by the release
   * -- `pointerup` or `pointercancel` -- in the capture phase too
   * (`#handlePointerUp`, `#handlePointerCancel`), so a page that stops it
   * above the editor cannot leave a press down for good (R14-RV4B-1).
   */
  #pointerDown = false;

  /**
   * True while the press `#pointerDown` holds was pressed in this editor
   * (`#pressedHere`). A range the reader began outside the editor ends a
   * block selection only when no such press is held: WebKit re-anchors its
   * own drag selection in the page's text a drag from the blocks is carried
   * quickly over, and taken for the reader's, the blocks went while the
   * button was still down (R14-RV9-1).
   */
  #pressInHere = false;

  /**
   * True from an Escape that ended a text drag -- or an edit or an update
   * that did (`#endTextDrag`) -- until the button comes up, or the drag is
   * given back (`#resumeTextDrag`, `#resumePromotedDrag`).
   *
   * The gesture is over but the button is still held, and WebKit goes on
   * drawing its own drag selection into whatever host is under the pointer --
   * a caret beside the block selection the drag left. With the gesture over,
   * that caret is a stray like any other and is taken out as it appears.
   */
  #textDragEscaped = false;

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
   * Where the composition began, and what was armed when it did.
   *
   * A composition is one edit, not one per candidate keystroke: the browser
   * rewrites the text several times before the user commits, and each rewrite
   * reaches `#handleInput`. Recording history per rewrite banked a dead undo
   * step for a cancelled candidate and fired a `change` for every intermediate
   * state. Formatting armed with Cmd+B is held here too, because a composition
   * arrives as `insertCompositionText` and the armed-marks path only ever
   * handled `insertText` -- so bolding and then typing in an IME produced plain
   * text.
   */
  #composition: CompositionState | null = null;

  /**
   * A text drag that may grow into a block selection.
   *
   * Each block is its own contenteditable, and a browser will not extend a
   * selection across editing hosts — so dragging from one block into the next
   * produces no cross-block range to react to. The gesture is tracked here and
   * turned into a block selection once the pointer leaves the block it started
   * in.
   */
  #textDrag: TextDrag | null = null;

  /** The shadow roots around the mount, each listened to for its own scrolls. */
  readonly #shadowTrees: ShadowRoot[] = [];

  /** The pointer behind the latest press on the root, for the mousedown it brings. */
  #press: { pointerId: number; pointerType: string } | null = null;

  /**
   * Where a drag's pointer is, while it may be held at a scroll edge.
   *
   * A drag that selects or moves blocks owns the gesture, so nothing scrolls
   * the page for it: a block could not be moved further than one screen, and
   * on a phone -- where the handle is `touch-action: none` -- not at all.
   *
   * `pressY` is where a text drag's press landed while that press is still
   * inside an edge band (see `#autoScrollTarget`), and null once the pointer
   * has been out of every band since.
   */
  #autoScroll: {
    pointerId: number;
    x: number;
    y: number;
    pressY: number | null;
    frame: number | null;
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
    // What the element carried before, so `destroy()` can hand back exactly
    // that: a theme attribute left behind, or a `class=""` that was never
    // there, is residue the next mount -- or the host's own CSS -- trips over.
    this.#originalClassAttribute = this.#root.getAttribute('class');
    this.#originalTheme = this.#root.getAttribute('data-neditor-theme');
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
      // Only where there is no role to override. A bare <div> or <span> has
      // the `generic` role, which prohibits a name -- that is what this is for.
      // Everything else a host might mount into (<main>, <section>, <article>,
      // <nav>, <form>, <aside>) already has an implicit role that both permits
      // a name and means something, and replacing it with `group` threw that
      // away.
      this.#ownsRole = !this.#root.hasAttribute('role') && hasGenericRole(this.#root);

      if (this.#ownsRole) {
        this.#root.setAttribute('role', 'group');
      }
    }
    // Block selection has no caret, so the root itself must hold focus for
    // keystrokes to reach the editor -- but `destroy()` has to put back what
    // was there, which for most hosts is no attribute at all.
    this.#ownsTabIndex = !this.#root.hasAttribute('tabindex');
    this.#priorTabIndex = this.#root.tabIndex;
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
      { renderMath: options.renderMath },
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

          if (!active) {
            return;
          }

          // Back to the selection F10 left, in the direction it was made: the
          // cell's end lost a caret mid-word, a range and its direction.
          const cell = { row: active.row, column: active.column };
          const block = findBlock(this.#blocks, active.blockId);
          const content = this.#hostFor(active.blockId, cell);
          const kept = active.selection;

          if (block && content && kept && this.#tallerThanBand(content)) {
            // `#placeRange` without its reveal of the whole host, which in a
            // cell taller than its scroller lined up the cell's nearest edge:
            // the caret F10 had just left on screen moved about 100px, and
            // Firefox and WebKit scrolled the page too. The selection is
            // judged as F10 judged it, and on screen it moves nothing. The
            // selection F10 left is taken out before the focus: WebKit, which
            // keeps it while the toolbar holds focus, reveals it on `focus()`
            // whatever `preventScroll` says, and a range taller than the
            // window scrolled the page 400px.
            this.#goal = null;
            this.#clearBlockSelection();
            this.#selection()?.removeAllRanges();
            content.focus({ preventScroll: true });
            setSelectionRange(
              content,
              kept.start,
              kept.end,
              kept.backward && kept.start !== kept.end,
            );

            if (kept.upper && kept.start === kept.end) {
              placeCaretOnLine(content, kept.start, 'upper');
            }

            this.#showSelectionOrHost(content, () => this.#reveal(content));
          } else if (block && content && kept) {
            this.#focusResolved({ block, content, cell }, kept.start, kept.end, kept.backward);
          } else {
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

    // Hidden, and still read when referenced by aria-labelledby. It lives in
    // the root so the reference always resolves, whatever tree the menu is in.
    this.#slashLabel = this.#document.createElement('span');
    this.#slashLabel.id = `neditor-slash-label-${Math.random().toString(36).slice(2, 9)}`;
    this.#slashLabel.hidden = true;
    this.#slashLabel.textContent = this.#labels.slashMenu;
    this.#root.append(this.#slashLabel);

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
        onEditMath: () => {
          this.openMathEditor();
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

    this.#mathEditor = new MathEditor(
      this.#document,
      {
        onApply: (tex) => {
          this.#applyMath(tex);
        },
        onRemove: () => {
          this.#applyMath('');
        },
        onCancel: () => {
          this.#closeMathEditor();
        },
      },
      this.#labels,
      options.renderMath,
    );

    this.#portals = [
      this.#slashMenu.element,
      this.#toolbar.element,
      this.#linkEditor.element,
      this.#mathEditor.element,
      this.#iconPicker.element,
      this.#imageEditor.element,
      this.#tableToolbar.element,
    ];

    for (const portal of [
      this.#slashMenu,
      this.#toolbar,
      this.#linkEditor,
      this.#mathEditor,
      this.#iconPicker,
      this.#imageEditor,
      this.#tableToolbar,
    ]) {
      portal.setTheme(theme);
      this.#portalRoot.append(portal.element);
      // Its anchors are measured here, whichever window it is drawn in, and
      // it can be seen only where the pages around the page it is drawn in
      // show that page (`#frameBand`).
      setAnchorView(portal.element, this.#document.defaultView);
      setAnchorBand(portal.element, () => this.#frameBand(portal.element.ownerDocument));
    }

    this.#syncPortalDirection();

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
    this.#root.addEventListener('focusout', this.#handleRootFocusOut);
    this.#root.addEventListener('focusin', this.#handleToolbarFocusIn);
    this.#toolbar.element.addEventListener('focusout', this.#handleToolbarFocusOut);
    this.#tableToolbar.element.addEventListener('focusout', this.#handleToolbarFocusOut);
    this.#root.addEventListener('mousedown', this.#handleRootMouseDown);
    this.#root.addEventListener('contextmenu', this.#handleContextMenu);
    this.#root.addEventListener('click', this.#handleClick);
    this.#root.addEventListener('paste', this.#handlePaste);
    this.#root.addEventListener('copy', this.#handleCopy);
    this.#root.addEventListener('cut', this.#handleCopy);
    this.#root.addEventListener('drop', this.#handleDrop);
    this.#root.addEventListener('pointerdown', this.#handleRootPointerDown);
    this.#root.addEventListener('pointerover', this.#handlePointerOver);
    this.#root.addEventListener('pointerleave', this.#handlePointerLeave);
    this.#document.addEventListener('pointermove', this.#handlePointerMove);
    // The release in the capture phase, as the press is (`#disarmExit`): a
    // page that stops `pointerup` or `pointercancel` above the editor never
    // let the bubble phase hear it, and the gesture stayed down from then on
    // -- Escape in a block selected nothing, Escape twice then Tab never
    // left, a drag went on following a pointer with no button down
    // (R14-RV4B-1). It runs before the page's own listeners for the
    // release, which see the gesture over, and still before the
    // compatibility `click`, a later event.
    this.#document.addEventListener('pointerup', this.#handlePointerUp, true);
    this.#document.addEventListener('pointercancel', this.#handlePointerCancel, true);
    this.#document.addEventListener('pointerdown', this.#handleDocumentPointerDown);
    this.#document.addEventListener('focusin', this.#handleDocumentFocusIn, true);
    this.#listenToOuterDocuments();
    for (const type of ['copy', 'cut', 'paste'] as const) {
      this.#document.addEventListener(type, this.#handleDocumentClipboard);
    }
    this.#document.addEventListener('keydown', this.#handleDocumentKeyDown, true);
    this.#document.addEventListener('selectionchange', this.#handleSelectionChange);
    this.#document.addEventListener('keydown', this.#handleExitKeyDown, true);
    this.#document.addEventListener('pointerdown', this.#disarmExit, true);
    this.#document.addEventListener('focusin', this.#disarmExit, true);
    for (const doc of [this.#document, ...this.#outerDocuments.map(({ doc }) => doc)]) {
      doc.addEventListener('keydown', this.#guardBackspace, true);
      doc.addEventListener('pointerdown', this.#spendBackGuard, true);
      doc.addEventListener('focusin', this.#spendBackGuard, true);
    }
    this.#root.addEventListener('keyup', this.#flushAfterKey);
    // Capture, so a scroll inside any container on the way down is heard: a
    // scroll event from an element does not bubble.
    this.#document.addEventListener('scroll', this.#handleViewportChange, true);
    // And on every shadow root the editor is drawn inside: a scroll there is
    // not composed, so the document never hears a scroller in the shadow
    // tree, and the floating UI stayed where it was while the text moved
    // under it. Climbed through the flat tree, as `clipChainOf` and the
    // drag's auto-scroll climb it (`flatParent`): an editor slotted into a
    // component whose shadow pane scrolls it is inside that pane's tree too.
    // The tree is read here, once: an editor moved into a component after it
    // was mounted is not heard scrolling there until it is mounted again.
    for (const shadow of shadowRootsAround(this.#root)) {
      this.#shadowTrees.push(shadow);
      shadow.addEventListener('scroll', this.#handleViewportChange, true);
    }
    this.#document.defaultView?.addEventListener('resize', this.#handleViewportChange);

    this.#render();

    if (options.autofocus) {
      this.focus();
    }
  }

  /* ------------------------------------------------------------ public -- */

  get element(): HTMLElement {
    return this.#root;
  }

  /** False once destroyed, too: a destroyed editor edits nothing. */
  get editable(): boolean {
    return this.#editable && !this.#destroyed;
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

    this.#cancelLinkOpen();

    // A drag in flight was aimed at the document being replaced; see
    // `#applyBlocks`.
    if (this.#drag) {
      this.#endDrag(null);
    }

    const textDrag = this.#textDrag;

    if (textDrag) {
      this.#noteDragAnchor(textDrag);
      this.#noteDragUnit(textDrag);
      textDrag.anchorEnd = this.#anchorEndOf(textDrag);
    }

    // A drag across blocks goes on over an update that leaves the order it
    // selects in as it was (`#resumePromotedDrag`): that order, and where in
    // its own text its press was, asked of the document being replaced.
    const promotedBefore = textDrag?.promoted ? this.#promotedDragState(textDrag) : null;
    // And the pointer a drag the editor draws in its own block follows at
    // rest (`#resumeTextDrag`), before the scroll is stopped with the drag.
    const followBefore = textDrag && !textDrag.promoted ? this.#followState() : null;
    // And the order of the blocks shown: a drag still in its own block is
    // given back to cross into the others only where that is unchanged.
    const shownBefore =
      textDrag && !textDrag.promoted ? this.#visible().map((block) => block.id) : null;
    this.#endTextDrag();
    // What the reader had selected and was looking at, asked of the document
    // being replaced: a block selection carries over (below), and only a
    // toolbar that was showing is drawn again.
    const previous = this.#blocks;
    const selectedBefore = this.#orderedSelection();
    const activeBefore = this.#activeElement();
    const rootHeldFocus = activeBefore === this.#root;
    // The caret or range in the text, read against the document it was made
    // in, and whether the reader is typing at it (`#carryTextSelection`).
    const textBefore = this.#selectionTarget();
    const textHeldFocus = textBefore !== null && this.#typingIn(textBefore.content);
    // Made by the reader just now, its `selectionchange` still queued: the
    // carry's write is not noted over it (`#ownSelection`).
    const changePending = this.#selectionChangePending();
    // And a composition live there: its text is in the model but in no
    // document a peer sends (`#carryTextSelection`).
    const composingBefore = this.#composing ? this.#composition : null;
    const formatShown = this.#toolbar.isOpen;
    const tableShown = this.#tableToolbar.isOpen || this.#tableToolbarScrolledAway;
    const pending = this.#pending;
    this.#blocks = normalizeDocument(doc).blocks;
    this.#pending = null;
    this.#typingOver = null;
    // The run of ↑/↓ was through the document being replaced.
    this.#goal = null;
    // Every open popover describes the document being replaced. `#travel`
    // closes them all for exactly this reason and `setEditable` does too; this,
    // a strictly larger reset, closed only the block selection. So a link
    // editor left open across a socket or autosave restore -- a supported
    // integration -- applied the user's URL to the NEW document at the OLD
    // offsets, linking whatever text now sat there and emitting `change` for a
    // persistence layer to write back.
    this.#readerExpanded.clear();
    // Closed without moving focus, every one of them. A panel that held focus
    // leaves it on the page, outside the editor, deliberately: the reader was
    // typing into that panel, and the keys still on their way -- the rest of
    // a URL, the Space or Enter meant for a toolbar button, a caption, an
    // icon search -- belong to it. Handed back to the block (round 6) with
    // the panel's range selected, they overwrote the document's text, at
    // offsets a peer's edit had already moved, and `change` carried them out.
    // Typing that reaches nothing loses nothing; typing that reaches the
    // document is an edit no one made. Asked before they close.
    const panelFocus = this.#panelFocus();
    const panelHeldFocus = panelFocus !== null;
    const rootHeldAnyFocus = activeBefore !== null && this.#root.contains(activeBefore);
    this.#closeSlashMenu();
    this.#linkContext = null;
    this.#linkEditor.close();
    this.#mathContext = null;
    this.#mathEditor.close();
    this.#closeImageEditor(false);
    this.#closeIconPicker(false);
    this.#toolbar.hide();
    this.#hideTableToolbar();
    this.#activeCell = null;
    this.#history.clear();

    if (panelFocus) {
      // Hidden, a panel's control can keep focus: WebKit left it on the F10
      // toolbar's zero-size button, where the next Backspace went back in
      // history. Taken off it, focus is on the page, guarded below.
      panelFocus.blur();

      // And the selection the panel's opening left behind in a host is not
      // left there for the keys meant for the panel: WebKit keeps it in the
      // cell while F10's toolbar holds focus, and with focus fallen to
      // `<body>` it typed the Space meant for a toolbar button over it.
      // Dropped before anything reads it. Only the editor's own panels: a
      // host's own toolbar button holds focus while it acts on the reader's
      // selection (`toggleMark` from its click), and a peer's update landing
      // during the press took the range it was about to bold.
      this.#selection()?.removeAllRanges();
    }

    this.#render();
    // The reader's caret or range in a host the update redrew is carried
    // across by the text around it, or let go of -- never left at offset 0.
    // (A panel's own range was dropped above, with the keys meant for it.)
    // Before the composition is re-anchored below: the re-anchoring notes the
    // caret as the place undoing the composed word returns to, and taken
    // before the carry it was the redrawn host's offset 0.
    const droppedKept = this.#carryTextSelection(
      panelHeldFocus ? null : textBefore,
      textHeldFocus,
      composingBefore,
      changePending,
    );
    // A press still down in the host the carry wrote into goes on selecting,
    // drawn from the carried anchor (`#resumeTextDrag`).
    this.#resumeTextDrag(textDrag, followBefore, shownBefore);
    // The gutter goes with its block, by id, as after an edit
    // (`#applyBlocks`): left where it was drawn, its handle stood beside
    // the block that had moved into that place while still naming the old
    // one -- drawn beside p4, a click on it selected p5, and Backspace
    // deleted p5 (R14-RV2-B3). Nothing is drawn where none was showing.
    this.#refreshGutter();
    // After the render, which is what decides it: the check asks whether the
    // host the composition lives in survived, and before the render it always
    // has.
    this.#endComposition();
    // A block selection is kept for the blocks the new document still shows,
    // by id, as an edit keeps it (`#pruneBlockSelection`). Cleared outright,
    // it left the root holding focus with nothing selected and no caret --
    // neither mode, so every key fell on the floor. A peer's edit elsewhere
    // in the document is not the reader leaving the blocks they picked; where
    // no id says where they were, the root lets go of focus rather than guess.
    this.#keepBlockSelection(selectedBefore, previous, rootHeldFocus && !panelHeldFocus);
    // After the selection it extends is kept by id.
    this.#resumePromotedDrag(textDrag, promotedBefore);

    // The toolbars were hidden with the panels, but a caret or a range that
    // survived the render in the host still holding focus is still being
    // edited: drawn again for it -- only the one that was showing, and only
    // here (`#redrawToolbars`), never by the `selectionchange` the carry's
    // write queued (`#ownSelection`).
    this.#redrawToolbars(formatShown, tableShown);

    // A ⌘B armed at a collapsed caret is still armed when nothing it belongs
    // to changed: its block is there by id with the same text (the same
    // cell's, in a table). A peer's edit to another block took it away, and
    // "XY" typed next came out plain. Where the caret is is not asked here:
    // the caret moving off its offset is a `selectionchange`, which ends it
    // (`#handleSelectionChange`) as it does without a peer.
    if (pending) {
      const textOf = (block: Block | undefined): RichText | undefined =>
        pending.cell ? block?.rows?.[pending.cell.row]?.[pending.cell.column] : block?.content;
      const was = textOf(findBlock(previous, pending.blockId));
      const now = textOf(findBlock(this.#blocks, pending.blockId));

      if (was && now && richEquals(was, now)) {
        this.#pending = pending;
      }
    }

    // Focus that was in the editor -- a block, the root, or one of its
    // panels -- and fell to the page with the render leaves a Backspace on
    // `<body>`, which WebKit answers by going back in history: guarded as
    // `#letGo` guards it (`#backAfterLetGo`). The focused block gone, renamed
    // by a host that reloads (after a debounce, say); or a panel closed, whose
    // control was blurred above. Asked of the document the focus was in: a
    // `portalContainer` in the page around an iframe mount puts the panels
    // there, and closed, it leaves focus on *that* page's `<body>`, while the
    // frame's own document still names the cell F10 left. And a range kept
    // in a host without focus that the update dropped (`#carryTextSelection`)
    // with focus on the page: WebKit types into such a range from `<body>`,
    // so the reader's next Backspace was the editor's until the update, and a
    // Back after it -- or from a modal `<dialog>` (`#keptFocusOnPage`).
    if (
      (rootHeldAnyFocus && this.#focusOnPage()) ||
      (panelFocus !== null && this.#focusOnPage(panelFocus.ownerDocument)) ||
      (droppedKept && this.#keptFocusOnPage())
    ) {
      this.#backAfterLetGo = true;
    }

    // `silent` exists for the case where the caller already knows: piping a
    // remote document in and echoing `change` back out is an unbounded loop.
    if (!options.silent) {
      this.#emitChange();
    }

    this.#emitHistory();
  }

  /**
   * Whether `undo()` would do anything -- which a read-only editor's would not.
   *
   * `#travel` refuses outright while `editable` is false, so forwarding the
   * stack depth alone described a document that could be stepped back and an
   * `undo()` that returned false: a host binding a toolbar button to this
   * enabled it and then did nothing when it was pressed.
   */
  get canUndo(): boolean {
    return this.#canEdit() && this.#history.canUndo;
  }

  /** Whether `redo()` would do anything. Read-only says no, for the same reason. */
  get canRedo(): boolean {
    return this.#canEdit() && this.#history.canRedo;
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
    // Final, like the other mutators: a destroyed editor has nothing to
    // switch. (The getter reports false after destroy whatever this held.)
    if (this.#destroyed) {
      return;
    }

    // A call that switches nothing changes nothing: no selection, no drag,
    // no panel, no focus, no render and no event. Hosts re-assert the state
    // they have on every render, and each such call used to run the whole
    // switch again -- `setEditable(false)` on a read-only view let go of
    // the blocks a reader had selected to copy, at rest and in the middle
    // of the drag selecting them (R14-RV2-B2), and `setEditable(true)` on
    // every render dropped the link editor a click had just asked for
    // (R13-RV15-PTR-1).
    if (this.#editable === editable) {
      return;
    }

    // A pending link open (`#linkOpen`) is older than a lock. An unlock
    // never meets one: opens are only scheduled while editable.
    if (!editable) {
      this.#cancelLinkOpen();
    }

    // Where focus was, asked before anything closes or redraws: a read-only
    // switch that takes it off the editor leaves it on the page (below).
    const panelFocus = editable ? null : this.#panelFocus();
    const activeBefore = this.#activeElement();
    const editorHeldFocus = activeBefore !== null && this.#root.contains(activeBefore);
    // The caret the reader is typing at, which a lock takes off its block and
    // an unlock gives back (`#lockedCaret`).
    const caretBefore = editable ? null : this.#selectionTarget();
    const typingBefore = caretBefore !== null && this.#typingIn(caretBefore.content);
    // And which toolbar was showing for it, before the lock hides them -- or
    // would have been: a change of the reader's whose `selectionchange` is
    // still queued is answered during the lock, which draws nothing, and the
    // toolbar for the range they had just made never came
    // (`#selectionChangePending`).
    const changePending = !editable && this.#selectionChangePending();
    const formatShown = this.#toolbar.isOpen || changePending;
    const tableShown = this.#tableToolbar.isOpen || this.#tableToolbarScrolledAway || changePending;
    // Or a selection in a block with focus on the page: WebKit gives a page
    // button no focus and goes on typing into the block from `<body>`, so the
    // reader's next Backspace was the editor's until the lock took the block
    // away -- and a Back after it. The rule `setDocument` follows for a host
    // it redraws or takes away (`#carryTextSelection`); focus that is on
    // anything else -- a field of the page -- is the reader's. (Every lock
    // that reaches here takes editing away: a selection made in a read-only
    // view, for copying, was never typed into, and a call that switches
    // nothing has returned.)
    const keptBefore =
      caretBefore !== null && !editorHeldFocus && panelFocus === null && this.#keptFocusOnPage();
    this.#editable = editable;
    // Read-only ends a link continuation; turning editing back on does not
    // resume one. Nor a run of ↑/↓.
    this.#typingOver = null;
    this.#goal = null;

    // Only when editing is turned on. A reader's view-only expansions
    // describe a document nobody could edit, and kept across that they went on
    // overriding the model for an author whose chevron then reported the
    // opposite of what the page showed. (Cleared on every call, a host
    // calling `setEditable(false)` on an already read-only editor, which is
    // the no-op every framework does on re-render, snapped every toggle the
    // reader had opened; such a call no longer gets this far.)
    if (editable) {
      this.#readerExpanded.clear();
    }
    this.#renderer.setEditable(editable);
    // `canUndo` and `canRedo` both answer differently now, and a host that
    // renders its toolbar from the `history` event had no way to hear it.
    this.#emitHistory();

    if (!editable) {
      // Taken off a panel's control before the panel closes: hidden, WebKit
      // kept focus on the F10 toolbar's zero-size button, where Backspace
      // went back in history. Focus is on the page, guarded below.
      panelFocus?.blur();
      this.#toolbar.hide();
      this.#hideTableToolbar();
      this.#closeLinkEditor();
      this.#closeMathEditor();
      this.#closeImageEditor();
      this.#closeIconPicker();
      // The slash menu too: left open, a click on it retyped the block and
      // fired `change` in an editor that had just been made read-only.
      this.#closeSlashMenu();
      // And any gesture in flight. A drag released after the switch still
      // moved the blocks, and a long press still re-entered block selection.
      if (this.#drag) {
        this.#endDrag(null);
      }
      this.#cancelLongPress();
      // Ended, and with the button still down the gesture stays ended
      // (`#lockEnded`): nothing the browser goes on selecting is taken up
      // at the release, nor left across blocks (`#handlePointerUp`), and
      // the caret it leaves after a drag across blocks is taken out there
      // (`#lockEndedBlocks`). A lock that switches nothing never gets here.
      // A press whose text drag something had ended already -- Escape, a
      // peer's reorder -- is that press still (`#textDragEscaped`): the
      // button is down, and the browser goes on across the blocks the
      // same.
      this.#lockEnded = this.#textDrag !== null || this.#textDragEscaped;
      this.#lockEndedBlocks = this.#textDrag?.promoted === true;
      this.#endTextDrag();
      this.#gutter.hide();

      // A block selection ends, and the root lets go of the focus it gave
      // it (`#letGo`): left holding focus with nothing selected, the root
      // took keys in neither mode, and WebKit's Backspace on it -- no
      // longer an editing host's key -- went back in history.
      if (this.#selected.size > 0) {
        this.#clearBlockSelection();
        this.#letGo();
      }
    }

    this.#render();

    if (!editable && (editorHeldFocus || panelFocus !== null)) {
      // A block's host is no editing host now, and can hold no focus: taken
      // off it here rather than whenever the engine gets round to it, so the
      // guard below sees where focus really is. (A closing panel hands focus
      // back to its block, which a read-only host refuses in a browser.)
      const active = this.#activeElement();

      // And a control the lock disabled -- the image trigger, the callout
      // icon: WebKit takes focus off a disabled button only lazily, so the
      // guard below still found it on the button, and the Backspace that
      // then landed on `<body>` went back in history.
      if (
        active &&
        active !== this.#root &&
        (this.#hostFromNode(active) === active ||
          (this.#root.contains(active) && (active as HTMLButtonElement).disabled === true))
      ) {
        (active as HTMLElement).blur();
      }
    }

    // Focus that was in the editor -- a block, the root, a panel -- and is on
    // the page now leaves a Backspace on `<body>`, which WebKit answers by
    // going back in history; guarded as `setDocument` guards it. So does a
    // selection WebKit kept in a block with focus on the page (`keptBefore`).
    if (
      !editable &&
      ((editorHeldFocus && this.#focusOnPage()) ||
        (panelFocus !== null && this.#focusOnPage(panelFocus.ownerDocument)) ||
        keptBefore)
    ) {
      this.#backAfterLetGo = true;

      if (caretBefore && (typingBefore || keptBefore) && panelFocus === null) {
        this.#lockedCaret = {
          blockId: caretBefore.block.id,
          ...(caretBefore.cell ? { cell: caretBefore.cell } : {}),
          range: caretBefore.range,
          backward: caretBefore.backward,
          text: richToPlainText(this.#contentOf(caretBefore)),
          shape: tableShape(caretBefore.block),
          formatShown,
          tableShown,
          caption: caretBefore.block.type === 'image',
          kept: !typingBefore,
        };
      }
    }

    // What the lock did to the selection is its own doing, not the reader's
    // (`#selectionHandledHere`) -- unless a change of theirs was still on its
    // way, which the unlock is then not to pass over either.
    if (!editable && !changePending) {
      this.#selectionHandledHere();
    }

    const locked = this.#lockedCaret;

    if (editable && locked) {
      this.#lockedCaret = null;

      if (locked.kept) {
        // Not asked of the window's focus: an unlock that lands while the
        // tab is in the background (a save finishing) left the guard over a
        // selection WebKit types into again when the reader comes back --
        // letters reaching the block, Backspace cancelled.
        if (this.#backAfterLetGo && this.#keptFocusOnPage(false)) {
          this.#resumeKeptSelection();
        }
      } else if (this.#backAfterLetGo && this.#focusOnPageAround()) {
        this.#restoreLockedCaret(locked);
      }
    }
  }

  /**
   * An unlock over a selection WebKit kept in a block with focus on the page
   * (`LockedCaret.kept`): the lock guarded Backspace because the block could
   * no longer take it, and the block can again. Wherever the selection still
   * is in one of the editor's hosts, WebKit types into it as it did before
   * the lock -- letters and Delete reach it -- so Backspace is the editor's
   * again and the guard goes; left armed, it cancelled the Backspace while
   * every other key still reached the block. Not only at the offsets the
   * lock found: Safari's Shift+← extends a read-only selection with focus on
   * `<body>`, and an unlock after it kept cancelling three Backspaces in a
   * row while "Q" replaced the range (R14-KEY-1). Focus is not moved: the
   * reader never gave it to the block. A selection that is gone -- an update
   * that redrew or took away its host dropped it -- across two hosts, or
   * outside the editor keeps the guard: nothing of the editor's takes the
   * key there, and Backspace on `<body>` goes back.
   */
  #resumeKeptSelection(): void {
    if (this.#selectionTarget()) {
      this.#backAfterLetGo = false;
    }
  }

  /**
   * The caret a `setEditable(false)` took off the block the reader was typing
   * in, kept while the reader has not placed themselves since
   * (`#backAfterLetGo` still armed): a host locking the editor round a save
   * and unlocking it took the reader's caret with it, and the next letter
   * reached nothing -- where, before the lock blurred the block, Firefox and
   * WebKit had kept typing into it. By id, never by position or content.
   * Forgotten the moment the reader places themselves (`#spendBackGuard`),
   * so a guard armed again later -- a peer's update dropping focus they put
   * on a control -- gives nothing back. Not reset by `destroy`: a destroyed
   * editor's `setEditable` returns before reading it. Also a selection WebKit
   * kept in a block with focus on the page (`LockedCaret.kept`), which an
   * unlock gives Backspace back to rather than focus
   * (`#resumeKeptSelection`).
   */
  #lockedCaret: LockedCaret | null = null;

  /**
   * Puts the locked caret back (`#lockedCaret`): only into the block of the
   * same id, still shown and still holding text -- the same cell of a table
   * that kept its shape, the caption of a block that is still an image --
   * at its offsets, carried by the text around them
   * where a `setDocument` changed the text meanwhile (`carryOffset`).
   * Otherwise nothing: focus stays on the page, guarded.
   */
  #restoreLockedCaret(locked: LockedCaret): void {
    const { blockId, cell, range, backward } = locked;
    const block = findBlock(this.#blocks, blockId);
    const shown = this.#visible().some((visible) => visible.id === blockId);
    const target = this.#targetFor(blockId, cell);

    if (
      !block ||
      !shown ||
      !target ||
      tableShape(block) !== locked.shape ||
      // A caption is given back to an image, as the live carry carries it;
      // never to a block that became or stopped being one meanwhile.
      (block.type === 'image') !== locked.caption ||
      isVoidType(block.type)
    ) {
      return;
    }

    const after = richToPlainText(this.#contentOf(target));
    const collapsed = range.start === range.end;
    // Unchanged text is the same offsets: carried, a caret the reader had put
    // inside a character (Firefox, after a virama) was snapped out of it.
    // A range is carried to what every reading of the edit that keeps each
    // code point whole agrees on (`carryRange`).
    let carried: OffsetRange | null = range;

    if (after !== locked.text) {
      const at = collapsed ? carryOffset(locked.text, after, range.start, 'before') : null;

      carried = collapsed
        ? at === null
          ? null
          : { start: at, end: at }
        : carryRange(locked.text, after, range.start, range.end);
    }

    if (!carried) {
      return;
    }

    const { start, end } = carried;

    // Put back where it was, not brought into view: the reader may have
    // scrolled away during the lock (`?doc=long`: 1231 back to 174, and the
    // page around an iframe mount with it). `#placeRange` reveals the host;
    // `#placeFocus` focuses with `preventScroll`, and no engine scrolls for
    // the selection written after it (measured: RO6d).
    this.#goal = null;
    // A change of the reader's still on its way (a range set in the task
    // that unlocked) is answered by its own event (`#ownSelection`).
    const pending = this.#selectionChangePending();

    this.#writeOwnSelection(target.content, pending, () => {
      if (!this.#placeFocus(target.content)) {
        return false;
      }

      this.#clearBlockSelection();
      setSelectionRange(target.content, start, end, backward && start !== end);
      return true;
    });
    // The lock hid the toolbars; only the one showing then comes back, and
    // the format toolbar only while its range is on screen -- the reader may
    // have scrolled away during the lock, or pressed Escape before it.
    this.#redrawToolbars(locked.formatShown, locked.tableShown);
  }

  /**
   * `#focusOnPage`, asked of the editor's document and of every document
   * around an iframe mount, where focus may be on the editor's own frame
   * and nowhere else: the frame's document answers `<body>` whenever focus
   * is anywhere outside the frame, and an unlock took focus back from an
   * input in another frame on the page, scrolled the page to the block and
   * typed the reader's next letter there.
   */
  #focusOnPageAround(): boolean {
    return (
      this.#focusOnPage() &&
      this.#outerDocuments.every(
        ({ doc, frame }) => this.#focusOnPage(doc) || holdsOwnFocus(frame),
      ) &&
      // Past a page of another origin nothing can be asked of its focus, and
      // a press there spends nothing: an unlock took the caret back from an
      // input in a cross-origin page around an embed and typed the reader's
      // "Q" into the block. There the window's own focus is the only answer
      // -- false while the tab is in the background too, so in that case
      // alone an unlock landing in a background tab gives nothing back.
      (!this.#crossOriginAbove || this.#document.hasFocus())
    );
  }

  /**
   * Whether the frames around an iframe mount end at a page of another
   * origin, whose focus and presses this script cannot hear
   * (`#listenToOuterDocuments`).
   */
  #crossOriginAbove = false;

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

    // Literal text has no formatting: in a code block or an equation a mark
    // was stored, shown, and dropped by the next save.
    if (!target || !this.#editable || isLiteralType(target.block.type)) {
      return;
    }

    // A mark toggled during a link continuation is a choice about what comes
    // next, and the continuation would have overruled it: Mod+B lit bold and
    // the next characters went into the link plain. It ends here, so the armed
    // mark applies exactly as it does at any other link's end.
    this.#typingOver = null;

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
    // In the direction the reader made it: restored forwards, a Shift+← after
    // Mod+B shrank the selection from the far end instead of growing it.
    this.#focusResolved(target, range.start, range.end, target.backward);
    this.#syncToolbar();
  }

  /** Sets or clears a link over the selection. Returns false for an unsafe URL. */
  setLink(href: string | null): boolean {
    const target = this.#selectionTarget();

    if (
      !target ||
      !this.#editable ||
      target.range.start === target.range.end ||
      isLiteralType(target.block.type)
    ) {
      return false;
    }

    const url = href === null ? null : sanitizeUrl(href);

    if (href !== null && url === null) {
      return false;
    }

    const { range } = target;
    this.#commitResolved(target, richSetLink(this.#contentOf(target), range.start, range.end, url));
    // In the direction the reader made it, as `toggleMark` restores it.
    this.#focusResolved(target, range.start, range.end, target.backward);
    this.#syncToolbar();
    return true;
  }

  /** Opens the link popover for the current selection. */
  openLinkEditor(): void {
    const target = this.#selectionTarget();

    if (
      !target ||
      !this.#editable ||
      target.range.start === target.range.end ||
      isLiteralType(target.block.type)
    ) {
      return;
    }

    const { range, content } = target;
    const anchor = this.#selectionRect() ?? content.getBoundingClientRect();
    this.#linkContext = {
      blockId: target.block.id,
      start: range.start,
      end: range.end,
      ...(target.cell ? { cell: target.cell } : {}),
      backward: target.backward,
    };
    this.#toolbar.hide();

    this.#syncPortalDirection();
    this.#linkEditor.open(
      anchor,
      richActiveLink(this.#contentOf(target), range.start, range.end),
      pinAnchor(content, anchor),
    );
  }

  /**
   * Opens the inline equation popover at the selection.
   *
   * With a formula beside a collapsed caret -- the one before it first -- or a
   * selection that is exactly one formula, that formula is edited. A selection
   * of text becomes a formula whose TeX is that text. Otherwise a new formula
   * is inserted at the caret. Bound to Mod+Shift+E, and to a click on a
   * formula.
   *
   * Does nothing outside a text block's host or where the editor cannot edit:
   * a code block or a display equation is TeX already.
   */
  openMathEditor(): void {
    const target = this.#selectionTarget();

    if (!target || !this.#canEdit() || isLiteralType(target.block.type)) {
      return;
    }

    const content = this.#contentOf(target);
    let { start, end } = target.range;
    let existing = false;

    if (start === end) {
      const before = richSlice(content, start - 1, start)[0];
      const after = richSlice(content, start, start + 1)[0];

      if (start > 0 && isMathRun(before)) {
        start -= 1;
        existing = true;
      } else if (isMathRun(after)) {
        end += 1;
        existing = true;
      }
    } else if (end - start === 1 && isMathRun(richSlice(content, start, end)[0])) {
      existing = true;
    }

    const selected = richSlice(content, start, end);
    // A selection becomes TeX the way an equation takes text: a formula in it
    // is its bare TeX, never `$…$` -- a bare `$` inside a formula ends it.
    const tex = existing
      ? (selected[0]?.math ?? '')
      : richToPlainText(contentForType('math', selected));
    const cell = target.cell ? { cell: target.cell } : {};

    this.#mathContext = {
      blockId: target.block.id,
      start,
      end,
      existing,
      selection: {
        blockId: target.block.id,
        start: target.range.start,
        end: target.range.end,
        ...cell,
      },
      ...cell,
    };
    this.#toolbar.hide();
    this.#syncPortalDirection();
    this.#mathEditor.open(
      this.#mathAnchor(target.content, content, start, existing) ??
        this.#selectionRect() ??
        target.content.getBoundingClientRect(),
      tex,
      existing,
    );
  }

  /**
   * The formula element at `start`, measured, when there is one to point at.
   *
   * Found by counting: the formulas before `start` in the model are the
   * elements before it in the host, one each. Measuring every element's offset
   * to find the one at `start` cost the square of the formulas in the block
   * on every click.
   */
  #mathAnchor(
    host: HTMLElement,
    content: RichText,
    start: number,
    existing: boolean,
  ): DOMRect | null {
    if (!existing) {
      return null;
    }

    const index = richSlice(content, 0, start).filter(isMathRun).length;

    return host.querySelectorAll('[data-neditor-math]')[index]?.getBoundingClientRect() ?? null;
  }

  /**
   * Focuses a block, or the first editable one when no id is given.
   *
   * Returns false when there is nowhere to put a caret — an unknown id, a block
   * inside a collapsed toggle, or a void one such as a divider. Silence was the
   * bug: the caller went on believing the editor was back in text mode while it
   * was in neither, and the next keystroke reached nothing at all.
   *
   * And false whenever the host does not hold focus afterwards, which is the
   * only proof there is: a read-only host is not focusable at all, and
   * outside an open modal `<dialog>` everything is inert. Both answered `true`
   * with focus left on `<body>`, and a caller that trusted it -- the editor's
   * own hand-back after `setDocument` -- went no further. A focus that did not
   * land changes nothing else: the block selection, the caret and the scroll
   * stay as they were, so the caller is free to try somewhere else.
   */
  focus(id?: string, offset = 0): boolean {
    // Wherever the caret is put, a run of ↑/↓ starts again from there: a host
    // that focused the place the last run ended went on with that run's
    // column. The editor's own crossings note the run again after this.
    this.#goal = null;
    const target = id ?? this.#visible().find((block) => !isVoidType(block.type))?.id;

    if (!target) {
      return false;
    }

    const view = this.#renderer.getView(target);

    if (!view?.content) {
      return false;
    }

    // `focus()` dispatches `focusin` synchronously, and `#handleFocusIn` turns
    // that into the event -- so emitting unconditionally here as well delivered
    // every focus move twice. But the browser fires nothing when the element
    // already holds focus, which is the ordinary case for moving the caret
    // within one block, and dropping the emit outright made those silent.
    const alreadyFocused = this.#activeElement() === view.content;

    if (!this.#placeFocus(view.content)) {
      return false;
    }

    // A caret and a block selection are the two modes, and they exclude each
    // other: entering one leaves the other. Both at once routed the next
    // printable key to the block selection, which replaced blocks the reader
    // could no longer see were selected. `#handleFocusIn` has ended it already
    // (`#placingFocus`); this is for a host that already held focus.
    this.#clearBlockSelection();
    this.#reveal(view.root);
    setCaretOffset(view.content, offset);

    if (alreadyFocused) {
      this.#emitter.emit('focus', { blockId: target });
    }

    return true;
  }

  /**
   * Selects a range within a block, or within one of its table cells.
   *
   * A table has one editable host per cell, so `cell` says which one the
   * offsets belong to. Without it a table resolves to its first cell — the same
   * place {@link focus} lands — which is only ever right for the header.
   *
   * Reports failure the same way {@link focus} does -- including a host that
   * did not take focus -- and leaves block selection for the same reason.
   */
  focusRange(id: string, start: number, end: number, cell?: CellCoords): boolean {
    return this.#placeRange(id, start, end, cell);
  }

  /**
   * Set while `focus`/`focusRange` move focus into a host. The focus they
   * make is the editor's own caret, never a gesture's: `#handleFocusIn` ends
   * block selection for it even within a pointer's grace period, so the
   * `focus` event it emits never reaches a listener with both modes live --
   * a host's own button calling `editor.focus()` from its click is inside
   * that period. A focus that fails fires no `focusin` on a host, and so
   * still changes nothing.
   */
  #placingFocus = false;

  /** `focusHost`, marked as the editor's own caret (`#placingFocus`). */
  #placeFocus(host: HTMLElement): boolean {
    // A caret the editor places is its own move, drawn by its own event --
    // unless it is the write being noted, which notes itself afterwards.
    this.#ownSelection = null;
    this.#placingFocus = true;

    try {
      return focusHost(host);
    } finally {
      this.#placingFocus = false;
    }
  }

  /**
   * {@link focusRange}, optionally with the focus at `start` (a backward
   * range), and without bringing the host into view where `reveal` is false:
   * a press reveals only the caret it placed, and only where that is off
   * screen (`#revealPlacedCaret`).
   */
  #placeRange(
    id: string,
    start: number,
    end: number,
    cell?: CellCoords,
    backward = false,
    reveal = true,
  ): boolean {
    // A new run, as in `focus`.
    this.#goal = null;
    const host = this.#hostFor(id, cell);

    if (!host) {
      return false;
    }

    // Only a host that took focus, as in `focus`.
    if (!this.#placeFocus(host)) {
      return false;
    }

    this.#clearBlockSelection();

    if (reveal) {
      this.#reveal(host);
    }

    setSelectionRange(host, start, end, backward && start !== end);

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

    // The argument is typed, which stops nothing at runtime: JavaScript callers
    // and a stale string from a host's own menu both reach here. An unknown
    // type was written into the model, where `normalizeDocument` silently
    // degrades it to a paragraph on the next load -- so the block quietly
    // changed type between sessions with nothing reported at the point of the
    // mistake.
    if (!isBlockType(type)) {
      return;
    }

    const source = findBlock(this.#blocks, id);

    // Nothing to change is nothing to announce: an unknown id, or the type the
    // block already has, still said "Changed to Heading 1" in the live region.
    // The same type still places the caret, though -- the README promises
    // `setBlockType` ends block selection, whatever the type.
    if (!source) {
      return;
    }

    if (source.type === type) {
      this.focus(id, CARET_END);
      return;
    }

    let blocks: Block[] = [...this.#blocks];

    // A table's text lives in its rows, which the new type cannot hold. They
    // are rehoused as the block's own text -- cells by spaces, rows by lines --
    // where the conversion had simply deleted them.
    if (isTableType(source.type) && !isTableType(type)) {
      // Only cells with text, so an empty table flattens to nothing rather
      // than to separators -- a stray paragraph of spaces for a divider.
      const lines = (source.rows ?? [])
        .map((row) => row.filter((cell) => !isRichEmpty(cell)))
        .filter((row) => row.length > 0);
      // `richConcat`'s work without its spread: a table has any number of
      // rows, and the engine caps a call's arguments.
      const flattened = normalizeRuns(
        lines
          .flatMap((row, r) => [
            ...(r > 0 ? [[{ text: '\n' }]] : []),
            ...row.flatMap((cell, c) => (c > 0 ? [[{ text: ' ' }], cell] : [cell])),
          ])
          .flat(),
      );
      blocks = updateBlock(blocks, id, { content: flattened });
    }

    const carried = findBlock(blocks, id)?.content ?? [];
    blocks = setBlockType(blocks, id, type);

    // A divider holds no text; give it a paragraph of its own, as /divider
    // does, rather than dropping what the block said.
    if (type === 'divider' && !isRichEmpty(carried)) {
      const paragraph = createBlock('paragraph', carried, source.depth);
      blocks = insertBlockAfter(blocks, id, paragraph);
      this.#commit(blocks);
      this.focus(paragraph.id, 0);
    } else {
      this.#commit(blocks);
      this.focus(id, CARET_END);
    }

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

    if (!block || block.type !== 'toggle' || this.#destroyed) {
      return;
    }

    // A read-only reader opens a toggle to read what is inside it, which is not
    // an edit -- and refusing outright left that content unreachable behind a
    // chevron the renderer still draws as an enabled, tabbable control. So it
    // is remembered as a view state instead: the document is untouched,
    // `getDocument()` still reports the toggle collapsed, and no `change` is
    // emitted for a persistence layer to write back as the author's revision.
    if (!this.#editable) {
      // An override in both directions, keyed off what is showing now rather
      // than off whether an entry exists: a set of "expanded" ids could not
      // close a toggle the document already had open, so clicking its chevron
      // announced a state change that never happened.
      const showing = this.#readerExpanded.get(id) ?? block.collapsed !== true;
      const expanded = !showing;
      this.#readerExpanded.set(id, expanded);

      this.#render();
      // Every other path that can hide a block prunes the selection behind the
      // render. This branch could only ever *reveal* until the override became
      // two-directional; now that it can hide a run of blocks, a reader closing
      // a toggle left its children selected and off screen, where Cmd+C copied
      // them.
      this.#pruneBlockSelection();
      this.#announce(expanded ? this.#labels.toggleExpanded : this.#labels.toggleCollapsed);

      return;
    }

    // The mount's own root, not the document: `document.activeElement`
    // retargets to the shadow *host* for anything inside a shadow tree, so
    // inside one this never matched a block and the branch below yanked the
    // caret into the toggle on every expand or collapse.
    const focused = this.#renderer.blockIdFromNode(this.#activeElement());
    const collapsed = block.collapsed !== true;
    // A chevron click leaves no caret in the text to record, and undo with
    // nothing to restore went to the top of the document. The toggle's own
    // text stands in, as it does for the focus below.
    this.#commit(updateBlock(this.#blocks, id, { collapsed }), null, this.#snapshotAt(block));
    this.#announce(collapsed ? this.#labels.toggleCollapsed : this.#labels.toggleExpanded);

    // Collapsing can hide the block the caret was in; catch it before it is lost.
    if (!focused || !this.#renderer.getView(focused)) {
      this.focus(id, CARET_END);
    }
  }

  /**
   * What holds focus, asked of the tree the editor is actually mounted in.
   *
   * A `ShadowRoot` has its own `activeElement`; the document's retargets to the
   * host, so reading it from there answers "the custom element" for everything
   * inside one.
   */
  #activeElement(): Element | null {
    const root = this.#root.getRootNode();

    return 'activeElement' in root
      ? ((root as Document | ShadowRoot).activeElement ?? null)
      : this.#document.activeElement;
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

    const checked = !block.checked;
    this.#commit(updateBlock(this.#blocks, id, { checked }));
    // Every sibling state change announces -- the toggle chevron, a type
    // conversion, undo, every table command. This one did not, and its checkbox
    // has tabIndex -1 so focus never lands on it to have the new state read
    // out: ticking a to-do was completely silent.
    this.#announce(checked ? this.#labels.todoChecked : this.#labels.todoUnchecked);
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }

    this.#destroyed = true;
    this.#typingOver = null;
    this.#goal = null;
    this.#root.removeEventListener('compositionstart', this.#handleCompositionStart);
    this.#root.removeEventListener('compositionend', this.#handleCompositionEnd);
    this.#root.removeEventListener('beforeinput', this.#handleBeforeInput);
    this.#root.removeEventListener('input', this.#handleInput);
    this.#root.removeEventListener('keydown', this.#handleKeyDown);
    this.#root.removeEventListener('focusin', this.#handleFocusIn);
    this.#root.removeEventListener('focusout', this.#handleRootFocusOut);
    this.#root.removeEventListener('focusin', this.#handleToolbarFocusIn);
    this.#toolbar.element.removeEventListener('focusout', this.#handleToolbarFocusOut);
    this.#tableToolbar.element.removeEventListener('focusout', this.#handleToolbarFocusOut);
    this.#root.removeEventListener('mousedown', this.#handleRootMouseDown);
    this.#root.removeEventListener('contextmenu', this.#handleContextMenu);
    this.#root.removeEventListener('click', this.#handleClick);
    this.#root.removeEventListener('paste', this.#handlePaste);
    this.#root.removeEventListener('copy', this.#handleCopy);
    this.#root.removeEventListener('cut', this.#handleCopy);
    this.#root.removeEventListener('drop', this.#handleDrop);
    this.#root.removeEventListener('pointerdown', this.#handleRootPointerDown);
    this.#root.removeEventListener('pointerover', this.#handlePointerOver);
    this.#root.removeEventListener('pointerleave', this.#handlePointerLeave);
    this.#document.removeEventListener('scroll', this.#handleViewportChange, true);
    for (const shadow of this.#shadowTrees) {
      shadow.removeEventListener('scroll', this.#handleViewportChange, true);
    }
    this.#document.defaultView?.removeEventListener('resize', this.#handleViewportChange);
    this.#document.removeEventListener('pointermove', this.#handlePointerMove);
    this.#document.removeEventListener('pointerup', this.#handlePointerUp, true);
    this.#document.removeEventListener('pointercancel', this.#handlePointerCancel, true);
    this.#document.removeEventListener('pointerdown', this.#handleDocumentPointerDown);
    this.#document.removeEventListener('focusin', this.#handleDocumentFocusIn, true);
    for (const { doc } of this.#outerDocuments) {
      try {
        doc.removeEventListener('pointerdown', this.#handleOuterPointerDown, true);
        doc.removeEventListener('focusin', this.#handleOuterFocusIn, true);
        doc.removeEventListener('scroll', this.#handleViewportChange, true);
      } catch {
        // A document that has gone away holds no listeners worth removing.
      }
    }
    for (const type of ['copy', 'cut', 'paste'] as const) {
      this.#document.removeEventListener(type, this.#handleDocumentClipboard);
    }
    this.#document.removeEventListener('keydown', this.#handleDocumentKeyDown, true);
    this.#document.removeEventListener('selectionchange', this.#handleSelectionChange);
    this.#document.removeEventListener('keydown', this.#handleExitKeyDown, true);
    this.#backAfterLetGo = false;
    this.#document.removeEventListener('pointerdown', this.#disarmExit, true);
    this.#document.removeEventListener('focusin', this.#disarmExit, true);
    for (const doc of [this.#document, ...this.#outerDocuments.map(({ doc }) => doc)]) {
      try {
        doc.removeEventListener('keydown', this.#guardBackspace, true);
        doc.removeEventListener('pointerdown', this.#spendBackGuard, true);
        doc.removeEventListener('focusin', this.#spendBackGuard, true);
      } catch {
        // A document that has gone away holds no listeners worth removing.
      }
    }
    this.#root.removeEventListener('keyup', this.#flushAfterKey);
    this.#removeExitStop();
    this.#cancelAfterKey();

    this.#cancelLongPress();
    this.#stopAutoScroll();
    this.#slashMenu.destroy();
    this.#toolbar.destroy();
    this.#linkEditor.destroy();
    this.#mathEditor.destroy();
    this.#gutter.destroy();
    this.#liveRegion.remove();
    this.#slashLabel.remove();
    this.#iconPicker.destroy();
    this.#imageEditor.destroy();
    this.#tableToolbar.destroy();
    this.#dropIndicator.remove();
    this.#renderer.destroy();
    this.#emitter.clear();
    this.#root.classList.remove('neditor');

    if (this.#originalClassAttribute === null && this.#root.getAttribute('class') === '') {
      this.#root.removeAttribute('class');
    }

    if (this.#originalTheme === null) {
      this.#root.removeAttribute('data-neditor-theme');
    } else {
      this.#root.setAttribute('data-neditor-theme', this.#originalTheme);
    }

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

    // `destroy()` is documented as giving the element back the way it was
    // found, and `tabIndex = -1` was the one change it kept. A host that
    // unmounts the editor and reuses the element was left with a node that
    // silently takes focus and answers no keys.
    if (this.#ownsTabIndex) {
      this.#root.removeAttribute('tabindex');
    } else {
      this.#root.tabIndex = this.#priorTabIndex;
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
    return visibleBlocks(this.#shown());
  }

  /**
   * The document as the reader is shown it: a read-only reader's own
   * overrides of what a toggle shows applied -- see `toggleCollapsed` --
   * for display only. Spread rather than mutated, so `#blocks` stays
   * exactly the document the host handed over.
   */
  #shown(): readonly Block[] {
    if (this.#readerExpanded.size === 0) {
      return this.#blocks;
    }

    return this.#blocks.map((block) => {
      const expanded = this.#readerExpanded.get(block.id);

      return expanded === undefined ? block : { ...block, collapsed: !expanded };
    });
  }

  #applyBlocks(blocks: Block[]): void {
    // A handle drag aims at a gap by its index into the document it started
    // over. Once that document is gone -- an undo, a redo, any other commit
    // mid-drag -- the index names a different place, and releasing moved the
    // blocks into it. The drag ends with the document it was aimed at.
    // (`#endDrag` commits through here itself, with `#drag` already cleared.)
    if (this.#drag) {
      this.#endDrag(null);
    }

    // Any edit, an undo or a redo ends a link continuation. Its own text check
    // cannot be relied on for that: a redo puts back the very array it held.
    // (`#typeOver` commits through here and only then starts its next one.)
    this.#typingOver = null;
    // And a run of ↑/↓: an edit starts a new one. (A crossing that commits --
    // ↓ off the end of the document -- notes its run again afterwards.)
    this.#goal = null;
    // And the note of a selection the editor wrote back (`#ownSelection`):
    // what this edit, an undo or a redo selects is drawn by its own event.
    this.#ownSelection = null;

    // A text drag the same way: its anchor and the range it has grown name
    // blocks of the old document, and left live it re-selected against the
    // new order on the next move, `data-selecting` still set.
    this.#endTextDrag();
    const previous = this.#blocks;
    this.#blocks = blocks;
    this.#render();
    this.#pruneBlockSelection(previous);
    this.#refreshGutter();
    this.#emitChange();
  }

  /**
   * Lets go of a text drag in flight, for a document that changed under it.
   *
   * The pointer is still down, so the browser's own drag selection may carry
   * on; marked as escaped, the stray-caret check stays armed against it, as
   * after an Escape.
   */
  #endTextDrag(): void {
    if (!this.#textDrag) {
      return;
    }

    this.#textDrag = null;
    this.#textDragEscaped = this.#pointerDown;
    this.#stopAutoScroll();
    delete this.#root.dataset.selecting;
  }

  /**
   * Reads where the browser anchored the selection for a press with Shift
   * (`TextDrag.anchorPoint`), once, after the press's default action -- at
   * the drag's first move, or before a peer's update that lands first. That
   * is where its own drag is anchored, and where the editor's is when the
   * drag comes back from another block (`#returnTextDrag`). It is not the
   * reader's anchor: on macOS Chromium and Safari re-anchor a range at the
   * end farther from the click, and Firefox keeps the reader's -- read at
   * the `pointerdown`, [4,20] Shift+clicked at 11 came back [4,37] for
   * [20,37] (R13-RV8-PTR-1), and the press point before it, [4,37] for
   * [9,37] from a caret at 9 (R13-RV7-PTR-2).
   *
   * Taken without asking the range its direction: the press put the focus at
   * the click, so the anchor is whichever end is farther from the press
   * (`anchorPoint` until now, the caret under it); a caret is its own. WebKit
   * in a shadow root reports every range forward, and read as the range's
   * anchor, a caret at 9 Shift+clicked at 4 came back [4,37] for [9,37]
   * there (R13-RV9-PTR-1).
   */
  #noteDragAnchor(drag: TextDrag): void {
    if (!drag.anchorPending) {
      return;
    }

    drag.anchorPending = false;
    const host = drag.anchorHost;
    const reading = readSelection(this.#root);

    if (
      !host ||
      !reading ||
      !host.contains(reading.anchorNode) ||
      !host.contains(reading.focusNode)
    ) {
      return;
    }

    const anchor = { node: reading.anchorNode, offset: reading.anchorOffset };
    const focus = { node: reading.focusNode, offset: reading.focusOffset };
    const press = drag.anchorPoint;
    const at = press ? offsetWithin(host, press.node, press.offset) : null;
    const from = offsetWithin(host, anchor.node, anchor.offset);
    const to = offsetWithin(host, focus.node, focus.offset);

    drag.anchorPoint =
      at !== null && from !== null && to !== null && Math.abs(to - at) > Math.abs(from - at)
        ? focus
        : anchor;
  }

  /**
   * Which end of the range a press's drag is anchored at, asked of offsets
   * (`TextDrag.anchorEnd`), not of the range's direction, which WebKit in a
   * shadow root reports forward. Read before the render, against the text
   * the drag was made in. A Shift press's anchor is the end the browser
   * chose (`#noteDragAnchor`). Any other press's is the anchor the
   * selection reports (null here: `#resumeTextDrag` reads it) -- except
   * where it reports no direction (`SelectionReading.undirected`: a mouse's
   * selection in WebKit's shadow root): read as the reported anchor there, a
   * drag from 50 back to 30 that a peer's update redrew went on from 30, and
   * the release selected [10,30] for [10,50] (R14-PTR-2). There a
   * multi-click's is the side of its own unit the range kept (a forward
   * drag keeps the unit's start, a backward one its end), and a single
   * press's the end nearer the press -- nearer rather than equal, since the
   * caret read under the press can round to the other side of a glyph from
   * the browser's. Only there: Chromium anchored a drag pressed seven
   * tenths across a letter before it, where the caret read under the press
   * is after it, and asked everywhere, a peer's update landing one
   * character into that drag anchored it a character late, [31,55] for
   * [30,55], where round 13 and the same drag with no peer held 30. Null for
   * a caret, or where neither end is it. The multi-click rule is not the
   * nearer end's: a word pressed near its end and dragged a short way on
   * has its press nearer the far end, and its anchor at the word's start.
   */
  #anchorEndOf(drag: TextDrag): 'start' | 'end' | null {
    const target = this.#selectionTarget();
    const point = drag.anchorPoint;

    if (!target || target.content !== drag.anchorHost) {
      return null;
    }

    const { start, end } = target.range;
    const at = point ? offsetWithin(target.content, point.node, point.offset) : null;

    if (start === end) {
      return null;
    }

    if (drag.shift) {
      return at === start ? 'start' : at === end ? 'end' : null;
    }

    if (!readSelection(this.#root)?.undirected) {
      return null;
    }

    const unit = drag.unit;

    if (unit) {
      return start === unit.start && end !== unit.end
        ? 'start'
        : end === unit.end && start !== unit.start
          ? 'end'
          : null;
    }

    if (at === null) {
      return null;
    }

    const toStart = Math.abs(at - start);
    const toEnd = Math.abs(end - at);

    return toStart < toEnd ? 'start' : toEnd < toStart ? 'end' : null;
  }

  /**
   * Reads the word or paragraph the browser selected for a multi-click
   * press (`TextDrag.unit`), once, before the drag's first move -- or before
   * a peer's update that lands first. That is the browser's own unit by its
   * own rules: the line break a triple-click takes in Chromium and WebKit,
   * the space after a word where the platform takes it. Read later it is
   * not: Chromium and WebKit go on by character once anything writes the
   * selection, and WebKit's own backward word drag reports, between moves, a
   * range without the word that was double-clicked. Nothing for a press with
   * Shift that left the reader's range -- both ends and its direction -- as
   * it held it at the press (`TextDrag.heldRange`): Chromium's and WebKit's
   * Shift+double-click, which extend it and go on by character, and a
   * Firefox re-anchor that happens to leave both unchanged (a documented
   * limit). A Shift press that re-anchored -- on a paragraph in every
   * engine, on a word in Firefox -- changed the range or its direction, and
   * what it holds now is read as the unit.
   */
  #noteDragUnit(drag: TextDrag): void {
    if (drag.unitRead || drag.detail < 2) {
      return;
    }

    drag.unitRead = true;
    const target = this.#selectionTarget();

    // A Shift multi-click that only extended the reader's own range: the
    // range the browser holds at the first move is the one it held when this
    // press came down -- both ends and the direction; the click before it
    // did the extending, and this press changed nothing (Chromium's and
    // WebKit's Shift+double-click). The browser goes on from there by
    // character, and so does the editor. Taken as the unit, the whole
    // extended range was never given up -- dragged back towards its anchor
    // it stayed [2, 27] where theirs was [2, 12] (R13-RV5-PTR-1). A press
    // that re-anchored on a word or a paragraph changed the range or its
    // direction -- every engine's Shift+triple-click, every Firefox Shift
    // multi-click -- and what it holds is the unit. Asked by the anchor end
    // alone, a caret at 0 and Shift+triple-click on "over" went by
    // character, [0,11] for [0,43] (R13-RV6-PTR-1); by both ends without the
    // direction, Firefox's "quick" re-anchored forward over the reader's
    // backward [4,9] went by character, [4,37] for [4,39] (R13-RV7-PTR-1).
    // Where a re-anchor leaves range and direction exactly as they were --
    // Firefox's Shift+double-click on the word the reader's range already
    // was, in its direction; Shift+triple-click in a one-word paragraph --
    // nothing tells it from an extension, and it goes by character: a
    // documented limit. Where the direction cannot be read (WebKit in a
    // shadow root reports every range forward), both reads say forward and
    // the ends alone decide.
    if (
      target &&
      drag.heldRange !== null &&
      target.range.start === drag.heldRange.start &&
      target.range.end === drag.heldRange.end &&
      target.backward === drag.heldRange.backward
    ) {
      return;
    }

    if (target && target.content === drag.anchorHost && target.range.start < target.range.end) {
      drag.unit = {
        start: target.range.start,
        end: target.range.end,
        text: richToPlainText(this.#contentOf(target)),
      };
    }
  }

  /**
   * Gives a text drag that a peer's `setDocument` ended back to the press
   * still selecting in its own block, when the update redrew that block and
   * the carry wrote the reader's caret or range back into it
   * (`#carryTextSelection`) -- anchored at the carried anchor, the press's
   * own text node being gone, and drawn by the editor on every move as a
   * drag back in its own block is (`returned`, `#returnTextDrag`).
   *
   * The browser's own drag selection does not survive that write. In
   * Chromium, written while the drag had begun but the pointer had not yet
   * left the first character -- the selection still a caret -- every later
   * move put a caret under the pointer, and the release selected nothing (6
   * to 8 in 30 drags with a peer typing every 200 ms, R13-RV2-PTR-3); a
   * range written mid-drag it extended on, by character. A double- or
   * triple-click drag lost its unit in Chromium and WebKit, which went on by
   * character ("quick ... lazy d", "The qu"); Firefox kept it until the
   * editor drew the drag, by character (R13-RV3-PTR-1). So the editor draws
   * it by the press's own unit (`TextDrag.unit`): the word or paragraph the
   * browser itself selected for the press (`#noteDragUnit`), carried here by
   * `carryRange` as the reader's range is -- re-derived from the carried
   * range instead, a backward drag lost the word that was double-clicked
   * and a paragraph its line break (R13-RV4-PTR-3, -4) -- to the word or
   * paragraph at the caret nearest the pointer (`farUnit`), Chromium's and
   * WebKit's own rule in text of one direction. Measured against the same
   * drag with no peer, at two points of every character: Chromium the same
   * everywhere; WebKit where its words are not `Intl.Segmenter`'s ("It'"
   * for "It's", "3." for "3.14", 8 of 102 points of punctuated English), and
   * at spaces in its backward drags in right-to-left text; Firefox where it
   * runs on over a run of spaces at the caret to the next word (9 of 38
   * forward, 9 of 50 backward) and where its words differ (punctuation,
   * numbers). In mixed-direction text, the caret at the visual edge of a run
   * is ambiguous, and the word after it can be the one visually on the
   * other side (Chromium and WebKit, 2-3 of 50-66 points; Firefox none) --
   * as ambiguous as the character a drag by character drew there before,
   * and their own drags with no peer lose the double-clicked word at far
   * more points. All of these are documented limits. Only an unpromoted
   * drag (one across blocks goes on by its ids, `#resumePromotedDrag`, or
   * ends), only while the button is down, and only where the update
   * rewrote the press's own text: a host the update did not touch keeps the
   * browser's drag as it was, and the editor's watch on it for the block
   * edge where the update kept the blocks' order (R14-RV1-1).
   */
  #resumeTextDrag(
    drag: TextDrag | null,
    follow: FollowState | null = null,
    shownBefore: readonly string[] | null = null,
  ): void {
    if (!drag || drag.promoted || !this.#pointerDown || this.#textDrag) {
      return;
    }

    const live = this.#selectionTarget();
    const reading = readSelection(this.#root);
    const pressed = drag.anchorHost;

    if (
      !live ||
      !reading ||
      !pressed ||
      live.block.id !== drag.anchorBlockId ||
      // (Whether the host holds focus is not asked: a read-only view's
      // blocks hold none, and its drag is given back all the same; in an
      // editable one, a press that is still selecting here with focus
      // gone elsewhere was not reached by any input tried -- the keyboard
      // moves the selection with the focus, and that ends it above.)
      !live.content.contains(reading.anchorNode) ||
      // Redrawn in place, or replaced by the same block's new host (a
      // paragraph a peer made a heading); never a table's rebuilt cell.
      (pressed !== live.content && (pressed.isConnected || live.cell !== undefined))
    ) {
      return;
    }

    // The press's own text still there: the update did not redraw it. The
    // browser's own drag carries on there -- but a drag the editor draws
    // (`placed`: its press was cancelled; `returned`) has no drag of the
    // browser's behind it, and ended here it stopped following the pointer
    // at whatever it held: [0,2] for [0,16] after a peer's edit to another
    // block (R13-RV12-PTR-4). It goes on as it was, anchor and all --
    // over an update that reorders the other blocks too, by the new
    // order: its anchor is in this host's text, and the blocks it crosses
    // into are read from the document as it is at each move.
    // The browser's own drag is tracked again too, untouched: it goes on
    // drawing itself in that host, and the editor only goes on watching
    // for the block edge. Ended here, it could no longer become a block
    // selection once it left its block, and a drag from p1 to p6 with a
    // peer typing in p15 before it had left p1 released a range of p1's
    // text, 3 to 8 drags in 30 (R14-RV1-1). Only over an update that left
    // the blocks shown in their order, the rule a drag across blocks is
    // given back by (`#resumePromotedDrag`); over any other it ends, as it
    // always did, and is the browser's alone.
    if (drag.anchorPoint !== null && live.content.contains(drag.anchorPoint.node)) {
      const shown = this.#visible();
      const sameOrder =
        shownBefore !== null &&
        shownBefore.length === shown.length &&
        shown.every((block, index) => block.id === shownBefore[index]);

      if (drag.placed || drag.returned) {
        this.#textDrag = drag;
        this.#textDragEscaped = false;
        this.#followAgain(follow);
      } else if (sameOrder) {
        this.#textDrag = drag;
        this.#textDragEscaped = false;
      }

      return;
    }

    // The browser's own word or paragraph, carried by the text around it as
    // the reader's range is (`carryRange`): what every reading of the edit
    // agrees on, so never text the reader did not select. Nothing left of it,
    // the drag goes on by character.
    const text = richToPlainText(this.#contentOf(live));
    const unit = drag.unit;
    const carried = unit ? carryRange(unit.text, text, unit.start, unit.end) : null;

    // The drag's anchor is an end of the range (`anchorEnd`: the one a
    // Shift press's browser chose, or, where the selection reports no
    // direction, the press's own), carried with the range; asked of the
    // carried range's direction, WebKit in a shadow root -- which reports
    // it forward -- put it at the start, and a drag back from 50 went on
    // from 30 (R14-PTR-2). Otherwise it is the anchor the selection reports.
    const ownEnd =
      drag.anchorEnd && live.range.start !== live.range.end
        ? locate(live.content, drag.anchorEnd === 'start' ? live.range.start : live.range.end)
        : null;

    const anchorPoint = ownEnd ?? { node: reading.anchorNode, offset: reading.anchorOffset };
    const kept =
      carried && carried.start < carried.end
        ? { start: carried.start, end: carried.end, text }
        : null;

    // Where the range as carried was drawn to (`TextDrag.lastFocus`), for a
    // move that finds no caret before any move has found one -- the pointer
    // taken straight from the update under something the page draws over
    // the text: the range is drawn there again as it was carried. Its far
    // end from the anchor; for a word or a paragraph, a caret that names
    // the unit at its far end (`farUnit` takes the one after the caret).
    // Left to stand instead, the browser's own drag went on from the
    // anchor it reports, and WebKit's in a shadow root, which had been
    // dragging back from 38, released [14,23] for [23,38] (R14-FX-1).
    const { start, end } = live.range;
    const from = offsetWithin(live.content, anchorPoint.node, anchorPoint.offset);
    const far =
      start === end
        ? null
        : kept
          ? start < kept.start
            ? start
            : end > kept.end
              ? end - 1
              : null
          : from === start
            ? end
            : from === end
              ? start
              : null;

    this.#textDrag = {
      ...drag,
      anchorHost: live.content,
      anchorPoint,
      anchorPending: false,
      returned: true,
      unit: kept,
      lastFocus: far === null ? null : locate(live.content, far),
    };
    this.#textDragEscaped = false;
    this.#followAgain(follow);
  }

  /**
   * Goes on following a resting pointer for a drag a peer's update gave
   * back (`#followState`). Held at the window's edge the pointer sends no
   * move, and with the scroll `#endTextDrag` stopped left stopped, a drag
   * the editor draws through one tall block stood still after each update
   * until the hand moved -- 375px and [.., 3762] for half a second, where
   * the same drag with no peer reached 1065px and 6410 (R14-FX-2); a drag
   * across blocks the same way (R14-PTR-5).
   */
  #followAgain(follow: FollowState | null): void {
    if (follow) {
      this.#followPointer(follow, follow.pressY);
    }
  }

  /**
   * What a drag across blocks needs to go on over a peer's update
   * (`#resumePromotedDrag`), read before the render and before the drag is
   * ended: the order of the blocks it selects in, its press's offset into
   * its own block's text, and where the pointer it follows at a scroll edge
   * rests (`#autoScroll`).
   */
  #promotedDragState(drag: TextDrag): PromotedDragState {
    const host = drag.anchorHost;
    const point = drag.anchorPoint;
    const offset =
      host && point && host.contains(point.node)
        ? offsetWithin(host, point.node, point.offset)
        : null;

    return {
      visible: this.#visible().map((block) => block.id),
      anchor:
        host && offset !== null ? { text: richToPlainText(parseRichText(host)), offset } : null,
      follow: this.#followState(),
    };
  }

  /**
   * Where the pointer a drag follows at a scroll edge rests (`#autoScroll`),
   * read before `#endTextDrag` stops the scroll, for the drag a peer's
   * update gives back (`#resumeTextDrag`, `#resumePromotedDrag`).
   */
  #followState(): FollowState | null {
    const follow = this.#autoScroll;

    return follow
      ? {
          pointerId: follow.pointerId,
          clientX: follow.x,
          clientY: follow.y,
          pressY: follow.pressY,
        }
      : null;
  }

  /**
   * Gives a drag across blocks -- a block selection a press is still
   * growing (`TextDrag.promoted`) -- back after a peer's update that left
   * the blocks it selects in the order they were shown in, its own block
   * among them: an edit to any block's text, here or far away. Ended, it
   * stopped following the pointer, and a drag from p1 to p6 with a peer
   * typing in p15 on the way released p1-p3 (R14-PTR-5). The selection it
   * grows was kept by id (`#keepBlockSelection`) and the range it extends
   * is between ids, so nothing it holds names the old document. An update
   * that reorders, adds or removes a shown block -- or takes its own away
   * -- still ends it, as `#endTextDrag` was written for: it re-selected
   * against the new order. Its press's place in its own block, for the
   * drag back there as text, is carried by the text around it as the
   * reader's caret is (`carryOffset`), and its word or paragraph as the
   * reader's range is (`carryRange`); where its own block's host was
   * replaced, the block's new one takes it, never a table's rebuilt cell.
   * Where nothing carries the press -- its block's text replaced whole,
   * its block become one with no text, a table's cells rebuilt, or a
   * drag that began on a block with no text -- the drag goes on across
   * blocks all the same, with no place in its own block to come back to
   * as text: back over it, the selection is that block alone, as for a
   * drag begun on a divider (`#returnTextDrag`). No offset is guessed,
   * least of all 0.
   * And the pointer goes on being followed where it rests (`#followPointer`):
   * held at the window's edge, which is how a long run of blocks is
   * selected, it sends no move, and with the scroll that `#endTextDrag`
   * stopped left stopped, the selection stood still until the hand moved.
   */
  #resumePromotedDrag(drag: TextDrag | null, before: PromotedDragState | null): void {
    if (!drag?.promoted || !before || !this.#pointerDown || this.#textDrag) {
      return;
    }

    const visible = this.#visible().map((block) => block.id);

    if (
      visible.length !== before.visible.length ||
      visible.some((id, i) => id !== before.visible[i])
    ) {
      return;
    }

    let { anchorHost, anchorPoint, unit } = drag;

    if (!anchorHost?.isConnected || !anchorPoint || !anchorHost.contains(anchorPoint.node)) {
      const view = this.#renderer.getView(drag.anchorBlockId);
      const host = anchorHost?.isConnected
        ? anchorHost
        : view && !view.cells
          ? (view.content ?? null)
          : null;
      const text = host ? richToPlainText(parseRichText(host)) : null;
      const at =
        host && text !== null && before.anchor
          ? carryOffset(before.anchor.text, text, before.anchor.offset, 'before')
          : null;

      const carried =
        unit && text !== null ? carryRange(unit.text, text, unit.start, unit.end) : null;
      const kept = host !== null && text !== null && at !== null;

      anchorHost = kept ? host : null;
      anchorPoint = kept ? locate(host, at) : null;
      unit = kept && carried && carried.start < carried.end ? { ...carried, text } : null;
    }

    this.#textDrag = { ...drag, anchorHost, anchorPoint, unit };
    this.#textDragEscaped = false;
    this.#root.dataset.selecting = 'true';

    this.#followAgain(before.follow);
  }

  /**
   * Drops selected ids the new document no longer shows.
   *
   * `previous` is the order the selection was made in -- the document before
   * the edit or the replacement -- which is where a lost anchor's nearest
   * survivor is measured.
   */
  #pruneBlockSelection(previous: readonly Block[] = this.#blocks): void {
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
    //
    // The survivor nearest the lost anchor, in the order the selection was
    // made in, takes its place -- the end the reader extended from. The first
    // id kept was the far end of a selection grown upwards: a peer deleting
    // the anchor of [b, c, d] (made from d) turned Shift+↑ into a shrink to
    // [b] instead of a growth to [a, b, c]. Ties go to the earlier block.
    if (this.#selectionAnchor !== null && !alive.has(this.#selectionAnchor)) {
      this.#selectionAnchor = nearestSurvivor(previous, this.#selectionAnchor, kept);
    }

    this.#renderer.setSelected(this.#selected);
    this.#emitter.emit('blockselection', { ids: this.#orderedSelection() });
  }

  /**
   * Carries a block selection across a replaced document (`setDocument`).
   *
   * Identity decides, and only identity: the editor never guesses which
   * block of the new document the reader meant. `ids` is the selection
   * before, in `previous`'s order. The ones the new document still shows
   * stay selected, as an edit keeps them; a lost anchor passes to the
   * survivor nearest it. When none do, the selection ends, and where the
   * root held the focus block selection gives it (`mayFocus`) the root lets
   * go of it (`#letGo`): the reader clicks or tabs back in, and a key
   * pressed meanwhile lands nowhere, which loses nothing. Focus elsewhere
   * stays where it is, and so does the live region: this is a document
   * arriving, not the reader moving, and "No blocks selected" spoken over a
   * field they were typing in described an editor they had left.
   *
   * Never a neighbour. Every block the new document still has by id is one
   * the reader did not choose: a peer deleting the selected "Beta" handed the
   * caret to "Gamma" (round 11), and the Backspace, Delete or letter the
   * reader pressed for the selection merged "AlphaGamma", ate the "G" or
   * typed "xGamma". Every other guess tried here took something too: found
   * by position, the old index named the block after a blank line Markdown
   * dropped -- with seventy blank lines above, sixty-nine blocks down -- and
   * typing went into it; found by content, switching to another note made
   * from the same template selected *its* "Notes" heading, and Backspace
   * deleted it. Hosts that rename blocks lose the selection on every update
   * (the README says to keep ids stable) -- and a host that loads another
   * document under the same ids (notes cloned from one template) keeps it on
   * the block that has the id, which is that document's: ids are identity
   * here, so the README tells hosts not to reuse them across documents.
   */
  #keepBlockSelection(ids: readonly string[], previous: readonly Block[], mayFocus: boolean): void {
    if (ids.length === 0) {
      return;
    }

    const shown = new Set(this.#visible().map((block) => block.id));

    if (ids.some((id) => shown.has(id))) {
      this.#pruneBlockSelection(previous);
      return;
    }

    this.#clearBlockSelection();

    if (!mayFocus) {
      return;
    }

    this.#announceSelectionCount(0);
    this.#letGo();
  }

  /**
   * Takes focus off the root when nothing names where the reader was.
   *
   * For a block-mode edit or a replaced document after which no block the
   * reader chose is still there by id; for a read-only switch that ends a
   * block selection (`setEditable`); and, given a host (`from`), for a
   * caret whose text changed on both sides of it (`#carryTextSelection`).
   * The root holding focus with nothing selected and no caret is neither mode: every
   * key fell on the floor. Selecting or putting the caret in some other block
   * instead is a guess, and each guess has selected, typed into or deleted a
   * block the reader never chose. Blurred, the root takes nothing: the reader
   * clicks or tabs back in, exactly as after a panel that held focus closes
   * under `setDocument`. A key pressed meanwhile goes to the page, and the
   * one that could cost the page itself -- WebKit's Backspace on `<body>`
   * goes back in history -- is held off (`#backAfterLetGo`).
   * Only `from` holding focus: focus that is anywhere else is the reader's.
   */
  #letGo(from: HTMLElement = this.#root): void {
    if (this.#activeElement() === from) {
      from.blur();
      this.#backAfterLetGo = true;
    }
  }

  /** The control in one of the editor's own panels that holds focus, if any. */
  #panelFocus(): HTMLElement | null {
    for (const portal of this.#portals) {
      const tree = portal.getRootNode();
      const active = 'activeElement' in tree ? (tree as Document | ShadowRoot).activeElement : null;

      if (active && portal.contains(active)) {
        return active as HTMLElement;
      }
    }

    return null;
  }

  /**
   * Whether the reader's keys go to `host`, read from focus alone: it holds
   * focus in its own tree. In an iframe mount that is enough -- measured in
   * every engine and six ways of leaving the frame, the frame's own document
   * lets go of the block (its `activeElement` is its `<body>`) whenever focus
   * goes anywhere in the page around it.
   *
   * Never the window's own focus (`document.hasFocus()`): that is false
   * whenever the tab or the window is in the background, and a peer's update
   * landing then dropped the caret of a reader who had only looked away --
   * Chromium typed their next word at offset 0, Firefox and WebKit lost it.
   */
  #typingIn(host: HTMLElement): boolean {
    return holdsFocus(host);
  }

  /**
   * Draws the toolbars again for the reader's caret or range after a
   * `setDocument` or an unlock hid them: a caret or range that survived in
   * the host still holding focus is still being edited, so its toolbar comes
   * back, as focus coming back draws it (`#handleToolbarFocusIn`). Hidden,
   * they stayed gone until the selection moved, and a cell scrolled away lost
   * the note that brings its toolbar back. Only where focus already is --
   * this never moves it.
   *
   * And only a toolbar that was showing (`formatShown`, `tableShown`, read
   * before they were hidden). Re-synced from the selection alone, one Escape
   * had dismissed came straight back, so with a peer's edit landing between
   * presses Escape never got past it to the block and the blur -- the
   * Escape-twice exit was gone -- and one for a range scrolled out of sight
   * was drawn at the window's edge. The format toolbar comes back only while
   * its range is still on screen; the table toolbar's own sync asks that, and
   * notes a cell scrolled away again. This is the only redraw the editor's
   * own write of that selection gets: the `selectionchange` and the focus the
   * write itself causes draw nothing (`#ownSelection`).
   */
  #redrawToolbars(formatShown: boolean, tableShown: boolean): void {
    const kept = this.#selectionTarget();

    if (!kept || !holdsFocus(kept.content)) {
      return;
    }

    const range = kept.range.start !== kept.range.end;

    if (formatShown && range && this.#selectionOnScreen(kept.content)) {
      this.#syncToolbar();
    } else if (tableShown && kept.cell && (!range || !this.#useToolbar)) {
      this.#syncTableToolbar();
    }
  }

  /**
   * The reader's caret or range as the editor last wrote it back itself --
   * carried across a peer's redraw of its host (`#carryTextSelection`), or
   * given back by an unlock (`#restoreLockedCaret`) -- for the one
   * `selectionchange` that write causes.
   *
   * Whoever writes it decides what it draws (`#redrawToolbars`). The write
   * queues a `selectionchange` that arrives after the caller has returned,
   * and the focus it may give the host is a `focusin`; answered as the
   * reader's own, both drew the format toolbar for it -- the one Escape had
   * dismissed, so with a peer typing in the reader's block between presses
   * Escape never got past it (R13-PTR-1), and one for a range scrolled out
   * of sight, clamped to the window's edge, whose Bold bolded text no one
   * could see (R13-PTR-2). So `#handleSelectionChange` leaves the toolbars
   * alone for that event, and `#handleToolbarFocusIn` stands down during the
   * write.
   *
   * One event, and only that one: every write measured causes exactly one
   * `selectionchange` in every engine -- in place, into a replaced host, an
   * unlock in the same task or a later one, the selection unchanged or not
   * -- so the first one handled after the write ends the note, matching or
   * not. Kept until the selection changed (round 13's first version), it
   * outlived its event and passed over the reader's own later selections
   * that happened to equal it: the range an undo or a redo restores after
   * ⌘B on the carried range drew no toolbar again (R13-RV-PTR-1). Should a
   * write's event ever not come -- none was measured that did not -- the
   * note also ends when the editor writes a selection of its own
   * (`#applyBlocks`, `#placeFocus`). A key does not end it: Escape, which
   * dismisses the toolbar, can be handled before the write's queued
   * `selectionchange` arrives.
   *
   * And never over a change of the reader's still on its way. Their own
   * change of the selection whose `selectionchange` has not yet been
   * handled (`#selectionChangePending`) shares that one event with the
   * write -- the browser coalesces them -- so passing it over dropped the
   * toolbar for a range the reader had just made, whenever a peer's update
   * landed between their Shift+← or double-click and its event (up to 9 in
   * 40 in WebKit with a peer typing, R13-RV-PTR-2). Then the write is not
   * noted, and the event is answered as the reader's.
   */
  #ownSelection: { host: HTMLElement; start: number; end: number } | null = null;

  /** Set while the editor writes the reader's selection back (`#ownSelection`). */
  #writingOwnSelection = false;

  /**
   * The selection the last `selectionchange` handled found, by host and
   * offsets (`#selectionChangePending`).
   */
  #handledSelection: { host: HTMLElement; start: number; end: number } | null = null;

  /**
   * Whether the live selection is not the one the last `selectionchange`
   * handled found: something changed it and its event is still queued --
   * the reader's own move, which a write of the editor's must not pass over
   * (`#ownSelection`). Asked before the write, of the selection it replaces.
   */
  #selectionChangePending(): boolean {
    const live = this.#selectionTarget();
    const handled = this.#handledSelection;

    if (!live || !handled) {
      return live !== handled;
    }

    return (
      live.content !== handled.host ||
      live.range.start !== handled.start ||
      live.range.end !== handled.end
    );
  }

  /**
   * Writes the reader's selection back into `host` through `write` (which
   * answers whether it wrote), and notes what the host now reads as the
   * editor's own (`#ownSelection`) -- unless a change of the reader's was
   * still on its way when the write began (`pending`).
   */
  #writeOwnSelection(host: HTMLElement, pending: boolean, write: () => boolean): void {
    this.#writingOwnSelection = true;
    let written = false;

    try {
      written = write();
    } finally {
      this.#writingOwnSelection = false;
    }

    const now = written && !pending ? this.#selectionTarget() : null;

    this.#ownSelection =
      now?.content === host ? { host, start: now.range.start, end: now.range.end } : null;

    // And what the next write asks about is this one, not the selection the
    // event will find: a second update in the same task -- a peer typing
    // fast -- found the selection the first had written, took it for the
    // reader's, and drew the toolbar Escape had dismissed.
    if (this.#ownSelection) {
      this.#handledSelection = this.#ownSelection;
    }
  }

  /**
   * Takes the live selection as handled (`#selectionChangePending`): the
   * editor itself changed it, and a write after this is not passing over the
   * reader's change. A lock does: WebKit drops the selection when the lock
   * blurs the block, and the unlock took that for the reader's move.
   */
  #selectionHandledHere(): void {
    const live = this.#selectionTarget();
    this.#handledSelection = live
      ? { host: live.content, start: live.range.start, end: live.range.end }
      : null;
  }

  /**
   * Whether `target`, the live selection a `selectionchange` found, is the
   * one the editor wrote back itself (`#ownSelection`). Either way the note
   * is spent: it stands for one event.
   */
  #takeOwnSelection(target: (ResolvedTarget & { range: OffsetRange }) | null): boolean {
    const own = this.#ownSelection;
    this.#ownSelection = null;

    return (
      own !== null &&
      target?.content === own.host &&
      target.range.start === own.start &&
      target.range.end === own.end
    );
  }

  /**
   * Carries the reader's caret or range across a `setDocument` that redrew
   * the host it is in -- a peer's edit to the very block, or cell, the reader
   * is in. The render rebuilds the host's children, and the browser drops a
   * selection inside them to offset 0: the next characters were typed at the
   * block's start (`XNEW Hello world`).
   *
   * Where the reader is typing (`#typingIn`), each end is carried by the
   * text around it (`carryOffset`): it keeps its offset while the text before
   * it is unchanged, else its distance from the end while the text after it
   * is, else -- deleted around it -- where the deleted text was. Where text
   * was put in across an end, nothing says where the reader was, and the host
   * lets go of focus (`#letGo`) with the range dropped, as a block selection
   * whose blocks are gone does: the reader clicks back in.
   *
   * The block's host replaced rather than redrawn -- a peer turning the
   * paragraph into a heading, same id, same text -- is the same block: the
   * new host takes the caret, carried the same way. Not a table cell: a
   * table a peer reshapes is rebuilt, and its cells have no ids, so the cell
   * the caret was in is not looked for by coordinates or content (round 11);
   * focus is on the page, guarded. Nor a block that is no longer text.
   *
   * A composition live in the host (`composition`) is never let go of: its
   * text is in the model but in no document a peer sends -- it is not
   * committed and fires no `change` -- so the text around the caret always
   * looked changed and the host let go mid-word, losing it and everything
   * typed after. Carried instead from where it began, against the text it
   * began from, and to the start of the changed text where nothing else says
   * (`carryOffset`'s `always`); the browser commits it there.
   *
   * A range kept in a host the reader is *not* typing in -- they pressed a
   * page button, which WebKit does not focus -- is dropped: WebKit's own
   * reading of it disagreed with the live range after the redraw (`DIV:4`
   * against `DIV:0`), so the editor read 0..0 while WebKit typed at the
   * fourth child, and in a shadow mount the composed range was clamped onto
   * the new children, so a host's Bold covered the peer's text instead of
   * the reader's. Whatever it held is gone with the text it was in. Answers
   * whether it dropped one of those -- or the update took such a range's
   * host away (deleted, renamed, a table rebuilt) -- which the caller guards
   * against.
   *
   * A host the update did not touch keeps its selection exactly as it was:
   * a host's own toolbar button acts on it (`toggleMark` from its click).
   */
  #carryTextSelection(
    target: (ResolvedTarget & { range: OffsetRange; backward: boolean }) | null,
    typing: boolean,
    composition: CompositionState | null,
    pending = false,
  ): boolean {
    if (!target) {
      return false;
    }

    const { block, cell, content: host, range, backward } = target;
    const composing = composition !== null && composition.host === host;
    const now = this.#targetFor(block.id, cell);
    const text = now ? this.#contentOf(now) : null;
    const was = this.#contentOf(target);

    // Carried by the text the reader had, or by the text a composition
    // started from and the offset it started at.
    const carry = (): { start: number; end: number } | null => {
      const before = richToPlainText(composing ? composition.content : was);
      const after = richToPlainText(text ?? []);

      if (composing) {
        const at = carryOffset(before, after, composition.offset, 'before', true) ?? 0;

        return { start: at, end: at };
      }

      // A caret by `carryOffset`; a range by what every reading of the edit
      // that keeps each code point whole agrees on, both ends at once
      // (`carryRange`): carried one end at a time, repeated text let the two
      // ends read it two ways and the range grew.
      if (range.start !== range.end) {
        return carryRange(before, after, range.start, range.end);
      }

      const at = carryOffset(before, after, range.start, 'before');

      return at === null ? null : { start: at, end: at };
    };

    if (now?.content !== host) {
      // Replaced, not redrawn. Only a text block of the same id, out of a
      // table and into none, and only where the reader was typing.
      const textBlock =
        now !== null &&
        !cell &&
        !now.cell &&
        !isTableType(now.block.type) &&
        now.block.type !== 'image' &&
        !isVoidType(now.block.type);
      const ends = typing && textBlock ? carry() : null;

      if (now && ends) {
        this.#writeOwnSelection(now.content, pending, () => {
          if (!this.#placeFocus(now.content)) {
            return false;
          }

          setSelectionRange(now.content, ends.start, ends.end, backward && ends.start !== ends.end);
          return true;
        });
      }

      // A range kept in a host the reader is not typing in, and the host
      // gone with it -- deleted, renamed, a table rebuilt: WebKit was typing
      // into it from `<body>` exactly as into one the update only redrew
      // (below), and the Backspace that reached nothing afterwards went back
      // in history. Answered the same way, for the caller to guard.
      return !typing;
    }

    if (!text || richEquals(was, text)) {
      return false;
    }

    if (typing || composing) {
      const ends = carry();

      if (ends) {
        this.#writeOwnSelection(host, pending, () => {
          setSelectionRange(host, ends.start, ends.end, backward && ends.start !== ends.end);
          return true;
        });
        return false;
      }
    }

    this.#selection()?.removeAllRanges();

    if (typing) {
      this.#letGo(host);
      return false;
    }

    return true;
  }

  /**
   * Armed by `#letGo`, by a `setDocument` whose render dropped focus that
   * was in the editor -- a block, the root or a panel -- onto the page, or
   * dropped a range WebKit was typing into from `<body>`, and by a
   * `setEditable(false)` that took focus off the editor: no Backspace that
   * lands on the page itself is a Back until the reader puts focus or the
   * pointer somewhere (`#guardBackspace`, `#spendBackGuard`).
   *
   * With focus on `<body>`, WebKit's Backspace goes back in history, and the
   * reader who pressed it was in the middle of editing: a held Backspace's
   * repeats arrive there straight after the press that deleted under a
   * renaming host, and a press that seems to do nothing is answered with
   * another. Spending it on the first press, its keyup or any other key
   * (round 11's first version) let the second press, "x" then Backspace, or
   * a word typed over a block selection under a Markdown echo go Back. So
   * every Backspace aimed at the page is cancelled while it is armed, and
   * only the reader placing themselves spends it: a pointerdown, a focusin
   * onto anything but the page, and `destroy`. Not the Tab key: in a modal
   * dialog WebKit's Tab focused the `<dialog>` itself, and Backspace there
   * went back (R12-KEY-6).
   * Only here: Escape twice is the reader leaving on purpose, and the page's
   * keys are theirs afterwards.
   */
  #backAfterLetGo = false;

  /**
   * Whether focus is on the page itself -- `<body>`, the root element, or
   * nothing -- in `doc`: the editor's own, or the one around an iframe mount
   * that a `portalContainer` put a panel in.
   */
  #focusOnPage(doc: Document = this.#document): boolean {
    const active = doc.activeElement;

    return active === null || active === doc.body || active === doc.documentElement;
  }

  /**
   * Where focus is while WebKit types into a selection it kept in a block
   * after a click on a button it gave no focus: on the page (`#focusOnPage`),
   * or on the modal `<dialog>` the button is in, which WebKit focuses
   * instead and where Backspace goes back in history too (`isPageTarget`) --
   * in a dialog mount the lock and a peer's update guarded nothing. And,
   * asked when guarding (`windowFocus`), only while the window has focus: a
   * background tab types nowhere.
   */
  #keptFocusOnPage(windowFocus = true): boolean {
    return (
      (this.#focusOnPage() || isPageTarget(this.#document.activeElement)) &&
      (!windowFocus || this.#document.hasFocus())
    );
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

    // Recorded first -- the entry is the document as it stood *before* the edit
    // -- but announced after, once `#applyBlocks` has made the edit true. Doing
    // both in `#recordHistory` emitted `history` while `#blocks` was still the
    // old array, so a listener that read `getDocument()` saw the pre-edit
    // document, and one that wrote through `setDocument()` had its document
    // overwritten by the assignment that followed.
    this.#recordHistory(runKey, selection, { silent: true });
    this.#applyBlocks(blocks);
    this.#emitHistory();
  }

  /**
   * Snapshots the state *before* an edit.
   *
   * `runKey` folds a burst of related edits — a run of typing in one block —
   * into one undo step; null forces the edit to stand alone.
   */
  #recordHistory(
    runKey: string | null = null,
    selection?: SelectionSnapshot | null,
    options: { silent?: boolean } = {},
  ): void {
    this.#history.record(
      {
        blocks: this.#blocks,
        selection: selection ?? this.#selectionSnapshot(),
        ...this.#blockSelectionSnapshot(),
      },
      runKey,
    );
    this.#settleAfterEdit();

    // `silent` is for callers that have not applied their edit yet: announcing
    // here would describe a document that does not exist for another line.
    if (!options.silent) {
      this.#emitHistory();
    }
  }

  #settleQueued = false;

  /**
   * Tells history where the edit just recorded left the reader, so redoing it
   * comes back there.
   *
   * A microtask, because every edit places its caret synchronously *after* the
   * commit that records it -- `#commit` and then `focus`, or the browser's own
   * caret on the typing path -- and the selection to keep is the one in place
   * once that has run. A typing run settles again on every keystroke.
   */
  #settleAfterEdit(): void {
    if (this.#settleQueued) {
      return;
    }

    this.#settleQueued = true;
    queueMicrotask(() => {
      this.#settleQueued = false;

      if (!this.#destroyed) {
        this.#history.settle({
          selection: this.#selectionSnapshot(),
          ...this.#blockSelectionSnapshot(),
        });
      }
    });
  }

  #emitHistory(): void {
    // The getters' answer, not the raw stack depth: a host renders its toolbar
    // from one or the other, and they must not disagree about whether pressing
    // the button would do anything.
    this.#emitter.emit('history', { canUndo: this.canUndo, canRedo: this.canRedo });
  }

  /** The block selection a history entry records, when there is one. */
  #blockSelectionSnapshot(): Pick<HistoryEntry, 'selectedBlocks' | 'selectionAnchor'> {
    if (this.#selected.size === 0) {
      return {};
    }

    return {
      selectedBlocks: this.#orderedSelection(),
      ...(this.#selectionAnchor !== null ? { selectionAnchor: this.#selectionAnchor } : {}),
    };
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
      ...(target.backward ? { backward: true as const } : {}),
    };
  }

  #travel(direction: 'undo' | 'redo'): boolean {
    // `#canEdit()`, not `#editable`: the other half of the question is whether
    // the editor still exists. Asking only the first let `undo()` rewrite the
    // document of a destroyed editor and return true, while `canUndo` -- which
    // does ask both -- said false. Nothing rendered it, so an application
    // holding the reference to serialize later wrote out a document one edit
    // behind the one its user last saw.
    if (!this.#canEdit()) {
      return false;
    }

    const current: HistoryEntry = {
      blocks: this.#blocks,
      selection: this.#selectionSnapshot(),
      ...this.#blockSelectionSnapshot(),
    };

    const entry = direction === 'undo' ? this.#history.undo(current) : this.#history.redo(current);

    if (!entry) {
      return false;
    }

    const previous = this.#blocks;

    // Transient UI describes the pre-undo document; none of it survives.
    this.#pending = null;
    this.#closeSlashMenu();
    this.#linkContext = null;
    this.#linkEditor.close();
    this.#mathContext = null;
    this.#mathEditor.close();
    this.#closeImageEditor();
    this.#toolbar.hide();
    this.#hideTableToolbar();
    this.#clearBlockSelection();

    this.#applyBlocks(entry.blocks);
    // After the blocks are applied, for the reason given in `setDocument`.
    this.#endComposition();

    // Neither mode is not a place to leave the editor: `#handleKeyDown`
    // resolves nothing from a root with no caret and no selection, and drops
    // every later keystroke, the next Ctrl+Z included. So an entry restores
    // the block selection it recorded, else its caret, else the caret goes to
    // where the document changed -- not to its first block, which threw a
    // reader undoing at block 40 back to the top of the page.
    // An edit made on a block selection comes back as that selection, where
    // the blocks now are; only ids the restored document still shows count.
    const visible = new Set(this.#visible().map((block) => block.id));
    const reselect = (entry.selectedBlocks ?? []).filter((id) => visible.has(id));

    if (reselect.length > 0) {
      const anchor =
        entry.selectionAnchor !== undefined && reselect.includes(entry.selectionAnchor)
          ? entry.selectionAnchor
          : reselect[0];
      this.#setBlockSelection(reselect, anchor);
    } else if (
      !this.#restoreSelection(entry.selection) &&
      !this.#focusFirst([entry.selection?.blockId]) &&
      !this.#focusNearChange(previous)
    ) {
      // Nothing that can hold a caret is left to say where the change was.
      this.#letGo();
    }

    this.#emitHistory();
    this.#announce(direction === 'undo' ? this.#labels.undone : this.#labels.redone);

    return true;
  }

  /**
   * Puts the caret where a step through history changed the document, for an
   * entry with no selection of its own to restore.
   *
   * Every edit reuses the blocks it did not touch, so the first position whose
   * block is not the same object as before is where the change begins: the
   * caret goes to the first block from there that can hold one, else back to
   * the nearest before it -- both found by id (`splitAt`). False when none
   * can, and the caller lets go rather than guess.
   */
  #focusNearChange(previous: readonly Block[]): boolean {
    const blocks = this.#blocks;
    const changed = blocks.findIndex((block, position) => block !== previous[position]);
    const index = changed === -1 ? blocks.length : changed;
    const { after, before } = splitAt(blocks, this.#visible(), index);

    return this.#focusFirst(after, 0) || this.#focusFirst(before, CARET_END);
  }

  /* ---------------------------------------------------- block selection -- */

  /** Ids of the blocks selected as units, in document order. */
  getSelectedBlocks(): string[] {
    return this.#orderedSelection();
  }

  /** Selects whole blocks. Pass an empty list to return to text editing. */
  selectBlocks(ids: readonly string[]): void {
    // The guard every other public mutator has. Without it a stale call after
    // `destroy()` still ran `removeAllRanges()` and focused the root -- wiping
    // the caret out of whatever the page had moved on to, from an editor that
    // no longer exists.
    if (this.#destroyed) {
      return;
    }

    this.#setBlockSelection(ids);
  }

  /** Leaves block selection, handing the caret back to the text. */
  clearBlockSelection(): void {
    if (this.#destroyed) {
      return;
    }

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
   *
   * Collapsed in the document or by the reader: a read-only reader who
   * closed a toggle with its chevron hides its children as surely, and
   * expanded by the document alone, that toggle taken in as a block was
   * copied without them (R14-RV7-3). The copy writes the document, so the
   * toggle is written as the document has it, open, with its children; a
   * toggle the reader opened still carries the children the document hides,
   * as it did.
   */
  #selectionForEdit(): Set<string> {
    const edit = withHiddenDescendants(this.#blocks, this.#selected);

    if (this.#readerExpanded.size > 0) {
      for (const id of withHiddenDescendants(this.#shown(), this.#selected)) {
        edit.add(id);
      }
    }

    return edit;
  }

  /**
   * Enters (or updates) block selection.
   *
   * It always takes the caret out of the text: a DOM range left in a host while
   * blocks are selected is a caret the reader can see and keystrokes that go
   * somewhere else. `reveal` is false while a handle drag is in progress, where
   * scrolling to the anchor would move the page under the pointer and change the
   * gap it is aiming at.
   */
  #setBlockSelection(
    ids: readonly string[],
    anchorId?: string,
    options: { reveal?: boolean; show?: string } = {},
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
    this.#typingOver = null;
    this.#toolbar.hide();
    this.#hideTableToolbar();
    this.#closeSlashMenu();

    // Blocks, not characters, are the subject now: drop the caret and let the
    // root take the keystrokes.
    this.#selection()?.removeAllRanges();
    this.#root.focus({ preventScroll: true });
    // The anchor, or the block a caller names instead (`show`: the end a
    // Shift+arrow moves).
    const shown = options.show ?? this.#selectionAnchor;

    if (shown && (options.reveal ?? true)) {
      this.#reveal(this.#renderer.getView(shown)?.root);
    }

    // Document order, as `getSelectedBlocks()` promises: insertion order is
    // whatever order a caller happened to pass to `selectBlocks`.
    this.#emitter.emit('blockselection', { ids: this.#orderedSelection() });
    this.#announceSelectionCount(this.#selected.size);
  }

  /**
   * Announces how many blocks are selected.
   *
   * Zero is its own sentence. Reading it as the plural announced "0 blocks
   * selected", which describes a mode the editor is not supposed to have.
   */
  /** How much of a block's own text is read out when it is selected. */
  static readonly #SELECTION_TEXT_LIMIT = 60;

  #announceSelectionCount(count: number): void {
    // A single block says which one. The count alone read "1 block selected"
    // for every block in the document, so arrowing through block-selection mode
    // repeated one identical sentence and nothing ever identified what
    // Backspace was about to delete. More than one is back to the count: naming
    // them all would be longer than it is useful.
    if (count === 1) {
      const id = this.#orderedSelection()[0];
      const block = id === undefined ? undefined : findBlock(this.#blocks, id);

      if (block) {
        // An image is named by what its alt text says it shows, before its
        // caption: that is the picture's own description.
        // A formula is announced as its TeX, not as an object character -- in
        // a table too, cell by cell: the table's plain text has none.
        const own =
          block.type === 'image' && block.alt?.trim()
            ? block.alt
            : block.type === 'table'
              ? (block.rows ?? []).map((row) => row.map(richToSourceText).join('\t')).join('\n')
              : richToSourceText(block.content);
        const text = own.trim().slice(0, NEditor.#SELECTION_TEXT_LIMIT);
        // A name for the block, not the menu entry: the menu's "Text" read as
        // "Text selected", which sounds like a text selection.
        const type = this.#labels.blockTypeNames[block.type] ?? this.#typeName(block.type);
        // A divider holds nothing but is not empty, and neither is an image
        // with a picture: "Empty Divider selected" described a missing block.
        const empty = block.type !== 'divider' && !(block.type === 'image' && block.src);

        this.#announce(
          text.length > 0
            ? formatLabel(this.#labels.blockSelectedNamed, { type, text })
            : formatLabel(
                empty
                  ? this.#labels.emptyBlockSelectedNamed
                  : this.#labels.textlessBlockSelectedNamed,
                { type },
              ),
        );

        return;
      }
    }

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

  /**
   * Places the caret where a Tab that changed nothing should continue from.
   *
   * Forward, that is the last caret the selection reaches: the end of its last
   * block, a table's last cell, or -- when the selection ends on a divider or
   * other block with no caret -- the nearest block before it that has one, so
   * the browser's Tab moves on to whatever follows. Backward, mirrored: the
   * first caret at or after the selection's start. Focusing the block itself
   * sent a table's Tab to its own next cell and a divider's to the top of the
   * document.
   */
  #focusForTabExit(forward: boolean): boolean {
    const visible = this.#visible();
    const indices = this.#selectedVisibleIndices(visible);
    const edge = forward ? indices.at(-1) : indices[0];

    if (edge === undefined) {
      return false;
    }

    const candidates = forward ? visible.slice(0, edge + 1).reverse() : visible.slice(edge);

    for (const candidate of candidates) {
      const rows = candidate.rows;

      if (isTableType(candidate.type) && rows && rows.length > 0) {
        const row = forward ? rows.length - 1 : 0;
        const column = forward ? (rows[row]?.length ?? 1) - 1 : 0;

        if (this.focusRange(candidate.id, 0, 0, { row, column })) {
          if (forward) {
            this.#focusCell(candidate.id, row, column, CARET_END);
          }

          return true;
        }

        continue;
      }

      if (this.focus(candidate.id, forward ? CARET_END : 0)) {
        return true;
      }
    }

    return false;
  }

  /** Puts the caret in the first of `ids` that can take one. */
  #focusFirst(ids: readonly (string | undefined)[], offset = 0): boolean {
    for (const id of ids) {
      if (id !== undefined && this.#focusAt(id, offset)) {
        return true;
      }
    }

    return false;
  }

  /**
   * `focus(id, offset)`, except that a table's end is the end of its last
   * cell. `focus` resolves a table to its first cell, so "the end of the
   * block before" put the caret after the header's first word, and the next
   * character typed went into it.
   */
  #focusAt(id: string, offset: number): boolean {
    const block = offset === CARET_END ? findBlock(this.#blocks, id) : undefined;
    const rows = block?.rows;

    if (block && isTableType(block.type) && rows && rows.length > 0) {
      const row = rows.length - 1;
      const column = Math.max((rows[row]?.length ?? 1) - 1, 0);

      // `focus` starts a new run of ↑/↓; so does this, through `#placeRange`.
      return this.focusRange(id, CARET_END, CARET_END, { row, column });
    }

    return this.focus(id, offset);
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

    // A pointer's own click reveals nothing: the handle is under the
    // pointer, and bringing a block cut by the window's edge into view
    // moved the page 89px under it -- the next click landed in the block's
    // text (R14-RV1-5). No press scrolls, except to show a caret it placed
    // out of sight. The handle operated by keyboard (`detail` 0) reveals,
    // as every key that selects a block does.
    const reveal = event.detail === 0;

    if (event.shiftKey && this.#selectionAnchor) {
      this.#setBlockSelection(
        blockIdRange(this.#blocks, this.#selectionAnchor, blockId),
        this.#selectionAnchor,
        { reveal },
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

      this.#setBlockSelection([...next], blockId, { reveal });
      return;
    }

    this.#setBlockSelection([blockId], blockId, { reveal });
  }

  #addBlockAfter(blockId: string): void {
    if (!this.#editable) {
      return;
    }

    const source = findBlock(this.#blocks, blockId);
    const created = createBlock('paragraph', [], source?.depth ?? 0);
    // Below the block's whole subtree, as a sibling. Straight after the block
    // put the new paragraph between a parent and its children, which then
    // nested under it -- for a collapsed toggle that meant its hidden children
    // came out from under it and showed beneath an empty line.
    const last = descendantsOf(this.#blocks, blockId).at(-1) ?? blockId;
    // The `+` is pressed with the pointer, which leaves no caret in the text
    // for `#commit` to record -- and an entry with nothing to restore sent the
    // caret, and the page with it, to the top of the document on undo. Undo
    // comes back to the block the `+` was pressed beside.
    const selection = source ? this.#snapshotAt(source) : null;

    this.#clearBlockSelection();
    this.#commit(insertBlockAfter(this.#blocks, last, created), null, selection);
    this.focus(created.id, 0);
  }

  /**
   * The selection to record for an edit made on `block` with the pointer: the
   * live one if it is in that block, else a caret at the end of its text. A
   * caret left behind in some other block -- where the reader typed before
   * scrolling down to press a control -- is not where the edit happened.
   */
  #snapshotAt(block: Block): SelectionSnapshot {
    const live = this.#selectionSnapshot();
    const length = richLength(block.content);

    return live?.blockId === block.id ? live : { blockId: block.id, start: length, end: length };
  }

  #deleteSelectedBlocks(options: { cut?: boolean } = {}): void {
    const ordered = this.#orderedSelection();
    const firstId = ordered[0];

    if (!firstId) {
      return;
    }

    const index = findBlockIndex(this.#blocks, firstId);
    const next = keepVisible(this.#blocks, removeBlocks(this.#blocks, this.#selectionForEdit()));

    this.#commit(next);
    this.#clearBlockSelection();
    // Announced last, once the caret or the fallback selection is settled:
    // selecting a neighbour announces its own count, which replaced "Block
    // deleted" in the live region before it was ever spoken.
    // A cut says so: "deleted" told the reader the blocks were gone, not that
    // they were on the clipboard waiting to be pasted.
    const deleted =
      ordered.length === 1
        ? options.cut
          ? this.#labels.blockCut
          : this.#labels.blockDeleted
        : formatLabel(options.cut ? this.#labels.blocksCut : this.#labels.blocksDeleted, {
            count: ordered.length,
          });

    // The caret lands on whatever moved up into the gap -- or the nearest block
    // on either side that can hold one. Blindly focusing the block in the gap
    // failed on a divider or a hidden child and left the editor in neither
    // mode, where even Cmd+Z fell on the floor straight after a delete.
    // Neighbours are taken in visible space, which is where a caret can go,
    // and found by id in the array this edit committed: a host that answers
    // `change` with a renamed document (a Markdown echo) leaves none of them,
    // and then nothing names where the reader was (`#letGo`).
    const { after, before } = splitAt(next, this.#visible(), index);
    const landed = this.#focusFirst(after, 0) || this.#focusFirst(before, CARET_END);

    // Nothing left can hold a caret: stay in block mode on the nearest block.
    const neighbour = after[0] ?? before[0];

    if (!landed && neighbour) {
      this.#setBlockSelection([neighbour], neighbour);
      // One sentence for both: the live region keeps only the last write, and
      // either message alone left out something the next keystroke acts on.
      this.#announce(joinSentences(deleted, this.#liveRegion.textContent ?? ''));
      return;
    }

    if (!landed) {
      this.#letGo();
    }

    this.#announce(deleted);
  }

  #duplicateSelectedBlocks(): void {
    const edit = this.#selectionForEdit();
    const result = duplicateBlocks(this.#blocks, edit);

    if (result.ids.length === 0) {
      return;
    }

    // The copies go after the last selected block, in document order. With a
    // gap in the selection, a copied collapsed toggle lands in front of the
    // last block's later siblings, which fold into it -- and in front of the
    // copies that follow it, which are what the user asked to see. The copy of
    // every block the reader selected must be on screen.
    const sources = this.#blocks.filter((block) => edit.has(block.id));
    const shown = result.ids.filter((_, index) => this.#selected.has(sources[index]?.id ?? ''));

    this.#commit(keepVisible(this.#blocks, result.blocks, shown));
    // What the commit did, counted from the commit: the copies of the blocks
    // the reader selected. Counted from the selection that followed, a host
    // that renamed every block on `change` made it "0 blocks duplicated".
    const count = shown.length;
    const duplicated =
      count === 1
        ? this.#labels.blockDuplicated
        : formatLabel(this.#labels.blocksDuplicated, { count });
    const present = new Set(this.#visible().map((block) => block.id));

    // The copies are selected by their ids, or not at all: renamed under the
    // edit, nothing says which blocks they now are (`#letGo`).
    if (!shown.some((id) => present.has(id))) {
      this.#clearBlockSelection();
      this.#letGo();
      this.#announce(joinSentences(duplicated, this.#labels.noBlocksSelected));
      return;
    }

    this.#setBlockSelection(result.ids);
    // After the selection, which announces the copies' count: the live region
    // keeps only the last write, and on its own that never said a copy was
    // made. One sentence for both, as a delete that selects a neighbour does.
    this.#announce(joinSentences(duplicated, this.#liveRegion.textContent ?? ''));
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

    // A delete like any other: what followed the removed blocks can now follow
    // a collapsed toggle's subtree instead.
    const next = keepVisible(this.#blocks, normalizeDepths(insertBlockAt(kept, index, created)));
    this.#commit(next);
    this.#clearBlockSelection();

    if (this.focus(created.id, CARET_END)) {
      return;
    }

    // The document was replaced under the edit: a host that writes every
    // `change` out as Markdown and loads it straight back renames every
    // block, and the caret aimed at the new paragraph's id goes nowhere. The
    // character is in the document; nothing says which block now holds it,
    // so the root lets go of focus (`#letGo`) and the next key lands nowhere,
    // as after every other block-mode edit under such a host. Every search
    // tried took something: by position, the old index named the block after
    // the twins ("Delta"), and the next key went into it; by content, a
    // one-character paragraph has twins, and with more blank lines dropped
    // above than the search window held, an old "q" 49 blocks down took it.
    this.#letGo();
  }

  #moveSelectedBlocks(direction: 1 | -1): void {
    const before = this.#blocks;
    this.#moveVisible(this.#selected, direction);

    // Only a move that happened: against the edge of the document `#commit`
    // keeps the array it had, and nothing moved to be announced.
    if (this.#blocks !== before) {
      this.#announce(direction === -1 ? this.#labels.blocksMovedUp : this.#labels.blocksMovedDown);
    }
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
    // A move takes a block out of its slot just as a delete does, so its
    // children can land after a collapsed toggle's subtree: `keepVisible`.
    this.#commit(keepVisible(this.#blocks, moveVisibleBlocks(this.#blocks, ids, direction)));
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
    } else if (direction === 1 && this.#canEdit() && this.#endsOnTrailingVoid()) {
      // ↓ off a divider that ends the document: as from text, a paragraph
      // opens below it, since nothing else there can take the caret.
      this.#openTrailingParagraph();
    }
  }

  /** The selection's last block is a divider (or other caretless block) ending the document. */
  #endsOnTrailingVoid(): boolean {
    const last = this.#visible().at(-1);

    return last !== undefined && this.#selected.has(last.id) && isVoidType(last.type);
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

    // The end that moved is the one brought into view: revealed by its
    // anchor, six Shift+↓ from the window's last block selected p31-p36
    // out of sight and the page did not move (R14-RV2-B1).
    if (anchorId && target) {
      this.#setBlockSelection(blockIdRange(this.#blocks, anchorId, target.id), anchorId, {
        show: target.id,
      });
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

  /**
   * The Backspace or Delete whose press stepped up from text to a block it
   * would not destroy, so that its auto-repeat can be told from a new press.
   */
  #selectedByKey: string | null = null;

  #handleBlockSelectionKeys(event: KeyboardEvent): void {
    const modifier = this.#shortcutModifier(event);
    const ordered = this.#orderedSelection();

    if (event.key === 'Escape') {
      event.preventDefault();

      // Escape from text selects the block; a second Escape leaves the editor.
      // That pair is the documented way out for a keyboard user, alongside
      // Shift+Tab at depth 0.
      this.#clearBlockSelection();
      // Whatever inside the editor holds focus -- normally the root, but a
      // control such as the drag handle can too, and blurring only the root
      // left focus where it was with no mode at all.
      const active = this.#activeElement();
      (active && this.#root.contains(active) ? (active as HTMLElement) : this.#root).blur?.();
      this.#announce(this.#labels.leftEditor);
      // Blurring releases focus but does not move the browser's sequential
      // focus starting point out of the editor, so the next Tab went straight
      // back in. The next Tab is taken past it instead (#handleExitKeyDown).
      this.#exitArmed = true;
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

        // Nothing selected could take the caret. When that is a divider at
        // the very end there is no text below it to go to either, so Enter
        // opens it -- the keyboard's only way past a trailing divider.
        if (this.#selected.size > 0 && this.#endsOnTrailingVoid()) {
          this.#openTrailingParagraph();
        }

        return;

      case 'Backspace':
      case 'Delete':
        event.preventDefault();

        // The key that selected this block is still held down. Selecting a
        // table or an image instead of deleting it is only a safeguard if
        // the deletion has to be asked for; auto-repeat asked for it a few
        // milliseconds later, and then went on into the text above.
        if (event.repeat && this.#selectedByKey === event.key) {
          return;
        }

        this.#selectedByKey = null;
        this.#deleteSelectedBlocks();
        return;

      case 'Tab': {
        // `#selectionForEdit()`'s expansion, applied per anchor: a selected
        // block the indent cannot move keeps its hidden children with it.
        const delta = event.shiftKey ? -1 : 1;
        const indented = indentBlocks(
          this.#blocks,
          indentTargets(this.#blocks, this.#selected, delta),
          delta,
        );

        // Same escape as in text mode: a Tab that changes nothing moves focus,
        // and from the same place it would from text. The caret goes back into
        // the last selected block (the first, for Shift+Tab) before the browser
        // takes the key, so it moves on to the next or previous stop from
        // there. Left on the root, the selection outlived the focus move -- the
        // next character replaced the selected text -- and the browser's Tab
        // went from the root: to the first block of the document, or out of
        // the editor altogether.
        if (indented.every((next, index) => next.depth === this.#blocks[index]?.depth)) {
          if (!this.#focusForTabExit(!event.shiftKey)) {
            this.#clearBlockSelection();
          }

          return;
        }

        event.preventDefault();
        // Indenting a block after a collapsed toggle makes it the toggle's
        // child; outdenting one hands its next sibling to whatever now
        // precedes it. Either way a block the reader could see would vanish.
        this.#commit(keepVisible(this.#blocks, indented));
        // Nothing on screen but the indent itself says it happened, and focus
        // stays on the root, so nothing else is read out.
        this.#announce(delta === 1 ? this.#labels.blocksIndented : this.#labels.blocksOutdented);
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
    this.#syncPortalDirection();
    this.#imageEditor.open(
      anchor.getBoundingClientRect(),
      { src: block.src ?? '', alt: block.alt ?? '' },
      pinAnchor(anchor),
    );
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

  /**
   * The cell the table toolbar acts on. `selection` is what F10 left in it,
   * for Escape to hand back; only F10 records one, since only F10 moves focus
   * out of the cell with the toolbar still to come back from.
   */
  #activeCell: {
    blockId: string;
    row: number;
    column: number;
    /** `upper`: a caret F10 found drawn at the end of a wrapped line. */
    selection?: { start: number; end: number; backward: boolean; upper?: boolean };
  } | null = null;

  /**
   * Whether the table toolbar is hidden only because the caret's cell has
   * scrolled out of sight, so that a scroll bringing the cell back draws it
   * again (`#handleViewportChange`). A scroll fires no `selectionchange`, and
   * nothing else would have asked.
   */
  #tableToolbarScrolledAway = false;

  /**
   * The room the table toolbar takes over its anchor -- its height, as last
   * measured to place it, and the gap -- in this frame's pixels: the room a
   * line break in a tall cell leaves over the caret's line for it
   * (`#placeAfterBreak`), whether or not it is drawn at that moment. A
   * toolbar drawn in the page around the frame is measured in that page's
   * pixels, so it is carried in at the scale the frame is drawn at
   * (`#drawArea`).
   */
  #tableToolbarRoom = 0;

  /** Shows the row and column controls whenever the caret is inside a table. */
  #syncTableToolbar(): void {
    // Someone is operating the toolbar: leave it, and the cell it acts on,
    // alone. WebKit clears the document selection when focus moves to one of
    // its buttons, so the check below found no caret in a cell and hid the
    // toolbar under the focus F10 had just given it (the e2e finding F13).
    const toolbar = this.#tableToolbar.element;
    const root = toolbar.getRootNode() as Document | ShadowRoot;

    if (this.#activeCell && this.#tableToolbar.isOpen && toolbar.contains(root.activeElement)) {
      // The cell stays, but the ground can move under it: a scroll while the
      // toolbar held focus left it behind, drawn over the rows. Re-placed
      // against the same cell, measured afresh -- even once the cell has left
      // the screen, where the clamp holds it at the edge: it holds focus, and
      // hiding it would drop that focus on the page, as a scroll must not
      // (the dialogs follow their anchor for the same reason).
      const { blockId, row, column } = this.#activeCell;
      this.#placeTableToolbar(blockId, this.#hostFor(blockId, { row, column }));
      return;
    }

    const target = this.#selectionTarget();

    // Only while the cell holds focus. Firefox and WebKit leave the caret in
    // the cell when focus goes to a field on the page, and Firefox goes on
    // firing `selectionchange` for that field, which drew the toolbar straight
    // back over a table the reader had left.
    if (
      !target?.cell ||
      !this.#editable ||
      this.#selected.size > 0 ||
      this.#toolbar.isOpen ||
      this.#imageEditor.isOpen ||
      (target.content.getRootNode() as Document | ShadowRoot).activeElement !== target.content
    ) {
      this.#hideTableToolbar();
      return;
    }

    const view = this.#renderer.getView(target.block.id);

    if (!view) {
      this.#tableToolbar.hide();
      this.#tableToolbarScrolledAway = false;
      return;
    }

    // A cell scrolled out of sight takes the toolbar with it, as the format
    // toolbar and the slash menu go with their caret: clamped to the edge of
    // the window, it was drawn over whatever had scrolled there -- the host
    // page above an inner scroller included -- acting on rows no one could
    // see. It comes back with the cell (`#handleViewportChange`). A box with
    // no size is no layout at all (happy-dom), not a cell out of sight: a
    // laid-out cell is at least a line tall.
    const box = target.content.getBoundingClientRect();

    if ((box.width > 0 || box.height > 0) && !this.#onScreen(target.content)) {
      this.#hideTableToolbar();
      this.#tableToolbarScrolledAway = true;
      return;
    }

    this.#tableToolbarScrolledAway = false;
    this.#activeCell = { blockId: target.block.id, ...target.cell };
    this.#syncPortalDirection();
    this.#tableToolbar.show((height) =>
      this.#tableToolbarAnchor(view.root, target.content, height),
    );
  }

  /** Draws the table toolbar against `cell` of table `blockId`; false when either is gone. */
  #placeTableToolbar(blockId: string, cell: HTMLElement | null): boolean {
    const view = this.#renderer.getView(blockId);

    if (!view || !cell) {
      return false;
    }

    this.#tableToolbar.show((height) => this.#tableToolbarAnchor(view.root, cell, height));
    return true;
  }

  /**
   * What the table toolbar is placed against: the table, while all of it is
   * on screen with room for the toolbar above or below it, and otherwise the
   * row the caret is in -- or, in a row taller than what is shown, the
   * selection itself while that is on screen (`#anchorBoxIn`: the caret's
   * line, an empty one included, or a range, by its focus end when it is
   * taller than what is shown too).
   *
   * Anchored to a table taller than the screen, the toolbar had nowhere to go
   * above or below it, so the viewport clamp left it far from the caret and
   * over whatever cells were there -- the caret's own included. A table that
   * only just fits is the same case: with no room on either side the clamp
   * pulled the toolbar back over the last rows, and a caret in the last row
   * was covered. The row keeps it beside the cell being edited and never on
   * top of it. `height` is the toolbar's own, measured, and the room asked
   * for is what `positionPortal` asks to place it on a side: the toolbar and
   * its gap (within its margin of the viewport's edge it is clamped, by no
   * more than the gap, so it touches the table at worst). Asked with the
   * margin as well, a table with 8px less room than that took the row as
   * its anchor, and the toolbar went over the rows above the caret's.
   *
   * "On screen" is the part of the window every scroller that clips the
   * editor leaves visible, cut in an iframe mount by the pages around the
   * frame too (`#visibleBand`; a pane behind a fixed sheet or a modal dialog
   * does not clip it). The room above and below is measured where the
   * toolbar can be drawn instead, which no scroller around the editor clips:
   * measured inside one, a table filling a fixed-height pane had none, and
   * the row's toolbar was drawn over the table's own rows rather than above
   * the pane over the page. A table scrolled half
   * out of a fixed-height root is inside the window still, and anchored to
   * its hidden top the toolbar was drawn over the host page above the
   * scroller, far from the caret. Measured in the frame's own window, a row
   * in a content-sized iframe taller than the page's window fitted in it,
   * and the toolbar was drawn beside the row, below the page's window. A
   * toolbar drawn in the page around the frame (`portalContainer`) has that
   * page's window, and a pane there it is drawn over does not clip it
   * (`#drawArea`): measured by the pane, a table filling it had no room, and
   * the row's toolbar covered the rows above the caret's.
   */
  #tableToolbarAnchor(table: HTMLElement, cell: HTMLElement, height: number): AnchorRect {
    const box = table.getBoundingClientRect();
    // Where the toolbar can be drawn (`#drawArea`): the room `positionPortal`
    // itself measures, in this frame's pixels -- as is what the toolbar
    // needs of it, its height and gap in the pixels of the page it is drawn
    // in carried in at the scale the frame is drawn at there. Compared
    // unscaled, a frame at `scale(0.5)` read 43px of the page's for 86 and
    // anchored a 44px toolbar to a table it had no room beside: the clamp drew
    // it over the caret's row. Exactly what `positionPortal`'s own test asks
    // (the toolbar and the gap, no margin), so the anchor chosen here is one
    // it places on the side asked for.
    const {
      top: drawTop,
      bottom: drawBottom,
      scale,
    } = this.#drawArea(this.#tableToolbar.element.ownerDocument);
    const needed = (height + PORTAL_GAP_PX) / scale;
    this.#tableToolbarRoom = needed;
    // What is shown: that, cut by every scroller that clips the editor.
    const band = this.#visibleBand();
    const shownTop = Math.max(band.top, drawTop);
    const shownBottom = Math.min(band.bottom, drawBottom);
    const row = cell.closest('tr')?.getBoundingClientRect();
    const room = box.top - drawTop >= needed || drawBottom - box.bottom >= needed;

    if (!row || (box.top >= shownTop && box.bottom <= shownBottom && room)) {
      return box;
    }

    // A row taller than what is shown has no room above or below it either,
    // and the clamp drew the toolbar over the caret's line: there the caret,
    // while it is on screen, is the row's stand-in.
    const caret =
      row.height > shownBottom - shownTop ? this.#anchorBoxIn(cell, shownBottom - shownTop) : null;

    if (caret && caret.bottom > shownTop && caret.top < shownBottom) {
      return { top: caret.top, bottom: caret.bottom, left: box.left, right: box.right };
    }

    return { top: row.top, bottom: row.bottom, left: box.left, right: box.right };
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

    // The toolbar's left and right are what the reader sees. Columns run right
    // to left in an RTL table, so the visual left of a cell is the logical
    // index after it: inserting at the logical index put "left" on the right.
    const logical =
      this.#direction() === 'rtl' &&
      (command === 'insertColumnLeft' || command === 'insertColumnRight')
        ? command === 'insertColumnLeft'
          ? 'insertColumnRight'
          : 'insertColumnLeft'
        : command;
    const next = applyTableCommand(rows, logical, active.row, active.column);

    // An insert refused at its cap comes back with the grid untouched. Commit
    // that and the button banks an undo entry for a document that never
    // changed, while the live region tells a screen-reader user a row is there
    // that is not. The caret still goes home, so the toolbar keeps its promise
    // to hand editing back to the cell it was invoked from.
    if (!sameRows(rows, next)) {
      this.#commit(updateBlock(this.#blocks, block.id, { rows: next }));
      this.#announce(this.#labels[TABLE_COMMAND_ANNOUNCEMENTS[command]]);
    }

    // An insert lands *at* the active index for the "above" and "left"
    // commands, which pushes the user's own cell one along -- so reusing the
    // pre-edit indices put the caret in the new blank cell instead of the one
    // they were editing. The other four commands do not move it. The grid may
    // also have shrunk under the caret, so clamp after shifting.
    const shift = logical === 'insertRowAbove' || logical === 'insertColumnLeft' ? 1 : 0;
    const size = tableSize(next);
    const row = Math.min(
      logical === 'insertRowAbove' ? active.row + shift : active.row,
      size.rows - 1,
    );
    const column = Math.min(
      logical === 'insertColumnLeft' ? active.column + shift : active.column,
      size.columns - 1,
    );
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
      case 'F10': {
        // Only F10 itself. Shift+F10 is the keyboard's context menu, and the
        // others are the platform's or the page's: taking them all focused
        // the toolbar and swallowed the key.
        if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
          return false;
        }

        // Taken from the event, not from #activeCell: that is set by the
        // selection sync, which has not necessarily run for a cell the user
        // reached with the keyboard alone. And the toolbar is drawn for this
        // cell here, not left to that sync: a range in the cell -- Shift+arrow,
        // or the whole cell Tab selects -- draws the format toolbar, which
        // keeps the table toolbar hidden, and WebKit runs the sync for a Tab's
        // focus before the caret has moved into the new cell. Either way F10
        // focused a hidden button, and the key was swallowed with focus left
        // in the cell.
        const view = this.#renderer.getView(target.block.id);

        if (!view || !this.#editable) {
          return true;
        }

        this.#toolbar.hide();
        // What F10 leaves, for Escape to restore: a caret at 3, a range 6-11,
        // a backward one -- not the cell's end.
        const ends = getSelectionEnds(target.content);
        this.#activeCell = {
          blockId: target.block.id,
          row: cell.row,
          column: cell.column,
          selection: ends
            ? {
                start: Math.min(ends.anchor, ends.focus),
                end: Math.max(ends.anchor, ends.focus),
                backward: ends.focus < ends.anchor,
              }
            : undefined,
        };
        // The cell first: one already scrolled out of sight drew the toolbar
        // at the window's clamp and moved focus into it there -- over the
        // page above an inner scroller, outside a dialog around the editor --
        // acting on rows no one could see. Brought back to the middle of what
        // scrolls it, not to its nearest edge: there the toolbar, drawn
        // beside the row, still sat over the page outside the scroller. So is
        // a cell with only a sliver on screen -- anything short of the whole
        // cell -- or its toolbar was drawn outside the scroller or the dialog
        // around it. The scroll is followed like any other
        // (`#handleViewportChange`).
        //
        // A cell taller than what it is seen in is never wholly on screen, and
        // centring its middle scrolled the caret away on every F10: there the
        // selection is judged instead (`#tallSelectionView`).
        const side = this.#showSelectionOrHost(target.content, () => {
          if (this.#whollyOnScreen(target.content)) {
            this.#reveal(target.content);
          } else {
            this.#centreInScroller(target.content);
          }
        });

        // Escape puts the caret back on the line it was drawn on: set by
        // offset, it is drawn at the start of the lower one, and judged
        // there the Escape back scrolled a caret on the window's last line
        // 400px.
        if (side === 'upper' && this.#activeCell.selection) {
          this.#activeCell.selection.upper = true;
        }
        this.#syncPortalDirection();
        this.#tableToolbar.show((height) =>
          this.#tableToolbarAnchor(view.root, target.content, height),
        );
        this.#tableToolbar.focusFirst();

        const toolbar = this.#tableToolbar.element;

        // Only a key that moved focus is taken.
        if (toolbar.contains((toolbar.getRootNode() as Document | ShadowRoot).activeElement)) {
          event.preventDefault();
        } else {
          this.#syncToolbar();
        }

        return true;
      }

      case 'Tab': {
        const next = tableStep(rows, cell.row, cell.column, event.shiftKey ? -1 : 1);

        if (next) {
          event.preventDefault();
          this.#focusCell(target.block.id, next.row, next.column, 0, CARET_END);
          return true;
        }

        // Shift+Tab out of the first cell releases focus rather than trapping
        // it; Tab past the last cell grows the table, as a spreadsheet does --
        // unless the last row is still empty, when it releases focus too.
        //
        // Released by handling the key and declining to act on it, NOT by
        // returning false: false falls through to the block-level Tab handler,
        // which indents the block the caret is in — so releasing this way
        // silently indented the whole table and threw the caret to cell 0:0,
        // which for a 1000-row grid is 999 rows from where the user was.
        if (event.shiftKey) {
          return true;
        }

        // A last row with nothing in it is the row a previous Tab just added,
        // or one waiting to be filled: another would only stack empty rows
        // under it, and swallowing every Tab made the last cell a stop focus
        // could never leave by Tab. So the key moves focus onward, as any Tab
        // that would change nothing does.
        if ((rows.at(-1) ?? []).every((value) => isRichEmpty(value))) {
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
        this.#placeAfterBreak(target.block.id, range.start + 1, target.cell);
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

      // ↑/↓ are not handled here: rows are stepped by the same code that steps
      // blocks (`#moveCaretVertically`), and with Shift or Mod held the keys
      // mean what they mean in any block -- extend into block selection, move
      // the table. Taking them here first jumped rows for both.
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
    this.#syncPortalDirection();
    this.#iconPicker.open(
      anchor.getBoundingClientRect(),
      block.icon ?? DEFAULT_CALLOUT_ICON,
      pinAnchor(anchor),
    );
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
    if (!event.clipboardData) {
      return;
    }

    if (this.#selected.size === 0) {
      this.#copyTextRange(event, event.clipboardData);
      return;
    }

    event.preventDefault();

    const doc = sliceDocument(this.#blocks, this.#selectionForEdit());
    event.clipboardData.setData('text/plain', toMarkdown(doc));
    event.clipboardData.setData('text/html', blocksToHtml(this.#document, doc.blocks));
    // A type of our own, alongside rather than inside the payload: it marks the
    // clipboard as ours without changing a byte of what any other application
    // receives. `text/plain` beside our HTML is `toMarkdown` output, which is
    // not the literal characters -- a code block's fence lines and a
    // paragraph's escapes are in it -- and a paste into a code block has to
    // know which of the two it is holding.
    event.clipboardData.setData(OWN_CLIPBOARD_TYPE, '1');

    if (event.type === 'cut' && this.#editable) {
      this.#deleteSelectedBlocks({ cut: true });
    }
  };

  /**
   * Copy and cut of a text range inside one editing host.
   *
   * Left to the browser, the copy serialised the *rendered* DOM with the
   * editor's computed styles inlined, and the reader then believed them: a
   * link's underline came back as an `underline` mark, a checked to-do's
   * line-through as `strikethrough` (visible only once it was unchecked), and
   * Firefox wrote a soft break and a double space as single spaces. A formula
   * on screen is the renderer's picture: KaTeX's spans as HTML, and its glyphs
   * twice over as plain text (`x^2` copied as `x2x2`). The model holds what
   * was selected, so the clipboard is written from the model: `text/plain` is
   * the literal characters, each formula as its TeX between dollars -- the
   * user selected text, not a document, so this is not `toMarkdown` -- the
   * HTML is the runs as the renderer draws them, a formula in the spelling
   * that carries its TeX, and our own type carries the runs themselves, which
   * a paste into any neditor merges inline at the caret without the HTML
   * being read at all (see `#ownFragment`).
   *
   * A range across hosts is not this case: no gesture makes one (see the
   * block-selection promotion), so it is left to the browser as before.
   */
  #copyTextRange(event: ClipboardEvent, data: DataTransfer): void {
    const target = this.#selectionTarget();

    if (!target || target.range.start === target.range.end) {
      return;
    }

    event.preventDefault();

    const { start, end } = target.range;
    const runs = richSlice(this.#contentOf(target), start, end);

    data.setData('text/plain', richToSourceText(runs));
    data.setData(
      'text/html',
      richTextToHtml(this.#document, runs, { code: target.block.type === 'code' }),
    );
    data.setData(
      OWN_CLIPBOARD_TYPE,
      JSON.stringify({ blocks: [{ type: 'paragraph', depth: 0, content: runs }] }),
    );

    if (event.type === 'cut' && this.#canEdit()) {
      this.#commitResolved(target, richDelete(this.#contentOf(target), start, end));
      this.#focusResolved(target, start);
    }
  }

  /**
   * A clipboard event in block mode that never reached the root.
   *
   * Block mode focuses the root, which is not editable, and Firefox dispatches
   * clipboard events at <body> when the focused element is not editable -- so
   * the root's own listeners never ran, and copy, cut and paste over selected
   * blocks silently did nothing there (the e2e finding F8). Handled only while
   * this editor's root holds focus with blocks selected, and only when the
   * event did not pass through the root, whose listeners have it otherwise.
   */
  #handleDocumentClipboard = (event: ClipboardEvent): void => {
    if (
      this.#selected.size === 0 ||
      this.#activeElement() !== this.#root ||
      composedTargets(event).includes(this.#root)
    ) {
      return;
    }

    if (event.type === 'paste') {
      this.#handlePaste(event);
    } else {
      this.#handleCopy(event);
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

  /**
   * Points the gutter at a block, aligned to that block's indentation; true
   * when that drew the controls somewhere they were not (`Gutter.showFor`).
   */
  #positionGutter(id: string): boolean {
    const view = this.#renderer.getView(id);

    if (!view) {
      this.#gutter.hide();
      return false;
    }

    // Margin *and* padding. The block reserves the gutter with its padding and
    // carries its nesting depth in its margin -- they were one summed `calc`
    // until that broke on a unitless gutter width -- and the gutter is
    // positioned against the editor root, so where the text begins is the sum
    // of both. Reading only the padding left the controls at the left edge for
    // every nested block. Logical properties in both cases, so this stays
    // correct in both writing directions without mirroring here.
    const win = this.#document.defaultView;
    const style = win?.getComputedStyle(view.root);
    // The inset is measured from the root's padding edge, so the root's own
    // padding is part of where the text begins: a mount with padding (the
    // demo's is 20px) put the handle that far short of the text.
    const rootPadding = Number.parseFloat(
      win?.getComputedStyle(this.#root).paddingInlineStart ?? '0',
    );
    const indent =
      (Number.isFinite(rootPadding) ? rootPadding : 0) +
      Number.parseFloat(style?.paddingInlineStart ?? '0') +
      Number.parseFloat(style?.marginInlineStart ?? '0');

    return this.#gutter.showFor(id, view.root.offsetTop, Number.isFinite(indent) ? indent : 0);
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
      const text = this.#textDrag;

      // A press the editor placed is a click until it travels; see `still`.
      if (text?.still && event.pointerId === text.pointerId) {
        if (
          Math.hypot(event.clientX - text.startX, event.clientY - text.startY) < DRAG_THRESHOLD_PX
        ) {
          return;
        }

        text.still = false;
      }

      // Before this move's default action, the selection is still the one
      // the multi-click press made.
      if (text && event.pointerId === text.pointerId) {
        this.#noteDragAnchor(text);
        this.#noteDragUnit(text);
      }

      this.#updateTextDrag(event);

      // Kept up once the drag is back in its own block as text, too: the
      // browser has no drag selection of its own there to autoscroll for, and
      // stopping put an end to the scroll that was bringing the anchor's
      // neighbours back -- held at the top edge, the page stuck with them
      // off-screen. A press the editor placed never had one at all.
      if (
        text &&
        this.#textDrag === text &&
        event.pointerId === text.pointerId &&
        (text.promoted || text.returned || text.placed)
      ) {
        this.#followPointer(event, text.startY);
      }

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
      // Taking focus, not only selecting: a drag that started from the block
      // holding the caret otherwise left that caret live in the moved block,
      // and the next keystroke replaced the whole block.
      this.#setBlockSelection([...drag.ids], [...drag.ids][0], { reveal: false });
    }

    this.#aimDrag(event.clientY);
    this.#followPointer(event);
  };

  /** Points a handle drag's drop indicator at the gap nearest a viewport Y. */
  #aimDrag(clientY: number): void {
    const drag = this.#drag;

    if (!drag?.active) {
      return;
    }

    const gap = this.#dropGapFor(clientY);

    if (gap !== drag.gap) {
      drag.gap = gap;
      this.#showDropIndicator(gap);
    }
  }

  /**
   * Keeps a drag's pointer on record, and scrolls while it rests at an edge.
   *
   * Driven by animation frames rather than by moves, because the case that
   * needs it is the one that sends none: a pointer held still at the bottom of
   * the screen. Each step re-aims the drag, since the blocks moved under it.
   */
  #followPointer(
    event: Pick<PointerEvent, 'pointerId' | 'clientX' | 'clientY'>,
    pressY: number | null = null,
  ): void {
    const state = this.#autoScroll ?? {
      pointerId: event.pointerId,
      x: 0,
      y: 0,
      pressY,
      frame: null,
    };

    state.x = event.clientX;
    state.y = event.clientY;
    this.#autoScroll = state;

    // The press's own spot in a band stops counting once the pointer has been
    // anywhere nothing would scroll for.
    if (state.pressY !== null && !this.#autoScrollTarget(state.y)) {
      state.pressY = null;
    }

    if (state.frame === null && this.#autoScrollTarget(state.y, state.pressY)) {
      state.frame = this.#document.defaultView?.requestAnimationFrame(this.#runAutoScroll) ?? null;
    }
  }

  #runAutoScroll = (): void => {
    const state = this.#autoScroll;

    if (!state) {
      return;
    }

    state.frame = null;

    // A drag the editor draws whose pointer finds no caret -- something of
    // the page's own is over the text there, a fixed header at the very
    // edge the drag is held at -- does not scroll: the range stands as it
    // was drawn (`#returnTextDrag`), and scrolled on, the page left it
    // behind, 900 to 1,800px in 700 ms (R14-RV1-3). The next move that
    // finds one starts it again (`#followPointer`).
    const text = this.#textDrag;

    if (text && !text.promoted && text.missed) {
      return;
    }

    const step = this.#destroyed ? null : this.#autoScrollTarget(state.y, state.pressY);

    if (!step) {
      return;
    }

    const before = step.scroller.scrollTop;
    const origin = this.#outerMapping();

    step.scroller.scrollTop = before + step.delta;

    if (step.scroller.scrollTop === before) {
      return;
    }

    // Scrolling a page around the frame moves the frame under a pointer that
    // has not moved, so where it is in this frame's coordinates has -- by
    // the distance the frame moved, at the scale it is drawn at.
    const now = this.#outerMapping();

    state.y += (origin.offset - now.offset) / now.scale;

    if (this.#drag?.active) {
      this.#aimDrag(state.y);
    } else {
      this.#updateTextDrag({ pointerId: state.pointerId, clientX: state.x, clientY: state.y });
    }

    state.frame = this.#document.defaultView?.requestAnimationFrame(this.#runAutoScroll) ?? null;
  };

  #stopAutoScroll(): void {
    if (this.#autoScroll?.frame != null) {
      this.#document.defaultView?.cancelAnimationFrame(this.#autoScroll.frame);
    }

    this.#autoScroll = null;
  }

  /**
   * Every element that scrolls the editor and clips it, nearest first: each
   * ancestor in the flat tree -- the root included, across a shadow boundary
   * and through a slot -- that scrolls vertically and has something to
   * scroll, past a scroller that is not a positioned panel's containing
   * block, up to the first one
   * drawn against the window, outside its own ancestors' clip
   * (`clipChainOf`). The page's own scroller is not in it. A drag's auto-scroll asks what can
   * move the editor instead, and takes every scroller (`#scrollTargets`).
   */
  #clipChain(): HTMLElement[] {
    return clipChainOf(this.#root).scrollers;
  }

  /**
   * The part of the window the editor can be seen in: the window, cut by
   * `#clipChain` -- and, in an iframe mount, by the window of every
   * same-origin page around the frame and every scroller there that clips
   * the frame (`clipChainOf`: a frame in a scrolling pane of the page --
   * a docs preview, a Storybook canvas -- is seen only where the pane
   * shows it), carried into this frame's
   * coordinates through each frame's offset and the scale it is drawn at
   * (`frameMapping`: cut in the outer page's pixels unscaled, a frame at
   * `scale(0.5)` read a cell in the middle of the window as off screen and
   * drew it no toolbar); a frame that cannot be read exactly does not cut it,
   * nor any page beyond it. A frame's own window reaches past the page
   * around it wherever the page has scrolled the frame partly away, and a
   * caret above the page's window read as wholly on screen: F10 in a tall
   * cell moved nothing and focused a toolbar no one could see.
   */
  #visibleBand(): { top: number; bottom: number } {
    const frames = this.#frameBand();
    let top = Math.max(0, frames?.top ?? 0);
    let bottom = Math.min(this.#document.defaultView?.innerHeight ?? 0, frames?.bottom ?? Infinity);

    // Inside each scroller's border, as it is drawn (`drawnClientBox`): cut
    // by the border box, a word scrolled under a pane's border, wholly out
    // of sight, kept its format toolbar drawn beside nothing.
    for (const scroller of this.#clipChain()) {
      const clip = drawnClientBox(scroller);

      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
    }

    return { top, bottom };
  }

  /**
   * What the pages around an iframe mount leave of this frame's window, in
   * its coordinates: the window of every same-origin page around the frame,
   * cut by every scroller there that clips the frame (`clipChainOf`), each
   * carried in through the frame's offset and the scale it is drawn at
   * (`framesAround`). Null outside an iframe mount, or where the frame
   * around it cannot be read exactly. The part of `#visibleBand` that also
   * clips the floating UI drawn in this frame, which no scroller inside the
   * frame does: every portal is placed inside it (`setAnchorBand`).
   *
   * `drawnIn` asks it for a portal drawn in that document instead -- a
   * `portalContainer` in a page around the frame: only what clips that page
   * clips the portal, so the climb starts past the frame that page holds,
   * and null where nothing beyond it cuts. A pane of that page the frame is
   * in, and the page's own window, are not that: a `position: fixed` portal
   * is drawn over the pane, and its window is the portal's own viewport.
   * Cut by them, a slash menu over a frame in a pane of the page went below
   * its caret and past the window, its options out of sight, and the table
   * toolbar of a table filling the pane was drawn over its rows. Null too
   * where the walk out does not reach `drawnIn` (a frame on the way that
   * cannot be read exactly): what it did reach is inside that page.
   */
  #frameBand(drawnIn: Document = this.#document): { top: number; bottom: number } | null {
    const around = framesAround(this.#document.defaultView);
    const from =
      drawnIn === this.#document
        ? 0
        : around.findIndex(({ frame }) => frame.ownerDocument === drawnIn) + 1;
    const frames = from > 0 || drawnIn === this.#document ? around.slice(from) : [];
    let top = -Infinity;
    let bottom = Infinity;

    for (const { frame, scale, offset } of frames) {
      let outerTop = 0;
      let outerBottom = frame.ownerDocument.defaultView?.innerHeight ?? 0;

      // Inside each pane's border, as it is drawn (`drawnClientBox`), as in
      // `#visibleBand`: cut by the border box, a word scrolled under the
      // border of a pane around the frame, out of sight, kept its toolbar.
      for (const scroller of this.#outerClipChain(frame)) {
        const clip = drawnClientBox(scroller);

        outerTop = Math.max(outerTop, clip.top);
        outerBottom = Math.min(outerBottom, clip.bottom);
      }

      top = Math.max(top, (outerTop - offset) / scale);
      bottom = Math.min(bottom, (outerBottom - offset) / scale);
    }

    return frames.length > 0 ? { top, bottom } : null;
  }

  /**
   * Where a portal drawn in `drawnIn` can be drawn, in this frame's
   * coordinates: that document's visual viewport -- which a phone's keyboard
   * shrinks and the layout one does not -- carried in through the frames
   * between (`framesAround`), cut by what the pages around it leave of it
   * (`#frameBand(drawnIn)`). Never by a scroller around the editor, which
   * does not clip a portal; nor, for a `portalContainer` in the page around
   * an iframe mount, by the frame's own window or a pane of that page, which
   * do not clip a portal drawn over them. Where the walk out does not reach
   * `drawnIn`, the editor's own viewport, as `positionPortal` then has no
   * band either. `scale` is the scale `drawnIn`'s pixels are to this
   * frame's (1 where it is this document, or was not reached): a size
   * measured there is that size divided by it here.
   */
  #drawArea(drawnIn: Document): { top: number; bottom: number; scale: number } {
    const mapped =
      drawnIn === this.#document
        ? undefined
        : framesAround(this.#document.defaultView).find(
            ({ frame }) => frame.ownerDocument === drawnIn,
          );
    const view = (mapped ? drawnIn : this.#document).defaultView;
    const scale = mapped?.scale ?? 1;
    const offset = mapped?.offset ?? 0;
    const visual = view?.visualViewport;
    const top = visual?.offsetTop ?? 0;
    const bottom = visual ? visual.offsetTop + visual.height : (view?.innerHeight ?? 0);
    const band = this.#frameBand(drawnIn);

    return {
      top: Math.max((top - offset) / scale, band?.top ?? -Infinity),
      bottom: Math.min((bottom - offset) / scale, band?.bottom ?? Infinity),
      scale,
    };
  }

  /**
   * `clipChainOf(frame).scrollers`, kept for the rest of the task: which
   * elements clip the frame does not change as they scroll, and the climb
   * reads the computed style of every ancestor -- asked for each portal
   * placed and each on-screen test in one scroll's handling, a frame nested
   * 300 elements deep in the page cost four times the script time. Their
   * boxes are measured fresh by the caller.
   */
  #outerClipChain(frame: Element): HTMLElement[] {
    let memo = this.#outerClipChains;

    if (!memo) {
      memo = new Map();
      this.#outerClipChains = memo;
      queueMicrotask(() => {
        this.#outerClipChains = null;
      });
    }

    let chain = memo.get(frame);

    if (!chain) {
      chain = clipChainOf(frame).scrollers;
      memo.set(frame, chain);
    }

    return chain;
  }

  #outerClipChains: Map<Element, HTMLElement[]> | null = null;

  /**
   * Everything that can scroll the editor into view, nearest first, each with
   * its box in this frame's viewport coordinates: the scroller chain, then the
   * page -- and, for a mount in a same-origin iframe, the frame's own chain and
   * page in the document around it, and so on up. The frame is no edge: a
   * frame taller than the window, or partly below it, has its bottom out of
   * sight, and a drag held at the bottom of the window scrolled nothing at all
   * because the walk ended at the frame's own page, which had nowhere to go.
   * A box in a window around the frame is carried into this one through the
   * frame's offset and the scale it is drawn at (`framesAround`): added
   * unscaled, a drag held mid-way down a frame at `scale(0.5)` read as past
   * the page's bottom edge and scrolled it hundreds of pixels. A
   * cross-origin parent is not reachable and ends the walk, as does a frame
   * that cannot be read exactly.
   */
  #scrollTargets(): { scroller: Element; box: Pick<DOMRect, 'top' | 'bottom'> }[] {
    const targets: { scroller: Element; box: Pick<DOMRect, 'top' | 'bottom'> }[] = [];
    const frames = framesAround(this.#document.defaultView);
    let doc: Document = this.#document;
    let node: Element = this.#root;
    // A y in this frame's viewport is drawn at `y * scale + offset` in the
    // viewport of `doc`.
    let scale = 1;
    let offset = 0;

    for (let level = 0; ; level += 1) {
      const into = (y: number): number => (y - offset) / scale;

      for (const scroller of scrollersAround(node)) {
        const box = scroller.getBoundingClientRect();

        targets.push({ scroller, box: { top: into(box.top), bottom: into(box.bottom) } });
      }

      if (doc.scrollingElement) {
        targets.push({
          scroller: doc.scrollingElement,
          box: { top: into(0), bottom: into(doc.defaultView?.innerHeight ?? 0) },
        });
      }

      const next = frames[level];

      if (!next) {
        return targets;
      }

      ({ scale, offset } = next);
      node = next.frame;
      doc = next.frame.ownerDocument;
    }
  }

  /**
   * How a y in this frame's viewport is drawn in the outermost viewport the
   * drag can scroll (`framesAround`, as `#scrollTargets` walks it):
   * `y * scale + offset`, the identity outside an iframe mount.
   */
  #outerMapping(): { scale: number; offset: number } {
    return framesAround(this.#document.defaultView).at(-1) ?? { scale: 1, offset: 0 };
  }

  /**
   * What to scroll this frame for a pointer at viewport Y, and by how much
   * (negative is up); null outside every edge band or when nothing there can
   * move.
   *
   * Each scroller's bands are at the edges of the part of it on screen --
   * clipped by the window and by every scroller outside it -- and the step
   * grows to the maximum at that edge and past it, so a pointer that has left
   * the window still scrolls at full speed. The nearest scroller that can
   * still move that way is the one, unless its own edge on that side is out of
   * sight: then an outer one goes first, because the inner one would only be
   * scrolling content no one can see -- a pane taller than the window scrolled
   * to its end while the page held its bottom off-screen. An exhausted one
   * hands on to the next one out, ending at the outermost page this frame can
   * reach (`#scrollTargets`).
   *
   * `pressY` is where the press landed, while it is still in force (see
   * `#autoScroll`). A press inside a band is a click there, not a reach for
   * the edge, so that band does not scroll until the pointer has moved past
   * the press towards its edge: a click on a list marker near the bottom of
   * the window otherwise scrolled the page from under the resting pointer,
   * which then selected every block the scroll carried past it.
   */
  #autoScrollTarget(
    clientY: number,
    pressY: number | null = null,
  ): { scroller: Element; delta: number } | null {
    const chain = this.#scrollTargets();
    let fallback: { scroller: Element; delta: number } | null = null;

    for (const [index, { scroller, box: own }] of chain.entries()) {
      let top = own.top;
      let bottom = own.bottom;

      for (const { box: outer } of chain.slice(index + 1)) {
        top = Math.max(top, outer.top);
        bottom = Math.min(bottom, outer.bottom);
      }

      const delta = edgeStep(clientY, top, bottom);
      const room =
        delta > 0
          ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop >= 1
          : scroller.scrollTop >= 1;

      if (delta === 0 || !room) {
        continue;
      }

      if (
        pressY !== null &&
        Math.sign(edgeStep(pressY, top, bottom)) === Math.sign(delta) &&
        (delta > 0 ? clientY <= pressY : clientY >= pressY)
      ) {
        continue;
      }

      if (delta > 0 ? own.bottom <= bottom + 1 : own.top >= top - 1) {
        return { scroller, delta };
      }

      fallback ??= { scroller, delta };
    }

    return fallback;
  }

  /**
   * The browser took the gesture over — a touch became a scroll, or the window
   * lost focus. `pointerup` does not follow, so this is the only chance to let
   * go of the drag. Heard in the document's capture phase, as `pointerup` is
   * (`#handlePointerUp`): a page that stops it above the editor left the
   * press down until the next one (R14-RV4B-1).
   */
  #handlePointerCancel = (event: PointerEvent): void => {
    this.#cancelLongPress();
    this.#pointerReleasedAt = this.#now();
    this.#stopAutoScroll();

    if (this.#drag && event.pointerId === this.#drag.pointerId) {
      this.#endDrag(null);
    }

    this.#pointerDown = false;
    this.#pressInHere = false;
    this.#textDragEscaped = false;
    this.#lockEndedBlocks = false;
    this.#textDrag = null;
    delete this.#root.dataset.selecting;
    // The same check pointerup makes: Android Chrome ends a long press with a
    // cancel, and the caret and word selection its long press placed were
    // left live beside the block selection -- both modes at once.
    this.#takeStrayCaretOut();
  };

  #handlePointerUp = (event: PointerEvent): void => {
    const text = this.#textDrag;
    // Whether the press released here was in this editor at all
    // (`#pressInHere`, cleared below). A range a page's own button builds
    // through the Selection API from its press is the API's, and is promoted
    // as one (R15-SEL-1: read with the pointer's rule, b:2..c:0 was cut to
    // "ock B").
    const releaseHere = this.#pressInHere;
    // Whether the gesture ending here was pressed in this editor's text: its
    // text drag still live, or ended with the button still down (Escape, a
    // peer's update, a lock). A press in the page's own text is not, and
    // what it selects is the page's (below).
    const pressedHere = text !== null || this.#textDragEscaped;

    // A multi-click drag the editor draws by its unit (`TextDrag.unit`) is
    // drawn once more at the release: the browser's own drag selection goes
    // on moving by character, and a move's default action undid the last
    // drawing before the frame that puts it back -- in WebKit, every move of
    // a quick drag, and the release kept "quick ... lazy d".
    if (text?.unit && text.returned && !text.promoted && event.pointerId === text.pointerId) {
      this.#returnTextDrag(text, event);
    }

    // WebKit fires no `selectionchange` after the release to catch its last
    // one by.
    this.#takeCaretOutAfterLock();

    // A text drag a lock ended with the button still down stays ended until
    // the next press (`#lockEnded`), and selects nothing: what the browser
    // went on selecting across the blocks since is no gesture of the
    // reader's, and is let go of before anything below reads it. Promoted
    // there instead, WebKit's own drag, carried on from the block under the
    // pointer when the lock landed, released "p3,p4,p5,p6" after
    // `setEditable(false)` had ended a drag across blocks (R14-RV1-7).
    if (this.#lockEnded) {
      this.#dropRangeAcrossBlocks();
    }

    this.#lockEndedBlocks = false;
    this.#pointerDown = false;
    this.#pressInHere = false;
    this.#textDragEscaped = false;
    this.#pointerReleasedAt = this.#now();
    this.#textDrag = null;
    this.#stopAutoScroll();
    this.#cancelLongPress();
    delete this.#root.dataset.selecting;
    const drag = this.#drag;

    if (drag && event.pointerId === drag.pointerId) {
      this.#endDrag(drag.active && drag.gap >= 0 ? drag : null);
      return;
    }

    // The release of a right-click: the range in place is the one the
    // browser chose for its menu, not a gesture to read (`#handleContextMenu`).
    if (this.#contextRestore) {
      this.#contextRestore();
      return;
    }

    if (this.#takeStrayCaretOut()) {
      return;
    }

    // Blocks selected, and a range of the browser's across this editor's
    // blocks beside them: both selection modes at once. A read-only view's
    // drag across blocks that a peer's reorder ended keeps the blocks it
    // held, the button still down, and WebKit's own drag goes on from the
    // editor's root -- 1,073 characters to p6 at the release, 45 to 52
    // drags in 60 with a peer reordering every 170 ms, where Chromium and
    // Firefox leave none (R14-RV3-6). No block's host holds it, so it is no
    // stray caret (above); it is let go of here. With no blocks selected the
    // range is the release's to read (below). Only for a gesture pressed in
    // this editor: a range the reader drew from the page's own text into
    // the blocks is theirs, and dropped here with blocks selected, it left
    // nothing selected and a read-only Mod+C copied nothing (R14-RV4-1).
    // And only in a read-only view, the one where the browser's own drag
    // runs across the blocks: in an editable one a drag the editor promotes
    // leaves at most WebKit's caret in a block, which is taken out above
    // (measured: a reorder after promotion, and 40 drags under a peer
    // reordering every 170 ms, left no range in any engine).
    if (this.#selected.size > 0 && pressedHere && !this.#editable) {
      this.#dropRangeAcrossBlocks();
    }

    // The release of a pointer gesture pressed here: the range is read as
    // the gesture's, with the block it was pressed on
    // (`#promoteCrossBlockSelection`).
    this.#promoteCrossBlockSelection(releaseHere ? { pressed: text?.anchorBlockId } : undefined);
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

    if (this.#mathEditor.isOpen) {
      const context = this.#mathContext;

      popovers.push({
        ownedBy: (blockId, cell) => context?.blockId === blockId && sameCell(context.cell, cell),
        contains: (node) => this.#mathEditor.contains(node),
        close: (restoreFocus) => {
          this.#closeMathEditor(restoreFocus);
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

    // The slash menu belongs in this list too. Left out of it, it was the one
    // popover an outside pointer never dismissed -- so clicking away from the
    // editor left it sitting `position: fixed` over the page at z-index 1000,
    // outliving the caret that opened it.
    if (this.#slashMenu.isOpen) {
      const context = this.#slashContext;

      popovers.push({
        // The menu only ever opens outside a table cell, so a caret in one
        // never owns it.
        ownedBy: (blockId, cell) => context?.blockId === blockId && cell === undefined,
        contains: (node) => node !== null && this.#slashMenu.element.contains(node),
        close: () => {
          this.#closeSlashMenu();
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
    this.#cancelLinkOpen();
    this.#pointerDown = true;
    this.#textDragEscaped = false;
    this.#lockEndedBlocks = false;
    this.#contextRestore = null;

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

  /**
   * The documents above an iframe mount, with the frame each one holds the
   * editor's side of.
   *
   * A press or a focus in the page around the frame happens in another
   * document, which neither `#handleDocumentPointerDown` nor
   * `#handleDocumentFocusIn` can hear: clicking an input in the host page
   * left the link editor open over the frame. Only those the editor's window
   * may reach -- a cross-origin parent says nothing, and is left alone.
   */
  readonly #outerDocuments: { doc: Document; frame: Element }[] = [];

  #listenToOuterDocuments(): void {
    let view: Window | null = this.#document.defaultView;

    while (view) {
      let frame: Element | null = null;
      let doc: Document | null = null;

      try {
        frame = view.frameElement;
        doc = frame ? frame.ownerDocument : null;
      } catch {
        doc = null;
      }

      if (!frame || !doc) {
        // A window with a parent but no frame element this script can read
        // is framed by a page of another origin: the chain stops short of
        // the top (`#crossOriginAbove`).
        let framed = false;

        try {
          framed = view.parent !== view;
        } catch {
          framed = true;
        }

        this.#crossOriginAbove = framed;
        return;
      }

      this.#outerDocuments.push({ doc, frame });
      doc.addEventListener('pointerdown', this.#handleOuterPointerDown, true);
      doc.addEventListener('focusin', this.#handleOuterFocusIn, true);
      // What is on screen is measured through the frames' windows too
      // (`#visibleBand`), so a scroll in the page around the frame -- or in a
      // shadow tree the frame is drawn in -- moves the ground as one inside it
      // does: a table toolbar hidden with its cell came back only with the
      // next caret move.
      doc.addEventListener('scroll', this.#handleViewportChange, true);
      for (const shadow of shadowRootsAround(frame)) {
        this.#shadowTrees.push(shadow);
        shadow.addEventListener('scroll', this.#handleViewportChange, true);
      }
      view = doc.defaultView;
    }
  }

  /** Whether an event in an outer document is about the frame that leads here. */
  #intoFrame(event: Event): boolean {
    const path = composedTargets(event);

    return this.#outerDocuments.some(({ frame }) => path.includes(frame));
  }

  /**
   * Whether an event in an outer document landed on the editor's own floating
   * UI, which a `portalContainer` in the page around the frame puts there. It
   * is still the editor: read as a press outside, "insert row below" hid the
   * table toolbar and did nothing, and F10's focus on its first button hid it
   * under that focus.
   */
  #onOwnPortal(event: Event): boolean {
    const path = composedTargets(event);

    return this.#portals.some((portal) => path.includes(portal));
  }

  /**
   * A press in the page around the frame: every popover is left behind, and
   * both toolbars with them. Those two are drawn from the frame's own
   * selection, which a press in another document does not change -- so
   * nothing inside ever said to hide them, and they stayed over the frame
   * acting on text the reader had left. Focus coming back into the editor
   * draws them again (`#handleToolbarFocusIn`).
   */
  #handleOuterPointerDown = (event: PointerEvent): void => {
    if (this.#intoFrame(event)) {
      return;
    }

    // On one of the portals: the popovers it is not are left behind, as
    // `#handleDocumentPointerDown` leaves them in the editor's own document.
    const path = composedTargets(event);

    for (const popover of this.#openPopovers()) {
      if (!path.some((node) => popover.contains(node))) {
        popover.close(false);
      }
    }

    if (!this.#onOwnPortal(event)) {
      this.#hideToolbars();
    }
  };

  /** Hides the format and table toolbars: focus has gone somewhere else. */
  #hideToolbars(): void {
    this.#toolbar.hide();
    this.#hideTableToolbar();
  }

  /**
   * Focus coming back into the editor draws the toolbars again for the
   * selection it comes back to. Leaving hid them (`#hideToolbars`), and the
   * selection need not change on the way back: in an iframe mount the frame
   * keeps its caret while the page around it has focus, so a click back onto
   * that same spot fired no `selectionchange` and the table toolbar never
   * returned.
   */
  #handleToolbarFocusIn = (): void => {
    // Not for the focus the editor gives a host while it writes the reader's
    // selection back: what the host holds before the write is not the
    // reader's, and the writer draws what was showing (`#ownSelection`).
    if (this.#writingOwnSelection) {
      return;
    }

    this.#syncToolbar();
  };

  /**
   * Focus arriving in the page around the frame, as `#handleDocumentFocusIn`
   * answers it inside: the dialogs close, without handing focus back. Focus
   * coming back into the frame -- from another window too -- arrives at the
   * frame element first, and is not leaving.
   */
  #handleOuterFocusIn = (event: FocusEvent): void => {
    if (this.#intoFrame(event)) {
      return;
    }

    // Focus arriving in one of the portals is answered as it is inside: the
    // dialogs it is not close (the link editor's own field is where Mod+K
    // puts focus), and the toolbars stay.
    this.#handleDocumentFocusIn(event);

    if (!this.#onOwnPortal(event)) {
      this.#hideToolbars();
    }
  };

  /** Remembers which block a text drag started in. */
  #handleRootPointerDown = (event: PointerEvent): void => {
    // The compatibility mousedown that follows needs to know which pointer
    // pressed, to hand a press that missed every host a drag of its own.
    this.#press = { pointerId: event.pointerId, pointerType: event.pointerType };
    this.#shiftPress = false;
    // A press starts a new run of ↑/↓ (`#goal`): one that put the caret back
    // where the last run ended otherwise continued that run's column.
    this.#goal = null;
    // A press puts the caret somewhere, if only where it was: a formula the
    // `$` rule just made stands (`#takeBackFormula`).
    this.#ruleFormula = null;

    if (this.#drag || event.button !== 0) {
      return;
    }

    const node = isNode(event.target) ? event.target : null;

    if (this.#gutter.contains(node)) {
      return;
    }

    // A scrollbar's thumb or track: the drag that follows scrolls, it does not
    // select, and a pointer carried past the table's edge while paging it
    // sideways otherwise selected the blocks it crossed.
    if (onScrollbar(event)) {
      this.#textDrag = null;
      return;
    }

    const anchorBlockId = this.#renderer.blockIdFromNode(node);

    // Not for touch. A finger moving across blocks is the browser's pan, and
    // Chromium delivers a few pointermoves before it says so with
    // pointercancel -- enough to cross a block edge and select two blocks that
    // then outlived the scroll (the e2e finding F11). Long-press is the touch
    // way into block selection.
    if (anchorBlockId && event.pointerType !== 'touch') {
      const anchorHost = this.#hostFromNode(node);
      const point = anchorHost ? this.#caretFromPoint(event.clientX, event.clientY) : null;
      const held = event.shiftKey ? this.#selectionTarget() : null;
      const heldHere = held !== null && held.content === anchorHost;

      this.#textDrag = {
        anchorBlockId,
        pointerId: event.pointerId,
        currentId: anchorBlockId,
        anchorHost,
        anchorPoint: point && anchorHost?.contains(point.node) ? point : null,
        anchorPending: event.shiftKey && anchorHost !== null,
        shift: event.shiftKey,
        anchorEnd: null,
        promoted: false,
        returned: false,
        placed: false,
        startX: event.clientX,
        startY: event.clientY,
        still: false,
        detail: 1,
        unit: null,
        unitRead: false,
        heldRange: heldHere
          ? { start: held.range.start, end: held.range.end, backward: held.backward }
          : null,
        lastFocus: null,
        missed: false,
      };
    } else {
      this.#textDrag = null;
    }

    // Touch has no hover, so the controls have to be offered some other way.
    // Offered on exactly the terms hover offers them, though: `#handlePointerOver`
    // stands down for a read-only editor and for `dragHandles: false`, and a
    // touch is not a second, laxer way in — a reader who taps a paragraph is
    // not owed an add button and a drag handle for a document they cannot edit.
    if (event.pointerType === 'touch' && anchorBlockId) {
      if (this.#useGutter && this.#editable) {
        // The tap's own click is hit-tested once the controls are drawn, and
        // a tap just beside the text landed it on the `+` (R5-PTR-6). Only a
        // press that drew them -- revealed them, or moved them under the
        // finger: with the controls already there, a tap just off the `+`
        // that WebKit retargets onto it is a press on it, and swallowing its
        // click lost the add (R6-PTR-2). Asked of where they are drawn, not
        // of the block they point at: drawn for this block at an offset a
        // resize or the text typed above had made stale, the press moved
        // them under the finger unmarked, and the click added a paragraph.
        if (this.#positionGutter(anchorBlockId)) {
          this.#gutter.markRevealedByPress();
        }
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
        // Under the finger: a press reveals nothing (`#selectFromHandle`).
        this.#setBlockSelection([blockId], blockId, { reveal: false });
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
   * of the document still selects to the bottom (and past its start, to the
   * top) -- or, for a press the editor
   * placed and a pointer in a gap between two blocks, to the block the pointer
   * was last over.
   */
  #updateTextDrag(event: Pick<PointerEvent, 'pointerId' | 'clientX' | 'clientY'>): void {
    const drag = this.#textDrag;

    if (!drag || event.pointerId !== drag.pointerId || !this.#pointerDown) {
      return;
    }

    // A press the editor placed can begin in a gap that is no block's -- the
    // band above a heading, the root's padding -- and the block above a gap
    // is not the one it was aimed at: a click there with a pixel of jitter
    // selected that block and the next. So for such a drag a gap between two
    // blocks keeps the block the pointer was last over. Below the last block
    // is no such gap: it is the end of the document, as it is for every other
    // drag, and a pointer moved there in one quick step had not been over the
    // blocks in between at all, so it selected nothing. Above the first block
    // is the same, the other way: the start of the document.
    const overId = this.#blockIdAtY(event.clientY, !drag.placed) ?? drag.currentId;

    if (!overId) {
      return;
    }

    // Still inside the block it started in: leave the native text selection
    // be. Back in it after a detour through other blocks, the gesture is a
    // text selection again -- the anchor to the pointer -- not that block
    // selected whole, where the next keystroke replaced all of it.
    if (overId === drag.anchorBlockId) {
      drag.currentId = overId;

      if (drag.placed || drag.promoted || drag.returned || this.#selected.size > 0) {
        this.#returnTextDrag(drag, event);
      }

      return;
    }

    if (overId === drag.currentId) {
      return;
    }

    drag.currentId = overId;

    const ids = blockIdRange(this.#blocks, drag.anchorBlockId, overId);

    if (ids.length <= 1 && this.#selected.size === 0) {
      return;
    }

    // Whole blocks are the unit now; stop the browser painting text over them.
    // Not revealed, for the reason a handle drag is not: scrolling back to the
    // anchor moves the page under the pointer, and fights the edge autoscroll
    // that carried the pointer away from it.
    drag.promoted = true;
    drag.returned = false;
    drag.lastFocus = null;
    this.#root.dataset.selecting = 'true';
    this.#setBlockSelection(ids, drag.anchorBlockId, { reveal: false });
  }

  /**
   * Gives a text drag that came back to its own block a text range again.
   *
   * From where the press landed to the pointer, the range the browser would
   * have drawn had the pointer never left. Set on every move while it stays
   * there: block selection took the browser's own drag selection away, and
   * nothing says it resumes. A press the editor placed itself is drawn here
   * from its first move past `DRAG_THRESHOLD_PX` (see `TextDrag.still`),
   * since its cancelled mousedown never started one.
   * The edge autoscroll keeps running (see `#handlePointerMove`). A block
   * with no text to come back to is selected alone instead.
   */
  #returnTextDrag(drag: TextDrag, event: Pick<PointerEvent, 'clientX' | 'clientY'>): void {
    const host = drag.anchorHost;

    if (!host?.isConnected) {
      // No text to come back to: the drag began on a block that holds none
      // (a divider, a picture), or a peer's update left its press no place
      // (`#resumePromotedDrag`). Back over its own block, the selection is
      // that block alone, as it is one block and the next when it moves
      // away again -- it kept the blocks it had last crossed, "hr,p2" with
      // the pointer back on the rule (R14-FX-3). Blocks only: no offset is
      // guessed for a text range. Once, not on every move.
      if (drag.promoted && !(this.#selected.size === 1 && this.#selected.has(drag.anchorBlockId))) {
        this.#setBlockSelection([drag.anchorBlockId], drag.anchorBlockId, { reveal: false });
      }

      return;
    }

    if (drag.promoted || this.#selected.size > 0) {
      drag.promoted = false;
      drag.returned = true;
      delete this.#root.dataset.selecting;
      this.#clearBlockSelection();
      host.focus({ preventScroll: true });
    }

    const { clientX, clientY } = event;
    const apply = () => {
      const anchor =
        drag.anchorPoint && host.contains(drag.anchorPoint.node)
          ? drag.anchorPoint
          : { node: host, offset: 0 };
      // Clamped into the host, as a press beside it is (`#caretNear`): a drag
      // carried sideways out of the editor hit-tested the page beside it,
      // which collapsed the range in Chromium and, in WebKit RTL, drew it the
      // wrong way. And where that misses the host, asked once more past the
      // editor's own floating UI (`#throughPortals`): the format toolbar
      // this drag's own range draws sits over the line above it, and hit
      // there, a drag up onto a blank line collapsed to its anchor at the
      // release (R14-PTR-3).
      const hit =
        this.#caretInHost(host, clientX, clientY) ?? this.#throughPortals(host, clientX, clientY);

      // Still a miss: something of the page's own is drawn over the text
      // there (a sticky bar), and nothing says which caret the pointer
      // means. The range drawn so far stays exactly as it is: drawn again
      // to the caret found last (`TextDrag.lastFocus`: under the pointer,
      // or where a peer's update left the range, `#resumeTextDrag`), since
      // the browser's own drag selection, where the press began one, goes
      // on moving it under the bar -- left to stand, Chromium's took a
      // double-clicked word's [20,37] to [14,20]. Collapsed to the anchor,
      // as it was until round 14, a drag carried under such a bar let go
      // of everything it had selected: [23,32] released [32,32], the
      // word's [20,37] its own word alone (R14-FX-1). With no caret found
      // yet there is no range of this drag's either -- it is back from
      // other blocks, or has not moved -- and the anchor, the press's own
      // place, is the caret.
      const last = hit ? null : drag.lastFocus;

      if (hit) {
        drag.lastFocus = hit;
      }

      drag.missed = hit === null;

      const focus = hit ?? last ?? anchor;
      const unit = drag.unit;
      const at = unit ? offsetWithin(host, focus.node, focus.offset) : null;

      if (!unit || at === null) {
        this.#selection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
        return;
      }

      // From the press's own unit to the word or paragraph at the caret
      // nearest the pointer (`farUnit`), which is the one Chromium and
      // WebKit extend a word drag to -- never the character under the
      // pointer, which left out the space they take after a word's last
      // letter. The anchor's side stays as it was carried.
      const text = richToPlainText(parseRichText(host));

      // Inside the anchor, forward: the anchor and what its own unit grew to
      // (a peer typing at the end of the reader's paragraph is in it now,
      // as a triple-click would take it).
      const forward = at >= unit.start;
      const [from, to] = farUnit(text, at, drag.detail > 2, unit);

      if (forward) {
        setSelectionRange(host, unit.start, Math.max(unit.end, to));
      } else {
        setSelectionRange(host, Math.min(from, unit.start), unit.end, true);
      }
    };

    apply();
    // And again once the move's default action has run: Chromium resumes its
    // own drag selection there, from a base of its choosing -- sometimes the
    // pointer itself, collapsing the range this just drew.
    this.#document.defaultView?.requestAnimationFrame(() => {
      if (this.#textDrag === drag && !drag.promoted && this.#pointerDown) {
        apply();
      }
    });
  }

  /**
   * Asks for the caret in `host` again (`#caretInHost`) with the editor's
   * own floating UI out of its way, for a hit test that missed the host:
   * the portal drawn on top at the point asked takes no pointer for its
   * duration -- and the one under it, should there be one -- which the
   * caret-from-point calls honour in every engine, and gets its own inline
   * `pointer-events` back, value and priority, before anything is drawn. A
   * drag the editor draws is its own selection's; a toolbar drawn for it is
   * no place the pointer means (R14-PTR-3). Null, and nothing touched,
   * where no portal is on top there: the miss was not theirs. Asked of what
   * is on top (`elementFromPoint`), so a drag under something of the page's
   * own writes no style either, the toolbar drawn beneath a page's header
   * included -- with every showing portal taken out on any miss, a drag
   * held under such a header wrote 73 to 75 in two thirds of a second. And
   * asked of the host's document, the answer followed into each shadow
   * root the portal is in, outermost first, while that root's host is what
   * is on top: asked of the portal's own tree alone, Firefox answers for a
   * shadow root with the topmost element of that tree, whatever the page
   * draws over it, and the toolbar under a page's header was written 46
   * times all the same (R14-RV2-3). The roots are the portal's own
   * (`getRootNode`), not ones read off the answer: a closed root's host
   * has no `shadowRoot` to follow, and in one the toolbar was never found
   * -- the drag stopped a line short under it (R14-RV3-2). That also leaves out a portal of
   * another document -- one a `portalContainer` puts in the page around an
   * iframe mount: it is in no hit test made in the frame, the point is
   * none of that page's, and nothing the frame's document has on top is
   * inside it.
   */
  #throughPortals(host: HTMLElement, x: number, y: number): CaretPoint | null {
    const aim = this.#aimInHost(host, x, y);
    const showing = [
      this.#toolbar.element,
      this.#tableToolbar.element,
      this.#slashMenu.element,
      this.#linkEditor.element,
      this.#imageEditor.element,
      this.#iconPicker.element,
    ].filter((element) => element.isConnected && !element.hidden);
    const taken: { element: HTMLElement; value: string; priority: string }[] = [];
    const onTop = (element: HTMLElement): boolean => {
      // The shadow roots the portal is in, outermost first: known from the
      // portal itself, since a closed root's host answers `shadowRoot` with
      // null and names nothing to follow.
      const roots: ShadowRoot[] = [];

      for (let root = element.getRootNode(); isShadowRoot(root); root = root.host.getRootNode()) {
        roots.unshift(root);
      }

      let top = host.ownerDocument.elementFromPoint(aim.x, aim.y);

      // Into each of them only while its host is what is on top: under
      // something the page draws over the host, the answer stays the page's.
      for (const root of roots) {
        if (top !== root.host) {
          break;
        }

        top = root.elementFromPoint(aim.x, aim.y);
      }

      return top !== null && element.contains(top);
    };

    try {
      for (let index = showing.findIndex(onTop); index !== -1; index = showing.findIndex(onTop)) {
        const [element] = showing.splice(index, 1);

        taken.push({
          element: element!,
          value: element!.style.getPropertyValue('pointer-events'),
          priority: element!.style.getPropertyPriority('pointer-events'),
        });
        element!.style.setProperty('pointer-events', 'none', 'important');
      }

      return taken.length === 0 ? null : this.#caretInHost(host, x, y);
    } finally {
      for (const { element, value, priority } of taken) {
        if (value) {
          element.style.setProperty('pointer-events', value, priority);
        } else {
          element.style.removeProperty('pointer-events');
        }
      }
    }
  }

  /**
   * The block under a viewport Y; below the last block, the last block; above
   * the first block, the first block; and in a gap between two blocks, the one
   * above it -- or, without `inGaps`, null.
   *
   * The two ends mirror each other: past either one is that end of the
   * document. Above the first block it was null, so a drag carried there in
   * one quick step -- never over the blocks in between -- kept only its own
   * block, where the same step below selected to the end.
   */
  #blockIdAtY(clientY: number, inGaps = true): string | null {
    let above: string | null = null;
    let first: string | null = null;
    let below = false;

    for (const block of this.#visible()) {
      const view = this.#renderer.getView(block.id);

      if (!view) {
        continue;
      }

      const rect = view.root.getBoundingClientRect();

      if (clientY >= rect.top && clientY <= rect.bottom) {
        return block.id;
      }

      first ??= block.id;

      if (clientY > rect.bottom) {
        above = block.id;
      } else {
        below = true;
      }
    }

    if (above === null) {
      return first;
    }

    return inGaps || !below ? above : null;
  }

  /** Steps from a caret or range whose focus is at a block edge into a block selection. */
  #extendFromTextToBlocks(blockId: string, direction: 1 | -1): void {
    // Stepped through the visible list: the raw array puts a block hidden
    // inside a collapsed toggle next to the caret, and Backspace would then
    // destroy something that was never on screen.
    const visible = this.#visible();
    const index = findBlockIndex(visible, blockId);
    const sibling = index === -1 ? undefined : visible[index + direction];

    // The block the key took in is the end that moved, and the one brought
    // into view, as on every later step (`#extendBlockSelection`): revealed
    // by the block the caret was in, Shift+↑ from the window's first block
    // took in p29 at -31..-1 with the page where it was, and Backspace
    // deleted a block the reader had not seen (R14-RV3-4).
    this.#setBlockSelection(
      sibling ? blockIdRange(this.#blocks, blockId, sibling.id) : [blockId],
      blockId,
      sibling ? { show: sibling.id } : {},
    );
  }

  /**
   * Abandons a drag on Escape.
   *
   * Bound to the document rather than the editor root because pressing the
   * handle can leave focus outside the editor, where a root listener would
   * never see the key. In the capture phase, and stopped there: Escape during
   * a gesture ends the gesture and nothing else. Let through, the root's own
   * block-mode Escape ran as well -- it cleared the selection the drag had
   * made and left the editor -- and a text drag carried on regardless, so the
   * next move re-selected and took focus straight back.
   */
  #handleDocumentKeyDown = (event: KeyboardEvent): void => {
    // A key after a click on a link is newer than it (`#linkOpen`).
    this.#cancelLinkOpen();

    if (event.key !== 'Escape') {
      return;
    }

    if (this.#drag?.active) {
      event.preventDefault();
      event.stopPropagation();
      this.#endDrag(null);
      return;
    }

    if (this.#textDrag && this.#pointerDown) {
      event.preventDefault();
      event.stopPropagation();
      this.#textDrag = null;
      this.#textDragEscaped = true;
      this.#stopAutoScroll();
      delete this.#root.dataset.selecting;
      this.#takeStrayCaretOut();
    }
  };

  /** Set by the second Escape; the next Tab or Shift+Tab leaves the editor. */
  #exitArmed = false;

  /**
   * Carries the Tab after Escape, Escape out of the editor.
   *
   * The second Escape blurs the editor, but blurring does not move the
   * browser's sequential-focus starting point -- and neither does moving the
   * selection after the root -- so the Tab that followed went straight back
   * into the editor's first block (or to whatever came first on the page). The
   * one documented way out was a way back in. So that Tab is handled here: to
   * the next tabbable element after the editor, or the previous one for
   * Shift+Tab (#tabbablesOutside), and the key is taken only once focus has
   * really landed there -- a swallowed Tab that moved nothing left focus on
   * `<body>` for the next Tab to go back in. With nowhere to land, the key is
   * the browser's, from a starting point outside the editor (#placeExitStop).
   *
   * Only a Tab spends it. A reader who scrolls on with ↓, Space or Page Down
   * before tabbing has moved no focus, and disarming on those keys sent them
   * back in; a key that does move focus disarms it through `focusin`, as a
   * pointer press does.
   */
  #handleExitKeyDown = (event: KeyboardEvent): void => {
    if (!this.#exitArmed || event.key !== 'Tab') {
      return;
    }

    this.#exitArmed = false;

    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    const active = this.#activeElement();

    if (active && this.#root.contains(active)) {
      return;
    }

    const forward = !event.shiftKey;
    const { found, outermost } = this.#tabbablesOutside(forward);

    for (const target of found) {
      target.focus();

      if ((target.getRootNode() as Document | ShadowRoot).activeElement === target) {
        event.preventDefault();
        return;
      }
    }

    this.#placeExitStop(forward, outermost);
  };

  /**
   * Any press or focus move anywhere disarms the Tab exit -- and a press
   * begins a new gesture, which no lock has ended (`#lockEnded`). In the
   * document's capture phase, which a page cannot stop: reset in the bubble
   * phase, it was never reached on a page that stops `pointerdown` above the
   * editor (a container with drag handling of its own), and the next
   * gesture's release was read as one a lock had ended -- a double-click and
   * a Shift+click across blocks selected nothing (R14-RV4-2). Only the
   * press resets it, never its focus half: a focus move begins no gesture,
   * and the button is still down. Reset by focus, a host that locks and
   * focuses a button or a `tabindex` element of its own in the same call (a
   * "Done" button's handler) let the release promote the browser's range
   * across the read-only blocks -- p2..p6 in WebKit, p1..p6 in Firefox,
   * every time (R14-RV5-1).
   *
   * A press that lands in this editor is marked here too (`#pointerDown`),
   * for the same reason. Marked only in the bubble phase
   * (`#handleDocumentPointerDown`, which still marks every other press), a
   * press the page stopped above the editor was no press of the editor's,
   * and a lock in the middle of its drag let the release promote the
   * browser's range across the read-only blocks: p1 to p3 selected after
   * the lock, in every engine (round 14, review 4). The release that
   * clears it is heard in the same phase (`#handlePointerUp`,
   * `#handlePointerCancel`): cleared only in the bubble phase, a page that
   * stopped the release as well left the press down from the first click
   * on (R14-RV4B-1).
   */
  #disarmExit = (event: Event): void => {
    this.#exitArmed = false;

    if (event.type !== 'pointerdown') {
      return;
    }

    this.#lockEnded = false;
    this.#pressInHere = this.#pressedHere(composedTargets(event));

    if (this.#pressInHere) {
      this.#pointerDown = true;
    }
  };

  /**
   * Whether a press the document heard landed in this editor. The path shows
   * the root itself unless a closed shadow root hides it; then the first of
   * its hosts the document can see is where the path begins, and a path
   * that only passes through that host (a press on something else of its
   * open tree) is not one. A press on anything else inside the closed root
   * also begins at that host, and counts: the document cannot tell the two
   * apart.
   */
  #pressedHere(path: readonly Node[]): boolean {
    for (let node: Node = this.#root; ;) {
      if (path.includes(node)) {
        return node === this.#root || path[0] === node;
      }

      const tree = node.getRootNode();

      if (!isShadowRoot(tree)) {
        return false;
      }

      node = tree.host;
    }
  }

  /**
   * Cancels a Backspace aimed at the page while `#backAfterLetGo` is armed.
   *
   * Listened to on the editor's document and on every same-origin document
   * around an iframe mount (`#outerDocuments`): a `portalContainer` in the
   * page around the frame puts the panels there, and a panel closed under
   * the reader leaves focus on that page's `<body>`, whose keys the frame's
   * document never hears. "The page" is the document's `<body>`, its root
   * element, or a `<dialog>` element: WebKit's Tab inside a modal dialog
   * with nothing focused focuses the dialog itself, and Backspace there goes
   * back in history as it does on `<body>`.
   */
  #guardBackspace = (event: KeyboardEvent): void => {
    if (this.#backAfterLetGo && event.key === 'Backspace' && isPageTarget(event.target)) {
      event.preventDefault();
    }
  };

  /**
   * Spends `#backAfterLetGo` once the reader places themselves: a press
   * anywhere, or focus arriving on something that is not the page.
   *
   * Not focus arriving on the page itself, nor on a `<dialog>` element --
   * WebKit's Tab focused the modal dialog an editor was mounted in, and with
   * the guard spent by that Tab the Backspace after it went back in history
   * -- nor on the frame an iframe mount is drawn in, which focus crosses on
   * its way back into the frame's own `<body>`. Not the Tab key itself
   * either (round 11): it is the focus it moves that places the reader.
   */
  #spendBackGuard = (event: Event): void => {
    if (!this.#backAfterLetGo) {
      return;
    }

    if (event.type === 'focusin') {
      const target = event.target;

      if (isPageTarget(target) || this.#outerDocuments.some(({ frame }) => frame === target)) {
        return;
      }
    }

    this.#backAfterLetGo = false;
    // The reader has placed themselves: an unlock gives nothing back.
    this.#lockedCaret = null;
  };

  /** Holds the browser's Tab starting point outside the editor, for one Tab. */
  #exitStop: HTMLElement | null = null;

  /**
   * With nothing tabbable beyond the editor, the browser's own Tab goes on
   * from its sequential-focus starting point -- still inside the editor, so it
   * went straight back into the same block. A focusable stand-in just after
   * `beside` (before it, for Shift+Tab) moves that point out, and the key is
   * left to the browser, which goes on from there to its own controls or wraps
   * round the page.
   *
   * The stand-in goes as soon as it has done that: on its blur, on focus
   * arriving anywhere else, and on the next key pressed while it holds focus
   * (by which time the browser's Tab from it has long run). Blur alone was not
   * enough -- with nothing before the editor Firefox headless keeps focus on
   * the stand-in through Shift+Tab, and it stayed in the page across every
   * further press. `destroy` takes it too.
   *
   * `beside` is the outermost element the search climbed to -- the shadow host,
   * the frame -- not the root: a stand-in left inside a shadow root or a frame
   * is the end of *that* scope, and Chromium and WebKit wrapped from there to
   * the start of the same scope, the editor's first block.
   */
  #placeExitStop(forward: boolean, beside: Element): void {
    this.#removeExitStop();
    const stop = beside.ownerDocument.createElement('span');
    stop.tabIndex = -1;
    stop.className = 'neditor-exit-stop';
    stop.style.cssText =
      'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap';
    stop.addEventListener('blur', this.#removeExitStop);
    stop.addEventListener('keydown', this.#removeExitStop);
    // Its own document: past a frame, the stand-in is in the parent's.
    stop.ownerDocument.addEventListener('focusin', this.#handleExitStopFocusIn, true);

    if (forward) {
      beside.after(stop);
    } else {
      beside.before(stop);
    }

    this.#exitStop = stop;
    stop.focus({ preventScroll: true });
  }

  #handleExitStopFocusIn = (event: FocusEvent): void => {
    if (event.target !== this.#exitStop) {
      this.#removeExitStop();
    }
  };

  #removeExitStop = (): void => {
    const stop = this.#exitStop;
    this.#exitStop = null;

    if (!stop) {
      return;
    }

    stop.removeEventListener('blur', this.#removeExitStop);
    stop.removeEventListener('keydown', this.#removeExitStop);
    stop.ownerDocument.removeEventListener('focusin', this.#handleExitStopFocusIn, true);
    stop.remove();
  };

  /**
   * The next (or previous) element Tab can reach outside the editor, in
   * document order within the tree the editor is mounted in. The editor's own
   * hosts and its portals do not count, nor does anything disabled, inert,
   * unrendered, invisible or taken out of the order with a negative tabindex.
   *
   * A shadow root with nothing else in it to reach is not the end of the page,
   * so the search continues from its host in the tree around it -- otherwise a
   * custom element wrapping the editor alone gave the Tab back to the browser,
   * which put it straight back into the editor. A frame's document that holds
   * nothing else continues the same way, from the frame element in its parent
   * where that parent can be reached (same origin).
   *
   * Nearest first, all of them, because the first can still refuse focus: a
   * modal dialog makes everything outside it inert with no attribute to say
   * so, and the element after a dialog-mounted editor was "found", focus() on
   * it failed without a word, and the swallowed Tab left focus on `<body>`.
   * The caller tries each in turn. With them, the outermost element the
   * search climbed to.
   *
   * Each tree is read through the shadow roots inside it (`composedTabOrder`):
   * `querySelectorAll` stops at a shadow boundary, so a web component's own
   * button right after the editor was passed over.
   */
  #tabbablesOutside(forward: boolean): { found: HTMLElement[]; outermost: Element } {
    let boundary: Element = this.#root;

    for (;;) {
      const scope = boundary.getRootNode() as Document | ShadowRoot;
      const view = boundary.ownerDocument.defaultView;
      const reachable = (element: HTMLElement): boolean =>
        inTabOrder(element) &&
        !this.#portals.some((portal) => portal.contains(element)) &&
        !element.matches(':disabled') &&
        !(element.localName === 'input' && (element as HTMLInputElement).type === 'hidden') &&
        !inInertTree(element) &&
        element.getClientRects().length > 0 &&
        view?.getComputedStyle(element).visibility !== 'hidden';
      const { before, after } = composedTabOrder(scope, boundary);
      const found = forward ? after.filter(reachable) : before.filter(reachable).reverse();

      if (found.length > 0) {
        return { found, outermost: boundary };
      }

      if ('host' in scope) {
        boundary = scope.host;
        continue;
      }

      const frame = frameElementOf(view);

      if (!frame) {
        return { found, outermost: boundary };
      }

      boundary = frame;
    }
  }

  #endDrag(commit: { ids: Set<string>; gap: number } | null): void {
    // A drag that actually moved is followed by a compatibility click on the
    // handle that holds the pointer capture. That click is the tail of this
    // gesture, not a new one, so the handle's click hook has to skip it —
    // abandoned and cancelled drags included, since they end the same way.
    const wasActive = this.#drag?.active ?? false;
    this.#clickEndedDrag = wasActive;
    this.#drag = null;
    this.#stopAutoScroll();

    // The press focused the handle button, and the click this flag swallows
    // was what would have focused the root -- so after a drag focus sat on the
    // handle with the blocks selected, where Escape could not leave and Cmd+Z
    // could not undo the move. Block selection keeps focus on the root.
    if (wasActive && !this.#destroyed && this.#selected.size > 0) {
      this.#selection()?.removeAllRanges();
      this.#root.focus({ preventScroll: true });
    }
    this.#gutter.setDragging(false);
    delete this.#root.dataset.dragging;
    this.#dropIndicator.hidden = true;

    // A drag that began in an editable editor can end in a read-only one.
    if (commit && this.#canEdit()) {
      // The drag carries visible anchors; a collapsed toggle's children join
      // here, or they stay behind and are re-parented under whatever follows.
      this.#commit(
        keepVisible(
          this.#blocks,
          moveBlocks(this.#blocks, withHiddenDescendants(this.#blocks, commit.ids), commit.gap),
        ),
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
   * Converts a text selection across blocks into a block selection -- or,
   * at a pointer's release, where it holds only one block's text, into that
   * block's own range.
   *
   * A mouse drag in an editable view never produces one: the browser
   * confines a selection to a single editing host, every block is its own,
   * and the editor draws that gesture itself (`#updateTextDrag`). What
   * reaches here is a range across blocks the editor did not draw: one an
   * embedder builds through the Selection API and, in a read-only view, the
   * browser's own Shift+arrow (`#handleSelectionChange`), which select every
   * block they reach; and a read-only view's pointer gestures -- its blocks
   * are no editing hosts, so the browser's drag, Shift+click and
   * multi-click run across them and are read at the release
   * (`#handlePointerUp`, `release`), which passes the block the gesture was
   * pressed on (`pressed`). That is the one block it names: a drag that
   * reaches another block is a block selection from that move on
   * (`#updateTextDrag`), and leaves no range across blocks for the release
   * to read -- measured, 108 read-only drags, Shift+drags and multi-click
   * drags onto, past and back from a block with no text, in three engines.
   */
  #promoteCrossBlockSelection(release?: { pressed: string | undefined }): boolean {
    const selection = readSelection(this.#root);

    if (!selection || selection.isCollapsed) {
      return false;
    }

    const from = this.#renderer.blockIdFromNode(selection.anchorNode);
    const to = this.#renderer.blockIdFromNode(selection.focusNode);

    if (!from || !to || from === to) {
      return false;
    }

    // A range with an end outside the editor is not across its blocks, and
    // none of them is the reader's to select -- a triple-click on the last
    // block that WebKit (and Chromium after an announcement) runs on past
    // the blocks included: a known limit, since telling that run-on from the
    // reader's drag into the page's text took three rounds and was still
    // wrong in a shadow mount and over text the page does not draw (R15-SEL-4,
    // R16-1/-2, R17-1/-2; reverted). At the release of a drag from
    // the page's text into a shadow-mounted editor, Firefox moves the
    // selection's own anchor into the tree, to the first block, and a..d
    // were selected -- Mod+C copied the blocks -- for a range the reader
    // began in the page (R14-RV5-B1). The composed range's ends say where
    // the range really is (`readSelectionEnds`).
    const ends = readSelectionEnds(this.#root);

    if (ends && (!this.#root.contains(ends.start) || !this.#root.contains(ends.end))) {
      return false;
    }

    // Read over the blocks on screen: selection anchors live in visible
    // space. A collapsed toggle's children are in the document, not on
    // screen, and counted here they were left over once the next block was
    // left out (below): the read-only triple-click on a closed toggle's text
    // selected the toggle as a block, and Mod+C copied what it hides
    // (R14-RV6-1). A block selection that takes such a toggle in still
    // carries them, at the edit (`#selectionForEdit`). The range's ends are
    // always in blocks on screen -- a hidden block is not drawn -- so the
    // last id is one the reader can see.
    const ids = blockIdRange(this.#visible(), from, to);

    // An id this editor does not own yields an empty range. Selecting nothing
    // still clears the caret and takes focus, so leave the selection be.
    if (ids.length === 0) {
      return false;
    }

    // Only a pointer's release leaves a block out (below). A range a key
    // made selects every block it reaches, as round 13 did: asked of the
    // range Firefox's read-only Shift+→ from the end of a block makes,
    // which reaches the next block at the start of its text, the rule left
    // that block out, and the key never crossed the edge -- in every
    // engine from a word double-clicked at the end of a block, and in
    // Firefox Shift+← from the start of one and Shift+↑ out of a table
    // dropped the block the range began in (R14-RV7-1). A press does not
    // reveal what it selects (`#selectFromHandle`): a read-only
    // Shift+click, whose range across blocks is promoted at the release,
    // brought the block it began in back into view, 567px under the
    // pointer. A key or the API reveals the block the range takes in, its focus
    // end (`show`).
    if (release && this.#releaseLeavesOut(selection, ids, release.pressed, from)) {
      const kept = ids.slice(0, -1);

      if (kept.length > 1) {
        this.#setBlockSelection(kept, from, { reveal: false });
        return true;
      }

      if (this.#releaseWithin(selection, kept[0]!, from)) {
        return true;
      }
      // Left with nothing of the block's text selected, the block is not
      // left out: a click at the end of b's text and a Shift+click beside
      // c make a range from b's end to c's start, which holds no character
      // of either, and written into b it selected nothing (R14-RV7-1); the
      // reader's Shift+click across the edge selects both, as round 13 did.
    }

    this.#setBlockSelection(ids, from, release === undefined ? { show: to } : { reveal: false });
    return true;
  }

  /**
   * Whether the last block a pointer gesture's range reaches is out of it,
   * read at the release (`#promoteCrossBlockSelection`).
   *
   * A block the range reaches only at the start of its text, no character
   * of it selected, is not in it: Chromium and WebKit end a read-only
   * triple-click's paragraph at offset 0 of the next block, and "b,c" was
   * selected for a click on b -- Mod+C copied both -- where Firefox and an
   * editable view select b's text (R14-RV4-B1). The start of a table's text
   * is its first cell's, but it has text if any cell does: asked of that
   * cell alone, a table whose first cell is empty kept "b,c". A block with
   * no text at all -- an empty paragraph, a divider, a picture with no
   * caption -- is reached only at its start by the same triple-click, which
   * ends the paragraph exactly where a Shift+click beside that block ends;
   * only the gesture tells them apart, so such a block is in the range when
   * the gesture was pressed on it (R14-RV5-3: the triple-click copied
   * "Block B" with an empty line, "---" or "![grey]()"), or when the
   * selection began on it (`from`: a click on it, then a Shift+click back
   * into the block before, R14-RV8-1). Where no press in a block says
   * (`pressed` absent: a press beside every block, by touch, or a drag a
   * peer's update or Escape ended), it stays.
   */
  #releaseLeavesOut(
    selection: { range: Range },
    ids: readonly string[],
    pressed: string | undefined,
    from: string,
  ): boolean {
    const lastId = ids.at(-1)!;
    const lastView = this.#renderer.getView(lastId);
    const lastHosts = lastView?.cells?.flat() ?? (lastView?.content ? [lastView.content] : []);
    const lastHost = lastHosts[0];

    if (lastHost && lastHosts.some((host) => (host.textContent ?? '').length > 0)) {
      const reached = selection.range.cloneRange();
      reached.setStart(lastHost, 0);

      return reached.toString().length === 0;
    }

    return pressed !== undefined && pressed !== lastId && from !== lastId;
  }

  /**
   * A released range left with one block (`#releaseLeavesOut`) is that
   * block's own, from where it starts to the end of the text it starts in,
   * as Firefox and an editable view draw it -- a table cell's, for a table:
   * a block id does not name an editable host, and read as the block's
   * first cell, WebKit's triple-click in the last cell, "b3", before the
   * next block was written as a caret in "H1" (R14-RV5-4). The block left
   * is the one the range starts in: the range's start is one of its ends,
   * and the earlier. Answers false where that leaves nothing of the block
   * selected, and writes nothing.
   */
  #releaseWithin(selection: { range: Range }, id: string, from: string): boolean {
    const { range } = selection;
    const start = range.startContainer;
    const view = this.#renderer.getView(id);
    const hosts = view?.cells?.flat() ?? (view?.content ? [view.content] : []);
    // A start in no host -- below a table's grid, beside it, between its
    // cells -- is beside one: the last host that ends before it, from its
    // end, else the first, from its start. Read as the first cell, a click
    // below the grid and a Shift+click beside the next block wrote a range
    // over "H1", which Mod+C copied (R14-RV7-2).
    const before = hosts
      .filter((host) => range.comparePoint(host, host.childNodes.length) < 0)
      .at(-1);
    const target = this.#resolve(start) ?? this.#resolve(before ?? hosts[0] ?? null);

    if (!target) {
      return false;
    }

    const host = target.content;

    // A range from a cell that runs on over cells after it with text is
    // the table's, not that cell's: written into the cell it starts in up
    // to the cell's end, a click in "H2" and a Shift+click beside the next
    // block were cut to "2" (R14-RV6-2). Only a range that holds nothing
    // after its start cell -- the last cell, or cells after it with no
    // text -- is the cell's own. The cells after it are wholly in the
    // range, whose end is past the table.
    if (
      hosts.some(
        (cell) =>
          cell !== host && range.intersectsNode(cell) && (cell.textContent ?? '').length > 0,
      )
    ) {
      this.#setBlockSelection([id], from, { reveal: false });
      return true;
    }

    const end = richToPlainText(this.#contentOf(target)).length;
    const offset = host.contains(start)
      ? (offsetWithin(host, start, range.startOffset) ?? 0)
      : host === before
        ? end
        : 0;

    if (offset >= end) {
      return false;
    }

    // Backward when the press was in the block left out.
    setSelectionRange(host, offset, end, from !== id);
    return true;
  }

  #restoreSelection(snapshot: SelectionSnapshot | null): boolean {
    // The block may not exist in the restored document.
    if (!snapshot || !findBlock(this.#blocks, snapshot.blockId)) {
      return false;
    }

    return this.#placeRange(
      snapshot.blockId,
      snapshot.start,
      snapshot.end,
      snapshot.cell,
      snapshot.backward === true,
    );
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
    // The payload is a deep copy of the whole document, made on every
    // keystroke; with nobody listening it was pure cost.
    if (!this.#emitter.has('change')) {
      return;
    }

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
    // Content equal to what the host already holds is not an edit. The pure
    // rich-text ops hand back fresh run arrays even then -- re-applying the
    // link already on a range, the same TeX applied again, bold toggled over a
    // lone formula, which takes no marks -- and `sameBlocks` compares blocks,
    // so without this an undo step and a `change` were banked for a document
    // nobody touched. Compared here, as `#syncFromDom` compares.
    if (richEquals(this.#contentOf(target), content)) {
      return;
    }

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

  /**
   * Puts the caret back in the host the reader is typing in, without
   * revealing the host: a key that deletes or retypes a character in place
   * leaves the page where it was, as the browser's own edit there did. The
   * host already holds focus; `focusRange` would scroll a block taller than
   * the window to line it up.
   */
  #caretInPlace(target: ResolvedTarget, offset: number): void {
    const host = this.#hostFor(target.block.id, target.cell);

    if (host) {
      setSelectionRange(host, offset, offset);
    }
  }

  /** Restores a selection to whichever host it came from. */
  #focusResolved(
    target: ResolvedTarget,
    start: number,
    end = start,
    backward = false,
    reveal = true,
  ): void {
    this.#placeRange(target.block.id, start, end, target.cell, backward, reveal);
  }

  /**
   * Puts the caret at `offset`, just after a line break the editor wrote into
   * the model itself -- Enter in a table cell or a code block, Shift+Enter --
   * and shows the line it opened.
   *
   * `#placeRange` reveals the whole host, which is right for a host that
   * fits on screen and wrong for one taller than what it is seen in
   * (`#tallerThanBand`): `block: 'nearest'` does nothing for an element that
   * covers the window, so Enter on the window's last line left the new line
   * below it, and with the host's top on screen it lined that top up instead,
   * scrolling the page by the host's offset. There the caret's own box is
   * brought into view (`#revealBox`), with room over it for the table toolbar
   * that is drawn above a caret in a tall row (`#tableToolbarAnchor`).
   */
  #placeAfterBreak(id: string, offset: number, cell?: CellCoords): void {
    const host = this.#hostFor(id, cell);

    if (!host || !this.#tallerThanBand(host)) {
      this.#placeRange(id, offset, offset, cell);
      return;
    }

    // `#placeRange`, but for its reveal.
    this.#goal = null;

    if (!this.#placeFocus(host)) {
      return;
    }

    this.#clearBlockSelection();
    setSelectionRange(host, offset, offset);

    const box = this.#selectionRectIn(host);

    if (box) {
      this.#revealBox(host, box, cell ? this.#tableToolbarRoom : 0);
    }
  }

  /**
   * The editable host the selection sits in, when both ends share one.
   *
   * `backward` says the reader made it from the end towards the start, which a
   * restore has to repeat: an `OffsetRange` is start-to-end either way.
   */
  #selectionTarget(): (ResolvedTarget & { range: OffsetRange; backward: boolean }) | null {
    // Read through the shadow boundary where the browser retargets it.
    const selection = readSelection(this.#root);

    if (!selection) {
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
    const ends = range ? getSelectionEnds(resolved.content) : null;

    return range
      ? { ...resolved, range, backward: ends !== null && ends.focus < ends.anchor }
      : null;
  }

  /**
   * The selection for the tree this editor is mounted in, for writing to.
   *
   * Reads go through `readSelection` instead, which sees through a shadow
   * root -- Safari's document selection reports the host, not the caret.
   */
  #selection(): TreeSelection | null {
    return selectionFor(this.#root);
  }

  #selectionRect(): DOMRect | null {
    const selection = readSelection(this.#root);

    if (!selection) {
      return null;
    }

    const rect = selection.range.getBoundingClientRect();

    return rect.width > 0 || rect.height > 0 ? rect : null;
  }

  #syncToolbar(): void {
    if (this.#linkEditor.isOpen || this.#mathEditor.isOpen) {
      return;
    }

    // Someone is operating the table toolbar F10 drew: the range left in the
    // cell -- Chromium keeps it, and its selectionchange for a Tab's
    // whole-cell selection can arrive after F10 -- draws no format toolbar
    // over it.
    if (this.#tableToolbar.isOpen && holdsFocus(this.#tableToolbar.element)) {
      this.#toolbar.hide();
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

    // Only while the range's host holds focus, as `#syncTableToolbar` asks. A
    // range can be put in a host from outside it: Firefox's Quick Find
    // selects its match in the text while focus stays in the find bar, and
    // the toolbar was drawn over the page for a selection the reader was not
    // editing. Its buttons keep focus where it is (the portal cancels the
    // mousedown), so the editor's own commands still find the host focused.
    if (
      !target ||
      !this.#editable ||
      target.range.start === target.range.end ||
      !holdsOwnFocus(target.content)
    ) {
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

    // Nothing on it applies to a code block or an equation, whose text is
    // literal, nor to a selection of formulas alone, which take no marks or
    // links: every button would be a no-op.
    if (
      isLiteralType(target.block.type) ||
      richSlice(content, range.start, range.end).every(isMathRun)
    ) {
      this.#toolbar.hide();
      this.#syncTableToolbar();
      return;
    }

    // One toolbar for a range, in every engine: the table toolbar is the
    // caret's (`#syncTableToolbar` refuses while this one is open), and F10
    // is the keyboard's way to it from a range. Left to the order of the
    // selection events, a drag in a cell drew both in Firefox and WebKit --
    // the caret's `selectionchange` first -- and only this one in Chromium.
    this.#hideTableToolbar();
    this.#syncPortalDirection();
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
    // Not while composing: the entry belongs to the finished candidate, and
    // `#handleCompositionEnd` records it once against the state the
    // composition started from.
    if (event && !this.#composing && !richEquals(this.#contentOf(resolved), parsed)) {
      this.#recordHistory(inputRunKey(event, hostScope(id, cell)), this.#selectionBeforeInput);
    }

    this.#writeContent(resolved, parsed);

    return parsed;
  }

  /**
   * Writes content into the model and tells the renderer the DOM already has it.
   *
   * Deliberately not `#commit`: the DOM is ahead on these paths, so re-rendering
   * would drop the caret the browser just placed.
   */
  #writeContent(resolved: ResolvedTarget, content: RichText): void {
    const { cell } = resolved;
    const id = resolved.block.id;

    if (cell) {
      const rows = tableSetCell(
        findBlock(this.#blocks, id)?.rows ?? resolved.block.rows ?? [],
        cell.row,
        cell.column,
        content,
      );
      this.#blocks = updateBlock(this.#blocks, id, { rows });
      this.#renderer.syncCellFromDom(id, cell.row, cell.column, content);
    } else {
      this.#blocks = updateBlock(this.#blocks, id, { content });
      this.#renderer.syncFromDom(id, content);
    }
  }

  /**
   * Forgets an in-flight composition, because its host is about to go away.
   *
   * `#composing` had exactly one clearing site: the `compositionend` listener
   * on the root. Anything that re-renders detaches the host the composition
   * lived in, so that event never arrives -- and the flag gates `#handleInput`
   * and `#handleKeyDown`, so the editor went keyboard-inert for good. Plain
   * characters still appeared, because the browser writes them itself and the
   * DOM is read back, so the document kept saving while Enter, Backspace, Tab,
   * Escape and every shortcut did nothing.
   */
  #endComposition(): void {
    // Only if the host it lives in is really gone. A render that reuses the
    // element -- the same block id, the common case for a revision reload --
    // leaves the composition running and its `compositionend` still able to
    // reach the listener on the root; clearing regardless meant the browser's
    // later candidate rewrites arrived looking like committed input.
    const composition = this.#composition;

    if (composition && this.#root.contains(composition.host)) {
      // The browser is still composing into an element that survived, so the
      // flag has to stay -- but `content` and `selection` describe the document
      // that was just replaced. Kept, they became the history entry
      // `#handleCompositionEnd` records, restoring blocks the user never saw.
      // Re-anchored to what is there now instead.
      const target = this.#resolve(composition.host);

      this.#composition = target
        ? {
            host: composition.host,
            content: this.#contentOf(target),
            selection: this.#selectionSnapshot(),
            offset: getSelectionRange(target.content)?.start ?? 0,
            pending: null,
            formatting: null,
          }
        : null;
      this.#composing = this.#composition !== null;

      return;
    }

    this.#composing = false;
    this.#composition = null;
  }

  /**
   * Brings a block into view, and only if it is not already there.
   *
   * `preventScroll: true` on every `focus()` is deliberate -- letting the
   * browser choose what to scroll moves the wrong container, and on a mount
   * inside a pane it moves the page. But nothing then scrolled anything, so
   * `editor.focus(id)` on an off-screen block was a no-op the user could see
   * nothing of, and arrowing a block selection walked it off the screen.
   * `block: 'nearest'` scrolls the least it can and does nothing at all when
   * the element is already fully visible, which is what makes it safe to call
   * on every focus rather than only the programmatic ones.
   */
  #reveal(element: Element | null | undefined): void {
    element?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  /**
   * Brings `element` -- or `part`, a box inside it, where the element is too
   * tall to be centred whole -- to the middle of the scroller nearest it that
   * clips it (`clipChainOf`), that one only, and then the least of everything
   * around it into view.
   *
   * `scrollIntoView({ block: 'center' })` centres in every ancestor at once,
   * so a scroller that was wholly on screen still made the page jump, and
   * the page around an iframe with it. Measured instead: the scroller's
   * offset is set from the element's distance to its middle. A scroller
   * with `scroll-behavior: smooth` is still on its way when this returns,
   * and revealing the element then would measure where it is leaving and
   * overrule the animation; the scroller itself is revealed instead. So is
   * it after `part` is centred: revealing the element would line its edge
   * up with the scroller's and take `part` away again.
   *
   * The scroller is one that clips the element, as `#onScreen` measures it.
   * Inside a fixed panel that does not scroll itself, the nearest scroller
   * of all was the pane behind it, which moved while the cell stayed where
   * it was; with nothing between the element and the window that can move
   * it, it is only revealed, and the page is not scrolled under it.
   */
  #centreInScroller(element: HTMLElement, part: ScreenBox | null = null): void {
    const doc = element.ownerDocument;
    const page = doc.scrollingElement;
    const { scrollers, pinned } = clipChainOf(element);
    const scroller = scrollers[0] ?? (pinned ? null : page);

    if (!scroller) {
      this.#reveal(element);
      return;
    }

    const isPage = scroller === page;
    const box = scroller.getBoundingClientRect();
    const clipTop = isPage ? 0 : box.top + scroller.clientTop;
    const clipHeight = isPage
      ? (doc.defaultView?.innerHeight ?? scroller.clientHeight)
      : scroller.clientHeight;
    const rect = part ?? element.getBoundingClientRect();
    const wanted = scroller.scrollTop + (rect.top + rect.height / 2) - (clipTop + clipHeight / 2);
    const target = Math.min(
      Math.max(wanted, 0),
      Math.max(scroller.scrollHeight - scroller.clientHeight, 0),
    );

    scroller.scrollTop = target;

    const landed = Math.abs(scroller.scrollTop - target) < 1;

    this.#reveal(landed && !part ? element : isPage ? frameElementOf(doc.defaultView) : scroller);
  }

  /**
   * Scrolls the least that brings `box` -- a caret's line in `host` -- into
   * view, with `above` pixels clear over it: what `scrollIntoView({ block:
   * 'nearest' })` does for an element, for a box that is not one. Each
   * scroller that clips `host` (`clipChainOf`), nearest first, then its page
   * -- unless the chain ended at an element drawn against the window, which
   * no page scroll moves -- and the same outward through the same-origin
   * frames around an iframe mount, the box carried into each outer window at
   * the scale its frame is drawn at (`frameMapping`; under `scale(0.5)` the
   * unscaled offset scrolled the page ~590px for a line already on screen),
   * and stopping at a frame that cannot be read exactly. A scroller still easing towards its
   * target (`scroll-behavior: smooth`) ends it: an outer one would measure
   * the box mid-way.
   */
  #revealBox(host: HTMLElement, box: ScreenBox, above = 0): void {
    let element: Element = host;
    let top = box.top;
    let bottom = box.bottom;

    for (;;) {
      const doc = element.ownerDocument;
      const view = doc.defaultView;
      const page = doc.scrollingElement;
      const { scrollers, pinned } = clipChainOf(element);

      for (const scroller of pinned || !page ? scrollers : [...scrollers, page]) {
        // A scroller's own box as it is drawn (`drawnClientBox`): measured
        // in its layout pixels, a pane drawn at 1.5 counted its lower third
        // as out of sight, and a press beside the text there scrolled it 62
        // and 134px for a caret that was on screen (R14-RV3-5).
        const client = scroller === page ? null : drawnClientBox(scroller as HTMLElement);
        const scale = client?.scale ?? 1;
        const viewTop = client ? client.top : (view?.visualViewport?.offsetTop ?? 0);
        const viewBottom = client
          ? client.bottom
          : viewTop + (view?.visualViewport?.height ?? view?.innerHeight ?? 0);
        // Whole pixels, rounded away from the box: a scroll offset is
        // rounded, and WebKit left a line 0.4px below the window. Measured
        // as drawn, and scrolled in the scroller's own pixels.
        let delta = bottom > viewBottom ? Math.ceil((bottom - viewBottom) / scale) : 0;

        if (top - delta * scale - above < viewTop) {
          delta = Math.floor((top - above - viewTop) / scale);
        }

        if (delta === 0) {
          continue;
        }

        const before = scroller.scrollTop;
        const target = Math.min(
          Math.max(before + delta, 0),
          Math.max(scroller.scrollHeight - scroller.clientHeight, 0),
        );

        scroller.scrollTop = target;
        top -= (scroller.scrollTop - before) * scale;
        bottom -= (scroller.scrollTop - before) * scale;

        if (Math.abs(scroller.scrollTop - target) >= 1) {
          return;
        }
      }

      const frame = frameElementOf(view);
      const mapping = frame ? frameMapping(frame, view) : null;

      // Into the window around the frame, at the scale it is drawn at; one
      // that cannot be read exactly is not scrolled by a guess.
      if (!frame || !mapping) {
        return;
      }

      top = top * mapping.scale + mapping.offset;
      bottom = bottom * mapping.scale + mapping.offset;
      above *= mapping.scale;
      element = frame;
    }
  }

  /**
   * Whether any of an element is still on screen: inside the window and
   * inside every scroller that clips the editor (`#visibleBand`), which is
   * how `#tableToolbarAnchor` measures what is shown. Asking only the nearest
   * scroller kept the table toolbar drawn over the host page once an outer
   * scroller had taken its cell out of sight; asking every scroller around
   * the editor clipped a fixed sheet or a modal dialog by the pane they were
   * declared in, which does not clip them.
   */
  #onScreen(element: Element): boolean {
    return element.isConnected && this.#rectOnScreen(element.getBoundingClientRect());
  }

  /** Whether all of an element is on screen, by the same measure as `#onScreen`. */
  #whollyOnScreen(element: Element): boolean {
    return element.isConnected && this.#rectWhollyOnScreen(element.getBoundingClientRect());
  }

  /** Whether any of a box is on screen, by the same measure as `#onScreen`. */
  #rectOnScreen(rect: Pick<DOMRect, 'top' | 'bottom'>): boolean {
    const { top, bottom } = this.#visibleBand();

    return rect.bottom > top && rect.top < bottom;
  }

  /** Whether all of a box is on screen, by the same measure as `#onScreen`. */
  #rectWhollyOnScreen(rect: Pick<DOMRect, 'top' | 'bottom'>): boolean {
    const { top, bottom } = this.#visibleBand();

    return rect.top >= top && rect.bottom <= bottom;
  }

  /**
   * Whether the caret or range in `host` is on screen -- the text the format
   * toolbar and the slash menu describe, not the block it is in. Judged by
   * the block, a paragraph taller than the window held them clamped at the
   * window's edge long after their text had scrolled away. A host with no
   * box for its selection (an empty block, a selection elsewhere) is judged
   * by its own.
   */
  #selectionOnScreen(host: HTMLElement): boolean {
    return (
      host.isConnected &&
      this.#rectOnScreen(this.#selectionRectIn(host) ?? host.getBoundingClientRect())
    );
  }

  /** The box of the selection when both its ends are in `host`, as `#selectionRect` measures it. */
  #selectionRectIn(host: HTMLElement): ScreenBox | null {
    const selection = this.#selectionIn(host);

    return selection ? selectionBox(host, selection.range) : null;
  }

  /** The selection, when both its ends are in `host`. */
  #selectionIn(host: HTMLElement): SelectionReading | null {
    const selection = readSelection(this.#root);

    return selection &&
      host.contains(selection.range.startContainer) &&
      host.contains(selection.range.endContainer)
      ? selection
      : null;
  }

  /**
   * What the table toolbar stands beside in a row taller than what is shown:
   * the selection in `cell` -- a caret, measured from its neighbours on an
   * empty line and by both of its lines at a soft wrap (`selectionBox`), or
   * a range that fits in `shown` pixels -- and for a range taller than that,
   * its focus end, the part the reader is working at.
   */
  #anchorBoxIn(cell: HTMLElement, shown: number): ScreenBox | null {
    const box = this.#selectionRectIn(cell);

    return box && box.height > shown ? this.#focusBoxIn(cell) : box;
  }

  /**
   * The box of the focus end of the selection in `host` -- where the reader
   * was extending it -- measured as `selectionBox` measures a caret.
   */
  #focusBoxIn(host: HTMLElement): ScreenBox | null {
    const selection = this.#selectionIn(host);

    if (!selection) {
      return null;
    }

    const focus = host.ownerDocument.createRange();

    focus.setStart(selection.focusNode, selection.focusOffset);

    return selectionBox(host, focus);
  }

  /**
   * In a host taller than the visible band, which is never wholly on screen,
   * what to judge instead: the selection. `undefined` when the host fits and
   * is judged whole. Otherwise `box` is what to bring to the middle of its
   * scroller, or null when nothing has to move: a caret wholly on screen, a
   * range any of which is (a range taller than the window is never wholly on
   * screen either, and centring it whole put its focus end below the
   * window), or a selection with nothing to measure -- never the whole host,
   * whose middle is no place the reader was. A range off screen is brought
   * back by its focus end.
   *
   * Asked only from keys -- F10 and the Escape back from its toolbar -- so a
   * caret at a soft wrap is judged by the line it is drawn on, which the
   * browser is asked here and nowhere else outside the arrow keys
   * (`softWrapLine`): judged by either line, a caret drawn on the one just
   * out of sight was never brought back while the other showed. Its move
   * away and back is harmless on these keys, which restore the selection
   * and scroll to it anyway. Where the browser cannot say, either line on
   * screen will do (`selectionBoxes`).
   */
  #tallSelectionView(
    host: HTMLElement,
  ): { box: ScreenBox | null; side: 'upper' | 'lower' | null } | undefined {
    if (!this.#tallerThanBand(host)) {
      return undefined;
    }

    // Asked before anything is measured: Firefox's move scrolls the caret
    // into view.
    const ends = getSelectionEnds(host);
    const side = ends && ends.anchor === ends.focus ? softWrapLine(host, ends.focus) : null;
    const selection = this.#selectionIn(host);

    if (!selection) {
      return { box: null, side };
    }

    if (selection.isCollapsed) {
      const both = selectionBoxes(host, selection.range);
      const boxes = both.length === 2 && side ? [side === 'upper' ? both[0]! : both[1]!] : both;

      return {
        box: boxes.some((box) => this.#rectWhollyOnScreen(box)) ? null : spanOf(boxes),
        side,
      };
    }

    if (this.#rectOnScreen(selection.range.getBoundingClientRect())) {
      return { box: null, side };
    }

    return { box: this.#focusBoxIn(host), side };
  }

  /** Whether `host` is taller than the part of the window it can be seen in (`#visibleBand`). */
  #tallerThanBand(host: HTMLElement): boolean {
    const band = this.#visibleBand();

    return host.getBoundingClientRect().height > band.bottom - band.top;
  }

  /**
   * Brings the selection in `host` into view the way F10 and the Escape back
   * from its toolbar both judge it: in a host taller than the visible band,
   * by the selection (`#tallSelectionView`), centred only when it is off
   * screen; otherwise by `whole`, the caller's own rule for the host.
   * Answers the line of a wrap the caret was found drawn on, where that was
   * asked (in a tall host only).
   */
  #showSelectionOrHost(host: HTMLElement, whole: () => void): 'upper' | 'lower' | null {
    const tall = this.#tallSelectionView(host);

    if (!tall) {
      whole();
      return null;
    }

    if (tall.box) {
      this.#centreInScroller(host, tall.box);
    }

    return tall.side;
  }

  /**
   * Answers the ground moving under the floating UI.
   *
   * Portals are `position: fixed` and are given viewport coordinates when they
   * open, so after a scroll or resize they sat over whatever had moved under
   * them -- still live, still acting on the block they were opened from. The
   * slash menu and the format toolbar describe a caret position, so they are
   * moved to where the caret is now, and dismissed only once it has left the
   * screen. A dialog the user is typing into follows its anchor too (see
   * below), and the table toolbar is re-placed against its table: it was moved
   * only on `selectionchange`, which a scroll never fires. Browsers deliver
   * `scroll` at most once a frame, so that is one layout pass per frame.
   */
  #handleViewportChange = (event: Event): void => {
    if (this.#destroyed) {
      return;
    }

    // A scroll *inside* one of these is the popover doing its own work -- the
    // slash menu scrolls its option list to keep the active item in view, and
    // dismissing on that closed the menu as soon as the user arrowed past the
    // fold. Only a scroll of the ground underneath counts.
    // The portal element, not the container it was appended to: that container
    // defaults to the mount's root node, which for an ordinary mount is
    // `document.body` -- so testing it swallowed every scroll on the page.
    // Duck-typed: in an iframe mount the target belongs to another realm's
    // `Element`, and `instanceof` read every scroll there as the ground's --
    // scrolling a wide formula in the equation popover's preview closed the
    // popover.
    const target = asElement(event.target);

    if (target?.closest('.neditor-portal')) {
      return;
    }

    // The slash menu and the format toolbar describe the caret, so they follow
    // it. Dismissing them instead lost the menu to the browser's own
    // scroll-into-view of the caret -- a few pixels, a frame after the `/` --
    // before anyone saw it, leaving the query as literal text; nothing reopens
    // it. In WebKit the scroll a Shift+End brings arrives after the
    // `selectionchange` that showed the toolbar, which it then hid for good.
    // Only a caret or range that has left the screen takes them with it --
    // the text itself, not its block, which can be taller than the window.
    const slashHost = this.#slashContext
      ? this.#renderer.getView(this.#slashContext.blockId)?.content
      : null;

    if (this.#slashMenu.isOpen) {
      if (slashHost && this.#selectionOnScreen(slashHost)) {
        this.#slashMenu.reposition(this.#selectionRect() ?? slashHost.getBoundingClientRect());
      } else {
        this.#closeSlashMenu();
      }
    }

    // Only one already showing: a toolbar Escape dismissed stays dismissed.
    if (this.#toolbar.isOpen) {
      const target = this.#selectionTarget();

      if (target && this.#selectionOnScreen(target.content)) {
        this.#syncToolbar();
      } else {
        this.#toolbar.hide();
      }
    }

    // And one the scroll took away comes back with its cell, while the caret
    // is still in it (`#syncTableToolbar` asks that afresh).
    if (this.#tableToolbar.isOpen || this.#tableToolbarScrolledAway) {
      this.#syncTableToolbar();
    }

    // The dialogs take focus, and one that holds it is being typed into.
    // Dismissing it handed focus back to the block it came from mid-word, so
    // the rest of a URL went into the document -- and a resize is what an
    // opening software keyboard looks like, so on a phone a dialog closed the
    // moment its own input was focused. It moves with its anchor instead. One
    // the user has left is dismissed as before, but focus stays wherever they
    // took it: a scroll is not a choice of where to go.
    for (const [dialog, close] of [
      [this.#linkEditor, (restore: boolean) => this.#closeLinkEditor(restore)],
      [this.#imageEditor, (restore: boolean) => this.#closeImageEditor(restore)],
      [this.#iconPicker, (restore: boolean) => this.#closeIconPicker(restore)],
    ] as const) {
      if (!dialog.isOpen) {
        continue;
      }

      if (!dialog.hasFocus) {
        close(false);
      } else if (!dialog.reposition()) {
        // Its anchor is gone. Hiding a dialog that holds focus would drop
        // focus on the body, so hand it back to the block if there is one.
        close(true);
      }
    }

    // The math editor has no anchor to follow, and closes as it always did.
    if (this.#mathEditor.isOpen) {
      this.#closeMathEditor();
    }
  };

  #handleCompositionStart = (event: CompositionEvent): void => {
    this.#composing = true;

    const resolved = this.#resolve(event.target);
    const range = resolved ? getSelectionRange(resolved.content) : null;
    // The candidate is the next thing typed at this caret, so a link
    // continuation waiting here passes to it. Taken now: the composition's
    // first `beforeinput` would end it.
    const continuing = this.#typingOver;
    this.#typingOver = null;

    this.#composition = resolved
      ? {
          host: resolved.content,
          content: this.#contentOf(resolved),
          // The live selection, not `#selectionBeforeInput`. That field holds
          // the selection as it stood before the *previous* input event, so
          // undoing a composed word put the caret back in whatever block or
          // cell had been edited before it -- and the next keystrokes landed
          // there.
          selection: this.#selectionSnapshot(),
          offset: range?.start ?? 0,
          pending: this.#pending,
          formatting: range ? this.#replacementFormatting(resolved, range, continuing) : null,
        }
      : null;
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

    const composition = this.#composition;
    this.#composition = null;
    const resolved = this.#resolve(event.target);

    if (!resolved || !this.#editable) {
      return;
    }

    // One undoable edit for the whole candidate, recorded against the content
    // as it stood before any of it was typed -- so undo takes back the word,
    // and a cancelled candidate, which ends where it began, records nothing.
    //
    // `#blocks` already holds the last intermediate candidate, written by the
    // per-rewrite syncs that deliberately recorded nothing. It is put back to
    // where the composition started first, or the entry would record the
    // half-composed text as the state to return to.
    if (composition && !richEquals(composition.content, parseRichText(resolved.content))) {
      this.#writeContent(resolved, composition.content);
      this.#recordHistory(
        `insert:${hostScope(resolved.block.id, resolved.cell)}`,
        composition.selection,
      );
    }

    const parsed = this.#syncFromDom(resolved);
    this.#formatComposed(resolved, composition, parsed);

    // An open slash menu narrows on what was typed, and a composed query is
    // typed too. `#handleInput` stands down while composing, so without this
    // the menu never heard `/引用` and Enter applied its unfiltered first
    // command -- deleting the query the user had just composed.
    if (!resolved.cell && this.#slashContext?.blockId === resolved.block.id) {
      const caret = getCaretOffset(resolved.content);

      this.#updateSlashQuery(richToPlainText(parsed).slice(0, caret), caret);
    }

    // A cancelled candidate ends where it began: no edit, so no `change`.
    // Judged by the block as it stands now -- `resolved.block` was captured
    // before the sync above, so it still held the last intermediate candidate.
    const committed = {
      ...resolved,
      block: findBlock(this.#blocks, resolved.block.id) ?? resolved.block,
    };

    if (!composition || !richEquals(composition.content, this.#contentOf(committed))) {
      this.#emitChange();
    }
  };

  /**
   * Gives a composed word the formatting a typed one would have had.
   *
   * `#handleBeforeInput` writes typed text itself -- with the armed marks, or
   * over a selection or a link continuation (`#typeOver`) -- and prevents the
   * default. A composition cannot be handled that way -- cancelling it would
   * break the IME -- so the formatting is applied afterwards, over the range
   * the composition actually filled. Without it a word composed over a link's
   * whole text dropped the link, and one composed after a typed-over link
   * landed outside it while Latin keys joined it.
   */
  #formatComposed(
    resolved: ResolvedTarget,
    composition: CompositionState | null,
    parsed: RichText,
  ): void {
    if (!composition) {
      return;
    }

    const { pending, formatting, offset } = composition;
    const armed =
      pending !== null &&
      pending.blockId === resolved.block.id &&
      sameCell(resolved.cell, pending.cell);
    const replaced = !armed && formatting !== null && composition.host === resolved.content;

    if (!armed && !replaced) {
      return;
    }

    const end = getSelectionRange(resolved.content)?.end ?? offset;

    if (end <= offset) {
      return;
    }

    let next = parsed;

    if (armed) {
      for (const mark of pending.marks) {
        next = richSetMark(next, offset, end, mark, true);
      }

      this.#pending = null;
    } else if (formatting) {
      // Rewritten, not marked: the browser's own choice of formatting for the
      // candidate is exactly what `#typeOver` exists to overrule.
      next = richInsert(
        richDelete(parsed, offset, end),
        offset,
        richFromPlainText(
          richToPlainText(richSlice(parsed, offset, end)),
          formatting.marks,
          formatting.link,
        ),
      );
    }

    if (!richEquals(next, parsed)) {
      // Into the model only, then a real render. Not `#writeContent`: that
      // exists for the paths where the browser has already edited the DOM, and
      // it tells the renderer so by setting the content key -- which made the
      // very next `#render()` skip the block and leave the marks painted
      // nowhere. And not `#commitResolved` either: `#handleCompositionEnd` has
      // already recorded the one history entry this word gets, and committing
      // again banked a second whose first undo showed the word with its
      // formatting stripped.
      this.#blocks = resolved.cell
        ? updateBlock(this.#blocks, resolved.block.id, {
            rows: tableSetCell(
              findBlock(this.#blocks, resolved.block.id)?.rows ?? [],
              resolved.cell.row,
              resolved.cell.column,
              next,
            ),
          })
        : updateBlock(this.#blocks, resolved.block.id, { content: next });
      this.#render();
      this.#focusResolved(resolved, end);
    }

    // The candidate's end is a link's end now, where the next typed character
    // would land outside it: the continuation moves on to here.
    const link = replaced ? formatting?.link : undefined;
    const target = link ? this.#targetFor(resolved.block.id, resolved.cell) : null;

    if (link && target) {
      this.#continueTypingOver(target, end, formatting?.marks, link);
    }
  }

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

    // The take-back first: it is asked of every input, since any input but
    // the digit straight after a rule's formula leaves that formula standing.
    if (this.#takeBackFormula(event) || this.#typeOver(event) || this.#deleteFormula(event)) {
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

  /**
   * A character typed over a text range inside one host, written model-first.
   *
   * Each engine replaces a selection by its own rules for whose formatting the
   * new text inherits, and none of them is the editor's: over exactly the text
   * of a link, Chromium and WebKit kept the link for the first character only
   * and Firefox dropped it altogether. The replacement takes the marks and the
   * link of the first character it replaces, as typing inside a run does.
   * Composition is never taken over -- cancelling it breaks the IME -- so the
   * same formatting is applied to a composed word when it ends instead
   * (`#formatComposed`). A collapsed caret is left to the browser, which is
   * what keeps IME, autocorrect and spellcheck working everywhere else, except
   * at the one caret a link continuation is waiting at (`#typingOver`).
   */
  #typeOver(event: InputEvent): boolean {
    const continuing = this.#typingOver;
    this.#typingOver = null;

    if (
      event.inputType !== 'insertText' ||
      typeof event.data !== 'string' ||
      event.data.length === 0 ||
      event.isComposing ||
      this.#composing
    ) {
      return false;
    }

    const resolved = this.#resolve(event.target);
    const range = resolved ? getSelectionRange(resolved.content) : null;

    if (!resolved || !range) {
      return false;
    }

    const current = this.#contentOf(resolved);
    const formatting = this.#replacementFormatting(resolved, range, continuing);

    if (!formatting) {
      return false;
    }

    event.preventDefault();

    const caret = range.start + event.data.length;
    const next = richInsert(
      richDelete(current, range.start, range.end),
      range.start,
      richFromPlainText(event.data, formatting.marks, formatting.link),
    );

    this.#commitResolved(
      resolved,
      next,
      `insert:${hostScope(resolved.block.id, resolved.cell)}`,
      this.#selectionBeforeInput,
    );
    this.#focusResolved(resolved, caret);

    const target = this.#targetFor(resolved.block.id, resolved.cell);

    if (!target) {
      return true;
    }

    // The replacement is a link now, and the caret sits at that link's end --
    // where every engine types *outside* the anchor, so `docs` typed over as
    // `XYZ` became a one-letter link. What is typed next, from exactly here
    // and into exactly this text, joins it, as it does in Google Docs; see
    // `#typingOver` for everything that ends it. Marks need none of this:
    // each engine already carries them on past the end of a run.
    if (formatting.link) {
      this.#continueTypingOver(target, caret, formatting.marks, formatting.link);
    }

    // What was typed is still typed: the shortcuts get the same chance they
    // get on the browser's path. The commit has already reported the change.
    this.#applyInputRules(target);

    return true;
  }

  /**
   * The formatting text typed at `range` is written in by the editor, or null
   * when the browser is to type it.
   *
   * Over a range: the first replaced character's marks and link. At a
   * collapsed caret: a link continuation's, and only one waiting at exactly
   * this caret in exactly this text (`#typeOver`).
   */
  #replacementFormatting(
    resolved: ResolvedTarget,
    range: { start: number; end: number },
    continuing: TypingOver | null,
  ): Pick<TextRun, 'marks' | 'link'> | null {
    const current = this.#contentOf(resolved);

    if (range.start !== range.end) {
      const first = richSlice(current, range.start, range.start + 1)[0];

      return {
        ...(first?.marks ? { marks: first.marks } : {}),
        ...(first?.link ? { link: first.link } : {}),
      };
    }

    return continuing?.blockId === resolved.block.id &&
      sameCell(continuing.cell, resolved.cell) &&
      continuing.offset === range.start &&
      continuing.content === current
      ? continuing
      : null;
  }

  #continueTypingOver(
    target: ResolvedTarget,
    offset: number,
    marks: Mark[] | undefined,
    link: string,
  ): void {
    this.#typingOver = {
      blockId: target.block.id,
      ...(target.cell ? { cell: target.cell } : {}),
      offset,
      content: this.#contentOf(target),
      ...(marks ? { marks } : {}),
      link,
    };
  }

  /**
   * Where a type-over of a link left the caret; see `#typeOver`.
   *
   * It lasts for exactly the next character typed -- or composed -- at that
   * caret, and every other path ends it: a selection that moves off the
   * offset, a click or a caret key even back onto it, Escape, a blur, a mark
   * toggle (whose armed mark then applies), any other edit, undo and redo,
   * `setDocument`, read-only and `destroy`. The text it remembers is compared
   * by identity as a backstop, so an edit nobody listed still ends it.
   */
  #typingOver: TypingOver | null = null;

  /**
   * Backspace or Delete beside a formula, which goes as one character -- and
   * so does a word deletion there, the formula being the word.
   *
   * Left to the browser, it did -- except after a formula that ends its block,
   * where the caret sits past the separator image (WebKit's click, Chromium's
   * End): the first Backspace deleted the separator, which is no text, so the
   * model did not change, nothing redrew it, and the formula stayed. Firefox's
   * word deletion there deleted nothing at all; Chromium's and WebKit's took
   * the formula alone, which is what this does in every engine. A deletion
   * whose target reaches past the formula -- an IME taking back a suggestion
   * -- is the browser's.
   */
  #deleteFormula(event: InputEvent): boolean {
    const forward =
      event.inputType === 'deleteContentForward' || event.inputType === 'deleteWordForward';
    const backward =
      event.inputType === 'deleteContentBackward' || event.inputType === 'deleteWordBackward';

    if ((!forward && !backward) || this.#composing) {
      return false;
    }

    const resolved = this.#resolve(event.target);
    const range = resolved ? getSelectionRange(resolved.content) : null;

    if (!resolved || !range || range.start !== range.end) {
      return false;
    }

    const start = forward ? range.start : range.start - 1;
    const content = this.#contentOf(resolved);

    if (
      start < 0 ||
      !isMathRun(richSlice(content, start, start + 1)[0]) ||
      this.#targetsPastFormula(event, resolved.content, start)
    ) {
      return false;
    }

    event.preventDefault();
    // In the run the browser's own deletions around it are in, so a held
    // Backspace through text and a formula is still one undo step.
    this.#commitResolved(
      resolved,
      richDelete(content, start, start + 1),
      inputRunKey(event, hostScope(resolved.block.id, resolved.cell)),
      this.#selectionBeforeInput,
    );
    this.#caretInPlace(resolved, start);
    return true;
  }

  /**
   * True when the input's own target ranges reach past the formula at
   * `start`: the browser was asked to delete more than the formula, and knows
   * what. Compared in the model's offsets, not as DOM boundary points: the
   * same characters can be named from the text before the formula or from
   * the host, the separator after it is no offset, and a position inside the
   * formula is its edge.
   */
  #targetsPastFormula(event: InputEvent, host: HTMLElement, start: number): boolean {
    const targets = typeof event.getTargetRanges === 'function' ? event.getTargetRanges() : [];

    return targets.some((target) => {
      if (target.collapsed) {
        return false;
      }

      // Somewhere this host cannot read -- a wrapper's boundary, a range a
      // shadow mount retargeted -- says nothing about this formula, so it is
      // read like no target at all: handed to the browser, the first
      // Backspace past the separator deleted only the separator again.
      if (!host.contains(target.startContainer) || !host.contains(target.endContainer)) {
        return false;
      }

      return (
        offsetAt(host, target.startContainer, target.startOffset, 'start') < start ||
        offsetAt(host, target.endContainer, target.endOffset, 'end') > start + 1
      );
    });
  }

  /**
   * Takes back the formula the `$` rule made a keystroke ago, when that
   * keystroke is a digit: `$5-$` then `1` is a price range, and the reader
   * of the same text never makes a formula of it.
   *
   * Taken back, not edited: history drops the entry the rule recorded, and
   * the text as typed comes back with the digit after it -- so undo never
   * steps through a formula that, as far as the reader is concerned, was never
   * there. Anything at all between the two keystrokes and the formula stays.
   */
  #takeBackFormula(event: InputEvent): boolean {
    const made = this.#ruleFormula;
    this.#ruleFormula = null;

    if (
      !made ||
      this.#composing ||
      event.inputType !== 'insertText' ||
      typeof event.data !== 'string' ||
      !/^[0-9]$/.test(event.data)
    ) {
      return false;
    }

    const resolved = this.#resolve(event.target);
    const range = resolved ? getSelectionRange(resolved.content) : null;

    if (
      !resolved ||
      !range ||
      resolved.block.id !== made.blockId ||
      !sameCell(resolved.cell, made.cell) ||
      range.start !== made.offset + 1 ||
      range.end !== range.start ||
      !isMathRun(richSlice(this.#contentOf(resolved), made.offset, made.offset + 1)[0]) ||
      !this.#history.withdraw(made.before)
    ) {
      return false;
    }

    event.preventDefault();
    this.#pending = null;

    // The dollars come back as they were typed, formatting and all, and the
    // digit takes the formatting of the `$` before it, as typing it there
    // would have: in a bold run, `$5-$1` stays bold.
    const typed = made.before.find((block) => block.id === made.blockId);
    const was = typed
      ? made.cell
        ? (typed.rows?.[made.cell.row]?.[made.cell.column] ?? [])
        : typed.content
      : [];
    const end = made.offset + made.source.length;
    const source = richSlice(was, made.offset, end);
    // A link only where it goes on past the caret: at a link's end every
    // engine types outside the anchor, and so does this.
    const linkAfter = end < richLength(was) ? richLinkAt(was, end) : null;
    const link =
      linkAfter !== null && linkAfter === richLinkAt(was, end - 1) ? linkAfter : undefined;
    const text = richEquals(
      richFromPlainText(richToPlainText(source)),
      richFromPlainText(made.source),
    )
      ? richInsert(
          source,
          made.source.length,
          richFromPlainText(event.data, richMarksAt(was, end), link),
        )
      : richFromPlainText(made.source + event.data);
    const content = richInsert(
      richDelete(this.#contentOf(resolved), made.offset, made.offset + 1),
      made.offset,
      text,
    );
    const rows = resolved.cell
      ? tableSetCell(resolved.block.rows ?? [], resolved.cell.row, resolved.cell.column, content)
      : null;

    // Applied without recording: the entry this edit replaces is the one just
    // withdrawn, and the document before it is still the one undo returns to.
    this.#applyBlocks(updateBlock(this.#blocks, resolved.block.id, rows ? { rows } : { content }));
    this.#emitHistory();
    this.#caretInPlace(resolved, made.offset + richLength(text));
    return true;
  }

  #handleInput = (event: Event): void => {
    const resolved = this.#resolve(event.target);

    if (!resolved || !this.#editable) {
      return;
    }

    const { content } = resolved;
    const id = resolved.block.id;

    // The reader's own edit under a drag the editor is drawing ends that
    // drag (the edit is in the drag's host, where the selection is: no host
    // is asked for), as a letter typed over its range always has (`#typeOver`
    // commits, and `#applyBlocks` ends it): its anchor and the caret it
    // last found are places in the text as it was. A Backspace over the
    // range with the button still down left both, and the next move drew
    // from them -- [18,32] under a bar of the page's, [30,32] in the text,
    // from a caret at 26 (R14-RV1-4). Never the browser's own drag, which
    // keeps its own anchor.
    const drawn = this.#textDrag;

    if (drawn && !drawn.promoted && (drawn.placed || drawn.returned)) {
      this.#endTextDrag();
    }

    // The browser already edited the DOM, so it is the source of truth here.
    // Reading it back keeps IME, autocorrect and spellcheck fixes working.
    const parsed = this.#syncFromDom(resolved, event);
    const block = findBlock(this.#blocks, id);

    if (!block) {
      return;
    }

    const target: ResolvedTarget = { ...resolved, block };

    // Half-composed text is not something to run markdown rules against --
    // nor something to report. Each candidate fired `change`, so an autosave or
    // a collaboration layer persisted and broadcast IME candidates on every
    // word; composition end reports the result once.
    if (this.#composing) {
      return;
    }

    // After a deletion: only the browser's own deletions have been seen to
    // take the filler out, and an insertion leaves text after the newline.
    if (!isInsertion(event)) {
      restoreTrailingFiller(content, parsed);
    }

    // Every rule reads the text before the caret and treats it as something
    // just typed. A deletion leaves the very same text sitting there without
    // anyone having typed it — delete the word after a `# ` and the prefix is
    // suddenly "complete" — so the rules convert the block and eat the prefix
    // the user was in the middle of clearing. Only an insertion arms them; an
    // open slash menu still follows a deletion (see `#applyInputRules`).
    if (!this.#applyInputRules(target, !isInsertion(event))) {
      this.#emitChange();
    }
  };

  /**
   * The shortcuts that read the text before the caret as just typed.
   *
   * Returns true when one of them committed an edit of its own, which reports
   * the change; otherwise reporting it is the caller's business. The browser's
   * path has an unreported edit in the DOM, a type-over has already committed.
   */
  #applyInputRules(target: ResolvedTarget, deletion = false): boolean {
    const { content, cell } = target;
    const id = target.block.id;
    const caret = getCaretOffset(content);
    const beforeCaret = richToPlainText(this.#contentOf(target)).slice(0, caret);

    // An open slash menu tracks the text in both directions: backspacing
    // narrows the query, and deleting the `/` closes the menu. It reads the
    // text rather than acting on it, so it runs before the deletion gate.
    if (!cell && this.#slashContext?.blockId === id) {
      this.#updateSlashQuery(beforeCaret, caret);
      return false;
    }

    if (deletion) {
      return false;
    }

    // The slash menu and block rules act on a block; a cell has neither.
    if (!cell) {
      if (this.#tryOpenSlashMenu(id, beforeCaret, caret, content)) {
        return false;
      }

      if (this.#tryBlockRule(target.block, beforeCaret)) {
        return true;
      }
    }

    return this.#tryInlineRule(target, beforeCaret);
  }

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

    if (match.checked) {
      blocks = updateBlock(blocks, block.id, { checked: true });
    }

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
    // A code block is literal; its text must not be reinterpreted. Nor is a
    // display equation's TeX, where `$` and `*` mean what TeX says.
    if (isLiteralType(target.block.type)) {
      return false;
    }

    const current = this.#contentOf(target);
    // Read from the runs, not the plain text: an existing code run's
    // characters are hidden from the rules, as the Markdown reader hides a
    // code span it has closed, so typing a line and pasting it still agree
    // (the parity tests in `foreign-input.test.ts`). A backtick inside ``a`b``
    // in code can no longer pair with one typed after it and take it out of
    // the code, and a `$` in a code run is code: `` `$a` `` then `,$`
    // swallowed the span, and `$y$` typed after `` `x$` `` read `$$`.
    const match = matchTypedInlineRule(current, beforeCaret.length);

    if (!match) {
      return false;
    }

    // A formula replaces its whole span, dollars and all, with one atom.
    if (match.math !== undefined) {
      const formula = richMath(match.math);

      // A closer with a digit after it is no closer, there for the reader too:
      // a `$` typed into `$5-|2` is a price range, not a formula and a 2.
      if (
        formula.length === 0 ||
        /^[0-9]$/.test(richToPlainText(richSlice(current, match.end, match.end + 1)))
      ) {
        return false;
      }

      const before = this.#blocks;

      this.#commitResolved(
        target,
        richInsert(
          richDelete(this.#contentOf(target), match.start, match.end),
          match.start,
          formula,
        ),
      );
      this.#focusResolved(target, match.start + 1);
      this.#pending = {
        blockId: target.block.id,
        offset: match.start + 1,
        marks: [],
        ...(target.cell ? { cell: target.cell } : {}),
      };
      this.#ruleFormula = {
        blockId: target.block.id,
        offset: match.start,
        source: beforeCaret.slice(match.start, match.end),
        before,
        ...(target.cell ? { cell: target.cell } : {}),
      };
      return true;
    }

    const innerStart = match.start + match.openLength;
    const innerEnd = match.end - match.closeLength;

    if (innerEnd <= innerStart) {
      return false;
    }

    // A character typed into an inline code run is code, and code is literal,
    // as a code block is: it closes nothing. Typing `*` at the end of `a*b` in
    // code italicised the `b` and deleted both asterisks. The projection above
    // already hides that character; this says so where the rule is refused.
    if (hasCodeIn(current, match.end - 1, match.end)) {
      return false;
    }

    // Strip the closing delimiter first, so the opening offsets stay valid.
    let content = richDelete(current, innerEnd, match.end);
    content = richDelete(content, match.start, innerStart);

    const start = match.start;
    const end = start + (innerEnd - innerStart);

    if (match.link) {
      content = richSetLink(content, start, end, match.link);
    } else if (match.mark) {
      // Set, not toggled: a span typed around text that already has the mark
      // keeps it, as it does when the same line is pasted -- toggling made
      // `**__a__**` plain when typed and bold when pasted.
      content = richSetMark(content, start, end, match.mark, true);
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

    // Not where a slash is ordinary text, or where retyping the block would
    // destroy it. In a code block ` /` is everyday shell; the menu took the
    // Enter meant for a newline and turned the code into a paragraph. In an
    // image caption, applying any command retyped the image and deleted its
    // picture -- the payload `canMergeText` exists to protect.
    const owner = findBlock(this.#blocks, blockId);

    if (!owner || owner.type === 'code' || !canMergeText(owner.type)) {
      return false;
    }

    // Only at a word boundary, so a URL never opens the menu.
    const preceding = beforeCaret.at(-2);

    if (preceding !== undefined && preceding !== ' ') {
      return false;
    }

    this.#slashContext = { blockId, start: caret - 1 };
    this.#syncPortalDirection();
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
    // A combobox is an input field and needs a name (WCAG 4.1.2). The host has
    // none of its own -- its element supplies its role and content -- so it
    // borrows the menu's for exactly as long as it is one. By reference, not
    // aria-label (a to-do's checkbox is named by this host, and a label here
    // renamed it), and to a label of its own rather than the listbox: Chromium
    // names a combobox labelled by a listbox from the options' text, not from
    // the listbox's aria-label ("T Text Just start writing...").
    host.setAttribute('aria-labelledby', this.#slashLabel.id);
    host.setAttribute('aria-expanded', 'true');
    host.setAttribute('aria-haspopup', 'listbox');

    const menu = this.#slashMenu.element;
    const active = this.#slashMenu.activeOptionId;

    this.#reference(host, 'aria-controls', menu.querySelector(`[id="${this.#slashMenu.listId}"]`));
    this.#reference(
      host,
      'aria-activedescendant',
      active ? menu.querySelector(`[id="${active}"]`) : null,
    );
  }

  /**
   * Points an ARIA relationship at an element, wherever it lives.
   *
   * An ID reference cannot cross a shadow boundary, and the menu is portalled
   * into whatever tree the host passes as `portalContainer` -- with the editor
   * in a shadow root and the popovers on the page, these IDs pointed at nothing.
   * Across trees the element-reflection property is used where the browser has
   * it, and no ID is written that could not resolve.
   *
   * Reflection only reaches into an ancestor tree: an editor in a shadow root
   * pointing at a menu on the page works, but a light-DOM editor whose
   * `portalContainer` is a shadow root, or one in another document, gets no
   * relation at all -- the browser drops the reference rather than expose an
   * element the host's tree cannot see.
   */
  #reference(
    host: HTMLElement,
    attribute: 'aria-controls' | 'aria-activedescendant',
    target: Element | null,
  ): void {
    const property =
      attribute === 'aria-controls' ? 'ariaControlsElements' : 'ariaActiveDescendantElement';
    const reflecting = host as unknown as Record<string, unknown>;

    if (target && target.getRootNode() === host.getRootNode()) {
      host.setAttribute(attribute, target.id);
      return;
    }

    host.removeAttribute(attribute);

    if (property in host) {
      reflecting[property] = target ? (attribute === 'aria-controls' ? [target] : target) : null;
    }
  }

  /** Closes the menu and removes the combobox wiring it added. */
  #closeSlashMenu(): void {
    const content = this.#slashContext
      ? this.#renderer.getView(this.#slashContext.blockId)?.content
      : undefined;

    this.#slashMenu.close();
    this.#slashContext = null;

    for (const attribute of ['role', 'aria-labelledby', 'aria-expanded', 'aria-haspopup']) {
      content?.removeAttribute(attribute);
    }

    if (content) {
      this.#reference(content, 'aria-controls', null);
      this.#reference(content, 'aria-activedescendant', null);
    }
  }

  #applySlashCommand(command: SlashCommand): void {
    const context = this.#slashContext;

    this.#closeSlashMenu();

    if (!context || !this.#canEdit()) {
      return;
    }

    const block = findBlock(this.#blocks, context.blockId);
    const content = this.#renderer.getView(context.blockId)?.content;

    if (!block || !content) {
      return;
    }

    // Strip the `/query` the user typed to summon the menu.
    //
    // Clamped to the start. `getCaretOffset` answers 0 when the caret is not in
    // this host at all -- which it documents -- and the user can also simply
    // click earlier in the same block with the menu still open. Either way the
    // range ran backwards, and `richDelete` took it as [0, start): the command
    // applied and silently ate the head of the block instead of the query.
    const end = Math.max(context.start, getCaretOffset(content));
    const stripped = richDelete(block.content, context.start, end);
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

    // Focus is in the dialog, so the live selection cannot say what the link
    // was applied to, and undo put the caret at offset 0. The range the
    // dialog was opened over is that selection -- direction included, which
    // undo restores from here and redo from the selection placed below.
    this.#commitResolved(
      target,
      richSetLink(this.#contentOf(target), context.start, context.end, url),
      null,
      {
        blockId: context.blockId,
        start: context.start,
        end: context.end,
        ...(context.cell ? { cell: context.cell } : {}),
        ...(context.backward ? { backward: true as const } : {}),
      },
    );
    // Shown as Escape shows it (`#closeLinkEditor`).
    this.#placeRangeInView(target, context.start, context.end, context.backward);
    this.#syncToolbar();
  }

  /**
   * Puts a range back in `target` without revealing its host, and brings the
   * range's focus end into view by the least scroll, only where it is not
   * wholly on screen (`#revealPlacedCaret`): the link editor's ways in and
   * out. A host taller than the window, revealed whole, moved the page by
   * its edge whether or not the range was already in sight (R14-PTR-1).
   */
  #placeRangeInView(target: ResolvedTarget, start: number, end: number, backward = false): void {
    if (this.#placeRange(target.block.id, start, end, target.cell, backward, false)) {
      this.#revealPlacedCaret(target.content);
    }
  }

  /* -------------------------------------------------------------- math -- */

  /**
   * Writes the popover's TeX over the range it was opened for, as one edit.
   *
   * Empty TeX removes a formula that was there and inserts nothing where none
   * was: an empty formula is no formula (`normalizeRuns` drops one).
   */
  #applyMath(tex: string): void {
    const context = this.#mathContext;

    this.#mathEditor.close();
    this.#mathContext = null;

    if (!context || !this.#canEdit()) {
      return;
    }

    const target = this.#targetFor(context.blockId, context.cell);

    if (!target) {
      return;
    }

    const formula = richMath(tex);
    const { selection } = context;

    // Nothing written over nothing: a new formula left empty is a cancel.
    if (formula.length === 0 && !context.existing) {
      this.#focusResolved(target, selection.start, selection.end);
      return;
    }

    const content = richInsert(
      richDelete(this.#contentOf(target), context.start, context.end),
      context.start,
      formula,
    );

    // The snapshot is the selection the popover was opened from. Read from the
    // page instead, it was whatever the popover's own input held -- nowhere in
    // this editor -- so undo put the caret at the top of the document.
    this.#commitResolved(target, content, null, selection);

    // A caret that stood before the formula stays before it; anything else
    // lands after what was written.
    const caret =
      context.existing && selection.start === selection.end && selection.start === context.start
        ? context.start
        : context.start + formula.length;

    this.#focusResolved(target, caret);
    this.#syncToolbar();
  }

  #closeMathEditor(restoreFocus = true): void {
    const context = this.#mathContext;

    this.#mathEditor.close();
    this.#mathContext = null;

    // As for the link popover: back where it was opened from, unless a pointer
    // dismissed it by placing the caret somewhere else itself.
    if (context && restoreFocus) {
      const { selection } = context;

      this.focusRange(selection.blockId, selection.start, selection.end, selection.cell);
      this.#syncToolbar();
    }
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
      // Shown, its host not revealed (`#placeRangeInView`): Escape from the
      // link editor a click opened in a tall block scrolled the page the way
      // the click had (R14-PTR-1).
      const target = this.#targetFor(context.blockId, context.cell);

      if (target) {
        this.#placeRangeInView(target, context.start, context.end, context.backward);
      }

      this.#syncToolbar();
    }
  }

  /**
   * Set by a Shift press on the reader's range (`#handleRootMouseDown`, rule
   * (a)): one the browser extends in the range's own host, or one cancelled
   * on another host. Its click is no link click: on a link, it selected the
   * link and opened the link editor, which dropped the reader's range --
   * extended or kept -- all the same (R13-RV11-PTR-4). Spent by the first
   * click after it, and cleared by the next press; only a pointer's own
   * click (`detail` above 0) is taken for the press's, so a page's
   * `anchor.click()` or an assistive technology's default action after a
   * press that ended without a click still acts (R13-RV11-PTR-2).
   */
  #shiftPress = false;

  /** Clicking a link edits it; ⌘/Ctrl-click and read-only mode follow it. */
  #handleClick = (event: MouseEvent): void => {
    const shiftPress = this.#shiftPress && event.detail > 0;
    this.#shiftPress = false;
    const node = asElement(event.target);

    // A formula is edited in its popover: nothing can be typed inside it.
    // Read-only, it is only something to look at.
    const formula = node?.closest<HTMLElement>('.neditor-math');

    if (formula && this.#root.contains(formula)) {
      event.preventDefault();

      const target = this.#resolve(formula);
      const offsets = target ? offsetsOfNode(target.content, formula) : null;

      // The caret goes after the formula, not over it: `openMathEditor` keeps
      // the selection it opened from for Escape to give back, and a selected
      // formula given back was replaced by the next key.
      if (target && offsets && this.#canEdit()) {
        this.#focusResolved(target, offsets.end);
        this.openMathEditor();
      }

      return;
    }

    // A display equation's picture stands in for its source until the source
    // is being edited; a click on it is a click into the equation.
    const preview = node?.closest<HTMLElement>('.neditor-math-block__preview');
    const previewBlock = preview ? this.#renderer.blockIdFromNode(preview) : undefined;

    if (previewBlock && this.#canEdit()) {
      event.preventDefault();
      this.focus(previewBlock, CARET_END);
      return;
    }

    const anchor = node?.closest<HTMLAnchorElement>('a.neditor-link');

    if (!anchor) {
      return;
    }

    // Cancel first. An unsafe href is exactly the case that must not reach the
    // browser, so returning early here would fail open.
    event.preventDefault();

    if (shiftPress) {
      return;
    }

    const href = sanitizeUrl(anchor.getAttribute('href') ?? '');

    if (!href) {
      return;
    }

    if (!this.#editable || event.metaKey || event.ctrlKey) {
      this.#document.defaultView?.open(href, '_blank', 'noopener,noreferrer');
      return;
    }

    // In a task after the click: WebKit collapses a range the press landed
    // inside, and focuses the host, only after the click's listeners have
    // run, so a link editor opened here closed at once and left the caret in
    // the link. Cancelling that press instead (round 13's first version) cost
    // every engine the native drag of a selection by a link in it.
    this.#cancelLinkOpen();
    const pointer = event.detail > 0;
    this.#linkOpen =
      this.#document.defaultView?.setTimeout(() => {
        this.#linkOpen = null;

        // Resolved from the anchor itself: a table has one host per cell, and
        // the view's `content` is only ever the first of them. A link gone
        // from the document resolves to nothing.
        const target = this.#resolve(anchor);
        const offsets = target ? offsetsOfNode(target.content, anchor) : null;

        // And, for a pointer's own click, only while focus is still in the
        // link's own host, where the press put it: a page's own click
        // listener that moved it -- to a button of its own, or through
        // `focus()` -- had the last word, and the editor took focus back into
        // the link's URL field over it (R13-RV14-PTR-1). A script's `click()`
        // (`detail` 0) put no focus anywhere and asks for the link editor.
        if (!target || !offsets || (pointer && !this.#typingIn(target.content))) {
          return;
        }

        // The link is selected where it is, and the page moves only to show
        // its end where that is not wholly on screen (`#placeRangeInView`,
        // as a press the editor places is shown): revealing its
        // host, as before round 14, scrolled a block taller than the window
        // by 100-300px and took the link from under the pointer, and one
        // cut at the window's edge by 41-158px (R14-PTR-1). A script's
        // `click()` too: on a link out of sight in a tall block, revealing
        // the host lines up one of its edges and can leave the link out of
        // sight still, so the link's own place is the one worth showing.
        this.#placeRangeInView(target, offsets.start, offsets.end);
        this.openLinkEditor();
      }) ?? null;
  };

  /**
   * The link editor a click on a link opens in a task (`#handleClick`), until
   * it does. Anything that came between is newer than the click, and the
   * open is dropped rather than taking the caret from it: another press, a
   * key, a new document, a lock (a real switch to read-only; a no-op
   * `setEditable(true)` is not one), or, for a pointer's click, focus no
   * longer in the link's own host when the task runs. `destroy` cancels
   * nothing: the task still fires, and finds no link to resolve.
   */
  #linkOpen: number | null = null;

  #cancelLinkOpen(): void {
    if (this.#linkOpen !== null) {
      this.#document.defaultView?.clearTimeout(this.#linkOpen);
      this.#linkOpen = null;
    }
  }

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
    const own = event.clipboardData.getData(OWN_CLIPBOARD_TYPE);
    const fragment = this.#ownFragment(own);

    if (this.#selected.size > 0) {
      this.#pasteOverBlockSelection(html, plain, fragment);
      return;
    }

    const resolved = this.#resolve(event.target);

    if (!resolved) {
      return;
    }

    this.#insertForeignContent(resolved, html, plain, undefined, own.length > 0, fragment);
  };

  /**
   * The runs a text-range copy carried in our own clipboard type, if it did.
   *
   * Read as untrusted: any page can write this type, so it goes through
   * `normalizeDocument` like a stored document -- unknown marks dropped, every
   * href through `sanitizeUrl` -- and is honoured only when it is exactly the
   * one paragraph `#copyTextRange` writes. A block copy writes a bare marker
   * there instead, and anything else is ignored in favour of the HTML. The
   * block is built fresh, so no id from the clipboard can reach the document.
   */
  #ownFragment(data: string): Block[] | null {
    if (!data.startsWith('{')) {
      return null;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(data);
    } catch {
      return null;
    }

    const stored = (parsed as { blocks?: unknown } | null)?.blocks;

    if (!Array.isArray(stored) || stored.length !== 1) {
      return null;
    }

    const [block] = normalizeDocument({ blocks: stored as Block[] }).blocks;

    if (block?.type !== 'paragraph' || isRichEmpty(block.content)) {
      return null;
    }

    return [createBlock('paragraph', block.content)];
  }

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
      // setBaseAndExtent, not collapse: the one WebKit honours inside a shadow
      // root (see setSelectionRange).
      this.#selection()?.setBaseAndExtent(point.node, point.offset, point.node, point.offset);
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
    own = false,
    fragment: Block[] | null = null,
  ): void {
    // Our own fragment is runs, read from neither the HTML nor the plain text.
    const { blocks: pasted, fromHtml } = fragment
      ? { blocks: fragment, fromHtml: false }
      : this.#parseClipboard(html, plain);

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
      : isLiteralType(resolved.block.type)
        ? // A code block is literal: pasted structure becomes text, never blocks.
          // So is a display equation, and pasted formulas arrive as their TeX.
          //
          // Whose clipboard it is decides which half to read. Ours, from a
          // block copy, pairs the HTML with `toMarkdown` output, so `text/plain`
          // there carries a code block's fence lines and a paragraph's escapes
          // -- characters the user never typed; from a text copy it carries the
          // runs themselves, which `pasted` already is. Everyone else pairs it
          // with the literal text,
          // which is exactly what a code block wants and is more faithful than
          // anything recoverable from their HTML. Preferring the parsed text
          // for *all* HTML, which is what the first version of this fix did,
          // took the second case away to fix the first.
          //
          // Math is the exception to that: rendered math's plain text is its
          // glyphs (`\frac{1}{2}` copies as `1212`), and HTML that names its
          // TeX is the faithful half then. Only HTML: with none, the blocks
          // were read from the plain text as Markdown, and a shell line's
          // `"$HOME/$USER"` pair made every `#`, `- ` and `*` in it go.
          //
          // Windows and classic Mac line endings are one newline each: a
          // `\r` kept in the model is a character no key typed, and it went
          // on into every copy and Markdown export of the block. So is a
          // vertical tab or a form feed, and no other control character
          // stays (see `normalizeControlCharacters`).
          richFromPlainText(
            normalizeControlCharacters(
              own ||
                this.#plainIsOurMarkdown(fromHtml, pasted, plain) ||
                (fromHtml && pasted.some(holdsMath))
                ? pasted.map((block) => this.#literalText(resolved.block.type, block)).join('\n')
                : plain ||
                    pasted.map((block) => this.#literalText(resolved.block.type, block)).join('\n'),
            ),
          )
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

    // Plain text with no structure of its own: lines, each a depth-0
    // paragraph only because the Markdown reader had nothing else to call it.
    const lines =
      fragment === null &&
      html.length === 0 &&
      pasted.every((block) => block.type === 'paragraph' && block.depth === 0);

    this.#pasteBlocks(resolved.block, resolved.content, pasted, lines);
  }

  /**
   * A pasted block's text as a literal block of `type` takes it: a table's
   * cells as tab-separated text, and a formula as its TeX -- between dollars
   * in a code block, bare in a display equation, which is TeX already.
   */
  #literalText(type: BlockType, block: Block): string {
    const literal = (content: RichText): string => richToPlainText(contentForType(type, content));

    // Cell by cell: the table's own plain text holds each formula as an atom
    // character with its TeX gone.
    return block.type === 'table'
      ? (block.rows ?? []).map((row) => row.map(literal).join('\t')).join('\n')
      : literal(block.content);
  }

  /** HTML first, since it carries structure; Markdown is the fallback. */
  /**
   * Whether `plain` is this package's own Markdown for the HTML beside it.
   *
   * The `application/x-neditor` type is the primary signal, but a custom
   * clipboard type is not guaranteed to survive every system clipboard, and
   * when it does not the code-block paste falls back to `text/plain` -- which
   * for our own payload is `toMarkdown` output, fence lines and escapes and
   * all. This is an exact test rather than a guess: if writing the parsed
   * blocks back out reproduces the plain text byte for byte, the plain text is
   * that Markdown. Another application's pairing does not survive that.
   */
  #plainIsOurMarkdown(fromHtml: boolean, pasted: readonly Block[], plain: string): boolean {
    // Only when the blocks came from the HTML. Without HTML -- or with HTML
    // that parses to nothing, `<meta charset>` alone -- `#parseClipboard`
    // parses the *plain text* into them, so the comparison below becomes a
    // Markdown round trip against itself -- true for anything Markdown-shaped,
    // which made this vacuous in exactly the case where it is the only signal.
    // `# TODO: fix` pasted from a terminal lost its `#`, and `---` inserted
    // nothing at all.
    if (!fromHtml || plain.length === 0) {
      return false;
    }

    return toMarkdown({ blocks: pasted as Block[] }).trim() === plain.trim();
  }

  /** The clipboard's blocks, and whether they came from its HTML or its plain text. */
  #parseClipboard(html: string, plain: string): { blocks: Block[]; fromHtml: boolean } {
    // The plain text rides along as the arbiter of whitespace: Firefox copies
    // a page's classes rather than its computed `white-space`, so a pre-wrap
    // paragraph arrives looking like source text to collapse, while its
    // `text/plain` holds it as it was drawn (R2-PARSE-1).
    const fromHtml = html.length > 0 ? blocksFromHtml(this.#document, html, { plain }) : [];

    return fromHtml.length > 0
      ? { blocks: fromHtml, fromHtml: true }
      : { blocks: blocksFromMarkdown(plain), fromHtml: false };
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
   * paragraph splits it rather than leaving an empty remnant. At the very
   * start of a block with text, several blocks -- or one that cannot merge --
   * go in front of it instead, and it takes the last one's text when that is
   * prose at the paste's top level: the block the reader is in stays itself.
   * So do they at the start of an empty block a paste may not replace: one
   * with blocks nested under it (a list item or a to-do with sub-items), or a
   * toggle or callout at `MAX_DEPTH` when the first pasted block cannot merge.
   * An empty toggle or callout is otherwise the exception: the paste goes in
   * as typed there, its first line of prose the block's own text and the rest
   * -- a table too -- its children, or at `MAX_DEPTH` its siblings. Plain
   * lines pasted into a list item or a to-do go in front of nothing: they are
   * its further items (`continuing`), as Enter makes them.
   *
   * Both of those moves carry text and nothing else, which is only the whole of
   * a block when the block is text. A table, an image or a divider keeps its
   * payload beside `content`, so one is spliced in as a block of its own rather
   * than merged into a paragraph — and never handed text it cannot show.
   */
  #pasteBlocks(target: Block, content: HTMLElement, pasted: Block[], lines = false): void {
    const range = getSelectionRange(content) ?? { start: 0, end: 0 };
    const trimmed = richDelete(target.content, range.start, range.end);
    const [before, after] = richSplit(trimmed, range.start);
    const [first] = pasted;

    if (!first) {
      return;
    }

    // Lines of plain text pasted into a list item or a to-do are more items,
    // as Enter makes them: the item keeps its own type, check and id, and each
    // line after the first is a new item at its depth. As paragraphs, the text
    // after the caret fell out of the list with the last line.
    const continuing = lines && isContinuingType(target.type);

    // Pasting into a genuinely empty block replaces it outright. Retyping it
    // through setBlockType would rebuild the payload from the *target*, which
    // blanks a pasted table's rows and an image's src. A table or an image is
    // never empty here whatever its cells or caption say: its payload is not
    // text, so there is nothing for a paste to take the place of.
    //
    // Not a block with children, though: a toggle or a callout (or a list
    // item with items under it) is still their parent when its text is empty,
    // and replaced, the children passed to whatever replaced it -- an
    // equation, shown open, or a collapsed one hiding nothing of its own; a
    // collapsed toggle's hidden answers showed under a pasted bullet. A toggle
    // or a callout is never replaced even with no children yet: the paste
    // merges into its own text and nests the rest, as anywhere else in it.
    const index = findBlockIndex(this.#blocks, target.id);
    const parents = (this.#blocks[index + 1]?.depth ?? -1) > target.depth;
    const replaceable =
      !continuing &&
      isRichEmpty(trimmed) &&
      canMergeText(target.type) &&
      !parents &&
      !acceptsChildren(target.type);

    // Only text merges into text. Merging a pasted table would keep its
    // (always empty) content and drop every row — for a lone table pasted into
    // a paragraph, a paste that changed nothing at all. Nor does literal text
    // merge into prose: an equation pasted mid-sentence became part of the
    // sentence, its TeX read as words. The target is never literal here --
    // a paste into one takes the inline path -- so a literal block pasted
    // stands as a block of its own.
    const merges = replaceable || (canMergeText(first.type) && !isLiteralType(first.type));

    // Pasted at the very start of a block -- several blocks, or one that cannot
    // merge -- what is pasted goes in front of it, and the block stays itself:
    // its id, type, payload, check, icon and children, which is Enter's own
    // answer there. Split around the caret instead, its text was rebuilt as a
    // new block -- a heading lost its level, a checked to-do its check, a
    // callout its icon, a toggle or callout its children, and a collapsed
    // toggle deleted as a husk exposed its answers -- whichever pasted block
    // came first. A paste that ends in prose still ends in the block's text,
    // as anywhere else: that last block's text joins the start of the block,
    // as a first block's text joins the end of the text before a caret
    // mid-block. One block of prose merges as it does anywhere.
    // Only a last block at the paste's own top level joins: one nested in what
    // was pasted (the body of a closed `<details>`, a list's last sub-item)
    // belongs to that, and joined, a toggle lost its body to the heading.
    const top = shallowest(pasted);
    const depths = pastedDepths(pasted, target.depth);
    const lastPasted = pasted[pasted.length - 1] ?? first;
    const lastJoins =
      canMergeText(lastPasted.type) && !isLiteralType(lastPasted.type) && lastPasted.depth === top;

    // Not into a toggle's or a callout's empty text, though: with nothing of
    // the block's own to keep in front of, the paste is its text and children,
    // as typed there -- the first line its summary, the rest nested beside its
    // answers, a table under it. Put in front, the paste left it an empty husk
    // above them. At `MAX_DEPTH` nothing nests under it (`into` is 0 below),
    // and a first block that cannot merge -- a table -- landed beside it and
    // left exactly that husk, so that one goes in front, as for any block.
    // Prose still merges there: its first line is the block's text and the
    // rest its siblings, as Enter makes them at that depth. Nor are lines
    // pasted into a list item put in front of it: they are its further items
    // (`continuing`), as Enter makes them.
    const keepsOwnText =
      !isRichEmpty(after) ||
      !acceptsChildren(target.type) ||
      (target.depth >= MAX_DEPTH && !merges);

    if (
      isRichEmpty(before) &&
      !replaceable &&
      !continuing &&
      keepsOwnText &&
      (!merges || pasted.length > 1)
    ) {
      const front = lastJoins ? pasted.slice(0, -1) : pasted;
      const joined = lastJoins ? richConcat(lastPasted.content, after) : after;
      let blocks = richEquals(joined, target.content)
        ? this.#blocks
        : updateBlock(this.#blocks, target.id, { content: joined });
      let at = findBlockIndex(blocks, target.id);

      front.forEach((block, index) => {
        blocks = insertBlockAt(blocks, at, { ...cloneBlock(block), depth: depths[index]! });
        at += 1;
      });

      // `pastedDepths` roots what goes in front at the target's own depth, so
      // no front block can take the target or its children under a fold;
      // `keepVisible` holds that whatever later changes the depths -- every
      // structural commit goes through it.
      this.#commit(keepVisible(this.#blocks, normalizeDepths(blocks), [target.id]));
      this.focus(target.id, lastJoins ? richLength(lastPasted.content) : 0);
      return;
    }

    // Lines pasted into a toggle's or a callout's own text become its
    // children, as Enter there makes them, and open it: a sibling put between
    // it and its children took them over -- a collapsed toggle's hidden
    // answers showed under a stranger, and the toggle was left empty -- and
    // one put inside it collapsed was never seen, nor was the reader's own
    // text after the caret, carried into it. Neither is ever replaced. A block
    // the paste replaces has the pasted block's type instead.
    //
    // Only what stands at the paste's own level and below it: blocks nested
    // under a first block that merged into the toggle's text are under the
    // toggle already, and a level more put a sibling of theirs under them.
    // Not past the deepest level a document holds, as Enter is not.
    const into = !replaceable && acceptsChildren(target.type) && target.depth < MAX_DEPTH ? 1 : 0;
    const skip = merges ? 1 : 0;
    let underFirst = skip === 1;
    let created = pasted.slice(skip).map((block, index) => {
      if (continuing) {
        return createBlock(target.type, block.content, target.depth);
      }

      const depth = depths[index + skip]!;
      underFirst &&= depth > depths[0]!;

      return { ...cloneBlock(block), depth: depth + (underFirst ? 0 : into) };
    });

    // Where the text that followed the caret lands, and the type it lands in.
    const tail = created.at(-1);
    const tailType = tail?.type ?? (replaceable ? first.type : target.type);

    // Appending that text to a divider or a table parks it in a field nothing
    // renders and `normalizeDocument` erases on the next load, so it gets a
    // block of its own — the rehousing `/divider` already does. A divider holds
    // no caret either, so it earns one even with no text to carry.
    // The same goes for the prose after the caret when the last pasted block
    // is literal: appended there it became TeX, marks, links and formulas and
    // all, inside an equation.
    const rehoused =
      (canMergeText(tailType) && (!isLiteralType(tailType) || tailType === target.type)) ||
      (isRichEmpty(after) && !isVoidType(tailType))
        ? null
        : createBlock(typeAfterSplit(target.type), after, target.depth + into);

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
      // The id is the target's and stays put; the rest is the pasted block's
      // and nothing else. Merged over the target, the old type's fields
      // survived -- a heading pasted over an empty checked to-do kept
      // `checked`, an equation `collapsed` -- where `setBlockType` drops them
      // with the type.
      const { id: _pastedId, ...payload } = cloneBlock(first);
      const replacement: Block = {
        ...payload,
        id: target.id,
        depth: target.depth,
        content: targetContent,
      };

      blocks = this.#blocks.map((block) => (block.id === target.id ? replacement : block));
    } else if (created.length === 0 && richEquals(targetContent, target.content)) {
      // A paste that brings nothing back to where it started -- `## ` as plain
      // text parses to one empty heading, which merges as no text at all --
      // keeps the target itself, so `#commit` sees the document it already has
      // and records nothing. Rebuilt, an equal block was still a new one: an
      // undo step and a `change` for a document nobody had touched.
      blocks = this.#blocks;
    } else {
      blocks = updateBlock(this.#blocks, target.id, {
        content: targetContent,
        ...(into && target.collapsed && created.length > 0 ? { collapsed: false } : {}),
      });
    }

    let at = findBlockIndex(blocks, target.id);

    for (const block of created) {
      at += 1;
      blocks = insertBlockAt(blocks, at, block);
    }

    // A block that could not merge, pasted at offset 0, went in front of the
    // target above, so no husk is left here for a table pasted at the start
    // of a block to sit under.

    const last = created.at(-1);

    // On the depths that are drawn: opened against depths before clamping,
    // a fold that clamping made an ancestor stayed shut over the reader's text.
    // `openPastedFolds` opens a pasted fold over the reader's next block and
    // over the block the text after the caret went into; `keepVisible` then
    // opens any fold, pasted or not, over a block the reader could already
    // see -- a pasted collapsed toggle lands in front of the target's own
    // children, which then nest under it out of sight.
    blocks = openPastedFolds(normalizeDepths(blocks), new Set(created.map((block) => block.id)), [
      blocks[at + 1]?.id,
      isRichEmpty(after) ? undefined : last?.id,
    ]);

    // Its own pasted children have new ids and stay folded: a closed
    // `<details>` pastes as a collapsed toggle. The last block is the
    // exception only when it carries text the reader already had -- what
    // followed the caret moves into it, and folded away it vanished -- or when
    // the fold that hides it was already in the document (pasting lines into a
    // collapsed toggle's summary nests them, and Enter there opens it too).
    // Otherwise the fold is the paste's own, and the caret goes to the end of
    // the nearest pasted block still on screen rather than into the fold.
    const settled = keepVisible(this.#blocks, blocks);
    const shown = new Set(visibleBlocks(settled).map((block) => block.id));
    const pastedIds = new Set(created.map((block) => block.id));

    if (replaceable) {
      pastedIds.add(target.id);
    }

    if (last && !shown.has(last.id)) {
      const lastIndex = findBlockIndex(settled, last.id);
      let holder: Block | undefined;

      for (let index = lastIndex - 1, depth = last.depth; index >= 0 && depth > 0; index -= 1) {
        const candidate = settled[index]!;

        if (candidate.depth < depth) {
          depth = candidate.depth;

          if (shown.has(candidate.id)) {
            holder = candidate;
            break;
          }
        }
      }

      if (isRichEmpty(after) && holder && pastedIds.has(holder.id)) {
        this.#commit(settled);
        this.focus(holder.id, CARET_END);
        return;
      }

      this.#commit(keepVisible(this.#blocks, blocks, [last.id]));
    } else {
      this.#commit(settled);
    }

    // The caret goes where the paste ends -- or, should that block not take
    // it, to the end of the nearest pasted block still on screen. Aimed at a
    // hidden one, focus failed and nothing else took it: the editor was left
    // in neither mode, with focus on the page.
    if (last && this.focus(last.id, richLength(last.content) - richLength(after))) {
      return;
    }

    for (const block of [...created].reverse()) {
      if (block !== last && this.focus(block.id, richLength(block.content))) {
        return;
      }
    }

    this.focus(target.id, richLength(before) + richLength(first.content));
  }

  /** Replaces the selected blocks with the clipboard's blocks. */
  #pasteOverBlockSelection(html: string, plain: string, fragment: Block[] | null = null): void {
    const pasted = fragment ?? this.#parseClipboard(html, plain).blocks;
    const firstId = this.#orderedSelection()[0];

    if (pasted.length === 0 || !firstId) {
      return;
    }

    const index = findBlockIndex(this.#blocks, firstId);
    const depths = pastedDepths(pasted, this.#blocks[index]?.depth ?? 0);
    const created = pasted.map((block, at) => ({ ...block, depth: depths[at]! }));

    const removing = this.#selectionForEdit();
    let blocks = this.#blocks.filter((block) => !removing.has(block.id));
    let at = index;

    for (const block of created) {
      blocks = insertBlockAt(blocks, at, block);
      at += 1;
    }

    // A removal like any other: the removed blocks' children go to whatever
    // now precedes them, and a pasted collapsed toggle would swallow them
    // (`keepVisible`), as it would the reader's next block (`openPastedFolds`).
    blocks = openPastedFolds(normalizeDepths(blocks), new Set(created.map((block) => block.id)), [
      blocks[at]?.id,
    ]);

    this.#commit(keepVisible(this.#blocks, blocks));

    // The pasted blocks by their ids, or nothing (`#letGo`): renamed under the
    // edit by a `change` listener, none of them was found, and the root was
    // left focused with nothing selected and no caret -- neither mode.
    const present = new Set(this.#visible().map((block) => block.id));

    if (!created.some((block) => present.has(block.id))) {
      this.#clearBlockSelection();
      this.#letGo();
      return;
    }

    // Hidden ones (inside a pasted collapsed toggle) are dropped there: a block
    // selection holds only what the reader can see.
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

  /** Mod+Z, Mod+Shift+Z and Mod+Y. True when the key was one of them. */
  #handleHistoryKeys(event: KeyboardEvent): boolean {
    if (!this.#shortcutModifier(event) || event.altKey) {
      return false;
    }

    const key = event.key.toLowerCase();

    if (key === 'z') {
      event.preventDefault();

      if (event.shiftKey) {
        this.redo();
      } else {
        this.undo();
      }

      return true;
    }

    if (key === 'y' && !event.shiftKey) {
      event.preventDefault();
      this.redo();
      return true;
    }

    return false;
  }

  #handleKeyDown = (event: KeyboardEvent): void => {
    // Whatever the last key left for after the browser's own action on it is
    // due now: that action has happened, and this key is judged after it.
    // A held arrow's repeats can all arrive before any timer runs (Chromium
    // puts input first), and then this is where the last press crosses into
    // the next host -- after this key was aimed at the host it left. So the
    // key is judged in the host the caret is now in, as a fresh press from
    // there: judged in the old one, it checked nothing, and every crossing
    // cost a second press.
    const crossed = this.#flushAfterKey();

    // A run of plain ↑/↓ keeps its column; any other key starts a new one.
    if (
      (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      this.#goal = null;
    }

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

    // Before resolving a host: undo is about the document, not the text the
    // key landed in. A toggle's chevron and a callout's icon are inside the
    // editor but are no editing host, and resolving first dropped Mod+Z there
    // -- right after the chevron press it would have undone.
    if (this.#editable && this.#handleHistoryKeys(event)) {
      return;
    }

    const resolved = this.#resolve(
      crossed ? (readSelection(this.#root)?.focusNode ?? null) : event.target,
    );

    if (!resolved || !this.#editable) {
      return;
    }

    const { block, content } = resolved;
    const modifier = this.#shortcutModifier(event);

    // Anything but a typed character between the formula and the digit means
    // the caret went somewhere: the formula stands. A modifier pressed alone
    // is part of typing the digit, not something between: on AZERTY the top
    // row's digits need Shift.
    if (
      (event.key.length !== 1 && !MODIFIER_KEYS.has(event.key)) ||
      event.ctrlKey ||
      event.metaKey
    ) {
      this.#ruleFormula = null;
    }

    if (modifier && !event.altKey) {
      const key = event.key.toLowerCase();
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

      // Not swallowed where it does nothing: in a code block or an equation
      // the browser keeps it.
      if (event.shiftKey && key === 'e' && !isLiteralType(block.type)) {
        event.preventDefault();
        this.openMathEditor();
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

    // A caret key ends a link continuation even when it comes back to the same
    // offset: ← then → is the reader going somewhere, not the next character.
    if (CARET_KEYS.has(event.key) || event.key === 'Escape') {
      this.#typingOver = null;
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

        if (event.shiftKey || isLiteralType(block.type)) {
          this.#insertSoftBreak(block, content);
        } else {
          this.#splitBlock(block, content);
        }

        return;

      case 'Backspace':
        if (isCaretAtStart(content)) {
          event.preventDefault();
          this.#backspaceAtStart(block);
          this.#selectedByKey = this.#selected.size > 0 ? event.key : null;
        }

        return;

      case 'Delete':
        if (isCaretAtEnd(content)) {
          event.preventDefault();
          this.#deleteAtEnd(block);
          this.#selectedByKey = this.#selected.size > 0 ? event.key : null;
        }

        return;

      case 'Tab': {
        const delta = event.shiftKey ? -1 : 1;
        const indented = indentBlocks(
          this.#blocks,
          indentTargets(this.#blocks, [block.id], delta),
          delta,
        );

        // Only swallow Tab when it actually indents. Otherwise the editor would
        // be a keyboard trap (WCAG 2.1.2): Shift+Tab at depth 0 is always
        // available as the way out.
        if (indented.every((next, index) => next.depth === this.#blocks[index]?.depth)) {
          return;
        }

        event.preventDefault();
        // Into a collapsed toggle, the block would vanish and the focus below
        // could not land -- the editor left in neither mode. Open it instead.
        this.#commit(keepVisible(this.#blocks, indented));
        this.focus(block.id, getCaretOffset(content));
        return;
      }

      case 'ArrowUp':
      case 'ArrowDown': {
        const direction = event.key === 'ArrowUp' ? -1 : 1;

        if (modifier && event.shiftKey) {
          event.preventDefault();
          // Read before the move: it re-parents this very host, and a real
          // browser drops the selection with it (happy-dom does not), so the
          // offset read afterwards was 0 on the way up.
          const offset = getCaretOffset(content);
          this.#moveVisible(new Set([block.id]), direction);
          // Back into the same host: a table's cell, not its block id (0:0).
          this.#focusResolved(resolved, offset);
        } else if (event.shiftKey) {
          // Shift-extending past the edge of a block selects whole blocks: the
          // browser cannot carry a text selection into another editing host.
          // The *focus* end decides, not the caret: a range made with
          // Shift+↓ ends at the block's edge without ever being collapsed
          // there, and asking for a caret kept it in the block for good.
          if (this.#focusAtEdge(content, direction)) {
            event.preventDefault();
            this.#extendFromTextToBlocks(block.id, direction);
          }
        } else if (!event.altKey && !event.ctrlKey && !event.metaKey) {
          // Modified, the keys are the platform's: on macOS ⌘↑/↓ go to the
          // start or end of the document and ⌥↑/↓ to the start or end of the
          // paragraph, elsewhere Ctrl moves by paragraph. Stepping one block
          // for them was a different command under the same keys.
          const ends = getSelectionEnds(content);
          const run = ends ? this.#runGoal(content, ends.focus) : null;
          const goal = run ?? (ends ? this.#caretColumn(content, ends.focus) : null);

          if (this.#leavesHost(content, direction)) {
            this.#moveCaretVertically(resolved, direction, event, goal);
          }

          if (event.defaultPrevented) {
            this.#noteGoal(goal);
          } else {
            // The move is the browser's -- inside the block, or off the end of
            // the document to the end of its text -- and where it puts the
            // caret stands: only the run is noted, from there. Noted before
            // the move, the run ended right there. Putting the caret back
            // under the run's column afterwards undid every move the browser
            // made to a block's end, and a run of ↓ stuck at the start of a
            // wrapped paragraph's last line for good.
            this.#afterDefault(() => this.#noteGoal(goal));
          }
        }

        return;
      }

      case 'ArrowLeft':
      case 'ArrowRight': {
        // A plain arrow that cannot move the caret steps into the next host,
        // as it would across paragraphs anywhere else: each block is its own
        // editing host, so the browser's own arrow stops dead at the edge.
        // The browser moves first, and only a move that went nowhere crosses
        // (#checkArrowMove): which end of the text an arrow is stopped at is
        // a question about where the caret is drawn, and under bidi that is
        // not the host's direction -- English in an RTL host, or Hebrew in an
        // LTR one, put the logical start at the far side, so the key pointing
        // into the text jumped to the previous block and the other was stuck.
        if (event.shiftKey || event.altKey || modifier || event.ctrlKey || event.metaKey) {
          return;
        }

        const ends = getSelectionEnds(content);

        if (ends && ends.anchor === ends.focus) {
          const { focus } = ends;
          const blocks = this.#blocks;
          this.#afterDefault(() => this.#checkArrowMove(resolved, event, focus, blocks));
        }

        return;
      }

      default:
    }
  };

  /**
   * Whether the selection's focus end is at the start (`-1`) or end (`1`) of
   * `content`. With `collapsed`, only a caret counts: an arrow over a range
   * collapses it first, which is the browser's to do.
   */
  #focusAtEdge(content: HTMLElement, direction: 1 | -1, collapsed = false): boolean {
    const ends = getSelectionEnds(content);

    if (!ends || (collapsed && ends.anchor !== ends.focus)) {
      return false;
    }

    return direction === -1 ? ends.focus === 0 : ends.focus === (content.textContent ?? '').length;
  }

  /**
   * The column a run of plain ↑/↓ is aiming for, in viewport pixels, and where
   * the run's last press left the caret. Measured from wherever the caret had
   * got to, a short block in between pulled every later block's caret over to
   * its own end. The run goes on only while the caret is still where the last
   * press left it -- a click (`#handleRootPointerDown`), an edit
   * (`#applyBlocks`), the host's own `focus()` or `focusRange()`, a
   * `setDocument`, `setEditable` and `destroy` all start a new one -- and any
   * other key ends it.
   *
   * A run is noted after the browser has had its turn whenever the press was
   * left to it -- inside a block, and off the end of the document -- since
   * only then is the caret where the press left it.
   *
   * The column is aimed for only where the editor moves the caret, out of one
   * host into the next. Inside a host the browser's own line movement stands,
   * by the browser's own column (wherever the caret entered the host, so in
   * any host of more than one line -- a wrapped paragraph, a soft break, a
   * cell, a code block -- entering on a short line pulls it over to that
   * line's end, away from the run's; R5-KEY-1, documented): putting
   * the caret back under the run's column after it undid the browser's move
   * to a block's end, and a run of ↓ through a wrapped paragraph stuck at the
   * start of its last line.
   */
  #goal: { x: number; host: HTMLElement; offset: number } | null = null;

  /** The run's column, when a ↑/↓ from `offset` in `host` continues one. */
  #runGoal(host: HTMLElement, offset: number): number | null {
    const goal = this.#goal;

    return goal && goal.host === host && goal.offset === offset ? goal.x : null;
  }

  /**
   * The column a run of ↑/↓ starting from `offset` aims for: where the caret
   * is drawn.
   *
   * At a soft wrap that is one of two places, and the selection does not say
   * which. Taking the start of the lower line every time -- right for a click
   * there or the line-start key -- meant that after the line-end key on line
   * 1, ↓ ↓ entered the next block at its start. The browser knows, so it is
   * asked (`softWrapLine`); where it cannot be, the lower line's start stands.
   */
  #caretColumn(host: HTMLElement, offset: number): number | null {
    const sides = softWrapSides(host, offset);

    return sides && softWrapLine(host, offset) === 'upper' ? sides.upper.x : caretX(host, offset);
  }

  /** Records where a ↑/↓ left the caret, once it has moved, so the next press continues the run. */
  #noteGoal(x: number | null): void {
    const selection = readSelection(this.#root);
    const node = selection?.focusNode ?? null;
    const host = this.#hostFromNode(node);
    const offset = host && node ? offsetWithin(host, node, selection?.focusOffset ?? 0) : null;

    this.#goal = x === null || !host || offset === null ? null : { x, host, offset };
  }

  /**
   * Work that has to wait for the browser's own action on the key being
   * handled -- a caret move is the default action of a keydown, so it has not
   * happened while the listener runs. Done from a task, from the key's
   * `keyup`, or at the next keydown, whichever is first: a held key repeats
   * without a keyup, faster than a timer can be relied on. `run` answers
   * whether it moved the caret into another host.
   */
  #afterKey: { run: () => boolean | void; timer: number | undefined } | null = null;

  #afterDefault(run: () => boolean | void): void {
    this.#flushAfterKey();
    const timer = this.#document.defaultView?.setTimeout(this.#flushAfterKey, 0);

    this.#afterKey = { run, timer };
  }

  #cancelAfterKey(): void {
    if (this.#afterKey?.timer !== undefined) {
      this.#document.defaultView?.clearTimeout(this.#afterKey.timer);
    }

    this.#afterKey = null;
  }

  /** Runs the pending work now; true when it moved the caret into another host. */
  #flushAfterKey = (): boolean => {
    const pending = this.#afterKey;

    if (!pending) {
      return false;
    }

    this.#cancelAfterKey();
    return pending.run() === true;
  };

  /**
   * Whether a plain ↑/↓ leaves `content` rather than moving within it: a caret
   * on its first or last line as laid out, wrapped lines included. The browser
   * only moves the caret to the start or end of a host from its edge line, so
   * waiting for it to get there cost a second press at every block. Where no
   * layout can be read the caret has to be at the edge itself.
   *
   * At a soft wrap the offset is the end of one line and the start of the
   * next, so which line the caret is on is asked of the browser
   * (`softWrapLine`): the upper side of the first wrap is the first line, the
   * lower side of the last wrap the last. Left to the browser there, it moved
   * the caret to the block's end, a press spent going nowhere visible. Where
   * the browser cannot say, the wrap is no edge line and the browser moves.
   */
  #leavesHost(content: HTMLElement, direction: 1 | -1): boolean {
    const ends = getSelectionEnds(content);

    if (!ends || ends.anchor !== ends.focus) {
      return false;
    }

    const side = softWrapLine(content, ends.focus);

    return (
      isOnEdgeLine(content, ends.focus, direction, side) ??
      this.#focusAtEdge(content, direction, true)
    );
  }

  /**
   * ↑/↓ out of a host: into the row above or below in a table, else into the
   * nearest visible block that holds a caret, keeping the caret's horizontal
   * position as nearly as the target's text allows. Entering a table lands in
   * its first row going down and its last row going up, in the column under
   * the caret -- not in the header cell a block id resolves to.
   *
   * `x` is the column being aimed for: the caret's own at the start of a run
   * of vertical moves (`#goal`), not wherever the last block clamped it to.
   */
  #moveCaretVertically(
    resolved: ResolvedTarget,
    direction: 1 | -1,
    event: KeyboardEvent,
    x: number | null,
  ): void {
    const { block, cell } = resolved;
    let target: { id: string; cell?: CellCoords };

    if (cell && block.rows?.[cell.row + direction]) {
      const row = cell.row + direction;
      target = {
        id: block.id,
        cell: { row, column: this.#columnAt(block.id, row, x, cell.column) },
      };
    } else {
      // Hidden blocks are not places a caret can go.
      const visible = this.#visible();
      const index = findBlockIndex(visible, block.id);

      if (index === -1) {
        return;
      }

      const slice = direction === -1 ? visible.slice(0, index).reverse() : visible.slice(index + 1);
      const next = slice.find((candidate) => !isVoidType(candidate.type));

      if (!next) {
        this.#leaveTrailingBlock(block, direction, event, slice.length > 0);
        return;
      }

      const rows = next.rows;

      if (isTableType(next.type) && rows && rows.length > 0) {
        const row = direction === 1 ? 0 : rows.length - 1;
        target = { id: next.id, cell: { row, column: this.#columnAt(next.id, row, x, 0) } };
      } else {
        target = { id: next.id };
      }
    }

    event.preventDefault();
    const edge = direction === 1 ? 0 : CARET_END;

    if (!this.focusRange(target.id, edge, edge, target.cell)) {
      return;
    }

    const host = this.#hostFor(target.id, target.cell);

    if (host && x !== null) {
      this.#placeCaretAtX(host, x, direction === 1 ? 'first' : 'last');
    }
  }

  /**
   * Moves the caret to the point on `host`'s first or last line nearest to
   * `x`. Measured after the host has been focused and scrolled into view,
   * because a caret can only be hit-tested on screen; when the point resolves
   * anywhere but this host the caret stays where focusing put it. Past the
   * end of a wrapped first line the point is the wrap, and the caret is drawn
   * at the end of that line, not the start of the next (`placeCaretOnLine`).
   */
  #placeCaretAtX(host: HTMLElement, x: number, line: 'first' | 'last'): void {
    const y = lineMiddle(host, line);

    if (y === null) {
      return;
    }

    const rect = host.getBoundingClientRect();
    const clamped = Math.min(Math.max(x, rect.left + 1), rect.right - 1);
    const point = this.#caretFromPoint(clamped, y);
    const offset = point ? offsetWithin(host, point.node, point.offset) : null;

    if (offset !== null) {
      placeCaretOnLine(host, offset, line === 'first' ? 'upper' : 'lower');
    }
  }

  /** The column of `row` whose cell is nearest `x`, or `fallback` unmeasured. */
  #columnAt(id: string, row: number, x: number | null, fallback: number): number {
    const cells = this.#renderer.getView(id)?.cells?.[row];

    if (x === null || !cells) {
      return fallback;
    }

    let best = fallback;
    let distance = Number.POSITIVE_INFINITY;

    cells.forEach((cellHost, column) => {
      const rect = (cellHost.closest('td, th') ?? cellHost).getBoundingClientRect();

      if (rect.width === 0 && rect.height === 0) {
        return;
      }

      const away = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;

      if (away < distance) {
        best = column;
        distance = away;
      }
    });

    return best;
  }

  /**
   * After the browser's own ←/→: if the caret did not move and is at a
   * logical end of its host's text, it steps into the neighbouring host.
   * Returns whether it did, for the keydown that may be flushing this check.
   *
   * Which neighbour is the logical direction the browser could not go: stuck
   * at the end of the text it was moving forward, at the start backward --
   * wherever on screen bidi has drawn those ends. An empty host, which is
   * both, asks the key, in the host's base direction.
   *
   * Stuck mid-text it stays, whatever the reason. The offset is all the DOM
   * says, and it stays the same where Firefox's ← takes the caret from the
   * start of a wrapped line to the end of the line above: reading that as a
   * caret held against the drawn end of a line took it out of the block at
   * every soft wrap. Mixed-direction text whose logical end one key never
   * reaches is the price -- the other arrow, or ↑/↓, still leaves.
   */
  #checkArrowMove(
    resolved: ResolvedTarget,
    event: KeyboardEvent,
    offset: number,
    blocks: Block[],
  ): boolean {
    const { content } = resolved;

    // Someone else took the key, the document changed meanwhile, or the
    // host is gone: what the caret did is no longer this key's answer.
    if (
      event.defaultPrevented ||
      !this.#canEdit() ||
      this.#blocks !== blocks ||
      !content.isConnected
    ) {
      return false;
    }

    const ends = getSelectionEnds(content);

    if (!ends || ends.anchor !== ends.focus || ends.focus !== offset) {
      return false;
    }

    const length = (content.textContent ?? '').length;
    let direction: 1 | -1;

    if (length === 0) {
      const rtl = this.#document.defaultView?.getComputedStyle(content).direction === 'rtl';
      direction = (event.key === 'ArrowRight') !== rtl ? 1 : -1;
    } else if (offset === length) {
      direction = 1;
    } else if (offset === 0) {
      direction = -1;
    } else {
      return false;
    }

    return this.#stepCaretAcross(resolved, direction);
  }

  /**
   * ←/→ off the logical edge of a host: to the start of the next host that
   * holds a caret, or the end of the previous one. A table's cells are hosts
   * in reading order; dividers and other blocks with no caret are stepped over.
   * Returns whether the caret landed there.
   */
  #stepCaretAcross(resolved: ResolvedTarget, direction: 1 | -1): boolean {
    const hosts: { id: string; cell?: CellCoords }[] = [];

    for (const candidate of this.#visible()) {
      const view = this.#renderer.getView(candidate.id);
      const cells = view?.cells;

      if (isTableType(candidate.type) && cells) {
        cells.forEach((row, r) =>
          row.forEach((_, column) => hosts.push({ id: candidate.id, cell: { row: r, column } })),
        );
      } else if (view?.content && !isVoidType(candidate.type)) {
        hosts.push({ id: candidate.id });
      }
    }

    const here = hosts.findIndex(
      (host) => host.id === resolved.block.id && sameCell(host.cell, resolved.cell),
    );
    const target = here === -1 ? undefined : hosts[here + direction];

    if (!target) {
      return false;
    }

    const offset = direction === 1 ? 0 : CARET_END;
    return this.focusRange(target.id, offset, offset, target.cell);
  }

  #insertSoftBreak(block: Block, content: HTMLElement): void {
    const range = getSelectionRange(content) ?? { start: 0, end: 0 };
    const trimmed = richDelete(block.content, range.start, range.end);
    const next = richInsert(
      trimmed,
      range.start,
      richFromPlainText('\n', richMarksAt(trimmed, range.start)),
    );

    this.#commitContent(block.id, next);
    this.#placeAfterBreak(block.id, range.start + 1);
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

    // At the very start of a block that has text, Enter pushes the block down
    // and opens an empty line above it. Splitting there made the *empty* half
    // the original: a heading's text came out as a paragraph, a checked
    // to-do's text lost its check to the empty line above, an image caption
    // moved out of its image. The block -- id, type, payload -- stays with its
    // text, and the caret stays at its start.
    if (range.start === 0 && !isRichEmpty(trimmed)) {
      const index = findBlockIndex(this.#blocks, block.id);
      const opened = createBlock(typeAfterSplit(block.type), [], block.depth);
      let blocks = updateBlock(this.#blocks, block.id, { content: trimmed });
      blocks = insertBlockAt(blocks, index, opened);

      this.#commit(blocks);
      this.focus(block.id, 0);
      return;
    }

    const [before, after] = richSplit(trimmed, range.start);

    // A callout or toggle owns what follows it, so Enter opens a child -- one
    // way to put the first block inside an empty one (Tab is another, and so
    // is pasting several blocks after the start of its title). Not
    // past the deepest level a document holds: born at 33, the child was a
    // sibling once `normalizeDocument` clamped it on the next load.
    const nested = acceptsChildren(block.type) && block.depth < MAX_DEPTH;
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
    // Outdent before any destructive edit -- with whatever the block hides, as
    // Shift+Tab does. Outdenting the one block left a collapsed toggle's
    // children where they were, nested under each other out of sight.
    if (block.depth > 0) {
      this.#commit(
        keepVisible(
          this.#blocks,
          indentBlocks(this.#blocks, withHiddenDescendants(this.#blocks, [block.id]), -1),
        ),
      );
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
      this.#commit(keepVisible(this.#blocks, removeBlock(this.#blocks, previous.id)));
      this.focus(block.id, 0);
      return;
    }

    // A table or an image cannot absorb text. Select it instead of destroying it.
    if (!canMergeText(previous.type)) {
      // An empty line has no text to protect, so it goes, in the same step:
      // left in place, the next Backspace deleted the picture and the empty
      // line stayed -- the opposite of what two presses ask for.
      if (isRichEmpty(block.content)) {
        this.#commit(keepVisible(this.#blocks, removeBlock(this.#blocks, block.id)));
      }

      this.#setBlockSelection([previous.id], previous.id);
      return;
    }

    const joinAt = richLength(previous.content);
    // Into what the receiving block can hold: a code block or an equation
    // takes the text and not its formatting, as every other way in does.
    let blocks = updateBlock(this.#blocks, previous.id, {
      content: contentForType(previous.type, richConcat(previous.content, block.content)),
    });
    // No re-clamp here, unlike `#deleteAtEnd`: this path is only ever reached
    // at depth 0 — anything deeper outdents above rather than merging — and
    // removing a depth-0 block leaves its successor at depth 1 at most, which
    // any predecessor can carry.
    blocks = keepVisible(this.#blocks, removeBlock(blocks, block.id));

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
      this.#commit(keepVisible(this.#blocks, normalizeDepths(removeBlock(this.#blocks, next.id))));
      this.focus(block.id, CARET_END);
      return;
    }

    // A table or an image holds no mergeable text; selecting it is the only
    // non-destructive reading of Delete here.
    if (!canMergeText(next.type)) {
      // As Backspace does after one: an empty text line in front of it goes
      // in the same step. Only a line -- an image's empty caption is a whole
      // picture, and an empty toggle or callout is still its children's parent.
      if (isRichEmpty(block.content) && canMergeText(block.type) && !acceptsChildren(block.type)) {
        this.#commit(
          keepVisible(this.#blocks, normalizeDepths(removeBlock(this.#blocks, block.id))),
        );
      }

      this.#setBlockSelection([next.id], next.id);
      return;
    }

    const joinAt = richLength(block.content);
    let blocks = updateBlock(this.#blocks, block.id, {
      content: contentForType(block.type, richConcat(block.content, next.content)),
    });
    // Deleting the neighbour takes its depth step with it: anything nested
    // under it is left more than one level below this block, which is exactly
    // the state `normalizeDepths` exists to make impossible.
    blocks = keepVisible(this.#blocks, normalizeDepths(removeBlock(blocks, next.id)));

    this.#commit(blocks);
    this.focus(block.id, joinAt);
  }

  /**
   * ↓ off the last block that can hold a caret, when the keyboard has no other
   * way below it.
   *
   * Enter inside a code block or a table cell is a line break, so a document
   * ending in one gave the keyboard no way below it: only a click under the
   * last block opened a paragraph. A document ending in a divider was the same
   * -- the caret cannot stop on one, so ↓ never got past it -- and so is one
   * whose last block is a divider selected as a block. Arrowing off the end
   * opens that same paragraph. Any other trailing block is left by Enter
   * already, and grows nothing here.
   */
  #leaveTrailingBlock(
    block: Block | undefined,
    direction: 1 | -1,
    event: KeyboardEvent,
    passesVoid: boolean,
  ): void {
    if (
      direction !== 1 ||
      !block ||
      (!passesVoid && block.type !== 'code' && !isTableType(block.type)) ||
      !this.#canEdit()
    ) {
      return;
    }

    event.preventDefault();
    this.#openTrailingParagraph();
  }

  /** Appends an empty paragraph and puts the caret in it, as one undo step. */
  #openTrailingParagraph(): void {
    const created = createBlock('paragraph');
    this.#commit([...this.#blocks, created]);
    this.focus(created.id, 0);
  }

  /**
   * The editor's own resolved direction: computed, so a `dir` on any ancestor
   * and a CSS `direction` both count.
   */
  #direction(): 'ltr' | 'rtl' {
    return this.#document.defaultView?.getComputedStyle(this.#root).direction === 'rtl'
      ? 'rtl'
      : 'ltr';
  }

  /**
   * Portals render outside the editor and inherit nothing from it, direction
   * included: in a right-to-left editor every menu, toolbar and dialog laid
   * itself out left to right. The direction is copied over on focus and again
   * as each portal opens, so a host that flips `dir` while the editor already
   * has focus is followed too. One computed-style read each time.
   */
  #syncPortalDirection(): void {
    const dir = this.#direction();

    for (const portal of this.#portals) {
      portal.dir = dir;
    }
  }

  #handleFocusIn = (event: FocusEvent): void => {
    this.#syncPortalDirection();
    const resolved = this.#resolve(event.target);

    // Focus moved into a block's text by the keyboard or a screen reader -- no
    // pointer involved -- is the reader choosing that text, so the block
    // selection ends rather than a stray-caret check taking it back (see
    // #takeStrayCaretOut, which is for carets the browser puts back itself).
    if (
      resolved &&
      this.#selected.size > 0 &&
      (this.#placingFocus ||
        (!this.#pointerDown && this.#now() - this.#pointerReleasedAt > POINTER_FOCUS_GRACE_MS))
    ) {
      this.#clearBlockSelection();
    }

    if (resolved) {
      this.#emitter.emit('focus', { blockId: resolved.block.id });
    }

    // A block's own control taking focus -- the chevron, the callout icon, the
    // image trigger, reached by Tab -- is not text. WebKit leaves the document
    // selection in the host focus came from, and the next printable key was
    // typed there: Tab onto a callout's icon, type `W`, and the block above
    // read "BeforeW". The control owns the keys now, so the range is set aside
    // -- and handed back when focus returns from that control to that host,
    // as Shift+Tab does: dropped outright, the caret every engine keeps on
    // its own came back at offset 0, and a range came back as a caret.
    const aside = this.#asideSelection;
    const control = asElement(event.target)?.closest('button');

    this.#asideSelection = null;

    if (control && !resolved && this.#renderer.blockIdFromNode(control)) {
      const reading = readSelection(this.#root);
      const host = reading ? this.#hostFromNode(reading.anchorNode) : null;

      if (reading && host) {
        this.#asideSelection =
          host === this.#hostFromNode(reading.focusNode)
            ? {
                control,
                host,
                anchorNode: reading.anchorNode,
                anchorOffset: reading.anchorOffset,
                focusNode: reading.focusNode,
                focusOffset: reading.focusOffset,
              }
            : null;
        this.#selection()?.removeAllRanges();
      }

      return;
    }

    // Back from that control into that host, by the keyboard: the pointer
    // places its own caret, and wins.
    if (
      aside &&
      resolved?.content === aside.host &&
      event.relatedTarget === aside.control &&
      !this.#pointerDown &&
      aside.host.contains(aside.anchorNode) &&
      aside.host.contains(aside.focusNode)
    ) {
      this.#selection()?.setBaseAndExtent(
        aside.anchorNode,
        aside.anchorOffset,
        aside.focusNode,
        aside.focusOffset,
      );
    }
  };

  /** The range a block control set aside on taking focus; see `#handleFocusIn`. */
  #asideSelection: {
    control: Element;
    host: HTMLElement;
    anchorNode: Node;
    anchorOffset: number;
    focusNode: Node;
    focusOffset: number;
  } | null = null;

  /**
   * Focus leaving the editor for somewhere else on the page.
   *
   * The toolbars are drawn from `selectionchange`, and WebKit fires none when
   * focus goes to an outside `<input>`: the format toolbar stayed on screen,
   * its buttons acting on a selection the reader had left. Firefox and WebKit
   * also leave the caret in a table cell then, so the table toolbar stayed
   * too (and `#syncTableToolbar` asks for focus, since Firefox goes on firing
   * `selectionchange` for the field). A move into one of the
   * editor's own portals is still the editor, and a null target -- the window
   * itself losing focus -- is not a choice of anywhere, so both keep it.
   */
  #handleRootFocusOut = (event: FocusEvent): void => {
    // Focus leaving the host it was typed into, by any route.
    this.#typingOver = null;

    const next = isNode(event.relatedTarget) ? event.relatedTarget : null;

    if (
      !next ||
      this.#root.contains(next) ||
      this.#portals.some((portal) => portal.contains(next))
    ) {
      return;
    }

    this.#hideToolbars();
  };

  /**
   * Focus leaving one of the toolbars for somewhere else on the page.
   *
   * F10 puts focus in the table toolbar, outside the root, so
   * `#handleRootFocusOut` has already run and the next move out -- a click on
   * a page field, Tab past the toolbar -- is heard by nothing on the root: the
   * toolbar stayed drawn, and its buttons edited the table the reader had left
   * and pulled focus back into it. The same test as the root's: a move back
   * into the editor or another portal keeps it.
   *
   * A null target is either the window losing focus, which must keep it, or
   * Tab past the end of the page into the browser's own controls (where
   * Chromium leaves the toolbar last in the page). The two are told apart
   * once the move is over: a window switch leaves the element focused within
   * its document, and Tab out leaves none of the editor's focused at all.
   *
   * A target retargeted to a shadow host around the editor -- focus going
   * back into a cell from a portal in the body, Escape from the toolbar --
   * reads as leaving, and hides the toolbars; the cell's own `focusin` draws
   * them again for the selection it receives (`#handleToolbarFocusIn`).
   */
  #handleToolbarFocusOut = (event: FocusEvent): void => {
    const next = isNode(event.relatedTarget) ? event.relatedTarget : null;
    const ours = (node: Node | null | undefined) =>
      !!node &&
      (this.#root.contains(node) || this.#portals.some((portal) => portal.contains(node)));

    if (next) {
      if (!ours(next)) {
        this.#hideToolbars();
      }

      return;
    }

    const left = asElement(event.currentTarget);

    left?.ownerDocument.defaultView?.setTimeout(() => {
      const tree = left.getRootNode() as Document | ShadowRoot;

      if (!this.#destroyed && !ours(tree.activeElement) && !ours(this.#activeElement())) {
        this.#hideToolbars();
      }
    }, 0);
  };

  /**
   * Focus arriving anywhere outside one of the dialogs -- the link, image and
   * icon popovers -- while it is open.
   *
   * They are portals, so Tab and Shift+Tab walk straight out of them into the
   * page or back into the document, and nothing was listening: the dialog
   * stayed open and owned, and a later Apply linked the range it had saved,
   * even over text typed since. Leaving by keyboard is the same choice as
   * leaving by pointer (`#handleDocumentPointerDown`), so it closes the same
   * way, without handing focus back -- the reader has just put it somewhere.
   * Asked where focus lands rather than where it left: Tab past the end of the
   * page leaves for the browser's own controls with no target to name, which
   * looks exactly like switching windows, and only the second must keep the
   * dialog. Where focus comes back tells them apart: into the dialog again from
   * another window, onto the page from the browser's controls. The composed
   * path, because inside a shadow root the document sees only the host.
   */
  #handleDocumentFocusIn = (event: FocusEvent): void => {
    const path = composedTargets(event);

    for (const [dialog, close] of [
      [this.#linkEditor, () => this.#closeLinkEditor(false)],
      [this.#imageEditor, () => this.#closeImageEditor(false)],
      [this.#iconPicker, () => this.#closeIconPicker(false)],
    ] as const) {
      if (dialog.isOpen && !path.some((node) => dialog.contains(node))) {
        close();
      }
    }
  };

  /**
   * A press anywhere in the editor that is not on one of the gutter's controls.
   *
   * Inside an editing host the browser places the caret itself. Everywhere else
   * -- the root's padding, the gap or margin between two blocks, a list marker,
   * a table's border, a block's own gutter padding, the gutter's own background
   * -- the browser's default is to focus the root and place nothing, which is
   * neither mode: every key falls on the floor. So a plain primary press there
   * is given the caret the reader was aiming at, in the block nearest the
   * pointer, and a drag of its own from that caret (`#armPlacedTextDrag`): the
   * default it cancels is also the browser's drag selection. Only a press below
   * the last block starts a new paragraph: treating every press on the root as
   * one appended a block to the end of the document and scrolled there from a
   * click in the band above a heading. A press on a scrollbar is the
   * scroller's; a right or middle press places nothing, where it moved the
   * caret away from the range a context menu was opened for; and Shift extends
   * the range the reader already has rather than replacing it.
   */
  #handleRootMouseDown = (event: MouseEvent): void => {
    // How many clicks the press is, which only its mousedown says: a text
    // drag the editor draws selects by the same unit (`TextDrag.detail`).
    if (this.#textDrag) {
      this.#textDrag.detail = event.detail;
    }

    // Any click repositions the caret, which ends the current typing run --
    // and a link continuation with it, even a click at the very same offset.
    this.#history.breakRun();
    this.#typingOver = null;
    this.#contextSelection = null;

    const node = isNode(event.target) ? event.target : null;
    const control = asElement(node)?.closest('button');

    // The gutter's controls have their own selection semantics; do not undo
    // them here. Its background is only space beside the text, like the
    // block's own padding next to it. They have no menu of their own, though:
    // a right-click on the handle is one beside the text like any other.
    if (control && this.#gutter.contains(control)) {
      if (event.button !== 0) {
        this.#holdForContextMenu(event);
      }

      return;
    }

    // The to-do's checkbox acts and changes nothing else: its own mousedown
    // keeps focus where it was, so the caret -- or the block selection --
    // the reader had is still theirs. Clearing the selection here left the
    // root focused with neither.
    if (control?.classList.contains('neditor-block__checkbox')) {
      return;
    }

    // Dragging a wide table's scrollbar, or clicking its track, moved the
    // caret into a cell; in a root that scrolls itself, into whatever block
    // was level with the press. Cancelled all the same: the scrollbar still
    // moves, but the press no longer focuses the root it belongs to, which in
    // Chromium left the caret drawn in its block with every key going to
    // the root.
    if (onScrollbar(event)) {
      event.preventDefault();
      return;
    }

    // A primary Shift press on a host, in an editable view, not by touch. The
    // reader's caret or range in a host of this editor that holds focus is
    // the one Shift extends -- in its own host only: Shift extends a range
    // within its own host and otherwise leaves it, so a press on another
    // host (another table cell too) does nothing, and no drag follows it;
    // neither press, extended or cancelled, is a link click (`#shiftPress`).
    // Left to the browser, Chromium and
    // WebKit grew the reader's range to the edge of its own block facing the
    // press ("Alpha" became "Alpha one", and the next key deleted text never
    // selected), Firefox dropped it for a caret at the other block's start,
    // and a drag from there drew a range the reader never anchored
    // (R13-RV9-PTR-2). With no such range -- focus left the editor (a page
    // button) with a stale range in it, the selection is outside the
    // editor (the link editor's field), a block selection, nothing at all --
    // there is nothing of the reader's to extend, and the press is a plain
    // one: the caret at the press and a drag from it, in every engine.
    // Left to the browser, a stale range swallowed the press and the next
    // key, and Firefox put the caret at the start of the block pressed from
    // the link editor, where Backspace merged it into the block above
    // (R13-RV10-PTR-3, -4). A read-only view keeps the browser's own Shift:
    // its selection crosses blocks, and the native extension is promoted
    // to a block selection at the release.
    const pressed = this.#hostFromNode(node);
    const link = asElement(node)?.closest('a.neditor-link') ?? null;
    const followed = link !== null && (event.metaKey || event.ctrlKey);

    // A ⌘/Ctrl+Shift+click on a link follows it, as ⌘/Ctrl+click does: it is
    // neither Shift path below, and its click is not a Shift press's.
    if (
      pressed &&
      event.shiftKey &&
      !followed &&
      event.button === 0 &&
      this.#editable &&
      this.#press?.pointerType !== 'touch'
    ) {
      const held = this.#selectionTarget();

      if (held && this.#typingIn(held.content)) {
        this.#shiftPress = true;

        if (held.content !== pressed) {
          event.preventDefault();
          this.#textDrag = null;
          return;
        }

        // On a link in its own host every engine puts a caret at the press
        // instead of extending, so the editor extends the range there itself,
        // and draws a drag from its anchor as for a press beside the text.
        const blockId = this.#renderer.blockIdFromNode(pressed);

        if (blockId && link) {
          event.preventDefault();
          this.#extendSelectionNear(blockId, event.clientX, event.clientY, node);
          this.#armPlacedTextDrag(blockId, event.clientX, event.clientY);
          return;
        }
      } else {
        // `#placeCaretNear` ends a block selection as the caret lands, and a
        // caret that cannot land leaves it, as any focus that fails does.
        const blockId = this.#renderer.blockIdFromNode(pressed);
        event.preventDefault();

        if (blockId && this.#placeCaretNear(blockId, event.clientX, event.clientY, node)) {
          this.#armPlacedTextDrag(blockId, event.clientX, event.clientY);
        } else {
          this.#textDrag = null;
        }

        return;
      }
    }

    // A read-only view's Shift press on a host extends the reader's range
    // natively, and the release promotes it across blocks (above) -- only a
    // range in a block: in its text, or the caret a click on a divider or a
    // picture leaves in it, outside every host (taken out, the Shift+click
    // after it selected nothing, R14-RV8-2). With none, it is a plain press: a
    // block selection let go of the DOM selection and focused the root, and
    // WebKit keeps a caret of its own there, in no block; its Shift+click
    // extended from it, and the release left a range of 1,073 characters
    // from the root to the block pressed, beside no block selection, which
    // the next Shift+arrow grew on past the editor. Chromium and Firefox
    // extend from nothing. Taken out before the browser's default action, the
    // press has nothing to extend in any engine.
    if (pressed && event.shiftKey && !this.#editable) {
      const reading = readSelection(this.#root);

      if (
        reading &&
        this.#root.contains(reading.anchorNode) &&
        !this.#renderer.blockIdFromNode(reading.anchorNode)
      ) {
        this.#selection()?.removeAllRanges();
      }
    }

    // The other controls (chevron, callout icon, image trigger) act on their
    // own click and say where focus goes; text inside a host is the browser's.
    // Either is a return to text editing.
    if (control || pressed) {
      this.#clearBlockSelection();
      return;
    }

    // From here the press missed every host. Only the primary button means
    // "put the caret there".
    if (event.button !== 0) {
      this.#holdForContextMenu(event);
      return;
    }

    if (!this.#editable) {
      this.#clearBlockSelection();
      return;
    }

    const aim = this.#aimForPress(node, event.clientY);
    const held = event.shiftKey ? this.#selectionTarget() : null;

    // A Shift press beside the text extends the reader's range in its own
    // host and leaves it anywhere else -- rule (a) above. With no caret or
    // range being typed in, it is a plain press, as rule (b) makes one on a
    // host: the start of a list item for its marker, the nearest cell for a
    // table's border, a paragraph below the last block. Taken down this
    // path, `#extendSelectionNear` found no range, and the press and the next
    // key went nowhere (R13-RV11-PTR-3).
    if (held && this.#typingIn(held.content)) {
      event.preventDefault();

      if (aim) {
        this.#extendSelectionNear(aim, event.clientX, event.clientY, node);
      }

      return;
    }

    // Clicking into the document is a return to text editing.
    this.#clearBlockSelection();

    if (aim) {
      event.preventDefault();

      if (this.#placeCaretNear(aim, event.clientX, event.clientY, node)) {
        this.#armPlacedTextDrag(aim, event.clientX, event.clientY);
      }

      return;
    }

    if (node !== this.#root && !this.#gutter.contains(node)) {
      return;
    }

    const last = this.#visible().at(-1);

    // `#aimForPress` answers for every press level with a block or above the
    // first one, so this one is below the last block.
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

  /**
   * A right or middle press outside every host: it places nothing, and the
   * range the reader has is set aside for `#handleContextMenu` to put back.
   * WebKit selects the word nearest a right-click before it dispatches
   * `contextmenu`, whatever its mousedown said.
   */
  #holdForContextMenu(event: MouseEvent): void {
    if (!this.#editable) {
      return;
    }

    event.preventDefault();

    const reading = readSelection(this.#root);

    this.#contextSelection =
      reading && this.#hostFromNode(reading.anchorNode)
        ? {
            anchorNode: reading.anchorNode,
            anchorOffset: reading.anchorOffset,
            focusNode: reading.focusNode,
            focusOffset: reading.focusOffset,
          }
        : null;
  }

  /** The range a right or middle press outside every host found, to keep. */
  #contextSelection: {
    anchorNode: Node;
    anchorOffset: number;
    focusNode: Node;
    focusOffset: number;
  } | null = null;

  /**
   * Puts back the range a context-menu press outside every host replaced.
   *
   * Its mousedown is cancelled, which keeps the caret in Firefox; WebKit
   * selects the word nearest the press anyway, between that mousedown and
   * this event, so the menu opened for the reader's range was about a word in
   * another block. Restored before the menu reads it.
   *
   * Chromium does its own selecting later, in this event's default action --
   * after every listener has run -- and with a press on the root's padding or
   * the gutter's background it chose a range that began outside the editor
   * altogether: focus stayed in the block, the selection was no host's, and
   * every key after it was lost. Or one from one block into the next, which
   * the release then promoted to a block selection. So the range is put back
   * once more after that default has run -- at the release, before anything
   * reads the selection, or in a task if no release comes first (where
   * `contextmenu` follows the release) -- if the selection is not the one held
   * and nothing has pressed since. The menu itself was already built for
   * Chromium's range; the reader's next key at least lands where they left it.
   *
   * That second restore is only for Chromium's default, and only while the
   * reader is still in the text. A page with a menu of its own cancels the
   * event -- so the default never runs -- and often moves focus into that
   * menu, a search field or its first item: putting the range back there
   * pulled focus into the editor a moment later, and the reader's typing
   * replaced their range. So it is skipped once the event was cancelled, and
   * whenever the host the range was in no longer holds focus.
   */
  #handleContextMenu = (event: MouseEvent): void => {
    const held = this.#contextSelection;

    this.#contextSelection = null;

    if (!held || this.#hostFromNode(isNode(event.target) ? event.target : null)) {
      return;
    }

    const heldHost = this.#hostFromNode(held.anchorNode);

    const restore = () => {
      if (!held.anchorNode.isConnected || !held.focusNode.isConnected) {
        return;
      }

      const reading = readSelection(this.#root);

      if (
        reading &&
        reading.anchorNode === held.anchorNode &&
        reading.anchorOffset === held.anchorOffset &&
        reading.focusNode === held.focusNode &&
        reading.focusOffset === held.focusOffset
      ) {
        return;
      }

      this.#selection()?.setBaseAndExtent(
        held.anchorNode,
        held.anchorOffset,
        held.focusNode,
        held.focusOffset,
      );
    };

    restore();

    const view = this.#document.defaultView;

    if (!view) {
      return;
    }

    const pending = () => {
      if (this.#contextRestore === pending) {
        this.#contextRestore = null;

        if (
          !this.#destroyed &&
          !event.defaultPrevented &&
          heldHost &&
          this.#activeElement() === heldHost
        ) {
          restore();
        }
      }
    };

    this.#contextRestore = pending;
    view.setTimeout(pending, 0);
  };

  /**
   * The pending second restore of `#handleContextMenu`, run once: by the
   * release (`#handlePointerUp`) or its own task, whichever comes first. A
   * later press clears it, since the reader has moved on.
   */
  #contextRestore: (() => void) | null = null;

  /**
   * The block a press that missed every host was aimed at, or null for a
   * press below the last block (or on nothing of the editor's).
   *
   * A press inside a block's own box is that block's. One on the root or the
   * gutter's background is level with a block, or above the first one, and
   * means the text that is already there -- the nearest block that holds any.
   */
  #aimForPress(node: Node | null, clientY: number): string | null {
    const onGround = node === this.#root || this.#gutter.contains(node);

    if (!onGround) {
      return this.#renderer.blockIdFromNode(node) ?? null;
    }

    const visible = this.#visible();
    const last = visible.at(-1);
    const lastBottom = last
      ? this.#renderer.getView(last.id)?.root.getBoundingClientRect().bottom
      : undefined;

    if (lastBottom === undefined || clientY >= lastBottom) {
      return null;
    }

    return this.#nearestBlockAtY(
      visible.filter((block) => !isVoidType(block.type)),
      clientY,
    );
  }

  /**
   * Gives a press the editor placed the caret for a drag of its own.
   *
   * Its mousedown was cancelled, and with it the browser's drag selection:
   * dragging from a list marker or the band above a heading selected nothing,
   * and a drag that crossed into another block and came back stayed a block
   * selection, since `#returnTextDrag` had no host to return to. The drag is
   * anchored at the caret just placed, so it behaves like one that began in
   * that text. Not for touch, as in `#handleRootPointerDown`. It stays a click
   * until it has travelled `DRAG_THRESHOLD_PX` from the press at `x`, `y`.
   */
  #armPlacedTextDrag(blockId: string, x: number, y: number): void {
    const press = this.#press;
    const reading = readSelection(this.#root);
    const host = reading ? this.#hostFromNode(reading.anchorNode) : null;

    if (
      !press ||
      press.pointerType === 'touch' ||
      !this.#pointerDown ||
      !reading ||
      !host ||
      this.#renderer.blockIdFromNode(host) !== blockId
    ) {
      return;
    }

    this.#textDrag = {
      anchorBlockId: blockId,
      pointerId: press.pointerId,
      currentId: blockId,
      anchorHost: host,
      anchorPoint: { node: reading.anchorNode, offset: reading.anchorOffset },
      anchorPending: false,
      shift: false,
      anchorEnd: null,
      promoted: false,
      returned: false,
      placed: true,
      startX: x,
      startY: y,
      still: true,
      detail: 1,
      unit: null,
      unitRead: false,
      heldRange: null,
      lastFocus: null,
      missed: false,
    };
  }

  /**
   * Shift+press outside every host: the range the reader has, grown to the
   * text nearest the press when that is in the host it is in. Anywhere else it
   * stays as it was -- collapsing it to a caret threw away the selection the
   * press was meant to extend.
   */
  #extendSelectionNear(blockId: string, x: number, y: number, pressed: Node | null): void {
    const current = this.#selectionTarget();
    const aim = this.#caretNear(blockId, x, y, pressed);

    if (!current || !aim || aim.target.content !== current.content) {
      return;
    }

    // From the end of the reader's range farther from the press, without
    // asking the range its direction: a range the press falls outside of is
    // kept whole and grows to it, whichever way it was made -- Chromium's and
    // Safari's own Shift+click on macOS. Firefox's own plain-text Shift+click
    // keeps the range's anchor, so there the two differ: kept, since the
    // farther end never drops the reader's selected text and needs no
    // asking which browser it is (R13-RV13-PTR-3).
    // Kept by its anchor, "te" Shift+clicked on a link before it lost the
    // "te" ([13,15] at 8 gave [8,13]), and WebKit in a shadow root, which
    // reports every range forward, chose its end at random (R13-RV12-PTR-3).
    const { start, end } = current.range;
    const anchor = Math.abs(end - aim.offset) > Math.abs(start - aim.offset) ? end : start;

    this.#focusResolved(
      current,
      Math.min(anchor, aim.offset),
      Math.max(anchor, aim.offset),
      aim.offset < anchor,
      false,
    );
    this.#revealPlacedCaret(current.content);
  }

  /** Of `blocks`, the one whose box is vertically closest to a viewport Y. */
  #nearestBlockAtY(blocks: readonly Block[], clientY: number): string | null {
    let nearest: string | null = null;
    let distance = Number.POSITIVE_INFINITY;

    for (const block of blocks) {
      const rect = this.#renderer.getView(block.id)?.root.getBoundingClientRect();

      if (!rect) {
        continue;
      }

      const away = Math.max(rect.top - clientY, 0, clientY - rect.bottom);

      if (away < distance) {
        nearest = block.id;
        distance = away;
      }
    }

    return nearest;
  }

  /**
   * Puts the caret in a block at the text nearest a viewport point; true when
   * it placed one.
   *
   * For a press that missed every editing host. A divider has no text at all,
   * so the divider itself is selected -- the one thing such a press can still
   * mean.
   */
  #placeCaretNear(blockId: string, x: number, y: number, pressed: Node | null): boolean {
    const aim = this.#caretNear(blockId, x, y, pressed);

    if (!aim) {
      const view = this.#renderer.getView(blockId);

      if (view && !view.content && !view.cells) {
        // Under the pointer: a press reveals nothing (`#selectFromHandle`).
        // A rule cut by the window's edge moved the page 3 to 13px.
        this.#setBlockSelection([blockId], blockId, { reveal: false });
      }

      return false;
    }

    // Not the host revealed: `scrollIntoView` of a host taller than the
    // window, or peeking in at its bottom, moved the page under the pointer
    // -- a Shift press there and a drag from it selected 1,491 characters for
    // six (R13-RV11-PTR-1), and a press in the gutter beside a tall block
    // jumped the page 400px. The caret's own box instead, and only where it
    // is not on screen (`#revealPlacedCaret`): the text nearest a press can
    // be out of sight -- an image's caption below a picture taller than the
    // window, a cell scrolled out of its table -- and left there, the first
    // letter typed jumped the page (R13-RV12-PTR-1).
    this.#focusResolved(aim.target, aim.offset, aim.offset, false, false);
    this.#revealPlacedCaret(aim.target.content);
    return true;
  }

  /**
   * Brings the focus end of the selection a press placed in `host` into
   * view by the least scroll, only where it is not: sideways in each
   * element around it that scrolls across (a table's own), nearest first,
   * then up or down as `#revealBox` does, through every scroller and page
   * around it. A caret already on
   * screen -- under the pointer, as it nearly always is -- moves nothing.
   */
  #revealPlacedCaret(host: HTMLElement): void {
    let box = this.#focusBoxIn(host);

    if (!box) {
      return;
    }

    // Sideways: `clipChainOf` climbs only the scrollers that clip up and
    // down, and a table scrolls on its own across.
    const view = host.ownerDocument.defaultView;
    const across: HTMLElement[] = [];

    for (
      let node: Element | null = flatParent(host).parent;
      node && node !== host.ownerDocument.documentElement && node !== host.ownerDocument.body;
      node = flatParent(node).parent
    ) {
      if (
        /auto|scroll|overlay/.test(view?.getComputedStyle(node).overflowX ?? '') &&
        node.scrollWidth > node.clientWidth
      ) {
        across.push(node as HTMLElement);
      }
    }

    for (const scroller of across) {
      // Measured where it is drawn, scrolled in its own layout pixels: under
      // a `transform: scale(0.5)` the drawn distance moved it half as far,
      // and the caret stayed out of sight (R13-RV13-PTR-2).
      const rect = scroller.getBoundingClientRect();
      const drawn = scroller.offsetWidth > 0 ? rect.width / scroller.offsetWidth : 1;
      const left = rect.left + scroller.clientLeft * drawn;
      const right = left + scroller.clientWidth * drawn;
      const delta =
        box.left < left
          ? Math.floor((box.left - left) / drawn)
          : box.right > right
            ? Math.ceil((box.right - right) / drawn)
            : 0;

      if (delta !== 0) {
        const before = scroller.scrollLeft;
        scroller.scrollLeft = before + delta;
        const moved = (scroller.scrollLeft - before) * drawn;
        box = { ...box, left: box.left - moved, right: box.right - moved };
      }
    }

    this.#revealBox(host, box);
  }

  /**
   * The host and text offset nearest a viewport point in a block, or null for
   * a block with no text to hold a caret.
   *
   * A table has one host per cell, so the nearest cell is the one meant; a
   * list marker means the start of its item's text.
   */
  #caretNear(
    blockId: string,
    x: number,
    y: number,
    pressed: Node | null,
  ): { target: ResolvedTarget; offset: number } | null {
    const view = this.#renderer.getView(blockId);
    const hosts = view?.cells ? view.cells.flat() : view?.content ? [view.content] : [];
    let host: HTMLElement | null = null;
    let distance = Number.POSITIVE_INFINITY;

    for (const candidate of hosts) {
      const box = candidate.getBoundingClientRect();
      const dx = Math.max(box.left - x, 0, x - box.right);
      const dy = Math.max(box.top - y, 0, y - box.bottom);

      if (dx * dx + dy * dy < distance) {
        host = candidate;
        distance = dx * dx + dy * dy;
      }
    }

    const target = host ? this.#resolve(host) : null;

    if (!target || !host) {
      return null;
    }

    if (asElement(pressed)?.closest('.neditor-block__marker')) {
      return { target, offset: 0 };
    }

    const point = this.#caretInHost(host, x, y);
    let offset = 0;

    if (point) {
      const probe = host.ownerDocument.createRange();
      probe.selectNodeContents(host);
      probe.setEnd(point.node, point.offset);
      offset = probe.toString().length;
    }

    return { target, offset };
  }

  /**
   * The caret in a host nearest a viewport point, or null when the engine
   * answers with none in it.
   *
   * Pulled inside the host's box, so the engine answers with a position in
   * its text rather than in the gap the pointer is actually over -- and, for
   * a point above or below it, onto the middle of its first or last line: the
   * box's edge pixel is the line's leading, where every engine answers with
   * the start of the text whatever the x. A point beside the host clamps to
   * its edge on that side, which the engine answers with the position drawn
   * at that end of the line: in RTL text the left is the line's logical end.
   * An LTR phrase in an RTL block is the one case that reads oddly -- the
   * empty left of its line is still the block's logical end, and the engines
   * answer with that rather than the phrase's first letter.
   */
  #caretInHost(host: HTMLElement, x: number, y: number): CaretPoint | null {
    const aim = this.#aimInHost(host, x, y);
    const point = this.#caretFromPoint(aim.x, aim.y);

    return point && host.contains(point.node) ? point : null;
  }

  /**
   * The point `#caretInHost` hit-tests for a viewport point: pulled into the
   * host's box, and up or down into the part of it that can be seen -- the
   * host's own window (an iframe mount's frame), cut by the client box of
   * each scroller that clips the editor, inside its border, as that box is
   * drawn on screen (`drawnClientBox`: a pane under a `transform: scale()`
   * or a `zoom` is not drawn at its layout size). Not by the
   * pages around an iframe mount (`#visibleBand`): the frame's own hit
   * test answers for a line the outer window hides, and cut by them too,
   * a drag past the outer window's edge read that same line 4 times in 10
   * and the same range 700 ms on, 9 in 10 (WebKit, measured). A drag
   * carried past
   * the window's edge through a block taller than the window was asked for
   * at a point of its box below the window, where no hit test answers: it
   * missed on every move, and the range stood still -- collapsed, until
   * round 14 -- while the page scrolled on under it, [23,698] for
   * [23,1658] (R14-RV1-2). Pulled into the window only, the same drag past
   * the edge of a pane or a dialog that scrolls the editor was asked for
   * in the text the pane had clipped away -- or on its border -- and
   * missed; and the line a point above or below the block is moved onto
   * was not pulled in at all, so past the first or the last block's own
   * edge it was asked for wherever that line was, out of sight. The range
   * stood still, and so did the pane, since a drag that misses does not
   * scroll (`#runAutoScroll`): 24 to 93px in (R14-RV2-2).
   */
  #aimInHost(host: HTMLElement, x: number, y: number): { x: number; y: number } {
    const rect = host.getBoundingClientRect();
    const lines = (() => {
      const range = host.ownerDocument.createRange();
      range.selectNodeContents(host);
      return [...range.getClientRects()].filter((line) => line.height > 0);
    })();
    const edge = y < rect.top ? lines[0] : y > rect.bottom ? lines.at(-1) : undefined;
    // What can be seen of the host: its own window, cut by each scroller
    // that clips the editor, inside its border, where its content is drawn
    // -- and as it is drawn, at whatever scale (`drawnClientBox`).
    let shownTop = Math.max(rect.top, 0);
    let shownBottom = Math.min(
      rect.bottom,
      host.ownerDocument.defaultView?.innerHeight ?? rect.bottom,
    );

    for (const scroller of this.#clipChain()) {
      const client = drawnClientBox(scroller);

      shownTop = Math.max(shownTop, client.top);
      shownBottom = Math.min(shownBottom, client.bottom);
    }

    return {
      x: Math.min(Math.max(x, rect.left + 1), Math.max(rect.left + 1, rect.right - 1)),
      y: Math.min(
        Math.max(edge ? (edge.top + edge.bottom) / 2 : y, shownTop + 1),
        Math.max(shownTop + 1, shownBottom - 1),
      ),
    };
  }

  /**
   * Whether the page's selection is a range the reader began outside this
   * editor -- in the page's own text, or another editor's -- wherever its
   * focus is. Such a range ends a block selection (`#handleSelectionChange`):
   * left, both were shown,
   * `getSelectedBlocks()` still answered with the blocks, and a drag from
   * that range into them met a block selection that was no longer the
   * reader's (R14-RV4-B2). Asked of a range wholly outside the editor, it
   * held only by timing: a drag from the page's text, or from a second
   * editor, straight into the blocks was first seen with its focus in them,
   * and the blocks stayed beside it (R14-RV5-5). Its anchor decides, read as the page's
   * selection through the editor's shadow root (`readSelectionAnchor`):
   * Chromium's own `ShadowRoot.getSelection()` reports nothing for a range
   * outside the tree, and a page range, one over the editor or Mod+A on the
   * page left the blocks selected in a shadow mount (R14-RV5-2); read
   * retargeted, a read-only drag pressed in a block and carried out of a
   * WebKit shadow root looked begun outside and lost its blocks. Where
   * nothing says which end is the anchor, a range with both ends outside.
   * Only a range: a press that selects nothing -- a click on a host page's
   * button, which reads `getSelectedBlocks()` from its own click -- leaves a
   * caret or nothing, and the blocks stay. The range is the reader's and is
   * left as it is, for Mod+C to copy (R14-RV4-1). A second editor's own
   * drag across its blocks ends them once it has selected text in its first
   * block; one that leaves that block first presents no range in Chromium
   * and Firefox, and ends nothing here (R14-RV9-2).
   */
  #rangeBegunElsewhere(): boolean {
    const reading = readSelectionAnchor(this.#root);

    if (!reading || reading.collapsed) {
      return false;
    }

    return reading.anchor
      ? !this.#root.contains(reading.anchor)
      : !this.#root.contains(reading.start) && !this.#root.contains(reading.end);
  }

  #handleSelectionChange = (event: Event): void => {
    // A field's own: Chromium fires `selectionchange` at an `<input>` or
    // `<textarea>` whose value script sets, Firefox and WebKit at one the
    // reader types in, and it bubbles here. The selection this editor reads
    // is the document's, whose events every engine fires at the document --
    // in every mount, measured. Answered here, a page updating a title drew
    // the toolbar Escape had dismissed, and spent the note of a carry's write
    // before that write's own event came (R13-RV2-PTR-1).
    if (isElement(event.target)) {
      return;
    }

    // What this event found, read before anything answers it: the next write
    // of the editor's asks whether a change is still on its way after it
    // (`#selectionChangePending`), and a write's own event is spent here
    // whatever this handler goes on to do (`#ownSelection`).
    const live = this.#selectionTarget();
    this.#handledSelection = live
      ? { host: live.content, start: live.range.start, end: live.range.end }
      : null;
    const own = this.#takeOwnSelection(live);

    // Focus is in the link or equation input; the block selection is
    // intentionally stale.
    if (this.#linkEditor.isOpen || this.#mathEditor.isOpen) {
      return;
    }

    // A range the reader began outside this editor ends a block selection
    // (`#rangeBegunElsewhere`) -- not one the browser made of a press held
    // in this editor (`#pressInHere`).
    if (this.#selected.size > 0 && !this.#pressInHere && this.#rangeBegunElsewhere()) {
      this.#clearBlockSelection();
      return;
    }

    // A range across blocks with no button down: one an embedder built
    // through the Selection API, or, in a read-only view, the browser's own
    // Shift+arrow across the blocks. An editable view's drags are drawn as
    // they happen and its Shift+arrow at a block edge is `#handleKeyDown`'s;
    // a pointer's range across a read-only view's blocks is read at the
    // release (`#handlePointerUp`), which knows the block the gesture was
    // pressed on. Here no gesture says, so every block the range reaches
    // is in it, one it reaches only at the start of its text too: that is
    // where a read-only Shift+→ crosses a block's end (R14-RV7-1).
    if (!this.#pointerDown && this.#promoteCrossBlockSelection()) {
      return;
    }

    if ((!this.#pointerDown || this.#textDragEscaped) && this.#takeStrayCaretOut()) {
      return;
    }

    const target = this.#selectionTarget();

    // So does a formula's take-back: a caret that went anywhere else, even
    // back again, put something between the formula and the next key.
    const made = this.#ruleFormula;

    if (
      made &&
      (!target ||
        target.block.id !== made.blockId ||
        !sameCell(target.cell, made.cell) ||
        target.range.start !== made.offset + 1 ||
        target.range.start !== target.range.end)
    ) {
      this.#ruleFormula = null;
    }

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

    // A link continuation belongs to one exact caret too (`#typeOver`). Asked
    // of the live selection, so a selectionchange queued behind the next
    // keystroke reads the caret that keystroke left, not a stale one.
    const typingOver = this.#typingOver;

    if (
      typingOver &&
      (!target ||
        target.block.id !== typingOver.blockId ||
        !sameCell(target.cell, typingOver.cell) ||
        target.range.start !== typingOver.offset ||
        target.range.start !== target.range.end)
    ) {
      this.#typingOver = null;
    }

    // Another block, or back over the `/` itself: either way the caret has
    // left the command. Only input re-read the query, so arrowing back over the
    // slash left the menu open until the next edit.
    if (
      this.#slashContext &&
      (target?.block.id !== this.#slashContext.blockId ||
        target.range.start <= this.#slashContext.start)
    ) {
      this.#closeSlashMenu();
    }

    // The one event of a selection the editor wrote back itself: its
    // toolbars were drawn by whoever wrote it (`#ownSelection`).
    if (!own) {
      this.#syncToolbar();
    }

    this.#emitter.emit('selection', this.getSelectionState());
  };

  /**
   * Takes a caret out of this editor's text while blocks are selected.
   *
   * Every deliberate way to place a caret -- focus(), a click, Enter -- ends
   * block selection first, so one that turns up while it is still live was put
   * there by the browser: WebKit re-focuses a host and sets a range in it during
   * a drag that is selecting blocks, and fires no selectionchange after the
   * release to catch it by (the e2e finding F7). Run on selectionchange and on
   * pointerup. Only a caret in this editor's own hosts: another editor's is
   * none of its business.
   */
  #takeStrayCaretOut(): boolean {
    return this.#takeStrayOut(false);
  }

  /**
   * True from a lock that ended a drag across blocks until the button comes
   * up (`setEditable`): the blocks it had selected are let go of, and the
   * gesture is over, but WebKit goes on drawing its own drag selection into
   * the block under the pointer -- once an unlock makes that block editable
   * again, a caret in it that takes focus, "p3[18,18]" at the release where
   * Chromium and Firefox hold nothing (R14-RV1-7). No block selection is
   * left for `#takeStrayCaretOut` to tell it by, so this says it.
   */
  #lockEndedBlocks = false;

  /**
   * True from a lock (`setEditable`, a real switch to read-only) that
   * landed during a held press that began as a text press in this editor,
   * until the next press begins (`#disarmExit`, in the document's capture
   * phase, its one reset -- a press, never a focus move: the release is
   * where it is read, and a release can be lost) --
   * its text drag of any kind still live, or ended already with the
   * button down (`#textDragEscaped`: Escape, a peer's
   * reorder; with only the live drag asked for, such a press went on to
   * release "p1,p2,p3,p4"). The gesture is over, and what the browser
   * goes on selecting across the blocks, which are no editing hosts any
   * more, is not the reader's gesture: it is let go of at the release,
   * before that is read (`#handlePointerUp`, `#dropRangeAcrossBlocks`).
   * Only a press of the editor's: one in the page's own text is the
   * page's, and its range is left alone. The lock's own flag, not
   * `#textDragEscaped` alone: every `#endTextDrag` sets that one -- a peer's
   * `setDocument` in a read-only view too, where the browser's own drag
   * across blocks is all there is, and gated by it, a read-only drag or
   * Shift+click with any update in the middle of the press released
   * nothing, 10 to 23 times in 60 (R14-RV2-1).
   */
  #lockEnded = false;

  /**
   * Lets go of a selection the browser left across more than one block of
   * this editor -- from one block to another, or from a block out of the
   * editor or to the editor's root, over the blocks between -- at the
   * release of a gesture a lock ended, which selects nothing, and at the
   * release of a read-only press in this editor that finds blocks selected,
   * beside which no range stands (`#handlePointerUp`). An end at the
   * editor's root, outside every block, is a place apart from one outside
   * the editor. Left there, the range was promoted to a block
   * selection by the release itself, and, kept from that, by the next
   * `selectionchange` -- a Shift+arrow's included, 81 characters over p1
   * to p5. A range inside one block is the browser's own and stays. The
   * ends are the composed range's (`readSelectionEnds`): out of a shadow
   * mount the selection's own are retargeted to the shadow host -- WebKit
   * reports the range collapsed there -- name no block, and the range
   * stayed, 9 characters in Firefox and 22 in WebKit (R14-RV3-3).
   */
  #dropRangeAcrossBlocks(): void {
    const ends = readSelectionEnds(this.#root);
    // Where an end is: a block of this editor's, the editor's root outside
    // every block (WebKit's own drag goes on from there), or neither -- the
    // page, or another editor. Taken for the page, an end at the root named
    // the same place as one in another editor's block, and a drag from a
    // second editor's block into this one's kept 74 characters (WebKit).
    const place = (node: Node): string | null =>
      this.#renderer.blockIdFromNode(node) ?? (this.#root.contains(node) ? '#root' : null);

    // Two ends in one place -- one block, or neither in this editor (a
    // selection of the page's, a caret) -- are left alone.
    if (ends && place(ends.start) !== place(ends.end)) {
      this.#selection()?.removeAllRanges();
    }
  }

  /**
   * At the release, takes out what the browser's own drag put in this
   * editor's text after a lock ended the reader's drag across blocks
   * (`#lockEndedBlocks`), and lets go of the focus it gave the block
   * (`#letGo`): the reader chose no caret there. Not while the button is
   * down: the selection is not written under a held drag.
   */
  #takeCaretOutAfterLock(): boolean {
    return this.#lockEndedBlocks && this.#takeStrayOut(true);
  }

  #takeStrayOut(afterLock: boolean): boolean {
    if (!afterLock && this.#selected.size === 0) {
      return false;
    }

    const reading = readSelection(this.#root);
    const host =
      reading && this.#root.contains(reading.anchorNode)
        ? this.#hostFromNode(reading.anchorNode)
        : null;

    if (!host) {
      return false;
    }

    this.#selection()?.removeAllRanges();

    if (afterLock) {
      this.#letGo(host);
    } else {
      this.#root.focus({ preventScroll: true });
    }

    return true;
  }

  #now(): number {
    return this.#document.defaultView?.performance.now() ?? Date.now();
  }

  /** Hides the table toolbar and forgets the cell it was acting on. */
  #hideTableToolbar(): void {
    this.#tableToolbar.hide();
    this.#activeCell = null;
    this.#tableToolbarScrolledAway = false;
  }
}
