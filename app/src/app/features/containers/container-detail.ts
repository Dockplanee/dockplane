import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink, RouterOutlet } from '@angular/router';
import { catchError, combineLatest, of, switchMap } from 'rxjs';

import { ApiError } from '../../core/api-error';
import { InventoryRefresh } from '../../core/inventory-refresh';
import { PageContext } from '../../core/page-context';
import { Permission, Permissions } from '../../core/permissions';
import { DockplaneApi } from '../../data/dockplane-api';
import { Container } from '../../domain/inventory';
import {
  containerHealth,
  containerState,
  containerStateBadge,
  isReporting,
} from '../../domain/status';
import { Button } from '../../ui/button';
import { ConfirmDetail, ConfirmDialog } from '../../ui/confirm-dialog/confirm-dialog';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { ErrorState } from '../../ui/error-state/error-state';
import { Icon } from '../../ui/icon/icon';
import { Panel } from '../../ui/panel/panel';
import { StaleNotice } from '../../ui/stale-notice/stale-notice';
import { StatusBadge } from '../../ui/status-badge/status-badge';
import { ManagementBadge } from '../shared/management-badge';
import { TabBar } from '../../ui/tabs/tab-bar';
import { ContainerStore } from './container-store';

type Lifecycle = 'start' | 'stop' | 'restart';

const TABS = [
  { label: 'Overview', path: 'overview' },
  { label: 'Logs', path: 'logs' },
  { label: 'Configuration', path: 'configuration' },
  { label: 'Networks', path: 'networks' },
  { label: 'Volumes', path: 'volumes' },
];

const COPY: Record<Lifecycle, { verb: string; consequence: string }> = {
  start: { verb: 'Start', consequence: 'The container will be started on its host.' },
  stop: {
    verb: 'Stop',
    consequence: 'The workload becomes unavailable until it is started again.',
  },
  restart: {
    verb: 'Restart',
    consequence: 'The workload is briefly unavailable, usually for a few seconds.',
  },
};

@Component({
  selector: 'dp-container-detail',
  imports: [
    RouterLink,
    RouterOutlet,
    Button,
    ConfirmDialog,
    EmptyState,
    ErrorState,
    Icon,
    ManagementBadge,
    Panel,
    StaleNotice,
    StatusBadge,
    TabBar,
  ],
  templateUrl: './container-detail.html',
  styleUrl: './container-detail.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ContainerStore],
})
export class ContainerDetail {
  private readonly api = inject(DockplaneApi);
  private readonly page = inject(PageContext);
  private readonly permissions = inject(Permissions);
  private readonly refresh = inject(InventoryRefresh);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /**
   * The configuration this container is meant to have.
   *
   * Read only so the removal dialog can name the volumes it keeps. A container
   * Dockplane did not build has none, and the read fails harmlessly.
   */
  private readonly configuration = toSignal(
    combineLatest([this.route.paramMap, this.refresh.changes]).pipe(
      switchMap(([params]) =>
        this.api
          .containerConfiguration(params.get('id') ?? '')
          .pipe(catchError(() => of(undefined))),
      ),
    ),
    { initialValue: undefined },
  );
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog = viewChild.required(ConfirmDialog);
  /*
   * Found by name rather than by type. Both dialogs on this page are the same
   * component, and a query by type would answer with whichever is first.
   */
  private readonly removeDialog = viewChild.required('removeDialog', { read: ConfirmDialog });

  protected readonly store = inject(ContainerStore);
  protected readonly tabs = TABS;
  protected readonly state = containerState;

  /** The state badge, told apart from a live one when the record is stale. */
  protected stateBadge(container: Container) {
    return containerStateBadge(container.state, container.stale);
  }
  protected readonly health = containerHealth;

  protected readonly running = signal(false);
  protected readonly failure = signal<
    { message: string; code?: string; requestId: string } | undefined
  >(undefined);

  private readonly pending = signal<Lifecycle | undefined>(undefined);

  /** Announced after a successful operation, then cleared by the next one. */
  protected readonly outcome = signal<string | undefined>(undefined);

  protected readonly isRunning = computed(() => {
    const state = this.store.container()?.state;
    return state === 'running' || state === 'restarting';
  });

  /**
   * An action is offered only when it can actually be carried out.
   *
   * Four things have to hold: the operator holds the permission, the container
   * is in a state the operation applies to, the host can be reached, and no
   * other operation is running on this container. An enabled control missing
   * any of them would promise something the control server refuses.
   *
   * This is what the interface offers, not what is allowed. The control server
   * authorizes every request again, and a request made anyway is refused there.
   */
  private readonly reachable = computed(() => {
    const host = this.store.host();

    // An archived host is not a target for new work, whatever its agent is
    // doing. The control server refuses the same request again.
    return host ? isReporting(host.status) && !host.archived : false;
  });

