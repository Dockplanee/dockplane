import { TestBed } from '@angular/core/testing';

import { NAVIGATION } from './navigation';
import { PERMISSIONS, Permissions } from './permissions';
import { Session } from './session';
import { routes } from '../app.routes';

describe('navigation', () => {
  const routePaths = new Set(routes.map((route) => route.path));

  it('points every entry at an implemented route', () => {
    for (const group of NAVIGATION) {
      for (const item of group.items) {
        expect(routePaths.has(item.path.replace(/^\//, ''))).toBe(true);
      }
    }
  });

  it('guards every entry with a permission the control server issues', () => {
    for (const group of NAVIGATION) {
      for (const item of group.items) {
        if (item.permission) {
          expect(PERMISSIONS).toContain(item.permission);
        }
      }
    }
  });

  it('uses a unique path per entry', () => {
    const paths = NAVIGATION.flatMap((group) => group.items.map((item) => item.path));

    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('Permissions', () => {
  const signIn = (permissions: readonly (typeof PERMISSIONS)[number][]) => {
    TestBed.inject(Session).authenticate({
      kind: 'authenticated',
      user: {
        id: 'user-1',
        email: 'ops@example.internal',
        displayName: 'Ops',
        mfaEnabled: false,
        recoveryCodesRemaining: 0,
      },
      roles: ['Administrator'],
      permissions,
      session: { id: 'session-1', expiresAt: '2026-12-31T00:00:00.000Z' },
    });
  };

  /**
   * The property that replaced the development grant.
   *
   * Before a session exists there is nothing to grant from, so every question
   * answers no. An interface that assumed otherwise would offer controls the
   * server refuses, and would show an unauthenticated visitor a full navigation.
   */
  it('grants nothing before a session is established', () => {
    const permissions = TestBed.inject(Permissions);

    for (const key of PERMISSIONS) {
      expect(permissions.has(key)).toBe(false);
    }

    expect(permissions.all()).toEqual([]);
  });

  it('grants exactly what the control server returned', () => {
    const permissions = TestBed.inject(Permissions);

    signIn(['hosts.read', 'containers.read']);

    expect(permissions.has('hosts.read')).toBe(true);
    expect(permissions.has('containers.read')).toBe(true);
    expect(permissions.has('agents.revoke')).toBe(false);
    expect(permissions.has('audit.read')).toBe(false);
  });

  it('grants nothing again once the session ends', () => {
    const permissions = TestBed.inject(Permissions);

    signIn(['hosts.read']);
    expect(permissions.has('hosts.read')).toBe(true);

    TestBed.inject(Session).anonymous();

    expect(permissions.has('hosts.read')).toBe(false);
  });

  it('separates the three lifecycle permissions', () => {
    const permissions = TestBed.inject(Permissions);

    // A role may carry restart without carrying stop. Collapsing the three into
    // one "may operate containers" flag would offer an operator a control the
    // control server refuses.
    signIn(['containers.read', 'containers.restart']);

    expect(permissions.has('containers.restart')).toBe(true);
    expect(permissions.has('containers.start')).toBe(false);
    expect(permissions.has('containers.stop')).toBe(false);
  });

  it('treats reading logs as a permission of its own', () => {
    const permissions = TestBed.inject(Permissions);

    // Reading a container's output is not implied by being able to see the
    // container: an application decides what it prints, and it may print
    // credentials. It is granted, never inherited.
    signIn(['containers.read', 'containers.restart']);

    expect(permissions.has('containers.logs')).toBe(false);

    signIn(['containers.read', 'containers.logs']);

    expect(permissions.has('containers.logs')).toBe(true);
  });
});
