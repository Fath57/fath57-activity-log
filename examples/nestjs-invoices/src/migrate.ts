import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  getAuditSchemaStatements,
  getFeedSchemaStatements,
  getInitialPartitionStatements,
  getTrackTableSql,
} from 'fath57-activity-log/migrations';
import { ormConfig } from './mikro-orm.config';

/**
 * Stands in for a real MikroORM migration so the example runs with one command.
 * In an application this is the body of `Migration.up()`; the statements are the
 * same and in the same order.
 */
async function migrate(): Promise<void> {
  const orm = await MikroORM.init(ormConfig);
  const conn = orm.em.getConnection();

  const run = async (label: string, statements: string[]) => {
    for (const sql of statements) {
      await conn.execute(sql);
    }
    // eslint-disable-next-line no-console
    console.log(`  ${label}: ${statements.length} statement(s)`);
  };

  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS public.invoices (
        id             UUID PRIMARY KEY,
        reference      VARCHAR(255) NOT NULL,
        total          NUMERIC(12,2) NOT NULL DEFAULT 0,
        internal_notes VARCHAR(255),
        deleted_at     TIMESTAMPTZ
      );
    `);
    console.log('  business table: public.invoices');

    await run('feed schema', getFeedSchemaStatements());
    await run('audit schema', getAuditSchemaStatements());

    // Pre-create the current month plus three. Without the scheduled top-up in
    // AuditMaintenanceService, everything after that falls into DEFAULT.
    await run('partitions', getInitialPartitionStatements(new Date(), 4));

    // internal_notes is ignored on BOTH sides: @LogsActivity keeps it out of the
    // feed, this keeps it out of the audit payload.
    await conn.execute(getTrackTableSql('public.invoices', ['id'], ['internal_notes']));
    console.log('  audit triggers: public.invoices');

    console.log('\nmigrated. Run `npm start`.');
    console.log(
      'Remember: the hardening script still has to be run once by a DBA — the app ' +
        'will print it at boot until that is done.',
    );
  } finally {
    await orm.close(true);
  }
}

void migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
