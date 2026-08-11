import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

/**
 * A request to read the Docker inventory again.
 *
 * An operation changes a host, so every view describing that host is now
 * describing something that no longer holds. Rather than each view predicting
 * what an operation did, they all read again from the control server, which is
 * the only thing that knows what the host actually reported afterwards.
 *
 * The stream emits once on subscription so a view can gate its initial read on
 * it and needs no second code path for the first load.
 */
@Injectable({ providedIn: 'root' })
export class InventoryRefresh {
  private readonly ticks = new BehaviorSubject(0);

  readonly changes: Observable<number> = this.ticks.asObservable();

  request(): void {
    this.ticks.next(this.ticks.value + 1);
  }
}
