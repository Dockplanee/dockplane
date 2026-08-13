import { Injectable, inject } from '@angular/core';
import { Observable, Subscriber, map } from 'rxjs';

import { API_BASE_URL } from '../core/api-config';
import { ApiClient } from '../core/api-client';
import {
  ComposeMember,
  ComposeProject,
  ComposeService,
  Container,
  ContainerDetail,
  ContainerManagement,
  Host,
  Mount,
  PortBinding,
  ResourceUsage,
} from '../domain/inventory';
import { OperatorSession } from '../domain/sessions';
import {
  Agent,
  AuditEntry,
  AuditPage,
  CreatedHostSetup,
  EnrollmentToken,
  HostSetup,
  Role,
  User,
} from '../domain/operations';
import {
  AgentStatus,
  ComposeState,
  ContainerHealth,
  ContainerState,
  HostStatus,
} from '../domain/status';
import {
  AgentResponse,
  AuditEntryResponse,
  ComposeProjectResponse,
  ComposeServiceResponse,
  ContainerDetailResponse,
  ContainerResponse,
  EnrollmentTokenResponse,
  HostResponse,
  RoleResponse,
  SessionResponse,
  UserResponse,
} from './api-contract';
import {
  ActionOutcome,
  ContainerConfiguration,
  ContainerSpecRequest,
  ManagementOutcome,
  ActionRecord,
  AuditQuery,
  ContainerFilter,
  ContainerOperation,
  DockplaneApi,
  LogEvent,
  LogLine,
  LogOptions,
  LogSnapshot,
  MfaSetup,
} from './dockplane-api';

/** A page large enough for a fleet view without asking the server for everything. */
const PAGE_SIZE = 200;

/**
 * The control server, over HTTP.
 *
 * Responses are mapped into the domain model here and nowhere else, so a change
 * in the API shape is one edit rather than a hunt through templates, and no
 * component ever sees a raw response.
 */
@Injectable()
export class RealDockplaneApi extends DockplaneApi {
  private readonly api = inject(ApiClient);
  private readonly base = inject(API_BASE_URL);

  hosts(): Observable<readonly Host[]> {
    return this.api
      .get<{ hosts: readonly HostResponse[] }>('/api/v1/hosts', { limit: PAGE_SIZE })
      .pipe(map((response) => response.hosts.map(toHost)));
  }

  host(id: string): Observable<Host | undefined> {
    return this.api
      .get<{ host: HostResponse }>(`/api/v1/hosts/${id}`)
      .pipe(map((response) => toHost(response.host)));
  }

  containers(filter?: ContainerFilter): Observable<readonly Container[]> {
    return this.api
      .get<{ containers: readonly ContainerResponse[] }>('/api/v1/containers', {
        limit: PAGE_SIZE,
        hostId: filter?.hostId,
        state: filter?.state,
        project: filter?.project,
        search: filter?.search,
      })
      .pipe(map((response) => response.containers.map(toContainer)));
  }

  container(id: string): Observable<Container | undefined> {
    return this.api
      .get<{ container: ContainerResponse }>(`/api/v1/containers/${id}`)
      .pipe(map((response) => toContainer(response.container)));
  }

  containerDetail(id: string): Observable<ContainerDetail> {
    return this.api
      .get<{
        container: ContainerResponse & {
          detail: ContainerDetailResponse | null;
          detailObservedAt: string | null;
        };
      }>(`/api/v1/containers/${id}`)
      .pipe(map((response) => toContainerDetail(response.container)));
  }

  runContainerOperation(
    operation: ContainerOperation,
    containerId: string,
  ): Observable<ActionOutcome> {
    return this.api.post<ActionOutcome>(`/api/v1/containers/${containerId}/${operation}`);
  }

  containerConfiguration(id: string): Observable<ContainerConfiguration> {
    return this.api
      .get<{
        configuration: Omit<ContainerConfiguration, 'reconciling'>;
        reconciling: boolean;
      }>(`/api/v1/containers/${id}/configuration`)
      .pipe(map((response) => ({ ...response.configuration, reconciling: response.reconciling })));
  }

