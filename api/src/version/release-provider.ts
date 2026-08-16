import { z } from 'zod';

import { parseVersion } from './semver';

/**
 * Where a published release version comes from.
 *
 * The rest of Dockplane knows this contract and not the upstream behind it.
 * That is the point: an available-version check is the only outbound request
 * this product makes, and confining it to one implementation is what makes the
 * claim about what leaves the installation checkable rather than asserted.
 */
export interface ReleaseVersionProvider {
  /**
   * The newest published stable release.
   *
   * Null means the upstream answered and had nothing usable to say — no
   * release, or one whose version cannot be read. A failure to reach or
   * understand the upstream throws, so a caller can tell "there is no update"
   * apart from "nobody knows".
   */
  latestStable(): Promise<PublishedRelease | null>;
}

export interface PublishedRelease {
  readonly version: string;
  /** Where a person can read about it, when the upstream offers a link. */
  readonly url: string | null;
}

/**
 * The project's own releases.
 *
 * Fixed rather than configurable. A version check that could be pointed
 * somewhere else is a way to tell an installation that a version exists which
 * does not, and in v0.3 there is no need that would justify it.
 */
export const RELEASE_ENDPOINT = 'https://api.github.com/repos/Dockplanee/dockplane/releases/latest';

/** Longest the check may take before it is abandoned. */
const TIMEOUT_MS = 5_000;

/**
 * Most that will be read from the upstream.
 *
 * A release description is a few kilobytes; anything approaching this is not a
 * release listing, and reading it to the end would be the upstream deciding how
 * much memory this process uses.
 */
const MAX_BYTES = 256 * 1024;

/**
 * Only the fields a version check needs.
 *
 * Everything else the upstream returns — author, assets, body, reactions — is
 * left unread rather than parsed and discarded, so a change on their side
 * cannot widen what this holds.
 */
const releaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.url().optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
});

async function readCapped(response: Response): Promise<string> {
  const body = response.body;

  if (!body) {
    return '';
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;
      if (!value) continue;

      size += value.byteLength;

      if (size > MAX_BYTES) {
        throw new Error('release response is larger than expected');
      }

      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Reads the newest release from the project's release listing.
 *
 * The request carries nothing about the installation making it: no identifier,
 * no hostname, no counts, no query string. It is the same request any reader of
 * the public release page makes, and the response is read for four fields.
 */
export class PublishedReleaseProvider implements ReleaseVersionProvider {
  constructor(private readonly endpoint: string = RELEASE_ENDPOINT) {}

  async latestStable(): Promise<PublishedRelease | null> {
    const response = await fetch(this.endpoint, {
      method: 'GET',
      // A redirect is how a request ends up at a host nobody allowed.
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        accept: 'application/vnd.github+json',
        // Required by the upstream, and deliberately says nothing about who is
        // asking: no version, no instance, no contact address.
        'user-agent': 'Dockplane',
      },
    });

    if (!response.ok) {
      throw new Error(`release listing answered ${response.status}`);
    }

    const parsed = releaseSchema.safeParse(JSON.parse(await readCapped(response)));

    if (!parsed.success) {
      throw new Error('release listing was not in the expected shape');
    }

    const release = parsed.data;

    // The upstream's "latest" already excludes these; a listing that carries
    // one anyway is not something to announce as a stable release.
    if (release.draft || release.prerelease) {
      return null;
    }

    const version = parseVersion(release.tag_name);

    if (!version) {
      return null;
    }

    return {
      version: release.tag_name.trim().replace(/^v/, ''),
      url: release.html_url ?? null,
    };
  }
}
