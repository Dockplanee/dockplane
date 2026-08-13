import { describe, expect, it } from 'vitest';

import { ContainerConfiguration } from '../../data/dockplane-api';
import {
  ContainerFormModel,
  changesBetween,
  emptyForm,
  formFrom,
  problemsIn,
  requestFrom,
} from './container-form-model';

/**
 * What the form sends, and what it refuses to send.
 *
 * These are pure functions over plain data, so the rule that matters most can
 * be checked exactly: an interface that was never shown a secret must not send
 * one, and must not send anything that could be mistaken for one.
 */
const CANARY = 'canary-secret-value';

function configuration(overrides: Partial<ContainerConfiguration> = {}): ContainerConfiguration {
  return {
    name: 'shop-web',
    image: 'nginx:1.27',
    ports: [{ containerPort: 80, hostPort: 8080, protocol: 'tcp' }],
    mounts: [{ type: 'volume', source: 'app-data', target: '/data' }],
    networks: ['shop'],
    restartPolicy: 'unless-stopped',
    labels: {},
    environment: [
      { key: 'LOG_LEVEL', secret: false, value: 'debug' },
      { key: 'DB_PASSWORD', secret: true },
    ],
    reconciling: false,
    ...overrides,
  };
}

function form(overrides: Partial<ContainerFormModel> = {}): ContainerFormModel {
  return { ...emptyForm('host-1'), name: 'shop-web', image: 'nginx:1.27', ...overrides };
}

describe('filling the form from a configuration', () => {
  it('gives a stored secret no value at all', () => {
    const model = formFrom(configuration(), 'host-1');
    const secret = model.environment.find((row) => row.key === 'DB_PASSWORD')!;

    // Not a masked string either: a mask in the value is a value that could be
    // sent back as though somebody had typed it.
    expect(secret.value).toBe('');
    expect(secret.secret).toBe(true);
    expect(secret.stored).toBe(true);
    expect(secret.action).toBe('unchanged');
  });

  it('keeps an ordinary value, which the server does return', () => {
    const model = formFrom(configuration(), 'host-1');

    expect(model.environment.find((row) => row.key === 'LOG_LEVEL')?.value).toBe('debug');
  });
});

describe('what the form sends', () => {
  it('leaves an untouched secret alone, and sends no value for it', () => {
    const model = formFrom(configuration(), 'host-1');
    const request = requestFrom(model, { includeHost: false });
    const secret = request.environment!.find((entry) => entry.key === 'DB_PASSWORD')!;

    expect(secret.operation).toBe('unchanged');
    expect('value' in secret).toBe(false);
    expect(JSON.stringify(request)).not.toContain('•');
  });

  it('sends a new secret as one', () => {
    const model = formFrom(configuration(), 'host-1');

    model.environment = model.environment.map((row) =>
      row.key === 'DB_PASSWORD' ? { ...row, action: 'change' as const, value: CANARY } : row,
    );

    const secret = requestFrom(model, { includeHost: false }).environment!.find(
      (entry) => entry.key === 'DB_PASSWORD',
    )!;

    expect(secret).toEqual({ operation: 'set-secret', key: 'DB_PASSWORD', value: CANARY });
  });

  it('says a secret is being removed rather than omitting it', () => {
    const model = formFrom(configuration(), 'host-1');

    model.environment = model.environment.map((row) =>
      row.key === 'DB_PASSWORD' ? { ...row, action: 'remove' as const } : row,
    );

    const secret = requestFrom(model, { includeHost: false }).environment!.find(
      (entry) => entry.key === 'DB_PASSWORD',
    )!;

    expect(secret).toEqual({ operation: 'remove', key: 'DB_PASSWORD' });
  });

  it('carries the host when creating and not when replacing', () => {
    expect(requestFrom(form(), { includeHost: true }).hostId).toBe('host-1');
    expect(requestFrom(form(), { includeHost: false }).hostId).toBeUndefined();
  });

  it('drops rows nobody filled in', () => {
    const request = requestFrom(
      form({
        ports: [{ hostIp: '', hostPort: '', containerPort: '', protocol: 'tcp' }],
        mounts: [{ type: 'volume', source: '', target: '', readOnly: false }],
      }),
      { includeHost: true },
    );

    expect(request.ports).toEqual([]);
    expect(request.mounts).toEqual([]);
  });

  it('splits a command on spaces rather than handing over a string', () => {
    // A command that arrived as one line would have to be split by something,
    // and whatever split it would be a shell.
    expect(
      requestFrom(form({ command: 'nginx -g daemon off;' }), { includeHost: true }).command,
    ).toEqual(['nginx', '-g', 'daemon', 'off;']);
  });
});