  createContainer(request: ContainerSpecRequest): Observable<ManagementOutcome> {
    return this.api.post<ManagementOutcome>('/api/v1/containers', request);
  }

  replaceContainer(id: string, request: ContainerSpecRequest): Observable<ManagementOutcome> {
    return this.api.put<ManagementOutcome>(`/api/v1/containers/${id}`, request);
  }

  removeContainer(
    id: string,
    options: { stopFirst?: boolean } = {},
  ): Observable<ManagementOutcome> {
    return this.api.delete<ManagementOutcome>(`/api/v1/containers/${id}`, {
      stopFirst: options.stopFirst ?? false,
    });
  }

  containerLogs(containerId: string, options: LogOptions = {}): Observable<LogSnapshot> {
    return this.api
      .get<{ lines: readonly LogLine[]; dropped: number }>(
        `/api/v1/containers/${containerId}/logs`,
        logParams(options),
      )
      .pipe(map((response) => ({ lines: response.lines, dropped: response.dropped })));
  }

  /**
   * Follows a container's output over server-sent events.
   *
   * Read with fetch rather than EventSource for two reasons that matter here: a
   * refusal arrives as a status code the interface can name, instead of an
   * anonymous error, and an AbortController ends the request the moment a
   * subscriber goes away — which is what stops the read on the host.
   */
  streamContainerLogs(containerId: string, options: LogOptions = {}): Observable<LogEvent> {
    const query = new URLSearchParams();

    for (const [key, value] of Object.entries(logParams(options))) {
      if (value !== undefined) {
        query.set(key, String(value));
      }
    }

    const url =
      `${this.base.replace(/\/$/, '')}/api/v1/containers/${containerId}` +
      `/logs/stream?${query.toString()}`;

    return new Observable<LogEvent>((subscriber) => {
      const controller = new AbortController();

      void readEventStream(url, controller.signal, subscriber);

      return () => controller.abort();
    });
  }

  actions(options?: { limit?: number; offset?: number }): Observable<readonly ActionRecord[]> {
    return this.api
      .get<{ actions: readonly ActionRecord[] }>('/api/v1/actions', {
        limit: options?.limit ?? 50,
        offset: options?.offset,
      })
      .pipe(map((response) => response.actions));
  }

  composeProjects(): Observable<readonly ComposeProject[]> {
    return this.api
      .get<{ projects: readonly ComposeProjectResponse[] }>('/api/v1/compose-projects', {
        limit: PAGE_SIZE,
      })
      .pipe(map((response) => response.projects.map(toComposeProject)));
  }

  composeProject(id: string): Observable<ComposeProject | undefined> {
    return this.api
      .get<{ project: ComposeProjectResponse }>(`/api/v1/compose-projects/${id}`)
      .pipe(map((response) => toComposeProject(response.project)));
  }

  agents(): Observable<readonly Agent[]> {
    return this.api
      .get<{ agents: readonly AgentResponse[] }>('/api/v1/agents')
      .pipe(map((response) => response.agents.map(toAgent)));
  }

  /**
   * Issues an enrollment token.
   *
   * The raw value is in this response and nowhere else. The caller shows it
   * once; it is never stored, and asking again produces a different token
   * rather than the same one.
   */
  /**
   * Creates a host setup and returns its one-time bootstrap ticket.
   *
   * The ticket is in this response and nowhere else. It is never put in a URL:
   * the installer sends it in a request body, so it does not end up in a proxy
   * or server access log on the way.
   */
  createHostSetup(displayName?: string): Observable<CreatedHostSetup> {
    return this.api.post<CreatedHostSetup>('/api/v1/host-setups', { displayName });
  }

  hostSetup(id: string): Observable<HostSetup> {
    return this.api.get<HostSetup>(`/api/v1/host-setups/${encodeURIComponent(id)}`);
  }

