import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createAdminClient, resetSchema } from '../fixtures/test-database.helper';
import { anonymizeSubject } from '../../src/migrations';

/**
 * Review finding R2-4.
 *
 * The naive `UPDATE ... WHERE row_id = :userId` rewrote row 42 of every audited
 * table, because row_id is unique only within a table. These tests pin the three
 * properties the procedure had to gain: table scoping, time bounds, termination.
 */
describe('audit.anonymize_subject()', () => {
  let admin: Client;

  const seed = (table: string, rowId: string, changedBy: string, at: string, email: string) =>
    admin.query(
      `INSERT INTO audit.logged_actions
         (schema_name, table_name, row_id, action, old_data, new_data, changed_by, changed_at)
       VALUES ('public', $1, $2, 'U',
               jsonb_build_object('email', $5::text, 'name', 'Alice', 'total', 10),
               jsonb_build_object('email', $5::text, 'name', 'Alice', 'total', 20),
               $3, $4::timestamptz)`,
      [table, rowId, changedBy, at, email],
    );

  const fetch = async (table: string, rowId: string) => {
    const res = await admin.query(
      'SELECT * FROM audit.logged_actions WHERE table_name = $1 AND row_id = $2 ORDER BY event_id',
      [table, rowId],
    );
    return res.rows;
  };

  const anonymize = (table: string, rowId: string, actor: string | null, from: string, to: string) =>
    anonymizeSubject(admin, {
      schema: 'public',
      table,
      rowId,
      actor,
      keys: ['email', 'name', 'phone'],
      from: new Date(from),
      to: new Date(to),
      batchSize: 10,
    });

  beforeAll(async () => {
    admin = await createAdminClient();
  });

  afterAll(async () => {
    await admin.end();
  });

  beforeEach(async () => {
    await resetSchema(admin);
  });

  it('strips the configured keys from the targeted subject', async () => {
    await seed('users', '42', 'user-42', '2026-03-10T10:00:00Z', 'alice@example.com');

    await anonymize('users', '42', 'user-42', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z');

    const [row] = await fetch('users', '42');
    expect(row.old_data).not.toHaveProperty('email');
    expect(row.old_data).not.toHaveProperty('name');
    expect(row.new_data).not.toHaveProperty('email');
    expect(row.changed_by).toBe('ANONYMIZED');
    // Non-personal fields survive: the forensic sequence is preserved.
    expect(row.old_data.total).toBe(10);
    expect(row.new_data.total).toBe(20);
  });

  it('does NOT touch the same row_id in a different table', async () => {
    await seed('users', '42', 'user-42', '2026-03-10T10:00:00Z', 'alice@example.com');
    await seed('invoices', '42', 'user-99', '2026-03-10T10:00:00Z', 'bob@example.com');

    await anonymize('users', '42', 'user-42', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z');

    const [invoice] = await fetch('invoices', '42');
    expect(invoice.old_data.email).toBe('bob@example.com');
    expect(invoice.changed_by).toBe('user-99');
  });

  it('respects the time bounds', async () => {
    await seed('users', '7', 'user-7', '2026-03-10T10:00:00Z', 'in@example.com');
    await seed('users', '7', 'user-7', '2025-03-10T10:00:00Z', 'out@example.com');

    await anonymize('users', '7', 'user-7', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z');

    const rows = await fetch('users', '7');
    const emails = rows.map((r) => r.old_data?.email ?? null);
    expect(emails).toContain('out@example.com'); // outside the window, untouched
    expect(emails).toContain(null);              // inside the window, stripped
  });

  it('also anonymises the subject acting as a causer on other rows', async () => {
    await seed('invoices', '900', 'user-42', '2026-03-10T10:00:00Z', 'someone@example.com');

    await anonymize('users', '42', 'user-42', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z');

    const [row] = await fetch('invoices', '900');
    expect(row.changed_by).toBe('ANONYMIZED');
  });

  it('terminates and is idempotent when run twice', async () => {
    for (let i = 0; i < 25; i++) {
      await seed('users', '13', 'user-13', '2026-03-10T10:00:00Z', `a${i}@example.com`);
    }

    await anonymize('users', '13', 'user-13', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z');
    await anonymize('users', '13', 'user-13', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z');

    const rows = await fetch('users', '13');
    expect(rows).toHaveLength(25);
    expect(rows.every((r) => !('email' in r.old_data))).toBe(true);
    expect(rows.every((r) => r.changed_by === 'ANONYMIZED')).toBe(true);
  });

  it('accepts a NULL actor and then only scopes by subject', async () => {
    await seed('users', '55', 'someone-else', '2026-03-10T10:00:00Z', 'x@example.com');

    await anonymize('users', '55', null, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z');

    const [row] = await fetch('users', '55');
    expect(row.old_data).not.toHaveProperty('email');
    expect(row.changed_by).toBe('someone-else'); // untouched: not the actor
  });
});
