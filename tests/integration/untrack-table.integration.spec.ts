import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  auditRows,
  createAdminClient,
  createInvoicesTable,
  resetSchema,
  truncateAudit,
} from '../fixtures/test-database.helper';
import {
  getTrackTableSql,
  getUntrackTableSql,
} from '../../src/migrations/migration-helpers';

/**
 * §5 — detaching the audit triggers.
 *
 * The inverse of `track_table`, and the operation a `down()` needs. It is also
 * the one that switches the audit trail off, so the tests below pin both halves:
 * that it stops new rows, and that it leaves the recorded ones alone.
 */
describe('audit.untrack_table', () => {
  let admin: Client;

  const triggersOn = async (table: string): Promise<string[]> => {
    const res = await admin.query(
      `SELECT t.tgname FROM pg_trigger t
       WHERE t.tgrelid = $1::regclass AND NOT t.tgisinternal
       ORDER BY t.tgname`,
      [table],
    );
    return res.rows.map((r) => r.tgname);
  };

  const insertInvoice = async (reference: string) => {
    const id = randomUUID();
    await admin.query(
      'INSERT INTO public.invoices (id, reference) VALUES ($1, $2)',
      [id, reference],
    );
    return id;
  };

  beforeAll(async () => {
    admin = await createAdminClient();
    await resetSchema(admin);
    await createInvoicesTable(admin);
  });

  afterAll(async () => {
    await admin.end();
  });

  beforeEach(async () => {
    await admin.query(getTrackTableSql('public.invoices', ['id'], ['secret_token']));
    await admin.query('DELETE FROM public.invoices;');
    await truncateAudit(admin);
  });

  it('removes both triggers track_table attached', async () => {
    expect(await triggersOn('public.invoices')).toEqual([
      'audit_trigger_invoices_iud',
      'audit_trigger_invoices_u',
    ]);

    await admin.query(getUntrackTableSql('public.invoices'));

    expect(await triggersOn('public.invoices')).toEqual([]);
  });

  it('stops recording once detached', async () => {
    await insertInvoice('INV-TRACKED');
    expect(await auditRows(admin)).toHaveLength(1);

    await admin.query(getUntrackTableSql('public.invoices'));
    await insertInvoice('INV-UNTRACKED');

    // Still one: the second insert produced nothing.
    const rows = await auditRows(admin);
    expect(rows).toHaveLength(1);
    expect(rows[0].new_data.reference).toBe('INV-TRACKED');
  });

  it('leaves the rows already recorded in place', async () => {
    await insertInvoice('INV-KEEP');
    const before = await auditRows(admin);

    await admin.query(getUntrackTableSql('public.invoices'));

    // Detaching a trigger is not a way to erase a trail.
    expect(await auditRows(admin)).toEqual(before);
  });

  it('is a no-op on a table that was never tracked', async () => {
    await admin.query(`
      CREATE TABLE IF NOT EXISTS public.never_tracked (id UUID PRIMARY KEY);
    `);

    await expect(
      admin.query(getUntrackTableSql('public.never_tracked')),
    ).resolves.toBeDefined();

    await admin.query('DROP TABLE public.never_tracked;');
  });

  it('is idempotent, so a down migration can run twice', async () => {
    await admin.query(getUntrackTableSql('public.invoices'));
    await admin.query(getUntrackTableSql('public.invoices'));

    expect(await triggersOn('public.invoices')).toEqual([]);
  });

  it('can be re-tracked afterwards', async () => {
    await admin.query(getUntrackTableSql('public.invoices'));
    await admin.query(getTrackTableSql('public.invoices', ['id'], ['secret_token']));

    await insertInvoice('INV-AGAIN');
    expect(await auditRows(admin)).toHaveLength(1);
  });
});
