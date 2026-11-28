import type { Block, BlockType } from '../model/document.ts';
import { nextId } from '../util/ids.ts';
import {
  DEFAULT_CALLOUT_ICON,
  computeListNumbers,
  isLiteralType,
  isVoidType,
} from '../model/document.ts';
import type { NEditorLabels } from '../labels.ts';
import { asElement } from '../util/dom.ts';
import type { TableRows } from '../model/table.ts';
import { tableSize } from '../model/table.ts';
import type { RichText } from '../model/rich-text.ts';
import { richToPlainText } from '../model/rich-text.ts';
import type { RenderOptions } from './rich-dom.ts';
import { renderRichText } from './rich-dom.ts';
import { readSelection } from './selection.ts';
import type { MathRenderer } from './math.ts';
import { drawMath } from './math.ts';

/**
 * The view layer.
 *
 * Re-rendering a contenteditable from scratch destroys the caret, so the
 * renderer reconciles instead: it keeps one DOM element per block id, reuses it
 * across renders, and only writes `textContent` when it actually differs from
 * what the browser already holds. Typing therefore touches the model and the
 * DOM stays exactly as the user left it. A reorder moves the other blocks
 * around the one the reader is in, never that one (`#positionAround`).
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

  /** How rich text is drawn here: for editing, with the host's math renderer. */
  readonly #richOptions: RenderOptions;
  readonly #renderMath: MathRenderer | undefined;

  /** The TeX each display equation's preview was last drawn from. */
  readonly #previews = new WeakMap<HTMLElement, string>();

  /** Distinguishes this editor's DOM ids from every other editor's on the page. */
  readonly #instance: number;

  /**
   * Watches each table's scroller, and the table in it, for whether the table
   * is wider than the block (`#markTableScroller`). Made on the first table;
   * `null` where the realm has no `ResizeObserver`.
   */
  #tableObserver: ResizeObserver | null | undefined;
  readonly #watchedTables = new WeakSet<HTMLElement>();

  constructor(
    root: HTMLElement,
    hooks: RendererHooks,
    labels: NEditorLabels,
    options: { readonly renderMath?: MathRenderer } = {},
  ) {
    this.#root = root;
    this.#hooks = hooks;
    this.#labels = labels;
    this.#renderMath = options.renderMath;
    this.#richOptions = { editing: true, renderMath: options.renderMath };
    this.#instance = nextId('renderer');
  }

  /**
   * A document-unique id for a block's content element.
   *
   * Block ids are unique within a document, not within a page, and keeping them
   * stable across a published/draft pair is the point of them. Two editors over
   * the same document therefore emitted the same `id` twice, and every
   * `aria-labelledby` resolves to the first match in the document -- so the
   * second editor's to-do announced the first editor's text.
   */
  #domId(blockId: string): string {
    return `neditor-${this.#instance}-${blockId}-content`;
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

      // Deliberately no `aria-readonly`. These hosts are h1/h2/h3, blockquote,
      // pre, div, figcaption and table cells -- none of whose roles permit it,
      // so browsers drop it and axe reports a critical `aria-allowed-attr`
      // violation on every block of every instance. `contenteditable` already
      // tells assistive technology whether the field takes input, which is the
      // thing the attribute was trying to say.
    }

    if (view.type === 'math') {
      this.#applyMathAccess(view);
    }

    // A control that cannot act is not an offer. The image trigger and the
    // callout icon open a popover the editor refuses to open while read-only,
    // so left enabled they are tab stops that answer with nothing. They keep
    // drawing the picture and the emoji, which are content; only the control
    // goes.
    const type = view.root.dataset.blockType;

    if (type === 'image' || type === 'callout') {
      for (const control of view.root.querySelectorAll<HTMLButtonElement>(
        '.neditor-image__trigger, .neditor-block__icon',
      )) {
        control.disabled = !this.#editable;
      }
    }

    if (type === 'image') {
      this.#applyImagePlaceholder(view);
    }

    // The checkbox stays focusable and in the tree in a read-only view -- it is
    // the to-do's state, and a reader has to be able to hear it -- but it no
    // longer takes a press, and `checkbox` is a role that may say so. Without
    // it a screen reader offered a box to tick that did nothing.
    const checkbox = type === 'todo' ? view.root.querySelector('.neditor-block__checkbox') : null;

    if (checkbox && checkbox.hasAttribute('aria-readonly') === this.#editable) {
      if (this.#editable) {
        checkbox.removeAttribute('aria-readonly');
      } else {
        checkbox.setAttribute('aria-readonly', 'true');
      }
    }

    if (view.type === 'table') {
      this.#watchTable(view);
    }
  }

  /**
   * A table wider than a read-only view is a tab stop, a named region.
   *
   * Its scroller is the only way to its last columns. In an editable view the
   * cells are hosts and the browser scrolls the caret's into view, but a
   * read-only one has nothing focusable inside: WebKit never stops on the
   * scroller, so the columns past its edge could not be reached by keyboard at
   * all, and Chromium and Firefox stop on it as a nameless group. Only while it
   * overflows, so a table that fits adds no tab stop.
   */
  #markTableScroller(wrapper: HTMLElement): void {
    if (!this.#editable && wrapper.scrollWidth > wrapper.clientWidth) {
      if (wrapper.getAttribute('tabindex') !== '0') {
        wrapper.tabIndex = 0;
      }

      wrapper.setAttribute('role', 'region');
      wrapper.setAttribute('aria-label', this.#labels.tableScrollRegion);
      return;
    }

    wrapper.removeAttribute('tabindex');
    wrapper.removeAttribute('role');
    wrapper.removeAttribute('aria-label');
  }

  /** Marks a table's scroller now, and again whenever it or its table resizes. */
  #watchTable(view: BlockView): void {
    const wrapper = view.root.querySelector<HTMLElement>('.neditor-table');

    if (!wrapper) {
      return;
    }

    this.#markTableScroller(wrapper);

    if (this.#watchedTables.has(wrapper)) {
      return;
    }

    if (this.#tableObserver === undefined) {
      const Observer = this.#root.ownerDocument.defaultView?.ResizeObserver;

      this.#tableObserver = Observer
        ? new Observer((entries) => {
            for (const { target } of entries) {
              const scroller = target.closest<HTMLElement>('.neditor-table');

              if (scroller) {
                this.#markTableScroller(scroller);
              }
            }
          })
        : null;
    }

    if (!this.#tableObserver) {
      return;
    }

    this.#watchedTables.add(wrapper);
    this.#tableObserver.observe(wrapper);

    const table = wrapper.querySelector('table');

    if (table) {
      this.#tableObserver.observe(table);
    }
  }

  /** Lets go of a table view's elements, which the observer would otherwise keep. */
  #unwatchTable(view: BlockView): void {
    const wrapper = view.root.querySelector<HTMLElement>('.neditor-table');

    if (!wrapper || !this.#tableObserver || !this.#watchedTables.has(wrapper)) {
      return;
    }

    this.#tableObserver.unobserve(wrapper);

    const table = wrapper.querySelector('table');

    if (table) {
      this.#tableObserver.unobserve(table);
    }
  }

  /**
   * Draws the empty image's "Add an image" button while the editor takes
   * input, and removes it while it does not.
   *
   * Disabling it was not enough: it was still drawn, and still exposed as a
   * button by that name, which is an authoring prompt in a view that takes no
   * authoring -- the same reason placeholders are drawn only on hosts that
   * take typing. A picture is content and stays; this button is nothing but
   * the offer, so read-only leaves the figure empty instead.
   */
  #applyImagePlaceholder(view: BlockView): void {
    const figure = view.root.querySelector('.neditor-image');
    const current = figure?.querySelector('.neditor-image__placeholder');

    // Only a figure with no picture offers one; a set image has its trigger.
    if (!figure || figure.querySelector('.neditor-image__frame')) {
      return;
    }

    if (!this.#editable) {
      current?.remove();
      return;
    }

    if (current) {
      return;
    }

    const id = view.root.dataset.blockId ?? '';
    const placeholder = figure.ownerDocument.createElement('button');
    placeholder.type = 'button';
    placeholder.className = 'neditor-image__placeholder';
    // WebKit skips a button with no tabindex; see the image trigger.
    placeholder.tabIndex = 0;
    placeholder.textContent = this.#labels.imageAdd;
    placeholder.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });
    placeholder.addEventListener('click', () => {
      this.#hooks.onEditImage(id, placeholder);
    });
    figure.prepend(placeholder);
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

    // Deliberately no `aria-selected`: it is prohibited on `role=generic`, which
    // is what a bare block <div> is, so browsers drop it — it left every block
    // carrying aria-selected="false" and told assistive technology nothing. A
    // role that would carry it (option, row, gridcell) would displace the
    // heading and list semantics the content element exists to provide, which
    // is the same trade that made `role="textbox"` wrong here. Selection is
    // announced through the live region instead.
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
    const live = new Set(blocks.map((block) => block.id));

    // Pruned first. Positioning compares each view against
    // `root.children.item(index)`, and while a removed block's element is still
    // sitting in the DOM those indices are shifted -- so every block after the
    // removal failed the comparison and was re-inserted. `insertBefore` moves a
    // node, and moving the node a caret is in blurs it. Deleting one block
    // therefore dropped the caret out of a block that had not changed at all,
    // in the one method written to protect it.
    for (const [id, view] of this.#views) {
      if (!live.has(id)) {
        view.root.remove();
        this.#unwatchTable(view);
        this.#views.delete(id);
      }
    }

    const order = blocks.map((block) => {
      let view = this.#views.get(block.id);

      // A change of shape swaps the elements, so the view is rebuilt.
      if (!view || view.key !== viewKey(block)) {
        if (view) {
          view.root.remove();
          this.#unwatchTable(view);
        }

        view = this.#createView(block);
        this.#views.set(block.id, view);
      }

      this.#updateView(view, block, numbers.get(block.id));

      return view.root;
    });

    // Positioned only once every view is final, so that the block the reader
    // is in is known: a view rebuilt above has already taken focus with it.
    const kept = this.#readersBlock();

    if (kept) {
      this.#positionAround(order, kept);
      return;
    }

    // insertBefore moves an existing node rather than cloning it, so this
    // both inserts new blocks and reorders moved ones.
    order.forEach((element, index) => {
      const current = this.#root.children.item(index);

      if (current !== element) {
        this.#root.insertBefore(element, current);
      }
    });
  }

  /**
   * The block element the reader is in, which a reorder must not move.
   *
   * First the one holding focus, asked of the mount's own root node -- the
   * document, or the shadow root an editor drawn in one lives in, where
   * `document.activeElement` is only the shadow host -- and climbed to the
   * root's child it sits in, so focus on a control inside a block (the to-do
   * checkbox, the callout icon, a table cell) names its block. The root itself
   * (block selection) and the gutter are not blocks and name nothing.
   *
   * With no block holding focus, the one the selection is in: a page's own
   * toolbar button holds focus while it acts on the reader's range (WebKit
   * leaves focus on `<body>` and types into that range), and a block taken
   * out and put back loses every range inside it -- pressed while a peer moved
   * the block, the button bolded nothing.
   */
  #readersBlock(): HTMLElement | null {
    const rootNode = this.#root.getRootNode() as Partial<DocumentOrShadowRoot>;
    const focused = this.#blockOf(rootNode.activeElement ?? null);

    if (focused) {
      return focused;
    }

    const reading = readSelection(this.#root);
    const block = reading ? this.#blockOf(reading.anchorNode) : null;

    return block && block === this.#blockOf(reading!.focusNode) ? block : null;
  }

  /** The block view's element `node` is inside, if it is inside one. */
  #blockOf(node: Node | null): HTMLElement | null {
    while (node && node.parentNode !== this.#root) {
      node = node.parentNode;
    }

    const element = asElement(node) as HTMLElement | null;
    const id = element?.dataset.blockId;

    return id !== undefined && this.#views.get(id)?.root === element ? element : null;
  }

  /**
   * Puts the views in `order` without moving `kept`.
   *
   * A node is moved by taking it out and putting it back, and taking out the
   * element focus is in blurs it in every engine: a peer's `setDocument` that
   * moved the reader's block up -- or moved a block from above it to below,
   * which the top-down loop does by moving the reader's block up past it --
   * left focus on `<body>`, and the next keys typed nothing anywhere
   * (R13-KEY-2). The same move ends a composition in it and collapses every
   * range inside it onto the root. Any order can be reached with one element
   * standing still, so the others are moved around it instead: those before
   * it are placed from the root's start, exactly as the top-down loop places
   * them (it never moves `kept`, which is not one of them), and those after it
   * are each put right after the one before. Where the top-down loop would not
   * have moved `kept` anyway, both make the same moves. Linear, like it.
   */
  #positionAround(order: readonly HTMLElement[], kept: HTMLElement): void {
    const at = order.indexOf(kept);

    for (let index = 0; index < at; index += 1) {
      const element = order[index]!;
      const current = this.#root.children.item(index);

      if (current !== element) {
        this.#root.insertBefore(element, current);
      }
    }

    for (let index = at + 1; index < order.length; index += 1) {
      const element = order[index]!;
      // The element after the one before, as `children` counts: a text node
      // a host left in the mount is not a position.
      const next = order[index - 1]!.nextElementSibling;

      if (next !== element) {
        this.#root.insertBefore(element, next);
      }
    }
  }

  destroy(): void {
    for (const view of this.#views.values()) {
      view.root.remove();
    }

    this.#tableObserver?.disconnect();
    this.#tableObserver = null;

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
    // So is a display equation's TeX.
    content.spellcheck = !isLiteralType(block.type);
    // Deliberately no role="textbox": it would win over the host-language role
    // and erase the h1/h2/h3/blockquote semantics the tag was chosen for, so
    // heading navigation would report nothing. contenteditable already exposes
    // an editable text field on top of the element's own role.
    content.id = this.#domId(block.id);

    const placeholder = this.#labels.placeholders[block.type];

    if (placeholder) {
      content.dataset.placeholder = placeholder;
    }

    // `code` is inline, so it needs a block wrapper to lay out as a code block.
    if (block.type === 'code') {
      const pre = doc.createElement('pre');
      pre.className = 'neditor-block__pre';
      // The corner label the stylesheet prints, so `labels` reaches it.
      pre.dataset.neditorCodeLabel = this.#labels.codeBlockLabel;
      pre.append(content);
      root.append(pre);
    } else if (block.type === 'math') {
      root.append(this.#createMathBox(doc, content, block.id));
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

  /**
   * A display equation: its TeX in an editable host, and what the TeX draws.
   *
   * The host is the block's content like any other -- the caret, input,
   * history and serializers all work on the TeX in it, and nothing else.
   * The preview beside it is the host's renderer's picture of that TeX, kept
   * outside the editing host so typing can never reach it and parsing never
   * reads it. While the equation is being edited both show; otherwise the
   * stylesheet hides the source visually -- never from focus, so arrowing into
   * the block still lands in it and reveals it -- and the preview stands in.
   *
   * Assistive technology gets one of the two, never both -- which one is
   * `#applyMathAccess`'s to say -- and a TeX error is said outside the
   * picture, where it can be read.
   */
  #createMathBox(doc: Document, content: HTMLElement, blockId: string): HTMLElement {
    const box = doc.createElement('div');
    box.className = 'neditor-math-block';
    box.dataset.neditorMathLabel = this.#labels.mathBlockLabel;

    const preview = doc.createElement('div');
    preview.className = 'neditor-math-block__preview';
    preview.contentEditable = 'false';
    preview.setAttribute('aria-hidden', 'true');

    const error = doc.createElement('p');
    error.className = 'neditor-math-block__error';
    error.id = `${this.#domId(blockId)}-math-error`;
    error.textContent = this.#labels.mathError;
    error.hidden = true;

    box.append(content, preview, error);
    return box;
  }

  /**
   * Which of an equation's two views assistive technology gets.
   *
   * While it can be edited, the TeX: it is the text being edited, and the
   * picture beside it is `aria-hidden` and out of the tab order -- a wide one
   * scrolls, and a scroller is a tab stop in Chrome and Firefox, which put
   * focus on a node announced as nothing. Read-only there is nothing to edit
   * and the source cannot even take focus to show itself, so when there is a
   * picture the picture is what is read (a typesetter's MathML, spoken as
   * maths) and the hidden source is hidden from it too. Without a picture the
   * source is the only view, and stays exposed.
   */
  #applyMathAccess(view: BlockView): void {
    const box = view.root.querySelector<HTMLElement>('.neditor-math-block');
    const preview = box?.querySelector<HTMLElement>('.neditor-math-block__preview');

    if (!box || !preview || !view.content) {
      return;
    }

    const pictured = !this.#editable && box.dataset.rendered === 'true';

    if (pictured) {
      preview.removeAttribute('aria-hidden');
      preview.removeAttribute('tabindex');
      view.content.setAttribute('aria-hidden', 'true');
    } else {
      preview.setAttribute('aria-hidden', 'true');
      preview.tabIndex = -1;
      view.content.removeAttribute('aria-hidden');
    }
  }

  /** Redraws a display equation's preview, when its TeX has changed. */
  #updateMathPreview(view: BlockView, content: RichText): void {
    const box = view.root.querySelector<HTMLElement>('.neditor-math-block');
    const preview = box?.querySelector<HTMLElement>('.neditor-math-block__preview');

    if (!box || !preview) {
      return;
    }

    const tex = richToPlainText(content);

    if (this.#previews.get(preview) === tex) {
      return;
    }

    this.#previews.set(preview, tex);

    // Drawn only when there is something to draw it with: without a
    // renderer the source is the only view, and a second copy of it beside
    // itself would say nothing new.
    const drawn = tex.trim().length > 0 && drawMath(preview, tex, true, this.#renderMath);

    if (!drawn) {
      preview.replaceChildren();
    }

    box.dataset.rendered = String(drawn);

    // A renderer that refused the TeX: said beside the source, which names it
    // as its description, so a screen reader hears it with the field -- inside
    // the hidden picture it reached nobody.
    const failed = !drawn && this.#renderMath !== undefined && tex.trim().length > 0;
    const error = box.querySelector<HTMLElement>('.neditor-math-block__error');

    if (error) {
      error.hidden = !failed;
    }

    if (failed && error && view.content) {
      view.content.setAttribute('aria-describedby', error.id);
    } else {
      view.content?.removeAttribute('aria-describedby');
    }

    this.#applyMathAccess(view);
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
      // Explicit, as on the chevron and the callout icon: WebKit leaves a
      // button out of the Tab order unless it carries a tabindex, so there the
      // picture's alt text could not be reached from the keyboard at all.
      // Read-only it is `disabled`, which takes it out again whatever this says.
      trigger.tabIndex = 0;
      trigger.setAttribute('aria-label', this.#labels.imageEdit);
      trigger.addEventListener('click', () => {
        this.#hooks.onEditImage(block.id, trigger);
      });
      frame.append(trigger);

      figure.append(frame);
    }

    // Without a source there is nothing to show, so the figure offers the way
    // to add one -- but only to someone who can: `#applyEditable` draws and
    // withdraws that button as the editor's mode changes.
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
      checkbox.setAttribute('aria-labelledby', this.#domId(block.id));
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
      // Deliberately no aria-controls. What `aria-expanded` describes here is
      // the toggle's *children*, and collapsing removes those from the document
      // altogether — there is no element left to point at. The id this used to
      // name was the toggle's own text host, which is present and visible in
      // both states, so following the reference landed on something that never
      // changes and reported the opposite of the truth.
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
        content.replaceChildren(
          renderRichText(content.ownerDocument, block.content, this.#richOptions),
        );
        view.contentKey = key;
      }
    }

    if (block.type === 'math') {
      this.#updateMathPreview(view, block.content);
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

        element.replaceChildren(renderRichText(element.ownerDocument, cell, this.#richOptions));
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

      // Typing does not re-render, but a display equation's picture lives
      // outside the host the browser edited, so it is redrawn here: the
      // preview follows the TeX as it is typed.
      if (view.type === 'math') {
        this.#updateMathPreview(view, content);
      }
    }
  }
}