  /**
   * Whether the container is one anything may be done to at all.
   *
   * Separate from permissions and from state. A container two Docker containers
   * claim is one nobody can identify, and a container whose last change has not
   * been settled is one no operation has a defined meaning for — the control
   * server refuses both, whoever is asking.
   */
  protected readonly undetermined = computed(() => {
    const management = this.store.container()?.management;

    if (management?.identityConflict) {
      return 'More than one Docker container claims this one, so nothing may be done to it.';
    }

    if (management?.reconciling) {
      return 'A change to this container has not been settled yet.';
    }

    return '';
  });

  private readonly ready = computed(
    () => this.reachable() && !this.running() && !this.undetermined(),
  );

  protected readonly canStart = computed(
    () => !this.isRunning() && this.permissions.has('containers.start') && this.ready(),
  );
  protected readonly canStop = computed(
    () => this.isRunning() && this.permissions.has('containers.stop') && this.ready(),
  );
  protected readonly canRestart = computed(
    () => this.isRunning() && this.permissions.has('containers.restart') && this.ready(),
  );

  /** Why a control is disabled, so an operator is not left guessing. */
  protected readonly startHint = computed(() => this.hint('start', 'containers.start'));
  protected readonly stopHint = computed(() => this.hint('stop', 'containers.stop'));
  protected readonly restartHint = computed(() => this.hint('restart', 'containers.restart'));

  /**
   * What kind of container this is, said plainly.
   *
   * Ordered by what stops an operator soonest. A conflict or an unsettled
   * change blocks every operation, so it outranks where the configuration comes
   * from; an external container is next, because nothing on this page will
   * change it; and a stack container explains where to look instead.
   */
  protected readonly notice = computed((): DetailNotice | undefined => {
    const container = this.store.container();

    if (!container) {
      return undefined;
    }

    if (container.management.identityConflict) {
      return {
        severity: 'warning',
        title: 'Container identity conflict',
        detail:
          'More than one Docker container claims this Dockplane container. Operations are blocked until somebody resolves which one is the real container; nothing will be removed in the meantime.',
      };
    }

    if (container.management.reconciling) {
      return {
        severity: 'warning',
        title: 'Reconciling',
        detail:
          'A change to this container has not been confirmed yet. Dockplane is establishing what happened from its host and will not repeat the operation. Further changes are blocked until it has.',
      };
    }

    if (container.management.kind === 'stack') {
      const project = container.composeProjectName;

      return {
        severity: 'info',
        title: project ? `Managed by stack ${project}` : 'Managed by a stack',
        detail:
          'Its configuration is controlled by the Compose project it belongs to and cannot be changed here.',
        link: container.composeProjectId
          ? { label: 'View project', path: ['/compose', container.composeProjectId] }
          : undefined,
      };
    }

    if (container.management.kind === 'external') {
      return {
        severity: 'info',
        title: 'Externally managed',
        detail:
          'This container was discovered on the Docker host and was not created by Dockplane. Its configuration is read-only here.',
      };
    }

    return undefined;
  });

  /**
   * Whether the interface offers to change or remove this container.
   *
   * Only for containers Dockplane built. An external one has no configuration
   * to edit, and inventing one from what can be observed would mean guessing at
   * somebody else's workload — the environment is deliberately not observable.
   */
  protected readonly canEdit = computed(
    () =>
      this.permissions.has('containers.update') &&
      this.store.container()?.management.kind === 'managed',
  );

  protected readonly canDelete = computed(
    () =>
      this.permissions.has('containers.delete') &&
      this.store.container()?.management.kind === 'managed',
  );

  protected readonly removing = signal(false);

  /**
   * The volumes a removal keeps.
   *
   * Listed by name because "volumes will be kept" is easier to believe when the
   * volumes are named. Read from the configuration Dockplane holds, which is
   * the only place a managed container's named volumes are recorded.
   */
  protected readonly removalDetails = computed((): readonly ConfirmDetail[] => {
    const volumes = (this.configuration()?.mounts ?? [])
      .filter((mount) => mount.type === 'volume')
      .map((mount) => mount.source);

    return volumes.length > 0
      ? volumes.map((volume) => ({ label: 'Volume kept', value: volume }))
      : [];
  });

  protected askToRemove(): void {
    this.removeDialog().open();
  }

  protected dismissRemoval(): void {
    this.removing.set(false);
  }

