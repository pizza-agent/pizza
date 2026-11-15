/**
 * Gateway watchdog — deterministic liveness alerts for pooled agents.
 *
 * This is the first, deliberately small tier of the Super-agent watchdog idea:
 * no model calls and no automatic cancellation. It observes the event stream
 * the gateway already receives from each workspace agent and reports three
 * concrete conditions:
 *
 * - a model turn has produced no output for too long
 * - a tool has produced no progress for too long
 * - the same tool call (same name and arguments) repeats in one user task
 *
 * The gateway forwards raw store events (AGENT_MESSAGE_START,
 * TOOL_EXECUTION_START, …), not pi's lowercase AgentEvent names. Keep this
 * switch aligned with rpc-mode.ts / channels/runtime.ts.
 *
 * Relationship to core enforcement: the reactor already aborts a stream after
 * 10 minutes of silence and stops after six consecutive identical tool rounds.
 * The gateway watchdog alerts earlier (120s / six identical calls in one user
 * task) and never aborts; it is observability for the gateway boundary, not a
 * replacement for the reactor's guard.
 *
 * Keeping this outside the core runtime means a standalone CLI session, which
 * has no gateway, does not pay for it.
 */

export type WatchdogAlertKind = "stream_idle" | "tool_idle" | "repeated_tool_call";

export interface WatchdogAlert {
	workspace: string;
	kind: WatchdogAlertKind;
	message: string;
	at: number;
	/** User-task counter (USER_MESSAGE → AGENT_TURN_COMPLETED). */
	turn: number;
	toolCallId?: string;
	toolName?: string;
}

export interface GatewayWatchdogOptions {
	/** Default true. */
	enabled?: boolean;
	/** How often to sweep active workspaces. Default 5s; values below 100ms are clamped. */
	tickMs?: number;
	/** Alert when a model turn produces no output for this long. Default 120s. */
	streamIdleMs?: number;
	/** Alert when a running tool reports no progress for this long. Default 10min. */
	toolIdleMs?: number;
	/** Alert when the same tool call repeats this many times in one user task. Default 6. */
	repeatedToolCalls?: number;
	onAlert?: (alert: WatchdogAlert) => void;
	/** Test hook; defaults to Date.now. */
	now?: () => number;
}

const DEFAULT_TICK_MS = 5_000;
/** Earlier than the reactor's 10-minute stream-idle abort: alert only. */
const DEFAULT_STREAM_IDLE_MS = 120_000;
const DEFAULT_TOOL_IDLE_MS = 10 * 60_000;
/** Matches the reactor's six-identical-round loop guard, but is alert-only and scoped to one user task. */
const DEFAULT_REPEATED_TOOL_CALLS = 6;

interface ToolWatch {
	toolCallId: string;
	toolName: string;
	lastProgressAt: number;
}

interface WorkspaceWatch {
	/** USER_MESSAGE → AGENT_TURN_COMPLETED scope. */
	taskTurn: number;
	taskActive: boolean;
	modelActive: boolean;
	lastModelProgressAt: number;
	tools: Map<string, ToolWatch>;
	toolCounts: Map<string, number>;
	alerted: Set<string>;
}

function newState(): WorkspaceWatch {
	return {
		taskTurn: 0,
		taskActive: false,
		modelActive: false,
		lastModelProgressAt: 0,
		tools: new Map(),
		toolCounts: new Map(),
		alerted: new Set(),
	};
}

interface RawStoreEvent {
	type: string;
	payload: Record<string, unknown>;
}

function asStoreEvent(raw: unknown): RawStoreEvent | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const type = (raw as { type?: unknown }).type;
	if (typeof type !== "string") return undefined;
	const payload = (raw as { payload?: unknown }).payload;
	return {
		type,
		payload: payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {},
	};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Compute a stable hash of tool arguments for repeated-call detection. Uses
 * FNV-1a (32-bit), matching the reactor's loop guard so the gateway does not
 * retain large `_write` payloads as map keys.
 */
function hashArguments(args: unknown): string {
	let text: string;
	try {
		text = typeof args === "string" ? args : (JSON.stringify(args) ?? "");
	} catch {
		return "unserializable";
	}
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}

function startTask(state: WorkspaceWatch, now: number): void {
	state.taskTurn += 1;
	state.taskActive = true;
	state.modelActive = false;
	state.lastModelProgressAt = now;
	state.tools.clear();
	state.toolCounts.clear();
	state.alerted.clear();
}

function ensureTask(state: WorkspaceWatch, now: number): void {
	if (!state.taskActive) startTask(state, now);
}

export class GatewayWatchdog {
	private readonly states = new Map<string, WorkspaceWatch>();
	private timer: NodeJS.Timeout | undefined;
	private readonly enabled: boolean;
	private readonly tickMs: number;
	private readonly streamIdleMs: number;
	private readonly toolIdleMs: number;
	private readonly repeatedToolCalls: number;
	private readonly onAlert?: (alert: WatchdogAlert) => void;
	private readonly now: () => number;

