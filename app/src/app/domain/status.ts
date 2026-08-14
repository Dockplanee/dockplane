/**
 * Shared operational vocabulary.
 *
 * The status language is fixed in docs/design/APP_UI_SPEC.md. Every status is
 * rendered with a label, so a tone is only ever a visual reinforcement.
 */

export type StatusTone = 'ok' | 'warn' | 'critical' | 'info' | 'neutral';

export type HostStatus = 'healthy' | 'warning' | 'critical' | 'offline' | 'unknown';

export type ContainerState =
  'running' | 'stopped' | 'starting' | 'stopping' | 'restarting' | 'failed';

export type ContainerHealth = 'healthy' | 'unhealthy' | 'starting' | 'none';

export type ComposeState = 'running' | 'degraded' | 'stopped' | 'failed' | 'unknown';

export type AgentStatus = 'connected' | 'disconnected' | 'revoked' | 'pending';

export type ActionStatus =
  'queued' | 'running' | 'succeeded' | 'failed' | 'timed-out' | 'cancelled';

export type Severity = 'critical' | 'warning' | 'info';

export type AuditResult = 'success' | 'failure';

const HOST_STATUS: Record<HostStatus, { label: string; tone: StatusTone }> = {
  healthy: { label: 'Healthy', tone: 'ok' },
  warning: { label: 'Warning', tone: 'warn' },
  critical: { label: 'Critical', tone: 'critical' },
  offline: { label: 'Offline', tone: 'critical' },
  unknown: { label: 'Unknown', tone: 'neutral' },
};

const CONTAINER_STATE: Record<ContainerState, { label: string; tone: StatusTone }> = {
  running: { label: 'Running', tone: 'ok' },
  stopped: { label: 'Stopped', tone: 'neutral' },
  starting: { label: 'Starting', tone: 'info' },
  stopping: { label: 'Stopping', tone: 'info' },
  restarting: { label: 'Restarting', tone: 'warn' },
  failed: { label: 'Failed', tone: 'critical' },
};

const CONTAINER_HEALTH: Record<ContainerHealth, { label: string; tone: StatusTone }> = {
  healthy: { label: 'Healthy', tone: 'ok' },
  unhealthy: { label: 'Unhealthy', tone: 'critical' },
  starting: { label: 'Starting', tone: 'info' },
  none: { label: 'No health check', tone: 'neutral' },
};

const COMPOSE_STATE: Record<ComposeState, { label: string; tone: StatusTone }> = {
  running: { label: 'Running', tone: 'ok' },
  degraded: { label: 'Degraded', tone: 'warn' },
  stopped: { label: 'Stopped', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'critical' },
  unknown: { label: 'Unknown', tone: 'neutral' },
};

const AGENT_STATUS: Record<AgentStatus, { label: string; tone: StatusTone }> = {
  connected: { label: 'Connected', tone: 'ok' },
  disconnected: { label: 'Disconnected', tone: 'critical' },
  revoked: { label: 'Revoked', tone: 'neutral' },
  pending: { label: 'Pending', tone: 'info' },
};

const ACTION_STATUS: Record<ActionStatus, { label: string; tone: StatusTone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  succeeded: { label: 'Succeeded', tone: 'ok' },
  failed: { label: 'Failed', tone: 'critical' },
  'timed-out': { label: 'Timed out', tone: 'critical' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const SEVERITY: Record<Severity, { label: string; tone: StatusTone }> = {
  critical: { label: 'Critical', tone: 'critical' },
  warning: { label: 'Warning', tone: 'warn' },
  info: { label: 'Info', tone: 'info' },
};

export const hostStatus = (value: HostStatus) => HOST_STATUS[value];
export const containerState = (value: ContainerState) => CONTAINER_STATE[value];
export const containerHealth = (value: ContainerHealth) => CONTAINER_HEALTH[value];
export const composeState = (value: ComposeState) => COMPOSE_STATE[value];
export const agentStatus = (value: AgentStatus) => AGENT_STATUS[value];
export const actionStatus = (value: ActionStatus) => ACTION_STATUS[value];
export const severity = (value: Severity) => SEVERITY[value];

/**
 * How a container's state is shown, given how fresh the observation is.
 *
 * A state nobody has confirmed for a while is still worth showing — it is what
 * the host last said — but showing it the way a live one is shown makes a page
 * of abandoned records read as a page of running workloads. The state keeps its
 * name and loses the live tone, and says plainly that it is the last one seen.
 *
 * In one place, because it is needed wherever a container appears and two
 * copies of a rule like this drift apart.
 */
export function containerStateBadge(
  value: ContainerState,
  stale: boolean,
): { tone: StatusTone; label: string } {
  const current = CONTAINER_STATE[value];

  return stale ? { tone: 'neutral', label: `Last known: ${current.label}` } : current;
}

/**
 * How a host is named where a reader has to tell it from another.
 *
 * A machine enrolled more than once leaves a host resource behind for every
 * enrolment, and they all report the same system hostname. So the name an
 * operator gave the resource leads, and the hostname follows only when it says
 * something the name does not — on a host with no name of its own, the hostname
 * is the name and repeating it beneath itself would be noise.
 *
 * In one place, because this is needed wherever a host is named next to
 * something else and separate copies of the rule drift apart.
 */
export function hostIdentity(
  hostName: string,
  hostname: string,
): { primary: string; secondary?: string } {
  return hostName === hostname
    ? { primary: hostname }
    : { primary: hostName, secondary: `System hostname: ${hostname}` };
}

/** Ordering used wherever problems are listed most-urgent first. */
export const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** A host that is not reporting cannot supply current metrics. */
export function isReporting(status: HostStatus): boolean {
  return status !== 'offline' && status !== 'unknown';
}
