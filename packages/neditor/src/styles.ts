/**
 * Styles ship as a string rather than a `.css` file on purpose: the package
 * then works in any web app, including a bare `<script type="module">`, with no
 * CSS loader, bundler plugin or build step on the consumer's side. Everything
 * is themable through the custom properties on `.neditor`, so overriding a
 * colour never requires editing this string.
 */
export const NEDITOR_STYLES = `
.neditor,
.neditor-portal {
  --neditor-font: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial,
    sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji';
  --neditor-font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  --neditor-text: rgb(55 53 47);
  /* Alphas chosen for contrast, not taste: 0.75 -> 5.6:1 and 0.70 -> 4.8:1
     on white. Muted colours real content (captions, completed to-dos), so it
     is the darker of the two. */
  --neditor-text-muted: rgb(55 53 47 / 0.75);
  --neditor-placeholder: rgb(55 53 47 / 0.7);
  --neditor-surface: transparent;
  --neditor-surface-raised: rgb(255 255 255);
  --neditor-border: rgb(55 53 47 / 0.09);
  --neditor-hover: rgb(55 53 47 / 0.06);
  /* Darkened from rgb(35 131 226): white on that was 3.9:1, below 4.5. */
  --neditor-accent: rgb(25 118 210);
  --neditor-on-accent: #ffffff;
  --neditor-code-bg: rgb(135 131 120 / 0.15);
  --neditor-code-text: rgb(185 50 45);
  --neditor-danger: rgb(212 76 71);
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
    --neditor-placeholder: rgb(255 255 255 / 0.55);
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
    --neditor-code-text: rgb(255 163 158);
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
  --neditor-placeholder: rgb(255 255 255 / 0.55);
  /* Opaque for the reason given in the prefers-color-scheme block. */
  --neditor-surface: rgb(25 25 25);
  --neditor-surface-raised: rgb(37 37 37);
  --neditor-border: rgb(255 255 255 / 0.11);
  --neditor-hover: rgb(255 255 255 / 0.06);
  --neditor-code-bg: rgb(255 255 255 / 0.1);
  --neditor-code-text: rgb(255 163 158);
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

.neditor-block__content:empty::before {
  content: attr(data-placeholder);
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
  padding: 0;
  font-family: var(--neditor-font-mono);
  font-size: 0.85em;
  line-height: 1.5;
  tab-size: 2;
}

/* -------------------------------------------------------------- callout -- */

.neditor-callout {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  flex: 1 1 auto;
  min-width: 0;
  padding: 0.75rem 1rem 0.75rem 0.75rem;
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

.neditor-block__icon:hover {
  background: var(--neditor-hover);
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

.neditor-image__trigger:disabled,
.neditor-image__placeholder:disabled {
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
  /* Anchored by its inline-end edge to where the block's text starts. */
  transform: translateX(-100%);
  opacity: 0;
  transition: opacity 100ms ease;
  pointer-events: none;
}

/* translateX is physical, so the direction has to be mirrored explicitly --
   and against the editor's own direction, not an ancestor's. Keyed off a bare
   [dir='rtl'] this matched an LTR editor sitting anywhere inside an RTL page,
   where inset-inline-start had already resolved to the left: the mirroring was
   applied to something unmirrored and dropped the drag handle on top of the
   first characters of every line. */
.neditor[dir='rtl'] .neditor-gutter,
[dir='rtl'] .neditor:not([dir]) .neditor-gutter {
  transform: translateX(100%);
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
  border: 1px solid var(--neditor-border);
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
  border: 1px solid var(--neditor-border);
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
  align-items: center;
  gap: 0.375rem;
  width: 22rem;
  max-width: calc(100vw - 2rem);
  padding: 0.375rem;
}

.neditor-link-editor__input {
  flex: 1 1 auto;
  min-width: 0;
  height: 1.875rem;
  padding: 0 0.5rem;
  border: 1px solid var(--neditor-border);
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
  .neditor-image-editor__input[data-invalid='true'] {
    forced-color-adjust: none;
    border-color: LinkText;
    outline: 2px solid LinkText;
  }

  .neditor-link-editor__error,
  .neditor-image-editor__error {
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

  /* forced-color-adjust inherits, so the opt-out above took the whole subtree
     with it: bullets and completed to-dos kept their author colour and were
     painted onto the system Highlight, at around 1.2:1. Only the block box
     itself opts out; everything inside it goes back to the system palette,
     where an unforced colour is dropped and HighlightText is inherited. */
  .neditor-block[data-selected='true'] * {
    forced-color-adjust: auto;
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
