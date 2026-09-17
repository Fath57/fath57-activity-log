import { afterAll, beforeAll } from 'vitest';
import { Client } from 'pg';
import { createAdminClient, resetSchema } from '../fixtures/test-database.helper';
import {
  createOrm,
  createSampleTables,
  dropSampleTables,
  OrmHarness,
} from '../fixtures/orm.helper';
import { MikroOrmActivityAdapter } from '../../src/adapters/mikro-orm/mikro-orm.adapter';
import {
  ConformanceContext,
  describeAdapterConformance,
} from '../conformance/adapter-conformance.suite';
import { ActivityRecord } from '../../src/core/model/activity-record';

/**
 * Runs the shared adapter conformance suite against the reference profile.
 *
 * When a second adapter lands, it gets a file exactly like this one — the suite
 * itself must not need a line of change. If it does, the ports were under-
 * specified and the portability claim of §11 was never real.
 */
let admin: Client;
let h: OrmHarness;
let adapter: MikroOrmActivityAdapter;

beforeAll(async () => {
  admin = await createAdminClient();
  await resetSchema(admin);
  await createSampleTables(admin);
  h = await createOrm({ withAudit: false });
  adapter = new MikroOrmActivityAdapter(h.em as any);
});

afterAll(async () => {
  await h?.close();
  await dropSampleTables(admin);
  await admin.end();
});

describeAdapterConformance('mikro-orm + postgres', (): ConformanceContext => ({
  adapter,

  withTransaction: (fn) => h.em.transactional((em) => fn((em as any).getTransactionContext())),

  withRollback: async (fn) => {
    await h.em
      .transactional(async (em) => {
        await fn((em as any).getTransactionContext());
        throw new Error('__rollback__');
      })
      .catch((err) => {
        if (err?.message !== '__rollback__') throw err;
      });
  },

  readAllRecords: async () => {
    const res = await admin.query('SELECT * FROM activity_logs ORDER BY created_at DESC, id DESC');
    return res.rows.map(
      (r): ActivityRecord => ({
        id: r.id,
        logName: r.log_name,
        description: r.description,
        subjectType: r.subject_type ?? undefined,
        subjectId: r.subject_id ?? undefined,
        causerType: r.causer_type ?? undefined,
        causerId: r.causer_id ?? undefined,
        event: r.event ?? undefined,
        properties: r.properties ?? undefined,
        tenantId: r.tenant_id ?? undefined,
        createdAt: r.created_at,
      }),
    );
  },

  reset: async () => {
    await admin.query('TRUNCATE activity_logs, activity_outbox');
    h.em.clear();
  },

  readAttribution: (tx) => adapter.binder.currentValue(tx),
}));
