import { Inject, Injectable, Optional } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { RequestContextService } from '../../common/request-context.service';
import { FeedModuleOptions } from '../interfaces/activity-options.interface';
import { FEED_MODULE_OPTIONS } from '../constants/feed.constants';
import { ActivityBuilder } from './activity-builder';
import { ActivityLog } from '../entities/activity-log.entity';

@Injectable()
export class ActivityLogger {
  constructor(
    private readonly em: EntityManager,
    private readonly requestContext: RequestContextService,
    @Optional()
    @Inject(FEED_MODULE_OPTIONS)
    private readonly options?: FeedModuleOptions,
  ) {}

  builder(): ActivityBuilder {
    return new ActivityBuilder(
      this.em.fork ? this.em.fork() : this.em,
      this.requestContext,
      this.options?.defaultLogName,
      this.options?.defaultCauserType,
    );
  }

  performedOn(subject: any, subjectType?: string, subjectId?: string): ActivityBuilder {
    return this.builder().performedOn(subject, subjectType, subjectId);
  }

  causedBy(causer: any, causerType?: string, causerId?: string): ActivityBuilder {
    return this.builder().causedBy(causer, causerType, causerId);
  }

  async log(description: string): Promise<ActivityLog> {
    return this.builder().log(description);
  }

  async withoutLogs<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.requestContext.runWithDisabledFeed(fn);
  }
}
