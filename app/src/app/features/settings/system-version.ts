import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { catchError, of } from 'rxjs';

import { WEB_BUILD } from '../../core/build-info';
import { DockplaneApi } from '../../data/dockplane-api';
import { StatusTone } from '../../domain/status';
import { InstalledVersions, UpdateCheck } from '../../domain/versions';
import { Panel } from '../../ui/panel/panel';
import { StatusBadge } from '../../ui/status-badge/status-badge';

interface Line {
  readonly label: string;
  readonly value: string;
  readonly detail?: string | null;
  readonly note?: { readonly label: string; readonly tone: StatusTone } | null;
}

/**
 * What this installation is running.
 *
 * The control server and the browser application are two artefacts and are
 * reported as two: the server's version comes from the server, and the web
 * version from the bundle the browser actually loaded. An operator who pins one
 * image to a different tag can see that here, which is the reason for not
 * reporting one number as "the Dockplane version".
 *
 * Nothing here is a call to action. A newer release is a sentence; installing
 * it is a documented manual step, and no control in this panel changes
 * anything.
 */
@Component({
  selector: 'dp-system-version',
  imports: [Panel, StatusBadge],
  template: `
    <dp-panel heading="System" icon="settings" headingId="system-version-heading" flush>
      @if (failed()) {
        <p class="state">The control server did not report its versions.</p>
      } @else if (installed(); as versions) {
        <dl class="lines">
          @for (line of lines(); track line.label) {
            <div class="line">
              <dt>{{ line.label }}</dt>
              <dd>
                <span class="value">{{ line.value }}</span>
                @if (line.detail) {
                  <span class="detail dp-mono">{{ line.detail }}</span>
                }
                @if (line.note; as note) {
                  <dp-status-badge class="note plated" [tone]="note.tone" [label]="note.label" />
                }
              </dd>
            </div>
          }
        </dl>
      } @else {
        <p class="state">Reading versions…</p>
      }
    </dp-panel>
  `,
  styles: `
    .lines {
      margin: 0;
    }

    .line {
      display: grid;
      grid-template-columns: 12rem minmax(0, 1fr);
      gap: 0.25rem 1rem;
      padding: 0.625rem 1rem;
      border-bottom: 1px solid var(--dp-line);
    }

    .line:last-child {
      border-bottom: 0;
    }

    dt {
      color: var(--dp-fg-muted);
      font-size: var(--dp-text-label);
    }

    dd {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0.375rem 0.625rem;
      margin: 0;
      min-width: 0;
    }

    .value {
      font-size: 0.8125rem;
      /* Versions and commits have nowhere to break; a phone is 340 pixels. */
      overflow-wrap: anywhere;
    }

    .detail {
      color: var(--dp-fg-muted);
      overflow-wrap: anywhere;
    }

    .note {
      align-self: center;
    }

    .state {
      padding: 0.875rem 1rem;
      margin: 0;
      color: var(--dp-fg-muted);
      font-size: var(--dp-text-body);
    }

    /* One column below a tablet, so a label never squeezes its value. */
    @media (max-width: 39.999rem) {
      .line {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SystemVersion {
  private readonly api = inject(DockplaneApi);

  protected readonly failed = signal(false);

  protected readonly installed = toSignal(
    this.api.installedVersions().pipe(
      catchError(() => {
        this.failed.set(true);
        return of(undefined);
      }),
    ),
    { initialValue: undefined },
  );

  /*
   * The check is a separate request so that an upstream nobody can reach cannot
   * delay what the installation says about itself. A failure here leaves the
   * line absent rather than the panel broken.
   */
  protected readonly update = toSignal(
    this.api.updateCheck().pipe(catchError(() => of(undefined))),
    { initialValue: undefined },
  );

  protected readonly lines = computed<readonly Line[]>(() => {
    const versions = this.installed();

    if (!versions) {
      return [];
    }

    return [
      this.controlServerLine(versions),
      this.webLine(versions),
      this.schemaLine(versions),
      this.protocolLine(versions),
      ...(versions.agents ? [this.agentsLine(versions.agents)] : []),
      ...(this.updateLine() ? [this.updateLine() as Line] : []),
    ];
  });

  private controlServerLine(versions: InstalledVersions): Line {
    return {
      label: 'Dockplane Server',
      value: versions.controlServer.version,
      detail: this.shortCommit(versions.controlServer.commit),
    };
  }

  /*
   * A difference between the two is worth naming and is not a fault: an
   * operator mid-upgrade has exactly this state for as long as the rollout
   * takes.
   */
  private webLine(versions: InstalledVersions): Line {
    const differs = WEB_BUILD.version !== versions.controlServer.version;

    return {
      label: 'Web Interface',
      value: WEB_BUILD.version,
      detail: this.shortCommit(WEB_BUILD.commit),
      note: differs ? { label: 'Differs from the server', tone: 'info' } : null,
    };
  }

  private schemaLine(versions: InstalledVersions): Line {
    return {
      label: 'Database Schema',
      value: versions.schema.applied ?? 'None applied',
      detail: versions.schema.mismatch ? `Build expects ${versions.schema.expected}` : null,
      note: versions.schema.mismatch
        ? { label: 'Migration pending', tone: 'critical' }
        : null,
    };
  }

  private protocolLine(versions: InstalledVersions): Line {
    const range =
      versions.protocol.minimumSupported === versions.protocol.server
        ? null
        : `Accepts v${versions.protocol.minimumSupported} and above`;

    return {
      label: 'Agent Protocol',
      value: `v${versions.protocol.server}`,
      detail: range,
    };
  }

  /*
   * Mixed versions are worth flagging and are not an error: an agent on an
   * older release whose protocol the server still speaks is working. Only a
   * protocol outside the supported range is an incompatibility.
   */
  private agentsLine(agents: NonNullable<InstalledVersions['agents']>): Line {
    const readable = agents.versions.filter((entry) => entry.version !== null).length;

    const value =
      agents.total === 0
        ? 'No agents enrolled'
        : `${agents.total} ${agents.total === 1 ? 'agent' : 'agents'}`;

    const detail =
      agents.total === 0
        ? null
        : [
            readable === 1 ? agents.versions.find((entry) => entry.version)?.version : null,
            readable > 1 ? `${readable} versions in use` : null,
            agents.unknownCount > 0 ? `${agents.unknownCount} not reporting a version` : null,
          ]
            .filter(Boolean)
            .join(' · ');

    if (agents.protocolUnsupportedCount > 0) {
      return {
        label: 'Agents',
        value,
        detail,
        note: { label: 'Protocol not supported', tone: 'critical' },
      };
    }

    return {
      label: 'Agents',
      value,
      detail,
      note: agents.mixedVersions ? { label: 'Mixed versions', tone: 'warn' } : null,
    };
  }

  private updateLine(): Line | null {
    const check = this.update();

    if (!check) {
      return null;
    }

    return {
      label: 'Updates',
      value: this.updateText(check),
      detail: check.stale && check.checkedAt ? 'Last successful check' : null,
      note: check.updateAvailable ? { label: 'Update available', tone: 'info' } : null,
    };
  }

  private updateText(check: UpdateCheck): string {
    switch (check.state) {
      case 'disabled':
        return 'Checking for new releases is off';
      case 'unknown':
        return 'Not checked yet';
      case 'unavailable':
        return 'The release listing could not be reached';
      case 'unsupported':
        return 'The release listing named no version this build can read';
      case 'ok':
        return check.updateAvailable
          ? `Dockplane ${check.latestStableVersion} has been published`
          : 'This is the newest published release';
    }
  }

  /** A commit is only ever read to compare two of them. */
  private shortCommit(commit: string): string | null {
    return commit && commit !== 'unknown' ? commit.slice(0, 12) : null;
  }
}
