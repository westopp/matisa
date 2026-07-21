# Database tenets

This file governs how service code and the database interact — the boundary, schema design, column types, lifecycle and history, queries and transactions, and migrations. Cross-cutting governance — schema sharing, time, error structure, branded IDs — lives in [tenets.general.md](./tenets.general.md); the SQL-injection and string-built-SQL prohibition lives in [tenets.security.md](./tenets.security.md) (SEC-203); the database boundary itself is also referenced by [ARCH-215](./tenets.system-architecture.md); per-operation timeouts owned by the layer doing the work live in [ARCH-220](./tenets.system-architecture.md), with the pool-level backstops here in DB-201.

Tenets are stable, prescriptive commitments. IDs are stable references — code review, PR descriptions, and incident postmortems can cite them. Numbers are not hierarchical; they are identifiers.

---

## The boundary

### DB-200. The `Database` service is the only way to interface with the database.

Every query, every transaction, every read and write that touches Postgres goes through the `Database` tag and the helpers it exposes. No module imports `postgres`, instantiates Drizzle, opens a raw connection, or reaches for the underlying driver of its own. Connection pooling, transaction primitives, the mapping from postgres error codes to typed `DatabaseError`, query-level observability (spans, duration histograms, error counters), and the `DatabaseConfig` parameters all live behind that single tag. Services consume `Database` via its `Context.Tag` and call its `query` / `transaction` methods; they do not construct their own client. A "temporary" raw-driver import to "just bypass the abstraction for this one query" is a tenet violation regardless of how isolated it looks — once it lands, the next contributor copies the shape, and the centralised error mapping, observability, and connection lifecycle hollow out from underneath.

---

## Pool and session

### DB-201. Pool and session settings are configured at boot, not per-query.

The Postgres pool is constructed once at boot with `connect_timeout`, `idle_timeout`, `statement_timeout`, and `idle_in_transaction_session_timeout` set from `AppConfig` (cross-ref ARCH-216). These settings are the database's *backstop* against runaway SQL and orphan transactions — distinct from the per-operation application timeouts in ARCH-220, which express the intended budget. The application timeout fires first under healthy conditions; the pool-level timeouts catch the cases where application code forgot or failed to set one. Per-query overrides via `SET LOCAL statement_timeout = ...` exist for genuinely long-running cases (exports, reports, backfills) and are explicit at the call site, not silently accumulated; a service that routinely overrides the statement_timeout for "performance reasons" is masking a query that should be made cheaper instead. New connections inherit the pool defaults — there is no per-call connection construction with bespoke session settings.

---

## Schema integrity

### DB-202. Constraints encode invariants the database can enforce.

Columns are `NOT NULL` by default; nullable only when absence is semantically meaningful (e.g. `accepted_at` is null until accepted, `archived_at` is null until archived). Every foreign reference is a real `FOREIGN KEY` constraint, not a string column with a name like `..._id` and an application-level expectation. Uniqueness is a `UNIQUE` constraint, not an application-level "check then insert" — the application-level check TOCTOU-races under concurrency and silently allows duplicates. Domain invariants that fit a `CHECK` constraint are encoded as one (`quantity > 0`, `start_at < end_at`, `status IN (...)`); the database refuses bad rows at write time, not the application after they have already landed. The bug class this closes is "the application enforces a rule on the happy path under low load and silently fails to enforce it under concurrency, batch jobs, or contributors who didn't know the rule existed."

### DB-207. Foreign-key graphs are acyclic.

The directed graph of foreign-key relationships across tables is acyclic. Cycles break topological insert order (no row in either table can be inserted before the other), make seeding and test fixtures unworkable, and produce ambiguous `ON DELETE CASCADE` semantics that are hard to reason about in incidents. Junction tables that hold FKs to two parent tables are not cycles — the cycle would be between the parent tables themselves, mediated through fields that reference each other directly. Cyclic schemas are prohibited absent a compelling case argued in review and a deferred-constraint design that has been worked through end-to-end.

### DB-212. Cascades are explicit and schema-declared.

