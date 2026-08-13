import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';

import { Host } from '../../domain/inventory';
import { Button } from '../../ui/button';
import {
  ContainerFormModel,
  EnvironmentRow,
  FieldProblem,
  LabelRow,
  MountRow,
  PortRow,
  RESTART_POLICIES,
} from './container-form-model';

/**
 * What a container should be, as a form.
 *
 * One component for creating and for changing, because they describe the same
 * thing and an operator should not have to learn it twice. What differs is
 * small and explicit: creating chooses a host, changing shows the one the
 * container is already on.
 *
 * It holds no opinion about what happens next. The page around it decides what
 * to do with a valid form, which is why the same fields can end up as a create
 * on one route and a replacement on another.
 *
 * Nothing here reaches Docker's own vocabulary. There is no field for
 * privileged mode, host namespaces, devices or capabilities, and no free-form
 * box that could carry one — those are absent from the product, not hidden by
 * the interface.
 */
@Component({
  selector: 'dp-container-form',
  imports: [Button],
  templateUrl: './container-form.html',
  styleUrl: './container-form.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContainerForm {
  readonly model = model.required<ContainerFormModel>();
  readonly mode = input<'create' | 'edit'>('create');
  readonly hosts = input<readonly Host[]>([]);

  /**
   * Problems worth showing.
   *
   * Supplied rather than computed here: the page decides when an operator has
   * done enough for a complaint to be useful, which is usually after they try
   * to submit rather than while they are still typing the first field.
   */
  readonly problems = input<readonly FieldProblem[]>([]);

  protected readonly restartPolicies = RESTART_POLICIES;

  protected readonly hostName = computed(
    () => this.hosts().find((host) => host.id === this.model().hostId)?.name ?? 'this host',
  );

  protected problem(field: string): string | undefined {
    return this.problems().find((entry) => entry.field === field)?.message;
  }

  /**
   * Whether a create could reach this host.
   *
   * The agent's connection, not the freshness of the last observation. They
   * differ for the whole window between a host connecting and its first
   * discovery pass finishing — during which the control server would happily
   * carry out a create and this form was refusing to offer one.
   */
  protected reachable(host: Host): boolean {
    return host.agentStatus === 'connected';
  }

  protected patch(change: Partial<ContainerFormModel>): void {
    this.model.update((current) => ({ ...current, ...change }));
  }

  protected setHost(hostId: string): void {
    // The networks belong to the host that has them, so a change of host
    // discards names that no longer refer to anything.
    this.patch({ hostId, networks: [] });
  }

  protected addPort(): void {
    this.patch({
      ports: [
        ...this.model().ports,
        { hostIp: '', hostPort: '', containerPort: '', protocol: 'tcp' },
      ],
    });
  }

  protected patchPort(index: number, change: Partial<PortRow>): void {
    this.patch({ ports: replace(this.model().ports, index, change) });
  }

  protected removePort(index: number): void {
    this.patch({ ports: without(this.model().ports, index) });
  }

  protected addMount(): void {
    this.patch({
      mounts: [...this.model().mounts, { type: 'volume', source: '', target: '', readOnly: false }],
    });
  }

  protected patchMount(index: number, change: Partial<MountRow>): void {
    this.patch({ mounts: replace(this.model().mounts, index, change) });
  }

  protected removeMount(index: number): void {
    this.patch({ mounts: without(this.model().mounts, index) });
  }

  protected addVariable(): void {
    this.patch({
      environment: [
        ...this.model().environment,
        { key: '', value: '', secret: false, stored: false, action: 'unchanged' },
      ],
    });
  }

  protected patchVariable(index: number, change: Partial<EnvironmentRow>): void {
    this.patch({ environment: replace(this.model().environment, index, change) });
  }

  /**
   * What is being done to a stored secret.
   *
   * Changing back to `unchanged` drops whatever was typed. A value that is no
   * longer going to be sent has no reason to stay in the form.
   */
  protected setVariableAction(index: number, action: EnvironmentRow['action']): void {
    this.patchVariable(index, { action, value: action === 'change' ? '' : '' });
  }

  protected removeVariable(index: number): void {
    this.patch({ environment: without(this.model().environment, index) });
  }

  protected addNetwork(): void {
    this.patch({ networks: [...this.model().networks, ''] });
  }

  protected patchNetwork(index: number, value: string): void {
    this.patch({
      networks: this.model().networks.map((entry, position) =>
        position === index ? value : entry,
      ),
    });
  }

  protected removeNetwork(index: number): void {
    this.patch({ networks: without(this.model().networks, index) });
  }

  protected addLabel(): void {
    this.patch({ labels: [...this.model().labels, { key: '', value: '' }] });
  }

  protected patchLabel(index: number, change: Partial<LabelRow>): void {
    this.patch({ labels: replace(this.model().labels, index, change) });
  }

  protected removeLabel(index: number): void {
    this.patch({ labels: without(this.model().labels, index) });
  }
}

function replace<T>(rows: readonly T[], index: number, change: Partial<T>): T[] {
  return rows.map((row, position) => (position === index ? { ...row, ...change } : row));
}

function without<T>(rows: readonly T[], index: number): T[] {
  return rows.filter((_, position) => position !== index);
}
