import { ComposeProject, Container, Host } from '../app/domain/inventory';

/**
 * Records shaped the way the mapping layer produces them.
 *
 * Tests build what the control server would have returned, so a view is never
 * exercised against a shape the API cannot actually deliver.
 */
export function host(overrides: Partial<Host> = {}): Host {
  return {
    id: 'host-1',
    name: 'docker-01',
    hostname: 'docker-01',
    status: 'healthy',
    os: 'Debian GNU/Linux 13',
    architecture: 'x86_64',
    kernel: '6.12.0',
    dockerVersion: '29.0.0',
    agentId: 'agent-1',
    agentStatus: 'connected',
    agentVersion: '1.0.0',
    containersRunning: 0,
    containersTotal: 0,
    cpu: { percent: 12 },
    memory: { percent: 40, detail: '6.4 / 16.0 GiB' },
    disk: { percent: 55, detail: '110.0 / 200.0 GiB' },
    uptimeSeconds: 86_400,
    lastSeen: '2026-08-09T12:00:00.000Z',
    observedAt: '2026-08-09T12:00:00.000Z',
    stale: false,
    archived: false,
    ...overrides,
  };
}

export function container(overrides: Partial<Container> = {}): Container {
  return {
    id: 'container-1',
    name: 'shop-web-1',
    hostId: 'host-1',
    hostName: 'docker-01',
    hostname: 'docker-01',
    dockerId: 'aaa111bbb222',
    image: 'nginx:1.27',
    imageId: 'sha256:cafebabe',
    state: 'running',
    health: 'healthy',
    restarts: 0,
    management: { kind: 'managed', reconciling: false, identityConflict: false },
    createdAt: '2026-08-09T10:00:00.000Z',
    observedAt: '2026-08-09T12:00:00.000Z',
    stale: false,
    ...overrides,
  };
}

export function project(overrides: Partial<ComposeProject> = {}): ComposeProject {
  return {
    id: 'project-1',
    name: 'shop',
    hostId: 'host-1',
    hostname: 'docker-01',
    state: 'running',
    servicesTotal: 2,
    servicesRunning: 2,
    services: [
      { name: 'web', containerIds: ['aaa111bbb222'], running: 1, total: 1, state: 'running' },
      { name: 'db', containerIds: ['ccc333ddd444'], running: 1, total: 1, state: 'running' },
    ],
    containers: [],
    observedAt: '2026-08-09T12:00:00.000Z',
    stale: false,
    ...overrides,
  };
}
