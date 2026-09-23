import { EntityManager } from '@mikro-orm/core';
import { ActivityStore, ActivityRecord, TransactionRef } from '../../core';

interface OutboxRow {
  id: string;
  payload: string | Record<string, any>;
}

const COLUMNS = [
  'id',
  'log_name',
  'description',
  'subject_type',
  'subject_id',
  'causer_type',
  'causer_id',
  'event',
  'properties',
  'tenant_id',
  'created_at',
] as const;

/**
 * Writes feed rows through MikroORM's connection, inside the caller's transaction.
 *
 * Statements are issued via `getConnection().execute(..., tx)` rather than through
 * the EntityManager's own context. A store is constructed once at bootstrap, so
 * `this.em` does NOT hold the ambient transaction: `em.insertMany()` would resolve
 * its own connection, the rows would survive a rollback as orphan feed entries,
 * and the atomicity `flushMode: 'sync'` promises would quietly be false. This is
 * the same discipline the session binder needs, and for the same reason.
 *
 * Guarded by the "WRITES INSIDE THE AMBIENT TRANSACTION" conformance test.
 */
export class MikroOrmActivityStore implements ActivityStore {
  constructor(private readonly em: EntityManager) {}

  async persist(records: ActivityRecord[], tx: TransactionRef): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const rowPlaceholder = `(${COLUMNS.map(() => '?').join(', ')})`;
    const sql =
      `INSERT INTO activity_logs (${COLUMNS.join(', ')}) VALUES ` +
      records.map(() => rowPlaceholder).join(', ') +
      ' ON CONFLICT (id) DO NOTHING';

    const params = records.flatMap((r) => [
      r.id,
      r.logName,
      r.description,
      r.subjectType ?? null,
      r.subjectId ?? null,
      r.causerType ?? null,
      r.causerId ?? null,
      r.event ?? null,
      r.properties ? JSON.stringify(r.properties) : null,
      r.tenantId ?? null,
      r.createdAt,
    ]);

    await this.em.getConnection().execute(sql, params, 'run', tx as any);
  }

  /**
   * Fills in identifiers the database assigned during the flush.
   *
   * Only meaningful for generated keys; for client-assigned ones `subjectId` was
   * already known when the record was built. See §4.5 for the atomicity boundary:
   * outside `em.transactional()` this runs after the commit.
   */
  async resolveIdentifiers(
    records: ActivityRecord[],
    tx: TransactionRef,
  ): Promise<void> {
    for (const record of records) {
      if (!record.subjectId) {
        continue;
      }
      await this.em
        .getConnection()
        .execute(
          'UPDATE activity_logs SET subject_id = ? WHERE id = ?',
          [record.subjectId, record.id],
          'run',
          tx as any,
        );
    }
  }

  /**
   * `ActivityStore.drainOutbox`, and the reason the port has it.
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
   *
   * Its own fork and its own transaction on purpose: draining is a background
   * sweep, not part of whatever the caller happens to be doing.
   */
  async drainOutbox(batchSize = 100): Promise<number> {

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