	constructor(options: GatewayWatchdogOptions = {}) {
		this.enabled = options.enabled ?? true;
		this.tickMs = Math.max(100, options.tickMs ?? DEFAULT_TICK_MS);
		this.streamIdleMs = Math.max(1, options.streamIdleMs ?? DEFAULT_STREAM_IDLE_MS);
		this.toolIdleMs = Math.max(1, options.toolIdleMs ?? DEFAULT_TOOL_IDLE_MS);
		this.repeatedToolCalls = Math.max(2, options.repeatedToolCalls ?? DEFAULT_REPEATED_TOOL_CALLS);
		this.onAlert = options.onAlert;
		this.now = options.now ?? Date.now;
	}

	start(): void {
		if (!this.enabled || this.timer) return;
		this.timer = setInterval(() => this.sweep(), this.tickMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.states.clear();
	}

	forget(workspace: string): void {
		this.states.delete(workspace);
	}

	observe(workspace: string, rawEvent: unknown): void {
		if (!this.enabled) return;
		const event = asStoreEvent(rawEvent);
		if (!event) return;
		const now = this.now();
		let state = this.states.get(workspace);
		if (!state) {
			state = newState();
			this.states.set(workspace, state);
		}
		const payload = event.payload;

		switch (event.type) {
			case "USER_MESSAGE":
				// A user message starts a new task. Count repeated calls across all
				// LLM/tool rounds until AGENT_TURN_COMPLETED, not per round.
				startTask(state, now);
				return;
			case "AGENT_TURN_START":
				ensureTask(state, now);
				state.modelActive = false;
				state.lastModelProgressAt = now;
				return;
			case "AGENT_MESSAGE_START":
				ensureTask(state, now);
				state.modelActive = true;
				state.lastModelProgressAt = now;
				return;
			case "AGENT_MESSAGE_CHUNK":
				ensureTask(state, now);
				state.modelActive = true;
				state.lastModelProgressAt = now;
				return;
			case "AGENT_MESSAGE_END":
				ensureTask(state, now);
				state.modelActive = false;
				state.lastModelProgressAt = now;
				return;
			case "TOOL_EXECUTION_START": {
				ensureTask(state, now);
				const toolCallId = asString(payload.tool_call_id);
				if (!toolCallId) return;
				const toolName = asString(payload.tool_name) ?? "tool";
				const toolKey = `${toolName}:${hashArguments(payload.arguments)}`;
				state.modelActive = false;
				state.lastModelProgressAt = now;
				state.tools.set(toolCallId, {
					toolCallId,
					toolName,
					lastProgressAt: now,
				});
				const count = (state.toolCounts.get(toolKey) ?? 0) + 1;
				state.toolCounts.set(toolKey, count);
				if (count >= this.repeatedToolCalls) {
					this.alert(
						workspace,
						state,
						"repeated_tool_call",
						`same ${toolName} call repeated ${count} times in one task`,
						now,
						{ dedupeKey: toolKey, toolCallId, toolName },
					);
				}
				return;
			}
			case "TOOL_EXECUTION_UPDATE": {
				ensureTask(state, now);
				const toolCallId = asString(payload.tool_call_id);
				if (!toolCallId) return;
				const tool = state.tools.get(toolCallId);
				if (tool) tool.lastProgressAt = now;
				state.lastModelProgressAt = now;
				return;
			}
			case "TOOL_EXECUTION_END": {
				ensureTask(state, now);
				const toolCallId = asString(payload.tool_call_id);
				if (toolCallId) state.tools.delete(toolCallId);
				state.modelActive = false;
				state.lastModelProgressAt = now;
				return;
			}
			case "AGENT_TURN_END":
				state.modelActive = false;
				state.tools.clear();
				return;
			case "AGENT_TURN_COMPLETED":
				// End of the user task. A later USER_MESSAGE starts the next one.
				state.taskActive = false;
				state.modelActive = false;
				state.tools.clear();
				return;
		}
	}

	/** Check all active workspaces now; public for tests and for a future sidecar tick. */
	sweep(now = this.now()): void {
		if (!this.enabled) return;
		for (const [workspace, state] of this.states) {
			if (!state.taskActive) continue;
			for (const tool of state.tools.values()) {
				if (now - tool.lastProgressAt >= this.toolIdleMs) {
					this.alert(
						workspace,
						state,
						"tool_idle",
						`tool ${tool.toolName} produced no progress for ${now - tool.lastProgressAt}ms`,
						now,
						{ dedupeKey: `tool:${tool.toolCallId}`, toolCallId: tool.toolCallId, toolName: tool.toolName },
					);
				}
			}
			if (state.modelActive && state.tools.size === 0 && now - state.lastModelProgressAt >= this.streamIdleMs) {
				this.alert(
					workspace,
					state,
					"stream_idle",
					`model produced no output for ${now - state.lastModelProgressAt}ms`,
					now,
				);
			}
		}
	}

	private alert(
		workspace: string,
		state: WorkspaceWatch,
		kind: WatchdogAlertKind,
		message: string,
		at: number,
		options: { dedupeKey?: string; toolCallId?: string; toolName?: string } = {},
	): void {
		const key = `${kind}:${options.dedupeKey ?? kind}`;
		if (state.alerted.has(key)) return;
		state.alerted.add(key);
		const alert: WatchdogAlert = {
			workspace,
			kind,
			message,
			at,
			turn: state.taskTurn,
			...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
			...(options.toolName ? { toolName: options.toolName } : {}),
		};
		try {
			this.onAlert?.(alert);
		} catch {
			// A diagnostic must never take down the gateway.
		}
	}
}
