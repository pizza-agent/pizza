/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import type { AgentMessage } from "../agent/types.js";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "../types/session-types.js";
import type { FileOperations } from "./utils.js";

// ============================================================================
// File Operation Tracking
// ============================================================================

/** Details stored in CompactionEntry.details for file tracking */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
}

// ============================================================================
// Types
// ============================================================================

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 10000,
};

// ============================================================================
// Token calculation
// ============================================================================

/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted and error messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last non-aborted assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * Ratio threshold above which a provider-reported usage is considered stale.
 *
 * After a session fork or switch, the message list may include messages from a
 * different context. The last assistant usage's totalTokens reflects the context
 * size at the time of that call, not the current (larger) context. If our
 * char/4 estimate of the prefix messages exceeds the reported usage by more than
 * this factor, the usage is unreliable and we fall back to full estimation.
 *
 * The 1.5x factor accounts for the inherent inaccuracy of the chars/4 heuristic
 * compared to the provider's tokenizer (can differ by ~30-40% for non-English
 * text or efficient tokenizers).
 */
const STALE_USAGE_RATIO = 1.5;

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 *
 * Falls back to full char/4 estimation when the provider-reported usage appears stale
 * (e.g. after a session fork that merged in messages from a different context).
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	// A compaction/branch summary whose timestamp is >= the last assistant
	// message's means that usage was recorded BEFORE the summary was written
	// — its totalTokens describe the pre-compaction context, not the current
	// one. The kept assistant messages sit after the summary in the flattened
	// list, so index comparisons can't see this; timestamps can (>= because
	// same-millisecond appends are common in fast sequences). Fall back to
	// full estimation (summary + prefix + kept pairs) so the UI stops
	// reporting the pre-compaction size after a compact.
	if (usageInfo) {
		const usageTs = messages[usageInfo.index]!.timestamp;
		for (const m of messages) {
			if ((m.role === "compactionSummary" || m.role === "branchSummary") && m.timestamp >= usageTs) {
				let estimated = 0;
				for (const msg of messages) estimated += estimateTokens(msg);
				return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, lastUsageIndex: null };
			}
		}
	}

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);

	// Detect stale usage: estimate the tokens of all messages up to and including
	// the usage point. If the estimate significantly exceeds the reported usage,
	// the message list has grown beyond what the provider saw (e.g. after a fork).
	let prefixEstimatedTokens = 0;
	for (let i = 0; i <= usageInfo.index; i++) {
		prefixEstimatedTokens += estimateTokens(messages[i]);
	}

	if (prefixEstimatedTokens > usageTokens * STALE_USAGE_RATIO) {
		// Usage is stale — fall back to full estimation
		let estimated = prefixEstimatedTokens;
		for (let i = usageInfo.index + 1; i < messages.length; i++) {
			estimated += estimateTokens(messages[i]);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: usageInfo.index,
		};
	}

	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ============================================================================
// Cut point detection
// ============================================================================

/**
 * Estimate tokens in a string. ASCII is ~4 chars/token; CJK/emoji run
 * close to 1-2 chars/token, so a flat chars/4 halves or thirds the real
 * count on CJK-heavy sessions. Shared rule with the compaction engine.
 */
export function estimateStringTokens(text: string): number {
	let ascii = 0;
	let nonAscii = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) < 0x80) ascii++;
		else nonAscii++;
	}
	return Math.ceil(ascii / 4 + nonAscii / 1.5);
}

/**
 * Estimate token count for a message using a chars/token heuristic.
 * This is conservative (overestimates tokens).
 */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
			if (typeof content === "string") {
				return estimateStringTokens(content);
			} else if (Array.isArray(content)) {
				let tokens = 0;
				for (const block of content) {
					if (block.type === "text" && block.text) {
						tokens += estimateStringTokens(block.text);
					}
				}
				return tokens;
			}
			return 0;
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			let tokens = 0;
			for (const block of assistant.content) {
				if (block.type === "text") {
					tokens += estimateStringTokens(block.text);
				} else if (block.type === "thinking") {
					tokens += estimateStringTokens(block.thinking);
				} else if (block.type === "toolCall") {
					tokens += estimateStringTokens(block.name) + estimateStringTokens(JSON.stringify(block.arguments));
				}
			}
			return tokens;
		}
		case "custom":
		case "toolResult": {
			if (typeof message.content === "string") {
				return estimateStringTokens(message.content);
			}
			let tokens = 0;
			for (const block of message.content) {
				if (block.type === "text" && block.text) {
					tokens += estimateStringTokens(block.text);
				}
				if (block.type === "image") {
					tokens += 1200;
				}
			}
			return tokens;
		}
		case "bashExecution": {
			return estimateStringTokens(message.command) + estimateStringTokens(message.output);
		}
		case "branchSummary":
		case "compactionSummary": {
			return estimateStringTokens(message.summary);
		}
	}

	return 0;
}

/**
 * Find valid cut points: indices of user, assistant, custom, or bashExecution messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 * BashExecutionMessage is treated like a user message (user-initiated context).
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
			case "session_info":
				break;
		}

		// branch_summary and custom_message are user-role messages, valid cut points
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * Find the user message (or bashExecution) that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 * BashExecutionMessage is treated like a user message for turn boundaries.
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		// branch_summary and custom_message are user-role messages, can start a turn
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// Walk backwards from newest, accumulating estimated message sizes
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // Default: keep from first message (not header)

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;

		// Estimate this message's size
		const messageTokens = estimateTokens(entry.message);
		accumulatedTokens += messageTokens;

		// Check if we've exceeded the budget
		if (accumulatedTokens >= keepRecentTokens) {
			// Find the closest valid cut point at or after this entry
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}

	// Scan backwards from cutIndex to include any non-message entries (bash, settings, etc.)
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// Stop at session header or compaction boundaries
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			// Stop if we hit any message
			break;
		}
		// Include this non-message entry (bash, settings change, etc.)
		cutIndex--;
	}

	// Determine if this is a split turn
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}


// ============================================================================
// Compaction Preparation (for extensions)
// ============================================================================

export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	turnPrefixMessages: AgentMessage[];
	/** Whether this is a split turn (cut point in middle of turn) */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** Summary from previous compaction, for iterative update */
	previousSummary?: string;
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
}


