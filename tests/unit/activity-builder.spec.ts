import { describe, it, expect, vi } from 'vitest';
import { ActivityBuilder } from '../../src/feed/services/activity-builder';
import { RequestContextService } from '../../src/common/request-context.service';
import { ActivityRecord, ActivityStore } from '../../src/core';

/**
 * The manual logging path.
 *
 * `requestContext.run()` returns whatever the callback returns, so an async
 * callback has to be awaited — an earlier version of this file dropped that
 * promise, and every assertion below ran after the test had already reported
 * green. It asserted nothing for as long as it existed.
 */
function mockStore() {
  const persisted: ActivityRecord[] = [];
  const store: ActivityStore = {
    persist: vi.fn(async (records: ActivityRecord[]) => {
      persisted.push(...records);
    }),
  };
  return { store, persisted };
}

describe('ActivityBuilder', () => {
  it('builds and persists a record with all attributes', async () => {
    const { store, persisted } = mockStore();
    const requestContext = new RequestContextService();

    const log = await requestContext.run(
      { userId: 'user-default', tenantId: 'tenant-default', causerType: 'User' },
      async () => {
        const builder = new ActivityBuilder(store, requestContext, 'default-feed', 'User');

        const invoice = { id: 'inv-123', constructor: { name: 'Invoice' } };
        const user = { id: 'usr-999', constructor: { name: 'Admin' } };

        return builder
          .performedOn(invoice)
          .causedBy(user)
          .withEvent('validated')
          .inLog('billing')
          .withProperties({ total: 500, discount: 50 })
          .withTenant('tenant-custom')
          .log('Invoice approved and validated');
      },
    );

    // One call, one record, and the record is the one handed back.
    expect(store.persist).toHaveBeenCalledTimes(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toBe(log);

    expect(log.description).toBe('Invoice approved and validated');
    expect(log.logName).toBe('billing');
    expect(log.subjectType).toBe('Invoice');
    expect(log.subjectId).toBe('inv-123');
    expect(log.causerType).toBe('Admin');
    expect(log.causerId).toBe('usr-999');
    expect(log.event).toBe('validated');
    expect(log.properties).toEqual({ total: 500, discount: 50 });
    expect(log.tenantId).toBe('tenant-custom');
    expect(log.id).toBeTruthy();
    expect(log.createdAt).toBeInstanceOf(Date);
  });

  it('defaults causer and tenant from RequestContext when omitted', async () => {
    const { store } = mockStore();
    const requestContext = new RequestContextService();

    const log = await requestContext.run(
      { userId: 'ctx-user', tenantId: 'ctx-tenant', causerType: 'System' },
      async () =>
        new ActivityBuilder(store, requestContext)
          .performedOn({ id: 'task-1' }, 'Task')
          .log('Task executed'),
    );

    expect(log.causerId).toBe('ctx-user');
    expect(log.causerType).toBe('System');
    expect(log.tenantId).toBe('ctx-tenant');
    expect(log.subjectType).toBe('Task');
    expect(log.subjectId).toBe('task-1');
    expect(log.logName).toBe('default');
  });

  it('writes with no transaction handle, as the fork used to', async () => {
    const { store } = mockStore();
    const requestContext = new RequestContextService();

    await requestContext.run({}, async () =>
      new ActivityBuilder(store, requestContext).log('unattributed'),
    );

    // Second argument is the ambient transaction; a manual entry has none, which
    // is why it is not rolled back with the caller's work.
    expect(store.persist).toHaveBeenCalledWith(expect.any(Array), undefined);
  });
});
