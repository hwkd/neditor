import { DEFAULT_LABELS, DEFAULT_SLASH_COMMANDS } from '../labels.ts';
import type { NEditorLabels } from '../labels.ts';
import type { BlockType } from '../model/document.ts';
import type { PortalTheme } from './portal.ts';
import { createPortal, positionPortal } from './portal.ts';

/**
 * The slash command menu.
 *
 * Opens when `/` is typed at a word boundary — the start of a block, or after a
 * space — filters as you keep typing, and commits a block type on Enter. It
 * owns no editor state: it reports a chosen type and lets the editor apply it.
 */

export interface SlashCommand {
  readonly type: BlockType;
  readonly label: string;
  readonly description: string;
  readonly icon: string;
  readonly keywords: readonly string[];
}

/**
 * Menu order and icon per block type.
 *
 * Only the untranslatable half lives here; every string a translator has to
 * touch is in the label set, so a menu built from French labels also filters
 * on French words.
 */
const COMMAND_ORDER: readonly { readonly type: BlockType; readonly icon: string }[] = [
  { type: 'paragraph', icon: 'T' },
  { type: 'heading1', icon: 'H1' },
  { type: 'heading2', icon: 'H2' },
  { type: 'heading3', icon: 'H3' },
  { type: 'bulleted_list', icon: '•' },
  { type: 'numbered_list', icon: '1.' },
  { type: 'todo', icon: '☐' },
  { type: 'quote', icon: '❝' },
  { type: 'code', icon: '</>' },
  { type: 'callout', icon: '\u{1F4A1}' },
  { type: 'toggle', icon: '\u25B8' },
  { type: 'image', icon: '\u{1F5BC}' },
  { type: 'table', icon: '\u25A6' },
  { type: 'divider', icon: '—' },
];

/** Builds the menu for one label set. */
export function createSlashCommands(labels: NEditorLabels): readonly SlashCommand[] {
  return COMMAND_ORDER.map(({ type, icon }) => {
    // A caller may override one entry and leave the rest out; falling back per
    // entry keeps the command in the menu rather than silently dropping it.
    const text = labels.slashCommands[type] ?? DEFAULT_SLASH_COMMANDS[type];

    return {
      type,
      icon,
      label: text.label,
      description: text.description,
      keywords: text.keywords,
    };
  });
}

/** The menu in the built-in English. */
export const SLASH_COMMANDS: readonly SlashCommand[] = createSlashCommands(DEFAULT_LABELS);

export function filterCommands(
  query: string,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): readonly SlashCommand[] {
  const needle = query.trim().toLowerCase();

  if (needle.length === 0) {
    return commands;
  }

  return commands.filter(
    (command) =>
      command.label.toLowerCase().includes(needle) ||
      command.keywords.some((keyword) => keyword.toLowerCase().startsWith(needle)),
  );
}

export interface SlashMenuHooks {
  onSelect(command: SlashCommand): void;
  onDismiss(): void;
  /**
   * The highlighted option changed, so `aria-activedescendant` is now stale.
   *
   * The menu is a portal and the combobox wiring lives on the block being
   * typed in, so the menu cannot fix the attribute itself — and it is the only
   * one that knows the highlight moved. Arrow keys never reach the editor's
   * own key handling, and a mouse moving down the list reaches nothing at all.
   */
  onActiveChange(): void;
}

export class SlashMenu {
  readonly #element: HTMLElement;
  readonly #list: HTMLElement;
  readonly #hooks: SlashMenuHooks;
  /** Built once from the label set this menu was constructed with. */
  readonly #allCommands: readonly SlashCommand[];

  #commands: readonly SlashCommand[];
  #anchor: DOMRect | null = null;
  #activeIndex = 0;
  #open = false;

  constructor(doc: Document, hooks: SlashMenuHooks, labels: NEditorLabels) {
    this.#hooks = hooks;
    this.#allCommands = createSlashCommands(labels);
    this.#commands = this.#allCommands;

    this.#element = createPortal(doc, 'neditor-slash-menu');

    this.#list = doc.createElement('div');
    this.#list.className = 'neditor-slash-menu__list';
    // The listbox role belongs on the element that actually owns the options.
    // It was on the outer portal, so the options were not its children and the
    // relationship was broken.
    this.#list.id = `neditor-slash-${Math.random().toString(36).slice(2, 9)}`;
    this.#list.setAttribute('role', 'listbox');
    this.#list.setAttribute('aria-label', labels.slashMenu);
    this.#element.append(this.#list);
  }

