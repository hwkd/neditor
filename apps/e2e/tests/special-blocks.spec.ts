import { expect, MOD, test } from '../helpers/test.ts';

test.describe('14 · to-do, toggle, callout', () => {
  test('K1 the checkbox toggles without moving the caret, is announced, styled and undoable', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'lists' });
    await editor.placeCaret('b1', 3);
    const checkbox = editor.block('t1').locator('.neditor-block__checkbox');
    await checkbox.click();
    expect((await editor.blockData('t1'))?.checked).toBe(true);
    await expect(checkbox).toHaveAttribute('aria-checked', 'true');
    await expect(editor.liveRegion).toHaveText('Checked');
    // The caret did not follow the click.
    expect(await editor.selection()).toMatchObject({ blockId: 'b1', range: { start: 3, end: 3 } });
    const decoration = await editor
      .content('t1')
      .evaluate((element) => getComputedStyle(element).textDecorationLine);
    expect(decoration).toContain('line-through');

    await page.keyboard.press(`${MOD}+z`);
    expect((await editor.blockData('t1'))?.checked).toBe(false);
    await checkbox.click();
    await checkbox.click();
    await expect(editor.liveRegion).toHaveText('Unchecked');
  });

  test('K2 collapsing hides children from the DOM; a caret inside moves to the toggle', async ({
    editor,
  }) => {
    await editor.load({ doc: 'toggle-open' });
    await editor.placeCaret('child2', 3);
    const chevron = editor.block('tg').locator('.neditor-block__chevron');
    await expect(chevron).toHaveAttribute('aria-expanded', 'true');
    await chevron.click();
    await expect(chevron).toHaveAttribute('aria-expanded', 'false');
    await expect(editor.block('child1')).toHaveCount(0);
    await expect(editor.block('child2')).toHaveCount(0);
    await expect(editor.block('tg')).toHaveAttribute('data-collapsed', 'true');
    expect(await editor.selection()).toMatchObject({
      blockId: 'tg',
      range: { start: 11, end: 11 },
    });
    // Still in the document, just not drawn.
    expect(await editor.ids()).toEqual(['before', 'tg', 'child1', 'child2', 'after']);

    await chevron.click();
    await expect(editor.block('child2')).toBeVisible();
  });

  test('K3 the chevron and the callout icon are tab stops that Enter and Space operate', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'kitchen-sink' });
    const chevron = editor.block('tg').locator('.neditor-block__chevron');
    const icon = editor.block('co').locator('.neditor-block__icon');
    await expect(chevron).toHaveAttribute('tabindex', '0');
    await expect(icon).toHaveAttribute('tabindex', '0');

    await chevron.focus();
    await page.keyboard.press('Enter');
    await expect(chevron).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Space');
    await expect(chevron).toHaveAttribute('aria-expanded', 'true');

    await icon.focus();
    await page.keyboard.press('Space');
    await expect(editor.portal('icon-picker')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('K4 icon picker: presets, a custom first grapheme, empty dismisses, Escape returns the caret', async ({
    editor,
    page,
  }) => {
    await editor.load({ doc: 'callout' });
    const icon = editor.block('co').locator('.neditor-block__icon');
    const picker = editor.portal('icon-picker');

    await editor.clickControl(icon);
    await expect(picker).toBeVisible();
    await expect(picker).toHaveAttribute('role', 'dialog');
    const pickerBox = (await picker.boundingBox())!;
    const iconBox = (await icon.boundingBox())!;
    expect(pickerBox.y).toBeGreaterThanOrEqual(iconBox.y + iconBox.height - 1);
    const input = picker.getByRole('textbox', { name: 'Custom icon' });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('💡');

    await picker.getByRole('button', { name: '🚀' }).click();
    expect((await editor.blockData('co'))?.icon).toBe('🚀');
    await expect(picker).toBeHidden();
    expect((await editor.selection())?.blockId).toBe('co');

    for (const [typed, kept] of [
      ['⚠️ warning', '⚠️'],
      ['👨‍👩‍👧 family', '👨‍👩‍👧'],
    ] as const) {
      await editor.clickControl(icon);
      await input.fill(typed);
      await page.keyboard.press('Enter');
      expect((await editor.blockData('co'))?.icon).toBe(kept);
      await expect(icon).toHaveText(kept);
    }

    await editor.clickControl(icon);
    await input.fill('');
    await page.keyboard.press('Enter');
    await expect(picker).toBeHidden();
    expect((await editor.blockData('co'))?.icon).toBe('👨‍👩‍👧');

    await editor.clickControl(icon);
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    expect(await editor.selection()).toMatchObject({
      blockId: 'co',
      range: { start: 12, end: 12 },
    });

    await editor.clickControl(icon);
    await page.locator('#before').click(); // (the picker itself covers #after)
    await expect(picker).toBeHidden();
    await expect(page.locator('#before')).toBeFocused();
  });
});
