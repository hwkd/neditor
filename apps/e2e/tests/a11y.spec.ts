import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { EditorPage, expect, MOD, test } from '../helpers/test.ts';

async function axe(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

test.describe('21 · accessibility', () => {
  test.describe('A1 axe (WCAG 2.1 AA) finds nothing', () => {
    test('default kitchen-sink document', async ({ editor, page }) => {
      await editor.load({ doc: 'kitchen-sink' });
      expect(await axe(page)).toEqual([]);
    });

    test('dark theme', async ({ editor, page }) => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await editor.load({ doc: 'kitchen-sink', theme: 'dark' });
      expect(await axe(page)).toEqual([]);
    });

    test('read-only', async ({ editor, page }) => {
      await editor.load({ doc: 'kitchen-sink', editable: false });
      expect(await axe(page)).toEqual([]);
    });

    test('slash menu open', async ({ editor, page }) => {
      // Was FINDING F9, fixed; see docs/e2e-progress.md.
      await editor.load({ doc: 'empty' });
      await editor.placeCaret('p1', 0);
      await editor.type('/');
      await expect(editor.portal('slash-menu')).toBeVisible();
      expect(await axe(page)).toEqual([]);
    });

    test('format toolbar and link editor open', async ({ editor, page }) => {
      await editor.load({ doc: 'paragraphs' });
      await editor.placeCaret('p1', 0, 5);
      await expect(editor.portal('toolbar')).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await page.keyboard.press(`${MOD}+k`);
      await expect(editor.portal('link-editor')).toBeVisible();
      expect(await axe(page)).toEqual([]);
    });

    test('image editor and icon picker open', async ({ editor, page }) => {
      await editor.load({ doc: 'kitchen-sink' });
      await editor.clickControl(editor.block('img').locator('.neditor-image__trigger'));
      await expect(editor.portal('image-editor')).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await page.keyboard.press('Escape');
      await editor.clickControl(editor.block('co').locator('.neditor-block__icon'));
      await expect(editor.portal('icon-picker')).toBeVisible();
      expect(await axe(page)).toEqual([]);
    });

    test('block selection and table toolbar', async ({ editor, page }) => {
      await editor.load({ doc: 'kitchen-sink' });
      await page.evaluate(() => window.__e2e.editor.selectBlocks(['bl', 'bl2']));
      expect(await axe(page)).toEqual([]);
      await editor.placeCaret('tbl', 0, 0, { row: 1, column: 0 });
      await expect(editor.portal('table-toolbar')).toBeVisible();
      expect(await axe(page)).toEqual([]);
    });
  });

  test('A2 blocks keep their own semantics; content never takes role="textbox"', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'kitchen-sink' });
    await expect(page.getByRole('heading', { level: 1, name: 'Heading one' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Heading two' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'Heading three' })).toBeVisible();
    await expect(page.getByRole('blockquote')).toHaveCount(1);
    await expect(page.getByRole('checkbox', { name: 'To-do' })).toBeChecked();
    await expect(page.getByRole('button', { name: 'Expand or collapse' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(page.getByRole('img', { name: 'A blue gradient' })).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(1);
    await expect(
      editor.root.locator('[role="textbox"], [aria-multiline], [aria-selected]'),
    ).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Rich text editor' })).toBeVisible();
  });

  test('A3 the live region announces each state change', async ({ editor, page }) => {
    await editor.load({ doc: 'kitchen-sink' });
    const region = editor.liveRegion;
    await expect(region).toHaveAttribute('role', 'status');
    await expect(region).toHaveAttribute('aria-live', 'polite');

    await editor.block('td').locator('.neditor-block__checkbox').click();
    await expect(region).toHaveText('Unchecked');
    await editor.block('tg').locator('.neditor-block__chevron').click();
    await expect(region).toHaveText('Toggle collapsed');
    await editor.block('tg').locator('.neditor-block__chevron').click();
    await expect(region).toHaveText('Toggle expanded');

    await editor.placeCaret('end', 0);
    await page.keyboard.press(`${MOD}+z`);
    await expect(region).toHaveText('Undone');
    await page.keyboard.press(`${MOD}+Shift+z`);
    await expect(region).toHaveText('Redone');

    await page.evaluate(() => window.__e2e.editor.setBlockType('end', 'heading1'));
    await expect(region).toHaveText('Changed to Heading 1');

    await page.evaluate(() => window.__e2e.editor.selectBlocks(['qt']));
    await expect(region).toHaveText('Quote selected, A quote');
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['hr']));
    await expect(region).toHaveText('Divider selected');

    // The same message twice is announced twice (blanked, then set).
    await editor.clearLog();
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['qt']));
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['hr']));
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['qt']));
    await expect
      .poll(() => editor.announcements())
      .toEqual(['Quote selected, A quote', 'Divider selected', 'Quote selected, A quote']);
  });

  /*
   * The live region is visually hidden, not absent: a range the reader draws
   * in the page across the editor took in its last announcement ("Paragraph
   * selected, B", "3 blocks selected"), and Chromium's Mod+C copied it with
   * the blocks' text (round 14, review 4). It is not the reader's text, so it
   * cannot be selected; its role, politeness and announcements stay. The
   * clipboard is read in Chromium, the one engine whose clipboard the suite
   * can read; elsewhere the page's own selection is asked.
   */
  test('A3b a page range across the editor takes in none of the live region', async ({
    editor,
    page,
    browserName,
  }) => {
    for (const editable of [true, false]) {
      const label = editable ? 'editable' : 'read-only';
      await editor.load({ doc: 'five', toolbar: 0, editable });
      await page.evaluate(() => {
        const stage = document.querySelector('#stage')!;
        for (const [id, where] of [
          ['above', 'before'],
          ['below', 'after'],
        ] as const) {
          const text = document.createElement('p');
          text.id = id;
          text.textContent = `Some page text ${id} the editor, for the reader to select.`;
          stage[where](text);
        }
      });
      if (editable) {
        await editor.hoverBlock('b');
        await editor.handle.click();
      } else {
        const b = await editor.pointAt(editor.content('b'), 2);
        const d = await editor.pointAt(editor.content('d'), 3);
        await page.mouse.move(b.x, b.y);
        await page.mouse.down();
        await page.mouse.move(b.x + 20, b.y, { steps: 3 });
        await page.mouse.move(d.x, d.y, { steps: 6 });
        await page.mouse.up();
      }
      await editor.settle();
      const announced = (await editor.liveRegion.textContent()) ?? '';
      expect(announced, `${label}: an announcement to leave behind`).toMatch(/selected/);

      const above = (await page.locator('#above').boundingBox())!;
      const below = (await page.locator('#below').boundingBox())!;
      await page.mouse.move(above.x + 10, above.y + above.height / 2);
      await page.mouse.down();
      await page.mouse.move(above.x + 60, above.y + above.height / 2, { steps: 3 });
      await page.mouse.move(below.x + 200, below.y + below.height / 2, { steps: 10 });
      await page.mouse.up();
      await editor.settle();
      // The announcement is still there to be taken in.
      expect(await editor.liveRegion.textContent(), label).toBe(announced);
      if (browserName === 'chromium') {
        await page.keyboard.press('ControlOrMeta+c');
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        expect(copied, `${label}: the copy`).toContain('page text below');
        expect(copied, `${label}: the copy`).toContain('Block C');
        expect(copied, `${label}: the copy`).not.toContain(announced);
      }
      const selected = await page.evaluate(() => getSelection()!.toString());
      expect(selected, `${label}: the range runs across the editor`).toContain('page text above');
      expect(selected, `${label}: the range runs across the editor`).toContain('page text below');
      expect(selected, `${label}: the page's range`).not.toContain(announced);
    }
  });

  test('A4 a keyboard-only journey: in, build, reach every control, and out', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await page.locator('#before').focus();
    await page.keyboard.press('Tab');
    await expect(editor.content('p1')).toBeFocused();

    await editor.type('Title');
    await page.keyboard.press('Enter');
    await editor.type('/toggle');
    await page.keyboard.press('Enter');
    await editor.type('Details');
    await page.keyboard.press('Enter'); // a child of the toggle
    await editor.type('Hidden inside');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Backspace'); // an empty nested block outdents
    await editor.type('/callout');
    await page.keyboard.press('Enter');
    await editor.type('Note');
    expect(await editor.outline()).toEqual([
      'paragraph:Title',
      'toggle:Details',
      '  paragraph:Hidden inside',
      'callout:Note',
    ]);

    // Shift+Tab at depth 0 from the callout's text reaches its icon button.
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Change icon' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(editor.portal('icon-picker')).toBeVisible();
    await page.keyboard.press('Escape');

    // The toggle's chevron is reachable the same way, and Space operates it.
    const toggle = (await editor.doc()).blocks.find((block) => block.type === 'toggle')!;
    await editor.caretAtEnd(toggle.id);
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Expand or collapse' })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Expand or collapse' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    // Out: Escape twice from text releases focus.
    await editor.caretAtEnd(toggle.id);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    expect(await editor.hasFocus()).toBe(false);
  });

  test('A5 every name, placeholder, menu entry and announcement can be translated', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty', labels: 'fr' });
    await expect(page.getByRole('group', { name: 'Éditeur de texte' })).toBeVisible();
    await editor.placeCaret('p1', 0);
    const placeholder = await editor
      .content('p1')
      .evaluate((element) => getComputedStyle(element, '::before').content);
    expect(placeholder).toContain('Tapez « / » pour les commandes');

    await editor.type('/titre');
    await expect(
      editor.portal('slash-menu').getByRole('listbox', { name: 'Types de bloc' }),
    ).toBeVisible();
    await expect(editor.portal('slash-menu').getByRole('option')).toHaveText([/Titre 1/]);
    await page.keyboard.press('Enter');
    await editor.type('Bonjour');
    await page.keyboard.press(`${MOD}+a`);
    await expect(page.getByRole('toolbar', { name: 'Mise en forme' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Gras' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(editor.liveRegion).toHaveText('Titre 1 sélectionné, Bonjour');
  });

  test('A6 the browser names the slash combobox, and a to-do checkbox keeps its own name', async ({
    editor,
    page,
    browserName,
  }) => {
    // Chromium's real accessibility tree, through the DevTools protocol: what a
    // screen reader is given, not a recomputation (B10).
    test.skip(browserName !== 'chromium', 'reads the browser accessibility tree over CDP');
    await editor.load({ doc: 'lists' });
    const cdp = await page.context().newCDPSession(page);
    const names = async (role: string) => {
      const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as {
        nodes: Array<{ role?: { value?: string }; name?: { value?: string } }>;
      };
      return nodes.filter((node) => node.role?.value === role).map((node) => node.name?.value);
    };

    await editor.placeCaret('t1', 0);
    await editor.type('/');
    await expect(editor.portal('slash-menu')).toBeVisible();
    expect(await names('combobox')).toEqual(['Block types']);
    expect(await names('checkbox')).toEqual(['/Todo one', 'Todo two']);
  });

  test('A7 with the editor in a shadow root and its menus on the page, no reference dangles', async ({
    editor,
    page,
    browserName,
  }) => {
    await editor.load({ mount: 'shadow', portal: 'body', doc: 'empty' });
    await editor.placeCaret('p1', 0);
    await editor.type('/');
    await expect(editor.portal('slash-menu')).toBeVisible();
    await page.keyboard.press('ArrowDown');

    // Across trees the relationships are element references, not IDs -- every
    // engine here supports them -- and they point at the real list and option.
    const relations = await page.evaluate(() => {
      const host = document
        .querySelector('e2e-shadow-host')!
        .shadowRoot!.querySelector('.neditor-block__content') as HTMLElement & {
        ariaControlsElements?: Element[];
        ariaActiveDescendantElement?: Element | null;
      };
      return {
        controls: host.ariaControlsElements?.map((element) => element.getAttribute('role')),
        active: host.ariaActiveDescendantElement?.getAttribute('aria-selected'),
      };
    });
    expect(relations).toEqual({ controls: ['listbox'], active: 'true' });

    if (browserName === 'chromium') {
      const cdp = await page.context().newCDPSession(page);
      const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as {
        nodes: Array<{ role?: { value?: string }; properties?: Array<{ name: string }> }>;
      };
      const combobox = nodes.find((node) => node.role?.value === 'combobox');
      expect(combobox?.properties?.map((property) => property.name)).toEqual(
        expect.arrayContaining(['controls', 'activedescendant']),
      );
    }

    // axe reads only the ID attributes, so it cannot see the element
    // references above and reports the list as an unreachable scrolling region.
    // Everything else it checks, including that no ID dangles, still applies.
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .disableRules(['scrollable-region-focusable'])
      .analyze();
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  /*
   * A11Y-1 / STR-3 (the 9 Nov audit). E2E only: where the browser's Tab goes
   * from a blurred editor is the browser's sequential-focus navigation, and
   * which elements count as tabbable depends on what is rendered -- happy-dom
   * implements neither.
   */
  // R2-NAV-3: an iframe's document holding only the editor is not the end of
  // the page; the search goes on from the frame element in its parent.
  for (const mount of ['plain', 'shadow', 'iframe'] as const) {
    test(`A8 Escape, Escape, then Tab leaves the editor for the next stop on the page (${mount})`, async ({
      editor: plain,
      page,
    }) => {
      const editor =
        mount === 'iframe' ? new EditorPage(page, 0, page.frameLocator('#frame')) : plain;
      await editor.load({ doc: 'paragraphs', mount });
      await editor.clickAt('p2', 3);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      expect(await editor.hasFocus()).toBe(false);
      await page.keyboard.press('Tab');
      await expect(page.locator('#after')).toBeFocused();

      // A fresh page: in Firefox a click into a frame while the parent holds
      // focus does not focus the frame's host under Playwright.
      await editor.load({ doc: 'paragraphs', mount });
      await editor.clickAt('p2', 3);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Shift+Tab');
      await expect(page.locator('#before')).toBeFocused();
      expect((await editor.doc()).blocks.map((block) => block.depth)).toEqual([0, 0, 0]);
    });
  }

  /*
   * R2-NAV-4: inside a modal dialog, everything outside it is inert. The
   * search found #after anyway, `focus()` on it failed without a word after
   * the key was swallowed, and focus fell to <body> for the next Tab to go
   * straight back in.
   */
  test('A8 in a modal dialog, the way out stays inside the dialog (dialog)', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs', mount: 'dialog' });
    // Arranged: a control after the editor, inside the dialog.
    await page.evaluate(() => {
      const save = document.createElement('button');
      save.id = 'save';
      save.textContent = 'Save';
      document.querySelector('#dialog')!.append(save);
    });
    await editor.clickAt('p2', 3);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    await expect(page.locator('#save')).toBeFocused();

    // With nothing else in the dialog, the key is the browser's: never
    // swallowed, nothing indented, and focus not dropped on <body>.
    await page.evaluate(() => document.querySelector('#save')!.remove());
    await editor.clickAt('p2', 3);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    const swallowed = page.evaluate(
      () =>
        new Promise<boolean>((resolve) =>
          document.addEventListener('keydown', (event) => resolve(event.defaultPrevented), {
            once: true,
          }),
        ),
    );
    await page.keyboard.press('Tab');
    expect(await swallowed).toBe(false);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
    expect((await editor.doc()).blocks.map((block) => block.depth)).toEqual([0, 0, 0]);
  });

  /*
   * R2-NAV-5: with nothing tabbable after (or before) the editor, the browser
   * kept the key and started from inside the editor: Chromium went back into
   * the very block that was left. The browser now starts from outside it, so
   * it goes on to its own controls -- here, headless, it wraps round the page.
   */
  for (const mount of ['plain', 'shadow', 'iframe'] as const) {
    test(`A8 with nothing tabbable beyond the editor, Tab still does not go back in (${mount})`, async ({
      editor: plain,
      page,
    }) => {
      const editor =
        mount === 'iframe' ? new EditorPage(page, 0, page.frameLocator('#frame')) : plain;
      await editor.load({ doc: 'paragraphs', mount });
      await page.evaluate(() =>
        document.querySelectorAll('#after, #paste-target, #foreign-source').forEach((element) => {
          element.remove();
        }),
      );
      await editor.clickAt('p2', 3);
      expect(await editor.hasFocus(), 'precondition: the click is in the editor').toBe(true);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Tab');
      expect(await editor.hasFocus()).toBe(false);

      await editor.load({ doc: 'paragraphs', mount });
      await page.evaluate(() =>
        document.querySelectorAll('.outside').forEach((element) => element.remove()),
      );
      await editor.clickAt('p2', 3);
      expect(await editor.hasFocus(), 'precondition: the click is in the editor').toBe(true);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Shift+Tab');
      expect(await editor.hasFocus()).toBe(false);
      expect((await editor.doc()).blocks.map((block) => block.depth)).toEqual([0, 0, 0]);
      // The stand-in that moved the browser's starting point is gone once
      // focus has left it -- or is the one thing still holding focus.
      expect(
        await page.evaluate(() => {
          const stops = document.querySelectorAll('.neditor-exit-stop');
          return stops.length === 0 || document.activeElement === stops[0];
        }),
      ).toBe(true);
    });
  }

  /*
   * R3-KEY-3. The search read each tree with `querySelectorAll`, which never
   * looks into another shadow root, so a web component's own button right
   * after the editor was passed over in every engine. A host that delegates
   * focus is a stop itself.
   */
  for (const variant of ['open', 'delegatesFocus'] as const) {
    test(`A8 a control inside a web component beside the editor is the next stop (${variant})`, async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'paragraphs' });
      await page.evaluate((delegatesFocus) => {
        customElements.define(
          'x-btn',
          class extends HTMLElement {
            constructor() {
              super();
              this.attachShadow({ mode: 'open', delegatesFocus }).innerHTML =
                '<button id="inner">Save</button>';
            }
          },
        );
        const editorElement = document.querySelector('#editor')!;
        editorElement.after(Object.assign(document.createElement('x-btn'), { id: 'save-after' }));
        editorElement.before(Object.assign(document.createElement('x-btn'), { id: 'save-before' }));
      }, variant === 'delegatesFocus');
      const inner = (id: string) =>
        page.evaluate(
          (id) =>
            document.activeElement?.id === id &&
            document.activeElement.shadowRoot?.activeElement?.id === 'inner',
          id,
        );

      await editor.clickAt('p3', 2);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Tab');
      expect(await inner('save-after')).toBe(true);

      await editor.clickAt('p1', 2);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Shift+Tab');
      expect(await inner('save-before')).toBe(true);
    });
  }

  test('A8 a host that delegates focus is a stop even where its controls cannot be read', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await page.evaluate(() => {
      // The control is in a closed shadow root inside the delegating host's
      // own: the search cannot see it, but focus() on the host reaches it.
      customElements.define(
        'x-closed',
        class extends HTMLElement {
          constructor() {
            super();
            this.attachShadow({ mode: 'closed', delegatesFocus: true }).innerHTML =
              '<button>Save</button>';
          }
        },
      );
      customElements.define(
        'x-delegating',
        class extends HTMLElement {
          constructor() {
            super();
            this.attachShadow({ mode: 'open', delegatesFocus: true }).innerHTML =
              '<x-closed></x-closed>';
          }
        },
      );
      document
        .querySelector('#editor')!
        .after(Object.assign(document.createElement('x-delegating'), { id: 'save-after' }));
    });

    await editor.clickAt('p3', 2);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('save-after');
  });

  /*
   * R4-KEY-5. A shadow host taken out of the tab order with tabindex=-1 takes
   * its shadow tree out with it, delegating focus or not: the browser's own
   * Tab never stops inside. The exit's search went in and landed on the
   * control there. Sequential focus order: e2e only.
   */
  for (const delegatesFocus of [false, true]) {
    test(`A8 a web component with tabindex=-1 is passed over, contents and all${delegatesFocus ? ' (delegatesFocus)' : ''}`, async ({
      editor,
      page,
    }) => {
      await editor.load({ doc: 'paragraphs' });
      await page.evaluate((delegatesFocus) => {
        customElements.define(
          'x-neg',
          class extends HTMLElement {
            constructor() {
              super();
              this.attachShadow({ mode: 'open', delegatesFocus }).innerHTML =
                '<button id="inner">inner</button>';
            }
          },
        );
        const editorElement = document.querySelector('#editor')!;
        const after = Object.assign(document.createElement('x-neg'), { id: 'neg-after' });
        after.tabIndex = -1;
        const before = Object.assign(document.createElement('x-neg'), { id: 'neg-before' });
        before.tabIndex = -1;
        editorElement.after(after);
        after.after(Object.assign(document.createElement('button'), { id: 'plain-after' }));
        editorElement.before(before);
        before.before(Object.assign(document.createElement('button'), { id: 'plain-before' }));
      }, delegatesFocus);
      const active = () => page.evaluate(() => document.activeElement?.id);

      await editor.clickAt('p3', 2);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Tab');
      expect(await active()).toBe('plain-after');

      await editor.clickAt('p1', 2);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Shift+Tab');
      expect(await active()).toBe('plain-before');
    });
  }

  /*
   * R3-KEY-8, the probe's scenario 2: nothing before the editor, then
   * Shift+Tab three times. Firefox headless left focus on the stand-in, which
   * went only on its own blur, so it stayed in the page across every press.
   */
  test('A8 the exit stand-in is gone by the next key, wherever focus went', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await page.evaluate(() => document.querySelector('#before')?.remove());
    await editor.clickAt('p2', 3);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+Tab');
    expect(await editor.hasFocus()).toBe(false);
    await page.keyboard.press('Shift+Tab');
    expect(await page.locator('.neditor-exit-stop').count()).toBe(0);
    await page.keyboard.press('Shift+Tab');
    expect(await page.locator('.neditor-exit-stop').count()).toBe(0);
    expect((await editor.doc()).blocks.map((block) => block.depth)).toEqual([0, 0, 0]);
  });

  test('A9 the way out is spent by a focus change: from #before, Tab goes into the editor', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.clickAt('p2', 3);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.locator('#before').focus();
    await page.keyboard.press('Tab');
    // From #before, the browser's Tab goes into the editor, as it always has.
    expect(await editor.hasFocus()).toBe(true);
  });

  /*
   * R2-NAV-6: a reader who scrolls on before tabbing has moved no focus, and
   * disarming on those keys sent them back into the editor. Real key presses,
   * on a page tall enough to scroll.
   */
  test('A9 keys that move no focus keep the way out: scroll first, then Tab', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs', scroll: true });
    await editor.content('p2').scrollIntoViewIfNeeded();
    await editor.settleScroll();
    await editor.clickAt('p2', 3);
    expect(await editor.hasFocus(), 'precondition: the click is in the editor').toBe(true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    for (const key of ['ArrowDown', 'ArrowUp', 'Space', 'PageDown', 'PageUp', 'End', 'Home']) {
      await page.keyboard.press(key);
    }
    expect(await editor.hasFocus()).toBe(false);
    await page.keyboard.press('Tab');
    await expect(page.locator('#after')).toBeFocused();
    expect((await editor.doc()).blocks.map((block) => block.depth)).toEqual([0, 0, 0]);
  });

  test('A10 Tab in a table whose last row is empty moves focus on instead of adding rows', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    await editor.placeCaret('tbl', 2, 2, { row: 2, column: 2 });
    await page.keyboard.press('Tab');
    expect((await editor.blockData('tbl'))?.rows).toHaveLength(4);
    // The row it added is empty: Tab through it, and out.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    expect((await editor.selection())?.cell).toEqual({ row: 3, column: 2 });
    await page.keyboard.press('Tab');
    expect((await editor.blockData('tbl'))?.rows).toHaveLength(4);
    await expect(editor.content('after')).toBeFocused();
  });

  /*
   * R8-KEY-1. With a collaborator's update arriving between presses, Escape
   * never got past the format toolbar: each `setDocument` drew again the
   * toolbar the press had just dismissed, so the next Escape dismissed it
   * once more, and the Escape-twice exit never came. (The block selection
   * the second press makes survives the update too, R8-KEY-3.) The probe:
   * "Read the doc first please" selected from 5 for 3, four Escapes, a
   * peer's edit to the last block after each. Real focus and toolbar: e2e.
   */
  test('A11 Escape still leaves the editor with a peer’s update between presses', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const para = (id: string, text: string) => ({
        id,
        type: 'paragraph' as const,
        depth: 0,
        content: [{ text }],
      });
      ed.setDocument({
        blocks: [para('p', 'Read the doc first please'), para('q', 'Second'), para('tail', 'tail')],
      });
      ed.clearHistory();
    });
    const point = await editor.pointAt(editor.content('p'), 5);
    await page.mouse.click(point.x, point.y);
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Shift+ArrowRight');
    }
    await editor.settle();
    const toolbar = editor.portal('toolbar');
    await expect(toolbar).toBeVisible();
    const escapeThenPeer = async () => {
      await page.keyboard.press('Escape');
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        const tail = doc.blocks[2]!;
        tail.content = [{ text: `${tail.content[0]?.text ?? ''}.` }];
        ed.setDocument(doc);
      });
      await editor.settle();
    };

    await escapeThenPeer();
    await expect(toolbar, 'the first Escape dismissed it').toBeHidden();
    expect(await editor.selected()).toEqual([]);

    await escapeThenPeer();
    await expect(toolbar).toBeHidden();
    expect(await editor.selected(), 'the second selected the block').toEqual(['p']);
    await expect(editor.root).toBeFocused();

    await escapeThenPeer();
    expect(await editor.selected()).toEqual([]);
    expect(await editor.hasFocus(), 'the third left').toBe(false);
  });

  /*
   * R13-PTR-1, p3's literal case: `?doc=paragraphs`, "two" double-clicked in
   * p2, then Escape and a peer appending "." to p2 itself, eight times. A11's
   * peer edits another block; editing the reader's own block, the editor
   * carries the range across the redraw and writes it back, and the
   * `selectionchange` that write queues drew again the toolbar Escape had
   * just dismissed -- after `setDocument` had decided not to. Escape never got
   * past it (eight presses, focus still in the block). In every mount, and in
   * a table cell. Real focus, real `selectionchange` timing: e2e.
   */
  for (const mount of ['plain', 'shadow', 'iframe', 'dialog', 'portal'] as const) {
    test(`A11b Escape still leaves with a peer editing the reader’s own block between presses (${mount})`, async ({
      page,
    }) => {
      const framed = mount === 'iframe' || mount === 'portal';
      const editor = new EditorPage(page, 0, framed ? page.frameLocator('#frame') : undefined);
      await editor.load({
        doc: 'paragraphs',
        mount: framed ? 'iframe' : mount,
        portal: mount === 'portal' ? 'body' : undefined,
      });
      // With `portalContainer` in the page around the frame, the toolbar is there.
      const toolbar =
        mount === 'portal'
          ? page.locator('.neditor-portal.neditor-toolbar')
          : editor.portal('toolbar');
      const point = await editor.pointAt(editor.content('p2'), 7);
      await page.mouse.dblclick(point.x, point.y);
      await expect(toolbar).toBeVisible();
      expect((await editor.selection())?.range).toEqual({ start: 6, end: 9 });
      const escapeThenPeer = async () => {
        await page.keyboard.press('Escape');
        await page.evaluate(() => {
          const ed = window.__e2e.editor;
          const doc = ed.getDocument();
          const own = doc.blocks[1]!;
          own.content = [{ text: `${own.content.map((run) => run.text).join('')}.` }];
          ed.setDocument(doc);
        });
        await editor.settle();
        await page.waitForTimeout(60);
      };

      await escapeThenPeer();
      await expect(toolbar, 'the first Escape dismissed it').toBeHidden();
      expect((await editor.selection())?.range, 'the range was carried').toEqual({
        start: 6,
        end: 9,
      });

      await escapeThenPeer();
      await expect(toolbar).toBeHidden();
      expect(await editor.selected(), 'the second selected the block').toEqual(['p2']);

      await escapeThenPeer();
      expect(await editor.selected()).toEqual([]);
      expect(await editor.hasFocus(), 'the third left').toBe(false);
      await expect(toolbar).toBeHidden();
    });
  }

  test('A11c Escape still leaves with a peer editing the reader’s own table cell between presses', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'table' });
    const cell = editor.cell('tbl', 1, 1);
    const point = await editor.pointAt(cell, 1);
    await page.mouse.dblclick(point.x, point.y);
    const toolbar = editor.portal('toolbar');
    await expect(toolbar).toBeVisible();
    const escapeThenPeer = async () => {
      await page.keyboard.press('Escape');
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        const rows = doc.blocks[1]!.rows!;
        rows[1]![1] = [{ text: `${rows[1]![1]!.map((run) => run.text).join('')}.` }];
        ed.setDocument(doc);
      });
      await editor.settle();
      await page.waitForTimeout(60);
    };

    await escapeThenPeer();
    await expect(toolbar, 'the first Escape dismissed it').toBeHidden();
    await expect(editor.portal('table-toolbar'), 'one toolbar for a range, or none').toBeHidden();
    await escapeThenPeer();
    expect(await editor.selected()).toEqual(['tbl']);
    await escapeThenPeer();
    expect(await editor.hasFocus(), 'the third left').toBe(false);
  });

  /*
   * R13-RV-PTR-1, a1's literal case: "two" double-clicked, a peer appending
   * "!" to p2 (the carry writes the range back), then ⌘B or a toolbar
   * button, then ⌘Z, ⌘⇧Z, ⌘Z. Undo and redo hide the toolbar and leave its
   * redraw to the `selectionchange` of the selection they restore -- the
   * very range the carry had written, so a note that outlived its own
   * `selectionchange` passed over it, and the toolbar never came back. As
   * with no peer, every undo and redo draws it. Two things end the note
   * before undo's event, and this fails only with both gone: the note spent
   * by the write's own event, and the undo itself ending it (`#applyBlocks`
   * and `#placeFocus` clear it). The spend alone is pinned by A11e's
   * "same-word" case, in Chromium, the one engine whose double-click on the
   * selected word reports no caret in between. Real `selectionchange`: e2e.
   */
  test('A11g after a carry, undo and redo draw the toolbar for the range they restore', async ({
    editor,
    page,
  }) => {
    for (const format of ['⌘B', 'toolbar button'] as const) {
      await editor.load({ doc: 'paragraphs' });
      const point = await editor.pointAt(editor.content('p2'), 7);
      await page.mouse.dblclick(point.x, point.y);
      const toolbar = editor.portal('toolbar');
      await expect(toolbar, format).toBeVisible();
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks[1]!.content = [...doc.blocks[1]!.content, { text: '!' }];
        ed.setDocument(doc);
      });
      await editor.settle();
      await page.waitForTimeout(60);
      if (format === '⌘B') {
        await page.keyboard.press(`${MOD}+b`);
      } else {
        await toolbar.locator('button').nth(1).click();
      }
      await expect(toolbar, format).toBeVisible();

      for (const key of [`${MOD}+z`, `${MOD}+Shift+z`, `${MOD}+z`]) {
        await page.keyboard.press(key);
        await editor.settle();
        expect((await editor.selection())?.range, `${format}, ${key}`).toEqual({
          start: 6,
          end: 9,
        });
        await expect(toolbar, `${format}, ${key}`).toBeVisible();
      }
    }
  });

  /*
   * R13-RV-PTR-2, a2's and a4's case made deterministic: the reader's own
   * change of the selection still waiting for its `selectionchange` when a
   * peer's update to the same block lands. The carry wrote the reader's new
   * range back and noted it; the reader's queued `selectionchange` (one, the
   * write's coalesced into it) matched the note and was passed over, so the
   * toolbar for a range the reader had just made never came. Timed by a peer
   * typing on an interval it was a race (up to 9/40 in WebKit); here the
   * update runs in the very task the change was made in: from the
   * `dblclick` listener a test page installs, after the double-click's word
   * is selected and before its event; and after a range set through the
   * Selection API, as a page's own script may set one. A lock and unlock at
   * that moment is the same question for the unlock. Timing: e2e.
   */
  test('A11h a peer’s update landing before the reader’s own selectionchange keeps their toolbar', async ({
    editor,
    page,
  }) => {
    for (const how of ['dblclick', 'script', 'lock', 'lock, unlock later'] as const) {
      await editor.load({ doc: 'paragraphs' });
      await editor.clickAt('p2', 2);
      await editor.settle();
      const toolbar = editor.portal('toolbar');
      await expect(toolbar, how).toBeHidden();
      if (how === 'dblclick') {
        await page.evaluate(() =>
          document.addEventListener(
            'dblclick',
            () => {
              const ed = window.__e2e.editor;
              const doc = ed.getDocument();
              doc.blocks[1]!.content = [...doc.blocks[1]!.content, { text: 'z' }];
              ed.setDocument(doc);
            },
            { once: true, capture: true },
          ),
        );
        const point = await editor.pointAt(editor.content('p2'), 7);
        await page.mouse.dblclick(point.x, point.y);
      } else {
        await page.evaluate(
          (lock) => {
            const host = document.querySelector<HTMLElement>(
              '[data-block-id="p2"] .neditor-block__content',
            )!;
            const text = host.firstChild!;
            getSelection()!.setBaseAndExtent(text, 6, text, 9);
            const ed = window.__e2e.editor;
            if (lock) {
              ed.setEditable(false);
              if (lock === 'same task') ed.setEditable(true);
              return;
            }
            const doc = ed.getDocument();
            doc.blocks[1]!.content = [...doc.blocks[1]!.content, { text: 'z' }];
            ed.setDocument(doc);
          },
          how === 'lock' ? 'same task' : how === 'lock, unlock later' ? 'later' : '',
        );
        // Unlocked in a later task, the reader's event has been answered
        // during the lock, which draws nothing.
        if (how === 'lock, unlock later') {
          await editor.settle();
          await page.evaluate(() => window.__e2e.editor.setEditable(true));
        }
      }
      await editor.settle();
      await page.waitForTimeout(60);
      expect((await editor.selection())?.range, how).toEqual({ start: 6, end: 9 });
      await expect(toolbar, how).toBeVisible();
    }
  });

  /*
   * A11h's other side, a peer typing faster than events arrive: Escape, then
   * two updates in one task, each putting text in front of the reader's
   * range. The second found the range the first had carried -- moved, its
   * event not yet handled -- and, taking it for a change of the reader's,
   * noted nothing, so the one `selectionchange` drew the toolbar Escape had
   * dismissed. A write of the editor's own counts as handled. Timing: e2e.
   */
  test('A11i two peer updates in one task after Escape draw no toolbar', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    const point = await editor.pointAt(editor.content('p2'), 7);
    await page.mouse.dblclick(point.x, point.y);
    const toolbar = editor.portal('toolbar');
    await expect(toolbar).toBeVisible();
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      for (const typed of ['a', 'b']) {
        const doc = ed.getDocument();
        doc.blocks[1]!.content = [{ text: typed }, ...doc.blocks[1]!.content];
        ed.setDocument(doc);
      }
    });
    await editor.settle();
    await page.waitForTimeout(60);
    expect((await editor.selection())?.range).toEqual({ start: 8, end: 11 });
    await expect(toolbar).toBeHidden();
    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual(['p2']);
  });

  /*
   * R13-RV2-PTR-1, b3's literal case: "two" double-clicked, Escape, then the
   * page setting a field's value -- a title a peer's update changed -- alone,
   * or in the same task as a peer's edit to the reader's block, before or
   * after it. Chromium fires `selectionchange` at an `<input>` or
   * `<textarea>` whose value script sets, and it bubbles to the document;
   * answered as a change of the reader's selection, it drew the toolbar
   * Escape had dismissed, and, before the carry's own event, spent the note
   * of that write (`#ownSelection`), so the write's event drew it instead.
   * Escape then never got to the block. In every mount whose field the
   * editor's document hears: the field in the frame's document, in the
   * dialog, in the page around a shadow root. (Chromium dispatches a field's
   * event inside the editor's own shadow root at the document: a documented
   * limit, not pinned here.) Real `selectionchange` targets: e2e.
   */
  for (const mount of ['plain', 'shadow', 'iframe', 'dialog'] as const) {
    test(`A11j a page field’s own selectionchange draws no toolbar Escape dismissed (${mount})`, async ({
      page,
    }) => {
      const editor = new EditorPage(
        page,
        0,
        mount === 'iframe' ? page.frameLocator('#frame') : undefined,
      );
      for (const how of ['input', 'textarea', 'input, then peer', 'peer, then input'] as const) {
        await editor.load({ doc: 'paragraphs', mount });
        await page.evaluate(() => {
          const ed = window.__e2e.editor;
          const doc = ed.element.ownerDocument;
          const place = doc.getElementById('dialog') ?? doc.body;
          for (const tag of ['input', 'textarea']) {
            const field = doc.createElement(tag) as HTMLInputElement;
            field.id = `page-${tag}`;
            field.value = 'Title';
            place.prepend(field);
          }
        });
        const point = await editor.pointAt(editor.content('p2'), 7);
        await page.mouse.dblclick(point.x, point.y);
        const toolbar = editor.portal('toolbar');
        await expect(toolbar, how).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(toolbar, how).toBeHidden();
        await page.evaluate((how) => {
          const ed = window.__e2e.editor;
          const doc = ed.element.ownerDocument;
          const field = doc.getElementById(how === 'textarea' ? 'page-textarea' : 'page-input') as
            | HTMLInputElement
            | HTMLTextAreaElement;
          const peer = () => {
            const next = ed.getDocument();
            next.blocks[1]!.content = [...next.blocks[1]!.content, { text: '!' }];
            ed.setDocument(next);
          };
          if (how === 'peer, then input') peer();
          field.value += ' (edited)';
          if (how === 'input, then peer') peer();
        }, how);
        await editor.settle();
        await page.waitForTimeout(60);
        expect((await editor.selection())?.range, how).toEqual({ start: 6, end: 9 });
        await expect(toolbar, how).toBeHidden();
        await page.keyboard.press('Escape');
        expect(await editor.selected(), how).toEqual(['p2']);
      }
    });
  }

  /*
   * A11b's sibling where the peer's edit replaces the reader's host rather
   * than redrawing it: the paragraph made a heading, same id and text. The
   * new element takes focus and the range (`#carryTextSelection`), and that
   * focus and its `selectionchange` are the editor's own write too. Escape,
   * then the conversion; Escape, then a peer's edit to the heading's text.
   */
  test('A11f Escape still leaves with a peer turning the reader’s paragraph into a heading', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    const point = await editor.pointAt(editor.content('p2'), 7);
    await page.mouse.dblclick(point.x, point.y);
    const toolbar = editor.portal('toolbar');
    await expect(toolbar).toBeVisible();

    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const doc = ed.getDocument();
      doc.blocks[1]!.type = 'heading1';
      ed.setDocument(doc);
    });
    await editor.settle();
    await page.waitForTimeout(60);
    expect(await editor.block('p2').getAttribute('data-block-type')).toBe('heading1');
    expect((await editor.selection())?.range, 'the range moved into the heading').toEqual({
      start: 6,
      end: 9,
    });
    await expect(toolbar, 'the first Escape dismissed it').toBeHidden();

    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual(['p2']);
    await page.keyboard.press('Escape');
    expect(await editor.hasFocus()).toBe(false);
  });

  /*
   * R13-PTR-1's lock variant: Escape, then a host locking the editor round a
   * save and unlocking it. The unlock gives the reader's range back
   * (`#lockedCaret`), and that write -- its focus and its `selectionchange`
   * -- drew the dismissed toolbar again. A toolbar that was showing at the
   * lock is drawn again; one Escape had dismissed is not. Real focus: e2e.
   */
  test('A11d a lock round trip draws again only a toolbar that was showing', async ({
    editor,
    page,
  }) => {
    for (const escaped of [false, true]) {
      await editor.load({ doc: 'paragraphs' });
      const point = await editor.pointAt(editor.content('p2'), 7);
      await page.mouse.dblclick(point.x, point.y);
      const toolbar = editor.portal('toolbar');
      await expect(toolbar).toBeVisible();
      if (escaped) {
        await page.keyboard.press('Escape');
        await expect(toolbar).toBeHidden();
      }

      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        ed.setEditable(false);
        ed.setEditable(true);
      });
      await editor.settle();
      await page.waitForTimeout(60);
      expect((await editor.selection())?.range, 'the range came back').toEqual({
        start: 6,
        end: 9,
      });
      if (!escaped) {
        await expect(toolbar, 'it was showing').toBeVisible();
        continue;
      }

      await expect(toolbar, 'Escape had dismissed it').toBeHidden();
      await page.keyboard.press('Escape');
      expect(await editor.selected()).toEqual(['p2']);
      await page.keyboard.press('Escape');
      expect(await editor.hasFocus()).toBe(false);
    }
  });

  /*
   * The other side of A11b: only the editor's own write is passed over. The
   * reader's next change of the selection after it -- a Shift+Arrow, or the
   * same word double-clicked again, which Chromium reports as one coalesced
   * `selectionchange` showing that same word -- and ⌘B over the same range
   * draw the toolbar as they do with no peer, in every engine. Real
   * `selectionchange` timing: e2e.
   */
  test('A11e after a peer’s edit to the reader’s block, their own next selection draws the toolbar', async ({
    editor,
    page,
  }) => {
    for (const next of ['shift-arrow', 'same-word', 'bold', 'back to the same range'] as const) {
      await editor.load({ doc: 'paragraphs' });
      const point = await editor.pointAt(editor.content('p2'), 7);
      await page.mouse.dblclick(point.x, point.y);
      const toolbar = editor.portal('toolbar');
      await expect(toolbar).toBeVisible();
      await page.keyboard.press('Escape');
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks[1]!.content = [{ text: 'Peer Bravo two' }];
        ed.setDocument(doc);
      });
      await editor.settle();
      await page.waitForTimeout(60);
      await expect(toolbar, next).toBeHidden();
      expect((await editor.selection())?.range, next).toEqual({ start: 11, end: 14 });

      if (next === 'shift-arrow') {
        await page.keyboard.press('Shift+ArrowLeft');
      } else if (next === 'same-word') {
        const again = await editor.pointAt(editor.content('p2'), 12);
        await page.mouse.dblclick(again.x, again.y);
      } else if (next === 'back to the same range') {
        // Collapsed, then the very range the carry wrote, by keys: the note
        // stood for the write's one event and is spent, so this one draws.
        await page.keyboard.press('ArrowRight');
        await expect(toolbar, next).toBeHidden();
        for (let i = 0; i < 3; i += 1) await page.keyboard.press('Shift+ArrowLeft');
        expect((await editor.selection())?.range, next).toEqual({ start: 11, end: 14 });
      } else {
        await page.keyboard.press(`${MOD}+b`);
      }

      await expect(toolbar, next).toBeVisible();
    }
  });

  /*
   * R9-KEY-4, p01's literal case: Escape on "Block B", a click into the field
   * after the editor, typing there, and a peer deleting "Block B". The live
   * region said "No blocks selected" over the field the reader was typing in.
   * In each mount, including a second editor on the page. The live region a
   * screen reader hears: e2e.
   */
  for (const mount of ['plain', 'shadow', 'iframe', 'two'] as const) {
    test(`A12 a peer ending a block selection the reader has left says nothing (${mount})`, async ({
      editor: plain,
      page,
    }) => {
      const editor =
        mount === 'iframe' ? new EditorPage(page, 0, page.frameLocator('#frame')) : plain;
      await editor.load({ doc: 'empty', mount });
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const para = (id: string, text: string) => ({
          id,
          type: 'paragraph' as const,
          depth: 0,
          content: [{ text }],
        });
        ed.setDocument({
          blocks: [para('a', 'Block A'), para('b2', 'Block B'), para('c', 'Block C')],
        });
        ed.clearHistory();
      });
      await editor.clickAt('b2', 3);
      await page.keyboard.press('Escape');
      expect(await editor.selected()).toEqual(['b2']);

      if (mount === 'two') {
        await editor
          .other()
          .content(
            await editor
              .other()
              .ids()
              .then((ids) => ids[0]!),
          )
          .click();
      } else {
        await page.locator('#after').click();
      }
      await page.keyboard.type('x');
      await editor.clearLog();

      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks.splice(1, 1);
        ed.setDocument(doc);
      });
      await page.keyboard.type('y');

      expect(await editor.selected()).toEqual([]);
      expect(await editor.hasFocus()).toBe(false);
      expect(await editor.announcements()).toEqual([]);
      if (mount !== 'two') {
        expect(await page.locator('#after').inputValue()).toBe('xy');
      }
    });
  }
});
