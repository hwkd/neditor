import { isNode } from '../util/dom.ts';

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
 * `(tex, { displayMode }) => katex.renderToString(tex, { displayMode, throwOnError: false })`
 * -- but anything with this shape will do. It is called with TeX from the
 * document, which is untrusted: a string it returns is assigned as HTML, so it
 * must produce safe markup for any input (KaTeX does, unless `trust` is set).
 * A renderer that throws is caught, and the TeX is shown instead.
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
      // Shown as source below; a half-typed formula is not an error to report.
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
  for (const annotation of element.getElementsByTagName('annotation')) {
    if ((annotation.getAttribute('encoding') ?? '').toLowerCase() === 'application/x-tex') {
      return annotation.textContent ?? '';
    }
  }

  const math = tagOf(element) === 'MATH' ? element : element.getElementsByTagName('math')[0];

  return math?.getAttribute('alttext') ?? null;
}

/**
 * Whether markup is a formula, and if so its TeX and whether it is displayed.
 *
 * Recognised: the editor's own atom and clipboard spellings, KaTeX output
 * (`.katex`, `.katex-display`), a MathML `<math>`, and MediaWiki's
 * `.mwe-math-element`. Each foreign one only when it names its TeX: a formula
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

  const tag = tagOf(element);
  const katexDisplay = hasClass(element, 'katex-display');
  const katex = katexDisplay || hasClass(element, 'katex');
  const mediaWiki = hasClass(element, 'mwe-math-element');

  if (!katex && !mediaWiki && tag !== 'MATH') {
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
    (tag === 'MATH' && blockMath(element)) ||
    (mediaWiki && blockMath(element.getElementsByTagName('math')[0]));

  return { tex: tex.trim(), display };
}

/**
 * KaTeX's MathML half, where its TeX is gone and the HTML half beside it is
 * the formula as it was drawn.
 *
 * WebKit strips the `<annotation>` out of HTML put on the clipboard -- it is
 * never rendered -- so a KaTeX formula copied there arrives with no TeX to
 * recover. Read as text, both halves came through: `\frac{1}{2}` pasted as
 * `1221`. The MathML half is the copy for assistive technology, so it is the
 * one left out, and the formula reads as the glyphs the reader saw, once.
 */
export function isUnannotatedKatexMathml(element: Element): boolean {
  return hasClass(element, 'katex-mathml') && element.nextElementSibling !== null
    ? hasClass(element.nextElementSibling, 'katex-html')
    : false;
}

/** Text that is only layout: whitespace between the tags of pretty-printed HTML. */
function isLayout(node: Node): boolean {
  return node.nodeType === 8 || (node.nodeType === 3 && !/[^ \t\n\r\f]/.test(node.nodeValue ?? ''));
}

const SHOW_ELEMENT = 0x1;
const FILTER_REJECT = 2;
const FILTER_SKIP = 3;

/** Text any markup {@link mathSourceOf} recognises must contain. */
const MATH_HINT = /katex|<math|mwe-math|data-neditor-math/i;

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
    replacement.textContent = source.tex;

    const depth = element.getAttribute('data-neditor-depth');

    if (depth !== null) {
      replacement.setAttribute('data-neditor-depth', depth);
    }

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
