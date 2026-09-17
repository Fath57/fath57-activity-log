import { ChangeSetType } from '@mikro-orm/core';
import { describe, it, expect } from 'vitest';
import { MikroOrmChangeCapture } from '../../src/adapters/mikro-orm/mikro-orm-change-capture';

class Invoice {
  constructor(public id = 'inv-1') {}
}

function changeSet(type: ChangeSetType) {
  return {
    type,
    entity: new Invoice(),
    meta: { primaryKeys: ['id'] },
    originalEntity: { id: 'inv-1', total: 100 },
    payload: { total: 250 },
  };
}

describe('MikroOrmChangeCapture.toEntityChange', () => {
  const capture = new MikroOrmChangeCapture();

  it.each([
    [ChangeSetType.CREATE, 'create'],
    [ChangeSetType.UPDATE, 'update'],
    [ChangeSetType.UPDATE_EARLY, 'update'],
    [ChangeSetType.DELETE, 'delete'],
    [ChangeSetType.DELETE_EARLY, 'delete'],
  ] as const)('maps %s to the %s operation', (type, operation) => {
    expect(capture.toEntityChange(changeSet(type)).operation).toBe(operation);
  });

  /**
   * A cascaded delete reaches the subscriber as DELETE_EARLY, not DELETE. The
   * operation drives `after` and `changed`, so getting it wrong files the
   * removal in the feed as an edit that set `total` to its new payload value.
   */
  it('gives an early delete the same shape as a regular delete', () => {
    const early = capture.toEntityChange(changeSet(ChangeSetType.DELETE_EARLY));
    const regular = capture.toEntityChange(changeSet(ChangeSetType.DELETE));

    expect(early).toEqual(regular);
    expect(early.after).toEqual({ id: 'inv-1', total: 100 });
    expect(early.changed).toBeUndefined();
  });

  it('falls back to update for a change set type it does not know', () => {
    const change = capture.toEntityChange({
      ...changeSet(ChangeSetType.UPDATE),
      type: 'some_future_type',
    });

    expect(change.operation).toBe('update');
  });
});
