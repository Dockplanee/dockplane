import {
  ContainerConfiguration,
  ContainerSpecRequest,
  EnvironmentChange,
  MountSpec,
  PortSpec,
} from '../../data/dockplane-api';

/**
 * What the form holds, and how it becomes a request.
 *
 * Deliberately not the API shape. The interface needs to keep things the API
 * has no field for — which row is being edited, whether a stored secret is
 * being left alone — and the API needs to receive things the form never holds,
 * a secret it was never shown among them. Keeping the two apart makes the
 * translation a place rather than a habit, and the translation is where the
 * secret rule lives.
 *
 * These are pure functions over plain data, so what a form sends can be checked
 * without a browser.
 */

/** Restart policies Dockplane actually supports. Not what Docker can do. */
export const RESTART_POLICIES = [
  { value: 'no', label: 'Never' },
  { value: 'unless-stopped', label: 'Unless stopped' },
  { value: 'always', label: 'Always' },
  { value: 'on-failure', label: 'On failure' },
] as const;

export type RestartPolicy = (typeof RESTART_POLICIES)[number]['value'];

/** The label namespace the agent sets from what the server resolved. */
export const RESERVED_LABEL_PREFIX = 'io.dockplane.';

/**
 * Host paths a bind mount may not name.
 *
 * The same list the control server and the agent refuse, repeated here so an
 * operator is told while they are typing rather than after a round trip. It is
 * not the boundary — the agent is, and it checks whether or not this did.
 */
const FORBIDDEN_BIND_SOURCES = [
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/var/lib/docker',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/etc/shadow',
  '/root/.ssh',
  '/var/lib/dockplane-agent',
];

export interface PortRow {
  hostIp: string;
  hostPort: string;
  containerPort: string;
  protocol: 'tcp' | 'udp';
}

export interface MountRow {
  type: 'volume' | 'bind';
  source: string;
  target: string;
  readOnly: boolean;
}

/**
 * One environment variable as the form holds it.
 *
 * `stored` marks a variable that already exists on the server. It matters for
 * exactly one reason: a stored secret has no value here and must never acquire
 * one. The interface was not shown it, so `action` says what is being done to
 * it and nothing is invented to fill the gap.
 */
export interface EnvironmentRow {
  key: string;
  value: string;
  secret: boolean;
  stored: boolean;
  action: 'unchanged' | 'change' | 'remove';
}

export interface LabelRow {
  key: string;
  value: string;
}

export interface ContainerFormModel {
  hostId: string;
  name: string;
  hostname: string;
  image: string;
  ports: PortRow[];
  mounts: MountRow[];
  environment: EnvironmentRow[];
  networks: string[];
  restartPolicy: RestartPolicy;
  command: string;
  entrypoint: string;
  labels: LabelRow[];
}

export function emptyForm(hostId = ''): ContainerFormModel {
  return {
    hostId,
    name: '',
    hostname: '',
    image: '',
    ports: [],
    mounts: [],
    environment: [],
    networks: [],
    restartPolicy: 'unless-stopped',
    command: '',
    entrypoint: '',
    labels: [],
  };
}

/** Fills the form from what the container is configured to be. */
export function formFrom(
  configuration: ContainerConfiguration,
  hostId: string,
): ContainerFormModel {
  return {
    hostId,
    name: configuration.name,
    hostname: configuration.hostname ?? '',
    image: configuration.image,
    ports: configuration.ports.map((port) => ({
      hostIp: port.hostIp ?? '',
      hostPort: port.hostPort ? String(port.hostPort) : '',
      containerPort: String(port.containerPort),
      protocol: port.protocol,
    })),
    mounts: configuration.mounts.map((mount) => ({
      type: mount.type,
      source: mount.source,
      target: mount.target,
      readOnly: mount.readOnly ?? false,
    })),
    environment: configuration.environment.map((variable) => ({
      key: variable.key,
      // A stored secret arrives with no value, and is given none here.
      value: variable.secret ? '' : (variable.value ?? ''),
      secret: variable.secret,
      stored: true,
      action: 'unchanged',
    })),
    networks: [...configuration.networks],
    restartPolicy: (RESTART_POLICIES.find((policy) => policy.value === configuration.restartPolicy)
      ?.value ?? 'no') as RestartPolicy,
    command: (configuration.command ?? []).join(' '),
    entrypoint: (configuration.entrypoint ?? []).join(' '),
    labels: Object.entries(configuration.labels ?? {}).map(([key, value]) => ({ key, value })),
  };
}

