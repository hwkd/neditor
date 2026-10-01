/**
 * Seed documents for the e2e harness, selected with `?doc=<name>`.
 *
 * Ids are stable and human-readable so specs can address blocks directly:
 * `p1`, `h1`, `todo1`… Every document is plain data — it is imported by the
 * browser harness and by the Node-side specs alike, so it must not touch the
 * DOM or import the editor.
 */
import type { Block, NEditorDocument, RichText } from '@neditor/core';

type Extra = Partial<Omit<Block, 'id' | 'type' | 'content' | 'depth'>>;

const t = (text: string): RichText => (text ? [{ text }] : []);

export function block(
  id: string,
  type: Block['type'],
  content: RichText | string = '',
  depth = 0,
  extra: Extra = {},
): Block {
  return { id, type, content: typeof content === 'string' ? t(content) : content, depth, ...extra };
}

const p = (id: string, text = '', depth = 0) => block(id, 'paragraph', text, depth);

export const DOCS = {
  empty: () => ({ blocks: [p('p1')] }),

  /** Three plain paragraphs: the default playground for text and structure keys. */
  paragraphs: () => ({
    blocks: [p('p1', 'Alpha one'), p('p2', 'Bravo two'), p('p3', 'Charlie three')],
  }),

  /** Five paragraphs, for block selection and moves. */
  five: () => ({
    blocks: [
      p('a', 'Block A'),
      p('b', 'Block B'),
      p('c', 'Block C'),
      p('d', 'Block D'),
      p('e', 'Block E'),
    ],
  }),

  lists: () => ({
    blocks: [
      block('b1', 'bulleted_list', 'Bullet one'),
      block('b2', 'bulleted_list', 'Bullet two'),
      block('n1', 'numbered_list', 'Number one'),
      block('n2', 'numbered_list', 'Number two'),
      block('t1', 'todo', 'Todo one', 0, { checked: false }),
      block('t2', 'todo', 'Todo two', 0, { checked: true }),
    ],
  }),

  nested: () => ({
    blocks: [
      block('l0', 'bulleted_list', 'Level zero'),
      block('l1', 'bulleted_list', 'Level one', 1),
      block('l2', 'bulleted_list', 'Level two', 2),
      p('after', 'After the list'),
    ],
  }),

  /** A collapsed toggle with two hidden children, between two paragraphs. */
  'toggle-collapsed': () => ({
    blocks: [
      p('before', 'Before'),
      block('tg', 'toggle', 'Toggle head', 0, { collapsed: true }),
      p('child1', 'Hidden child one', 1),
      p('child2', 'Hidden child two', 1),
      p('after', 'After'),
    ],
  }),

  'toggle-open': () => ({
    blocks: [
      p('before', 'Before'),
      block('tg', 'toggle', 'Toggle head', 0, { collapsed: false }),
      p('child1', 'Child one', 1),
      p('child2', 'Child two', 1),
      p('after', 'After'),
    ],
  }),

  table: () => ({
    blocks: [
      p('before', 'Before the table'),
      block('tbl', 'table', '', 0, {
        rows: [
          [t('H1'), t('H2'), t('H3')],
          [t('a1'), t('a2'), t('a3')],
          [t('b1'), t('b2'), t('b3')],
        ],
      }),
      p('after', 'After the table'),
    ],
  }),

  image: () => ({
    blocks: [
      p('before', 'Before the image'),
      block('img', 'image', 'A caption', 0, { src: '/sample.png', alt: 'A blue gradient' }),
      p('after', 'After the image'),
    ],
  }),

  'image-empty': () => ({
    blocks: [
      p('before', 'Before'),
      block('img', 'image', '', 0, { src: '', alt: '' }),
      p('after', 'After'),
    ],
  }),

  links: () => ({
    blocks: [
      block('p1', 'paragraph', [
        { text: 'See the ' },
        { text: 'docs', link: 'https://example.com/docs' },
        { text: ' for details.' },
      ]),
      p('p2', 'Plain paragraph'),
    ],
  }),

  formatted: () => ({
    blocks: [
      block('p1', 'paragraph', [
        { text: 'plain ' },
        { text: 'bold', marks: ['bold'] },
        { text: ' and ' },
        { text: 'italic', marks: ['italic'] },
      ]),
      p('p2', 'Second paragraph'),
    ],
  }),

  callout: () => ({
    blocks: [
      p('before', 'Before'),
      block('co', 'callout', 'Callout text', 0, { icon: '💡' }),
      p('after', 'After'),
    ],
  }),

  divider: () => ({
    blocks: [p('p1', 'Above'), block('hr', 'divider'), p('p2', 'Below')],
  }),

  code: () => ({
    blocks: [p('p1', 'Before code'), block('code', 'code', 'const x = 1;'), p('p2', 'After code')],
  }),

  /** One of every block type, used by round-trip, a11y and visual specs. */
  'kitchen-sink': () => ({
    blocks: [
      block('h1', 'heading1', 'Heading one'),
      block('para', 'paragraph', [
        { text: 'Plain, ' },
        { text: 'bold', marks: ['bold'] },
        { text: ', ' },
        { text: 'italic', marks: ['italic'] },
        { text: ', ' },
        { text: 'code', marks: ['code'] },
        { text: ' and a ' },
        { text: 'link', link: 'https://example.com/' },
        { text: '.' },
      ]),
      block('h2', 'heading2', 'Heading two'),
      block('h3', 'heading3', 'Heading three'),
      block('bl', 'bulleted_list', 'Bullet'),
      block('bl2', 'bulleted_list', 'Nested bullet', 1),
      block('nl', 'numbered_list', 'Numbered'),
      block('td', 'todo', 'To-do', 0, { checked: true }),
      block('qt', 'quote', 'A quote'),
      block('cd', 'code', 'let x = 1;'),
      block('co', 'callout', 'A callout', 0, { icon: '💡' }),
      block('tg', 'toggle', 'A toggle', 0, { collapsed: false }),
      p('tgc', 'Inside the toggle', 1),
      block('img', 'image', 'Caption', 0, { src: '/sample.png', alt: 'A blue gradient' }),
      block('tbl', 'table', '', 0, {
        rows: [
          [t('Name'), t('Value')],
          [t('one'), t('1')],
        ],
      }),
      block('hr', 'divider'),
      p('end', 'The end'),
    ],
  }),

  /** Hostile content arriving through setDocument: normalizeDocument must defuse it. */
  malicious: () => ({
    blocks: [
      block('p1', 'paragraph', [
        { text: 'js link', link: 'javascript:alert(1)' },
        { text: ' data link', link: 'data:text/html,<script>alert(1)</script>' },
      ]),
      block('img', 'image', '', 0, {
        src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        alt: 'svg',
      }),
      block('img2', 'image', '', 0, { src: 'javascript:alert(1)', alt: 'js' }),
    ],
  }),

  'long-2000': () => ({
    blocks: Array.from({ length: 2000 }, (_, index) => p(`p${index}`, `Paragraph number ${index}`)),
  }),

  /** Tall enough that the page scrolls; used with `scroll=1`. */
  long: () => ({
    blocks: Array.from({ length: 60 }, (_, index) => p(`p${index}`, `Paragraph number ${index}`)),
  }),
} satisfies Record<string, () => NEditorDocument>;

export type DocName = keyof typeof DOCS;
