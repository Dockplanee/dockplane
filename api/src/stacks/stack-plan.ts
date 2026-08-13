import { AppError } from '../common/errors';
import { StackDeploymentPlan } from './compose-compiler.service';

/**
 * Turning a compiled Compose file into what an agent is asked to deploy.
 *
 * Two things happen here and nothing else does.
 *
 * Names are resolved. A Compose file talks about a network called `default` and
 * a volume called `data`; Docker knows them as `shop_default` and `shop_data`.
 * The compiler works out both, and this is where a service's mounts and
 * networks stop referring to the logical name and start referring to the one
 * Docker will look up. An agent that had to do this would need to understand
 * Compose's naming rules, which is the thing that is deliberately kept on this
 * side.
 *
 * Identity is attached. Each service is given the Dockplane container resource
 * it is, allocated by the control server before anything is dispatched. The
 * agent stamps it onto the container, and it is how the container is recognised
 * afterwards as this service of this stack.
 *
 * The result carries resolved environment values, secrets included. It exists
 * for the length of one dispatch: it is never stored, never logged and never
 * put into an action or an audit entry.
 */
export interface AgentStackPlan {
  readonly planVersion: number;
  readonly stackId: string;
  readonly revisionId: string;
  readonly projectName: string;
  readonly networks: readonly { name: string; dockerName: string; driver?: string }[];
  readonly volumes: readonly { name: string; dockerName: string; driver?: string }[];
  readonly services: readonly AgentStackService[];
}

interface AgentStackService {
  readonly serviceName: string;
  readonly containerId: string;
  readonly containerName: string;
  readonly dependsOn?: readonly string[];
  readonly spec: Record<string, unknown>;
}

/** The plan shape this build and the agent agree on. */
export const STACK_PLAN_VERSION = 1;

/** The name a service's container will be given on the host. */
export function containerNames(plan: StackDeploymentPlan): Map<string, string> {
  return new Map(
    plan.services.map((service) => {
      if (!service.containerName) {
        /*
         * The compiler resolves every service's container name, including the
         * default one. A plan without it comes from a build that did not, and
         * deriving a name here would put Compose's naming rules in a second
         * place — where they could disagree with the first.
         */
        throw new AppError(
          'STACK_CONFIGURATION_INVALID',
          'This build cannot deploy the compiled plan: a service has no container name.',
          500,
        );
      }

      return [service.serviceName, service.containerName];
    }),
  );
}

/**
 * Builds the plan the agent receives.
 *
 * `containers` maps each service name to the container resource allocated for
 * it. A service without one is a programming error rather than a bad request,
 * because the caller allocated them.
 */
export function agentPlanFor(input: {
  readonly stackId: string;
  readonly revisionId: string;
  readonly plan: StackDeploymentPlan;
  readonly containers: ReadonlyMap<string, string>;
}): AgentStackPlan {
  const { plan } = input;

  const networkNames = new Map(
    plan.networks.map((network) => [network.name, network.dockerName ?? network.name]),
  );

  const volumeNames = new Map(
    plan.volumes.map((volume) => [volume.name, volume.dockerName ?? volume.name]),
  );

  const names = containerNames(plan);

  return {
    planVersion: STACK_PLAN_VERSION,
    stackId: input.stackId,
    revisionId: input.revisionId,
    projectName: plan.projectName,
    networks: plan.networks.map((network) => ({
      name: network.name,
      dockerName: networkNames.get(network.name)!,
      ...(network.driver ? { driver: network.driver } : {}),
    })),
    volumes: plan.volumes.map((volume) => ({
      name: volume.name,
      dockerName: volumeNames.get(volume.name)!,
      ...(volume.driver ? { driver: volume.driver } : {}),
    })),
    services: plan.services.map((service) => {
      const containerId = input.containers.get(service.serviceName);

      if (!containerId) {
        throw new AppError(
          'STACK_DEPLOYMENT_FAILED',
          'This deployment could not be prepared.',
          500,
        );
      }

      const containerName = names.get(service.serviceName)!;

      return {
        serviceName: service.serviceName,
        containerId,
        containerName,
        ...(service.dependsOn?.length ? { dependsOn: service.dependsOn } : {}),
        spec: {
          name: containerName,
          image: service.image,
          ...(service.hostname ? { hostname: service.hostname } : {}),
          ...(service.command?.length ? { command: service.command } : {}),
          ...(service.entrypoint?.length ? { entrypoint: service.entrypoint } : {}),
          env: service.environment ?? [],
          ports: service.ports ?? [],
          /*
           * A named volume's source becomes the name Docker knows. A bind's
           * source is a path on the host and is left exactly as written: it is
           * not Compose's to rename, and the agent refuses the dangerous ones.
           */
          mounts: (service.mounts ?? []).map((mount) => ({
            ...mount,
            source:
              mount.type === 'volume'
                ? (volumeNames.get(mount.source) ?? mount.source)
                : mount.source,
          })),
          networks: (service.networks ?? []).map((network) => networkNames.get(network) ?? network),
          restartPolicy: service.restartPolicy,
          ...(service.labels ? { labels: service.labels } : {}),
          ...(service.healthcheck ? { healthcheck: healthcheckFor(service.healthcheck) } : {}),
        },
      };
    }),
  };
}

/**
 * A health check as the agent's specification expresses one.
 *
 * Compose can disable an image's own check, and Docker's way of saying that is
 * a test of `NONE`. The agent has no separate field for it, so the intent is
 * carried the way Docker itself carries it rather than being dropped — a
 * container that quietly kept the image's health check would report a state its
 * author had turned off.
 */
function healthcheckFor(
  healthcheck: NonNullable<StackDeploymentPlan['services'][number]['healthcheck']>,
) {
  if (healthcheck.disabled) {
    return { test: ['NONE'] };
  }

  return {
    test: healthcheck.test,
    ...(healthcheck.intervalMs ? { intervalMs: healthcheck.intervalMs } : {}),
    ...(healthcheck.timeoutMs ? { timeoutMs: healthcheck.timeoutMs } : {}),
    ...(healthcheck.startPeriodMs ? { startPeriodMs: healthcheck.startPeriodMs } : {}),
    ...(healthcheck.retries ? { retries: healthcheck.retries } : {}),
  };
}
