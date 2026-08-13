import { StackDeploymentPlan } from '../src/stacks/compose-compiler.service';
import { classifyStackDeployment } from '../src/stacks/stack-deployment';
import { agentPlanFor, containerNames } from '../src/stacks/stack-plan';

/**
 * What a deployment turned out to be, and what an agent is asked for.
 *
 * Both are pure functions, so every case here is a table rather than a
 * scenario somebody has to reproduce with a broken Docker daemon.
 */
describe('deciding what a deployment did', () => {
  const service = (
    serviceName: string,
    dockerId: string | null,
    state: string | null = 'running',
  ) => ({ serviceName, containerId: `resource-${serviceName}`, dockerId, state });

  it('is a success only when every service is running', () => {
    expect(
      classifyStackDeployment({
        services: [service('web', 'a'), service('database', 'b')],
        snapshotComplete: true,
      }),
    ).toEqual({ kind: 'succeeded' });
  });

  it('is a failure when the host has nothing of the stack on it', () => {
    const outcome = classifyStackDeployment({
      services: [service('web', null, null), service('database', null, null)],
      snapshotComplete: true,
    });

    expect(outcome.kind).toBe('failed');
  });

  /*
   * The case the whole design is for. Something exists, so the host is not as
   * it was, and nothing may be removed on the strength of a partial answer.
   */
  it('needs attention when part of it exists', () => {
    const outcome = classifyStackDeployment({
      services: [service('database', 'a'), service('web', null, null)],
      snapshotComplete: true,
    });

    expect(outcome.kind).toBe('needs_attention');
  });

  it('needs attention when a container was created and did not start', () => {
    const outcome = classifyStackDeployment({
      services: [service('database', 'a'), service('web', 'b', 'exited')],
      snapshotComplete: true,
    });

    expect(outcome.kind).toBe('needs_attention');
  });

  /*
   * A reading that stopped halfway cannot say a container is absent, and every
   * conclusion above turns on exactly that.
   */
  it('concludes nothing from a reading that did not finish', () => {
    for (const services of [
      [service('web', 'a'), service('database', 'b')],
      [service('web', null, null)],
    ]) {
      expect(classifyStackDeployment({ services, snapshotComplete: false }).kind).toBe('unknown');
    }
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

  it('carries the stack and the revision it is deploying', () => {
    expect(built()).toMatchObject({
      planVersion: 1,
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

  it('refuses a plan whose services have no container name', () => {
    const source = plan();

    source.services[0] = { ...source.services[0], containerName: undefined };

    expect(() => containerNames(source)).toThrow();
  });
});
