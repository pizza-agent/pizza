/**
 * Agent Types — pizza's own message / tool / state model.
 *
 * Built on top of pi-ai's primitives (`UserMessage`, `AssistantMessage`,
 * `ToolResultMessage`, `Tool`, `Model`) without carrying the old standalone
 * agent-core package boundary.
 *
 * This module is the new canonical home for agent shape definitions.
 * Callers should import from here.
 */

import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	streamSimple,
	TextContent,
	ThinkingLevel as AiThinkingLevel,
	Tool,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai/compat";
import type { Static, TSchema } from "@sinclair/typebox";

// ============================================================================
// Re-exports of pi-ai primitives so downstream code has one canonical import
// ============================================================================

export type {
	AssistantMessage,
	AssistantMessageEvent,
	ImageContent,
	Message,
	Model,
	TextContent,
	Tool,
	ToolResultMessage,
	UserMessage,
};

// ============================================================================
// Tool execution mode
// ============================================================================

/** Controls whether a tool runs sequentially or in parallel with other tool calls. */
export type ToolExecutionMode = "sequential" | "parallel";

// ============================================================================
// Thinking levels (Pizza's extension; includes "off" which pi-ai doesn't have)
// ============================================================================

export type ThinkingLevel = "off" | AiThinkingLevel;

// ============================================================================
// Custom message types — pizza-specific roles that flow alongside LLM messages
// ============================================================================

/** A bash execution message (recorded by the runtime, not produced by the LLM). */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	/** Combined stdout+stderr output. */
	output: string;
	exitCode: number | undefined;
	/** Whether the command was cancelled/aborted. */
	cancelled: boolean;
	/** Whether the output was truncated. */
	truncated: boolean;
	timestamp: number;
	/** Path to full output file when truncated. */
	fullOutputPath?: string;
	/** Whether to exclude from LLM context. */
	excludeFromContext?: boolean;
	/** Separated stdout (when available). */
	stdout?: string;
	/** Separated stderr (when available). */
	stderr?: string;
}

/** A summary inserted by compaction. */
export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

/** A branch summary inserted when switching branches. */
export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	/** Source branch/entry id. */
	fromId?: string;
	timestamp: number;
}

/** A custom extension-provided message. Generic over the structured payload type. */
export interface CustomMessage<T = unknown> {
	role: "custom";
	/** Discriminator for the extension to identify its own custom messages. */
	customType: string;
	/** Content visible to the LLM when this message is included in context. */
	content: string | (TextContent | ImageContent)[];
	/** Optional UI-only display text or boolean flag. */
	display?: string | boolean;
	/** Arbitrary structured payload for tooling / persistence. */
	details?: T;
	timestamp: number;
}

// ============================================================================
// AgentMessage — the union of everything that can appear in a session timeline
// ============================================================================

export type AgentMessage =
	| Message
	| BashExecutionMessage
	| CompactionSummaryMessage
	| BranchSummaryMessage
	| CustomMessage;

// ============================================================================
// Agent tools — wraps pi-ai's `Tool` with an execute callback
// ============================================================================

/** Tool execution result returned to the LLM. */
export interface AgentToolResult<T = unknown> {
	/** Text or image content returned to the model. */
	content: (TextContent | ImageContent)[];
	/** Optional structured payload for logs/UI. */
	details?: T;
}

/** Optional streaming-update callback. */
export type AgentToolUpdateCallback<T = unknown> = (partial: AgentToolResult<T>) => void;

/** Pizza's tool definition. */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = unknown>
	extends Tool<TParameters> {
	/** Controls whether a tool runs sequentially or in parallel with other tool calls. */
	executionMode?: ToolExecutionMode;
	/** Optional shim for raw tool-call arguments before schema validation. */
	prepareArguments?: (args: unknown) => Static<TParameters>;
	/** Resolve a call once before approval (classifier / tool_call hook / execute share it). */
	resolve?: (args: Static<TParameters>, toolCallId: string) => import("../intent/types.js").ResolvedToolCall | undefined;
	/** Execute the tool call. Throw on failure. */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
}

