import { DynamicModule, Module } from '@nestjs/common';
import { AuditModuleOptions } from './interfaces/audit-options.interface';
import { AUDIT_MODULE_OPTIONS } from './constants/audit.constants';
import { AuditSessionSubscriber } from './subscribers/audit-session.subscriber';
import { AuditQueryService } from './services/audit-query.service';

@Module({})
export class AuditModule {
  static forRoot(options?: AuditModuleOptions): DynamicModule {
    return {
      module: AuditModule,
      providers: [
        {
          provide: AUDIT_MODULE_OPTIONS,
          useValue: options ?? {},
        },
        AuditSessionSubscriber,
        AuditQueryService,
      ],
      exports: [AuditSessionSubscriber, AuditQueryService],
    };
  }
}
