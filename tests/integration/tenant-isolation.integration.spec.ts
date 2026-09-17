import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createAdminClient, resetSchema } from '../fixtures/test-database.helper';
import {
  clearSampleData,
  createOrm,
  createSampleTables,
  dropSampleTables,
  OrmHarness,
} from '../fixtures/orm.helper';
import { SampleInvoice } from '../fixtures/sample-entities';
import { ActivityQueryService } from '../../src/feed/services/activity-query.service';

/** Review finding R2-5: reads must not cross tenants by default. */
describe('ActivityQueryService tenant isolation', () => {
  let admin: Client;
  let h: OrmHarness;
  let query: ActivityQueryService;

  const seedFor = async (tenantId: string, reference: string) => {
    await h.context.runWith({ userId: `u-${tenantId}`, causerType: 'User', tenantId }, async () => {
      const invoice = new SampleInvoice();
      invoice.reference = reference;
      await h.em.persistAndFlush(invoice);
    });
    h.em.clear();
  };

  beforeAll(async () => {
    admin = await createAdminClient();
    await resetSchema(admin);
    await createSampleTables(admin);
    h = await createOrm({ withAudit: false });
    query = new ActivityQueryService(h.em as any, h.context);
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

  it('scopes findFeed to the ambient tenant', async () => {
    await seedFor('tenant-a', 'A-1');
    await seedFor('tenant-b', 'B-1');

    const page = await h.context.runWith({ tenantId: 'tenant-a' }, () =>
      query.findFeed('billing'),
    );

    expect(page.data).toHaveLength(1);
    expect(page.data[0].tenantId).toBe('tenant-a');
  });

  it('scopes findForCauser to the ambient tenant', async () => {
    await seedFor('tenant-a', 'A-2');
    await seedFor('tenant-b', 'B-2');

    const page = await h.context.runWith({ tenantId: 'tenant-b' }, () =>
      query.findForCauser('User', 'u-tenant-b'),
    );

    expect(page.data).toHaveLength(1);
    expect(page.data[0].tenantId).toBe('tenant-b');
  });

  it('honours an explicit tenantId over the ambient one', async () => {
    await seedFor('tenant-a', 'A-3');
    await seedFor('tenant-b', 'B-3');

    const page = await h.context.runWith({ tenantId: 'tenant-a' }, () =>
      query.findFeed('billing', { tenantId: 'tenant-b' }),
    );

    expect(page.data).toHaveLength(1);
    expect(page.data[0].tenantId).toBe('tenant-b');
  });

  it('crosses tenants only when tenantId is explicitly null', async () => {
    await seedFor('tenant-a', 'A-4');
    await seedFor('tenant-b', 'B-4');

    const page = await h.context.runWith({ tenantId: 'tenant-a' }, () =>
      query.findFeed('billing', { tenantId: null }),
    );

    expect(page.data).toHaveLength(2);
  });

  it('scopes countForSubject the same way', async () => {
    await seedFor('tenant-a', 'A-5');
    const rows = await admin.query('SELECT subject_id FROM activity_logs LIMIT 1');
    const subjectId = rows.rows[0].subject_id;

    const scoped = await h.context.runWith({ tenantId: 'tenant-b' }, () =>
      query.countForSubject('SampleInvoice', subjectId),
    );
    const crossing = await query.countForSubject('SampleInvoice', subjectId, { tenantId: null });

    expect(scoped).toBe(0);
    expect(crossing).toBe(1);
  });

  it('paginates by cursor without repeating or skipping rows', async () => {
    for (let i = 0; i < 5; i++) {
      await seedFor('tenant-a', `A-P${i}`);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res: any = await h.context.runWith({ tenantId: 'tenant-a' }, () =>
        query.findFeed('billing', { limit: 2, cursor }),
      );
      seen.push(...res.data.map((r: any) => r.id));
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });
});
