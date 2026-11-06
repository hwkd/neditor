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
import type { InlineRuleMatch } from './inline-rules.ts';
import { INLINE_SPAN_LIMIT, insideLinkDestination, matchInlineRuleAhead } from './inline-rules.ts';

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
const CALLOUT_MARKER = /^\[!((?:\\.|[^\]\n\\])+)\](?:\s+|$)/;

/** The markers `toMarkdown` uses for a toggle, collapsed and expanded. */
const TOGGLE_MARKER = /^([\u25B8\u25BE])(?:\s+|$)/;

/**
 * A line that is nothing but an image.
 *
 * The destination comes in either form CommonMark allows, because a `)` in a
 * URL has to go inside angle brackets to survive; the alt text may carry
 * escapes, since a bare `]` would close the label early.
 *
 * The label's two branches must not both accept a backslash. With `[^\]\n]`
 * as the second one, a backslash could be spent either as an escape or as an
 * ordinary character, so a label that never closed was retried both ways at
 * every backslash -- exponential: `![` and thirty `a\` pairs took two seconds,
 * doubling every two characters more. {@link CALLOUT_MARKER} had the same
 * label and the same defect.
 *
 * The destination may be empty: `![]()` is the image block the slash menu
 * inserts before a picture is chosen, and the writer spells it that way.
 */
const IMAGE_LINE = /^!\[((?:\\.|[^\]\n\\])*)\]\((?:<([^<>\n]*)>|([^)\s]*))\)$/;

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
/**
 * An opening fence: three or more backticks, plus an optional info string.
 *
 * The info string may not hold a backtick, as in CommonMark, and that is what
 * keeps a paragraph opening with a long code span a paragraph: the writer puts
 * code in a fence longer than any backtick run inside it, so code holding
 * ` `` ` opens its line with three. The `(?!`)` keeps the run whole, so a
 * failed test is not retried at every shorter length of it.
 */
