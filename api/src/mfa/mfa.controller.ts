import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { z } from 'zod';

import { AppError } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuthenticatedRequest, AuthenticatedUser } from '../auth/authenticated-request';
import { CurrentUser } from '../auth/current-user.decorator';
import { SessionService } from '../auth/session.service';
import { MfaService } from './mfa.service';

const codeSchema = z.object({ code: z.string().min(6).max(64) });

/**
 * Second-factor management for a signed-in operator.
 *
 * A rejected code here answers 400, not 401: the session is valid and only the
 * submitted code was wrong. Reserving 401 for the login challenge keeps a
 * client from mistaking a typo for an expired session.
 */
@Controller('api/v1/mfa')
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Starts setup and returns the secret once.
   *
   * Nothing is enabled yet: the account keeps working with a password alone
   * until a valid code confirms the operator can actually generate one.
   */
  @Post('setup')
  @HttpCode(HttpStatus.OK)
  async setup(@CurrentUser() user: AuthenticatedUser) {
    return this.mfa.beginSetup(user.id, user.email);
  }

  /** Confirms possession, enables the factor and returns the recovery codes once. */
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(
    @Body(new ZodValidationPipe(codeSchema)) body: z.infer<typeof codeSchema>,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const activation = await this.mfa.confirmSetup(user.id, body.code);

    await this.audit.record({
      action: 'mfa.enabled',
      result: 'success',
      actorUserId: user.id,
      actorLabel: user.email,
      targetType: 'user',
      targetId: user.id,
      sourceIp: request.ip,
      userAgent: request.header('user-agent'),
    });

    return activation;
  }

  /**
   * Disables the second factor.
   *
   * Requires a current TOTP or recovery code, so a borrowed session cannot
   * quietly weaken an account, and every other session is revoked afterwards.
   */
  @Post('disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  async disable(
    @Body(new ZodValidationPipe(codeSchema)) body: z.infer<typeof codeSchema>,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const result = await this.mfa.verifyChallenge(user.id, body.code);

    if (!result.accepted) {
      await this.audit.record({
        action: 'mfa.disabled',
        result: 'failure',
        actorUserId: user.id,
        actorLabel: user.email,
        targetType: 'user',
        targetId: user.id,
        reasonCode: 'invalid_code',
        sourceIp: request.ip,
        userAgent: request.header('user-agent'),
      });

      throw new AppError('AUTH_MFA_INVALID', 'That code is not valid.');
    }

    await this.mfa.disable(user.id);
    await this.sessions.revokeAllForUser(user.id);

    await this.audit.record({
      action: 'mfa.disabled',
      result: 'success',
      actorUserId: user.id,
      actorLabel: user.email,
      targetType: 'user',
      targetId: user.id,
      sourceIp: request.ip,
      userAgent: request.header('user-agent'),
    });
  }

  /** Replaces every recovery code; previously issued codes stop working. */
  @Post('recovery-codes/regenerate')
  @HttpCode(HttpStatus.OK)
  async regenerate(
    @Body(new ZodValidationPipe(codeSchema)) body: z.infer<typeof codeSchema>,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const result = await this.mfa.verifyChallenge(user.id, body.code);

    if (!result.accepted) {
      throw new AppError('AUTH_MFA_INVALID', 'That code is not valid.');
    }

    const activation = await this.mfa.regenerateRecoveryCodes(user.id);

    await this.audit.record({
      action: 'mfa.recovery_codes.regenerated',
      result: 'success',
      actorUserId: user.id,
      actorLabel: user.email,
      targetType: 'user',
      targetId: user.id,
      sourceIp: request.ip,
      userAgent: request.header('user-agent'),
    });

    return activation;
  }
}
