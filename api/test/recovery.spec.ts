import { ObservedClaim, RecoveryInput, classifyRecovery } from '../src/containers/recovery';

/**
 * Every state a crashed mutation can leave behind.
 *
 * The classifier is pure, so these are the states themselves rather than
 * reproductions of them: no database, no host, no timing. What each one means
 * is decided here once, and the service that acts on it does not get a vote.
 */
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const Z = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const claim = (dockerId: string, desiredConfigId: string | null): ObservedClaim => ({
  dockerId,
  desiredConfigId,
});

/** A replacement: the container is A and is being asked to become B. */
const replacing = (overrides: Partial<RecoveryInput> = {}): RecoveryInput => ({
  operation: 'replace',
  currentDesiredConfigId: A,
  pendingDesiredConfigId: B,
  claims: [],
  snapshotComplete: true,
  recoveryEligible: true,
  ...overrides,
});

/** A create: there is nothing yet, and A is what it is meant to become. */
const creating = (overrides: Partial<RecoveryInput> = {}): RecoveryInput =>
  replacing({
    operation: 'create',
    currentDesiredConfigId: null,
    pendingDesiredConfigId: A,
    ...overrides,
  });

/** A removal: the container is A and is meant to stop existing. */
const removing = (overrides: Partial<RecoveryInput> = {}): RecoveryInput =>
  replacing({ operation: 'remove', pendingDesiredConfigId: null, ...overrides });

