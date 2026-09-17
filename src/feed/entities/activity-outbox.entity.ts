import { Entity, PrimaryKey, Property, Index } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';

@Entity({ tableName: 'activity_outbox' })
@Index({ name: 'idx_activity_outbox_pending', properties: ['createdAt'] })
export class ActivityOutbox {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property({ type: 'jsonb' })
  payload!: Record<string, any>;

  @Property({ type: 'timestamptz' })
  createdAt: Date = new Date();

  @Property({ type: 'integer' })
  attempts: number = 0;
}
