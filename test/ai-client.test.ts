import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildLlmClientFromStreamFn, type AiStreamFn } from "../src/core/runtime/ai-client.js";
import { isLlmMessage, toLlmMessages } from "../src/core/agent/types.js";
import { convertToLlm } from "../src/core/context/messages.js";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import type { LLMChunk } from "../src/core/runtime/llm-types.js";

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

function createAssistantMessage(model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
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

function createModel(): Model<any> {
	return {
		id: "qwen3.8-max",
		name: "qwen3.8-max",
		api: "anthropic-messages",
		provider: "custom-provider",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

describe("buildLlmClientFromStreamFn", () => {
	it("streams text and split tool arguments through the upgraded provider adapter", async () => {
		const model = getModel("deepseek", "deepseek-flash");
		const chunks: LLMChunk[] = [];
		let payload: any;
		const deltas = [
			{ content: "Looking up the value." },
			{ tool_calls: [{ index: 0, id: "call_lookup", type: "function", function: { name: "lookup", arguments: '{"value":' } }] },
			{ tool_calls: [{ index: 0, function: { arguments: "42}" } }] },
		];
		const events = deltas.map(delta => ({ choices: [{ index: 0, delta, finish_reason: null }] }));
		events.push({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] } as any);
		const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
		const client = buildLlmClientFromStreamFn(() => model, streamSimple, {
			getApiKey: () => "test-key",
			fetch: async (_input, init) => {
				payload = JSON.parse(init!.body as string);
				return new Response(body, { headers: { "content-type": "text/event-stream" } });
			},
		});
		const response = await client.complete({
			model: { provider: model.provider, model_id: model.id },
			systemPrompt: "Use the lookup tool.",
			messages: [{ role: "user", content: "Look up 42", timestamp: 1 }],
			tools: [{ name: "lookup", input_schema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] } }],
			onChunk: chunk => chunks.push(chunk),
		});

		expect(payload.model).toBe("deepseek-flash");
		expect(payload.messages[0]).toMatchObject({ role: "system", content: "Use the lookup tool." });
		expect(payload.tools[0].function.name).toBe("lookup");
		expect(response.stopReason).toBe("tool_use");
		expect(response.content).toEqual([
			{ type: "text", text: "Looking up the value." },
			{ type: "tool_call", id: "call_lookup", name: "lookup", arguments: { value: 42 } },
		]);
		expect(chunks).toContainEqual({ kind: "toolcall_end", contentIndex: 1, tool_call_id: "call_lookup", tool_name: "lookup", arguments: { value: 42 } });
	});

	it("preserves transcript system instructions and tool declarations", async () => {
		const model = createModel();
		const system = {
			role: "system" as const,
			content: "Updated instructions",
			toolsAdded: [{ name: "lookup", description: "Look up a value", parameters: { type: "object" } }],
			timestamp: 1,
		};
		let capturedContext: Context | undefined;
		const client = buildLlmClientFromStreamFn(() => model, (_model, context) => {
			capturedContext = context;
			return new MockAssistantStream(createAssistantMessage(model));
		});

		expect(isLlmMessage(system)).toBe(true);
		expect(toLlmMessages([system])).toEqual([system]);
		await client.complete({ messages: convertToLlm([system]), tools: [] });
		expect(capturedContext?.messages).toEqual([system]);
	});

	it("does not pass provider reasoning when thinking level is off", async () => {
		const model = createModel();
		let capturedOptions: SimpleStreamOptions | undefined;
		const streamFn: AiStreamFn = (_model: Model<any>, _context: Context, options?: SimpleStreamOptions) => {
			capturedOptions = options;
			return new MockAssistantStream(createAssistantMessage(model));
		};
		const client = buildLlmClientFromStreamFn(() => model, streamFn, {
			getThinkingLevel: () => "off",
		});

		await client.complete({ messages: [{ role: "user", content: "hi" }], tools: [] });

		expect(capturedOptions).toBeDefined();
		expect(capturedOptions).not.toHaveProperty("reasoning");
	});

	it("passes provider reasoning when thinking level is enabled", async () => {
		const model = { ...createModel(), reasoning: true };
		let capturedOptions: SimpleStreamOptions | undefined;
		const streamFn: AiStreamFn = (_model: Model<any>, _context: Context, options?: SimpleStreamOptions) => {
			capturedOptions = options;
			return new MockAssistantStream(createAssistantMessage(model));
		};
		const client = buildLlmClientFromStreamFn(() => model, streamFn, {
			getThinkingLevel: () => "high",
		});

		await client.complete({ messages: [{ role: "user", content: "hi" }], tools: [] });

		expect(capturedOptions?.reasoning).toBe("high");
	});
});
