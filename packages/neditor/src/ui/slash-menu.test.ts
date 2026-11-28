// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';

import { DEFAULT_LABELS } from '../labels.ts';
import { SlashMenu } from './slash-menu.ts';
import type { SlashCommand } from './slash-menu.ts';

function openMenu(query: string) {
  const chosen: SlashCommand[] = [];
  let dismissed = 0;
  const menu = new SlashMenu(
    document,
    {
      onSelect: (command) => chosen.push(command),
      onDismiss: () => (dismissed += 1),
      onActiveChange: () => {},
    },
    DEFAULT_LABELS,
  );

  document.body.append(menu.element);
  menu.open(new DOMRect(0, 0, 0, 16));
  menu.setQuery(query);

  return { menu, chosen, dismissed: () => dismissed };
}

describe('slash menu keys', () => {
  // BL P3-1: " /quo" then Shift+Enter turned the paragraph into a quote. Shift+
  // Enter is the soft break everywhere else in a block; the menu matched the
  // key and ignored the modifier.
  test('Shift+Enter applies nothing: the menu closes and the key is the editor’s', () => {
    const { menu, chosen, dismissed } = openMenu('quo');
    const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true });

    expect(menu.handleKeyDown(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(chosen).toEqual([]);
    expect(menu.isOpen).toBe(false);
    expect(dismissed()).toBe(1);
  });

  // Same key, same reading: Shift+Tab is the outdent and the way out of the
  // editor at depth 0, never a choice from the menu.
  test('Shift+Tab applies nothing either', () => {
    const { menu, chosen } = openMenu('quo');
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true });

    expect(menu.handleKeyDown(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(chosen).toEqual([]);
    expect(menu.isOpen).toBe(false);
  });

  test('plain Enter and Tab still apply the highlighted command', () => {
    for (const key of ['Enter', 'Tab']) {
      const { menu, chosen } = openMenu('quo');
      const event = new KeyboardEvent('keydown', { key, cancelable: true });

      expect(menu.handleKeyDown(event)).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(chosen.map((command) => command.type)).toEqual(['quote']);
    }
  });
});
