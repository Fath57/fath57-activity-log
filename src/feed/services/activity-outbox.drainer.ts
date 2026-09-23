import { Inject, Injectable } from '@nestjs/common';
import { ActivityStore } from '../../core';
import { ACTIVITY_STORE } from '../constants/feed.constants';

/**
 * Drains the outbox through the store port.
 *
 * Everything that made this hard — the locking dequeue, the shared transaction,
 * the idempotent replay — is SQL, and SQL belongs to the adapter. What is left
 * here is the schedule-facing surface an application calls.
 */
@Injectable()
export class ActivityOutboxDrainer {
  constructor(@Inject(ACTIVITY_STORE) private readonly store: ActivityStore) {}

  /**
   * Moves one batch of intents from `activity_outbox` into `activity_logs`.
   * Returns the number of intents drained, or 0 when the configured adapter
   * supplies no drain — `flushMode: 'outbox'` is already refused at bootstrap in
   * that case, so reaching here means the feed is running in sync mode and the
   * outbox is empty by construction.
   */
  async drain(batchSize = 100): Promise<number> {
    return this.store.drainOutbox ? this.store.drainOutbox(batchSize) : 0;
  }
}