// ============================================================================
// Agent state — read-only snapshot the runtime exposes to UI / extensions
// ============================================================================

export interface AgentState {
	/** System prompt sent with each model request. */
	systemPrompt: string;
	/** Active model used for future turns. */
	model: Model<any> | undefined;
	/** Requested reasoning level for future turns. */
	thinkingLevel: ThinkingLevel;
	/** Available tools. */
	tools: AgentTool<any>[];
	/** Conversation transcript. */
	messages: AgentMessage[];
	/** True while the agent is processing a prompt. */
	isStreaming: boolean;
	/** Tool call ids currently executing. */
	pendingToolCalls: ReadonlySet<string>;
	/** Error message from the most recent failed turn. */
	errorMessage?: string;
}

// ============================================================================
// Helpers
// ============================================================================

/** Type guard: is this a pi-ai LLM message (user / assistant / toolResult)? */
export function isLlmMessage(msg: AgentMessage): msg is Message {
	return msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult";
}

/** Filter pizza-specific messages, keep only those the LLM can consume. */
export function toLlmMessages(messages: AgentMessage[]): Message[] {
	const out: Message[] = [];
	for (const m of messages) {
		if (isLlmMessage(m)) {
			out.push(m);
		} else if (m.role === "compactionSummary" || m.role === "branchSummary") {
			// Inject summaries as a user message so the LLM sees them.
			out.push({
				role: "user",
				content: `[Previous context summary]\n${m.summary}`,
				timestamp: m.timestamp,
			});
		} else if (m.role === "bashExecution") {
			out.push({
				role: "user",
				content:
					`[Bash command executed]\n$ ${m.command}\n` +
					(m.output ? `output:\n${m.output}\n` : "") +
					`exit code: ${m.exitCode}`,
				timestamp: m.timestamp,
			});
		} else if (m.role === "custom") {
			out.push({
				role: "user",
				content: m.content,
				timestamp: m.timestamp,
			});
		}
	}
	return out;
}

// ============================================================================
// AgentEvent — the event union emitted by the agent runtime during execution
// ============================================================================

/** Events emitted during agent execution. */
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };

// ============================================================================
// Agent loop / runtime support types — used by `agent-loop.ts` & `agent.ts`
// ============================================================================

/**
 * Stream function used by the agent loop.
 *
 * Mirrors pi-ai's `streamSimple` shape so that pi-ai can be plugged in directly.
 */
export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;

/** A single tool-call content block emitted by an assistant message. */
export type AgentToolCall = Extract<
	AssistantMessage["content"][number],
	{ type: "toolCall" }
>;

/** Result returned from `beforeToolCall`. */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

/** Partial override returned from `afterToolCall`. */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
}

/** Context passed to `beforeToolCall`. */
export interface BeforeToolCallContext {
	assistantMessage: AssistantMessage;
	toolCall: AgentToolCall;
	args: unknown;
	context: AgentContext;
}

/** Context passed to `afterToolCall`. */
export interface AfterToolCallContext {
	assistantMessage: AssistantMessage;
	toolCall: AgentToolCall;
	args: unknown;
	result: AgentToolResult<any>;
	isError: boolean;
	context: AgentContext;
}

/** Context snapshot passed into the low-level agent loop. */
export interface AgentContext {
	systemPrompt: string;
	messages: AgentMessage[];
	tools?: AgentTool<any>[];
}

/** Configuration for one agent loop run. */
export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	getSteeringMessages?: () => Promise<AgentMessage[]>;
	getFollowUpMessages?: () => Promise<AgentMessage[]>;
	toolExecution?: ToolExecutionMode;
	beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
}

// Re-export Context for downstream typing convenience
export type { Context };
