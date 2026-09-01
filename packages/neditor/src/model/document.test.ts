import { describe, expect, test } from 'vitest';

import { matchInputRule } from '../input/input-rules.ts';
import type { Block } from './document.ts';
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

  test('converting to a code block strips inline marks', () => {
    const content = richSetMark(richFromPlainText('abc'), 0, 3, 'bold', true);
    const block = { ...createBlock('paragraph'), content };
    const converted = setBlockType([block], block.id, 'code');

    expect(converted[0]?.content).toEqual([{ text: 'abc' }]);
  });
});
