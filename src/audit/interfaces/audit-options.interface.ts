export interface AuditModuleOptions {
  /** Binds attribution to the engine through the SessionBinder port (§11.1). */
  adapter?: import('../../core/ports').ActivityAdapter;
  sessionVariableName?: string;
  captureClientQuery?: boolean;
  sessionBinding?: 'eager' | 'lazy';
}
