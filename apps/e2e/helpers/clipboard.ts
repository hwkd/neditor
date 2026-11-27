import type { Page } from '@playwright/test';
import type { Block, NEditorDocument } from '@neditor/core';

/**
 * Put a foreign payload on the real system clipboard, the way another
 * application would, so the paste that follows is a genuine Mod+V.
 */
export async function writeClipboard(
  page: Page,
  payload: { html?: string; text?: string },
): Promise<void> {
  await page.evaluate(async ({ html, text }) => {
    const items: Record<string, Blob> = {};

    if (html !== undefined) {
      items['text/html'] = new Blob([html], { type: 'text/html' });
    }

    if (text !== undefined) {
      items['text/plain'] = new Blob([text], { type: 'text/plain' });
    }

    await navigator.clipboard.write([new ClipboardItem(items)]);
  }, payload);
}

/**
 * Put a payload on the clipboard the way a page does from its own `copy`
 * event, on a real copy shortcut outside the editor. Unlike `writeClipboard`,
 * no engine cleans what a page sets this way, so the payload reaches the
 * paste exactly as written.
 */
export async function copyFromPage(
  page: Page,
  mod: string,
  payload: { html?: string; text?: string },
): Promise<void> {
  const source = page.locator('#foreign-source');

  await source.evaluate((element, { html, text }) => {
    element.setAttribute('tabindex', '-1');
    // On the document, whatever element the engine aims the event at.
    element.ownerDocument.addEventListener(
      'copy',
      (event) => {
        const data = (event as ClipboardEvent).clipboardData;

        event.preventDefault();

        if (html !== undefined) {
          data?.setData('text/html', html);
        }

        if (text !== undefined) {
          data?.setData('text/plain', text);
        }
      },
      { capture: true, once: true },
    );
  }, payload);
  // Selected, so the copy is aimed at the source, as a page's own would be.
  await source.evaluate((element) => {
    element.focus();
    element.ownerDocument.getSelection()?.selectAllChildren(element);
  });
  await page.keyboard.press(`${mod}+c`);
}

/** A document with ids removed, for comparing content across editors. */
export function shape(doc: NEditorDocument): unknown[] {
  return doc.blocks.map(({ id: _id, ...rest }: Block) => rest);
}
