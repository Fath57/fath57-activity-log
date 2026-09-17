import { ActivityRecord } from '../model/activity-record';
import { EntityChange, TransactionRef } from '../model/entity-change';

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

/** What an adapter supplies. `reader` and `binder` are optional capabilities. */
export interface ActivityAdapter {
  readonly name: string;
  readonly capture: ChangeCapture;
  readonly store: ActivityStore;
  readonly reader?: ActivityReader;
  readonly binder?: SessionBinder;
}
