// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { Block, NEditor, RichText } from './index.ts';
import {
  MATH_ATOM,
  blocksFromHtml,
  blocksFromMarkdown,
  blocksToHtml,
  createEditor,
  matchInlineRule,
  normalizeDocument,
  normalizeRuns,
  parseInlineMarkdown,
  parseRichText,
  renderRichText,
  richActiveMarks,
  richDelete,
  richSetLink,
  richSetMark,
  richSlice,
  richToSourceText,
  toMarkdown,
} from './index.ts';
import { pastedDepths, shallowest } from './editor.ts';
import { contentForType, setBlockType } from './model/document.ts';
import { NEDITOR_STYLES } from './styles.ts';
import { getSelectionRange, isCaretAtEnd, setSelectionRange } from './view/selection.ts';
import { LINEAR, growth, growthOf } from './test-timing.ts';

/**
 * Math: inline formulas as atoms in the runs, display equations as blocks of
 * TeX. The round trips themselves are in `round-trip.test.ts`; this is the
 * behaviour around them -- what the model keeps, what each reader recognises,
 * and what the editor does with real events.
 */

const m = (tex: string) => ({ text: MATH_ATOM, math: tex });
const blocksText = (b: Block) => b.content.map((run) => run.text).join('');

function block(over: Partial<Block>): Block {
  return {
    id: Math.random().toString(36).slice(2),
    type: 'paragraph',
    depth: 0,
    content: [],
    ...over,
  } as Block;
}

const editors: NEditor[] = [];

afterEach(() => {
  while (editors.length > 0) {
    editors.pop()?.destroy();
  }

  document.body.replaceChildren();
});

function mount(blocks: Block[], options: Record<string, unknown> = {}): NEditor {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = createEditor({ element: host, doc: { blocks }, ...options });
  editors.push(editor);
  return editor;
}

const hostOf = (editor: NEditor, index = 0): HTMLElement =>
  editor.element.querySelectorAll<HTMLElement>('.neditor-block__content')[index]!;

/** What a browser leaves behind after typing: the text, the caret at its end, an input event. */
function typeInto(host: HTMLElement, text: string, inputType = 'insertText'): void {
  host.focus();
  host.textContent = text;
  setSelectionRange(host, text.length, text.length);
  host.dispatchEvent(new InputEvent('input', { inputType, data: text.at(-1), bubbles: true }));
}

/** A renderer that draws a lot of text, so that offsets counting it would be visibly wrong. */
const loud = (tex: string, { displayMode }: { displayMode: boolean }) =>
  `<span class="drawn" data-display="${displayMode}">${'#'.repeat(20)}${tex}</span>`;

describe('the model: a formula is one atom carrying its TeX', () => {
  test('two formulas side by side never merge, even identical ones', () => {
    expect(normalizeRuns([m('\\alpha'), m('b'), m('b')])).toEqual([m('\\alpha'), m('b'), m('b')]);
  });

  test('stored shapes are coerced: the atom is one character, empty TeX is nothing', () => {
    expect(
      normalizeRuns([
        { text: 'whatever was stored', math: 'x', marks: ['bold'], link: 'https://a.test/' },
        { text: '', math: '   ' },
        { text: 'plain', math: 42 as unknown as string },
      ]),
    ).toEqual([m('x'), { text: 'plain' }]);
  });

  test('inline TeX is one line with no edge whitespace', () => {
    expect(normalizeRuns([{ text: MATH_ATOM, math: '  a +\r\nb \n' }])).toEqual([m('a + b')]);
  });

  test('no slice, delete or mark lands inside a formula', () => {
    const content: RichText = [{ text: 'ab' }, m('x^2'), { text: 'cd' }];

    expect(richSlice(content, 2, 3)).toEqual([m('x^2')]);
    expect(richDelete(content, 1, 3)).toEqual([{ text: 'acd' }]);

    const bold = richSetMark(content, 0, 5, 'bold', true);
    expect(bold).toEqual([
      { text: 'ab', marks: ['bold'] },
      m('x^2'),
      { text: 'cd', marks: ['bold'] },
    ]);
    // The formula has no marks of its own, so it does not make the range read
    // as unformatted -- toggling twice would otherwise bold it both times.
    expect(richActiveMarks(bold, 0, 5)).toEqual(['bold']);
    expect(richSetLink(content, 0, 5, 'https://a.test/')[1]).toEqual(m('x^2'));
  });

  test('a literal block takes a formula as its TeX: between dollars in code, bare in an equation', () => {
    const content: RichText = [{ text: 'f ', marks: ['bold'] }, m('x')];

    expect(contentForType('code', content)).toEqual([{ text: 'f $x$' }]);
    expect(contentForType('math', content)).toEqual([{ text: 'f x' }]);

    const blocks = [block({ id: 'a', content })];
    expect(setBlockType(blocks, 'a', 'math')[0]?.content).toEqual([{ text: 'f x' }]);
    expect(
      normalizeDocument({ blocks: [block({ type: 'math', content })] }).blocks[0]?.content,
    ).toEqual([{ text: 'f x' }]);
  });

  test('an equation keeps formulas apart from their neighbours: a space ends a control word', () => {
    expect(contentForType('math', [m('\\alpha'), m('b'), { text: 'c' }])).toEqual([
      { text: '\\alpha b c' },
    ]);
    expect(contentForType('math', [{ text: 'f ' }, m('x'), { text: ' g' }])).toEqual([
      { text: 'f x g' },
    ]);
  });

  test('the atom character is no part of any TeX', () => {
    expect(normalizeRuns([{ text: MATH_ATOM, math: `a${MATH_ATOM}b` }])).toEqual([m('ab')]);
  });

  test('a stored formula with no TeX is nothing, whatever text it carried', () => {
    expect(
      normalizeDocument({
        blocks: [block({ content: [{ text: 'abc', math: '' }, { text: 'kept' }] as RichText })],
      }).blocks[0]?.content,
    ).toEqual([{ text: 'kept' }]);
  });

  test('read as text for good, a formula is its $TeX$', () => {
    expect(richToSourceText([{ text: 'a ' }, m('x')])).toBe('a $x$');
  });
});

describe('the inline rule', () => {
  test('a closing $ makes a formula of the span, delimiters and all', () => {
    expect(matchInlineRule('Let $x^2$')).toMatchObject({ start: 4, end: 9, math: 'x^2' });
    expect(matchInlineRule('$a\\$b$')).toMatchObject({ start: 0, math: 'a\\$b' });
    expect(matchInlineRule('$a \\\\$')).toMatchObject({ math: 'a \\\\' });
  });

  test.each([
    ['an opener against a space', 'costs $ 5$'],
    ['a closer against a space', 'from $5 to $'],
    ['a doubled dollar', '$$x$'],
    ['an escaped closer', '$x\\$'],
    ['a line break inside', '$a\nb$'],
    ['an open code span', 'run `echo $HOME$'],
    ['a link destination', '[a](https://a.test/?p=$x$'],
    ['an autolink', '<https://a.test/$x$'],
    ['a formula inside a formula', `$a ${MATH_ATOM} b$`],
    ['prose with prices', 'costs $5 and $6'],
  ])('refuses %s', (_name, text) => {
    expect(matchInlineRule(text)).toBeNull();
  });
});

describe('the Markdown reader', () => {
  test("a formula's TeX is its source, escapes and all", () => {
    expect(parseInlineMarkdown('See $a\\_b + \\|x\\|$ and \\$5.')).toEqual([
      { text: 'See ' },
      m('a\\_b + \\|x\\|'),
      { text: ' and $5.' },
    ]);
  });

  test('a rule that fires inside a formula does not cost it its characters', () => {
    expect(parseInlineMarkdown('$a*b*c$')).toEqual([m('a*b*c')]);
  });

  test('a $$ fence takes its lines verbatim, under a list item too', () => {
    const blocks = blocksFromMarkdown('- item\n  $$\n  | a | b \\\\\n  c\n  $$\n\nafter');

    expect(blocks.map((b) => [b.type, b.depth, b.content])).toEqual([
      ['bulleted_list', 0, [{ text: 'item' }]],
      ['math', 1, [{ text: '| a | b \\\\\nc' }]],
      ['paragraph', 0, [{ text: 'after' }]],
    ]);
  });

  test('a one-line $$…$$ is an equation, and an unclosed fence still yields one', () => {
    expect(blocksFromMarkdown('$$ x^2 $$').map((b) => [b.type, b.content])).toEqual([
      ['math', [{ text: 'x^2' }]],
    ]);
    expect(blocksFromMarkdown('$$\nx').map((b) => [b.type, b.content])).toEqual([
      ['math', [{ text: 'x' }]],
    ]);
  });

  test.each([
    ['a price range', 'Prices run $5-$10 per seat.'],
    ['currencies with letters', 'US$10 to US$20, or A$5 or A$10'],
    ['a range with a dash', 'HK$100–HK$200'],
    ['a slash', 'Rent is $1,200/$1,500.'],
  ])('a closing $ before a digit is no closer: %s stays prose', (_name, text) => {
    expect(parseInlineMarkdown(text)).toEqual([{ text }]);
  });

  test('a digit after a formula is written as a reference and read back', () => {
    const content = [m('x'), { text: '2 apples' }];
    const markdown = toMarkdown({ blocks: [block({ content })] });

    expect(markdown).toBe('$x$&#50; apples');
    expect(blocksFromMarkdown(markdown)[0]?.content).toEqual(content);
  });

  test('a $ in a code span is written bare, and never opens a formula', () => {
    const content = [{ text: 'echo $HOME', marks: ['code'] as const }, { text: '/' }, m('x')];
    const markdown = toMarkdown({ blocks: [block({ content: content as RichText })] });

    expect(markdown).toBe('`echo $HOME`/$x$');
    expect(blocksFromMarkdown(markdown)[0]?.content).toEqual(content);
  });

  test('two one-line display spans in a paragraph are not one equation', () => {
    expect(blocksFromMarkdown('$$a$$ and $$b$$').map((b) => b.type)).toEqual(['paragraph']);
  });

  test('a $$ line inside a code fence is code', () => {
    expect(blocksFromMarkdown('```\n$$\nx\n$$\n```').map((b) => b.type)).toEqual(['code']);
  });

  test('the writer spells both kinds the way the reader takes them', () => {
    const markdown = toMarkdown({
      blocks: [
        block({ content: [{ text: 'cost $5, ' }, m('x_1')] }),
        block({ type: 'math', content: [{ text: 'a\nb' }], depth: 0 }),
      ],
    });

    expect(markdown).toBe('cost \\$5, $x_1$\n\n$$\na\nb\n$$');
  });
});

