/**
 * RPC protocol types — shared between the agent (src/) and consumers (apps/web/).
 *
 * This package is dependency-free. Types that reference agent internals
 * (AgentMessage, CompactionResult, BashResult, SessionStats, SourceInfo)
 * are declared as `unknown` here so consumers don't need to install the
 * full agent core. The agent side re-exports a typed version from
 * src/modes/rpc/rpc-types.ts with proper type parameters filled in.
 */

// ============================================================================
// Scheduled task primitives
// ============================================================================

/**
 * Schedule data types — shared between the agent (src/core/scheduler/) and
 * consumers (apps/web/). Kept dependency-free so protocol consumers don't
 * have to pull in agent internals.
 *
 * Two layers of scheduling are supported:
 *   - "visual" modes: every_n_minutes / every_n_hours / daily / weekdays /
 *     weekly / monthly. Each "time" field is an array so multiple time
 *     points are first-class (e.g. "every day at 02:00 and 03:00" /
 *     "每天 02:00 和 03:00").
 *   - "advanced" mode: cron expression with optional timezone.
 *
 * The two layers are equivalent at runtime: any visual schedule can be
 * converted to an equivalent cron expression for display, and any cron
 * expression (covering the supported syntax) can be converted back. See
 * src/core/scheduler/cron.ts for the conversion helpers.
 */

export type ScheduleMode =
	| "every_n_minutes"
	| "every_n_hours"
	| "daily"
	| "weekdays"
	| "weekly"
	| "monthly"
	| "cron";

/** 24h wall-clock time. */
export interface TimeOfDay {
	hour: number; // 0-23
	minute: number; // 0-59
}

/** 0 = Sunday, 1 = Monday, ..., 6 = Saturday (matches JS Date.getDay()). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Day-of-month, 1-31. */
export type DayOfMonth = number;

/**
 * ScheduleSpec is the canonical, fully-unrolled schedule for one task.
 * Each field is optional except where the chosen mode requires it.
 */
export interface ScheduleSpec {
	mode: ScheduleMode;
	/** every_n_minutes / every_n_hours */
	everyN?: { n: number; unit: "minute" | "hour" };
	/** daily / weekdays / weekly / monthly. Always an array (possibly empty). */
	times?: TimeOfDay[];
	/** weekly (multi-select). */
	weekdays?: Weekday[];
	/** monthly (multi-select). */
	daysOfMonth?: DayOfMonth[];
	/** cron mode. */
	cron?: { expression: string; tz?: string };
	/** First allowed fire time (epoch ms). Defaults to creation time. */
	startAt?: number;
	/** Last allowed fire time (epoch ms). Omit = forever. */
	endAt?: number;
}

/**
 * A persisted scheduled task. One task = one schedule + one prompt message
 * that gets dispatched to the agent at every fire time.
 */
export interface ScheduledTask {
	id: string;
	/** Display name. Defaults to first 30 chars of prompt. */
	name: string;
	/** Message to dispatch to the agent at every fire time. */
	prompt: string;
	/**
	 * Which scope owns this task.
	 *   - "main"       → stored at ~/.pizza/main/scheduler/tasks.json
	 *   - "workspace"  → stored at ~/.pizza/workspaces/<workspaceId>/scheduler/tasks.json
	 * When scope === "workspace", workspaceId must be set.
	 */
	scope: "main" | "workspace";
	/** Workspace id when scope === "workspace". */
	workspaceId?: string;
	schedule: ScheduleSpec;
	enabled: boolean;
	/** Last successful fire time (epoch ms). */
	lastRunAt?: number;
	/** Status of the most recent run. */
	lastRunStatus?: "ok" | "failed" | "skipped";
	/** Event id of the last USER_MESSAGE event produced by this task. */
	lastRunEventId?: string;
	/** Number of times this task has fired since creation. */
	runCount?: number;
	createdAt: number;
	updatedAt: number;
	/** "user" = manual creation, "intent" = natural-language chat intent. */
	createdBy: "user" | "intent";
	/** Original user sentence when createdBy === "intent" (auditability). */
	sourceText?: string;
	/**
	 * Which session the task runs in at each fire time.
	 *   - { kind: "pinned", sessionId } → dispatch into the saved logical session
	 *   - { kind: "new", purpose }      → each fire creates a fresh session whose
	 *                                     first user message is the task prompt
	 * Optional only for backwards compat; legacy missing/current targets require
	 * the user to edit the task and choose one of the supported targets.
	 */
	sessionTarget?: SessionTarget;
	/**
	 * What to do when this task wants to fire but its target session is
	 * already running another task. Default: "skip" (cron-style drop the tick).
	 */
	concurrencyPolicy?: ConcurrencyPolicy;
	/**
	 * Auto-release the session lock and mark the task as failed if it
	 * doesn't finish within this many minutes. 0 = no timeout (default).
	 * Recommended: 15 for interactive agents, 0 for batch jobs.
	 */
	timeoutMinutes?: number;
	/**
	 * Safety cap: auto-disable the task once runCount reaches this value.
	 * Prevents runaway recurring tasks (e.g. self-deleting tasks whose
	 * termination condition never fires). 0/undefined = unlimited.
	 */
	maxRuns?: number;
}

