import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { createAdminClient, resetSchema } from '../fixtures/test-database.helper';
import {
  clearSampleData,
  createOrm,
  createSampleTables,
  dropSampleTables,
  feedRows,
  OrmHarness,
} from '../fixtures/orm.helper';
import { SampleInvoice } from '../fixtures/sample-entities';
import { ActivityOutboxDrainer } from '../../src/feed/services/activity-outbox.drainer';

/** §4.8 — the outbox must be transactional on both ends. */
describe('flushMode: outbox', () => {
  let admin: Client;
  let h: OrmHarness;
  let drainer: ActivityOutboxDrainer;

  const outboxRows = async () => {
    const res = await admin.query('SELECT * FROM activity_outbox ORDER BY created_at');
    return res.rows;
  };

  const seedOutboxRow = (id: string, payload: Record<string, any>) =>
    admin.query('INSERT INTO activity_outbox (id, payload) VALUES ($1, $2::jsonb)', [
      id,
      JSON.stringify(payload),
    ]);

  const validPayload = (id = randomUUID()) => ({
    id,
    logName: 'billing',
    description: 'seeded',
    subjectType: 'SampleInvoice',
    subjectId: randomUUID(),
    event: 'created',
    createdAt: new Date().toISOString(),
  });

  beforeAll(async () => {
    admin = await createAdminClient();
    await resetSchema(admin);
    await createSampleTables(admin);
    h = await createOrm({ withAudit: false, feed: { flushMode: 'outbox' } as any });
    drainer = new ActivityOutboxDrainer(h.em as any);
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

  it('writes the intent to the outbox instead of the feed', async () => {
    const invoice = new SampleInvoice();
    invoice.reference = 'OB-1';
    await h.em.persistAndFlush(invoice);

    expect(await feedRows(admin)).toHaveLength(0);
    expect(await outboxRows()).toHaveLength(1);
  });

  it('discards the intent when the business transaction rolls back', async () => {
    await expect(
      h.em.transactional(async (em) => {
        const invoice = new SampleInvoice();
        invoice.reference = 'OB-DOOMED';
        em.persist(invoice);
        await em.flush();
        throw new Error('business failure');
      }),
    ).rejects.toThrow('business failure');

    expect(await outboxRows()).toHaveLength(0);
    expect(await feedRows(admin)).toHaveLength(0);
  });

  it('drains intents into the feed and empties the outbox', async () => {
    const invoice = new SampleInvoice();
    invoice.reference = 'OB-2';
    await h.em.persistAndFlush(invoice);

    const moved = await drainer.drain();
    expect(moved).toBe(1);
    expect(await outboxRows()).toHaveLength(0);

    const [row] = await feedRows(admin);
    expect(row.log_name).toBe('billing');
    expect(row.subject_type).toBe('SampleInvoice');
  });

  it('is a no-op on an empty outbox', async () => {
    expect(await drainer.drain()).toBe(0);
  });

  it('replays idempotently: the same id is never inserted twice', async () => {
    const id = randomUUID();
    await seedOutboxRow(randomUUID(), validPayload(id));
    await drainer.drain();

    // Same activity id arriving again (a replayed batch after a crash).
    await seedOutboxRow(randomUUID(), validPayload(id));
    await drainer.drain();

    expect(await feedRows(admin)).toHaveLength(1);
  });

  it('does not double-write under concurrent drainers', async () => {
    for (let i = 0; i < 20; i++) {
      await seedOutboxRow(randomUUID(), validPayload());
    }

    const results = await Promise.all([
      drainer.drain(5),
      drainer.drain(5),
      drainer.drain(5),
      drainer.drain(5),
    ]);

    const total = results.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(20);
    expect(await feedRows(admin)).toHaveLength(total);
    expect(new Set((await feedRows(admin)).map((r) => r.id)).size).toBe(total);
  });

  it('LOSES NOTHING when the feed insert fails mid-batch', async () => {
    // At-least-once requires the DELETE and the INSERTs to share one transaction.
    // If they do not, a failure after the DELETE destroys the intents for good.
    await seedOutboxRow(randomUUID(), validPayload());
    await seedOutboxRow(randomUUID(), { ...validPayload(), id: 'not-a-uuid' });

    await expect(drainer.drain()).rejects.toThrow();

    expect(await outboxRows()).toHaveLength(2); // both intents survive
    expect(await feedRows(admin)).toHaveLength(0);
  });
});
