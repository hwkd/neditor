/**
 * Writes the stylesheet out as a real `.css` file.
 *
 * The styles live as a string so the package needs no CSS loader, but a
 * consumer under a strict `style-src` policy cannot use an injected `<style>`
 * at all. Emitting the file gives them something to `import` or `<link>`.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dist = new URL('../dist/', import.meta.url);
const { NEDITOR_STYLES } = await import(new URL('index.mjs', dist).href);

const banner = '/* @neditor/core — generated from src/styles.ts. Do not edit. */\n';
const target = new URL('styles.css', dist);

await writeFile(target, banner + NEDITOR_STYLES.trimStart(), 'utf8');
// eslint-disable-next-line no-console -- build script output
console.warn(`wrote ${fileURLToPath(target)}`);

/**
 * Leaves the `dom` lib reference on the main entry's declarations, and nowhere
 * else.
 *
 * `pack.banner.dts` applies to every declaration output, including the shared
 * chunks -- and the model entry reaches some of those, so banners left there
 * inject `lib.dom` into a consumer who imported the DOM-free entry precisely to
 * avoid it. Stripping only `model.d.*` was not enough: the CJS build routes the
 * URL helpers through a chunk of their own, and `check-dts.mjs` caught it.
 *
 * A chunk reachable only from the main entry loses nothing by this. The
 * reference on `index.d.*` adds the lib to the whole program, so anything that
 * entry pulls in still has the DOM types it names.
 */
const LIB_REFERENCE = '/// <reference lib="dom" />';
const ENTRY_DECLARATIONS = new Set(['index.d.mts', 'index.d.cts']);

for (const name of await readdir(fileURLToPath(dist))) {
  if (!/\.d\.(m|c)ts$/.test(name) || ENTRY_DECLARATIONS.has(name)) {
    continue;
  }

  const file = new URL(name, dist);
  const source = await readFile(file, 'utf8');

  if (!source.startsWith(LIB_REFERENCE)) {
    continue;
  }

  await writeFile(file, source.slice(LIB_REFERENCE.length).trimStart(), 'utf8');
  // eslint-disable-next-line no-console -- build script output
  console.warn(`stripped the dom lib reference from ${name}`);
}
