import { Observable, Subject, of, throwError } from 'rxjs';

import { ApiError } from '../app/core/api-error';
import {
  ApplyOutcome,
  ComposeValidation,
  OperationOutcome,
  StackDeletion,
  CreateStackRequest,
  SaveRevisionRequest,
  SavedRevision,
  StackConfiguration,
  ValidateComposeRequest,
  ActionOutcome,
  ActionRecord,
  ContainerConfiguration,
  ContainerFilter,
  ContainerOperation,
  ContainerSpecRequest,
  DockplaneApi,
  ManagementOutcome,
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
import { Stack, StackOperation, StackRevision, StackService } from '../app/domain/stacks';

/** What a test wants the control server to answer with. */
export interface TestData {
  /** What the configuration read returns; absent means the container is not managed. */
  readonly configuration?: ContainerConfiguration;
  /** What a create, replace or remove returns when it succeeds. */
  readonly managementOutcome?: ManagementOutcome;
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
  stacks?: readonly Stack[];
  stackRevisions?: readonly StackRevision[];
  stackServices?: readonly StackService[];
  stackConfiguration?: StackConfiguration;
  validation?: ComposeValidation;
  /** Set to make applying a revision fail the way the server would. */
  applyFailure?: unknown;
  /** Set to make starting, stopping or restarting fail the way the server would. */
  operationFailure?: unknown;
  /** Set to make deleting a stack fail the way the server would. */
  deleteFailure?: unknown;
  /** What a deletion reports it kept. */
  retainedVolumes?: readonly string[];
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
  /** Every request body a mutation was given, so a test can assert on it. */
  readonly requests: unknown[] = [];

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

  containerConfiguration(id: string): Observable<ContainerConfiguration> {
    this.calls.push(`containerConfiguration:${id}`);

    return this.data.configuration
      ? of(this.data.configuration)
      : throwError(
          () => new ApiError('CONTAINER_NOT_MANAGED', 'Dockplane did not create this.', 409),
        );
  }

  createContainer(request: ContainerSpecRequest): Observable<ManagementOutcome> {
    // Recorded as JSON so a test can assert what was actually sent — which for
    // the environment is the only way to check that a secret nobody changed
    // travelled as `unchanged` and carried no value.
    this.calls.push(`createContainer:${JSON.stringify(request)}`);

    return this.mutate(
      this.data.managementOutcome ?? {
        actionId: 'action-1',
        containerId: 'container-1',
        status: 'succeeded',
      },
      'create',
    );
  }

  replaceContainer(id: string, request: ContainerSpecRequest): Observable<ManagementOutcome> {
    this.calls.push(`replaceContainer:${id}:${JSON.stringify(request)}`);

    return this.mutate(
      this.data.managementOutcome ?? {
        actionId: 'action-1',
        containerId: id,
        status: 'succeeded',
      },
      'replace',
    );
  }

  removeContainer(id: string, options?: { stopFirst?: boolean }): Observable<ManagementOutcome> {
    this.calls.push(`removeContainer:${id}:${options?.stopFirst ?? false}`);

    return this.mutate(
      this.data.managementOutcome ?? {
        actionId: 'action-1',
        containerId: id,
        status: 'succeeded',
      },
      'remove',
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

  stacks(): Observable<readonly Stack[]> {
    this.calls.push('stacks');
    return of(this.data.stacks ?? []);
  }

  stack(id: string): Observable<Stack | undefined> {
    this.calls.push(`stack:${id}`);
    return of((this.data.stacks ?? []).find((stack) => stack.id === id));
  }

  stackRevisions(id: string): Observable<readonly StackRevision[]> {
    this.calls.push(`stackRevisions:${id}`);
    return of(this.data.stackRevisions ?? []);
  }

  stackServices(id: string): Observable<readonly StackService[]> {
    this.calls.push(`stackServices:${id}`);
    return of(this.data.stackServices ?? []);
  }

  stackConfiguration(stackId: string, revisionId: string): Observable<StackConfiguration> {
    this.calls.push(`stackConfiguration:${stackId}:${revisionId}`);

    return this.data.stackConfiguration
      ? of(this.data.stackConfiguration)
      : throwError(() => new Error('no stack configuration in this fixture'));
  }

  validateCompose(request: ValidateComposeRequest): Observable<ComposeValidation> {
    this.calls.push(`validateCompose:${request.projectName}`);

    return this.data.validation
      ? of(this.data.validation)
      : of({ valid: true, errors: [] as const });
  }

  createStack(request: CreateStackRequest): Observable<SavedRevision> {
    this.calls.push(`createStack:${request.name}`);
    this.requests.push(request);

    return of({ stackId: 'stack-1', revisionId: 'revision-1', revisionNumber: 1 });
  }

  createStackRevision(stackId: string, request: SaveRevisionRequest): Observable<SavedRevision> {
    this.calls.push(`createStackRevision:${stackId}`);
    this.requests.push(request);

    return of({ stackId, revisionId: 'revision-2', revisionNumber: 2 });
  }

  deleteStack(stackId: string): Observable<StackDeletion> {
    this.calls.push(`deleteStack:${stackId}`);

    return this.data.deleteFailure
      ? throwError(() => this.data.deleteFailure)
      : of({
          stackId,
          status: 'deleted',
          retainedVolumes: this.data.retainedVolumes ?? [],
        });
  }

  operateStack(stackId: string, operation: StackOperation): Observable<OperationOutcome> {
    this.calls.push(`operateStack:${stackId}:${operation}`);

    return this.data.operationFailure
      ? throwError(() => this.data.operationFailure)
      : of({ operationId: 'operation-1', stackId, operation, status: 'succeeded' });
  }

  applyStackRevision(stackId: string, revisionId: string): Observable<ApplyOutcome> {
    this.calls.push(`applyStackRevision:${stackId}:${revisionId}`);

    return this.data.applyFailure
      ? throwError(() => this.data.applyFailure)
      : of({
          deploymentId: 'deployment-1',
          stackId,
          revisionId,
          kind: 'deploy',
          status: 'succeeded',
        });
  }

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
