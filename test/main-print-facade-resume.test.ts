import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { deriveWorkspaceId, getEventDatabasePath } from "../src/core/event-store/workspace.js";
import type { ExtensionAPI } from "../src/core/extensions/types.js";
import { makeSessionRef } from "../src/core/session/session-ref.js";

import { main } from "../src/main.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
		queueMicrotask(() => {
			this.push({ type: "start", partial: { ...message, content: [] } });
			this.push({ type: "done", reason: "stop", message });
		});
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "facade-test",
		model: "facade-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("main print facade resume route", () => {
	const tempDirs: string[] = [];
	const originalCwd = process.cwd();
	const originalEnvAgentDir = process.env[ENV_AGENT_DIR];
	const originalOffline = process.env.PIZZA_OFFLINE;
	const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

	afterEach(() => {
		process.chdir(originalCwd);
		if (originalEnvAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalEnvAgentDir;
		}
		if (originalOffline === undefined) {
			delete process.env.PIZZA_OFFLINE;
		} else {
			process.env.PIZZA_OFFLINE = originalOffline;
		}
		if (stdinIsTtyDescriptor) {
			Object.defineProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		}
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		vi.restoreAllMocks();
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pizza-main-print-facade-resume-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
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

	function createProject(): { agentDir: string; projectDir: string } {
		const tempDir = makeTempDir();
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env.PIZZA_OFFLINE = "1";
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		process.chdir(projectDir);
		return { agentDir, projectDir };
	}

	function createFacadeProviderExtension(
		responses: string[],
		seenContexts?: Context[],
	): (pizza: ExtensionAPI) => void {
		return (pizza: ExtensionAPI) => {
			pizza.registerProvider("facade-test", {
				baseUrl: "https://example.invalid",
				apiKey: "test-key",
				api: "anthropic-messages",
				streamSimple: (_model, context) => {
					seenContexts?.push(context);
					return new MockAssistantStream(createAssistantMessage(responses.shift() ?? "facade fallback"));
				},
				models: [
					{
						id: "facade-model",
						name: "Facade Model",
						api: "anthropic-messages",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 64000,
						maxTokens: 1024,
					},
				],
			});
		};
	}

	function readOnlySessionRef(agentDir: string): string {
		const workspaceId = deriveWorkspaceId(process.cwd());
		const dbPath = getEventDatabasePath(workspaceId, agentDir);
		if (!existsSync(dbPath)) {
			throw new Error(`Event database not found: ${dbPath}`);
		}
		const store = new SqliteEventStore(workspaceId, dbPath, "test_session_read");
		try {
			const index = store.getSessionIndex();
			expect(index?.sessions).toHaveLength(1);
			return makeSessionRef(workspaceId, index!.sessions[0]!.session_id);
		} finally {
			store.close();
		}
	}

	it("auto-resumes the eternal conversation in print/json facade mode", async () => {
		const { agentDir } = createProject();
		const stdout = captureStdout();
		const seenContexts: Context[] = [];

		await main(["--mode", "json", "--model", "facade-test/facade-model", "first"], {
			extensionFactories: [createFacadeProviderExtension(["first response"], seenContexts)],
		});

		// Verify the first run created a session
		readOnlySessionRef(agentDir);
		stdout.length = 0;

		// Second run with no flag: default auto-resumes the eternal conversation
		await main(["--mode", "json", "--model", "facade-test/facade-model", "second"], {
			extensionFactories: [createFacadeProviderExtension(["second response"], seenContexts)],
		});

		expect(seenContexts).toHaveLength(2);
		expect(seenContexts[1]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(seenContexts[1]!.messages[0]).toMatchObject({ role: "user", content: "first" });
		expect(seenContexts[1]!.messages[2]).toMatchObject({ role: "user", content: "second" });
	});
});
