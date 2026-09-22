import { EntityManager } from '@mikro-orm/core';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AuditModule } from '../../src/audit/audit.module';
import { AuditQueryService } from '../../src/audit/services/audit-query.service';
import { AuditSessionSubscriber } from '../../src/audit/subscribers/audit-session.subscriber';
import { RequestContextModule } from '../../src/common/request-context.module';
import { FeedModule } from '../../src/feed/feed.module';
import { ActivityLogger } from '../../src/feed/services/activity-logger.service';
import { ActivityOutboxDrainer } from '../../src/feed/services/activity-outbox.drainer';
import { ActivityQueryService } from '../../src/feed/services/activity-query.service';
import { ActivitySubscriber } from '../../src/adapters/mikro-orm/activity.subscriber';

/**
 * §10 — the modules must instantiate in a real Nest container.
 *
 * `module-adapter-wiring.spec.ts` reads the DynamicModule metadata, which is a
 * plain object: it proves the providers are listed, never that the injector can
 * build them. That gap hid a constructor whose optional parameter was typed as
 * an interface and left undecorated, so `emitDecoratorMetadata` recorded its
 * token as `Object` and Nest threw on the first real bootstrap. Compiling the
 * modules here is the only check that exercises the injector.
 */
const em: any = { find: async () => [], persist: () => undefined, flush: async () => undefined };
em.fork = () => em;

/**
 * Global on purpose: MikroOrmModule registers the EntityManager globally, and
 * FeedModule resolves it from the ambient context rather than importing the ORM
 * module itself. A non-global stub would fail here for a reason no application
 * would ever hit.
 */
@Global()
@Module({ providers: [{ provide: EntityManager, useValue: em }], exports: [EntityManager] })
class EntityManagerStubModule {}

describe('module instantiation', () => {
  async function compile(...imports: any[]) {
    return Test.createTestingModule({
      imports: [EntityManagerStubModule, RequestContextModule.forRoot(), ...imports],
    }).compile();
  }

  it('builds every FeedModule provider through the injector', async () => {
    const moduleRef = await compile(
      FeedModule.forRoot({ defaultLogName: 'default', defaultCauserType: 'User' }),
    );

    expect(moduleRef.get(ActivityLogger)).toBeInstanceOf(ActivityLogger);
    expect(moduleRef.get(ActivityQueryService)).toBeInstanceOf(ActivityQueryService);
    expect(moduleRef.get(ActivityOutboxDrainer)).toBeInstanceOf(ActivityOutboxDrainer);
    expect(moduleRef.get(ActivitySubscriber)).toBeInstanceOf(ActivitySubscriber);

    await moduleRef.close();
  });

  it('builds every AuditModule provider through the injector', async () => {
    const moduleRef = await compile(
      AuditModule.forRoot({ sessionVariableName: 'app.current_user_id' }),
    );

    expect(moduleRef.get(AuditQueryService)).toBeInstanceOf(AuditQueryService);
    expect(moduleRef.get(AuditSessionSubscriber)).toBeInstanceOf(AuditSessionSubscriber);

    await moduleRef.close();
  });

  it('builds both modules side by side, as an application would', async () => {
    const moduleRef = await compile(
      FeedModule.forRoot(),
      AuditModule.forRoot({ sessionVariableName: 'app.current_user_id' }),
    );

    expect(moduleRef.get(ActivitySubscriber)).toBeInstanceOf(ActivitySubscriber);
    expect(moduleRef.get(AuditSessionSubscriber)).toBeInstanceOf(AuditSessionSubscriber);

    await moduleRef.close();
  });
});
