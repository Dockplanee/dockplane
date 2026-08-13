import { StackDeploymentPlan } from '../src/stacks/compose-compiler.service';
import { classifyStackApply } from '../src/stacks/stack-deployment';
import { STACK_PLAN_VERSION, agentPlanFor, containerNames } from '../src/stacks/stack-plan';

/**
 * What a deployment turned out to be, and what an agent is asked for.
 *
 * Both are pure functions, so every case here is a table rather than a
 * scenario somebody has to reproduce with a broken Docker daemon.
 */
describe('deciding what an attempt did', () => {
  const service = (
    serviceName: string,
    revisionId: string | null,
    state: string | null = 'running',
  ) => ({
    serviceName,
    containerId: `resource-${serviceName}`,
    dockerId: revisionId === null ? null : `docker-${serviceName}`,
    state: revisionId === null ? null : state,
    revisionId,
  });

  const classify = (input: Partial<Parameters<typeof classifyStackApply>[0]>) =>
    classifyStackApply({
      fromRevisionId: 'revision-a',
      targetRevisionId: 'revision-b',
      targetServices: ['web', 'database'],
      fromServices: ['web', 'database'],
      observed: [],
      snapshotComplete: true,
      ...input,
    });

  it('is the target when exactly the target is running', () => {
    expect(
      classify({ observed: [service('web', 'revision-b'), service('database', 'revision-b')] }),
    ).toEqual({ kind: 'finalize_target' });
  });

  /*
   * The revision the stack came from, whether because the attempt never started
   * or because the agent put the host back. Both mean the same thing: the stack
   * is what it was.
   */
  it('is the revision it came from when that is what is running', () => {
    expect(
      classify({ observed: [service('web', 'revision-a'), service('database', 'revision-a')] })
        .kind,
    ).toBe('finalize_from');
  });

  it('accepts a service the operator had stopped as part of where it came from', () => {
    expect(
      classify({
        observed: [service('web', 'revision-a'), service('database', 'revision-a', 'exited')],
      }).kind,
    ).toBe('finalize_from');
  });

  /* The target has to be running. That is the bar a deployment succeeds at. */
  it('is not the target when one of its services is not running', () => {
    expect(
      classify({
        observed: [service('web', 'revision-b'), service('database', 'revision-b', 'exited')],
      }).kind,
    ).toBe('needs_attention');
  });

  it('is nothing applied when there was nothing before and nothing now', () => {
    expect(classify({ fromRevisionId: null, fromServices: null, observed: [] }).kind).toBe(
      'finalize_not_applied',
    );
  });

  /*
   * The case the whole design is for: the host is neither one thing nor the
   * other, so nothing may be removed on the strength of a partial answer.
   */
  it('needs attention when the host holds some of each revision', () => {
    expect(
      classify({ observed: [service('web', 'revision-b'), service('database', 'revision-a')] })
        .kind,
    ).toBe('needs_attention');
  });

  it('needs attention when a service is missing entirely', () => {
    expect(classify({ observed: [service('web', 'revision-b')] }).kind).toBe('needs_attention');
  });

  it('needs attention when a running stack has vanished', () => {
    expect(classify({ observed: [] }).kind).toBe('needs_attention');
  });

  /*
   * Two containers claiming one service is what a crash between building the
   * target and removing what it replaced leaves behind. Which one is real was
   * never established.
   */
  it('needs attention when two containers are the same service', () => {
    expect(
      classify({
        observed: [
          service('web', 'revision-b'),
          { ...service('web', 'revision-a'), containerId: 'resource-web-old' },
          service('database', 'revision-b'),
        ],
      }).kind,
    ).toBe('needs_attention');
  });

  it('does not mistake a service added by the target for the old revision', () => {
    expect(
      classify({
        targetServices: ['web', 'database', 'worker'],
        observed: [
          service('web', 'revision-b'),
          service('database', 'revision-b'),
          service('worker', 'revision-b'),
        ],
      }).kind,
    ).toBe('finalize_target');
  });

  /*
   * A reading that stopped halfway cannot say a container is absent, and every
   * conclusion above turns on exactly that.
   */
  it('concludes nothing from a reading that did not finish', () => {
    expect(
      classify({
        observed: [service('web', 'revision-b'), service('database', 'revision-b')],
        snapshotComplete: false,
      }).kind,
    ).toBe('unknown');
  });
});

