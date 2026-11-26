import { isNode } from '../util/dom.ts';
import { SKIP_TAGS } from './skipped.ts';

/**
 * Math in the DOM: drawing a formula, and recognising one in markup.
 *
 * The model stores TeX and nothing else (see `TextRun.math` and the `math`
 * block). Drawing it is the host's business -- `@neditor/core` has no
 * dependencies, so it cannot bundle KaTeX -- and arrives through a
 * {@link MathRenderer}. What a renderer returns is view-only: it is never
 * parsed back, because every reader here recognises a formula by the TeX it
 * carries and skips the subtree that draws it. So no markup a renderer
 * produces, and no markup pasted from a page that rendered math, can ever
 * persist in the model as anything but TeX.
 */

export interface MathRenderOptions {
  /** True for a display equation, false for a formula inside a line of text. */
  readonly displayMode: boolean;
}

/**
 * Turns TeX into something to show: an HTML string, or a node.
 *
 * KaTeX is the expected one --
 * `(tex, { displayMode }) => katex.renderToString(tex, { displayMode, throwOnError: true })`
 * -- but anything with this shape will do. It is called with TeX from the
 * document, which is untrusted: a string it returns is assigned as HTML, so it
 * must produce safe markup for any input (KaTeX does, unless `trust` is set).
 * A renderer that throws is caught, the TeX is shown instead, and the failure
 * is reported (an equation's error, the popover field marked invalid) -- so
 * throwing on invalid TeX, as above, is what lets it be said in words.
 */
export type MathRenderer = (tex: string, options: MathRenderOptions) => string | Node;

/** Carries an inline formula's TeX, on the editor's atom and in clipboard HTML. */
export const MATH_ATTR = 'data-neditor-math';

/** Carries a display equation's TeX in clipboard HTML. */
export const MATH_BLOCK_ATTR = 'data-neditor-math-block';

/**
 * Draws `tex` into `element`, replacing what it held.
 *
 * Returns false when there was no renderer or it failed, in which case the TeX
 * itself is shown, in a `<code>` so it reads as source -- the fallback the
 * README promises for an editor configured without one. A renderer error does
 * not lose anything: the TeX is the document, and this is only its picture.
 */
export function drawMath(
  element: HTMLElement,
  tex: string,
  displayMode: boolean,
  renderer: MathRenderer | undefined,
): boolean {
  const doc = element.ownerDocument;

  if (renderer && tex.trim().length > 0) {
    try {
      const drawn = renderer(tex, { displayMode });

      if (typeof drawn === 'string') {
        element.innerHTML = drawn;
        return true;
      }

      if (isNode(drawn)) {
        element.replaceChildren(drawn);
        return true;
      }
    } catch {
      // Shown as source below, and the false returned reports it: an
      // equation block says the TeX is invalid, and so does the popover,
      // marking its field. An inline formula in text just shows its source.
    }
  }

  const source = doc.createElement('code');
  source.className = 'neditor-math__source';
  source.textContent = tex;
  element.replaceChildren(source);
  return false;
}

/** A node's tag name, uppercase whatever namespace it is in (MathML is not HTML). */
function tagOf(element: Element): string {
  return element.nodeName.toUpperCase();
}

function hasClass(element: Element, name: string): boolean {
  return (element.getAttribute('class') ?? '').split(/\s+/).includes(name);
}

/**
 * The TeX a rendered formula was drawn from, where the markup records it.
 *
 * KaTeX and MathJax's MathML output, and MediaWiki's, carry the source in a
 * MathML `<annotation encoding="application/x-tex">`; MediaWiki also writes it
 * as the `<math>` element's `alttext`.
 */
