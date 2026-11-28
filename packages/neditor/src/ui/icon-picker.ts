import type { NEditorLabels } from '../labels.ts';
import { firstGrapheme } from '../util/grapheme.ts';
import type { PortalTheme } from './portal.ts';
import type { AnchorPin } from './portal.ts';
import { createPortal, holdsFocus, positionPortal } from './portal.ts';

/**
 * The callout icon picker.
 *
 * A short, opinionated set covers what callouts are actually for — a note, a
 * warning, a tip — and the input takes anything else, so the list never has to
 * become a full emoji keyboard.
 */

const ICONS = [
  '💡',
  '📌',
  '⚠️',
  '🚨',
  '✅',
  '❌',
  'ℹ️',
  '❓',
  '📝',
  '🔖',
  '🔥',
  '⭐',
  '🎯',
  '🚀',
  '🧠',
  '🔍',
  '📊',
  '🗓️',
  '⏰',
  '🔒',
  '🐛',
  '🧪',
  '💬',
  '👉',
] as const;

export interface IconPickerHooks {
  onSelect(icon: string): void;
  onDismiss(): void;
}

export class IconPicker {
  readonly #element: HTMLElement;
  readonly #input: HTMLInputElement;
  readonly #grid: HTMLElement;
  readonly #hooks: IconPickerHooks;

  #open = false;
  #pin: AnchorPin | null = null;

  constructor(doc: Document, hooks: IconPickerHooks, labels: NEditorLabels) {
    this.#hooks = hooks;
    // Contains an input, so it must be allowed to take focus.
    this.#element = createPortal(doc, 'neditor-icon-picker', {
      keepFocus: false,
      onEscape: () => {
        this.#hooks.onDismiss();
      },
    });
    this.#element.setAttribute('role', 'dialog');
    this.#element.setAttribute('aria-label', labels.iconDialog);

    this.#input = doc.createElement('input');
    this.#input.type = 'text';
    this.#input.className = 'neditor-icon-picker__input';
    this.#input.placeholder = labels.iconPlaceholder;
    this.#input.setAttribute('aria-label', labels.iconCustom);
    this.#input.addEventListener('keydown', (event) => {
      // The editor's own key handling must not see these.
      event.stopPropagation();

      if (event.key === 'Enter') {
        event.preventDefault();
        this.#commitInput();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.#hooks.onDismiss();
      }
    });

    const grid = doc.createElement('div');
    grid.className = 'neditor-icon-picker__grid';
    grid.addEventListener('keydown', (event) => {
      this.#moveInGrid(event);
    });

    for (const [index, icon] of ICONS.entries()) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'neditor-icon-picker__icon';
      button.textContent = icon;
      button.setAttribute('aria-label', icon);
      // One tab stop for the whole grid; the arrows move within it.
      button.tabIndex = index === 0 ? 0 : -1;
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
      });
      button.addEventListener('click', () => {
        this.#hooks.onSelect(icon);
      });

      grid.append(button);
    }

    // The field first, in the DOM as on screen. It is where the dialog opens,
    // and it was last, so Tab from it left the dialog at once and the grid was
    // reachable only backwards, by Shift+Tab.
    this.#element.append(this.#input, grid);
    this.#grid = grid;
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

  open(anchor: DOMRect, current: string, pin: AnchorPin | null = null): void {
    this.#pin = pin;
    this.#element.hidden = false;
    this.#open = true;
    this.#input.value = current;

    positionPortal(this.#element, anchor, { prefer: 'below' });
    this.#input.focus();
    this.#input.select();
  }

  close(): void {
    if (!this.#open) {
      return;
    }

    this.#open = false;
    this.#pin = null;
    this.#element.hidden = true;
  }

  /** True while the user is in the dialog: its input, a swatch, a button. */
  get hasFocus(): boolean {
    return this.#open && holdsFocus(this.#element);
  }

  /**
   * Places the dialog against wherever its anchor has moved to. False when it
   * was opened without a pin or the anchor has left the page, so there is
   * nothing left to place it against.
   */
  reposition(): boolean {
    const anchor = this.#open ? this.#pin?.() : null;

    if (!anchor) {
      return false;
    }

    positionPortal(this.#element, anchor, { prefer: 'below' });
    return true;
  }

  contains(node: Node | null): boolean {
    return node !== null && this.#element.contains(node);
  }

  destroy(): void {
    this.#element.remove();
  }

  /**
   * Arrow keys, Home and End rove the grid, its one tab stop going with the
   * focus. Up and down step by the columns the grid is drawn with; left and
   * right follow the direction it is drawn in.
   */
  #moveInGrid(event: KeyboardEvent): void {
    const buttons = [...this.#grid.querySelectorAll<HTMLButtonElement>('button')];
    const from = buttons.findIndex((button) => button === event.target);

    if (from === -1 || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    const view = this.#grid.ownerDocument.defaultView;
    const style = view?.getComputedStyle(this.#grid);
    const columns = Math.max(1, style?.gridTemplateColumns.split(' ').filter(Boolean).length ?? 1);
    const forward = style?.direction === 'rtl' ? -1 : 1;
    const steps: Record<string, number> = {
      ArrowRight: forward,
      ArrowLeft: -forward,
      ArrowDown: columns,
      ArrowUp: -columns,
      Home: -from,
      End: buttons.length - 1 - from,
    };
    const step = steps[event.key];

    if (step === undefined) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const to = buttons[Math.min(buttons.length - 1, Math.max(0, from + step))];

    if (!to) {
      return;
    }

    for (const button of buttons) {
      button.tabIndex = button === to ? 0 : -1;
    }

    to.focus();
  }

  #commitInput(): void {
    const value = firstGrapheme(this.#input.value);

    if (value === undefined) {
      this.#hooks.onDismiss();
      return;
    }

    this.#hooks.onSelect(value);
  }
}
