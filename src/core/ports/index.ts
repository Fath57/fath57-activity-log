import { ActivityRecord } from '../model/activity-record';
import { AuditEntry } from '../model/audit-entry';
import { EntityChange, TransactionRef } from '../model/entity-change';

export type { EntityChange, TransactionRef };

/**
 * Observe mutations. The capability that varies most between ORMs.
 *
 * MikroORM and Sequelize expose both the before-state and a per-flush batch;
 * TypeORM reports per entity; Prisma intercepts at the query level with no
 * before-state at all. The two capability flags let the core refuse a
 * configuration the adapter cannot honour, instead of degrading silently.
 */
export interface ChangeCapture {
  onChanges(
    handler: (changes: EntityChange[], tx: TransactionRef) => void | Promise<void>,
  ): void;

  /**
   * True when the ORM supplies `EntityChange.before` without an extra read.
   * Gates `logOnlyDirty`: an adapter reporting false makes exact diffing cost a
   * round-trip per mutation, so the core rejects that combination at bootstrap.
   */
  readonly providesBeforeState: boolean;

  /** True when changes arrive batched per flush rather than one entity at a time. */
  readonly batchesByFlush: boolean;
}

/** Write feed rows inside the ambient transaction. */
export interface ActivityStore {
  persist(records: ActivityRecord[], tx: TransactionRef): Promise<void>;

  /**
   * Moves one batch of queued intents into the feed, returning how many moved.
   *
   * One method rather than take-then-persist: the claim is at-least-once
   * delivery, which requires the removal and the insert to share a transaction.
   * Split across two port calls, the boundary would sit in the caller, where no
   * adapter can enforce it.
   *
   * Optional: only `flushMode: 'outbox'` needs it, and an adapter whose driver
   * cannot express a locking dequeue should say so by not implementing it.
   */
  drainOutbox?(batchSize: number): Promise<number>;

  /**
   * Fill in identifiers assigned during the flush. A no-op for client-assigned
   * keys. See §4.5 for the atomicity boundary this runs against.
   */
  resolveIdentifiers?(records: ActivityRecord[], tx: TransactionRef): Promise<void>;
}

export interface FeedQuerySpec {
  logName?: string;
  subjectType?: string;
  subjectId?: string;
  causerType?: string;
  causerId?: string;
  /** undefined = scope to the ambient tenant; null = deliberately cross-tenant. */
  tenantId?: string | null;
  limit?: number;
  cursor?: string;
}

export interface CursorPage<T> {
  data: T[];
  /** Opaque (createdAt, id) cursor. null when exhausted. */
  nextCursor: string | null;
}

/** Read feed rows. Keyset pagination and tenant scoping live behind this port. */
export interface ActivityReader {
  query(spec: FeedQuerySpec): Promise<CursorPage<ActivityRecord>>;
  count(spec: FeedQuerySpec): Promise<number>;
  prune(olderThan: Date, batchSize: number): Promise<number>;
}

/**
 * Read the audit trail.
 *
 * One `query` over a spec rather than a method per question, so an adapter
 * implements one translation instead of three. The service above keeps the named
 * questions — findForRow, findForTransaction, findForUser — because those are
 * what an application asks; the port keeps the one shape an adapter must map.
 */
export interface AuditQuerySpec {
  schemaName?: string;
  tableName?: string;
  rowId?: string;
  transactionId?: string;
  changedBy?: string;
  from?: Date;
  to?: Date;
  /** Defaults to 'desc': most recent first, which is what a history reads like. */
  order?: 'asc' | 'desc';
}

export interface AuditReader {
  query(spec: AuditQuerySpec): Promise<AuditEntry[]>;
}

/**
 * Carry user attribution down to the engine.
 *
 * `scope` is part of the contract rather than an implementation detail: an
 * adapter that can only offer session scope (MySQL has no transaction-scoped
 * variable) is NOT a drop-in replacement for one offering transaction scope, and
 * the difference must be visible at registration rather than discovered through
 * a cross-tenant attribution leak.
 */
export interface SessionBinder {
  bind(userId: string, tx: TransactionRef): Promise<void>;
  readonly scope: 'transaction' | 'session' | 'none';
}

/** What an adapter supplies. Everything but `capture` and `store` is optional. */
export interface ActivityAdapter {
  readonly name: string;
  readonly capture: ChangeCapture;
  readonly store: ActivityStore;
  readonly reader?: ActivityReader;
  readonly binder?: SessionBinder;
  /** Only AuditModule uses it; an adapter with no audit trail supplies none. */
  readonly auditReader?: AuditReader;
}
