import type { NEditorLabels } from '../labels.ts';

/**
 * The block gutter: the add button and drag handle that follow the pointer.
 *
 * One element for the whole editor, repositioned on hover, rather than a pair
 * of buttons rendered into every block. With a thousand blocks that is the
 * difference between two DOM nodes and two thousand, and it keeps the controls
 * out of the contenteditable subtree where they would become editable content.
 */

export interface GutterHooks {
  /** The add button was pressed for this block. */
  onAdd(blockId: string, event: MouseEvent): void;
  /** The handle was pressed without dragging. */
  onSelect(blockId: string, event: MouseEvent): void;
  /** The handle began a drag. */
  onDragStart(blockId: string, event: PointerEvent): void;
}

const ADD_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>';

/** Six dots, the universal "grab me" affordance. */
const HANDLE_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">' +
  [
    [6, 4],
    [10, 4],
    [6, 8],
    [10, 8],
    [6, 12],
    [10, 12],
  ]
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.35"/>`)
    .join('') +
  '</svg>';

export class Gutter {
  readonly #element: HTMLElement;
  readonly #addButton: HTMLButtonElement;
  readonly #handle: HTMLButtonElement;
  readonly #hooks: GutterHooks;

  #blockId: string | null = null;

  constructor(doc: Document, hooks: GutterHooks, labels: NEditorLabels) {
    this.#hooks = hooks;

    this.#element = doc.createElement('div');
    this.#element.className = 'neditor-gutter';
    this.#element.dataset.visible = 'false';
    // Not editable content, and never part of the document's text.
    this.#element.contentEditable = 'false';
    this.#element.setAttribute('aria-hidden', 'true');

    this.#addButton = this.#createButton(doc, 'neditor-gutter__add', ADD_ICON, labels.gutterAdd);
    this.#handle = this.#createButton(
      doc,
      'neditor-gutter__handle',
      HANDLE_ICON,
      labels.gutterHandle,
    );

    this.#addButton.addEventListener('click', (event) => {
      if (this.#blockId) {
        this.#hooks.onAdd(this.#blockId, event);
      }
    });

    this.#handle.addEventListener('pointerdown', (event) => {
      if (this.#blockId && event.button === 0) {
        this.#hooks.onDragStart(this.#blockId, event);
      }
    });

    this.#handle.addEventListener('click', (event) => {
      if (this.#blockId) {
        this.#hooks.onSelect(this.#blockId, event);
      }
    });

    this.#element.append(this.#addButton, this.#handle);
  }

  get element(): HTMLElement {
    return this.#element;
  }

  /** The block the gutter currently points at. */
  get blockId(): string | null {
    return this.#blockId;
  }

  /** True while the pointer is over the controls themselves. */
  contains(node: Node | null): boolean {
    return node !== null && this.#element.contains(node);
  }

  /**
   * Points the gutter at a block.
   *
   * `top` and `left` are offsets within the editor, so this stays correct while
   * the page scrolls without recomputing anything.
   */
  showFor(blockId: string, top: number, left: number): void {
    this.#blockId = blockId;
    this.#element.style.top = `${top}px`;
    // Logical, so the controls sit on the reading-start side under dir="rtl".
    this.#element.style.insetInlineStart = `${left}px`;
    this.#element.dataset.visible = 'true';
  }

  hide(): void {
    this.#blockId = null;
    this.#element.dataset.visible = 'false';
  }

  /** Marks the handle as actively dragging, for styling. */
  setDragging(dragging: boolean): void {
    this.#element.dataset.dragging = String(dragging);
  }

  destroy(): void {
    this.#element.remove();
  }

  #createButton(doc: Document, className: string, icon: string, label: string): HTMLButtonElement {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = `neditor-gutter__button ${className}`;
    button.innerHTML = icon;
    button.title = label;
    button.setAttribute('aria-label', label);
    // Keeps the caret where it is when the control is pressed.
    button.tabIndex = -1;

    return button;
  }
}
