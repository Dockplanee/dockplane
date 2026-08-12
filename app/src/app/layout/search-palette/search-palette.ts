import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';

import { DockplaneApi } from '../../data/dockplane-api';
import { Icon, IconName } from '../../ui/icon/icon';

interface SearchResult {
  readonly id: string;
  readonly label: string;
  readonly context: string;
  readonly group: string;
  readonly icon: IconName;
  readonly link: readonly string[];
}

const RESULT_LIMIT = 12;

/**
 * Search across the managed inventory.
 *
 * Matching happens over what the interface already holds, so it stays available
 * while navigating and needs no separate query endpoint.
 */
@Component({
  selector: 'dp-search-palette',
  imports: [Icon],
  templateUrl: './search-palette.html',
  styleUrl: './search-palette.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchPalette {
  private readonly api = inject(DockplaneApi);
  private readonly router = inject(Router);

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');

  private readonly hosts = toSignal(this.api.hosts(), { initialValue: [] });
  private readonly containers = toSignal(this.api.containers(), { initialValue: [] });
  private readonly projects = toSignal(this.api.composeProjects(), { initialValue: [] });

  protected readonly query = signal('');
  protected readonly activeIndex = signal(0);

  private readonly index = computed<readonly SearchResult[]>(() => [
    ...this.hosts().map((host) => ({
      id: `host-${host.id}`,
      label: host.name,
      context: host.os ?? 'Unknown operating system',
      group: 'Hosts',
      icon: 'hosts' as const,
      link: ['/hosts', host.id],
    })),
    ...this.containers().map((container) => ({
      id: `container-${container.id}`,
      label: container.name,
      context: `${container.hostId} · ${container.image}`,
      group: 'Containers',
      icon: 'containers' as const,
      link: ['/containers', container.id],
    })),
    ...this.projects().map((project) => ({
      id: `compose-${project.id}`,
      label: project.name,
      context: project.hostId,
      group: 'Compose projects',
      icon: 'compose' as const,
      link: ['/compose', project.id],
    })),
  ]);

  protected readonly results = computed<readonly SearchResult[]>(() => {
    const term = this.query().trim().toLowerCase();

    if (!term) {
      return this.index().slice(0, RESULT_LIMIT);
    }

    return this.index()
      .filter(
        (entry) =>
          entry.label.toLowerCase().includes(term) || entry.context.toLowerCase().includes(term),
      )
      .slice(0, RESULT_LIMIT);
  });

  /** Results regrouped for display while keeping one flat keyboard order. */
  protected readonly groups = computed(() => {
    const grouped = new Map<string, SearchResult[]>();

    for (const result of this.results()) {
      const bucket = grouped.get(result.group) ?? [];
      bucket.push(result);
      grouped.set(result.group, bucket);
    }

    return [...grouped].map(([title, items]) => ({ title, items }));
  });

  open(): void {
    const element = this.dialog().nativeElement;

    if (!element.open) {
      this.query.set('');
      this.activeIndex.set(0);
      /*
       * showModal is what puts the dialog in the top layer. Not every
       * environment implements it — a test renderer typically does not — so
       * the element is still opened there rather than the call throwing and
       * taking the flow with it.
       */
      if (typeof element.showModal === 'function') {
        element.showModal();
      } else {
        element.setAttribute('open', '');
      }

      this.field().nativeElement.focus();
    }
  }

  protected close(): void {
    const element = this.dialog().nativeElement;

    if (element.open) {
      element.close();
    }
  }

  protected onQuery(value: string): void {
    this.query.set(value);
    this.activeIndex.set(0);
  }

  protected move(offset: number, event: Event): void {
    event.preventDefault();

    const count = this.results().length;
    if (count === 0) {
      return;
    }

    this.activeIndex.update((index) => (index + offset + count) % count);
  }

  protected submit(event: Event): void {
    event.preventDefault();

    const result = this.results()[this.activeIndex()];
    if (result) {
      this.go(result);
    }
  }

  protected go(result: SearchResult): void {
    this.close();
    void this.router.navigate(result.link);
  }

  protected flatIndex(result: SearchResult): number {
    return this.results().findIndex((entry) => entry.id === result.id);
  }
}
