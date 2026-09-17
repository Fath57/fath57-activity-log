# Technical Specification: Decoupled Activity Feed and Database Audit Trail
## Package: `fath-activity-log`

> **Revision 4** — incorporates the resolutions of review rounds 1–3. See `SPECIFICATION-REVIEW.md` for the finding-by-finding traceability table.

---

## 1. Executive Summary & Threat Model

This specification defines the architecture, packaging, performance characteristics and verification strategy for **`fath-activity-log`**, a production-grade, reusable **npm package** for **NestJS (v10/v11)**, **MikroORM (v6)** and **PostgreSQL (v13+)**.

The package provides two deliberately decoupled modules with distinct responsibilities and operational guarantees:

1. **Business Activity Feed (`FeedModule`)** — an application-level, user-facing timeline (e.g. *"Sarah approved invoice #INV-2026-0042"*). Inspired by `spatie/laravel-activitylog`: declarative entity decorators (`@LogsActivity`), runtime options (`LogOptions`), automated lifecycle tracking through a MikroORM `EventSubscriber` (dirty-checking, attribute filtering, prototype-traversing metadata cache), and a fluent API for arbitrary business milestones.
2. **System Audit Trail (`AuditModule`)** — a database-level, high-integrity record of every mutation against audited tables, implemented with PostgreSQL PL/pgSQL triggers (`audit.log_change()`). It captures all DML, including direct SQL, migrations, and raw ORM operations (`em.nativeUpdate()`). User attribution is carried transaction-locally through `SET LOCAL app.current_user_id`.

> [!NOTE]
> **This document specifies the MikroORM + PostgreSQL profile**, which is the reference implementation and the only one shipped in v1. The two modules have very different portability characteristics — the feed is adapter-bound, the audit trail is engine-bound — and §11 defines the seams, the capability matrix, and what a second profile would and would not preserve. Sections 4, 5, 7 and 8 are profile-specific; §11 marks which parts are.

### 1.1. Threat Model & Integrity Scope — PostgreSQL Profile

> The guarantees below are properties of the PostgreSQL implementation, not of the package. §11.3 gives the equivalent table for every other engine considered; several rows degrade to **not achievable**.

| Vector | Business Activity Feed | System Audit Trail |
| :--- | :--- | :--- |
| **`em.nativeUpdate()` / QueryBuilder** | **Bypassed by design** (no ORM lifecycle events). | **Recorded.** Attribution present only when executed inside `em.transactional()`, or under `sessionBinding: 'eager'` — otherwise `changed_by IS NULL`. See §5.6. |
| **Raw SQL / psql / migrations** | **Bypassed by design.** | **Recorded** (triggers run in-engine). Attribution absent unless the session sets `app.current_user_id` itself. |
| **Application bugs / crashes** | Follows the transaction; rolls back on failure. | Follows the transaction; rolls back on failure. |
| **Tampering by the application DB role** | App has full CRUD on `activity_logs`. | **Resistant.** App role holds `SELECT` only, on the parent **and on every partition** (§5.8). Writes occur solely through the `SECURITY DEFINER` trigger. |
| **Audit suppression (`audit.disabled`)** | n/a (`withoutLogs()` is in-process, no integrity claim). | **Resistant, fail-closed.** The bypass requires membership in `audit_bypass`. A denied attempt is itself recorded (`bypass_attempted = true`). See §5.3. |
| **Tampering by a superuser / DBA** | Modifiable. | Modifiable (a DBA can drop triggers or delete rows). **Out of scope** — ship audit rows to an append-only external sink if this vector matters. |
| **User attribution forgery** | Reflects the JWT / `RequestContext`. | `changed_by` is application-declared and therefore forgeable by application code. `session_user_name` and `client_addr` are engine-provided — **but see the PgBouncer caveat below**. |

> [!WARNING]
> **PgBouncer caveat.** Under transaction pooling, `SESSION_USER` is the pooler's login role and `inet_client_addr()` is the pooler's address — both become constants shared by all application users. In that topology the engine-provided columns carry **no** per-user attribution, and `pg_has_role(SESSION_USER, 'audit_bypass', …)` is all-or-nothing for the whole application. Deployments that need per-user forensics at the database level must connect directly, or use one pooler login role per trust level.

---

## 2. NPM Package Architecture & Consumer Integration

### 2.1. Package Identity & Build Strategy

- **Name**: `fath-activity-log`
- **Targets (v1 profile)**: Node.js >= 20.0.0 · NestJS >= 10.0.0 · MikroORM >= 6.0.0 · PostgreSQL >= 13.0
- **Core targets**: Node.js >= 20.0.0 · NestJS >= 10.0.0. The core carries no ORM or driver dependency — see §11.
- **Compiler**: the official TypeScript compiler (`tsc`), `declaration: true`, `declarationMap: true`.

  > [!IMPORTANT]
  > `tsup` and `esbuild` are deliberately excluded: esbuild does not implement `emitDecoratorMetadata`, which this package requires for MikroORM and NestJS reflection. Vitest must be configured with `unplugin-swc` for the same reason — otherwise the build succeeds while the tests observe empty metadata.

- **Module format: CommonJS only.** `"type": "commonjs"`, one `dist/**/*.js` per entrypoint.

  > [!IMPORTANT]
  > A dual CJS/ESM build is **rejected by design**. `ActivityMetadataStorage` is a module-level singleton; under a dual build a host application can load both formats and end up with **two registries**, so entities decorated through one are invisible to the subscriber resolving through the other. This is the dual-package hazard, and it is silent. ESM consumers `import` the CommonJS build through Node's interop, which exposes the named exports via `cjs-module-lexer`.

- **`peerDependencies`** — the core requires only NestJS and `reflect-metadata`. Adapter peers are declared **optional** so a future TypeORM or MySQL consumer does not install MikroORM.
  - `@nestjs/common`: `^10.0.0 || ^11.0.0`
  - `@nestjs/core`: `^10.0.0 || ^11.0.0`
  - `@mikro-orm/core`: `^6.0.0`
  - `@mikro-orm/postgresql`: `^6.0.0`
  - `@mikro-orm/nestjs`: `^6.0.0`
  - `reflect-metadata`: `^0.1.13 || ^0.2.0`
- **`peerDependenciesMeta`**: `@mikro-orm/core`, `@mikro-orm/postgresql`, `@mikro-orm/nestjs`, `@mikro-orm/migrations` are all `{ optional: true }`.

  > [!NOTE]
  > Optional does not mean unnecessary: `fath-activity-log/mikro-orm` throws at bootstrap with an actionable message when its peers are absent. It means the dependency belongs to the *adapter* you chose, not to the package.
- **`dependencies`**: *none* — `crypto.randomUUID()` replaces `uuid`.

- **Manifest**

  ```json
  {
    "type": "commonjs",
    "license": "MIT",
    "sideEffects": false,
    "engines": { "node": ">=20.0.0" },
    "files": ["dist", "README.md", "LICENSE"],
    "publishConfig": { "access": "public" },
    "exports": {
      ".":            { "types": "./dist/index.d.ts",             "default": "./dist/index.js" },
      "./feed":       { "types": "./dist/feed/index.d.ts",        "default": "./dist/feed/index.js" },
      "./audit":      { "types": "./dist/audit/index.d.ts",       "default": "./dist/audit/index.js" },
      "./mikro-orm":  { "types": "./dist/adapters/mikro-orm/index.d.ts", "default": "./dist/adapters/mikro-orm/index.js" },
      "./postgres":   { "types": "./dist/adapters/postgres/index.d.ts",  "default": "./dist/adapters/postgres/index.js" },
      "./migrations": { "types": "./dist/migrations/index.d.ts",  "default": "./dist/migrations/index.js" }
    }
  }
  ```

### 2.2. Consumer Application Registration

```ts
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
// Core: ORM- and engine-agnostic.
import {
  FeedModule,
  AuditModule,
  RequestContextModule,
  RequestContextInterceptor,
} from 'fath-activity-log';

// Adapter: binds the core ports to MikroORM + PostgreSQL. Swapping this line
// is what a second profile would replace — see §11.
import { MikroOrmActivityAdapter, ActivityLog, ActivityOutbox, LoggedAction }
  from 'fath-activity-log/mikro-orm';

@Module({
  imports: [
    MikroOrmModule.forFeature([ActivityLog, ActivityOutbox, LoggedAction]),

    RequestContextModule.forRoot({
      userExtractor: (req) => ({
        userId: req.user?.id ?? req.user?.sub,
        userEmail: req.user?.email,
        tenantId: req.user?.tenantId,
      }),
    }),

    FeedModule.forRoot({
      adapter: MikroOrmActivityAdapter,  // provides ChangeCapture + ActivityStore (§11.1)
      defaultLogName: 'default',
      defaultCauserType: 'User',
      flushMode: 'sync',                 // 'sync' | 'outbox'  — see §4.8
      generatedIdStrategy: 'resolve',    // 'resolve' | 'skip' — see §4.5
      softDeleteField: 'deletedAt',      // per-entity override via @LogsActivity
    }),

    AuditModule.forRoot({
      adapter: MikroOrmActivityAdapter,  // provides SessionBinder (§11.1)
      sessionVariableName: 'app.current_user_id',
      captureClientQuery: false,         // off by default: current_query() contains literals
      sessionBinding: 'eager',           // 'eager' | 'lazy' — see §5.6
    }),
  ],
  providers: [
    // Interceptors run AFTER guards, so req.user is populated. A middleware would not be.
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
  ],
})
export class AppModule {}
```

