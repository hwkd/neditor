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

  /** Where the controls were last drawn, as `showFor` was given it. */
  #top = Number.NaN;
  #left = Number.NaN;

  /**
   * Whether the controls were revealed by a press that did not land on them.
   * Touch has no hover, so the gutter is offered on a touch `pointerdown` on a
   * block -- and the compatibility `click` that follows the same tap is
   * hit-tested once the controls are drawn under the finger. A tap (or a long
   * press) just beside the text then pressed the `+` it had only just
   * revealed and opened an empty paragraph. That click belongs to the press on
   * the block, and to nothing after it: the flag dies with its gesture -- on
   * the next pointerdown anywhere, and on `pointercancel` -- so a second tap
   * on the now-visible `+` still adds. Outliving it, it swallowed a later tap
   * just off the `+` that WebKit retargets onto it (R6-PTR-2).
   */
  #revealedByPress = false;

  readonly #doc: Document;

  /**
   * Any new press ends the gesture that revealed the controls. Capture on the
   * document, so it runs before the root's own pointerdown, which marks the
   * flag afresh for a press that reveals them again.
   */
  readonly #endPress = (): void => {
    this.#revealedByPress = false;
  };

  constructor(doc: Document, hooks: GutterHooks, labels: NEditorLabels) {
    this.#hooks = hooks;
    this.#doc = doc;

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

    doc.addEventListener('pointerdown', this.#endPress, true);
    doc.addEventListener('pointercancel', this.#endPress, true);

    this.#addButton.addEventListener('click', (event) => {
      if (this.#takeRevealClick()) {
        return;
      }

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
      if (this.#takeRevealClick()) {
        return;
      }

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
   * Points the gutter at a block, and says whether that drew anything new:
   * true when the controls were hidden or are now drawn somewhere else.
   *
   * `top` and `left` are offsets within the editor, so this stays correct while
   * the page scrolls without recomputing anything. It is also why they are the
   * whole answer: within one press nothing else moves the controls.
   */
  showFor(blockId: string, top: number, left: number): boolean {
    const moved =
      this.#element.dataset.visible !== 'true' || top !== this.#top || left !== this.#left;

    this.#blockId = blockId;
    this.#top = top;
    this.#left = left;
    this.#element.style.top = `${top}px`;
    // Logical, so the controls sit on the reading-start side under dir="rtl".
    this.#element.style.insetInlineStart = `${left}px`;
    this.#element.dataset.visible = 'true';

    return moved;
  }

  /**
   * Marks the controls as revealed by a press elsewhere (a touch on the block),
   * so the click that same press ends with is not taken as a press on them.
   * Only for a press that really revealed or moved them (`showFor` says
   * which): one that left them drawn where they were put nothing new under
   * the finger. Not the block they point at -- drawn for the same block at an
   * offset a resize or the text above had made stale, a press re-placed them
   * under the finger, and its click added a paragraph. Kept across
   * `showFor` -- the gutter is re-placed after a layout change -- and cleared
   * by the next press anywhere, by `pointercancel`, by that click, and by
   * `hide`.
   */
  markRevealedByPress(): void {
    this.#revealedByPress = true;
  }

  hide(): void {
    this.#blockId = null;
    this.#revealedByPress = false;
    this.#element.dataset.visible = 'false';
  }

  /** Marks the handle as actively dragging, for styling. */
  setDragging(dragging: boolean): void {
    this.#element.dataset.dragging = String(dragging);
  }

  destroy(): void {
    this.#doc.removeEventListener('pointerdown', this.#endPress, true);
    this.#doc.removeEventListener('pointercancel', this.#endPress, true);
    this.#element.remove();
  }

  /** Whether a click is the tail of the press that revealed the controls; spends it. */
  #takeRevealClick(): boolean {
    const revealed = this.#revealedByPress;
    this.#revealedByPress = false;

    return revealed;
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
