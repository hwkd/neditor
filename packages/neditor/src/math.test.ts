// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { Block, NEditor, RichText } from './index.ts';
import {
  MATH_ATOM,
  blocksFromHtml,
  blocksFromMarkdown,
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
import { contentForType, setBlockType } from './model/document.ts';
import { getSelectionRange, isCaretAtEnd, setSelectionRange } from './view/selection.ts';

/**
 * Math: inline formulas as atoms in the runs, display equations as blocks of
 * TeX. The round trips themselves are in `round-trip.test.ts`; this is the
 * behaviour around them -- what the model keeps, what each reader recognises,
 * and what the editor does with real events.
 */

const m = (tex: string) => ({ text: MATH_ATOM, math: tex });

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

  test('a display equation inside a sentence is read as a formula in it', () => {
    const blocks = blocksFromHtml(
      document,
      `<p>so <span class="katex-display">${katexInline('y')}</span> holds</p>`,
    );

    expect(blocks.map((b) => [b.type, b.content])).toEqual([
      ['paragraph', [{ text: 'so ' }, m('y'), { text: ' holds' }]],
    ]);
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
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.neditor-math__source')?.textContent).toBe(tex);
  });

  test('pasted HTML with no math pays nothing for it, however deep', () => {
    expect(() => blocksFromHtml(document, `${'<b>'.repeat(5000)}x`)).not.toThrow();
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
    expect(box.dataset.error).toBe('true');
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
});
