import { describe, expect, test } from 'vitest';

import { blocksFromMarkdown } from '../input/markdown.ts';
import { matchInputRule } from '../input/input-rules.ts';
import type { Block } from './document.ts';
import type { Mark, TextRun } from './rich-text.ts';
import {
  blockText,
  computeListNumbers,
  createBlock,
  createEmptyDocument,
  indentBlock,
  insertBlockAfter,
  moveBlock,
  normalizeDocument,
  removeBlock,
  setBlockType,
  toMarkdown,
  typeAfterSplit,
  updateBlock,
  withHiddenDescendants,
} from './document.ts';
import { richFromPlainText, richSetLink, richSetMark } from './rich-text.ts';

function blocks(...specs: Array<[Block['type'], string, number?]>): Block[] {
  return specs.map(([type, text, depth]) => createBlock(type, text, depth ?? 0));
}

describe('document model', () => {
  test('a new document starts with one empty paragraph', () => {
    const doc = createEmptyDocument();

    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]?.type).toBe('paragraph');
    expect(doc.blocks[0]?.content).toEqual([]);
  });

  test('block ids are unique', () => {
    const ids = new Set(Array.from({ length: 500 }, () => createBlock().id));

    expect(ids.size).toBe(500);
  });

  test('structural edits do not mutate the input array', () => {
    const original = blocks(['paragraph', 'a'], ['paragraph', 'b']);
    const first = original[0];

    expect(first).toBeDefined();

    // Frozen rather than shallow-copied: a copy shares the block objects, so an
    // in-place write would be invisible to toEqual. Undo depends on this.
    Object.freeze(original);
    original.forEach((block) => {
      Object.freeze(block);
      Object.freeze(block.content);
    });

    expect(() => {
      insertBlockAfter(original, first!.id, createBlock('paragraph', 'c'));
      removeBlock(original, first!.id);
      updateBlock(original, first!.id, { content: richFromPlainText('changed') });
    }).not.toThrow();

    expect(blockText(first!)).toBe('a');
  });

  test('setBlockType clears state that does not apply to the new type', () => {
    const [todo] = blocks(['todo', 'ship it']);

    expect(todo).toBeDefined();

    const checked = updateBlock([todo!], todo!.id, { checked: true });
    const converted = setBlockType(checked, todo!.id, 'paragraph');

    expect(converted[0]?.checked).toBeUndefined();
    expect(converted[0]?.type).toBe('paragraph');
  });

  test('converting to a divider drops the text', () => {
    const [paragraph] = blocks(['paragraph', 'leftover']);
    const converted = setBlockType([paragraph!], paragraph!.id, 'divider');

    expect(converted[0]?.content).toEqual([]);
  });

  test('moveBlock is a no-op at the edges', () => {
    const list = blocks(['paragraph', 'a'], ['paragraph', 'b']);
    const first = list[0]!;

    expect(moveBlock(list, first.id, -1).map(blockText)).toEqual(['a', 'b']);
    expect(moveBlock(list, first.id, 1).map(blockText)).toEqual(['b', 'a']);
  });

  test('indent never exceeds one level below the previous block', () => {
    const list = blocks(['bulleted_list', 'a'], ['bulleted_list', 'b']);
    const second = list[1]!;

    const once = indentBlock(list, second.id, 1);
    expect(once[1]?.depth).toBe(1);

    // Already at the maximum, so a second indent is refused.
    expect(indentBlock(once, second.id, 1)[1]?.depth).toBe(1);
  });

  test('the first block can never be indented', () => {
    const list = blocks(['bulleted_list', 'a']);

    expect(indentBlock(list, list[0]!.id, 1)[0]?.depth).toBe(0);
  });

  test('outdent stops at zero', () => {
    const list = blocks(['paragraph', 'a']);

    expect(indentBlock(list, list[0]!.id, -1)[0]?.depth).toBe(0);
  });

  test('lists continue themselves on Enter, other types fall back to paragraph', () => {
    expect(typeAfterSplit('bulleted_list')).toBe('bulleted_list');
    expect(typeAfterSplit('numbered_list')).toBe('numbered_list');
    expect(typeAfterSplit('todo')).toBe('todo');
    expect(typeAfterSplit('heading1')).toBe('paragraph');
    expect(typeAfterSplit('quote')).toBe('paragraph');
  });
});

