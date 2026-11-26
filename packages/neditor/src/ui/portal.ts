/**
 * Floating UI that lives outside the editor element.
 *
 * The slash menu, format toolbar and link editor all render into `document.body`
 * so they are never clipped by the editor's `overflow`. That also puts them
 * outside `.neditor`, where the theme custom properties are defined, so every
 * portal carries the `neditor-portal` class and its own theme attribute.
 */

/**
 * Colour scheme for the editor and its floating UI.
 *
 * Exported as `NEditorTheme`; the internal name reflects where it is consumed.
 */
export type PortalTheme = 'light' | 'dark' | 'auto';

export interface PortalOptions {
  /**
   * Suppress the default mousedown, so clicking the portal does not blur the
   * block being edited. Portals that contain a focusable input opt out.
   */
  readonly keepFocus?: boolean;

  /**
   * Dismiss on Escape from anywhere inside, which a `role="dialog"` owes its
   * user. Handled here rather than on each control: the dialogs bound it to
   * their text input alone, so Escape did nothing while focus was on a preset
   * swatch or an Apply button -- and those buttons are the last tab stops in
   * the document, so tabbing off them left the dialog open over the editor with
   * no way back to it.
   */
  readonly onEscape?: () => void;
}

export function createPortal(
  doc: Document,
  className: string,
  options: PortalOptions = {},
): HTMLElement {
  const element = doc.createElement('div');
  element.className = `neditor-portal ${className}`;
  element.dataset.neditorTheme = 'auto';
  element.hidden = true;

  if (options.keepFocus ?? true) {
    element.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });
  }

  const { onEscape } = options;

  if (onEscape) {
    element.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      // The editor's own key handling must not also see this.
      event.stopPropagation();
      onEscape();
    });
  }

  return element;
}

/**
 * The part of a rect a portal is placed against.
 *
 * `right` is optional so a caller holding only a point can still place one;
 * without it an RTL portal lines up with `left`, as an LTR one does.
 */
export type AnchorRect = Pick<DOMRect, 'top' | 'bottom' | 'left'> & Partial<Pick<DOMRect, 'right'>>;

/** Finds an anchor again after the page has moved it, or null once it is gone. */
export type AnchorPin = () => AnchorRect | null;

/**
 * Pins `rect` to `element`, so it can be found again after a scroll or resize.
 *
 * The rect is kept as an offset from the element rather than as viewport
 * coordinates, which go stale the moment the page moves. That covers a range
 * inside a block (the link editor's selection) as well as a control that is
 * the anchor itself.
 */
export function pinAnchor(
  element: Element,
  rect: AnchorRect = element.getBoundingClientRect(),
): AnchorPin {
  const base = element.getBoundingClientRect();
  const dx = rect.left - base.left;
  const dy = rect.top - base.top;
  const height = rect.bottom - rect.top;
  const width = (rect.right ?? rect.left) - rect.left;

  return () => {
    if (!element.isConnected) {
      return null;
    }

    const now = element.getBoundingClientRect();
    const top = now.top + dy;
    const left = now.left + dx;

    return { left, right: left + width, top, bottom: top + height };
  };
}

/**
 * Whether focus is inside `element`, asked of the tree it lives in.
 *
 * A portal may sit in a shadow root, whose `activeElement` the document's
 * retargets to the host.
 */
export function holdsFocus(element: Element): boolean {
  const root = element.getRootNode();
  const active = 'activeElement' in root ? (root as Document | ShadowRoot).activeElement : null;

  return active !== null && element.contains(active);
}

/** The window each portal's anchors are measured in, where that is not its own. */
const anchorViews = new WeakMap<Element, Window>();

/**
 * Says which window a portal's anchors are measured in.
 *
 * Every anchor is a rect from the editor's own document, in that window's
 * viewport. An iframe mount can be given a `portalContainer` in the page
 * around the frame, and a portal drawn there was placed by the frame's
 * coordinates in the outer page's viewport: off by the frame's own offset,
 * the table toolbar clamped into the page's corner. `positionPortal` lifts
 * such an anchor through the frames between the two windows.
 */
export function setAnchorView(element: Element, view: Window | null): void {
  if (view) {
    anchorViews.set(element, view);
  } else {
    anchorViews.delete(element);
  }
}

