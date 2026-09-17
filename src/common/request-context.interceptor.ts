import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { RequestContextService } from './request-context.service';
import {
  RequestContextModuleOptions,
  RequestContextStore,
} from './request-context.interface';

export const REQUEST_CONTEXT_MODULE_OPTIONS = 'REQUEST_CONTEXT_MODULE_OPTIONS';

@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  constructor(
    private readonly requestContext: RequestContextService,
    @Optional()
    @Inject(REQUEST_CONTEXT_MODULE_OPTIONS)
    private readonly options?: RequestContextModuleOptions,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() === 'http') {
      const req = context.switchToHttp().getRequest();
      const extractedCustom = this.options?.userExtractor?.(req) ?? {};

      const store: RequestContextStore = {
        userId:
          extractedCustom.userId ??
          req.user?.id ??
          req.user?.sub ??
          req.user?.userId,
        userEmail: extractedCustom.userEmail ?? req.user?.email,
        tenantId:
          extractedCustom.tenantId ??
          req.user?.tenantId ??
          req.headers?.['x-tenant-id'],
        requestId:
          extractedCustom.requestId ??
          req.headers?.['x-request-id'] ??
          req.id,
        causerType: extractedCustom.causerType ?? 'User',
      };

      return new Observable((subscriber) => {
        this.requestContext.runWith(store, () => {
          next.handle().subscribe(subscriber);
        });
      });
    }

    return next.handle();
  }
}
