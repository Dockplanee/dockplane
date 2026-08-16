import { Observable } from 'rxjs';

import { ComposeProject, Container, ContainerDetail, Host } from '../domain/inventory';
import { Stack, StackOperation, StackRevision, StackService } from '../domain/stacks';
import {
  Agent,
  AuditPage,
  CreatedHostSetup,
  EnrollmentToken,
  HostSetup,
  Role,
  User,
} from '../domain/operations';
import { OperatorSession } from '../domain/sessions';
import { InstalledVersions, UpdateCheck } from '../domain/versions';

/**
 * The control server, as the interface uses it.
 *
 * Every method here has a real endpoint behind it. Capabilities the server does
 * not implement — container lifecycle, log streaming, images, volumes and
 * networks — deliberately have no method: a view cannot ask for something the
 * product does not do, and no fixture can quietly fill the gap.
 *
 * Views depend on this abstraction only, so the production HTTP client and the
 * fixture used by tests are interchangeable without touching a component.
 */
export abstract class DockplaneApi {
  abstract hosts(): Observable<readonly Host[]>;
  abstract host(id: string): Observable<Host | undefined>;

  abstract containers(filter?: ContainerFilter): Observable<readonly Container[]>;
  abstract container(id: string): Observable<Container | undefined>;

  /**
   * The sanitised inspect projection, read from the host on request.
   *
   * Fails with `CONTAINER_DETAIL_UNAVAILABLE` when the host has never been
   * reachable, which the view reports rather than papering over.
   */
  abstract containerDetail(id: string): Observable<ContainerDetail>;

  /**
   * Runs a lifecycle operation on a container.
   *
   * The operation is one of three names the interface knows; a caller supplies
   * a container and nothing else. The server derives the host, the agent and
   * the Docker identifier, so the browser never chooses where an operation
   * lands.
   */
  abstract runContainerOperation(
    operation: ContainerOperation,
    containerId: string,
  ): Observable<ActionOutcome>;

  /**
   * What a container is configured to be.
   *
   * The configuration Dockplane holds, which is what an edit starts from — not
   * the inspect projection, which describes the container Docker is running.
   * The two agree until somebody changes one.
   */
  abstract containerConfiguration(id: string): Observable<ContainerConfiguration>;

  /**
   * Creates a container on a host.
   *
   * The host is named as a Dockplane resource. Neither the agent nor any Docker
   * identifier appears in the request: the server resolves both.
   */
  abstract createContainer(request: ContainerSpecRequest): Observable<ManagementOutcome>;

  /**
   * Replaces a container with a new configuration.
   *
   * The whole configuration, not a patch — Docker cannot change a running
   * container's ports or environment, so applying a change means rebuilding it.
   * The Dockplane container is the same one afterwards.
   */
  abstract replaceContainer(
    id: string,
    request: ContainerSpecRequest,
  ): Observable<ManagementOutcome>;

  /** Removes a container. Its volumes are kept, and cannot be asked for. */
  abstract removeContainer(
    id: string,
    options?: { stopFirst?: boolean },
  ): Observable<ManagementOutcome>;

  abstract actions(options?: {
    limit?: number;
    offset?: number;
  }): Observable<readonly ActionRecord[]>;

  /** What a container has already printed. */
  abstract containerLogs(containerId: string, options?: LogOptions): Observable<LogSnapshot>;

  /**
   * Follows a container's output.
   *
   * Read-only in the strongest sense: the returned stream carries events
   * outwards and offers nothing to write. Unsubscribing closes the connection,
   * which is what ends the read on the host.
   */
  abstract streamContainerLogs(containerId: string, options?: LogOptions): Observable<LogEvent>;

  /**
   * What this installation is running.
   *
   * Local throughout, so it answers on a deployment with no route out. The
   * agent summary is absent for a user who may not see the agents rather than
   * present and hidden.
   */
  abstract installedVersions(): Observable<InstalledVersions>;

  /**
   * Whether a newer Dockplane has been published.
   *
   * A separate call because it is a separate question: it is off unless an
   * administrator turned it on, and asking it must never delay what the
   * installation can say about itself.
   */
  abstract updateCheck(): Observable<UpdateCheck>;

  abstract composeProjects(): Observable<readonly ComposeProject[]>;
  abstract composeProject(id: string): Observable<ComposeProject | undefined>;

  abstract stacks(): Observable<readonly Stack[]>;
  abstract stack(id: string): Observable<Stack | undefined>;
  abstract stackRevisions(id: string): Observable<readonly StackRevision[]>;
  abstract stackServices(id: string): Observable<readonly StackService[]>;

  /**
   * The Compose source and environment of one revision.
   *
   * The only response that carries a stack's source, which is why the server
   * puts it behind the permission to change a stack rather than to see one: a
   * Compose file can contain a credential its author wrote into it. Secret
   * variables come back saying they are secret and carrying nothing else.
   */
  abstract stackConfiguration(stackId: string, revisionId: string): Observable<StackConfiguration>;

