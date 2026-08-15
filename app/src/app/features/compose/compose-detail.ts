import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { PageContext } from '../../core/page-context';
import { ComposeState, composeStateBadge } from '../../domain/status';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { Panel } from '../../ui/panel/panel';
import { StaleNotice } from '../../ui/stale-notice/stale-notice';
import { StatusBadge } from '../../ui/status-badge/status-badge';
import { TabBar } from '../../ui/tabs/tab-bar';
import { ComposeStore } from './compose-store';

const TABS = [
  { label: 'Overview', path: 'overview' },
  { label: 'Services', path: 'services' },
];

@Component({
  selector: 'dp-compose-detail',
  imports: [RouterOutlet, EmptyState, Panel, StaleNotice, StatusBadge, TabBar],
  template: `
    @if (store.project(); as project) {
      <header class="head">
        <div class="identity">
          <h2>{{ project.name }}</h2>
          <dp-status-badge
            [tone]="stateBadge(project).tone"
            [label]="stateBadge(project).label"
            plated
          />
        </div>

        <p class="meta">
          @for (entry of meta(); track entry) {
            <span>{{ entry }}</span>
          }
        </p>
      </header>

      @if (project.stale) {
        <dp-stale-notice
          class="stale"
          [lastSeen]="project.observedAt ?? ''"
          reason="Nothing is refreshing this project, so what is shown is the last observation."
        />
      }

      <dp-tab-bar class="tabs" [tabs]="tabs" label="Compose project sections" />

      <router-outlet />
    } @else {
      <dp-panel flush>
        <dp-empty-state
          icon="compose"
          title="Compose project not found"
          detail="This project is no longer reported by any connected host."
        />
      </dp-panel>
    }
  `,
  styles: `
    .identity {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.625rem;
    }

    h2 {
      font-family: var(--font-mono);
      font-size: 1.0625rem;
      font-weight: 600;
    }

    .meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.375rem 0.75rem;
      margin-top: 0.375rem;
      color: var(--dp-fg-muted);
      font-family: var(--font-mono);
      font-size: 0.75rem;
    }

    .meta span + span::before {
      content: '·';
      margin-right: 0.75rem;
      color: var(--dp-line-strong);
    }

    .tabs {
      margin-top: 0.875rem;
      margin-bottom: 1rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ComposeStore],
})
export class ComposeDetail {
  private readonly page = inject(PageContext);
  protected readonly store = inject(ComposeStore);

  protected readonly tabs = TABS;
  /** The state badge, told apart from a live one when the record is stale. */
  protected stateBadge(project: { state: ComposeState; stale: boolean }) {
    return composeStateBadge(project.state, project.stale);
  }

  /** Header facts. Compose file paths are deliberately not among them. */
  protected readonly meta = computed<readonly string[]>(() => {
    const project = this.store.project();

    if (!project) {
      return [];
    }

    return [
      project.hostname,
      `${project.servicesRunning} of ${project.servicesTotal} services running`,
    ];
  });

  constructor() {
    effect(() => {
      const project = this.store.project();

      this.page.set({
        title: project?.name ?? 'Compose project',
        breadcrumb: [
          { label: 'Compose', path: '/compose' },
          { label: project?.name ?? this.store.id() },
        ],
      });
    });
  }
}