> [!NOTE]
> Exclude the audit schema from MikroORM's `SchemaGenerator` — it is partitioned and owned by migrations:
> `schemaGenerator: { ignoreSchema: ['audit'] }`.

### 2.3. Non-HTTP Contexts

`RequestContextInterceptor` covers HTTP only. Queue workers, cron jobs, microservice transports, GraphQL subscriptions, CLI scripts and seeders must open a context explicitly, or both modules will record unattributed events:

```ts
await this.requestContext.runWith(
  { userId: 'system:invoice-cron', causerType: 'System', tenantId },
  async () => {
    await this.processOverdueInvoices();
  },
);
```

`runWith()` is the single primitive; `RequestContextInterceptor` is a thin wrapper over it.

---

## 3. High-Level Architecture

```mermaid
flowchart TD
    subgraph Client ["Client / Request"]
        Req["HTTP Request (JWT / Session)"]
    end

    subgraph HostApp ["Consumer NestJS Application"]
        Guard["AuthGuard (populates req.user)"]
        RCI["RequestContextInterceptor\n(AsyncLocalStorage via runWith)"]
        Ctrl["Controller"]
        Svc["Domain Service (e.g. InvoiceService)"]
        FeedSub["FeedModule: ActivitySubscriber\n(onFlush + afterFlush)"]
        AuditSub["AuditModule: AuditSessionSubscriber\n(eager or lazy set_config)"]
        UoW["MikroORM UnitOfWork"]
    end

    subgraph PostgreSQL ["PostgreSQL Database"]
        FeedTable[("public.activity_logs")]
        OutboxTable[("public.activity_outbox\n(flushMode = outbox)")]
        BizTable[("public.invoices\n(audited)")]
        TrigIUD{"audit_trigger_invoices_iud\nAFTER INSERT OR DELETE"}
        TrigU{"audit_trigger_invoices_u\nAFTER UPDATE WHEN OLD IS DISTINCT FROM NEW"}
        AuditTable[("audit.logged_actions\nPARTITION BY RANGE (changed_at)")]
    end

    Req --> Guard --> RCI --> Ctrl --> Svc --> UoW

    UoW -.->|afterTransactionStart / first flush| AuditSub
    AuditSub -->|SELECT set_config('app.current_user_id', id, true)| BizTable

    UoW -.->|onFlush: @LogsActivity cache| FeedSub
    FeedSub --> UoW
    UoW -->|INSERT| FeedTable
    UoW -->|INSERT| OutboxTable
    UoW -->|INSERT / UPDATE / DELETE| BizTable

    BizTable --> TrigIUD --> AuditTable
    BizTable --> TrigU --> AuditTable
```

---

## 4. Module 1: Business Activity Feed (`FeedModule`)

### 4.1. Entity Definition: `ActivityLog`

Indexes lead with `tenantId` so that multi-tenant reads prune before scanning, and a dedicated `createdAt` index supports retention (§4.7).

```ts
import { Entity, PrimaryKey, Property, Index } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';

@Entity({ tableName: 'activity_logs' })
@Index({ name: 'idx_activity_logs_subject', properties: ['tenantId', 'subjectType', 'subjectId', 'createdAt'] })
@Index({ name: 'idx_activity_logs_causer',  properties: ['tenantId', 'causerType', 'causerId', 'createdAt'] })
@Index({ name: 'idx_activity_logs_feed',    properties: ['tenantId', 'logName', 'createdAt'] })
@Index({ name: 'idx_activity_logs_created', properties: ['createdAt'] })
export class ActivityLog {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property({ length: 100 })
  logName: string = 'default';

  /** Rendered fallback. Prefer `event` + `properties` for i18n — see §4.6. */
  @Property({ type: 'text' })
  description!: string;

  @Property({ length: 150, nullable: true })
  subjectType?: string;

  @Property({ length: 100, nullable: true })
  subjectId?: string;

  @Property({ length: 150, nullable: true })
  causerType?: string;

  @Property({ length: 100, nullable: true })
  causerId?: string;

  @Property({ length: 50, nullable: true })
  event?: 'created' | 'updated' | 'deleted' | (string & {});

  @Property({ type: 'jsonb', nullable: true })
  properties?: Record<string, any>;

  @Property({ length: 100, nullable: true })
  tenantId?: string;

  @Property({ type: 'timestamptz' })
  createdAt: Date = new Date();
}
```

### 4.2. Configuration Precedence & Options

```
[1. entity.getActivitylogOptions()]   Instance dynamic override — highest
                │
[2. @LogsActivity({...})]             Class decorator, static
                │
[3. FeedModule.forRoot({...})]        Module defaults — lowest
```

The merge is a **property-level fallback**, and for it to be well-defined every level must be able to express *"not specified"*. All three therefore contribute a **partial** shape:

```ts
export interface ActivityOptionsConfig {
  logName?: string;
  events?: Array<'created' | 'updated' | 'deleted' | (string & {})>;
  logOnly?: string[];
  logExcept?: string[];
  logOnlyDirty?: boolean;
  dontSubmitEmptyLogs?: boolean;
  softDeleteField?: string | false;
  description?: (event: string, entity: any) => string;
}

/**
 * Canonical registration. The decorator below is sugar over this call.
 *
 * Kept as the primitive on purpose: class decorators presuppose class-based
 * entities, which MikroORM, TypeORM and Sequelize have but Prisma and Drizzle
 * do not. Any adapter for a schema-first ORM registers through this function.
 * Making the decorator primary would close that door permanently (§11.2).
 */
export function registerActivity(
  target: Function | string,
  options?: ActivityOptionsConfig,
): void;

/** Sugar: `@LogsActivity(o)` === `registerActivity(TargetClass, o)`. */
export function LogsActivity(options?: ActivityOptionsConfig): ClassDecorator;

export interface LogsActivityInterface {
  /** MUST return a partial. `LogOptions.toPartial()` produces one. */
  getActivitylogOptions(): Partial<ActivityOptionsConfig>;
}
```

**Bootstrap validation.** `FeedModule.forRoot()` refuses a configuration the adapter cannot honour, rather than letting it degrade in silence:

```ts
FeedModule.forRoot({
  adapter: someAdapter,      // capture.providesBeforeState === false
  logOnlyDirty: true,
});
// Error: FeedModule was configured with logOnlyDirty: true, but the "…" adapter
// reports providesBeforeState: false — it cannot supply the pre-mutation state
// without an extra read per mutation.
```

The failure this prevents is not a crash. `logOnlyDirty` on an adapter with no cheap before-state does not stop working: it starts logging every attribute on every update, or paying a read-before-write per mutation. The feed keeps producing rows either way, and nobody notices until the storage bill or a leaked attribute says otherwise. A binder declaring `scope: 'session'` likewise draws a warning, since on a pooled connection its attribution survives `COMMIT`. Covered by `module-adapter-wiring.spec.ts`.

> [!IMPORTANT]
> `LogOptions.defaults()` populates every field. Returning it directly from `getActivitylogOptions()` would silently override both lower levels. `LogOptions` therefore tracks which fields were explicitly set and exposes `toPartial()`, which emits only those. Returning a fully-populated object is a valid but total override, and the metadata storage logs a warning at bootstrap when it detects one.

### 4.3. Fluent Configuration Builder: `LogOptions`

```ts
export class LogOptions {
  static defaults(): LogOptions;
  useLogName(logName: string): this;
  logOnly(attributes: string[]): this;
  logExcept(attributes: string[]): this;
  logAll(): this;
  logOnlyDirty(onlyDirty?: boolean): this;
  dontSubmitEmptyLogs(dontSubmit?: boolean): this;
  useSoftDeleteField(field: string | false): this;
  setDescriptionForEvent(formatter: (event: string, entity: any) => string): this;

  /** Only the fields explicitly set on this instance. Use this in getActivitylogOptions(). */
  toPartial(): Partial<ActivityOptionsConfig>;
}
```

### 4.4. Automated Lifecycle Tracking: `ActivitySubscriber`

1. **Zero runtime reflection, inheritance-aware.** `ActivityMetadataStorage` keys configuration by constructor reference (`Map<Function, ResolvedActivityOptions>`) and resolves by walking the prototype chain (`Object.getPrototypeOf`), so Single Table Inheritance and abstract base entities are supported without reflection cost and without minification collisions.
2. Subscribes to `onFlush(args: FlushEventArgs)` and `afterFlush(args: FlushEventArgs)`.
3. Fast-filters `uow.getChangeSets()`, discarding any entity whose prototype chain is absent from the registry.
4. Resolves causer, user id and tenant id from `RequestContextService`.
5. **Soft-delete detection.** When `softDeleteField` is configured (default `'deletedAt'`, disable with `false`) and an `UPDATE` moves it from `null` to a value, the event is classified `'deleted'` rather than `'updated'`.

