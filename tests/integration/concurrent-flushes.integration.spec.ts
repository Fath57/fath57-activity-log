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
import { SampleTicket } from '../fixtures/sample-entities';

/**
 * §4.5 under concurrency.
 *
 * One subscriber instance serves every fork, and `onFlush` and `afterFlush` are
 * separated by awaits, so a second flush interleaves between them. Staging held
 * on the subscriber let the first `afterFlush` drain the other flush's creations
 * and update rows its transaction had not committed — no error, no match, and an
 * entry left with `subject_id` NULL.
 *
 * Every assertion here passes trivially when the flushes are serialised, which is
 * why the whole suite missed it.
 */
describe('concurrent flushes through one subscriber', () => {
  let admin: Client;
  let h: OrmHarness;

  const newTicket = (em: any, title: string) => {
    const t = new SampleTicket();
    t.title = title;
    em.persist(t);
    return t;
  };

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
  });

  it('resolves a generated key for every flush in flight', async () => {
    const create = (title: string) =>
      h.orm.em.fork().transactional(async (em) => {
        const ticket = newTicket(em, title);
        await em.flush();
        return ticket.id;
      });

    const ids = await Promise.all([create('A'), create('B'), create('C')]);

    const rows = await feedRows(admin);
    expect(rows).toHaveLength(3);
    expect(rows.map((r: any) => r.subject_id).sort()).toEqual(
      ids.map(String).sort(),
    );
  });

  it('keeps each entry matched to its own subject', async () => {
    const create = (title: string) =>
      h.orm.em.fork().transactional(async (em) => {
        const ticket = newTicket(em, title);
        await em.flush();
        return { id: String(ticket.id), title };
      });

    const made = await Promise.all([create('A'), create('B')]);
    const rows = await feedRows(admin);

    // A drain that emptied the shared list would still leave two rows; what it
    // could not do is keep every description paired with its own key.
    for (const { id, title } of made) {
      const row = rows.find((r: any) => r.subject_id === id);
      expect(row, `no feed row for ticket ${title}`).toBeDefined();
      expect(row.description).toBe(`Ticket #${id} created`);
    }
  });
});