describe('math in HTML', () => {
  // KaTeX's own output for `\frac{1}{2}`, trimmed to its structure.
  const katexInline = (tex: string, annotated = true) =>
    `<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mn>1</mn></mrow>${
      annotated ? `<annotation encoding="application/x-tex">${tex}</annotation>` : ''
    }</semantics></math></span><span class="katex-html" aria-hidden="true"><span class="mord">½</span></span></span>`;

  test('KaTeX pasted from a page arrives as its TeX', () => {
    const blocks = blocksFromHtml(
      document,
      `<p>Half is ${katexInline('\\frac{1}{2}')}.</p><p><span class="katex-display">${katexInline('\\sum i')}</span></p>`,
    );

    expect(blocks.map((b) => [b.type, b.content])).toEqual([
      ['paragraph', [{ text: 'Half is ' }, m('\\frac{1}{2}'), { text: '.' }]],
      ['math', [{ text: '\\sum i' }]],
    ]);
  });

  // On a line of its own, as it is drawn -- the breaks an ordinary block in
  // the same place makes (`<li>so <div>x</div> holds</li>` reads
  // `so\nx\nholds`: the spaces beside a line break are not drawn, and the
  // reader collapses whitespace as a browser draws it).
  test('a display equation inside a sentence is read as a formula on its own line', () => {
    const blocks = blocksFromHtml(
      document,
      `<p>so <span class="katex-display">${katexInline('y')}</span> holds</p>`,
    );

    expect(blocks.map((b) => [b.type, b.content])).toEqual([
      ['paragraph', [{ text: 'so\n' }, m('y'), { text: '\nholds' }]],
    ]);
  });

  test('a display wrapper in a table cell keeps the line breaks of the block it was', () => {
    const [table] = blocksFromHtml(
      document,
      `<table><tr><td>a<div class="math"><span class="katex-display">${katexInline('k')}</span></div>b</td></tr></table>`,
    );

    expect(table?.rows?.[0]?.[0]).toEqual([{ text: 'a\n' }, m('k'), { text: '\nb' }]);
  });

  // Text beside it in the item's line keeps it in the item's text, in order,
  // as in a paragraph: handed on as a nested block it moved after "where k".
  test('a display wrapper inside a list item, with text beside it, is a formula on its own line', () => {
    const blocks = blocksFromHtml(
      document,
      `<ul><li>Consider<div class="math"><span class="katex-display">${katexInline('k')}</span></div>where k</li></ul>`,
    );

    expect(blocks.map((b) => [b.type, b.depth, b.content])).toEqual([
      ['bulleted_list', 0, [{ text: 'Consider\n' }, m('k'), { text: '\nwhere k' }]],
    ]);
  });

  test('a display equation in the middle of a sentence in a list item keeps its place', () => {
    const blocks = blocksFromHtml(
      document,
      `<ol><li>Step one: compute <span class="katex-display">${katexInline('a+b')}</span> and then add one.</li></ol>`,
    );

    expect(blocks.map((b) => [b.type, b.depth, b.content])).toEqual([
      [
        'numbered_list',
        0,
        [{ text: 'Step one: compute\n' }, m('a+b'), { text: '\nand then add one.' }],
      ],
    ]);
  });

  test('a display equation that stands alone in a list item is a block nested under it', () => {
    const blocks = blocksFromHtml(
      document,
      `<ul><li><p>Solve</p><div class="math"><span class="katex-display">${katexInline('k')}</span></div></li></ul>`,
    );

    expect(blocks.map((b) => [b.type, b.depth, b.content])).toEqual([
      ['bulleted_list', 0, [{ text: 'Solve' }]],
      ['math', 1, [{ text: 'k' }]],
    ]);
    // MathJax's TeX script after it is no text beside it.
    expect(
      blocksFromHtml(
        document,
        '<ul><li><p>Solve</p><div class="MathJax_Display"><span class="MathJax">x</span></div>' +
          '<script type="math/tex; mode=display">x=1</script></li></ul>',
      ).map((b) => [b.type, b.depth, b.content]),
    ).toEqual([
      ['bulleted_list', 0, [{ text: 'Solve' }]],
      ['math', 1, [{ text: 'x=1' }]],
    ]);
  });

  test('a display equation that is a paragraph of a list item is a block nested under it', () => {
    const blocks = blocksFromHtml(
      document,
      `<ul><li><p>Solve</p><p><span class="katex-display">${katexInline('x=1')}</span></p></li></ul>`,
    );

    expect(blocks.map((b) => [b.type, b.depth, b.content])).toEqual([
      ['bulleted_list', 0, [{ text: 'Solve' }]],
      ['math', 1, [{ text: 'x=1' }]],
    ]);
  });

  test("MathJax 2's TeX script is read, and its drawing and assistive copy are not", () => {
    const frame = (tex: string, display: boolean) =>
      `<span class="MathJax_Preview"></span><span class="mjx-chtml MathJax_CHTML"><span class="mjx-math">x2</span>` +
      `<span class="MJX_Assistive_MathML"><math><mi>x</mi></math></span></span>` +
      `<script type="math/tex${display ? '; mode=display' : ''}">${tex}</script>`;

    expect(
      blocksFromHtml(document, `<p>Let ${frame('x^2', false)} be.</p>`).map((b) => b.content),
    ).toEqual([[{ text: 'Let ' }, m('x^2'), { text: ' be.' }]]);
    // CommonHTML draws a displayed one as its frame inside an `MJXc-display`
    // span, and the script follows that wrapper, not the frame (MathJax
    // 2.7's `CommonHTML/jax.js`, `preTranslate`).
    expect(
      blocksFromHtml(
        document,
        '<span class="MathJax_Preview"></span><span class="mjx-chtml MJXc-display">' +
          '<span class="mjx-chtml MathJax_CHTML" id="MathJax-Element-1-Frame"><span class="mjx-math">y</span>' +
          '<span class="MJX_Assistive_MathML MJX_Assistive_MathML_Block"><math display="block"><mi>y</mi></math></span>' +
          '</span></span><script type="math/tex; mode=display">y</script>',
      ).map((b) => [b.type, b.content]),
    ).toEqual([['math', [{ text: 'y' }]]]);
    // HTML-CSS wraps its `MathJax` frame in a `MathJax_Display` div.
    expect(
      blocksFromHtml(
        document,
        '<div class="MathJax_Display"><span class="MathJax" id="MathJax-Element-2-Frame"><span>z</span></span></div>' +
          '<script type="math/tex; mode=display">z</script>',
      ).map((b) => [b.type, b.content]),
    ).toEqual([['math', [{ text: 'z' }]]]);
    // With no script but an annotated assistive copy, that copy names the TeX.
    expect(
      blocksFromHtml(
        document,
        '<p>a <span class="MathJax_CHTML"><span>x2</span><span class="MJX_Assistive_MathML"><math><semantics>' +
          '<mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span></span> b</p>',
      )[0]?.content,
    ).toEqual([{ text: 'a ' }, m('x^2'), { text: ' b' }]);
    // With no script to name its TeX, the drawing is read once, not twice.
    expect(
      blocksFromHtml(
        document,
        '<p><span class="MathJax_CHTML"><span>x2</span><span class="MJX_Assistive_MathML"><math><mi>x</mi></math></span></span></p>',
      )[0]?.content,
    ).toEqual([{ text: 'x2' }]);
  });

  test("MathML's alttext and MediaWiki's markup are read, and the fallback image is not a block", () => {
    const blocks = blocksFromHtml(
      document,
      '<p>a <math alttext="x^2"><msup><mi>x</mi><mn>2</mn></msup></math> b ' +
        '<span class="mwe-math-element"><span class="mwe-math-mathml-inline" style="display:none">' +
        '<math alttext="{\\displaystyle y}"><mi>y</mi></math></span>' +
        '<img src="https://a.test/y.svg" alt="{\\displaystyle y}"></span></p>',
    );

    expect(blocks.map((b) => [b.type, b.content])).toEqual([
      ['paragraph', [{ text: 'a ' }, m('x^2'), { text: ' b ' }, m('{\\displaystyle y}')]],
    ]);
  });

  test('KaTeX that has lost its TeX reads as what it drew, once', () => {
    expect(
      blocksFromHtml(document, `<p>Half is ${katexInline('', false)}</p>`)[0]?.content,
    ).toEqual([{ text: 'Half is ½' }]);
  });

  test('what draws a formula in the editor is never read back: only the TeX it carries', () => {
    const host = document.createElement('div');
    host.innerHTML =
      'a<span data-neditor-math="x" contenteditable="false"><b>junk</b><img src="https://a.test/i.png"></span>b';

    expect(parseRichText(host)).toEqual([{ text: 'a' }, m('x'), { text: 'b' }]);
  });

  test('TeX that looks like markup stays TeX, and is shown as text without a renderer', () => {
    const tex = '<img src=x onerror=alert(1)>';
    const blocks = blocksFromHtml(
      document,
      `<p><span data-neditor-math="${tex.replaceAll('<', '&lt;')}">x</span></p>`,
    );
    expect(blocks[0]?.content).toEqual([m(tex)]);

    const host = document.createElement('div');
    host.append(renderRichText(document, blocks[0]!.content, { editing: true }));
    // The one image is the caret separator after a trailing formula, which is ours.
    expect(host.querySelector('img:not(.neditor-math__separator)')).toBeNull();
    expect(host.querySelector('.neditor-math__source')?.textContent).toBe(tex);
  });

  // What one read learnt about an element is not true of the next: the DOM a
  // host passes `parseRichText` is live, and markup naming the TeX can arrive.
  test('a live formula that names its TeX later is read by it', () => {
    const host = document.createElement('div');
    host.innerHTML = 'a <span class="katex"><span>g</span></span> b';
    expect(parseRichText(host)).toEqual([{ text: 'a g b' }]);

    host
      .querySelector('.katex')!
      .insertAdjacentHTML(
        'afterbegin',
        '<math><semantics><mi>g</mi><annotation encoding="application/x-tex">g</annotation></semantics></math>',
      );
    expect(parseRichText(host)).toEqual([{ text: 'a ' }, m('g'), { text: ' b' }]);
  });

  // Scoped to one read, the verdict that a subtree names no TeX must still be
  // passed down within it, or each level searches everything below it again.
  // MathJax frames are asked too now, for an assistive copy's annotation.
  test('formulas nested in themselves with no TeX to find read in linear time', () => {
    const live = (html: string): void => {
      const host = document.createElement('div');
      host.innerHTML = html;
      parseRichText(host);
    };

    for (const open of ['<span class="MathJax">', '<span class="katex">']) {
      expect(
        growth((size) => blocksFromHtml(document, `<p>${open.repeat(size)}x</p>`), 200),
      ).toBeLessThan(LINEAR);
      expect(growth((size) => live(`${open.repeat(size)}x`), 200)).toBeLessThan(LINEAR);
    }
  }, 60_000);

  // Deep, with no math in it: read without a throw. Only so deep: happy-dom
  // builds a tree recursively, parsed or appended, and a cold engine
  // overflowed its stack on 5,000 levels before the reader ran at all -- this
  // environment cannot hold a tree deep enough to tell a walking reader from
  // a recursive one. What the math reader costs on deep input is pinned by
  // the growth test above.
  test('HTML with no math, nested deep, reads without throwing', () => {
    expect(() => blocksFromHtml(document, `${'<b>'.repeat(1000)}x`)).not.toThrow();
  });
});

