import { Observable } from 'rxjs';

import { ComposeProject, Container, ContainerDetail, Host } from '../domain/inventory';
import { Agent, AuditPage, EnrollmentToken, Role, User } from '../domain/operations';
import { OperatorSession } from '../domain/sessions';

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

  abstract composeProjects(): Observable<readonly ComposeProject[]>;
  abstract composeProject(id: string): Observable<ComposeProject | undefined>;

  abstract agents(): Observable<readonly Agent[]>;
  abstract createEnrollmentToken(intendedHostname?: string): Observable<EnrollmentToken>;
  abstract revokeAgent(id: string, reason: string): Observable<void>;

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

export interface MfaSetup {
  /** Base32 secret, shown so it can be entered by hand. */
  readonly secret: string;
  /** The otpauth:// URL an authenticator app reads from a QR code. */
  readonly otpauthUrl: string;
}

export type ContainerOperation = 'start' | 'stop' | 'restart';

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
