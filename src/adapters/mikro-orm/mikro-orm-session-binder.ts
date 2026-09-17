import { EntityManager } from '@mikro-orm/core';
import { SessionBinder, TransactionRef } from '../../core/ports';

/**
 * PostgreSQL attribution binder for MikroORM.
 *
 * `scope` is `'transaction'` because `set_config(..., is_local => true)` is
 * cleared by the engine at COMMIT and ROLLBACK. An adapter for an engine without
 * a transaction-scoped variable (MySQL) must report `'session'` here rather than
 * pretend otherwise — the difference decides whether a pooled connection can leak
 * one user's identity into the next borrower's statements.
 */
export class MikroOrmSessionBinder implements SessionBinder {
  readonly scope = 'transaction' as const;

  private readonly bound = new WeakSet<object>();

  constructor(
    private readonly em: EntityManager,
    private readonly sessionVariableName = 'app.current_user_id',
  ) {}

  async bind(userId: string, tx: TransactionRef): Promise<void> {
    if (tx && typeof tx === 'object' && this.bound.has(tx)) {
      return;
    }

    // The statement MUST ride the transaction's own connection: em.execute()
    // resolves its own from the pool, and an is_local setting applied there is
    // discarded at the end of that statement, leaving changed_by NULL.
    await this.em
      .getConnection()
      .execute(
        'SELECT set_config(?, ?, true)',
        [this.sessionVariableName, String(userId)],
        'all',
        tx as any,
      );

    if (tx && typeof tx === 'object') {
      this.bound.add(tx);
    }
  }

  /** Reads back the value visible to `tx`. Used by the conformance suite. */
  async currentValue(tx: TransactionRef): Promise<string | null> {
    const rows = (await this.em
      .getConnection()
      .execute(
        `SELECT current_setting(?, true) AS v`,
        [this.sessionVariableName],
        'all',
        tx as any,
      )) as Array<{ v: string | null }>;
    const value = rows?.[0]?.v ?? null;
    return value === '' ? null : value;
  }
}