function annotatedTex(element: Element): string | null {
  // A subtree already searched to the bottom holds nothing this search could
  // find, when two readers ask about the same element -- `canonicalizeMath`,
  // then the walk. Its descendants are answered by `mathSourceOf`, which
  // passes the verdict down; without that a chain of nested `.katex` spans
  // that name no TeX was searched again from every level.
  if (noTex?.has(element) === true) {
    return null;
  }

  // Walked, not queried: `getElementsByTagName` recurses per level in a
  // headless DOM, and MathJax frames nested 3,500 deep, each with its copy
  // last as MathJax writes it, overflowed the stack there. One walk finds both
  // an annotation (which wins wherever it is) and the first `<math>`'s
  // `alttext`.
  let first: Element | null = tagOf(element) === 'MATH' ? element : null;
  let anyAlt = first?.hasAttribute('alttext') === true;
  const walker = element.ownerDocument.createTreeWalker(element, SHOW_ELEMENT);

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const found = node as Element;
    const tag = tagOf(found);

    if (
      tag === 'ANNOTATION' &&
      (found.getAttribute('encoding') ?? '').toLowerCase() === 'application/x-tex'
    ) {
      return found.textContent ?? '';
    }

    if (tag === 'MATH' && tagOf(element) !== 'MATH') {
      first ??= found;
      anyAlt ||= found.hasAttribute('alttext');
    }
  }

  const alt = first?.getAttribute('alttext') ?? null;

  if (alt === null && !anyAlt) {
    noTex?.add(element);
  }

  return alt;
}

/**
 * Elements whose whole subtree names no TeX: no annotation, no `alttext`.
 *
 * A descendant of one is one too, which `mathSourceOf` passes down as the
 * walks reach it, parent before child, so each level asks once.
 *
 * Known only for the length of one read ({@link readingMath}): the DOM
 * `parseRichText` is handed can be live, and a verdict kept past the read
 * went on reading a formula as its glyphs after markup naming its TeX was
 * added to it. Outside a read nothing is remembered.
 */
let noTex: Set<Element> | null = null;

/**
 * MathJax frames, and whether each draws text of its own beside its assistive
 * copies: asked once a frame for the length of a read, not once a copy.
 */
let framesDrawn: Map<Element, boolean> | null = null;

/** Whether each element holds text a reader keeps; see `keepsText`. */
let textBelow: Map<Element, boolean> | null = null;

/**
 * Runs one read of markup, sharing what it learns about formulas with every
 * reader it calls and forgetting it afterwards. A read inside another (the
 * walk inside `blocksFromHtml`) shares the outer one's.
 */
export function readingMath<T>(read: () => T): T {
  if (noTex !== null) {
    return read();
  }

  noTex = new Set();
  framesDrawn = new Map();
  textBelow = new Map();

  try {
    return read();
  } finally {
    noTex = null;
    framesDrawn = null;
    textBelow = null;
  }
}

/**
 * The classes MathJax 2 gives the element that draws a formula, by output
 * mode, and the wrapper a displayed one is drawn in: HTML-CSS's and SVG's
 * `<div>`, CommonHTML's `MJXc-display` span, PreviewHTML's
 * `MathJax_PHTML_Display` div, PlainSource's `MathJax_PlainSource_Display`
 * div (around a `MathJax_PlainSource` span that draws the TeX as text).
 * NativeMML draws a displayed one in a `<div>` of the same class,
 * `MathJax_MathML`. The `<script>` follows the outermost
 * of them (each output's `preTranslate`, in MathJax 2.7.9, inserts the
 * wrapper, or the frame when there is none, before the script).
 */
const MATHJAX_FRAMES = [
  'MathJax',
  'MathJax_CHTML',
  'MathJax_SVG',
  'MathJax_MathML',
  'MathJax_PHTML',
  'MathJax_PlainSource',
  'MathJax_Display',
  'MathJax_SVG_Display',
  'MathJax_PHTML_Display',
  'MathJax_PlainSource_Display',
  'MJXc-display',
];

/**
 * The display wrappers, asked only of a frame with no script after it, which
 * names its TeX in its assistive copy. PlainSource's is not one of them:
 * `AssistiveMML` (2.7.9) gives a PlainSource frame no copy, so without its
 * script it is the TeX drawn as text, and read as that.
 */
const MATHJAX_DISPLAYS = [
  'MathJax_Display',
  'MathJax_SVG_Display',
  'MathJax_PHTML_Display',
  'MJXc-display',
];

const isMathJaxFrame = (element: Element): boolean =>
  MATHJAX_FRAMES.some((name) => hasClass(element, name));

const isMathJaxDisplay = (element: Element): boolean =>
  MATHJAX_DISPLAYS.some((name) => hasClass(element, name));