`ON DELETE` and `ON UPDATE` behaviour is declared at the foreign-key definition with deliberate intent — `CASCADE`, `SET NULL`, `RESTRICT`, or `NO ACTION` — and the choice is reviewed alongside the FK. Implicit defaults (`NO ACTION` on every FK because nobody specified) are acceptable when that *is* the considered choice; they are not acceptable when nobody thought about it. Cascades that destroy data (the parent is hard-deleted, taking children with it) get extra review attention: the cascade must be the deliberate intent for that relationship, not a default that nobody pushed back on. Tree structures with destructive cascades multiply the blast radius of a single delete — a deliberate choice in some cases, a footgun in others.

### DB-213. Schema lives in code.

The Drizzle schema files in `db.schema/` are the single source of truth for the database structure. Manual `psql` schema changes — `ALTER TABLE` ad-hoc in any environment, including production hotfixes — are tenet violations; the fix path is "write a migration, deploy it, run it." Side-channel changes drift the production schema from the codebase, break the next migration Drizzle generates (it assumes a state that no longer matches), and make every future schema operation a guess. Test environments and dev databases are reset from migrations, not from `pg_dump` snapshots — the migration history *is* the schema, not a derived artifact.

### DB-217. Every table has a co-located Effect Schema with a compile-time alignment assertion.

Each Drizzle table definition in `db.schema/` declares an Effect Schema describing the row shape immediately after the table — `TodoRow` next to `todos`, `UserRow` next to `users` — and asserts alignment via a compile-time `AssertEqual<Schema.Schema.Type<typeof RowSchema>, typeof table.$inferSelect>` const. Application code consumes the schema, not `$inferSelect` directly; the assertion guarantees the two cannot drift, and a schema change ships only when the table change ships. The bug class this closes is "the table was renamed and the application kept reading the old column name, returning silent `undefined` rather than a build error" — the assertion turns drift into a compile failure. See [db.todos.ts:56-71](../../services/server/src/db/db.schema/db.todos.ts) for the canonical pattern.

---

## Column types and shapes

### DB-206. Column types follow the project's Postgres dialect.

Timestamps are `timestamptz`, never `timestamp without time zone` — the database stores UTC, the application layer parses through Effect's `DateTime` per GEN-202, and there is one wall clock and one timezone semantics. JSON columns are `jsonb`, never `json` — jsonb is binary, indexable, and the right default for everything except the rare write-once-never-read case. Enumerations whose value set is stable and rarely extended use Drizzle's `pgEnum` (typed in both Postgres and TypeScript); value sets that are extended frequently — audit-log actions, plugin identifiers — use plain `text` validated by an application-side discriminated-union schema, because `ALTER TYPE ... ADD VALUE` for every new entry is friction that compounds across deploys. Primary keys are branded ID types from `@apollis/shared` (cross-ref GEN-204) so a `userId` cannot be passed where an `orgId` is expected; the brand is applied in the column definition and propagates through `$inferSelect`. The dialect is opinionated on purpose — defaults that "work fine" for one column shape are bug-class-adjacent at scale, and homogeneity across tables makes review faster and migrations safer.

### DB-211. Prefer nullable timestamps over booleans for state with meaningful "when".

State that is binary but has a meaningful occurrence time uses a nullable `*_at timestamptz` column, not a boolean — `email_verified_at`, `archived_at`, `accepted_at`, `published_at`. The presence of a value is the "true" state; `NULL` is the "false" state. This encodes the same boolean information plus *when it happened*, supports filtering (`WHERE archived_at IS NULL`) without a separate timestamp column, and avoids the `(is_active, deactivated_at)` pair that drifts out of sync because correctness depends on which one you query. Plain `boolean` columns are reserved for state where the occurrence time is genuinely irrelevant — those cases are rarer than they look. State with more than two values uses `pgEnum` (DB-206), not a fan of three booleans that can be inconsistent with each other. This pattern applies to lifecycle state generally; it is not coupled to any deletion model.

### DB-214. Numeric types are deliberate.

