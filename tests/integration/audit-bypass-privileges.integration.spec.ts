import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  auditRows,
  createAdminClient,
  createInvoicesTable,
  createLoginRole,
  dropLoginRole,
  resetSchema,
  truncateAudit,
} from '../fixtures/test-database.helper';

/**
 * Review finding R3-1 / R3-2.
 *
 * `SET LOCAL audit.disabled` must be FAIL-CLOSED: it suppresses auditing only for
 * a caller holding membership in `audit_bypass`. Every other caller is audited
 * anyway, and the attempt is recorded in `bypass_attempted`.
 *
 * The regression this guards against is the revision-3 form
 *   IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_admin')
 *      OR pg_has_role(...)
 * which granted the bypass to everyone whenever the role was missing — i.e. on
 * any install where the DBA hardening script had not been run.
 */
describe('audit bypass privileges (fail-closed)', () => {
  let admin: Client;
  let plainPool: Pool;
  let bypassPool: Pool;

  beforeAll(async () => {
    admin = await createAdminClient();
    await resetSchema(admin);
    await createInvoicesTable(admin);

    plainPool = await createLoginRole(admin, 'fath57_plain_user');
    bypassPool = await createLoginRole(admin, 'fath57_bypass_user');

    await admin.query('GRANT audit_bypass TO fath57_bypass_user;');
    await admin.query('GRANT INSERT, UPDATE, DELETE, SELECT ON public.invoices TO fath57_plain_user, fath57_bypass_user;');
  });

  afterAll(async () => {
    await plainPool?.end();
    await bypassPool?.end();
    await dropLoginRole(admin, 'fath57_plain_user');
    await dropLoginRole(admin, 'fath57_bypass_user');
    await admin.end();
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM public.invoices;');
    await truncateAudit(admin);
  });

  it('records the mutation and flags the attempt when the caller lacks audit_bypass', async () => {
    const id = randomUUID();
    const c = await plainPool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL audit.disabled = 'on'");
      await c.query('INSERT INTO public.invoices (id, reference) VALUES ($1, $2)', [id, 'INV-1']);
      await c.query('COMMIT');
    } finally {
      c.release();
    }

    const rows = await auditRows(admin);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('I');
    expect(rows[0].bypass_attempted).toBe(true);
    expect(rows[0].session_user_name).toBe('fath57_plain_user');
  });

  it('suppresses the audit row for a caller holding audit_bypass', async () => {
    const id = randomUUID();
    const c = await bypassPool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL audit.disabled = 'on'");
      await c.query('INSERT INTO public.invoices (id, reference) VALUES ($1, $2)', [id, 'INV-2']);
      await c.query('COMMIT');
    } finally {
      c.release();
    }

    expect(await auditRows(admin)).toHaveLength(0);
  });

  it.each(['on', 'ON', '1', 'true', 'TRUE'])(
    'denies the bypass for value %s without membership (case/alias coercion)',
    async (value) => {
      const c = await plainPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL audit.disabled = '${value}'`);
        await c.query('INSERT INTO public.invoices (id, reference) VALUES ($1, $2)', [randomUUID(), 'INV-' + value]);
        await c.query('COMMIT');
      } finally {
        c.release();
      }

      const rows = await auditRows(admin);
      expect(rows).toHaveLength(1);
      expect(rows[0].bypass_attempted).toBe(true);
    },
  );

  it('denies the bypass when the audit_bypass role does not exist at all', async () => {
    // The revision-3 regression: no role => bypass open to everyone.
    await admin.query('REVOKE audit_bypass FROM fath57_bypass_user;');
    await admin.query('DROP ROLE audit_bypass;');
    try {
      const c = await bypassPool.connect();
      try {
        await c.query('BEGIN');
        await c.query("SET LOCAL audit.disabled = 'on'");
        await c.query('INSERT INTO public.invoices (id, reference) VALUES ($1, $2)', [randomUUID(), 'INV-NOROLE']);
        await c.query('COMMIT');
      } finally {
        c.release();
      }

      const rows = await auditRows(admin);
      expect(rows).toHaveLength(1);
      expect(rows[0].bypass_attempted).toBe(true);
    } finally {
      await admin.query('CREATE ROLE audit_bypass NOLOGIN;');
      await admin.query('GRANT audit_bypass TO fath57_bypass_user;');
    }
  });

  it('leaves auditing untouched when audit.disabled is unset or off', async () => {
    const c = await plainPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('INSERT INTO public.invoices (id, reference) VALUES ($1, $2)', [randomUUID(), 'INV-3']);
      await c.query('COMMIT');
    } finally {
      c.release();
    }

    const rows = await auditRows(admin);
    expect(rows).toHaveLength(1);
    expect(rows[0].bypass_attempted).toBe(false);
  });
});