/**
 * Where a task runs when it fires.
 */
export type SessionTarget =
	| { kind: "pinned"; sessionId?: string; label?: string }
	/** @deprecated kept only so old tasks can be migrated through the UI. */
	| { kind: "current" }
	| { kind: "new"; purpose: string };

/**
 * What to do when a second task wants to run while another is in flight
 * in the same target session.
 */
export type ConcurrencyPolicy = "skip" | "queue" | "preempt";

/**
 * Per-scope scheduler policy (the global defaults for newly-created
 * tasks). Persisted in settings.json. Per-task fields on ScheduledTask
 * override these defaults.
 */
export interface SchedulerPolicy {
	concurrency: ConcurrencyPolicy;
	timeoutMinutes: number;
	defaultSessionTarget: SessionTarget;
}

/** Network settings (settings.json `network`) — outbound egress for channel
 *  adapters and other integrations. */
export interface NetworkSettings {
	/** Proxy for outbound connections. "auto" (default/absent): env vars, then
	 *  OS proxy detection. "off": direct connections. Otherwise an explicit URL
	 *  like "http://127.0.0.1:7897" or "socks5://…". */
	proxy?: string;
}

/** Lightweight status snapshot returned to UI when listing tasks. */
export interface ScheduledTaskSummary extends ScheduledTask {
	/** Next scheduled fire time, or null if disabled / past endAt. */
	nextRunAt: number | null;
}

/** One record in runs.jsonl — appended on every fire. */
export interface ScheduledTaskRun {
	taskId: string;
	at: number;
	status: "ok" | "failed" | "skipped";
	/** Event id of the produced USER_MESSAGE (if any). */
	eventId?: string;
	/** Session id that received the scheduled prompt (if known). */
	sessionId?: string;
	/** Optional error / skip reason. */
	reason?: string;
}

/** Default limit for schedule_history RPC. */
export const SCHEDULE_HISTORY_DEFAULT_LIMIT = 50;

/** Maximum time points a user can attach to one schedule. */
export const SCHEDULE_MAX_TIME_POINTS = 32;

/** Maximum days/weekdays in one schedule. */
export const SCHEDULE_MAX_DAYS = 31;

// Internal aliases so the rest of this file can use the bare names
// without colliding with the inlined types above.
// ============================================================================

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Minimal model info — enough for UI rendering without pulling in
 * @earendil-works/pi-ai's Model<any> type.
 */
