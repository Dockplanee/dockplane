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
const Z = 'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz';

const claim = (dockerId: string, desiredConfigId: string | null): ObservedClaim => ({
  dockerId,
  desiredConfigId,
});

const replacing = (overrides: Partial<RecoveryInput> = {}): RecoveryInput => ({
  operation: 'replace',
  currentDesiredConfigId: A,
  pendingDesiredConfigId: B,
  claims: [],
  snapshotComplete: true,
  recoveryEligible: true,
  ...overrides,
});

describe('deciding what an orphaned mutation meant', () => {
  describe('when it is not orphaned', () => {
    it('leaves a running mutation alone', () => {
      // The normal state of a replacement that has not finished. Deciding
      // anything here would destroy an operation in progress.
      const decision = classifyRecovery(
        replacing({ recoveryEligible: false, claims: [claim('a', A)] }),
      );

      expect(decision.kind).toBe('no_action');
    });

    it('concludes nothing from a discovery that did not finish', () => {
      // An agent that timed out and a host with no containers look identical
      // from here, and one of them is not a reason to discard a candidate.
      const decision = classifyRecovery(replacing({ snapshotComplete: false, claims: [] }));

      expect(decision.kind).toBe('no_action');
    });

    it('has nothing to do when nothing is pending', () => {
      const decision = classifyRecovery(
        replacing({ pendingDesiredConfigId: null, claims: [claim('a', A)] }),
      );

      expect(decision.kind).toBe('no_action');
    });
  });

  describe('replacing', () => {
    it('discards the candidate when the original is what is running', () => {
      const decision = classifyRecovery(replacing({ claims: [claim('a', A)] }));

      expect(decision).toEqual({ kind: 'discard_pending', desiredConfigId: B });
    });

    it('promotes the candidate when the replacement is what is running', () => {
      const decision = classifyRecovery(replacing({ claims: [claim('b', B)] }));

      expect(decision).toEqual({ kind: 'promote_pending', desiredConfigId: B });
    });

    it('refuses to choose when both are there', () => {
      const decision = classifyRecovery(replacing({ claims: [claim('a', A), claim('b', B)] }));

      expect(decision.kind).toBe('conflict');
    });

    it('refuses a configuration this resource never had', () => {
      const decision = classifyRecovery(replacing({ claims: [claim('z', Z)] }));

      expect(decision.kind).toBe('needs_attention');
    });

    it('refuses a container that will not say what it is', () => {
      const decision = classifyRecovery(replacing({ claims: [claim('a', null)] }));

      expect(decision.kind).toBe('needs_attention');
    });

    it('refuses to conclude anything when nothing is left at all', () => {
      // The workflow keeps the original until the replacement runs, so this is
      // not a state it produces. Something else happened to this host.
      const decision = classifyRecovery(replacing({ claims: [] }));

      expect(decision.kind).toBe('needs_attention');
    });
  });

  /*
   * The reason the configuration identity exists.
   *
   * These two differ in nothing observable. Without the label there would be no
   * way to tell which one is running, and recovery would have to read a secret
   * back out of Docker to find out — which is exactly what the observed
   * projection refuses to make possible.
   */
  describe('a replacement that changed nothing anyone can see', () => {
    it('promotes a secret-only candidate on the label alone', () => {
      const decision = classifyRecovery(replacing({ claims: [claim('b', B)] }));

      expect(decision).toEqual({ kind: 'promote_pending', desiredConfigId: B });
    });

    it('discards a secret-only candidate on the label alone', () => {
      const decision = classifyRecovery(replacing({ claims: [claim('a', A)] }));

      expect(decision).toEqual({ kind: 'discard_pending', desiredConfigId: B });
    });
  });

  describe('creating', () => {
    const creating = (overrides: Partial<RecoveryInput> = {}): RecoveryInput =>
      replacing({
        operation: 'create',
        currentDesiredConfigId: null,
        pendingDesiredConfigId: A,
        ...overrides,
      });

    it('promotes when the container is there', () => {
      const decision = classifyRecovery(creating({ claims: [claim('a', A)] }));

      expect(decision).toEqual({ kind: 'promote_pending', desiredConfigId: A });
    });

    it('discards when a finished pass saw nothing', () => {
      const decision = classifyRecovery(creating({ claims: [] }));

      expect(decision).toEqual({ kind: 'discard_pending', desiredConfigId: A });
    });

    it('refuses to choose between two containers', () => {
      const decision = classifyRecovery(creating({ claims: [claim('a', A), claim('b', A)] }));

      expect(decision.kind).toBe('conflict');
    });
  });

  describe('removing', () => {
    const removing = (overrides: Partial<RecoveryInput> = {}): RecoveryInput =>
      replacing({ operation: 'remove', pendingDesiredConfigId: null, ...overrides });

    it('finishes the removal when the container is gone', () => {
      const decision = classifyRecovery(removing({ claims: [] }));

      expect(decision).toEqual({ kind: 'finalize_remove' });
    });

    it('says so when the container is still there', () => {
      // Asking for the removal again is not recovery's decision to make.
      const decision = classifyRecovery(removing({ claims: [claim('a', A)] }));

      expect(decision.kind).toBe('needs_attention');
    });

    it('refuses to choose when two containers claim the resource', () => {
      const decision = classifyRecovery(removing({ claims: [claim('a', A), claim('b', A)] }));

      expect(decision.kind).toBe('conflict');
    });

    it('concludes nothing from an unfinished pass', () => {
      const decision = classifyRecovery(removing({ claims: [], snapshotComplete: false }));

      expect(decision.kind).toBe('no_action');
    });
  });

  /*
   * Two containers outrank a tidy explanation.
   *
   * When both A and B are present the pending one looks like the winner and the
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
    ]) {
      expect(classifyRecovery(replacing({ claims })).kind).toBe('conflict');
    }
  });

  it('never asks for an operation to be run again', () => {
    const everyState: RecoveryInput[] = [
      replacing({ claims: [] }),
      replacing({ claims: [claim('a', A)] }),
      replacing({ claims: [claim('b', B)] }),
      replacing({ claims: [claim('z', Z)] }),
      replacing({ claims: [claim('a', null)] }),
      replacing({ claims: [claim('a', A), claim('b', B)] }),
      replacing({ operation: 'create', currentDesiredConfigId: null, claims: [] }),
      replacing({ operation: 'remove', pendingDesiredConfigId: null, claims: [] }),
    ];

    const permitted = new Set([
      'promote_pending',
      'discard_pending',
      'finalize_remove',
      'conflict',
      'needs_attention',
      'no_action',
    ]);

    for (const state of everyState) {
      // There is no outcome that dispatches, and none that removes anything.
      expect(permitted.has(classifyRecovery(state).kind)).toBe(true);
    }
  });

  it('is the same answer every time it is asked', () => {
    const state = replacing({ claims: [claim('b', B)] });

    expect(classifyRecovery(state)).toEqual(classifyRecovery(state));
    expect(classifyRecovery(state)).toEqual(classifyRecovery(state));
  });
});
