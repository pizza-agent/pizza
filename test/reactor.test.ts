/**
 * Reactor end-to-end test.
 *
 * Verifies that a USER_MESSAGE drives the reactor through the full event chain:
 *   USER_MESSAGE → AGENT_TURN_REQUESTED → LLM_CALL_REQUESTED → AGENT_MESSAGE_END
 *     → INTENT_TOOL_CALL → TOOL_EXECUTION_END → TOOL_RESULTS_AGGREGATED
 *     → AGENT_TURN_REQUESTED → LLM_CALL_REQUESTED → AGENT_MESSAGE_END (stop)
 *     → AGENT_TURN_COMPLETED
 *
 * No while-loop is involved — the chain is driven entirely by EventStore subscriptions.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { IntentClassifier } from "../src/core/intent/classifier.js";
import { Reactor } from "../src/core/runtime/reactor.js";
import { SessionManager } from "../src/core/projection/session-manager.js";
import { buildSessionBreadcrumb } from "../src/core/projection/history-tree.js";
import type { LLMClient, LLMResponse } from "../src/core/runtime/llm-types.js";
import type { ToolExecutor, ToolRegistry } from "../src/core/intent/types.js";
import type { ContentBlock } from "../src/core/event-store/types.js";

describe("Reactor (event-driven core)", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pizza-reactor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	function makeRegistry(): ToolRegistry {
		return {
			get(name: string): ToolExecutor | undefined {
				if (name !== "echo") return undefined;
				return {
					async execute(args) {
						return { content: [{ type: "text", text: String(args.text ?? "") }], is_error: false };
					},
					getMetadata() {
						return { name: "echo", category: "file_read", defaultRisk: "safe" };
					},
				};
			},
			list() {
				return ["echo"];
			},
		};
	}

	function makeCliRegistry(): ToolRegistry {
		return {
			get(name: string): ToolExecutor | undefined {
				if (name !== "cli") return undefined;
				return {
					async execute(args) {
						return { content: [{ type: "text", text: String(args.command ?? "") }], is_error: false };
					},
					getMetadata() {
						return { name: "cli", category: "shell_moderate", defaultRisk: "moderate" };
					},
				};
			},
			list() {
				return ["cli"];
			},
		};
	}

	/** Scripted LLM client: first call returns a tool_use, second call returns a stop. */
	function makeScriptedClient(): { client: LLMClient; callCount: () => number } {
		let calls = 0;
		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				if (calls === 1) {
					const content: ContentBlock[] = [
						{ type: "tool_call", id: "call_1", name: "echo", arguments: { text: "hello" } } as ContentBlock,
					];
					return {
						content,
						provider: "test",
						model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "tool_use",
					};
				}
				return {
					content: [{ type: "text", text: "done" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};
		return { client, callCount: () => calls };
	}

	it("drives a complete turn purely through events (no while-loop)", async () => {
		const cwd = makeTempDir();
		const registry = makeRegistry();
		const { client, callCount } = makeScriptedClient();

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: registry,
			llmClient: client,
			classifierConfig: { approve_unknown: false },
			systemPrompt: "test system",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		await runtime.prompt("please echo hello");

		// LLM should have been called twice: once with tool_use, once with stop
		expect(callCount()).toBe(2);

		expect(runtime.store.query({ types: ["USER_MESSAGE"] })).toHaveLength(1);
		expect(runtime.store.query({ types: ["AGENT_TURN_REQUESTED"] })).toHaveLength(2); // initial + after tool results
		expect(runtime.store.query({ types: ["LLM_CALL_REQUESTED"] })).toHaveLength(2);
		expect(runtime.store.query({ types: ["INTENT_TOOL_CALL"] })).toHaveLength(1);
		expect(runtime.store.query({ types: ["TOOL_EXECUTION_END"] })).toHaveLength(1);
		expect(runtime.store.query({ types: ["TOOL_RESULTS_AGGREGATED"] })).toHaveLength(1);
		expect(runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] })).toHaveLength(1);

		const completed = runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] })[0];
		expect((completed.payload as { reason: string }).reason).toBe("stop");

		runtime.dispose();
	});

	it("runs beforeAgentStart once per user prompt and applies the returned system prompt", async () => {
		const cwd = makeTempDir();
		const registry = makeRegistry();
		const seenSystemPrompts: string[] = [];
		let calls = 0;
		const client: LLMClient = {
			async complete(request) {
				calls++;
				seenSystemPrompts.push(request.systemPrompt ?? "");
				if (calls === 1) {
					const content: ContentBlock[] = [
						{ type: "tool_call", id: "call_1", name: "echo", arguments: { text: "hello" } } as ContentBlock,
					];
					return {
						content,
						provider: "test",
						model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "tool_use",
					};
				}
				return {
					content: [{ type: "text", text: "done" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		let hookCalls = 0;
		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: registry,
			llmClient: client,
			classifierConfig: { approve_unknown: false },
			systemPrompt: "base system",
			model: { provider: "test", model_id: "test" },
			tools: [],
			beforeAgentStart: async (payload) => {
				hookCalls++;
				return { systemPrompt: `base system + hint for: ${payload.prompt}` };
			},
		});

		await runtime.prompt("say hi");

		// Hook fired exactly once for the user prompt — not again on the tool-results round.
		expect(hookCalls).toBe(1);
		// Both LLM rounds of the turn used the injected system prompt.
		expect(seenSystemPrompts.length).toBe(2);
		for (const sp of seenSystemPrompts) {
			expect(sp).toBe("base system + hint for: say hi");
		}

		// A second user prompt fires the hook again (once).
		calls = 0;
		seenSystemPrompts.length = 0;
		await runtime.prompt("say hi again").catch(() => {});
		expect(hookCalls).toBe(2);
		if (seenSystemPrompts.length > 0) {
			for (const sp of seenSystemPrompts) {
				expect(sp).toBe("base system + hint for: say hi again");
			}
		}

		runtime.dispose();
	});

	it("refreshes the session breadcrumb before prompting after an out-of-band session switch", async () => {
		const cwd = makeTempDir();
		const store = new SqliteEventStore(`runtime-refresh-${Date.now()}`, join(cwd, "events.sqlite"));
		const sessionManager = new SessionManager(store, store);
		const root = sessionManager.createSession("user_explicit", "old root");
		const stale = sessionManager.createSession("fork", "old branch", { parentSessionId: root.session_id });
		const basePrompt = "test system";
		const stalePrompt = `${basePrompt}\n${buildSessionBreadcrumb(sessionManager.listSessions(), stale.session_id)}`;
		let capturedPrompt = "";
		const client: LLMClient = {
			async complete(request): Promise<LLMResponse> {
				capturedPrompt = request.systemPrompt ?? "";
				return {
					content: [{ type: "text", text: "done" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};
		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			store,
			sessionManager,
			toolRegistry: makeRegistry(),
			llmClient: client,
			systemPrompt: stalePrompt,
			model: { provider: "test", model_id: "test" },
			tools: [],
			refreshSystemPrompt: () => {
				const breadcrumb = buildSessionBreadcrumb(sessionManager.listSessions(), sessionManager.getActiveSessionId());
				return breadcrumb ? `${basePrompt}\n${breadcrumb}` : basePrompt;
			},
		});

		const fresh = sessionManager.createSession("user_explicit", "fresh root");
		await runtime.prompt("what did I ask in this session?");

		expect(fresh.parent_session_id).toBeUndefined();
		expect(fresh.context_parent_session_id).toBeUndefined();
		expect(capturedPrompt).toBe(basePrompt);
		expect(capturedPrompt).not.toContain(stale.session_id);

		runtime.dispose();
		store.close();
	});

	it("passes tool execution context through the runtime and emits updates", async () => {
		const cwd = makeTempDir();
		let receivedToolCallId: string | undefined;
		let receivedSignal: AbortSignal | undefined;
		const registry: ToolRegistry = {
			get(name: string): ToolExecutor | undefined {
				if (name !== "echo") return undefined;
				return {
					async execute(args, options) {
						receivedToolCallId = options?.tool_call_id;
						receivedSignal = options?.signal;
						options?.onUpdate?.({
							content: [{ type: "text", text: `partial ${String(args.text ?? "")}` }],
						});
						return { content: [{ type: "text", text: String(args.text ?? "") }], is_error: false };
					},
					getMetadata() {
						return { name: "echo", category: "file_read", defaultRisk: "safe" };
					},
				};
			},
			list() {
				return ["echo"];
			},
		};

		let calls = 0;
		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				if (calls === 1) {
					return {
						content: [
							{ type: "tool_call", id: "call_update", name: "echo", arguments: { text: "hello" } } as ContentBlock,
						],
						provider: "test",
						model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "tool_use",
					};
				}
				return {
					content: [{ type: "text", text: "done" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: registry,
			llmClient: client,
			classifierConfig: { require_approval_unknown: false },
			systemPrompt: "test system",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		await runtime.prompt("please echo hello");

		const updates = runtime.store.query({ types: ["TOOL_EXECUTION_UPDATE"] });
		expect(receivedToolCallId).toBe("call_update");
		expect(receivedSignal).toBeInstanceOf(AbortSignal);
		expect(updates).toHaveLength(1);
		expect((updates[0].payload as { tool_call_id: string; update: string }).tool_call_id).toBe("call_update");
		expect((updates[0].payload as { tool_call_id: string; update: string }).update).toBe("partial hello");

		runtime.dispose();
	});

	it("executes legacy camelCase toolCall blocks returned by a provider", async () => {
		const cwd = makeTempDir();
		const registry = makeRegistry();
		let calls = 0;
		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				if (calls === 1) {
					return {
						content: [
							{ type: "toolCall", id: "call_legacy", name: "echo", arguments: { text: "hello" } } as any,
						],
						provider: "test",
						model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "tool_use",
					};
				}
				return {
					content: [{ type: "text", text: "done" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: registry,
			llmClient: client,
			classifierConfig: { approve_unknown: false },
			systemPrompt: "test system",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		await runtime.prompt("please echo hello");

		expect(calls).toBe(2);
		expect(runtime.store.query({ types: ["INTENT_TOOL_CALL"] })).toHaveLength(1);
		expect(runtime.store.query({ types: ["TOOL_EXECUTION_END"] })).toHaveLength(1);
		expect(runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] })).toHaveLength(1);

		runtime.dispose();
	});

	it("emits AGENT_TURN_COMPLETED immediately when LLM returns stop on first call", async () => {
		const cwd = makeTempDir();
		const registry = makeRegistry();

		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				return {
					content: [{ type: "text", text: "hi" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: registry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		await runtime.prompt("hi");

		expect(runtime.store.query({ types: ["INTENT_TOOL_CALL"] })).toHaveLength(0);
		expect(runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] })).toHaveLength(1);
		runtime.dispose();
	});

	it("classifies LLM failures and emits LLM_CALL_FAILED → eventually completes with error", async () => {
		const cwd = makeTempDir();
		const registry = makeRegistry();

		// Always fail with a non-retryable error
		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				throw new Error("permanent auth failure");
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: registry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		await runtime.prompt("hello");

		const failed = runtime.store.query({ types: ["LLM_CALL_FAILED"] });
		expect(failed).toHaveLength(1);
		expect((failed[0].payload as { retryable: boolean }).retryable).toBe(false);

		const completed = runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] });
		expect(completed).toHaveLength(1);
		expect((completed[0].payload as { reason: string }).reason).toBe("error");

		runtime.dispose();
	});

	it("aggregates parallel tool calls before requesting the next turn", async () => {
		const cwd = makeTempDir();
		const registry = makeRegistry();

		let calls = 0;
		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				if (calls === 1) {
					return {
						content: [
							{ type: "tool_call", id: "c1", name: "echo", arguments: { text: "a" } } as ContentBlock,
							{ type: "tool_call", id: "c2", name: "echo", arguments: { text: "b" } } as ContentBlock,
							{ type: "tool_call", id: "c3", name: "echo", arguments: { text: "c" } } as ContentBlock,
						],
						provider: "test",
						model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "tool_use",
					};
				}
				return {
					content: [{ type: "text", text: "done" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: registry,
			llmClient: client,
			classifierConfig: { approve_unknown: false },
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		await runtime.prompt("run three");

		expect(runtime.store.query({ types: ["INTENT_TOOL_CALL"] })).toHaveLength(3);
		expect(runtime.store.query({ types: ["TOOL_EXECUTION_END"] })).toHaveLength(3);
		expect(runtime.store.query({ types: ["TOOL_RESULTS_AGGREGATED"] })).toHaveLength(1);

		const aggregated = runtime.store.query({ types: ["TOOL_RESULTS_AGGREGATED"] })[0];
		expect((aggregated.payload as { tool_call_count: number }).tool_call_count).toBe(3);
		expect((aggregated.payload as { any_error: boolean }).any_error).toBe(false);

		runtime.dispose();
	});

	it("executes dev-null redirected shell lookups in a parallel tool batch", async () => {
		const cwd = makeTempDir();
		const registry = makeCliRegistry();

		let calls = 0;
		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				if (calls === 1) {
					return {
						content: [
							{ type: "tool_call", id: "c1", name: "cli", arguments: { command: "ls -la .claude/" } } as ContentBlock,
							{ type: "tool_call", id: "c2", name: "cli", arguments: { command: "ls -la .crush/" } } as ContentBlock,
							{
								type: "tool_call",
								id: "c3",
								name: "cli",
								arguments: {
									command: "which zai-cli 2>/dev/null; type zai-cli 2>/dev/null; npm list -g 2>/dev/null | grep -i zai",
								},
							} as ContentBlock,
						],
						provider: "test",
						model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "tool_use",
					};
				}
				return {
					content: [{ type: "text", text: "done" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: registry,
			llmClient: client,
			classifierConfig: { approve_unknown: false },
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		await runtime.prompt("run three shell lookups");

		const intents = runtime.store.query({ types: ["INTENT_TOOL_CALL"] });
		expect(intents).toHaveLength(3);
		expect((intents[2].payload as { requires_approval: boolean }).requires_approval).toBe(false);
		expect(runtime.store.query({ types: ["TOOL_EXECUTION_START"] })).toHaveLength(3);
		expect(runtime.store.query({ types: ["TOOL_EXECUTION_END"] })).toHaveLength(3);
		expect(runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] })).toHaveLength(1);
		expect(calls).toBe(2);

		runtime.dispose();
	});

	it("does not hang when approval is required without an approval handler", async () => {
		const cwd = makeTempDir();
		const registry = makeCliRegistry();

		let calls = 0;
		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				if (calls === 1) {
					return {
						content: [
							{ type: "tool_call", id: "danger", name: "cli", arguments: { command: "sudo whoami" } } as ContentBlock,
						],
						provider: "test",
						model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "tool_use",
					};
				}
				return {
					content: [{ type: "text", text: "done" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: registry,
			llmClient: client,
			classifierConfig: { approve_unknown: false },
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		await runtime.prompt("run dangerous command");

		const starts = runtime.store.query({ types: ["TOOL_EXECUTION_START"] });
		const ends = runtime.store.query({ types: ["TOOL_EXECUTION_END"] });
		// A rejected/blocked tool call still emits a START→END pair so the event
		// log stays consistent (no orphan END without a matching START).
		expect(starts).toHaveLength(1);
		expect(ends).toHaveLength(1);
		expect((ends[0].payload as { is_error: boolean }).is_error).toBe(true);
		expect(JSON.stringify((ends[0].payload as { result: unknown }).result)).toContain("no approval handler");
		expect(runtime.store.query({ types: ["TOOL_RESULTS_AGGREGATED"] })).toHaveLength(1);
		expect(runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] })).toHaveLength(1);
		expect(calls).toBe(2);

		runtime.dispose();
	});

	it("blocks a tool for approval in safe mode until approved", async () => {
		const cwd = makeTempDir();
		const registry = makeCliRegistry();

		let calls = 0;
		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				if (calls === 1) {
					return {
						content: [
							{ type: "tool_call", id: "write1", name: "cli", arguments: { command: "echo hi > out.txt" } } as ContentBlock,
						],
						provider: "test",
						model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "tool_use",
					};
				}
				return {
					content: [{ type: "text", text: "done" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: registry,
			llmClient: client,
			// safe_mode on → file-writing shell redirection requires approval.
			classifierConfig: { safe_mode: true },
			// A no-op approval handler (like the facade uses) keeps the reactor
			// waiting; resolution comes from runtime.approve()/reject().
			approvalHandler: { requestApproval: () => {}, cancelApproval: () => {} },
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		// Drive the prompt without awaiting — it should block on approval.
		const promptPromise = runtime.prompt("write a file");

		// Wait until an INTENT_TOOL_CALL is recorded, then approve it.
		await new Promise<void>((resolve) => {
			const unsub = runtime.store.subscribe((event) => {
				if (event.type === "INTENT_TOOL_CALL") {
					unsub();
					resolve();
				}
			});
		});

		const intent = runtime.store.query({ types: ["INTENT_TOOL_CALL"] });
		expect(intent).toHaveLength(1);
		expect((intent[0].payload as { requires_approval: boolean }).requires_approval).toBe(true);

		// Approve via the runtime (emits USER_APPROVAL → reactor resolves).
		runtime.approve(intent[0].event_id);

		await promptPromise;

		const ends = runtime.store.query({ types: ["TOOL_EXECUTION_END"] });
		expect(ends).toHaveLength(1);
		expect((ends[0].payload as { is_error: boolean }).is_error).toBe(false);
		expect(runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] })).toHaveLength(1);

		runtime.dispose();
	});

	it("rejects a tool in safe mode when runtime.reject() is called", async () => {
		const cwd = makeTempDir();
		const registry = makeCliRegistry();

		let calls = 0;
		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				if (calls === 1) {
					return {
						content: [
							{ type: "tool_call", id: "write1", name: "cli", arguments: { command: "echo hi > out.txt" } } as ContentBlock,
						],
						provider: "test",
						model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "tool_use",
					};
				}
				return {
					content: [{ type: "text", text: "done" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: registry,
			llmClient: client,
			classifierConfig: { safe_mode: true },
			approvalHandler: { requestApproval: () => {}, cancelApproval: () => {} },
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		const promptPromise = runtime.prompt("write a file");

		await new Promise<void>((resolve) => {
			const unsub = runtime.store.subscribe((event) => {
				if (event.type === "INTENT_TOOL_CALL") {
					unsub();
					resolve();
				}
			});
		});

		const intent = runtime.store.query({ types: ["INTENT_TOOL_CALL"] })[0];
		runtime.reject(intent.event_id);

		await promptPromise;

		const ends = runtime.store.query({ types: ["TOOL_EXECUTION_END"] });
		expect(ends).toHaveLength(1);
		expect((ends[0].payload as { is_error: boolean }).is_error).toBe(true);
		expect(JSON.stringify((ends[0].payload as { result: unknown }).result)).toContain("rejected by user");

		runtime.dispose();
	});

	it("safe_mode=false bypasses approval even for dangerous tools", async () => {
		const cwd = makeTempDir();
		const registry = makeCliRegistry();

		let calls = 0;
		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				if (calls === 1) {
					return {
						content: [
							{ type: "tool_call", id: "danger", name: "cli", arguments: { command: "sudo whoami" } } as ContentBlock,
						],
						provider: "test",
						model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "tool_use",
					};
				}
				return {
					content: [{ type: "text", text: "done" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: registry,
			llmClient: client,
			classifierConfig: { safe_mode: false },
			approvalHandler: { requestApproval: () => {}, cancelApproval: () => {} },
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		await runtime.prompt("run dangerous command");

		const intent = runtime.store.query({ types: ["INTENT_TOOL_CALL"] })[0];
		expect((intent.payload as { requires_approval: boolean }).requires_approval).toBe(false);
		// Tool ran to completion without blocking on approval.
		const ends = runtime.store.query({ types: ["TOOL_EXECUTION_END"] });
		expect(ends).toHaveLength(1);
		expect((ends[0].payload as { is_error: boolean }).is_error).toBe(false);

		runtime.dispose();
	});

	it("aggregates completed tools via assistant_message_event_id carried on INTENT_TOOL_CALL", async () => {
		const cwd = makeTempDir();
		const store = new SqliteEventStore("reactor-causality-fallback", ":memory:");
		const registry = makeRegistry();
		const reactor = new Reactor({
			store,
			projection: {} as any,
			llmClient: { async complete() { throw new Error("not used"); } },
			classifier: new IntentClassifier({ approve_writes: false, approve_edits: false, approve_shell_moderate: false, approve_unknown: false }),
			toolRegistry: registry,
			runtimeAdapter: {
				runtime_id: "test_runtime",
				workspace_id: store.workspace_id,
				kind: "local",
				async executeTool() {
					return { content: [{ type: "text", text: "not used" }], is_error: false };
				},
				async createCheckpoint() {
					return { id: "checkpoint", label: "checkpoint", runtime_id: "test_runtime", created_at: Date.now(), metadata: {} };
				},
				async restoreCheckpoint() {},
				async getStatus() {
					return { runtime_id: "test_runtime", workspace_id: store.workspace_id, kind: "local", cwd, status: "idle" };
				},
			},
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			contextBudget: 128000,
			tools: [],
		});

		const assistantEnd = store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [
					{ type: "tool_call", id: "missing_chain_1", name: "echo", arguments: { text: "a" } },
					{ type: "tool_call", id: "missing_chain_2", name: "echo", arguments: { text: "b" } },
				],
				model: { provider: "test", model_id: "test" },
				usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
				stop_reason: "tool_use",
			},
		});

		await (reactor as any)._onAgentMessageEnd(assistantEnd);

		// _onAgentMessageEnd emitted one INTENT_TOOL_CALL per tool call, each
		// carrying assistant_message_event_id. TOOL_EXECUTION_END references its
		// intent via caused_by — the only supported lookup path.
		const intents = store.query({ types: ["INTENT_TOOL_CALL"] });
		expect(intents).toHaveLength(2);
		for (const intent of intents) {
			expect((intent.payload as { assistant_message_event_id: string }).assistant_message_event_id).toBe(
				assistantEnd.event_id,
			);
		}
		const intentByToolCallId = new Map(
			intents.map((intent) => [(intent.payload as { tool_call_id: string }).tool_call_id, intent]),
		);

		const firstResult = store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: {
				tool_call_id: "missing_chain_1",
				tool_name: "echo",
				result: [{ type: "text", text: "a" }],
				is_error: false,
			},
			caused_by: intentByToolCallId.get("missing_chain_1")!.event_id,
		});
		const secondResult = store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: {
				tool_call_id: "missing_chain_2",
				tool_name: "echo",
				result: [{ type: "text", text: "b" }],
				is_error: false,
			},
			caused_by: intentByToolCallId.get("missing_chain_2")!.event_id,
		});

		await (reactor as any)._onToolExecutionEnd(firstResult);
		await (reactor as any)._onToolExecutionEnd(secondResult);

		expect(store.query({ types: ["TOOL_RESULTS_AGGREGATED"] })).toHaveLength(1);
		const aggregated = store.query({ types: ["TOOL_RESULTS_AGGREGATED"] })[0];
		expect((aggregated.payload as { tool_call_count: number }).tool_call_count).toBe(2);

		store.close();
	});

	// ─── Loop detection ──────────────────────────────────────────────────────

	it("does NOT trigger loop detection when the same tool is called with different arguments", async () => {
		const cwd = makeTempDir();
		const registry = makeCliRegistry();

		// LLM calls `cli` 8 times with different commands, then stops.
		// Before the fix (signature = tool name only), 6 consecutive `cli`
		// rounds would trigger loop_detected. With argument-aware signatures,
		// each round is unique so no loop is detected.
		let calls = 0;
		const commands = ["ls", "pwd", "whoami", "date", "echo a", "echo b", "echo c", "echo d"];
		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				if (calls <= commands.length) {
					return {
						content: [
							{ type: "tool_call", id: `call_${calls}`, name: "cli", arguments: { command: commands[calls - 1] } } as ContentBlock,
						],
						provider: "test",
						model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "tool_use",
					};
				}
				return {
					content: [{ type: "text", text: "done" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: registry,
			llmClient: client,
			classifierConfig: { approve_unknown: false },
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		await runtime.prompt("run 8 different commands");

		const completed = runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] });
		expect(completed).toHaveLength(1);
		expect((completed[0].payload as { reason: string }).reason).toBe("stop");
		expect(calls).toBe(commands.length + 1); // 8 tool rounds + 1 stop

		runtime.dispose();
	});

	it("triggers loop detection when the same tool is called with identical arguments repeatedly", async () => {
		const cwd = makeTempDir();
		const registry = makeCliRegistry();

		// LLM calls `cli` with the EXACT same command 8 times.
		// After 6 consecutive identical rounds, loop_detected should fire.
		let calls = 0;
		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				return {
					content: [
						{ type: "tool_call", id: `call_${calls}`, name: "cli", arguments: { command: "same command" } } as ContentBlock,
					],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "tool_use",
				};
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: registry,
			llmClient: client,
			classifierConfig: { approve_unknown: false },
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		await runtime.prompt("run same command repeatedly");

		const completed = runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] });
		expect(completed).toHaveLength(1);
		expect((completed[0].payload as { reason: string }).reason).toBe("loop_detected");
		// Should stop after 6 identical rounds, not 8
		expect(calls).toBe(6);

		runtime.dispose();
	});
});
