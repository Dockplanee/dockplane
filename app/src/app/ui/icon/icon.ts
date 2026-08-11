import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * The application icon family.
 *
 * One set, drawn on a 20x20 grid with a 1.5 stroke and round joins, so icons
 * stay legible at 16-20px and read consistently next to text. Icons support
 * labels rather than replacing them: an icon-only control must supply its own
 * accessible name.
 */
const PATHS = {
  overview: ['M3 3h6v6H3zM11 3h6v4h-6zM11 9h6v8h-6zM3 11h6v6H3z'],
  hosts: ['M3 4.5h14v4H3zM3 11.5h14v4H3z', 'M6 6.5h.01M6 13.5h.01'],
  containers: ['M10 2.5l6.5 3.5v8L10 17.5 3.5 14V6z', 'M3.5 6l6.5 3.5L16.5 6M10 9.5v8'],
  compose: ['M10 2.5L17 6l-7 3.5L3 6z', 'M3 10l7 3.5L17 10M3 14l7 3.5L17 14'],
  images: ['M3 5.5h14v9H3z', 'M3 12l3.5-3 3 2.5 3.5-3.5L17 12', 'M7 8.5h.01'],
  volumes: [
    'M4 5c0-1.1 2.7-2 6-2s6 .9 6 2-2.7 2-6 2-6-.9-6-2z',
    'M4 5v10c0 1.1 2.7 2 6 2s6-.9 6-2V5',
    'M4 10c0 1.1 2.7 2 6 2s6-.9 6-2',
  ],
  networks: [
    'M10 3.5a2 2 0 110 4 2 2 0 010-4zM4.5 12.5a2 2 0 110 4 2 2 0 010-4zM15.5 12.5a2 2 0 110 4 2 2 0 010-4z',
    'M8.6 7.1l-2.8 4M11.4 7.1l2.8 4M6.5 14.5h7',
  ],
  health: ['M10 17s-6-3.6-6-8a3.4 3.4 0 016-2.2A3.4 3.4 0 0116 9c0 4.4-6 8-6 8z'],
  events: ['M2.5 10h3l2-5 3 10 2.5-5h4.5'],
  actions: ['M10 2.5a7.5 7.5 0 110 15 7.5 7.5 0 010-15z', 'M8.5 7.5l4 2.5-4 2.5z'],
  agents: ['M10 2.8l6 2.2v4.6c0 3.4-2.5 6-6 7.6-3.5-1.6-6-4.2-6-7.6V5z', 'M7.5 10l1.8 1.8L13 8'],
  users: [
    'M7 9.5a2.6 2.6 0 110-5.2 2.6 2.6 0 010 5.2z',
    'M2.5 16.5c0-2.5 2-4.2 4.5-4.2s4.5 1.7 4.5 4.2',
    'M13.5 5.2a2.4 2.4 0 010 4.8M14.5 12.6c1.8.4 3 1.9 3 3.9',
  ],
  roles: ['M12.5 4a3.5 3.5 0 110 7 3.5 3.5 0 010-7z', 'M9.6 9.4L3 16v1.5h2.5V16H7v-1.5h1.5L10 13'],
  audit: ['M5 2.5h7l3 3v12H5z', 'M8 8.5h4M8 11.5h4M8 14.5h2.5'],
  settings: [
    'M10 7.6a2.4 2.4 0 110 4.8 2.4 2.4 0 010-4.8z',
    'M10 2.5l1.2 1.9 2.2-.4.5 2.2 2 1-1 2 1 2-2 1-.5 2.2-2.2-.4L10 17.5l-1.2-1.9-2.2.4-.5-2.2-2-1 1-2-1-2 2-1 .5-2.2 2.2.4z',
  ],
  search: ['M9 3.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11z', 'M13.2 13.2l3.3 3.3'],
  filter: ['M3 5h14M6 10h8M8.5 15h3'],
  columns: ['M3 4h14v12H3z', 'M8 4v12M13 4v12'],
  more: ['M5 10h.01M10 10h.01M15 10h.01'],
  close: ['M5 5l10 10M15 5L5 15'],
  check: ['M4.5 10.5l3.5 3.5 7.5-8'],
  chevronDown: ['M5.5 8l4.5 4.5L14.5 8'],
  chevronRight: ['M8 5.5l4.5 4.5L8 14.5'],
  chevronLeft: ['M12 5.5L7.5 10l4.5 4.5'],
  alertTriangle: ['M10 3.2l7 12.3H3z', 'M10 8v3.2M10 13.4h.01'],
  alertCircle: ['M10 3a7 7 0 110 14 7 7 0 010-14z', 'M10 6.5v4M10 13.2h.01'],
  info: ['M10 3a7 7 0 110 14 7 7 0 010-14z', 'M10 9.2v4.3M10 6.6h.01'],
  refresh: ['M16.5 10a6.5 6.5 0 11-1.9-4.6', 'M16.5 3v3.5H13'],
  play: ['M6.5 4.5l9 5.5-9 5.5z'],
  stop: ['M5.5 5.5h9v9h-9z'],
  copy: ['M7 7h9v9H7z', 'M13 7V4H4v9h3'],
  download: ['M10 3.5v9M6 9l4 4 4-4', 'M3.5 16.5h13'],
  externalLink: ['M11 4h5v5', 'M16 4l-7 7', 'M14 11.5v4.5H4V6h4.5'],
  menu: ['M3 6h14M3 10h14M3 14h14'],
  bell: [
    'M10 3a4.5 4.5 0 014.5 4.5c0 3.5 1.5 4.5 1.5 4.5H4s1.5-1 1.5-4.5A4.5 4.5 0 0110 3z',
    'M8.4 14.5a1.8 1.8 0 003.2 0',
  ],
  user: ['M10 3.5a3 3 0 110 6 3 3 0 010-6z', 'M4 17c0-3 2.7-5 6-5s6 2 6 5'],
  sun: [
    'M10 6.4a3.6 3.6 0 110 7.2 3.6 3.6 0 010-7.2z',
    'M10 2.4v1.8M10 15.8v1.8M17.6 10h-1.8M4.2 10H2.4M15.4 4.6l-1.3 1.3M5.9 14.1l-1.3 1.3M15.4 15.4l-1.3-1.3M5.9 5.9L4.6 4.6',
  ],
  moon: ['M16.2 12.4A6.8 6.8 0 017.6 3.8a6.8 6.8 0 108.6 8.6z'],
  logs: ['M3 4.5h14v11H3z', 'M6 8h3M6 11h6M11 8h3'],
  metrics: ['M3 16.5h14', 'M5.5 13v-3M9 13V6M12.5 13v-5M16 13V8.5'],
  config: ['M4 4.5h12v11H4z', 'M7 8h6M7 11h4'],
  logout: ['M8 4.5H4.5v11H8', 'M11.5 7l3 3-3 3M14.5 10H7'],
  arrowLeft: ['M15 10H5', 'M9 5.5L4.5 10 9 14.5'],
  clock: ['M10 3.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13z', 'M10 6.5V10l2.5 1.8'],
  pause: ['M7 5v10M13 5v10'],
  wrap: ['M3 5.5h14M3 10h9.5a2.5 2.5 0 010 5H10', 'M11.5 13l-1.8 2 1.8 2'],
  plus: ['M10 4.5v11M4.5 10h11'],
} as const;

export type IconName = keyof typeof PATHS;

@Component({
  selector: 'dp-icon',
  template: `
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      @for (path of paths(); track $index) {
        <path [attr.d]="path" />
      }
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
      width: 1.125rem;
      height: 1.125rem;
    }

    svg {
      width: 100%;
      height: 100%;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Icon {
  readonly name = input.required<IconName>();

  protected readonly paths = computed<readonly string[]>(() => PATHS[this.name()]);
}
