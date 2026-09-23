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
import { SampleInvoice, SampleTicket } from '../fixtures/sample-entities';
import { ActivityOutboxDrainer } from '../../src/feed/services/activity-outbox.drainer';
import { MikroOrmActivityStore } from '../../src/adapters/mikro-orm/mikro-orm-activity-store';

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
    // The drainer takes the store port now; the harness supplies MikroORM's.
    drainer = new ActivityOutboxDrainer(new MikroOrmActivityStore(h.em as any));
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
    h.em.persist(invoice);
    await h.em.flush();

    expect(await feedRows(admin)).toHaveLength(0);
    expect(await outboxRows()).toHaveLength(1);
  });

  /**
   * §4.5 under §4.8 — the identifier and the description have to be resolved in
   * the outbox too. The subscriber stages the creation the same way in both flush
   * modes, but the row it has to revisit is in activity_outbox, inside a JSON
   * payload, not in activity_logs.
   */
  it('resolves a database-assigned key into the outbox payload', async () => {
    const ticket = new SampleTicket();
    ticket.title = 'Outbox ticket';
    h.em.persist(ticket);
    await h.em.flush();

    expect(ticket.id).toBeGreaterThan(0);

    const moved = await drainer.drain();
    expect(moved).toBe(1);

    const [row] = await feedRows(admin);
    expect(row.subject_type).toBe('SampleTicket');
    expect(row.subject_id).toBe(String(ticket.id));
    expect(row.description).toBe(`Ticket #${ticket.id} created`);
  });

  it('merges into the payload without dropping the rest of the record', async () => {
    const ticket = new SampleTicket();
    ticket.title = 'Keeps its fields';
    h.em.persist(ticket);
    await h.em.flush();

    // The patch is a jsonb `||` merge, so this is the assertion that matters:
    // every field the record carried has to survive being merged into.
    const [row] = await outboxRows();
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;

    expect(payload.subjectId).toBe(String(ticket.id));
    expect(payload.logName).toBe('support');
    expect(payload.subjectType).toBe('SampleTicket');
    expect(payload.event).toBe('created');
    expect(payload.id).toBeTruthy();
    expect(payload.createdAt).toBeTruthy();
    expect(payload.properties).toMatchObject({ title: 'Keeps its fields' });
  });

  it('leaves a client-assigned key untouched in the outbox', async () => {
    const invoice = new SampleInvoice();
    invoice.reference = 'OB-CLIENT-KEY';
    h.em.persist(invoice);
    await h.em.flush();

    // Never staged: subjectId was known during onFlush, so no patch runs at all.
    const [row] = await outboxRows();
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;

    expect(payload.subjectId).toBe(invoice.id);
    expect(payload.description).toBe('Invoice OB-CLIENT-KEY created');
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
    h.em.persist(invoice);
    await h.em.flush();

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