describe('deciding what an interrupted mutation meant', () => {
  describe('replacing', () => {
    it('has nothing to do when nothing is pending', () => {
      const decision = classifyRecovery(
        replacing({ pendingDesiredConfigId: null, claims: [claim('a', A)] }),
      );

      expect(decision.kind).toBe('no_action');
    });

    it('leaves a mutation that is still running alone', () => {
      // The normal state of a replacement partway through: the candidate is
      // written, the agent has been asked, nothing has come back yet. Deciding
      // anything here would destroy an operation in progress.
      const decision = classifyRecovery(
        replacing({ recoveryEligible: false, claims: [claim('a', A)] }),
      );

      expect(decision.kind).toBe('no_action');
    });

    it('discards the candidate when the original is what is running', () => {
      expect(classifyRecovery(replacing({ claims: [claim('a', A)] }))).toEqual({
        kind: 'discard_pending',
        desiredConfigId: B,
      });
    });

    it('promotes the candidate when the replacement is what is running', () => {
      expect(classifyRecovery(replacing({ claims: [claim('b', B)] }))).toEqual({
        kind: 'promote_pending',
        desiredConfigId: B,
      });
    });

    it('refuses to choose when both are there', () => {
      const decision = classifyRecovery(replacing({ claims: [claim('a', A), claim('b', B)] }));

      expect(decision.kind).toBe('identity_conflict');
    });

    it('refuses a configuration this resource never had', () => {
      // Adopting it would mean inventing a configuration for something nobody
      // asked for, out of a label anyone with Docker access can write.
      const decision = classifyRecovery(replacing({ claims: [claim('z', Z)] }));

      expect(decision.kind).toBe('needs_attention');
    });

    it('refuses to conclude anything when nothing is left at all', () => {
      // A replacement keeps the original until the replacement runs, so this is
      // not a state the workflow produces. Something else happened to this host.
      const decision = classifyRecovery(replacing({ claims: [] }));

      expect(decision.kind).toBe('needs_attention');
    });

    /*
     * The case the configuration identity exists for.
     *
     * A candidate that differs from the current configuration in nothing that
     * can be seen from outside — one secret, or one ordinary variable. Observed
     * state carries no environment values at all, so the label is not a
     * shortcut here; it is the only evidence there is.
     */
    it('promotes a secret-only candidate on the label alone', () => {
      expect(classifyRecovery(replacing({ claims: [claim('b', B)] }))).toEqual({
        kind: 'promote_pending',
        desiredConfigId: B,
      });
    });

    it('discards a secret-only candidate on the label alone', () => {
      expect(classifyRecovery(replacing({ claims: [claim('a', A)] }))).toEqual({
        kind: 'discard_pending',
        desiredConfigId: B,
      });
    });

    it('concludes nothing from a discovery that did not finish', () => {
      // An agent that timed out and a host with no containers look identical
      // from here, and one of them is not a reason to discard a candidate.
      const decision = classifyRecovery(replacing({ snapshotComplete: false, claims: [] }));

      expect(decision.kind).toBe('no_action');
    });
  });

  describe('creating', () => {
    it('promotes when the container is there', () => {
      expect(classifyRecovery(creating({ claims: [claim('a', A)] }))).toEqual({
        kind: 'promote_pending',
        desiredConfigId: A,
      });
    });

    it('discards when a finished discovery saw nothing', () => {
      // Nothing was created, or it was created and removed again. Either way
      // the candidate describes something that does not exist — and asking for
      // the create again is not recovery's decision to make.
      expect(classifyRecovery(creating({ claims: [] }))).toEqual({
        kind: 'discard_pending',
        desiredConfigId: A,
      });
    });

    it('refuses to choose between two containers', () => {
      const decision = classifyRecovery(creating({ claims: [claim('a', A), claim('b', A)] }));

      expect(decision.kind).toBe('identity_conflict');
    });
  });

  describe('removing', () => {
    it('finishes the removal when the container is gone', () => {
      expect(classifyRecovery(removing({ claims: [] }))).toEqual({ kind: 'finalize_remove' });
    });

    it('records a failure when the container is still there', () => {
      // Nothing is half-applied: the container is what it always was. That is a
      // failed operation, not a resource somebody has to repair.
      const decision = classifyRecovery(removing({ claims: [claim('a', A)] }));

      expect(decision.kind).toBe('fail_operation');
    });

    it('refuses to choose when two containers claim the resource', () => {
      const decision = classifyRecovery(removing({ claims: [claim('a', A), claim('b', A)] }));

      expect(decision.kind).toBe('identity_conflict');
    });

    it('concludes nothing from a discovery that did not finish', () => {
      const decision = classifyRecovery(removing({ claims: [], snapshotComplete: false }));

      expect(decision.kind).toBe('no_action');
    });
  });

  describe('whatever the operation', () => {
    it('refuses a managed container that will not say what it is', () => {
      // Hand-edited, or built by a Dockplane that predates the label. Either
      // way its configuration cannot be established, and assuming it is the
      // current one would be assuming the thing in question.
      const decision = classifyRecovery(replacing({ claims: [claim('a', null)] }));

      expect(decision.kind).toBe('needs_attention');
    });

    it('keeps saying so about a conflict that is already recorded', () => {
      // A conflict does not stop being true because the next sweep timed out.
      const decision = classifyRecovery(
        replacing({ identityConflict: true, snapshotComplete: false, claims: [] }),
      );

      expect(decision.kind).toBe('identity_conflict');
    });

    /*
     * Two containers outrank a tidy explanation.
     *
     * With both A and B present, the pending one looks like the winner and the
     * current one like a leftover. It is a guess, the Docker side of the
     * operation never finished, and being wrong removes a running workload.
     */
    it('never resolves a duplicate claim, however sensible the pair looks', () => {
      for (const claims of [
        [claim('a', A), claim('b', B)],
        [claim('b', B), claim('a', A)],
        [claim('a', A), claim('a2', A)],
        [claim('b', B), claim('b2', B)],
        [claim('a', A), claim('z', Z)],
        [claim('a', A), claim('b', B), claim('z', Z)],
      ]) {
        expect(classifyRecovery(replacing({ claims })).kind).toBe('identity_conflict');
      }
    });

    it('never dispatches and never removes', () => {
      // Recovery classifies, finalises and marks conflicts. Nothing it can say
      // asks for a container to be created, replaced or removed.
      const permitted = new Set([
        'promote_pending',
        'discard_pending',
        'finalize_remove',
        'fail_operation',
        'identity_conflict',
        'needs_attention',
        'no_action',
      ]);

      const states: RecoveryInput[] = [
        replacing({ claims: [] }),
        replacing({ claims: [claim('a', A)] }),
        replacing({ claims: [claim('b', B)] }),
        replacing({ claims: [claim('z', Z)] }),
        replacing({ claims: [claim('a', null)] }),
        replacing({ claims: [claim('a', A), claim('b', B)] }),
        replacing({ recoveryEligible: false, claims: [claim('a', A)] }),
        replacing({ snapshotComplete: false, claims: [] }),
        creating({ claims: [] }),
        creating({ claims: [claim('a', A)] }),
        removing({ claims: [] }),
        removing({ claims: [claim('a', A)] }),
      ];

      for (const state of states) {
        expect(permitted.has(classifyRecovery(state).kind)).toBe(true);
      }
    });

    it('decides nothing irreversible from an unfinished discovery', () => {
      const changesState = new Set(['promote_pending', 'discard_pending', 'finalize_remove']);

      for (const operation of [replacing, creating, removing]) {
        for (const claims of [[], [claim('a', A)], [claim('b', B)]]) {
          const decision = classifyRecovery(operation({ snapshotComplete: false, claims }));

          expect(changesState.has(decision.kind)).toBe(false);
        }
      }
    });

    it('is the same answer every time it is asked', () => {
      const state = replacing({ claims: [claim('b', B)] });

      expect(classifyRecovery(state)).toEqual(classifyRecovery(state));
      expect(classifyRecovery(state)).toEqual(classifyRecovery(state));
    });
  });
});