describe('carets count a formula as one character', () => {
  test('across a drawing many characters long', () => {
    const host = document.createElement('div');
    host.contentEditable = 'true';
    document.body.append(host);
    host.append(
      renderRichText(document, [{ text: 'ab' }, m('x'), { text: 'cd' }], {
        editing: true,
        renderMath: loud,
      }),
    );
    host.focus();

    setSelectionRange(host, 3, 4);
    expect(getSelectionRange(host)).toEqual({ start: 3, end: 4 });

    setSelectionRange(host, 2, 3);
    expect(getSelectionRange(host)).toEqual({ start: 2, end: 3 });

    setSelectionRange(host, 5, 5);
    expect(isCaretAtEnd(host)).toBe(true);
  });

  test('a formula that draws nothing still counts as one character', () => {
    const host = document.createElement('div');
    host.contentEditable = 'true';
    document.body.append(host);
    host.append(
      renderRichText(document, [{ text: 'ab' }, m('x'), { text: 'c' }, m('y')], {
        editing: true,
        renderMath: () => document.createElement('span'),
      }),
    );
    host.focus();

    for (const offset of [2, 3, 4, 5]) {
      setSelectionRange(host, offset, offset);
      expect(getSelectionRange(host)).toEqual({ start: offset, end: offset });
    }
  });

  test('reading the caret costs the length of the block, however many formulas it holds', () => {
    const host = document.createElement('div');
    host.contentEditable = 'true';
    document.body.append(host);
    host.focus();

    const reading = (size: number) => {
      host.replaceChildren(
        renderRichText(
          document,
          Array.from({ length: size }, () => [m('x'), { text: 'a ' }]).flat(),
          { editing: true, renderMath: loud },
        ),
      );
      setSelectionRange(host, size * 3, size * 3);

      return () => getSelectionRange(host);
    };

    // Sixteen times the formulas: about 16x if linear, 256x if quadratic.
    expect(growthOf(reading, 50)).toBeLessThan(LINEAR);
  }, 60_000);

  test('a position inside a formula snaps to its edges', () => {
    const host = document.createElement('div');
    host.contentEditable = 'true';
    document.body.append(host);
    host.append(
      renderRichText(document, [{ text: 'ab' }, m('x')], { editing: true, renderMath: loud }),
    );
    host.focus();

    const inside = host.querySelector('.drawn')!.firstChild!;
    const range = document.createRange();
    range.setStart(inside, 3);
    range.setEnd(inside, 5);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);

    expect(getSelectionRange(host)).toEqual({ start: 2, end: 3 });
  });
});

