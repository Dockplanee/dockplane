import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'dockplane:public';

/** Marks a route as reachable without a session, such as login and the probes. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ALLOWS_MFA_PENDING = 'dockplane:allowsMfaPending';

/**
 * Marks a route that a half-authenticated session may reach.
 *
 * Only the second-factor endpoints carry this. Every other route rejects a
 * session that has not completed its MFA challenge.
 */
export const AllowMfaPending = () => SetMetadata(ALLOWS_MFA_PENDING, true);
