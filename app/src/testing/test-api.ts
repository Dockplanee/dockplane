import { Observable, Subject, of, throwError } from 'rxjs';

import { ApiError } from '../app/core/api-error';
import {
  ActionOutcome,
  ActionRecord,
  ContainerFilter,
  ContainerOperation,
  DockplaneApi,
  LogEvent,
  LogOptions,
  LogSnapshot,
  MfaSetup,
} from '../app/data/dockplane-api';
import { ComposeProject, Container, ContainerDetail, Host } from '../app/domain/inventory';
import {
  Agent,
  AuditPage,
  CreatedHostSetup,
  EnrollmentToken,
  HostSetup,
  Role,
  User,
} from '../app/domain/operations';
import { OperatorSession } from '../app/domain/sessions';

/** What a test wants the control server to answer with. */
export interface TestData {
  hosts?: readonly Host[];
  containers?: readonly Container[];
  containerDetail?: ContainerDetail;
  containerDetailError?: ApiError;
  composeProjects?: readonly ComposeProject[];
  agents?: readonly Agent[];
  audit?: AuditPage;
  users?: readonly User[];
  roles?: readonly Role[];
  sessions?: readonly OperatorSession[];
  mfaSetup?: MfaSetup;
  recoveryCodes?: readonly string[];
  actionOutcome?: ActionOutcome;
  actionRecords?: readonly ActionRecord[];
  logSnapshot?: LogSnapshot;
  logsError?: ApiError;
  /** When set, mutating calls fail with it. */
  failure?: ApiError;
  /** Narrows `failure` to one call, so a flow can fail at a chosen step. */
  failOnly?: string;
  enrollmentToken?: EnrollmentToken;
  hostSetup?: CreatedHostSetup;
  regeneratedHostSetup?: CreatedHostSetup;
  /** What a later read of the setup reports, so a flow can advance. */
  hostSetupState?: HostSetup;
}

/**
 * A control server stand-in for tests.
 *
 * It exists only under the test setup. The application wires the HTTP client
 * and has no path to this class, so there is no build in which a view could
 * render invented data.
 */
export class TestApi extends DockplaneApi {
  readonly calls: string[] = [];

  constructor(private readonly data: TestData = {}) {
    super();
  }

  hosts(): Observable<readonly Host[]> {
    this.calls.push('hosts');
    return of(this.data.hosts ?? []);
  }

  host(id: string): Observable<Host | undefined> {
    return of((this.data.hosts ?? []).find((host) => host.id === id));
  }

  containers(filter?: ContainerFilter): Observable<readonly Container[]> {
    this.calls.push(`containers:${filter?.hostId ?? 'all'}`);

    const containers = this.data.containers ?? [];

    return of(
      filter?.hostId
        ? containers.filter((container) => container.hostId === filter.hostId)
        : containers,
    );
  }

  container(id: string): Observable<Container | undefined> {
    return of((this.data.containers ?? []).find((container) => container.id === id));
  }

  containerDetail(id: string): Observable<ContainerDetail> {
    this.calls.push(`containerDetail:${id}`);

    if (this.data.containerDetailError) {
      return throwError(() => this.data.containerDetailError);
    }

    return this.data.containerDetail
      ? of(this.data.containerDetail)
      : throwError(
          () => new ApiError('CONTAINER_DETAIL_UNAVAILABLE', 'No detail has been read yet.', 409),
        );
  }

  runContainerOperation(
    operation: ContainerOperation,
    containerId: string,
  ): Observable<ActionOutcome> {
    this.calls.push(`${operation}:${containerId}`);

    return this.mutate(
      this.data.actionOutcome ?? { actionId: 'action-1', status: 'succeeded', state: 'running' },
      operation,
    );
  }

  actions(): Observable<readonly ActionRecord[]> {
    return of(this.data.actionRecords ?? []);
  }

  containerLogs(containerId: string, options?: LogOptions): Observable<LogSnapshot> {
    this.calls.push(`containerLogs:${containerId}:${options?.tail ?? ''}`);

    if (this.data.logsError) {
      return throwError(() => this.data.logsError);
    }

    return of(this.data.logSnapshot ?? { lines: [], dropped: 0 });
  }

  /**
   * A stream the test drives.
   *
   * Events are pushed through `logEvents`, so a spec can decide when a line
   * arrives, when the host goes away and when the stream ends. Unsubscribing is
   * recorded, because a viewer that leaves its stream running is the defect
   * these tests exist to catch.
   */
  streamContainerLogs(containerId: string, options?: LogOptions): Observable<LogEvent> {
    this.calls.push(`streamContainerLogs:${containerId}:${options?.tail ?? ''}`);

    return new Observable<LogEvent>((subscriber) => {
      const subscription = this.logEvents.subscribe(subscriber);

      this.openStreams += 1;

      return () => {
        this.openStreams -= 1;
        subscription.unsubscribe();
      };
    });
  }

