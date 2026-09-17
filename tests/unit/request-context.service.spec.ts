import { describe, it, expect } from 'vitest';
import { RequestContextService } from '../../src/common/request-context.service';

describe('RequestContextService', () => {
  const service = new RequestContextService();

  it('should isolate context between concurrent asynchronous operations', async () => {
    const runTask = (userId: string, delay: number) => {
      return service.run({ userId, tenantId: `tenant-${userId}` }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        expect(service.getUserId()).toBe(userId);
        expect(service.getTenantId()).toBe(`tenant-${userId}`);
        return service.getUserId();
      });
    };

    const results = await Promise.all([
      runTask('user-1', 25),
      runTask('user-2', 10),
      runTask('user-3', 5),
    ]);

    expect(results).toEqual(['user-1', 'user-2', 'user-3']);
  });

  it('should allow nested runWith() to merge values without clobbering outer scope', async () => {
    await service.run({ userId: 'outer-user', tenantId: 'outer-tenant' }, async () => {
      expect(service.getUserId()).toBe('outer-user');
      expect(service.getTenantId()).toBe('outer-tenant');

      await service.runWith({ tenantId: 'inner-tenant' }, async () => {
        expect(service.getUserId()).toBe('outer-user'); // Preserved
        expect(service.getTenantId()).toBe('inner-tenant'); // Overridden
      });

      // Returns to outer scope
      expect(service.getUserId()).toBe('outer-user');
      expect(service.getTenantId()).toBe('outer-tenant');
    });
  });

  it('should support runWithDisabledFeed flag', async () => {
    await service.run({ userId: 'seeder' }, async () => {
      expect(service.isFeedDisabled()).toBe(false);

      await service.runWithDisabledFeed(async () => {
        expect(service.isFeedDisabled()).toBe(true);
        expect(service.getUserId()).toBe('seeder'); // Preserved
      });

      expect(service.isFeedDisabled()).toBe(false);
    });
  });
});
