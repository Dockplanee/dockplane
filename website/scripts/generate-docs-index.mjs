/**
 * Derives the documentation page from docs/, so the technical documentation is
 * maintained in exactly one place.
 *
 * The website does not hold a second copy of the documentation. It holds an
 * index of it — each page's title, its summary and where to read it — built
 * from the files themselves. A page added, renamed or removed under docs/ shows
 * up here on the next build; a page that drifts cannot, because there is
 * nothing here to drift from.
 *
 * Title    the first `# ` heading
 * Summary  the first paragraph under it, as one line
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, '..', 'docs');
const target = join(root, 'src', 'app', 'pages', 'docs', 'docs.data.ts');

const REPOSITORY = 'https://github.com/Dockplanee/dockplane';
const BRANCH = 'main';

/*
 * The sections the documentation is organised into, in the order a reader meets
 * them. A directory that is not listed is not part of the public documentation:
 * design specifications and per-release notes are in the repository for people
 * working on Dockplane, not for people running it.
 */
const SECTIONS = [
  {
    directory: 'getting-started',
    title: 'Getting started',
    summary: 'What Dockplane is, how to install it, and how to connect a Docker host.',
    order: ['overview.md', 'installation.md', 'add-host.md'],
  },
  {
    directory: 'operations',
    title: 'Operations',
    summary: 'Running it: upgrades, backups, the agent, and what to check when something is wrong.',
    order: [
      'upgrade.md',
      'backup-restore.md',
      'agent.md',
      'container-lifecycle.md',
      'container-logs.md',
      'troubleshooting.md',
    ],
  },
  {
    directory: 'security',
    title: 'Security',
    summary: 'Trust boundaries, how a host proves who it is, and how operators sign in.',
    order: ['security-model.md', 'agent-security.md', 'authentication.md'],
  },
  {
    directory: 'reference',
    title: 'Reference',
    summary: 'Architecture, supported platforms, limitations, and the agent interfaces.',
    order: [
      'architecture.md',
      'supported-platforms.md',
      'known-limitations.md',
      'agent-protocol.md',
      'agent-gateway.md',
      'agent-identity.md',
      'interface-versions.md',
    ],
  },
];

/** The first `# ` heading, or the file name if a page has none. */
function titleOf(markdown, file) {
  const heading = markdown.match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : file.replace(/\.md$/, '');
}

/**
 * The first paragraph under the title, flattened to one line.
 *
 * Blockquotes, code fences, tables and lists are skipped: a summary is prose,
 * and a page that opens with a diagram should be described by the sentence
 * after it rather than by the diagram.
 */
function summaryOf(markdown) {
  const afterTitle = markdown.replace(/^#\s+.+$/m, '');
  const blocks = afterTitle.split(/\n\s*\n/);

  for (const block of blocks) {
    const text = block.trim();

    if (!text) continue;
    if (/^(```|>|\||[-*+]\s|\d+\.\s|#)/.test(text)) continue;

    return text
      .replace(/\s*\n\s*/g, ' ')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .replace(/\[(.+?)\]\([^)]+\)/g, '$1')
      .trim();
  }

  return '';
}

async function pagesIn(section) {
  const directory = join(docs, section.directory);
  const present = (await readdir(directory)).filter((name) => name.endsWith('.md'));

  // Listed pages first, in the order they are listed; anything else after, so a
  // new page appears without this file needing to know about it.
  const ordered = [
    ...section.order.filter((name) => present.includes(name)),
    ...present.filter((name) => !section.order.includes(name)).sort(),
  ];

  return Promise.all(
    ordered.map(async (name) => {
      const path = join(directory, name);
      const markdown = await readFile(path, 'utf8');

      return {
        title: titleOf(markdown, name),
        summary: summaryOf(markdown),
        path: relative(join(root, '..'), path),
      };
    }),
  );
}

const sections = await Promise.all(
  SECTIONS.map(async (section) => ({
    title: section.title,
    summary: section.summary,
    pages: await pagesIn(section),
  })),
);

const missing = sections.flatMap((section) =>
  section.pages.filter((page) => !page.summary).map((page) => page.path),
);

if (missing.length > 0) {
  console.error('these pages have no opening paragraph to summarise:');
  for (const path of missing) console.error(`  ${path}`);
  process.exit(1);
}

const file = `/*
 * Generated from docs/ by scripts/generate-docs-index.mjs. Do not edit.
 *
 * The documentation lives in docs/ and is written once. This file is an index
 * of it, rebuilt before every build.
 */

export interface DocPage {
  readonly title: string;
  readonly summary: string;
  readonly url: string;
}

export interface DocSection {
  readonly title: string;
  readonly summary: string;
  readonly pages: readonly DocPage[];
}

export const DOCS_REPOSITORY = '${REPOSITORY}/tree/${BRANCH}/docs';

export const DOC_SECTIONS: readonly DocSection[] = ${JSON.stringify(
  sections.map((section) => ({
    title: section.title,
    summary: section.summary,
    pages: section.pages.map((page) => ({
      title: page.title,
      summary: page.summary,
      url: `${REPOSITORY}/blob/${BRANCH}/${page.path}`,
    })),
  })),
  null,
  2,
)} as const;
`;

await writeFile(target, file, 'utf8');

const count = sections.reduce((total, section) => total + section.pages.length, 0);
console.log(`docs index: ${count} pages in ${sections.length} sections`);
