import { randomUUID } from 'node:crypto';
import { ActivityRecord, ActivityStore } from '../../core';
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
    private readonly store: ActivityStore,
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

  /**
   * Writes one entry and returns it.
   *
   * Through the store port, with no transaction handle — which is the behaviour
   * this already had: the logger handed the builder a fresh fork, so a manual
   * entry never joined the caller's transaction and was never rolled back with
   * it. Wrap the call in your own transaction and pass it down if you need that.
   */
  async log(description: string): Promise<ActivityRecord> {
    const record: ActivityRecord = {
      id: randomUUID(),
      logName: this.logName ?? this.defaultLogName ?? 'default',
      description,
      subjectType: this.subjectType,
      subjectId: this.subjectId,
      causerType:
        this.causerType ??
        this.requestContext.getCauserType() ??
        (this.requestContext.getUserId() ? this.defaultCauserType : undefined),
      causerId: this.causerId ?? this.requestContext.getUserId(),
      event: this.event,
      properties: this.properties,
      tenantId: this.tenantId ?? this.requestContext.getTenantId(),
      createdAt: new Date(),
    };

    await this.store.persist([record], undefined);
    return record;
  }
}