/**
 * Turns the form into a request.
 *
 * The environment is the part that matters. A stored secret nobody touched
 * becomes `unchanged` and carries no value at all — not a masked one, not an
 * empty one — because the interface does not have the secret and must not
 * imply that it does.
 */
export function requestFrom(
  form: ContainerFormModel,
  options: { includeHost: boolean },
): ContainerSpecRequest {
  return {
    ...(options.includeHost ? { hostId: form.hostId } : {}),
    name: form.name.trim(),
    image: form.image.trim(),
    ...(form.hostname.trim() ? { hostname: form.hostname.trim() } : {}),
    ...(form.command.trim() ? { command: words(form.command) } : {}),
    ...(form.entrypoint.trim() ? { entrypoint: words(form.entrypoint) } : {}),
    ports: form.ports.filter(hasPort).map(toPort),
    mounts: form.mounts.filter((mount) => mount.source.trim() && mount.target.trim()).map(toMount),
    environment: form.environment.filter((row) => row.key.trim()).map(toEnvironment),
    networks: form.networks.filter(Boolean),
    restartPolicy: form.restartPolicy,
    labels: Object.fromEntries(
      form.labels
        .filter((label) => label.key.trim())
        .map((label) => [label.key.trim(), label.value]),
    ),
  };
}

function toEnvironment(row: EnvironmentRow): EnvironmentChange {
  const key = row.key.trim();

  if (row.stored && row.secret) {
    switch (row.action) {
      case 'remove':
        return { operation: 'remove', key };
      case 'change':
        return { operation: 'set-secret', key, value: row.value };
      default:
        // No value, by construction. This is the whole reason the row knows it
        // came from the server.
        return { operation: 'unchanged', key };
    }
  }

  if (row.action === 'remove') {
    return { operation: 'remove', key };
  }

  return row.secret
    ? { operation: 'set-secret', key, value: row.value }
    : { operation: 'set', key, value: row.value };
}

function toPort(row: PortRow): PortSpec {
  return {
    containerPort: Number(row.containerPort),
    ...(row.hostPort ? { hostPort: Number(row.hostPort) } : {}),
    protocol: row.protocol,
    ...(row.hostIp ? { hostIp: row.hostIp } : {}),
  };
}

function toMount(row: MountRow): MountSpec {
  return {
    type: row.type,
    source: row.source.trim(),
    target: row.target.trim(),
    readOnly: row.readOnly,
  };
}

function hasPort(row: PortRow): boolean {
  return Boolean(row.containerPort.trim());
}