### 4.5. Primary Key Resolution — Defined Behaviour

`onFlush` runs **before** the `INSERT`, so a database-generated key does not exist yet. The behaviour is explicit, not left to a recommendation:

| Key kind | Behaviour |
| :--- | :--- |
| Client-assigned (UUID, ULID, NanoID) | `subjectId` is populated synchronously in `onFlush`. **Recommended.** |
| DB-generated (`SERIAL` / `IDENTITY`), `generatedIdStrategy: 'resolve'` *(default)* | `onFlush` stages the `ActivityLog` with `subjectId = null`; `afterFlush` issues **one batched `UPDATE`** resolving every staged id. |
| DB-generated, `generatedIdStrategy: 'skip'` | `subjectId` stays `null` on `'created'` events. No extra round-trip. |

> [!WARNING]
> **Atomicity boundary.** MikroORM emits `afterFlush` *after* the flush has committed. With an implicit flush (`em.flush()` outside `em.transactional()`), the resolving `UPDATE` therefore runs in a **separate transaction**: a subsequent failure can leave an `ActivityLog` whose `subjectId` is `null`. The `'sync'` atomicity guarantee of §6 holds unconditionally for client-assigned keys, and for DB-generated keys **only inside `em.transactional()`**. `auto-generated-pk.integration.spec.ts` asserts both branches, including rollback.

### 4.6. Descriptions and i18n

`description` is a **rendered fallback**, not the canonical record. It is frozen at write time: it cannot be re-rendered when business wording changes, and it cannot be localised per reader. The canonical payload is `event` + `properties`; consumers building a user-facing timeline should render from those and treat `description` as a degraded fallback for ad-hoc feeds. This is an inherited weakness of the spatie design, stated here rather than discovered later.

### 4.7. Kill-Switch, Manual Logger, and Read API

```ts
// Suppress feed logging (in-process, AsyncLocalStorage-scoped).
// This does NOT suppress the database audit trail — see §5.3 for that.
await this.activityService.withoutLogs(async () => {
  await this.seedDatabase();
});

await this.activityLogger
  .performedOn(invoice)
  .causedBy(currentUser)            // defaults to RequestContext
  .withEvent('validated')
  .inLog('billing')
  .withProperties({ totalAmount: invoice.total, discountRate: 0.15 })
  .log('Facture validée avec escompte exceptionnel');
```

Reads use **keyset pagination**: the composite indexes of §4.1 support it natively, and `COUNT(*)` over a feed degrades linearly with depth. Counting is opt-in.

```ts
export interface CursorPage<T> {
  data: T[];
  /** Opaque (createdAt, id) cursor. null when exhausted. */
  nextCursor: string | null;
}

export interface FeedQueryOptions {
  /** Defaults to RequestContext.tenantId. Pass `null` to query across tenants (admin only). */
  tenantId?: string | null;
  limit?: number;
  cursor?: string;
}

/**
 * A thin wrapper over the `ActivityReader` port. It adds exactly one thing:
 * resolving the ambient tenant from the request context. Pagination, counting
 * and pruning live in the port, so there is one implementation rather than two
 * that drift — and so the port has a real caller rather than only a test.
 */
export class ActivityQueryService {
  findForSubject(subjectType: string, subjectId: string, opts?: FeedQueryOptions): Promise<CursorPage<ActivityLog>>;
  findForCauser(causerType: string, causerId: string, opts?: FeedQueryOptions): Promise<CursorPage<ActivityLog>>;
  findFeed(logName?: string, opts?: FeedQueryOptions): Promise<CursorPage<ActivityLog>>;

  /** Opt-in: a full COUNT over the matching index range. */
  countForSubject(subjectType: string, subjectId: string, opts?: FeedQueryOptions): Promise<number>;
  countForCauser(causerType: string, causerId: string, opts?: FeedQueryOptions): Promise<number>;

  /**
   * Retention. Deletes in bounded batches (default 10 000) with a commit between
   * each, backed by idx_activity_logs_created. Returns the number of rows removed.
   */
  prune(olderThan: Date, opts?: { batchSize?: number }): Promise<number>;
}
```

> [!IMPORTANT]
> **Tenant isolation is enforced by default.** Every read resolves `tenantId` from `RequestContextService` unless the caller passes it explicitly. `tenantId: null` performs a cross-tenant query and is intended for back-office use; `tenant-isolation.integration.spec.ts` asserts that the default path never returns another tenant's rows.

> [!NOTE]
> **Feed retention and GDPR.** `activity_logs.properties` and `description` routinely hold personal data, and the application role has full CRUD on this table (§1.1) — it is the *less* protected of the two stores. `prune()` is the baseline. Deployments above roughly 10⁸ rows should partition `activity_logs` by month with the same helpers as §5.5 and purge by `DROP TABLE`, which is bounded work where a mass `DELETE` is not.

### 4.8. `flushMode`: `sync` vs `outbox`

| Mode | Semantics |
| :--- | :--- |
| `'sync'` *(default)* | `ActivityLog` rows are written inside the business transaction. Atomic rollback, at the cost of the extra `INSERT` on the critical path. |
| `'outbox'` | The subscriber writes to `activity_outbox` **in the same transaction**, so a rollback discards the intent. A background drainer moves rows into `activity_logs` and deletes them. |

```ts
@Entity({ tableName: 'activity_outbox' })
@Index({ name: 'idx_activity_outbox_pending', properties: ['createdAt'] })
export class ActivityOutbox {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @Property({ type: 'jsonb' })
  payload!: Record<string, any>;   // serialised ActivityLog

  @Property({ type: 'timestamptz' })
  createdAt: Date = new Date();

  @Property({ type: 'integer' })
  attempts: number = 0;
}
```

**Drainer contract** — `ActivityOutboxDrainer`, a `@Cron`-driven provider the host registers explicitly:

```sql
DELETE FROM activity_outbox
WHERE id IN (SELECT id FROM activity_outbox ORDER BY created_at LIMIT :batch FOR UPDATE SKIP LOCKED)
RETURNING *;
-- rows are inserted into activity_logs in the same transaction
```

`FOR UPDATE SKIP LOCKED` makes concurrent drainers safe. Delivery is **at-least-once**: a crash between the `INSERT` and the `COMMIT` replays the batch, so `ActivityLog.id` is carried in the payload and insertion is `ON CONFLICT (id) DO NOTHING` — making the drain idempotent. `outbox-drainer.integration.spec.ts` asserts rollback discards intents, that a replayed batch produces no duplicate, and that concurrent drainers do not double-write.

---

## 5. Module 2: System Audit Trail (`AuditModule`) — PostgreSQL Reference Implementation

> [!IMPORTANT]
> This entire section is **profile-specific and intentionally so**. The value of the audit trail is precisely the triplet trigger + `SECURITY DEFINER` + `SET LOCAL`; an abstraction that made it portable would remove what justifies it. A second engine is a re-implementation with its own guarantee table, not an adapter over this one. See §11.3.

### 5.1. Database Schema: Partitioned `audit.logged_actions`

```sql
CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE audit.logged_actions (
    event_id          BIGSERIAL,
    schema_name       TEXT NOT NULL,
    table_name        TEXT NOT NULL,
    -- Scalar for a single-column PK; canonical JSON object for a composite one. See §5.4.
    row_id            TEXT NOT NULL,
    row_id_is_json    BOOLEAN NOT NULL DEFAULT false,
    action            CHAR(1) NOT NULL CHECK (action IN ('I', 'U', 'D')),
    old_data          JSONB,
    new_data          JSONB,
    changed_fields    JSONB,
    -- Application-declared, therefore forgeable by application code.
    changed_by        TEXT,
    -- Engine-provided. Constant under PgBouncer transaction pooling (see §1.1).
    session_user_name TEXT NOT NULL DEFAULT SESSION_USER,
    client_addr       INET DEFAULT inet_client_addr(),
    -- True when a caller asked for audit.disabled without holding audit_bypass.
    bypass_attempted  BOOLEAN NOT NULL DEFAULT false,
    client_query      TEXT,
    transaction_id    XID8 NOT NULL DEFAULT pg_current_xact_id(),
    changed_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (event_id, changed_at)
) PARTITION BY RANGE (changed_at);

-- Safety net only. It must stay EMPTY in steady state: see §5.5.
CREATE TABLE IF NOT EXISTS audit.logged_actions_default
    PARTITION OF audit.logged_actions DEFAULT;

-- Keeps the DEFAULT-conflict probe of create_monthly_partition() off a sequential scan.
CREATE INDEX IF NOT EXISTS idx_logged_actions_default_time
    ON audit.logged_actions_default (changed_at);

CREATE INDEX idx_logged_actions_target ON audit.logged_actions (schema_name, table_name, row_id);
CREATE INDEX idx_logged_actions_user   ON audit.logged_actions (changed_by) WHERE changed_by IS NOT NULL;
```

> [!NOTE]
> `current_user_name` was removed in revision 4. Inside a `SECURITY DEFINER` function `CURRENT_USER` resolves to the function **owner**, so the column recorded `audit_admin` on every row and carried no information. `SESSION_USER` is unaffected by `SECURITY DEFINER` and is retained.