describe('list numbering', () => {
  test('numbers run consecutively and restart after an interruption', () => {
    const list = blocks(
      ['numbered_list', 'one'],
      ['numbered_list', 'two'],
      ['paragraph', 'break'],
      ['numbered_list', 'restarted'],
    );

    const numbers = computeListNumbers(list);

    expect(numbers.get(list[0]!.id)).toBe(1);
    expect(numbers.get(list[1]!.id)).toBe(2);
    expect(numbers.get(list[2]!.id)).toBeUndefined();
    expect(numbers.get(list[3]!.id)).toBe(1);
  });

  test('a nested list numbers independently of its parent', () => {
    const list = blocks(
      ['numbered_list', 'one', 0],
      ['numbered_list', 'nested a', 1],
      ['numbered_list', 'nested b', 1],
      ['numbered_list', 'two', 0],
    );

    const numbers = computeListNumbers(list);

    expect(numbers.get(list[0]!.id)).toBe(1);
    expect(numbers.get(list[1]!.id)).toBe(1);
    expect(numbers.get(list[2]!.id)).toBe(2);
    expect(numbers.get(list[3]!.id)).toBe(2);
  });
});

describe('input rules', () => {
  test.each([
    ['# ', 'heading1'],
    ['## ', 'heading2'],
    ['### ', 'heading3'],
    ['- ', 'bulleted_list'],
    ['* ', 'bulleted_list'],
    ['1. ', 'numbered_list'],
    ['7) ', 'numbered_list'],
    ['> ', 'quote'],
    ['[] ', 'todo'],
    ['[x] ', 'todo'],
    ['```', 'code'],
    ['---', 'divider'],
  ])('%s becomes %s', (prefix: string, expected: string) => {
    expect(matchInputRule(prefix, prefix)?.type).toBe(expected);
  });

  test('the remaining text is preserved', () => {
    expect(matchInputRule('# ', '# Title')?.rest).toBe('Title');
  });

  test('a prefix mid-sentence does not fire', () => {
    expect(matchInputRule('a # ', 'a # ')).toBeNull();
    expect(matchInputRule('# heading ', '# heading ')).toBeNull();
  });

  test('a bare hash without the space does not fire', () => {
    expect(matchInputRule('#', '#')).toBeNull();
  });
});

describe('normalizeDocument', () => {
  test('an empty or missing document becomes one paragraph', () => {
    expect(normalizeDocument(undefined).blocks).toHaveLength(1);
    expect(normalizeDocument({ blocks: [] }).blocks).toHaveLength(1);
  });

  test('missing fields are filled in', () => {
    const doc = normalizeDocument({
      blocks: [{ type: 'todo' } as Block],
    });

    expect(doc.blocks[0]?.id).toBeTruthy();
    expect(doc.blocks[0]?.content).toEqual([]);
    expect(doc.blocks[0]?.depth).toBe(0);
    expect(doc.blocks[0]?.checked).toBe(false);
  });

  test('negative and fractional depths are clamped to integers', () => {
    const doc = normalizeDocument({
      blocks: [{ id: 'x', type: 'paragraph', content: [], depth: -3.7 } as Block],
    });

    expect(doc.blocks[0]?.depth).toBe(0);
  });

  test.each([
    ['an object map', { a: { type: 'paragraph' } }],
    ['a JSON string', '[{"type":"paragraph"}]'],
    ['a number', 7],
    ['null', null],
  ])('a `blocks` field that is %s degrades instead of throwing', (_label, blocksField) => {
    // The README says stored content is safe to hand straight to setDocument,
    // and none of these has a `.filter` — so trusting the declared type threw a
    // TypeError out of createEditor rather than opening an empty document.
    const doc = normalizeDocument({ blocks: blocksField } as unknown as { blocks: Block[] });

    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]?.type).toBe('paragraph');
  });
});

