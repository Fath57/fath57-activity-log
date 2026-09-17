import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  createAdminClient,
  resetSchema,
} from '../fixtures/test-database.helper';
import {
  clearSampleData,
  createOrm,
  createSampleTables,
  dropSampleTables,
  feedRows,
  OrmHarness,
} from '../fixtures/orm.helper';
import { SampleTicket, SampleInvoice } from '../fixtures/sample-entities';

/**
 * Review hypothesis 1, and §4.5.
 *
 * `onFlush` runs before the INSERT, so a database-generated key does not exist
 * yet. The spec claims `afterFlush` fires AFTER the flush has committed, which
 * would put the resolving UPDATE in a separate transaction whenever the flush is
 * implicit. That claim is load-bearing for the atomicity boundary — these tests
 * settle it against the real ORM instead of assuming it.
 */
describe('primary key resolution for database-generated ids', () => {
  let admin: Client;
  let h: OrmHarness;

  beforeAll(async () => {
    admin = await createAdminClient();
    await resetSchema(admin);
    await createSampleTables(admin);
    h = await createOrm({ withAudit: false });
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

  it('populates subjectId synchronously for a client-assigned key', async () => {
    const invoice = new SampleInvoice();
    invoice.reference = 'INV-UUID';
    h.em.persist(invoice);
    await h.em.flush();

    const [row] = await feedRows(admin);
    expect(row.subject_type).toBe('SampleInvoice');
    expect(row.subject_id).toBe(invoice.id);
  });

  it("resolves subjectId for a SERIAL key under generatedIdStrategy 'resolve'", async () => {
    const ticket = new SampleTicket();
    ticket.title = 'Printer on fire';
    h.em.persist(ticket);
    await h.em.flush();

    expect(ticket.id).toBeGreaterThan(0);

    const [row] = await feedRows(admin);
    expect(row.subject_type).toBe('SampleTicket');
    expect(row.subject_id).toBe(String(ticket.id));
  });

  it('reformats a description that reads a database-assigned key', async () => {
    const ticket = new SampleTicket();
    ticket.title = 'Printer still on fire';
    h.em.persist(ticket);
    await h.em.flush();

    const [row] = await feedRows(admin);
    // Formatted at onFlush this reads "Ticket #undefined created": the SERIAL
    // key is assigned by the INSERT, after the description is built.
    expect(row.description).toBe(`Ticket #${ticket.id} created`);
    expect(row.description).not.toContain('undefined');
    expect(row.subject_id).toBe(String(ticket.id));
  });

  it('leaves a client-assigned key path alone: nothing to reformat', async () => {
    const invoice = new SampleInvoice();
    invoice.reference = 'INV-DESC';
    h.em.persist(invoice);
    await h.em.flush();

    // Never staged, so the afterFlush pass does not touch it at all; the text
    // built during onFlush is the text that stays.
    const [row] = await feedRows(admin);
    expect(row.description).toBe('Invoice INV-DESC created');
  });

  it("leaves subjectId null under generatedIdStrategy 'skip'", async () => {
    const skipping = await createOrm({
      withAudit: false,
      feed: { generatedIdStrategy: 'skip' } as any,
    });
    try {
      const ticket = new SampleTicket();
      ticket.title = 'No resolution wanted';
      skipping.em.persist(ticket);
      await skipping.em.flush();

      const [row] = await feedRows(admin);
      expect(row.subject_type).toBe('SampleTicket');
      expect(row.subject_id).toBeNull();
    } finally {
      await skipping.close();
    }
  });

  /**
   * HYPOTHESIS 1. If afterFlush ran before the commit, rolling the transaction
   * back would discard the resolving UPDATE along with everything else, and the
   * feed row would be gone. If it runs after the commit, the resolving UPDATE
   * lands in its own transaction.
   */
  it('keeps the whole unit atomic on rollback inside em.transactional()', async () => {
    await expect(
      h.em.transactional(async (em) => {
        const ticket = new SampleTicket();
        ticket.title = 'Doomed';
        em.persist(ticket);
        await em.flush();
        throw new Error('business failure');
      }),
    ).rejects.toThrow('business failure');

    // Nothing survives: not the business row, not the feed row.
    const tickets = await admin.query('SELECT count(*)::int AS n FROM public.sample_tickets');
    expect(tickets.rows[0].n).toBe(0);
    expect(await feedRows(admin)).toHaveLength(0);
  });

  it('keeps a client-assigned-key unit atomic on rollback too', async () => {
    await expect(
      h.em.transactional(async (em) => {
        const invoice = new SampleInvoice();
        invoice.reference = 'INV-DOOMED';
        em.persist(invoice);
        await em.flush();
        throw new Error('business failure');
      }),
    ).rejects.toThrow('business failure');

    const invoices = await admin.query('SELECT count(*)::int AS n FROM public.sample_invoices');
    expect(invoices.rows[0].n).toBe(0);
    expect(await feedRows(admin)).toHaveLength(0);
  });

  it('documents where afterFlush actually runs relative to the commit', async () => {
    // Observed directly: is the flushed row visible to an OUTSIDE connection by
    // the time afterFlush runs? Visible => the flush already committed.
    let visibleDuringAfterFlush: number | null = null;

    const probe = await createOrm({ withAudit: false });
    try {
      const subscribers = [...probe.orm.config.get('subscribers')] as any[];
      subscribers[0].afterFlush = async function (args: any) {
        const res = await admin.query('SELECT count(*)::int AS n FROM public.sample_tickets');
        visibleDuringAfterFlush = res.rows[0].n;
      };

      const ticket = new SampleTicket();
      ticket.title = 'Probe';
      probe.em.persist(ticket);
      await probe.em.flush();
    } finally {
      await probe.close();
    }

    // This assertion records the observed behaviour of MikroORM v6 so that a
    // future upgrade changing it fails here rather than silently breaking the
    // atomicity guarantee documented in §4.5.
    expect(visibleDuringAfterFlush).toBe(1);
  });
});
