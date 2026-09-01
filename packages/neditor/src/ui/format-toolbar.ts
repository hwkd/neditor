import type { NEditorLabels } from '../labels.ts';
import type { Mark } from '../model/rich-text.ts';
import type { PortalTheme } from './portal.ts';
import { createPortal, positionPortal } from './portal.ts';

/**
 * The selection toolbar.
 *
 * Appears over a non-empty selection and reflects the marks that span the whole
 * selection, so a half-bold range shows Bold as inactive and clicking it bolds
 * the remainder — matching {@link richToggleMark}.
 */

export interface ToolbarState {
  readonly marks: readonly Mark[];
  readonly link: string | null;
}

export interface FormatToolbarHooks {
  onToggleMark(mark: Mark): void;
  onEditLink(): void;
}

interface ToolbarButton {
  readonly mark: Mark;
  readonly glyph: string;
  readonly shortcut: string;
}

const BUTTONS: readonly ToolbarButton[] = [
  { mark: 'bold', glyph: 'B', shortcut: 'Mod+B' },
  { mark: 'italic', glyph: 'I', shortcut: 'Mod+I' },
  { mark: 'underline', glyph: 'U', shortcut: 'Mod+U' },
  { mark: 'strikethrough', glyph: 'S', shortcut: 'Mod+Shift+X' },
  { mark: 'code', glyph: '</>', shortcut: 'Mod+E' },
];

const LINK_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round"><path d="M6.5 9.5a2.5 2.5 0 0 0 3.54 0l2-2a2.5 2.5 0 0 0-3.54-3.54l-.7.7"/>' +
  '<path d="M9.5 6.5a2.5 2.5 0 0 0-3.54 0l-2 2a2.5 2.5 0 0 0 3.54 3.54l.7-.7"/></svg>';

/** Renders `Mod` as the platform's modifier key. */
function shortcutLabel(shortcut: string, doc: Document): string {
  const isApple = /Mac|iPhone|iPad/i.test(doc.defaultView?.navigator.platform ?? '');
  return shortcut.replace('Mod', isApple ? '⌘' : 'Ctrl').replace(/\+/g, isApple ? '' : '+');
}

export class FormatToolbar {
  readonly #element: HTMLElement;
  readonly #hooks: FormatToolbarHooks;
  readonly #markButtons = new Map<Mark, HTMLButtonElement>();
  readonly #linkButton: HTMLButtonElement;

  #open = false;

  constructor(doc: Document, hooks: FormatToolbarHooks, labels: NEditorLabels) {
    this.#hooks = hooks;
    this.#element = createPortal(doc, 'neditor-toolbar');
    this.#element.setAttribute('role', 'toolbar');
    this.#element.setAttribute('aria-label', labels.formatToolbar);

    for (const button of BUTTONS) {
      const node = doc.createElement('button');
      node.type = 'button';
      node.className = 'neditor-toolbar__button';
      node.dataset.mark = button.mark;
      node.textContent = button.glyph;
      node.tabIndex = -1;
      node.setAttribute('aria-pressed', 'false');
      const name = labels[button.mark];
      node.title = `${name} (${shortcutLabel(button.shortcut, doc)})`;
      node.setAttribute('aria-label', name);

      node.addEventListener('click', () => {
        this.#hooks.onToggleMark(button.mark);
      });

      this.#markButtons.set(button.mark, node);
      this.#element.append(node);
    }

    const separator = doc.createElement('div');
    separator.className = 'neditor-toolbar__separator';
    separator.setAttribute('aria-hidden', 'true');
    this.#element.append(separator);

    this.#linkButton = doc.createElement('button');
    this.#linkButton.type = 'button';
    this.#linkButton.className = 'neditor-toolbar__button neditor-toolbar__button--link';
    this.#linkButton.innerHTML = LINK_ICON;
    this.#linkButton.tabIndex = -1;
    this.#linkButton.title = `${labels.link} (${shortcutLabel('Mod+K', doc)})`;
    this.#linkButton.setAttribute('aria-label', labels.link);
    this.#linkButton.addEventListener('click', () => {
      this.#hooks.onEditLink();
    });

    this.#element.append(this.#linkButton);
  }

  get element(): HTMLElement {
    return this.#element;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  setTheme(theme: PortalTheme): void {
    this.#element.dataset.neditorTheme = theme;
  }

  show(anchor: DOMRect, state: ToolbarState): void {
    this.#element.hidden = false;
    this.#open = true;
    this.update(state);
    // Unhidden first, so the real width is known before placement.
    positionPortal(this.#element, anchor, { prefer: 'above' });
  }

  update(state: ToolbarState): void {
    for (const [mark, button] of this.#markButtons) {
      const active = state.marks.includes(mark);
      button.setAttribute('aria-pressed', String(active));
      button.dataset.active = String(active);
    }

    const linked = state.link !== null;
    this.#linkButton.dataset.active = String(linked);
    this.#linkButton.setAttribute('aria-pressed', String(linked));
  }

  hide(): void {
    if (!this.#open) {
      return;
    }

    this.#open = false;
    this.#element.hidden = true;
  }

  destroy(): void {
    this.#element.remove();
  }
}
