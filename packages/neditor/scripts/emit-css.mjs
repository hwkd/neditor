/**
 * Writes the stylesheet out as a real `.css` file.
 *
 * The styles live as a string so the package needs no CSS loader, but a
 * consumer under a strict `style-src` policy cannot use an injected `<style>`
 * at all. Emitting the file gives them something to `import` or `<link>`.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dist = new URL('../dist/', import.meta.url);
const { NEDITOR_STYLES } = await import(new URL('index.mjs', dist).href);

const banner = '/* @neditor/core — generated from src/styles.ts. Do not edit. */\n';
const target = new URL('styles.css', dist);

await writeFile(target, banner + NEDITOR_STYLES.trimStart(), 'utf8');
// eslint-disable-next-line no-console -- build script output
console.warn(`wrote ${fileURLToPath(target)}`);
