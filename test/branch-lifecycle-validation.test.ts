import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { SessionProjection } from "../src/core/projection/session-projection.js";
import { Reactor } from "../src/core/runtime/reactor.js";
import { DefaultRetryPolicy } from "../src/core/runtime/policies.js";
import { LocalRuntimeAdapter } from "../src/core/runtime/local-runtime.js";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import { IntentClassifier } from "../src/core/intent/classifier.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import { createExtensionRuntime } from "../src/core/extensions/loader.js";
import { EventStoreExtensionSessionManager } from "../src/core/extensions/session-context.js";
import { AuthStorage } from "../src/core/auth/auth-storage.js";
import { ModelRegistry } from "../src/core/models/model-registry.js";
import { SessionFacade } from "../src/core/session/session-facade.js";
import { SettingsManager } from "../src/core/config/settings-manager.js";
import type { Extension, ToolCallEventResult } from "../src/core/extensions/types.js";
import type { ToolRegistry } from "../src/core/intent/types.js";
import type { LLMResponse } from "../src/core/runtime/llm-types.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); });
const empty: ToolRegistry = { get: () => undefined, list: () => [] };
const answer = (): LLMResponse => ({ content: [{ type: "text", text: "done" }], provider: "test", model: "test", stopReason: "stop", usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 } });
function workspace() { const dir = mkdtempSync(join(tmpdir(), "pizza-lifecycle-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function projection(store: SqliteEventStore) {
	return new SessionProjection(store, { session_id: "s", thread_id: "t", workspace_id: store.workspace_id, created_at: 0, created_by: "user_explicit", event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" } });
}

describe("branch lifecycle validation", () => {
	it("retries a stalled stream without aborting the turn-level signal", async () => {
		const store = new SqliteEventStore("watchdog", ":memory:"); cleanups.push(() => store.close());
		const cwd = workspace();
		let calls = 0;
		let stalledSignal: AbortSignal | undefined;
		const reactor = new Reactor({
			store, projection: projection(store), classifier: new IntentClassifier({ approve_unknown: false }), toolRegistry: empty,
			runtimeAdapter: new LocalRuntimeAdapter({ workspace_id: store.workspace_id, cwd, agentDir: cwd, toolRegistry: empty }),
			contextBudget: 128000, systemPrompt: "", tools: [], model: { provider: "test", model_id: "test" },
			retryPolicy: new DefaultRetryPolicy({ baseDelayMs: 1, maxAttempts: 1 }),
			llmClient: { async complete(request) {
				calls++;
				if (calls === 1) {
					stalledSignal = request.signal;
					return new Promise((_, reject) => request.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
				}
				expect(reactor.signal?.aborted).toBe(false);
				return answer();
			} },
		});
		(reactor as unknown as { _streamIdleTimeoutMs: number })._streamIdleTimeoutMs = 25;
		cleanups.push(() => reactor.stop());
		await reactor.start();
		const completed = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("watchdog retry did not settle")), 2000);
			const unsub = store.subscribe(() => { clearTimeout(timer); unsub(); resolve(); }, { types: ["AGENT_TURN_COMPLETED"] });
		});
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "retry stalled stream" } });
		await completed;
		expect(calls).toBe(2);
		expect(stalledSignal?.aborted).toBe(true);
		expect(reactor.signal?.aborted).toBe(false);
		expect(store.query({ types: ["LLM_CALL_FAILED"] })[0].payload).toMatchObject({ retryable: true });
		expect(JSON.stringify(store.query({ types: ["LLM_CALL_FAILED"] }))).toContain("connection stalled, timed out");
	});

	it("throttles persisted tool updates while preserving the complete final result", async () => {
		const cwd = workspace();
		const registry: ToolRegistry = { list: () => ["echo"], get: () => ({
			getMetadata: () => ({ name: "echo", category: "file_read", defaultRisk: "safe" }),
			async execute(_args, options) {
				const now = vi.spyOn(Date, "now").mockReturnValue(100000);
				try { for (let i = 0; i < 1000; i++) options?.onUpdate?.({ content: [{ type: "text", text: `partial ${i}` }], progress: i / 1000 }); }
				finally { now.mockRestore(); }
				return { content: [{ type: "text", text: "complete final result" }], is_error: false };
			},
		}) };
		let calls = 0;
		const runtime = new EventSourcedRuntime({ cwd, agentDir: cwd, storagePath: ":memory:", toolRegistry: registry,
			classifierConfig: { approve_unknown: false }, systemPrompt: "", tools: [], model: { provider: "test", model_id: "test" },
			llmClient: { async complete() { return ++calls === 1 ? { ...answer(), content: [{ type: "tool_call", id: "echo-call", name: "echo", arguments: {} }], stopReason: "tool_use" } : answer(); } },
		}); cleanups.push(() => runtime.dispose());
		await runtime.prompt("run echo");
		expect(runtime.store.query({ types: ["TOOL_EXECUTION_UPDATE"] })).toHaveLength(1);
		expect(runtime.store.query({ types: ["TOOL_EXECUTION_END"] })[0].payload).toMatchObject({ result: [{ type: "text", text: "complete final result" }] });
	});

	it("silent per-turn prompts update the runtime without persisting config churn", () => {
		const cwd = workspace();
		const runtime = new EventSourcedRuntime({ cwd, agentDir: cwd, storagePath: ":memory:", toolRegistry: empty, llmClient: { complete: async () => answer() }, systemPrompt: "base", tools: [], model: { provider: "test", model_id: "test" } });
		cleanups.push(() => runtime.dispose());
		runtime.setSystemPrompt("transient injection", { silent: true });
		expect(runtime.getSystemPrompt()).toBe("transient injection");
		expect(runtime.store.query({ types: ["USER_CONFIG_CHANGE"] })).toHaveLength(0);
		runtime.setSystemPrompt("explicit user change");
		expect(runtime.store.query({ types: ["USER_CONFIG_CHANGE"] })).toHaveLength(1);
	});

	it("finishes disposal even when one hook throws, and remains idempotent", () => {
		const cwd = workspace();
		const runtime = new EventSourcedRuntime({ cwd, agentDir: cwd, storagePath: ":memory:", toolRegistry: empty, llmClient: { complete: async () => answer() }, systemPrompt: "", tools: [], model: { provider: "test", model_id: "test" } });
		cleanups.push(() => runtime.dispose());
		const dispose = vi.spyOn(runtime, "dispose");
		const remaining = vi.fn();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const facade = new SessionFacade({ runtime, settingsManager: SettingsManager.inMemory(), disposers: [() => { throw new Error("hook failure"); }, remaining] });
		facade.dispose(); facade.dispose();
		expect(remaining).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(runtime.store.query({})).toEqual([]);
	});

	it("reports a broken extension hook and still lets the next hook block the tool", async () => {
		const store = new SqliteEventStore("extensions", ":memory:"); cleanups.push(() => store.close());
		const cwd = workspace();
		const next = vi.fn(async (): Promise<ToolCallEventResult> => ({ block: true, reason: "test guard" }));
		const extension = (path: string, handler: Extension["handlers"] extends Map<string, Array<infer H>> ? H : never): Extension => ({
			path, resolvedPath: path, sourceInfo: { path, source: "test", scope: "temporary", origin: "top-level" } as never,
			handlers: new Map([["tool_call", [handler]]]), tools: new Map(), builtinCommands: new Map(), commands: new Map(), messageRenderers: new Map(), flags: new Map(), shortcuts: new Map(),
		});
		const runner = new ExtensionRunner([extension("broken", async () => { throw new Error("bad hook"); }), extension("guard", next)], createExtensionRuntime(), cwd,
			new EventStoreExtensionSessionManager({ store, projection: projection(store), cwd }), ModelRegistry.inMemory(AuthStorage.inMemory()));
		const error = vi.fn(); runner.onError(error);
		const result = await runner.emitToolCall({ type: "tool_call", toolCallId: "test", toolName: "read", input: { path: "file" } });
		expect(result).toEqual({ block: true, reason: "test guard" });
		expect(next).toHaveBeenCalledTimes(1);
		expect(error).toHaveBeenCalledWith(expect.objectContaining({ extensionPath: "broken", event: "tool_call", error: "bad hook" }));
	});
});
