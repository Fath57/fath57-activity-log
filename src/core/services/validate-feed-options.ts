import { ActivityAdapter } from '../ports';
import { FeedModuleOptions } from '../interfaces/activity-options.interface';

/**
 * Rejects, at bootstrap, a configuration the adapter cannot honour.
 *
 * The alternative is silent degradation, and for this package that is the worse
 * failure: `logOnlyDirty` on an adapter with no cheap before-state does not stop
 * working, it starts either logging every attribute on every update or paying a
 * read-before-write per mutation. Either way the feed keeps producing rows and
 * nobody notices until the storage bill or a leaked attribute says otherwise.
 *
 * Refusing loudly costs one exception at startup. See §11.2.
 */
export function validateFeedOptions(
  options: FeedModuleOptions,
  adapter?: ActivityAdapter,
): void {
  if (!adapter) {
    return;
  }

  if (options.logOnlyDirty === true && !adapter.capture.providesBeforeState) {
    throw new Error(
      `[fath-activity-log] FeedModule was configured with logOnlyDirty: true, but the ` +
        `"${adapter.name}" adapter reports providesBeforeState: false — it cannot supply ` +
        `the pre-mutation state without an extra read per mutation. Either set ` +
        `logOnlyDirty: false, or use an adapter whose ORM exposes a unit of work.`,
    );
  }

  if (options.flushMode === 'outbox' && !adapter.store) {
    throw new Error(
      `[fath-activity-log] flushMode: 'outbox' requires an adapter supplying an ` +
        `ActivityStore; "${adapter.name}" supplies none.`,
    );
  }
}

/**
 * Warns when an adapter's attribution guarantee is weaker than the audit module
 * assumes. A binder reporting `'session'` scope leaves the setting on the
 * connection after COMMIT, so a pooled connection carries one user's identity
 * into the next borrower's statements — a cross-tenant attribution leak that is
 * invisible in every single-connection test.
 */
export function warnOnWeakSessionScope(adapter?: ActivityAdapter): void {
  const scope = adapter?.binder?.scope;
  if (scope === 'session') {
    // eslint-disable-next-line no-console
    console.warn(
      `[fath-activity-log] the "${adapter!.name}" adapter binds user attribution at ` +
        `SESSION scope, not TRANSACTION scope. On a pooled connection the value ` +
        `persists past COMMIT and can be attributed to the next borrower's writes. ` +
        `Reset it explicitly at the end of every transaction, or do not pool.`,
    );
  }
}
