import type { Page } from '@playwright/test';

/*
 * The guard against a Backspace that goes back in history, observed itself.
 * The URL pins nothing off macOS: no Linux WebKit port binds Backspace to
 * Back, so a page that stayed put there passed with `#guardBackspace`
 * removed (r1 ci-6). `watchBackspace` records every Backspace keydown in the
 * page and each frame in it, on the top window, as the event leaves its own
 * window's bubble phase -- after every listener of its document's, the
 * editor's capture-phase guard among them: what it was aimed at, whether the
 * selection it would act on was in editable text (read through the open
 * shadow roots, as WebKit's editing reads it), and whether it was cancelled.
 * Call it before the page loads anything.
 */
export async function watchBackspace(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Seen = { target: string; editing: boolean; prevented: boolean }[];
    const top = window.top as (Window & { __e2eBackspaces?: Seen }) | null;
    if (!top) return;
    if (top === window) top.__e2eBackspaces = [];
    const editing = (): boolean => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) return false;
      const roots: ShadowRoot[] = [];
      const collect = (root: Document | ShadowRoot) => {
        for (const element of root.querySelectorAll('*')) {
          if (element.shadowRoot) {
            roots.push(element.shadowRoot);
            collect(element.shadowRoot);
          }
        }
      };
      collect(document);
      type Composed = (...args: unknown[]) => StaticRange[];
      const composed = (selection as unknown as { getComposedRanges?: Composed }).getComposedRanges;
      let range: AbstractRange = selection.getRangeAt(0);
      if (composed) {
        try {
          range = composed.call(selection, { shadowRoots: roots })[0] ?? range;
        } catch {
          range = composed.call(selection, ...roots)[0] ?? range;
        }
      }
      const node = range.startContainer;
      const element = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
      return element?.isContentEditable ?? false;
    };
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Backspace') return;
      (top.__e2eBackspaces ??= []).push({
        target: (event.target as Node | null)?.nodeName ?? '',
        editing: editing(),
        prevented: event.defaultPrevented,
      });
    });
  });
}

/**
 * The Backspaces since the page loaded that Safari on macOS takes Back: aimed
 * at the page -- `<body>`, the root element, a `<dialog>` -- with no editable
 * text selected for them to delete in, and cancelled by nothing. Empty is the
 * guard holding, on every platform.
 */
export async function unguardedBackspaces(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type Seen = { target: string; editing: boolean; prevented: boolean }[];
    const seen = (window as Window & { __e2eBackspaces?: Seen }).__e2eBackspaces;
    if (!seen) return ['(not watched)'];
    return seen
      .filter(
        ({ target, editing, prevented }) =>
          !prevented && !editing && ['BODY', 'HTML', 'DIALOG'].includes(target),
      )
      .map(({ target }) => target);
  });
}

/*
 * Safari's page button, on the WebKit ports that are not Apple's. Safari
 * gives a clicked button no focus and leaves focus on the page, with the
 * reader's selection where it was: the state the Backspace guard is for,
 * since its Backspace there goes back. Every other WebKit port focuses the
 * button, as Chromium and Firefox do, where the guard has nothing to do, and
 * these tests passed on Linux with `#guardBackspace` removed (r1 ci-6).
 * There the button's press does what Safari's does.
 */
export async function likeSafarisButton(
  page: Page,
  browserName: string,
  selector: string,
): Promise<void> {
  if (browserName !== 'webkit' || process.platform === 'darwin') return;
  await page.locator(selector).evaluate((button) => {
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      let focused = document.activeElement;
      while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
      (focused as HTMLElement | null)?.blur();
    });
  });
}
