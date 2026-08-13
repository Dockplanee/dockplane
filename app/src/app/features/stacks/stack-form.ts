import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';

import { Host } from '../../domain/inventory';
import { Button } from '../../ui/button';
import { FieldProblem, StackEnvironmentRow, StackFormModel, problemFor } from './stack-form-model';

/**
 * The Compose source and the environment beside it.
 *
 * Two editors that deliberately do not talk to each other. The environment
 * defines values; the Compose file decides where they are used, and rewriting
 * somebody's YAML to insert a `${VARIABLE}` reference would be editing their
 * file for them — from an interface that does not understand what the file
 * means.
 *
 * The source is held here and nowhere else: not in a store, not in the URL and
 * not in browser storage. A Compose file can contain a credential its author
 * wrote into it, and a draft saved to `localStorage` is that credential written
 * to disk by a page nobody asked to persist anything.
 */
@Component({
  selector: 'dp-stack-form',
  imports: [Button],
  templateUrl: './stack-form.html',
  styleUrl: './stack-form.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StackForm {
  readonly model = model.required<StackFormModel>();
  readonly problems = input<readonly FieldProblem[]>([]);
  readonly hosts = input<readonly Host[]>([]);
  /** `create` asks for a name and a host; an edit changes neither. */
  readonly mode = input<'create' | 'edit'>('create');

  protected readonly identityEditable = computed(() => this.mode() === 'create');

  protected readonly chosenHost = computed(() =>
    this.hosts().find((host) => host.id === this.model().hostId),
  );

  /**
   * Whether the chosen host has an agent that can be reached.
   *
   * Saving does not need one — writing a stack down is not a change to a
   * machine — so an offline host is stated rather than refused.
   */
  protected readonly hostOffline = computed(() => {
    const host = this.chosenHost();

    return Boolean(host) && host!.agentStatus !== 'connected';
  });

  protected problem(field: string): string | undefined {
    return problemFor(this.problems(), field);
  }

  protected patch(change: Partial<StackFormModel>): void {
    this.model.update((current) => ({ ...current, ...change }));
  }

  protected patchVariable(index: number, change: Partial<StackEnvironmentRow>): void {
    this.model.update((current) => ({
      ...current,
      environment: current.environment.map((row, position) =>
        position === index ? { ...row, ...change } : row,
      ),
    }));
  }

  protected setVariableAction(index: number, action: StackEnvironmentRow['action']): void {
    this.patchVariable(index, { action, ...(action === 'change' ? {} : { value: '' }) });
  }

  protected addVariable(secret: boolean): void {
    this.model.update((current) => ({
      ...current,
      environment: [
        ...current.environment,
        { key: '', value: '', secret, stored: false, action: 'unchanged' as const },
      ],
    }));
  }

  protected removeVariable(index: number): void {
    this.model.update((current) => ({
      ...current,
      environment: current.environment.filter((_, position) => position !== index),
    }));
  }
}
