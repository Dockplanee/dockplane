export type ChangeType = 'Added' | 'Changed' | 'Fixed' | 'Removed' | 'Security';

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
