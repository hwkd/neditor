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

/** A document with ids removed, for comparing content across editors. */
export function shape(doc: NEditorDocument): unknown[] {
  return doc.blocks.map(({ id: _id, ...rest }: Block) => rest);
}

/**
 * FINDING F8. Firefox dispatches clipboard events at <body> when the focused
 * element is not editable, and in block-selection mode focus sits on the
 * editor root (tabindex=-1), whose listeners therefore never run: copy, cut
 * and paste over selected blocks all silently do nothing in Firefox.
 */
export const FIREFOX_BLOCK_CLIPBOARD =
  'FINDING F8: Firefox targets clipboard events at <body> in block-selection mode, so the root’s copy/cut/paste handlers never run';
