import { EXAMPLE_PERMISSIONS, IN_SCOPE } from './product';

/**
 * The product page shows permission keys in a code block. A key that does not
 * exist reads exactly like one that does — `compose.operate` was on the page
 * for three releases and was never a permission anybody could grant.
 *
 * The catalogue below is `PERMISSIONS` in api/src/rbac/permissions.ts. It is
 * repeated here because the website is built on its own; when the backend adds
 * a permission, this list is what has to be brought along.
 */
const BACKEND_PERMISSIONS = [
  'hosts.read',
  'hosts.archive',
  'containers.read',
  'containers.start',
  'containers.stop',
  'containers.restart',
  'containers.logs',
  'containers.create',
  'containers.update',
  'containers.delete',
  'compose.read',
  'stacks.read',
  'stacks.create',
  'stacks.update',
  'stacks.deploy',
  'stacks.delete',
  'agents.read',
  'agents.enroll',
  'agents.revoke',
  'audit.read',
  'users.read',
  'users.manage',
  'roles.read',
  'sessions.read',
  'sessions.revoke',
];

describe('the product page', () => {
  it('shows only permissions the backend defines', () => {
    for (const permission of EXAMPLE_PERMISSIONS) {
      expect(BACKEND_PERMISSIONS, `"${permission}" is not a permission`).toContain(permission);
    }
  });

  it('does not present a planned capability as part of the product today', () => {
    const scope = IN_SCOPE.join(' ').toLowerCase();

    // Each of these was on the page as something Dockplane already covers.
    // None of them exists: there is no route, and no agent capability.
    for (const claim of ['host groups', 'container metrics', 'resource-scoped', 'volumes']) {
      expect(scope, `"${claim}" is presented as part of the product`).not.toContain(claim);
    }
  });
});
