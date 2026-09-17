import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ActivityAdapter, TransactionRef } from '../../src/core/ports';
import { ActivityRecord } from '../../src/core/model/activity-record';

/**
 * The acceptance criterion for any `ActivityAdapter` (§11.1).
 *
 * This suite is deliberately written against the PORTS and nothing else: it
 * imports no ORM, no driver and no entity. A TypeORM or Sequelize adapter is
 * "done" when it passes this file unmodified. That is the whole point of having
 * ports — without an executable definition of what they promise, they are four
 * interfaces that drift from their only implementation.
 *
 * Capability flags are honoured rather than assumed: an adapter that reports
 * `providesBeforeState: false` is not asked to produce a before-state.
 */
export interface ConformanceContext {
  adapter: ActivityAdapter;
  /** Runs `fn` inside a transaction and hands back its opaque handle. */
  withTransaction<T>(fn: (tx: TransactionRef) => Promise<T>): Promise<T>;
  /** Rolls back whatever `fn` wrote. */
  withRollback(fn: (tx: TransactionRef) => Promise<void>): Promise<void>;
  /** Reads every feed row currently committed, bypassing the adapter. */
  readAllRecords(): Promise<ActivityRecord[]>;
  /** Removes every feed row. */
  reset(): Promise<void>;
  /** Reads the attribution value the engine currently sees for `tx`, if any. */
  readAttribution?(tx: TransactionRef): Promise<string | null>;
}

