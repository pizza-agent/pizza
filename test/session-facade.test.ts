import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth/auth-storage.js";
import type { ContentBlock, EventBase, EventType } from "../src/core/event-store/types.js";
import type { ToolRegistry } from "../src/core/intent/types.js";
import { ModelRegistry } from "../src/core/models/model-registry.js";
import { SessionFacade } from "../src/core/session/session-facade.js";
import { SettingsManager } from "../src/core/config/settings-manager.js";
import type { LLMClient, LLMResponse } from "../src/core/runtime/llm-types.js";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";

describe("SessionFacade", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pizza-session-facade-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	const emptyRegistry: ToolRegistry = {
		get: () => undefined,
		list: () => [],
	};

	function makeTextResponse(text: string): LLMResponse {
		return {
			content: [{ type: "text", text } as ContentBlock],
			provider: "test",
			model: "test-model",
			usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
			stopReason: "stop",
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

	function makeFacade(client?: LLMClient) {
		const cwd = makeTempDir();
		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: emptyRegistry,
			llmClient: client ?? {
				async complete(): Promise<LLMResponse> {
					return makeTextResponse("ok");
				},
			},
			systemPrompt: "initial prompt",
			model: { provider: "test", model_id: "test-model", thinking_level: "low" },
			tools: [],
		});
		const settingsManager = SettingsManager.inMemory({ defaultProvider: "test", defaultModel: "test-model" });
		const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
		const facade = new SessionFacade({ runtime, settingsManager, modelRegistry });
		return { facade, runtime, settingsManager, modelRegistry };
	}

	it("forwards prompt and follow-up through the event-sourced runtime", async () => {
		const seenPrompts: string[] = [];
		const { facade } = makeFacade({
			async complete(req): Promise<LLMResponse> {
				const last = req.messages.at(-1);
				if (last?.role === "user") {
					seenPrompts.push(typeof last.content === "string" ? last.content : "");
				}
				return makeTextResponse(`response ${seenPrompts.length}`);
			},
		});
		const events: EventBase[] = [];
		facade.subscribe((event) => events.push(event));

		facade.followUp("second");
		await facade.prompt("first");

		expect(seenPrompts).toEqual(["first", "second"]);
		expect(events.some((event) => event.type === "AGENT_TURN_COMPLETED")).toBe(true);
		expect(facade.getProjection().buildContext().messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);

		facade.dispose();
	});

	it("exposes model, thinking, tools, and system prompt via runtime events", () => {
		const { facade, runtime } = makeFacade();

		facade.model = { provider: "next-provider", model_id: "next-model", thinking_level: "high" };
		facade.thinkingLevel = "medium";
		facade.tools = [{ name: "read", description: "Read files", input_schema: { type: "object" } }];
		facade.systemPrompt = "updated prompt";

		expect(facade.model).toEqual({ provider: "next-provider", model_id: "next-model", thinking_level: "medium" });
		expect(facade.tools).toEqual([{ name: "read", description: "Read files", input_schema: { type: "object" } }]);
		expect(facade.systemPrompt).toBe("updated prompt");
		expect(runtime.store.query({ types: ["MODEL_CHANGED"] })).toHaveLength(1);
		expect(runtime.store.query({ types: ["THINKING_LEVEL_CHANGED"] })).toHaveLength(2);
		expect(runtime.store.query({ types: ["USER_CONFIG_CHANGE"] })).toHaveLength(2);

		facade.dispose();
	});

	it("holds settings and model registry without owning transcript state", () => {
		const { facade, settingsManager, modelRegistry } = makeFacade();

		expect(facade.settingsManager).toBe(settingsManager);
		expect(facade.modelRegistry).toBe(modelRegistry);
		expect(facade.runtime).toBeDefined();
		expect("messages" in facade).toBe(false);
		expect("state" in facade).toBe(false);

		facade.compact({ token_count: 100 });
		expect(facade.runtime.store.query({ types: ["COMPACTION_REQUESTED"] })).toHaveLength(1);

		facade.dispose();
	});

	it("exposes the active runtime signal and abort path", async () => {
		let requestSignal: AbortSignal | undefined;
		const { facade, runtime } = makeFacade({
			async complete(req): Promise<LLMResponse> {
				requestSignal = req.signal;
				await new Promise<void>((resolve) => req.signal?.addEventListener("abort", () => resolve(), { once: true }));
				throw new Error("aborted");
			},
		});

		const prompt = facade.prompt("stop");
		await waitForEvent(runtime, "LLM_CALL_REQUESTED");

		expect(facade.signal).toBe(requestSignal);
		facade.abort();
		await prompt;
		expect(facade.signal).toBeUndefined();

		facade.dispose();
	});

	describe("preference persistence (settings.json)", () => {
		it("persists the new model when setModel is called", async () => {
			const { facade, settingsManager } = makeFacade();
			facade.setModel({ provider: "anthropic", id: "claude-sonnet-4-5" } as never);
			await settingsManager.flush();
			expect(settingsManager.getDefaultProvider()).toBe("anthropic");
			expect(settingsManager.getDefaultModel()).toBe("claude-sonnet-4-5");
			facade.dispose();
		});

		it("persists the new model via the `set model` shorthand", async () => {
			const { facade, settingsManager } = makeFacade();
			facade.model = { provider: "anthropic", model_id: "claude-sonnet-4-5", thinking_level: "off" };
			await settingsManager.flush();
			expect(settingsManager.getDefaultProvider()).toBe("anthropic");
			expect(settingsManager.getDefaultModel()).toBe("claude-sonnet-4-5");
			facade.dispose();
		});

		it("persists thinking-level changes from the setter", async () => {
			const { facade, settingsManager } = makeFacade();
			facade.thinkingLevel = "xhigh";
			await settingsManager.flush();
			expect(settingsManager.getDefaultThinkingLevel()).toBe("xhigh");
			facade.dispose();
		});

		it("persists the optional thinkingLevel passed to setModel", async () => {
			const { facade, settingsManager } = makeFacade();
			facade.setModel({ provider: "openai", id: "gpt-5", thinking_level: "high" } as never);
			await settingsManager.flush();
			expect(settingsManager.getDefaultModel()).toBe("gpt-5");
			expect(settingsManager.getDefaultThinkingLevel()).toBe("high");
			facade.dispose();
		});

		it("survives a settings-write failure without breaking the runtime", async () => {
			const { facade, runtime, settingsManager } = makeFacade();
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			vi.spyOn(settingsManager, "setDefaultModelAndProvider").mockImplementation(() => {
				throw new Error("disk full");
			});
			expect(() => facade.setModel({ provider: "anthropic", id: "claude-sonnet-4-5" } as never)).not.toThrow();
			// Runtime state still updated despite the persistence failure.
			expect(runtime.getModel().provider).toBe("anthropic");
			expect(runtime.getModel().model_id).toBe("claude-sonnet-4-5");
			expect(warn).toHaveBeenCalled();
			warn.mockRestore();
			facade.dispose();
		});
	});
});