describe('markdown serialization', () => {
  test('every block type round-trips to its markdown form', () => {
    const list = blocks(
      ['heading1', 'Title'],
      ['paragraph', 'Body text.'],
      ['bulleted_list', 'First'],
      ['numbered_list', 'Step'],
      ['quote', 'Quoted'],
      ['divider', ''],
    );

    const [todo] = blocks(['todo', 'Done']);
    const checked = updateBlock([todo!], todo!.id, { checked: true });

    const markdown = toMarkdown({ blocks: [...list, ...checked] });

    expect(markdown).toContain('# Title');
    expect(markdown).toContain('- First');
    expect(markdown).toContain('1. Step');
    expect(markdown).toContain('> Quoted');
    expect(markdown).toContain('---');
    expect(markdown).toContain('- [x] Done');
  });

  test('nesting is indented', () => {
    const list = blocks(['bulleted_list', 'parent', 0], ['bulleted_list', 'child', 1]);

    expect(toMarkdown({ blocks: list })).toContain('  - child');
  });
});

describe('legacy documents', () => {
  test('a pre-rich-text `text` string is migrated to runs', () => {
    const doc = normalizeDocument({
      blocks: [{ id: 'a', type: 'paragraph', text: 'hello', depth: 0 } as unknown as Block],
    });

    expect(doc.blocks[0]?.content).toEqual([{ text: 'hello' }]);
    expect(blockText(doc.blocks[0]!)).toBe('hello');
  });

  test('rich content wins when both fields are present', () => {
    const doc = normalizeDocument({
      blocks: [
        {
          id: 'a',
          type: 'paragraph',
          text: 'stale',
          content: [{ text: 'fresh', marks: ['bold'] }],
          depth: 0,
        } as unknown as Block,
      ],
    });

    expect(doc.blocks[0]?.content).toEqual([{ text: 'fresh', marks: ['bold'] }]);
  });

  test('a divider never carries content, whatever it was given', () => {
    const doc = normalizeDocument({
      blocks: [{ id: 'a', type: 'divider', text: 'junk', depth: 0 } as unknown as Block],
    });

    expect(doc.blocks[0]?.content).toEqual([]);
  });

  test('unknown mark names are dropped rather than trusted', () => {
    const doc = normalizeDocument({
      blocks: [
        {
          id: 'a',
          type: 'paragraph',
          content: [{ text: 'x', marks: ['bold', 'blink'] }],
          depth: 0,
        } as unknown as Block,
      ],
    });

    expect(doc.blocks[0]?.content).toEqual([{ text: 'x', marks: ['bold'] }]);
  });
});

describe('rich markdown serialization', () => {
  test('marks become their delimiters, innermost first', () => {
    let content = richFromPlainText('plain bold code');
    content = richSetMark(content, 6, 10, 'bold', true);
    content = richSetMark(content, 11, 15, 'code', true);

    const block = { ...createBlock('paragraph'), content };

    expect(toMarkdown({ blocks: [block] })).toBe('plain **bold** `code`');
  });

  test('a link wraps its marks', () => {
    let content = richFromPlainText('see docs');
    content = richSetMark(content, 4, 8, 'bold', true);
    content = richSetLink(content, 4, 8, 'https://a.test/');

    const block = { ...createBlock('paragraph'), content };

    expect(toMarkdown({ blocks: [block] })).toBe('see [**docs**](https://a.test/)');
  });

  test('surrounding whitespace is hoisted outside the delimiters', () => {
    // `**bold **` is not emphasis in any Markdown dialect.
    const content = richSetMark(richFromPlainText('a bold b'), 2, 7, 'bold', true);
    const block = { ...createBlock('paragraph'), content };

    expect(toMarkdown({ blocks: [block] })).toBe('a **bold** b');
  });

  test('a code block is emitted literally, not re-escaped', () => {
    const content = richFromPlainText('const a = **not bold**;');
    const block = { ...createBlock('code'), content };

    expect(toMarkdown({ blocks: [block] })).toContain('const a = **not bold**;');
  });

  test('the fence is longer than any backtick run in the code', () => {
    const block = { ...createBlock('code'), content: richFromPlainText('```js\nx\n```') };

    // A three-backtick fence would be closed by the first line of its own
    // payload, and the block would come back as three.
    expect(toMarkdown({ blocks: [block] })).toBe('````\n```js\nx\n```\n````');
  });

  test('a destination holding a paren is written in angle brackets', () => {
    const content = richSetLink(richFromPlainText('Mercury'), 0, 7, 'https://a.test/M_(planet)');
    const block = { ...createBlock('paragraph'), content };

    expect(toMarkdown({ blocks: [block] })).toBe('[Mercury](<https://a.test/M_(planet)>)');
  });

  test('an empty block is written as a bare marker', () => {
    const empty = [
      createBlock('heading1'),
      createBlock('todo'),
      { ...createBlock('callout'), icon: '★' },
    ];

    expect(toMarkdown({ blocks: empty })).toBe('#\n\n- [ ]\n\n> [!★]');
  });

  test('a callout names its icon in brackets, so a quote cannot imitate it', () => {
    const block = { ...createBlock('callout', 'note'), icon: '→' };

    expect(toMarkdown({ blocks: [block] })).toBe('> [!→] note');
  });

  test('a paragraph that reads as a divider is escaped', () => {
    expect(toMarkdown({ blocks: [createBlock('paragraph', '---')] })).toBe('\\---');
  });

  test('converting to a code block strips inline marks', () => {
    const content = richSetMark(richFromPlainText('abc'), 0, 3, 'bold', true);
    const block = { ...createBlock('paragraph'), content };
    const converted = setBlockType([block], block.id, 'code');

    expect(converted[0]?.content).toEqual([{ text: 'abc' }]);
  });
});

