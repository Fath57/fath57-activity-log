import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  auditRows,
  createAdminClient,
  resetSchema,
  truncateAudit,
} from '../fixtures/test-database.helper';
import { getTrackTableSql } from '../../src/migrations';

/**
 * §6, "Large Column (TOAST) Overhead".
 *
 * `to_jsonb(NEW)` de-TOASTs every large column on every audited write, and the row
 * is then stored twice more inside the audit payload. These tests make the cost
 * observable and prove `ignored_columns` is the lever the spec says it is.
 */
describe('TOAST overhead and ignored_columns', () => {
  let admin: Client;
  const BIG = 'x'.repeat(512 * 1024); // 512 KB, comfortably past the TOAST threshold

  const auditSize = async () => {
    const res = await admin.query(
      `SELECT COALESCE(sum(pg_column_size(old_data) + pg_column_size(new_data)), 0)::bigint AS bytes
         FROM audit.logged_actions WHERE table_name = 'documents'`,
    );
    return Number(res.rows[0].bytes);
  };

  beforeAll(async () => {
    admin = await createAdminClient();
    await resetSchema(admin);
    await admin.query(`
      CREATE TABLE public.documents (
        id      UUID PRIMARY KEY,
        title   TEXT NOT NULL,
        content TEXT
      );
    `);
  });

  afterAll(async () => {
    await admin.query('DROP TABLE IF EXISTS public.documents CASCADE;');
    await admin.end();
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM public.documents;');
    await truncateAudit(admin);
  });

  const seed = async () => {
    const id = randomUUID();
    await admin.query('INSERT INTO public.documents (id, title, content) VALUES ($1, $2, $3)', [
      id,
      'Doc',
      BIG,
    ]);
    return id;
  };

  it('carries the whole large column into the audit payload when not ignored', async () => {
    await admin.query(getTrackTableSql('public.documents', ['id'], [], false));
    const id = await seed();

    await truncateAudit(admin);
    await admin.query('UPDATE public.documents SET title = $1 WHERE id = $2', ['Doc v2', id]);

    const [row] = await auditRows(admin, 'documents');
    // The content did not change, yet both snapshots embed it in full.
    expect(row.old_data.content).toHaveLength(BIG.length);
    expect(row.new_data.content).toHaveLength(BIG.length);
    // ... while the diff correctly contains only the changed column.
    expect(Object.keys(row.changed_fields)).toEqual(['title']);
  });

  it('drops it entirely once listed in ignored_columns', async () => {
    await admin.query(getTrackTableSql('public.documents', ['id'], ['content'], false));
    const id = await seed();

    await truncateAudit(admin);
    await admin.query('UPDATE public.documents SET title = $1 WHERE id = $2', ['Doc v2', id]);

    const [row] = await auditRows(admin, 'documents');
    expect(row.old_data).not.toHaveProperty('content');
    expect(row.new_data).not.toHaveProperty('content');
  });

  it('shrinks the stored audit payload by orders of magnitude', async () => {
    await admin.query(getTrackTableSql('public.documents', ['id'], [], false));
    const id = await seed();
    await truncateAudit(admin);
    await admin.query('UPDATE public.documents SET title = $1 WHERE id = $2', ['A', id]);
    const withContent = await auditSize();

    await admin.query('DELETE FROM public.documents;');
    await admin.query(getTrackTableSql('public.documents', ['id'], ['content'], false));
    const id2 = await seed();
    await truncateAudit(admin);
    await admin.query('UPDATE public.documents SET title = $1 WHERE id = $2', ['A', id2]);
    const withoutContent = await auditSize();

    expect(withContent).toBeGreaterThan(withoutContent * 10);
  });

  it('still writes no audit row when only the ignored large column changes', async () => {
    await admin.query(getTrackTableSql('public.documents', ['id'], ['content'], false));
    const id = await seed();
    await truncateAudit(admin);

    await admin.query('UPDATE public.documents SET content = $1 WHERE id = $2', [
      'y'.repeat(512 * 1024),
      id,
    ]);

    expect(await auditRows(admin, 'documents')).toHaveLength(0);
  });
});
