/**
 * MikroORM adapter — the ORM binding ring (§9, §11.1).
 *
 * Everything reachable from here may import `@mikro-orm/*`. Nothing in `core/`
 * may import anything from here; `core-has-no-orm-dependency.spec.ts` enforces
 * that direction.
 *
 * A second ORM adapter (TypeORM, Sequelize) replaces this module and nothing
 * else: it supplies the same four ports over its own lifecycle events.
 */
export { ActivityLog } from '../../feed/entities/activity-log.entity';
export { ActivityOutbox } from '../../feed/entities/activity-outbox.entity';
export { LoggedAction } from '../../audit/entities/logged-action.entity';

export { ActivitySubscriber } from '../../feed/subscribers/activity.subscriber';
export { AuditSessionSubscriber } from '../../audit/subscribers/audit-session.subscriber';

export { ActivityQueryService } from '../../feed/services/activity-query.service';
export { ActivityOutboxDrainer } from '../../feed/services/activity-outbox.drainer';
export { AuditQueryService } from '../../audit/services/audit-query.service';

export type { FeedQueryOptions } from '../../feed/services/activity-query.service';

// The four ports of §11.1, implemented.
export { MikroOrmActivityAdapter } from './mikro-orm.adapter';
export { MikroOrmChangeCapture } from './mikro-orm-change-capture';
export { MikroOrmActivityStore } from './mikro-orm-activity-store';
export { MikroOrmActivityReader } from './mikro-orm-activity-reader';
export { MikroOrmSessionBinder } from './mikro-orm-session-binder';
