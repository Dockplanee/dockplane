import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { catchError, combineLatest, map, of, switchMap } from 'rxjs';

import { ApiError } from '../../core/api-error';
import { InventoryRefresh } from '../../core/inventory-refresh';
import { DockplaneApi } from '../../data/dockplane-api';
import { Button } from '../../ui/button';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { PageHeader } from '../../ui/page-header/page-header';
import { Panel } from '../../ui/panel/panel';
import { ContainerForm } from './container-form';
import {
  ContainerFormModel,
  FieldProblem,
  changesBetween,
  emptyForm,
  formFrom,
  problemsIn,
  requestFrom,
} from './container-form-model';
import { OutcomeNotice } from './outcome-notice';

/**
 * Changing what a container is.
 *
 * The form starts from the configuration Dockplane holds, never from the
 * container Docker is running. The two agree until somebody changes one, and an
 * edit filled in from the second would be filled in from a container that is
 * about to be replaced.
 *
 * Applying is a replacement, because Docker cannot change a running container's
 * ports, mounts or environment. That is stated rather than implied: an operator
 * about to lose a few seconds of service should be told so before they press
 * the button, not discover it from a graph afterwards.
 */
@Component({
  selector: 'dp-container-edit',
  imports: [RouterLink, Button, ContainerForm, EmptyState, OutcomeNotice, PageHeader, Panel],
  template: `
    <dp-page-header [title]="'Edit ' + (name() || 'container')" />

    @if (unresolved(); as outcome) {
      <dp-outcome-notice
        [message]="outcome"
        heading="The result has not been confirmed"
        [containerId]="id()"
      />
    }

    @if (unavailable(); as reason) {
      <dp-panel>
        <dp-empty-state
          icon="containers"
          title="This container cannot be edited"
          [detail]="reason"
        />
        <a dpButton variant="secondary" [routerLink]="['/containers', id()]"
          >Back to the container</a
        >
      </dp-panel>
    } @else if (loaded()) {
      <div class="layout">
        <dp-panel class="form">
          <form (ngSubmit)="submit()">
            <dp-container-form
              [(model)]="form"
              mode="edit"
              [hosts]="hosts()"
              [problems]="shownProblems()"
            />

            @if (failure(); as error) {
              <p class="failure" role="alert">{{ error }}</p>
            }

            <div class="actions">
              <button type="submit" dpButton variant="primary" [disabled]="busy()">
                {{ busy() ? 'Applying…' : 'Apply changes' }}
              </button>
              <a dpButton variant="ghost" [routerLink]="['/containers', id()]">Cancel</a>
            </div>
          </form>
        </dp-panel>

        <dp-panel class="summary">
          <h3 class="summary__title">Review changes</h3>

          @if (changes().length === 0) {
            <p class="summary__empty">Nothing has been changed yet.</p>
          } @else {
            <ul class="changes">
              @for (change of changes(); track $index) {
                <li class="change" [class]="'change--' + change.kind">
                  <span class="change__mark" aria-hidden="true">{{ mark(change.kind) }}</span>
                  <span class="change__section">{{ change.section }}</span>
                  <span class="change__text">
                    <span class="dp-sr-only">{{ change.kind }}:</span>{{ change.text }}
                  </span>
                </li>
              }
            </ul>

            <!--
              Said before the button, not after. A replacement is how Docker
              applies any of this, and the interruption is real.
            -->
            <p class="recreate">
              Docker requires this container to be recreated to apply these changes. Volumes will be
              kept.
            </p>
          }
        </dp-panel>
      </div>
    }
  `,
  styleUrl: './container-create.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContainerEdit {
  private readonly api = inject(DockplaneApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly refresh = inject(InventoryRefresh);

  protected readonly form = signal<ContainerFormModel>(emptyForm());
  protected readonly busy = signal(false);
  protected readonly failure = signal<string | undefined>(undefined);
  protected readonly unresolved = signal<string | undefined>(undefined);
  protected readonly loaded = signal(false);

  private readonly submitted = signal(false);

  /** What the container was when the form was filled in, for the diff. */
  private readonly original = signal<ContainerFormModel>(emptyForm());

  protected readonly id = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? '')),
    { initialValue: '' },
  );

  protected readonly hosts = toSignal(this.api.hosts(), { initialValue: [] });

  private readonly container = toSignal(
    this.route.paramMap.pipe(switchMap((params) => this.api.container(params.get('id') ?? ''))),
    { initialValue: undefined },
  );

  /**
   * Why this container cannot be edited, when it cannot.
   *
   * The same reasons the control server refuses, checked here so an operator
   * who followed a link is told rather than shown a form that cannot be
   * submitted. The server refuses independently.
   */
  protected readonly unavailable = computed(() => {
    const container = this.container();

    if (!container) {
      return undefined;
    }

    if (container.management.identityConflict) {
      return 'More than one Docker container claims to be this one. That has to be resolved first.';
    }

    if (container.management.reconciling) {
      return 'A change to this container has not been settled yet. Dockplane is establishing what happened on its host.';
    }

    if (container.management.kind === 'stack') {
      return 'This container belongs to a Compose project, and its configuration comes from there.';
    }

    if (container.management.kind === 'external') {
      return 'Dockplane did not create this container, so its configuration is read-only.';
    }

    return undefined;
  });

  protected readonly name = computed(() => this.container()?.name ?? '');

  protected readonly changes = computed(() => changesBetween(this.original(), this.form()));

  protected readonly problems = computed(() => problemsIn(this.form(), { requireHost: false }));

  protected readonly shownProblems = computed((): readonly FieldProblem[] =>
    this.submitted() ? this.problems() : [],
  );

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

  constructor() {
    /*
     * Filled in once, when the configuration first arrives.
     *
     * Refilling on every refresh would discard what somebody is in the middle
     * of typing — and for a secret they had just entered, discard it silently.
     */
    effect(() => {
      const configuration = this.configuration();
      const container = this.container();

      if (!configuration || !container || untracked(this.loaded)) {
        return;
      }

      const model = formFrom(configuration, container.hostId);

      this.original.set(model);
      this.form.set(model);
      this.loaded.set(true);
    });
  }

  protected mark(kind: string): string {
    return kind === 'added' ? '+' : kind === 'removed' ? '−' : '~';
  }

  protected submit(): void {
    if (this.busy()) {
      return;
    }

    this.submitted.set(true);
    this.failure.set(undefined);

    if (this.problems().length > 0) {
      return;
    }

    this.busy.set(true);

    this.api
      .replaceContainer(this.id(), requestFrom(this.form(), { includeHost: false }))
      .subscribe({
        next: () => {
          // Whatever secret was typed has been sent and is not needed again.
          this.form.update((current) => ({
            ...current,
            environment: current.environment.map((row) => ({ ...row, value: '' })),
          }));

          this.busy.set(false);
          this.refresh.request();
          void this.router.navigate(['/containers', this.id()]);
        },
        error: (error: unknown) => {
          const failure = ApiError.from(error);

          this.busy.set(false);

          if (failure.code === 'OPERATION_OUTCOME_UNKNOWN') {
            this.unresolved.set(failure.message);
            this.refresh.request();

            return;
          }

          this.failure.set(failure.message);
        },
      });
  }
}
