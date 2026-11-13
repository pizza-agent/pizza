import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatEventMatchesSession, chatSessionTransition, type ChatSessionIdentity } from "../apps/web/src/lib/session-events";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { SessionManager } from "../src/core/projection/session-manager.js";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import type { EventBase } from "../src/core/event-store/types.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

describe("chat session event routing", () => {
	const current = { sessionId: "old", threadId: "thread-old" };
	it("adopts a historical continuation without clearing the conversation", () => {
		const next = chatSessionTransition({ type: "SESSION_CREATED", thread_id: "thread-new", payload: { session_id: "new", context_parent_session_id: "old" } }, current)!;
		expect(next).toEqual({ sessionId: "new", threadId: "thread-new", preserveHistory: true });
		for (const type of ["USER_MESSAGE", "AGENT_MESSAGE_START", "AGENT_MESSAGE_CHUNK", "TOOL_EXECUTION_START", "AGENT_TURN_COMPLETED"]) {
			expect(chatEventMatchesSession({ type, thread_id: "thread-new" }, next)).toBe(true);
			expect(chatEventMatchesSession({ type, thread_id: "thread-old" }, next)).toBe(false);
		}
	});
	it("follows a reused continuation before the state snapshot arrives", () => {
		expect(chatSessionTransition({ type: "SESSION_JUMPED", thread_id: "thread-new", payload: { target_session_id: "existing", context_parent_session_id: "old", background: true } }, current)).toEqual({ sessionId: "existing", threadId: "thread-new", preserveHistory: true });
	});
	it("ignores scheduler hops and continuations of other sessions", () => {
		for (const event of [
			{ type: "SESSION_CREATED", payload: { session_id: "task", created_by: "schedule" } },
			{ type: "SESSION_CREATED", payload: { session_id: "other", context_parent_session_id: "elsewhere" } },
			{ type: "SESSION_JUMPED", payload: { target_session_id: "task", background: true } },
			{ type: "SESSION_JUMPED", payload: { target_session_id: "task", context_parent_session_id: "elsewhere", background: true } },
		]) expect(chatSessionTransition(event, current)).toBeUndefined();
		expect(chatSessionTransition({ type: "SESSION_JUMPED", payload: { target_session_id: "task", background: true } }, {})).toBeUndefined();
	});
	it("reloads explicit navigation, including hidden continuation targets", () => {
		expect(chatSessionTransition({ type: "SESSION_JUMPED", thread_id: "thread-new", payload: { target_session_id: "new", context_parent_session_id: "source", direct: true } }, current)).toEqual({ sessionId: "new", threadId: "thread-new", preserveHistory: false });
		expect(chatSessionTransition({ type: "SESSION_JUMPED", payload: { target_session_id: "old", reopened_as: "fork" } }, current)?.sessionId).toBe("fork");
	});
	it("updates mid-turn session boundaries without dropping the streaming bubble", () => {
		expect(chatSessionTransition({ type: "SESSION_BOUNDARY_INFERRED", thread_id: current.threadId, payload: { new_session_id: "split" } }, current)).toEqual({ sessionId: "split", threadId: current.threadId, preserveHistory: true });
	});
	it("keeps explicit session tags isolated even within the same thread", () => {
		expect(chatEventMatchesSession({ type: "USER_MESSAGE", session_id: "elsewhere", thread_id: current.threadId }, current)).toBe(false);
		expect(chatEventMatchesSession({ type: "USER_MESSAGE", payload: { sessionId: current.sessionId } }, current)).toBe(true);
	});

	it("routes every turn after historical navigation without waiting for get_state", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pizza-history-chat-"));
		cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
		const store = new SqliteEventStore("history-chat", ":memory:");
		cleanups.push(() => store.close());
		const manager = new SessionManager(store, store);
		const first = manager.createSession("user_explicit", "first");
		const runtime = new EventSourcedRuntime({ cwd, agentDir: cwd, store, sessionManager: manager,
			toolRegistry: { get: () => undefined, list: () => [] }, tools: [], systemPrompt: "test",
			model: { provider: "test", model_id: "test" },
			llmClient: { async complete() { return { content: [{ type: "text", text: "reply" }], provider: "test", model: "test", usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 }, stopReason: "stop" }; } },
		});
		cleanups.push(() => runtime.dispose());
		await runtime.prompt("first context");
		const second = runtime.createSession()!;
		await runtime.prompt("second context");
		let visible: ChatSessionIdentity = { sessionId: second.session_id, threadId: second.thread_id };
		const accepted: EventBase[] = [];
		cleanups.push(store.subscribe((event) => {
			visible = chatSessionTransition(event, visible) ?? visible;
			if (chatEventMatchesSession(event, visible)) accepted.push(event);
		}));
		manager.switchToExistingSession(first.session_id, "history row click");
		await runtime.prompt("continue first");
		const continuation = manager.getActiveSessionId()!;
		expect(visible.sessionId).toBe(continuation);
		expect(continuation).not.toBe(first.session_id);
		await runtime.prompt("another turn");
		manager.switchToExistingSession(second.session_id);
		manager.switchToExistingSession(manager.resolveSwitchTargetSession(first.session_id).session_id);
		await runtime.prompt("returned again");
		expect(accepted.filter((e) => e.type === "USER_MESSAGE").map((e) => (e.payload as { content: string }).content)).toEqual(["continue first", "another turn", "returned again"]);
		expect(accepted.filter((e) => e.type === "AGENT_MESSAGE_END")).toHaveLength(3);
		expect(accepted.filter((e) => e.type === "AGENT_TURN_COMPLETED")).toHaveLength(3);
		const history = JSON.stringify(runtime.getProjection().buildContext().messages);
		for (const text of ["first context", "continue first", "another turn", "returned again"]) expect(history).toContain(text);
		expect(history).not.toContain("second context");
	});
});
