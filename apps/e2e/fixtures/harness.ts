/**
 * The e2e harness: one framework-free page, configured by query string.
 *
 * It mounts the editor exactly as a consumer would — from the built package —
 * and exposes `window.__e2e` so specs can arrange state and read it back. The
 * step under test is always driven with real input from Playwright; nothing in
 * here should be used to perform it.
 */
import * as lib from '@neditor/core';
import type { NEditor, NEditorDocument, NEditorLabels, NEditorOptions } from '@neditor/core';
import { DOCS } from './docs.ts';

type Mount = 'plain' | 'shadow' | 'iframe' | 'dialog' | 'two';

interface LoggedEvent {
  editor: number;
  type: string;
  payload: unknown;
  t: number;
}

const params = new URLSearchParams(location.search);

const FRENCH: Partial<NEditorLabels> = {
  editor: 'Éditeur de texte',
  bold: 'Gras',
  italic: 'Italique',
  formatToolbar: 'Mise en forme',
  blocksSelected: '{count} blocs sélectionnés',
  blockSelected: '1 bloc sélectionné',
  blockSelectedNamed: '{type} sélectionné, {text}',
  emptyBlockSelectedNamed: '{type} vide sélectionné',
  leftEditor: "Sortie de l'éditeur",
  placeholders: { paragraph: 'Tapez « / » pour les commandes' },
  slashMenu: 'Types de bloc',
  slashCommands: {
    heading1: {
      label: 'Titre 1',
      description: 'Grand titre de section.',
      keywords: ['titre', 'h1'],
    },
    paragraph: { label: 'Texte', description: 'Du texte simple.', keywords: ['texte'] },
  },
};

function bool(name: string): boolean | undefined {
  const value = params.get(name);
  return value === null ? undefined : value !== '0' && value !== 'false';
}

function optionsFromQuery(): Partial<NEditorOptions> {
  const options: Partial<NEditorOptions> = {};
  const editable = bool('editable');
  const toolbar = bool('toolbar');
  const dragHandles = bool('dragHandles');
  const injectStyles = bool('injectStyles');
  const autofocus = bool('autofocus');
  const theme = params.get('theme');
  const historyLimit = params.get('historyLimit');

  if (editable !== undefined) options.editable = editable;
  if (toolbar !== undefined) options.toolbar = toolbar;
  if (dragHandles !== undefined) options.dragHandles = dragHandles;
  if (injectStyles !== undefined) options.injectStyles = injectStyles;
  if (autofocus !== undefined) options.autofocus = autofocus;
  if (theme === 'light' || theme === 'dark' || theme === 'auto') options.theme = theme;
  if (historyLimit) options.historyLimit = Number(historyLimit);
  if (params.get('labels') === 'fr') options.labels = FRENCH;

  return options;
}

function seed(name = params.get('doc') ?? 'paragraphs'): NEditorDocument {
  const make = (DOCS as Record<string, (() => NEditorDocument) | undefined>)[name];

  if (!make) {
    throw new Error(`[e2e] unknown doc fixture: ${name}`);
  }

  return make();
}

const stage = document.querySelector<HTMLElement>('#stage')!;
const editors: NEditor[] = [];
const events: LoggedEvent[] = [];
const announcements: string[] = [];
const errors: unknown[] = [];
let dragPayload: { html?: string; text?: string } = { html: '<b>dragged</b>', text: 'dragged' };

window.addEventListener('error', (event) => errors.push(String(event.error ?? event.message)));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));

function watch(editor: NEditor, index: number): void {
  for (const type of ['change', 'focus', 'selection', 'history', 'blockselection'] as const) {
    editor.on(type, (payload: unknown) => {
      events.push({ editor: index, type, payload: structuredClone(payload), t: performance.now() });
    });
  }

  const region = editor.element.querySelector('.neditor-live-region');

  if (region) {
    new MutationObserver(() => {
      const text = region.textContent ?? '';

      if (text) {
        announcements.push(text);
      }
    }).observe(region, { childList: true, characterData: true, subtree: true });
  }
}

function makeHost(container: ParentNode & Node, id: string): HTMLElement {
  const ownerDocument = container.ownerDocument ?? document;
  const host = ownerDocument.createElement('div');
  host.id = id;
  host.className = 'editor-host';

  const dir = params.get('dir');

  if (dir === 'rtl') {
    host.dir = 'rtl';
  } else if (dir === 'page-rtl') {
    // An LTR editor inside an RTL page: it must not be mirrored twice.
    host.dir = 'ltr';
  }

  container.appendChild(host);
  return host;
}

function create(
  element: HTMLElement,
  overrides: Partial<NEditorOptions> = {},
  doc?: NEditorDocument,
): NEditor {
  const index = editors.length;
  const editor = lib.createEditor({
    element,
    doc: doc ?? seed(),
    onError: (error) => errors.push(String(error)),
    ...optionsFromQuery(),
    ...overrides,
  });

  editors.push(editor);
  watch(editor, index);
  return editor;
}

