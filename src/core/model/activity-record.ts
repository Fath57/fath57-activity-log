/**
 * A feed entry, as the core produces it: plain data, no decorators.
 *
 * Adapters map this onto whatever persistence shape they use — a MikroORM entity,
 * a TypeORM entity, a plain INSERT. The core never sees that mapping.
 */
export interface ActivityRecord {
  id: string;
  logName: string;
  description: string;
  subjectType?: string;
  subjectId?: string;
  causerType?: string;
  causerId?: string;
  event?: string;
  properties?: Record<string, unknown>;
  tenantId?: string;
  createdAt: Date;
}
