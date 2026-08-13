import { Injectable, computed, inject, signal } from '@angular/core';

import { ApiError } from '../../core/api-error';
import { Permissions } from '../../core/permissions';
import { DockplaneApi } from '../../data/dockplane-api';
import {
  OPERATION_CONFIRMATIONS,
  OPERATION_LABELS,
  StackOperation,
  stackOperations,
} from '../../domain/stacks';
import { StackStore } from './stack-store';

/**
 * Starting, stopping and restarting a stack, from the interface's side.
 *
 * Separate from applying a revision because it is a different promise. Applying
 * one recreates every container and can change what the stack is; these three
 * move containers that already exist between running and stopped, and the
 * revision the stack is deployed with is the same afterwards.
 *
 * There is no review to load, for the same reason: nothing about the
 * configuration changes, so there is nothing to compare.
 */
@Injectable()
export class StackOperate {
  private readonly api = inject(DockplaneApi);
  private readonly store = inject(StackStore);
  private readonly permissions = inject(Permissions);

  /** The operation waiting to be confirmed, if any. */
  readonly pending = signal<StackOperation | undefined>(undefined);
  readonly busy = signal(false);
  readonly failure = signal<string | undefined>(undefined);
  /** Set when the host was asked and the answer never came back. */
  readonly unresolved = signal<string | undefined>(undefined);

  /** The operations this stack is in a position to be given, if this operator may. */
  readonly available = computed((): readonly StackOperation[] => {
    const stack = this.store.stack();

    if (!stack || !this.permissions.has('stacks.deploy')) {
      return [];
    }

    return stackOperations(stack);
  });

  /**
   * Why an offered operation cannot be started right now.
   *
   * Carried with the button rather than hiding it, so a host that has gone away
   * explains itself instead of leaving an operator wondering where the control
   * went.
   */
  readonly blocked = computed((): string | undefined => {
    const stack = this.store.stack();

    if (!stack) {
      return 'This stack no longer exists.';
    }

    if (!stack.hostReachable) {
      return 'The host agent is offline.';
    }

    return undefined;
  });

  readonly heading = computed(() => {
    const operation = this.pending();

    return operation ? `${OPERATION_LABELS[operation]}?` : '';
  });

  readonly description = computed(() => {
    const operation = this.pending();

    return operation ? OPERATION_CONFIRMATIONS[operation] : '';
  });

  readonly label = computed(() => {
    const operation = this.pending();

    return operation ? OPERATION_LABELS[operation] : '';
  });

  request(operation: StackOperation): void {
    this.pending.set(operation);
    this.failure.set(undefined);
    this.unresolved.set(undefined);
  }

  cancel(): void {
    this.pending.set(undefined);
  }

  confirm(): void {
    const stackId = this.store.id();
    const operation = this.pending();

    if (!operation || this.busy()) {
      return;
    }

    this.busy.set(true);
    this.failure.set(undefined);

    this.api.operateStack(stackId, operation).subscribe({
      next: () => {
        this.busy.set(false);
        this.pending.set(undefined);
        this.store.reload();
      },
      error: (error: unknown) => {
        const failure = ApiError.from(error);

        this.busy.set(false);
        this.pending.set(undefined);

        /*
         * An outcome nobody knows is not a failure. The host may have done what
         * was asked, so this says so and offers nothing that would send the same
         * request again.
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
