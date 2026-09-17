import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  createAdminClient,
  createInvoicesTable,
  createLoginRole,
  dropLoginRole,
  resetSchema,
} from '../fixtures/test-database.helper';
import { getHardeningScript } from '../../src/migrations';

/**
 * Review finding R2-10 / R3-6, and hypothesis 2 of the spec review:
 *
 *   "Confirm that a partition created from a SECURITY DEFINER function belongs to
 *    the function owner, and that REVOKE on the parent does NOT cover direct
 *    access to a child."
 *
 * All of §5.8 rests on that pair of assumptions. This suite turns them into facts.
 */
describe('partition ownership and privileges', () => {
  let admin: Client;
  let appPool: Pool;
  const partition = `logged_actions_${new Date().getUTCFullYear()}_${String(
    new Date().getUTCMonth() + 1,
  ).padStart(2, '0')}`;

  beforeAll(async () => {
    admin = await createAdminClient();
    await resetSchema(admin);
    await createInvoicesTable(admin);

    appPool = await createLoginRole(admin, 'fath57_app_user');
    await admin.query('GRANT INSERT, UPDATE, DELETE, SELECT ON public.invoices TO fath57_app_user;');

    // Apply the DBA hardening script BEFORE creating any partition, so the
    // partition-creating function is already owned by audit_admin.
    await admin.query(getHardeningScript('fath57_app_user', 'audit_admin'));

    await admin.query(`SELECT audit.create_monthly_partition(date_trunc('month', now())::date);`);
  });

  afterAll(async () => {
    await appPool?.end();
    await dropLoginRole(admin, 'fath57_app_user');
    await admin.end();
  });

  it('creates the monthly partition owned by the function owner, not the caller', async () => {
    const res = await admin.query(
      `SELECT pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'audit' AND c.relname = $1`,
      [partition],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].owner).toBe('audit_admin');
  });

  it('routes new audit rows into the monthly partition, not the DEFAULT one', async () => {
    const c = await appPool.connect();
    try {
      await c.query('INSERT INTO public.invoices (id, reference) VALUES ($1, $2)', [randomUUID(), 'INV-PART']);
    } finally {
      c.release();
    }

    const inPartition = await admin.query(`SELECT count(*)::int AS n FROM audit.${partition}`);
    const inDefault = await admin.query('SELECT count(*)::int AS n FROM audit.logged_actions_default');
    expect(inPartition.rows[0].n).toBeGreaterThan(0);
    expect(inDefault.rows[0].n).toBe(0);
  });

  it('lets the app role read audit rows through the parent', async () => {
    const c = await appPool.connect();
    try {
      const res = await c.query('SELECT count(*)::int AS n FROM audit.logged_actions');
      expect(res.rows[0].n).toBeGreaterThan(0);
    } finally {
      c.release();
    }
  });

  it('refuses DELETE and UPDATE on the parent to the app role', async () => {
    const c = await appPool.connect();
    try {
      await expect(c.query('DELETE FROM audit.logged_actions')).rejects.toThrow(/permission denied/i);
      await expect(
        c.query("UPDATE audit.logged_actions SET changed_by = 'x'"),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      c.release();
    }
  });

  it('refuses DIRECT access to the child partition — the hole R2-10 described', async () => {
    const c = await appPool.connect();
    try {
      await expect(c.query(`DELETE FROM audit.${partition}`)).rejects.toThrow(/permission denied/i);
      await expect(c.query(`SELECT * FROM audit.${partition}`)).rejects.toThrow(/permission denied/i);
    } finally {
      c.release();
    }
  });

  it('refuses the partition-management and tracking functions to the app role', async () => {
    const c = await appPool.connect();
    try {
      await expect(
        c.query(`SELECT audit.create_monthly_partition('2030-01-01'::date)`),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        c.query(`SELECT audit.track_table('public.invoices'::regclass)`),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      c.release();
    }
  });

  it('refuses DROP TRIGGER on the audited table to a non-owner app role', async () => {
    const c = await appPool.connect();
    try {
      await expect(
        c.query('DROP TRIGGER audit_trigger_invoices_iud ON public.invoices'),
      ).rejects.toThrow(/must be owner/i);
    } finally {
      c.release();
    }
  });
});
