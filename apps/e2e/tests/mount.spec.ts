import { expect, test } from '../helpers/test.ts';

test.describe('01 · mount & lifecycle', () => {
  test('M1 mounts by selector and by element; a missing selector throws', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await expect(editor.blocks).toHaveCount(3);

    const message = await page.evaluate(() => {
      try {
        window.__e2e.lib.createEditor({ element: '#does-not-exist' });
        return 'no error';
      } catch (error) {
        return String(error);
      }
    });
    expect(message).toContain('[neditor] Mount element not found: selector "#does-not-exist"');

    const bySelector = await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'by-selector';
      document.body.appendChild(host);
      const editor = window.__e2e.lib.createEditor({ element: '#by-selector' });
      const ok = editor.element === host && host.classList.contains('neditor');
      editor.destroy();
      host.remove();
      return ok;
    });
    expect(bySelector).toBe(true);
  });

  test('M2 no doc gives one empty paragraph; autofocus places the caret', async ({
    editor,
    page,
  }) => {
    await editor.load();
    await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'fresh';
      document.querySelector('#stage')!.appendChild(host);
      (window as unknown as { fresh: unknown }).fresh = window.__e2e.lib.createEditor({
        element: host,
        autofocus: true,
      });
    });
    const fresh = page.locator('#fresh');
    await expect(fresh.locator('.neditor-block')).toHaveCount(1);
    await expect(fresh.locator('.neditor-block')).toHaveAttribute('data-block-type', 'paragraph');
    await expect(fresh.locator('.neditor-block__content')).toBeFocused();
    await page.keyboard.type('typed');
    await expect(fresh.locator('.neditor-block__content')).toHaveText('typed');
    await page.evaluate(() =>
      (window as unknown as { fresh: { destroy(): void } }).fresh.destroy(),
    );
  });

  test('M3 root attributes: class, tabindex, label, role', async ({ editor, page }) => {
    await editor.load();
    await expect(editor.root).toHaveAttribute('tabindex', '-1');
    await expect(editor.root).toHaveAttribute('aria-label', 'Rich text editor');
    await expect(editor.root).toHaveAttribute('role', 'group');

    const kept = await page.evaluate(() => {
      const host = document.createElement('section');
      host.setAttribute('aria-label', 'My notes');
      document.body.appendChild(host);
      const editor = window.__e2e.lib.createEditor({ element: host });
      const result = { label: host.getAttribute('aria-label'), role: host.getAttribute('role') };
      editor.destroy();
      host.remove();
      return result;
    });
    // An existing name wins; a <section> already has a role of its own.
    expect(kept).toEqual({ label: 'My notes', role: null });
  });

  test('M4 styles are injected once, first in <head>', async ({ editor }) => {
    await editor.load({ mount: 'two' });
    const styles = await editor.page.evaluate(() => {
      const all = document.querySelectorAll('style[data-neditor-styles]');
      return { count: all.length, first: document.head.firstElementChild === all[0] };
    });
    expect(styles).toEqual({ count: 1, first: true });
  });

  test('M5 destroy removes everything, restores attributes, and is final', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.placeCaret('p1', 0);
    await editor.type('/');
    await expect(editor.portal('slash-menu')).toBeVisible();

    await page.evaluate(() => window.__e2e.editor.destroy());

    const host = page.locator('#editor');
    await expect(host).not.toHaveClass(/neditor/);
    await expect(host.locator('.neditor-block')).toHaveCount(0);
    await expect(host.locator('.neditor-live-region, .neditor-gutter')).toHaveCount(0);
    await expect(page.locator('.neditor-portal')).toHaveCount(0);
    await expect(host).not.toHaveAttribute('tabindex');
    await expect(host).not.toHaveAttribute('aria-label');
    await expect(host).not.toHaveAttribute('role');

    await page.evaluate(() => {
      const editor = window.__e2e.editor;
      editor.destroy();
      editor.setDocument(window.__e2e.docs.paragraphs());
      editor.setEditable(true);
    });
    await expect(host.locator('[contenteditable]')).toHaveCount(0);
    await expect(host).toBeEmpty();
  });

  test('M6 two editors are independent', async ({ editor, page }) => {
    await editor.load({ mount: 'two', doc: 'paragraphs' });
    const second = editor.other();

    await editor.placeCaret('p1', 5);
    await editor.type('X');
    await second.content('p1').click();
    await second.type('hello');

    expect((await editor.texts())[0]).toBe('AlphaX one');
    expect(await second.texts()).toEqual(['hello']);

    // Undo in the second editor does not touch the first.
    await page.keyboard.press('ControlOrMeta+z');
    expect(await second.texts()).toEqual(['']);
    expect((await editor.texts())[0]).toBe('AlphaX one');

    // Each opens its own slash menu with a distinct listbox id.
    await second.type('/');
    const firstId = await editor.page
      .locator('.neditor-slash-menu [role=listbox]')
      .first()
      .getAttribute('id');
    await page.keyboard.press('Escape');
    await editor.placeCaret('p2', 0);
    await editor.type('/');
    const ids = await page
      .locator('.neditor-slash-menu [role=listbox]')
      .evaluateAll((lists) => lists.map((l) => l.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(firstId);
    await page.keyboard.press('Escape');
  });
});
