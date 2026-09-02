import { describe, expect, test } from 'vitest';

import type { Block } from './document.ts';
import {
  DEFAULT_CALLOUT_ICON,
  MAX_DEPTH,
  acceptsChildren,
  blockIdRange,
  blockText,
  computeListNumbers,
  createBlock,
  descendantsOf,
  duplicateBlocks,
  indentBlock,
  indentBlocks,
  hiddenBlockIds,
  moveBlock,
  moveBlocks,
  normalizeDepths,
  normalizeDocument,
  removeBlocks,
  setBlockType,
  sliceDocument,
  visibleBlocks,
  withHiddenDescendants,
} from './document.ts';

/** Builds a list from `[text, depth]` pairs and exposes ids by text. */
function build(...specs: Array<[string, number?]>): {
  blocks: Block[];
  id: (text: string) => string;
  ids: (...texts: string[]) => Set<string>;
} {
  const blocks = specs.map(([text, depth]) => createBlock('paragraph', text, depth ?? 0));
  const id = (text: string) => blocks.find((b) => blockText(b) === text)!.id;

  return { blocks, id, ids: (...texts) => new Set(texts.map(id)) };
}

const texts = (blocks: readonly Block[]) => blocks.map(blockText);

/**
 * Freezes a block list and everything reachable from it.
 *
 * Every structural operation must return new values; snapshot-based undo is
 * only sound because nothing is ever written in place. Under strict mode a
 * frozen write throws, so this turns a silent violation into a failure.
 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);

    for (const inner of Object.values(value as Record<string, unknown>)) {
      deepFreeze(inner);
    }
  }

  return value;
}
const depths = (blocks: readonly Block[]) => blocks.map((b) => b.depth);

describe('normalizeDepths', () => {
  test('the first block is always at the root', () => {
    const { blocks } = build(['a', 3]);

    expect(depths(normalizeDepths(blocks))).toEqual([0]);
  });

  test('a block can never be more than one level below its predecessor', () => {
    const { blocks } = build(['a', 0], ['b', 3], ['c', 5]);

    expect(depths(normalizeDepths(blocks))).toEqual([0, 1, 2]);
  });

  test('valid depths are left alone, and the objects are reused', () => {
    const { blocks } = build(['a', 0], ['b', 1], ['c', 1], ['d', 0]);
    const result = normalizeDepths(blocks);

    expect(depths(result)).toEqual([0, 1, 1, 0]);
    expect(result[0]).toBe(blocks[0]);
  });

  test('no block passes MAX_DEPTH, however legal the step to it looks', () => {
    // Each of these is one level below its predecessor, so the "one level at a
    // time" rule alone accepts every one of them.
    const { blocks } = build(
      ...Array.from({ length: MAX_DEPTH + 5 }, (_, i): [string, number] => [`b${i}`, i]),
    );

    expect(Math.max(...depths(normalizeDepths(blocks)))).toBe(MAX_DEPTH);
  });
});

/**
 * MAX_DEPTH used to be a load-time clamp only, which made it a data loss rather
 * than a limit: the editor indented past it happily, and `normalizeDocument`
 * folded every level above 32 into 32 on the next load. Nesting the user could
 * see vanished on reload, and undo could not bring it back.
 */
describe('MAX_DEPTH survives a save/load round trip', () => {
  const deep = () =>
    build(...Array.from({ length: MAX_DEPTH + 3 }, (_, i): [string, number] => [`b${i}`, i]));

  test('indentBlocks cannot push a block past the ceiling', () => {
    const { blocks, ids } = deep();
    const last = blocks.at(-1)!;
    const pushed = indentBlocks(normalizeDepths(blocks), ids(blockText(last)), 1);

    expect(pushed.at(-1)?.depth).toBe(MAX_DEPTH);
  });

  test('indentBlock cannot either, and reports the Tab as the no-op it is', () => {
    const { blocks, id } = deep();
    const normalized = normalizeDepths(blocks);
    const last = normalized.at(-1)!;
    const pushed = indentBlock(normalized, id(blockText(last)), 1);

    expect(pushed.at(-1)?.depth).toBe(MAX_DEPTH);
    // Nothing moved, so nothing was rebuilt — otherwise Tab at the ceiling
    // records an undo entry for a keystroke with no effect.
    expect(pushed.at(-1)).toBe(last);
  });

  test('what the editor produces is what normalizeDocument accepts back', () => {
    const edited = normalizeDepths(deep().blocks);
    const reloaded = normalizeDocument({ blocks: edited });

    expect(depths(reloaded.blocks)).toEqual(depths(edited));
  });
});

