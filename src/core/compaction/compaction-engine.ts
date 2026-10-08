/**
 * Event-sourced compaction engine.
 *
 * Builds compaction summaries directly from EventStore projections. It never
 * mutates or deletes old events; callers record the returned first_kept_event_id
 * on COMPACTION_END so projections can ignore the summarized prefix.
 */

import type { AgentMessage } from "../agent/types.js";
import type { EventBase } from "../event-store/types.js";
import type { EventStore } from "../event-store/store.js";
import { convertToLlm } from "../messages.js";
import { eventToMessage } from "../projection/event-to-message.js";
import type { SessionProjection } from "../projection/session-projection.js";
import type { LLMClient, ModelConfig, LLMResponse } from "../runtime/llm-types.js";
import type { CompactionOutcome, CompactionPolicy, CompactionReason } from "../runtime/policies.js";
import { serializeConversation, SUMMARIZATION_SYSTEM_PROMPT } from "./utils.js";
import { DEFAULT_MASK_MIN_CHARS, maskToolResultEvents } from "./tool-result-masking.js";

/**
 * - "mask": only replace old tool results with placeholders (no LLM call).
 * - "summary": only LLM summarization (drops the summarized prefix).
 * - "hybrid": mask first; fall back to summary if masking alone doesn't get
 *   the context comfortably below the threshold.
 */
export type CompactionStrategy = "mask" | "summary" | "hybrid";

export interface CompactionEngineSettings {
	/** Estimated active model context window. */
	contextWindow?: number;
	/** Reserve this many tokens for future turns. */
	reserveTokens?: number;
	/** Keep roughly this many recent tokens verbatim after compaction. */
	keepRecentTokens?: number;
	/** Optional custom threshold. Defaults to (contextWindow - reserveTokens) / contextWindow. */
	threshold?: number;
	/** Compaction strategy. Default "hybrid". */
	strategy?: CompactionStrategy;
	/** Tool results shorter than this (chars) are never masked. Default 500. */
	maskMinChars?: number;
	/**
	 * hybrid: masking is accepted only if it brings the context to at most
	 * threshold tokens × this ratio, leaving headroom so the next turn doesn't
	 * immediately re-trigger compaction (and break the prompt cache again). Default 0.8.
	 */
	maskTargetRatio?: number;
}

export interface CompactionEngineConfig {
	store: EventStore;
	projection: SessionProjection;
	llmClient: LLMClient;
	model: ModelConfig;
	systemPrompt?: string;
	settings?: CompactionEngineSettings;
}

type EventMessagePair = {
	event: EventBase;
	message: AgentMessage;
};

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_RESERVE_TOKENS = 16384;
const DEFAULT_KEEP_RECENT_TOKENS = 20000;
const DEFAULT_MASK_TARGET_RATIO = 0.8;

/**
 * Ratio threshold above which a provider-reported usage is considered stale.
 * See compaction.ts for the full rationale.
 */
