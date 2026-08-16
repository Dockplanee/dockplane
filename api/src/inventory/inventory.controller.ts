import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';

import { AuthenticatedRequest, AuthenticatedUser } from '../auth/authenticated-request';
import { CurrentUser } from '../auth/current-user.decorator';
import { AppError } from '../common/errors';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequirePermissions } from '../rbac/permissions.decorator';
import { DetailService } from '../discovery/detail.service';
import { HostArchiveService } from './host-archive.service';
import { InventoryService } from './inventory.service';

/**
 * Views over discovered infrastructure, and the one thing an operator decides
 * about a host itself.
 *
 * Nothing here reaches a Docker host. Archiving is a decision about Dockplane's
 * own record — which identities are part of the working set — and it changes
 * nothing on any machine, removes nothing, and is reversible.
 */

const idSchema = z.uuid();

/** A bounded page keeps one request from reading a whole fleet's containers. */
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const containerQuerySchema = pageSchema.extend({
  hostId: z.uuid().optional(),
  state: z.string().max(32).optional(),
  project: z.string().max(128).optional(),
  search: z.string().max(128).optional(),
});

const projectQuerySchema = pageSchema.extend({
  hostId: z.uuid().optional(),
});

/*
 * Which hosts a list is about. Active by default: an archived host is not part
 * of the working set, and asking for it is a deliberate act.
 */
const hostQuerySchema = pageSchema.extend({
  scope: z.enum(['active', 'archived', 'all']).default('active'),
});

@Controller('api/v1/hosts')
export class HostsController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly archive: HostArchiveService,
  ) {}

  @Get()
  @RequirePermissions('hosts.read')
  async list(@Query(new ZodValidationPipe(hostQuerySchema)) query: z.infer<typeof hostQuerySchema>) {
    const { hosts, total } = await this.inventory.listHosts(query, query.scope);

    return {
      hosts,
      scope: query.scope,
      page: { limit: query.limit, offset: query.offset, total },
    };
  }

  @Get(':id')
  @RequirePermissions('hosts.read')
  async get(@Param('id', new ZodValidationPipe(idSchema)) id: string) {
    const host = await this.inventory.findHost(id);

    if (!host) {
      throw AppError.notFound('HOST_NOT_FOUND', 'The host does not exist.');
    }

    return { host };
  }

  /**
   * Takes a host out of the working set.
   *
   * Refused while its agent is connected, and refused at this moment rather
   * than according to what the browser last saw: an agent can reconnect
   * between a page rendering and this request arriving.
   */
  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('hosts.archive')
  async archiveHost(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.archive.archive(id, user, context(request));

    return { host: await this.inventory.findHost(id) };
  }

  /** Returns an archived host to the working set. Visibility only. */
  @Post(':id/unarchive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('hosts.archive')
  async unarchiveHost(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.archive.unarchive(id, user, context(request));

    return { host: await this.inventory.findHost(id) };
  }
}

function context(request: AuthenticatedRequest) {
  return { sourceIp: request.ip, userAgent: request.header('user-agent') };
}

@Controller('api/v1/containers')
export class ContainersController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly detail: DetailService,
  ) {}

  @Get()
  @RequirePermissions('containers.read')
  async list(
    @Query(new ZodValidationPipe(containerQuerySchema)) query: z.infer<typeof containerQuerySchema>,
  ) {
    const { containers, total } = await this.inventory.listContainers(query, query);

    return { containers, page: { limit: query.limit, offset: query.offset, total } };
  }

  /**
   * One container, in detail.
   *
   * The detail is read from the host through the `container.inspect`
   * capability, not assembled from the summary discovery already holds. The
   * capability is named by the service from the catalog; nothing in this
   * request reaches the agent except the container's identifier.
   */
  @Get(':id')
  @RequirePermissions('containers.read')
  async get(@Param('id', new ZodValidationPipe(idSchema)) id: string) {
    const container = await this.inventory.findContainer(id);

    if (!container) {
      throw AppError.notFound('CONTAINER_NOT_FOUND', 'The container does not exist.');
    }

    /*
     * The detail is read from the host; the container is not. A host that
     * cannot be reached costs the detail and nothing else, so the request
     * answers with what Dockplane holds and says why the rest is missing.
     *
     * It used to throw, and the whole resource went with it: a container kept
     * on purpose after its host went away could not be opened at all, and the
     * interface — having asked for the container and been refused — reported it
     * as no longer existing.
     */
    const inspected = await this.detail
      .containerDetail(id)
      .then((read) => ({ ...read, unavailable: null }))
      .catch(async (error: unknown) => {
        if (!(error instanceof AppError)) {
          throw error;
        }

        /*
         * A host that answers "no such container" is not a host that could not
         * be asked: the record is finalised while the detail is read, and the
         * resource really has gone. Anything else — an unreachable host, a
         * create Docker has not carried out yet — leaves the resource in place,
         * and then the request is about the resource rather than the inspect.
         */
        if (!(await this.inventory.findContainer(id))) {
          throw error;
        }

        return {
          detail: null,
          observedAt: null,
          stale: true,
          unavailable: { code: error.code, message: error.message },
        };
      });

    return {
      container: {
        ...container,
        detail: inspected.detail,
        detailObservedAt: inspected.observedAt,
        /** Why the host could not be asked, when it could not. */
        detailUnavailable: inspected.unavailable,
        // The summary and the detail age separately, so a container listed a
        // moment ago can still carry detail nobody has refreshed.
        stale: container.stale || inspected.stale,
      },
    };
  }
}

@Controller('api/v1/compose-projects')
export class ComposeProjectsController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly detail: DetailService,
  ) {}

  @Get()
  @RequirePermissions('compose.read')
  async list(
    @Query(new ZodValidationPipe(projectQuerySchema)) query: z.infer<typeof projectQuerySchema>,
  ) {
    const { projects, total } = await this.inventory.listProjects(query, query);

    return { projects, page: { limit: query.limit, offset: query.offset, total } };
  }

  /** One Compose project, with its services read through `compose.inspect`. */
  @Get(':id')
  @RequirePermissions('compose.read')
  async get(@Param('id', new ZodValidationPipe(idSchema)) id: string) {
    const project = await this.inventory.findProject(id);

    if (!project) {
      throw AppError.notFound('COMPOSE_PROJECT_NOT_FOUND', 'The Compose project does not exist.');
    }

    const inspected = await this.detail.projectDetail(id);

    return {
      project: {
        ...project,
        services: inspected.services,
        status: inspected.status,
        serviceCount: inspected.serviceCount,
        runningCount: inspected.runningCount,
        detailObservedAt: inspected.observedAt,
        stale: project.stale || inspected.stale,
      },
    };
  }
}
