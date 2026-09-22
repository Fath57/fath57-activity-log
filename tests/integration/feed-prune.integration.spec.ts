import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { createAdminClient, resetSchema } from '../fixtures/test-database.helper';
import {
  clearSampleData,
  createOrm,
  createSampleTables,
  dropSampleTables,
  OrmHarness,
} from '../fixtures/orm.helper';
import { ActivityQueryService } from '../../src/feed/services/activity-query.service';
import { MikroOrmActivityReader } from '../../src/adapters/mikro-orm/mikro-orm-activity-reader';

/** Review finding R3-8: prune() needs an index, and must not run unbounded. */
describe('ActivityQueryService.prune()', () => {
  let admin: Client;
  let h: OrmHarness;
  let query: ActivityQueryService;

  const seedLogs = async (count: number, daysAgo: number) => {
    const values: string[] = [];
    const params: any[] = [];
    for (let i = 0; i < count; i++) {
      const base = i * 3;
      values.push(`($${base + 1}, 'billing', 'seed', now() - ($${base + 2}::int || ' days')::interval, $${base + 3})`);
      params.push(randomUUID(), daysAgo, `tenant-${i % 2}`);
    }
    await admin.query(
      `INSERT INTO activity_logs (id, log_name, description, created_at, tenant_id) VALUES ${values.join(',')}`,
      params,
    );
  };

  beforeAll(async () => {
    admin = await createAdminClient();
    await resetSchema(admin);
    await createSampleTables(admin);
    h = await createOrm({ withAudit: false });
    // The service takes the port now, not an EntityManager; the harness
    // supplies the MikroORM implementation of it directly.
    query = new ActivityQueryService(new MikroOrmActivityReader(h.em as any), h.context);
  });

  afterAll(async () => {
    await h?.close();
    await dropSampleTables(admin);
    await admin.end();
  });

  beforeEach(async () => {
    await clearSampleData(admin);
    h.em.clear();
  });

  it('deletes only rows older than the cutoff', async () => {
    await seedLogs(10, 400);
    await seedLogs(5, 10);

    const cutoff = new Date(Date.now() - 100 * 24 * 3600 * 1000);
    const deleted = await query.prune(cutoff);

    expect(deleted).toBe(10);
    const remaining = await admin.query('SELECT count(*)::int AS n FROM activity_logs');
    expect(remaining.rows[0].n).toBe(5);
  });

  it('deletes across every tenant: retention is not tenant-scoped', async () => {
    await seedLogs(6, 400);

    const deleted = await query.prune(new Date(Date.now() - 100 * 24 * 3600 * 1000));

    expect(deleted).toBe(6);
  });

  it('works in bounded batches rather than one large statement', async () => {
    await seedLogs(25, 400);

    const deleted = await query.prune(new Date(Date.now() - 100 * 24 * 3600 * 1000), {
      batchSize: 10,
    });

    expect(deleted).toBe(25);
    const remaining = await admin.query('SELECT count(*)::int AS n FROM activity_logs');
    expect(remaining.rows[0].n).toBe(0);
  });

  it('returns 0 when nothing is old enough', async () => {
    await seedLogs(5, 1);
    expect(await query.prune(new Date(Date.now() - 100 * 24 * 3600 * 1000))).toBe(0);
  });

  it('uses idx_activity_logs_created rather than a sequential scan', async () => {
    // The point of R3-8. Without a leading-createdAt index this plan is a seq scan
    // on the largest table in the package.
    await seedLogs(500, 400);
    await admin.query('ANALYZE activity_logs');
    await admin.query('SET enable_seqscan = off');
    try {
      const plan = await admin.query(
        `EXPLAIN (FORMAT JSON)
         SELECT id FROM activity_logs WHERE created_at < now() - interval '100 days' LIMIT 100`,
      );
      const text = JSON.stringify(plan.rows[0]['QUERY PLAN']);
      expect(text).toContain('idx_activity_logs_created');
    } finally {
      await admin.query('SET enable_seqscan = on');
    }
  });
});
