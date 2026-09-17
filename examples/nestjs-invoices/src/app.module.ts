import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { ScheduleModule } from '@nestjs/schedule';
import {
  AuditModule,
  FeedModule,
  RequestContextInterceptor,
  RequestContextModule,
} from '@fath57/activity-log';
import {
  ActivityLogSchema,
  ActivityOutboxSchema,
  LoggedActionSchema,
} from '@fath57/activity-log/mikro-orm';
import { Invoice } from './invoices/invoice.entity';
import { InvoicesController } from './invoices/invoices.controller';
import { AuditMaintenanceService } from './maintenance/audit-partitions.service';
import { ormConfig } from './mikro-orm.config';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    MikroOrmModule.forRoot(ormConfig),
    MikroOrmModule.forFeature([Invoice, ActivityLogSchema, ActivityOutboxSchema, LoggedActionSchema]),

    RequestContextModule.forRoot({
      // A real app reads a verified JWT here. Headers keep the example runnable
      // with curl; never trust a caller-supplied identity in production.
      userExtractor: (req) => ({
        userId: req.headers['x-user-id'],
        tenantId: req.headers['x-tenant-id'],
        causerType: 'User',
      }),
    }),

    FeedModule.forRoot({
      defaultLogName: 'default',
      defaultCauserType: 'User',
      flushMode: 'sync',
      generatedIdStrategy: 'resolve',
    }),

    AuditModule.forRoot({
      sessionVariableName: 'app.current_user_id',
      captureClientQuery: false, // current_query() would contain literal values
      sessionBinding: 'eager',
    }),
  ],
  controllers: [InvoicesController],
  providers: [
    AuditMaintenanceService,
    // An INTERCEPTOR, not a middleware. Nest runs middleware BEFORE guards, so
    // req.user would still be undefined and every entry would be unattributed.
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
  ],
})
export class AppModule {}
