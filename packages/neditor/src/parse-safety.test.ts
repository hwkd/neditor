// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest';

import { blocksFromMarkdown } from './input/markdown.ts';
import type { Block } from './model/document.ts';
import { toMarkdown } from './model/document.ts';
import { richToPlainText } from './model/rich-text.ts';
import { blocksFromHtml, parseRichTextFromHtml } from './view/rich-dom.ts';

/**
 * Foreign HTML is parsed without ever touching the live document.
 *
 * A pasted `<b><p>x</p><img src=/nope.png onerror=…></b>` ran its handler in
 * the page, in Chromium and WebKit both. The template it was parsed into is
 * inert, but distributing the `<b>` over the paragraph cloned its children
 * into a fragment made by the caller's document, and adopting the `<img>` into
 * a document with a browsing context is what starts its load -- and the load
 * failing is what fires `onerror`. `<span>t<video onerror=…>` took the other
 * route there, through the scratch `<div>` the inline buffer is read from.
 *
 * happy-dom loads nothing and runs no inline handlers, so the behaviour cannot
 * be observed here: these payloads parse identically with the defect in place.
 * What is pinned instead is the artifact that decides it in a browser -- the
 * live document's factories are never called during a parse, so nothing the
 * parse builds is owned by it, and nothing pasted can be adopted into it. A
 * node created by the live document is the only way one of its nodes could
 * enter the parse, because the parse starts from a string.
 */
describe('parsing foreign HTML never creates a node in the live document', () => {
  const FACTORIES = [
    'createElement',
    'createElementNS',
    'createDocumentFragment',
    'createTextNode',
    'importNode',
    'adoptNode',
  ] as const;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Every call the live document's factories receive while `work` runs, other
   * than the ones the HTML parser itself makes while filling a template.
   *
   * That exception is happy-dom's, not the code's: it builds a template's
   * content with the window's document whichever document made the template,
   * where a browser builds it in the template's own inert contents document.
   * (It equally reports `ownerDocument` wrongly for a node made by a
   * `createHTMLDocument` document, which is why ownership is not asserted
   * directly.) The parser's calls are the one thing in a parse this file does
   * not author, so they are set aside and everything the parse itself builds
   * is held to the rule.
   */
  function liveCalls(work: () => void): string[] {
    const calls: string[] = [];
    let parsing = 0;
    const setter = Object.getOwnPropertyDescriptor(HTMLTemplateElement.prototype, 'innerHTML')!;

    vi.spyOn(HTMLTemplateElement.prototype, 'innerHTML', 'set').mockImplementation(function (
      this: HTMLTemplateElement,
      html: string,
    ) {
      parsing += 1;

      try {
        setter.set!.call(this, html);
      } finally {
        parsing -= 1;
      }
    });

    for (const name of FACTORIES) {
      const original = document[name].bind(document) as (...args: unknown[]) => unknown;

      vi.spyOn(document, name).mockImplementation(((...args: unknown[]) => {
        if (parsing === 0) {
          calls.push(`${name}(${typeof args[0] === 'string' ? args[0] : 'node'})`);
        }

        return original(...args);
      }) as never);
    }

    work();

    return calls;
  }

  // The two payloads the lead reproduced in real browsers, and one for each
  // route by which a parse builds scratch nodes: the formatting pushed inward
  // over a block, the inline buffer read as a paragraph, the image wrapper,
  // and a toggle and a table cell, which clone the source.
  const PAYLOADS: ReadonlyArray<readonly [string, string, string]> = [
    [
      'a wrapper distributed over a block',
      '<b><p>x</p><img src="/nope.png" onerror="window.__pwned = 1"></b>',
      'x',
    ],
    [
      'an inline buffer read as a paragraph',
      '<span>t<video src="/nope.mp4" onerror="window.__pwned = 1"></video></span>',
      't',
    ],
    [
      'an image inside a link',
      '<a href="https://e.test/"><img src="https://e.test/a.png" alt="a"></a><i>tail</i>',
      'tail',
    ],
    [
      'a toggle with a wrapped summary',
      '<details><span><summary>s</summary></span><p>body</p></details>',
      'body',
    ],
    ['a table cell', '<table><tr><td>c<table><tr><td>n</td></tr></table></td></tr></table>', 'c'],
  ];

  test.each(PAYLOADS)('blocksFromHtml: %s', (_name, html, text) => {
    let blocks: ReturnType<typeof blocksFromHtml> = [];
    const calls = liveCalls(() => {
      blocks = blocksFromHtml(document, html);
    });

    // The parse still has to have done its job, or an implementation that
    // returned nothing would pass by building nothing.
    expect(JSON.stringify(blocks)).toContain(`"text":"${text}"`);
    expect(calls).toEqual([]);
  });

  test('parseRichTextFromHtml', () => {
    let text = '';
    const calls = liveCalls(() => {
      text = richToPlainText(
        parseRichTextFromHtml(
          document,
          '<b>a<img src="/nope.png" onerror="window.__pwned = 1"></b><video src="/n.mp4"></video>',
        ),
      );
    });

    expect(text).toBe('a');
    expect(calls).toEqual([]);
  });
});

