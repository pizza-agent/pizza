/**
 * Devin (Cascade) inference adapter.
 *
 * Streams `ApiServerService/GetChatMessage` over Connect JSON: pizza's
 * `Context` is replayed as `chatMessagePrompts` (USER / SYSTEM for assistant
 * turns / TOOL for tool results), the system prompt rides on the request's
 * top-level `prompt` field, and `chatModelUid` selects the CLI model uid.
 * Router uids (`adaptive`, `fusion-*`) resolve through `AssignModel` first —
 * the returned `modelAssignmentJwt` must accompany the chat request on the
 * same `cascadeId`.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	ThinkingContent,
	ToolCall,
} from "@earendil-works/pi-ai/compat";
import type { Api, AssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { DEVIN_DEFAULT_API_SERVER_URL, normalizeDevinSessionToken } from "./credentials.js";
import { connectStreamJson, connectUnaryJson, devinChatMetadata } from "./client.js";

const GET_CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const ASSIGN_MODEL_PATH = "/exa.api_server_pb.ApiServerService/AssignModel";

// --- Wire types (only the fields we use) ------------------------------------

interface DevinChatToolCall {
	id?: string;
	name?: string;
	argumentsJson?: string;
}

interface DevinChatMessagePrompt {
	messageId?: string;
	source?: string;
	prompt?: string;
	toolCalls?: DevinChatToolCall[];
	toolCallId?: string;
	toolResultIsError?: boolean;
	images?: { base64Data: string; mimeType: string }[];
	thinking?: string;
	signature?: string;
	signatureType?: string;
	thinkingRedacted?: boolean;
}

interface DevinDeltaFrame {
	messageId?: string;
	deltaText?: string;
	deltaThinking?: string;
	deltaSignature?: string;
	thinkingRedacted?: boolean;
	deltaToolCalls?: DevinChatToolCall[];
	stopReason?: string;
	actualModelUid?: string;
	usage?: {
		inputTokens?: string | number;
		outputTokens?: string | number;
		cacheReadTokens?: string | number;
		cacheWriteTokens?: string | number;
		modelUid?: string;
	};
	creditCost?: number;
	committedCreditCost?: number;
	committedAcuCost?: number;
}

const CHAT_SOURCE_USER = "CHAT_MESSAGE_SOURCE_USER";
const CHAT_SOURCE_SYSTEM = "CHAT_MESSAGE_SOURCE_SYSTEM";
const CHAT_SOURCE_TOOL = "CHAT_MESSAGE_SOURCE_TOOL";

// --- Helpers -----------------------------------------------------------------

/** Deterministic UUID (v5-style, seeded) so replayed messages keep stable ids. */
function deterministicUuid(seed: string): string {
	const hash = createHash("sha256").update(seed).digest();
	hash[6] = (hash[6] & 0x0f) | 0x50;
	hash[8] = (hash[8] & 0x3f) | 0x80;
	const hex = hash.subarray(0, 16).toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (part?.type === "text" && typeof part.text === "string") text += part.text;
	}
	return text;
}

function messageImages(content: unknown): { base64Data: string; mimeType: string }[] {
	if (!Array.isArray(content)) return [];
	const images: { base64Data: string; mimeType: string }[] = [];
	for (const part of content) {
		if (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			images.push({ base64Data: part.data, mimeType: part.mimeType });
		}
	}
	return images;
}

function buildUserPrompt(message: { content: unknown }, messageId: string): DevinChatMessagePrompt {
	return {
		messageId,
		source: CHAT_SOURCE_USER,
		prompt: messageText(message.content),
		images: messageImages(message.content),
	};
}

/**
 * Map pizza history onto Cascade prompts. Assistant turns replay as SYSTEM
 * messages (with thinking+signature round-trip); tool results replay as TOOL
 * messages keyed by `toolCallId`.
 */
