import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';

interface OutboxRow {
  id: string;
  payload: string | Record<string, any>;
}

@Injectable()
export class ActivityOutboxDrainer {
  constructor(private readonly em: EntityManager) {}

  /**
   * Moves one batch of intents from `activity_outbox` into `activity_logs`.
   * Returns the number of intents drained.
   *
   * The claim delivery makes is **at-least-once**, and that requires the DELETE
   * and the INSERTs to share a single transaction. Run as separate autocommit
   * statements, a failure after the DELETE destroys the intents outright: the
   * outbox is empty, the feed never received them, and nothing replays. Delivery
   * would be at-most-once, silently. Guarded by
   * outbox-drainer.integration.spec.ts ("LOSES NOTHING when the feed insert fails").
   *
   * `FOR UPDATE SKIP LOCKED` keeps concurrent drainers off each other's rows;
   * `ON CONFLICT (id) DO NOTHING` makes a replayed batch idempotent.
   */
  async drain(batchSize = 100): Promise<number> {
    const fork = this.em.fork ? this.em.fork() : this.em;

    return fork.transactional(async (em) => {
      const rows = (await (em as any).execute(
        `DELETE FROM activity_outbox
         WHERE id IN (
           SELECT id FROM activity_outbox
           ORDER BY created_at ASC
           LIMIT ?
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *;`,
        [batchSize],
      )) as OutboxRow[];

      if (!rows?.length) {
        return 0;
      }

      for (const row of rows) {
        const payload =
          typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;

        await (em as any).execute(
          `INSERT INTO activity_logs (
             id, log_name, description, subject_type, subject_id,
             causer_type, causer_id, event, properties, tenant_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING;`,
          [
            payload.id,
            payload.logName ?? 'default',
            payload.description ?? '',
            payload.subjectType ?? null,
            payload.subjectId ?? null,
            payload.causerType ?? null,
            payload.causerId ?? null,
            payload.event ?? null,
            payload.properties ? JSON.stringify(payload.properties) : null,
            payload.tenantId ?? null,
            payload.createdAt ? new Date(payload.createdAt) : new Date(),
          ],
        );
      }

      return rows.length;
    });
  }
}
