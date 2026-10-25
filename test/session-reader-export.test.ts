/**
 * Regression: readSessionForExport must rebuild the transcript from the
 * session's conversation events (USER_MESSAGE / AGENT_MESSAGE_END / …).
 * The event-sourced model never writes SESSION_ENTRY_APPENDED for normal
 * conversation — reading only those produced empty HTML exports.
 */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { SessionManager } from "../src/core/projection/session-manager.js";
import { readSessionForExport } from "../src/core/session/session-reader.js";

describe("readSessionForExport", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pizza-export-"));
	const workspaceId = "ws_export_test";
	const dbDir = join(agentDir, "workspaces", workspaceId);
	let store: SqliteEventStore;

	beforeEach(() => {
		mkdirSync(dbDir, { recursive: true });
		store = new SqliteEventStore(workspaceId, join(dbDir, "events.sqlite"));
	});

	afterEach(() => {
		store.close();
	});

	it("rebuilds conversation entries from the session event range", () => {
		const mgr = new SessionManager(store, store);
		const desc = mgr.createSession("user_explicit", "Export Me");
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "Hello there" } });
		store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [{ type: "text", text: "Hi back" }],
				model: { provider: "anthropic", model_id: "claude" },
				usage: { input: 5, output: 10, cache_read: 0, cache_write: 0, total: 15, cost: 0 },
				stop_reason: "stop",
			},
		});
		store.close();

		const result = readSessionForExport(`event-session:${workspaceId}:${desc.session_id}`, agentDir);
		expect(result.entries).toHaveLength(2);
		expect(result.entries[0].type).toBe("message");
		expect((result.entries[0] as any).message.role).toBe("user");
		expect((result.entries[0] as any).message.content).toBe("Hello there");
		expect((result.entries[1] as any).message.role).toBe("assistant");
		// chained into a single timeline like the TUI /history selector
		expect(result.entries[1].parentId).toBe(result.entries[0].id);
		expect(result.leafId).toBe(result.entries[1].id);
	});

	it("maps lifecycle and tooling events to their entry types", () => {
		const mgr = new SessionManager(store, store);
		const desc = mgr.createSession("user_explicit");
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "run it" } });
		store.append({
			actor_id: "user",
			type: "BASH_EXECUTION",
			payload: { command: "echo hi", output: "hi", exit_code: 0, duration_ms: 12, cwd: "/tmp" },
		});
		store.append({
			actor_id: "runtime",
			type: "COMPACTION_END",
			payload: { summary: "older turns compacted", tokens_before: 9999 },
		});
		store.append({ actor_id: "user", type: "MODEL_CHANGED", payload: { provider: "test", model_id: "m2" } });
		store.append({ actor_id: "user", type: "THINKING_LEVEL_CHANGED", payload: { level: "high" } });
		store.close();

		const result = readSessionForExport(`event-session:${workspaceId}:${desc.session_id}`, agentDir);
		const types = result.entries.map((e) => e.type);
		expect(types).toEqual(["message", "message", "compaction", "model_change", "thinking_level_change"]);
		expect((result.entries[1] as any).message.role).toBe("bashExecution");
		expect((result.entries[2] as any).tokensBefore).toBe(9999);
		expect((result.entries[3] as any).modelId).toBe("m2");
		expect((result.entries[4] as any).thinkingLevel).toBe("high");
	});

	it("keeps extension SESSION_ENTRY_APPENDED entries alongside conversation entries", () => {
		const mgr = new SessionManager(store, store);
		const desc = mgr.createSession("user_explicit");
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "hi" } });
		store.append({
			actor_id: "runtime",
			type: "SESSION_ENTRY_APPENDED",
			payload: {
				session_id: desc.session_id,
				entry: { type: "custom_message", customType: "ext:note", content: "extension note", display: true },
			},
		});
		store.close();

		const result = readSessionForExport(`event-session:${workspaceId}:${desc.session_id}`, agentDir);
		expect(result.entries).toHaveLength(2);
		expect(result.entries[1].type).toBe("custom_message");
		expect((result.entries[1] as any).customType).toBe("ext:note");
	});

	it("does not leak a later session's events into the export", () => {
		const mgr = new SessionManager(store, store);
		const s1 = mgr.createSession("user_explicit", "First");
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "session one message" } });
		const s2 = mgr.createSession("user_explicit", "Second");
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "session two message" } });
		store.close();

		const r1 = readSessionForExport(`event-session:${workspaceId}:${s1.session_id}`, agentDir);
		expect(r1.entries).toHaveLength(1);
		expect((r1.entries[0] as any).message.content).toBe("session one message");
		const r2 = readSessionForExport(`event-session:${workspaceId}:${s2.session_id}`, agentDir);
		expect(r2.entries).toHaveLength(1);
		expect((r2.entries[0] as any).message.content).toBe("session two message");
	});

	it("includes the context parent's entries for a forked session", () => {
		const mgr = new SessionManager(store, store);
		const parent = mgr.createSession("user_explicit", "Parent");
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "parent message" } });
		store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [{ type: "text", text: "parent reply" }],
				model: { provider: "anthropic", model_id: "claude" },
				usage: { input: 5, output: 5, cache_read: 0, cache_write: 0, total: 10, cost: 0 },
				stop_reason: "stop",
			},
		});
		// Create a new session that inherits the parent's context (like a jump-continuation).
		const forked = mgr.createSession("fork", undefined, {
			parentSessionId: parent.session_id,
			contextParentSessionId: parent.session_id,
		});
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "fork message" } });
		store.close();

		const result = readSessionForExport(`event-session:${workspaceId}:${forked.session_id}`, agentDir);
		const texts = result.entries.map((e) => {
			const c = (e as any).message?.content;
			return typeof c === "string" ? c : (c?.[0]?.text ?? "");
		});
		expect(texts).toEqual(["parent message", "parent reply", "fork message"]);
		// The fork's own first entry chains onto the parent's last entry.
		const lastParent = result.entries[1];
		const firstFork = result.entries[2];
		expect(firstFork.parentId).toBe(lastParent.id);
	});

	const messageTexts = (result: ReturnType<typeof readSessionForExport>) =>
		result.entries.map((e) => (e as any).message?.content).filter((c) => typeof c === "string");

	it("does not duplicate the parent's turns for a history-preserving fork", () => {
		const mgr = new SessionManager(store, store);
		const parent = mgr.createSession("user_explicit", "Parent");
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "parent message" } });
		const forked = mgr.forkFromSession(parent.session_id);
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "fork message" } });
		store.close();

		const result = readSessionForExport(`event-session:${workspaceId}:${forked.session_id}`, agentDir);
		expect(messageTexts(result)).toEqual(["parent message", "fork message"]);
	});

	it("does not prepend a lineage-only parent's turns to a fresh child session", () => {
		const mgr = new SessionManager(store, store);
		const parent = mgr.createSession("user_explicit", "Parent");
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "parent message" } });
		const child = mgr.createSession("user_explicit", "Child", { parentSessionId: parent.session_id });
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "child message" } });
		store.close();

		const result = readSessionForExport(`event-session:${workspaceId}:${child.session_id}`, agentDir);
		expect(messageTexts(result)).toEqual(["child message"]);
	});

	it("returns an empty transcript for a session that does not exist", () => {
		const mgr = new SessionManager(store, store);
		mgr.createSession("user_explicit", "Real Session");
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "someone else's message" } });
		store.close();
		// A bogus id used to degenerate the range query to "all events" and
		// leak other sessions' entries into the export.
		const result = readSessionForExport(`event-session:${workspaceId}:sess_does_not_exist`, agentDir);
		expect(result.entries).toHaveLength(0);
	});

	it("returns an empty transcript for an indexed session with no entries", () => {
		const mgr = new SessionManager(store, store);
		const empty = mgr.createSession("user_explicit", "Empty");
		mgr.createSession("user_explicit", "Other");
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "other session message" } });
		store.close();

		const result = readSessionForExport(`event-session:${workspaceId}:${empty.session_id}`, agentDir);
		expect(result.entries).toHaveLength(0);
	});
});
