import { DynamicModule, Module } from '@nestjs/common';
import { FeedModuleOptions } from '../core/interfaces/activity-options.interface';
import { EntityManager } from '@mikro-orm/core';
import { ActivityAdapter } from '../core';
import { MikroOrmActivityAdapter } from '../adapters/mikro-orm/mikro-orm.adapter';
import {
  ACTIVITY_ADAPTER,
  ACTIVITY_READER,
  ACTIVITY_STORE,
  FEED_MODULE_OPTIONS,
} from './constants/feed.constants';
import { ActivityLogger } from './services/activity-logger.service';
import { ActivityQueryService } from './services/activity-query.service';
import { ActivityOutboxDrainer } from './services/activity-outbox.drainer';
import { ActivitySubscriber } from '../adapters/mikro-orm/activity.subscriber';
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
        {
          // The MikroORM profile is assembled here when no adapter is configured,
          // so that stays the one-liner it was — but it is assembled ONCE, and
          // every service below sees ports rather than an EntityManager.
          provide: ACTIVITY_ADAPTER,
          inject: [EntityManager],
          useFactory: (em: EntityManager): ActivityAdapter =>
            resolved.adapter ?? new MikroOrmActivityAdapter(em),
        },
        {
          provide: ACTIVITY_READER,
          inject: [ACTIVITY_ADAPTER],
          useFactory: (adapter: ActivityAdapter) => adapter.reader,
        },
        {
          provide: ACTIVITY_STORE,
          inject: [ACTIVITY_ADAPTER],
          useFactory: (adapter: ActivityAdapter) => adapter.store,
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