export function describeAdapterConformance(
  name: string,
  setup: () => ConformanceContext,
): void {
  describe(`ActivityAdapter conformance: ${name}`, () => {
    let ctx: ConformanceContext;

    const record = (over: Partial<ActivityRecord> = {}): ActivityRecord => ({
      id: randomUUID(),
      logName: 'conformance',
      description: 'a thing happened',
      subjectType: 'Thing',
      subjectId: randomUUID(),
      event: 'created',
      createdAt: new Date(),
      ...over,
    });

    beforeEach(async () => {
      ctx = setup();
      await ctx.reset();
    });

    describe('declares its capabilities', () => {
      it('exposes a stable name', () => {
        expect(typeof ctx.adapter.name).toBe('string');
        expect(ctx.adapter.name.length).toBeGreaterThan(0);
      });

      it('declares both ChangeCapture capability flags as booleans', () => {
        expect(typeof ctx.adapter.capture.providesBeforeState).toBe('boolean');
        expect(typeof ctx.adapter.capture.batchesByFlush).toBe('boolean');
      });

      it('declares an honest SessionBinder scope, or omits the binder', () => {
        const binder = ctx.adapter.binder;
        if (!binder) return;
        expect(['transaction', 'session', 'none']).toContain(binder.scope);
      });
    });

    describe('ActivityStore', () => {
      it('persists a record and makes it readable', async () => {
        const r = record();
        await ctx.withTransaction((tx) => ctx.adapter.store.persist([r], tx));

        const all = await ctx.readAllRecords();
        expect(all).toHaveLength(1);
        expect(all[0].id).toBe(r.id);
        expect(all[0].logName).toBe('conformance');
        expect(all[0].description).toBe('a thing happened');
      });

      it('persists a batch in one call', async () => {
        const rs = [record(), record(), record()];
        await ctx.withTransaction((tx) => ctx.adapter.store.persist(rs, tx));

        expect(await ctx.readAllRecords()).toHaveLength(3);
      });

      it('accepts an empty batch without writing anything', async () => {
        await ctx.withTransaction((tx) => ctx.adapter.store.persist([], tx));
        expect(await ctx.readAllRecords()).toHaveLength(0);
      });

      it('round-trips optional fields, including jsonb properties', async () => {
        const r = record({
          causerType: 'User',
          causerId: 'u-1',
          tenantId: 't-1',
          properties: { total: 42, nested: { ok: true } },
        });
        await ctx.withTransaction((tx) => ctx.adapter.store.persist([r], tx));

        const [stored] = await ctx.readAllRecords();
        expect(stored.causerId).toBe('u-1');
        expect(stored.tenantId).toBe('t-1');
        expect(stored.properties).toEqual({ total: 42, nested: { ok: true } });
      });

      it('WRITES INSIDE THE AMBIENT TRANSACTION: a rollback discards the row', async () => {
        // The single most important promise of the port. An adapter that opens
        // its own connection here would leave orphan feed rows behind every
        // failed business transaction, and the "sync" mode of §4.8 would be a lie.
        await ctx.withRollback(async (tx) => {
          await ctx.adapter.store.persist([record()], tx);
        });

        expect(await ctx.readAllRecords()).toHaveLength(0);
      });
    });

    describe('ActivityReader', () => {
      it('filters by subject and by log name', async () => {
        const mine = record({ subjectType: 'Invoice', subjectId: 'inv-1', logName: 'billing' });
        const other = record({ subjectType: 'Invoice', subjectId: 'inv-2', logName: 'billing' });
        await ctx.withTransaction((tx) => ctx.adapter.store.persist([mine, other], tx));

        const reader = ctx.adapter.reader;
        if (!reader) return;

        const page = await reader.query({ subjectType: 'Invoice', subjectId: 'inv-1' });
        expect(page.data.map((r) => r.id)).toEqual([mine.id]);

        const byLog = await reader.query({ logName: 'billing' });
        expect(byLog.data).toHaveLength(2);
      });

      it('scopes by tenant, and crosses tenants only when asked explicitly', async () => {
        const reader = ctx.adapter.reader;
        if (!reader) return;

        await ctx.withTransaction((tx) =>
          ctx.adapter.store.persist(
            [record({ tenantId: 'a' }), record({ tenantId: 'b' })],
            tx,
          ),
        );

        expect((await reader.query({ tenantId: 'a' })).data).toHaveLength(1);
        expect((await reader.query({ tenantId: null })).data).toHaveLength(2);
      });

      it('paginates by cursor without repeating or skipping', async () => {
        const reader = ctx.adapter.reader;
        if (!reader) return;

        const rs = Array.from({ length: 7 }, (_, i) =>
          record({ createdAt: new Date(Date.now() - i * 1000) }),
        );
        await ctx.withTransaction((tx) => ctx.adapter.store.persist(rs, tx));

        const seen: string[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 20; i++) {
          const page = await reader.query({ limit: 3, cursor });
          seen.push(...page.data.map((r) => r.id));
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }

        expect(seen).toHaveLength(7);
        expect(new Set(seen).size).toBe(7);
      });

      it('counts with the same filters it queries with', async () => {
        const reader = ctx.adapter.reader;
        if (!reader) return;

        await ctx.withTransaction((tx) =>
          ctx.adapter.store.persist(
            [record({ tenantId: 'a' }), record({ tenantId: 'a' }), record({ tenantId: 'b' })],
            tx,
          ),
        );

        expect(await reader.count({ tenantId: 'a' })).toBe(2);
        expect(await reader.count({ tenantId: null })).toBe(3);
      });

      it('prunes only what is older than the cutoff, in bounded batches', async () => {
        const reader = ctx.adapter.reader;
        if (!reader) return;

        const old = Array.from({ length: 5 }, () =>
          record({ createdAt: new Date(Date.now() - 400 * 864e5) }),
        );
        const fresh = [record(), record()];
        await ctx.withTransaction((tx) => ctx.adapter.store.persist([...old, ...fresh], tx));

        const cutoff = new Date(Date.now() - 100 * 864e5);
        expect(await reader.prune(cutoff, 2)).toBe(5);
        expect(await ctx.readAllRecords()).toHaveLength(2);
      });

      it('returns an exhausted page rather than a cursor when nothing matches', async () => {
        const reader = ctx.adapter.reader;
        if (!reader) return;

        const page = await reader.query({ subjectId: 'does-not-exist' });
        expect(page.data).toEqual([]);
        expect(page.nextCursor).toBeNull();
      });
    });

    describe('SessionBinder', () => {
      it('makes the bound identity visible inside the transaction', async () => {
        const binder = ctx.adapter.binder;
        if (!binder || !ctx.readAttribution) return;

        await ctx.withTransaction(async (tx) => {
          await binder.bind('user-conformance', tx);
          expect(await ctx.readAttribution!(tx)).toBe('user-conformance');
        });
      });

      it('CONFINES the binding to the transaction when it claims transaction scope', async () => {
        const binder = ctx.adapter.binder;
        if (!binder || binder.scope !== 'transaction' || !ctx.readAttribution) return;

        // An adapter claiming transaction scope must not leak into the next
        // transaction on the same connection. Claiming it falsely is how one
        // user's identity ends up attributed to the next borrower's writes.
        await ctx.withTransaction(async (tx) => {
          await binder.bind('user-first', tx);
        });

        await ctx.withTransaction(async (tx) => {
          expect(await ctx.readAttribution!(tx)).toBeNull();
        });
      });

      it('is idempotent within one transaction', async () => {
        const binder = ctx.adapter.binder;
        if (!binder || !ctx.readAttribution) return;

        await ctx.withTransaction(async (tx) => {
          await binder.bind('user-a', tx);
          await binder.bind('user-a', tx);
          expect(await ctx.readAttribution!(tx)).toBe('user-a');
        });
      });
    });
  });
}