function words(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

/** A problem with one field, said where the field is. */
export interface FieldProblem {
  readonly field: string;
  readonly message: string;
}

/**
 * What the interface can tell without asking.
 *
 * Everything here is refused by the control server too. It is checked first so
 * a mistake is answered while somebody is still looking at the field that
 * caused it — never so that the server has to check less.
 */
export function problemsIn(
  form: ContainerFormModel,
  options: { requireHost: boolean },
): FieldProblem[] {
  const problems: FieldProblem[] = [];

  if (options.requireHost && !form.hostId) {
    problems.push({ field: 'hostId', message: 'Choose the host to create this container on.' });
  }

  if (!form.name.trim()) {
    problems.push({ field: 'name', message: 'A container needs a name.' });
  } else if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(form.name.trim())) {
    problems.push({
      field: 'name',
      message: 'Use letters, digits, and . _ - starting with a letter or digit.',
    });
  }

  if (!form.image.trim()) {
    problems.push({ field: 'image', message: 'A container needs an image.' });
  }

  const bound = new Set<string>();

  form.ports.forEach((port, index) => {
    const container = Number(port.containerPort);

    if (!port.containerPort.trim() || !inRange(container)) {
      problems.push({
        field: `ports.${index}.containerPort`,
        message: 'Container port must be between 1 and 65535.',
      });
    }

    if (port.hostPort.trim()) {
      const host = Number(port.hostPort);

      if (!inRange(host)) {
        problems.push({
          field: `ports.${index}.hostPort`,
          message: 'Host port must be between 1 and 65535.',
        });
      } else {
        const binding = `${port.hostIp || '*'}:${host}/${port.protocol}`;

        if (bound.has(binding)) {
          problems.push({
            field: `ports.${index}.hostPort`,
            message: 'This host port is already published by another mapping.',
          });
        }

        bound.add(binding);
      }
    }
  });

  const targets = new Set<string>();

  form.mounts.forEach((mount, index) => {
    if (!mount.source.trim()) {
      problems.push({
        field: `mounts.${index}.source`,
        message: mount.type === 'bind' ? 'Enter a path on the host.' : 'Enter a volume name.',
      });
    } else if (mount.type === 'bind' && forbiddenBind(mount.source)) {
      problems.push({
        field: `mounts.${index}.source`,
        message: 'Dockplane does not mount this path from the host.',
      });
    }

    if (!mount.target.trim()) {
      problems.push({ field: `mounts.${index}.target`, message: 'Enter a path in the container.' });
    } else if (!mount.target.startsWith('/')) {
      problems.push({
        field: `mounts.${index}.target`,
        message: 'The path in the container must be absolute.',
      });
    } else if (targets.has(mount.target.trim())) {
      problems.push({
        field: `mounts.${index}.target`,
        message: 'Something else is already mounted here.',
      });
    }

    targets.add(mount.target.trim());
  });

  const keys = new Set<string>();

  form.environment.forEach((row, index) => {
    const key = row.key.trim();

    if (!key) {
      problems.push({ field: `environment.${index}.key`, message: 'Enter a variable name.' });
      return;
    }

    if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(key)) {
      problems.push({
        field: `environment.${index}.key`,
        message: 'Use letters, digits and underscores, starting with a letter or underscore.',
      });
    }

    if (keys.has(key)) {
      problems.push({
        field: `environment.${index}.key`,
        message: 'This variable is listed twice.',
      });
    }

    keys.add(key);

    if (row.secret && !row.stored && !row.value) {
      problems.push({ field: `environment.${index}.value`, message: 'Enter the secret value.' });
    }

    if (row.secret && row.stored && row.action === 'change' && !row.value) {
      problems.push({
        field: `environment.${index}.value`,
        message: 'Enter the new secret value.',
      });
    }
  });

  form.labels.forEach((label, index) => {
    if (label.key.trim().startsWith(RESERVED_LABEL_PREFIX)) {
      problems.push({
        field: `labels.${index}.key`,
        message: 'This label namespace is reserved by Dockplane.',
      });
    }
  });

  return problems;
}

