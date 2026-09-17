import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { RequestContextService } from '../../common/request-context.service';
import { ActivityReader, CursorPage, FeedQuerySpec } from '../../core/ports';
import { ActivityLog } from '../entities/activity-log.entity';
import { MikroOrmActivityReader } from '../../adapters/mikro-orm/mikro-orm-activity-reader';

export type { CursorPage };

export interface FeedQueryOptions {
  /** Defaults to RequestContext.tenantId. Pass `null` to query across tenants (admin only). */
  tenantId?: string | null;
  limit?: number;
  cursor?: string;
}

/**
 * The Nest-facing read API for the feed.
 *
 * Deliberately thin: every query actually runs through the `ActivityReader` port,
 * and this class adds exactly one thing on top — resolving the ambient tenant
 * from the request context. Keeping the pagination and pruning logic here as well
 * would mean maintaining two copies that drift, and would leave the port without
 * a real caller.
 *
 * Tenant resolution lives here rather than in the port on purpose: the port takes
 * a tenant explicitly so it stays testable without a request context, and so that
 * `null` reads as a deliberate cross-tenant query rather than an absent one.
 */
@Injectable()
export class ActivityQueryService {
  private readonly reader: ActivityReader;

  constructor(
    em: EntityManager,
    private readonly requestContext: RequestContextService,
    reader?: ActivityReader,
  ) {
    this.reader = reader ?? new MikroOrmActivityReader(em);
  }

  async findForSubject(
    subjectType: string,
    subjectId: string,
    opts?: FeedQueryOptions,
  ): Promise<CursorPage<ActivityLog>> {
    return this.read({ subjectType, subjectId }, opts);
  }

  async findForCauser(
    causerType: string,
    causerId: string,
    opts?: FeedQueryOptions,
  ): Promise<CursorPage<ActivityLog>> {
    return this.read({ causerType, causerId }, opts);
  }

  async findFeed(logName = 'default', opts?: FeedQueryOptions): Promise<CursorPage<ActivityLog>> {
    return this.read({ logName }, opts);
  }

  async countForSubject(
    subjectType: string,
    subjectId: string,
    opts?: FeedQueryOptions,
  ): Promise<number> {
    return this.reader.count(this.toSpec({ subjectType, subjectId }, opts));
  }

  async countForCauser(
    causerType: string,
    causerId: string,
    opts?: FeedQueryOptions,
  ): Promise<number> {
    return this.reader.count(this.toSpec({ causerType, causerId }, opts));
  }

  /**
   * Retention. Deletes in bounded batches, backed by idx_activity_logs_created.
   * Not tenant-scoped: this is a storage policy, not a query.
   */
  async prune(olderThan: Date, opts?: { batchSize?: number }): Promise<number> {
    return this.reader.prune(olderThan, opts?.batchSize ?? 10_000);
  }

  private async read(
    base: Partial<FeedQuerySpec>,
    opts?: FeedQueryOptions,
  ): Promise<CursorPage<ActivityLog>> {
    const page = await this.reader.query(this.toSpec(base, opts));
    return page as unknown as CursorPage<ActivityLog>;
  }

  private toSpec(base: Partial<FeedQuerySpec>, opts?: FeedQueryOptions): FeedQuerySpec {
    return {
      ...base,
      tenantId: this.resolveTenant(opts),
      limit: opts?.limit,
      cursor: opts?.cursor,
    };
  }

  /**
   * `undefined` in the options means "use the ambient tenant"; an explicit `null`
   * means "cross every tenant". The port receives `null` for both the deliberate
   * cross-tenant case and the case where no tenant is in scope at all.
   */
  private resolveTenant(opts?: FeedQueryOptions): string | null {
    if (opts && opts.tenantId !== undefined) {
      return opts.tenantId;
    }
    return this.requestContext.getTenantId() ?? null;
  }
}
