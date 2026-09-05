// Compiles a consumer against the built declarations, with declaration emit on.
//
// `vp check` type-checks this package's own sources, which is a weaker question
// than the one consumers ask: every type reachable through an exported
// signature must itself be nameable, or their build fails with TS4023 and emits
// nothing. That has been wrong twice — first for NEditorTheme and OffsetRange,
// then for CellCoords, which was "exported" as a derived alias while the
// interface the signature actually names stayed private and was emitted as
// `CellCoords$1`. Both looked exported from inside.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(dirname(pkg));
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const dir = mkdtempSync(join(tmpdir(), 'neditor-dts-'));
const LIB_REFERENCE = '/// <reference lib="dom" />';

// Every type the public surface can hand back, named the way a wrapper names
// it: through the signature, not by importing it directly. Importing directly
// would have passed even while the emitted declaration was unusable.
const CONSUMER = `
import { NEditor, createEditor } from '@neditor/core';
import type {
  Block, BlockType, CellCoords, NEditorDocument, NEditorLabels, NEditorOptions,
  NEditorTheme, OffsetRange, RichText, SelectionState, SlashCommand,
  SlashCommandLabel, TableRows, TextRun,
} from '@neditor/core';

export const cell = (...a: Parameters<NEditor['focusRange']>) => a[3];
export const doc = (e: NEditor) => e.getDocument();
export const sel = (e: NEditor) => e.getSelectionState();
export const mount = (o: NEditorOptions) => createEditor(o);
export const named = (
  b: Block, t: BlockType, c: CellCoords, d: NEditorDocument, l: NEditorLabels,
  th: NEditorTheme, o: OffsetRange, r: RichText, s: SelectionState,
  sc: SlashCommand, sl: SlashCommandLabel, tr: TableRows, tx: TextRun,
) => [b, t, c, d, l, th, o, r, s, sc, sl, tr, tx] as const;
`;

// The point of the `./model` entry: it names no DOM type, so it must compile
// for a consumer who has no `dom` lib. That is the Cloudflare Worker or other
// edge runtime whose own globals conflict with the DOM's, and for whom the
// main entry's `/// <reference lib="dom" />` -- which nothing on their side can
// suppress -- breaks the build on the first import.
const MODEL_CONSUMER = `
import {
  blocksFromMarkdown, normalizeDocument, toMarkdown, blockText, richToPlainText,
  createBlock, sanitizeUrl, normalizeTableRows,
} from '@neditor/core/model';
import type {
  Block, BlockType, NEditorDocument, RichText, TableRows, TextRun, Mark,
} from '@neditor/core/model';

export const roundTrip = (markdown: string): string =>
  toMarkdown(normalizeDocument({ blocks: blocksFromMarkdown(markdown) }));

export const named = (
  b: Block, t: BlockType, d: NEditorDocument, r: RichText,
  tr: TableRows, tx: TextRun, m: Mark,
) => [b, t, d, r, tr, tx, m] as const;

export const used = [blockText, richToPlainText, createBlock, sanitizeUrl, normalizeTableRows];
`;

try {
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'index.ts'), CONSUMER);
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'es2022',
        module: 'esnext',
        moduleResolution: 'bundler',
        declaration: true,
        emitDeclarationOnly: true,
        strict: true,
        skipLibCheck: true,
        rootDir: 'src',
        outDir: 'out',
      },
      include: ['src'],
    }),
  );

  // A real pack and install, not a `paths` alias to the .d.mts. The alias
  // resolves the module differently enough that the failure this exists to
  // catch does not reproduce under it — checked by reverting the fix and
  // watching the aliased version pass.
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'dts-check', private: true, type: 'module' }),
  );
  const packed = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], {
    cwd: pkg,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .trim()
    .split('\n')
    .at(-1);

  execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund', join(dir, packed)], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  execFileSync(process.execPath, [tsc, '-p', dir], { stdio: 'pipe', encoding: 'utf8' });

  const emitted = readFileSync(join(dir, 'out', 'index.d.ts'), 'utf8');

  if (!emitted.includes('CellCoords')) {
    throw new Error('declaration emitted, but the consumer could not name CellCoords');
  }

  console.warn('dts: a consumer can name every public type and emit declarations');

  // Same tarball, a second consumer, and a tsconfig with no `dom` in `lib` and
  // `skipLibCheck` off -- so a DOM type reaching this entry through a shared
  // chunk is an error here rather than something an edge consumer discovers.
  //
  // No `paths` alias: this sits inside the temp dir, so `@neditor/core/model`
  // resolves by walking up to the installed tarball and through its `exports`
  // map, which is the thing being tested. Aliasing it was how an earlier
  // version of this check managed to pass while the package was broken.
  mkdirSync(join(dir, 'model'));
  mkdirSync(join(dir, 'model', 'src'));
  writeFileSync(join(dir, 'model', 'src', 'index.ts'), MODEL_CONSUMER);
  writeFileSync(
    join(dir, 'model', 'package.json'),
    JSON.stringify({ name: 'dts-check-model', private: true, type: 'module' }),
  );
  writeFileSync(
    join(dir, 'model', 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'es2022',
        lib: ['es2022'],
        module: 'esnext',
        moduleResolution: 'bundler',
        declaration: true,
        emitDeclarationOnly: true,
        strict: true,
        skipLibCheck: false,
        rootDir: 'src',
        outDir: 'out',
        typeRoots: [],
        types: [],
      },
      include: ['src'],
    }),
  );

  execFileSync(process.execPath, [tsc, '-p', join(dir, 'model')], {
    stdio: 'pipe',
    encoding: 'utf8',
  });

  // Compiling is necessary and not sufficient. A shared chunk carries its own
  // copy of the banner, so an entry that reaches one still compiles -- while
  // injecting `lib.dom` into the consumer exactly as before. Both mutations of
  // this check passed until it asked the real question, which is what the
  // model entry's declarations can *reach*.
  const installed = join(dir, 'node_modules', '@neditor', 'core', 'dist');
  const closure = new Set();
  const pending = ['model.d.mts', 'model.d.cts'];

  while (pending.length > 0) {
    const name = pending.pop();

    if (closure.has(name)) {
      continue;
    }

    closure.add(name);
    const source = readFileSync(join(installed, name), 'utf8');

    if (source.includes(LIB_REFERENCE)) {
      throw new Error(
        `${name} is reachable from the model entry and carries ${LIB_REFERENCE}, ` +
          'which injects lib.dom into every consumer of it',
      );
    }

    for (const [, specifier] of source.matchAll(/from\s*"(\.[^"]+)"/g)) {
      pending.push(specifier.replace(/^\.\//, '').replace(/\.(m|c)js$/, `.d.$1ts`));
    }
  }

  console.warn(
    `dts: the model entry compiles with no dom lib, and none of the ${closure.size} ` +
      'declaration files it reaches asks for one',
  );
} catch (error) {
  const output = error.stdout ?? error.stderr ?? error.message;

  console.error('dts: a consumer cannot compile against the built declarations\n');
  console.error(String(output).trim());
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
