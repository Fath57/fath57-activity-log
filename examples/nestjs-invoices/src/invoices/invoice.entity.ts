import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { LogsActivity } from '@fath57/activity-log';

/**
 * `internalNotes` is excluded from the feed AND passed to the trigger as an
 * ignored column at migration time. Both sides need telling: the decorator keeps
 * it out of activity_logs.properties, ARRAY['internal_notes'] keeps it out of the
 * audit payload.
 */
@Entity({ tableName: 'invoices' })
@LogsActivity({
  logName: 'billing',
  logExcept: ['internalNotes'],
  description: (event, invoice: Invoice) => `Invoice ${invoice.reference} ${event}`,
})
export class Invoice {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property()
  reference!: string;

  @Property({ type: 'decimal', precision: 12, scale: 2 })
  total: string = '0.00';

  @Property({ nullable: true })
  internalNotes?: string;

  @Property({ type: 'timestamptz', nullable: true })
  deletedAt?: Date | null;
}
