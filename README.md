# @fath57/activity-log

Two modules for **NestJS 10/11/12** + **MikroORM 6 or 7** + **PostgreSQL 13+**: a user-facing activity feed, and a database-level audit trail.

They are separate because they answer different questions.

| | Activity feed | Audit trail |
| :--- | :--- | :--- |
| Answers | *"What did Sarah do?"* | *"What changed in this row, and who says so?"* |
| Written by | The ORM lifecycle | PostgreSQL triggers |
| `em.nativeUpdate()` / raw SQL | **Invisible**, by design | **Recorded** |
| Writable by the app role | Yes | No (SELECT only) |

That last row is why they cannot be one table.

---

## Install

```bash
npm install @fath57/activity-log
```

Peers: `@nestjs/common`, `@nestjs/core`, `reflect-metadata`. The `@mikro-orm/*` peers are optional — the core carries no ORM dependency.

---

## Setup

### 1. Register the modules

```ts
import { Module, OnModuleInit } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import {
  FeedModule,
  AuditModule,
  RequestContextModule,
  RequestContextInterceptor,
  ActivitySubscriber,
  AuditSessionSubscriber,
} from '@fath57/activity-log';
import {
  ActivityLogSchema,
  ActivityOutboxSchema,
  LoggedActionSchema,
} from '@fath57/activity-log/mikro-orm';

@Module({
  imports: [
    MikroOrmModule.forFeature([ActivityLogSchema, ActivityOutboxSchema, LoggedActionSchema]),
    RequestContextModule.forRoot({
      userExtractor: (req) => ({ userId: req.user?.id, tenantId: req.user?.tenantId }),
    }),
    FeedModule.forRoot({ defaultLogName: 'default', defaultCauserType: 'User' }),
    AuditModule.forRoot({ sessionVariableName: 'app.current_user_id' }),
  ],
  providers: [
    // An interceptor, not a middleware: guards run after middleware, so req.user
    // would still be undefined and every entry would be unattributed.
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
  ],
})
export class AppModule implements OnModuleInit {
  constructor(
    private readonly orm: MikroORM,
    private readonly activitySubscriber: ActivitySubscriber,
    private readonly auditSubscriber: AuditSessionSubscriber,
  ) {}

  // Required. MikroORM only dispatches to subscribers its own EventManager
  // knows about — providing them to Nest is not enough, and without this the
  // feed stays silently empty.
  onModuleInit(): void {
    const events = this.orm.em.getEventManager();
    events.registerSubscriber(this.activitySubscriber);
    events.registerSubscriber(this.auditSubscriber);
  }
}
```

In your ORM config, register the same three schemas in `entities`, and exclude the audit schema from the schema generator — it is partitioned and owned by migrations:

```ts
schemaGenerator: { ignoreSchema: ['audit'] }
```

Skip that and the generator creates `audit.logged_actions` unpartitioned, after which the migration below fails with `"logged_actions" is not partitioned`.

### 2. Run the migration

```ts
import { Migration } from '@mikro-orm/migrations';
import {
  getFeedSchemaStatements,
  getAuditSchemaStatements,
  getInitialPartitionStatements,
  getDropAuditSchemaStatements,
  getDropFeedSchemaStatements,
} from '@fath57/activity-log/migrations';

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
import { LogsActivity } from '@fath57/activity-log';

@Entity()
@LogsActivity({
  logName: 'billing',
  logExcept: ['internalNotes'],
  description: (event, invoice: Invoice) => `Invoice ${invoice.reference} ${event}`,
})
export class Invoice { /* … */ }
```

Creating, updating or deleting an `Invoice` through the ORM now produces an entry, attributed from the request context.

### 4. Turn on the audit trail, per table

```ts
import { getTrackTableSql, getUntrackTableSql } from '@fath57/activity-log/migrations';

this.addSql(getTrackTableSql('public.invoices', ['id'], ['internal_notes']));
this.addSql(getUntrackTableSql('public.invoices'));   // for down()
```

Composite keys work: pass `['order_id', 'line_id']`. Always list large columns as ignored — `to_jsonb(NEW)` de-TOASTs them on every audited write, which is the one case where the trigger cost is visible (`npm run bench`).

---

## Before production

**Schedule the partition top-up.** The audit table is range-partitioned by month and the migration pre-creates four. Something must keep creating them:

