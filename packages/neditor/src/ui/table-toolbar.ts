import type { NEditorLabels } from '../labels.ts';
import type { PortalTheme } from './portal.ts';
import { createPortal, positionPortal } from './portal.ts';

/**
 * Row and column controls for the table the caret is in.
 *
 * One floating toolbar rather than grips aligned to every row and column: the
 * commands always act on the cell holding the caret, so nothing has to be
 * measured against the grid, and there is no per-column DOM to keep in sync.
 */

export type TableCommand =
  | 'insertRowAbove'
  | 'insertRowBelow'
  | 'deleteRow'
  | 'insertColumnLeft'
  | 'insertColumnRight'
  | 'deleteColumn';

export interface TableToolbarHooks {
  onCommand(command: TableCommand): void;
  /** The toolbar is giving focus back to the cell it was opened from. */
  onDismiss(): void;
}

interface ToolbarButton {
  readonly command: TableCommand;
  readonly glyph: string;
}

/**
 * The arrow glyphs are direction, not language, so they stay literal. The two
 * delete buttons carry a word, so they come from `labels` like every other
 * visible string.
 */
function buttonsFor(labels: NEditorLabels): readonly ToolbarButton[] {
  return [
    { command: 'insertRowAbove', glyph: '↑+' },
    { command: 'insertRowBelow', glyph: '↓+' },
    { command: 'deleteRow', glyph: labels.deleteRowGlyph },
    { command: 'insertColumnLeft', glyph: '←+' },
    { command: 'insertColumnRight', glyph: '→+' },
    { command: 'deleteColumn', glyph: labels.deleteColumnGlyph },
  ];
}

export class TableToolbar {
  readonly #element: HTMLElement;
  readonly #hooks: TableToolbarHooks;
  readonly #buttons: HTMLButtonElement[] = [];

  #open = false;
  #activeIndex = 0;

  constructor(doc: Document, hooks: TableToolbarHooks, labels: NEditorLabels) {
    this.#hooks = hooks;
    this.#element = createPortal(doc, 'neditor-table-toolbar');
    this.#element.setAttribute('role', 'toolbar');
    this.#element.setAttribute('aria-label', labels.tableToolbar);

    buttonsFor(labels).forEach((button, index) => {
      if (index === 3) {
        const separator = doc.createElement('div');
        separator.className = 'neditor-toolbar__separator';
        separator.setAttribute('aria-hidden', 'true');
        this.#element.append(separator);
      }

      const node = doc.createElement('button');
      node.type = 'button';
      node.className = 'neditor-table-toolbar__button';
      const name = labels[button.command];
      node.textContent = button.glyph;
      node.title = name;
      node.setAttribute('aria-label', name);
      // Roving tabindex: one stop for the whole toolbar, arrows move within it.
      node.tabIndex = -1;
      node.addEventListener('click', () => {
        this.#hooks.onCommand(button.command);
      });
      node.addEventListener('keydown', (event) => {
        this.#handleKeyDown(event);
      });

      this.#buttons.push(node);
      this.#element.append(node);
    });
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

  show(anchor: DOMRect): void {
    this.#element.hidden = false;
    this.#open = true;
    positionPortal(this.#element, anchor, { prefer: 'above' });
  }

  hide(): void {
    if (!this.#open) {
      return;
    }

    this.#open = false;
    this.#element.hidden = true;
  }

  /**
   * Moves keyboard focus into the toolbar.
   *
   * Reached with F10 from a cell, the standard way to get at a toolbar without
   * a mouse — otherwise deleting a row or column has no keyboard path at all.
   */
  focusFirst(): void {
    this.#activeIndex = 0;
    this.#applyRoving();
    this.#buttons[0]?.focus();
  }

  #handleKeyDown(event: KeyboardEvent): void {
    const last = this.#buttons.length - 1;

    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowLeft': {
        event.preventDefault();
        const delta = event.key === 'ArrowRight' ? 1 : -1;
        this.#activeIndex =
          (this.#activeIndex + delta + this.#buttons.length) % this.#buttons.length;
        break;
      }

      case 'Home':
        event.preventDefault();
        this.#activeIndex = 0;
        break;

      case 'End':
        event.preventDefault();
        this.#activeIndex = last;
        break;

      case 'Escape':
        event.preventDefault();
        this.#hooks.onDismiss();
        return;

      default:
        return;
    }

    this.#applyRoving();
    this.#buttons[this.#activeIndex]?.focus();
  }

  #applyRoving(): void {
    this.#buttons.forEach((button, index) => {
      button.tabIndex = index === this.#activeIndex ? 0 : -1;
    });
  }

  destroy(): void {
    this.#element.remove();
  }
}
