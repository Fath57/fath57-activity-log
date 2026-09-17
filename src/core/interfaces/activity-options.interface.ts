export interface ActivityOptionsConfig {
  logName?: string;
  events?: Array<'created' | 'updated' | 'deleted' | (string & {})>;
  logOnly?: string[];
  logExcept?: string[];
  logOnlyDirty?: boolean;
  dontSubmitEmptyLogs?: boolean;
  softDeleteField?: string | false;
  description?: (event: string, entity: any) => string;
}

export interface FeedModuleOptions {
  /**
   * Binds the core ports to an ORM (§11.1). Optional: when omitted the MikroORM
   * adapter is assembled by default, which is what keeps the common case a
   * one-liner while leaving the seam open.
   */
  adapter?: import('../ports').ActivityAdapter;
  /** Global default for per-entity `logOnlyDirty`. Validated against the adapter. */
  logOnlyDirty?: boolean;
  defaultLogName?: string;
  defaultCauserType?: string;
  flushMode?: 'sync' | 'outbox';
  generatedIdStrategy?: 'resolve' | 'skip';
  softDeleteField?: string | false;
}
