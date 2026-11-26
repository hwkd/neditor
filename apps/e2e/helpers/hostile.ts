import type { Page } from '@playwright/test';

const handler = 'onerror="window.__pwned=1"';

/**
 * Markup the reader copies into wrappers of its own: a run cut at its
 * pictures (in a paragraph, a container, a flex row's items) and an inline
 * wrapper's formatting pushed into the blocks it holds. Built in the live
 * document, a copy was adopted into it: its image started loading, failed,
 * and ran the pasted handler -- in every engine, before the fix. Each of these
 * ran it then. Each comes with the text it reads as, which shows it arrived:
 * none is in the drop spec's fixture already.
 */
export const READER_COPIES: ReadonlyArray<readonly [html: string, text: string]> = [
  [`<p>safe<img src="https://i.test/a.png" ${handler}>more</p>`, 'safemore'],
  [
    `<div style="display:flex"><span>a</span><img src="https://i.test/b.png" ${handler}></div><p>z</p>`,
    'az',
  ],
  [`<b><p>x</p><img src="https://i.test/c.png" ${handler}></b>`, 'x'],
  [`<header>hq<img src="https://i.test/d.png" ${handler}></header>`, 'hq'],
];

/**
 * Records the HTML each paste or drop carries as it reaches the page, ahead of
 * the editor: the text a payload reads as shows the markup arrived, but not
 * that its handler did, which an engine's own cleaning can take out first.
 */
export async function recordArrivingHtml(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const seen: string[] = [];

    (window as { __arrived?: string[] }).__arrived = seen;
    document.addEventListener(
      'paste',
      (event) => seen.push(event.clipboardData?.getData('text/html') ?? ''),
      true,
    );
    document.addEventListener(
      'drop',
      (event) => seen.push(event.dataTransfer?.getData('text/html') ?? ''),
      true,
    );
  });

  return () => page.evaluate(() => (window as { __arrived?: string[] }).__arrived ?? []);
}

/**
 * Waits until an image that cannot load, made now, has failed: by then a copy
 * made earlier would have failed too, and run its handler.
 */
export async function afterFailedLoads(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const probe = new Image();
        probe.onerror = () => setTimeout(resolve, 50);
        probe.src = 'https://i.test/probe.png';
      }),
  );
}