/** What each portal's anchors can be seen in, where that is less than a window. */
const anchorBands = new WeakMap<Element, () => { top: number; bottom: number } | null>();

/**
 * Says what part of the anchors' window a portal can be seen in: `band`
 * answers it vertically, in the anchors' coordinates, or null for all of it.
 *
 * In an iframe mount that is what the pages around the frame leave of it --
 * a frame taller than the page's window, or in a scrolling pane of the page
 * -- and the portal's own viewport, the frame's window, reaches past it.
 * Placed by that viewport, the table toolbar went above a caret near the
 * top of what the pane showed, where the pane hides it, and with a row
 * taller than the page's window it was drawn below the window. The band
 * chooses the side of the anchor and nothing else (`positionPortal`): the
 * portal is still clamped to its own viewport, never into the band, which
 * can be smaller than the portal. The band is lifted as the anchor is. For
 * a portal drawn in a page around the frame (a `portalContainer` there) it
 * is only what clips that page -- the frames around it -- never a pane of
 * that page or the frame's own window: the portal is `position: fixed` in
 * that page and drawn over both. Cut by the pane, a slash menu over a frame
 * in a pane of the page went below its caret and past the window. Null
 * where nothing clips the portal's page, which leaves its own viewport.
 */
export function setAnchorBand(
  element: Element,
  band: (() => { top: number; bottom: number } | null) | null,
): void {
  if (band) {
    anchorBands.set(element, band);
  } else {
    anchorBands.delete(element);
  }
}

/**
 * An anchor measured in another window, in the coordinates of the window the
 * portal is drawn in -- through each frame on the way out, its content box's
 * origin added and its scale applied. Unchanged where the portal's window is
 * not above the anchor's, or a frame on the way cannot be read.
 *
 * The scale is the frame's drawn size over its layout size: a `transform` or
 * a CSS `zoom` on the frame or anything around it draws the frame's whole
 * viewport larger or smaller, and an anchor lifted by the offset alone put
 * the table toolbar over the rows (under `scale(0.7)`) or hundreds of pixels
 * above them (under `zoom: 1.5`). The border and padding between the frame's
 * edge and its viewport are in the frame's own pixels, so they are scaled
 * too. A rotation or skew is not a scale and is not answered here. Nor is
 * WebKit under a CSS `zoom` around the frame (a documented limit): it lays
 * the frame's document out at the zoomed width and reports rects inside it
 * divided by the zoom once more, so no frame measurement maps them.
 */
function liftAnchor(element: Element, anchor: AnchorRect): AnchorRect {
  const from = anchorViews.get(element);
  const to = element.ownerDocument.defaultView;

  if (!from || !to || from === to) {
    return anchor;
  }

  // x in the anchor's window maps to x * sx + dx in the current one.
  let sx = 1;
  let sy = 1;
  let dx = 0;
  let dy = 0;
  let view: Window | null = from;

  while (view && view !== to) {
    let frame: Element | null;

    try {
      frame = view.frameElement;
    } catch {
      return anchor;
    }

    if (!frame) {
      return anchor;
    }

    const rect = frame.getBoundingClientRect();
    const style = frame.ownerDocument.defaultView?.getComputedStyle(frame);
    const layout = frame as Partial<HTMLElement>;
    const scaleX = layout.offsetWidth ? rect.width / layout.offsetWidth : 1;
    const scaleY = layout.offsetHeight ? rect.height / layout.offsetHeight : 1;
    const insetX = frame.clientLeft + (parseFloat(style?.paddingLeft ?? '') || 0);
    const insetY = frame.clientTop + (parseFloat(style?.paddingTop ?? '') || 0);

    dx = dx * scaleX + rect.left + insetX * scaleX;
    dy = dy * scaleY + rect.top + insetY * scaleY;
    sx *= scaleX;
    sy *= scaleY;
    view = frame.ownerDocument.defaultView;
  }

  if (view !== to) {
    return anchor;
  }

  return {
    top: anchor.top * sy + dy,
    bottom: anchor.bottom * sy + dy,
    left: anchor.left * sx + dx,
    ...(anchor.right === undefined ? {} : { right: anchor.right * sx + dx }),
  };
}

