import type { Block, BlockType } from '../model/document.ts';
import { DEFAULT_CALLOUT_ICON, createBlock } from '../model/document.ts';
import type { TableRows } from '../model/table.ts';
import { normalizeTableRows } from '../model/table.ts';
import { sanitizeImageUrl } from '../util/url.ts';
import type { RichText } from '../model/rich-text.ts';
import {
  richConcat,
  richDelete,
  richFromPlainText,
  richSetLink,
  richSetMark,
} from '../model/rich-text.ts';
import { INLINE_SPAN_LIMIT, matchInlineRule } from './inline-rules.ts';

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
 * A callout is a quote whose first token is its bracketed icon.
 *
 * Reading any emoji-led quote as a callout was ambiguous in both directions: a
 * quote that legitimately opened with an emoji came back retyped, and an icon
 * outside the pictographic classes came back as a quote with the icon stuck to
 * the front of its text. The brackets say which one it is, and `toMarkdown`
 * escapes `[` in text, so no quote can imitate the marker.
 */
const CALLOUT_MARKER = /^\[!((?:\\.|[^\]\n])+)\](?:\s+|$)/;

/** The markers `toMarkdown` uses for a toggle, collapsed and expanded. */
const TOGGLE_MARKER = /^([\u25B8\u25BE])(?:\s+|$)/;

/**
 * A line that is nothing but an image.
 *
 * The destination comes in either form CommonMark allows, because a `)` in a
 * URL has to go inside angle brackets to survive; the alt text may carry
 * escapes, since a bare `]` would close the label early.
 */
const IMAGE_LINE = /^!\[((?:\\.|[^\]\n])*)\]\((?:<([^<>\n]*)>|([^)\s]+))\)$/;

/** A GFM table row; the leading pipe is what identifies one. */
const TABLE_ROW = /^\|/;