  /** Asks the real compiler whether a Compose file is one Dockplane can deploy. */
  abstract validateCompose(request: ValidateComposeRequest): Observable<ComposeValidation>;

  abstract createStack(request: CreateStackRequest): Observable<SavedRevision>;

  /**
   * Saves a change as a new revision.
   *
   * The revision it was based on travels with it, so a save cannot silently
   * overwrite one somebody else made in the meantime.
   */
  abstract createStackRevision(
    stackId: string,
    request: SaveRevisionRequest,
  ): Observable<SavedRevision>;

  /**
   * Applies a revision to the stack's host.
   *
   * Deploying, redeploying, rolling back and repairing are one operation with
   * one endpoint: make this revision the one that is running. The browser names
   * a revision and nothing else — no host, no agent, no plan.
   */
  abstract applyStackRevision(stackId: string, revisionId: string): Observable<ApplyOutcome>;

  /**
   * Starts, stops or restarts what is already deployed.
   *
   * No revision and no body: the operation is the route, and which containers
   * it means is the server's to resolve.
   */
  abstract operateStack(stackId: string, operation: StackOperation): Observable<OperationOutcome>;

  /**
   * Deletes a stack.
   *
   * No options: there is no field in which a caller could ask for a volume to
   * be removed, which is what keeps deleting a stack from deleting data.
   */
  abstract deleteStack(stackId: string): Observable<StackDeletion>;

  abstract agents(): Observable<readonly Agent[]>;
  abstract createEnrollmentToken(intendedHostname?: string): Observable<EnrollmentToken>;
  abstract revokeAgent(id: string, reason: string): Observable<void>;

  abstract createHostSetup(displayName?: string): Observable<CreatedHostSetup>;
  abstract hostSetup(id: string): Observable<HostSetup>;
  abstract regenerateHostSetup(id: string): Observable<CreatedHostSetup>;
  abstract cancelHostSetup(id: string): Observable<HostSetup>;

  abstract auditEntries(options?: AuditQuery): Observable<AuditPage>;

  abstract users(): Observable<readonly User[]>;
  abstract assignRole(userId: string, role: string): Observable<void>;
  abstract roles(): Observable<readonly Role[]>;

  abstract sessions(): Observable<readonly OperatorSession[]>;
  abstract revokeSession(id: string): Observable<void>;

  /**
   * Starts second-factor setup.
   *
   * The secret is returned once and is not enabled by anything yet: the account
   * keeps working with a password alone until a code proves the operator can
   * generate one.
   */
  abstract beginMfaSetup(): Observable<MfaSetup>;

  /** Confirms possession and returns the recovery codes, once. */
  abstract confirmMfa(code: string): Observable<readonly string[]>;

  abstract disableMfa(code: string): Observable<void>;

  /** Replaces every recovery code. Previously issued ones stop working. */
  abstract regenerateRecoveryCodes(code: string): Observable<readonly string[]>;
}

/** A stack's configuration, as an editor receives it. */
export interface StackConfiguration {
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly compose: string;
  readonly environment: readonly EnvironmentVariable[];
  readonly summary?: {
    readonly services: readonly string[];
    readonly networks: readonly string[];
    readonly volumes: readonly string[];
  } | null;
}

export interface ValidateComposeRequest {
  readonly projectName: string;
  readonly compose: string;
  /** Values are needed to resolve the file, and are neither stored nor echoed. */
  readonly environment: readonly { key: string; value: string; secret?: boolean }[];
}

/** One reason a Compose file was not accepted, as the compiler states it. */
export interface ComposeProblem {
  readonly path?: string;
  readonly code: string;
  readonly message: string;
}

export interface ComposeValidation {
  readonly valid: boolean;
  readonly errors: readonly ComposeProblem[];
  readonly summary?: {
    readonly projectName: string;
    readonly services: readonly {
      readonly name: string;
      readonly image: string;
      readonly ports: number;
      readonly mounts: number;
      readonly environment: readonly string[];
      readonly networks: readonly string[];
      readonly dependsOn: readonly string[];
    }[];
    readonly networks: readonly { readonly name: string; readonly external: boolean }[];
    readonly volumes: readonly { readonly name: string; readonly external: boolean }[];
  };
}

export interface CreateStackRequest {
  readonly name: string;
  readonly hostId: string;
  readonly compose: string;
  readonly environment: readonly EnvironmentChange[];
}

export interface SaveRevisionRequest {
  readonly baseRevisionId: string;
  readonly compose: string;
  readonly environment: readonly EnvironmentChange[];
}

export interface SavedRevision {
  readonly stackId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
}

/** What came of applying a revision. */
export interface ApplyOutcome {
  readonly deploymentId: string;
  readonly stackId: string;
  readonly revisionId: string;
  readonly kind: string;
  readonly status: string;
}

