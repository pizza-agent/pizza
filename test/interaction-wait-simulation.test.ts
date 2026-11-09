/**
 * Simulates the real question path: the model calls `cli` / `_interact show`,
 * the GUI leaves the card pending, the turn stops, then a click resumes it.
 * Terminal prompts still answer inside the same command.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInteractionExtension } from "../src/builtin-extensions/interaction/index.js";
import type { CliCommandDefinition, ExtensionContext } from "../src/core/extensions/types.js";
import { answerInteraction, listInteractions } from "../src/core/interaction/store.js";
import { InteractionDelivery } from "../src/core/interaction/delivery.js";
import { createToolRegistry } from "../src/core/intent/tool-adapter.js";
import type { LLMClient, LLMResponse } from "../src/core/runtime/llm-types.js";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import type { SessionFacade } from "../src/core/session/session-facade.js";
import { createCliToolDefinition } from "../src/core/tools/cli.js";
import { CommandRegistry } from "../src/core/tools/command-registry.js";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.js";
import type { ContentBlock } from "../src/core/event-store/types.js";

const card = {
	title: "Pick one",
	fields: [
		{
			id: "choice",
			type: "select",
			label: "Choice",
			options: [
				{ id: "a", label: "Alpha" },
				{ id: "b", label: "Beta" },
			],
		},
	],
};
const commandText = `_interact show <<'JSON'\n${JSON.stringify(card)}\nJSON`;

function interactCommand(): CliCommandDefinition {
	let command: CliCommandDefinition | undefined;
	createInteractionExtension({
		registerCliCommand: (registered: CliCommandDefinition) => {
			command = registered;
		},
		on: () => {},
	} as never);
	if (!command) throw new Error("interaction command was not registered");
	return command;
}

function usage() {
	return { input: 1, output: 1, cache_read: 0, cache_write: 0, total: 2, cost: 0 };
}

function toolUse(): LLMResponse {
	const content: ContentBlock[] = [
		{ type: "tool_call", id: "call_1", name: "cli", arguments: { command: commandText } } as ContentBlock,
	];
	return { content, provider: "test", model: "test", usage: usage(), stopReason: "tool_use" };
}

function reply(text: string): LLMResponse {
	return {
		content: [{ type: "text", text } as ContentBlock],
		provider: "test",
		model: "test",
		usage: usage(),
		stopReason: "stop",
	};
}

describe("interaction wait simulation", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function setup(surface: "rpc" | "tui", select: ExtensionContext["ui"]["select"]) {
		const cwd = mkdtempSync(join(tmpdir(), "pizza-interact-wait-"));
		dirs.push(cwd);
		let runtime: EventSourcedRuntime | undefined;
		const seen: string[] = [];
		let calls = 0;
		const client: LLMClient = {
			async complete(request) {
				calls++;
				seen.push(JSON.stringify(request.messages));
				return calls === 1 ? toolUse() : reply("continued");
			},
		};
		const cli = wrapToolDefinition(
			createCliToolDefinition(cwd, { registry: new CommandRegistry({ builtins: [], sdk: [interactCommand()] }) }),
			() =>
				({
					ui: { surface, select, input: vi.fn(), confirm: vi.fn(), notify: vi.fn() },
					sessionManager: {
						eventStore: runtime!.store,
						projection: runtime!.getProjection(),
					},
				}) as unknown as ExtensionContext,
		);
		runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			threadId: "default",
			toolRegistry: createToolRegistry([cli]),
			llmClient: client,
			classifierConfig: { require_approval_unknown: false },
			systemPrompt: "test",
			model: { provider: "test", model_id: "test" },
			tools: [],
		});
		return { runtime, seen, callCount: () => calls };
	}

	it("stops after the GUI choice card and resumes only when the user picks", async () => {
		const select = vi.fn();
		const { runtime, seen, callCount } = setup("rpc", select);

		await runtime.prompt("ask me to pick");

		expect(select).not.toHaveBeenCalled();
		expect(callCount()).toBe(1);
		expect(runtime.isRunning).toBe(false);
		expect(runtime.store.query({ types: ["AGENT_TURN_REQUESTED"] })).toHaveLength(1);
		expect((runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] })[0].payload as { reason: string }).reason).toBe(
			"interaction_pending",
		);
		const threadId = runtime.getProjection().getDescriptor().thread_id;
		const pending = listInteractions(runtime.store, threadId);
		expect(pending).toHaveLength(1);
		expect(pending[0].status).toBe("pending");
		const toolResult = JSON.stringify(runtime.store.query({ types: ["TOOL_EXECUTION_END"] })[0].payload);
		expect(toolResult).toContain("pending");
		expect(toolResult).toContain("_interact");

		const failure = vi.fn();
		const delivery = new InteractionDelivery(
			runtime.store,
			{
				get isRunning() {
					return runtime.isRunning;
				},
				runtime,
				prompt: (text: string, _images?: unknown, _files?: unknown, options?: { threadId?: string }) =>
					runtime.prompt(text, undefined, undefined, options?.threadId),
			} as unknown as SessionFacade,
			failure,
		);
		answerInteraction(
			runtime.store,
			threadId,
			pending[0].id,
			{ kind: "submit", values: { choice: "a" } },
			{ deliveryRequired: true },
		);
		delivery.resume();
		await vi.waitFor(() => expect(callCount()).toBe(2));
		expect(failure).not.toHaveBeenCalled();
		expect(seen[1]).toContain("interaction_response");
		expect(seen[1]).toContain("Alpha");
		expect((runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] }).at(-1)!.payload as { reason: string }).reason).toBe(
			"stop",
		);
		expect(listInteractions(runtime.store, runtime.getProjection().getDescriptor().thread_id)[0].status).toBe(
			"answered",
		);
		delivery.dispose();
		runtime.dispose();
	});

	it("answers inside the terminal prompt and continues the same turn", async () => {
		const select = vi.fn(async () => "a: Alpha");
		const { runtime, seen, callCount } = setup("tui", select);

		await runtime.prompt("ask me to pick");

		expect(select).toHaveBeenCalledOnce();
		expect(callCount()).toBe(2);
		expect(seen[1]).toContain("Alpha");
		expect(seen[1]).not.toContain("interaction_response");
		expect((runtime.store.query({ types: ["AGENT_TURN_COMPLETED"] })[0].payload as { reason: string }).reason).toBe(
			"stop",
		);
		expect(listInteractions(runtime.store, runtime.getProjection().getDescriptor().thread_id)[0]).toMatchObject({
			status: "answered",
			answer: { kind: "submit", values: { choice: "a" } },
		});
		runtime.dispose();
	});
});
