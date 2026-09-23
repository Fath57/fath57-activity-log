import { EntityManager, FilterQuery } from '@mikro-orm/core';
import { AuditEntry, AuditQuerySpec, AuditReader } from '../../core';
import { LoggedAction } from '../../audit/entities/logged-action.entity';

/**
 * `AuditReader` over MikroORM.
 *
 * Every clause is conditional: the spec is a partial question, and a field the
 * caller left out must not narrow the result. `LoggedAction` is readonly and
 * written only by the triggers, so this is the only way the rows are read
 * through the ORM at all.
 */
export class MikroOrmAuditReader implements AuditReader {
  constructor(private readonly em: EntityManager) {}

  async query(spec: AuditQuerySpec): Promise<AuditEntry[]> {
    const where: FilterQuery<LoggedAction> = {};

    if (spec.schemaName) where.schemaName = spec.schemaName;
    if (spec.tableName) where.tableName = spec.tableName;
    if (spec.rowId) where.rowId = spec.rowId;
    if (spec.transactionId) where.transactionId = spec.transactionId;
    if (spec.changedBy) where.changedBy = spec.changedBy;

    if (spec.from || spec.to) {
      where.changedAt = {};
      if (spec.from) where.changedAt.$gte = spec.from;
      if (spec.to) where.changedAt.$lte = spec.to;
    }

    return this.em.find(LoggedAction, where, {
      orderBy: { changedAt: spec.order === 'asc' ? 'ASC' : 'DESC' },
    }) as unknown as Promise<AuditEntry[]>;
  }
}
