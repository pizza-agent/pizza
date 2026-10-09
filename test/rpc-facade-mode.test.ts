import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import type { ContentBlock, EventBase } from "../src/core/event-store/types.js";
import type { ToolRegistry } from "../src/core/intent/types.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry as RealModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/projection/session-manager.js";
import type { LLMClient, LLMResponse } from "../src/core/runtime/llm-types.js";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import { SessionFacade } from "../src/core/session-facade.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { runRpcModeWithFacade } from "../packages/rpc/rpc-mode.js";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	takeOverStdout: vi.fn(),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../packages/tui/theme/theme.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	theme: {},
}));

vi.mock("../packages/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

const execMock = vi.hoisted(() => ({
	// Whether the agent-browser CLI is "on PATH". Install sets it true, uninstall false.
	installed: false,
	reset(installed = false) {
		this.installed = installed;
	},
}));

vi.mock("../src/core/exec.js", () => ({
	execCommand: vi.fn(async (command: string, args: string[]) => {
		const key = `${command}:${args[0]}`;
		// version probe reflects install state
		if (key === "agent-browser:--version") {
			return execMock.installed
				? { stdout: "0.0.0-mock", stderr: "", code: 0 }
				: { stdout: "", stderr: "not found", code: 127 };
		}
		// installing the CLI succeeds and flips install state on
		if (key === "npm:install" || key === "agent-browser:install") {
			execMock.installed = true;
			return { stdout: "", stderr: "", code: 0 };
		}
		// uninstalling flips install state off
		if (key === "npm:uninstall") {
			execMock.installed = false;
			return { stdout: "", stderr: "", code: 0 };
		}
		return { stdout: "", stderr: `mock: ${key} not handled`, code: 127 };
	}),
}));

const tempDirs: string[] = [];

const emptyRegistry: ToolRegistry = {
	get: () => undefined,
	list: () => [],
};

function makeTempDir(): string {
	const dir = join(tmpdir(), `pizza-rpc-facade-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

function makeTextResponse(text: string): LLMResponse {
	return {
		content: [{ type: "text", text } as ContentBlock],
		provider: "test",
		model: "test-model",
		usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
		stopReason: "stop",
	};
}

function createFacade(client?: LLMClient, modelRegistry?: ModelRegistry): SessionFacade {
	const cwd = makeTempDir();
	const store = new SqliteEventStore(`rpc-facade-${Date.now()}`, join(cwd, "events.sqlite"));
	const sessionManager = new SessionManager(store, store);
	sessionManager.createSession("user_explicit", "Initial");
	const runtime = new EventSourcedRuntime({
		cwd,
		agentDir: cwd,
		store,
		sessionManager,
		toolRegistry: emptyRegistry,
		llmClient: client ?? {
			async complete(): Promise<LLMResponse> {
				return makeTextResponse("rpc facade done");
			},
		},
		systemPrompt: "rpc facade test",
		model: { provider: "test", model_id: "test-model" },
		tools: [],
	});
	return new SessionFacade({
		runtime,
		settingsManager: SettingsManager.inMemory({ defaultProvider: "test", defaultModel: "test-model" }),
		modelRegistry,
		disposers: [() => store.close()],
	});
}

function parseOutputLines(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("runRpcModeWithFacade", () => {
	let originalPizzaHome: string | undefined;

	beforeEach(() => {
		// Isolate ALL ~/.pizza writes (scheduler tasks.json, runs.jsonl, ...).
		// Without this, scheduled-task tests pollute the real user home with
		// rpc-facade-* workspace dirs containing live-looking tasks.
		originalPizzaHome = process.env.PIZZA_HOME;
		process.env.PIZZA_HOME = makeTempDir();
	});

	afterEach(() => {
		if (originalPizzaHome === undefined) delete process.env.PIZZA_HOME;
		else process.env.PIZZA_HOME = originalPizzaHome;
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		vi.restoreAllMocks();
	});

	it("emits command responses and typed events over JSONL", async () => {
		const facade = createFacade();
		void runRpcModeWithFacade(facade);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		rpcIo.lineHandler!(JSON.stringify({ id: "state-1", type: "get_state" }));
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "state-1",
					type: "response",
					command: "get_state",
					success: true,
				}),
			);
		});

		rpcIo.outputLines = [];
		rpcIo.lineHandler!(JSON.stringify({ id: "prompt-1", type: "prompt", message: "hello" }));

		await vi.waitFor(() => {
			const records = parseOutputLines();
			expect(records).toContainEqual(
				expect.objectContaining({
					id: "prompt-1",
					type: "response",
					command: "prompt",
					success: true,
				}),
			);
			const eventTypes = records
				.filter((record) => typeof record.event_id === "string")
				.map((record) => (record as unknown as EventBase).type);
			expect(eventTypes).toContain("USER_MESSAGE");
			expect(eventTypes).toContain("AGENT_MESSAGE_END");
			expect(eventTypes).toContain("AGENT_TURN_COMPLETED");
		});

		facade.dispose();
	});

	it("handles projection-backed session and settings commands", async () => {
		const facade = createFacade();
		void runRpcModeWithFacade(facade);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		const user = facade.runtime.store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "fork me" },
		});
		facade.runtime.store.append({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: [
					{ type: "text", text: "done" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
				],
				model: { provider: "test", model_id: "test-model" },
				usage: { input: 10, output: 20, cache_read: 3, cache_write: 4, total: 37, cost: 0.5 },
				stop_reason: "stop",
			},
		});
		facade.runtime.store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: {
				tool_call_id: "call-1",
				tool_name: "read",
				result: [{ type: "text", text: "file" }],
				is_error: false,
				duration_ms: 1,
			},
		});

		rpcIo.lineHandler!(JSON.stringify({ id: "stats-1", type: "get_session_stats" }));
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "stats-1",
					type: "response",
					command: "get_session_stats",
					success: true,
					data: expect.objectContaining({
						userMessages: 1,
						assistantMessages: 1,
						toolCalls: 1,
						toolResults: 1,
						totalMessages: 3,
						tokens: expect.objectContaining({ input: 10, output: 20, cacheRead: 3, cacheWrite: 4, total: 37 }),
						cost: 0.5,
					}),
				}),
			);
		});

		rpcIo.outputLines = [];
		rpcIo.lineHandler!(JSON.stringify({ id: "fork-messages-1", type: "get_fork_messages" }));
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "fork-messages-1",
					type: "response",
					command: "get_fork_messages",
					success: true,
					data: { messages: [{ entryId: user.event_id, text: "fork me" }] },
				}),
			);
		});

		rpcIo.outputLines = [];
		rpcIo.lineHandler!(JSON.stringify({ id: "autocompact-1", type: "set_auto_compaction", enabled: false }));
		rpcIo.lineHandler!(JSON.stringify({ id: "state-2", type: "get_state" }));
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "state-2",
					type: "response",
					command: "get_state",
					success: true,
					data: expect.objectContaining({ autoCompactionEnabled: false }),
				}),
			);
		});

		rpcIo.outputLines = [];
		rpcIo.lineHandler!(JSON.stringify({ id: "fork-1", type: "fork", entryId: user.event_id }));
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "fork-1",
					type: "response",
					command: "fork",
					success: true,
					data: { text: "fork me", cancelled: false },
				}),
			);
		});

		facade.dispose();
	});

	it("new_session waits for the in-flight turn so the boundary does not steal the answer", async () => {
		// Deferred LLM call: the turn stays in flight until we resolve it.
		let resolveLlm: ((response: LLMResponse) => void) | undefined;
		const client: LLMClient = {
			async complete(): Promise<LLMResponse> {
				return new Promise<LLMResponse>((resolve) => {
					resolveLlm = resolve;
				});
			},
		};
		const facade = createFacade(client);
		void runRpcModeWithFacade(facade);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		const manager = facade.runtime.sessionManager!;
		const sessionA = manager.getActiveSessionId()!;

		// Start a turn; it streams until resolveLlm() is called.
		rpcIo.outputLines = [];
		rpcIo.lineHandler!(JSON.stringify({ id: "p1", type: "prompt", message: "computer use protocol?" }));
		await vi.waitFor(() => expect(resolveLlm).toBeDefined());
		expect(facade.isRunning).toBe(true);

		// Click "new session" mid-turn. Regression: the boundary used to land at
		// the streaming answer start event, stealing the answer from the session
		// where the user asked.
		rpcIo.lineHandler!(JSON.stringify({ id: "new-1", type: "new_session" }));

		await new Promise((resolve) => setTimeout(resolve, 50));
		// The command is still waiting for the turn to settle…
		expect(parseOutputLines().filter((record) => record.id === "new-1")).toHaveLength(0);
		// …and no session boundary was created mid-turn.
		expect(manager.getActiveSessionId()).toBe(sessionA);

		// The answer completes AFTER the click and must stay in session A.
		resolveLlm!(makeTextResponse("the answer belongs to the session where it was asked"));

		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "new-1",
					type: "response",
					command: "new_session",
					success: true,
				}),
			);
		});

		const sessionB = manager.getActiveSessionId()!;
		expect(sessionB).not.toBe(sessionA);

		const contextA = manager.getSessionProjection(sessionA)!.buildContext();
		expect(contextA.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(JSON.stringify(contextA.messages)).toContain("the answer belongs to the session where it was asked");

		// The new session starts fresh: it must not contain the stolen turn.
		const contextB = manager.getSessionProjection(sessionB)!.buildContext();
		expect(contextB.messages).toHaveLength(0);

		facade.dispose();
	});

	it("keeps pinned scheduled tasks on the resolved continuation instead of the visible session", async () => {
		const facade = createFacade();
		void runRpcModeWithFacade(facade);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		const manager = facade.runtime.sessionManager!;
		const sessionA = manager.getActiveSessionId()!;
		const workspaceId = facade.getProjection().getDescriptor().workspace_id;

		rpcIo.outputLines = [];
		rpcIo.lineHandler!(JSON.stringify({ id: "new-b", type: "new_session" }));
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "new-b",
					type: "response",
					command: "new_session",
					success: true,
				}),
			);
		});
		const sessionB = manager.getActiveSessionId()!;
		expect(sessionB).not.toBe(sessionA);

		rpcIo.outputLines = [];
		rpcIo.lineHandler!(JSON.stringify({
			id: "create-fixed",
			type: "schedule_create",
			task: {
				name: "fixed A",
				prompt: "scheduled ping",
				scope: "workspace",
				workspaceId,
				schedule: { mode: "every_n_minutes", everyN: { n: 60, unit: "minute" } },
				enabled: false,
				sessionTarget: { kind: "pinned", sessionId: sessionA },
				concurrencyPolicy: "skip",
				timeoutMinutes: 0,
			},
		}));
		let taskId = "";
		await vi.waitFor(() => {
			const createResponse = parseOutputLines().find((record) => record.id === "create-fixed" && record.command === "schedule_create");
			expect(createResponse).toEqual(expect.objectContaining({ success: true }));
			const data = createResponse?.data as { task?: { id?: string } } | undefined;
			taskId = data?.task?.id ?? "";
			expect(taskId).toMatch(/^st_/);
		});

		rpcIo.outputLines = [];
		rpcIo.lineHandler!(JSON.stringify({
			id: "run-fixed",
			type: "schedule_run_now",
			scope: "workspace",
			workspaceId,
			taskId,
		}));
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "run-fixed",
					type: "response",
					command: "schedule_run_now",
					success: true,
				}),
			);
		});

		rpcIo.outputLines = [];
		await vi.waitFor(() => {
			rpcIo.lineHandler!(JSON.stringify({
				id: "list-fixed",
				type: "schedule_list",
				scope: "workspace",
				workspaceId,
			}));
			const listResponse = parseOutputLines().find((record) => record.id === "list-fixed" && record.command === "schedule_list");
			const tasks = (listResponse?.data as { tasks?: Array<{ id: string; runCount?: number; sessionTarget?: { kind: string; sessionId?: string } }> } | undefined)?.tasks ?? [];
			const task = tasks.find((candidate) => candidate.id === taskId);
			expect(task?.runCount).toBe(1);
			expect(task?.sessionTarget).toEqual({ kind: "pinned", sessionId: expect.any(String) });
			expect(task?.sessionTarget?.sessionId).not.toBe(sessionA);
			expect(task?.sessionTarget?.sessionId).not.toBe(sessionB);
		});

		rpcIo.outputLines = [];
		rpcIo.lineHandler!(JSON.stringify({
			id: "hist-fixed",
			type: "schedule_history",
			scope: "workspace",
			workspaceId,
			taskId,
		}));
		await vi.waitFor(() => {
			const historyResponse = parseOutputLines().find((record) => record.id === "hist-fixed" && record.command === "schedule_history");
			const runs = (historyResponse?.data as { runs?: Array<{ status: string; sessionId?: string }> } | undefined)?.runs ?? [];
			expect(runs[0]?.status).toBe("ok");
			expect(runs[0]?.sessionId).toBeDefined();
			expect(runs[0]?.sessionId).not.toBe(sessionA);
			expect(runs[0]?.sessionId).not.toBe(sessionB);
		});

		expect(manager.getActiveSessionId()).toBe(sessionB);
		facade.dispose();
	});

	it("cycles models through the facade model registry", async () => {
		const models = [
			{ provider: "test", id: "test-model", name: "Test Model" },
			{ provider: "test", id: "next-model", name: "Next Model" },
		];
		const modelRegistry = {
			getAvailable: () => models,
			find: (provider: string, modelId: string) => models.find((model) => model.provider === provider && model.id === modelId),
		} as unknown as ModelRegistry;
		const facade = createFacade(undefined, modelRegistry);
		void runRpcModeWithFacade(facade);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		rpcIo.lineHandler!(JSON.stringify({ id: "cycle-1", type: "cycle_model" }));
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "cycle-1",
					type: "response",
					command: "cycle_model",
					success: true,
					data: expect.objectContaining({
						model: models[1],
						thinkingLevel: "off",
						isScoped: false,
					}),
				}),
			);
		});
		expect(facade.model).toMatchObject({ provider: "test", model_id: "next-model" });

		facade.dispose();
	});

	it("reload_providers re-reads externally-written auth.json (desktop token refresh)", async () => {
		// Reproduces the desktop bug: the Tauri bridge writes a provider key directly
		// to auth.json while the sidecar holds a stale in-memory AuthStorage cache.
		// Without reload_providers, getApiKeyAndHeaders would fall back to the old
		// key (or an env var). After reload_providers it must use the fresh key.
		const dir = makeTempDir();
		const authJsonPath = join(dir, "auth.json");
		const modelsJsonPath = join(dir, "models.json");
		// Seed the file the sidecar would have loaded at startup (old key).
		writeFileSync(authJsonPath, JSON.stringify({ openai: { type: "api_key", key: "old-openai-key" } }, null, 2));
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					openai: {
						baseUrl: "https://api.openai.com/v1",
						api: "openai-responses",
						apiKey: "openai", // auth-only override on a built-in provider
					},
				},
			}),
		);

		const authStorage = AuthStorage.create(authJsonPath);
		const modelRegistry = RealModelRegistry.create(authStorage, modelsJsonPath);
		const facade = createFacade(undefined, modelRegistry);
		void runRpcModeWithFacade(facade);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		const model = modelRegistry.getAll().find((m) => m.provider === "openai");
		expect(model).toBeDefined();

		// Before reload: resolves the old key from the in-memory cache.
		const before = await modelRegistry.getApiKeyAndHeaders(model!);
		expect(before.ok).toBe(true);
		expect(before.ok && before.apiKey).toBe("old-openai-key");

		// The desktop bridge edits auth.json out-of-band (new key), then broadcasts
		// reload_providers to every sidecar.
		writeFileSync(authJsonPath, JSON.stringify({ openai: { type: "api_key", key: "new-openai-key" } }, null, 2));
		rpcIo.lineHandler!(JSON.stringify({ id: "reload-1", type: "reload_providers" }));
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "reload-1",
					type: "response",
					command: "reload_providers",
					success: true,
					data: { providers: ["openai"] },
				}),
			);
		});

		// After reload: the fresh key is used for model auth resolution.
		const after = await modelRegistry.getApiKeyAndHeaders(model!);
		expect(after.ok).toBe(true);
		expect(after.ok && after.apiKey).toBe("new-openai-key");

		facade.dispose();
	});

	it("reload_providers resolves a placeholder model after a key is added (desktop first-run setup)", async () => {
		// Reproduces the desktop first-run bug: the sidecar starts with no API
		// key configured, so the facade is initialized with the placeholder
		// model (provider="none", id="none"). The user configures a key via the
		// Settings UI; the bridge writes auth.json and broadcasts
		// reload_providers. Without resolving a real model here, get_state keeps
		// returning model=undefined and the GUI bounces the user back to the
		// setup page forever (especially in gateway mode where the agent process
		// can't be restarted).
		const dir = makeTempDir();
		const authJsonPath = join(dir, "auth.json");
		const modelsJsonPath = join(dir, "models.json");
		// No auth.json at startup → no models available → placeholder model.
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					openai: {
						baseUrl: "https://api.openai.com/v1",
						api: "openai-responses",
						apiKey: "openai", // auth-only override on a built-in provider
					},
				},
			}),
		);

		const authStorage = AuthStorage.create(authJsonPath);
		const modelRegistry = RealModelRegistry.create(authStorage, modelsJsonPath);

		// Build a facade with the placeholder model, matching the production
		// startup path in session-facade-factory when findInitialModel returns
		// no model (toModelConfig(model ?? ({ provider: "none", id: "none" }))).
		const cwd = makeTempDir();
		const store = new SqliteEventStore(`rpc-placeholder-${Date.now()}`, join(cwd, "events.sqlite"));
		const sessionManager = new SessionManager(store, store);
		sessionManager.createSession("user_explicit", "Initial");
		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			store,
			sessionManager,
			toolRegistry: emptyRegistry,
			llmClient: { async complete() { return makeTextResponse("ok"); } },
			systemPrompt: "placeholder test",
			model: { provider: "none", model_id: "none" },
			tools: [],
		});
		const facade = new SessionFacade({
			runtime,
			settingsManager: SettingsManager.inMemory({}),
			modelRegistry,
			disposers: [() => store.close()],
		});
		void runRpcModeWithFacade(facade);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		// Before reload: get_state returns model=undefined (placeholder).
		rpcIo.lineHandler!(JSON.stringify({ id: "state-1", type: "get_state" }));
		await vi.waitFor(() => {
			const stateResp = parseOutputLines().find((l) => l.id === "state-1");
			expect(stateResp).toBeDefined();
			expect((stateResp as { data?: { model?: unknown } }).data?.model).toBeUndefined();
		});

		// User configures a key via the Settings UI; bridge writes auth.json.
		writeFileSync(authJsonPath, JSON.stringify({ openai: { type: "api_key", key: "sk-test-key" } }, null, 2));
		rpcIo.lineHandler!(JSON.stringify({ id: "reload-1", type: "reload_providers" }));
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "reload-1",
					type: "response",
					command: "reload_providers",
					success: true,
					data: { providers: ["openai"] },
				}),
			);
		});

		// After reload: get_state returns a real model — the facade picked one
		// up from the now-available registry.
		rpcIo.lineHandler!(JSON.stringify({ id: "state-2", type: "get_state" }));
		await vi.waitFor(() => {
			const stateResp = parseOutputLines().find((l) => l.id === "state-2");
			expect(stateResp).toBeDefined();
			const model = (stateResp as { data?: { model?: { provider?: string; id?: string } } }).data?.model;
			expect(model).toBeDefined();
			expect(model?.provider).toBe("openai");
		});

		facade.dispose();
	});

	it("reload_providers recovers when the current model becomes unresolvable (provider removed mid-session)", async () => {
		// Reproduces the gateway-mode trap: the facade started with a real model,
		// then the provider was deleted from models.json while the agent kept
		// running (e.g. the user reconfigured providers in the Settings UI).
		// get_state returns model=undefined and, since gateway agents can't be
		// respawned by restart_sidecar, nothing ever re-resolves — the GUI
		// bounces the user back to the setup page forever. reload_providers
		// must treat a dangling model like the "none" placeholder and pick a
		// real model once credentials allow it.
		const dir = makeTempDir();
		const authJsonPath = join(dir, "auth.json");
		const modelsJsonPath = join(dir, "models.json");
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					openai: {
						baseUrl: "https://api.openai.com/v1",
						api: "openai-responses",
						apiKey: "openai", // auth-only override on a built-in provider
					},
				},
			}),
		);

		const authStorage = AuthStorage.create(authJsonPath);
		const modelRegistry = RealModelRegistry.create(authStorage, modelsJsonPath);

		// Facade holds a model whose provider no longer exists in the registry —
		// e.g. settings.json's defaultProvider pointed at a provider that has
		// since been removed. Not "none": the placeholder-only recovery path
		// must not be the only escape hatch.
		const cwd = makeTempDir();
		const store = new SqliteEventStore(`rpc-dangling-${Date.now()}`, join(cwd, "events.sqlite"));
		const sessionManager = new SessionManager(store, store);
		sessionManager.createSession("user_explicit", "Initial");
		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			store,
			sessionManager,
			toolRegistry: emptyRegistry,
			llmClient: { async complete() { return makeTextResponse("ok"); } },
			systemPrompt: "dangling model test",
			model: { provider: "removed-provider", model_id: "removed-model" },
			tools: [],
		});
		const facade = new SessionFacade({
			runtime,
			settingsManager: SettingsManager.inMemory({}),
			modelRegistry,
			disposers: [() => store.close()],
		});
		void runRpcModeWithFacade(facade);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		// Before reload: the dangling model resolves to nothing → model=undefined,
		// which is what traps the GUI in the setup page.
		rpcIo.lineHandler!(JSON.stringify({ id: "state-1", type: "get_state" }));
		await vi.waitFor(() => {
			const stateResp = parseOutputLines().find((l) => l.id === "state-1");
			expect(stateResp).toBeDefined();
			expect((stateResp as { data?: { model?: unknown } }).data?.model).toBeUndefined();
		});

		// User reconfigures providers via the Settings UI; the bridge writes
		// auth.json (key for the surviving provider) and broadcasts
		// reload_providers.
		writeFileSync(authJsonPath, JSON.stringify({ openai: { type: "api_key", key: "sk-test-key" } }, null, 2));
		rpcIo.lineHandler!(JSON.stringify({ id: "reload-1", type: "reload_providers" }));
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "reload-1",
					type: "response",
					command: "reload_providers",
					success: true,
					data: { providers: ["openai"] },
				}),
			);
		});

		// After reload: the facade switched to a resolvable model.
		rpcIo.lineHandler!(JSON.stringify({ id: "state-2", type: "get_state" }));
		await vi.waitFor(() => {
			const stateResp = parseOutputLines().find((l) => l.id === "state-2");
			expect(stateResp).toBeDefined();
			const model = (stateResp as { data?: { model?: { provider?: string } } }).data?.model;
			expect(model).toBeDefined();
			expect(model?.provider).toBe("openai");
		});

		// A model that still resolves must NOT be yanked on subsequent reloads.
		const modelId = facade.model.model_id;
		rpcIo.lineHandler!(JSON.stringify({ id: "reload-2", type: "reload_providers" }));
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({ id: "reload-2", type: "response", command: "reload_providers", success: true }),
			);
		});
		rpcIo.lineHandler!(JSON.stringify({ id: "state-3", type: "get_state" }));
		await vi.waitFor(() => {
			const stateResp = parseOutputLines().find((l) => l.id === "state-3");
			expect(stateResp).toBeDefined();
			const model = (stateResp as { data?: { model?: { provider?: string; model_id?: string } } }).data?.model;
			expect(model?.provider).toBe("openai");
			expect(model?.id).toBe(modelId);
		});

		facade.dispose();
	});

	it("get_extensions returns extensions (empty when no resource loader)", async () => {
		const facade = createFacade();
		void runRpcModeWithFacade(facade);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		rpcIo.lineHandler!(JSON.stringify({ id: "ext-1", type: "get_extensions" }));
		await vi.waitFor(() => {
			const records = parseOutputLines();
			expect(records).toContainEqual(
				expect.objectContaining({
					id: "ext-1",
					type: "response",
					command: "get_extensions",
					success: true,
				}),
			);
			const exts = records.find((r) => r.command === "get_extensions")?.data as
				| { extensions: Array<{ id: string; kind: string; enabled: boolean; canToggle: boolean }> }
				| undefined;
			// Built-ins are listed even without a resource loader; agent-browser is enabled by default.
			const ab = exts?.extensions.find((e) => e.id === "agent-browser");
			expect(ab).toEqual(
				expect.objectContaining({ id: "agent-browser", kind: "builtin", enabled: true, canToggle: true }),
			);
		});

		facade.dispose();
	});

	it("set_extension_enabled toggles a built-in extension and reports reload", async () => {
		const facade = createFacade();
		void runRpcModeWithFacade(facade);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		rpcIo.lineHandler!(
			JSON.stringify({ id: "toggle-1", type: "set_extension_enabled", extensionId: "agent-browser", enabled: false }),
		);
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "toggle-1",
					type: "response",
					command: "set_extension_enabled",
					success: true,
					data: { id: "agent-browser", enabled: false, requiresReload: true },
				}),
			);
		});
		expect(facade.settingsManager.getDisabledBuiltinExtensions().has("agent-browser")).toBe(true);

		facade.dispose();
	});

	it("set_extension_enabled rejects non-built-in ids", async () => {
		const facade = createFacade();
		void runRpcModeWithFacade(facade);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		rpcIo.lineHandler!(
			JSON.stringify({ id: "toggle-2", type: "set_extension_enabled", extensionId: "not-a-builtin", enabled: true }),
		);
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "toggle-2",
					type: "response",
					command: "set_extension_enabled",
					success: false,
				}),
			);
		});

		facade.dispose();
	});

	it("install_extension installs agent-browser and reports installed=true", async () => {
		execMock.reset(false);
		const facade = createFacade();
		void runRpcModeWithFacade(facade);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		rpcIo.lineHandler!(
			JSON.stringify({ id: "inst-1", type: "install_extension", extensionId: "agent-browser" }),
		);
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "inst-1",
					type: "response",
					command: "install_extension",
					success: true,
					data: expect.objectContaining({ extensionId: "agent-browser", ok: true, installed: true }),
				}),
			);
		});

		facade.dispose();
	});

	it("uninstall_extension reports installed=false", async () => {
		execMock.reset(false);
		const facade = createFacade();
		void runRpcModeWithFacade(facade);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		rpcIo.lineHandler!(
			JSON.stringify({ id: "uninst-1", type: "uninstall_extension", extensionId: "agent-browser" }),
		);
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "uninst-1",
					type: "response",
					command: "uninstall_extension",
					success: true,
					data: expect.objectContaining({ extensionId: "agent-browser", installed: false }),
				}),
			);
		});

		facade.dispose();
	});

	it("install_extension rejects a non-installable id", async () => {
		const facade = createFacade();
		void runRpcModeWithFacade(facade);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		rpcIo.lineHandler!(
			JSON.stringify({ id: "inst-2", type: "install_extension", extensionId: "not-installable" }),
		);
		await vi.waitFor(() => {
			expect(parseOutputLines()).toContainEqual(
				expect.objectContaining({
					id: "inst-2",
					type: "response",
					command: "install_extension",
					success: true,
					data: expect.objectContaining({ ok: false }),
				}),
			);
		});

		facade.dispose();
	});
});