function inRange(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function forbiddenBind(source: string): boolean {
  const clean = source.trim().replace(/\/+$/, '');

  return (
    clean === '' ||
    clean === '/' ||
    FORBIDDEN_BIND_SOURCES.some(
      (forbidden) => clean === forbidden || clean.startsWith(`${forbidden}/`),
    )
  );
}

/** One line of what is about to change. */
export interface Change {
  readonly section: string;
  readonly kind: 'added' | 'removed' | 'changed';
  readonly text: string;
}

/**
 * What applying this form would change.
 *
 * Shown before anything is sent, because a replacement rebuilds the container
 * and an operator should see the whole list rather than discover an entry they
 * did not mean to touch afterwards.
 *
 * No secret value appears here, in either direction. A secret that changed says
 * that it changed; what it changed from and to is not the interface's to show,
 * and for the old value it does not have it.
 */
export function changesBetween(before: ContainerFormModel, after: ContainerFormModel): Change[] {
  const changes: Change[] = [];

  if (before.image !== after.image) {
    changes.push({ section: 'Image', kind: 'changed', text: `${before.image} → ${after.image}` });
  }

  if (before.name !== after.name) {
    changes.push({ section: 'General', kind: 'changed', text: `${before.name} → ${after.name}` });
  }

  if (before.hostname !== after.hostname) {
    changes.push({
      section: 'General',
      kind: 'changed',
      text: `Hostname ${before.hostname || 'none'} → ${after.hostname || 'none'}`,
    });
  }

  if (before.restartPolicy !== after.restartPolicy) {
    changes.push({
      section: 'Runtime',
      kind: 'changed',
      text: `Restart ${label(before.restartPolicy)} → ${label(after.restartPolicy)}`,
    });
  }

  compare(changes, 'Ports', before.ports.map(portText), after.ports.map(portText));
  compare(changes, 'Storage', before.mounts.map(mountText), after.mounts.map(mountText));
  compare(changes, 'Networks', before.networks, after.networks);
  compare(
    changes,
    'Labels',
    before.labels.map((entry) => `${entry.key}=${entry.value}`),
    after.labels.map((entry) => `${entry.key}=${entry.value}`),
  );

  if (before.command !== after.command) {
    changes.push({ section: 'Advanced', kind: 'changed', text: 'Command' });
  }

  if (before.entrypoint !== after.entrypoint) {
    changes.push({ section: 'Advanced', kind: 'changed', text: 'Entrypoint' });
  }

  changes.push(...environmentChanges(before.environment, after.environment));

  return changes;
}

function environmentChanges(
  before: readonly EnvironmentRow[],
  after: readonly EnvironmentRow[],
): Change[] {
  const changes: Change[] = [];
  const previous = new Map(before.map((row) => [row.key.trim(), row]));

  for (const row of after) {
    const key = row.key.trim();

    if (!key) {
      continue;
    }

    const existing = previous.get(key);

    if (row.action === 'remove') {
      changes.push({
        section: 'Environment',
        kind: 'removed',
        text: row.secret ? `${key} — secret removed` : key,
      });

      previous.delete(key);
      continue;
    }

    if (!existing) {
      changes.push({
        section: 'Environment',
        kind: 'added',
        text: row.secret ? `${key} — secret added` : `${key}=${row.value}`,
      });

      continue;
    }

    previous.delete(key);

    if (row.secret && row.action === 'change') {
      changes.push({ section: 'Environment', kind: 'changed', text: `${key} — secret changed` });
      continue;
    }

    if (!row.secret && existing.value !== row.value) {
      changes.push({ section: 'Environment', kind: 'changed', text: `${key}=${row.value}` });
    }
  }

  for (const [key, row] of previous) {
    changes.push({
      section: 'Environment',
      kind: 'removed',
      text: row.secret ? `${key} — secret removed` : key,
    });
  }

  return changes;
}

function compare(
  changes: Change[],
  section: string,
  before: readonly string[],
  after: readonly string[],
): void {
  for (const entry of after) {
    if (!before.includes(entry)) {
      changes.push({ section, kind: 'added', text: entry });
    }
  }

  for (const entry of before) {
    if (!after.includes(entry)) {
      changes.push({ section, kind: 'removed', text: entry });
    }
  }
}

export function portText(port: PortRow): string {
  const published = port.hostPort
    ? `${port.hostIp ? `${port.hostIp}:` : ''}${port.hostPort} → `
    : '';

  return `${published}${port.containerPort}/${port.protocol}`;
}

export function mountText(mount: MountRow): string {
  return `${mount.source}:${mount.target}${mount.readOnly ? ' (read only)' : ''}`;
}

function label(policy: RestartPolicy): string {
  return RESTART_POLICIES.find((entry) => entry.value === policy)?.label ?? policy;
}
