import { DynamicModule, Module } from '@nestjs/common';
import { FeedModuleOptions } from './interfaces/activity-options.interface';
import { FEED_MODULE_OPTIONS } from './constants/feed.constants';
import { ActivityLogger } from './services/activity-logger.service';
import { ActivityQueryService } from './services/activity-query.service';
import { ActivityOutboxDrainer } from './services/activity-outbox.drainer';
import { ActivitySubscriber } from './subscribers/activity.subscriber';

@Module({})
export class FeedModule {
  static forRoot(options?: FeedModuleOptions): DynamicModule {
    return {
      module: FeedModule,
      providers: [
        {
          provide: FEED_MODULE_OPTIONS,
          useValue: options ?? {},
        },
        ActivityLogger,
        ActivityQueryService,
        ActivityOutboxDrainer,
        ActivitySubscriber,
      ],
      exports: [
        ActivityLogger,
        ActivityQueryService,
        ActivityOutboxDrainer,
        ActivitySubscriber,
      ],
    };
  }
}
