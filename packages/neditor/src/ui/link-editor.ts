import type { NEditorLabels } from '../labels.ts';
import { nextId } from '../util/ids.ts';
import type { PortalTheme } from './portal.ts';
import type { AnchorPin } from './portal.ts';
import { createPortal, holdsFocus, positionPortal } from './portal.ts';

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
  /** The visible message, and the field's description while it applies. */
  readonly #error: HTMLElement;
  /** The live region, which speaks a rejection focus would not. */
  readonly #alert: HTMLElement;
  /** The rejection's wording, written into the alert each time it fires. */
  readonly #message: string;
  readonly #removeButton: HTMLButtonElement;
  readonly #hooks: LinkEditorHooks;

  #open = false;
  #pin: AnchorPin | null = null;

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
    // A URL is LTR whatever the prose around it is. The portal takes the
    // editor's direction, and under dir="rtl" the bidi algorithm showed
    // `https://example.com/docs?` as `?https://example.com/docs`. Only while
    // the field holds one, though: the placeholder is prose in the reader's
    // language, and a field forced LTR drew a translated one left-aligned with
    // its ellipsis on the wrong end. See `#syncDirection`.
    // A correction in progress is not the rejected value: the message and
    // `aria-invalid` stood while the user typed the fixed URL, and a reader
    // heard "invalid" on every character of it.
    this.#input.addEventListener('input', () => {
      this.#syncDirection();
      this.#clearInvalid();
    });

    // Named rather than colour-only, and wired to the input by
    // `aria-describedby` only while it applies -- description computation
    // follows a reference into a hidden node, so a standing reference read the
    // error out on every opening. Spoken once per rejection, by whichever of
    // two routes applies: see `markInvalid`. The visible message is therefore
    // not itself a live region; the alert beside it is, and is visually hidden.
    this.#message = labels.invalidUrl;
    this.#error = doc.createElement('p');
    this.#error.className = 'neditor-link-editor__error';
    this.#error.id = `neditor-link-error-${nextId('link-error')}`;
    this.#error.hidden = true;
    this.#alert = doc.createElement('div');
    this.#alert.className = 'neditor-live-region';
    this.#alert.setAttribute('role', 'alert');

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

    this.#element.append(this.#input, this.#error, apply, this.#removeButton, this.#alert);
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

  open(anchor: DOMRect, current: string | null, pin: AnchorPin | null = null): void {
    this.#pin = pin;
    this.#element.hidden = false;
    this.#open = true;
    this.#input.value = current ?? '';
    this.#syncDirection();
    this.#clearInvalid();
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
    this.#pin = null;
    this.#element.hidden = true;
  }

  /** Flags the URL as unusable and keeps the popover open for a correction. */
  markInvalid(): void {
    // Asked before anything moves focus. Enter in the field leaves focus where
    // it is, so the description added below is never read and the alert has
    // to speak. From Apply, focus moves into the field, which reads its new
    // description on arrival -- filling the alert as well, in the same tick,
    // had the reader say the message twice.
    const announce = holdsFocus(this.#input);

    this.#input.dataset.invalid = 'true';
    this.#input.setAttribute('aria-invalid', 'true');
    this.#input.setAttribute('aria-describedby', this.#error.id);
    this.#error.hidden = false;
    this.#error.textContent = this.#message;
    // Written again on every rejection that needs it: a live region speaks
    // when its content changes, and a second bad URL in a row would otherwise
    // leave the same words standing and say nothing.
    this.#alert.textContent = announce ? this.#message : '';
    this.#input.focus();
    this.#input.select();
  }

  /**
   * LTR while there is a URL to lay out, inherited while the placeholder shows.
   * An empty `dir` is the same as none. Not `unicode-bidi: plaintext`, which
   * would decide from the text alone: Firefox stops painting the placeholder.
   */
  #syncDirection(): void {
    this.#input.dir = this.#input.value ? 'ltr' : '';
  }

  /** So a corrected value stops being announced as the rejected one. */
  #clearInvalid(): void {
    delete this.#input.dataset.invalid;
    this.#input.removeAttribute('aria-invalid');
    this.#input.removeAttribute('aria-describedby');
    this.#error.hidden = true;
    this.#error.textContent = '';
    this.#alert.textContent = '';
  }

  /** True while the user is in the dialog: its input or one of its buttons. */
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
