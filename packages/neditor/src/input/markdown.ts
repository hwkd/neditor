import type { Block, BlockType } from '../model/document.ts';
import { DEFAULT_CALLOUT_ICON, MAX_DEPTH, createBlock } from '../model/document.ts';
import type { TableRows } from '../model/table.ts';
import { normalizeTableRows } from '../model/table.ts';
import { sanitizeReadImageUrl, sanitizeReadUrl } from '../util/url.ts';
import type { RichText } from '../model/rich-text.ts';
import {
  MATH_ATOM,
  normalizeRuns,
  richConcat,
  richDelete,
  richFromPlainText,
  richInsert,
  richMath,
  richSetLink,
  richSetMark,
  richSlice,
  richSplit,
  richToPlainText,
} from '../model/rich-text.ts';
import type { DestinationAhead } from './inline-rules.ts';
import {
  CODE_DOLLAR,
  INLINE_SPAN_LIMIT,
  MARKDOWN_IMAGE,
  NO_BANG,
  matchInlineRule,
  projectCode,
} from './inline-rules.ts';
import { normalizeControlCharacters, normalizeLineBreaks } from './line-breaks.ts';

export { normalizeLineBreaks };

/**
 * Markdown → blocks, for pasted plain text.
 *
 * Our own copy writes Markdown to `text/plain`, and people paste Markdown from
 * files and other editors, so plain text is parsed rather than dropped in
 * verbatim. Each line becomes a block: predictable, and the same rule a reader
 * can hold in their head. Soft-wrapped prose therefore arrives as several
 * paragraphs.
 */

/**
 * Line prefixes, longest-first so `###` is not read as `#`.
 *
 * Each ends in `\s+|$`, not `\s+`: an empty block is a marker with nothing
 * after it, and a marker that needs a trailing space to be recognised is a
 * marker that any trailing-whitespace trim silently turns into a paragraph.
 */
const BLOCK_PREFIXES: ReadonlyArray<readonly [RegExp, BlockType]> = [
  [/^###(?:\s+|$)/, 'heading3'],
  [/^##(?:\s+|$)/, 'heading2'],
  [/^#(?:\s+|$)/, 'heading1'],
  // A to-do is a list item whose marker is a checkbox, so it wins over the list.
  [/^[-*+]\s+\[[ xX]\](?:\s+|$)/, 'todo'],
  [/^\[[ xX]\](?:\s+|$)/, 'todo'],
  [/^[-*+](?:\s+|$)/, 'bulleted_list'],
  [/^\d+[.)](?:\s+|$)/, 'numbered_list'],
  [/^>(?:\s+|$)/, 'quote'],
];

const DIVIDER = /^(?:-{3,}|\*{3,}|_{3,})$/;

/**
 * A setext heading's underline: `===` makes the line above it a first-level
 * heading, `---` a second. (One `-` is an empty list item, as it was.)
 */
const SETEXT_UNDERLINE = /^(?:=+|-{2,})$/;

/**
 * A callout is a quote whose first token is its bracketed icon.
 *
 * Reading any emoji-led quote as a callout was ambiguous in both directions: a
 * quote that legitimately opened with an emoji came back retyped, and an icon
 * outside the pictographic classes came back as a quote with the icon stuck to
 * the front of its text. The brackets say which one it is, and `toMarkdown`
 * escapes `[` in text, so no quote can imitate the marker.
 */
const CALLOUT_MARKER = /^\[!((?:\\.|[^\]\n\\])+)\](?:\s+|$)/;

/** The markers `toMarkdown` uses for a toggle, collapsed and expanded. */
const TOGGLE_MARKER = /^([\u25B8\u25BE])(?:\s+|$)/;

/**
 * A line that is nothing but an image.
 *
 * The destination comes in either form CommonMark allows, because a `)` in a
 * URL has to go inside angle brackets to survive; the alt text may carry
 * escapes, since a bare `]` would close the label early.
 */
const IMAGE_LINE = /^!\[((?:\\.|[^\]\n\\])*)\]\((?:<([^<>\n]*)>|((?:[^\s<][^\s]*)?))\)$/;

/** A GFM table row; the leading pipe is what identifies one. */
const TABLE_ROW = /^\|/;

/**
 * The `| --- | --- |` line, which is alignment rather than content.
 *
 * One hyphen is enough. GFM's delimiter cell is `-` repeated one or more times
 * with optional colons, and requiring three silently turned `| - | - |` -- the
 * spelling anyone typing a table by hand reaches for, and what several
 * generators emit -- into a paragraph of pipes.
 */
const TABLE_DIVIDER_CELL = /^:?-+:?$/;

/** Whether a destination's unescaped parentheses balance, never closing more than opened. */
function balancedParens(destination: string): boolean {
  let depth = 0;

  for (let at = 0; at < destination.length; at += 1) {
    const char = destination[at];

    if (char === '\\') {
      at += 1;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')' && --depth < 0) {
      return false;
    }
  }

  return depth === 0;
}

/**
 * The `<br>`s of a table cell or a heading as the line breaks they are.
 *
 * Both are one line in every reader, so the writer spells a break inside one
 * `<br>`, as GFM tables do. An escaped `\<br>` is text, so only a `<` preceded by an even run
 * of backslashes counts.
 */
function breaksFromHtml(cell: string): string {
  const code = codeSpans(cell);
  let span = 0;

  // Matched on the tag alone and counted back from it: a pattern that leads
  // with the backslashes is retried from each one of a long run.
  return cell.replace(/<br\s*\/?>/gi, (tag, offset: number) => {
    // Visited in order, so the lookup is a pointer that only moves on.
    while (span < code.length && code[span]![1] <= offset) {
      span += 1;
    }

    // Inside a backtick span it is code: `# The \`<br>\` element` shows it.
    if (span < code.length && code[span]![0] <= offset) {
      return tag;
    }

    let slashes = 0;

    while (cell.charCodeAt(offset - 1 - slashes) === 92) {
      slashes += 1;
    }

    return slashes % 2 === 0 ? '\n' : tag;
  });
}

/**
 * The `[start, end)` spans of backtick code in a line, in order: a run of
 * backticks not escaped, up to the next run of the same length.
 *
 * Each run is paired once, through the next run of its length, which a pointer
 * per length finds -- so a line of unpaired backticks is still one pass.
 */
function codeSpans(line: string): Array<readonly [number, number]> {
  if (!line.includes('`')) {
    return [];
  }

  const runs: Array<{ readonly at: number; readonly length: number }> = [];

  for (let at = 0; at < line.length; at += 1) {
    if (line[at] === '\\') {
      at += 1;
    } else if (line[at] === '`') {
      const start = at;

      while (line[at + 1] === '`') {
        at += 1;
      }

      runs.push({ at: start, length: at - start + 1 });
    }
  }

  const byLength = new Map<number, number[]>();

  runs.forEach((run, index) => {
    const list = byLength.get(run.length) ?? [];
    list.push(index);
    byLength.set(run.length, list);
  });

  const next = new Map<number, number>();
  const spans: Array<readonly [number, number]> = [];
  let after = -1;

  for (const [index, run] of runs.entries()) {
    if (run.at < after) {
      continue;
    }

    const list = byLength.get(run.length)!;
    let pointer = next.get(run.length) ?? 0;

    while (pointer < list.length && list[pointer]! <= index) {
      pointer += 1;
    }

    next.set(run.length, pointer);

    const closing = list[pointer];

    if (closing !== undefined) {
      const end = runs[closing]!.at + run.length;
      spans.push([run.at, end]);
      after = end;
    }
  }

  return spans;
}

/** Splits a GFM row on unescaped pipes and unescapes the rest. */
function splitTableRow(line: string): string[] {
  const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll('\\|', '|'));

  // A row is bounded by pipes, so the first and last pieces are empty.
  if (cells[0] === '') {
    cells.shift();
  }

  if (cells.at(-1) === '') {
    cells.pop();
  }

  return cells;
}

