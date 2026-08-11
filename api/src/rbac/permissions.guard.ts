import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppError } from '../common/errors';
import { AuthenticatedRequest } from '../auth/authenticated-request';
import { REQUIRED_PERMISSIONS } from './permissions.decorator';
import { Permission } from './permissions';

/**
 * Enforces the permissions a route declares.
 *
 * Denial is the default in every uncertain case: no metadata means no
 * requirement, but a declared requirement with no authenticated user, or with a
 * permission the user does not hold, is refused. There is no role-name
 * shortcut and no administrator fallback.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(REQUIRED_PERMISSIONS, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const held = request.authUser?.permissions;

    if (!held) {
      throw AppError.forbidden(
        'PERMISSION_DENIED',
        'You do not have permission to perform this action.',
      );
    }

    const missing = required.filter((permission) => !held.has(permission));

    if (missing.length > 0) {
      throw AppError.forbidden(
        'PERMISSION_DENIED',
        'You do not have permission to perform this action.',
      );
    }

    return true;
  }
}
