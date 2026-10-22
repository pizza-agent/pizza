/**
 * Session Domain Types
 *
 * Shared type definitions for the session entry model.
 * Extracted from the legacy SessionManager to allow its removal
 * while preserving the type contracts used by extensions, compaction, and export.
 */

import type { AgentMessage } from "../agent/types.js";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";

// ============================================================================
// Session Header
// ============================================================================

export interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

// ============================================================================
// Session Entries
// ============================================================================

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: T;
	fromHook?: boolean;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: T;
	fromHook?: boolean;
}

export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

/**
 * A display-only entry synthesized from the event-store timeline projection.
 * Used by the TUI session-tree selector (/history) which cannot reconstruct
 * full SessionEntry objects from the projection; carries the timeline kind
 * and a pre-computed human summary instead.
 */
export interface TimelineDisplayEntry extends SessionEntryBase {
	type: "timeline";
	kind: string;
	summary: string;
	durationMs?: number;
	metadata?: Record<string, unknown>;
}
export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry
	| TimelineDisplayEntry;

// ============================================================================
// Tree Node
// ============================================================================

export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	label?: string;
	labelTimestamp?: string;
}

// ============================================================================
// Session Context
// ============================================================================

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
}

// ============================================================================
// Readonly Session Manager Interface
// ============================================================================

/**
 * Read-only interface for session data access.
 * Implemented by EventStoreExtensionSessionManager and legacy SessionManager.
 */
export interface ReadonlySessionManager {
	getCwd(): string;
	getSessionDir(): string;
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	getLeafEntry(): SessionEntry | undefined;
	getEntry(entryId: string): SessionEntry | undefined;
	getLabel(entryId: string): string | undefined;
	getBranch(fromId?: string): SessionEntry[];
	getHeader(): SessionHeader;
	getEntries(): SessionEntry[];
	getTree(): SessionTreeNode[];
	getSessionName(): string | undefined;
}

// ============================================================================
// Session Info (for listing)
// ============================================================================

export interface SessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

export type SessionListProgress = (loaded: number, total: number) => void;

// ============================================================================
// Session Options
// ============================================================================

export interface NewSessionOptions {
	id?: string;
	parentSession?: string;
}
