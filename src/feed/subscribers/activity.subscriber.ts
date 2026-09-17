import {
  ChangeSetType,
  EventSubscriber,
  FlushEventArgs,
} from '@mikro-orm/core';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RequestContextService } from '../../common/request-context.service';
import { ActivityPipeline } from '../../core/services/activity-pipeline';
import { EntityChange } from '../../core/model/entity-change';
import { ChangeCapture } from '../../core/ports';
import { MikroOrmChangeCapture } from '../../adapters/mikro-orm/mikro-orm-change-capture';
import { ActivityRecord } from '../../core/model/activity-record';
import { FEED_MODULE_OPTIONS } from '../constants/feed.constants';
import { ActivityLog } from '../entities/activity-log.entity';
import { ActivityOutbox } from '../entities/activity-outbox.entity';
import { FeedModuleOptions } from '../interfaces/activity-options.interface';

interface StagedCreation {
  entity: any;
  activityLogId: string;
  pkName: string;
}

/**
 * MikroORM binding for the feed.
 *
 * Its whole job is translation: MikroORM change sets in, neutral `EntityChange`
 * out, `ActivityRecord` back, MikroORM entities persisted. Every decision —
 * precedence, filtering, soft-delete, suppression, description — lives in
 * `ActivityPipeline`, which no ORM type reaches. That split is what makes a
 * second adapter a matter of writing this file again, and nothing else (§11.1).
 */
@Injectable()
export class ActivitySubscriber implements EventSubscriber<any> {
  private stagedCreations: StagedCreation[] = [];
  private readonly pipeline: ActivityPipeline;
  /**
   * Translation is delegated to the ChangeCapture port, so the adapter -- not
   * this file -- owns the mapping from an ORM's change sets to EntityChange.
   * Defaults to the MikroORM capture when no adapter is configured.
   */
  private readonly capture: ChangeCapture & { toEntityChange(cs: any): EntityChange };

  constructor(
    private readonly requestContext: RequestContextService,
    @Optional()
    @Inject(FEED_MODULE_OPTIONS)
    private readonly options?: FeedModuleOptions,
  ) {
    this.pipeline = new ActivityPipeline(options ?? {});
    this.capture =
      (options?.adapter?.capture as any) ?? new MikroOrmChangeCapture();
  }

  async onFlush(args: FlushEventArgs): Promise<void> {
    if (this.requestContext.isFeedDisabled()) {
      return;
    }

    const generatedIdStrategy = this.options?.generatedIdStrategy ?? 'resolve';
    const flushMode = this.options?.flushMode ?? 'sync';
    const causer = {
      userId: this.requestContext.getUserId(),
      causerType: this.requestContext.getCauserType(),
      tenantId: this.requestContext.getTenantId(),
    };

    for (const cs of args.uow.getChangeSets()) {
      const pkName = cs.meta?.primaryKeys?.[0] ?? 'id';
      const change = this.capture.toEntityChange(cs);
      if (!this.pipeline.isTracked(change)) {
        continue;
      }

      const record = this.pipeline.build(change, causer);
      if (!record) {
        continue;
      }

      if (cs.type === ChangeSetType.CREATE && !change.identifier && generatedIdStrategy === 'resolve') {
        this.stagedCreations.push({
          entity: cs.entity,
          activityLogId: record.id,
          pkName,
        });
      }

      if (flushMode === 'outbox') {
        args.uow.computeChangeSet(this.toOutbox(record));
      } else {
        args.uow.computeChangeSet(this.toActivityLog(record));
      }
    }
  }

  /**
   * Resolves database-generated identifiers.
   *
   * MikroORM emits `afterFlush` after the flush has committed, so with an
   * implicit flush this UPDATE runs in its own transaction. Inside
   * `em.transactional()` the outer transaction is still open and the unit stays
   * atomic. Both branches are asserted by auto-generated-pk.integration.spec.ts.
   */
  async afterFlush(args: FlushEventArgs): Promise<void> {
    if (this.stagedCreations.length === 0) {
      return;
    }

    const pending = [...this.stagedCreations];
    this.stagedCreations = [];

    for (const item of pending) {
      const generatedId = item.entity[item.pkName] ?? item.entity.id;
      if (generatedId) {
        await (args.em as any).execute(
          'UPDATE activity_logs SET subject_id = ? WHERE id = ?',
          [String(generatedId), item.activityLogId],
        );
      }
    }
  }

  private toActivityLog(record: ActivityRecord): ActivityLog {
    const log = new ActivityLog();
    log.id = record.id;
    log.logName = record.logName;
    log.description = record.description;
    log.subjectType = record.subjectType;
    log.subjectId = record.subjectId;
    log.causerType = record.causerType;
    log.causerId = record.causerId;
    log.event = record.event;
    log.properties = record.properties as Record<string, any> | undefined;
    log.tenantId = record.tenantId;
    log.createdAt = record.createdAt;
    return log;
  }

  private toOutbox(record: ActivityRecord): ActivityOutbox {
    const outbox = new ActivityOutbox();
    outbox.id = randomUUID();
    outbox.payload = { ...record };
    outbox.createdAt = new Date();
    return outbox;
  }
}
