import { EditorPage, expect, MOD, test } from '../helpers/test.ts';

test.describe('08 · block selection (keyboard)', () => {
  test('B1 Escape selects the block; Escape again leaves the editor and says so', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await editor.placeCaret('b', 3);
    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual(['b']);
    await expect(editor.root).toBeFocused();
    await expect(editor.block('b')).toHaveAttribute('data-selected', 'true');
    // A block is named for what it is: the menu's "Text" read as a text selection.
    await expect(editor.liveRegion).toHaveText('Paragraph selected, Block B');

    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual([]);
    expect(await editor.hasFocus()).toBe(false);
    await expect(editor.liveRegion).toHaveText('Left the editor');
  });

  test('B2 Shift+Arrow at a block edge extends into whole blocks', async ({ editor, page }) => {
    await editor.load({ doc: 'five' });
    await editor.placeCaret('c', 0);
    await page.keyboard.press('Shift+ArrowUp');
    expect(await editor.selected()).toEqual(['b', 'c']);
    await expect(editor.liveRegion).toHaveText('2 blocks selected');

    await editor.caretAtEnd('c');
    await page.keyboard.press('Shift+ArrowDown');
    expect(await editor.selected()).toEqual(['c', 'd']);
  });

  test('B2b a text selection that has reached the block edge extends on the next Shift+Arrow (STR-1)', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await editor.clickAt('b', 3);
    // The first press takes the range to the end of the line, which is the end
    // of the block; it is never a collapsed caret there.
    await page.keyboard.press('Shift+ArrowDown');
    expect(await editor.selection()).toMatchObject({ blockId: 'b', range: { start: 3, end: 7 } });
    await page.keyboard.press('Shift+ArrowDown');
    expect(await editor.selected()).toEqual(['b', 'c']);
    await page.keyboard.press('Shift+ArrowDown');
    expect(await editor.selected()).toEqual(['b', 'c', 'd']);

    await editor.clickAt('d', 3);
    await page.keyboard.press('Shift+ArrowUp');
    expect(await editor.selection()).toMatchObject({ blockId: 'd', range: { start: 0, end: 3 } });
    await page.keyboard.press('Shift+ArrowUp');
    expect(await editor.selected()).toEqual(['c', 'd']);
  });

  test('B2c moves, indents, outdents and duplicates are announced (A11Y-5)', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await editor.clickAt('b', 3);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press(`${MOD}+Shift+ArrowDown`);
    await expect(editor.liveRegion).toHaveText('Moved down');
    await page.keyboard.press('Tab');
    await expect(editor.liveRegion).toHaveText('Indented');
    await page.keyboard.press('Shift+Tab');
    await expect(editor.liveRegion).toHaveText('Outdented');
    await page.keyboard.press(`${MOD}+d`);
    await expect(editor.liveRegion).toHaveText('2 blocks duplicated. 2 blocks selected');
  });

  test('B2d a document that ends in a divider: ↓ and Enter open a paragraph after it (TXT-14)', async ({
    editor,
    page,
  }) => {
    const ending = {
      blocks: [
        { id: 'A', type: 'paragraph' as const, depth: 0, content: [{ text: 'Text' }] },
        { id: 'hr', type: 'divider' as const, depth: 0, content: [] },
      ],
    };
    await editor.load({ doc: 'empty' });

    // From text: ↓ off the last line.
    await editor.setDocument(ending);
    await editor.clickAt('A', 4);
    await page.keyboard.press('ArrowDown');
    expect(await editor.outline()).toEqual(['paragraph:Text', 'divider:', 'paragraph:']);
    await editor.type('more');
    expect(await editor.texts()).toEqual(['Text', '', 'more']);

    // From the divider itself, block-selected: Enter.
    await editor.setDocument(ending);
    await editor.clickAt('A', 4);
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowDown');
    expect(await editor.selected()).toEqual(['hr']);
    await page.keyboard.press('Enter');
    expect(await editor.selected()).toEqual([]);
    expect(await editor.outline()).toEqual(['paragraph:Text', 'divider:', 'paragraph:']);
    await editor.type('x');
    expect(await editor.texts()).toEqual(['Text', '', 'x']);
  });

  test('B3 Mod+A takes the text, then every block; in an empty block it goes straight to blocks', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await editor.placeCaret('b', 2);
    await page.keyboard.press(`${MOD}+a`);
    expect(await editor.selection()).toMatchObject({ blockId: 'b', range: { start: 0, end: 7 } });
    expect(await editor.selected()).toEqual([]);
    await page.keyboard.press(`${MOD}+a`);
    expect(await editor.selected()).toEqual(['a', 'b', 'c', 'd', 'e']);

    await editor.remount({}, 'empty');
    await editor.placeCaret('p1', 0);
    await page.keyboard.press(`${MOD}+a`);
    expect(await editor.selected()).toEqual(['p1']);
  });

  test('B4 arrows move the selection, Shift grows and shrinks it from the anchor, Mod+Shift moves blocks', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['c']));
    await page.keyboard.press('ArrowDown');
    expect(await editor.selected()).toEqual(['d']);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    expect(await editor.selected()).toEqual(['b']);

    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    expect(await editor.selected()).toEqual(['b', 'c', 'd']);
    await page.keyboard.press('Shift+ArrowUp');
    expect(await editor.selected()).toEqual(['b', 'c']);

    await page.keyboard.press(`${MOD}+Shift+ArrowDown`);
    expect(await editor.ids()).toEqual(['a', 'd', 'b', 'c', 'e']);
    expect(await editor.selected()).toEqual(['b', 'c']);
    await page.keyboard.press(`${MOD}+z`);
    expect(await editor.ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  /*
   * The reviewer's k1 case (round 14, review 2): a block at the window's
   * edge, selected, and Shift+Arrow six times on past that edge. The
   * selection grew out of sight -- every key revealed the block it grows
   * from, which never moves, so the end that does was 30, 60, ... 180px
   * off the window and the page stood still. Shift+Arrow reveals the end
   * it moves: growing, and shrinking back toward where it started. In the
   * window and in a pane that scrolls the editor; both ways.
   */
  test('B4b Shift+Arrow on a block selection brings the end it moves into view', async ({
    editor,
    page,
  }) => {
    // The moving end's box against what shows of it: the window, or the pane.
    const moving = (down: boolean, pane: boolean) =>
      page.evaluate(
        ({ down, pane }) => {
          const ed = window.__e2e.editor;
          const ids = ed.getSelectedBlocks();
          const id = down ? ids.at(-1)! : ids[0]!;
          const box = ed.element.querySelector(`[data-block-id="${id}"]`)!.getBoundingClientRect();
          const stage = document.querySelector<HTMLElement>('#stage')!;
          const frame = stage.getBoundingClientRect();
          const [top, bottom] = pane
            ? [frame.top + stage.clientTop, frame.top + stage.clientTop + stage.clientHeight]
            : [0, window.innerHeight];
          return {
            id,
            count: ids.length,
            shown: box.top >= top - 1 && box.bottom <= bottom + 1,
            scrolled: pane ? stage.scrollTop : window.scrollY,
          };
        },
        { down, pane },
      );

    // From a block already selected, and from a caret in its text: the
    // first Shift+Arrow out of the text revealed the block the caret was
    // in, and took in p29 at -31..-1 with the page where it was -- the
    // next Backspace deleted a block the reader had not seen (R14-RV3-4).
    for (const [pane, down, caret] of [
      [false, true, false],
      [false, false, false],
      [true, true, false],
      [true, false, false],
      [false, true, true],
      [false, false, true],
      [true, true, true],
      [true, false, true],
    ] as const) {
      {
        const label = `${pane ? 'a pane' : 'the window'}, Shift+Arrow${down ? 'Down' : 'Up'}${caret ? ', from a caret' : ''}`;
        await editor.load({ doc: 'long' });
        await page.evaluate(
          ({ down, pane }) => {
            const stage = document.querySelector<HTMLElement>('#stage')!;
            if (pane) {
              stage.style.cssText = 'height:420px;overflow:auto;border:2px solid #36c';
            }
            const box = window.__e2e.editor.element
              .querySelector('[data-block-id="p30"]')!
              .getBoundingClientRect();
            // p30 against the edge the selection is about to grow past.
            if (pane) {
              const frame = stage.getBoundingClientRect();
              stage.scrollTop += down
                ? box.bottom - (frame.top + stage.clientTop + stage.clientHeight) + 4
                : box.top - (frame.top + stage.clientTop) - 4;
            } else {
              window.scrollTo(
                0,
                down
                  ? box.bottom + window.scrollY - window.innerHeight + 4
                  : box.top + window.scrollY - 4,
              );
            }
          },
          { down, pane },
        );
        await editor.settle();
        const line = (await editor.content('p30').boundingBox())!;
        // At the end of its text for ↓, at the start for ↑.
        await page.mouse.click(
          down ? line.x + line.width - 3 : line.x + 2,
          line.y + line.height / 2,
        );
        if (!caret) {
          await page.keyboard.press('Escape');
          expect(await editor.selected(), label).toEqual(['p30']);
        }
        const start = await page.evaluate(
          (pane) => (pane ? document.querySelector('#stage')!.scrollTop : window.scrollY),
          pane,
        );

        for (let press = 1; press <= 6; press += 1) {
          await page.keyboard.press(down ? 'Shift+ArrowDown' : 'Shift+ArrowUp');
          await editor.settle();
          const end = await moving(down, pane);
          expect(end, `${label}, press ${press}`).toMatchObject({
            id: `p${down ? 30 + press : 30 - press}`,
            shown: true,
          });
        }

        const grown = (await moving(down, pane)).scrolled;
        expect(Math.abs(grown - start), label).toBeGreaterThan(120);

        // On to 24 blocks, more than the window holds; the moving end put
        // out of sight by hand; and one key back toward where it started.
        for (let press = 7; press <= 24; press += 1) {
          await page.keyboard.press(down ? 'Shift+ArrowDown' : 'Shift+ArrowUp');
        }

        await editor.settle();
        expect(await moving(down, pane), label).toMatchObject({ count: 25, shown: true });
        await page.evaluate(
          ({ pane, to }) => {
            if (pane) document.querySelector('#stage')!.scrollTop = to;
            else window.scrollTo(0, to);
          },
          { pane, to: start },
        );
        await editor.settle();
        expect((await moving(down, pane)).shown, label).toBe(false);
        await page.keyboard.press(down ? 'Shift+ArrowUp' : 'Shift+ArrowDown');
        await editor.settle();
        expect(await moving(down, pane), `${label}, and back`).toMatchObject({
          id: `p${down ? 53 : 7}`,
          count: 24,
          shown: true,
        });
      }
    }
  });

  test('B5 Tab and Shift+Tab indent and outdent the whole group', async ({ editor, page }) => {
    await editor.load({ doc: 'five' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['b', 'c']));
    await page.keyboard.press('Tab');
    expect((await editor.doc()).blocks.map((block) => block.depth)).toEqual([0, 1, 1, 0, 0]);
    await page.keyboard.press('Shift+Tab');
    expect((await editor.doc()).blocks.map((block) => block.depth)).toEqual([0, 0, 0, 0, 0]);
  });

  test('B5b a Tab in block mode that changes nothing leaves block mode before focus moves on', async ({
    editor,
    page,
  }) => {
    // Was FINDING F6: focus reached the first block's host but the block
    // selection survived, so the character typed at the visible caret
    // replaced the whole block.
    await editor.load({ doc: 'five' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['a']));
    await page.keyboard.press('Tab'); // nothing above `a` to nest under
    await expect(editor.root).not.toBeFocused();
    expect(await editor.selected()).toEqual([]);
    expect(await editor.invariants()).toEqual([]);
    await page.keyboard.type('x');
    // Whatever mode the editor lands in, typing must not destroy "Block A".
    expect((await editor.texts())[0]).toContain('Block A');
  });

  test('B6 Backspace and Delete remove the blocks and place the caret; deleting everything leaves one paragraph', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['b', 'c']));
    await page.keyboard.press('Backspace');
    expect(await editor.ids()).toEqual(['a', 'd', 'e']);
    await expect(editor.liveRegion).toHaveText('2 blocks deleted');
    expect(await editor.selection()).toMatchObject({ blockId: 'd', range: { start: 0, end: 0 } });

    await page.evaluate(() => window.__e2e.editor.selectBlocks(['e']));
    await page.keyboard.press('Delete');
    await expect(editor.liveRegion).toHaveText('Block deleted');
    expect((await editor.selection())?.blockId).toBe('d');

    await page.evaluate(() => window.__e2e.editor.selectBlocks(['a', 'd']));
    await page.keyboard.press('Delete');
    expect(await editor.outline()).toEqual(['paragraph:']);
  });

  test('B7 Mod+D duplicates below and selects the copies', async ({ editor, page }) => {
    await editor.load({ doc: 'five' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['b', 'c']));
    await page.keyboard.press(`${MOD}+d`);
    expect(await editor.texts()).toEqual([
      'Block A',
      'Block B',
      'Block C',
      'Block B',
      'Block C',
      'Block D',
      'Block E',
    ]);
    const ids = await editor.ids();
    expect(await editor.selected()).toEqual([ids[3], ids[4]]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('B8 a printable key replaces the selection with a paragraph holding it', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['b', 'c']));
    await page.keyboard.type('xyz');
    expect(await editor.texts()).toEqual(['Block A', 'xyz', 'Block D', 'Block E']);
    expect(await editor.selected()).toEqual([]);
  });

  test('B9 Enter returns to the last selected block that can hold a caret', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'divider' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['p1', 'hr']));
    await page.keyboard.press('Enter');
    expect(await editor.selected()).toEqual([]);
    expect(await editor.selection()).toMatchObject({ blockId: 'p1', range: { start: 5, end: 5 } });

    await page.evaluate(() => window.__e2e.editor.selectBlocks(['hr']));
    await page.keyboard.press('Enter');
    expect(await editor.selected()).toEqual(['hr']);
  });

  test('B10 selected blocks are marked with an accent bar, not colour alone, and no aria-selected', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'five' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['b']));
    const bar = await editor.block('b').evaluate((element) => {
      const style = getComputedStyle(element, '::before');
      return { content: style.content, width: style.width };
    });
    expect(bar.content).not.toBe('none');
    expect(parseFloat(bar.width)).toBeGreaterThanOrEqual(2);
    await expect(editor.block('b')).not.toHaveAttribute('aria-selected');
    const unselected = await editor
      .block('a')
      .evaluate((element) => getComputedStyle(element, '::before').content);
    expect(unselected).toBe('none');
  });

  test('B11 a collapsed toggle carries its hidden children through delete, move and duplicate', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'toggle-collapsed' });
    await page.evaluate(() => window.__e2e.editor.selectBlocks(['tg']));
    expect(await editor.selected()).toEqual(['tg']);

    await page.keyboard.press(`${MOD}+Shift+ArrowUp`);
    expect(await editor.ids()).toEqual(['tg', 'child1', 'child2', 'before', 'after']);

    await page.keyboard.press(`${MOD}+d`);
    expect(await editor.texts()).toEqual([
      'Toggle head',
      'Hidden child one',
      'Hidden child two',
      'Toggle head',
      'Hidden child one',
      'Hidden child two',
      'Before',
      'After',
    ]);

    await page.evaluate(() => window.__e2e.editor.selectBlocks(['tg']));
    await page.keyboard.press('Backspace');
    expect(await editor.texts()).toEqual([
      'Toggle head',
      'Hidden child one',
      'Hidden child two',
      'Before',
      'After',
    ]);
    expect(await editor.ids()).not.toContain('child1');
  });

  /*
   * R8-KEY-3. `setDocument` cleared a block selection outright, leaving the
   * root holding focus with nothing selected and no caret -- neither mode --
   * so the next key fell on the floor; WebKit's Backspace navigated the page
   * away. The probe: a click in "Block B", Escape, a peer's edit to "Block C",
   * then each key. The blocks the new document still shows stay selected, and
   * the keys act on them. Real key routing and focus: e2e.
   */
  test('B12 a block selection survives a host’s setDocument, and its keys still act on it', async ({
    editor,
    page,
  }) => {
    const peer = () =>
      page.evaluate(() => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks[2]!.content = [{ text: 'Block C (peer)' }];
        ed.setDocument(doc);
      });

    for (const key of ['Backspace', 'ArrowDown'] as const) {
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
          blocks: [para('a', 'Block A'), para('b2', 'Block B'), para('c', 'Block C')],
        });
        ed.clearHistory();
      });
      await editor.clickAt('b2', 3);
      await page.keyboard.press('Escape');
      expect(await editor.selected()).toEqual(['b2']);

      await peer();
      expect(await editor.selected(), key).toEqual(['b2']);
      await expect(editor.root, key).toBeFocused();

      const url = page.url();
      await page.keyboard.press(key);
      expect(page.url(), key).toBe(url);
      if (key === 'Backspace') {
        expect(await editor.texts()).toEqual(['Block A', 'Block C (peer)']);
      } else {
        expect(await editor.selected()).toEqual(['c']);
      }
    }
  });

  /*
   * R9-KEY-1, the probes' literal cases. When nothing of the old order
   * survived -- a host that reloads from Markdown gives every block a new id;
   * a peer leaves only a divider -- the hand-back found nothing and left the
   * root focused with neither a caret nor a selection; WebKit's Backspace
   * navigated the page away. Real key routing and focus: e2e.
   */
  const threeParas = () =>
    window.__e2e.editor.setDocument({
      blocks: (
        [
          ['a', 'Block A'],
          ['b2', 'Block B'],
          ['c', 'Block C'],
        ] as const
      ).map(([id, text]) => ({ id, type: 'paragraph' as const, depth: 0, content: [{ text }] })),
    });

  /*
   * Every id is new. The editor no longer guesses (R10-KEY-1, -2): not by
   * position, not by content. The selection ends and focus leaves the
   * editor, and a key pressed then reaches nothing in it. (Backspace there
   * is B24's: WebKit goes back in history on it with focus on <body>.)
   */
  test('B13 a Markdown reload with every id new ends the selection and lets go of focus', async ({
    editor,
    page,
  }) => {
    for (const key of ['Delete', 'a', 'ArrowDown'] as const) {
      await editor.load({ doc: 'empty' });
      await page.evaluate(threeParas);
      await editor.clickAt('b2', 3);
      await page.keyboard.press('Escape');
      expect(await editor.selected()).toEqual(['b2']);

      await page.evaluate(() => {
        const { editor, lib } = window.__e2e;
        const md = lib.toMarkdown(editor.getDocument()).replace('Block C', 'Block C (peer)');
        editor.setDocument({ blocks: lib.blocksFromMarkdown(md) });
      });
      expect(await editor.ids(), key).not.toContain('b2');
      expect(await editor.selected(), key).toEqual([]);
      expect(await editor.hasFocus(), key).toBe(false);
      expect(await editor.selection(), key).toBeNull();

      const url = page.url();
      await page.keyboard.press(key);
      expect(page.url(), key).toBe(url);
      expect(await editor.texts(), key).toEqual(['Block A', 'Block B', 'Block C (peer)']);
      expect(await editor.selected(), key).toEqual([]);
    }
  });

  /*
   * R9-RV-SEL-1, p04's literal case: Markdown drops the empty paragraph above
   * the selection, so the block now at its old position is the one after it.
   * Found by position, the caret went into "Ship release" and Q was typed
   * there. Neither position nor content decides now: Q reaches nothing.
   */
  test('B13c a reload that drops a blank line above types into no block', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await page.evaluate(() => {
      const para = (id: string, text: string, type: 'paragraph' | 'heading2' = 'paragraph') => ({
        id,
        type,
        depth: 0,
        content: text ? [{ text }] : [],
      });
      window.__e2e.editor.setDocument({
        blocks: [
          para('x', 'Notes', 'heading2'),
          para('blank', ''),
          para('a', 'Buy milk'),
          para('bb', 'Call Sam'),
          para('c', 'Ship release'),
        ],
      });
      window.__e2e.editor.clearHistory();
    });
    await editor.clickAt('bb', 3);
    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual(['bb']);

    await page.evaluate(() => {
      const { lib, editor } = window.__e2e;
      editor.setDocument({ blocks: lib.blocksFromMarkdown(lib.toMarkdown(editor.getDocument())) });
    });
    expect(await editor.texts()).toEqual(['Notes', 'Buy milk', 'Call Sam', 'Ship release']);
    expect(await editor.selected()).toEqual([]);
    expect(await editor.hasFocus()).toBe(false);

    await page.keyboard.type('Q');
    expect(await editor.texts()).toEqual(['Notes', 'Buy milk', 'Call Sam', 'Ship release']);
  });

  /*
   * R10-KEY-1, the probes' literal cases (p07, p06 A). Blank paragraphs above
   * and inside the selection, which Markdown drops: the old index named
   * "Epsilon 1", and with seventy blank lines above "Unique", "Line 68". The
   * next key was typed there. Real typing: e2e.
   */
  test('B13d a reload below dropped blank lines types into no block, near or far', async ({
    editor,
    page,
  }) => {
    type Case = { blocks: [string, string][]; from: string; extend: number };
    const blanks = (n: number, prefix: string): [string, string][] =>
      Array.from({ length: n }, (_, i) => [`${prefix}${i}`, ''] as [string, string]);
    const cases: Record<string, Case> = {
      sections: {
        blocks: [
          ['t', 'Title'],
          ...blanks(1, 'x'),
          ['a1', 'Alpha 1'],
          ...blanks(1, 'y'),
          ['g1', 'Gamma 1'],
          ['ge', ''],
          ['g2', 'Gamma 2'],
          ...blanks(1, 'w'),
          ['d1', 'Delta 1'],
          ...blanks(1, 'v'),
          ['e1', 'Epsilon 1'],
          ['f1', 'Zeta 1'],
        ],
        from: 'g1',
        extend: 2,
      },
      window: {
        blocks: [
          ['t', 'Title'],
          ...blanks(70, 'k'),
          ['u', 'Unique'],
          ['n1', 'Next one'],
          ...Array.from({ length: 80 }, (_, i) => [`m${i}`, `Line ${i}`] as [string, string]),
        ],
        from: 'u',
        extend: 0,
      },
    };

    for (const [label, c] of Object.entries(cases)) {
      await editor.load({ doc: 'empty' });
      await page.evaluate((blocks) => {
        const ed = window.__e2e.editor;
        ed.setDocument({
          blocks: blocks.map(([id, text]) => ({
            id,
            type: 'paragraph' as const,
            depth: 0,
            content: text ? [{ text }] : [],
          })),
        });
        ed.clearHistory();
      }, c.blocks);
      await page.evaluate(
        (id) =>
          window.__e2e.editor.element
            .querySelector(`[data-block-id="${id}"]`)!
            .scrollIntoView({ block: 'center' }),
        c.from,
      );
      await editor.clickAt(c.from, 2);
      await page.keyboard.press('Escape');
      for (let step = 0; step < c.extend; step += 1) {
        await page.keyboard.press('Shift+ArrowDown');
      }
      expect(await editor.selected(), label).toHaveLength(c.extend + 1);
      const before = await editor.texts();

      await page.evaluate(() => {
        const { lib, editor } = window.__e2e;
        editor.setDocument({
          blocks: lib.blocksFromMarkdown(lib.toMarkdown(editor.getDocument())),
        });
      });
      expect(await editor.selected(), label).toEqual([]);
      expect(await editor.hasFocus(), label).toBe(false);

      await page.keyboard.type('x');
      expect(await editor.texts(), label).toEqual(before.filter((text) => text !== ''));
    }
  });

  /*
   * R10-KEY-2, p11 and p20's literal cases: a daily note made from a
   * template, its "Notes" heading selected, and the host switching to
   * yesterday's note -- from a script with the root focused, and from a
   * sidebar link. Yesterday's "Notes" heading was selected, and a delete
   * removed it. (Delete rather than Backspace: see B13.)
   */
  test('B20 switching to another note from the same template selects nothing in it', async ({
    editor,
    page,
  }) => {
    for (const from of ['root', 'sidebar'] as const) {
      await editor.load({ doc: 'empty' });
      await page.evaluate(() => {
        type Kind = 'heading1' | 'heading2' | 'todo' | 'paragraph' | 'divider';
        const make = (id: string, type: Kind, text = '') => ({
          id,
          type,
          depth: 0,
          content: text ? [{ text }] : [],
        });
        const note = (p: string, day: string, tasks: string[], notes: string[]) => [
          make(`${p}h`, 'heading1', day),
          make(`${p}t`, 'heading2', 'Tasks'),
          ...tasks.map((text, i) => make(`${p}k${i}`, 'todo', text)),
          make(`${p}n`, 'heading2', 'Notes'),
          ...notes.map((text, i) => make(`${p}p${i}`, 'paragraph', text)),
          make(`${p}d`, 'divider'),
        ];
        const ed = window.__e2e.editor;
        const yesterday = note(
          'y',
          'Monday 9 November',
          ['Write the changelog'],
          ['Quiet day.', 'Read the audit.'],
        );
        ed.setDocument({
          blocks: note(
            'a',
            'Tuesday 10 November',
            ['Ship the release', 'Call Sam'],
            ['Meeting went long.'],
          ),
        });
        ed.clearHistory();
        const link = document.createElement('a');
        link.href = '#yesterday';
        link.id = 'side';
        link.textContent = 'Yesterday';
        document.body.prepend(link);
        link.addEventListener('click', (event) => {
          event.preventDefault();
          ed.setDocument({ blocks: yesterday });
        });
        (window as unknown as { __yesterday: () => void }).__yesterday = () =>
          ed.setDocument({ blocks: yesterday });
      });
      await editor.clickAt('an', 2);
      await page.keyboard.press('Escape');
      expect(await editor.selected(), from).toEqual(['an']);

      if (from === 'root') {
        await page.evaluate(() => (window as unknown as { __yesterday: () => void }).__yesterday());
        expect(await editor.hasFocus(), from).toBe(false);
      } else {
        await page.locator('#side').click();
        // Focus is wherever the click left it -- the link, or <body> in
        // WebKit, which does not focus a link on a click -- never the editor.
        expect(await editor.hasFocus(), from).toBe(false);
      }
      expect(await editor.selected(), from).toEqual([]);

      await page.keyboard.press('Delete');
      expect(await editor.texts(), from).toContain('Notes');
      expect(await editor.ids(), from).toContain('yn');
    }
  });

  /*
   * R9-RV-SEL-4, p08's literal case: a host that writes every `change` out as
   * Markdown and loads it straight back, [Beta, Gamma] selected, and "x"
   * typed. The new paragraph was renamed under the editor, the caret aimed at
   * its old id went nowhere, and the root held focus in neither mode. Rounds 9
   * and 10 found the paragraph by its content and typed the next key after
   * it; R11-KEY-4 removed that search (B27), so the character is typed, the
   * root lets go, and the next key reaches no block.
   */
  test('B16 a printable key in block mode under a Markdown echo is typed; the next key lands nowhere', async ({
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
        blocks: [para('a', 'Alpha'), para('b2', 'Beta'), para('c', 'Gamma'), para('d', 'Delta')],
      });
      ed.clearHistory();
      const { lib } = window.__e2e;
      ed.on('change', () => {
        ed.setDocument(
          { blocks: lib.blocksFromMarkdown(lib.toMarkdown(ed.getDocument())) },
          {
            silent: true,
          },
        );
      });
    });
    await editor.clickAt('b2', 2);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+ArrowDown');
    expect(await editor.selected()).toEqual(['b2', 'c']);

    await page.keyboard.type('x');
    await page.keyboard.type('Q');

    expect(await editor.hasFocus()).toBe(false);
    expect(await editor.texts()).toEqual(['Alpha', 'x', 'Delta']);
    expect(await editor.selected()).toEqual([]);
  });

  /*
   * R9-RV2-SEL-1, p01's literal case: a host with stable ids, a to-do
   * selected beside an identical one, and a peer deleting the selected one.
   * Content matching moved the selection onto the twin, and Backspace
   * deleted a block nobody chose. Content is asked only on a full rename.
   */
  test('B17 a peer deleting the selected block never selects its identical twin', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const make = (id: string, type: 'paragraph' | 'todo', text: string) => ({
        id,
        type,
        depth: 0,
        content: [{ text }],
      });
      ed.setDocument({
        blocks: [
          make('a', 'paragraph', 'Alpha'),
          make('t1', 'todo', 'buy milk'),
          make('t2', 'todo', 'buy milk'),
          make('d', 'paragraph', 'Delta'),
        ],
      });
      ed.clearHistory();
    });
    await editor.clickAt('t1', 2);
    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual(['t1']);

    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      ed.setDocument({ blocks: ed.getDocument().blocks.filter((block) => block.id !== 't1') });
    });
    expect(await editor.selected()).toEqual([]);

    await page.keyboard.press('Backspace');
    expect(await editor.ids()).toContain('t2');
  });

  /*
   * R9-RV2-SEL-2, p02's literal case: a Markdown reload (every id new, a
   * blank line above dropped) beside a twin that differs only in its check.
   * Matched by type and text, the unchecked twin was selected and Backspace
   * deleted it. Nothing is matched now, and a delete removes neither.
   */
  test('B18 a reload beside twins deletes neither to-do', async ({ editor, page }) => {
    await editor.load({ doc: 'empty' });
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      ed.setDocument({
        blocks: [
          { id: 'n', type: 'paragraph', depth: 0, content: [{ text: 'Notes' }] },
          { id: 'e', type: 'paragraph', depth: 0, content: [] },
          { id: 't1', type: 'todo', depth: 0, checked: true, content: [{ text: 'task' }] },
          { id: 't2', type: 'todo', depth: 0, checked: false, content: [{ text: 'task' }] },
        ],
      });
      ed.clearHistory();
    });
    await editor.clickAt('t1', 1);
    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual(['t1']);

    await page.evaluate(() => {
      const { editor: ed, lib } = window.__e2e;
      ed.setDocument({ blocks: lib.blocksFromMarkdown(lib.toMarkdown(ed.getDocument())) });
    });
    expect(await editor.selected()).toEqual([]);
    await page.keyboard.press('Delete');

    const left = (await editor.doc()).blocks;
    expect(left.map((block) => [block.type, block.checked === true])).toEqual([
      ['paragraph', false],
      ['todo', true],
      ['todo', false],
    ]);
  });

  /*
   * R9-RV2-SEL-3, p06's literal case: a Markdown echo, "Beta" selected after
   * a blank line, a one-character paragraph "q" after it, and "q" typed. The
   * echo drops the blank line, the old "q" became the nearest, and the caret
   * went to its end: the next key was typed into it. Neither "q" gets it now
   * (R11-KEY-4): the root lets go.
   */
  test('B19 typing over a block under a Markdown echo types the next key into neither "q"', async ({
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
        content: text ? [{ text }] : [],
      });
      ed.setDocument({
        blocks: [para('n', 'Notes'), para('e', ''), para('B', 'Beta'), para('x', 'q')],
      });
      ed.clearHistory();
      const { lib } = window.__e2e;
      ed.on('change', () => {
        ed.setDocument(
          { blocks: lib.blocksFromMarkdown(lib.toMarkdown(ed.getDocument())) },
          { silent: true },
        );
      });
    });
    await editor.clickAt('B', 1);
    await page.keyboard.press('Escape');
    await page.keyboard.type('q');
    await page.keyboard.type('Z');

    expect(await editor.hasFocus()).toBe(false);
    expect(await editor.texts()).toEqual(['Notes', 'q', 'q']);
  });

  /** A host that writes every `change` out as Markdown and loads it straight back. */
  const markdownEcho = () => {
    const { editor: ed, lib } = window.__e2e;
    ed.on('change', () => {
      ed.setDocument(
        { blocks: lib.blocksFromMarkdown(lib.toMarkdown(ed.getDocument())) },
        { silent: true },
      );
    });
  };

  /*
   * R10-KEY-1, p08's "twins" case: one-character twins either side of the
   * selected block, each behind a blank line, "q" typed over it under a
   * Markdown echo. Nothing says which "q" is the new one; by position the
   * caret went to "Delta" and the next key was typed into it.
   */
  test('B21 typing over a block between one-character twins under an echo types no further', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await page.evaluate(() => {
      const para = (id: string, text: string) => ({
        id,
        type: 'paragraph' as const,
        depth: 0,
        content: text ? [{ text }] : [],
      });
      const ed = window.__e2e.editor;
      ed.setDocument({
        blocks: [
          para('a', 'Alpha'),
          para('e1', ''),
          para('t1', 'q'),
          para('e2', ''),
          para('s', 'Select me'),
          para('e3', ''),
          para('t2', 'q'),
          para('d', 'Delta'),
        ],
      });
      ed.clearHistory();
    });
    await page.evaluate(markdownEcho);
    await editor.clickAt('s', 2);
    await page.keyboard.press('Escape');

    await page.keyboard.type('q');
    expect(await editor.hasFocus()).toBe(false);
    await page.keyboard.type('u');

    expect(await editor.texts()).toEqual(['Alpha', 'q', 'q', 'q', 'Delta']);
  });

  /*
   * R10-KEY-1, p06's B and C cases: [First, ∅, Second] selected under two
   * blank lines and a Markdown echo, then a block-mode Tab or Mod+Shift+↓.
   * The echo renamed every block, the caret went to "Quiet" or "Rest", and
   * "x" was typed there. The edit is made; focus then leaves the editor.
   */
  test('B22 an indent or a move under a Markdown echo is made, and types no further', async ({
    editor,
    page,
  }) => {
    for (const [key, order, depths] of [
      ['Tab', ['Heading', 'First', 'Second', 'Quiet', 'Rest'], [0, 1, 1, 0, 0]],
      [
        'ControlOrMeta+Shift+ArrowDown',
        ['Heading', 'Quiet', 'First', 'Second', 'Rest'],
        [0, 0, 0, 0, 0],
      ],
    ] as const) {
      await editor.load({ doc: 'empty' });
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const make = (id: string, text: string, type: 'paragraph' | 'heading1' = 'paragraph') => ({
          id,
          type,
          depth: 0,
          content: text ? [{ text }] : [],
        });
        ed.setDocument({
          blocks: [
            make('h', 'Heading', 'heading1'),
            make('e1', ''),
            make('e2', ''),
            make('p1', 'First'),
            make('e3', ''),
            make('p2', 'Second'),
            make('q', 'Quiet'),
            make('r', 'Rest'),
          ],
        });
        ed.clearHistory();
      });
      await page.evaluate(markdownEcho);
      await editor.clickAt('p1', 2);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Shift+ArrowDown');
      await page.keyboard.press('Shift+ArrowDown');
      expect(await editor.selected(), key).toEqual(['p1', 'e3', 'p2']);

      await page.keyboard.press(key);
      expect(await editor.selected(), key).toEqual([]);
      expect(await editor.hasFocus(), key).toBe(false);

      await page.keyboard.type('x');
      const blocks = (await editor.doc()).blocks;
      expect(await editor.texts(), key).toEqual([...order]);
      expect(
        blocks.map((block) => block.depth),
        key,
      ).toEqual([...depths]);
    }
  });

  /*
   * R10-KEY-3, p19's literal case: forty paragraphs, "Paragraph 10" selected
   * in the middle of the window, a Markdown echo, and Delete, Backspace,
   * Mod+X or Mod+D. A miss in the id lookup read as position 0, so the caret
   * went to the end of "Paragraph 39" -- the page scrolled 480px -- and "Q"
   * was typed there; Mod+D said "0 blocks duplicated" and put the caret back
   * in "Paragraph 10". Each edit is made and announced as made; nothing
   * scrolls, and Q reaches no block.
   */
  test('B23 a delete, cut or duplicate under a Markdown echo lands nowhere and says what it did', async ({
    editor,
    page,
  }) => {
    for (const [key, said] of [
      ['Delete', 'Block deleted'],
      ['Backspace', 'Block deleted'],
      ['ControlOrMeta+x', 'Block cut'],
      ['ControlOrMeta+d', 'Block duplicated. No blocks selected'],
    ] as const) {
      await editor.load({ doc: 'empty' });
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        ed.setDocument({
          blocks: Array.from({ length: 40 }, (_, i) => ({
            id: `p${i}`,
            type: 'paragraph' as const,
            depth: 0,
            content: [{ text: `Paragraph ${i}` }],
          })),
        });
        ed.clearHistory();
      });
      await page.evaluate(markdownEcho);
      await page.evaluate(() =>
        window.__e2e.editor.element
          .querySelector('[data-block-id="p10"]')!
          .scrollIntoView({ block: 'center' }),
      );
      await editor.clickAt('p10', 3);
      await page.keyboard.press('Escape');
      expect(await editor.selected(), key).toEqual(['p10']);
      const scrolled = await page.evaluate(() => Math.round(window.scrollY));

      await page.keyboard.press(key);
      expect(await editor.selected(), key).toEqual([]);
      expect(await editor.hasFocus(), key).toBe(false);
      expect((await editor.announcements()).at(-1), key).toBe(said);
      expect(await page.evaluate(() => Math.round(window.scrollY)), key).toBe(scrolled);

      const before = await editor.texts();
      // Not Backspace on <body>: WebKit goes back in history on it (B13).
      await page.keyboard.type('Q');
      expect(await editor.texts(), key).toEqual(before);
      expect(
        before.filter((text) => text === 'Paragraph 10'),
        key,
      ).toHaveLength(key.endsWith('d') ? 2 : 0);
    }
  });

  /*
   * R10-RV-KEY-2, the reviewer's literal cases. Once the editor lets go of
   * focus, a Backspace lands on <body>, where WebKit goes back in history:
   * "Bravo" selected with a click and Escape, then a host reload from
   * Markdown (every id new) and Backspace; and p3's held Backspace under a
   * Markdown echo, whose repeats arrive on <body> straight after the press
   * that deleted. The page stays, and so does the document. Escape twice is
   * untouched (the reader left on purpose), so it is not asserted here.
   */
  test('B24 a Backspace after the editor let go of focus does not leave the page', async ({
    editor,
    page,
  }) => {
    const fiveParas = () => {
      const ed = window.__e2e.editor;
      ed.setDocument({
        blocks: (
          [
            ['a', 'Title'],
            ['p1', 'Alpha'],
            ['p2', 'Bravo'],
            ['p3', 'Charlie'],
            ['p4', 'Delta'],
          ] as const
        ).map(([id, text]) => ({ id, type: 'paragraph' as const, depth: 0, content: [{ text }] })),
      });
      ed.clearHistory();
    };

    for (const how of ['reload', 'held under an echo'] as const) {
      // A page to go back to.
      await page.goto('about:blank');
      await editor.load({ doc: 'empty' });
      await page.evaluate(fiveParas);
      if (how === 'held under an echo') {
        await page.evaluate(markdownEcho);
      }
      await editor.clickAt('p2', 2);
      await page.keyboard.press('Escape');
      expect(await editor.selected(), how).toEqual(['p2']);
      const url = page.url();

      if (how === 'reload') {
        await page.evaluate(() => {
          const { editor: ed, lib } = window.__e2e;
          ed.setDocument({ blocks: lib.blocksFromMarkdown(lib.toMarkdown(ed.getDocument())) });
        });
        expect(await editor.hasFocus(), how).toBe(false);
        const before = await editor.texts();
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);
        expect(page.url(), how).toBe(url);
        expect(await editor.texts(), how).toEqual(before);
      } else {
        await page.keyboard.down('Backspace');
        for (let repeat = 0; repeat < 4; repeat += 1) {
          await page.keyboard.down('Backspace');
        }
        await page.keyboard.up('Backspace');
        await page.waitForTimeout(300);
        expect(page.url(), how).toBe(url);
        expect(await editor.texts(), how).toEqual(['Title', 'Alpha', 'Charlie', 'Delta']);
      }
    }
  });

  /*
   * R11-KEY-2, p1's literal case (WebKit), in each mount: "Bravo" selected
   * with a click and Escape, a host reload from Markdown (the editor lets
   * go), then Backspace pressed afresh and held -- one keydown and four
   * repeats. The guard was kept only through a press that was itself a
   * repeat, so the fresh press spent it and the first repeat went back in
   * history. It holds until the key comes up. Navigation: e2e.
   */
  test('B25 a fresh Backspace held after the editor let go does not leave the page', async ({
    editor,
    page,
  }) => {
    for (const mount of ['plain', 'shadow', 'iframe', 'dialog'] as const) {
      const mounted =
        mount === 'iframe' ? new EditorPage(page, 0, page.frameLocator('#frame')) : editor;
      await page.goto('about:blank');
      await mounted.load({ doc: 'empty', mount });
      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        ed.setDocument({
          blocks: (
            [
              ['a', 'Title'],
              ['p1', 'Alpha'],
              ['p2', 'Bravo'],
              ['p3', 'Charlie'],
            ] as const
          ).map(([id, text]) => ({
            id,
            type: 'paragraph' as const,
            depth: 0,
            content: [{ text }],
          })),
        });
        ed.clearHistory();
      });
      await mounted.clickAt('p2', 2);
      await page.keyboard.press('Escape');
      const url = page.url();
      await page.evaluate(() => {
        const { editor: ed, lib } = window.__e2e;
        ed.setDocument({ blocks: lib.blocksFromMarkdown(lib.toMarkdown(ed.getDocument())) });
      });
      expect(await mounted.hasFocus(), mount).toBe(false);
      const before = await mounted.texts();

      await page.keyboard.down('Backspace');
      for (let repeat = 0; repeat < 4; repeat += 1) {
        await page.keyboard.down('Backspace');
      }
      await page.keyboard.up('Backspace');
      await page.waitForTimeout(300);
      expect(page.url(), mount).toBe(url);
      expect(await mounted.texts(), mount).toEqual(before);
    }
  });

  /*
   * R11-KEY-3, p3's literal case (WebKit): a host that reloads from Markdown
   * 0, 20 or 200 ms after each `change` (a debounced autosave), and a held
   * Backspace -- on a block selection of "Charlie", or at the end of
   * "Charlie". The press deleted and the caret was placed by id; the reload
   * then renamed every block, the focused host went with the render, focus
   * fell to <body> with nothing to guard it, and the repeats went back in
   * history. `setDocument` guards a focus it dropped onto the page.
   */
  test('B26 a held Backspace under a debounced reload does not leave the page', async ({
    editor,
    page,
  }) => {
    for (const delay of [0, 20, 200]) {
      for (const mode of ['blocks', 'text'] as const) {
        const label = `${delay}ms ${mode}`;
        await page.goto('about:blank');
        await editor.load({ doc: 'empty' });
        await page.evaluate((delay) => {
          const { editor: ed, lib } = window.__e2e;
          ed.setDocument({
            blocks: ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map((text) => ({
              id: text[0]!.toLowerCase(),
              type: 'paragraph' as const,
              depth: 0,
              content: [{ text }],
            })),
          });
          ed.clearHistory();
          ed.on('change', () =>
            setTimeout(
              () =>
                ed.setDocument(
                  { blocks: lib.blocksFromMarkdown(lib.toMarkdown(ed.getDocument())) },
                  { silent: true },
                ),
              delay,
            ),
          );
        }, delay);
        if (mode === 'blocks') {
          await editor.clickAt('c', 2);
          await page.keyboard.press('Escape');
        } else {
          await editor.clickAt('c', 7);
        }
        const url = page.url();

        await page.keyboard.down('Backspace');
        await page.waitForTimeout(Math.max(60, delay + 60));
        for (let repeat = 0; repeat < 3; repeat += 1) {
          await page.keyboard.down('Backspace');
          await page.waitForTimeout(35);
        }
        await page.keyboard.up('Backspace');
        await page.waitForTimeout(500);
        expect(page.url(), label).toBe(url);
      }
    }
  });

  /*
   * R11-KEY-4, p10's literal case: seventy blank paragraphs that Markdown
   * drops, "Pick me" between "Mike" and "Zulu", and the same three blocks
   * twice further down with a one-character "q" in the middle; a Markdown
   * echo, "Pick me" selected, and "q" typed over it. The content search
   * looked within 64 blocks of the same position in both documents, an old
   * "q" from beyond that window took the new one's place, and "Z" was typed
   * 49 blocks below. No block is looked for by content now: "q" is typed,
   * and the next key reaches no block.
   */
  test('B27 typing over a block far below dropped blank lines types into no old twin', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await page.evaluate(() => {
      const P = (id: string, text: string) => ({
        id,
        type: 'paragraph' as const,
        depth: 0,
        content: text ? [{ text }] : [],
      });
      const blocks = [];
      for (let i = 0; i < 70; i += 1) blocks.push(P(`blank${i}`, ''));
      blocks.push(P('m0', 'Mike'), P('x', 'Pick me'), P('z0', 'Zulu'));
      for (let i = 73; i < 119; i += 1) blocks.push(P(`f${i}`, `filler ${i}`));
      blocks.push(P('m1', 'Mike'), P('q1', 'q'), P('z1', 'Zulu'));
      for (let i = 122; i < 179; i += 1) blocks.push(P(`g${i}`, `more ${i}`));
      blocks.push(P('m2', 'Mike'), P('q2', 'q'), P('z2', 'Zulu'));
      const { editor: ed, lib } = window.__e2e;
      ed.setDocument({ blocks });
      ed.clearHistory();
      ed.on('change', () =>
        ed.setDocument(
          { blocks: lib.blocksFromMarkdown(lib.toMarkdown(ed.getDocument())) },
          { silent: true },
        ),
      );
    });
    await page.evaluate(() =>
      window.__e2e.editor.element
        .querySelector('[data-block-id="x"]')!
        .scrollIntoView({ block: 'center' }),
    );
    await editor.clickAt('x', 2);
    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual(['x']);

    await page.keyboard.press('q');
    await page.keyboard.type('Z');

    const texts = await editor.texts();
    expect(await editor.hasFocus()).toBe(false);
    expect(texts.slice(0, 3)).toEqual(['Mike', 'q', 'Zulu']);
    expect(texts.filter((text) => text === 'q')).toHaveLength(3);
    expect(texts.some((text) => text.includes('Z') && text !== 'Zulu')).toBe(false);
  });

  /*
   * R11-RV-KEY-2, q4's literal sequences (WebKit): "Bravo" with a click, and
   * Escape for a block selection or not, then a host reload from Markdown --
   * the editor lets go, or the focused block goes with the render -- and then
   * the keys. The guard was spent by the first Backspace's keyup or by any
   * other key, so a second press, "x" then Backspace, or ArrowDown then
   * Backspace went Back. It holds until focus or the pointer moves.
   */
  test('B28 after the editor let go, no later Backspace on the page leaves it', async ({
    editor,
    page,
  }) => {
    const sequences = {
      'a second press': ['Backspace', 'Backspace'],
      '"x" then Backspace': ['x', 'Backspace'],
      'ArrowDown then Backspace': ['ArrowDown', 'Backspace'],
      'Alt+Backspace': ['Alt+Backspace'],
      'Shift+Backspace': ['Shift+Backspace'],
    } as const;
    for (const arm of ['let go', 'block gone'] as const) {
      for (const [name, keys] of Object.entries(sequences)) {
        const label = `${arm}: ${name}`;
        await page.goto('about:blank');
        await editor.load({ doc: 'empty' });
        await page.evaluate(() => {
          const ed = window.__e2e.editor;
          ed.setDocument({
            blocks: ['Alpha', 'Bravo', 'Charlie'].map((text, i) => ({
              id: `p${i}`,
              type: 'paragraph' as const,
              depth: 0,
              content: [{ text }],
            })),
          });
          ed.clearHistory();
        });
        const url = page.url();
        await editor.clickAt('p1', 1);
        if (arm === 'let go') {
          await page.keyboard.press('Escape');
        }
        await page.evaluate(() => {
          const { editor: ed, lib } = window.__e2e;
          ed.setDocument({ blocks: lib.blocksFromMarkdown(lib.toMarkdown(ed.getDocument())) });
        });
        expect(await editor.hasFocus(), label).toBe(false);
        const before = await editor.texts();

        for (const key of keys) {
          await page.keyboard.press(key);
          await page.waitForTimeout(150);
        }
        expect(page.url(), label).toBe(url);
        expect(await editor.texts(), label).toEqual(before);
      }
    }
  });

  /*
   * R11-RV-KEY-2, q3's literal case (WebKit): a word typed over a block
   * selection under a Markdown echo, at once or 30 ms later. "q" made the
   * paragraph and the editor let go; "uick" landed on <body>, and its keys
   * spent the guard, so the Backspace the reader pressed at the missing
   * letters went Back.
   */
  test('B29 a word typed over a block selection under an echo, then Backspace, stays on the page', async ({
    editor,
    page,
  }) => {
    for (const host of ['sync', 'debounced'] as const) {
      await page.goto('about:blank');
      await editor.load({ doc: 'empty' });
      await page.evaluate((host) => {
        const { editor: ed, lib } = window.__e2e;
        ed.setDocument({
          blocks: ['Alpha', 'Bravo', 'Charlie'].map((text, i) => ({
            id: `p${i}`,
            type: 'paragraph' as const,
            depth: 0,
            content: [{ text }],
          })),
        });
        ed.clearHistory();
        const reload = () =>
          ed.setDocument(
            { blocks: lib.blocksFromMarkdown(lib.toMarkdown(ed.getDocument())) },
            { silent: true },
          );
        ed.on('change', host === 'sync' ? reload : () => setTimeout(reload, 30));
      }, host);
      const url = page.url();
      await editor.clickAt('p1', 1);
      await page.keyboard.press('Escape');
      for (const character of 'quick') {
        await page.keyboard.type(character);
        await page.waitForTimeout(60);
      }
      const before = await editor.texts();

      await page.keyboard.press('Backspace');
      await page.waitForTimeout(300);
      expect(page.url(), host).toBe(url);
      expect(await editor.texts(), host).toEqual(before);
    }
  });

  /*
   * R9-KEY-1's p19 case, decided again in round 10: selecting the divider a
   * peer left handed Delete a block nobody chose. The selection ends and focus
   * leaves the editor; the divider stays.
   */
  test('B13b a peer leaving only a divider selects nothing, and a delete removes nothing', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await page.evaluate(() =>
      window.__e2e.editor.setDocument({
        blocks: [
          { id: 'dv', type: 'divider', content: [], depth: 0 },
          { id: 'p', type: 'paragraph', content: [{ text: 'Para' }], depth: 0 },
        ],
      }),
    );
    await editor.clickAt('p', 2);
    await page.keyboard.press('Escape');
    expect(await editor.selected()).toEqual(['p']);

    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const doc = ed.getDocument();
      doc.blocks = doc.blocks.filter((block) => block.id !== 'p');
      ed.setDocument(doc);
    });
    expect(await editor.selected()).toEqual([]);
    expect(await editor.hasFocus()).toBe(false);

    await page.keyboard.press('Delete');
    expect((await editor.doc()).blocks.map((block) => block.type)).toEqual(['divider']);
  });

  /*
   * R9-KEY-2, p13's literal case: a caret in "d", Escape, Shift+↑ twice -- a
   * selection made upwards from d -- and a peer deleting d. The anchor passed
   * to the far end, so Shift+↑ shrank the selection instead of growing it.
   */
  test('B14 a peer deleting the anchor of a kept selection leaves Shift+Arrow going the same way', async ({
    editor,
    page,
  }) => {
    for (const [key, expected] of [
      ['Shift+ArrowUp', ['a', 'b', 'c']],
      ['Shift+ArrowDown', ['c']],
    ] as const) {
      await editor.load({ doc: 'empty' });
      await page.evaluate(() =>
        window.__e2e.editor.setDocument({
          blocks: ['a', 'b', 'c', 'd', 'e'].map((id) => ({
            id,
            type: 'paragraph' as const,
            depth: 0,
            content: [{ text: `Block ${id.toUpperCase()}` }],
          })),
        }),
      );
      await editor.clickAt('d', 2);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Shift+ArrowUp');
      await page.keyboard.press('Shift+ArrowUp');
      expect(await editor.selected()).toEqual(['b', 'c', 'd']);

      await page.evaluate(() => {
        const ed = window.__e2e.editor;
        const doc = ed.getDocument();
        doc.blocks.splice(3, 1);
        ed.setDocument(doc);
      });
      expect(await editor.selected()).toEqual(['b', 'c']);

      await page.keyboard.press(key);
      expect(await editor.selected(), key).toEqual([...expected]);
    }
  });

  /*
   * R9-KEY-6, p14's literal case: a table and then the selected paragraph,
   * deleted by a peer. "The end of the block before" resolved the table to
   * its first cell, and the next character went into the header. Since
   * R12-KEY-4 a peer deleting the selection hands no caret to anything, the
   * table included: the character reaches no cell.
   */
  test('B15 a peer deleting the paragraph after a table types into no cell of it', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'empty' });
    await page.evaluate(() => {
      const cell = (text: string) => [{ text }];
      window.__e2e.editor.setDocument({
        blocks: [
          { id: 'a', type: 'paragraph', content: [{ text: 'A' }], depth: 0 },
          {
            id: 't',
            type: 'table',
            content: [],
            depth: 0,
            rows: [
              [cell('h1'), cell('h2')],
              [cell('c1'), cell('c2')],
            ],
          },
          { id: 'p', type: 'paragraph', content: [{ text: 'Para' }], depth: 0 },
        ],
      });
    });
    await editor.clickAt('p', 2);
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const doc = ed.getDocument();
      doc.blocks = doc.blocks.filter((block) => block.id !== 'p');
      ed.setDocument(doc);
    });

    expect(await editor.hasFocus()).toBe(false);
    await page.keyboard.type('Q');
    expect((await editor.blockData('t'))?.rows).toEqual([
      [[{ text: 'h1' }], [{ text: 'h2' }]],
      [[{ text: 'c1' }], [{ text: 'c2' }]],
    ]);
  });

  /*
   * R12-KEY-4, p12's literal case: "Beta" selected with a click and Escape,
   * and a peer deleting it with every id kept. The caret went to the start of
   * "Gamma", by id -- a block the reader never chose -- and the key they
   * pressed for the selection edited it: Backspace "AlphaGamma", Delete
   * "amma", "x" "xGamma", Enter a paragraph above it. The root lets go, as
   * when no id survives, and Backspace on the page is guarded. In each mount.
   * Focus and real key routing: e2e.
   */
  test('B30 a peer deleting the selected block hands no caret to its neighbour', async ({
    editor,
    page,
  }) => {
    const fourParas = () =>
      window.__e2e.editor.setDocument({
        blocks: ['Alpha', 'Beta', 'Gamma', 'Delta'].map((text, i) => ({
          id: `b${i}`,
          type: 'paragraph' as const,
          depth: 0,
          content: [{ text }],
        })),
      });
    const peerDeletes = () => {
      const ed = window.__e2e.editor;
      const doc = ed.getDocument();
      doc.blocks.splice(1, 1);
      ed.setDocument(doc, { silent: true });
    };

    for (const key of ['Backspace', 'Delete', 'x', 'Enter'] as const) {
      await page.goto('about:blank');
      await editor.load({ doc: 'empty' });
      await page.evaluate(fourParas);
      const url = page.url();
      await editor.clickAt('b1', 2);
      await page.keyboard.press('Escape');
      expect(await editor.selected(), key).toEqual(['b1']);

      await page.evaluate(peerDeletes);
      expect(await editor.selection(), key).toBeNull();
      expect(await editor.hasFocus(), key).toBe(false);

      await page.keyboard.press(key);
      await page.waitForTimeout(250);
      expect(page.url(), key).toBe(url);
      expect(await editor.texts(), key).toEqual(['Alpha', 'Gamma', 'Delta']);
    }

    for (const mount of ['shadow', 'iframe', 'dialog'] as const) {
      const mounted =
        mount === 'iframe' ? new EditorPage(page, 0, page.frameLocator('#frame')) : editor;
      await page.goto('about:blank');
      await mounted.load({ doc: 'empty', mount });
      await page.evaluate(fourParas);
      const url = page.url();
      await mounted.clickAt('b1', 2);
      await page.keyboard.press('Escape');
      expect(await mounted.selected(), mount).toEqual(['b1']);

      await page.evaluate(peerDeletes);
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(250);
      await page.keyboard.type('x');
      expect(page.url(), mount).toBe(url);
      expect(await mounted.texts(), mount).toEqual(['Alpha', 'Gamma', 'Delta']);
    }
  });

  /*
   * R12-KEY-6, p11's literal case (WebKit): the editor in a modal <dialog>, a
   * block selection under a Markdown echo, "q" typed over it -- the editor
   * lets go -- then Tab and Backspace. WebKit's Tab, with nothing focused in
   * the dialog, focused the <dialog> element itself; the Tab spent the
   * guard and the Backspace there went back in history. The Tab key spends
   * nothing now, the focus it moves does, and a <dialog> is the page. The
   * other engines Tab into a block. Navigation: e2e.
   */
  test('B31 in a modal dialog, Tab after a let-go then Backspace stays on the page', async ({
    editor,
    page,
  }) => {
    await page.goto('about:blank');
    await editor.load({ doc: 'empty', mount: 'dialog' });
    await page.evaluate(() => {
      const ed = window.__e2e.editor;
      const lib = window.__e2e.lib;
      ed.setDocument({
        blocks: ['Alpha', 'Beta', 'Gamma'].map((text, i) => ({
          id: `b${i}`,
          type: 'paragraph' as const,
          depth: 0,
          content: [{ text }],
        })),
      });
      ed.on('change', (doc) =>
        ed.setDocument({ blocks: lib.blocksFromMarkdown(lib.toMarkdown(doc)) }, { silent: true }),
      );
    });
    const url = page.url();
    await editor.clickAt('b1', 2);
    await page.keyboard.press('Escape');
    await page.keyboard.type('q');
    expect(await editor.hasFocus()).toBe(false);
    const before = await editor.texts();

    await page.keyboard.press('Tab');
    const onDialog = await page.evaluate(() => document.activeElement?.localName === 'dialog');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);
    expect(page.url(), `focus on the dialog: ${onDialog}`).toBe(url);
    if (onDialog) {
      expect(await editor.texts()).toEqual(before);
    }
  });

  /*
   * R12-KEY-7, p5's literal case: "world" selected in the focused block with
   * Shift+←, and a peer putting "NEW " in front of it, same id. The render
   * rebuilt the block's children and the range fell to offset 0: "X" typed
   * next made "XNEW Hello world" in every engine and mount. The range is
   * carried by the text around each end. Where the text changed on both
   * sides of the caret, nothing says where the reader was: the block lets
   * go, and neither the next letter nor Backspace reaches anything. Typing
   * through the browser's own input: e2e.
   */
  test('B32 a peer rewriting the block the reader is in keeps their caret by the text around it', async ({
    editor,
    page,
  }) => {
    const one = (text: string) =>
      window.__e2e.editor.setDocument(
        { blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text }] }] },
        { silent: true },
      );

    for (const mount of ['plain', 'shadow', 'iframe'] as const) {
      const mounted =
        mount === 'iframe' ? new EditorPage(page, 0, page.frameLocator('#frame')) : editor;
      for (const [label, select, peer, typed] of [
        ['range after the edit', 5, 'NEW Hello world', 'NEW Hello X'],
        ['caret after the edit', 0, 'NEW Hello world', 'NEW Hello worldX'],
        ['caret before the edit', -1, 'Hello world, again', 'Hello worlXd, again'],
      ] as const) {
        const name = `${mount}: ${label}`;
        await mounted.load({ doc: 'empty', mount });
        await page.evaluate(one, 'Hello world');
        await mounted.content('z').click();
        await page.keyboard.press('End');
        if (select < 0) {
          await page.keyboard.press('ArrowLeft');
        }
        for (let i = 0; i < select; i += 1) await page.keyboard.press('Shift+ArrowLeft');

        await page.evaluate(one, peer);
        await page.keyboard.type('X');
        expect((await mounted.texts())[0], name).toBe(typed);
      }

      await page.goto('about:blank');
      await mounted.load({ doc: 'empty', mount });
      await page.evaluate(one, 'Hello world');
      const url = page.url();
      await mounted.clickAt('z', 5);
      await page.evaluate(one, 'Goodbye moon');
      expect(await mounted.hasFocus(), mount).toBe(false);
      await page.keyboard.type('X');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(300);
      expect(page.url(), mount).toBe(url);
      expect(await mounted.texts(), mount).toEqual(['Goodbye moon']);
    }
  });

  /*
   * R13-KEY-1, k6's literal cases (WebKit): "o" selected at the end of p2 (or
   * of cell 1:1), a click on a page button -- WebKit takes no focus for it
   * and keeps typing into the range from `<body>` -- then a peer's update
   * that takes the range's host away: p2 deleted, every id renamed, a row
   * added to the table, the table deleted. A host the update only redrew was
   * already guarded (R12-KEY-3); one it took away was not, and Backspace went
   * back in history in all four. In a dialog mount (the button in the
   * dialog) WebKit focuses the `<dialog>` instead of nothing, and neither
   * kind was guarded there. Other engines focus the button, where Backspace
   * does nothing. Navigation and WebKit's kept selection: e2e.
   */
  test('B33c a peer taking away the host of a range WebKit kept for a page button leaves no Backspace that leaves the page', async ({
    editor,
    page,
  }) => {
    const edits = [
      'block deleted',
      'every id renamed',
      'table row added',
      'table deleted',
      'block rewritten',
    ];
    for (const mount of ['plain', 'shadow', 'dialog'] as const) {
      for (const name of edits) {
        // Rewritten in place, R12-KEY-3 already guarded it, but not from a
        // modal dialog, where WebKit focuses the `<dialog>` for the button.
        if (name === 'block rewritten' && mount !== 'dialog') continue;
        const label = `${mount}: ${name}`;
        const table = name.startsWith('table');
        await page.goto('about:blank');
        await editor.load({ doc: table ? 'table' : 'paragraphs', mount });
        const url = page.url();
        await page.evaluate(() => {
          const button = document.createElement('button');
          button.id = 'host-button';
          button.textContent = 'Host button';
          (document.querySelector('#dialog') ?? document.body).prepend(button);
        });
        await (table ? editor.cell('tbl', 1, 1) : editor.content('p2')).click();
        await page.keyboard.press('End');
        await page.keyboard.press('Shift+ArrowLeft');
        await page.locator('#host-button').click();
        await page.evaluate((name) => {
          const ed = window.__e2e.editor;
          const doc = ed.getDocument();
          if (name === 'every id renamed') {
            doc.blocks.forEach((block, index) => {
              block.id = `n${index}`;
            });
          } else if (name === 'table row added') {
            doc.blocks[1]!.rows!.push([[{ text: 'c1' }], [{ text: 'c2' }], [{ text: 'c3' }]]);
          } else if (name === 'block rewritten') {
            doc.blocks[1]!.content = [{ text: 'NEW ' }, ...doc.blocks[1]!.content];
          } else {
            doc.blocks.splice(1, 1);
          }
          ed.setDocument(doc);
        }, name);
        const after = await editor.doc();

        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);
        expect(page.url(), label).toBe(url);
        expect(await editor.doc(), label).toEqual(after);
      }
    }
  });

  /*
   * R12-RV-KEY-1, a1b's literal case (Chromium): "Hello there world" typed,
   * the reader switches to another tab -- `document.hasFocus()` is false --
   * and a peer appends "!". Judged by window focus the reader was not typing,
   * the caret was dropped, and " you" typed after coming back went to offset
   * 0. The focus chain still names the block. Focus emulation is turned off
   * through CDP so the tab really is in the background: Chromium only (the
   * unit test pins the rule for every engine).
   */
  test('B34 a peer’s update while the tab is in the background keeps the caret', async ({
    playwright,
    browserName,
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'a background tab needs CDP focus emulation turned off');
    // The headless shell answers `hasFocus()` true for every page whatever is
    // in front; Chromium's new headless mode tracks the front tab.
    const browser = await playwright.chromium.launch({ channel: 'chromium' });
    const context = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      viewport: { width: 1100, height: 800 },
    });
    const page = await context.newPage();
    const editor = new EditorPage(page);
    try {
      await editor.load({ doc: 'empty' });
      await page.evaluate(() =>
        window.__e2e.editor.setDocument({
          blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text: 'Hello world' }] }],
        }),
      );
      await editor.clickAt('z', 5);
      await page.keyboard.type(' there');
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
      const other = await context.newPage();
      await other.goto('about:blank');
      await other.bringToFront();
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);

      await page.evaluate(() => {
        window.__e2e.editor.setDocument(
          {
            blocks: [
              { id: 'z', type: 'paragraph', depth: 0, content: [{ text: 'Hello there world!' }] },
            ],
          },
          { silent: true },
        );
      });
      await page.bringToFront();
      await page.keyboard.type(' you');

      expect(await editor.texts()).toEqual(['Hello there you world!']);
    } finally {
      await browser.close();
    }
  });

  /*
   * R12-RV-KEY-2, c3's and c5's literal cases (Chromium's IME through CDP):
   * composing "にほ" after "Hello", a peer's update to the same block landing
   * mid-composition -- text after it, before it, or its marks -- then the
   * candidate committed as "日本" and more typed. The peer's text has no
   * "にほ" (it is not committed, and no `change` carried it), so both sides of
   * the caret looked changed and the block let go mid-word: "日本" and what
   * followed were lost. The composition is carried from where it began and
   * the browser commits it there. Firefox and WebKit have no IME a test can
   * drive; the carry is pinned for them in selection-modes.test.ts.
   */
  test('B35 a peer’s update to the block mid-composition loses no composed text', async ({
    editor,
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'IME composition is driven through CDP');
    for (const [peer, expected] of [
      ['Hello world!', 'Hello日本go world!'],
      ['NEW Hello world', 'NEW Hello日本go world'],
      ['Hey there', 'He日本goy there'],
    ] as const) {
      await editor.load({ doc: 'empty' });
      const cdp = await context.newCDPSession(page);
      await page.evaluate(() =>
        window.__e2e.editor.setDocument({
          blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text: 'Hello world' }] }],
        }),
      );
      await editor.clickAt('z', 5);
      await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
      await cdp.send('Input.imeSetComposition', {
        text: 'にほ',
        selectionStart: 2,
        selectionEnd: 2,
      });
      await page.evaluate((text) => {
        window.__e2e.editor.setDocument(
          { blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text }] }] },
          { silent: true },
        );
      }, peer);
      expect(await editor.hasFocus(), peer).toBe(true);

      await cdp.send('Input.imeSetComposition', {
        text: 'にほん',
        selectionStart: 3,
        selectionEnd: 3,
      });
      await cdp.send('Input.insertText', { text: '日本' });
      await page.keyboard.type('go');
      expect(await editor.texts(), peer).toEqual([expected]);

      // Undone, the composed word goes and the caret goes back to where the
      // composition was carried: the next letter lands there, not at 0.
      await page.keyboard.press(`${MOD}+z`);
      await page.keyboard.press(`${MOD}+z`);
      await page.keyboard.type('Z');
      const at = expected.indexOf('日本');
      expect(await editor.texts(), `${peer}, undone`).toEqual([
        `${peer.slice(0, at)}Z${peer.slice(at)}`,
      ]);
      await cdp.detach();
    }
  });

  /*
   * R12-RV-KEY-3 and -4a, c1's literal rows: the caret at 5 in "Hello world"
   * and a peer turning the paragraph into a heading (same id; same text, or
   * "!" added), or deleting "lo wo" around the caret. The heading's host is a
   * new element, and the caret fell to <body>; the deletion changed both
   * sides of the caret, and the block let go. The new host takes the caret,
   * carried; a deletion puts it where the deleted text was. Typing: e2e.
   */
  test('B36 a peer’s heading or deletion around the caret keeps it in the block', async ({
    editor,
    page,
  }) => {
    for (const mount of ['plain', 'shadow', 'iframe'] as const) {
      const mounted =
        mount === 'iframe' ? new EditorPage(page, 0, page.frameLocator('#frame')) : editor;
      for (const [label, type, text, typed] of [
        ['to heading', 'heading1', 'Hello world', 'HelloX world'],
        ['to heading, text added', 'heading1', 'Hello world!', 'HelloX world!'],
        ['deleted around', 'paragraph', 'Helrld', 'HelXrld'],
      ] as const) {
        const name = `${mount}: ${label}`;
        await mounted.load({ doc: 'empty', mount });
        await page.evaluate(() =>
          window.__e2e.editor.setDocument({
            blocks: [
              { id: 'a', type: 'paragraph', depth: 0, content: [{ text: 'Before' }] },
              { id: 'z', type: 'paragraph', depth: 0, content: [{ text: 'Hello world' }] },
            ],
          }),
        );
        await mounted.clickAt('z', 5);
        await page.evaluate(
          ([type, text]) =>
            window.__e2e.editor.setDocument(
              {
                blocks: [
                  { id: 'a', type: 'paragraph', depth: 0, content: [{ text: 'Before' }] },
                  { id: 'z', type, depth: 0, content: [{ text }] },
                ],
              },
              { silent: true },
            ),
          [type, text] as const,
        );
        await page.keyboard.type('X');
        expect((await mounted.blockData('z'))?.type, name).toBe(type);
        expect((await mounted.texts())[1], name).toBe(typed);
      }
    }
  });

  /*
   * R12-RV-KEY-1's other half, in an iframe mount: the reader left the block
   * for a field in the page around the frame. The focus chain says they are
   * not typing in the block, so a peer's update to it drops its range rather
   * than carrying it -- setting a selection in the block must not pull focus
   * out of the field (R11-KEY-1) -- and the reader's keys stay in the field.
   * Real focus across frames: e2e.
   */
  test('B33b a peer redrawing the block an iframe mount left for an outer field pulls no focus', async ({
    page,
  }) => {
    const editor = new EditorPage(page, 0, page.frameLocator('#frame'));
    await editor.load({ doc: 'empty', mount: 'iframe' });
    await page.evaluate(() =>
      window.__e2e.editor.setDocument({
        blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text: 'Hello world' }] }],
      }),
    );
    await editor.clickAt('z', 5);
    await page.locator('#before').click();
    await page.evaluate(() =>
      window.__e2e.editor.setDocument(
        {
          blocks: [
            { id: 'z', type: 'paragraph', depth: 0, content: [{ text: 'NEW Hello world' }] },
          ],
        },
        { silent: true },
      ),
    );
    // Dropped, not carried. (Measured, every engine also moves the frame's
    // own `activeElement` to its <body> when the page around it takes focus,
    // so the frame half of the focus chain agrees here; it is what decides
    // where a frame document still names the block.)
    expect(await editor.selection()).toBeNull();

    await page.keyboard.type('ab');
    await expect(page.locator('#before')).toBeFocused();
    await expect(page.locator('#before')).toHaveValue('ab');
    expect(await editor.texts()).toEqual(['NEW Hello world']);
  });

  /*
   * R12-RV2-KEY-1, p1's literal case: "X😀😁😂Y" with the caret after "😀"
   * (two → from the start), and a peer leaving "X😂Y". The carry counted in
   * UTF-16 code units and put the caret between the halves of "😂": Firefox
   * typed "Q" there and wrote two lone surrogates into the model; Chromium and
   * WebKit put it after the emoji. The caret goes before "😂", in every engine,
   * and the model never holds half a character. Typing: e2e.
   */
  test('B32b a peer deleting emoji around the caret types no lone surrogate', async ({
    editor,
    page,
  }) => {
    for (const [label, start, steps, peer, typed] of [
      ['emoji', 'X😀😁😂Y', 2, 'X😂Y', 'XQ😂Y'],
      ['flags', 'X🇫🇷🇺🇸🇺🇦Y', 2, 'X🇺🇦Y', 'XQ🇺🇦Y'],
      ['marks', 'Xe\u0301e\u0300e\u0302Y', 2, 'Xe\u0302Y', 'XQe\u0302Y'],
    ] as const) {
      await editor.load({ doc: 'empty' });
      await page.evaluate(
        (text) =>
          window.__e2e.editor.setDocument({
            blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text }] }],
          }),
        start,
      );
      await editor.clickAt('z', 0);
      for (let i = 0; i < steps; i += 1) await page.keyboard.press('ArrowRight');
      await page.evaluate(
        (text) =>
          window.__e2e.editor.setDocument(
            { blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text }] }] },
            { silent: true },
          ),
        peer,
      );
      await page.keyboard.type('Q');

      const text = (await editor.texts())[0]!;
      expect(/[\ud800-\udfff]/u.test(text.replace(/[\u{10000}-\u{10ffff}]/gu, '')), label).toBe(
        false,
      );
      expect(text.normalize('NFC'), label).toBe(typed.normalize('NFC'));
    }
  });

  /*
   * R12-RV3-KEY-1, g1's and g2's literal cases: a peer adding a mark to the
   * character just before the reader's caret -- a Devanagari matra, a
   * combining accent, a skin tone -- or to the character a range covers.
   * Snapped back, the caret went before the reader's own character and "Q"
   * split their word ("नQमाY"); the range collapsed. A kept offset goes past
   * the whole extended character, and a range covers it. Typing: e2e.
   */
  test('B32c a peer adding a mark to the character before the caret leaves the caret after it', async ({
    editor,
    page,
  }) => {
    for (const [label, start, at, extend, peer, typed] of [
      ['matra, caret', 'नमY', 2, 0, 'नमाY', 'नमाQY'],
      ['accent, caret', 'XeY', 2, 0, 'Xe\u0301Y', 'Xe\u0301QY'],
      ['skin tone, caret', 'X👍Y', 2, 0, 'X👍🏽Y', 'X👍🏽QY'],
      ['accent, range', 'XeY', 1, 1, 'Xe\u0301Y', 'XQY'],
      // And the boundary right before an emoji or a flag, where WebKit's
      // `containing()` answers the character before: a prepend moved the
      // caret back over "X" in WebKit alone ("NQX😀Y").
      ['emoji after the caret, peer prepends', 'X😀Y', 1, 0, 'NX😀Y', 'NXQ😀Y'],
      ['flag after the caret, peer prepends', 'X🇺🇸Y', 1, 0, 'NX🇺🇸Y', 'NXQ🇺🇸Y'],
      ['emoji after a deletion around the caret', 'Xab😀Y', 2, 0, 'X😀Y', 'XQ😀Y'],
    ] as const) {
      await editor.load({ doc: 'empty' });
      await page.evaluate(
        (text) =>
          window.__e2e.editor.setDocument({
            blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text }] }],
          }),
        start,
      );
      await editor.clickAt('z', 0);
      for (let i = 0; i < at; i += 1) await page.keyboard.press('ArrowRight');
      for (let i = 0; i < extend; i += 1) await page.keyboard.press('Shift+ArrowRight');
      await page.evaluate(
        (text) =>
          window.__e2e.editor.setDocument(
            { blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text }] }] },
            { silent: true },
          ),
        peer,
      );
      await page.keyboard.type('Q');
      expect((await editor.texts())[0], label).toBe(typed);
    }
  });

  /*
   * R12-RV4-KEY-1, g1's literal steps (Firefox): "कमल end", the caret after
   * "क", a virama typed -- Firefox leaves the caret at 2, inside "क्म" -- or
   * Backspace on the consonant after a virama; then a peer appending "!" and
   * "र" typed. The carry snapped the caret out of the cluster and "र" went
   * after "म". The caret is wherever the reader's own keys left it, in every
   * engine: the peer's edit moves it by exactly the text put in before it,
   * and the letter lands where it lands with no peer at all.
   */
  test('B32d a peer’s edit far from a caret the reader left inside a character moves it nowhere', async ({
    editor,
    page,
  }) => {
    // Typed the same way with no peer, and the peer's edit applied to that:
    // where each engine's own typing puts the letter (WebKit puts it after
    // the cluster from inside it) is the engine's; the peer must not change it.
    const typedAfter = async (start: string, edit: string, peer: string | null) => {
      await editor.load({ doc: 'empty' });
      await page.evaluate(
        (text) =>
          window.__e2e.editor.setDocument({
            blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text }] }],
          }),
        start,
      );
      await editor.clickAt('z', 0);
      await page.keyboard.press('ArrowRight');
      if (edit === 'type') {
        await page.keyboard.type('\u094D');
      } else {
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Backspace');
      }
      const at = (await editor.selection())!.range;
      if (peer !== null) {
        const text = (await editor.texts())[0]!;
        const next = peer === 'append' ? `${text}!` : `! ${text}`;
        await page.evaluate(
          (text) =>
            window.__e2e.editor.setDocument(
              { blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text }] }] },
              { silent: true },
            ),
          next,
        );
        const shift = peer === 'append' ? 0 : 2;
        expect((await editor.selection())?.range, `${start} ${edit} ${peer}`).toEqual({
          start: at.start + shift,
          end: at.end + shift,
        });
      }
      await page.keyboard.type('र');
      return (await editor.texts())[0]!;
    };

    for (const [start, edit] of [
      ['कमल end', 'type'],
      ['क्षल end', 'backspace'],
    ] as const) {
      const alone = await typedAfter(start, edit, null);
      expect(await typedAfter(start, edit, 'append'), `${start} ${edit}`).toBe(`${alone}!`);
      expect(await typedAfter(start, edit, 'prepend'), `${start} ${edit}`).toBe(`! ${alone}`);
    }
  });

  /*
   * R12-RV5-KEY-1 and -2, j1's and j2's literal steps: → by whole characters
   * from the block's start, Shift+→ for a range, and a peer's edit that joins
   * the reader's text on both sides of the caret or the range's start into
   * one character -- a deletion between them, or a virama or ZWJ inserted
   * there. The snap moved the end over the reader's own text: the range grew
   * back over "🇺" and "Q" deleted it ("aQ"); the caret jumped forward over
   * "म". The end is not moved now, in every engine (asserted on the editor's
   * selection), and a range typed over keeps the reader's other text in
   * every engine. A caret left inside a character is typed at by the engine:
   * Firefox types there; Chromium and WebKit type at the character's end
   * (the README's documented limit), so the caret's typing is pinned in
   * Firefox.
   */
  test('B32e a peer’s edit that joins the reader’s text across the caret moves the caret over none of it', async ({
    editor,
    page,
    browserName,
  }) => {
    for (const [label, start, right, extend, peer, at, typed] of [
      ['devanagari range', 'abक्मलcd', 3, 2, 'abक्लcd', [4, 6], 'abक्Qd'],
      ['flag range', 'a🇺x🇸b', 3, 2, 'a🇺🇸b', [3, 6], 'a🇺Q'],
      ['virama inserted, range', 'abकमलcd', 3, 1, 'abक\u094dमलcd', [4, 5], 'abक\u094dQलcd'],
      ['devanagari caret', 'abक्मलcd', 3, 0, 'abक्लcd', [4, 4], 'abक्Qलcd'],
      ['flag caret', 'a🇺x🇸b', 3, 0, 'a🇺🇸b', [3, 3], 'a🇺Q🇸b'],
      ['virama inserted, caret', 'abकमलcd', 3, 0, 'abक\u094dमलcd', [3, 3], 'abकQ\u094dमलcd'],
    ] as const) {
      await editor.load({ doc: 'empty' });
      await page.evaluate(
        (text) =>
          window.__e2e.editor.setDocument({
            blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text }] }],
          }),
        start,
      );
      await editor.clickAt('z', 0);
      for (let i = 0; i < right; i += 1) await page.keyboard.press('ArrowRight');
      for (let i = 0; i < extend; i += 1) await page.keyboard.press('Shift+ArrowRight');
      await page.evaluate(
        (text) =>
          window.__e2e.editor.setDocument(
            { blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text }] }] },
            { silent: true },
          ),
        peer,
      );
      expect((await editor.selection())?.range, label).toEqual({ start: at[0], end: at[1] });
      if (extend > 0 || browserName === 'firefox') {
        await page.keyboard.type('Q');
        expect((await editor.texts())[0], label).toBe(typed);
      }
    }
  });

  /*
   * R12-RV6-KEY-1, n1's, n2's and n3's literal steps: a range in repeated
   * text -- the second "ha" of "ha ha ha!" (made forward, or backward with
   * Shift+←), the third of four dots, a space in a run, an emoji in a run --
   * and a peer deleting one of the repeats, through `setDocument` or across a
   * lock. Each end was carried by its own reading of the edit, the range grew
   * over text the reader never selected, and "Q" deleted it ("Q!", "a.Qb").
   * R12-RV7-KEY-1/-2: read once, from the common prefix, a "w" the peer typed
   * before a selected "world" went inside it ("hello Q"), and a duplicate
   * removed took the reader's "the" ("Q cat"). The range is now what every
   * reading of the edit agrees on: no unselected text, no peer text at an
   * edge, and selected text left behind where the edit is ambiguous.
   */
  test('B32f a peer’s edit in repeated text takes no unselected text and no peer text at an edge', async ({
    editor,
    page,
  }) => {
    for (const [label, start, right, extend, peer, wanted, lock] of [
      // Since R12-RV7-KEY-2 the range is what every reading of the deletion
      // agrees on: where the deleted text could have been the selection
      // itself, a caret where it began -- selected text left behind, none
      // taken that was not selected.
      ['laughter', 'ha ha ha!', 3, 2, 'ha ha!', ['ha Qha!'], false],
      ['laughter, backward', 'ha ha ha!', 5, -2, 'ha ha!', ['ha Qha!'], false],
      ['laughter, across a lock', 'ha ha ha!', 3, 2, 'ha ha!', ['ha Qha!'], true],
      ['dots', 'a....b', 3, 1, 'a...b', ['a..Q.b'], false],
      ['spaces', 'x    y', 3, 1, 'x   y', ['x  Q y'], false],
      ['indentation', 'if x:    y', 7, 1, 'if x:   y', ['if x:  Q y'], false],
      ['emoji run', 'a👍👍👍b', 3, 1, 'a👍👍b', ['a👍👍Qb'], false],
      // R12-RV7-KEY-1, n5: the peer's text typed at the range's start stays
      // outside it, one key at a time or all at once, forward or backward.
      ['"w" typed before "world"', 'hello world', 6, 5, 'hello wworld', ['hello wQ'], false],
      ['"w" before "world", backward', 'hello world', 11, -5, 'hello wworld', ['hello wQ'], false],
      [
        '"wide " typed before "world"',
        'hello world',
        6,
        5,
        'hello wide world',
        ['hello wide Q'],
        false,
      ],
      ['"1" typed before "10"', 'Total: 10', 7, 2, 'Total: 110', ['Total: 1Q'], false],
      // R12-RV7-KEY-2, n4 and n7: a deletion takes no unselected text.
      ['the duplicate "the " removed', 'the the cat', 4, 3, 'the cat', ['the Qcat'], false],
      ['the third "ha", " ha" removed', 'ha ha ha!', 6, 2, 'ha ha!', ['ha haQ!'], false],
      ['trailing spaces', 'b b   ', 0, 5, 'b b ', ['Q '], false],
      // R12-RV8-KEY-1, v1 and v2: readings that cut a surrogate pair are
      // none, since no editor's edit makes one. The deleted 👍 and 👋 share
      // their first code unit with the 😀 after them, and the range lost its
      // 😀. A character is not asked about: a peer's own Backspace can take one
      // code point of a letter and its mark, a conjunct or a syllable's jamo,
      // so "é" less the "á" after it can be "e" and "́a" less, and only
      // what both readings keep is replaced -- the reader's mark, vowel sign
      // or final jamo is left over. That is the decided price, not a defect.
      ['"😀!" selected, 👍 deleted', 'ok 👍😀!', 4, 2, 'ok 😀!', ['ok Q'], false],
      ['"😀!" selected, 👍 deleted, across a lock', 'ok 👍😀!', 4, 2, 'ok 😀!', ['ok Q'], true],
      ['"😀 there" selected, 👋 deleted', 'Hi 👋😀 there', 4, 7, 'Hi 😀 there', ['Hi Q'], false],
      ['NFD é selected, á deleted', 'éáb', 0, 1, 'éb', ['Q́b'], false],
      ['NFD è selected, é deleted', 'éè', 1, 1, 'è', ['eQ'], false],
      ['कु selected, कि deleted', 'किकु', 1, 1, 'कु', ['कQ'], false],
      ['jamo 각 selected, 가 deleted', '가각', 1, 1, '각', ['가Q'], false],
      // R12-RV9-KEY-2: a tie between two readings of an insertion is nothing
      // of the range, a caret before every place the text could have gone.
      ['"ha" selected, the peer making it "haha"', 'ha', 0, 2, 'haha', ['Qhaha'], false],
      ['"ab" selected, the peer making it "abab"', 'ab', 0, 2, 'abab', ['Qabab'], false],
      ['" x" selected, the peer making it " x x"', ' x', 0, 2, ' x x', ['Q x x'], false],
      // R12-RV9-KEY-1: the peer completing a lone surrogate into a pair.
      [
        '"b\ud83d" selected, its lone surrogate completed',
        'ab\ud83d',
        1,
        2,
        'ab😀b\ud83d',
        ['aQb😀b\ud83d'],
        false,
      ],
      // R12-RV10-KEY-1: a tie no reading puts inside the peer's text stays
      // where the readings meet, forward, backward and across a lock.
      [
        'one "0" of "1000000" selected, a "0" typed',
        '1000000',
        5,
        1,
        '10000000',
        ['100000Q00'],
        false,
      ],
      ['the same, backward', '1000000', 6, -1, '10000000', ['100000Q00'], false],
      ['the same, across a lock', '1000000', 5, 1, '10000000', ['100000Q00'], true],
      ['the second "l" of "hello", an "l" typed', 'hello', 2, 1, 'helllo', ['helQllo'], false],
      [
        'the last "😂" selected, a "😂" typed',
        'lol 😂😂😂',
        6,
        1,
        'lol 😂😂😂😂',
        ['lol 😂😂😂Q😂'],
        false,
      ],
      // R12-RV10-KEY-2: the caret before every reading is never inside a
      // character; put back by code point, Firefox split the reader's "á".
      ['NFD "e" after "á" selected, "é" typed', 'áe', 1, 1, 'áée', ['Qáée'], false],
      ['the same, backward', 'áe', 2, -1, 'áée', ['Qáée'], false],
      ['the same, across a lock', 'áe', 1, 1, 'áée', ['Qáée'], true],
    ] as const) {
      await editor.load({ doc: 'empty' });
      await page.evaluate(
        (text) =>
          window.__e2e.editor.setDocument({
            blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text }] }],
          }),
        start,
      );
      await editor.clickAt('z', 0);
      for (let i = 0; i < right; i += 1) await page.keyboard.press('ArrowRight');
      for (let i = 0; i < Math.abs(extend); i += 1) {
        await page.keyboard.press(extend > 0 ? 'Shift+ArrowRight' : 'Shift+ArrowLeft');
      }
      await page.evaluate(
        ([text, lock]) => {
          const ed = window.__e2e.editor;
          if (lock) ed.setEditable(false);
          ed.setDocument(
            { blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text }] }] },
            { silent: true },
          );
          if (lock) ed.setEditable(true);
        },
        [peer, lock] as const,
      );
      await page.keyboard.type('Q');
      expect(wanted, label).toContain((await editor.texts())[0]);
    }
  });

  /*
   * R12-RV10-KEY-2, t2's Devanagari row: "कि" (the second consonant and its
   * vowel sign) selected in "्किक" and the peer making it "्किकििक". The
   * caret before every reading of that insertion was put back by code point
   * between "क" and "ि", where Firefox typed into the character and WebKit at
   * its end, in the peer's text; it goes to the character's start. Chromium
   * is skipped: its arrows cannot make this selection -- in t2 they moved
   * over the whole "्किक" at once (a caret at 4 forward, at 0 backward) and
   * never selected the last "क" alone.
   */
  test('B32g the caret before every reading of an insertion is not inside a character', async ({
    editor,
    page,
    browserName,
  }) => {
    test.skip(browserName === 'chromium', 'Chromium’s arrows cannot select the last "क" alone');
    for (const lock of [false, true]) {
      await editor.load({ doc: 'empty' });
      await page.evaluate(() =>
        window.__e2e.editor.setDocument({
          blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text: '्किक' }] }],
        }),
      );
      // As t2 made it: to the block's start by ←, then by →.
      await editor.clickAt('z', 0);
      for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowLeft');
      for (let i = 0; i < 2; i += 1) await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Shift+ArrowRight');
      expect(await page.evaluate(() => window.__e2e.editor.getSelectionState()?.range)).toEqual({
        start: 3,
        end: 4,
      });
      await page.evaluate((locked) => {
        const ed = window.__e2e.editor;
        if (locked) ed.setEditable(false);
        ed.setDocument(
          {
            blocks: [
              {
                id: 'z',
                type: 'paragraph',
                depth: 0,
                content: [{ text: '्किकििक' }],
              },
            ],
          },
          { silent: true },
        );
        if (locked) ed.setEditable(true);
      }, lock);
      await page.keyboard.type('Q');
      expect((await editor.texts())[0], `lock: ${lock}`).toBe('्Qकिकििक');
    }
  });

  /*
   * R12-RV11-KEY-1, t4's literal keys: "क्" typed before "म", the "म"
   * selected -- a range that starts inside the reader's own character -- and
   * the peer making "क्म" "क्म्म". Nothing of the range is left, and the
   * caret goes to the character's start ("Qक्म्म"); left where the reader's
   * keys put it, Q split the character ("कQ्म्म"). Firefox only: the other
   * engines' arrows cannot put a range start there.
   */
  test('B32h a range from inside the reader’s own character collapses to its start', async ({
    editor,
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'firefox', 'only Firefox’s arrows start a range inside "क्म"');
    for (const lock of [false, true]) {
      await editor.load({ doc: 'empty' });
      await page.evaluate(() =>
        window.__e2e.editor.setDocument({
          blocks: [{ id: 'z', type: 'paragraph', depth: 0, content: [{ text: 'म' }] }],
        }),
      );
      await editor.clickAt('z', 0);
      for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowLeft');
      await page.keyboard.type('क्');
      await page.keyboard.press('Shift+ArrowRight');
      expect(await page.evaluate(() => window.__e2e.editor.getSelectionState()?.range)).toEqual({
        start: 2,
        end: 3,
      });
      await page.evaluate((locked) => {
        const ed = window.__e2e.editor;
        if (locked) ed.setEditable(false);
        ed.setDocument(
          {
            blocks: [
              {
                id: 'z',
                type: 'paragraph',
                depth: 0,
                content: [{ text: 'क्म्म' }],
              },
            ],
          },
          { silent: true },
        );
        if (locked) ed.setEditable(true);
      }, lock);
      await page.keyboard.type('Q');
      expect((await editor.texts())[0], `lock: ${lock}`).toBe('Qक्म्म');
    }
  });

  /*
   * R12-KEY-3, p7's literal case. AP8b's five-run block, the caret at its end
   * or the last four characters selected, a click on a button in the page,
   * and a peer prefixing the block with "NEW " (same id). WebKit focuses no
   * button: it left focus on <body> and the selection in the block, and
   * types into it from there -- but after the redraw its anchor said
   * `DIV:4` while its range said `DIV:0`, the editor read 0..0, and "X",
   * Backspace and Enter all went into "bold two". The range goes with the
   * redraw, Backspace on the page is guarded, and nothing reaches the
   * document. An update to another block leaves the range, which the keys
   * still act on as with no update at all (AP9). Real WebKit selection: e2e.
   */
  test('B33 a peer redrawing the block a page button left a range in drops it', async ({
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
    for (const key of ['X', 'Backspace', 'Enter'] as const) {
      for (const sel of ['caret', 'range'] as const) {
        const label = `${key}, ${sel}`;
        await page.goto('about:blank');
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
          button.textContent = 'Host';
          document.body.prepend(button);
        }, content);
        const url = page.url();
        await editor.content('z').click();
        await page.keyboard.press(`${MOD}+ArrowDown`);
        await page.keyboard.press('End');
        if (sel === 'range') {
          for (let i = 0; i < 4; i += 1) await page.keyboard.press('Shift+ArrowLeft');
        }
        await page.locator('#host-button').click();
        const after = await page.evaluate(() => {
          const ed = window.__e2e.editor;
          const doc = ed.getDocument();
          doc.blocks[1]!.content = [{ text: 'NEW ' }, ...doc.blocks[1]!.content];
          ed.setDocument(doc, { silent: true });
          return ed.getDocument().blocks.map((block) => window.__e2e.lib.blockText(block));
        });
        expect(await editor.selection(), label).toBeNull();

        await page.keyboard.press(key);
        await page.waitForTimeout(250);
        expect(page.url(), label).toBe(url);
        expect(await editor.texts(), label).toEqual(after);
      }
    }
  });

  /*
   * A drag across blocks that overshoots the editor in one quick move, over
   * the page's own text (review 9). R14-RV9-1: WebKit re-anchors its own
   * drag selection in that text, and the range was taken for one the reader
   * began outside the editor, so the blocks went while the button was still
   * down and the release selected nothing; round 13 kept them. Only a press
   * outside the editor makes a range begun outside it.
   */
  test('B37 a drag across blocks carried out over the page’s text keeps its blocks', async ({
    editor,
    page,
  }) => {
    for (const mount of ['plain', 'shadow'] as const) {
      for (const editable of [true, false]) {
        const label = `${mount}, ${editable ? 'editable' : 'read-only'}`;
        await editor.load({ doc: 'five', toolbar: 0, editable, mount });
        const a = await editor.pointAt(editor.content('b'), 2);
        const d = await editor.pointAt(editor.content('d'), 4);
        await page.mouse.move(a.x, a.y);
        await page.mouse.down();
        await page.mouse.move(a.x + 20, a.y, { steps: 3 });
        await page.mouse.move(d.x, d.y, { steps: 8 });
        await editor.settle();
        expect(await editor.selected(), `${label}, over d`).toEqual(['b', 'c', 'd']);
        await page.mouse.move(1095, 795, { steps: 8 });
        await editor.settle();
        expect(await editor.selected(), `${label}, held outside`).toEqual(
          expect.arrayContaining(['b', 'c', 'd']),
        );
        await page.mouse.up();
        await editor.settle();
        expect(await editor.selected(), `${label}, released`).toEqual(
          expect.arrayContaining(['b', 'c', 'd']),
        );
      }
    }
  });
});
