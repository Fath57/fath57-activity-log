import { EntityCaseNamingStrategy, NamingStrategy } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { getFeedSchemaStatements } from '../../src/migrations/migration-helpers';
import { describe, expect, it } from 'vitest';
import { ActivityLogSchema } from '../../src/feed/entities/activity-log.entity';
import { ActivityOutboxSchema } from '../../src/feed/entities/activity-outbox.entity';
import { LoggedActionSchema } from '../../src/audit/entities/logged-action.entity';

/**
 * §9 — the entity schemas must describe the tables this package ships SQL for.
 *
 * The schemas and `migrations/sql/*.sql` are two descriptions of one table, kept
 * in step by hand. When they disagree the package still boots: the mismatch only
 * surfaces on the first insert, in the host application, as a column that does
 * not exist. Generating the DDL from the schemas and reading it back is the
 * cheapest way to keep the two honest.
 */
async function createSchemaSql(namingStrategy?: new () => NamingStrategy): Promise<string> {
  const orm = await MikroORM.init({
    dbName: 'ddl_only',
    entities: [ActivityLogSchema, ActivityOutboxSchema, LoggedActionSchema],
    connect: false,
    allowGlobalContext: true,
    discovery: { warnWhenNoEntities: false },
    ...(namingStrategy ? { namingStrategy } : {}),
  });
  try {
    return await orm.schema.getCreateSchemaSQL({ wrap: false });
  } finally {
    await orm.close(true);
  }
}

describe('entity schema DDL', () => {
  it('keeps the column types the shipped SQL declares', async () => {
    const sql = await createSchemaSql();

    // jsonb and timestamptz are the two that degrade silently: an EntitySchema
    // that says `type: 'jsonb'` (not a registered type name) yields a text column,
    // and the feed keeps working until someone queries `properties->>'x'`.
    expect(sql).toContain('"properties" jsonb null');
    expect(sql).toContain('"payload" jsonb not null');
    expect(sql).toContain('"created_at" timestamptz not null');
    expect(sql).toContain('"log_name" varchar(100) not null default \'default\'');
    expect(sql).toContain('"description" text not null');
    expect(sql).toContain('"attempts" int not null default 0');
  });

  it('gives logged_actions its audit schema and composite primary key', async () => {
    const sql = await createSchemaSql();

    expect(sql).toContain('create schema if not exists "audit"');
    expect(sql).toContain('create table "audit"."logged_actions"');
    expect(sql).toContain('primary key ("event_id", "changed_at")');
  });

  /**
   * The regression this pins: field names are spelled out in the schemas, so a
   * host application's naming strategy cannot rename the package's own columns
   * out from under the SQL it ships. A NestJS boilerplate on
   * EntityCaseNamingStrategy would otherwise look for "logName" in a table that
   * only ever has "log_name".
   */
  it('ignores the host application naming strategy', async () => {
    const sql = await createSchemaSql(EntityCaseNamingStrategy);

    expect(sql).toContain('"log_name"');
    expect(sql).toContain('"subject_type"');
    expect(sql).toContain('"created_at"');
    expect(sql).not.toContain('"logName"');
    expect(sql).not.toContain('"subjectType"');
    expect(sql).not.toContain('"createdAt"');
  });

  it('declares every column the feed schema SQL creates', async () => {
    const sql = await createSchemaSql();
    // Read from the statements the package actually runs, not from
    // migrations/sql/*.sql: those files are a second copy that nothing loads,
    // so a test reading them would pass while the shipped SQL drifted away.
    const shipped = getFeedSchemaStatements().join('\n');

    const columns = [...shipped.matchAll(/^\s{4}([a-z_]+)\s+[A-Z]/gm)].map((m) => m[1]);
    expect(columns.length).toBeGreaterThan(10);
    for (const column of columns) {
      expect(sql, `${column} missing from the generated DDL`).toContain(`"${column}"`);
    }
  });
});
