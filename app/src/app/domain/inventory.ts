import {
  AgentStatus,
  ComposeState,
  ContainerHealth,
  ContainerState,
  HostStatus,
  Severity,
} from './status';

/**
 * Docker inventory reported by agents.
 *
 * Timestamps are ISO 8601 in UTC, matching the control server contract. Metric
 * values are optional because an offline or stale host has nothing current to
 * report, and the interface must not fall back to an older value.
 */

export interface ResourceUsage {
  /** Percentage between 0 and 100. */
  readonly percent: number;
  /** Human-readable absolute value, for example `5.1 / 16 GiB`. */
  readonly detail?: string;
}

export interface Host {
  readonly id: string;
  readonly name: string;
  readonly status: HostStatus;
  readonly os?: string;
  readonly architecture?: string;
  readonly kernel?: string;
  readonly dockerVersion?: string;
  readonly agentId?: string;
  readonly agentStatus?: AgentStatus;
  readonly agentVersion?: string;
  readonly certificateNotAfter?: string;
  readonly containersRunning: number;
  readonly containersTotal: number;
  readonly cpu?: ResourceUsage;
  readonly memory?: ResourceUsage;
  readonly disk?: ResourceUsage;
  /** Seconds since boot. Absent while the host is not reporting. */
  readonly uptimeSeconds?: number;
  readonly lastSeen?: string;
  /** When the host last reported. Absent before the first discovery pass. */
  readonly observedAt?: string;
  /**
   * True when nothing is refreshing this record.
   *
   * Set whenever the agent is disconnected, however recent the observation was,
   * and when a connected agent has not reported for several intervals.
   */
  readonly stale: boolean;
}

/**
 * Who decides what a container is.
 *
 * `managed` — Dockplane built it and holds the configuration it should have.
 * `external` — it was discovered on the host and belongs to somebody else.
 * `stack` — it belongs to a Compose project, which is where its configuration
 * comes from.
 */
export type ManagementKind = 'managed' | 'external' | 'stack';

/**
 * What may be done to a container, beyond what a permission allows.
 *
 * The interface uses this to decide what to offer. It is not what decides
 * whether an operation is permitted: the control server refuses on its own
 * account, and a button that is absent here is a courtesy rather than a
 * boundary.
 */
export interface ContainerManagement {
  readonly kind: ManagementKind;
  /**
   * A change that has not been settled.
   *
   * Either a configuration the container is being asked to become, or an
   * operation that was dispatched and never confirmed. Both mean nothing may be
   * done to it until Dockplane has read its host again.
   */
  readonly reconciling: boolean;
  /** Two Docker containers claim to be this one. */
  readonly identityConflict: boolean;
}

/** A container as discovery lists it. Detail is a separate, on-demand read. */
export interface Container {
  readonly id: string;
  readonly name: string;
  readonly hostId: string;
  readonly hostname: string;
  readonly dockerId: string;
  readonly image: string;
  readonly imageId?: string;
  readonly state: ContainerState;
  readonly health: ContainerHealth;
  readonly restarts: number;
  readonly createdAt?: string;
  readonly composeProjectId?: string;
  readonly composeProjectName?: string;
  readonly composeService?: string;
  readonly management: ContainerManagement;
  readonly observedAt?: string;
  readonly stale: boolean;
}

/**
 * The inspect projection.
 *
 * A deliberate subset of what Docker reports. Environment values, registry
 * credentials, the configured command and bind-mount host paths are never part
 * of it, so there is nothing here to redact in the interface.
 */
export interface ContainerDetail {
  readonly dockerId: string;
  readonly name: string;
  readonly image: string;
  readonly imageId?: string;
  readonly state: ContainerState;
  readonly health: ContainerHealth;
  readonly restarts: number;
  readonly restartPolicy?: string;
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly exitCode?: number;
  readonly ports: readonly PortBinding[];
  readonly networks: readonly string[];
  readonly mounts: readonly Mount[];
  readonly limits?: ResourceLimits;
  readonly observedAt?: string;
  readonly stale: boolean;
}

export interface ResourceLimits {
  readonly memoryBytes?: number;
  readonly nanoCpus?: number;
  readonly pidsLimit?: number;
}

export interface PortBinding {
  readonly containerPort: number;
  readonly hostPort?: string;
  readonly hostIp?: string;
  readonly protocol: string;
}

/**
 * Storage attached to a container.
 *
 * A named volume carries its name. A bind mount reports only that it exists and
 * whether it is writable: the host path is the machine's filesystem layout and
 * is never sent to the browser.
 */
export interface Mount {
  readonly type: string;
  readonly name?: string;
  readonly readOnly: boolean;
}

export interface ComposeProject {
  readonly id: string;
  readonly name: string;
  readonly hostId: string;
  readonly hostname: string;
  readonly state: ComposeState;
  readonly servicesTotal: number;
  readonly servicesRunning: number;
  readonly services: readonly ComposeService[];
  readonly containers: readonly ComposeMember[];
  readonly observedAt?: string;
  readonly stale: boolean;
}

export interface ComposeService {
  readonly name: string;
  readonly containerIds: readonly string[];
  readonly running: number;
  readonly total: number;
  readonly state: ComposeState;
}

/** A container the project owns, as the registry knows it. */
export interface ComposeMember {
  readonly id: string;
  readonly dockerId: string;
  readonly name: string;
  readonly state: ContainerState;
  readonly health: ContainerHealth;
  readonly stale: boolean;
}

export interface Image {
  readonly id: string;
  readonly repository: string;
  readonly tag: string;
  readonly hostIds: readonly string[];
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly usedBy: readonly string[];
}

export interface Volume {
  readonly id: string;
  readonly name: string;
  readonly hostId: string;
  readonly driver: string;
  readonly usedBy: readonly string[];
  readonly createdAt: string;
}

export interface Network {
  readonly id: string;
  readonly name: string;
  readonly hostId: string;
  readonly driver: string;
  readonly scope: string;
  readonly attached: readonly string[];
}

export interface LogLine {
  readonly timestamp: string;
  readonly stream: 'stdout' | 'stderr';
  readonly level?: string;
  readonly message: string;
}

export interface HealthIssue {
  readonly id: string;
  readonly severity: Severity;
  readonly title: string;
  readonly detail: string;
  readonly hostId?: string;
  readonly resource: string;
  readonly kind: 'host' | 'container' | 'compose' | 'agent' | 'image';
  readonly since: string;
  /** Router path that leads to the cause. */
  readonly link?: readonly string[];
}
