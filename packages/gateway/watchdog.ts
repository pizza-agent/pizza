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
 * - the same tool call (same name and arguments) repeats in one turn
 *
 * Alerts are emitted once per turn/rule; the caller decides whether to log,
 * surface, or act on them. Keeping this outside the core runtime means a
 * standalone CLI session, which has no gateway, does not pay for it.
 */

import type { AgentEvent } from "../../src/core/agent/types.js";

export type WatchdogAlertKind = "stream_idle" | "tool_idle" | "repeated_tool_call";

export interface WatchdogAlert {
	workspace: string;
	kind: WatchdogAlertKind;
	message: string;
	at: number;
	turn: number;
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
	/** Alert when the same tool call repeats this many times in one turn. Default 5. */
	repeatedToolCalls?: number;
	onAlert?: (alert: WatchdogAlert) => void;
	/** Test hook; defaults to Date.now. */
	now?: () => number;
}

const DEFAULT_TICK_MS = 5_000;
const DEFAULT_STREAM_IDLE_MS = 120_000;
const DEFAULT_TOOL_IDLE_MS = 10 * 60_000;
const DEFAULT_REPEATED_TOOL_CALLS = 5;

interface WorkspaceWatch {
	turn: number;
	active: boolean;
	modelActive: boolean;
	toolActive: boolean;
	lastProgressAt: number;
	lastToolProgressAt: number;
	toolCounts: Map<string, number>;
	alerted: Set<string>;
}

function newState(): WorkspaceWatch {
	return {
		turn: 0,
		active: false,
		modelActive: false,
		toolActive: false,
		lastProgressAt: 0,
		lastToolProgressAt: 0,
		toolCounts: new Map(),
		alerted: new Set(),
	};
}

function asAgentEvent(event: unknown): AgentEvent | undefined {
	if (!event || typeof event !== "object") return undefined;
	const type = (event as { type?: unknown }).type;
	return typeof type === "string" ? (event as AgentEvent) : undefined;
}

/** JSON with sorted object keys, so equal arguments compare equal. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? String(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function toolKey(event: Extract<AgentEvent, { type: "tool_execution_start" }>): string {
	try {
		return `${event.toolName}:${stableStringify(event.args)}`;
	} catch {
		return `${event.toolName}:<unserializable>`;
	}
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
		const event = asAgentEvent(rawEvent);
		if (!event) return;
		const now = this.now();
		let state = this.states.get(workspace);
		if (!state) {
			state = newState();
			this.states.set(workspace, state);
		}

		switch (event.type) {
			case "agent_start":
				state.active = false;
				state.modelActive = false;
				state.toolActive = false;
				return;
			case "turn_start":
				state.turn += 1;
				state.active = true;
				state.modelActive = false;
				state.toolActive = false;
				state.lastProgressAt = now;
				state.lastToolProgressAt = now;
				state.toolCounts.clear();
				state.alerted.clear();
				return;
			case "message_start":
				if (!state.active) {
					state.turn += 1;
					state.active = true;
					state.toolCounts.clear();
					state.alerted.clear();
				}
				state.modelActive = true;
				state.lastProgressAt = now;
				return;
			case "message_update":
				state.modelActive = true;
				state.lastProgressAt = now;
				return;
			case "message_end":
				state.modelActive = false;
				state.lastProgressAt = now;
				return;
			case "tool_execution_start": {
				state.active = true;
				state.modelActive = false;
				state.toolActive = true;
				state.lastProgressAt = now;
				state.lastToolProgressAt = now;
				const key = toolKey(event);
				const count = (state.toolCounts.get(key) ?? 0) + 1;
				state.toolCounts.set(key, count);
				if (count >= this.repeatedToolCalls) {
					this.alert(
						workspace,
						state,
						"repeated_tool_call",
						`same ${event.toolName} call repeated ${count} times`,
						now,
						key,
					);
				}
				return;
			}
			case "tool_execution_update":
				state.lastProgressAt = now;
				state.lastToolProgressAt = now;
				return;
			case "tool_execution_end":
				state.toolActive = false;
				state.lastProgressAt = now;
				return;
			case "turn_end":
			case "agent_end":
				state.active = false;
				state.modelActive = false;
				state.toolActive = false;
				return;
		}
	}

	/** Check all active workspaces now; public for tests and for a future sidecar tick. */
	sweep(now = this.now()): void {
		if (!this.enabled) return;
		for (const [workspace, state] of this.states) {
			if (!state.active) continue;
			if (state.toolActive) {
				if (now - state.lastToolProgressAt >= this.toolIdleMs) {
					this.alert(
						workspace,
						state,
						"tool_idle",
						`tool produced no progress for ${now - state.lastToolProgressAt}ms`,
						now,
					);
				}
				continue;
			}
			if (state.modelActive && now - state.lastProgressAt >= this.streamIdleMs) {
				this.alert(
					workspace,
					state,
					"stream_idle",
					`model produced no output for ${now - state.lastProgressAt}ms`,
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
		dedupeKey: string = kind,
	): void {
		const key = `${kind}:${dedupeKey}`;
		if (state.alerted.has(key)) return;
		state.alerted.add(key);
		const alert: WatchdogAlert = { workspace, kind, message, at, turn: state.turn };
		try {
			this.onAlert?.(alert);
		} catch {
			// A diagnostic must never take down the gateway.
		}
	}
}
