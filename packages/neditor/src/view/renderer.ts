import type { Block, BlockType } from '../model/document.ts';
import { DEFAULT_CALLOUT_ICON, computeListNumbers, isVoidType } from '../model/document.ts';
import type { NEditorLabels } from '../labels.ts';
import { asElement } from '../util/dom.ts';
import type { TableRows } from '../model/table.ts';
import { tableSize } from '../model/table.ts';
import type { RichText } from '../model/rich-text.ts';
import { renderRichText } from './rich-dom.ts';

/**
 * The view layer.
 *
 * Re-rendering a contenteditable from scratch destroys the caret, so the
 * renderer reconciles instead: it keeps one DOM element per block id, reuses it
 * across renders, and only writes `textContent` when it actually differs from
 * what the browser already holds. Typing therefore touches the model and the
 * DOM stays exactly as the user left it.
 */

export interface BlockView {
  readonly root: HTMLElement;
  /** The contenteditable host, or null for void blocks such as dividers. */
  readonly content: HTMLElement | null;
  type: BlockType;
  /**
   * Fingerprint of the runs currently in the DOM.
   *
   * Plain text is not enough to detect a change: bolding a word leaves the text
   * identical while the element nesting must be rebuilt.
   */
  contentKey: string;
  /** For tables: the editable host per cell, row-major. */
  cells: HTMLElement[][] | null;
  /** For tables: the content fingerprint per cell. */
  cellKeys: string[][] | null;
  /** Shape of the view, as opposed to its content. See {@link viewKey}. */
  key: string;
}

/** The common shape of a freshly built view. */
function emptyView(
  root: HTMLElement,
  content: HTMLElement | null,
  block: Block,
): Omit<BlockView, 'key'> {
  return {
    root,
    content,
    type: block.type,
    contentKey: contentKey([]),
    cells: null,
    cellKeys: null,
  };
}

/** Stable fingerprint of a block's content. */
function contentKey(content: RichText): string {
  return JSON.stringify(content);
}

/**
 * Identity of a view's *structure*.
 *
 * A change here means the elements themselves must be rebuilt — a table gaining
 * a column, an image gaining a source — while a change in content alone is
 * written into the existing elements so the caret survives.
 */
function viewKey(block: Block): string {
  if (block.type === 'image') {
    return `image:${block.src ? 'set' : 'empty'}`;
  }

  if (block.type === 'table') {
    const { rows, columns } = tableSize(block.rows ?? []);
    return `table:${rows}x${columns}`;
  }

  return block.type;
}

export interface RendererHooks {
  /** Fired when a to-do checkbox is clicked. */
  onToggleTodo(id: string): void;
  /** Fired when a toggle's chevron is clicked. */
  onToggleCollapsed(id: string): void;
  /** Fired when a callout's icon is clicked; the button anchors the picker. */
  onPickIcon(id: string, anchor: HTMLElement): void;
  /** Fired when an image (or its empty placeholder) is clicked. */
  onEditImage(id: string, anchor: HTMLElement): void;
}

/** A right-pointing triangle; CSS rotates it when the toggle is open. */
const CHEVRON_ICON =
  '<svg viewBox="0 0 12 12" width="10" height="10" fill="currentColor" aria-hidden="true">' +
  '<path d="M4 2.5 8.5 6 4 9.5z"/></svg>';

/** The semantic element each block type renders its text into. */
function contentTagFor(type: BlockType): string {
  switch (type) {
    case 'heading1':
      return 'h1';
    case 'heading2':
      return 'h2';
    case 'heading3':
      return 'h3';
    case 'quote':
      return 'blockquote';
    case 'code':
      return 'code';
    default:
      return 'div';
  }
}

export class Renderer {
  readonly #root: HTMLElement;
  readonly #hooks: RendererHooks;
  readonly #views = new Map<string, BlockView>();

  /** Blocks selected as whole units, distinct from a text selection. */
  #selected: ReadonlySet<string> = new Set();

  /** Whether the hosts this renderer creates accept typing. */
  #editable = true;

  readonly #labels: NEditorLabels;

  constructor(root: HTMLElement, hooks: RendererHooks, labels: NEditorLabels) {
    this.#root = root;
    this.#hooks = hooks;
    this.#labels = labels;
  }

  /**
   * Sets whether every editable host accepts typing.
   *
   * Owned by the renderer because it alone knows every host — a table has one
   * per cell, and the editor only ever saw the first. Written in both
   * directions so the flag is reversible.
   */
  setEditable(editable: boolean): void {
    this.#editable = editable;

    for (const view of this.#views.values()) {
      this.#applyEditable(view);
    }
  }

  #applyEditable(view: BlockView): void {
    const flag = String(this.#editable);

    for (const host of this.#hostsOf(view)) {
      if (host.contentEditable !== flag) {
        host.contentEditable = flag;
      }

      host.setAttribute('aria-readonly', String(!this.#editable));
    }

    // A control that cannot act is not an offer. Both image buttons open a
    // popover the editor refuses to open while read-only, so left enabled they
    // are tab stops that answer with nothing.
    if (view.root.dataset.blockType === 'image') {
      for (const control of view.root.querySelectorAll<HTMLButtonElement>(
        '.neditor-image__trigger, .neditor-image__placeholder',
      )) {
        control.disabled = !this.#editable;
      }
    }
  }

  /** Every editable host a view owns: its content, or all of a table's cells. */
  #hostsOf(view: BlockView): HTMLElement[] {
    if (view.cells) {
      return view.cells.flat();
    }

    return view.content ? [view.content] : [];
  }

  /**
   * Marks which blocks are selected as units.
   *
   * Selection is presentation over the same blocks, so this only flips an
   * attribute — it never rebuilds a view and so never disturbs the caret.
   */
  setSelected(ids: ReadonlySet<string>): void {
    this.#selected = ids;

    for (const [id, view] of this.#views) {
      this.#applySelected(view, ids.has(id));
    }
  }

  #applySelected(view: BlockView, selected: boolean): void {
    if (selected) {
      view.root.dataset.selected = 'true';
    } else {
      delete view.root.dataset.selected;
    }

    // Block selection had no accessible representation at all — only a colour.
    view.root.setAttribute('aria-selected', String(selected));
  }

  getView(id: string): BlockView | undefined {
    return this.#views.get(id);
  }

  /**
   * Resolves the block id that owns a DOM node, if any.
   *
   * Scoped to this renderer's root. `data-block-id` is an ordinary attribute
   * that the embedding page is free to use for its own purposes, and a node
   * from outside the editor is not ours whatever it happens to carry.
   */
  blockIdFromNode(node: Node | null): string | undefined {
    const element = asElement(node);
    const host = element?.closest<HTMLElement>('[data-block-id]');

    return host && this.#root.contains(host) ? host.dataset.blockId : undefined;
  }

  render(blocks: readonly Block[]): void {
    const numbers = computeListNumbers(blocks);
    const live = new Set<string>();

    blocks.forEach((block, index) => {
      let view = this.#views.get(block.id);

      // A change of shape swaps the elements, so the view is rebuilt.
      if (!view || view.key !== viewKey(block)) {
        view?.root.remove();
        view = this.#createView(block);
        this.#views.set(block.id, view);
      }

      this.#updateView(view, block, numbers.get(block.id));

      // insertBefore moves an existing node rather than cloning it, so this
      // both inserts new blocks and reorders moved ones.
      const current = this.#root.children.item(index);

      if (current !== view.root) {
        this.#root.insertBefore(view.root, current);
      }

      live.add(block.id);
    });

    for (const [id, view] of this.#views) {
      if (!live.has(id)) {
        view.root.remove();
        this.#views.delete(id);
      }
    }
  }

  destroy(): void {
    for (const view of this.#views.values()) {
      view.root.remove();
    }

    this.#views.clear();
  }

  #createView(block: Block): BlockView {
    const doc = this.#root.ownerDocument;
    const root = doc.createElement('div');
    root.className = 'neditor-block';
    root.dataset.blockId = block.id;
    root.dataset.blockType = block.type;

    if (block.type === 'image') {
      return this.#createImageView(doc, root, block);
    }

    if (block.type === 'table') {
      return this.#createTableView(doc, root, block);
    }

    if (block.type === 'divider') {
      const rule = doc.createElement('hr');
      rule.className = 'neditor-block__divider';
      root.append(rule);

      return { ...emptyView(root, null, block), key: viewKey(block) };
    }

    const marker = this.#createMarker(block);
    const content = doc.createElement(contentTagFor(block.type));
    content.className = 'neditor-block__content';
    content.contentEditable = 'true';
    // A code block is literal text; autocorrect would rewrite it into the model.
    content.spellcheck = block.type !== 'code';
    // Deliberately no role="textbox": it would win over the host-language role
    // and erase the h1/h2/h3/blockquote semantics the tag was chosen for, so
    // heading navigation would report nothing. contenteditable already exposes
    // an editable text field on top of the element's own role.
    content.id = `${block.id}-content`;

    const placeholder = this.#labels.placeholders[block.type];

    if (placeholder) {
      content.dataset.placeholder = placeholder;
    }

    // `code` is inline, so it needs a block wrapper to lay out as a code block.
    if (block.type === 'code') {
      const pre = doc.createElement('pre');
      pre.className = 'neditor-block__pre';
      pre.append(content);
      root.append(pre);
    } else if (block.type === 'callout') {
      // The tint wraps icon and text together, and must not extend into the
      // gutter reservation on the block itself.
      const box = doc.createElement('div');
      box.className = 'neditor-callout';

      if (marker) {
        box.append(marker);
      }

      box.append(content);
      root.append(box);
    } else {
      if (marker) {
        root.append(marker);
      }

      root.append(content);
    }

    return { ...emptyView(root, content, block), key: viewKey(block) };
  }

  /** An editable host, styled and resolved exactly like a block's own content. */
  #createEditable(doc: Document, tag: string, placeholder: string): HTMLElement {
    const element = doc.createElement(tag);
    element.className = 'neditor-block__content';
    element.contentEditable = 'true';
    element.spellcheck = true;
    element.dataset.placeholder = placeholder;

    return element;
  }

  #createImageView(doc: Document, root: HTMLElement, block: Block): BlockView {
    const figure = doc.createElement('figure');
    figure.className = 'neditor-image';

    if (block.src) {
      // The picture and the control that edits it are two separate things, and
      // a <button> wrapped around an <img> can only be one of them: `button`
      // makes its children presentational, and an author `aria-label` beats
      // name-from-content — so the alt text was collected, stored, rendered,
      // and then never announced to anybody. The image is a sibling of the
      // trigger instead, which is laid over it so the whole picture is still
      // the click target a mouse expects.
      const frame = doc.createElement('div');
      frame.className = 'neditor-image__frame';

      const image = doc.createElement('img');
      image.className = 'neditor-image__img';
      image.src = block.src;
      image.alt = block.alt ?? '';
      frame.append(image);

      // Still a button, and still focusable: a bare <img> with a click
      // listener cannot be reached at all, which left alt text impossible to
      // correct without a mouse.
      const trigger = doc.createElement('button');
      trigger.type = 'button';
      trigger.className = 'neditor-image__trigger';
      trigger.setAttribute('aria-label', this.#labels.imageEdit);
      trigger.addEventListener('click', () => {
        this.#hooks.onEditImage(block.id, trigger);
      });
      frame.append(trigger);

      figure.append(frame);
    } else {
      // Without a source there is nothing to show, so offer the way to add one.
      const placeholder = doc.createElement('button');
      placeholder.type = 'button';
      placeholder.className = 'neditor-image__placeholder';
      placeholder.textContent = this.#labels.imageAdd;
      placeholder.addEventListener('mousedown', (event) => {
        event.preventDefault();
      });
      placeholder.addEventListener('click', () => {
        this.#hooks.onEditImage(block.id, placeholder);
      });
      figure.append(placeholder);
    }

    const caption = this.#createEditable(doc, 'figcaption', this.#labels.placeholders.image ?? '');
    figure.append(caption);
    root.append(figure);

    return { ...emptyView(root, caption, block), key: viewKey(block) };
  }

  #createTableView(doc: Document, root: HTMLElement, block: Block): BlockView {
    const rows = block.rows ?? [];
    const wrapper = doc.createElement('div');
    wrapper.className = 'neditor-table';

    const table = doc.createElement('table');
    const head = doc.createElement('thead');
    const body = doc.createElement('tbody');
    const cells: HTMLElement[][] = [];

    rows.forEach((row, rowIndex) => {
      const tr = doc.createElement('tr');
      const rowCells: HTMLElement[] = [];

      row.forEach((_, columnIndex) => {
        // Row 0 is the header, which is why there is no header flag to store.
        const container = doc.createElement(rowIndex === 0 ? 'th' : 'td');
        const editable = this.#createEditable(
          doc,
          'div',
          rowIndex === 0 ? this.#labels.tableHeaderCell : '',
        );
        editable.dataset.cell = `${rowIndex}:${columnIndex}`;
        container.append(editable);
        tr.append(container);
        rowCells.push(editable);
      });

      cells.push(rowCells);
      (rowIndex === 0 ? head : body).append(tr);
    });

    table.append(head);

    if (rows.length > 1) {
      table.append(body);
    }

    wrapper.append(table);
    root.append(wrapper);

    return {
      root,
      // The first cell is where `focus(blockId)` should land.
      content: cells[0]?.[0] ?? null,
      type: block.type,
      contentKey: contentKey([]),
      cells,
      cellKeys: cells.map((row) => row.map(() => contentKey([]))),
      key: viewKey(block),
    };
  }

  #createMarker(block: Block): HTMLElement | null {
    const doc = this.#root.ownerDocument;

    if (block.type === 'todo') {
      const checkbox = doc.createElement('button');
      checkbox.type = 'button';
      checkbox.className = 'neditor-block__checkbox';
      checkbox.setAttribute('role', 'checkbox');
      // Named by the to-do's own text; the box itself is drawn entirely in CSS
      // and would otherwise announce as an unlabelled "checkbox".
      checkbox.setAttribute('aria-labelledby', `${block.id}-content`);
      // Keeps the caret in the text when the checkbox is clicked.
      checkbox.tabIndex = -1;
      checkbox.addEventListener('mousedown', (event) => {
        event.preventDefault();
      });
      checkbox.addEventListener('click', () => {
        this.#hooks.onToggleTodo(block.id);
      });

      return checkbox;
    }

    if (block.type === 'toggle') {
      const chevron = doc.createElement('button');
      chevron.type = 'button';
      chevron.className = 'neditor-block__chevron';
      chevron.innerHTML = CHEVRON_ICON;
      // Focusable: collapsing is the only way to reach a toggle's children, and
      // a keyboard user who cannot expand one can never read them.
      chevron.tabIndex = 0;
      chevron.setAttribute('aria-label', this.#labels.toggleCollapse);
      chevron.setAttribute('aria-controls', `${block.id}-content`);
      chevron.addEventListener('mousedown', (event) => {
        event.preventDefault();
      });
      chevron.addEventListener('click', () => {
        this.#hooks.onToggleCollapsed(block.id);
      });

      return chevron;
    }

    if (block.type === 'callout') {
      const icon = doc.createElement('button');
      icon.type = 'button';
      icon.className = 'neditor-block__icon';
      icon.tabIndex = 0;
      icon.setAttribute('aria-label', this.#labels.calloutIcon);
      icon.addEventListener('mousedown', (event) => {
        event.preventDefault();
      });
      icon.addEventListener('click', () => {
        this.#hooks.onPickIcon(block.id, icon);
      });

      return icon;
    }

    if (block.type === 'bulleted_list' || block.type === 'numbered_list') {
      const marker = doc.createElement('div');
      marker.className = 'neditor-block__marker';
      // Exposed rather than aria-hidden: these blocks are not wrapped in a real
      // <ul>/<ol>, so the bullet or number is the only thing telling a screen
      // reader this is a list item at all.
      marker.setAttribute('aria-hidden', 'false');

      return marker;
    }

    return null;
  }

  #updateView(view: BlockView, block: Block, listNumber: number | undefined): void {
    const { root, content } = view;

    this.#applySelected(view, this.#selected.has(block.id));
    this.#applyEditable(view);

    if (root.dataset.depth !== String(block.depth)) {
      root.dataset.depth = String(block.depth);
      root.style.setProperty('--neditor-depth', String(block.depth));
    }

    if (block.type === 'todo') {
      const checked = block.checked === true;
      root.dataset.checked = String(checked);

      const checkbox = root.querySelector<HTMLElement>('.neditor-block__checkbox');
      checkbox?.setAttribute('aria-checked', String(checked));
    }

    if (block.type === 'toggle') {
      const collapsed = block.collapsed === true;
      root.dataset.collapsed = String(collapsed);
      root
        .querySelector('.neditor-block__chevron')
        ?.setAttribute('aria-expanded', String(!collapsed));
    }

    if (block.type === 'callout') {
      const iconElement = root.querySelector<HTMLElement>('.neditor-block__icon');
      const icon = block.icon ?? DEFAULT_CALLOUT_ICON;

      if (iconElement && iconElement.textContent !== icon) {
        iconElement.textContent = icon;
      }
    }

    const marker = root.querySelector<HTMLElement>('.neditor-block__marker');

    if (marker) {
      const label = block.type === 'numbered_list' ? `${listNumber ?? 1}.` : '•';

      if (marker.textContent !== label) {
        marker.textContent = label;
      }
    }

    if (block.type === 'image') {
      const image = root.querySelector('img');

      // Compared as written, not as resolved: `image.src` is absolute, so a
      // relative source would look different on every pass.
      if (image && image.getAttribute('src') !== (block.src ?? '')) {
        image.setAttribute('src', block.src ?? '');
      }

      if (image && image.alt !== (block.alt ?? '')) {
        image.alt = block.alt ?? '';
      }
    }

    if (block.type === 'table' && view.cells && view.cellKeys) {
      this.#updateCells(view, block.rows ?? []);
    }

    if (content && !isVoidType(block.type) && block.type !== 'table') {
      // Only touch the DOM when it has genuinely drifted from the model,
      // otherwise the browser collapses the caret on every keystroke.
      const key = contentKey(block.content);

      if (view.contentKey !== key) {
        content.replaceChildren(renderRichText(content.ownerDocument, block.content));
        view.contentKey = key;
      }
    }
  }

  /** Writes only the cells whose content has drifted from the model. */
  #updateCells(view: BlockView, rows: TableRows): void {
    const { cells, cellKeys } = view;

    if (!cells || !cellKeys) {
      return;
    }

    rows.forEach((row, rowIndex) => {
      row.forEach((cell, columnIndex) => {
        const element = cells[rowIndex]?.[columnIndex];
        const keys = cellKeys[rowIndex];

        if (!element || !keys) {
          return;
        }

        const key = contentKey(cell);

        if (keys[columnIndex] === key) {
          return;
        }

        element.replaceChildren(renderRichText(element.ownerDocument, cell));
        keys[columnIndex] = key;
      });
    });
  }

  /** Records that a cell's DOM already matches `content`. See {@link syncFromDom}. */
  syncCellFromDom(id: string, row: number, column: number, content: RichText): void {
    const keys = this.#views.get(id)?.cellKeys?.[row];

    if (keys) {
      keys[column] = contentKey(content);
    }
  }

  /**
   * Records that the DOM already matches `content`.
   *
   * Typing mutates the contenteditable directly and the editor reads it back
   * into runs, so the DOM is ahead of the last render. Without this the next
   * structural render would rebuild that block and drop the caret.
   */
  syncFromDom(id: string, content: RichText): void {
    const view = this.#views.get(id);

    if (view) {
      view.contentKey = contentKey(content);
    }
  }
}
