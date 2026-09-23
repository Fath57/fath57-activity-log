import { DynamicModule, Module } from '@nestjs/common';
import { AuditModuleOptions } from './interfaces/audit-options.interface';
import { EntityManager } from '@mikro-orm/core';
import { ActivityAdapter } from '../core';
import { MikroOrmActivityAdapter } from '../adapters/mikro-orm/mikro-orm.adapter';
import {
  AUDIT_ADAPTER,
  AUDIT_MODULE_OPTIONS,
  AUDIT_READER,
} from './constants/audit.constants';
import { AuditSessionSubscriber } from '../adapters/mikro-orm/audit-session.subscriber';
import { AuditQueryService } from './services/audit-query.service';

@Module({})
export class AuditModule {
  static forRoot(options?: AuditModuleOptions): DynamicModule {
    const resolved = options ?? {};

    return {
      module: AuditModule,
      providers: [
        {
          provide: AUDIT_MODULE_OPTIONS,
          useValue: resolved,
        },
        {
          provide: AUDIT_ADAPTER,
          inject: [EntityManager],
          useFactory: (em: EntityManager): ActivityAdapter =>
            resolved.adapter ?? new MikroOrmActivityAdapter(em),
        },
        {
          provide: AUDIT_READER,
          inject: [AUDIT_ADAPTER],
          useFactory: (adapter: ActivityAdapter) => adapter.auditReader,
        },
        AuditSessionSubscriber,
        AuditQueryService,
      ],
      exports: [AuditSessionSubscriber, AuditQueryService],
    };
  }
}
