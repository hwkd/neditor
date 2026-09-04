import type { NEditorLabels } from '../labels.ts';
import type { PortalTheme } from './portal.ts';
import { createPortal, positionPortal } from './portal.ts';

/**
 * The image source popover.
 *
 * Takes focus, like the link editor, so the editor remembers which block opened
 * it. Alt text sits beside the URL rather than in a separate step: an image
 * without it is invisible to a screen reader, and a caption is not a substitute.
 */

export interface ImageEditorValue {
  readonly src: string;
  readonly alt: string;
}

export interface ImageEditorHooks {
  onApply(value: ImageEditorValue): void;
  onRemove(): void;
  onCancel(): void;
}

export class ImageEditor {
  readonly #element: HTMLElement;
  readonly #src: HTMLInputElement;
  readonly #alt: HTMLInputElement;
  readonly #removeButton: HTMLButtonElement;
  readonly #hooks: ImageEditorHooks;

  #open = false;

  constructor(doc: Document, hooks: ImageEditorHooks, labels: NEditorLabels) {
    this.#hooks = hooks;
    this.#element = createPortal(doc, 'neditor-image-editor', {
      keepFocus: false,
      onEscape: () => {
        this.#hooks.onCancel();
      },
    });
    this.#element.setAttribute('role', 'dialog');
    this.#element.setAttribute('aria-label', labels.imageEdit);

    this.#src = this.#createInput(doc, labels.imageUrlPlaceholder, labels.linkUrl);
    this.#alt = this.#createInput(doc, labels.imageAltPlaceholder, labels.imageAlt);

    const actions = doc.createElement('div');
    actions.className = 'neditor-image-editor__actions';

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

    actions.append(apply, this.#removeButton);
    this.#element.append(this.#src, this.#alt, actions);
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

  open(anchor: DOMRect, value: ImageEditorValue): void {
    this.#element.hidden = false;
    this.#open = true;
    this.#src.value = value.src;
    this.#alt.value = value.alt;
    this.#removeButton.hidden = value.src.length === 0;
    delete this.#src.dataset.invalid;

    positionPortal(this.#element, anchor, { prefer: 'below' });
    this.#src.focus();
    this.#src.select();
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
    this.#src.dataset.invalid = 'true';
    this.#src.focus();
    this.#src.select();
  }

  contains(node: Node | null): boolean {
    return node !== null && this.#element.contains(node);
  }

  destroy(): void {
    this.#element.remove();
  }

  #createInput(doc: Document, placeholder: string, label: string): HTMLInputElement {
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'neditor-image-editor__input';
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', label);
    input.addEventListener('keydown', (event) => {
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

    return input;
  }

  #apply(): void {
    const src = this.#src.value.trim();

    if (src.length === 0) {
      this.#hooks.onRemove();
      return;
    }

    this.#hooks.onApply({ src, alt: this.#alt.value.trim() });
  }
}
