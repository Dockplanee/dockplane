import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map, switchMap, take, throwError } from 'rxjs';

import { ApiError } from '../../core/api-error';
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
  formFromConfiguration,
  problemsIn,
  validationEnvironment,
} from './stack-form-model';

/**
 * Editing a stack's configuration.
 *
 * Saving writes a new revision and changes nothing on the host. That is stated
 * on the page rather than assumed: an operator who has just edited a running
 * stack's Compose file has every reason to think they changed it.
 *
 * The revision the edit started from travels with the save. If somebody else
 * saved in the meantime the server refuses, and what is in the editor is left
 * exactly where it is — the alternative is discarding somebody's work to
 * resolve a conflict they did not know about.
 */
@Component({
  selector: 'dp-stack-edit',
  imports: [RouterLink, Button, PageHeader, Panel, StackForm, ComposeValidationPanel],
  template: `
    <dp-page-header [title]="'Edit ' + (stackName() || 'stack')" />

    @if (loadFailure(); as message) {
      <dp-panel>
        <p class="failure" role="alert">{{ message }}</p>
        <div class="actions">
          <a dpButton variant="ghost" [routerLink]="['/stacks', stackId()]">Back to stack</a>
        </div>
      </dp-panel>
    } @else {
      <div class="layout">
        <dp-panel class="form">
          <form (submit)="submit($event)">
            <dp-stack-form [(model)]="form" mode="edit" [problems]="shownProblems()" />

            @if (conflict()) {
              <p class="failure" role="alert">
                This stack changed while you were editing it. Reload the latest revision before
                saving your changes. Your edits are still here — copy anything you need before
                reloading.
              </p>
            } @else if (failure(); as error) {
              <p class="failure" role="alert">{{ error }}</p>
            }

            <div class="actions">
              <button type="submit" dpButton variant="primary" [disabled]="busy() || !loaded()">
                {{ busy() ? 'Saving…' : 'Save revision' }}
              </button>
              <a dpButton variant="ghost" [routerLink]="['/stacks', stackId()]">Cancel</a>
              @if (conflict()) {
                <a dpButton variant="secondary" [routerLink]="['/stacks', stackId(), 'edit']">
                  Reload latest revision
                </a>
              }
            </div>
          </form>
        </dp-panel>

        <dp-panel class="side">
          <h3 class="side__title">Validation</h3>

          <button
            type="button"
            dpButton
            variant="secondary"
            [disabled]="validating() || !loaded()"
            (click)="validate()"
          >
            {{ validating() ? 'Validating…' : 'Validate' }}
          </button>

          <dp-compose-validation
            class="side__result"
            [result]="validation()"
            [stale]="validationStale()"
          />

          <h3 class="side__title">Saving</h3>
          <p class="side__note">
            Saving creates a new immutable revision. It does not change the running stack — deploy
            the revision when you want it on the host.
          </p>
          <dl class="side__list">
            <dt>Editing</dt>
            <dd class="dp-mono">
              {{ baseRevisionNumber() ? '#' + baseRevisionNumber() : '—' }}
            </dd>
          </dl>
        </dp-panel>
      </div>
    }
  `,
  styleUrl: './stack-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StackEdit {
  private readonly api = inject(DockplaneApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly refresh = inject(InventoryRefresh);

  protected readonly form = signal<StackFormModel>(emptyStackForm());
  protected readonly busy = signal(false);
  protected readonly validating = signal(false);
  protected readonly failure = signal<string | undefined>(undefined);
  protected readonly loadFailure = signal<string | undefined>(undefined);
  protected readonly conflict = signal(false);
  protected readonly validation = signal<ComposeValidation | undefined>(undefined);
  protected readonly loaded = signal(false);

  private readonly validated = signal<string | undefined>(undefined);
  private readonly submitted = signal(false);

  /** The revision this edit started from, sent with the save. */
  private readonly baseRevisionId = signal('');
  protected readonly baseRevisionNumber = signal<number | undefined>(undefined);

  protected readonly stackId = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? '')),
    { initialValue: '' },
  );

  protected readonly stackName = signal('');

  protected readonly problems = computed(() => problemsIn(this.form(), { requireIdentity: false }));

  protected readonly shownProblems = computed((): readonly FieldProblem[] =>
    this.submitted() ? this.problems() : [],
  );

  protected readonly validationStale = computed(
    () => this.validated() !== undefined && this.validated() !== this.form().compose,
  );

  /**
   * The stack, and then the configuration of its newest revision.
   *
   * Two requests because they are two different things: one describes the stack
   * and is readable by anybody who may see it, the other carries the Compose
   * source and is behind the permission to change it.
   */
  constructor() {
    /*
     * Read once, when the page opens. Deliberately not re-read afterwards: an
     * edit in progress must never be replaced by a later read of the same
     * stack, which would discard what somebody had typed.
     */
    this.route.paramMap
      .pipe(
        map((params) => params.get('id') ?? ''),
        switchMap((id) => this.api.stack(id)),
        take(1),
        switchMap((stack) => {
          if (!stack?.latestRevision) {
            return throwError(() => new Error('this stack has no saved revision'));
          }

          this.stackName.set(stack.name);
          this.baseRevisionId.set(stack.latestRevision.id);
          this.baseRevisionNumber.set(stack.latestRevision.number);

          return this.api
            .stackConfiguration(stack.id, stack.latestRevision.id)
            .pipe(map((configuration) => ({ stack, configuration })));
        }),
      )
      .subscribe({
        next: ({ stack, configuration }) => {
          this.form.set(
            formFromConfiguration({
              name: stack.name,
              hostId: stack.hostId,
              compose: configuration.compose,
              environment: configuration.environment,
            }),
          );

          this.loaded.set(true);
        },
        error: (error: unknown) =>
          this.loadFailure.set(
            error instanceof Error && error.message === 'this stack has no saved revision'
              ? 'This stack has no saved revision to edit.'
              : ApiError.from(error).message,
          ),
      });
  }

  protected validate(): void {
    if (this.validating()) {
      return;
    }

    const model = this.form();

    this.validating.set(true);
    this.failure.set(undefined);

    this.api
      .validateCompose({
        projectName: this.stackName() || 'stack',
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

  protected submit(event: Event): void {
    event.preventDefault();

    if (this.busy() || !this.loaded()) {
      return;
    }

    this.submitted.set(true);
    this.failure.set(undefined);
    this.conflict.set(false);

    if (this.problems().length > 0) {
      return;
    }

    const model = this.form();

    this.busy.set(true);

    this.api
      .createStackRevision(this.stackId(), {
        baseRevisionId: this.baseRevisionId(),
        compose: model.compose,
        environment: environmentChanges(model.environment),
      })
      .subscribe({
        next: () => {
          /*
           * Any secret typed here has been sent and is not needed again. It
           * goes before anything navigates.
           */
          this.form.set(emptyStackForm());
          this.validation.set(undefined);
          this.busy.set(false);
          this.refresh.request();
          void this.router.navigate(['/stacks', this.stackId()]);
        },
        error: (error: unknown) => {
          const failure = ApiError.from(error);

          this.busy.set(false);

          if (failure.code === 'STACK_REVISION_CONFLICT') {
            this.conflict.set(true);

            return;
          }

          this.failure.set(failure.message);

          if (failure.code === 'STACK_CONFIGURATION_INVALID') {
            this.validation.set({ valid: false, errors: failure.details });
            this.validated.set(this.form().compose);
          }
        },
      });
  }
}
