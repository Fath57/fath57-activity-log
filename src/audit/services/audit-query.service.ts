import { Injectable } from '@nestjs/common';
import { EntityManager, FilterQuery } from '@mikro-orm/core';
import { LoggedAction } from '../entities/logged-action.entity';

@Injectable()
export class AuditQueryService {
  constructor(private readonly em: EntityManager) {}

  async findForRow(
    schema: string,
    table: string,
    rowId: string | Record<string, any>,
  ): Promise<LoggedAction[]> {
    const formattedRowId = this.formatRowId(rowId);
    return this.em.find(
      LoggedAction,
      {
        schemaName: schema,
        tableName: table,
        rowId: formattedRowId,
      },
      {
        orderBy: { changedAt: 'DESC' },
      },
    );
  }

  async findForTransaction(transactionId: string): Promise<LoggedAction[]> {
    return this.em.find(
      LoggedAction,
      { transactionId },
      { orderBy: { changedAt: 'ASC' } },
    );
  }

  async findForUser(
    changedBy: string,
    dateRange?: { from?: Date; to?: Date },
  ): Promise<LoggedAction[]> {
    const where: FilterQuery<LoggedAction> = { changedBy };
    if (dateRange?.from || dateRange?.to) {
      where.changedAt = {};
      if (dateRange.from) {
        where.changedAt.$gte = dateRange.from;
      }
      if (dateRange.to) {
        where.changedAt.$lte = dateRange.to;
      }
    }

    return this.em.find(LoggedAction, where, {
      orderBy: { changedAt: 'DESC' },
    });
  }

  formatRowId(rowId: string | Record<string, any>): string {
    if (typeof rowId === 'string') {
      return rowId;
    }

    // Sort keys canonically to match postgres jsonb key ordering
    const sortedKeys = Object.keys(rowId).sort();
    const normalized: Record<string, any> = {};
    for (const key of sortedKeys) {
      normalized[key] = rowId[key];
    }
    return JSON.stringify(normalized);
  }
}
