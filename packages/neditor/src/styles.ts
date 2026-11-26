/**
 * Styles ship as a string rather than a `.css` file on purpose: the package
 * then works in any web app, including a bare `<script type="module">`, with no
 * CSS loader, bundler plugin or build step on the consumer's side. Everything
 * is themable through the custom properties on `.neditor`, so overriding a
 * colour never requires editing this string.
 *
 * Annotated `string` rather than inferred. Without it the emitted declaration
 * gives this const the literal type of the whole stylesheet — 29k characters
 * that every consumer's compiler parses, and that a wrapper re-exporting it
 * copies verbatim into its own `.d.ts`, where it then goes stale.
 */
export const NEDITOR_STYLES: string = `
.neditor,
.neditor-portal {
  --neditor-font: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial,
    sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji';
  --neditor-font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  --neditor-text: rgb(55 53 47);
  /* Alphas chosen for contrast, not taste. Muted colours real content
     (captions, completed to-dos), so it stays the darker of the two. The
     placeholder is tuned on the worst ground it is drawn on, not on white: it
     was 0.70, which held on white but fell to 4.46:1 on the code block's tint,
     then 0.72, which held there but fell to 4.28:1 once a block selection's
     tint stacked under the code tint. 0.75 is 4.62:1 there and 5.6:1 on white;
     muted moved to 0.78 with it, so an empty caption still reads lighter than
     a written one. */
  --neditor-text-muted: rgb(55 53 47 / 0.78);
  --neditor-placeholder: rgb(55 53 47 / 0.75);
  --neditor-surface: transparent;
  --neditor-surface-raised: rgb(255 255 255);
  --neditor-border: rgb(55 53 47 / 0.09);
  --neditor-hover: rgb(55 53 47 / 0.06);
  /* Darkened from rgb(35 131 226): white on that was 3.9:1, below 4.5. Then
     again from rgb(25 118 210), which held 4.6:1 as the pressed toolbar glyph
     on white but 4.14:1 on the hover tint under the pointer that pressed it.
     This is 5.3:1 on white and 4.7:1 on the tint; every other use is a fill or
     an edge on a light ground, which only gains from it. */
  --neditor-accent: rgb(22 108 198);
  --neditor-on-accent: #ffffff;
  --neditor-code-bg: rgb(135 131 120 / 0.15);
  /* Measured where they are drawn, not on white: inline code sits on the code
     tint, and inside a callout on the tint stacked over the callout's own
     (rgb(185 50 45) was 4.49:1 there). In a selected block the selection tint
     is under both, where rgb(178 46 41) held only 4.52:1. The error text sits
     on a popover, and an equation's error on the code tint: rgb(212 76 71)
     was 4.26:1 on white and 3.6:1 there -- small text, below 4.5. */
  --neditor-code-text: rgb(174 44 39);
  --neditor-danger: rgb(185 50 45);
  --neditor-shadow: 0 0 0 1px rgb(15 15 15 / 0.05), 0 3px 6px rgb(15 15 15 / 0.1),
    0 9px 24px rgb(15 15 15 / 0.2);
  --neditor-indent: 1.5em;
  --neditor-gutter-width: 2.75em;
  --neditor-selection: rgb(35 131 226 / 0.16);
  --neditor-callout-bg: rgb(241 241 239);
  --neditor-table-border: rgb(55 53 47 / 0.16);
  --neditor-table-header-bg: rgb(247 247 245);

  box-sizing: border-box;
  color: var(--neditor-text);
  background: var(--neditor-surface);
  /* Positioning context for the gutter and the drop indicator. */
  position: relative;
  font-family: var(--neditor-font);
  /* Pinned, so the editor is the same size on every host -- and every size
     below is therefore in em, which resolves against this. They used to be
     rem, which resolves against the host's root instead: on the common
     62.5% root-font-size reset that made h2 and h3 render smaller than body
     text, and collapsed quotes to 10px and code to 8.5px. */
  font-size: 16px;
  line-height: 1.5;
  caret-color: var(--neditor-text);
  -webkit-font-smoothing: antialiased;
}

@media (prefers-color-scheme: dark) {
  .neditor:not([data-neditor-theme='light']),
  .neditor-portal:not([data-neditor-theme='light']) {
    --neditor-text: rgb(255 255 255 / 0.9);
    --neditor-text-muted: rgb(255 255 255 / 0.68);
    --neditor-placeholder: rgb(255 255 255 / 0.64);
    /* Opaque, unlike the light surface. The foregrounds above are all white,
       so a transparent surface means white text composited onto whatever the
       host happens to paint: on an ordinary light-only page the whole document
       renders at 1.00:1 and disappears. A widget that flips its own ink has to
       own the ground it flips it onto. Consumers who want it to blend can set
       --neditor-surface back to transparent, which now works from their own
       stylesheet -- see injectStyles. */
    --neditor-surface: rgb(25 25 25);
    --neditor-surface-raised: rgb(37 37 37);
    --neditor-border: rgb(255 255 255 / 0.11);
    --neditor-hover: rgb(255 255 255 / 0.06);
    --neditor-code-bg: rgb(255 255 255 / 0.1);
    /* The placeholder and inline code are tuned for a *selected* block, where
       the selection's blue tint lies under the code and callout tints and
       lightens the ground: at 0.55 and rgb(255 163 158) a selected empty code
       block's placeholder was 3.94:1 and inline code in a selected callout
       3.95:1. */
    --neditor-code-text: rgb(255 185 181);
    /* Re-tuned as a pair, because the accent is a *foreground* here — the
       active toolbar glyph — as well as the primary button's background. The
       light-mode blue reads 3.3:1 on the raised dark surface, so it is
       lightened to 6.4:1 and the ink on top of it inverted: white on a blue
       this light would be 2.4:1 under the checkmark and the button label. */
    --neditor-accent: rgb(110 170 250);
    --neditor-on-accent: rgb(23 23 23);
    --neditor-selection: rgb(35 131 226 / 0.3);
    --neditor-callout-bg: rgb(255 255 255 / 0.055);
    --neditor-table-border: rgb(255 255 255 / 0.14);
    --neditor-table-header-bg: rgb(255 255 255 / 0.04);
    --neditor-danger: rgb(255 115 105);
    --neditor-shadow: 0 0 0 1px rgb(0 0 0 / 0.2), 0 3px 6px rgb(0 0 0 / 0.3),
      0 9px 24px rgb(0 0 0 / 0.4);
  }
}

.neditor[data-neditor-theme='dark'],
.neditor-portal[data-neditor-theme='dark'] {
  --neditor-text: rgb(255 255 255 / 0.9);
  --neditor-text-muted: rgb(255 255 255 / 0.68);
  --neditor-placeholder: rgb(255 255 255 / 0.64);
  /* Opaque for the reason given in the prefers-color-scheme block. */
  --neditor-surface: rgb(25 25 25);
  --neditor-surface-raised: rgb(37 37 37);
  --neditor-border: rgb(255 255 255 / 0.11);
  --neditor-hover: rgb(255 255 255 / 0.06);
  --neditor-code-bg: rgb(255 255 255 / 0.1);
  --neditor-code-text: rgb(255 185 181);
  /* Kept in step with the prefers-color-scheme block above. */
  --neditor-accent: rgb(110 170 250);
  --neditor-on-accent: rgb(23 23 23);
  --neditor-selection: rgb(35 131 226 / 0.3);
  --neditor-callout-bg: rgb(255 255 255 / 0.055);
  --neditor-table-border: rgb(255 255 255 / 0.14);
  --neditor-table-header-bg: rgb(255 255 255 / 0.04);
  --neditor-danger: rgb(255 115 105);
  --neditor-shadow: 0 0 0 1px rgb(0 0 0 / 0.2), 0 3px 6px rgb(0 0 0 / 0.3),
    0 9px 24px rgb(0 0 0 / 0.4);
}

.neditor *,
.neditor *::before,
.neditor *::after,
.neditor-portal *,
.neditor-portal *::before,
.neditor-portal *::after {
  box-sizing: inherit;
}

/* ---------------------------------------------------------------- blocks -- */

.neditor-block {
  display: flex;
  align-items: flex-start;
  gap: 0.25rem;
  margin: 0.0625rem 0;
  /* The gutter reservation lives on the block, not the root: a host stylesheet
     with higher specificity would otherwise win and the controls would hang
     outside the editor. Set --neditor-gutter-width to 0 to reclaim the space. */
  /* Logical, not physical: these carry the gutter reservation and the whole
     nesting model, and under dir="rtl" the flex row already mirrors while a
     left padding would not.

     Two declarations rather than one calc adding them together. Summed, a
     host setting --neditor-gutter-width to 0 -- unitless, exactly as the README
     said to -- made the calc add a number to a length. That is invalid, and
     because it only becomes invalid after var() substitution it is
     invalid-at-computed-value-time, so the whole declaration was dropped and
     every level of nesting went flush. Apart, a bare 0 is a perfectly good
     padding and the indent is unaffected by it. */
  padding-inline-start: var(--neditor-gutter-width);
  margin-inline-start: calc(var(--neditor-depth, 0) * var(--neditor-indent));
  /* Positioning context for the selection bar, which is drawn as a
     pseudo-element rather than a border -- see [data-selected]. */
  position: relative;
  /* Both, now that the indent moved: the animation on indent and outdent is
     the margin's, and naming only the padding would have left it snapping. */
  transition:
    padding-inline-start 120ms ease,
    margin-inline-start 120ms ease;
}

.neditor-block__content {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 1.5em;
  margin: 0;
  padding: 0.1875rem 0.125rem;
  border: 0;
  outline: none;
  font: inherit;
  color: inherit;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: break-word;
}

/* Only on hosts that take typing. Generated content is part of an element's
   accessible name, so in a read-only document an empty caption named its
   figure "Add a caption" and an empty heading announced itself as "Heading 1"
   -- instructions to a reader who cannot act on them. The renderer writes
   contenteditable as true or false on every host, in both modes. Editable, it
   still named the figure after its own placeholder, so the text is given empty
   alternative text: drawn, never read as the element's name. The plain
   declaration comes first because a declaration fails whole -- an engine that
   rejects the slash syntax drops the second and keeps the first. */
.neditor-block__content[contenteditable='true']:empty::before {
  content: attr(data-placeholder);
  content: attr(data-placeholder) / '';
  color: var(--neditor-placeholder);
  pointer-events: none;
}

/* The command hint only nudges you on the block you are in. */
.neditor-block[data-block-type='paragraph'] .neditor-block__content:empty::before {
  opacity: 0;
  transition: opacity 80ms ease;
}

.neditor-block[data-block-type='paragraph'] .neditor-block__content:empty:focus::before {
  opacity: 1;
}

/* ------------------------------------------------------------- headings -- */

.neditor-block__content:is(h1, h2, h3) {
  font-weight: 600;
  line-height: 1.3;
}

.neditor-block[data-block-type='heading1'] {
  margin-top: 1.75rem;
}

.neditor-block[data-block-type='heading2'] {
  margin-top: 1.35rem;
}

.neditor-block[data-block-type='heading3'] {
  margin-top: 1rem;
}

.neditor-block__content:is(h1) {
  font-size: 1.875em;
}

.neditor-block__content:is(h2) {
  font-size: 1.5em;
}

.neditor-block__content:is(h3) {
  font-size: 1.25em;
}

/* ---------------------------------------------------------------- lists -- */

.neditor-block__marker {
  flex: 0 0 auto;
  min-width: 1.25rem;
  padding: 0.1875rem 0;
  text-align: end;
  color: var(--neditor-text);
  -webkit-user-select: none;
  user-select: none;
}

.neditor-block[data-block-type='bulleted_list'] .neditor-block__marker {
  font-size: 1.15em;
  line-height: 1.3;
}

/* ---------------------------------------------------------------- to-do -- */

.neditor-block__checkbox {
  flex: 0 0 auto;
  width: 1rem;
  height: 1rem;
  margin-block: 0.3125rem 0;
  margin-inline: 0.125rem 0.25rem;
  padding: 0;
  border: 1.25px solid var(--neditor-text-muted);
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
  transition: background-color 100ms ease, border-color 100ms ease;
}

.neditor-block__checkbox[aria-checked='true'] {
  position: relative;
  border-color: var(--neditor-accent);
  background: var(--neditor-accent);
}

/* Drawn with a mask so the tick takes its colour from a token. Baking
   stroke='white' into a background shorthand made it invisible the moment a
   consumer themed --neditor-accent to something light. */
.neditor-block__checkbox[aria-checked='true']::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--neditor-on-accent);
  mask: no-repeat center /
    0.75rem
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 8.5l3.5 3.5L13 5'/%3E%3C/svg%3E");
  -webkit-mask: no-repeat center /
    0.75rem
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 8.5l3.5 3.5L13 5'/%3E%3C/svg%3E");
}

.neditor-block[data-checked='true'] .neditor-block__content {
  color: var(--neditor-text-muted);
  text-decoration: line-through;
}

/* ------------------------------------------------------- quote and code -- */

.neditor-block__content:is(blockquote) {
  padding-inline-start: 0.875rem;
  border-inline-start: 3px solid currentColor;
  font-size: 1em;
}

.neditor-block__pre {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0.25rem 0;
  padding: 2rem 1rem 1rem;
  border-radius: 4px;
  background: var(--neditor-code-bg);
  position: relative;
}

.neditor-block__pre::before {
  /* Read from the element rather than written here, so the documented labels
     route reaches it. As a literal it was English on every page in every
     language, and a pseudo-element's content is not in the DOM for a consumer
     to translate afterwards either. */
  content: attr(data-neditor-code-label);
  position: absolute;
  top: 0.5rem;
  inset-inline-start: 1rem;
  font-family: var(--neditor-font);
  font-size: 0.75em;
  color: var(--neditor-text-muted);
}

.neditor-block__content:is(code) {
  display: block;
  /* Code is LTR whatever the prose around it is. Under dir="rtl" the block took
     the RTL base direction, and the bidi algorithm moved a line's trailing
     punctuation to the far end -- a string literal ending in "; read as ;" at
     the start. Set on the code element only, so the pre and its label keep
     the editor's direction and the label stays on the reading-start side.
     start, not left: it is the start of this box, which is now LTR. */
  direction: ltr;
  unicode-bidi: isolate;
  text-align: start;
  padding: 0;
  font-family: var(--neditor-font-mono);
  font-size: 0.85em;
  line-height: 1.5;
  tab-size: 2;
}

/* ----------------------------------------------------------------- math -- */

/* A display equation. Its TeX is the editable host and its picture the
   preview beside it; while it is being edited, or when nothing could draw
   it, the box looks like a code block and both show. */
.neditor-math-block {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0.25rem 0;
  padding: 0.5rem 1rem;
  border-radius: 4px;
  position: relative;
}

.neditor-math-block:focus-within,
.neditor-math-block:not([data-rendered='true']) {
  padding-top: 2rem;
  background: var(--neditor-code-bg);
}

.neditor-math-block:focus-within::before,
.neditor-math-block:not([data-rendered='true'])::before {
  content: attr(data-neditor-math-label);
  position: absolute;
  top: 0.5rem;
  inset-inline-start: 1rem;
  font-family: var(--neditor-font);
  font-size: 0.75em;
  color: var(--neditor-text-muted);
}

/* TeX reads left to right in every language. Under dir="rtl" its neutral
   characters -- plus, equals, a closing brace -- took the block's direction, and
   both the source and KaTeX's inline-block glyph boxes drew reordered; so the
   source, the pictures and the popover's field are isolated as LTR. */
.neditor-math-block > .neditor-block__content {
  direction: ltr;
  unicode-bidi: isolate;
  text-align: start;
  font-family: var(--neditor-font-mono);
  font-size: 0.85em;
  line-height: 1.5;
}

/* Out of sight, never out of reach: a hidden host could not take focus, and
   focusing it -- an arrow key, a click on the preview -- is what reveals it. */
.neditor-math-block[data-rendered='true']:not(:focus-within) > .neditor-block__content {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.neditor-math-block__preview {
  direction: ltr;
  unicode-bidi: isolate;
  overflow-x: auto;
  text-align: center;
}

/* A click on the picture is a click into the TeX -- while there is TeX to
   edit. Read-only it does nothing, and says so by not pointing. */
.neditor-math-block > .neditor-block__content[contenteditable='true'] + .neditor-math-block__preview {
  cursor: text;
}

.neditor-math-block__preview:empty {
  display: none;
}

.neditor-math-block:focus-within .neditor-math-block__preview {
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--neditor-border);
}

/* The renderer refused the TeX: said in words beside the source, which names
   it as its description. */
.neditor-math-block__error {
  margin: 0.5rem 0 0;
  font-size: 0.75em;
  color: var(--neditor-danger);
}

.neditor-math-block__error[hidden] {
  display: none;
}

/* An inline formula: one atom in the line, edited in its popover. */
.neditor-math {
  direction: ltr;
  unicode-bidi: isolate;
  border-radius: 3px;
}

/* The caret position after a formula that ends a block (see renderRichText):
   an empty image, drawn as nothing. */
.neditor-math__separator {
  display: inline;
  border: 0;
  margin: 0;
  padding: 0;
}

.neditor-block__content[contenteditable='true'] .neditor-math {
  cursor: pointer;
}

.neditor-block__content[contenteditable='true'] .neditor-math:hover {
  background: var(--neditor-hover);
}

/* -------------------------------------------------------------- callout -- */

.neditor-callout {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  flex: 1 1 auto;
  min-width: 0;
  /* Logical, so the wider side follows the reading direction in RTL too. */
  padding-block: 0.75rem;
  padding-inline: 0.75rem 1rem;
  border-radius: 4px;
  background: var(--neditor-callout-bg);
}

.neditor-block__icon {
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  font-family: var(--neditor-font);
  font-size: 1.125em;
  line-height: 1.35;
  cursor: pointer;
  -webkit-user-select: none;
  user-select: none;
}

.neditor-block__icon:hover:not(:disabled) {
  background: var(--neditor-hover);
}

/* Read-only: the picker will not open, so the icon is not offered as a control. */
.neditor-block__icon:disabled {
  color: inherit;
  cursor: default;
}

/* --------------------------------------------------------------- toggle -- */

.neditor-block__chevron {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 1.25rem;
  height: 1.5rem;
  margin-top: 0.1875rem;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--neditor-text-muted);
  cursor: pointer;
  transition: transform 120ms ease, background-color 80ms ease;
}

.neditor-block__chevron:hover {
  background: var(--neditor-hover);
  color: var(--neditor-text);
}

.neditor-block[data-block-type='toggle']:not([data-collapsed='true']) .neditor-block__chevron {
  transform: rotate(90deg);
}

/* ---------------------------------------------------------------- image -- */

.neditor-image {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
}

/* Positions the trigger over the picture rather than around it. */
.neditor-image__frame {
  position: relative;
  display: block;
  /* The only in-flow child is the img, and a src that fails to load has no
     intrinsic size -- so the frame collapsed to nothing and took the
     absolutely positioned edit button with it. A broken image then could not
     be fixed or removed with a mouse at all. */
  min-height: 2.5em;
}

.neditor-image__trigger {
  position: absolute;
  inset: 0;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: none;
  cursor: pointer;
}

/* The empty image's "Add an image" button has no disabled state to style: a
   read-only view does not draw it at all. */
.neditor-image__trigger:disabled {
  cursor: default;
}

.neditor-image__img {
  display: block;
  max-width: 100%;
  height: auto;
  border-radius: 4px;
}

.neditor-image__placeholder {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 1.25rem 1rem;
  border: 0;
  border-radius: 4px;
  background: var(--neditor-callout-bg);
  color: var(--neditor-text-muted);
  font: inherit;
  font-size: 0.875em;
  cursor: pointer;
}

.neditor-image__placeholder:hover {
  color: var(--neditor-text);
}

.neditor-block[data-block-type='image'] .neditor-block__content {
  padding-top: 0.375rem;
  font-size: 0.8125em;
  color: var(--neditor-text-muted);
}

/* ---------------------------------------------------------------- table -- */

.neditor-table {
  flex: 1 1 auto;
  min-width: 0;
  /* Wide tables scroll inside the block rather than stretching the page. */
  overflow-x: auto;
  margin: 0.25rem 0;
}

.neditor-table table {
  border-collapse: collapse;
  width: 100%;
}

.neditor-table :is(th, td) {
  min-width: 6rem;
  padding: 0;
  border: 1px solid var(--neditor-table-border);
  /* Logical, like every other alignment here: a physical left would park the
     text against the closing edge of every cell under dir="rtl". */
  text-align: start;
  vertical-align: top;
}

.neditor-table th {
  background: var(--neditor-table-header-bg);
  font-weight: 600;
}

.neditor-table .neditor-block__content {
  padding: 0.375rem 0.5rem;
  min-height: 1.75rem;
}

/* -------------------------------------------------------------- divider -- */

.neditor-block__divider {
  flex: 1 1 auto;
  margin: 0.5rem 0;
  border: 0;
  border-top: 1px solid var(--neditor-border);
}

/* ----------------------------------------------------------- slash menu -- */

.neditor-portal {
  position: fixed;
  z-index: 1000;
  box-sizing: border-box;
  border-radius: 6px;
  background: var(--neditor-surface-raised);
  box-shadow: var(--neditor-shadow);
  font-family: var(--neditor-font);
  font-size: 16px;
  line-height: 1.5;
  color: var(--neditor-text);
}

.neditor-portal[hidden] {
  display: none;
}

.neditor-slash-menu {
  width: 20em;
  /* As the other popovers: 20em is wider than a 320px screen. */
  max-width: calc(100vw - 2rem);
  max-height: 20rem;
  overflow: hidden;
}

.neditor-slash-menu__list {
  max-height: 20rem;
  overflow-y: auto;
  padding: 0.375rem;
}

.neditor-slash-menu__item {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.375rem 0.5rem;
  border-radius: 4px;
  cursor: pointer;
}

.neditor-slash-menu__item[data-active='true'] {
  background: var(--neditor-hover);
  /* The tint alone is 1.11:1 against the menu, and 1.4.11 asks 3:1 of a state
     indicator. An inset outline is symmetric, so it needs no mirroring. */
  outline: 2px solid var(--neditor-accent);
  outline-offset: -2px;
}

.neditor-slash-menu__icon {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  height: 2.5rem;
  border: 1px solid var(--neditor-border);
  border-radius: 4px;
  font-size: 0.8em;
  font-weight: 500;
}

.neditor-slash-menu__body {
  min-width: 0;
}

.neditor-slash-menu__label {
  font-size: 0.875em;
  font-weight: 500;
}

.neditor-slash-menu__description {
  font-size: 0.75em;
  color: var(--neditor-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ------------------------------------------------------------ live region -- */

/* Visually hidden but readable by assistive technology. */
.neditor-live-region {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* And not selectable: a range the reader draws in the page across the editor
   took in its last announcement, and Mod+C copied it with the blocks' text.
   Except under a drag across blocks, which makes the blocks' text
   unselectable: WebKit keeps a caret of its own under the pointer, at the
   nearest text it can select, and with none left in the editor it put that
   caret in the page after it or in a second editor's first block -- a
   Shift+click then extended from there over every block. */
.neditor:not([data-selecting='true']) .neditor-live-region {
  -webkit-user-select: none;
  user-select: none;
}

/* ----------------------------------------------------- block selection -- */

.neditor:focus {
  outline: none;
}

.neditor-block[data-selected='true'] {
  background: var(--neditor-selection);
  border-radius: 3px;
}

/* The selection bar. Not colour alone (1.4.1): it survives high-contrast modes
   and reads for anyone who cannot distinguish the tint from the page.

   Drawn as a pseudo-element rather than as a border, because a border takes
   space and the compensating outdent had to live somewhere. As its own
   margin-inline-start it overrode the depth indent that moved into that
   property, flattening a selected nested block; folded into the indent's calc
   it took the indent down with it whenever a host set a unitless value, and it
   was still missing from the gutter's own sum, which put the drag handle 2px
   inside the text of every selected block. Out of the box model, none of that
   arises. Logical inset, so it sits on the reading-start edge either way. */
.neditor-block[data-selected='true']::before {
  content: '';
  position: absolute;
  inset-block: 0;
  inset-inline-start: 0;
  width: 2px;
  border-radius: 3px 0 0 3px;
  background: var(--neditor-accent);
}

/* The native highlight would double up on the block overlay. */
.neditor-block[data-selected='true'] ::selection {
  background: transparent;
}

.neditor[data-dragging='true'] {
  cursor: grabbing;
}

.neditor[data-dragging='true'] .neditor-block__content,
.neditor[data-selecting='true'] .neditor-block__content {
  /* Once whole blocks are the unit, the browser must stop painting text over
     them as the pointer keeps moving. */
  -webkit-user-select: none;
  user-select: none;
}

/* ---------------------------------------------------------------- gutter -- */

.neditor-gutter {
  position: absolute;
  /* Placed by showFor() on the first hover. Until then an absolute box with
     no offset sits at its static position, below the last block, where it
     added scrollable overflow -- and the first hover took that away again,
     shrinking a host that ended with the editor so the click landed short.
     Both axes: with only the block one set, an RTL editor's gutter sat at
     its static inline position, half a gutter past the root's edge, and a
     phone-width page scrolled sideways until the first hover. One gutter
     width from the start edge, which the negative margin below takes back
     to the start edge itself -- inside the root, whatever the direction. */
  top: 0;
  inset-inline-start: var(--neditor-gutter-width);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.0625rem;
  /* Exactly the reserved width, so it never overhangs the editor. */
  width: var(--neditor-gutter-width);
  height: 1.75rem;
  /* The gap sits between the handle and the text, which is the inline-end side
     in both directions; a physical right puts it behind the handle in RTL. */
  padding-inline-end: 0.25rem;
  /* Anchored by its inline-end edge to where the block's text starts: the
     inset places its start edge there, and a negative start margin of its own
     width pulls it back. Logical, so the browser resolves the side from the
     gutter's real direction, however that was set. It used to be a physical
     translateX mirrored by selectors guessing the direction from [dir]
     attributes, which put the handle over the text of an LTR editor inside an
     LTR wrapper inside an RTL page, and never mirrored a CSS-only direction.
     A unitless 0 gutter width makes this calc invalid, which falls back to a
     0 margin -- the right answer for a gutter with no width. */
  margin-inline-start: calc(-1 * var(--neditor-gutter-width));
  opacity: 0;
  transition: opacity 100ms ease;
  pointer-events: none;
}

.neditor-gutter[data-visible='true'] {
  opacity: 1;
  pointer-events: auto;
}

.neditor-gutter__button {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 1.25rem;
  height: 1.5rem;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--neditor-text-muted);
  cursor: pointer;
  transition: background-color 80ms ease, color 80ms ease;
}

.neditor-gutter__button:hover {
  background: var(--neditor-hover);
  color: var(--neditor-text);
}

.neditor-gutter__handle {
  cursor: grab;
  /* The browser would otherwise claim a touch drag for scrolling and cancel
     the gesture before it starts. */
  touch-action: none;
}

.neditor-gutter[data-dragging='true'] .neditor-gutter__handle {
  cursor: grabbing;
  background: var(--neditor-hover);
  color: var(--neditor-text);
}

.neditor-drop-indicator {
  position: absolute;
  inset-inline: 0;
  height: 2px;
  margin-top: -1px;
  border-radius: 1px;
  background: var(--neditor-accent);
  pointer-events: none;
}

.neditor-drop-indicator[hidden] {
  display: none;
}

/* --------------------------------------------------------- inline marks -- */

/* Descendant selector only: a code *block* is itself .neditor-block__content. */
.neditor-block__content code {
  /* LTR and isolated, like the code block, and for the same reason: measured
     in an RTL paragraph, foo(bar); rendered as ;foo(bar), its trailing
     semicolon taken by the surrounding RTL text. */
  direction: ltr;
  unicode-bidi: isolate;
  padding: 0.15em 0.35em;
  border-radius: 3px;
  background: var(--neditor-code-bg);
  color: var(--neditor-code-text);
  font-family: var(--neditor-font-mono);
  font-size: 0.85em;
}

.neditor-block__pre code {
  padding: 0;
  background: none;
  color: inherit;
  font-size: 0.85em;
}

.neditor-link {
  color: inherit;
  text-decoration: underline;
  text-decoration-color: var(--neditor-text-muted);
  text-underline-offset: 2px;
  cursor: pointer;
}

.neditor-link:hover {
  text-decoration-color: var(--neditor-text);
}

/* ------------------------------------------------------ format toolbar -- */

.neditor-toolbar {
  display: flex;
  align-items: stretch;
  gap: 0.125rem;
  padding: 0.25rem;
}

.neditor-toolbar__button {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 1.875rem;
  height: 1.875rem;
  padding: 0 0.4rem;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--neditor-text);
  font-family: inherit;
  font-size: 0.875em;
  cursor: pointer;
  transition: background-color 80ms ease, color 80ms ease;
}

.neditor-toolbar__button:hover {
  background: var(--neditor-hover);
}

.neditor-toolbar__button[data-active='true'] {
  color: var(--neditor-accent);
  /* Not a hue alone: the accent is 2.33:1 against the unpressed ink (1.97:1
     dark), under 1.4.11's 3:1. A bar under the glyph is a change of shape. */
  box-shadow: inset 0 -2px 0 var(--neditor-accent);
}

.neditor-toolbar__button[data-mark='bold'] {
  font-weight: 700;
}

.neditor-toolbar__button[data-mark='italic'] {
  font-family: Georgia, 'Times New Roman', serif;
  font-style: italic;
}

.neditor-toolbar__button[data-mark='underline'] {
  text-decoration: underline;
  text-underline-offset: 2px;
}

.neditor-toolbar__button[data-mark='strikethrough'] {
  text-decoration: line-through;
}

.neditor-toolbar__button[data-mark='code'] {
  font-family: var(--neditor-font-mono);
  font-size: 0.7em;
}

.neditor-toolbar__separator {
  width: 1px;
  margin: 0.25rem 0.25rem;
  background: var(--neditor-border);
}

/* --------------------------------------------------------- icon picker -- */

.neditor-icon-picker {
  width: 15rem;
  padding: 0.5rem;
}

.neditor-icon-picker__grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 0.125rem;
  margin-bottom: 0.375rem;
}

.neditor-icon-picker__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  font-size: 1em;
  line-height: 1;
  cursor: pointer;
}

.neditor-icon-picker__icon:hover {
  background: var(--neditor-hover);
}

.neditor-icon-picker__input {
  width: 100%;
  height: 1.75rem;
  padding: 0 0.5rem;
  /* The muted ink, as for the to-do box: the divider border is 1.17:1, and
     1.4.11 asks 3:1 of the edge that shows where a field is. */
  border: 1px solid var(--neditor-text-muted);
  border-radius: 4px;
  background: transparent;
  color: var(--neditor-text);
  font: inherit;
  /* 16px, not 13. iOS Safari zooms the page in when a focused input
     computes under 16px, and does not zoom back out when it blurs. */
  font-size: 1em;
  outline: none;
}

.neditor-icon-picker__input:focus {
  border-color: var(--neditor-accent);
}

/* -------------------------------------------------------- table toolbar -- */

.neditor-table-toolbar {
  display: flex;
  align-items: stretch;
  gap: 0.125rem;
  padding: 0.25rem;
}

.neditor-table-toolbar__button {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 1.75rem;
  padding: 0 0.5rem;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--neditor-text);
  font-family: inherit;
  font-size: 0.75em;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 80ms ease;
}

.neditor-table-toolbar__button:hover {
  background: var(--neditor-hover);
}

/* --------------------------------------------------------- image editor -- */

.neditor-image-editor {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  width: 22rem;
  max-width: calc(100vw - 2rem);
  padding: 0.5rem;
}

.neditor-image-editor__input {
  width: 100%;
  height: 1.875rem;
  padding: 0 0.5rem;
  /* The muted ink, as for the to-do box: the divider border is 1.17:1, and
     1.4.11 asks 3:1 of the edge that shows where a field is. */
  border: 1px solid var(--neditor-text-muted);
  border-radius: 4px;
  background: transparent;
  color: var(--neditor-text);
  font: inherit;
  /* 16px, not 13. iOS Safari zooms the page in when a focused input
     computes under 16px, and does not zoom back out when it blurs. */
  font-size: 1em;
  outline: none;
}

.neditor-image-editor__input:focus {
  border-color: var(--neditor-accent);
}

.neditor-image-editor__input[data-invalid='true'] {
  border-color: var(--neditor-danger);
}

.neditor-image-editor__actions {
  display: flex;
  gap: 0.375rem;
}

/* --------------------------------------------------------- link editor -- */

.neditor-link-editor {
  display: flex;
  /* Wraps so the error, at flex-basis 100%, takes a line of its own. Without
     it the error was squeezed between the input and Apply and clipped. */
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem;
  width: 22rem;
  max-width: calc(100vw - 2rem);
  padding: 0.375rem;
}

.neditor-link-editor__input {
  /* A zero basis, so the input takes what Apply and Remove leave rather than
     asking for its intrinsic width first. At auto that width was the basis,
     and in a wrapping row the input dropped to a line of its own at 320px.
     The error, at 100%, is the only thing meant to wrap. */
  flex: 1 1 0;
  min-width: 0;
  height: 1.875rem;
  padding: 0 0.5rem;
  /* The muted ink, as for the to-do box: the divider border is 1.17:1, and
     1.4.11 asks 3:1 of the edge that shows where a field is. */
  border: 1px solid var(--neditor-text-muted);
  border-radius: 4px;
  background: transparent;
  color: var(--neditor-text);
  font: inherit;
  /* 16px, not 13. iOS Safari zooms the page in when a focused input
     computes under 16px, and does not zoom back out when it blurs. */
  font-size: 1em;
  outline: none;
}

.neditor-link-editor__input:focus {
  border-color: var(--neditor-accent);
}

/* The rejection, said rather than only coloured. Hidden until it applies, so
   the dialog does not carry a standing error message. */
.neditor-link-editor__error,
.neditor-image-editor__error {
  margin: 0.25rem 0 0;
  flex-basis: 100%;
  /* Below the buttons rather than between the input and Apply. The reading
     order does not matter here: the field names it through aria-describedby. */
  order: 1;
  font-size: 0.75em;
  color: var(--neditor-danger);
}

.neditor-link-editor__input[data-invalid='true'] {
  border-color: var(--neditor-danger);
}

.neditor-link-editor__button {
  flex: 0 0 auto;
  height: 1.875rem;
  padding: 0 0.625rem;
  border: 0;
  border-radius: 4px;
  background: var(--neditor-accent);
  color: var(--neditor-on-accent);
  font: inherit;
  font-size: 0.8125em;
  cursor: pointer;
}

.neditor-link-editor__button--remove {
  background: transparent;
  color: var(--neditor-text-muted);
}

.neditor-link-editor__button--remove:hover {
  background: var(--neditor-hover);
  color: var(--neditor-text);
}

.neditor-link-editor__button[hidden] {
  display: none;
}

/* ------------------------------------------------------- math editor -- */

.neditor-math-editor {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem;
  width: 24rem;
  max-width: calc(100vw - 2rem);
  padding: 0.375rem;
}

.neditor-math-editor__input {
  direction: ltr;
  font-family: var(--neditor-font-mono);
}

/* The picture of the TeX being typed, on a line of its own under the field. */
.neditor-math-editor__preview {
  direction: ltr;
  unicode-bidi: isolate;
  order: 1;
  flex-basis: 100%;
  min-width: 0;
  padding: 0.25rem 0.5rem;
  overflow-x: auto;
  text-align: center;
}

.neditor-math-editor__preview[hidden] {
  display: none;
}

/* ------------------------------------------------------------ focus ring -- */

/* Every control the keyboard can now reach needs a visible focus indicator. */
.neditor-block__chevron:focus-visible,
.neditor-block__icon:focus-visible,
.neditor-block__checkbox:focus-visible,
.neditor-image__trigger:focus-visible,
.neditor-gutter__button:focus-visible,
.neditor-portal button:focus-visible {
  outline: 2px solid var(--neditor-accent);
  outline-offset: 2px;
}

.neditor-block__content:focus-visible {
  /* The caret is the indicator inside text; an outline here would fight it. */
  outline: none;
}

/* ---------------------------------------------------------- forced colors -- */

@media (forced-colors: active) {
  /* System colours replace the palette, so the tint-based cues vanish. These
     restate every state in terms the mode keeps. */
  .neditor-link-editor__input[data-invalid='true'],
  .neditor-image-editor__input[data-invalid='true'],
  .neditor-math-editor__input[data-invalid='true'] {
    forced-color-adjust: none;
    border-color: LinkText;
    outline: 2px solid LinkText;
  }

  .neditor-link-editor__error,
  .neditor-image-editor__error,
  .neditor-math-block__error {
    forced-color-adjust: none;
    color: LinkText;
  }

  .neditor-block[data-selected='true'] {
    forced-color-adjust: none;
    background: Highlight;
    color: HighlightText;
    box-shadow: none;
    outline: 2px solid Highlight;
  }

  /* The bar inherits the opt-out from the block, so its author colour would be
     kept and painted onto the system Highlight. A system colour instead. */
  .neditor-block[data-selected='true']::before {
    background: HighlightText;
  }

  /* forced-color-adjust inherits, so the opt-out above takes the whole subtree
     with it, and neither way out of that is safe on its own. Left inherited,
     bullets and completed to-dos kept their author colour and were painted
     onto the system Highlight at around 1.2:1. Handed back with auto, Chromium
     drew its readability backplate -- Canvas, white -- behind every run of
     text, while the text still inherited HighlightText, also white: the
     selected block went blank. So the subtree stays opted out and every colour
     in it is stated in system terms, which reads the same with a backplate or
     without one (Firefox has none). The content element is named as well,
     because the completed to-do rule outranks a bare star; the pseudo-elements
     because they carry the placeholder and the code block's label. */
  .neditor-block[data-selected='true'] *,
  .neditor-block[data-selected='true'] *::before,
  .neditor-block[data-selected='true'] *::after,
  .neditor-block[data-selected='true'] .neditor-block__content,
  .neditor-block[data-selected='true'] .neditor-block__content::before {
    forced-color-adjust: none;
    color: HighlightText;
    background-color: transparent;
    border-color: HighlightText;
    text-decoration-color: HighlightText;
  }

  /* The star above cleared the box's fill, so a checked box is restated
     inverted: a HighlightText square with a Highlight tick. */
  .neditor-block[data-selected='true'] .neditor-block__checkbox[aria-checked='true'] {
    background-color: HighlightText;
  }

  .neditor-block[data-selected='true'] .neditor-block__checkbox[aria-checked='true']::after {
    background-color: Highlight;
  }

  /* Each of these was bounded by nothing but a tint, and forced colours
     replace every tint with Canvas. The "Add an image" button is one too. */
  .neditor-callout,
  .neditor-block__pre,
  .neditor-block__content code,
  .neditor-image__placeholder {
    border: 1px solid CanvasText;
  }

  .neditor-slash-menu__item[data-active='true'],
  .neditor-toolbar__button[data-active='true'] {
    outline: 2px solid Highlight;
  }

  .neditor-portal {
    border: 1px solid CanvasText;
  }

  .neditor-block__checkbox {
    border-color: CanvasText;
  }

  .neditor-block__checkbox[aria-checked='true'] {
    background: Highlight;
  }

  .neditor-block__checkbox[aria-checked='true']::after {
    background: HighlightText;
  }

  .neditor-drop-indicator {
    background: Highlight;
  }
}

@media (prefers-reduced-motion: reduce) {
  .neditor *,
  .neditor-portal * {
    transition: none !important;
  }
}
`;