> [!NOTE]
> `changed_at` uses `clock_timestamp()`, so rows are ordered by *statement* time, not commit order. Concurrent transactions interleave; use `transaction_id` to group and order a single transaction's effects.

### 5.2. Roles

Two roles, deliberately disjoint. Conflating them would mean that granting a batch job the right to skip auditing also grants it ownership of the audit table.

| Role | Grants | Given to |
| :--- | :--- | :--- |
| `audit_admin` | Owns the schema, the functions, the parent table and every partition. | DBAs only; never a connection role. |
| `audit_bypass` | Membership alone authorises `SET LOCAL audit.disabled`. No table rights. | Named batch / seed accounts. |

Both are created (empty, `NOLOGIN`) by the package migration so the trigger's fail-closed check has something to test against; membership is granted only by the hardening script of §5.8.

### 5.3. Trigger Function: `audit.log_change()`

```sql
CREATE OR REPLACE FUNCTION audit.log_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_old_data       JSONB := NULL;
    v_new_data       JSONB := NULL;
    v_diff           JSONB := NULL;
    v_data           JSONB;
    v_row_id         TEXT;
    v_row_id_is_json BOOLEAN := false;
    v_pk_cols        TEXT[]  := COALESCE(TG_ARGV[0]::TEXT[], ARRAY['id']::TEXT[]);
    v_ignored_cols   TEXT[]  := COALESCE(TG_ARGV[1]::TEXT[], ARRAY[]::TEXT[]);
    v_capture_query  BOOLEAN := COALESCE(TG_ARGV[2]::BOOLEAN, false);
    v_query          TEXT := NULL;
    v_bypass_denied  BOOLEAN := false;
    v_may_bypass     BOOLEAN := false;
BEGIN
    -------------------------------------------------------------------------
    -- Bypass switch. FAIL-CLOSED: absence of configuration denies the bypass.
    -------------------------------------------------------------------------
    IF LOWER(COALESCE(current_setting('audit.disabled', true), 'off')) IN ('on', '1', 'true') THEN
        BEGIN
            v_may_bypass := pg_has_role(SESSION_USER, 'audit_bypass', 'MEMBER');
        EXCEPTION WHEN undefined_object THEN
            -- Role absent (hardening never applied): refuse and keep auditing.
            v_may_bypass := false;
        END;

        IF v_may_bypass THEN
            IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
        END IF;

        -- Denied. Fall through and audit the mutation, flagging the attempt.
        v_bypass_denied := true;
    END IF;

    IF v_capture_query THEN
        -- current_query() contains literals: off by default, truncated when on.
        v_query := left(current_query(), 2048);
    END IF;

    IF (TG_OP = 'INSERT') THEN
        v_new_data := to_jsonb(NEW) - v_ignored_cols;
        v_data     := v_new_data;

    ELSIF (TG_OP = 'UPDATE') THEN
        v_old_data := to_jsonb(OLD) - v_ignored_cols;
        v_new_data := to_jsonb(NEW) - v_ignored_cols;
        v_data     := v_new_data;

        SELECT jsonb_object_agg(n.key, n.value)
        INTO   v_diff
        FROM   jsonb_each(v_new_data) n
        WHERE  n.value IS DISTINCT FROM (v_old_data -> n.key);

        -- Only ignored columns changed (e.g. updated_at): nothing to record.
        IF v_diff IS NULL OR v_diff = '{}'::jsonb THEN
            RETURN NEW;
        END IF;

    ELSIF (TG_OP = 'DELETE') THEN
        v_old_data := to_jsonb(OLD) - v_ignored_cols;
        v_data     := v_old_data;
    END IF;

    -------------------------------------------------------------------------
    -- Row identity. Single column -> scalar. Composite -> canonical JSON object
    -- (jsonb normalises key order, so the value is deterministic and indexable).
    -------------------------------------------------------------------------
    IF array_length(v_pk_cols, 1) = 1 THEN
        v_row_id := v_data ->> v_pk_cols[1];
    ELSE
        SELECT jsonb_object_agg(k, v_data -> k)::text
        INTO   v_row_id
        FROM   unnest(v_pk_cols) k;
        v_row_id_is_json := true;
    END IF;

    -- Fail loudly: a wrong pk_columns would otherwise yield a whole audit trail
    -- of placeholder identifiers with no signal. audit.track_table() validates
    -- this up front; this is the last line of defence.
    IF v_row_id IS NULL THEN
        RAISE EXCEPTION
            'audit: primary key %(s) not present in the %.% payload — check pk_columns / ignored_columns',
            v_pk_cols, TG_TABLE_SCHEMA, TG_TABLE_NAME
            USING ERRCODE = 'undefined_column';
    END IF;

    INSERT INTO audit.logged_actions (
        schema_name, table_name, row_id, row_id_is_json, action,
        old_data, new_data, changed_fields,
        changed_by, bypass_attempted, client_query, changed_at
    ) VALUES (
        TG_TABLE_SCHEMA, TG_TABLE_NAME, v_row_id, v_row_id_is_json, SUBSTRING(TG_OP, 1, 1),
        v_old_data, v_new_data, v_diff,
        NULLIF(current_setting('app.current_user_id', true), ''),
        v_bypass_denied, v_query, clock_timestamp()
    );

    IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION audit.log_change() FROM PUBLIC;
```

> [!IMPORTANT]
> Revoking `EXECUTE` after the triggers exist is safe: PostgreSQL checks `EXECUTE` on a trigger function at `CREATE TRIGGER` time, not on each firing.

### 5.4. Table Activation: `audit.track_table()`

Two triggers, because a single `AFTER INSERT OR UPDATE OR DELETE` trigger cannot carry a `WHEN` clause referencing `OLD`/`NEW` — PostgreSQL forbids `OLD` on `INSERT` and `NEW` on `DELETE`.

```sql
CREATE OR REPLACE FUNCTION audit.track_table(
    target_table    REGCLASS,
    pk_columns      TEXT[]  DEFAULT ARRAY['id']::TEXT[],
    ignored_columns TEXT[]  DEFAULT ARRAY[]::TEXT[],
    capture_query   BOOLEAN DEFAULT false
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_table_name   TEXT;
    v_trigger_iud  TEXT;
    v_trigger_u    TEXT;
    v_bad          TEXT[];
BEGIN
    IF pk_columns IS NULL OR array_length(pk_columns, 1) IS NULL THEN
        RAISE EXCEPTION 'audit.track_table: pk_columns must not be empty';
    END IF;

    -- A PK column that is also ignored would strip row identity from the payload.
    SELECT array_agg(c) INTO v_bad
    FROM unnest(pk_columns) c WHERE c = ANY(ignored_columns);
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'audit.track_table: pk_columns and ignored_columns overlap on %', v_bad;
    END IF;

    -- Every PK column must actually exist on the target table.
    SELECT array_agg(c) INTO v_bad
    FROM unnest(pk_columns) c
    WHERE NOT EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = target_table
          AND a.attname = c AND a.attnum > 0 AND NOT a.attisdropped
    );
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'audit.track_table: column(s) % do not exist on %', v_bad, target_table;
    END IF;

    SELECT relname INTO v_table_name FROM pg_class WHERE oid = target_table;
    v_trigger_iud := 'audit_trigger_' || v_table_name || '_iud';
    v_trigger_u   := 'audit_trigger_' || v_table_name || '_u';

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s;', v_trigger_iud, target_table);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s;', v_trigger_u,   target_table);

    EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT OR DELETE ON %s
         FOR EACH ROW EXECUTE FUNCTION audit.log_change(%L, %L, %L);',
        v_trigger_iud, target_table, pk_columns, ignored_columns, capture_query);

    EXECUTE format(
        'CREATE TRIGGER %I AFTER UPDATE ON %s
         FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
         EXECUTE FUNCTION audit.log_change(%L, %L, %L);',
        v_trigger_u, target_table, pk_columns, ignored_columns, capture_query);
END;
$$;

REVOKE EXECUTE ON FUNCTION audit.track_table(REGCLASS, TEXT[], TEXT[], BOOLEAN) FROM PUBLIC;
```

> [!NOTE]
> The `WHEN (OLD.* IS DISTINCT FROM NEW.*)` guard is largely inert in ORM workloads, since `updated_at` / `version` change on every write. The effective de-duplication is the empty-`v_diff` early return in §5.3, which compares *after* ignored columns are stripped.

### 5.5. Partition Management

Two operations with deliberately different risk profiles. **Routine creation never takes a long lock; absorbing the DEFAULT partition always does.** Conflating them is what makes a missed cron escalate into an outage.

