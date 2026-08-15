import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { routes } from '../../app.routes';
import { ComposeProject } from '../../domain/inventory';
import { project } from '../../../testing/data';
import { renderView, textOf } from '../../../testing/harness';
import { ComposeTable } from '../shared/compose-table';
import { ComposeDetail } from './compose-detail';
import { ComposeStore } from './compose-store';

@Component({
  imports: [ComposeTable],
  template: `<dp-compose-table [projects]="projects()" [total]="1" />`,
})
class TableHost {
  readonly projects = signal<readonly ComposeProject[]>([]);
}

/**
 * A Compose project whose host has stopped answering.
 *
 * The same rule as everywhere else, arrived at last: inventory is kept when a
 * host goes quiet, so what is on the page becomes a claim about the past. A
 * project is an observation like any other and cannot be shown with a live tone
 * beside a host that already says it is offline — that is the reading somebody
 * acts on when they are trying to work out what is actually running.
 */
describe('a Compose project that is no longer being refreshed', () => {
  describe('in the table', () => {
    const render = async (stale: boolean) => {
      TestBed.resetTestingModule();
      await TestBed.configureTestingModule({
        imports: [TableHost],
        providers: [provideRouter(routes)],
      }).compileComponents();

      const fixture = TestBed.createComponent(TableHost);
      fixture.componentInstance.projects.set([project({ state: 'running', stale })]);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      return (fixture.nativeElement as HTMLElement).textContent ?? '';
    };

    it('names the state as the last one seen', async () => {
      expect(await render(true)).toContain('Last known: Running');
    });

    it('and shows a reporting project as running', async () => {
      const shown = await render(false);

      expect(shown).toContain('Running');
      expect(shown).not.toContain('Last known');
    });
  });

  describe('on its page', () => {
    const render = (stale: boolean) =>
      renderView(ComposeDetail, {
        params: { id: 'project-1' },
        data: { composeProjects: [project({ id: 'project-1', state: 'running', stale })] },
        permissions: ['compose.read'] as never,
        providers: [ComposeStore],
      });

    it('says the observation is the last one, and when it was', async () => {
      const shown = textOf(await render(true));

      expect(shown).toContain('Last known: Running');
      expect(shown).toContain('last observation');
    });

    it('says nothing of the sort while the host is reporting', async () => {
      const shown = textOf(await render(false));

      expect(shown).toContain('Running');
      expect(shown).not.toContain('last observation');
    });
  });
});
