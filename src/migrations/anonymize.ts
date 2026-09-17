/**
 * Driver for `audit.anonymize_subject_batch()` (GDPR art. 17, §7.2).
 *
 * The loop lives here rather than inside PL/pgSQL because a procedure performing
 * its own COMMIT cannot be invoked over the extended query protocol — PostgreSQL
 * raises `invalid transaction termination`, since parameterised statements run
 * inside an implicit transaction. Keeping the batch as a plain function lets
 * callers pass bound parameters instead of interpolating a subject identifier
 * into SQL text.
 */

export interface AnonymizeSubjectOptions {
  /** Schema of the audited business table, e.g. `'public'`. */
  schema: string;
  /** Table the subject lives in. REQUIRED: `row_id` is unique only within a table. */
  table: string;
  /** The subject's identifier in that table. */
  rowId: string;
  /** The same person seen as a causer (`changed_by`), or null to scope by subject only. */
  actor?: string | null;
  /** Personal-data keys to strip from `old_data` / `new_data`. Per table. */
  keys: string[];
  /** Inclusive lower bound. Enables partition pruning — do not widen needlessly. */
  from: Date;
  /** Exclusive upper bound. */
  to: Date;
  /** Rows per transaction. Default 10 000. */
  batchSize?: number;
  /** Safety valve against an unexpectedly non-terminating predicate. Default 10 000. */
  maxBatches?: number;
}

/** Minimal shape satisfied by `pg.Client`, `pg.Pool` and MikroORM's connection. */
export interface SqlExecutor {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

const SQL =
  'SELECT audit.anonymize_subject_batch($1, $2, $3, $4, $5::text[], $6::timestamptz, $7::timestamptz, $8) AS n';

/**
 * Runs the anonymisation to completion, one bounded transaction per batch.
 * Returns the total number of rows rewritten.
 */
export async function anonymizeSubject(
  executor: SqlExecutor,
  options: AnonymizeSubjectOptions,
): Promise<number> {
  const {
    schema,
    table,
    rowId,
    actor = null,
    keys,
    from,
    to,
    batchSize = 10_000,
    maxBatches = 10_000,
  } = options;

  if (!table) {
    throw new Error(
      'anonymizeSubject: `table` is required. row_id is unique only within a table, ' +
        'so omitting it would rewrite unrelated rows sharing the same identifier.',
    );
  }
  if (!keys.length) {
    throw new Error('anonymizeSubject: `keys` must list at least one key to strip.');
  }
  if (!(from < to)) {
    throw new Error('anonymizeSubject: `from` must be strictly before `to`.');
  }

  let total = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const res = await executor.query(SQL, [
      schema,
      table,
      rowId,
      actor,
      keys,
      from.toISOString(),
      to.toISOString(),
      batchSize,
    ]);
    const n = Number(res.rows[0]?.n ?? 0);
    if (n === 0) return total;
    total += n;
  }

  throw new Error(
    `anonymizeSubject: still matching rows after ${maxBatches} batches ` +
      `(${total} rewritten). The predicate is not converging — investigate before retrying.`,
  );
}
