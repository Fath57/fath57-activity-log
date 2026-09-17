/**
 * A mutation, described without reference to any ORM.
 *
 * This is the only shape `ChangeCapture` implementations are allowed to hand the
 * core. Anything MikroORM-, TypeORM- or Sequelize-specific stops at the adapter.
 */
export interface EntityChange {
  /** The entity instance, opaque to the core. Passed back to user formatters. */
  entity: unknown;
  /** Stable name used as `ActivityRecord.subjectType`. */
  entityName: string;
  operation: 'create' | 'update' | 'delete';
  /**
   * Stringified identifier, or undefined when the database assigns it and the
   * capture happens before the INSERT. See `ActivityStore.resolveIdentifiers`.
   */
  identifier?: string;
  /** Attribute values before the mutation. Absent when the ORM cannot supply them. */
  before?: Record<string, unknown>;
  /** Attribute values after the mutation; for a delete, the values that were removed. */
  after?: Record<string, unknown>;
  /** Only the attributes the ORM reports as changed. Absent means "unknown". */
  changed?: Record<string, unknown>;
}

/** An opaque handle to the ambient transaction, understood only by its adapter. */
export type TransactionRef = unknown;
