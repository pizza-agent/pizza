import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createExtensionRuntime } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import { EventStoreExtensionSessionManager } from "../src/core/extensions/session-context.js";
import type { Extension } from "../src/core/extensions/types.js";
import type { ContentBlock } from "../src/core/event-store/types.js";
import type { ToolRegistry } from "../src/core/intent/types.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { PromptTemplate } from "../src/core/prompt-templates.js";
import type { ResourceLoader } from "../src/core/resource-loader.js";
import type { LLMResponse } from "../src/core/runtime/llm-types.js";
import type { AgentMessage } from "../src/core/agent/types.js";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import { SessionFacade } from "../src/core/session-facade.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { Skill } from "../src/core/skills.js";

/**
 * Regression: `/<name> [args]` dispatch was dropped when AgentSession was
 * replaced by EventSourcedRuntime — extension commands (e.g. /computer
 * install, /browser install) reached the model as plain text instead of
 * running their handler. The interception now lives in SessionFacade so
 * prompt/steer/followUp all share it.
 */
describe("SessionFacade slash-command dispatch", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pizza-cmd-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	const emptyRegistry: ToolRegistry = {
		get: () => undefined,
		list: () => [],
	};

	function makeLlmClient(captured: { requests: AgentMessage[][]; calls: number }) {
		return {
			async complete(request: { messages: AgentMessage[] }): Promise<LLMResponse> {
				captured.calls++;
				captured.requests.push(request.messages);
				return {
					content: [{ type: "text", text: "ok" } as ContentBlock],
					provider: "test",
					model: "test-model",
					usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
					stopReason: "stop",
				};
			},
		};
	}

	function lastUserText(messages: AgentMessage[]): string {
		const last = [...messages].reverse().find((m) => m.role === "user");
		const content = (last as { content?: unknown })?.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
				.filter(Boolean)
				.join("\n");
		}
		return "";
	}

	function makeExtension(commandName: string, calls: { args: string[] }): Extension {
		return {
			path: `test-${commandName}`,
			resolvedPath: `test-${commandName}`,
			sourceInfo: { path: `test-${commandName}`, source: "test", scope: "temporary", origin: "top-level" } as never,
			handlers: new Map(),
			tools: new Map(),
			builtinCommands: new Map(),
			commands: new Map([
				[
					commandName,
					{
						name: commandName,
						sourceInfo: { path: `test-${commandName}`, source: "test", scope: "temporary", origin: "top-level" } as never,
						description: "test command",
						handler: async (args: string) => {
							calls.args.push(args);
						},
					},
				],
			]),
			flags: new Map(),
			shortcuts: new Map(),
		};
	}

	function makeFacade(options: {
		cwd: string;
		extensions?: Extension[];
		skills?: Skill[];
		prompts?: PromptTemplate[];
	}) {
		const captured = { requests: [] as AgentMessage[][], calls: 0 };
		const runtime = new EventSourcedRuntime({
			cwd: options.cwd,
			agentDir: options.cwd,
			toolRegistry: emptyRegistry,
			llmClient: makeLlmClient(captured),
			systemPrompt: "",
			model: { provider: "test", model_id: "test-model" },
			tools: [],
		});
		const sessionManager = new EventStoreExtensionSessionManager({
			store: runtime.store,
			projection: runtime.getProjection(),
			cwd: options.cwd,
		});
		const runner = new ExtensionRunner(
			options.extensions ?? [],
			createExtensionRuntime(),
			options.cwd,
			sessionManager,
			ModelRegistry.inMemory(AuthStorage.inMemory()),
		);
		const resourceLoader =
			options.skills || options.prompts
				? ({
						getSkills: () => ({ skills: options.skills ?? [], diagnostics: [] }),
						getPrompts: () => ({ prompts: options.prompts ?? [], diagnostics: [] }),
					} as unknown as ResourceLoader)
				: undefined;
		const facade = new SessionFacade({
			runtime,
			settingsManager: SettingsManager.inMemory(),
			extensionRunner: runner,
			modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
			resourceLoader,
		});
		return { facade, runtime, captured };
	}

	it("executes registered extension commands instead of prompting the model", async () => {
		const cwd = makeTempDir();
		const calls = { args: [] as string[] };
		const { facade, runtime, captured } = makeFacade({
			cwd,
			extensions: [makeExtension("computer", calls)],
		});

		await facade.prompt("/computer install");

		expect(calls.args).toEqual(["install"]);
		// No LLM turn must be started — the command handled the input.
		expect(captured.calls).toBe(0);
		runtime.dispose();
	});

	it("executes commands via steer() while a turn would queue plain text", async () => {
		const cwd = makeTempDir();
		const calls = { args: [] as string[] };
		const { facade, runtime, captured } = makeFacade({
			cwd,
			extensions: [makeExtension("browser", calls)],
		});

		facade.steer("/browser status");
		// steer() dispatches the async handler without blocking; give it a tick.
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(calls.args).toEqual(["status"]);
		expect(captured.calls).toBe(0);
		runtime.dispose();
	});

	it("passes unknown /commands through to the model unchanged", async () => {
		const cwd = makeTempDir();
		const { facade, runtime, captured } = makeFacade({ cwd });

		await facade.prompt("/not-a-command hello");

		expect(captured.calls).toBe(1);
		expect(lastUserText(captured.requests[0]!)).toBe("/not-a-command hello");
		runtime.dispose();
	});

	it("expands /skill:<name> into the skill block before prompting", async () => {
		const cwd = makeTempDir();
		const skillFile = join(cwd, "SKILL.md");
		writeFileSync(skillFile, "---\nname: demo\ndescription: d\n---\n\nSKILL BODY\n");
		const skill: Skill = {
			name: "demo",
			description: "d",
			filePath: skillFile,
			baseDir: cwd,
			sourceInfo: { path: skillFile, source: "test", scope: "temporary", origin: "top-level" } as never,
			disableModelInvocation: false,
		};
		const { facade, runtime, captured } = makeFacade({ cwd, skills: [skill] });

		await facade.prompt("/skill:demo do the thing");

		const text = lastUserText(captured.requests[0]!);
		expect(text).toContain('<skill name="demo"');
		expect(text).toContain("SKILL BODY");
		expect(text).toContain("do the thing");
		runtime.dispose();
	});

	it("expands prompt templates before prompting", async () => {
		const cwd = makeTempDir();
		const prompt: PromptTemplate = {
			name: "review",
			description: "d",
			content: "TEMPLATE BODY $ARGUMENTS",
			sourceInfo: { path: "x", source: "test", scope: "temporary", origin: "top-level" } as never,
			filePath: "x",
		};
		const { facade, runtime, captured } = makeFacade({ cwd, prompts: [prompt] });

		await facade.prompt("/review file.ts");

		const text = lastUserText(captured.requests[0]!);
		expect(text).toContain("TEMPLATE BODY");
		expect(text).toContain("file.ts");
		runtime.dispose();
	});
});
