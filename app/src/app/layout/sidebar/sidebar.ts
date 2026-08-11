import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import { NAVIGATION } from '../../core/navigation';
import { Permissions } from '../../core/permissions';
import { Icon } from '../../ui/icon/icon';
import { Logo } from '../../ui/logo/logo';

@Component({
  selector: 'dp-sidebar',
  imports: [RouterLink, RouterLinkActive, Icon, Logo],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.collapsed]': 'collapsed()',
  },
})
export class Sidebar {
  private readonly permissions = inject(Permissions);

  readonly collapsed = input(false, { transform: booleanAttribute });

  readonly collapseToggled = output<void>();
  readonly navigated = output<void>();

  /** Groups whose entries the operator is allowed to see. */
  protected readonly groups = computed(() =>
    NAVIGATION.map((group) => ({
      title: group.title,
      items: group.items.filter(
        (item) => !item.permission || this.permissions.has(item.permission),
      ),
    })).filter((group) => group.items.length > 0),
  );
}
