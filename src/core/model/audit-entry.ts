/**
 * A row of the audit trail, as the core sees it: plain data, no ORM.
 *
 * The field list is spelled out again rather than shared with
 * `audit/entities/logged-action.entity.ts`, because the core may not import an
 * outer ring — the same boundary `ActivityRecord` sits on. The two shapes are
 * kept in step by the conformance suite, which is written against this one.
 */
export interface AuditEntry {
  eventId: string;
  changedAt: Date;
  schemaName: string;
  tableName: string;
  /** Scalar when rowIdIsJson is false; a canonical JSON object otherwise. */
  rowId: string;
  rowIdIsJson: boolean;
  action: 'I' | 'U' | 'D';
  oldData?: Record<string, any>;
  newData?: Record<string, any>;
  changedFields?: Record<string, any>;
  changedBy?: string;
  sessionUserName: string;
  clientAddr?: string;
  bypassAttempted: boolean;
  clientQuery?: string;
  transactionId: string;
}
