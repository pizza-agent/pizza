/**
 * Headless Integration Test
 *
 * Verifies the full event-sourced runtime stack works end-to-end
 * without any UI, LLM, or filesystem dependencies.
 *
 * Tests:
 * 1. EventStore persistence and querying
 * 2. SessionManager session lifecycle
 * 3. GoalProjection + GoalScheduler integration
 * 4. TimelineProjection output
 * 5. Reactor event flow (mock LLM)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { GoalProjection } from "../src/core/projection/goal-projection.js";
import { GoalScheduler } from "../src/core/goal/scheduler.js";
import { TimelineProjection } from "../src/core/projection/timeline-projection.js";
import { Reactor } from "../src/core/runtime/reactor.js";
import { IntentClassifier } from "../src/core/intent/classifier.js";
import { SessionProjection } from "../src/core/projection/session-projection.js";
import type { SessionDescriptor } from "../src/core/projection/types.js";
import type { EventBase } from "../src/core/event-store/types.js";
import type { ToolExecutionResult, ToolRegistry, ToolExecutor, ToolMetadata } from "../src/core/intent/types.js";
import type { RuntimeAdapter, RuntimeStatus, CheckpointRef, CheckpointRequest, ToolExecutionRequest } from "../src/core/runtime/types.js";

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockToolRegistry(): ToolRegistry {
	const tools = new Map<string, ToolExecutor>();

	tools.set("read", {
		execute: async (args) => ({
			content: [{ type: "text", text: `Contents of ${args.path}` }],
			is_error: false,
		}),
		getMetadata: () => ({ name: "read", category: "file_read" as const, defaultRisk: "safe" as const }),
	});

	tools.set("edit", {
		execute: async (args) => ({
			content: [{ type: "text", text: `Edited ${args.path}` }],
			is_error: false,
			file_mutations: [{ path: args.path as string, operation: "modify" }],
			// Mirrors the real cli `_edit` result: the diff lives in the
			// command's own details rather than in file_mutations.
			details: {
				command: {
					source: "builtin",
					name: "_edit",
					args: { path: args.path },
					details: { diff: "@@ -1 +1 @@\n-old\n+new", firstChangedLine: 1 },
				},
			},
		}),
		// Keep this mock safe so the integration test exercises the mutation
		// event path without a UI approval round-trip.
		getMetadata: () => ({ name: "edit", category: "file_read" as const, defaultRisk: "safe" as const }),
	});

	return {
		get: (name) => tools.get(name),
		list: () => Array.from(tools.keys()),
	};
}

function createMockRuntimeAdapter(toolRegistry: ToolRegistry): RuntimeAdapter {
	return {
		runtime_id: "test_runtime",
		workspace_id: "test_workspace",
		kind: "local",
		async executeTool(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
			const tool = toolRegistry.get(request.tool_name);
			if (!tool) return { content: [{ type: "text", text: "unknown" }], is_error: true };
			return tool.execute(request.arguments);
		},
		async createCheckpoint(_req: CheckpointRequest): Promise<CheckpointRef> {
			return { checkpoint_id: "cp_test", path: "/tmp/cp_test", created_at: Date.now(), label: "test" };
		},
		async restoreCheckpoint(_ref: CheckpointRef): Promise<void> {},
		async getStatus(): Promise<RuntimeStatus> {
			return { runtime_id: "test_runtime", workspace_id: "test_workspace", kind: "local", cwd: "/tmp", status: "idle" };
		},
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("Headless Integration", () => {
	let store: SqliteEventStore;

	beforeEach(() => {
		store = new SqliteEventStore("test_workspace", ":memory:");
	});

	describe("EventStore + SessionManager", () => {
		it("persists events and creates sessions", () => {
			// Append events
			const e1 = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "Hello" } });
			const e2 = store.append({ actor_id: "coder_agent", type: "AGENT_MESSAGE_END", payload: { content: [{ type: "text", text: "Hi" }] } });

			expect(store.size).toBe(2);
			expect(store.get(e1.event_id)).toBeDefined();
			expect(store.head).toBe(e2.event_id);

			// Query by type
			const userMsgs = store.query({ types: ["USER_MESSAGE"] });
			expect(userMsgs).toHaveLength(1);
			expect(userMsgs[0].payload).toEqual({ content: "Hello" });
		});

		it("supports causal chains", () => {
			const root = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "fix bug" } });
			const child = store.append({
				actor_id: "coder_agent",
				type: "AGENT_MESSAGE_END",
				payload: { content: [{ type: "text", text: "done" }] },
				caused_by: root.event_id,
			});

			const chain = store.getCausalChain(child.event_id);
			expect(chain).toHaveLength(2);
			expect(chain[0].event_id).toBe(root.event_id);
			expect(chain[1].event_id).toBe(child.event_id);
		});

		it("supports real-time subscriptions", () => {
			const received: EventBase[] = [];
			const unsub = store.subscribe((e) => received.push(e));

			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "test" } });
			store.append({ actor_id: "runtime", type: "SESSION_CREATED", payload: { session_id: "s1" } });

			expect(received).toHaveLength(2);
			unsub();

			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "after unsub" } });
			expect(received).toHaveLength(2); // no more events
		});
	});

	describe("Goal/Task Full Lifecycle", () => {
		it("runs goal lifecycle: create → plan → schedule → execute → complete", () => {
			// 1. Create goal and tasks
			store.append({ actor_id: "user", type: "GOAL_CREATED", payload: { goal_id: "g1", title: "Add login page" } });
			store.append({ actor_id: "planner", type: "TASK_CREATED", payload: { task_id: "t1", goal_id: "g1", title: "Create component", priority: "high" } });
			store.append({ actor_id: "planner", type: "TASK_CREATED", payload: { task_id: "t2", goal_id: "g1", title: "Write tests", priority: "medium", depends_on: ["t1"] } });

			// 2. Start scheduler BEFORE emitting GOAL_PLANNED (it subscribes to live events)
			const scheduler = new GoalScheduler(store, { maxConcurrency: 1 });

			// 3. Plan triggers scheduling
			store.append({ actor_id: "planner", type: "GOAL_PLANNED", payload: { goal_id: "g1", task_ids: ["t1", "t2"] } });

			// Verify t1 was assigned
			let assignEvents = store.query({ types: ["TASK_ASSIGNED"] });
			expect(assignEvents).toHaveLength(1);
			expect((assignEvents[0].payload as any).task_id).toBe("t1");

			// 4. Execute t1
			store.append({ actor_id: "worker", type: "TASK_STARTED", payload: { task_id: "t1", session_id: "s1" } });
			store.append({ actor_id: "worker", type: "TASK_COMPLETED", payload: { task_id: "t1", summary: "Component created" } });

			// 5. Scheduler auto-dispatches t2 (dependency met)
			assignEvents = store.query({ types: ["TASK_ASSIGNED"] });
			expect(assignEvents).toHaveLength(2);
			expect((assignEvents[1].payload as any).task_id).toBe("t2");

			// 6. Execute t2
			store.append({ actor_id: "tester", type: "TASK_STARTED", payload: { task_id: "t2", session_id: "s2" } });
			store.append({ actor_id: "tester", type: "TASK_COMPLETED", payload: { task_id: "t2", summary: "Tests passing" } });

			// 7. Goal auto-completed
			const goalCompleted = store.query({ types: ["GOAL_COMPLETED"] });
			expect(goalCompleted).toHaveLength(1);
			expect((goalCompleted[0].payload as any).goal_id).toBe("g1");

			// 8. Verify projection state
			const projection = new GoalProjection(store);
			projection.rebuild();

			const goal = projection.getGoal("g1");
			expect(goal?.status).toBe("completed");

			const tasks = projection.getTasksForGoal("g1");
			expect(tasks.every((t) => t.status === "completed")).toBe(true);

			scheduler.stop();
		});
	});

	describe("Timeline Projection", () => {
		it("produces unified timeline from mixed events", () => {
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "Fix the bug in auth.ts" } });
			store.append({ actor_id: "runtime", type: "TOOL_EXECUTION_START", payload: { tool_call_id: "tc1", tool_name: "read_file" } });
			store.append({ actor_id: "runtime", type: "TOOL_EXECUTION_END", payload: { tool_call_id: "tc1", tool_name: "read_file", is_error: false } });
			store.append({ actor_id: "runtime", type: "FILE_MUTATION_APPLIED", payload: { path: "src/auth.ts", operation: "modify" } });
			store.append({ actor_id: "coder_agent", type: "AGENT_MESSAGE_END", payload: { content: [{ type: "text", text: "Fixed the bug" }], stop_reason: "stop" } });
			store.append({ actor_id: "user", type: "GOAL_CREATED", payload: { goal_id: "g1", title: "Fix auth" } });

			const timeline = new TimelineProjection(store);
			const entries = timeline.query();

			expect(entries.length).toBeGreaterThanOrEqual(4);

			const kinds = entries.map((e) => e.kind);
			expect(kinds).toContain("user_message");
			expect(kinds).toContain("tool_execution");
			expect(kinds).toContain("file_mutation");
			expect(kinds).toContain("agent_message");
			expect(kinds).toContain("goal_event");

			// Timeline is chronologically ordered
			for (let i = 1; i < entries.length; i++) {
				expect(entries[i].timestamp).toBeGreaterThanOrEqual(entries[i - 1].timestamp);
			}
		});
	});

	describe("Reactor End-to-End", () => {
		it("processes user message through full reactor cycle", async () => {
			const toolRegistry = createMockToolRegistry();
			const classifier = new IntentClassifier({ require_approval_unknown: false });
			const runtimeAdapter = createMockRuntimeAdapter(toolRegistry);

			// Mock LLM that returns a tool call on first call, then stops
			let callCount = 0;
			const mockLlm = {
				async complete(_request: any) {
					callCount++;
					if (callCount === 1) {
						return {
							content: [
								{ type: "text" as const, text: "Let me read the file" },
								{ type: "tool_call" as const, id: "tc_1", name: "edit", arguments: { path: "src/main.ts" } },
							],
							stopReason: "tool_use" as const,
							provider: "test",
							model: "test-model",
							usage: { input: 100, output: 50, cache_read: 0, cache_write: 0, total: 150, cost: 0 },
						};
					}
					return {
						content: [{ type: "text" as const, text: "Here is the result" }],
						stopReason: "stop" as const,
						provider: "test",
						model: "test-model",
						usage: { input: 200, output: 80, cache_read: 0, cache_write: 0, total: 280, cost: 0 },
					};
				},
			};

			const collected: EventBase[] = [];
			store.subscribe((e) => collected.push(e));

			const descriptor: SessionDescriptor = {
				session_id: "test_session",
				workspace_id: "test_workspace",
				event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" },
				created_by: "user_explicit",
				created_at: Date.now(),
			};
			const projection = new SessionProjection(store, descriptor);

			const reactor = new Reactor({
				store,
				projection,
				llmClient: mockLlm,
				classifier,
				toolRegistry,
				runtimeAdapter,
				model: { provider: "test", model_id: "test-model" },
				tools: [],
				systemPrompt: "You are a coding assistant.",
				contextBudget: 100000,
			});

			reactor.start();

			// Emit user message to kick off the reactor
			store.append({
				actor_id: "user",
				type: "USER_MESSAGE",
				payload: { content: "Read the main file" },
			});

			// Wait for reactor to process
			await new Promise((resolve) => setTimeout(resolve, 500));

			// Verify event flow happened
			const types = collected.map((e) => e.type);
			const mutations = store.query({ types: ["FILE_MUTATION_APPLIED"] });
			expect(mutations).toHaveLength(1);
			expect(mutations[0].payload).toMatchObject({
				path: "src/main.ts",
				operation: "modify",
				diff: "@@ -1 +1 @@\n-old\n+new",
			});
			const toolEnd = store.query({ types: ["TOOL_EXECUTION_END"] })[0];
			expect((toolEnd.payload as { file_mutations?: Array<{ diff?: string }> }).file_mutations?.[0]?.diff)
				.toBe("@@ -1 +1 @@\n-old\n+new");
			expect(types).toContain("USER_MESSAGE");
			expect(types).toContain("LLM_CALL_REQUESTED");
			expect(types).toContain("AGENT_MESSAGE_END");
			expect(types).toContain("TOOL_EXECUTION_START");
			expect(types).toContain("TOOL_EXECUTION_END");

			// Verify LLM was called at least once
			expect(callCount).toBeGreaterThanOrEqual(1);

			reactor.stop();
		});
	});

	describe("Event Replay and Recovery", () => {
		it("rebuilds state from persisted events", () => {
			// Simulate a previous session's events
			store.append({ actor_id: "runtime", type: "SESSION_CREATED", payload: { session_id: "s1", created_by: "user_explicit" } });
			store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "Add feature X" } });
			store.append({ actor_id: "user", type: "GOAL_CREATED", payload: { goal_id: "g1", title: "Feature X" } });
			store.append({ actor_id: "planner", type: "TASK_CREATED", payload: { task_id: "t1", goal_id: "g1", title: "Implement X", priority: "high" } });
			store.append({ actor_id: "planner", type: "GOAL_PLANNED", payload: { goal_id: "g1", task_ids: ["t1"] } });
			store.append({ actor_id: "worker", type: "TASK_STARTED", payload: { task_id: "t1", session_id: "s1" } });

			// "Restart" — create fresh projection from same store (like a process restart)
			const projection = new GoalProjection(store);
			projection.rebuild();

			// State is fully recovered
			const goal = projection.getGoal("g1");
			expect(goal).toBeDefined();
			expect(goal!.title).toBe("Feature X");
			expect(goal!.status).toBe("running");

			const task = projection.getTask("t1");
			expect(task).toBeDefined();
			expect(task!.status).toBe("started");

			// Timeline is also recoverable
			const timeline = new TimelineProjection(store);
			const entries = timeline.query();
			expect(entries.length).toBeGreaterThan(0);
			expect(entries[0].kind).toBe("session_boundary");
		});
	});
});
