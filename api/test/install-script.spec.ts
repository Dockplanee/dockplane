import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  UnreleasedAgentVersionError,
  debianVersion,
  renderInstallScript,
  resolveAgentVersion,
} from '../src/host-setup/install-script';

const OPTIONS = {
  releaseBaseUrl: 'https://github.com/Dockplanee/dockplane/releases/download',
  agentVersion: '0.1.0-rc.2',
  controlPlaneUrl: 'https://dockplane.example.com',
  enrollmentToken: 'kEyQ3Zt6Xr9wA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU',
};

/**
 * The script runs as root on somebody else's machine.
 *
 * These are the properties that matter before it ever gets there: that it
 * parses, that it stops rather than guessing, and that the credential it
 * carries reaches the agent without passing through an argument list.
 */
describe('the install script', () => {
  it('is valid shell', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dockplane-install-script-'));
    const path = join(directory, 'install.sh');

    try {
      writeFileSync(path, renderInstallScript(OPTIONS));
      execFileSync('bash', ['-n', path]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('stops on the first failure rather than continuing', () => {
    expect(renderInstallScript(OPTIONS)).toContain('set -euo pipefail');
  });

  it('pins the agent version and never asks for the newest', () => {
    const script = renderInstallScript(OPTIONS);

    expect(script).toContain("AGENT_VERSION='0.1.0-rc.2'");
    expect(script).toContain("PACKAGE_VERSION='0.1.0~rc.2'");
    expect(script).not.toContain('latest');
  });

  it('names a Debian pre-release the way dpkg orders it', () => {
    expect(debianVersion('0.1.0-rc.2')).toBe('0.1.0~rc.2');
    expect(debianVersion('0.1.0')).toBe('0.1.0');
  });

  it('reads the release from the configured source and nowhere else', () => {
    const script = renderInstallScript({
      ...OPTIONS,
      releaseBaseUrl: 'http://localhost:47260/releases/download',
    });

    expect(script).toContain("RELEASE_BASE_URL='http://localhost:47260/releases/download'");
    expect(script).not.toContain('raw.githubusercontent.com');
  });

  it('hands the enrollment token to the agent on standard input', () => {
    const script = renderInstallScript(OPTIONS);

    expect(script).toContain('--token-stdin');
    expect(script).toContain(`printf '%s' '${OPTIONS.enrollmentToken}'`);

    // Never an argument, an environment variable or a file.
    expect(script).not.toContain(`--token ${OPTIONS.enrollmentToken}`);
    expect(script).not.toContain(`DOCKPLANE_ENROLLMENT_TOKEN=${OPTIONS.enrollmentToken}`);
    expect(script).not.toContain(`--token-file`);
  });

  it('verifies the download before it installs it', () => {
    const script = renderInstallScript(OPTIONS);

    expect(script.indexOf('sha256sum')).toBeLessThan(script.indexOf('dpkg -i'));
    expect(script).toContain('checksum mismatch');
  });

  it('refuses architectures it has no package for', () => {
    const script = renderInstallScript(OPTIONS);

    expect(script).toContain('x86_64) ARCH=amd64');
    expect(script).toContain('aarch64 | arm64) ARCH=arm64');
    expect(script).toContain('unsupported architecture');
  });

  it('says what arm64 is worth', () => {
    expect(renderInstallScript(OPTIONS)).toContain('arm64 is experimental');
  });

  it('refuses distributions the package does not support', () => {
    const script = renderInstallScript(OPTIONS);

    expect(script).toContain('ubuntu:24.04 | ubuntu:22.04 | debian:12');
    expect(script).toContain('unsupported distribution');
  });

  it('refuses to install Docker on somebody’s behalf', () => {
    const script = renderInstallScript(OPTIONS);

    expect(script).toContain('Docker Engine is not installed');
    expect(script).not.toMatch(/apt(-get)? install .*docker/);
  });

  it('leaves an existing identity alone', () => {
    const script = renderInstallScript(OPTIONS);

    expect(script).toContain('already enrolled');
    expect(script.indexOf('already enrolled')).toBeLessThan(script.indexOf('dpkg -i'));
  });

  it('removes what it downloaded', () => {
    const script = renderInstallScript(OPTIONS);

    expect(script).toContain('trap cleanup EXIT');
    expect(script).toContain('rm -rf "$work"');
  });

  describe('what it refuses to be built from', () => {
    it('rejects a release source that is not a URL', () => {
      expect(() => renderInstallScript({ ...OPTIONS, releaseBaseUrl: 'file:///tmp/x' })).toThrow();
      expect(() =>
        renderInstallScript({ ...OPTIONS, releaseBaseUrl: "https://x/'; id; '" }),
      ).toThrow();
    });

    it('rejects a version that is not a version', () => {
      expect(() => renderInstallScript({ ...OPTIONS, agentVersion: 'latest' })).toThrow();
      expect(() => renderInstallScript({ ...OPTIONS, agentVersion: "0.1.0'; id; '" })).toThrow();
    });

    it('refuses to name a version nobody released', () => {
      expect(() => resolveAgentVersion('', '0.0.0-dev')).toThrow(UnreleasedAgentVersionError);
      expect(() => resolveAgentVersion('', '0.1.0-rc.1-dirty')).toThrow(UnreleasedAgentVersionError);
      expect(() => resolveAgentVersion('latest', '0.1.0')).toThrow(UnreleasedAgentVersionError);

      expect(resolveAgentVersion('', '0.1.0-rc.2')).toBe('0.1.0-rc.2');
      expect(resolveAgentVersion('', '0.1.0')).toBe('0.1.0');
      // An explicit setting wins, which is how a local rehearsal is done.
      expect(resolveAgentVersion('0.1.0-rc.2', '0.0.0-dev')).toBe('0.1.0-rc.2');
    });

    it('rejects a token that could close a quote', () => {
      expect(() => renderInstallScript({ ...OPTIONS, enrollmentToken: "abc'; id; '" })).toThrow();
      expect(() => renderInstallScript({ ...OPTIONS, enrollmentToken: 'abc def' })).toThrow();
    });
  });
});
