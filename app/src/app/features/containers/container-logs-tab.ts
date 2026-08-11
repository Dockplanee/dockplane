import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';

import { ApiError, messageForCode } from '../../core/api-error';
import { clockTime, timestamp } from '../../core/format';
import { Permissions } from '../../core/permissions';
import { DockplaneApi, LogEvent, LogLine } from '../../data/dockplane-api';
import { isReporting } from '../../domain/status';
import { Button } from '../../ui/button';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { ErrorState } from '../../ui/error-state/error-state';
import { Icon } from '../../ui/icon/icon';
import { Panel } from '../../ui/panel/panel';
import { ContainerStore } from './container-store';

/**
 * How many lines the view keeps.
 *
 * A container can print faster than anyone can read for as long as it likes, so
 * the view holds a window rather than a history. What falls out of it is said
 * plainly: a viewer that quietly forgets is worse than one that admits it.
 */
const MAX_LINES = 5000;

/** How many lines may pile up while the view is paused before the oldest go. */
const MAX_PAUSED = 2000;

/** One line as the view holds it, numbered so a filter can keep its place. */
interface ViewLine extends LogLine {
  readonly seq: number;
}

/**
 * Container logs.
 *
 * A viewer, not a console. It shows what a container printed and offers no way
 * to send anything back — there is no input, no prompt and no shell: the
 * control server has no route that would carry one and the agent has no
 * capability that would accept one.
 */
