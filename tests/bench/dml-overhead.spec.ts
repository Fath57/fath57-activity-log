import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { createAdminClient, resetSchema } from '../fixtures/test-database.helper';
import { getTrackTableSql } from '../../src/migrations';

/**
 * §6 — measured per-mutation overhead by row shape.
 *
 * This benchmark PUBLISHES numbers and asserts no latency threshold. The spec
 * makes no sub-millisecond guarantee, and a CI-enforced bound on a shared runner
 * would be noise. Read the table to size your own workload:
 *
 *   narrow       a few small columns   -> the floor of the trigger's cost
 *   wide         30 text columns       -> to_jsonb() over a large tuple
 *   toasted      one 512 KB column     -> de-TOAST on every audited write
 *   toasted+ign  same, column ignored  -> what ignored_columns buys back
 *
 * Run: npm run bench
 */
describe('audit trigger overhead by row shape', () => {
  let admin: Client;
  const WIDE_COLS = Array.from({ length: 30 }, (_, i) => `c${i}`);
  const BIG = 'x'.repeat(512 * 1024);
  const ROWS = 60;
  const results: Array<{ shape: string; medianMs: number; p95Ms: number }> = [];

  const seedRows = async (table: string, insert: (id: string) => Promise<unknown>) => {
    const ids: string[] = [];
    for (let i = 0; i < ROWS; i++) {
      const id = randomUUID();
      await insert(id);
      ids.push(id);
    }
    return ids;
  };

  const measure = async (shape: string, ids: string[], update: (id: string) => Promise<unknown>) => {
    // Warm-up: first touch of a TOASTed row is not representative.
    for (let i = 0; i < 5; i++) await update(ids[i % ids.length]);

    const samples: number[] = [];
    for (const id of ids) {
      const t0 = process.hrtime.bigint();
      await update(id);
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    samples.sort((a, b) => a - b);
    const medianMs = samples[Math.floor(samples.length / 2)];
    const p95Ms = samples[Math.floor(samples.length * 0.95)];
    results.push({ shape, medianMs, p95Ms });
    return { medianMs, p95Ms };
  };

  beforeAll(async () => {
    admin = await createAdminClient();
    await resetSchema(admin);
    await admin.query('DROP TABLE IF EXISTS bench_narrow, bench_wide, bench_toast, bench_toast_ign CASCADE');
    await admin.query('CREATE TABLE bench_narrow (id UUID PRIMARY KEY, n INT NOT NULL)');
    await admin.query(
      `CREATE TABLE bench_wide (id UUID PRIMARY KEY, ${WIDE_COLS.map((c) => `${c} TEXT`).join(', ')})`,
    );
    await admin.query('CREATE TABLE bench_toast (id UUID PRIMARY KEY, n INT NOT NULL, blob TEXT)');
    await admin.query('CREATE TABLE bench_toast_ign (id UUID PRIMARY KEY, n INT NOT NULL, blob TEXT)');
  });

  afterAll(async () => {
    const baseline = results.find((r) => r.shape.includes('baseline'))?.medianMs ?? 0;
    const pad = (s: string, n: number) => s.padEnd(n);
    const num = (n: number) => n.toFixed(3).padStart(9);

    const lines = [
      '',
      `  audit trigger overhead — median / p95 per UPDATE, ${ROWS} samples`,
      '  ' + '-'.repeat(74),
      '  ' + pad('shape', 44) + '   median      p95   vs base',
    ];
    for (const r of results) {
      const ratio = baseline > 0 ? (r.medianMs / baseline).toFixed(1) + 'x' : '—';
      lines.push('  ' + pad(r.shape, 44) + num(r.medianMs) + num(r.p95Ms) + '   ' + ratio);
    }
    lines.push('  ' + '-'.repeat(74), '');
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));

    await admin.query('DROP TABLE IF EXISTS bench_narrow, bench_wide, bench_toast, bench_toast_ign CASCADE');
    await admin.end();
  });

  it('narrow row, NO audit trigger (baseline)', async () => {
    const ids = await seedRows('bench_narrow', (id) =>
      admin.query('INSERT INTO bench_narrow (id, n) VALUES ($1, 0)', [id]),
    );
    const r = await measure('narrow row, NO trigger (baseline)', ids, (id) =>
      admin.query('UPDATE bench_narrow SET n = n + 1 WHERE id = $1', [id]),
    );
    expect(r.medianMs).toBeGreaterThan(0);
  });

  it('narrow row, audited', async () => {
    await admin.query(getTrackTableSql('public.bench_narrow', ['id'], [], false));
    const ids = (await admin.query('SELECT id FROM bench_narrow')).rows.map((r) => r.id);
    const r = await measure('narrow row, audited', ids, (id) =>
      admin.query('UPDATE bench_narrow SET n = n + 1 WHERE id = $1', [id]),
    );
    expect(r.medianMs).toBeGreaterThan(0);
  });

  it('wide row (30 columns), audited', async () => {
    const cols = WIDE_COLS.join(', ');
    const params = WIDE_COLS.map((_, i) => `$${i + 2}`).join(', ');
    const ids = await seedRows('bench_wide', (id) =>
      admin.query(`INSERT INTO bench_wide (id, ${cols}) VALUES ($1, ${params})`, [
        id,
        ...WIDE_COLS.map(() => 'value'),
      ]),
    );
    await admin.query(getTrackTableSql('public.bench_wide', ['id'], [], false));

    const r = await measure('wide row (30 cols), audited', ids, (id) =>
      admin.query('UPDATE bench_wide SET c0 = c0 || $1 WHERE id = $2', ['.', id]),
    );
    expect(r.medianMs).toBeGreaterThan(0);
  });

  it('512 KB TOASTed column, audited, column NOT ignored', async () => {
    const ids = await seedRows('bench_toast', (id) =>
      admin.query('INSERT INTO bench_toast (id, n, blob) VALUES ($1, 0, $2)', [id, BIG]),
    );
    await admin.query(getTrackTableSql('public.bench_toast', ['id'], [], false));

    const r = await measure('512KB TOAST column, audited, NOT ignored', ids, (id) =>
      admin.query('UPDATE bench_toast SET n = n + 1 WHERE id = $1', [id]),
    );
    expect(r.medianMs).toBeGreaterThan(0);
  });

  it('512 KB TOASTed column, audited, column IGNORED', async () => {
    const ids = await seedRows('bench_toast_ign', (id) =>
      admin.query('INSERT INTO bench_toast_ign (id, n, blob) VALUES ($1, 0, $2)', [id, BIG]),
    );
    await admin.query(getTrackTableSql('public.bench_toast_ign', ['id'], ['blob'], false));

    const r = await measure('512KB TOAST column, audited, IGNORED', ids, (id) =>
      admin.query('UPDATE bench_toast_ign SET n = n + 1 WHERE id = $1', [id]),
    );
    expect(r.medianMs).toBeGreaterThan(0);
  });
});
