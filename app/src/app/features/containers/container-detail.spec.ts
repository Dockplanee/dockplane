import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { routes } from '../../app.routes';
import { ApiError } from '../../core/api-error';
import { DockplaneApi } from '../../data/dockplane-api';
import { ContainerDetail } from '../../domain/inventory';
import { container } from '../../../testing/data';
import { renderView, signIn, textOf } from '../../../testing/harness';
import { TestApi, TestData } from '../../../testing/test-api';
import { ContainerDetail as ContainerDetailView } from './container-detail';
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

/**
 * The page itself, rather than one of its panels.
 *
 * The empty state lives here, and it used to be what an operator saw for a
 * container whose host had stopped reporting: the summary and the inspect came
 * from one request, the inspect refused, and the page concluded the container
 * was gone. Inventory is kept when a host goes away on purpose, so the page has
 * to show what is kept.
 */
describe('the container detail page', () => {
  const render = (data: TestData) =>
    renderView(ContainerDetailView, {
      params: { id: 'container-1' },
      data,
      permissions: ['containers.read'] as never,
    });

  it('shows a container whose host is no longer reporting', async () => {
    const fixture = await render({
      containers: [container({ stale: true, state: 'running' })],
      containerDetailError: new ApiError(
        'CONTAINER_DETAIL_UNAVAILABLE',
        'The host has not been reachable since this container was discovered.',
        409,
      ),
    });

    const shown = textOf(fixture);

    expect(shown).not.toContain('Container not found');
    expect(shown).toContain('shop-web-1');
    expect(shown).toContain('nginx:1.27');
  });

  /* What is on screen is the last observation, and says so. */
  it('marks what it shows as the last thing that was reported', async () => {
    const fixture = await render({
      containers: [container({ stale: true })],
      containerDetailError: new ApiError('CONTAINER_DETAIL_UNAVAILABLE', 'unreachable', 409),
    });

    expect(textOf(fixture)).toMatch(/last (report|observation)/i);
  });

  /*
   * And the other case is unchanged: a container the control server does not
   * have is a container that is not there, whatever the reason.
   */
  it('still says so when there is no such container', async () => {
    const fixture = await render({ containers: [] });

    expect(textOf(fixture)).toContain('Container not found');
  });
});

/**
 * What the page says a container is, and whose host it is on.
 *
 * Both are about telling one record from another. Six host resources can
 * report the same system hostname, and a container nobody has heard from in
 * two days should not wear the badge of one running now.
 */
describe('a container’s state and host on its page', () => {
  const render = (data: TestData) =>
    renderView(ContainerDetailView, {
      params: { id: 'container-1' },
      data,
      permissions: ['containers.read'] as never,
    });

  const badge = (fixture: { nativeElement: unknown }) =>
    (fixture.nativeElement as HTMLElement).querySelector('.identity dp-status-badge');

  it('names a stale state as the last one seen, without the live tone', async () => {
    const fixture = await render({
      containers: [container({ stale: true, state: 'running' })],
      containerDetailError: new ApiError('CONTAINER_DETAIL_UNAVAILABLE', 'unreachable', 409),
    });

    expect(badge(fixture)?.textContent).toContain('Last known: Running');
    expect(badge(fixture)?.className).not.toContain('tone-ok');
  });

  it('leaves a live state alone', async () => {
    const fixture = await render({
      containers: [container({ stale: false, state: 'running' })],
      containerDetail: DETAIL,
    });

    expect(badge(fixture)?.textContent).toContain('Running');
    expect(badge(fixture)?.textContent).not.toContain('Last known');
    expect(badge(fixture)?.className).toContain('tone-ok');
  });

  /* The host is named in the overview panel rather than in the page shell. */
  const overview = (data: TestData) =>
    renderView(ContainerOverviewTab, {
      params: { id: 'container-1' },
      data,
      permissions: ['containers.read'] as never,
      providers: [ContainerStore],
    });

  it('names the host the way the operator named it', async () => {
    const fixture = await overview({
      containers: [container({ hostName: 'rc4-smoke', hostname: 'aQuo3M359XhY' })],
      containerDetail: DETAIL,
    });

    const shown = textOf(fixture);

    expect(shown).toContain('rc4-smoke');
    expect(shown).toContain('System hostname: aQuo3M359XhY');
  });

  it('falls back to the system hostname when nobody named the host', async () => {
    const fixture = await overview({
      containers: [container({ hostName: 'aQuo3M359XhY', hostname: 'aQuo3M359XhY' })],
      containerDetail: DETAIL,
    });

    const shown = textOf(fixture);

    expect(shown).toContain('aQuo3M359XhY');
    expect(shown).not.toContain('System hostname:');
  });
});