export interface ModelInfo {
	id: string;
	name: string;
	api: string;
	provider: string;
	reasoning?: boolean;
	contextWindow?: number;
	/** Whether the user has configured auth (API key / OAuth) for this model. */
	hasAuth?: boolean;
}

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: unknown[]; files?: unknown[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: unknown[]; files?: unknown[] }
	| { id?: string; type: "follow_up"; message: string; images?: unknown[]; files?: unknown[] }
	| { id?: string; type: "get_queued_messages" }
	| { id?: string; type: "cancel_queued_message"; sourceEventId: string }
	| { id?: string; type: "steer_queued_message"; sourceEventId: string }
	| { id?: string; type: "abort" }
	| { id?: string; type: "rewind"; targetEventId?: string }

	// State
	| { id?: string; type: "get_state" }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	/** authOnly: return only models with configured auth (the registry holds ~1.6k models, ~260KB). */
	| { id?: string; type: "get_available_models"; authOnly?: boolean }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string; reason?: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "clone" }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_last_assistant_text" }

	// Messages
	| { id?: string; type: "get_messages" }

	// Commands (available for invocation via prompt)
	| { id?: string; type: "get_commands" }

	// History tree / event forensics (web docks)
	| { id?: string; type: "history_tree"; action: "list"; query?: string }
	| { id?: string; type: "history_tree"; action: "view"; sessionId: string; maxMessages?: number }
	| { id?: string; type: "history_tree"; action: "switch"; sessionId: string; reason?: string }
	| { id?: string; type: "history_tree"; action: "jump"; sessionId: string; reason?: string }
	| { id?: string; type: "history_tree"; action: "fork"; sessionId: string }
	| { id?: string; type: "history_tree"; action: "rename"; sessionId: string; name: string }
	| { id?: string; type: "get_events"; eventTypes?: string[]; limit?: number; sessionScoped?: boolean }

	// Approval (safe mode)
	| { id?: string; type: "approve"; intentEventId: string }
	| { id?: string; type: "reject"; intentEventId: string }
	| { id?: string; type: "set_safe_mode"; enabled: boolean }
	| { id?: string; type: "set_approval_policy"; policy: ApprovalPolicy }
	| { id?: string; type: "get_approval_policy" }
	| { id?: string; type: "get_approval_gates" }
	| { id?: string; type: "set_approval_gates"; gates: ApprovalGates }
	| { id?: string; type: "new_session" }
	| { id?: string; type: "get_skills" }
	| { id?: string; type: "set_skill_enabled"; skillName: string; enabled: boolean }
	| { id?: string; type: "delete_skill"; skillName: string }
	| { id?: string; type: "install_skill"; source: string; slug: string }
	| { id?: string; type: "get_extensions" }
	| { id?: string; type: "get_themes" }
	| { id?: string; type: "set_extension_enabled"; extensionId: string; enabled: boolean }
	| { id?: string; type: "install_extension"; extensionId: string }
	| { id?: string; type: "uninstall_extension"; extensionId: string }
	| { id?: string; type: "remove_package"; source: string }
	| { id?: string; type: "get_extension_permissions"; extensionId: string }
	| { id?: string; type: "recheck_extension_permissions"; extensionId: string }
	| { id?: string; type: "open_extension_permission_settings"; extensionId: string; permissionKind: RpcExtensionPermissionKind }
	// Provider auth: reload in-memory credentials from auth.json (used after the
	// desktop bridge edits auth.json out-of-band, so a model switch picks up the
	// new key instead of the stale in-memory cache or an env-var fallback).
	| { id?: string; type: "reload_providers" }
	| { id?: string; type: "get_scheduler_policy" }
	| { id?: string; type: "set_scheduler_policy"; policy: SchedulerPolicy }
	| { id?: string; type: "get_network" }
	| { id?: string; type: "set_network"; network: NetworkSettings }

	// Scheduled tasks
	| { id?: string; type: "schedule_list"; scope: "main" | "workspace"; workspaceId?: string }
	| { id?: string; type: "schedule_create"; task: ScheduledTaskCreateInput }
	| { id?: string; type: "schedule_update"; taskId: string; patch: ScheduledTaskPatch; scope: "main" | "workspace"; workspaceId?: string }
	| { id?: string; type: "schedule_delete"; taskId: string; scope: "main" | "workspace"; workspaceId?: string }
	| { id?: string; type: "schedule_run_now"; taskId: string; scope: "main" | "workspace"; workspaceId?: string }
	| { id?: string; type: "schedule_reload"; scope?: "main" | "workspace"; workspaceId?: string }
	| { id?: string; type: "schedule_history"; taskId: string; scope: "main" | "workspace"; workspaceId?: string; limit?: number };

/** Input for schedule_create RPC. Server fills id/createdAt/updatedAt. */
export interface ScheduledTaskCreateInput {
	name: string;
	prompt: string;
	scope: "main" | "workspace";
	workspaceId?: string;
	schedule: ScheduleSpec;
	enabled?: boolean;
	createdBy?: "user" | "intent";
	sourceText?: string;
	startAt?: number;
	endAt?: number;
	sessionTarget?: SessionTarget;
	concurrencyPolicy?: ConcurrencyPolicy;
	timeoutMinutes?: number;
}

/** Patch object for schedule_update. Any field omitted is left unchanged. */
export interface ScheduledTaskPatch {
	name?: string;
	prompt?: string;
	schedule?: ScheduleSpec;
	enabled?: boolean;
	startAt?: number | null;
	endAt?: number | null;
	sessionTarget?: SessionTarget | null;
	concurrencyPolicy?: ConcurrencyPolicy | null;
	timeoutMinutes?: number | null;
}

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

