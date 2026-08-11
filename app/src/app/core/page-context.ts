import { Injectable, inject, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';

export interface PageDescriptor {
  readonly title: string;
  readonly subtitle?: string;
  /** Trail shown before the title, for example `Hosts / docker-01`. */
  readonly breadcrumb?: readonly BreadcrumbEntry[];
}

export interface BreadcrumbEntry {
  readonly label: string;
  readonly path?: string;
}

/**
 * The heading the shell shows for the current view.
 *
 * Every view sets this once. Detail views update it when their subject loads,
 * so the browser title and the visible heading never disagree.
 */
@Injectable({ providedIn: 'root' })
export class PageContext {
  private readonly documentTitle = inject(Title);
  private readonly descriptor = signal<PageDescriptor>({ title: 'Dockplane' });

  readonly current = this.descriptor.asReadonly();

  set(descriptor: PageDescriptor): void {
    this.descriptor.set(descriptor);
    this.documentTitle.setTitle(`${descriptor.title} — Dockplane`);
  }
}