  regenerateHostSetup(id: string): Observable<CreatedHostSetup> {
    return this.api.post<CreatedHostSetup>(
      `/api/v1/host-setups/${encodeURIComponent(id)}/regenerate`,
      {},
    );
  }

  cancelHostSetup(id: string): Observable<HostSetup> {
    return this.api.post<HostSetup>(`/api/v1/host-setups/${encodeURIComponent(id)}/cancel`, {});
  }

  createEnrollmentToken(intendedHostname?: string): Observable<EnrollmentToken> {
    return this.api
      .post<EnrollmentTokenResponse>('/api/v1/agents/enrollment-tokens', { intendedHostname })
      .pipe(
        map((response) => ({
          id: response.id,
          token: response.token,
          expiresAt: response.expiresAt,
        })),
      );
  }

  revokeAgent(id: string, reason: string): Observable<void> {
    return this.api.post<void>(`/api/v1/agents/${id}/revoke`, { reason });
  }

  auditEntries(options?: AuditQuery): Observable<AuditPage> {
    return this.api
      .get<{ entries: readonly AuditEntryResponse[]; nextBefore: string | null }>('/api/v1/audit', {
        limit: options?.limit ?? 50,
        before: options?.before,
        action: options?.action,
      })
      .pipe(
        map((response) => ({
          entries: response.entries.map(toAuditEntry),
          nextBefore: response.nextBefore ?? undefined,
        })),
      );
  }

  users(): Observable<readonly User[]> {
    return this.api
      .get<{ users: readonly UserResponse[] }>('/api/v1/users')
      .pipe(map((response) => response.users.map(toUser)));
  }

  assignRole(userId: string, role: string): Observable<void> {
    return this.api.post<void>(`/api/v1/users/${userId}/roles`, { role });
  }

  roles(): Observable<readonly Role[]> {
    return this.api
      .get<{ roles: readonly RoleResponse[] }>('/api/v1/roles')
      .pipe(map((response) => response.roles.map(toRole)));
  }

  sessions(): Observable<readonly OperatorSession[]> {
    return this.api
      .get<{ sessions: readonly SessionResponse[] }>('/api/v1/sessions')
      .pipe(map((response) => response.sessions.map(toSession)));
  }

  revokeSession(id: string): Observable<void> {
    return this.api.delete<void>(`/api/v1/sessions/${id}`);
  }

  beginMfaSetup(): Observable<MfaSetup> {
    return this.api.post<MfaSetup>('/api/v1/mfa/setup');
  }

  confirmMfa(code: string): Observable<readonly string[]> {
    return this.api
      .post<{ recoveryCodes: readonly string[] }>('/api/v1/mfa/confirm', { code: code.trim() })
      .pipe(map((response) => response.recoveryCodes));
  }

  disableMfa(code: string): Observable<void> {
    return this.api.post<void>('/api/v1/mfa/disable', { code: code.trim() });
  }

  regenerateRecoveryCodes(code: string): Observable<readonly string[]> {
    return this.api
      .post<{ recoveryCodes: readonly string[] }>('/api/v1/mfa/recovery-codes/regenerate', {
        code: code.trim(),
      })
      .pipe(map((response) => response.recoveryCodes));
  }
}

function toSession(session: SessionResponse): OperatorSession {
  return {
    id: session.id,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
    userAgent: session.userAgent ?? undefined,
    sourceIp: session.sourceIp ?? undefined,
    current: session.current,
  };
}

/**
 * Host status, derived from what is actually known.
 *
 * A host whose agent is gone is offline regardless of what it last reported; a
 * host nothing is refreshing is unknown rather than healthy. Metrics never
 * decide status here, because a stale reading is not evidence of anything.
 */
function toHostStatus(host: HostResponse): HostStatus {
  if (host.agent?.status === 'revoked') {
    return 'critical';
  }

  if (!host.agent || host.agent.connected === false) {
    return 'offline';
  }

  return host.stale ? 'unknown' : 'healthy';
}