@Component({
  selector: 'dp-container-logs-tab',
  imports: [Button, EmptyState, ErrorState, Icon, Panel],
  templateUrl: './container-logs-tab.html',
  styleUrl: './container-logs-tab.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContainerLogsTab {
  private readonly api = inject(DockplaneApi);
  private readonly permissions = inject(Permissions);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly store = inject(ContainerStore);

  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');

  /** Whether this operator may read logs at all. The server decides again. */
  protected readonly permitted = this.permissions.has('containers.logs');

  protected readonly connected = signal(false);
  protected readonly connecting = signal(false);
  protected readonly paused = signal(false);
  protected readonly wrap = signal(false);
  protected readonly autoscroll = signal(true);
  protected readonly query = signal('');
  protected readonly copied = signal(false);

  protected readonly failure = signal<{ message: string; code?: string } | undefined>(undefined);
  /** Why the stream ended, when it ended for a reason worth naming. */
  protected readonly ended = signal<string | undefined>(undefined);

  private readonly buffer = signal<readonly ViewLine[]>([]);
  private held: ViewLine[] = [];
  private next = 0;
  private subscription?: Subscription;

  /** Lines removed from the local view, counted so the gap is not silent. */
  protected readonly discarded = signal(0);
  /** Lines the host or the server could not deliver. */
  protected readonly lost = signal(0);

  protected readonly at = timestamp;
  protected readonly time = clockTime;

  protected readonly lines = computed(() => {
    const term = this.query().trim().toLowerCase();
    const lines = this.buffer();

    return term ? lines.filter((line) => line.message.toLowerCase().includes(term)) : lines;
  });

  protected readonly hidden = computed(() => this.buffer().length - this.lines().length);

  protected readonly reachable = computed(() => {
    const host = this.store.host();

    return host ? isReporting(host.status) : false;
  });

  protected readonly status = computed(() => {
    if (this.connected()) {
      return this.paused() ? { tone: 'paused', label: 'Paused' } : { tone: 'live', label: 'Live' };
    }

    if (this.connecting()) {
      return { tone: 'idle', label: 'Connecting' };
    }

    return { tone: 'off', label: 'Disconnected' };
  });

  constructor() {
    /*
     * The stream follows the container the page is showing. Opening it here
     * rather than on a button means a viewer that navigates between containers
     * never leaves the previous one running.
     */
    effect(() => {
      const container = this.store.container();

      if (!container || !this.permitted) {
        return;
      }

      if (!this.subscription && !this.ended() && this.reachable()) {
        this.connect(container.id);
      }
    });

    this.destroyRef.onDestroy(() => this.disconnect());
  }

  /** Opens the stream, replacing whatever was running. */
  protected connect(containerId?: string): void {
    const id = containerId ?? this.store.container()?.id;

    if (!id || !this.permitted) {
      return;
    }

    this.disconnect();

    this.failure.set(undefined);
    this.ended.set(undefined);
    this.connecting.set(true);

    this.subscription = this.api
      .streamContainerLogs(id, { tail: 500, timestamps: true, stdout: true, stderr: true })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (event) => this.accept(event),
        error: (error: unknown) => {
          const problem = ApiError.from(error);

          this.connecting.set(false);
          this.connected.set(false);
          this.failure.set({ message: problem.message, code: problem.code });
        },
        complete: () => {
          this.connecting.set(false);
          this.connected.set(false);
        },
      });
  }

  /** Ends the stream. The server stops reading the host when this connection goes. */
  protected disconnect(): void {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    this.connected.set(false);
    this.connecting.set(false);
  }

  protected togglePause(): void {
    const paused = !this.paused();

    this.paused.set(paused);

    if (!paused) {
      this.release();
    }
  }

  protected toggleWrap(): void {
    this.wrap.update((wrap) => !wrap);
  }

  protected toggleAutoscroll(): void {
    this.autoscroll.update((on) => !on);

    if (this.autoscroll()) {
      this.scrollToEnd();
    }
  }

  /** Empties what is on screen. Nothing is stored anywhere to clear. */
  protected clear(): void {
    this.buffer.set([]);
    this.held = [];
    this.discarded.set(0);
    this.lost.set(0);
  }

  /** Copies what is currently shown, which is what a reader would expect. */
  protected async copy(): Promise<void> {
    const text = this.lines()
      .map((line) => [line.timestamp ? this.at(line.timestamp) : '', line.message].join(' ').trim())
      .join('\n');

    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      // A browser that refuses the clipboard is not a failure worth a banner.
    }
  }

  private accept(event: LogEvent): void {
    switch (event.kind) {
      case 'open':
        this.connecting.set(false);
        this.connected.set(true);
        return;

      case 'lines':
        this.append(event.lines);
        return;

      case 'dropped':
        this.lost.update((count) => count + event.count);
        return;

      case 'end':
        this.connected.set(false);
        this.connecting.set(false);
        this.ended.set(event.reason);

        if (event.code) {
          this.failure.set({ message: messageForCode(event.code), code: event.code });
        }
    }
  }

  /**
   * Adds lines, keeping both the paused buffer and the view bounded.
   *
   * Pausing holds the stream open and buffers here rather than asking the
   * server to stop, so resuming does not lose the moment that was worth pausing
   * for. That buffer is bounded too — a pause left running for an hour must not
   * become the browser's memory problem.
   */
  private append(lines: readonly LogLine[]): void {
    const numbered = lines.map((line) => ({ ...line, seq: this.next++ }));

    if (this.paused()) {
      this.held.push(...numbered);

      if (this.held.length > MAX_PAUSED) {
        this.discarded.update((count) => count + (this.held.length - MAX_PAUSED));
        this.held = this.held.slice(-MAX_PAUSED);
      }

      return;
    }

    this.push(numbered);
  }

  private release(): void {
    if (this.held.length === 0) {
      return;
    }

    const held = this.held;
    this.held = [];
    this.push(held);
  }

  private push(lines: readonly ViewLine[]): void {
    const combined = [...this.buffer(), ...lines];

    if (combined.length > MAX_LINES) {
      this.discarded.update((count) => count + (combined.length - MAX_LINES));
    }

    this.buffer.set(combined.slice(-MAX_LINES));

    if (this.autoscroll()) {
      queueMicrotask(() => this.scrollToEnd());
    }
  }

  private scrollToEnd(): void {
    const element = this.viewport()?.nativeElement;

    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }
}
