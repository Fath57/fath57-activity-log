import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { createAdminClient, resetSchema } from '../fixtures/test-database.helper';
import { getTrackTableSql } from '../../src/migrations';

/**
 * §6 — measured per-mutation overhead by row shape.
 *
 * Publishes numbers; asserts no latency threshold. The spec makes no
 * sub-millisecond guarantee, and a CI-enforced bound on a shared runner would be
 * noise rather than signal.
 *
 * Shapes are measured ROUND-ROBIN rather than one after another. Measuring each
 * shape to completion in turn attributes every source of drift -- connection
 * warm-up, cache state, a busy host -- to whichever shape happened to run first.
 * An earlier version of this file did exactly that and reported the audited
 * narrow row as *faster* than the untriggered baseline (0.8x), which is not a
 * result, it is an artefact. Interleaving cancels monotonic drift; the remaining
 * noise shows up in the spread rather than in the ranking.
 *
 * Run: npm run bench
 */
describe('audit trigger overhead by row shape', () => {
  let admin: Client;

  const WIDE_COLS = Array.from({ length: 30 }, (_, i) => `c${i}`);
  const BIG = 'x'.repeat(512 * 1024);
  const ROWS = 40;
  const ROUNDS = 40;
  const WARMUP = 10;

  interface Shape {
    label: string;
    baseline?: boolean;
    ids: string[];
    update: (id: string) => Promise<unknown>;
  }

  const shapes: Shape[] = [];

  const seed = async (
    table: string,
    insert: (id: string) => Promise<unknown>,
  ): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < ROWS; i++) {
      const id = randomUUID();
      await insert(id);
      ids.push(id);
    }
    return ids;
  };

  beforeAll(async () => {
    admin = await createAdminClient();
    await resetSchema(admin);
    await admin.query(
      'DROP TABLE IF EXISTS bench_narrow, bench_base, bench_wide, bench_toast, bench_toast_ign CASCADE',
    );

    // Untriggered baseline, kept as its own table so the audited narrow table
    // does not have to be tracked half-way through the run.
    await admin.query('CREATE TABLE bench_base (id UUID PRIMARY KEY, n INT NOT NULL)');
    await admin.query('CREATE TABLE bench_narrow (id UUID PRIMARY KEY, n INT NOT NULL)');
    await admin.query(
      `CREATE TABLE bench_wide (id UUID PRIMARY KEY, ${WIDE_COLS.map((c) => `${c} TEXT`).join(', ')})`,
    );
    await admin.query('CREATE TABLE bench_toast (id UUID PRIMARY KEY, n INT NOT NULL, blob TEXT)');
    await admin.query('CREATE TABLE bench_toast_ign (id UUID PRIMARY KEY, n INT NOT NULL, blob TEXT)');

    const baseIds = await seed('bench_base', (id) =>
      admin.query('INSERT INTO bench_base (id, n) VALUES ($1, 0)', [id]),
    );
    const narrowIds = await seed('bench_narrow', (id) =>
      admin.query('INSERT INTO bench_narrow (id, n) VALUES ($1, 0)', [id]),
    );
    const wideCols = WIDE_COLS.join(', ');
    const widePlaceholders = WIDE_COLS.map((_, i) => `$${i + 2}`).join(', ');
    const wideIds = await seed('bench_wide', (id) =>
      admin.query(`INSERT INTO bench_wide (id, ${wideCols}) VALUES ($1, ${widePlaceholders})`, [
        id,
        ...WIDE_COLS.map(() => 'value'),
      ]),
    );
    const toastIds = await seed('bench_toast', (id) =>
      admin.query('INSERT INTO bench_toast (id, n, blob) VALUES ($1, 0, $2)', [id, BIG]),
    );
    const toastIgnIds = await seed('bench_toast_ign', (id) =>
      admin.query('INSERT INTO bench_toast_ign (id, n, blob) VALUES ($1, 0, $2)', [id, BIG]),
    );

    await admin.query(getTrackTableSql('public.bench_narrow', ['id'], [], false));
    await admin.query(getTrackTableSql('public.bench_wide', ['id'], [], false));
    await admin.query(getTrackTableSql('public.bench_toast', ['id'], [], false));
    await admin.query(getTrackTableSql('public.bench_toast_ign', ['id'], ['blob'], false));

    shapes.push(
      {
        label: 'narrow row, NO trigger (baseline)',
        baseline: true,
        ids: baseIds,
        update: (id) => admin.query('UPDATE bench_base SET n = n + 1 WHERE id = $1', [id]),
      },
      {
        label: 'narrow row, audited',
        ids: narrowIds,
        update: (id) => admin.query('UPDATE bench_narrow SET n = n + 1 WHERE id = $1', [id]),
      },
      {
        label: 'wide row (30 cols), audited',
        ids: wideIds,
        update: (id) => admin.query('UPDATE bench_wide SET c0 = c0 || $1 WHERE id = $2', ['.', id]),
      },
      {
        label: '512KB TOAST column, audited, NOT ignored',
        ids: toastIds,
        update: (id) => admin.query('UPDATE bench_toast SET n = n + 1 WHERE id = $1', [id]),
      },
      {
        label: '512KB TOAST column, audited, IGNORED',
        ids: toastIgnIds,
        update: (id) => admin.query('UPDATE bench_toast_ign SET n = n + 1 WHERE id = $1', [id]),
      },
    );
  });

  afterAll(async () => {
    await admin.query(
      'DROP TABLE IF EXISTS bench_narrow, bench_base, bench_wide, bench_toast, bench_toast_ign CASCADE',
    );
    await admin.end();
  });

  it('measures every shape interleaved and reports the spread', async () => {
    const samples = new Map<string, number[]>(shapes.map((s) => [s.label, []]));

    // Warm every shape before any of them is timed: connection, plan cache and
    // the first de-TOAST are all one-off costs that belong to nobody.
    for (let i = 0; i < WARMUP; i++) {
      for (const shape of shapes) {
        await shape.update(shape.ids[i % shape.ids.length]);
      }
    }

    for (let round = 0; round < ROUNDS; round++) {
      for (const shape of shapes) {
        const id = shape.ids[round % shape.ids.length];
        const t0 = process.hrtime.bigint();
        await shape.update(id);
        samples.get(shape.label)!.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
    }

    const stats = shapes.map((shape) => {
      const xs = samples.get(shape.label)!.slice().sort((a, b) => a - b);
      return {
        label: shape.label,
        baseline: shape.baseline === true,
        median: xs[Math.floor(xs.length / 2)],
        p95: xs[Math.floor(xs.length * 0.95)],
      };
    });

    const base = stats.find((s) => s.baseline)!.median;
    const pad = (s: string, n: number) => s.padEnd(n);
    const num = (n: number) => n.toFixed(3).padStart(9);

    const lines = [
      '',
      `  audit trigger overhead — ${ROUNDS} interleaved rounds, ${WARMUP} warm-up`,
      '  ' + '-'.repeat(74),
      '  ' + pad('shape', 44) + '   median      p95   vs base',
    ];
    for (const s of stats) {
      lines.push('  ' + pad(s.label, 44) + num(s.median) + num(s.p95) + '   ' + (s.median / base).toFixed(1) + 'x');
    }
    lines.push('  ' + '-'.repeat(74), '');
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));

    const byLabel = Object.fromEntries(stats.map((s) => [s.label, s.median]));

    // Only one ordering here is robust enough to assert: de-TOASTing a large
    // column costs several times what the trigger itself does, and listing it in
    // ignored_columns recovers most of that.
    //
    // Deliberately NOT asserted: that the audited narrow row is slower than the
    // untriggered baseline. It is, on average — but by less than the run-to-run
    // spread at this sample size, and an earlier version of this file asserted it
    // and would have failed on a run where the audited median came out 0.03 ms
    // below the baseline. An assertion that fails on noise teaches you to ignore
    // the suite. The number is reported; the claim is not made.
    expect(byLabel['512KB TOAST column, audited, IGNORED']).toBeLessThan(
      byLabel['512KB TOAST column, audited, NOT ignored'] / 2,
    );
    expect(base).toBeGreaterThan(0);
  });
});
