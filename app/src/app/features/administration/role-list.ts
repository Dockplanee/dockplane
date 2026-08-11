import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';

import { PageContext } from '../../core/page-context';
import { DockplaneApi } from '../../data/dockplane-api';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { Panel } from '../../ui/panel/panel';

/**
 * Roles and the permissions they carry.
 *
 * What is listed here is what the interface offers. The control server remains
 * the authorization boundary and checks every request independently.
 */
@Component({
  selector: 'dp-role-list',
  imports: [EmptyState, Panel],
  template: `
    @if (roles().length > 0) {
      <div class="roles">
        @for (role of roles(); track role.id) {
          <dp-panel [heading]="role.name" icon="roles">
            <p class="description">{{ role.description }}</p>

            <p class="members">
              @if (role.builtIn) {
                <span class="built-in">Built-in</span>
              }
            </p>

            <ul class="permissions">
              @for (permission of role.permissions; track permission) {
                <li class="dp-mono">{{ permission }}</li>
              }
            </ul>
          </dp-panel>
        }
      </div>
    } @else {
      <dp-panel flush>
        <dp-empty-state
          icon="roles"
          title="No roles defined"
          detail="Roles group the permissions an operator needs. They are managed by an administrator."
        />
      </dp-panel>
    }

    <p class="note">
      Permissions decide what this interface offers. Every request is authorized again by the
      control server, so hiding a control is never the access boundary.
    </p>
  `,
  styles: `
    .roles {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.75rem;
    }

    .description {
      color: var(--dp-fg-muted);
      font-size: 0.8125rem;
      line-height: 1.6;
    }

    .members {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: 0.5rem;
      color: var(--dp-fg-muted);
      font-size: 0.75rem;
    }

    .built-in {
      padding: 0.0625rem 0.375rem;
      border: 1px solid var(--dp-line);
      border-radius: 4px;
      font-size: 0.6875rem;
    }

    .permissions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.375rem;
      list-style: none;
      margin: 0.875rem 0 0;
      padding: 0;
    }

    .permissions li {
      padding: 0.125rem 0.4375rem;
      border: 1px solid var(--dp-line);
      border-radius: 4px;
      background-color: var(--dp-surface-inset);
      color: var(--dp-fg-muted);
      font-size: 0.6875rem;
    }

    .note {
      margin-top: 1rem;
      color: var(--dp-fg-muted);
      font-size: 0.75rem;
      line-height: 1.6;
      max-width: 62ch;
    }

    @media (min-width: 1100px) {
      .roles {
        grid-template-columns: repeat(auto-fit, minmax(22rem, 1fr));
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoleList {
  private readonly api = inject(DockplaneApi);

  protected readonly roles = toSignal(this.api.roles(), { initialValue: [] });

  constructor() {
    inject(PageContext).set({ title: 'Roles', subtitle: 'Permission sets assigned to users' });
  }
}