describe('what the form refuses before asking', () => {
  it('needs a host, a name and an image', () => {
    const problems = problemsIn(emptyForm(), { requireHost: true }).map((entry) => entry.field);

    expect(problems).toEqual(expect.arrayContaining(['hostId', 'name', 'image']));
  });

  it('refuses a port outside the range', () => {
    const problems = problemsIn(
      form({ ports: [{ hostIp: '', hostPort: '99999', containerPort: '0', protocol: 'tcp' }] }),
      { requireHost: false },
    );

    expect(problems.map((entry) => entry.field)).toEqual(
      expect.arrayContaining(['ports.0.hostPort', 'ports.0.containerPort']),
    );
  });

  it('refuses the same host port twice', () => {
    const problems = problemsIn(
      form({
        ports: [
          { hostIp: '', hostPort: '8080', containerPort: '80', protocol: 'tcp' },
          { hostIp: '', hostPort: '8080', containerPort: '81', protocol: 'tcp' },
        ],
      }),
      { requireHost: false },
    );

    expect(problems.some((entry) => entry.field === 'ports.1.hostPort')).toBe(true);
  });

  /*
   * The same paths the agent refuses. Checked here so somebody is told while
   * they are still looking at the field — never so the agent has to check less.
   */
  it('refuses a bind mount that reaches for the host', () => {
    for (const source of ['/var/run/docker.sock', '/proc', '/', '/etc/shadow/x']) {
      const problems = problemsIn(
        form({ mounts: [{ type: 'bind', source, target: '/mnt', readOnly: false }] }),
        { requireHost: false },
      );

      expect(problems.some((entry) => entry.field === 'mounts.0.source')).toBe(true);
    }
  });

  it('allows a named volume of the same name as a refused path', () => {
    const problems = problemsIn(
      form({ mounts: [{ type: 'volume', source: 'proc-data', target: '/data', readOnly: false }] }),
      { requireHost: false },
    );

    expect(problems).toEqual([]);
  });

  it('refuses a label in the namespace Dockplane sets', () => {
    const problems = problemsIn(
      form({ labels: [{ key: 'io.dockplane.container-id', value: 'mine' }] }),
      { requireHost: false },
    );

    expect(problems[0]?.message).toContain('reserved');
  });

  it('needs a value for a new secret, and for one being changed', () => {
    expect(
      problemsIn(
        form({
          environment: [{ key: 'A', value: '', secret: true, stored: false, action: 'unchanged' }],
        }),
        { requireHost: false },
      ).some((entry) => entry.field === 'environment.0.value'),
    ).toBe(true);

    expect(
      problemsIn(
        form({
          environment: [{ key: 'A', value: '', secret: true, stored: true, action: 'change' }],
        }),
        { requireHost: false },
      ).some((entry) => entry.field === 'environment.0.value'),
    ).toBe(true);
  });

  it('does not ask for a value for a secret nobody is touching', () => {
    expect(
      problemsIn(
        form({
          environment: [{ key: 'A', value: '', secret: true, stored: true, action: 'unchanged' }],
        }),
        { requireHost: false },
      ),
    ).toEqual([]);
  });
});

describe('what is about to change', () => {
  it('says nothing changed when nothing did', () => {
    const model = formFrom(configuration(), 'host-1');

    expect(changesBetween(model, model)).toEqual([]);
  });

  it('names a changed secret without either value', () => {
    const before = formFrom(configuration(), 'host-1');
    const after = {
      ...before,
      environment: before.environment.map((row) =>
        row.key === 'DB_PASSWORD' ? { ...row, action: 'change' as const, value: CANARY } : row,
      ),
    };

    const changes = changesBetween(before, after);
    const secret = changes.find((change) => change.text.startsWith('DB_PASSWORD'))!;

    expect(secret.text).toBe('DB_PASSWORD — secret changed');
    expect(JSON.stringify(changes)).not.toContain(CANARY);
  });

  it('names a removed secret as removed', () => {
    const before = formFrom(configuration(), 'host-1');
    const after = {
      ...before,
      environment: before.environment.map((row) =>
        row.key === 'DB_PASSWORD' ? { ...row, action: 'remove' as const } : row,
      ),
    };

    expect(changesBetween(before, after)).toContainEqual({
      section: 'Environment',
      kind: 'removed',
      text: 'DB_PASSWORD — secret removed',
    });
  });

  it('reports a port that was added and one that went', () => {
    const before = formFrom(configuration(), 'host-1');
    const after = {
      ...before,
      ports: [{ hostIp: '', hostPort: '8443', containerPort: '443', protocol: 'tcp' as const }],
    };

    const changes = changesBetween(before, after);

    expect(changes).toContainEqual({ section: 'Ports', kind: 'added', text: '8443 → 443/tcp' });
    expect(changes).toContainEqual({ section: 'Ports', kind: 'removed', text: '8080 → 80/tcp' });
  });

  it('reports an image and a restart policy', () => {
    const before = formFrom(configuration(), 'host-1');
    const after = { ...before, image: 'nginx:1.28', restartPolicy: 'always' as const };
    const changes = changesBetween(before, after);

    expect(changes).toContainEqual({
      section: 'Image',
      kind: 'changed',
      text: 'nginx:1.27 → nginx:1.28',
    });
    expect(changes.some((change) => change.text.startsWith('Restart'))).toBe(true);
  });

  it('reports an ordinary variable by value and a new secret without one', () => {
    const before = formFrom(configuration(), 'host-1');
    const after = {
      ...before,
      environment: [
        ...before.environment.map((row) =>
          row.key === 'LOG_LEVEL' ? { ...row, value: 'info' } : row,
        ),
        {
          key: 'API_TOKEN',
          value: CANARY,
          secret: true,
          stored: false,
          action: 'unchanged' as const,
        },
      ],
    };

    const changes = changesBetween(before, after);

    expect(changes).toContainEqual({
      section: 'Environment',
      kind: 'changed',
      text: 'LOG_LEVEL=info',
    });
    expect(changes).toContainEqual({
      section: 'Environment',
      kind: 'added',
      text: 'API_TOKEN — secret added',
    });
    expect(JSON.stringify(changes)).not.toContain(CANARY);
  });
});