function toHost(host: HostResponse): Host {
  const metrics = host.metrics ?? {};

  return {
    id: host.id,
    name: host.displayName ?? host.hostname,
    status: toHostStatus(host),
    os: host.os ?? undefined,
    architecture: host.architecture ?? undefined,
    kernel: host.kernel ?? undefined,
    dockerVersion: host.dockerVersion ?? undefined,
    agentId: host.agent?.id,
    agentStatus: host.agent?.status as AgentStatus | undefined,
    agentVersion: host.agentVersion ?? undefined,
    certificateNotAfter: host.agent?.certificateNotAfter,
    // Discovery counts containers separately; the host record does not carry
    // them, so they are filled in by whoever already has the container list.
    containersRunning: 0,
    containersTotal: 0,
    cpu: percentage(metrics.cpuPercent),
    memory: ratio(metrics.memoryUsedBytes, metrics.memoryTotalBytes),
    disk: ratio(metrics.diskUsedBytes, metrics.diskTotalBytes),
    uptimeSeconds: host.metadata?.uptimeSeconds,
    lastSeen: host.lastSeenAt ?? undefined,
    observedAt: host.observedAt ?? undefined,
    stale: host.stale,
  };
}

function toContainer(container: ContainerResponse): Container {
  return {
    id: container.id,
    name: container.name,
    hostId: container.hostId,
    hostname: container.hostname,
    dockerId: container.dockerId,
    image: container.image,
    imageId: container.imageId ?? undefined,
    state: toContainerState(container.state),
    health: toContainerHealth(container.health),
    restarts: container.restartCount,
    createdAt: container.createdAt ?? undefined,
    composeProjectId: container.composeProject?.id,
    composeProjectName: container.composeProject?.name,
    composeService: container.metadata?.service,
    management: toManagement(container),
    observedAt: container.observedAt ?? undefined,
    stale: container.stale,
  };
}

/**
 * What the server said may be done to this container.
 *
 * A server that says nothing is treated as saying `external`, which offers
 * least: an interface that assumed a container was Dockplane's because a field
 * was missing would offer to change somebody else's workload.
 */
function toManagement(container: ContainerResponse): ContainerManagement {
  const management = container.management;

  return {
    kind:
      management?.kind === 'managed' || management?.kind === 'stack' ? management.kind : 'external',
    reconciling: management?.reconciling ?? false,
    identityConflict: management?.identityConflict ?? false,
  };
}

function toContainerDetail(
  container: ContainerResponse & {
    detail: ContainerDetailResponse | null;
    detailObservedAt: string | null;
  },
): ContainerDetail {
  const detail = container.detail;

  return {
    dockerId: detail?.dockerId ?? container.dockerId,
    name: detail?.name ?? container.name,
    image: detail?.image ?? container.image,
    imageId: detail?.imageId,
    state: toContainerState(detail?.state ?? container.state),
    health: toContainerHealth(detail?.health ?? container.health),
    restarts: detail?.restartCount ?? container.restartCount,
    restartPolicy: detail?.restartPolicy,
    createdAt: detail?.createdAt ?? container.createdAt ?? undefined,
    startedAt: detail?.startedAt,
    finishedAt: detail?.finishedAt,
    exitCode: detail?.exitCode,
    ports: (detail?.ports ?? []).map(toPort),
    networks: [...(detail?.networks ?? [])],
    mounts: (detail?.mounts ?? []).map(toMount),
    limits: detail?.limits,
    observedAt: container.detailObservedAt ?? undefined,
    stale: container.stale,
  };
}

function toPort(port: ContainerDetailResponse['ports'][number]): PortBinding {
  return {
    containerPort: port.containerPort,
    hostPort: port.hostPort,
    hostIp: port.hostIp,
    protocol: port.protocol,
  };
}

function toMount(mount: ContainerDetailResponse['mounts'][number]): Mount {
  return { type: mount.type, name: mount.name, readOnly: mount.readOnly };
}