```ts
@Cron('0 3 1 * *')
async ensurePartitions(): Promise<void> {
  const now = new Date();
  for (let i = 0; i <= 3; i++) {
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    await this.em.execute('SELECT audit.create_monthly_partition(?)', [month]);
  }
}
```

Alert on the tripwire — it is not a destination:

```sql
SELECT count(*) FROM audit.logged_actions_default;  -- expected: 0
```

**Run the hardening script, as a superuser, once per environment.** Until it does, the application role owns the audit table and can rewrite it, so the tamper-resistance does not hold yet.

```ts
import { getHardeningScript } from '@fath57/activity-log/migrations';

console.log(getHardeningScript('my_app_user', 'audit_admin'));
```

It is not part of the migration on purpose: `CREATE ROLE` and `ALTER … OWNER TO` need privileges your migration role should not have.

---

## Using it

```ts
// Read the feed
const page = await this.activityQuery.findForSubject('Invoice', invoice.id, { limit: 20 });
page.data;        // ActivityLog[]
page.nextCursor;  // pass back as { cursor }

// Log a business event by hand — returns the ActivityRecord it wrote
await this.activityLogger
  .performedOn(invoice)
  .withEvent('validated')
  .log('Invoice validated with an exceptional discount');

// Silence the feed for a batch. The audit trail keeps recording.
await this.activityLogger.withoutLogs(() => this.importTenThousandInvoices());

// Read the audit trail
await this.auditQuery.findForRow('public', 'invoices', invoice.id);
```

### Per-entity options

`@LogsActivity()` takes eight, all optional.

| Option | Default | Effect |
| :--- | :--- | :--- |
| `logName` | `'default'` | Which feed this entity writes to |
| `events` | all three | Which lifecycle events produce an entry |
| `logOnly` | — | Whitelist of attributes kept in `properties` |
| `logExcept` | — | Blacklist; ignored when `logOnly` is set |
| `logOnlyDirty` | `true` | On update, keep only what changed |
| `dontSubmitEmptyLogs` | `true` | Drop an update whose `properties` came out empty |
| `softDeleteField` | `'deletedAt'` | Field whose first non-null value means `deleted` |
| `description` | `` `${entityName} ${event}` `` | Formats the text |

For options that depend on the row, implement `LogsActivityInterface` and return `LogOptions.partial()…toPartial()`. Precedence is per field, highest first: the entity's `getActivitylogOptions()`, then the decorator, then `FeedModule.forRoot()`.

---

## Things that will bite you

**The feed does not see `em.nativeUpdate()`, the QueryBuilder, or raw SQL.** No ORM event fires. That is exactly why the audit module exists; for the user-facing feed, log those explicitly with `ActivityLogger`.

**Attribution needs a transaction.** `changed_by` comes from a transaction-local setting. A write outside a MikroORM-managed transaction is recorded but unattributed.

**`description` receives the entity that changed**, not the one you had in mind — decorate `PostVersion` and you get a `PostVersion`. The option is typed `(event, entity: any)`, so a wrong annotation compiles and reads `undefined`. Read scalar columns only; a relation is a proxy.

**Under PgBouncer transaction pooling**, `session_user` and `client_addr` become the pooler's. The `SET LOCAL` attribution still works; the engine-provided columns do not.

**GDPR erasure is pseudonymisation, not deletion** — `anonymizeSubject` from `/migrations`. The trail is meant to resist rewriting.

---

## Development

```bash
npm run db:up            # throwaway PostgreSQL 16 on :55432
npm test                 # 212 tests: unit + integration
npm run db:down
```

CI runs the suite against four combinations of NestJS 10/11/12 and MikroORM 6/7, as far as `@mikro-orm/nestjs` allows them to be paired. The matrix is the peer range.

- [`SPECIFICATION.md`](./SPECIFICATION.md) — architecture, threat model, SQL, ports
- [`SPECIFICATION-REVIEW.md`](./SPECIFICATION-REVIEW.md) — review rounds, findings traced to resolutions
- [`examples/nestjs-invoices`](./examples/nestjs-invoices) — a runnable application

A second ORM adapter implements the four ports in `core/ports` and passes `tests/conformance/` unmodified; nothing else changes.

## License

MIT
