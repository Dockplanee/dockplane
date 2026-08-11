import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { PageContext } from '../../core/page-context';
import { Button } from '../../ui/button';
import { EmptyState } from '../../ui/empty-state/empty-state';
import { Panel } from '../../ui/panel/panel';

@Component({
  selector: 'dp-not-found',
  imports: [RouterLink, Button, EmptyState, Panel],
  template: `
    <dp-panel flush>
      <dp-empty-state
        icon="alertCircle"
        title="This view does not exist"
        detail="The address you opened does not match any Dockplane view. It may have been renamed, or the resource may no longer be managed here."
      >
        <a dpButton variant="primary" routerLink="/overview">Go to overview</a>
      </dp-empty-state>
    </dp-panel>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotFound {
  constructor() {
    inject(PageContext).set({ title: 'Not found' });
  }
}
