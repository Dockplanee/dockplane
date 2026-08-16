import {
  ChangeDetectionStrategy,
  ElementRef,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { catchError, of, switchMap } from 'rxjs';

import { relativeTime, timestamp } from '../../core/format';
import { PageContext } from '../../core/page-context';
import { ApiError } from '../../core/api-error';
import { Permissions } from '../../core/permissions';
import { DockplaneApi } from '../../data/dockplane-api';
import { Agent } from '../../domain/operations';
import { agentStatus } from '../../domain/status';
import { Button } from '../../ui/button';
import { ConfirmDetail, ConfirmDialog } from '../../ui/confirm-dialog/confirm-dialog';
import { EnrollmentDialog } from './enrollment-dialog';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { ErrorState } from '../../ui/error-state/error-state';
import { Icon } from '../../ui/icon/icon';
import { Panel } from '../../ui/panel/panel';
import { RowAction, RowMenu } from '../../ui/row-menu/row-menu';
import { SelectFilter } from '../../ui/select-filter/select-filter';
import { StatusBadge } from '../../ui/status-badge/status-badge';
import { TableShell } from '../../ui/table/table-shell';

/**
 * Agent administration.
 *
 * Revoking an agent is destructive: the host stops being manageable until it is
 * enrolled again. It therefore requires the agents.revoke permission and an
 * explicit confirmation that names the agent and its host.
 */
@Component({
  selector: 'dp-agent-list',
  imports: [
    Button,
    ConfirmDialog,
    EmptyState,
    EnrollmentDialog,
    ErrorState,
    Icon,
    Panel,
    RowMenu,
    SelectFilter,
    StatusBadge,
    TableShell,
  ],
  templateUrl: './agent-list.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AgentList {
  private readonly api = inject(DockplaneApi);
  private readonly permissions = inject(Permissions);
  private readonly destroyRef = inject(DestroyRef);

  private readonly revokeDialog = viewChild.required('revokeDialog', { read: ConfirmDialog });
  private readonly enrollmentDialog = viewChild.required(EnrollmentDialog);
  private readonly enrollTrigger = viewChild<ElementRef<HTMLElement>>('enrollTrigger');
  private readonly inspectDialog = viewChild.required('inspectDialog', { read: ConfirmDialog });

  protected readonly query = signal('');
  protected readonly statusFilter = signal('all');
  protected readonly selected = signal<Agent | undefined>(undefined);
  protected readonly revoking = signal(false);
  protected readonly failure = signal<
    { message: string; code?: string; requestId: string } | undefined
  >(undefined);

  /** Reloaded after a revocation, so the table reflects the server's answer. */
  private readonly reload = signal(0);

  protected readonly agents = toSignal(
    toObservable(this.reload).pipe(switchMap(() => this.api.agents())),
    { initialValue: [] },
  );

  /*
   * The fleet's version picture comes from the control server, which counts it
   * over the database rather than over whatever page the browser happens to
   * hold. A row only compares its own version with the newest one named.
   */
  private readonly fleet = toSignal(
    this.api.installedVersions().pipe(catchError(() => of(undefined))),
    { initialValue: undefined },
  );

  protected readonly newestAgentVersion = computed(() => this.fleet()?.agents?.newestVersion ?? null);

  protected isBehind(agent: Agent): boolean {
    const summary = this.fleet()?.agents;

    return Boolean(
      summary?.mixedVersions &&
        agent.version &&
        summary.newestVersion &&
        agent.version !== summary.newestVersion,
    );
  }

  protected readonly canEnroll = this.permissions.has('agents.enroll');
  protected readonly canRevoke = this.permissions.has('agents.revoke');

  protected openEnrollment(): void {
    this.enrollmentDialog().open(this.enrollTrigger()?.nativeElement);
  }

  /** Enough of the identifier to tell two agents apart; the rest is a title. */
  protected shortId(id: string): string {
    return id.slice(0, 8);
  }

  protected readonly statusOptions = [
    { value: 'all', label: 'All statuses' },
    { value: 'connected', label: 'Connected' },
    { value: 'disconnected', label: 'Disconnected' },
    { value: 'pending', label: 'Pending' },
    { value: 'revoked', label: 'Revoked' },
  ];

  protected readonly filtered = computed(() => {
    const term = this.query().trim().toLowerCase();
    const status = this.statusFilter();

    return this.agents().filter((agent) => {
      const matchesTerm =
        !term || agent.id.toLowerCase().includes(term) || agent.hostId.toLowerCase().includes(term);

      return matchesTerm && (status === 'all' || agent.status === status);
    });
  });

  protected readonly revokeDetails = computed<readonly ConfirmDetail[]>(() => {
    const agent = this.selected();

    if (!agent) {
      return [];
    }

    return [
      { label: 'Host', value: agent.hostname },
      { label: 'Agent ID', value: agent.id },
      { label: 'Enrolled', value: agent.enrolledAt ? timestamp(agent.enrolledAt) : 'Unknown' },
    ];
  });

  protected readonly inspectDetails = computed<readonly ConfirmDetail[]>(() => {
    const agent = this.selected();

    if (!agent) {
      return [];
    }

    return [
      { label: 'Host', value: agent.hostname },
      { label: 'Agent ID', value: agent.id },
      { label: 'Version', value: agent.version ?? '—' },
      { label: 'Protocol', value: `v${agent.protocolVersion}` },
      { label: 'Certificate expires', value: timestamp(agent.certificateNotAfter) },
      { label: 'Last report', value: agent.lastSeen ? timestamp(agent.lastSeen) : '—' },
    ];
  });

  protected readonly status = agentStatus;
  protected readonly age = relativeTime;

  protected actionsFor(agent: Agent): readonly RowAction[] {
    const revoked = agent.status === 'revoked';

    return [
      { id: 'inspect', label: 'Inspect agent' },
      {
        id: 'revoke',
        label: 'Revoke agent',
        destructive: true,
        disabled: revoked || !this.permissions.has('agents.revoke'),
        hint: revoked ? 'This agent is already revoked.' : 'Requires the agents.revoke permission.',
      },
    ];
  }

  protected onAction(agent: Agent, action: string): void {
    this.selected.set(agent);

    if (action === 'revoke') {
      this.revokeDialog().open();
    } else if (action === 'inspect') {
      this.inspectDialog().open();
    }
  }

  protected closeInspect(): void {
    this.inspectDialog().close();
    this.selected.set(undefined);
  }

  protected cancelRevoke(): void {
    if (!this.revoking()) {
      this.selected.set(undefined);
    }
  }

  /**
   * Revokes the selected agent.
   *
   * The server's answer is the outcome. Nothing is marked revoked optimistically
   * and the list is reloaded afterwards, so what is on screen is what the
   * registry says rather than what the interface hoped for.
   */
  protected confirmRevoke(): void {
    const agent = this.selected();

    if (!agent || this.revoking()) {
      return;
    }

    this.revoking.set(true);
    this.failure.set(undefined);

    this.api
      .revokeAgent(agent.id, 'Revoked from the Dockplane interface')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.revoking.set(false);
          this.revokeDialog().close();
          this.selected.set(undefined);
          this.reload.update((value) => value + 1);
        },
        error: (error: unknown) => {
          const problem = ApiError.from(error);

          this.revoking.set(false);
          this.revokeDialog().close();
          this.selected.set(undefined);
          this.failure.set({
            message: problem.message,
            code: problem.code,
            requestId: problem.requestId ?? '',
          });
        },
      });
  }

  constructor() {
    inject(PageContext).set({
      title: 'Agents',
      subtitle: 'Connect and manage Dockplane agents',
    });
  }
}