/** A command available for invocation via prompt */
export interface RpcSlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** What kind of command this is */
	source: "extension" | "prompt" | "skill";
	/** Source metadata for the owning resource */
	sourceInfo: unknown;
}

/** A user-invocable skill (from ~/.pizza skills), as returned by get_skills. */
export interface RpcSkillInfo {
	/** Command name without leading slash (e.g. "skill:my-skill"). */
	command: string;
	/** Human-readable name. */
	name: string;
	/** Human-readable description. */
	description?: string;
	/** Whether the skill is active. Disabled skills are listed so a UI can re-enable them. */
	enabled: boolean;
	/** Whether the skill ships with Pizza (opt-in) rather than being discovered on disk. */
	builtin: boolean;
	/** Absolute path of the skill's SKILL.md. */
	path: string;
	/** Where the skill comes from (e.g. "builtin", "local", a package name). */
	source: string;
}

/** An extension loaded by the agent, as returned by get_extensions. */
export interface RpcExtensionInfo {
	/** Stable id. For built-in extensions this is the built-in id (e.g. "agent-browser"); otherwise derived from the path. */
	id: string;
	/** Human-readable name. */
	name: string;
	/** Human-readable description. */
	description?: string;
	/** Where the extension comes from. */
	kind: "builtin" | "user" | "project" | "cli" | "package";
	/** Whether the extension is currently active (loaded). Disabled built-ins report false. */
	enabled: boolean;
	/** Whether toggling enable/disable is supported (built-ins and installed plugin packages). */
	canToggle: boolean;
	/**
	 * For extensions from an installed plugin package: the package source. Pass
	 * it (not `id`) to set_extension_enabled / remove_package — packages toggle
	 * and uninstall as a whole.
	 */
	packageSource?: string;
	/** Whether this extension ships an external dependency (e.g. a CLI binary) that can be installed/uninstalled. */
	installable: boolean;
	/** Whether the external dependency is currently installed. Only meaningful when installable is true. */
	installed: boolean;
	/** Internal path / source tag (e.g. "<builtin:agent-browser>" or a file path). */
	path: string;
	/** Number of tools this extension registers. */
	toolCount: number;
	/** Number of slash commands this extension registers. */
	commandCount: number;
	/** Number of dynamic built-in cli commands this extension registers (e.g. computer-use's `_computer_use`). */
	builtinCommandCount: number;
}

/** A theme known to the agent (built-in, user dir, or extension-contributed), as returned by get_themes. */
export interface RpcThemeInfo {
	/** Theme name (unique key). */
	name: string;
	/** Display label for UI pickers (defaults to name). */
	label?: string;
	/** Absolute path of the theme JSON, when loaded from disk. */
	path?: string;
	/** Where the theme comes from (e.g. "builtin", "user", an extension/package name). */
	source?: string;
	/** Whether the theme ships with Pizza. */
	builtin: boolean;
	/** Resolved web/desktop UI contribution, when the theme provides one. */
	web?: {
		label?: string;
		mode: "light" | "dark";
		/** CSS custom-property overrides keyed without the "--" prefix. */
		tokens: Record<string, string>;
		/** Window/document title and app brand name shown while this theme is active. */
		title?: string;
		/** App icon (favicon, window icon, sidebar brand mark) as a data: URI. */
		icon?: string;
		/** Raw CSS injected only while this theme is active (background images, animations, ...). */
		css?: string;
		/** Background video as a data: URI — plays muted+looping behind app content. */
		video?: string;
	};
}

export type RpcExtensionPermissionKind = "accessibility" | "screenRecording";

export interface RpcExtensionPermissionInfo {
	kind: RpcExtensionPermissionKind;
	label: string;
	description: string;
	granted: boolean;
	required: boolean;
}

export interface RpcExtensionPermissionState {
	extensionId: string;
	supported: boolean;
	installed: boolean;
	ready: boolean;
	helperPath?: string;
	message?: string;
	permissions: RpcExtensionPermissionInfo[];
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: ModelInfo;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionFile?: string;
	sessionId: string;
	threadId?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
	/** Local WebSocket PTY server port for the Terminal pane (0/undefined = unavailable). */
	ptyPort?: number;
	/** When true, risky tool calls require explicit user approval before running. */
	safeMode?: boolean;
	/** Approval policy: "off" auto-runs everything, "auto" defers to per-category gates, "on" gates every risky call. */
	approvalPolicy?: ApprovalPolicy;
	/** Estimated context window usage for the current session. */
	contextUsage?: RpcContextUsage;
	/** Cumulative token usage across all assistant messages in the session. */
	tokenUsage?: RpcTokenUsage;
}