describe('the plan an agent is asked for', () => {
  const plan = (): StackDeploymentPlan => ({
    planVersion: 1,
    projectName: 'shop',
    services: [
      {
        serviceName: 'web',
        containerName: 'shop-web-1',
        image: 'nginx:1.27',
        restartPolicy: 'no',
        networks: ['default'],
        mounts: [
          { type: 'volume', source: 'data', target: '/var/lib/x' },
          { type: 'bind', source: '/srv/site', target: '/usr/share/nginx/html', readOnly: true },
        ],
        dependsOn: ['database'],
      },
      {
        serviceName: 'database',
        containerName: 'shop-database-1',
        image: 'postgres:17',
        restartPolicy: 'always',
        environment: [{ key: 'POSTGRES_PASSWORD', value: 'from-the-environment' }],
      },
    ],
    networks: [{ name: 'default', dockerName: 'shop_default', external: false }],
    volumes: [{ name: 'data', dockerName: 'shop_data', external: false }],
  });

  const built = () =>
    agentPlanFor({
      stackId: 'stack-1',
      revisionId: 'revision-1',
      plan: plan(),
      containers: new Map([
        ['web', 'resource-web'],
        ['database', 'resource-db'],
      ]),
    });

  /*
   * A Compose file says `data`; Docker knows `shop_data`. Resolved here so that
   * nothing downstream needs Compose's naming rules — and so a mount cannot end
   * up pointing at a volume of the logical name, which would be a different
   * volume entirely.
   */
  it('mounts the volume under the name Docker knows', () => {
    const web = built().services.find((service) => service.serviceName === 'web')!;
    const mounts = web.spec.mounts as { type: string; source: string }[];

    expect(mounts[0]).toMatchObject({ type: 'volume', source: 'shop_data' });
  });

  it('leaves a host path exactly as its author wrote it', () => {
    const web = built().services.find((service) => service.serviceName === 'web')!;
    const mounts = web.spec.mounts as { type: string; source: string }[];

    expect(mounts[1]).toMatchObject({ type: 'bind', source: '/srv/site' });
  });

  it('attaches the service to the network Docker will look up', () => {
    const web = built().services.find((service) => service.serviceName === 'web')!;

    expect(web.spec.networks).toEqual(['shop_default']);
  });

  it('gives each service the container resource allocated for it', () => {
    const services = built().services;

    expect(services.map((service) => service.containerId)).toEqual(['resource-web', 'resource-db']);
  });

  it('carries the stack and the revision it is applying', () => {
    expect(built()).toMatchObject({
      planVersion: STACK_PLAN_VERSION,
      stackId: 'stack-1',
      revisionId: 'revision-1',
      projectName: 'shop',
    });
  });

  it('keeps the order a service has to start in', () => {
    const web = built().services.find((service) => service.serviceName === 'web')!;

    expect(web.dependsOn).toEqual(['database']);
  });

  /*
   * Compose can turn an image's own health check off, and Docker's way of
   * saying that is a test of NONE. Dropping it would leave a container
   * reporting health its author disabled.
   */
  it('expresses a disabled health check the way Docker does', () => {
    const source = plan();

    source.services[0].healthcheck = { test: ['CMD', 'true'], disabled: true };

    const built = agentPlanFor({
      stackId: 'stack-1',
      revisionId: 'revision-1',
      plan: source,
      containers: new Map([
        ['web', 'resource-web'],
        ['database', 'resource-db'],
      ]),
    });

    expect(built.services[0].spec.healthcheck).toEqual({ test: ['NONE'] });
  });

  /*
   * Only the control server knows which volumes the stack was already using, so
   * only it can tell the agent which ones must already be there. A volume this
   * revision introduces is created; one that should exist and does not is a
   * volume that has gone.
   */
  it('marks the volumes the stack was already using', () => {
    const marked = agentPlanFor({
      stackId: 'stack-1',
      revisionId: 'revision-1',
      plan: plan(),
      containers: new Map([
        ['web', 'resource-web'],
        ['database', 'resource-db'],
      ]),
      existingVolumes: ['data'],
    });

    expect(marked.volumes[0]).toMatchObject({ name: 'data', mustExist: true });
    expect(built().volumes[0].mustExist).toBeUndefined();
  });

  it('refuses a plan whose services have no container name', () => {
    const source = plan();

    source.services[0] = { ...source.services[0], containerName: undefined };

    expect(() => containerNames(source)).toThrow();
  });
});
