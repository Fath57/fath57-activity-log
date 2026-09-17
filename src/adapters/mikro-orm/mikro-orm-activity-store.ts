import { EntityManager } from '@mikro-orm/core';
import { ActivityStore } from '../../core/ports';
import { ActivityRecord } from '../../core/model/activity-record';
import { TransactionRef } from '../../core/model/entity-change';

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
}
