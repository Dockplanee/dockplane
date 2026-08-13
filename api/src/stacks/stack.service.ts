import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { AgentConnectionManager } from '../agents/connection-manager.service';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/authenticated-request';
import { SecretBox } from '../common/crypto';
import { AppError } from '../common/errors';
import { SECRET_BOX } from '../config/tokens';
import { Database } from '../database/database';
import {
  agents,
  composeProjects,
  containers,
  hosts,
  stackDeployments,
  stackRevisionEnvironment,
  stackRevisions,
  stacks,
} from '../database/schema';
import { ComposeCompilerService } from './compose-compiler.service';
import { EnvironmentChange, StoredVariable, resolveStackEnvironment } from './stack-environment';

/**
 * Stacks, as things that are saved rather than things that run.
 *
 * A stack is a name, a host, and a history of configurations. Saving one
 * creates a revision; changing one creates another. Nothing here deploys
 * anything, and a stack that has never been deployed says so rather than
 * borrowing a status from a container that does not exist.
 *
 * Two rules shape the rest.
 *
 * A revision is immutable. Editing a stack does not rewrite what was saved
 * before, because a revision is what a rollback goes back to and one that could
 * be changed afterwards would not be a record of anything.
 *
 * A revision is compiled before it is stored. A saved configuration that turns
 * out to be undeployable is a problem discovered at the worst possible moment,
 * so the same compiler that answers the validation endpoint has to accept it
 * first — and it runs before the transaction opens, never inside one.
 */
@Injectable()
export class StackService {
  constructor(
    private readonly db: Database,
    private readonly compiler: ComposeCompilerService,
    private readonly connections: AgentConnectionManager,
    private readonly audit: AuditService,
    @Inject(SECRET_BOX) private readonly box: SecretBox,
  ) {}

  /** Creates a stack and its first revision. */
  async create(
    request: {
      name: string;
      hostId: string;
      compose: string;
      environment: readonly EnvironmentChange[];
    },
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    await this.host(request.hostId);
    await this.assertNameFree(request.hostId, request.name);

    const environment = resolveStackEnvironment(request.environment, [], this.box);
    const compiled = await this.compileOrRefuse(request.name, request.compose, environment);

    const created = await this.db.client.transaction(async (tx) => {
      const [stack] = await tx
        .insert(stacks)
        .values({
          hostId: request.hostId,
          name: request.name,
          sourceType: 'dockplane',
          // Nothing has been deployed, and nothing pretends otherwise.
          status: 'not_deployed',
          createdBy: actor.id,
        })
        .returning({ id: stacks.id });

      const revision = await this.writeRevision(tx, {
        stackId: stack.id,
        number: 1,
        compose: request.compose,
        environment,
        compiled,
        actorId: actor.id,
      });

      await tx
        .update(stacks)
        .set({ latestRevisionId: revision.id, updatedAt: new Date() })
        .where(eq(stacks.id, stack.id));

      return { stackId: stack.id, revisionId: revision.id };
    });

    await this.audit.record({
      action: 'stack.created',
      result: 'success',
      actorUserId: actor.id,
      actorLabel: actor.email,
      targetType: 'stack',
      targetId: created.stackId,
      targetLabel: request.name,
      reasonCode: created.revisionId,
      sourceIp: context.sourceIp,
      userAgent: context.userAgent,
    });

    return { ...created, revisionNumber: 1, summary: compiled.summary };
  }

