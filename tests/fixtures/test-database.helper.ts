import { Client, Pool, PoolClient } from 'pg';
import {
  getAuditSchemaStatements,
  getFeedSchemaStatements,
  getDropAuditSchemaStatements,
  getDropFeedSchemaStatements,
  getTrackTableSql,
} from '../../src/migrations';

/**
 * Connection settings for the throwaway Postgres used by the integration suite.
 * Override with PG* env vars in CI.
 */
export const TEST_DB = {
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 55432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'test',
  database: process.env.PGDATABASE ?? 'fath57_test',
};

export function createPool(
  overrides: Partial<typeof TEST_DB> & { max?: number } = {},
): Pool {
  return new Pool({ max: 8, ...TEST_DB, ...overrides });
}

/** Owner connection used to build and tear down fixtures. */
export async function createAdminClient(): Promise<Client> {
  const client = new Client(TEST_DB);
  await client.connect();
  return client;
}

async function runAll(client: Client, statements: string[]): Promise<void> {
  for (const sql of statements) {
    await client.query(sql);
  }
}

/** Rebuilds the package schema from scratch. */
export async function resetSchema(client: Client): Promise<void> {
  await client.query('DROP TABLE IF EXISTS public.invoices CASCADE;');
  await client.query('DROP TABLE IF EXISTS public.order_lines CASCADE;');
  await runAll(client, getDropAuditSchemaStatements());
  await runAll(client, getDropFeedSchemaStatements());

  await runAll(client, getFeedSchemaStatements());
  await runAll(client, getAuditSchemaStatements());
}

/** A single-PK business table, audited, with a secret column that must be stripped. */
export async function createInvoicesTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE public.invoices (
      id           UUID PRIMARY KEY,
      reference    TEXT NOT NULL,
      total        NUMERIC(12,2) NOT NULL DEFAULT 0,
      secret_token TEXT,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await client.query(
    getTrackTableSql('public.invoices', ['id'], ['secret_token'], false),
  );
}

/** A composite-PK business table. */
export async function createOrderLinesTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE public.order_lines (
      order_id INTEGER NOT NULL,
      line_id  INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (order_id, line_id)
    );
  `);
  await client.query(
    getTrackTableSql('public.order_lines', ['order_id', 'line_id'], [], false),
  );
}

export async function auditRows(
  client: Client | PoolClient,
  table = 'invoices',
): Promise<any[]> {
  const res = await client.query(
    `SELECT * FROM audit.logged_actions WHERE table_name = $1 ORDER BY event_id`,
    [table],
  );
  return res.rows;
}

export async function truncateAudit(client: Client): Promise<void> {
  await client.query('TRUNCATE audit.logged_actions;');
}

/** Creates a LOGIN role for privilege tests and returns a pool connected as it. */
export async function createLoginRole(
  admin: Client,
  name: string,
  password = 'pw',
): Promise<Pool> {
  await dropLoginRole(admin, name);
  await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}';`);
  await admin.query(`GRANT CREATE, USAGE ON SCHEMA public TO ${name};`);
  return createPool({ user: name, password });
}

export async function dropLoginRole(admin: Client, name: string): Promise<void> {
  await admin.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN
        EXECUTE 'REASSIGN OWNED BY ${name} TO postgres';
        EXECUTE 'DROP OWNED BY ${name}';
        EXECUTE 'DROP ROLE ${name}';
      END IF;
    END $$;
  `);
}
