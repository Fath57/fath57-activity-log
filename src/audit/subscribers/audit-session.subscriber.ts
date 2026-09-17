import {
  EventSubscriber,
  FlushEventArgs,
  TransactionEventArgs,
} from '@mikro-orm/core';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { RequestContextService } from '../../common/request-context.service';
import { AuditModuleOptions } from '../interfaces/audit-options.interface';
import { AUDIT_MODULE_OPTIONS } from '../constants/audit.constants';

@Injectable()
export class AuditSessionSubscriber implements EventSubscriber<any> {
  private readonly bound = new WeakSet<object>();

  constructor(
    private readonly requestContext: RequestContextService,
    @Optional()
    @Inject(AUDIT_MODULE_OPTIONS)
    private readonly options?: AuditModuleOptions,
  ) {}

  async afterTransactionStart(args: TransactionEventArgs): Promise<void> {
    const sessionBinding = this.options?.sessionBinding ?? 'eager';
    if (sessionBinding !== 'eager') {
      return;
    }

    await this.bind(args.em, args.transaction);
  }

  /** Surfaced for `afterTransactionEnd`-style cleanup and for tests. */
  isBound(transaction: unknown): boolean {
    return (
      typeof transaction === 'object' &&
      transaction !== null &&
      this.bound.has(transaction)
    );
  }

  async onFlush(args: FlushEventArgs): Promise<void> {
    const sessionBinding = this.options?.sessionBinding ?? 'eager';
    if (sessionBinding === 'lazy' && args.uow.getChangeSets().length > 0) {
      const tx = (args.em as any).getTransactionContext?.() ?? (args.uow as any).transactionContext;
      await this.bind(args.em, tx);
    }
  }

  /**
   * Delegates to the adapter's SessionBinder when one is configured, so the
   * engine-specific part of attribution lives behind the port rather than here.
   * Without an adapter it falls back to the PostgreSQL binding inline, which is
   * what keeps the common case free of ceremony.
   */
  private async bind(em: any, transaction: any): Promise<void> {
    const userId = this.requestContext.getUserId();
    if (!userId) {
      return;
    }

    if (transaction && typeof transaction === 'object' && this.bound.has(transaction)) {
      return;
    }

    const sessionVariableName = this.options?.sessionVariableName ?? 'app.current_user_id';

    try {
      const binder = this.options?.adapter?.binder;
      if (binder) {
        await binder.bind(String(userId), transaction);
      } else {
        // The binding MUST be issued on the transaction's own connection.
        //
        // `em.execute()` resolves a connection from the pool on its own, which is
        // not necessarily the one the transaction holds. `set_config(..., is_local
        // => true)` then applies to a foreign connection's implicit transaction and
        // is discarded at the end of that statement, leaving `changed_by` NULL on
        // every audit row. Passing the transaction context explicitly is what pins
        // it to the right connection.
        // Covered by native-update-asymmetry.integration.spec.ts.
        await em
          .getConnection()
          .execute(
            'SELECT set_config(?, ?, true)',
            [sessionVariableName, String(userId)],
            'all',
            transaction,
          );
      }

      if (transaction && typeof transaction === 'object') {
        this.bound.add(transaction);
      }
    } catch (err) {
      // A failed binding must not abort the business transaction, but it must not
      // pass unnoticed either: the audit trail silently loses its attribution.
      // eslint-disable-next-line no-console
      console.warn(
        `[@fath57/activity-log] could not bind ${sessionVariableName}; ` +
          `audit rows for this transaction will have no changed_by. ` +
          `Cause: ${(err as Error)?.message ?? err}`,
      );
    }
  }
}