export type ApprovalPolicy = "auto" | "on" | "off";

/** Per-category approval gates; consulted only when the approval policy is "auto". */
export interface ApprovalGates {
	writes?: boolean;
	edits?: boolean;
	shellModerate?: boolean;
	unknown?: boolean;
}

export interface RpcContextUsage {
	/** Estimated context tokens, or null if unknown. */
	tokens: number | null;
	/** Model context window size in tokens. */
	contextWindow: number;
	/** Context usage as percentage of context window (0-100), or null if unknown. */
	percent: number | null;
}

export interface RpcTokenUsage {
	totalInput: number;
	totalOutput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalCost: number;
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "get_queued_messages"; success: true; data: { entries: Array<{ kind: "steer" | "followUp"; text: string; sourceEventId?: string }> } }
	| { id?: string; type: "response"; command: "cancel_queued_message"; success: true; data: { removed: boolean } }
	| { id?: string; type: "response"; command: "steer_queued_message"; success: true; data: { promoted: boolean } }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "rewind"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// Model
	| { id?: string; type: "response"; command: "set_model"; success: true; data: ModelInfo }
	| { id?: string; type: "response"; command: "cycle_model"; success: true; data: { model: ModelInfo; thinkingLevel: ThinkingLevel; isScoped: boolean } | null }
	| { id?: string; type: "response"; command: "get_available_models"; success: true; data: { models: ModelInfo[]; total: number } }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| { id?: string; type: "response"; command: "cycle_thinking_level"; success: true; data: { level: ThinkingLevel } | null }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: unknown }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: unknown }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: unknown }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean; sessionId?: string } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "get_fork_messages"; success: true; data: { messages: Array<{ entryId: string; text: string }> } }
	| { id?: string; type: "response"; command: "get_last_assistant_text"; success: true; data: { text: string | null } }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: unknown[] } }

	// Commands
	| { id?: string; type: "response"; command: "get_commands"; success: true; data: { commands: RpcSlashCommand[] } }

	// History tree / event forensics
	| { id?: string; type: "response"; command: "history_tree"; success: true; data: RpcHistoryTreeResult }
	| { id?: string; type: "response"; command: "get_events"; success: true; data: { events: RpcForensicEvent[] } }
	// Approval (safe mode)
	| { id?: string; type: "response"; command: "approve"; success: true }
	| { id?: string; type: "response"; command: "reject"; success: true }
	| { id?: string; type: "response"; command: "set_safe_mode"; success: true; data: { safeMode: boolean } }
	| { id?: string; type: "response"; command: "set_approval_policy"; success: true; data: { approvalPolicy: ApprovalPolicy } }
	| { id?: string; type: "response"; command: "get_approval_policy"; success: true; data: { approvalPolicy: ApprovalPolicy } }
	| { id?: string; type: "response"; command: "get_approval_gates"; success: true; data: { gates: ApprovalGates } }
	| { id?: string; type: "response"; command: "set_approval_gates"; success: true; data: { gates: ApprovalGates } }
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
	| { id?: string; type: "response"; command: "install_skill"; success: true; data: { name: string; path: string } }
	| { id?: string; type: "response"; command: "get_extensions"; success: true; data: { extensions: RpcExtensionInfo[] } }
	| { id?: string; type: "response"; command: "get_themes"; success: true; data: { themes: RpcThemeInfo[] } }
	| { id?: string; type: "response"; command: "set_extension_enabled"; success: true; data: { id: string; enabled: boolean; requiresReload: boolean } }
	| { id?: string; type: "response"; command: "install_extension"; success: true; data: { extensionId: string; ok: boolean; message: string; installed: boolean } }
	| { id?: string; type: "response"; command: "uninstall_extension"; success: true; data: { extensionId: string; ok: boolean; message: string; installed: boolean } }
	| { id?: string; type: "response"; command: "remove_package"; success: true; data: { source: string; removed: boolean; requiresReload: boolean } }
	| { id?: string; type: "response"; command: "get_extension_permissions"; success: true; data: RpcExtensionPermissionState }
	| { id?: string; type: "response"; command: "recheck_extension_permissions"; success: true; data: RpcExtensionPermissionState }
	| { id?: string; type: "response"; command: "open_extension_permission_settings"; success: true; data: { extensionId: string; ok: boolean; message: string } }
	| { id?: string; type: "response"; command: "reload_providers"; success: true; data: { providers: string[] } }
	| { id?: string; type: "response"; command: "get_scheduler_policy"; success: true; data: { policy: SchedulerPolicy } }
	| { id?: string; type: "response"; command: "set_scheduler_policy"; success: true; data: { policy: SchedulerPolicy } }
	| { id?: string; type: "response"; command: "get_network"; success: true; data: { network: NetworkSettings } }
	| { id?: string; type: "response"; command: "set_network"; success: true; data: { network: NetworkSettings } }

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

