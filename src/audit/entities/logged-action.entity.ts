import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ schema: 'audit', tableName: 'logged_actions', readonly: true })
export class LoggedAction {
  @PrimaryKey({ type: 'bigint' })
  eventId!: string;

  @PrimaryKey({ type: 'timestamptz' })
  changedAt!: Date;

  @Property()
  schemaName!: string;

  @Property()
  tableName!: string;

  /** Scalar when rowIdIsJson is false; a canonical JSON object otherwise. */
  @Property()
  rowId!: string;

  @Property()
  rowIdIsJson: boolean = false;

  @Property({ length: 1 })
  action!: 'I' | 'U' | 'D';

  @Property({ type: 'jsonb', nullable: true })
  oldData?: Record<string, any>;

  @Property({ type: 'jsonb', nullable: true })
  newData?: Record<string, any>;

  @Property({ type: 'jsonb', nullable: true })
  changedFields?: Record<string, any>;

  @Property({ nullable: true })
  changedBy?: string;

  @Property()
  sessionUserName!: string;

  @Property({ nullable: true })
  clientAddr?: string;

  @Property()
  bypassAttempted: boolean = false;

  @Property({ nullable: true })
  clientQuery?: string;

  @Property({ type: 'string' })
  transactionId!: string;
}
