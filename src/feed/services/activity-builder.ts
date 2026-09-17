import { EntityManager } from '@mikro-orm/core';
import { ActivityLog } from '../entities/activity-log.entity';
import { RequestContextService } from '../../common/request-context.service';

export class ActivityBuilder {
  private logName?: string;
  private subject?: any;
  private subjectType?: string;
  private subjectId?: string;
  private causer?: any;
  private causerType?: string;
  private causerId?: string;
  private event?: string;
  private properties?: Record<string, any>;
  private tenantId?: string;

  constructor(
    private readonly em: EntityManager,
    private readonly requestContext: RequestContextService,
    private readonly defaultLogName = 'default',
    private readonly defaultCauserType = 'User',
  ) {}

  performedOn(subject: any, subjectType?: string, subjectId?: string): this {
    this.subject = subject;
    this.subjectType = subjectType ?? subject?.constructor?.name;
    this.subjectId = subjectId ?? subject?.id ?? subject?._id ?? (typeof subject === 'string' || typeof subject === 'number' ? String(subject) : undefined);
    return this;
  }

  causedBy(causer: any, causerType?: string, causerId?: string): this {
    this.causer = causer;
    this.causerType = causerType ?? causer?.constructor?.name ?? this.defaultCauserType;
    this.causerId = causerId ?? causer?.id ?? causer?._id ?? (typeof causer === 'string' || typeof causer === 'number' ? String(causer) : undefined);
    return this;
  }

  withEvent(event: string): this {
    this.event = event;
    return this;
  }

  inLog(logName: string): this {
    this.logName = logName;
    return this;
  }

  withProperties(properties: Record<string, any>): this {
    this.properties = properties;
    return this;
  }

  withTenant(tenantId: string): this {
    this.tenantId = tenantId;
    return this;
  }

  async log(description: string): Promise<ActivityLog> {
    const activityLog = new ActivityLog();
    activityLog.description = description;
    activityLog.logName = this.logName ?? this.defaultLogName;
    activityLog.event = this.event;
    activityLog.properties = this.properties;
    activityLog.tenantId = this.tenantId ?? this.requestContext.getTenantId();

    activityLog.subjectType = this.subjectType;
    activityLog.subjectId = this.subjectId;

    activityLog.causerType = this.causerType ?? this.requestContext.getCauserType() ?? (this.requestContext.getUserId() ? this.defaultCauserType : undefined);
    activityLog.causerId = this.causerId ?? this.requestContext.getUserId();

    // persist + flush rather than persistAndFlush: MikroORM 7 dropped the
    // combined method, and these two are the pair it kept in both majors.
    this.em.persist(activityLog);
    await this.em.flush();
    return activityLog;
  }
}