/**
 * Best of three, so one slow run on a loaded machine does not decide it.
 */
const bestOf = (work: () => void): number => {
  let best = Infinity;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const began = performance.now();
    work();
    best = Math.min(best, performance.now() - began);
  }

  return best;
};

/**
 * How much longer sixteen times the input takes: about 16x for linear work,
 * about 256x for quadratic.
 *
 * A ratio between two sizes rather than a budget, because a budget is a
 * statement about the machine. The line is drawn wide between the two, since
 * allocation makes honest linear work come out at 30x or so at these sizes,
 * and a loaded machine only ever makes the ratio worse -- so the lowest of a
 * few measurements is the honest one, and quadratic work is over the line
 * every time.
 */
const LINEAR = 90;
const growth = (work: (size: number) => void, size: number): number => {
  let least = Infinity;

  for (let attempt = 0; attempt < 3 && least >= LINEAR; attempt += 1) {
    work(size);
    const small = bestOf(() => work(size));
    const large = bestOf(() => work(size * 16));
    least = Math.min(least, large / Math.max(small, 0.5));
  }

  return least;
};

const paragraph = (text: string): Block => ({
  id: 'p',
  type: 'paragraph',
  depth: 0,
  content: [{ text }],
});

describe('a bracketed label does not backtrack exponentially', () => {
  /**
   * `(?:\\.|[^\]\n])*` can spend a backslash either as the start of an escape
   * or as an ordinary character, so a label that never closes is retried both
   * ways at every backslash: `![` and thirty `a\` pairs took two seconds, and
   * the time doubled every two characters more. Pasting one line froze the
   * tab. That is exponential, not quadratic, so a growth ratio between two
   * sizes would not finish on the defect; the sizes here are the largest the
   * unfixed pattern still gets through in seconds, and the budget is three
   * orders of magnitude over what the fixed one needs.
   */
  test.each([
    ['an image line', (pairs: number) => `![${'a\\'.repeat(pairs)}`],
    ['a callout marker', (pairs: number) => `> [!${'a\\'.repeat(pairs)}`],
    ['an image line ending in a bracket', (pairs: number) => `![${'a\\'.repeat(pairs)}](`],
  ])('%s', (_name, line) => {
    // One run: unfixed, each of these takes seconds on its own.
    const began = performance.now();
    blocksFromMarkdown(line(30));
    const took = performance.now() - began;

    expect(took).toBeLessThan(250);
  });

  test('an escaped bracket in a label is still read as one', () => {
    const image = blocksFromMarkdown('![a\\]b\\\\](https://a.test/x.png)')[0];

    expect(image).toMatchObject({ type: 'image', alt: 'a]b\\', src: 'https://a.test/x.png' });

    const callout = blocksFromMarkdown('> [!x\\]y] note')[0];

    expect(callout).toMatchObject({ type: 'callout', icon: 'x]y' });
  });
});

