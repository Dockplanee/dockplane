/**
 * Copies the Latin subsets of the brand typefaces from their npm packages into
 * public/fonts so the site can serve them from its own origin.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'public', 'fonts');

const files = [
  '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  '@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2',
  '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2',
];

await mkdir(target, { recursive: true });

for (const file of files) {
  const source = join(root, 'node_modules', file);
  const name = file.slice(file.lastIndexOf('/') + 1);
  await copyFile(source, join(target, name));
  process.stdout.write(`fonts: ${name}\n`);
}
