/**
 * What this browser bundle is.
 *
 * The application and the control server are two artefacts, deployed from two
 * images, and an operator who pins one of them to a different tag is running
 * two revisions. Showing the server's version as "the Dockplane version" would
 * hide exactly that, so the bundle carries its own.
 *
 * The values are replaced at build time — see the `build` script, which passes
 * them from the release's version and commit. There is no build clock, no host
 * name and no path here: the same source and the same release produce the same
 * bundle, which is what the reproducibility contract requires.
 *
 * A bundle built without them says so rather than guessing. `typeof` is what
 * makes that safe: unreplaced, these identifiers do not exist at all, and
 * reading one directly would throw before the application starts.
 */

declare const DOCKPLANE_WEB_VERSION: string;
declare const DOCKPLANE_WEB_COMMIT: string;

function injected(read: () => string, fallback: string): string {
  const value = read();

  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export interface WebBuildInfo {
  readonly version: string;
  readonly commit: string;
}

export const WEB_BUILD: WebBuildInfo = {
  version: injected(
    () => (typeof DOCKPLANE_WEB_VERSION === 'string' ? DOCKPLANE_WEB_VERSION : ''),
    '0.0.0-dev',
  ),
  commit: injected(
    () => (typeof DOCKPLANE_WEB_COMMIT === 'string' ? DOCKPLANE_WEB_COMMIT : ''),
    'unknown',
  ),
};
