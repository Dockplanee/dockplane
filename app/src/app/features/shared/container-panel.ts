import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { ApiError } from '../../core/api-error';
import { InventoryRefresh } from '../../core/inventory-refresh';
import { DockplaneApi } from '../../data/dockplane-api';
import { Container } from '../../domain/inventory';
import { ConfirmDialog, ConfirmDetail } from '../../ui/confirm-dialog/confirm-dialog';
import { ErrorState } from '../../ui/error-state/error-state';
import { ContainerActionRequest, ContainerTable } from './container-table';

type Lifecycle = 'start' | 'stop' | 'restart';

interface PendingAction {
  readonly container: Container;
  readonly action: Lifecycle;
}

interface ActionFailure {
  readonly message: string;
  readonly code?: string;
  readonly requestId: string;
}

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

/**
 * Container table together with confirmation and result handling for the
 * lifecycle actions, so every view that operates containers behaves the same.
 */
@Component({
  selector: 'dp-container-panel',
  imports: [ConfirmDialog, ContainerTable, ErrorState],
  template: `
    @if (failure(); as error) {
      <dp-error-state
        class="failure"
        [message]="error.message"
        [code]="error.code"
        [requestId]="error.requestId"
      />
    }

    <!--
      The message is the live region rather than a copy of one, so a screen
      reader announces the result once.
    -->
    <p class="outcome" role="status" aria-live="polite" [class.outcome--empty]="!outcome()">
      {{ outcome() ?? '' }}
    </p>

    <dp-container-table
      [containers]="containers()"
      [total]="total()"
      [showHost]="showHost()"
      [emptyTitle]="emptyTitle()"
      [emptyDetail]="emptyDetail()"
      (actionRequested)="request($event)"
    />

    <dp-confirm-dialog
      [heading]="heading()"
      [description]="description()"
      [confirmLabel]="confirmLabel()"
      [details]="details()"
      [pending]="running()"
      (confirmed)="confirm()"
      (dismissed)="dismiss()"
    />
  `,
  styles: `
    :host {
      display: block;
    }

    .failure {
      margin: 1rem;
    }

    .outcome {
      margin: 1rem 1rem 0;
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--dp-line);
      border-left: 3px solid var(--dp-status-ok);
      border-radius: var(--dp-radius-md);
      background-color: var(--dp-surface);
      color: var(--dp-fg-muted);
      font-size: 0.8125rem;
    }

    /*
     * The region stays in the document whether or not it has something to say.
     * A live region inserted at the moment it gains text is announced
     * unreliably, so it collapses to nothing instead of being removed.
     */
    .outcome--empty {
      margin: 0;
      padding: 0;
      border: 0;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContainerPanel {
  private readonly api = inject(DockplaneApi);
  private readonly refresh = inject(InventoryRefresh);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog = viewChild.required(ConfirmDialog);

  readonly containers = input.required<readonly Container[]>();
  readonly total = input<number>();
  readonly showHost = input(true);
  readonly emptyTitle = input('No containers found');
  readonly emptyDetail = input('No container matches the current search and filters.');

  protected readonly running = signal(false);
  protected readonly failure = signal<ActionFailure | undefined>(undefined);

  /** Announced after a completed operation, so the result is not silent. */
  protected readonly outcome = signal<string | undefined>(undefined);

  private readonly pending = signal<PendingAction | undefined>(undefined);

  protected readonly heading = computed(() => {
    const target = this.pending();
    return target ? `${COPY[target.action].verb} ${target.container.name}?` : 'Confirm action';
  });

  protected readonly description = computed(() => {
    const target = this.pending();
    return target ? COPY[target.action].consequence : '';
  });

  protected readonly confirmLabel = computed(() => {
    const target = this.pending();
    return target ? `${COPY[target.action].verb} container` : 'Confirm';
  });

  protected readonly details = computed<readonly ConfirmDetail[]>(() => {
    const target = this.pending();

    if (!target) {
      return [];
    }

    return [
      { label: 'Container', value: target.container.name },
      { label: 'Host', value: target.container.hostname },
      { label: 'Image', value: target.container.image },
    ];
  });

  protected request(request: ContainerActionRequest): void {
    this.failure.set(undefined);
    this.outcome.set(undefined);
    this.pending.set({ container: request.container, action: request.action });
    this.dialog().open();
  }

  /**
   * Carries the operation out.
   *
   * Nothing is set optimistically. The row keeps showing what discovery last
   * reported until the inventory has been read again, so the table never claims
   * a state the host has not confirmed.
   */
  protected confirm(): void {
    const target = this.pending();

    if (!target || this.running()) {
      return;
    }

    this.running.set(true);
    this.failure.set(undefined);

    this.api
      .runContainerOperation(target.action, target.container.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          this.settle();

          if (result.status === 'timed_out') {
            this.failure.set({
              message:
                'The host did not answer in time. The operation may still have been carried out; the table shows what was observed afterwards.',
              code: result.errorCode ?? 'AGENT_REQUEST_TIMEOUT',
              requestId: result.actionId,
            });
          } else {
            this.outcome.set(`${target.container.name} was ${past(target.action)}.`);
          }

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
}

function past(action: Lifecycle): string {
  return action === 'stop' ? 'stopped' : action === 'start' ? 'started' : 'restarted';
}
