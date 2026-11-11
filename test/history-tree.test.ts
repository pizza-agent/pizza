/**
 * Headless tests for the history_tree tool, SessionManager.jumpToSession,
 * and the builtin command parsing.
 *
 * Verifies:
 * 1. buildHistoryTreeNodes organizes sessions into a depth-annotated tree
 * 2. SessionManager.jumpToSession switches/reopens sessions and emits SESSION_JUMPED
 * 3. EventStoreExtensionSessionManager.historyTree exposes list/view/jump/fork
 * 4. The history_tree tool definition executes each action
 * 5. parseBuiltinToolInput parses history_tree commands
 */

import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import type { EventAppendInput, EventQuery, EventStore, SubscribeOptions } from "../src/core/event-store/store.js";
import type { EventBase } from "../src/core/event-store/types.js";
import { SessionManager as ProjectionSessionManager } from "../src/core/projection/session-manager.js";
import { buildHistoryTreeNodes, renderHistoryTreeText, buildSessionBreadcrumb } from "../src/core/projection/history-tree.js";
import { EventStoreExtensionSessionManager } from "../src/core/extensions/session-context.js";
import { createHistoryTreeToolDefinition } from "../src/core/tools/history-tree.js";
import { parseBuiltinToolInput } from "../src/core/tools/builtin-commands.js";

function makeStore(): { store: SqliteEventStore; sessionManager: ProjectionSessionManager } {
	const store = new SqliteEventStore("test-ws", ":memory:");
	const sessionManager = new ProjectionSessionManager(store, store);
	return { store, sessionManager };
}

class MemoryEventStore implements EventStore {
	readonly workspace_id = "test-ws";
	private events: EventBase[] = [];
	private subscribers: Array<{ handler: (event: EventBase) => void; options?: SubscribeOptions }> = [];

	append(input: EventAppendInput): EventBase {
		const event: EventBase = {
			...input,
			sequence: this.events.length + 1,
			event_id: input.event_id ?? `evt_${String(this.events.length + 1).padStart(4, "0")}`,
			workspace_id: this.workspace_id,
			runtime_id: input.runtime_id ?? "test-runtime",
			timestamp: input.timestamp ?? Date.now(),
			schema_version: input.schema_version ?? 1,
		};
		this.events.push(event);
		for (const subscriber of this.subscribers) {
			if (!subscriber.options?.types?.length || subscriber.options.types.includes(event.type)) {
				subscriber.handler(event);
			}
		}
		return event;
	}

	appendBatch(events: EventAppendInput[]): EventBase[] {
		return events.map((event) => this.append(event));
	}

	query(filter: EventQuery = {}): EventBase[] {
		let result = this.events.filter((event) => {
			if (filter.after && event.event_id <= filter.after) return false;
			if (filter.before && event.event_id >= filter.before) return false;
			if (filter.after_sequence !== undefined && event.sequence <= filter.after_sequence) return false;
			if (filter.before_sequence !== undefined && event.sequence >= filter.before_sequence) return false;
			if (filter.types?.length && !filter.types.includes(event.type)) return false;
			if (filter.actor_ids?.length && !filter.actor_ids.includes(event.actor_id)) return false;
			if (filter.thread_id && event.thread_id !== filter.thread_id) return false;
			return true;
		});
		if (filter.reverse) result = [...result].reverse();
		return filter.limit === undefined ? result : result.slice(0, filter.limit);
	}

	get(event_id: string): EventBase | undefined {
		return this.events.find((event) => event.event_id === event_id);
	}

	latest(count: number): EventBase[] {
		return this.events.slice(-count);
	}

	getCausalChain(event_id: string): EventBase[] {
		const chain: EventBase[] = [];
		let current = this.get(event_id);
		while (current) {
			chain.unshift(current);
			current = current.caused_by ? this.get(current.caused_by) : undefined;
		}
		return chain;
	}

	subscribe(handler: (event: EventBase) => void, options?: SubscribeOptions): () => void {
		const subscriber = { handler, options };
		this.subscribers.push(subscriber);
		return () => {
			this.subscribers = this.subscribers.filter((entry) => entry !== subscriber);
		};
	}

