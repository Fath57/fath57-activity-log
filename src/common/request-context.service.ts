import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { RequestContextStore } from './request-context.interface';

@Injectable()
export class RequestContextService {
  private readonly asyncLocalStorage = new AsyncLocalStorage<RequestContextStore>();

  run<T>(store: RequestContextStore, fn: () => T): T {
    return this.asyncLocalStorage.run(store, fn);
  }

  runWith<T>(partialStore: Partial<RequestContextStore>, fn: () => T): T {
    const existing = this.getStore() ?? {};
    const merged: RequestContextStore = {
      ...existing,
      ...partialStore,
    };
    return this.asyncLocalStorage.run(merged, fn);
  }

  runWithDisabledFeed<T>(fn: () => T): T {
    return this.runWith({ isFeedDisabled: true }, fn);
  }

  getStore(): RequestContextStore | undefined {
    return this.asyncLocalStorage.getStore();
  }

  getUserId(): string | undefined {
    return this.getStore()?.userId;
  }

  getUserEmail(): string | undefined {
    return this.getStore()?.userEmail;
  }

  getTenantId(): string | undefined {
    return this.getStore()?.tenantId;
  }

  getCauserType(): string | undefined {
    return this.getStore()?.causerType;
  }

  isFeedDisabled(): boolean {
    return this.getStore()?.isFeedDisabled === true;
  }
}