describe('a bullet whose text opens with a toggle marker', () => {
  const bullet = (text: string): Block => ({
    id: 'b',
    type: 'bulleted_list',
    depth: 0,
    content: [{ text }],
  });

  test.each(['▾', '▾ collapsed', ' ▾ collapsed', '\t▾ x', '  ▸ y'])(
    'stays a bullet and keeps its triangle: %j',
    (text) => {
      // The reader's bullet prefix consumes the marker AND the whitespace after
      // it, so a triangle behind a space still arrives where a toggle's marker
      // is read. Escaping only at offset 0 left these turning into toggles with
      // the triangle eaten.
      const back = normalizeDocument({
        blocks: blocksFromMarkdown(toMarkdown({ blocks: [bullet(text)] })),
      }).blocks[0]!;

      expect(back.type).toBe('bulleted_list');
      expect(blockText(back)).toContain(text.trim().charAt(0));
    },
  );

  test('an empty toggle is still written as one', () => {
    const back = normalizeDocument({
      blocks: blocksFromMarkdown(
        toMarkdown({ blocks: [{ id: 't', type: 'toggle', depth: 0, content: [] }] }),
      ),
    }).blocks[0]!;

    expect(back.type).toBe('toggle');
  });

  test('ordinary prose keeps its triangle unescaped, for every other reader', () => {
    expect(
      toMarkdown({
        blocks: [{ id: 'p', type: 'paragraph', depth: 0, content: [{ text: 'press ▾ now' }] }],
      }),
    ).toBe('press ▾ now');
  });
});

describe('a bullet whose triangle sits behind a soft break', () => {
  const bullet = (text: string): Block => ({
    id: 'b',
    type: 'bulleted_list',
    depth: 0,
    content: [{ text }],
  });

  test.each(['\n▾ x', '\n\n▸ y', ' ▾ x', '▾ x'])('stays a bullet: %j', (text) => {
    // escapeMarkdownText writes a leading newline as `\` + newline, so a bare
    // `\s*` prefix stopped at that backslash and never escaped the triangle.
    const back = normalizeDocument({
      blocks: blocksFromMarkdown(toMarkdown({ blocks: [bullet(text)] })),
    }).blocks[0]!;

    expect(back.type).toBe('bulleted_list');
    expect(blockText(back)).toContain(text.trim().charAt(0));
  });
});

describe('normalizeDocument is the boundary, so it degrades instead of throwing', () => {
  /**
   * A table cell is an array of runs. A stored document whose cells are bare
   * `{ text }` objects -- a plausible hand-written or legacy shape -- reached
   * `normalizeRuns` unguarded and threw `runs is not iterable`, which took
   * `createEditor` and `setDocument` down with it and left the host element
   * empty. Every other malformed field already degraded quietly; this was the
   * one that crashed.
   */
  test('a table whose cells are single runs is read, not thrown on', () => {
    const doc = normalizeDocument({
      blocks: [
        {
          id: 't1',
          type: 'table',
          depth: 0,
          content: [],
          rows: [[{ text: 'Name' }, { text: 'Qty' }]],
        } as unknown as Block,
      ],
    });

    expect(doc.blocks[0]?.rows?.[0]?.[0]).toEqual([{ text: 'Name' }]);
    expect(doc.blocks[0]?.rows?.[0]?.[1]).toEqual([{ text: 'Qty' }]);
  });

  test('a cell holding something that is not a run at all becomes empty', () => {
    for (const cell of [42, true, 'text']) {
      const doc = normalizeDocument({
        blocks: [
          { id: 't', type: 'table', depth: 0, content: [], rows: [[cell]] } as unknown as Block,
        ],
      });

      expect(doc.blocks[0]?.rows?.[0]?.[0], `cell ${JSON.stringify(cell)}`).toEqual([]);
    }
  });
});