function isAlignmentLine(line: string | undefined): boolean {
  if (line === undefined) {
    return false;
  }

  const cells = splitTableRow(line);

  return cells.length > 0 && cells.every((cell) => TABLE_DIVIDER_CELL.test(cell));
}

function parseTableLines(lines: readonly string[]): TableRows {
  // A table is a header, a delimiter row, then the body. Without the delimiter
  // directly under the header these are just pipe characters in a paragraph,
  // and treating them as a table turned `---` placeholders into a row of
  // content — or, for a lone delimiter line, into a table of dashes.
  if (!isAlignmentLine(lines[1])) {
    return [];
  }

  const rows: TableRows = [];

  for (const [index, line] of lines.entries()) {
    const cells = splitTableRow(line);

    if (cells.length === 0) {
      continue;
    }

    // Only the row directly after the header is alignment. Anywhere else a row
    // of dashes is content — `---` is a common "no value" placeholder, and
    // dropping it silently deleted a row of the user's table.
    if (index === 1) {
      continue;
    }

    rows.push(cells.map((cell) => parseInlineMarkdown(breaksFromHtml(cell))));
  }

  return rows;
}
/**
 * An opening fence: three or more backticks, plus an optional info string.
 *
 * A backtick fence's info string may not hold a backtick (CommonMark), so
 * ```` ```npm install``` ```` on a line of its own -- the way chat apps write
 * inline code -- is a paragraph with a code span. Read as a fence it dropped
 * the line's text as an info string and made code of every line after it.
 */
const FENCE_OPEN = /^(?:(`{3,})(?![^\n]*`)|(~{3,})(?![^\n]*~))/;

/**
 * The run that opens a fence -- backticks, or CommonMark's tildes -- or null.
 * A tilde fence's info string holds no tilde either, unlike CommonMark's: a
 * line like `~~~a~~~` is struck-through text in every reader that strikes
 * through with three tildes, and read as a fence it made code of every line
 * after it. (The writer escapes every `~`, so it never writes one.)
 */
function fenceOpening(line: string): string | null {
  const match = FENCE_OPEN.exec(line);

  return match?.[1] ?? match?.[2] ?? null;
}

const CHECKED = /\[[xX]\]/;

/**
 * The length of the fence this line closes, or 0 for a line that closes none.
 *
 * A closing fence is backticks and nothing else, and at least as long as the
 * one that opened the block — otherwise ```` ``` ```` inside the code ends it
 * three lines early and one block comes back as three.
 */
