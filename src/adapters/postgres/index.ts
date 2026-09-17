/**
 * PostgreSQL adapter — the engine binding ring (§9, §11.3).
 *
 * The audit trail is deliberately NOT abstracted: its value is the trigger +
 * SECURITY DEFINER + SET LOCAL triplet, and an interface that made it portable
 * would guarantee less while claiming the same. A second engine ships its own
 * schema, its own erasure routine, its own migrations and its own threat-model
 * table — it does not implement this one.
 */
export {
  getAuditSchemaStatements,
  getFeedSchemaStatements,
  getDropAuditSchemaStatements,
  getDropFeedSchemaStatements,
  getHardeningScript,
  getTrackTableSql,
} from '../../migrations/migration-helpers';

export {
  createMonthlyPartitionSql,
  getInitialPartitionStatements,
} from '../../migrations/partition-manager';

export { anonymizeSubject } from '../../migrations/anonymize';
export type { AnonymizeSubjectOptions, SqlExecutor } from '../../migrations/anonymize';
