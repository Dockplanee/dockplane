import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequirePermissions } from '../rbac/permissions.decorator';
import { AuthenticatedRequest, AuthenticatedUser } from '../auth/authenticated-request';
import { CurrentUser } from '../auth/current-user.decorator';
import { ComposeCompilerService } from './compose-compiler.service';
import { StackDeploymentService } from './stack-deployment.service';
import { StackLifecycleService } from './stack-lifecycle.service';
import { StackService } from './stack.service';

/**
 * What a caller sends to have a Compose file checked.
 *
 * The environment arrives as entries rather than an object so that a caller can
 * say which of them are secret. Dockplane does not treat the two differently
 * here — the compiler needs every value to resolve the file — but the
 * distinction is what stops a later editor from displaying one of them.
 */
const idSchema = z.uuid();

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

function context(request: AuthenticatedRequest) {
  return { sourceIp: request.ip, userAgent: request.header('user-agent') };
}

/** A stack name is also its Compose project name, so Compose's rule applies. */
const nameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Use lower-case letters, digits, hyphens and underscores.');

/**
 * What is being done to one environment variable.
 *
 * A browser that was never shown a secret sends `unchanged` and no value, which
 * is why this is an operation rather than a map of values.
 */
const environmentSchema = z
  .array(
    z.discriminatedUnion('operation', [
      z.strictObject({
        operation: z.literal('set'),
        key: z.string().min(1).max(256),
        value: z.string().max(32 * 1024),
      }),
      z.strictObject({
        operation: z.literal('set-secret'),
        key: z.string().min(1).max(256),
        value: z
          .string()
          .min(1)
          .max(32 * 1024),
      }),
      z.strictObject({ operation: z.literal('unchanged'), key: z.string().min(1).max(256) }),
      z.strictObject({ operation: z.literal('remove'), key: z.string().min(1).max(256) }),
    ]),
  )
  .max(512)
  .optional()
  .default([]);

const composeSchema = z
  .string()
  .min(1)
  .max(64 * 1024);

const createStackSchema = z.strictObject({
  name: nameSchema,
  hostId: z.uuid(),
  compose: composeSchema,
  environment: environmentSchema,
});

/**
 * Saving a change.
 *
 * The revision it was based on is required. Without it, two people editing one
 * stack would each save what they had and the second would quietly erase the
 * first.
 */
const revisionSchema = z.strictObject({
  baseRevisionId: z.uuid(),
  compose: composeSchema,
  environment: environmentSchema,
});

/**
 * What a caller sends to deploy a stack.
 *
 * The revision and nothing else. No host, no agent, no Docker identifier and no
 * plan: everything that decides what reaches a machine is resolved here, from
 * what was saved. A browser that could name an agent or hand over a plan would
 * be a browser that could deploy something nobody saved.
 */
const deploySchema = z.strictObject({ revisionId: z.uuid() });

const validateSchema = z.strictObject({
  projectName: z.string().min(1).max(63),
  /*
   * Comfortably larger than any real Compose file and smaller than the body
   * this server accepts, so the limit an author meets is this one — answered
   * with a message about their Compose file rather than about a request size.
   */
  compose: z
    .string()
    .min(1)
    .max(64 * 1024),
  environment: z
    .array(
      z.strictObject({
        key: z.string().min(1).max(256),
        value: z.string().max(32 * 1024),
        secret: z.boolean().optional().default(false),
      }),
    )
    .max(512)
    .optional()
    .default([]),
});

type ValidateRequest = z.infer<typeof validateSchema>;

/**
 * Whether a Compose file is one Dockplane could deploy.
 *
 * Answering that question needs the real compiler and the real values, because
 * a variable that is missing changes the answer — so this hands the compiler
 * everything, including the secrets, and then hands back almost none of it.
 *
 * Nothing is stored. No stack, no Compose file, no environment and no plan
 * reaches the database: this exists so an editor can tell somebody what is
 * wrong before they commit to anything, and a check that quietly saved what it
 * checked would be a different feature.
 */