function buildChatMessagePrompts(messages: Context["messages"], cascadeId: string, model: Model<Api>): DevinChatMessagePrompt[] {
	const prompts: DevinChatMessagePrompt[] = [];
	for (const [index, message] of messages.entries()) {
		if (message.role === "user") {
			prompts.push(buildUserPrompt(message, deterministicUuid(`${cascadeId}${index}user`)));
		} else if (message.role === "assistant") {
			const isNativeDevinMessage =
				message.api === model.api && message.provider === model.provider && message.model === model.id;
			let promptText = "";
			let thinkingText = "";
			let signature = "";
			let thinkingRedacted = false;
			const toolCalls: DevinChatToolCall[] = [];
			for (const part of message.content) {
				if (part.type === "text") {
					promptText += part.text;
				} else if (part.type === "thinking") {
					thinkingText += part.thinking;
					if (isNativeDevinMessage && !signature && part.thinkingSignature) signature = part.thinkingSignature;
					if (part.redacted) thinkingRedacted = true;
				} else if (part.type === "toolCall") {
					toolCalls.push({ id: part.id, name: part.name, argumentsJson: JSON.stringify(part.arguments) });
				}
			}
			if (!promptText && !thinkingText && !signature && toolCalls.length === 0) continue;
			prompts.push({
				messageId:
					isNativeDevinMessage && message.responseId
						? message.responseId
						: `bot-${deterministicUuid(`${cascadeId}${index}assistant`)}`,
				source: CHAT_SOURCE_SYSTEM,
				prompt: promptText,
				thinking: thinkingText,
				signature,
				signatureType: "",
				toolCalls,
				...(thinkingRedacted ? { thinkingRedacted: true } : {}),
			});
		} else {
			prompts.push({
				messageId: deterministicUuid(`${cascadeId}${index}tool${message.toolCallId}`),
				source: CHAT_SOURCE_TOOL,
				toolCallId: message.toolCallId,
				toolResultIsError: message.isError,
				prompt: messageText(message.content),
				images: messageImages(message.content),
			});
		}
	}
	return prompts;
}

/** Whether a model uid is a server-side router that needs AssignModel. */
function isRouterModelUid(uid: string): boolean {
	return uid === "adaptive" || uid.startsWith("fusion-") || uid.startsWith("MODEL_ROUTER");
}

/**
 * Lead chat uid of a Fusion pairing `fusion-<lead>[-fast]-sidekick-<sidekick>`,
 * or undefined when the uid is not a pairing.
 */
function fusionLeadUid(uid: string): string | undefined {
	if (!uid.startsWith("fusion-")) return undefined;
	const cut = uid.indexOf("-sidekick-");
	if (cut <= "fusion-".length) return undefined;
	return uid.slice("fusion-".length, cut);
}

interface ModelAssignment {
	assignmentJwt?: string;
	modelUid?: string;
}

/** Resolve a router uid to a concrete model + assignment JWT for this turn. */
async function assignModel(
	baseUrl: string,
	apiKey: string,
	routerUid: string,
	cascadeId: string,
	lastUserPrompt: DevinChatMessagePrompt | undefined,
	signal: AbortSignal | undefined,
	fetchImpl: typeof fetch,
): Promise<ModelAssignment> {
	const response = await connectUnaryJson<{ assignment?: ModelAssignment }>(
		baseUrl,
		ASSIGN_MODEL_PATH,
		{
			metadata: devinChatMetadata(apiKey),
			modelRouterUid: routerUid,
			cascadeId,
			chatMessagePrompt: lastUserPrompt,
		},
		{ signal, fetch: fetchImpl },
	);
	if (!response.assignment?.assignmentJwt || !response.assignment.modelUid) {
		throw new Error("Devin AssignModel error: response carried no assignment JWT or model uid");
	}
	return response.assignment;
}

// --- streamSimple ------------------------------------------------------------