describe('blockIdRange', () => {
  test('covers both endpoints in document order', () => {
    const { blocks, id } = build(['a'], ['b'], ['c'], ['d']);

    expect(blockIdRange(blocks, id('b'), id('d'))).toEqual([id('b'), id('c'), id('d')]);
  });

  test('is direction-agnostic', () => {
    const { blocks, id } = build(['a'], ['b'], ['c']);

    expect(blockIdRange(blocks, id('c'), id('a'))).toEqual([id('a'), id('b'), id('c')]);
  });

  test('a single block is its own range', () => {
    const { blocks, id } = build(['a'], ['b']);

    expect(blockIdRange(blocks, id('a'), id('a'))).toEqual([id('a')]);
  });

  test('an unknown id yields nothing', () => {
    const { blocks, id } = build(['a']);

    expect(blockIdRange(blocks, id('a'), 'missing')).toEqual([]);
  });
});

describe('removeBlocks', () => {
  test('removes every selected block', () => {
    const { blocks, ids } = build(['a'], ['b'], ['c']);

    expect(texts(removeBlocks(blocks, ids('a', 'c')))).toEqual(['b']);
  });

  test('clearing everything leaves one empty paragraph', () => {
    const { blocks, ids } = build(['a'], ['b']);
    const result = removeBlocks(blocks, ids('a', 'b'));

    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('paragraph');
    expect(blockText(result[0]!)).toBe('');
  });

  test('orphaned children are pulled back to a legal depth', () => {
    // Removing the parent would leave "b" indented under nothing.
    const { blocks, ids } = build(['a', 0], ['b', 1]);

    expect(depths(removeBlocks(blocks, ids('a')))).toEqual([0]);
  });

  test('does not mutate the input', () => {
    const { blocks, ids } = build(['a'], ['b']);
    // Deep-frozen, not shallow-copied: `[...blocks]` shares the same block
    // objects, so toEqual would compare each block with itself and pass even if
    // the function mutated in place. History snapshots share these references.
    deepFreeze(blocks);

    expect(() => removeBlocks(blocks, ids('a'))).not.toThrow();
  });
});

describe('moveBlocks', () => {
  test('moves a block down to a later gap', () => {
    const { blocks, ids } = build(['a'], ['b'], ['c']);

    // Gap 3 is below "c" in the original coordinates.
    expect(texts(moveBlocks(blocks, ids('a'), 3))).toEqual(['b', 'c', 'a']);
  });

  test('moves a block up to an earlier gap', () => {
    const { blocks, ids } = build(['a'], ['b'], ['c']);

    expect(texts(moveBlocks(blocks, ids('c'), 0))).toEqual(['c', 'a', 'b']);
  });

  test('dropping a block back where it started changes nothing', () => {
    const { blocks, ids } = build(['a'], ['b'], ['c']);

    expect(texts(moveBlocks(blocks, ids('b'), 1))).toEqual(['a', 'b', 'c']);
    expect(texts(moveBlocks(blocks, ids('b'), 2))).toEqual(['a', 'b', 'c']);
  });

  test('several blocks move together and keep their order', () => {
    const { blocks, ids } = build(['a'], ['b'], ['c'], ['d']);

    expect(texts(moveBlocks(blocks, ids('a', 'b'), 4))).toEqual(['c', 'd', 'a', 'b']);
  });

  test('a non-contiguous selection is gathered at the drop point', () => {
    const { blocks, ids } = build(['a'], ['b'], ['c'], ['d']);

    expect(texts(moveBlocks(blocks, ids('a', 'c'), 4))).toEqual(['b', 'd', 'a', 'c']);
  });

  test('the gap is interpreted in original coordinates', () => {
    // Moving "a" to gap 2 means "between b and c", not "index 2 after removal".
    const { blocks, ids } = build(['a'], ['b'], ['c']);

    expect(texts(moveBlocks(blocks, ids('a'), 2))).toEqual(['b', 'a', 'c']);
  });

  test('out-of-range gaps clamp to the ends', () => {
    const { blocks, ids } = build(['a'], ['b']);

    expect(texts(moveBlocks(blocks, ids('a'), 99))).toEqual(['b', 'a']);
    expect(texts(moveBlocks(blocks, ids('b'), -5))).toEqual(['b', 'a']);
  });

  test('depth is re-clamped at the destination', () => {
    const { blocks, ids } = build(['a', 0], ['b', 1], ['c', 0]);

    // "b" was nested; moved to the top it cannot stay at depth 1.
    expect(depths(moveBlocks(blocks, ids('b'), 0))).toEqual([0, 0, 0]);
  });

  test('an empty selection is a no-op', () => {
    const { blocks } = build(['a'], ['b']);

    expect(texts(moveBlocks(blocks, new Set(), 0))).toEqual(['a', 'b']);
  });
});

