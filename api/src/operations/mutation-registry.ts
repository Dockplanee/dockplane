import { Injectable } from '@nestjs/common';

import { AppError } from '../common/errors';

/**
 * What is currently being done to a container, across every service that does
 * something to one.
 *
 * There was one of these inside the lifecycle service, which was enough while
 * starting, stopping and restarting were the only things that changed a
 * container. They are not any more, and two independent sets would not have
 * stopped a replacement from running underneath a stop: each would have seen an
 * idle container and both would have been wrong.
 *
 * Per container rather than global, so one slow replacement does not hold up a
 * fleet. A second operation on the same container is refused rather than
 * queued: with two in flight neither the operator nor the audit trail could say
 * which one produced the state that resulted.
 *
 * Creating has no container to hold, so it holds the name it intends to take on
 * a host — which is the thing two simultaneous creates would collide over. A
 * stack deployment holds the stack, because what it changes is every container
 * of one.
 */
@Injectable()
export class MutationRegistry {
  private readonly held = new Map<string, string>();

  /**
   * Takes the lock, or refuses.
   *
   * Returns a release function rather than expecting the caller to remember,
   * so a path that throws cannot leave a container locked for the lifetime of
   * the process.
   */
  acquire(key: string, operation: string): () => void {
    const existing = this.held.get(key);

    if (existing) {
      // The code this situation has always answered with. A new one would say
      // the same thing to a client that had already learned the old one.
      throw AppError.conflict(
        'ACTION_CONFLICT',
        `Another operation is already running on this resource: ${existing}.`,
      );
    }

    this.held.set(key, operation);

    let released = false;

    return () => {
      if (!released) {
        released = true;
        this.held.delete(key);
      }
    };
  }

  /** Whether anything holds this container. Used to report, never to decide. */
  isBusy(key: string): boolean {
    return this.held.has(key);
  }

  /**
   * The containers currently being mutated.
   *
   * Discovery reads this so that a replacement in progress — which legitimately
   * has two Docker containers claiming one identity — is left alone rather than
   * recorded as a conflict.
   */
  get inFlight(): ReadonlySet<string> {
    return new Set(this.held.keys());
  }

  /** The key a create holds: a name on a host, since there is no container yet. */
  static nameKey(hostId: string, name: string): string {
    return `name:${hostId}:${name.toLowerCase()}`;
  }
}
