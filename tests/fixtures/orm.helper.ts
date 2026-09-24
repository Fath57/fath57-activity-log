import { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import { RequestContextService } from '../../src/common/request-context.service';
import { ActivityLogSchema } from '../../src/adapters/mikro-orm/schemas/activity-log.schema';
import { ActivityOutboxSchema } from '../../src/adapters/mikro-orm/schemas/activity-outbox.schema';
import { ActivitySubscriber } from '../../src/adapters/mikro-orm/activity.subscriber';
import { AuditSessionSubscriber } from '../../src/adapters/mikro-orm/audit-session.subscriber';
import { FeedModuleOptions } from '../../src/core/interfaces/activity-options.interface';
import { AuditModuleOptions } from '../../src/audit/interfaces/audit-options.interface';
import {
  SampleDynamicSchema,
  SampleInvoiceSchema,
  SampleTicketSchema,
  SampleUntrackedSchema,
} from './sample-entities';
import { TEST_DB } from './test-database.helper';

export interface OrmHarness {
  orm: MikroORM;
  em: EntityManager;
  context: RequestContextService;
  close(): Promise<void>;
}

/**
 * Boots MikroORM against the integration database with the feed and audit
 * subscribers wired the way FeedModule / AuditModule wire them at runtime.
 */
export async function createOrm(opts?: {
  feed?: Partial<FeedModuleOptions>;
  audit?: Partial<AuditModuleOptions>;
  withAudit?: boolean;
}): Promise<OrmHarness> {
  const context = new RequestContextService();

  const subscribers: any[] = [
    new ActivitySubscriber(context, opts?.feed as FeedModuleOptions),
  ];
  if (opts?.withAudit !== false) {
    subscribers.push(
      new AuditSessionSubscriber(context, {
        sessionVariableName: 'app.current_user_id',
        sessionBinding: 'eager',
        captureClientQuery: false,
        ...opts?.audit,
      } as AuditModuleOptions),
    );
  }

  const orm = await MikroORM.init({
    host: TEST_DB.host,
    port: TEST_DB.port,
    user: TEST_DB.user,
    password: TEST_DB.password,
    dbName: TEST_DB.database,
    entities: [
      ActivityLogSchema,
      ActivityOutboxSchema,
      SampleInvoiceSchema,
      SampleTicketSchema,
      SampleUntrackedSchema,
      SampleDynamicSchema,
    ],
    subscribers,
    allowGlobalContext: true,
    debug: false,
  });

  return {
    // Cast through unknown: MikroORM 7 infers the entities array into the
    // MikroORM generics, so the instance no longer matches the plain postgres
    // flavour the harness exposes. The runtime object is the same one.
    orm: orm as unknown as MikroORM,
    em: orm.em.fork() as unknown as EntityManager,
    context,
    close: () => orm.close(true),
  };
}

/** Creates the sample business tables. Owned by the suite, not by the package. */
export async function createSampleTables(client: Client): Promise<void> {
  await dropSampleTables(client);
  await client.query(`
    CREATE TABLE public.sample_invoices (
      id            UUID PRIMARY KEY,
      reference     VARCHAR(255) NOT NULL,
      total         NUMERIC(12,2) NOT NULL DEFAULT 0,
      secret_token  VARCHAR(255),
      deleted_at    TIMESTAMPTZ
    );
  `);
  await client.query(`
    CREATE TABLE public.sample_tickets (
      id     SERIAL PRIMARY KEY,
      title  VARCHAR(255) NOT NULL,
      status VARCHAR(255) NOT NULL DEFAULT 'open'
    );
  `);
  await client.query(`
    CREATE TABLE public.sample_untracked (
      id    UUID PRIMARY KEY,
      label VARCHAR(255) NOT NULL
    );
  `);
  await client.query(`
    CREATE TABLE public.sample_dynamic (
      id    UUID PRIMARY KEY,
      label VARCHAR(255) NOT NULL,
      note  VARCHAR(255)
    );
  `);
}

export async function dropSampleTables(client: Client): Promise<void> {
  for (const t of ['sample_invoices', 'sample_tickets', 'sample_untracked', 'sample_dynamic']) {
    await client.query(`DROP TABLE IF EXISTS public.${t} CASCADE;`);
  }
}

export async function clearSampleData(client: Client): Promise<void> {
  await client.query(`
    TRUNCATE public.sample_invoices, public.sample_tickets,
             public.sample_untracked, public.sample_dynamic,
             public.activity_logs, public.activity_outbox
    RESTART IDENTITY;
  `);
}

export async function feedRows(client: Client): Promise<any[]> {
  const res = await client.query('SELECT * FROM public.activity_logs ORDER BY created_at, id');
  return res.rows;
}