  /**
   * Saves a change as a new revision.
   *
   * The caller says which revision it was working from. If somebody else has
   * saved since, this refuses rather than writing over their work — an
   * interface can then say so, which is the only way an operator finds out
   * before rather than after.
   */
  async createRevision(
    stackId: string,
    request: {
      baseRevisionId: string;
      compose: string;
      environment: readonly EnvironmentChange[];
    },
    actor: AuthenticatedUser,
    context: RequestContext,
  ) {
    const stack = await this.find(stackId);

    if (stack.latestRevisionId !== request.baseRevisionId) {
      throw AppError.conflict(
        'STACK_REVISION_CONFLICT',
        'This stack changed while you were editing it. Reload it and apply your changes again.',
      );
    }

    const previous = await this.db.client
      .select()
      .from(stackRevisionEnvironment)
      .where(eq(stackRevisionEnvironment.revisionId, request.baseRevisionId));

    const environment = resolveStackEnvironment(request.environment, previous, this.box);
    const compiled = await this.compileOrRefuse(stack.name, request.compose, environment);

    const created = await this.db.client.transaction(async (tx) => {
      /*
       * The stack row is locked for the rest of this transaction.
       *
       * Two saves arriving together would otherwise both read the same latest
       * revision and both allocate the same number — one of them ending in a
       * unique-violation nobody asked a question about. Serialised here, the
       * second one finds the first one's revision and is refused as a conflict,
       * which is a thing an interface can explain.
       */
      const [locked] = await tx
        .select({ latestRevisionId: stacks.latestRevisionId })
        .from(stacks)
        .where(eq(stacks.id, stackId))
        .for('update');

      if (locked?.latestRevisionId !== request.baseRevisionId) {
        throw AppError.conflict(
          'STACK_REVISION_CONFLICT',
          'This stack changed while you were editing it. Reload it and apply your changes again.',
        );
      }

      const [{ highest }] = await tx
        .select({ highest: sql<number>`coalesce(max(${stackRevisions.number}), 0)` })
        .from(stackRevisions)
        .where(eq(stackRevisions.stackId, stackId));

      const revision = await this.writeRevision(tx, {
        stackId,
        number: Number(highest) + 1,
        compose: request.compose,
        environment,
        compiled,
        actorId: actor.id,
      });

      await tx
        .update(stacks)
        .set({ latestRevisionId: revision.id, updatedAt: new Date() })
        .where(eq(stacks.id, stackId));

      return { revisionId: revision.id, revisionNumber: Number(highest) + 1 };
    });

    await this.audit.record({
      action: 'stack.revision.created',
      result: 'success',
      actorUserId: actor.id,
      actorLabel: actor.email,
      targetType: 'stack',
      targetId: stackId,
      targetLabel: stack.name,
      reasonCode: String(created.revisionNumber),
      sourceIp: context.sourceIp,
      userAgent: context.userAgent,
    });

    return { stackId, ...created, summary: compiled.summary };
  }

  /** Stacks, as a listing describes them: no source, no environment. */
  async list(page: { limit: number; offset: number }) {
    const rows = await this.db.client
      .select({ stack: stacks, host: hosts, revision: stackRevisions, running: running })
      .from(stacks)
      .innerJoin(hosts, eq(hosts.id, stacks.hostId))
      .leftJoin(stackRevisions, eq(stackRevisions.id, stacks.latestRevisionId))
      .leftJoin(running, eq(running.id, stacks.currentRevisionId))
      .orderBy(hosts.hostname, stacks.name)
      .limit(page.limit)
      .offset(page.offset);

    const [{ value: total }] = await this.db.client.select({ value: count() }).from(stacks);
    const unresolved = await this.unresolvedStacks();
    const reachable = await this.reachableHosts();

    return {
      stacks: rows.map((row) =>
        present(row, unresolved.has(row.stack.id), reachable.has(row.stack.hostId)),
      ),
      total,
    };
  }

  async detail(stackId: string) {
    const [row] = await this.db.client
      .select({ stack: stacks, host: hosts, revision: stackRevisions, running: running })
      .from(stacks)
      .innerJoin(hosts, eq(hosts.id, stacks.hostId))
      .leftJoin(stackRevisions, eq(stackRevisions.id, stacks.latestRevisionId))
      .leftJoin(running, eq(running.id, stacks.currentRevisionId))
      .where(eq(stacks.id, stackId));

    if (!row) {
      throw AppError.notFound('STACK_NOT_FOUND', 'The stack does not exist.');
    }

    const unresolved = await this.unresolvedStacks(stackId);
    const reachable = await this.reachableHosts();

    return present(row, unresolved.has(stackId), reachable.has(row.stack.hostId));
  }

  /**
   * The services of a stack, as its host shows them.
   *
   * The container resources Dockplane allocated, each with what the host says
   * about it. Named by service rather than by Docker identifier: the service
   * and the Dockplane container are what stay the same across revisions, and
   * the Docker container changes every time one is applied.
   */
  async services(stackId: string) {
    await this.find(stackId);

    const rows = await this.db.client
      .select({
        containerId: containers.id,
        serviceName: containers.stackService,
        name: containers.name,
        image: containers.image,
        state: containers.state,
        health: containers.health,
        dockerId: containers.dockerId,
        revisionId: containers.stackRevisionId,
        observedAt: containers.observedAt,
      })
      .from(containers)
      .where(eq(containers.stackId, stackId))
      .orderBy(containers.stackService);

    return {
      services: rows.map((row) => ({ ...row, serviceName: row.serviceName ?? '' })),
    };
  }

  /**
   * The hosts whose agent is connected right now.
   *
   * Read here rather than left to the interface to fetch separately: whether a
   * revision can be applied is part of what a stack is at this moment, and an
   * interface that asked a second endpoint would be showing two answers from
   * two moments.
   */
  private async reachableHosts(): Promise<Set<string>> {
    const rows = await this.db.client
      .select({ id: agents.id, hostId: agents.hostId })
      .from(agents)
      .where(isNull(agents.revokedAt));

    return new Set(
      rows.filter((row) => this.connections.isConnected(row.id)).map((row) => row.hostId),
    );
  }

