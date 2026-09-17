# fath57-activity-log

Two decoupled modules for **NestJS 10/11** + **MikroORM 6 or 7** + **PostgreSQL 13+**: a user-facing activity feed, and a database-level audit trail.

They are deliberately separate because they answer different questions.

| | Business Activity Feed | System Audit Trail |
| :--- | :--- | :--- |
| Answers | *"What did Sarah do?"* | *"What changed in this row, and who says so?"* |
| Lives in | Your application | PostgreSQL triggers |
| `em.nativeUpdate()` / raw SQL | **Invisible** — by design | **Recorded** |
| Written by | The ORM lifecycle | The database engine |
| Tamperable by the app role | Yes (full CRUD) | No (SELECT only) |

If you only need one: the feed is what users read, the audit trail is what auditors read. Most applications want both, and the asymmetry in the third row is the reason they cannot be the same table.

---

## Install

```bash
npm install fath57-activity-log
```

Peer dependencies: `@nestjs/common`, `@nestjs/core`, `reflect-metadata`. The `@mikro-orm/*` peers are **optional** — the core carries no ORM dependency, so a future adapter for another ORM does not drag MikroORM in.

One build serves MikroORM 6 and 7. The entities ship as `EntitySchema`s rather than decorated classes: v7 moved the decorators out of `@mikro-orm/core`, and which flavour works depends on the `metadataProvider` your application configures. `EntitySchema` is exported identically by both majors and needs no metadata provider.

---

## Quick start

### 1. Register the modules

```ts
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import {
  FeedModule,
  AuditModule,
  RequestContextModule,
  RequestContextInterceptor,
  ActivitySubscriber,
  AuditSessionSubscriber,
} from 'fath57-activity-log';
import {
  ActivityLogSchema,
  ActivityOutboxSchema,
  LoggedActionSchema,
} from 'fath57-activity-log/mikro-orm';

@Module({
  imports: [
    MikroOrmModule.forFeature([ActivityLogSchema, ActivityOutboxSchema, LoggedActionSchema]),

    RequestContextModule.forRoot({
      userExtractor: (req) => ({
        userId: req.user?.id ?? req.user?.sub,
        userEmail: req.user?.email,
        tenantId: req.user?.tenantId,
      }),
    }),

    FeedModule.forRoot({ defaultLogName: 'default', defaultCauserType: 'User' }),
    AuditModule.forRoot({ sessionVariableName: 'app.current_user_id' }),
  ],
  providers: [
    // An INTERCEPTOR, not a middleware: guards run after middleware, so req.user
    // would still be undefined there and every entry would be unattributed.
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
  ],
})
export class AppModule {}
```

The entities are declared as `EntitySchema`s, not with decorators: MikroORM moved
the decorators out of `@mikro-orm/core` in v7, and which flavour works depends on
the `metadataProvider` your application configures. One schema serves MikroORM 6
and 7 alike. Register the same three schemas in your ORM config `entities` array.
Queries still take the classes — `em.find(ActivityLog, …)`, exported alongside.

MikroORM only dispatches flush events to subscribers its own `EventManager`
knows about, and providing them to Nest is not enough. Register them once the ORM
is up — the modules export both:

```ts
export class AppModule implements OnModuleInit {
  constructor(
    private readonly orm: MikroORM,
    private readonly activitySubscriber: ActivitySubscriber,
    private readonly auditSubscriber: AuditSessionSubscriber,
  ) {}

  onModuleInit(): void {
    const events = this.orm.em.getEventManager();
    events.registerSubscriber(this.activitySubscriber);
    events.registerSubscriber(this.auditSubscriber);
  }
}
```

Passing them to `MikroORM.init({ subscribers: […] })` works too, but builds them
outside Nest, so they get a different `RequestContextService` than the interceptor
populates and every entry lands unattributed. The `EntityManager` must also be
resolvable from the modules' context: `MikroOrmModule.forRoot()` registers it
globally, so this is already true unless you have scoped the ORM module yourself.

Exclude the audit schema from MikroORM's schema generator — it is partitioned and owned by migrations:

```ts
schemaGenerator: { ignoreSchema: ['audit'] }
```

### 2. Run the migration

```ts
import { Migration } from '@mikro-orm/migrations';
import {
  getFeedSchemaStatements,
  getAuditSchemaStatements,
  getInitialPartitionStatements,
  getDropAuditSchemaStatements,
  getDropFeedSchemaStatements,
} from 'fath57-activity-log/migrations';

export class Migration001ActivityLog extends Migration {
  async up(): Promise<void> {
    for (const sql of getFeedSchemaStatements()) this.addSql(sql);
    for (const sql of getAuditSchemaStatements()) this.addSql(sql);
    for (const sql of getInitialPartitionStatements(new Date(), 4)) this.addSql(sql);
  }

  async down(): Promise<void> {
    for (const sql of getDropAuditSchemaStatements()) this.addSql(sql);
    for (const sql of getDropFeedSchemaStatements()) this.addSql(sql);
  }
}
```

