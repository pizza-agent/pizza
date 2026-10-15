import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
	streamSimple,
	ToolCall,
} from "@earendil-works/pi-ai/compat";
import type { LLMChunk, LLMClient, ModelConfig } from "./llm-types.js";
import { annotateVagueError, wrapFetchWithDiagnostics } from "./network-diagnostics.js";

/** Shared diagnostics-wrapped fetch so network failures are recorded. */
const diagnosticsFetch = wrapFetchWithDiagnostics();

export type AiStreamFn = (
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;

function getStreamToolCall(event: AssistantMessageEvent): ToolCall | undefined {
	const direct = (event as any).toolCall;
	if (direct?.type === "toolCall") return direct as ToolCall;

	const contentIndex = (event as any).contentIndex;
	const partialContent = (event as any).partial?.content;
	const partialBlock =
		Array.isArray(partialContent) && typeof contentIndex === "number" ? partialContent[contentIndex] : undefined;
	return partialBlock?.type === "toolCall" ? (partialBlock as ToolCall) : undefined;
}

/** Build an EventSourcedRuntime LLMClient around the configured AI stream function. */
export function buildLlmClientFromStreamFn(
	/**
	 * Getter for the current model. Read at request time so live model changes
	 * (e.g. via /model, RPC set_model, or extensions) are reflected in both the
	 * API call and the model metadata exposed to tools via ctx.model.
	 */
	getModel: () => Model<any> | undefined,
	streamFn: AiStreamFn,
	options?: {
		getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
		/**
		 * Getter for the current thinking level (e.g. "off", "low", "medium", "high").
		 * Read at request time so live changes via /thinking are reflected.
		 */
		getThinkingLevel?: () => string | undefined;
		thinkingBudgets?: any;
		transport?: any;
		onPayload?: any;
		onResponse?: any;
		/**
		 * Optional fetch override for provider HTTP requests. Defaults to a
		 * diagnostics-wrapped global fetch so transport failures can be annotated.
		 */
		fetch?: typeof globalThis.fetch;
	},
): LLMClient {
	return {
		async complete({ messages, systemPrompt, tools, onChunk, signal }) {
			const model = getModel();
			if (!model) {
				throw new Error("No model configured");
			}
			const apiKey = options?.getApiKey ? await options.getApiKey(model.provider) : undefined;
			// Read the current thinking level at request time (not build time) so
			// runtime changes via /thinking or setThinkingLevel() are honored.
			// pi-ai's streamSimple expects this on options.reasoning.
			const reasoning = options?.getThinkingLevel?.();
			const providerReasoning = reasoning && reasoning !== "off" ? reasoning : undefined;
			const streamTools = tools?.map((tool) => ({
				name: tool.name,
				description: tool.description ?? "",
				parameters: tool.input_schema as any,
			})) as any;

			const stream = await streamFn(
				model,
				{
					systemPrompt: systemPrompt ?? "",
					messages: messages.filter(
						(message) =>
							message.role === "user" || message.role === "assistant" || message.role === "toolResult",
					).map((message) => {
						if (message.role !== "toolResult") {
							return message;
						}
						const toolResult = message as any;
						return {
							role: "toolResult",
							toolCallId: toolResult.toolCallId,
							toolName: toolResult.toolName,
							content: toolResult.content,
							isError: toolResult.isError,
							timestamp: toolResult.timestamp,
						};
					}) as any,
					tools: streamTools,
				},
				{
					apiKey,
					signal,
					onPayload: options?.onPayload,
					onResponse: options?.onResponse,
					thinkingBudgets: options?.thinkingBudgets,
					transport: options?.transport,
					// Wrap provider HTTP in the diagnostics fetch so transport-level
					// failures (DNS/TLS/refused/timeout) are recorded and can be
					// attached to vague error messages like "Connection error.".
					fetch: options?.fetch ?? diagnosticsFetch,
					// Pass the live thinking level so pi-ai maps it into the provider
					// payload (zai/openrouter/etc.). Without this, streamSimple sees
					// options.reasoning === undefined and always emits thinking disabled.
					...(providerReasoning !== undefined ? { reasoning: providerReasoning } : {}),
				} as any,
			);

			let finalMessage: AssistantMessage | undefined;

			for await (const event of stream) {
				switch (event.type) {
					case "start":
						break;
					case "text_start":
						onChunk?.({ kind: "text_start", contentIndex: event.contentIndex } as LLMChunk);
						break;
					case "text_delta":
						onChunk?.({ kind: "text_delta", contentIndex: event.contentIndex, delta: event.delta } as LLMChunk);
						break;
					case "text_end":
						onChunk?.({
							kind: "text_end",
							contentIndex: event.contentIndex,
							content: event.content,
						} as LLMChunk);
						break;
					case "thinking_start":
						onChunk?.({ kind: "thinking_start", contentIndex: event.contentIndex } as LLMChunk);
						break;
					case "thinking_delta":
						onChunk?.({
							kind: "thinking_delta",
							contentIndex: event.contentIndex,
							delta: event.delta,
						} as LLMChunk);
						break;
					case "thinking_end":
						onChunk?.({
							kind: "thinking_end",
							contentIndex: event.contentIndex,
							content: event.content,
						} as LLMChunk);
						break;
					case "toolcall_start": {
						const toolCall = getStreamToolCall(event);
						onChunk?.({
							kind: "toolcall_start",
							contentIndex: event.contentIndex,
							tool_call_id: (event as any).id ?? toolCall?.id ?? "",
							tool_name: (event as any).toolName ?? toolCall?.name ?? "",
						} as LLMChunk);
						break;
					}
					case "toolcall_delta":
						onChunk?.({ kind: "toolcall_delta", contentIndex: event.contentIndex, delta: event.delta } as LLMChunk);
						break;
					case "toolcall_end": {
						const toolCall = getStreamToolCall(event);
						onChunk?.({
							kind: "toolcall_end",
							contentIndex: event.contentIndex,
							tool_call_id: (event as any).id ?? toolCall?.id ?? "",
							tool_name: (event as any).toolName ?? toolCall?.name ?? "",
							arguments: toolCall?.arguments ?? {},
						} as LLMChunk);
						break;
					}
					case "done":
					case "error":
						finalMessage = await (stream as any).result();
						break;
				}
			}

			finalMessage ??= await (stream as any).result();
			if (!finalMessage) {
				throw new Error("Stream ended without a terminal event");
			}

			const content = finalMessage.content.map((block) => {
				if (block.type === "toolCall") {
					return {
						type: "tool_call",
						id: block.id,
						name: block.name,
						arguments: block.arguments,
					} as any;
				}
				return block as any;
			});

			return {
				content,
				provider: finalMessage.provider,
				model: finalMessage.model,
				usage: {
					input: finalMessage.usage.input,
					output: finalMessage.usage.output,
					cache_read: finalMessage.usage.cacheRead,
					cache_write: finalMessage.usage.cacheWrite,
					total: finalMessage.usage.totalTokens,
					cost: finalMessage.usage.cost.total,
				},
				// Only promote to tool_use when the stream actually ENDED in
				// toolUse (or the stop reason is missing). A partial tool_call
				// block inside an errored/aborted message must not mask the real
				// stop reason — otherwise the reactor treats a failed call as a
				// normal tool round (no retry, no error surfaced).
				stopReason:
					finalMessage.stopReason === "toolUse" ||
					(content.some((block: any) => block.type === "tool_call") &&
						finalMessage.stopReason !== "error" &&
						finalMessage.stopReason !== "aborted")
						? "tool_use"
						: (finalMessage.stopReason as any),
				errorMessage: annotateVagueError(finalMessage.errorMessage),
			};
		},
	};
}

export function toModelConfig(model: Model<any>, thinkingLevel: string | undefined): ModelConfig {
	return {
		provider: model.provider,
		model_id: model.id,
		thinking_level: thinkingLevel,
	};
}
