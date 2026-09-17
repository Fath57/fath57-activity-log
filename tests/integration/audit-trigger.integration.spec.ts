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
import { getTrackTableSql } from '../../src/migrations';

describe('audit.log_change() trigger', () => {
  let admin: Client;

  beforeAll(async () => {
    admin = await createAdminClient();
    await resetSchema(admin);
    await createInvoicesTable(admin);
  });

  afterAll(async () => {
    await admin.end();
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM public.invoices;');
    await truncateAudit(admin);
  });

  const insertInvoice = async (ref = 'INV-1', token: string | null = 'secret-abc') => {
    const id = randomUUID();
    await admin.query(
      'INSERT INTO public.invoices (id, reference, total, secret_token) VALUES ($1, $2, $3, $4)',
      [id, ref, '100.00', token],
    );
    return id;
  };

  it('records an INSERT with new_data only', async () => {
    const id = await insertInvoice();
    const [row] = await auditRows(admin);

    expect(row.action).toBe('I');
    expect(row.schema_name).toBe('public');
    expect(row.table_name).toBe('invoices');
    expect(row.row_id).toBe(id);
    expect(row.row_id_is_json).toBe(false);
    expect(row.old_data).toBeNull();
    expect(row.changed_fields).toBeNull();
    expect(row.new_data.reference).toBe('INV-1');
  });

  it('strips ignored columns from every payload', async () => {
    const id = await insertInvoice('INV-2', 'top-secret');
    await admin.query('UPDATE public.invoices SET reference = $1 WHERE id = $2', ['INV-2b', id]);
    await admin.query('DELETE FROM public.invoices WHERE id = $1', [id]);

    const rows = await auditRows(admin);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(JSON.stringify(row.new_data ?? {})).not.toContain('top-secret');
      expect(JSON.stringify(row.old_data ?? {})).not.toContain('top-secret');
      expect(row.new_data ?? {}).not.toHaveProperty('secret_token');
      expect(row.old_data ?? {}).not.toHaveProperty('secret_token');
    }
  });

  it('records an UPDATE with the exact dirty diff', async () => {
    const id = await insertInvoice('INV-3');
    await truncateAudit(admin);

    await admin.query('UPDATE public.invoices SET reference = $1, total = $2 WHERE id = $3', [
      'INV-3-rev',
      '250.00',
      id,
    ]);

    const [row] = await auditRows(admin);
    expect(row.action).toBe('U');
    expect(Object.keys(row.changed_fields).sort()).toEqual(['reference', 'total']);
    expect(row.changed_fields.reference).toBe('INV-3-rev');
    expect(row.old_data.reference).toBe('INV-3');
    expect(row.new_data.reference).toBe('INV-3-rev');
  });

  it('records a DELETE with old_data only', async () => {
    const id = await insertInvoice('INV-4');
    await truncateAudit(admin);

    await admin.query('DELETE FROM public.invoices WHERE id = $1', [id]);

    const [row] = await auditRows(admin);
    expect(row.action).toBe('D');
    expect(row.row_id).toBe(id);
    expect(row.new_data).toBeNull();
    expect(row.old_data.reference).toBe('INV-4');
  });

  it('writes nothing when an UPDATE changes no value at all', async () => {
    const id = await insertInvoice('INV-5');
    await truncateAudit(admin);

    // The WHEN (OLD.* IS DISTINCT FROM NEW.*) guard short-circuits this one.
    await admin.query('UPDATE public.invoices SET reference = reference WHERE id = $1', [id]);

    expect(await auditRows(admin)).toHaveLength(0);
  });

  it('writes nothing when an UPDATE touches only ignored columns', async () => {
    const id = await insertInvoice('INV-6', 'tok-1');
    await truncateAudit(admin);

    // The row genuinely changes, so the WHEN clause fires; the empty-diff early
    // return inside the function is what suppresses the row. This is the case the
    // spec calls out as the effective de-duplication in ORM workloads.
    await admin.query('UPDATE public.invoices SET secret_token = $1 WHERE id = $2', ['tok-2', id]);

    expect(await auditRows(admin)).toHaveLength(0);
  });

  it('captures no client_query by default and truncates it when enabled', async () => {
    const id = await insertInvoice('INV-7');
    expect((await auditRows(admin))[0].client_query).toBeNull();

    await admin.query(getTrackTableSql('public.invoices', ['id'], ['secret_token'], true));
    await truncateAudit(admin);
    try {
      await admin.query(
        `UPDATE public.invoices SET reference = $1 /* ${'x'.repeat(4000)} */ WHERE id = $2`,
        ['INV-7b', id],
      );
      const [row] = await auditRows(admin);
      expect(row.client_query).not.toBeNull();
      expect(row.client_query.length).toBe(2048);
    } finally {
      await admin.query(getTrackTableSql('public.invoices', ['id'], ['secret_token'], false));
    }
  });

  it('groups a multi-statement transaction under one transaction_id', async () => {
    await admin.query('BEGIN');
    await admin.query('INSERT INTO public.invoices (id, reference) VALUES ($1, $2)', [randomUUID(), 'T-1']);
    await admin.query('INSERT INTO public.invoices (id, reference) VALUES ($1, $2)', [randomUUID(), 'T-2']);
    await admin.query('COMMIT');

    const rows = await auditRows(admin);
    expect(rows).toHaveLength(2);
    expect(rows[0].transaction_id).toBe(rows[1].transaction_id);
  });

  it('rolls the audit row back with the business transaction', async () => {
    await admin.query('BEGIN');
    await admin.query('INSERT INTO public.invoices (id, reference) VALUES ($1, $2)', [randomUUID(), 'RB-1']);
    await admin.query('ROLLBACK');

    expect(await auditRows(admin)).toHaveLength(0);
    const invoices = await admin.query('SELECT count(*)::int AS n FROM public.invoices');
    expect(invoices.rows[0].n).toBe(0);
  });
});
