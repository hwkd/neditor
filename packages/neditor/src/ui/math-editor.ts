import type { NEditorLabels } from '../labels.ts';
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
  readonly #removeButton: HTMLButtonElement;
  readonly #hooks: MathEditorHooks;
  readonly #renderMath: MathRenderer | undefined;

  #open = false;

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
        this.#hooks.onApply(this.#input.value);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.#hooks.onCancel();
      }
    });

    this.#input.addEventListener('input', () => {
      this.#draw();
    });

    // The picture of what is being typed. Hidden from assistive technology:
    // the field holds the same formula as TeX, which is what is being edited.
    this.#preview = doc.createElement('div');
    this.#preview.className = 'neditor-math-editor__preview';
    this.#preview.setAttribute('aria-hidden', 'true');

    const apply = doc.createElement('button');
    apply.type = 'button';
    apply.className = 'neditor-link-editor__button';
    apply.textContent = labels.apply;
    apply.addEventListener('click', () => {
      this.#hooks.onApply(this.#input.value);
    });

    this.#removeButton = doc.createElement('button');
    this.#removeButton.type = 'button';
    this.#removeButton.className =
      'neditor-link-editor__button neditor-link-editor__button--remove';
    this.#removeButton.textContent = labels.remove;
    this.#removeButton.addEventListener('click', () => {
      this.#hooks.onRemove();
    });

    this.#element.append(this.#input, this.#preview, apply, this.#removeButton);
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
  }

  #draw(): void {
    const tex = this.#input.value;

    // Nothing to show without a renderer: the field already shows the TeX.
    this.#preview.hidden = !this.#renderMath || tex.trim().length === 0;

    if (!this.#preview.hidden) {
      drawMath(this.#preview, tex, false, this.#renderMath);
    }
  }
}
