import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { ApiError } from '../../core/api-error';
import { Permissions } from '../../core/permissions';
import { DockplaneApi } from '../../data/dockplane-api';
import { stackState } from '../../domain/stacks';
import { StackStore } from './stack-store';

/**
 * Deleting a stack, from the interface's side.
 *
 * The dialog has one job beyond confirming: telling an operator what survives.
 * Deleting a stack removes its containers and its saved configuration and keeps
 * every named volume, which is the opposite of what "delete" suggests to
 * somebody who has used `docker compose down -v`. So the volumes are listed by
 * name, and a deployed stack has to be named back before the action is offered
 * at all.
 */
@Injectable()
export class StackDelete {
  private readonly api = inject(DockplaneApi);
  private readonly store = inject(StackStore);
  private readonly permissions = inject(Permissions);
  private readonly router = inject(Router);

  readonly open = signal(false);
  readonly busy = signal(false);
  readonly failure = signal<string | undefined>(undefined);
  /** Set when the host was asked and the answer never came back. */
  readonly unresolved = signal<string | undefined>(undefined);

  /**
   * Whether deleting is offered at all.
   *
   * Not while the stack needs attention: its host does not say clearly which
   * containers are its own, and that is exactly when a destructive operation
   * must not be one click away. Not while it is reconciling either, for the
   * older reason — nobody knows yet what the last request did.
   */
  readonly available = computed(() => {
    const stack = this.store.stack();

    if (!stack || !this.permissions.has('stacks.delete')) {
      return false;
    }

    const state = stackState(stack);

    return state !== 'needs_attention' && state !== 'reconciling';
  });

  /** Why deleting cannot be started right now, when it is offered but blocked. */
  readonly blocked = computed((): string | undefined => {
    const stack = this.store.stack();

    if (!stack) {
      return 'This stack no longer exists.';
    }

    /*
     * A stack that has never been deployed has nothing on a host, so it can be
     * deleted with the host unreachable. One that is deployed cannot: its
     * containers have to go first.
     */
    if (stack.deployedRevision && !stack.hostReachable) {
      return 'The host agent is offline, so this stack’s containers cannot be removed.';
    }

    return undefined;
  });

  readonly heading = computed(() => `Delete ${this.store.stack()?.name ?? 'stack'}?`);

  /** What the operator is told before confirming, in the order it matters. */
  readonly description = computed(() => {
    const stack = this.store.stack();

    if (stack?.deployedRevision) {
      return 'The service containers of this stack are removed from its host, and its saved configuration and revision history are deleted from Dockplane. Named volumes are kept and no data in them is deleted. Networks this stack created are not removed.';
    }

    return 'The saved configuration and revision history of this stack are deleted from Dockplane. Nothing is running, so nothing is removed from a host.';
  });

  /** The volumes that are kept, named so nobody has to take it on trust. */
  readonly retainedVolumes = computed(() => {
    const stack = this.store.stack();
    const revision = stack?.deployedRevision ?? stack?.latestRevision;

    return revision?.summary?.volumes ?? [];
  });

  /**
   * What has to be typed to confirm, for a stack that is deployed.
   *
   * A stack that never ran has nothing on a host to lose, so it is confirmed
   * the ordinary way. One that is running is not.
   */
  readonly confirmationPhrase = computed(() =>
    this.store.stack()?.deployedRevision ? this.store.stack()?.name : undefined,
  );

  request(): void {
    this.failure.set(undefined);
    this.unresolved.set(undefined);
    this.open.set(true);
  }

  cancel(): void {
    this.open.set(false);
  }

  confirm(): void {
    const stackId = this.store.id();

    if (this.busy()) {
      return;
    }

    this.busy.set(true);
    this.failure.set(undefined);

    this.api.deleteStack(stackId).subscribe({
      next: () => {
        this.busy.set(false);
        this.open.set(false);

        // The stack is gone, so there is no page left to stand on.
        void this.router.navigate(['/stacks']);
      },
      error: (error: unknown) => {
        const failure = ApiError.from(error);

        this.busy.set(false);
        this.open.set(false);

        /*
         * An outcome nobody knows is not a deletion. The containers may be
         * gone, so this says what is true and offers nothing that would send
         * the same request again.
         */
        if (failure.code === 'OPERATION_OUTCOME_UNKNOWN') {
          this.unresolved.set(failure.message);
        } else {
          this.failure.set(failure.message);
        }

        this.store.reload();
      },
    });
  }
}