async function mount(
  overrides: Partial<NEditorOptions> = {},
  doc?: NEditorDocument,
): Promise<void> {
  const kind = (params.get('mount') ?? 'plain') as Mount;

  switch (kind) {
    case 'plain': {
      create(makeHost(stage, 'editor'), overrides, doc);
      break;
    }

    case 'two': {
      create(makeHost(stage, 'editor'), overrides, doc);
      create(makeHost(stage, 'editor2'), overrides, seed('empty'));
      break;
    }

    case 'shadow': {
      const outer = document.createElement('e2e-shadow-host');
      stage.appendChild(outer);
      const shadow = outer.attachShadow({ mode: 'open' });
      create(makeHost(shadow, 'editor'), overrides, doc);
      break;
    }

    case 'iframe': {
      const frame = document.createElement('iframe');
      frame.id = 'frame';
      frame.style.cssText = 'width: 100%; height: 480px; border: 1px solid #ccc';
      frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
      const loaded = new Promise((resolve) =>
        frame.addEventListener('load', resolve, { once: true }),
      );
      stage.appendChild(frame);
      await loaded;
      // The editor module lives in *this* realm; its mount point in the frame's.
      create(makeHost(frame.contentDocument!.body, 'editor'), overrides, doc);
      break;
    }

    case 'dialog': {
      const dialog = document.createElement('dialog');
      dialog.id = 'dialog';
      dialog.style.cssText = 'width: 640px';
      stage.appendChild(dialog);
      dialog.showModal();
      create(makeHost(dialog, 'editor'), { portalContainer: dialog, ...overrides }, doc);
      break;
    }
  }
}

/** Checks the editor's core invariants; returns human-readable violations. */
function checkInvariants(editor: NEditor): string[] {
  const violations: string[] = [];
  const root = editor.element;

  if (!root.classList.contains('neditor')) {
    return violations; // destroyed
  }

  const blocks = editor.getDocument().blocks;

  // Depth is re-clamped after every structural change.
  const clamped = lib.normalizeDepths(blocks);
  clamped.forEach((block, index) => {
    if (block.depth !== blocks[index]!.depth) {
      violations.push(
        `depth: ${block.id} is ${blocks[index]!.depth}, should clamp to ${block.depth}`,
      );
    }
  });

  // The rendered view is the visible model, in order.
  const visible = lib.visibleBlocks(blocks);
  const views = [...root.querySelectorAll<HTMLElement>(':scope > .neditor-block')];
  const renderedIds = views.map((view) => view.dataset.blockId);
  const visibleIds = visible.map((block) => block.id);

  if (renderedIds.join('|') !== visibleIds.join('|')) {
    violations.push(
      `order: rendered [${renderedIds.join(', ')}] but model shows [${visibleIds.join(', ')}]`,
    );
  } else {
    visible.forEach((block, index) => {
      const view = views[index]!;

      if (view.dataset.blockType !== block.type) {
        violations.push(
          `type: ${block.id} renders ${view.dataset.blockType}, model says ${block.type}`,
        );
      }

      if (Number(view.dataset.depth) !== block.depth) {
        violations.push(
          `depth attr: ${block.id} renders ${view.dataset.depth}, model says ${block.depth}`,
        );
      }

      if (block.type === 'table') {
        for (const cell of view.querySelectorAll<HTMLElement>('[data-cell]')) {
          const [row, column] = cell.dataset.cell!.split(':').map(Number);
          const expected = block.rows?.[row!]?.[column!] ?? [];

          if (!lib.richEquals(lib.parseRichText(cell), expected)) {
            violations.push(`drift: ${block.id} cell ${cell.dataset.cell} DOM differs from model`);
          }
        }
      } else if (block.type !== 'divider') {
        const host = view.querySelector<HTMLElement>('.neditor-block__content');

        if (!host) {
          violations.push(`host: ${block.id} has no content host`);
        } else if (!lib.richEquals(lib.parseRichText(host), block.content)) {
          violations.push(
            `drift: ${block.id} DOM ${JSON.stringify(lib.parseRichText(host))} vs model ${JSON.stringify(block.content)}`,
          );
        }
      }
    });
  }

  // Two selection modes, never both.
  const selected = editor.getSelectedBlocks();
  const marked = views
    .filter((view) => view.dataset.selected === 'true')
    .map((view) => view.dataset.blockId);

  const byId = (a: string | undefined, b: string | undefined) => String(a).localeCompare(String(b));

  if ([...selected].sort(byId).join('|') !== [...marked].sort(byId).join('|')) {
    violations.push(
      `selection: getSelectedBlocks [${selected.join(', ')}] vs data-selected [${marked.join(', ')}]`,
    );
  }

  if (selected.length > 0) {
    const rootNode = root.getRootNode() as Document | ShadowRoot;
    const selection =
      (rootNode as { getSelection?: () => Selection | null }).getSelection?.() ??
      root.ownerDocument.getSelection();
    const anchor = selection?.rangeCount ? selection.anchorNode : null;
    const anchorElement =
      anchor && (anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement);

    if (anchorElement?.closest('.neditor-block__content') && root.contains(anchorElement)) {
      violations.push(
        'modes: blocks are selected while a DOM selection sits inside a content host',
      );
    }
  }

  if (root.lastElementChild?.classList.contains('neditor-live-region') !== true) {
    violations.push('live region is not the last child of the root');
  }

  if (!editor.editable) {
    const trees = new Set<ParentNode>([document, root.getRootNode() as ParentNode]);

    for (const tree of trees) {
      for (const portal of tree.querySelectorAll<HTMLElement>('.neditor-portal:not([hidden])')) {
        violations.push(`read-only: portal ${portal.className} is visible`);
      }
    }
  }

  // What the writer emits, the reader reads back to the same thing. Markdown
  // cannot express an empty paragraph (a documented, registered known failure
  // of the round trip), so those are left out on both sides.
  //
  // FINDING F1 (docs/e2e-progress.md): whitespace at either edge of a block's
  // text is dropped by the reader, so " one" comes back as "one". Not in the
  // unit registry; tolerated here, and pinned by an expected-failure spec in
  // round-trip.spec.ts so a fix is noticed.
  const expressible = lib
    .normalizeDepths(
      blocks.filter((block) => !(block.type === 'paragraph' && lib.isRichEmpty(block.content))),
    )
    .map((block) => {
      if (block.type === 'code' || block.type === 'table') {
        return block;
      }

      const text = lib.richToPlainText(block.content);
      const start = text.length - text.trimStart().length;
      const end = text.trimEnd().length;
      return { ...block, content: lib.richSlice(block.content, start, Math.max(start, end)) };
    })
    .filter((block) => !(block.type === 'paragraph' && lib.isRichEmpty(block.content)))
    // FINDING F4: an image with no source is written as `![]()`, which the
    // reader cannot accept as an image and keeps as literal paragraph text.
    .filter((block) => !(block.type === 'image' && !block.src));
  const markdown = lib.toMarkdown({ blocks: expressible });
  const again = lib.toMarkdown({ blocks: lib.blocksFromMarkdown(markdown) });

  if (again !== markdown) {
    violations.push(`markdown round trip drifted:\n${markdown}\n---\n${again}`);
  }

  return violations;
}