Currency and other exact-decimal values use `numeric(precision, scale)`, never `float` or `double precision` — IEEE 754 floating-point arithmetic is wrong for currency in ways that produce silent reconciliation bugs (`0.1 + 0.2 !== 0.3`). Counts are `integer` or `bigint` based on bounded vs. unbounded range; `bigint` is the right default for primary keys on tables that may grow. Percentages, ratios, and measurements where exact arithmetic matters use `numeric`. JavaScript's `Number` is a 64-bit float, so `bigint` columns require explicit handling at the application boundary — Drizzle's `bigserial` mode returns strings to preserve precision, and the row schema (DB-217) reflects that. Choosing the wrong numeric type is rarely caught at review and rarely fixable cheaply once data exists.

### DB-215. JSONB columns are parsed against a schema, not used as a schemaless escape hatch.

When data goes into a `jsonb` column, the application boundary parses it through an Effect Schema on read — there is no `as any` traversal of jsonb fields, no "we'll figure out the shape later." The database cannot enforce the JSON shape; the application must (cross-ref SEC-202: external input is parsed at the boundary, and the database is one boundary among several). JSONB is appropriate for genuinely document-shaped data — the `diff` column on `audit_log` (DB-210), settings blobs whose keys vary by integration, payloads from external webhooks. It is not an excuse to avoid table design when the data has a stable, queryable shape: if the JSON has the same five fields on every row, those are five columns. The bug class this closes is "we used jsonb because the schema wasn't decided yet" — the schema gets decided implicitly by whoever wrote the first read query, and never gets revisited.

### DB-216. Database `now()` is the source of truth for DB-recorded timestamps.

`created_at` and `updated_at` columns default to `NOW()` at the database, not to a value passed in by the application. The database has one wall clock; application servers may have several with skew between them, and timestamps recorded from app clocks can produce out-of-order `(created_at, id)` cursors and audit rows whose `occurred_at` precedes their parent transaction's `BEGIN`. Application code reads these timestamps through GEN-202's `DateTime`; it does not write them. `updated_at` autotouch is implemented as a Postgres trigger declared once and applied uniformly across audited tables — putting `updated_at = NOW()` in every UPDATE statement scattered across services is the inconsistency this tenet exists to prevent.

---

## Lifecycle and history

### DB-210. Audit log is the canonical "who did what to what".

Mutations to audit-worthy resources record an entry in a single central `audit_log` table: `(id, correlation_id, entity_type, entity_id, action, actor_id, occurred_at, diff jsonb)`. The `correlation_id` is the request's trace ID, sourced from the request scope (TEL-203 owns its generation) — every audit row produced inside a request shares one, so the full set of audit consequences of a single user action is one indexed query. The `actor_id` is the resolved session user (cross-ref SEC-205 on actor identity); `action` is plain `text` validated against an application-side discriminated-union Effect Schema (cross-ref DB-206 on why not `pgEnum`), and `diff` is `jsonb` whose shape varies per `action` variant — `create` carries `{ snapshot }`, `update` carries `{ before, after }` for changed fields only, `delete` carries `{ snapshot }` for forensics, `restore` is self-describing, and semantic actions (`publish`, `accept_invitation`) carry action-specific fields. Resources do not carry their own `created_by`/`updated_by`/`deleted_by` columns — the audit log is the single source of truth for "who did this", and per-action FKs from resources to audit rows are denormalisation paid for only when a measured query path demands it. Indexes on `(entity_type, entity_id, occurred_at)` and `(correlation_id)` cover the entity-history and causal-chain query patterns respectively.

---

## Queries and transactions

### DB-203. Transactions are short-lived and bounded.

A transaction wraps a unit of work that completes within milliseconds. No third-party HTTP calls, no queue publishes, no waits-on-external-state inside the transaction body — those operations have unbounded latency variance, hold row locks plus a pool connection for their full duration, and under load exhaust the pool and convert upstream slowness into a database outage. Read-modify-write that needs atomicity goes through the transaction (`SELECT ... FOR UPDATE`, or serialisable isolation with retry on conflict), not through an application-level "check-then-write" pattern that loses correctness under concurrency. Long-running operations — migrations, backfills, exports — run outside the request-serving connection pool entirely. When a database write must be gated by an external action, the pattern is the outbox: write the intent to an `outbox` table inside the transaction, commit, and let an async worker pick up the row and call the external API with an idempotency key. The Postgres transaction is atomic within Postgres; it has no purchase on external state, and treating it as if it does produces partial-state failures in every realistic failure mode (commit fails after external success, response lost, network partition).

