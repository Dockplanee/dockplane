import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ApiError } from '../../core/api-error';
import { DockplaneApi } from '../../data/dockplane-api';
import { EnrollmentToken } from '../../domain/operations';
import { Button } from '../../ui/button';
import { Icon } from '../../ui/icon/icon';
import { OneTimeSecret } from '../../ui/one-time-secret/one-time-secret';

/**
 * Issues an enrollment token and shows it once.
 *
 * The raw value exists in this component and nowhere else: the server stores
 * only its digest, nothing here writes it to storage or to the URL, and closing
 * the dialog drops it. A reload cannot bring it back, which is the same
 * guarantee the server makes.
 */
@Component({
  selector: 'dp-enrollment-dialog',
  imports: [Button, FormsModule, Icon, OneTimeSecret],
  templateUrl: './enrollment-dialog.html',
  styleUrl: './enrollment-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'close()' },
})
export class EnrollmentDialog implements OnDestroy {
  private readonly api = inject(DockplaneApi);

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly hostname = signal('');
  protected readonly busy = signal(false);
  protected readonly token = signal<EnrollmentToken | undefined>(undefined);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly requestId = signal<string | undefined>(undefined);

  /** Where the operator was before the dialog opened, so focus can return. */
  private opener?: HTMLElement;

  open(opener?: HTMLElement): void {
    this.opener = opener;
    this.reset();

    const element = this.dialog().nativeElement;

    /*
     * showModal is what traps focus and dims the page. Not every environment
     * implements it — a test renderer typically does not — so the element is
     * still opened there rather than the call throwing and taking the flow with
     * it.
     */
    if (typeof element.showModal === 'function') {
      element.showModal();
    } else {
      element.setAttribute('open', '');
    }
  }

  close(): void {
    const element = this.dialog().nativeElement;

    if (typeof element.close === 'function') {
      element.close();
    } else {
      element.removeAttribute('open');
    }

    this.reset();
    this.opener?.focus();
  }

  protected create(): void {
    // A dialog issues one token. Guarding on the token as well as on the
    // in-flight flag means a second submit cannot quietly mint another one and
    // leave the first unaccounted for.
    if (this.busy() || this.token()) {
      return;
    }

    this.busy.set(true);
    this.error.set(undefined);
    this.requestId.set(undefined);

    this.api.createEnrollmentToken(this.hostname().trim() || undefined).subscribe({
      next: (token) => {
        this.token.set(token);
        this.busy.set(false);
      },
      error: (error: unknown) => {
        const failure = ApiError.from(error);

        this.error.set(failure.message);
        this.requestId.set(failure.requestId);
        this.busy.set(false);
      },
    });
  }

  /**
   * The command an operator runs on the host.
   *
   * The token is piped in rather than passed as an argument: the agent has no
   * `--token` flag precisely because a command line is visible in the process
   * list and lands in the shell history.
   */
  protected command(): string {
    return `echo '<paste the token>' | sudo dockplane-agent enroll --server ${origin()} --token-stdin`;
  }

  protected expiresAt(): string {
    const token = this.token();

    return token ? new Date(token.expiresAt).toLocaleString() : '';
  }

  ngOnDestroy(): void {
    this.reset();
  }

  /** Drops everything sensitive this dialog was holding. */
  private reset(): void {
    this.token.set(undefined);
    this.hostname.set('');
    this.error.set(undefined);
    this.requestId.set(undefined);
    this.busy.set(false);
  }
}

function origin(): string {
  return typeof location === 'undefined' ? 'https://dockplane.example.com' : location.origin;
}
