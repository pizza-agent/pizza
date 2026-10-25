/**
 * Session Projection tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { SessionProjection } from "../src/core/projection/session-projection.js";
import { SessionManager } from "../src/core/projection/session-manager.js";
import type { SessionDescriptor } from "../src/core/projection/types.js";

describe("SessionProjection", () => {
	const testDir = join(tmpdir(), ".test-pizza-projection", String(Date.now()));
	let store: SqliteEventStore;

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
		store = new SqliteEventStore("test-ws", join(testDir, "projection-events.sqlite"));
	});

	afterEach(() => {
		store.close();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	function createDescriptor(overrides?: Partial<SessionDescriptor>): SessionDescriptor {
		return {
			session_id: "sess_test",
			thread_id: "thread_test",
			workspace_id: "test-ws",
			event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" },
			created_by: "user_explicit",
			created_at: Date.now(),
			...overrides,
		};
	}

	it("should build empty context from empty store", () => {
		const projection = new SessionProjection(store, createDescriptor());
		const context = projection.buildContext();

		expect(context.messages).toHaveLength(0);
		expect(context.events).toHaveLength(0);
		expect(context.descriptor.session_id).toBe("sess_test");
	});

	it("should build context with user and agent messages", () => {
		store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "Hello agent" },
		});
		store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [{ type: "text", text: "Hello user" }],
				model: { provider: "anthropic", model_id: "claude-sonnet" },
				usage: { input: 10, output: 20, cache_read: 0, cache_write: 0, total: 30, cost: 0.001 },
				stop_reason: "stop",
			},
		});

		const projection = new SessionProjection(store, createDescriptor());
		const context = projection.buildContext();

		expect(context.messages).toHaveLength(2);
		expect(context.messages[0].role).toBe("user");
		expect(context.messages[1].role).toBe("assistant");
	});

	it("should build context with tool results", () => {
		store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "Read file.ts" },
		});
		store.append({
			actor_id: "runtime",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [{ type: "tool_call", id: "call_1", name: "read", arguments: { path: "file.ts" } }],
				model: { provider: "anthropic", model_id: "claude-sonnet" },
				usage: { input: 10, output: 20, cache_read: 0, cache_write: 0, total: 30, cost: 0.001 },
				stop_reason: "tool_use",
			},
		});
		store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: {
				tool_call_id: "call_1",
				tool_name: "read",
				result: [{ type: "text", text: "file contents here" }],
				is_error: false,
				duration_ms: 50,
			},
		});

		const projection = new SessionProjection(store, createDescriptor());
		const context = projection.buildContext();

		// user, assistant (tool_use), toolResult — the context sanitizer keeps
		// the tool_use → tool_result pairing intact.
		expect(context.messages).toHaveLength(3);
		expect(context.messages[1].role).toBe("assistant");
		expect(context.messages[2].role).toBe("toolResult");
	});

	it("should include compaction events once when building context", () => {
		const summary = store.append({
			actor_id: "compactor",
			type: "COMPACTION_END",
			payload: {
				summary: "Compacted context",
				first_kept_event_id: "evt-keep",
				tokens_before: 12000,
				tokens_after: 900,
			},
		});

		const projection = new SessionProjection(
			store,
			createDescriptor({ summary_event_id: summary.event_id }),
		);
		const context = projection.buildContext();

		expect(context.messages).toHaveLength(1);
		expect(context.messages[0].role).toBe("compactionSummary");
		expect((context.messages[0] as any).summary).toBe("Compacted context");
	});

	it("should treat COMPACTION_END first_kept_event_id as a context boundary", () => {
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "old request" } });
		store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [{ type: "text", text: "old response" }],
				model: { provider: "anthropic", model_id: "claude" },
				usage: { input: 5, output: 10, cache_read: 0, cache_write: 0, total: 15, cost: 0 },
				stop_reason: "stop",
			},
		});
		const kept = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "kept request" } });
		store.append({
			actor_id: "compactor",
			type: "COMPACTION_END",
			payload: {
				summary: "Old request and response were summarized",
				first_kept_event_id: kept.event_id,
				tokens_before: 9000,
				tokens_after: 1000,
			},
		});

		const projection = new SessionProjection(store, createDescriptor());
		const context = projection.buildContext();

		expect(context.messages).toHaveLength(2);
		expect(context.messages[0].role).toBe("compactionSummary");
		expect((context.messages[1] as any).content).toBe("kept request");
		expect(context.messages.some((message) => JSON.stringify(message).includes("old request"))).toBe(false);
	});

	it("should skip non-context events like AGENT_THINKING_START", () => {
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "Hi" } });
		store.append({ actor_id: "coder_agent", type: "AGENT_THINKING_START", payload: {} });
		store.append({ actor_id: "coder_agent", type: "AGENT_TURN_START", payload: { message_count: 1 } });
		store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [{ type: "text", text: "response" }],
				model: { provider: "anthropic", model_id: "claude" },
				usage: { input: 5, output: 10, cache_read: 0, cache_write: 0, total: 15, cost: 0 },
				stop_reason: "stop",
			},
		});
		store.append({ actor_id: "coder_agent", type: "AGENT_TURN_END", payload: { tool_calls_count: 0 } });
		store.append({ actor_id: "coder_agent", type: "AGENT_THINKING_END", payload: {} });

		const projection = new SessionProjection(store, createDescriptor());
		const context = projection.buildContext();

		// Only USER_MESSAGE and AGENT_MESSAGE_END should produce messages
		expect(context.messages).toHaveLength(2);
		expect(context.messages[0].role).toBe("user");
		expect(context.messages[1].role).toBe("assistant");
	});

	it("should apply token budget truncation", () => {
		// Add many messages
		for (let i = 0; i < 100; i++) {
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: `Message ${i}` } });
		}

		const projection = new SessionProjection(store, createDescriptor());
		// "Message i" is ~3-4 tokens each; a 50-token budget keeps ~12-16 messages.
		const context = projection.buildContext({ max_tokens: 50 });

		expect(context.messages.length).toBeLessThan(100);
		expect(context.messages.length).toBeGreaterThan(0);
	});

	it("should return timeline entries", () => {
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "Hello" } });
		store.append({ actor_id: "coder_agent", type: "AGENT_THINKING_START", payload: {} });
		store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [{ type: "text", text: "Hi" }],
				model: { provider: "anthropic", model_id: "claude" },
				usage: { input: 5, output: 10, cache_read: 0, cache_write: 0, total: 15, cost: 0 },
				stop_reason: "stop",
			},
		});

		const projection = new SessionProjection(store, createDescriptor());
		const timeline = projection.getTimeline();

		expect(timeline).toHaveLength(3);
		expect(timeline[0].kind).toBe("user_message");
		expect(timeline[0].summary).toBe("Hello");
		expect(timeline[2].kind).toBe("agent_message");
		expect(timeline[2].summary).toBe("Hi");
	});

	it("should fork session from a specific event", () => {
		const e1 = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "A" } });
		const e2 = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "B" } });
		const e3 = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "C" } });

		const projection = new SessionProjection(store, createDescriptor());
		const forked = projection.fork(e2.event_id);

		expect(forked.event_range.start_event_id).toBe(e2.event_id);
		expect(forked.event_range.end_event_id).toBe("HEAD");
		expect(forked.created_by).toBe("fork");
		expect(forked.parent_session_id).toBe("sess_test");
	});
});

describe("SessionManager", () => {
	const testDir = join(tmpdir(), ".test-pizza-session-mgr", String(Date.now()));
	let store: SqliteEventStore;

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
		store = new SqliteEventStore("test-ws", join(testDir, "session-events.sqlite"));
	});

	afterEach(() => {
		store.close();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("should create a session on first access", () => {
		const mgr = new SessionManager(store, store);
		const session = mgr.getActiveSession();

		expect(session).toBeDefined();
		expect(mgr.getActiveSessionId()).toBeDefined();
	});

	it("should create named sessions", () => {
		const mgr = new SessionManager(store, store);
		const desc = mgr.createSession("user_explicit", "My Session");

		expect(desc.name).toBe("My Session");
		expect(desc.created_by).toBe("user_explicit");
		expect(mgr.getActiveSessionId()).toBe(desc.session_id);
	});

	it("should list sessions", () => {
		const mgr = new SessionManager(store, store);
		mgr.createSession("user_explicit", "Session A");
		mgr.createSession("user_explicit", "Session B");

		const list = mgr.listSessions();
		expect(list.length).toBe(2);
	});

	it("should switch sessions", () => {
		const mgr = new SessionManager(store, store);
		const s1 = mgr.createSession("user_explicit", "Session 1");
		const s2 = mgr.createSession("user_explicit", "Session 2");

		expect(mgr.getActiveSessionId()).toBe(s2.session_id);

		mgr.switchTo(s1.session_id);
		expect(mgr.getActiveSessionId()).toBe(s1.session_id);
	});

	it("should close the previous open session when switching directly", () => {
		const mgr = new SessionManager(store, store);
		const s1 = mgr.createSession("user_explicit", "Session 1");
		store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "before switch" },
			thread_id: s1.thread_id,
		});
		const s2 = mgr.createSession("user_explicit", "Session 2", { closeActive: false });

		mgr.switchToExistingSession(s1.session_id, "return");
		store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "after switch" },
			thread_id: s1.thread_id,
		});

		expect(mgr.getSession(s2.session_id)?.event_range.end_event_id).not.toBe("HEAD");
		const s2Messages = mgr.getSessionProjection(s2.session_id)!.buildContext().messages;
		const s2Text = s2Messages.map((message) => ("content" in message ? message.content : undefined));
		expect(s2Text).not.toContain("after switch");
	});

	it("should switch directly to closed sessions for viewing", () => {
		const mgr = new SessionManager(store, store);
		const s1 = mgr.createSession("user_explicit", "Session 1");
		mgr.createSession("user_explicit", "Session 2");

		const switched = mgr.switchToExistingSession(s1.session_id, "view historical session");
		expect(switched.session_id).toBe(s1.session_id);
		expect(mgr.getActiveSessionId()).toBe(s1.session_id);
	});

	it("should continue a closed active session with inherited context", () => {
		const mgr = new SessionManager(store, store);
		const s1 = mgr.createSession("user_explicit", "Session 1");
		store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "old context" },
			thread_id: s1.thread_id,
		});
		const s2 = mgr.createSession("user_explicit", "Session 2");
		store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "other branch gap" },
			thread_id: s2.thread_id,
		});

		mgr.switchToExistingSession(s1.session_id, "view historical session");
		const continuation = mgr.ensureActiveSessionWritable("continue");
		store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "new continuation" },
			thread_id: continuation!.thread_id,
		});

		expect(continuation?.session_id).not.toBe(s1.session_id);
		expect(continuation?.context_parent_session_id).toBe(s1.session_id);
		expect(continuation?.thread_id).not.toBe(s1.thread_id);
		const messages = mgr.getSessionProjection(continuation!.session_id)!.buildContext().messages;
		const text = messages.map((message) => ("content" in message ? message.content : undefined));
		expect(text).toContain("old context");
		expect(text).toContain("new continuation");
		expect(text).not.toContain("other branch gap");
	});

	it("should create scheduled sessions in isolated threads", () => {
		const mgr = new SessionManager(store, store);
		const user = mgr.createSession("user_explicit", "User");
		const userThreadId = user.thread_id;

		const scheduleThread = mgr.createThread("Scheduled task", "schedule");
		const schedule = mgr.getSession(mgr.getActiveSessionId()!)!;

		expect(schedule.created_by).toBe("schedule");
		expect(schedule.thread_id).toBe(scheduleThread.thread_id);
		expect(schedule.thread_id).not.toBe(userThreadId);
		expect(mgr.getSession(user.session_id)?.event_range.end_event_id).toBe("HEAD");
	});

	it("marks scheduler-created threads as background", () => {
		const mgr = new SessionManager(store, store);
		mgr.createSession("user_explicit", "User");
		const bg = mgr.createThread("Scheduled task", "schedule");
		expect(bg.status).toBe("background");
		const normal = mgr.createThread("Chat", "user_explicit");
		expect(normal.status).toBe("active");
	});

	it("does not auto-select a leftover background thread as active on reload", () => {
		const userThreadId: string[] = [];
		{
			const mgr = new SessionManager(store, store);
			const user = mgr.createSession("user_explicit", "User");
			userThreadId.push(user.thread_id);
			// Scheduler creates a background thread + session, then restores the
			// previous interactive session (as rpc-mode dispatch does).
			mgr.createThread("Scheduled task", "schedule");
			mgr.switchToExistingSession(user.session_id, "schedule complete", { background: true });
			expect(mgr.getActiveThreadId()).toBe(user.thread_id);
			mgr.dispose();
		}
		// Reopen (simulates sidecar restart / _loadIndex).
		const mgr2 = new SessionManager(store, store);
		expect(mgr2.getActiveThreadId()).toBe(userThreadId[0]);
		mgr2.dispose();
	});

	it("deterministically picks the most recently used interactive thread on reload", () => {
		// Use fake timers to give each session/thread a distinct created_at so
		// the "most recently used" selection is unambiguous (no same-ms ties).
		vi.useFakeTimers();
		try {
			let expectedThreadId = "";
			{
				const mgr = new SessionManager(store, store);
				vi.setSystemTime(new Date("2026-08-10T10:00:00Z"));
				const a = mgr.createThread("A", "user_explicit");
				vi.setSystemTime(new Date("2026-08-10T11:00:00Z"));
				mgr.createThread("B", "user_explicit");
				// Thread A gets the newest session -> it must be selected on reload.
				vi.setSystemTime(new Date("2026-08-10T12:00:00Z"));
				mgr.createSession("user_explicit", "latest-in-A", { threadId: a.thread_id });
				expectedThreadId = a.thread_id;
				mgr.dispose();
			}
			const mgr2 = new SessionManager(store, store);
			expect(mgr2.getActiveThreadId()).toBe(expectedThreadId);
			mgr2.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("promotes a background thread to active when the user navigates into it", () => {
		const mgr = new SessionManager(store, store);
		const user = mgr.createSession("user_explicit", "User");
		const bg = mgr.createThread("Scheduled task", "schedule");
		expect(bg.status).toBe("background");
		// Scheduler restored the user session after the background run.
		mgr.switchToExistingSession(user.session_id, "schedule complete", { background: true });
		expect(mgr.getActiveThreadId()).toBe(user.thread_id);
		// Later the user opens the scheduled session from the history tree.
		const bgSession = mgr.listSessions().find((s) => s.thread_id === bg.thread_id)!.session_id;
		mgr.switchToExistingSession(bgSession, "history tree row click");
		expect(mgr.getActiveThreadId()).toBe(bg.thread_id);
		expect(mgr.getActiveThread()?.status).toBe("active");
	});

	it("does not promote a background thread on a scheduler-driven switch", () => {
		const mgr = new SessionManager(store, store);
		mgr.createSession("user_explicit", "User");
		const bg = mgr.createThread("Scheduled task", "schedule");
		const bgSession = mgr.getActiveSessionId()!;
		// A pinned scheduled run hops into its own session every fire; that must
		// not turn the background thread into an interactive one.
		mgr.switchToExistingSession(bgSession, "scheduled task", { background: true });
		expect(mgr.getActiveThread()?.status).toBe("background");
		// The same switch made by the user does promote it — including when the
		// session is already the active one (the scheduler put us here).
		mgr.switchToExistingSession(bgSession, "history tree row click");
		expect(mgr.getActiveThread()?.status).toBe("active");
		expect(mgr.getActiveThreadId()).toBe(bg.thread_id);
	});

	it("should throw when switching to non-existent session", () => {
		const mgr = new SessionManager(store, store);
		mgr.createSession("user_explicit");

		expect(() => mgr.switchTo("non-existent")).toThrow("Session not found");
	});

	it("should rename sessions", () => {
		const mgr = new SessionManager(store, store);
		const desc = mgr.createSession("user_explicit", "Old Name");

		mgr.renameSession(desc.session_id, "New Name");
		const updated = mgr.getSession(desc.session_id);
		expect(updated?.name).toBe("New Name");
	});

	it("should fork sessions", () => {
		const mgr = new SessionManager(store, store);
		mgr.createSession("user_explicit", "Original");
		const event = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "fork point" } });

		const forked = mgr.forkAt(event.event_id);
		expect(forked.created_by).toBe("fork");
		expect(forked.parent_session_id).toBeDefined();
		expect(mgr.getActiveSessionId()).toBe(forked.session_id);
	});

	it("should fork a session while preserving history and freezing the source", () => {
		const mgr = new SessionManager(store, store);
		const source = mgr.createSession("user_explicit", "Original");
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "source message" } });

		const forked = mgr.forkFromSession(source.session_id);
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "fork message" } });

		const sourceProjection = mgr.getSessionProjection(source.session_id)!;
		const forkProjection = mgr.getSessionProjection(forked.session_id)!;
		const textContents = (messages: ReturnType<typeof sourceProjection.buildContext>["messages"]) =>
			messages.map((message) => ("content" in message ? message.content : undefined));
		expect(source.event_range.end_event_id).not.toBe("HEAD");
		expect(forked.event_range.start_event_id).toBe(source.event_range.start_event_id);
		expect(textContents(sourceProjection.buildContext().messages)).toEqual(["source message"]);
		expect(textContents(forkProjection.buildContext().messages)).toEqual([
			"source message",
			"fork message",
		]);
	});

	it("should fork without preserving history when preserveHistory is false", () => {
		const mgr = new SessionManager(store, store);
		const source = mgr.createSession("user_explicit", "Original");
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "source message" } });

		const forked = mgr.forkFromSession(source.session_id, { preserveHistory: false });
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "fork message" } });

		const forkProjection = mgr.getSessionProjection(forked.session_id)!;
		const textContents = (messages: ReturnType<typeof forkProjection.buildContext>["messages"]) =>
			messages.map((message) => ("content" in message ? message.content : undefined));
		// Fork should NOT include the source's "source message" — only "fork message"
		expect(forked.event_range.start_event_id).not.toBe(source.event_range.start_event_id);
		expect(textContents(forkProjection.buildContext().messages)).toEqual(["fork message"]);
	});

	it("should fork preserving history by default (backward compat)", () => {
		const mgr = new SessionManager(store, store);
		const source = mgr.createSession("user_explicit", "Original");
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "source message" } });

		const forked = mgr.forkFromSession(source.session_id);
		expect(forked.event_range.start_event_id).toBe(source.event_range.start_event_id);
	});

	it("should persist sessions to disk", () => {
		{
			const mgr = new SessionManager(store, store);
			mgr.createSession("user_explicit", "Persisted");
			mgr.dispose();
		}

		{
			const mgr = new SessionManager(store, store);
			const list = mgr.listSessions();
			expect(list.length).toBe(1);
			expect(list[0].name).toBe("Persisted");
			mgr.dispose();
		}
	});
});