```sql
CREATE OR REPLACE FUNCTION audit.create_monthly_partition(p_date DATE)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET timezone = 'UTC'                 -- partition bounds must not depend on the caller's TimeZone
AS $$
DECLARE
    v_start     TIMESTAMPTZ := (date_trunc('month', p_date::timestamp))                    AT TIME ZONE 'UTC';
    v_end       TIMESTAMPTZ := (date_trunc('month', p_date::timestamp) + INTERVAL '1 month') AT TIME ZONE 'UTC';
    v_name      TEXT := 'logged_actions_' || to_char(v_start AT TIME ZONE 'UTC', 'YYYY_MM');
    v_conflicts BIGINT;
BEGIN
    IF to_regclass('audit.' || quote_ident(v_name)) IS NOT NULL THEN
        RETURN;                       -- idempotent
    END IF;

    SELECT count(*) INTO v_conflicts
    FROM   audit.logged_actions_default
    WHERE  changed_at >= v_start AND changed_at < v_end;

    IF v_conflicts > 0 THEN
        RAISE EXCEPTION
            'audit: % row(s) for % already landed in the DEFAULT partition. Creating % now '
            'would hold an ACCESS EXCLUSIVE lock on audit.logged_actions for the whole copy. '
            'Run the §5.5 absorption runbook during a maintenance window instead.',
            v_conflicts, to_char(v_start AT TIME ZONE 'UTC', 'YYYY-MM'), v_name
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    EXECUTE format(
        'CREATE TABLE audit.%I PARTITION OF audit.logged_actions FOR VALUES FROM (%L) TO (%L);',
        v_name, v_start, v_end);
    -- The partition inherits the function owner (audit_admin after §5.8), so the
    -- application role cannot reach it directly. No PUBLIC grants are created.
END;
$$;

REVOKE EXECUTE ON FUNCTION audit.create_monthly_partition(DATE) FROM PUBLIC;
```

**Mandatory operational requirement.** `create_monthly_partition()` must be invoked ahead of time, or every row lands in the DEFAULT partition and none of the partitioning benefits of §6 and §7 apply. The package migration (§8) pre-creates the current month plus three, and the host **must** schedule the monthly top-up:

```ts
@Cron('0 3 1 * *')                 // 03:00 UTC on the 1st
async ensureAuditPartitions(): Promise<void> {
  for (let i = 0; i <= 3; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    await this.em.execute('SELECT audit.create_monthly_partition(?)', [d]);
  }
}
```

**Alert on `audit.logged_actions_default` being non-empty.** That table is a tripwire, not a destination:

```sql
SELECT count(*) FROM audit.logged_actions_default;   -- expected: 0
```

**Absorption runbook (maintenance window, DBA).**

> [!WARNING]
> `DETACH PARTITION … CONCURRENTLY` is **not usable here**. PostgreSQL rejects it outright — `cannot detach partitions concurrently when a default partition exists` — for any partition of a table that has a DEFAULT partition, the default itself included. Verified in `partition-conflict.integration.spec.ts`. The runbook therefore uses a plain `DETACH`, and earns its safety a different way: **the expensive copy happens while the default is detached**, so the parent holds `ACCESS EXCLUSIVE` only for two catalog statements rather than for the duration of the copy.

```sql
-- Phase 1 — catalog only, no table scan. Short ACCESS EXCLUSIVE.
--   Both statements are in ONE transaction so no window exists in which an
--   uncovered month has neither a partition nor a DEFAULT to fall back on.
BEGIN;
  ALTER TABLE audit.logged_actions DETACH PARTITION audit.logged_actions_default;
  SELECT audit.create_monthly_partition('2026-09-01');
COMMIT;

-- Phase 2 — the expensive part, parent unlocked and accepting writes throughout.
INSERT INTO audit.logged_actions SELECT * FROM audit.logged_actions_default;
TRUNCATE audit.logged_actions_default;

-- Phase 3 — re-attach the (now empty) safety net. The attach scan is trivial.
ALTER TABLE audit.logged_actions ATTACH PARTITION audit.logged_actions_default DEFAULT;
```

Phase 1 works because the conflict probe in `create_monthly_partition()` is **attachment-aware**: only an *attached* default partition can hold conflicting rows, so the guard stands down once it is detached. That is what lets the runbook reuse the function instead of duplicating its DDL.

### 5.6. User Attribution via PostgreSQL Session

```ts
async afterTransactionStart(args: TransactionEventArgs): Promise<void> {
  if (this.options.sessionBinding !== 'eager') return;
  await this.bind(args);
}

private async bind(args: TransactionEventArgs): Promise<void> {
  const userId = this.requestContext.getUserId();
  if (!userId || this.bound.has(args.transaction)) return;

  // is_local = true scopes the setting to this transaction (SET LOCAL semantics),
  // and the transaction context MUST be passed explicitly -- see the warning below.
  await args.em.getConnection().execute(
    'SELECT set_config(?, ?, true)',
    [this.options.sessionVariableName, String(userId)],
    'all',
    args.transaction,
  );
  this.bound.add(args.transaction);
}
```

> [!WARNING]
> **The binding must be issued on the transaction's own connection.** `em.execute()` resolves a connection from the pool by itself, which is not necessarily the one the transaction holds. `set_config(..., is_local => true)` then applies to a *foreign* connection's implicit transaction and is discarded at the end of that statement — so every audit row is written with `changed_by` NULL, silently, while the trigger itself keeps working perfectly. Passing `args.transaction` as the execution context is what pins the statement to the right connection. Regression-guarded by `native-update-asymmetry.integration.spec.ts`.
>
> A failed binding must never abort the business transaction, but it must not be swallowed either: the subscriber logs a warning naming the variable it could not set. A silent `catch {}` here turns a broken audit trail into an invisible one.

| `sessionBinding` | Behaviour | Trade-off |
| :--- | :--- | :--- |
| `'eager'` *(default)* | Binds in `afterTransactionStart`. | One extra round-trip per transaction, **including read-only ones**. Attributes every write, `em.nativeUpdate()` and QueryBuilder included. |
| `'lazy'` | Binds on the first `onFlush` that carries change sets. | No cost on read-only transactions, but statements that never flush — `em.nativeUpdate()`, QueryBuilder — are recorded **without attribution**. |

The default is `'eager'`: correctness of the audit trail outweighs a round-trip on read paths.

Outside a MikroORM-managed transaction (autocommit `em.nativeUpdate()`), no hook fires under either mode and `changed_by` is `NULL`. The mutation is still recorded. Wrap such calls in `em.transactional()` when attribution matters.

**PgBouncer.** `is_local = true` means PostgreSQL clears the setting at `COMMIT`/`ROLLBACK`, so it is safe under transaction pooling and never leaks to the next borrower of the connection. `is_local = false` is forbidden. See §1.1 for what pooling costs in attribution fidelity.

### 5.7. Read-Only Query Entity: `LoggedAction`

```ts
import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ schema: 'audit', tableName: 'logged_actions', readonly: true })
export class LoggedAction {
  @PrimaryKey({ type: 'bigint' })     eventId!: string;
  @PrimaryKey({ type: 'timestamptz' }) changedAt!: Date;

  @Property() schemaName!: string;
  @Property() tableName!: string;

  /** Scalar when rowIdIsJson is false; a canonical JSON object otherwise. See §5.3. */
  @Property() rowId!: string;
  @Property() rowIdIsJson!: boolean;

  @Property({ length: 1 }) action!: 'I' | 'U' | 'D';

  @Property({ type: 'jsonb', nullable: true }) oldData?: Record<string, any>;
  @Property({ type: 'jsonb', nullable: true }) newData?: Record<string, any>;
  @Property({ type: 'jsonb', nullable: true }) changedFields?: Record<string, any>;

  @Property({ nullable: true }) changedBy?: string;
  @Property() sessionUserName!: string;
  @Property({ nullable: true }) clientAddr?: string;
  @Property() bypassAttempted!: boolean;
  @Property({ nullable: true }) clientQuery?: string;
  @Property({ type: 'string' }) transactionId!: string;   // xid8
}
```

`AuditQueryService` exposes `findForRow(schema, table, rowId)` and `findForTransaction(transactionId)`, and builds the composite `rowId` for callers so they never assemble the JSON form by hand.

### 5.8. Hardening Script — run by a DBA, not by the migration

> [!IMPORTANT]
> This script is **not** part of the package migration. `CREATE ROLE` and `ALTER … OWNER TO` require superuser or `CREATEROLE` plus membership in the target role — privileges the application's migration role must not hold. Shipping it inside `up()` guarantees it fails, or that the migration role is over-privileged. `getHardeningScript()` returns it as text for a DBA to review and run once, per environment.

