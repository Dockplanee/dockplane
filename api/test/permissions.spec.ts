import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { PERMISSION_KEYS } from '../src/rbac/permissions';

/**
 * The permission catalog against what the product actually does with it.
 *
 * A permission that nothing enforces is worse than a missing one. It appears in
 * the roles view, it can be granted, and it reads as a capability somebody has
 * been given — while the endpoint it appears to guard either does not exist or
 * is guarded by something else. The catalog says a key exists only when the
 * control server enforces something with it, and these are the checks that keep
 * that true.
 */
const REPOSITORY = join(__dirname, '..', '..');
const API_SOURCE = join(__dirname, '..', 'src');
const APP_PERMISSIONS = join(REPOSITORY, 'app', 'src', 'app', 'core', 'permissions.ts');
const DOCUMENTED = join(REPOSITORY, 'docs', 'security', 'authentication.md');
const CATALOG = join('rbac', 'permissions.ts');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(path);
    }

    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

describe('the permission catalog', () => {
  // Every file but the catalog itself: a key naming itself is not enforcement.
  const enforcement = sourceFiles(API_SOURCE)
    .filter((path) => !path.endsWith(CATALOG))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');

  it.each(PERMISSION_KEYS)('enforces %s somewhere', (key) => {
    expect(enforcement).toContain(`'${key}'`);
  });

  /*
   * The interface mirrors this list, and an interface that knows a permission
   * the server never issues offers actions nobody can take.
   */
  it('is mirrored exactly by the application', () => {
    const source = readFileSync(APP_PERMISSIONS, 'utf8');
    const listed = [...source.matchAll(/^ {2}'([a-z][a-z.]*)',$/gm)].map((match) => match[1]);

    expect(listed).toEqual([...PERMISSION_KEYS]);
  });

  /*
   * The security documentation prints the catalog, and a reader deciding what
   * to grant reads it there rather than in the source.
   */
  it('is documented exactly', () => {
    const source = readFileSync(DOCUMENTED, 'utf8');
    const block = /### Permission catalog[\s\S]*?```text\n([\s\S]*?)```/.exec(source);

    expect(block).not.toBeNull();

    const listed = block![1]
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => line.split(/\s{2,}/)[0]);

    expect(listed).toEqual([...PERMISSION_KEYS]);
  });
});