function toComposeProject(project: ComposeProjectResponse): ComposeProject {
  return {
    id: project.id,
    name: project.projectName,
    hostId: project.hostId,
    hostname: project.hostname,
    state: toComposeState(project.status),
    servicesTotal: project.serviceCount,
    servicesRunning: project.runningCount,
    services: (project.services ?? []).map(toComposeService),
    containers: (project.containers ?? []).map(toComposeMember),
    observedAt: project.detailObservedAt ?? project.observedAt ?? undefined,
    stale: project.stale,
  };
}

function toComposeService(service: ComposeServiceResponse): ComposeService {
  return {
    name: service.name,
    containerIds: [...service.containerIds],
    running: service.running,
    total: service.total,
    state: toComposeState(service.state),
  };
}

function toComposeMember(
  member: NonNullable<ComposeProjectResponse['containers']>[number],
): ComposeMember {
  return {
    id: member.id,
    dockerId: member.dockerId,
    name: member.name,
    state: toContainerState(member.state),
    health: toContainerHealth(member.health),
    stale: member.stale,
  };
}

function toAgent(agent: AgentResponse): Agent {
  return {
    id: agent.id,
    hostId: agent.hostId,
    hostname: agent.hostname,
    version: agent.version ?? undefined,
    status: agent.status as AgentStatus,
    connected: agent.connected,
    lastSeen: agent.lastSeenAt ?? undefined,
    enrolledAt: agent.enrolledAt,
    protocolVersion: agent.protocolVersion,
    certificateNotAfter: agent.certificateNotAfter,
    revokedAt: agent.revokedAt ?? undefined,
    revocationReason: agent.revocationReason ?? undefined,
  };
}

function toAuditEntry(entry: AuditEntryResponse): AuditEntry {
  return {
    id: entry.id,
    time: entry.occurredAt,
    actor: entry.actorLabel ?? 'system',
    action: entry.action,
    target: entry.targetLabel ?? entry.targetId ?? entry.targetType ?? '—',
    result: entry.result === 'success' ? 'success' : 'failure',
    source: entry.sourceIp ?? undefined,
    requestId: entry.requestId ?? undefined,
  };
}

function toUser(user: UserResponse & { isActive?: boolean }): User {
  return {
    id: user.id,
    name: user.displayName,
    email: user.email,
    roleIds: (user.roles ?? []).map((role) => role.id),
    roleNames: (user.roles ?? []).map((role) => role.name),
    mfaEnabled: user.mfaEnabled,
    status: user.isActive === false ? 'disabled' : 'active',
    lastLogin: user.lastLoginAt ?? undefined,
    createdAt: user.createdAt,
  };
}

function toRole(role: RoleResponse): Role {
  return {
    id: role.id,
    name: role.name,
    description: role.description ?? undefined,
    permissions: [...role.permissions],
    builtIn: role.isBuiltIn,
  };
}

const CONTAINER_STATES = new Set<ContainerState>([
  'running',
  'stopped',
  'starting',
  'stopping',
  'restarting',
  'failed',
]);

/**
 * Maps Docker's own state vocabulary onto the interface's.
 *
 * Docker reports `exited`, `created`, `dead` and `paused`; the interface speaks
 * a smaller language. An unrecognised state becomes `stopped` rather than being
 * rendered raw, because a status the design has no tone for reads as broken.
 */
function toContainerState(state: string): ContainerState {
  if (CONTAINER_STATES.has(state as ContainerState)) {
    return state as ContainerState;
  }

  switch (state) {
    case 'exited':
    case 'created':
    case 'paused':
      return 'stopped';
    case 'dead':
      return 'failed';
    default:
      return 'stopped';
  }
}

function toContainerHealth(health: string): ContainerHealth {
  switch (health) {
    case 'healthy':
    case 'unhealthy':
    case 'starting':
      return health;
    default:
      return 'none';
  }
}

