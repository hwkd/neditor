import { expect, EditorPage, MOD, test } from '../helpers/test.ts';
import { writeClipboard } from '../helpers/clipboard.ts';

const WEBKIT_SHADOW =
  'FINDING F10: WebKit exposes no selection inside a shadow root to document.getSelection (and has no ShadowRoot.getSelection); the editor does not use getComposedRanges, so it cannot read the caret there';

test.describe('19 · embedding', () => {
  test('E1 inside a shadow root: styles and portals live in the shadow tree and work', async ({
    editor,
    page,
    browserName,
  }) => {
    test.fail(browserName === 'webkit', WEBKIT_SHADOW);
    await editor.load({ mount: 'shadow', doc: 'paragraphs' });
    const placement = await page.evaluate(() => {
      const shadow = document.querySelector('e2e-shadow-host')!.shadowRoot!;
      return {
        styleInShadow: shadow.querySelector('style[data-neditor-styles]') !== null,
        styleInHead: document.head.querySelector('style[data-neditor-styles]') !== null,
      };
    });
    expect(placement.styleInShadow).toBe(true);

    await editor.placeCaret('p1', 0, 5);
    const toolbar = editor.portal('toolbar');
    await expect(toolbar).toBeVisible();
    const style = await toolbar.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        inShadow: element.getRootNode() instanceof ShadowRoot,
        position: computed.position,
        token: computed.getPropertyValue('--neditor-surface-raised').trim(),
      };
    });
    expect(style).toEqual({
      inShadow: true,
      position: 'fixed',
      token: expect.stringMatching(/\S/),
    });

    // Real retargeting: a pointer in the light DOM, and one on another block, both dismiss.
    await page.keyboard.press(`${MOD}+k`);
    await expect(editor.portal('link-editor')).toBeVisible();
    await page.locator('#after').click();
    await expect(editor.portal('link-editor')).toBeHidden();

    await editor.placeCaret('p1', 0, 5);
    await page.keyboard.press(`${MOD}+k`);
    await editor.clickAt('p3', 2);
    await expect(editor.portal('link-editor')).toBeHidden();
    // A pointer inside the dialog does not.
    await editor.placeCaret('p1', 0, 5);
    await page.keyboard.press(`${MOD}+k`);
    await editor.portal('link-editor').getByRole('textbox').click();
    await expect(editor.portal('link-editor')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('E1b a drop inside the shadow root lands at the pointer', async ({
    editor,
    page,
    browserName,
  }) => {
    test.fail(browserName === 'webkit', WEBKIT_SHADOW);
    await editor.load({ mount: 'shadow', doc: 'paragraphs' });
    await page.evaluate(() => window.__e2e.setDragPayload({ html: '<b>DROP</b>', text: 'DROP' }));
    const host = editor.content('p2');
    const point = await editor.pointAt(host, 5);
    const box = (await host.boundingBox())!;
    await page.locator('#foreign-source').dragTo(host, {
      targetPosition: { x: point.x - box.x, y: point.y - box.y },
    });
    expect((await editor.texts())[1]).toBe('BravoDROP two');
  });

  test('E1c inside a shadow root, Enter splits at the caret and Mod+B formats the selection', async ({
    editor,
    page,
    browserName,
  }) => {
    test.fail(browserName === 'webkit', WEBKIT_SHADOW);
    await editor.load({ mount: 'shadow', doc: 'paragraphs' });
    await editor.clickAt('p1', 5);
    await page.keyboard.press('Enter');
    expect(await editor.texts()).toEqual(['Alpha', ' one', 'Bravo two', 'Charlie three']);
    await editor.dragText(['p3', 0], ['p3', 7]);
    await page.keyboard.press(`${MOD}+b`);
    expect((await editor.blockData('p3'))?.content[0]).toEqual({
      text: 'Charlie',
      marks: ['bold'],
    });
  });

  test('E2 mounted into an iframe from the parent realm: typing, menus, paste and drop all work', async ({
    page,
  }) => {
    const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
    await editor.load({ mount: 'iframe', doc: 'paragraphs' });

    // Different realm: the editor's own Node is not the frame's.
    const realms = await page.evaluate(() => {
      const root = window.__e2e.editor.element;
      return {
        sameRealm: root instanceof HTMLElement,
        frameRealm: root instanceof root.ownerDocument.defaultView!.HTMLElement,
      };
    });
    expect(realms).toEqual({ sameRealm: false, frameRealm: true });

    await editor.content('p1').click();
    await editor.caretAtEnd('p1');
    await editor.type('!');
    expect((await editor.texts())[0]).toBe('Alpha one!');

    await editor.placeCaret('p2', 0);
    await editor.type('/');
    await expect(editor.portal('slash-menu')).toBeVisible();
    await editor.type('quote');
    await page.keyboard.press('Enter');
    expect((await editor.doc()).blocks[1]?.type).toBe('quote');

    await editor.placeCaret('p3', 0, 7);
    await expect(editor.portal('toolbar')).toBeVisible();
    await page.keyboard.press(`${MOD}+b`);
    expect((await editor.blockData('p3'))?.content[0]).toEqual({
      text: 'Charlie',
      marks: ['bold'],
    });

    await writeClipboard(page, { html: '<p><i>pasted</i></p>' });
    await editor.caretAtEnd('p3');
    await page.keyboard.press(`${MOD}+v`);
    expect((await editor.blockData('p3'))?.content.at(-1)).toEqual({
      text: 'pasted',
      marks: ['italic'],
    });

    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual([]);
  });

  test('E3 inside a modal <dialog>, the portals paint on top of it', async ({ editor, page }) => {
    await editor.load({ mount: 'dialog', doc: 'paragraphs' });
    await editor.placeCaret('p2', 0, 5);
    const toolbar = editor.portal('toolbar');
    await expect(toolbar).toBeVisible();
    expect(await toolbar.evaluate((element) => element.parentElement?.tagName)).toBe('DIALOG');
    const box = (await toolbar.boundingBox())!;
    const onTop = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('.neditor-toolbar') !== null,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
    expect(onTop).toBe(true);
    await toolbar.locator('[data-mark="italic"]').click();
    expect((await editor.blockData('p2'))?.content[0]).toEqual({
      text: 'Bravo',
      marks: ['italic'],
    });
  });
});
