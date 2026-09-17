import { EntitySchema } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { LogsActivity } from '../../src/feed/decorators/logs-activity.decorator';

/**
 * Declared as EntitySchemas, like the package's own entities, so the suite runs
 * against MikroORM 6 and 7 alike — v7 moved the decorators out of
 * `@mikro-orm/core`. `@LogsActivity` stays: it is a plain class decorator that
 * registers metadata with this package and touches no ORM.
 *
 * The tables are created by raw SQL in orm.helper.ts, so every `fieldName` is
 * pinned rather than left to a naming strategy.
 */

/** Client-assigned identifier: `subjectId` is known during onFlush. */
@LogsActivity({
  logName: 'billing',
  logExcept: ['secretToken'],
  description: (event, entity: any) => `Invoice ${entity.reference} ${event}`,
})
export class SampleInvoice {
  id: string = randomUUID();
  reference!: string;
  total: string = '0.00';
  secretToken?: string;
  deletedAt?: Date | null;
}

export const SampleInvoiceSchema = new EntitySchema<SampleInvoice>({
  class: SampleInvoice,
  tableName: 'sample_invoices',
  properties: {
    id: { type: 'uuid', fieldName: 'id', primary: true },
    reference: { type: 'string', fieldName: 'reference' },
    total: { type: 'decimal', fieldName: 'total', precision: 12, scale: 2 },
    secretToken: { type: 'string', fieldName: 'secret_token', nullable: true },
    deletedAt: {
      type: 'datetime',
      fieldName: 'deleted_at',
      columnType: 'timestamptz',
      nullable: true,
    },
  },
});

/**
 * Database-generated identifier: exercises §4.5 `generatedIdStrategy`.
 *
 * The description reads the primary key on purpose. At onFlush the SERIAL key
 * does not exist yet, so this is the shape that used to render "Ticket undefined
 * created" on a row whose subject_id resolved correctly.
 */
@LogsActivity({
  logName: 'support',
  description: (event, ticket: SampleTicket) => `Ticket #${ticket.id} ${event}`,
})
export class SampleTicket {
  id!: number;
  title!: string;
  status: string = 'open';
}

export const SampleTicketSchema = new EntitySchema<SampleTicket>({
  class: SampleTicket,
  tableName: 'sample_tickets',
  properties: {
    id: { type: 'integer', fieldName: 'id', primary: true, autoincrement: true },
    title: { type: 'string', fieldName: 'title' },
    status: { type: 'string', fieldName: 'status', default: 'open' },
  },
});

/** Not registered: must be ignored by the subscriber entirely. */
export class SampleUntracked {
  id: string = randomUUID();
  label!: string;
}

export const SampleUntrackedSchema = new EntitySchema<SampleUntracked>({
  class: SampleUntracked,
  tableName: 'sample_untracked',
  properties: {
    id: { type: 'uuid', fieldName: 'id', primary: true },
    label: { type: 'string', fieldName: 'label' },
  },
});

/** Exercises the instance-level dynamic override and its partial-merge contract. */
@LogsActivity({ logName: 'static-name', logOnly: ['label'] })
export class SampleDynamic {
  id: string = randomUUID();
  label!: string;
  note?: string;

  getActivitylogOptions() {
    // Only logName is set: logOnly must survive from the decorator level.
    return { logName: 'dynamic-name' };
  }
}

export const SampleDynamicSchema = new EntitySchema<SampleDynamic>({
  class: SampleDynamic,
  tableName: 'sample_dynamic',
  properties: {
    id: { type: 'uuid', fieldName: 'id', primary: true },
    label: { type: 'string', fieldName: 'label' },
    note: { type: 'string', fieldName: 'note', nullable: true },
  },
});