  /**
   * Stacks with an attempt that has not resolved.
   *
   * What the interface needs to say "this is being reconciled" rather than
   * offering an operation that would be refused.
   */
  private async unresolvedStacks(stackId?: string): Promise<Set<string>> {
    const rows = await this.db.client
      .select({ stackId: stackDeployments.stackId })
      .from(stackDeployments)
      .where(
        and(
          inArray(stackDeployments.status, ['pending', 'running', 'interrupted']),
          ...(stackId ? [eq(stackDeployments.stackId, stackId)] : []),
        ),
      );

    return new Set(rows.map((row) => row.stackId));
  }

  /** What has been saved, newest first. No source and no values. */
  async revisions(stackId: string, page: { limit: number; offset: number }) {
    const stack = await this.find(stackId);

    const rows = await this.db.client
      .select()
      .from(stackRevisions)
      .where(eq(stackRevisions.stackId, stackId))
      .orderBy(desc(stackRevisions.number))
      .limit(page.limit)
      .offset(page.offset);

    const [{ value: total }] = await this.db.client
      .select({ value: count() })
      .from(stackRevisions)
      .where(eq(stackRevisions.stackId, stackId));

    return {
      revisions: rows.map((revision) => ({
        id: revision.id,
        number: revision.number,
        createdAt: revision.createdAt,
        createdBy: revision.createdBy,
        summary: revision.summary,
        compiler: {
          protocolVersion: revision.compilerProtocolVersion,
          planVersion: revision.planVersion,
          validatedAt: revision.validatedAt,
        },
        latest: revision.id === stack.latestRevisionId,
        deployed: revision.id === stack.currentRevisionId,
      })),
      total,
    };
  }

  /**
   * The configuration itself, for an editor.
   *
   * The only read that decrypts the Compose source, which is why it is a route
   * of its own rather than part of the stack. A source can carry a credential
   * an author wrote into it literally, and nothing that merely lists stacks
   * should be handling that.
   *
   * Secret variables come back saying they are secret and carrying nothing
   * else — no value, no envelope, not even a length.
   */
  async configuration(stackId: string, revisionId: string) {
    const [revision] = await this.db.client
      .select()
      .from(stackRevisions)
      .where(and(eq(stackRevisions.id, revisionId), eq(stackRevisions.stackId, stackId)));

    if (!revision) {
      throw AppError.notFound('STACK_NOT_FOUND', 'The revision does not exist.');
    }

    const environment = await this.db.client
      .select()
      .from(stackRevisionEnvironment)
      .where(eq(stackRevisionEnvironment.revisionId, revisionId));

    return {
      revisionId: revision.id,
      revisionNumber: revision.number,
      compose: this.box.decrypt(revision.composeSourceEncrypted),
      environment: environment
        .slice()
        .sort((left, right) => left.key.localeCompare(right.key))
        .map((variable) =>
          variable.isSecret
            ? { key: variable.key, secret: true }
            : { key: variable.key, secret: false, value: variable.value ?? '' },
        ),
      summary: revision.summary,
    };
  }

  /**
   * Compiles what is about to be saved, and refuses everything else.
   *
   * Exactly the object that will be persisted, so a revision cannot be stored
   * having been validated as something slightly different. Outside any
   * transaction: the compiler is another process, and a database transaction
   * held open across one would pin a connection to it.
   */
  private async compileOrRefuse(
    projectName: string,
    compose: string,
    environment: readonly StoredVariable[],
  ) {
    const result = await this.compiler.compile({
      projectName,
      compose,
      // Resolving a Compose file needs the values, so the compiler is given
      // them. They exist for this call and are not stored, logged or returned.
      environment: Object.fromEntries(
        environment.map((variable) => [
          variable.key,
          variable.isSecret ? this.box.decrypt(variable.valueEncrypted!) : (variable.value ?? ''),
        ]),
      ),
    });

    if (!result.ok) {
      throw new AppError(
        'STACK_CONFIGURATION_INVALID',
        'This Compose configuration is not one Dockplane can deploy.',
        400,
        result.problems,
      );
    }

    return {
      plan: result.plan,
      summary: {
        services: result.plan.services.map((service) => service.serviceName),
        networks: result.plan.networks.map((network) => network.name),
        volumes: result.plan.volumes.map((volume) => volume.name),
      },
    };
  }

