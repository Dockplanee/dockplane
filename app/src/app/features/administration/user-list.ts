import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';

import { relativeTime } from '../../core/format';
import { PageContext } from '../../core/page-context';
import { DockplaneApi } from '../../data/dockplane-api';
import { StatusTone } from '../../domain/status';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { Panel } from '../../ui/panel/panel';
import { StatusBadge } from '../../ui/status-badge/status-badge';
import { TableShell } from '../../ui/table/table-shell';

const USER_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  active: { label: 'Active', tone: 'ok' },
  disabled: { label: 'Disabled', tone: 'neutral' },
  invited: { label: 'Invited', tone: 'info' },
};

@Component({
  selector: 'dp-user-list',
  imports: [EmptyState, Panel, StatusBadge, TableShell],
  template: `
    <dp-panel flush>
      @if (users().length > 0) {
        <dp-table-shell [count]="users().length" noun="user" nounPlural="users" minWidth="52rem">
          <table class="dp-table">
            <caption>
              Local Dockplane users
            </caption>
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Status</th>
                <th scope="col">MFA</th>
                <th scope="col">Last login</th>
              </tr>
            </thead>
            <tbody>
              @for (user of rows(); track user.id) {
                <tr>
                  <th scope="row">
                    {{ user.name }}
                    <span class="secondary">{{ user.email }}</span>
                  </th>
                  <td>
                    <dp-status-badge [tone]="user.statusTone" [label]="user.statusLabel" />
                  </td>
                  <td>
                    <dp-status-badge
                      [tone]="user.mfaEnabled ? 'ok' : 'warn'"
                      [label]="user.mfaEnabled ? 'Enabled' : 'Not enabled'"
                    />
                  </td>
                  <td class="shrink dp-unknown">{{ user.lastLogin }}</td>
                </tr>
              }
            </tbody>
          </table>
        </dp-table-shell>
      } @else {
        <dp-empty-state
          icon="users"
          title="No users yet"
          detail="Users are created by an administrator and authenticate against the Dockplane control server."
        />
      }
    </dp-panel>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserList {
  private readonly api = inject(DockplaneApi);

  protected readonly users = toSignal(this.api.users(), { initialValue: [] });
  private readonly roles = toSignal(this.api.roles(), { initialValue: [] });

  protected readonly rows = computed(() =>
    this.users().map((user) => ({
      ...user,
      statusLabel: USER_STATUS[user.status]?.label ?? 'Unknown',
      statusTone: USER_STATUS[user.status]?.tone ?? ('neutral' as StatusTone),
      roles: user.roleIds
        .map((id) => this.roles().find((role) => role.id === id)?.name ?? id)
        .join(', '),
      lastLogin: user.lastLogin ? relativeTime(user.lastLogin) : 'Never',
    })),
  );

  constructor() {
    inject(PageContext).set({ title: 'Users', subtitle: 'Local Dockplane users and their roles' });
  }
}
