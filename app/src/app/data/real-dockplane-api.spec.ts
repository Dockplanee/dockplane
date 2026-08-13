import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { DockplaneApi } from './dockplane-api';
import { RealDockplaneApi } from './real-dockplane-api';

/**
 * The mapping between what the control server sends and what views consume.
 *
 * The point of the layer is that a response shape never reaches a template, so
 * these tests assert the projection rather than the request: what a null
 * becomes, what an unrecognised value becomes, and what is dropped.
 */
describe('RealDockplaneApi', () => {
  let http: HttpTestingController;
  let api: DockplaneApi;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: DockplaneApi, useClass: RealDockplaneApi },
      ],
    });

    http = TestBed.inject(HttpTestingController);
    api = TestBed.inject(DockplaneApi);
  });

  afterEach(() => http.verify());

  describe('hosts', () => {
    const hostResponse = (overrides: Record<string, unknown> = {}) => ({
      id: 'host-1',
      hostname: 'docker-01',
      displayName: null,
      os: 'Debian GNU/Linux 13',
      architecture: 'x86_64',
      kernel: '6.12.0',
      dockerVersion: '29.0.0',
      agentVersion: '1.0.0',
      metadata: { cpuCount: 8, memoryTotalBytes: 16 * 1024 ** 3, uptimeSeconds: 3600 },
      metrics: {
        cpuPercent: 12.5,
        memoryUsedBytes: 4 * 1024 ** 3,
        memoryTotalBytes: 16 * 1024 ** 3,
      },
      lastSeenAt: '2026-08-09T12:00:00.000Z',
      agent: {
        id: 'agent-1',
        status: 'connected',
        connected: true,
        lastSeenAt: '2026-08-09T12:00:00.000Z',
        certificateNotAfter: '2026-09-08T12:00:00.000Z',
      },
      observedAt: '2026-08-09T12:00:00.000Z',
      stale: false,
      ...overrides,
    });

    const load = (response: Record<string, unknown>) => {
      const hosts = api.hosts().toPromise();

      http.expectOne((request) => request.url === '/api/v1/hosts').flush({ hosts: [response] });

      return hosts;
    };

    it('maps a reporting host', async () => {
      const [host] = (await load(hostResponse()))!;

      expect(host.name).toBe('docker-01');
      expect(host.status).toBe('healthy');
      expect(host.dockerVersion).toBe('29.0.0');
      expect(host.agentStatus).toBe('connected');
      expect(host.cpu?.percent).toBeCloseTo(12.5);
      expect(host.memory?.detail).toBe('4.0 / 16.0 GiB');
      expect(host.stale).toBe(false);
    });

    it('prefers a display name when one is set', async () => {
      const [host] = (await load(hostResponse({ displayName: 'Production EU' })))!;

      expect(host.name).toBe('Production EU');
    });

    /**
     * An agent that is not connected makes the host offline, whatever it last
     * reported: nothing is refreshing it, so its state can only be history.
     */
    it('reports a host as offline when its agent is not connected', async () => {
      const [host] = (await load(
        hostResponse({
          agent: {
            id: 'agent-1',
            status: 'disconnected',
            connected: false,
            lastSeenAt: null,
            certificateNotAfter: '2026-09-08T12:00:00.000Z',
          },
          stale: true,
        }),
      ))!;

      expect(host.status).toBe('offline');
      expect(host.stale).toBe(true);
    });

    it('reports a connected host with an old observation as unknown, not healthy', async () => {
      const [host] = (await load(hostResponse({ stale: true })))!;

      expect(host.status).toBe('unknown');
    });

    it('leaves a missing field absent rather than filling it in', async () => {
      const [host] = (await load(
        hostResponse({
          os: null,
          architecture: null,
          kernel: null,
          dockerVersion: null,
          agentVersion: null,
          metrics: null,
          metadata: null,
          lastSeenAt: null,
          observedAt: null,
          agent: null,
        }),
      ))!;

      expect(host.os).toBeUndefined();
      expect(host.dockerVersion).toBeUndefined();
      expect(host.cpu).toBeUndefined();
      expect(host.memory).toBeUndefined();
      expect(host.disk).toBeUndefined();
      expect(host.lastSeen).toBeUndefined();
      // No agent at all is not a connected one.
      expect(host.status).toBe('offline');
    });

    it('does not turn a partial metric into a reading', async () => {
      const [host] = (await load(hostResponse({ metrics: { memoryUsedBytes: 100 } })))!;

      expect(host.memory).toBeUndefined();
      expect(host.cpu).toBeUndefined();
    });
  });

  describe('containers', () => {
    const containerResponse = (overrides: Record<string, unknown> = {}) => ({
      id: 'container-1',
      hostId: 'host-1',
      hostname: 'docker-01',
      dockerId: 'aaa111bbb222',
      name: 'shop-web-1',
      image: 'nginx:1.27',
      imageId: 'sha256:cafebabe',
      state: 'running',
      health: 'healthy',
      restartCount: 2,
      createdAt: '2026-08-09T10:00:00.000Z',
      composeProject: { id: 'project-1', name: 'shop' },
      metadata: { service: 'web' },
      observedAt: '2026-08-09T12:00:00.000Z',
      stale: false,
      ...overrides,
    });

    const load = (response: Record<string, unknown>) => {
      const containers = api.containers().toPromise();

      http
        .expectOne((request) => request.url === '/api/v1/containers')
        .flush({ containers: [response] });

      return containers;
    };

    it('maps a running container', async () => {
      const [item] = (await load(containerResponse()))!;

      expect(item.name).toBe('shop-web-1');
      expect(item.hostname).toBe('docker-01');
      expect(item.state).toBe('running');
      expect(item.health).toBe('healthy');
      expect(item.restarts).toBe(2);
      expect(item.composeProjectName).toBe('shop');
      expect(item.composeService).toBe('web');
    });

    /**
     * Docker's vocabulary is larger than the interface's. An unrecognised state
     * becomes a known one rather than being rendered raw, which would show a
     * status the design has no tone for.
     */
    it('maps Docker states the interface does not model', async () => {
      for (const [reported, expected] of [
        ['exited', 'stopped'],
        ['created', 'stopped'],
        ['paused', 'stopped'],
        ['dead', 'failed'],
        ['something-new', 'stopped'],
      ] as const) {
        const [item] = (await load(containerResponse({ state: reported })))!;

        expect(item.state).toBe(expected);
      }
    });

    it('maps an unrecognised health value to none', async () => {
      const [item] = (await load(containerResponse({ health: 'weird' })))!;

      expect(item.health).toBe('none');
    });

    it('leaves an absent project and image id undefined', async () => {
      const [item] = (await load(
        containerResponse({ composeProject: null, imageId: null, metadata: null, createdAt: null }),
      ))!;

      expect(item.composeProjectId).toBeUndefined();
      expect(item.composeService).toBeUndefined();
      expect(item.imageId).toBeUndefined();
      expect(item.createdAt).toBeUndefined();
    });
  });

  describe('container detail', () => {
    it('maps the inspect projection', async () => {
      const detail = api.containerDetail('container-1').toPromise();

      http.expectOne('/api/v1/containers/container-1').flush({
        container: {
          id: 'container-1',
          hostId: 'host-1',
          hostname: 'docker-01',
          dockerId: 'aaa111bbb222',
          name: 'shop-web-1',
          image: 'nginx:1.27',
          imageId: 'sha256:cafebabe',
          state: 'running',
          health: 'healthy',
          restartCount: 2,
          createdAt: '2026-08-09T10:00:00.000Z',
          composeProject: null,
          metadata: null,
          observedAt: '2026-08-09T12:00:00.000Z',
          stale: false,
          detailObservedAt: '2026-08-09T12:05:00.000Z',
          detail: {
            dockerId: 'aaa111bbb222',
            name: 'shop-web-1',
            image: 'nginx:1.27',
            state: 'running',
            status: 'running',
            health: 'healthy',
            restartCount: 2,
            restartPolicy: 'unless-stopped',
            startedAt: '2026-08-09T10:01:00.000Z',
            ports: [{ containerPort: 80, protocol: 'tcp', hostPort: '8080', hostIp: '127.0.0.1' }],
            networks: ['shop_default'],
            mounts: [
              { type: 'volume', name: 'shop_data', readOnly: false },
              { type: 'bind', readOnly: true },
            ],
            limits: { memoryBytes: 536870912, pidsLimit: 100 },
            labels: { 'com.docker.compose.project': 'shop' },
          },
        },
      });

      const result = (await detail)!;

      expect(result.restartPolicy).toBe('unless-stopped');
      expect(result.ports[0].hostPort).toBe('8080');
      expect(result.networks).toEqual(['shop_default']);
      expect(result.limits?.pidsLimit).toBe(100);
      expect(result.observedAt).toBe('2026-08-09T12:05:00.000Z');

      // A bind mount is reported as present, without the host path behind it.
      const bind = result.mounts.find((mount) => mount.type === 'bind');
      expect(bind).toBeDefined();
      expect(bind?.name).toBeUndefined();
    });

    it('falls back to the summary when no detail has been read', async () => {
      const detail = api.containerDetail('container-1').toPromise();

      http.expectOne('/api/v1/containers/container-1').flush({
        container: {
          id: 'container-1',
          hostId: 'host-1',
          hostname: 'docker-01',
          dockerId: 'aaa111bbb222',
          name: 'shop-web-1',
          image: 'nginx:1.27',
          imageId: null,
          state: 'exited',
          health: 'none',
          restartCount: 0,
          createdAt: null,
          composeProject: null,
          metadata: null,
          observedAt: '2026-08-09T12:00:00.000Z',
          stale: true,
          detail: null,
          detailObservedAt: null,
        },
      });

      const result = (await detail)!;

      expect(result.state).toBe('stopped');
      expect(result.ports).toEqual([]);
      expect(result.networks).toEqual([]);
      expect(result.stale).toBe(true);
    });
  });

  describe('compose projects', () => {
    it('maps a project and its services', async () => {
      const projects = api.composeProjects().toPromise();

      http
        .expectOne((request) => request.url === '/api/v1/compose-projects')
        .flush({
          projects: [
            {
              id: 'project-1',
              hostId: 'host-1',
              hostname: 'docker-01',
              projectName: 'shop',
              status: 'degraded',
              serviceCount: 2,
              runningCount: 1,
              services: [
                { name: 'web', containerIds: ['aaa'], running: 1, total: 1, state: 'running' },
                { name: 'db', containerIds: ['bbb'], running: 0, total: 1, state: 'stopped' },
              ],
              observedAt: '2026-08-09T12:00:00.000Z',
              stale: false,
            },
          ],
        });

      const [project] = (await projects)!;

      expect(project.name).toBe('shop');
      expect(project.state).toBe('degraded');
      expect(project.servicesRunning).toBe(1);
      expect(project.services).toHaveLength(2);
      expect(project.services[1].state).toBe('stopped');
    });

    it('maps an unrecognised project status to unknown', async () => {
      const projects = api.composeProjects().toPromise();

      http
        .expectOne((request) => request.url === '/api/v1/compose-projects')
        .flush({
          projects: [
            {
              id: 'project-1',
              hostId: 'host-1',
              hostname: 'docker-01',
              projectName: 'shop',
              status: 'something-else',
              serviceCount: 0,
              runningCount: 0,
              services: [],
              observedAt: null,
              stale: true,
            },
          ],
        });

      const [project] = (await projects)!;

      expect(project.state).toBe('unknown');
      expect(project.observedAt).toBeUndefined();
    });
  });

  describe('stack services', () => {
    /*
     * The states a stack's services report come from Docker, and a stopped
     * container reports `exited`. Left unmapped it reached a view that knows
     * five states and treats anything else as a failure — so a stack somebody
     * had just stopped on purpose was shown as broken.
     */
    it('maps Docker states the interface does not model', async () => {
      const services = api.stackServices('stack-1').toPromise();

      http.expectOne((request) => request.url === '/api/v1/stacks/stack-1/services').flush({
        services: [
          { serviceName: 'web', state: 'exited' },
          { serviceName: 'db', state: 'running' },
          { serviceName: 'cache', state: 'dead' },
        ],
      });

      const mapped = (await services)!;

      expect(mapped.map((service) => service.state)).toEqual(['stopped', 'running', 'failed']);
    });
  });
});