/** The `<script type="math/tex">` after a MathJax 2 frame, which names its TeX. */
function mathJaxScript(element: Element): Element | null {
  if (!isMathJaxFrame(element)) {
    return null;
  }

  const script = element.nextElementSibling;

  return script &&
    tagOf(script) === 'SCRIPT' &&
    /^math\/tex/i.test(script.getAttribute('type') ?? '')
    ? script
    : null;
}

/**
 * MathJax 2's formula, whose TeX it keeps in the `<script type="math/tex">`
 * that follows what it drew -- `mode=display` for a displayed one. Math
 * Stack Exchange still serves it. The script is skipped by every reader, so
 * without this the TeX was lost and the glyphs read twice: once drawn, once
 * as the assistive MathML beside them.
 */
function mathJaxSource(element: Element): { tex: string; display: boolean } | null {
  const script = mathJaxScript(element);

  if (!script) {
    return null;
  }

  return {
    tex: (script.textContent ?? '').trim(),
    display: /mode\s*=\s*display/i.test(script.getAttribute('type') ?? ''),
  };
}

/**
 * Whether a MathJax 2 frame with no script is one formula, whose assistive
 * copy can name its TeX: it holds exactly one such copy, as its own child,
 * around a single `<math>` (`AssistiveMML` appends one to the frame) -- or, for a
 * display wrapper, it holds nothing but one such frame. A frame class is
 * also a page's own class: around paragraphs, or a wrapper around two
 * formulas and the text between them, it is walked, and each formula in it
 * is found where it stands. Read as one, the first annotation was the whole
 * of it and everything else was lost.
 *
 * Children are asked, never descendants searched, so a chain of frames
 * costs each level its own children.
 */
function isOneMathJaxFormula(element: Element): boolean {
  const copies = [...element.children].filter((child) => hasClass(child, 'MJX_Assistive_MathML'));

  // Two copies are two formulas' worth, or a page's own markup: read as the
  // first, the second was lost.
  if (copies.length > 1) {
    return false;
  }

  const [assistive] = copies;

  if (assistive) {
    const [math, ...rest] = assistive.children;
    return math !== undefined && rest.length === 0 && tagOf(math) === 'MATH';
  }

  if (!isMathJaxDisplay(element)) {
    return false;
  }

  const [frame, ...rest] = element.children;

  return (
    frame !== undefined &&
    rest.length === 0 &&
    [...element.childNodes].every((child) => child === frame || isLayout(child)) &&
    !isMathJaxDisplay(frame) &&
    isMathJaxFrame(frame) &&
    isOneMathJaxFormula(frame)
  );
}

/**
 * Whether markup is a formula, and if so its TeX and whether it is displayed.
 *
 * Recognised: the editor's own atom and clipboard spellings, KaTeX output
 * (`.katex`, `.katex-display`), a MathML `<math>`, MediaWiki's
 * `.mwe-math-element`, and MathJax 2's frame followed by its TeX script (or,
 * with none, holding an annotated assistive copy). Each foreign one only when
 * it names its TeX: a formula
 * whose source cannot be recovered is read as whatever text it holds, as it
 * always was, rather than guessed at from its glyphs.
 *
 * Reading the TeX out of an attribute or an annotation is the whole of the
 * trust boundary here: the result is a string, and the subtree around it --
 * KaTeX's spans, a MediaWiki fallback `<img>` -- is never read at all.
 */
