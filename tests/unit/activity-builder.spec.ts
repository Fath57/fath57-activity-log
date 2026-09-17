import { describe, it, expect, vi } from 'vitest';
import { ActivityBuilder } from '../../src/feed/services/activity-builder';
import { RequestContextService } from '../../src/common/request-context.service';
import { ActivityLog } from '../../src/feed/entities/activity-log.entity';

describe('ActivityBuilder', () => {
  it('should build and persist an ActivityLog with all attributes', async () => {
    let persistedLog: ActivityLog | undefined;
    // Mirrors the MikroORM 7 surface, which has no persistAndFlush: a mock that
    // still offered it would keep passing after the package stopped working.
    const mockEm = {
      persist: vi.fn().mockImplementation((log: ActivityLog) => {
        persistedLog = log;
      }),
      flush: vi.fn().mockResolvedValue(undefined),
    };

    const requestContext = new RequestContextService();
    requestContext.run(
      { userId: 'user-default', tenantId: 'tenant-default', causerType: 'User' },
      async () => {
        const builder = new ActivityBuilder(mockEm as any, requestContext, 'default-feed', 'User');

        const invoice = { id: 'inv-123', constructor: { name: 'Invoice' } };
        const user = { id: 'usr-999', constructor: { name: 'Admin' } };

        const log = await builder
          .performedOn(invoice)
          .causedBy(user)
          .withEvent('validated')
          .inLog('billing')
          .withProperties({ total: 500, discount: 50 })
          .withTenant('tenant-custom')
          .log('Invoice approved and validated');

        expect(mockEm.persist).toHaveBeenCalledTimes(1);
        expect(mockEm.flush).toHaveBeenCalledTimes(1);
        expect(log).toBe(persistedLog);
        expect(log.description).toBe('Invoice approved and validated');
        expect(log.logName).toBe('billing');
        expect(log.subjectType).toBe('Invoice');
        expect(log.subjectId).toBe('inv-123');
        expect(log.causerType).toBe('Admin');
        expect(log.causerId).toBe('usr-999');
        expect(log.event).toBe('validated');
        expect(log.properties).toEqual({ total: 500, discount: 50 });
        expect(log.tenantId).toBe('tenant-custom');
      },
    );
  });

  it('should default causer and tenant from RequestContext if omitted', async () => {
    const mockEm = {
      persist: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };

    const requestContext = new RequestContextService();
    await requestContext.run(
      { userId: 'ctx-user', tenantId: 'ctx-tenant', causerType: 'System' },
      async () => {
        const builder = new ActivityBuilder(mockEm as any, requestContext);

        const log = await builder
          .performedOn({ id: 'task-1' }, 'Task')
          .log('Task executed');

        expect(log.causerId).toBe('ctx-user');
        expect(log.causerType).toBe('System');
        expect(log.tenantId).toBe('ctx-tenant');
        expect(log.subjectType).toBe('Task');
        expect(log.subjectId).toBe('task-1');
      },
    );
  });
});