@Controller('api/v1/stacks')
export class StacksController {
  constructor(
    private readonly compiler: ComposeCompilerService,
    private readonly stacks: StackService,
    private readonly deployments: StackDeploymentService,
    private readonly lifecycle: StackLifecycleService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('stacks.create')
  async create(
    @Body(new ZodValidationPipe(createStackSchema)) body: z.infer<typeof createStackSchema>,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.stacks.create(body, user, context(request));
  }

  @Get()
  @RequirePermissions('stacks.read')
  async list(@Query(new ZodValidationPipe(pageSchema)) page: z.infer<typeof pageSchema>) {
    const { stacks, total } = await this.stacks.list(page);

    return { stacks, page: { ...page, total } };
  }

  @Get(':id')
  @RequirePermissions('stacks.read')
  async detail(@Param('id', new ZodValidationPipe(idSchema)) id: string) {
    return { stack: await this.stacks.detail(id) };
  }

  /**
   * The services of a stack, as its host shows them.
   *
   * Behind `stacks.read`: it carries names, images and states, which is what
   * any listing of containers carries and nothing more.
   */
  @Get(':id/services')
  @RequirePermissions('stacks.read')
  async services(@Param('id', new ZodValidationPipe(idSchema)) id: string) {
    return this.stacks.services(id);
  }

  @Get(':id/revisions')
  @RequirePermissions('stacks.read')
  async revisions(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Query(new ZodValidationPipe(pageSchema)) page: z.infer<typeof pageSchema>,
  ) {
    const { revisions, total } = await this.stacks.revisions(id, page);

    return { revisions, page: { ...page, total } };
  }

  /**
   * The configuration itself.
   *
   * Behind `stacks.update` rather than `stacks.read`, because this is the one
   * response that carries the Compose source — and a source can contain a
   * credential its author wrote into it literally. Somebody who may look at
   * stacks is not thereby somebody who may read that.
   *
   * Never cached. It is the most sensitive thing this API returns.
   */
  @Get(':id/revisions/:revisionId/configuration')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('stacks.update')
  async configuration(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Param('revisionId', new ZodValidationPipe(idSchema)) revisionId: string,
  ) {
    return this.stacks.configuration(id, revisionId);
  }

  @Post(':id/revisions')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('stacks.update')
  async createRevision(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(revisionSchema)) body: z.infer<typeof revisionSchema>,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.stacks.createRevision(id, body, user, context(request));
  }

  /**
   * Deploys a stack for the first time.
   *
   * Answers when the deployment is over, not when it was dispatched: a stack
   * that is reported as deployed has been read back off its host. The wait is
   * bounded by the capability's own timeout, and a request that outlives its
   * answer leaves the attempt unresolved rather than guessing.
   */
  @Post(':id/deploy')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('stacks.deploy')
  async deploy(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(deploySchema)) body: z.infer<typeof deploySchema>,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.deployments.deploy(id, body.revisionId, user, context(request));
  }

  /**
   * Starts, stops or restarts what is already deployed.
   *
   * Three routes rather than one that takes the operation, matching both the
   * capability the agent offers and the container endpoints beside them. None
   * of them takes a body: the stack is the subject, the server resolves which
   * containers that means, and there is no field in which a caller could name
   * one of its own.
   *
   * The deployed revision does not change here, and neither does the newest
   * saved one. Starting a stack whose newest revision has never been deployed
   * starts what is deployed — the saved changes stay saved.
   */
  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('stacks.deploy')
  async start(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.lifecycle.run('start', id, user, context(request));
  }

  @Post(':id/stop')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('stacks.deploy')
  async stop(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.lifecycle.run('stop', id, user, context(request));
  }

  @Post(':id/restart')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('stacks.deploy')
  async restart(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.lifecycle.run('restart', id, user, context(request));
  }

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  /*
   * Whoever may write a stack may check one.
   *
   * The permission guard requires everything it is given, so this names one:
   * the roles that hold either stack-writing permission hold both, and gating
   * on both would exclude nobody while reading as though it might. If a role
   * ever holds only `stacks.update`, this needs an any-of check rather than a
   * second permission here.
   */
  @RequirePermissions('stacks.create')
  async validate(@Body(new ZodValidationPipe(validateSchema)) body: ValidateRequest) {
    const result = await this.compiler.compile({
      projectName: body.projectName,
      compose: body.compose,
      environment: Object.fromEntries(body.environment.map((entry) => [entry.key, entry.value])),
    });

    if (!result.ok) {
      return { valid: false, errors: result.problems };
    }

    /*
     * What the plan contains, not the plan.
     *
     * The plan carries resolved environment values — that is its whole purpose,
     * since an agent has to create containers with them — so it stays inside
     * the server. What comes back is the shape of the stack: what it would
     * create, and by what name.
     */
    return {
      valid: true,
      errors: [],
      summary: {
        projectName: result.plan.projectName,
        services: result.plan.services.map((service) => ({
          name: service.serviceName,
          image: service.image,
          ports: service.ports?.length ?? 0,
          mounts: service.mounts?.length ?? 0,
          // Names only. A summary that listed values would be a way to read a
          // secret back out of the thing that was told not to return it.
          environment: (service.environment ?? []).map((variable) => variable.key),
          networks: service.networks ?? [],
          dependsOn: service.dependsOn ?? [],
        })),
        networks: result.plan.networks.map((network) => ({
          name: network.name,
          external: network.external,
        })),
        volumes: result.plan.volumes.map((volume) => ({
          name: volume.name,
          external: volume.external,
        })),
      },
    };
  }
}
