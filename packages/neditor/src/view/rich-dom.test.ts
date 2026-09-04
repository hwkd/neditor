// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';

import type { Block } from '../model/document.ts';
import { blockText } from '../model/document.ts';
import type { RichText } from '../model/rich-text.ts';
import { richToPlainText } from '../model/rich-text.ts';
import {
  blocksFromHtml,
  blocksToHtml,
  parseRichText,
  parseRichTextFromHtml,
  renderRichText,
} from './rich-dom.ts';

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
    // A <summary> is never reached by visitBlocks: visitDetails strips it out
    // of the body clone and reads it whole. Unsealing it let the pop lift the
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
