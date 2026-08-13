/**
 * Capability catalog.
 *
 * A capability is a named, validated operation, never a command. The list is
 * exhaustive: six observations, six named container operations, one stack
 * deployment and one log stream. There is deliberately no capability that takes
 * an operation name or an argument list, because that is a remote shell with
 * extra steps — and none that carries input, which is what keeps a log stream
 * from becoming a console.
 *
 * The three that build a container carry a typed specification rather than a
 * Docker API payload. What can be asked for is the shape of that type, so an
 * option Docker has and Dockplane has not modelled cannot be requested at all.
 *
 * `stack.deploy` carries several of those specifications and the networks and
 * volumes they need. It does not carry a Compose file: Compose is read on this
 * side, by a program built for it, and an agent has no parser for one.
 *
 * The catalog is shared by the dispatcher and the agent. Both sides check it,
 * so a capability the server never dispatches is also one the agent refuses to
 * run.
 */

export const CAPABILITIES = [
  'host.inventory',
  'host.metrics',
  'container.list',
  'container.inspect',
  'compose.list',
  'compose.inspect',
  'container.start',
  'container.stop',
  'container.restart',
  'container.logs',
  'container.create',
  'container.replace',
  'container.remove',
  'stack.deploy',
  'stack.start',
  'stack.stop',
  'stack.restart',
  'stack.remove',
] as const;

/**
 * The capability that answers over time rather than once.
 *
 * A stream is dispatched, acknowledged, delivered in chunks and ended. It is
 * read-only: it carries a container's output outwards and has no field an
 * input could travel in.
 */
export const STREAMING_CAPABILITIES = ['container.logs'] as const;

export type StreamingCapability = (typeof STREAMING_CAPABILITIES)[number];

const STREAMING = new Set<string>(STREAMING_CAPABILITIES);

export function isStreaming(capability: string): capability is StreamingCapability {
  return STREAMING.has(capability);
}

/**
 * The capabilities that change a host.
 *
 * Named separately because they are treated differently everywhere: they need a
 * permission, an action record, a confirmation and a shorter expiry, and they
 * are the only ones a replayed request could do damage with.
 */
export const MUTATING_CAPABILITIES = [
  'container.start',
  'container.stop',
  'container.restart',
  'container.create',
  'container.replace',
  'container.remove',
  'stack.deploy',
  'stack.start',
  'stack.stop',
  'stack.restart',
  'stack.remove',
] as const;

export type MutatingCapability = (typeof MUTATING_CAPABILITIES)[number];

const MUTATING = new Set<string>(MUTATING_CAPABILITIES);

export function isMutating(capability: string): capability is MutatingCapability {
  return MUTATING.has(capability);
}

export type Capability = (typeof CAPABILITIES)[number];

const CAPABILITY_SET = new Set<string>(CAPABILITIES);

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && CAPABILITY_SET.has(value);
}

/**
 * How long a capability may take before the request is abandoned.
 *
 * Per capability rather than global, because inspecting one container is not
 * comparable to walking a host's entire Compose estate.
 */
export const CAPABILITY_TIMEOUT_MS: Record<Capability, number> = {
  'host.inventory': 10_000,
  'host.metrics': 10_000,
  'container.list': 20_000,
  'container.inspect': 15_000,
  'compose.list': 20_000,
  'compose.inspect': 20_000,
  /*
   * Lifecycle operations wait longer than a read, because Docker itself waits
   * for a container to exit before killing it, but they stay bounded: an
   * operation nobody is waiting for any more must not hold a request open.
   */
  'container.start': 60_000,
  'container.stop': 60_000,
  'container.restart': 90_000,
  /*
   * Building a container may have to fetch an image first, which is somebody
   * else's network. Replacing one does that and then waits for the result to
   * come up, so it is given the longest of the three.
   */
  'container.create': 300_000,
  'container.replace': 420_000,
  'container.remove': 90_000,
  /*
   * A stack deploys several containers and pulls an image for each of them,
   * which is somebody else's network several times over. Long, and still
   * bounded: a deployment nobody is waiting for any more must not hold a
   * request open. The agent's own ceiling for this capability is the same.
   */
  'stack.deploy': 900_000,
  /*
   * Moving a deployed stack between running and stopped pulls nothing and
   * builds nothing, so it is bounded by what Docker waits for: the engine's own
   * stop timeout, once per service, plus the time containers take to come up.
   */
  'stack.start': 300_000,
  'stack.stop': 300_000,
  'stack.restart': 600_000,
  /*
   * Removing a stack stops each of its services before taking it away, so it
   * waits what a stop waits and then some. Bounded like everything else.
   */
  'stack.remove': 600_000,
  /*
   * A stream's timeout covers being accepted, not being finished. A follow
   * stream runs until something ends it, and how long that may be is a stream
   * lifetime rather than a request timeout.
   */
  'container.logs': 15_000,
};

