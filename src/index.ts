export * from './core';
export * from './common';
export * from './feed';
export * from './audit';
export * from './migrations';

// The MikroORM subscribers live in the adapter ring, where the ORM types they
// implement belong, but stay on the root surface: an application has to hand
// them to MikroORM's EventManager, so they are part of the documented setup.
export { ActivitySubscriber } from './adapters/mikro-orm/activity.subscriber';
export { AuditSessionSubscriber } from './adapters/mikro-orm/audit-session.subscriber';

// Same reasoning for the schemas: MikroORM types, declared in the ring, but part
// of the documented setup because an application registers them itself.
export { ActivityLogSchema } from './adapters/mikro-orm/schemas/activity-log.schema';
export { ActivityOutboxSchema } from './adapters/mikro-orm/schemas/activity-outbox.schema';
export { LoggedActionSchema } from './adapters/mikro-orm/schemas/logged-action.schema';