  /**
   * Writes one revision and its environment.
   *
   * The plan is not among what is stored. It carries resolved values, secrets
   * included, and a deployment recompiles the source rather than reading a plan
   * back out of a database.
   */
  private async writeRevision(
    tx: Transaction,
    input: {
      stackId: string;
      number: number;
      compose: string;
      environment: readonly StoredVariable[];
      compiled: { summary: { services: string[]; networks: string[]; volumes: string[] } };
      actorId: string;
    },
  ) {
    const [revision] = await tx
      .insert(stackRevisions)
      .values({
        stackId: input.stackId,
        number: input.number,
        // The author's own file, encrypted. Not the compiler's idea of it:
        // re-serialising would lose their comments and their formatting, and
        // they have to edit this again.
        composeSourceEncrypted: this.box.encrypt(input.compose),
        compilerProtocolVersion: COMPILER_PROTOCOL_VERSION,
        planVersion: COMPILER_PROTOCOL_VERSION,
        validatedAt: new Date(),
        summary: input.compiled.summary,
        createdBy: input.actorId,
      })
      .returning({ id: stackRevisions.id });

    if (input.environment.length > 0) {
      await tx
        .insert(stackRevisionEnvironment)
        .values(input.environment.map((variable) => ({ revisionId: revision.id, ...variable })));
    }

    return revision;
  }

  private async find(stackId: string) {
    const [stack] = await this.db.client.select().from(stacks).where(eq(stacks.id, stackId));

    if (!stack) {
      throw AppError.notFound('STACK_NOT_FOUND', 'The stack does not exist.');
    }

    return stack;
  }

  private async host(hostId: string) {
    const [host] = await this.db.client.select().from(hosts).where(eq(hosts.id, hostId));

    if (!host) {
      throw AppError.notFound('HOST_NOT_FOUND', 'The host does not exist.');
    }

    /*
     * Whether its agent is connected is deliberately not checked. Preparing a
     * stack for a machine that is currently offline is a reasonable thing to
     * do; deploying to one is not, and that is where it will be refused.
     */
    return host;
  }

  /**
   * One stack of a given name per host, and not one that collides with a
   * Compose project already on it.
   *
   * The second check is why this is worth doing here rather than leaving to a
   * unique index: a project discovered on the host is not Dockplane's, and a
   * stack that would later deploy over it should not be created in the first
   * place. Discovery can only see what a host has reported, so this catches the
   * cases it knows about and the deployment preflight has to catch the rest.
   */
  private async assertNameFree(hostId: string, name: string): Promise<void> {
    const [existing] = await this.db.client
      .select({ id: stacks.id })
      .from(stacks)
      .where(and(eq(stacks.hostId, hostId), eq(stacks.name, name)));

    if (existing) {
      throw AppError.conflict('STACK_NAME_CONFLICT', 'This host already has a stack of that name.');
    }

    const [discovered] = await this.db.client
      .select({ id: composeProjects.id })
      .from(composeProjects)
      .where(and(eq(composeProjects.hostId, hostId), eq(composeProjects.projectName, name)));

    if (discovered) {
      throw AppError.conflict(
        'STACK_NAME_CONFLICT',
        'A Compose project of that name was found on this host and is not managed by Dockplane.',
      );
    }
  }
}

/** The revision a stack is running, joined beside the newest one saved. */
const running = alias(stackRevisions, 'running_revision');

/** The contract a revision was validated under. */
const COMPILER_PROTOCOL_VERSION = 1;

interface RequestContext {
  readonly sourceIp?: string;
  readonly userAgent?: string;
}

type Transaction = Parameters<Parameters<Database['client']['transaction']>[0]>[0];

/**
 * A stack as every listing and detail describes one.
 *
 * Saved and running are two separate things and are reported as two separate
 * things: the newest revision anybody wrote down, and the one Dockplane has
 * confirmed is on the host. An interface that had only one of them would have
 * to guess which it was showing.
 */
function present(
  row: {
    stack: typeof stacks.$inferSelect;
    host: typeof hosts.$inferSelect;
    revision: typeof stackRevisions.$inferSelect | null;
    running: typeof stackRevisions.$inferSelect | null;
  },
  reconciling: boolean,
  hostReachable: boolean,
) {
  return {
    id: row.stack.id,
    name: row.stack.name,
    hostId: row.stack.hostId,
    hostname: row.host.hostname,
    sourceType: row.stack.sourceType,
    status: row.stack.status,
    latestRevision: row.revision
      ? { id: row.revision.id, number: row.revision.number, summary: row.revision.summary }
      : null,
    /* Nothing has been deployed yet, and this says so rather than implying it. */
    runningRevision: row.running
      ? { id: row.running.id, number: row.running.number, summary: row.running.summary }
      : null,
    deployedRevisionId: row.stack.currentRevisionId,
    /** An attempt that has not resolved. No further operation may be started. */
    reconciling,
    /** Whether this stack's host can be reached at all right now. */
    hostReachable,
    lastDeployedAt: row.stack.lastDeployedAt,
    createdAt: row.stack.createdAt,
    updatedAt: row.stack.updatedAt,
  };
}