### 3. Mark the entities you want in the feed

```ts
// v6: '@mikro-orm/core' — v7: '@mikro-orm/decorators/legacy' or '/es'.
// `LogsActivity` itself is a plain class decorator and works with either.
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { LogsActivity } from 'fath57-activity-log';
import { randomUUID } from 'node:crypto';

@Entity()
@LogsActivity({
  logName: 'billing',
  logExcept: ['internalNotes'],
  description: (event, invoice: Invoice) => `Invoice ${invoice.reference} ${event}`,
})
export class Invoice {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property()
  reference!: string;

  @Property({ type: 'decimal', precision: 12, scale: 2 })
  total: string = '0.00';

  @Property({ nullable: true })
  internalNotes?: string;
}
```

That is all the feed needs. Creating, updating or deleting an `Invoice` through the ORM now produces an entry, with the causer taken from the request context.

### 4. Turn on the audit trail for a table

```sql
SELECT audit.track_table('public.invoices'::regclass, ARRAY['id'], ARRAY['internal_notes']);
```

Or from TypeScript:

```ts
import { getTrackTableSql } from 'fath57-activity-log/migrations';

this.addSql(getTrackTableSql('public.invoices', ['id'], ['internal_notes']));
```

Composite keys work: pass `['order_id', 'line_id']`.

To stop auditing a table — which is what a migration's `down()` needs — detach the
triggers with the inverse call:

```ts
import { getUntrackTableSql } from 'fath57-activity-log/migrations';

this.addSql(getUntrackTableSql('public.invoices'));
```

It removes the two triggers and nothing else: rows already recorded stay, because
an audit trail you can erase selectively is not one. Untracking a table that was
never tracked is a no-op, so a `down()` runs safely against a database that never
had them.

Both calls go through `audit.track_table` / `audit.untrack_table` rather than
emitting `CREATE TRIGGER` and `DROP TRIGGER` directly. The trigger names are
derived from the resolved relation inside the database, so a caller never has to
reproduce the naming rule or quote a mixed-case table — and after the hardening
script both functions are owned by `audit_admin` and revoked from `PUBLIC`.
Detaching a trigger switches the trail off silently, so it is not an operation the
application role should hold.

---

## Customising what an entity logs

`@LogsActivity()` takes eight options, all optional. Passing none logs every
attribute of every create, update and delete under the log name `default`.

| Option | Default | What it does |
| :--- | :--- | :--- |
| `logName` | module `defaultLogName`, else `'default'` | The feed this entity writes to. Query one feed at a time rather than filtering in the application. |
| `events` | `['created', 'updated', 'deleted']` | Which lifecycle events produce an entry. Narrowing it drops the others before any work. |
| `logOnly` | — | Whitelist of attributes kept in `properties`. |
| `logExcept` | — | Blacklist. Ignored when `logOnly` is set — a whitelist already answers the question. |
| `logOnlyDirty` | `true` | On an update, keep only the attributes that actually changed. |
| `dontSubmitEmptyLogs` | `true` | Drop an update whose `properties` came out empty after filtering, instead of writing a row that says nothing. |
| `softDeleteField` | `'deletedAt'` | The field whose first non-null value reclassifies an update as `deleted`. `false` turns the reclassification off. |
| `description` | `` `${entityName} ${event}` `` | Formats the entry's text. |

### Deciding at runtime rather than at import time

A decorator is evaluated once, when the class is loaded, so it cannot depend on
the row. Implement `LogsActivityInterface` when the answer varies per instance —
the entity's own options win over its decorator, field by field:

```ts
import { LogsActivity, LogOptions, LogsActivityInterface } from 'fath57-activity-log';

@Entity()
@LogsActivity({ logName: 'billing', logExcept: ['internalNotes'] })
export class Invoice implements LogsActivityInterface {
  // …

  getActivitylogOptions() {
    return LogOptions.partial()
      .useLogName(Number(this.total) > 10_000 ? 'billing-large' : 'billing')
      .logOnly(['status', 'total'])
      .toPartial();
  }
}
```

`LogOptions.partial()` starts empty and records only the fields you actually set,
which is what `toPartial()` returns. That matters: precedence is resolved per
field, so a level that stayed silent must not erase the level beneath it.
`LogOptions.defaults()` exists too, but it marks every field as set, so it
overrides the decorator wholesale — use it when that is what you mean.

