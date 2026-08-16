import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { switchMap } from 'rxjs';

import { timestamp } from '../../core/format';
import { PageContext } from '../../core/page-context';
import { DockplaneApi } from '../../data/dockplane-api';
import { AuditEntry, AuditPage } from '../../domain/operations';
import { Button } from '../../ui/button';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { Icon } from '../../ui/icon/icon';
import { Panel } from '../../ui/panel/panel';
import { SelectFilter } from '../../ui/select-filter/select-filter';
import { StatusBadge } from '../../ui/status-badge/status-badge';
import { TableShell } from '../../ui/table/table-shell';

/**
 * Security-relevant record of who did what.
 *
 * The audit log is not a copy of the operational event stream, and it never
 * carries secrets: entries reference a request ID instead of a payload.
 */
@Component({
  selector: 'dp-audit-log',
  imports: [Button, EmptyState, Icon, Panel, SelectFilter, StatusBadge, TableShell],
  template: `
    <dp-panel flush>
      <div class="dp-controls">
        <div class="dp-controls__search">
          <label class="dp-sr-only" for="audit-search">Search audit entries</label>
          <dp-icon name="search" class="dp-controls__search-icon" />
          <input
            id="audit-search"
            class="dp-field"
            type="search"
            placeholder="Search audit entries"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
          />
        </div>

        <dp-select-filter
          id="audit-result"
          label="Filter by result"
          [options]="resultOptions"
          [value]="resultFilter()"
          (valueChange)="resultFilter.set($event)"
        />
      </div>

      @if (filtered().length > 0) {
        <dp-table-shell
          [count]="filtered().length"
          [total]="entries().length"
          noun="entry"
          nounPlural="entries"
          minWidth="58rem"
        >
          <table class="dp-table">
            <caption>
              Security-relevant and infrastructure-mutating actions
            </caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col" data-priority="p1">Target</th>
                <th scope="col">Result</th>
                <th scope="col" data-priority="p2">Source</th>
                <th scope="col" data-priority="p2">Request ID</th>
              </tr>
            </thead>
            <tbody>
              @for (entry of filtered(); track entry.id) {
                <tr>
                  <th scope="row" class="shrink dp-mono">{{ at(entry.time) }}</th>
                  <td>{{ entry.actor }}</td>
                  <td class="dp-mono">{{ entry.action }}</td>
                  <td data-priority="p1" class="dp-mono dp-unknown">{{ entry.target }}</td>
                  <td>
                    <dp-status-badge
                      [tone]="entry.result === 'success' ? 'ok' : 'critical'"
                      [label]="entry.result === 'success' ? 'Success' : 'Failure'"
                    />
                  </td>
                  <td data-priority="p2" class="dp-mono dp-unknown">{{ entry.source }}</td>
                  <td data-priority="p2" class="dp-mono dp-unknown">{{ entry.requestId }}</td>
                </tr>
              }
            </tbody>
          </table>
        </dp-table-shell>

        @if (hasMore()) {
          <div class="more">
            <button dpButton variant="secondary" type="button" (click)="loadMore()">
              Load older entries
            </button>
          </div>
        }
      } @else {
        <dp-empty-state
          icon="audit"
          title="No audit entries found"
          detail="Authentication changes, role changes, enrollment and workload mutations are recorded here."
        />
      }
    </dp-panel>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuditLog {
  private readonly api = inject(DockplaneApi);

  protected readonly query = signal('');
  protected readonly resultFilter = signal('all');

  /**
   * The audit log is read a page at a time.
   *
   * The trail grows without bound, so it is never fetched whole. The server
   * returns a cursor with each page; following it appends rather than replaces,
   * because an operator scrolling back should not lose what they have read.
   */
  private readonly before = signal<string | undefined>(undefined);
  private readonly loaded = signal<readonly AuditEntry[]>([]);

  private readonly page = toSignal(
    toObservable(this.before).pipe(
      switchMap((before) => this.api.auditEntries({ limit: 50, before })),
    ),
    { initialValue: { entries: [] } as AuditPage },
  );

  protected readonly entries = computed(() => {
    const page = this.page();
    const seen = new Set(this.loaded().map((entry) => entry.id));

    return [...this.loaded(), ...page.entries.filter((entry) => !seen.has(entry.id))];
  });

  protected readonly hasMore = computed(() => Boolean(this.page().nextBefore));
  protected readonly loadingMore = signal(false);

  /** Follows the server's cursor and keeps what is already on screen. */
  protected loadMore(): void {
    const cursor = this.page().nextBefore;

    if (!cursor || this.loadingMore()) {
      return;
    }

    this.loadingMore.set(true);
    this.loaded.set(this.entries());
    this.before.set(cursor);
    this.loadingMore.set(false);
  }

  protected readonly resultOptions = [
    { value: 'all', label: 'All results' },
    { value: 'success', label: 'Success' },
    { value: 'failure', label: 'Failure' },
  ];

  protected readonly filtered = computed(() => {
    const term = this.query().trim().toLowerCase();
    const result = this.resultFilter();

    return this.entries().filter((entry: AuditEntry) => {
      const matchesTerm =
        !term ||
        entry.actor.toLowerCase().includes(term) ||
        entry.action.toLowerCase().includes(term) ||
        entry.target.toLowerCase().includes(term) ||
        (entry.requestId ?? '').toLowerCase().includes(term);

      return matchesTerm && (result === 'all' || entry.result === result);
    });
  });

  protected readonly at = timestamp;

  constructor() {
    inject(PageContext).set({
      title: 'Audit Log',
      subtitle: 'Security-relevant and infrastructure-mutating actions',
    });
  }
}
