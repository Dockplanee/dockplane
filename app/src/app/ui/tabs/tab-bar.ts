import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

export interface TabLink {
  readonly label: string;
  readonly path: string;
}

/**
 * Detail-view tabs.
 *
 * Each tab is a real link to a child route, so tabs are shareable, restorable
 * and operable with the browser's own navigation.
 */
@Component({
  selector: 'dp-tab-bar',
  imports: [RouterLink, RouterLinkActive],
  template: `
    <nav [attr.aria-label]="label()">
      <ul>
        @for (tab of tabs(); track tab.path) {
          <li>
            <a
              [routerLink]="tab.path"
              routerLinkActive="active"
              #link="routerLinkActive"
              [attr.aria-current]="link.isActive ? 'page' : null"
              >{{ tab.label }}</a
            >
          </li>
        }
      </ul>
    </nav>
  `,
  styles: `
    :host {
      display: block;
      border-bottom: 1px solid var(--dp-line);
    }

    nav {
      overflow-x: auto;
    }

    ul {
      display: flex;
      gap: 0.25rem;
      list-style: none;
      margin: 0;
      padding: 0;
    }

    a {
      display: inline-flex;
      align-items: center;
      height: 2.5rem;
      padding-inline: 0.75rem;
      border-bottom: 2px solid transparent;
      color: var(--dp-fg-muted);
      font-size: 0.8125rem;
      font-weight: 500;
      white-space: nowrap;
      text-decoration: none;
    }

    a:hover {
      color: var(--dp-fg);
    }

    a.active {
      color: var(--dp-fg);
      border-bottom-color: var(--dp-accent);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TabBar {
  readonly tabs = input.required<readonly TabLink[]>();
  readonly label = input('Sections');
}
