import { StatusTone } from '../ui/status-badge/status-badge';

/**
 * Content for the interface previews on the public pages.
 *
 * These values describe a design mockup of the Dockplane application, kept in
 * one place so every section shows a consistent environment. They are not
 * telemetry and are not derived from any deployment.
 */

export interface PreviewHost {
  readonly name: string;
  readonly tone: StatusTone;
  readonly status: string;
  readonly containers: number;
  readonly dockerVersion: string;
  readonly agentState: string;
}

export interface PreviewWorkload {
  readonly name: string;
  readonly tone: StatusTone;
  readonly status: string;
  readonly image: string;
}

export interface PreviewMetric {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}

export interface PreviewEvent {
  readonly time: string;
  readonly summary: string;
  readonly target: string;
  readonly tone: StatusTone;
}

export const PREVIEW_HOSTS: readonly PreviewHost[] = [
  {
    name: 'docker-01',
    tone: 'ok',
    status: 'Healthy',
    containers: 12,
    dockerVersion: '27.3.1',
    agentState: 'Connected',
  },
  {
    name: 'docker-02',
    tone: 'ok',
    status: 'Healthy',
    containers: 8,
    dockerVersion: '27.3.1',
    agentState: 'Connected',
  },
  {
    name: 'storage-01',
    tone: 'warn',
    status: 'Warning',
    containers: 6,
    dockerVersion: '26.1.4',
    agentState: 'Connected',
  },
  {
    name: 'apps-01',
    tone: 'ok',
    status: 'Healthy',
    containers: 12,
    dockerVersion: '27.3.1',
    agentState: 'Connected',
  },
];

export const PREVIEW_SUMMARY: readonly PreviewMetric[] = [
  { label: 'Hosts', value: '4', detail: 'connected' },
  { label: 'Containers', value: '38', detail: 'across all hosts' },
  { label: 'Compose projects', value: '7', detail: 'discovered' },
  { label: 'Needs attention', value: '1', detail: 'workload' },
];

export const PREVIEW_ATTENTION = {
  workload: 'paperless-db',
  reason: 'Health check failing',
  host: 'docker-02',
} as const;

export const PREVIEW_COMPOSE = {
  project: 'Nextcloud',
  host: 'apps-01',
  summary: '3 / 3 healthy',
  services: [
    { name: 'nextcloud', tone: 'ok', status: 'Running', image: 'nextcloud:30-apache' },
    { name: 'postgres', tone: 'ok', status: 'Running', image: 'postgres:16-alpine' },
    { name: 'redis', tone: 'ok', status: 'Running', image: 'redis:7-alpine' },
  ] as readonly PreviewWorkload[],
} as const;

/**
 * What Dockplane reports about a single container.
 *
 * Deliberately not CPU, memory and network: metrics are collected for a host,
 * not for a workload, and a preview showing per-container usage would be an
 * interface for something the product does not have.
 */
export const PREVIEW_CONTAINER_FACTS: readonly PreviewMetric[] = [
  { label: 'State', value: 'Running', detail: 'up 6 days' },
  { label: 'Health', value: 'Unhealthy', detail: 'check failing since 10:43' },
  { label: 'Restarts', value: '3', detail: 'since it was created' },
];

export const PREVIEW_LOG_LINES: readonly string[] = [
  '10:42:18  nextcloud      Server started, listening on port 80',
  '10:42:19  nextcloud      Cron job finished in 0.42s',
  '10:43:02  paperless-db   Health check failed (exit code 1)',
  '10:43:12  paperless-db   Health check failed (exit code 1)',
  '10:43:22  paperless-db   Container marked unhealthy',
];

export const PREVIEW_EVENTS: readonly PreviewEvent[] = [
  { time: '10:43:22', summary: 'Workload marked unhealthy', target: 'paperless-db', tone: 'warn' },
  { time: '10:31:05', summary: 'Container restarted', target: 'nextcloud', tone: 'info' },
  { time: '09:58:41', summary: 'Host reconnected', target: 'storage-01', tone: 'ok' },
];

/**
 * A few of the capabilities the agent defines, shown as examples.
 *
 * Chosen to span the surface rather than one corner of it: something read,
 * something that runs a container, something that builds one, and something
 * that deploys a stack. The full catalogue is in the security documentation,
 * which is the one place it is maintained.
 */
export const PREVIEW_CAPABILITIES: readonly string[] = [
  'host.metrics',
  'container.inspect',
  'container.logs',
  'container.restart',
  'container.replace',
  'stack.deploy',
];
