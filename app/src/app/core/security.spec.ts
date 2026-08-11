import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards against the interface granting itself authority.
 *
 * These read the source rather than the running application, because what they
 * prevent is a change that looks harmless in review: a default permission set
 * "for development", a role name compared in a component, a token parked in
 * storage so a reload feels faster. Each would move the security boundary into
 * the browser, where it does not belong.
 */
const SOURCE_ROOT = join(process.cwd(), 'src');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);

    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }

    return path.endsWith('.ts') || path.endsWith('.html') ? [path] : [];
  });
}

const FILES = sourceFiles(SOURCE_ROOT);

const PRODUCTION_FILES = FILES.filter(
  (path) => !path.endsWith('.spec.ts') && !path.includes(`${join('src', 'testing')}`),
);

const read = (path: string) => readFileSync(path, 'utf8');

/**
 * Source with comments removed.
 *
 * The checks below look for behaviour, and a comment explaining that something
 * is deliberately *not* done would otherwise read as the thing itself.
 */
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

describe('no self-granted authority', () => {
  it('has no development grant in anything that ships', () => {
    const offenders = PRODUCTION_FILES.filter((path) => read(path).includes('DEVELOPMENT_GRANTS'));

    expect(offenders).toEqual([]);
  });

  /**
   * Permissions arrive from the session and are never seeded.
   *
   * A default set is the same mistake as a development grant wearing different
   * clothes: it makes the interface offer controls before the server has said
   * the operator may use them.
   */
  it('starts the permission set empty', () => {
    const source = read(join(SOURCE_ROOT, 'app', 'core', 'permissions.ts'));

    expect(source).not.toMatch(/new Set\(\s*PERMISSIONS/);
    expect(source).not.toMatch(/granted\s*=\s*signal/);
    expect(source).toContain('this.session.permissions()');
  });

  it('has no administrator fallback', () => {
    const offenders = PRODUCTION_FILES.filter((path) => {
      const source = read(path);

      // A role name decides nothing. Authority is a permission the server
      // granted, and roles are shown to the operator, never branched on.
      return (
        /===\s*'Administrator'/.test(source) ||
        /includes\(\s*'Administrator'\s*\)/.test(source) ||
        /isAdmin/.test(source)
      );
    });

    expect(offenders).toEqual([]);
  });

  /**
   * Browser storage holds display preferences and nothing else.
   *
   * Two files may touch it: the shell remembers whether the sidebar is
   * collapsed, and the theme remembers light or dark. Neither says anything
   * about who is signed in, and no third file is allowed to start.
   */
  it('never persists session material in the browser', () => {
    const allowed = [join('app', 'app.ts'), join('app', 'core', 'theme.ts')];

    const offenders = PRODUCTION_FILES.filter(
      (path) =>
        /localStorage|sessionStorage/.test(code(path)) &&
        !allowed.some((permitted) => path.endsWith(permitted)),
    );

    expect(offenders).toEqual([]);
  });

  it('keeps the permitted storage uses free of anything identifying', () => {
    for (const path of [join('app', 'app.ts'), join('app', 'core', 'theme.ts')]) {
      const source = code(join(SOURCE_ROOT, path));

      expect(source).not.toMatch(/(local|session)Storage\.setItem\([^)]*(token|csrf|user|email)/i);
    }
  });

  it('declares only permissions the control server issues', () => {
    const source = read(join(SOURCE_ROOT, 'app', 'core', 'permissions.ts'));

    // These have no permission on the server. Declaring one here would let the
    // interface offer an action nothing can carry out, and would look like
    // authority in review.
    for (const absent of [
      'containers.remove',
      'containers.exec',
      'containers.attach',
      'compose.operate',
      'images.read',
      'volumes.read',
      'networks.read',
      'events.read',
      'actions.read',
      'settings.manage',
    ]) {
      expect(source).not.toContain(`'${absent}'`);
    }
  });

  /**
   * Nothing that ships may import test data.
   *
   * A single import from the test harness would put invented records into a
   * production build, where they are indistinguishable from what a host really
   * reported. The double lives under `src/testing/` and stays there.
   */
  it('imports no test data into anything that ships', () => {
    const offenders = PRODUCTION_FILES.filter((path) =>
      /from\s+'[^']*(testing\/|fixture)/.test(code(path)),
    );

    expect(offenders).toEqual([]);
  });

  it('has no fixture provider left to wire', () => {
    const offenders = PRODUCTION_FILES.filter((path) => /FixtureApi/.test(read(path)));

    expect(offenders).toEqual([]);
  });

  it('binds the production application to the real control server', () => {
    const source = code(join(SOURCE_ROOT, 'app', 'app.config.ts'));

    expect(source).toContain('RealDockplaneApi');
    expect(source).not.toMatch(/Fixture|TestApi/);
  });

  /**
   * One-time secrets are held for as long as they are on screen and no longer.
   *
   * An enrollment token, a recovery code and a TOTP secret are each shown once
   * because the server keeps only a digest — or nothing at all. Writing any of
   * them to storage would quietly make them recoverable, which is exactly what
   * the one-time promise rules out.
   */
  it('never writes a one-time secret to storage', () => {
    const holders = [
      join('app', 'features', 'agents', 'enrollment-dialog.ts'),
      join('app', 'features', 'settings', 'security.ts'),
      join('app', 'ui', 'one-time-secret', 'one-time-secret.ts'),
    ];

    for (const path of holders) {
      const source = code(join(SOURCE_ROOT, path));

      expect(source).not.toMatch(/(local|session)Storage/);
      expect(source).not.toMatch(/indexedDB/i);
    }
  });

  it('keeps one-time secrets out of the URL', () => {
    const source = code(join(SOURCE_ROOT, 'app', 'features', 'agents', 'enrollment-dialog.ts'));

    // A token in a query parameter survives in history, in a bookmark and in
    // whatever logs the address.
    expect(source).not.toMatch(/queryParams|navigate\(.*token/i);
  });

  it('clears what it held when the view goes away', () => {
    for (const path of [
      join('app', 'features', 'agents', 'enrollment-dialog.ts'),
      join('app', 'features', 'settings', 'security.ts'),
    ]) {
      expect(code(join(SOURCE_ROOT, path))).toContain('ngOnDestroy');
    }
  });

  it('sends no credential in a header the interface controls', () => {
    const offenders = PRODUCTION_FILES.filter((path) =>
      /setHeaders:\s*\{[^}]*[Aa]uthorization/.test(read(path)),
    );

    expect(offenders).toEqual([]);
  });
});