/** What came of deleting a stack, including what was deliberately kept. */
export interface StackDeletion {
  readonly stackId: string;
  readonly status: string;
  readonly retainedVolumes: readonly string[];
}

/** What came of starting, stopping or restarting a stack. */
export interface OperationOutcome {
  readonly operationId: string;
  readonly stackId: string;
  readonly operation: string;
  readonly status: string;
}

export interface MfaSetup {
  /** Base32 secret, shown so it can be entered by hand. */
  readonly secret: string;
  /** The otpauth:// URL an authenticator app reads from a QR code. */
  readonly otpauthUrl: string;
}

export type ContainerOperation = 'start' | 'stop' | 'restart';

/** A published port, as Dockplane describes one. */
export interface PortSpec {
  readonly containerPort: number;
  readonly hostPort?: number;
  readonly protocol: 'tcp' | 'udp';
  readonly hostIp?: string;
}

export interface MountSpec {
  readonly type: 'volume' | 'bind';
  readonly source: string;
  readonly target: string;
  readonly readOnly?: boolean;
}

/**
 * What is being done to one environment variable.
 *
 * The operation is explicit because a masked value must never be mistaken for a
 * new one: an interface that has not been shown a secret says the variable is
 * unchanged, and carries no value at all.
 */
export type EnvironmentChange =
  | { readonly operation: 'set'; readonly key: string; readonly value: string }
  | { readonly operation: 'set-secret'; readonly key: string; readonly value: string }
  | { readonly operation: 'unchanged'; readonly key: string }
  | { readonly operation: 'remove'; readonly key: string };

/** A container as it is asked for. Deliberately not a Docker API payload. */
export interface ContainerSpecRequest {
  readonly hostId?: string;
  readonly name?: string;
  readonly image: string;
  readonly hostname?: string;
  readonly command?: readonly string[];
  readonly entrypoint?: readonly string[];
  readonly ports?: readonly PortSpec[];
  readonly mounts?: readonly MountSpec[];
  readonly environment?: readonly EnvironmentChange[];
  readonly networks?: readonly string[];
  readonly restartPolicy?: 'no' | 'always' | 'unless-stopped' | 'on-failure';
  readonly labels?: Readonly<Record<string, string>>;
}

/** An environment variable as the server reports it: a secret carries no value. */
export interface EnvironmentVariable {
  readonly key: string;
  readonly secret: boolean;
  readonly value?: string;
}

export interface ContainerConfiguration {
  readonly name: string;
  readonly image: string;
  readonly hostname?: string;
  readonly command?: readonly string[];
  readonly entrypoint?: readonly string[];
  readonly ports: readonly PortSpec[];
  readonly mounts: readonly MountSpec[];
  readonly networks: readonly string[];
  readonly restartPolicy: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly environment: readonly EnvironmentVariable[];
  /** True while a change to this container has not been settled. */
  readonly reconciling: boolean;
}

/** What came of a change to a container. */
export interface ManagementOutcome {
  readonly actionId: string;
  readonly containerId: string;
  readonly status: string;
  readonly state?: string;
}

/** What came of an operation, as the server observed it afterwards. */
export interface ActionOutcome {
  readonly actionId: string;
  readonly status: 'succeeded' | 'failed' | 'timed_out';
  readonly state?: string;
  readonly health?: string;
  readonly observedAt?: string;
  readonly errorCode?: string;
}

export interface ActionRecord {
  readonly id: string;
  readonly capability: string;
  readonly status: string;
  readonly requestedAt: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly containerName: string;
  readonly hostname?: string;
  readonly actor?: string;
  readonly errorCode?: string;
}

/** The complete set of choices a viewer has. Nothing else reaches the host. */
export interface LogOptions {
  readonly tail?: number;
  readonly since?: string;
  readonly timestamps?: boolean;
  readonly stdout?: boolean;
  readonly stderr?: boolean;
}

export interface LogLine {
  readonly stream: 'stdout' | 'stderr';
  readonly timestamp?: string;
  readonly message: string;
  /** True when the line was longer than the agent forwards intact. */
  readonly truncated?: boolean;
}

export interface LogSnapshot {
  readonly lines: readonly LogLine[];
  /** Lines the host could not deliver, so a viewer can say the log is partial. */
  readonly dropped: number;
}

/** What a running stream reports. There is no event that carries input. */
export type LogEvent =
  | { readonly kind: 'open'; readonly streamId: string }
  | { readonly kind: 'lines'; readonly lines: readonly LogLine[] }
  | { readonly kind: 'dropped'; readonly count: number; readonly where: 'agent' | 'server' }
  | { readonly kind: 'end'; readonly reason: string; readonly code?: string };

export interface ContainerFilter {
  readonly hostId?: string;
  readonly state?: string;
  readonly project?: string;
  readonly search?: string;
}

export interface AuditQuery {
  readonly limit?: number;
  readonly before?: string;
  readonly action?: string;
}
