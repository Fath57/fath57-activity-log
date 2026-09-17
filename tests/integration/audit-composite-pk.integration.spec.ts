import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  auditRows,
  createAdminClient,
  createInvoicesTable,
  createOrderLinesTable,
  resetSchema,
  truncateAudit,
} from '../fixtures/test-database.helper';
import { getTrackTableSql } from '../../src/migrations';

/** Review findings R2-18 (composite PK support) and R2-17 / R3-11 (fail loudly). */
describe('composite primary keys and row identity', () => {
  let admin: Client;

  beforeAll(async () => {
    admin = await createAdminClient();
    await resetSchema(admin);
    await createInvoicesTable(admin);
    await createOrderLinesTable(admin);
  });

  afterAll(async () => {
    await admin.end();
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM public.order_lines;');
    await truncateAudit(admin);
  });

  it('encodes a composite key as canonical JSON and flags it', async () => {
    await admin.query('INSERT INTO public.order_lines (order_id, line_id) VALUES (1, 7)');

    const [row] = await auditRows(admin, 'order_lines');
    expect(row.row_id_is_json).toBe(true);
    expect(JSON.parse(row.row_id)).toEqual({ order_id: 1, line_id: 7 });
  });

  it('produces a stable row_id across INSERT, UPDATE and DELETE of the same row', async () => {
    await admin.query('INSERT INTO public.order_lines (order_id, line_id) VALUES (2, 3)');
    await admin.query('UPDATE public.order_lines SET quantity = 5 WHERE order_id = 2 AND line_id = 3');
    await admin.query('DELETE FROM public.order_lines WHERE order_id = 2 AND line_id = 3');

    const rows = await auditRows(admin, 'order_lines');
    expect(rows.map((r) => r.action)).toEqual(['I', 'U', 'D']);
    expect(new Set(rows.map((r) => r.row_id)).size).toBe(1);
  });

  it('keeps a single-column key as a bare scalar', async () => {
    const rows = await auditRows(admin, 'order_lines');
    expect(rows).toHaveLength(0);

    await admin.query(
      "INSERT INTO public.invoices (id, reference) VALUES ('00000000-0000-0000-0000-000000000001', 'SCALAR')",
    );
    const [row] = await auditRows(admin, 'invoices');
    expect(row.row_id_is_json).toBe(false);
    expect(row.row_id).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('rejects an empty pk_columns at configuration time', async () => {
    await expect(
      admin.query(`SELECT audit.track_table('public.order_lines'::regclass, ARRAY[]::TEXT[])`),
    ).rejects.toThrow(/pk_columns must not be empty/i);
  });

  it('rejects a pk_columns / ignored_columns overlap at configuration time', async () => {
    await expect(
      admin.query(getTrackTableSql('public.invoices', ['id'], ['id', 'secret_token'])),
    ).rejects.toThrow(/overlap/i);
  });

  it('rejects a pk column that does not exist on the target table', async () => {
    await expect(
      admin.query(getTrackTableSql('public.invoices', ['invoice_id'])),
    ).rejects.toThrow(/do not exist/i);
  });

  it('raises at write time rather than recording a placeholder identifier', async () => {
    // The validations above make this unreachable through track_table(), so the
    // trigger is wired by hand to prove the last line of defence still fires.
    await admin.query(`
      CREATE TRIGGER audit_manual_bad_pk AFTER INSERT ON public.invoices
      FOR EACH ROW EXECUTE FUNCTION audit.log_change('{nonexistent}', '{}', 'false');
    `);
    try {
      await expect(
        admin.query(
          "INSERT INTO public.invoices (id, reference) VALUES ('00000000-0000-0000-0000-000000000002', 'BAD')",
        ),
      ).rejects.toMatchObject({
        code: '42703', // undefined_column
        message: expect.stringContaining('primary key'),
      });
    } finally {
      await admin.query('DROP TRIGGER audit_manual_bad_pk ON public.invoices');
    }
  });
});
