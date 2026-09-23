import { Inject, Injectable } from '@nestjs/common';
import { AuditEntry, AuditReader } from '../../core';
import { AUDIT_READER } from '../constants/audit.constants';

/**
 * The named questions an application asks of the audit trail.
 *
 * Every one of them is the same port call with a different spec; what lives here
 * is the vocabulary, plus the row-id normalisation, which is a property of how
 * the triggers write jsonb rather than of any ORM.
 */
@Injectable()
export class AuditQueryService {
  constructor(@Inject(AUDIT_READER) private readonly reader: AuditReader) {}

  async findForRow(
    schema: string,
    table: string,
    rowId: string | Record<string, any>,
  ): Promise<AuditEntry[]> {
    return this.reader.query({
      schemaName: schema,
      tableName: table,
      rowId: this.formatRowId(rowId),
    });
  }

  /** Ascending: a transaction reads as the sequence of what it did. */
  async findForTransaction(transactionId: string): Promise<AuditEntry[]> {
    return this.reader.query({ transactionId, order: 'asc' });
  }

  async findForUser(
    changedBy: string,
    dateRange?: { from?: Date; to?: Date },
  ): Promise<AuditEntry[]> {
    return this.reader.query({
      changedBy,
      from: dateRange?.from,
      to: dateRange?.to,
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
