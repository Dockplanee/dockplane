import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { ApiError } from '../../core/api-error';
import { DockplaneApi } from '../../data/dockplane-api';
import { CreatedHostSetup, HostSetup } from '../../domain/operations';
import { Button } from '../../ui/button';
import { Icon } from '../../ui/icon/icon';

/** How often a waiting operator's view is refreshed against the server. */
const POLL_INTERVAL = 3000;

type Step = 'name' | 'install' | 'connected';

/**
 * Adding a host.
 *
 * Three things happen here and only three: a setup is created, the command that
 * goes with it is shown once, and the server is asked what has become of it.
 * Everything the waiting view reports is something the control plane observed —
 * a token spent, a certificate issued, a connection open, an inventory
 * received. Nothing advances on a timer.
 *
 * The bootstrap ticket lives in this component and nowhere else. It is not
 * stored, not put in the URL, and not recoverable after the dialog closes; the
 * server keeps only its digest. An operator who loses it regenerates, which
 * invalidates the one they lost.
 */
@Component({
  selector: 'dp-add-host-dialog',
  imports: [Button, FormsModule, Icon],
  templateUrl: './add-host-dialog.html',
  styleUrl: './add-host-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'close()' },
})
export class AddHostDialog implements OnDestroy {
  private readonly api = inject(DockplaneApi);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly step = signal<Step>('name');
  protected readonly displayName = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly requestId = signal<string | undefined>(undefined);
  protected readonly copied = signal(false);

  protected readonly setup = signal<CreatedHostSetup | undefined>(undefined);
  protected readonly state = signal<HostSetup | undefined>(undefined);
  protected readonly now = signal(Date.now());

  private poll?: ReturnType<typeof setInterval>;
  private clock?: ReturnType<typeof setInterval>;
  private opener?: HTMLElement;

  /**
   * The command an operator runs on the new host.
   *
   * The ticket goes in the request body. It is deliberately not part of the
   * address: a URL is written down by every proxy, access log and error
   * reporter it passes, and a credential has no business in any of them. It
   * reaches curl through a shell builtin, so it is not in an argument list
   * either — the one place it can survive is the operator's own shell history,
   * which is why it dies in ten minutes and on first use.
   */
  protected readonly command = computed(() => {
    const ticket = this.setup()?.ticket;

    if (!ticket) {
      return '';
    }

    const origin = this.origin();
    const secure = origin.startsWith('https://') ? " --proto '=https' --tlsv1.2" : '';

    return (
      `printf '{"ticket":"%s"}' '${ticket}' | ` +
      `curl -fsS${secure} --data-binary @- -H 'content-type: application/json' ` +
      `${origin}/api/v1/host-setups/bootstrap | sudo bash`
    );
  });

  protected readonly expiresIn = computed(() => {
    const expiresAt = this.setup()?.expiresAt;

    if (!expiresAt) {
      return '';
    }

    const seconds = Math.floor((new Date(expiresAt).getTime() - this.now()) / 1000);

    if (seconds <= 0) {
      return 'expired';
    }

    const minutes = Math.floor(seconds / 60);

    return minutes > 0
      ? `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`
      : `${seconds} s`;
  });

  protected readonly expired = computed(() => this.expiresIn() === 'expired');

  /** Only what the server has actually seen. Nothing here is an animation. */
  protected readonly steps = computed(() => {
    const progress = this.state()?.progress;

    return [
      { label: 'Command run on the host', done: Boolean(progress?.bootstrapped) },
      { label: 'Secure identity issued', done: Boolean(progress?.enrolled) },
      { label: 'Connected to the gateway', done: Boolean(progress?.connected) },
      { label: 'Docker inventory received', done: Boolean(progress?.inventoryReported) },
    ];
  });

  ngOnDestroy(): void {
    this.stopTimers();
  }

  open(opener?: HTMLElement): void {
    this.opener = opener;
    this.reset();

    const element = this.dialog().nativeElement;

    /*
     * showModal is what traps focus and dims the page. Not every environment
     * implements it — a test renderer typically does not — so the element is
     * still opened there rather than the call throwing.
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
    if (this.busy()) {
      return;
    }

    this.busy.set(true);
    this.error.set(undefined);

    this.api.createHostSetup(this.displayName().trim() || undefined).subscribe({
      next: (setup) => {
        this.setup.set(setup);
        this.state.set(setup);
        this.step.set('install');
        this.busy.set(false);
        this.startTimers();
      },
      error: (error: unknown) => this.fail(error),
    });
  }

  protected regenerate(): void {
    const current = this.setup();

    if (this.busy() || !current) {
      return;
    }

    this.busy.set(true);
    this.error.set(undefined);

    this.api.regenerateHostSetup(current.id).subscribe({
      next: (setup) => {
        this.setup.set(setup);
        this.state.set(setup);
        this.copied.set(false);
        this.busy.set(false);
      },
      error: (error: unknown) => this.fail(error),
    });
  }

  protected cancel(): void {
    const current = this.setup();

    if (!current) {
      this.close();
      return;
    }

    this.api.cancelHostSetup(current.id).subscribe({
      next: () => this.close(),
      error: () => this.close(),
    });
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.command());
      this.copied.set(true);
    } catch {
      // Selecting the text by hand still works, and saying nothing is better
      // than claiming a copy that did not happen.
      this.copied.set(false);
    }
  }

  protected openHost(): void {
    const hostId = this.state()?.hostId;

    this.close();

    if (hostId) {
      void this.router.navigate(['/hosts', hostId]);
    }
  }

  private startTimers(): void {
    this.stopTimers();

    this.clock = setInterval(() => this.now.set(Date.now()), 1000);
    this.poll = setInterval(() => this.refresh(), POLL_INTERVAL);
    this.destroyRef.onDestroy(() => this.stopTimers());
  }

  private stopTimers(): void {
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = undefined;
    }

    if (this.clock) {
      clearInterval(this.clock);
      this.clock = undefined;
    }
  }

  private refresh(): void {
    const current = this.setup();

    if (!current) {
      return;
    }

    this.api.hostSetup(current.id).subscribe({
      next: (state) => {
        this.state.set(state);

        if (state.status === 'connected') {
          this.step.set('connected');
          this.stopTimers();
        }
      },
      // A failed poll is not worth interrupting the operator over; the next one
      // is three seconds away.
      error: () => undefined,
    });
  }

  private fail(error: unknown): void {
    this.busy.set(false);

    if (error instanceof ApiError) {
      this.error.set(error.message);
      this.requestId.set(error.requestId);
      return;
    }

    this.error.set('The request could not be completed.');
  }

  private reset(): void {
    this.stopTimers();
    this.step.set('name');
    this.displayName.set('');
    this.busy.set(false);
    this.error.set(undefined);
    this.requestId.set(undefined);
    this.copied.set(false);
    this.setup.set(undefined);
    this.state.set(undefined);
  }

  private origin(): string {
    return typeof window === 'undefined' ? '' : window.location.origin;
  }
}
