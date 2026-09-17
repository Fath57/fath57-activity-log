import { DynamicModule, Module } from '@nestjs/common';
import { FeedModuleOptions } from './interfaces/activity-options.interface';
import { FEED_MODULE_OPTIONS } from './constants/feed.constants';
import { ActivityLogger } from './services/activity-logger.service';
import { ActivityQueryService } from './services/activity-query.service';
import { ActivityOutboxDrainer } from './services/activity-outbox.drainer';
import { ActivitySubscriber } from './subscribers/activity.subscriber';
import {
  validateFeedOptions,
  warnOnWeakSessionScope,
} from '../core/services/validate-feed-options';

@Module({})
export class FeedModule {
  /**
   * @param options  See FeedModuleOptions. `adapter` binds the core ports to an
   *                 ORM; omit it to use the MikroORM profile.
   *
   * Configuration is validated here rather than discovered at the first flush:
   * an adapter that cannot honour `logOnlyDirty` makes the module throw at
   * bootstrap instead of silently logging every attribute forever (§11.2).
   */
  static forRoot(options?: FeedModuleOptions): DynamicModule {
    const resolved = options ?? {};

    validateFeedOptions(resolved, resolved.adapter);
    warnOnWeakSessionScope(resolved.adapter);

    return {
      module: FeedModule,
      providers: [
        {
          provide: FEED_MODULE_OPTIONS,
          useValue: resolved,
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
