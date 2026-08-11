import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';

import { Button } from '../../ui/button';
import { EmptyState } from '../../ui/empty-state/empty-state';

/**
 * Shown when the operator is signed in but may not see a page.
 *
 * Deliberately not a sign-in prompt. The session is fine; signing in again
 * would change nothing and would send an operator round a loop looking for a
 * problem that is not there.
 */
@Component({
  selector: 'dp-forbidden',
  imports: [Button, EmptyState, RouterLink],
  template: `
    <dp-empty-state
      icon="info"
      title="You do not have access to this area"
      [detail]="description()"
    >
      <a dpButton variant="secondary" routerLink="/overview">Back to overview</a>
    </dp-empty-state>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Forbidden {
  private readonly route = inject(ActivatedRoute);

  private readonly from = toSignal(
    this.route.queryParamMap.pipe(map((params) => params.get('from') ?? '')),
    { initialValue: '' },
  );

  protected readonly description = () =>
    this.from()
      ? `Your roles do not include the permission needed for ${this.from()}. An administrator can grant it.`
      : 'Your roles do not include the permission needed for this page. An administrator can grant it.';
}
