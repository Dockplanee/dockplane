import {
  createContainerSchema,
  environmentEntrySchema,
  removeContainerSchema,
  replaceContainerSchema,
} from '../src/containers/container-spec';

/**
 * What the server refuses before a host ever hears about it.
 *
 * The agent enforces the same boundaries and is the one that actually defends
 * the machine. These exist so an operator is told what is wrong by the
 * interface, and so a mistake in the server cannot be the only thing standing
 * between a browser and a Docker daemon.
 */
const valid = {
  hostId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  name: 'web',
  image: 'nginx:1.27-alpine',
  ports: [{ containerPort: 80, hostPort: 8080, protocol: 'tcp' as const }],
  mounts: [{ type: 'volume' as const, source: 'web-data', target: '/data' }],
  environment: [{ operation: 'set' as const, key: 'APP_ENV', value: 'production' }],
  networks: ['dockplane'],
  restartPolicy: 'unless-stopped' as const,
  labels: { 'com.example.team': 'platform' },
};

describe('the container specification', () => {
  it('accepts an ordinary container', () => {
    expect(createContainerSchema.safeParse(valid).success).toBe(true);
  });

  describe('what it refuses', () => {
    const refusals: [string, unknown][] = [
      ['a name with a slash', { ...valid, name: 'web/proxy' }],
      ['a name with a space', { ...valid, name: 'web proxy' }],
      ['an image carrying a command', { ...valid, image: 'nginx; rm -rf /' }],
      ['an image with a newline', { ...valid, image: 'nginx\nFROM scratch' }],
      ['a host that is not a resource id', { ...valid, hostId: 'docker-01' }],
      ['an unknown restart policy', { ...valid, restartPolicy: 'sometimes' }],
      ['a protocol that is neither', { ...valid, ports: [{ containerPort: 80, protocol: 'sctp' }] }],
      ['a container port of zero', { ...valid, ports: [{ containerPort: 0, protocol: 'tcp' }] }],
      [
        'one host port bound twice',
        {
          ...valid,
          ports: [
            { containerPort: 80, hostPort: 8080, protocol: 'tcp' },
            { containerPort: 81, hostPort: 8080, protocol: 'tcp' },
          ],
        },
      ],
      [
        'a bind address that is not one',
        { ...valid, ports: [{ containerPort: 80, hostPort: 8080, protocol: 'tcp', hostIp: 'evil.example' }] },
      ],
      ['a relative mount target', { ...valid, mounts: [{ type: 'volume', source: 'a', target: 'data' }] }],
      [
        'a mount target climbing out',
        { ...valid, mounts: [{ type: 'volume', source: 'a', target: '/data/../../etc' }] },
      ],
      [
        'one target mounted twice',
        {
          ...valid,
          mounts: [
            { type: 'volume', source: 'a', target: '/data' },
            { type: 'volume', source: 'b', target: '/data' },
          ],
        },
      ],
      ['a mount type Dockplane does not have', { ...valid, mounts: [{ type: 'tmpfs', source: 'a', target: '/t' }] }],
      ['an environment key that is not one', { ...valid, environment: [{ operation: 'set', key: 'not a key', value: 'x' }] }],
      [
        'an environment key smuggling an assignment',
        { ...valid, environment: [{ operation: 'set', key: 'A=B', value: 'x' }] },
      ],
      [
        'an environment value with a newline',
        { ...valid, environment: [{ operation: 'set', key: 'A', value: 'one\nTWO=two' }] },
      ],
      [
        'the same variable twice',
        {
          ...valid,
          environment: [
            { operation: 'set', key: 'A', value: '1' },
            { operation: 'set', key: 'A', value: '2' },
          ],
        },
      ],
      ['a network name that is not one', { ...valid, networks: ['net work'] }],
      ['a hostname that is not one', { ...valid, hostname: 'not a hostname' }],
      ['a healthcheck with nothing to run', { ...valid, healthcheck: { test: [] } }],
      // The fields a Docker payload would carry, and this is not one.
      ['a privileged flag', { ...valid, privileged: true }],
      ['a raw bind list', { ...valid, binds: ['/:/host'] }],
      ['a network mode', { ...valid, networkMode: 'host' }],
      ['added capabilities', { ...valid, capAdd: ['SYS_ADMIN'] }],
      ['devices', { ...valid, devices: ['/dev/sda'] }],
      ['a whole HostConfig', { ...valid, HostConfig: { Privileged: true } }],
      ['an agent chosen by the caller', { ...valid, agentId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' }],
      ['a Docker id chosen by the caller', { ...valid, dockerId: 'aaa111' }],
    ];

    for (const [description, payload] of refusals) {
      it(`refuses ${description}`, () => {
        expect(createContainerSchema.safeParse(payload).success).toBe(false);
      });
    }
  });

  /*
   * Mounting the Docker socket into a container hands over the host, and the
   * agent already holds that socket. The server says so first.
   */
  describe('host paths it will not bind', () => {
    for (const source of [
      '/var/run/docker.sock',
      '/run/docker.sock',
      '/var/lib/docker',
      '/var/lib/docker/volumes',
      '/proc',
      '/proc/self',
      '/sys',
      '/dev',
      '/boot',
      '/etc/shadow',
      '/root/.ssh',
      '/var/lib/dockplane-agent',
      '/',
    ]) {
      it(`refuses ${source}`, () => {
        const payload = { ...valid, mounts: [{ type: 'bind', source, target: '/mnt' }] };

        expect(createContainerSchema.safeParse(payload).success).toBe(false);
      });
    }

    it('allows an ordinary bind mount', () => {
      const payload = { ...valid, mounts: [{ type: 'bind', source: '/srv/app', target: '/app' }] };

      expect(createContainerSchema.safeParse(payload).success).toBe(true);
    });
  });

  describe('labels Dockplane sets', () => {
    for (const key of [
      'io.dockplane.managed',
      'io.dockplane.container-id',
      'io.dockplane.stack',
      'io.dockplane.anything',
    ]) {
      it(`refuses ${key}`, () => {
        expect(createContainerSchema.safeParse({ ...valid, labels: { [key]: 'mine' } }).success).toBe(
          false,
        );
      });
    }
  });

  /*
   * A masked value is not a value.
   *
   * A form showing `••••••••` and sending it back would otherwise set the
   * password to eight bullets. The operation says what is meant, so there is
   * nothing to infer.
   */
  describe('what an environment entry means', () => {
    it('carries no value when it is unchanged', () => {
      const parsed = environmentEntrySchema.safeParse({ operation: 'unchanged', key: 'DB_PASSWORD' });

      expect(parsed.success).toBe(true);
      expect(parsed.success && 'value' in parsed.data).toBe(false);
    });

    it('refuses a value smuggled onto an unchanged entry', () => {
      const parsed = environmentEntrySchema.safeParse({
        operation: 'unchanged',
        key: 'DB_PASSWORD',
        value: '••••••••',
      });

      expect(parsed.success).toBe(false);
    });

    it('refuses a value on a removal', () => {
      expect(
        environmentEntrySchema.safeParse({ operation: 'remove', key: 'A', value: 'x' }).success,
      ).toBe(false);
    });

    it('takes a new secret only when asked to replace one', () => {
      expect(
        environmentEntrySchema.safeParse({ operation: 'set-secret', key: 'DB_PASSWORD', value: 'new' })
          .success,
      ).toBe(true);
    });

    it('refuses an operation it does not have', () => {
      expect(
        environmentEntrySchema.safeParse({ operation: 'reveal', key: 'DB_PASSWORD' }).success,
      ).toBe(false);
    });
  });

  describe('replacing', () => {
    it('takes a whole configuration rather than a patch', () => {
      const { hostId, name, ...configuration } = valid;

      expect(replaceContainerSchema.safeParse(configuration).success).toBe(true);
      expect(hostId).toBeDefined();
      expect(name).toBeDefined();
    });

    it('refuses a host, because the container already has one', () => {
      expect(replaceContainerSchema.safeParse(valid).success).toBe(false);
    });
  });

  describe('removing', () => {
    it('has no way to ask for volumes to be deleted', () => {
      expect(removeContainerSchema.safeParse({ removeVolumes: true }).success).toBe(false);
      expect(removeContainerSchema.safeParse({ v: true }).success).toBe(false);
      expect(removeContainerSchema.safeParse({ force: true }).success).toBe(false);
    });

    it('keeps a running container unless stopping it was asked for', () => {
      const parsed = removeContainerSchema.safeParse({});

      expect(parsed.success && parsed.data.stopFirst).toBe(false);
    });
  });
});