describe('the editor', () => {
  test('typing $…$ makes a formula and leaves the caret after it', () => {
    const editor = mount([block({ id: 'p' })], { renderMath: loud });
    const host = hostOf(editor);

    typeInto(host, 'Let $x$');

    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: 'Let ' }, m('x')]);
    expect(getSelectionRange(host)).toEqual({ start: 5, end: 5 });
    expect(host.querySelector('.drawn')?.getAttribute('data-display')).toBe('false');
  });

  test('a deletion that leaves $…$ behind converts nothing', () => {
    const editor = mount([block({ id: 'p', content: [{ text: '$x$y' }] })]);

    typeInto(hostOf(editor), '$x$', 'deleteContentForward');

    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: '$x$' }]);
  });

  test('$$ makes an equation, whose picture is drawn in display mode and follows the typing', () => {
    const renderMath = vi.fn<typeof loud>(loud);
    const editor = mount([block({ id: 'p' })], { renderMath });

    typeInto(hostOf(editor), '$$');
    expect(editor.getDocument().blocks[0]?.type).toBe('math');

    typeInto(hostOf(editor), 'a^2');
    const preview = editor.element.querySelector('.neditor-math-block__preview')!;
    expect(preview.querySelector('.drawn')?.textContent).toContain('a^2');
    expect(renderMath).toHaveBeenLastCalledWith('a^2', { displayMode: true });
    expect(preview.getAttribute('aria-hidden')).toBe('true');

    // Typing a no-op does not redraw.
    const calls = renderMath.mock.calls.length;
    typeInto(hostOf(editor), 'a^2');
    expect(renderMath.mock.calls.length).toBe(calls);
  });

  test('a renderer that throws shows the TeX, and says so for an equation', () => {
    const editor = mount(
      [block({ content: [m('\\bad')] }), block({ type: 'math', content: [{ text: '\\bad' }] })],
      {
        renderMath: () => {
          throw new Error('ParseError');
        },
      },
    );

    expect(hostOf(editor).querySelector('.neditor-math__source')?.textContent).toBe('\\bad');
    const box = editor.element.querySelector<HTMLElement>('.neditor-math-block')!;
    expect(box.dataset.rendered).toBe('false');
    expect(box.querySelector<HTMLElement>('.neditor-math-block__error')?.hidden).toBe(false);
  });

  test('the popover writes a formula as one undoable edit, and Remove takes it out', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'a' }, m('x'), { text: 'b' }] })]);
    const host = hostOf(editor);

    editor.focusRange('p', 2, 2);
    editor.openMathEditor();

    const dialog = document.querySelector<HTMLElement>('.neditor-math-editor')!;
    const field = dialog.querySelector<HTMLInputElement>('input')!;
    expect(dialog.hidden).toBe(false);
    expect(field.value).toBe('x');

    field.value = 'y^2';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(editor.getDocument().blocks[0]?.content).toEqual([
      { text: 'a' },
      m('y^2'),
      { text: 'b' },
    ]);
    expect(getSelectionRange(host)).toEqual({ start: 2, end: 2 });
    editor.undo();
    expect(editor.getDocument().blocks[0]?.content[1]).toEqual(m('x'));
    // One step, not two: nothing is left to undo.
    expect(editor.canUndo).toBe(false);

    editor.focusRange('p', 1, 1);
    editor.openMathEditor();
    dialog.querySelector<HTMLButtonElement>('.neditor-link-editor__button--remove')!.click();
    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: 'ab' }]);
  });

  test('a new formula left empty is a cancel, not an edit', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'ab' }] })]);

    editor.focusRange('p', 1, 1);
    editor.openMathEditor();
    const field = document.querySelector<HTMLInputElement>('.neditor-math-editor input')!;
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(editor.canUndo).toBe(false);
  });

  test('read-only, the popover does not open and a click on a formula does nothing', () => {
    const editor = mount([block({ id: 'p', content: [m('x')] })], { editable: false });

    editor.focusRange('p', 0, 1);
    editor.openMathEditor();
    hostOf(editor).querySelector<HTMLElement>('.neditor-math')!.click();

    expect(document.querySelector<HTMLElement>('.neditor-math-editor')?.hidden).toBe(true);
  });

  // Every other popover closes on these, because the range each one holds
  // describes the document as it was: applied afterwards, it wrote TeX over
  // whatever now sat at the old offsets.
  test.each([
    ['setDocument', (editor: NEditor) => editor.setDocument({ blocks: [block({ id: 'q' })] })],
    ['undo', (editor: NEditor) => editor.undo()],
    ['setEditable(false)', (editor: NEditor) => editor.setEditable(false)],
  ])('%s closes the equation popover', (_name, act) => {
    const editor = mount([block({ id: 'p', content: [{ text: 'ab' }] })]);
    const host = hostOf(editor);
    typeInto(host, 'abc');

    editor.focusRange('p', 1, 1);
    editor.openMathEditor();
    const dialog = document.querySelector<HTMLElement>('.neditor-math-editor')!;
    expect(dialog.hidden).toBe(false);

    act(editor);
    expect(dialog.hidden).toBe(true);
  });

  test('Mod+Shift+E is left to the browser in an equation, where it does nothing', () => {
    const editor = mount([block({ type: 'math', content: [{ text: 'x' }] })]);
    const host = hostOf(editor);
    host.focus();

    const event = new KeyboardEvent('keydown', {
      key: 'E',
      ctrlKey: true,
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    host.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  test('Enter in an equation is a line of TeX, not a new block', () => {
    const editor = mount([block({ id: 'eq', type: 'math', content: [{ text: 'ab' }] })]);
    editor.focusRange('eq', 1, 1);
    hostOf(editor).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    expect(editor.getDocument().blocks.map((b) => [b.type, b.content])).toEqual([
      ['math', [{ text: 'a\nb' }]],
    ]);
  });

  /** Types `text` at the end of a host, keeping what is there: what a browser does. */
  function append(host: HTMLElement, text: string): void {
    host.focus();
    host.append(text);
    const end = Number.MAX_SAFE_INTEGER;
    setSelectionRange(host, end, end);
    host.dispatchEvent(
      new InputEvent('input', { inputType: 'insertText', data: text.at(-1), bubbles: true }),
    );
  }

  /** A keystroke the editor takes over in `beforeinput`, as it does after a rule fires. */
  function beforeInput(host: HTMLElement, data: string): InputEvent {
    const event = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data,
      bubbles: true,
      cancelable: true,
    });
    host.dispatchEvent(event);
    return event;
  }

  test('a digit straight after a typed formula takes it back, and undo never sees it', () => {
    const editor = mount([block({ id: 'p' })]);
    const host = hostOf(editor);

    typeInto(host, 'cost $5-$');
    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: 'cost ' }, m('5-')]);

    const event = beforeInput(host, '1');
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: 'cost $5-$1' }]);
    expect(getSelectionRange(host)).toEqual({ start: 10, end: 10 });

    // Undo goes past the formula to before the typing, not back to the formula.
    editor.undo();
    expect(editor.getDocument().blocks[0]?.content).toEqual([]);
  });

  test('anything but a digit after a typed formula keeps it', () => {
    const editor = mount([block({ id: 'p' })]);
    const host = hostOf(editor);

    typeInto(host, 'let $x$');
    beforeInput(host, ' ');

    expect(editor.getDocument().blocks[0]?.content).toEqual([
      { text: 'let ' },
      m('x'),
      { text: ' ' },
    ]);
  });

  test('a $ in a finished code span does not open a typed formula', () => {
    const editor = mount([
      block({ id: 'p', content: [{ text: '$a', marks: ['code'] }, { text: ',' }] }),
    ]);

    append(hostOf(editor), '$');

    expect(editor.getDocument().blocks[0]?.content).toEqual([
      { text: '$a', marks: ['code'] },
      { text: ',$' },
    ]);
  });

  test('applying a formula unchanged, or bolding a lone formula, is not an edit', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'a' }, m('x')] })]);
    const changes: unknown[] = [];
    editor.on('change', (doc) => changes.push(doc));

    editor.focusRange('p', 1, 2);
    editor.openMathEditor();
    document
      .querySelector<HTMLInputElement>('.neditor-math-editor input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    editor.focusRange('p', 1, 2);
    editor.toggleMark('bold');

    expect(editor.canUndo).toBe(false);
    expect(changes).toEqual([]);
  });

  test('Escape gives back the caret the popover was opened from, not the formula', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'a' }, m('x'), { text: 'b' }] })]);
    const host = hostOf(editor);

    editor.focusRange('p', 2, 2);
    editor.openMathEditor();
    document
      .querySelector<HTMLInputElement>('.neditor-math-editor input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(getSelectionRange(host)).toEqual({ start: 2, end: 2 });
  });

  test('editing a formula from a caret before it leaves the caret before it', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'a' }, m('x')] })]);
    const host = hostOf(editor);

    editor.focusRange('p', 1, 1);
    editor.openMathEditor();
    const field = document.querySelector<HTMLInputElement>('.neditor-math-editor input')!;
    field.value = 'y';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(getSelectionRange(host)).toEqual({ start: 1, end: 1 });
  });

  test('a caret left inside a formula is a caret at its edge, not a selection of it', () => {
    const host = document.createElement('div');
    host.contentEditable = 'true';
    document.body.append(host);
    host.append(
      renderRichText(document, [{ text: 'ab' }, m('x')], { editing: true, renderMath: loud }),
    );
    host.focus();

    const inside = host.querySelector('.drawn')!.firstChild!;
    const range = document.createRange();
    range.setStart(inside, 3);
    range.collapse(true);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);

    expect(getSelectionRange(host)).toEqual({ start: 2, end: 2 });
  });

  test('in an equation the format toolbar does not offer, and marks and links are refused', () => {
    const editor = mount([block({ id: 'eq', type: 'math', content: [{ text: 'E = mc^2' }] })]);

    editor.focusRange('eq', 0, 1);
    editor.toggleMark('bold');

    expect(editor.setLink('https://a.test/')).toBe(false);
    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: 'E = mc^2' }]);
    expect(editor.canUndo).toBe(false);
  });

  test('Mod+Shift+E in a table cell edits that cell', () => {
    const editor = mount([
      block({
        id: 't',
        type: 'table',
        rows: [
          [[{ text: 'h' }], [{ text: 'k' }]],
          [[{ text: 'a' }], [{ text: 'b' }]],
        ],
      }),
    ]);

    editor.focusRange('t', 0, 1, { row: 1, column: 1 });
    editor.openMathEditor();
    const field = document.querySelector<HTMLInputElement>('.neditor-math-editor input')!;
    expect(field.value).toBe('b');
    field.value = '\\beta';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(editor.getDocument().blocks[0]?.rows?.[1]?.[1]).toEqual([m('\\beta')]);
    expect(editor.getDocument().blocks[0]?.rows?.[1]?.[0]).toEqual([{ text: 'a' }]);
  });

  test('a selected table is announced with its formulas as TeX', () => {
    const editor = mount([
      block({ id: 't', type: 'table', rows: [[[m('x^2'), { text: ' value' }], [{ text: 'b' }]]] }),
    ]);

    editor.selectBlocks(['t']);

    expect(editor.element.querySelector('.neditor-live-region')?.textContent).toContain(
      '$x^2$ value',
    );
  });

  test("the popover says, in the field's own description, that the renderer refused the TeX", () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'ab' }] })], {
      renderMath: () => {
        throw new Error('ParseError');
      },
    });

    editor.focusRange('p', 1, 1);
    editor.openMathEditor();
    const field = document.querySelector<HTMLInputElement>('.neditor-math-editor input')!;
    field.value = '\\frac{';
    field.dispatchEvent(new Event('input'));

    const error = document.getElementById(field.getAttribute('aria-describedby') ?? '');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(error?.hidden).toBe(false);
    expect(error?.closest('[aria-hidden="true"]')).toBeNull();
  });

  test("an equation's error is the source's description, outside the hidden picture", () => {
    const editor = mount([block({ type: 'math', content: [{ text: '\\frac{' }] })], {
      renderMath: () => {
        throw new Error('ParseError');
      },
    });
    const host = hostOf(editor);
    const error = document.getElementById(host.getAttribute('aria-describedby') ?? '');

    expect(error?.textContent).toBe('This TeX could not be rendered');
    expect(error?.hidden).toBe(false);
    expect(error?.closest('[aria-hidden="true"]')).toBeNull();
  });

  test('read-only, the picture is what is read and the hidden source is not; editable, the reverse', () => {
    const editor = mount([block({ type: 'math', content: [{ text: 'x' }] })], { renderMath: loud });
    const host = hostOf(editor);
    const preview = editor.element.querySelector<HTMLElement>('.neditor-math-block__preview')!;

    expect(preview.getAttribute('aria-hidden')).toBe('true');
    expect(preview.getAttribute('tabindex')).toBe('-1');
    expect(host.hasAttribute('aria-hidden')).toBe(false);

    editor.setEditable(false);
    expect(preview.hasAttribute('aria-hidden')).toBe(false);
    expect(host.getAttribute('aria-hidden')).toBe('true');
  });

  test('without a picture, the source stays readable even read-only', () => {
    const editor = mount([block({ type: 'math', content: [{ text: 'x' }] })], { editable: false });

    expect(hostOf(editor).hasAttribute('aria-hidden')).toBe(false);
  });

  test('math reads left to right whatever the direction of the page', () => {
    for (const selector of [
      '.neditor-math {',
      '.neditor-math-block > .neditor-block__content {',
      '.neditor-math-block__preview {',
      '.neditor-math-editor__preview {',
    ]) {
      const rule = NEDITOR_STYLES.slice(NEDITOR_STYLES.indexOf(selector));
      const body = rule.slice(0, rule.indexOf('}'));

      expect({
        selector,
        ltr: body.includes('direction: ltr'),
        isolated: body.includes('unicode-bidi: isolate'),
      }).toEqual({ selector, ltr: true, isolated: true });
    }
  });
});

