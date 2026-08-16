/**
 * Version ordering.
 *
 * Comparing releases as strings puts 0.10.0 before 0.9.0 and a release before
 * its own candidate, which is exactly backwards in both cases. This implements
 * the precedence rules of Semantic Versioning 2.0.0: numeric identifiers
 * compare numerically, alphanumeric ones compare in ASCII order, a version
 * carrying a prerelease is lower than the same version without one, and build
 * metadata takes no part in ordering at all.
 *
 * Nothing here guesses. A version that does not parse compares to nothing, so
 * an unrecognised agent build is reported as unknown rather than pushed to one
 * end of the ordering and announced as out of date.
 */

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated prerelease identifiers, empty for a stable release. */
  readonly prerelease: readonly string[];
}

const PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Reads a version, or returns null.
 *
 * A leading `v` is accepted because that is how the releases are tagged; the
 * grammar is otherwise the specification's own, so `1.0` and `1.0.0.1` are
 * refused rather than interpreted.
 */
export function parseVersion(value: string | null | undefined): ParsedVersion | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = PATTERN.exec(value.trim());

  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

const NUMERIC = /^(0|[1-9]\d*)$/;

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  // A release outranks any of its own candidates; two releases are equal here.
  if (a.length === 0 || b.length === 0) {
    return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  }

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index];
    const right = b[index];

    // The shorter identifier list is the lower version when all else matches.
    if (left === undefined) return -1;
    if (right === undefined) return 1;

    const leftNumeric = NUMERIC.test(left);
    const rightNumeric = NUMERIC.test(right);

    if (leftNumeric && rightNumeric) {
      const difference = Number(left) - Number(right);
      if (difference !== 0) return difference < 0 ? -1 : 1;
      continue;
    }

    // Numeric identifiers always rank below alphanumeric ones.
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }

    if (left !== right) {
      return left < right ? -1 : 1;
    }
  }

  return 0;
}

/**
 * Orders two parsed versions: -1, 0 or 1.
 */
export function compareParsed(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  const positional = a.major - b.major || a.minor - b.minor || a.patch - b.patch;

  if (positional !== 0) {
    return positional < 0 ? -1 : 1;
  }

  const prerelease = comparePrerelease(a.prerelease, b.prerelease);

  return prerelease === 0 ? 0 : prerelease < 0 ? -1 : 1;
}

/**
 * Orders two version strings, or returns null if either cannot be read.
 *
 * Null is a real answer rather than a failure: it is what stops an unreadable
 * version from producing an update notice nobody can act on.
 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined) {
  const left = parseVersion(a);
  const right = parseVersion(b);

  return left && right ? compareParsed(left, right) : null;
}

/** Whether `candidate` is newer than `current`, or null when either is unreadable. */
export function isNewer(
  candidate: string | null | undefined,
  current: string | null | undefined,
): boolean | null {
  const order = compareVersions(candidate, current);

  return order === null ? null : order > 0;
}