export function mathSourceOf(element: Element): { tex: string; display: boolean } | null {
  const own = element.getAttribute(MATH_ATTR);

  if (own !== null) {
    return { tex: own, display: false };
  }

  const block = element.getAttribute(MATH_BLOCK_ATTR);

  if (block !== null) {
    return { tex: block, display: true };
  }

  const mathJax = mathJaxSource(element);

  if (mathJax) {
    return mathJax;
  }

  if (element.parentElement && noTex?.has(element.parentElement) === true) {
    noTex.add(element);
    return null;
  }

  const tag = tagOf(element);
  const katexDisplay = hasClass(element, 'katex-display');
  const katex = katexDisplay || hasClass(element, 'katex');
  const mediaWiki = hasClass(element, 'mwe-math-element');
  // A MathJax frame with no script after it can still name its TeX in the
  // assistive MathML copy inside it, which the reader skips beside a drawing
  // in text (and reads as text beside an SVG one): asked here,
  // as a whole, or the TeX was lost and the glyphs read. Only a frame that
  // is one formula.
  const mathJaxFrame = isMathJaxFrame(element) && isOneMathJaxFormula(element);

  if (!katex && !mediaWiki && !mathJaxFrame && tag !== 'MATH') {
    return null;
  }

  const tex = annotatedTex(element);

  if (tex === null) {
    return null;
  }

  const blockMath = (math: Element | undefined): boolean =>
    (math?.getAttribute('display') ?? '').toLowerCase() === 'block';
  const display =
    katexDisplay ||
    isMathJaxDisplay(element) ||
    (tag === 'MATH' && blockMath(element)) ||
    (mediaWiki && blockMath(element.getElementsByTagName('math')[0]));

  return { tex: tex.trim(), display };
}

/**
 * The assistive MathML copy beside a drawn formula whose TeX could not be
 * recovered: KaTeX's MathML half, or MathJax's `MJX_Assistive_MathML`.
 *
 * WebKit strips the `<annotation>` out of HTML put on the clipboard -- it is
 * never rendered -- so a KaTeX formula copied there arrives with no TeX to
 * recover. Read as text, both halves came through: `\frac{1}{2}` pasted as
 * `1221`. The MathML half is the copy for assistive technology, so it is the
 * one left out, and the formula reads as the glyphs the reader saw, once.
 */
export function isAssistiveMathCopy(element: Element): boolean {
  // MathJax's assistive copy is the same thing under another name, beside a
  // drawing that names no TeX script -- left out only where that drawing is
  // text. MathJax's SVG output draws no text a reader keeps, so there the copy
  // is the only reading of the formula there is, and left out, the formula
  // was lost (`a <svg> b` read "a  b").
  //
  // Only in a MathJax frame, which is asked once a read: each copy scanning
  // its parent made a paste of thousands of them in one paragraph quadratic
  // (27 s at 8,000), and two copies in one frame each took the other for the
  // drawing.
  if (hasClass(element, 'MJX_Assistive_MathML')) {
    const frame = element.parentElement;

    return frame !== null && frameDrawsText(frame);
  }

  return hasClass(element, 'katex-mathml') && element.nextElementSibling !== null
    ? hasClass(element.nextElementSibling, 'katex-html')
    : false;
}

/**
 * Gives a reader's stand-in for `source` what a KaTeX MathML copy judges its
 * next sibling by: the `katex-html` class of the drawing. A copy is decided by
 * what follows it as the markup stands now, so a drawing a reader took out
 * behind a stand-in -- a wrapped `<summary>` that was the drawing, read as the
 * title -- turned the copy before it into content, and the formula read twice.
 * The stand-in is a `<template>`, which every reader skips, so the class makes
 * it nothing else.
 */
export function keepDrawingClass(source: Node, standIn: Element): void {
  if (source.nodeType === 1 && hasClass(source as Element, 'katex-html')) {
    standIn.setAttribute('class', 'katex-html');
  }
}

/**
 * Whether an element is a MathJax frame that draws text of its own beside its
 * assistive copies -- the whole question cached per element for the read,
 * the frame test included: asked before the cache, splitting a hostile
 * 20,000-token `class` once per copy beside it took seconds.
 */
function frameDrawsText(frame: Element): boolean {
  const known = framesDrawn?.get(frame);

  if (known !== undefined) {
    return known;
  }

  let drawn = false;

  if (isMathJaxFrame(frame)) {
    for (const node of frame.childNodes) {
      // The frame's own copies are what is being decided, so they are not
      // its drawing; nor is any other copy the reader skips (KaTeX's, asked
      // of its sibling) -- the whole question its nested walk asks.
      if (
        node.nodeType === 1 &&
        (hasClass(node as Element, 'MJX_Assistive_MathML') || isAssistiveMathCopy(node as Element))
      ) {
        continue;
      }

      if (
        node.nodeType === 3 ? !isLayout(node) : node.nodeType === 1 && keepsText(node as Element)
      ) {
        drawn = true;
        break;
      }
    }
  }

  framesDrawn?.set(frame, drawn);
  return drawn;
}

