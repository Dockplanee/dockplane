import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { ApiError } from '../../core/api-error';
import { Auth } from '../../core/auth.service';
import { Button } from '../../ui/button';
import { Logo } from '../../ui/logo/logo';

/** Which step of signing in is on screen. */
type Step = 'credentials' | 'second-factor';

/**
 * Sign-in.
 *
 * Nothing typed here is kept: the password is sent and dropped, and the session
 * that comes back lives in a cookie the browser manages. A failed attempt says
 * only that the credentials do not match — the server does not distinguish an
 * unknown address from a wrong password, and neither does this page.
 */
@Component({
  selector: 'dp-login',
  imports: [FormsModule, Button, Logo],
  templateUrl: './login.html',
  styleUrl: './login.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Login {
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly step = signal<Step>('credentials');
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly code = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly requestId = signal<string | undefined>(undefined);

  protected submit(): void {
    if (this.busy()) {
      return;
    }

    this.start();

    this.auth.login(this.email().trim(), this.password()).subscribe({
      next: (outcome) => {
        // The password is not needed again and is dropped either way, so it is
        // not sitting in a signal while a second factor is entered.
        this.password.set('');

        if (outcome === 'mfa-required') {
          this.step.set('second-factor');
          this.busy.set(false);
          return;
        }

        void this.complete();
      },
      error: (error: unknown) => this.fail(error),
    });
  }

  protected verify(): void {
    if (this.busy()) {
      return;
    }

    this.start();

    this.auth.verifySecondFactor(this.code()).subscribe({
      next: () => {
        this.code.set('');
        void this.complete();
      },
      error: (error: unknown) => this.fail(error),
    });
  }

  /** Returns to the credentials step, for an operator who cannot complete MFA. */
  protected restart(): void {
    this.step.set('credentials');
    this.code.set('');
    this.error.set(undefined);
  }

  private start(): void {
    this.busy.set(true);
    this.error.set(undefined);
    this.requestId.set(undefined);
  }

  /**
   * Loads the session and continues.
   *
   * Permissions are read before navigating, so the first protected view renders
   * with the operator's real authority rather than briefly with none.
   */
  private async complete(): Promise<void> {
    try {
      await this.auth.restore();

      const target = this.route.snapshot.queryParamMap.get('returnUrl');

      await this.router.navigateByUrl(target && target.startsWith('/') ? target : '/overview');
    } finally {
      this.busy.set(false);
    }
  }

  private fail(error: unknown): void {
    const failure = ApiError.from(error);

    this.busy.set(false);
    this.error.set(failure.message);
    this.requestId.set(failure.requestId);
  }
}
