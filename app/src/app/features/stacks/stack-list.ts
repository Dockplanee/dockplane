import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';

import { relativeTime } from '../../core/format';
import { PageContext } from '../../core/page-context';
import { Permissions } from '../../core/permissions';
import { DockplaneApi } from '../../data/dockplane-api';
import { STACK_STATE_LABELS, STACK_STATE_TONES, Stack, stackState } from '../../domain/stacks';
import { Button } from '../../ui/button';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { Icon } from '../../ui/icon/icon';
import { PageHeader } from '../../ui/page-header/page-header';
import { Panel } from '../../ui/panel/panel';
import { SelectFilter } from '../../ui/select-filter/select-filter';
import { StatusBadge } from '../../ui/status-badge/status-badge';
import { TableShell } from '../../ui/table/table-shell';

/**
 * Stacks Dockplane manages.
 *
 * Not the Compose projects discovered on a host — those are somebody else's and
 * are listed under Compose, read-only. A stack here is one this product wrote,
 * keeps the history of, and can put on a machine.
 *
 * Two revisions are shown per row because they answer different questions:
 * what was last saved, and what is actually running. A stack whose newest
 * revision is not the running one is a normal and intended state, and it says
 * so rather than looking like a fault.
 */
@Component({
  selector: 'dp-stack-list',
  imports: [
    RouterLink,
    Button,
    EmptyState,
    Icon,
    PageHeader,
    Panel,
    SelectFilter,
    StatusBadge,
    TableShell,
  ],
  template: `
    <dp-page-header title="Stacks">
      @if (canCreate()) {
        <a dpButton variant="primary" routerLink="/stacks/new">Create stack</a>
      }
    </dp-page-header>

    <dp-panel flush>
      <div class="dp-controls">
        <div class="dp-controls__search">
          <label class="dp-sr-only" for="stack-search">Search stacks</label>
          <dp-icon name="search" class="dp-controls__search-icon" />
          <input
            id="stack-search"
            class="dp-field"
            type="search"
            placeholder="Search stacks"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
          />
        </div>

        <dp-select-filter
          id="stack-host"
          label="Filter by host"
          [options]="hostOptions()"
          [value]="hostFilter()"
          (valueChange)="hostFilter.set($event)"
        />
      </div>

      @if (filtered().length > 0) {
        <dp-table-shell
          [count]="filtered().length"
          [total]="stacks().length"
          noun="stack"
          nounPlural="stacks"
          minWidth="52rem"
        >
          <table class="dp-table">
            <caption>
              Stacks Dockplane manages
            </caption>
            <thead>
              <tr>
                <th scope="col">Stack</th>
                <th scope="col">Host</th>
                <th scope="col">Status</th>
                <th scope="col">Saved</th>
                <th scope="col">Deployed</th>
                <th scope="col">Services</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              @for (stack of filtered(); track stack.id) {
                <tr>
                  <th scope="row">
                    <a class="identifier" [routerLink]="['/stacks', stack.id]">{{ stack.name }}</a>
                  </th>
                  <td class="dp-unknown">{{ stack.hostname }}</td>
                  <td>
                    <dp-status-badge [tone]="tone(stack)" [label]="label(stack)" />
                  </td>
                  <td class="dp-mono">
                    {{ stack.latestRevision ? '#' + stack.latestRevision.number : '—' }}
                  </td>
                  <td class="dp-mono">
                    {{
                      stack.deployedRevision ? '#' + stack.deployedRevision.number : 'Not deployed'
                    }}
                  </td>
                  <td class="dp-mono">{{ serviceCount(stack) }}</td>
                  <td class="shrink dp-unknown">{{ age(stack.updatedAt) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </dp-table-shell>
      } @else {
        <dp-empty-state
          icon="compose"
          title="No stacks"
          [detail]="
            stacks().length > 0
              ? 'No stack matches the current filters.'
              : 'A stack is a Compose file Dockplane keeps, deploys and can roll back.'
          "
        />
      }
    </dp-panel>
  `,
  styles: `
    :host {
      display: block;
    }

    .identifier {
      font-family: var(--font-mono);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StackList {
  private readonly api = inject(DockplaneApi);
  private readonly permissions = inject(Permissions);

  protected readonly query = signal('');
  protected readonly hostFilter = signal('all');

  protected readonly stacks = toSignal(this.api.stacks(), { initialValue: [] });
  private readonly hosts = toSignal(this.api.hosts(), { initialValue: [] });

  protected readonly canCreate = computed(() => this.permissions.has('stacks.create'));

  protected readonly hostOptions = computed(() => [
    { value: 'all', label: 'All hosts' },
    ...this.hosts().map((host) => ({ value: host.id, label: host.name })),
  ]);

  protected readonly filtered = computed(() => {
    const term = this.query().trim().toLowerCase();
    const host = this.hostFilter();

    return this.stacks().filter((stack) => {
      const matches =
        !term ||
        stack.name.toLowerCase().includes(term) ||
        stack.hostname.toLowerCase().includes(term);

      return matches && (host === 'all' || stack.hostId === host);
    });
  });

  protected readonly age = relativeTime;

  protected tone(stack: Stack) {
    return STACK_STATE_TONES[stackState(stack)];
  }

  protected label(stack: Stack): string {
    return STACK_STATE_LABELS[stackState(stack)];
  }

  /** From the revision that is running where there is one, else what was saved. */
  protected serviceCount(stack: Stack): string {
    const revision = stack.deployedRevision ?? stack.latestRevision;

    return revision?.summary ? String(revision.summary.services.length) : '—';
  }

  constructor() {
    /*
     * The heading belongs to whichever view is showing, and this one never
     * claimed it. Arriving here from a stack — most sharply after deleting one
     * — left the shell still naming the stack that had just been left behind.
     */
    inject(PageContext).set({ title: 'Stacks', subtitle: 'Stacks Dockplane deploys and manages' });
  }
}