describe('the clipboard and math', () => {
  function paste(host: HTMLElement, html: string, plain = '', own = false): void {
    const data = new DataTransfer();
    data.setData('text/html', html);
    data.setData('text/plain', plain);

    if (own) {
      data.setData('application/x-neditor', '1');
    }

    host.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }

  const katexHtml = (tex: string) =>
    `<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>g</mi></mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">g</span></span>`;

  test('KaTeX pasted into an equation is its TeX, not the glyphs in its plain text', () => {
    const editor = mount([block({ id: 'eq', type: 'math' })]);
    editor.focus('eq');

    paste(
      hostOf(editor),
      `<p><span class="katex-display">${katexHtml('\\frac{1}{2}')}</span></p>`,
      '1212',
    );

    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: '\\frac{1}{2}' }]);
  });

  test('a table with formulas pasted into a cell, a code block or an equation keeps their TeX', () => {
    const table = blocksToHtml(document, [
      block({ type: 'table', rows: [[[{ text: 'a ' }, m('\\alpha')], [m('\\pi')]]] }),
    ]);

    const code = mount([block({ id: 'c', type: 'code' })]);
    code.focus('c');
    paste(hostOf(code), table, '', true);
    expect(code.getDocument().blocks[0]?.content).toEqual([{ text: 'a $\\alpha$\t$\\pi$' }]);

    const equation = mount([block({ id: 'e', type: 'math' })]);
    equation.focus('e');
    paste(hostOf(equation), table, '', true);
    expect(equation.getDocument().blocks[0]?.content).toEqual([{ text: 'a \\alpha\t\\pi' }]);

    const cell = mount([
      block({ id: 't', type: 'table', rows: [[[{ text: 'h' }]], [[{ text: '' }]]] }),
    ]);
    cell.focusRange('t', 0, 0, { row: 1, column: 0 });
    paste(cell.element.querySelector<HTMLElement>('[data-cell="1:0"]')!, table, '', true);
    expect(cell.getDocument().blocks[0]?.rows?.[1]?.[0]).toEqual([
      { text: 'a ' },
      m('\\alpha'),
      { text: '\t' },
      m('\\pi'),
    ]);
  });

  test('an equation pasted mid-sentence stands as a block, and the sentence stays prose', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'hello world' }] })]);
    editor.focusRange('p', 5, 5);

    paste(
      hostOf(editor),
      blocksToHtml(document, [block({ type: 'math', content: [{ text: 'x^2' }] })]),
      '',
      true,
    );

    expect(editor.getDocument().blocks.map((b) => [b.type, b.content])).toEqual([
      ['paragraph', [{ text: 'hello' }]],
      ['math', [{ text: 'x^2' }]],
      ['paragraph', [{ text: ' world' }]],
    ]);
  });

  test('pasted blocks ending in an equation do not pour the rest of the line into it', () => {
    const editor = mount([
      block({ id: 'p', content: [{ text: 'hel' }, { text: 'lo', marks: ['bold'] }] }),
    ]);
    editor.focusRange('p', 3, 3);

    paste(
      hostOf(editor),
      blocksToHtml(document, [
        block({ content: [{ text: 'p' }] }),
        block({ type: 'math', content: [{ text: 'x^2' }] }),
      ]),
      '',
      true,
    );

    expect(editor.getDocument().blocks.map((b) => [b.type, b.content])).toEqual([
      ['paragraph', [{ text: 'help' }]],
      ['math', [{ text: 'x^2' }]],
      ['paragraph', [{ text: 'lo', marks: ['bold'] }]],
    ]);
  });

  test('copying text that holds a formula writes its TeX, not its picture', () => {
    const editor = mount(
      [block({ id: 'p', content: [{ text: 'a ' }, m('x^2'), { text: ' b' }] })],
      {
        renderMath: loud,
      },
    );
    editor.focusRange('p', 0, 5);

    const data = new DataTransfer();
    const event = new ClipboardEvent('copy', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    hostOf(editor).dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(data.getData('text/plain')).toBe('a $x^2$ b');
    expect(data.getData('text/html')).toBe(
      '<span style="white-space: pre-wrap;">a <span data-neditor-math="x^2">$x^2$</span> b</span>',
    );
  });

  test('copying text with no formula writes its characters, with no dollars added', () => {
    // Every text range is written from the model (README, "Copying and
    // pasting": the browser's own copy carried the editor's computed styles),
    // so a range with no formula is no longer the browser's. What the math
    // side asked of it still holds: nothing of a formula's spelling appears,
    // and a literal dollar is the character typed.
    const editor = mount([block({ id: 'p', content: [{ text: 'plain $5' }] })]);
    editor.focusRange('p', 0, 8);

    const data = new DataTransfer();
    const event = new ClipboardEvent('copy', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    hostOf(editor).dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(data.getData('text/plain')).toBe('plain $5');
    expect(data.getData('text/html')).toBe('<span style="white-space: pre-wrap;">plain $5</span>');
  });

  test('cutting text that holds a formula removes it as one edit', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'a ' }, m('x'), { text: ' b' }] })]);
    editor.focusRange('p', 1, 3);

    hostOf(editor).dispatchEvent(
      new ClipboardEvent('cut', {
        clipboardData: new DataTransfer(),
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: 'a b' }]);
    editor.undo();
    expect(editor.getDocument().blocks[0]?.content).toEqual([
      { text: 'a ' },
      m('x'),
      { text: ' b' },
    ]);
  });
});

