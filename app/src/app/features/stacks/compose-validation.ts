import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { ComposeValidation } from '../../data/dockplane-api';

/**
 * What the compiler said about a Compose file.
 *
 * The answer comes from the real compiler on the control server — the same one
 * that has to accept the file before it can be saved — so this never renders a
 * second opinion formed in the browser. A file the interface believed was fine
 * and the server refused would be worse than no check at all.
 *
 * Errors carry the path they were found at, because "invalid configuration" is
 * not something anybody can act on.
 */
@Component({
  selector: 'dp-compose-validation',
  template: `
    @if (stale() && result()) {
      <p class="note" role="status">
        The Compose file changed since it was checked. Validate it again to see what it would
        create.
      </p>
    } @else if (result(); as validation) {
      @if (validation.valid) {
        <p class="ok" role="status">Configuration is valid.</p>

        @if (validation.summary; as summary) {
          <dl class="summary">
            <dt>Services</dt>
            <dd>
              @for (service of summary.services; track service.name) {
                <span class="dp-mono">{{ service.name }} — {{ service.image }}</span>
              } @empty {
                None
              }
            </dd>
            <dt>Networks</dt>
            <dd>
              @for (network of summary.networks; track network.name) {
                <span class="dp-mono">{{ network.name }}</span>
              } @empty {
                None
              }
            </dd>
            <dt>Volumes</dt>
            <dd>
              @for (volume of summary.volumes; track volume.name) {
                <span class="dp-mono">{{ volume.name }}</span>
              } @empty {
                None
              }
            </dd>
          </dl>
        }
      } @else {
        <p class="failed" role="alert">This Compose file is not one Dockplane can deploy.</p>

        <ul class="problems">
          @for (problem of validation.errors; track $index) {
            <li class="problem">
              @if (problem.path) {
                <code class="dp-mono problem__path">{{ problem.path }}</code>
              }
              <span class="problem__message">{{ problem.message }}</span>
            </li>
          }
        </ul>
      }
    } @else {
      <p class="idle">Validate the Compose file to see what it would create before saving it.</p>
    }
  `,
  styles: `
    :host {
      display: block;
    }

    .ok,
    .failed,
    .idle,
    .note {
      margin: 0 0 0.75rem;
      font-size: 0.8125rem;
    }

    .ok {
      color: var(--dp-status-ok);
      font-weight: 500;
    }

    .failed {
      color: var(--dp-status-critical);
      font-weight: 500;
    }

    .idle,
    .note {
      color: var(--dp-text-muted);
    }

    .summary {
      display: grid;
      grid-template-columns: minmax(6rem, auto) 1fr;
      gap: 0.375rem 0.875rem;
      margin: 0;
      font-size: 0.8125rem;
    }

    .summary dt {
      color: var(--dp-text-muted);
    }

    .summary dd {
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .problems {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .problem {
      display: flex;
      flex-direction: column;
      gap: 0.1875rem;
      font-size: 0.8125rem;
    }

    .problem__path {
      color: var(--dp-text-muted);
      overflow-wrap: anywhere;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComposeValidationPanel {
  readonly result = input<ComposeValidation | undefined>(undefined);
  /** True once the file changed after it was checked. */
  readonly stale = input(false);
}
