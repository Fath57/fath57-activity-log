import { EntityManager } from '@mikro-orm/core';
import { ActivityReader, CursorPage, FeedQuerySpec } from '../../core/ports';
import { ActivityRecord } from '../../core/model/activity-record';
import { ActivityLog } from '../../feed/entities/activity-log.entity';

interface CursorPayload {
  createdAt: string;
  id: string;
}

/**
 * Keyset-paginated reads over `activity_logs`.
 *
 * Pagination is by cursor rather than offset: the composite indexes of §4.1
 * support `(tenantId, …, createdAt)` ranges natively, while OFFSET and COUNT(*)
 * degrade linearly with depth on what is the largest table in the package.
 *
 * Tenant scoping is resolved by the CALLER (ActivityQueryService reads it from
 * the request context). This port takes it explicitly so that it stays testable
 * without a context, and so that `null` means a deliberate cross-tenant query
 * rather than an absent one.
 */
export class MikroOrmActivityReader implements ActivityReader {
  constructor(private readonly em: EntityManager) {}

  async query(spec: FeedQuerySpec): Promise<CursorPage<ActivityRecord>> {
    const limit = spec.limit ?? 25;
    const where = this.buildWhere(spec);

    if (spec.cursor) {
      const decoded = this.decodeCursor(spec.cursor);
      if (decoded) {
        const at = new Date(decoded.createdAt);
        where.$or = [
          { createdAt: { $lt: at } },
          { createdAt: at, id: { $lt: decoded.id } },
        ];
      }
    }

    const items = await this.em.find(ActivityLog, where as any, {
      limit: limit + 1,
      orderBy: { createdAt: 'DESC', id: 'DESC' },
    });

    let nextCursor: string | null = null;
    if (items.length > limit) {
      items.pop();
      const last = items[items.length - 1];
      if (last) {
        nextCursor = this.encodeCursor({
          createdAt: last.createdAt.toISOString(),
          id: last.id,
        });
      }
    }

    return { data: items as unknown as ActivityRecord[], nextCursor };
  }

  async count(spec: FeedQuerySpec): Promise<number> {
    return this.em.count(ActivityLog, this.buildWhere(spec) as any);
  }

  /**
   * Bounded-batch retention, backed by idx_activity_logs_created.
   *
   * A single unbounded DELETE over a table this size holds locks and WAL for the
   * duration; batching keeps each statement short. Retention is deliberately NOT
   * tenant-scoped — it is a storage policy, not a query.
   */
  async prune(olderThan: Date, batchSize: number): Promise<number> {
    let total = 0;

    for (;;) {
      const rows = await this.em.find(
        ActivityLog,
        { createdAt: { $lt: olderThan } } as any,
        { limit: batchSize, fields: ['id'] },
      );
      if (rows.length === 0) {
        return total;
      }

      total += await this.em.nativeDelete(ActivityLog, {
        id: { $in: rows.map((r) => r.id) },
      } as any);

      if (rows.length < batchSize) {
        return total;
      }
    }
  }

  private buildWhere(spec: FeedQuerySpec): Record<string, any> {
    const where: Record<string, any> = {};
    if (spec.logName !== undefined) where.logName = spec.logName;
    if (spec.subjectType !== undefined) where.subjectType = spec.subjectType;
    if (spec.subjectId !== undefined) where.subjectId = spec.subjectId;
    if (spec.causerType !== undefined) where.causerType = spec.causerType;
    if (spec.causerId !== undefined) where.causerId = spec.causerId;
    // undefined => unscoped (the caller resolves the ambient tenant);
    // null      => deliberately cross-tenant.
    if (spec.tenantId != null) where.tenantId = spec.tenantId;
    return where;
  }

  private encodeCursor(payload: CursorPayload): string {
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  private decodeCursor(cursor: string): CursorPayload | null {
    try {
      return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }
}
