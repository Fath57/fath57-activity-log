import { randomUUID } from 'node:crypto';

export class ActivityLog {
  id: string = randomUUID();
  logName: string = 'default';
  description!: string;
  subjectType?: string;
  subjectId?: string;
  causerType?: string;
  causerId?: string;
  event?: 'created' | 'updated' | 'deleted' | (string & {});
  properties?: Record<string, any>;
  tenantId?: string;
  createdAt: Date = new Date();
}
