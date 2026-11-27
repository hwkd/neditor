// @vitest-environment happy-dom
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';

import { describe, expect, test, vi } from 'vitest';

import type { Block } from '../model/document.ts';
import { blockText } from '../model/document.ts';
import type { RichText } from '../model/rich-text.ts';
import { isRichEmpty, richToPlainText } from '../model/rich-text.ts';
import {
  blocksFromHtml,
  blocksToHtml,
  parseRichText,
  parseRichTextFromHtml,
  renderRichText,
  richTextToHtml,
} from './rich-dom.ts';
import { LINEAR, growth, growthOf } from '../test-timing.ts';

function render(content: RichText): string {
  const host = document.createElement('div');
  host.append(renderRichText(document, content));
  return host.innerHTML;
}

function roundTrip(content: RichText): RichText {
  const host = document.createElement('div');
  host.append(renderRichText(document, content));
  return parseRichText(host);
}

function fromHtml(html: string): RichText {
  return parseRichTextFromHtml(document, html);
}

describe('render', () => {
  test('plain runs become bare text', () => {
    expect(render([{ text: 'hello' }])).toBe('hello');
  });

  test('each mark maps to a semantic element', () => {
    expect(render([{ text: 'x', marks: ['bold'] }])).toBe('<strong>x</strong>');
    expect(render([{ text: 'x', marks: ['italic'] }])).toBe('<em>x</em>');
    expect(render([{ text: 'x', marks: ['underline'] }])).toBe('<u>x</u>');
    expect(render([{ text: 'x', marks: ['strikethrough'] }])).toBe('<s>x</s>');
    expect(render([{ text: 'x', marks: ['code'] }])).toBe('<code>x</code>');
  });

  test('nesting is deterministic regardless of mark order', () => {
    const a = render([{ text: 'x', marks: ['bold', 'italic'] }]);
    const b = render([{ text: 'x', marks: ['italic', 'bold'] }]);

    expect(a).toBe(b);
  });

  test('a link wraps the marks and carries rel', () => {
    expect(render([{ text: 'x', marks: ['bold'], link: 'https://a.test/' }])).toBe(
      '<a class="neditor-link" href="https://a.test/" rel="noopener noreferrer">' +
        '<strong>x</strong></a>',
    );
  });

  test('empty content renders nothing, so the placeholder still matches', () => {
    expect(render([])).toBe('');
  });

  test('a trailing newline gets a <br>, or it has no line box at all', () => {
    // Under `white-space: pre-wrap` the last newline ends the last line and
    // there is nothing after it to fill another one — the block does not grow
    // and the caret has nowhere to sit, so the next character lands in front of
    // the break. The <br> is what gives that empty last line a box.
    expect(render([{ text: 'one\n' }])).toBe('one\n<br>');
  });

  test('the filler goes outside the marks, not inside them', () => {
    expect(render([{ text: 'one\n', marks: ['bold'] }])).toBe('<strong>one\n</strong><br>');
  });

  test('a newline anywhere else needs no filler', () => {
    expect(render([{ text: 'one\ntwo' }])).toBe('one\ntwo');
  });
});

describe('round trip', () => {
  test.each<[string, RichText]>([
    ['plain', [{ text: 'hello world' }]],
    ['bold', [{ text: 'a' }, { text: 'b', marks: ['bold'] }]],
    ['composed marks', [{ text: 'x', marks: ['bold', 'italic', 'underline'] }]],
    ['link with marks', [{ text: 'x', marks: ['bold'], link: 'https://a.test/' }]],
    [
      'mixed',
      [
        { text: 'see ' },
        { text: 'docs', marks: ['code'], link: 'https://a.test/' },
        { text: ' now' },
      ],
    ],
    ['newlines', [{ text: 'line one\nline two' }]],
    // The rendered <br> after it is filler, and `parseRichText` already reads a
    // trailing <br> back as nothing — so the newline must not be counted twice.
    ['a trailing newline', [{ text: 'line one\n' }]],
    ['a trailing newline under a mark', [{ text: 'line one\n', marks: ['bold'] }]],
  ])('%s survives render then parse', (_name, content) => {
    expect(roundTrip(content)).toEqual(content);
  });

  test('the clipboard does not double a trailing newline either', () => {
    const blocks = blocksFromHtml(
      document,
      blocksToHtml(document, [
        { id: 'a', type: 'paragraph', depth: 0, content: [{ text: 'one\n' }] },
        { id: 'b', type: 'paragraph', depth: 0, content: [{ text: 'two' }] },
      ]),
    );

    // The <br> sits inside the <p>, so the following paragraph must not turn it
    // into content: a block element is the root each block's runs are read from.
    expect(blocks.map((item) => richToPlainText(item.content))).toEqual(['one\n', 'two']);
  });
});

describe('parsing foreign HTML', () => {
  test('presentational tags map onto marks', () => {
    expect(fromHtml('<b>a</b><i>b</i><u>c</u><strike>d</strike><tt>e</tt>')).toEqual([
      { text: 'a', marks: ['bold'] },
      { text: 'b', marks: ['italic'] },
      { text: 'c', marks: ['underline'] },
      { text: 'd', marks: ['strikethrough'] },
      { text: 'e', marks: ['code'] },
    ]);
  });

  test('inline styles are read, as pasted documents rely on them', () => {
    expect(fromHtml('<span style="font-weight:700">a</span>')).toEqual([
      { text: 'a', marks: ['bold'] },
    ]);
    expect(fromHtml('<span style="font-style:italic">a</span>')).toEqual([
      { text: 'a', marks: ['italic'] },
    ]);
    expect(fromHtml('<span style="text-decoration:line-through">a</span>')).toEqual([
      { text: 'a', marks: ['strikethrough'] },
    ]);
  });

  test('an explicit style clears the mark its tag implies', () => {
    // Google Docs wraps its whole payload in <b style="font-weight:normal">, so
    // a tag that can only add marks makes every Google Docs paste bold.
    expect(fromHtml('<b style="font-weight:normal">a</b>')).toEqual([{ text: 'a' }]);
    expect(fromHtml('<strong style="font-weight:400">a</strong>')).toEqual([{ text: 'a' }]);
    expect(fromHtml('<i style="font-style:normal">a</i>')).toEqual([{ text: 'a' }]);
    expect(fromHtml('<u style="text-decoration:none">a</u>')).toEqual([{ text: 'a' }]);
    expect(fromHtml('<s style="text-decoration-line:none">a</s>')).toEqual([{ text: 'a' }]);
  });

  test('a style clears a mark inherited from an ancestor', () => {
    expect(fromHtml('<b>a<span style="font-weight:400">b</span></b>')).toEqual([
      { text: 'a', marks: ['bold'] },
      { text: 'b' },
    ]);
  });

  test('a style that says nothing about a mark leaves the tag alone', () => {
    expect(fromHtml('<b style="color:red">a</b>')).toEqual([{ text: 'a', marks: ['bold'] }]);
    expect(fromHtml('<u style="font-weight:normal">a</u>')).toEqual([
      { text: 'a', marks: ['underline'] },
    ]);
  });

  test('unknown wrappers contribute nothing but their text', () => {
    expect(fromHtml('<div><span><font color="red">a</font></span></div>')).toEqual([{ text: 'a' }]);
  });

  test('block elements are separated by a newline', () => {
    expect(richToPlainText(fromHtml('<p>one</p><p>two</p>'))).toBe('one\ntwo');
    expect(richToPlainText(fromHtml('<ul><li>a</li><li>b</li></ul>'))).toBe('a\nb');
  });

  test('no trailing newline after the last block', () => {
    expect(richToPlainText(fromHtml('<p>only</p>'))).toBe('only');
  });

  test('a block following inline content breaks the line', () => {
    expect(richToPlainText(fromHtml('lead <b>in</b><p>para</p>'))).toBe('lead in\npara');
  });

  test('a leading block does not emit a leading newline', () => {
    expect(richToPlainText(fromHtml('<p>a</p>tail'))).toBe('a\ntail');
  });

  describe('whitespace between blocks', () => {
    test('indentation around block elements is dropped', () => {
      expect(richToPlainText(fromHtml('<p>a</p>\n  <p>b</p>'))).toBe('a\nb');
      expect(richToPlainText(fromHtml('<div>\n  <p>a</p>\n  <p>b</p>\n</div>'))).toBe('a\nb');
    });

    test('a space between inline elements is content', () => {
      expect(richToPlainText(fromHtml('<b>a</b> <b>b</b>'))).toBe('a b');
    });

    test('whitespace that is the whole content is content, not indentation', () => {
      // No sibling to be separated from: this space is what the block holds.
      // Counting the edge of the parent as a block boundary on its own threw it
      // away, so a space-only paragraph came back empty on every copy-paste.
      expect(fromHtml('<p> </p>')).toEqual([{ text: ' ' }]);
      expect(fromHtml('<td>\u00a0</td>')).toEqual([{ text: '\u00a0' }]);
    });
  });

  describe('sanitization', () => {
    test('script contents are dropped, not read as text', () => {
      expect(fromHtml('<p>safe</p><script>alert(1)</script>')).toEqual([{ text: 'safe' }]);
    });

    test('style and other non-content elements are dropped', () => {
      expect(fromHtml('<style>body{color:red}</style><p>safe</p>')).toEqual([{ text: 'safe' }]);
      expect(richToPlainText(fromHtml('<iframe>x</iframe>hi'))).toBe('hi');
    });

    test('an unsafe href is stripped but its text is kept', () => {
      expect(fromHtml('<a href="javascript:alert(1)">click</a>')).toEqual([{ text: 'click' }]);
    });

    test('a safe href is preserved', () => {
      expect(fromHtml('<a href="https://a.test/">click</a>')).toEqual([
        { text: 'click', link: 'https://a.test/' },
      ]);
    });

    test('event handler attributes never survive, since only text is read', () => {
      const parsed = fromHtml('<img src=x onerror="alert(1)">hello');

      expect(richToPlainText(parsed)).toBe('hello');
    });

    test('an <svg> is skipped, source text and all', () => {
      // Outside the HTML namespace `tagName` keeps its source case, so only an
      // uppercased comparison matches: <svg><style> and <svg><title> are read
      // as document text otherwise.
      expect(richToPlainText(fromHtml('<p>a</p><svg><title>tip</title><desc>d</desc></svg>'))).toBe(
        'a',
      );
    });

    test('MathML is content, but its script and style source is not', () => {
      // The other foreign namespace, and the same trap: <math><style> is a
      // MathML element whose name keeps its source case. The maths itself is
      // text the reader is meant to see, so only the source is dropped.
      expect(richToPlainText(fromHtml('<math><style>.y{color:red}</style><mi>z</mi></math>'))).toBe(
        'z',
      );
      expect(richToPlainText(fromHtml('<math><script>alert(1)</script><mi>z</mi></math>'))).toBe(
        'z',
      );
    });
  });

  test('a trailing filler <br> is not content', () => {
    // contenteditable appends one to keep an empty line selectable.
    expect(fromHtml('text<br>')).toEqual([{ text: 'text' }]);
  });

  test('a <br> between text becomes a newline', () => {
    expect(fromHtml('a<br>b')).toEqual([{ text: 'a\nb' }]);
  });
});

describe('blocksFromHtml', () => {
  const parse = (html: string) => blocksFromHtml(document, html);
  const types = (html: string) => parse(html).map((b) => b.type);
  const texts = (html: string) => parse(html).map(blockText);
  const depths = (html: string) => parse(html).map((b) => b.depth);

  test('nothing in, nothing out', () => {
    expect(parse('')).toEqual([]);
    expect(parse('<div></div>')).toEqual([]);
  });

  test.each([
    ['<h1>a</h1>', 'heading1'],
    ['<h2>a</h2>', 'heading2'],
    ['<h3>a</h3>', 'heading3'],
    ['<h6>a</h6>', 'heading3'],
    ['<p>a</p>', 'paragraph'],
    ['<blockquote>a</blockquote>', 'quote'],
    ['<pre>a</pre>', 'code'],
    ['<hr>', 'divider'],
  ])('%s becomes %s', (html: string, type: string) => {
    expect(types(html)).toEqual([type]);
  });

  test('paragraphs become separate blocks', () => {
    expect(texts('<p>one</p><p>two</p>')).toEqual(['one', 'two']);
  });

  test('inline formatting survives into the block', () => {
    const blocks = parse('<p>a <strong>b</strong></p>');

    expect(blocks[0]?.content).toEqual([{ text: 'a ' }, { text: 'b', marks: ['bold'] }]);
  });

  test('a safe link is kept and an unsafe one is dropped', () => {
    expect(parse('<p><a href="https://a.test/">x</a></p>')[0]?.content).toEqual([
      { text: 'x', link: 'https://a.test/' },
    ]);
    expect(parse('<p><a href="javascript:alert(1)">x</a></p>')[0]?.content).toEqual([
      { text: 'x' },
    ]);
  });

  test('lists map to their block types', () => {
    expect(types('<ul><li>a</li><li>b</li></ul>')).toEqual(['bulleted_list', 'bulleted_list']);
    expect(types('<ol><li>a</li></ol>')).toEqual(['numbered_list']);
  });

  test('a nested list goes one level deeper', () => {
    const html = '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>';

    expect(texts(html)).toEqual(['a', 'b', 'c']);
    expect(depths(html)).toEqual([0, 1, 2]);
  });

  test('a nested item does not leak into its parent text', () => {
    expect(texts('<ul><li>parent<ul><li>child</li></ul></li></ul>')).toEqual(['parent', 'child']);
  });

  test('a checkbox input makes a to-do', () => {
    const blocks = parse(
      '<ul><li><input type="checkbox" checked>done</li><li><input type="checkbox">open</li></ul>',
    );

    expect(blocks.map((b) => b.type)).toEqual(['todo', 'todo']);
    expect(blocks[0]?.checked).toBe(true);
    expect(blocks[1]?.checked).toBe(false);
  });

  test('a textual checkbox also makes a to-do, and is stripped', () => {
    const blocks = parse('<ul><li>[x] done</li><li>[ ] open</li></ul>');

    expect(blocks.map((b) => b.type)).toEqual(['todo', 'todo']);
    expect(blocks.map(blockText)).toEqual(['done', 'open']);
    expect(blocks[0]?.checked).toBe(true);
    expect(blocks[1]?.checked).toBe(false);
  });

  test('a list we wrote ourselves says what its items are instead', () => {
    // Guessing at the text is right for foreign markup (above) and wrong for
    // our own, where a bullet beginning "[x]" is a bullet, not a ticked to-do.
    const blocks = parse(
      '<ul data-neditor-list=""><li>[x] not a to-do</li>' +
        '<li data-neditor-checked="true">\u2611 really is one</li></ul>',
    );

    expect(blocks.map((b) => b.type)).toEqual(['bulleted_list', 'todo']);
    expect(blocks.map(blockText)).toEqual(['[x] not a to-do', 'really is one']);
    expect(blocks[1]?.checked).toBe(true);
  });

  test('an explicit marker outweighs the text, wherever the item came from', () => {
    const blocks = parse('<ul><li data-neditor-checked="false">\u2610 [x] later</li></ul>');

    expect(blocks[0]).toMatchObject({ type: 'todo', checked: false });
    // One box stripped, not two: the rest is the author's text.
    expect(blockText(blocks[0]!)).toBe('[x] later');
  });

  test('code blocks keep their text verbatim', () => {
    expect(blockText(parse('<pre>const a = **1**;</pre>')[0]!)).toBe('const a = **1**;');
  });

  test('containers are transparent', () => {
    expect(texts('<div><section><p>a</p></section></div>')).toEqual(['a']);
  });

  test('stray inline text at the top level becomes a paragraph', () => {
    expect(texts('loose <strong>text</strong><p>block</p>')).toEqual(['loose text', 'block']);
  });

  test('scripts and styles never become blocks', () => {
    expect(texts('<script>alert(1)</script><style>a{}</style><p>safe</p>')).toEqual(['safe']);
    expect(texts('<iframe src="https://a.test/">x</iframe><p>safe</p>')).toEqual(['safe']);
  });

  test('an <svg> never becomes a block, whatever it holds', () => {
    // Its tags are lowercase, so they only match the skip list uppercased.
    expect(texts('<svg><title>tip</title><desc>d</desc></svg><p>safe</p>')).toEqual(['safe']);
  });

  describe('an inline wrapper holding blocks', () => {
    test('does not collapse the blocks inside it', () => {
      // Google Docs wraps its entire clipboard payload in one <b>.
      const html =
        '<b style="font-weight:normal" id="docs-internal-guid-1">' +
        '<h1>Title</h1><p>Body</p><ul><li>one</li><li>two</li></ul></b>';

      expect(types(html)).toEqual(['heading1', 'paragraph', 'bulleted_list', 'bulleted_list']);
      expect(texts(html)).toEqual(['Title', 'Body', 'one', 'two']);
    });

    test('splits the payload Google Docs actually sends, unbolded', () => {
      // The exact shape of a Google Docs clipboard, kept as its own test: the
      // wrapper is descended into rather than pushed inward, because
      // font-weight:normal leaves it with no mark to carry.
      const html =
        '<b style="font-weight:normal" id="docs-internal-guid-x"><p>One</p><p>Two</p></b>';

      expect(parse(html).map((block) => block.content)).toEqual([
        [{ text: 'One' }],
        [{ text: 'Two' }],
      ]);
    });

    test('carries only the bold the source really had', () => {
      // The whole point of that wrapper's font-weight:normal: without it every
      // Google Docs paste arrives bold from end to end.
      const blocks = parse(
        '<b style="font-weight:normal" id="docs-internal-guid-1"><p>plain</p>' +
          '<p><span style="font-weight:700">loud</span></p></b>',
      );

      expect(blocks.map((block) => block.content)).toEqual([
        [{ text: 'plain' }],
        [{ text: 'loud', marks: ['bold'] }],
      ]);
    });

    test('keeps its own formatting on the blocks it holds', () => {
      expect(parse('<b><p>one</p><p>two</p></b>').map((block) => block.content)).toEqual([
        [{ text: 'one', marks: ['bold'] }],
        [{ text: 'two', marks: ['bold'] }],
      ]);
    });

    test('keeps its href on the blocks it holds', () => {
      expect(parse('<a href="https://a.test/"><p>one</p></a>')[0]?.content).toEqual([
        { text: 'one', link: 'https://a.test/' },
      ]);
    });

    test('keeps a table it holds readable', () => {
      // The formatting has to reach the cell text without moving a single
      // section, row or cell: pushTable reads the grid with `:scope >` queries.
      const rows = parse(
        '<b><table><thead><tr><th>h</th></tr></thead>' +
          '<tbody><tr><td>a</td></tr></tbody></table></b>',
      )[0]?.rows;

      expect(rows).toEqual([
        [[{ text: 'h', marks: ['bold'] }]],
        [[{ text: 'a', marks: ['bold'] }]],
      ]);
    });

    test('reaches the text of a caption or a summary', () => {
      const image = parse(
        '<b><figure><img src="https://a.test/x.png"><figcaption>Cap</figcaption></figure></b>',
      );
      const toggle = parse('<b><details><summary>T</summary></details></b>');

      expect(image[0]?.content).toEqual([{ text: 'Cap', marks: ['bold'] }]);
      expect(toggle[0]?.content).toEqual([{ text: 'T', marks: ['bold'] }]);
    });

    test('keeps the space between two elements it wraps', () => {
      expect(texts('<b><p><span>a</span> <span>b</span></p></b>')).toEqual(['a b']);
    });

    test('is descended into however deeply it is wrapped', () => {
      expect(texts('<span><em><span><p>a</p><p>b</p></span></em></span>')).toEqual(['a', 'b']);
    });

    test('still reads inline text of its own', () => {
      expect(texts('<b>lead<p>para</p></b>')).toEqual(['lead', 'para']);
    });

    test('is still inline when it holds no blocks', () => {
      expect(texts('<b>just <em>text</em></b>')).toEqual(['just text']);
    });

    test('hands its formatting to a quote without swallowing the list in it', () => {
      const html = '<b><blockquote><p>q</p><ul><li>i</li><li>j</li></ul></blockquote></b>';

      expect(types(html)).toEqual(['quote', 'bulleted_list', 'bulleted_list']);
      expect(parse(html).map((block) => block.content)).toEqual([
        [{ text: 'q', marks: ['bold'] }],
        [{ text: 'i', marks: ['bold'] }],
        [{ text: 'j', marks: ['bold'] }],
      ]);
      expect(depths(html)).toEqual([0, 1, 1]);
    });
  });

  describe('a chain of inline wrappers', () => {
    /**
     * Deep enough that re-reading the chain per level would show, and still
     * only a few kilobytes — which is the point: the depth costs the paste
     * nothing and used to cost the tab everything.
     */
    const DEEP = 512;

    const chain = (open: string, close: string, inner: string, depth = DEEP): string =>
      open.repeat(depth) + inner + close.repeat(depth);

    /** A block at every level, so the wrappers are lifted out of real content. */
    const staircase = (depth = DEEP): string => '<b><p>p</p>'.repeat(depth) + '</b>'.repeat(depth);

    const parseTime = (html: string): number => {
      const started = performance.now();

      parse(html);

      return performance.now() - started;
    };

    /** Subtree queries run while parsing: every one of them walks everything. */
    const subtreeQueries = (html: string): number => {
      const prototype = Element.prototype as {
        querySelector: (selector: string) => Element | null;
      };
      const original = prototype.querySelector;
      let queries = 0;

      prototype.querySelector = function counted(this: Element, selector: string): Element | null {
        queries += 1;

        return original.call(this, selector);
      };

      try {
        parse(html);
      } finally {
        prototype.querySelector = original;
      }

      return queries;
    };

    test('is read once, not once per level', () => {
      // Pushing the formatting inward handed back a fragment still topped by
      // the next wrapper, so the visitor came straight back and re-cloned and
      // re-scanned everything below it, one level further down. In Chrome, 4.5
      // KB of nested <b> — what a drag out of a hostile page can carry — froze
      // the tab for eleven seconds inside the paste event, and 9 KB for six
      // minutes. The bound here is loose on purpose: the work is linear now,
      // so this is milliseconds, and anything quadratic blows straight past it.
      expect(parseTime(chain('<b>', '</b>', '<p>x</p>'))).toBeLessThan(1000);
      expect(parseTime(chain('<span>', '</span>', '<p>x</p>'))).toBeLessThan(1000);
      expect(parseTime(chain('<a href="https://a.test/">', '</a>', '<p>x</p>'))).toBeLessThan(1000);
      expect(parseTime(staircase())).toBeLessThan(1000);
    });

    test('costs no more to look through the deeper it is', () => {
      // The timing above is the alarm; this is the mechanism. Asking "is there
      // a block in here", "is there an image in here" or "where is the image"
      // with a query walks the whole remaining subtree, and asking once per
      // level is quadratic before the cloning makes it cubic — 128 nested <b>
      // ran 8,640 of these queries, and 8 of them ran 60.
      const wrappers: ReadonlyArray<readonly [string, string]> = [
        ['<b>', '</b>'],
        ['<span>', '</span>'],
        ['<b><figure>', '</figure></b>'],
      ];

      for (const [open, close] of wrappers) {
        const shallow = subtreeQueries(chain(open, close, '<p>x</p>', 8));

        expect(subtreeQueries(chain(open, close, '<p>x</p>', DEEP))).toBe(shallow);
      }
    });

    test('leaves one copy of its formatting on the block it holds', () => {
      const blocks = parse(chain('<b>', '</b>', '<p>x</p>'));

      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.content).toEqual([{ text: 'x', marks: ['bold'] }]);
    });

    test('keeps every block it holds, at every level of it', () => {
      const blocks = parse(staircase());

      expect(blocks).toHaveLength(DEEP);
      expect(blocks.map((block) => block.content)).toEqual(
        Array.from({ length: DEEP }, () => [{ text: 'p', marks: ['bold'] }]),
      );
    });

    test('every wrapper in it leaves its own mark', () => {
      expect(parse('<b><i><u><p>x</p></u></i></b>')[0]?.content).toEqual([
        { text: 'x', marks: ['bold', 'italic', 'underline'] },
      ]);
      expect(parse('<span><b><span><i><p>x</p></i></span></b></span>')[0]?.content).toEqual([
        { text: 'x', marks: ['bold', 'italic'] },
      ]);
    });

    test('an href anywhere in it reaches the block, either way up', () => {
      const linked = [{ text: 'x', marks: ['bold'], link: 'https://a.test/' }];

      expect(parse('<a href="https://a.test/"><b><p>x</p></b></a>')[0]?.content).toEqual(linked);
      expect(parse('<b><a href="https://a.test/"><p>x</p></a></b>')[0]?.content).toEqual(linked);
    });

    test('a mark an outer wrapper turned on outlives an inner one turning it off', () => {
      // Not the rule the same markup follows when it holds no block — there the
      // inner element wins — but the rule every paste has had since the wrapper
      // was first descended into, and this pass is about what that costs, not
      // about what it decides.
      expect(parse('<b><em style="font-weight:normal"><p>x</p></em></b>')[0]?.content).toEqual([
        { text: 'x', marks: ['bold', 'italic'] },
      ]);
      expect(parse('<em style="font-weight:normal"><b><p>x</p></b></em>')[0]?.content).toEqual([
        { text: 'x', marks: ['italic'] },
      ]);
    });

    test('leaves a wrapper inside a block to speak for itself', () => {
      // A block is read whole, so a wrapper standing inside one is read where
      // it stands — and a copy of it around the text as well would say the same
      // thing twice, which is only harmless until one of the two turns a mark
      // off. Here the <em> cancels the <b> around it, and the <u> outside the
      // quote — the one the block really is cut off from — still arrives.
      expect(
        parse(
          '<u><blockquote><b><em style="font-weight:normal"><p>x</p></em></b></blockquote></u>',
        )[0]?.content,
      ).toEqual([{ text: 'x', marks: ['italic', 'underline'] }]);

      expect(parse('<b><blockquote><em><p>x</p></em>tail</blockquote></b>')[0]?.content).toEqual([
        { text: 'x', marks: ['bold', 'italic'] },
        { text: '\n', marks: ['italic'] },
        { text: 'tail', marks: ['bold'] },
      ]);
    });

    test('carries the marks it turns off as well as the ones it turns on', () => {
      // The copy has to be able to say "not bold" the way the wrapper it stands
      // in for said it — with a style — because the <b> it has to overrule is
      // still standing inside the block, between the copy and the text.
      expect(
        parse('<u style="font-weight:normal"><blockquote><b><p>x</p></b></blockquote></u>')[0]
          ?.content,
      ).toEqual([{ text: 'x', marks: ['underline'] }]);

      // And it must say only that: a <u> inside the quote is still underline,
      // and the strikethrough from outside it still arrives.
      expect(parse('<s><blockquote><u><p>x</p></u></blockquote></s>')[0]?.content).toEqual([
        { text: 'x', marks: ['underline', 'strikethrough'] },
      ]);
    });

    test('keeps the text either side of a wrapper in it out of each other', () => {
      const blocks = parse('<b><i><p>one</p>tail</i>after</b>');

      expect(blocks.map((block) => block.content)).toEqual([
        [{ text: 'one', marks: ['bold', 'italic'] }],
        [{ text: 'tail', marks: ['bold', 'italic'] }],
        [{ text: 'after', marks: ['bold'] }],
      ]);
    });
  });

  describe('empty blocks', () => {
    test('an empty element is a blank block, not nothing', () => {
      // blocksToHtml writes an empty block as an empty element, so dropping it
      // loses a line on every copy-paste. README documents this for the HTML path.
      expect(types('<p></p>')).toEqual(['paragraph']);
      expect(types('<h1></h1>')).toEqual(['heading1']);
      expect(types('<blockquote></blockquote>')).toEqual(['quote']);
      expect(types('<ul><li></li></ul>')).toEqual(['bulleted_list']);
      expect(texts('<p>A</p><p></p><p>B</p>')).toEqual(['A', '', 'B']);
    });

    test('an empty to-do keeps its checkbox', () => {
      const blocks = parse('<ul><li>☐ </li><li>☑ </li></ul>');

      expect(blocks.map((block) => block.type)).toEqual(['todo', 'todo']);
      expect(blocks.map((block) => block.checked)).toEqual([false, true]);
    });

    test('an item that only holds a nested list is not a blank bullet', () => {
      expect(types('<ul><li><ul><li>a</li></ul></li></ul>')).toEqual(['bulleted_list']);
    });

    test('a blank line survives a round trip through the serializer', () => {
      const source = parse('<p>A</p><p></p><p>B</p>');
      const round = blocksFromHtml(document, blocksToHtml(document, source));

      expect(round.map(blockText)).toEqual(['A', '', 'B']);
    });
  });

  test('a document round-trips through blocksToHtml', () => {
    const source = blocksFromHtml(
      document,
      '<h1>Title</h1><p>Body <em>text</em> and <a href="https://a.test/">a link</a></p>' +
        '<ul><li>one</li><li><strong>two</strong></li></ul>' +
        '<ol><li>step</li></ol>' +
        '<blockquote>quoted</blockquote><hr>',
    );

    const round = blocksFromHtml(document, blocksToHtml(document, source));

    expect(round.map((b) => b.type)).toEqual(source.map((b) => b.type));
    // Compared deeply, not by plain text: replacing the serializer's
    // renderRichText calls with bare text nodes destroys every mark and link on
    // copy, and a text-only assertion cannot see it.
    expect(round.map((b) => b.content)).toEqual(source.map((b) => b.content));
  });

  test('marks and links survive the serializer, not just the text', () => {
    const source = blocksFromHtml(
      document,
      '<p><strong>b</strong><em>i</em><u>u</u><s>s</s><code>c</code>' +
        '<a href="https://a.test/">l</a></p>',
    );

    const round = blocksFromHtml(document, blocksToHtml(document, source));

    expect(round[0]?.content).toEqual([
      { text: 'b', marks: ['bold'] },
      { text: 'i', marks: ['italic'] },
      { text: 'u', marks: ['underline'] },
      { text: 's', marks: ['strikethrough'] },
      { text: 'c', marks: ['code'] },
      { text: 'l', link: 'https://a.test/' },
    ]);
  });

  test('table cell formatting survives the serializer', () => {
    const source = blocksFromHtml(
      document,
      '<table><tr><th><strong>h</strong></th></tr><tr><td><em>a</em></td></tr></table>',
    );

    const round = blocksFromHtml(document, blocksToHtml(document, source));

    expect(round[0]?.rows).toEqual(source[0]?.rows);
    expect(round[0]?.rows?.[1]?.[0]).toEqual([{ text: 'a', marks: ['italic'] }]);
  });

  test('to-dos survive a round trip through the serializer', () => {
    const source = blocksFromHtml(
      document,
      '<ul><li><input type="checkbox" checked>done</li><li><input type="checkbox">open</li></ul>',
    );

    const round = blocksFromHtml(document, blocksToHtml(document, source));

    expect(round.map((b) => b.type)).toEqual(['todo', 'todo']);
    expect(round.map(blockText)).toEqual(['done', 'open']);
    expect(round.map((b) => b.checked)).toEqual([true, false]);
  });

  test('nesting survives a round trip', () => {
    const source = blocksFromHtml(
      document,
      '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>',
    );
    const round = blocksFromHtml(document, blocksToHtml(document, source));

    expect(round.map(blockText)).toEqual(['a', 'b', 'c', 'd']);
    expect(round.map((b) => b.depth)).toEqual([0, 1, 2, 0]);
  });

  test('the serializer emits real nested lists, not indentation', () => {
    const source = blocksFromHtml(document, '<ul><li>a<ul><li>b</li></ul></li></ul>');
    const html = blocksToHtml(document, source);

    // Genuinely nested, so other applications read the structure. The depth
    // attribute rides along because structure alone cannot survive a non-list
    // block interrupting a list.
    // Matched loosely on the tags rather than the exact markup: the items also
    // carry the attributes that say what they are, and this test is about the
    // shape of the nesting.
    expect(html).toMatch(/<ul[^>]*><li[^>]*>a<ul[^>]*><li/);
    expect(html).toContain('>b</li></ul></li></ul>');
    expect(html).not.toContain('margin-left');
  });

  test('list depth survives a block that interrupts the list', () => {
    const source = blocksFromHtml(
      document,
      '<ul><li>A<ul><li>B</li></ul></li></ul><p data-neditor-depth="1">note</p>' +
        '<ul><li data-neditor-depth="1">C</li></ul>',
    );
    const round = blocksFromHtml(document, blocksToHtml(document, source));

    expect(round.map((b) => b.depth)).toEqual([0, 1, 1, 1]);
    expect(round.map(blockText)).toEqual(['A', 'B', 'note', 'C']);
  });

  test('a list interrupted by another type starts a new list', () => {
    const source = blocksFromHtml(document, '<ul><li>a</li></ul><p>x</p><ul><li>b</li></ul>');
    const round = blocksFromHtml(document, blocksToHtml(document, source));

    expect(round.map((b) => b.type)).toEqual(['bulleted_list', 'paragraph', 'bulleted_list']);
  });

  test('depth on a non-list block round-trips', () => {
    const source = blocksFromHtml(document, '<ul><li>a<ul><li>b</li></ul></li></ul>');
    source.push({ ...source[0]!, id: 'x', type: 'paragraph', depth: 1 });

    const round = blocksFromHtml(document, blocksToHtml(document, source));

    expect(round.at(-1)?.depth).toBe(1);
  });
});

describe('callouts and toggles in HTML', () => {
  const parse = (html: string) => blocksFromHtml(document, html);

  test('a marked blockquote is a callout, a plain one is a quote', () => {
    expect(parse('<blockquote data-neditor-callout="📌">note</blockquote>')[0]).toMatchObject({
      type: 'callout',
      icon: '📌',
    });
    expect(parse('<blockquote>note</blockquote>')[0]?.type).toBe('quote');
  });

  test('a quoted list survives, nested under the quote', () => {
    // `> - item` on GitHub, Wikipedia and Stack Overflow.
    const blocks = parse('<blockquote><p>intro</p><ul><li>a</li><li>b</li></ul></blockquote>');

    expect(blocks.map((block) => block.type)).toEqual(['quote', 'bulleted_list', 'bulleted_list']);
    expect(blocks.map(blockText)).toEqual(['intro', 'a', 'b']);
    expect(blocks.map((block) => block.depth)).toEqual([0, 1, 1]);
  });

  test('a nested quoted list keeps its own nesting', () => {
    const blocks = parse('<blockquote><p>q</p><ul><li>a<ul><li>b</li></ul></li></ul></blockquote>');

    expect(blocks.map(blockText)).toEqual(['q', 'a', 'b']);
    expect(blocks.map((block) => block.depth)).toEqual([0, 1, 2]);
  });

  test('a blockquote holding nothing but a list is that list', () => {
    const blocks = parse('<blockquote><ul><li>a</li></ul></blockquote>');

    expect(blocks.map((block) => block.type)).toEqual(['bulleted_list']);
    expect(blocks.map((block) => block.depth)).toEqual([0]);
  });

  test('a callout keeps both its text and its list', () => {
    const blocks = parse(
      '<blockquote data-neditor-callout="📌"><p>note</p><ol><li>step</li></ol></blockquote>',
    );

    expect(blocks.map((block) => block.type)).toEqual(['callout', 'numbered_list']);
    expect(blocks.map(blockText)).toEqual(['note', 'step']);
  });

  test('a <details> becomes a toggle from its summary', () => {
    const blocks = parse('<details open><summary>Title</summary><p>Body</p></details>');

    expect(blocks.map((b) => b.type)).toEqual(['toggle', 'paragraph']);
    expect(blockText(blocks[0]!)).toBe('Title');
    expect(blocks[0]?.collapsed).toBe(false);
  });

  test('a closed <details> is collapsed', () => {
    expect(parse('<details><summary>T</summary></details>')[0]?.collapsed).toBe(true);
  });

  test('a <details> body nests one level under the toggle', () => {
    const blocks = parse('<details open><summary>T</summary><p>a</p><p>b</p></details>');

    expect(blocks.map((b) => b.depth)).toEqual([0, 1, 1]);
  });

  test('callouts round-trip, icon included', () => {
    const source = parse('<blockquote data-neditor-callout="⚠️">careful</blockquote>');
    const round = blocksFromHtml(document, blocksToHtml(document, source));

    expect(round[0]).toMatchObject({ type: 'callout', icon: '⚠️' });
    expect(blockText(round[0]!)).toBe('careful');
  });

  test('toggles round-trip with their collapsed state and children', () => {
    const source = parse('<details><summary>Title</summary><p>Body</p></details>');
    const round = blocksFromHtml(document, blocksToHtml(document, source));

    expect(round.map((b) => b.type)).toEqual(['toggle', 'paragraph']);
    expect(round.map((b) => b.depth)).toEqual([0, 1]);
    expect(round[0]?.collapsed).toBe(true);
    expect(blockText(round[1]!)).toBe('Body');
  });

  test('an expanded toggle stays expanded through a round trip', () => {
    const source = parse('<details open><summary>T</summary></details>');
    const round = blocksFromHtml(document, blocksToHtml(document, source));

    expect(round[0]?.collapsed).toBe(false);
  });
});

describe('images and tables in HTML', () => {
  const parse = (html: string) => blocksFromHtml(document, html);

  test('a figure becomes an image with its caption', () => {
    const blocks = parse(
      '<figure><img src="https://a.test/x.png" alt="alt"><figcaption>A caption</figcaption></figure>',
    );

    expect(blocks[0]).toMatchObject({ type: 'image', src: 'https://a.test/x.png', alt: 'alt' });
    expect(blockText(blocks[0]!)).toBe('A caption');
  });

  test('a bare img is an image with no caption', () => {
    const blocks = parse('<img src="https://a.test/x.png">');

    expect(blocks[0]?.type).toBe('image');
    expect(blockText(blocks[0]!)).toBe('');
  });

  test('a linked image is still an image', () => {
    // A wrapper with nothing but an image inside has no block to hand its href
    // to, so it is walked as it stands rather than copied inward.
    expect(
      parse('<a href="https://a.test/"><img src="https://a.test/x.png"></a>')[0],
    ).toMatchObject({ type: 'image', src: 'https://a.test/x.png' });
  });

  test('an unsafe or missing source drops the block entirely', () => {
    expect(parse('<img src="javascript:alert(1)">')).toEqual([]);
    expect(parse('<img>')).toEqual([]);
  });

  test('a table becomes a grid, header row first', () => {
    const blocks = parse(
      '<table><thead><tr><th>h1</th><th>h2</th></tr></thead>' +
        '<tbody><tr><td>a</td><td>b</td></tr></tbody></table>',
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.rows?.map((row) => row.map(richToPlainText))).toEqual([
      ['h1', 'h2'],
      ['a', 'b'],
    ]);
  });

  test('a ragged table is squared off rather than rejected', () => {
    const rows = parse('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>')[0]?.rows;

    expect(rows?.map((row) => row.length)).toEqual([2, 2]);
  });

  test('cells keep their inline formatting', () => {
    const rows = parse('<table><tr><td><strong>a</strong></td></tr></table>')[0]?.rows;

    expect(rows?.[0]?.[0]).toEqual([{ text: 'a', marks: ['bold'] }]);
  });

  test('an empty table produces no block', () => {
    expect(parse('<table></table>')).toEqual([]);
  });

  test('images round-trip, caption and alt included', () => {
    const source = parse(
      '<figure><img src="https://a.test/x.png" alt="alt"><figcaption>Cap</figcaption></figure>',
    );
    const round = blocksFromHtml(document, blocksToHtml(document, source));

    expect(round[0]).toMatchObject({ type: 'image', src: 'https://a.test/x.png', alt: 'alt' });
    expect(blockText(round[0]!)).toBe('Cap');
  });

  test('tables round-trip', () => {
    const source = parse(
      '<table><tr><th>h</th><th>i</th></tr><tr><td>a</td><td>b</td></tr></table>',
    );
    const round = blocksFromHtml(document, blocksToHtml(document, source));

    expect(round[0]?.rows?.map((row) => row.map(richToPlainText))).toEqual([
      ['h', 'i'],
      ['a', 'b'],
    ]);
  });

  test('a one-row table serializes as a header alone', () => {
    const source = parse('<table><tr><th>only</th></tr></table>');
    const html = blocksToHtml(document, source);

    expect(html).toContain('<thead>');
    expect(html).not.toContain('<tbody>');
    expect(blocksFromHtml(document, html)[0]?.rows).toHaveLength(1);
  });
});

describe('the clipboard round trip is idempotent', () => {
  const parse = (html: string) => blocksFromHtml(document, html);
  const round = (blocks: Block[]) => blocksFromHtml(document, blocksToHtml(document, blocks));

  test('a bullet whose text begins with a checkbox stays a bullet', () => {
    // Copying a document and pasting it back reclassified the item as a ticked
    // to-do and ate the characters that triggered it.
    const source = parse('<ul><li>placeholder</li></ul>').map((block) => ({
      ...block,
      content: [{ text: '[x] not a to-do' }],
    }));

    expect(round(source).map((block) => block.type)).toEqual(['bulleted_list']);
    expect(round(source).map(blockText)).toEqual(['[x] not a to-do']);
  });

  test('every textual box form is safe inside a bullet', () => {
    const source = ['[ ] open', '\u2610 box', '\u2611 ticked', '\u2705 check'].map((text) => ({
      ...parse('<ul><li>placeholder</li></ul>')[0]!,
      content: [{ text }],
    }));

    expect(round(source).map((block) => block.type)).toEqual([
      'bulleted_list',
      'bulleted_list',
      'bulleted_list',
      'bulleted_list',
    ]);
    expect(round(source).map(blockText)).toEqual([
      '[ ] open',
      '\u2610 box',
      '\u2611 ticked',
      '\u2705 check',
    ]);
  });

  test('a to-do whose text begins with a box keeps both', () => {
    const source = parse('<ul><li><input type="checkbox" checked>[ ] later</li></ul>');

    expect(round(source)[0]).toMatchObject({ type: 'todo', checked: true });
    expect(blockText(round(source)[0]!)).toBe('[ ] later');
  });

  test('a block holding nothing but whitespace keeps it', () => {
    const source = parse('<p>x</p>').map((block) => ({ ...block, content: [{ text: ' ' }] }));

    expect(round(source).map(blockText)).toEqual([' ']);
  });

  test('a table cell holding nothing but whitespace keeps it', () => {
    const source = parse(
      '<table><tr><th>h</th><th>i</th></tr><tr><td>a</td><td>b</td></tr></table>',
    );
    const cells = [
      [[{ text: 'h' }], [{ text: 'i' }]],
      [[{ text: ' ' }], [{ text: 'b' }]],
    ];
    const withSpace = source.map((block) => ({ ...block, rows: cells }));

    expect(round(withSpace)[0]?.rows?.map((row) => row.map(richToPlainText))).toEqual([
      ['h', 'i'],
      [' ', 'b'],
    ]);
  });
});

describe('a copied text range reads back as the runs it was written from', () => {
  // `richTextToHtml` is what a text-range copy puts in `text/html`. A paste
  // into neditor reads the runs from our own type instead, so this is the path
  // for a clipboard that lost that type -- and for every other application.
  const round = (content: RichText): RichText[] =>
    blocksFromHtml(document, richTextToHtml(document, content)).map((block) => block.content);

  test('a newline is a <br>, with no block element around the phrase', () => {
    expect(richTextToHtml(document, [{ text: 'one\ntwo' }])).toBe(
      '<span style="white-space: pre-wrap;">one<br>two</span>',
    );
  });

  test.each<[string, RichText]>([
    [
      'marks and a link',
      [
        { text: 'a ' },
        { text: 'b', marks: ['bold', 'italic'] },
        { text: 'c', link: 'https://e.test/' },
      ],
    ],
    ['a break inside a mark', [{ text: 'x\ny', marks: ['bold'] }]],
    ['a break between runs', [{ text: 'x\n' }, { text: 'y', marks: ['code'] }]],
    ['two breaks in a row', [{ text: 'x\n\ny' }]],
    ['a trailing break', [{ text: 'line\n' }]],
    ['a linked break', [{ text: 'a\nb', link: 'https://e.test/' }]],
  ])('%s', (_, content) => {
    expect(round(content)).toEqual([content]);
  });
});

describe('the DOM to work in is the one passed in', () => {
  test('parsing never reaches for the global Node or NodeFilter', () => {
    // README promises the serializers take a Document so they run on a server
    // with nothing but a shim. Reading these off the global scope broke that
    // outright: `blocksFromHtml` threw before it read a single node.
    const globals = globalThis as Record<string, unknown>;
    const node = globals.Node;
    const filter = globals.NodeFilter;

    delete globals.Node;
    delete globals.NodeFilter;

    try {
      const blocks = blocksFromHtml(document, '<p>a<br>b</p>\n<ul><li>c</li></ul>');

      expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'bulleted_list']);
      expect(blocks.map(blockText)).toEqual(['a\nb', 'c']);
      expect(richToPlainText(parseRichTextFromHtml(document, '<b>a</b> <i>b</i>'))).toBe('a b');
    } finally {
      globals.Node = node;
      globals.NodeFilter = filter;
    }
  });
});

describe('a container that carries a style is not a formatting wrapper', () => {
  const marks = (html: string): string =>
    [
      ...new Set(
        blocksFromHtml(document, html).flatMap((b) =>
          (b.content ?? []).flatMap((r) => r.marks ?? []),
        ),
      ),
    ]
      .sort()
      .join(',');

  test.each([
    [
      'footer',
      '<footer style="text-decoration: underline"><img src="/l.png"><s><p>t</p></s></footer>',
    ],
    ['nav', '<nav style="text-decoration: line-through"><img src="/l.png"><u><p>t</p></u></nav>'],
    ['summary', '<summary style="text-decoration: line-through"><u><p>t</p></u></summary>'],
  ])('%s keeps the mark the tag inside it states', (_name, html) => {
    // `text-decoration` is a shorthand, so a container asking for one
    // decoration reads as turning the others off. Taken as firmly as a
    // wrapper's own formatting, that silently swallowed the tag below it.
    expect(marks(html)).toBe('strikethrough,underline');
  });

  test('a tag inside can still turn a container mark off', () => {
    const html =
      '<header style="font-weight: bold"><img src="/l.png">' +
      '<span style="font-weight: normal; font-style: italic"><p>T</p></span></header>';

    expect(marks(html)).toBe('italic');
  });

  test('an ordinary inline wrapper still decides for everything below it', () => {
    // The nearest wrapper wins as before; only a container's implied marks are
    // overridable, so this must not change.
    expect(marks('<s style="text-decoration: line-through"><u><p>t</p></u></s>')).toBe(
      'strikethrough',
    );
  });
});

describe('a container mark is not re-stated as CSS on the way out', () => {
  const marks = (html: string): string =>
    [
      ...new Set(
        blocksFromHtml(document, html).flatMap((b) =>
          (b.content ?? []).flatMap((r) => r.marks ?? []),
        ),
      ),
    ]
      .sort()
      .join(',');

  test.each([
    [
      'main',
      '<main style="text-decoration:underline"><details><s><h2>a</h2></s></details><img src="https://e.com/l.png"></main>',
    ],
    [
      'nav',
      '<nav style="text-decoration:line-through"><details><u><p>a</p>b</u></details><img src="https://e.com/l.png"></nav>',
    ],
  ])('%s does not cancel a tag standing inside it', (_name, html) => {
    // The weak/firm split kept a container's implied mark from winning during
    // accumulation, but the emitted shell wrote it back out as an explicit
    // declaration — nested deeper than the tag, where it won anyway.
    expect(marks(html)).toBe('strikethrough,underline');
  });

  test('a mark the container really states is still emitted', () => {
    expect(
      marks(
        '<main style="font-weight:bold"><details><h2>a</h2></details><img src="/l.png"></main>',
      ),
    ).toBe('bold');
  });
});

describe('source layout around a pushed-inward wrapper', () => {
  const texts = (html: string): string[][] =>
    blocksFromHtml(document, html).map((b) => (b.content ?? []).map((r) => r.text));

  test('trailing indentation does not become content', () => {
    const html =
      '<footer style="text-decoration:underline">\n  <em>emph</em>\n  <ul><li>i</li></ul>\n' +
      '  <img src="https://e.com/l.png">\n</footer>';

    // The run had already opened when the newline joined it, so it survived
    // into the shell as a `"\n  "` run of document text.
    expect(texts(html)[0]).toEqual(['emph']);
  });

  test('it matches what the same shape gives without a wrapper', () => {
    const wrapped = texts(
      '<footer style="text-decoration:underline">\n  <em>emph</em>\n  <ul><li>i</li></ul>\n</footer>',
    );
    const plain = texts('<div>\n  <em>emph</em>\n  <ul><li>i</li></ul>\n</div>');

    expect(wrapped[0]).toEqual(plain[0]);
  });

  test('a real space between two inline siblings still survives', () => {
    expect(texts('<b><em>a</em> <strong>b</strong><p>x</p></b>')[0]).toEqual(['a', ' b']);
  });

  test.each([
    [
      "whitespace that is a block's whole content",
      '<b><div>A</div><div><br> </div><div>B</div></b>',
      '<div><b>A</b></div><div><b><br> </b></div><div><b>B</b></div>',
    ],
    [
      'a bare space before a heading',
      '<b><section>one <em>two</em> <h2>H</h2></section></b>',
      '<section><b>one </b><b><em>two</em></b><b> </b><h2><b>H</b></h2></section>',
    ],
  ])('distributing a wrapper equals writing it by hand: %s', (_name, wrapped, byHand) => {
    // pushFormattingInward's contract is that `<b><p>x</p></b>` becomes
    // `<p><b>x</b></p>`, so the two spellings must parse alike. Dropping
    // trailing whitespace too eagerly broke that: the first case came back a
    // block short, and the second lost a space the author typed.
    expect(texts(wrapped)).toEqual(texts(byHand));
  });
});

describe('a sealed block reads its whole subtree, so nothing in it is layout', () => {
  const cellRuns = (html: string): unknown =>
    blocksFromHtml(document, html).map((b) => (b.type === 'table' ? b.rows : (b.content ?? [])));

  test('a wrapped table cell equals the hand-distributed spelling', () => {
    // Inside <td>/<li>/<blockquote> parseRichText takes the whole subtree as
    // one block's text, so popping the whitespace out of the shell left it
    // stripped of the wrapper's marks and split one run into three.
    const wrapped = '<b><table><tr><td><span>Cell</span>\n<p>para</p></td></tr></table></b>';
    const byHand = '<table><tr><td><b><span>Cell</span>\n</b><p><b>para</b></p></td></tr></table>';

    expect(cellRuns(wrapped)).toEqual(cellRuns(byHand));
  });

  test('a link keeps its href across the break inside a blockquote', () => {
    const runs = blocksFromHtml(
      document,
      '<a href="https://e.com/"><blockquote><i>Q</i>\n<ul><li>L</li></ul></blockquote></a>',
    )[0]!.content;

    for (const run of runs) {
      expect(run.link).toBe('https://e.com/');
    }
  });

  test('an unsealed container still drops its indentation', () => {
    // The narrowing must not undo what it narrowed: a <footer> is not sealed.
    const wrapped = blocksFromHtml(
      document,
      '<footer>\n  <em>emph</em>\n  <ul><li>i</li></ul>\n</footer>',
    );

    expect((wrapped[0]?.content ?? []).map((r) => r.text)).toEqual(['emph']);
  });
});

describe('a structure tag the block walk reads inline', () => {
  const texts = (html: string): unknown =>
    blocksFromHtml(document, html).map((b) =>
      (b.content ?? []).map((r) => ({ t: r.text, m: r.marks })),
    );

  test('a figcaption keeps the break that separates it, with its marks', () => {
    // <figcaption>, <summary>, <td> and <tr> are structure tags, but visitBlocks
    // reads them inline when they hold no block of their own — so whitespace in
    // front of one separates two runs rather than being layout to discard.
    expect(
      texts('<b><figure><em>Some inline</em>\n<figcaption>Caption</figcaption></figure></b>'),
    ).toEqual(
      texts(
        '<figure><b><em>Some inline</em>\n</b><figcaption><b>Caption</b></figcaption></figure>',
      ),
    );
  });
});

describe('startsBlock agrees with visitBlocks', () => {
  // The pop that trims trailing indentation only holds where a block really
  // begins, and `startsBlock` is a second copy of a decision `visitBlocks`
  // makes in its own dispatch. That copy has drifted three times, each time by
  // omitting tags and each time silently. This walks every tag and fails the
  // moment the two disagree again, rather than waiting for the shape nobody
  // tested.
  const BLOCK_LIKE = [
    'p',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'blockquote',
    'pre',
    'hr',
    'table',
    'figure',
    'details',
    'div',
    'section',
  ];
  const INLINE_LIKE = ['em', 'strong', 'span', 'code', 'a'];

  const texts = (html: string): unknown =>
    blocksFromHtml(document, html).map((b) =>
      (b.content ?? []).map((r) => ({ t: r.text, m: r.marks })),
    );

  test.each(BLOCK_LIKE)('distributing over <%s> equals writing it by hand', (tag) => {
    const inner = tag === 'hr' ? '' : 'Body';
    const wrapped = `<b>\n  <em>Intro</em>\n  <${tag}>${inner}</${tag}>\n</b>`;
    const byHand = `<em><b>Intro</b></em>\n  <${tag}><b>${inner}</b></${tag}>`;

    expect(texts(wrapped)).toEqual(texts(byHand));
  });

  test.each(INLINE_LIKE)('<%s> is read inline, so the space before it survives', (tag) => {
    const runs = texts(`<b><section><em>a</em> <${tag}>b</${tag}></section></b>`) as {
      t: string;
    }[][];

    expect(runs[0]?.map((r) => r.t).join('')).toContain(' ');
  });
});

describe('a caption that holds a block is not sealed', () => {
  const texts = (html: string): unknown =>
    blocksFromHtml(document, html).map((b) => (b.content ?? []).map((r) => r.text));

  const CAPTION =
    '<figure><figcaption><a href="https://x.test/1"><i>A</i>\n<p>B</p></a></figcaption></figure>';
  const SUMMARY =
    '<details><summary><a href="https://x.test/1"><i>A</i>\n<p>B</p></a></summary></details>';

  test.each([
    ['figcaption', CAPTION],
    ['summary', SUMMARY],
  ])('%s parses the same wrapped or not', (_name, html) => {
    // Sealing says parseRichText reads the whole subtree as one block, but
    // visitBlocks dispatches neither tag by name — holding a block, they split
    // like anything else. Sealed anyway, the same caption parsed differently
    // depending only on whether an inline wrapper reached it first.
    expect(texts(`<b>${html}</b>`)).toEqual(texts(html));
    expect(texts(`<code>${html}</code>`)).toEqual(texts(html));
  });

  test.each([
    [
      'a block in the body',
      '<details open><summary>S</summary><em>Intro</em>\n  <p>Body</p></details>',
    ],
    [
      'a block in the summary',
      '<details><summary><a href="https://x.test/1"><i>A</i>\n<p>B</p></a></summary></details>',
    ],
    ['no block at all', '<details open><summary>S</summary><em>only inline</em></details>'],
  ])('a details with %s parses the same wrapped or not', (_name, html) => {
    // visitDetails takes the summary out and re-visits what is left, so it is
    // the BODY that decides whether the subtree reads as one block. Asking of
    // the whole element got these two backwards: a block in the summary says
    // nothing about the body, and a block in the body means the seal's premise
    // is false.
    expect(texts(`<b>${html}</b>`)).toEqual(texts(html));
  });

  test.each([
    ['bold', '<b>', 'marks'],
    ['a link', '<a href="https://e.com/">', 'link'],
  ])('a toggle title stays continuous under %s', (_name, open, kind) => {
    // A <summary> is never reached by visitBlocks: visitDetails skips it, or
    // takes it out of the tree, and reads it whole. Unsealing it let the pop lift the
    // title's own indentation out of the shell, splitting the title into
    // marked / plain / marked — with a link, the middle of the title stopped
    // being part of it. The test covers a block in the summary AND one in the
    // body at once, which is the combination the earlier cases each missed.
    const close = open.startsWith('<a') ? '</a>' : '</b>';
    const html = `${open}<details open><summary><em>Intro</em>\n  <p>Body</p></summary><p>rest</p></details>${close}`;
    const title = blocksFromHtml(document, html)[0]!.content;

    expect(title).toHaveLength(2);
    expect(
      kind === 'link' ? title.every((r) => r.link) : title.every((r) => (r.marks ?? []).length > 0),
    ).toBe(true);
  });

  test.each([
    ['a refused scheme', 'javascript:x'],
    ['no source at all', ''],
    ['a relative path', './a.png'],
  ])('a figure whose image pushImage rejects is not sealed: %s', (_name, src) => {
    // Holding an <img> is not the question the seal asks. pushImage refuses a
    // source sanitizeImageUrl rejects and visitBlocks then recurses into the
    // figure and splits it, so sealing on containsImage sealed a subtree that
    // does get split — and the pop stood down inside it, leaving the figure's
    // own indentation in the document as text.
    const html = `<figure><em>Intro</em>\n  <p>Body</p><img src="${src}"></figure>`;

    expect(texts(`<b>${html}</b>`)).toEqual(texts(html));
  });

  test('a figure whose image is usable still seals', () => {
    const html = '<figure><em>Intro</em>\n  <p>Body</p><img src="https://x.test/a.png"></figure>';

    expect(texts(`<b>${html}</b>`)).toEqual(texts(html));
  });

  test('a caption with no block in it is still sealed', () => {
    expect(texts('<b><figure><em>x</em>\n<figcaption>Cap</figcaption></figure></b>')).toEqual(
      texts('<figure><b><em>x</em>\n</b><figcaption><b>Cap</b></figcaption></figure>'),
    );
  });
});

describe('reading a pasted subtree is linear in its size', () => {
  /**
   * A list item holds the whole list nested under it, and a `<details>` holds
   * every `<details>` below it. Both readers used to deep-clone the element to
   * delete the parts they did not want -- once per level, so the same nodes were
   * copied over and over. Pasting ~10 KB of nested `<ul>` froze the paste
   * handler for 15 seconds and allocated 1.4 GB; 33 KB of nested `<details>`
   * exhausted the heap outright. They skip during the walk now instead.
   *
   * Measured against the flat spelling of the same block count rather than
   * against a stopwatch: the ratio is the property -- reading each node once
   * versus once per ancestor -- and it does not move with the machine. Unfixed
   * these ratios are in the hundreds; fixed they are near one.
   */
  const RATIO = 25;

  /**
   * The best of five runs, not one.
   *
   * A single timing of a ~0.6ms parse is mostly whatever else the machine was
   * doing: over fifteen trials the ratio below ranged 0.8 to 4.1 with one
   * reading, and 1.2 to 1.8 with three. It takes one stalled run to spoil a
   * single measurement and five to spoil this minimum, and that is the whole
   * difference between this failing on a busy CI runner and not. Five runs of
   * a 0.6ms parse costs 3ms, so the margin is close to free.
   *
   * The sizes cannot grow to solve it instead: `parseRichText` bounds list
   * nesting at 256 levels, so a nested `<ul>` past that stops producing one
   * block per level -- at n=1000 it yields 257 against the flat spelling's
   * 1000, and the two sides are no longer the same document in two shapes.
   */
  function elapsed(html: string, expected: number): number {
    let best = Infinity;

    for (let run = 0; run < 5; run += 1) {
      const started = performance.now();
      const blocks = blocksFromHtml(document, html);

      expect(blocks).toHaveLength(expected);
      best = Math.min(best, performance.now() - started);
    }

    return Math.max(best, 0.1);
  }

  test('deeply nested lists cost about what the same blocks cost flat', () => {
    const n = 250;
    const nested = elapsed(`${'<ul><li>a'.repeat(n)}${'</li></ul>'.repeat(n)}`, n);
    const flat = elapsed(`<ul>${'<li>a</li>'.repeat(n)}</ul>`, n);

    expect(
      nested / flat,
      `nested ${Math.round(nested)}ms vs flat ${Math.round(flat)}ms`,
    ).toBeLessThan(RATIO);
  });

  test('deeply nested toggles do too', () => {
    const n = 250;
    const nested = elapsed(
      `${'<details><summary>s</summary>'.repeat(n)}${'</details>'.repeat(n)}`,
      n,
    );
    const flat = elapsed(`${'<details><summary>s</summary></details>'.repeat(n)}`, n);

    expect(
      nested / flat,
      `nested ${Math.round(nested)}ms vs flat ${Math.round(flat)}ms`,
    ).toBeLessThan(RATIO);
  });

  test('nested toggles whose summaries are wrapped cost what direct summaries cost', () => {
    // A `<summary>` that is not the details' own child used to send its
    // toggle down a copy of the whole element, to delete the summary from
    // that -- and a `<details>` holds every one nested below it, so each level
    // copied, and re-asked every question about, everything under it. At this
    // size that ran happy-dom out of heap; 500 levels with 40 paragraphs each
    // took 3.1 s in Chromium against 117 ms with the summaries in place. The
    // same toggles with the summary as the direct child are the baseline: the
    // same blocks out, the same text.
    const n = 180;
    const body = '<p>b</p>'.repeat(10);
    const wrapped = elapsed(
      `${`<details><span><summary>t</summary></span>${body}`.repeat(n)}${'</details>'.repeat(n)}`,
      n * 11,
    );
    const direct = elapsed(
      `${`<details><summary>t</summary>${body}`.repeat(n)}${'</details>'.repeat(n)}`,
      n * 11,
    );

    expect(
      wrapped / direct,
      `wrapped ${Math.round(wrapped)}ms vs direct ${Math.round(direct)}ms`,
    ).toBeLessThan(RATIO);
  });

  test('summaries hidden in a noscript below nested toggles cost what they cost beside them', () => {
    // Each toggle asks for its summary. The query that answered found the
    // first `<summary>` anywhere below -- inside the `<noscript>` at the
    // bottom -- so every level searched the whole subtree under it. 167 KB of
    // this held Chromium's paste handler for 10.6 seconds. The same markup
    // with the noscript beside the toggles instead of below them is the
    // baseline: the same nodes to parse, the same blocks out.
    const n = 100;
    const hidden = `<noscript>${'<div>'.repeat(n)}${'<summary>s</summary>'.repeat(4 * n)}${'</div>'.repeat(n)}</noscript>`;
    const below = elapsed(`${'<details>'.repeat(n)}${hidden}${'</details>'.repeat(n)}`, n);
    const beside = elapsed(`${'<details>'.repeat(n)}${'</details>'.repeat(n)}${hidden}`, n);

    expect(
      below / beside,
      `below ${Math.round(below)}ms vs beside ${Math.round(beside)}ms`,
    ).toBeLessThan(RATIO);
  });

  test('the nesting is still read, not just skipped past', () => {
    const blocks = blocksFromHtml(
      document,
      '<ul><li>one<ul><li>two<ul><li>three</li></ul></li></ul></li></ul>',
    );

    expect(blocks.map((block) => [blockText(block), block.depth])).toEqual([
      ['one', 0],
      ['two', 1],
      ['three', 2],
    ]);
  });
});

describe('nesting deeper than the model can express is bounded, not followed', () => {
  /**
   * The readers descend recursively, so before this a deeply nested paste threw
   * `RangeError: Maximum call stack size exceeded` straight out of the `paste`
   * handler -- around 1,500 levels, and reachable with a few kilobytes. The
   * model clamps block depth to 32, so nothing that deep was ever going to
   * survive as structure anyway.
   *
   * Past the bound the text is still read, as one block: the point is to stop
   * recursing, not to drop what the author wrote.
   */
  test('a list nested far past the bound reads without throwing', () => {
    const html = `${'<ul><li>a'.repeat(3000)}${'</li></ul>'.repeat(3000)}`;

    const blocks = blocksFromHtml(document, html);

    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.length).toBeLessThan(3000);
    expect(blocks.every((one) => blockText(one).length > 0)).toBe(true);
  });

  test('so does a toggle, and a plain wrapper chain', () => {
    const toggles = `${'<details><summary>s</summary>'.repeat(3000)}${'</details>'.repeat(3000)}`;
    const wrappers = `${'<div>'.repeat(20000)}deep${'</div>'.repeat(20000)}`;

    expect(blocksFromHtml(document, toggles).length).toBeLessThan(3000);
    expect(blocksFromHtml(document, wrappers).map(blockText)).toEqual(['deep']);
  });

  test('inline nesting past the bound keeps its text', () => {
    const html = `<p>${'<span>'.repeat(20000)}deep${'</span>'.repeat(20000)}</p>`;

    expect(blocksFromHtml(document, html).map(blockText)).toEqual(['deep']);
  });

  test('ordinary nesting is nowhere near the bound and is read in full', () => {
    const html = `${'<ul><li>a'.repeat(20)}${'</li></ul>'.repeat(20)}`;

    expect(blocksFromHtml(document, html)).toHaveLength(20);
  });
});

describe('a code block keeps its first line through the clipboard', () => {
  /**
   * HTML tree construction ignores a single newline immediately after a `<pre>`
   * start tag, so a code block whose first line was blank lost it on every
   * copy-paste -- `blocksToHtml` writes `text/html` and the paste handler
   * prefers it. Measured in Chrome: `<pre>\nX` reads back as "X", while
   * `<pre><code>\nX` reads back as "\nX", which is also the conventional markup
   * for a code block.
   *
   * Doubling the newline would have worked too, and only in a real browser:
   * happy-dom does not implement that rule, so the fix would have been correct
   * in production and wrong in this suite. The `<code>` wrapper needs no rule
   * at all, and was checked in both.
   */
  const roundTrip = (text: string): string => {
    const html = blocksToHtml(document, [{ id: 'c', type: 'code', depth: 0, content: [{ text }] }]);

    return blocksFromHtml(document, html)
      .flatMap((block) => block.content ?? [])
      .map((run) => run.text)
      .join('');
  };

  test.each([
    ['a blank first line', '\nconst a = 1;'],
    ['two blank first lines', '\n\nx'],
    ['a newline in the middle', 'a\nb'],
    ['no newline at all', 'plain'],
    ['nothing but a newline', '\n'],
  ])('%s survives', (_name, text) => {
    expect(roundTrip(text)).toBe(text);
  });

  /**
   * This is the assertion that actually guards the fix. The five above cannot:
   * happy-dom does not drop the newline after `<pre>`, so they pass either way
   * -- mutation-checked, and reverting to a bare `<pre>` fails only this one.
   * Pinning the markup is the closest a suite running on this DOM can get to
   * pinning a browser rule it does not implement.
   */
  test('the markup is the conventional pre > code', () => {
    const html = blocksToHtml(document, [
      { id: 'c', type: 'code', depth: 0, content: [{ text: 'x' }] },
    ]);

    expect(html).toContain('<pre><code>');
  });
});

describe('a code block reads the text the sanitizer left, not everything under it', () => {
  /**
   * The `<pre>` branch took `element.textContent`, which includes the source of
   * a `<script>` or `<style>` sitting inside it -- markup every other branch
   * drops. It is inert, since parsing happens in a detached template and this
   * becomes text either way, but it is still somebody else's code arriving in
   * the user's document as content.
   */
  test.each([
    ['a script', '<pre>keep me<script>alert(1)</script></pre>', 'alert(1)'],
    ['a style', '<pre>keep me<style>.x{color:red}</style></pre>', 'color:red'],
  ])('%s inside a pre is dropped, not read as code', (_name, html, leaked) => {
    const text = blocksFromHtml(document, html)
      .flatMap((one) => one.content ?? [])
      .map((run) => run.text)
      .join('');

    expect(text).toBe('keep me');
    expect(text).not.toContain(leaked);
  });

  test('ordinary code is untouched', () => {
    const text = blocksFromHtml(document, '<pre>a\nb</pre>')
      .flatMap((one) => one.content ?? [])
      .map((run) => run.text)
      .join('');

    expect(text).toBe('a\nb');
  });
});

describe('a summary is the toggle title once, wherever it sits', () => {
  /**
   * Skipping it by node identity only reaches a direct child:
   * `visitBlocksInner` tests the exclusion against its own children, and the
   * descents into lists, quotes and blocks do not carry it. So a `<summary>`
   * wrapped in anything was read as the title *and* again as body content --
   * in the list and quote cases concatenated into that block's own text, which
   * is wrong text with no visible cause. Those shapes take the summary out of
   * the tree instead, which works at any depth.
   */
  const read = (html: string): [string, string][] =>
    blocksFromHtml(document, html).map((one) => [one.type, blockText(one)]);

  test.each([
    [
      'wrapped in a span',
      '<details open><span><summary>Title</summary><p>Body</p></span></details>',
    ],
    [
      'inside a list item',
      '<details open><ul><li><summary>Title</summary>item</li></ul></details>',
    ],
    ['inside a heading', '<details open><h2><summary>Title</summary></h2><p>Body</p></details>'],
    [
      'inside a quote',
      '<details open><blockquote><summary>Title</summary>quoted</blockquote></details>',
    ],
  ])('%s is not repeated into the body', (_name, html) => {
    const blocks = read(html);

    expect(blocks[0]).toEqual(['toggle', 'Title']);
    expect(
      blocks.slice(1).some(([, text]) => text.includes('Title')),
      'the title must appear once, as the toggle',
    ).toBe(false);
  });

  test.each([
    ['', ''],
    ['<b>', '</b>'],
  ])("a wrapped summary's block does not split the body: %j", (open, close) => {
    // The summary is taken out of the tree, and what was remembered about the
    // elements around it has to go with it. The `<b>` asks, before the toggle
    // is reached, whether the `<span>` holds a block -- it does, the `<p>` in the
    // summary -- and answered from memory after the summary had gone, `tail`
    // was read as a block of its own and parted from the `x` it runs into.
    // Without the `<b>` nothing asks early, which is the control.
    const html = `${open}<details open><span><summary><p>T</p></summary>tail</span>x</details>${close}`;

    expect(
      blocksFromHtml(document, html).map((one) => [one.type, one.depth, blockText(one)]),
    ).toEqual([
      ['toggle', 0, 'T'],
      ['paragraph', 1, 'tailx'],
    ]);
  });

  test('the ordinary shape is unchanged', () => {
    expect(read('<details open><summary>Title</summary><p>Body</p></details>')).toEqual([
      ['toggle', 'Title'],
      ['paragraph', 'Body'],
    ]);
  });

  test("a toggle with no summary of its own does not take a nested toggle's", () => {
    // The summary belongs to the `<details>` it sits in. Searching the whole
    // subtree gave the outer toggle the inner one's title, and the inner
    // toggle -- whose summary was then taken out of the copy as the outer
    // title -- came back with none. After a paragraph: at the very start of
    // a copy a `<details>` with no summary of its own is a drag begun in its
    // body, and is read as its body (R8-FMT-1).
    expect(
      blocksFromHtml(
        document,
        '<p>before</p><details><p>outer body</p><details><summary>inner</summary>b</details></details>',
      ).map((one) => [one.type, one.depth, blockText(one)]),
    ).toEqual([
      ['paragraph', 0, 'before'],
      ['toggle', 0, ''],
      ['paragraph', 1, 'outer body'],
      ['toggle', 1, 'inner'],
      ['paragraph', 2, 'b'],
    ]);
  });

  test('and so is a summary inside a plain container', () => {
    expect(read('<details open><div><summary>Title</summary><p>Body</p></div></details>')).toEqual([
      ['toggle', 'Title'],
      ['paragraph', 'Body'],
    ]);
  });
});

describe('content a skipped element holds is not read by any query either', () => {
  /**
   * `SKIP_TAGS` was honoured by the walker and not by the readers that look a
   * part up by query -- a figure's image and caption, a toggle's summary, a
   * quote's lists -- which found it inside a `<noscript>` all the same.
   * Chromium and WebKit parse a `<noscript>` in the inert paste document into
   * elements, and so does happy-dom (checked here, so these inputs are the
   * shape a real paste produces rather than one built by hand); Firefox
   * parses it as text and never had the problem.
   */
  const shape = (html: string) =>
    blocksFromHtml(document, html).map((block) => [
      block.type,
      block.src ?? null,
      richToPlainText(block.content),
    ]);

  test('happy-dom parses noscript content as elements, as Chromium does', () => {
    const template = document.createElement('template');
    template.innerHTML = '<noscript><p>x</p></noscript>';

    expect(template.content.firstChild?.firstChild?.nodeName).toBe('P');
  });

  test('a caption inside a noscript is not the image caption', () => {
    expect(
      shape(
        '<figure><img src="https://a.test/x.png"><noscript><figcaption>hidden caption</figcaption></noscript></figure>',
      ),
    ).toEqual([['image', 'https://a.test/x.png', '']]);
  });

  test('a summary inside a noscript is not the toggle title', () => {
    // After a paragraph, as the toggle above (R8-FMT-1).
    expect(
      shape(
        '<p>a</p><details><noscript><summary>hidden summary</summary></noscript><p>b</p></details>',
      ),
    ).toEqual([
      ['paragraph', null, 'a'],
      ['toggle', null, ''],
      ['paragraph', null, 'b'],
    ]);
  });

  test('an image inside a noscript does not make the figure an image', () => {
    expect(
      shape('<figure><noscript><img src="https://a.test/x.png"></noscript>text</figure>'),
    ).toEqual([['paragraph', null, 'text']]);
  });

  test('a wrapped summary is taken out of the body, not the hidden one before it', () => {
    // A wrapped summary is taken out of the tree once it is read as the title.
    // When that was done on a copy, removing the copy's first `<summary>` took
    // the hidden one and left the title to be read a second time as body
    // text; the summary taken out now is the one that was read.
    expect(
      shape(
        '<details><noscript><summary>no</summary></noscript><span><summary>yes</summary></span><p>b</p></details>',
      ),
    ).toEqual([
      ['toggle', null, 'yes'],
      ['paragraph', null, 'b'],
    ]);
  });

  test('a list inside a noscript is not a quoted list', () => {
    expect(
      shape('<blockquote>q<noscript><ul><li>hidden item</li></ul></noscript></blockquote>'),
    ).toEqual([['quote', null, 'q']]);
  });

  test('the visible caption, summary and image are still read', () => {
    expect(
      shape(
        '<figure><noscript><img src="https://a.test/n.png"></noscript><img src="https://a.test/x.png"><noscript><figcaption>no</figcaption></noscript><figcaption>yes</figcaption></figure>',
      ),
    ).toEqual([['image', 'https://a.test/x.png', 'yes']]);
    expect(
      shape(
        '<details><noscript><summary>no</summary></noscript><summary>yes</summary><p>b</p></details>',
      ),
    ).toEqual([
      ['toggle', null, 'yes'],
      ['paragraph', null, 'b'],
    ]);
  });
});

describe('a space between two inline elements outside any paragraph', () => {
  // A browser copying part of a paragraph puts only the inline markup on the
  // clipboard -- `<b>Hello</b> <a href>world</a>` with no <p> around it -- and
  // the block walk read the space between two inline siblings as layout, so
  // the paste arrived as "Helloworld". The same walk runs inside a <div> and
  // in a paragraph that also holds an image, which is how those lost it too.
  const text = (html: string): string[] =>
    blocksFromHtml(document, html).map((b) => (b.content ?? []).map((r) => r.text).join(''));

  test.each([
    ['a bare inline fragment', '<b>a</b> <i>b</i>', ['a b']],
    [
      'a fragment behind the meta tag Chrome writes',
      '<meta charset="utf-8"><b>a</b> <i>b</i>',
      ['a b'],
    ],
    ['inline siblings in a div', '<div><b>a</b> <i>b</i></div>', ['a b']],
    [
      'two links in a div',
      '<div><a href="https://a.b/">x</a> <a href="https://c.d/">y</a></div>',
      ['x y'],
    ],
  ])('%s keeps the space', (_name, html, expected) => {
    expect(text(html)).toEqual(expected);
  });

  test('a paragraph that also holds an image keeps its spaces', () => {
    const blocks = blocksFromHtml(
      document,
      '<p>Hello <b>world</b> <a href="https://ok.com/">ok</a><img src="https://e.com/x.png"></p>',
    );

    expect(blockText(blocks[0]!)).toBe('Hello world ok');
    expect(blocks[1]?.type).toBe('image');
  });

  test('indentation before a block still is not content', () => {
    expect(text('<div>\n  <b>a</b>\n  <p>c</p>\n</div>')).toEqual(['a', 'c']);
    expect(text('<b>a</b> <i>b</i>\n')).toEqual(['a b']);
  });
});

describe('an empty item in a list we wrote is a real item', () => {
  /**
   * An empty `<li>` holding only a nested list is how indentation alone is
   * written elsewhere, so a foreign one is skipped. Ours never writes that
   * shape -- a deeper list goes inside the item it hangs off, which always
   * exists -- so in a `data-neditor-list` an empty item is an empty block, and
   * skipping it promoted its child: [bullet "", bullet "child" at depth 1]
   * came back as one bullet "child" at depth 0.
   */
  const through = (blocks: Block[]): Array<[string, number, boolean | undefined, string]> =>
    blocksFromHtml(document, blocksToHtml(document, blocks)).map((block) => [
      block.type,
      block.depth,
      block.checked,
      blockText(block),
    ]);
  const item = (type: Block['type'], text: string, depth = 0, checked?: boolean): Block =>
    ({
      id: `${type}-${depth}-${text}`,
      type,
      depth,
      content: text ? [{ text }] : [],
      ...(checked === undefined ? {} : { checked }),
    }) as Block;

  test.each(['bulleted_list', 'numbered_list'] as const)('%s', (type) => {
    expect(through([item(type, ''), item(type, 'child', 1)])).toEqual([
      [type, 0, undefined, ''],
      [type, 1, undefined, 'child'],
    ]);
  });

  test('a to-do keeps its own state, not its child’s', () => {
    expect(through([item('todo', '', 0, true), item('todo', 'child', 1, false)])).toEqual([
      ['todo', 0, true, ''],
      ['todo', 1, false, 'child'],
    ]);
  });

  test.each([' ', '  x', '☐ x'])('a to-do whose text is %j keeps all of it', (text) => {
    // The box we write is one glyph and one space; reading it back with the
    // foreign rule, which takes any whitespace after a box, ate the text's own.
    expect(through([item('todo', text, 0, true)])).toEqual([['todo', 0, true, text]]);
  });

  test('a foreign empty item that only holds a list is still indentation', () => {
    expect(
      blocksFromHtml(document, '<ul><li><ul><li>child</li></ul></li></ul>').map((block) => [
        block.depth,
        blockText(block),
      ]),
    ).toEqual([[1, 'child']]);
  });
});

describe('audit 28: block content inside a foreign list item', () => {
  const shape = (html: string) =>
    blocksFromHtml(document, html).map((block) => ({
      type: block.type,
      depth: block.depth,
      text: richToPlainText(block.content),
      ...(block.src === undefined ? {} : { src: block.src, alt: block.alt }),
      ...(block.rows === undefined
        ? {}
        : { rows: block.rows.map((row) => row.map((cell) => richToPlainText(cell))) }),
      ...(block.checked === undefined ? {} : { checked: block.checked }),
    }));

  // The item's text is what comes before its first block; the blocks are its
  // children, in order, the way a nested list already was.
  test('an image after the text is a child image', () => {
    expect(
      shape('<ol><li>Open settings<br><img src="https://a.test/s.png" alt="shot"></li></ol>'),
    ).toEqual([
      { type: 'numbered_list', depth: 0, text: 'Open settings' },
      { type: 'image', depth: 1, text: '', src: 'https://a.test/s.png', alt: 'shot' },
    ]);
  });

  test('a table after the text is a child table', () => {
    expect(shape('<ul><li>a<table><tr><td>x</td><td>y</td></tr></table></li></ul>')).toEqual([
      { type: 'bulleted_list', depth: 0, text: 'a' },
      { type: 'table', depth: 1, text: '', rows: [['x', 'y']] },
    ]);
  });

  test('text after a nested list stays after it', () => {
    expect(shape('<ul><li><p>a</p><ul><li>b</li></ul><p>c</p></li></ul>')).toEqual([
      { type: 'bulleted_list', depth: 0, text: 'a' },
      { type: 'bulleted_list', depth: 1, text: 'b' },
      { type: 'paragraph', depth: 1, text: 'c' },
    ]);
  });

  // An item holding nothing but a block is that block, a level in, as an item
  // holding nothing but a list is that list (the paste normalises the depth).
  test('an item that is only an image is the image', () => {
    expect(shape('<ul><li><img src="https://a.test/s.png" alt="a"></li></ul>')).toEqual([
      { type: 'image', depth: 1, text: '', src: 'https://a.test/s.png', alt: 'a' },
    ]);
  });

  // Paragraphs alone are still the item's text, as before.
  test('paragraphs alone are the item text', () => {
    expect(shape('<ul><li><p>a</p><p>c</p></li></ul>')).toEqual([
      { type: 'bulleted_list', depth: 0, text: 'a\nc' },
    ]);
  });

  // A table's caption has nowhere to go in the block, so it goes above it.
  test("a table's caption is a paragraph above it", () => {
    expect(shape('<table><caption>Cap</caption><tr><td>x</td></tr></table>')).toEqual([
      { type: 'paragraph', depth: 0, text: 'Cap' },
      { type: 'table', depth: 0, text: '', rows: [['x']] },
    ]);
  });

  // GitHub's task list: the space after the box is the box's, as it is after
  // a textual `[ ]`.
  test('a checkbox to-do loses the space after the box', () => {
    expect(
      shape(
        '<ul><li class="task-list-item"><input type="checkbox" disabled checked> Done</li></ul>',
      ),
    ).toEqual([{ type: 'todo', depth: 0, text: 'Done', checked: true }]);
  });
});

describe('audit 29: list items holding blocks', () => {
  const shape = (html: string) =>
    blocksFromHtml(document, html).map((block) => ({
      type: block.type,
      depth: block.depth,
      text: richToPlainText(block.content),
      ...(block.checked === undefined ? {} : { checked: block.checked }),
    }));

  // micromark's rendering of an item that is only a fenced block: the
  // pretty-printing around the block is not a line of text.
  test('an item that is only a code block is the code block', () => {
    expect(
      shape(
        '<ol>\n<li>Install</li>\n<li>\n<pre><code>npm i x</code></pre>\n</li>\n<li>Run</li>\n</ol>',
      ),
    ).toEqual([
      { type: 'numbered_list', depth: 0, text: 'Install' },
      { type: 'code', depth: 1, text: 'npm i x' },
      { type: 'numbered_list', depth: 0, text: 'Run' },
    ]);
  });

  // Layout around the block is no text either, however it is spelled.
  test.each([
    '<ol><li>a</li><li><br> <h2>M0</h2></li></ol>',
    '<ol><li>a</li><li><h2>M0</h2> <a href="https://l.test/">\n</a></li></ol>',
  ])('%s has no blank item', (html) => {
    expect(shape(html)).toEqual([
      { type: 'numbered_list', depth: 0, text: 'a' },
      { type: 'heading2', depth: 1, text: 'M0' },
    ]);
  });

  // A to-do's box is content: it stays, empty, in front of its block.
  test('a to-do holding only a block keeps its box', () => {
    expect(shape('<ul><li><input type="checkbox" checked> <h2>x</h2></li></ul>')).toEqual([
      { type: 'todo', depth: 0, text: '', checked: true },
      { type: 'heading2', depth: 1, text: 'x' },
    ]);
  });

  // Text after the first block is still the item's: the to-do, its state and
  // the numbered list all survive an image in front of the text.
  test('a GitHub task item with an image keeps the to-do', () => {
    expect(
      shape(
        '<ul><li class="task-list-item"><input type="checkbox" disabled checked> <img src="https://a.test/i.png" alt=""> Ship</li></ul>',
      ),
    ).toEqual([
      { type: 'todo', depth: 0, text: 'Ship', checked: true },
      { type: 'image', depth: 1, text: '' },
    ]);
  });

  test('items led by an icon stay a numbered list', () => {
    expect(
      shape(
        '<ol><li><img src="https://a.test/1.png"> Step one</li><li><img src="https://a.test/2.png"> Step two</li></ol>',
      ),
    ).toEqual([
      // The space after the icon starts the item's text once the icon is a
      // block of its own, and a browser draws none there.
      { type: 'numbered_list', depth: 0, text: 'Step one' },
      { type: 'image', depth: 1, text: '' },
      { type: 'numbered_list', depth: 0, text: 'Step two' },
      { type: 'image', depth: 1, text: '' },
    ]);
  });

  // An image the reader cannot use is no block, so it splits nothing.
  test('an unusable image inside the text splits nothing', () => {
    // The two spaces it stood between are one, as a browser draws them.
    expect(shape('<ul><li>Click <img src="cid:x"> to open</li></ul>')).toEqual([
      { type: 'bulleted_list', depth: 0, text: 'Click to open' },
    ]);
  });

  // And an item holding only one is still a blank bullet, not nothing.
  test('an item holding only an unusable image is a blank bullet', () => {
    expect(shape('<ul><li><img src="cid:a"></li></ul>')).toEqual([
      { type: 'bulleted_list', depth: 0, text: '' },
    ]);
  });

  // A checkbox inside one of the item's blocks is that block's, not the item's.
  test('a checkbox in a child table does not make the item a to-do', () => {
    expect(
      shape('<ul><li>a<table><tr><td><input type="checkbox">x</td></tr></table></li></ul>'),
    ).toEqual([
      { type: 'bulleted_list', depth: 0, text: 'a' },
      { type: 'table', depth: 1, text: '' },
    ]);
  });

  // Each kind of block an item can hold.
  test.each([
    ['<pre>x</pre>', 'code'],
    ['<blockquote>x</blockquote>', 'quote'],
    ['<h2>x</h2>', 'heading2'],
    ['<hr>', 'divider'],
    ['<figure><img src="https://a.test/i.png"><figcaption>x</figcaption></figure>', 'image'],
  ])('%s in an item is its child', (html, type) => {
    expect(shape(`<ul><li>a${html}</li></ul>`).map((block) => [block.type, block.depth])).toEqual([
      ['bulleted_list', 0],
      [type, 1],
    ]);
  });

  // Bare text after a block or a nested list has no element of its own to be
  // a block, so it stays the item's text -- on a line of its own, not joined
  // to the word before the block.
  test.each([
    ['<ul><li>a<ul><li>b</li></ul>c</li></ul>', 'a\nc'],
    ['<ul><li>a<pre>x</pre>c</li></ul>', 'a\nc'],
  ])('%s keeps its text apart', (html, text) => {
    expect(shape(html)[0]?.text).toBe(text);
  });

  // Whitespace after a nested list is no text to break the line for.
  test('whitespace after a nested list adds no break', () => {
    expect(shape('<ul><li>a<ul><li>b</li></ul><b> </b></li></ul>')[0]?.text).toBe('a ');
  });

  // Google Docs, and a browser's own indent command, nest a list directly
  // inside a list rather than inside an item.
  test('a list nested directly in a list is a level deeper', () => {
    expect(shape('<ul><li>a</li><ul><li>b</li></ul><li>c</li></ul>')).toEqual([
      { type: 'bulleted_list', depth: 0, text: 'a' },
      { type: 'bulleted_list', depth: 1, text: 'b' },
      { type: 'bulleted_list', depth: 0, text: 'c' },
    ]);
  });

  // Rows and cells are read from the table's own children, never by a query
  // over everything below it, which recursed through every level nested in a
  // cell and overflowed the stack.
  test.each([
    ['a table in an item', '<ul><li>a<table><tr><td>', '</td></tr></table></li></ul>'],
    [
      'a table in a cell',
      '<table><tr><td>a<table><tr><td>',
      '</td></tr></table></td></tr></table>',
    ],
  ])('%s, 1,100 deep, reads without overflowing', (_name, open, close) => {
    expect(() =>
      blocksFromHtml(document, `${open.repeat(1100)}x${close.repeat(1100)}`),
    ).not.toThrow();
  });

  // At the nesting bound the item's blocks are still not dropped.
  test('an item past the nesting bound keeps all its text', () => {
    const html = `${'<div>'.repeat(1023)}<ul><li>a<pre>x</pre>b<p>c</p></li></ul>${'</div>'.repeat(1023)}`;
    // Exactly once each: the bound reads the item's blocks as text, not the
    // item again.
    expect(shape(html)).toEqual([
      { type: 'bulleted_list', depth: 0, text: 'a\nb' },
      { type: 'paragraph', depth: 1, text: 'x' },
      { type: 'paragraph', depth: 1, text: 'c' },
    ]);
  });
});

describe('audit 30', () => {
  const shape = (html: string) =>
    blocksFromHtml(document, html).map((block) => ({
      type: block.type,
      depth: block.depth,
      text: richToPlainText(block.content),
    }));

  // A list directly inside a list counts against the list bound like any other.
  test('lists nested directly in lists, 4,000 deep, read without overflowing', () => {
    expect(() =>
      blocksFromHtml(document, `${'<ul>'.repeat(4000)}<li>x</li>${'</ul>'.repeat(4000)}`),
    ).not.toThrow();
  });

  // A figure or a rule between two pieces of an item's text breaks the line,
  // as any other block does; an image inline in the text does not.
  test.each([
    [
      '<ul><li>Before<figure><img src="https://a.test/i.png"><figcaption>cap</figcaption></figure>After</li></ul>',
      'Before\nAfter',
    ],
    ['<ul><li>Before<hr>After</li></ul>', 'Before\nAfter'],
    ['<ul><li>Click <img src="https://a.test/i.png"> to open</li></ul>', 'Click to open'],
  ])('%s reads its text as %j', (html, text) => {
    expect(shape(html)[0]?.text).toBe(text);
  });

  // A space between two inline elements is content wherever it is read.
  test.each([
    ['<b>bold</b> <i>it</i>', 'bold it'],
    ['<div><a href="https://a.test/1">one</a> <a href="https://a.test/2">two</a></div>', 'one two'],
    // A paragraph holding an image is split around it, through the same path.
    [
      '<ul><li>x<pre>c</pre><p><a href="https://a.test/1">one</a> <a href="https://a.test/2">two</a> <img src="https://a.test/i.png"></p></li></ul>',
      'one two',
    ],
  ])('%s keeps its space', (html, text) => {
    expect(
      shape(html)
        .filter((block) => block.type === 'paragraph')
        .at(-1)?.text,
    ).toBe(text);
  });

  // But whitespace before a block is still layout.
  test('whitespace between inline text and a block is not kept', () => {
    expect(shape('<div><b>x</b> <p>y</p></div>').map((block) => block.text)).toEqual(['x', 'y']);
  });

  // GitHub wraps every image in a link, and a loose list wraps it in a
  // paragraph: an element holding nothing but a usable image is the image.
  test.each([
    [
      '<ol><li><p>Open settings</p><p><img src="https://a.test/s.png" alt="s"></p></li><li><p>Save</p></li></ol>',
      [
        { type: 'numbered_list', depth: 0, text: 'Open settings' },
        { type: 'image', depth: 1, text: '' },
        { type: 'numbered_list', depth: 0, text: 'Save' },
      ],
    ],
    [
      '<ul><li class="task-list-item"><input type="checkbox" disabled checked> <a href="https://a.test/i.png"><img src="https://a.test/i.png" alt=""></a> Ship</li></ul>',
      [
        { type: 'todo', depth: 0, text: 'Ship' },
        { type: 'image', depth: 1, text: '' },
      ],
    ],
  ])('%s keeps the image', (html, blocks) => {
    expect(shape(html)).toEqual(blocks);
  });

  // A link holding text as well as an image is the item's text, and the
  // image is handed on beside it rather than dropped.
  test('a link holding text and an image stays text', () => {
    expect(
      shape(
        '<ul><li>See <a href="https://a.test/"><img src="https://a.test/i.png">here</a></li></ul>',
      ),
    ).toEqual([
      { type: 'bulleted_list', depth: 0, text: 'See here' },
      { type: 'image', depth: 1, text: '' },
    ]);
  });

  test("a table's footer rows are rows", () => {
    const [table] = blocksFromHtml(
      document,
      '<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>b</td></tr></tbody><tfoot><tr><td>f</td></tr></tfoot></table>',
    );
    expect(table?.rows?.map((row) => row.map((cell) => richToPlainText(cell)))).toEqual([
      ['h'],
      ['b'],
      ['f'],
    ]);
  });

  // Only beside an item's blocks is whitespace-only text layout.
  test('a foreign item holding only a space keeps it', () => {
    expect(shape('<ul><li> </li></ul>')).toEqual([{ type: 'bulleted_list', depth: 0, text: ' ' }]);
  });

  // Deep inline chains are walked without recursion.
  test.each([
    ['a checkbox search', `<ul><li>a${'<span>'.repeat(5000)}x</li></ul>`],
    ['a buffered inline run', `${'<b>'.repeat(5000)}x`],
  ])('%s 5,000 deep reads without overflowing', (_name, html) => {
    expect(() => blocksFromHtml(document, html)).not.toThrow();
  });
});

describe('audit 31', () => {
  const shape = (html: string) =>
    blocksFromHtml(document, html).map((block) => ({
      type: block.type,
      depth: block.depth,
      text: richToPlainText(block.content),
      ...(block.checked === undefined ? {} : { checked: block.checked }),
    }));

  // A loose task item: the box sits beside the image in the first paragraph.
  // That paragraph holds an input, so it is not an image block.
  test.each([
    '<ul class="contains-task-list"><li class="task-list-item"><p><input type="checkbox" checked disabled> <a href="https://a.test/i.png"><img src="https://a.test/i.png"></a></p><p>Ship it</p></li></ul>',
    '<ul><li><p><input type="checkbox" checked> <img src="https://a.test/i.png"></p></li></ul>',
  ])('%s keeps its to-do', (html) => {
    expect(shape(html)[0]).toMatchObject({ type: 'todo', depth: 0, checked: true });
  });

  // An item whose first block comes before any text takes its first paragraph
  // as its text, so the list keeps the item and its number.
  test.each([
    [
      '<ol><li><p><a href="https://a.test/a.png"><img src="https://a.test/a.png"></a></p><p>Click the button.</p></li><li><p>Next</p></li></ol>',
      [
        { type: 'numbered_list', depth: 0, text: 'Click the button.' },
        { type: 'image', depth: 1, text: '' },
        { type: 'numbered_list', depth: 0, text: 'Next' },
      ],
    ],
    [
      '<ol><li><pre>npm i</pre><p>Install it.</p></li><li>Next</li></ol>',
      [
        { type: 'numbered_list', depth: 0, text: 'Install it.' },
        { type: 'code', depth: 1, text: 'npm i' },
        { type: 'numbered_list', depth: 0, text: 'Next' },
      ],
    ],
  ])('%s keeps the item', (html, blocks) => {
    expect(shape(html)).toEqual(blocks);
  });

  // The text test beside an image walks without recursion, and a style sheet
  // is no text.
  test('a deep chain beside an image reads without overflowing', () => {
    expect(() =>
      blocksFromHtml(
        document,
        `<ul><li><p><img src="https://a.test/i.png">${'<span>'.repeat(5000)}x</p></li></ul>`,
      ),
    ).not.toThrow();
  });

  test('a style sheet beside an image is not text', () => {
    expect(
      shape(
        '<ul><li>a<p><style>p { color: red }</style><img src="https://a.test/i.png"></p></li></ul>',
      ),
    ).toEqual([
      { type: 'bulleted_list', depth: 0, text: 'a' },
      { type: 'image', depth: 1, text: '' },
    ]);
  });

  // A list past the bound is still read, as text, where it was.
  test('a list nested in lists past the bound keeps its text', () => {
    const blocks = shape(`${'<ul>'.repeat(300)}<li>x</li>${'</ul>'.repeat(300)}`);
    expect(blocks.map((block) => block.text)).toEqual(['x']);
  });

  // The checkbox is found wherever it sits in the item's own text, and the
  // first one wins.
  test.each([
    ['<ul><li><p><input type="checkbox" checked> Done</p></li></ul>', 'Done', true],
    ['<ul><li><label><input type="checkbox"> Task</label></li></ul>', 'Task', false],
    [
      '<ul><li><span><input type="checkbox"></span><input type="checkbox" checked> x</li></ul>',
      'x',
      false,
    ],
  ])('%s is a to-do', (html, text, checked) => {
    expect(shape(html)).toEqual([{ type: 'todo', depth: 0, text, checked }]);
  });

  // Leading whitespace is layout, not a space in front of the text.
  // (At the very start of a paste it is the paste's edge, which keeps it --
  // Firefox copies a selected leading space that way; see audit 36.)
  test('whitespace before the first inline node is not kept', () => {
    expect(shape('<p>a</p><div> <b>x</b></div>')).toEqual([
      { type: 'paragraph', depth: 0, text: 'a' },
      { type: 'paragraph', depth: 0, text: 'x' },
    ]);
  });

  // Nor is whitespace after the last text, before an empty element or a break.
  test.each(['<div><b>x</b>\n <span></span>\n<p>y</p></div>', '<div><b>x</b> <br></div>'])(
    '%j has no trailing space',
    (html) => {
      expect(shape(html)[0]?.text).toBe('x');
    },
  );

  // Pretty-printing between inline elements is one space, as a browser shows
  // it, whether or not a wrapper is distributed over it. A paragraph keeps its
  // own whitespace: that is how this editor writes a line break between runs.
  test.each([
    '<div>\n <strong>Note:</strong>\n <a href="https://a.test/">read this</a>\n <p>para</p>\n</div>',
    '<em><div>\n <strong>Note:</strong>\n <a href="https://a.test/">read this</a>\n <p>para</p>\n</div></em>',
  ])('%j reads one space between the elements', (html) => {
    expect(shape(html)[0]?.text).toBe('Note: read this');
  });

  // A skipped link that holds a block breaks the line like the block; one
  // that is only an inline image does not.
  test.each([
    [
      '<ul><li>a<a href="https://l.test/"><p><img src="https://i.test/x.png"></p></a>b</li></ul>',
      'a\nb',
    ],
    ['<ul><li>a <a href="https://l.test/"><img src="https://i.test/x.png"></a> b</li></ul>', 'a b'],
  ])('%s reads its text as %j', (html, text) => {
    expect(shape(html)[0]?.text).toBe(text);
  });

  // Inside a paragraph a wrapper is distributed over, the paragraph's own
  // whitespace stands, as it does when the formatting is written by hand.
  test('a distributed paragraph keeps its whitespace as a hand-written one does', () => {
    const wrapped = '<b><p><i>a</i>\n <i>b</i></p><p>c</p></b>';
    const byHand = '<p><b><i>a</i>\n <i>b</i></b></p><p><b>c</b></p>';
    expect(shape(wrapped)).toEqual(shape(byHand));
  });
});

describe('audit 32', () => {
  const shape = (html: string) =>
    blocksFromHtml(document, html).map((block) => ({
      type: block.type,
      depth: block.depth,
      text: richToPlainText(block.content),
      ...(block.src === undefined ? {} : { src: block.src }),
      ...(block.checked === undefined ? {} : { checked: block.checked }),
    }));

  // An image in the item's own text is handed on as a child image, as a bare
  // one is: read as text it was dropped.
  test.each([
    [
      'a loose task item opening with an image',
      '<ul><li class="task-list-item"><p><input type="checkbox" disabled> <a href="https://a.test/shot.png"><img src="https://a.test/shot.png"></a></p></li></ul>',
      [
        { type: 'todo', depth: 0, text: '', checked: false },
        { type: 'image', depth: 1, text: '', src: 'https://a.test/shot.png' },
      ],
    ],
    [
      'an image in a promoted paragraph',
      '<ol><li><p><a href="https://a.test/a.png"><img src="https://a.test/a.png"></a></p><p>Click the <a href="https://a.test/g.png"><img src="https://a.test/g.png"></a> icon.</p></li></ol>',
      [
        { type: 'numbered_list', depth: 0, text: 'Click the icon.' },
        // In document order: the screenshot's paragraph comes first, and the
        // icon is in the text after it (the text is read ahead; the picture
        // in it is not).
        { type: 'image', depth: 1, text: '', src: 'https://a.test/a.png' },
        { type: 'image', depth: 1, text: '', src: 'https://a.test/g.png' },
      ],
    ],
    [
      "Confluence's image wrapper",
      '<ul><li>Step one<br><span class="confluence-embedded-file-wrapper"><img src="https://a.test/c.png"></span></li></ul>',
      [
        { type: 'bulleted_list', depth: 0, text: 'Step one' },
        { type: 'image', depth: 1, text: '', src: 'https://a.test/c.png' },
      ],
    ],
    [
      "an image in the item's own paragraph",
      '<ul><li><p>Click <img src="https://a.test/i.png"> here</p></li></ul>',
      [
        { type: 'bulleted_list', depth: 0, text: 'Click here' },
        { type: 'image', depth: 1, text: '', src: 'https://a.test/i.png' },
      ],
    ],
  ])('%s keeps the image', (_name, html, blocks) => {
    expect(shape(html)).toEqual(blocks);
  });

  // A link's whitespace is the sentence's: one holding a space beside its
  // image is read as text, the space kept and the image handed on.
  test('an image link holding a space keeps the space', () => {
    expect(
      shape('<ul><li>a<a href="https://l.test/"><img src="https://i.test/x.png"> </a>b</li></ul>'),
    ).toEqual([
      { type: 'bulleted_list', depth: 0, text: 'a b' },
      { type: 'image', depth: 1, text: '', src: 'https://i.test/x.png' },
    ]);
  });

  // A pretty-printed image paragraph is still only an image.
  test('an image paragraph with layout around the image is the image', () => {
    expect(
      shape('<ul><li>a<p>\n  <img src="https://a.test/i.png">\n</p><p>t</p></li></ul>'),
    ).toEqual([
      { type: 'bulleted_list', depth: 0, text: 'a' },
      { type: 'image', depth: 1, text: '', src: 'https://a.test/i.png' },
      { type: 'paragraph', depth: 1, text: 't' },
    ]);
  });

  // The paragraph promoted is the first that holds text.
  test.each([
    [
      '<ol><li><pre>npm i</pre><p><br></p><p>Install it.</p></li></ol>',
      [
        { type: 'numbered_list', depth: 0, text: 'Install it.' },
        { type: 'code', depth: 1, text: 'npm i' },
        { type: 'paragraph', depth: 1, text: '' },
      ],
    ],
    [
      '<ol><li><pre>npm i</pre><p>&nbsp;</p><p>Install it.</p></li></ol>',
      [
        { type: 'numbered_list', depth: 0, text: 'Install it.' },
        { type: 'code', depth: 1, text: 'npm i' },
        { type: 'paragraph', depth: 1, text: '\u00a0' },
      ],
    ],
    [
      '<ol><li><pre>x</pre><p>first</p><p>second</p></li></ol>',
      [
        { type: 'numbered_list', depth: 0, text: 'first' },
        { type: 'code', depth: 1, text: 'x' },
        { type: 'paragraph', depth: 1, text: 'second' },
      ],
    ],
  ])('%s promotes the first paragraph with text', (html, blocks) => {
    expect(shape(html)).toEqual(blocks);
  });

  // Outside a paragraph, whitespace is a space only between two pieces of
  // text: not before the first, not beside a line break, and once however many
  // empty elements or comments sit in it.
  test.each([
    [
      '<div>\n  <i class="fa fa-check"></i>\n  <span>Unlimited projects</span>\n</div>',
      'Unlimited projects',
    ],
    [
      '<div>\n  <strong>Acme Ltd</strong><br>\n  <span>1 Main St</span><br>\n  <span>Springfield</span>\n</div>',
      'Acme Ltd\n1 Main St\nSpringfield',
    ],
    ['<div><span>x</span>\n  <br>\n  <span>y</span></div>', 'x\ny'],
    ['<div><b>x</b> <br> <i>y</i></div>', 'x\ny'],
    [
      '<div><a href="https://a.test/1">One</a>\n  <!-- c -->\n  <a href="https://a.test/2">Two</a></div>',
      'One Two',
    ],
    ['<div><b>One</b> <span></span> <b>Two</b></div>', 'One Two'],
    // An element holding only a space is a space too.
    ['<div><span>w0</span>\n  <span> </span><span>w3</span></div>', 'w0 w3'],
    // And text that ends in a space already has one.
    ['<div><a href="https://a.test/">w0</a> w1 <span></span>\n<!--c--><b>w5</b></div>', 'w0 w1 w5'],
  ])('%j reads %j', (html, text) => {
    expect(shape(html)[0]?.text).toBe(text);
  });
});

describe('audit 33', () => {
  const shape = (html: string) =>
    blocksFromHtml(document, html).map((block) => ({
      type: block.type,
      depth: block.depth,
      text: richToPlainText(block.content),
    }));
  const text = (html: string) => shape(html).map((block) => block.text);

  // Outside a paragraph, whitespace collapses as a browser collapses it
  // (white-space: normal), across element edges -- and a no-break space is
  // never whitespace that collapses. Each expectation is what Chromium shows.
  test.each([
    ['<div><span>a </span><span>&nbsp;</span><b>b</b></div>', 'a \u00a0b'],
    ['<div>a<br>&nbsp;&nbsp;<b>b</b></div>', 'a\n\u00a0\u00a0b'],
    ['<div><a href="https://a.test/">x</a> <span> - desc</span></div>', 'x - desc'],
    ['<div><u>a<br></u> <u>b</u></div>', 'a\nb'],
    ['<div><b>a</b><span> </span> <b>b</b></div>', 'a b'],
    ['<div><b>a </b><br><span> </span><b>b</b></div>', 'a\nb'],
    ['<div>foo\nbar <b>x</b></div>', 'foo bar x'],
    // ... and after a break, which therefore stands.
    ['<div>w<br>&nbsp;</div>', 'w\n\u00a0'],
    // A no-break space is content even where it comes first.
    ['<div>&nbsp;<b> </b>w</div>', '\u00a0 w'],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)[0]).toBe(expected);
  });

  // A wrapper distributed over the same content reads it the same way.
  test('the buffer and a distributed wrapper agree', () => {
    expect(text('<div><p>A</p><i>x</i>\n<br>\n<i>y</i></div>')).toEqual(['A', 'x\ny']);
    expect(text('<div><b><p>A</p><i>x</i>\n<br>\n<i>y</i></b></div>')).toEqual(['A', 'x\ny']);
  });

  // A link's pretty-printing is layout; only a space on its line is the
  // sentence's.
  test('a pretty-printed image link is the image', () => {
    expect(
      shape(
        '<ul><li>\n  <a href="https://a.test/p1">\n    <img src="https://a.test/1.png">\n  </a>\n</li></ul>',
      ),
    ).toEqual([{ type: 'image', depth: 1, text: '' }]);
  });

  test('an image in a list inside a link is kept', () => {
    expect(
      shape(
        '<ul><li><a href="https://l.test/">\n  <ul><li><img src="https://i.test/1.png"></li></ul>\n</a></li></ul>',
      ).some((block) => block.type === 'image'),
    ).toBe(true);
  });

  // A link holding a block is no part of a sentence, so its whitespace is
  // layout: holding only an image besides, it is the image's block.
  test('an image link holding a block keeps its image', () => {
    expect(
      shape(
        '<ul><li>t<a href="https://l.test/"> <div><ul><li><img src="https://i.test/3.png"></li></ul></div></a></li></ul>',
      ),
    ).toEqual([
      { type: 'bulleted_list', depth: 0, text: 't' },
      { type: 'image', depth: 2, text: '' },
    ]);
  });

  // An empty block after text adds no line: the break before it waits for text.
  // (A cell's source whitespace collapses as a block's does, so the space
  // that ends its line goes too: R3-FMT-2.)
  test('an empty block after text adds no line break', () => {
    const [table] = blocksFromHtml(
      document,
      '<table><tr><td>t <div><span></span></div></td></tr></table>',
    );
    expect(richToPlainText(table?.rows?.[0]?.[0] ?? [])).toBe('t');
  });

  // A list the item does not hold directly is never visited as a block, so it
  // is read as the item's text rather than dropped -- and a checkbox in it
  // does not make the item a to-do.
  test.each([
    ['<ul><li>a<b><ul><li>b</li></ul></b></li></ul>', 'a\nb', 'bulleted_list'],
    [
      '<ul><li><p>a<details><summary>s</summary><ul><li>F0</li></ul></details></p></li></ul>',
      'a\ns\nF0',
      'bulleted_list',
    ],
    [
      '<ul><li>a<b><ul><li><input type="checkbox">x</li></ul></b></li></ul>',
      'a\nx',
      'bulleted_list',
    ],
  ])('%s keeps its text', (html, text, type) => {
    expect(shape(html)[0]).toEqual({ type, depth: 0, text });
  });

  // A table nested in a cell is read as the cell's text, not dropped with it:
  // a cell holds text, and that is the text it holds.
  test('a table nested in a cell keeps its text', () => {
    const [table] = blocksFromHtml(
      document,
      '<table><tr><td>a<table><tr><td>V0</td><td>W0</td></tr></table></td><td>b</td></tr></table>',
    );
    expect(table?.rows?.map((row) => row.map((cell) => richToPlainText(cell)))).toEqual([
      ['a\nV0\nW0', 'b'],
    ]);
  });

  // A no-break space after a block is text, so the line still breaks before it.
  test('a no-break space after a block in a cell is on its own line', () => {
    const [table] = blocksFromHtml(document, '<table><tr><td><div>x</div>&nbsp;</td></tr></table>');
    expect(richToPlainText(table?.rows?.[0]?.[0] ?? [])).toBe('x\n\u00a0');
  });

  // An image in something never read is not handed on either.
  test('an image in a <noscript> is not handed on', () => {
    expect(
      shape('<ul><li>a<noscript><img src="https://a.test/n.png"></noscript>b</li></ul>'),
    ).toEqual([{ type: 'bulleted_list', depth: 0, text: 'ab' }]);
  });
});

describe('audit 34', () => {
  const text = (html: string) =>
    blocksFromHtml(document, html).map((block) => richToPlainText(block.content));

  // Whitespace an inline style preserves is kept: Google Docs, VS Code, and
  // Chromium's own copy of a pre-wrap region all mark their text that way.
  test.each([
    [
      '<b id="docs-internal-guid-1"><span style="white-space:pre;white-space:pre-wrap;">Hello  big\tx </span></b>',
      'Hello  big\tx ',
    ],
    [
      '<div style="white-space: pre;"><div><span>    return  a;</span></div></div>',
      '    return  a;',
    ],
    ['<span style="font-size: 16px; white-space: pre-wrap;">\there  </span>', '\there  '],
    ['<span style="white-space: break-spaces">a  b</span>', 'a  b'],
    // The last declaration wins, as in CSS.
    ['<span style="white-space: pre-wrap; white-space: normal">a  b</span>', 'a b'],
    // pre-line keeps its line breaks and collapses the rest.
    ['<span style="white-space: pre-line">a  b\nc</span>', 'a b\nc'],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual([expected]);
  });

  // The edges of an inline paste are the middle of a line: a space there in
  // an element stays. Layout text around the fragment does not.
  test.each([
    ['<span>Hello </span>', 'Hello '],
    ['<span> world</span>', ' world'],
    ['\n<!--StartFragment--><b>x</b><!--EndFragment-->\n', 'x'],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual([expected]);
  });

  // A pretty-printed image link in a sentence is handed on as an image, and
  // the sentence keeps the space its layout made there.
  test('an image link between two words keeps them apart', () => {
    expect(
      blocksFromHtml(
        document,
        '<ul><li>V0 W0<a href="https://l.test/">\n<img src="https://i.test/x.png">\n</a>D1</li></ul>',
      ).map((block) => [block.type, richToPlainText(block.content)]),
    ).toEqual([
      ['bulleted_list', 'V0 W0 D1'],
      ['image', ''],
    ]);
  });

  // A line break alone on the line after a block is a blank line.
  test.each([
    ['<table><tr><td><div>a</div><div><br></div></td></tr></table>'],
    ['<table><tr><td><p>a</p><br></td></tr></table>'],
  ])('%s keeps its blank line', (html) => {
    const [table] = blocksFromHtml(document, html);
    expect(richToPlainText(table?.rows?.[0]?.[0] ?? [])).toBe('a\n');
  });

  test.each([
    ['<ul><li><p>a</p><br></li></ul>', 'a\n'],
    ['<blockquote><div>a</div><br></blockquote>', 'a\n'],
    ['<h2>a<div><br></div></h2>', 'a\n'],
  ])('%s keeps its blank line', (html, expected) => {
    expect(text(html)[0]).toBe(expected);
  });

  // An empty block still adds none.
  test('an empty block after text in a cell adds no line', () => {
    const [table] = blocksFromHtml(document, '<table><tr><td>a<div></div></td></tr></table>');
    expect(richToPlainText(table?.rows?.[0]?.[0] ?? [])).toBe('a');
  });
});

describe('audit 35', () => {
  const text = (html: string) =>
    blocksFromHtml(document, html).map((block) => richToPlainText(block.content));
  const cell = (html: string) =>
    richToPlainText(blocksFromHtml(document, html)[0]?.rows?.[0]?.[0] ?? []);

  // Every blank line after a block stands, not only the last.
  test.each([
    ['<table><tr><td><div>a</div><div><br></div><div><br></div></td></tr></table>', 'a\n\n'],
    ['<table><tr><td><p>a</p><br><br></td></tr></table>', 'a\n\n'],
    ['<table><tr><td><p>a</p><br><br><br></td></tr></table>', 'a\n\n\n'],
    ['<table><tr><td>a<div>b</div><br><br></td></tr></table>', 'a\nb\n\n'],
  ])('%s keeps every blank line', (html, expected) => {
    expect(cell(html)).toBe(expected);
  });

  test('two blank lines after a block in a quote', () => {
    expect(text('<blockquote><p>a</p><br><br></blockquote>')).toEqual(['a\n\n']);
  });

  // Firefox's own copy keeps the selected space as a bare text node at the
  // edge; only layout text carrying a line break is dropped there, and a
  // no-break space never is.
  test.each([
    ['<b>Hello</b> ', 'Hello '],
    [' <b>world</b>', ' world'],
    ['<html><body>\n<!--StartFragment--><b>Hello</b> <!--EndFragment-->\n</body></html>', 'Hello '],
    ['<b>Hello</b>&nbsp;', 'Hello\u00a0'],
    ['&nbsp;', '\u00a0'],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual([expected]);
  });

  // The marks are escaped where the text already holds them.
  test('pasted noncharacters stay as they are', () => {
    expect(text('<span>x\uFDD2y\uFDD0\uFDD0z \uFDD3\uFDD4</span>')).toEqual([
      'x\uFDD2y\uFDD0\uFDD0z \uFDD3\uFDD4',
    ]);
    expect(text('<span style="white-space: pre">a\uFDD1  b</span>')).toEqual(['a\uFDD1  b']);
  });

  // The space a skipped image link leaves stands only between two words.
  test.each([
    [
      '<ul><li>word<a href="https://l.test/">\n<img src="https://i.test/x.png">\n</a> next</li></ul>',
      'word next',
    ],
    [
      '<ul><li>word<a href="https://l.test/">\n<img src="https://i.test/x.png">\n</a></li></ul>',
      'word',
    ],
  ])('%s reads %j', (html, expected) => {
    expect(text(html)[0]).toBe(expected);
  });

  // A preserved line break that ends a block's text is its end, not a line.
  test.each([
    ['<div style="white-space:pre-wrap">Some text\n</div><p>end</p>', ['Some text', 'end']],
    ['<span style="white-space:pre-wrap">a\n</span><p>end</p>', ['a', 'end']],
    ['<span style="white-space:pre-line">a\n</span><p>end</p>', ['a', 'end']],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual(expected);
  });

  // At the end of a paste it lands mid-line, so the break stays.
  test('a preserved line break at the end of a paste stays', () => {
    expect(text('<span style="white-space:pre-wrap">a\n</span>')).toEqual(['a\n']);
  });

  // `inherit`, `unset`, `revert` and an invalid value do not reset to normal;
  // an invalid one is ignored, as CSS ignores it.
  test.each([
    [
      '<div style="white-space:pre-wrap"><span style="white-space:revert">w0  w1\tw2</span></div>',
      'w0  w1\tw2',
    ],
    [
      '<div style="white-space:pre-wrap"><span style="white-space:inherit">w0  w1</span></div>',
      'w0  w1',
    ],
    [
      '<div style="white-space:pre-wrap"><span style="white-space:bogus">w0  w1</span></div>',
      'w0  w1',
    ],
    ['<span style="white-space:pre-wrap; white-space:bogus">w0  w1</span>', 'w0  w1'],
    [
      '<div style="white-space:pre-wrap"><span style="white-space:initial">w0  w1</span></div>',
      'w0 w1',
    ],
    // A later `inherit` overrides an earlier value, inheriting normal here.
    ['<span style="white-space:pre-wrap; white-space:inherit">w0  w1</span>', 'w0 w1'],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)[0]).toBe(expected);
  });

  // An ancestor's pre-line reaches the run as pre-line, not as pre-wrap.
  test('an outer pre-line governs the run as pre-line', () => {
    expect(text('<div style="white-space:pre-line"><div><span>a   b</span></div></div>')).toEqual([
      'a b',
    ]);
  });

  // After a block, a run's start is a line's start, not the paste's edge.
  test('inline text after a block loses its leading space', () => {
    expect(text('<p>x</p>\n<span> w</span>')).toEqual(['x', 'w']);
  });

  // A collapsible space before a pre-line break goes, as before a `<br>`; one
  // before a pre or pre-wrap break stays. Both as Chromium reads them.
  test.each([
    ['<div>a <span style="white-space:pre">\nb</span></div>', 'a \nb'],
    ['<div>a <span style="white-space:pre-wrap">\nb</span></div>', 'a \nb'],
    ['<div>a <span style="white-space:pre-line">\nb</span></div>', 'a\nb'],
    ['<span style="white-space:pre-line">a \nb</span>', 'a\nb'],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual([expected]);
  });
});

describe('audit 36', () => {
  const text = (html: string) =>
    blocksFromHtml(document, html).map((block) => richToPlainText(block.content));

  // A `<br>` after a preserved line break is a line of its own, so the break
  // stands: every browser copies a pre-wrap block ending in a blank line so.
  test.each([
    ['<div style="white-space:pre-wrap">first\n<br></div><div>second</div>', ['first\n', 'second']],
    ['<div>W<span style="white-space:pre-line">\n</span><br></div><div>x</div>', ['W\n', 'x']],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual(expected);
  });

  // One blank line between two blocks is a block of its own, as two are --
  // and a blank line that is all there is, or at either end, is nothing.
  test.each([
    ['<div>a</div><br><div>b</div>', ['a', '', 'b']],
    ['<div>a</div><div><br></div><div>b</div>', ['a', '', 'b']],
    ['<div>a</div><br><br><div>b</div>', ['a', '\n', 'b']],
    ['<div><br></div>', []],
    ['<div><br></div><div>a</div>', ['a']],
    ['<div>a</div><div><br></div>', ['a']],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual(expected);
  });

  // Firefox puts a selected edge space inside the first or last block: the
  // paste's edges are its first and last text, wherever they sit.
  test.each([
    ['<div>one</div><div>two three </div>', ['one', 'two three ']],
    ['<div> <b>b</b></div><div>c</div>', [' b', 'c']],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual(expected);
  });

  // The keywords, each checked against Chromium.
  test.each([
    ['<div style="white-space:pre-wrap"><span style="white-space:nowrap">a  b</span></div>', 'a b'],
    ['<span style="white-space:pre-wrap; white-space:revert">a  b</span>', 'a b'],
    ['<span style="white-space:pre-wrap; white-space:unset">a  b</span>', 'a b'],
    ['<span style="white-space:pre-wrap; white-space:revert-layer">a  b</span>', 'a b'],
    ['<span style="white-space:pre-wrap !important; white-space:normal">a  b</span>', 'a  b'],
    ['<span style="white-space:pre-wrap; white-space:constructor">a  b</span>', 'a  b'],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)[0]).toBe(expected);
  });

  // An escaped mark is text: it ends a run of spaces, and a break does not
  // take it for one.
  test.each([
    ['<div>\uFDD0 x</div>', '\uFDD0 x'],
    ['<div>a \uFDD0<br>b</div>', 'a \uFDD0\nb'],
    ['<div><span style="white-space:pre-wrap">a\n\uFDD0</span></div>', 'a\n\uFDD0'],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)[0]).toBe(expected);
  });
});

describe('audit 37', () => {
  const text = (html: string) =>
    blocksFromHtml(document, html).map((block) => richToPlainText(block.content));

  // A `<br>` after a wrapper that holds blocks ends the wrapper's open line:
  // no blank paragraph, as Chromium draws it.
  test.each([
    [
      '<p>Intro</p><a href="https://x.test/"><div>Title</div>Read more</a><br><p>Next</p>',
      ['Intro', 'Title', 'Read more', 'Next'],
    ],
    [
      '<p>Intro</p><span>Lead <div>Block</div>tail</span><br><p>Next</p>',
      ['Intro', 'Lead', 'Block', 'tail', 'Next'],
    ],
    ['<div>lead<span><br><div>x</div></span></div>', ['lead', 'x']],
    // A block's start is a new line, so a `<br>` there is still a blank one.
    ['<p>a</p>text<div><br><div>x</div></div>', ['a', 'text', '', 'x']],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual(expected);
  });

  // A block before the paste's first text, or after its last, starts or ends
  // a line there: the text is no edge. (An empty `<p></p>` first is the block
  // Firefox writes, emptied, for one a selection left, and is not read at
  // all: R5-FMT-3.)
  test.each([
    ['<p></p><hr> text more<p>q</p>', ['', 'text more', 'q']],
    ['<p><br></p><hr> text more<p>q</p>', ['', '', 'text more', 'q']],
    ['<hr> text', ['', 'text']],
    ['text <hr>', ['text', '']],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual(expected);
  });

  // Spaces between a preserved break and a `<br>` do not hide the blank line.
  test.each([
    ['<div><span style="white-space:pre-wrap">a\n</span> <br></div><div>b</div>', ['a\n', 'b']],
    ['<div style="white-space:pre-line">a\n <br></div><div>b</div>', ['a\n', 'b']],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual(expected);
  });

  // The mark exists only while whitespace is collapsed: a noncharacter in a
  // paragraph's text before its filler `<br>` gains nothing.
  test.each([
    ['<p>x\uFDD2<br></p>', 'x\uFDD2'],
    ['<ul><li>x\uFDD4<br></li></ul>', 'x\uFDD4'],
    ['<div>a\uFDD5b</div>', 'a\uFDD5b'],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)[0]).toBe(expected);
  });

  // The edge walker passes over layout and what is never read.
  test.each([
    ['<p>y</p><div>x </div>\n', ['y', 'x ']],
    ['<p>y</p><div>x </div><style>a{}</style>', ['y', 'x ']],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual(expected);
  });

  // A `<br>` inside an inline element makes a blank line as a bare one does.
  test('a wrapped blank line between blocks', () => {
    expect(text('<p>a</p><b><br></b><p>b</p>')).toEqual(['a', '', 'b']);
  });

  // `!important` with a space, and an important `inherit`.
  test.each([
    ['<span style="white-space:pre-wrap ! important; white-space:normal">a  b</span>', 'a  b'],
    [
      '<div style="white-space:pre"><span style="white-space:pre-wrap; white-space:inherit !important; white-space:normal">a  b</span></div>',
      'a  b',
    ],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)[0]).toBe(expected);
  });
});

describe('audit 38', () => {
  const text = (html: string) =>
    blocksFromHtml(document, html).map((block) =>
      block.type === 'image' ? '[img]' : richToPlainText(block.content),
    );

  // A line that already ended in a break is not left open: the `<br>` after
  // it is a blank line.
  test.each([
    [
      '<p>Intro</p><a href="https://x.test/"><div>Title</div>Read more<br></a><br><p>Next</p>',
      ['Intro', 'Title', 'Read more', '', 'Next'],
    ],
    [
      '<p>Intro</p><a href="https://x.test/"><div>Title</div><span style="white-space:pre-wrap">Read more\n</span></a><br><p>Next</p>',
      ['Intro', 'Title', 'Read more', '', 'Next'],
    ],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual(expected);
  });

  // Text after the break opens the line again, so a `<br>` then ends it.
  test('text after a break leaves its line open', () => {
    expect(text('<p>x</p><a href="https://h.test/"><div>T</div>a<br>b</a><br><p>y</p>')).toEqual([
      'x',
      'T',
      'a\nb',
      'y',
    ]);
  });

  // An element the browser lays out as a block ends its line, whatever this
  // reader calls it; only an inline one leaves the line open.
  test.each([
    [
      '<p>x</p><center><div>Logo</div>View online</center><br><p>Hi</p>',
      ['x', 'Logo', 'View online', '', 'Hi'],
    ],
    ['<p>x</p>Lead text<aside><br><p>Body</p></aside>', ['x', 'Lead text', '', 'Body']],
    ['<p>a</p>text<figcaption><br><div>x</div></figcaption>', ['a', 'text', '', 'x']],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual(expected);
  });

  // An inline image sits on a line; the `<br>` after it ends that line.
  test.each([
    [
      '<div>there</div><div><img src="https://a.test/a.png"><br></div><div>Thanks</div>',
      ['there', '[img]', 'Thanks'],
    ],
    ['<p><img src="https://a.test/a.png"><br>Caption text</p>', ['[img]', 'Caption text']],
    [
      '<p>a</p>text<a href="https://h.test/"><br><img src="https://x.test/i.png"></a><p>x</p>',
      ['a', 'text', '[img]', 'x'],
    ],
    [
      '<p>a</p>text<p><br><img src="https://x.test/i.png"></p><p>x</p>',
      ['a', 'text', '', '[img]', 'x'],
    ],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual(expected);
  });

  // Each way the line is closed.
  test.each([
    ['<p>a</p><span><div>b</div></span><br><p>x</p>', ['a', 'b', '', 'x']],
    [
      '<p>a</p><a href="https://h.test/"><div>T</div>more</a><br><span><br><div>x</div></span>',
      ['a', 'T', 'more', '', 'x'],
    ],
    [
      '<p>a</p><span><div>b</div>tail</span><div><br><div>x</div></div>',
      ['a', 'b', 'tail', '', 'x'],
    ],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual(expected);
  });

  // List items a wrapper holds are items still, carrying the wrapper's link;
  // loose content in a list is read rather than dropped.
  test('items wrapped in links are kept', () => {
    const blocks = blocksFromHtml(
      document,
      '<p>Menu</p><ul><a href="https://a.test/1"><li>Home page</li></a><a href="https://a.test/2"><li>About us</li></a></ul><p>After</p>',
    );
    expect(blocks.map((block) => [block.type, richToPlainText(block.content)])).toEqual([
      ['paragraph', 'Menu'],
      ['bulleted_list', 'Home page'],
      ['bulleted_list', 'About us'],
      ['paragraph', 'After'],
    ]);
    expect(blocks[1]?.content[0]?.link).toBe('https://a.test/1');
  });

  // The wrappers take the list bound: past it, what is left is one block of
  // text rather than an item per level.
  test('a deep chain of formatting around items stops at the list bound', () => {
    expect(
      blocksFromHtml(document, `<ul>${'<b><li>x</li>'.repeat(3000)}${'</b>'.repeat(3000)}</ul>`),
    ).toHaveLength(257);
  });

  test.each([
    ['<ul><div><li>a</li><li>b</li></div></ul>', ['a', 'b']],
    ['<ul><li>a</li>loose text<li>b</li></ul>', ['a', 'loose text', 'b']],
    ['<ol><li>a</li><p>para</p></ol>', ['a', 'para']],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual(expected);
  });
});

describe('audit 39', () => {
  const text = (html: string) =>
    blocksFromHtml(document, html).map((block) =>
      block.type === 'image' ? '[img]' : richToPlainText(block.content),
    );
  const shape = (html: string) =>
    blocksFromHtml(document, html).map((block) => [
      block.type,
      block.depth,
      richToPlainText(block.content),
    ]);

  // Two breaks after an open line: the first ends it, the second is a blank
  // line -- each counted once.
  test.each([
    [
      '<p>words</p><img src="https://example.test/a.png"><br><br><p>Next</p>',
      ['words', '[img]', '', 'Next'],
    ],
    [
      '<p>s</p><a href="https://h.test/"><div>T</div>more</a><br><br><p>x</p>',
      ['s', 'T', 'more', '', 'x'],
    ],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual(expected);
  });

  // An item, a nested list or a wrapper of items starts a line of its own, so
  // a break after it does not close a line the loose text before it opened.
  test.each([
    ['<ul>Lead<li>One item</li><br><li>Two item</li></ul>', ['Lead', 'One item', '', 'Two item']],
    ['<ul>x<ul><br>y</ul></ul>', ['x', '\ny']],
    ['<ul><img src="https://example.test/a.png"><li>a</li><br>z</ul>', ['[img]', 'a', '\nz']],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual(expected);
  });

  // The wrapper branch for images asks the browser's layout too, and a figure
  // is a block.
  test.each([
    ['<p>s</p><center><img src="https://example.test/a.png"></center><br>b', ['s', '[img]', '\nb']],
    [
      '<p>s</p>a<figure><img src="https://example.test/a.png"></figure><br>b',
      ['s', 'a', '[img]', '\nb'],
    ],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual(expected);
  });

  // Wrapped items keep the list's type, its depth and whether we wrote it.
  test.each([
    ['<ol><div><li>a</li></div></ol>', [['numbered_list', 0, 'a']]],
    ['<ul><div><li>a</li></div></ul>', [['bulleted_list', 0, 'a']]],
    ['<ul data-neditor-list><span><li>[x] a</li></span></ul>', [['bulleted_list', 0, '[x] a']]],
  ])('%j reads %j', (html, expected) => {
    expect(shape(html)).toEqual(expected);
  });

  // An element a browser lays out as a block breaks the line in text as well:
  // HTML email centres its lines with <center>.
  test.each([
    [
      '<p>words</p><center>Title line</center><center>Sub line</center><p>Next</p>',
      ['words', 'Title line\nSub line', 'Next'],
    ],
    ['<address>1 Main St</address>Phone 555', ['1 Main St\nPhone 555']],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual(expected);
  });

  test('centred lines in a cell', () => {
    const [table] = blocksFromHtml(
      document,
      '<table><tr><td><center>Line A</center><center>Line B</center></td></tr></table>',
    );
    expect(richToPlainText(table?.rows?.[0]?.[0] ?? [])).toBe('Line A\nLine B');
  });
});

describe('audit 40', () => {
  const text = (html: string) =>
    blocksFromHtml(document, html).map((block) =>
      block.type === 'image' ? '[img]' : richToPlainText(block.content),
    );

  // Firefox's copies of pretty-printed pages: whitespace beside a block is no
  // line of its own (each checked against Firefox's own text/plain).
  test.each([
    ['<p>words</p>Thanks,<br>\n<center>Sub</center><p>Next</p>', ['words', 'Thanks,\nSub', 'Next']],
    [
      '<p>words</p><span>Name</span>\n<fieldset>\n</fieldset>\n<span>Email</span><p>Next</p>',
      ['words', 'Name\nEmail', 'Next'],
    ],
    [
      '<p>words</p>Dear Ann,<br>\n<center>\n  Thank you\n</center>\nRegards<p>Next</p>',
      ['words', 'Dear Ann,\nThank you\nRegards', 'Next'],
    ],
    ['<p>s</p>x<center> </center>y<p>e</p>', ['s', 'x\ny', 'e']],
  ])('%j reads %j', (html, expected) => {
    expect(text(html)).toEqual(expected);
  });

  // Whitespace between two display-block elements is layout.
  test('layout between centred lines in a cell', () => {
    const [table] = blocksFromHtml(
      document,
      '<table><tr><td><center>a</center>\n<center>b</center></td></tr></table>',
    );
    expect(richToPlainText(table?.rows?.[0]?.[0] ?? [])).toBe('a\nb');
  });

  // A wrapper holding an image keeps its link and marks on its text.
  test('text in a link or bold beside an image keeps the link and the bold', () => {
    const blocks = blocksFromHtml(
      document,
      '<p>s</p><a href="https://h.test/docs">the docs <img src="https://x.test/i.png"></a> for <b>more <img src="https://x.test/j.png"> info</b>.<p>e</p>',
    );
    expect(
      blocks.map((block) => (block.type === 'image' ? '[img]' : richToPlainText(block.content))),
    ).toEqual(['s', 'the docs', '[img]', 'for more', '[img]', 'info.', 'e']);
    expect(blocks[1]?.content[0]?.link).toBe('https://h.test/docs');
    expect(blocks[3]?.content.find((run) => run.text.includes('more'))?.marks).toEqual(['bold']);
    expect(blocks[5]?.content.find((run) => run.text.includes('info'))?.marks).toEqual(['bold']);
  });

  // An image inside such a wrapper sits on a line, which a `<br>` ends.
  test('a break after a linked image is no blank line', () => {
    expect(
      text('<p>s</p><a href="https://h.test/"><img src="https://x.test/i.png"></a><br><p>x</p>'),
    ).toEqual(['s', '[img]', 'x']);
  });

  // An item ending in an image ends its line with it.
  test('a break after an item ending in an image is a blank line', () => {
    expect(text('<ul><li><img src="https://x.test/i.png"></li><br><li>b</li></ul>')).toEqual([
      '[img]',
      '',
      'b',
    ]);
  });
});

describe('audit 41', () => {
  const I = '<img src="https://x.test/i.png">';
  const text = (html: string) =>
    blocksFromHtml(document, html).map((block) =>
      block.type === 'image' ? '[img]' : richToPlainText(block.content),
    );

  // A display-block element inside a wrapper holding an image keeps its
  // lines: an HTML-email signature, as Chromium and Firefox copy it.
  test.each([
    [
      `<p>s</p><font face="Arial">Best regards<center>${I}<br>ACME Corp</center>123 Main St</font><p>e</p>`,
      ['Corp123', 'regardsACME'],
    ],
    [`<p>s</p><b>x<center>y${I}</center>z</b><p>e</p>`, ['xy', 'yz']],
    [
      `<p>s</p><a href="https://h.test/">Title<aside>Sub ${I}</aside>more</a><p>e</p>`,
      ['TitleSub', 'Submore'],
    ],
  ])('%s joins no words', (html, joins) => {
    const all = text(html).join('|');
    for (const join of joins) {
      expect(all).not.toContain(join);
    }
  });

  // A white-space style above a wrapper holding an image still governs its text.
  test.each([
    [
      `<p>s</p><div style="white-space:pre-wrap">AAA <b>line1\nline2 ${I} ok</b> ZZZ</div>`,
      'line1\nline2',
    ],
    [`<p>s</p><span style="white-space:pre">a   b${I}</span><p>e</p>`, 'a   b'],
    // pre-line keeps its line breaks and collapses its spaces.
    [`<p>s</p><span style="white-space:pre-line">a   b\nc${I}</span><p>e</p>`, 'a b\nc'],
  ])('%s keeps %j', (html, kept) => {
    expect(text(html).join('|')).toContain(kept);
  });

  // Firefox keeps a selected edge space as text: inside such a wrapper too.
  test('edge spaces in a wrapper holding an image', () => {
    expect(text(`<a href="https://h.test/"> and ${I} more </a>`)).toEqual([
      ' and',
      '[img]',
      'more ',
    ]);
  });

  // The nearest wrapper decides, as it does for text read directly.
  test('an inner wrapper turning a mark off wins', () => {
    const blocks = blocksFromHtml(
      document,
      `<p>s</p><b>Note: <span style="font-weight:normal">see ${I} here</span> done</b><p>e</p>`,
    );
    const runs = blocks.flatMap((block) => block.content);
    expect(runs.find((run) => run.text.includes('see'))?.marks ?? []).toEqual([]);
    expect(runs.find((run) => run.text.includes('Note'))?.marks).toEqual(['bold']);
  });

  // An element that both adds and removes a mark -- Google Docs' own
  // `<b style="font-weight:normal">` -- leaves it off, as the walk does.
  test('a wrapper that adds and removes bold leaves it off', () => {
    const blocks = blocksFromHtml(
      document,
      `<p>s</p><b style="font-weight:normal">plain ${I} text</b><p>e</p>`,
    );
    const run = blocks.flatMap((block) => block.content).find((one) => one.text.includes('plain'));
    expect(run?.marks ?? []).toEqual([]);
  });

  test('formatting nested inside the wrapper is inherited', () => {
    const blocks = blocksFromHtml(
      document,
      `<p>s</p><a href="https://h.test/"><b>more ${I}</b></a><p>e</p>`,
    );
    const run = blocks.flatMap((block) => block.content).find((one) => one.text.includes('more'));
    expect(run?.marks).toEqual(['bold']);
    expect(run?.link).toBe('https://h.test/');
  });

  // An image one level further in -- an emoji's span inside a link -- is
  // reached and split out too.
  test('an image nested in a wrapper inside the wrapper is kept', () => {
    expect(
      text(`<p>s</p><a href="https://h.test/">see <span>the ${I}</span> docs</a><p>e</p>`),
    ).toEqual(['s', 'see the', '[img]', 'docs', 'e']);
  });

  test('an image in something never read is not split out', () => {
    expect(text(`<p>s</p><b>x<object>${I}</object>y</b><p>e</p>`)).toEqual(['s', 'xy', 'e']);
  });

  // Space-only runs are looked past while whitespace is collapsed, and a
  // paragraph that does not preserve its whitespace collapses it too: the
  // space after the `<br>` starts a line, so a browser draws neither it nor a
  // line for it. (It used to read 'a\n \nb', when every paragraph read its
  // whitespace as it stood; one that says `pre-wrap` still does.)
  test('a paragraph draws no space between a break and a block', () => {
    expect(text('<p>a<br> <center>b</center></p>')).toEqual(['a\nb']);
    expect(text('<p style="white-space:pre-wrap">a<br> <center>b</center></p>')).toEqual([
      'a\n \nb',
    ]);
  });
});

describe('audit 43', () => {
  const text = (html: string) =>
    blocksFromHtml(document, html).map((block) =>
      block.type === 'image'
        ? `[img ${block.src?.split('/').pop()}]`
        : `${block.type}:${richToPlainText(block.content)}`,
    );

  // A heading, a quote or a table cell holding an image hands it on, as a list
  // item does; read as text it was dropped. GitHub READMEs, quoted
  // screenshots and HTML-email layout tables, as Chromium copies them.
  test.each([
    [
      '<h1 align="center"><a href="https://github.com/o/r"><img src="https://github.com/o/r/raw/main/logo.png" alt="Logo"></a><br>Project</h1>',
      ['heading1:Project', '[img logo.png]'],
    ],
    [
      '<blockquote><p><a href="https://github.com/o/r"><img src="https://user-images.test/shot.png"></a></p></blockquote>',
      ['[img shot.png]'],
    ],
    [
      '<blockquote><p><img src="https://x.test/n.png"> Note: careful</p></blockquote>',
      // The space stood after the image, which goes to a block of its own.
      ['quote:Note: careful', '[img n.png]'],
    ],
    [
      '<table><tr><td><a href="https://x.test/"><img src="https://x.test/banner.jpg"></a></td></tr><tr><td>text</td></tr></table>',
      ['table:', '[img banner.jpg]'],
    ],
  ])('%s keeps its image', (html, expected) => {
    expect(text(html)).toEqual(expected);
  });

  test('a handed-on image from a quote sits a level in', () => {
    const blocks = blocksFromHtml(
      document,
      '<blockquote><p><img src="https://x.test/n.png"> Note: careful</p></blockquote>',
    );
    expect(blocks.map((block) => [block.type, block.depth])).toEqual([
      ['quote', 0],
      ['image', 1],
    ]);
  });

  // An image the reader cannot use is no block, so it splits no sentence:
  // Outlook's cid: images, Word's file: ones.
  test.each([
    ['<p>Click <img src="cid:x"> to open</p>', ['paragraph:Click to open']],
    ['<div>see <b>bold <img src="cid:y"> text</b> here</div>', ['paragraph:see bold text here']],
    [
      '<p class="MsoNormal">See the logo <span><img src="file:///C:/x/clip_image002.png"></span> in the header.</p>',
      ['paragraph:See the logo in the header.'],
    ],
  ])('%s is one paragraph', (html, expected) => {
    expect(text(html)).toEqual(expected);
  });
});

describe('audit 44', () => {
  const show = (html: string) =>
    blocksFromHtml(document, html).map((block) =>
      block.type === 'image'
        ? `[img ${block.src?.split('/').pop()}${isRichEmpty(block.content) ? '' : ` "${richToPlainText(block.content)}"`}]@${block.depth}`
        : block.type === 'table'
          ? `table${JSON.stringify(block.rows?.map((row) => row.map((cell) => richToPlainText(cell))))}@${block.depth}`
          : `${block.type}:${richToPlainText(block.content)}@${block.depth}`,
    );

  // A figure is an image only when, its own caption aside, it holds one
  // usable image and no text; any other is read block by block -- a WordPress
  // table block, a gallery, a bookmark card.
  test('a WordPress table block keeps its table and caption', () => {
    expect(
      show(
        '<figure class="wp-block-table"><table><tr><th>Logo</th><th>Name</th></tr><tr><td><img src="https://x.test/a.png"></td><td>Product A</td></tr><tr><td><img src="https://x.test/b.png"></td><td>Product B</td></tr></table><figcaption>Comparison</figcaption></figure>',
      ),
    ).toEqual([
      'table[["Logo","Name"],["","Product A"],["","Product B"]]@0',
      '[img a.png]@0',
      '[img b.png]@0',
      'paragraph:Comparison@0',
    ]);
  });

  test('a gallery keeps every image with its own caption', () => {
    expect(
      show(
        '<figure class="wp-block-gallery"><figure class="wp-block-image"><img src="https://x.test/1.jpg"><figcaption>First</figcaption></figure><figure class="wp-block-image"><img src="https://x.test/2.jpg"></figure><figure class="wp-block-image"><img src="https://x.test/3.jpg"><figcaption>Third</figcaption></figure><figcaption>Our trip</figcaption></figure>',
      ),
    ).toEqual([
      '[img 1.jpg "First"]@0',
      '[img 2.jpg]@0',
      '[img 3.jpg "Third"]@0',
      'paragraph:Our trip@0',
    ]);
  });

  test('a bookmark card keeps its text', () => {
    const blocks = show(
      '<figure class="kg-bookmark-card"><a class="kg-bookmark-container" href="https://x.test/"><div class="kg-bookmark-content"><div class="kg-bookmark-title">Title</div><div class="kg-bookmark-description">Desc</div><div class="kg-bookmark-metadata"><img class="kg-bookmark-icon" src="https://x.test/fav.png"><span>Author</span></div></div></a></figure>',
    ).join('|');
    for (const word of ['Title', 'Desc', 'Author', 'fav.png']) {
      expect(blocks).toContain(word);
    }
  });

  test('a figure holding text and an image in a list item keeps the text', () => {
    expect(
      show('<ul><li><figure>text<img src="https://x.test/i.png"></figure></li></ul>').join('|'),
    ).toContain('text');
  });

  // Two images and no caption -- a gallery row -- is two images, not the first.
  test('a figure of two images keeps both', () => {
    expect(
      show('<figure><img src="https://x.test/a.png"><img src="https://x.test/b.png"></figure>'),
    ).toEqual(['[img a.png]@0', '[img b.png]@0']);
  });

  // An image figure's caption is its own, not one nested further in.
  test("an image figure's caption is its direct one", () => {
    expect(
      show(
        '<figure><a href="https://x.test/"><img src="https://x.test/i.png"><figcaption></figcaption></a><figcaption>Real</figcaption></figure>',
      ),
    ).toEqual(['[img i.png "Real"]@0']);
  });

  // An image figure -- ours, linked, in a picture -- is still the image.
  test.each([
    [
      '<figure><img src="https://x.test/i.png" alt="a"><figcaption>Cap</figcaption></figure>',
      ['[img i.png "Cap"]@0'],
    ],
    [
      '<figure><a href="https://x.test/"><img src="https://x.test/i.png"></a></figure>',
      ['[img i.png]@0'],
    ],
    [
      '<figure><picture><source srcset="https://x.test/i.webp"><img src="https://x.test/i.png"></picture></figure>',
      ['[img i.png]@0'],
    ],
  ])('%s is an image', (html, expected) => {
    expect(show(html)).toEqual(expected);
  });

  // Images in a quote's nested list are the list's own, handed on once.
  test.each([
    [
      '<blockquote><p>Steps:</p><ul><li>Open it<br><img src="https://x.test/i.png"></li></ul></blockquote>',
      ['quote:Steps:@0', 'bulleted_list:Open it@1', '[img i.png]@2'],
    ],
    [
      '<blockquote><ul><li><img src="https://x.test/i.png"></li></ul></blockquote>',
      ['[img i.png]@1'],
    ],
    [
      '<p>a</p><blockquote><p><img src="https://x.test/i.png"></p></blockquote>',
      ['paragraph:a@0', '[img i.png]@0'],
    ],
  ])('%s reads %j', (html, expected) => {
    expect(show(html)).toEqual(expected);
  });

  // A heading or a table holding nothing but an image is that image.
  test.each([
    [
      '<h1 align="center"><a href="https://x.test/"><img src="https://x.test/logo.png" alt="Project"></a></h1>',
      ['[img logo.png]@0'],
    ],
    [
      '<table><tr><td><a href="https://x.test/"><img src="https://x.test/banner.jpg"></a></td></tr></table>',
      ['[img banner.jpg]@0'],
    ],
  ])('%s is only the image', (html, expected) => {
    expect(show(html)).toEqual(expected);
  });
});

describe('audit 45', () => {
  const show = (html: string) =>
    blocksFromHtml(document, html).map((block) =>
      block.type === 'image'
        ? `[img ${block.src?.split('/').pop()}${isRichEmpty(block.content) ? '' : ` "${richToPlainText(block.content)}"`}]`
        : `${block.type}:${richToPlainText(block.content)}`,
    );

  // Only the figure's own caption is set aside: a WordPress gallery of one
  // image is that image, with its caption.
  test('a gallery of one image keeps its caption', () => {
    expect(
      show(
        '<figure class="wp-block-gallery has-nested-images"><figure class="wp-block-image"><img src="https://x.test/a.png"><figcaption>Only image caption</figcaption></figure></figure>',
      ),
    ).toEqual(['[img a.png "Only image caption"]']);
  });

  // An image in a caption -- a Wikipedia thumbnail's flag icon, a table's
  // caption -- is handed on after it, as one in a heading or a cell is.
  test('an image in an image figure caption is kept', () => {
    expect(
      show(
        '<figure><a href="https://x.test/"><img src="https://upload.wikimedia.org/map.png"></a><figcaption>Map of <span class="flagicon"><img src="https://upload.wikimedia.org/flag.svg"></span>&nbsp;France</figcaption></figure>',
      ),
    ).toEqual(['[img map.png "Map of \u00a0France"]', '[img flag.svg]']);
  });

  test('an image in a table caption is kept', () => {
    expect(
      show(
        '<table><caption>Prices <img src="https://x.test/c.png"></caption><tr><td>x</td></tr></table>',
      ),
    ).toEqual(['paragraph:Prices ', '[img c.png]', 'table:']);
  });
});

describe('audit 46', () => {
  const show = (html: string) =>
    blocksFromHtml(document, html).map(
      (block) =>
        `${block.type === 'image' ? `[img ${block.src?.split('/').pop()}]` : block.type}@${block.depth}:${richToPlainText(block.content)}`,
    );

  // A caption may come first. The figure's picture is the image outside its
  // caption -- the one `isImageFigure` counted -- and the caption's own image
  // is handed on after it, once.
  test('a caption before the image does not lend the figure its image', () => {
    expect(
      show(
        '<figure><figcaption>Flag of <img src="https://x.test/flag.png" alt="FR"> France</figcaption><img src="https://x.test/map.png" alt="Map"></figure>',
      ),
    ).toEqual(['[img map.png]@0:Flag of  France', '[img flag.png]@0:']);
    expect(
      blocksFromHtml(
        document,
        '<figure><figcaption>Cap <img src="https://x.test/flag.png" alt="FR"></figcaption><img src="https://x.test/map.png" alt="Map"></figure>',
      )[0]?.alt,
    ).toBe('Map');
  });

  test('a caption before the image, as a list item block', () => {
    expect(
      show(
        '<ul><li>Item<figure><figcaption>Cap <img src="https://x.test/flag.png"></figcaption><img src="https://x.test/map.png"></figure></li></ul>',
      ),
    ).toEqual(['bulleted_list@0:Item', '[img map.png]@1:Cap ', '[img flag.png]@1:']);
  });

  // A caption's images are handed on at the depth of what they sat in.
  test('caption images keep the depth of their figure or table', () => {
    expect(
      show(
        '<ul><li>Item<figure><img src="https://x.test/m.png"><figcaption>Cap <img src="https://x.test/f.png"></figcaption></figure></li></ul>',
      ),
    ).toEqual(['bulleted_list@0:Item', '[img m.png]@1:Cap ', '[img f.png]@1:']);
    expect(
      show(
        '<ul><li>Item<table><caption>Cap <img src="https://x.test/c.png"></caption><tr><td>x</td></tr></table></li></ul>',
      ),
    ).toEqual(['bulleted_list@0:Item', 'paragraph@1:Cap ', '[img c.png]@1:', 'table@1:']);
  });

  // A list item asks the same question: a figure whose only image is in its
  // caption is no image block of the item's, so the bullet keeps the text.
  test('a figure with only a caption image is the item text', () => {
    expect(
      show(
        '<ul><li><figure><figcaption>Cap <img src="https://x.test/flag.png"></figcaption></figure></li></ul>',
      ),
    ).toEqual(['bulleted_list@0:Cap', '[img flag.png]@1:']);
  });

  // Only the first caption is the figure's; a second one is content, so the
  // figure is read block by block rather than losing it.
  test('a second caption is not dropped', () => {
    const out = show(
      '<figure><img src="https://x.test/a.png"><figcaption>One</figcaption><figcaption>Two <img src="https://x.test/b.png"></figcaption></figure>',
    );

    expect(out.join('|')).toContain('One');
    expect(out.join('|')).toContain('Two');
    expect(out).toContain('[img a.png]@0:');
    expect(out).toContain('[img b.png]@0:');
  });
});

describe('audit 48', () => {
  const images = (html: string) =>
    blocksFromHtml(document, html)
      .filter((block) => block.type === 'image')
      .map((block) => `${block.src} "${block.alt}"`);

  // Medium writes every article image as a <picture> whose <img> has no src:
  // the browser shows a <source> candidate. Copied whole (Chromium; Firefox
  // writes the same tree), the picture was dropped with no trace.
  const medium =
    '<figure class="ni nj nk nl nm nn nf ng paragraph-image"><div role="button" tabindex="0" class="no np fj nq bh nr"><div class="nf ng nt"><picture><source srcset="https://miro.medium.com/v2/resize:fit:640/format:webp/1*6EB1Xue1wM_QP0IIzXphQA.png 640w, https://miro.medium.com/v2/resize:fit:720/format:webp/1*6EB1Xue1wM_QP0IIzXphQA.png 720w, https://miro.medium.com/v2/resize:fit:750/format:webp/1*6EB1Xue1wM_QP0IIzXphQA.png 750w, https://miro.medium.com/v2/resize:fit:786/format:webp/1*6EB1Xue1wM_QP0IIzXphQA.png 786w, https://miro.medium.com/v2/resize:fit:828/format:webp/1*6EB1Xue1wM_QP0IIzXphQA.png 828w, https://miro.medium.com/v2/resize:fit:1100/format:webp/1*6EB1Xue1wM_QP0IIzXphQA.png 1100w, https://miro.medium.com/v2/resize:fit:1400/format:webp/1*6EB1Xue1wM_QP0IIzXphQA.png 1400w" sizes="(min-resolution: 4dppx) and (max-width: 700px) 50vw, (-webkit-min-device-pixel-ratio: 4) and (max-width: 700px) 50vw, (min-resolution: 3dppx) and (max-width: 700px) 67vw, (-webkit-min-device-pixel-ratio: 3) and (max-width: 700px) 65vw, (min-resolution: 2.5dppx) and (max-width: 700px) 80vw, (-webkit-min-device-pixel-ratio: 2.5) and (max-width: 700px) 80vw, (min-resolution: 2dppx) and (max-width: 700px) 100vw, (-webkit-min-device-pixel-ratio: 2) and (max-width: 700px) 100vw, 700px" type="image/webp"><source data-testid="og" srcset="https://miro.medium.com/v2/resize:fit:640/1*6EB1Xue1wM_QP0IIzXphQA.png 640w, https://miro.medium.com/v2/resize:fit:720/1*6EB1Xue1wM_QP0IIzXphQA.png 720w, https://miro.medium.com/v2/resize:fit:750/1*6EB1Xue1wM_QP0IIzXphQA.png 750w, https://miro.medium.com/v2/resize:fit:786/1*6EB1Xue1wM_QP0IIzXphQA.png 786w, https://miro.medium.com/v2/resize:fit:828/1*6EB1Xue1wM_QP0IIzXphQA.png 828w, https://miro.medium.com/v2/resize:fit:1100/1*6EB1Xue1wM_QP0IIzXphQA.png 1100w, https://miro.medium.com/v2/resize:fit:1400/1*6EB1Xue1wM_QP0IIzXphQA.png 1400w" sizes="(min-resolution: 4dppx) and (max-width: 700px) 50vw, (-webkit-min-device-pixel-ratio: 4) and (max-width: 700px) 50vw, (min-resolution: 3dppx) and (max-width: 700px) 67vw, (-webkit-min-device-pixel-ratio: 3) and (max-width: 700px) 65vw, (min-resolution: 2.5dppx) and (max-width: 700px) 80vw, (-webkit-min-device-pixel-ratio: 2.5) and (max-width: 700px) 80vw, (min-resolution: 2dppx) and (max-width: 700px) 100vw, (-webkit-min-device-pixel-ratio: 2) and (max-width: 700px) 100vw, 700px"><img alt="" class="bh lo ns c" width="700" height="435" loading="lazy" role="presentation"></picture></div></div></figure>';

  test('a Medium picture with no src is read from its sources', () => {
    const blocks = blocksFromHtml(document, `<p>a</p>${medium}<p>b</p>`);

    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'image', 'paragraph']);
    // The untyped source is the fallback every browser can show; its largest
    // candidate is the best copy of the picture.
    expect(blocks[1]?.src).toBe(
      'https://miro.medium.com/v2/resize:fit:1400/1*6EB1Xue1wM_QP0IIzXphQA.png',
    );
  });

  test("an image's own srcset stands in for a missing src", () => {
    expect(
      images('<p>a <img srcset="https://x.test/b.png 1x, https://x.test/b2.png 2x" alt="x"> b</p>'),
    ).toEqual(['https://x.test/b2.png "x"']);
    expect(images('<img srcset="https://x.test/c.png">')).toEqual(['https://x.test/c.png ""']);
  });

  test('a src the reader can use still wins', () => {
    expect(images('<img src="https://x.test/a.png" srcset="https://x.test/b.png 2x">')).toEqual([
      'https://x.test/a.png ""',
    ]);
  });

  // Every candidate passes the same gate a src does.
  test('unsafe candidates are passed over, and none leaves no image', () => {
    expect(images('<img srcset="javascript:alert(1) 4x, https://x.test/ok.png 1x">')).toEqual([
      'https://x.test/ok.png ""',
    ]);
    expect(images('<p>a <img srcset="javascript:alert(1) 2x, cid:x 1x"> b</p>')).toEqual([]);
  });

  // A data: URL holds a comma; only a comma after whitespace, or at the
  // URL's end, separates candidates.
  test('a data URL in a srcset keeps its comma', () => {
    expect(
      images('<img srcset="data:image/png;base64,iVBORw0KGgo= 1x,https://x.test/d.png 0.5x">'),
    ).toEqual(['data:image/png;base64,iVBORw0KGgo= ""']);
    expect(images('<img srcset="https://x.test/e.png,, https://x.test/f.png 0.5x">')).toEqual([
      'https://x.test/e.png ""',
    ]);
  });
});

describe('audit 49', () => {
  const images = (html: string) =>
    blocksFromHtml(document, html)
      .filter((block) => block.type === 'image')
      .map((block) => block.src);
  const read = (html: string) =>
    blocksFromHtml(document, html).map(
      (block) => `${block.type}:${richToPlainText(block.content)}`,
    );

  // A browser resolves `src` when it copies, but writes `srcset` as the page
  // did, and the reader has no base URL to resolve one against.
  test('a relative srcset candidate is no image source', () => {
    expect(
      images(
        '<p>Before.</p><img srcset="/images/bayon-800.jpg 800w, /images/bayon-1600.jpg 1600w" alt="Bayon face"><p>Between.</p><img srcset="bayon-800.jpg 1x, bayon-1600.jpg 2x" alt="Bayon two"><p>After.</p>',
      ),
    ).toEqual([]);
    expect(images('<img srcset="/a.png 4x, https://x.test/b.png 1x">')).toEqual([
      'https://x.test/b.png',
    ]);
    expect(images('<img srcset="//cdn.x.test/c.png 2x">')).toEqual(['https://cdn.x.test/c.png']);
  });

  test('a srcset splits on every kind of HTML whitespace', () => {
    expect(images('<img srcset="https://x.test/a.png\n1x,\thttps://x.test/b.png\t2x">')).toEqual([
      'https://x.test/b.png',
    ]);
    expect(images('<img srcset="https://x.test/a.png\f3x,\rhttps://x.test/b.png\r2x">')).toEqual([
      'https://x.test/a.png',
    ]);
  });

  test("the image's own srcset comes before its picture's sources", () => {
    expect(
      images(
        '<picture><source srcset="https://x.test/s.png"><img srcset="https://x.test/o.png"></picture>',
      ),
    ).toEqual(['https://x.test/o.png']);
  });

  test('an unusable src falls back to the srcset', () => {
    expect(images('<img src="javascript:alert(1)" srcset="https://x.test/f.png">')).toEqual([
      'https://x.test/f.png',
    ]);
  });

  // Chromium writes a flex or grid container's `display` inline when it
  // copies, and leaves out the whitespace between its items, which is not
  // rendered. Each item is a line of its own, in both browsers.
  test('a Shiki code block laid out as a grid keeps its lines (nextjs.org, Chromium)', () => {
    expect(
      read(
        '<pre><code style="box-sizing: border-box; display: grid; white-space: pre"><span data-line=""><span># Use the new automated upgrade CLI</span></span><span data-line=""><span>npx</span><span> @next/codemod@canary</span><span> upgrade</span><span> latest</span></span><span data-line=""> </span><span data-line=""><span># ...or upgrade manually</span></span><span data-line=""><span>npm</span><span> install</span><span> next@latest</span><span> react@rc</span><span> react-dom@rc</span></span></code></pre>',
      ),
    ).toEqual([
      'code:# Use the new automated upgrade CLI\nnpx @next/codemod@canary upgrade latest\n \n# ...or upgrade manually\nnpm install next@latest react@rc react-dom@rc',
    ]);
  });

  test('the same block copied by Firefox, with its newlines, reads the same', () => {
    expect(
      read(
        '<pre><code style="display: grid"><span data-line=""><span>a</span></span>\n<span data-line=""> </span>\n<span data-line=""><span>b</span></span></code></pre>',
      ),
    ).toEqual(['code:a\n \nb']);
  });

  test('spaces between the items of a code grid are not drawn', () => {
    expect(
      read('<pre><code style="display:grid"><span>a</span> <span>b</span>\t</code></pre>'),
    ).toEqual(['code:a\nb']);
  });

  test('a code block: a block inside starts a line, and loose text in a grid does not', () => {
    expect(read('<pre>x<div>a</div><div>b</div>y</pre>')).toEqual(['code:x\na\nb\ny']);
    expect(read('<pre><code style="display:grid">a<!-- -->b</code></pre>')).toEqual(['code:ab']);
  });

  // A `<br>` is a newline where text follows it on its line; the last one
  // before a line ends is that line's filler, as everywhere else.
  test('a <br> in a code block', () => {
    expect(read('<pre>a<br>b</pre>')).toEqual(['code:a\nb']);
    expect(read('<pre><code>a<br><br>b</code></pre>')).toEqual(['code:a\n\nb']);
    expect(read('<pre>a<br></pre>')).toEqual(['code:a']);
    expect(read('<pre>a<br><br></pre>')).toEqual(['code:a\n']);
    expect(read('<pre>a\n<br></pre>')).toEqual(['code:a\n']);
    expect(read('<pre><div>a<br></div><div>b</div></pre>')).toEqual(['code:a\nb']);
    expect(read('<pre><div>a<br><br></div><div>b</div></pre>')).toEqual(['code:a\n\nb']);
    expect(read('<pre><div>a</div><div><br></div><div>b</div></pre>')).toEqual(['code:a\n\nb']);
  });

  // A newline after a block in a <pre> is a line of its own: Chromium draws
  // three lines for each of these.
  test('a newline beside a block in a code block is a blank line', () => {
    expect(read('<pre><div>a</div>\nb</pre>')).toEqual(['code:a\n\nb']);
    expect(read('<pre><div>a</div>\n<div>b</div></pre>')).toEqual(['code:a\n\nb']);
  });

  test('a code grid: loose text after an item, and what follows the grid, start lines', () => {
    expect(
      read(
        '<pre><code style="display:grid"><span>echo one</span><span>echo two</span>tail</code>after</pre>',
      ),
    ).toEqual(['code:echo one\necho two\ntail\nafter']);
  });

  test("a flex row's links do not run together", () => {
    const blocks = blocksFromHtml(
      document,
      '<div style="display: flex"><a href="https://x.test/h">Back to Home</a><a href="https://x.test/t">Browse Tags</a></div>',
    );

    expect(blocks.map((block) => richToPlainText(block.content))).toEqual([
      'Back to Home\nBrowse Tags',
    ]);
    expect(blocks[0]?.content.map((run) => run.link)).toEqual([
      'https://x.test/h',
      undefined,
      'https://x.test/t',
    ]);
    expect(
      read(
        '<div style="display:flex"><a href="#">Back to Home</a> <a href="#">Browse Tags</a></div>',
      ),
    ).toEqual(['paragraph:Back to Home\nBrowse Tags']);
  });

  // Each element item is a block; loose text stays on the line beside it.
  test('loose text beside the items of a flex container', () => {
    expect(read('<div style="display:flex">text <b>bold</b> more</div>')).toEqual([
      'paragraph:text\nbold\nmore',
    ]);
    expect(read('<div style="display:grid">a<span> </span>b</div>')).toEqual(['paragraph:a\nb']);
    // Loose text is one item however many nodes it spans.
    expect(read('<div style="display:flex">a<!-- -->b</div>')).toEqual(['paragraph:ab']);
  });

  test('an inline-flex container inside a sentence', () => {
    expect(
      read('<p>x <span style="display:inline-flex"><b>a</b> <i>b</i></span> y</p>')[0]
        ?.split('\n')
        .map((line) => line.trim()),
    ).toEqual(['paragraph:x', 'a', 'b', 'y']);
  });

  test('an inline flex container sits in its line; a flex or grid one is a block', () => {
    expect(read('<p>x<span style="display:inline-flex">a<b>b</b>c</span></p>')).toEqual([
      'paragraph:xa\nb\nc',
    ]);
    expect(read('<p>a<span style="display:inline-flex">b</span>c</p>')).toEqual(['paragraph:abc']);
    expect(read('<p>a<span style="display:flex">b</span>c</p>')).toEqual(['paragraph:a\nb\nc']);
    expect(read('<p>a<span style="display:grid"><span>b</span>c</span>d</p>')).toEqual([
      'paragraph:a\nb\nc\nd',
    ]);
    expect(read('<p>a<span style="display: inline grid">b</span>c</p>')).toEqual(['paragraph:abc']);
  });

  test('flex containers side by side, and an item read elsewhere', () => {
    expect(
      read('<p><span style="display:flex">a</span> <span style="display:flex">b</span></p>'),
    ).toEqual(['paragraph:a\nb']);
    expect(
      read(
        '<ul><li style="display:flex">a<a href="https://h.test/"><img src="https://x.test/i.png"></a>b</li></ul>',
      ),
    ).toEqual(['bulleted_list:a\nb', 'image:']);
  });

  // Not drawn even where a style preserves whitespace.
  test('preserved whitespace between flex items is still not drawn', () => {
    expect(read('<div style="display:flex; white-space:pre"><a>a</a> <a>b</a></div>')).toEqual([
      'paragraph:a\nb',
    ]);
  });

  // The declaration CSS would apply, not the first one written.
  test('only a display that lays out items counts', () => {
    expect(read('<div style="display:block"><a>a</a> <a>b</a></div>')).toEqual(['paragraph:a b']);
    expect(read('<div style="display:flex; display: bogus">c<span>d</span></div>')).toEqual([
      'paragraph:c\nd',
    ]);
    expect(
      read('<div style="display:flex !important; display:block">c<span>d</span></div>'),
    ).toEqual(['paragraph:c\nd']);
    expect(read('<div style="display:grid; display:inline">c<span>d</span></div>')).toEqual([
      'paragraph:cd',
    ]);
    expect(read('<div style="display: inline flex">c<span>d</span></div>')).toEqual([
      'paragraph:c\nd',
    ]);
    expect(read('<div style="-webkit-display: flex">c<span>d</span></div>')).toEqual([
      'paragraph:cd',
    ]);
  });
});

describe('audit 50', () => {
  const read = (html: string) =>
    blocksFromHtml(document, html).map(
      (block) => `${block.type}:${richToPlainText(block.content)}`,
    );

  // Stripe wraps a linked API parameter in a <div> Chromium copies as
  // `display: inline`: drawn on one line, so not a line of its own.
  test('an inline-displayed block in a code block stays on its line (Stripe)', () => {
    expect(
      read(
        '<pre><code>s.<span style="display:inline-block"><div style="display:inline">create</div></span>({ a })</code></pre>',
      ),
    ).toEqual(['code:s.create({ a })']);
    expect(read('<pre>s.<div style="display:inline-block">create</div>()</pre>')).toEqual([
      'code:s.create()',
    ]);
    // A flex item is a line whatever its own display says.
    expect(
      read(
        '<pre><code style="display:grid"><div style="display:inline">a</div><div style="display:inline">b</div></code></pre>',
      ),
    ).toEqual(['code:a\nb']);
  });

  // Tailwind's code blocks: a flex <pre>, and a `display: block` span per line.
  test('a span displayed as a block is a line (tailwindcss.com, Chromium)', () => {
    expect(
      read(
        '<pre tabindex="0" style="display: flex"><code><span style="display: block"><span>npm</span><span> create</span><span> vite@latest</span><span> my-project</span></span><span style="display: block"><span>cd</span><span> my-project</span></span></code></pre>',
      ),
    ).toEqual(['code:npm create vite@latest my-project\ncd my-project']);
  });

  // Mintlify writes each paragraph as a `display: block` span.
  test('spans displayed as blocks do not run together (Mintlify)', () => {
    expect(
      read(
        '<span style="display: block">Every page has a file in your <button type="button"><span>repository</span></button>.</span><span style="display: block">When you connect it, you can sync.</span>',
      ),
    ).toEqual([
      'paragraph:Every page has a file in your repository.\nWhen you connect it, you can sync.',
    ]);
    expect(read('<p>a<span style="display: list-item">b</span>c</p>')).toEqual([
      'paragraph:a\nb\nc',
    ]);
    expect(read('<p>a<span style="display: inline-block">b</span>c</p>')).toEqual([
      'paragraph:abc',
    ]);
  });

  // A link around a flex container hands its href to each item, not to one
  // shell around all of them, which took the items out of their container.
  test('a link around a flex container keeps its items apart (nextjs.org)', () => {
    const blocks = blocksFromHtml(
      document,
      '<div style="display: flex"><a href="https://twitter.com/delba_oliveira" style="display: flex"><img alt="Delba" src="https://x.test/d.jpg"><div style="display: flex; flex-direction: column"><span>Delba de Oliveira</span><span>@delba_oliveira</span></div></a></div>',
    );
    const text = blocks.find((block) => block.type === 'paragraph');

    expect(richToPlainText(text?.content ?? [])).toBe('Delba de Oliveira\n@delba_oliveira');
    expect(
      text?.content.every(
        (run) => run.text === '\n' || run.link === 'https://twitter.com/delba_oliveira',
      ),
    ).toBe(true);
    expect(
      read(
        '<a href="https://x.test/"><div style="display:flex"><span>Alpha</span> <span>Beta</span></div></a>',
      ),
    ).toEqual(['paragraph:Alpha\nBeta']);
    expect(
      read(
        '<a href="https://x.test/"><div style="display:flex; white-space:pre"><span>Alpha</span> <span>Beta</span></div></a>',
      ),
    ).toEqual(['paragraph:Alpha\nBeta']);
  });

  // A <br> in a flex container ends a line; it is not an item of its own.
  test('a <br> directly in a flex container is one line break', () => {
    expect(read('<div style="display:flex">123 Main St<br>Springfield</div>')).toEqual([
      'paragraph:123 Main St\nSpringfield',
    ]);
  });

  // The newline that ends a <pre>'s last line draws no line of its own.
  test("a code block's final newline is no blank line", () => {
    expect(read('<pre><code>img {\n  width: 320px;\n}\n</code></pre>')).toEqual([
      'code:img {\n  width: 320px;\n}',
    ]);
    expect(read('<pre><div>a</div>\n</pre>')).toEqual(['code:a\n']);
    expect(read('<pre>a<br>\n</pre>')).toEqual(['code:a\n']);
    expect(read('<pre>a\n\n</pre>')).toEqual(['code:a\n']);
  });

  test('inline-grid, inheriting and invalid display values', () => {
    expect(read('<p>a<span style="display:inline-grid"><i>b</i></span>c</p>')).toEqual([
      'paragraph:a\nb\nc',
    ]);
    expect(read('<p>a<span style="display:inline-grid">b</span>c</p>')).toEqual(['paragraph:abc']);
    expect(read('<div style="display:flex; display: inherit">c<span>d</span></div>')).toEqual([
      'paragraph:cd',
    ]);
    expect(read('<div style="display: flex bogus">c<span>d</span></div>')).toEqual([
      'paragraph:cd',
    ]);
  });
});

describe('audit 51', () => {
  const read = (html: string) =>
    blocksFromHtml(document, html).map(
      (block) => `${block.type}:${richToPlainText(block.content)}`,
    );

  // KaTeX sets a superscript in a zero-height `display: block` span inside
  // an inline-table, inside an inline-block: drawn within the line, so the
  // sentence is not broken (Chromium's copy, its hidden MathML left out).
  // A lone block in a box touches the text beside it, as MathJax 2 draws a
  // block per glyph; only blocks stacked together are apart.
  test('a block inside an inline-block or inline-table box stays in its line (KaTeX)', () => {
    const katex =
      '<p>The area is <span class="katex"><span class="katex-html" aria-hidden="true"><span class="base" style="position: relative; display: inline-block"><span class="strut" style="display: inline-block; height: 0.8141em"></span><span class="mord"><span class="mord">x</span><span class="msupsub"><span class="vlist-t" style="display: inline-table"><span class="vlist-r" style="display: table-row"><span class="vlist" style="display: table-cell; position: relative; vertical-align: bottom; height: 0.8141em"><span class="" style="display: block; height: 0px; position: relative; top: -3.063em"><span class="pstrut" style="display: inline-block; height: 2.7em"></span><span class="sizing" style="display: inline-block"><span class="mord">2</span></span></span></span></span></span></span></span></span></span></span> square units.</p>';

    expect(read(katex)).toEqual(['paragraph:The area is x2 square units.']);
    expect(
      read(
        '<p>a<span style="display:inline-block"><span style="display:block">b</span></span>c</p>',
      ),
    ).toEqual(['paragraph:abc']);
    expect(
      read(
        '<p>a<span style="display:inline-table"><span style="display:block">b</span></span>c</p>',
      ),
    ).toEqual(['paragraph:abc']);
    // MathJax 2's CommonHTML output, as Chromium copies it.
    expect(
      read(
        '<p>the <span style="display: inline-block"><span style="display: block">n</span></span>th term, <span style="display: inline-block"><span style="display: block">P</span></span><span style="display: inline-block"><span style="display: block">(</span></span><span style="display: inline-block"><span style="display: block">B</span></span><span style="display: inline-block"><span style="display: block">)</span></span>.</p>',
      ),
    ).toEqual(['paragraph:the nth term, P(B).']);
    // Blocks stacked together in one box are drawn apart: a badge's two
    // lines, a fraction's parts.
    expect(
      read(
        '<p>Inline <span style="display:inline-block"><span style="display:block">stacked</span><span style="display:block">badge</span></span> after.</p>',
      ),
    ).toEqual(['paragraph:Inline stacked badge after.']);
    // Wikipedia's fractions write a hidden `/` between the stacked parts.
    expect(
      read(
        '<p>one-half: <span class="sfrac"><span>\u2060</span><span class="tion" style="display: inline-block"><span class="num" style="display: block">1</span><span class="sr-only" style="clip: rect(0px, 0px, 0px, 0px); position: absolute">/</span><span class="den" style="display: block">2</span></span><span>\u2060</span></span>.</p>',
      ),
    ).toEqual(['paragraph:one-half: \u20601/2\u2060.']);
    // `inline flow-root` is a box like `inline-block`.
    expect(
      read(
        '<p>a<span style="display:inline flow-root"><span style="display:block">b</span><span style="display:block">c</span></span>d</p>',
      ),
    ).toEqual(['paragraph:ab cd']);
    // Slack's feedback buttons: two inline-blocks, a block label in each,
    // and no space between them -- joined, as on `main`.
    expect(
      read(
        '<p><a role="button" title="Yes, thanks!" style="display: inline-block"><span style="display: block">Yes, thanks!</span></a><a role="button" title="Not really" style="display: inline-block"><span style="display: block">Not really</span></a></p>',
      ),
    ).toEqual(['paragraph:Yes, thanks!Not really']);
    // Code keeps its spaces as written: stacked in a box, the text joins.
    expect(
      read(
        '<pre>s<span style="display:inline-block"><span style="display:block">t</span></span>u</pre>',
      ),
    ).toEqual(['code:stu']);
    // A block between them starts its own lines, inside the box or not.
    expect(
      read(
        '<p>a<span style="display:inline-block"><div>x<span style="display:block">y</span>z</div></span>b</p>',
      )[0],
    ).toContain('x\ny\nz');
    // A block tag is a block whatever it declares, outside code, and what
    // it holds is read by lines -- at the top level and in a cell alike.
    expect(
      read(
        '<p>x<div style="display:inline-block"><span style="display:block">a</span><span style="display:block">b</span></div>y</p>',
      ),
    ).toEqual(['paragraph:x', 'paragraph:a\nb', 'paragraph:y']);
    expect(
      blocksFromHtml(
        document,
        '<table><tr><td>x<div style="display:inline-block"><span style="display:block">a</span><span style="display:block">b</span></div>y</td></tr></table>',
      )[0]
        ?.rows?.[0]?.[0]?.map((run) => run.text)
        .join(''),
    ).toBe('x\na\nb\ny');
    // A plain inline span is no box: a block inside it breaks the line, and
    // each of several does.
    expect(read('<p>a<span><span style="display:block">b</span></span>c</p>')).toEqual([
      'paragraph:a\nb\nc',
    ]);
    expect(
      read(
        '<p><span>x<span style="display:block">a</span>y<span style="display:block">b</span>z</span></p>',
      ),
    ).toEqual(['paragraph:x\na\ny\nb\nz']);
    // Nor is a block: one inside another is a line of its own.
    expect(
      read('<p><span style="display:block">p<span style="display:block">a</span>q</span></p>'),
    ).toEqual(['paragraph:p\na\nq']);
    // A flex item starts lines, and so does a block inside one, even in a box.
    expect(
      read(
        '<p>q<span style="display:inline-block"><span style="display:inline-flex"><span>item <span style="display:block">x</span> y</span></span></span></p>',
      ),
      // The spaces either side of the block start and end a line, where a
      // browser draws none.
    ).toEqual(['paragraph:q\nitem\nx\ny']);
  });

  test('a <br> declared a block is still one line break', () => {
    expect(
      read('<pre>alpha<br style="display: block">beta<br style="display: block">gamma</pre>'),
    ).toEqual(['code:alpha\nbeta\ngamma']);
    expect(read('<p>alpha<br style="display: block">beta</p>')).toEqual(['paragraph:alpha\nbeta']);
  });

  test('every block-level and inline-level display value', () => {
    expect(read('<p>a<span style="display:table">b</span>c</p>')).toEqual(['paragraph:a\nb\nc']);
    expect(read('<p>a<span style="display:flow-root">b</span>c</p>')).toEqual([
      'paragraph:a\nb\nc',
    ]);
    for (const display of ['inline-flex', 'inline-grid', 'inline-table', 'inline-list-item']) {
      expect(read(`<pre>s.<div style="display:${display}">create</div>()</pre>`)).toEqual([
        'code:s.create()',
      ]);
    }
  });

  test('whitespace between spans declared blocks is not a line', () => {
    expect(
      read('<p><span style="display:block">a</span> <span style="display:block">b</span></p>'),
    ).toEqual(['paragraph:a\nb']);
  });
});

describe('audit 53', () => {
  const read = (html: string) =>
    blocksFromHtml(document, html).map(
      (block) => `${block.type}:${richToPlainText(block.content)}`,
    );

  // KaTeX's fraction, as Chromium copies it (styles cut to `display`, the
  // hidden MathML left out): two parts stacked apart, an empty rule between.
  test('a KaTeX fraction: its parts apart, its empty rule no gap', () => {
    expect(
      read(
        '<p>Half is <span class="m"><span class="katex"><span class="katex-html"><span class="base" style="display: inline-block"><span class="strut" style="display: inline-block"></span><span class="mord"><span class="mopen" style="display: inline-block"></span><span class="mfrac"><span class="vlist-t" style="display: inline-table"><span class="vlist-r" style="display: table-row"><span class="vlist" style="display: table-cell"><span style="display: block"><span class="pstrut" style="display: inline-block"></span><span class="sizing" style="display: inline-block"><span class="mord"><span class="mord">2</span></span></span></span><span style="display: block"><span class="pstrut" style="display: inline-block"></span><span class="frac-line" style="display: inline-block"></span></span><span style="display: block"><span class="pstrut" style="display: inline-block"></span><span class="sizing" style="display: inline-block"><span class="mord"><span class="mord">1</span></span></span></span></span><span class="vlist-s" style="display: table-cell">\u200b</span></span><span class="vlist-r" style="display: table-row"><span class="vlist" style="display: table-cell"><span style="display: block"></span></span></span></span></span><span class="mclose" style="display: inline-block"></span></span></span></span></span></span> of it.</p>',
      ),
    ).toEqual(['paragraph:Half is 2 1​ of it.']);
  });

  // An empty block -- KaTeX's rule line, strike or radical -- draws no text,
  // so it neither takes a gap nor makes one.
  test('an empty stacked block makes no word gap', () => {
    expect(
      read(
        '<p>abcde<span style="display:inline-block"><span style="display:block"></span><span style="display:block"></span></span>fg</p>',
      ),
    ).toEqual(['paragraph:abcdefg']);
    // \underline{AB}: the rule first, then the text.
    expect(
      read(
        '<p>x<span style="display:inline-block"><span style="display:block"></span><span style="display:block">AB</span></span>y</p>',
      ),
    ).toEqual(['paragraph:xABy']);
    // \sqrt{2}x: the text first, then the radical's rule.
    expect(
      read(
        '<p><span style="display:inline-block"><span style="display:block">2</span><span style="display:block"></span></span>x</p>',
      ),
    ).toEqual(['paragraph:2x']);
    // One that draws only a zero-width space is as empty: the parts either
    // side of it are still apart.
    expect(
      read(
        '<p><span style="display:inline-block"><span style="display:block">a</span><span style="display:block">\u200b</span><span style="display:block">b</span></span></p>',
      ),
    ).toEqual(['paragraph:a\u200b b']);
    // An empty one between two stacked parts keeps them apart.
    expect(
      read(
        '<p><span style="display:inline-block"><span style="display:block">a</span><span style="display:block"></span><span style="display:block">b</span></span></p>',
      ),
    ).toEqual(['paragraph:a b']);
  });

  // In code a block tag's declared inline display is honoured (Stripe), so a
  // <div> declared inline-block is a box there.
  test('in code, a div declared inline-block is a box', () => {
    expect(
      read(
        '<pre><code>call(<div style="display:inline-block"><span style="display:block">arg</span></div>, x)</code></pre>',
      ),
    ).toEqual(['code:call(arg, x)']);
  });

  // A <pre> declared inline-block is still the root its lines are read
  // from (Chromium's copy of a page styling `pre { display: inline-block }`).
  test('a code block declared inline-block keeps its lines', () => {
    expect(
      read(
        '<pre style="display: inline-block"><code><span style="display: block">a = 1</span><span style="display: block">b = 2</span></code></pre>',
      ),
    ).toEqual(['code:a = 1\nb = 2']);
  });

  // Taking a tentative gap back leaves the memo of the last solid run
  // pointing where it did: a blank line no browser draws came of it.
  test('a gap taken back moves nothing else', () => {
    expect(
      read(
        '<span style="display:table-cell">a</span><span style="display:table-cell"><span style="display:flex"><span></span></span></span> <span style="display:flex"><span>y</span></span>',
      ),
    ).toEqual(['paragraph:a\ny']);
    // Both the last solid run and how far the memo has looked move.
    expect(
      read(
        '<span style="display:table-cell">a</span><span style="display:table-cell"><span style="display:flex"><span></span></span></span>y<span style="display:flex"><span>z</span></span>',
      ),
    ).toEqual(['paragraph:a\ny\nz']);
    // A cell that pushes no gap -- after a space, or holding only a line
    // break or a zero-width space -- keeps all it holds, except the space a
    // line break takes, which a browser does not draw.
    expect(
      read(
        '<p><span style="display:table-cell">a </span><span style="display:table-cell"><br></span>b</p>',
      ),
    ).toEqual(['paragraph:a\nb']);
    expect(
      read(
        '<p><span style="display:table-cell">a </span><span style="display:table-cell">\u200b</span>b</p>',
      ),
    ).toEqual(['paragraph:a \u200bb']);
  });

  // MediaWiki's table of contents: number and title are table cells, and
  // Chromium drops the space between them.
  test('adjacent table cells holding text are words apart (Wikipedia contents)', () => {
    expect(
      read(
        '<ul><li><a href="#x"><span class="tocnumber" style="display: table-cell">10</span><span class="toctext" style="display: table-cell">Algebraic Proof</span></a></li></ul>',
      ),
    ).toEqual(['bulleted_list:10 Algebraic Proof']);
    // Firefox keeps the space; it is not doubled.
    expect(
      read(
        '<ul><li><a href="#x"><span class="tocnumber">10</span> <span class="toctext">Algebraic Proof</span></a></li></ul>',
      ),
    ).toEqual(['bulleted_list:10 Algebraic Proof']);
    expect(
      read(
        '<p><span style="display: table-cell">a</span><span style="display: table-cell">\u200b</span>b</p>',
      ),
    ).toEqual(['paragraph:a\u200bb']);
  });
});

describe("Safari's converted spaces", () => {
  // Safari writes a space at an inline boundary as a non-breaking space inside
  // `<span class="Apple-converted-space">` when it copies, so a paste from
  // Safari left U+00A0 where the reader saw ordinary spaces: words no longer
  // wrapped there and a search for "and" with spaces missed. The class is
  // Safari's own record that the character was a space. (Captured from a real
  // WebKit copy of `Pick <b>this bold</b> and <a>a link</a> …`.)
  test('read back as ordinary spaces', () => {
    const html =
      '<b>his bold</b><span><span class="Apple-converted-space"> </span>and<span class="Apple-converted-space"> </span></span><a href="https://ok.example/">a link</a>';

    expect(parseRichTextFromHtml(document, html)).toEqual([
      { text: 'his bold', marks: ['bold'] },
      { text: ' and ' },
      { text: 'a link', link: 'https://ok.example/' },
    ]);
  });

  test('every other non-breaking space is kept', () => {
    expect(parseRichTextFromHtml(document, '<p>a b</p>')).toEqual([{ text: 'a b' }]);
  });
});

describe("a link's underline is how links look, not a mark", () => {
  /**
   * Chromium and WebKit copy a link out of this editor with its computed
   * `text-decoration` inlined on the `<a>`, and Google Docs underlines a span
   * inside every link. Both pasted back as a link that was underlined too, and
   * the Markdown then read `[<u>docs</u>](…)`.
   */
  test("the editor's own link, as Chromium copies it", () => {
    expect(
      fromHtml(
        '<span style="white-space: pre-wrap;">the </span><a class="neditor-link" href="https://example.com/docs" rel="noopener noreferrer" style="box-sizing: inherit; color: inherit; text-decoration: underline rgba(55, 53, 47, 0.78); text-underline-offset: 2px; white-space: pre-wrap;">docs</a>',
      ),
    ).toEqual([{ text: 'the ' }, { text: 'docs', link: 'https://example.com/docs' }]);
  });

  test('a Google Docs link', () => {
    const blocks = blocksFromHtml(
      document,
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-x"><span style="font-size:11pt;font-family:Arial;color:#000000;font-weight:400;white-space:pre-wrap;">See </span><a href="https://example.com/x" style="text-decoration:none;"><span style="font-size:11pt;font-family:Arial;color:#1155cc;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:underline;-webkit-text-decoration-skip:none;text-decoration-skip-ink:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">the docs</span></a></b>',
    );

    expect(blocks.map((block) => block.content)).toEqual([
      [{ text: 'See ' }, { text: 'the docs', link: 'https://example.com/x' }],
    ]);
  });

  test('a <u> inside a link is still an underline', () => {
    expect(fromHtml('<a href="https://a.test/" style="text-decoration:none"><u>x</u></a>')).toEqual(
      [{ text: 'x', marks: ['underline'], link: 'https://a.test/' }],
    );
  });

  test('an underline around a link is still one', () => {
    expect(
      fromHtml('<span style="text-decoration:underline">a <a href="https://a.test/">b</a></span>'),
    ).toEqual([
      { text: 'a ', marks: ['underline'] },
      { text: 'b', marks: ['underline'], link: 'https://a.test/' },
    ]);
  });

  test('a strikethrough inside a link is still read', () => {
    expect(
      fromHtml('<a href="https://a.test/"><span style="text-decoration:line-through">x</span></a>'),
    ).toEqual([{ text: 'x', marks: ['strikethrough'], link: 'https://a.test/' }]);
  });

  test('outside a link, a styled underline is one as before', () => {
    expect(fromHtml('<span style="text-decoration:underline">x</span>')).toEqual([
      { text: 'x', marks: ['underline'] },
    ]);
  });
});

describe('a Word list is a list', () => {
  /**
   * Word writes a list item as a paragraph styled `mso-list:l0 levelN lfo1`,
   * with its bullet or number as text in a `mso-list:Ignore` span behind an
   * `<![if !supportLists]>` conditional. Read as paragraphs, they kept the
   * marker as text ("·      Bullet one") and lost their nesting, though the
   * README promises Word content keeps its structure.
   */
  const item = (marker: string, text: string, level: number, font = ''): string =>
    `<p class=MsoListParagraphCxSpMiddle style='margin-left:${36 * level}.0pt;mso-add-space:auto;text-indent:-18.0pt;mso-list:l0 level${level} lfo1'><![if !supportLists]><span style='${font}'><span style='mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><![endif]><span lang=EN-US>${text}<o:p></o:p></span></p>`;
  const html =
    `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><body><!--StartFragment-->` +
    item('·', 'Bullet one', 1, 'font-family:Symbol;mso-fareast-font-family:Symbol') +
    item('o', 'Bullet nested', 2, 'font-family:"Courier New"') +
    item('·', 'Bullet two', 1, 'font-family:Symbol') +
    `<p class=MsoNormal>Between<o:p></o:p></p>` +
    item('1.', 'Numbered one', 1) +
    item('2.', 'Numbered two', 1) +
    `<!--EndFragment--></body></html>`;

  test("the auditor's paste", () => {
    expect(
      blocksFromHtml(document, html).map((block) => [block.type, block.depth, blockText(block)]),
    ).toEqual([
      ['bulleted_list', 0, 'Bullet one'],
      ['bulleted_list', 1, 'Bullet nested'],
      ['bulleted_list', 0, 'Bullet two'],
      ['paragraph', 0, 'Between'],
      ['numbered_list', 0, 'Numbered one'],
      ['numbered_list', 0, 'Numbered two'],
    ]);
  });

  test.each([
    ['a.', 'numbered_list'],
    ['iv.', 'numbered_list'],
    ['(1)', 'numbered_list'],
    ['3)', 'numbered_list'],
    ['§', 'bulleted_list'],
    ['-', 'bulleted_list'],
    ['o', 'bulleted_list'],
  ])('the marker %j makes a %s', (marker, type) => {
    expect(blocksFromHtml(document, item(marker, 'x', 1)).map((block) => block.type)).toEqual([
      type,
    ]);
  });

  test('formatting in the item survives, and the marker does not', () => {
    const blocks = blocksFromHtml(
      document,
      `<p style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>·<span>&nbsp; </span></span><b>Bold</b> rest</p>`,
    );

    expect(blocks.map((block) => block.content)).toEqual([
      [{ text: 'Bold', marks: ['bold'] }, { text: ' rest' }],
    ]);
  });

  test('a paragraph that is not a list item is untouched', () => {
    expect(
      blocksFromHtml(document, `<p style='mso-list:none'>Plain</p>`).map((block) => block.type),
    ).toEqual(['paragraph']);
  });
});

describe('the clipboard writes breaks and spaces other applications keep', () => {
  /**
   * A soft line break went out as a raw newline inside the `<p>` and a run of
   * spaces as it stood, which only this package's reader kept: Gmail, Google
   * Docs and a plain contenteditable collapse both, and so did this reader
   * whenever WebKit dropped `application/x-neditor` on a paste between two
   * origins. Neither is something happy-dom lays out, so the emitted markup is
   * what is pinned here, beside the round trip.
   */
  const blocks: Block[] = [
    { id: 'a', type: 'paragraph', content: [{ text: 'two  spaces   three' }], depth: 0 },
    { id: 'b', type: 'quote', content: [{ text: 'line\nbreak' }], depth: 0 },
    { id: 'c', type: 'paragraph', content: [{ text: 'soft\nbreak ', marks: ['bold'] }], depth: 1 },
    { id: 'd', type: 'heading2', content: [{ text: 'H  two\nlines' }], depth: 0 },
    { id: 'e', type: 'bulleted_list', content: [{ text: 'item\n  more' }], depth: 0 },
    { id: 'f', type: 'bulleted_list', content: [{ text: '\tnested\n' }], depth: 1 },
    { id: 'g', type: 'toggle', content: [{ text: 'sum\nmary' }], depth: 0, collapsed: false },
    { id: 'h', type: 'callout', content: [{ text: 'a\n\nb' }], depth: 0, icon: '💡' },
    {
      id: 'i',
      type: 'table',
      content: [],
      depth: 0,
      rows: [[[{ text: 'c  1\nc2' }], [{ text: 'x' }]]],
    },
    { id: 'j', type: 'code', content: [{ text: 'x  =  1\n\n  y' }], depth: 0 },
  ];
  const shape = (list: readonly Block[]) =>
    list.map((block) => [
      block.type,
      block.depth,
      block.type === 'table' ? block.rows : block.content,
    ]);

  test('a line break is a <br>, never a raw newline, outside a code block', () => {
    const html = blocksToHtml(document, blocks);
    const outsideCode = html.replace(/<pre>[\s\S]*?<\/pre>/g, '');

    expect(outsideCode).not.toContain('\n');
    expect(html).toContain('line<br>break');
    expect(html).toContain('<strong>soft<br>break </strong>');
    expect(html).toContain('<pre><code>x  =  1\n\n  y</code></pre>');
  });

  test('every element holding text says it preserves whitespace', () => {
    const host = document.createElement('div');
    host.innerHTML = blocksToHtml(document, blocks);

    for (const selector of ['p', 'blockquote', 'h2', 'li', 'summary', 'th, td']) {
      const found = [...host.querySelectorAll<HTMLElement>(selector)];

      expect([selector, found.length > 0]).toEqual([selector, true]);
      expect([selector, ...found.map((element) => element.style.whiteSpace)]).toEqual([
        selector,
        ...found.map(() => 'pre-wrap'),
      ]);
    }
  });

  test('and it reads back exactly, depth included', () => {
    expect(shape(blocksFromHtml(document, blocksToHtml(document, blocks)))).toEqual(shape(blocks));
  });

  test('a trailing break keeps its filler', () => {
    // `renderRichText` appends a `<br>` after a final newline as filler, which
    // the reader reads back as nothing; the newline itself is the one before.
    const trailing: Block[] = [
      { id: 'a', type: 'paragraph', content: [{ text: 'a\n' }], depth: 0 },
      { id: 'b', type: 'paragraph', content: [{ text: 'b \n ' }], depth: 0 },
    ];
    const html = blocksToHtml(document, trailing);

    expect(html).toContain('a<br><br>');
    expect(shape(blocksFromHtml(document, html))).toEqual(shape(trailing));
  });

  test('HTML this package wrote before still reads its raw newlines', () => {
    // No `pre-wrap` anywhere, and a marker only this writer emits.
    expect(
      blocksFromHtml(
        document,
        '<ul data-neditor-list=""><li>soft\nbreak</li></ul><p data-neditor-depth="1">x\n  y</p>',
      ).map((block) => [block.type, block.depth, richToPlainText(block.content)]),
    ).toEqual([
      ['bulleted_list', 0, 'soft\nbreak'],
      ['paragraph', 1, 'x\n  y'],
    ]);
  });
});

describe('a foreign paragraph draws its source whitespace as one space', () => {
  /**
   * Firefox copies a page's `<p>` with its source line-wrapping and
   * indentation as they are in the HTML -- Sphinx, Hugo, Jekyll and MkDocs all
   * wrap it -- and every block used to keep its whitespace as it stood, so the
   * paragraph a page showed on one line pasted as three, indented.
   */
  test("the auditor's page", () => {
    expect(
      blocksFromHtml(
        document,
        '<p id="w1">The quick brown fox jumps over\n    the lazy dog, and then it\n    runs away.</p>\n<p id="w2">Second paragraph\n    also wrapped.</p>',
      ).map((block) => [block.type, richToPlainText(block.content)]),
    ).toEqual([
      ['paragraph', 'The quick brown fox jumps over the lazy dog, and then it runs away.'],
      ['paragraph', 'Second paragraph also wrapped.'],
    ]);
  });

  test('Word wraps its own source lines', () => {
    expect(
      blocksFromHtml(
        document,
        '<p class=MsoNormal>A sentence Word\r\nwrapped in its <b>source</b>,\r\nas it does.<o:p></o:p></p>',
      ).map((block) => block.content),
    ).toEqual([
      [
        { text: 'A sentence Word wrapped in its ' },
        { text: 'source', marks: ['bold'] },
        { text: ', as it does.' },
      ],
    ]);
  });

  test('a <br> still breaks the line, and takes the spaces either side', () => {
    expect(
      blocksFromHtml(document, '<p>one  \n  <br>\n  two</p>').map((block) =>
        richToPlainText(block.content),
      ),
    ).toEqual(['one\ntwo']);
  });

  test('a heading, a quote and a list item read the same way', () => {
    expect(
      blocksFromHtml(
        document,
        '<h2>\n  A wrapped\n  heading\n</h2><blockquote>\n  quoted\n  text\n</blockquote><ul>\n  <li>\n    an item\n    wrapped\n  </li>\n</ul>',
      ).map((block) => [block.type, richToPlainText(block.content)]),
    ).toEqual([
      ['heading2', 'A wrapped heading'],
      ['quote', 'quoted text'],
      ['bulleted_list', 'an item wrapped'],
    ]);
  });

  test('whitespace a style or a <pre> preserves is kept', () => {
    expect(
      blocksFromHtml(
        document,
        '<p style="white-space:pre-wrap">a  b\nc</p><p>x <span style="white-space:pre">  y</span></p>',
      ).map((block) => richToPlainText(block.content)),
    ).toEqual(['a  b\nc', 'x   y']);
  });

  test('a typed space at the edge of a paste stays, its indentation does not', () => {
    // The paste lands mid-line, so a space somebody selected matters; the
    // source's own line-wrapping at the same edge was never selected.
    expect(
      blocksFromHtml(document, '<p>quick brown </p>').map((block) =>
        richToPlainText(block.content),
      ),
    ).toEqual(['quick brown ']);
    expect(
      blocksFromHtml(document, '<p>\n    quick brown\n</p>').map((block) =>
        richToPlainText(block.content),
      ),
    ).toEqual(['quick brown']);
  });
});

describe('a Word list WebKit has sanitized is still a list', () => {
  // What WebKit hands a page for the same Word payload: every `mso-`
  // declaration and the marker span's style gone, Word's class and indent
  // kept, the marker the first text of the paragraph.
  const item = (marker: string, text: string, level: number): string =>
    `<p class="MsoListParagraphCxSpMiddle" style="color: rgb(0, 0, 0); white-space: normal; text-decoration: none; margin-left: ${36 * level}pt; text-indent: -18pt;"><span style="font-family: Symbol;"><span>${marker}<span style="font-size: 7pt; font-family: Times New Roman;">     <span class="Apple-converted-space"> </span></span></span></span><span lang="EN-US">${text}<o:p></o:p></span></p>`;

  test("the auditor's paste, as WebKit delivers it", () => {
    expect(
      blocksFromHtml(
        document,
        `<head><meta charset="UTF-8"></head>${item('·', 'Bullet one', 1)}${item('o', 'Bullet nested', 2)}<p class="MsoNormal">Between<o:p></o:p></p>${item('1.', 'Numbered one', 1)}`,
      ).map((block) => [block.type, block.depth, blockText(block)]),
    ).toEqual([
      ['bulleted_list', 0, 'Bullet one'],
      ['bulleted_list', 1, 'Bullet nested'],
      ['paragraph', 0, 'Between'],
      ['numbered_list', 0, 'Numbered one'],
    ]);
  });

  test('a list paragraph with no marker in front stays a paragraph', () => {
    expect(
      blocksFromHtml(document, '<p class="MsoListParagraph">Just text here</p>').map(
        (block) => block.type,
      ),
    ).toEqual(['paragraph']);
  });

  // R2-PARSE-5: US and Mac Word write the indent in inches, and WebKit keeps
  // Word's unit; only `pt` was read, so every item came back at depth 0.
  test.each([
    ['.5in', '1.0in', '1.5in'],
    ['0.5in', '1in', '1.5in'],
    ['1.27cm', '2.54cm', '3.81cm'],
    ['12.7mm', '25.4mm', '38.1mm'],
    ['48px', '96px', '144px'],
  ])('an indent of %s, %s, %s is three levels', (one, two, three) => {
    const at = (marker: string, text: string, margin: string): string =>
      item(marker, text, 1).replace('margin-left: 36pt', `margin-left: ${margin}`);

    expect(
      blocksFromHtml(
        document,
        at('·', 'One', one) +
          at('o', 'Nested', two) +
          at('§', 'Deeper', three) +
          at('·', 'Two', one),
      ).map((block) => [block.type, block.depth, blockText(block)]),
    ).toEqual([
      ['bulleted_list', 0, 'One'],
      ['bulleted_list', 1, 'Nested'],
      ['bulleted_list', 2, 'Deeper'],
      ['bulleted_list', 0, 'Two'],
    ]);
  });

  test.each(['1.1.', 'viii.', '(xii)'])('the marker %j is numbered here too', (marker) => {
    expect(blocksFromHtml(document, item(marker, 'x', 1)).map((block) => block.type)).toEqual([
      'numbered_list',
    ]);
  });
});

describe('Word numbers past three letters, and pictures for bullets', () => {
  // R2-PARSE-6: a multilevel `1.1.` and a roman `viii.` were read as bullets,
  // since the numbered test stopped at three letters; a picture bullet -- an
  // `<img>` in the marker span -- kept the item from being an item at all, its
  // spacer stayed in the text as three no-break spaces, and a web picture
  // became an image block of its own.
  const item = (marker: string, text: string, level = 1): string =>
    `<p class=MsoListParagraphCxSpMiddle style='margin-left:${36 * level}.0pt;mso-list:l0 level${level} lfo1'><![if !supportLists]><span style='mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp; </span></span><![endif]>${text}<o:p></o:p></p>`;

  test.each(['1.1.', '1.1.1.', '2.10.', 'viii.', 'VIII.', '(xii)', 'xlii)'])(
    '%j is numbered',
    (marker) => {
      expect(blocksFromHtml(document, item(marker, 'x')).map((block) => block.type)).toEqual([
        'numbered_list',
      ]);
    },
  );

  test("the auditor's picture bullets", () => {
    const html =
      `<p class=MsoListParagraphCxSpFirst style='text-indent:-.25in;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'><img width=11 height=11 src="file:///C:/Temp/clip_image001.gif" alt="*"><span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp; </span></span><![endif]>Picture bullet<o:p></o:p></p>` +
      `<p class=MsoListParagraphCxSpLast style='text-indent:-.25in;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'><img src="https://i.test/b.png" alt="*"><span>&nbsp;&nbsp; </span></span><![endif]>Web bullet<o:p></o:p></p>`;

    expect(
      blocksFromHtml(document, html).map((block) => [block.type, block.depth, block.content]),
    ).toEqual([
      ['bulleted_list', 0, [{ text: 'Picture bullet' }]],
      ['bulleted_list', 0, [{ text: 'Web bullet' }]],
    ]);
  });

  test('a picture in the item text, past the marker, is still a picture', () => {
    const html = `<p style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>·<span>&nbsp; </span></span>See <img src="https://i.test/x.png" alt="x"></p>`;

    expect(blocksFromHtml(document, html).map((block) => block.type)).toContain('image');
  });
});

describe('a converted space stays a space when the block collapses', () => {
  // R2-PARSE-11: WebKit writes a run of spaces at a boundary as alternating
  // no-break and ordinary spaces inside `Apple-converted-space`. Converted to
  // spaces first and collapsed second, three became one.
  const html = 'x<span class="Apple-converted-space">&nbsp; &nbsp;</span>y';

  test('in a paragraph', () => {
    expect(blocksFromHtml(document, `<p>${html}</p>`).map((block) => block.content)).toEqual([
      [{ text: 'x   y' }],
    ]);
  });

  test('as inline content', () => {
    expect(blocksFromHtml(document, html).map((block) => block.content)).toEqual([
      [{ text: 'x   y' }],
    ]);
    expect(fromHtml(html)).toEqual([{ text: 'x   y' }]);
  });

  test('a lone one in source whitespace collapses with it', () => {
    // R3-FMT-2: one converted space is an ordinary space, and the source
    // layout either side of it holds no space that was drawn.
    expect(
      blocksFromHtml(
        document,
        '<p>x\n    <span class="Apple-converted-space">&nbsp;</span>\n    y</p>',
      ).map(blockText),
    ).toEqual(['x y']);
  });
});

describe('whitespace is decided per text, not per block', () => {
  // R2-PARSE-2: one inline element declaring `pre` made the whole block read
  // raw, so a source-wrapped paragraph around it pasted its indentation as
  // real lines.
  test("the auditor's paragraph", () => {
    expect(
      blocksFromHtml(
        document,
        '<p>One\n    two <span style="white-space:pre">x  y</span>\n    three</p>',
      ).map((block) => block.content),
    ).toEqual([[{ text: 'One two x  y three' }]]);
  });

  test('a preserved line break inside it stands, and so does a tab', () => {
    expect(
      blocksFromHtml(
        document,
        '<p>a\n  b <span style="white-space:pre-wrap">c\n\td</span>\n  e</p>',
      ).map(blockText),
    ).toEqual(['a b c\n\td e']);
  });

  test('pre-line keeps its breaks and collapses its spaces', () => {
    expect(
      blocksFromHtml(
        document,
        '<p>a\n  <span style="white-space:pre-line">b   c\n  d</span>\n  e</p>',
      ).map(blockText),
    ).toEqual(['a b c\nd e']);
  });

  test('text that already holds the internal marks reads as itself', () => {
    expect(
      blocksFromHtml(
        document,
        '<p>\uFDD0a\n  <span style="white-space:pre">\uFDD2 b</span></p>',
      ).map(blockText),
    ).toEqual(['\uFDD0a \uFDD2 b']);
  });

  test('a list item reads its own text that way, and its nested list is its own', () => {
    expect(
      blocksFromHtml(
        document,
        '<ul><li>a\n    <span style="white-space:pre">x  y</span>\n    <ul><li>n\n  m</li></ul></li></ul>',
      ).map((block) => [block.depth, blockText(block)]),
    ).toEqual([
      [0, 'a x  y'],
      [1, 'n m'],
    ]);
  });
});

describe('code keeps the spaces the plain text shows', () => {
  // R2-PARSE-1: Firefox copies a page's class, not its computed style, so
  // GitHub's `code { white-space: break-spaces }` arrived as a bare `<code>`
  // and its spaces collapsed. Its plain text shows them, and decides (R3-FMT-1:
  // without it, code is drawn `normal` like the paragraph around it).
  test.each(['code', 'kbd', 'samp'])('in <%s>', (tag) => {
    expect(
      blocksFromHtml(document, `<p>Run <${tag}>npm  install  --save</${tag}> now.</p>`, {
        plain: 'Run npm  install  --save now.',
      }).map((block) => richToPlainText(block.content)),
    ).toEqual(['Run npm  install  --save now.']);
  });

  test.each(['code', 'kbd', 'samp'])('and without it, <%s> collapses', (tag) => {
    expect(
      blocksFromHtml(document, `<p>Run <${tag}>npm  install  --save</${tag}> now.</p>`).map(
        (block) => richToPlainText(block.content),
      ),
    ).toEqual(['Run npm install --save now.']);
  });

  test('a style on the code element itself still decides', () => {
    expect(
      blocksFromHtml(document, '<p>Run <code style="white-space: normal">a  b</code> now.</p>').map(
        blockText,
      ),
    ).toEqual(['Run a b now.']);
  });

  test('as inline content too', () => {
    expect(fromHtml('Run <code>a  b</code>')).toEqual([
      { text: 'Run ' },
      { text: 'a  b', marks: ['code'] },
    ]);
  });
});

describe('the plain text decides what a stylesheet preserved', () => {
  // R2-PARSE-1: Firefox's HTML names the page's classes, not their computed
  // whitespace, so `<p class="pw">` styled `pre-wrap` and a source-wrapped
  // `<p>` look the same. Its `text/plain` is the text as drawn: where the HTML
  // declares no `white-space` at all, the block's text as it stands is kept
  // when the plain text holds it, and collapsed when it does not.
  const read = (html: string, plain: string): string[] =>
    blocksFromHtml(document, html, { plain }).map(blockText);

  test.each([
    [
      'pre-wrap by class',
      '<div id="s"><p class="pw">two  spaces\tand tab\nnext line</p></div>',
      'two  spaces\tand tab\nnext line',
      'two  spaces\tand tab\nnext line',
    ],
    [
      'pre by class',
      '<div id="s"><p class="art"> /\\_/\\\n( o.o )\n &gt; ^ &lt;</p></div>',
      ' /\\_/\\\n( o.o )\n > ^ <',
      ' /\\_/\\\n( o.o )\n > ^ <',
    ],
    [
      'pre-line by class',
      '<div id="s"><p class="poem">Roses are red,\n  violets blue</p></div>',
      'Roses are red,\n  violets blue',
      'Roses are red,\n  violets blue',
    ],
    [
      'source line-wrapping',
      '<div id="s"><p>The quick brown fox\n    jumps over the dog.</p></div>',
      'The quick brown fox jumps over the dog.',
      'The quick brown fox jumps over the dog.',
    ],
  ])('%s', (_, html, plain, expected) => {
    expect(read(html, plain)).toEqual([expected]);
  });

  test('each block asks for itself', () => {
    expect(
      read('<p class="pw">a  b</p>\n<p>c\n   d</p>\n<p class="pw">e\tf</p>', 'a  b\n\nc d\n\ne\tf'),
    ).toEqual(['a  b', 'c d', 'e\tf']);
  });

  test('without the plain text the old reading stands', () => {
    expect(blocksFromHtml(document, '<p class="pw">two  spaces\nnext</p>').map(blockText)).toEqual([
      'two spaces next',
    ]);
  });

  test('a block that declares its whitespace is believed, whatever the plain text says', () => {
    expect(read('<p style="white-space: normal">a  b</p>', 'a  b')).toEqual(['a b']);
    expect(read('<div style="white-space: normal">a  b</div>', 'a  b')).toEqual(['a b']);
    expect(
      read('<div style="white-space: normal"><p>a  b</p></div><p>c\n  d</p>', 'a  b\n\nc d'),
    ).toEqual(['a b', 'c d']);
  });

  test('one that does not is decided by the plain text, beside one that does', () => {
    // R3-FMT-1: declared anywhere in the HTML, the plain text was not asked at
    // all -- so once `<code>` stopped preserving by default, Firefox's copy of
    // a paragraph with one inline `pre` span lost its code's spaces.
    expect(read('<p style="white-space: normal">a  b</p><p>c  d</p>', 'a b\n\nc  d')).toEqual([
      'a b',
      'c  d',
    ]);
    expect(
      read(
        '<div id="foreign"><style>#foreign code { white-space: break-spaces }</style><p id="w1">Run <code>npm  install  --save</code> now, then\n    <span style="white-space: pre">x  y</span>\n    as well.</p></div>',
        'Run npm  install  --save now, then x  y as well.',
      ),
    ).toEqual(['Run npm  install  --save now, then x  y as well.']);
    // The same phrase as Firefox copies it from inside the paragraph: bare
    // inline content, one element of which declares.
    expect(
      read(
        'Run <code>npm  install  --save</code> now, then\n    <span style="white-space: pre">x  y</span>\n    as well.',
        'Run npm  install  --save now, then x  y as well.',
      ),
    ).toEqual(['Run npm  install  --save now, then x  y as well.']);
  });

  test('a phrase whose every element declares its whitespace is believed', () => {
    // As Chromium and WebKit copy one: each element carries its computed style.
    expect(
      read(
        '<span style="white-space: normal">a  b </span><code style="white-space: normal">c  d</code>',
        'a  b c  d',
      ),
    ).toEqual(['a b c d']);
  });

  test('a block found nowhere in the plain text collapses', () => {
    expect(read('<p>a  b</p>', 'something else')).toEqual(['a b']);
  });

  test('looks for each block near the last one, never through the whole plain text', () => {
    // A search of the whole plain text per block cost the plain text's length
    // for every block: here 2,000 blocks against 2 MB that holds none of them.
    // Bounded, the plain text costs a few kilobytes a block on top of the read.
    const html = Array.from({ length: 2000 }, (_, i) => `<p>line ${i}\n   wrapped</p>`).join('');
    const plain = 'z'.repeat(2_000_000);
    const time = (options: { plain?: string }): number => {
      const start = performance.now();
      blocksFromHtml(document, html, options);
      return performance.now() - start;
    };

    time({});
    const without = Math.min(time({}), time({}));
    const withPlain = Math.min(time({ plain }), time({ plain }));

    expect(withPlain / without).toBeLessThan(4);
  });
});

describe('HTML from an older writer can be read as it was written', () => {
  // R2-PARSE-3: releases up to 0.1.3 wrote a soft break as a raw newline and
  // a run of spaces as it stood, marking only nested and checked blocks
  // `data-neditor-*`. Stored HTML with no such block cannot be told apart
  // from a page's source-wrapped paragraphs, so the caller says.
  const old = '<p>soft\nbreak  two</p><h2>H\tx</h2>';

  test('auto: an unmarked paragraph collapses as a browser draws it', () => {
    expect(blocksFromHtml(document, old).map(blockText)).toEqual(['soft break two', 'H x']);
  });

  test("preserve: read raw, as that writer's own reader did", () => {
    expect(
      blocksFromHtml(document, old, { whitespace: 'preserve' }).map((block) => [
        block.type,
        blockText(block),
      ]),
    ).toEqual([
      ['paragraph', 'soft\nbreak  two'],
      ['heading2', 'H\tx'],
    ]);
  });

  test('preserve leaves structure alone', () => {
    expect(
      blocksFromHtml(
        document,
        '<ul><li>a  b<ul><li>c\nd</li></ul></li></ul><p data-neditor-depth="1">e</p>',
        { whitespace: 'preserve' },
      ).map((block) => [block.type, block.depth, blockText(block)]),
    ).toEqual([
      ['bulleted_list', 0, 'a  b'],
      ['bulleted_list', 1, 'c\nd'],
      ['paragraph', 1, 'e'],
    ]);
  });

  test.each([
    ['an inline formula', '<span data-neditor-math="a" contenteditable="false">a</span>'],
    ['a display equation', '<div data-neditor-math-block="a">a</div>'],
    ['a code block label', '<pre data-neditor-code-label="Code">a</pre>'],
  ])("a live editor's %s in a page's copy is no sign of that writer", (_, mark) => {
    // R1-reader-1: that writer emitted only `data-neditor-depth`, `-list`,
    // `-checked` and `-callout`. A page range copied across a live editor
    // carries the renderer's own marks, and one of them anywhere read the
    // whole page raw: its source newline and indent pasted as text.
    const html =
      '<p>Intro text\n    wrapped in source</p>\n' +
      `<div class="neditor"><div class="neditor-block"><p class="neditor-block__content">x ${mark} y</p></div></div>\n` +
      '<p>After\n    text</p>';
    const texts = blocksFromHtml(document, html).map(blockText);

    expect(texts[0]).toBe('Intro text wrapped in source');
    expect(texts.at(-1)).toBe('After text');
  });

  test.each([
    '<p data-neditor-depth="0">d</p>',
    '<ul data-neditor-list="bulleted_list"><li>d</li></ul>',
    '<ul><li data-neditor-checked="true">d</li></ul>',
    '<blockquote data-neditor-callout="i">d</blockquote>',
  ])("each mark that writer emitted still says it is that writer's: %s", (mark) => {
    expect(blocksFromHtml(document, `<p>soft\nbreak</p>${mark}`).map(blockText)[0]).toBe(
      'soft\nbreak',
    );
  });
});

describe('a copied text range keeps its spaces in other applications', () => {
  // R2-PARSE-4 / R2-EDIT-3: the text-range writer put runs of spaces and tabs
  // in the HTML raw, with nothing saying they are preserved, so every other
  // application -- and this reader, when WebKit drops our own type between
  // origins -- collapsed them: `def f():\n    return  1` from a code block
  // pasted as `def f():\nreturn 1`. happy-dom lays nothing out, so the mark is
  // pinned here beside the round trip.
  const round = (content: RichText): RichText[] =>
    blocksFromHtml(document, richTextToHtml(document, content)).map((block) => block.content);

  test('the HTML says its whitespace is preserved', () => {
    expect(richTextToHtml(document, [{ text: 'a  b' }])).toBe(
      '<span style="white-space: pre-wrap;">a  b</span>',
    );
  });

  test.each<[string, RichText]>([
    ['double spaces', [{ text: 'a  b   c' }]],
    ['tabs', [{ text: 'a\tb\t\tc' }]],
    ['a leading indent', [{ text: '    return  1' }]],
    ['edge spaces', [{ text: ' a ' }]],
    ['edge spaces across marks', [{ text: ' a ', marks: ['bold'] }, { text: '  b\t' }]],
    ['indented lines', [{ text: 'def f():\n    return  1' }]],
  ])('%s', (_, content) => {
    expect(round(content)).toEqual([content]);
  });

  test('a range from a code block is written as code', () => {
    const content: RichText = [{ text: 'def f():\n    return  1' }];
    const html = richTextToHtml(document, content, { code: true });

    expect(html).toMatch(/^<pre\b/);
    expect(blocksFromHtml(document, html)).toEqual([
      expect.objectContaining({ type: 'code', content }),
    ]);
  });
});

describe('the plain text is read where each block stands in it', () => {
  // R3-FMT-4/5: each block was searched for in a window past the last one
  // found -- quadratic on periodic text, accepted anywhere in the window, and
  // moved on only by blocks that had whitespace to collapse. Every block is
  // now matched at the cursor, whitespace aside, and moves it on.
  const read = (html: string, plain: string): string[] =>
    blocksFromHtml(document, html, { plain }).map(blockText);

  test('a periodic block costs its length, not its length squared', () => {
    // The auditor's pair: one block `ab…ab  ab…ab`, its plain text three
    // copies of `ab…ab `. Searched for, 100k characters took 650 ms against
    // 7 ms without the plain text.
    const half = 'ab'.repeat(50_000);
    const html = `<p>${half}  ${half}</p>`;
    const plain = `${half} `.repeat(3);
    const time = (options: { plain?: string }): number => {
      const start = performance.now();
      blocksFromHtml(document, html, options);
      return performance.now() - start;
    };

    // Best of five each, and 8x: the defect this guards ran 90x slower, while
    // the honest ratio sits near 2-3 and a loaded machine pushed a best of two
    // past 4 in rounds 8 and 9 alike (measured, R10 gate) -- a flaky guard is
    // one nobody believes.
    time({});
    const best = (options: { plain?: string }) =>
      Math.min(...Array.from({ length: 5 }, () => time(options)));
    const without = best({});
    const withPlain = best({ plain });

    expect(withPlain / without).toBeLessThan(8);
  });

  test('blocks the cursor misses are looked for a bounded number of lines on', () => {
    // Each of 4,000 blocks matches all but its last character at the start of
    // every line, so each is tried at each line it is looked for at: bounded,
    // that is a constant times its length; unbounded, the plain text's length.
    const line = 'x'.repeat(49);
    const html = Array.from({ length: 4000 }, () => `<p>${line}q\n  w</p>`).join('');
    const plain = Array.from({ length: 4000 }, () => `${line}z w`).join('\n');
    const time = (options: { plain?: string }): number => {
      const start = performance.now();
      blocksFromHtml(document, html, options);
      return performance.now() - start;
    };

    time({});
    const without = Math.min(time({}), time({}));
    const withPlain = Math.min(time({ plain }), time({ plain }));

    expect(withPlain / without).toBeLessThan(4);
  });

  test('a block after many single-line paragraphs is still found', () => {
    // Fifty short paragraphs moved nothing on, so the pre-wrap block after
    // them was past the window and collapsed. A hundred, so that it is past
    // the lines a block the cursor missed is looked for in, too: only a
    // cursor every block moves on reaches it.
    const filler = Array.from(
      { length: 100 },
      (_, i) => `Paragraph ${i} ${'lorem ipsum dolor '.repeat(5)}end.`,
    );
    const html = `<div id="s">${filler.map((text) => `<p>${text}</p>`).join('')}<p class="pw">line1\nline2  x</p></div>`;
    const plain = `${filler.join('\n\n')}\n\nline1\nline2  x`;

    expect(read(html, plain).at(-1)).toBe('line1\nline2  x');
  });

  test('two blocks with the same text are each read against their own place', () => {
    // A match anywhere in the window took the second block's drawn text for
    // the first, and the pair came back swapped.
    expect(read('<div id="s"><p>a\n b</p><p class="pw">a\n b</p></div>', 'a b\n\na\n b')).toEqual([
      'a b',
      'a\n b',
    ]);
  });

  test("a pre-wrap block's last newline draws none when the HTML says pre-wrap, too", () => {
    // Chromium and WebKit write the computed style, so the same paragraph
    // arrives declared; its source newline is still the end of its last line.
    // A `<br>` there is a line break somebody made, and stays.
    const style = 'white-space: pre-wrap;';

    expect(
      blocksFromHtml(
        document,
        `<p style="${style}">line1\nline2\n</p><p style="${style}">next</p><p style="${style}">soft<br><br></p><p style="${style}">then\n<br></p>`,
      ).map(blockText),
    ).toEqual(['line1\nline2', 'next', 'soft\n', 'then\n']);
  });

  test("a pre-wrap block's last newline ends its last line and draws none", () => {
    expect(
      read('<div id="s"><p class="pw">line1\nline2\n</p><p>next</p></div>', 'line1\nline2\n\nnext'),
    ).toEqual(['line1\nline2', 'next']);
  });

  test('a block the plain text does not hold is passed over, and the next found', () => {
    // Firefox writes an image's alt text into the plain text; the paragraph's
    // own text has none, so it is not found -- but the block after it is.
    expect(
      read(
        '<div id="s"><p>a <img alt="ALT" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="> b</p><p class="pw">c  d</p></div>',
        'a ALT b\n\nc  d',
      ).at(-1),
    ).toBe('c  d');
  });

  test('a source line break before the text is no line of its own', () => {
    // The newlines before a block in the plain text are the gap between
    // blocks, not the block's own: they never decide its leading whitespace.
    expect(read('<p>one</p><p>\ntwo  three\n</p>', 'one\n\ntwo  three')).toEqual([
      'one',
      'two  three',
    ]);
  });

  test('whitespace is decided gap by gap', () => {
    // A paragraph whose code a stylesheet makes pre-wrap: the source wrap is
    // collapsed and the code's double space kept, as Firefox drew them.
    expect(
      read('<p>Some text\n   wrapped <code>a  b</code></p>', 'Some text wrapped a  b'),
    ).toEqual(['Some text wrapped a  b']);
  });

  test('more misses in a row than the look-ahead still find the block after them', () => {
    // R4-FMT-2: a block not found never moved the cursor, so after 64 of them
    // in a row -- Firefox writes a `<q>` with its quote marks -- the window
    // never reached past them again. The auditor's page, 70 such paragraphs.
    const quoted = Array.from({ length: 70 }, (_, i) => `<p>Item ${i} <q>quoted</q> text</p>`);
    const html = `<div id="s"><p class="pw">top  one</p>${quoted.join('')}<p class="pw">keep  two  spaces</p><pre>pre  x</pre><p class="pw">last  one</p></div>`;
    const plain = [
      'top  one',
      ...Array.from({ length: 70 }, (_, i) => `Item ${i} "quoted" text`),
      'keep  two  spaces',
      'pre  x',
      'last  one',
    ].join('\n\n');
    const texts = read(html, plain);

    expect(texts.slice(0, 2)).toEqual(['top  one', 'Item 0 quoted text']);
    expect(texts.slice(-3)).toEqual(['keep  two  spaces', 'pre  x', 'last  one']);
  });

  test('a block the plain text leaves out moves on no further than its own lines', () => {
    // A missed block is taken to stand on the next line or lines past the
    // cursor; one the plain text does not hold at all must not cost the
    // block after it its place, which is still at the cursor -- nor, once
    // that block is found there, the blocks after it theirs.
    expect(
      read(
        '<div id="s"><p class="pw">a  b</p><p>hidden</p><p>gone</p><p class="pw">c  d</p><p>x <q>y</q></p><p class="pw">e  f</p></div>',
        'a  b\n\nc  d\n\nx "y"\n\ne  f',
      ),
    ).toEqual(['a  b', 'hidden', 'gone', 'c  d', 'x y', 'e  f']);
  });

  test('a claim moves where the look-ahead starts, never what it can reach', () => {
    // R5-FMT-1: a block the plain text left out claimed the line the next
    // block stood on, a block spelled differently (a `<q>`) claimed another,
    // and the look-ahead for every block after started past its own line.
    // The auditor's replay cases.
    expect(
      read(
        '<p>hidden one</p><p>say <q>hi</q></p><p>Z  z</p><p>W  w</p>',
        'say “hi”\n\nZ  z\n\nW  w',
      ),
    ).toEqual(['hidden one', 'say hi', 'Z  z', 'W  w']);
    expect(
      read(
        '<p>hidden one</p><p>say <q>hi</q></p><p>say <q>ho</q></p><p>Z  z</p>',
        'say “hi”\n\nsay “ho”\n\nZ  z',
      ),
    ).toEqual(['hidden one', 'say hi', 'say ho', 'Z  z']);
  });

  test('a table whose first cells are spelled differently costs the blocks after it nothing', () => {
    // R5-FMT-1: every cell of a row stands on one line of Firefox's plain
    // text, but each missed cell claimed a line of its own, so the table
    // claimed rows x columns lines and every block after it missed and
    // collapsed. The auditor's Firefox copies: a flag's alt text Firefox
    // writes, and a `<q>`'s quote marks.
    const after = (html: string, plain: string): string[] =>
      blocksFromHtml(document, html, { plain })
        .filter((block) => block.type === 'paragraph')
        .map(blockText);
    const flag =
      '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="flag" width="8" height="8">';

    expect(
      after(
        `<p id="first">before</p><table><tbody><tr><td>${flag} France</td><td class="pw">a  b</td><td class="pw">c  d</td></tr><tr><td>${flag} Spain</td><td class="pw">e  f</td><td class="pw">g  h</td></tr></tbody></table><p class="pw">Z  z</p><p class="pw">W   w</p><p class="pw" id="last">end  end</p>`,
        'before\nflag France\ta  b\tc  d\nflag Spain\te  f\tg  h\n\nZ  z\n\nW   w\n\nend  end',
      ),
    ).toEqual(['before', 'Z  z', 'W   w', 'end  end']);
    expect(
      after(
        '<p id="first">before</p><table><tbody><tr><td><q>quoted</q></td><td class="pw">a  b</td><td>x</td></tr><tr><td>plain</td><td class="pw">e  f</td><td>y</td></tr></tbody></table><p class="pw">Z  z</p><p class="pw">W   w</p><p class="pw" id="last">end  end</p>',
        'before\n"quoted"\ta  b\tx\nplain\te  f\ty\n\nZ  z\n\nW   w\n\nend  end',
      ),
    ).toEqual(['before', 'Z  z', 'W   w', 'end  end']);
  });

  test('a cell after the first in its row claims no line', () => {
    // The flag table again, with more rows than the look-ahead: the block
    // after it is past the reach of a search from the cursor, so it is found
    // only if the claims put the look-ahead on it -- a line per row, where
    // Firefox writes the row, not one per cell.
    const flag =
      '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="flag" width="8" height="8">';
    const rows = Array.from({ length: 70 }, (_, i) => i);
    const blocks = blocksFromHtml(
      document,
      `<p>before</p><table><tbody>${rows.map((i) => `<tr><td>${flag} Land ${i}</td><td>a</td><td>b</td></tr>`).join('')}</tbody></table><p class="pw">Z  z</p>`,
      {
        plain: `before\n${rows.map((i) => `flag Land ${i}\ta\tb`).join('\n')}\n\nZ  z`,
      },
    );

    expect(blocks.filter((block) => block.type === 'paragraph').map(blockText)).toEqual([
      'before',
      'Z  z',
    ]);
  });

  test("a cell's edge spaces stand where the plain text has them, after a tab too", () => {
    // R4-FMT-6a: the leading-space rule asked for a line start, and every
    // cell but a row's first follows a tab in Firefox's plain text, so
    // `<td class=pw> f </td>` read `f`. The auditor's table, as Firefox wrote
    // it. A cell's end counts only at the end of its row: before the tab,
    // Firefox writes a trailing space whether the cell draws it or not
    // (`cell `, `mid `), so there the plain text cannot tell -- and the space
    // a pre-wrap `x ` does draw collapses, as it did before.
    const cells = (html: string, plain: string): string[][] | undefined =>
      blocksFromHtml(document, html, { plain })[0]?.rows?.map((row) => row.map(richToPlainText));

    expect(
      cells(
        '<div id="s"><table><tbody><tr><td class="pw">a  b</td><td>c</td></tr><tr><td class="pw">d\ne</td><td class="pw"> f </td></tr></tbody></table><p class="pw">p  q</p></div>',
        'a  b\tc\nd\ne\t f \n\np  q',
      ),
    ).toEqual([
      ['a  b', 'c'],
      ['d\ne', ' f '],
    ]);
    expect(
      cells(
        '<div id="s"><table><tbody><tr><td>cell </td><td> mid </td><td>last </td></tr><tr><td class="pw">x </td><td class="pw"> y </td><td class="pw">z </td></tr></tbody></table><p>after</p></div>',
        'cell \tmid \tlast\nx \t y \tz \n\nafter',
      ),
    ).toEqual([
      ['cell', 'mid', 'last'],
      ['x', ' y', 'z '],
    ]);
  });

  test('a block that is not a cell is not asked about a space at its edge', () => {
    // R5-FMT-2: asking every block about its edge spaces (for the cells'
    // sake) pasted the space a pretty-printed `<li>first <code>x</code> </li>`
    // ends with, which Firefox's plain text writes whether it was drawn or
    // not. The auditor's Firefox copies.
    const typed = (html: string, plain: string): string[] =>
      blocksFromHtml(document, html, { plain }).map((block) => `${block.type}:${blockText(block)}`);

    expect(
      typed(
        '<p id="first">before</p><ul><li><a href="https://x.test/">Link</a> </li><li>text <b>bold</b> </li><li>plain end </li><li><span>sp</span> </li></ul><p id="last">after</p>',
        'before\n\n    Link\n    text bold\n    plain end\n    sp \n\nafter',
      ),
    ).toEqual([
      'paragraph:before',
      'bulleted_list:Link',
      'bulleted_list:text bold',
      'bulleted_list:plain end',
      'bulleted_list:sp',
      'paragraph:after',
    ]);
    expect(
      typed(
        '<p id="first">before</p><ol><li>first <code>x</code> </li></ol><p id="last">after</p>',
        'before\n\n    first x \n\nafter',
      ),
    ).toEqual(['paragraph:before', 'numbered_list:first x', 'paragraph:after']);
    expect(
      typed(
        '<p id="first">before</p><p>text <span>x</span> </p><h2>Title <small>v1</small> </h2><blockquote>q <i>i</i> </blockquote><p id="last">after</p>',
        'before\n\ntext x\nTitle v1\n\n    q i \n\nafter',
      ),
    ).toEqual([
      'paragraph:before',
      'paragraph:text x',
      'heading2:Title v1',
      'quote:q i',
      'paragraph:after',
    ]);
  });

  test("a block's own edge spaces stand where the plain text has them", () => {
    // The indentation of the line a block starts, and what ends its last
    // line, are the block's when the plain text holds exactly them there.
    expect(
      read(
        '<div id="s"><p>one</p><div class="pw">  indented  x</div><p class="pw">tail  </p><p>next</p></div>',
        'one\n  indented  x\ntail  \n\nnext',
      ),
    ).toEqual(['one', '  indented  x', 'tail  ', 'next']);
  });

  test('a block read with no choice to make still moves the cursor on', () => {
    // A code block's text is its own, but the paragraph after it with the
    // same characters must be matched past it, not at it, or it takes the
    // code's single space for its own double one.
    expect(read('<div id="s"><pre>x y</pre><p class="pw">x  y</p></div>', 'x y\n\nx  y')).toEqual([
      'x y',
      'x  y',
    ]);
  });

  test('a list item is matched past the indentation Firefox writes for it', () => {
    expect(
      read(
        '<div id="s"><ul><li class="pw">one  two</li><li>three\n  four</li></ul></div>',
        '    one  two\n    three four',
      ),
    ).toEqual(['one  two', 'three four']);
  });
});

describe('code is collapsed unless something says it is drawn otherwise', () => {
  // R3-FMT-1: a browser's default for `code`, `kbd` and `samp` is
  // `white-space: normal`, so a page paragraph's source-wrapped
  // `<code>npm\n      install</code>` is drawn on one line -- and Firefox
  // pastes it with the plain text that says so. Only `<pre>` and
  // `<textarea>` preserve by default; a stylesheet's pre-wrap code is told
  // apart by the plain text, like any other element.
  test("the auditor's paragraph, with Firefox's plain text", () => {
    expect(
      blocksFromHtml(
        document,
        '<div id="s"><p>Run <code>npm\n      install</code> now, then <code>a  b</code>.</p></div>',
        { plain: 'Run npm install now, then a b.' },
      ).map((block) => block.content),
    ).toEqual([
      [
        { text: 'Run ' },
        { text: 'npm install', marks: ['code'] },
        { text: ' now, then ' },
        { text: 'a b', marks: ['code'] },
        { text: '.' },
      ],
    ]);
  });

  test.each(['kbd', 'samp'])('<%s> too', (tag) => {
    expect(
      blocksFromHtml(document, `<p>Press <${tag}>Ctrl\n   C</${tag}> to copy.</p>`, {
        plain: 'Press Ctrl C to copy.',
      }).map(blockText),
    ).toEqual(['Press Ctrl C to copy.']);
  });

  test('code a stylesheet preserves keeps its spaces when the plain text shows them', () => {
    expect(
      blocksFromHtml(
        document,
        '<p>Run <code>npm\n      install</code> now, then <code>a  b</code>.</p>',
        { plain: 'Run npm\n      install now, then a  b.' },
      ).map(blockText),
    ).toEqual(['Run npm\n      install now, then a  b.']);
  });

  test('<pre> still preserves with nothing to say so', () => {
    expect(blocksFromHtml(document, '<pre>a  b\n  c</pre>').map(blockText)).toEqual(['a  b\n  c']);
  });
});

describe('a block-level element styled by class is decided by the plain text', () => {
  // R3-FMT-3: the plain-text check ran only for paragraphs, headings, quotes
  // and list items, so the commonest pre-wrap of all -- a chat message or a
  // comment, a `<div class>` -- still collapsed in Firefox.
  test("the auditor's chat", () => {
    expect(
      blocksFromHtml(
        document,
        '<div id="s"><div class="msg"><b>Ann</b><div class="pw">first line\nsecond  line</div></div><div class="msg"><b>Bob</b><div class="pw">ok\n\nthanks</div></div></div>',
        { plain: 'Ann\nfirst line\nsecond  line\nBob\nok\n\nthanks' },
      ).map(blockText),
    ).toEqual(['Ann', 'first line\nsecond  line', 'Bob', 'ok\n\nthanks']);
  });

  test.each(['div', 'section', 'article'])('<%s class="pw">', (tag) => {
    expect(
      blocksFromHtml(document, `<${tag} class="pw">first line\nsecond  line</${tag}>`, {
        plain: 'first line\nsecond  line',
      }).map(blockText),
    ).toEqual(['first line\nsecond  line']);
  });

  test('<dd class="pw">', () => {
    expect(
      blocksFromHtml(document, '<dl><dt>k</dt><dd class="pw">first line\nsecond  line</dd></dl>', {
        plain: 'k\nfirst line\nsecond  line',
      }).map(blockText),
    ).toEqual(['k', 'first line\nsecond  line']);
  });

  test('a source-wrapped <div> still collapses', () => {
    expect(
      blocksFromHtml(document, '<div>first line\n    second  line</div>', {
        plain: 'first line second line',
      }).map(blockText),
    ).toEqual(['first line second line']);
  });
});

describe('a lone converted space is an ordinary space', () => {
  // R3-FMT-2: WebKit writes a space it did not draw -- the last of a line, the
  // last of a block -- as a no-break space in `Apple-converted-space`. Every
  // one was kept, so these arrived with trailing spaces and exported as
  // `&#32;`. Only a run of them, or one beside another space, is drawn.
  const style = 'font-size: medium; white-space: normal; color: rgb(0, 0, 0);';

  test("the auditor's line ends and heading", () => {
    expect(
      blocksFromHtml(
        document,
        `<head><meta charset="UTF-8"></head><p style="${style}">line one<span class="Apple-converted-space">\u00a0</span><br>line two<span class="Apple-converted-space">\u00a0</span></p><h2 style="${style}">Title<span class="Apple-converted-space">\u00a0</span></h2><p style="${style}">x</p>`,
      ).map(blockText),
    ).toEqual(['line one\nline two', 'Title', 'x']);
  });

  test('at the end of bold, and between words', () => {
    expect(
      blocksFromHtml(
        document,
        `<p style="${style}">a<span class="Apple-converted-space">\u00a0</span><b>bold<span class="Apple-converted-space">\u00a0</span></b></p><p style="${style}">y</p>`,
      ).map((block) => block.content),
    ).toEqual([[{ text: 'a ' }, { text: 'bold', marks: ['bold'] }], [{ text: 'y' }]]);
  });

  test('in a table cell', () => {
    expect(
      blocksFromHtml(
        document,
        '<table><tbody><tr><td>cell<span class="Apple-converted-space">\u00a0</span></td><td>two</td></tr></tbody></table>',
      )[0]?.rows,
    ).toEqual([[[{ text: 'cell' }], [{ text: 'two' }]]]);
  });

  test('beside a typed space it is the second space', () => {
    expect(
      blocksFromHtml(document, '<p>x <span class="Apple-converted-space">\u00a0</span>y</p>').map(
        blockText,
      ),
    ).toEqual(['x  y']);
  });

  // R9-RV-FMT-4: a drag begun after `Sentence.` in `Sentence.  Next words`
  // selects the drawn space, and WebKit writes it as a lone converted space
  // at the copy's very start. Read as one, it was a space that starts a line
  // and collapsed, though a space at the paste's edge stays -- and stays from
  // Chromium's copy of the same drag. The real copies, by a mouse drag.
  const webkit =
    'color: rgb(17, 17, 17); font-family: system-ui, sans-serif; font-size: medium; font-style: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; white-space: normal; widows: 2; word-spacing: 0px; -webkit-tap-highlight-color: rgba(0, 0, 0, 0.4); -webkit-text-stroke-width: 0px; background-color: rgb(255, 255, 255); text-decoration: none;';
  const chromium =
    'color: rgb(17, 17, 17); font-family: system-ui, sans-serif; font-size: medium; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;';

  test.each([
    [
      'WebKit',
      `<!DOCTYPE html><head></head><p id="a" style="${webkit}"><span class="Apple-converted-space">\u00a0</span>Next words</p><p id="b" style="${webkit}">Second</p>`,
    ],
    [
      'Chromium',
      `<p id="a" style="${chromium}"><span>\u00a0</span>Next words</p><p id="b" style="${chromium}">Second</p>`,
    ],
  ])('%s: the space a drag began at, at the start of a copy, stays', (_engine, html) => {
    const blocks = blocksFromHtml(document, html, { plain: ' Next words\n\nSecond' });

    expect(blocks.map(blockText).map((text) => text.replace(/\u00a0/g, ' '))).toEqual([
      ' Next words',
      'Second',
    ]);
  });

  test('anywhere but the start of a copy a lone one still starts its line unseen', () => {
    expect(
      blocksFromHtml(
        document,
        `<p style="${style}">before</p><p style="${style}"><span class="Apple-converted-space">\u00a0</span>after</p>`,
      ).map(blockText),
    ).toEqual(['before', 'after']);
  });
});

describe('a Word list paragraph is an item only when Word numbered it', () => {
  // R3-FMT-6: Word writes "List Paragraph" style without numbering as a bare
  // `MsoListParagraph` with no `mso-list`. That fell to the heuristic for
  // WebKit's sanitised lists, which took any first word for a marker.
  const head = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta name=Generator content="Microsoft Word 15"><style>p.MsoListParagraph, li.MsoListParagraph {margin-top:0in;margin-right:0in;margin-bottom:0in;margin-left:.5in;mso-add-space:auto;}</style></head><body lang=EN-US><!--StartFragment-->`;
  const tail = '<!--EndFragment--></body></html>';

  test("the auditor's raw Word paste", () => {
    expect(
      blocksFromHtml(
        document,
        `${head}<p class=MsoNormal>Steps for the rig:</p><p class=MsoListParagraphCxSpFirst>Caution:&nbsp; never touch the blade.</p><p class=MsoListParagraphCxSpLast>Results.&nbsp; The test passed.</p>${tail}`,
      ).map((block) => [block.type, blockText(block)]),
    ).toEqual([
      ['paragraph', 'Steps for the rig:'],
      ['paragraph', 'Caution:\u00a0 never touch the blade.'],
      ['paragraph', 'Results.\u00a0 The test passed.'],
    ]);
  });

  test("in Word's own HTML, a number typed by hand is text too", () => {
    // Word numbers an item with `mso-list`; without it, `1.` is what was typed.
    expect(
      blocksFromHtml(
        document,
        `${head}<p class=MsoListParagraph>1.&nbsp; Typed, not numbered.</p>${tail}`,
      ).map((block) => [block.type, blockText(block)]),
    ).toEqual([['paragraph', '1.\u00a0 Typed, not numbered.']]);
  });

  test.each([
    ['Caution:\u00a0 do not touch.'],
    ['Results.\u00a0 The test passed.'],
    ['Note\u00a0 this.'],
    ['Example:\u00a0 foo'],
  ])('sanitised, %j keeps its first word', (text) => {
    expect(
      blocksFromHtml(
        document,
        `<p class=MsoListParagraphCxSpMiddle style="margin-left: 0.5in;">${text}</p>`,
      ).map((block) => [block.type, blockText(block)]),
    ).toEqual([['paragraph', text]]);
  });
});

describe('Word numbers without a full stop, and picture bullets', () => {
  // R3-FMT-7.
  const item = (marker: string, text: string, level = 1): string =>
    `<p class=MsoListParagraphCxSpFirst style='margin-left:${0.5 * level}in;text-indent:-.25in;mso-list:l0 level${level} lfo1'><![if !supportLists]><span style='mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp; </span></span><![endif]>${text}</p>`;

  test("the auditor's 1 / 1.1 / 1.1.1 and a legal 1.01", () => {
    expect(
      blocksFromHtml(
        document,
        item('1', 'One') + item('1.1', 'One one', 2) + item('1.1.1', 'Deep', 3) + item('1.01', 'C'),
      ).map((block) => [block.type, block.depth, blockText(block)]),
    ).toEqual([
      ['numbered_list', 0, 'One'],
      ['numbered_list', 1, 'One one'],
      ['numbered_list', 2, 'Deep'],
      ['numbered_list', 0, 'C'],
    ]);
  });

  test('a picture bullet beside a real picture: the bullet is the marker, the picture an image', () => {
    expect(
      blocksFromHtml(
        document,
        `<p class=MsoListParagraph style='text-indent:-.25in;mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'><img src="https://a.test/b.gif" alt="*">&nbsp;&nbsp; </span>Item <img src="https://a.test/pic.png" alt="pic"> one</p>`,
      ).map((block) => [block.type, block.depth, block.src ?? blockText(block)]),
    ).toEqual([
      ['bulleted_list', 0, 'Item one'],
      ['image', 1, 'https://a.test/pic.png'],
    ]);
  });

  test('a picture bullet WebKit has sanitised is still a bullet', () => {
    // An https bullet, which `sanitizeImageUrl` keeps: a `file:///` one is
    // dropped as an image anyway, so it could not tell a bullet skipped as
    // the marker from one read as a picture (R4-FMT-5). With Word's 7pt
    // spacer after it, as WebKit delivers one (style shortened).
    expect(
      blocksFromHtml(
        document,
        '<p class=MsoListParagraph style="margin-left: 0.5in; text-indent: -0.25in;"><span><img width="12" height="12" src="https://a.test/clip_image001.gif" alt="*"><span style="font-size: 7pt; font-family: Times New Roman;">&nbsp; <span class="Apple-converted-space">&nbsp;</span></span></span>Item one</p><p class=MsoListParagraph style="margin-left: 0.5in; text-indent: -0.25in;"><span><img style="width: 9pt; height: 9pt;" src="https://a.test/clip_image001.gif" alt="*"><span style="font-size: 7pt;">&nbsp;&nbsp; </span></span>Item two</p>',
      ).map((block) => [block.type, block.depth, block.src ?? blockText(block)]),
    ).toEqual([
      ['bulleted_list', 0, 'Item one'],
      ['bulleted_list', 0, 'Item two'],
    ]);
  });

  test('a sanitised paragraph that starts with a full-size picture keeps it', () => {
    // R4-FMT-3: any picture first was a bullet, so a screenshot and its
    // caption became a bullet reading "Figure 1", the screenshot gone. A
    // bullet is bullet-sized; anything larger, or of no stated size, is
    // content.
    const read = (html: string): Array<[string, string]> =>
      blocksFromHtml(document, html).map((block) => [block.type, block.src ?? blockText(block)]);

    expect(
      read(
        '<p class=MsoListParagraph><img width=400 height=200 src="https://a.test/400/200" alt="screenshot">&nbsp;&nbsp;Figure 1</p>',
      ),
    ).toContainEqual(['image', 'https://a.test/400/200']);
    expect(
      read(
        '<p class="MsoListParagraph"><img src="https://x.test/shot.png" width=600>&nbsp;&nbsp;Figure 1: the dialog</p>',
      ),
    ).toContainEqual(['image', 'https://x.test/shot.png']);
    expect(
      read(
        '<p class="MsoListParagraph"><img src="https://x.test/shot.png" style="width: 3in">&nbsp;&nbsp;Figure 2</p>',
      ),
    ).toContainEqual(['image', 'https://x.test/shot.png']);
    expect(
      read(
        '<p class="MsoListParagraph"><img src="https://x.test/shot.png">&nbsp;&nbsp;Figure 3</p>',
      ),
    ).toContainEqual(['image', 'https://x.test/shot.png']);
    for (const html of [
      '<p class=MsoListParagraph><img width=400 height=200 src="https://a.test/400/200">&nbsp;&nbsp;Figure 1</p>',
    ]) {
      expect(read(html).map(([type]) => type)).not.toContain('bulleted_list');
    }
  });
});

describe("a sanitised Word marker is punctuated, or has Word's spacer after it", () => {
  // R4-FMT-4: a bare number was a marker in WebKit's sanitised Word HTML too,
  // so "2024   Annual results" became a numbered item reading "Annual
  // results"; and the characters that stand in for a Wingdings or Symbol
  // bullet (`o`, `v`, `q`, `n`, `*`, `-`, `§`, `Ø`, `ü`) ate the first
  // character of a paragraph with two spaces after it. Either is a marker only
  // with Word's spacer after it: the 7pt span WebKit keeps, as it delivered
  // the auditor's Word paste (style shortened).
  const read = (html: string): Array<[string, string]> =>
    blocksFromHtml(document, html).map((block) => [block.type, blockText(block)]);
  const item = (marker: string, text: string): string =>
    `<p class="MsoListParagraphCxSpMiddle" style="white-space: normal; margin-left: 36pt; text-indent: -18pt;"><span>${marker}<span style="font-style: normal; font-weight: normal; font-size: 7pt; line-height: normal; font-family: Times New Roman;">      <span class="Apple-converted-space"> </span></span></span>${text}<o:p></o:p></p>`;

  test("the auditor's year", () => {
    expect(
      read('<p class=MsoListParagraph>2024&nbsp;&nbsp;&nbsp; Annual results<o:p></o:p></p>'),
    ).toEqual([['paragraph', '2024\u00a0\u00a0\u00a0 Annual results']]);
    expect(read('<p class="MsoListParagraph">2024&nbsp;&nbsp; Annual results</p>')).toEqual([
      ['paragraph', '2024\u00a0\u00a0 Annual results'],
    ]);
  });

  test.each(['1', '1.1', '1.1.1', '1.01'])("%s with Word's spacer is a number", (marker) => {
    expect(read(item(marker, 'Item text'))).toEqual([['numbered_list', 'Item text']]);
  });

  test.each(['1.', '1.1.', '(2)', '10.2.3.'])('%s is a number either way', (marker) => {
    expect(
      read(
        `<p class="MsoListParagraph" style="margin-left:36.0pt;text-indent:-18pt">${marker}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Item text</p>`,
      ),
    ).toEqual([['numbered_list', 'Item text']]);
    expect(read(item(marker, 'Item text'))).toEqual([['numbered_list', 'Item text']]);
  });

  // R5-FMT-4: a letter or a roman numeral with its punctuation needed no
  // spacer, so an unnumbered List Paragraph lost its first word. Real Word
  // lists always carry the spacer (the auditor's WebKit paste of a Word
  // `a.` and `iv.` list did), so it is required for these too.
  test.each(['a.', 'a)', '(iv)', 'iv.', 'viii.'])("%s with Word's spacer is a number", (marker) => {
    expect(read(item(marker, 'Item text'))).toEqual([['numbered_list', 'Item text']]);
  });

  test.each([
    ['Yes.&nbsp; We agree.', 'Yes.  We agree.'],
    ['Dr.&nbsp; Smith said so.', 'Dr.  Smith said so.'],
    ['Mild.&nbsp; Then add salt.', 'Mild.  Then add salt.'],
    ['(c)&nbsp; 2024 Acme', '(c)  2024 Acme'],
    ['a)&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Item text', 'a)       Item text'],
  ])('an unnumbered List Paragraph %s keeps its first word', (html, text) => {
    // As WebKit delivered the auditor's paste: the class, the indent, and the
    // typed `&nbsp; ` (style shortened).
    expect(
      read(
        `<p class="MsoListParagraph" style="white-space: normal; margin-left: 36pt; text-indent: -18pt;">${html}<o:p></o:p></p>`,
      ),
    ).toEqual([['paragraph', text]]);
  });

  test('an icon a List Paragraph starts with, with no spacer after it, is a picture', () => {
    // The same paste's `uPic`: a 16px icon and two typed spaces. A picture
    // bullet carries Word's spacer as a lettered marker does.
    const blocks = blocksFromHtml(
      document,
      '<p class="MsoListParagraph" style="white-space: normal; margin-left: 36pt; text-indent: -18pt;"><img width="16" height="16" src="https://picsum.photos/16" alt="icon">&nbsp; Icon led note<o:p></o:p></p>',
    );

    expect(blocks.map((block) => block.type)).not.toContain('bulleted_list');
    expect(blocks.map((block) => block.src ?? blockText(block))).toContain(
      'https://picsum.photos/16',
    );
  });

  test.each(['o', 'v', 'q', 'n', '*', '-', '§', 'Ø', 'ü'])(
    "%s with Word's spacer is a bullet",
    (marker) => {
      expect(read(item(marker, 'Item text'))).toEqual([['bulleted_list', 'Item text']]);
    },
  );

  test("Word's spacer as Word writes it after a Wingdings bullet", () => {
    // `&nbsp; ` -- the very characters two typed spaces make.
    expect(
      read(
        '<p class="MsoListParagraph" style="margin-left: 108pt;"><span style="font-family: Wingdings;"><span>§<span style="font: 7.0pt &quot;Times New Roman&quot;">&nbsp; </span></span></span>Deeper</p>',
      ),
    ).toEqual([['bulleted_list', 'Deeper']]);
  });

  test.each(['·', '•'])('%s is a bullet either way', (marker) => {
    expect(
      read(
        `<p class="MsoListParagraph" style="margin-left:36.0pt;text-indent:-18pt">${marker}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Item text</p>`,
      ),
    ).toEqual([['bulleted_list', 'Item text']]);
  });

  test.each([
    ['o&nbsp;&nbsp;clock', 'o\u00a0\u00a0clock'],
    ['o&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; clock', 'o\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0 clock'],
    ['n&nbsp; times', 'n\u00a0 times'],
    ['§&nbsp; 12 applies', '§\u00a0 12 applies'],
    ['-&nbsp;&nbsp;5 degrees', '-\u00a0\u00a05 degrees'],
    ['7&nbsp;&nbsp; <span style="font-size: 7pt">days</span>', '7\u00a0\u00a0 days'],
  ])('%s keeps its first character', (html, text) => {
    expect(read(`<p class="MsoListParagraph">${html}</p>`)).toEqual([['paragraph', text]]);
  });

  test('a bare number in raw Word HTML is a number', () => {
    expect(
      read(
        `<p class=MsoListParagraphCxSpFirst style="margin-left:36.0pt;text-indent:-18.0pt;mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">2024<span style="font:7.0pt">&nbsp;&nbsp;&nbsp; </span></span>Annual results</p>`,
      ),
    ).toEqual([['numbered_list', 'Annual results']]);
  });
});

describe("a preserved block's last newline is taken only if its text ends in one", () => {
  // R4-FMT-1: the check found the last source text a block holds, and when
  // that was the formatting after a child block (`<p>abc</p>\n</td>`) -- text
  // the walk had already dropped -- it still took the block's last character,
  // which was a letter. These are the auditor's clipboards, Chromium's with
  // its computed style shortened to the declaration that matters.
  const pw = 'white-space: pre-wrap;';
  const cells = (blocks: Block[]): string[][] | undefined =>
    blocks
      .find((block) => block.type === 'table')
      ?.rows?.map((row) => row.map((cell) => richToPlainText(cell)));
  const items = (blocks: Block[]): Array<[string, number, string]> =>
    blocks.map((block) => [block.type, block.depth, blockText(block)]);

  test('a table in a pre-wrap div, as Chromium writes it', () => {
    expect(
      cells(
        blocksFromHtml(
          document,
          `<div style="${pw}"><table><tbody><tr><td><p>Name</p>\n</td><td><p>Value</p>\n</td></tr></tbody></table></div><p style="white-space: normal;">after</p>`,
        ),
      ),
    ).toEqual([['Name', 'Value']]);
  });

  test('the same table as Firefox writes it, with its plain text', () => {
    expect(
      cells(
        blocksFromHtml(
          document,
          '<div id="s"><div style="white-space:pre-wrap"><table>\n<tbody><tr>\n<td><p>Name</p>\n</td>\n<td><p>Value</p>\n</td>\n</tr>\n</tbody></table></div><p>after</p></div>',
          { plain: '\n\nName\n\n\n\t\n\nValue\n\n\n\nafter' },
        ),
      ),
    ).toEqual([['Name', 'Value']]);
  });

  test('a cell a stylesheet makes pre-wrap, its paragraph and a newline after it', () => {
    expect(
      cells(
        blocksFromHtml(
          document,
          `<table><tr><td style="${pw}"><p>abc</p>\n</td><td style="${pw}">def\n</td></tr></table>`,
        ),
      ),
    ).toEqual([['abc', 'def']]);
  });

  test('loose list items and a quote in a pre-wrap div', () => {
    expect(
      items(
        blocksFromHtml(
          document,
          `<ul style="${pw}"><li><p>alpha</p>\n</li>\n<li><p>beta</p>\n</li>\n</ul><span style="${pw} display: inline !important;">\n</span><blockquote style="${pw}"><p>quoted</p>\n</blockquote><p style="${pw}">after</p>`,
        ),
      ),
    ).toEqual([
      ['bulleted_list', 0, 'alpha'],
      ['bulleted_list', 0, 'beta'],
      ['quote', 0, 'quoted'],
      ['paragraph', 0, 'after'],
    ]);
  });

  test('an item whose nested list is followed by a newline', () => {
    expect(
      items(
        blocksFromHtml(
          document,
          '<ul><li style="white-space:pre-wrap">foo<ul><li>bar</li></ul>\n</li></ul>',
        ),
      ),
    ).toEqual([
      ['bulleted_list', 0, 'foo'],
      ['bulleted_list', 1, 'bar'],
    ]);
  });

  test("an item's own newline before its nested list still draws no line", () => {
    // Measured in Chromium, Firefox and WebKit: `foo\n` before a block child
    // is one line high, `foo\n\n` two. So the newline is still the end of the
    // text when a block follows it -- with or without formatting after that.
    expect(
      items(
        blocksFromHtml(
          document,
          `<div style="${pw}"><ul><li>foo\n<ul>\n<li>bar</li>\n</ul>\n</li>\n<li>baz</li>\n</ul></div>`,
        ),
      ),
    ).toEqual([
      ['bulleted_list', 0, 'foo'],
      ['bulleted_list', 1, 'bar'],
      ['bulleted_list', 0, 'baz'],
    ]);
    expect(
      blocksFromHtml(
        document,
        `<ul><li style="${pw}">foo\n<ul><li>bar</li></ul></li><li style="${pw}">two\n\n<ul><li>bar</li></ul></li></ul>`,
      )
        .filter((block) => block.depth === 0)
        .map(blockText),
    ).toEqual(['foo', 'two\n']);
  });
});

// Chromium and WebKit mark a selection that begins at the end of a line (a drag
// started just past the line above) with a `<br class="Apple-interchange-newline">`
// at the start of the copied fragment, and one that ends at a line's start with
// one at its end. It stands for the line break the selection crossed, outside
// what the reader selected: read as content, the paste opened with an empty line.
// Taken from a real Chromium copy (drag from the end of one paragraph across the
// next).
describe('an interchange newline at either edge of a copy is not content', () => {
  const read = (html: string) => blocksFromHtml(document, html).map((block) => blockText(block));

  test('at the start, before inline text', () => {
    expect(
      read(
        '<meta charset="utf-8"><br class="Apple-interchange-newline"><span style="color: rgb(17, 17, 17);">beta two</span>',
      ),
    ).toEqual(['beta two']);
  });

  test('at the start, before a block', () => {
    expect(read('<br class="Apple-interchange-newline"><p>beta two</p>')).toEqual(['beta two']);
  });

  test('at the end, after a block', () => {
    expect(read('<p>alpha one</p><br class="Apple-interchange-newline">')).toEqual(['alpha one']);
  });

  test('at the end, after inline text', () => {
    expect(read('<span>alpha one</span><br class="Apple-interchange-newline">')).toEqual([
      'alpha one',
    ]);
  });

  test('a break of that class inside the text is still a break', () => {
    expect(read('<p>one<br class="Apple-interchange-newline">two</p>')).toEqual(['one\ntwo']);
  });

  test('an ordinary leading break is not taken for it', () => {
    expect(read('<p><br>after a break</p>')).toEqual(['\nafter a break']);
  });

  // Firefox writes the block the selection left, emptied, and nothing for it
  // in its plain text (a real Firefox copy of the same drag).
  const readWith = (html: string, plain?: string) =>
    blocksFromHtml(document, html, plain === undefined ? {} : { plain }).map((block) =>
      blockText(block),
    );

  test("Firefox's emptied block at the start goes when its plain text has no line for it", () => {
    expect(readWith('<p id="s1"></p><p id="s2">beta two</p>', 'beta two')).toEqual(['beta two']);
  });

  test('and at the end', () => {
    expect(readWith('<p>alpha one</p><p></p>', 'alpha one')).toEqual(['alpha one']);
  });

  // The plain text is not asked: on a pretty-printed page Firefox's starts
  // with the source's own newlines (R5-FMT-3b). An empty block draws no line.
  test('an empty block at an edge goes whatever the plain text says', () => {
    expect(readWith('<p></p><p>beta two</p>', '\nbeta two')).toEqual(['beta two']);
    expect(readWith('<p></p><p>beta two</p>')).toEqual(['beta two']);
  });

  test('a block with a break in it is a line, and stays', () => {
    expect(readWith('<p><br></p><p>beta two</p>', '\nbeta two')).toEqual(['', 'beta two']);
  });

  test('one that declares its own white-space stays', () => {
    expect(readWith('<p style="white-space: pre-wrap"></p><p>beta two</p>')).toEqual([
      '',
      'beta two',
    ]);
  });

  test("this editor's HTML from before its writer marked every block keeps its empty lines", () => {
    // Recognised by its `data-neditor-*` marks, or asked for: an empty
    // paragraph there is one the writer wrote, with no `white-space` to say so.
    const legacy = '<p></p><p data-neditor-depth="0">x</p><p></p>';

    expect(readWith(legacy)).toEqual(['', 'x', '']);
    expect(
      blocksFromHtml(document, '<p></p><p>x</p>', { whitespace: 'preserve' }).map(blockText),
    ).toEqual(['', 'x']);
  });

  test('a fragment of nothing but empty blocks is kept', () => {
    expect(readWith('<p></p>')).toEqual(['']);
    expect(readWith('<p></p><p></p>', '\n')).toEqual(['', '']);
  });

  test("this editor's own empty paragraph is a line the reader copied", () => {
    const source: Block[] = [
      { id: 'a', type: 'paragraph', depth: 0, content: [] },
      { id: 'b', type: 'paragraph', depth: 0, content: [{ text: 'x' }] },
      { id: 'c', type: 'paragraph', depth: 0, content: [] },
    ];

    expect(readWith(blocksToHtml(document, source), 'x')).toEqual(['', 'x', '']);
  });
});

describe('the line break a selection crossed is not content, wherever the browser writes it', () => {
  // R5-FMT-3. The payloads are the auditor's, copied by a real mouse drag in
  // each engine (Chromium's and WebKit's computed `style` shortened to the
  // `white-space` they declare, which is what the reader asks of it).
  const read = (html: string, plain?: string) =>
    blocksFromHtml(document, html, plain === undefined ? {} : { plain }).map(
      (block) => `${block.type}:${blockText(block)}`,
    );
  const normal = 'color: rgb(17, 17, 17); font-size: medium; white-space: normal;';

  test('Chromium: inside the first block, when the drag reaches a second (a)', () => {
    expect(
      read(
        `<p id="s2" style="${normal}"><br class="Apple-interchange-newline">beta two</p><p id="s3" style="${normal}">gam</p>`,
        '\nbeta two\n\ngam',
      ),
    ).toEqual(['paragraph:beta two', 'paragraph:gam']);
  });

  test('Chromium and WebKit: inside a list item (a)', () => {
    expect(
      read(
        `<ul style="${normal}"><li id="s2"><br class="Apple-interchange-newline">beta two</li></ul>`,
        '\nbeta two',
      ),
    ).toEqual(['bulleted_list:beta two']);
    expect(
      read(
        `<!DOCTYPE html><ul style="${normal}"><li><p id="s2"><br class="Apple-interchange-newline">para li two</p></li><li><p id="s3">par</p></li></ul>`,
        '\npara li two\n\npar',
      ),
    ).toEqual(['bulleted_list:para li two', 'bulleted_list:par']);
  });

  test('Chromium and WebKit: inside the link a block starts with (a)', () => {
    expect(
      read(
        `<a href="https://x.test/" style="${normal}"><br class="Apple-interchange-newline">beta</a><span style="${normal}"> two</span>`,
        '\nbeta two',
      ),
    ).toEqual(['paragraph:beta two']);
    expect(
      read(
        `<!DOCTYPE html><head><meta charset="UTF-8"></head><a href="https://x.test/" style="${normal}"><br class="Apple-interchange-newline">beta</a><span style="${normal}"><span class="Apple-converted-space"> </span>two</span>`,
        '\nbeta two',
      ),
    ).toEqual(['paragraph:beta two']);
  });

  test('Chromium: a drag from the end of a line across an empty one keeps the empty one', () => {
    expect(
      read(
        `<p id="e1" style="${normal}"><br class="Apple-interchange-newline"><br></p><p id="s2" style="${normal}">beta</p>`,
        '\n\n\nbeta',
      ),
    ).toEqual(['paragraph:', 'paragraph:beta']);
  });

  test('Chromium and WebKit: the item a drag ended at the start of, inside its list', () => {
    expect(
      read(
        `<ul style="${normal}"><li><p id="s2">para li two</p></li><li></li></ul><br class="Apple-interchange-newline">`,
        'para li two\n\n',
      ),
    ).toEqual(['bulleted_list:para li two']);
    expect(
      read(
        `<!DOCTYPE html><ul style="${normal}"><li><li><p id="s2">para li two</p></li><li></p></li></ul><br class="Apple-interchange-newline">`,
        'para li two\n\n',
      ),
    ).toEqual(['bulleted_list:para li two']);
  });

  test('Firefox on a pretty-printed page, whose plain text starts with newlines (b)', () => {
    expect(
      read('<p id="s1"></p>\n    <p id="s2">\n      beta two\n    </p>', '\n\nbeta two '),
    ).toEqual(['paragraph:beta two']);
    expect(read('<li id="s1"></li>\n  <li id="s2">\n    beta two\n  </li>', '\nbeta two ')).toEqual(
      ['bulleted_list:beta two'],
    );
  });

  test('Firefox: a drag ended at the start of the line below (c)', () => {
    expect(read('<p id="s2">beta two</p><p id="s3"></p>', 'beta two\n\n')).toEqual([
      'paragraph:beta two',
    ]);
    expect(read('<p id="s2">beta two</p><h3 id="s3"></h3>', 'beta two\n')).toEqual([
      'paragraph:beta two',
    ]);
    expect(read('<li id="s2">beta two</li><li id="s3"></li>', 'beta two\n')).toEqual([
      'bulleted_list:beta two',
    ]);
  });

  test('Firefox: from the end of a line whose next line is empty (d)', () => {
    expect(read('<p id="s1"></p><p id="e1"><br></p><p id="s2">beta</p>', '\nbeta')).toEqual([
      'paragraph:',
      'paragraph:beta',
    ]);
  });

  test('Firefox: an emptied block inside the item it was in', () => {
    expect(
      read('<li><p id="s1"></p></li><li><p id="s2">para li two</p></li>', 'para li two'),
    ).toEqual(['bulleted_list:para li two']);
  });

  test("this editor's own copy, sanitised cross-origin by WebKit (e)", () => {
    // The empty list items either side of `mid` arrive as interchange breaks,
    // the first inside the item it was sanitised into.
    const pre = 'font-size: medium; white-space: pre-wrap;';

    expect(
      read(
        `<li style="${pre}"><br class="Apple-interchange-newline">mid</li><br class="Apple-interchange-newline" style="color: rgb(0, 0, 0); white-space: normal;"><br class="Apple-interchange-newline">`,
        '-\n\n- mid\n\n-',
      ),
    ).toEqual(['bulleted_list:mid']);
  });
});

describe("a code block's last vertical tab or form feed adds no line", () => {
  // R5-FMT-5: R4-FMT-6c taught every other block that a vertical tab or form
  // feed ending its text ends its last line, as a newline there does; a code
  // block still read `<pre>a\v</pre>` as `a\n`, while `<pre>code\n</pre>`
  // read `code`. The auditor's cases.
  const code = (html: string): string[] =>
    blocksFromHtml(document, html).map((block) => `${block.type}:${blockText(block)}`);

  test.each([
    ['<pre><code>a\u000b</code></pre>', 'code:a'],
    ['<pre><code>a\fb\f</code></pre>', 'code:a\nb'],
    ['<pre>a\u000b</pre>', 'code:a'],
    ['<pre>code\n</pre>', 'code:code'],
    ['<pre>a\u000b\u000b</pre>', 'code:a\n'],
    ['<pre>a&#13;</pre>', 'code:a'],
    ['<pre>a\u000bb</pre>', 'code:a\nb'],
  ])('%j reads %j', (html, expected) => {
    expect(code(html)).toEqual([expected]);
  });
});

describe('a block emptied by a selection is empty whatever inline markup it kept', () => {
  // R6-FMT-1: Firefox writes the block a selection left with the inline
  // elements it held still in it, or with the source's indentation, and only
  // a bare `<p></p>` was recognised -- so a paste mid-block split the
  // paragraph, and the reader's own text was retyped as a heading or a code
  // block. The auditor's Firefox copies, by a real mouse drag.
  const read = (html: string, plain?: string) =>
    blocksFromHtml(document, html, plain === undefined ? {} : { plain }).map(
      (block) => `${block.type}:${blockText(block)}`,
    );

  test.each([
    // From the end of a paragraph that ends in a link.
    [
      '<p id="s1"><a href="https://x.test/"></a></p>\n<p id="s2">Install </p>',
      '\n\nInstall ',
      ['paragraph:Install '],
    ],
    // To the start of a heading.
    [
      '<p id="s2"> restart.</p>\n<h2 id="s3"><span></span></h2>',
      ' restart.\n',
      ['paragraph: restart.'],
    ],
    // To the start of a code block.
    [
      '<h2 id="s3"><span>Configuration</span></h2>\n<pre id="s4"></pre>',
      'Configuration\n\n',
      ['heading2:Configuration'],
    ],
    ['<p id="s1"><span></span></p><p id="s2"><span>beta</span></p>', 'beta', ['paragraph:beta']],
    ['<p id="s1"><b></b></p><p id="s2"><b>beta</b></p>', 'beta', ['paragraph:beta']],
    [
      '<p id="s1"><b>one</b></p><p id="s2">beta <i>two</i></p><p id="s3"><i></i></p>',
      'one\n\nbeta two\n\n',
      ['paragraph:one', 'paragraph:beta two'],
    ],
    [
      '<li id="s1"><span>one</span></li><li id="s2"><span>beta two</span></li><li id="s3"><span></span></li>',
      'one\nbeta two\n',
      ['bulleted_list:one', 'bulleted_list:beta two'],
    ],
    [
      '<blockquote id="s1"><span></span></blockquote><blockquote id="s2"><span>beta</span></blockquote>',
      '    beta',
      ['quote:beta'],
    ],
    [
      '<div id="s1"><span style="font-size:14px"></span></div><div id="s2"><span style="font-size:14px">beta</span></div>',
      'beta',
      ['paragraph:beta'],
    ],
    [
      '<h2 id="s1"><span>one</span></h2><p id="s2">beta two</p><h2 id="s3"><span></span></h2>',
      'one\n\nbeta two\n',
      ['heading2:one', 'paragraph:beta two'],
    ],
    // Pretty-printed: the emptied block keeps the source's indentation.
    [
      '<p id="s1"><span></span>\n  </p>\n  <p id="s2">\n    <span>beta</span></p>',
      '\n\nbeta',
      ['paragraph:beta'],
    ],
    ['<p id="s1">a one\n  </p>\n  <p id="s2">\n    </p>', 'a one\n\n', ['paragraph:a one']],
  ])('%j reads %j', (html, plain, expected) => {
    expect(read(html, plain)).toEqual(expected);
  });

  // What R5-FMT-3 kept is kept: a line somebody drew, and what draws without
  // text -- a picture, a control, preserved whitespace.
  test.each([
    ['<p><b><br></b></p><p>beta</p>', ['paragraph:', 'paragraph:beta']],
    ['<p><span style="white-space:pre"> </span></p><p>beta</p>', ['paragraph: ', 'paragraph:beta']],
    ['<pre> </pre><p>beta</p>', ['code: ', 'paragraph:beta']],
    ['<p>&nbsp;</p><p>beta</p>', ['paragraph: ', 'paragraph:beta']],
    [
      '<p style="white-space: pre-wrap"><span></span></p><p>beta</p>',
      ['paragraph:', 'paragraph:beta'],
    ],
    ['<p>beta</p><p><span><input type="checkbox"></span></p>', ['paragraph:beta', 'paragraph:']],
    [
      '<p><a href="https://x.test/"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="x"></a></p><p>beta</p>',
      ['image:', 'paragraph:beta'],
    ],
  ])('%j keeps its edge: %j', (html, expected) => {
    expect(read(html)).toEqual(expected);
  });

  test('a copy of nothing but emptied blocks is kept', () => {
    expect(read('<p><span></span></p>')).toEqual(['paragraph:']);
    expect(read('<p><b></b></p><h2><span></span></h2>', '\n')).toEqual(['paragraph:', 'heading2:']);
    expect(read('<pre></pre>')).toEqual(['code:']);
  });
});

describe('an emptied `<details>` at a copy edge is dropped with what it held', () => {
  // R7-FMT-1: `<details>` and `<summary>` were not edge blocks, so the walk
  // down the edge took the emptied `<p>` out of a `<details>` and left the
  // `<details>` -- read as a toggle, it split the reader's paragraph or
  // turned their text into a collapsed toggle. The auditor's copies, by a
  // real mouse drag.
  const read = (html: string, plain?: string) =>
    blocksFromHtml(document, html, plain === undefined ? {} : { plain }).map(
      (block) => `${block.type}:${blockText(block)}`,
    );

  test.each([
    // Firefox, begun past the end of a paragraph in an open `<details>`.
    ['<details open=""><p id="s1"></p></details><p id="s2">beta</p>', 'beta', ['paragraph:beta']],
    // Firefox, begun past the end of a closed `<details>`'s summary.
    [
      '<details><summary id="s1"></summary><p></p></details><p id="s2">beta</p>',
      'beta',
      ['paragraph:beta'],
    ],
    // Firefox, begun past the end of an open `<details>`'s summary: the
    // summary alone, out of its `<details>` -- read as nothing already, and
    // pinned because Firefox writes it.
    ['<summary id="s1"></summary><p id="s2">beta</p>', 'beta', ['paragraph:beta']],
    // Firefox, begun past the end of loose text in an open `<details>`.
    [
      '<details open=""><span id="s1"></span></details><p id="s2">beta</p>',
      'beta',
      ['paragraph:beta'],
    ],
    // Firefox, ended at the start of a closed `<details>`'s summary.
    [
      '<p id="s0">one</p><details><summary id="s1"></summary></details>',
      'one\n',
      ['paragraph:one'],
    ],
    // WebKit, the same drag: the `<summary>` is closed, never opened.
    [
      '<!DOCTYPE html><p id="s0">one</p><details></summary><br class="Apple-interchange-newline">',
      'one\n\n',
      ['paragraph:one'],
    ],
    // WebKit, begun past the end of a closed `<details>`'s summary: the
    // crossed break inside the emptied body of the `<details>`, which WebKit
    // writes with its computed style -- `white-space: normal` -- and its
    // content slot.
    [
      '<!DOCTYPE html><details style="color: rgb(17, 17, 17); font-family: system-ui, sans-serif; font-size: medium; font-style: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; white-space: normal; widows: 2; word-spacing: 0px; -webkit-tap-highlight-color: rgba(0, 0, 0, 0.4); -webkit-text-stroke-width: 0px; background-color: rgb(255, 255, 255); text-decoration: none;"><span useragentpart="details-content" style="display: block; content-visibility: hidden;"><p><br class="Apple-interchange-newline"></p></span></details><p id="s2" style="color: rgb(17, 17, 17); font-family: system-ui, sans-serif; font-size: medium; font-style: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; white-space: normal; widows: 2; word-spacing: 0px; -webkit-tap-highlight-color: rgba(0, 0, 0, 0.4); -webkit-text-stroke-width: 0px; background-color: rgb(255, 255, 255); text-decoration: none;">beta</p>',
      '\nbeta',
      ['paragraph:beta'],
    ],
  ])('%j reads %j', (html, plain, expected) => {
    expect(read(html, plain)).toEqual(expected);
  });

  test('what the edge rule keeps is kept', () => {
    // What held the crossed break and something else.
    expect(
      read(
        '<blockquote style="white-space: normal"><p><br class="Apple-interchange-newline"></p><p>beta</p></blockquote><p>gamma</p>',
      ),
    ).toEqual(['quote:beta', 'paragraph:gamma']);
    // A cell that held it: the walk never goes into a table.
    expect(
      blocksFromHtml(
        document,
        '<table><tr><td style="white-space: normal"><br class="Apple-interchange-newline"></td><td>b</td></tr></table>',
      ).map((block) => block.rows?.map((row) => row.map(richToPlainText))),
    ).toEqual([[['', 'b']]]);
    // The `<details>` the drag reached into, with its summary.
    expect(
      read(
        '<p id="s0">one</p><details open=""><summary>Summary line</summary><p id="s1"></p></details>',
        'one\nSummary line\n\n',
      ),
    ).toEqual(['paragraph:one', 'toggle:Summary line']);
    // A block that declares its white-space, and one with a line in it.
    expect(
      read('<details style="white-space: pre-wrap"><p></p></details><p>beta</p>', 'beta').at(-1),
    ).toBe('paragraph:beta');
    expect(
      read('<details style="white-space: pre-wrap"><p></p></details><p>beta</p>'),
    ).toHaveLength(2);
    // Its line kept -- read as the body it is, since the `<details>` starts
    // the copy without its summary (R8-FMT-1).
    expect(read('<details open><p><br></p></details><p>beta</p>')).toEqual([
      'paragraph:',
      'paragraph:beta',
    ]);
    // A copy of nothing else, and ProseMirror's closed slice.
    expect(read('<details><summary></summary></details>')).toEqual(['toggle:']);
    expect(
      read(
        '<meta charset=\'utf-8\'><details data-pm-slice="0 0 []"><summary></summary></details><p>mid</p>',
        '\nmid',
      ),
    ).toEqual(['toggle:', 'paragraph:mid']);
  });
});

describe('a leading space a stylesheet draws stands where the plain text has it', () => {
  // R6-FMT-2: R5-FMT-2 asked only a table cell about its edge spaces, so a
  // drawn leading space in a block a class makes `pre-wrap` collapsed. Firefox
  // writes no undrawn leading space (`<p> lead</p>` copies as `lead`) but at
  // a copy's very start (below), so the start edge is asked of every block;
  // the end only of a cell, since
  // Firefox writes an undrawn trailing one. The auditor's Firefox copy.
  const read = (html: string, plain: string) =>
    blocksFromHtml(document, html, { plain }).map((block) => `${block.type}:${blockText(block)}`);

  test('the verse', () => {
    expect(
      read(
        '<p id="s1" class="verse">First line</p><p class="verse"> second, set in</p><p id="s3" class="verse">third</p>',
        'First line\n\n second, set in\n\nthird',
      ),
    ).toEqual(['paragraph:First line', 'paragraph: second, set in', 'paragraph:third']);
  });

  test("a loose `<div>`'s text is a block like any other", () => {
    // The same probe's chat and doc-comment lines, `<div class>`s read as an
    // inline run rather than a block element's text (real Firefox copies).
    expect(
      read(
        '<div id="s1" class="msg">alice: hi</div><div class="msg"> indented reply</div><div class="msg">trailing space here </div><div id="s3" class="msg">bob: ok</div>',
        'alice: hi\n indented reply\ntrailing space here \nbob: ok',
      ),
    ).toEqual([
      'paragraph:alice: hi',
      'paragraph: indented reply',
      'paragraph:trailing space here',
      'paragraph:bob: ok',
    ]);
    expect(
      read(
        '<div id="s1" class="ln">/**</div><div class="ln"> * Adds two numbers.</div><div class="ln"> * @param a first</div><div class="ln"> */</div><div id="s3" class="ln">function add(a, b) {}</div>',
        '/**\n * Adds two numbers.\n * @param a first\n */\nfunction add(a, b) {}',
      ),
    ).toEqual([
      'paragraph:/**',
      'paragraph: * Adds two numbers.',
      'paragraph: * @param a first',
      'paragraph: */',
      'paragraph:function add(a, b) {}',
    ]);
    expect(
      read('<p id="s1">alpha</p><div> lead</div><p id="s3">omega</p>', 'alpha\nlead\n\nomega'),
    ).toEqual(['paragraph:alpha', 'paragraph:lead', 'paragraph:omega']);
    // Its end is not asked, as a paragraph's is not.
    expect(
      read(
        '<div id="s1" class="msg">alice: hi</div><div class="msg"> both ends </div><div id="s3" class="msg">bob: ok</div>',
        'alice: hi\n both ends \nbob: ok',
      ),
    ).toEqual(['paragraph:alice: hi', 'paragraph: both ends', 'paragraph:bob: ok']);
  });

  test("an undrawn one Firefox leaves out, or writes as a list's indentation, stays out", () => {
    // Real Firefox copies of each.
    expect(
      read('<p id="s1">alpha</p><p> lead</p><p id="s3">omega</p>', 'alpha\n\nlead\n\nomega'),
    ).toEqual(['paragraph:alpha', 'paragraph:lead', 'paragraph:omega']);
    expect(
      read(
        '<p id="s1">alpha</p><ul><li> <code>x</code></li><li> <b>y</b> z</li></ul><p id="s3">omega</p>',
        'alpha\n\n    x\n    y z\n\nomega',
      ),
    ).toEqual(['paragraph:alpha', 'bulleted_list:x', 'bulleted_list:y z', 'paragraph:omega']);
    expect(
      read(
        '<p id="s1">alpha</p><blockquote> q</blockquote><p id="s3">omega</p>',
        'alpha\n\n    q\n\nomega',
      ),
    ).toEqual(['paragraph:alpha', 'quote:q', 'paragraph:omega']);
  });

  test('at the very start of a copy the space is kept: a known limit (R9-FMT-3)', () => {
    // Real Firefox copies, by a mouse drag. Begun on the `H` of a block whose
    // source starts with two spaces, nothing drawn, Firefox writes the source
    // whole and its plain text with one space; begun after the period of
    // `Sentence.  Next`, the space drawn and selected, it writes the very
    // same bytes. The paste keeps the space for both: dropping it would
    // delete a character the second reader selected, to spare the first one
    // an extra space.
    for (const [html, plain] of [
      ['<p id="a">  Hello world</p><p id="b">Second</p>', ' Hello world\n\nSecond'],
      ['<p id="a">  Next words</p><p id="b">Second</p>', ' Next words\n\nSecond'],
    ] as const) {
      const [first] = blocksFromHtml(document, html, { plain });

      expect(blockText(first!)).toMatch(/^ \S/);
    }

    // A `pre-wrap` source writes the spaces it drew, and keeps them.
    expect(
      read('<p class="pw" id="a">  Hello world</p><p id="b">Second</p>', '  Hello world\n\nSecond'),
    ).toEqual(['paragraph:  Hello world', 'paragraph:Second']);
  });

  // R7-FMT-4: Firefox's plain text indents the lines of a list item, a `<dd>`
  // and a `<blockquote>` by four spaces for each `<ul>`, `<ol>`, `<dd>` and
  // `<blockquote>` around them -- measured, nested ones included -- so a
  // drawn leading space was no longer at the start of its line, the line
  // break in a pre-wrap quote no longer matched, and an undrawn lead of
  // exactly that width read as drawn. Exactly that indentation after each
  // line start of such a block is Firefox's. The auditor's and the fixer's
  // real Firefox copies, by a mouse drag from `start` to `end`.
  test.each([
    [
      '<p id="a">start</p><blockquote class="pw"> reply</blockquote><p id="b">end</p>',
      'start\n\n     reply\n\nend',
      ['paragraph:start', 'quote: reply', 'paragraph:end'],
    ],
    [
      '<p id="a">start</p><blockquote class="pw"><p> reply</p></blockquote><p id="b">end</p>',
      'start\n\n     reply\n\nend',
      ['paragraph:start', 'quote: reply', 'paragraph:end'],
    ],
    [
      '<p id="a">start</p><ul class="pw"><li> item one</li><li>  two lead</li></ul><p id="b">end</p>',
      'start\n\n     item one\n      two lead\n\nend',
      ['paragraph:start', 'bulleted_list: item one', 'bulleted_list:  two lead', 'paragraph:end'],
    ],
    [
      '<p id="a">start</p><dl class="pw"><dt>term</dt><dd> definition</dd></dl><p id="b">end</p>',
      'start\n\nterm\n     definition\n\nend',
      ['paragraph:start', 'paragraph:term', 'paragraph: definition', 'paragraph:end'],
    ],
    [
      '<p id="a">start</p><blockquote><ul class="pw"><li> li in q</li></ul></blockquote><p id="b">end</p>',
      'start\n\n         li in q\n\nend',
      ['paragraph:start', 'bulleted_list: li in q', 'paragraph:end'],
    ],
    [
      '<p id="a">start</p><dl><dd><dl><dd class="pw"> d2 lead</dd></dl></dd></dl><p id="b">end</p>',
      'start\n\n         d2 lead\n\nend',
      ['paragraph:start', 'paragraph: d2 lead', 'paragraph:end'],
    ],
    [
      '<p id="a">start</p><ul><li><p class="pw"> para lead</p></li></ul><p id="b">end</p>',
      'start\n\n     para lead\n\nend',
      ['paragraph:start', 'bulleted_list: para lead', 'paragraph:end'],
    ],
    // A line break in a pre-wrap block: each line is indented.
    [
      '<p id="a">start</p><blockquote class="pw">line one\nline two</blockquote><p id="b">end</p>',
      'start\n\n    line one\n    line two\n\nend',
      ['paragraph:start', 'quote:line one\nline two', 'paragraph:end'],
    ],
    [
      '<p id="a">start</p><ul class="pw"><li>line one\nline two</li></ul><p id="b">end</p>',
      'start\n\n    line one\n    line two\n\nend',
      ['paragraph:start', 'bulleted_list:line one\nline two', 'paragraph:end'],
    ],
    [
      '<p id="a">start</p><ol class="pw"><li> first</li><li>second\nline</li></ol><p id="b">end</p>',
      'start\n\n     first\n    second\n    line\n\nend',
      ['paragraph:start', 'numbered_list: first', 'numbered_list:second\nline', 'paragraph:end'],
    ],
    [
      '<p id="a">start</p><ul><li>top<ul class="pw"><li>line one\n  line two</li></ul></li></ul><p id="b">end</p>',
      'start\n\n    top\n        line one\n          line two\n\nend',
      [
        'paragraph:start',
        'bulleted_list:top',
        'bulleted_list:line one\n  line two',
        'paragraph:end',
      ],
    ],
    [
      '<p id="a">start</p><ul><li>item<blockquote class="pw"> q lead\nnext</blockquote></li></ul><p id="b">end</p>',
      'start\n\n    item\n\n         q lead\n        next\n\nend',
      ['paragraph:start', 'bulleted_list:item', 'quote: q lead\nnext', 'paragraph:end'],
    ],
    // An undrawn lead exactly as wide as the indentation is not drawn.
    [
      '<p id="a">start</p><ul><li>    li four</li></ul><dl><dd>    dd four</dd></dl><blockquote><p>  bq two</p></blockquote><p id="b">end</p>',
      'start\n\n    li four\n\n    dd four\n\n    bq two\n\nend',
      [
        'paragraph:start',
        'bulleted_list:li four',
        'paragraph:dd four',
        'quote:bq two',
        'paragraph:end',
      ],
    ],
  ])('in a list, a definition or a quote: %j', (html, plain, expected) => {
    expect(read(html, plain)).toEqual(expected);
  });

  test("a table's first cell after the indentation, the next after its tab", () => {
    expect(
      blocksFromHtml(
        document,
        '<p id="a">start</p><ul><li><table><tbody><tr><td class="pw"> c1</td><td class="pw"> c2</td></tr></tbody></table></li></ul><p id="b">end</p>',
        { plain: 'start\n\n     c1\t c2\n\nend' },
      )
        .find((block) => block.type === 'table')
        ?.rows?.map((row) => row.map(richToPlainText)),
    ).toEqual([[' c1', ' c2']]);
    // An empty first cell: the next is after the indentation and a tab.
    expect(
      blocksFromHtml(
        document,
        '<p id="a">start</p><ul><li><table><tbody><tr><td></td><td class="pw"> c2</td></tr></tbody></table></li></ul><p id="b">end</p>',
        { plain: 'start\n\n    \t c2\n\nend' },
      )
        .find((block) => block.type === 'table')
        ?.rows?.map((row) => row.map(richToPlainText)),
    ).toEqual([['', ' c2']]);
  });

  test('where the indentation is not there exactly, as before', () => {
    // A plain text without the indentation (constructed) decides as it did.
    expect(
      read(
        '<p id="a">start</p><ul class="pw"><li> item</li></ul><p id="b">end</p>',
        'start\n item\nend',
      ),
    ).toEqual(['paragraph:start', 'bulleted_list: item', 'paragraph:end']);
    expect(
      read(
        '<p id="a">start</p><blockquote class="pw">line one\nline two</blockquote><p id="b">end</p>',
        'start\nline one\nline two\nend',
      ),
    ).toEqual(['paragraph:start', 'quote:line one\nline two', 'paragraph:end']);
    // A `<menu>`'s item, or an `<li>` in no list, is not indented: the
    // spaces at the start of its line are its own (real Firefox copies).
    expect(
      read(
        '<p id="a">start</p><menu class="pw"><li> m one</li></menu><p id="b">end</p>',
        'start\n m one\n\nend',
      ),
    ).toEqual(['paragraph:start', 'bulleted_list: m one', 'paragraph:end']);
    expect(
      read(
        '<p id="a">start</p><menu class="pw"><li>    four</li></menu><p id="b">end</p>',
        'start\n    four\n\nend',
      ),
    ).toEqual(['paragraph:start', 'bulleted_list:    four', 'paragraph:end']);
    expect(
      read(
        '<p id="a">start</p><li class="pw">    four</li><p id="b">end</p>',
        'start\n    four\n\nend',
      ),
    ).toEqual(['paragraph:start', 'bulleted_list:    four', 'paragraph:end']);
  });

  test('indentation is read once per element, however deep the nesting', () => {
    // Each block's indentation is its parent's plus its own, remembered: a
    // walk to the root per block is the nesting depth times the blocks, and
    // inline wrappers nest as deep as the reader goes (a thousand levels).
    const depth = 1000;
    const count = 3000;
    const html = `<dd>${'<span>'.repeat(depth)}${Array.from({ length: count }, (_, i) => `<p class="pw"> p${i}</p>`).join('')}${'</span>'.repeat(depth)}</dd>`;
    const plain = Array.from({ length: count }, (_, i) => `     p${i}`).join('\n\n');

    expect(blocksFromHtml(document, html, { plain }).map(blockText).slice(0, 2)).toEqual([
      ' p0',
      ' p1',
    ]);
    const time = (options: { plain?: string }): number => {
      let best = Infinity;

      for (let run = 0; run < 3; run += 1) {
        const start = performance.now();
        blocksFromHtml(document, html, options);
        best = Math.min(best, performance.now() - start);
      }

      return Math.max(best, 0.1);
    };

    time({});
    expect(time({ plain }) / time({})).toBeLessThan(4);
  });

  test('the end edge is still asked of a cell only', () => {
    // R5-FMT-2's trailing space, with a drawn leading space beside it: the
    // trailing one stays out.
    expect(
      read(
        '<p id="first">before</p><p class="verse"> lead <span>x</span> </p><p id="last">after</p>',
        'before\n\n lead x \n\nafter',
      ),
    ).toEqual(['paragraph:before', 'paragraph: lead x', 'paragraph:after']);
  });
});

describe('a cell spelled differently costs the cells after it in its row nothing', () => {
  // R6-FMT-3: once one cell of a row was spelled differently in Firefox's
  // plain text (an image's alt text, a `<q>`), every later cell in that row
  // missed -- the cursor stayed before the text it did not match, and a cell
  // is only ever looked for at the cursor or a line start -- and was read
  // collapsed. A cell that misses is tried once more right after the next
  // tab on its row's line; a missed cell moves the row on past its own tab.
  const picture = '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="warning">';
  const cells = (html: string, plain: string): string[][] | undefined =>
    blocksFromHtml(document, html, { plain })
      .find((block) => block.type === 'table')
      ?.rows?.map((row) => row.map(richToPlainText));

  test("the auditor's row", () => {
    expect(
      cells(
        `<table><tbody><tr><td>${picture} force</td><td class="cmd">tool  --force   now</td></tr></tbody></table>`,
        'warning force\ttool  --force   now',
      ),
    ).toEqual([['force', 'tool  --force   now']]);
  });

  test('after a paragraph, past a quoted cell and an empty one', () => {
    expect(
      cells(
        `<p>intro</p><table><tbody><tr><td>${picture} north</td><td><q>b</q></td><td></td><td class="cmd">c  d</td></tr><tr><td>x</td><td><q>y</q></td><td class="cmd">e  f</td><td>g</td></tr></tbody></table><p>after</p>`,
        'intro\nwarning north\t“b”\t\tc  d\nx\t“y”\te  f\tg\n\nafter',
      ),
    ).toEqual([
      ['north', 'b', '', 'c  d'],
      ['x', 'y', 'e  f', 'g'],
    ]);
  });

  test('a row of many missed cells stays linear', () => {
    // Each cell misses at the cursor and is tried once more past one tab: the
    // row costs its length, not its length times its cells. Long cells, so
    // walking the line again for each one would dwarf reading the HTML.
    const count = 3000;
    const word = 'w'.repeat(200);
    const html = `<table><tbody><tr>${Array.from({ length: count }, (_, i) => `<td><q>${word}${i}</q></td>`).join('')}</tr></tbody></table>`;
    const plain = Array.from({ length: count }, (_, i) => `"${word}${i}"`).join('\t');
    const time = (options: { plain?: string }): number => {
      const start = performance.now();
      blocksFromHtml(document, html, options);
      return performance.now() - start;
    };

    time({});
    const without = Math.min(time({}), time({}));
    const withPlain = Math.min(time({ plain }), time({ plain }));

    expect(withPlain / without).toBeLessThan(4);
  });

  test('many rows against one long line without a tab stay linear', () => {
    // R7-FMT-3: every row whose first cell missed was placed at the same
    // point mid-line, and the walk to its next tab crossed the rest of the
    // line again -- rows times the line's length (4000 rows against an
    // 800,000-character JSON line took 3.1 s in Chromium). Measured against
    // reading the table and the plain text apart, which is what linear costs.
    // The auditor's line, and the same with a second line after it, where
    // every row is placed (its first cell missed mid-line, so it claims no
    // line of its own) and each looked for its tab across the whole line.
    const rows = 2000;
    const html = `<p>Export</p><table><tbody>${Array.from({ length: rows }, (_, i) => `<tr><td>r${i}</td><td>s${i}</td></tr>`).join('')}</tbody></table>`;
    const line = JSON.stringify({ data: 'y'.repeat(200_000) });
    const time = (source: string, options: { plain?: string }): number => {
      let best = Infinity;

      for (let run = 0; run < 3; run += 1) {
        const start = performance.now();
        blocksFromHtml(document, source, options);
        best = Math.min(best, performance.now() - start);
      }

      return Math.max(best, 0.1);
    };

    time(html, {});

    for (const plain of [`Export ${line}`, `Export ${line}\n${line}`]) {
      const apart = time(html, {}) + time('<p>Export</p>', { plain });
      const together = time(html, { plain });

      expect(together / apart).toBeLessThan(4);
    }
  });
});

describe('a row whose first cell is empty or missed is placed on its own line', () => {
  // R7-FMT-2: R6-FMT-3 walked a row's tabs from where its first cell was
  // found or looked for -- so a row whose first cell was empty or held only
  // a picture had no place at all, and a row after one whose last cell
  // missed was placed on that row's line, still mid-line. Either way every
  // later cell of the row lost its spaces. The auditor's Firefox copies, by
  // a real mouse drag; each row is placed at the start of the first line
  // after the last block matched.
  const gif = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  const picture = (alt: string) => `<img alt="${alt}" width="12" height="12" src="${gif}">`;
  const read = (html: string, plain: string) =>
    blocksFromHtml(document, html, { plain })
      .filter((block) => block.type !== 'image')
      .map((block) =>
        block.rows ? block.rows.map((row) => row.map(richToPlainText)) : blockText(block),
      );

  test('a picture alone in the first cell', () => {
    expect(
      read(
        `<p id="a">start</p><table><tbody><tr><th>Flag</th><th>Command</th></tr><tr><td>${picture('FR')}</td><td class="cmd">git  push   origin</td></tr><tr><td>${picture('DE')}</td><td class="cmd">git  pull</td></tr></tbody></table><p id="b">end</p>`,
        'start\nFlag\tCommand\nFR\tgit  push   origin\nDE\tgit  pull\n\nend',
      ),
    ).toEqual([
      'start',
      [
        ['Flag', 'Command'],
        ['', 'git  push   origin'],
        ['', 'git  pull'],
      ],
      'end',
    ]);
  });

  test('an empty first cell', () => {
    expect(
      read(
        `<p id="a">start</p><table><tbody><tr><td></td><td>${picture('yes')} ok</td><td class="cmd">tool  --force   now</td></tr></tbody></table><p id="b">end</p>`,
        'start\n\tyes ok\ttool  --force   now\n\nend',
      ),
    ).toEqual(['start', [['', 'ok', 'tool  --force   now']], 'end']);
  });

  test('a missed first cell after a row whose last cell missed', () => {
    expect(
      read(
        `<p id="a">start</p><table><tbody><tr><td class="cmd">npm  run</td><td>${picture('ok')} Passed</td></tr><tr><td>${picture('w')} two</td><td class="cmd">npm  test</td></tr></tbody></table><p id="b">end</p>`,
        'start\nnpm  run\tok Passed\nw two\tnpm  test\n\nend',
      ),
    ).toEqual([
      'start',
      [
        ['npm  run', 'Passed'],
        ['two', 'npm  test'],
      ],
      'end',
    ]);
  });

  test('a cell with the same text on a later line is not taken for one placed nowhere', () => {
    // Pre-existing and not changed: a row whose cells are all spelled as the
    // next row's is matched there (the auditor's `sameText`).
    expect(
      read(
        `<p id="a">start</p><table><tbody><tr><td>${picture('w')} x</td><td class="cmd">x  x</td></tr><tr><td>x</td><td class="cmd">x  x</td></tr></tbody></table><p id="b">end</p>`,
        'start\nw x\tx  x\nx\tx  x\n\nend',
      ),
    ).toEqual([
      'start',
      [
        ['x', 'x  x'],
        ['x', 'x x'],
      ],
      'end',
    ]);
  });

  test('many rows with an empty first cell stay linear', () => {
    // Each row is placed by a search, not a walk, so a long line of nothing
    // but spaces after each first tab costs nothing per row.
    const rows = 2000;
    const html = `<p>Export</p><table><tbody>${Array.from({ length: rows }, (_, i) => `<tr><td></td><td>s${i}</td></tr>`).join('')}</tbody></table>`;
    const plain = `Export\n\t${' '.repeat(200_000)}x`;
    const time = (source: string, options: { plain?: string }): number => {
      let best = Infinity;

      for (let run = 0; run < 3; run += 1) {
        const start = performance.now();
        blocksFromHtml(document, source, options);
        best = Math.min(best, performance.now() - start);
      }

      return Math.max(best, 0.1);
    };

    time(html, {});
    const apart = time(html, {}) + time('<p>Export</p>', { plain });
    const together = time(html, { plain });

    expect(together / apart).toBeLessThan(4);
  });
});

describe("ProseMirror's closed slice keeps the empty blocks at its closed ends", () => {
  // R6-FMT-4: a ProseMirror (Tiptap) select-all copy marks its first element
  // `data-pm-slice="0 0 []"` -- open depth 0 at both ends: the empty blocks
  // there are whole blocks the reader selected, not the edge of a drag. An
  // open slice (`1 1`) is the drag, and its empty edges still go.
  const read = (html: string, plain: string) =>
    blocksFromHtml(document, html, { plain }).map((block) => `${block.type}:${blockText(block)}`);
  const meta = "<meta charset='utf-8'>";

  test.each([
    [
      `${meta}<p data-pm-slice="0 0 []"></p><p>mid</p><p></p>`,
      '\n\nmid\n\n',
      ['paragraph:', 'paragraph:mid', 'paragraph:'],
    ],
    [
      `${meta}<ul data-pm-slice="0 0 []"><li>one</li><li></li></ul>`,
      'one\n',
      ['bulleted_list:one', 'bulleted_list:'],
    ],
    [
      `${meta}<p data-pm-slice="0 1 []"></p><p>mid</p><p></p>`,
      '\n\nmid\n\n',
      ['paragraph:', 'paragraph:mid'],
    ],
    [
      `${meta}<p data-pm-slice="1 0 []"></p><p>mid</p><p></p>`,
      '\n\nmid\n\n',
      ['paragraph:mid', 'paragraph:'],
    ],
    [`${meta}<p data-pm-slice="1 1 []">first</p><p></p>`, 'first\n\n', ['paragraph:first']],
    [`${meta}<p data-pm-slice="1 1 []"></p><p>second</p>`, '\n\nsecond', ['paragraph:second']],
    // Without the mark, as before.
    [`${meta}<ul><li>one</li><li></li></ul>`, 'one\n', ['bulleted_list:one']],
  ])('%j reads %j', (html, plain, expected) => {
    expect(read(html, plain)).toEqual(expected);
  });
});

describe('a `<details>` that opens a copy without its own summary is its body', () => {
  // R8-FMT-1, R8-FMT-2: a drag begun in a `<details>`' body leaves its
  // summary out, and the `<details>` at the copy's start read as a toggle
  // with an empty title -- the reader's paragraph split and indented, or an
  // empty toggle. WebKit writes the start tags of every closed `<details>` a
  // drag crosses at the front, so a whole FAQ pasted inside two empty
  // collapsed toggles. Each engine's real copy, by a mouse drag.
  const read = (html: string, plain?: string) =>
    blocksFromHtml(document, html, plain === undefined ? {} : { plain }).map(
      (block) => `${block.type}@${block.depth}${block.collapsed ? '(c)' : ''}:${blockText(block)}`,
    );
  const chromium =
    'color: rgb(17, 17, 17); font-family: system-ui, sans-serif; font-size: medium; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; background-color: rgb(255, 255, 255); text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;';
  const webkit =
    'color: rgb(17, 17, 17); font-family: system-ui, sans-serif; font-size: medium; font-style: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; white-space: normal; widows: 2; word-spacing: 0px; -webkit-tap-highlight-color: rgba(0, 0, 0, 0.4); -webkit-text-stroke-width: 0px; background-color: rgb(255, 255, 255); text-decoration: none;';
  const webkitH3 =
    'color: rgb(17, 17, 17); font-family: system-ui, sans-serif; font-style: normal; font-variant-caps: normal; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; white-space: normal; widows: 2; word-spacing: 0px; -webkit-tap-highlight-color: rgba(0, 0, 0, 0.4); -webkit-text-stroke-width: 0px; background-color: rgb(255, 255, 255); text-decoration: none;';
  const answers = ['paragraph@0:Answer one', 'paragraph@0:Answer more', 'paragraph@0:Outro text'];

  test.each([
    [
      'Firefox',
      '<details open=""><p id="a1">Answer one</p><p id="a1b">Answer more</p></details><p id="o">Outro text</p>',
    ],
    [
      'Chromium',
      `<details open="" style="${chromium}"><slot id="details-content" pseudo="details-content" style="display: block;"><p id="a1">Answer one</p><p id="a1b">Answer more</p></slot></details><p id="o" style="${chromium}">Outro text</p>`,
    ],
    [
      'WebKit',
      `<!DOCTYPE html><details open="" style="${webkit}"><span useragentpart="details-content" style="display: block;"><p id="a1">Answer one</p><p id="a1b">Answer more</p></span></details><p id="o" style="${webkit}">Outro text</p>`,
    ],
  ])('%s: a drag from an answer to the next paragraph', (_engine, html) => {
    expect(read(html, 'Answer one\n\nAnswer more\n\nOutro text')).toEqual(answers);
    expect(read(html)).toEqual(answers);
  });

  // R9-FMT-1: only the copy's first element was asked, and then only a
  // `<details>` that was the first child of one already marked. A page's
  // wrapper around the FAQ, Chromium's `<slot>` and WebKit's `<span>` around
  // a nested `<details>`, an editor's content `<div>` all stopped it, so the
  // answer still pasted indented under an empty toggle. Each engine's real
  // copy, by a mouse drag from the answer's first letter to the end of a
  // paragraph after the wrapper.
  const rest = ['paragraph@0:Rest in wrapper', 'paragraph@0:Outro text'];
  const inner = ['paragraph@0:Inner body', 'paragraph@0:Outer rest', 'paragraph@0:Outro text'];

  test.each([
    [
      'Chromium, a wrapper `<div>`',
      `<div class="faq" style="${chromium}"><details open=""><slot id="details-content" pseudo="details-content" style="display: block;"><p id="a">Answer text</p></slot></details><p id="r">Rest in wrapper</p></div><p id="o" style="${chromium}">Outro text</p>`,
      'Answer text\n\nRest in wrapper\n\nOutro text',
      ['paragraph@0:Answer text', ...rest],
    ],
    [
      'Firefox, a wrapper `<div>`',
      `<div class="faq"><details open=""><p id="a">Answer text</p></details><p id="r">Rest in wrapper</p></div><p id="o">Outro text</p>`,
      'Answer text\n\nRest in wrapper\n\nOutro text',
      ['paragraph@0:Answer text', ...rest],
    ],
    [
      'WebKit, a wrapper `<div>`',
      `<!DOCTYPE html><div class="faq" style="${webkit}"><details open=""><span useragentpart="details-content" style="display: block;"><p id="a">Answer text</p></span></details><p id="r">Rest in wrapper</p></div><p id="o" style="${webkit}">Outro text</p>`,
      'Answer text\n\nRest in wrapper\n\nOutro text',
      ['paragraph@0:Answer text', ...rest],
    ],
    [
      'Chromium, a `<section>`',
      `<section style="${chromium}"><details open=""><slot id="details-content" pseudo="details-content" style="display: block;"><p id="a">Answer text</p></slot></details><p id="r">Rest in wrapper</p></section><p id="o" style="${chromium}">Outro text</p>`,
      'Answer text\n\nRest in wrapper\n\nOutro text',
      ['paragraph@0:Answer text', ...rest],
    ],
    [
      'Chromium, a wrapper in a right-to-left page (the drag ended at its end)',
      `<div class="faq" style="${chromium}"><details open=""><slot id="details-content" pseudo="details-content" style="display: block;"><p id="a">لجواب هنا</p></slot></details><p id="r">بقية النص</p></div><br class="Apple-interchange-newline">`,
      'لجواب هنا\n\nبقية النص\n\n',
      ['paragraph@0:لجواب هنا', 'paragraph@0:بقية النص'],
    ],
    [
      'Chromium, nested in the outer `<details>` content slot',
      `<details open="" style="${chromium}"><slot id="details-content" pseudo="details-content" style="display: block;"><details open=""><slot id="details-content" pseudo="details-content" style="display: block;"><p id="ib">Inner body</p></slot></details><p id="or">Outer rest</p></slot></details><p id="o" style="${chromium}">Outro text</p>`,
      'Inner body\n\nOuter rest\n\nOutro text',
      inner,
    ],
    [
      'WebKit, nested in the outer `<details>` content slot',
      `<!DOCTYPE html><details open="" style="${webkit}"><span useragentpart="details-content" style="display: block;"><details open=""><span useragentpart="details-content" style="display: block;"><p id="ib">Inner body</p></span></details><p id="or">Outer rest</p></span></details><p id="o" style="${webkit}">Outro text</p>`,
      'Inner body\n\nOuter rest\n\nOutro text',
      inner,
    ],
    // Read right already: Firefox writes no slot.
    [
      'Firefox, nested',
      `<details open=""><details open=""><p id="ib">Inner body</p></details><p id="or">Outer rest</p></details><p id="o">Outro text</p>`,
      'Inner body\n\nOuter rest\n\nOutro text',
      inner,
    ],
    [
      "Chromium, nested in Tiptap's content `<div>`",
      `<details open="" style="${chromium}"><slot id="details-content" pseudo="details-content" style="display: block;"><div data-type="detailsContent"><details open=""><slot id="details-content" pseudo="details-content" style="display: block;"><div data-type="detailsContent"><p id="ib">Inner body</p></div></slot></details><p id="or">Outer rest</p></div></slot></details><p id="o" style="${chromium}">Outro text</p>`,
      'Inner body\n\nOuter rest\n\nOutro text',
      inner,
    ],
    [
      "Firefox, nested in Tiptap's content `<div>`",
      `<details open=""><div data-type="detailsContent"><details open=""><div data-type="detailsContent"><p id="ib">Inner body</p></div></details><p id="or">Outer rest</p></div></details><p id="o">Outro text</p>`,
      'Inner body\n\nOuter rest\n\nOutro text',
      inner,
    ],
    [
      "WebKit, nested in Tiptap's content `<div>`",
      `<!DOCTYPE html><details open="" style="${webkit}"><span useragentpart="details-content" style="display: block;"><div data-type="detailsContent"><details open=""><span useragentpart="details-content" style="display: block;"><div data-type="detailsContent"><p id="ib">Inner body</p></div></span></details><p id="or">Outer rest</p></div></span></details><p id="o" style="${webkit}">Outro text</p>`,
      'Inner body\n\nOuter rest\n\nOutro text',
      inner,
    ],
    // From the outer body: WebKit hoists the start tag of the `<details>`
    // whose summary comes next into the slot, ahead of the outer body.
    [
      'WebKit, from the outer body',
      `<!DOCTYPE html><details open="" style="${webkit}"><span useragentpart="details-content" style="display: block;"><details open=""><p id="ob">Outer body</p><details open=""><summary id="iq">Inner question</summary><p id="ib">Inner body</p></span></details><p id="or">Outer rest</p></span></details><p id="o" style="${webkit}">Outro text</p>`,
      'Outer body\n\nInner question\nInner body\n\nOuter rest\n\nOutro text',
      [
        'paragraph@0:Outer body',
        'toggle@0:Inner question',
        'paragraph@1:Inner body',
        'paragraph@0:Outer rest',
        'paragraph@0:Outro text',
      ],
    ],
    // Read right already: the inner `<details>` keeps its summary.
    [
      'Chromium, from the outer body',
      `<details open="" style="${chromium}"><slot id="details-content" pseudo="details-content" style="display: block;"><p id="ob">Outer body</p><details open=""><summary id="iq">Inner question</summary><p id="ib">Inner body</p></details><p id="or">Outer rest</p></slot></details><p id="o" style="${chromium}">Outro text</p>`,
      'Outer body\n\nInner question\nInner body\n\nOuter rest\n\nOutro text',
      [
        'paragraph@0:Outer body',
        'toggle@0:Inner question',
        'paragraph@1:Inner body',
        'paragraph@0:Outer rest',
        'paragraph@0:Outro text',
      ],
    ],
    // WebKit hoists a closed `<details>`' start tag inside the wrapper too.
    [
      'WebKit, a wrapper around a closed `<details>`',
      `<!DOCTYPE html><div class="faq" style="${webkit}"><details><p id="a">Lead in faq</p><details><summary>Closed q</summary></span></details><p id="r">Rest in wrapper</p></div><p id="o" style="${webkit}">Outro text</p>`,
      'Lead in faq\n\nClosed q\nRest in wrapper\n\nOutro text',
      ['paragraph@0:Lead in faq', 'toggle@0(c):Closed q', ...rest],
    ],
    // Read right already: a list item and a quote read their text as one.
    [
      'Firefox, a list item',
      `<ul><li><details open=""><p id="a">Answer text</p></details><p id="r">Rest in wrapper</p></li></ul><p id="o">Outro text</p>`,
      '    Answer text\n\n    Rest in wrapper\n\nOutro text',
      ['bulleted_list@0:Answer text\nRest in wrapper', 'paragraph@0:Outro text'],
    ],
    [
      'WebKit, a list item',
      `<!DOCTYPE html><ul style="${webkit}"><li><details open=""><span useragentpart="details-content" style="display: block;"><p id="a">Answer text</p></span></details><p id="r">Rest in wrapper</p></li></ul><p id="o" style="${webkit}">Outro text</p>`,
      'Answer text\n\nRest in wrapper\n\nOutro text',
      ['bulleted_list@0:Answer text\nRest in wrapper', 'paragraph@0:Outro text'],
    ],
  ])('%s', (_name, html, plain, expected) => {
    expect(read(html, plain)).toEqual(expected);
    expect(read(html)).toEqual(expected);
  });

  test('ProseMirror: an open slice in a nested body is its body; a closed one a toggle', () => {
    expect(
      read(
        '<meta charset="utf-8"><details data-pm-slice="4 1 []" open><div data-type="details-content"><details open><div data-type="details-content"><p>A</p></div></details><p>rest</p></div></details><p>B</p>',
      ),
    ).toEqual(['paragraph@0:A', 'paragraph@0:rest', 'paragraph@0:B']);
    expect(
      read('<meta charset="utf-8"><details data-pm-slice="0 0 []" open><p>A</p></details><p>B</p>'),
    ).toEqual(['toggle@0:', 'paragraph@1:A', 'paragraph@0:B']);
  });

  test('off the start edge, or below its own summary, a `<details>` is a toggle', () => {
    // A whole one in a wrapper, its summary selected.
    expect(
      read(
        '<div class="faq"><details open><summary>Q</summary><p>A</p></details></div><p>after</p>',
        'Q\nA\n\nafter',
      ),
    ).toEqual(['toggle@0:Q', 'paragraph@1:A', 'paragraph@0:after']);
    // Pasted after other content in the wrapper.
    expect(
      read('<div class="faq"><p>before</p><details open><p>A</p></details></div>', 'before\n\nA'),
    ).toEqual(['paragraph@0:before', 'toggle@0:', 'paragraph@1:A']);
    // Below a summary: the start edge runs into the summary, not past it.
    expect(
      read(
        '<div><details open><summary>Q</summary><details open><p>A</p></details></details></div>',
      ),
    ).toEqual(['toggle@0:Q', 'toggle@1:', 'paragraph@2:A']);
  });

  test('wrapped and nested without end, it costs the nesting once', () => {
    const time = (levels: number): number => {
      const html = `${'<div><slot><details>'.repeat(levels)}<p>deep</p>`;
      let best = Infinity;

      for (let run = 0; run < 3; run += 1) {
        const start = performance.now();
        blocksFromHtml(document, html);
        best = Math.min(best, performance.now() - start);
      }

      return Math.max(best, 0.1);
    };

    time(100);
    expect(time(1600) / time(400)).toBeLessThan(8);
    expect(read(`${'<div><slot><details>'.repeat(3)}<p>deep</p>`)).toEqual(['paragraph@0:deep']);
  });

  test("WebKit's FAQ, dragged whole: the hoisted `<details>` go, every question stays", () => {
    const html = `<!DOCTYPE html><details style="${webkit}"><details style="${webkit}"><h3 id="i" style="${webkitH3}">FAQ</h3><details style="${webkit}"><summary>How do I install it?</summary></span></details><details style="${webkit}"><summary>Does it work offline?</summary></span></details><p id="o" style="${webkit}">Still stuck? Open an issue.</p>`;

    expect(
      read(html, 'FAQ\n\nHow do I install it?\nDoes it work offline?\nStill stuck? Open an issue.'),
    ).toEqual([
      'heading3@0:FAQ',
      'toggle@0(c):How do I install it?',
      'toggle@0(c):Does it work offline?',
      'paragraph@0:Still stuck? Open an issue.',
    ]);
  });

  test("WebKit's FAQ from the break before a question: that one keeps its summary", () => {
    // The summary inside WebKit's content slot is the `<details>`' own.
    expect(
      read(
        '<!DOCTYPE html><details open=""><details open=""><span useragentpart="details-content"><summary id="q1"><br class="Apple-interchange-newline">Question one</summary><p id="a1">Answer one</p></span></details><details open=""><summary id="q2">Question two</summary><p id="a2">Answer two</p></span></details><p id="o">Outro text</p>',
        '\nQuestion one\nAnswer one\n\nQuestion two\nAnswer two\n\nOutro text',
      ),
    ).toEqual([
      'toggle@0:Question one',
      'paragraph@1:Answer one',
      'toggle@0:Question two',
      'paragraph@1:Answer two',
      'paragraph@0:Outro text',
    ]);
  });

  test('a `<details>` with its summary, or anywhere but the start, is a toggle', () => {
    expect(
      read('<details open><summary>Q</summary><p>A</p></details><p>after</p>', 'Q\nA\n\nafter'),
    ).toEqual(['toggle@0:Q', 'paragraph@1:A', 'paragraph@0:after']);
    expect(read('<p>before</p><details open><p>A</p></details>', 'before\n\nA')).toEqual([
      'paragraph@0:before',
      'toggle@0:',
      'paragraph@1:A',
    ]);
    // ProseMirror's closed start: the `<details>` is a whole block selected.
    expect(
      read(
        '<meta charset=\'utf-8\'><details data-pm-slice="0 1 []" open><p>A</p></details><p>B</p>',
      ),
    ).toEqual(['toggle@0:', 'paragraph@1:A', 'paragraph@0:B']);
    // Only the first: a summary-less one after it is read as before.
    expect(read('<details open><p>A</p></details><details open><p>B</p></details>')).toEqual([
      'paragraph@0:A',
      'toggle@0:',
      'paragraph@1:B',
    ]);
  });

  test('nested without end, it costs the nesting once', () => {
    // A hostile copy can open as many summary-less `<details>` as it likes.
    const time = (levels: number): number => {
      const html = `${'<details>'.repeat(levels)}<p>deep</p>`;
      let best = Infinity;

      for (let run = 0; run < 3; run += 1) {
        const start = performance.now();
        blocksFromHtml(document, html);
        best = Math.min(best, performance.now() - start);
      }

      return Math.max(best, 0.1);
    };

    time(100);
    expect(time(1600) / time(400)).toBeLessThan(8);
    expect(read(`${'<details>'.repeat(3)}<p>deep</p>`)).toEqual(['paragraph@0:deep']);
  });
});

describe("Firefox's indentation, line by line and for the text's own element", () => {
  // Real Firefox copies, by a mouse drag from `start` to `end`, of blocks a
  // stylesheet makes `pre-wrap` (`class="pw"`) or leaves `normal`.
  const read = (html: string, plain: string) =>
    blocksFromHtml(document, html, { plain }).map((block) =>
      block.type === 'table'
        ? `table:${JSON.stringify(block.rows?.map((row) => row.map(richToPlainText)))}`
        : `${block.type}@${block.depth}:${blockText(block)}`,
    );

  // R8-FMT-3: Firefox writes no indentation on an empty line, and the
  // indentation was asked after every line feed, so a blank line in a
  // pre-wrap list item, quote or definition collapsed into a space.
  test.each([
    [
      '<p id="a">start</p><ul><li class="pw x">a\n\nb</li></ul><p id="b">end</p>',
      'start\n\n    a\n\n    b\n\nend',
      ['bulleted_list@0:a\n\nb'],
    ],
    [
      '<p id="a">start</p><blockquote class="pw x">a\n\nb</blockquote><p id="b">end</p>',
      'start\n\n    a\n\n    b\n\nend',
      ['quote@0:a\n\nb'],
    ],
    [
      '<p id="a">start</p><dl><dd class="pw x">a\n\nb</dd></dl><p id="b">end</p>',
      'start\n\n    a\n\n    b\n\nend',
      ['paragraph@0:a\n\nb'],
    ],
    [
      '<p id="a">start</p><ul><li>o<ul><li class="pw x">poem line\n\nsecond stanza</li></ul></li></ul><p id="b">end</p>',
      'start\n\n    o\n        poem line\n\n        second stanza\n\nend',
      ['bulleted_list@0:o', 'bulleted_list@1:poem line\n\nsecond stanza'],
    ],
    // A line of spaces is indented, and was read already.
    [
      '<p id="a">start</p><ul><li class="pw x">a\n  \nb</li></ul><p id="b">end</p>',
      'start\n\n    a\n      \n    b\n\nend',
      ['bulleted_list@0:a\n  \nb'],
    ],
  ])('a blank line: %j', (html, plain, expected) => {
    expect(read(html, plain)).toEqual(['paragraph@0:start', ...expected, 'paragraph@0:end']);
  });

  // R8-FMT-4: the spaces after a `<br>` in a `normal` list item, exactly as
  // many as Firefox indents the next line by, matched the plain text as they
  // stand and were kept, though nothing drew them.
  test.each([
    [
      '<p id="a">start</p><ul><li class="x">one<br>    two</li></ul><p id="b">end</p>',
      'start\n\n    one\n    two\n\nend',
      ['bulleted_list@0:one\ntwo'],
    ],
    [
      '<p id="a">start</p><ul><li>o<ul><li class="x">one<br>        two</li></ul></li></ul><p id="b">end</p>',
      'start\n\n    o\n        one\n        two\n\nend',
      ['bulleted_list@0:o', 'bulleted_list@1:one\ntwo'],
    ],
    // Drawn, they stand: Firefox writes them after its indentation.
    [
      '<p id="a">start</p><ul><li class="pw x">one<br>    two</li></ul><p id="b">end</p>',
      'start\n\n    one\n        two\n\nend',
      ['bulleted_list@0:one\n    two'],
    ],
  ])('spaces after a break: %j', (html, plain, expected) => {
    expect(read(html, plain)).toEqual(['paragraph@0:start', ...expected, 'paragraph@0:end']);
  });

  // R8-FMT-5: the indentation was counted for the block, not for the element
  // its text stands in -- a quote in a quote, a list in a cell -- and a
  // second paragraph in a list item or a quote stands after the blank line
  // Firefox writes between paragraphs, so its drawn leading space was lost.
  test.each([
    [
      '<p id="a">start</p><blockquote><blockquote class="pw x"> deep  q</blockquote></blockquote><p id="b">end</p>',
      'start\n\n         deep  q\n\nend',
      ['quote@0: deep  q'],
    ],
    // Its lines too (the round 7 fixer's real copy).
    [
      '<p id="a">start</p><blockquote><blockquote class="pw"> deep\nline</blockquote></blockquote><p id="b">end</p>',
      'start\n\n         deep\n        line\n\nend',
      ['quote@0: deep\nline'],
    ],
    [
      '<p id="a">start</p><table><tbody><tr><td>c0</td><td><ul><li class="pw x"> in  cell</li></ul></td></tr></tbody></table><p id="b">end</p>',
      'start\nc0\t\n\n     in  cell\n\nend',
      ['table:[["c0"," in  cell"]]'],
    ],
    [
      '<p id="a">start</p><ul><li><p class="x">first</p><p class="pw x"> second  p</p></li></ul><p id="b">end</p>',
      'start\n\n    first\n\n     second  p\n\nend',
      ['bulleted_list@0:first\n second  p'],
    ],
    [
      '<p id="a">start</p><blockquote><p class="pw x">q1</p><p class="pw x"> q2</p></blockquote><p id="b">end</p>',
      'start\n\n    q1\n\n     q2\n\nend',
      ['quote@0:q1\n q2'],
    ],
    [
      '<p id="a">start</p><ul><li><div class="x">d0</div><div class="pw x"> d1</div></li></ul><p id="b">end</p>',
      'start\n\n    d0\n     d1\n\nend',
      ['bulleted_list@0:d0\n d1'],
    ],
    [
      '<p id="a">start</p><blockquote><ul><li><p class="x">p1</p><p class="pw x"> p2</p></li></ul></blockquote><p id="b">end</p>',
      'start\n\n        p1\n\n         p2\n\nend',
      ['bulleted_list@0:p1\n p2'],
    ],
    // Undrawn, the second paragraph's space stays out.
    [
      '<p id="a">start</p><ul><li><p class="x">first</p><p class="x"> second</p></li></ul><p id="b">end</p>',
      'start\n\n    first\n\n    second\n\nend',
      ['bulleted_list@0:first\nsecond'],
    ],
  ])("the text's own indentation: %j", (html, plain, expected) => {
    expect(read(html, plain)).toEqual(['paragraph@0:start', ...expected, 'paragraph@0:end']);
  });

  // R9-FMT-2: R8-FMT-5's blank line between two paragraphs of one block was
  // allowed only where Firefox indents, so with no list, quote or definition
  // in the copy -- a drag begun inside a list, where Firefox writes bare
  // `<li>`s, or any table cell -- the second paragraph's drawn leading
  // spaces were dropped. Real Firefox copies, by a mouse drag from the start
  // of the first element to the end of the last.
  test.each([
    [
      '<li class="pw" id="s"><p>First paragraph</p><p>  indented second</p></li><li class="pw" id="e">Next item</li>',
      'First paragraph\n\n  indented second\nNext item',
      ['bulleted_list@0:First paragraph\n  indented second', 'bulleted_list@0:Next item'],
    ],
    [
      '<li id="s"><p>First paragraph</p><p class="pw">  indented second</p></li><li id="e">Next item</li>',
      'First paragraph\n\n  indented second\nNext item',
      ['bulleted_list@0:First paragraph\n  indented second', 'bulleted_list@0:Next item'],
    ],
    [
      '<li class="pw" id="s"><p>  two</p><p>  three</p></li><li id="e">Next item</li>',
      '  two\n\n  three\nNext item',
      ['bulleted_list@0:  two\n  three', 'bulleted_list@0:Next item'],
    ],
    [
      '<p id="s">Lead</p><table><tbody><tr><td class="pw"><p>First paragraph</p><p>  indented second</p></td><td id="e">z</td></tr></tbody></table>',
      'Lead\n\nFirst paragraph\n\n  indented second\n\tz',
      ['paragraph@0:Lead', 'table:[["First paragraph\\n  indented second","z"]]'],
    ],
    [
      '<p id="s">Lead</p><table><tbody><tr><th class="pw"><p>First paragraph</p><p>  indented second</p></th><td id="e">z</td></tr></tbody></table>',
      'Lead\n\nFirst paragraph\n\n  indented second\n\tz',
      ['paragraph@0:Lead', 'table:[["First paragraph\\n  indented second","z"]]'],
    ],
    [
      '<p id="s">Lead</p><table><tbody><tr><td class="pw"><p>One</p><p>  two</p><p>   three</p></td><td id="e">z</td></tr></tbody></table>',
      'Lead\n\nOne\n\n  two\n\n   three\n\tz',
      ['paragraph@0:Lead', 'table:[["One\\n  two\\n   three","z"]]'],
    ],
    [
      '<p id="s">Lead</p><table><tbody><tr><td><p>First paragraph</p><p class="pw">  indented second</p></td><td id="e">z</td></tr></tbody></table>',
      'Lead\n\nFirst paragraph\n\n  indented second\n\tz',
      ['paragraph@0:Lead', 'table:[["First paragraph\\n  indented second","z"]]'],
    ],
    [
      '<p id="s">Lead</p><table><tbody><tr><td class="pw">\n<p>First paragraph</p>\n<p>  indented second</p>\n</td><td id="e">z</td></tr></tbody></table>',
      'Lead\n\nFirst paragraph\n\n  indented second\n\n\tz',
      ['paragraph@0:Lead', 'table:[["First paragraph\\n  indented second","z"]]'],
    ],
    [
      '<p id="s">Lead</p><table dir="rtl"><tbody><tr><td class="pw"><p>الفقرة الأولى</p><p>  الفقرة الثانية</p></td><td id="e">z</td></tr></tbody></table>',
      'Lead\n\nالفقرة الأولى\n\n  الفقرة الثانية\n\tz',
      ['paragraph@0:Lead', 'table:[["الفقرة الأولى\\n  الفقرة الثانية","z"]]'],
    ],
    // Undrawn, the spaces stay out, as before.
    [
      '<li id="s"><p>First paragraph</p><p>  indented second</p></li><li id="e">Next item</li>',
      'First paragraph\n\nindented second\nNext item',
      ['bulleted_list@0:First paragraph\nindented second', 'bulleted_list@0:Next item'],
    ],
    [
      '<p id="s">Lead</p><table><tbody><tr><td><p>First paragraph</p><p>  indented second</p></td><td id="e">z</td></tr></tbody></table>',
      'Lead\n\nFirst paragraph\n\nindented second\n\tz',
      ['paragraph@0:Lead', 'table:[["First paragraph\\nindented second","z"]]'],
    ],
    // Read right already: two `<div>`s are one line feed apart.
    [
      '<p id="s">Lead</p><table><tbody><tr><td class="pw"><div>First line</div><div>  indented second</div></td><td id="e">z</td></tr></tbody></table>',
      'Lead\nFirst line\n  indented second\n\tz',
      ['paragraph@0:Lead', 'table:[["First line\\n  indented second","z"]]'],
    ],
    [
      '<li class="pw" id="s"><div>First line</div><div>  indented second</div></li><li id="e">Next item</li>',
      'First line\n  indented second\nNext item',
      ['bulleted_list@0:First line\n  indented second', 'bulleted_list@0:Next item'],
    ],
  ])('a blank line with no indentation: %j', (html, plain, expected) => {
    expect(read(html, plain)).toEqual(expected);
  });

  // R9-RV-FMT-1: a block with no indentation of its own can hold a list, a
  // quote or a definition Firefox does indent, and the line after the blank
  // line is then indented by that element's four (or eight) spaces -- which
  // R9-FMT-2's rule took for the block's own drawn spaces. R9-RV-FMT-3: and
  // R8-FMT-4's rule never reached such an element, so the undrawn spaces
  // after a `<br>` in a `normal` item in a cell were kept, and a `pre-wrap`
  // one's drawn spaces dropped. Each line is matched past the indentation of
  // the element its first character stands in. Real Firefox copies, by a
  // mouse drag from `Intro` (or the item's start) to the end of the last.
  const cell = (text: string) => [
    'paragraph@0:Intro',
    `table:[[${text},"zed"]]`,
    'paragraph@0:Outro text',
  ];

  test.each([
    [
      '<p id="s">Intro</p><table><tbody><tr><td><p>First para</p><ul><li>    item text</li></ul></td><td>zed</td></tr></tbody></table><p id="e">Outro text</p>',
      'Intro\n\nFirst para\n\n    item text\n\n\tzed\n\nOutro text',
      cell('"First para\\nitem text"'),
    ],
    [
      '<p id="s">Intro</p><table><tbody><tr><td><p>First para</p><ol><li>    item text</li></ol></td><td>zed</td></tr></tbody></table><p id="e">Outro text</p>',
      'Intro\n\nFirst para\n\n    item text\n\n\tzed\n\nOutro text',
      cell('"First para\\nitem text"'),
    ],
    [
      '<p id="s">Intro</p><table><tbody><tr><td><p>First para</p><blockquote>    quoted text</blockquote></td><td>zed</td></tr></tbody></table><p id="e">Outro text</p>',
      'Intro\n\nFirst para\n\n    quoted text\n\n\tzed\n\nOutro text',
      cell('"First para\\nquoted text"'),
    ],
    [
      '<p id="s">Intro</p><table><tbody><tr><td><p>First para</p><blockquote><blockquote>        deep text</blockquote></blockquote></td><td>zed</td></tr></tbody></table><p id="e">Outro text</p>',
      'Intro\n\nFirst para\n\n        deep text\n\n\tzed\n\nOutro text',
      cell('"First para\\ndeep text"'),
    ],
    [
      '<li id="s"><p>First para</p><dl><dd>    def text</dd></dl></li><li id="e">Next item</li>',
      'First para\n\n    def text\n\nNext item',
      ['bulleted_list@0:First para\ndef text', 'bulleted_list@0:Next item'],
    ],
    // R9-RV-FMT-3, wrong before R9-FMT-2 as well: a definition, and the
    // spaces after a `<br>` in a `normal` item, after a paragraph or first.
    [
      '<p id="s">Intro</p><table><tbody><tr><td><p>First para</p><dl><dt>term</dt><dd>    def text</dd></dl></td><td>zed</td></tr></tbody></table><p id="e">Outro text</p>',
      'Intro\n\nFirst para\n\nterm\n    def text\n\n\tzed\n\nOutro text',
      cell('"First para\\nterm\\ndef text"'),
    ],
    [
      '<p id="s">Intro</p><table><tbody><tr><td><p>First para</p><ul><li>one<br>    two</li></ul></td><td>zed</td></tr></tbody></table><p id="e">Outro text</p>',
      'Intro\n\nFirst para\n\n    one\n    two\n\n\tzed\n\nOutro text',
      cell('"First para\\none\\ntwo"'),
    ],
    [
      '<p id="s">Intro</p><table><tbody><tr><td><ul><li>one<br>    two</li></ul></td><td>zed</td></tr></tbody></table><p id="e">Outro text</p>',
      'Intro\n\n    one\n    two\n\n\tzed\n\nOutro text',
      cell('"one\\ntwo"'),
    ],
    // Drawn, past the element's indentation, they stand.
    [
      '<p id="s">Intro</p><table><tbody><tr><td><p>First para</p><ul><li class="pw">  item drawn</li></ul></td><td>zed</td></tr></tbody></table><p id="e">Outro text</p>',
      'Intro\n\nFirst para\n\n      item drawn\n\n\tzed\n\nOutro text',
      cell('"First para\\n  item drawn"'),
    ],
    [
      '<p id="s">Intro</p><table><tbody><tr><td><p>First para</p><blockquote class="pw">  quoted drawn</blockquote></td><td>zed</td></tr></tbody></table><p id="e">Outro text</p>',
      'Intro\n\nFirst para\n\n      quoted drawn\n\n\tzed\n\nOutro text',
      cell('"First para\\n  quoted drawn"'),
    ],
    [
      '<p id="s">Intro</p><table><tbody><tr><td><p>First para</p><ul><li class="pw">one<br>  two</li></ul></td><td>zed</td></tr></tbody></table><p id="e">Outro text</p>',
      'Intro\n\nFirst para\n\n    one\n      two\n\n\tzed\n\nOutro text',
      cell('"First para\\none\\n  two"'),
    ],
    [
      '<p id="s">Intro</p><table><tbody><tr><td><ul><li class="pw">one<br>    two</li></ul></td><td>zed</td></tr></tbody></table><p id="e">Outro text</p>',
      'Intro\n\n    one\n        two\n\n\tzed\n\nOutro text',
      cell('"one\\n    two"'),
    ],
    [
      '<p id="s">Intro</p><table><tbody><tr><td><ul><li class="pw">one<br>  two</li></ul></td><td>zed</td></tr></tbody></table><p id="e">Outro text</p>',
      'Intro\n\n    one\n      two\n\n\tzed\n\nOutro text',
      cell('"one\\n  two"'),
    ],
    // Read right already: the indentation-0 blank line, where nothing indents.
    [
      '<p id="s">Intro</p><table><tbody><tr><td><div class="pw"><p>First para</p><p>  second drawn</p></div></td><td>zed</td></tr></tbody></table><p id="e">Outro text</p>',
      'Intro\n\nFirst para\n\n  second drawn\n\tzed\n\nOutro text',
      cell('"First para\\n  second drawn"'),
    ],
    [
      '<li id="s"><p>First para</p><p class="pw">  second drawn</p></li><li id="e">Next item</li>',
      'First para\n\n  second drawn\nNext item',
      ['bulleted_list@0:First para\n  second drawn', 'bulleted_list@0:Next item'],
    ],
  ])('a line in an element indented inside a block that is not: %j', (html, plain, expected) => {
    expect(read(html, plain)).toEqual(expected);
  });

  // R9-RV2-FMT-1: a line matched past its element's indentation was judged
  // with the whole gap before it, so the space ending the line above rode
  // along -- Firefox writes a `<dd>`'s trailing space whether it was drawn or
  // not -- and an undrawn one the plain text left out cost the next line its
  // drawn lead. The gap is split at its first line feed: what ends the line
  // above is the collapsed reading's where a block ends there, and the line
  // below is matched from the line feed on. Real Firefox copies, by a drag
  // from `Lead` to the end of `End`.
  const at = (text: string) => ['paragraph@0:Lead', `table:[[${text},"zed"]]`, 'paragraph@0:End'];

  test.each([
    [
      '<p id="s0">Lead</p><table><tbody><tr><td><p>a</p><dl><dd>one </dd></dl><ul><li class="pw">  two</li></ul></td><td>zed</td></tr></tbody></table><p id="e">End</p>',
      'Lead\n\na\n\n    one \n\n      two\n\n\tzed\n\nEnd',
      at('"a\\none\\n  two"'),
    ],
    [
      '<p id="s0">Lead</p><table><tbody><tr><td><p>a</p><dl><dd>one </dd></dl><blockquote class="pw">  two</blockquote></td><td>zed</td></tr></tbody></table><p id="e">End</p>',
      'Lead\n\na\n\n    one \n\n      two\n\n\tzed\n\nEnd',
      at('"a\\none\\n  two"'),
    ],
    [
      '<p id="s0">Lead</p><table><tbody><tr><td><dl><dt>t</dt><dd>one<br>two </dd></dl><ol><li><p class="pw">  three</p></li></ol></td><td>zed</td></tr></tbody></table><p id="e">End</p>',
      'Lead\n\nt\n    one\n    two \n\n      three\n\n\tzed\n\nEnd',
      at('"t\\none\\ntwo\\n  three"'),
    ],
    // Wrong before R9-FMT-2 as well: the space the plain text left out.
    [
      '<p id="s0">Lead</p><table><tbody><tr><td><p>one </p><p class="pw">  two</p></td><td>zed</td></tr></tbody></table><p id="e">End</p>',
      'Lead\n\none\n\n  two\n\tzed\n\nEnd',
      at('"one\\n  two"'),
    ],
    [
      '<p id="s0">Lead</p><table><tbody><tr><td><ul><li>one </li><li class="pw">  two</li></ul></td><td>zed</td></tr></tbody></table><p id="e">End</p>',
      'Lead\n\n    one\n      two\n\n\tzed\n\nEnd',
      at('"one\\n  two"'),
    ],
    [
      '<p id="s0">Lead</p><table><tbody><tr><td>one <br><span class="pw">  two</span></td><td>zed</td></tr></tbody></table><p id="e">End</p>',
      'Lead\none\n  two\tzed\n\nEnd',
      at('"one\\n  two"'),
    ],
    // Read right already: nothing drawn after it, or a drawn space ending a
    // line inside one block (`pre-wrap` keeps it, and Firefox writes it).
    [
      '<p id="s0">Lead</p><table><tbody><tr><td><p>a</p><dl><dd>one </dd></dl><ul><li>    two</li></ul></td><td>zed</td></tr></tbody></table><p id="e">End</p>',
      'Lead\n\na\n\n    one \n\n    two\n\n\tzed\n\nEnd',
      at('"a\\none\\ntwo"'),
    ],
    [
      '<p id="s">Lead</p><table><tbody><tr><td><p class="pw">one <br>  two</p></td><td>zed</td></tr></tbody></table><p id="e">End</p>',
      'Lead\n\none \n  two\n\tzed\n\nEnd',
      at('"one \\n  two"'),
    ],
    [
      '<p id="s">Lead</p><table><tbody><tr><td><p class="pw">one  <br>two</p></td><td>zed</td></tr></tbody></table><p id="e">End</p>',
      'Lead\n\none  \ntwo\n\tzed\n\nEnd',
      at('"one  \\ntwo"'),
    ],
    // Its source line feed collapses to a space, so nothing is split.
    [
      '<p id="s0">Lead</p><table><tbody><tr><td><p class="pw">    <span>gamma</span> \n    delta</p></td><td>zed</td></tr></tbody></table><p id="e">End</p>',
      'Lead\n\n    gamma \n    delta\n\tzed\n\nEnd',
      at('"    gamma \\n    delta"'),
    ],
    // The cost (R9-RV2-FMT-1's decision): a `pre-wrap` definition's drawn
    // trailing space ends a block, and goes as an undrawn one would.
    [
      '<p id="s">Lead</p><table><tbody><tr><td><p>a</p><dl><dd class="pw">one </dd></dl><ul><li class="pw">  two</li></ul></td><td>zed</td></tr></tbody></table><p id="e">End</p>',
      'Lead\n\na\n\n    one \n\n      two\n\n\tzed\n\nEnd',
      at('"a\\none\\n  two"'),
    ],
  ])('a line feed splits the gap: %j', (html, plain, expected) => {
    expect(read(html, plain)).toEqual(expected);
  });

  test('a block end the rule before kept, it keeps (cell whose text starts in a list)', () => {
    // The second reviewer's fuzz case (cell, seed 99, #18), a real Firefox
    // copy: the `pre-wrap` item's drawn `  ` before its `<dl>` ends a block,
    // and the gap read as a whole by the cell's lead indentation kept it.
    const [, table] = blocksFromHtml(
      document,
      '<p id="s0">Lead</p><table><tbody><tr><td class="pw"><ol><li><p class="pw">    <em> </em>gamma286&lt;eps287</p><blockquote><p>\u00a0<span>gamma284</span>\f<br><br>delta285    </p></blockquote></li></ol><p class="pw">    <b>delta288</b><br>delta289\neps290  </p><p>    eps291\u0001 <br>gamma292    </p><blockquote><p>\u00a0<b>eps293</b>\u000b<br>beta294</p></blockquote></td><td class="pw"><ul><li class="pw"> \u00a0<i>be</i>ta300\u200beps301 beta302  <dl><dt>alpha297</dt><dd class="pw">    <span>beta298</span>  beta299<blockquote class="pw">    <b>gamma295</b>&amp;<br> delta296</blockquote></dd></dl></li><li>    gamma303<br>        gamma304\n  </li></ul><div>    <a href="#">eps305</a><br><br>beta306  </div></td></tr></tbody></table><p id="e">End</p>',
      {
        plain:
          'Lead\n\n         gamma286<eps287\n\n         gamma284\f\n\n        delta285    \n\n    delta288\ndelta289\neps290  \n\n    eps291\u0001 \ngamma292    \n\n     eps293\u000b\n    beta294\n\n\t\n\n      beta300\u200beps301 beta302  \n\n    alpha297\n            beta298  beta299\n\n                gamma295&\n             delta296\n\n        gamma303\n            gamma304\n      \n\n    eps305\n\nbeta306  \n\nEnd',
      },
    );
    const lines = table!
      .rows!.flat()
      .map(richToPlainText)
      .join('\n')
      .replace(/\u00a0/g, ' ')
      .split('\n');

    expect(lines).toContain('  beta300\u200beps301 beta302  ');
  });

  test('a block end the plain text holds exactly, gap and all, still stands', () => {
    // The reviewer's fuzz case (seed 5, #20), a real Firefox copy of a drag
    // begun inside a list: `gamma241    ` ends a `pre-wrap` `<div>`, drawn,
    // and the whole gap to the next `<div>` is in the plain text as it is in
    // the source -- read so before the split, and kept.
    const [first] = blocksFromHtml(
      document,
      '<li id="l1"><p id="p1">ead text</p><div class="pw">beta239 \n    alpha240  <br>gamma241    </div><div class="pw">\u00a0<a href="http://localhost:4404/?doc=empty#">delta242</a><br>alpha243\n  </div></li><li id="l2"><dl><dt>alpha244</dt><dd class="pw">    delta245\u2003delta246</dd></dl><blockquote class="pw">    alpha247\u007f\ndelta248</blockquote></li><li id="l3">Final</li>',
      {
        plain:
          'ead text\nbeta239 \n    alpha240  \ngamma241    \n delta242\nalpha243\n  \n\nalpha244\n        delta245\u2003delta246\n\n        alpha247\u007f\n    delta248\n\nFinal',
      },
    );

    expect(blockText(first!).replace(/\u00a0/g, ' ')).toBe(
      'ead text\nbeta239 \n    alpha240  \ngamma241    \n delta242\nalpha243',
    );
  });

  test('a cell of many lines in many lists costs its length', () => {
    const time = (lines: number): number => {
      const html = `<table><tbody><tr><td>${'<p>para</p><ul><li class="pw">  item</li></ul>'.repeat(lines)}</td></tr></tbody></table>`;
      const plain = 'para\n\n      item\n\n'.repeat(lines);
      let best = Infinity;

      for (let run = 0; run < 3; run += 1) {
        const start = performance.now();
        blocksFromHtml(document, html, { plain });
        best = Math.min(best, performance.now() - start);
      }

      return Math.max(best, 0.1);
    };

    time(200);
    expect(time(3200) / time(800)).toBeLessThan(8);
    expect(
      read(
        `<table><tbody><tr><td>${'<p>para</p><ul><li class="pw">  item</li></ul>'.repeat(2)}</td></tr></tbody></table>`,
        'para\n\n      item\n\npara\n\n      item\n\n',
      ),
    ).toEqual(['table:[["para\\n  item\\npara\\n  item"]]']);
  });

  test('where the characters read are not the ones counted, a line is matched as before', () => {
    // Built, not copied: a control character is a solid character of the
    // source the text read drops, so counted by text node the `b` would be
    // placed in the paragraph, and its line matched with no indentation --
    // the item's four undrawn spaces taken for drawn ones.
    expect(
      read(
        '<table><tbody><tr><td><p>a&#1;</p><ul><li>    b</li></ul></td><td>zed</td></tr></tbody></table>',
        'a\n\n    b\n\n\tzed',
      ),
    ).toEqual(['table:[["a\\nb","zed"]]']);
  });

  // R8-FMT-6: only collapsible whitespace or a space the block starts with
  // asked the plain text, so a drawn space after a `<br>` in a block a
  // stylesheet makes pre-wrap was lost. Undrawn, Firefox leaves it out.
  test.each([
    [
      '<p id="a">start</p><p class="pw x">one<br> two</p><p id="b">end</p>',
      'start\n\none\n two\n\nend',
      'paragraph@0:one\n two',
    ],
    [
      '<p id="a">start</p><ul><li class="pw x">one<br> two</li></ul><p id="b">end</p>',
      'start\n\n    one\n     two\n\nend',
      'bulleted_list@0:one\n two',
    ],
    [
      '<p id="a">start</p><blockquote class="pw x">one<br> two</blockquote><p id="b">end</p>',
      'start\n\n    one\n     two\n\nend',
      'quote@0:one\n two',
    ],
    [
      '<p id="a">start</p><p class="x">one<br> two</p><p id="b">end</p>',
      'start\n\none\ntwo\n\nend',
      'paragraph@0:one\ntwo',
    ],
    [
      '<p id="a">start</p><ul><li class="x">one<br> two</li></ul><p id="b">end</p>',
      'start\n\n    one\n    two\n\nend',
      'bulleted_list@0:one\ntwo',
    ],
    [
      '<p id="a">start</p><p class="x">one<br>  two</p><p id="b">end</p>',
      'start\n\none\ntwo\n\nend',
      'paragraph@0:one\ntwo',
    ],
    // A loose `<div>`'s text, read as an inline run.
    [
      '<p id="a">start</p><div class="pw x">one<br> two</div><p id="b">end</p>',
      'start\none\n two\n\nend',
      'paragraph@0:one\n two',
    ],
    [
      '<p id="a">start</p><div class="x">one<br> two</div><p id="b">end</p>',
      'start\none\ntwo\n\nend',
      'paragraph@0:one\ntwo',
    ],
  ])('a space after a break: %j', (html, plain, expected) => {
    expect(read(html, plain)).toEqual(['paragraph@0:start', expected, 'paragraph@0:end']);
  });

  test('each line costs its own length, however many there are', () => {
    // Every gap is asked whether it shows the indentation, a blank line is
    // passed over, and a block is walked once for the breaks it holds.
    const time = (lines: number): number => {
      const text = Array.from({ length: lines }, (_, index) => `line ${index}`);
      const html = `<p>start</p><ul><li><ul><li>${text.join('\n\n')}</li></ul></li></ul><p>${text.join('<br> ')}</p>`;
      const plain = `start\n\n        ${text.join('\n\n        ')}\n\n${text.join('\n ')}`;
      let best = Infinity;

      for (let run = 0; run < 3; run += 1) {
        const start = performance.now();
        blocksFromHtml(document, html, { plain });
        best = Math.min(best, performance.now() - start);
      }

      return Math.max(best, 0.1);
    };

    time(200);
    expect(time(8000) / time(2000)).toBeLessThan(8);
    expect(
      read(
        '<p>start</p><ul><li><ul><li>a\n\nb</li></ul></li></ul>',
        'start\n\n        a\n\n        b',
      ),
    ).toEqual(['paragraph@0:start', 'bulleted_list@1:a\n\nb']);
  });

  // R8-FMT-8 (a known limit): Firefox starts each line of a `type="cite"`
  // quote with `>` in its plain text, so nothing in one is found there and
  // its whitespace reads collapsed. Pinned so that a change to it is chosen.
  test('a cite quote reads collapsed', () => {
    expect(
      read(
        '<p id="a">start</p><blockquote type="cite"><p class="pw x"> quoted  text</p></blockquote><p id="b">end</p>',
        'start\n>\n>  quoted  text\n\nend',
      ),
    ).toEqual(['paragraph@0:start', 'quote@0:quoted text', 'paragraph@0:end']);
  });

  // R10-FMT-1: a `pre-wrap` line's drawn trailing spaces, inside an element
  // that stands in a block with text before it (`start` then a list, quote or
  // definition in a cell), are kept because the line above the split and the
  // line below are in one block (`lineBlock`) -- not because the gap matched
  // as before (`asBefore`), which here it does not: the rule before the split
  // dropped them. Real Firefox copies, by a mouse drag from the start of
  // `Lead` to the end of `End`.
  test.each([
    [
      '<p id="s0">Lead</p><table><tbody><tr><td>start<ul><li class="pw">one  <br>two</li></ul></td><td>z</td></tr></tbody></table><p id="e">End</p>',
      'Lead\nstart\n\n    one  \n    two\n\n\tz\n\nEnd',
      '"start\\none  \\ntwo"',
    ],
    [
      '<p id="s0">Lead</p><table><tbody><tr><td>start<blockquote class="pw">one  <br>two</blockquote></td><td>z</td></tr></tbody></table><p id="e">End</p>',
      'Lead\nstart\n\n    one  \n    two\n\n\tz\n\nEnd',
      '"start\\none  \\ntwo"',
    ],
    [
      '<p id="s0">Lead</p><table><tbody><tr><td>start<dl><dd class="pw">one   <br>two</dd></dl></td><td>z</td></tr></tbody></table><p id="e">End</p>',
      'Lead\nstart\n\n    one   \n    two\n\n\tz\n\nEnd',
      '"start\\none   \\ntwo"',
    ],
  ])('a drawn trailing space within one block stands: %j', (html, plain, text) => {
    expect(read(html, plain)).toEqual([
      'paragraph@0:Lead',
      `table:[[${text},"z"]]`,
      'paragraph@0:End',
    ]);
  });

  // R10-FMT-1: a no-break space is not a solid character of the plain text
  // -- Firefox writes it there as a space -- so it is not counted as one, or
  // the count of solids no longer equals the text read's, the line-by-line
  // match is given up, and the next paragraph's drawn lead is dropped. Real
  // Firefox copies, by a mouse drag from the start of `Lead` to the end of
  // `End`.
  test.each([
    [
      '<p id="s0">Lead</p><table><tbody><tr><td class="pw"><p>First para</p><p>   Second para</p></td><td>z</td></tr></tbody></table><p id="e">End</p>',
      '"First para\\n   Second para"',
    ],
    [
      '<p id="s0">Lead</p><table><tbody><tr><td class="pw"><p>First para</p><p>   Second para</p></td><td>z</td></tr></tbody></table><p id="e">End</p>',
      '"First para\\n   Second para"',
    ],
  ])('a no-break space is not counted as solid: %j', (html, text) => {
    expect(read(html, 'Lead\n\nFirst para\n\n   Second para\n\tz\n\nEnd')).toEqual([
      'paragraph@0:Lead',
      `table:[[${text},"z"]]`,
      'paragraph@0:End',
    ]);
  });

  // R10-FMT-2 (a known limit): Firefox writes `white-space: pre-line` text as
  // preformatted in its plain text -- the source spaces `pre-line` collapsed,
  // and drew none of, are there -- and a page's classes rather than its
  // computed style in its HTML, so a `pre-line` paragraph after a blank line
  // in a table cell or a bare `<li>` arrives byte for byte as its `pre-wrap`
  // twin does (pinned above, under "a blank line with no indentation"), and
  // is read the same way: with the spaces nobody saw. Telling them apart
  // would take the `pre-wrap` case's drawn spaces away. Pinned so that a
  // change to it is chosen. Real Firefox copies, by a mouse drag from `Lead`
  // (or `ad item`) to the end of the last block.
  test.each([
    [
      '<p id="s0">Lead</p><table><tbody><tr><td class="pl"><p>First para</p><p>   Second para</p></td><td>Other</td></tr></tbody></table><p id="e">End</p>',
      'Lead\n\nFirst para\n\n   Second para\n\tOther\n\nEnd',
      ['paragraph@0:Lead', 'table:[["First para\\n   Second para","Other"]]', 'paragraph@0:End'],
    ],
    [
      '<li><p id="s0">ad item</p><ul><li class="pl"><p>First para</p><p>   Second para</p></li></ul></li><li id="e">Last</li>',
      'ad item\n\n    First para\n\n       Second para\n\nLast',
      [
        'bulleted_list@0:ad item',
        'bulleted_list@1:First para\n   Second para',
        'bulleted_list@0:Last',
      ],
    ],
    [
      '<p id="s0">Lead</p><table><tbody><tr><td class="pl">First line<br><p>   Second para</p></td></tr></tbody></table><p id="e">End</p>',
      'Lead\nFirst line\n\n   Second para\n\nEnd',
      ['paragraph@0:Lead', 'table:[["First line\\n   Second para"]]', 'paragraph@0:End'],
    ],
  ])('a pre-line paragraph after a blank line reads as pre-wrap: %j', (html, plain, expected) => {
    expect(read(html, plain)).toEqual(expected);
  });
});

describe('math on the clipboard', () => {
  const m = (tex: string) => ({ text: '￼', math: tex });
  const roundTripBlocks = (blocks: Block[]): Block[] =>
    blocksFromHtml(document, blocksToHtml(document, blocks));

  test('an equation and the formulas around it come back at their depths', () => {
    const blocks = [
      { id: 'a', type: 'bulleted_list', depth: 0, content: [{ text: 'take ' }, m('n')] },
      { id: 'b', type: 'math', depth: 1, content: [{ text: 'a\n| b |' }] },
      { id: 'c', type: 'paragraph', depth: 1, content: [m('x'), { text: ' after' }] },
      { id: 'd', type: 'math', depth: 0, content: [] },
    ] as Block[];

    expect(roundTripBlocks(blocks).map((b) => [b.type, b.depth, b.content])).toEqual(
      blocks.map((b) => [b.type, b.depth, b.content]),
    );
  });

  test('the TeX travels in an attribute, with a spelling any application can show', () => {
    const html = blocksToHtml(document, [
      { id: 'a', type: 'paragraph', depth: 0, content: [m('x^2')] },
      { id: 'b', type: 'math', depth: 2, content: [{ text: 'y' }] },
    ] as Block[]);

    expect(html).toBe(
      '<p style="white-space: pre-wrap;"><span data-neditor-math="x^2">$x^2$</span></p>' +
        '<div data-neditor-depth="2" style="margin-left: 3em;" data-neditor-math-block="y">$$y$$</div>',
    );
  });

  test('a formula in a table cell keeps its TeX', () => {
    const rows = [[[m('|x|')], [{ text: 'h' }]]];
    const [table] = roundTripBlocks([
      { id: 't', type: 'table', depth: 0, content: [], rows },
    ] as Block[]);

    expect(table?.rows).toEqual(rows);
  });
});

describe('math audit round 3: MathJax 2 as pages serve it', () => {
  const read = (html: string) =>
    blocksFromHtml(document, html).map((block) => [block.type, block.depth, block.content]);
  const m = (tex: string) => ({ text: '￼', math: tex });
  const katex = (tex: string) =>
    '<span class="katex"><span class="katex-mathml"><math><semantics>' +
    `<mi>x</mi><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span>` +
    '<span class="katex-html" aria-hidden="true">x</span></span>';
  const katexDisplay = (tex: string) => `<span class="katex-display">${katex(tex)}</span>`;
  const preview = '<span class="MathJax_Preview" style="color: inherit; display: none;"></span>';
  // MathJax 2.7's CommonHTML output for `$$y=1$$`, as Math Stack Exchange
  // serves it: the empty preview, the display wrapper, the TeX script.
  const commonHtmlDisplay =
    '<span class="mjx-chtml MJXc-display" style="text-align: center;">' +
    '<span id="MathJax-Element-1-Frame" class="mjx-chtml MathJax_CHTML" tabindex="0"><span class="mjx-math">y</span>' +
    '<span class="MJX_Assistive_MathML MJX_Assistive_MathML_Block" role="presentation"><math display="block"><mi>y</mi></math></span>' +
    '</span></span><script type="math/tex; mode=display" id="MathJax-Element-1">y=1</script>';
  // A frame with no script after it, naming its TeX in its assistive copy.
  const annotatedFrame = (tex: string, display = false) =>
    '<span class="mjx-chtml MathJax_CHTML"><span class="mjx-math">g</span>' +
    `<span class="MJX_Assistive_MathML${display ? ' MJX_Assistive_MathML_Block' : ''}" role="presentation">` +
    `<math${display ? ' display="block"' : ''}><semantics><mi>g</mi>` +
    `<annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span></span>`;

  // The preview and the script are the formula's: left beside it, the script
  // kept a paragraph from being the equation, and the preview was an inline
  // sibling beside it in a list item.
  test('a displayed formula that is the whole of its paragraph is an equation', () => {
    const expected = [
      ['paragraph', 0, [{ text: 'Text.' }]],
      ['math', 0, [{ text: 'y=1' }]],
      ['paragraph', 0, [{ text: 'More.' }]],
    ];

    expect(read(`<p>Text.</p><p>${preview}${commonHtmlDisplay}</p><p>More.</p>`)).toEqual(expected);
    expect(read(`<p>Text.</p><p>${commonHtmlDisplay}</p><p>More.</p>`)).toEqual(expected);
    expect(read(`<p>Text.</p>${preview}${commonHtmlDisplay}<p>More.</p>`)).toEqual(expected);
  });

  test('a displayed formula after a paragraph of a list item is nested under it', () => {
    const expected = [
      ['bulleted_list', 0, [{ text: 'Solve' }]],
      ['math', 1, [{ text: 'y=1' }]],
    ];

    expect(read(`<ul><li><p>Solve</p>${preview}${commonHtmlDisplay}</li></ul>`)).toEqual(expected);
    expect(read(`<ul><li><p>Solve</p><p>${preview}${commonHtmlDisplay}</p></li></ul>`)).toEqual(
      expected,
    );
  });

  // A `<br>` ends the line, as contenteditable and Google Docs leave one
  // after the last thing in an item.
  test('a line break after an equation in a list item leaves it standing apart', () => {
    expect(read(`<ul><li>${katexDisplay('E')}<br></li></ul>`)).toEqual([
      ['math', 1, [{ text: 'E' }]],
    ]);
    // (The item keeps the `<br>` as a line break, as after any block in it.)
    expect(read(`<ul><li><p>text</p>${katexDisplay('E')}<br></li></ul>`).slice(1)).toEqual([
      ['math', 1, [{ text: 'E' }]],
    ]);
    expect(
      read(`<ul><li>text<br>${katexDisplay('E')}<br>${katexDisplay('F')}</li></ul>`).slice(1),
    ).toEqual([
      ['math', 1, [{ text: 'E' }]],
      ['math', 1, [{ text: 'F' }]],
    ]);
    // Text beside it on its line, or after the break, keeps it in the item's
    // text, in its place.
    expect(read(`<ul><li>see ${katexDisplay('E')}<br></li></ul>`)).toHaveLength(1);
    const before = read(`<ul><li>${katexDisplay('E')}<br>after</li></ul>`);

    expect(before).toHaveLength(1);
    expect(before[0]?.[2]).toEqual([
      m('E'),
      expect.objectContaining({ text: expect.stringMatching(/after$/) }),
    ]);
  });

  // A `<br>` an inline wrapper draws at its edge ends the line as a bare one
  // does: read only as a sibling, `<span><br></span>` after the equation kept
  // it in the item with a "\n", and `<span>T<br></span>` before it kept it
  // on T's line.
  test('a line break at the edge of an inline wrapper is that line break', () => {
    const bare = (inner: string) => read(`<ul><li>${inner}</li></ul>`);

    expect(bare(`${katexDisplay('E')}<span><br></span>`)).toEqual(bare(`${katexDisplay('E')}<br>`));
    expect(bare(`${katexDisplay('E')}<span> <b><br></b> </span>`)).toEqual(
      bare(`${katexDisplay('E')}<br>`),
    );
    expect(bare(`<span>T<br></span>${katexDisplay('E')}`)).toEqual([
      ['bulleted_list', 0, [{ text: 'T' }]],
      ['math', 1, [{ text: 'E' }]],
    ]);
    expect(bare(`<span>T<i>u<br></i> </span>${katexDisplay('E')}`).slice(1)).toEqual([
      ['math', 1, [{ text: 'E' }]],
    ]);
    // What follows the break inside the wrapper still decides, as after a
    // bare one: text there keeps the equation in the item's text.
    expect(bare(`${katexDisplay('E')}<span><br>after</span>`)).toHaveLength(1);
    expect(bare(`${katexDisplay('E')}<span><br></span>after`)).toHaveLength(1);
    expect(bare(`${katexDisplay('E')}<span><br><b>x</b></span>`)).toHaveLength(1);
    // A break inside the wrapper but not at its edge is no edge.
    expect(bare(`<span>T<br>u</span>${katexDisplay('E')}`)).toHaveLength(1);
    expect(bare(`${katexDisplay('E')}<span>u<br></span>`)).toHaveLength(1);
  });

  // The annotation fallback is for one formula; a frame class around more
  // than that is walked, as it was before there was a fallback.
  test('a MathJax class around more than one formula is walked', () => {
    expect(read(`<div class="MathJax"><p>Para one</p><p>Two ${katex('K')}</p></div>`)).toEqual([
      ['paragraph', 0, [{ text: 'Para one' }]],
      ['paragraph', 0, [{ text: 'Two ' }, m('K')]],
    ]);
    expect(
      read(
        `<p><span class="mjx-chtml MJXc-display">${annotatedFrame('A')} and ${annotatedFrame('B')}</span></p>`,
      ),
    ).toEqual([['paragraph', 0, [m('A'), { text: ' and ' }, m('B')]]]);
  });

  test('a scriptless display wrapper is an equation, its TeX from the annotation', () => {
    expect(
      read(
        `<p>Text.</p><span class="mjx-chtml MJXc-display">${annotatedFrame('y=1', true)}</span><p>More.</p>`,
      ),
    ).toEqual([
      ['paragraph', 0, [{ text: 'Text.' }]],
      ['math', 0, [{ text: 'y=1' }]],
      ['paragraph', 0, [{ text: 'More.' }]],
    ]);
    expect(
      read(
        `<div class="MathJax_Display"><span class="MathJax"><span>z</span>` +
          '<span class="MJX_Assistive_MathML MJX_Assistive_MathML_Block"><math display="block"><semantics><mi>z</mi>' +
          '<annotation encoding="application/x-tex">z</annotation></semantics></math></span></span></div>',
      ),
    ).toEqual([['math', 0, [{ text: 'z' }]]]);
    // PreviewHTML's display wrapper is one too.
    expect(
      read(
        `<div class="MathJax_PHTML_Display">${annotatedFrame('w', true)
          .replace('mjx-chtml MathJax_CHTML', 'MathJax_PHTML')
          .replace(
            '<span class="mjx-math">g</span>',
            '<span class="MJXp-math MJXp-display"><span class="MJXp-mi MJXp-italic">g</span></span>',
          )}</div>`,
      ),
    ).toEqual([['math', 0, [{ text: 'w' }]]]);
  });

  // MathJax 2.7.9's `NativeMML/jax.js` (`preTranslate`) and
  // `PreviewHTML/jax.js` (`preTranslate`) put these before the script.
  test('NativeMML and PreviewHTML output is read from its script', () => {
    expect(
      read(
        '<p>Let <span class="MathJax_MathML" id="MathJax-Element-1-Frame"><span class="MathJax_MathContainer">' +
          '<span style="display: inline-block"><math><msup><mi>x</mi><mn>2</mn></msup></math></span></span></span>' +
          '<script type="math/tex" id="MathJax-Element-1">x^2</script> be.</p>',
      ),
    ).toEqual([['paragraph', 0, [{ text: 'Let ' }, m('x^2'), { text: ' be.' }]]]);
    expect(
      read(
        '<div class="MathJax_MathML" id="MathJax-Element-2-Frame"><span class="MathJax_MathContainer">' +
          '<span style="display: inline-block"><math display="block"><mi>y</mi></math></span></span></div>' +
          '<script type="math/tex; mode=display" id="MathJax-Element-2">y</script>',
      ),
    ).toEqual([['math', 0, [{ text: 'y' }]]]);
    expect(
      read(
        '<p>Let <span class="MathJax_PHTML" id="MathJax-Element-3-Frame"><span class="MJXp-math" id="MJXp-Span-1">' +
          '<span class="MJXp-msubsup" id="MJXp-Span-2"><span class="MJXp-mi MJXp-italic" id="MJXp-Span-3" ' +
          'style="margin-right: 0.05em;">x</span><span class="MJXp-mn MJXp-script" id="MJXp-Span-4" ' +
          'style="vertical-align: 0.5em;">2</span></span></span></span>' +
          '<script type="math/tex" id="MathJax-Element-3">x^2</script> be.</p>',
      ),
    ).toEqual([['paragraph', 0, [{ text: 'Let ' }, m('x^2'), { text: ' be.' }]]]);
    expect(
      read(
        '<div class="MathJax_PHTML_Display"><span class="MathJax_PHTML" id="MathJax-Element-4-Frame">' +
          '<span class="MJXp-math MJXp-display" id="MJXp-Span-5"><span class="MJXp-mi MJXp-italic" id="MJXp-Span-6">y</span>' +
          '</span></span></div><script type="math/tex; mode=display" id="MathJax-Element-4">y</script>',
      ),
    ).toEqual([['math', 0, [{ text: 'y' }]]]);
  });

  // Whether a frame is one formula is asked of its children, never searched
  // for in its subtree, so frames in frames, or many in one wrapper, cost
  // their size. Small sizes, because a search of each frame's
  // subtree took 25 seconds at 1,600 nested frames.
  test('reading frames and their scripts is linear in their number', () => {
    const frame =
      '<span class="mjx-chtml MathJax_CHTML"><span>g</span><span class="MJX_Assistive_MathML">' +
      '<math><mi>g</mi></math></span></span>';
    const shapes = [
      (n: number) =>
        `<p>${'<span class="MathJax_CHTML"><span class="MJX_Assistive_MathML">'.repeat(n)}x${'</span></span>'.repeat(n)}</p>`,
      (n: number) => `<p><span class="mjx-chtml MJXc-display">${frame.repeat(n)}</span></p>`,
      (n: number) => `<p>${`${preview}${frame}<script type="math/tex">a</script> `.repeat(n)}</p>`,
    ];
    for (const shape of shapes) {
      expect(
        growth((n) => {
          blocksFromHtml(document, shape(n));
        }, 25),
      ).toBeLessThan(LINEAR);
    }
  }, 60_000);

  // `AssistiveMML` appends one copy to a frame, around one `<math>`. Anything
  // else is no frame of one formula, and is walked rather than read as the
  // first annotation in it.
  test('a frame is one formula only around exactly one assistive copy of one <math>', () => {
    const copy = (inner: string) =>
      `<span class="MJX_Assistive_MathML" role="presentation">${inner}</span>`;
    const math = (tex: string) =>
      `<math><semantics><mi>g</mi><annotation encoding="application/x-tex">${tex}</annotation></semantics></math>`;
    const frame = (inner: string) =>
      `<p>A <span class="mjx-chtml MathJax_CHTML"><span class="mjx-math">g</span>${inner}</span> B</p>`;

    expect(read(frame(copy(math('K'))))).toEqual([
      ['paragraph', 0, [{ text: 'A ' }, m('K'), { text: ' B' }]],
    ]);

    for (const inner of [
      copy(math('K')) + copy(math('L')),
      copy(math('K') + math('L')),
      copy(`${math('K')}<span>L</span>`),
      copy(`<span>${math('K')}</span>`),
    ]) {
      // Walked, as before the fallback: the drawing's text, copies skipped.
      expect(read(frame(inner))).toEqual([['paragraph', 0, [{ text: 'A g B' }]]]);
    }
  });

  // tex2jax's `createPreview` puts the preview before the script, and the
  // output's `preTranslate` then the frame between them. An emptied preview
  // is the formula's; one still holding fast preview's drawing is read.
  test('a preview that still holds something is left to be read', () => {
    const frame =
      '<span class="mjx-chtml MathJax_CHTML" id="MathJax-Element-1-Frame"><span class="mjx-math">' +
      '<span class="mjx-mi">x</span></span></span><script type="math/tex" id="MathJax-Element-1">x</script>';

    expect(read(`<p>Let ${preview}${frame} be.</p>`)).toEqual([
      ['paragraph', 0, [{ text: 'Let ' }, m('x'), { text: ' be.' }]],
    ]);
    expect(
      read(
        '<p>Let <span class="MathJax_Preview"><span class="MathJax_PHTML"><span class="MJXp-math">' +
          `<span class="MJXp-mi MJXp-italic">z</span></span></span></span>${frame} be.</p>`,
      ),
    ).toEqual([['paragraph', 0, [{ text: 'Let z' }, m('x'), { text: ' be.' }]]]);
  });

  // MathJax 2.7.9's sixth output, `PlainSource/jax.js` (`preTranslate`): a
  // `MathJax_PlainSource` span drawing the source as text, in a
  // `MathJax_PlainSource_Display` div when displayed, before the script.
  test('PlainSource output is read from its script', () => {
    expect(
      read(
        '<p>Let <span class="MathJax_PlainSource" id="MathJax-Element-1-Frame" tabindex="0"><span>x^2</span></span>' +
          '<script type="math/tex" id="MathJax-Element-1">x^2</script> be.</p>',
      ),
    ).toEqual([['paragraph', 0, [{ text: 'Let ' }, m('x^2'), { text: ' be.' }]]]);
    expect(
      read(
        '<p>Text.</p><div class="MathJax_PlainSource_Display"><span class="MathJax_PlainSource" ' +
          'id="MathJax-Element-2-Frame" tabindex="0"><span>y=1</span></span></div>' +
          '<script type="math/tex; mode=display" id="MathJax-Element-2">y=1</script><p>More.</p>',
      ),
    ).toEqual([
      ['paragraph', 0, [{ text: 'Text.' }]],
      ['math', 0, [{ text: 'y=1' }]],
      ['paragraph', 0, [{ text: 'More.' }]],
    ]);
    expect(
      read(
        `<ul><li><p>Solve</p>${preview}<div class="MathJax_PlainSource_Display"><span class="MathJax_PlainSource" ` +
          'id="MathJax-Element-3-Frame"><span>y</span></span></div>' +
          '<script type="math/tex; mode=display" id="MathJax-Element-3">y</script></li></ul>',
      ),
    ).toEqual([
      ['bulleted_list', 0, [{ text: 'Solve' }]],
      ['math', 1, [{ text: 'y' }]],
    ]);
  });
});

describe('math audit round 5: what stands beside a display equation in a list item', () => {
  const read = (html: string) =>
    blocksFromHtml(document, html).map((block) => [block.type, block.depth, block.content]);
  const m = (tex: string) => ({ text: '￼', math: tex });
  const eq =
    '<span class="katex-display"><span class="katex"><span class="katex-mathml"><math><semantics>' +
    '<mrow><mi>E</mi></mrow><annotation encoding="application/x-tex">E</annotation></semantics></math>' +
    '</span></span></span>';
  const li = (inner: string) => read(`<ul><li>${inner}</li></ul>`);
  const nested = (text: string) => [
    ['bulleted_list', 0, [{ text }]],
    ['math', 1, [{ text: 'E' }]],
  ];

  // An element the reader keeps nothing of -- empty, or holding only
  // whitespace -- is no text beside the equation, at the edge of a wrapper or
  // as a sibling: the walk into it ended there and read it as text, so
  // `<b></b>` kept the equation in the item's text where without it the
  // equation nested. (Round 6 decides by what the reader keeps, not by what a
  // browser draws.)
  test('an element the reader keeps nothing of is passed over', () => {
    expect(li(`<span>Text<br></span>${eq}`)).toEqual(nested('Text'));
    expect(li(`<span>Text<br><b></b></span>${eq}`)).toEqual(nested('Text'));
    // (The space after the break is the item's, as it is with no equation.)
    expect(li(`<span>Text<br><span> </span></span>${eq}`)).toEqual(nested('Text '));
    expect(li(`Text<br><b></b>${eq}`)).toEqual(li(`Text<br>${eq}`));
    expect(li(`Text<br>${eq}<span><b></b><br></span>`)).toEqual(li(`Text<br>${eq}<br>`));
    expect(li(`Text<br>${eq}<b></b>`)).toEqual(li(`Text<br>${eq}`));
    expect(li(`<span></span>${eq}`)).toEqual(li(eq));
    expect(li(eq)).toEqual([['math', 1, [{ text: 'E' }]]]);
    // What the reader keeps without content still stands beside it.
    expect(li(`<span>Text<br><input type="checkbox"></span>${eq}`)).toHaveLength(1);
    expect(li(`Text<br>${eq}<span><img src="https://a.test/i.png"></span>`)[0]?.[2]).toContainEqual(
      m('E'),
    );
  });

  // A line-starting element ends the line it is in wherever it is: as a
  // sibling before the equation it left it apart, and at the end of an inline
  // wrapper it read as text on the equation's line.
  test('a line-starting element at the end of a wrapper before the equation ends the line', () => {
    expect(li(`<p>Text</p>${eq}`)).toEqual(nested('Text'));
    expect(li(`<span><p>Text</p></span>${eq}`)).toEqual(nested('Text'));
    expect(li(`<span>a<b><div>Text</div></b> </span>${eq}`).slice(1)).toEqual([
      ['math', 1, [{ text: 'E' }]],
    ]);
  });

  // After the equation only a block the item hands on is apart: anything else
  // that starts a line -- a `<div>`, a `<section>` -- is the item's text, read
  // in place, so handing the equation on moved it after that text.
  test('a block the item does not hand on keeps the equation in its text, in order', () => {
    expect(li(`<p>Text</p>${eq}<div>more</div>`)).toEqual([
      ['bulleted_list', 0, [{ text: 'Text\n' }, m('E'), { text: '\nmore' }]],
    ]);
    expect(li(`<p>Text</p>${eq}<section>more</section>`)).toEqual([
      ['bulleted_list', 0, [{ text: 'Text\n' }, m('E'), { text: '\nmore' }]],
    ]);
    expect(li(`Text<br>${eq}<span><br><div>more</div></span>`)).toEqual([
      ['bulleted_list', 0, [{ text: 'Text\n' }, m('E'), { text: '\n\nmore' }]],
    ]);
    // Inside a wrapper even a paragraph is the item's text: only the item's
    // own children are handed on.
    expect(li(`Text<br>${eq}<span><br><p>more</p></span>`)).toHaveLength(1);
    // An equation after it that stands apart is handed on; one that does not
    // is the item's text.
    expect(li(`Text<br>${eq}${eq.replace(/>E</g, '>F<')}`).slice(1)).toEqual([
      ['math', 1, [{ text: 'E' }]],
      ['math', 1, [{ text: 'F' }]],
    ]);
    expect(li(`Text<br>${eq}${eq.replace(/>E</g, '>F<')}<div>more</div>`)).toEqual([
      [
        'bulleted_list',
        0,
        [{ text: 'Text\n' }, m('E'), { text: '\n' }, m('F'), { text: '\nmore' }],
      ],
    ]);
    // Blocks it does hand on, and a line-starting element that draws
    // nothing, leave it apart.
    for (const after of [
      '<p>more</p>',
      '<blockquote>more</blockquote>',
      '<h3>more</h3>',
      '<div> </div>',
    ]) {
      expect(li(`<p>Text</p>${eq}${after}`)[1]).toEqual(['math', 1, [{ text: 'E' }]]);
    }
  });

  // Each node is visited a bounded number of times, by the walk on one side
  // of one equation or the other.
  test('deciding is linear in what stands between the equations', () => {
    const shapes = [
      (n: number) => `<ul><li>Text<br>${`${eq}<span><b></b><br></span>`.repeat(n)}</li></ul>`,
      (n: number) =>
        `<ul><li>Text<br>${`${eq}${'<b> </b>'.repeat(4)}<div> </div>`.repeat(n)}</li></ul>`,
      (n: number) => `<ul><li>Text<br>${eq.repeat(n)}more</li></ul>`,
      (n: number) =>
        `<ul><li>${'<span>'.repeat(n)}Text<br>${'<b></b>'.repeat(n)}${'</span>'.repeat(n)}${eq}</li></ul>`,
      (n: number) => `<ul><li>Text<br>${eq}<span>${'<i> </i>'.repeat(n)}<br></span></li></ul>`,
    ];

    for (const shape of shapes) {
      expect(
        growth((n) => {
          blocksFromHtml(document, shape(n));
        }, 25),
      ).toBeLessThan(LINEAR);
    }
  }, 60_000);
});

describe('math audit round 6: a display equation in a list item changes no order', () => {
  const read = (html: string) =>
    blocksFromHtml(document, html).map((block) =>
      block.type === 'image'
        ? [block.type, block.depth, block.src]
        : [block.type, block.depth, block.content],
    );
  const m = (tex: string) => ({ text: '￼', math: tex });
  const katex = (tex: string) =>
    '<span class="katex-display"><span class="katex"><span class="katex-mathml"><math><semantics>' +
    `<mrow><mi>${tex}</mi></mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math>` +
    '</span></span></span>';
  const eq = katex('E');
  const eqF = katex('F');
  const src = 'https://a.test/i.png';
  const img = `<img src="${src}">`;
  const linked = `<a href="https://a.test/">${img}</a>`;
  const li = (inner: string) => read(`<ul><li>${inner}</li></ul>`);
  const item = (...content: unknown[]) => ['bulleted_list', 0, content];
  const math = (tex: string) => ['math', 1, [{ text: tex }]];
  const image = ['image', 1, src];

  // A child the item hands on ends the line before an equation as a line
  // break does: it goes after the item's text, so nothing of the item's
  // stands beside the equation. Asked only of a line start, E went into the
  // item's text and F after the picture -- F came out before E.
  test('a block the item hands on before the equation ends its line', () => {
    for (const picture of [img, linked]) {
      expect(li(`Text<br>${eq}${picture}${eqF}`)).toEqual([
        item({ text: 'Text' }),
        math('E'),
        image,
        math('F'),
      ]);
    }

    expect(li(`T<br>${img}${eq}`)).toEqual([item({ text: 'T' }), image, math('E')]);
  });

  // The item's text is read before every block it hands on, so text after a
  // block still comes before an equation handed on: it is apart only when
  // nothing the item keeps follows it anywhere in the item.
  test('text the item keeps after a block it hands on keeps the equation in its text', () => {
    expect(li(`Text<br>${eq}${img}After`)).toEqual([
      item({ text: 'Text\n' }, m('E'), { text: '\nAfter' }),
      image,
    ]);
    expect(li(`${eq}${img}Text`)).toEqual([item(m('E'), { text: '\nText' }), image]);
    expect(li(`<span> </span>${eq}<h2>H</h2>Tail`)).toEqual([
      item({ text: ' \n' }, m('E'), { text: '\nTail' }),
      ['heading2', 1, [{ text: 'H' }]],
    ]);
    expect(li(`Text<br>${eq}<p>More</p>After`)).toEqual([
      item({ text: 'Text\n' }, m('E'), { text: '\nMore\nAfter' }),
    ]);
  });

  // An item with no text of its own takes its first paragraph as its text,
  // which reads before every block: an equation before that paragraph would
  // move after it.
  test('a paragraph the item takes as its text keeps the equation before it in its text', () => {
    expect(li(`${eq}<p>More</p>`)).toEqual([item(m('E'), { text: '\nMore' })]);
    expect(li(`${eq}<p>More</p>${eqF}`)).toEqual([item(m('E'), { text: '\nMore' }), math('F')]);
    expect(li(`${img}${eq}<p>More</p>`)).toEqual([
      item(m('E')),
      image,
      ['paragraph', 1, [{ text: 'More' }]],
    ]);
    // With text of its own the item takes no paragraph, and both nest.
    expect(li(`Text<br>${eq}<p>More</p>`)).toEqual([
      item({ text: 'Text' }),
      math('E'),
      ['paragraph', 1, [{ text: 'More' }]],
    ]);
    // A blank paragraph is not taken, and a paragraph before it changes nothing.
    expect(li(`<p>Intro</p>${eq}<p>More</p>`)).toEqual([
      item({ text: 'Intro' }),
      math('E'),
      ['paragraph', 1, [{ text: 'More' }]],
    ]);
  });

  // What decides is what the reader keeps, not what a browser draws: a
  // player, a field or a broken picture leaves nothing in the item.
  test('an element the reader keeps nothing of is passed over', () => {
    for (const nothing of [
      '<video></video>',
      '<audio></audio>',
      '<canvas></canvas>',
      '<embed>',
      '<meter></meter>',
      '<progress></progress>',
      '<input type="hidden">',
      '<input type="text">',
      '<button></button>',
      '<img src="">',
      '<span><hr></span>',
      '<span data-neditor-math=""></span>',
      '<script>s</script>',
      '<style>p{}</style>',
    ]) {
      // (Whether the break before it stays a line of the item's text is
      // the text's own reading: a browser draws the element after it.)
      expect(li(`Text<br>${eq}${nothing}`).slice(1)).toEqual([math('E')]);
      expect(li(`Text<br><span>${nothing}</span>${eq}`).slice(1)).toEqual([math('E')]);
    }
  });

  test('a formula, a picture after it or a to-do box the reader keeps stays beside it', () => {
    expect(li(`Text<br>${eq}<span data-neditor-math="y"></span>`)).toEqual([
      item({ text: 'Text\n' }, m('E'), { text: '\n' }, m('y')),
    ]);
    expect(li(`Text<br>${eq}<span>${img}</span>`)).toEqual([
      item({ text: 'Text\n' }, m('E')),
      image,
    ]);
    expect(li(`Text<br>${eq}<input type="checkbox">`)).toEqual([
      ['todo', 0, [{ text: 'Text\n' }, m('E')]],
    ]);
    // On its line before it, too -- but not a picture, which is handed on
    // after the item's text: there it ends the line, wrapped or bare, and the
    // equation after it goes after it.
    expect(li(`Text<br><span data-neditor-math="y"></span>${eq}`)).toHaveLength(1);
    expect(li(`Text<br><span>${img}</span>${eq}`)).toEqual([
      item({ text: 'Text' }),
      image,
      math('E'),
    ]);
  });

  test('two equations around a wrapped picture keep their order', () => {
    const second = eq.replace(/E/g, 'F');

    for (const picture of [`<span>${img}</span>`, `<b>${linked}</b>`]) {
      expect(li(`${eq}${picture}${second}`)).toEqual([item(m('E')), image, math('F')]);
    }
  });

  // A paragraph after a picture is a block of the item whether the picture is
  // bare or wrapped: asked of a bare one alone, a wrapped picture let the
  // paragraph become the item's text and went after it.
  test('a wrapped picture reads as a bare one does before a paragraph', () => {
    const k = (tex: string) => eq.replace(/E/g, tex);
    const tail = `${k('M0')} ${k('M1')}<p>w1</p><ul><li>w2</li></ul>`;

    expect(read(`<ol><li><span>${img}</span>${tail}</li></ol>`)).toEqual(
      read(`<ol><li>${img}${tail}</li></ol>`),
    );
    expect(read(`<ol><li><span>${img}</span>${tail}</li></ol>`).map((b) => b[0])).toEqual([
      'numbered_list',
      'image',
      'paragraph',
      'bulleted_list',
    ]);
  });

  test('assistive copies in bulk read in linear time, and only a frame asks', () => {
    const copy = '<span class="MJX_Assistive_MathML"> </span>';

    // Outside a MathJax frame the class means nothing: it is text.
    expect(read('<p>a <span class="MJX_Assistive_MathML">x</span> b</p>')).toEqual([
      ['paragraph', 0, [{ text: 'a x b' }]],
    ]);

    expect(
      growth((n) => blocksFromHtml(document, `<p>${`<svg></svg>${copy}`.repeat(n)}</p>`), 200),
    ).toBeLessThan(LINEAR);
    expect(
      growth(
        (n) =>
          blocksFromHtml(
            document,
            `<p><span class="MathJax_SVG">${'<svg></svg>'.repeat(n)}${copy.repeat(n)}</span></p>`,
          ),
        200,
      ),
    ).toBeLessThan(LINEAR);
  }, 60_000);

  test('a copy split out around a glyph picture is judged where it stood', () => {
    const frame = `<span class="MathJax"><nobr><span>y</span>${img}</nobr><span class="MJX_Assistive_MathML"><math><mi>x</mi></math></span></span>`;
    const text = (html: string) =>
      read(html)
        .filter((block) => block[0] === 'paragraph')
        .map((block) => richToPlainText(block[2] as RichText))
        .join('|');

    // Read once -- the drawing, its glyph picture, nothing of the copy -- and
    // nothing of it lost.
    for (const html of [`<p><b>a ${frame} b</b></p>`, `<p>a ${frame} b</p>`]) {
      expect(read(html).map((block) => block[0])).toEqual(['paragraph', 'image', 'paragraph']);
      expect(text(html)).toBe('a y|b');
    }
  });

  test('a copy in a frame drawn as a block is judged where it stands', () => {
    const frame =
      '<div class="MathJax"><nobr><span>y</span></nobr><span class="MJX_Assistive_MathML"><math><mi>x</mi></math></span></div>';

    expect(read(frame)).toEqual([['paragraph', 0, [{ text: 'y' }]]]);
  });

  test('frames nested in frames are read for their text once, not once a level', () => {
    const copy = '<span class="MJX_Assistive_MathML"></span>';

    // Depth and leaves grow together: each frame read the whole subtree below
    // it, so the cost was their product -- with text at the bottom, and with
    // none (pictures only), where nothing ends the search early.
    for (const leaf of ['<b>z</b>', '<span><svg><text>s</text></svg></span>']) {
      expect(
        growth(
          (n) =>
            blocksFromHtml(
              document,
              `<p>${'<span class="MathJax">'.repeat(n)}${leaf.repeat(n * 16)}${`${copy}</span>`.repeat(n)}</p>`,
            ),
          25,
        ),
      ).toBeLessThan(LINEAR);
    }
  }, 60_000);

  test("a frame's drawing is judged by what the reader keeps of it", () => {
    const copy = (tex: string) =>
      `<span class="MJX_Assistive_MathML"><math><mi>${tex}</mi></math></span>`;
    const text = (html: string) => richToPlainText(read(html)[0]?.[2] as RichText);

    // An SVG wrapped in a span draws no text either: the copy is read.
    expect(
      text(
        `<p>a <span class="MathJax_SVG"><span><svg><text>s</text></svg></span>${copy('X')}</span> b</p>`,
      ),
    ).toBe('a X b');
    // Nor does what the reader skips: a <noscript> is no drawing.
    for (const skipped of ['<noscript>n</noscript>', '<span><noscript>n</noscript></span>']) {
      expect(text(`<p>a <span class="MathJax">${skipped}${copy('X')}</span> b</p>`)).toBe('a X b');
    }
    // A nested frame drawing nothing has its copy read -- text the outer
    // frame draws, so the outer copy is the duplicate.
    expect(
      text(
        `<p>a <span class="MathJax"><span class="MathJax_SVG"><svg></svg>${copy('I')}</span>${copy('O')}</span> b</p>`,
      ),
    ).toBe('a I b');
  });

  test('frames nested 3,000 deep, each copy before the next frame, read without overflowing', () => {
    const copy = '<span class="MJX_Assistive_MathML"><math><mi>x</mi></math></span>';
    const n = 3000;
    let blocks: Block[] = [];

    expect(() => {
      blocks = blocksFromHtml(
        document,
        `<p>${`<span class="MathJax">${copy}`.repeat(n)}<span>y</span>${'</span>'.repeat(n)}</p>`,
      );
    }).not.toThrow();
    // Past the inline nesting bound the rest is read whole, and every frame
    // here draws the "y": not one copy is read, there either.
    expect(blocks.map((block) => blockText(block)).join('')).toBe('y');
  });

  test('frames nested 5,000 deep in MathJax order, copy last, read without overflowing', () => {
    const copy = '<span class="MJX_Assistive_MathML"><math><mi>x</mi></math></span>';
    const n = 5000;

    expect(() =>
      blocksFromHtml(
        document,
        `<p>${'<span class="MathJax"><span>y</span>'.repeat(n)}${`${copy}</span>`.repeat(n)}</p>`,
      ),
    ).not.toThrow();
  });

  test('a formula with no TeX in a <pre> is read once, as its drawing', () => {
    const code = (html: string) => richToPlainText(read(`<pre>${html}</pre>`)[0]?.[2] as RichText);

    expect(
      code(
        'a <span class="MathJax"><nobr>y</nobr><span class="MJX_Assistive_MathML"><math><mi>x</mi></math></span></span> b',
      ),
    ).toBe('a y b');
    expect(
      code(
        'a <span class="katex"><span class="katex-mathml"><math><mi>x</mi></math></span><span class="katex-html">y</span></span> b',
      ),
    ).toBe('a y b');
  });

  test('a line break followed only by a copy the reader skips is filler, as in a <pre>', () => {
    const lines = (html: string) => blockText(blocksFromHtml(document, html)[0]!);

    expect(
      lines(
        '<p><span class="MathJax"><nobr>y<br></nobr><span class="MJX_Assistive_MathML"><math><mi>x</mi></math></span></span></p>',
      ),
    ).toBe('y');
    expect(
      lines(
        '<p>a<br><span class="katex"><span class="katex-mathml"><math><mi>x</mi></math></span><span class="katex-html"></span></span></p>',
      ),
    ).toBe('a');
  });

  test('a linked picture beside a copy the reader skips is still only a picture', () => {
    const katex =
      '<span class="katex"><span class="katex-mathml"><math><mi>x</mi></math></span><span class="katex-html"></span></span>';
    const item = (inner: string) =>
      blocksFromHtml(document, `<ul><li><a href="https://a.test/">${inner}</a></li></ul>`).map(
        (block) => [block.type, block.src ?? ''],
      );

    expect(item(`${img}${katex}`)).toEqual(item(img));
  });

  test('a line break before a formula that draws no text is a line break', () => {
    const host = document.createElement('div');
    host.innerHTML =
      'a<br><span data-neditor-math="\\quad" contenteditable="false"><span class="katex"><span class="katex-mathml"><math><semantics><mspace width="1em"></mspace><annotation encoding="application/x-tex">\\quad</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="mspace"></span></span></span></span>';

    expect(parseRichText(host)).toEqual([{ text: 'a\n' }, { text: '\uFFFC', math: '\\quad' }]);
  });

  test("KaTeX's skipped copy is nothing the item or the figure keeps", () => {
    const tex = (inner: string) =>
      `<span class="katex"><span class="katex-mathml"><math><mi>x</mi></math></span><span class="katex-html">${inner}</span></span>`;
    const display = eq.replace(/E/g, 'D');
    const shape = (html: string) =>
      blocksFromHtml(document, html).map((block) => [block.type, block.depth, block.src ?? '']);

    expect(
      shape(`<ul><li>T<br>${tex('<span class="mspace"></span>')}${display}</li></ul>`),
    ).toEqual(shape(`<ul><li>T<br>${display}</li></ul>`));
    expect(shape(`<ul><li>${display}${tex('<span class="mspace"></span>')}</li></ul>`)).toEqual(
      shape(`<ul><li>${display}</li></ul>`),
    );
    expect(
      blocksFromHtml(document, `<figure>${img}${tex('')}<figcaption>cap</figcaption></figure>`).map(
        (block) => [block.type, blockText(block)],
      ),
    ).toEqual([['image', 'cap']]);
  });

  test('a picture inside a copy the reader skips is no picture of the item', () => {
    const inner = `t<span class="katex-mathml">${img}</span><span class="katex-html">h</span>`;

    expect(blocksFromHtml(document, `<ul><li>${inner}</li></ul>`).map((b) => b.type)).toEqual([
      'bulleted_list',
    ]);

    // Nor does it make the paragraph after it a block of the item.
    const before = (copy: string) =>
      blocksFromHtml(
        document,
        `<ol><li><span>T</span><span class="katex"><span class="katex-mathml">${copy}</span><span class="katex-html">h</span></span><p>w1</p></li></ol>`,
      ).map((b) => [b.type, b.depth]);
    expect(before(img)).toEqual(before(''));
  });

  test('a figure takes the picture it shows, not one inside what the reader skips', () => {
    const j = '<img src="https://x.test/j.png" alt="j">';
    const hidden = '<img src="https://x.test/i.png" alt="i">';

    for (const skipped of [
      `<span class="katex"><span class="katex-mathml">${hidden}</span><span class="katex-html"></span></span>`,
      `<noscript>${hidden}</noscript>`,
    ]) {
      expect(
        blocksFromHtml(document, `<figure>${skipped}${j}<figcaption>cap</figcaption></figure>`).map(
          (block) => [block.type, block.src, blockText(block)],
        ),
      ).toEqual([['image', 'https://x.test/j.png', 'cap']]);
    }
  });

  test('a loose copy holding a picture makes no paragraph after it a block', () => {
    const item = (copy: string) =>
      blocksFromHtml(
        document,
        `<ol><li><span>T</span><span class="katex-mathml">${copy}</span><span class="katex-html">h</span><p>w1</p></li></ol>`,
      ).map((b) => [b.type, blockText(b)]);

    expect(item(img)).toEqual(item(''));
  });

  test('a checkbox inside a copy the reader skips makes no to-do', () => {
    expect(
      blocksFromHtml(
        document,
        '<ul><li>t<span class="katex"><span class="katex-mathml"><input type="checkbox" checked></span><span class="katex-html">h</span></span></li></ul>',
      ).map((b) => b.type),
    ).toEqual(['bulleted_list']);
  });

  test('a formula is never entered when judging content: with no TeX it is nothing', () => {
    const raw = (html: string) => {
      const host = document.createElement('div');
      host.innerHTML = html;
      return richToPlainText(parseRichText(host));
    };

    expect(
      raw(
        'a<br><span class="katex"><span class="katex-mathml"><math><semantics><mi>x</mi><annotation encoding="application/x-tex"></annotation></semantics></math></span><span class="katex-html">x</span></span>',
      ),
    ).toBe('a');
    expect(raw('a<br><math alttext=""><mi>x</mi></math>')).toBe('a');

    // And never searched once a level: nested formulas whose TeX is empty --
    // an empty annotation, an empty `alttext`, at the bottom of the chain --
    // each a formula, each searched to the bottom when it was entered. The
    // host is built outside the timing, which measures the read alone.
    for (const [open, bottom] of [
      [
        '<span class="katex">',
        '<math><semantics><mi>x</mi><annotation encoding="application/x-tex"></annotation></semantics></math>',
      ],
      ['<span class="mwe-math-element">', '<math alttext=""><mi>x</mi></math>'],
    ] as const) {
      expect(
        growthOf((n) => {
          const host = document.createElement('div');
          host.innerHTML = `a<br>${open.repeat(n)}${bottom}${'</span>'.repeat(n)}z`;
          return () => parseRichText(host);
        }, 150),
      ).toBeLessThan(LINEAR);
    }
  }, 60_000);

  test('what the reader skips holds no break or block of its own', () => {
    const shape = (html: string) =>
      blocksFromHtml(document, html).map((b) => [b.type, blockText(b)]);

    // A <br> in an <object> fallback is no line of the reader's.
    expect(shape('<p>a</p><span><object data="v.swf"><br></object></span><p>b</p>')).toEqual(
      shape('<p>a</p><span><object data="v.swf"></object></span><p>b</p>'),
    );
    // Nor is a block in one a block that splits the line.
    expect(shape(`<p>a<span>x<object><div>d</div></object>${img}z</span></p>`)).toEqual(
      shape(`<p>a<span>x<object></object>${img}z</span></p>`),
    );
    // And a picture in a skipped copy at a paste's start is no content there.
    const edge = (inner: string) =>
      blocksFromHtml(
        document,
        `<span class="x"><span class="katex-mathml">${inner}</span><span class="katex-html"> </span></span>Hello`,
      ).map((b) => blockText(b));
    expect(edge(img)).toEqual(edge(''));
  });

  test('a list item inside what the reader skips makes no wrapper of items', () => {
    const runs = (html: string) => blocksFromHtml(document, html).map((b) => b.content);

    expect(
      runs('<ul><a href="https://e.test/">Docs<noscript><li>x</li></noscript></a><li>b</li></ul>'),
    ).toEqual(runs('<ul><a href="https://e.test/">Docs<noscript></noscript></a><li>b</li></ul>'));
    expect(runs('<ul><b>Bold<object><li>x</li></object></b><li>b</li></ul>')).toEqual(
      runs('<ul><b>Bold<object></object></b><li>b</li></ul>'),
    );
    expect(
      blocksFromHtml(
        document,
        '<ul><table><tr><td>cell<noscript><li>x</li></noscript></td></tr></table><li>a</li></ul>',
      ).map((b) => b.type),
    ).toContain('table');
  });

  test('a skipped element holding a block is no block itself', () => {
    const runs = (inner: string) =>
      blocksFromHtml(document, `<b><span>a</span>\n${inner}\n<span>b</span><div>c</div></b>`).map(
        (b) => b.content,
      );

    expect(runs('<noscript><div>n</div></noscript>')).toEqual(runs('<noscript></noscript>'));
  });

  test('a quote or a <details> takes no list or summary from what the reader skips', () => {
    const shape = (html: string) =>
      blocksFromHtml(document, html).map((b) => [b.type, blockText(b)]);

    expect(
      shape('<blockquote>Quote<noscript><ul><li>Enable JS</li></ul></noscript></blockquote>'),
    ).toEqual(shape('<blockquote>Quote<noscript></noscript></blockquote>'));
    expect(
      shape(
        '<details><noscript><summary>JS off</summary></noscript><summary>Title</summary>Body</details>',
      )[0],
    ).toEqual(['toggle', 'Title']);
    // After other content: a `<details>` on the paste's start edge with no
    // summary the reader takes -- `<object>` is never read -- is a drag begun
    // in its body, read as a container (`HEADLESS_DETAILS`).
    expect(
      shape('<p>x</p><details><object><summary>F</summary></object>Body</details>')[1],
    ).toEqual(['toggle', '']);
  });

  test('whitespace TeX is no TeX anywhere', () => {
    const shape = (html: string) =>
      blocksFromHtml(document, html).map((b) => [b.type, b.depth, blockText(b)]);

    expect(
      shape(
        `<figure>${img}<span data-neditor-math=" "></span><figcaption>cap</figcaption></figure>`,
      ),
    ).toEqual(shape(`<figure>${img}<figcaption>cap</figcaption></figure>`));
    expect(
      shape(
        '<figure><b>w</b><figcaption>c</figcaption><span data-neditor-math=" "></span></figure>',
      ),
    ).toEqual(shape('<figure><b>w</b><figcaption>c</figcaption></figure>'));
    expect(
      shape(
        '<ul><li><span data-neditor-math=" "></span><div data-neditor-math-block="x"></div></li></ul>',
      ),
    ).toEqual(
      shape(
        '<ul><li><span data-neditor-math=""></span><div data-neditor-math-block="x"></div></li></ul>',
      ),
    );
  });

  test("an empty formula at a paste's edge is nothing there", () => {
    const shape = (html: string) => blocksFromHtml(document, html).map((b) => [b.type, b.content]);

    expect(shape('<b><span data-neditor-math=""></span>\n</b>')).toEqual(
      shape('<b><span></span>\n</b>'),
    );
    // Nor in a code block's text.
    expect(shape('<pre>a<span data-neditor-math=""></span>b</pre>')).toEqual(
      shape('<pre>ab</pre>'),
    );
  });

  test('past the inline nesting bound an empty formula is nothing either', () => {
    const deep = (inner: string) => `<p>${'<b>'.repeat(2100)}${inner}${'</b>'.repeat(2100)}</p>`;

    expect(
      blocksFromHtml(document, deep('a<span data-neditor-math=""></span>b')).map(blockText),
    ).toEqual(blocksFromHtml(document, deep('ab')).map(blockText));
  });

  test('a formula with no TeX is nothing beside a picture', () => {
    const empty =
      '<span class="katex"><span class="katex-mathml"><math><semantics><mi>x</mi><annotation encoding="application/x-tex"></annotation></semantics></math></span><span class="katex-html">x</span></span>';
    const shape = (html: string) =>
      blocksFromHtml(document, html).map((b) => [b.type, b.depth, blockText(b)]);

    expect(shape(`<figure>${img}${empty}<figcaption>cap</figcaption></figure>`)).toEqual(
      shape(`<figure>${img}<span></span><figcaption>cap</figcaption></figure>`),
    );
    expect(shape(`<ul><li><a href="https://a.test/">${img}${empty}</a></li></ul>`)).toEqual(
      shape(`<ul><li><a href="https://a.test/">${img}</a></li></ul>`),
    );
  });

  test("a formula in a MathJax frame is the frame's drawing, bare or wrapped", () => {
    for (const formula of [
      '<span data-neditor-math="x"></span>',
      '<span><span data-neditor-math="x"></span></span>',
    ]) {
      const host = document.createElement('div');
      host.innerHTML = `a<span class="MathJax">${formula}<span class="MJX_Assistive_MathML"><math><mi>y</mi></math></span></span>b`;

      expect(parseRichText(host)).toEqual([
        { text: 'a' },
        { text: '\uFFFC', math: 'x' },
        { text: 'b' },
      ]);
    }
  });

  test("KaTeX's copy loose in a MathJax frame is no drawing either", () => {
    const katex =
      '<span class="katex-mathml"><math><mi>k</mi></math></span><span class="katex-html"></span>';
    const copy = '<span class="MJX_Assistive_MathML"><math><mi>X</mi></math></span>';

    for (const parts of [katex, `<span>${katex}</span>`]) {
      expect(read(`<p>a <span class="MathJax">${parts}${copy}</span> b</p>`)[0]?.[2]).toEqual([
        { text: 'a X b' },
      ]);
    }
  });

  test('a copy beside a wrapped <details> summary is read once', () => {
    const blocks = read(
      '<details open><span class="MathJax"><span><summary>y</summary></span><span class="MJX_Assistive_MathML"><math><mi>X</mi></math></span></span><p>b</p></details>',
    );

    expect(JSON.stringify(blocks)).not.toContain('"X"');
    expect(blocks[0]?.[0]).toBe('toggle');
  });

  test('the summary left out of the body is the one read as the title', () => {
    const shape = (html: string) =>
      blocksFromHtml(document, html).map((b) => [b.type, b.depth, blockText(b)]);

    // The first `katex-mathml` is no copy (no drawing follows it), so "Title"
    // is the title. Searched for again in a copy that lacks the second one,
    // the body lost "Second" and kept "Title".
    expect(
      shape(
        '<details open><div class="katex-mathml"><summary>Title</summary></div><span class="katex-mathml">m</span><span class="katex-html">h</span><p>body</p><summary>Second</summary></details>',
      ),
    ).toEqual([
      ['toggle', 0, 'Title'],
      ['paragraph', 1, 'h'],
      ['paragraph', 1, 'body'],
      ['paragraph', 1, 'Second'],
    ]);
  });

  test('a wrapped summary beside one the reader skips is read once', () => {
    const shape = (html: string) =>
      blocksFromHtml(document, html).map((b) => [b.type, b.depth, blockText(b)]);

    // A summary in a `<noscript>` is no title, and no body either.
    expect(
      shape(
        '<details open><span><noscript><summary>N</summary></noscript><summary>T</summary></span>body</details>',
      ),
    ).toEqual([
      ['toggle', 0, 'T'],
      ['paragraph', 1, 'body'],
    ]);
  });

  test("a nested <details>' summary is its own title, never the outer one's", () => {
    const shape = (html: string) =>
      blocksFromHtml(document, html).map((b) => [b.type, b.depth, blockText(b)]);

    // After other content, as above: on the paste's start edge the outer one
    // has no summary of its own and is a drag begun in its body -- WebKit's
    // content `<span>` around a nested one is this shape (`HEADLESS_DETAILS`).
    expect(
      shape(
        '<p>x</p><details open><div><details open><summary>Inner</summary>ib</details></div>body</details>',
      ),
    ).toEqual([
      ['paragraph', 0, 'x'],
      ['toggle', 0, ''],
      ['toggle', 1, 'Inner'],
      ['paragraph', 2, 'ib'],
      ['paragraph', 1, 'body'],
    ]);
    expect(
      shape(
        '<details open><details open><summary>Inner</summary>ib</details><summary>Outer</summary>body</details>',
      ),
    ).toEqual([
      ['toggle', 0, 'Outer'],
      ['toggle', 1, 'Inner'],
      ['paragraph', 2, 'ib'],
      ['paragraph', 1, 'body'],
    ]);
  });

  test('and each <details> searches only its own part of the tree for one', () => {
    // Searched past the <details> inside it, every level walked the whole
    // subtree below it: quadratic in the nesting.
    expect(
      growth(
        (n) =>
          blocksFromHtml(document, `${'<details><p>x</p>'.repeat(n)}${'</details>'.repeat(n)}`),
        60,
      ),
    ).toBeLessThan(LINEAR);
  }, 60_000);

  test('a <details> inside a copy keeps its own title, read once', () => {
    const shape = (html: string) =>
      blocksFromHtml(document, html).map((b) => [b.type, b.depth, blockText(b)]);
    const nested = [
      ['toggle', 0, 'A'],
      ['toggle', 1, 'B'],
      ['paragraph', 2, 'bb'],
      ['paragraph', 1, 'aa'],
    ];

    expect(
      shape(
        '<details open><span><summary>A</summary><details open><span><summary>B</summary></span>bb</details></span>aa</details>',
      ),
    ).toEqual(nested);
    expect(
      shape(
        '<details open><span><summary>A</summary><details open><summary>B</summary>bb</details></span>aa</details>',
      ),
    ).toEqual(nested);
    expect(
      shape(
        '<details open><span><summary>A</summary></span><span><details open><b><summary>B</summary></b>bb</details></span></details>',
      ),
    ).toEqual([
      ['toggle', 0, 'A'],
      ['toggle', 1, 'B'],
      ['paragraph', 2, 'bb'],
    ]);
    // Copied again, to carry the bold inward: the title noted for the first
    // copy goes with the second.
    expect(
      shape(
        '<details open><span><summary>A</summary></span><b><details open><span><summary>B</summary></span>bb</details></b></details>',
      ),
    ).toEqual([
      ['toggle', 0, 'A'],
      ['toggle', 1, 'B'],
      ['paragraph', 2, 'bb'],
    ]);
  });

  test("at the nesting bound a list's loose run is one remainder, and what the reader skips stays out", () => {
    const deep = (inner: string) => `${'<div>'.repeat(1023)}${inner}${'</div>'.repeat(1023)}`;

    expect(
      blocksFromHtml(
        document,
        deep(
          '<ul><li>a</li><script>var secret=1</script>x <b>y</b> z<style>p{color:red}</style></ul>',
        ),
      ).map(blockText),
    ).toEqual(['a', 'x y z']);
  });

  test('a <details> whose wrapped summary is taken out reads as it does alone', () => {
    // Taken out where it stands, what the readers had learned about the
    // elements around it was still about the summary: the line break in the
    // cell beside the picture it held was lost.
    const shape = (html: string) =>
      blocksFromHtml(document, html).map((b) => [b.type, b.depth, blockText(b)]);
    const inner =
      '<details open>k<td><summary><img src="https://e.x/a.png" alt="al"></summary><br></td></details>';

    // The summary's picture is handed on as the toggle's first child (R1
    // reader-2), ahead of the body: what is pinned here is the body's line
    // break, which the stale image memo lost.
    expect(shape(inner)).toEqual([
      ['toggle', 0, ''],
      ['image', 1, ''],
      ['paragraph', 1, 'k\n'],
    ]);
    expect(shape(`<details open><div>${inner}<summary>O</summary></div></details>`)).toEqual([
      ['toggle', 0, 'O'],
      ['toggle', 1, ''],
      ['image', 2, ''],
      ['paragraph', 2, 'k\n'],
    ]);
    // Every element from the summary up to its <details>, not just its parent.
    const wrapped = inner.replace(/<summary>.*<\/summary>/, '<b>$&</b>');

    expect(shape(`<details open><div>${wrapped}<summary>O</summary></div></details>`)).toEqual([
      ['toggle', 0, 'O'],
      ['toggle', 1, ''],
      ['image', 2, ''],
      ['paragraph', 2, 'k\n'],
    ]);
  });

  test.each([
    [
      'beside its text',
      '<details><summary>Title<img src=https://e.x/a.png></summary>body</details>',
      'Title',
    ],
    ['alone', '<details><summary><img src=https://e.x/a.png></summary>body</details>', ''],
    [
      'wrapped',
      '<details><b><summary>Title<img src=https://e.x/a.png></summary></b>body</details>',
      'Title',
    ],
  ])("a summary's picture %s is the toggle's first child", (_, html, title) => {
    // R1 reader-2: a heading's, a quote's and a cell's pictures are handed on
    // as image blocks; a summary's went nowhere. The title reads as before.
    expect(
      blocksFromHtml(document, html).map((b) => [b.type, b.depth, blockText(b), b.src ?? null]),
    ).toEqual([
      ['toggle', 0, title, null],
      ['image', 1, '', 'https://e.x/a.png'],
      ['paragraph', 1, 'body', null],
    ]);
  });

  test('a wrapped summary leaves the body reading as a direct one does', () => {
    // Copied instead, the body lost what it inherited where it stood.
    const shape = (html: string) =>
      blocksFromHtml(document, html).map((b) => [b.type, b.depth, blockText(b)]);
    const both = (direct: string) => [
      direct,
      direct.replace(/<summary>(.*?)<\/summary>/, '<i>$&</i>'),
    ];

    for (const direct of [
      '<div style="white-space:pre-wrap"><details open><summary>T</summary>a\nb\tc</details></div>',
      '<p>q</p><details open><summary>T</summary>x </details>',
      '<details open><summary><div>T</div></summary><span>ab</span>y</details>',
    ]) {
      const [plain, wrapped] = both(direct);

      expect(shape(wrapped!)).toEqual(shape(plain!));
    }
    expect(
      shape(
        '<div style="white-space:pre-wrap"><details open><i><summary>T</summary></i>a\nb\tc</details></div>',
      ),
    ).toEqual([
      ['toggle', 0, 'T'],
      ['paragraph', 1, 'a\nb\tc'],
    ]);
    // An edge of the paste the title held is none of the body's: the space
    // after it is collapsed, as after a direct summary.
    expect(shape('<details open><i><summary>T</summary> x</i>y</details>')).toEqual(
      shape('<details open><summary>T</summary><i> x</i>y</details>'),
    );
    // A block in the summary, which the readers had found below its wrapper
    // before it was taken out, splits nothing.
    expect(
      shape('<b><details open><span>a<summary><div>T</div></summary>b</span>y</details></b>'),
    ).toEqual([
      ['toggle', 0, 'T'],
      ['paragraph', 1, 'aby'],
    ]);
  });

  test("a formatting wrapper's blocks keep the white-space around it", () => {
    expect(
      blocksFromHtml(document, '<div style="white-space:pre-wrap"><b>a  b<p>c</p></b></div>').map(
        blockText,
      ),
    ).toEqual(['a  b', 'c']);
  });

  test("a paste's edges in a toggle are judged in the order it is read: title, then body", () => {
    const body = (html: string) => blocksFromHtml(document, html).slice(1).map(blockText);

    for (const [wrapped, direct] of [
      // The paste starts with the toggle, so no text of the body is at its
      // start, even the text before a wrapped summary.
      [
        '<details open> x<span><summary>T</summary></span></details>',
        '<details open><summary>T</summary> x<span></span></details>',
      ],
      [
        '<details open><span> x<summary>T</summary></span>y </details>',
        '<details open><summary>T</summary><span> x</span>y </details>',
      ],
      // A paste whose last text is in the title ends with the body's.
      [
        '<details open><i>x <summary>T</summary></i></details>',
        '<details open><summary>T</summary><i>x </i></details>',
      ],
    ]) {
      expect(body(wrapped!)).toEqual(body(direct!));
    }
    expect(body('<details open><summary></summary> x</details>')).toEqual(['x']);
    expect(body('<details open>x <summary>T</summary></details>')).toEqual(['x ']);
  });

  test('a wrapped summary keeps the formatting of what wraps it, as a direct one does', () => {
    const read = (html: string) => blocksFromHtml(document, html).map((b) => [b.type, b.content]);
    const bold = [{ text: 'T', marks: ['bold'] }];

    // A `<b>` around the whole toggle: its shell went around the `<span>`,
    // above the summary the title is read from, and the title read plain.
    expect(read('<b><details open><span><summary>T</summary></span> z</details></b>')).toEqual(
      read('<b><details open><summary>T</summary> z</details></b>'),
    );
    expect(read('<b><details open><span><summary>T</summary></span> z</details></b>')[0]).toEqual([
      'toggle',
      bold,
    ]);
    expect(
      read(
        '<a href="https://x.test/"><details open><span><summary>T</summary></span></details></a>',
      ),
    ).toEqual([['toggle', [{ text: 'T', link: 'https://x.test/' }]]]);
    // Written around the summary itself, by tag or by style.
    expect(read('<details open><b><summary>T</summary></b> z</details>')).toEqual([
      ['toggle', bold],
      ['paragraph', [{ text: 'z' }]],
    ]);
    expect(
      read('<details open><span style="font-weight:bold"><summary>T</summary></span></details>'),
    ).toEqual([['toggle', bold]]);
    // By the distribution's two rules, the title reads as the body text beside
    // it under the same wrappers: a wrapper holding a block is taken up, the
    // outermost winning; one holding none is read where it stands, the
    // nearest winning; a structure element hands on nothing (a `<figure>` is
    // one, though no block tag).
    const formatOf = (blocks: ReturnType<typeof read>, text: string) => {
      const run = blocks
        .flatMap(([, content]) => content as RichText)
        .find((candidate) => candidate.text.includes(text))!;

      return [[...(run.marks ?? [])].sort(), run.link ?? null];
    };

    for (const [open, close] of [
      ['<div style="font-weight:bold">', '</div>'],
      ['<figure style="font-weight:bold">', '</figure>'],
      ['<b><i style="font-weight:normal">', '</i></b>'],
      ['<i style="font-weight:normal">', '</i>'],
      ['<b><span style="font-weight:normal">', '</span></b>'],
      ['<span style="font-weight:normal"><b>', '</b></span>'],
      ['<span style="text-decoration:underline"><s>', '</s></span>'],
      ['<a href="https://x.test/"><span style="font-style:normal">', '</span></a>'],
      // A block on the way down to the summary: the wrapper above holds it.
      ['<b><i style="font-weight:normal"><div>', '</div></i></b>'],
    ]) {
      // A summary that holds blocks of its own -- GitHub's READMEs write
      // `<summary><h3>` -- says nothing about its wrappers: the body is read
      // with the summary taken out, and the title by the same answer.
      for (const title of [
        'T',
        '<p>T</p>',
        '<h3>T</h3>',
        'T<details open><summary>i</summary>q</details>',
      ]) {
        for (const body of [' z', '<p>z</p>']) {
          const blocks = read(
            `<details open>${open}<summary>${title}</summary>${body}${close}</details>`,
          );

          expect(formatOf(blocks, 'T'), `${open} ${title} ${body}`).toEqual(formatOf(blocks, 'z'));
        }
      }
    }
    // An assistive copy is no block to the reader, though written as a
    // `<div>`: the wrapper holding it reads in place.
    expect(
      formatOf(
        read(
          '<details open><b><i style="font-weight:normal"><summary>T</summary><div class="katex-mathml">m</div><span class="katex-html">h</span> z</i></b></details>',
        ),
        'T',
      ),
    ).toEqual([['italic'], null]);
    // The cases round 25 read wrong, taking the outermost of wrappers that
    // hold no block: the title took a mark the browser does not draw.
    expect(
      read(
        '<b><details open><span style="font-weight:400"><summary>Title</summary> body</span></details></b>',
      ),
    ).toEqual([
      ['toggle', [{ text: 'Title' }]],
      ['paragraph', [{ text: 'body' }]],
    ]);
    expect(
      read('<details open><b><i style="font-weight:normal"><summary>T</summary></i></b></details>'),
    ).toEqual([['toggle', [{ text: 'T', marks: ['italic'] }]]]);
    expect(
      read(
        '<details open><span style="text-decoration:underline"><s><summary>T</summary></s></span></details>',
      ),
    ).toEqual([['toggle', [{ text: 'T', marks: ['underline', 'strikethrough'] }]]]);
    // Round 26 asked whether a wrapper held a block with the summary still in
    // it, so a block in the summary brought the outermost-first reading back.
    expect(
      read(
        '<details open><span style="text-decoration:underline"><s><summary><h3>T</h3></summary> body</s></span></details>',
      ),
    ).toEqual([
      ['toggle', [{ text: 'T', marks: ['underline', 'strikethrough'] }]],
      ['paragraph', [{ text: 'body', marks: ['underline', 'strikethrough'] }]],
    ]);
    expect(
      read(
        '<details open><b><blockquote><span style="font-weight:normal"><summary><p>T</p></summary> z</span></blockquote></b></details>',
      )[0],
    ).toEqual(['toggle', [{ text: 'T' }]]);
    // Holding a block, the `<b>` is taken up, and a wrapper that only turns a
    // mark off is no wrapper to the distribution: bold, as its body is.
    expect(
      read(
        '<details open><b><span style="font-weight:normal"><summary>T</summary><p>z</p></span></b></details>',
      ),
    ).toEqual([
      ['toggle', [{ text: 'T', marks: ['bold'] }]],
      ['paragraph', [{ text: 'z', marks: ['bold'] }]],
    ]);
    // An href is a link only through `sanitizeUrl`, as everywhere else.
    expect(
      read('<details open><a href="javascript:alert(1)"><summary>T</summary></a></details>'),
    ).toEqual([['toggle', [{ text: 'T' }]]]);
    // The title's own formatting wins over what wraps it.
    expect(
      read(
        '<details open><b><summary><span style="font-weight:normal">T</span></summary></b></details>',
      ),
    ).toEqual([['toggle', [{ text: 'T' }]]]);
    // A wrapper an outer shell has already spent has its formatting in the
    // summary, run by run; given it again, the title took it where the
    // distribution leaves none, on the space that starts it.
    expect(
      read(
        '<div style="white-space:pre-wrap"><i><details open><b><summary> <span>T</span></summary><p>x</p></b></details></i></div>',
      ),
    ).toEqual(
      read(
        '<div style="white-space:pre-wrap"><i><details open><summary> <b><span>T</span></b></summary><b><p>x</p></b></details></i></div>',
      ),
    );
    // Read where the summary stands: a shell inside it took a MathJax frame's
    // assistive copy away from the frame, and the formula read twice.
    expect(
      read(
        '<details open><b><summary class="MathJax"><span>y</span><span class="MJX_Assistive_MathML"><math><mi>X</mi></math></span></summary></b><p>z</p></details>',
      ),
    ).toEqual([
      ['toggle', [{ text: 'y', marks: ['bold'] }]],
      ['paragraph', [{ text: 'z' }]],
    ]);
  });

  test("a formatting wrapper's copy keeps the paste's edge and the wrapper's layout", () => {
    expect(blocksFromHtml(document, '<b><p>y</p>x </b>').map(blockText)).toEqual(['y', 'x ']);
    // A shell of two wrappers, each of them at the edge.
    expect(
      blocksFromHtml(document, '<b><a href="https://x.test/"><p>y</p>x </a></b>').map(blockText),
    ).toEqual(['y', 'x ']);
    expect(
      blocksFromHtml(document, '<b style="display:flex">a<span>x</span><p>b</p></b>').map(
        blockText,
      ),
    ).toEqual(['a\nx', 'b']);
  });

  test('at the nesting bound a direct summary is read once', () => {
    const deep = (inner: string) => `${'<div>'.repeat(1023)}${inner}${'</div>'.repeat(1023)}`;

    expect(
      blocksFromHtml(document, deep('<details open><summary>Title</summary>body</details>')).map(
        blockText,
      ),
    ).toEqual(['Title', 'body']);
  });

  test('a copied <details> read as text keeps its wrapped title', () => {
    const shape = (html: string) =>
      blocksFromHtml(document, html).map((b) => [b.type, blockText(b)]);
    const inner = (title: string, body: string) =>
      `<details open><span><summary>${title}</summary></span>${body}</details>`;
    // Read as text in the outer toggle's body, or in a formatting shell's copy.
    const outer = (html: string) =>
      `<details open><span><summary>Outer</summary></span>${html}</details>`;

    expect(shape(outer(`<blockquote>${inner('Inner', 'body')}</blockquote>`))).toEqual([
      ['toggle', 'Outer'],
      ['quote', 'Inner\nbody'],
    ]);
    expect(shape(outer(`<table><tr><td>${inner('Cell title', 'c')}</td></tr></table>`))).toEqual([
      ['toggle', 'Outer'],
      ['table', 'Cell title\nc'],
    ]);
    expect(shape(outer(`<ul><li>${inner('Item title', 'c')}</li></ul>`))).toEqual([
      ['toggle', 'Outer'],
      ['bulleted_list', 'Item title\nc'],
    ]);
    expect(shape(outer(`<h2>${inner('Heading title', '')}</h2>`))).toEqual([
      ['toggle', 'Outer'],
      ['heading2', 'Heading title'],
    ]);
    expect(shape(outer(`<pre>${inner('Code title', 'code')}</pre>`))).toEqual([
      ['toggle', 'Outer'],
      ['code', 'Code title\ncode'],
    ]);
    expect(shape(`<b>x<blockquote>${inner('Inner', 'body')}</blockquote></b>`)).toEqual([
      ['paragraph', 'x'],
      ['quote', 'Inner\nbody'],
    ]);
  });

  test('nested wrapped summaries and nested loose list content read in linear time', () => {
    const shapes: ReadonlyArray<readonly [string, string]> = [
      ['<details><span><summary>s</summary></span><p>x</p>', '</details>'],
      ['<details><span><summary>s</summary><p>x</p>', '</span></details>'],
      ['<ul><div>x', '</div></ul>'],
      // A title after its body holds the paste's last text at every level, so
      // each toggle looks for the end of its body again: walking the whole
      // body to find it was quadratic in the nesting.
      [`<details>${'<p>x</p>'.repeat(5)}`, '<summary>s</summary></details>'],
      [`<details>${'<p>x</p>'.repeat(5)}`, '<span><summary>s</summary></span></details>'],
      // A title asks of each wrapper around it whether it holds a block other
      // than the summary: one question a child, wherever the summary is.
      ['<details><span><summary><h3>s</h3></summary><p>x</p>', '</span></details>'],
      [`<details><b>${'<i>y</i>'.repeat(5)}<summary><h3>s</h3></summary>`, '</b></details>'],
    ];

    for (const [open, close] of shapes) {
      expect(
        growth((n) => blocksFromHtml(document, `${open.repeat(n)}${close.repeat(n)}`), 25),
      ).toBeLessThan(LINEAR);
    }
  }, 120_000);

  test('a stand-in for a KaTeX drawing keeps the copy before it a copy', () => {
    const read = (html: string) => blocksFromHtml(document, html).map((b) => [b.type, b.content]);

    // A wrapped summary that was the drawing is read as the title and taken
    // out behind a stand-in; judged by what now came next, the MathML copy
    // before it turned into content, and the formula read twice.
    expect(
      read(
        '<details open><span><span class="katex-mathml">m</span><summary class="katex-html">T</summary> z</span></details>',
      ),
    ).toEqual(
      read(
        '<details open><span class="katex-mathml">m</span><summary class="katex-html">T</summary> z</details>',
      ),
    );
    // And a copy holding a block made each wrapper around the summary a
    // holder of blocks to the body, though not to the title.
    expect(
      read(
        '<details open><b><i style="font-weight:normal"><span class="katex-mathml"><div>m</div></span><summary class="katex-html">T</summary> z</i></b></details>',
      ),
    ).toEqual([
      ['toggle', [{ text: 'T', marks: ['italic'] }]],
      ['paragraph', [{ text: 'z', marks: ['italic'] }]],
    ]);
  });

  test('a run put together around pictures judges a copy as it stood', () => {
    const text = (html: string) =>
      blocksFromHtml(document, html).map((b) => (b.type === 'image' ? 'IMG' : blockText(b)));

    // Where it stands each `katex-mathml` is no copy: what comes next is a
    // `<span>` or an `<img>`. Pieces from two levels of a wrapper holding a
    // picture, or either side of a picture the reader cannot use, came
    // together in one run, and the copy rule read the neighbour it now had.
    expect(
      text(
        '<details open><span class="katex-mathml">m</span><span><summary class="katex-html">T</summary><img src="https://x.test/i.png"></span> z</details>',
      ),
    ).toEqual(['T', 'm', 'IMG', 'z']);
    expect(
      text(
        '<span>a <span class="katex-mathml">m</span><span><script class="katex-html"></script><img src="https://x.test/i.png"></span></span>',
      ),
    ).toEqual(['a m', 'IMG']);
    expect(
      text(
        '<p>a <span class="katex-mathml">m</span><img src="cid:x"><script class="katex-html"></script> z</p>',
      ),
    ).toEqual(['a m z']);
    expect(
      text(
        '<details open><span class="katex-mathml">m</span><img src="cid:x"><summary class="katex-html">T</summary> z</details>',
      ),
    ).toEqual(['T', 'm z']);
    expect(
      text(
        '<figure><span class="katex-mathml">m</span><img src="cid:x"><script class="katex-html"></script></figure>',
      ),
    ).toEqual(['m']);
    // Inside a wrapper split around a picture as well as outside one.
    expect(
      text(
        '<span>a <span class="katex-mathml">m</span><img src="cid:x"><span class="katex-html">D</span><img src="https://x.test/i.png"></span>',
      ),
    ).toEqual(['a mD', 'IMG']);
    // A real drawing across the levels, before and after them.
    expect(
      text(
        '<span>a <span class="katex-mathml">m</span><span><span class="katex-html">D</span><img src="https://x.test/i.png"></span></span>',
      ),
    ).toEqual(['a mD', 'IMG']);
    expect(
      text(
        '<span><span><img src="https://x.test/i.png">a <span class="katex-mathml">m</span></span><span class="katex-html">D</span></span>',
      ),
    ).toEqual(['IMG', 'a mD']);
    expect(
      text(
        '<p>a <span class="katex-mathml">m</span><img src="cid:x"><span class="katex-html">D</span> z</p>',
      ),
    ).toEqual(['a mD z']);
  });

  test('what the reader skips is nothing beside a space between blocks', () => {
    const text = (html: string) =>
      blocksFromHtml(document, html).map((b) => (b.type === 'image' ? 'IMG' : blockText(b)));

    // Outlook's pictures arrive as `cid:` sources, which the reader cannot
    // use; the stand-in it keeps for one kept the space beside it at the
    // paste's edge, which a browser collapses against the block.
    expect(text('<div> <img src="cid:image001.png"><center>Regards</center></div>')).toEqual([
      'Regards',
    ]);
    expect(text('<div><center>Regards</center><img src="cid:image001.png"> </div>')).toEqual([
      'Regards',
    ]);
    expect(text('<p> <img src="cid:x"><span style="display:block">B</span></p>')).toEqual(['B']);
    expect(text(' <img src="cid:x"><span style="display:block">B</span>')).toEqual(['B']);
    // A `<script>` beside the space, and a `<template>` in the source.
    expect(text('<div> <script></script><center>B</center></div>')).toEqual(['B']);
    expect(text('<div><center>A</center><script></script> </div>')).toEqual(['A']);
    expect(text('<blockquote><p></p><template>t</template>  </blockquote>')).toEqual(['']);
    // An assistive copy, as its stand-in: the space before it is the
    // title's edge.
    expect(
      text(
        '<details open><summary class="katex-html"> <span class="katex-mathml"></span><summary class="katex-html"></summary></summary></details>',
      ),
    ).toEqual(['']);
    // In a flex or grid container every element is an item, the skipped one
    // too, and whitespace between items is never drawn: stepping past it
    // joined two such runs into text.
    expect(
      text(
        '<blockquote><div style="display:grid"><img src="https://x.test/i.png">\n  <script></script> </div></blockquote>',
      ),
    ).toEqual(['IMG']);
    expect(
      blocksFromHtml(
        document,
        '<table><tr><td><div style="display:grid"><hr> <script></script>  </div></td></tr></table>',
      )[0]!.rows,
    ).toEqual([[[]]]);
  });

  test('pretty-printed source reads the same around what the reader skips', () => {
    const text = (html: string) =>
      blocksFromHtml(document, html).map((b) =>
        b.type === 'table' ? JSON.stringify(b.rows) : blockText(b),
      );

    // A `<style>`, a `<script>` or a comment on a line of its own between two
    // indented paragraphs: the whitespace either side of it is one run, and
    // a browser collapses it between the blocks.
    expect(
      text('<blockquote>\n  <p>a</p>\n  <script></script>\n  <p>b</p>\n</blockquote>'),
    ).toEqual(['a\nb']);
    expect(
      text('<ul>\n  <li>\n    <p>a</p>\n    <style>x{}</style>\n    <p>b</p>\n  </li>\n</ul>'),
    ).toEqual(['a\nb']);
    expect(text('<blockquote>\n  <p>a</p>\n  <!-- c -->\n  <p>b</p>\n</blockquote>')).toEqual([
      'a\nb',
    ]);
    expect(text('<blockquote><p>a</p> <!-- c --></blockquote>')).toEqual(['a']);
    // One the reader skips that is a block by its own display is still a
    // block: stepping past it joined the indentation either side into text.
    expect(
      text(
        '<blockquote>\n  <p>a</p>\n  <svg style="display:block"></svg>\n  <p>b</p>\n</blockquote>',
      ),
    ).toEqual(['a\nb']);
    expect(
      text(
        '<ul>\n  <li>\n    <p>a</p>\n    <iframe style="display:block"></iframe>\n    <p>b</p>\n  </li>\n</ul>',
      ),
    ).toEqual(['a\nb']);
    expect(
      text(
        '<table><tr><td>\n<p>a</p>\n<svg style="display:block"></svg>\n<p>b</p>\n</td></tr></table>',
      ),
    ).toEqual([JSON.stringify([[[{ text: 'a\nb' }]]])]);
    expect(
      blocksFromHtml(
        document,
        '<b><blockquote><object style="display:block"></object> <p></p></blockquote></b>',
      ).map((b) => b.content),
    ).toEqual([[]]);
    // A no-break space is content, not part of the run either side: the
    // reading is the one without the `<script>`.
    expect(text('<blockquote><p>a</p> <script></script>&nbsp;</blockquote>')).toEqual(
      text('<blockquote><p>a</p> &nbsp;</blockquote>'),
    );
    expect(text('<blockquote>&nbsp;<script></script> <p>a</p></blockquote>')).toEqual(
      text('<blockquote>&nbsp; <p>a</p></blockquote>'),
    );
    // In a flex or grid container the skipped element is an item, and so a
    // block: whitespace beside it between items is no text.
    expect(
      text('<blockquote><div style="display:grid"><hr> <script></script>b</div></blockquote>'),
    ).toEqual(['b']);
    expect(
      text('<blockquote><div style="display:flex">a<script></script> <hr></div></blockquote>'),
    ).toEqual(['a']);
    // Word gaps beside one are untouched.
    expect(text('a <svg></svg> b')).toEqual(['a b']);
    expect(text('a<script></script> <b>b</b>')).toEqual(['a b']);
    // A `<template>` changes nothing, beside a block or a preserved newline.
    expect(
      text(
        '<li>  z <span style="white-space:pre-line"><svg style="display:block"></svg>\n<template>t</template></span>\n  w</li>',
      ),
    ).toEqual(
      text(
        '<li>  z <span style="white-space:pre-line"><svg style="display:block"></svg>\n</span>\n  w</li>',
      ),
    );
  });

  test('no list a paste can make long is spread into the arguments of one call', () => {
    // An engine caps a call's arguments (V8 near 120,000, JavaScriptCore at
    // 65,536): `run.push(...ahead)` threw on a paste of 150,000 comments under
    // a `<b>`, and the paste did nothing. Read straight from the source because
    // the shape that shows it costs seconds in happy-dom, which moves each node
    // in time linear in its siblings; a browser does not. Parsed, not matched
    // line by line: a line-by-line match missed a spread the formatter put on
    // a line of its own, and one after an argument holding parentheses
    // (`splice(Math.min(i, n), 0, ...copies)`). An offender is, exactly:
    //   - a spread passed to a call or a `new`;
    //   - a member named `apply`, read by dot or by a literal key, that is
    //     called or is the object of `.call`, `.bind` or `.apply` -- through
    //     any parentheses, `as`, `satisfies`, `!` or `<T>` around it, as this
    //     package writes `(listener as Handler)(payload)`;
    //   - `Reflect.construct`, read and used the same way;
    //   - `apply` destructured, in a variable declaration, from `Reflect` or
    //     from something ending in `.prototype`;
    // unless it is named here as bounded: a table's head and body, and a choice
    // of two argument lists. Not seen: a key computed at run time
    // (`f[name](...)`), an alias (`const ap = Reflect.apply`), `Reflect` spelled
    // any other way (`globalThis.Reflect`), any other destructuring. This is a
    // tripwire for the forms this code writes, not a proof that none is left.
    const bounded = new Set([
      'view/rich-dom.ts: element.append(...tableSections(doc, block.rows ?? []))',
      'view/selection.ts: composed?.apply(selection, args)',
      // A selection's boxes are the one or two lines a caret can be drawn on
      // (`selectionBoxes`), never a paste's length.
      'editor.ts: Math.min(...boxes.map((box) => box.top))',
      'editor.ts: Math.max(...boxes.map((box) => box.bottom))',
      'editor.ts: Math.min(...boxes.map((box) => box.left))',
      'editor.ts: Math.max(...boxes.map((box) => box.right))',
      // `ends` answers a pair.
      'view/selection.ts: settle(before, after, start, first, false, ...ends(first))',
      'view/selection.ts: settle(before, after, start, from, false, ...ends(startAt))',
      'view/selection.ts: settle(before, after, end, to, true, ...ends(endAt))',
    ]);
    // Paths, not URLs: under happy-dom `URL` is the DOM's, which `fs` refuses.
    const root = join(import.meta.dirname, '..');
    const offenders: string[] = [];

    for (const file of readdirSync(root, { recursive: true }) as string[]) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts') || /(^|\/)test-/.test(file)) {
        continue;
      }

      const source = ts.createSourceFile(
        file,
        readFileSync(join(root, file), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      // The member a node names, by dot, by string key or in a destructuring.
      const member = (node: ts.Node): string | null => {
        if (ts.isPropertyAccessExpression(node)) {
          return node.name.text;
        }

        if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
          return node.argumentExpression.text;
        }

        // Taken apart, only from where a function's `apply` lives: a label of
        // that name is a string (`labels.apply`, a popover's button).
        if (
          ts.isBindingElement(node) &&
          ts.isObjectBindingPattern(node.parent) &&
          ts.isVariableDeclaration(node.parent.parent) &&
          /^(Reflect|.*\.prototype)$/.test(node.parent.parent.initializer?.getText(source) ?? '')
        ) {
          const key = node.propertyName ?? node.name;

          return ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : null;
        }

        return null;
      };
      // The expression a member stands as, past the parentheses, casts and
      // assertions around it, which change nothing about what is called.
      const outermost = (node: ts.Node): ts.Node => {
        let at = node;

        while (
          (ts.isParenthesizedExpression(at.parent) ||
            ts.isAsExpression(at.parent) ||
            ts.isSatisfiesExpression(at.parent) ||
            ts.isNonNullExpression(at.parent) ||
            ts.isTypeAssertionExpression(at.parent)) &&
          at.parent.expression === at
        ) {
          at = at.parent;
        }

        return at;
      };
      // The call a member makes, where it is called.
      const callOf = (node: ts.Node): ts.CallExpression | null => {
        const at = outermost(node);

        return ts.isCallExpression(at.parent) && at.parent.expression === at ? at.parent : null;
      };
      // Whether a member expression is used as a function: called, or the
      // object of a `.call`, `.bind` or `.apply`.
      const usedAsFunction = (node: ts.Node): boolean => {
        const at = outermost(node);

        return (
          ts.isBindingElement(node) ||
          callOf(node) !== null ||
          ((ts.isPropertyAccessExpression(at.parent) || ts.isElementAccessExpression(at.parent)) &&
            at.parent.expression === at &&
            ['call', 'bind', 'apply'].includes(member(at.parent) ?? ''))
        );
      };
      const visit = (node: ts.Node): void => {
        const name = member(node);
        const reflected =
          name === 'construct' &&
          (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
          node.expression.getText(source) === 'Reflect';
        // Reported as the call it makes, where it is one, so the bounded
        // names read as the code does.
        const call =
          ts.isSpreadElement(node) &&
          (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent))
            ? node.parent
            : (name === 'apply' || reflected) && usedAsFunction(node)
              ? (callOf(node) ?? node)
              : null;

        if (call) {
          const text = `${file}: ${call.getText(source).replace(/\s+/g, ' ')}`;
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));

          if (!bounded.has(text)) {
            offenders.push(`${text} (line ${line + 1})`);
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(source);
    }

    expect(offenders).toEqual([]);
  });

  test('long runs of what draws nothing read in linear time', () => {
    // Each whitespace text in the run looked past the whole of it both ways.
    const shapes: ReadonlyArray<(n: number) => string> = [
      (n) => `<p>a</p>${'<!---->\n'.repeat(n)}<p>b</p>`,
      (n) => `<p>a</p>${'<script></script> '.repeat(n)}<p>b</p>`,
      (n) => `a${'<!----> '.repeat(n)}b`,
      (n) => `<blockquote>${' <!---->'.repeat(n)}</blockquote>`,
    ];

    for (const shape of shapes) {
      expect(growth((n) => blocksFromHtml(document, shape(n)), 100)).toBeLessThan(LINEAR);
    }
  }, 120_000);

  test('what a read settles about a run of whitespace is forgotten after it', () => {
    // The editor reads its live editing hosts again on every input: an answer
    // kept past the read went on describing a tree the user had since edited.
    const host = document.createElement('div');
    host.innerHTML = '<p>a</p> <!----> <p>b</p>';
    expect(richToPlainText(parseRichText(host))).toBe('a\nb');
    host.lastElementChild!.replaceWith(document.createTextNode('b'));
    const fresh = document.createElement('div');
    fresh.innerHTML = '<p>a</p> <!----> b';
    expect(richToPlainText(parseRichText(host))).toBe(richToPlainText(parseRichText(fresh)));
  });

  test('a formatting wrapper around pretty-printed blocks reads as without it', () => {
    const text = (html: string) =>
      blocksFromHtml(document, html).map((b) =>
        b.type === 'table'
          ? JSON.stringify(b.rows?.map((row) => row.map(richToPlainText)))
          : blockText(b),
      );

    // A comment or a `<script>` started the run a `<b>` shell went around, and
    // the indentation either side of the shell was read as text.
    for (const inner of ['<!-- c -->', '<script></script>', '<style>x{}</style>']) {
      expect(
        text(`<b><blockquote>\n  <p>a</p>\n  ${inner}\n  <p>b</p>\n</blockquote></b>`),
      ).toEqual(text(`<blockquote>\n  <p>a</p>\n  ${inner}\n  <p>b</p>\n</blockquote>`));
    }
    expect(text('<b><ul>\n  <li><p>a</p>\n  <!-- c -->\n  <p>b</p></li>\n</ul></b>')).toEqual([
      'a\nb',
    ]);
    expect(
      text('<b><table><tr><td>\n<p>a</p>\n<!-- c -->\n<p>b</p>\n</td></tr></table></b>'),
    ).toEqual([JSON.stringify([['a\nb']])]);
    expect(text('<b><blockquote>\n  <p>a</p>\n  <!-- c -->\n</blockquote></b>')).toEqual(['a']);
    // A run that goes on to content keeps all of it: the space before the
    // content is formatted as it is without what draws nothing beside it, and
    // a no-break space is content.
    const runs = (html: string) => blocksFromHtml(document, html).map((b) => b.content);
    expect(
      runs('<a href="https://x.test/"><noscript></noscript>  <script></script>T<hr></a>'),
    ).toEqual(runs('<a href="https://x.test/">  T<hr></a>'));
    expect(runs('<b><blockquote><p>a</p> <!-- c --> <i>x</i></blockquote></b>')).toEqual(
      runs('<b><blockquote><p>a</p>  <i>x</i></blockquote></b>'),
    );
    expect(runs('<b><script></script> <!-- c -->x<hr></b>')).toEqual(runs('<b> x<hr></b>'));
    // What waited before a block is never carried past it.
    expect(text('<b><!-- c --> <p>x</p>y</b>')).toEqual(['x', 'y']);
    expect(runs('<b><script></script>&nbsp;<hr></b>')).toEqual(runs('<b>&nbsp;<hr></b>'));
  });

  test('what the reader skips keeps its neighbours apart on every path', () => {
    // Where it stands, the first `katex-mathml` is no copy: the element after
    // it is the second, not the drawing. A path that dropped the second and
    // put the rest together again made the first the copy, and "extra" went.
    const katex =
      '<span class="katex-mathml">extra</span><span class="katex-mathml">m</span><span class="katex-html">h</span>';
    const noscript =
      '<span class="katex-mathml">extra</span><noscript>n</noscript><span class="katex-html">h</span>';
    const pic = '<img src="https://e.x/a.png">';
    const text = (html: string) => blocksFromHtml(document, html).map(blockText).join('|');

    expect(text(`<p>q${katex}</p>`)).toBe('qextrah');
    expect(text(`q${katex}`)).toBe('qextrah');
    expect(text(`q${noscript}`)).toBe('qextrah');
    expect(text(`q<span>${katex}</span>`)).toBe('qextrah');
    expect(text(`<p>q${katex}${pic} z</p>`)).toBe('qextrah||z');
    expect(text(`<span>q${katex}${pic} z</span>`)).toBe('qextrah||z');
    expect(text(`<ul><li>a</li>${katex}</ul>`)).toBe('a|extrah');
    expect(text(`<ul><li>a</li>${noscript}</ul>`)).toBe('a|extrah');
    expect(
      text(
        '<ul><li>a</li><div class="katex-mathml">extra</div><span class="katex-mathml">m</span><span class="katex-html">h</span></ul>',
      ),
    ).toBe('a|extra|h');
    expect(text(`<details open><summary>T</summary>${katex}</details>`)).toBe('T|extrah');
    expect(text(`<details open><span><summary>T</summary></span>${katex}</details>`)).toBe(
      'T|extrah',
    );
    // The summary the body leaves out keeps its place too, direct or wrapped,
    // nested or not.
    expect(
      text(
        '<details open><span><summary>O</summary></span><details open><div><span class="katex-mathml">e</span><summary>T</summary><span class="katex-html">h</span></div></details></details>',
      ),
    ).toBe('O|T|eh');
    expect(
      text(
        '<details open><div><span class="katex-mathml">e</span><summary>T</summary><span class="katex-html">h</span></div></details>',
      ),
    ).toBe('T|eh');
    expect(
      text(
        '<details open><span class="katex-mathml">e</span><summary>T</summary><span class="katex-html">h</span></details>',
      ),
    ).toBe('T|eh');
  });

  test('a copy moved before it is read -- loose list content, a formatting shell -- is still a copy', () => {
    const copy = '<span class="MJX_Assistive_MathML"><math><mi>x</mi></math></span>';
    const text = (html: string) =>
      read(html)
        .map((block) => richToPlainText(block[2] as RichText))
        .join('|');

    expect(text(`<ol class="MathJax"><nobr><span>y</span></nobr>${copy}</ol>`)).toBe('y');
    expect(
      text(`<b><span class="MathJax"><nobr><span>y</span></nobr>${copy}<div>z</div></span></b>`),
    ).toBe('y|z');
  });

  test('a long class beside many copies is split once, not once a copy', () => {
    // Both grow with the input -- the class's length and the copies beside
    // it -- since the cost was their product.
    for (const frame of ['', ' MathJax_SVG']) {
      expect(
        growth(
          (n) =>
            blocksFromHtml(
              document,
              `<p><span class="${'c '.repeat(n)}${frame}">${'<span class="MJX_Assistive_MathML"></span>'.repeat(n)}</span></p>`,
            ),
          150,
        ),
      ).toBeLessThan(LINEAR);
    }
  }, 60_000);

  test('a picture the reader never takes makes no paragraph after it a block', () => {
    for (const hidden of [
      `<noscript>${img}</noscript>`,
      `<span><noscript>${img}</noscript></span>`,
      '<span><img src=""></span>',
    ]) {
      expect(read(`<ol><li><span>T</span>${hidden}<p>w1</p><p>w2</p></li></ol>`)).toEqual([
        ['numbered_list', 0, [{ text: 'T\nw1\nw2' }]],
      ]);
    }
  });

  test("MathJax's hidden MathML copy is read only where nothing else draws the formula", () => {
    const copy = '<span class="MJX_Assistive_MathML"><math><mi>x</mi></math></span>';
    // Drawn in text (HTML-CSS): the copy is the duplicate, and skipped.
    const html = `<span class="MathJax"><span>x</span>${copy}</span>`;
    // Drawn as SVG: no text a reader keeps, so the copy is the formula's only
    // reading -- left out, `a <svg> b` read "a  b".
    const svg = `<span class="MathJax_SVG"><svg><text>s</text></svg>${copy}</span>`;

    expect(read(`<p>a ${html} b</p>`)[0]?.[2]).toEqual([{ text: 'a x b' }]);
    expect(read(`<p>a ${svg} b</p>`)[0]?.[2]).toEqual([{ text: 'a x b' }]);
    // Either way the formula's reading is text beside the equation before it.
    expect(li(`Text<br>${eq}${html}`)).toHaveLength(1);
    expect(li(`Text<br>${eq}${svg}`)).toHaveLength(1);
  });

  // Round 5's accepted change: a picture after the equation is a block of
  // the item, and the equation goes before it.
  test('a picture after the equation leaves it apart', () => {
    for (const picture of [img, linked]) {
      expect(li(`Text<br>${eq}${picture}`)).toEqual([item({ text: 'Text' }), math('E'), image]);
    }

    // A line break beside the picture changes nothing of the order.
    for (const picture of [`${img}<br>`, `<br>${linked}`]) {
      expect(li(`Text<br>${eq}${picture}`).slice(1)).toEqual([math('E'), image]);
    }
  });

  // Shapes the differential fuzzer found moving an equation in round 5.
  test('fuzzer-found items keep their order', () => {
    expect(li(`<span>w0<br></span>${eq}<figure>${img}</figure><div>w2</div>`)).toEqual([
      item({ text: 'w0\n' }, m('E'), { text: '\nw2' }),
      image,
    ]);
    expect(li(`${eq}<ul><li>w0</li></ul><p>w1</p>`)).toEqual([
      item(m('E')),
      ['bulleted_list', 1, [{ text: 'w0' }]],
      ['paragraph', 1, [{ text: 'w1' }]],
    ]);
    expect(li(`w0<br>${eq}<table><tr><td>w1</td></tr></table><b>w2</b>`)).toEqual([
      item({ text: 'w0\n' }, m('E'), { text: '\n' }, { text: 'w2', marks: ['bold'] }),
      ['table', 1, []],
    ]);
    expect(li(`<p>w0</p>${eq}<hr>${eqF}<pre>w1</pre>`)).toEqual([
      item({ text: 'w0' }),
      math('E'),
      ['divider', 1, []],
      math('F'),
      ['code', 1, [{ text: 'w1' }]],
    ]);
  });

  // Each child of the item is looked into once, last to first, and each
  // equation's line is walked back to the block before it.
  test('deciding is linear in the item', () => {
    const shapes = [
      (n: number) => `<ul><li>Text<br>${`${eq}${img}`.repeat(n)}</li></ul>`,
      (n: number) =>
        `<ul><li>Text<br>${`${eq}${'<b> </b>'.repeat(4)}${linked}`.repeat(n)}tail</li></ul>`,
      (n: number) => `<ul><li>${eq.repeat(n)}<p>More</p></li></ul>`,
      (n: number) => `<ul><li>Text<br>${eq}<span>${'<video></video>'.repeat(n)}</span></li></ul>`,
    ];

    for (const shape of shapes) {
      expect(
        growth((n) => {
          blocksFromHtml(document, shape(n));
        }, 25),
      ).toBeLessThan(LINEAR);
    }
  }, 60_000);
});

describe('a list item hands on its images in document order', () => {
  const img = (name: string) => `<img src="https://x.test/${name}.png">`;
  // In a wrapper the image is part of the item's text; bare, it is a block.
  const inline = (name: string) => `<span>${img(name)}</span>`;
  const read = (html: string) =>
    blocksFromHtml(document, html).map((block) =>
      block.type === 'image'
        ? `image@${block.depth}:${block.src?.replace('https://x.test/', '')}`
        : `${block.type}@${block.depth}:${richToPlainText(block.content)}`,
    );

  // An item's text is still read before its blocks (round 6 accepted that);
  // what moves is each image in that text, which is handed on among the
  // item's blocks where the browser draws it rather than ahead of all of them.
  test('an image after a nested list stays after it', () => {
    expect(read(`<ul><li>a<ul><li>c</li></ul>${inline('1')}</li></ul>`)).toEqual([
      'bulleted_list@0:a',
      'bulleted_list@1:c',
      'image@1:1.png',
    ]);
  });

  test('images on either side of a nested list keep their sides', () => {
    expect(read(`<ul><li>a${inline('1')}<ul><li>c</li></ul>${inline('2')}</li></ul>`)).toEqual([
      'bulleted_list@0:a',
      'image@1:1.png',
      'bulleted_list@1:c',
      'image@1:2.png',
    ]);
  });

  test('an image in text after a block follows the block', () => {
    expect(read(`<ul><li>a<pre>p</pre><b>b${img('1')}</b></li></ul>`)).toEqual([
      'bulleted_list@0:a\nb',
      'code@1:p',
      'image@1:1.png',
    ]);
  });

  test('images between several blocks land between them', () => {
    expect(
      read(
        `<ul><li>a${inline('0')}<pre>p</pre>${inline('1')}<ul><li>c</li></ul>${inline('2')}<hr>${inline('3')}</li></ul>`,
      ),
    ).toEqual([
      'bulleted_list@0:a',
      'image@1:0.png',
      'code@1:p',
      'image@1:1.png',
      'bulleted_list@1:c',
      'image@1:2.png',
      'divider@1:',
      'image@1:3.png',
    ]);
  });

  // The paragraph an item takes as its text is read ahead of the block before
  // it, by design; its picture is not text and stays where it stood. (Its
  // text is read as a browser draws it, `readBlockText`: the space before the
  // picture handed on ends the block, and goes.)
  test('a promoted paragraph keeps its picture after the block before it', () => {
    expect(read(`<ul><li><pre>p</pre><p>Click ${img('1')}</p></li></ul>`)).toEqual([
      'bulleted_list@0:Click',
      'code@1:p',
      'image@1:1.png',
    ]);
  });

  // A bare image is a block of the item's already, and was always in order.
  test('bare and inline images interleave in document order', () => {
    expect(
      read(`<ul><li>a<ul><li>c</li></ul>${inline('1')}${img('2')}${inline('3')}</li></ul>`),
    ).toEqual([
      'bulleted_list@0:a',
      'bulleted_list@1:c',
      'image@1:1.png',
      'image@1:2.png',
      'image@1:3.png',
    ]);
  });

  // A guard on the output only: an item with no images reads as it did.
  test('an item with no images is unchanged', () => {
    expect(read('<ul><li>a<pre>p</pre><ul><li>c</li></ul><p>d</p></li></ul>')).toEqual([
      'bulleted_list@0:a',
      'code@1:p',
      'bulleted_list@1:c',
      'paragraph@1:d',
    ]);
  });

  // One walk places every image: neither images nor blocks are looked for
  // again per block.
  test('placing them is linear in the item', () => {
    const shapes = [
      (n: number) => `<ul><li>a${`<pre>p</pre>${inline('i')}`.repeat(n)}</li></ul>`,
      (n: number) => `<ul><li>a${`<hr><b>b${img('i')}</b>`.repeat(n)}</li></ul>`,
      (n: number) => `<ul><li>a${`<ul><li>c</li></ul>${inline('i')}`.repeat(n)}</li></ul>`,
    ];

    // At 25 a scan of the item's children per run grew 22x, inside the line;
    // at 400 it is well past it.
    for (const shape of shapes) {
      expect(
        growth((n) => {
          blocksFromHtml(document, shape(n));
        }, 400),
      ).toBeLessThan(LINEAR);
    }
  }, 120_000);
});

describe('a styled display block keeps its marks beside an image', () => {
  const img = '<img src="https://x.test/k.png">';
  const read = (html: string) =>
    blocksFromHtml(document, html).map((block) =>
      block.type === 'image'
        ? `image@${block.depth}:${block.src?.replace('https://x.test/', '')}`
        : `${block.type}@${block.depth}:${JSON.stringify(block.content)}`,
    );
  const bold = (text: string) => `paragraph@0:${JSON.stringify([{ text, marks: ['bold'] }])}`;

  // `<aside>`, `<center>` and `<address>` are laid out as blocks but are not
  // structure this reader knows, so their style is formatting, read where it
  // stands -- as it already was without the image.
  test.each(['aside', 'center', 'address'])('<%s> reads bold with an image in it', (tag) => {
    expect(read(`<${tag} style="font-weight:bold">q z</${tag}>`)).toEqual([bold('q z')]);
    expect(read(`<${tag} style="font-weight:bold">q z${img}</${tag}>`)).toEqual([
      bold('q z'),
      'image@0:k.png',
    ]);
  });

  test('text on both sides of the image keeps the mark, and its blocks', () => {
    expect(read(`<aside style="font-weight:bold">q${img}z</aside>`)).toEqual([
      bold('q'),
      'image@0:k.png',
      bold('z'),
    ]);
  });

  // It still ends the lines around it, as it did when its marks were lost.
  // It reads as it does without the picture -- its own lines, in the text
  // around it -- split where the picture stands.
  test('it still stands apart from the text around it', () => {
    expect(read(`before<aside style="font-weight:bold">q${img}z</aside>after`)).toEqual([
      `paragraph@0:${JSON.stringify([{ text: 'before\n' }, { text: 'q', marks: ['bold'] }])}`,
      'image@0:k.png',
      `paragraph@0:${JSON.stringify([{ text: 'z', marks: ['bold'] }, { text: '\nafter' }])}`,
    ]);
    expect(read('before<aside style="font-weight:bold">qz</aside>after')).toEqual([
      `paragraph@0:${JSON.stringify([{ text: 'before\n' }, { text: 'qz', marks: ['bold'] }, { text: '\nafter' }])}`,
    ]);
  });

  // The nearest formatting wins, exactly as the image-free read has it.
  test('an inner wrapper still overrides it', () => {
    const html = `<aside style="font-weight:bold"><span style="font-weight:normal">q</span> z</aside>`;
    const withImage = html.replace('</aside>', `${img}</aside>`);

    expect(read(withImage)).toEqual([...read(html), 'image@0:k.png']);
  });

  test('a link inside keeps both the link and the mark', () => {
    expect(
      read(`<center style="font-style:italic"><a href="https://l.test/">q z${img}</a></center>`),
    ).toEqual([
      `paragraph@0:${JSON.stringify([{ text: 'q z', marks: ['italic'], link: 'https://l.test/' }])}`,
      'image@0:k.png',
    ]);
  });

  test('its white-space still governs the text', () => {
    expect(read(`<aside style="white-space:pre-wrap;font-weight:bold">q  z${img}</aside>`)).toEqual(
      [bold('q  z'), 'image@0:k.png'],
    );
  });

  // A block tag's style is not a mark, with or without the image: that is the
  // reader's rule for `<div>` and `<p>`, not this defect.
  test.each(['div', 'p'])('<%s> is unchanged', (tag) => {
    expect(read(`<${tag} style="font-weight:bold">q z${img}</${tag}>`)).toEqual([
      `paragraph@0:${JSON.stringify([{ text: 'q z' }])}`,
      'image@0:k.png',
    ]);
  });

  test('reading them is linear', () => {
    // The chain stays under the inline nesting bound at its large size, where
    // it would stop being the same document.
    const shapes: Array<[(n: number) => string, number]> = [
      [(n) => `<aside style="font-weight:bold">${`q ${img}`.repeat(n)}</aside>`, 400],
      [
        (n) =>
          `<center style="font-weight:bold">${'<span>'.repeat(n)}q${img}${'</span>'.repeat(n)}</center>`,
        100,
      ],
      [(n) => `<aside style="font-weight:bold">q${img}</aside>`.repeat(n), 400],
    ];

    for (const [shape, size] of shapes) {
      expect(
        growth((n) => {
          blocksFromHtml(document, shape(n));
        }, size),
      ).toBeLessThan(LINEAR);
    }
  }, 120_000);
});

describe('reader fixes, review round 1', () => {
  const img = (name: string) => `<img src="https://x.test/${name}.png">`;
  const read = (html: string) =>
    blocksFromHtml(document, html).map((block) =>
      block.type === 'image'
        ? `image@${block.depth}:${block.src?.replace('https://x.test/', '')}`
        : `${block.type}@${block.depth}:${JSON.stringify(block.content)}`,
    );
  const para = (...runs: object[]) => `paragraph@0:${JSON.stringify(runs)}`;

  // L1: an image an item hands on among its blocks leaves its line open, as an
  // inline image does, so a `<br>` that follows it ends that line.
  test('an image placed among an item’s blocks leaves its line open', () => {
    const tail = `<span>${img('2')}</span><a href="https://x.test/"><br>${img('3')}</a>`;

    expect(read(`<ul><li>t<pre>p</pre>${tail}</li></ul>`)).toEqual([
      `bulleted_list@0:${JSON.stringify([{ text: 't' }])}`,
      `code@1:${JSON.stringify([{ text: 'p' }])}`,
      'image@1:2.png',
      'image@1:3.png',
    ]);
    expect(read(`<ul><li>t${tail}</li></ul>`)).toEqual([
      `bulleted_list@0:${JSON.stringify([{ text: 't' }])}`,
      'image@1:2.png',
      'image@1:3.png',
    ]);
    // As the same markup reads outside a list.
    expect(read(`<pre>p</pre>${tail}`)).toEqual([
      `code@0:${JSON.stringify([{ text: 'p' }])}`,
      'image@0:2.png',
      'image@0:3.png',
    ]);
  });

  // D1: a styled container (`<header>`, `<footer>`, `<nav>`, `<main>`, `<dl>`)
  // states a mark that a tag inside it may still overrule. Whether it holds an
  // image or a block decided whether that mark was read at all.
  test.each(['header', 'footer', 'nav', 'main', 'dl'])(
    '<%s> reads its mark with or without an image or a block',
    (tag) => {
      const open = `<${tag} style="font-weight:bold">`;
      const bold = para({ text: 'q z', marks: ['bold'] });

      expect(read(`${open}q z</${tag}>`)).toEqual([bold]);
      expect(read(`${open}q z${img('k')}</${tag}>`)).toEqual([bold, 'image@0:k.png']);
      expect(read(`${open}<p>q z</p></${tag}>`)).toEqual([bold]);
      expect(read(`${open}<p>q z</p>${img('k')}</${tag}>`)).toEqual([bold, 'image@0:k.png']);
    },
  );

  // And weakly, image or not: the shorthand the footer states does not undo
  // the `<s>` inside it.
  test('a container mark stays weak without an image', () => {
    const marks = (html: string) =>
      blocksFromHtml(document, html)
        .flatMap((block) => (block.content ?? []).flatMap((run) => run.marks ?? []))
        .sort();

    expect(marks('<footer style="text-decoration:underline"><s>q</s></footer>')).toEqual([
      'strikethrough',
      'underline',
    ]);
    expect(marks(`<footer style="text-decoration:underline"><s>q</s>${img('k')}</footer>`)).toEqual(
      ['strikethrough', 'underline'],
    );
  });

  // T5: a styled `<figcaption>` reached as a block reads its mark, as it does
  // without the image.
  test('a styled figcaption keeps its mark beside an image', () => {
    const table = '<table><tr><td>x</td></tr></table>';

    expect(
      read(
        `<figure><figcaption style="font-weight:bold">q z${img('k')}</figcaption>${table}</figure>`,
      )[0],
    ).toBe(para({ text: 'q z', marks: ['bold'] }));
  });

  // D2: flex and grid items stay apart when their container is split around
  // an image, as they are without one.
  test.each([
    [
      `<address style="display:flex;align-items:center;font-weight:bold">${img('k')}<span>Jane</span><span>Nov 14</span></address>`,
      ['image@0:k.png', para({ text: 'Jane\nNov 14', marks: ['bold'] })],
    ],
    [
      `<aside style="display:grid;font-weight:bold">q<span>z</span>${img('k')}</aside>`,
      [para({ text: 'q\nz', marks: ['bold'] }), 'image@0:k.png'],
    ],
    [
      `<span style="display:flex;font-weight:bold"><span>q</span><span>z</span>${img('k')}</span>`,
      [para({ text: 'q\nz', marks: ['bold'] }), 'image@0:k.png'],
    ],
  ])('%s keeps its items apart', (html, blocks) => {
    expect(read(html)).toEqual(blocks);
  });

  // The whitespace between items is not drawn, split or not.
  test('pretty-printed items read no space', () => {
    expect(
      read(
        `<aside style="display:flex;font-weight:bold">\n  <span>Jane</span>\n  <span>Nov 14</span>\n  ${img('k')}\n</aside>`,
      ),
    ).toEqual([para({ text: 'Jane\nNov 14', marks: ['bold'] }), 'image@0:k.png']);
  });

  // A display block ended inside the wrapper ends that line, not the one a
  // picture after it opens: a `<br>` after the wrapper ends the picture's line.
  test('a picture after a nested display block keeps its line open', () => {
    expect(read(`<b><center>y${img('k')}</center>w${img('2')}</b><br>z`)).toEqual([
      para({ text: 'y', marks: ['bold'] }),
      'image@0:k.png',
      para({ text: 'w', marks: ['bold'] }),
      'image@0:2.png',
      para({ text: 'z' }),
    ]);
  });

  // An item that holds the image ends the line on both sides of it.
  test('an item holding the image is a line of its own', () => {
    const text = read(
      `<aside style="display:flex;font-weight:bold"><span>q</span><span>z${img('k')}y</span></aside>`,
    ).join('|');

    expect(text).not.toContain('qz');
    expect(text).toContain('image@0:k.png');
  });

  // K2: a wrapper that holds a display block as well as an image keeps its
  // marks and link, and the block keeps its lines.
  test.each([
    [
      `<b>q<aside>z</aside>${img('k')}</b>`,
      [para({ text: 'q\nz', marks: ['bold'] }), 'image@0:k.png'],
    ],
    [
      `<aside style="font-weight:bold">q<center>z</center>${img('k')}</aside>`,
      [para({ text: 'q\nz', marks: ['bold'] }), 'image@0:k.png'],
    ],
    [
      `<b><aside style="font-style:italic">q${img('k')}</aside></b>`,
      [para({ text: 'q', marks: ['bold', 'italic'] }), 'image@0:k.png'],
    ],
    [
      `<a href="https://l.test/"><aside style="font-weight:bold">q${img('k')}</aside></a>`,
      [para({ text: 'q', marks: ['bold'], link: 'https://l.test/' }), 'image@0:k.png'],
    ],
    [
      `<i><p>p</p><aside style="font-weight:bold">q${img('k')}</aside></i>`,
      [
        para({ text: 'p', marks: ['italic'] }),
        para({ text: 'q', marks: ['bold', 'italic'] }),
        'image@0:k.png',
      ],
    ],
    [
      `<fieldset style="font-weight:bold"><legend>L</legend>q${img('k')}</fieldset>`,
      [para({ text: 'L\nq', marks: ['bold'] }), 'image@0:k.png'],
    ],
  ])('%s keeps its formatting', (html, blocks) => {
    expect(read(html)).toEqual(blocks);
  });

  // An image inside the display block splits the run there, and the block's
  // lines either side of it stay, as without the image (`x\nyw\nz`).
  test('an image inside a nested display block ends the lines around the block', () => {
    expect(read(`<b>x<center>y${img('k')}w</center>z</b>`)).toEqual([
      para({ text: 'x\ny', marks: ['bold'] }),
      'image@0:k.png',
      para({ text: 'w\nz', marks: ['bold'] }),
    ]);
    expect(read('<b>x<center>yw</center>z</b>')).toEqual([
      para({ text: 'x\nyw\nz', marks: ['bold'] }),
    ]);
  });

  // K1: a quote hands its images on among its lists where they stand, as a
  // list item now does.
  test.each([
    [
      `<blockquote>a<ul><li>b</li></ul><span>${img('1')}</span></blockquote>`,
      ['quote@0:[{"text":"a"}]', 'bulleted_list@1:[{"text":"b"}]', 'image@1:1.png'],
    ],
    [
      `<blockquote>a<span>${img('1')}</span><ul><li>b</li></ul><span>${img('2')}</span></blockquote>`,
      [
        'quote@0:[{"text":"a"}]',
        'image@1:1.png',
        'bulleted_list@1:[{"text":"b"}]',
        'image@1:2.png',
      ],
    ],
    // Bare: a quote of nothing but a list and an image is those, in order.
    [
      `<blockquote><ul><li>b</li></ul><span>${img('1')}</span></blockquote>`,
      ['bulleted_list@0:[{"text":"b"}]', 'image@0:1.png'],
    ],
  ])('%s keeps document order', (html, blocks) => {
    expect(read(html)).toEqual(blocks);
  });

  // D4: a chain of styled containers holding an image hands each one's mark on
  // once, not by copying everything below it once per level.
  test('a chain of styled containers is linear', () => {
    expect(
      growth((n) => {
        blocksFromHtml(
          document,
          `${'<footer style="font-weight:bold">'.repeat(n)}q${img('k')}${'</footer>'.repeat(n)}`,
        );
      }, 40),
    ).toBeLessThan(LINEAR);
    expect(
      growth((n) => {
        blocksFromHtml(
          document,
          `${'<footer style="font-weight:bold">'.repeat(n)}<p>q</p>${'</footer>'.repeat(n)}`,
        );
      }, 40),
    ).toBeLessThan(LINEAR);
  }, 60_000);

  test('splitting a wrapper around its display blocks is linear', () => {
    expect(
      growth((n) => {
        blocksFromHtml(
          document,
          `<b>${`q<aside>z</aside><center>y${img('i')}</center>`.repeat(n)}</b>`,
        );
      }, 200),
    ).toBeLessThan(LINEAR);
  }, 60_000);
});

describe('reader fixes, review round 2', () => {
  const img = (name: string, scheme = 'https://x.test/') => `<img src="${scheme}${name}.png">`;
  const read = (html: string) =>
    blocksFromHtml(document, html).map((block) =>
      block.type === 'image'
        ? `image@${block.depth}:${block.src?.replace('https://x.test/', '')}`
        : `${block.type}@${block.depth}:${JSON.stringify(block.content)}`,
    );
  const marksOf = (html: string) =>
    [
      ...new Set(
        blocksFromHtml(document, html).flatMap((block) =>
          (block.content ?? []).flatMap((run) => run.marks ?? []),
        ),
      ),
    ].sort();
  const para = (...runs: object[]) => `paragraph@0:${JSON.stringify(runs)}`;

  // C1: a container's mark is weak -- any element below that turns it off
  // wins, as the browser draws it. Chromium writes each element's matched
  // rules inline, so a Tailwind header (semibold, its tagline normal) arrives
  // like this.
  test('a Chromium-copied header keeps only its own mark', () => {
    expect(
      read(
        '<header style="font-weight: 600;"><a href="https://s.test/">Site</a><p style="margin:0; font-weight: 400;">Notes on things</p><nav><ul><li style="font-weight: 400;">Home</li></ul></nav></header>',
      ),
    ).toEqual([
      para({ text: 'Site', marks: ['bold'], link: 'https://s.test/' }),
      para({ text: 'Notes on things' }),
      `bulleted_list@0:${JSON.stringify([{ text: 'Home' }])}`,
    ]);
  });

  test.each([
    '<header style="font-weight:bold"><p style="font-weight:normal">x</p></header>',
    '<header style="font-weight:bold"><span style="font-weight:400"><p>x</p></span></header>',
    '<footer style="font-weight:bold"><b style="font-weight:normal" id="docs-internal-guid-1"><p>x</p></b></footer>',
    '<footer style="font-weight:bold"><nav style="font-weight:normal"><p>x</p></nav></footer>',
    `<header style="font-weight:bold">${img('k')}<span style="font-weight: normal"><p>x</p></span></header>`,
  ])('%s turns the container’s mark off', (html) => {
    expect(marksOf(html)).toEqual([]);
  });

  test('an item or a cell turns it off for itself alone', () => {
    expect(
      read(
        '<nav style="font-style:italic"><ul><li>a</li><li style="font-style:normal">b</li></ul></nav>',
      ),
    ).toEqual([
      `bulleted_list@0:${JSON.stringify([{ text: 'a', marks: ['italic'] }])}`,
      `bulleted_list@0:${JSON.stringify([{ text: 'b' }])}`,
    ]);
    const [table] = blocksFromHtml(
      document,
      '<main style="font-weight:700"><table><tr><td>c</td><td style="font-weight:400">d</td></tr></table></main>',
    );

    expect(table?.rows).toEqual([[[{ text: 'c', marks: ['bold'] }], [{ text: 'd' }]]]);
  });

  // The same nesting reads the same in a list item as outside one.
  test('a nested container’s off holds inside a list item', () => {
    const inner = '<footer style="font-weight:normal;font-style:italic"><p>x</p></footer>';

    expect(
      marksOf(`<footer style="font-weight:bold"><ul><li>t${inner}</li></ul></footer>`),
    ).toEqual(['bold', 'italic']);
    expect(
      blocksFromHtml(
        document,
        `<footer style="font-weight:bold"><ul><li>t${inner}</li></ul></footer>`,
      )
        .flatMap((block) => block.content ?? [])
        .filter((run) => run.text.includes('x')),
    ).toEqual([{ text: 'x', marks: ['italic'] }]);
  });

  // C3: a nested container's mark is weak too, against the tags inside it.
  test.each([
    [
      '<b><footer style="text-decoration:underline"><s><p>q</p></s></footer></b>',
      ['bold', 'strikethrough', 'underline'],
    ],
    [
      '<footer style="text-decoration:underline"><nav style="text-decoration:line-through"><u><p>q</p></u></nav></footer>',
      ['strikethrough', 'underline'],
    ],
  ])('%s keeps the tag inside it', (html, marks) => {
    expect(marksOf(html)).toEqual(marks);
  });

  // C4: a styled flex container's item break carries the mark, as the split's
  // does: the same document, one run.
  test('a styled flex container reads one run', () => {
    expect(
      read(
        '<footer style="display:flex;font-weight:bold"><span>Jane</span><span>Nov 14</span></footer>',
      ),
    ).toEqual([para({ text: 'Jane\nNov 14', marks: ['bold'] })]);
  });

  // Q1: a picture's line stays open only when nothing in the item's text
  // ended it first: two `<br>`s in a row are a blank line, as outside a list.
  test.each([
    [
      `<ul><li>t<span>${img('1')}</span><br><a href="https://x.test/"><br>${img('2')}</a></li></ul>`,
      `t<span>${img('1')}</span><br><a href="https://x.test/"><br>${img('2')}</a>`,
    ],
    [
      `<ul><li><span>${img('1')}</span>text<br><a href="https://x.test/"><br>${img('2')}</a></li></ul>`,
      `<span>${img('1')}</span>text<br><a href="https://x.test/"><br>${img('2')}</a>`,
    ],
  ])('%s keeps its blank line', (html, outside) => {
    const blank = (blocks: string[]) =>
      blocks.filter((block) => block.startsWith('paragraph@') && block.endsWith(':[]')).length;

    expect(blank(read(html))).toBe(1);
    // Outside a list the line is there too: a blank paragraph, or the break
    // that ends the text before the second picture.
    expect(
      blank(read(outside)) + read(outside).filter((block) => block.includes('\\n"')).length,
    ).toBe(1);
  });

  // And when the picture sat in a line of its own in the item's text, whose
  // end ended the picture's line.
  test('a picture in a line of the item’s text closes with it', () => {
    const blank = (blocks: string[]) =>
      blocks.filter((block) => block.startsWith('paragraph@') && block.endsWith(':[]')).length;

    expect(
      blank(
        read(
          `<ul><li>t<div><span>${img('1')}</span></div><a href="https://x.test/"><br>${img('2')}</a></li></ul>`,
        ),
      ),
    ).toBe(1);
  });

  // Q4: a picture the reader cannot use takes no place among the lists.
  test('an unusable picture is not counted before a list', () => {
    expect(
      read(`<blockquote>a${img('x', 'cid:')}<ul><li>b</li></ul>${img('1')}</blockquote>`),
    ).toEqual(['quote@0:[{"text":"a"}]', 'bulleted_list@1:[{"text":"b"}]', 'image@1:1.png']);
  });

  // Q5: the break at a block's head is the picture's only when the picture
  // came before it; one the author wrote first is a blank line.
  test.each([
    [`<blockquote><br>text${img('1')}</blockquote>`, 'quote@0:[{"text":"\\ntext"}]'],
    [`<h1><br>text${img('1')}</h1>`, 'heading1@0:[{"text":"\\ntext"}]'],
    [`<blockquote>${img('1')}<br>text</blockquote>`, 'quote@0:[{"text":"text"}]'],
    [`<h1>${img('1')}<br>text</h1>`, 'heading1@0:[{"text":"text"}]'],
  ])('%s', (html, first) => {
    expect(read(html)[0]).toBe(first);
  });

  // S1: words beside table cells and inside inline boxes stay apart when
  // the wrapper is split around a picture, as they are without one.
  test.each([
    [
      `<a href="https://h.test/"><center>Contents</center><span style="display:table-cell">10</span><span style="display:table-cell">Algebraic Proof</span>${img('k')}</a>`,
      'Contents\n10 Algebraic Proof',
    ],
    [
      `<b><span style="display:table-cell">10</span><span style="display:table-cell">Title${img('k')}</span></b>`,
      '10 Title',
    ],
    [
      `<b><span style="display:table"><span style="display:table-cell">a</span><span style="display:table-cell">b${img('k')}</span></span></b>`,
      'a b',
    ],
    [
      `<b>${img('x', 'cid:')}<span style="display:table-cell">a</span><span style="display:table-cell">b</span></b>`,
      'a b',
    ],
    [
      `<b><span style="display:inline-block"><span style="display:block">top</span><span style="display:block">bottom${img('k')}</span></span> next</b>`,
      'top bottom',
    ],
  ])('%s keeps its words apart', (html, text) => {
    expect(
      blocksFromHtml(document, html)
        .filter((block) => block.type !== 'image')
        .map((block) => richToPlainText(block.content))
        .join('|'),
    ).toContain(text);
  });

  // S2: a line of its own by being an item or by its declared display, not
  // only by its tag -- a line, as without the picture, never the same words.
  test.each([
    [`<b style="display:flex">loose<span>z${img('k')}</span></b>`, 'loose\nz'],
    [`<b>q<span style="display:block">z${img('k')}</span></b>`, 'q\nz'],
    [`x<span style="display:block;font-weight:bold">q${img('k')}</span>`, 'x\nq'],
  ])('%s is a line of its own', (html, text) => {
    const texts = blocksFromHtml(document, html)
      .filter((block) => block.type !== 'image')
      .map((block) => richToPlainText(block.content));

    expect(texts).toEqual([text]);
    expect(
      blocksFromHtml(document, html.replace(img('k'), '')).map((block) =>
        richToPlainText(block.content),
      ),
    ).toEqual([text]);
  });

  // S3: whitespace between items is not drawn, whatever their white-space.
  test.each([
    ['<b style="display:flex;white-space:pre"><span>a</span>\n<span>c</span></b>', 'a\nc'],
    [
      `<b><span style="display:flex;white-space:pre"><span>a</span>\n<span>c</span></span>${img('k')}</b>`,
      'a\nc',
    ],
  ])('%s reads no blank lines', (html, text) => {
    expect(richToPlainText(blocksFromHtml(document, html)[0]!.content)).toBe(text);
  });

  // Q7: at the size the item's test uses; a scan per list as cheap as an
  // array lookup still costs less than the parse at any size worth running.
  test('a quote placing its images is linear', () => {
    expect(
      growth((n) => {
        blocksFromHtml(
          document,
          `<blockquote>a${`<ul><li>b</li></ul><span>${img('i')}</span>`.repeat(n)}</blockquote>`,
        );
      }, 400),
    ).toBeLessThan(LINEAR);
  }, 120_000);
});

describe('reader fixes, review round 3', () => {
  const img = (name: string, scheme = 'https://x.test/') => `<img src="${scheme}${name}.png">`;
  const read = (html: string) =>
    blocksFromHtml(document, html).map((block) =>
      block.type === 'image'
        ? `image@${block.depth}:${block.src?.replace('https://x.test/', '')}`
        : `${block.type}@${block.depth}:${JSON.stringify(block.content)}`,
    );
  /** Every run, from text, captions and table cells, as `text[marks]`. */
  const runs = (html: string) =>
    blocksFromHtml(document, html).flatMap((block) =>
      [...(block.content ?? []), ...(block.rows ?? []).flat(2)].map(
        (run) => `${run.text}[${[...(run.marks ?? [])].sort().join(',')}]`,
      ),
    );
  const texts = (html: string) =>
    blocksFromHtml(document, html)
      .filter((block) => block.type !== 'image')
      .map((block) => richToPlainText(block.content));
  /** A blank line, as a blank paragraph or as the break ending the text before it. */
  const blankLines = (html: string) =>
    read(html).filter(
      (block) =>
        (block.startsWith('paragraph@') && block.endsWith(':[]')) || block.includes('\\n"'),
    ).length;

  // Y1: a wrapper inside an item, a quote, a cell or a summary that turns a
  // container's mark off wins there too.
  test.each([
    [
      '<nav style="font-weight:600"><ul><li><a href="https://x.test/x" style="font-weight:400"><div>Title</div><p>desc</p></a></li></ul></nav>',
      ['Title\ndesc[]'],
    ],
    [
      '<header style="font-weight:bold"><ul><li><span style="font-weight:normal;font-style:italic"><div>x</div></span></li></ul></header>',
      ['x[italic]'],
    ],
    [
      '<header style="font-weight:bold"><blockquote><em style="font-weight:normal"><p>x</p></em></blockquote></header>',
      ['x[italic]'],
    ],
    [
      '<header style="font-weight:bold"><table><tr><td><a href="https://x.test/x" style="font-weight:normal"><div>x</div></a></td></tr></table></header>',
      ['x[]'],
    ],
    [
      '<header style="font-weight:bold"><details><summary><a href="https://x.test/x" style="font-weight:normal"><div>T</div></a></summary>b</details></header>',
      ['T[]', 'b[bold]'],
    ],
    [
      '<nav style="font-weight:bold"><ul><li>t<ul><a href="https://x.test/x" style="font-weight:normal"><li>x</li></a></ul></li></ul></nav>',
      ['t[bold]', 'x[]'],
    ],
  ])('%s turns the mark off where it stands', (html, expected) => {
    expect(runs(html)).toEqual(expected);
  });

  // Y2: `inherit` asks for the container's mark rather than turning it off,
  // and so does every value the reader cannot resolve.
  test.each([
    ['<header style="font-weight:bold"><p style="font: inherit">x</p></header>', 'x[bold]'],
    ['<header style="font-weight:bold"><p style="font-weight: inherit">x</p></header>', 'x[bold]'],
    ['<header style="font-weight:bold"><p style="font-weight: unset">x</p></header>', 'x[bold]'],
    ['<header style="font-weight:bold"><p style="font-weight: var(--w)">x</p></header>', 'x[bold]'],
    [
      '<header style="font-style:italic"><p style="font-style: inherit">x</p></header>',
      'x[italic]',
    ],
    [
      '<header style="font-style:italic"><p style="font-style: oblique 10deg">x</p></header>',
      'x[italic]',
    ],
    [
      '<header style="font-weight:bold"><ul><li style="font-weight: inherit">x</li></ul></header>',
      'x[bold]',
    ],
    ['<b><span style="font-weight:inherit">x</span></b>', 'x[bold]'],
    ['<p><span style="font-style: oblique 10deg">x</span></p>', 'x[italic]'],
  ])('%s keeps the mark', (html, expected) => {
    expect(runs(html)).toEqual([expected]);
  });

  // Y3: a row further in reads as one marked run, as a row at the top does:
  // each item's shell lays it out as an item (round 11, E11-1), so the break
  // between two of them is drawn inside the marks.
  test.each([
    '<header style="font-weight:bold"><div style="display:flex"><span>a</span><span>c</span></div></header>',
    '<b><footer style="display:flex"><span>a</span><span>c</span></footer></b>',
  ])('%s keeps its items apart and marked', (html) => {
    expect(runs(html)).toEqual(['a\nc[bold]']);
  });

  // Y4: a space at a paste's edge stays, styled or not.
  test.each([
    [
      '<footer style="display:flex;font-weight:bold"> a</footer>',
      '<footer style="display:flex"> a</footer>',
    ],
    [
      '<footer style="display:flex;font-weight:bold"><span> a</span><span>c </span></footer>',
      '<footer style="display:flex"><span> a</span><span>c </span></footer>',
    ],
  ])('%s keeps its edges', (styled, plain) => {
    expect(texts(styled)).toEqual(texts(plain));
  });

  // Y5 was answered the other way in round 4 (M3): a `text-decoration: none`
  // below a container's decoration takes it off on every path, as text read
  // in place always had it; see "reader fixes, review round 4".

  // P1: a gap goes before a cell or a stacked part only after another one on
  // the same parent, as the walk puts it -- never after any earlier text.
  test.each([
    [`<b>x<span style="display:table-cell">y${img('k')}</span></b>`, 'xy'],
    [
      `<b>x<span style="display:inline-block"><span style="display:block">y${img('k')}</span></span></b>`,
      'xy',
    ],
    [
      `<b><span style="display:table-cell">a</span><span><span style="display:table-cell">b${img('k')}</span></span></b>`,
      'ab',
    ],
  ])('%s takes no gap', (html, text) => {
    expect(texts(html)[0]).toBe(text);
  });

  test('loose text before a cell holding a picture takes no gap', () => {
    expect(read(`<b><i>x</i><span style="display:table-cell">y${img('k')}</span></b>`)[0]).toBe(
      `paragraph@0:${JSON.stringify([
        { text: 'x', marks: ['bold', 'italic'] },
        { text: 'y', marks: ['bold'] },
      ])}`,
    );
  });

  // P2: and after one the split descended into.
  test.each([
    [
      `<b><span style="display:table-cell">a${img('k')}b</span><span style="display:table-cell">c</span></b>`,
      ['a', 'b c'],
    ],
    [
      `<b><span style="display:inline-block"><span style="display:block">a</span><span style="display:block">b${img('k')}c</span><span style="display:block">d</span></span></b>`,
      ['a b', 'c d'],
    ],
  ])('%s keeps the next one apart', (html, expected) => {
    expect(texts(html)).toEqual(expected);
  });

  // P3: a piece copied out of an inline box keeps the box.
  test.each([
    [
      `<b>x<span style="display:inline-block"><span><span style="display:block">p</span></span>${img('k')}</span>y</b>`,
      ['xp', 'y'],
    ],
    [
      `<b><span style="display:inline-block">${img('k')}<span><span style="display:block">p</span><span style="display:block">q</span></span></span></b>`,
      ['p q'],
    ],
  ])('%s stays in its line', (html, expected) => {
    expect(texts(html)).toEqual(expected);
  });

  // P4: what the walk does not draw between two cells keeps them side by side.
  test.each(['<!--x-->', '<script>s</script>', '<template></template>'])(
    'cells either side of %s stay apart',
    (between) => {
      expect(
        texts(
          `<b><span style="display:table-cell">a</span>${between}<span style="display:table-cell">b</span>${img('k')}</b>`,
        ),
      ).toEqual(['a b']);
    },
  );

  // P5: spaces inside one anonymous item are text, not the gap between items.
  test('spaces between comments in a flex item are kept', () => {
    expect(texts('<b style="display:flex;white-space:pre">x<!---->   <!---->y</b>')).toEqual([
      'x   y',
    ]);
  });

  // E1: a picture alone on its line ends that line with its own break; the
  // blank line the author wrote before it stays.
  test.each([
    [`<blockquote><br>${img('1')}<br>text</blockquote>`, 'quote@0:[{"text":"\\ntext"}]'],
    [`<h1><br>${img('1')}<br>Title</h1>`, 'heading1@0:[{"text":"\\nTitle"}]'],
    [`<blockquote><br><br>${img('1')}<br>text</blockquote>`, 'quote@0:[{"text":"\\n\\ntext"}]'],
    [
      `<blockquote><div><br></div><div>${img('1')}<br></div><div>text</div></blockquote>`,
      'quote@0:[{"text":"\\ntext"}]',
    ],
    [`<blockquote><br>${img('1')}text</blockquote>`, 'quote@0:[{"text":"\\ntext"}]'],
  ])('%s', (html, first) => {
    expect(read(html)[0]).toBe(first);
  });

  // E2-E5: an item's line ends, wherever they come from, are what they are
  // outside a list.
  test.each([
    // A bare picture, and a line of its own, between two of the item's blocks.
    `t${img('1')}<br><a href="https://x.test/"><br>${img('2')}</a>`,
    `t${img('1')}<span style="display:block">u</span><a href="https://x.test/"><br>${img('2')}</a>`,
    // A picture the reader cannot use ends nothing.
    `t${img('1')}<br>${img('x', 'cid:')}<a href="https://x.test/"><br>${img('2')}</a>`,
    // A line of its own after the picture, inside the same wrapper.
    `t<span>${img('1')}<span style="display:block">u</span></span><a href="https://x.test/"><br>${img('2')}</a>`,
  ])('<ul><li>%s</li></ul> keeps its blank line', (inner) => {
    expect(blankLines(`<ul><li>${inner}</li></ul>`)).toBe(1);
    expect(blankLines(inner)).toBe(1);
  });

  // E4 counted a preserved newline after the picture as ending its line;
  // round 4 (I4) found that double-counted the line the item text already
  // keeps. See "a preserved newline after the picture is one blank line".

  // E5: what the head-break strip passes over: nested lists and skipped elements.
  test.each([
    [
      `<blockquote><ul><li>a<br>b</li></ul>${img('1')}<br>text</blockquote>`,
      'quote@0:[{"text":"text"}]',
    ],
    [
      `<blockquote><noscript><br></noscript>${img('1')}<br>text</blockquote>`,
      'quote@0:[{"text":"text"}]',
    ],
  ])('%s', (html, first) => {
    expect(read(html)[0]).toBe(first);
  });
});

describe('reader fixes, review round 4', () => {
  const img = (name: string, scheme = 'https://x.test/') => `<img src="${scheme}${name}.png">`;
  const read = (html: string) =>
    blocksFromHtml(document, html).map((block) =>
      block.type === 'image'
        ? `image@${block.depth}:${block.src?.replace('https://x.test/', '')}`
        : `${block.type}@${block.depth}:${JSON.stringify(block.content)}`,
    );
  const runs = (html: string) =>
    blocksFromHtml(document, html).flatMap((block) =>
      [...(block.content ?? []), ...(block.rows ?? []).flat(2)].map(
        (run) => `${run.text}[${[...(run.marks ?? [])].sort().join(',')}]`,
      ),
    );
  const texts = (html: string) =>
    blocksFromHtml(document, html)
      .filter((block) => block.type !== 'image')
      .map((block) => richToPlainText(block.content));
  const blankLines = (html: string) =>
    read(html).filter(
      (block) =>
        (block.startsWith('paragraph@') && block.endsWith(':[]')) || block.includes('\\n"'),
    ).length;

  // I1-I3: the head of a heading's or quote's text loses only the line a
  // picture handed on stood on alone -- read off the parse's own lines.
  test.each([
    [
      `<blockquote type="cite"><div>${img('1')}</div><div><br></div><div>text</div></blockquote>`,
      '\ntext',
    ],
    [`<blockquote><p>${img('1')}</p><p><br></p><p>text</p></blockquote>`, '\ntext'],
    [`<blockquote>${img('1')}<div><br>text</div></blockquote>`, '\ntext'],
    [`<h1><div>${img('1')}</div><div><br></div>Title</h1>`, '\nTitle'],
    [`<blockquote><br>${img('1')}${img('2')}<br>text</blockquote>`, '\ntext'],
    [`<blockquote><br>${img('1')}${img('x', 'cid:')}<br>text</blockquote>`, '\ntext'],
    [`<blockquote style="white-space:pre-wrap"><br>${img('1')}\ntext</blockquote>`, '\ntext'],
    [`<blockquote style="white-space:pre-wrap">\n${img('1')}text</blockquote>`, '\ntext'],
    [`<blockquote><noscript>x</noscript>${img('1')}<br>text</blockquote>`, 'text'],
    [`<h1><br>x${img('1')}<br>y</h1>`, '\nx\ny'],
  ])('%s reads %j', (html, text) => {
    expect(texts(html)[0]).toBe(text);
  });

  // I4: a newline a style preserves after the picture is the item text's own,
  // so the item reads one blank line, as the same markup outside a list.
  test('a preserved newline after the picture is one blank line', () => {
    const inner = `<span>t${img('1')}\n</span><a href="https://x.test/"><br>${img('2')}</a>`;

    expect(blankLines(`<ul><li style="white-space:pre">${inner}</li></ul>`)).toBe(1);
    expect(blankLines(`<div style="white-space:pre">${inner}</div>`)).toBe(1);
  });

  // A run split at its pictures: a `<br>` with only the picture after it is
  // the filler of its line, and a block's break before the picture is no line
  // of the text's.
  test.each([
    [`<p>text<br>${img('1')}more</p>`, ['text', '[img]', 'more']],
    [
      `<b><span style="display:flex"><span>a</span><span>c</span></span>${img('1')}more</b>`,
      ['a\nc', '[img]', 'more'],
    ],
  ])('%s reads %j', (html, expected) => {
    expect(
      blocksFromHtml(document, html).map((block) =>
        block.type === 'image' ? '[img]' : richToPlainText(block.content),
      ),
    ).toEqual(expected);
  });

  // I10: the reset at each of the item's blocks.
  test('a line ended before a block is not ended again after the next one', () => {
    expect(
      read(
        `<ul><li>t<br><a href="https://x.test/">${img('1')}</a>x<a href="https://x.test/"><br>${img('2')}</a></li></ul>`,
      ),
    ).toEqual([
      `bulleted_list@0:${JSON.stringify([{ text: 't\nx' }])}`,
      'image@1:1.png',
      'image@1:2.png',
    ]);
  });

  // I5 / M2: `lighter` under an ordinary bold is normal weight.
  test.each([
    ['<p><b><span style="font-weight:lighter">x</span></b></p>', 'x[]'],
    ['<header style="font-weight:700"><p style="font-weight:lighter">x</p></header>', 'x[]'],
  ])('%s reads %s', (html, expected) => {
    expect(runs(html)).toEqual([expected]);
  });

  // I6 / M4: a custom property that sets only a colour leaves the line.
  test.each([
    '<p><span style="text-decoration: underline var(--c)">x</span></p>',
    '<p><span style="text-decoration: underline dotted var(--accent)">x</span></p>',
  ])('%s is underlined', (html) => {
    expect(runs(html)).toEqual(['x[underline]']);
  });

  // M1: on a mark's own tag, a value the reader cannot resolve replaces the
  // tag's mark as CSS replaces the user agent's.
  test.each([
    '<p><b style="font-weight:inherit">x</b>y</p>',
    '<p><strong style="font-weight:unset">x</strong>y</p>',
    '<p><b style="font:inherit">x</b>y</p>',
    '<p><em style="font-style:inherit">x</em>y</p>',
    '<p><u style="text-decoration:inherit">x</u>y</p>',
    '<p><b style="font-weight:var(--w)">x</b>y</p>',
  ])('%s reads plain', (html) => {
    expect(runs(html)).toEqual(['xy[]']);
  });

  // M5: and inside a mark, it asks for that mark.
  test.each([
    ['<u><span style="text-decoration:inherit">x</span></u>', 'x[underline]'],
    // (`revert-layer` is not here: happy-dom drops the declaration, so a test
    // of it would pass with the code removed.)
    ['<p><span style="font-style: oblique 0deg">x</span></p>', 'x[]'],
  ])('%s reads %s', (html, expected) => {
    expect(runs(html)).toEqual([expected]);
  });

  // M3: a `text-decoration: none` below a container's decoration reads the
  // same whether the container is pushed into blocks or read in place.
  test.each([
    [
      '<footer style="text-decoration:underline"><b style="text-decoration:none"><p>x</p></b></footer>',
      '<footer style="text-decoration:underline"><p><b style="text-decoration:none">x</b></p></footer>',
    ],
    [
      '<footer style="text-decoration:underline"><span style="text-decoration:none;font-style:italic"><p>x</p></span></footer>',
      '<footer style="text-decoration:underline"><p><span style="text-decoration:none;font-style:italic">x</span></p></footer>',
    ],
  ])('%s reads as %s', (pushed, inPlace) => {
    expect(runs(pushed)).toEqual(runs(inPlace));
  });

  // G3: whitespace between flex items, joined through comments (Vue's
  // `<!--v-if-->`), is not drawn; spaces beside text, through a `<script>`,
  // are.
  test.each([
    [
      '<p>A</p><b style="white-space:pre-wrap"><span style="display:flex">\n<!---->\n<span>a</span>\n<!---->\n<span>b</span></span></b><p>Z</p>',
      'a\nb',
    ],
    [
      '<b style="display:flex;white-space:pre">x<script></script>   <script></script>y</b>',
      'x   y',
    ],
    ['<b style="display:flex;white-space:pre">x<!---->   <!---->y</b>', 'x   y'],
  ])('%s', (html, text) => {
    expect(texts(html).filter((block) => block !== 'A' && block !== 'Z')).toEqual([text]);
  });

  // A cell after one holding the picture, past an empty element, is apart.
  test('a cell after a split cell stays apart', () => {
    expect(
      texts(
        `<b><span style="display:table-cell">a${img('k')}b</span><span></span><span style="display:table-cell">c</span></b>`,
      ),
    ).toEqual(['a', 'b c']);
  });

  // The split reads the run as it reads without the picture, cut where the
  // picture stands: cells and stacked parts stay apart.
  test.each([
    [
      `<p>A</p><a href="https://x.test/u">Visit <span style="display:inline-table">${img('k')}<span style="display:table-cell">10</span><span style="display:table-cell">Title</span></span></a><p>Z</p>`,
      ['A', 'Visit', '10 Title', 'Z'],
    ],
    [
      `<a href="https://x.test/u">Visit <span style="display:inline-block">${img('k')}<span style="display:block">Line one</span><span style="display:block">Line two</span></span></a>`,
      ['Visit', 'Line one Line two'],
    ],
  ])('%s reads %j', (html, expected) => {
    expect(texts(html)).toEqual(expected);
  });

  // With the picture first, block for block as without it. (Joined into
  // words instead, a block boundary passed for a word gap.)
  test.each([
    `<b><span style="display:flex">${img('k')}<span style="display:inline-block">f<span style="display:block">g</span></span></span></b>`,
    `<b>${img('k')}<span style="display:table-cell">a</span><!----><span style="display:table-cell">&#8203;</span><!----><span style="display:table-cell">b</span></b>`,
  ])('%s reads as without the picture', (html) => {
    expect(texts(html)).toEqual(texts(html.replace(img('k'), '')));
  });
});

describe('splitting a run at its pictures', () => {
  // Thousands of pictures in one run, between marked text, read in one parse
  // and split in one pass.
  test('is linear in the pictures', () => {
    expect(
      growth((n) => {
        blocksFromHtml(
          document,
          `<p>${'<b>q</b><img src="https://x.test/i.png"><i>r</i>'.repeat(n)}</p>`,
        );
      }, 300),
    ).toBeLessThan(LINEAR);
  }, 120_000);
});

describe('reader fixes, review round 5', () => {
  const img = (name: string, scheme = 'https://x.test/') => `<img src="${scheme}${name}.png">`;
  const shape = (html: string) =>
    blocksFromHtml(document, html).map((block) =>
      block.type === 'image'
        ? `[img ${block.src?.replace(/^.*\//, '')}]`
        : richToPlainText(block.content),
    );
  const marksOf = (html: string) =>
    blocksFromHtml(document, html)
      .flatMap((block) => (block.content ?? []).flatMap((run) => run.marks ?? []))
      .sort();

  // A1: in a heading or quote, whose pictures are handed on after it, a
  // block's line before a picture is still a line: the picture cuts nothing.
  test.each([
    [`<blockquote><p>Quote text</p>${img('1')}Author</blockquote>`, 'Quote text\nAuthor'],
    [`<h2><div>Title</div>${img('1')}subtitle</h2>`, 'Title\nsubtitle'],
    [`<h1><span style="display:block">A</span>${img('1')}B</h1>`, 'A\nB'],
    [`<h1><div>a</div><div>${img('1')}c</div></h1>`, 'a\nc'],
  ])('%s reads %j', (html, text) => {
    expect(shape(html)[0]).toBe(text);
  });

  // A2: layout whitespace between a block and a picture is no line of its own.
  test.each([
    `<a href="https://l.test/">\n  <span style="display:block">Title</span>\n  ${img('1')}\n  Caption\n</a>`,
    `<span>\n  <center>Title</center>\n  ${img('1')}\n  Caption\n</span>`,
    `<b><span style="display:block">Title</span> ${img('1')}y</b>`,
  ])('%s ends the title at the picture', (html) => {
    expect(shape(html)[0]).toBe('Title');
  });

  // A3: a picture whose source is its <picture>'s, beside a block.
  test('a picture holding a block keeps its picture', () => {
    const blocks = blocksFromHtml(
      document,
      '<picture><source srcset="https://e.test/s.png 2x"><img alt="pic"><div>caption</div></picture>',
    );

    expect(blocks.map((block) => block.type)).toEqual(['image', 'paragraph']);
    expect(blocks[0]).toMatchObject({ src: 'https://e.test/s.png', alt: 'pic' });
  });

  // A4: a picture past the inline nesting bound is still handed on.
  test('a picture past the nesting bound is kept', () => {
    expect(shape(`${'<span>'.repeat(2100)}a ${img('1')} b${'</span>'.repeat(2100)}`)).toContain(
      '[img 1.png]',
    );
  });

  // A5 / A6: a U+FDD6 the text holds is the text's, beside a picture too.
  test.each([
    [`<h1>T&#xFDD6;itle${img('1')}</h1>`, ['T﷖itle', '[img 1.png]']],
    [`<blockquote>a﷖b<br>${img('1')}</blockquote>`, ['a﷖b', '[img 1.png]']],
    [`<blockquote>${img('1')}﷖</blockquote>`, ['﷖', '[img 1.png]']],
    [`<p>a&#xFDD6;b ${img('1')} c</p>`, ['a﷖b', '[img 1.png]', 'c']],
  ])('%s keeps its own character', (html, expected) => {
    expect(shape(html)).toEqual(expected);
  });

  // A6: a preserved break that ends the line a picture ends is no line.
  test.each([
    [`<p style="white-space:pre-wrap">text\n${img('1')}more</p>`, ['text', '[img 1.png]', 'more']],
    [`<span style="white-space:pre-wrap">a\n${img('1')}</span>`, ['a', '[img 1.png]']],
  ])('%s', (html, expected) => {
    expect(shape(html)).toEqual(expected);
  });

  // A6: whether the text after the last picture is a blank line is decided by
  // its own `<br>`s -- the one before the picture is that picture's line.
  test('a break before the last picture makes no blank line after it', () => {
    const blanks = (html: string) => shape(html).filter((text) => text === '').length;

    expect(blanks(`<span style="white-space:pre-wrap"><br>${img('1')}\n\n</span><p>x</p>`)).toBe(
      blanks(`<span style="white-space:pre-wrap"><br>${img('1')}</span><p>x</p>`),
    );
  });

  // B2: a heading or quote with thousands of pictures reads in linear time.
  test('stripping a quote’s pictures is linear', () => {
    expect(
      growth((n) => {
        blocksFromHtml(
          document,
          `<blockquote>${`<b>q</b>${img('i')}<i>r</i>`.repeat(n)}</blockquote>`,
        );
      }, 150),
    ).toBeLessThan(LINEAR);
    expect(
      growth((n) => {
        blocksFromHtml(document, `<h1>t${`<br><b>w</b><br>${img('i')}`.repeat(n)}</h1>`);
      }, 150),
    ).toBeLessThan(LINEAR);
  }, 120_000);

  // B3: a `text-decoration: none` below a container's decoration takes it off,
  // whatever element says it -- through `yieldSoft` for one that adds no mark,
  // through `formattingWithin` for one that adds one (the nav and the link).
  test.each([
    [
      '<footer style="text-decoration:underline"><span style="text-decoration:none"><p>x</p></span></footer>',
      [],
    ],
    [
      '<footer style="text-decoration:underline"><div style="text-decoration:none"><p>x</p></div></footer>',
      [],
    ],
    [
      '<footer style="text-decoration:underline"><blockquote style="text-decoration:none">x</blockquote></footer>',
      [],
    ],
    [
      '<footer style="text-decoration:underline"><h2 style="text-decoration:none">x</h2></footer>',
      [],
    ],
    [
      '<footer style="text-decoration:underline"><ul><li style="text-decoration:none">x</li></ul></footer>',
      [],
    ],
    [
      '<footer style="text-decoration:underline"><nav style="text-decoration:none;font-weight:bold"><p>x</p></nav></footer>',
      ['bold'],
    ],
    // A link's underline is no mark either way, so the link's own line is
    // asked of a strike (see "a link's underline is how links look").
    [
      '<footer style="text-decoration:line-through"><a href="https://x.test/x" style="text-decoration:none"><p>x</p></a></footer>',
      [],
    ],
    [
      '<footer style="text-decoration:line-through"><span style="text-decoration:none"><p>x</p></span></footer>',
      [],
    ],
  ])('%s', (html, marks) => {
    expect(marksOf(html)).toEqual(marks);
  });

  // B4: a run of picture-only lines at the end takes the break before it.
  test.each([
    [`<h1>Title<br>${img('1')}<br>${img('2')}<br></h1>`, 'Title'],
    [`<h1 style="white-space:pre-line">Title\n${img('1')}\n${img('2')}</h1>`, 'Title'],
    [`<blockquote style="white-space:pre-wrap">text\n${img('1')}</blockquote>`, 'text'],
    [`<blockquote>text<br>${img('1')}<br></blockquote>`, 'text'],
  ])('%s reads %j', (html, text) => {
    expect(shape(html)[0]).toBe(text);
  });

  // B5: a picture between two cells in a heading leaves them apart.
  test('cells either side of a picture in a heading stay apart', () => {
    expect(
      shape(
        `<h1><span style="display:table-cell">1</span>${img('1')}<span style="display:table-cell">Title</span></h1>`,
      )[0],
    ).toBe('1 Title');
  });

  // B6 / B7: a decoration is decided by its line keywords alone.
  test.each([
    [
      '<p><span style="text-decoration: line-through var(--underline-color)">x</span></p>',
      ['strikethrough'],
    ],
    ['<u><span style="text-decoration: none var(--underline)">x</span></u>', []],
    ['<u style="text-decoration: UNDERLINE">x</u>', ['underline']],
    ['<u><span style="text-decoration: blink var(--c)">x</span></u>', []],
  ])('%s', (html, marks) => {
    expect(marksOf(html)).toEqual(marks);
  });

  // B7: `revert` rolls a mark's own tag back to the user agent's value, which
  // is the tag's mark. (`revert-layer` is not here: happy-dom drops it.)
  test('revert on a mark tag keeps its mark', () => {
    expect(
      blocksFromHtml(document, '<p><b style="font-weight:revert">x</b>y</p>')[0]!.content,
    ).toEqual([{ text: 'x', marks: ['bold'] }, { text: 'y' }]);
  });

  // An unstyled `<center>` holding a picture reads as without the picture.
  test('a center holding a picture is read whole', () => {
    expect(shape(`before<center>q${img('1')}z</center>after`)).toEqual([
      'before\nq',
      '[img 1.png]',
      'z\nafter',
    ]);
    expect(shape('before<center>qz</center>after')).toEqual(['before\nqz\nafter']);
  });
});

describe('reader fixes, review round 6', () => {
  const img = (name: string) => `<img src="https://x.test/${name}.png">`;
  const pic =
    '<picture><source srcset="https://e.test/s.png 2x"><img alt="pic"><div>x</div></picture>';
  const shape = (html: string) =>
    blocksFromHtml(document, html).map((block) =>
      block.type === 'image'
        ? `[img ${block.src?.replace(/^.*\//, '')}]`
        : richToPlainText(block.content),
    );
  const marksOf = (html: string) =>
    blocksFromHtml(document, html)
      .flatMap((block) => (block.content ?? []).flatMap((run) => run.marks ?? []))
      .sort();

  // R1: a blank line the author wrote before pictures at the end of a heading
  // or quote stays, as it does in an inline run.
  test.each([
    [`<h2>T<br>${img('1')}<br><br>${img('2')}</h2>`, 'T\n'],
    [`<blockquote>Line<br>${img('1')}<br><br>${img('2')}</blockquote>`, 'Line\n'],
    [`<blockquote>Line<br><br>${img('1')}<br><br>${img('2')}</blockquote>`, 'Line\n\n'],
  ])('%s reads %j', (html, text) => {
    expect(shape(html)[0]).toBe(text);
  });

  // K8 was reverted in round 7 (V1): it took every empty last line for a
  // preserved newline, and dropped a blank line an author's `<br>` made. A
  // heading's or quote's trailing preserved newline is kept as its text keeps
  // any source whitespace, picture or not.

  // K3: a wrapped picture between two cells, or two stacked parts, in a
  // heading is nothing between them.
  test.each([
    [
      `<h1><span style="display:table-cell">1</span><a href="https://x.test/">${img('1')}</a><span style="display:table-cell">Title</span></h1>`,
      '1 Title',
    ],
    [
      `<h1><span style="display:table-cell">1</span><span>${img('1')}</span><span style="display:table-cell">Title</span></h1>`,
      '1 Title',
    ],
    [
      `<h1><span style="display:inline-block"><span style="display:block">a</span><span>${img('1')}</span><span style="display:block">b</span></span></h1>`,
      'a b',
    ],
  ])('%s reads %j', (html, text) => {
    expect(shape(html)[0]).toBe(text);
  });

  // K4 / R4: the text's own U+FDD6 is text, picture or none in sight.
  test.each([
    ['<h1><div>a</div><b>&#xFDD6;</b></h1>', 'a\n﷖'],
    ['<p><span style="display:block">a</span>&#xFDD6;</p>', 'a\n﷖'],
  ])('%s reads %j', (html, text) => {
    expect(shape(html)[0]).toBe(text);
  });

  // R2: a picture whose source is its <picture>'s is judged as itself on
  // every path that hands pictures on.
  test.each([
    `<b><h1>T<br>${pic}</h1></b>`,
    `<b><blockquote>T${pic}</blockquote></b>`,
    `<b><ul><li>T${pic}</li></ul></b>`,
    `<b><table><tr><td>T${pic}</td></tr></table></b>`,
  ])('%s keeps its picture', (html) => {
    expect(shape(html)).toContain('[img s.png]');
  });

  // R5: the line break before such a picture is the picture's filler -- which
  // asks `imageSource` for the picture's source through its original's
  // <picture>, as every path that judges a picture does (R2).
  test('a break before a picture in its picture is filler', () => {
    expect(
      shape(
        '<picture><source srcset="https://e.test/s.png 2x"><span>x<br></span><img alt="pic"><span>y</span><div>c</div></picture>',
      ),
    ).toEqual(['x', '[img s.png]', 'y', 'c']);
  });

  // R3: past the block and list nesting bounds a picture is still kept.
  test.each([
    `${'<div>'.repeat(1100)}a ${img('1')} b${'</div>'.repeat(1100)}`,
    `${'<ul><li>'.repeat(300)}a ${img('1')} b${'</li></ul>'.repeat(300)}`,
  ])('a picture past a nesting bound is kept (%#)', (html) => {
    expect(shape(html)).toContain('[img 1.png]');
  });

  // K1: `revert` on a mark's own tag keeps the tag's mark however the DOM
  // spells it -- Chromium writes the longhand and the shorthand both.
  test('revert on a decoration tag keeps it', () => {
    expect(
      marksOf('<p><u style="text-decoration: revert; text-decoration-line: revert">x</u></p>'),
    ).toEqual(['underline']);
  });

  // K2: a block's own decoration is no mark, so the `off` its shorthand
  // implies is none either; only `none` takes a container's decoration off.
  test.each([
    [
      '<footer style="text-decoration: line-through"><p style="text-decoration: underline">a</p></footer>',
      ['strikethrough'],
    ],
    [
      '<footer style="text-decoration: underline"><div style="text-decoration: line-through"><p>x</p></div></footer>',
      ['underline'],
    ],
  ])('%s', (html, marks) => {
    expect(marksOf(html)).toEqual(marks);
  });

  // K5 / K6: an undefined custom property draws its fallback -- which is what
  // a paste usually has, the page's definitions not coming with it.
  test.each([
    ['<p><span style="text-decoration: var(--deco, underline)">x</span></p>', ['underline']],
    ['<p><span style="text-decoration: var(--deco, underline wavy)">x</span></p>', ['underline']],
    [
      '<s><span style="text-decoration: var(--a, rgb(0 0 0) underline wavy)">x</span></s>',
      ['underline'],
    ],
    ['<u><span style="text-decoration: var(--underline-color)">x</span></u>', ['underline']],
    // (A weight or a style through a fallback is in round 7's W6: happy-dom
    // drops one spelled with a space after the comma, and keeps one without.)
    // K7: the error lines are line keywords too.
    ['<u><span style="text-decoration: spelling-error var(--c)">x</span></u>', []],
  ])('%s', (html, marks) => {
    expect(marksOf(html)).toEqual(marks);
  });
});

describe('reader fixes, review round 7', () => {
  const img = (name: string) => `<img src="https://x.test/${name}.png">`;
  const shape = (html: string) =>
    blocksFromHtml(document, html).map((block) =>
      block.type === 'image'
        ? `[img ${block.src?.replace(/^.*\//, '')}]`
        : richToPlainText(block.content),
    );
  const marksOf = (html: string) =>
    blocksFromHtml(document, html)
      .flatMap((block) => (block.content ?? []).flatMap((run) => run.marks ?? []))
      .sort();

  // V1: a blank line the author wrote after the last picture line stays.
  test.each([
    [`<h1>A<br>${img('1')}<br><br></h1>`, 'A\n'],
    [`<blockquote>A<br>${img('1')}<div><br></div></blockquote>`, 'A\n'],
    [`<blockquote><p>A<br>${img('1')}</p><br></blockquote>`, 'A\n'],
    [`<blockquote>Line<br>${img('1')}<br><br>${img('2')}<br><br></blockquote>`, 'Line\n\n'],
  ])('%s reads %j', (html, text) => {
    expect(shape(html)[0]).toBe(text);
  });

  // V2: a read never depends on the pictures earlier reads held. In a fresh
  // module, as a new page has it: the count that leaked only lined up with
  // `out` while it was small, which earlier tests in this file are past.
  test('earlier pictures change no later read', async () => {
    vi.resetModules();
    const fresh = await import('./rich-dom.ts');
    const read = (html: string) =>
      fresh.blocksFromHtml(document, html).map((block) => richToPlainText(block.content));
    const cell = '<h1>a<span style="display:table-cell">b</span></h1>';

    expect(read(cell)).toEqual(['ab']);
    read(`<h1>x${img('p')}${img('q')}</h1>`);
    expect(read(cell)).toEqual(['ab']);
  });

  // V3: the gap across a picture between two cells is one space.
  test.each([
    [
      `<h1><span style="display:table-cell">bb </span><span>${img('1')}</span><span style="display:table-cell">c</span></h1>`,
      'bb c',
    ],
    [
      `<h1><span style="display:inline-block"><span style="display:block">a </span><span>${img('1')}</span><span style="display:block">b</span></span></h1>`,
      'a b',
    ],
  ])('%s reads %j', (html, text) => {
    expect(shape(html)[0]).toBe(text);
  });

  // V4 / W1: a picture of many unsourced images, and a style of many custom
  // properties, read in linear time.
  test('many images in one picture, and many fallbacks, are linear', () => {
    expect(
      growth((n) => {
        blocksFromHtml(
          document,
          `<picture><source srcset="https://e.test/s.png 2x">${'<img alt="a">'.repeat(n)}</picture>`,
        );
      }, 200),
    ).toBeLessThan(LINEAR);
    expect(
      growth((n) => {
        blocksFromHtml(
          document,
          `<p><u><span style="text-decoration: ${'var(--a,x) '.repeat(n)}underline">x</span></u></p>`,
        );
      }, 2000),
    ).toBeLessThan(LINEAR);
  }, 120_000);

  // W2 / W3: a wrapper's decoration is a mark, so a container's yields to it;
  // only a block's own stated line leaves the container's alone, whatever
  // line it names.
  test.each([
    [
      '<footer style="text-decoration:underline"><blockquote><span style="text-decoration:line-through"><p>x</p></span></blockquote></footer>',
      ['strikethrough'],
    ],
    [
      '<footer style="text-decoration:underline"><table><tr><td><span style="text-decoration:line-through"><p>x</p></span></td></tr></table></footer>',
      ['strikethrough'],
    ],
    [
      '<footer style="text-decoration:underline"><div style="text-decoration:overline"><p>x</p></div></footer>',
      ['underline'],
    ],
  ])('%s', (html, marks) => {
    const all = blocksFromHtml(document, html).flatMap((block) => [
      ...(block.content ?? []),
      ...(block.rows ?? []).flat(2),
    ]);

    expect([...new Set(all.flatMap((run) => run.marks ?? []))].sort()).toEqual(marks);
  });

  // W4: a value no keyword survives in decides nothing; an empty fallback is
  // `unset`, which takes a mark tag's own mark.
  test.each([
    ['<u><span style="text-decoration:var(--a, bogus)">x</span></u>', ['underline']],
    ['<p><u style="text-decoration:var(--d,)">x</u></p>', []],
  ])('%s', (html, marks) => {
    expect(marksOf(html)).toEqual(marks);
  });

  // W6: a weight or style read through its fallback, as GitHub's CSS writes
  // `<strong>`'s; and lowercased there too.
  test.each([
    ['<p><span style="font-weight:var(--w,700)">x</span></p>', ['bold']],
    [
      '<p><strong style="font-weight:var(--base-text-weight-semibold,600)">x</strong></p>',
      ['bold'],
    ],
    ['<p><span style="font-weight:var(--w,BOLD)">x</span></p>', ['bold']],
    ['<p><span style="font-style:var(--s,ITALIC)">x</span></p>', ['italic']],
    // `env()` and `attr()` draw their fallback only for a name the UA does
    // not know or an attribute that is missing, which the reader does not
    // check: they decide nothing, and the tag's mark around them stays.
    ['<u><span style="text-decoration:env(x, none)">x</span></u>', ['underline']],
  ])('%s', (html, marks) => {
    expect(marksOf(html)).toEqual(marks);
  });

  // W7: a fallback holding a function, read past its parentheses.
  test('a nested fallback is read whole', () => {
    expect(
      marksOf('<u><span style="text-decoration: var(--a, rgb(0 0 0) none)">x</span></u>'),
    ).toEqual([]);
  });

  // W9: `revert-layer` on a decoration tag keeps the tag's mark.
  test('revert-layer on a decoration tag keeps it', () => {
    expect(marksOf('<p><u style="text-decoration: revert-layer">x</u></p>')).toEqual(['underline']);
  });
});

describe('reader fixes, review round 8', () => {
  const img = (name: string) => `<img src="https://x.test/${name}.png">`;
  const shape = (html: string) =>
    blocksFromHtml(document, html).map((block) =>
      block.type === 'image'
        ? `[img ${block.src?.replace(/^.*\//, '')}]`
        : richToPlainText(block.content),
    );
  const marksOf = (html: string) =>
    [
      ...new Set(
        blocksFromHtml(document, html).flatMap((block) =>
          [...(block.content ?? []), ...(block.rows ?? []).flat(2)].flatMap(
            (run) => run.marks ?? [],
          ),
        ),
      ),
    ].sort();

  // X1: source layout after the last picture line is no line of the text's;
  // a line written after it -- a `<br>`, a block's -- still is (V1).
  test.each([
    [`<blockquote>\n<p>Note</p>\n<a href="https://l.test/">${img('1')}</a>\n</blockquote>`, 'Note'],
    [`<blockquote>\n  <div>A</div>\n  <span>${img('1')}</span>\n</blockquote>`, 'A'],
    [`<h1>A<br>${img('1')}\n</h1>`, 'A'],
    [`<h1>A<br>${img('1')}<br><br></h1>`, 'A\n'],
  ])('%s reads %j', (html, text) => {
    expect(shape(html)[0]).toBe(text);
  });

  // X2: an empty cell after many pictures looks back past them once. (The
  // look-back it replaced cost about three times as much here but grew only
  // about 55x against the line of 90: the parse outweighs it, as Q7 found for
  // a scan per list. This guards against worse, not against that.)
  test('empty cells after many pictures are linear', () => {
    expect(
      growth((n) => {
        blocksFromHtml(
          document,
          `<h1><span style="display:table-cell">a</span>${img('i').repeat(n)}${'<span style="display:table-cell"></span>'.repeat(n)}</h1>`,
        );
      }, 1000),
    ).toBeLessThan(LINEAR);
  }, 120_000);

  // X3: the text's own U+FDD6 is text to the gap between cells.
  test('a cell holding U+FDD6 stays apart', () => {
    expect(
      shape(
        '<h1><span style="display:table-cell">a</span><span style="display:table-cell">﷖</span><span style="display:table-cell">b</span></h1>',
      )[0],
    ).toBe('a ﷖ b');
  });

  // Z1: thousands of custom properties in one value, at a size where the
  // old slicing was quadratic.
  test('a value of many custom properties is linear', () => {
    expect(
      growth((n) => {
        blocksFromHtml(
          document,
          `<p><u><span style="text-decoration: ${'var(--a,x) '.repeat(n)}underline">x</span></u></p>`,
        );
      }, 16000),
    ).toBeLessThan(LINEAR);
  }, 300_000);

  // Z2: a block that states a line of its own leaves a container's other line
  // alone, whatever block it is; so does a styled container inside one.
  test.each(['nav', 'header', 'main', 'aside', 'center', 'dl', 'footer'])(
    '<%s> stating a line keeps the container’s',
    (tag) => {
      expect(
        marksOf(
          `<footer style="text-decoration:underline"><${tag} style="text-decoration:overline"><p>x</p></${tag}></footer>`,
        ),
      ).toEqual(['underline']);
    },
  );

  test('a styled container stating a line keeps the other', () => {
    expect(
      marksOf(
        '<footer style="text-decoration:line-through"><nav style="text-decoration:underline"><p>x</p></nav></footer>',
      ),
    ).toEqual(['strikethrough', 'underline']);
  });

  // Z3: `oblique` is a keyword, not a prefix.
  test('a fallback that only starts with oblique is no italic', () => {
    expect(marksOf('<p><span style="font-style:var(--s,oblique-x)">x</span></p>')).toEqual([]);
  });
});

describe('reader fixes, review round 9', () => {
  const img = (name: string) => `<img src="https://x.test/${name}.png">`;
  const shape = (html: string) =>
    blocksFromHtml(document, html).map((block) =>
      block.type === 'image'
        ? `[img ${block.src?.replace(/^.*\//, '')}]`
        : `${block.type}:${richToPlainText(block.content)}`,
    );
  const marksOf = (html: string) =>
    [
      ...new Set(
        blocksFromHtml(document, html).flatMap((block) =>
          [...(block.content ?? []), ...(block.rows ?? []).flat(2)].flatMap(
            (run) => run.marks ?? [],
          ),
        ),
      ),
    ].sort();

  // Q9-1: a block's break after the last picture that nothing made stand is
  // no line of the author's; one a `<br>` made stand is.
  test.each([
    [`<h1>A<br>${img('1')}<div>\n</div></h1>`, ['heading1:A', '[img 1.png]']],
    [`<h1><br>${img('1')}<div>\n</div></h1>`, ['[img 1.png]']],
    [`<h1>A<br>${img('1')}<p></p><br></h1>`, ['heading1:A\n', '[img 1.png]']],
  ])('%s', (html, expected) => {
    expect(shape(html)).toEqual(expected);
  });

  // Q9-2: indentation closing the source after the last picture is layout.
  // (A `pre-wrap` heading's spaces-only last line after a picture goes too,
  // which a browser would draw: the trade taken for pretty-printed markup.)
  test.each([
    [
      `<blockquote>\n  <p>Note</p>\n  <a href="https://l.test/">${img('1')}</a>\n  </blockquote>`,
      'quote:Note',
    ],
    [`<h1>A<br>${img('1')}\n  </h1>`, 'heading1:A'],
  ])('%s reads %j', (html, first) => {
    expect(shape(html)[0]).toBe(first);
  });

  // Q9-3: a block by its display states a line of its own as a block by its
  // tag does; and read in place, a block stating a line keeps the line around
  // it as the pushed reading does.
  test.each([
    '<footer style="text-decoration:underline"><span style="display:block;text-decoration:overline"><p>x</p></span></footer>',
    '<table><tr><td><u><p style="text-decoration:overline">x</p></u></td></tr></table>',
    '<ul><li><u><p style="text-decoration:overline">x</p></u></li></ul>',
  ])('%s keeps the underline', (html) => {
    expect(marksOf(html)).toEqual(['underline']);
  });
});

describe('reader fixes, review round 10', () => {
  const img = (name: string) => `<img src="https://x.test/${name}.png">`;
  const shape = (html: string) =>
    blocksFromHtml(document, html).map((block) =>
      block.type === 'image'
        ? `[img@${block.depth}]`
        : `${block.type}@${block.depth}:${richToPlainText(block.content)}`,
    );
  const marksOf = (html: string) =>
    [
      ...new Set(
        blocksFromHtml(document, html).flatMap((block) =>
          [...(block.content ?? []), ...(block.rows ?? []).flat(2)].flatMap(
            (run) => run.marks ?? [],
          ),
        ),
      ),
    ].sort();

  // T10-1: a `<br>` that makes a block's break stand is the author's line,
  // whatever source whitespace stands between them.
  test.each([
    `<h1>A<br>${img('1')}<p>\n</p><br></h1>`,
    `<blockquote>A<br>${img('1')}<p></p>\n<br></blockquote>`,
    `<h1>A<br>${img('1')}<div>\n  </div><br></h1>`,
  ])('%s keeps its blank line', (html) => {
    // (Its spaces are the source's, which a heading's text keeps as it stands.)
    expect(shape(html)[0]).toMatch(/:A\n[ \t]*$/);
  });

  // T10-2: a newline a style preserves, alone in a block after the last
  // picture, goes with the picture lines -- the documented trade-off, as for
  // a `pre-wrap` block's last line of spaces.
  test('a preserved newline alone after the pictures goes with them', () => {
    expect(shape(`<h1>A<br>${img('1')}<p style="white-space:pre-wrap">\n</p></h1>`)[0]).toBe(
      'heading1@0:A',
    );
  });

  // T10-3: a flex item keeps a container's line at the top level as it does
  // read in place.
  // (A link's underline is no mark -- "a link's underline is how links
  // look" -- so the links keep the container's strike alone; the spans keep
  // their own line too.)
  test.each([
    [
      '<s><div style="display:flex"><a href="https://l.test/" style="text-decoration:underline">x</a><a href="https://l.test/" style="text-decoration:underline">y</a></div></s>',
      ['strikethrough'],
    ],
    [
      '<s><div style="display:flex"><span style="text-decoration:underline">x</span><span style="text-decoration:underline">y</span></div></s>',
      ['strikethrough', 'underline'],
    ],
    [
      '<footer style="text-decoration:line-through"><div style="display:flex"><span style="text-decoration:overline">x</span></div></footer>',
      ['strikethrough'],
    ],
  ])('%s', (html, marks) => {
    expect(marksOf(html)).toEqual(marks);
    expect(marksOf(`<ul><li>${html}</li></ul>`)).toEqual(marks);
  });

  // T10-4: a `display:block` span stating a line the reader models keeps the
  // container's other line, holding a block (the case round 10 fixed) or not
  // (read in place: its companion, which already held).
  test.each([
    '<footer style="text-decoration:underline"><span style="display:block;text-decoration:line-through"><p>x</p></span></footer>',
    '<footer style="text-decoration:underline"><span style="display:block;text-decoration:line-through">x</span></footer>',
  ])('%s keeps both lines', (html) => {
    expect(marksOf(html)).toEqual(['strikethrough', 'underline']);
  });

  // T10-5: a quote whose text all goes with its pictures is no quote, and
  // its lists stand where it stood.
  test.each([
    `<p>before</p><blockquote><ul><li>x</li></ul>${img('1')}\n </blockquote>`,
    `<p>before</p><blockquote>\n<ul>\n<li>x</li>\n</ul>\n<a href="https://l.test/">${img('1')}</a>\n  </blockquote>`,
  ])('%s keeps its list at the quote’s depth', (html) => {
    expect(shape(html)).toEqual(['paragraph@0:before', 'bulleted_list@0:x', '[img@0]']);
  });
});

describe('reader fixes, review round 11', () => {
  const runsOf = (html: string) =>
    blocksFromHtml(document, html).flatMap((block) =>
      [...(block.content ?? []), ...(block.rows ?? []).flat(2)].map(
        (run) =>
          `${run.text}[${[...(run.marks ?? [])].sort().join(',')}${run.link ? `|${run.link}` : ''}]`,
      ),
    );

  // E11-1: a flex item's own marks win over the chain around it, as they do
  // out of a row, in an item and in a cell.
  test.each([
    [
      '<a href="https://shop.test/p/1" style="text-decoration: none;"><h3>Mug</h3><div style="display: flex;"><del>$20.00</del><span>$10.00</span></div></a>',
      '$20.00[strikethrough|https://shop.test/p/1]',
    ],
    [
      '<span style="text-decoration:underline"><div style="display:flex"><s>x</s><span>y</span></div><p>z</p></span>',
      'x[strikethrough,underline]',
    ],
    [
      '<b><div style="display:flex"><span style="font-weight:normal">x</span><span>y</span></div><p>z</p></b>',
      'x[]',
    ],
    [
      '<s><div style="display:flex"><span style="text-decoration:none">x</span><span>y</span></div><p>z</p></s>',
      'x[]',
    ],
  ])('%s', (html, run) => {
    expect(runsOf(html)).toContain(run);
  });

  // E11-2: a deep chain of flex items reads without overflowing.
  test('a deep chain of flex items reads', () => {
    expect(() =>
      blocksFromHtml(
        document,
        `<b><div style="display:flex">${'<span style="display:flex">'.repeat(5000)}x${'</span>'.repeat(5000)}</div><p>z</p></b>`,
      ),
    ).not.toThrow();
  });

  // E11-3: spaces in an item keep the chain's marks and link.
  test('a space making up an item keeps the bold', () => {
    expect(
      runsOf('<b><div style="display:flex"><span> </span><span>c</span></div><p>z</p></b>'),
    ).not.toContain(' []');
  });
});

describe('reader fixes, review round 12', () => {
  const runsOf = (html: string) =>
    blocksFromHtml(document, html).flatMap((block) =>
      [...(block.content ?? []), ...(block.rows ?? []).flat(2)].map(
        (run) =>
          `${run.text}[${[...(run.marks ?? [])].sort().join(',')}${run.link ? `|${run.link}` : ''}]`,
      ),
    );

  // F12-1: loose text in a row is an item of its own (an anonymous one), and
  // the break beside it is drawn inside the marks and the link.
  test.each([
    [
      '<b><footer style="display:flex"><span>a</span>t<span>c</span></footer></b>',
      ['a\nt\nc[bold]'],
    ],
    [
      '<a href="https://w.test/"><div style="display:flex">Price: <span>$1</span></div><p>z</p></a>',
      ['Price:\n$1[|https://w.test/]', 'z[|https://w.test/]'],
    ],
  ])('%s', (html, expected) => {
    expect(runsOf(html)).toEqual(expected);
  });

  // F12-3: a chain of two marks around a row keeps the row one run: the item
  // shell's inner element is the row the item stands in.
  test('a link and bold around a row read it as one run', () => {
    expect(
      runsOf(
        '<a href="https://w.test/"><b><div style="display:flex"><span>a</span><span>c</span></div><p>z</p></b></a>',
      )[0],
    ).toBe('a\nc[bold|https://w.test/]');
  });

  // F12-3: E11-3's space, asserted where it stands.
  test('a space making up an item keeps the bold, where it stands', () => {
    expect(
      runsOf('<b><div style="display:flex"><span> </span><span>c</span></div><p>z</p></b>')[0],
    ).toMatch(/^ \n?c\[bold\]$/);
  });
});

describe('loose text in a row at a paste edge', () => {
  // A parity guard: loose text in a row and the same text in an element item
  // read the same at a paste's edge. (The edges are judged on the shell's
  // outer element, which both mark; which inner node the walk up starts from
  // changes nothing observable.)
  test('an edge space in loose row text stays as in an item', () => {
    const text = (html: string) =>
      blocksFromHtml(document, html).map((block) => richToPlainText(block.content));

    expect(text('<b><div style="display:flex"> a<span>c</span></div><p>z</p></b>')[0]).toBe(
      text('<b><div style="display:flex"><span> a</span><span>c</span></div><p>z</p></b>')[0],
    );
  });
});

describe('reader fixes, review round 13', () => {
  const runsOf = (html: string) =>
    blocksFromHtml(document, html).flatMap((block) =>
      [...(block.content ?? []), ...(block.rows ?? []).flat(2)].map(
        (run) =>
          `${run.text}[${[...(run.marks ?? [])].sort().join(',')}${run.link ? `|${run.link}` : ''}]`,
      ),
    );
  const texts = (html: string) =>
    blocksFromHtml(document, html).map((block) => richToPlainText(block.content));

  // G13-1: a no-break space is content, in a row and between blocks: it
  // keeps the marks and the link around it.
  test.each([
    [
      '<a href="https://w.test/"><div style="display:flex"><span>by</span>&nbsp;<span>Author</span></div><p>z</p></a>',
      'by\n \nAuthor[|https://w.test/]',
    ],
    ['<b><p>a</p>&nbsp;<p>b</p></b>', ' [bold]'],
  ])('%s keeps its no-break space marked', (html, run) => {
    expect(runsOf(html)).toContain(run);
  });

  // G13-2: what draws no box in a row joins the text beside it, which is one
  // anonymous item, as it reads in place.
  test.each([
    '<a href="https://w.test/"><div style="display:flex">foo<script>x</script>bar<span>c</span></div><p>z</p></a>',
    '<a href="https://w.test/"><div style="display:flex">foo<template>x</template>bar<span>c</span></div><p>z</p></a>',
  ])('%s reads one item before the span', (html) => {
    expect(texts(html)[0]).toBe('foobar\nc');
  });
});

describe('reader fixes, review round 14', () => {
  const runsOf = (html: string) =>
    blocksFromHtml(document, html).flatMap((block) =>
      [...(block.content ?? []), ...(block.rows ?? []).flat(2)].map(
        (run) =>
          `${run.text}[${[...(run.marks ?? [])].sort().join(',')}${run.link ? `|${run.link}` : ''}]`,
      ),
    );
  const texts = (html: string) =>
    blocksFromHtml(document, html).map((block) => richToPlainText(block.content));

  // H14-1: an element the reader skips but a browser draws as a box -- an
  // `<svg>` star, an `<iframe>` -- is still an item in a row: the words
  // either side stay apart.
  test.each([
    [
      '<p>q</p><a href="https://shop.test/p/1"><div style="display:flex;align-items:center">4.5<svg width="12" height="12"></svg>(120 reviews)</div><p>Blue kettle</p></a>',
      '4.5\n(120 reviews)',
    ],
    ['<b style="display:flex">Home<svg width="8"></svg>Docs<p>x</p></b>', 'Home\nDocs'],
    ['<b style="display:flex">Home<iframe></iframe>Docs<p>x</p></b>', 'Home\nDocs'],
  ])('%s keeps its words apart', (html, text) => {
    expect(texts(html)).toContain(text);
  });

  // H14-2: what the reader skips opening a row is no item of spaces.
  test.each([
    [
      '<a href="https://w.test/"><div style="display:flex">\n  <script type="application/ld+json">{}</script>\n  <span>Price</span>\n</div><p>z</p></a>',
      'Price',
    ],
  ])('%s reads %j first', (html, text) => {
    expect(texts(html)[0]).toBe(text);
  });

  // H14-3: indentation before the first text of a paste is layout, past a
  // comment or a style, as the same markup reads unwrapped.
  test.each([
    ['<b>\n<!--c-->&nbsp;<p>z</p></b>', ' '],
    ['<b>\n<!--c-->foo<p>z</p></b>', 'foo'],
  ])('%s reads %j first', (html, text) => {
    expect(texts(html)[0]).toBe(text);
  });

  // H14-4: a no-break space before indentation is the text's, kept with it
  // in the wrapper's marks -- not popped as indentation.
  test('a no-break space before a newline keeps the bold', () => {
    expect(runsOf('<b><span>x</span>&nbsp;\n<p>b</p></b>')[0]).toBe('x [bold]');
  });
});

describe('a boxed skipped item in a row, read in place', () => {
  // H14-1's sibling: read in place (no wrapper pushed in), an `<svg>` a row
  // lays out as an item still stands between the words either side, as a
  // browser draws it; a `<script>` there draws nothing and joins them.
  test.each([
    ['<div style="display:flex">foo<svg width="8"></svg>bar</div>', 'foo\nbar'],
    ['<ul><li><div style="display:flex">foo<svg width="8"></svg>bar</div></li></ul>', 'foo\nbar'],
    ['<div style="display:flex">foo<script></script>bar</div>', 'foobar'],
  ])('%s reads %j', (html, text) => {
    expect(blocksFromHtml(document, html).map((block) => richToPlainText(block.content))[0]).toBe(
      text,
    );
  });
});

describe('reader fixes, review round 15', () => {
  const texts = (html: string) =>
    blocksFromHtml(document, html).map((block) => richToPlainText(block.content));

  // J15-1: a `<br>` inside a boxed skipped item is no break of the reader's.
  test.each([
    [
      '<p>q</p><div style="display:flex"><svg><foreignObject><div>a<br>c</div></foreignObject></svg></div><p>z</p>',
      ['q', 'z'],
    ],
    ['s<div style="display:flex"><object><br></object></div>&nbsp;', ['s', ' ']],
  ])('%s reads %j', (html, expected) => {
    expect(texts(html)).toEqual(expected);
  });

  // The item a boxed skipped element is stands in the run as an empty block,
  // never as a copy of it: a `<br>` in an `<object>`'s fallback or an
  // `<svg>`'s `foreignObject` would be read as the run's own (the cases
  // above). The artifact is pinned too: nothing of the object is cloned.
  test('a boxed skipped item is not copied into the run', () => {
    const spy = vi.spyOn(Node.prototype, 'cloneNode');

    try {
      expect(
        blocksFromHtml(
          document,
          '<div style="display:flex">foo<object data="https://t.test/x"><img src="https://t.test/y.png"></object>bar</div>',
        ).map((block) => richToPlainText(block.content)),
      ).toEqual(['foo\nbar']);
      expect(spy.mock.contexts.map((node) => (node as Node).nodeName)).not.toContain('OBJECT');
      expect(spy.mock.contexts.map((node) => (node as Node).nodeName)).not.toContain('IMG');
    } finally {
      spy.mockRestore();
    }
  });

  // J15-2: `<base>` is skipped and draws nothing, in a row or out.
  test.each([
    ['<div style="display:flex">foo<base>bar</div>', 'foobar'],
    ['<b style="display:flex">foo<base>bar<p>x</p></b>', 'foobar'],
    ['<b style="display:flex">\n<base>\n<span>s</span><p>z</p></b>', 's'],
  ])('%s reads %j first', (html, text) => {
    expect(texts(html)[0]).toBe(text);
  });

  // J15-3 (a): an assistive copy of a formula in a row is no item of its
  // own. Unwrapped (no `.katex` around it), the copy is skipped and its
  // drawing read -- the TeX and the drawing told apart -- which guards the
  // copy checks in `visitBlocksInner` (top level) and `cloneDeep` (a wrapper
  // pushed in). Wrapped as KaTeX writes it, it is one formula.
  test.each(['', '<b>'])(
    'an unwrapped copy in a row reads its drawing (%j around it)',
    (wrapper) => {
      const row =
        '<div style="display:flex">a<span class="katex-mathml"><math><semantics><mi>α</mi><annotation encoding="application/x-tex">\\alpha</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span>α</span></span>b</div>';

      expect(texts(wrapper ? `<b>${row}<p>z</p></b>` : row)[0]).toBe('a\nα\nb');
    },
  );

  test('a KaTeX formula in a row is one formula', () => {
    const [block] = blocksFromHtml(
      document,
      '<div style="display:flex">a<span class="katex"><span class="katex-mathml"><math><semantics><mi>α</mi><annotation encoding="application/x-tex">\\alpha</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span>α</span></span></span>b</div>',
    );

    expect(block!.content.filter((run) => run.math !== undefined)).toEqual([
      expect.objectContaining({ math: '\\alpha' }),
    ]);
  });

  // And where the drawing beside a copy draws no box, the copy is no item
  // either: the two sides are one line (`drawsNoBox`'s assistive half).
  test('a copy beside a box-less drawing is no item', () => {
    expect(
      texts(
        '<div style="display:flex">a<span class="katex-mathml"><math><semantics><mi>α</mi><annotation encoding="application/x-tex">\\alpha</annotation></semantics></math></span><script class="katex-html"></script>b</div>',
      )[0],
    ).toBe('ab');
  });

  // J15-3 (b): indentation is left out of a run only before a paste's first
  // text; elsewhere it is the run's, and keeps its link.
  test('indentation after the paste starts keeps its link', () => {
    const blocks = blocksFromHtml(
      document,
      '<a href="https://l.test/"><img src="https://i.test/b.png" alt="B"><p>\n<!--c-->\nbaz </p></a>',
    );
    const runs = blocks.flatMap((block) => block.content ?? []);

    expect(runs.every((run) => run.link === 'https://l.test/')).toBe(true);
  });
});

describe('the reader builds nothing in the live document', () => {
  // A pasted `<img onerror>` copied into an element of the live document is
  // adopted into it, starts loading, and runs its handler: script from the
  // clipboard. The reader's scratch DOM -- every wrapper, fragment and
  // copy -- belongs to a document with no browsing context. happy-dom loads
  // nothing, and makes a template's contents owner the live document itself,
  // so the artifact is pinned: the live document makes no element or fragment
  // during a read that parsing the payload into a template does not make on
  // its own. (A `cloneNode` copy stays in its source's document -- the
  // template's, or the read's own once a copy has been adopted into it --
  // inert either way in a browser.)
  // Counted: the live document's own methods that make or take in a node,
  // the realm's constructors that make one owned by it (and `Range`, whose
  // fragments are), and copies of a connected node (`document.body`), which
  // no read makes. So the usual other spellings of the bug fail here too
  // (`createElementNS`, `importNode`, `new DocumentFragment()`). The list is
  // not exhaustive -- a method borrowed from `Document.prototype`, or a copy
  // of the unconnected parse template, goes uncounted -- and the e2e (C7b,
  // D1b), which watches for the handler itself, is the backstop.
  const CONSTRUCTORS = ['DocumentFragment', 'Text', 'Comment', 'Range', 'Image', 'Audio', 'Option'];
  const madeBy = (read: () => void): unknown[] => {
    const element = vi.spyOn(document, 'createElement');
    const fragment = vi.spyOn(document, 'createDocumentFragment');
    const others = (
      [
        'createElementNS',
        'createTextNode',
        'createComment',
        'importNode',
        'adoptNode',
        'createRange',
      ] as const
    ).map((name) => vi.spyOn(document, name));
    const clone = vi.spyOn(Node.prototype, 'cloneNode');
    const constructed = new Map<string, number>();

    for (const name of CONSTRUCTORS) {
      const Real = (globalThis as unknown as Record<string, new (...args: unknown[]) => object>)[
        name
      ];

      // Only those this environment has.
      if (typeof Real !== 'function') {
        continue;
      }

      vi.stubGlobal(
        name,
        class extends Real {
          constructor(...args: unknown[]) {
            super(...args);
            constructed.set(name, (constructed.get(name) ?? 0) + 1);
          }
        },
      );
    }

    try {
      read();

      return [
        element.mock.calls.map(([tag]) => tag),
        fragment.mock.calls.length,
        [
          ...others.map((spy) => spy.mock.calls.length),
          [...constructed],
          (clone.mock.contexts as Node[])
            .filter((node) => node.isConnected)
            .map((node) => node.nodeName),
        ],
      ];
    } finally {
      element.mockRestore();
      fragment.mockRestore();
      clone.mockRestore();

      for (const spy of others) {
        spy.mockRestore();
      }

      vi.unstubAllGlobals();
    }
  };
  // The payload parsed into a template of an inert document, as the reader
  // parses it: the reader makes even its parse template in its inert
  // document (`readBlocksFromHtml`), so the live one makes not even that.
  const parsing = (html: string): unknown[] =>
    madeBy(() => {
      document.implementation.createHTMLDocument('').createElement('template').innerHTML = html;
    });

  test.each([
    '<p>safe<img src="x" onerror="window.__pwned=2">more</p>',
    '<b><p>x</p><img src="x" onerror="window.__pwned=2"></b>',
    '<a href="https://l.test/"><div style="display:flex"><span>a</span><img src="x" onerror="1"></div><p>z</p></a>',
    '<header>h<img src="x" onerror="1"></header>',
    '<span style="font-weight:bold"><div>x<img src="x" onerror="1"></div></span>',
    // The list readers build with the document passed down. In a browser a
    // list item read in place is owned by the inert template document anyway;
    // these two pin that the readers never reach for that, which in happy-dom
    // is the live document.
    '<ul><li>a</li><b><li>b<img src="x" onerror="1"></li></b></ul>',
    '<ul><li>a<p>b</p>c<img src="https://i.test/x.png" onerror="1"><p>d</p></li></ul>',
    // A list in a quote, loose content in a list, a list straight inside a
    // list, a bare item, a run that keeps its `white-space`, and the body of
    // a toggle: each passes the document down.
    '<ul>loose<img src="x" onerror="1">more<li>a</li></ul>',
    '<ul><li>a</li><ul><li>b</li><b><li>c<img src="x" onerror="1"></li></b></ul></ul>',
    '<li>a<p>b</p>c<img src="https://i.test/x.png" onerror="1"><p>d</p></li>',
    '<div style="white-space:pre-wrap">a  <img src="x" onerror="1">b</div>',
    '<details><summary>s</summary>t<img src="x" onerror="1">u</details>',
    '<blockquote><ul><li>a</li><b><li>b<img src="x" onerror="1"></li></b></ul></blockquote>',
    // An item read again after a display equation, a wrapper inside a list
    // holding loose content, a figure that is not one picture, and a
    // container's formatting pushed in, as a wrapper's and as its own style;
    // then a whole flex row's shell, a wrapper's `white-space` holder, a
    // loose item in a row, and the stand-in for a boxed item.
    '<ul><li><div data-neditor-math-block="x^2">x^2</div><p>t</p><figure><p>safe' +
      '<img src="https://i.test/x.png" onerror="1">more</p><figcaption>c</figcaption></figure></li></ul>',
    '<ul><b><li>a</li>loose<img src="x" onerror="1">more</b></ul>',
    '<figure><p>safe<img src="x" onerror="1">more</p><figcaption>c</figcaption></figure>',
    '<header><b><p>x</p><video src="x" onerror="1"></video></b></header>',
    '<header style="font-weight:bold"><p>x</p><video src="x" onerror="1"></video></header>',
    '<header style="display:flex;font-weight:bold"><span>a</span><img src="x" onerror="1"></header>',
    '<b style="white-space:pre-wrap"><p>x</p><img src="x" onerror="1"></b>',
    '<b><div style="display:flex">loose<img src="x" onerror="1"><span>s</span></div><p>z</p></b>',
    '<div style="display:flex"><span>a</span><svg></svg><img src="x" onerror="1"><span>b</span></div>',
    // Inside a wrapper pushed inward: a styled container, a block that seals
    // what it holds, and an inline wrapper, each handing the formatting on;
    // and a wrapper that turns a mark off, whose shell says so.
    '<b><p>x</p><header style="font-weight:bold">h<img src="x" onerror="1"><p>y</p></header></b>',
    '<b><p>x</p><pre><i>a<img src="x" onerror="1"><p>y</p></i></pre></b>',
    '<b><p>x</p><i>a<img src="x" onerror="1"><p>y</p></i></b>',
    '<i style="font-weight:normal"><p>x</p>a<img src="x" onerror="1"></i>',
    // An assistive copy of a formula in a run cut at its pictures: the copy
    // the run is read from keeps the assistive copy's place with a stand-in.
    '<p><span class="katex"><span class="katex-mathml"><math><mi>x</mi></math></span>' +
      '<span class="katex-html">x</span></span><img src="x" onerror="1">y</p>',
    // A formula's source is replaced by an element the reader makes.
    '<p>Let <span class="MathJax_MathML" id="MathJax-Element-1-Frame"><span class="MathJax_MathContainer">' +
      '<span><math><mi>x</mi></math></span></span></span>' +
      '<script type="math/tex" id="MathJax-Element-1">x</script> be.</p>',
  ])('%s', (html) => {
    expect(madeBy(() => blocksFromHtml(document, html))).toEqual(parsing(html));
  });

  // A summary a wrapper holds, and a wrapper pushed into the blocks it holds
  // around an assistive copy: each leaves a stand-in `<template>` made in the
  // document passed down. Fragments are left out here: the stand-in is
  // copied once it has been adopted into the paste's own document, the live
  // one in happy-dom, and happy-dom's copy of a `<template>` makes its content
  // fragment with its source's document.
  test.each([
    '<details><span><summary>S</summary></span><p>b</p></details>',
    '<b><p>x</p><span class="katex"><span class="katex-mathml"><math><mi>x</mi></math></span>' +
      '<span class="katex-html">x</span></span></b>',
  ])('the stand-ins it leaves: %s', (html) => {
    const [elements, , others] = madeBy(() => blocksFromHtml(document, html));
    const [parsed, , parsedOthers] = parsing(html);

    expect([elements, others]).toEqual([parsed, parsedOthers]);
  });

  test('parseRichTextFromHtml likewise: the formulas it replaces', () => {
    // Its other reading makes nothing at all; a formula's source is replaced
    // by an element the reader makes.
    const html =
      'Let <span class="MathJax_MathML" id="MathJax-Element-1-Frame"><span class="MathJax_MathContainer">' +
      '<span><math><mi>x</mi></math></span></span></span>' +
      '<script type="math/tex" id="MathJax-Element-1">x</script> be.';

    expect(madeBy(() => parseRichTextFromHtml(document, html))).toEqual(parsing(html));
  });
});
