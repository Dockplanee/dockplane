import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { z } from 'zod';

import { AuthenticatedRequest, AuthenticatedUser } from '../auth/authenticated-request';
import { CurrentUser } from '../auth/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequirePermissions } from '../rbac/permissions.decorator';
import { ContainerManagementService } from './container-management.service';
import {
  CreateContainerRequest,
  RemoveContainerRequest,
  ReplaceContainerRequest,
  createContainerSchema,
  removeContainerSchema,
  replaceContainerSchema,
} from './container-spec';

const idSchema = z.uuid();

function context(request: AuthenticatedRequest) {
  return {
    sourceIp: request.ip,
    userAgent: request.header('user-agent'),
    requestId: request.header('x-request-id') ?? undefined,
  };
}

/**
 * Changing what a container is.
 *
 * A caller describes a container in Dockplane's own fields and names a host as
 * a Dockplane resource. It does not name an agent, a Docker identifier or a
 * configuration: the server resolves all three, so no request can choose which
 * machine it lands on or which container it rebuilds.
 *
 * Each operation has its own permission. Creating, changing and removing are
 * three different kinds of trust, and a role that may recreate a container to
 * change a port is not thereby a role that may delete one.
 */
@Controller('api/v1/containers')
export class ContainerManagementController {
  constructor(private readonly management: ContainerManagementService) {}

  /**
   * What the container is configured to be.
   *
   * Separate from the container itself, which reports what the host is running.
   * The two are the same until somebody changes one, and an interface that
   * conflated them would show an edit form filled in from a container that is
   * about to be replaced.
   */
  @Get(':id/configuration')
  @RequirePermissions('containers.read')
  async configuration(@Param('id', new ZodValidationPipe(idSchema)) id: string) {
    return this.management.configuration(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('containers.create')
  async create(
    @Body(new ZodValidationPipe(createContainerSchema)) body: CreateContainerRequest,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.management.create(body, user, context(request));
  }

  /**
   * The whole configuration, not a patch.
   *
   * A replacement recreates the container, so what is sent is what it will be.
   * Sending a patch would mean the server merging two pictures of a container
   * that may have been edited in between, and producing something nobody asked
   * for.
   */
  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('containers.update')
  async replace(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(replaceContainerSchema)) body: ReplaceContainerRequest,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.management.replace(id, body, user, context(request));
  }

  /** Volumes are never removed with the container, and cannot be asked for. */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('containers.delete')
  async remove(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(removeContainerSchema)) body: RemoveContainerRequest,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.management.remove(id, body, user, context(request));
  }
}
