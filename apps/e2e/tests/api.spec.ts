import { EditorPage, expect, MOD, test } from '../helpers/test.ts';

/**
 * The platform's own key for the end of the document: ⌘↓ on macOS,
 * Ctrl+End elsewhere (Linux WebKit's Ctrl+↓ does not move the caret, ci-5).
 */
const DOC_END = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';

test.describe('24 · public API & events', () => {
  test('AP1 change fires once per edit, never for a no-op; the other events carry the right payloads', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.clearLog();

    await editor.clickAt('p2', 5);
    const focus = await editor.events('focus');
    expect(focus.at(-1)?.payload).toEqual({ blockId: 'p2' });

    await editor.type('x');
    expect(await editor.events('change')).toHaveLength(1);
    const history = await editor.events('history');
    expect(history.at(-1)?.payload).toEqual({ canUndo: true, canRedo: false });

    await editor.clearLog();
    await page.keyboard.press(`${MOD}+Shift+ArrowUp`);
    await page.keyboard.press(`${MOD}+Shift+ArrowUp`); // the second is against the top
    expect(await editor.events('change')).toHaveLength(1);

    await editor.clearLog();
    await editor.placeCaret('p3', 0, 7);
    // `selection` rides on the browser's asynchronous selectionchange.
    await expect
      .poll(async () => (await editor.events('selection')).at(-1)?.payload)
      .toMatchObject({ blockId: 'p3', range: { start: 0, end: 7 }, marks: [], link: null });

    // With a range selected the first Escape only hides the toolbar; then the
    // block is selected; then the editor is left.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    const blockEvents = (await editor.events('blockselection')).map((event) => event.payload);
    expect(blockEvents).toEqual([{ ids: ['p3'] }, { ids: [] }]);
    await expect.poll(async () => (await editor.events('selection')).at(-1)?.payload).toBeNull();
  });

  test('AP1b the selection event reports a table cell', async ({ editor }) => {
    await editor.load({ doc: 'table' });
    await editor.cell('tbl', 2, 1).click();
    const state = await editor.selection();
    expect(state).toMatchObject({ blockId: 'tbl', cell: { row: 2, column: 1 } });
  });

  test('AP2 a listener that throws goes to onError; the editor keeps working', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await page.evaluate(() => {
      window.__e2e.editor.on('change', () => {
        throw new Error('listener boom');
      });
    });
    await editor.caretAtEnd('p1');
    await editor.type('!');
    await editor.type('?');
    expect((await editor.texts())[0]).toBe('Alpha one!?');
    const errors = await page.evaluate(() => window.__e2e.errors.splice(0).map(String));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('listener boom');
  });

  test('AP3 getDocument returns a copy', async ({ editor, page }) => {
    await editor.load({ doc: 'paragraphs' });
    await page.evaluate(() => {
      const doc = window.__e2e.editor.getDocument();
      doc.blocks[0]!.content = [{ text: 'mutated' }];
      doc.blocks.pop();
    });
    expect(await editor.texts()).toEqual(['Alpha one', 'Bravo two', 'Charlie three']);
    await expect(editor.content('p1')).toHaveText('Alpha one');
  });

  test('AP4 setDocument sanitises what it renders; silent emits no change', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await editor.clearLog();
    await page.evaluate(() => {
      window.__e2e.editor.setDocument(window.__e2e.docs.malicious(), { silent: true });
    });
    expect(await editor.events('change')).toEqual([]);
    const unsafe = await editor.root.evaluate(
      (root) =>
        [...root.querySelectorAll('[href], [src]')]
          .map((node) => node.getAttribute('href') ?? node.getAttribute('src') ?? '')
          .filter((value) => !/^(https?:|mailto:|tel:|\/)/.test(value)).length,
    );
    expect(unsafe).toBe(0);

    await page.evaluate(() => window.__e2e.editor.setDocument(window.__e2e.docs.five()));
    expect(await editor.events('change')).toHaveLength(1);
  });

  test('AP5 focus() and focusRange() refuse blocks that cannot hold a caret, and stay in a valid mode', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'toggle-collapsed' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['before']));
    const results = await page.evaluate(() => {
      const editor = window.__e2e.editor;
      return [editor.focus('child1'), editor.focus('nope'), editor.focusRange('child2', 0, 1)];
    });
    expect(results).toEqual([false, false, false]);
    expect(await editor.selected()).toEqual(['before']);

    await editor.remount({}, 'divider');
    expect(await page.evaluate(() => window.__e2e.editor.focus('hr'))).toBe(false);
    expect(await page.evaluate(() => window.__e2e.editor.focus('p2', 2))).toBe(true);
    expect(await editor.selection()).toMatchObject({ blockId: 'p2', range: { start: 2, end: 2 } });
  });

  /*
   * R9-KEY-7's sibling: a host that exists and could hold a caret but does
   * not take focus. Outside an open modal `<dialog>` everything is inert, and
   * `focus()` answered `true` with focus left in the dialog. Read-only is the
   * other case (read-only.spec.ts). Real inertness: e2e.
   */
  test('AP5b focus() and focusRange() answer false for an editor made inert by a modal dialog', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'paragraphs' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['p1']));
    const result = await page.evaluate(() => {
      const dialog = document.createElement('dialog');
      dialog.id = 'blocker';
      dialog.innerHTML = '<button id="in-dialog">OK</button>';
      document.body.append(dialog);
      dialog.showModal();
      const ed = window.__e2e.editor;
      return { focus: ed.focus('p2'), range: ed.focusRange('p2', 0, 2) };
    });

    expect(result).toEqual({ focus: false, range: false });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('in-dialog');
    // Nothing else changed either: the block selection the caret could not
    // replace is still there.
    expect(await editor.selected()).toEqual(['p1']);

    await page.evaluate(() => document.querySelector<HTMLDialogElement>('#blocker')!.close());
    expect(await page.evaluate(() => window.__e2e.editor.focus('p2', 1))).toBe(true);
    expect(await editor.selection()).toMatchObject({ blockId: 'p2', range: { start: 1, end: 1 } });
  });

  /*
   * The other side of R9-KEY-7: a focus that does land must still say so.
   * Firefox's first `focus()` on an element in a frame that does not hold
   * focus focuses only the frame, leaving its `<body>` focused inside it; the
   * old code was rescued by the caret it set next, and the honest check
   * answered `false` -- Escape from a table toolbar portalled into the page
   * around an iframe mount (the r6/r8 probes) left focus on that `<body>`.
   * Asked of an iframe mount with focus in the outer page, in every engine.
   */
  test('AP5c focus() from the page around an iframe mount lands, and says so', async ({ page }) => {
    const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
    await editor.load({ doc: 'paragraphs', mount: 'iframe', portal: 'body' });
    await page.locator('#before').click();

    expect(await page.evaluate(() => window.__e2e.editor.focus('p2', 1))).toBe(true);
    expect(await editor.focusedBlock()).toBe('p2');
    expect(await editor.selection()).toMatchObject({ blockId: 'p2', range: { start: 1, end: 1 } });
  });

  test('AP5d Escape from a table toolbar portalled around an iframe mount puts focus back in the cell', async ({
    page,
  }) => {
    const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
    await editor.load({ doc: 'empty', mount: 'iframe', portal: 'body' });
    await page.evaluate(() => {
      const cell = (text: string) => [{ text }];
      window.__e2e.editor.setDocument({
        blocks: [
          {
            id: 'tbl',
            type: 'table',
            content: [],
            depth: 0,
            rows: [
              [cell('Header one'), cell('Header two')],
              [cell('alpha beta gamma'), cell('delta epsilon zeta')],
            ],
          },
        ],
      });
    });
    await editor.cell('tbl', 1, 0).click();
    await page.keyboard.press('End');
    await page.keyboard.press('F10');
    await expect(page.locator('.neditor-table-toolbar button').first()).toBeFocused();

    await page.keyboard.press('Escape');
    expect(await editor.focusedBlock()).toBe('tbl');
    expect(await editor.selection()).toMatchObject({
      blockId: 'tbl',
      cell: { row: 1, column: 0 },
      range: { start: 16, end: 16 },
    });
  });

  /*
   * R9-RV-SEL-2, p06's literal case: a host's own button whose click calls
   * `editor.focus('a', 2)` while "c" is selected. The click is inside the
   * pointer's grace period, where a focus is left to the gesture, so `focus`
   * reached listeners with "c" still selected -- both modes at once.
   */
  test('AP5e a host button calling focus() during block selection: `focus` is heard in one mode', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'jump';
      button.textContent = 'Jump to A';
      document.querySelector('.outside')!.append(button);
      const ed = window.__e2e.editor;
      const seen: string[] = [];
      (window as unknown as { __seen: string[] }).__seen = seen;
      button.addEventListener('click', () => {
        seen.push(`returned ${ed.focus('a', 2)}`);
      });
      ed.on('focus', ({ blockId }) => {
        seen.push(`focus ${blockId} with [${ed.getSelectedBlocks().join(',')}]`);
      });
    });
    await editor.clickAt('c', 2);
    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual(['c']);
    await page.evaluate(() => {
      (window as unknown as { __seen: string[] }).__seen.length = 0;
    });

    await page.locator('#jump').click();

    expect(await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen)).toEqual([
      'focus a with []',
      'returned true',
    ]);
    expect(await editor.selected()).toEqual([]);
    expect(await editor.selection()).toMatchObject({ blockId: 'a', range: { start: 2, end: 2 } });
  });

  test('AP6 selectBlocks([]) hands the caret back; setBlockType announces and ends block mode', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await editor.placeCaret('c', 3);
    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual(['c']);
    await page.evaluate(() => window.__e2e.editor.selectBlocks([]));
    expect(await editor.selected()).toEqual([]);
    expect((await editor.selection())?.blockId).toBe('c');

    await page.evaluate(() => window.__e2e.editor.selectBlocks(['b']));
    await page.evaluate(() => window.__e2e.editor.setBlockType('b', 'quote'));
    expect(await editor.selected()).toEqual([]);
    await expect(editor.liveRegion).toHaveText('Changed to Quote');
    await expect(editor.block('b').locator('blockquote')).toBeVisible();
    expect((await editor.selection())?.blockId).toBe('b');
  });

  /*
   * R8-KEY-2. In Firefox a "/" typed with focus on the page opens Quick Find,
   * whose selection lives in the find bar's own content: its containers are
   * no Node the page can touch, and the editor's `selectionchange` listener
   * threw a TypeError into the host's error reporting (the fixture fails a
   * test on any page error). The probe, literally: a click in the page's
   * margin, then "//". Firefox's find bar: e2e; the other engines have no
   * such selection, and must stay quiet too.
   */
  test('AP7 a selection the page cannot touch raises no error', async ({ editor, page }) => {
    await editor.load({ doc: 'empty' });
    await page.mouse.click(1050, 700);
    await page.keyboard.type('//');
    await editor.settle();

    expect(await page.evaluate(() => window.__e2e.errors.map(String))).toEqual([]);
    // And the editor still takes a caret and typing afterwards.
    await editor.clickAt('p1', 0);
    await editor.type('x');
    expect(await editor.texts()).toEqual(['x']);
  });

  /*
   * R10-FMT-3, x3's literal case. A block holding five children (`alpha\n`,
   * bold, `\n`, bold, `\nlast line`), a click, Mod+↓ and End, then a host's
   * `setDocument` redrawing the block, same id, as plain "X". WebKit went on
   * reporting the caret at `DIV:4` on an element that now had one child, and
   * `setDocument` threw `IndexSizeError` after drawing -- no `change`, no
   * history -- then so did the next keystroke. A stale WebKit selection:
   * e2e (selection.test.ts pins the clamp with WebKit's answer stubbed).
   */
  /*
   * R10-RV-KEY-1, the reviewer's literal case (p6, p8). AP8's block after
   * "Prev", the caret at its end, and a host's `setDocument` rewriting it, same
   * id, as "Hello world". WebKit's selection then said `DIV:4` and its live
   * range `DIV:0`: with the offsets clamped but the range read raw, typing
   * went to the end while Backspace merged into "Prev" and Enter opened a
   * paragraph above. The editor now reads one caret and writes it back, so
   * every key acts there. Chromium and Firefox moved the caret to the start
   * themselves; since R12-KEY-7 the editor carries it by the text around it
   * -- the text after it, none, is unchanged -- so it is at the end in every
   * engine.
   */
  test('AP8b after that setDocument, Backspace and Enter act where typing does', async ({
    editor,
    page,
  }) => {
    const content = [
      { text: 'alpha\n' },
      { text: 'bold one', marks: ['bold' as const] },
      { text: '\n' },
      { text: 'bold two', marks: ['bold' as const] },
      { text: '\nlast line' },
    ];
    for (const [key, expected] of [
      ['Backspace', ['Prev', 'Hello worl']],
      ['Enter', ['Prev', 'Hello world', '']],
      ['Q', ['Prev', 'Hello worldQ']],
    ] as const) {
      await editor.load({ doc: 'empty' });
      await page.evaluate((content) => {
        window.__e2e.editor.setDocument({
          blocks: [
            { id: 'p', type: 'paragraph', depth: 0, content: [{ text: 'Prev' }] },
            { id: 'z', type: 'paragraph', depth: 0, content },
          ],
        });
      }, content);
      await editor.block('z').locator('.neditor-block__content').click();
      await page.keyboard.press(DOC_END);
      await page.keyboard.press('End');
      // At the block's end before the update, or the test is not about one.
      expect(await editor.selection(), key).toMatchObject({
        blockId: 'z',
        range: { start: 33, end: 33 },
      });
      await page.evaluate(() =>
        window.__e2e.editor.setDocument({
          blocks: [
            { id: 'p', type: 'paragraph', depth: 0, content: [{ text: 'Prev' }] },
            { id: 'z', type: 'paragraph', depth: 0, content: [{ text: 'Hello world' }] },
          ],
        }),
      );
      expect(await editor.selection(), key).toMatchObject({
        blockId: 'z',
        range: { start: 11, end: 11 },
      });

      await page.keyboard.press(key);
      expect(await editor.texts(), key).toEqual([...expected]);
    }
  });

  test('AP8 setDocument under a caret at the end of a formatted block does not throw', async ({
    editor,
    page,
  }) => {
    const content = [
      { text: 'alpha\n' },
      { text: 'bold one', marks: ['bold' as const] },
      { text: '\n' },
      { text: 'bold two', marks: ['bold' as const] },
      { text: '\nlast line' },
    ];
    for (const variant of ['same id', 'two blocks'] as const) {
      await editor.load({ doc: 'empty' });
      await page.evaluate((content) => {
        window.__e2e.editor.setDocument({
          blocks: [{ id: 'z', type: 'paragraph', depth: 0, content }],
        });
        window.__e2e.editor.on('change', () => {
          (window as unknown as { __changes: number }).__changes =
            ((window as unknown as { __changes?: number }).__changes ?? 0) + 1;
        });
      }, content);
      await editor.block('z').locator('.neditor-block__content').click();
      await page.keyboard.press(DOC_END);
      await page.keyboard.press('End');
      // At the block's end before the update, or the test is not about one.
      expect(await editor.selection(), variant).toMatchObject({
        blockId: 'z',
        range: { start: 33, end: 33 },
      });

      const thrown = await page.evaluate((variant) => {
        const blocks = [
          { id: 'z', type: 'paragraph' as const, depth: 0, content: [{ text: 'X' }] },
          ...(variant === 'two blocks'
            ? [{ id: 'w', type: 'paragraph' as const, depth: 0, content: [{ text: 'W' }] }]
            : []),
        ];
        try {
          window.__e2e.editor.setDocument({ blocks });
          return null;
        } catch (error) {
          return String(error);
        }
      }, variant);
      expect(thrown, variant).toBeNull();
      expect(
        await page.evaluate(() => (window as unknown as { __changes?: number }).__changes),
      ).toBe(1);

      // Typed at the end of the redrawn text: the caret was at the end, and
      // the text after it -- none -- is unchanged (R12-KEY-7).
      await page.keyboard.type('Y');
      expect((await editor.texts())[0], variant).toBe('XY');
      expect(await page.evaluate(() => window.__e2e.errors.map(String)), variant).toEqual([]);
    }
  });

  /*
   * R11-KEY-1, p5's literal case (WebKit). AP8b's block, the caret at its
   * end, then the reader moves to a button on the page -- clicked (WebKit
   * leaves focus on <body> and the selection in the block) or focused from
   * the keyboard -- and a peer's `setDocument` rewrites the block as "Hello
   * world". Reading WebKit's stale selection wrote it back, which focused the
   * block: the reader's Space and "xy" were typed into it ("Hello world xy").
   * Now the update moves no focus. Safari types into the selection a block
   * keeps while a button or <body> holds focus (p14 measured it with no
   * editor code involved), and with no update the keys go on doing that.
   * An update that redraws that very block takes the selection with it
   * (R12-KEY-3, p7: WebKit's own reading of the redrawn selection disagreed
   * with its live range, and "xy" went into the middle of the block), so the
   * keys reach nothing. Focus moved by a selection write: real browsers only.
   */
  test('AP9 a peer’s setDocument while the reader is at a page button pulls no focus into the block', async ({
    editor,
    page,
  }) => {
    const content = [
      { text: 'alpha\n' },
      { text: 'bold one', marks: ['bold' as const] },
      { text: '\n' },
      { text: 'bold two', marks: ['bold' as const] },
      { text: '\nlast line' },
    ];
    // What the keys do after the reader moved to the button, with no update
    // at all: the engine's own answer, which the update must not change.
    const typed = async (how: 'clicked' | 'focused', peer: boolean) => {
      await editor.load({ doc: 'empty' });
      await page.evaluate((content) => {
        window.__e2e.editor.setDocument({
          blocks: [
            { id: 'p', type: 'paragraph', depth: 0, content: [{ text: 'Prev' }] },
            { id: 'z', type: 'paragraph', depth: 0, content },
          ],
        });
        const button = document.createElement('button');
        button.id = 'host-button';
        button.textContent = 'Host button';
        document.body.prepend(button);
      }, content);
      await editor.block('z').locator('.neditor-block__content').click();
      await page.keyboard.press(DOC_END);
      await page.keyboard.press('End');
      // At the block's end before the update, or the test is not about one.
      expect(await editor.selection(), how).toMatchObject({
        blockId: 'z',
        range: { start: 33, end: 33 },
      });
      if (how === 'clicked') {
        await page.locator('#host-button').click();
      } else {
        await page.locator('#host-button').focus();
      }
      const active = () =>
        page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
      const before = await active();
      const text = peer ? 'Hello world' : 'alpha\nbold one\nbold two\nlast line';

      if (peer) {
        await page.evaluate(() =>
          window.__e2e.editor.setDocument({
            blocks: [
              { id: 'p', type: 'paragraph', depth: 0, content: [{ text: 'Prev' }] },
              { id: 'z', type: 'paragraph', depth: 0, content: [{ text: 'Hello world' }] },
            ],
          }),
        );
      }
      const moved = (await editor.hasFocus()) || (await active()) !== before;

      await page.keyboard.press('Space');
      await page.keyboard.type('xy');
      const now = (await editor.texts())[1]!;
      return { moved, added: now.startsWith(text) ? now.slice(text.length) : `<${now}>` };
    };

    for (const how of ['clicked', 'focused'] as const) {
      const updated = await typed(how, true);
      expect(updated.moved, how).toBe(false);
      expect(updated.added, how).toBe('');
    }
  });

  /*
   * R11-KEY-6, p9's literal case. ⌘B at the caret after "Hello", a peer's
   * silent `setDocument` editing the other block, then "XY". The reset dropped
   * the armed mark and "XY" came out plain. Its block, its text and the caret
   * all survived, so the mark does too -- typed through the browser's own
   * input, which happy-dom does not run.
   */
  test('AP10 a ⌘B armed at the caret survives a peer’s edit to another block', async ({
    editor,
    page,
  }) => {
    for (const peer of [false, true]) {
      await editor.load({ doc: 'empty' });
      await page.evaluate(() =>
        window.__e2e.editor.setDocument({
          blocks: [
            { id: 'z', type: 'paragraph', depth: 0, content: [{ text: 'Hello world' }] },
            { id: 'q', type: 'paragraph', depth: 0, content: [{ text: 'Other' }] },
          ],
        }),
      );
      await editor.clickAt('z', 5);
      await page.keyboard.press(`${MOD}+b`);
      if (peer) {
        await page.evaluate(() => {
          const ed = window.__e2e.editor;
          const doc = ed.getDocument();
          doc.blocks[1]!.content = [{ text: 'Other (peer)' }];
          ed.setDocument(doc, { silent: true });
        });
      }
      await page.keyboard.type('XY');

      expect((await editor.blockData('z'))!.content, `peer: ${peer}`).toEqual([
        { text: 'Hello' },
        { text: 'XY', marks: ['bold'] },
        { text: ' world' },
      ]);
    }

    // A peer rewriting the armed block itself still ends it -- at its start,
    // where the rewrite leaves the caret at the same offset in the same
    // focused host, only its text says the block changed.
    await editor.load({ doc: 'empty' });
    await page.evaluate(() =>
      window.__e2e.editor.setDocument({
        blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text: 'Hello world' }] }],
      }),
    );
    await editor.clickAt('z', 0);
    await page.keyboard.press('Home');
    await page.keyboard.press(`${MOD}+b`);
    await page.evaluate(() =>
      window.__e2e.editor.setDocument(
        { blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text: 'Goodbye' }] }] },
        { silent: true },
      ),
    );
    expect(await editor.selection()).toMatchObject({ blockId: 'z', range: { start: 0, end: 0 } });
    await page.keyboard.type('XY');
    expect((await editor.blockData('z'))!.content).toEqual([{ text: 'XYGoodbye' }]);

    // In a table, by the cell (q6's siblingCell and sameCellOther, from the
    // cell's start): another cell rewritten keeps it; its own cell rewritten
    // ends it, though the caret is again at the same offset in the same host.
    for (const [label, row, column, expected] of [
      ['another cell', 1, 1, [{ text: 'XY', marks: ['bold'] }, { text: 'a1' }]],
      ['its own cell', 1, 0, [{ text: 'XYZ1' }]],
    ] as const) {
      await editor.load({ doc: 'table' });
      const start = await editor.pointAt(editor.cell('tbl', 1, 0), 0);
      await page.mouse.click(start.x, start.y);
      await page.keyboard.press(`${MOD}+b`);
      await page.evaluate(
        ({ row, column }) => {
          const ed = window.__e2e.editor;
          const doc = ed.getDocument();
          const table = doc.blocks.find((block) => block.type === 'table')!;
          table.rows![row]![column] = [{ text: column === 0 ? 'Z1' : 'peer' }];
          ed.setDocument(doc, { silent: true });
        },
        { row, column },
      );
      await page.keyboard.type('XY');
      expect((await editor.blockData('tbl'))!.rows![1]![0], label).toEqual(expected);
    }
  });

  /*
   * R11-RV-KEY-1, q13's and q18's literal cases. The README's "drive your own
   * toolbar": a plain <button> that takes focus and runs `toggleMark('bold')`
   * from its click, and a <select> whose change runs `setBlockType` on the
   * selection's block. "charlie" selected with Shift+→, the control pressed,
   * and a peer's update to another block landing while it holds focus --
   * once, or every 60 ms through a 120 ms press. Round 11's first version
   * dropped the reader's selection whenever focus was outside the editor, and
   * nothing was bolded (0/6 in every engine). A page control keeps it.
   */
  test('AP11 a host’s own toolbar acts on the reader’s selection while a peer updates', async ({
    editor,
    page,
  }) => {
    const arrange = async (peerEvery: number | null) => {
      await editor.load({ doc: 'empty' });
      await page.evaluate((peerEvery) => {
        const ed = window.__e2e.editor;
        ed.setDocument({
          blocks: [
            { id: 'a', type: 'paragraph', depth: 0, content: [{ text: 'Alpha' }] },
            { id: 'b', type: 'paragraph', depth: 0, content: [{ text: 'Bravo charlie' }] },
            { id: 'c', type: 'paragraph', depth: 0, content: [{ text: 'Echo' }] },
          ],
        });
        const bar = document.createElement('div');
        bar.innerHTML =
          '<button id="host-bold">Bold</button><select id="host-type"><option value="paragraph">Text</option><option value="heading1">H1</option></select>';
        document.querySelector('.outside')!.append(bar);
        document
          .getElementById('host-bold')!
          .addEventListener('click', () => ed.toggleMark('bold'));
        document.getElementById('host-type')!.addEventListener('change', (event) => {
          const state = ed.getSelectionState();
          if (state) {
            ed.setBlockType(state.blockId, (event.target as HTMLSelectElement).value as 'heading1');
          }
        });
        if (peerEvery !== null) {
          let n = 0;
          (window as unknown as { __peer: number }).__peer = window.setInterval(() => {
            const doc = ed.getDocument();
            doc.blocks[2]!.content = [{ text: `Echo ${'x'.repeat(n++ % 40)}` }];
            ed.setDocument(doc, { silent: true });
          }, peerEvery);
        }
      }, peerEvery);
      await editor.clickAt('b', 6);
      for (let i = 0; i < 7; i += 1) await page.keyboard.press('Shift+ArrowRight');
    };
    const peerOnce = () =>
      page.evaluate(() => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks[2]!.content = [{ text: 'Echo (peer)' }];
        ed.setDocument(doc);
      });
    const bolded = [{ text: 'Bravo ' }, { text: 'charlie', marks: ['bold'] }];

    // q13, the button: pressed, the update, released.
    await arrange(null);
    const button = (await page.locator('#host-bold').boundingBox())!;
    await page.mouse.move(button.x + 5, button.y + 5);
    await page.mouse.down();
    await peerOnce();
    await page.mouse.up();
    expect((await editor.blockData('b'))!.content, 'button').toEqual(bolded);

    // q13, the select: focused, the update, an option chosen.
    await arrange(null);
    await page.locator('#host-type').focus();
    await peerOnce();
    await page.locator('#host-type').selectOption('heading1');
    expect((await editor.blockData('b'))!.type, 'select').toBe('heading1');

    // q18: a collaborator typing elsewhere through a 120 ms press.
    await arrange(60);
    const again = (await page.locator('#host-bold').boundingBox())!;
    await page.mouse.move(again.x + 5, again.y + 5);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(50);
    await page.evaluate(() =>
      window.clearInterval((window as unknown as { __peer: number }).__peer),
    );
    expect((await editor.blockData('b'))!.content, 'typing peer').toEqual(bolded);
  });

  /*
   * R13-KEY-2, k5's literal case. The reader clicks "c", presses End and types
   * "1"; a peer's `setDocument` reorders the blocks; the reader types "23".
   * Positioning the views from the top moved the reader's block whenever it
   * went up, or a block went from above it to below it, and moving the element
   * focus is in blurs it: focus was left on <body>, "c" stayed "Block C1" and
   * "23" landed nowhere, in every engine and mount. The renderer now moves the
   * other blocks around the one holding focus. Blur on a move, and the keys
   * that follow it, are a real browser's: happy-dom keeps focus on a moved node
   * (renderer.test.ts pins only that the element is never taken out).
   */
  for (const mount of ['plain', 'shadow', 'iframe', 'dialog', 'two'] as const) {
    test(`AP12 a peer’s reorder leaves the reader typing where they were (${mount})`, async ({
      editor,
      page,
    }) => {
      const reorder = (order: string[], patch: Record<string, object> = {}) =>
        page.evaluate(
          ({ order, patch }) => {
            const editor = window.__e2e.editors[0]!;
            const doc = editor.getDocument();
            const byId = new Map(doc.blocks.map((block) => [block.id, block]));
            editor.setDocument({
              blocks: order.map((id) => ({ ...byId.get(id)!, ...(patch[id] ?? {}) })),
            });
          },
          { order, patch },
        );
      const label = (id: string) => `Block ${id.toUpperCase()}`;
      const ed = mount === 'iframe' ? new EditorPage(page, 0, page.frameLocator('#frame')) : editor;

      for (const order of [
        ['b', 'c', 'a', 'd', 'e'],
        ['b', 'c', 'd', 'e', 'a'],
        ['c', 'a', 'b', 'd', 'e'],
        ['e', 'd', 'c', 'b', 'a'],
      ]) {
        const variant = `${mount} ${order.join('')}`;
        await ed.load({ doc: 'five', mount });
        await ed.content('c').click();
        await page.keyboard.press('End');
        await page.keyboard.type('1');
        await reorder(order);
        expect(await ed.focusedBlock(), variant).toBe('c');
        await page.keyboard.type('23');
        expect(await ed.texts(), variant).toEqual(
          order.map((id) => (id === 'c' ? 'Block C123' : label(id))),
        );
      }

      // The caret mid-text, and a range: the DOM selection survives the
      // siblings moving around its block, so the key lands at its offset.
      await ed.load({ doc: 'five', mount });
      await ed.content('c').click();
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowLeft');
      await reorder(['c', 'a', 'b', 'd', 'e']);
      await page.keyboard.type('Q');
      expect((await ed.texts())[0], `${mount} caret`).toBe('Block QC');

      await ed.load({ doc: 'five', mount });
      await ed.content('c').click();
      await page.keyboard.press('End');
      await page.keyboard.press('Shift+ArrowLeft');
      await page.keyboard.press('Shift+ArrowLeft');
      await reorder(['b', 'c', 'a', 'd', 'e']);
      await page.keyboard.type('Q');
      expect((await ed.texts())[1], `${mount} range`).toBe('BlockQ');

      // A table cell holding the caret, its table moved to the top.
      await ed.load({ doc: 'table', mount });
      await ed.cell('tbl', 1, 1).click();
      await page.keyboard.press('End');
      await reorder(['tbl', 'before', 'after']);
      await page.keyboard.type('Q');
      expect((await ed.blockData('tbl'))!.rows![1]![1], `${mount} cell`).toEqual([{ text: 'a2Q' }]);

      // A nested child moved up with its parent below it, and a toggle
      // expanded around the block that moves.
      await ed.load({ doc: 'nested', mount });
      await ed.content('l2').click();
      await page.keyboard.press('End');
      await reorder(['l2', 'l0', 'l1', 'after']);
      await page.keyboard.type('Q');
      expect((await ed.blockData('l2'))!.content, `${mount} nested`).toEqual([
        { text: 'Level twoQ' },
      ]);

      await ed.load({ doc: 'toggle-collapsed', mount });
      await ed.content('after').click();
      await page.keyboard.press('End');
      await reorder(['after', 'before', 'tg', 'child1', 'child2'], { tg: { collapsed: false } });
      await page.keyboard.type('Q');
      expect((await ed.blockData('after'))!.content, `${mount} toggle`).toEqual([
        { text: 'AfterQ' },
      ]);

      // Focus on a control inside the block the peer moves: the checkbox.
      await ed.load({ doc: 'lists', mount });
      await ed
        .block('t1')
        .locator('.neditor-block__checkbox')
        .evaluate((box: HTMLElement) => {
          box.focus();
        });
      await reorder(['t1', 'b1', 'b2', 'n1', 'n2', 't2']);
      expect(await ed.focusedBlock(), `${mount} checkbox`).toBe('t1');
      await page.keyboard.press('Space');
      expect((await ed.blockData('t1'))!.checked, `${mount} checkbox`).toBe(true);
    });
  }

  /*
   * AP11's host toolbar, R13-KEY-2's cause: the button holds focus (WebKit:
   * <body>) while it acts on the reader's range, and the peer's update moves
   * the block the range is in to the top. Taken out and put back, the block
   * lost the range and the button bolded nothing. With no block holding focus
   * the block the selection is in is the one the others move around.
   */
  test('AP13 a host’s own toolbar acts on the reader’s range when a peer moves its block', async ({
    editor,
    page,
  }) => {
    for (const order of [
      ['b', 'a', 'c'],
      ['c', 'a', 'b'],
    ]) {
      await editor.load({ doc: 'empty' });
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        ed.setDocument({
          blocks: [
            { id: 'a', type: 'paragraph', depth: 0, content: [{ text: 'Alpha' }] },
            { id: 'b', type: 'paragraph', depth: 0, content: [{ text: 'Bravo charlie' }] },
            { id: 'c', type: 'paragraph', depth: 0, content: [{ text: 'Echo' }] },
          ],
        });
        const button = document.createElement('button');
        button.id = 'host-bold';
        button.textContent = 'Bold';
        document.querySelector('.outside')!.append(button);
        button.addEventListener('click', () => ed.toggleMark('bold'));
      });
      await editor.clickAt('b', 6);
      for (let i = 0; i < 7; i += 1) await page.keyboard.press('Shift+ArrowRight');
      const button = (await page.locator('#host-bold').boundingBox())!;
      await page.mouse.move(button.x + 5, button.y + 5);
      await page.mouse.down();
      await page.evaluate((order) => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        const byId = new Map(doc.blocks.map((block) => [block.id, block]));
        ed.setDocument({ blocks: order.map((id) => byId.get(id)!) });
      }, order);
      await page.mouse.up();
      expect((await editor.blockData('b'))!.content, order.join('')).toEqual([
        { text: 'Bravo ' },
        { text: 'charlie', marks: ['bold'] },
      ]);
    }
  });
});
