import { CookieOptions, Response } from 'express';

import { AppConfig } from '../config/configuration';

/**
 * Session cookie policy.
 *
 * HttpOnly keeps the token out of reach of any script, so a cross-site
 * scripting flaw cannot exfiltrate it. `SameSite=Lax` stops the cookie from
 * riding along on cross-site form posts while keeping ordinary top-level
 * navigation to the application working. Secure is only omitted when the
 * development switch is on, which production configuration rejects.
 */
export function sessionCookieOptions(config: AppConfig, expiresAt: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: !config.DEV_ALLOW_INSECURE_COOKIES,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  };
}

export function setSessionCookie(
  response: Response,
  config: AppConfig,
  token: string,
  expiresAt: Date,
): void {
  response.cookie(config.SESSION_COOKIE_NAME, token, sessionCookieOptions(config, expiresAt));
}

export function clearSessionCookie(response: Response, config: AppConfig): void {
  response.clearCookie(config.SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: !config.DEV_ALLOW_INSECURE_COOKIES,
    sameSite: 'lax',
    path: '/',
  });
}
