import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { z } from 'zod';

import { AuthenticatedRequest, AuthenticatedUser } from '../auth/authenticated-request';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import { CredentialThrottlerGuard } from '../auth/throttling';
import { AppError } from '../common/errors';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AppConfig, CONFIG } from '../config/configuration';
import { RequirePermissions } from '../rbac/permissions.decorator';
import { BUILD_INFO } from '../version/build-info';
import { HostSetupService } from './host-setup.service';
import {
  UnreleasedAgentVersionError,
  renderInstallScript,
  resolveAgentVersion,
} from './install-script';

const setupIdSchema = z.uuid();

const createSchema = z.object({
  /** The operator's own name for the machine. Optional, and never an identity. */
  displayName: z.string().max(120).optional(),
});

/**
 * The bootstrap ticket arrives in the body, never in the path or the query.
 *
 * A URL is written down by everything it passes through — proxy access logs,
 * server logs, browser history, error reporters. A request body is not. The
 * ticket is short-lived and single-use regardless, but there is no reason to
 * spread it across infrastructure that was never meant to hold a credential.
 */
const bootstrapSchema = z.object({
  ticket: z.string().min(20).max(512),
});

function context(request: AuthenticatedRequest) {
  return { sourceIp: request.ip, userAgent: request.header('user-agent') };
}

/**
 * Adding a host.
 *
 * Creating a setup mints an enrollment credential, so it takes the permission
 * that already means exactly that — `agents.enroll`. A separate permission for
 * the same capability would be two names an administrator has to keep in step.
 */
@Controller('api/v1/host-setups')
export class HostSetupController {
  constructor(private readonly setups: HostSetupService) {}

  @Get()
  @RequirePermissions('agents.enroll')
  async list() {
    return { setups: await this.setups.list() };
  }

  /**
   * Creates a setup and returns its bootstrap ticket.
   *
   * The raw ticket is in this response and nowhere else: only its digest is
   * stored, so it cannot be shown again or recovered from the database. An
   * operator who loses it regenerates, which invalidates the one they lost.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('agents.enroll')
  async create(
    @Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.setups.create(user, { displayName: body.displayName }, context(request));
  }

  @Get(':id')
  @RequirePermissions('agents.enroll')
  async get(@Param('id', new ZodValidationPipe(setupIdSchema)) id: string) {
    return this.setups.get(id);
  }

  @Post(':id/regenerate')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('agents.enroll')
  async regenerate(
    @Param('id', new ZodValidationPipe(setupIdSchema)) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.setups.regenerate(id, user, context(request));
  }

  @Post(':id/cancel')
  @RequirePermissions('agents.enroll')
  async cancel(
    @Param('id', new ZodValidationPipe(setupIdSchema)) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.setups.cancel(id, user, context(request));
  }
}

/**
 * The bootstrap.
 *
 * Unauthenticated, because the machine being added has no session and no
 * identity yet: the one-time ticket is the entire authorisation, and it is spent
 * on first use. One fixed address for every host, with the ticket in the body,
 * so nothing about which machine is being added ends up in a URL.
 *
 * The response carries an enrollment token. It is not cached, not logged and not
 * written to disk on either side.
 */
@Controller('api/v1/host-setups')
export class HostBootstrapController {
  constructor(
    private readonly setups: HostSetupService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('bootstrap')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CredentialThrottlerGuard)
  @Throttle({ credentials: { limit: 10, ttl: 300_000 } })
  async bootstrap(
    @Body(new ZodValidationPipe(bootstrapSchema)) body: z.infer<typeof bootstrapSchema>,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    /*
     * Resolved before the ticket is spent. A deployment that cannot name a
     * published agent — a development build, or a version nobody released —
     * refuses here, leaving the operator's one-time command still usable.
     */
    let agentVersion: string;

    try {
      // An empty setting means "the version this control plane is", which is the
      // only pairing this project builds and tests together.
      agentVersion = resolveAgentVersion(this.config.AGENT_RELEASE_VERSION, BUILD_INFO.version);
    } catch (error) {
      if (error instanceof UnreleasedAgentVersionError) {
        throw new AppError(
          'HOST_SETUP_UNAVAILABLE',
          'This Dockplane build has no matching agent release, so it cannot add a host. Set AGENT_RELEASE_VERSION to a released version.',
        );
      }

      throw error;
    }

    const claimed = await this.setups.consumeTicket(body.ticket, { sourceIp: request.ip });

    const script = renderInstallScript({
      releaseBaseUrl: this.config.AGENT_RELEASE_BASE_URL,
      agentVersion,
      controlPlaneUrl: this.config.PUBLIC_APP_URL,
      enrollmentToken: claimed.enrollmentToken,
    });

    response
      .status(HttpStatus.OK)
      .setHeader('Content-Type', 'text/x-shellscript; charset=utf-8')
      .setHeader('Cache-Control', 'no-store')
      .setHeader('Referrer-Policy', 'no-referrer')
      .setHeader('X-Content-Type-Options', 'nosniff')
      .send(script);
  }
}
