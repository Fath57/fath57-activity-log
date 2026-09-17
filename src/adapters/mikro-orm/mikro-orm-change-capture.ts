import { ChangeSetType } from '@mikro-orm/core';
import { ChangeCapture } from '../../core/ports';
import { EntityChange, TransactionRef } from '../../core/model/entity-change';

type Handler = (changes: EntityChange[], tx: TransactionRef) => void | Promise<void>;

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
    const operation =
      cs.type === ChangeSetType.CREATE
        ? 'create'
        : cs.type === ChangeSetType.DELETE
          ? 'delete'
          : 'update';

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