describe('duplicateBlocks', () => {
  test('copies land below the lowest selected block', () => {
    const { blocks, ids } = build(['a'], ['b'], ['c']);
    const result = duplicateBlocks(blocks, ids('a'));

    expect(texts(result.blocks)).toEqual(['a', 'a', 'b', 'c']);
  });

  test('copies get fresh ids', () => {
    const { blocks, ids } = build(['a']);
    const result = duplicateBlocks(blocks, ids('a'));

    expect(result.ids).toHaveLength(1);
    expect(result.ids[0]).not.toBe(blocks[0]?.id);
    expect(result.blocks[1]?.id).toBe(result.ids[0]);
  });

  test('content is deep-copied, not shared', () => {
    const { blocks, ids } = build(['a']);
    const result = duplicateBlocks(blocks, ids('a'));

    expect(result.blocks[1]?.content).not.toBe(blocks[0]?.content);
    expect(result.blocks[1]?.content).toEqual(blocks[0]?.content);
  });

  test('a multi-block selection duplicates as a group', () => {
    const { blocks, ids } = build(['a'], ['b'], ['c']);

    expect(texts(duplicateBlocks(blocks, ids('a', 'b')).blocks)).toEqual(['a', 'b', 'a', 'b', 'c']);
  });

  test('an empty selection is a no-op', () => {
    const { blocks } = build(['a']);

    expect(duplicateBlocks(blocks, new Set()).ids).toEqual([]);
  });
});

describe('indentBlocks', () => {
  test('indents a group together', () => {
    const { blocks, ids } = build(['a', 0], ['b', 0], ['c', 0]);

    expect(depths(indentBlocks(blocks, ids('b', 'c'), 1))).toEqual([0, 1, 1]);
  });

  test('the leading block of a selection cannot outrun its predecessor', () => {
    const { blocks, ids } = build(['a', 0], ['b', 0]);

    // "b" may reach depth 1, and no further however hard it is pushed.
    const once = indentBlocks(blocks, ids('b'), 1);

    expect(depths(indentBlocks(once, ids('b'), 1))).toEqual([0, 1]);
  });

  test('outdent stops at the root', () => {
    const { blocks, ids } = build(['a', 0], ['b', 1]);

    expect(depths(indentBlocks(blocks, ids('b'), -1))).toEqual([0, 0]);
    expect(depths(indentBlocks(blocks, ids('a', 'b'), -1))).toEqual([0, 0]);
  });
});

describe('sliceDocument', () => {
  test('keeps only the selected blocks', () => {
    const { blocks, ids } = build(['a'], ['b'], ['c']);

    expect(texts(sliceDocument(blocks, ids('a', 'c')).blocks)).toEqual(['a', 'c']);
  });

  test('depths are re-rooted, so a nested copy pastes back at the top', () => {
    const { blocks, ids } = build(['a', 0], ['b', 1], ['c', 2]);

    expect(depths(sliceDocument(blocks, ids('b', 'c')).blocks)).toEqual([0, 1]);
  });

  test('an empty selection yields an empty document', () => {
    const { blocks } = build(['a']);

    expect(sliceDocument(blocks, new Set()).blocks).toEqual([]);
  });
});

