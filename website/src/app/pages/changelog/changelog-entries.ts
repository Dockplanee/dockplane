/**
 * The sections a release may be divided into.
 *
 * The Keep a Changelog set, plus the one this project needs: a release that
 * ships with something it cannot yet do says so on the same page as what it
 * added. Kept in step with CHANGE_TYPES in scripts/generate-changelog.mjs,
 * which refuses a heading that is not listed in both.
 */
export type ChangeType =
  | 'Added'
  | 'Changed'
  | 'Deprecated'
  | 'Fixed'
  | 'Removed'
  | 'Security'
  | 'Known limitations';

export interface ChangeGroup {
  readonly type: ChangeType;
  readonly items: readonly string[];
}

export interface ChangelogRelease {
  /** Release name, or `Unreleased` for work that has not shipped yet. */
  readonly version: string;
  /** ISO date of the release. Omitted while a release is still unpublished. */
  readonly date?: string;
  readonly changes: readonly ChangeGroup[];
}