const STYLE_MARKER = 'data-neditor-styles';

/**
 * Where a style element for this node belongs.
 *
 * A shadow tree does not inherit the document's stylesheets, so a style added
 * to `document.head` leaves an editor inside a custom element completely
 * unstyled. `getRootNode()` lands in the right tree either way.
 */
function styleRootFor(node: Node): Document | ShadowRoot {
  const root = node.getRootNode();

  // A ShadowRoot accepts a <style> child directly; a Document needs its head.
  return 'host' in root ? (root as ShadowRoot) : (node.ownerDocument ?? (root as Document));
}

/**
 * Injects {@link NEDITOR_STYLES} once per root. Repeat calls are no-ops, so
 * mounting many editors on a page still yields a single style element.
 *
 * The element goes *first* in its container, so the page's own stylesheet comes
 * after it and wins on equal specificity. That is what makes the documented
 * `.neditor { --neditor-*: ... }` theming recipe work; appending it last meant
 * the package silently overrode every consumer theme.
 *
 * `nonce` is forwarded to the `<style>` element, which a `style-src` policy
 * without `'unsafe-inline'` requires — otherwise the editor renders unstyled.
 */
export function injectStyles(node: Document | ShadowRoot | Element, nonce?: string): void {
  const root = 'getRootNode' in node && !('head' in node) ? styleRootFor(node as Node) : node;
  const container = 'head' in root ? (root as Document).head : (root as ShadowRoot);

  if (container.querySelector(`style[${STYLE_MARKER}]`)) {
    return;
  }

  const doc = 'createElement' in root ? (root as Document) : (root as ShadowRoot).ownerDocument;
  const style = doc.createElement('style');
  style.setAttribute(STYLE_MARKER, '');

  if (nonce) {
    style.setAttribute('nonce', nonce);
  }

  style.textContent = NEDITOR_STYLES;
  // First, not last. Appending put the package sheet after the consumer's own,
  // so `.neditor { --neditor-accent: ... }` -- the recipe the README gives --
  // lost every tie on equal specificity and silently did nothing. A library
  // stylesheet is a default: it goes first and is overridden by the page.
  container.prepend(style);
}
