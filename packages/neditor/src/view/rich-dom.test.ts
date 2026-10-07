// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';

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
   * is wrong text with no visible cause. Those shapes take a copy instead,
   * where removing it works at any depth.
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

  test('the ordinary shape is unchanged and takes no copy', () => {
    expect(read('<details open><summary>Title</summary><p>Body</p></details>')).toEqual([
      ['toggle', 'Title'],
      ['paragraph', 'Body'],
    ]);
  });

  test('and so is a summary inside a plain container', () => {
    expect(read('<details open><div><summary>Title</summary><p>Body</p></div></details>')).toEqual([
      ['toggle', 'Title'],
      ['paragraph', 'Body'],
    ]);
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
      { type: 'numbered_list', depth: 0, text: ' Step one' },
      { type: 'image', depth: 1, text: '' },
      { type: 'numbered_list', depth: 0, text: ' Step two' },
      { type: 'image', depth: 1, text: '' },
    ]);
  });

  // An image the reader cannot use is no block, so it splits nothing.
  test('an unusable image inside the text splits nothing', () => {
    expect(shape('<ul><li>Click <img src="cid:x"> to open</li></ul>')).toEqual([
      { type: 'bulleted_list', depth: 0, text: 'Click  to open' },
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
    ['<ul><li>Click <img src="https://a.test/i.png"> to open</li></ul>', 'Click  to open'],
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
    [
      '<ul><li>a <a href="https://l.test/"><img src="https://i.test/x.png"></a> b</li></ul>',
      'a  b',
    ],
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
        { type: 'numbered_list', depth: 0, text: 'Click the  icon.' },
        { type: 'image', depth: 1, text: '', src: 'https://a.test/g.png' },
        { type: 'image', depth: 1, text: '', src: 'https://a.test/a.png' },
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
        { type: 'bulleted_list', depth: 0, text: 'Click  here' },
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
  test('an empty block after text adds no line break', () => {
    const [table] = blocksFromHtml(
      document,
      '<table><tr><td>t <div><span></span></div></td></tr></table>',
    );
    expect(richToPlainText(table?.rows?.[0]?.[0] ?? [])).toBe('t ');
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
  // a line there: the text is no edge.
  test.each([
    ['<p></p><hr> text more<p>q</p>', ['', '', 'text more', 'q']],
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

  // Space-only runs are looked past only while whitespace is collapsed; a
  // paragraph reads its whitespace as it stands.
  test('a paragraph keeps a space between a break and a block', () => {
    expect(text('<p>a<br> <center>b</center></p>')).toEqual(['a\n \nb']);
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
      ['quote: Note: careful', '[img n.png]'],
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
    ).toEqual(['bulleted_list@0:Cap ', '[img flag.png]@1:']);
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
