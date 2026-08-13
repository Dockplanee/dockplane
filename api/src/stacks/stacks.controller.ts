import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequirePermissions } from '../rbac/permissions.decorator';
import { ComposeCompilerService } from './compose-compiler.service';

/**
 * What a caller sends to have a Compose file checked.
 *
 * The environment arrives as entries rather than an object so that a caller can
 * say which of them are secret. Dockplane does not treat the two differently
 * here — the compiler needs every value to resolve the file — but the
 * distinction is what stops a later editor from displaying one of them.
 */
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
  constructor(private readonly compiler: ComposeCompilerService) {}

  @Post('validate')
  @HttpCode(HttpStatus.OK)
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
