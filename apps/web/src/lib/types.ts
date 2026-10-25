/**
 * Web app types — re-exports shared protocol types from @tomsun28/pizza-protocol
 * and adds web-specific types (WorkspaceMeta, AgentMessage subset).
 */

export {
	type RpcCommand,
	type RpcResponse,
	type RpcSessionState,
	type RpcContextUsage,
	type RpcTokenUsage,
	type RpcExtensionUIRequest,
	type RpcExtensionUIResponse,
	type RpcCommandType,
	type TypedEvent,
	type StdoutLine,
	type ModelInfo,
	type ModelTestResult,
	type ThinkingLevel,
	type RpcSlashCommand,
	type RpcHistoryTreeNode,
	type RpcHistorySessionView,
	type RpcHistoryTreeResult,
	type RpcForensicEvent,
	type ScheduleSpec,
	type ScheduleMode,
	type TimeOfDay,
	type Weekday,
	type DayOfMonth,
	type ScheduledTask,
	type ScheduledTaskSummary,
	type ScheduledTaskRun,
	type ScheduledTaskCreateInput,
	type ScheduledTaskPatch,
	type SessionTarget,
	type ConcurrencyPolicy,
	type SchedulerPolicy,
	classifyLine,
	PROTOCOL_VERSION,
	SCHEDULED_TASK_FIRED,
	SCHEDULED_TASK_COMPLETED,
	SCHEDULE_INTENT_RESOLVED,
} from "@tomsun28/pizza-protocol";
// ---- AgentMessage (subset, for get_messages) ----
export interface AgentMessage {
	role: string;
	content: unknown;
	timestamp?: number;
	[key: string]: unknown;
}

// ---- Workspace metadata (from ~/.pizza/agent/workspaces/*/meta.json) ----
export interface WorkspaceMeta {
	workspace_id: string;
	cwd: string;
	created_at: number;
	last_accessed_at: number;
	/** Local directories and SSH-backed workspaces share this metadata shape. */
	kind?: "local" | "remote";
	/** Friendly sidebar label for remote workspaces; local entries use basename(cwd). */
	display_name?: string;
	/** False when the project directory was removed externally — the entry is
	 * stale: switching must be blocked, deletion offered instead. */
	dir_exists?: boolean;
	remote?: {
		ssh_target: string;
		port?: number | null;
		identity_file?: string | null;
		has_password?: boolean;
		remote_path: string;
		pizza_command?: string;
	};
}
