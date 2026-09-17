import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createAdminClient, resetSchema } from '../fixtures/test-database.helper';
import {
  clearSampleData,
  createOrm,
  createSampleTables,
  dropSampleTables,
  feedRows,
  OrmHarness,
} from '../fixtures/orm.helper';
import {
  SampleDynamic,
  SampleInvoice,
  SampleUntracked,
} from '../fixtures/sample-entities';

describe('ActivitySubscriber', () => {
  let admin: Client;
  let h: OrmHarness;

  beforeAll(async () => {
    admin = await createAdminClient();
    await resetSchema(admin);
    await createSampleTables(admin);
    h = await createOrm({ withAudit: false });
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

  const newInvoice = (reference = 'INV-1') => {
    const i = new SampleInvoice();
    i.reference = reference;
    i.secretToken = 'do-not-log-me';
    return i;
  };

  it('ignores entities that are not registered', async () => {
    const u = new SampleUntracked();
    u.label = 'nothing to see';
    await h.em.persistAndFlush(u);

    expect(await feedRows(admin)).toHaveLength(0);
  });

  it('logs a creation with the configured logName and description formatter', async () => {
    await h.em.persistAndFlush(newInvoice('INV-CREATE'));

    const [row] = await feedRows(admin);
    expect(row.event).toBe('created');
    expect(row.log_name).toBe('billing');
    expect(row.description).toBe('Invoice INV-CREATE created');
  });

  it('honours logExcept: the excluded attribute never reaches properties', async () => {
    await h.em.persistAndFlush(newInvoice('INV-SECRET'));

    const [row] = await feedRows(admin);
    expect(JSON.stringify(row.properties)).not.toContain('do-not-log-me');
    expect(row.properties).not.toHaveProperty('secretToken');
    expect(row.properties.reference).toBe('INV-SECRET');
  });

  it('logs an update with only the dirty attributes', async () => {
    const invoice = newInvoice('INV-UPD');
    await h.em.persistAndFlush(invoice);
    await clearSampleData(admin);

    invoice.total = '99.00';
    await h.em.flush();

    const [row] = await feedRows(admin);
    expect(row.event).toBe('updated');
    expect(Object.keys(row.properties)).toEqual(['total']);
  });

  it('writes nothing when a flush changes no tracked attribute', async () => {
    const invoice = newInvoice('INV-NOOP');
    await h.em.persistAndFlush(invoice);
    await clearSampleData(admin);

    invoice.secretToken = 'rotated'; // excluded from the log
    await h.em.flush();

    expect(await feedRows(admin)).toHaveLength(0);
  });

  it('classifies a soft delete as deleted, not updated', async () => {
    const invoice = newInvoice('INV-SOFT');
    await h.em.persistAndFlush(invoice);
    await clearSampleData(admin);

    invoice.deletedAt = new Date();
    await h.em.flush();

    const [row] = await feedRows(admin);
    expect(row.event).toBe('deleted');
  });

  it('logs a hard delete', async () => {
    const invoice = newInvoice('INV-HARD');
    await h.em.persistAndFlush(invoice);
    await clearSampleData(admin);

    await h.em.removeAndFlush(invoice);

    const [row] = await feedRows(admin);
    expect(row.event).toBe('deleted');
  });

  it('populates causer and tenant from the request context', async () => {
    await h.context.runWith(
      { userId: 'user-7', causerType: 'User', tenantId: 'tenant-a' },
      async () => {
        await h.em.persistAndFlush(newInvoice('INV-CTX'));
      },
    );

    const [row] = await feedRows(admin);
    expect(row.causer_id).toBe('user-7');
    expect(row.causer_type).toBe('User');
    expect(row.tenant_id).toBe('tenant-a');
  });

  it('leaves causer null outside any request context', async () => {
    await h.em.persistAndFlush(newInvoice('INV-NOCTX'));

    const [row] = await feedRows(admin);
    expect(row.causer_id).toBeNull();
    expect(row.causer_type).toBeNull();
  });

  it('suppresses logging inside withoutLogs()', async () => {
    await h.context.runWithDisabledFeed(async () => {
      await h.em.persistAndFlush(newInvoice('INV-SILENT'));
    });

    expect(await feedRows(admin)).toHaveLength(0);
    const invoices = await admin.query('SELECT count(*)::int AS n FROM public.sample_invoices');
    expect(invoices.rows[0].n).toBe(1); // business write still happened
  });

  it('merges a partial dynamic override over the decorator without erasing it', async () => {
    // getActivitylogOptions() sets only logName; logOnly: ['label'] must survive.
    const d = new SampleDynamic();
    d.label = 'visible';
    d.note = 'filtered out';
    await h.em.persistAndFlush(d);

    const [row] = await feedRows(admin);
    expect(row.log_name).toBe('dynamic-name');   // dynamic level wins
    expect(Object.keys(row.properties)).toEqual(['label']); // decorator level survives
  });
});
