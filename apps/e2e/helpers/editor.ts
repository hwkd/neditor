import { expect } from '@playwright/test';
import type { FrameLocator, Locator, Page } from '@playwright/test';
import type { Block, NEditorDocument, NEditorOptions, SelectionState } from '@neditor/core';

/** `Cmd` on Apple hosts, `Ctrl` elsewhere — the same rule the editor applies. */
export const MOD = 'ControlOrMeta';

export type RemountOptions = Partial<
  Pick<
    NEditorOptions,
    | 'editable'
    | 'autofocus'
    | 'injectStyles'
    | 'theme'
    | 'toolbar'
    | 'historyLimit'
    | 'dragHandles'
    | 'label'
    | 'labels'
    | 'styleNonce'
  >
>;

export type HarnessParams = Record<string, string | number | boolean | undefined>;

export interface LoggedEvent {
  editor: number;
  type: string;
  payload: unknown;
  t: number;
}

/**
 * A page object over one mounted editor.
 *
 * Arranging methods (`load`, `setDocument`, `placeCaret`) may use the API;
 * every method that *acts* goes through real input.
 */
export class EditorPage {
  constructor(
    readonly page: Page,
    /** Which editor on the page, for `mount=two`. */
    readonly index = 0,
    /** For `mount=iframe`: the frame the editor (and its portals) live in. */
    readonly frame?: FrameLocator,
  ) {}

  /** Where the editor's own DOM lives: the page, or the mount frame. */
  get scope(): Page | FrameLocator {
    return this.frame ?? this.page;
  }

