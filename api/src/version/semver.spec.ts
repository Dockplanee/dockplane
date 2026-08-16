import { compareVersions, isNewer, parseVersion } from './semver';

describe('version parsing', () => {
  it('reads a release', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });

  it('reads the tag form', () => {
    expect(parseVersion('v0.3.0')).toEqual({ major: 0, minor: 3, patch: 0, prerelease: [] });
  });

  it('reads a candidate', () => {
    expect(parseVersion('0.3.0-rc.4')).toEqual({
      major: 0,
      minor: 3,
      patch: 0,
      prerelease: ['rc', '4'],
    });
  });

  it('ignores build metadata', () => {
    expect(parseVersion('1.0.0+build.5')?.prerelease).toEqual([]);
  });

  // Guessing at a malformed version is what produces an update notice for a
  // release that does not exist.
  it.each(['', '1.0', '1.0.0.1', '01.0.0', 'latest', 'v', 'nightly-2026-08-16'])(
    'refuses %p',
    (value) => {
      expect(parseVersion(value)).toBeNull();
    },
  );

  it.each([null, undefined, 42, {}])('refuses the non-string %p', (value) => {
    expect(parseVersion(value as string | null | undefined)).toBeNull();
  });
});

describe('version ordering', () => {
  it('orders by number and not by string', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
  });

  it('ranks a release above its own candidate', () => {
    expect(compareVersions('0.3.0', '0.3.0-rc.4')).toBe(1);
    expect(compareVersions('0.3.0-rc.4', '0.3.0')).toBe(-1);
  });

  it('orders candidates numerically', () => {
    expect(compareVersions('0.3.0-rc.10', '0.3.0-rc.2')).toBe(1);
  });

  it('ranks a numeric identifier below an alphanumeric one', () => {
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
  });

  it('ranks a longer identifier list above its prefix', () => {
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha')).toBe(1);
  });

  // The precedence example from the specification, in order.
  it('reproduces the specification ordering', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];

    for (let index = 1; index < ordered.length; index += 1) {
      expect(compareVersions(ordered[index], ordered[index - 1])).toBe(1);
    }
  });

  it('treats build metadata as equal', () => {
    expect(compareVersions('1.0.0+a', '1.0.0+b')).toBe(0);
  });

  it('has no opinion about a version it cannot read', () => {
    expect(compareVersions('0.3.0', 'nightly')).toBeNull();
    expect(compareVersions(null, '0.3.0')).toBeNull();
  });
});

describe('newer than', () => {
  it('answers the question the update check asks', () => {
    expect(isNewer('0.4.0', '0.3.0')).toBe(true);
    expect(isNewer('0.3.0', '0.3.0')).toBe(false);
    expect(isNewer('0.2.0', '0.3.0')).toBe(false);
  });

  // A development build is not a release, and claiming an update against one
  // would tell an operator to downgrade.
  it('declines to answer for an unstamped build', () => {
    expect(isNewer('0.3.0', '0.0.0-dev')).toBe(true);
    expect(isNewer('0.3.0', 'unknown')).toBeNull();
  });
});
