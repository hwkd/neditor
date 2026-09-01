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

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    type: 'paragraph',
    label: 'Text',
    description: 'Just start writing with plain text.',
    icon: 'T',
    keywords: ['text', 'paragraph', 'plain'],
  },
  {
    type: 'heading1',
    label: 'Heading 1',
    description: 'Big section heading.',
    icon: 'H1',
    keywords: ['heading', 'h1', 'title', 'large'],
  },
  {
    type: 'heading2',
    label: 'Heading 2',
    description: 'Medium section heading.',
    icon: 'H2',
    keywords: ['heading', 'h2', 'subtitle', 'medium'],
  },
  {
    type: 'heading3',
    label: 'Heading 3',
    description: 'Small section heading.',
    icon: 'H3',
    keywords: ['heading', 'h3', 'small'],
  },
  {
    type: 'bulleted_list',
    label: 'Bulleted list',
    description: 'Create a simple bulleted list.',
    icon: '•',
    keywords: ['bullet', 'list', 'unordered', 'ul'],
  },
  {
    type: 'numbered_list',
    label: 'Numbered list',
    description: 'Create a list with numbering.',
    icon: '1.',
    keywords: ['number', 'list', 'ordered', 'ol'],
  },
  {
    type: 'todo',
    label: 'To-do list',
    description: 'Track tasks with a checkbox.',
    icon: '☐',
    keywords: ['todo', 'task', 'checkbox', 'check'],
  },
  {
    type: 'quote',
    label: 'Quote',
    description: 'Capture a quote.',
    icon: '❝',
    keywords: ['quote', 'blockquote', 'cite'],
  },
  {
    type: 'code',
    label: 'Code',
    description: 'Capture a code snippet.',
    icon: '</>',
    keywords: ['code', 'snippet', 'pre', 'monospace'],
  },
  {
    type: 'callout',
    label: 'Callout',
    description: 'Make writing stand out.',
    icon: '\u{1F4A1}',
    keywords: ['callout', 'note', 'info', 'aside', 'tip', 'warning'],
  },
  {
    type: 'toggle',
    label: 'Toggle list',
    description: 'Hide content inside a collapsible block.',
    icon: '\u25B8',
    keywords: ['toggle', 'collapse', 'details', 'accordion', 'fold'],
  },
  {
    type: 'image',
    label: 'Image',
    description: 'Embed a picture by URL.',
    icon: '\u{1F5BC}',
    keywords: ['image', 'picture', 'photo', 'img', 'embed'],
  },
  {
    type: 'table',
    label: 'Table',
    description: 'Add a simple table.',
    icon: '\u25A6',
    keywords: ['table', 'grid', 'rows', 'columns'],
  },
  {
    type: 'divider',
    label: 'Divider',
    description: 'Visually divide blocks.',
    icon: '—',
    keywords: ['divider', 'separator', 'hr', 'line'],
  },
];

export function filterCommands(query: string): readonly SlashCommand[] {
  const needle = query.trim().toLowerCase();

  if (needle.length === 0) {
    return SLASH_COMMANDS;
  }

  return SLASH_COMMANDS.filter(
    (command) =>
      command.label.toLowerCase().includes(needle) ||
      command.keywords.some((keyword) => keyword.startsWith(needle)),
  );
}

export interface SlashMenuHooks {
  onSelect(command: SlashCommand): void;
  onDismiss(): void;
}

export class SlashMenu {
  readonly #element: HTMLElement;
  readonly #list: HTMLElement;
  readonly #hooks: SlashMenuHooks;

  #commands: readonly SlashCommand[] = SLASH_COMMANDS;
  #anchor: DOMRect | null = null;
  #activeIndex = 0;
  #open = false;

  constructor(doc: Document, hooks: SlashMenuHooks, labels: NEditorLabels) {
    this.#hooks = hooks;

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
    this.#commands = filterCommands(query);

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
