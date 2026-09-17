import { ChangeSetType } from '@mikro-orm/core';
import { ChangeCapture } from '../../core/ports';
import { EntityChange, TransactionRef } from '../../core/model/entity-change';

type Handler = (changes: EntityChange[], tx: TransactionRef) => void | Promise<void>;

/**
 * MikroORM splits deletes and updates into a regular and an `_EARLY` variant:
 * the early ones are the same mutation scheduled ahead of the rest of the flush
 * to satisfy a foreign key (a cascade, or an FK that would otherwise be violated
 * mid-flush). They are the same business event, so they map to the same
 * operation. Treating `delete_early` as an update files a cascaded deletion in
 * the feed as a modification, with `after` holding the payload instead of the
 * removed values.
 */
const OPERATION_BY_CHANGE_SET_TYPE: Record<string, EntityChange['operation']> = {
  [ChangeSetType.CREATE]: 'create',
  [ChangeSetType.UPDATE]: 'update',
  [ChangeSetType.UPDATE_EARLY]: 'update',
  [ChangeSetType.DELETE]: 'delete',
  [ChangeSetType.DELETE_EARLY]: 'delete',
};

/**
 * Translates MikroORM change sets into the neutral `EntityChange` shape.
 *
 * Both capability flags are true here, which is why MikroORM is the reference
 * profile: the UnitOfWork hands over a whole flush at once, with the original
 * entity state attached, so exact diffing costs nothing extra. A TypeORM adapter
 * would set `batchesByFlush` false; a Prisma one would have to set
 * `providesBeforeState` false, and the core would then refuse `logOnlyDirty`
 * rather than silently paying for a read-before-write on every mutation (§11.2).
 */
export class MikroOrmChangeCapture implements ChangeCapture {
  readonly providesBeforeState = true;
  readonly batchesByFlush = true;

  private handlers: Handler[] = [];

  onChanges(handler: Handler): void {
    this.handlers.push(handler);
  }

  /** Called by the subscriber with a MikroORM UnitOfWork. */
  async emitFromUnitOfWork(uow: any, tx: TransactionRef): Promise<void> {
    const changes = uow.getChangeSets().map((cs: any) => this.toEntityChange(cs));
    for (const handler of this.handlers) {
      await handler(changes, tx);
    }
  }

  toEntityChange(cs: any): EntityChange {
    const operation = OPERATION_BY_CHANGE_SET_TYPE[cs.type] ?? 'update';

    const pkName = cs.meta?.primaryKeys?.[0] ?? 'id';
    const identifier = cs.entity?.[pkName] ?? cs.entity?.id;

    return {
      entity: cs.entity,
      entityName: cs.entity?.constructor?.name ?? cs.name ?? 'Unknown',
      operation,
      identifier: identifier != null ? String(identifier) : undefined,
      before: cs.originalEntity ? { ...cs.originalEntity } : undefined,
      after:
        operation === 'delete'
          ? { ...(cs.originalEntity ?? {}) }
          : { ...(cs.payload ?? {}) },
      changed: operation === 'update' ? { ...(cs.payload ?? {}) } : undefined,
    };
  }
}
