import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { SessionProjection } from "../src/core/projection/session-projection.js";
import { TurnState } from "../src/core/runtime/turn-state.js";
import { estimateContextTokens } from "../src/core/compaction/compaction.js";
import { ChannelRuntime, type ChannelBridge } from "../packages/channels/runtime.js";
import { devinStreamSimple } from "../src/core/devin/stream.js";
import { encodeConnectFrame } from "../src/core/devin/client.js";
import { execCommand } from "../src/core/exec/exec.js";
import type { SessionDescriptor } from "../src/core/projection/types.js";
import type { AgentMessage } from "../src/core/agent/types.js";
import type { Model, Api } from "@earendil-works/pi-ai/compat";

const dirs: string[] = [];
const stores: SqliteEventStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function dir() { const value = mkdtempSync(join(tmpdir(), "pizza-branch-check-")); dirs.push(value); return value; }
function store(path = ":memory:") { const value = new SqliteEventStore("branch-check", path); stores.push(value); return value; }
function descriptor(): SessionDescriptor {
	return { session_id: "session", thread_id: "thread", workspace_id: "branch-check", event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" }, created_by: "user_explicit", created_at: 0 };
}
function user(db: SqliteEventStore, content: string) {
	return db.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content } });
}

describe("branch context caching and replay validation", () => {
	it("reuses a built context until a persisted event arrives, then invalidates it", () => {
		const db = store(); user(db, "first");
		const projection = new SessionProjection(db, descriptor());
		const first = projection.buildContext();
		expect(projection.buildContext()).toBe(first);
		db.append({ actor_id: "runtime", type: "AGENT_MESSAGE_CHUNK", payload: { chunk: { kind: "text_delta", delta: "transient" } } });
		expect(projection.buildContext()).toBe(first);
		user(db, "second");
		expect(projection.buildContext().messages).toHaveLength(2);
		expect(projection.buildContext()).not.toBe(first);
	});

	it("invalidates the cached projection when another SQLite connection appends", () => {
		const dbPath = join(dir(), "events.sqlite");
		const reader = store(dbPath); const writer = store(dbPath);
		user(reader, "first");
		const projection = new SessionProjection(reader, descriptor());
		expect(projection.buildContext().messages).toHaveLength(1);
		user(writer, "external writer");
		expect(projection.buildContext().messages).toHaveLength(2);
	});

	it("invalidates cached context on descriptor update without a new event", () => {
		const db = store(); user(db, "first"); const second = user(db, "second");
		const projection = new SessionProjection(db, descriptor());
		expect(projection.buildContext().messages).toHaveLength(2);
		projection.updateDescriptor({ event_range: { start_event_id: "ORIGIN", end_event_id: second.event_id } });
		expect(projection.buildContext().messages).toHaveLength(1);
	});

	it("does not revive pre-compaction usage when compaction and assistant share a timestamp", () => {
		const messages: AgentMessage[] = [
			{ role: "compactionSummary", summary: "short summary", tokensBefore: 10000, timestamp: 100 },
			{ role: "assistant", content: [{ type: "text", text: "kept" }], api: "openai-completions", provider: "test", model: "test", stopReason: "stop", timestamp: 100,
				usage: { input: 10000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 10001, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
		];
		expect(estimateContextTokens(messages).tokens).toBeLessThan(20);
		expect(estimateContextTokens(messages).usageTokens).toBe(0);
	});

	it("keeps this run's pending follow-up after more than 100 other runtimes start", () => {
		const db = store(); const state = new TurnState("our-run");
		db.append({ actor_id: "runtime", type: "RUNTIME_STARTED", payload: { run_id: "our-run" } });
		db.append({ actor_id: "user", type: "USER_FOLLOWUP_QUEUED", payload: { content: "must survive", run_id: "our-run" } });
		for (let i = 0; i < 101; i++) db.append({ actor_id: "runtime", type: "RUNTIME_STARTED", payload: { run_id: `other-${i}` } });
		expect(state.replayFollowUpsFromLog(db).map((entry) => entry.content)).toEqual(["must survive"]);
	});

	it("terminates a corrupt causal cycle instead of looping", () => {
		const db = store();
		db.append({ actor_id: "user", type: "USER_MESSAGE", event_id: "cycle-a", caused_by: "cycle-b", payload: { content: "a" } });
		db.append({ actor_id: "user", type: "USER_MESSAGE", event_id: "cycle-b", caused_by: "cycle-a", payload: { content: "b" } });
		expect(db.getCausalChain("cycle-a")).toHaveLength(2);
	});
});

describe("branch channel and provider error validation", () => {
	it("retains correlation and returns the final reply across 2000 deltas before the tell ack", async () => {
		let listener: Parameters<ChannelBridge["onEvent"]>[0] | undefined;
		const bridge: ChannelBridge = {
			attach: async (ws) => ws, detach: async () => {},
			onEvent: (handler) => { listener = handler; return () => { listener = undefined; }; },
			tell: async (ws) => {
				listener!({ type: "USER_MESSAGE", payload: { content: '<message id="m_validation">hello</message>' } }, ws);
				for (let i = 0; i < 1000; i++) {
					listener!({ type: "AGENT_MESSAGE_CHUNK", payload: { chunk: { kind: "text_delta", delta: "partial" } } }, ws);
					listener!({ type: "TOOL_EXECUTION_UPDATE", payload: {} }, ws);
				}
				listener!({ type: "AGENT_TURN_COMPLETED" }, ws);
				return { messageId: "m_validation" };
			},
			sendToWorkspace: vi.fn(async () => ({ success: true, data: { text: "authoritative final reply" } })),
		};
		const runtime = new ChannelRuntime({ agentDir: dir(), bridge, onFatal: () => {}, tellTimeoutMs: 500 });
		await runtime.start();
		try {
			expect(await runtime.deliver("/fixture", "hi", { kind: "webhook", id: "fixture" })).toBe("authoritative final reply");
			expect(bridge.sendToWorkspace).toHaveBeenCalledTimes(1);
		} finally { await runtime.stop(); }
	});

	it.each(["STOP_REASON_ERROR", "STOP_REASON_ABORTED", "STOP_REASON_FAILED"])("surfaces %s even with a partial tool call", async (stopReason) => {
		const frames = [
			{ deltaToolCalls: [{ id: "partial", name: "cli", argumentsJson: '{"command":' }] },
			{ stopReason },
		];
		const bytes = Buffer.concat(frames.map((frame) => Buffer.from(encodeConnectFrame(new TextEncoder().encode(JSON.stringify(frame))))));
		const fetch = vi.fn(async () => new Response(bytes, { status: 200, headers: { "content-type": "application/connect+json" } }));
		const model = { id: "swe-2", api: "devin", provider: "devin", baseUrl: "https://fixture.invalid", maxTokens: 1000 } as Model<Api>;
		const stream = devinStreamSimple(model, { messages: [{ role: "user", content: "test", timestamp: 0 }] }, { apiKey: "fixture-only", fetch });
		const events = [];
		for await (const event of stream) events.push(event.type);
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(stopReason);
		expect(events).toContain("error");
		expect(events).not.toContain("done");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

describe("bounded command capture", () => {
	it("bounds stdout and stderr independently while preserving the tail", async () => {
		const result = await execCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(5*1024*1024)+'STDOUT_END');process.stderr.write('y'.repeat(5*1024*1024)+'STDERR_END')"], dir());
		expect(result.code).toBe(0);
		expect(result.stdout.length).toBeLessThanOrEqual(4 * 1024 * 1024);
		expect(result.stderr.length).toBeLessThanOrEqual(4 * 1024 * 1024);
		expect(result.stdout.endsWith("STDOUT_END")).toBe(true);
		expect(result.stderr.endsWith("STDERR_END")).toBe(true);
	});
});
