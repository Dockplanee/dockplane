import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { z } from 'zod';

import { AppError } from '../common/errors';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AppConfig, CONFIG } from '../config/configuration';
import { Inject } from '@nestjs/common';
import { MfaService } from '../mfa/mfa.service';
import { AuthenticatedRequest, AuthenticatedUser } from './authenticated-request';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { CurrentSession, CurrentUser } from './current-user.decorator';
import { AllowMfaPending, Public } from './public.decorator';
import { ActiveSession } from './session.service';
import { clearSessionCookie, setSessionCookie } from './session-cookie';
import { CredentialThrottlerGuard } from './throttling';

const loginSchema = z.object({
  email: z.string().min(3).max(320),
  // Long passphrases are supported; only an absurd length is refused.
  password: z.string().min(1).max(1024),
});

const mfaSchema = z.object({
  code: z.string().min(6).max(64),
});

function requestContext(request: AuthenticatedRequest) {
  return { userAgent: request.header('user-agent'), sourceIp: request.ip };
}

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Signs in with a password.
   *
   * A successful response says whether a second factor is still required; it
   * never says why a rejected attempt failed.
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CredentialThrottlerGuard)
  @Throttle({ credentials: { limit: 10, ttl: 300_000 } })
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const outcome = await this.auth.login(body.email, body.password, requestContext(request));

    setSessionCookie(response, this.config, outcome.session.token, outcome.session.expiresAt);

    if (outcome.kind === 'mfa-required') {
      /*
       * The pending session's CSRF token is returned so the challenge can be
       * completed. It grants nothing else: this session reaches only the
       * second-factor endpoint until it is rotated.
       */
      return { status: 'mfa_required' as const, csrfToken: outcome.session.csrfToken };
    }

    return { status: 'authenticated' as const, csrfToken: outcome.session.csrfToken };
  }

  /** Completes a sign-in that required a second factor. */
  @AllowMfaPending()
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CredentialThrottlerGuard)
  @Throttle({ credentials: { limit: 10, ttl: 300_000 } })
  async verifyMfa(
    @Body(new ZodValidationPipe(mfaSchema)) body: z.infer<typeof mfaSchema>,
    @CurrentSession() session: ActiveSession,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!session.mfaPending) {
      throw new AppError('AUTH_MFA_INVALID', 'This session has already been authenticated.');
    }

    const rotated = await this.auth.verifyMfa(
      session.id,
      user.id,
      body.code,
      requestContext(request),
    );

    setSessionCookie(response, this.config, rotated.token, rotated.expiresAt);

    return { status: 'authenticated' as const, csrfToken: rotated.csrfToken };
  }

  /**
   * The signed-in operator, their roles and the permissions they actually hold.
   *
   * A fresh CSRF token comes with it. Only the digest of a token is stored, so a
   * session restored in a new page load has no way to be handed the value it
   * was issued at sign-in, and without one it could read but never act.
   */
  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser, @CurrentSession() session: ActiveSession) {
    const csrfToken = await this.sessions.issueCsrfToken(session.id);

    return {
      csrfToken,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        mfaEnabled: user.mfaEnabled,
        recoveryCodesRemaining: user.mfaEnabled
          ? await this.mfa.remainingRecoveryCodes(user.id)
          : 0,
      },
      roles: user.roles,
      permissions: [...user.permissions].sort(),
      session: { id: session.id, expiresAt: session.expiresAt },
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentSession() session: ActiveSession,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(session.id, user.id, user.email, requestContext(request));
    clearSessionCookie(response, this.config);
  }
}
