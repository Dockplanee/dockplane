/**
 * What this build is.
 *
 * Baked in at build time rather than read at runtime: a deployment has to be
 * able to say which code it is running even when the repository it came from
 * is nowhere near it. An unstamped build reports `0.0.0-dev`, which is
 * deliberately not a plausible release number.
 */
export interface BuildInfo {
  /** The Dockplane release this build belongs to. */
  readonly version: string;
  /** The commit it was built from, or `unknown`. */
  readonly commit: string;
  /** When it was built, ISO 8601, or `unknown`. */
  readonly buildDate: string;
}

export const BUILD_INFO: BuildInfo = {
  version: process.env.DOCKPLANE_VERSION?.trim() || '0.0.0-dev',
  commit: process.env.DOCKPLANE_COMMIT?.trim() || 'unknown',
  buildDate: process.env.DOCKPLANE_BUILD_DATE?.trim() || 'unknown',
};