  /**
   * Removes the container.
   *
   * An outcome the server could not confirm is not treated as a removal: the
   * container stays where it is and the page is reloaded, because Dockplane is
   * about to establish what happened from the host and removing the row first
   * would be showing an operator something nobody knows.
   */
  protected remove(): void {
    if (this.removing()) {
      return;
    }

    const container = this.store.container();

    if (!container) {
      return;
    }

    this.removing.set(true);

    this.api.removeContainer(container.id, { stopFirst: true }).subscribe({
      next: () => {
        this.removing.set(false);
        this.refresh.request();
        void this.router.navigate(['/containers']);
      },
      error: (error: unknown) => {
        const failure = ApiError.from(error);

        this.removing.set(false);
        this.failure.set({
          message: failure.message,
          code: failure.code,
          requestId: failure.requestId ?? '',
        });

        this.refresh.request();
      },
    });
  }

  protected readonly heading = computed(() => {
    const action = this.pending();
    const name = this.store.container()?.name ?? '';
    return action ? `${COPY[action].verb} ${name}?` : 'Confirm action';
  });

  protected readonly description = computed(() => {
    const action = this.pending();
    return action ? COPY[action].consequence : '';
  });

  protected readonly confirmLabel = computed(() => {
    const action = this.pending();
    return action ? `${COPY[action].verb} container` : 'Confirm';
  });

  protected readonly details = computed<readonly ConfirmDetail[]>(() => {
    const container = this.store.container();

    if (!container) {
      return [];
    }

    return [
      { label: 'Container', value: container.name },
      { label: 'Host', value: container.hostname },
      { label: 'Image', value: container.image },
    ];
  });

  constructor() {
    effect(() => {
      const container = this.store.container();

      this.page.set({
        title: container?.name ?? 'Container',
        breadcrumb: [
          { label: 'Containers', path: '/containers' },
          { label: container?.name ?? this.store.id() },
        ],
      });
    });
  }

  protected request(action: Lifecycle): void {
    this.failure.set(undefined);
    this.outcome.set(undefined);
    this.pending.set(action);
    this.dialog().open();
  }

  /**
   * Carries out the operation.
   *
   * The server's answer decides what is shown. Nothing is set optimistically:
   * a start that returned does not mean the container is running, and the
   * response carries the state the host was observed in afterwards.
   */
  protected confirm(): void {
    const action = this.pending();
    const container = this.store.container();

    if (!action || !container || this.running()) {
      return;
    }

    this.running.set(true);
    this.failure.set(undefined);

    this.api
      .runContainerOperation(action, container.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          this.settle();

          if (result.status === 'timed_out') {
            this.failure.set({
              message:
                'The host did not answer in time. The operation may still have been carried out; what is shown below is what was observed afterwards.',
              code: result.errorCode ?? 'AGENT_REQUEST_TIMEOUT',
              requestId: result.actionId,
            });
          } else {
            this.outcome.set(`${container.name} was ${past(action)}.`);
          }

          /*
           * The container is read again rather than assumed. A start that was
           * accepted is not a container that is running, and the rest of the
           * interface shows what discovery reports, not what was asked for.
           */
          this.refresh.request();
        },
        error: (error: unknown) => {
          const problem = ApiError.from(error);

          this.settle();
          this.failure.set({
            message: problem.message,
            code: problem.code,
            requestId: problem.requestId ?? '',
          });

          // A refusal still says something about the container — it may already
          // be running, or its host may have gone quiet since the page loaded.
          this.refresh.request();
        },
      });
  }

  protected dismiss(): void {
    if (!this.running()) {
      this.pending.set(undefined);
    }
  }

  private settle(): void {
    this.running.set(false);
    this.pending.set(undefined);
    this.dialog().close();
  }

  private hint(action: Lifecycle, permission: Permission): string {
    if (!this.permissions.has(permission)) {
      return `Requires the ${permission} permission.`;
    }

    if (this.undetermined()) {
      return this.undetermined();
    }

    if (action === 'start' ? this.isRunning() : !this.isRunning()) {
      return action === 'start'
        ? 'The container is already running.'
        : 'The container is not running.';
    }

    if (!this.reachable()) {
      return 'The host is not reachable, so nothing can be carried out on it now.';
    }

    return this.running() ? 'Another operation is running on this container.' : '';
  }
}

/** A short statement about the container, with somewhere to go if there is one. */
interface DetailNotice {
  readonly severity: 'info' | 'warning';
  readonly title: string;
  readonly detail: string;
  readonly link?: { readonly label: string; readonly path: readonly unknown[] };
}

function past(action: Lifecycle): string {
  return action === 'stop' ? 'stopped' : action === 'start' ? 'started' : 'restarted';
}
