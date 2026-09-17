import { EntitySchema } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';

export class ActivityOutbox {
  id: string = randomUUID();
  payload!: Record<string, any>;
  createdAt: Date = new Date();
  attempts: number = 0;
}

/** See `ActivityLogSchema` for why this is an `EntitySchema` with pinned field names. */
export const ActivityOutboxSchema = new EntitySchema<ActivityOutbox>({
  class: ActivityOutbox,
  tableName: 'activity_outbox',
  indexes: [{ name: 'idx_activity_outbox_pending', properties: ['createdAt'] }],
  properties: {
    id: { type: 'uuid', fieldName: 'id', primary: true },
    payload: { type: 'json', fieldName: 'payload', columnType: 'jsonb' },
    createdAt: { type: 'datetime', fieldName: 'created_at', columnType: 'timestamptz' },
    attempts: { type: 'integer', fieldName: 'attempts', default: 0 },
  },
});
