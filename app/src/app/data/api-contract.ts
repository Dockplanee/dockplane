/**
 * The control server's response shapes.
 *
 * These describe what the API actually returns, kept in one place so a backend
 * change is a single edit rather than a hunt through templates. Views never see
 * these types: everything is mapped into the domain model first, so a response
 * shape cannot leak into a component.
 */

export interface PageInfo {
  readonly limit: number;
  readonly offset: number;
  readonly total: number;
}

export interface HostResponse {
  readonly id: string;
  readonly hostname: string;
  readonly archived?: boolean;
  readonly archivedAt?: string | null;
  readonly displayName: string | null;
  readonly os: string | null;
  readonly architecture: string | null;
  readonly kernel: string | null;
  readonly dockerVersion: string | null;
  readonly agentVersion: string | null;
  readonly metadata: {
    readonly cpuCount?: number;
    readonly cpuModel?: string;
    readonly memoryTotalBytes?: number;
    readonly uptimeSeconds?: number;
  } | null;
  readonly metrics: {
    readonly cpuPercent?: number;
    readonly memoryUsedBytes?: number;
    readonly memoryTotalBytes?: number;
    readonly diskUsedBytes?: number;
    readonly diskTotalBytes?: number;
    readonly loadAverage?: {
      readonly one: number;
      readonly five: number;
      readonly fifteen: number;
    };
    readonly unavailable?: readonly string[];
    readonly observedAt?: string;
  } | null;
  readonly lastSeenAt: string | null;
  readonly agent: {
    readonly id: string;
    readonly status: 'connected' | 'disconnected' | 'revoked';
    readonly connected: boolean;
    readonly lastSeenAt: string | null;
    readonly certificateNotAfter: string;
  } | null;
  readonly observedAt: string | null;
  readonly stale: boolean;
}

export interface ContainerResponse {
  readonly id: string;
  readonly hostId: string;
  readonly hostname: string;
  readonly hostDisplayName?: string | null;
  readonly dockerId: string;
  readonly name: string;
  readonly image: string;
  readonly imageId: string | null;
  readonly state: string;
  readonly health: string;
  readonly restartCount: number;
  readonly createdAt: string | null;
  readonly composeProject: { readonly id: string; readonly name: string } | null;
  readonly metadata: { readonly service?: string; readonly status?: string } | null;
  readonly management: {
    readonly kind: string;
    readonly reconciling: boolean;
    readonly identityConflict: boolean;
  } | null;
  readonly observedAt: string | null;
  readonly stale: boolean;
  /**
   * Why the host could not be asked about this container, when it could not.
   *
   * The resource and the inspect are read separately: a host that is not
   * answering costs the detail and nothing else, so the container still
   * arrives and this says what is missing from it.
   */
  readonly detailUnavailable?: { readonly code: string; readonly message: string } | null;
}

/** The sanitised inspect projection. Never carries environment values. */
export interface ContainerDetailResponse {
  readonly dockerId: string;
  readonly name: string;
  readonly image: string;
  readonly imageId?: string;
  readonly state: string;
  readonly status: string;
  readonly health: string;
  readonly restartCount: number;
  readonly restartPolicy?: string;
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly exitCode?: number;
  readonly ports: readonly {
    readonly containerPort: number;
    readonly protocol: string;
    readonly hostPort?: string;
    readonly hostIp?: string;
  }[];
  readonly networks: readonly string[];
  readonly mounts: readonly {
    readonly type: string;
    readonly name?: string;
    readonly readOnly: boolean;
  }[];
  readonly limits?: {
    readonly memoryBytes?: number;
    readonly nanoCpus?: number;
    readonly pidsLimit?: number;
  };
  readonly labels: Record<string, string>;
}

export interface ComposeServiceResponse {
  readonly name: string;
  readonly containerIds: readonly string[];
  readonly running: number;
  readonly total: number;
  readonly state: string;
}

export interface ComposeProjectResponse {
  readonly id: string;
  readonly hostId: string;
  readonly hostname: string;
  readonly projectName: string;
  readonly status: string;
  readonly serviceCount: number;
  readonly runningCount: number;
  readonly services: readonly ComposeServiceResponse[];
  readonly observedAt: string | null;
  readonly stale: boolean;
  readonly detailObservedAt?: string | null;
  readonly containers?: readonly {
    readonly id: string;
    readonly dockerId: string;
    readonly name: string;
    readonly state: string;
    readonly health: string;
    readonly observedAt: string | null;
    readonly stale: boolean;
  }[];
}

export interface StackRevisionRefResponse {
  readonly id: string;
  readonly number: number;
  readonly summary: {
    readonly services: readonly string[];
    readonly networks: readonly string[];
    readonly volumes: readonly string[];
  } | null;
}

/**
 * A stack as a listing and a detail read both describe it.
 *
 * The host is carried as both names the control server knows: several host
 * resources can report the same system hostname, so the display name is what
 * tells an operator which of them a stack is on.
 */
export interface StackResponse {
  readonly id: string;
  readonly name: string;
  readonly hostId: string;
  readonly hostname: string;
  readonly hostDisplayName?: string | null;
  readonly sourceType: string;
  readonly status: string;
  readonly latestRevision: StackRevisionRefResponse | null;
  readonly deployedRevision: StackRevisionRefResponse | null;
  readonly deployedRevisionId: string | null;
  readonly reconciling: boolean;
  readonly hostReachable: boolean;
  readonly lastDeployedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentResponse {
  readonly id: string;
  readonly hostId: string;
  readonly hostname: string;
  readonly hostDisplayName?: string | null;
  readonly certificateSerial: string;
  readonly certificateNotAfter: string;
  readonly version: string | null;
  readonly protocolVersion: number;
  readonly status: 'pending' | 'connected' | 'disconnected' | 'revoked';
  readonly enrolledAt: string;
  readonly firstSeenAt: string | null;
  readonly lastSeenAt: string | null;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly connected: boolean;
}

export interface EnrollmentTokenResponse {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly note: string;
}

export interface EnrollmentTokenSummary {
  readonly id: string;
  readonly intendedHostname: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly consumedByAgentId: string | null;
  readonly revokedAt: string | null;
}

export interface AuditEntryResponse {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorLabel: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly targetLabel: string | null;
  readonly result: string;
  readonly requestId: string | null;
  readonly sourceIp: string | null;
  readonly reasonCode: string | null;
}

export interface SessionResponse {
  readonly id: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly userAgent: string | null;
  readonly sourceIp: string | null;
  readonly current: boolean;
}

export interface UserResponse {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: string;
  readonly mfaEnabled: boolean;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
  readonly roles: readonly { readonly id: string; readonly name: string }[];
}

export interface RoleResponse {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly isBuiltIn: boolean;
  readonly permissions: readonly string[];
}
