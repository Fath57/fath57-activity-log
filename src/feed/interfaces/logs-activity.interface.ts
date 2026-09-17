import { ActivityOptionsConfig } from './activity-options.interface';

export interface LogsActivityInterface {
  /** MUST return a partial. `LogOptions.toPartial()` produces one. */
  getActivitylogOptions(): Partial<ActivityOptionsConfig>;
}