```sql
-- Roles (the package migration creates them empty; this grants membership).
GRANT audit_bypass TO batch_importer;        -- named accounts only

-- Schema ownership FIRST. Without it the REVOKE below strips USAGE from
-- audit_admin as well -- it does not own the schema -- and every SECURITY DEFINER
-- function, log_change() included, loses access to its own schema. The symptom is
-- "permission denied for schema audit" on the first audited write after hardening,
-- i.e. auditing silently stops working the moment you secure it.
-- Caught by partition-privileges.integration.spec.ts.
ALTER SCHEMA   audit                                                   OWNER TO audit_admin;

-- Ownership: functions first, so partitions created later inherit audit_admin.
ALTER TABLE    audit.logged_actions                                    OWNER TO audit_admin;
ALTER TABLE    audit.logged_actions_default                            OWNER TO audit_admin;
ALTER FUNCTION audit.log_change()                                      OWNER TO audit_admin;
ALTER FUNCTION audit.track_table(REGCLASS, TEXT[], TEXT[], BOOLEAN)    OWNER TO audit_admin;
ALTER FUNCTION audit.create_monthly_partition(DATE)                    OWNER TO audit_admin;
ALTER FUNCTION audit.anonymize_subject_batch(TEXT, TEXT, TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INT)
                                                                       OWNER TO audit_admin;

-- Application role: read-only.
REVOKE ALL   ON SCHEMA audit           FROM PUBLIC;
GRANT  USAGE ON SCHEMA audit           TO   audit_admin;
GRANT  USAGE ON SCHEMA audit           TO   app_user;
REVOKE ALL   ON audit.logged_actions   FROM PUBLIC, app_user;
GRANT  SELECT ON audit.logged_actions  TO   app_user;

-- Existing partitions are separate relations: privileges on the parent govern access
-- THROUGH the parent, not direct access to a child. Apply explicitly.
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN
        SELECT c.oid::regclass AS part
        FROM   pg_inherits i
        JOIN   pg_class c ON c.oid = i.inhrelid
        WHERE  i.inhparent = 'audit.logged_actions'::regclass
    LOOP
        EXECUTE format('ALTER TABLE %s OWNER TO audit_admin;', r.part);
        EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, app_user;', r.part);
    END LOOP;
END $$;
```

Partitions created afterwards by `audit.create_monthly_partition()` inherit `audit_admin` automatically, because a `SECURITY DEFINER` function creates objects as its owner. `role-privileges.integration.spec.ts` asserts direct access to a monthly partition is refused.

---

## 6. Performance, Bottlenecks & Operational Realities

| Dimension | Mechanism | Reality & trade-offs |
| :--- | :--- | :--- |
| **Write amplification** | Triggers on DML | Every audited mutation writes to both the business and the audit table, inside the same transaction. Transaction duration and WAL volume grow proportionally. This is inherent to in-transaction auditing and is **not** mitigated by the `WHEN` clause. |
| **TOAST overhead** | `to_jsonb(NEW)` / `to_jsonb(OLD)` | Large `TEXT` / `BYTEA` columns (>2 KB) are de-TOASTed into memory on every audited write, and again by `OLD.* IS DISTINCT FROM NEW.*`. **Always** list document/payload columns in `ignored_columns`. |
| **Session binding** | `sessionBinding` | `'eager'` costs one round-trip per transaction including read-only ones; `'lazy'` removes it but loses attribution for non-flushing statements. §5.6. |
| **Index bloat** | Monthly range partitioning | Keeps active indexes small enough to stay resident. Requires the scheduled top-up of §5.5 — without it there is one unbounded partition and no benefit. |
| **Retention purging** | Partition drop | `DROP TABLE` on an attached partition takes an `ACCESS EXCLUSIVE` lock on the **parent** and blocks audited writes while it waits. Use `DETACH PARTITION … CONCURRENTLY` (PG 14+) first, then `DROP`. Not free, but bounded. |
| **Event loop** | Prototype metadata cache | `ActivityMetadataStorage.get(entity.constructor)` plus a prototype walk; no `Reflect.getMetadata` during flush. |
| **Feed critical path** | `flushMode` | `'sync'` is atomic and on the critical path; `'outbox'` moves the write off it at the cost of at-least-once delivery. §4.8. |

No sub-millisecond guarantee is claimed. `npm run bench` publishes measured overhead per row shape so integrators can size against their own data. Reference run — PostgreSQL 16, local container, median of 60 UPDATEs:

| Row shape | median | p95 | vs baseline |
| :--- | ---: | ---: | ---: |
| narrow row, **no trigger** (baseline) | 0.97 ms | 1.60 ms | 1.0× |
| narrow row, audited | 1.27 ms | 1.61 ms | **1.3×** |
| wide row (30 text columns), audited | 1.39 ms | 1.77 ms | **1.4×** |
| 512 KB TOASTed column, audited, **not** ignored | 7.13 ms | 11.48 ms | **7.4×** |
| 512 KB TOASTed column, audited, **ignored** | 2.61 ms | 5.27 ms | **2.7×** |

Read the last two rows together: de-TOASTing a single large column costs more than the trigger, the tuple width and the audit INSERT combined, and listing that column in `ignored_columns` recovers roughly two thirds of it. Tuple width alone is close to free (1.3× → 1.4× across 30 columns). These are absolute numbers on an unloaded local instance — treat the **ratios** as transferable, not the milliseconds.

---

## 7. Compliance & GDPR

### 7.1. Retention

Range partitioning is the retention mechanism for the audit trail: dropping an expired partition is bounded work, where a mass `DELETE` is not. Detach concurrently, then drop (§6). `activity_logs` has no partitioning by default — use `ActivityQueryService.prune()`, or partition it for high-volume deployments (§4.7).

### 7.2. Right to Erasure (Art. 17)

An audit trail designed to resist tampering is in direct tension with a statutory right to erasure. The resolution is **targeted pseudonymisation**, executed by `audit_admin`, preserving the forensic event sequence while removing identifiers.

> [!IMPORTANT]
> The batch is a **function with no transaction control**, and the loop lives in the package (`anonymizeSubject()`), not in PL/pgSQL. A procedure performing its own `COMMIT` cannot be invoked over the **extended query protocol**: PostgreSQL wraps parameterised statements in an implicit transaction and raises `invalid transaction termination`. A procedure would therefore be callable only with interpolated parameters — i.e. the erasure routine, whose whole input is a personal identifier, would have to build SQL by string concatenation. Verified in `gdpr-anonymize.integration.spec.ts`.

```sql
CREATE OR REPLACE FUNCTION audit.anonymize_subject_batch(
    p_schema     TEXT,           -- e.g. 'public'
    p_table      TEXT,           -- REQUIRED: row_id is not unique across tables
    p_row_id     TEXT,           -- the subject's identifier in that table
    p_actor      TEXT,           -- the same person as a causer (changed_by), or NULL
    p_keys       TEXT[],         -- personal-data keys to strip, per table
    p_from       TIMESTAMPTZ,    -- bounds enable partition pruning
    p_to         TIMESTAMPTZ,
    p_batch_size INT DEFAULT 10000
) RETURNS BIGINT                 -- rows rewritten; 0 means done
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_batch BIGINT;
BEGIN
    UPDATE audit.logged_actions t
    SET    changed_by = CASE WHEN t.changed_by = p_actor THEN 'ANONYMIZED' ELSE t.changed_by END,
           old_data   = t.old_data - p_keys,
           new_data   = t.new_data - p_keys
    WHERE (t.event_id, t.changed_at) IN (
        SELECT event_id, changed_at
        FROM   audit.logged_actions
        WHERE  changed_at >= p_from AND changed_at < p_to
          AND  (   (schema_name = p_schema AND table_name = p_table AND row_id = p_row_id)
                OR (p_actor IS NOT NULL AND changed_by = p_actor) )
          AND  (   jsonb_exists_any(old_data, p_keys)
                OR jsonb_exists_any(new_data, p_keys)
                OR (p_actor IS NOT NULL AND changed_by = p_actor) )
        LIMIT p_batch_size
    );

    GET DIAGNOSTICS v_batch = ROW_COUNT;
    RETURN v_batch;
END;
$$;
```

The driver loops until the batch returns 0, one transaction per batch, with bound parameters throughout:

```ts
import { anonymizeSubject } from 'fath-activity-log/migrations';

const rewritten = await anonymizeSubject(em.getConnection(), {
  schema: 'public',
  table: 'users',                       // required; omitting it is rejected
  rowId: subjectId,
  actor: subjectId,                     // same person seen as a causer
  keys: ['email', 'name', 'phone'],     // per table
  from: new Date('2020-01-01'),
  to: new Date(),
});
```

Three properties this fixes relative to a naive `UPDATE … WHERE row_id = :userId`:

1. **`table_name` is mandatory.** `row_id` is unique only within a table; `row_id = '42'` alone also rewrites row 42 of `invoices`, `products` and every other audited table.
2. **Time bounds enable partition pruning.** Without them the statement scans every partition and rewrites the history in one transaction.
3. **It terminates.** Stripping the keys and rewriting `changed_by` removes each row from the predicate, so the batched loop drains.

> [!NOTE]
> `jsonb_exists_any(x, keys)` is used rather than the `?|` operator on purpose: `?` is a bind placeholder in knex, which MikroORM's migration runner uses. Any raw SQL shipped by this package must avoid `?`, `?|` and `?&`.

Personal data may also be embedded in *other* tables' payloads (`orders.customer_email`). `p_keys` is therefore per-table, and the erasure procedure is expected to be called once per audited table that can carry the subject's identifiers.

---

## 8. Migration Publishing & SQL Helpers

Helpers return **arrays of statements** rather than one blob: `CREATE FUNCTION` bodies contain `$$ … ; … $$`, which no naive semicolon split survives.

