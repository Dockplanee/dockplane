import { Injectable, computed, inject, signal } from '@angular/core';
import { forkJoin } from 'rxjs';

import { ApiError } from '../../core/api-error';
import { Permissions } from '../../core/permissions';
import { DockplaneApi } from '../../data/dockplane-api';
import { APPLY_LABELS, ApplyKind, RevisionRef, applyKind } from '../../domain/stacks';
import { RevisionDiff, diffRevisions } from './revision-diff';
import { StackStore } from './stack-store';

/**
 * Applying a revision, from the interface's side.
 *
 * One place for it, because the same operation is offered from the header, from
 * the revision history and from the warning shown when a stack needs attention.
 * Three buttons that each built their own confirmation would eventually
 * disagree about what they were warning people of.
 *
 * The review is loaded before anything is sent: applying a revision recreates
 * every container of the stack, and what that changes is worth seeing first.
 */
@Injectable()
export class StackApply {
  private readonly api = inject(DockplaneApi);
  private readonly store = inject(StackStore);
  private readonly permissions = inject(Permissions);

  /** The revision waiting to be confirmed, if any. */
  readonly target = signal<RevisionRef | undefined>(undefined);
  readonly busy = signal(false);
  readonly failure = signal<string | undefined>(undefined);
  /** Set when the host was asked and the answer never came back. */
  readonly unresolved = signal<string | undefined>(undefined);
  readonly diff = signal<RevisionDiff | undefined>(undefined);
  readonly diffFailed = signal(false);

  readonly kind = computed((): ApplyKind | undefined => {
    const stack = this.store.stack();
    const target = this.target();

    return stack && target ? applyKind(stack, target) : undefined;
  });

  readonly label = computed(() => {
    const kind = this.kind();
    const target = this.target();

    return kind && target ? APPLY_LABELS[kind](target.number) : '';
  });

  readonly heading = computed(() => {
    const kind = this.kind();
    const target = this.target();

    if (!kind || !target) {
      return '';
    }

    return kind === 'rollback'
      ? `Roll back to revision #${target.number}?`
      : kind === 'repair'
        ? `Repair using revision #${target.number}?`
        : `Deploy revision #${target.number}?`;
  });

  /**
   * What the operator is told before confirming.
   *
   * The downtime and the volumes are stated every time. A rollback says
   * explicitly that data does not come back with the configuration, because
   * that is the thing somebody rolling back a database is most likely to assume.
   */
  readonly description = computed(() => {
    const kind = this.kind();

    const shared =
      'Every service of this stack is recreated as one coordinated transition, so the stack is briefly down. Named volumes are kept.';

    if (kind === 'rollback') {
      return `${shared} This changes the running container configuration back to an earlier revision. It does not roll back data stored in volumes.`;
    }

    if (kind === 'repair') {
      return `${shared} Dockplane will converge the stack on this revision. It does not restore data.`;
    }

    return shared;
  });

  /** Whether this operator may be shown what changes between two revisions. */
  readonly canReview = computed(() => this.permissions.has('stacks.update'));

  request(target: RevisionRef): void {
    this.target.set(target);
    this.failure.set(undefined);
    this.unresolved.set(undefined);
    this.diff.set(undefined);
    this.diffFailed.set(false);

    this.loadDiff(target);
  }

  cancel(): void {
    this.target.set(undefined);
    this.diff.set(undefined);
  }

  confirm(): void {
    const stackId = this.store.id();
    const target = this.target();

    if (!target || this.busy()) {
      return;
    }

    this.busy.set(true);
    this.failure.set(undefined);

    this.api.applyStackRevision(stackId, target.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.target.set(undefined);
        this.diff.set(undefined);
        this.store.reload();
      },
      error: (error: unknown) => {
        const failure = ApiError.from(error);

        this.busy.set(false);
        this.target.set(undefined);
        this.diff.set(undefined);

        /*
         * An outcome nobody knows is not a failure. The host may have applied
         * the revision, so this says so and offers nothing that would send the
         * same request again.
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

  /**
   * Loads both configurations and compares them.
   *
   * Only for an operator who may read a stack's source at all — the comparison
   * is made of the two files, and there is no way to show what changed without
   * showing what it changed from.
   */
  private loadDiff(target: RevisionRef): void {
    const stack = this.store.stack();
    const from = stack?.deployedRevision;

    if (!this.canReview() || !from || from.id === target.id) {
      return;
    }

    forkJoin({
      from: this.api.stackConfiguration(stack!.id, from.id),
      to: this.api.stackConfiguration(stack!.id, target.id),
    }).subscribe({
      next: ({ from: before, to: after }) => this.diff.set(diffRevisions(before, after)),
      // A review that could not be loaded is stated rather than silently
      // missing: the operator is about to change what is running.
      error: () => this.diffFailed.set(true),
    });
  }
}