describe('nesting and visibility', () => {
  /** `parent` with two children and an unrelated sibling after them. */
  function tree(collapsed: boolean): Block[] {
    const parent = createBlock('toggle', 'parent', 0);
    parent.collapsed = collapsed;

    return [
      parent,
      createBlock('paragraph', 'child one', 1),
      createBlock('paragraph', 'child two', 1),
      createBlock('paragraph', 'after', 0),
    ];
  }

  test('descendantsOf covers the contiguous deeper run', () => {
    const blocks = tree(false);

    expect(descendantsOf(blocks, blocks[0]!.id)).toEqual([blocks[1]!.id, blocks[2]!.id]);
  });

  test('descendantsOf stops at the first shallower block', () => {
    const blocks = tree(false);

    expect(descendantsOf(blocks, blocks[3]!.id)).toEqual([]);
  });

  test('an expanded toggle hides nothing', () => {
    expect(hiddenBlockIds(tree(false)).size).toBe(0);
    expect(visibleBlocks(tree(false))).toHaveLength(4);
  });

  test('a collapsed toggle hides exactly its descendants', () => {
    const blocks = tree(true);
    const hidden = hiddenBlockIds(blocks);

    expect([...hidden]).toEqual([blocks[1]!.id, blocks[2]!.id]);
    expect(visibleBlocks(blocks).map(blockText)).toEqual(['parent', 'after']);
  });

  test('a toggle nested in a collapsed one adds no second threshold', () => {
    const outer = createBlock('toggle', 'outer', 0);
    outer.collapsed = true;
    const inner = createBlock('toggle', 'inner', 1);
    inner.collapsed = false;

    const blocks = [
      outer,
      inner,
      createBlock('paragraph', 'deep', 2),
      createBlock('paragraph', 'after', 0),
    ];

    expect(visibleBlocks(blocks).map(blockText)).toEqual(['outer', 'after']);
  });

  test('an expanded toggle inside a collapsed one still hides its own children', () => {
    const outer = createBlock('toggle', 'outer', 0);
    outer.collapsed = false;
    const inner = createBlock('toggle', 'inner', 1);
    inner.collapsed = true;

    const blocks = [
      outer,
      inner,
      createBlock('paragraph', 'deep', 2),
      createBlock('paragraph', 'after', 0),
    ];

    expect(visibleBlocks(blocks).map(blockText)).toEqual(['outer', 'inner', 'after']);
  });

  test('a selection grows to carry the blocks it hides', () => {
    const blocks = tree(true);
    const grown = withHiddenDescendants(blocks, [blocks[0]!.id]);

    expect(grown).toEqual(new Set([blocks[0]!.id, blocks[1]!.id, blocks[2]!.id]));
  });

  test('visible children are left out; the user can see and select them', () => {
    const blocks = tree(false);

    expect(withHiddenDescendants(blocks, [blocks[0]!.id])).toEqual(new Set([blocks[0]!.id]));
  });

  test('deleting a collapsed toggle with its children leaves the rest intact', () => {
    const blocks = tree(true);
    const doomed = withHiddenDescendants(blocks, [blocks[0]!.id]);

    expect(removeBlocks(blocks, doomed).map(blockText)).toEqual(['after']);
  });
});

describe('callout and toggle fields', () => {
  test('a new callout gets the default icon', () => {
    expect(createBlock('callout').icon).toBe(DEFAULT_CALLOUT_ICON);
  });

  test('a new toggle starts expanded', () => {
    expect(createBlock('toggle').collapsed).toBe(false);
  });

  test('converting away clears the fields that no longer apply', () => {
    const callout = createBlock('callout', 'x');
    const asParagraph = setBlockType([callout], callout.id, 'paragraph');

    expect(asParagraph[0]?.icon).toBeUndefined();

    const toggle = createBlock('toggle', 'x');
    const asQuote = setBlockType([toggle], toggle.id, 'quote');

    expect(asQuote[0]?.collapsed).toBeUndefined();
  });

  test('converting into them supplies defaults', () => {
    const paragraph = createBlock('paragraph', 'x');

    expect(setBlockType([paragraph], paragraph.id, 'callout')[0]?.icon).toBe(DEFAULT_CALLOUT_ICON);
    expect(setBlockType([paragraph], paragraph.id, 'toggle')[0]?.collapsed).toBe(false);
  });

  test('only callouts and toggles adopt Enter as a child', () => {
    expect(acceptsChildren('callout')).toBe(true);
    expect(acceptsChildren('toggle')).toBe(true);
    expect(acceptsChildren('paragraph')).toBe(false);
    expect(acceptsChildren('quote')).toBe(false);
  });

  test('normalizeDocument fills in and repairs both fields', () => {
    const doc = normalizeDocument({
      blocks: [
        { id: 'a', type: 'callout', content: [], depth: 0 } as Block,
        { id: 'b', type: 'toggle', content: [], depth: 0, collapsed: 'yes' } as unknown as Block,
      ],
    });

    expect(doc.blocks[0]?.icon).toBe(DEFAULT_CALLOUT_ICON);
    expect(doc.blocks[1]?.collapsed).toBe(false);
  });
});

