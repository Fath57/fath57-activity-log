import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createAdminClient, resetSchema } from '../fixtures/test-database.helper';

/**
 * Review finding R3-3 / R3-4, and hypothesis 3 of the spec review.
 *
 * The revision-3 design "self-healed" by copying conflicting rows out of the
 * DEFAULT partition while holding ACCESS EXCLUSIVE on the parent — turning a
 * missed cron into an outage that scales with the accumulated volume.
 *
 * Revision 4 instead REFUSES to create the partition and points at a maintenance
 * runbook. These tests pin that contract, and prove the runbook actually works.
 */
describe('monthly partition creation vs the DEFAULT partition', () => {
  let admin: Client;
  const FUTURE = '2031-07-01';
  const FUTURE_PART = 'logged_actions_2031_07';

  const seedDefaultRow = (client: Client, at: string) =>
    client.query(
      `INSERT INTO audit.logged_actions
         (schema_name, table_name, row_id, action, changed_at)
       VALUES ('public', 'invoices', $1, 'I', $2::timestamptz)`,
      [`row-${at}`, at],
    );

  beforeAll(async () => {
    admin = await createAdminClient();
  });

  afterAll(async () => {
    await admin.end();
  });

  beforeEach(async () => {
    await resetSchema(admin);
  });

  it('is idempotent: creating the same month twice is a no-op', async () => {
    await admin.query(`SELECT audit.create_monthly_partition($1::date)`, [FUTURE]);
    await expect(
      admin.query(`SELECT audit.create_monthly_partition($1::date)`, [FUTURE]),
    ).resolves.toBeDefined();

    const res = await admin.query(
      `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'audit' AND c.relname = $1`,
      [FUTURE_PART],
    );
    expect(res.rows[0].n).toBe(1);
  });

  it('routes a row with no matching partition into DEFAULT instead of failing', async () => {
    await expect(seedDefaultRow(admin, '2031-07-15T12:00:00Z')).resolves.toBeDefined();

    const res = await admin.query('SELECT count(*)::int AS n FROM audit.logged_actions_default');
    expect(res.rows[0].n).toBe(1);
  });

  it('REFUSES to create the partition when DEFAULT already holds rows for that month', async () => {
    await seedDefaultRow(admin, '2031-07-15T12:00:00Z');

    await expect(
      admin.query(`SELECT audit.create_monthly_partition($1::date)`, [FUTURE]),
    ).rejects.toMatchObject({
      // object_not_in_prerequisite_state
      code: '55000',
      message: expect.stringContaining('DEFAULT partition'),
    });

    // The refusal must be total: no half-created partition left behind.
    const res = await admin.query(
      `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'audit' AND c.relname = $1`,
      [FUTURE_PART],
    );
    expect(res.rows[0].n).toBe(0);
  });

  it('still creates partitions for OTHER months while DEFAULT holds a conflict', async () => {
    await seedDefaultRow(admin, '2031-07-15T12:00:00Z');

    await expect(
      admin.query(`SELECT audit.create_monthly_partition('2031-08-01'::date)`),
    ).resolves.toBeDefined();
  });

  it('CONCURRENTLY is unavailable while a DEFAULT partition exists', async () => {
    // Discovered by this suite: PostgreSQL refuses to detach any partition
    // concurrently as long as the table has a default partition. The revision-4
    // runbook (which used DETACH ... CONCURRENTLY) was impossible as written.
    await expect(
      admin.query(
        'ALTER TABLE audit.logged_actions DETACH PARTITION audit.logged_actions_default CONCURRENTLY',
      ),
    ).rejects.toThrow(/cannot detach partitions concurrently when a default partition exists/i);
  });

  it('runbook: detach + create in one short transaction, copy while detached', async () => {
    await seedDefaultRow(admin, '2031-07-15T12:00:00Z');
    await seedDefaultRow(admin, '2031-07-20T12:00:00Z');
    const before = await admin.query('SELECT count(*)::int AS n FROM audit.logged_actions');
    expect(before.rows[0].n).toBe(2);

    // Phase 1 — catalog only, no scan. ACCESS EXCLUSIVE is held for the duration
    // of two DDL statements, not for the duration of the copy.
    await admin.query('BEGIN');
    await admin.query(
      'ALTER TABLE audit.logged_actions DETACH PARTITION audit.logged_actions_default',
    );
    await admin.query(`SELECT audit.create_monthly_partition($1::date)`, [FUTURE]);
    await admin.query('COMMIT');

    // Phase 2 — the expensive part, with the parent unlocked and accepting writes.
    await admin.query('INSERT INTO audit.logged_actions SELECT * FROM audit.logged_actions_default');
    await admin.query('TRUNCATE audit.logged_actions_default');

    // Phase 3 — re-attach the (now empty) safety net.
    await admin.query(
      'ALTER TABLE audit.logged_actions ATTACH PARTITION audit.logged_actions_default DEFAULT',
    );

    const after = await admin.query('SELECT count(*)::int AS n FROM audit.logged_actions');
    expect(after.rows[0].n).toBe(2);

    const inPart = await admin.query(`SELECT count(*)::int AS n FROM audit.${FUTURE_PART}`);
    expect(inPart.rows[0].n).toBe(2);

    const inDefault = await admin.query('SELECT count(*)::int AS n FROM audit.logged_actions_default');
    expect(inDefault.rows[0].n).toBe(0);
  });

  it('skips the conflict probe while the DEFAULT partition is detached', async () => {
    // What makes phase 1 of the runbook possible: the guard is attachment-aware.
    await seedDefaultRow(admin, '2031-07-15T12:00:00Z');

    await admin.query('ALTER TABLE audit.logged_actions DETACH PARTITION audit.logged_actions_default');
    try {
      await expect(
        admin.query(`SELECT audit.create_monthly_partition($1::date)`, [FUTURE]),
      ).resolves.toBeDefined();
    } finally {
      await admin.query('TRUNCATE audit.logged_actions_default');
      await admin.query(
        'ALTER TABLE audit.logged_actions ATTACH PARTITION audit.logged_actions_default DEFAULT',
      );
    }
  });

  it('computes partition bounds in UTC regardless of the session TimeZone', async () => {
    // R3-5: bounds must not shift with the caller's TimeZone.
    await admin.query("SET TIME ZONE 'Pacific/Kiritimati'");   // UTC+14
    try {
      await admin.query(`SELECT audit.create_monthly_partition($1::date)`, [FUTURE]);
    } finally {
      await admin.query('SET TIME ZONE UTC');
    }

    const res = await admin.query(
      `SELECT pg_get_expr(c.relpartbound, c.oid) AS bound
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'audit' AND c.relname = $1`,
      [FUTURE_PART],
    );
    expect(res.rows[0].bound).toContain('2031-07-01 00:00:00+00');
    expect(res.rows[0].bound).toContain('2031-08-01 00:00:00+00');
  });
});
