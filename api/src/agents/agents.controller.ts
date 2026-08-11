import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { AppError } from '../common/errors';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuthenticatedRequest, AuthenticatedUser } from '../auth/authenticated-request';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import { CredentialThrottlerGuard } from '../auth/throttling';
import { RequirePermissions } from '../rbac/permissions.decorator';
import { DiscoveryScheduler } from '../discovery/discovery.scheduler';
import { LogStreamService } from '../logs/log-stream.service';
import { AgentConnectionManager } from './connection-manager.service';
import { AgentRegistryService } from './agent-registry.service';
import { EnrollmentService } from './enrollment.service';

/** Identifiers are UUIDs; anything else is refused before it reaches the database. */
const agentIdSchema = z.uuid();

const createTokenSchema = z.object({
  /** Operator hint only. Never used as an identity. */
  intendedHostname: z.string().max(253).optional(),
});

const revokeSchema = z.object({
  reason: z.string().min(1).max(200).default('revoked by an administrator'),
});

const enrollmentSchema = z.object({
  token: z.string().min(20).max(512),
  csr: z.string().min(1).max(8192),
  agentVersion: z.string().max(64).optional(),
  protocolVersion: z.number().int().min(1).max(1000),
  hostname: z.string().max(253).optional(),
});

function context(request: AuthenticatedRequest) {
  return { sourceIp: request.ip, userAgent: request.header('user-agent') };
}

@Controller('api/v1/agents')
export class AgentsController {
  constructor(
    private readonly registry: AgentRegistryService,
    private readonly enrollment: EnrollmentService,
    private readonly connections: AgentConnectionManager,
    private readonly discovery: DiscoveryScheduler,
    private readonly logs: LogStreamService,
  ) {}

  @Get()
  @RequirePermissions('agents.read')
  async list() {
    const agents = await this.registry.list();

    return {
      agents: agents.map((agent) => ({
        ...agent,
        connected: this.connections.isConnected(agent.id),
      })),
    };
  }

  /**
   * Issues a one-time enrollment token.
   *
   * The raw value is in this response and nowhere else: only its digest is
   * stored, so it cannot be shown again or recovered from the database.
   */
  @Post('enrollment-tokens')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('agents.enroll')
  async createEnrollmentToken(
    @Body(new ZodValidationPipe(createTokenSchema)) body: z.infer<typeof createTokenSchema>,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const created = await this.enrollment.createToken(user, {
      intendedHostname: body.intendedHostname,
      ...context(request),
    });

    return {
      id: created.id,
      token: created.token,
      expiresAt: created.expiresAt,
      note: 'This token is shown once and cannot be retrieved again.',
    };
  }

  @Get('enrollment-tokens')
  @RequirePermissions('agents.enroll')
  async listEnrollmentTokens() {
    return { tokens: await this.enrollment.listTokens() };
  }

  @Post('enrollment-tokens/:id/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('agents.enroll')
  async revokeEnrollmentToken(
    @Param('id', new ZodValidationPipe(agentIdSchema)) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.enrollment.revokeToken(id, user, context(request));
  }

  @Get(':id')
  @RequirePermissions('agents.read')
  async get(@Param('id', new ZodValidationPipe(agentIdSchema)) id: string) {
    const agent = await this.registry.findById(id);

    if (!agent) {
      throw AppError.notFound('AGENT_UNKNOWN', 'The agent does not exist.');
    }

    return { agent: { ...agent, connected: this.connections.isConnected(agent.id) } };
  }

  /**
   * Revokes an agent credential.
   *
   * The database decides trust, so the record is updated first and the live
   * connection is dropped afterwards. A connection that survives the drop still
   * fails on its next message, because identity is re-resolved every time.
   *
   * Polling and any running log stream are stopped here rather than left to
   * the socket closing. Dropping the connection removes it from the registry,
   * so the close handler no longer recognises it as the current one — and the
   * server would go on reading a host it has just been told not to trust.
   */
  @Post(':id/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('agents.revoke')
  async revoke(
    @Param('id', new ZodValidationPipe(agentIdSchema)) id: string,
    @Body(new ZodValidationPipe(revokeSchema)) body: z.infer<typeof revokeSchema>,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.registry.revoke(id, body.reason, user, context(request));
    this.discovery.stop(id);
    // A revoked credential must not keep reading a host's output either.
    this.logs.endStreamsOfAgent(id, 'AGENT_REVOKED', 'The agent credential was revoked.');
    this.connections.disconnect(id);
  }
}

/**
 * Enrollment.
 *
 * The only unauthenticated write in the API. It carries no session because the
 * agent has no identity yet; the one-time token is the entire authorisation,
 * and it is spent on first use.
 */
@Controller('api/v1/agent-enrollments')
export class AgentEnrollmentController {
  constructor(private readonly enrollment: EnrollmentService) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CredentialThrottlerGuard)
  @Throttle({ credentials: { limit: 10, ttl: 300_000 } })
  async enroll(
    @Body(new ZodValidationPipe(enrollmentSchema)) body: z.infer<typeof enrollmentSchema>,
    @Req() request: AuthenticatedRequest,
  ) {
    const result = await this.enrollment.enroll({
      token: body.token,
      csrPem: body.csr,
      agentVersion: body.agentVersion,
      protocolVersion: body.protocolVersion,
      declaredHostname: body.hostname,
      sourceIp: request.ip,
    });

    return {
      agentId: result.agentId,
      certificate: result.certificatePem,
      caChain: result.caChainPem,
      gatewayUrl: result.gatewayUrl,
      protocolVersion: result.protocolVersion,
      certificateNotAfter: result.certificateNotAfter,
    };
  }
}