describe('ordered list numbering', () => {
  test('an indented block does not restart the outer list', () => {
    const blocks = [
      createBlock('numbered_list', 'first', 0),
      createBlock('paragraph', 'an indented note', 1),
      createBlock('numbered_list', 'second', 0),
    ];

    const numbers = computeListNumbers(blocks);

    expect(blocks.map((block) => numbers.get(block.id))).toEqual([1, undefined, 2]);
  });

  test('a block at the same depth does restart it', () => {
    const blocks = [
      createBlock('numbered_list', 'first', 0),
      createBlock('paragraph', 'a sibling paragraph', 0),
      createBlock('numbered_list', 'restarted', 0),
    ];

    const numbers = computeListNumbers(blocks);

    expect(blocks.map((block) => numbers.get(block.id))).toEqual([1, undefined, 1]);
  });
});

describe('indentBlock keeps the tree legal', () => {
  test('outdenting a parent re-clamps the children it leaves behind', () => {
    const { blocks, id } = build(['a', 0], ['parent', 1], ['child', 2]);
    const outdented = indentBlock(blocks, id('parent'), -1);

    // Un-normalized this is [0, 0, 2] — a child two levels under its parent.
    // Nothing looks wrong until an unrelated edit re-normalizes and the child
    // jumps left on its own.
    expect(depths(outdented)).toEqual([0, 0, 1]);
  });

  test('the result satisfies the depth invariant even with siblings below', () => {
    const { blocks, id } = build(['a', 0], ['b', 1], ['c', 2], ['d', 1]);
    const result = indentBlock(blocks, id('b'), -1);

    result.forEach((block: Block, index: number) => {
      const previous = result[index - 1];

      expect(block.depth).toBeLessThanOrEqual(previous ? previous.depth + 1 : 0);
    });
  });

  test('a no-op outdent at depth 0 leaves the depths alone', () => {
    const { blocks, id } = build(['parent', 0], ['child', 1]);

    expect(depths(indentBlock(blocks, id('parent'), -1))).toEqual([0, 1]);
  });
});

describe('moveBlock re-clamps depth like every other structural op', () => {
  test('moving a nested block above its parent flattens it', () => {
    const { blocks, id } = build(['a', 0], ['b', 1], ['p', 0]);

    // Un-clamped this is [1, 0, 0]: the first block in the document indented
    // under nothing, which README:201 promises can never happen.
    expect(depths(moveBlock(blocks, id('b'), -1))).toEqual([0, 0, 0]);
  });

  test('an ordinary move still moves', () => {
    const { blocks, id } = build(['a', 0], ['b', 0], ['c', 0]);
    const moved = moveBlock(blocks, id('a'), 1);

    expect(moved.map(blockText)).toEqual(['b', 'a', 'c']);
  });

  test('the result always satisfies the depth invariant', () => {
    const { blocks, id } = build(['a', 0], ['b', 1], ['c', 2], ['d', 0]);
    const moved = moveBlock(blocks, id('d'), -1);

    moved.forEach((block: Block, index: number) => {
      const previous = moved[index - 1];

      expect(block.depth).toBeLessThanOrEqual(previous ? previous.depth + 1 : 0);
    });
  });
});

describe('normalizeDocument enforces unique block ids', () => {
  const dup = (): Partial<Block>[] => [
    { id: 'dup', type: 'paragraph', depth: 0, content: [{ text: 'FIRST' }] },
    { id: 'dup', type: 'paragraph', depth: 0, content: [{ text: 'SECOND' }] },
    { id: 'z', type: 'paragraph', depth: 0, content: [{ text: 'TAIL' }] },
  ];

  test('a duplicated id is replaced, not kept', () => {
    const ids = normalizeDocument({ blocks: dup() as Block[] }).blocks.map((b) => b.id);

    // Ids key the renderer's view map and address every model op: a duplicate
    // renders one block only and makes each edit write to both.
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe('dup');
  });

  test('every block survives the repair with its own content', () => {
    const blocks = normalizeDocument({ blocks: dup() as Block[] }).blocks;

    expect(blocks.map(blockText)).toEqual(['FIRST', 'SECOND', 'TAIL']);
  });

  test('unique ids are left alone', () => {
    const ids = normalizeDocument({
      blocks: [
        { id: 'a', type: 'paragraph', depth: 0, content: [] },
        { id: 'b', type: 'paragraph', depth: 0, content: [] },
      ] as Block[],
    }).blocks.map((b) => b.id);

    expect(ids).toEqual(['a', 'b']);
  });
});
