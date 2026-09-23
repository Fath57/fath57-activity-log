import { Inject, Injectable, Optional } from '@nestjs/common';
import { RequestContextService } from '../../common/request-context.service';
import { FeedModuleOptions } from '../interfaces/activity-options.interface';
import { ACTIVITY_STORE, FEED_MODULE_OPTIONS } from '../constants/feed.constants';
import { ActivityRecord, ActivityStore } from '../../core';
import { ActivityBuilder } from './activity-builder';

@Injectable()
export class ActivityLogger {
  constructor(
    @Inject(ACTIVITY_STORE) private readonly store: ActivityStore,
    private readonly requestContext: RequestContextService,
    @Optional()
    @Inject(FEED_MODULE_OPTIONS)
    private readonly options?: FeedModuleOptions,
  ) {}

  builder(): ActivityBuilder {
    return new ActivityBuilder(
      this.store,
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

  async log(description: string): Promise<ActivityRecord> {
    return this.builder().log(description);
  }

  async withoutLogs<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.requestContext.runWithDisabledFeed(fn);
  }
}
