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
import { matchInlineRule } from './inline-rules.ts';

/**
 * Markdown → blocks, for pasted plain text.
 *
 * Our own copy writes Markdown to `text/plain`, and people paste Markdown from
 * files and other editors, so plain text is parsed rather than dropped in
 * verbatim. Each line becomes a block: predictable, and the same rule a reader
 * can hold in their head. Soft-wrapped prose therefore arrives as several
 * paragraphs.
 */

/** Line prefixes, longest-first so `###` is not read as `#`. */
const BLOCK_PREFIXES: ReadonlyArray<readonly [RegExp, BlockType]> = [
  [/^###\s+/, 'heading3'],
  [/^##\s+/, 'heading2'],
  [/^#\s+/, 'heading1'],
  // A to-do is a list item whose marker is a checkbox, so it wins over the list.
  [/^[-*+]\s+\[[ xX]\]\s+/, 'todo'],
  [/^\[[ xX]\]\s+/, 'todo'],
  [/^[-*+]\s+/, 'bulleted_list'],
  [/^\d+[.)]\s+/, 'numbered_list'],
  [/^>\s+/, 'quote'],
];

const DIVIDER = /^(?:-{3,}|\*{3,}|_{3,})$/;

/**
 * A quote whose first character is a symbol is a callout.
 *
 * Widened past Extended_Pictographic because the icon picker accepts any
 * grapheme: `★` is a perfectly good callout icon and used to degrade the whole
 * block back to a quote.
 */
const CALLOUT_ICON = /^(\p{Extended_Pictographic}\uFE0F?|[\p{So}\p{Sk}])\s+/u;

/** The markers `toMarkdown` uses for a toggle, collapsed and expanded. */
const TOGGLE_MARKER = /^([\u25B8\u25BE])\s+/;

/** A line that is nothing but an image. */
const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;

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
const FENCE = /^```/;
const CHECKED = /\[[xX]\]/;

/** Long lines skip inline parsing; the scan below is quadratic in line length. */
const INLINE_LIMIT = 2000;

/** Characters `escapeMarkdownText` protects, and which `\\` therefore makes literal. */
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
  let fenced = false;

  for (const line of lines) {
    if (FENCE.test(line.trimStart())) {
      fenced = !fenced;
      out.push(line);
      continue;
    }

    const previous = out.at(-1);

    if (!fenced && previous !== undefined && endsWithSoftBreak(previous)) {
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
 */
export function parseInlineMarkdown(text: string): RichText {
  if (text.length === 0) {
    return [];
  }

  if (text.length > INLINE_LIMIT) {
    return richFromPlainText(stripEscapes(text));
  }

  let content: RichText = [];
  let matchable = '';

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

    content = richConcat(content, richFromPlainText(literal));
    matchable += projected;

    const match = matchInlineRule(matchable);

    if (!match) {
      continue;
    }

    const innerStart = match.start + match.openLength;
    const innerEnd = match.end - match.closeLength;

    if (innerEnd <= innerStart) {
      continue;
    }

    // Strip the closing delimiter first, so the opening offsets stay valid —
    // and apply the identical splice to the projection to keep them aligned.
    content = richDelete(content, innerEnd, match.end);
    content = richDelete(content, match.start, innerStart);
    matchable = matchable.slice(0, innerEnd) + matchable.slice(match.end);
    matchable = matchable.slice(0, match.start) + matchable.slice(innerStart);

    const start = match.start;
    const end = start + (innerEnd - innerStart);

    if (match.link) {
      content = richSetLink(content, start, end, match.link);
    } else if (match.mark) {
      content = richSetMark(content, start, end, match.mark, true);
    }
  }

  return content;
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

    if (FENCE.test(trimmedStart)) {
      if (fence) {
        blocks.push(createBlock('code', fence.join('\n'), fenceDepth));
        fence = null;
      } else {
        fence = [];
        fenceDepth = indentOf(raw);
      }

      continue;
    }

    if (fence) {
      fence.push(raw);
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
      const src = sanitizeImageUrl(image[2] ?? '');

      if (src) {
        const block = createBlock('image', [], depth);
        block.src = src;
        block.alt = image[1] ?? '';
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
      const callout = CALLOUT_ICON.exec(rest);

      if (callout) {
        type = 'callout';
        icon = callout[1];
        rest = rest.slice(callout[0].length);
      }
    } else if (type === 'bulleted_list') {
      const toggle = TOGGLE_MARKER.exec(rest);

      if (toggle) {
        type = 'toggle';
        collapsed = toggle[1] === '\u25B8';
        rest = rest.slice(toggle[0].length);
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