const FENCE_OPEN = /^(`{3,})(?!`)(?=[^`]*$)/;

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
 * Deliberately not the toggle triangles, though a bullet whose text is one is
 * written escaped. Honouring `\▾` everywhere ate the backslash out of ordinary
 * prose, which no other reader does; it is honoured at the one place the writer
 * emits it, the head of a bullet, and nowhere else.
 */
const ESCAPABLE = /[\\`*_[\]~|<>#+\-.()!]/;

/**
 * Stands in for a character no rule may read while rules are matched: an
 * escaped one, a backtick, and everything inside a code span but its spaces.
 *
 * The projection stays the same length as the content, offset for offset, so a
 * rule's offsets apply to both — but a placeholder can never be read as a
 * delimiter, which is the whole point of the escape.
 */
const ESCAPED = '\u0000';

const BACKSLASH = 0x5c;

/**
 * What CommonMark lets a backslash escape: any ASCII punctuation character.
 *
 * Wider than {@link ESCAPABLE}, which is what the writer protects in prose and
 * so what the projection hides from the rules. In a link destination the rules
 * have finished, and the destination is read as CommonMark reads it.
 */
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

/**
 * True when a line ends in a soft break rather than a literal backslash.
 *
 * `escapeMarkdownText` doubles a literal backslash, so an odd number of
 * trailing backslashes is unambiguously the break marker it emits for `\n`.
 */
function endsWithSoftBreak(line: string): boolean {
  // Counted back from the end rather than matched with `/\\+$/`, which has no
  // left anchor and so is retried from every backslash of a run that does not
  // reach the end: 40,000 of them mid-line took over a second.
  let count = 0;

  for (
    let index = line.length - 1;
    index >= 0 && line.charCodeAt(index) === BACKSLASH;
    index -= 1
  ) {
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

/** For each offset of a line, whether a destination open there would close. */
interface Closers {
  /** The angle-bracketed form; `null` when the line holds no `](<`. */
  readonly angled: Uint8Array | null;
  /** The plain form; `null` when the line holds no `](`. */
  readonly plain: Uint8Array | null;
}

/**
 * For each offset, whether the text from there closes a link destination open
 * at that offset.
 *
 * For the angled form, whether the first unescaped `<`, `>` or line break from
 * it is a `>` with a `)` straight after. A destination in angle brackets admits
 * spaces, so a `](<` that never closes held every mark rule off the prose
 * behind it, as far as the rule window reaches -- `Use [a](<b to open, then
 * **bold**` kept its asterisks, where CommonMark, seeing no link, reads the
 * bold.
 *
 * For the plain form, whether the first unescaped `)` or whitespace from it is
 * the `)`. Only the angled form used to be asked, so `**see [docs](x**`, with
 * no `)` anywhere after it, kept its asterisks too.
 *
 * Typing cannot know what comes next; a whole line can, and one backward pass
 * answers every offset.
 */
function lineClosers(text: string): Closers | null {
  if (!text.includes('](')) {
    return null;
  }

  // Escapes are read left to right, as the replay reads them: an escaped
  // character is not syntax, so a `\>` or a `\)` closes nothing.
  const escaped = new Uint8Array(text.length);

  for (let index = 0; index < text.length - 1; index += 1) {
    if (text[index] === '\\' && ESCAPABLE.test(text[index + 1]!)) {
      escaped[index + 1] = 1;
      index += 1;
    }
  }

  const angled = text.includes('](<') ? new Uint8Array(text.length + 1) : null;
  const plain = new Uint8Array(text.length + 1);
  let angledState = 0;
  let plainState = 0;

  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text[index]!;

    if (escaped[index] === 0) {
      if (char === '<' || char === '\n') {
        angledState = 0;
      } else if (char === '>') {
        angledState = text[index + 1] === ')' ? 1 : 0;
      }

      if (char === ')') {
        plainState = 1;
      } else if (/\s/.test(char)) {
        plainState = 0;
      }
    }

    if (angled) {
      angled[index] = angledState;
    }

    plain[index] = plainState;
  }

  return { angled, plain };
}

/** A code span in a line: its opening fence, the fence's length, its closing fence. */
interface CodeSpan {
  readonly open: number;
  readonly fence: number;
  readonly close: number;
}

/**
 * The code spans of a line, found the way CommonMark finds them, one opener at
 * a time.
 *
 * A run of N backticks opens a span that the next run of exactly N closes;
 * with no such run it is literal backticks. Backslash escapes count only
 * outside a span -- an escaped backtick opens nothing, but inside a span a
 * backslash is a backslash, so `` `a\` `` is the code `a\`. A span does not
 * cross a line break: the writer puts each line of a run in its own span, and
 * the reader's other rules are line-bounded too.
 *
 * Whether a run opens at all is the caller's to say, which is why this answers
 * one opener at a time rather than listing every span up front: a run that
 * begins inside a link destination is part of the URL, and only the replay
 * knows where the destinations are. Listing them first paired the backtick in
 * `[a](https://x.test/?q=`) and `code`` with the next one in the line.
 *
 * Every maximal run is indexed by length once, and each length keeps a cursor
 * that only moves forward, so a line of unmatched runs of every length is
 * still one pass. `null` with no backtick in the line.
 */
function codeSpanFinder(
  text: string,
): ((at: number, fence: number, opens: boolean) => CodeSpan | null) | null {
  if (!text.includes('`')) {
    return null;
  }

  // Every maximal run, by length, in order: the candidates for a closer.
  const runs = new Map<number, number[]>();

  for (let at = 0; at < text.length;) {
    if (text[at] !== '`') {
      at += 1;
      continue;
    }

    let end = at;

    while (text[end] === '`') {
      end += 1;
    }

    const starts = runs.get(end - at);

    if (starts) {
      starts.push(at);
    } else {
      runs.set(end - at, [at]);
    }

    at = end;
  }

  /** For each run length, how many of its runs are already behind the scan. */
  const passed = new Map<number, number>();
  let lineEnd = -1;

  /**
   * The span a run of `fence` backticks at `at` opens, or `null` for literal
   * backticks. `opens` false is a run the caller has ruled out; it is still
   * passed over, so the cursors stay where a left-to-right scan puts them.
   */
  return (at, fence, opens) => {
    const starts = runs.get(fence) ?? [];
    let next = passed.get(fence) ?? 0;

    while (next < starts.length && starts[next]! < at + fence) {
      next += 1;
    }

    passed.set(fence, next);

    if (!opens) {
      return null;
    }

    if (lineEnd < at) {
      lineEnd = text.indexOf('\n', at);
      lineEnd = lineEnd === -1 ? text.length : lineEnd;
    }

    const close = starts[next];

    if (close === undefined || close >= lineEnd) {
      return null;
    }

    passed.set(fence, next + 1);

    return { open: at, fence, close };
  };
}

/**
 * Applies inline rules to a whole string.
 *
 * Rather than a second grammar, this replays the rules typing uses over each
 * growing prefix, so pasting `**a**` and typing it give the same thing. Three
 * things differ, all because a paste has the whole line and typing has only
 * what is before the caret. A link destination that never closes on the line
 * is no link, so the marks after it apply -- `**see [docs](x**` pasted is bold
 * -- where typing holds the destination open because the `)` may be the next
 * key. A code span is read as CommonMark reads it (below), where typing fires
 * each rule as its closer is typed, so `*a*` typed inside backticks is already
 * italic when the closing backtick arrives. And a backslash escape is honoured
 * (`\*a*` pastes as literal `*a*`), where a typed backslash stays a backslash.
 *
 * Code spans are the one exception, found by `codeSpanFinder` as each
 * opening run is reached: a span is closed by a backtick run of its opener's
 * length and holds no markup and no escapes, which a rule anchored at the caret
 * cannot see coming -- by the closing fence, a `*a*` inside would already have
 * fired. The writer emits code literally on the strength of this, as CommonMark
 * readers expect. A run that begins inside a link destination that closes
 * opens nothing: CommonMark parses a destination from the input when its `]`
 * is reached, so the backtick is part of the URL.
 *
 * Plain text is buffered and folded into the runs where a rule fires -- and,
 * on a line where none does, once the buffer outgrows the rule window -- the
 * rules are only tried on a character that could close one, and a match rebuilds
 * only the handful of runs around it, so the text each test looks at stays the
 * size of the window and the pass is linear in the length of the line rather
 * than quadratic. There used to be a length cap here instead, past which a
 * pasted paragraph kept its raw `**` markup.
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

  const closers = lineClosers(text);
  const findSpan = codeSpanFinder(text);
  /** The code span the replay is inside, from its opening fence to its closing one. */
  let span: CodeSpan | null = null;
  /** Up to where the backticks of a run that opened nothing are still literal. */
  let literalUntil = 0;
  /** What the rest of the line says about a destination open at `index`. */
  const aheadAt = (index: number): { angledCloses?: boolean; plainCloses?: boolean } => ({
    angledCloses: closers?.angled ? closers.angled[index] === 1 : undefined,
    plainCloses: closers?.plain ? closers.plain[index] === 1 : undefined,
  });
  /** Where the open code span's fence starts, counted as `opens` counts. */
  let codeOpen = 0;

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
  let retired = false;

  const flush = (): void => {
    if (pending.length > 0) {
      content = richConcat(content, richFromPlainText(pending));
      pending = '';
    }
  };

  /**
   * The match a code span makes once its closing fence is in, or `null`.
   *
   * Found by `codeSpanFinder` rather than by a rule, so the only
   * question left is one every rule answers: whether the opening fence is
   * still in reach. Whether the span sits in a link destination was settled at
   * its opening fence, where a run inside one opens nothing at all.
   */
  const codeSpanMatch = (span: CodeSpan, start: number): InlineRuleMatch | null => {
    const end = matchable.length;

    if (start < 0 || end - start > INLINE_SPAN_LIMIT) {
      return null;
    }

    // One space comes off each end when both have one and the content is not
    // all spaces -- the padding the writer adds around a backtick at an end.
    const from = span.open + span.fence;
    const padded =
      span.close - from >= 2 &&
      text[from] === ' ' &&
      text[span.close - 1] === ' ' &&
      /[^ ]/.test(text.slice(from, span.close));
    const delimiter = span.fence + (padded ? 1 : 0);

    return {
      start,
      end,
      openLength: delimiter,
      closeLength: delimiter,
      mark: 'code',
    };
  };

  /**
   * A link destination as the URL it spells, from its offsets in `matchable`.
   *
   * The projection holds a placeholder for each escaped character, and the
   * content holds the character itself, offset for offset. A backslash still in
   * the projection escaped nothing the projection hides, but CommonMark lets it
   * escape any ASCII punctuation, so in a destination it does.
   */
  const destination = (from: number, to: number): string => {
    let literal: string | undefined;
    let out = '';

    for (let at = from; at < to; at += 1) {
      const char = matchable[at]!;
      const next = matchable[at + 1];

      if (char === ESCAPED) {
        // Read in place, never by folding `pending` into the runs: this is
        // asked of every link candidate, including the ones `sanitizeUrl` then
        // refuses, and a flush per candidate kept `pending` empty, which is the
        // one thing `retire` folds. On a line of `[a](x\`)` -- the writer's own
        // spelling -- nothing ever fired, `content` grew to the line, and every
        // candidate joined it afresh: quadratic.
        if (literal === undefined) {
          const pendingFrom = matchable.length - pending.length;

          if (from >= pendingFrom) {
            literal = pending.slice(from - pendingFrom);
          } else {
            recall(from);
            literal =
              content
                .map((run) => run.text)
                .join('')
                .slice(from - base) + pending;
          }
        }

        out += literal[at - from] ?? '';
      } else if (
        char === '\\' &&
        at + 1 < to &&
        next !== undefined &&
        ASCII_PUNCTUATION.test(next)
      ) {
        out += next;
        at += 1;
      } else {
        out += char;
      }
    }

    return out;
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

    const open = opens[openFrom];
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

    // Nothing parked is left to cut, but the text no rule has fired over is
    // still all in `matchable`: `content` and `pending` are folded only where
    // a rule fires, so on a long line where none does -- `*b ` repeated, every
    // `*` a closer and none of them closing -- `matchable` grew to the whole
    // line, and each closer's test sliced it afresh. `'*b '.repeat(80000)`
    // took 4.4 seconds. So once it is twice the window, everything behind the
    // barrier is folded straight into `done`, keeping a full window: what the
    // rules can see is exactly what they saw before. (A delimiter still in
    // reach is inside that window anyway; the barrier is the same rule the
    // parked cut obeys, stated where it applies.)
    if (recallable === 0 && matchable.length - cut > 2 * window) {
      const limit = Math.min(barrier, matchable.length - window);
      // With nothing parked, `content` starts at `cut` and `pending` follows it.
      const folded = limit - (matchable.length - pending.length);

      if (folded > 0) {
        done.push(...content, ...richFromPlainText(pending.slice(0, folded)));
        content = [];
        pending = pending.slice(folded);
        // As though the folded text had been parked and cut with the rest.
        base = limit;
        cut = limit;
      }
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

    if (span === null && char === '`' && index >= literalUntil && findSpan) {
      let fence = 1;

      while (text[index + fence] === '`') {
        fence += 1;
      }

      // Asked with the projection as it stands before this run, so the walk
      // back from the caret starts at the character in front of it. A line
      // whose rest closes no destination here cannot hold one, which spares
      // the walk for nearly every run.
      const ahead = aheadAt(index);
      const inDestination =
        (ahead.plainCloses === true || ahead.angledCloses === true) &&
        insideLinkDestination(matchable, matchable.length, ahead);

      span = findSpan(index, fence, !inDestination);

      if (span === null) {
        literalUntil = index + fence;
      }
    }

    const inSpan = span !== null;
    let literal = char;
    let projected = char;

    if (inSpan) {
      // Inside a code span nothing is markup, a backslash included: every
      // character is content, and none of it is visible to the rules. Spaces
      // are, since they are what ends a plain destination the span may sit in.
      projected = /\s/.test(char) ? char : ESCAPED;
    } else if (char === '\\' && next !== undefined && ESCAPABLE.test(next)) {
      // A backslash makes the next character literal: it goes into the content
      // but never into the string rules are matched against.
      index += 1;
      literal = next;
      projected = ESCAPED;
    } else if (char === '`') {
      // A backtick no span claimed is a literal one, which no rule may pair
      // differently: `` ``a` `` is not code in CommonMark.
      projected = ESCAPED;
    }

    pending += literal;
    matchable += projected;

    if (span !== null && index === span.open) {
      // Held open like any other delimiter, so nothing cuts it off before its
      // closing fence arrives.
      codeOpen = origin + matchable.length - 1;
      opens.push(codeOpen);
    } else if (OPENERS.has(projected)) {
      opens.push(origin + matchable.length - 1);
    }

    if (matchable.length > window) {
      retire();
    }

    let match: InlineRuleMatch | null;

    if (span !== null) {
      if (index !== span.close + span.fence - 1) {
        continue;
      }

      const closed = span;

      span = null;
      match = codeSpanMatch(closed, codeOpen - origin);
    } else {
      if (!CLOSERS.has(projected)) {
        continue;
      }

      match = matchInlineRuleAhead(matchable, { ...aheadAt(index + 1), destination });
    }

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

/**
 * A numeric character reference, matched at one position only.
 *
 * Sticky, so it is tried where the previous one ended and nowhere else.
 */
const REFERENCE_AT = /&#(\d{1,7});/y;

/** `&`, which the writer encodes when text would otherwise begin `&#`. */
const AMPERSAND = 38;

/**
 * Splits off the run of references that opens a block's text, decoded.
 *
 * `toMarkdown` writes a block's leading whitespace as `&#32;`, `&#9;` and the
 * like, because bare it would be read as indentation or as the separator after
 * a marker and lost. Decoded only here, at the start of the text, and only the
 * references that writer emits there -- whitespace, line breaks included, and
 * the `&#38;` it puts in front of text that itself begins `&#` -- so a
 * reference anywhere else in the line stays the literal characters it was.
 *
 * A line break is among them because the writer spells a leading one `&#10;`:
 * as the escaped newline it is elsewhere, it was joined onto the next line and
 * trimmed off the front of it, with the spaces after it.
 */
function decodeLeadingReferences(text: string): readonly [string, string] {
  let lead = '';
  let at = 0;

  for (;;) {
    REFERENCE_AT.lastIndex = at;
    const reference = REFERENCE_AT.exec(text);

    if (!reference) {
      break;
    }

    const code = Number(reference[1]);
    const char = code <= 0xffff ? String.fromCharCode(code) : '';

    if (code !== AMPERSAND && (char === '' || !/\s/.test(char))) {
      break;
    }

    lead += char;
    at += reference[0].length;
  }

  return [lead, at === 0 ? text : text.slice(at)];
}

/** A block's text: its encoded leading run as literal text, then the inline rules. */
function parseLeadAndInline(text: string): RichText {
  const [lead, rest] = decodeLeadingReferences(text);

  return lead.length === 0
    ? parseInlineMarkdown(rest)
    : richConcat(richFromPlainText(lead), parseInlineMarkdown(rest));
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
      const destination = image[2] ?? image[3] ?? '';
      // An empty destination is the placeholder, not an unsafe URL: it has no
      // source to sanitize, and dropping it turned the block into `![]()` text.
      const src = destination === '' ? '' : sanitizeImageUrl(destination);

      if (src !== null) {
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

    const block = createBlock(type, parseLeadAndInline(rest), depth);

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
