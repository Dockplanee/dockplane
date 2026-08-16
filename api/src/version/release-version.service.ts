import { Inject, Injectable } from '@nestjs/common';
import { Logger } from 'pino';

import { AppConfig, CONFIG } from '../config/configuration';
import { LOGGER } from '../config/tokens';
import { BUILD_INFO } from './build-info';
import { ReleaseVersionProvider } from './release-provider';
import { isNewer } from './semver';

export const RELEASE_PROVIDER = Symbol('DOCKPLANE_RELEASE_PROVIDER');

/**
 * What is known about a published version, and how much that is worth.
 *
 * `disabled` is the shipped state and is not a failure: nobody asked for the
 * check, so nothing was asked of anybody. `unavailable` means the check ran and
 * could not answer, which is different again from `ok` with `updateAvailable`
 * false — the first is silence, the second is an answer.
 */
export type UpdateCheckState = 'disabled' | 'unknown' | 'ok' | 'unavailable' | 'unsupported';

export interface UpdateCheckStatus {
  readonly state: UpdateCheckState;
  readonly latestStableVersion: string | null;
  readonly releaseUrl: string | null;
  /** When the last answer was obtained, ISO 8601. */
  readonly checkedAt: string | null;
  /** Only meaningful in the `ok` state; null when no comparison could be made. */
  readonly updateAvailable: boolean | null;
  /** Whether what is shown is older than the check interval. */
  readonly stale: boolean;
}

const DISABLED: UpdateCheckStatus = {
  state: 'disabled',
  latestStableVersion: null,
  releaseUrl: null,
  checkedAt: null,
  updateAvailable: null,
  stale: false,
};

/** How long an answer is used before the upstream is asked again. */
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * How long a failure is remembered.
 *
 * Long enough that an upstream which is down does not receive a request per
 * page load, short enough that a transient failure is not carried for hours.
 */
const FAILURE_TTL_MS = 15 * 60 * 1000;

interface Answer {
  readonly at: number;
  readonly release: { readonly version: string; readonly url: string | null } | null;
}

/**
 * The optional check for a newer published version.
 *
 * Off unless an administrator turns it on, and off is the whole behaviour: the
 * provider is never consulted, so the process makes no outbound request at all.
 * Nothing here installs, downloads or changes anything — the result is a
 * sentence an operator reads.
 *
 * Answers are cached and shared. One request is in flight at a time however
 * many callers are waiting, a failure is remembered so a downed upstream is not
 * asked once per page load, and the last good answer goes on being shown while
 * a later check fails, marked as what it is.
 */
@Injectable()
export class ReleaseVersionService {
  private answer: Answer | null = null;
  private failedAt: number | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(RELEASE_PROVIDER) private readonly provider: ReleaseVersionProvider,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  get enabled(): boolean {
    return this.config.UPDATE_CHECK_ENABLED;
  }

  async status(): Promise<UpdateCheckStatus> {
    if (!this.enabled) {
      return DISABLED;
    }

    if (this.shouldCheck()) {
      await this.check();
    }

    return this.describe();
  }

  private shouldCheck(): boolean {
    const now = Date.now();

    if (this.answer && now - this.answer.at < SUCCESS_TTL_MS) {
      return false;
    }

    return this.failedAt === null || now - this.failedAt >= FAILURE_TTL_MS;
  }

  /** Runs one check, and joins the running one rather than starting a second. */
  private async check(): Promise<void> {
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = null;
    });

    await this.inFlight;
  }

  private async run(): Promise<void> {
    try {
      const release = await this.provider.latestStable();

      this.answer = { at: Date.now(), release };
      this.failedAt = null;
    } catch (error) {
      // A version check that cannot reach anyone is not an incident: it is
      // logged once per interval and the product carries on.
      this.failedAt = Date.now();
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'update check did not complete',
      );
    }
  }

  private describe(): UpdateCheckStatus {
    if (!this.answer) {
      return {
        ...DISABLED,
        state: this.failedAt === null ? 'unknown' : 'unavailable',
      };
    }

    const stale = Date.now() - this.answer.at >= SUCCESS_TTL_MS;
    const checkedAt = new Date(this.answer.at).toISOString();

    if (!this.answer.release) {
      return {
        state: 'unsupported',
        latestStableVersion: null,
        releaseUrl: null,
        checkedAt,
        updateAvailable: null,
        stale,
      };
    }

    return {
      state: 'ok',
      latestStableVersion: this.answer.release.version,
      releaseUrl: this.answer.release.url,
      checkedAt,
      updateAvailable: isNewer(this.answer.release.version, BUILD_INFO.version),
      stale,
    };
  }
}