/** The default space between a portal and its anchor, and from the viewport's edge. */
export const PORTAL_GAP_PX = 8;
export const PORTAL_MARGIN_PX = 8;

export interface PositionOptions {
  readonly prefer: 'above' | 'below';
  readonly gap?: number;
  readonly margin?: number;
}

/**
 * Places a portal against an anchor rect, flipping when it would overflow.
 *
 * The element must already be visible: its real measured size is used rather
 * than an estimate, so a filtered menu that shrank to one row sits tight
 * against the caret instead of floating away from it.
 */
export function positionPortal(
  element: HTMLElement,
  measured: AnchorRect,
  options: PositionOptions,
): void {
  const view = element.ownerDocument.defaultView;
  const anchor = liftAnchor(element, measured);

  // The visual viewport, not the layout one. `innerHeight` does not shrink when
  // a software keyboard opens -- that is precisely what `visualViewport`
  // reports -- so on a phone the menu was placed into the space the keyboard
  // was covering and never flipped above it: of a 320px menu, 80px was visible.
  // `offsetTop` matters too, since a pinch-zoomed or keyboard-scrolled visual
  // viewport no longer starts at the top of the layout one.
  const visual = view?.visualViewport ?? null;
  const viewportWidth = visual?.width ?? view?.innerWidth ?? 0;
  const viewportHeight = visual?.height ?? view?.innerHeight ?? 0;
  const viewportTop = visual?.offsetTop ?? 0;
  const viewportBottom = viewportTop + viewportHeight;
  const gap = options.gap ?? PORTAL_GAP_PX;
  const margin = options.margin ?? PORTAL_MARGIN_PX;

  const { width, height } = element.getBoundingClientRect();

  // The side is chosen by the room in what can be seen of the anchor's window
  // (`setAnchorBand`), and only the side: the portal is then placed against
  // the anchor and clamped to its own viewport alone. Clamped into a band
  // smaller than itself, a 320px slash menu with 200px of the frame on screen
  // was pulled up over its own caret and past the frame's top, which clips
  // it, and the option Enter would apply was out of sight.
  const within = anchorBands.get(element)?.() ?? null;
  const band = within ? liftAnchor(element, { ...within, left: 0 }) : null;
  const seenTop = Math.max(viewportTop, band?.top ?? -Infinity);
  const seenBottom = Math.min(viewportBottom, band?.bottom ?? Infinity);
  const roomAbove = anchor.top - seenTop - gap;
  const roomBelow = seenBottom - anchor.bottom - gap;
  const fitsAbove = roomAbove >= height;
  const fitsBelow = roomBelow >= height;
  // Where neither side fits, the side with more of it seen, if the portal
  // fits there in its own viewport -- above, that is, without crossing the
  // viewport's top, where a frame clips it -- and otherwise below. Only where
  // the band does cut the viewport; otherwise below, as it always was.
  const cut = seenTop > viewportTop || seenBottom < viewportBottom;

  const above =
    fitsAbove && fitsBelow
      ? options.prefer === 'above'
      : fitsAbove || fitsBelow
        ? fitsAbove
        : cut && roomAbove > roomBelow && anchor.top - gap - height >= viewportTop + margin;

  const top = above ? anchor.top - gap - height : anchor.bottom + gap;
  // Aligned on the reading-start edge: the portal's left to the anchor's left
  // in LTR, its right to the anchor's right in RTL -- where a left-aligned menu
  // would hang off the end of the text it belongs to. The portal's own
  // computed direction, so a `dir` on it and a CSS `direction` both count.
  const rtl = view?.getComputedStyle(element).direction === 'rtl';
  const start = rtl ? (anchor.right ?? anchor.left) - width : anchor.left;
  const left = Math.min(Math.max(margin, start), Math.max(margin, viewportWidth - width - margin));

  let placed = Math.min(Math.max(viewportTop + margin, top), viewportBottom - height - margin);

  // Where a band cuts the viewport, the clamp never carries the portal back
  // across its anchor: above it, it was chosen only where it fits; below it,
  // it may run past the viewport's bottom rather than over the anchor, with
  // its first option -- the one Enter applies -- beside the anchor.
  if (cut) {
    placed = above ? top : Math.max(placed, top);
  }

  element.style.left = `${Math.round(left)}px`;
  element.style.top = `${Math.round(placed)}px`;
}
