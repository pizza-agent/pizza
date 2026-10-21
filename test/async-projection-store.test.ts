import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AsyncProjectionStore } from "../src/core/event-store/async-projection-store.js";
import type { AsyncEventStorage, EventStorageSnapshot } from "../src/core/event-store/async-storage.js";
import type { EventBase } from "../src/core/event-store/types.js";
import { SessionManager } from "../src/core/projection/session-manager.js";
import { ThreadScopedStore } from "../src/core/event-store/thread-scoped-store.js";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";

class Backend implements AsyncEventStorage {
	workspace_id = "ws";
	snapshot: EventStorageSnapshot = { events: [] };
	beforeCommit?: (events: EventBase[]) => Promise<void>;
	async load() {
		return structuredClone(this.snapshot);
	}
	async commit(events: EventBase[], index?: EventStorageSnapshot["index"]) {
		await this.beforeCommit?.(events);
		this.snapshot.events.push(...structuredClone(events));
		if (index) this.snapshot.index = structuredClone(index);
	}
	closed = 0;
	async close() {
		this.closed++;
	}
}
/** Backend that supports verified projection-cache resume. */
class ResumableBackend extends Backend {
	identity = "fake:scope-1";
	restored: number[] = [];
	async restore(accept: (page: EventBase[]) => void, options: { afterSequence?: number } = {}) {
		const tail = this.snapshot.events.filter((event) => event.sequence > (options.afterSequence ?? 0));
		this.restored.push(tail.length);
		if (tail.length) accept(structuredClone(tail));
		return structuredClone(this.snapshot.index);
	}
	async eventIdAt(sequence: number) {
		return this.snapshot.events.find((event) => event.sequence === sequence)?.event_id;
	}
}
const message = {
	type: "USER_MESSAGE" as const,
	actor_id: "user",
	thread_id: "a",
	payload: { content: "secret from a" },
};

