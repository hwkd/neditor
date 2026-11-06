import type { NEditorLabels } from '../labels.ts';
import { nextId } from '../util/ids.ts';
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

export class ImageEditor {
  readonly #element: HTMLElement;
  readonly #src: HTMLInputElement;
  /** The visible message, and the URL field's description while it applies. */
  readonly #error: HTMLElement;
  /** The live region, which speaks a rejection focus would not. */
  readonly #alert: HTMLElement;
  /** The rejection's wording, written into the alert each time it fires. */
  readonly #message: string;
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
    // A URL is LTR whatever the prose around it is: under dir="rtl" the bidi
    // algorithm showed `/sample.png` as `sample.png/`. Only while the field
    // holds one, though -- the placeholder is prose, as in the link editor.
    // The alt text is prose in the reader's language, so it always inherits.
    this.#src.addEventListener('input', () => {
      this.#syncDirection();
    });
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
    // Named rather than colour-only, wired to the field only while it
    // applies, and spoken once per rejection by a separate, visually hidden
    // alert -- for the reasons given in the link editor, which has the same
    // error.
    this.#message = labels.invalidUrl;
    this.#error = doc.createElement('p');
    this.#error.className = 'neditor-image-editor__error';
    this.#error.id = `neditor-image-error-${nextId('image-error')}`;
    this.#error.hidden = true;
    this.#alert = doc.createElement('div');
    this.#alert.className = 'neditor-live-region';
    this.#alert.setAttribute('role', 'alert');

    this.#element.append(this.#src, this.#alt, this.#error, actions, this.#alert);
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
    this.#syncDirection();
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
    // Asked before focus moves, as in the link editor: only a rejection made
    // from inside the URL field needs the alert. From Apply or the alt field,
    // focus arrives in the URL field and its new description says it.
    const announce = holdsFocus(this.#src);

    this.#src.dataset.invalid = 'true';
    this.#src.setAttribute('aria-invalid', 'true');
    this.#src.setAttribute('aria-describedby', this.#error.id);
    this.#error.hidden = false;
    this.#error.textContent = this.#message;
    // Written again on every rejection that needs it: a live region speaks
    // when its content changes, and a second bad URL in a row would otherwise
    // leave the same words standing and say nothing.
    this.#alert.textContent = announce ? this.#message : '';
    this.#src.focus();
    this.#src.select();
  }

  /** LTR while there is a URL to lay out, for the reason the link editor gives. */
  #syncDirection(): void {
    this.#src.dir = this.#src.value ? 'ltr' : '';
  }

  /** So a corrected value stops being announced as the rejected one. */
  #clearInvalid(): void {
    delete this.#src.dataset.invalid;
    this.#src.removeAttribute('aria-invalid');
    this.#src.removeAttribute('aria-describedby');
    this.#error.hidden = true;
    this.#error.textContent = '';
    this.#alert.textContent = '';
  }

  /** True while the user is in the dialog: one of its inputs or buttons. */
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
