import { EnvironmentVariable, StackConfiguration } from '../../data/dockplane-api';

/**
 * What changes between two revisions.
 *
 * A line-based comparison of the Compose source and a per-variable comparison
 * of the environment. Nothing here parses YAML: a diff that understood the file
 * would have to agree with the compiler about what it means, and two things
 * that have to agree eventually disagree.
 *
 * Secrets are the interesting case. The browser is never shown a stored secret,
 * so it cannot tell whether the value behind two revisions' `DB_PASSWORD` is
 * the same — and it must not try. A secret that exists in both revisions is
 * reported as being configured in both, which is the whole of what can honestly
 * be said without revealing one.
 */

export type LineKind = 'context' | 'added' | 'removed';

export interface DiffLine {
  readonly kind: LineKind;
  readonly text: string;
}

export type EnvironmentChangeKind =
  'added' | 'removed' | 'changed' | 'secret_added' | 'secret_removed' | 'secret_unknown';

export interface EnvironmentDiffEntry {
  readonly key: string;
  readonly kind: EnvironmentChangeKind;
  /** Only ever set for values that are not secret. */
  readonly from?: string;
  readonly to?: string;
}

export interface RevisionDiff {
  readonly compose: readonly DiffLine[];
  readonly environment: readonly EnvironmentDiffEntry[];
  /** True when neither the file nor the environment differs. */
  readonly identical: boolean;
}

export function diffRevisions(from: StackConfiguration, to: StackConfiguration): RevisionDiff {
  const compose = diffLines(from.compose, to.compose);
  const environment = diffEnvironment(from.environment, to.environment);

  return {
    compose,
    environment,
    identical: environment.length === 0 && compose.every((line) => line.kind === 'context'),
  };
}

/**
 * A line-based comparison, by longest common subsequence.
 *
 * Enough for a Compose file, which is small and edited by hand. The alternative
 * — a word-level or semantic diff — would be more code to be wrong in, for a
 * file where the unit somebody thinks in is the line anyway.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const left = before.split('\n');
  const right = after.split('\n');

  const lengths: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );

  for (let index = left.length - 1; index >= 0; index -= 1) {
    for (let position = right.length - 1; position >= 0; position -= 1) {
      lengths[index][position] =
        left[index] === right[position]
          ? lengths[index + 1][position + 1] + 1
          : Math.max(lengths[index + 1][position], lengths[index][position + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let index = 0;
  let position = 0;

  while (index < left.length && position < right.length) {
    if (left[index] === right[position]) {
      lines.push({ kind: 'context', text: left[index] });
      index += 1;
      position += 1;
    } else if (lengths[index + 1][position] >= lengths[index][position + 1]) {
      lines.push({ kind: 'removed', text: left[index] });
      index += 1;
    } else {
      lines.push({ kind: 'added', text: right[position] });
      position += 1;
    }
  }

  for (; index < left.length; index += 1) {
    lines.push({ kind: 'removed', text: left[index] });
  }

  for (; position < right.length; position += 1) {
    lines.push({ kind: 'added', text: right[position] });
  }

  return lines;
}

export function diffEnvironment(
  before: readonly EnvironmentVariable[],
  after: readonly EnvironmentVariable[],
): EnvironmentDiffEntry[] {
  const left = new Map(before.map((variable) => [variable.key, variable]));
  const right = new Map(after.map((variable) => [variable.key, variable]));
  const entries: EnvironmentDiffEntry[] = [];

  for (const [key, variable] of right) {
    const previous = left.get(key);

    if (!previous) {
      entries.push({
        key,
        kind: variable.secret ? 'secret_added' : 'added',
        ...(variable.secret ? {} : { to: variable.value ?? '' }),
      });

      continue;
    }

    if (variable.secret || previous.secret) {
      /*
       * Two secrets, or one that became a secret. Whether the value behind them
       * differs is not something this side can see, and finding out would mean
       * being shown both — which is the one thing a secret is stored to prevent.
       */
      entries.push({ key, kind: 'secret_unknown' });
      continue;
    }

    if ((previous.value ?? '') !== (variable.value ?? '')) {
      entries.push({
        key,
        kind: 'changed',
        from: previous.value ?? '',
        to: variable.value ?? '',
      });
    }
  }

  for (const [key, variable] of left) {
    if (!right.has(key)) {
      entries.push({
        key,
        kind: variable.secret ? 'secret_removed' : 'removed',
        ...(variable.secret ? {} : { from: variable.value ?? '' }),
      });
    }
  }

  return entries.sort((first, second) => first.key.localeCompare(second.key));
}

/** What each kind of environment change is called, in words. */
export const ENVIRONMENT_CHANGE_LABELS: Record<EnvironmentChangeKind, string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  secret_added: 'Secret added',
  secret_removed: 'Secret removed',
  secret_unknown: 'Secret in both revisions',
};
