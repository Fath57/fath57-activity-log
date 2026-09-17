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
  /** Kept so the description can be reformatted once the key exists. */
  change: EntityChange;
  event?: string;
  description: string;
  /**
   * Set under `flushMode: 'outbox'`. The entry is then an intent in
   * `activity_outbox`, and that is the row afterFlush has to revisit — there is
   * no feed row yet for it to update.
   */
  outboxId?: string;
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

      const staged: StagedCreation | undefined =
        cs.type === ChangeSetType.CREATE &&
        !change.identifier &&
        generatedIdStrategy === 'resolve'
          ? {
              entity: cs.entity,
              activityLogId: record.id,
              pkName,
              change,
              event: record.event,
              description: record.description,
            }
          : undefined;

      if (flushMode === 'outbox') {
        const outbox = this.toOutbox(record);
        // Record where the intent landed: its id is not the record's, so
        // afterFlush could not find it otherwise.
        if (staged) {
          staged.outboxId = outbox.id;
        }
        args.uow.computeChangeSet(outbox);
      } else {
        args.uow.computeChangeSet(this.toActivityLog(record));
      }

      if (staged) {
        this.stagedCreations.push(staged);
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
      if (!generatedId) {
        continue;
      }

      // The entity now carries the key, so a description that reads it formats
      // correctly this time. Kept only when it differs, which for a
      // deterministic callback means it read the key and had rendered
      // `undefined`; an entry whose text ignores the key is left untouched.
      const redescribed = this.pipeline.redescribe(item.change, item.event ?? 'created');
      const description =
        redescribed !== undefined && redescribed !== item.description
          ? redescribed
          : undefined;

      if (item.outboxId) {
        // Under outbox mode the entry has not reached activity_logs yet, so it is
        // patched where it lives. `||` merges at the top level of the payload,
        // leaving every other field of the record alone, and the drainer goes on
        // to insert the resolved values rather than the ones formatted before the
        // INSERT. Reading the payload back to rewrite it would race every other
        // drainer holding the row.
        const patch: Record<string, unknown> = { subjectId: String(generatedId) };
        if (description !== undefined) {
          patch.description = description;
        }

        await (args.em as any).execute(
          'UPDATE activity_outbox SET payload = payload || ?::jsonb WHERE id = ?',
          [JSON.stringify(patch), item.outboxId],
        );
        continue;
      }

      if (description !== undefined) {
        await (args.em as any).execute(
          'UPDATE activity_logs SET subject_id = ?, description = ? WHERE id = ?',
          [String(generatedId), description, item.activityLogId],
        );
        continue;
      }

      await (args.em as any).execute(
        'UPDATE activity_logs SET subject_id = ? WHERE id = ?',
        [String(generatedId), item.activityLogId],
      );
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