/**
 * Error codes an agent may report.
 *
 * An agent names a failure from this list and nothing else. Passing its string
 * straight through would let a host inject codes into the API's stable error
 * contract, so an unrecognised one collapses to a generic failure.
 */
const AGENT_ERROR_CODES = new Set<string>([
  'DOCKER_UNAVAILABLE',
  'DOCKER_PERMISSION_DENIED',
  'DOCKER_OPERATION_FAILED',
  'AGENT_REQUEST_EXPIRED',
  'AGENT_CAPABILITY_UNSUPPORTED',
  'CONTAINER_NOT_FOUND',
  'CONTAINER_ALREADY_RUNNING',
  'CONTAINER_ALREADY_STOPPED',
  'CONTAINER_NAME_IN_USE',
  'IMAGE_NOT_FOUND',
  'INVALID_CONTAINER_SPEC',
  'REPLACEMENT_FAILED',
  'STACK_RESOURCE_CONFLICT',
  'STACK_STATE_AMBIGUOUS',
  'STACK_SERVICE_MISSING',
  'STACK_LIFECYCLE_INCOMPLETE',
  'STACK_REMOVE_INCOMPLETE',
  'VOLUME_MISSING',
  'COMPOSE_PROJECT_NOT_FOUND',
  'VALIDATION_FAILED',
  'AGENT_CAPABILITY_FAILED',
]);

export function agentErrorCode(value: unknown): string {
  return typeof value === 'string' && AGENT_ERROR_CODES.has(value)
    ? value
    : 'AGENT_CAPABILITY_FAILED';
}

/**
 * What an operator is told when a capability fails on a host.
 *
 * The sentence is the control server's, chosen from the code, and never the
 * string the agent sent. An agent's own text is written for a log file — it
 * arrives wrapped in the layers it passed through — and a host that had been
 * tampered with could otherwise put any sentence it liked in front of an
 * operator. The agent's text is kept in the control server's log instead,
 * where it is useful and not addressed to anyone.
 */
const AGENT_ERROR_MESSAGES: Record<string, string> = {
  DOCKER_UNAVAILABLE: 'The Docker Engine on this host could not be reached.',
  DOCKER_PERMISSION_DENIED: 'The agent is not permitted to use the Docker socket on this host.',
  DOCKER_OPERATION_FAILED: 'The Docker Engine refused the operation.',
  AGENT_REQUEST_EXPIRED: 'The host received the request too late to act on it.',
  AGENT_CAPABILITY_UNSUPPORTED: 'This host does not support that operation.',
  CONTAINER_NOT_FOUND: 'The container no longer exists on its host.',
  CONTAINER_ALREADY_RUNNING: 'The container is already running.',
  CONTAINER_ALREADY_STOPPED: 'The container is not running.',
  CONTAINER_NAME_IN_USE: 'A container of that name already exists on this host.',
  IMAGE_NOT_FOUND: 'The image could not be found or pulled on this host.',
  INVALID_CONTAINER_SPEC: 'The host rejected the container configuration as invalid.',
  REPLACEMENT_FAILED: 'The replacement did not start, so the original container was put back.',
  STACK_RESOURCE_CONFLICT:
    'A container, volume or network on this host has a name this stack needs and was not created by it.',
  STACK_STATE_AMBIGUOUS:
    'The containers of this stack on the host do not say clearly which revision it is running.',
  STACK_SERVICE_MISSING:
    'A service of this stack has no container on the host. Dockplane will not create one in its place.',
  STACK_LIFECYCLE_INCOMPLETE:
    'Part of this stack was moved and part of it was not. Nothing was undone.',
  STACK_REMOVE_INCOMPLETE:
    'Part of this stack was removed and part of it was not. Nothing was rebuilt.',
  VOLUME_MISSING:
    'A volume this stack was using is not on the host. Dockplane will not create an empty one in its place.',
  COMPOSE_PROJECT_NOT_FOUND: 'The Compose project no longer exists on its host.',
  VALIDATION_FAILED: 'The host rejected the request as invalid.',
  AGENT_CAPABILITY_FAILED: 'The operation failed on the host.',
};

export function agentErrorMessage(code: string): string {
  return AGENT_ERROR_MESSAGES[code] ?? AGENT_ERROR_MESSAGES.AGENT_CAPABILITY_FAILED;
}
