import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  auditRows,
  createAdminClient,
  createInvoicesTable,
  createPool,
  resetSchema,
  truncateAudit,
} from '../fixtures/test-database.helper';

/**
 * §5.6 — attribution via `SET LOCAL app.current_user_id`.
 *
 * The property that matters is that `is_local = true` confines the setting to the
 * transaction, so a pooled connection never carries one user's identity into the
 * next borrower's statements.
 */
describe('transaction-scoped user attribution', () => {
  let admin: Client;
  let pool: Pool;

  const bind = (c: any, userId: string) =>
    c.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId]);

  beforeAll(async () => {
    admin = await createAdminClient();
    await resetSchema(admin);
    await createInvoicesTable(admin);
    pool = createPool({ max: 1 }); // force connection reuse
  });

  afterAll(async () => {
    await pool?.end();
    await admin.end();
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM public.invoices;');
    await truncateAudit(admin);
  });

  it('records changed_by when bound inside the transaction', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await bind(c, 'user-42');
      await c.query('INSERT INTO public.invoices (id, reference) VALUES ($1, $2)', [randomUUID(), 'A']);
      await c.query('COMMIT');
    } finally {
      c.release();
    }

    const [row] = await auditRows(admin);
    expect(row.changed_by).toBe('user-42');
  });

  it('does not leak the setting to the next transaction on the same connection', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await bind(c, 'user-42');
      await c.query('INSERT INTO public.invoices (id, reference) VALUES ($1, $2)', [randomUUID(), 'A']);
      await c.query('COMMIT');

      // Same physical connection, no binding this time.
      await c.query('BEGIN');
      await c.query('INSERT INTO public.invoices (id, reference) VALUES ($1, $2)', [randomUUID(), 'B']);
      await c.query('COMMIT');
    } finally {
      c.release();
    }

    const rows = await auditRows(admin);
    expect(rows.map((r) => r.changed_by)).toEqual(['user-42', null]);
  });

  it('does not leak after a ROLLBACK either', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await bind(c, 'user-99');
      await c.query('ROLLBACK');

      await c.query('BEGIN');
      await c.query('INSERT INTO public.invoices (id, reference) VALUES ($1, $2)', [randomUUID(), 'C']);
      await c.query('COMMIT');
    } finally {
      c.release();
    }

    const [row] = await auditRows(admin);
    expect(row.changed_by).toBeNull();
  });

  it('leaves changed_by NULL for an autocommit write with no binding', async () => {
    // The §1.1 caveat: a mutation outside a managed transaction is still recorded,
    // but carries no attribution.
    await pool.query('INSERT INTO public.invoices (id, reference) VALUES ($1, $2)', [randomUUID(), 'D']);

    const [row] = await auditRows(admin);
    expect(row.action).toBe('I');
    expect(row.changed_by).toBeNull();
  });

  it('keeps concurrent transactions isolated from each other', async () => {
    const wide = createPool({ max: 4 });
    try {
      await Promise.all(
        ['alice', 'bob', 'carol', 'dave'].map(async (user) => {
          const c = await wide.connect();
          try {
            await c.query('BEGIN');
            await bind(c, user);
            await c.query('SELECT pg_sleep(0.05)');
            await c.query('INSERT INTO public.invoices (id, reference) VALUES ($1, $2)', [randomUUID(), user]);
            await c.query('COMMIT');
          } finally {
            c.release();
          }
        }),
      );
    } finally {
      await wide.end();
    }

    const rows = await auditRows(admin);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.changed_by).toBe(row.new_data.reference);
    }
  });

  it('records the engine-provided session_user alongside the declared changed_by', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await bind(c, 'spoofed-admin');
      await c.query('INSERT INTO public.invoices (id, reference) VALUES ($1, $2)', [randomUUID(), 'E']);
      await c.query('COMMIT');
    } finally {
      c.release();
    }

    const [row] = await auditRows(admin);
    expect(row.changed_by).toBe('spoofed-admin');   // application-declared, forgeable
    expect(row.session_user_name).toBe('postgres'); // engine-provided, not forgeable
  });
});
