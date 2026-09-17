import { EntitySchema } from '@mikro-orm/core';

export class LoggedAction {
  eventId!: string;
  changedAt!: Date;
  schemaName!: string;
  tableName!: string;
  /** Scalar when rowIdIsJson is false; a canonical JSON object otherwise. */
  rowId!: string;
  rowIdIsJson: boolean = false;
  action!: 'I' | 'U' | 'D';
  oldData?: Record<string, any>;
  newData?: Record<string, any>;
  changedFields?: Record<string, any>;
  changedBy?: string;
  sessionUserName!: string;
  clientAddr?: string;
  bypassAttempted: boolean = false;
  clientQuery?: string;
  transactionId!: string;
}

/**
 * See `ActivityLogSchema` for why this is an `EntitySchema` with pinned field names.
 *
 * `readonly` because the table is written by the audit triggers in
 * `migrations/sql/audit-schema.sql`, never by the ORM.
 */
export const LoggedActionSchema = new EntitySchema<LoggedAction>({
  class: LoggedAction,
  schema: 'audit',
  tableName: 'logged_actions',
  readonly: true,
  properties: {
    eventId: { type: 'bigint', fieldName: 'event_id', primary: true },
    changedAt: { type: 'datetime', fieldName: 'changed_at', columnType: 'timestamptz', primary: true },
    schemaName: { type: 'string', fieldName: 'schema_name' },
    tableName: { type: 'string', fieldName: 'table_name' },
    rowId: { type: 'string', fieldName: 'row_id' },
    rowIdIsJson: { type: 'boolean', fieldName: 'row_id_is_json', default: false },
    action: { type: 'string', fieldName: 'action', length: 1 },
    oldData: { type: 'json', fieldName: 'old_data', columnType: 'jsonb', nullable: true },
    newData: { type: 'json', fieldName: 'new_data', columnType: 'jsonb', nullable: true },
    changedFields: { type: 'json', fieldName: 'changed_fields', columnType: 'jsonb', nullable: true },
    changedBy: { type: 'string', fieldName: 'changed_by', nullable: true },
    sessionUserName: { type: 'string', fieldName: 'session_user_name' },
    clientAddr: { type: 'string', fieldName: 'client_addr', nullable: true },
    bypassAttempted: { type: 'boolean', fieldName: 'bypass_attempted', default: false },
    clientQuery: { type: 'string', fieldName: 'client_query', nullable: true },
    transactionId: { type: 'string', fieldName: 'transaction_id' },
  },
});