const STALE_USAGE_RATIO = 1.5;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export class CompactionEngine implements CompactionPolicy {
	constructor(private config: CompactionEngineConfig) {}

	estimateContextTokens(): number {
		return estimateMessagesTokens(this.config.projection.buildContext().messages);
	}

	contextWindow(): number {
		return this.config.settings?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
	}

	threshold(): number {
		if (this.config.settings?.threshold !== undefined) return this.config.settings.threshold;
		const window = this.contextWindow();
		if (!Number.isFinite(window) || window <= 0) return 1;
		const reserve = this.config.settings?.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
		return Math.max(0, Math.min(1, (window - reserve) / window));
	}

	isOverflow(lastAssistantMessageEvent: EventBase | undefined): boolean {
		if (!lastAssistantMessageEvent || lastAssistantMessageEvent.type !== "AGENT_MESSAGE_END") return false;
		const payload = lastAssistantMessageEvent.payload as { stop_reason?: string; error_message?: string };
		if (payload.stop_reason !== "error") return false;
		return /context.?length|context.?window|maximum.?context|token.?limit|too.?many.?tokens/i.test(
			payload.error_message ?? "",
		);
	}

	async compact(reason: CompactionReason, signal: AbortSignal): Promise<CompactionOutcome> {
		const built = this.config.projection.buildContext();
		const pairs = built.events
			.map((event): EventMessagePair | undefined => {
				const message = eventToMessage(event);
				return message ? { event, message } : undefined;
			})
			.filter((pair): pair is EventMessagePair => pair !== undefined);

		const previousCompactionIndex = findLastIndex(pairs, (pair) => pair.event.type === "COMPACTION_END");
		const previousSummary =
			previousCompactionIndex >= 0 ? (pairs[previousCompactionIndex]!.message as { summary?: string }).summary : undefined;
		const startIndex = previousCompactionIndex >= 0 ? previousCompactionIndex + 1 : 0;
		const compactablePairs = pairs.slice(startIndex);
		if (compactablePairs.length < 2) {
			throw new Error("Nothing to compact");
		}

		const keepRecentTokens = this.config.settings?.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
		const tokensBefore = estimateMessagesTokens(built.messages);
		const strategy = this.config.settings?.strategy ?? "hybrid";
		if (strategy !== "summary") {
			const masked = this._maskToolResults(compactablePairs, keepRecentTokens, tokensBefore);
			if (strategy === "mask") {
				if (!masked) throw new Error("Nothing to compact");
				return masked;
			}
			if (masked && masked.tokens_after! <= this._maskTargetTokens()) return masked;
		}

		const cutIndex = findCutIndex(compactablePairs, keepRecentTokens);
		if (cutIndex <= 0 || cutIndex >= compactablePairs.length) {
			throw new Error("Nothing to compact");
		}

		const messagesToSummarize = compactablePairs.slice(0, cutIndex).map((pair) => pair.message);
		const keptPairs = compactablePairs.slice(cutIndex);
		const firstKeptEvent = keptPairs[0]?.event;
		if (!firstKeptEvent) {
			throw new Error("Unable to determine first kept event");
		}

		const summary = await this._generateSummary(messagesToSummarize, previousSummary, signal);
		const tokensAfter = estimateMessageTokens({
			role: "compactionSummary",
			summary,
			tokensBefore,
			timestamp: Date.now(),
		}) + estimateMessagesTokens(keptPairs.map((pair) => pair.message));

		return {
			summary,
			first_kept_event_id: firstKeptEvent.event_id,
			tokens_before: tokensBefore,
			tokens_after: tokensAfter,
		};
	}

	private _maskTargetTokens(): number {
		const ratio = this.config.settings?.maskTargetRatio ?? DEFAULT_MASK_TARGET_RATIO;
		return this.contextWindow() * this.threshold() * ratio;
	}

	/** Tier 1: mask tool results older than the keepRecentTokens window. Undefined if nothing to mask. */
	private _maskToolResults(
		pairs: EventMessagePair[],
		keepRecentTokens: number,
		tokensBefore: number,
	): CompactionOutcome | undefined {
		const boundaryIndex = findRecentBoundaryIndex(pairs, keepRecentTokens);
		if (boundaryIndex <= 0) return undefined;
		const boundary = pairs[boundaryIndex]!.event;
		const minChars = this.config.settings?.maskMinChars ?? DEFAULT_MASK_MIN_CHARS;
		const events = pairs.map((pair) => pair.event);
		const maskedEvents = maskToolResultEvents(events, boundary.sequence, minChars);

		let maskedCount = 0;
		let savedTokens = 0;
		maskedEvents.forEach((event, i) => {
			if (event === events[i]) return;
			const maskedMessage = eventToMessage(event);
			maskedCount++;
			savedTokens += estimateMessageTokens(pairs[i]!.message) - (maskedMessage ? estimateMessageTokens(maskedMessage) : 0);
		});
		if (maskedCount === 0) return undefined;

		return {
			mode: "mask",
			summary: `Cleared ${maskedCount} old tool result(s), saving ~${savedTokens} tokens`,
			first_kept_event_id: pairs[0]!.event.event_id,
			mask_before_event_id: boundary.event_id,
			mask_min_chars: minChars,
			masked_count: maskedCount,
			tokens_before: tokensBefore,
			tokens_after: Math.max(0, tokensBefore - savedTokens),
		};
	}

	private async _generateSummary(
		messages: AgentMessage[],
		previousSummary: string | undefined,
		signal: AbortSignal,
	): Promise<string> {
		const conversationText = serializeConversation(convertToLlm(messages));
		let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
		if (previousSummary) {
			promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
		}
		promptText += previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;

		const response = await this.config.llmClient.complete({
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: promptText }],
					timestamp: Date.now(),
				},
			],
			systemPrompt: this.config.systemPrompt ?? SUMMARIZATION_SYSTEM_PROMPT,
			model: this.config.model,
			tools: [],
			signal,
		});

		if (response.stopReason === "error") {
			throw new Error(`Summarization failed: ${response.errorMessage ?? "Unknown error"}`);
		}

		const summary = extractText(response);
		if (!summary.trim()) {
			throw new Error("Summarization produced an empty summary");
		}
		return summary;
	}
}