describe('long runs at the end of a line are scanned once', () => {
  /**
   * A pattern ending in `$` with no left anchor is retried from every
   * character of a run that turns out not to reach the end, so a long run of
   * whitespace or backslashes in the middle of a line costs its length squared:
   * 80,000 spaces took 4.6 seconds in `toMarkdown`, 40,000 backslashes 1.3
   * seconds in `blocksFromMarkdown`.
   */
  test('the writer: whitespace inside a formatted run', () => {
    expect(
      growth((size) => {
        toMarkdown({
          blocks: [
            { ...paragraph(''), content: [{ text: `x${' '.repeat(size)}x`, marks: ['bold'] }] },
          ],
        });
      }, 2500),
    ).toBeLessThan(LINEAR);
  });

  test('the writer: whitespace inside a plain run', () => {
    expect(
      growth((size) => {
        toMarkdown({ blocks: [paragraph(`x${' '.repeat(size)}x`)] });
      }, 2500),
    ).toBeLessThan(LINEAR);
  });

  test('the reader: backslashes inside a line', () => {
    expect(
      growth((size) => {
        blocksFromMarkdown(`${'\\'.repeat(size)}a\nb`);
      }, 2500),
    ).toBeLessThan(LINEAR);
  });

  test('the trailing runs are still what they were', () => {
    // An odd count is a soft break, an even one is escaped backslashes.
    expect(blocksFromMarkdown('a\\\\\\\nb').map((block) => block.content)).toEqual([
      [{ text: 'a\\\nb' }],
    ]);
    expect(blocksFromMarkdown('a\\\\\nb').map((block) => block.content)).toEqual([
      [{ text: 'a\\' }],
      [{ text: 'b' }],
    ]);
    // The run's trailing spaces are hoisted outside its delimiters. Followed by
    // more text, since spaces that end the whole block are not written at all.
    expect(
      toMarkdown({
        blocks: [{ ...paragraph(''), content: [{ text: 'a  ', marks: ['bold'] }, { text: 'b' }] }],
      }),
    ).toBe('**a**  b');
  });
});

describe('empty block children inside a list item are read once each', () => {
  /**
   * Each block element asked whether real content followed it by walking
   * forward through everything after it, so N empty `<div>`s before the text
   * of a list item cost N squared: 8,000 of them took 7.7 seconds.
   */
  test.each([
    ['a list item', (n: number) => `<ul><li>${'<div></div>'.repeat(n)}x</li></ul>`],
    ['a table cell', (n: number) => `<table><tr><td>${'<div></div>'.repeat(n)}x</td></tr></table>`],
  ])('%s', (_name, html) => {
    expect(
      growth((size) => {
        blocksFromHtml(document, html(size));
      }, 150),
    ).toBeLessThan(LINEAR);
  });

  // What "content follows" meant before the scan was replaced, pinned case by
  // case: a `<br>` or a non-blank text node later in the same root, outside
  // anything skipped. These are the answers the forward walk gave.
  test.each([
    ['<ul><li><div>a</div><div></div>b</li></ul>', 'a\nb'],
    ['<ul><li>a<div>b</div><div></div></li></ul>', 'a\nb\n'],
    ['<ul><li>a<br><div></div></li></ul>', 'a\n'],
    ['<ul><li>a<br><span>b</span></li></ul>', 'a\nb'],
    ['<ul><li>a<br><ul><li>c</li></ul></li></ul>', 'a|c'],
    ['<ul><li><div>a</div><script>x</script></li></ul>', 'a'],
    ['<p>a<br></p>', 'a'],
    ['<p>a<br><br></p>', 'a\n'],
    ['<p><b>a<br></b><i></i></p>', 'a'],
  ])('%s still reads as %j', (html, expected) => {
    const text = blocksFromHtml(document, html)
      .map((block) => richToPlainText(block.content))
      .join('|');

    expect(text).toBe(expected);
  });
});