```ts
import { Migration } from '@mikro-orm/migrations';
import {
  getFeedSchemaStatements,
  getAuditSchemaStatements,
  getInitialPartitionStatements,
  getDropAuditSchemaStatements,
  getDropFeedSchemaStatements,
} from 'fath-activity-log/migrations';

export class Migration_ActivityLog extends Migration {
  async up(): Promise<void> {
    // Feed: activity_logs, activity_outbox, indexes.
    for (const sql of getFeedSchemaStatements()) this.addSql(sql);

    // Audit: schema, empty audit_admin / audit_bypass roles, functions,
    // partitioned parent, DEFAULT partition + its changed_at index.
    for (const sql of getAuditSchemaStatements()) this.addSql(sql);

    // Current month + 3. Without this every row lands in the DEFAULT partition.
    // The host must also schedule the monthly top-up — see §5.5.
    for (const sql of getInitialPartitionStatements(new Date(), 4)) this.addSql(sql);
  }

  async down(): Promise<void> {
    for (const sql of getDropAuditSchemaStatements()) this.addSql(sql);
    for (const sql of getDropFeedSchemaStatements()) this.addSql(sql);
  }
}
```

`getHardeningScript()` is exported separately and is **not** called from a migration (§5.8).

> [!IMPORTANT]
> `getFeedSchemaStatements()` emits DDL matching MikroORM's **default** `UnderscoreNamingStrategy`. A host using a custom naming strategy must either keep the default for these entities or generate the DDL from metadata via `SchemaGenerator` instead.

---

## 9. Package Layout

Three concentric rings. **Nothing under `core/` may import an ORM or a driver** — that rule is enforced by `dependency-cruiser` in CI (§10), because it is the only thing standing between this layout and a silent re-coupling.

```
fath-activity-log/
├── package.json
├── tsconfig.json
├── vitest.config.ts                     # unplugin-swc: decorator metadata in tests
├── .dependency-cruiser.cjs              # forbids core/ -> adapters/ and core/ -> @mikro-orm/*
├── src/
│   ├── index.ts                         # core only; no adapter re-exports
│   │
│   ├── core/                            # ── RING 1: zero ORM / DB dependency ──
│   │   ├── ports/
│   │   │   ├── change-capture.port.ts   # observe mutations  (§11.1)
│   │   │   ├── activity-store.port.ts   # write feed rows    (§11.1)
│   │   │   ├── activity-reader.port.ts  # read feed rows     (§11.1)
│   │   │   └── session-binder.port.ts   # carry attribution  (§11.1)
│   │   ├── model/
│   │   │   ├── activity-record.ts       # neutral row shape, no decorators
│   │   │   └── entity-change.ts         # neutral changeset shape
│   │   ├── options/log-options.ts       # toPartial(): explicit-field tracking
│   │   ├── metadata/
│   │   │   ├── activity-metadata-storage.ts
│   │   │   └── register-activity.ts     # the primitive; decorator is sugar
│   │   ├── decorators/logs-activity.decorator.ts
│   │   ├── services/
│   │   │   ├── activity-builder.ts
│   │   │   ├── activity-logger.service.ts
│   │   │   └── activity-pipeline.ts     # filtering, diffing, soft-delete, description
│   │   ├── context/
│   │   │   ├── request-context.service.ts   # runWith(): the non-HTTP entrypoint
│   │   │   ├── request-context.interceptor.ts
│   │   │   └── request-context.module.ts
│   │   ├── feed.module.ts               # takes { adapter } — see §2.2
│   │   ├── audit.module.ts              # takes { adapter }
│   │   └── index.ts
│   │
│   ├── adapters/
│   │   ├── mikro-orm/                   # ── RING 2: ORM binding ──
│   │   │   ├── entities/
│   │   │   │   ├── activity-log.entity.ts
│   │   │   │   ├── activity-outbox.entity.ts
│   │   │   │   └── logged-action.entity.ts
│   │   │   ├── mikro-orm-change-capture.ts   # onFlush / afterFlush -> EntityChange[]
│   │   │   ├── mikro-orm-activity-store.ts
│   │   │   ├── mikro-orm-activity-reader.ts  # keyset pagination, tenant scoping
│   │   │   ├── mikro-orm-session-binder.ts   # eager | lazy set_config
│   │   │   ├── activity-outbox.drainer.ts
│   │   │   ├── mikro-orm.adapter.ts          # MikroOrmActivityAdapter
│   │   │   └── index.ts
│   │   │
│   │   └── postgres/                    # ── RING 3: engine binding ──
│   │       ├── sql/
│   │       │   ├── audit-schema.sql
│   │       │   ├── audit-hardening.sql  # DBA-only, never run by a migration
│   │       │   └── feed-schema.sql
│   │       ├── partition-manager.ts
│   │       ├── audit-query.service.ts   # builds composite rowId for callers
│   │       └── index.ts
│   │
│   └── migrations/
│       ├── migration-helpers.ts         # dialect-parameterised; postgres only in v1
│       └── index.ts
│
└── tests/
    ├── unit/
    │   ├── log-options.spec.ts
    │   ├── logs-activity.decorator.spec.ts
    │   ├── activity-metadata-storage.spec.ts
    │   ├── options-precedence.spec.ts
    │   ├── activity-builder.spec.ts
    │   └── request-context.service.spec.ts
    ├── integration/
    │   ├── feed-subscriber.integration.spec.ts
    │   ├── tenant-isolation.integration.spec.ts
    │   ├── auto-generated-pk.integration.spec.ts
    │   ├── outbox-drainer.integration.spec.ts
    │   ├── feed-prune.integration.spec.ts
    │   ├── audit-trigger.integration.spec.ts
    │   ├── audit-composite-pk.integration.spec.ts
    │   ├── audit-session.integration.spec.ts
    │   ├── audit-bypass-privileges.integration.spec.ts
    │   ├── audit-partitioning.integration.spec.ts
    │   ├── partition-conflict.integration.spec.ts
    │   ├── partition-privileges.integration.spec.ts
    │   ├── transaction-rollback.integration.spec.ts
    │   ├── native-update-asymmetry.integration.spec.ts
    │   ├── session-concurrency.integration.spec.ts
    │   ├── role-privileges.integration.spec.ts
    │   ├── gdpr-anonymize.integration.spec.ts
    │   └── toast-overhead.integration.spec.ts
    ├── bench/dml-overhead.bench.ts
    └── fixtures/
        ├── sample-invoice.entity.ts
        ├── composite-pk.entity.ts
        └── test-database.helper.ts
```

---

## 10. Verification & Test Suite

| Category | Suite | Target verification |
| :--- | :--- | :--- |
| Unit | `log-options.spec.ts` | Chaining, attribute filtering, `toPartial()` reports only explicitly-set fields. |
| Unit | `options-precedence.spec.ts` | `getActivitylogOptions()` does **not** override fields it did not set (§4.2). |
| Unit | `activity-metadata-storage.spec.ts` | Constructor keying, prototype-chain resolution (STI, abstract bases). |
| Unit | `request-context.service.spec.ts` | `AsyncLocalStorage` isolation under concurrency; `runWith()` in non-HTTP contexts. |
| Integration | `feed-subscriber.integration.spec.ts` | Dirty checking, exclusions, configurable soft-delete field, `withoutLogs()`. |
| Integration | `tenant-isolation.integration.spec.ts` | Default reads never cross tenants; `tenantId: null` is explicit opt-out. |
| Integration | `auto-generated-pk.integration.spec.ts` | `'resolve'` fills `subjectId`; `'skip'` leaves it null; **rollback inside `em.transactional()` leaves no row** (§4.5). |
| Integration | `outbox-drainer.integration.spec.ts` | Rollback discards intents; replay is idempotent; concurrent drainers do not double-write. |
| Integration | `feed-prune.integration.spec.ts` | `prune()` uses `idx_activity_logs_created` (asserted via `EXPLAIN`) and commits per batch. |
| Integration | `audit-trigger.integration.spec.ts` | I/U/D payloads, `changed_fields`, ignored columns stripped, no row when only ignored columns change. |
| Integration | `audit-composite-pk.integration.spec.ts` | Composite `row_id` is canonical and stable; overlapping `pk_columns`/`ignored_columns` is rejected by `track_table`; a missing PK column raises. |
| Integration | `audit-bypass-privileges.integration.spec.ts` | **`SET LOCAL audit.disabled` without `audit_bypass` membership suppresses nothing and sets `bypass_attempted`; it is also denied when the role does not exist** (§5.3). |
| Integration | `partition-conflict.integration.spec.ts` | `create_monthly_partition()` raises instead of locking when the DEFAULT partition holds conflicting rows; the §5.5 runbook resolves it. |
| Integration | `partition-privileges.integration.spec.ts` | Direct `DELETE FROM audit.logged_actions_YYYY_MM` is refused to the app role; new partitions are owned by `audit_admin`. |
| Integration | `transaction-rollback.integration.spec.ts` | An aborted business transaction leaves zero rows in `activity_logs`, `activity_outbox` and `logged_actions`. |
| Integration | `native-update-asymmetry.integration.spec.ts` | `em.nativeUpdate()` bypasses the feed, is captured by the trigger, and carries attribution **only** inside `em.transactional()`. |
| Integration | `session-concurrency.integration.spec.ts` | Concurrent transactions over a shared pool keep `app.current_user_id` isolated; nothing leaks post-commit. |
| Integration | `role-privileges.integration.spec.ts` | The app role cannot `UPDATE`/`DELETE` audit rows nor `DROP TRIGGER`, on the parent or any partition. |
| Integration | `gdpr-anonymize.integration.spec.ts` | Anonymisation touches only the targeted table, prunes by time bounds, and terminates. |
| Integration | `toast-overhead.integration.spec.ts` | Behaviour and cost with multi-megabyte payloads, with and without `ignored_columns`. |
| Bench | `dml-overhead.bench.ts` | Measured per-mutation overhead by row shape. Publishes numbers; asserts no fixed threshold. |
| Architecture | `core-has-no-orm-dependency.spec.ts` | `dependency-cruiser` asserts no module under `core/` imports `adapters/`, `@mikro-orm/*` or any driver. The seam of §11.1 is worthless unless CI defends it. |
| Conformance | `adapter-conformance.suite.ts` | A reusable suite any adapter must pass: `ChangeCapture` reports create/update/delete with correct before/after values, `ActivityStore` writes participate in the ambient transaction, `SessionBinder` scopes attribution to the transaction. Run against MikroORM in v1; it is the acceptance criterion for a second adapter. |
| Packaging | Build verification | `tsc`, `publint`, `arethetypeswrong`; a CommonJS `require()` consumer **and** an ESM `import` consumer resolving through Node interop; importing `fath-activity-log` with **no** `@mikro-orm/*` installed must succeed. |

