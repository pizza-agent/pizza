import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import type { BashExecutionEvent } from "../src/core/event-store/events.js";
import type { ToolRegistry } from "../src/core/intent/types.js";
import type { LLMClient, LLMResponse } from "../src/core/runtime/llm-types.js";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import { SessionFacade } from "../src/core/session/session-facade.js";
import { SettingsManager } from "../src/core/config/settings-manager.js";
import { InteractiveMode } from "../packages/tui/interactive-mode.js";

vi.mock("../packages/tui/theme/theme.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	theme: {},
}));

const emptyRegistry: ToolRegistry = {
	get: () => undefined,
	list: () => [],
};

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = join(tmpdir(), `pizza-bash-facade-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

function createFacade(): SessionFacade {
	const cwd = makeTempDir();
	const store = new SqliteEventStore(`bash-facade-${Date.now()}`, join(cwd, "events.sqlite"));
	const runtime = new EventSourcedRuntime({
		cwd,
		agentDir: cwd,
		store,
		toolRegistry: emptyRegistry,
		llmClient: {
			async complete(): Promise<LLMResponse> {
				return {
					content: [{ type: "text", text: "ok" }],
					provider: "test",
					model: "test-model",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		} as LLMClient,
		systemPrompt: "test",
		model: { provider: "test", model_id: "test-model" },
		tools: [],
	});
	return new SessionFacade({
		runtime,
		settingsManager: SettingsManager.inMemory({ defaultProvider: "test", defaultModel: "test-model" }),
		disposers: [() => store.close()],
	});
}

describe("InteractiveMode bash facade (executeBashFacade + recordBashResultFacade)", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("executeBashFacade executes a shell command and returns output", async () => {
		const facade = createFacade();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
		Object.assign(mode, {
			facade,
			bashAbortController: undefined,
		});

		const executeBashFacade = Reflect.get(InteractiveMode.prototype, "executeBashFacade") as (
			this: InteractiveMode,
			command: string,
			onChunk?: (chunk: string) => void,
			options?: any,
		) => Promise<any>;

		const chunks: string[] = [];
		const result = await executeBashFacade.call(mode, "echo hello-bash", (chunk) => chunks.push(chunk));

		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
		expect(result.output).toContain("hello-bash");
		expect(chunks.join("")).toContain("hello-bash");
		// bashAbortController should be cleared after execution
		expect((mode as any).bashAbortController).toBeUndefined();

		facade.dispose();
	});

	it("isBashRunningValue reflects abort controller state", async () => {
		const facade = createFacade();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
		Object.assign(mode, {
			facade,
			bashAbortController: undefined,
		});

		const isBashRunningValue = Reflect.get(InteractiveMode.prototype, "isBashRunningValue") as unknown as {
			get(this: InteractiveMode): boolean;
		};
		// Using the getter via Object.getOwnPropertyDescriptor
		const desc = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "isBashRunningValue");
		const getter = desc?.get!;
		expect(getter.call(mode)).toBe(false);

		(mode as any).bashAbortController = new AbortController();
		expect(getter.call(mode)).toBe(true);

		(mode as any).bashAbortController = undefined;
		expect(getter.call(mode)).toBe(false);

		facade.dispose();
	});

	it("recordBashResultFacade appends BASH_EXECUTION event to the store", () => {
		const facade = createFacade();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
		Object.assign(mode, {
			facade,
			bashAbortController: undefined,
		});

		const recordBashResultFacade = Reflect.get(InteractiveMode.prototype, "recordBashResultFacade") as (
			this: InteractiveMode,
			command: string,
			result: any,
			options?: { excludeFromContext?: boolean },
		) => void;

		const beforeCount = facade.runtime.store.query({}).length;
		recordBashResultFacade.call(mode, "echo test", {
			output: "test\n",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			durationMs: 42,
		}, { excludeFromContext: false });

		const events = facade.runtime.store.query({});
		expect(events.length).toBe(beforeCount + 1);
		const bashEvent = events[events.length - 1] as BashExecutionEvent;
		expect(bashEvent.type).toBe("BASH_EXECUTION");
		expect(bashEvent.payload.command).toBe("echo test");
		expect(bashEvent.payload.output).toBe("test\n");
		expect(bashEvent.payload.exit_code).toBe(0);
		expect(bashEvent.payload.exclude_from_context).toBe(false);

		facade.dispose();
	});

	it("recordBashResultFacade respects excludeFromContext flag", () => {
		const facade = createFacade();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
		Object.assign(mode, {
			facade,
			bashAbortController: undefined,
		});

		const recordBashResultFacade = Reflect.get(InteractiveMode.prototype, "recordBashResultFacade") as (
			this: InteractiveMode,
			command: string,
			result: any,
			options?: { excludeFromContext?: boolean },
		) => void;

		recordBashResultFacade.call(mode, "secret", {
			output: "",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		}, { excludeFromContext: true });

		const events = facade.runtime.store.query({});
		const bashEvent = events[events.length - 1] as BashExecutionEvent;
		expect(bashEvent.type).toBe("BASH_EXECUTION");
		expect(bashEvent.payload.exclude_from_context).toBe(true);

		facade.dispose();
	});

	it("abortBashFacade aborts a running command via AbortController", async () => {
		const facade = createFacade();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
		Object.assign(mode, {
			facade,
			bashAbortController: undefined,
		});

		const executeBashFacade = Reflect.get(InteractiveMode.prototype, "executeBashFacade") as (
			this: InteractiveMode,
			command: string,
			onChunk?: (chunk: string) => void,
			options?: any,
		) => Promise<any>;

		const abortBashFacade = Reflect.get(InteractiveMode.prototype, "abortBashFacade") as (
			this: InteractiveMode,
		) => void;

		// Start a long-running command
		const promise = executeBashFacade.call(mode, "sleep 10 && echo done");

		// Give it a moment to start, then abort
		await new Promise((resolve) => setTimeout(resolve, 100));
		abortBashFacade.call(mode);

		const result = await promise;
		expect(result.cancelled).toBe(true);
		expect((mode as any).bashAbortController).toBeUndefined();

		facade.dispose();
	});

	it("executeBashFacade does not throw 'not yet supported' error", async () => {
		const facade = createFacade();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
		Object.assign(mode, {
			facade,
			bashAbortController: undefined,
		});

		const executeBashFacade = Reflect.get(InteractiveMode.prototype, "executeBashFacade") as (
			this: InteractiveMode,
			command: string,
			onChunk?: (chunk: string) => void,
			options?: any,
		) => Promise<any>;

		// Before the fix, this would throw "executeBash is not yet supported in facade mode"
		const result = await executeBashFacade.call(mode, "true");
		expect(result.exitCode).toBe(0);

		facade.dispose();
	});

	it("handleModeEvent does not re-render bashExecution message_committed (no duplicate)", async () => {
		const facade = createFacade();
		const addMessageToChat = vi.fn();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
		Object.assign(mode, {
			facade,
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			ui: { requestRender: vi.fn() },
			addMessageToChat,
		});

		const handleModeEvent = Reflect.get(InteractiveMode.prototype, "handleModeEvent") as (
			this: InteractiveMode,
			event: any,
		) => Promise<void>;

		// Simulate the message_committed event that the BASH_EXECUTION event triggers
		await handleModeEvent.call(mode, {
			type: "message_committed",
			message: {
				role: "bashExecution",
				command: "ls",
				output: "file.txt\n",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext: false,
			},
		});

		// addMessageToChat should NOT be called for bashExecution — handleBashCommand already renders it
		expect(addMessageToChat).not.toHaveBeenCalled();

		facade.dispose();
	});

	it("handleModeEvent still renders other non-bash message_committed roles", async () => {
		const facade = createFacade();
		const addMessageToChat = vi.fn();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
		Object.assign(mode, {
			facade,
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			ui: { requestRender: vi.fn() },
			addMessageToChat,
			updatePendingMessagesDisplay: vi.fn(),
		});

		const handleModeEvent = Reflect.get(InteractiveMode.prototype, "handleModeEvent") as (
			this: InteractiveMode,
			event: any,
		) => Promise<void>;

		// user message should still be rendered
		await handleModeEvent.call(mode, {
			type: "message_committed",
			message: { role: "user", content: "hello" },
		});
		expect(addMessageToChat).toHaveBeenCalledTimes(1);

		facade.dispose();
	});
});