describe('a code block holds what its serializers can carry, and no more', () => {
  /**
   * `toMarkdown` writes a fence, and CommonMark reads a fence's content
   * verbatim; `blocksFromHtml` takes a `<pre>` as its text. Marks and links
   * held here therefore survived in the model and nowhere else --
   * `blocksToHtml` wrote an `<a>` inside the `<pre>` that reading the same
   * clipboard back discarded, so a copy-paste destroyed it silently.
   */
  test('normalizeDocument drops formatting a fence cannot carry', () => {
    const doc = normalizeDocument({
      blocks: [
        {
          id: 'c',
          type: 'code',
          depth: 0,
          content: [{ text: 'see docs', marks: ['bold'], link: 'https://a.test/x' }],
        } as unknown as Block,
      ],
    });

    expect(doc.blocks[0]?.content).toEqual([{ text: 'see docs' }]);
  });

  test('converting a formatted block to code drops it too', () => {
    const blocks = setBlockType(
      [
        {
          id: 'p',
          type: 'paragraph',
          depth: 0,
          content: [{ text: 'see docs', marks: ['bold'], link: 'https://a.test/x' }],
        },
      ],
      'p',
      'code',
    );

    expect(blocks[0]?.content).toEqual([{ text: 'see docs' }]);
  });

  test('every other block type keeps its link', () => {
    const doc = normalizeDocument({
      blocks: [
        {
          id: 'p',
          type: 'paragraph',
          depth: 0,
          content: [{ text: 'see docs', link: 'https://a.test/x' }],
        } as unknown as Block,
      ],
    });

    expect(doc.blocks[0]?.content[0]?.link).toBe('https://a.test/x');
  });
});

describe('a mark or link that spans a soft break', () => {
  /**
   * Every inline pattern in the reader excludes `\n`, so no rule can match a
   * span crossing one. The writer wrapped the whole run anyway, so
   * `**one\<break>two**` came back as literal asterisks sitting in the prose
   * with the bold gone -- not a dropped mark but visible corruption. Reachable
   * with Shift+Enter inside bold text, and by pasting `<b>one<br>two</b>`.
   *
   * The writer emits one span per line now. What that does not restore is the
   * newline's own marks: it comes back as a bare run between two marked ones
   * rather than inside a single marked run. That is invisible -- a newline has
   * no formatting to see -- but it is not a byte-identical round trip, and the
   * assertions below say so rather than implying otherwise.
   */
  const roundTrip = (content: TextRun[]): TextRun[] =>
    normalizeDocument({
      blocks: blocksFromMarkdown(
        toMarkdown(
          normalizeDocument({
            blocks: [{ id: 'p', type: 'paragraph', depth: 0, content } as Block],
          }),
        ),
      ),
    }).blocks[0]!.content;

  test.each([
    ['bold', ['bold'] as Mark[], undefined],
    ['italic', ['italic'] as Mark[], undefined],
    ['strikethrough', ['strikethrough'] as Mark[], undefined],
    ['code', ['code'] as Mark[], undefined],
    ['underline', ['underline'] as Mark[], undefined],
  ])('%s survives the break, on both sides of it', (_name, marks) => {
    const back = roundTrip([{ text: 'one\ntwo', marks }]);

    expect(back.map((run) => run.text).join('')).toBe('one\ntwo');
    expect(back.filter((run) => run.text === 'one' || run.text === 'two')).toHaveLength(2);

    expect(
      back.filter((run) => run.text !== '\n').map((run) => run.marks),
      'every run but the break itself keeps the mark',
    ).toEqual(back.filter((run) => run.text !== '\n').map(() => marks));
  });

  test('a link survives it too, and keeps its destination', () => {
    const back = roundTrip([{ text: 'line one\nline two', link: 'https://example.com/docs' }]);

    expect(back.map((run) => run.text).join('')).toBe('line one\nline two');
    expect(back.filter((run) => run.link === 'https://example.com/docs')).toHaveLength(2);
  });

  test('no raw delimiter is left in the text', () => {
    for (const marks of [
      ['bold'],
      ['italic'],
      ['strikethrough'],
      ['code'],
      ['underline'],
    ] as Mark[][]) {
      const text = roundTrip([{ text: 'one\ntwo', marks }])
        .map((run) => run.text)
        .join('');

      expect(text, `marks: ${marks.join()}`).toBe('one\ntwo');
    }
  });

  test('an unmarked break is unaffected', () => {
    expect(roundTrip([{ text: 'one\ntwo' }])).toEqual([{ text: 'one\ntwo' }]);
  });
});

