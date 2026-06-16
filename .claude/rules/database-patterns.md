---
globs: "src/**/*.ts"
---

# Database Patterns

## TypeORM Code-First Migrations

Generate migrations from entity changes:

```bash
npx typeorm migration:generate src/migrations/AddItemTable
npx typeorm migration:run
```

**Carve-out — hand-written migrations are required for:** column renames and data migrations (`migration:generate` would emit drop+add and lose data — write `ALTER TABLE ... RENAME COLUMN` + `UPDATE` by hand) and framework-package migrations. The rule that stands: never duplicate an entity's `CREATE TABLE` by hand.

## Schema Per Service

Each service gets its own PostgreSQL schema (e.g., `identity`, `billing`).
Migrations reference the schema explicitly.

## CRITICAL: TypeORM Uses camelCase Column Names

TypeORM's default naming strategy maps entity properties directly to column names.
**Column names in the database are camelCase, NOT snake_case.**

```typescript
// Entity property: displayLatitude
// Database column: "displayLatitude" (NOT display_latitude)

// ❌ WRONG
CREATE INDEX idx_post_lat ON activity.posts ("display_latitude");

// ✅ CORRECT
CREATE INDEX idx_post_lat ON activity.posts ("displayLatitude");
```

When referencing tables in raw SQL, use `schema.tableName` (NOT `"schema"."tableName"` with the schema quoted):
```sql
-- ❌ WRONG
SELECT * FROM "activity"."post";

-- ✅ CORRECT
SELECT * FROM activity.posts;
```

## Entity Index Patterns — No Duplicates

Use EITHER class-level `@Index` OR property-level `@Index`, never both for the same column.

## Migration SQL Rules

### CREATE INDEX CONCURRENTLY — Non-Transactional Migrations Only

TypeORM migrations run inside transactions by default. `CONCURRENTLY` cannot run in a transaction. For normal migrations, use regular `CREATE INDEX`:

```typescript
// ❌ WRONG — CONCURRENTLY inside a default (transactional) migration
await queryRunner.query(`CREATE INDEX CONCURRENTLY idx_name ON schema.table ("column")`);

// ✅ CORRECT — regular index in a transactional migration
await queryRunner.query(`CREATE INDEX idx_name ON schema.table ("column")`);
```

For large tables (millions of rows) where locking must be avoided, create a **separate migration file** with `transaction = false`:

```typescript
export class AddIndexOnOrderLocationConcurrently1234567890 implements MigrationInterface {
  transaction = false as const;

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_location ON catalog.orders ("latitude", "longitude")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS catalog.idx_order_location`);
  }
}
```

### NEVER Write Hand-Crafted Migrations That Duplicate Entities

If a TypeORM entity defines a table, run `migration:generate`. Do NOT also write a manual `CREATE TABLE`.

## Work-Claiming — `FOR UPDATE SKIP LOCKED`

Competing pollers (e.g. the outbox relay across replicas) claim rows with pessimistic locks that skip already-claimed rows — no leader election needed:

```typescript
qb.setLock('pessimistic_write').setOnLocked('skip_locked')  // TypeORM ≥ 0.3.x
```

- **PostgreSQL ≥ 9.5 only** — non-Postgres deployments must disable features built on this (e.g. the outbox relay).
- Locks held during external I/O are bounded by `batchSize × broker latency` — tune `batchSize`/`pollIntervalMs` to size the lock window.
- A crashed claimer's transaction rolls back and the rows become claimable again — duplicates downstream are absorbed by the consumer inbox.

## Inbox / Dedup Table Pattern

The framework `processed_events` table dedups at-least-once deliveries:

- Composite PK **`(eventId, consumerGroup)`** IS the uniqueness constraint — a single-column `eventId` key would make two consumer groups dedup *each other* (fan-out broken).
- Insert with `orIgnore()` (`ON CONFLICT DO NOTHING`); 0 affected rows = duplicate, skip processing. Concurrent duplicate inserts block on the row lock then conflict — safe under Postgres unique-index semantics.
- Create the table with the exported `CreateProcessedEvents1781091700000` migration class from `@quanticjs/events-core` — do not hand-write it.
- Index `processedAt` for TTL cleanup (default 7-day retention via `inbox.retentionDays`, batched deletes). Inbox cleanup runs `@Cron('0 4 * * *')` daily (server-local time) and requires `ScheduleModule`. Retention must exceed the max redelivery horizon.
- **Writes must use the ambient transaction**: write through `TransactionContext.get()?.manager` when present, so the inbox row commits/rolls back atomically with the command's side effects. A raw insert through a separate connection breaks exactly-once semantics.

## Outbox Schema Notes

- `outbox_events` columns include `topic` (dot-delimited, renamed from `stream_key` in the v6.0 events-package split), nullable `userId` (added in v7.0.0 — `AddUserIdToOutbox` migration), `correlationId`, `causationId`.
- `OutboxEvent.id` deliberately accepts a **client-supplied** UUID — the row id IS the event envelope id (end-to-end dedup). Do not "fix" the explicit id assignment.

## Migration Naming Convention

Use descriptive names: `AddItemTable`, `AddStatusColumnToOrder`, `CreateIndexOnEmail`.

## NEVER

- **NEVER** use `synchronize: true` in staging or production
- **NEVER** write snake_case column names
- **NEVER** use `CREATE INDEX CONCURRENTLY` inside transactional migrations
- **NEVER** write manual `CREATE TABLE` for tables with TypeORM entities
- **NEVER** access another module's tables directly