### DB-205. Query bounds are explicit.

Every query returns a result set whose size is bounded by something visible in the query: an explicit `LIMIT`, or a predicate provably bounded by the schema (`WHERE id = $1` on a unique column returns at most one row; `WHERE id = ANY($1)` is bounded by the array's length). Implicit bounds from "this list is always small" are tenet violations — the list grows, the silent assumption fails, and an enterprise customer's request OOMs the application years after the query was written. List endpoints use cursor pagination (`WHERE id > $cursor ORDER BY id LIMIT n`) rather than `OFFSET`; OFFSET makes Postgres scan and discard the offset rows and is acceptable only for genuinely small bounded result sets where random-page access is required by product. `SELECT *` is not used — columns are listed explicitly so the data transferred stays stable as the schema grows, the query plan is analysable, and a reviewer can see what the query actually reads.

### DB-208. Every foreign key has a supporting index, and every index is justified by a query.

Postgres does not create an index on the referencing side of a foreign key automatically; a missing FK index turns every cascading delete and every reverse lookup into a sequential scan against the child table. Every FK declared in the schema has a corresponding index. Conversely, every index added is justified by a query that benefits from it, named in the migration's review notes; speculative indexes "for future queries" are not introduced because each index has a write-time cost (every insert/update maintains every covering index). Uniqueness is declared as a `UNIQUE` constraint, which produces the unique index for free — separately declaring a unique index next to a unique constraint is duplication. Index creation in production migrations uses `CREATE INDEX CONCURRENTLY` to avoid the write-blocking lock on the underlying table; the tradeoff is a longer migration, not a stalled application. Composite indexes are ordered by selectivity and predicate frequency — the leading column is the one most queries filter on. Partial indexes (`WHERE status = 'active'`, `WHERE archived_at IS NULL`) are used where the predicate matches a hot read pattern.

---

## Migrations

### DB-204. Migrations are forward-only.

In production, migrations only run forward. Drizzle's down-migration scripts are dev-only — the deployment pipeline never invokes them. If a migration is wrong, the fix is a *new forward migration* that corrects it, not a rollback to the previous schema. Down migrations are rarely tested against realistic production data shapes, are physically irreversible for some operations (a dropped column's data is gone; the down migration cannot recreate it), and create a habit of "just rollback" that masks the need to think about the correct forward step. Online-safety of each migration — no full-table rewrites without batching, no exclusive locks against hot tables, no destructive column drops without a multi-step deploy (deprecate → stop reading → drop), `CREATE INDEX CONCURRENTLY` rather than `CREATE INDEX` — is a review concern; the reviewer reads the generated SQL and pushes back on operations that would stall production for the migration's duration.

---

## Cross-references

- **ARCH-215** — the `Database` tag is the only database surface services see; DB-200 is the full statement.
- **ARCH-216** — `AppConfig` is the source of typed configuration; pool/session settings (DB-201) come from there.
- **ARCH-220** — application-level operation timeouts; pool-level settings (DB-201) are the backstop.
- **SEC-202** — external input is parsed at the boundary; JSONB schema validation (DB-215) is one application of this.
- **SEC-203** — no string-built SQL; Drizzle's parameterised builder is how DB-205's column listing intersects with safety.
- **SEC-205** — session is the only source of actor identity; the `actor_id` on `audit_log` (DB-210) comes from the resolved session, never from request input.
- **GEN-200** — schemas live in shared; row-aligned schemas (DB-217) are the table-bound counterpart.
- **GEN-201** — TaggedError pattern; `DatabaseError` is one such tagged error.
- **GEN-202** — time goes through Effect's `DateTime`; DB-216 is the database-side counterpart.
- **GEN-204** — branded IDs in shared; column-level branding (DB-206) is the database-side counterpart.
- **TEL-203** — span tree mirrors the request call stack; the `correlation_id` on `audit_log` (DB-210) is the trace ID from this scope.
