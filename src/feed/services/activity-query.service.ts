import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { ActivityLog } from '../entities/activity-log.entity';
import { RequestContextService } from '../../common/request-context.service';
import { CursorPage } from '../../core/ports';

export type { CursorPage };

export interface FeedQueryOptions {
  /** Defaults to RequestContext.tenantId. Pass `null` to query across tenants (admin only). */
  tenantId?: string | null;
  limit?: number;
  cursor?: string;
}

interface CursorPayload {
  createdAt: string;
  id: string;
}

@Injectable()
export class ActivityQueryService {
  constructor(
    private readonly em: EntityManager,
    private readonly requestContext: RequestContextService,
  ) {}

  async findForSubject(
    subjectType: string,
    subjectId: string,
    opts?: FeedQueryOptions,
  ): Promise<CursorPage<ActivityLog>> {
    const baseWhere: Record<string, any> = {
      subjectType,
      subjectId,
    };
    return this.paginate(baseWhere, opts);
  }

  async findForCauser(
    causerType: string,
    causerId: string,
    opts?: FeedQueryOptions,
  ): Promise<CursorPage<ActivityLog>> {
    const baseWhere: Record<string, any> = {
      causerType,
      causerId,
    };
    return this.paginate(baseWhere, opts);
  }

  async findFeed(
    logName = 'default',
    opts?: FeedQueryOptions,
  ): Promise<CursorPage<ActivityLog>> {
    const baseWhere: Record<string, any> = {
      logName,
    };
    return this.paginate(baseWhere, opts);
  }

  async countForSubject(
    subjectType: string,
    subjectId: string,
    opts?: FeedQueryOptions,
  ): Promise<number> {
    const where: Record<string, any> = {
      subjectType,
      subjectId,
      ...this.resolveTenantFilter(opts),
    };
    return this.em.count(ActivityLog, where as any);
  }

  async prune(
    olderThan: Date,
    opts?: { batchSize?: number },
  ): Promise<number> {
    let totalDeleted = 0;
    const batchSize = opts?.batchSize ?? 10000;

    while (true) {
      const rows = await this.em.find(
        ActivityLog,
        { createdAt: { $lt: olderThan } },
        { limit: batchSize, fields: ['id'] },
      );

      if (rows.length === 0) {
        break;
      }

      const ids = rows.map((r) => r.id);
      const deleted = await this.em.nativeDelete(ActivityLog, { id: { $in: ids } });
      totalDeleted += deleted;

      if (rows.length < batchSize) {
        break;
      }
    }

    return totalDeleted;
  }

  private resolveTenantFilter(opts?: FeedQueryOptions): Record<string, any> {
    if (opts && opts.tenantId !== undefined) {
      if (opts.tenantId === null) {
        return {};
      }
      return { tenantId: opts.tenantId };
    }

    const currentTenant = this.requestContext.getTenantId();
    if (currentTenant) {
      return { tenantId: currentTenant };
    }

    return {};
  }

  private async paginate(
    baseWhere: Record<string, any>,
    opts?: FeedQueryOptions,
  ): Promise<CursorPage<ActivityLog>> {
    const limit = opts?.limit ?? 25;
    const where: Record<string, any> = {
      ...baseWhere,
      ...this.resolveTenantFilter(opts),
    };

    if (opts?.cursor) {
      const decoded = this.decodeCursor(opts.cursor);
      if (decoded) {
        const cursorDate = new Date(decoded.createdAt);
        where.$or = [
          { createdAt: { $lt: cursorDate } },
          { createdAt: cursorDate, id: { $lt: decoded.id } },
        ];
      }
    }

    const items = await this.em.find(ActivityLog, where as any, {
      limit: limit + 1,
      orderBy: { createdAt: 'DESC', id: 'DESC' },
    });

    let nextCursor: string | null = null;
    if (items.length > limit) {
      items.pop();
      const lastItem = items[items.length - 1];
      if (lastItem) {
        nextCursor = this.encodeCursor({
          createdAt: lastItem.createdAt.toISOString(),
          id: lastItem.id,
        });
      }
    }

    return {
      data: items,
      nextCursor,
    };
  }

  private encodeCursor(payload: CursorPayload): string {
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  private decodeCursor(cursor: string): CursorPayload | null {
    try {
      const json = Buffer.from(cursor, 'base64url').toString('utf8');
      return JSON.parse(json) as CursorPayload;
    } catch {
      return null;
    }
  }
}