describe('round 2 of the math audit: typing, pasting and copying around formulas', () => {
  function paste(host: HTMLElement, html: string, plain = ''): void {
    const data = new DataTransfer();
    data.setData('text/html', html);
    data.setData('text/plain', plain);
    host.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }

  function copy(host: HTMLElement): DataTransfer {
    const data = new DataTransfer();
    host.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
    );
    return data;
  }

  function beforeInput(
    host: HTMLElement,
    data: string | null,
    inputType = 'insertText',
  ): InputEvent {
    const event = new InputEvent('beforeinput', {
      inputType,
      data,
      bubbles: true,
      cancelable: true,
    });
    host.dispatchEvent(event);
    return event;
  }

  const key = (host: HTMLElement, init: KeyboardEventInit): void => {
    host.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  };

  const moved = (): void => {
    document.dispatchEvent(new Event('selectionchange'));
  };

  test('plain text with a pair of dollars pasted into a code block is that text, not Markdown', () => {
    const shell = '# set the path\nexport P="$HOME/$USER"\n- item *one*\nx = a_b_c \\\\ y';

    for (const type of ['code', 'math'] as const) {
      const editor = mount([block({ id: 'c', type })]);
      editor.focus('c');
      paste(hostOf(editor), '', shell);

      expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: shell }]);
    }
  });

  test('a copied range holding a formula keeps its line breaks and runs of spaces', () => {
    const from = mount([
      block({ id: 'p', content: [{ text: 'a  b\nc ' }, m('x'), { text: ' d' }] }),
    ]);
    from.focusRange('p', 0, 10);
    const data = copy(hostOf(from));

    const into = mount([block({ id: 'q', content: [{ text: '' }] })]);
    into.focus('q');
    paste(hostOf(into), data.getData('text/html'), data.getData('text/plain'));

    expect(into.getDocument().blocks[0]?.content).toEqual([
      { text: 'a  b\nc ' },
      m('x'),
      { text: ' d' },
    ]);
  });

  test('a formula opened by a click gives back a caret after it on Escape, not the formula', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'a' }, m('x'), { text: 'b' }] })]);
    const host = hostOf(editor);

    host.querySelector<HTMLElement>('.neditor-math')!.click();
    document
      .querySelector<HTMLInputElement>('.neditor-math-editor input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(getSelectionRange(host)).toEqual({ start: 2, end: 2 });
  });

  test('a digit typed with Shift still takes the formula back (AZERTY)', () => {
    const editor = mount([block({ id: 'p' })]);
    const host = hostOf(editor);

    typeInto(host, 'cost $5-$');
    key(host, { key: 'Shift', shiftKey: true });
    beforeInput(host, '1');

    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: 'cost $5-$1' }]);
  });

  test('a caret that went away and came back keeps the formula', () => {
    const editor = mount([block({ id: 'p' }), block({ id: 'q', content: [{ text: 'other' }] })]);
    const host = hostOf(editor);

    typeInto(host, 'let $x$');
    moved();
    editor.focusRange('q', 2, 2);
    moved();
    editor.focusRange('p', 5, 5);
    moved();
    beforeInput(host, '2');

    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: 'let ' }, m('x')]);
  });

  test('a press between the formula and the digit keeps the formula', () => {
    const editor = mount([block({ id: 'p' })]);
    const host = hostOf(editor);

    typeInto(host, 'let $x$');
    host.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    beforeInput(host, '2');

    expect(editor.getDocument().blocks[0]?.content).toEqual([
      { text: 'let ' },
      m('x'),
      { text: '2' },
    ]);
  });

  test('a shortcut between the formula and the digit keeps the formula', () => {
    const editor = mount([block({ id: 'p' })]);
    const host = hostOf(editor);

    typeInto(host, 'let $x$');
    key(host, { key: 'b', ctrlKey: true, metaKey: true });
    beforeInput(host, '2');

    // The digit is typed bold, as the shortcut armed it; the formula stays.
    expect(editor.getDocument().blocks[0]?.content).toEqual([
      { text: 'let ' },
      m('x'),
      { text: '2', marks: ['bold'] },
    ]);
  });

  test.each([
    ['Ctrl', { ctrlKey: true }],
    ['Cmd', { metaKey: true }],
  ])('%s with a key between the formula and the digit keeps the formula', (_name, chord) => {
    const editor = mount([block({ id: 'p' })]);
    const host = hostOf(editor);

    typeInto(host, 'let $x$');
    key(host, { key: 'q', ...chord });
    beforeInput(host, '2');

    expect(editor.getDocument().blocks[0]?.content).toEqual([
      { text: 'let ' },
      m('x'),
      { text: '2' },
    ]);
  });

  test('a formula taken back inside a link stays in the link', () => {
    const editor = mount([block({ id: 'p' })]);
    const host = hostOf(editor);

    host.focus();
    host.innerHTML = '<a href="https://a.test/">see $5-$</a>';
    setSelectionRange(host, 8, 8);
    host.dispatchEvent(
      new InputEvent('input', { inputType: 'insertText', data: '$', bubbles: true }),
    );
    expect(editor.getDocument().blocks[0]?.content).toEqual([
      { text: 'see ', link: 'https://a.test/' },
      m('5-'),
    ]);

    beforeInput(host, '1');

    expect(editor.getDocument().blocks[0]?.content).toEqual([
      { text: 'see $5-$', link: 'https://a.test/' },
      { text: '1' },
    ]);
  });

  test('a formula taken back in the middle of a link keeps the digit in it', () => {
    const editor = mount([block({ id: 'p' })]);
    const host = hostOf(editor);

    host.focus();
    host.innerHTML = '<a href="https://a.test/">see $5-$ more</a>';
    setSelectionRange(host, 8, 8);
    host.dispatchEvent(
      new InputEvent('input', { inputType: 'insertText', data: '$', bubbles: true }),
    );
    beforeInput(host, '1');

    expect(editor.getDocument().blocks[0]?.content).toEqual([
      { text: 'see $5-$1 more', link: 'https://a.test/' },
    ]);
  });

  test('a formula taken back keeps the formatting it was typed in', () => {
    const editor = mount([block({ id: 'p' })]);
    const host = hostOf(editor);

    host.focus();
    host.innerHTML = '<strong>x cost $5-$</strong>';
    setSelectionRange(host, 11, 11);
    host.dispatchEvent(
      new InputEvent('input', { inputType: 'insertText', data: '$', bubbles: true }),
    );
    expect(editor.getDocument().blocks[0]?.content).toEqual([
      { text: 'x cost ', marks: ['bold'] },
      m('5-'),
    ]);

    beforeInput(host, '1');

    expect(editor.getDocument().blocks[0]?.content).toEqual([
      { text: 'x cost $5-$1', marks: ['bold'] },
    ]);
  });

  test('a formula typed straight after a code span ending in $ is a formula', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'x$', marks: ['code'] }] })]);
    const host = hostOf(editor);

    host.focus();
    host.innerHTML = '<code>x$</code>$y$';
    setSelectionRange(host, 5, 5);
    host.dispatchEvent(
      new InputEvent('input', { inputType: 'insertText', data: '$', bubbles: true }),
    );

    expect(editor.getDocument().blocks[0]?.content).toEqual([
      { text: 'x$', marks: ['code'] },
      m('y'),
    ]);
  });

  test('a $ typed before a digit already there closes no formula', () => {
    const editor = mount([block({ id: 'p', content: [{ text: '$5-2' }] })]);
    const host = hostOf(editor);

    host.focus();
    host.textContent = '$5-$2';
    setSelectionRange(host, 4, 4);
    host.dispatchEvent(
      new InputEvent('input', { inputType: 'insertText', data: '$', bubbles: true }),
    );

    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: '$5-$2' }]);
  });

  test('Backspace after a formula that ends its block deletes it, as one undo step', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'Ends ' }, m('y')] })]);
    const host = hostOf(editor);

    editor.focusRange('p', 6, 6);
    const event = beforeInput(host, null, 'deleteContentBackward');

    expect(event.defaultPrevented).toBe(true);
    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: 'Ends ' }]);
    expect(getSelectionRange(host)).toEqual({ start: 5, end: 5 });

    editor.undo();
    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: 'Ends ' }, m('y')]);
  });

  test('Delete before a formula deletes it; beside text it is left to the browser', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'a' }, m('y'), { text: 'b' }] })]);
    const host = hostOf(editor);

    editor.focusRange('p', 1, 1);
    expect(beforeInput(host, null, 'deleteContentForward').defaultPrevented).toBe(true);
    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: 'ab' }]);

    expect(beforeInput(host, null, 'deleteContentBackward').defaultPrevented).toBe(false);
  });

  test('an equation pasted at the start of a heading or a checked to-do leaves it as it was', () => {
    const equation = blocksToHtml(document, [block({ type: 'math', content: [{ text: 'x^2' }] })]);

    for (const target of [
      block({ id: 'h', type: 'heading2', content: [{ text: 'Title' }] }),
      block({ id: 'h', type: 'todo', checked: true, content: [{ text: 'Done' }] }),
    ]) {
      const editor = mount([target]);
      editor.focusRange('h', 0, 0);
      paste(hostOf(editor), equation);

      const [first, second] = editor.getDocument().blocks;
      expect(first?.type).toBe('math');
      expect(first?.content).toEqual([{ text: 'x^2' }]);
      expect(second).toEqual(target);
    }
  });

  test.each([
    [
      'a collapsed toggle',
      block({ id: 't', type: 'toggle', collapsed: true, content: [{ text: 'Bar' }] }),
    ],
    ['a callout', block({ id: 't', type: 'callout', icon: '💡', content: [{ text: 'Bar' }] })],
    ['a heading', block({ id: 't', type: 'heading1', content: [{ text: 'Bar' }] })],
    [
      'a checked to-do',
      block({ id: 't', type: 'todo', checked: true, content: [{ text: 'Bar' }] }),
    ],
  ])('an equation and a paragraph pasted at the start of %s leave it itself', (_name, target) => {
    const kid = block({ id: 'kid', depth: 1, content: [{ text: 'child' }] });
    const editor = mount([target, kid]);
    editor.focusRange('t', 0, 0);
    paste(
      hostOf(editor),
      blocksToHtml(document, [
        block({ type: 'math', content: [{ text: 'x^2' }] }),
        block({ content: [{ text: 'foo' }] }),
      ]),
    );

    const [math, kept, child] = editor.getDocument().blocks;
    expect(math?.type).toBe('math');
    expect(kept).toEqual({ ...target, content: [{ text: 'fooBar' }] });
    expect(child).toEqual(kid);
  });

  test('a closed <details> ending a paste at the start of a heading keeps its body; the heading keeps its text', () => {
    const editor = mount([block({ id: 'h', type: 'heading2', content: [{ text: 'Bar' }] })]);
    editor.focusRange('h', 0, 0);
    paste(
      hostOf(editor),
      `${blocksToHtml(document, [block({ type: 'math', content: [{ text: 'x' }] })])}<details><summary>T</summary><p>kid</p></details>`,
    );

    const blocks = editor.getDocument().blocks;
    expect(blocks.map((b) => [b.type, b.depth, b.content])).toEqual([
      ['math', 0, [{ text: 'x' }]],
      ['toggle', 0, [{ text: 'T' }]],
      ['paragraph', 1, [{ text: 'kid' }]],
      ['heading2', 0, [{ text: 'Bar' }]],
    ]);
    expect(blocks[3]?.id).toBe('h');
  });

  test('a paste that starts nested goes in at the depth of the block it lands before, not into a toggle above', () => {
    const editor = mount([
      block({ id: 't', type: 'toggle', collapsed: true, content: [{ text: 'T' }] }),
      block({ id: 'hid', depth: 1, content: [{ text: 'hidden' }] }),
      block({ id: 'p', content: [{ text: 'hello' }] }),
    ]);
    editor.focusRange('p', 0, 0);
    paste(hostOf(editor, 1), '', '  - deep\n- x');

    const blocks = editor.getDocument().blocks;
    expect(blocks.map((b) => [b.id === 'p' ? 'p' : b.type, b.depth, b.content])).toEqual([
      ['toggle', 0, [{ text: 'T' }]],
      ['paragraph', 1, [{ text: 'hidden' }]],
      ['bulleted_list', 0, [{ text: 'deep' }]],
      ['p', 0, [{ text: 'xhello' }]],
    ]);
  });

  test('a paste over selected blocks keeps its shape at their depth, and selects what is on screen', () => {
    const editor = mount([
      block({ id: 't', type: 'toggle', collapsed: true, content: [{ text: 'T' }] }),
      block({ id: 'hid', depth: 1, content: [{ text: 'hidden' }] }),
      block({ id: 'n', content: [{ text: 'next' }] }),
    ]);
    editor.selectBlocks(['n']);
    paste(editor.element, '', '  - deep\n- x');

    const blocks = editor.getDocument().blocks;
    expect(blocks.map((b) => [b.type, b.depth, b.content])).toEqual([
      ['toggle', 0, [{ text: 'T' }]],
      ['paragraph', 1, [{ text: 'hidden' }]],
      ['bulleted_list', 0, [{ text: 'deep' }]],
      ['bulleted_list', 0, [{ text: 'x' }]],
    ]);
    expect(editor.getSelectedBlocks()).toEqual([blocks[2]!.id, blocks[3]!.id]);
  });

  test('a paste over selected blocks selects none of what lands hidden in a pasted toggle', () => {
    const editor = mount([block({ id: 'n', content: [{ text: 'next' }] })]);
    editor.selectBlocks(['n']);
    paste(editor.element, '', '- ▸ T\n  - body');

    const blocks = editor.getDocument().blocks;
    expect(blocks.map((b) => [b.type, b.depth])).toEqual([
      ['toggle', 0],
      ['bulleted_list', 1],
    ]);
    expect(blocks[0]?.collapsed).toBe(true);
    expect(editor.getSelectedBlocks()).toEqual([blocks[0]!.id]);
  });

  test('a paste into an empty block keeps its shape: a sibling stays out of a pasted toggle', () => {
    const editor = mount([block({ id: 'p', content: [] })]);
    editor.focus('p');
    paste(hostOf(editor), '', '  - ▸ T\n    - body\n  - x');

    const blocks = editor.getDocument().blocks;
    expect(blocks.map((b) => [b.type, b.depth])).toEqual([
      ['toggle', 0],
      ['bulleted_list', 1],
      ['bulleted_list', 0],
    ]);
    expect(blocks[0]?.id).toBe('p');
  });

  test('lines pasted mid-text into a collapsed toggle become its children, and open it', () => {
    const editor = mount([
      block({ id: 't', type: 'toggle', collapsed: true, content: [{ text: 'Title' }] }),
      block({ id: 'hid', depth: 1, content: [{ text: 'hidden' }] }),
    ]);
    editor.focusRange('t', 2, 2);
    paste(hostOf(editor), '', 'a\n  - b');

    const blocks = editor.getDocument().blocks;
    expect(blocks.map((b) => [b.type, b.depth, b.content])).toEqual([
      ['toggle', 0, [{ text: 'Tia' }]],
      ['bulleted_list', 1, [{ text: 'btle' }]],
      ['paragraph', 1, [{ text: 'hidden' }]],
    ]);
    expect(blocks[0]?.collapsed).toBe(false);
  });

  test('a paste at the start of a block keeps three levels of its own shape', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'hello' }] })]);
    editor.focusRange('p', 0, 0);
    paste(hostOf(editor), '', '  - a\n- b\n  - c\n- d');

    expect(editor.getDocument().blocks.map((b) => [b.depth, b.content])).toEqual([
      [0, [{ text: 'a' }]],
      [0, [{ text: 'b' }]],
      [1, [{ text: 'c' }]],
      [0, [{ text: 'dhello' }]],
    ]);
  });

  test('the caret falls back to the nearest pasted block on screen', () => {
    const editor = mount([block({ id: 'p', content: [] })]);
    editor.focus('p');
    paste(hostOf(editor), '<p>A</p><details><summary>Sum</summary><p>Body</p></details>');

    const blocks = editor.getDocument().blocks;
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'toggle', 'paragraph']);
    expect(editor.getSelectionState()?.blockId).toBe(blocks[1]?.id);
    expect(editor.getSelectionState()?.range).toEqual({ start: 3, end: 3 });
  });

  test('a paste of very many blocks is shaped without spreading them into one call', () => {
    const many = Array.from({ length: 200_000 }, (_, at) => block({ id: `b${at}`, depth: at % 2 }));

    expect(() => pastedDepths(many, 0)).not.toThrow();
    expect(shallowest(many)).toBe(0);
    expect(pastedDepths(many.slice(0, 4), 3)).toEqual([3, 4, 3, 4]);
  });

  test('a paste that climbs back up keeps every block at or above where it was', () => {
    const at = (...depths: number[]) => depths.map((depth) => block({ depth }));

    expect(pastedDepths(at(2, 1, 0), 0)).toEqual([0, 0, 0]);
    expect(pastedDepths(at(2, 3, 1, 0), 0)).toEqual([0, 1, 0, 0]);
    expect(pastedDepths(at(1, 0, 1, 0), 0)).toEqual([0, 0, 1, 0]);
  });

  test.each(['the start of a block', 'an empty block', 'selected blocks'] as const)(
    'a copied fold that climbs back up stays one fold, pasted at %s',
    (where) => {
      const copied = blocksToHtml(document, [
        block({ type: 'toggle', depth: 2, collapsed: true, content: [{ text: 'Deep' }] }),
        block({ depth: 3, content: [{ text: 'body' }] }),
        block({ type: 'bulleted_list', depth: 1, content: [{ text: 'back up' }] }),
        block({ depth: 0, content: [{ text: 'top' }] }),
      ]);
      const editor = mount([
        block({ id: 'p', content: where === 'an empty block' ? [] : [{ text: 'hello' }] }),
      ]);

      if (where === 'selected blocks') {
        editor.selectBlocks(['p']);
        paste(editor.element, copied);
      } else {
        editor.focusRange('p', 0, 0);
        paste(hostOf(editor), copied);
      }

      const blocks = editor.getDocument().blocks;
      const deep = blocks.find((b) => blocksText(b) === 'Deep')!;
      const back = blocks.find((b) => blocksText(b) === 'back up')!;
      expect(back.depth).toBeLessThanOrEqual(deep.depth);
    },
  );

  test("a closed <details> ending a paste does not fold away the reader's own blocks", () => {
    const editor = mount([
      block({ id: 'h', type: 'bulleted_list', content: [{ text: 'hello' }] }),
      block({ id: 'kid', type: 'bulleted_list', depth: 1, content: [{ text: 'kid' }] }),
    ]);
    editor.focusRange('h', 5, 5);
    paste(hostOf(editor), '<p>x</p><details><summary>S</summary><p>body</p></details>');

    const blocks = editor.getDocument().blocks;
    expect(blocks.find((b) => b.type === 'toggle')?.collapsed).toBe(false);
    expect(blocks.at(-1)?.id).toBe('kid');
  });

  test('nor does one pasted over a selected toggle fold away its visible child', () => {
    const editor = mount([
      block({ id: 't', type: 'toggle', content: [{ text: 'T' }] }),
      block({ id: 'kid', depth: 1, content: [{ text: 'kid' }] }),
    ]);
    editor.selectBlocks(['t']);
    paste(editor.element, '<details><summary>S</summary><p>body</p></details>');

    const blocks = editor.getDocument().blocks;
    expect(blocks.find((b) => b.type === 'toggle')?.collapsed).toBe(false);
    expect(blocks.some((b) => b.id === 'kid')).toBe(true);
  });

  test("the reader's text after the caret is never folded into a pasted closed <details>", () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'abcd' }] })]);
    editor.focusRange('p', 2, 2);
    paste(
      hostOf(editor),
      `${blocksToHtml(document, [block({ type: 'math', content: [{ text: 'x' }] })])}<details><summary>S</summary><p>body</p></details>`,
    );

    const blocks = editor.getDocument().blocks;
    expect(blocks.find((b) => b.type === 'toggle')?.collapsed).toBe(false);
    expect(blocks.at(-1)?.content).toEqual([{ text: 'bodycd' }]);
  });

  test.each(['toggle', 'callout'] as const)(
    'a nested paste into the text of a %s keeps its shape',
    (type) => {
      const editor = mount([block({ id: 't', type, content: [{ text: 'abcd' }] })]);
      editor.focusRange('t', 2, 2);
      paste(hostOf(editor), '<ul><li>x<ul><li>a<ul><li>b</li></ul></li><li>q</li></ul></li></ul>');

      expect(editor.getDocument().blocks.map((b) => [blocksText(b), b.depth])).toEqual([
        ['abx', 0],
        ['a', 1],
        ['b', 2],
        ['qcd', 1],
      ]);
    },
  );

  test("a fold pasted into a toggle's text never hides the reader's text after the caret", () => {
    const editor = mount([block({ id: 't', type: 'toggle', content: [{ text: 'abcd' }] })]);
    editor.focusRange('t', 2, 2);
    paste(
      hostOf(editor),
      blocksToHtml(document, [
        block({ content: [{ text: 'x' }] }),
        block({ type: 'toggle', depth: 1, collapsed: true, content: [{ text: 'S' }] }),
        block({ depth: 2, content: [{ text: 'body' }] }),
        block({ depth: 1, content: [{ text: 'q' }] }),
      ]),
    );

    const blocks = editor.getDocument().blocks;
    expect(blocks.map((b) => [blocksText(b), b.depth])).toEqual([
      ['abx', 0],
      ['S', 1],
      ['body', 2],
      ['qcd', 1],
    ]);
  });

  test('a paste into a collapsed toggle at the deepest level does not open it for nothing', () => {
    const editor = mount([
      ...Array.from({ length: 32 }, (_, depth) =>
        block({ id: `l${depth}`, type: 'toggle', depth, content: [{ text: `${depth}` }] }),
      ),
      block({ id: 'last', type: 'toggle', depth: 32, collapsed: true, content: [{ text: 'end' }] }),
    ]);
    editor.focusRange('last', 1, 1);
    paste(hostOf(editor, 32), '<p>x</p><p>y</p>');

    const last = editor.getDocument().blocks.find((b) => b.id === 'last');
    expect(last?.collapsed).toBe(true);
  });

  test('Enter in a toggle at the deepest level opens no deeper child', () => {
    const editor = mount([
      ...Array.from({ length: 32 }, (_, depth) =>
        block({ id: `l${depth}`, type: 'toggle', depth, content: [{ text: `${depth}` }] }),
      ),
      block({ id: 'last', type: 'toggle', depth: 32, content: [{ text: 'end' }] }),
    ]);
    editor.focusRange('last', 3, 3);
    hostOf(editor, 32).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    expect(editor.getDocument().blocks.at(-1)?.depth).toBe(32);
  });

  test('a closed <details> pasted into an empty block leaves the caret in a block on screen', () => {
    const editor = mount([
      block({ id: 'p', content: [] }),
      block({ id: 'n', content: [{ text: 'next' }] }),
    ]);
    editor.focus('p');
    paste(hostOf(editor), '<details><summary>Sum</summary><p>Body</p></details>');

    expect(editor.getDocument().blocks.map((b) => [b.type, b.depth])).toEqual([
      ['toggle', 0],
      ['paragraph', 1],
      ['paragraph', 0],
    ]);
    const state = editor.getSelectionState();
    expect(state?.blockId).toBe('p');
    expect(document.activeElement).toBe(hostOf(editor));
  });

  test('an equation and a paragraph pasted at the start of a block: the paragraph takes its text', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'Bar' }] })]);
    editor.focusRange('p', 0, 0);
    paste(
      hostOf(editor),
      blocksToHtml(document, [
        block({ type: 'math', content: [{ text: 'x^2' }] }),
        block({ content: [{ text: 'foo' }] }),
      ]),
    );

    expect(editor.getDocument().blocks.map((b) => [b.type, b.content])).toEqual([
      ['math', [{ text: 'x^2' }]],
      ['paragraph', [{ text: 'fooBar' }]],
    ]);
    // The caret where the pasted text ends and the block's own begins.
    expect(getSelectionRange(hostOf(editor, 1))).toEqual({ start: 3, end: 3 });
  });

  test.each([
    ['a heading', block({ id: 't', type: 'heading1', content: [{ text: 'Bar' }] })],
    [
      'a checked to-do',
      block({ id: 't', type: 'todo', checked: true, content: [{ text: 'Bar' }] }),
    ],
    [
      'a collapsed toggle',
      block({ id: 't', type: 'toggle', collapsed: true, content: [{ text: 'Bar' }] }),
    ],
    ['a callout', block({ id: 't', type: 'callout', icon: '💡', content: [{ text: 'Bar' }] })],
  ])(
    'a paragraph and then an equation pasted at the start of %s go in front of it',
    (_name, target) => {
      const kid = block({ id: 'kid', depth: 1, content: [{ text: 'child' }] });
      const editor = mount([target, kid]);
      editor.focusRange('t', 0, 0);
      paste(
        hostOf(editor),
        blocksToHtml(document, [
          block({ content: [{ text: 'foo' }] }),
          block({ type: 'math', content: [{ text: 'x' }] }),
        ]),
      );

      const blocks = editor.getDocument().blocks;
      expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'math', target.type, 'paragraph']);
      expect(blocks[2]).toEqual(target);
      expect(blocks[3]).toEqual(kid);
    },
  );

  test('two paragraphs pasted at the start of a heading: the heading keeps itself and the last text', () => {
    const editor = mount([block({ id: 'h', type: 'heading2', content: [{ text: 'Bar' }] })]);
    editor.focusRange('h', 0, 0);
    paste(
      hostOf(editor),
      blocksToHtml(document, [
        block({ content: [{ text: 'foo' }] }),
        block({ content: [{ text: 'baz' }] }),
      ]),
    );

    const blocks = editor.getDocument().blocks;
    expect(blocks[0]?.content).toEqual([{ text: 'foo' }]);
    expect(blocks[1]).toEqual(block({ id: 'h', type: 'heading2', content: [{ text: 'bazBar' }] }));
  });

  test('an equation pasted into an empty toggle with children nests under it', () => {
    const toggle = block({ id: 't', type: 'toggle', collapsed: true, content: [] });
    const kid = block({ id: 'kid', depth: 1, content: [{ text: 'child' }] });
    const editor = mount([toggle, kid]);
    editor.focusRange('t', 0, 0);
    paste(
      hostOf(editor),
      blocksToHtml(document, [block({ type: 'math', content: [{ text: 'x' }] })]),
    );

    const blocks = editor.getDocument().blocks;
    expect(blocks.map((b) => [b.type, b.depth])).toEqual([
      ['toggle', 0],
      ['math', 1],
      ['paragraph', 1],
    ]);
    expect(blocks[0]).toEqual({ ...toggle, collapsed: false });
    expect(blocks[1]?.content).toEqual([{ text: 'x' }]);
    expect(blocks[2]).toEqual(kid);
  });

  test("a block a paste replaces keeps none of its old type's fields", () => {
    const editor = mount([block({ id: 't', type: 'todo', checked: true, content: [] })]);
    editor.focusRange('t', 0, 0);
    paste(
      hostOf(editor),
      blocksToHtml(document, [block({ type: 'math', content: [{ text: 'x' }] })]),
    );

    const [replaced] = editor.getDocument().blocks;
    expect(replaced?.type).toBe('math');
    expect(replaced?.id).toBe('t');
    expect(replaced).not.toHaveProperty('checked');
  });

  test('an equation pasted over a selection from the start of a heading keeps the heading', () => {
    const editor = mount([block({ id: 'h', type: 'heading2', content: [{ text: 'Title' }] })]);
    editor.focusRange('h', 0, 2);
    paste(
      hostOf(editor),
      blocksToHtml(document, [block({ type: 'math', content: [{ text: 'x' }] })]),
    );

    const [, heading] = editor.getDocument().blocks;
    expect(heading).toEqual(block({ id: 'h', type: 'heading2', content: [{ text: 'tle' }] }));
  });

  test('HTML that parses to nothing is no HTML: plain text with dollars stays literal', () => {
    const shell = 'echo "$HOME/$USER" # *note* - x';
    const editor = mount([block({ id: 'c', type: 'code' })]);
    editor.focus('c');
    paste(hostOf(editor), '<meta charset="utf-8">', shell);

    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: shell }]);
  });

  test('a held Backspace through text and a formula is one undo step', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'ab' }, m('y'), { text: 'cd' }] })]);
    const host = hostOf(editor);
    const tail = host.lastChild!;

    for (const [text, caret] of [
      ['c', 4],
      ['', 3],
    ] as const) {
      setSelectionRange(host, caret + 1, caret + 1);
      beforeInput(host, null, 'deleteContentBackward');
      tail.textContent = text;
      setSelectionRange(host, caret, caret);
      host.dispatchEvent(
        new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }),
      );
    }

    expect(beforeInput(host, null, 'deleteContentBackward').defaultPrevented).toBe(true);
    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: 'ab' }]);

    editor.undo();
    expect(editor.getDocument().blocks[0]?.content).toEqual([
      { text: 'ab' },
      m('y'),
      { text: 'cd' },
    ]);
  });

  test('taking a formula back does not scroll the page to its block', () => {
    const editor = mount([block({ id: 'p' })]);
    const host = hostOf(editor);
    typeInto(host, 'cost $5-$');
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');

    beforeInput(host, '1');

    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: 'cost $5-$1' }]);
    expect(scroll).not.toHaveBeenCalled();
    scroll.mockRestore();
  });

  test('deleting a formula does not scroll the page to its block', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'a' }, m('y')] })]);
    const host = hostOf(editor);
    editor.focusRange('p', 2, 2);
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');

    beforeInput(host, null, 'deleteContentBackward');

    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: 'a' }]);
    expect(scroll).not.toHaveBeenCalled();
    scroll.mockRestore();
  });

  test('a word deletion beside a formula takes the formula alone', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'a b' }, m('y'), { text: 'c d' }] })]);
    const host = hostOf(editor);

    editor.focusRange('p', 4, 4);
    expect(beforeInput(host, null, 'deleteWordBackward').defaultPrevented).toBe(true);
    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: 'a bc d' }]);

    // Forward, from a fresh caret before the formula.
    editor.setDocument({
      blocks: [block({ id: 'p', content: [{ text: 'a b' }, m('y'), { text: 'c d' }] })],
    });
    editor.focusRange('p', 3, 3);
    expect(beforeInput(hostOf(editor), null, 'deleteWordForward').defaultPrevented).toBe(true);
    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: 'a bc d' }]);
  });

  test('a target range naming the formula from the text around it is the formula', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'a b ' }, m('y'), { text: 'c' }] })]);
    const host = hostOf(editor);
    editor.focusRange('p', 5, 5);

    const texts = [...host.childNodes].filter((node) => node.nodeType === 3);
    const reach = document.createRange();
    reach.setStart(texts[0]!, 4);
    reach.setEnd(texts[1]!, 0);
    const event = new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'getTargetRanges', { value: () => [reach] });
    host.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: 'a b c' }]);
  });

  test('a target range the host cannot read is no reason to leave the formula to the browser', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'ab' }, m('y')] })]);
    const host = hostOf(editor);
    editor.focusRange('p', 3, 3);

    const reach = document.createRange();
    reach.selectNode(host);
    const event = new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'getTargetRanges', { value: () => [reach] });
    host.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: 'ab' }]);
  });

  test("a formula found by its offset, not by a renderer's own .neditor-math inside it", () => {
    const editor = mount(
      [block({ id: 'p', content: [{ text: 'a' }, m('x'), { text: 'b' }, m('y')] })],
      { renderMath: (tex: string) => `<span class="neditor-math">${tex}</span>` },
    );
    const host = hostOf(editor);
    editor.focusRange('p', 4, 4);

    const formulas = host.querySelectorAll('[data-neditor-math]');
    const reach = document.createRange();
    reach.setStartBefore(formulas[formulas.length - 1]!);
    reach.setEndAfter(formulas[formulas.length - 1]!);
    const event = new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'getTargetRanges', { value: () => [reach] });
    host.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: 'a' }, m('x'), { text: 'b' }]);
  });

  test('a deletion whose target reaches past the formula is left to the browser', () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'ab' }, m('y')] })]);
    const host = hostOf(editor);
    editor.focusRange('p', 3, 3);

    const reach = document.createRange();
    reach.setStart(host.firstChild!, 1);
    reach.setEndAfter(host.querySelector('.neditor-math')!);
    const event = new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'getTargetRanges', { value: () => [reach] });
    host.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  test('marks and links are refused in a code block, as in an equation', () => {
    const changes: unknown[] = [];
    const editor = mount([block({ id: 'c', type: 'code', content: [{ text: 'let x' }] })]);
    editor.on('change', (doc) => changes.push(doc));

    editor.focusRange('c', 0, 3);
    editor.toggleMark('bold');
    expect(editor.setLink('https://a.test/')).toBe(false);
    editor.openLinkEditor();

    expect(editor.getDocument().blocks[0]?.content).toEqual([{ text: 'let x' }]);
    expect(changes).toEqual([]);
    expect(
      [...document.querySelectorAll<HTMLElement>('.neditor-link-editor')].every((e) => e.hidden),
    ).toBe(true);
  });

  test('the popover drops the description once invalid TeX is corrected', () => {
    let fail = true;
    const editor = mount([block({ id: 'p', content: [{ text: 'ab' }] })], {
      renderMath: (tex: string) => {
        if (fail) {
          throw new Error(tex);
        }

        return tex;
      },
    });

    editor.focusRange('p', 1, 1);
    editor.openMathEditor();
    const fields = document.querySelectorAll<HTMLInputElement>('.neditor-math-editor input');
    const field = fields[fields.length - 1]!;
    field.value = '\\frac{';
    field.dispatchEvent(new Event('input'));
    expect(field.hasAttribute('aria-describedby')).toBe(true);

    fail = false;
    field.value = 'x';
    field.dispatchEvent(new Event('input'));

    expect(field.hasAttribute('aria-invalid')).toBe(false);
    expect(field.hasAttribute('aria-describedby')).toBe(false);
  });

  test("the popover's field has no description while its TeX draws", () => {
    const editor = mount([block({ id: 'p', content: [{ text: 'ab' }] })], { renderMath: loud });

    editor.focusRange('p', 1, 1);
    editor.openMathEditor();
    const fields = document.querySelectorAll<HTMLInputElement>('.neditor-math-editor input');
    const field = fields[fields.length - 1]!;
    field.value = 'x^2';
    field.dispatchEvent(new Event('input'));

    expect(field.hasAttribute('aria-invalid')).toBe(false);
    expect(field.hasAttribute('aria-describedby')).toBe(false);
  });
});
