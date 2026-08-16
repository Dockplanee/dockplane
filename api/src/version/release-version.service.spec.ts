import { AppConfig } from '../config/configuration';
import { PublishedRelease, ReleaseVersionProvider } from './release-provider';
import { ReleaseVersionService } from './release-version.service';

/**
 * The cached check, without a network.
 *
 * The provider here counts how often it is consulted, which is what the
 * important assertions are about: an installation that did not ask for the
 * check never consults it at all, and one that did consults it on an interval
 * rather than on a page load.
 */

class CountingProvider implements ReleaseVersionProvider {
  calls = 0;
  answer: () => Promise<PublishedRelease | null> = async () => ({ version: '0.4.0', url: null });

  async latestStable(): Promise<PublishedRelease | null> {
    this.calls += 1;
    return this.answer();
  }
}

const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };

function service(enabled: boolean, provider: ReleaseVersionProvider) {
  return new ReleaseVersionService(
    { UPDATE_CHECK_ENABLED: enabled } as AppConfig,
    provider,
    logger as never,
  );
}

const HOUR = 60 * 60 * 1000;
let clock: jest.SpyInstance<number, []>;
let now: number;

beforeEach(() => {
  now = Date.parse('2026-08-16T12:00:00Z');
  clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  logger.warn.mockClear();
});

afterEach(() => clock.mockRestore());

describe('when the check has not been turned on', () => {
  it('never consults the provider', async () => {
    const provider = new CountingProvider();
    const status = await service(false, provider).status();

    expect(provider.calls).toBe(0);
    expect(status.state).toBe('disabled');
    expect(status.latestStableVersion).toBeNull();
    expect(status.updateAvailable).toBeNull();
    expect(status.checkedAt).toBeNull();
  });

  it('goes on never consulting it however often it is asked', async () => {
    const provider = new CountingProvider();
    const releases = service(false, provider);

    for (let i = 0; i < 25; i += 1) {
      await releases.status();
    }

    expect(provider.calls).toBe(0);
  });
});

describe('when the check has been turned on', () => {
  it('reports the published version', async () => {
    const provider = new CountingProvider();
    provider.answer = async () => ({ version: '0.4.0', url: 'https://example.test/0.4.0' });

    const status = await service(true, provider).status();

    expect(status.state).toBe('ok');
    expect(status.latestStableVersion).toBe('0.4.0');
    expect(status.releaseUrl).toBe('https://example.test/0.4.0');
    expect(status.checkedAt).toBe('2026-08-16T12:00:00.000Z');
    expect(status.stale).toBe(false);
  });

  it('compares against the running build', async () => {
    const provider = new CountingProvider();

    // The build under test is unstamped, which is below every release.
    provider.answer = async () => ({ version: '0.4.0', url: null });
    expect((await service(true, provider).status()).updateAvailable).toBe(true);

    provider.answer = async () => ({ version: '0.0.0-dev', url: null });
    expect((await service(true, provider).status()).updateAvailable).toBe(false);
  });

  it('asks once and answers from what it has', async () => {
    const provider = new CountingProvider();
    const releases = service(true, provider);

    await releases.status();
    await releases.status();
    await releases.status();

    expect(provider.calls).toBe(1);
  });

  it('asks again once the answer is old', async () => {
    const provider = new CountingProvider();
    const releases = service(true, provider);

    await releases.status();
    now += 6 * HOUR;
    await releases.status();

    expect(provider.calls).toBe(2);
  });

  // Twenty browsers opening the page at once is one request, not twenty.
  it('runs one check however many callers are waiting', async () => {
    const provider = new CountingProvider();
    let release: (value: PublishedRelease) => void = () => undefined;
    provider.answer = () => new Promise((resolve) => (release = resolve));

    const releases = service(true, provider);
    const waiting = [releases.status(), releases.status(), releases.status()];

    release({ version: '0.4.0', url: null });
    const answers = await Promise.all(waiting);

    expect(provider.calls).toBe(1);
    expect(answers.every((answer) => answer.state === 'ok')).toBe(true);
  });
});

describe('when the upstream cannot answer', () => {
  it('says so rather than failing', async () => {
    const provider = new CountingProvider();
    provider.answer = async () => {
      throw new Error('connect ECONNREFUSED');
    };

    const status = await service(true, provider).status();

    expect(status.state).toBe('unavailable');
    expect(status.latestStableVersion).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does not ask again on every request', async () => {
    const provider = new CountingProvider();
    provider.answer = async () => {
      throw new Error('down');
    };

    const releases = service(true, provider);
    await releases.status();
    await releases.status();
    await releases.status();

    expect(provider.calls).toBe(1);

    now += 15 * 60 * 1000;
    await releases.status();
    expect(provider.calls).toBe(2);
  });

  it('goes on showing the last answer, and says it is old', async () => {
    const provider = new CountingProvider();
    const releases = service(true, provider);

    await releases.status();

    provider.answer = async () => {
      throw new Error('down');
    };

    now += 7 * HOUR;
    const status = await releases.status();

    expect(status.state).toBe('ok');
    expect(status.latestStableVersion).toBe('0.4.0');
    expect(status.stale).toBe(true);
    expect(status.checkedAt).toBe('2026-08-16T12:00:00.000Z');
  });

  it('reports an upstream with nothing usable to say', async () => {
    const provider = new CountingProvider();
    provider.answer = async () => null;

    const status = await service(true, provider).status();

    expect(status.state).toBe('unsupported');
    expect(status.latestStableVersion).toBeNull();
    expect(status.updateAvailable).toBeNull();
  });
});