function findCutIndex(pairs: EventMessagePair[], keepRecentTokens: number): number {
	const validCutIndexes = pairs
		.map((pair, index) => (isValidCutMessage(pair.message) ? index : -1))
		.filter((index) => index >= 0);
	if (validCutIndexes.length === 0) return -1;

	let accumulatedTokens = 0;
	let cutIndex = validCutIndexes[0]!;
	for (let i = pairs.length - 1; i >= 0; i--) {
		accumulatedTokens += estimateMessageTokens(pairs[i]!.message);
		if (accumulatedTokens >= keepRecentTokens) {
			cutIndex = validCutIndexes.find((index) => index >= i) ?? validCutIndexes[validCutIndexes.length - 1]!;
			break;
		}
	}

	return cutIndex;
}

/**
 * Index of the oldest event kept inside the keepRecentTokens window (the event
 * that overflows the budget falls outside it), or -1 if everything fits.
 * The newest event is always kept.
 */
function findRecentBoundaryIndex(pairs: EventMessagePair[], keepRecentTokens: number): number {
	let accumulatedTokens = 0;
	for (let i = pairs.length - 1; i >= 0; i--) {
		accumulatedTokens += estimateMessageTokens(pairs[i]!.message);
		if (accumulatedTokens >= keepRecentTokens) return Math.min(i + 1, pairs.length - 1);
	}
	return -1;
}

function isValidCutMessage(message: AgentMessage): boolean {
	return (
		message.role === "user" ||
		message.role === "bashExecution" ||
		message.role === "custom" ||
		message.role === "branchSummary"
	);
}

function extractText(response: LLMResponse): string {
	return response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	const usageInfo = findLastAssistantUsage(messages);
	if (!usageInfo) {
		return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
	}

	// Detect stale usage: if our char/4 estimate of the prefix messages
	// significantly exceeds the provider-reported total, the message list has
	// grown beyond what the provider saw (e.g. after a session fork). Fall back
	// to full estimation to avoid underestimating context size.
	let prefixEstimatedTokens = 0;
	for (let i = 0; i <= usageInfo.index; i++) {
		prefixEstimatedTokens += estimateMessageTokens(messages[i]!);
	}

	if (prefixEstimatedTokens > usageInfo.totalTokens * STALE_USAGE_RATIO) {
		let trailingTokens = 0;
		for (let i = usageInfo.index + 1; i < messages.length; i++) {
			trailingTokens += estimateMessageTokens(messages[i]!);
		}
		return prefixEstimatedTokens + trailingTokens;
	}

	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateMessageTokens(messages[i]!);
	}
	return usageInfo.totalTokens + trailingTokens;
}

function findLastAssistantUsage(messages: AgentMessage[]): { totalTokens: number; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as AgentMessage & {
			usage?: {
				totalTokens?: number;
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
			};
			stopReason?: string;
		};
		if (message.role !== "assistant" || !message.usage) continue;
		if (message.stopReason === "aborted" || message.stopReason === "error") continue;
		const usage = message.usage;
		return {
			totalTokens:
				usage.totalTokens ??
				(usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
			index: i,
		};
	}
	return undefined;
}

function estimateMessageTokens(message: AgentMessage): number {
	let chars = 0;
	switch (message.role) {
		case "user":
		case "custom":
		case "toolResult":
			chars = estimateContentChars(message.content);
			break;
		case "assistant":
			for (const block of message.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			break;
		case "bashExecution":
			chars = message.command.length + message.output.length;
			break;
		case "branchSummary":
		case "compactionSummary":
			chars = message.summary.length;
			break;
	}
	return Math.ceil(chars / 4);
}

function estimateContentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) {
		if (!block || typeof block !== "object" || !("type" in block)) continue;
		if (block.type === "text" && "text" in block && typeof block.text === "string") {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += 4800;
		}
	}
	return chars;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
	for (let i = items.length - 1; i >= 0; i--) {
		if (predicate(items[i]!)) return i;
	}
	return -1;
}
