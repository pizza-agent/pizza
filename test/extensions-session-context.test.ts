import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth/auth-storage.js";
import { createExtensionRuntime } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import { EventStoreExtensionSessionManager } from "../src/core/extensions/session-context.js";
import type { Extension } from "../src/core/extensions/types.js";
import type { ContentBlock } from "../src/core/event-store/types.js";
import type { ToolExecutor, ToolRegistry } from "../src/core/intent/types.js";
import { ModelRegistry } from "../src/core/models/model-registry.js";
import type { LLMResponse } from "../src/core/runtime/llm-types.js";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import { SessionFacade } from "../src/core/session/session-facade.js";
import { SettingsManager } from "../src/core/config/settings-manager.js";

describe("EventStoreExtensionSessionManager", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pizza-extension-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

	it("backs extension ctx.sessionManager with EventStore and SessionProjection", async () => {
		const cwd = makeTempDir();
		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: emptyRegistry,
			llmClient: {
				async complete(): Promise<LLMResponse> {
					return {
						content: [{ type: "text", text: "hello" } as ContentBlock],
						provider: "test",
						model: "test-model",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "stop",
					};
				},
			},
			systemPrompt: "",
			model: { provider: "test", model_id: "test-model" },
			tools: [],
		});

		runtime.setModel("next-provider", "next-model");
		runtime.setThinkingLevel("high");
		await runtime.prompt("hello");

		const projection = runtime.getProjection();
		const sessionManager = new EventStoreExtensionSessionManager({
			store: runtime.store,
			projection,
			cwd,
		});
		const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
		const runner = new ExtensionRunner([], createExtensionRuntime(), cwd, sessionManager, modelRegistry);
		const ctx = runner.createContext();

		expect(ctx.sessionManager).toBe(sessionManager);
		expect(ctx.sessionManager.eventStore).toBe(runtime.store);
		expect(ctx.sessionManager.projection).toBe(projection);
		expect(ctx.sessionManager.getHeader().id).toBe(ctx.sessionManager.getSessionId());
		expect(ctx.sessionManager.getBranch().map((entry) => entry.type)).toEqual(
			expect.arrayContaining(["model_change", "thinking_level_change", "message"]),
		);
		expect(ctx.sessionManager.getLeafEntry()?.id).toBe(ctx.sessionManager.getLeafId());
		expect(ctx.sessionManager.buildContext?.().messages.map((message) => message.role)).toEqual(["user", "assistant"]);

		runtime.dispose();
	});

	it("maps EventStore events into existing extension event handlers", async () => {
		const cwd = makeTempDir();
		let calls = 0;
		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: makeEchoRegistry(),
			llmClient: {
				async complete(): Promise<LLMResponse> {
					calls++;
					if (calls === 1) {
						return {
							content: [
								{ type: "tool_call", id: "call_echo", name: "echo", arguments: { text: "hello" } } as ContentBlock,
							],
							provider: "test",
							model: "test-model",
							usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
							stopReason: "tool_use",
						};
					}
					return {
						content: [{ type: "text", text: "done" } as ContentBlock],
						provider: "test",
						model: "test-model",
						usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
						stopReason: "stop",
					};
				},
			},
			systemPrompt: "",
			model: { provider: "test", model_id: "test-model" },
			tools: [{ name: "echo", input_schema: { type: "object" } }],
		});
		const sessionManager = new EventStoreExtensionSessionManager({
			store: runtime.store,
			projection: runtime.getProjection(),
			cwd,
		});
		const observed: string[] = [];
		const extension: Extension = {
			path: "event-store-test",
			resolvedPath: "event-store-test",
			sourceInfo: { path: "event-store-test", source: "test", scope: "temporary", origin: "top-level" },
			handlers: new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
				["turn_start", [async (event: any) => observed.push(`turn_start:${event.turnIndex}`)]],
				["message_end", [async (event: any) => observed.push(`message_end:${event.message.role}`)]],
				["tool_call", [async (event: any) => observed.push(`tool_call:${event.toolName}:${event.input.text}`)]],
				["tool_result", [async (event: any) => observed.push(`tool_result:${event.toolName}`)]],
				["context", [async (event: any) => observed.push(`context:${event.messages.length}`)]],
				["turn_end", [async (event: any) => observed.push(`turn_end:${event.turnIndex}`)]],
				["agent_end", [async () => observed.push("agent_end")]],
			]),
			tools: new Map(),
			builtinCommands: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};
		const runner = new ExtensionRunner(
			[extension],
			createExtensionRuntime(),
			cwd,
			sessionManager,
			ModelRegistry.inMemory(AuthStorage.inMemory()),
		);
		const facade = new SessionFacade({
			runtime,
			settingsManager: SettingsManager.inMemory(),
			extensionRunner: runner,
			modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
		});
		const unsubscribe = facade.extensionRunner!.bindEventStore(facade.runtime.store);

		await facade.prompt("run echo");
		await new Promise((resolve) => setTimeout(resolve, 0));
		unsubscribe();

		expect(observed).toEqual(expect.arrayContaining([
			"turn_start:1",
			"message_end:user",
			"tool_call:echo:hello",
			"tool_result:echo",
			"message_end:assistant",
			"turn_end:2",
			"agent_end",
		]));
		expect(observed.some((item) => item.startsWith("context:"))).toBe(true);

		facade.dispose();
	});

	describe("tool_call gate", () => {
		function setup(handler: (event: any) => Promise<unknown>) {
			const cwd = makeTempDir();
			const executed: unknown[] = [];
			let calls = 0;
			const registry: ToolRegistry = {
				get(name: string): ToolExecutor | undefined {
					if (name !== "echo") return undefined;
					return {
						async execute(args) {
							executed.push(args);
							return { content: [{ type: "text", text: String(args.text ?? "") }], is_error: false };
						},
						getMetadata() {
							return { name: "echo", category: "file_read", defaultRisk: "safe" };
						},
					};
				},
				list: () => ["echo"],
			};
			const extension: Extension = {
				path: "gate-test",
				resolvedPath: "gate-test",
				sourceInfo: { path: "gate-test", source: "test", scope: "temporary", origin: "top-level" },
				handlers: new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
					["tool_call", [handler as (...args: unknown[]) => Promise<unknown>]],
				]),
				tools: new Map(),
				builtinCommands: new Map(),
				commands: new Map(),
				flags: new Map(),
				shortcuts: new Map(),
			};
			let gate!: ReturnType<ExtensionRunner["createToolCallGate"]>;
			const runtime = new EventSourcedRuntime({
				cwd,
				agentDir: cwd,
				toolRegistry: registry,
				// No approval gate: the hook alone must decide.
				classifierConfig: { safe_mode: false },
				beforeToolCall: (call) => gate(call),
				llmClient: {
					async complete(): Promise<LLMResponse> {
						calls++;
						const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 };
						return calls === 1
							? {
									content: [
										{ type: "tool_call", id: "call_echo", name: "echo", arguments: { text: "hello" } } as ContentBlock,
									],
									provider: "test",
									model: "test-model",
									usage,
									stopReason: "tool_use",
								}
							: { content: [{ type: "text", text: "done" } as ContentBlock], provider: "test", model: "test-model", usage, stopReason: "stop" };
					},
				},
				systemPrompt: "",
				model: { provider: "test", model_id: "test-model" },
				tools: [{ name: "echo", input_schema: { type: "object" } }],
			});
			const runner = new ExtensionRunner(
				[extension],
				createExtensionRuntime(),
				cwd,
				new EventStoreExtensionSessionManager({ store: runtime.store, projection: runtime.getProjection(), cwd }),
				ModelRegistry.inMemory(AuthStorage.inMemory()),
			);
			gate = runner.createToolCallGate();
			const unbind = runner.bindEventStore(runtime.store);
			const toolEnd = () =>
				runtime.store.query({ types: ["TOOL_EXECUTION_END"] }).map((event) => event.payload as any);
			return { runtime, executed, toolEnd, unbind };
		}

		it("blocks execution when a handler returns { block: true }, calling it once", async () => {
			let handled = 0;
			const { runtime, executed, toolEnd, unbind } = setup(async () => {
				handled++;
				return { block: true, reason: "policy says no" };
			});
			await runtime.prompt("run echo");
			await new Promise((resolve) => setTimeout(resolve, 0));
			unbind();
			expect(executed).toEqual([]);
			expect(handled).toBe(1);
			expect(toolEnd()).toEqual([
				expect.objectContaining({ tool_call_id: "call_echo", is_error: true }),
			]);
			expect(JSON.stringify(toolEnd()[0].result)).toContain("policy says no");
			runtime.dispose();
		});

		it("executes the handler's in-place input mutation without rewriting the logged intent", async () => {
			const { runtime, executed, unbind } = setup(async (event) => {
				event.input.text = "rewritten";
			});
			await runtime.prompt("run echo");
			unbind();
			expect(executed).toEqual([{ text: "rewritten" }]);
			const intent = runtime.store.query({ types: ["INTENT_TOOL_CALL"] })[0]!.payload as any;
			expect(intent.arguments).toEqual({ text: "hello" });
			const start = runtime.store.query({ types: ["TOOL_EXECUTION_START"] })[0]!.payload as any;
			expect(start.arguments).toEqual({ text: "rewritten" });
			runtime.dispose();
		});

		it("fails closed when a handler throws", async () => {
			const { runtime, executed, toolEnd, unbind } = setup(async () => {
				throw new Error("policy crashed");
			});
			await runtime.prompt("run echo");
			unbind();
			expect(executed).toEqual([]);
			expect(toolEnd()[0]).toMatchObject({ is_error: true });
			expect(JSON.stringify(toolEnd()[0].result)).toContain("policy crashed");
			runtime.dispose();
		});

		it("lets the call through when handlers return nothing", async () => {
			const { runtime, executed, toolEnd, unbind } = setup(async () => undefined);
			await runtime.prompt("run echo");
			unbind();
			expect(executed).toEqual([{ text: "hello" }]);
			expect(toolEnd()[0]).toMatchObject({ is_error: false });
			runtime.dispose();
		});
	});
});