describe('a span longer than the reader will look back', () => {
  /**
   * The reader will not search further than `INLINE_SPAN_LIMIT` characters back
   * for an opening delimiter, and the writer had no matching bound -- so
   * selecting a long paragraph, pressing Cmd+B and exporting gave back the raw
   * `**` at each end with the formatting gone. One gesture, visible corruption.
   * The writer splits at a space now, which renders identically and reads back.
   */
  const words = (count: number): string =>
    Array.from({ length: count }, (_, index) => `w${index}`).join(' ');

  const roundTrip = (content: TextRun[]): TextRun[] =>
    normalizeDocument({
      blocks: blocksFromMarkdown(
        toMarkdown(
          normalizeDocument({
            blocks: [{ id: 'p', type: 'paragraph', depth: 0, content } as Block],
          }),
        ),
      ),
    }).blocks[0]!.content;

  test.each([
    ['bold', { marks: ['bold'] as Mark[] }],
    ['italic', { marks: ['italic'] as Mark[] }],
    ['a link', { link: 'https://example.com/x' }],
  ])('%s over 2500 characters keeps its text and its formatting', (_name, extra) => {
    const text = words(700);

    expect(text.length).toBeGreaterThan(2000);

    const back = roundTrip([{ text, ...extra }]);
    const formatted = back
      .filter((run) => (run.marks ?? []).length > 0 || run.link !== undefined)
      .map((run) => run.text.length)
      .reduce((total, length) => total + length, 0);

    expect(back.map((run) => run.text).join('')).toBe(text);
    expect(back.map((run) => run.text).join('')).not.toContain('**');
    // All but the space each split lands on, which is the same residue the
    // soft-break split leaves and is invisible either way.
    expect(formatted).toBeGreaterThan(text.length - 5);
  });

  test('a span inside the bound is still written as one', () => {
    const text = words(300);
    const back = roundTrip([{ text, marks: ['bold'] }]);

    expect(back).toHaveLength(1);
    expect(back[0]?.marks).toEqual(['bold']);
  });

  /**
   * Stated rather than hidden: a single unbroken token past the bound has no
   * space to split at, and splitting it anywhere else would change the text.
   * Nothing a person types looks like this.
   */
  test('one unbroken token past the bound is the case that still does not survive', () => {
    const back = roundTrip([{ text: 'x'.repeat(2500), marks: ['bold'] }]);

    expect(back.every((run) => (run.marks ?? []).length === 0)).toBe(true);
  });
});

