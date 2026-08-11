import { ExecutionContext, createParamDecorator } from '@nestjs/common';

import { AuthenticatedRequest, AuthenticatedUser } from './authenticated-request';
import { ActiveSession } from './session.service';

/** The authenticated operator. Present on every route the session guard admits. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.authUser) {
      throw new Error('CurrentUser used on a route without the session guard');
    }

    return request.authUser;
  },
);

/** The session the request authenticated with, used to identify the current one. */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ActiveSession => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.authSession) {
      throw new Error('CurrentSession used on a route without the session guard');
    }

    return request.authSession;
  },
);
