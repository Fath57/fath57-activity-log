import { DynamicModule, Global, Module } from '@nestjs/common';
import {
  RequestContextModuleOptions,
} from './request-context.interface';
import { RequestContextService } from './request-context.service';
import {
  RequestContextInterceptor,
  REQUEST_CONTEXT_MODULE_OPTIONS,
} from './request-context.interceptor';

@Global()
@Module({
  providers: [RequestContextService, RequestContextInterceptor],
  exports: [RequestContextService, RequestContextInterceptor],
})
export class RequestContextModule {
  static forRoot(options?: RequestContextModuleOptions): DynamicModule {
    return {
      module: RequestContextModule,
      providers: [
        {
          provide: REQUEST_CONTEXT_MODULE_OPTIONS,
          useValue: options ?? {},
        },
        RequestContextService,
        RequestContextInterceptor,
      ],
      exports: [RequestContextService, RequestContextInterceptor],
    };
  }
}