describe('withHiddenDescendants scales with the selection, not with the document', () => {
  /**
   * It called `findBlock` -- a linear scan -- once per selected id, so every
   * select-all gesture (copy, cut, delete, duplicate, indent, paste-over,
   * drag-drop, Cmd+Shift+Arrow) cost selection x document.
   *
   * Counted, not timed. This was a stopwatch: a ratio between a 500-block
   * document and a 5000-block one, asserted under 15. It failed 5 runs in 15 on
   * a CI runner while failing 0 in 15 here, because the small side of the ratio
   * was 19 microseconds and scheduler noise is bigger than that. Larger
   * documents make it worse rather than better -- the healthy ratio climbed
   * 6.3 -> 14.5 -> 17.6 as the pair grew 500/5000 -> 1000/10000 -> 2000/20000,
   * because the one-time index build stops dominating the small side. There is
   * no threshold that is both stable and meaningful.
   *
   * What the stopwatch was reaching for is a count, so count it. A scan reads
   * array SLOTS, and that is what is metered here -- not reads of `.id`, which
   * meters only one way of spelling a scan. `blocks.indexOf(block)` is the same
   * quadratic defect and reads no id at all; metering ids scores it clean.
   */
  /**
   * A document of collapsed sections: one collapsed toggle holding two
   * children, then a plain paragraph, repeating.
   *
   * The toggles are a FRACTION of the document, not a fixed number of them,
   * and that is the whole design. `descendantsOf` is a scan, so the cost it
   * adds is toggles x document -- which is only quadratic if the toggle count
   * grows with the document. A fixture with four toggles in it leaves the old
   * implementation at four passes, indistinguishable from linear, and the
   * guard passes on the defect. It did: that version of this fixture scored
   * the pre-fix code clean.
   */
  const documentOf = (count: number): Block[] => {
    const blocks: Block[] = [];

    while (blocks.length < count) {
      const at = blocks.length;

      if (at + 4 <= count) {
        blocks.push(
          { id: `t${at}`, type: 'toggle', depth: 0, collapsed: true, content: [] },
          { id: `c${at + 1}`, type: 'paragraph', depth: 1, content: [] },
          { id: `c${at + 2}`, type: 'paragraph', depth: 1, content: [] },
          { id: `b${at + 3}`, type: 'paragraph', depth: 0, content: [] },
        );
        continue;
      }

      blocks.push({ id: `b${at}`, type: 'paragraph', depth: 0, content: [] });
    }

    return blocks;
  };

  /**
   * Slot reads caused by growing a select-all over the whole document.
   *
   * The proxy counts reads of a numeric index and nothing else, so `length`,
   * iteration protocol and method lookups do not inflate it. Every scan spelled
   * any way -- `find`, `findIndex`, `indexOf`, `slice`, a hand-rolled loop --
   * goes through it.
   */
  const slotReads = (blocks: Block[]): number => {
    let reads = 0;
    const metered = new Proxy(blocks, {
      get(target, key, receiver) {
        if (typeof key === 'string' && key !== '' && !Number.isNaN(Number(key))) {
          reads += 1;
        }

        return Reflect.get(target, key, receiver) as unknown;
      },
    });

    // Select-all, so the answer can only be the whole document. A wrong size
    // means the count below is of something other than the work being claimed,
    // and an implementation that returns nothing cannot score a clean zero.
    expect(
      withHiddenDescendants(
        metered,
        blocks.map((block) => block.id),
      ).size,
    ).toBe(blocks.length);

    return reads;
  };

  /**
   * The vacuity check. Every assertion below is an upper bound, which a meter
   * wired to nothing satisfies perfectly -- so one test has to fail if the
   * proxy ever stops counting.
   */
  test('the meter counts slot reads, and only slot reads', () => {
    let reads = 0;
    const blocks: Block[] = [{ id: 'a', type: 'paragraph', depth: 0, content: [] }];
    const metered = new Proxy(blocks, {
      get(target, key, receiver) {
        if (typeof key === 'string' && key !== '' && !Number.isNaN(Number(key))) {
          reads += 1;
        }

        return Reflect.get(target, key, receiver) as unknown;
      },
    });

    expect(reads).toBe(0);
    expect(metered.length).toBe(1);
    expect(reads).toBe(0);
    expect(metered[0]!.id).toBe('a');
    expect(reads).toBe(1);
  });

  /**
   * The claim: the work is a bounded number of passes over the document, not a
   * pass per selected block.
   *
   * Bounded rather than exact. The current implementation reads about 4.3 slots
   * per block, and pinning that number would red the build on rewrites that are
   * strictly better -- indexing only toggles, or skipping the walk when nothing
   * is collapsed. Eight passes leaves room for those without leaving room for a
   * scan: the defect read 202 per block through `indexOf` and 800 through
   * `find`, both more than an order of magnitude over.
   */
  const PASSES = 8;

  test.each([[200], [1600]])(
    'select-all over %i blocks costs a few passes over the document, not one per block',
    (count) => {
      const blocks = documentOf(count);
      const reads = slotReads(blocks);

      expect(reads).toBeGreaterThan(0);
      expect(
        reads / count,
        `${reads} slot reads over ${count} blocks is ${(reads / count).toFixed(1)} passes`,
      ).toBeLessThanOrEqual(PASSES);
    },
  );

  /**
   * A constant bound alone admits a partial revert -- a scan for some ids and
   * the index for the rest stays under eight passes at one size. Growth is what
   * catches those: eight times the document costs eight times the work if the
   * cost is linear in the document, and sixty-four times if it is linear in
   * document x selection.
   *
   * Measured at these sizes: 8.0 indexed, 59.9 with `indexOf`, 62.6 with the
   * `descendantsOf` scan this replaced, 63.7 with `find`. Sixteen sits with a
   * factor of two above the healthy number and nearly four below the defect.
   */
  test('eight times the document is eight times the work, not sixty-four', () => {
    const small = slotReads(documentOf(200));
    const large = slotReads(documentOf(1600));

    expect(
      large / small,
      `${small} slot reads at 200 blocks, ${large} at 1600 -- a factor of ${(large / small).toFixed(1)}`,
    ).toBeLessThan(16);
  });

  /**
   * The fixture carries collapsed toggles because only a selected collapsed
   * toggle reaches `descendantsOf`. The stopwatch this replaced used plain
   * paragraphs, so it never ran that half of the function -- and that half was
   * still quadratic the whole time it was passing. Select-all over 16k
   * collapsed blocks cost 149ms against 1.2ms for the same count of paragraphs,
   * and doubling the document quadrupled it.
   */
  test('a document of collapsed sections is not more expensive than one of paragraphs', () => {
    const count = 1600;
    const collapsed = slotReads(documentOf(count));
    const flat = slotReads(
      Array.from({ length: count }, (_, at) => ({
        id: `b${at}`,
        type: 'paragraph' as const,
        depth: 0,
        content: [],
      })),
    );

    expect(
      collapsed / flat,
      `${collapsed} slot reads with toggles against ${flat} without`,
    ).toBeLessThan(4);
  });

  test('a collapsed toggle still hides everything under it', () => {
    const blocks = [
      { id: 't', type: 'toggle', depth: 0, collapsed: true, content: [] },
      { id: 'k', type: 'paragraph', depth: 1, content: [] },
      { id: 'j', type: 'paragraph', depth: 2, content: [] },
      { id: 'after', type: 'paragraph', depth: 0, content: [] },
    ] as Block[];

    expect([...withHiddenDescendants(blocks, ['t'])].sort()).toEqual(['j', 'k', 't']);
  });

  test('an expanded one hides nothing', () => {
    const blocks = [
      { id: 't', type: 'toggle', depth: 0, collapsed: false, content: [] },
      { id: 'k', type: 'paragraph', depth: 1, content: [] },
    ] as Block[];

    expect([...withHiddenDescendants(blocks, ['t'])]).toEqual(['t']);
  });
});