  get element(): HTMLElement {
    return this.#element;
  }

  /** The listbox id, for the editable's `aria-controls`. */
  get listId(): string {
    return this.#list.id;
  }

  /** The id of the highlighted option, for `aria-activedescendant`. */
  get activeOptionId(): string | null {
    return this.#open ? `${this.#list.id}-option-${this.#activeIndex}` : null;
  }

  /** The menu renders outside the editor, so it is themed explicitly. */
  setTheme(theme: PortalTheme): void {
    this.#element.dataset.neditorTheme = theme;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  open(anchor: DOMRect): void {
    this.#open = true;
    this.#activeIndex = 0;
    this.#anchor = anchor;
    this.#element.hidden = false;
    this.setQuery('');
  }

  close(): void {
    if (!this.#open) {
      return;
    }

    this.#open = false;
    this.#element.hidden = true;
  }

  setQuery(query: string): void {
    this.#commands = filterCommands(query, this.#allCommands);

    if (this.#commands.length === 0) {
      this.close();
      this.#hooks.onDismiss();
      return;
    }

    this.#activeIndex = Math.min(this.#activeIndex, this.#commands.length - 1);
    this.#renderList();
  }

  /** Returns true when the menu consumed the key. */
  handleKeyDown(event: KeyboardEvent): boolean {
    if (!this.#open) {
      return false;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.#move(1);
        return true;

      case 'ArrowUp':
        event.preventDefault();
        this.#move(-1);
        return true;

      case 'Enter':
      case 'Tab': {
        const command = this.#commands[this.#activeIndex];

        if (command) {
          event.preventDefault();
          this.#hooks.onSelect(command);
          return true;
        }

        return false;
      }

      case 'Escape':
        event.preventDefault();
        this.close();
        this.#hooks.onDismiss();
        return true;

      default:
        return false;
    }
  }

  destroy(): void {
    this.#element.remove();
  }

  #move(delta: number): void {
    const count = this.#commands.length;

    if (count === 0) {
      return;
    }

    this.#activeIndex = (this.#activeIndex + delta + count) % count;
    this.#renderList();
  }

  #renderList(): void {
    const doc = this.#element.ownerDocument;
    this.#list.replaceChildren();

    this.#commands.forEach((command, index) => {
      const item = doc.createElement('div');
      item.className = 'neditor-slash-menu__item';
      item.id = `${this.#list.id}-option-${index}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === this.#activeIndex));

      if (index === this.#activeIndex) {
        item.dataset.active = 'true';
      }

      const icon = doc.createElement('div');
      icon.className = 'neditor-slash-menu__icon';
      icon.textContent = command.icon;

      const body = doc.createElement('div');
      body.className = 'neditor-slash-menu__body';

      const label = doc.createElement('div');
      label.className = 'neditor-slash-menu__label';
      label.textContent = command.label;

      const description = doc.createElement('div');
      description.className = 'neditor-slash-menu__description';
      description.textContent = command.description;

      body.append(label, description);
      item.append(icon, body);

      item.addEventListener('click', () => {
        this.#hooks.onSelect(command);
      });

      item.addEventListener('mouseenter', () => {
        this.#activeIndex = index;
        this.#renderList();
      });

      this.#list.append(item);
    });

    this.#scrollActiveIntoView();

    if (this.#anchor && this.#open) {
      positionPortal(this.#element, this.#anchor, { prefer: 'below' });
    }

    // Every path that moves the highlight ends here — opening, filtering, the
    // arrow keys, a mouse crossing an item — so this is the one place that can
    // promise the announced option is the highlighted one. The ids exist by
    // now, which is why it is the last thing the render does.
    this.#hooks.onActiveChange();
  }

  /**
   * Scrolls the active item into view within the list only.
   *
   * `scrollIntoView` would walk up to the document and scroll the page to this
   * fixed-position menu's layout origin, so the offsets are done by hand.
   */
  #scrollActiveIntoView(): void {
    const active = this.#list.querySelector<HTMLElement>('[data-active="true"]');

    if (!active) {
      return;
    }

    const viewTop = this.#list.scrollTop;
    const viewBottom = viewTop + this.#list.clientHeight;
    const itemTop = active.offsetTop;
    const itemBottom = itemTop + active.offsetHeight;

    if (itemTop < viewTop) {
      this.#list.scrollTop = itemTop;
    } else if (itemBottom > viewBottom) {
      this.#list.scrollTop = itemBottom - this.#list.clientHeight;
    }
  }
}