	get size(): number { return this.events.length; }
	get head(): string | undefined { return this.events.at(-1)?.event_id; }
	get head_sequence(): number { return this.events.at(-1)?.sequence ?? 0; }
}

function makeExtManager(
	store: SqliteEventStore,
	sessionManager: ProjectionSessionManager,
): EventStoreExtensionSessionManager {
	return new EventStoreExtensionSessionManager({
		store,
		projection: sessionManager.getActiveSession(),
		cwd: "/tmp",
		sessionManager,
	});
}

describe("history_tree", () => {
	// ── Tree building ────────────────────────────────────────────────────────

	describe("buildHistoryTreeNodes", () => {
		it("organizes sessions into a depth-first tree with child counts", () => {
			const { store, sessionManager } = makeStore();
			const root = sessionManager.getActiveSession().getDescriptor();
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "root task" } });

			const child = sessionManager.createSession("user_explicit", "child-a");
			const grandchild = sessionManager.forkFromSession(child.session_id);

			const nodes = buildHistoryTreeNodes(
				sessionManager.listSessions(),
				sessionManager.getActiveSessionId(),
				store,
			);

			expect(nodes.length).toBe(3);
			const rootNode = nodes.find((n) => n.session_id === root.session_id)!;
			const childNode = nodes.find((n) => n.session_id === child.session_id)!;
			const grandchildNode = nodes.find((n) => n.session_id === grandchild.session_id)!;

			expect(rootNode.depth).toBe(0);
			// child was created without parentSessionId, so it's a root too
			expect(childNode.depth).toBe(0);
			expect(grandchildNode.depth).toBe(1);
			expect(grandchildNode.parent_session_id).toBe(child.session_id);
			expect(childNode.child_count).toBe(1);
			expect(grandchildNode.is_active).toBe(true);
			expect(rootNode.snippet).toContain("root task");

			const text = renderHistoryTreeText(nodes);
			expect(text).toContain(root.session_id);
			expect(text).toContain("[active]");

			sessionManager.dispose();
			store.close();
		});

		it("labels nodes with a human title, message count and last activity", () => {
			const { store, sessionManager } = makeStore();
			const root = sessionManager.getActiveSession().getDescriptor();
			store.append({
				actor_id: "user",
				type: "USER_MESSAGE",
				payload: { content: "Fix the flaky auth test in packages/rpc. It fails on CI sometimes." },
			});
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "also check the retry path" } });

			const named = sessionManager.createSession("user_explicit", "Release prep");
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "bump versions" } });

			const nodes = buildHistoryTreeNodes(
				sessionManager.listSessions(),
				sessionManager.getActiveSessionId(),
				store,
			);
			const rootNode = nodes.find((n) => n.session_id === root.session_id)!;
			const namedNode = nodes.find((n) => n.session_id === named.session_id)!;

			// Unnamed session: title derived from the first user message, first clause only.
			expect(rootNode.title).toBe("Fix the flaky auth test in packages/rpc");
			expect(rootNode.title_is_derived).toBe(true);
			expect(rootNode.message_count).toBeGreaterThanOrEqual(2);
			expect(rootNode.last_activity_at).toBeGreaterThan(0);

			// Explicit name always wins and is not marked derived.
			expect(namedNode.title).toBe("Release prep");
			expect(namedNode.title_is_derived).toBe(false);

			// Rendered text leads with the title, id second.
			const text = renderHistoryTreeText(nodes);
			expect(text).toContain("Fix the flaky auth test in packages/rpc · " + root.session_id);
			expect(text).toContain("Release prep · " + named.session_id);

			sessionManager.dispose();
			store.close();
		});
	});

	// ── SessionManager.jumpToSession ─────────────────────────────────────────

	describe("SessionManager.jumpToSession", () => {
		it("is a no-op when jumping to the active session", () => {
			const { store, sessionManager } = makeStore();
			const active = sessionManager.getActiveSession().getDescriptor();

			const result = sessionManager.jumpToSession(active.session_id);
			expect(result.reopened).toBe(false);
			expect(result.descriptor.session_id).toBe(active.session_id);
			expect(store.query({ types: ["SESSION_JUMPED"] })).toHaveLength(0);

			sessionManager.dispose();
			store.close();
		});

		it("reopens a closed session via fork and emits SESSION_JUMPED", () => {
			const { store, sessionManager } = makeStore();
			const first = sessionManager.getActiveSession().getDescriptor();
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "old work" } });

			// Creating a second session closes the first one
			sessionManager.createSession("user_explicit", "second");
			expect(sessionManager.getSession(first.session_id)!.event_range.end_event_id).not.toBe("HEAD");

			const result = sessionManager.jumpToSession(first.session_id, "return to old work");
			expect(result.reopened).toBe(true);
			expect(result.descriptor.session_id).not.toBe(first.session_id);
			expect(result.descriptor.parent_session_id).toBe(first.session_id);
			// Reopened session preserves the source's start boundary
			expect(result.descriptor.event_range.start_event_id).toBe(first.event_range.start_event_id);
			expect(sessionManager.getActiveSessionId()).toBe(result.descriptor.session_id);

			const jumped = store.query({ types: ["SESSION_JUMPED"] });
			expect(jumped).toHaveLength(1);
			expect((jumped[0].payload as any).target_session_id).toBe(first.session_id);
			expect((jumped[0].payload as any).reopened_as).toBe(result.descriptor.session_id);
			expect((jumped[0].payload as any).reason).toBe("return to old work");
			expect(store.query({ types: ["SESSION_FORKED"] })).toHaveLength(1);

			sessionManager.dispose();
			store.close();
		});

		it("throws for unknown session ids", () => {
			const { store, sessionManager } = makeStore();
			expect(() => sessionManager.jumpToSession("sess_missing")).toThrow("Session not found");
			sessionManager.dispose();
			store.close();
		});
	});

	describe("SessionManager.resolveSwitchTargetSession", () => {
		it("reuses a hidden open continuation when switching a visible historical session", () => {
			const store = new MemoryEventStore();
			const sessionManager = new ProjectionSessionManager(store);
			const first = sessionManager.getActiveSession().getDescriptor();
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "fixed target work" } });

			const second = sessionManager.createSession("user_explicit", "second");
			sessionManager.switchToExistingSession(first.session_id, "view historical session");
			const continuation = sessionManager.ensureActiveSessionWritable("scheduled task")!;
			expect(continuation.session_id).not.toBe(first.session_id);
			expect(continuation.context_parent_session_id).toBe(first.session_id);

			sessionManager.switchToExistingSession(second.session_id, "look elsewhere");
			const resolved = sessionManager.resolveSwitchTargetSession(first.session_id);
			expect(resolved.session_id).toBe(continuation.session_id);

			const switched = sessionManager.switchToExistingSession(resolved.session_id, "history tree switch");
			expect(switched.session_id).toBe(continuation.session_id);
			expect(sessionManager.getActiveSessionId()).toBe(continuation.session_id);

			const nodes = buildHistoryTreeNodes(
				sessionManager.listSessions(),
				sessionManager.getActiveSessionId(),
				store,
			);
			expect(nodes.some((node) => node.session_id === continuation.session_id)).toBe(false);
			expect(nodes.find((node) => node.session_id === first.session_id)?.is_active).toBe(true);

			sessionManager.dispose();
		});
	});

	// ── ExtensionSessionManager.historyTree ──────────────────────────────────

	describe("EventStoreExtensionSessionManager.historyTree", () => {
		it("is undefined when sessionManager is not provided", () => {
			const { store, sessionManager } = makeStore();
			const extManager = new EventStoreExtensionSessionManager({
				store,
				projection: sessionManager.getActiveSession(),
				cwd: "/tmp",
			});
			expect(extManager.historyTree).toBeUndefined();
			sessionManager.dispose();
			store.close();
		});

		it("lists, views, jumps, and forks sessions", () => {
			const { store, sessionManager } = makeStore();
			const extManager = makeExtManager(store, sessionManager);
			const first = sessionManager.getActiveSession().getDescriptor();
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "fix cli/args.ts parsing" } });

			sessionManager.createSession("user_explicit", "second topic");

			const historyTree = extManager.historyTree!;
			const nodes = historyTree.list();
			expect(nodes.length).toBe(2);
			expect(nodes.find((n) => n.session_id === first.session_id)?.snippet).toContain("cli/args.ts");

			const view = historyTree.view(first.session_id);
			expect(view).toBeDefined();
			expect(view!.messages.some((line) => line.includes("cli/args.ts"))).toBe(true);

			const jump = historyTree.jump(first.session_id, "back to args work");
			expect(jump.reopened).toBe(true);
			expect(sessionManager.getActiveSessionId()).toBe(jump.session_id);

			const fork = historyTree.fork(first.session_id);
			expect(fork.session_id).not.toBe(first.session_id);
			expect(sessionManager.getSession(fork.session_id)?.parent_session_id).toBe(first.session_id);

			sessionManager.dispose();
			store.close();
		});
	});

	// ── Tool Definition Execution ────────────────────────────────────────────

	describe("history_tree tool", () => {
		it("lists the tree and filters by query", async () => {
			const { store, sessionManager } = makeStore();
			const extManager = makeExtManager(store, sessionManager);
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "authentication bug hunt" } });
			sessionManager.createSession("user_explicit", "unrelated");

			const toolDef = createHistoryTreeToolDefinition();
			const ctx = { sessionManager: extManager } as any;

			const listResult = await toolDef.execute("t1", { action: "list" }, undefined, undefined, ctx);
			expect((listResult.content[0] as any).text).toContain("Session history tree (2 nodes)");

			const queryResult = await toolDef.execute(
				"t2",
				{ action: "list", query: "authentication" },
				undefined,
				undefined,
				ctx,
			);
			expect((queryResult.content[0] as any).text).toContain("authentication bug hunt");
			expect((queryResult.content[0] as any).text).toContain("(1 node)");

			const noMatch = await toolDef.execute(
				"t3",
				{ action: "list", query: "nonexistent-topic" },
				undefined,
				undefined,
				ctx,
			);
			expect((noMatch.content[0] as any).text).toContain("No sessions match");

			sessionManager.dispose();
			store.close();
		});

		it("views, jumps, and forks via the tool", async () => {
			const { store, sessionManager } = makeStore();
			const extManager = makeExtManager(store, sessionManager);
			const first = sessionManager.getActiveSession().getDescriptor();
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "original topic" } });
			sessionManager.createSession("user_explicit", "second");

			const toolDef = createHistoryTreeToolDefinition();
			const ctx = { sessionManager: extManager } as any;

			const viewResult = await toolDef.execute(
				"t1",
				{ action: "view", session_id: first.session_id },
				undefined,
				undefined,
				ctx,
			);
			expect((viewResult.content[0] as any).text).toContain(`Session ${first.session_id}`);
			expect((viewResult.content[0] as any).text).toContain("original topic");

			const jumpResult = await toolDef.execute(
				"t2",
				{ action: "jump", session_id: first.session_id },
				undefined,
				undefined,
				ctx,
			);
			expect((jumpResult.content[0] as any).text).toContain(`Jumped to session ${first.session_id}`);
			expect((jumpResult.content[0] as any).text).toContain("reopened");

			const forkResult = await toolDef.execute(
				"t3",
				{ action: "fork", session_id: first.session_id },
				undefined,
				undefined,
				ctx,
			);
			expect((forkResult.content[0] as any).text).toContain(`Forked session ${first.session_id}`);

			sessionManager.dispose();
			store.close();
		});

		it("returns helpful errors for missing arguments and unknown sessions", async () => {
			const { store, sessionManager } = makeStore();
			const extManager = makeExtManager(store, sessionManager);
			const toolDef = createHistoryTreeToolDefinition();
			const ctx = { sessionManager: extManager } as any;

			await expect(toolDef.execute("t1", { action: "jump" }, undefined, undefined, ctx)).rejects.toThrow("jump requires session_id");
			await expect(toolDef.execute("t2", { action: "jump", session_id: "sess_missing" }, undefined, undefined, ctx)).rejects.toThrow("failed");
			await expect(toolDef.execute("t3", { action: "list" }, undefined, undefined, { sessionManager: undefined } as any)).rejects.toThrow("not available");

			sessionManager.dispose();
			store.close();
		});
	});

	// ── Builtin Command Parsing ──────────────────────────────────────────────

	describe("parseBuiltinToolInput", () => {
		it("parses positional action and session id", () => {
			expect(parseBuiltinToolInput("_history_tree", ["list"])).toEqual({
				command: "history_tree",
				input: { action: "list", session_id: undefined, query: undefined, max_messages: undefined, reason: undefined },
			});
			expect(parseBuiltinToolInput("_history_tree", ["jump", "sess_0042"])).toMatchObject({
				command: "history_tree",
				input: { action: "jump", session_id: "sess_0042" },
			});
		});

		it("parses flags", () => {
			expect(
				parseBuiltinToolInput("_history_tree", ["list", "--query", "auth bug"]),
			).toMatchObject({ input: { action: "list", query: "auth bug" } });
			expect(
				parseBuiltinToolInput("_history_tree", ["view", "-s", "sess_1", "--max-messages", "5"]),
			).toMatchObject({ input: { action: "view", session_id: "sess_1", max_messages: 5 } });
			expect(
				parseBuiltinToolInput("_history_tree", ["jump", "sess_1", "--reason", "back to work"]),
			).toMatchObject({ input: { action: "jump", session_id: "sess_1", reason: "back to work" } });
		});

		it("throws on unknown or missing action", () => {
			expect(() => parseBuiltinToolInput("_history_tree", ["destroy"])).toThrow("unknown action");
			expect(() => parseBuiltinToolInput("_history_tree", [])).toThrow("action required");
		});
	});

	// ── Breadcrumb ──────────────────────────────────────────────────────────
	describe("buildSessionBreadcrumb", () => {
		it("returns empty for single root with no children", () => {
			const sessions = [
				{ session_id: "s1", thread_id: "t1", workspace_id: "ws", event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" }, created_by: "user_explicit" as const, created_at: 1000 },
			];
			expect(buildSessionBreadcrumb(sessions, "s1")).toBe("");
		});

		it("returns empty when active session is missing", () => {
			const sessions = [
				{ session_id: "s1", thread_id: "t1", workspace_id: "ws", event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" }, created_by: "user_explicit" as const, created_at: 1000 },
			];
			expect(buildSessionBreadcrumb(sessions, "nonexistent")).toBe("");
		});

		it("returns breadcrumb for root with children", () => {
			const sessions = [
				{ session_id: "s1", thread_id: "t1", workspace_id: "ws", event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" }, created_by: "user_explicit" as const, created_at: 1000 },
				{ session_id: "s2", thread_id: "t1", workspace_id: "ws", parent_session_id: "s1", event_range: { start_event_id: "e1", end_event_id: "HEAD" }, created_by: "fork" as const, created_at: 2000 },
			];
			const crumb = buildSessionBreadcrumb(sessions, "s1");
			expect(crumb).toContain("s1");
			expect(crumb).toContain("root");
			expect(crumb).toContain("_history_tree list");
		});

		it("returns breadcrumb with branch chain for nested session", () => {
			const sessions = [
				{ session_id: "s1", thread_id: "t1", workspace_id: "ws", event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" }, created_by: "user_explicit" as const, created_at: 1000 },
				{ session_id: "s2", thread_id: "t1", workspace_id: "ws", parent_session_id: "s1", event_range: { start_event_id: "e1", end_event_id: "HEAD" }, created_by: "fork" as const, created_at: 2000 },
				{ session_id: "s3", thread_id: "t1", workspace_id: "ws", parent_session_id: "s2", event_range: { start_event_id: "e2", end_event_id: "HEAD" }, created_by: "fork" as const, created_at: 3000 },
			];
			const crumb = buildSessionBreadcrumb(sessions, "s3");
			expect(crumb).toContain("s3");
			expect(crumb).toContain("depth 2");
			expect(crumb).toContain("s1 → s2 → s3");
		});
	});
});