describe('a span is split only when it is really too long to read back', () => {
  /**
   * The split tested the raw text against three quarters of the reader's limit,
   * so runs between about 1500 and 2000 characters were split -- and their
   * round trip gained an unmarked space -- when the reader would have read them
   * whole. It measures what is actually emitted now.
   */
  const words = (count: number): string =>
    Array.from({ length: count }, (_, index) => `w${index}`).join(' ');

  const runsAfterRoundTrip = (text: string): TextRun[] =>
    normalizeDocument({
      blocks: blocksFromMarkdown(
        toMarkdown(
          normalizeDocument({
            blocks: [
              {
                id: 'p',
                type: 'paragraph',
                depth: 0,
                content: [{ text, marks: ['bold'] }],
              } as Block,
            ],
          }),
        ),
      ),
    }).blocks[0]!.content;

  test.each([300, 400])('a run of about %i words stays one span', (count) => {
    const text = words(count);

    expect(text.length).toBeGreaterThan(1300);
    expect(text.length).toBeLessThan(2000);

    const back = runsAfterRoundTrip(text);

    expect(back).toHaveLength(1);
    expect(back[0]?.text).toBe(text);
    expect(back[0]?.marks).toEqual(['bold']);
  });

  test('and one past the limit still splits', () => {
    const text = words(700);

    expect(text.length).toBeGreaterThan(2000);

    const back = runsAfterRoundTrip(text);

    expect(back.length).toBeGreaterThan(1);
    expect(back.map((run) => run.text).join('')).toBe(text);
  });
});
