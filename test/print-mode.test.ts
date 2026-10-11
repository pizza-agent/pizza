import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../src/core/agent/types.js";
import type { ContentBlock, EventBase } from "../src/core/event-store/types.js";
import type { ToolRegistry } from "../src/core/intent/types.js";
import type { LLMClient, LLMResponse } from "../src/core/runtime/llm-types.js";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import { SessionFacade } from "../src/core/session/session-facade.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { runPrintModeWithFacade } from "../src/modes/print-mode.js";

const tempDirs: string[] = [];

const emptyRegistry: ToolRegistry = {
	get: () => undefined,
	list: () => [],
};

function makeTempDir(): string {
	const dir = join(tmpdir(), `pizza-print-mode-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function captureStdout(): string[] {
	const chunks: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation(((chunk, encodingOrCallback, callback) => {
		chunks.push(String(chunk));
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		done?.();
		return true;
	}) as typeof process.stdout.write);
	return chunks;
}

function createFacade(client?: LLMClient): { facade: SessionFacade; runtime: EventSourcedRuntime; disposer: ReturnType<typeof vi.fn> } {
	const cwd = makeTempDir();
	const runtime = new EventSourcedRuntime({
		cwd,
		agentDir: cwd,
		toolRegistry: emptyRegistry,
		llmClient: client ?? {
			async complete(): Promise<LLMResponse> {
				return makeTextResponse("facade done");
			},
		},
		systemPrompt: "print test",
		model: { provider: "test", model_id: "test-model" },
		tools: [],
	});
	const disposer = vi.fn();
	const facade = new SessionFacade({
		runtime,
		settingsManager: SettingsManager.inMemory({ defaultProvider: "test", defaultModel: "test-model" }),
		disposers: [disposer],
	});
	return { facade, runtime, disposer };
}


afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});

describe("runPrintModeWithFacade", () => {
	it("prints final assistant text from the event projection", async () => {
		const stdout = captureStdout();
		const { facade, disposer } = createFacade();

		const exitCode = await runPrintModeWithFacade(facade, {
			mode: "text",
			initialMessage: "Say done",
		});

		expect(exitCode).toBe(0);
		expect(stdout.join("")).toBe("facade done\n");
		expect(disposer).toHaveBeenCalledTimes(1);
	});

	it("emits typed event JSON lines in json mode", async () => {
		const stdout = captureStdout();
		const { facade, disposer } = createFacade();

		const exitCode = await runPrintModeWithFacade(facade, {
			mode: "json",
			initialMessage: "hello",
		});

		expect(exitCode).toBe(0);
		const events = stdout.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as EventBase);
		expect(events.every((event) => typeof event.sequence === "number" && typeof event.event_id === "string")).toBe(true);
		expect(events.map((event) => event.type)).toContain("USER_MESSAGE");
		expect(events.map((event) => event.type)).toContain("AGENT_MESSAGE_END");
		expect(events.map((event) => event.type)).toContain("AGENT_TURN_COMPLETED");
		expect(disposer).toHaveBeenCalledTimes(1);
	});

	it("converts legacy print image content to event-store image content", async () => {
		const stdout = captureStdout();
		let requestMessages: AgentMessage[] = [];
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];
		const { facade } = createFacade({
			async complete(request): Promise<LLMResponse> {
				requestMessages = request.messages;
				return makeTextResponse("saw image");
			},
		});

		const exitCode = await runPrintModeWithFacade(facade, {
			mode: "text",
			initialMessage: "Describe",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(stdout.join("")).toBe("saw image\n");
		const userMessage = requestMessages.find((message) => message.role === "user");
		expect(userMessage?.content).toEqual([
			{ type: "text", text: "Describe" },
			{ type: "image", data: "abc", mimeType: "image/png" },
		]);
	});
});
