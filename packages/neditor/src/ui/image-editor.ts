import type { NEditorLabels } from '../labels.ts';
import type { PortalTheme } from './portal.ts';
import type { AnchorPin } from './portal.ts';
import { createPortal, holdsFocus, positionPortal } from './portal.ts';

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

/** Distinguishes the error-message ids when several dialogs share a page. */
let imageErrorIds = 0;

export class ImageEditor {
  readonly #element: HTMLElement;
  readonly #src: HTMLInputElement;
  readonly #error: HTMLElement;
  readonly #alt: HTMLInputElement;
  readonly #removeButton: HTMLButtonElement;
  readonly #hooks: ImageEditorHooks;

  #open = false;
  #pin: AnchorPin | null = null;

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

    this.#src = this.#createInput(doc, labels.imageUrlPlaceholder, labels.imageUrl);
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
    // Named rather than colour-only, and wired to the field it belongs to.
    this.#error = doc.createElement('p');
    this.#error.className = 'neditor-image-editor__error';
    this.#error.id = `neditor-image-error-${(imageErrorIds += 1)}`;
    this.#error.textContent = labels.invalidUrl;
    this.#error.hidden = true;
    this.#src.setAttribute('aria-describedby', this.#error.id);

    this.#element.append(this.#src, this.#alt, this.#error, actions);
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

  open(anchor: DOMRect, value: ImageEditorValue, pin: AnchorPin | null = null): void {
    this.#pin = pin;
    this.#element.hidden = false;
    this.#open = true;
    this.#src.value = value.src;
    this.#clearInvalid();
    this.#alt.value = value.alt;
    this.#removeButton.hidden = value.src.length === 0;

    positionPortal(this.#element, anchor, { prefer: 'below' });
    this.#src.focus();
    this.#src.select();
  }

  close(): void {
    if (!this.#open) {
      return;
    }

    this.#open = false;
    this.#pin = null;
    this.#element.hidden = true;
  }

  /** Flags the URL as unusable and keeps the popover open for a correction. */
  markInvalid(): void {
    this.#src.dataset.invalid = 'true';
    this.#src.setAttribute('aria-invalid', 'true');
    this.#error.hidden = false;
    this.#src.focus();
    this.#src.select();
  }

  /** So a corrected value stops being announced as the rejected one. */
  #clearInvalid(): void {
    delete this.#src.dataset.invalid;
    this.#src.removeAttribute('aria-invalid');
    this.#error.hidden = true;
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