---

## 11. Portability & Platform Profiles

A *profile* is one (ORM, database) pair. v1 ships exactly one: **MikroORM v6 + PostgreSQL 13+**. This section defines what a second profile could reuse, what it would have to re-implement, and what it could not preserve at all.

The headline result is that **the feed/audit decoupling the package already rests on is also the portability boundary**:

| | Portable? | Nature of the work |
| :--- | :--- | :--- |
| **FeedModule** | Yes, behind an adapter | One business logic, several lifecycle bindings |
| **AuditModule** | **No** | A re-implementation per engine, with a *different guarantee table* |

### 11.1. The Four Ports

The core depends on these and on nothing else. An adapter is an object supplying all four.

```ts
/** Neutral changeset. No ORM types, no decorators. */
export interface EntityChange {
  entity: unknown;
  entityName: string;
  operation: 'create' | 'update' | 'delete';
  /** Undefined when the identifier is database-generated and not yet assigned. */
  identifier?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

/** Observe mutations. The capability that varies most between ORMs (§11.2). */
export interface ChangeCapture {
  onChanges(handler: (changes: EntityChange[], tx: TransactionRef) => void | Promise<void>): void;
  /** True when the ORM can supply `before` without an extra read. Gates logOnlyDirty. */
  readonly providesBeforeState: boolean;
  /** True when changes arrive batched per flush rather than one entity at a time. */
  readonly batchesByFlush: boolean;
}

/** Write feed rows inside the ambient transaction. */
export interface ActivityStore {
  persist(records: ActivityRecord[], tx: TransactionRef): Promise<void>;
  /** Resolve identifiers assigned during the flush. No-op when identifiers are client-assigned. */
  resolveIdentifiers?(records: ActivityRecord[], tx: TransactionRef): Promise<void>;
}

/** Read feed rows. Keyset pagination and tenant scoping live here. */
export interface ActivityReader {
  query(spec: FeedQuerySpec): Promise<CursorPage<ActivityRecord>>;
  count(spec: FeedQuerySpec): Promise<number>;
  prune(olderThan: Date, batchSize: number): Promise<number>;
}

/** Carry user attribution down to the engine. Engine-specific, may be a no-op. */
export interface SessionBinder {
  bind(userId: string, tx: TransactionRef): Promise<void>;
  /** Declares the actual scope obtained. 'session' means it leaks across a pooled connection. */
  readonly scope: 'transaction' | 'session' | 'none';
}
```

`SessionBinder.scope` is deliberately part of the contract rather than an implementation detail: an adapter that can only offer `'session'` scope (MySQL) is **not** a drop-in replacement for one offering `'transaction'`, and the type system should say so at registration time rather than the integrator discovering it through a cross-tenant attribution leak.

### 11.2. ORM Capability Matrix — what degrades and why

Transfers unchanged: `LogOptions`, `ActivityMetadataStorage`, `registerActivity`, `ActivityBuilder`, the precedence rules of §4.2, the filtering/diff/soft-delete pipeline, `RequestContext`, and the whole read API shape. That is most of §4.

What does **not** transfer is automatic change capture, because it is bounded by what the ORM knows.

| ORM | Hook | Before-state | `logOnlyDirty` | Verdict |
| :--- | :--- | :--- | :--- | :--- |
| **MikroORM v6** | `onFlush` + UnitOfWork | Full changesets, batched | Free | **Reference.** |
| **Sequelize** | `beforeCreate` / `afterUpdate` | `instance.previous()`, `changed()` | Free | Good fit. |
| **TypeORM** | `EntitySubscriberInterface` | `updatedColumns` + `databaseEntity`, per entity | Free on `save()` | **Partial** — `.update()` and QueryBuilder bypass subscribers entirely, reproducing the §1.1 asymmetry *inside* the feed. |
| **Prisma** | `$extends` — **query** level, not entity level | None. A read-before-write is on you. | Extra query + a lost-update race | **Not recommended.** |
| **Drizzle** | None | None | Unavailable | Manual logging only. |

Two consequences that shape the design *today*, not later:

1. **`@LogsActivity` cannot survive a schema-first ORM.** Prisma generates types and Drizzle uses table objects — neither has a class to decorate. This is why §4.2 makes `registerActivity(target, options)` the primitive and the decorator sugar over it. Doing this after v1 would break every consumer; doing it now costs one indirection.
2. **Below `providesBeforeState`, the package stops being itself.** Without a cheap before-state, `logOnlyDirty`, `dontSubmitEmptyLogs` and the exact diff — precisely what distinguishes this from a `logger.info()` call — are either unavailable or cost a round-trip per mutation. `FeedModule.forRoot()` therefore **refuses at bootstrap** to enable `logOnlyDirty` on an adapter reporting `providesBeforeState: false`, rather than silently degrading.

**Realistic targets: TypeORM and Sequelize.** Prisma and Drizzle are explicitly out of scope; a `fath-activity-log/prisma` adapter would be a different, weaker product wearing the same name.

### 11.3. Database Capability Matrix — the audit trail is not adapter-shaped

| Engine | Triggers | Attribution scope | Partitioning | Role model | §1.1 "Resistant" achievable? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **PostgreSQL 13+** | ✅ | ✅ transaction (`SET LOCAL`) | ✅ RANGE | ✅ | **Yes** — the reference. |
| **SQL Server** | ✅ | ✅ transaction (`sp_set_session_context`) | ✅ | ✅ | Yes, but see note. |
| **MySQL 8** | ✅ | ⚠️ **session only** (`@user_var`) | ⚠️ partition key constrained by every unique key | ⚠️ weaker | Partially. |
| **SQLite** | ✅ | ❌ | ❌ | ❌ no roles, no schemas | **No.** |
| **MongoDB** | Change Streams | ❌ | — | — | **No.** |

Where the breaks actually are:

- **MySQL has no transaction-scoped variable.** `SET @app_current_user_id` survives `COMMIT`, so on a pooled connection the value leaks into the next client's statements — exactly the failure `is_local = true` prevents in PostgreSQL. A MySQL profile must reset the variable explicitly at both commit and rollback, and `SessionBinder.scope` must report `'session'`. There is also no `to_jsonb(NEW)` equivalent: columns must be enumerated, so the trigger becomes **generated per table** rather than generic.
- **SQLite has neither schemas nor roles**, so §5.8 disappears entirely and with it the "Resistant" row of the threat model. Usable for tests; the tamper-resistance claim would be false.
- **MongoDB change streams are post-commit and outside the transaction.** The guarantee shared by both modules today — *the audit follows the transaction and rolls back with it* — no longer holds. That is a different product, not a port.
- **SQL Server**: reachable, but **temporal tables** (`SYSTEM_VERSIONING`) are likely a better native answer than triggers. Porting the PostgreSQL design there would be the wrong instinct — which is the general shape of the problem: each engine's best audit mechanism is idiomatic to that engine.

**Therefore**: a second database profile ships its own §5, its own §7.2 erasure procedure, its own §8 migrations and **its own §1.1 table**. `getAuditSchemaStatements()` takes a dialect parameter, but the dialects share no SQL — only the surface.

### 11.4. Recommendation

| | Decision |
| :--- | :--- |
| **Now, before v1** | Keep one package. Enforce the three rings of §9, the four ports of §11.1, `registerActivity` as the primitive, adapter subpath exports, and optional ORM peers. Cost: structural, no runtime change. |
| **When a second adapter lands** | Split into `@fath/activity-log-core` + `-mikro-orm` + `-postgres` + the newcomer. The ports make this mechanical. |
| **Never** | Abstract the audit trail behind a common interface. Its value is the PostgreSQL-specific implementation; a portable version would guarantee less while claiming the same. |

The cost asymmetry is the whole argument: introducing the seam **today** is a refactor, because the only consumer-visible surface is §2.2. Introducing it **after v1** breaks the registration contract for every installed base. §11.1 and §9 exist to make a decision that is currently cheap stay cheap.
