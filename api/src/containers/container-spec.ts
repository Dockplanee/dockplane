import { z } from 'zod';

/**
 * What a container may be asked to be.
 *
 * The same boundaries the agent enforces, checked here first so an operator
 * learns about a mistake from the interface rather than from a host. The agent
 * checks again regardless: this one is for the person, that one is for the
 * machine.
 *
 * Nothing here is a Docker API payload. A caller describes a container in these
 * fields, and a field that is not here cannot be asked for — which is what
 * keeps privileged, host namespaces, devices and arbitrary capabilities out of
 * Dockplane's remote surface entirely.
 */

/** Docker's own container name rule. */
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
/** A reference, not a command: no whitespace, no shell metacharacters. */
const IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,254}$/;
/** POSIX-ish, and no `=`, which would smuggle a second assignment into one. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;
const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const NETWORK = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const LABEL_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const HOSTNAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

/**
 * Labels Dockplane sets and a caller may not.
 *
 * They are the agent's statement about what a container is — that Dockplane
 * built it, which resource it is, which stack it belongs to. A request that
 * sets one is refused rather than quietly overridden, so an operator learns
 * their label was rejected instead of believing it was applied.
 */
export const RESERVED_LABEL_PREFIX = 'io.dockplane.';

/**
 * Host paths that are never a legitimate bind source.
 *
 * Refused here as well as on the agent. The agent is the boundary that matters,
 * because it is the one on the machine; this is the one that answers quickly
 * and explains itself.
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

function forbiddenBind(source: string): boolean {
  const clean = source.replace(/\/+$/, '');

  return FORBIDDEN_BIND_SOURCES.some(
    (forbidden) => clean === forbidden || clean.startsWith(`${forbidden}/`),
  );
}

const portSchema = z.strictObject({
  containerPort: z.number().int().min(1).max(65535),
  hostPort: z.number().int().min(0).max(65535).optional().default(0),
  protocol: z.enum(['tcp', 'udp']),
  // Deliberately narrow: the addresses somebody binds a published port to.
  hostIp: z.enum(['127.0.0.1', '0.0.0.0', '::1', '::']).optional(),
});

const mountSchema = z
  .strictObject({
    type: z.enum(['volume', 'bind']),
    source: z.string().min(1).max(4096),
    target: z.string().min(1).max(4096),
    readOnly: z.boolean().optional().default(false),
  })
  .superRefine((mount, context) => {
    if (!mount.target.startsWith('/') || mount.target.includes('..')) {
      context.addIssue({
        code: 'custom',
        path: ['target'],
        message: 'A mount target must be an absolute path and may not climb out of one.',
      });
    }

    if (mount.type === 'volume' && !VOLUME_NAME.test(mount.source)) {
      context.addIssue({ code: 'custom', path: ['source'], message: 'Not a volume name.' });
      return;
    }

    if (mount.type === 'bind') {
      if (!mount.source.startsWith('/') || mount.source.includes('..')) {
        context.addIssue({
          code: 'custom',
          path: ['source'],
          message: 'A bind source must be an absolute path and may not climb out of one.',
        });
        return;
      }

      if (mount.source.replace(/\/+$/, '') === '') {
        context.addIssue({
          code: 'custom',
          path: ['source'],
          message: 'The root filesystem may not be bind-mounted.',
        });
        return;
      }

      if (forbiddenBind(mount.source)) {
        context.addIssue({
          code: 'custom',
          path: ['source'],
          message: 'This host path may not be bind-mounted by Dockplane.',
        });
      }
    }
  });

/**
 * An environment variable, and what is being done to it.
 *
 * The operation is explicit because a masked value must never be mistaken for a
 * new one. A form that sends back `••••••••` is saying "unchanged", and the
 * only way to be sure of that is to have it say so.
 */
export const environmentEntrySchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('set'),
    key: z.string().regex(ENV_KEY, 'Not an environment variable name.'),
    value: z
      .string()
      .max(32_768)
      .refine((value) => !/[\0\n\r]/.test(value), {
        message: 'An environment value may not contain a newline or a null byte.',
      }),
    secret: z.literal(false).optional().default(false),
  }),
  z.strictObject({
    operation: z.literal('set-secret'),
    key: z.string().regex(ENV_KEY, 'Not an environment variable name.'),
    value: z
      .string()
      .min(1)
      .max(32_768)
      .refine((value) => !/[\0\n\r]/.test(value), {
        message: 'An environment value may not contain a newline or a null byte.',
      }),
    secret: z.literal(true).optional().default(true),
  }),
  // The value is not sent, because the browser does not have it.
  z.strictObject({
    operation: z.literal('unchanged'),
    key: z.string().regex(ENV_KEY, 'Not an environment variable name.'),
  }),
  z.strictObject({
    operation: z.literal('remove'),
    key: z.string().regex(ENV_KEY, 'Not an environment variable name.'),
  }),
]);

