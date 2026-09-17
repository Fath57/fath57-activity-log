import { randomUUID } from 'node:crypto';
import { ActivityRecord } from '../model/activity-record';
import { EntityChange } from '../model/entity-change';
import {
  ActivityOptionsConfig,
  FeedModuleOptions,
} from '../interfaces/activity-options.interface';
import { LogsActivityInterface } from '../interfaces/logs-activity.interface';
import { ActivityMetadataStorage } from '../metadata/activity-metadata-storage';

export interface CauserContext {
  userId?: string;
  causerType?: string;
  tenantId?: string;
}

/**
 * Turns a neutral `EntityChange` into an `ActivityRecord`, or into nothing.
 *
 * This is the whole business logic of the feed: precedence resolution, attribute
 * filtering, soft-delete classification, empty-log suppression, description
 * formatting. It knows about no ORM, which is what makes a second adapter a
 * matter of producing `EntityChange` values rather than reimplementing any of
 * this. See §11.1.
 */
export class ActivityPipeline {
  constructor(private readonly moduleOptions: FeedModuleOptions = {}) {}

  /** Registered entities only; everything else is discarded before any work. */
  isTracked(change: EntityChange): boolean {
    return this.resolveTarget(change) !== undefined;
  }

  build(change: EntityChange, causer: CauserContext): ActivityRecord | null {
    const decoratorOpts = this.resolveTarget(change);
    if (!decoratorOpts) {
      return null;
    }

    const dynamicOpts = this.dynamicOptions(change.entity);
    const o = this.merge(decoratorOpts, dynamicOpts);

    const event = this.classify(change, o.softDeleteField);
    if (!o.events.includes(event)) {
      return null;
    }

    const properties = this.filterAttributes(change, event, o);
    if (
      event === 'updated' &&
      o.logOnlyDirty &&
      o.dontSubmitEmptyLogs &&
      Object.keys(properties).length === 0
    ) {
      return null;
    }

    return {
      id: randomUUID(),
      logName: o.logName,
      description: o.description
        ? o.description(event, change.entity)
        : `${change.entityName} ${event}`,
      subjectType: change.entityName,
      subjectId: change.identifier,
      causerType: causer.userId
        ? (causer.causerType ?? this.moduleOptions.defaultCauserType ?? 'User')
        : undefined,
      causerId: causer.userId,
      event,
      properties: Object.keys(properties).length > 0 ? properties : undefined,
      tenantId: causer.tenantId,
      createdAt: new Date(),
    };
  }

  /**
   * Recomputes a description after the entity's state has moved on since `build`.
   *
   * Only one thing moves: a create whose primary key the database assigns, which
   * lands on the entity after the INSERT. A description that reads that key was
   * formatted before it existed and rendered `undefined`, on a row whose
   * `subjectId` the adapter went on to resolve correctly — the same entry
   * disagreeing with itself across two columns.
   *
   * Returns undefined when the entity carries no description callback: the
   * default `${entityName} ${event}` text cannot depend on the key, so there is
   * nothing to revisit. Callers compare against the original and write only on a
   * difference, which for a deterministic callback happens exactly when it read
   * the key.
   */
  redescribe(change: EntityChange, event: string): string | undefined {
    const decoratorOpts = this.resolveTarget(change);
    if (!decoratorOpts) {
      return undefined;
    }

    const o = this.merge(decoratorOpts, this.dynamicOptions(change.entity));
    return o.description ? o.description(event, change.entity) : undefined;
  }

  private resolveTarget(change: EntityChange): ActivityOptionsConfig | undefined {
    const byConstructor =
      change.entity && typeof change.entity === 'object'
        ? ActivityMetadataStorage.get((change.entity as object).constructor)
        : undefined;
    // Schema-first adapters register by name, not by class (§11.2).
    return byConstructor ?? ActivityMetadataStorage.get(change.entityName);
  }

  private dynamicOptions(entity: unknown): Partial<ActivityOptionsConfig> {
    const candidate = entity as LogsActivityInterface | undefined;
    return typeof candidate?.getActivitylogOptions === 'function'
      ? (candidate.getActivitylogOptions() as Partial<ActivityOptionsConfig>)
      : {};
  }

  /**
   * Property-level fallback: dynamic > decorator > module defaults.
   * A level that did not set a field must not erase the level below it, which is
   * why every level contributes a partial (§4.2).
   */
  private merge(
    decorator: ActivityOptionsConfig,
    dynamic: Partial<ActivityOptionsConfig>,
  ) {
    return {
      logName: dynamic.logName ?? decorator.logName ?? this.moduleOptions.defaultLogName ?? 'default',
      events: dynamic.events ?? decorator.events ?? ['created', 'updated', 'deleted'],
      logOnly: dynamic.logOnly ?? decorator.logOnly,
      logExcept: dynamic.logExcept ?? decorator.logExcept,
      logOnlyDirty: dynamic.logOnlyDirty ?? decorator.logOnlyDirty ?? true,
      dontSubmitEmptyLogs:
        dynamic.dontSubmitEmptyLogs ?? decorator.dontSubmitEmptyLogs ?? true,
      softDeleteField:
        dynamic.softDeleteField ??
        decorator.softDeleteField ??
        this.moduleOptions.softDeleteField ??
        'deletedAt',
      description: dynamic.description ?? decorator.description,
    };
  }

  private classify(
    change: EntityChange,
    softDeleteField: string | false,
  ): 'created' | 'updated' | 'deleted' {
    if (change.operation === 'create') return 'created';
    if (change.operation === 'delete') return 'deleted';

    if (softDeleteField && change.changed && softDeleteField in change.changed) {
      const before = change.before?.[softDeleteField];
      const after = change.changed[softDeleteField];
      if (!before && after) return 'deleted';
    }
    return 'updated';
  }

  private filterAttributes(
    change: EntityChange,
    event: string,
    o: ReturnType<ActivityPipeline['merge']>,
  ): Record<string, unknown> {
    let source: Record<string, unknown>;
    if (change.operation === 'delete') {
      source = { ...(change.before ?? change.after ?? {}) };
    } else if (change.operation === 'update') {
      source = { ...(change.changed ?? change.after ?? {}) };
    } else {
      source = { ...(change.after ?? {}) };
    }

    if (o.logOnly?.length) {
      const kept: Record<string, unknown> = {};
      for (const key of o.logOnly) {
        if (key in source) kept[key] = source[key];
      }
      return kept;
    }

    if (o.logExcept?.length) {
      for (const key of o.logExcept) delete source[key];
    }
    return source;
  }
}
