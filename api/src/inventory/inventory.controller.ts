import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';

import { AppError } from '../common/errors';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequirePermissions } from '../rbac/permissions.decorator';
import { DetailService } from '../discovery/detail.service';
import { InventoryService } from './inventory.service';

/**
 * Read-only views over discovered infrastructure.
 *
 * There is no mutating endpoint here, and not because one was left out: this
 * release observes Docker hosts and changes nothing on them. Adding an
 * operation means adding a capability, a permission and an audit path, not a
 * route.
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

@Controller('api/v1/hosts')
export class HostsController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  @RequirePermissions('hosts.read')
  async list(@Query(new ZodValidationPipe(pageSchema)) query: z.infer<typeof pageSchema>) {
    const { hosts, total } = await this.inventory.listHosts(query);

    return { hosts, page: { limit: query.limit, offset: query.offset, total } };
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

    const inspected = await this.detail.containerDetail(id);

    return {
      container: {
        ...container,
        detail: inspected.detail,
        detailObservedAt: inspected.observedAt,
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
