import { ActivityOptionsConfig } from '../interfaces/activity-options.interface';
import { ActivityMetadataStorage } from './activity-metadata-storage';

/**
 * Canonical registration. `@LogsActivity()` is sugar over this call.
 *
 * Kept as the primitive on purpose: a class decorator presupposes class-based
 * entities, which MikroORM, TypeORM and Sequelize have but Prisma and Drizzle do
 * not. Any adapter for a schema-first ORM registers through this function with a
 * string key. Making the decorator primary would close that door permanently,
 * and reopening it after v1 would break every consumer. See §11.2.
 */
export function registerActivity(
  target: Function | string,
  options: ActivityOptionsConfig = {},
): void {
  ActivityMetadataStorage.set(target as Function, options);
}

/** Look up the effective options for an entity class or registered name. */
export function getActivityOptions(
  target: Function | string,
): ActivityOptionsConfig | undefined {
  return ActivityMetadataStorage.get(target as Function);
}
