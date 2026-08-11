import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Request } from 'express';

/**
 * Abuse control for the credential endpoints.
 *
 * Requests are counted per source address and, where an account is named, per
 * account as well, so neither a single address nor a distributed attempt gets
 * unlimited guesses. The window slides and nothing is ever locked permanently:
 * a persistent lockout would let anyone deny a colleague access by guessing
 * their password badly on purpose.
 */
@Injectable()
export class CredentialThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(request: Request): Promise<string> {
    const address = request.ip ?? 'unknown';
    const body = request.body as { email?: unknown } | undefined;
    const account =
      typeof body?.email === 'string' ? body.email.trim().toLowerCase().slice(0, 320) : undefined;

    return account ? `${address}|${account}` : address;
  }
}