/**
 * Whether an element holds text a reader keeps -- outside what the reader
 * skips (`SKIP_TAGS`: `<svg>`, a picture whatever `<text>` it holds,
 * `<noscript>`, `<style>`...) and outside the assistive copies it skips
 * (a nested frame's, where that frame draws text; one it reads is text) --
 * remembered for every element it walks, for the read. Frames nested in
 * frames each read the whole subtree below them once a level, which a
 * pasted chain 512 deep (the HTML parser's cap) made seconds; walked once,
 * bottom up, each element is visited at most once a read.
 */
function keepsText(root: Element): boolean {
  const memo = textBelow ?? new Map<Element, boolean>();

  if (SKIP_TAGS.has(root.tagName.toUpperCase())) {
    return false;
  }

  const own = mathSourceOf(root);

  if (own !== null) {
    return own.tex.trim().length > 0;
  }

  const known = memo.get(root);

  if (known !== undefined) {
    return known;
  }

  const stack: Array<{ element: Element; next: number; found: boolean }> = [
    { element: root, next: 0, found: false },
  ];

  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    const children = top.element.childNodes;

    if (top.found || top.next >= children.length) {
      memo.set(top.element, top.found);
      stack.pop();

      if (stack.length > 0) {
        stack[stack.length - 1]!.found ||= top.found;
      }

      continue;
    }

    const node = children[top.next]!;
    top.next += 1;

    if (node.nodeType === 3) {
      top.found ||= !isLayout(node);
      continue;
    }

    if (node.nodeType !== 1) {
      continue;
    }

    const element = node as Element;

    // A nested MathJax copy is counted as text, never asked about: the reader
    // skips one only where its frame draws text, and that drawing is in this
    // same subtree, so the answer is the same -- and asking recursed through
    // `frameDrawsText` once a level, overflowing at 2,500 nested frames in a
    // headless DOM. KaTeX's copy is asked by its sibling, which recurses not.
    if (
      SKIP_TAGS.has(element.tagName.toUpperCase()) ||
      (!hasClass(element, 'MJX_Assistive_MathML') && isAssistiveMathCopy(element))
    ) {
      continue;
    }

    // A formula is what the walk reads it as, and never entered: with TeX,
    // text kept -- judged by the text inside it, one drawing none counted as
    // no drawing, and the copy beside it was read as well -- and with none,
    // nothing. Entered, a nested chain of them was searched once a level.
    const formula = mathSourceOf(element);

    if (formula !== null) {
      top.found ||= formula.tex.trim().length > 0;
      continue;
    }

    const below = memo.get(element);

    if (below !== undefined) {
      top.found ||= below;
    } else {
      stack.push({ element, next: 0, found: false });
    }
  }

  return memo.get(root) ?? false;
}

/** Text that is only layout: whitespace between the tags of pretty-printed HTML. */
function isLayout(node: Node): boolean {
  return node.nodeType === 8 || (node.nodeType === 3 && !/[^ \t\n\r\f]/.test(node.nodeValue ?? ''));
}

const SHOW_ELEMENT = 0x1;
const FILTER_REJECT = 2;
const FILTER_SKIP = 3;

/** Text any markup {@link mathSourceOf} recognises must contain. */
const MATH_HINT = /katex|<math|mwe-math|mathjax|data-neditor-math/i;

/** Wrappers a display equation is commonly set in, which it may stand in for. */
const LIFTABLE = new Set(['P', 'DIV', 'SPAN']);

/**
 * Rewrites every recognised formula in a parsed fragment to the editor's own
 * spelling of it, before anything else reads the fragment.
 *
 * Rendered math is a large subtree drawn twice -- KaTeX writes MathML for
 * assistive technology beside HTML for the eye -- with an `<img>` fallback in
 * MediaWiki's case, so every reader that walks it sees duplicated glyphs, an
 * image block, or both. Replacing each formula with one element carrying its
 * TeX leaves every later reader one thing to recognise, and the image and
 * table logic nothing inside a formula to trip on.
 *
 * A display equation that is the whole of its paragraph -- `<p>` around
 * `.katex-display` is how Markdown renderers emit `$$…$$` -- takes that
 * paragraph's place, so it is read as an equation block rather than as a
 * paragraph holding one formula. Anywhere else it is read inline.
 *
 * Only for a fragment this package owns: `blocksFromHtml` parses into a
 * detached template, which nothing else can see.
 */
