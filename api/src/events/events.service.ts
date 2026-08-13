import { Injectable } from '@nestjs/common';

import { Database } from '../database/database';
import { events } from '../database/schema';

/**
 * Operational events.
 *
 * Deliberately separate from the audit trail. Audit answers "who did what to
 * this system"; an operational event answers "what happened on a managed host".
 * Mixing them would bury a permission change under thousands of container state
 * transitions, and would let routine infrastructure noise dilute the record a
 * security review depends on.
 *
 * Events are recorded on change only. A poll that observes the same state as
 * the last one records nothing.
 */
export type EventType =
  | 'agent.connected'
  | 'agent.disconnected'
  | 'host.inventory.updated'
  | 'container.discovered'
  | 'container.state.changed'
  | 'container.health.changed'
  | 'container.removed'
  | 'container.created'
  | 'container.replaced'
  | 'container.started'
  | 'container.stopped'
  | 'container.restarted'
  | 'container.action.failed'
  | 'stack.deployed'
  | 'stack.deployment.failed'
  | 'stack.started'
  | 'stack.stopped'
  | 'stack.restarted'
  | 'stack.deleted'
  | 'stack.operation.failed'
  | 'compose.discovered'
  | 'compose.state.changed'
  | 'compose.removed'
  | 'inventory.sync.failed';

export interface EventInput {
  readonly hostId?: string;
  readonly type: EventType;
  readonly severity?: 'info' | 'warning' | 'critical';
  readonly resource: string;
  readonly message: string;
  readonly correlationId?: string;
}

@Injectable()
export class EventsService {
  constructor(private readonly db: Database) {}

  async record(input: EventInput): Promise<void> {
    await this.db.client.insert(events).values({
      hostId: input.hostId ?? null,
      type: input.type,
      severity: input.severity ?? 'info',
      resource: input.resource,
      message: input.message,
      correlationId: input.correlationId ?? null,
    });
  }
}