/** The `| --- | --- |` line, which is alignment rather than content. */
const TABLE_DIVIDER_CELL = /^:?-{3,}:?$/;

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

    rows.push(cells.map(parseInlineMarkdown));
  }

  return rows;
}
/** An opening fence: three or more backticks, plus an optional info string. */
const FENCE_OPEN = /^(`{3,})/;

const CHECKED = /\[[xX]\]/;

/**
 * The length of the fence this line closes, or 0 for a line that closes none.
 *
 * A closing fence is backticks and nothing else, and at least as long as the
 * one that opened the block — otherwise ```` ``` ```` inside the code ends it
 * three lines early and one block comes back as three.
 */
function closingFenceLength(line: string): number {
  const match = /^(`{3,})\s*$/.exec(line);

  return match?.[1]?.length ?? 0;
}

/**
 * Characters that can close an inline rule.
 *
 * Every rule is anchored at the caret, so a character that ends none of them
 * cannot complete a match and the scan can skip the rules entirely.
 */
const CLOSERS = new Set(['*', '_', '~', '`', '>', ')']);

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
 * How much run-shuffling one block may spend keeping a long span reachable.
 *
 * Reaching past the window costs a recall and a rebuild of everything it pulls
 * in, so spans that nest over one stretch of text — `[[[[…](u)](u)](u)` — make
 * the pass quadratic. Unbounded, 176KB of that took 47 seconds on the paste
 * handler's own thread: the hostile-clipboard hang this parser was rewritten
 * to remove, reappearing on the other input path.
 *
 * At this budget a single span still closes over roughly 400 inner spans (~3KB
 * of already-formatted text) and the pathological case costs under a second.
 * Past it the scan stops honouring an opener beyond the window and its
 * delimiters stay in the text — the old fixed-cut behaviour, but at 400 spans
 * rather than 32 runs, and only for input pathological enough to earn it.
 */
const RECALL_BUDGET = 2000;

/**
 * Characters that can open an inline rule.
 *
 * A rule's opening delimiter is one of these, so a delimiter still present in
 * the matchable text is a span that may yet close. Delimiters are spliced out
 * the moment their rule fires, so what remains is exactly the still-open ones:
 * in ordinary prose, none at all.
 */
const OPENERS = new Set(['*', '_', '~', '`', '<', '[']);

/**
 * Characters `escapeMarkdownText` protects, and which `\\` therefore makes literal.
 *
 * The toggle triangles are in here because a bullet whose text is one of them
 * is written escaped; unescaped it would be read back as an empty toggle.
 */
const ESCAPABLE = /[\\`*_[\]~|<>#+\-.()!]/;

/**
 * Stands in for an escaped character while rules are matched.
 *
 * The projection stays the same length as the content, offset for offset, so a
 * rule's offsets apply to both — but a placeholder can never be read as a
 * delimiter, which is the whole point of the escape.
 */
const ESCAPED = '\u0000';

/**
 * True when a line ends in a soft break rather than a literal backslash.
 *
 * `escapeMarkdownText` doubles a literal backslash, so an odd number of
 * trailing backslashes is unambiguously the break marker it emits for `\n`.
 */
function endsWithSoftBreak(line: string): boolean {
  const trailing = /\\+$/.exec(line);

  return trailing ? trailing[0].length % 2 === 1 : false;
}

/**
 * Rejoins lines the serializer split at a soft break.
 *
 * Skipped inside fenced code, where a trailing backslash is just source.
 */
function joinSoftBreaks(lines: readonly string[]): string[] {
  const out: string[] = [];
  let fence = 0;

  for (const line of lines) {
    const trimmed = line.trimStart();

    if (fence > 0) {
      if (closingFenceLength(trimmed) >= fence) {
        fence = 0;
      }

      out.push(line);
      continue;
    }

    const opening = FENCE_OPEN.exec(trimmed);

    if (opening?.[1]) {
      fence = opening[1].length;
      out.push(line);
      continue;
    }

    const previous = out.at(-1);

    if (previous !== undefined && endsWithSoftBreak(previous)) {
      out[out.length - 1] = `${previous.slice(0, -1)}\n${line}`;
      continue;
    }

    out.push(line);
  }

  return out;
}

/** Removes backslash escapes without interpreting anything else. */
function stripEscapes(text: string): string {
  return text.replace(/\\(.)/g, (whole, char: string) => (ESCAPABLE.test(char) ? char : whole));
}

/**
 * Applies inline rules to a whole string.
 *
 * Rather than a second grammar, this replays {@link matchInlineRule} over each
 * growing prefix — exactly what typing the text would have produced, so pasting
 * `**a**` and typing it cannot diverge.
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
export function parseInlineMarkdown(text: string): RichText {
  if (text.length === 0) {
    return [];
  }

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
  let openFrom = 0;
  let origin = 0;
  // How many runs have been dragged back so a span could reach past the window.
  // Each recall is followed by a rebuild of everything it pulled in, so the
  // work is quadratic in how often a long reach is exercised — nested spans
  // over one stretch of text (`[[[[…](u)](u)`) made a 176KB paste take 47s on
  // the paste handler's own thread. Past the budget the window stops honouring
  // an opener that far back, which is what the fixed 32-run cut used to do:
  // the same degradation, but only for input pathological enough to earn it.
  let recalled = 0;
  let retired = false;

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
        write += 1;
      }
    }

    opens.length = write;
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
      recalled += back.length;
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
      openFrom = 0;
    }

    if (recallable === 0) {
      return;
    }

    const open = recalled > RECALL_BUDGET ? undefined : opens[openFrom];
    const barrier = open === undefined ? matchable.length : open - origin - 1;
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
    }

    pending += literal;
    matchable += projected;

    if (OPENERS.has(projected)) {
      opens.push(origin + matchable.length - 1);
    }

    if (matchable.length > window) {
      retire();
    }

    if (!CLOSERS.has(projected)) {
      continue;
    }

    const match = matchInlineRule(matchable);

    if (!match) {
      continue;
    }

    // The first retained character is the one place a lookbehind has nothing to
    // look at, so a span opening there is not trusted rather than guessed at.
    if (retired && match.start === 0) {
      continue;
    }

    const innerStart = match.start + match.openLength;
    const innerEnd = match.end - match.closeLength;

    if (innerEnd <= innerStart) {
      continue;
    }

    flush();

    // The span may reach back over runs that were parked; they have to be in
    // `content` before its offsets mean anything there.
    recall(match.start);

    // Strip the closing delimiter first, so the opening offsets stay valid —
    // and apply the identical splice to the projection to keep them aligned.
    content = richDelete(content, innerEnd - base, match.end - base);
    content = richDelete(content, match.start - base, innerStart - base);
    matchable = matchable.slice(0, innerEnd) + matchable.slice(match.end);
    matchable = matchable.slice(0, match.start) + matchable.slice(innerStart);
    spliceOpens(innerEnd, match.end);
    spliceOpens(match.start, innerStart);

    const start = match.start - base;
    const end = start + (innerEnd - innerStart);

    if (match.link) {
      content = richSetLink(content, start, end, match.link);
    } else if (match.mark) {
      content = richSetMark(content, start, end, match.mark, true);
    }

    park();
    retire();
  }

  flush();

  return done.length > 0 ? richConcat(done, content) : content;
}

/** Leading whitespace as an indent level: two spaces or one tab per level. */
function indentOf(line: string): number {
  const leading = /^[ \t]*/.exec(line)?.[0] ?? '';
  let spaces = 0;

  for (const char of leading) {
    spaces += char === '\t' ? 2 : 1;
  }

  return Math.floor(spaces / 2);
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

/** Parses Markdown text into blocks. Returns an empty list for blank input. */
export function blocksFromMarkdown(text: string): Block[] {
  const lines = joinSoftBreaks(text.replace(/\r\n?/g, '\n').split('\n'));
  const blocks: Block[] = [];
  let fence: string[] | null = null;
  let fenceDepth = 0;
  let fenceLength = 0;
  let table: string[] | null = null;
  let tableDepth = 0;

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

  for (const raw of lines) {
    const trimmedStart = raw.trimStart();

    // A run of pipe-led lines is one table, not one block per line.
    if (fence === null && TABLE_ROW.test(trimmedStart)) {
      if (table === null) {
        table = [];
        tableDepth = indentOf(raw);
      }

      table.push(trimmedStart);
      continue;
    }

    flushTable();

    if (fence) {
      // Only a fence at least as long as the opening one closes the block; a
      // shorter one, or one carrying an info string, is code.
      if (closingFenceLength(trimmedStart) >= fenceLength) {
        blocks.push(createBlock('code', fence.join('\n'), fenceDepth));
        fence = null;
      } else {
        fence.push(raw);
      }

      continue;
    }

    const opening = FENCE_OPEN.exec(trimmedStart);

    if (opening?.[1]) {
      fence = [];
      fenceLength = opening[1].length;
      fenceDepth = indentOf(raw);
      continue;
    }

    const line = trimmedStart.trimEnd();

    // Blank lines only separate blocks; they do not become one.
    if (line.length === 0) {
      continue;
    }

    const depth = indentOf(raw);

    const image = IMAGE_LINE.exec(line);

    if (image) {
      const src = sanitizeImageUrl(image[2] ?? image[3] ?? '');

      if (src) {
        const block = createBlock('image', [], depth);
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

    const block = createBlock(type, parseInlineMarkdown(rest), depth);

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
  }

  flushTable();

  // An unterminated fence still yields its content.
  if (fence && fence.length > 0) {
    blocks.push(createBlock('code', fence.join('\n'), fenceDepth));
  }

  return blocks;
}