export function devinStreamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
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
		stopReason: "pending",
		timestamp: Date.now(),
	};

	(async () => {
		let currentText: { type: "text"; text: string } | undefined;
		let currentThinking: ThinkingContent | undefined;
		const toolBlocks = new Map<string, ToolCall>();
		const toolPartialJson = new Map<string, string>();
		const blockIndices = new Map<object, number>();
		let activeToolCallId: string | undefined;
		let latestStopReason: string | undefined;

		const pushStart = () => stream.push({ type: "start", partial: output });
		const endText = () => {
			if (!currentText) return;
			const block = currentText;
			currentText = undefined;
			stream.push({ type: "text_end", contentIndex: blockIndices.get(block)!, content: block.text, partial: output });
		};
		const endThinking = () => {
			if (!currentThinking) return;
			const block = currentThinking;
			currentThinking = undefined;
			stream.push({ type: "thinking_end", contentIndex: blockIndices.get(block)!, content: block.thinking, partial: output });
		};

		try {
			const fetchImpl = options?.fetch ?? fetch;
			const baseUrl = (model.baseUrl || DEVIN_DEFAULT_API_SERVER_URL).replace(/\/+$/, "");
			const apiKey = normalizeDevinSessionToken(options?.apiKey ?? "");
			if (!apiKey || apiKey === "devin-session-token$") {
				throw new Error('No Devin credential. Run "pizza auth login --provider devin" first.');
			}

			const cascadeId = options?.sessionId ?? randomUUID();
			const prompts = buildChatMessagePrompts(context.messages, cascadeId, model);
			let chatModelUid = model.id;
			let modelAssignmentJwt: string | undefined;
			if (isRouterModelUid(chatModelUid)) {
				const lastUserPrompt = prompts.filter((p) => p.source === CHAT_SOURCE_USER).at(-1);
				const assignment = await assignModel(
					baseUrl,
					apiKey,
					fusionLeadUid(chatModelUid) ?? chatModelUid,
					cascadeId,
					lastUserPrompt,
					options?.signal,
					fetchImpl,
				);
				chatModelUid = assignment.modelUid!;
				modelAssignmentJwt = assignment.assignmentJwt;
				output.responseModel = chatModelUid;
			}

			let request: Record<string, unknown> = {
				metadata: devinChatMetadata(apiKey, { sessionId: cascadeId }),
				prompt: context.systemPrompt ?? "",
				chatMessagePrompts: prompts,
				chatModelUid,
				...(modelAssignmentJwt ? { modelAssignmentJwt } : {}),
				requestType: "CHAT_MESSAGE_REQUEST_TYPE_CASCADE",
				plannerMode: "CONVERSATIONAL_PLANNER_MODE_DEFAULT",
				toolChoice: { optionName: "auto" },
				systemPromptCacheOptions: { type: "CACHE_CONTROL_TYPE_EPHEMERAL" },
				disableParallelToolCalls:
					(model as { compat?: { supportsParallelToolCalls?: boolean } }).compat
						?.supportsParallelToolCalls === false,
				cascadeId,
				executionId: randomUUID(),
				configuration: {
					numCompletions: 1,
					maxTokens: options?.maxTokens ?? model.maxTokens ?? 64000,
					maxNewlines: 200,
					temperature: options?.temperature ?? 0.4,
					firstTemperature: options?.temperature ?? 0.4,
					topK: 50,
					topP: 1,
					fimEotProbThreshold: 1,
				},
				tools: (context.tools ?? []).map((tool) => ({
					name: tool.name,
					description: tool.description,
					jsonSchemaString: JSON.stringify(tool.parameters),
					strict: false,
				})),
			};
			const replacement = await options?.onPayload?.(request, model);
			if (replacement !== undefined) request = replacement as Record<string, unknown>;

			pushStart();

			for await (const frame of connectStreamJson<DevinDeltaFrame>(baseUrl, GET_CHAT_MESSAGE_PATH, request, {
				signal: options?.signal,
				fetch: fetchImpl,
				headers: options?.headers,
			})) {
				if (frame.messageId && !output.responseId) output.responseId = frame.messageId;
				if (frame.actualModelUid) output.responseModel = frame.actualModelUid;

				if (frame.deltaThinking) {
					if (!currentThinking) {
						currentThinking = { type: "thinking", thinking: "" };
						blockIndices.set(currentThinking, output.content.push(currentThinking) - 1);
						stream.push({ type: "thinking_start", contentIndex: blockIndices.get(currentThinking)!, partial: output });
					}
					currentThinking.thinking += frame.deltaThinking;
					if (frame.deltaSignature) currentThinking.thinkingSignature = frame.deltaSignature;
					stream.push({
						type: "thinking_delta",
						contentIndex: blockIndices.get(currentThinking)!,
						delta: frame.deltaThinking,
						partial: output,
					});
				}
				if (frame.deltaSignature && currentThinking && !currentThinking.thinkingSignature) {
					currentThinking.thinkingSignature = frame.deltaSignature;
				}
				if (frame.thinkingRedacted && currentThinking) currentThinking.redacted = true;

				if (frame.deltaText) {
					endThinking();
					if (!currentText) {
						currentText = { type: "text", text: "" };
						blockIndices.set(currentText, output.content.push(currentText) - 1);
						stream.push({ type: "text_start", contentIndex: blockIndices.get(currentText)!, partial: output });
					}
					currentText.text += frame.deltaText;
					stream.push({
						type: "text_delta",
						contentIndex: blockIndices.get(currentText)!,
						delta: frame.deltaText,
						partial: output,
					});
				}

				if (frame.deltaToolCalls?.length) {
					endText();
					endThinking();
					for (const tc of frame.deltaToolCalls) {
						const toolCallId = tc.id || activeToolCallId;
						if (!toolCallId) continue;
						let block = toolBlocks.get(toolCallId);
						if (!block) {
							block = { type: "toolCall", id: toolCallId, name: tc.name ?? "", arguments: {} };
							blockIndices.set(block, output.content.push(block) - 1);
							toolBlocks.set(toolCallId, block);
							toolPartialJson.set(toolCallId, "");
							stream.push({
								type: "toolcall_start",
								contentIndex: blockIndices.get(block)!,
								partial: output,
							});
						}
						if (tc.name) block.name = tc.name;
						activeToolCallId = toolCallId;
						if (!tc.argumentsJson) continue;
						// argumentsJson may arrive cumulative (full buffer) or as deltas.
						const previousJson = toolPartialJson.get(toolCallId) ?? "";
						const accumulated = tc.argumentsJson.startsWith(previousJson)
							? tc.argumentsJson
							: previousJson + tc.argumentsJson;
						const delta = accumulated.slice(previousJson.length);
						toolPartialJson.set(toolCallId, accumulated);
						stream.push({
							type: "toolcall_delta",
							contentIndex: blockIndices.get(block)!,
							delta,
							partial: output,
						});
					}
				}

				if (frame.stopReason) latestStopReason = frame.stopReason;

				if (frame.usage) {
					output.usage.input = Number(frame.usage.inputTokens ?? 0);
					output.usage.output = Number(frame.usage.outputTokens ?? 0);
					output.usage.cacheRead = Number(frame.usage.cacheReadTokens ?? 0);
					output.usage.cacheWrite = Number(frame.usage.cacheWriteTokens ?? 0);
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
				}
			}

			endText();
			endThinking();
			for (const [id, block] of toolBlocks) {
				const raw = toolPartialJson.get(id) ?? "";
				try {
					block.arguments = raw ? JSON.parse(raw) : {};
				} catch {
					block.arguments = { __invalid_json__: raw };
				}
				stream.push({ type: "toolcall_end", contentIndex: blockIndices.get(block)!, toolCall: block, partial: output });
			}

			const doneReason =
				toolBlocks.size > 0 ? "toolUse" : latestStopReason === "STOP_REASON_MAX_TOKENS" ? "length" : "stop";
			output.stopReason = doneReason;
			stream.push({ type: "done", reason: doneReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}
