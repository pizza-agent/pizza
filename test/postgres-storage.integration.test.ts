/**
 * Real PostgreSQL integration tests. Skipped unless PIZZA_TEST_PG_URL is set, e.g.
 *   docker run -d --name pizza-pg-test -e POSTGRES_PASSWORD=pizza -e POSTGRES_DB=pizza -p 55432:5432 postgres:15
 *   PIZZA_TEST_PG_URL=postgres://postgres:pizza@localhost:55432/pizza npx vitest --run test/postgres-storage.integration.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AsyncProjectionStore } from "../src/core/event-store/async-projection-store.js";
import { PostgresEventStorage, type PostgresStorageOptions } from "../src/core/event-store/postgres-storage.js";
import { readSqliteEventSnapshot } from "../src/core/event-store/sqlite-snapshot.js";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { SessionManager } from "../src/core/projection/session-manager.js";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";

const url = process.env.PIZZA_TEST_PG_URL;
const schema = `pizza_it_${process.pid}_${Date.now().toString(36)}`;
let pool: pg.Pool;
let n = 0;
const scope = (extra: Partial<PostgresStorageOptions> = {}): PostgresStorageOptions => ({
	tenantId: "tenant-a",
	workspaceId: "ws",
	scopeId: `scope-${++n}`,
	schema,
	...extra,
});
const message = (content: string, thread_id = "a") => ({
	type: "USER_MESSAGE" as const,
	actor_id: "user",
	thread_id,
	payload: { content },
});
async function open(options: PostgresStorageOptions, projectionPath?: string) {
	return AsyncProjectionStore.open(await PostgresEventStorage.open(pool, options), { projectionPath });
}
async function countEvents(options: PostgresStorageOptions): Promise<number> {
	const { rows } = await pool.query(
		`SELECT count(*)::int AS c FROM ${schema}.pizza_events WHERE tenant_id=$1 AND workspace_id=$2 AND scope_id=$3`,
		[options.tenantId, options.workspaceId, options.scopeId],
	);
	return rows[0].c;
}

describe.skipIf(!url)("PostgresEventStorage against a real server", () => {
	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: url, max: 20 });
		await pool.query(`CREATE SCHEMA ${schema}`);
	});
	afterAll(async () => {
		await pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
		await pool?.end();
	});

	it("round-trips events, ids, sequences and the session index across restarts", async () => {
		const options = scope();
		let store = await open(options);
		const sessions = new SessionManager(store, store);
		sessions.useThread("a");
		const tricky = "nul\u0000 tab\t quote\" emoji 🍕 \\u0000 literal";
		const first = store.append({ ...message(tricky), idempotency_key: "k1" });
		const second = store.append(message("second"));
		await store.closeAsync();

		store = await open(options);
		expect(store.get(first.event_id)).toMatchObject({ sequence: first.sequence, payload: { content: tricky } });
		expect(store.get(second.event_id)?.sequence).toBe(second.sequence);
		expect(store.append({ ...message("dup"), idempotency_key: "k1" }).event_id).toBe(first.event_id);
		const reopened = new SessionManager(store, store);
		reopened.useThread("a");
		expect(reopened.getActiveSessionId()).toBe(sessions.getActiveSessionId());
		await store.closeAsync();
	});

	it("serializes concurrent first-use DDL on a fresh schema", async () => {
		const fresh = `${schema}_ddl`;
		await pool.query(`CREATE SCHEMA ${fresh}`);
		try {
			const stores = await Promise.all(
				Array.from({ length: 8 }, (_, i) => open({ ...scope(), schema: fresh, scopeId: `c${i}` })),
			);
			stores.forEach((store, i) => store.append(message(`c${i}`)));
			await Promise.all(stores.map((store) => store.closeAsync()));
			const { rows } = await pool.query(`SELECT count(*)::int AS c FROM ${fresh}.pizza_events`);
			expect(rows[0].c).toBe(8);
		} finally {
			await pool.query(`DROP SCHEMA ${fresh} CASCADE`);
		}
	});

	it("restores more than one page (256 events)", async () => {
		const options = scope();
		let store = await open(options);
		store.appendBatch(Array.from({ length: 600 }, (_, i) => message(`m${i}`)));
		await store.closeAsync();
		store = await open(options);
		expect(store.size).toBe(600);
		expect(store.head_sequence).toBe(600);
		await store.closeAsync();
	});

	it("resumes a verified disk projection and only streams the new tail", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pizza-proj-"));
		try {
			const options = scope();
			const cache = join(dir, "projection.sqlite");
			const reuse = async () =>
				AsyncProjectionStore.open(await PostgresEventStorage.open(pool, options), {
					projectionPath: cache,
					reuseProjection: true,
				});
			let store = await reuse();
			store.appendBatch(Array.from({ length: 300 }, (_, i) => message(`m${i}`)));
			await store.closeAsync();
			// Another host without the cache appends more.
			store = await open(options);
			store.append(message("tail"));
			await store.closeAsync();

			const queries: string[] = [];
			const spyPool = {
				connect: async () => {
					const client = await pool.connect();
					const query = client.query.bind(client) as (sql: string, values?: unknown[]) => Promise<any>;
					return Object.assign(client, {
						query: (sql: string, values?: unknown[]) => {
							queries.push(sql);
							return query(sql, values);
						},
					});
				},
			};
			store = await AsyncProjectionStore.open(await PostgresEventStorage.open(spyPool as any, options), {
				projectionPath: cache,
				reuseProjection: true,
			});
			expect(store.size).toBe(301);
			expect(store.latest(1)[0]?.payload).toEqual({ content: "tail" });
			// One page with the tail plus one empty page — not a 2-page full replay.
			expect(queries.filter((sql) => sql.includes("ORDER BY sequence LIMIT 256"))).toHaveLength(2);
			await store.closeAsync();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leases a scope to exactly one writer and releases it on close", async () => {
		const options = scope();
		const store = await open(options);
		await expect(PostgresEventStorage.open(pool, options)).rejects.toThrow("active writer");
		const other = await open({ ...options, scopeId: `${options.scopeId}-other` });
		await other.closeAsync();
		await store.closeAsync();
		const again = await open(options);
		await again.closeAsync();
	});

	it("isolates tenants sharing workspace and scope ids", async () => {
		const a = scope();
		const storeA = await open(a);
		storeA.append(message("only for a"));
		await storeA.closeAsync();
		const storeB = await open({ ...a, tenantId: "tenant-b" });
		expect(storeB.size).toBe(0);
		await storeB.closeAsync();
	});

	it("rejects events outside the server-enforced thread restriction", async () => {
		const options = scope({ threadId: "a" });
		const store = await open(options);
		const failures: Error[] = [];
		store.onPersistenceError((error) => failures.push(error));
		store.append(message("foreign", "b"));
		await expect(store.flush()).rejects.toThrow("scope mismatch");
		expect(failures).toHaveLength(1);
		await expect(store.closeAsync()).rejects.toThrow("scope mismatch");
		expect(await countEvents(options)).toBe(0);
	});

	it("detects a concurrent head change via compare-and-swap and rolls back", async () => {
		const options = scope();
		const store = await open(options);
		store.append(message("one"));
		await store.flush();
		await pool.query(
			`UPDATE ${schema}.pizza_event_scopes SET head_sequence = head_sequence + 100 WHERE tenant_id=$1 AND workspace_id=$2 AND scope_id=$3`,
			[options.tenantId, options.workspaceId, options.scopeId],
		);
		store.append(message("two"));
		await expect(store.flush()).rejects.toThrow("changed under active writer");
		await expect(store.closeAsync()).rejects.toThrow();
		expect(await countEvents(options)).toBe(1);
	});

	it("imports a legacy SQLite database once, preserving ids and sessions", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pizza-legacy-"));
		try {
			const path = join(dir, "events.sqlite");
			const legacy = new SqliteEventStore("ws", path);
			const legacySessions = new SessionManager(legacy, legacy);
			legacySessions.useThread("a");
			const old = legacy.append(message("from sqlite"));
			const sessionId = legacySessions.getActiveSessionId();
			const legacyCount = legacy.size;
			legacy.close();

			const options = scope();
			let backend = await PostgresEventStorage.open(pool, options);
			expect(await backend.importLegacy(() => readSqliteEventSnapshot(path, "ws"))).toBe(true);
			let store = await AsyncProjectionStore.open(backend);
			expect(store.size).toBe(legacyCount);
			expect(store.get(old.event_id)?.payload).toEqual({ content: "from sqlite" });
			const sessions = new SessionManager(store, store);
			sessions.useThread("a");
			expect(sessions.getActiveSessionId()).toBe(sessionId);
			store.append(message("after import"));
			await store.closeAsync();

			backend = await PostgresEventStorage.open(pool, options);
			expect(
				await backend.importLegacy(() => {
					throw Error("source must not be reopened");
				}),
			).toBe(false);
			store = await AsyncProjectionStore.open(backend);
			expect(store.size).toBe(legacyCount + 1);
			await store.closeAsync();

			const populated = scope();
			store = await open(populated);
			store.append(message("native"));
			await store.closeAsync();
			backend = await PostgresEventStorage.open(pool, populated);
			await expect(backend.importLegacy(() => readSqliteEventSnapshot(path, "ws"))).rejects.toThrow("non-empty");
			await backend.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs a full runtime prompt with every durable event committed to PostgreSQL", async () => {
		const options = scope({ threadId: "a" });
		const store = await open(options);
		const sessions = new SessionManager(store, store);
		sessions.useThread("a");
		const runtime = new EventSourcedRuntime({
			cwd: process.cwd(),
			store,
			ownsStore: true,
			sessionManager: sessions,
			threadId: "a",
			toolRegistry: { get: () => undefined, list: () => [] },
			llmClient: {
				complete: async ({ onChunk }: any) => {
					onChunk?.({ type: "text_delta", delta: "hi" });
					return {
						content: [{ type: "text", text: "hi there" }],
						stopReason: "stop",
						usage: { input: 1, output: 1, total: 2, cost: 0, cache_read: 0, cache_write: 0 },
					};
				},
			},
			systemPrompt: "test",
			model: { provider: "test", model_id: "test" },
			tools: [],
		} as any);
		await runtime.prompt("hello");
		const { rows } = await pool.query(
			`SELECT type FROM ${schema}.pizza_events WHERE tenant_id=$1 AND workspace_id=$2 AND scope_id=$3 ORDER BY sequence`,
			[options.tenantId, options.workspaceId, options.scopeId],
		);
		const types = rows.map((row) => row.type);
		expect(types).toContain("USER_MESSAGE");
		expect(types).toContain("AGENT_MESSAGE_END");
		expect(types).toContain("AGENT_TURN_COMPLETED");
		expect(types).not.toContain("AGENT_MESSAGE_CHUNK");
		await runtime.disposeAsync();
		// Lease released by disposeAsync.
		await (await PostgresEventStorage.open(pool, options)).close();
	});
});
