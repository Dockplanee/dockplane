/**
 * Writes robots.txt and sitemap.xml into the build output.
 *
 * The page list is taken from the prerendered files themselves, so the sitemap
 * cannot drift away from what was actually generated.
 */
import { readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SITE_ORIGIN } from '../src/app/core/site.config.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = join(root, 'dist', 'dockplane-website', 'browser');

/** Prerendered pages that must stay out of search indexes. */
const EXCLUDED = new Set(['404']);

async function collectPages(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name === 'index.html')
    .map((entry) => relative(outputRoot, join(entry.parentPath, entry.name)))
    .map((file) => file.slice(0, -'index.html'.length).split(sep).filter(Boolean).join('/'))
    .filter((route) => !EXCLUDED.has(route))
    .sort();
}

function pageUrl(route) {
  return route === '' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}/${route}`;
}

function renderSitemap(routes) {
  const entries = routes
    .map((route) => `  <url>\n    <loc>${pageUrl(route)}</loc>\n  </url>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

function renderRobots() {
  return [
    'User-agent: *',
    'Allow: /',
    ...[...EXCLUDED].map((route) => `Disallow: /${route}`),
    '',
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    '',
  ].join('\n');
}

const routes = await collectPages(outputRoot);

if (routes.length === 0) {
  throw new Error(`No prerendered pages found in ${outputRoot}`);
}

await writeFile(join(outputRoot, 'sitemap.xml'), renderSitemap(routes), 'utf8');
await writeFile(join(outputRoot, 'robots.txt'), renderRobots(), 'utf8');

process.stdout.write(`sitemap: ${routes.length} pages\n`);
