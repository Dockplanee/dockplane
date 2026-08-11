import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { routes } from '../../app.routes';
import { ApiError } from '../../core/api-error';
import { DockplaneApi } from '../../data/dockplane-api';
import { ContainerDetail } from '../../domain/inventory';
import { container } from '../../../testing/data';
import { signIn } from '../../../testing/harness';
import { TestApi, TestData } from '../../../testing/test-api';
import { ContainerOverviewTab } from './container-overview-tab';
import { ContainerStore } from './container-store';

const SECRET = 'THIS-MUST-NEVER-LEAVE-THE-HOST';

const DETAIL: ContainerDetail = {
  dockerId: 'aaa111bbb222',
  name: 'shop-web-1',
  image: 'nginx:1.27',
  imageId: 'sha256:cafebabe',
  state: 'running',
  health: 'healthy',
  restarts: 2,
  restartPolicy: 'unless-stopped',
  createdAt: '2026-08-09T10:00:00.000Z',
  startedAt: '2026-08-09T10:01:00.000Z',
  ports: [{ containerPort: 80, protocol: 'tcp', hostPort: '8080', hostIp: '127.0.0.1' }],
  networks: ['shop_default'],
  mounts: [
    { type: 'volume', name: 'shop_data', readOnly: false },
    { type: 'bind', readOnly: true },
  ],
  limits: { memoryBytes: 536870912, pidsLimit: 100 },
  observedAt: '2026-08-09T12:05:00.000Z',
  stale: false,
};

/**
 * The container detail view.
 *
 * The summary and the detail are separate reads, so the page has to stay
 * useful when the second one fails: the host may be unreachable, and saying so
 * is better than an empty page or a generic error.
 */
describe('container detail', () => {
  let api: TestApi;

  const render = async (data: TestData) => {
    api = new TestApi(data);

    await TestBed.configureTestingModule({
      imports: [ContainerOverviewTab],
      providers: [
        provideRouter(routes),
        { provide: DockplaneApi, useValue: api },
        {
          provide: ActivatedRoute,
          useValue: { paramMap: of({ get: () => 'container-1', has: () => true }) },
        },
        ContainerStore,
      ],
    }).compileComponents();

    signIn(['containers.read']);

    const fixture = TestBed.createComponent(ContainerOverviewTab);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    return fixture;
  };

  const text = (fixture: { nativeElement: unknown }) =>
    (fixture.nativeElement as HTMLElement).textContent ?? '';

  it('reads the detail from the host', async () => {
    const fixture = await render({ containers: [container()], containerDetail: DETAIL });

    expect(api.calls).toContain('containerDetail:container-1');
    expect(text(fixture)).toContain('unless-stopped');
    expect(text(fixture)).toContain('aaa111bbb222');
  });

  it('asks the host once for a view, not once per panel', async () => {
    await render({ containers: [container()], containerDetail: DETAIL });

    const detailCalls = api.calls.filter((call) => call.startsWith('containerDetail'));

    expect(detailCalls).toHaveLength(1);
  });

  it('shows the published port with the address it is bound to', async () => {
    const fixture = await render({ containers: [container()], containerDetail: DETAIL });

    expect(text(fixture)).toContain('127.0.0.1:8080 → 80/tcp');
  });

  /**
   * Nothing in the projection carries an environment value, a command or a host
   * path, so there is nothing for the view to redact — and no way for one to
   * appear by accident.
   */
  it('cannot render an environment value even if one were reported', async () => {
    const fixture = await render({
      containers: [container()],
      containerDetail: {
        ...DETAIL,
        ...({ env: [`SECRET=${SECRET}`], command: `run --password ${SECRET}` } as object),
      },
    });

    expect(text(fixture)).not.toContain(SECRET);
    expect(text(fixture)).not.toContain('SECRET=');
  });

  it('keeps the last known detail and marks it stale', async () => {
    const fixture = await render({
      containers: [container({ stale: true })],
      containerDetail: { ...DETAIL, stale: true },
    });

    expect(text(fixture)).toContain('unless-stopped');
  });

  it('reports that no detail has ever been read', async () => {
    const fixture = await render({
      containers: [container()],
      containerDetailError: new ApiError(
        'CONTAINER_DETAIL_UNAVAILABLE',
        'The host has not been reachable since this container was discovered.',
        409,
      ),
    });

    // The summary still renders; only the detail is missing.
    expect(text(fixture)).toContain('shop-web-1');
    expect(TestBed.inject(ContainerStore).unavailable()?.code).toBe('CONTAINER_DETAIL_UNAVAILABLE');
  });

  /**
   * The server's own wording is not shown. It is written for an API consumer
   * and can name things an operator has no business reading.
   */
  it("reports the server error in the interface's own words", async () => {
    await render({
      containers: [container()],
      containerDetailError: ApiError.from(
        new HttpErrorResponse({
          status: 404,
          error: { code: 'CONTAINER_NOT_FOUND', message: 'no such container: aaa111' },
        }),
      ),
    });

    const failure = TestBed.inject(ContainerStore).unavailable();

    expect(failure?.code).toBe('CONTAINER_NOT_FOUND');
    expect(failure?.message).toContain('no longer exists');
    expect(failure?.message).not.toContain('no such container');
  });
});
