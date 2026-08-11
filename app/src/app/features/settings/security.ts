import { ChangeDetectionStrategy, Component, OnDestroy, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { DestroyRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { switchMap } from 'rxjs';

import { ApiError } from '../../core/api-error';
import { Auth } from '../../core/auth.service';
import { relativeTime, timestamp } from '../../core/format';
import { Session } from '../../core/session';
import { DockplaneApi, MfaSetup } from '../../data/dockplane-api';
import { Button } from '../../ui/button';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { ErrorState } from '../../ui/error-state/error-state';
import { Icon } from '../../ui/icon/icon';
import { OneTimeSecret } from '../../ui/one-time-secret/one-time-secret';
import { Panel } from '../../ui/panel/panel';
import { StatusBadge } from '../../ui/status-badge/status-badge';
import { TableShell } from '../../ui/table/table-shell';

/** Which step of second-factor management is on screen. */
type MfaStep = 'idle' | 'setup' | 'confirming' | 'codes' | 'disabling' | 'regenerating';

/**
 * The operator's own security settings.
 *
 * Second factor and sessions, both against real endpoints. The secret and the
 * recovery codes exist here for as long as they are on screen: nothing is
 * written to storage, and leaving the page drops them, because the server will
 * not show either again.
 */
@Component({
  selector: 'dp-security',
  imports: [
    Button,
    EmptyState,
    ErrorState,
    FormsModule,
    Icon,
    OneTimeSecret,
    Panel,
    StatusBadge,
    TableShell,
  ],
  templateUrl: './security.html',
  styleUrl: './security.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Security implements OnDestroy {
  private readonly api = inject(DockplaneApi);
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly session = inject(Session);

  private readonly reloadSessions = signal(0);

  protected readonly sessions = toSignal(
    toObservable(this.reloadSessions).pipe(switchMap(() => this.api.sessions())),
    { initialValue: [] },
  );

  protected readonly step = signal<MfaStep>('idle');
  protected readonly setup = signal<MfaSetup | undefined>(undefined);
  protected readonly recoveryCodes = signal<readonly string[]>([]);
  protected readonly code = signal('');
  protected readonly busy = signal(false);
  protected readonly failure = signal<ApiError | undefined>(undefined);
  protected readonly revoking = signal<string | undefined>(undefined);

  protected readonly age = relativeTime;
  protected readonly at = timestamp;

  protected beginSetup(): void {
    this.start('setup');

    this.api
      .beginMfaSetup()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (setup) => {
          this.setup.set(setup);
          this.busy.set(false);
        },
        error: (error: unknown) => this.fail(error, 'idle'),
      });
  }

  protected confirmSetup(): void {
    if (this.busy()) {
      return;
    }

    this.busy.set(true);
    this.failure.set(undefined);

    this.api
      .confirmMfa(this.code())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (codes) => {
          // The secret has done its job and is dropped before the codes appear.
          this.setup.set(undefined);
          this.code.set('');
          this.recoveryCodes.set(codes);
          this.step.set('codes');
          this.busy.set(false);

          void this.auth.restore();
        },
        error: (error: unknown) => this.fail(error, 'setup'),
      });
  }

  protected askToDisable(): void {
    this.start('disabling');
    this.busy.set(false);
  }

  protected confirmDisable(): void {
    if (this.busy()) {
      return;
    }

    this.busy.set(true);
    this.failure.set(undefined);

    this.api
      .disableMfa(this.code())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.code.set('');
          this.busy.set(false);
          this.step.set('idle');

          /*
           * The server revokes every session when the factor is removed, this
           * one included. Reloading tells the interface what actually happened
           * rather than leaving it showing an account state that no longer holds.
           */
          void this.auth.restore().then(() => {
            if (!this.session.isAuthenticated()) {
              void this.router.navigate(['/login']);
            }
          });
        },
        error: (error: unknown) => this.fail(error, 'disabling'),
      });
  }

  protected askToRegenerate(): void {
    this.start('regenerating');
    this.busy.set(false);
  }

  protected confirmRegenerate(): void {
    if (this.busy()) {
      return;
    }

    this.busy.set(true);
    this.failure.set(undefined);

    this.api
      .regenerateRecoveryCodes(this.code())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (codes) => {
          this.code.set('');
          this.recoveryCodes.set(codes);
          this.step.set('codes');
          this.busy.set(false);

          void this.auth.restore();
        },
        error: (error: unknown) => this.fail(error, 'regenerating'),
      });
  }

  /** Leaves the one-time view, dropping what it was holding. */
  protected done(): void {
    this.recoveryCodes.set([]);
    this.setup.set(undefined);
    this.code.set('');
    this.step.set('idle');
  }

  protected cancel(): void {
    this.done();
    this.failure.set(undefined);
  }

  /**
   * Revokes a session.
   *
   * Revoking the current one ends this browser's access, so the interface
   * follows the server rather than pretending the page is still usable.
   */
  protected revoke(id: string, current: boolean): void {
    if (this.revoking()) {
      return;
    }

    this.revoking.set(id);
    this.failure.set(undefined);

    this.api
      .revokeSession(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.revoking.set(undefined);

          if (current) {
            void this.auth.logout().subscribe(() => this.router.navigate(['/login']));
            return;
          }

          this.reloadSessions.update((value) => value + 1);
        },
        error: (error: unknown) => {
          this.revoking.set(undefined);
          this.failure.set(ApiError.from(error));
        },
      });
  }

  ngOnDestroy(): void {
    // Nothing sensitive outlives the view.
    this.recoveryCodes.set([]);
    this.setup.set(undefined);
    this.code.set('');
  }

  private start(step: MfaStep): void {
    this.step.set(step);
    this.busy.set(true);
    this.failure.set(undefined);
    this.code.set('');
    this.recoveryCodes.set([]);
  }

  private fail(error: unknown, step: MfaStep): void {
    this.failure.set(ApiError.from(error));
    this.busy.set(false);
    this.step.set(step);
  }
}