export type EnvironmentEntry = z.infer<typeof environmentEntrySchema>;

const healthcheckSchema = z.strictObject({
  test: z.array(z.string().max(1024)).min(1).max(32),
  intervalMs: z.number().int().min(0).max(3_600_000).optional(),
  timeoutMs: z.number().int().min(0).max(3_600_000).optional(),
  startPeriodMs: z.number().int().min(0).max(3_600_000).optional(),
  retries: z.number().int().min(0).max(100).optional(),
});

const labelsSchema = z
  .record(z.string().regex(LABEL_KEY, 'Not a label name.'), z.string().max(4096))
  .superRefine((labels, context) => {
    for (const key of Object.keys(labels)) {
      if (key.startsWith(RESERVED_LABEL_PREFIX)) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `Labels beginning with ${RESERVED_LABEL_PREFIX} are set by Dockplane.`,
        });
      }
    }
  });

/** The configuration fields, shared by creating and replacing. */
const configurationShape = {
  image: z.string().regex(IMAGE, 'Not an image reference.'),
  hostname: z.string().regex(HOSTNAME, 'Not a hostname.').optional(),
  // Arrays, never a string. A command that arrived as one line would have to be
  // split by something, and whatever split it would be a shell.
  command: z.array(z.string().max(4096)).max(128).optional(),
  entrypoint: z.array(z.string().max(4096)).max(128).optional(),
  ports: z.array(portSchema).max(128).optional().default([]),
  mounts: z.array(mountSchema).max(64).optional().default([]),
  environment: z.array(environmentEntrySchema).max(512).optional().default([]),
  networks: z
    .array(z.string().regex(NETWORK, 'Not a network name.'))
    .max(16)
    .optional()
    .default([]),
  restartPolicy: z.enum(['no', 'always', 'unless-stopped', 'on-failure']).optional().default('no'),
  labels: labelsSchema.optional().default({}),
  healthcheck: healthcheckSchema.optional(),
};

function refineConfiguration(
  value: {
    ports: z.infer<typeof portSchema>[];
    mounts: { target: string }[];
    environment: EnvironmentEntry[];
  },
  context: z.RefinementCtx,
): void {
  const boundHostPorts = new Set<string>();

  for (const port of value.ports) {
    if (!port.hostPort) {
      continue;
    }

    const key = `${port.hostIp ?? ''}:${port.hostPort}/${port.protocol}`;

    if (boundHostPorts.has(key)) {
      context.addIssue({
        code: 'custom',
        path: ['ports'],
        message: `Host port ${port.hostPort}/${port.protocol} is bound more than once.`,
      });
    }

    boundHostPorts.add(key);
  }

  const targets = new Set<string>();

  for (const mount of value.mounts) {
    if (targets.has(mount.target)) {
      context.addIssue({
        code: 'custom',
        path: ['mounts'],
        message: `${mount.target} is mounted more than once.`,
      });
    }

    targets.add(mount.target);
  }

  const keys = new Set<string>();

  for (const entry of value.environment) {
    if (keys.has(entry.key)) {
      context.addIssue({
        code: 'custom',
        path: ['environment'],
        message: `${entry.key} is given more than once.`,
      });
    }

    keys.add(entry.key);
  }
}

/**
 * Creating a container.
 *
 * The host is named as a Dockplane resource. The agent is not, and neither is
 * any Docker identifier: the server resolves those, so a caller cannot choose
 * which agent hears a request or which container it lands on.
 */
export const createContainerSchema = z
  .strictObject({
    hostId: z.uuid(),
    name: z.string().regex(NAME, 'Not a container name.'),
    ...configurationShape,
  })
  .superRefine(refineConfiguration);

export type CreateContainerRequest = z.infer<typeof createContainerSchema>;

/**
 * Replacing a container.
 *
 * The whole desired configuration, not a patch. The server holds what the
 * container is supposed to be, applies what the operator changed, and sends the
 * result — so two edits cannot interleave into a configuration nobody asked
 * for, and nothing is merged on a host.
 *
 * The name may change; the resource may not. A replacement is the same
 * Dockplane container whatever Docker calls it.
 */
export const replaceContainerSchema = z
  .strictObject({
    name: z.string().regex(NAME, 'Not a container name.').optional(),
    ...configurationShape,
  })
  .superRefine(refineConfiguration);

export type ReplaceContainerRequest = z.infer<typeof replaceContainerSchema>;

/**
 * Removing a container.
 *
 * Volumes are not mentioned, because they are never removed with it. There is
 * no field to set and no default to get wrong.
 */
export const removeContainerSchema = z.strictObject({
  /*
   * Stop it first if it is running.
   *
   * Without this a running container is refused rather than killed, so removing
   * one that is still serving traffic is a thing somebody chose rather than a
   * thing that happened.
   */
  stopFirst: z.boolean().optional().default(false),
});

export type RemoveContainerRequest = z.infer<typeof removeContainerSchema>;
