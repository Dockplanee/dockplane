import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';

import { ApiError } from '../../core/api-error';
import { HasUnsavedChanges } from '../../core/guards';
import { InventoryRefresh } from '../../core/inventory-refresh';
import { ComposeValidation, DockplaneApi } from '../../data/dockplane-api';
import { Button } from '../../ui/button';
import { PageHeader } from '../../ui/page-header/page-header';
import { Panel } from '../../ui/panel/panel';
import { ComposeValidationPanel } from './compose-validation';
import { StackForm } from './stack-form';
import {
  FieldProblem,
  StackFormModel,
  emptyStackForm,
  environmentChanges,
  problemsIn,
  validationEnvironment,
} from './stack-form-model';

/**
 * Creating a stack.
 *
 * A page rather than a dialog: a stack is a Compose file, and a Compose file
 * needs room. The panel beside it is where the compiler's answer goes, because
 * checking the file and reading what is wrong with it are the same activity as
 * writing it.
 *
 * Creating a stack does not deploy it. Saving writes a revision down; putting it
 * on a host is a separate, deliberate action, and the two are not combined into
 * one button — the whole security model of this product lives in that
 * separation.
 */
@Component({
  selector: 'dp-stack-create',
  imports: [RouterLink, Button, PageHeader, Panel, StackForm, ComposeValidationPanel],
  template: `
    <dp-page-header title="Create stack" />

    <div class="layout">
      <dp-panel class="form">
        <form (submit)="submit($event)">
          <dp-stack-form
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
              {{ busy() ? 'Saving…' : 'Create stack' }}
            </button>
            <a dpButton variant="ghost" routerLink="/stacks">Cancel</a>
          </div>
        </form>
      </dp-panel>

      <dp-panel class="side">
        <h3 class="side__title">Validation</h3>

        <button
          type="button"
          dpButton
          variant="secondary"
          [disabled]="validating()"
          (click)="validate()"
        >
          {{ validating() ? 'Validating…' : 'Validate' }}
        </button>

        <dp-compose-validation
          class="side__result"
          [result]="validation()"
          [stale]="validationStale()"
        />

        <h3 class="side__title">Summary</h3>
        <dl class="side__list">
          <dt>Host</dt>
          <dd>{{ hostName() || 'Not chosen' }}</dd>
          <dt>Name</dt>
          <dd class="dp-mono">{{ form().name || 'Not set' }}</dd>
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
        </dl>

        <p class="side__note">
          Saving creates the stack and its first revision. It does not deploy anything.
        </p>
      </dp-panel>
    </div>
  `,
  styleUrl: './stack-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StackCreate implements HasUnsavedChanges {
  private readonly api = inject(DockplaneApi);
  private readonly router = inject(Router);
  private readonly refresh = inject(InventoryRefresh);

  protected readonly form = signal<StackFormModel>(emptyStackForm());
  protected readonly busy = signal(false);
  protected readonly validating = signal(false);
  protected readonly failure = signal<string | undefined>(undefined);
  protected readonly validation = signal<ComposeValidation | undefined>(undefined);

  /** The source as it was when the compiler last saw it. */
  private readonly validated = signal<string | undefined>(undefined);

  private readonly submitted = signal(false);

  /** Set once the stack has been written down, so leaving asks nothing. */
  private readonly saved = signal(false);

  protected readonly hosts = toSignal(this.api.hosts(), { initialValue: [] });

  protected readonly hostName = computed(
    () => this.hosts().find((host) => host.id === this.form().hostId)?.name ?? '',
  );

  protected readonly problems = computed(() => problemsIn(this.form(), { requireIdentity: true }));

  protected readonly shownProblems = computed((): readonly FieldProblem[] =>
    this.submitted() ? this.problems() : [],
  );

  /**
   * Whether the file has changed since it was checked.
   *
   * A successful validation is not a permit. The server compiles the file again
   * when it is saved, and an interface that treated an old answer as current
   * would be telling somebody their edit was approved when nothing looked at it.
   */
  protected readonly validationStale = computed(
    () => this.validated() !== undefined && this.validated() !== this.form().compose,
  );

  protected validate(): void {
    if (this.validating()) {
      return;
    }

    const model = this.form();

    this.validating.set(true);
    this.failure.set(undefined);

    this.api
      .validateCompose({
        // The compiler resolves names against the project, so it is given the
        // one this stack will have.
        projectName: model.name.trim() || 'stack',
        compose: model.compose,
        environment: validationEnvironment(model.environment),
      })
      .subscribe({
        next: (result) => {
          this.validation.set(result);
          this.validated.set(model.compose);
          this.validating.set(false);
        },
        error: (error: unknown) => {
          this.validating.set(false);
          this.failure.set(ApiError.from(error).message);
        },
      });
  }

  /**
   * Whether leaving would lose something.
   *
   * Compared against a fresh form rather than tracked with a flag: what matters
   * is that there is content, not that a keystroke happened. The form is
   * emptied on a successful save, so navigating afterwards asks nothing.
   */
  hasUnsavedChanges(): boolean {
    if (this.saved()) {
      return false;
    }

    const model = this.form();
    const untouched = emptyStackForm();

    return (
      model.name.trim() !== '' ||
      model.compose !== untouched.compose ||
      model.environment.length > 0
    );
  }

  protected submit(event: Event): void {
    /*
     * The browser's own submit is prevented rather than relied on. A form that
     * navigates puts every field it holds into the address bar, and these
     * fields are a Compose file and its secrets.
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

    const model = this.form();

    this.busy.set(true);

    this.api
      .createStack({
        name: model.name.trim(),
        hostId: model.hostId,
        compose: model.compose,
        environment: environmentChanges(model.environment),
      })
      .subscribe({
        next: (saved) => {
          /*
           * The secrets in the form have been sent and are not needed again.
           * They go before anything navigates, so nothing carries them into the
           * next view.
           */
          this.form.set(emptyStackForm());
          this.saved.set(true);
          this.validation.set(undefined);
          this.busy.set(false);
          this.refresh.request();
          void this.router.navigate(['/stacks', saved.stackId]);
        },
        error: (error: unknown) => {
          const failure = ApiError.from(error);

          this.busy.set(false);
          this.failure.set(failure.message);

          /*
           * The compiler's own reasons, when the server refused the file. They
           * are shown where the other validation problems are rather than as a
           * sentence with no path in it.
           */
          if (failure.code === 'STACK_CONFIGURATION_INVALID') {
            this.validation.set({ valid: false, errors: failure.details });
            this.validated.set(this.form().compose);
          }
        },
      });
  }
}
