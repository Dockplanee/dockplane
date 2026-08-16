import { Controller, Get } from '@nestjs/common';

import { AuthenticatedUser } from '../auth/authenticated-request';
import { CurrentUser } from '../auth/current-user.decorator';
import { InstalledVersions, SystemVersionService } from './system-version.service';
import { ReleaseVersionService, UpdateCheckStatus } from './release-version.service';

/**
 * The versions an operator can be shown.
 *
 * Two endpoints rather than one object, because they answer to different
 * things. What is installed is read from this build and this database and
 * always available; whether a newer release exists depends on a check that is
 * off by default and can fail. Putting them together would make a local fact
 * wait on a network call, which is the failure mode this separation removes.
 *
 * Both require a session. The unauthenticated `/api/v1/version` continues to
 * report what a deployment must be able to say before anyone signs in, and
 * nothing here widens it: the agent summary is the one piece of information
 * that is new, and it is behind the permission that governs the agents.
 */
@Controller('api/v1/system')
export class SystemVersionController {
  constructor(
    private readonly versions: SystemVersionService,
    private readonly releases: ReleaseVersionService,
  ) {}

  @Get('versions')
  async installed(@CurrentUser() user: AuthenticatedUser): Promise<InstalledVersions> {
    return this.versions.installed({ includeAgents: user.permissions.has('agents.read') });
  }

  /**
   * Whether a newer release has been published.
   *
   * Disabled unless an administrator turned the check on, and the disabled
   * answer is produced without reaching for the network at all.
   */
  @Get('update-check')
  async updateCheck(): Promise<UpdateCheckStatus> {
    return this.releases.status();
  }
}
