import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';

import { ApiError } from '../../core/api-error';
import { InventoryRefresh } from '../../core/inventory-refresh';
import { DockplaneApi } from '../../data/dockplane-api';
import { Button } from '../../ui/button';
import { PageHeader } from '../../ui/page-header/page-header';
import { Panel } from '../../ui/panel/panel';
import { ContainerForm } from './container-form';
import {
  ContainerFormModel,
  FieldProblem,
  emptyForm,
  mountText,
  portText,
  problemsIn,
  requestFrom,
} from './container-form-model';
import { OutcomeNotice } from './outcome-notice';

/**
 * Creating a container.
 *
 * A page rather than a dialog: this is the longest form in the product, and a
 * dialog would put it in a box that cannot be resized on the screens where it
 * is hardest to fill in.
 *
 * The summary beside it is not decoration. A container is described in eight
 * sections and applied in one action, so what is about to be created is worth
 * seeing whole — with the secrets named and not shown.
 */
@Component({
  selector: 'dp-container-create',
  imports: [RouterLink, Button, ContainerForm, OutcomeNotice, PageHeader, Panel],
  template: `
    <dp-page-header title="Create container" />

    @if (unresolved(); as outcome) {
      <dp-outcome-notice
        [message]="outcome"
        heading="The result has not been confirmed"
        [containerId]="unresolvedContainer()"
      />
    }

    <div class="layout">
      <dp-panel class="form">
        <form (submit)="submit($event)">
          <dp-container-form
            [(model)]="form"
            mode="create"
            [hosts]="hosts()"
            [problems]="shownProblems()"
          />

          @if (failure(); as error) {
            <p class="failure" role="alert">{{ error }}</p>
          }

          <div class="actions">
            <button type="submit" dpButton variant="primary" [disabled]="busy()">
              {{ busy() ? 'Creating…' : 'Create container' }}
            </button>
            <a dpButton variant="ghost" routerLink="/containers">Cancel</a>
          </div>
        </form>
      </dp-panel>

      <dp-panel class="summary">
        <h3 class="summary__title">Summary</h3>
        <dl class="summary__list">
          <dt>Host</dt>
          <dd>{{ hostName() || 'Not chosen' }}</dd>
          <dt>Name</dt>
          <dd>{{ form().name || 'Not set' }}</dd>
          <dt>Image</dt>
          <dd class="dp-mono">{{ form().image || 'Not set' }}</dd>
          <dt>Ports</dt>
          <dd>
            @for (port of form().ports; track $index) {
              <span class="dp-mono">{{ portOf(port) }}</span>
            } @empty {
              None
            }
          </dd>
          <dt>Storage</dt>
          <dd>
            @for (mount of form().mounts; track $index) {
              <span class="dp-mono">{{ mountOf(mount) }}</span>
            } @empty {
              None
            }
          </dd>
          <dt>Environment</dt>
          <dd>
            <!-- Names only. A secret value has no business in a summary. -->
            @for (variable of form().environment; track $index) {
              <span class="dp-mono"
                >{{ variable.key }}{{ variable.secret ? ' — Secret' : '' }}</span
              >
            } @empty {
              None
            }
          </dd>
          <dt>Networks</dt>
          <dd>{{ form().networks.join(', ') || 'Docker default' }}</dd>
          <dt>Restart</dt>
          <dd>{{ form().restartPolicy }}</dd>
        </dl>
      </dp-panel>
    </div>
  `,
  styleUrl: './container-create.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContainerCreate {
  private readonly api = inject(DockplaneApi);
  private readonly router = inject(Router);
  private readonly refresh = inject(InventoryRefresh);

  protected readonly form = signal<ContainerFormModel>(emptyForm());
  protected readonly busy = signal(false);
  protected readonly failure = signal<string | undefined>(undefined);
  protected readonly unresolved = signal<string | undefined>(undefined);
  protected readonly unresolvedContainer = signal<string | undefined>(undefined);

  /** Held back until a submit, so a half-filled form is not full of complaints. */
  private readonly submitted = signal(false);

  protected readonly hosts = toSignal(this.api.hosts(), { initialValue: [] });

  protected readonly hostName = computed(
    () => this.hosts().find((host) => host.id === this.form().hostId)?.name ?? '',
  );

  protected readonly problems = computed(() => problemsIn(this.form(), { requireHost: true }));

  protected readonly shownProblems = computed((): readonly FieldProblem[] =>
    this.submitted() ? this.problems() : [],
  );

  protected readonly portOf = portText;
  protected readonly mountOf = mountText;

  protected submit(event: Event): void {
    /*
     * The browser's own submit is prevented rather than relied on. A form that
     * navigates puts every field it holds into the address bar, and one of
     * these fields is a secret.
     */
    event.preventDefault();

    if (this.busy()) {
      return;
    }

    this.submitted.set(true);
    this.failure.set(undefined);

    if (this.problems().length > 0) {
      return;
    }

    this.busy.set(true);

    this.api.createContainer(requestFrom(this.form(), { includeHost: true })).subscribe({
      next: (outcome) => {
        /*
         * The secret values in the form have been sent and are not needed
         * again. They go before anything navigates, so nothing carries them
         * into the next view.
         */
        this.form.set(emptyForm());
        this.busy.set(false);
        this.refresh.request();
        void this.router.navigate(['/containers', outcome.containerId]);
      },
      error: (error: unknown) => {
        const failure = ApiError.from(error);

        this.busy.set(false);

        /*
         * An outcome nobody knows is not a failure. The container may exist,
         * so this says so and offers no way to send the same request again.
         */
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
