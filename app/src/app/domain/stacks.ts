import { StatusTone } from './status';

/**
 * Stacks, as the interface understands them.
 *
 * A stack has two revisions that matter and they are not the same thing: the
 * newest one anybody saved, and the one Dockplane has confirmed is running on
 * the host. Almost every question an operator asks about a stack is really a
 * question about the difference between those two, so they are kept apart here
 * rather than collapsed into a single "version".
 */

export interface RevisionRef {
  readonly id: string;
  readonly number: number;
  readonly summary?: RevisionSummary | null;
}

/** What a revision would create. Names only — never a value. */
export interface RevisionSummary {
  readonly services: readonly string[];
  readonly networks: readonly string[];
  readonly volumes: readonly string[];
}

export interface Stack {
  readonly id: string;
  readonly name: string;
  readonly hostId: string;
  readonly hostname: string;
  /** `dockplane` for a stack this product wrote; `adopted` is not built yet. */
  readonly sourceType: string;
  readonly status: string;
  readonly latestRevision: RevisionRef | null;
  readonly runningRevision: RevisionRef | null;
  /** An attempt that has not resolved, so no further operation may start. */
  readonly reconciling: boolean;
  readonly lastDeployedAt?: string | null;
  readonly updatedAt: string;
}

export interface StackRevision {
  readonly id: string;
  readonly number: number;
  readonly createdAt: string;
  readonly createdBy?: string | null;
  readonly summary?: RevisionSummary | null;
  /** True for the newest revision anybody saved. */
  readonly latest: boolean;
  /** True for the revision Dockplane has confirmed is running. */
  readonly deployed: boolean;
}

/** One service of a stack, as its host shows it. */
export interface StackService {
  readonly serviceName: string;
  readonly containerId: string;
  readonly name: string;
  readonly image: string;
  readonly state: string;
  readonly health: string;
  readonly dockerId: string | null;
  /** The revision this container says it is running. */
  readonly revisionId: string | null;
}

/**
 * What a stack is doing, in one word, in the order that matters.
 *
 * Deliberately not "latest differs from running, therefore something is wrong".
 * Saving a change without deploying it is an ordinary and intended state; a
 * stack that needs attention is not, and one is not allowed to hide the other.
 */
export type StackState =
  'needs_attention' | 'reconciling' | 'not_deployed' | 'changes_pending' | 'running';

export function stackState(stack: Stack): StackState {
  if (stack.status === 'needs_attention') {
    return 'needs_attention';
  }

  if (stack.reconciling || stack.status === 'deploying') {
    return 'reconciling';
  }

  if (!stack.runningRevision) {
    return 'not_deployed';
  }

  return stack.latestRevision && stack.latestRevision.id !== stack.runningRevision.id
    ? 'changes_pending'
    : 'running';
}

/** How each state is shown. The word carries the meaning, not the colour. */
export const STACK_STATE_LABELS: Record<StackState, string> = {
  needs_attention: 'Needs attention',
  reconciling: 'Reconciling',
  not_deployed: 'Not deployed',
  changes_pending: 'Changes not deployed',
  running: 'Running',
};

export const STACK_STATE_TONES: Record<StackState, StatusTone> = {
  needs_attention: 'critical',
  reconciling: 'info',
  not_deployed: 'neutral',
  changes_pending: 'warn',
  running: 'ok',
};

/**
 * What applying a revision to this stack would be called.
 *
 * The same operation in every case; the word is what an operator reads. A stack
 * that needs attention is being repaired whichever revision is chosen, because
 * what is being fixed is the host rather than the configuration.
 */
export type ApplyKind = 'deploy' | 'redeploy' | 'rollback' | 'repair';

export function applyKind(stack: Stack, target: { number: number }): ApplyKind {
  if (stackState(stack) === 'needs_attention') {
    return 'repair';
  }

  if (!stack.runningRevision) {
    return 'deploy';
  }

  return target.number < stack.runningRevision.number ? 'rollback' : 'redeploy';
}

export const APPLY_LABELS: Record<ApplyKind, (revision: number) => string> = {
  deploy: (revision) => `Deploy revision #${revision}`,
  redeploy: (revision) => `Deploy revision #${revision}`,
  rollback: (revision) => `Roll back to revision #${revision}`,
  repair: (revision) => `Repair using revision #${revision}`,
};
