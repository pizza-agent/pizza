/**
 * Reactor stage-2 tests — retry policy + compaction + follow-up queue.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import type { LLMClient, LLMResponse } from "../src/core/runtime/llm-types.js";
import type { CompactionOutcome, CompactionPolicy, RetryPolicy } from "../src/core/runtime/policies.js";
import type { ToolExecutor, ToolRegistry } from "../src/core/intent/types.js";
import type { ContentBlock, EventBase, EventType } from "../src/core/event-store/types.js";

describe("Reactor stage-2: policies + queues", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pizza-reactor2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	const emptyRegistry: ToolRegistry = {
		get: () => undefined,
		list: () => [],
	};

	function makeEchoRegistry(): ToolRegistry {
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

	function waitForEvent(runtime: EventSourcedRuntime, type: EventType, timeoutMs = 1000): Promise<EventBase> {
		const existing = runtime.store.query({ types: [type], reverse: true, limit: 1 })[0];
		if (existing) return Promise.resolve(existing);

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timed out waiting for ${type}`));
			}, timeoutMs);
			const unsubscribe = runtime.subscribe((event) => {
				if (event.type !== type) return;
				clearTimeout(timeout);
				unsubscribe();
				resolve(event);
			}, { types: [type] });
		});
	}

	// ────────────────────────────────────────────────────────────────────────
	// Runtime public API
	// ────────────────────────────────────────────────────────────────────────

	it("rejects a second prompt while a turn is active and waitForIdle resolves after abort", async () => {
		const cwd = makeTempDir();

		const client: LLMClient = {
			async complete(req): Promise<LLMResponse> {
				await new Promise<void>((resolve) => req.signal?.addEventListener("abort", () => resolve(), { once: true }));
				throw new Error("aborted");
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: emptyRegistry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		const firstPrompt = runtime.prompt("first");
		await waitForEvent(runtime, "LLM_CALL_REQUESTED");

		await expect(runtime.prompt("second")).rejects.toThrow("already processing");

		const idle = runtime.waitForIdle();
		runtime.abort();
		await firstPrompt;
		await expect(idle).resolves.toBeUndefined();

		runtime.dispose();
	});

	it("records public API changes as events", () => {
		const cwd = makeTempDir();
		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: emptyRegistry,
			llmClient: {
				async complete(): Promise<LLMResponse> {
					throw new Error("not used");
				},
			},
			systemPrompt: "old prompt",
			model: { provider: "old-provider", model_id: "old-model", thinking_level: "low" },
			tools: [],
		});

		runtime.setModel("new-provider", "new-model");
		runtime.setThinkingLevel("high");
		runtime.setSystemPrompt("new prompt");
		runtime.setTools([{ name: "read", description: "Read files", input_schema: { type: "object" } }]);
		runtime.compact({ token_count: 1234 });

		expect(runtime.getSystemPrompt()).toBe("new prompt");
		expect(runtime.getTools()).toEqual([{ name: "read", description: "Read files", input_schema: { type: "object" } }]);
		expect(runtime.getProjection().buildContext().messages).toHaveLength(0);

		const modelChanged = runtime.store.query({ types: ["MODEL_CHANGED"] })[0];
		expect(modelChanged.payload).toMatchObject({
			provider: "new-provider",
			model_id: "new-model",
			previous_provider: "old-provider",
			previous_model_id: "old-model",
		});
		expect(runtime.store.query({ types: ["THINKING_LEVEL_CHANGED"] })[0].payload).toMatchObject({
			level: "high",
			previous_level: "low",
		});
		expect(runtime.store.query({ types: ["USER_CONFIG_CHANGE"] })).toHaveLength(2);
		expect(runtime.store.query({ types: ["COMPACTION_REQUESTED"] })[0].payload).toMatchObject({
			reason: "manual",
			token_count: 1234,
		});

		runtime.dispose();
	});

	// ────────────────────────────────────────────────────────────────────────
	// Retry policy
	// ────────────────────────────────────────────────────────────────────────

	it("retries retryable errors per policy and eventually succeeds", async () => {
		const cwd = makeTempDir();
		let calls = 0;

		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				if (calls < 3) throw new Error("overloaded_error: please retry");
				return {
					content: [{ type: "text", text: "ok" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		// Custom retry policy: 5 attempts, 1ms delay
		const retryPolicy: RetryPolicy = {
			maxAttempts: 5,
			isRetryable: (e) => /overloaded/i.test(e.message),
			nextDelayMs: () => 1,
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: emptyRegistry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
			retryPolicy,
		});

		await runtime.prompt("hi");

		expect(calls).toBe(3);
		const failed = runtime.store.query({ types: ["LLM_CALL_FAILED"] });
		expect(failed).toHaveLength(2); // 2 failures before the 3rd success
		const scheduled = runtime.store.query({ types: ["RETRY_SCHEDULED"] });
		expect(scheduled).toHaveLength(2);
		expect((scheduled[0].payload as { attempt: number }).attempt).toBe(1);
		expect((scheduled[1].payload as { attempt: number }).attempt).toBe(2);

		const completed = runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] });
		expect(completed).toHaveLength(1);
		expect((completed[0].payload as { reason: string }).reason).toBe("stop");

		runtime.dispose();
	});

	it("gives up after maxAttempts and completes with error", async () => {
		const cwd = makeTempDir();

		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				throw new Error("overloaded_error");
			},
		};

		const retryPolicy: RetryPolicy = {
			maxAttempts: 2,
			isRetryable: () => true,
			nextDelayMs: () => 1,
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: emptyRegistry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
			retryPolicy,
		});

		await runtime.prompt("hi");

		const completed = runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] });
		expect(completed).toHaveLength(1);
		const payload = completed[0].payload as { reason: string; error_message?: string };
		expect(payload.reason).toBe("error");
		expect(payload.error_message).toMatch(/Max retries \(2\) exceeded/);

		runtime.dispose();
	});

	it("retries assistant error completions and waits for the retry to settle", async () => {
		const cwd = makeTempDir();
		let calls = 0;

		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				if (calls === 1) {
					return {
						content: [{ type: "text", text: "provider overloaded" } as ContentBlock],
						provider: "test",
						model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "error",
						errorMessage: "overloaded_error: retry later",
					};
				}
				return {
					content: [{ type: "text", text: "ok" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		const retryPolicy: RetryPolicy = {
			maxAttempts: 3,
			isRetryable: (error) => /overloaded/.test(error.message),
			nextDelayMs: () => 1,
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: emptyRegistry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
			retryPolicy,
		});

		await runtime.prompt("hi");

		expect(calls).toBe(2);
		const scheduled = runtime.store.query({ types: ["RETRY_SCHEDULED"] });
		expect(scheduled).toHaveLength(1);
		expect((scheduled[0].payload as { error_message: string }).error_message).toContain("overloaded_error");
		const completed = runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] });
		expect(completed.map((event) => (event.payload as { reason: string }).reason)).toEqual(["error", "stop"]);

		runtime.dispose();
	});

	it("resets the retry budget after successful tool rounds in a long task", async () => {
		const cwd = makeTempDir();
		let calls = 0;
		const runtime = new EventSourcedRuntime({
			cwd, agentDir: cwd, toolRegistry: makeEchoRegistry(),
			systemPrompt: "", model: { provider: "test", model_id: "test" }, tools: [],
			retryPolicy: { maxAttempts: 1, isRetryable: () => true, nextDelayMs: () => 1 },
			llmClient: { async complete(): Promise<LLMResponse> {
				calls++;
				const error = calls === 1 || calls === 3 || calls === 5;
				return {
					provider: "test", model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: error ? "error" : calls < 6 ? "tool_use" : "stop",
					errorMessage: error ? "The socket connection was closed unexpectedly" : undefined,
					content: error ? [] : calls < 6
						? [{ type: "tool_call", id: `echo-${calls}`, name: "echo", arguments: { text: String(calls) } }]
						: [{ type: "text", text: "finished" }],
				};
			} },
		});
		try {
			await runtime.prompt("long task");
			expect(calls).toBe(6);
			expect(runtime.store.query({ types: ["RETRY_SCHEDULED"] }).map(e => (e.payload as { attempt: number }).attempt)).toEqual([1, 1, 1]);
			expect(runtime.store.query({ types: ["AGENT_TURN_COMPLETED"], reverse: true, limit: 1 })[0].payload).toMatchObject({ reason: "stop" });
		} finally { runtime.dispose(); }
	});

	it("completes with error when retry backoff is exhausted", async () => {
		const cwd = makeTempDir();

		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				throw new Error("overloaded_error");
			},
		};

		const retryPolicy: RetryPolicy = {
			maxAttempts: 5,
			isRetryable: () => true,
			nextDelayMs: () => null,
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: emptyRegistry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
			retryPolicy,
		});

		await runtime.prompt("hi");

		expect(runtime.store.query({ types: ["RETRY_SCHEDULED"] })).toHaveLength(0);
		const completed = runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] });
		expect(completed).toHaveLength(1);
		expect((completed[0].payload as { error_message?: string }).error_message).toMatch(/Retry backoff exhausted/);

		runtime.dispose();
	});

	it("aborts a scheduled retry without hanging the active prompt", async () => {
		const cwd = makeTempDir();

		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				throw new Error("retryable outage");
			},
		};

		const retryPolicy: RetryPolicy = {
			maxAttempts: 5,
			isRetryable: () => true,
			nextDelayMs: () => 1000,
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: emptyRegistry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
			retryPolicy,
		});

		const prompt = runtime.prompt("hi");
		const scheduled = await waitForEvent(runtime, "RETRY_SCHEDULED");
		runtime.abort();
		await prompt;

		const aborted = runtime.store.query({ types: ["RETRY_ABORTED"] });
		expect(aborted).toHaveLength(1);
		expect(aborted[0].payload).toMatchObject({
			attempt: 1,
			reason: "user_interrupt",
			scheduled_event_id: scheduled.event_id,
		});
		const completed = runtime.store.query({ types: ["AGENT_TURN_COMPLETED"], reverse: true, limit: 1 })[0];
		expect(completed.payload).toMatchObject({ reason: "aborted" });

		runtime.dispose();
	});

	// ────────────────────────────────────────────────────────────────────────
	// Follow-up queue
	// ────────────────────────────────────────────────────────────────────────

	it("processes follow-up messages after the current turn completes", async () => {
		const cwd = makeTempDir();
		const seen: string[] = [];

		const client: LLMClient = {
			async complete(req): Promise<LLMResponse> {
				const last = req.messages[req.messages.length - 1];
				if (last.role === "user") {
					const c = typeof last.content === "string" ? last.content : "?";
					seen.push(c);
				}
				return {
					content: [{ type: "text", text: "ok" } as ContentBlock],
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
			toolRegistry: emptyRegistry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		// Queue follow-up BEFORE the prompt — both should run in sequence.
		runtime.followUp("second message");

		await runtime.prompt("first message");

		// Both turns should have completed
		expect(seen).toEqual(["first message", "second message"]);
		expect(runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] })).toHaveLength(2);

		runtime.dispose();
	});

	it("does not replay a consumed follow-up after reactor restart (regression for auto-injection bug)", async () => {
		const cwd = makeTempDir();
		const seen: string[] = [];

		const client: LLMClient = {
			async complete(req): Promise<LLMResponse> {
				const last = req.messages[req.messages.length - 1];
				if (last.role === "user") {
					const c = typeof last.content === "string" ? last.content : "?";
					seen.push(c);
				}
				return {
					content: [{ type: "text", text: "ok" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		const config = {
			cwd,
			agentDir: cwd,
			toolRegistry: emptyRegistry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
		};

		// First runtime: queue a follow-up, then prompt. Both should run.
		const runtime1 = new EventSourcedRuntime(config);
		runtime1.followUp("second message");
		await runtime1.prompt("first message");
		expect(seen).toEqual(["first message", "second message"]);
		expect(runtime1.store.query({ types: ["USER_FOLLOWUP_QUEUED"] })).toHaveLength(1);
		expect(runtime1.store.query({ types: ["USER_MESSAGE"] })).toHaveLength(2);
		// The follow-up USER_MESSAGE must be caused_by the USER_FOLLOWUP_QUEUED event,
		// not the AGENT_TURN_COMPLETED — this is what lets replay detect it as consumed.
		const followupEvent = runtime1.store.query({ types: ["USER_FOLLOWUP_QUEUED"] })[0];
		const userMessages = runtime1.store.query({ types: ["USER_MESSAGE"] });
		const followupUserMessage = userMessages.find((m) => m.caused_by === followupEvent.event_id);
		expect(followupUserMessage).toBeDefined();
		expect(followupUserMessage!.payload).toMatchObject({ content: "second message" });
		runtime1.dispose();

		// Second runtime on the same store: the consumed follow-up must NOT be replayed.
		// Previously the USER_MESSAGE was caused_by AGENT_TURN_COMPLETED, so the
		// USER_FOLLOWUP_QUEUED was never marked consumed and got replayed on every
		// restart, auto-injecting the queued message as a new USER_MESSAGE.
		const seenAfterRestart: string[] = [];
		const runtime2 = new EventSourcedRuntime({
			...config,
			llmClient: {
				async complete(req): Promise<LLMResponse> {
					const last = req.messages[req.messages.length - 1];
					if (last.role === "user") {
						const c = typeof last.content === "string" ? last.content : "?";
						seenAfterRestart.push(c);
					}
					return {
						content: [{ type: "text", text: "ok" } as ContentBlock],
						provider: "test",
						model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "stop",
					};
				},
			},
		});
		// Give the reactor a turn so any (incorrectly) replayed follow-up would fire.
		await runtime2.prompt("third message");
		// Only the new prompt should be seen — the old follow-up must not be replayed.
		expect(seenAfterRestart).toEqual(["third message"]);
		expect(runtime2.store.query({ types: ["USER_MESSAGE"] })).toHaveLength(3);
		runtime2.dispose();
	});

	it("processes steer messages after interrupting the current turn", async () => {
		const cwd = makeTempDir();
		const seen: string[] = [];
		let calls = 0;

		const client: LLMClient = {
			async complete(req): Promise<LLMResponse> {
				calls++;
				if (calls === 1) {
					await new Promise<void>((resolve) => req.signal?.addEventListener("abort", () => resolve(), { once: true }));
					throw new Error("aborted");
				}
				const last = req.messages[req.messages.length - 1];
				if (last.role === "user") {
					seen.push(typeof last.content === "string" ? last.content : "?");
				}
				return {
					content: [{ type: "text", text: "ok" } as ContentBlock],
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
			toolRegistry: emptyRegistry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});

		const prompt = runtime.prompt("first message");
		await waitForEvent(runtime, "LLM_CALL_REQUESTED");
		runtime.steer("redirected message");
		await prompt;

		expect(seen).toEqual(["redirected message"]);
		expect(runtime.store.query({ types: ["USER_INTERRUPT"] })).toHaveLength(1);
		expect(runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] })).toHaveLength(2);
		const completed = runtime.store.query({ types: ["AGENT_TURN_COMPLETED"], reverse: true, limit: 1 })[0];
		expect(completed.payload).toMatchObject({ reason: "stop" });

		runtime.dispose();
	});

	it("runs prompt, tool, follow-up, and manual compaction in one event-driven cycle", async () => {
		const cwd = makeTempDir();
		let calls = 0;
		let runtime: EventSourcedRuntime;

		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				calls++;
				if (calls === 1) {
					return {
						content: [
							{ type: "tool_call", id: "call_echo", name: "echo", arguments: { text: "hello" } } as ContentBlock,
						],
						provider: "test",
						model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "tool_use",
					};
				}
				if (calls === 2) {
					return {
						content: [{ type: "text", text: "tool handled" } as ContentBlock],
						provider: "test",
						model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "stop",
					};
				}
				return {
					content: [{ type: "text", text: "follow-up handled" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: makeEchoRegistry(),
			llmClient: client,
			classifierConfig: { approve_unknown: false },
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
			compactionPolicy: {
				estimateContextTokens: () => 100,
				contextWindow: () => 1000,
				threshold: () => 1,
				isOverflow: () => false,
				async compact() {
					const lastUser = runtime.store.query({ types: ["USER_MESSAGE"], reverse: true, limit: 1 })[0];
					return {
						first_kept_event_id: lastUser.event_id,
						summary: "Integrated summary",
						tokens_before: 100,
						tokens_after: 20,
					};
				},
			},
		});

		let stopTurns = 0;
		runtime.subscribe((event) => {
			if (event.type !== "AGENT_TURN_COMPLETED") return;
			const payload = event.payload as { reason: string };
			if (payload.reason !== "stop") return;
			stopTurns++;
			if (stopTurns === 2) {
				runtime.compact({ token_count: 100 });
			}
		}, { types: ["AGENT_TURN_COMPLETED"] });

		runtime.followUp("second message");
		await runtime.prompt("first message");
		await waitForEvent(runtime, "COMPACTION_END");

		expect(calls).toBe(3);
		expect(runtime.store.query({ types: ["TOOL_EXECUTION_END"] })).toHaveLength(1);
		expect(runtime.store.query({ types: ["USER_MESSAGE"] })).toHaveLength(2);
		expect(runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] })).toHaveLength(2);
		const compaction = runtime.store.query({ types: ["COMPACTION_END"] })[0];
		expect(compaction.payload).toMatchObject({ summary: "Integrated summary" });

		const context = runtime.getProjection().buildContext();
		expect(context.messages[0].role).toBe("compactionSummary");
		expect(JSON.stringify(context.messages)).toContain("second message");
		expect(JSON.stringify(context.messages)).not.toContain("first message");

		runtime.dispose();
	});

	it("dispose during an idle compaction leaves no unhandled rejection", async () => {
		const cwd = makeTempDir();
		let releaseCompact: (() => void) | undefined;

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: emptyRegistry,
			llmClient: {
				async complete(): Promise<LLMResponse> {
					throw new Error("not used");
				},
			},
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
			compactionPolicy: {
				estimateContextTokens: () => 0,
				contextWindow: () => 1000,
				threshold: () => 1,
				isOverflow: () => false,
				async compact() {
					// Block until the test has disposed the runtime, then fail —
					// forcing the catch path below to append on a closed store.
					await new Promise<void>((resolve) => {
						releaseCompact = resolve;
					});
					throw new Error("compaction failed after dispose");
				},
			},
		});

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			runtime.compact({ token_count: 100 });
			expect(releaseCompact).toBeTypeOf("function");

			// Close the store while the compaction is in flight, then let the
			// failure surface. Before the fix, the COMPACTION_ABORTED append in
			// the catch path threw "database is not open" and the rejection
			// escaped _runIdleCompaction as an unhandled rejection.
			runtime.dispose();
			releaseCompact!();
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));

			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	// ────────────────────────────────────────────────────────────────────────
	// Compaction policy
	// ────────────────────────────────────────────────────────────────────────

	it("emits COMPACTION_REQUESTED when threshold exceeded after a turn", async () => {
		const cwd = makeTempDir();

		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				return {
					content: [{ type: "text", text: "ok" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 5000, output: 1000, cache_read: 0, cache_write: 0, total: 6000, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		let compactCalled = false;
		const compactionPolicy: CompactionPolicy = {
			estimateContextTokens: () => 9000, // above threshold
			contextWindow: () => 10000,
			threshold: () => 0.8,
			isOverflow: () => false,
			async compact(): Promise<CompactionOutcome> {
				compactCalled = true;
				return { first_kept_event_id: "evt_summary", summary: "compacted", tokens_before: 9000, tokens_after: 500 };
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: emptyRegistry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
			compactionPolicy,
		});

		await runtime.prompt("hi");
		// Compaction is async; wait a tick
		await new Promise((r) => setTimeout(r, 50));

		const requested = runtime.store.query({ types: ["COMPACTION_REQUESTED"] });
		expect(requested).toHaveLength(1);
		expect((requested[0].payload as { reason: string }).reason).toBe("threshold");

		const ended = runtime.store.query({ types: ["COMPACTION_END"] });
		expect(ended).toHaveLength(1);
		expect((ended[0].payload as { summary: string }).summary).toBe("compacted");
		expect(compactCalled).toBe(true);

		runtime.dispose();
	});

	it("uses the default CompactionEngine when no custom compaction policy is supplied", async () => {
		const cwd = makeTempDir();
		let calls = 0;

		const client: LLMClient = {
			async complete(req): Promise<LLMResponse> {
				calls++;
				if (calls === 1) {
					return {
						content: [{ type: "text", text: "current answer ".repeat(30) } as ContentBlock],
						provider: "test",
						model: "test",
						usage: { input: 80, output: 60, cache_read: 0, cache_write: 0, total: 140, cost: 0 },
						stopReason: "stop",
					};
				}
				const promptMessage = req.messages[0];
				const promptText =
					typeof promptMessage.content === "string"
						? promptMessage.content
						: promptMessage.content.map((block) => "text" in block ? block.text : "").join("\n");
				expect(promptText).toContain("old request");
				return {
					content: [{ type: "text", text: "Generated event-sourced summary" } as ContentBlock],
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total: 2, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: emptyRegistry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
			contextBudget: 100,
			compactionEngineSettings: {
				contextWindow: 100,
				reserveTokens: 10,
				keepRecentTokens: 5,
			},
		});

		runtime.store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "old request ".repeat(50) },
		});
		runtime.store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [{ type: "text", text: "old answer ".repeat(50) }],
				model: { provider: "test", model_id: "test" },
				usage: { input: 100, output: 50, cache_read: 0, cache_write: 0, total: 150, cost: 0 },
				stop_reason: "stop",
			},
		});

		await runtime.prompt("current request");
		await waitForEvent(runtime, "COMPACTION_END");

		const ended = runtime.store.query({ types: ["COMPACTION_END"] });
		expect(ended).toHaveLength(1);
		expect(ended[0].payload).toMatchObject({
			summary: "Generated event-sourced summary",
			tokens_before: expect.any(Number),
			first_kept_event_id: expect.any(String),
		});
		expect(calls).toBe(2);

		const context = runtime.getProjection().buildContext();
		expect(context.messages[0].role).toBe("compactionSummary");
		expect(context.messages.some((message) => JSON.stringify(message).includes("old request"))).toBe(false);

		runtime.dispose();
	});

	it("emits COMPACTION_REQUESTED with reason=overflow when policy.isOverflow returns true", async () => {
		const cwd = makeTempDir();

		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				return {
					content: [],
					provider: "test",
					model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "error",
					errorMessage: "context_length_exceeded",
				};
			},
		};

		const compactionPolicy: CompactionPolicy = {
			estimateContextTokens: () => 50000,
			contextWindow: () => 10000,
			threshold: () => 0.85,
			isOverflow: (evt: EventBase | undefined) => {
				const p = evt?.payload as { error_message?: string } | undefined;
				return !!p?.error_message?.includes("context_length_exceeded");
			},
			async compact(): Promise<CompactionOutcome> {
				return { first_kept_event_id: "x", summary: "ok", tokens_before: 50000, tokens_after: 100 };
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: emptyRegistry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
			compactionPolicy,
		});

		await runtime.prompt("hi");
		await new Promise((r) => setTimeout(r, 50));

		const requested = runtime.store.query({ types: ["COMPACTION_REQUESTED"] });
		expect(requested).toHaveLength(1);
		expect((requested[0].payload as { reason: string }).reason).toBe("overflow");

		runtime.dispose();
	});

	it("emits COMPACTION_ABORTED when user interrupt cancels active compaction", async () => {
		const cwd = makeTempDir();

		const client: LLMClient = {
			async complete(req): Promise<LLMResponse> {
				await new Promise<void>((resolve) => req.signal?.addEventListener("abort", () => resolve(), { once: true }));
				throw new Error("aborted");
			},
		};

		const compactionPolicy: CompactionPolicy = {
			estimateContextTokens: () => 0,
			contextWindow: () => Number.MAX_SAFE_INTEGER,
			threshold: () => 1,
			isOverflow: () => false,
			async compact(_reason, signal): Promise<CompactionOutcome> {
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				throw new Error("cancelled");
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: emptyRegistry,
			llmClient: client,
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
			compactionPolicy,
		});

		const prompt = runtime.prompt("hi");
		await waitForEvent(runtime, "LLM_CALL_REQUESTED");
		runtime.compact({ token_count: 4321 });
		await waitForEvent(runtime, "COMPACTION_START");
		runtime.abort();
		await prompt;
		await waitForEvent(runtime, "COMPACTION_ABORTED");

		const aborted = runtime.store.query({ types: ["COMPACTION_ABORTED"] });
		expect(aborted).toHaveLength(1);
		expect(aborted[0].payload).toMatchObject({
			reason: "user_cancelled",
			message: "cancelled",
			token_count: 4321,
		});

		runtime.dispose();
	});

	// ────────────────────────────────────────────────────────────────────────
	// Regression: "ghost" follow-ups resurrected across process restarts.
	// A USER_FOLLOWUP_QUEUED is durable, but the in-memory buffer it backs is
	// not. If the process exits with a queued follow-up never delivered (no turn
	// completed to drain it), the durable event must NOT be replayed days later
	// by a fresh process run — otherwise stale user messages appear out of nowhere.
	// ────────────────────────────────────────────────────────────────────────

	it("does not replay a stale follow-up from a previous process run (ghost-followup regression)", async () => {
		const cwd = makeTempDir();
		const seen: string[] = [];

		const baseClient: LLMClient = {
			async complete(req): Promise<LLMResponse> {
				const last = req.messages[req.messages.length - 1];
				if (last.role === "user") seen.push(typeof last.content === "string" ? last.content : "?");
				return {
					content: [{ type: "text", text: "ok" } as ContentBlock],
					provider: "test", model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};
		const config = {
			cwd, agentDir: cwd, toolRegistry: emptyRegistry, llmClient: baseClient,
			systemPrompt: "", model: { provider: "test", model_id: "test" }, tools: [],
		};

		// Process 1: queue a follow-up but never deliver it (turn never runs, then
		// the process exits). This leaves a USER_FOLLOWUP_QUEUED with no matching
		// USER_MESSAGE — the exact "ghost" precondition.
		const runtime1 = new EventSourcedRuntime(config);
		runtime1.followUp("ghost from yesterday");
		const queued = runtime1.store.query({ types: ["USER_FOLLOWUP_QUEUED"] });
		expect(queued).toHaveLength(1);
		runtime1.dispose();

		// Process 2 on the same store: the stale follow-up must NOT be replayed.
		const seenAfterRestart: string[] = [];
		const runtime2 = new EventSourcedRuntime({
			...config,
			llmClient: {
				async complete(req): Promise<LLMResponse> {
					const last = req.messages[req.messages.length - 1];
					if (last.role === "user") seenAfterRestart.push(typeof last.content === "string" ? last.content : "?");
					return {
						content: [{ type: "text", text: "ok" } as ContentBlock],
						provider: "test", model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "stop",
					};
				},
			},
		});
		await runtime2.prompt("fresh message");
		// Only the fresh prompt is seen; the stale follow-up is abandoned.
		expect(seenAfterRestart).toEqual(["fresh message"]);
		// And no extra USER_MESSAGE was synthesized from the ghost follow-up.
		expect(runtime2.store.query({ types: ["USER_MESSAGE"] })).toHaveLength(1); // only "fresh message"; the ghost was never delivered
		runtime2.dispose();
	});

	it("emits USER_FOLLOWUP_DROPPED when an interrupt discards a queued follow-up", async () => {
		const cwd = makeTempDir();
		let calls = 0;
		const client: LLMClient = {
			async complete(req): Promise<LLMResponse> {
				calls++;
				// First call hangs until aborted, simulating a turn in flight.
				if (calls === 1) {
					await new Promise<void>((resolve) => req.signal?.addEventListener("abort", () => resolve(), { once: true }));
					throw new Error("aborted");
				}
				return {
					content: [{ type: "text", text: "ok" } as ContentBlock],
					provider: "test", model: "test",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd, agentDir: cwd, toolRegistry: emptyRegistry, llmClient: client,
			systemPrompt: "", model: { provider: "test", model_id: "test" }, tools: [],
		});

		const prompt = runtime.prompt("first");
		await waitForEvent(runtime, "LLM_CALL_REQUESTED");
		// Queue a follow-up while the turn is in flight...
		runtime.followUp("queued then dropped");
		// ...then hard-interrupt (no new content) — this discards the follow-up.
		runtime.abort();
		await prompt;

		const dropped = runtime.store.query({ types: ["USER_FOLLOWUP_DROPPED"] });
		expect(dropped).toHaveLength(1);
		const followupEvent = runtime.store.query({ types: ["USER_FOLLOWUP_QUEUED"] })[0];
		expect((dropped[0].payload as { dropped_event_ids: string[] }).dropped_event_ids).toContain(followupEvent.event_id);
		// The follow-up was never delivered as a user message.
		expect(runtime.store.query({ types: ["USER_MESSAGE"] })[0].payload).toMatchObject({ content: "first" });
		expect(runtime.store.query({ types: ["USER_MESSAGE"] })).toHaveLength(1);

		runtime.dispose();

		// And on a fresh process run, the dropped follow-up must stay dropped.
		const seen2: string[] = [];
		const runtime2 = new EventSourcedRuntime({
			cwd, agentDir: cwd, toolRegistry: emptyRegistry,
			llmClient: {
				async complete(req): Promise<LLMResponse> {
					const last = req.messages[req.messages.length - 1];
					if (last.role === "user") seen2.push(typeof last.content === "string" ? last.content : "?");
					return {
						content: [{ type: "text", text: "ok" } as ContentBlock],
						provider: "test", model: "test",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "stop",
					};
				},
			},
			systemPrompt: "", model: { provider: "test", model_id: "test" }, tools: [],
		});
		await runtime2.prompt("next");
		expect(seen2).toEqual(["next"]);
		runtime2.dispose();
	});
});
