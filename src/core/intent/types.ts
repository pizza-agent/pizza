/**
 * Intent Classification Types
 *
 * Defines the risk levels and categories for LLM-proposed tool calls.
 */

import type { FileMutation } from "../event-store/types.js";

// ============================================================================
// Intent Classification
// ============================================================================

/** Intent risk level */
export type IntentRisk = "safe" | "moderate" | "dangerous";

/** Intent category */
export type IntentCategory =
	| "file_read" // safe: read, ls, find, grep
	| "file_write" // moderate: write, edit
	| "file_delete" // dangerous: rm, unlink
	| "shell_safe" // safe: echo, cat, pwd
	| "shell_moderate" // moderate: npm install, git commit
	| "shell_dangerous" // dangerous: rm -rf, sudo, curl | bash
	| "network" // moderate: fetch, curl
	| "unknown"; // dangerous by default

/** Intent classification result */
export interface IntentClassification {
	risk: IntentRisk;
	/** Whether this intent requires user approval */
	requires_approval: boolean;
	category: IntentCategory;
	/** Files affected by this intent */
	affected_files?: string[];
	/** Human-readable description */
	description: string;
}

/**
 * Classification hint a tool declares for one call (e.g. the cli tool for a
 * resolved `_write`). The classifier still derives risk/requires_approval
 * from its own config; the hint only picks the category.
 */
export interface ToolCallIntent {
	category: IntentCategory;
	affectedFiles?: string[];
	description?: string;
	/** Approval gate for file_write: "edits" uses require_approval_edits (default: writes). */
	gate?: "writes" | "edits";
}

/** Structured command a tool call resolved to (cli: `_write` + parsed params). */
export interface ToolCallCommand {
	name: string;
	source: "builtin" | "extension" | "sdk" | "shell";
	params?: unknown;
}

/**
 * Result of resolving a tool call once, before approval. Shared by the
 * classifier, the `tool_call` hook, and execution so the same command is
 * never parsed differently by different consumers.
 */
export interface ResolvedToolCall {
	/** Undefined → classifier falls back to its own rules for the tool. */
	intent?: ToolCallIntent;
	command?: ToolCallCommand;
}

// ============================================================================
// Intent Execution
// ============================================================================

/** Tool execution result */
export interface ToolExecutionResult {
	content: Array<{ type: string; [key: string]: unknown }>;
	/** Optional structured payload for logs/UI. */
	details?: unknown;
	is_error: boolean;
	/** File mutations produced by this execution */
	file_mutations?: FileMutation[];
	/** Error message if is_error */
	error_message?: string;
}

/** Partial tool execution update emitted while a tool is running. */
export interface ToolExecutionUpdate {
	content: Array<{ type: string }>;
	details?: unknown;
	progress?: number;
}

/** Runtime-provided execution context for a tool call. */
export interface ToolExecutionOptions {
	tool_call_id?: string;
	signal?: AbortSignal;
	onUpdate?: (partial: ToolExecutionUpdate) => void;
}

/** Tool registry interface */
export interface ToolRegistry {
	get(name: string): ToolExecutor | undefined;
	list(): string[];
}

/** Tool executor interface */
export interface ToolExecutor {
	execute(args: Record<string, unknown>, options?: ToolExecutionOptions): Promise<ToolExecutionResult>;
	/** Resolve a call once before approval (see ResolvedToolCall). */
	resolve?(args: Record<string, unknown>, toolCallId: string): ResolvedToolCall | undefined;
	getMetadata(): ToolMetadata;
}

/** Tool metadata */
export interface ToolMetadata {
	name: string;
	description?: string;
	category: IntentCategory;
	defaultRisk: IntentRisk;
}

// ============================================================================
// Approval Handler
// ============================================================================

/** Approval handler for UI integration */
export interface ApprovalHandler {
	requestApproval(
		intentEventId: string,
		classification: IntentClassification,
		toolName?: string,
		args?: Record<string, unknown>,
	): void;
	cancelApproval(intentEventId: string): void;
}