  /** Streams this double currently has open. */
  openStreams = 0;

  /** What a running stream delivers, driven by the test. */
  readonly logEvents = new Subject<LogEvent>();

  composeProjects(): Observable<readonly ComposeProject[]> {
    return of(this.data.composeProjects ?? []);
  }

  composeProject(id: string): Observable<ComposeProject | undefined> {
    return of((this.data.composeProjects ?? []).find((project) => project.id === id));
  }

  agents(): Observable<readonly Agent[]> {
    return of(this.data.agents ?? []);
  }

  createHostSetup(displayName?: string): Observable<CreatedHostSetup> {
    this.calls.push(`createHostSetup:${displayName ?? ''}`);

    if (this.data.failure) {
      return throwError(() => this.data.failure);
    }

    return this.data.hostSetup
      ? of(this.data.hostSetup)
      : throwError(() => new ApiError('PERMISSION_DENIED', 'Not permitted.', 403));
  }

  hostSetup(id: string): Observable<HostSetup> {
    this.calls.push(`hostSetup:${id}`);

    return this.data.hostSetupState
      ? of(this.data.hostSetupState)
      : throwError(() => new ApiError('HOST_SETUP_NOT_FOUND', 'No such setup.', 404));
  }

  regenerateHostSetup(id: string): Observable<CreatedHostSetup> {
    this.calls.push(`regenerateHostSetup:${id}`);

    return this.data.regeneratedHostSetup
      ? of(this.data.regeneratedHostSetup)
      : throwError(() => new ApiError('HOST_SETUP_NOT_PENDING', 'Already used.', 404));
  }

  cancelHostSetup(id: string): Observable<HostSetup> {
    this.calls.push(`cancelHostSetup:${id}`);

    return of({
      ...(this.data.hostSetupState ?? this.data.hostSetup!),
      status: 'cancelled' as const,
    });
  }

  createEnrollmentToken(): Observable<EnrollmentToken> {
    this.calls.push('createEnrollmentToken');

    if (this.data.failure) {
      return throwError(() => this.data.failure);
    }

    return this.data.enrollmentToken
      ? of(this.data.enrollmentToken)
      : throwError(() => new ApiError('PERMISSION_DENIED', 'Not permitted.', 403));
  }

  revokeAgent(id: string): Observable<void> {
    this.calls.push(`revokeAgent:${id}`);
    return this.mutate(undefined, 'revokeAgent');
  }

  auditEntries(): Observable<AuditPage> {
    return of(this.data.audit ?? { entries: [] });
  }

  users(): Observable<readonly User[]> {
    return of(this.data.users ?? []);
  }

  roles(): Observable<readonly Role[]> {
    return of(this.data.roles ?? []);
  }

  assignRole(userId: string, role: string): Observable<void> {
    this.calls.push(`assignRole:${userId}:${role}`);
    return this.mutate(undefined, 'assignRole');
  }

  sessions(): Observable<readonly OperatorSession[]> {
    return of(this.data.sessions ?? []);
  }

  revokeSession(id: string): Observable<void> {
    this.calls.push(`revokeSession:${id}`);
    return this.mutate(undefined, 'revokeSession');
  }

  beginMfaSetup(): Observable<MfaSetup> {
    this.calls.push('beginMfaSetup');

    return this.mutate(
      this.data.mfaSetup ?? {
        secret: 'JBSWY3DPEHPK3PXP',
        otpauthUrl: 'otpauth://totp/Dockplane:ops@example.internal?secret=JBSWY3DPEHPK3PXP',
      },
      'beginMfaSetup',
    );
  }

  confirmMfa(code: string): Observable<readonly string[]> {
    this.calls.push(`confirmMfa:${code}`);
    return this.mutate(this.data.recoveryCodes ?? ['AAAA-1111', 'BBBB-2222'], 'confirmMfa');
  }

  disableMfa(code: string): Observable<void> {
    this.calls.push(`disableMfa:${code}`);
    return this.mutate(undefined, 'disableMfa');
  }

  regenerateRecoveryCodes(code: string): Observable<readonly string[]> {
    this.calls.push(`regenerateRecoveryCodes:${code}`);
    return this.mutate(
      this.data.recoveryCodes ?? ['CCCC-3333', 'DDDD-4444'],
      'regenerateRecoveryCodes',
    );
  }

  /**
   * Mutating calls answer with the scripted failure when one is set.
   *
   * `failOnly` narrows it to a single call, so a test can let a flow reach the
   * step it is actually about before failing there.
   */
  private mutate<T>(value: T, call?: string): Observable<T> {
    const applies = this.data.failure && (!this.data.failOnly || this.data.failOnly === call);

    return applies ? throwError(() => this.data.failure) : of(value);
  }
}
