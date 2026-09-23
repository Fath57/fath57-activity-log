
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
