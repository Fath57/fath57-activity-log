export interface AuditModuleOptions {
  sessionVariableName?: string;
  captureClientQuery?: boolean;
  sessionBinding?: 'eager' | 'lazy';
}
