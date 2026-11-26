import type { NEditorLabels } from '../labels.ts';
import { nextId } from '../util/ids.ts';
import type { MathRenderer } from '../view/math.ts';
import { drawMath } from '../view/math.ts';
import type { PortalTheme } from './portal.ts';
import { createPortal, positionPortal } from './portal.ts';

/**
 * The inline equation popover.
 *
 * An inline formula is an atom in the text -- the browser moves over it and
 * deletes it whole, and nothing can be typed inside it -- so its TeX is edited
 * here instead, with the picture drawn live underneath. Like the link popover
 * it takes focus, and the editor remembers which block and range it was opened
 * for so that it can put the caret back when it closes.
 */

export interface MathEditorHooks {
  onApply(tex: string): void;
  onRemove(): void;
  onCancel(): void;
}

export class MathEditor {
  readonly #element: HTMLElement;
  readonly #input: HTMLInputElement;
  readonly #preview: HTMLElement;
  /** The visible message, and the field's description while it applies. */
  readonly #error: HTMLElement;
  /** The live region, which speaks the refusal when the TeX is applied anyway. */
  readonly #alert: HTMLElement;
  /** The refusal's wording, written into the alert each time it is needed. */
  readonly #message: string;
  readonly #removeButton: HTMLButtonElement;
  readonly #hooks: MathEditorHooks;
  readonly #renderMath: MathRenderer | undefined;

  #open = false;
  /** Whether the renderer refused the TeX in the field, as last drawn. */
  #failed = false;

  constructor(
    doc: Document,
    hooks: MathEditorHooks,
    labels: NEditorLabels,
    renderMath: MathRenderer | undefined,
  ) {
    this.#hooks = hooks;
    this.#renderMath = renderMath;
    this.#element = createPortal(doc, 'neditor-math-editor', {
      keepFocus: false,
      onEscape: () => {
        this.#hooks.onCancel();
      },
    });
    this.#element.setAttribute('role', 'dialog');
    this.#element.setAttribute('aria-label', labels.inlineMath);

    this.#input = doc.createElement('input');
    this.#input.type = 'text';
    this.#input.className = 'neditor-link-editor__input neditor-math-editor__input';
    this.#input.placeholder = labels.mathPlaceholder;
    this.#input.spellcheck = false;
    this.#input.autocomplete = 'off';
    this.#input.setAttribute('aria-label', labels.mathTex);

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

    // TeX is LTR whatever the prose around it is, but only while the field
    // holds some: the placeholder is prose in the reader's language, and the
    // stylesheet's `direction: ltr` drew a translated one on the wrong side.
    // As in the link popover; see `#syncDirection`.
    this.#input.addEventListener('input', () => {
      this.#syncDirection();
      this.#draw();
    });

    // The picture of what is being typed. Hidden from assistive technology:
    // the field holds the same formula as TeX, which is what is being edited.
    // Out of the tab order too, though a wide one scrolls: a scroller is a tab
    // stop in Chrome and Firefox, and this one would be announced as nothing.
    this.#preview = doc.createElement('div');
    this.#preview.className = 'neditor-math-editor__preview';
    this.#preview.setAttribute('aria-hidden', 'true');
    this.#preview.tabIndex = -1;

    // What the picture cannot say: that the renderer refused the TeX. Said in
    // words rather than in the picture's red, and named as the field's
    // description while it applies -- which is read when focus arrives in the
    // field, so on opening a formula that was already invalid. While typing,
    // focus never moves, so the description alone is never read: the alert
    // below speaks instead, once, when the TeX is applied.
    this.#message = labels.mathError;
    this.#error = doc.createElement('p');
    this.#error.className = 'neditor-link-editor__error neditor-math-editor__error';
    this.#error.id = `neditor-math-error-${nextId('math-error')}`;
    this.#error.textContent = this.#message;
    this.#error.hidden = true;

    // The link popover's alert, with one difference. A rejected URL keeps that
    // dialog open; refused TeX is written anyway (an inline formula shows its
    // source), so applying always closes this one, from Enter and from Apply
    // alike, and focus goes back to the text. A live region inside the dialog
    // would be hidden with it in the same tick and say nothing, so this one is
    // the dialog's sibling, placed beside it on opening (see `#placeAlert`).
    this.#alert = doc.createElement('div');
    this.#alert.className = 'neditor-live-region';
    this.#alert.setAttribute('role', 'alert');

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

    this.#element.append(this.#input, apply, this.#removeButton, this.#preview, this.#error);
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

  /**
   * @param existing Whether the TeX belongs to a formula already in the text,
   * which is what makes Remove an offer rather than a dead button.
   */
  open(anchor: DOMRect, tex: string, existing: boolean): void {
    this.#element.hidden = false;
    this.#open = true;
    this.#input.value = tex;
    this.#removeButton.hidden = !existing;
    this.#alert.textContent = '';
    this.#placeAlert();
    this.#syncDirection();
    this.#draw();

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

  /** True when focus is inside the popover, so a blur can be ignored. */
  contains(node: Node | null): boolean {
    return node !== null && this.#element.contains(node);
  }

  destroy(): void {
    this.#element.remove();
    this.#alert.remove();
  }

  /**
   * Hands the TeX to the editor, which writes it whether or not it drew and
   * closes the dialog. Refused TeX is announced first: the alert is outside
   * the dialog, so it outlives the close. Not on every keystroke -- TeX is
   * invalid at nearly every point while it is being typed.
   */
  #apply(): void {
    // Emptied by every opening, so this is always a change, which is what a
    // live region speaks on.
    this.#alert.textContent = this.#failed ? this.#message : '';
    this.#hooks.onApply(this.#input.value);
  }

  /**
   * Puts the alert beside the dialog, in whatever tree the editor appended it
   * to. Done on opening rather than on applying, because a live region added
   * with its message already in it is not reliably announced.
   */
  #placeAlert(): void {
    const parent = this.#element.parentNode;

    if (parent && this.#alert.parentNode !== parent) {
      this.#element.after(this.#alert);
    }
  }

  /**
   * LTR while there is TeX to lay out, inherited while the placeholder shows.
   * An empty `dir` is the same as none.
   */
  #syncDirection(): void {
    this.#input.dir = this.#input.value ? 'ltr' : '';
  }

  #draw(): void {
    const tex = this.#input.value;

    // Nothing to show without a renderer: the field already shows the TeX.
    this.#preview.hidden = !this.#renderMath || tex.trim().length === 0;

    const failed = !this.#preview.hidden && !drawMath(this.#preview, tex, false, this.#renderMath);

    this.#preview.hidden ||= failed;
    this.#error.hidden = !failed;
    this.#failed = failed;

    // Named as the field's description only while it is shown: a hidden
    // element a field names directly is still read as its description, and
    // every open announced the error over TeX that drew.
    if (failed) {
      this.#input.dataset.invalid = 'true';
      this.#input.setAttribute('aria-invalid', 'true');
      this.#input.setAttribute('aria-describedby', this.#error.id);
    } else {
      delete this.#input.dataset.invalid;
      this.#input.removeAttribute('aria-invalid');
      this.#input.removeAttribute('aria-describedby');
    }
  }
}
