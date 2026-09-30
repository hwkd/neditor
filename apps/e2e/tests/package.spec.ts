import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from '../helpers/test.ts';

/**
 * The published artifact, served the way a consumer meets it: from a CDN
 * origin, under a page whose headers the test controls. Nothing here uses the
 * harness -- it is the package on its own.
 */
const DIST = fileURLToPath(new URL('../../../packages/neditor/dist/', import.meta.url));
const CDN = 'http://cdn.test/npm/@neditor/core@0.1.3/dist/';
const APP = 'http://app.test/';

const TYPES: Record<string, string> = {
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

async function serve(
  context: BrowserContext,
  html: string,
  headers: Record<string, string> = {},
): Promise<string[]> {
  const requested: string[] = [];
  await context.route('http://cdn.test/**', async (route) => {
    const url = new URL(route.request().url());
    const file = url.pathname.replace('/npm/@neditor/core@0.1.3/dist/', '');
    requested.push(file);

    try {
      await route.fulfill({
        body: await readFile(DIST + file),
        headers: {
          'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
          'access-control-allow-origin': '*',
        },
      });
    } catch {
      await route.fulfill({ status: 404, body: 'not found' });
    }
  });
  await context.route(APP + '**', (route) =>
    route.fulfill({ contentType: 'text/html', body: html, headers }),
  );
  return requested;
}

async function ready(page: Page): Promise<void> {
  await page.goto(APP);
  await page.waitForFunction(() => (window as { ready?: boolean }).ready === true);
}

/** A few computed properties that only the stylesheet sets. */
async function styled(
  page: Page,
): Promise<{ padding: string; heading: string; code: string; whiteSpace: string }> {
  return page.evaluate(() => {
    const block = document.querySelector('.neditor-block')!;
    const heading = document.querySelector('.neditor-block__content:is(h1, h2, h3)');
    const code = document.querySelector('pre.neditor-block__pre');
    return {
      padding: getComputedStyle(block).paddingInlineStart,
      heading: heading ? getComputedStyle(heading).fontWeight : '',
      code: code ? getComputedStyle(code).fontFamily : '',
      whiteSpace: getComputedStyle(document.querySelector('.neditor-block__content')!).whiteSpace,
    };
  });
}

const DOC = `{ blocks: blocksFromMarkdown('# From the CDN\\n\\n- item\\n\\n\`\`\`\\ncode\\n\`\`\`') }`;

test.describe('26 · packaging & consumer paths', () => {
  test('PK1 a CDN import of dist/index.mjs resolves its code-split chunk and works', async ({
    page,
    context,
  }) => {
    const requested = await serve(
      context,
      `<!doctype html><meta charset="utf-8"><div id="editor"></div>
      <script type="module">
        import { createEditor, blocksFromMarkdown } from '${CDN}index.mjs';
        window.editor = createEditor({ element: '#editor', doc: ${DOC} });
        window.ready = true;
      </script>`,
    );
    await ready(page);
    expect(requested.some((file) => /^markdown-.*\.mjs$/.test(file))).toBe(true);
    await expect(page.getByRole('heading', { level: 1, name: 'From the CDN' })).toBeVisible();

    await page.evaluate(() => {
      const editor = (
        window as unknown as {
          editor: {
            focus(id: string, offset: number): boolean;
            getDocument(): { blocks: { id: string }[] };
          };
        }
      ).editor;
      const second = editor.getDocument().blocks[1]!;
      editor.focus(second.id, 4);
    });
    await page.keyboard.type(' **b**');
    const markdown = await page.evaluate(() =>
      (window as unknown as { editor: { getMarkdown(): string } }).editor.getMarkdown(),
    );
    expect(markdown).toContain('- item **b**');
  });

  test('PK2 under a strict CSP: styleNonce styles it; without it the style is blocked; styles.css matches', async ({
    page,
    context,
    browser,
  }) => {
    test.info().annotations.push({
      type: 'allow-console-errors',
      description: 'the blocked <style> is logged',
    });
    const csp = {
      'content-security-policy': `default-src 'none'; script-src 'nonce-n1' http://cdn.test; style-src 'nonce-n1' http://cdn.test; img-src 'self'`,
    };
    const page_ = (options: string, head = '') =>
      `<!doctype html><meta charset="utf-8">${head}<div id="editor"></div>
      <script type="module" nonce="n1">
        import { createEditor, blocksFromMarkdown } from '${CDN}index.mjs';
        window.editor = createEditor({ element: '#editor', doc: ${DOC}, ${options} });
        window.ready = true;
      </script>`;

    await serve(context, page_(`styleNonce: 'n1'`), csp);
    await ready(page);
    const injected = await styled(page);
    expect(parseFloat(injected.padding)).toBeGreaterThan(20);
    expect(injected.whiteSpace).toBe('pre-wrap');

    const blocked = await browser.newContext();
    const blockedPage = await blocked.newPage();
    await serve(blocked, page_(''), csp);
    const violations: string[] = [];
    blockedPage.on('console', (message) => violations.push(message.text()));
    await ready(blockedPage);
    expect(parseFloat((await styled(blockedPage)).padding)).toBe(0);
    await blocked.close();

    const linked = await browser.newContext();
    const linkedPage = await linked.newPage();
    await serve(
      linked,
      page_('injectStyles: false', `<link rel="stylesheet" href="${CDN}styles.css">`),
      csp,
    );
    await ready(linkedPage);
    await linkedPage.waitForFunction(() => document.styleSheets.length > 0);
    expect(await styled(linkedPage)).toEqual(injected);
    await linked.close();
  });

  test('PK3 @neditor/core/model runs in a Web Worker, with no DOM', async ({ page, context }) => {
    await serve(
      context,
      `<!doctype html><meta charset="utf-8">
      <script type="module">
        const source = \`
          import { blocksFromMarkdown, toMarkdown, normalizeDocument } from '${CDN}model.mjs';
          onmessage = (event) => {
            const doc = normalizeDocument({ blocks: blocksFromMarkdown(event.data) });
            postMessage({ markdown: toMarkdown(doc), dom: typeof document });
          };
        \`;
        const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })), { type: 'module' });
        worker.onmessage = (event) => { window.result = event.data; window.ready = true; };
        worker.onerror = (event) => { window.result = { error: String(event.message) }; window.ready = true; };
        worker.postMessage('# Title\\n\\n- [x] done\\n\\n| a | b |\\n| - | - |\\n| 1 | 2 |');
      </script>`,
    );
    await ready(page);
    const result = await page.evaluate(() => (window as unknown as { result: unknown }).result);
    expect(result).toEqual({
      markdown: '# Title\n\n- [x] done\n\n| a | b |\n| --- | --- |\n| 1 | 2 |',
      dom: 'undefined',
    });
  });
});
