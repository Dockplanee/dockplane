import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { switchMap } from 'rxjs';

import { duration, timestamp } from '../../core/format';
import { PageContext } from '../../core/page-context';
import { ActionRecord, DockplaneApi } from '../../data/dockplane-api';
import { StatusTone } from '../../domain/status';
import { Button } from '../../ui/button';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { Icon } from '../../ui/icon/icon';
import { Panel } from '../../ui/panel/panel';
import { SelectFilter } from '../../ui/select-filter/select-filter';
import { StatusBadge } from '../../ui/status-badge/status-badge';
import { TableShell } from '../../ui/table/table-shell';

const PAGE_SIZE = 50;

const OPERATION: Record<string, string> = {
  'container.start': 'Start',
  'container.stop': 'Stop',
  'container.restart': 'Restart',
};

const OUTCOME: Record<string, { tone: StatusTone; label: string }> = {
  succeeded: { tone: 'ok', label: 'Succeeded' },
  failed: { tone: 'critical', label: 'Failed' },
  timed_out: { tone: 'warn', label: 'Timed out' },
  running: { tone: 'info', label: 'Running' },
};

/**
 * What Dockplane has been asked to do to containers, and what came of it.
 *
 * Separate from the audit log on purpose: audit answers who changed what about
 * the system, this answers what happened on a host — which operation, against
 * which container, how long it took and whether it worked.
 */
@Component({
  selector: 'dp-action-history',
  imports: [Button, EmptyState, Icon, Panel, SelectFilter, StatusBadge, TableShell],
  template: `
    <dp-panel flush>
      <div class="dp-controls">
        <div class="dp-controls__search">
          <label class="dp-sr-only" for="action-search">Search actions</label>
          <dp-icon name="search" class="dp-controls__search-icon" />
          <input
            id="action-search"
            class="dp-field"
            type="search"
            placeholder="Search actions"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
          />
        </div>

        <dp-select-filter
          id="action-status"
          label="Filter by result"
          [options]="statusOptions"
          [value]="statusFilter()"
          (valueChange)="statusFilter.set($event)"
        />
      </div>

      @if (filtered().length > 0) {
        <dp-table-shell
          [count]="filtered().length"
          [total]="records().length"
          noun="action"
          nounPlural="actions"
          minWidth="62rem"
        >
          <table class="dp-table">
            <caption>
              Container operations carried out through Dockplane
            </caption>
            <thead>
              <tr>
                <th scope="col">Requested</th>
                <th scope="col">Operation</th>
                <th scope="col">Container</th>
                <th scope="col">Host</th>
                <th scope="col">Actor</th>
                <th scope="col">Result</th>
                <th scope="col" class="numeric">Duration</th>
              </tr>
            </thead>
            <tbody>
              @for (record of filtered(); track record.id) {
                <tr>
                  <th scope="row" class="shrink dp-mono">{{ at(record.requestedAt) }}</th>
                  <td>{{ operation(record.capability) }}</td>
                  <td class="dp-mono">{{ record.containerName }}</td>
                  <td class="dp-mono dp-unknown">{{ record.hostname ?? '—' }}</td>
                  <td class="dp-unknown">{{ record.actor ?? '—' }}</td>
                  <td>
                    <dp-status-badge
                      [tone]="outcome(record.status).tone"
                      [label]="outcome(record.status).label"
                    />
                    @if (record.errorCode) {
                      <span class="code dp-mono">{{ record.errorCode }}</span>
                    }
                  </td>
                  <td class="numeric dp-mono dp-unknown">{{ took(record) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </dp-table-shell>

        @if (hasMore()) {
          <div class="more">
            <button dpButton variant="secondary" type="button" (click)="loadMore()">
              Load older actions
            </button>
          </div>
        }
      } @else {
        <dp-empty-state
          icon="actions"
          title="No actions recorded"
          detail="Starting, stopping and restarting a container is recorded here, together with its result."
        />
      }
    </dp-panel>
  `,
  styles: `
    .code {
      margin-left: 0.5rem;
      color: var(--dp-fg-muted);
      font-size: 0.75rem;
    }

    .more {
      display: flex;
      justify-content: center;
      padding: 0.875rem;
      border-top: 1px solid var(--dp-line);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ActionHistory {
  private readonly api = inject(DockplaneApi);

  protected readonly query = signal('');
  protected readonly statusFilter = signal('all');

  /**
   * Read a page at a time.
   *
   * The history grows with every operation, so it is never fetched whole. A
   * further page is appended rather than swapped in, because an operator
   * reading back through the history should not lose their place.
   */
  private readonly offset = signal(0);
  private readonly loaded = signal<readonly ActionRecord[]>([]);

  private readonly page = toSignal(
    toObservable(this.offset).pipe(
      switchMap((offset) => this.api.actions({ limit: PAGE_SIZE, offset })),
    ),
    { initialValue: [] as readonly ActionRecord[] },
  );

  protected readonly records = computed(() => {
    const seen = new Set(this.loaded().map((record) => record.id));

    return [...this.loaded(), ...this.page().filter((record) => !seen.has(record.id))];
  });

  /** A full page may have more behind it; a short one is the end. */
  protected readonly hasMore = computed(() => this.page().length === PAGE_SIZE);

  protected loadMore(): void {
    if (!this.hasMore()) {
      return;
    }

    this.loaded.set(this.records());
    this.offset.update((offset) => offset + PAGE_SIZE);
  }

  protected readonly statusOptions = [
    { value: 'all', label: 'All results' },
    { value: 'succeeded', label: 'Succeeded' },
    { value: 'failed', label: 'Failed' },
    { value: 'timed_out', label: 'Timed out' },
  ];

  protected readonly filtered = computed(() => {
    const term = this.query().trim().toLowerCase();
    const status = this.statusFilter();

    return this.records().filter((record) => {
      const matchesTerm =
        !term ||
        record.containerName.toLowerCase().includes(term) ||
        (record.hostname ?? '').toLowerCase().includes(term) ||
        (record.actor ?? '').toLowerCase().includes(term) ||
        record.capability.toLowerCase().includes(term);

      return matchesTerm && (status === 'all' || record.status === status);
    });
  });

  protected readonly at = timestamp;

  protected operation(capability: string): string {
    return OPERATION[capability] ?? capability;
  }

  protected outcome(status: string): { tone: StatusTone; label: string } {
    return OUTCOME[status] ?? { tone: 'neutral', label: status };
  }

  protected took(record: ActionRecord): string {
    return duration(record.durationMs) ?? '—';
  }

  constructor() {
    inject(PageContext).set({
      title: 'Actions',
      subtitle: 'Container operations carried out through Dockplane',
    });
  }
}
