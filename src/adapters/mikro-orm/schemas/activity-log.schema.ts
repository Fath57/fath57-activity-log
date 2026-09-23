import { EntitySchema } from '@mikro-orm/core';
import { ActivityLog } from '../../../feed/entities/activity-log.entity';

/**
 * Declared as an `EntitySchema` rather than with decorators (§9).
 *
 * MikroORM moved `@Entity`/`@Property` out of `@mikro-orm/core` in v7, and the
 * decorator flavour a consumer chose (legacy or standard) has to match the
 * `metadataProvider` their application configures. `EntitySchema` is exported
 * unchanged by v6 and v7 and is provider-agnostic, so one build serves both.
 *
 * Every `fieldName` is spelled out on purpose. The columns are fixed by the SQL
 * `getFeedSchemaStatements()` installs; without them a host application running a
 * non-default `namingStrategy` — `EntityCaseNamingStrategy`, say — would have
 * MikroORM look for `logName` in a table that only has `log_name`, and every
 * insert would fail.
 */
export const ActivityLogSchema = new EntitySchema<ActivityLog>({
  class: ActivityLog,
  tableName: 'activity_logs',
  indexes: [
    {
      name: 'idx_activity_logs_subject',
      properties: ['tenantId', 'subjectType', 'subjectId', 'createdAt'],
    },
    {
      name: 'idx_activity_logs_causer',
      properties: ['tenantId', 'causerType', 'causerId', 'createdAt'],
    },
    {
      name: 'idx_activity_logs_feed',
      properties: ['tenantId', 'logName', 'createdAt'],
    },
    {
      name: 'idx_activity_logs_created',
      properties: ['createdAt'],
    },
  ],
  properties: {
    id: { type: 'uuid', fieldName: 'id', primary: true },
    logName: { type: 'string', fieldName: 'log_name', length: 100, default: 'default' },
    description: { type: 'text', fieldName: 'description' },
    subjectType: { type: 'string', fieldName: 'subject_type', length: 150, nullable: true },
    subjectId: { type: 'string', fieldName: 'subject_id', length: 100, nullable: true },
    causerType: { type: 'string', fieldName: 'causer_type', length: 150, nullable: true },
    causerId: { type: 'string', fieldName: 'causer_id', length: 100, nullable: true },
    event: { type: 'string', fieldName: 'event', length: 50, nullable: true },
    properties: { type: 'json', fieldName: 'properties', columnType: 'jsonb', nullable: true },
    tenantId: { type: 'string', fieldName: 'tenant_id', length: 100, nullable: true },
    createdAt: { type: 'datetime', fieldName: 'created_at', columnType: 'timestamptz' },
  },
});