The three levels, highest first:

1. the entity's `getActivitylogOptions()`
2. the `@LogsActivity()` decorator
3. `FeedModule.forRoot()` defaults

### Entities without classes

The decorator is sugar over `registerActivity`, which is the primitive. A
schema-first ORM with no entity class registers under a string key instead:

```ts
import { registerActivity } from 'fath57-activity-log';

registerActivity('Invoice', { logName: 'billing' });
```

The key must match the `entityName` the adapter reports.

### Module-wide defaults

```ts
FeedModule.forRoot({
  defaultLogName: 'default',
  defaultCauserType: 'User',
  logOnlyDirty: true,
  softDeleteField: 'deletedAt',
  flushMode: 'sync',          // 'outbox' defers the write to a drained table
  generatedIdStrategy: 'resolve',
});
```

`logOnlyDirty: true` is rejected at bootstrap if the configured adapter reports
`providesBeforeState: false`, rather than silently logging every attribute
forever or paying a read before every write. Same for `flushMode: 'outbox'`
against an adapter that supplies no `ActivityStore`.

### Two things that catch people out

**`description` receives the entity that changed, not the one you had in mind.**
If a title lives on `PostVersion` and you decorate `PostVersion`, the callback is
handed a `PostVersion` — typing the parameter as `Post` compiles, because the
option is declared `(event: string, entity: any) => string`, and then silently
reads `undefined`. Read only scalar columns there: a relation is a reference, and
touching it loads a proxy mid-flush.

**A key the database assigns does not exist when the description is built.** With
`@PrimaryKey({ defaultRaw: 'gen_random_uuid()' })` or a `SERIAL`, the entry is
formatted inside `onFlush`, before the `INSERT`. The package reformats the text
in the same pass that resolves `subjectId`, so `` `Invoice ${invoice.id}` ``
comes out right — at the cost of one extra `UPDATE` per such create. A
description that reads no key is left alone. Under `flushMode: 'outbox'` the same
pass patches the queued payload instead, so the drainer writes the resolved
values rather than the ones formatted before the `INSERT`.

---

## Two things you must do before production

These are not optional polish. Skipping either leaves the package working but not doing its job.

### Schedule the monthly partition top-up

The audit table is range-partitioned by month. The migration pre-creates four months; **something must keep creating them**, or every row falls into the `DEFAULT` partition and none of the partitioning benefits apply.

```ts
import { Cron } from '@nestjs/schedule';
import { EntityManager } from '@mikro-orm/core';

@Injectable()
export class AuditPartitionMaintenance {
  constructor(private readonly em: EntityManager) {}

  @Cron('0 3 1 * *') // 03:00 UTC on the 1st
  async ensurePartitions(): Promise<void> {
    const now = new Date();
    for (let i = 0; i <= 3; i++) {
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      await this.em.execute('SELECT audit.create_monthly_partition(?)', [month]);
    }
  }
}
```

Alert on `audit.logged_actions_default` being non-empty. It is a tripwire, not a destination:

```sql
SELECT count(*) FROM audit.logged_actions_default;  -- expected: 0
```

### Run the hardening script, as a DBA

Until this runs, the application role owns the audit table and can rewrite it — the "tamper-resistant" property simply does not hold yet.

```ts
import { getHardeningScript } from 'fath57-activity-log/migrations';

console.log(getHardeningScript('my_app_user', 'audit_admin'));
```

Review the output and run it **once per environment, as a superuser**. It is deliberately not part of the migration: `CREATE ROLE` and `ALTER … OWNER TO` need privileges your migration role should not have, so putting it in `up()` guarantees either a failure or an over-privileged migration role.

Grant the bypass role only to named batch accounts:

```sql
GRANT audit_bypass TO batch_importer;
```

---

## Reading the feed

```ts
const page = await this.activityQuery.findForSubject('Invoice', invoice.id, { limit: 20 });
page.data;        // ActivityLog[]
page.nextCursor;  // pass back as { cursor } for the next page
```

Pagination is by cursor, not offset. Tenant scoping is **on by default**: every read is confined to the ambient `tenantId` from the request context. Crossing tenants is explicit:

```ts
await this.activityQuery.findFeed('billing', { tenantId: null }); // back-office only
```

Retention:

```ts
await this.activityQuery.prune(new Date(Date.now() - 365 * 864e5));
```

## Logging a business event by hand

For milestones that are not CRUD:

```ts
await this.activityLogger
  .performedOn(invoice)
  .withEvent('validated')
  .inLog('billing')
  .withProperties({ total: invoice.total, discountRate: 0.15 })
  .log('Invoice validated with an exceptional discount');
```

## Turning the feed off for a batch

```ts
await this.activityLogger.withoutLogs(async () => {
  await this.importTenThousandInvoices();
});
```

This silences the **feed only**. The audit trail keeps recording, which is the point — see below.

## Reading the audit trail

```ts
await this.auditQuery.findForRow('public', 'invoices', invoice.id);
await this.auditQuery.findForTransaction(txId);   // everything one transaction did
await this.auditQuery.findForUser('user-42', { from, to });
```

---

## Things worth knowing before you rely on it

**The feed does not see `em.nativeUpdate()`, the QueryBuilder, or raw SQL.** No ORM lifecycle event fires, so no entry is written. This is by design, and it is exactly why the audit module exists: the trigger records those mutations regardless. If you need them in the user-facing feed, log them explicitly with `ActivityLogger`.

**Attribution needs a transaction.** `changed_by` is set from a transaction-local PostgreSQL setting. A mutation outside a MikroORM-managed transaction is still recorded, but unattributed. Wrap writes that matter in `em.transactional()`.

**Under PgBouncer transaction pooling**, `session_user` and `client_addr` become the pooler's, identical for every user. The `SET LOCAL` attribution still works correctly, but the engine-provided columns carry no per-user information. Connect directly if you need database-level forensics per user.

**Always list large columns in `ignored_columns`.** `to_jsonb(NEW)` de-TOASTs them on every audited write. Measured on PostgreSQL 16, median per `UPDATE`, 40 interleaved rounds:

| Row shape | median | vs baseline |
| :--- | ---: | ---: |
| narrow row, no trigger | 1.24 ms | 1.0× |
| narrow row, audited | 1.27 ms | ~1.0× |
| 30 text columns, audited | 1.31 ms | ~1.1× |
| 512 KB TOASTed column, **not** ignored | 7.7 ms | **6×** |
| 512 KB TOASTed column, **ignored** | 2.8 ms | 2.3× |

On a narrow row the trigger costs less than the run-to-run spread — it is there, but it is not what you will notice. A single large column is a different story, and `ignored_columns` recovers most of it. Treat the ratios as transferable, not the milliseconds: run `npm run bench` against your own data.

**`client_query` is off by default.** `current_query()` contains literal values, so enabling it would put the very passwords and tokens you stripped via `ignored_columns` back into the audit table in plain text. Enable it knowingly, per table.

**GDPR erasure** is targeted pseudonymisation, not deletion — the audit trail is meant to resist rewriting:

```ts
import { anonymizeSubject } from 'fath57-activity-log/migrations';

await anonymizeSubject(em.getConnection(), {
  schema: 'public',
  table: 'users',              // required: row_id is unique only within a table
  rowId: subjectId,
  actor: subjectId,
  keys: ['email', 'name', 'phone'],
  from: new Date('2020-01-01'),
  to: new Date(),
});
```

---

## Development

```bash
npm run db:up            # throwaway PostgreSQL 16 on :55432
npm test                 # 208 tests: unit + integration
npm run bench            # publishes the overhead table above
npm run db:down
```

CI runs the whole suite against four combinations — NestJS 10/11/12 against
MikroORM 6/7, as far as `@mikro-orm/nestjs` allows them to be paired. The matrix
is the peer range: a version this package claims to support and never exercises
stops being supported without anyone noticing.

The integration suite runs against a real PostgreSQL. It is where six defects were found that were invisible by reading — including a hardening script that switched auditing off, and an attribution binding that left `changed_by` NULL on every row while appearing to work.

## Design documents

- [`SPECIFICATION.md`](./SPECIFICATION.md) — architecture, threat model, SQL, portability profiles
- [`SPECIFICATION-REVIEW.md`](./SPECIFICATION-REVIEW.md) — six review rounds, every finding traced to its resolution

## Extending to another ORM or database

The feed is adapter-bound and portable; the audit trail is engine-bound and is not. `core/` carries no ORM dependency, and four ports (`ChangeCapture`, `ActivityStore`, `ActivityReader`, `SessionBinder`) define what an adapter must supply. `tests/conformance/adapter-conformance.suite.ts` is the acceptance criterion: a new adapter is done when it passes that file unmodified.

TypeORM and Sequelize are realistic targets. Prisma and Drizzle are not — without a unit of work and a cheap before-state, `logOnlyDirty` and exact diffing cost a read per mutation, and `FeedModule.forRoot()` will refuse that configuration rather than degrade quietly. See §11 of the specification.

## License

MIT
