import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  auditRows,
  createAdminClient,
  resetSchema,
  truncateAudit,
} from '../fixtures/test-database.helper';
import {
  clearSampleData,
  createOrm,
  createSampleTables,
  dropSampleTables,
  feedRows,
  OrmHarness,
} from '../fixtures/orm.helper';
import { SampleInvoice } from '../fixtures/sample-entities';
import { getTrackTableSql } from '../../src/migrations';

/**
 * §1.1 — the asymmetry that justifies shipping two modules rather than one.
 *
 * `em.nativeUpdate()` and the QueryBuilder emit no entity lifecycle events, so the
 * feed cannot see them. The database trigger always does. Attribution, however,
 * only reaches the trigger when the statement runs inside a managed transaction.
 */
describe('nativeUpdate: feed bypassed, audit recorded', () => {
  let admin: Client;
  let h: OrmHarness;

  beforeAll(async () => {
    admin = await createAdminClient();
    await resetSchema(admin);
    await createSampleTables(admin);
    await admin.query(getTrackTableSql('public.sample_invoices', ['id'], ['secret_token'], false));
    h = await createOrm();
  });

  afterAll(async () => {
    await h?.close();
    await dropSampleTables(admin);
    await admin.end();
  });

  beforeEach(async () => {
    await clearSampleData(admin);
    await truncateAudit(admin);
    h.em.clear();
  });

  const seedInvoice = async () => {
    const id = randomUUID();
    await admin.query(
      'INSERT INTO public.sample_invoices (id, reference, total) VALUES ($1, $2, $3)',
      [id, 'INV-SEED', '10.00'],
    );
    await truncateAudit(admin);
    return id;
  };

  it('an ORM flush produces BOTH a feed row and an audit row', async () => {
    const invoice = new SampleInvoice();
    invoice.reference = 'INV-BOTH';
    h.em.persist(invoice);
    await h.em.flush();

    expect(await feedRows(admin)).toHaveLength(1);
    expect(await auditRows(admin, 'sample_invoices')).toHaveLength(1);
  });

  it('an implicit flush carries attribution to the audit row', async () => {
    // Regression guard. The binding used to be issued through em.execute(), which
    // picks its own pooled connection; set_config(..., is_local => true) then
    // applied to a foreign connection and was discarded, leaving changed_by NULL
    // on EVERY audit row. The binding must ride the transaction's own connection.
    await h.context.runWith({ userId: 'user-11', causerType: 'User' }, async () => {
      const invoice = new SampleInvoice();
      invoice.reference = 'INV-ATTR';
      h.em.persist(invoice);
      await h.em.flush();
    });

    const [row] = await auditRows(admin, 'sample_invoices');
    expect(row.changed_by).toBe('user-11');
  });

  it('nativeUpdate produces an audit row but NO feed row', async () => {
    const id = await seedInvoice();

    await h.em.nativeUpdate(SampleInvoice, { id }, { total: '500.00' });

    expect(await feedRows(admin)).toHaveLength(0);
    const audit = await auditRows(admin, 'sample_invoices');
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('U');
    expect(Number(audit[0].changed_fields.total)).toBe(500); // NUMERIC -> JSON number
  });

  it('the QueryBuilder is bypassed by the feed in the same way', async () => {
    const id = await seedInvoice();

    await h.em
      .createQueryBuilder(SampleInvoice)
      .update({ reference: 'INV-QB' })
      .where({ id })
      .execute();

    expect(await feedRows(admin)).toHaveLength(0);
    expect(await auditRows(admin, 'sample_invoices')).toHaveLength(1);
  });

  it('nativeUpdate OUTSIDE a transaction records no attribution', async () => {
    const id = await seedInvoice();

    await h.context.runWith({ userId: 'user-77', causerType: 'User' }, async () => {
      await h.em.nativeUpdate(SampleInvoice, { id }, { total: '77.00' });
    });

    const [row] = await auditRows(admin, 'sample_invoices');
    // Autocommit: no transaction hook fires, so no set_config happens.
    expect(row.changed_by).toBeNull();
  });

  it('nativeUpdate INSIDE em.transactional() carries attribution', async () => {
    const id = await seedInvoice();

    await h.context.runWith({ userId: 'user-88', causerType: 'User' }, async () => {
      await h.em.transactional(async (em) => {
        await em.nativeUpdate(SampleInvoice, { id }, { total: '88.00' });
      });
    });

    const [row] = await auditRows(admin, 'sample_invoices');
    expect(row.changed_by).toBe('user-88');
    // Still no feed row: attribution does not resurrect the lifecycle event.
    expect(await feedRows(admin)).toHaveLength(0);
  });

  it('raw SQL from outside the ORM entirely is still audited', async () => {
    const id = await seedInvoice();

    await admin.query('UPDATE public.sample_invoices SET reference = $1 WHERE id = $2', ['INV-RAW', id]);

    expect(await feedRows(admin)).toHaveLength(0);
    const audit = await auditRows(admin, 'sample_invoices');
    expect(audit).toHaveLength(1);
    expect(audit[0].changed_fields.reference).toBe('INV-RAW');
  });

  it('withoutLogs() silences the feed but NOT the audit trail', async () => {
    await h.context.runWithDisabledFeed(async () => {
      const invoice = new SampleInvoice();
      invoice.reference = 'INV-QUIET';
      h.em.persist(invoice);
      await h.em.flush();
    });

    expect(await feedRows(admin)).toHaveLength(0);
    expect(await auditRows(admin, 'sample_invoices')).toHaveLength(1);
  });
});