export function canonicalizeMath(doc: Document, root: ParentNode & Node, html: string): void {
  // Most pastes hold no math at all, and they pay nothing for this.
  if (!MATH_HINT.test(html)) {
    return;
  }

  readingMath(() => {
    canonicalize(doc, root);
  });
}

/**
 * Takes out what MathJax 2 writes around a formula it read from a script:
 * the script, and the empty `MathJax_Preview` before the frame (in 2.7,
 * tex2jax's `createPreview` puts the preview before the script, and the
 * output's `preTranslate` then puts the frame between them). They
 * are the formula's, and left beside it they were text to the readers'
 * tests: the script kept the paragraph Math Stack Exchange puts around
 * `$$…$$` from standing for the equation, and the preview, an inline
 * sibling, kept the equation in the line of a list item's text. A preview
 * that still holds something -- fast preview's drawing, before the real
 * one replaced it -- is left to be read.
 */
function removeMathJaxParts(element: Element): void {
  if (element.hasAttribute(MATH_ATTR) || element.hasAttribute(MATH_BLOCK_ATTR)) {
    return;
  }

  const script = mathJaxScript(element);

  if (!script) {
    return;
  }

  let before = element.previousSibling;

  while (before !== null && isLayout(before)) {
    before = before.previousSibling;
  }

  if (
    before !== null &&
    before.nodeType === 1 &&
    hasClass(before as Element, 'MathJax_Preview') &&
    [...before.childNodes].every(isLayout)
  ) {
    before.parentNode?.removeChild(before);
  }

  script.parentNode?.removeChild(script);
}

function canonicalize(doc: Document, root: ParentNode & Node): void {
  // A TreeWalker steps rather than recurses, so the deep trees the readers
  // bound elsewhere cannot overflow the stack here; and a formula's own
  // subtree is rejected rather than walked, which is most of a KaTeX paste.
  const sources = new Map<Element, { tex: string; display: boolean }>();
  const walker = doc.createTreeWalker(root, SHOW_ELEMENT, {
    acceptNode: (node) => {
      const source = mathSourceOf(node as Element);

      if (!source) {
        return FILTER_SKIP;
      }

      sources.set(node as Element, source);
      return FILTER_REJECT;
    },
  });

  // Collected first: replacing a node mid-walk would leave the walker
  // standing on a detached one.
  while (walker.nextNode() !== null) {
    // Every match is rejected, so nothing is ever accepted.
  }

  for (const [element, source] of sources) {
    const replacement = doc.createElement(source.display ? 'div' : 'span');
    replacement.setAttribute(source.display ? MATH_BLOCK_ATTR : MATH_ATTR, source.tex);
    // The text is only for a reader that takes text and not the attribute --
    // a code block's -- and there an inline formula is its `$TeX$`, as a
    // formula moved into a code block is (`contentForType`).
    replacement.textContent = source.display ? source.tex : `$${source.tex}$`;

    const depth = element.getAttribute('data-neditor-depth');

    if (depth !== null) {
      replacement.setAttribute('data-neditor-depth', depth);
    }

    removeMathJaxParts(element);
    element.replaceWith(replacement);

    if (!source.display) {
      continue;
    }

    for (
      let parent = replacement.parentElement;
      parent !== null && LIFTABLE.has(tagOf(parent));
      parent = replacement.parentElement
    ) {
      if (![...parent.childNodes].every((child) => child === replacement || isLayout(child))) {
        break;
      }

      const lifted = parent.getAttribute('data-neditor-depth');

      if (lifted !== null && !replacement.hasAttribute('data-neditor-depth')) {
        replacement.setAttribute('data-neditor-depth', lifted);
      }

      parent.replaceWith(replacement);
    }
  }
}
