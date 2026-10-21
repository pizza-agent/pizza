# PostgreSQL event storage for SDK hosts

The default CLI/SQLite path is unchanged. Node.js server hosts can now inject a
`SessionEventStore` into `createSessionFacade({ store, workspaceId, threadId, ... })`.

```ts
import pg from "pg";
import { AsyncProjectionStore, PostgresEventStorage, createSessionFacade } from "@tomsun28/pizza";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const backend = await PostgresEventStorage.open(pool, {
  tenantId: authenticatedUserId, // trusted server identity
  workspaceId: "my-service",
  scopeId: "chat",
  threadId: `user:${authenticatedUserId}`, // optional event/index restriction
});
const store = await AsyncProjectionStore.open(backend);
let session;
try {
  session = await createSessionFacade({
    ...yourSessionOptions,
    workspaceId: store.workspace_id,
    store,
    threadId: `user:${authenticatedUserId}`,
  });
  await session.facade.prompt("hello");
} finally {
  try {
    if (session) await session.facade.disposeAsync();
    else await store.closeAsync();
  } finally {
    await pool.end(); // only for a pool owned by this host
  }
}
```

The host supplies the `pg` pool; `pg` is declared as an optional peer dependency
(`^8.11.0`), so CLI/SQLite installs never pull it in. Node 22.13+ is required
(`engines`) for the unflagged `node:sqlite` projection and legacy reader. Existing
SQLite callers retain `dispose()`. Async callers should await `disposeAsync()` or
`closeAsync()`; a plain `dispose()` only starts a best-effort background flush and
close, so its errors are logged instead of surfaced. Closing a store that has
already failed still releases the connection, then rejects with that failure. A facade owns its injected store; do not share one store between
separately owned facades.

## Durability and API semantics

`AsyncEventStorage` is the authoritative asynchronous backend interface.
`AsyncProjectionStore` preserves synchronous engine/projection reads without
blocking Node on network I/O. Its `append()` stages an event. Durable events reach
subscribers only after a successful database transaction. `flush()` explicitly
waits for all pending event/index writes and may reject. Runtime prompts flush
before starting, before external model/tool calls, and before returning success.

Persistence failures poison the instance, stop event dispatch and reject active
prompts. A fresh instance reconstructs committed state. There is no fallback to
writing a local authoritative database. Message chunks remain transient; complete
messages, model/tool events and session metadata are durable. Normal PostgreSQL
WAL/fsync/synchronous-commit settings should remain enabled.

Every query/key contains tenant, workspace and scope. A scope leases one physical
PostgreSQL connection plus a session advisory lock until closed. A second writer
for that scope is rejected; independent scopes can run concurrently. Use direct
PostgreSQL connections or session pooling, not transaction-mode PgBouncer.

Sequences are scope-local and increasing. Event IDs and idempotency keys are
unique within a scope. Each batch and its accompanying session index commit
atomically under a head compare-and-swap check. An index watermark supports crash
replay; existing interrupted-turn recovery runs while the scope is exclusively
leased. These mechanisms do not make arbitrary external tools exactly-once.

JSON event/index bodies use text so escaped control characters are preserved.
Frequently queried fields have normal columns and B-tree indexes rather than a
full-payload GIN index on every append.

## Projection and operational bounds

The projection defaults to SQLite `:memory:`, rebuilt from PostgreSQL on every
open. PostgreSQL restores 256 events at a time, so a disk projection
(`projectionPath`) avoids holding the whole history as JavaScript objects or
in-memory SQLite pages. The projection never writes the local Pizza workspace
`meta.json`.

Without `reuseProjection`, `projectionPath` must point at an empty or missing
file; a non-empty file is rejected rather than trusted.

### Warm restarts (`reuseProjection`)

Opening a scope otherwise replays its full log, so cold latency scales with
history. Long-lived hosts can keep a per-scope cache file:

```ts
const store = await AsyncProjectionStore.open(backend, {
  projectionPath: `/var/lib/my-service/projections/${scopeKey}.sqlite`,
  reuseProjection: true,
});
```

The cache is resumed only if it was built from the same log (backend
`identity`: schema, tenant, workspace and scope) **and** its head event is
committed in PostgreSQL at the same sequence. Then only newer events are
streamed. Any other cache (different scope, uncommitted tail after a crash,
diverged history, unknown file) is deleted and rebuilt. The session index is
always replaced by the PostgreSQL copy. The cache is still disposable, not an
authority or backup: protect it as private data (it contains conversation
content) and never share one file between concurrently open scopes.

Context compaction does not delete old events. Measure restore time and large
payloads as well as append latency. Each active scope consumes one connection;
bound worker concurrency and the total pool budget together. The adapter does
not add distributed task scheduling or promise production throughput.

The PostgreSQL adapter explicitly rejects cross-workspace reference forks.
Same-scope sessions and forks remain supported. Default SQLite retains its
existing cross-workspace behavior.

## One-time legacy import

With the old writer stopped and the new PG scope leased, import **before**
opening the projection (importing after `AsyncProjectionStore.open()` is rejected,
because the projection would silently miss the imported history):

```ts
const backend = await PostgresEventStorage.open(pool, scope);
await backend.importLegacy(() => readSqliteEventSnapshot(path, workspaceId));
const store = await AsyncProjectionStore.open(backend);
```

The SQLite reader takes a consistent read-only snapshot of events, threads,
sessions and the index watermark. Import preserves event IDs, sequences and
metadata in one transaction. A marker makes repeats a no-op without reopening
the source. Non-empty unmarked PG scopes reject import instead of merging
histories. Tenant/thread restrictions apply to imports too. Keep source backups;
never import a shared legacy log into an arbitrary user's private scope.

## Testing

`test/postgres-storage.integration.test.ts` runs against a real server and is
skipped unless `PIZZA_TEST_PG_URL` is set. It uses an isolated, dropped schema.

```sh
docker run -d --name pizza-pg-test -e POSTGRES_PASSWORD=pizza -e POSTGRES_DB=pizza -p 55432:5432 postgres:15
PIZZA_TEST_PG_URL=postgres://postgres:pizza@localhost:55432/pizza npm run test:pg
```

`pg` is only a dev dependency used by these tests.
