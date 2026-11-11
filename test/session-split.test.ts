/**
 * Headless tests for the session_split tool and event mapping.
 *
 * Verifies:
 * 1. mapTypedEventToModeEvents maps SESSION_BOUNDARY_INFERRED → session_split ModeEvent
 * 2. EventStoreExtensionSessionManager.splitSession creates a new session and emits event
 * 3. The session_split tool definition executes and returns success
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { SessionManager as ProjectionSessionManager } from "../src/core/projection/session-manager.js";
import { SessionProjection } from "../src/core/projection/session-projection.js";
import { EventStoreExtensionSessionManager } from "../src/core/extensions/session-context.js";
import { createSessionSplitToolDefinition } from "../src/core/tools/session-split.js";
import { mapTypedEventToModeEvents } from "../src/modes/event-mapper.js";
import type { EventBase } from "../src/core/event-store/types.js";

let sequence = 0;

function mkEvent(type: string, payload: unknown): EventBase {
	sequence++;
	return {
		sequence,
		event_id: `evt-${sequence}`,
		workspace_id: "workspace",
		runtime_id: "runtime",
		actor_id: "runtime",
		timestamp: 1000 + sequence,
		type,
		payload,
	} as EventBase;
}

describe("session_split", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pizza-session-split-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	// ── Event Mapper ────────────────────────────────────────────────────────

	describe("event-mapper", () => {
		it("maps SESSION_BOUNDARY_INFERRED to session_split ModeEvent", () => {
			const events = mapTypedEventToModeEvents(mkEvent("SESSION_BOUNDARY_INFERRED", {
				reason: "intent_shift",
				new_session_id: "sess_new_123",
			}));

			expect(events).toHaveLength(1);
			expect(events[0]).toEqual({
				type: "session_split",
				eventId: expect.any(String),
				reason: "intent_shift",
				newSessionId: "sess_new_123",
			});
		});

		it("maps SESSION_BOUNDARY_INFERRED with different reason", () => {
			const events = mapTypedEventToModeEvents(mkEvent("SESSION_BOUNDARY_INFERRED", {
				reason: "topic_change",
				new_session_id: "sess_abc",
			}));

			expect(events[0]).toMatchObject({
				type: "session_split",
				reason: "topic_change",
				newSessionId: "sess_abc",
			});
		});

		it("still ignores SESSION_CREATED (no mode event)", () => {
			const events = mapTypedEventToModeEvents(mkEvent("SESSION_CREATED", {
				session_id: "sess_1",
				created_by: "user_explicit",
			}));
			expect(events).toEqual([]);
		});
	});

	// ── EventStoreExtensionSessionManager.splitSession ──────────────────────

	describe("EventStoreExtensionSessionManager.splitSession", () => {
		it("creates a new session and emits SESSION_BOUNDARY_INFERRED event", () => {
			const cwd = makeTempDir();
			const store = new SqliteEventStore("test-ws", ":memory:");
			const sessionManager = new ProjectionSessionManager(store, store);

			const projection = sessionManager.getActiveSession();
			const extSessionManager = new EventStoreExtensionSessionManager({
				store,
				projection,
				cwd,
				sessionManager,
			});

			// Append a user message so the session has content
			store.append({
				actor_id: "user",
				type: "USER_MESSAGE",
				payload: { content: "hello world" },
			});

			const originalSessionId = extSessionManager.getSessionId();
			expect(extSessionManager.splitSession).toBeDefined();

			const result = extSessionManager.splitSession!("intent_shift", "New topic");
			expect(result).toBeDefined();
			expect(result!.session_id).not.toBe(originalSessionId);

			// Verify SESSION_BOUNDARY_INFERRED event was emitted
			const events = store.query({ reverse: true });
			const boundaryEvent = events.find((e) => e.type === "SESSION_BOUNDARY_INFERRED");
			expect(boundaryEvent).toBeDefined();
			expect((boundaryEvent!.payload as any).reason).toBe("intent_shift");
			expect((boundaryEvent!.payload as any).new_session_id).toBe(result!.session_id);

			// The new session should be active
			expect(sessionManager.getActiveSessionId()).toBe(result!.session_id);

			sessionManager.dispose();
			store.close();
		});

		it("is a no-op when the active session has no user message (loop guard)", () => {
			const cwd = makeTempDir();
			const store = new SqliteEventStore("test-ws", ":memory:");
			const sessionManager = new ProjectionSessionManager(store, store);
			const projection = sessionManager.getActiveSession();
			const extSessionManager = new EventStoreExtensionSessionManager({
				store,
				projection,
				cwd,
				sessionManager,
			});

			// First user message + first split -> creates a new session
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "开新session做XXX" } });
			const first = extSessionManager.splitSession!("intent_shift");
			expect(first).toBeDefined();
			expect(first!.already_split).toBeUndefined();
			const firstSessionId = first!.session_id;

			// Second split within the same turn (no new user message) -> no-op
			const second = extSessionManager.splitSession!("intent_shift");
			expect(second).toBeDefined();
			expect(second!.already_split).toBe(true);
			expect(second!.session_id).toBe(firstSessionId);

			// Only one SESSION_BOUNDARY_INFERRED event should exist
			const boundaryEvents = store.query({ reverse: false }).filter((e) => e.type === "SESSION_BOUNDARY_INFERRED");
			expect(boundaryEvents).toHaveLength(1);

			sessionManager.dispose();
			store.close();
		});

		it("allows a new split after a new user message arrives", () => {
			const cwd = makeTempDir();
			const store = new SqliteEventStore("test-ws", ":memory:");
			const sessionManager = new ProjectionSessionManager(store, store);
			const projection = sessionManager.getActiveSession();
			const extSessionManager = new EventStoreExtensionSessionManager({
				store,
				projection,
				cwd,
				sessionManager,
			});

			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "task A" } });
			const first = extSessionManager.splitSession!("intent_shift");
			expect(first!.already_split).toBeUndefined();

			// New user message in the new session, then split again -> allowed
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "unrelated task B" } });
			const second = extSessionManager.splitSession!("topic_change");
			expect(second!.already_split).toBeUndefined();
			expect(second!.session_id).not.toBe(first!.session_id);

			const boundaryEvents = store.query({ reverse: false }).filter((e) => e.type === "SESSION_BOUNDARY_INFERRED");
			expect(boundaryEvents).toHaveLength(2);

			sessionManager.dispose();
			store.close();
		});

		it("returns undefined when sessionManager is not provided", () => {
			const cwd = makeTempDir();
			const store = new SqliteEventStore("test-ws", ":memory:");
			const sessionManager = new ProjectionSessionManager(store, store);
			const projection = sessionManager.getActiveSession();

			const extSessionManager = new EventStoreExtensionSessionManager({
				store,
				projection,
				cwd,
				// sessionManager intentionally omitted
			});

			expect(extSessionManager.splitSession).toBeDefined();
			const result = extSessionManager.splitSession!("test");
			expect(result).toBeUndefined();

			sessionManager.dispose();
			store.close();
		});
	});

	// ── Tool Definition Execution ───────────────────────────────────────────

	describe("session_split tool", () => {
		it("executes successfully and returns session id", async () => {
			const cwd = makeTempDir();
			const store = new SqliteEventStore("test-ws", ":memory:");
			const sessionManager = new ProjectionSessionManager(store, store);
			const projection = sessionManager.getActiveSession();

			const extSessionManager = new EventStoreExtensionSessionManager({
				store,
				projection,
				cwd,
				sessionManager,
			});

			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "do a task" } });

			const toolDef = createSessionSplitToolDefinition();
			expect(toolDef.name).toBe("session_split");

			const ctx = {
				sessionManager: extSessionManager,
			} as any;

			const result = await toolDef.execute(
				"test_call_id",
				{ reason: "topic_change", name: "Fix bugs" },
				undefined,
				undefined,
				ctx,
			);

			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe("text");
			expect((result.content[0] as any).text).toContain("Session split successfully");
			expect((result.content[0] as any).text).toContain("New session:");

			sessionManager.dispose();
			store.close();
		});

		it("rejects when splitSession is unavailable", async () => {
			const cwd = makeTempDir();
			const store = new SqliteEventStore("test-ws", ":memory:");
			const sessionManager = new ProjectionSessionManager(store, store);
			const projection = sessionManager.getActiveSession();

			const extSessionManager = new EventStoreExtensionSessionManager({
				store,
				projection,
				cwd,
				// sessionManager intentionally omitted
			});

			const toolDef = createSessionSplitToolDefinition();

			const ctx = {
				sessionManager: extSessionManager,
			} as any;

			await expect(toolDef.execute(
				"test_call_id",
				{ reason: "test" },
				undefined,
				undefined,
				ctx,
			)).rejects.toThrow("not available");

			sessionManager.dispose();
			store.close();
		});

		it("uses default reason when none provided", async () => {
			const cwd = makeTempDir();
			const store = new SqliteEventStore("test-ws", ":memory:");
			const sessionManager = new ProjectionSessionManager(store, store);
			const projection = sessionManager.getActiveSession();

			const extSessionManager = new EventStoreExtensionSessionManager({
				store,
				projection,
				cwd,
				sessionManager,
			});

			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "do a task" } });

			const toolDef = createSessionSplitToolDefinition();

			const ctx = {
				sessionManager: extSessionManager,
			} as any;

			const result = await toolDef.execute(
				"test_call_id",
				{},
				undefined,
				undefined,
				ctx,
			);

			expect(result.content).toHaveLength(1);
			expect((result.content[0] as any).text).toContain("Session split successfully");

			// Verify default reason was used
			const events = store.query({ reverse: true });
			const boundaryEvent = events.find((e) => e.type === "SESSION_BOUNDARY_INFERRED");
			expect(boundaryEvent).toBeDefined();
			expect((boundaryEvent!.payload as any).reason).toBe("intent_shift");

			sessionManager.dispose();
			store.close();
		});
	});
});