function toComposeState(state: string): ComposeState {
  switch (state) {
    case 'running':
    case 'degraded':
    case 'stopped':
    case 'failed':
      return state;
    default:
      return 'unknown';
  }
}

function percentage(value?: number): ResourceUsage | undefined {
  return typeof value === 'number' ? { percent: Math.min(100, Math.max(0, value)) } : undefined;
}

function ratio(used?: number, total?: number): ResourceUsage | undefined {
  if (typeof used !== 'number' || typeof total !== 'number' || total <= 0) {
    return undefined;
  }

  return {
    percent: Math.min(100, Math.max(0, (used / total) * 100)),
    detail: `${gibibytes(used)} / ${gibibytes(total)} GiB`,
  };
}

function gibibytes(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

function logParams(options: LogOptions): Record<string, string | number | undefined> {
  return {
    tail: options.tail ?? 500,
    since: options.since,
    timestamps: String(options.timestamps ?? true),
    stdout: String(options.stdout ?? true),
    stderr: String(options.stderr ?? true),
  };
}

/**
 * Reads a server-sent event stream into an observable.
 *
 * Frames are separated by a blank line, so the reader keeps whatever is left
 * over between chunks rather than assuming a frame arrives whole.
 */
async function readEventStream(
  url: string,
  signal: AbortSignal,
  subscriber: Subscriber<LogEvent>,
): Promise<void> {
  let response: Response;

  try {
    response = await fetch(url, {
      credentials: 'include',
      headers: { accept: 'text/event-stream' },
      signal,
    });
  } catch {
    if (!signal.aborted) {
      subscriber.next({ kind: 'end', reason: 'failed', code: 'NETWORK_UNAVAILABLE' });
      subscriber.complete();
    }

    return;
  }

  if (!response.ok || !response.body) {
    subscriber.next({
      kind: 'end',
      reason: 'failed',
      code: await failureCode(response),
    });
    subscriber.complete();

    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');

      while (boundary !== -1) {
        const event = parseFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);

        if (event) {
          subscriber.next(event);
        }

        boundary = buffer.indexOf('\n\n');
      }
    }
  } catch {
    if (!signal.aborted) {
      subscriber.next({ kind: 'end', reason: 'failed', code: 'NETWORK_UNAVAILABLE' });
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }

  subscriber.complete();
}

/** Reads the server's own error code from a refusal, never inventing one. */
async function failureCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { code?: string };

    if (typeof body.code === 'string') {
      return body.code;
    }
  } catch {
    // A refusal without a body still has a status to report.
  }

  return response.status === 403 ? 'PERMISSION_DENIED' : 'LOG_STREAM_UNAVAILABLE';
}

/**
 * Turns one event-stream frame into an event, or into nothing.
 *
 * A frame that is only a comment — the keepalive that holds a quiet connection
 * open — carries no event and no data, so it produces nothing. It must never
 * reach the viewer as a line: it is not output.
 */
function parseFrame(frame: string): LogEvent | undefined {
  const name = /^event: (.+)$/m.exec(frame)?.[1];
  const payload = /^data: (.+)$/m.exec(frame)?.[1];

  if (!name || !payload) {
    return undefined;
  }

  let data: Record<string, unknown>;

  try {
    data = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const lines = data['lines'];
  const count = data['count'];
  const code = data['code'];

  switch (name) {
    case 'open':
      return { kind: 'open', streamId: String(data['streamId'] ?? '') };

    case 'lines':
      return { kind: 'lines', lines: Array.isArray(lines) ? (lines as LogLine[]) : [] };

    case 'dropped':
      return {
        kind: 'dropped',
        count: typeof count === 'number' ? count : 0,
        where: data['where'] === 'server' ? 'server' : 'agent',
      };

    case 'end':
      return {
        kind: 'end',
        reason: String(data['reason'] ?? 'failed'),
        code: typeof code === 'string' ? code : undefined,
      };

    default:
      return undefined;
  }
}
