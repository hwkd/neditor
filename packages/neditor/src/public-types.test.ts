// @vitest-environment happy-dom
import { afterEach, expect, test } from 'vitest';

import type { CellCoords, NEditorLabels, SlashCommandLabel } from './index.ts';
import { createEditor } from './index.ts';
import type { NEditor } from './editor.ts';

/**
 * Names a consumer has to be able to write down.
 *
 * A type reachable through an exported signature is part of the surface
 * whether or not it is exported: `focusRange` takes cell coordinates and
 * `NEditorLabels.slashCommands` holds slash-command labels, so a wrapper that
 * forwards either has to be able to name them. When they were not exported,
 * naming one failed with TS2459 and declaration emit had nothing to point at.
 *
 * The imports above are the assertion — this file does not compile without
 * them — and the calls below are what keeps them honest: a type that no longer
 * lines up with the API it stands for fails here rather than in a consumer's
 * build.
 */

const editors: NEditor[] = [];

afterEach(() => {
  while (editors.length > 0) {
    editors.pop()?.destroy();
  }

  document.body.replaceChildren();
});

test('CellCoords names what focusRange takes', () => {
  const host = document.createElement('div');
  document.body.append(host);

  const editor = createEditor({
    element: host,
    doc: {
      blocks: [
        {
          id: 'table',
          type: 'table',
          depth: 0,
          content: [],
          rows: [
            [[{ text: 'head' }], [{ text: 'other' }]],
            [[{ text: 'body' }], [{ text: 'cell' }]],
          ],
        },
      ],
    },
  });
  editors.push(editor);

  // The point of the export: a wrapper can hold the coordinates in a variable
  // of its own before handing them on.
  const cell: CellCoords = { row: 1, column: 0 };

  expect(editor.focusRange('table', 0, 4, cell)).toBe(true);
});

test('SlashCommandLabel names what NEditorLabels.slashCommands holds', () => {
  const paragraph: SlashCommandLabel = {
    label: 'Absatz',
    description: 'Nur Text',
    keywords: ['text'],
  };

  const labels: Partial<NEditorLabels> = { slashCommands: { paragraph } };
  const host = document.createElement('div');
  document.body.append(host);

  const editor = createEditor({ element: host, labels });
  editors.push(editor);

  expect(labels.slashCommands?.paragraph).toBe(paragraph);
});
