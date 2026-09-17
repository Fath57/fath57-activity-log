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
  defaultLogName?: string;
  defaultCauserType?: string;
  flushMode?: 'sync' | 'outbox';
  generatedIdStrategy?: 'resolve' | 'skip';
  softDeleteField?: string | false;
}
