import type { NEditorLabels } from '../labels.ts';
import type { PortalTheme } from './portal.ts';
import { createPortal, positionPortal } from './portal.ts';

/**
 * The link popover.
 *
 * Unlike the other portals this one takes focus, because it contains a text
 * input. The editor therefore remembers which block and range it was opened
 * for and restores that selection when the popover closes.
 */

export interface LinkEditorHooks {
  onApply(href: string): void;
  onRemove(): void;
  onCancel(): void;
}

export class LinkEditor {
  readonly #element: HTMLElement;
  readonly #input: HTMLInputElement;
  readonly #removeButton: HTMLButtonElement;
  readonly #hooks: LinkEditorHooks;

  #open = false;

  constructor(doc: Document, hooks: LinkEditorHooks, labels: NEditorLabels) {
    this.#hooks = hooks;
    this.#element = createPortal(doc, 'neditor-link-editor', {
      keepFocus: false,
      onEscape: () => {
        this.#hooks.onCancel();
      },
    });
    this.#element.setAttribute('role', 'dialog');
    this.#element.setAttribute('aria-label', labels.link);

    this.#input = doc.createElement('input');
    this.#input.type = 'text';
    this.#input.className = 'neditor-link-editor__input';
    this.#input.placeholder = labels.linkPlaceholder;
    this.#input.spellcheck = false;
    this.#input.autocomplete = 'off';
    this.#input.setAttribute('aria-label', labels.linkUrl);

    this.#input.addEventListener('keydown', (event) => {
      // The editor's own key handling must not see these.
      event.stopPropagation();

      if (event.key === 'Enter') {
        event.preventDefault();
        this.#apply();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.#hooks.onCancel();
      }
    });

    const apply = doc.createElement('button');
    apply.type = 'button';
    apply.className = 'neditor-link-editor__button';
    apply.textContent = labels.apply;
    apply.addEventListener('click', () => {
      this.#apply();
    });

    this.#removeButton = doc.createElement('button');
    this.#removeButton.type = 'button';
    this.#removeButton.className =
      'neditor-link-editor__button neditor-link-editor__button--remove';
    this.#removeButton.textContent = labels.remove;
    this.#removeButton.addEventListener('click', () => {
      this.#hooks.onRemove();
    });

    this.#element.append(this.#input, apply, this.#removeButton);
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

  open(anchor: DOMRect, current: string | null): void {
    this.#element.hidden = false;
    this.#open = true;
    this.#input.value = current ?? '';
    delete this.#input.dataset.invalid;
    this.#removeButton.hidden = current === null;

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

  /** Flags the URL as unusable and keeps the popover open for a correction. */
  markInvalid(): void {
    this.#input.dataset.invalid = 'true';
    this.#input.focus();
    this.#input.select();
  }

  /** True when focus is inside the popover, so a blur can be ignored. */
  contains(node: Node | null): boolean {
    return node !== null && this.#element.contains(node);
  }

  destroy(): void {
    this.#element.remove();
  }

  #apply(): void {
    const value = this.#input.value.trim();

    if (value.length === 0) {
      this.#hooks.onRemove();
      return;
    }

    this.#hooks.onApply(value);
  }
}