// ============================================================================
// History Tree / Event Forensics payloads (shared with web docks)
// ============================================================================

/** A flattened history-tree node (one session), as returned by `history_tree list`. */
export interface RpcHistoryTreeNode {
	session_id: string;
	thread_id: string;
	name?: string;
	created_at: number;
	created_by: string;
	parent_session_id?: string;
	depth: number;
	child_count: number;
	is_active: boolean;
	closed: boolean;
	has_active_continuation?: boolean;
	/** Human-meaningful label: explicit name, else derived from the first user message. */
	title?: string;
	/** True when `title` was derived from content instead of an explicit name. */
	title_is_derived?: boolean;
	snippet?: string;
	/** Number of user messages in the session. */
	message_count?: number;
	/** Timestamp of the last event in the session. */
	last_activity_at?: number;
	/** Event id the branch was forked at (present when it has a parent). */
	fork_at_event_id?: string;
}

/** One session's message previews, as returned by `history_tree view`. */
export interface RpcHistorySessionView {
	session_id: string;
	name?: string;
	messages: string[];
	message_count: number;
}

/** Discriminated result of the `history_tree` command by action. */
export type RpcHistoryTreeResult =
	| { action: "list"; nodes: RpcHistoryTreeNode[] }
	| { action: "view"; view: RpcHistorySessionView | null }
	| { action: "switch"; session_id: string }
	| { action: "jump"; session_id: string; reopened: boolean }
	| { action: "fork"; session_id: string }
	| { action: "rename"; ok: boolean };

/** A raw event projected for the timeline dock. */
export interface RpcForensicEvent {
	event_id: string;
	type: string;
	timestamp: number;
	actor_id: string;
	caused_by?: string;
	thread_id?: string;
	payload: unknown;
}

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
	| { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText: string | undefined }
	| { type: "extension_ui_request"; id: string; method: "setWidget"; widgetKey: string; widgetLines: string[] | undefined; widgetPlacement?: "aboveEditor" | "belowEditor" }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Typed events (stdout, raw EventBase forwarded by the bridge)
// ============================================================================

// Well-known event types emitted by the scheduler. The UI subscribes to
// these over the rpc_event stream so it can update task status, history,
// and the "⏰ task fired" notice card in real time.
export const SCHEDULED_TASK_FIRED = "SCHEDULED_TASK_FIRED";
export const SCHEDULED_TASK_COMPLETED = "SCHEDULED_TASK_COMPLETED";
export const SCHEDULE_INTENT_RESOLVED = "SCHEDULE_INTENT_RESOLVED";

export interface TypedEvent {
	type: string;
	event_id: string;
	payload: unknown;
	[key: string]: unknown;
}

// ============================================================================
// Discriminator for stdout lines
// ============================================================================

export type StdoutLine =
	| { kind: "response"; data: RpcResponse }
	| { kind: "extension_ui_request"; data: RpcExtensionUIRequest }
	| { kind: "event"; data: TypedEvent };

export function classifyLine(raw: Record<string, unknown>): StdoutLine {
	if (raw.type === "response") {
		return { kind: "response", data: raw as unknown as RpcResponse };
	}
	if (raw.type === "extension_ui_request") {
		return { kind: "extension_ui_request", data: raw as unknown as RpcExtensionUIRequest };
	}
	return { kind: "event", data: raw as unknown as TypedEvent };
}

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];

// ============================================================================
// Protocol version
// ============================================================================

export const PROTOCOL_VERSION = 1;
