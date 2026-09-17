import {
  ChangeSetType,
  EventSubscriber,
  FlushEventArgs,
} from '@mikro-orm/core';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RequestContextService } from '../../common/request-context.service';
import { FEED_MODULE_OPTIONS } from '../constants/feed.constants';
import { ActivityLog } from '../entities/activity-log.entity';
import { ActivityOutbox } from '../entities/activity-outbox.entity';
import {
  ActivityOptionsConfig,
  FeedModuleOptions,
} from '../interfaces/activity-options.interface';
import { LogsActivityInterface } from '../interfaces/logs-activity.interface';
import { ActivityMetadataStorage } from '../metadata/activity-metadata-storage';

interface StagedCreation {
  entity: any;
  activityLogId: string;
  pkName: string;
}

@Injectable()
export class ActivitySubscriber implements EventSubscriber<any> {
  private stagedCreations: StagedCreation[] = [];

  constructor(
    private readonly requestContext: RequestContextService,
    @Optional()
    @Inject(FEED_MODULE_OPTIONS)
    private readonly options?: FeedModuleOptions,
  ) {}

  async onFlush(args: FlushEventArgs): Promise<void> {
    if (this.requestContext.isFeedDisabled()) {
      return;
    }

    const changeSets = args.uow.getChangeSets();
    const defaultLogName = this.options?.defaultLogName ?? 'default';
    const defaultCauserType = this.options?.defaultCauserType ?? 'User';
    const defaultSoftDeleteField = this.options?.softDeleteField ?? 'deletedAt';
    const generatedIdStrategy = this.options?.generatedIdStrategy ?? 'resolve';
    const flushMode = this.options?.flushMode ?? 'sync';

    for (const cs of changeSets) {
      const decoratorOpts = ActivityMetadataStorage.get(cs.entity.constructor);
      if (!decoratorOpts) {
        continue;
      }

      let dynamicOpts: Partial<ActivityOptionsConfig> | undefined;
      if (typeof (cs.entity as LogsActivityInterface).getActivitylogOptions === 'function') {
        dynamicOpts = (cs.entity as LogsActivityInterface).getActivitylogOptions();
      }

      const logName = dynamicOpts?.logName ?? decoratorOpts.logName ?? defaultLogName;
      const trackedEvents = dynamicOpts?.events ?? decoratorOpts.events ?? ['created', 'updated', 'deleted'];
      const logOnly = dynamicOpts?.logOnly ?? decoratorOpts.logOnly;
      const logExcept = dynamicOpts?.logExcept ?? decoratorOpts.logExcept;
      const logOnlyDirty = dynamicOpts?.logOnlyDirty ?? decoratorOpts.logOnlyDirty ?? true;
      const dontSubmitEmptyLogs = dynamicOpts?.dontSubmitEmptyLogs ?? decoratorOpts.dontSubmitEmptyLogs ?? true;
      const softDeleteField = dynamicOpts?.softDeleteField ?? decoratorOpts.softDeleteField ?? defaultSoftDeleteField;
      const descriptionFormatter = dynamicOpts?.description ?? decoratorOpts.description;

      let event: 'created' | 'updated' | 'deleted' = 'updated';
      if (cs.type === ChangeSetType.CREATE) {
        event = 'created';
      } else if (cs.type === ChangeSetType.DELETE) {
        event = 'deleted';
      } else if (cs.type === ChangeSetType.UPDATE) {
        if (softDeleteField && softDeleteField in cs.payload) {
          const oldVal = cs.originalEntity ? (cs.originalEntity as any)[softDeleteField] : undefined;
          const newVal = cs.payload[softDeleteField];
          if (!oldVal && newVal) {
            event = 'deleted';
          } else {
            event = 'updated';
          }
        } else {
          event = 'updated';
        }
      }

      if (!trackedEvents.includes(event)) {
        continue;
      }

      let payloadToLog: Record<string, any> = {};
      if (cs.type === ChangeSetType.CREATE) {
        payloadToLog = { ...cs.payload };
      } else if (cs.type === ChangeSetType.UPDATE) {
        payloadToLog = { ...cs.payload };
      } else if (cs.type === ChangeSetType.DELETE) {
        payloadToLog = cs.originalEntity ? { ...(cs.originalEntity as any) } : {};
      }

      if (logOnly && logOnly.length > 0) {
        const filtered: Record<string, any> = {};
        for (const key of logOnly) {
          if (key in payloadToLog) {
            filtered[key] = payloadToLog[key];
          }
        }
        payloadToLog = filtered;
      } else if (logExcept && logExcept.length > 0) {
        for (const key of logExcept) {
          delete payloadToLog[key];
        }
      }

      if (logOnlyDirty && cs.type === ChangeSetType.UPDATE && dontSubmitEmptyLogs) {
        if (Object.keys(payloadToLog).length === 0) {
          continue;
        }
      }

      const description = descriptionFormatter
        ? descriptionFormatter(event, cs.entity)
        : `${cs.entity.constructor.name} ${event}`;

      const pkName = cs.meta?.primaryKeys?.[0] ?? 'id';
      let subjectId = cs.entity[pkName] ?? (cs.entity as any).id ?? (cs.entity as any)._id;

      const activityLog = new ActivityLog();
      activityLog.id = randomUUID();
      activityLog.logName = logName;
      activityLog.description = description;
      activityLog.subjectType = cs.entity.constructor.name;
      activityLog.subjectId = subjectId ? String(subjectId) : undefined;
      activityLog.causerType = this.requestContext.getUserId() ? (this.requestContext.getCauserType() ?? defaultCauserType) : undefined;
      activityLog.causerId = this.requestContext.getUserId();
      activityLog.event = event;
      activityLog.properties = Object.keys(payloadToLog).length > 0 ? payloadToLog : undefined;
      activityLog.tenantId = this.requestContext.getTenantId();
      activityLog.createdAt = new Date();

      if (cs.type === ChangeSetType.CREATE && !subjectId && generatedIdStrategy === 'resolve') {
        this.stagedCreations.push({
          entity: cs.entity,
          activityLogId: activityLog.id,
          pkName,
        });
      }

      if (flushMode === 'outbox') {
        const outbox = new ActivityOutbox();
        outbox.id = randomUUID();
        outbox.payload = { ...activityLog };
        outbox.createdAt = new Date();
        args.uow.computeChangeSet(outbox);
      } else {
        args.uow.computeChangeSet(activityLog);
      }
    }
  }

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
}