function closingFenceLength(line: string, opening: string): number {
  const match = (opening.startsWith('~') ? /^(~{3,})\s*$/ : /^(`{3,})\s*$/).exec(line);

  return match?.[1]?.length ?? 0;
}

/**
 * Characters that can close an inline rule.
 *
 * Every rule is anchored at the caret, so a character that ends none of them
 * cannot complete a match and the scan can skip the rules entirely.
 */
const CLOSERS = new Set(['*', '_', '~', '`', '>', ')', '$']);

/**
 * How many runs a rule may reach back over once nothing is left open.
 *
 * Applying a match rebuilds the runs it can still reach, so without this a line
 * that is nothing but emphasis costs the square of the number of spans on it.
 *
 * It is a floor on what is kept rather than a ceiling: an opening delimiter
 * that has not closed yet holds the text back past this for as long as a rule
 * could still reach it. Cutting at a fixed number of runs lost every span that
 * wrapped more of them — the closing delimiter no longer had an opening one to
 * pair with, so the mark vanished and the `~~` or `<u>` was left sitting in the
 * visible text. That is the same defect as the length cap this replaced.
 */
const RUN_WINDOW = 32;

/**
 * Characters that can open an inline rule.
 *
 * A rule's opening delimiter is one of these, so a delimiter still present in
 * the matchable text is a span that may yet close. Delimiters are spliced out
 * the moment their rule fires, so what remains is exactly the still-open ones:
 * in ordinary prose, none at all.
 */
const OPENERS = new Set(['*', '_', '~', '`', '<', '[', '$']);

/**
 * Characters `escapeMarkdownText` protects, and which `\\` therefore makes literal.
 *
 * Deliberately not the toggle triangles, though a bullet whose text is one is
 * written escaped. Honouring `\▾` everywhere ate the backslash out of ordinary
 * prose, which no other reader does; it is honoured at the one place the writer
 * emits it, the head of a bullet, and nowhere else.
 */
const ESCAPABLE = /[\\`*_[\]~|<>#+\-.()!&=$]/;

/** What CommonMark lets a backslash escape: any ASCII punctuation character. */
const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/;
/** A backslash escape `ESCAPABLE` did not already take, in a destination. */
const DESTINATION_ESCAPE = /\\[!-/:-@[-`{-~]/;

/**
 * A numeric character reference, which the writer uses for whitespace at the
 * edge of a block (leading whitespace is indentation, and every reader trims
 * the rest). Decoded as CommonMark decodes it; an `&` that is meant literally
 * arrives escaped.
 */
const NUMERIC_REFERENCE = /^&#(?:(\d{1,7})|[xX]([0-9a-fA-F]{1,6}));/;

/**
 * Where references are decoded: a run at either edge of a block's text or at
 * the start of a line after a soft break, and nowhere else, because those are
 * the places the writer puts them (every reader strips leading whitespace from
 * a line, and trims a block). Decoding them everywhere corrupted foreign text --
 * a link destination holding `&#38;` came back with a NUL in it, and a pasted
 * code span holding `&#169;` came back as a copyright sign.
 */
const LINE_LEADING_REFERENCES = /(?:^|\n)((?:&#(?:\d{1,7}|[xX][0-9a-fA-F]{1,6});)+)/g;
const WHOLE_REFERENCE = /^&#(?:\d{1,7}|[xX][0-9a-fA-F]{1,6});$/;
/** The longest a reference can be: `&#` + seven digits + `;`. */
const REFERENCE_REACH = 10;

/**
 * Where the run of references that ends `text` starts, or -1 if none does.
 *
 * Walked back from the end one reference at a time. As a pattern ending in `$`
 * it was retried from every `&` in the line, and each try read a whole run
 * before failing: a long run of references in the middle of a line took a
 * second to parse.
 */
function trailingReferences(text: string, end: number): number {
  let start = end;

  for (;;) {
    const from = Math.max(0, start - REFERENCE_REACH);
    const at = text.slice(from, start).lastIndexOf('&');

    if (at === -1 || !WHOLE_REFERENCE.test(text.slice(from + at, start))) {
      break;
    }

    start = from + at;
  }

  return start === end ? -1 : start;
}

/** The closing tags the writer's HTML spelling of a mark ends in. */
const CLOSING_TAGS = ['</strong>', '</em>', '</s>', '</u>', '</code>'];

/** Where the closing tags that end `text` start: its length if there are none. */
function beforeClosingTags(text: string): number {
  let end = text.length;

  for (;;) {
    const tag = CLOSING_TAGS.find((candidate) => text.endsWith(candidate, end));

    if (!tag) {
      return end;
    }

    end -= tag.length;
  }
}

/** The `[start, end)` spans of `text` whose references are the writer's, in order. */
function decodableReferences(text: string): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];

  for (const match of text.matchAll(LINE_LEADING_REFERENCES)) {
    const run = match[1] ?? '';
    const start = match.index + match[0].length - run.length;
    spans.push([start, start + run.length]);
  }

  // The writer puts a block's last line break inside the tags of a run written
  // as HTML, so the end of the text is looked for behind any closing tags.
  const end = beforeClosingTags(text);
  const trailing = trailingReferences(text, end);

  // A run that is the whole of the last line is already there as a leading one.
  if (trailing !== -1 && spans.at(-1)?.[1] !== end) {
    spans.push([trailing, end]);
  }

  return spans;
}

/** The code point a {@link NUMERIC_REFERENCE} match names. */
function referenceCode(match: RegExpExecArray): number {
  return match[1] !== undefined ? Number(match[1]) : Number.parseInt(match[2] ?? '', 16);
}

function decodeReference(match: RegExpExecArray): string | null {
  const code = referenceCode(match);

  // A reference to a control character is that character, which the model
  // holds no more than it holds one typed: a line break, or nothing.
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
    ? normalizeControlCharacters(String.fromCodePoint(code))
    : null;
}

/**
 * Stands in for an escaped character while rules are matched.
 *
 * The projection stays the same length as the content, offset for offset, so a
 * rule's offsets apply to both — but a placeholder can never be read as a
 * delimiter, which is the whole point of the escape.
 */
const ESCAPED = '\u0000';

/**
 * Stands for an inline image while its line is read (`readInlineImages`): a
 * noncharacter, which no rule treats as punctuation, so the line around the
 * picture is read in one parse, as the HTML reader reads one (`IMAGE_ATOM`).
 */
const INLINE_IMAGE = MARKDOWN_IMAGE;

interface InlineImage {
  readonly src: string;
  readonly alt: string;
}

/**
 * A line that opens or closes a display equation: `$$` alone.
 *
 * Only alone. `$$` with TeX after it on the same line is Pandoc's spelling of
 * an equation that ends on a later line; the writer never emits it, and taking
 * it for a fence would swallow the lines after it whenever the closing `$$`
 * sits at the end of a line instead of on its own.
 */
const MATH_FENCE = /^\$\$[ \t]*$/;

function isMathFence(trimmedStart: string): boolean {
  return MATH_FENCE.test(trimmedStart);
}

/**
 * A display equation on one line, `$$TeX$$`, as other writers emit it.
 *
 * The body may not hold `$$` itself: `$$a$$ and $$b$$` is two inline-display
 * spans in a paragraph, not one equation running from the first to the last.
 */
const MATH_LINE = /^\$\$((?:(?!\$\$)[^\n])+)\$\$$/;

/**
 * True when a line ends in a soft break rather than a literal backslash.
 *
 * `escapeMarkdownText` doubles a literal backslash, so an odd number of
 * trailing backslashes is unambiguously the break marker it emits for `\n`.
 */
function endsWithSoftBreak(line: string): boolean {
  let count = 0;

  while (line.charCodeAt(line.length - 1 - count) === 92) {
    count += 1;
  }

  return count % 2 === 1;
}

/**
 * Rejoins lines the serializer split at a soft break.
 *
 * Skipped inside fenced code, where a trailing backslash is just source.
 */
function joinSoftBreaks(lines: readonly string[]): string[] {
  const out: string[] = [];
  // The lines of the block being joined, as they arrived. Collected and joined
  // once: appending each line to the block so far, and then asking that ever
  // longer string whether it ends in a break, was quadratic in a long
  // soft-broken paragraph.
  let pending: string[] = [];
  let fence = '';
  // A display equation's lines are TeX and pass through untouched, as a code
  // fence's do. An even run of backslashes at a line's end -- TeX's `\\` row
  // break -- would be left alone anyway; an odd one would not, and TeX ends a
  // line with one for a control space (`a\` then the line break).
  let math = false;

  const flush = (): void => {
    if (pending.length > 0) {
      const last = pending.length - 1;
      out.push(pending.map((line, index) => (index < last ? line.slice(0, -1) : line)).join('\n'));
      pending = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trimStart();

    if (math || (fence === '' && isMathFence(trimmed))) {
      math = !math || !isMathFence(trimmed);
      flush();
      out.push(line);
      continue;
    }

    if (fence !== '') {
      if (closingFenceLength(trimmed, fence) >= fence.length) {
        fence = '';
      }

      flush();
      out.push(line);
      continue;
    }

    const opening = fenceOpening(trimmed);

    if (opening !== null) {
      fence = opening;
      flush();
      out.push(line);
      continue;
    }

    const previous = pending.at(-1);

    if (previous === undefined || !endsWithSoftBreak(previous)) {
      flush();
    }

    pending.push(line);
  }

  flush();

  return out;
}

/** Removes backslash escapes without interpreting anything else. */
function stripEscapes(text: string): string {
  return text.replace(/\\(.)/g, (whole, char: string) => (ESCAPABLE.test(char) ? char : whole));
}

/**
 * For each caret in `text`, whether a link destination open there closes later
 * on the line -- the one thing the reader knows that typing does not.
 *
 * Built once, right to left, so each answer is a lookup: scanning forward at
 * every closing character instead made a long destination that never closes
 * cost its length squared. Characters are read as the reader reads them: an
 * escaped one is literal, never a parenthesis, bracket or whitespace, and a
 * numeric reference is spelled with none of those.
 */
function destinationsAhead(text: string): (caret: number) => DestinationAhead {
  const length = text.length;
  const escaped = new Uint8Array(length);

  for (let at = 0; at < length; at += 1) {
    if (text[at] === '\\' && at + 1 < length && ESCAPABLE.test(text[at + 1]!)) {
      escaped[at + 1] = 1;
      at += 1;
    }
  }

  const unbounded = 1 << 30;
  // The lowest the parenthesis depth falls, relative to the depth before `at`,
  // anywhere from `at` up to the next whitespace; `unbounded` at whitespace.
  const lowest = new Int32Array(length + 1);
  // Whether a `>)` follows `at` before any `<`, `>` or line break. Not before
  // whitespace: the angled form admits a space, and its rule reads one.
  const angled = new Uint8Array(length + 1);

  lowest[length] = unbounded;

  for (let at = length - 1; at >= 0; at -= 1) {
    const char = text[at]!;
    const literal = escaped[at] === 1;

    if (!literal && /\s/.test(char)) {
      lowest[at] = unbounded;
      angled[at] = char === '\n' ? 0 : angled[at + 1]!;
      continue;
    }

    const step = literal ? 0 : char === '(' ? 1 : char === ')' ? -1 : 0;

    lowest[at] = step + Math.min(0, lowest[at + 1]!);
    angled[at] = literal
      ? angled[at + 1]!
      : char === '<'
        ? 0
        : char === '>'
          ? Number(text[at + 1] === ')' && escaped[at + 1] === 0)
          : angled[at + 1]!;
  }

  return (caret) => ({
    angledCloses: () => angled[caret] === 1,
    // Open `depth` deep, the destination closes where the depth reaches -1.
    plainCloses: (depth) => lowest[caret]! <= -(depth + 1),
  });
}

/**
 * Applies inline rules to a whole string.
 *
 * Rather than a second grammar, this replays {@link matchInlineRule} over each
 * growing prefix — exactly what typing the text would have produced, so pasting
 * `**a**` and typing it cannot diverge. The one thing it adds is what only a
 * reader can know: whether a link destination open at the caret closes later
 * on the line. Typing holds one open, since the `)` may be the next key; a
 * reader that can see it never arrives reads the `](` as text, so
 * `**see [docs](x**` is bold, as it is in CommonMark.
 *
 * Plain text is buffered and folded into the runs only where a rule fires, the
 * rules are only tried on a character that could close one, and a match rebuilds
 * only the handful of runs around it — so the pass is linear in the length of
 * the line rather than quadratic. There used to be a length cap here instead,
 * past which a pasted paragraph kept its raw `**` markup.
 *
 * Runs already behind the caret are parked in `done` and pulled back out when a
 * span turns out to reach over them, rather than being written off at a fixed
 * count: a `~~`, an `<u>` or a link label wrapping any amount of formatting
 * still closes. Writing them off is what dropped the mark and left the raw
 * delimiters in the text.
 */
export function parseInlineMarkdown(source: string): RichText {
  return readInline(source);
}

/**
 * {@link parseInlineMarkdown}, and with `images` its image mode: each
 * `![alt](src)` the rules match, and whose source `sanitizeReadImageUrl`
 * takes, is written into the text as one `INLINE_IMAGE` and pushed onto
 * `images` (see `readInlineImages`).
 */
function readInline(source: string, images?: InlineImage[]): RichText {
  if (source.length === 0) {
    return [];
  }

  const text = normalizeControlCharacters(source);

  // Visited in order as `index` only grows, so the lookup is a moving pointer.
  const decodable = text.includes('&#') ? decodableReferences(text) : [];
  // Only a line with a `](` in it can hold a destination to look past.
  const ahead = text.includes('](') ? destinationsAhead(text) : undefined;
  let span = 0;

  // What a rule can still reach, plus the character of context the lookbehinds
  // need. Text before it is cut from `matchable` for good.
  const window = INLINE_SPAN_LIMIT + 1;

  /** Every run produced so far, in order, ahead of `content`. */
  const done: RichText = [];
  /**
   * The runs a match works on: the tail of the line, kept short so that
   * rebuilding it costs the span rather than the paragraph.
   */
  let content: RichText = [];
  /** Text not yet folded into runs. Always the very end of the line. */
  let pending = '';
  /** The line so far, with each escaped character replaced by {@link ESCAPED}. */
  let matchable = '';
  /** Offset into `matchable` at which `content` starts. */
  let base = 0;
  /**
   * How many of `done`'s trailing runs are still spelled out in `matchable`,
   * and so can be pulled back into `content`. Their text is exactly the first
   * `base` characters of it.
   */
  let recallable = 0;
  /**
   * Where the delimiters that could still open a span sit, ascending.
   *
   * A rule consumes its delimiters, so what is left here is the unmatched ones
   * — none at all in ordinary prose — and the earliest of them is as far back
   * as a later match can start, and so the furthest `retire` may cut.
   *
   * Offsets are counted from the front of `matchable` plus `origin`, the
   * characters `retire` has since cut off it, so cutting costs nothing here.
   * `openFrom` is where the live ones start: anything before it is out of
   * reach, and only waiting to be compacted away.
   */
  let opens: number[] = [];
  /**
   * Where each entry of `opens` stands in `text`, the raw source, index for
   * index with it. A formula's TeX is read from the source between its
   * dollars: the projection has already taken the backslash out of every
   * escape in it, and TeX needs them (`$a\_b$`, `$\|x\|$`).
   */
  let openSources: number[] = [];
  let openFrom = 0;
  let origin = 0;
  let retired = false;
  /**
   * Where a numeric reference stands that the writer put straight after a
   * formula's closing `$` to spell a digit, the one place outside a block's
   * edges it writes one (see `richToMarkdown`).
   */
  let afterFormula = -1;

  const flush = (): void => {
    if (pending.length > 0) {
      content = richConcat(content, richFromPlainText(pending));
      pending = '';
    }
  };

  /**
   * Applies to `opens` the splice just applied to `matchable`.
   *
   * Delimiters inside the removed range are gone — the rule that fired consumed
   * them — and everything after slides down by the width of the cut, so the
   * recorded offsets go on naming the same characters. Only the delimiters at
   * or past the match are looked at, which for an ordinary short span is a
   * handful; walking the whole list instead made a line of nothing but stray
   * delimiters cost the square of their number.
   */
  const spliceOpens = (start: number, end: number): void => {
    const from = start + origin;
    const to = end + origin;
    let first = opens.length;

    while (first > openFrom && opens[first - 1]! >= from) {
      first -= 1;
    }

    let write = first;

    for (let read = first; read < opens.length; read += 1) {
      const open = opens[read]!;

      if (open >= to) {
        opens[write] = open - (to - from);
        openSources[write] = openSources[read]!;
        write += 1;
      }
    }

    opens.length = write;
    openSources.length = write;
  };

  /** Where in the source the opening delimiter at `offset` of `matchable` is. */
  const sourceOf = (offset: number): number => {
    const target = offset + origin;

    for (let at = opens.length - 1; at >= openFrom; at -= 1) {
      if (opens[at] === target) {
        return openSources[at]!;
      }

      if (opens[at]! < target) {
        break;
      }
    }

    return -1;
  };

  /**
   * Forgets the delimiters in a range of `matchable` that can no longer open,
   * keeping `openSources` index for index with `opens`: left behind, every
   * later formula's TeX was read from the source of the wrong opener --
   * `` `x$`$y$ `` gave the formula `` `$y ``.
   */
  const dropOpens = (start: number, end: number): void => {
    const from = start + origin;
    const to = end + origin;
    let first = opens.length;

    while (first > openFrom && opens[first - 1]! >= from) {
      first -= 1;
    }

    let write = first;

    for (let read = first; read < opens.length; read += 1) {
      if (opens[read]! >= to) {
        opens[write] = opens[read]!;
        openSources[write] = openSources[read]!;
        write += 1;
      }
    }

    opens.length = write;
    openSources.length = write;
  };

  /**
   * Forgets the images read in a range of `matchable` that a span is about to
   * take as its own text: a formula's TeX, an image's alt text, which is the
   * inner pictures' alt text, as CommonMark reads it. They are the last ones
   * read, since the span ends at the caret.
   */
  const dropImagesIn = (start: number, end: number): InlineImage[] => {
    if (images === undefined || images.length === 0) {
      return [];
    }

    let count = 0;

    for (let at = matchable.indexOf(INLINE_IMAGE, start); at !== -1 && at < end;) {
      count += 1;
      at = matchable.indexOf(INLINE_IMAGE, at + 1);
    }

    return images.splice(images.length - count, count);
  };

  /**
   * Makes every `[` still open before `before` open nothing, as CommonMark
   * does once a link closes: links do not nest, so the inner one wins and
   * the outer brackets are text. The content keeps each `[`; the projection
   * reads it as an escaped one. Only a badge asks (see `readInlineImages`):
   * typing, which the reader otherwise replays, lets an outer link close
   * around an inner one.
   */
  const closeLabelsBefore = (before: number): void => {
    const limit = before + origin;
    let write = openFrom;
    let rebuilt = '';
    let copied = 0;

    for (let read = openFrom; read < opens.length; read += 1) {
      const open = opens[read]!;
      const at = open - origin;

      if (open < limit && matchable[at] === '[' && matchable[at - 1] !== '!') {
        rebuilt += matchable.slice(copied, at) + ESCAPED;
        copied = at + 1;
        continue;
      }

      opens[write] = open;
      openSources[write] = openSources[read]!;
      write += 1;
    }

    opens.length = write;
    openSources.length = write;

    if (copied > 0) {
      matchable = rebuilt + matchable.slice(copied);
    }
  };

  /**
   * Parks the runs a match is unlikely to touch, keeping `content` short.
   *
   * This is a layout, not a decision: {@link recall} brings any of them back,
   * so parking one can never cost a span the way discarding one did.
   */
  const park = (): void => {
    if (content.length <= RUN_WINDOW) {
      return;
    }

    for (const run of content.splice(0, content.length - RUN_WINDOW)) {
      done.push(run);
      recallable += 1;
      base += run.text.length;
    }
  };

  /** Brings parked runs back into `content` until it covers `offset`. */
  const recall = (offset: number): void => {
    if (base <= offset) {
      return;
    }

    // Popped newest-first, so the slice is reversed back into reading order
    // before it goes on the front.
    const back: RichText = [];

    while (base > offset && recallable > 0) {
      const run = done.pop()!;

      back.push(run);
      recallable -= 1;
      base -= run.text.length;
    }

    if (back.length > 0) {
      content = [...back.reverse(), ...content];
    }
  };

  /**
   * Cuts from the front of `matchable` the text no rule can reach any more.
   *
   * Only whole parked runs are cut, and `base` follows the cut, so `content`
   * goes on starting at offset `base`. Every rule is anchored at the caret and
   * rescanned per character, so a short `matchable` is what keeps each test
   * cheap; letting it run to the full span limit cost half again as much on a
   * line that is nothing but emphasis.
   *
   * An opening delimiter that has not closed is never cut past, whatever else
   * says otherwise — a rule has to see it to pair with it, and cutting one is
   * what silently dropped the mark of a span wrapping more runs than the
   * working window holds. The character in front of it is kept too, so the
   * lookbehinds read text rather than the cut. Once a delimiter is further back
   * than {@link INLINE_SPAN_LIMIT} no rule can reach it, and it stops holding
   * the text back.
   */
  const retire = (): void => {
    const reachable = origin + matchable.length - INLINE_SPAN_LIMIT;

    while (openFrom < opens.length && opens[openFrom]! < reachable) {
      openFrom += 1;
    }

    // Drop the out-of-reach prefix once it outweighs the rest, so the list
    // stays the size of what is really open.
    if (openFrom > 32 && openFrom * 2 > opens.length) {
      opens = opens.slice(openFrom);
      openSources = openSources.slice(openFrom);
      openFrom = 0;
    }

    const open = opens[openFrom];
    const barrier = open === undefined ? matchable.length : open - origin - 1;

    // A line with no finished span has nothing parked, so nothing below could
    // be cut and `matchable` grew to the whole line -- a rope flattened for
    // every closing character, which made one long line quadratic. Parking all
    // but the last window is layout as much as `park` is (the cut below still
    // stops at the barrier, and a rule never looks further back than the
    // window), and only done once it is twice the window, so each cut pays for
    // itself.
    if (recallable === 0 && matchable.length > 2 * window) {
      const target = matchable.length - window - base;

      if (target > 0) {
        flush();
        const [front, back] = richSplit(content, target);

        for (const run of front) {
          done.push(run);
          recallable += 1;
          base += run.text.length;
        }

        content = back;
      }
    }

    if (recallable === 0) {
      return;
    }
    let cut = 0;

    while (recallable > 0) {
      const length = done[done.length - recallable]!.text.length;

      if (cut + length > barrier) {
        break;
      }

      cut += length;
      recallable -= 1;
    }

    if (cut > 0) {
      matchable = matchable.slice(cut);
      base -= cut;
      origin += cut;
      retired = true;
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    const next = text[index + 1];
    let literal = char;
    let projected = char;

    // A backslash makes the next character literal: it goes into the content
    // but never into the string rules are matched against.
    if (char === '\\' && next !== undefined && ESCAPABLE.test(next)) {
      index += 1;
      literal = next;
      projected = ESCAPED;
    } else if (char === '&' && (decodable.length > 0 || index === afterFormula)) {
      // Visited in order, so the span lookup is a pointer that only moves on.
      while (span < decodable.length && decodable[span]![1] <= index) {
        span += 1;
      }

      const reference =
        index === afterFormula || (span < decodable.length && decodable[span]![0] <= index)
          ? NUMERIC_REFERENCE.exec(text.slice(index, index + 12))
          : null;
      const decoded = reference ? decodeReference(reference) : null;
      let spelled = reference?.[0].length ?? 0;

      // A CR LF spelled as two references is one line break, as the same two
      // characters are anywhere else: decoded one by one, each was a line
      // break of its own (R4-FMT-6b).
      if (reference && referenceCode(reference) === 13) {
        const after = index + spelled;
        const lineFeed =
          after < decodable[span]![1]
            ? NUMERIC_REFERENCE.exec(text.slice(after, after + 12))
            : null;

        if (lineFeed && referenceCode(lineFeed) === 10) {
          spelled += lineFeed[0].length;
        }
      }

      // A decoded reference is text, never a delimiter -- the same opacity an
      // escape gets, one placeholder per UTF-16 unit so offsets stay aligned.
      if (reference && decoded !== null) {
        index += spelled - 1;
        literal = decoded;
        projected = ESCAPED.repeat(decoded.length);
      }
    }

    // A `!` is an image's only where the source puts a `[` straight after
    // it, and that is decided here, from the source: in the projection a
    // closed span's delimiters are gone, so the `!` that ends `**Done!**` or
    // the label of `[Hi!](p)` stood straight before the next link's `[`, was
    // taken for its bang, lost from the text, and the link became a picture
    // (VX-1). Any other `!` is projected as {@link NO_BANG}, which nothing
    // reads as a bang; the content keeps the `!`, and no other rule has it
    // for a delimiter.
    if (projected === '!' && next !== '[') {
      projected = NO_BANG;
    }

    pending += literal;
    matchable += projected;

    if (OPENERS.has(projected)) {
      opens.push(origin + matchable.length - 1);
      openSources.push(index);
    }

    if (matchable.length > window) {
      retire();
    }

    if (!CLOSERS.has(projected)) {
      continue;
    }

    const match = matchInlineRule(matchable, {
      projection: true,
      ahead: ahead?.(index + 1),
      images: images !== undefined,
    });

    if (!match) {
      continue;
    }

    // The first retained character is the one place a lookbehind has nothing to
    // look at, so a span opening there is not trusted rather than guessed at.
    if (retired && match.start === 0) {
      continue;
    }

    // A formula replaces its whole span with one atom. Its TeX is the source
    // between the dollars, not the projection's version of it: there an escape
    // has lost its backslash, and a rule that fired inside the span -- `*b*`
    // in `$a*b*c$` -- has eaten its delimiters. The writer puts TeX between
    // the dollars exactly as it stands, so this is the inverse of that.
    if (match.math !== undefined) {
      // Pandoc's third condition, which typing cannot ask because the next
      // character has not arrived: a closing `$` is not followed by a digit,
      // so `$5-$10` and `US$10 to US$20` are prices, not a formula `5-`.
      if (/[0-9]/.test(text[index + 1] ?? '')) {
        continue;
      }

      const open = sourceOf(match.start);
      const formula = open === -1 ? [] : richMath(text.slice(open + 1, index));

      if (formula.length === 0) {
        continue;
      }

      flush();
      recall(match.start);
      afterFormula = index + 1;
      dropImagesIn(match.start, match.end);
      content = richInsert(
        richDelete(content, match.start - base, match.end - base),
        match.start - base,
        formula,
      );
      matchable = matchable.slice(0, match.start) + MATH_ATOM;
      spliceOpens(match.start, match.end);
      park();
      retire();
      continue;
    }

    const innerStart = match.start + match.openLength;
    const innerEnd = match.end - match.closeLength;

    if (innerEnd <= innerStart && !match.image) {
      continue;
    }

    flush();

    // The span may reach back over runs that were parked; they have to be in
    // `content` before its offsets mean anything there.
    recall(match.start);

    // The rule read the destination off the projection, where an escaped
    // character is a placeholder: `[x](https://a.test/a\_b)` linked to
    // `a%00b`. The content holds what the escape stands for, which is how
    // CommonMark reads a destination, so the href is taken from there -- and
    // only now, with the whole span recalled: a destination can hold more
    // finished code spans than are kept to hand, and read any earlier it was
    // whatever tail was left, which could name another host. A code span's
    // `$` is a placeholder there too, and the text may hold that character
    // itself: the content says which.
    let link = match.link;
    const tail = matchable.slice(innerEnd, match.end);

    // Which form the destination has is asked of the projection, never of the
    // content: there an escaped `<` is the `<` itself, so `[a](\<u@x.test)`
    // read as the angled form and lost a character at each end -- a link to
    // `https://u@x.tes/`, another host.
    //
    // A backslash before any other ASCII punctuation is that character too, in
    // a destination: CommonMark escapes all of it there, where in prose only
    // what the writer protects is honoured (see `ESCAPABLE`). Such a backslash
    // is still a backslash in the projection, so `?q=a\$b` kept it.
    //
    // And every destination is read as read content is (`sanitizeReadUrl`),
    // not as typed: the rule asked `sanitizeUrl`, which takes `README.md` for
    // a host. A destination it refuses leaves the whole span as text. An
    // image's source is read the same way, and asked of
    // `sanitizeReadImageUrl` instead.
    const destination = (): string => {
      let closing = tail;

      if (
        tail.includes(ESCAPED) ||
        tail.includes(NO_BANG) ||
        tail.includes(CODE_DOLLAR) ||
        DESTINATION_ESCAPE.test(tail)
      ) {
        const raw = richToPlainText(content).slice(innerEnd - base, match.end - base);
        closing = '';

        for (let at = 0; at < raw.length; at += 1) {
          if (!(tail[at] === '\\' && ASCII_PUNCTUATION.test(tail[at + 1] ?? ''))) {
            closing += raw[at];
          }
        }
      }

      return tail.startsWith('](<') ? closing.slice(3, -2) : closing.slice(2, -1);
    };

    // An image, in the image mode: one atom where it stood, and its alt text
    // as plain text -- the content its label was read to, as CommonMark
    // reads alt text, with any picture inside it forgotten.
    if (match.image) {
      const src = images && tail.startsWith('](') ? sanitizeReadImageUrl(destination()) : null;

      if (!src) {
        continue;
      }

      const inside = dropImagesIn(innerStart, innerEnd);
      let next = 0;
      const alt = richSlice(content, innerStart - base, innerEnd - base)
        .map((run) => (run.math === undefined ? run.text : `$${run.math}$`))
        .join('')
        .replaceAll(INLINE_IMAGE, () => inside[next++]?.alt ?? '');

      images!.push({ src, alt });
      content = richInsert(
        richDelete(content, match.start - base, match.end - base),
        match.start - base,
        richFromPlainText(INLINE_IMAGE),
      );
      matchable = matchable.slice(0, match.start) + INLINE_IMAGE;
      spliceOpens(match.start, match.end);
      park();
      retire();
      continue;
    }

    if (link !== undefined && tail.startsWith('](')) {
      // `![alt](src)` is an image, never `!` and a link to the picture: an
      // image the block reader did not take (see `readInlineImages`) stays
      // text, as the writer means it to, since it escapes a `!` before a link.
      if (matchable[match.start - 1] === '!') {
        continue;
      }

      const href = sanitizeReadUrl(destination());

      // Nothing has been changed yet: flushing and recalling only move runs.
      if (!href) {
        continue;
      }

      link = href;
    }

    // Strip the closing delimiter first, so the opening offsets stay valid —
    // and apply the identical splice to the projection to keep them aligned.
    content = richDelete(content, innerEnd - base, match.end - base);
    content = richDelete(content, match.start - base, innerStart - base);
    matchable = matchable.slice(0, innerEnd) + matchable.slice(match.end);
    matchable = matchable.slice(0, match.start) + matchable.slice(innerStart);
    spliceOpens(innerEnd, match.end);
    spliceOpens(match.start, innerStart);

    if (match.badge) {
      closeLabelsBefore(match.start);
    }

    const start = match.start - base;
    const end = start + (innerEnd - innerStart);

    if (link !== undefined) {
      content = richSetLink(content, start, end, link);
    } else if (match.mark) {
      content = richSetMark(content, start, end, match.mark, true);
    }

    // A code span is opaque from here on, as typing sees an existing code run
    // (`matchTypedInlineRule`): its text stays, but nothing in it opens or
    // closes another span. Left raw, a backtick inside ``a`b`` paired with the
    // next one and took the prose between into code.
    if (match.mark === 'code') {
      const innerLength = innerEnd - innerStart;

      matchable =
        matchable.slice(0, match.start) +
        projectCode(matchable.slice(match.start, match.start + innerLength)) +
        matchable.slice(match.start + innerLength);
      dropOpens(match.start, match.start + innerLength);
    }

    park();
    retire();
  }

  flush();

  return done.length > 0 ? richConcat(done, content) : content;
}

/** Leading indentation in columns: a space is one, a tab two. */
function columnsOf(line: string): number {
  // A tab after spaces is not indentation: the writer indents with spaces,
  // and `main` wrote a nested block's leading tab raw behind them, so counting
  // it put the next child a level too shallow. (The tab is trimmed from the
  // text, as it always was.) A line that starts with a tab is indented with
  // tabs.
  const leading = (line.startsWith('\t') ? /^[ \t]*/ : /^ */).exec(line)?.[0] ?? '';
  let spaces = 0;

  for (const char of leading) {
    spaces += char === '\t' ? 2 : 1;
  }

  return spaces;
}

/** A list item's marker, after its indentation. */
const LIST_ITEM_START = /^\s*(?:[-*+]|\d+[.)])(?:\s|$)/;

/**
 * Reads a block's depth from its indentation, relative to the blocks above it.
 *
 * A line is a child of the nearest block above it whose own indentation is at
 * least two columns less. That reads both what the writer emits now -- a child
 * at its parent's content column, which under `1. ` is three -- and what it
 * used to, two columns a level whatever the parent, at the same depths.
 */
function depthReader(): (line: string) => number {
  const open: Array<{ readonly column: number; readonly depth: number; readonly item: boolean }> =
    [];

  return (line) => {
    const column = columnsOf(line);

    // Two columns further in -- or, under anything but a list item, a level
    // deeper by two-columns-a-level: Markdown from `main` wrote a nested
    // paragraph's leading space raw, so a child of one sat a column short of
    // two more (`   b` then `    - c`). Not under a list item, whose child
    // sits at its content column: `1. Step` / `   - a` / `    - b` is two
    // siblings, as in CommonMark. A line indented with tabs is the exception:
    // its column counts each tab as two, an estimate a column either way, so
    // `\t\t- c` under `   - b` is its child although it reads a column short.
    const tabbed = line.startsWith('\t');
    const childOf = (parent: { readonly column: number; readonly item: boolean }): boolean =>
      column >= parent.column + 2 ||
      ((!parent.item || tabbed) && Math.floor(column / 2) > Math.floor(parent.column / 2));

    while (open.length > 0 && !childOf(open.at(-1)!)) {
      open.pop();
    }

    // With nothing above it to be a child of -- the first line of a pasted,
    // indented fragment -- it is two columns a level, as it always was.
    const parent = open.at(-1);
    const depth = parent ? parent.depth + 1 : Math.floor(column / 2);
    open.push({ column, depth, item: LIST_ITEM_START.test(line) });

    return depth;
  };
}

/**
 * A line's text read around the images inside it: the pieces between them,
 * in order, and the images, or null where the line holds none it can read.
 *
 * `![alt](src)` inside a line was read by the link rule, which took
 * `[alt](src)` and left the `!`: a README badge became "!" and a link to the
 * picture. The line is read in one parse in the reader's image mode
 * (`readInline`), where an image is a rule like any other: matched where a
 * link is, so with a link's precedence -- none inside a code span, an
 * autolink (`<https://a.test/![a](b.png)>` is one URL) or a link
 * destination, and one inside a formula is its TeX -- and written as one
 * `INLINE_IMAGE`, so a span around a picture (`*a ![x](y) b*`) is read where
 * it stands, as the HTML reader reads one; the result is cut at the atoms.
 * A source `sanitizeReadImageUrl` refuses leaves the image as text.
 *
 * A badge, `[![ci](b.png)](c)` -- a link whose label is pictures alone -- is
 * its pictures, whatever its destination reads as, as a linked `<img>` is:
 * left to the link rule, a destination it refuses (`LICENSE`, no host) kept
 * the span as text around the atom, "[", the picture and "](LICENSE)". Links
 * do not nest (CommonMark), so a badge inside another link's label is the
 * inner link: the outer `[` opens nothing, and its brackets and destination
 * stay text -- `[x [![a](b.png)](c)](d)` is "[x ", the picture and "](d)".
 * Only a badge closes the labels around it so: a link inside a link's label
 * is otherwise read as typing reads it, the outer link around the inner one.
 * Typing makes no picture at all: a typed `![a](https://…)` is a `!` and
 * a link to that address, the link rule's match, which only this reader refuses.
 */
function readInlineImages(line: string): {
  readonly pieces: RichText[];
  readonly images: InlineImage[];
} | null {
  if (!line.includes('![') || line.includes(INLINE_IMAGE)) {
    return null;
  }

  const images: InlineImage[] = [];
  const content = readInline(line, images);

  if (images.length === 0) {
    return null;
  }

  const plain = richToPlainText(content);
  const atoms: number[] = [];

  for (let at = plain.indexOf(INLINE_IMAGE); at !== -1; at = plain.indexOf(INLINE_IMAGE, at + 1)) {
    atoms.push(at);
  }

  // Every image read is an atom in the text, in order: a span that took one
  // as its own text forgot it (`dropImagesIn`). Should the two disagree, the
  // line is read as it was written rather than cut at the wrong place.
  if (atoms.length !== images.length) {
    return null;
  }

  const pieces: RichText[] = [];
  let start = 0;

  for (const at of [...atoms, plain.length]) {
    pieces.push(richSlice(content, start, at));
    start = at + 1;
  }

  return { pieces, images };
}

/** How much of `text`'s start (or end) is spaces, tabs and line breaks. */
function edgeSpace(text: string, end: boolean): number {
  const match = (end ? /[ \t\n]*$/ : /^[ \t\n]*/).exec(text);

  return match?.[0].length ?? 0;
}

/** `content` without the whitespace at its start and/or end. */
function trimRich(content: RichText, start: boolean, end: boolean): RichText {
  const plain = richToPlainText(content);
  const from = start ? edgeSpace(plain, false) : 0;
  const to = end ? plain.length - edgeSpace(plain.slice(from), true) : plain.length;

  return richSlice(content, from, Math.max(from, to));
}

/**
 * The number a Markdown or HTML ordered list's item was written with, which
 * the model cannot hold: it numbers consecutive items from 1
 * (`computeListNumbers`). `first` marks the first item of an HTML `<ol>`; a
 * Markdown list starts wherever the numbering does.
 */
export interface WrittenNumber {
  readonly marker: string;
  readonly value: number;
  readonly first?: boolean;
}

/**
 * Keeps the numbers a list was written with where the model would draw
 * others: every item of a list whose first item it would not draw with its
 * written number -- `5. five` / `6. six`, `<ol start="5">`, `1986. A great
 * year` -- becomes a paragraph that keeps its number as text, in place.
 * Renumbered, "step 5" after a note became "1.", and a dated line pasted into
 * a sentence lost its year. A list drawn as written -- from 1, or the writer's
 * `start`, which is the number it was drawn with -- stays a list. In place,
 * since a kept list is a run of paragraphs, which restart the numbering
 * after it as a list's own end does.
 */
export function keepWrittenNumbers(
  blocks: Block[],
  written: ReadonlyMap<Block, WrittenNumber>,
): void {
  if (written.size === 0) {
    return;
  }

  /** Per depth, the list open there: its count, or that its numbers are kept. */
  const counters = new Map<number, { count: number; keep: boolean }>();

  for (const block of blocks) {
    for (const depth of [...counters.keys()]) {
      if (block.type === 'numbered_list' ? depth > block.depth : depth >= block.depth) {
        counters.delete(depth);
      }
    }

    if (block.type !== 'numbered_list') {
      continue;
    }

    const number = written.get(block);
    let counter = counters.get(block.depth);

    if (counter === undefined || number?.first === true) {
      const drawn = (counter !== undefined && !counter.keep ? counter.count : 0) + 1;
      counter = { count: drawn, keep: number !== undefined && number.value !== drawn };
      counters.set(block.depth, counter);
    } else {
      counter.count += 1;
    }

    if (counter.keep && number !== undefined) {
      block.type = 'paragraph';
      block.content = richConcat(richFromPlainText(number.marker), block.content);
    }
  }
}

interface PrefixMatch {
  readonly type: BlockType;
  readonly rest: string;
  readonly checked: boolean;
}

function matchBlockPrefix(line: string): PrefixMatch | null {
  for (const [pattern, type] of BLOCK_PREFIXES) {
    const match = pattern.exec(line);

    if (match) {
      return {
        type,
        rest: line.slice(match[0].length),
        checked: type === 'todo' && CHECKED.test(match[0]),
      };
    }
  }

  return null;
}

/**
 * A fenced block's body, with the fence's own indentation taken off each line.
 *
 * The writer indents a nested code block's body as far as its fence, because
 * under a list item a line at the margin ends the item in every other reader.
 * Older versions wrote the body at the margin, and stripping from that would
 * eat the code's own leading spaces -- so the indentation comes off only when
 * every line that is not empty starts with it, which is the one shape the
 * writer has ever produced with an indented body.
 */
function unindentBody(lines: readonly string[], indent: string): string {
  // The fence's own indentation, as it is written -- spaces from this writer,
  // a tab from editors that indent lists with tabs. The writer leaves an empty
  // line empty and indents every other, so any line that does not start with
  // it is older output, whose body sat at the margin.
  if (indent !== '' && lines.every((line) => line === '' || line.startsWith(indent))) {
    return lines.map((line) => line.slice(Math.min(indent.length, line.length))).join('\n');
  }

  return lines.join('\n');
}

/** Parses Markdown text into blocks. Returns an empty list for blank input. */
export function blocksFromMarkdown(text: string): Block[] {
  const lines = joinSoftBreaks(normalizeControlCharacters(text).split('\n'));
  const blocks: Block[] = [];
  let fence: string[] | null = null;
  let fenceDepth = 0;
  /** The run that opened the fence: what closes it is the same, as long or longer. */
  let fenceOpen = '';
  let fenceIndent = '';
  /** The lines of an open `$$` display equation, as a code fence collects its own. */
  let math: string[] | null = null;
  let mathDepth = 0;
  let mathIndent = '';
  let table: string[] | null = null;
  let tableDepth = 0;
  const depthOf = depthReader();
  /** Each numbered item's marker, for `keepWrittenNumbers`. */
  const written = new Map<Block, WrittenNumber>();

  const flushTable = (): void => {
    if (!table) {
      return;
    }

    const collected = table;
    const rows = parseTableLines(collected);
    table = null;

    if (rows.length > 0) {
      const block = createBlock('table', [], tableDepth);
      block.rows = normalizeTableRows(rows);
      blocks.push(block);
      return;
    }

    // Not a table after all: give the lines back as text rather than consuming
    // them into nothing.
    for (const line of collected) {
      blocks.push(createBlock('paragraph', parseInlineMarkdown(line), tableDepth));
    }
  };

  /** The paragraph the line just read made, while the next could underline it. */
  let plainParagraph: { block: Block; source: string; column: number } | null = null;

  for (const raw of lines) {
    const trimmedStart = raw.trimStart();
    const above = plainParagraph;
    plainParagraph = null;

    // A display equation's lines are TeX, taken verbatim up to the closing
    // `$$` -- a row of `|` in a matrix is no table, and `\\` is no soft break.
    if (math) {
      if (isMathFence(trimmedStart)) {
        blocks.push(createBlock('math', unindentBody(math, mathIndent), mathDepth));
        math = null;
      } else {
        math.push(raw);
      }

      continue;
    }

    if (fence === null && isMathFence(trimmedStart)) {
      flushTable();
      math = [];
      mathDepth = depthOf(raw);
      mathIndent = raw.slice(0, raw.length - trimmedStart.length);
      continue;
    }

    // A run of pipe-led lines is one table, not one block per line.
    if (fence === null && TABLE_ROW.test(trimmedStart)) {
      if (table === null) {
        table = [];
        tableDepth = depthOf(raw);
      }

      table.push(trimmedStart);
      continue;
    }

    flushTable();

    if (fence) {
      // Only a fence at least as long as the opening one closes the block; a
      // shorter one, or one carrying an info string, is code.
      if (closingFenceLength(trimmedStart, fenceOpen) >= fenceOpen.length) {
        blocks.push(createBlock('code', unindentBody(fence, fenceIndent), fenceDepth));
        fence = null;
      } else {
        fence.push(raw);
      }

      continue;
    }

    const opening = fenceOpening(trimmedStart);

    if (opening !== null) {
      fence = [];
      fenceOpen = opening;
      fenceDepth = depthOf(raw);
      fenceIndent = raw.slice(0, raw.length - trimmedStart.length);
      continue;
    }

    const line = trimmedStart.trimEnd();

    // Blank lines only separate blocks; they do not become one.
    if (line.length === 0) {
      continue;
    }

    // A setext underline: the paragraph on the line just above is a heading,
    // as CommonMark reads it -- where it was a paragraph of `=` or, for `---`,
    // a divider under the paragraph. Only directly under a paragraph's own
    // line: the writer separates blocks with a blank line and escapes `=` and
    // `-` after a break, so it never writes one. Read before the depth, which
    // an underline has none of.
    if (above && SETEXT_UNDERLINE.test(line) && columnsOf(raw) <= above.column + 3) {
      above.block.type = line.startsWith('=') ? 'heading1' : 'heading2';
      above.block.content = parseInlineMarkdown(breaksFromHtml(above.source));
      continue;
    }

    const depth = depthOf(raw);
    const display = MATH_LINE.exec(line);

    if (display?.[1] && display[1].trim().length > 0) {
      blocks.push(createBlock('math', display[1].trim(), depth));
      continue;
    }

    // An image's caption follows it after a hard break, as `toMarkdown` writes
    // it -- which every other reader shows as the picture with its caption on
    // the line below.
    const breakAt = line.indexOf('\n');
    const image = IMAGE_LINE.exec(breakAt === -1 ? line : line.slice(0, breakAt));

    // A plain destination's parentheses have to balance, as a link's do;
    // `![a](b)(c)` is no image line.
    if (image && (image[3] === undefined || balancedParens(image[3]))) {
      // An empty destination is an image block with no picture yet -- the
      // writer's own spelling of one. Anything else has to be a usable source.
      const destination = image[2] ?? image[3] ?? '';
      const src = destination === '' ? '' : sanitizeReadImageUrl(stripEscapes(destination));

      if (src !== null) {
        const caption = breakAt === -1 ? '' : line.slice(breakAt + 1);
        const block = createBlock('image', parseInlineMarkdown(caption), depth);
        block.src = src;
        block.alt = stripEscapes(image[1] ?? '');
        blocks.push(block);
        continue;
      }
    }

    if (DIVIDER.test(line)) {
      blocks.push(createBlock('divider', [], depth));
      continue;
    }

    const prefix = matchBlockPrefix(line);
    let type = prefix?.type ?? 'paragraph';
    let rest = prefix?.rest ?? line;
    let icon: string | undefined;
    let collapsed: boolean | undefined;

    if (type === 'quote') {
      const callout = CALLOUT_MARKER.exec(rest);

      if (callout) {
        type = 'callout';
        icon = stripEscapes(callout[1] ?? '');
        rest = rest.slice(callout[0].length);
      }
    } else if (type === 'bulleted_list') {
      const toggle = TOGGLE_MARKER.exec(rest);

      if (toggle) {
        type = 'toggle';
        collapsed = toggle[1] === '\u25B8';
        rest = rest.slice(toggle[0].length);
      } else {
        // The one place `\▾` means an escape rather than a literal backslash,
        // because it is the one place the writer emits one — to keep a bullet
        // whose text opens with a triangle from reading as the toggle marker
        // just tested for. Honouring it everywhere ate real backslashes out of
        // ordinary text, and `\▾` is not an escape any other reader honours.
        rest = rest.replace(/^\\([\u25B8\u25BE])/, '$1');
      }
    }

    const source = type.startsWith('heading') ? breaksFromHtml(rest) : rest;
    const inline = readInlineImages(source);
    const imageBlocks = (inline?.images ?? []).map((image) => {
      const block = createBlock('image', [], depth);
      block.src = image.src;
      block.alt = image.alt;
      return block;
    });

    // A paragraph is cut at its pictures, each a block of its own between
    // the text before and after it, as the HTML reader cuts a `<p>`.
    if (inline && type === 'paragraph') {
      inline.pieces.forEach((piece, index) => {
        const text = trimRich(piece, index > 0, index < inline.pieces.length - 1);

        if (text.length > 0) {
          blocks.push(createBlock('paragraph', text, depth));
        }

        if (index < imageBlocks.length) {
          blocks.push(imageBlocks[index]!);
        }
      });
      continue;
    }

    // Any other block keeps its text whole, less the pictures, which follow
    // it -- inside it, as the HTML reader hands on an `<li>`'s, a quote's or
    // a toggle's, except after a heading, which holds no children. The space
    // a picture stood between is one space.
    let content: RichText;

    if (inline) {
      // Joined once, each piece read once for whether it ends in a space:
      // asked of the content so far, the join was quadratic in the pictures.
      // Flattened, never spread: a line can hold more pictures than a call
      // takes arguments.
      const parts: RichText[] = [];
      let joined = true;

      for (const piece of inline.pieces) {
        const part = joined ? trimRich(piece, true, false) : piece;
        const plain = richToPlainText(part);

        if (plain.length > 0) {
          parts.push(part);
          joined = /[ \t\n]$/.test(plain);
        }
      }

      content = trimRich(normalizeRuns(parts.flat()), false, true);
    } else {
      content = parseInlineMarkdown(source);
    }

    const block = createBlock(type, content, depth);

    if (!prefix && !inline) {
      plainParagraph = { block, source, column: columnsOf(raw) };
    }

    if (type === 'numbered_list' && prefix) {
      const marker = line.slice(0, line.length - prefix.rest.length);
      written.set(block, { marker, value: Number.parseInt(marker, 10) });
    }

    if (type === 'todo') {
      block.checked = prefix?.checked ?? false;
    }

    if (type === 'callout') {
      block.icon = icon ?? DEFAULT_CALLOUT_ICON;
    }

    if (type === 'toggle') {
      block.collapsed = collapsed ?? false;
    }

    blocks.push(block);

    const nests = !type.startsWith('heading');

    for (const image of imageBlocks) {
      image.depth = nests ? Math.min(depth + 1, MAX_DEPTH) : depth;
      blocks.push(image);
    }
  }

  flushTable();

  // An unterminated fence still yields its content.
  if (fence && fence.length > 0) {
    blocks.push(createBlock('code', unindentBody(fence, fenceIndent), fenceDepth));
  }

  // So does an unterminated equation -- and an empty one is still the
  // equation someone opened, which the writer spells `$$` + `$$` anyway.
  if (math) {
    blocks.push(createBlock('math', unindentBody(math, mathIndent), mathDepth));
  }

  keepWrittenNumbers(blocks, written);

  return blocks;
}
