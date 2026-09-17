import { defineConfig } from '@mikro-orm/postgresql';
import { ActivityLog, ActivityOutbox, LoggedAction } from 'fath-activity-log/mikro-orm';
import { Invoice } from './invoices/invoice.entity';

export const ormConfig = defineConfig({
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 55432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'test',
  dbName: process.env.PGDATABASE ?? 'fath_test',
  entities: [Invoice, ActivityLog, ActivityOutbox, LoggedAction],
  // The audit schema is partitioned and owned by migrations; keep the schema
  // generator away from it.
  schemaGenerator: { disableForeignKeys: false },
  discovery: { warnWhenNoEntities: false },
  debug: false,
});
