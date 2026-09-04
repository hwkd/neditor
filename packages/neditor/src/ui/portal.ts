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
  anchor: DOMRect,
  options: PositionOptions,
): void {
  const view = element.ownerDocument.defaultView;
  const viewportWidth = view?.innerWidth ?? 0;
  const viewportHeight = view?.innerHeight ?? 0;
  const gap = options.gap ?? 8;
  const margin = options.margin ?? 8;

  const { width, height } = element.getBoundingClientRect();

  const roomAbove = anchor.top - gap;
  const roomBelow = viewportHeight - anchor.bottom - gap;

  const above =
    options.prefer === 'above' ? roomAbove >= height : roomBelow < height && roomAbove >= height;

  const top = above ? anchor.top - gap - height : anchor.bottom + gap;
  const left = Math.min(
    Math.max(margin, anchor.left),
    Math.max(margin, viewportWidth - width - margin),
  );

  element.style.left = `${Math.round(left)}px`;
  element.style.top = `${Math.round(Math.min(Math.max(margin, top), viewportHeight - height - margin))}px`;
}
