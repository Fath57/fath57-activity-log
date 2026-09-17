import { Entity, PrimaryKey, Property, Index } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';

@Entity({ tableName: 'activity_logs' })
@Index({
  name: 'idx_activity_logs_subject',
  properties: ['tenantId', 'subjectType', 'subjectId', 'createdAt'],
})
@Index({
  name: 'idx_activity_logs_causer',
  properties: ['tenantId', 'causerType', 'causerId', 'createdAt'],
})
@Index({
  name: 'idx_activity_logs_feed',
  properties: ['tenantId', 'logName', 'createdAt'],
})
@Index({
  name: 'idx_activity_logs_created',
  properties: ['createdAt'],
})
export class ActivityLog {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property({ length: 100 })
  logName: string = 'default';

  @Property({ type: 'text' })
  description!: string;

  @Property({ length: 150, nullable: true })
  subjectType?: string;

  @Property({ length: 100, nullable: true })
  subjectId?: string;

  @Property({ length: 150, nullable: true })
  causerType?: string;

  @Property({ length: 100, nullable: true })
  causerId?: string;

  @Property({ length: 50, nullable: true })
  event?: 'created' | 'updated' | 'deleted' | (string & {});

  @Property({ type: 'jsonb', nullable: true })
  properties?: Record<string, any>;

  @Property({ length: 100, nullable: true })
  tenantId?: string;

  @Property({ type: 'timestamptz' })
  createdAt: Date = new Date();
}
