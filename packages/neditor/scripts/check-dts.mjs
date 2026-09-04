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
} catch (error) {
  const output = error.stdout ?? error.stderr ?? error.message;

  console.error('dts: a consumer cannot compile against the built declarations\n');
  console.error(String(output).trim());
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
