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

export const PREVIEW_CONTAINER_METRICS: readonly PreviewMetric[] = [
  { label: 'CPU', value: '4.2%', detail: 'of host capacity' },
  { label: 'Memory', value: '512 MiB', detail: 'of 2 GiB limit' },
  { label: 'Network', value: '1.4 MB/s', detail: 'in / out combined' },
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

export const PREVIEW_CAPABILITIES: readonly string[] = [
  'container.list',
  'container.inspect',
  'container.start',
  'container.stop',
  'container.restart',
  'container.logs',
];
