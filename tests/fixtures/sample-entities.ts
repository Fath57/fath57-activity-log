import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { LogsActivity } from '../../src/feed/decorators/logs-activity.decorator';

/** Client-assigned identifier: `subjectId` is known during onFlush. */
@Entity({ tableName: 'sample_invoices' })
@LogsActivity({
  logName: 'billing',
  logExcept: ['secretToken'],
  description: (event, entity: any) => `Invoice ${entity.reference} ${event}`,
})
export class SampleInvoice {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property()
  reference!: string;

  @Property({ type: 'decimal', precision: 12, scale: 2 })
  total: string = '0.00';

  @Property({ nullable: true })
  secretToken?: string;

  @Property({ type: 'timestamptz', nullable: true })
  deletedAt?: Date | null;
}

/** Database-generated identifier: exercises §4.5 `generatedIdStrategy`. */
@Entity({ tableName: 'sample_tickets' })
@LogsActivity({ logName: 'support' })
export class SampleTicket {
  @PrimaryKey()
  id!: number;

  @Property()
  title!: string;

  @Property({ default: 'open' })
  status: string = 'open';
}

/** Not decorated: must be ignored by the subscriber entirely. */
@Entity({ tableName: 'sample_untracked' })
export class SampleUntracked {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property()
  label!: string;
}

/** Exercises the instance-level dynamic override and its partial-merge contract. */
@Entity({ tableName: 'sample_dynamic' })
@LogsActivity({ logName: 'static-name', logOnly: ['label'] })
export class SampleDynamic {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property()
  label!: string;

  @Property({ nullable: true })
  note?: string;

  getActivitylogOptions() {
    // Only logName is set: logOnly must survive from the decorator level.
    return { logName: 'dynamic-name' };
  }
}
