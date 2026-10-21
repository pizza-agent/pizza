import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth/auth-storage.js";
import { createExtensionRuntime, type Extension, type ToolDefinition } from "../src/core/extensions/index.js";
import { ModelRegistry } from "../src/core/models/model-registry.js";
import type { ResourceLoader } from "../src/core/config/resource-loader.js";
import { SessionFacade } from "../src/core/session/session-facade.js";
import { createSessionFacade } from "../src/core/session/session-facade-factory.js";
import { createSyntheticSourceInfo } from "../src/core/skills/source-info.js";
import { SettingsManager } from "../src/core/config/settings-manager.js";

describe("createSessionFacade", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pizza-facade-factory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	/**
	 * Minimal ResourceLoader stub to avoid filesystem scanning. Pass `runtime`
	 * to hold onto the ExtensionRuntime the runner binds its actions onto, so a
	 * test can drive the extension-facing setModel/setThinkingLevel APIs.
	 */
	function makeResourceLoader(extensions: Extension[] = [], runtime = createExtensionRuntime()): ResourceLoader {
		return {
			getExtensions: () => ({ extensions, errors: [], runtime }),
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => undefined,
			getAppendSystemPrompt: () => [],
			extendResources: () => {},
			reload: async () => {},
		} as ResourceLoader;
	}

	function makeExtension(path = "<test-extension>"): Extension {
		const sourceInfo = createSyntheticSourceInfo(path, { source: "test" });
		return {
			path,
			resolvedPath: path,
			sourceInfo,
			handlers: new Map(),
			tools: new Map(),
			builtinCommands: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};
	}

	const fakeModel = {
		provider: "test",
		id: "test-model",
		name: "Test Model",
		reasoning: false,
		contextWindow: 64000,
		baseUrl: "https://example.com",
	} as unknown as Model<any>;

	function makeOptions() {
		const cwd = makeTempDir();
		return {
			cwd,
			storagePath: ":memory:",
			authStorage: AuthStorage.inMemory(),
			modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
			settingsManager: SettingsManager.inMemory({ defaultProvider: "test", defaultModel: "test-model" }),
			resourceLoader: makeResourceLoader(),
			model: fakeModel,
		};
	}

	it("wires an event-sourced SessionFacade with tools and system prompt", async () => {
		const { facade, runtime, model, thinkingLevel } = await createSessionFacade({ ...makeOptions() });

		expect(facade).toBeInstanceOf(SessionFacade);
		expect(model?.id).toBe("test-model");
		// Non-reasoning model is clamped to "off".
		expect(thinkingLevel).toBe("off");

		// Built-in cli tool is exposed to the LLM.
		expect(facade.tools.map((t) => t.name)).toContain("cli");
		expect(runtime.getTools().map((t) => t.name)).toContain("cli");

		// System prompt is assembled and non-empty.
		expect(facade.systemPrompt.length).toBeGreaterThan(0);

		// Projection is reachable and empty for a fresh store.
		expect(facade.getProjection().buildContext().messages).toEqual([]);

		facade.dispose();
	});

	it("emits a RUNTIME_STARTED event into the store on construction", async () => {
		const { runtime, facade } = await createSessionFacade({ ...makeOptions() });
		const started = runtime.store.query({ types: ["RUNTIME_STARTED"], limit: 1 })[0];
		expect(started).toBeDefined();
		expect(started?.type).toBe("RUNTIME_STARTED");
		facade.dispose();
	});

	it("reflects model and thinking-level changes through the facade", async () => {
		const { facade, runtime } = await createSessionFacade({ ...makeOptions() });

		facade.runtime.setModel("other", "other-model");
		expect(runtime.getModel().provider).toBe("other");
		expect(runtime.getModel().model_id).toBe("other-model");

		const modelChanged = runtime.store.query({ types: ["MODEL_CHANGED"], reverse: true, limit: 1 })[0];
		expect(modelChanged).toBeDefined();

		facade.dispose();
	});

	it("registers custom ToolDefinitions for LLM visibility and execution", async () => {
		let sawEventBackedContext = false;
		const customTool: ToolDefinition = {
			name: "custom_echo",
			label: "Custom Echo",
			description: "Echoes input text",
			promptSnippet: "Echo text for tests",
			parameters: {
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
			} as any,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				sawEventBackedContext = !!ctx.sessionManager.eventStore && !!ctx.sessionManager.projection;
				return {
					content: [{ type: "text", text: `echo:${(params as { text: string }).text}` }],
				};
			},
		};

		const { facade, runtime } = await createSessionFacade({
			...makeOptions(),
			customTools: [customTool],
		});

		expect(facade.tools.map((tool) => tool.name)).toContain("custom_echo");
		expect(facade.systemPrompt).toContain("custom_echo");

		const result = await runtime.runtimeAdapter.executeTool({
			tool_call_id: "test_direct",
			tool_name: "custom_echo",
			arguments: { text: "hello" },
		});
		expect(result.is_error).toBe(false);
		expect(result.content[0]).toMatchObject({ type: "text", text: "echo:hello" });
		expect(sawEventBackedContext).toBe(true);

		facade.dispose();
	});

	it("wires ExtensionRunner to EventStore events", async () => {
		const extension = makeExtension();
		let observedText = "";
		let sawEventBackedContext = false;
		const observed = new Promise<void>((resolve) => {
			extension.handlers.set("message_end", [
				async (event: any, ctx: any) => {
					if (event.message.role !== "user") return;
					observedText =
						typeof event.message.content === "string"
							? event.message.content
							: event.message.content.map((block: any) => block.text ?? "").join("");
					sawEventBackedContext = !!ctx.sessionManager.eventStore && !!ctx.sessionManager.projection;
					resolve();
				},
			]);
		});

		const { facade, runtime } = await createSessionFacade({
			...makeOptions(),
			resourceLoader: makeResourceLoader([extension]),
		});

		runtime.store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "hello extension" },
		});

		await observed;
		expect(observedText).toBe("hello extension");
		expect(sawEventBackedContext).toBe(true);

		facade.dispose();
	});

	it("enforces extension tool_call handlers as a pre-execution gate", async () => {
		const extension = makeExtension();
		const seen: string[] = [];
		extension.handlers.set("tool_call", [
			async (event: any) => {
				seen.push(event.toolName);
				return event.toolName === "dangerous" ? { block: true, reason: "denied" } : undefined;
			},
		]);
		const { facade, runtime } = await createSessionFacade({
			...makeOptions(),
			resourceLoader: makeResourceLoader([extension]),
		});
		const gate = (runtime as any).config.beforeToolCall;
		expect(typeof gate).toBe("function");
		await expect(gate({ tool_call_id: "a", tool_name: "dangerous", arguments: {} })).resolves.toMatchObject({
			block: true,
			reason: "denied",
		});
		await expect(gate({ tool_call_id: "b", tool_name: "safe", arguments: {} })).resolves.toBeUndefined();
		expect(seen).toEqual(["dangerous", "safe"]);
		facade.dispose();
	});

	// The extension-facing setModel/setThinkingLevel actions bypass SessionFacade
	// (they talk to the runtime directly), so they need their own persistence and
	// their own coverage — the SessionFacade tests don't exercise this path.
	it("persists model and thinking level chosen through the extension API", async () => {
		const authStorage = AuthStorage.inMemory();
		// Makes modelRegistry.hasConfiguredAuth() pass so setModel isn't rejected.
		authStorage.setRuntimeApiKey("test", "sk-test");
		const extensionRuntime = createExtensionRuntime();
		const settingsManager = SettingsManager.inMemory({ defaultProvider: "test", defaultModel: "test-model" });

		const { facade } = await createSessionFacade({
			cwd: makeTempDir(),
			storagePath: ":memory:",
			authStorage,
			modelRegistry: ModelRegistry.inMemory(authStorage),
			settingsManager,
			resourceLoader: makeResourceLoader([], extensionRuntime),
			model: fakeModel,
		});

		const nextModel = { ...fakeModel, provider: "test", id: "other-model" } as unknown as Model<any>;
		expect(await extensionRuntime.setModel(nextModel)).toBe(true);
		extensionRuntime.setThinkingLevel("high");
		await settingsManager.flush();

		expect(settingsManager.getDefaultProvider()).toBe("test");
		expect(settingsManager.getDefaultModel()).toBe("other-model");
		expect(settingsManager.getDefaultThinkingLevel()).toBe("high");

		facade.dispose();
	});

	it("skips thinking levels that settings.json cannot represent", async () => {
		const extensionRuntime = createExtensionRuntime();
		const settingsManager = SettingsManager.inMemory({ defaultProvider: "test", defaultModel: "test-model" });

		const { facade } = await createSessionFacade({
			...makeOptions(),
			settingsManager,
			resourceLoader: makeResourceLoader([], extensionRuntime),
		});

		extensionRuntime.setThinkingLevel("high");
		await settingsManager.flush();
		expect(settingsManager.getDefaultThinkingLevel()).toBe("high");

		// "max" is a valid runtime/pi-ai level but not a persistable one; the
		// previously stored value must survive rather than be clobbered.
		extensionRuntime.setThinkingLevel("max" as never);
		await settingsManager.flush();
		expect(settingsManager.getDefaultThinkingLevel()).toBe("high");

		facade.dispose();
	});
});
