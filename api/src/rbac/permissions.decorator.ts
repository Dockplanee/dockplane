import { SetMetadata } from '@nestjs/common';

import { Permission } from './permissions';

export const REQUIRED_PERMISSIONS = 'dockplane:permissions';

/**
 * Declares the permissions a route requires.
 *
 * Authorization lives in metadata and one guard rather than in handler bodies,
 * so a route cannot be added without an explicit access decision.
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);
