/**
 * Reactor Policies
 *
 * Pluggable policy objects that customize reactor behavior without coupling
 * the reactor to heavy dependencies (SettingsManager, SessionManager, etc).
 *
 * Each policy is a small, testable strategy interface. Default implementations
 * cover the common cases; richer implementations may consult settings/session state.
 */

import type { EventBase } from "../event-store/types.js";

// ============================================================================
// Retry Policy
// ============================================================================

/** Decides whether and how to retry after an LLM call failure. */
export interface RetryPolicy {
	/** Is this error transient (retryable)? */
	isRetryable(error: { message: string; statusCode?: number }): boolean;
	/** Compute backoff delay for the given attempt (1-indexed). Return null to give up. */
	nextDelayMs(attempt: number): number | null;
	/** Maximum attempts before giving up. */
	maxAttempts: number;
}

/** Built-in retry policy: matches the patterns historically used by the reactor. */
export class DefaultRetryPolicy implements RetryPolicy {
	maxAttempts: number;
	private baseDelayMs: number;
	private capDelayMs: number;

	constructor(opts?: { maxAttempts?: number; baseDelayMs?: number; capDelayMs?: number }) {
		this.maxAttempts = opts?.maxAttempts ?? 3;
		this.baseDelayMs = opts?.baseDelayMs ?? 1000;
		this.capDelayMs = opts?.capDelayMs ?? 30000;
	}

	isRetryable(error: { message: string; statusCode?: number }): boolean {
		if (error.statusCode && [429, 500, 502, 503, 504].includes(error.statusCode)) return true;
		return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|5\d{2}|service.?unavailable|server.?error|internal.?error|network.?error|connection.?(error|refused|lost)|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|timed? out|timeout|terminated|retry delay/i.test(
			error.message,
		);
	}

	nextDelayMs(attempt: number): number | null {
		if (attempt > this.maxAttempts) return null;
		return Math.min(this.baseDelayMs * Math.pow(2, attempt - 1), this.capDelayMs);
	}
}

// ============================================================================
// Compaction Policy
// ============================================================================

/** Reason a compaction is being requested. */
export type CompactionReason = "manual" | "threshold" | "overflow";

/** A single compaction operation's outcome. */
export interface CompactionOutcome {
	/** Marker event_id from which the summarized context begins. */
	first_kept_event_id: string;
	/** LLM-produced summary text. */
	summary: string;
	/** Estimated tokens before compaction. */
	tokens_before: number;
	/** Estimated tokens after compaction (post-summary context). */
	tokens_after?: number;
	/** "summary" (default): LLM summary + prefix dropped. "mask": old tool results replaced by placeholders. */
	mode?: "summary" | "mask";
	/** mask mode: tool results before this event are masked. */
	mask_before_event_id?: string;
	/** mask mode: tool results shorter than this are kept verbatim. */
	mask_min_chars?: number;
	/** mask mode: number of tool results masked. */
	masked_count?: number;
}

/** Decides whether to compact, and how to compact when asked. */
export interface CompactionPolicy {
	/** Estimate current context token usage. Return 0 if unknown. */
	estimateContextTokens(): number;
	/** Context window size for the active model (used for threshold/overflow detection). */
	contextWindow(): number;
	/** Compaction threshold as a fraction of contextWindow (default 0.85 in real settings). */
	threshold(): number;
	/** Run the actual compaction. Should throw on failure. */
	compact(reason: CompactionReason, signal: AbortSignal): Promise<CompactionOutcome>;
	/** Was the just-finished assistant message an overflow signal? */
	isOverflow(lastAssistantMessageEvent: EventBase | undefined): boolean;
}

/** No-op compaction policy — useful for tests and the bare reactor. */
export class NoopCompactionPolicy implements CompactionPolicy {
	estimateContextTokens(): number { return 0; }
	contextWindow(): number { return Number.MAX_SAFE_INTEGER; }
	threshold(): number { return 1; }
	async compact(): Promise<CompactionOutcome> {
		throw new Error("Compaction not configured");
	}
	isOverflow(): boolean { return false; }
}
