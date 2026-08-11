import { Type } from '@angular/core';

import { checkAccessibility } from '../../testing/accessibility';
import { headingLevels, renderView } from '../../testing/harness';
import { AgentList } from './agents/agent-list';
import { AuditLog } from './administration/audit-log';
import { RoleList } from './administration/role-list';
import { UserList } from './administration/user-list';
import { ComposeList } from './compose/compose-list';
import { ContainerList } from './containers/container-list';
import { Health } from './health/health';
import { HostList } from './hosts/host-list';
import { NotFound } from './not-found/not-found';
import { ActionHistory } from './operations/action-history';
import { Overview } from './overview/overview';
import { Settings } from './settings/settings';

const VIEWS: [name: string, component: Type<unknown>][] = [
  ['overview', Overview],
  ['hosts', HostList],
  ['containers', ContainerList],
  ['compose', ComposeList],
  ['health', Health],
  ['actions', ActionHistory],
  ['agents', AgentList],
  ['users', UserList],
  ['roles', RoleList],
  ['audit log', AuditLog],
  ['settings', Settings],
  ['not found', NotFound],
];

describe('application views', () => {
  for (const [name, component] of VIEWS) {
    describe(name, () => {
      it('has no accessibility violations', async () => {
        const fixture = await renderView(component);
        const { violations } = await checkAccessibility(fixture);

        expect(violations.join('\n\n')).toBe('');
      });

      it('does not skip a heading level', async () => {
        const fixture = await renderView(component);
        const levels = headingLevels(fixture);

        for (let index = 1; index < levels.length; index += 1) {
          expect(levels[index] - levels[index - 1]).toBeLessThanOrEqual(1);
        }
      });

      it('gives every table a caption and column headers', async () => {
        const fixture = await renderView(component);
        const tables = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('table'));

        for (const table of tables) {
          expect(table.querySelector('caption')?.textContent?.trim().length ?? 0).toBeGreaterThan(
            0,
          );
          expect(table.querySelectorAll('thead th[scope="col"]').length).toBeGreaterThan(0);
        }
      });

      it('gives every form control an accessible name', async () => {
        const fixture = await renderView(component);
        const host = fixture.nativeElement as HTMLElement;
        const controls = Array.from(host.querySelectorAll('input, select, textarea'));

        for (const control of controls) {
          const id = control.getAttribute('id');
          const labelled =
            control.getAttribute('aria-label') ??
            (id ? host.querySelector(`label[for="${id}"]`)?.textContent : undefined) ??
            control.closest('label')?.textContent;

          expect(labelled?.trim().length ?? 0).toBeGreaterThan(0);
        }
      });

      it('gives every icon-only control an accessible name', async () => {
        const fixture = await renderView(component);
        const buttons = Array.from(
          (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
        );

        for (const button of buttons) {
          const name = button.getAttribute('aria-label') ?? button.textContent ?? '';
          expect(name.trim().length).toBeGreaterThan(0);
        }
      });
    });
  }
});
