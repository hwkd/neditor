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
  findBlockIndex,
  indentBlock,
  indentBlocks,
  hiddenBlockIds,
  moveBlock,
  moveBlocks,
  moveVisibleBlocks,
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

  test('a negative depth is the root, not a level above a later one', () => {
    const { blocks } = build(['a', -2], ['b', -1]);

    expect(depths(normalizeDepths(blocks))).toEqual([0, 0]);
  });

  test('a depth that is not a number is the root, even a numeric string', () => {
    // Compared as text, "10" sorts before "9", and both came back nested under a;
    // a host's stored JSON can carry either.
    const { blocks } = build(['a', 0], ['b', 0], ['c', 0]);
    const loose = [
      blocks[0]!,
      { ...blocks[1]!, depth: '9' as unknown as number },
      { ...blocks[2]!, depth: '10' as unknown as number },
    ];

    expect(depths(normalizeDepths(loose))).toEqual([0, 0, 0]);
  });

  test('a NaN depth is the root, and does not swallow what follows it', () => {
    const { blocks } = build(['a', 0], ['b', Number.NaN], ['c', 0]);

    expect(depths(normalizeDepths(blocks))).toEqual([0, 0, 0]);
  });

  test('no block passes MAX_DEPTH, however legal the step to it looks', () => {
    // Each of these is one level below its predecessor, so the "one level at a
    // time" rule alone accepts every one of them.
    const { blocks } = build(
      ...Array.from({ length: MAX_DEPTH + 5 }, (_, i): [string, number] => [`b${i}`, i]),
    );

    expect(Math.max(...depths(normalizeDepths(blocks)))).toBe(MAX_DEPTH);
  });

  /**
   * The re-clamp keeps the tree it was given: a block's parent is the nearest
   * shallower block above it, before and after. Clamping each block against
   * only its predecessor moved the toggle up and left its sibling behind, one
   * level deeper than the toggle -- inside it, and hidden when it is collapsed.
   */
  test('a block clamped shallower takes its siblings with it, not just its children', () => {
    // `parent` was removed from between `root` and the toggle.
    const blocks = [
      createBlock('paragraph', 'root', 0),
      { ...createBlock('toggle', 'toggle', 2), collapsed: true },
      createBlock('paragraph', 'hidden', 3),
      createBlock('paragraph', 'sibling', 2),
    ];
    const result = normalizeDepths(blocks);

    expect(depths(result)).toEqual([0, 1, 2, 1]);
    expect(texts(visibleBlocks(result))).toEqual(['root', 'toggle', 'sibling']);
    expect(descendantsOf(result, blocks[1]!.id)).toEqual([blocks[2]!.id]);
  });

  test('a block shallower than one clamped above it is never put under it', () => {
    // `b` and `c` both sit outside `x` (neither is deeper than 3), so neither
    // may end up as its child, wherever `x` lands.
    const { blocks } = build(['a', 0], ['x', 3], ['b', 2], ['c', 1]);

    expect(depths(normalizeDepths(blocks))).toEqual([0, 1, 1, 1]);
  });

  test('a first block deeper than the next does not adopt it', () => {
    const { blocks } = build(['a', 2], ['b', 1]);

    expect(depths(normalizeDepths(blocks))).toEqual([0, 0]);
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

  /** Each block's parent text, or null at the root: the tree, as a reader sees it. */
  const parents = (blocks: readonly Block[]) =>
    blocks.map((block, at) => {
      const parent = blocks
        .slice(0, at)
        .reverse()
        .find((above) => above.depth < block.depth);

      return [blockText(block), parent ? blockText(parent) : null];
    });

  // BL-2: a handle dropped between a parent's children kept its own depth,
  // and the children after the gap went to it -- "Child two" left the toggle
  // for the paragraph "Before", and collapsing the toggle no longer hid it.
  // A drop joins the children it lands among instead, and adopts none.
  test('a block dropped among a parent’s children joins them and adopts none', () => {
    const { blocks, ids } = build(['Before', 0], ['tg', 0], ['one', 1], ['two', 1], ['After', 0]);

    expect(parents(moveBlocks(blocks, ids('Before'), 3))).toEqual([
      ['tg', null],
      ['one', 'tg'],
      ['Before', 'tg'],
      ['two', 'tg'],
      ['After', null],
    ]);
  });

  test('so does one dropped between a list item and its own child', () => {
    const { blocks, ids } = build(['zero', 0], ['one', 1], ['two', 2], ['After', 0]);

    expect(parents(moveBlocks(blocks, ids('After'), 2))).toEqual([
      ['zero', null],
      ['one', 'zero'],
      ['After', 'one'],
      ['two', 'one'],
    ]);
  });

  test('a group dropped there keeps its own shape', () => {
    const { blocks, ids } = build(['tg', 0], ['one', 1], ['two', 1], ['p', 0], ['q', 1]);

    expect(parents(moveBlocks(blocks, ids('p', 'q'), 2))).toEqual([
      ['tg', null],
      ['one', 'tg'],
      ['p', 'tg'],
      ['q', 'p'],
      ['two', 'tg'],
    ]);
  });

  // A child of the moving block after the gap stays its child, as the
  // keyboard's move (`moveVisibleBlocks`) leaves it: the parent is not
  // pushed down among them.
  test('a parent dropped among its own children keeps the ones after the gap', () => {
    const { blocks, ids } = build(['Before', 0], ['tg', 0], ['one', 1], ['two', 1]);

    expect(parents(moveBlocks(blocks, ids('tg'), 3))).toEqual([
      ['Before', null],
      ['one', 'Before'],
      ['tg', null],
      ['two', 'tg'],
    ]);
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

describe('indentBlocks moves each block only as far as it can', () => {
  test('a block that cannot indent is returned untouched, and so is its child', () => {
    const { blocks, ids } = build(['Item1', 0], ['Sub', 1]);
    const result = indentBlocks(blocks, ids('Item1'), 1);

    expect(depths(result)).toEqual([0, 1]);
    result.forEach((block, index) => expect(block).toBe(blocks[index]));
  });

  test('a run whose first block cannot move indents the rest under it', () => {
    const { blocks, ids } = build(['A', 0], ['B', 0], ['C', 0]);

    expect(depths(indentBlocks(blocks, ids('A', 'B', 'C'), 1))).toEqual([0, 1, 1]);
  });

  test('a block at the ceiling beside a sibling there is returned untouched', () => {
    // `previous + 1` would allow 33 here; only the ceiling refuses it, and a
    // rebuilt block would make Tab look like an edit to `sameBlocks`.
    const { blocks, ids } = build(
      ...Array.from({ length: MAX_DEPTH + 1 }, (_, i): [string, number] => [`b${i}`, i]),
      ['c', MAX_DEPTH],
    );
    const result = indentBlocks(blocks, ids('c'), 1);

    expect(result.at(-1)).toBe(blocks.at(-1));
  });

  test('a block is pinned at the ceiling only by selected blocks it would carry', () => {
    // x could indent under c30; z cannot pass the ceiling, but y between them
    // is unselected, so x does not carry z and is free to move.
    const chain = Array.from({ length: MAX_DEPTH - 1 }, (_, i) =>
      createBlock('paragraph', `c${i}`, i),
    );
    const x = createBlock('paragraph', 'x', MAX_DEPTH - 2);
    const y = createBlock('paragraph', 'y', MAX_DEPTH - 1);
    const z = createBlock('paragraph', 'z', MAX_DEPTH);
    const result = indentBlocks([...chain, x, y, z], new Set([x.id, z.id]), 1);

    expect(result.find((block) => block.id === x.id)?.depth).toBe(MAX_DEPTH - 1);
  });

  test('a collapsed toggle just under the ceiling does not indent out of its hidden child', () => {
    const chain = Array.from({ length: MAX_DEPTH }, (_, i) => createBlock('paragraph', `c${i}`, i));
    const toggle = { ...createBlock('toggle', 'T', MAX_DEPTH - 1), collapsed: true };
    const hidden = createBlock('paragraph', 'h', MAX_DEPTH);
    // `c31` sits at the toggle's depth, so the toggle could indent under it.
    const blocks = [...chain, toggle, hidden];
    const result = indentBlocks(blocks, new Set([toggle.id, hidden.id]), 1);

    expect(result.at(-2)).toBe(toggle);
    expect(result.at(-1)).toBe(hidden);
    expect(hiddenBlockIds(result).has(hidden.id)).toBe(true);
  });
});

describe('copies keep the tree they were taken from', () => {
  test('a later, shallower block keeps its child in the clipboard', () => {
    const { blocks, ids } = build(['A', 2], ['B', 3], ['C', 1], ['D', 2]);

    expect(depths(sliceDocument(blocks, ids('A', 'B', 'C', 'D')).blocks)).toEqual([0, 1, 0, 1]);
  });

  test('copies of a selection that starts deeper than it ends stay at its depth, in its list', () => {
    // The floor is 1, not 0: the copies must be re-rooted there, neither left
    // at r's depth (where s would adopt the copy of r) nor sent to the root.
    const { blocks, ids } = build(['P', 0], ['q', 1], ['r', 2], ['s', 1], ['Z', 0]);
    const result = duplicateBlocks(blocks, ids('r', 's'));

    expect(texts(result.blocks)).toEqual(['P', 'q', 'r', 's', 'r', 's', 'Z']);
    expect(depths(result.blocks)).toEqual([0, 1, 2, 1, 1, 1, 0]);
  });

  test('a parent duplicated with its first child keeps its second', () => {
    const { blocks, ids, id } = build(['A', 0], ['a1', 1], ['a2', 1], ['B', 0]);
    const result = duplicateBlocks(blocks, ids('A', 'a1'));

    expect(texts(result.blocks)).toEqual(['A', 'a1', 'a2', 'A', 'a1', 'B']);
    expect(descendantsOf(result.blocks, id('A'))).toEqual([id('a1'), id('a2')]);
  });

  test("a duplicate goes after the original's children, which stay the original's", () => {
    const { blocks, ids, id } = build(['A', 0], ['c', 1], ['after', 0]);
    const result = duplicateBlocks(blocks, ids('A'));

    expect(texts(result.blocks)).toEqual(['A', 'c', 'A', 'after']);
    expect(depths(result.blocks)).toEqual([0, 1, 0, 0]);
    expect(descendantsOf(result.blocks, id('A'))).toEqual([id('c')]);
  });
});

describe('normalizeDocument caps the output, not the stored depths', () => {
  test('a hidden child stored past the ceiling stays hidden', () => {
    const doc = normalizeDocument({
      blocks: [
        createBlock('paragraph', 'root', 0),
        { ...createBlock('toggle', 'toggle', 35), collapsed: true },
        createBlock('paragraph', 'hidden', 40),
      ],
    });

    expect(depths(doc.blocks)).toEqual([0, 1, 2]);
    expect(texts(visibleBlocks(doc.blocks))).toEqual(['root', 'toggle']);
  });
});

/**
 * The drop rule, as a property rather than as cases.
 *
 * Three rounds patched `moveBlocks` one shape at a time (BL-2, its README
 * qualification, VV-1), and each left the next shape wrong. So the rule is
 * stated once here and held over every gap of a seeded fuzz: every block the
 * move did not take, whose parent it did not take either, has the same parent
 * afterwards -- the nearest shallower block above it, or the root. Beside it,
 * the rules AGENTS.md already gives: the depths are re-clamped, and the moved
 * blocks land as one contiguous group, in document order.
 */
describe('moveBlocks keeps every parent it did not move', () => {
  /** A deterministic generator, so a failure names a case that can be rerun. */
  function seeded(seed: number): (below: number) => number {
    let state = seed >>> 0;

    return (below) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;

      return Math.floor((state / 0x100000000) * below);
    };
  }

  /** Blocks at these depths, some of them toggles and some of those collapsed. */
  function makeDocument(random: (below: number) => number, depths: readonly number[]): Block[] {
    return depths.map((depth, at) => {
      const text = String.fromCharCode(65 + at);

      return random(3) === 0
        ? { ...createBlock('toggle', text, depth), collapsed: random(2) === 0 }
        : createBlock('paragraph', text, depth);
    });
  }

  /** Every legal depth sequence of each size up to `largest`, then `extra` random ones of 3-9 blocks. */
  function documents(seed: number, largest: number, extra: number): Block[][] {
    const random = seeded(seed);
    const out: Block[][] = [];
    const grow = (depths: number[]) => {
      if (depths.length >= 3) {
        out.push(makeDocument(random, depths));
      }

      if (depths.length < largest) {
        for (let depth = 0; depth <= depths.at(-1)! + 1; depth += 1) {
          grow([...depths, depth]);
        }
      }
    };
    grow([0]);

    for (let round = 0; round < extra; round += 1) {
      const depths = [0];

      for (let size = 3 + random(7); depths.length < size;) {
        depths.push(random(depths.at(-1)! + 2));
      }

      out.push(makeDocument(random, depths));
    }

    return out;
  }

  /** Every nonempty subset of `blocks`' ids. */
  function subsets(blocks: readonly Block[]): Set<string>[] {
    const out: Set<string>[] = [];

    for (let mask = 1; mask < 1 << blocks.length; mask += 1) {
      out.push(new Set(blocks.filter((_, at) => mask & (1 << at)).map((block) => block.id)));
    }

    return out;
  }

  /** Selections of every shape: contiguous, with gaps, a parent with and without its children. */
  function selections(random: (below: number) => number, blocks: readonly Block[]): Set<string>[] {
    const out: Set<string>[] = [];

    for (let at = 0; at < blocks.length; at += 1) {
      const id = blocks[at]!.id;
      out.push(new Set([id]));
      out.push(new Set([id, ...descendantsOf(blocks, id)]));
      const end = at + random(blocks.length - at);
      out.push(new Set(blocks.slice(at, end + 1).map((block) => block.id)));
    }

    for (let round = 0; round < 12; round += 1) {
      const density = 1 + random(4);
      const picked = blocks.filter(() => random(6) < density).map((block) => block.id);

      if (picked.length > 0) {
        out.push(new Set(picked));
      }
    }

    return out;
  }

  const parentOf = (blocks: readonly Block[]) => {
    const parent = new Map<string, string | null>();

    blocks.forEach((block, at) => {
      const above = blocks
        .slice(0, at)
        .reverse()
        .find((candidate) => candidate.depth < block.depth);
      parent.set(block.id, above ? above.id : null);
    });

    return parent;
  };

  const name = (blocks: readonly Block[]) =>
    blocks.map((block) => `${blockText(block)}${block.depth}`).join(' ');

  /** What is wrong with one move, as readable lines; empty when it keeps the rules. */
  function violations(
    before: readonly Block[],
    ids: ReadonlySet<string>,
    after: readonly Block[],
    move: string,
  ): string[] {
    const label = (id: string | null | undefined) =>
      id ? blockText(before.find((block) => block.id === id)!) : 'root';
    const was = parentOf(before);
    const now = parentOf(after);
    const out: string[] = [];
    const where = `${name(before)} | move ${[...ids].map(label).join(',')} ${move} -> ${name(after)}`;

    for (const block of before) {
      const parent = was.get(block.id)!;

      if (ids.has(block.id) || (parent !== null && ids.has(parent))) {
        continue;
      }

      if (now.get(block.id) !== parent) {
        out.push(
          `${where}: ${blockText(block)} went from ${label(parent)} to ${label(now.get(block.id))}`,
        );
      }
    }

    if (JSON.stringify(normalizeDepths(after)) !== JSON.stringify(after)) {
      out.push(`${where}: depths not normalized`);
    }

    const order = before.filter((block) => ids.has(block.id)).map((block) => block.id);
    const start = after.findIndex((block) => ids.has(block.id));
    const landed = after.slice(start, start + order.length).map((block) => block.id);

    if (JSON.stringify(landed) !== JSON.stringify(order)) {
      out.push(`${where}: the group is not contiguous and in order`);
    }

    return out;
  }

  /**
   * Every selection of every document of up to 6 blocks, and selections of
   * every shape in random documents of up to 9, moved to every gap.
   */
  function fuzz(): { cases: number; failures: string[] } {
    const random = seeded(20261128);
    const failures: string[] = [];
    let cases = 0;

    for (const blocks of documents(20261128, 6, 400)) {
      const picks = blocks.length <= 6 ? subsets(blocks) : selections(random, blocks);

      for (const ids of picks) {
        for (let gap = 0; gap <= blocks.length; gap += 1) {
          cases += 1;
          const found = violations(blocks, ids, moveBlocks(blocks, ids, gap), `to ${gap}`);

          if (found.length > 0) {
            failures.push(found.join('; '));
          }
        }
      }
    }

    return { cases, failures };
  }

  // VV-1, literally: G and M selected, with a gap between them, dragged above
  // N. Y's parent was X, and neither moved; the group landed at G's depth 0,
  // and Y went to G.
  test('a group with a gap dropped among a moved parent’s children adopts none of the rest', () => {
    const { blocks, ids } = build(['G', 0], ['P', 0], ['X', 1], ['M', 2], ['N', 3], ['Y', 2]);

    expect(violations(blocks, ids('G', 'M'), moveBlocks(blocks, ids('G', 'M'), 4), 'to 4')).toEqual(
      [],
    );
    expect(texts(moveBlocks(blocks, ids('G', 'M'), 4))).toEqual(['P', 'X', 'G', 'M', 'N', 'Y']);
  });

  /**
   * `moveBlocks` and `moveVisibleBlocks` as they were before VV-1, copied
   * verbatim but for comments, so that the keyboard's move can be held to
   * exactly what it did: it picks its gap so that the drop's lift never
   * applies, and the new rule must not change a single one of its answers.
   */
  function parentIndexesBefore(blocks: readonly Block[]): number[] {
    const open: number[] = [];

    return blocks.map((block, at) => {
      while (open.length > 0 && blocks[open.at(-1)!]!.depth >= block.depth) {
        open.pop();
      }

      const parent = open.at(-1) ?? -1;
      open.push(at);

      return parent;
    });
  }

  function moveBlocksBefore(
    blocks: readonly Block[],
    ids: ReadonlySet<string>,
    gapIndex: number,
  ): Block[] {
    const moving = blocks.filter((block) => ids.has(block.id));

    if (moving.length === 0) {
      return [...blocks];
    }

    const rest = blocks.filter((block) => !ids.has(block.id));
    const gap = Math.max(0, Math.min(gapIndex, blocks.length));
    const removedBefore = blocks.slice(0, gap).filter((block) => ids.has(block.id)).length;
    const at = gap - removedBefore;
    let after = gap;

    while (after < blocks.length && ids.has(blocks[after]!.id)) {
      after += 1;
    }

    const next = blocks[after];
    const floor = moving.reduce((low, block) => Math.min(low, block.depth), Infinity);
    const lift =
      next && next.depth > floor && !ids.has(blocks[parentIndexesBefore(blocks)[after]!]?.id ?? '')
        ? next.depth - floor
        : 0;
    const landing =
      lift === 0 ? moving : moving.map((block) => ({ ...block, depth: block.depth + lift }));

    return normalizeDepths([...rest.slice(0, at), ...landing, ...rest.slice(at)]);
  }

  function moveVisibleBlocksBefore(
    blocks: readonly Block[],
    ids: ReadonlySet<string>,
    direction: 1 | -1,
  ): Block[] {
    const moving = withHiddenDescendants(blocks, ids);
    const visible = visibleBlocks(blocks);
    const selected = visible.filter((block) => moving.has(block.id));
    const first = selected[0];
    const last = selected.at(-1);

    if (!first || !last) {
      return [...blocks];
    }

    const from = findBlockIndex(visible, first.id);
    const to = findBlockIndex(visible, last.id);

    if (from === -1 || to === -1) {
      return [...blocks];
    }

    if (!visible[direction === -1 ? from - 1 : to + 1]) {
      return [...blocks];
    }

    const depth = selected.reduce((low, block) => Math.min(low, block.depth), Infinity);
    let landingAt = direction === -1 ? from - 1 : to + 2;

    if (direction === -1) {
      while (landingAt > 0 && visible[landingAt]!.depth > depth) {
        landingAt -= 1;
      }
    } else {
      const parents = parentIndexesBefore(visible);

      while (
        visible[landingAt] &&
        visible[landingAt]!.depth > depth &&
        !moving.has(visible[parents[landingAt]!]?.id ?? '')
      ) {
        landingAt += 1;
      }
    }

    const landing = visible[landingAt];

    return moveBlocksBefore(
      blocks,
      moving,
      landing ? findBlockIndex(blocks, landing.id) : blocks.length,
    );
  }

  // The keyboard picks its gap so that the drop's lift does not apply -- but
  // one case escaped that, and it is VV-1 by keyboard: with a gap in the
  // selection, ↓ lands just before a moving block's second child, the walk
  // stopping there because that child stays its parent's, and a block after
  // it whose parent is above the selection went to the group's first block.
  // G0 P0 X1 M2 N3 O3 Y2 with G and M, ↓, gave P0 X1 N2 G0 M1 O2 Y1, and Y
  // left X for G. So the answers are held to the old ones exactly, except
  // where the old one broke the rule going down and the new one keeps it;
  // and every answer keeps it.
  test('the keyboard’s move gives the answers it gave before, but where they broke the rule', () => {
    const random = seeded(20261129);
    const differ: string[] = [];
    let cases = 0;
    let mended = 0;

    for (const blocks of documents(20261129, 7, 400)) {
      const shown = visibleBlocks(blocks);
      // The editor's selection holds only blocks the reader can see.
      const picks = blocks.length <= 7 ? subsets(shown) : selections(random, shown);

      for (const ids of picks) {
        const moving = withHiddenDescendants(blocks, ids);

        for (const direction of [1, -1] as const) {
          cases += 1;
          const now = moveVisibleBlocks(blocks, ids, direction);
          const was = moveVisibleBlocksBefore(blocks, ids, direction);
          const step = direction === 1 ? 'down' : 'up';
          // Against an edge the move is a no-op and gathers nothing, so only
          // the parents and the depths are asked of every answer.
          const broken = violations(blocks, moving, now, step).filter(
            (line) => !line.endsWith('the group is not contiguous and in order'),
          );

          if (broken.length > 0) {
            differ.push(broken.join('; '));
          }

          if (JSON.stringify(now) === JSON.stringify(was)) {
            continue;
          }

          if (
            direction === 1 &&
            violations(blocks, moving, was, step).length > 0 &&
            violations(blocks, moving, now, step).length === 0
          ) {
            mended += 1;
          } else {
            differ.push(`${name(blocks)} | ${step} -> ${name(now)}, was ${name(was)}`);
          }
        }
      }
    }

    expect(cases).toBeGreaterThan(100_000);
    expect({ differing: differ.length, first: differ.slice(0, 5) }).toEqual({
      differing: 0,
      first: [],
    });
    // The exception is real, and it is all the change there is.
    expect(mended).toBeGreaterThan(0);
  });

  test('the keyboard’s move keeps every parent it did not move', () => {
    const { blocks, ids } = build(
      ['G', 0],
      ['P', 0],
      ['X', 1],
      ['M', 2],
      ['N', 3],
      ['O', 3],
      ['Y', 2],
    );
    const moved = moveVisibleBlocks(blocks, ids('G', 'M'), 1);

    expect(violations(blocks, ids('G', 'M'), moved, 'down')).toEqual([]);
    expect(name(moved)).toBe('P0 X1 N2 G2 M3 O3 Y2');
  });

  test('over every gap of a seeded fuzz', () => {
    const { cases, failures } = fuzz();

    expect(cases).toBeGreaterThan(100_000);
    expect({ failing: failures.length, first: failures.slice(0, 5) }).toEqual({
      failing: 0,
      first: [],
    });
  });
});