  /** Navigate to the harness and wait for the editor to mount. */
  async load(params: HarnessParams = {}): Promise<this> {
    const query = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        query.set(key, String(value === true ? 1 : value === false ? 0 : value));
      }
    }

    await this.page.goto(`/?${query}`);
    await this.page.waitForFunction(() => window.__e2e?.ready === true);
    return this;
  }

  /** A second editor on the same page (`mount=two`). */
  other(index = 1): EditorPage {
    return new EditorPage(this.page, index);
  }

  get root(): Locator {
    return this.scope.locator('.neditor').nth(this.index);
  }

  block(id: string): Locator {
    return this.root.locator(`.neditor-block[data-block-id="${id}"]`);
  }

  content(id: string): Locator {
    return this.block(id).locator('.neditor-block__content').first();
  }

  cell(id: string, row: number, column: number): Locator {
    return this.block(id).locator(`.neditor-block__content[data-cell="${row}:${column}"]`);
  }

  get blocks(): Locator {
    return this.root.locator(':scope > .neditor-block');
  }

  get gutter(): Locator {
    return this.root.locator('.neditor-gutter');
  }

  get liveRegion(): Locator {
    return this.root.locator('.neditor-live-region');
  }

  portal(
    name:
      | 'toolbar'
      | 'slash-menu'
      | 'link-editor'
      | 'image-editor'
      | 'icon-picker'
      | 'table-toolbar',
  ): Locator {
    return this.scope.locator(`.neditor-portal.neditor-${name}`);
  }

  /* --------------------------------- reads --------------------------------- */

  async doc(): Promise<NEditorDocument> {
    return this.page.evaluate((i) => window.__e2e.editors[i]!.getDocument(), this.index);
  }

  async blockData(id: string): Promise<Block | undefined> {
    return (await this.doc()).blocks.find((block) => block.id === id);
  }

  /** Every block as `type:text`, the most useful one-line picture of a document. */
  async outline(): Promise<string[]> {
    return this.page.evaluate((i) => {
      const { lib, editors } = window.__e2e;
      return editors[i]!.getDocument().blocks.map(
        (block) => `${'  '.repeat(block.depth)}${block.type}:${lib.blockText(block)}`,
      );
    }, this.index);
  }

  async texts(): Promise<string[]> {
    return this.page.evaluate((i) => {
      const { lib, editors } = window.__e2e;
      return editors[i]!.getDocument().blocks.map((block) => lib.blockText(block));
    }, this.index);
  }

  async ids(): Promise<string[]> {
    return (await this.doc()).blocks.map((block) => block.id);
  }

  async markdown(): Promise<string> {
    return this.page.evaluate((i) => window.__e2e.editors[i]!.getMarkdown(), this.index);
  }

  async selection(): Promise<SelectionState | null> {
    return this.page.evaluate((i) => window.__e2e.editors[i]!.getSelectionState(), this.index);
  }

  async selected(): Promise<string[]> {
    return this.page.evaluate((i) => window.__e2e.editors[i]!.getSelectedBlocks(), this.index);
  }

  async canUndo(): Promise<boolean> {
    return this.page.evaluate((i) => window.__e2e.editors[i]!.canUndo, this.index);
  }

  async events(type?: string): Promise<LoggedEvent[]> {
    return this.page.evaluate(
      ({ i, type }) =>
        window.__e2e.events.filter((event) => event.editor === i && (!type || event.type === type)),
      { i: this.index, type },
    );
  }

  async announcements(): Promise<string[]> {
    return this.page.evaluate(() => [...window.__e2e.announcements]);
  }

  /** The harness's invariant check, for tests that must assert it in-body (e.g. under `test.fail`). */
  async invariants(): Promise<string[]> {
    return this.page.evaluate(() => window.__e2e.checkInvariants());
  }

  async clearLog(): Promise<void> {
    await this.page.evaluate(() => window.__e2e.clearLog());
  }

  /** The id of the block whose content host holds focus, or null. */
  async focusedBlock(): Promise<string | null> {
    return this.page.evaluate(() => {
      let active: Element | null = document.activeElement;

      // Descend through shadow roots and (same-origin) frames to the real focus.
      for (;;) {
        if (active?.shadowRoot?.activeElement) {
          active = active.shadowRoot.activeElement;
        } else if (active instanceof HTMLIFrameElement && active.contentDocument?.activeElement) {
          active = active.contentDocument.activeElement;
        } else {
          break;
        }
      }

      return active?.closest<HTMLElement>('.neditor-block')?.dataset.blockId ?? null;
    });
  }

  /** Whether focus is anywhere inside this editor (root, host or control). */
  async hasFocus(): Promise<boolean> {
    return this.page.evaluate((i) => {
      const root = window.__e2e.editors[i]!.element;
      const rootNode = root.getRootNode() as Document | ShadowRoot;
      const active = rootNode.activeElement;
      return active !== null && root.contains(active);
    }, this.index);
  }

  /* -------------------------------- arrange -------------------------------- */

  async setDocument(doc: NEditorDocument): Promise<void> {
    await this.page.evaluate(({ i, doc }) => window.__e2e.editors[i]!.setDocument(doc), {
      i: this.index,
      doc,
    });
  }

  /** Options that survive structured cloning into the page (no elements, no callbacks). */
  async remount(options: RemountOptions = {}, docName?: string): Promise<void> {
    await this.page.evaluate(({ options, docName }) => window.__e2e.remount(options, docName), {
      options,
      docName,
    });
  }

  /** Arrange a caret (or range) through the API. Not for the step under test. */
  async placeCaret(
    id: string,
    start: number,
    end = start,
    cell?: { row: number; column: number },
  ): Promise<void> {
    const placed = await this.page.evaluate(
      ({ i, id, start, end, cell }) => window.__e2e.editors[i]!.focusRange(id, start, end, cell),
      { i: this.index, id, start, end, cell },
    );

    if (!placed) {
      throw new Error(`could not place a caret in ${id}`);
    }
  }

  /** Arrange a caret at the end of a block's text. */
  async caretAtEnd(id: string): Promise<void> {
    const length = (await this.page.evaluate(
      ({ i, id }) => {
        const { lib, editors } = window.__e2e;
        const block = editors[i]!.getDocument().blocks.find((b) => b.id === id);
        return block ? lib.richLength(block.content) : 0;
      },
      { i: this.index, id },
    )) as number;
    await this.placeCaret(id, length);
  }

  /**
   * Wait for two animation frames, so that scroll events a focus change
   * queued have been delivered before the next step (a late scroll closes
   * every popover, which is the behaviour, not a flake).
   */
  async settle(): Promise<void> {
    await this.page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  }

  /**
   * Wait until the page has stopped scrolling. A wheel scroll is animated in
   * some engines and on slower machines outlasts two frames, and a scroll
   * event that lands after the next step closes whatever that step opened.
   */
  async settleScroll(): Promise<void> {
    let last = -1;

    await expect
      .poll(
        async () => {
          const now = await this.page.evaluate(() => window.scrollY);
          const still = now === last;
          last = now;
          return still;
        },
        { intervals: [100] },
      )
      .toBe(true);
    await this.settle();
  }

  /* --------------------------------- input --------------------------------- */

  /** The viewport point of the caret position before character `offset` in a host. */
  async pointAt(host: Locator, offset: number): Promise<{ x: number; y: number }> {
    return host.evaluate((element, offset) => {
      const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let remaining = offset;
      let node = walker.nextNode() as Text | null;

      while (node && remaining > node.data.length) {
        remaining -= node.data.length;
        node = walker.nextNode() as Text | null;
      }

      // Coordinates inside a frame are the frame's; lift them to the top page.
      const lift = (point: { x: number; y: number }) => {
        let view = element.ownerDocument.defaultView;

        while (view?.frameElement) {
          const frame = view.frameElement.getBoundingClientRect();
          point.x += frame.left + view.frameElement.clientLeft;
          point.y += frame.top + view.frameElement.clientTop;
          view = view.parent as typeof view;
        }

        return point;
      };

      if (!node) {
        const rect = element.getBoundingClientRect();
        return lift({ x: rect.left + 2, y: rect.top + rect.height / 2 });
      }

      const range = element.ownerDocument.createRange();
      const after = remaining < node.data.length;
      range.setStart(node, after ? remaining : remaining - 1);
      range.setEnd(node, after ? remaining + 1 : remaining);
      const rect = range.getBoundingClientRect();
      return lift({ x: after ? rect.left + 1 : rect.right - 1, y: rect.top + rect.height / 2 });
    }, offset);
  }

  /**
   * Click a control that opens a popover. Playwright's own click scrolls the
   * target into view first, and that scroll's event lands a frame *after* the
   * click -- closing the popover the click just opened. A person cannot click
   * what is off screen, so scroll, let the page settle, then click.
   */
  async clickControl(control: Locator): Promise<void> {
    await control.scrollIntoViewIfNeeded();
    await this.settle();
    await control.click();
  }

  /** A real mouse click at a character offset in a block's text. */
  async clickAt(id: string, offset: number): Promise<void> {
    const point = await this.pointAt(this.content(id), offset);
    await this.page.mouse.click(point.x, point.y);
  }

  /** A real mouse drag from one text offset to another (possibly in another block). */
  async dragText(from: [string, number], to: [string, number], steps = 12): Promise<void> {
    const start = await this.pointAt(this.content(from[0]), from[1]);
    const end = await this.pointAt(this.content(to[0]), to[1]);
    await this.page.mouse.move(start.x, start.y);
    await this.page.mouse.down();
    await this.page.mouse.move(end.x, end.y, { steps });
    await this.page.mouse.up();
  }

  /** Hover a block so its gutter appears, and return the handle. */
  async hoverBlock(id: string): Promise<void> {
    const box = await this.content(id).boundingBox();

    if (!box) {
      throw new Error(`block ${id} is not visible`);
    }

    await this.page.mouse.move(box.x + 10, box.y + box.height / 2);
  }

  get handle(): Locator {
    return this.gutter.locator('.neditor-gutter__handle');
  }

  get addButton(): Locator {
    return this.gutter.locator('.neditor-gutter__add');
  }

  /**
   * Drag block `id` by its handle so that it lands above (`before`) or below
   * (`after`) block `target`.
   */
  async dragBlock(
    id: string,
    target: string,
    where: 'before' | 'after',
    options: { release?: boolean } = {},
  ): Promise<void> {
    await this.hoverBlock(id);
    const handle = await this.handle.boundingBox();
    const box = await this.block(target).boundingBox();

    if (!handle || !box) {
      throw new Error('drag geometry unavailable');
    }

    const y = where === 'before' ? box.y + box.height * 0.25 : box.y + box.height * 0.75;
    await this.page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await this.page.mouse.down();
    await this.page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + 8, {
      steps: 2,
    });
    await this.page.mouse.move(handle.x + handle.width / 2, y, { steps: 10 });

    if (options.release !== false) {
      await this.page.mouse.up();
    }
  }

  async type(text: string): Promise<void> {
    await this.page.keyboard.type(text);
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }
}
