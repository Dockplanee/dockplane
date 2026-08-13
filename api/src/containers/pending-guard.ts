import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { AppError } from '../common/errors';
import { Database } from '../database/database';
import { actions, containerDesiredConfigs, containers, stackDeployments } from '../database/schema';

/**
 * The operations that leave something unfinished behind.
 *
 * Starting, stopping and restarting are not here. They change a container's
 * state and not what it is, so one that never came back leaves nothing that has
 * to be settled before the next operation can mean anything.
 */
const UNFINISHABLE = ['container.create', 'container.replace', 'container.remove'];

/**
 * What is still unfinished, according to the database rather than to memory.
 *
 * The in-memory lock stops two operations racing inside one running process,
 * and it is the right tool for that: it is immediate and it costs nothing. But
 * it is also the first thing a restart forgets, and a control server that dies
 * partway through a replacement leaves behind a container whose state nobody
 * can describe — the candidate was written, Docker may or may not have applied
 * it, and until reconciliation says which, no further operation on that
 * container has a defined meaning.
 *
 * So both guards exist, and they answer different questions. The lock answers
 * "is something running right now"; this answers "did something never finish".
 * A restart clears the first and leaves the second exactly as it was.
 *
 * Recovery does not go through here. Finalising an unfinished mutation is the
 * one thing that must be allowed to touch one, and it reaches the rows through
 * its own path rather than through a flag that would turn this guard off.
 */
@Injectable()
export class PendingMutationGuard {
  constructor(private readonly db: Database) {}

  /**
   * Refuses an operation on a container whose last mutation never resolved.
   *
   * Checked before the container is resolved to a Docker identifier, because
   * during a replacement that identifier is the thing in question: resolving
   * first would mean reading an address that is being replaced and only then
   * discovering that nobody may act on it.
   */
  async assertResolved(containerId: string): Promise<void> {
    const [pending] = await this.db.client
      .select({ id: containerDesiredConfigs.id })
      .from(containerDesiredConfigs)
      .where(
        and(
          eq(containerDesiredConfigs.containerId, containerId),
          eq(containerDesiredConfigs.state, 'pending'),
        ),
      );

    if (pending) {
      // The code every other busy container has answered with. A new one would
      // say the same thing to a client that had already learned this one.
      throw AppError.conflict(
        'ACTION_CONFLICT',
        'A configuration change on this container has not been resolved yet.',
      );
    }

    /*
     * A removal has no candidate configuration to leave behind — there is
     * nothing the container is being asked to become — so the only trace of one
     * that never resolved is its action. Without this, a removal whose answer
     * was lost would leave a container that Dockplane would happily go on
     * restarting while its host may already have taken it away.
     */
    const [running] = await this.db.client
      .select({ id: actions.id })
      .from(actions)
      .where(
        and(
          eq(actions.targetType, 'container'),
          eq(actions.targetId, containerId),
          inArray(actions.status, ['queued', 'running']),
          inArray(actions.capability, UNFINISHABLE),
        ),
      );

    if (running) {
      throw AppError.conflict(
        'ACTION_CONFLICT',
        'A change to this container was started and has not been resolved yet.',
      );
    }
  }

  /**
   * Everything that has to be true before a container may be operated on.
   *
   * One method rather than a checklist each caller assembles, because the cost
   * of a caller forgetting one is a mutation against a container nobody can
   * describe. Starting a container is as affected as replacing it: if two
   * Docker containers claim to be this one, "start it" does not identify
   * anything.
   *
   * In this order deliberately. An unresolved change is the more common state
   * and the more precise thing to report; a conflict is what is left when the
   * resource itself is in question.
   */
  async assertOperable(containerId: string): Promise<void> {
    await this.assertResolved(containerId);
    await this.assertStackSettled(containerId);

    const [conflicted] = await this.db.client
      .select({ identityConflict: containers.identityConflict })
      .from(containers)
      .where(eq(containers.id, containerId));

    if (conflicted?.identityConflict) {
      throw AppError.conflict(
        'CONTAINER_IDENTITY_CONFLICT',
        'More than one container claims to be this one, so nothing may be done to it until that is resolved.',
      );
    }
  }

  /**
   * Refuses an operation on a container whose stack is mid-deployment.
   *
   * A stack's containers are created, started and observed as one thing. While
   * a deployment of that stack has not resolved, stopping or replacing one of
   * them changes the state the deployment is about to be judged against — and a
   * deployment that concluded from a container somebody else had just stopped
   * would record something that never happened.
   *
   * A container that belongs to no stack is unaffected, which is every
   * container that existed before stacks could be deployed.
   */
  async assertStackSettled(containerId: string): Promise<void> {
    const [deploying] = await this.db.client
      .select({ id: stackDeployments.id })
      .from(containers)
      .innerJoin(stackDeployments, eq(stackDeployments.stackId, containers.stackId))
      .where(
        and(
          eq(containers.id, containerId),
          inArray(stackDeployments.status, [
            'pending',
            'running',
            'interrupted',
            'needs_attention',
          ]),
        ),
      );

    if (deploying) {
      throw AppError.conflict(
        'STACK_DEPLOYMENT_CONFLICT',
        'A deployment of this container’s stack has not been resolved yet.',
      );
    }
  }

  /**
   * Refuses a name this host has already given out.
   *
   * Both senses of already. A container that exists holds its name, and so does
   * a create that never finished — the resource it wrote carries the name it
   * claimed and has no Docker identifier until something is observed, which is
   * what keeps the name held across a restart. Without that, two creates of one
   * name would both proceed after a restart, and the second would either
   * collide with a name Docker had taken or take it first and leave two
   * resources believing they owned it.
   *
   * The database refuses the second unfinished create as well. This is here so
   * the caller is told what is happening rather than shown a constraint
   * violation.
   */
  async assertNameFree(hostId: string, name: string): Promise<void> {
    const [taken] = await this.db.client
      .select({ id: containers.id, dockerId: containers.dockerId })
      .from(containers)
      .where(and(eq(containers.hostId, hostId), sql`lower(${containers.name}) = lower(${name})`));

    if (taken) {
      /*
       * Docker allows one container of a given name per host, so this would
       * fail there anyway — but it would fail after a resource had been
       * written, an action recorded and an image possibly pulled. Saying so
       * first is both faster and truthful about what is wrong.
       */
      throw AppError.conflict(
        'CONTAINER_NAME_IN_USE',
        taken.dockerId
          ? 'A container with this name already exists on this host.'
          : 'A container with this name is already being created on this host.',
      );
    }
  }
}
