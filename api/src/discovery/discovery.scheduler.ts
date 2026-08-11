import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Logger } from 'pino';

import { LOGGER } from '../config/tokens';
import { DiscoveryService } from './discovery.service';

/**
 * How often a connected agent is polled.
 *
 * Moderate on purpose. Discovery reads a host's whole container estate, and a
 * control plane that polls aggressively becomes the load it was meant to
 * observe.
 */
const SYNC_INTERVAL_MS = 60_000;

/** Delay before the first pass, so a reconnect storm does not arrive at once. */
const INITIAL_DELAY_MS = 2_000;

/** Spread added to each interval so a fleet does not synchronise. */
const JITTER_MS = 10_000;

interface Schedule {
  timer: NodeJS.Timeout;
  /** True while a pass is running, so passes cannot overlap for one agent. */
  running: boolean;
  stopped: boolean;
}

/**
 * Drives discovery for connected agents.
 *
 * Polling is deliberate rather than agent-driven: the server decides how often
 * a host is read, so a misbehaving or hostile agent cannot flood the control
 * plane by reporting as fast as it likes.
 */
@Injectable()
export class DiscoveryScheduler implements OnApplicationShutdown {
  private readonly schedules = new Map<string, Schedule>();

  constructor(
    private readonly discovery: DiscoveryService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Starts polling an agent that has completed its handshake. */
  start(agentId: string): void {
    this.stop(agentId);

    const schedule: Schedule = {
      timer: setTimeout(() => void this.run(agentId), INITIAL_DELAY_MS),
      running: false,
      stopped: false,
    };

    schedule.timer.unref?.();
    this.schedules.set(agentId, schedule);
  }

  /** Stops polling an agent that has disconnected or been revoked. */
  stop(agentId: string): void {
    const schedule = this.schedules.get(agentId);

    if (!schedule) {
      return;
    }

    schedule.stopped = true;
    clearTimeout(schedule.timer);
    this.schedules.delete(agentId);
  }

  onApplicationShutdown(): void {
    for (const agentId of [...this.schedules.keys()]) {
      this.stop(agentId);
    }
  }

  /** Agents currently being polled, used by tests and diagnostics. */
  get scheduled(): number {
    return this.schedules.size;
  }

  private async run(agentId: string): Promise<void> {
    const schedule = this.schedules.get(agentId);

    if (!schedule || schedule.stopped || schedule.running) {
      return;
    }

    schedule.running = true;

    try {
      await this.discovery.sync(agentId);
    } catch (error) {
      // A failed pass is an operational state, not a reason to stop polling:
      // the next pass is how a host that came back is noticed.
      this.logger.warn(
        {
          event: 'discovery_failed',
          agentId,
          reason: error instanceof Error ? error.message : 'unknown',
        },
        'a discovery pass failed',
      );
    } finally {
      schedule.running = false;
    }

    if (schedule.stopped || !this.schedules.has(agentId)) {
      return;
    }

    schedule.timer = setTimeout(() => void this.run(agentId), SYNC_INTERVAL_MS + jitter());
    schedule.timer.unref?.();
  }
}

function jitter(): number {
  return Math.floor(Math.random() * JITTER_MS);
}