describe("asynchronous durable storage with synchronous projections", () => {
	it("dispatches only after commit, batches index, and keeps deltas transient", async () => {
		const backend = new Backend();
		const store = await AsyncProjectionStore.open(backend);
		let release!: () => void;
		backend.beforeCommit = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});
		const received: EventBase[] = [];
		store.subscribe((event) => received.push(event));
		store.append(message);
		const flush = store.flush();
		expect(received).toHaveLength(0);
		expect(backend.snapshot.events).toHaveLength(0);
		release();
		await flush;
		expect(received).toHaveLength(1);
		store.append({ ...message, type: "AGENT_MESSAGE_CHUNK", payload: { delta: "hi" } });
		expect(received).toHaveLength(2);
		expect(backend.snapshot.events).toHaveLength(1);
		backend.beforeCommit = undefined;
		await store.closeAsync();
	});
	it("rebuilds context and session index after restart, preserving thread isolation and idempotency", async () => {
		const backend = new Backend();
		let store = await AsyncProjectionStore.open(backend);
		let sessions = new SessionManager(store, store);
		sessions.useThread("a");
		const sessionId = sessions.getActiveSessionId();
		const first = store.append({ ...message, idempotency_key: "once" });
		expect(store.append({ ...message, idempotency_key: "once" }).event_id).toBe(first.event_id);
		sessions.useThread("b");
		new ThreadScopedStore(store, "b").append({ ...message, payload: { content: "from b" } });
		await store.closeAsync();
		store = await AsyncProjectionStore.open(backend);
		sessions = new SessionManager(store, store);
		sessions.useThread("a");
		expect(sessions.getActiveSessionId()).toBe(sessionId);
		expect(JSON.stringify(sessions.getActiveSession().buildContext())).toContain("secret from a");
		expect(JSON.stringify(sessions.getActiveSession().buildContext())).not.toContain("from b");
		await store.closeAsync();
	});
	it("fails closed on persistence error and never dispatches uncommitted events", async () => {
		const backend = new Backend();
		const store = await AsyncProjectionStore.open(backend);
		backend.beforeCommit = async () => {
			throw Error("database offline");
		};
		const received: EventBase[] = [];
		let failure: Error | undefined;
		store.subscribe((event) => received.push(event));
		store.onPersistenceError((error) => {
			failure = error;
		});
		store.append(message);
		await expect(store.flush()).rejects.toThrow("database offline");
		expect(failure?.message).toBe("database offline");
		expect(received).toHaveLength(0);
		expect(() => store.append(message)).toThrow("database offline");
		await expect(store.closeAsync()).rejects.toThrow("database offline");
		expect(backend.snapshot.events).toHaveLength(0);
	});
	it("rejects a runtime prompt on database failure without invoking a model or hanging", async () => {
		const backend = new Backend();
		const store = await AsyncProjectionStore.open(backend);
		const sessions = new SessionManager(store, store);
		sessions.useThread("a");
		let calls = 0;
		const runtime = new EventSourcedRuntime({
			cwd: process.cwd(),
			store,
			ownsStore: true,
			sessionManager: sessions,
			threadId: "a",
			toolRegistry: { get: () => undefined, list: () => [] },
			llmClient: {
				complete: async () => {
					calls++;
					throw Error("must not call");
				},
			},
			systemPrompt: "test",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});
		await store.flush();
		backend.beforeCommit = async () => {
			throw Error("commit failed");
		};
		await expect(runtime.prompt("hello")).rejects.toThrow("commit failed");
		expect(calls).toBe(0);
		expect(runtime.isRunning).toBe(false);
		await expect(runtime.disposeAsync()).rejects.toThrow("commit failed");
	});
	it("does not execute a tool when its start event cannot be committed", async () => {
		const backend = new Backend();
		const store = await AsyncProjectionStore.open(backend);
		const sessions = new SessionManager(store, store);
		sessions.useThread("a");
		let executions = 0;
		const runtime = new EventSourcedRuntime({
			cwd: process.cwd(),
			store,
			ownsStore: true,
			sessionManager: sessions,
			threadId: "a",
			toolRegistry: {
				get: () => ({
					execute: async () => {
						executions++;
						return { content: [], is_error: false };
					},
					getMetadata: () => ({ name: "echo", category: "file_read", defaultRisk: "safe" }),
				}),
				list: () => ["echo"],
			},
			llmClient: {
				complete: async () => ({
					content: [{ type: "tool_call", id: "call-1", name: "echo", arguments: {} }],
					stopReason: "tool_use",
					usage: { input: 1, output: 1, total: 2, cost: 0, cache_read: 0, cache_write: 0 },
				}),
			},
			systemPrompt: "test",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});
		await store.flush();
		backend.beforeCommit = async (events) => {
			if (events.some((event) => event.type === "TOOL_EXECUTION_START")) throw Error("tool start commit failed");
		};
		await expect(runtime.prompt("use echo")).rejects.toThrow("tool start commit failed");
		expect(executions).toBe(0);
		await expect(runtime.disposeAsync()).rejects.toThrow("tool start commit failed");
	}, 5000);
	it("flush() waits for events staged while a previous drain is finishing", async () => {
		const backend = new Backend();
		const store = await AsyncProjectionStore.open(backend);
		let release!: () => void;
		backend.beforeCommit = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});
		store.append(message);
		const first = store.flush();
		await Promise.resolve();
		release();
		backend.beforeCommit = undefined;
		// Staged after the in-flight drain took its batch: must still be durable when flush() resolves.
		store.append({ ...message, payload: { content: "late" } });
		await first;
		await store.flush();
		expect(backend.snapshot.events.map((event) => event.payload)).toEqual([
			{ content: "secret from a" },
			{ content: "late" },
		]);
		await store.closeAsync();
	});
	it("commits the merged session index, matching SQLite upsert semantics", async () => {
		const backend = new Backend();
		const store = await AsyncProjectionStore.open(backend);
		const thread = (id: string) => ({ thread_id: id, workspace_id: "ws", created_at: 1, status: "active" as const });
		store.saveSessionIndex({ threads: [thread("a")], sessions: [], watermark_sequence: 0 });
		await store.flush();
		store.saveSessionIndex({ threads: [thread("b")], sessions: [], watermark_sequence: 0 });
		await store.flush();
		expect(backend.snapshot.index?.threads.map((t) => t.thread_id).sort()).toEqual(["a", "b"]);
		await store.closeAsync();
	});
	it("sync close() flushes and releases the backend for legacy dispose() callers", async () => {
		const backend = new Backend();
		const store = await AsyncProjectionStore.open(backend);
		store.append(message);
		store.close();
		expect(() => store.append(message)).toThrow("closed");
		await store.closeAsync();
		expect(backend.snapshot.events).toHaveLength(1);
		expect(backend.closed).toBe(1);
	});
	it("releases the backend even when closing a poisoned store", async () => {
		const backend = new Backend();
		const store = await AsyncProjectionStore.open(backend);
		backend.beforeCommit = async () => {
			throw Error("offline");
		};
		store.append(message);
		await expect(store.flush()).rejects.toThrow("offline");
		await expect(store.closeAsync()).rejects.toThrow("offline");
		expect(backend.closed).toBe(1);
	});
	it("releases the backend when restore fails", async () => {
		const backend = new Backend();
		backend.load = async () => {
			throw Error("restore failed");
		};
		await expect(AsyncProjectionStore.open(backend)).rejects.toThrow("restore failed");
		expect(backend.closed).toBe(1);
	});
	describe("projection cache reuse", () => {
		const withDir = async (fn: (path: string) => Promise<void>) => {
			const dir = mkdtempSync(join(tmpdir(), "pizza-projection-"));
			try {
				await fn(join(dir, "projection.sqlite"));
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		};
		it("resumes a verified cache and streams only newer events", () =>
			withDir(async (path) => {
				const backend = new ResumableBackend();
				let store = await AsyncProjectionStore.open(backend, { projectionPath: path, reuseProjection: true });
				store.appendBatch([message, message, message]);
				await store.closeAsync();
				// Another writer (cache-less) appends meanwhile.
				const other = await AsyncProjectionStore.open(backend);
				other.append({ ...message, payload: { content: "newer" } });
				await other.closeAsync();
				store = await AsyncProjectionStore.open(backend, { projectionPath: path, reuseProjection: true });
				expect(backend.restored.at(-1)).toBe(1);
				expect(store.size).toBe(4);
				expect(store.latest(1)[0]?.payload).toEqual({ content: "newer" });
				await store.closeAsync();
			}));
		it("discards a cache whose tail was never committed", () =>
			withDir(async (path) => {
				const backend = new ResumableBackend();
				let store = await AsyncProjectionStore.open(backend, { projectionPath: path, reuseProjection: true });
				store.append(message);
				await store.flush();
				backend.beforeCommit = async () => {
					throw Error("crash");
				};
				store.append({ ...message, payload: { content: "uncommitted" } });
				await expect(store.closeAsync()).rejects.toThrow("crash");
				backend.beforeCommit = undefined;
				store = await AsyncProjectionStore.open(backend, { projectionPath: path, reuseProjection: true });
				expect(backend.restored.at(-1)).toBe(1); // full rebuild
				expect(store.size).toBe(1);
				expect(JSON.stringify(store.query({}))).not.toContain("uncommitted");
				await store.closeAsync();
			}));
		it("discards a cache built from a different log", () =>
			withDir(async (path) => {
				const a = new ResumableBackend();
				let store = await AsyncProjectionStore.open(a, { projectionPath: path, reuseProjection: true });
				store.append({ ...message, payload: { content: "tenant a" } });
				await store.closeAsync();
				const b = new ResumableBackend();
				b.identity = "fake:scope-2";
				store = await AsyncProjectionStore.open(b, { projectionPath: path, reuseProjection: true });
				expect(store.size).toBe(0);
				await store.closeAsync();
			}));
		it("replaces, not merges, the cached session index", () =>
			withDir(async (path) => {
				const backend = new ResumableBackend();
				let store = await AsyncProjectionStore.open(backend, { projectionPath: path, reuseProjection: true });
				const thread = (id: string) => ({ thread_id: id, workspace_id: "ws", created_at: 1, status: "active" as const });
				store.saveSessionIndex({ threads: [thread("a")], sessions: [] });
				await store.closeAsync();
				backend.snapshot.index = { threads: [thread("b")], sessions: [] };
				store = await AsyncProjectionStore.open(backend, { projectionPath: path, reuseProjection: true });
				expect(store.getSessionIndex()?.threads.map((t) => t.thread_id)).toEqual(["b"]);
				await store.closeAsync();
			}));
		it("refuses a non-empty projection file without reuseProjection", () =>
			withDir(async (path) => {
				const backend = new ResumableBackend();
				const store = await AsyncProjectionStore.open(backend, { projectionPath: path, reuseProjection: true });
				store.append(message);
				await store.closeAsync();
				expect(existsSync(path)).toBe(true);
				await expect(AsyncProjectionStore.open(backend, { projectionPath: path })).rejects.toThrow("not empty");
			}));
	});
});