const api = {
  lib,
  docs: DOCS,
  editors,
  get editor(): NEditor {
    return editors[0]!;
  },
  events,
  announcements,
  errors,
  ready: false,
  /** The pointerId of the most recent pointerdown, for dispatching a matching pointercancel. */
  lastPointerId: 1,
  /** Pointerdowns seen, so a spec can wait for the renderer to have handled one. */
  pointerDowns: 0,
  /** Replace every editor with a fresh one; options merge over the query string. */
  async remount(overrides: Partial<NEditorOptions> = {}, docName?: string): Promise<void> {
    for (const editor of editors.splice(0)) {
      editor.destroy();
    }

    stage.replaceChildren();
    events.length = 0;
    announcements.length = 0;
    await mount(overrides, docName ? seed(docName) : undefined);
  },
  setDragPayload(payload: { html?: string; text?: string }): void {
    dragPayload = payload;
  },
  checkInvariants(): string[] {
    return editors.flatMap((editor, index) =>
      checkInvariants(editor).map((message) => `editor ${index}: ${message}`),
    );
  },
  clearLog(): void {
    events.length = 0;
    announcements.length = 0;
  },
};

declare global {
  interface Window {
    __e2e: typeof api;
  }
}

window.__e2e = api;

document.addEventListener(
  'pointerdown',
  (event) => {
    api.lastPointerId = event.pointerId;
    api.pointerDowns += 1;
  },
  true,
);

document.querySelector('#foreign-source')?.addEventListener('dragstart', (event) => {
  const transfer = (event as DragEvent).dataTransfer!;

  if (dragPayload.html !== undefined) {
    transfer.setData('text/html', dragPayload.html);
  }

  if (dragPayload.text !== undefined) {
    transfer.setData('text/plain', dragPayload.text);
  }

  transfer.effectAllowed = 'copy';
});

if (params.get('scroll') === '1') {
  document.body.classList.add('scrolling');
}

if (params.get('dir') === 'page-rtl') {
  document.documentElement.dir = 'rtl';
}

await mount();
api.ready = true;
