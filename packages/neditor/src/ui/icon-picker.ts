import type { NEditorLabels } from '../labels.ts';
import { firstGrapheme } from '../util/grapheme.ts';
import type { PortalTheme } from './portal.ts';
import { createPortal, positionPortal } from './portal.ts';

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
  readonly #hooks: IconPickerHooks;

  #open = false;

  constructor(doc: Document, hooks: IconPickerHooks, labels: NEditorLabels) {
    this.#hooks = hooks;
    // Contains an input, so it must be allowed to take focus.
    this.#element = createPortal(doc, 'neditor-icon-picker', { keepFocus: false });
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

    for (const icon of ICONS) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'neditor-icon-picker__icon';
      button.textContent = icon;
      button.setAttribute('aria-label', icon);
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
      });
      button.addEventListener('click', () => {
        this.#hooks.onSelect(icon);
      });

      grid.append(button);
    }

    this.#element.append(grid, this.#input);
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

  open(anchor: DOMRect, current: string): void {
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
    this.#element.hidden = true;
  }

  contains(node: Node | null): boolean {
    return node !== null && this.#element.contains(node);
  }

  destroy(): void {
    this.#element.remove();
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
