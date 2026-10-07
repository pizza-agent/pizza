/**
 * Agent-side RPC types — re-exports the dependency-free protocol types
 * from @tomsun28/pizza-protocol and provides typed overrides for fields that
 * reference agent internals (AgentMessage, CompactionResult, etc.).
 */

export {
	type RpcCommand,
	type RpcExtensionUIRequest,
	type RpcExtensionUIResponse,
	type RpcCommandType,
	type TypedEvent,
	type StdoutLine,
	type ModelInfo,
	type ThinkingLevel,
	type RpcHistoryTreeNode,
	type RpcHistorySessionView,
	type RpcHistoryTreeResult,
	type RpcForensicEvent,
	type RpcSkillInfo,
	type RpcExtensionInfo,
	type RpcThemeInfo,
	type RpcExtensionPermissionKind,
	type RpcExtensionPermissionInfo,
	type RpcExtensionPermissionState,
	classifyLine,
	PROTOCOL_VERSION,
} from "@tomsun28/pizza-protocol";

import type {
	RpcSessionState as ProtocolSessionState,
	RpcHistoryTreeResult,
	RpcForensicEvent,
	RpcSkillInfo,
	RpcThemeInfo,
	ScheduledTaskSummary,
	ScheduledTaskRun,
	SessionTarget,
	ConcurrencyPolicy,
	SchedulerPolicy,
} from "@tomsun28/pizza-protocol";

import type { AgentMessage, ThinkingLevel } from "../../src/core/agent/types.js";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { SessionStats } from "../../src/core/session-stats.js";
import type { BashResult } from "../../src/core/bash-executor.js";
import type { CompactionResult } from "../../src/core/compaction/index.js";
import type { SourceInfo } from "../../src/core/source-info.js";

// ============================================================================
// Typed overrides (agent side has full type information)
// ============================================================================

export interface RpcSessionState extends Omit<ProtocolSessionState, "model"> {
	model?: Model<any>;
}

/** Agent-side RpcSlashCommand with typed sourceInfo */
export interface RpcSlashCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	sourceInfo: SourceInfo;
}

export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "rewind"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// Model
	| { id?: string; type: "response"; command: "set_model"; success: true; data: Model<any> }
	| { id?: string; type: "response"; command: "cycle_model"; success: true; data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null }
	| { id?: string; type: "response"; command: "get_available_models"; success: true; data: { models: Model<any>[] } }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| { id?: string; type: "response"; command: "cycle_thinking_level"; success: true; data: { level: ThinkingLevel } | null }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean; sessionId?: string } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "get_fork_messages"; success: true; data: { messages: Array<{ entryId: string; text: string }> } }
	| { id?: string; type: "response"; command: "get_last_assistant_text"; success: true; data: { text: string | null } }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Commands
	| { id?: string; type: "response"; command: "get_commands"; success: true; data: { commands: RpcSlashCommand[] } }

	// History tree / event forensics
	| { id?: string; type: "response"; command: "history_tree"; success: true; data: RpcHistoryTreeResult }
	| { id?: string; type: "response"; command: "get_events"; success: true; data: { events: RpcForensicEvent[] } }
	// Approval (safe mode)
	| { id?: string; type: "response"; command: "approve"; success: true }
	| { id?: string; type: "response"; command: "reject"; success: true }
	| { id?: string; type: "response"; command: "set_safe_mode"; success: true; data: { safeMode: boolean } }
	| { id?: string; type: "response"; command: "set_approval_policy"; success: true; data: { approvalPolicy: import("@tomsun28/pizza-protocol").ApprovalPolicy } }
	| { id?: string; type: "response"; command: "get_approval_policy"; success: true; data: { approvalPolicy: import("@tomsun28/pizza-protocol").ApprovalPolicy } }
	| { id?: string; type: "response"; command: "get_approval_gates"; success: true; data: { gates: import("@tomsun28/pizza-protocol").ApprovalGates } }
	| { id?: string; type: "response"; command: "set_approval_gates"; success: true; data: { gates: import("@tomsun28/pizza-protocol").ApprovalGates } }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { sessionId: string } }
	| { id?: string; type: "response"; command: "get_skills"; success: true; data: { skills: RpcSkillInfo[] } }
	| {
			id?: string;
			type: "response";
			command: "set_skill_enabled";
			success: true;
			data: { name: string; enabled: boolean; requiresReload: boolean };
	  }
	| { id?: string; type: "response"; command: "delete_skill"; success: true; data: { name: string } }
	| { id?: string; type: "response"; command: "get_themes"; success: true; data: { themes: RpcThemeInfo[] } }

	// Scheduled tasks
	| { id?: string; type: "response"; command: "schedule_list"; success: true; data: { tasks: ScheduledTaskSummary[] } }
	| { id?: string; type: "response"; command: "schedule_create"; success: true; data: { task: ScheduledTaskSummary } }
	| { id?: string; type: "response"; command: "schedule_update"; success: true; data: { task: ScheduledTaskSummary } }
	| { id?: string; type: "response"; command: "schedule_delete"; success: true; data: { ok: true; taskId: string } }
	| { id?: string; type: "response"; command: "schedule_run_now"; success: true; data: { fired: true; taskId: string; at: number } }
	| { id?: string; type: "response"; command: "schedule_reload"; success: true; data: { reloaded: number } }
	| { id?: string; type: "response"; command: "schedule_history"; success: true; data: { runs: ScheduledTaskRun[] } }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };
