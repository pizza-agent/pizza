/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */

import { COMPACTION_RPC_TIMEOUT_MS } from "../protocol/index.js";

import { type ChildProcess, spawn } from "node:child_process";
import type { AgentMessage, ThinkingLevel } from "../../src/core/agent/types.js";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import type { SessionStats } from "../../src/core/session/session-stats.js";
import type { BashResult } from "../../src/core/exec/bash-executor.js";
import type { CompactionResult } from "../../src/core/compaction/index.js";
import type { EventBase } from "../../src/core/event-store/types.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type { RpcCommand, RpcResponse, RpcSessionState, RpcSlashCommand } from "./rpc-types.js";

// ============================================================================
// Types
// ============================================================================

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export interface RpcClientOptions {
	/** Path to the CLI entry point (default: searches for dist/cli.js) */
	cliPath?: string;
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Additional CLI arguments */
	args?: string[];
	/**
	 * Spawn the agent as a standalone binary instead of `node <cliPath>`.
	 *
	 * When true, {@link cliPath} is treated as the path to the compiled binary
	 * (e.g. the `bun build --compile` output) and is spawned directly without a
	 * `node` prefix. This is required when the agent runs from its compiled
	 * binary distribution — the default `spawn("node", [cliPath, ...])` would
	 * fail because no `node` runtime is bundled with the binary.
	 */
	binary?: boolean;
}

export interface ModelInfo {
	provider: string;
	id: string;
	contextWindow: number;
	reasoning: boolean;
}

export type RpcEventListener = (event: EventBase) => void;

/** Keep at most this many bytes of child stderr in memory (tail). */
const STDERR_TAIL_CAP = 64 * 1024;

// ============================================================================
// RPC Client
// ============================================================================

export class RpcClient {
	private process: ChildProcess | null = null;
	private stopReadingStdout: (() => void) | null = null;
	private eventListeners: RpcEventListener[] = [];
	private exitListeners: Array<() => void> = [];
	private pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	private requestId = 0;
	private stderr = "";

	constructor(private options: RpcClientOptions = {}) {}

	/**
	 * Start the RPC agent process.
	 */
	async start(): Promise<void> {
		if (this.process) {
			throw new Error("Client already started");
		}

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		// In binary mode the cliPath IS the compiled executable — spawn it
		// directly without a `node` prefix. In node mode, run `node cliPath`.
		const command = this.options.binary ? cliPath : "node";
		const commandArgs = this.options.binary ? args : [cliPath, ...args];

		this.process = spawn(command, commandArgs, {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Capture spawn errors (e.g. ENOENT when the binary/cliPath does not
		// exist) so they surface via getStderr()/start() instead of leaking as
		// unhandled 'error' events on the ChildProcess.
		this.process.on("error", (err: Error) => {
			const message = `Failed to spawn agent process: ${err.message}`;
			this.stderr += `\n${message}`;
			// Reject any in-flight start() waiters via the exit-code check below.
			for (const pending of this.pendingRequests.values()) {
				pending.reject(new Error(message));
			}
			this.pendingRequests.clear();
		});

		// Collect stderr for debugging — keep only the tail. Pooled agents
		// run for days and log continuously; an unbounded string would
		// leak memory inside the gateway process.
		this.process.stderr?.on("data", (data) => {
			this.stderr += data.toString();
			if (this.stderr.length > STDERR_TAIL_CAP) {
				this.stderr = this.stderr.slice(-STDERR_TAIL_CAP);
			}
			process.stderr.write(data);
		});

		// Set up strict JSONL reader for stdout.
		this.stopReadingStdout = attachJsonlLineReader(this.process.stdout!, (line) => {
			this.handleLine(line);
		});

		// Notify exit listeners when the agent process dies (so the gateway can
		// evict the dead pool entry immediately instead of waiting for idle
		// timeout or a 30s sendCommand timeout on the next request).
		this.process.on("exit", () => {
			for (const listener of this.exitListeners) {
				listener();
			}
		});

		// Wait a moment for process to initialize
		await new Promise((resolve) => setTimeout(resolve, 100));

		if (this.process.exitCode !== null || this.process.signalCode !== null || !this.process.pid) {
			throw new Error(
				`Agent process failed to start (exitCode=${this.process.exitCode}, signal=${this.process.signalCode}). Stderr: ${this.stderr}`,
			);
		}
	}

	/**
	 * Stop the RPC agent process.
	 */
	async stop(): Promise<void> {
		if (!this.process) return;

		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		this.process.kill("SIGTERM");

		// Wait for process to exit
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 1000);

			this.process?.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		this.process = null;
		// Reject all in-flight requests so callers don't hang for 30s
		// waiting for a response from a dead agent.
		for (const [, pending] of this.pendingRequests) {
			pending.reject(new Error("Agent process stopped"));
		}
		this.pendingRequests.clear();
	}

	/**
	 * Subscribe to agent events.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Subscribe to the agent process exiting. Used by the gateway to evict a
	 * dead pool entry immediately. Returns an unsubscribe fn.
	 */
	onExit(listener: () => void): () => void {
		this.exitListeners.push(listener);
		return () => {
			const index = this.exitListeners.indexOf(listener);
			if (index !== -1) {
				this.exitListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.stderr;
	}

	// =========================================================================
	// Command Methods
	// =========================================================================

	/**
	 * Send a prompt to the agent.
	 * Returns immediately after sending; use onEvent() to receive streaming events.
	 * Use waitForIdle() to wait for completion.
	 */
	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		const response = await this.send({ type: "prompt", message, images });
		if (!response.success) {
			// The agent refused the prompt (most commonly: a turn is already
			// running). Surface it — a silently dropped prompt leaves the caller
			// waiting for a reply that will never come.
			throw new Error((response as Extract<RpcResponse, { success: false }>).error);
		}
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "steer", message, images });
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "follow_up", message, images });
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	/**
	 * Rewind to a branch point, or no-op to continue the eternal conversation.
	 * @param targetEventId - Optional event id to fork from
	 */
	async rewind(targetEventId?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "rewind", targetEventId });
		return this.getData(response);
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		return this.getData(response);
	}

	/**
	 * Set model by provider and ID.
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.send({ type: "set_model", provider, modelId });
		return this.getData(response);
	}

	/**
	 * Cycle to next model.
	 */
	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		const response = await this.send({ type: "cycle_model" });
		return this.getData(response);
	}

	/**
	 * Get list of available models.
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		return this.getData<{ models: ModelInfo[] }>(response).models;
	}

	/**
	 * Set thinking level.
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	/**
	 * Cycle thinking level.
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		return this.getData(response);
	}

	/**
	 * Set steering mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * Compact session context.
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.send({ type: "compact", customInstructions });
		return this.getData(response);
	}

	/**
	 * Set auto-compaction enabled/disabled.
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * Set auto-retry enabled/disabled.
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}

	/**
	 * Execute a bash command.
	 */
	async bash(command: string): Promise<BashResult> {
		const response = await this.send({ type: "bash", command });
		return this.getData(response);
	}

	/**
	 * Abort running bash command.
	 */
	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.send({ type: "get_session_stats" });
		return this.getData(response);
	}

	/**
	 * Export session to HTML.
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.send({ type: "export_html", outputPath });
		return this.getData(response);
	}

	/**
	 * Switch to a different session file.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "switch_session", sessionPath });
		return this.getData(response);
	}

	/**
	 * Fork from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.send({ type: "fork", entryId });
		return this.getData(response);
	}

	/**
	 * Clone the current active branch into a new session.
	 * @returns Object with `cancelled: true` if an extension cancelled the clone
	 */
	async clone(): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "clone" });
		return this.getData(response);
	}

	/**
	 * Get messages available for forking.
	 */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.send({ type: "get_fork_messages" });
		return this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * Get text of last assistant message.
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		return this.getData<{ text: string | null }>(response).text;
	}


	/**
	 * Get all messages in the session.
	 */
	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.send({ type: "get_messages" });
		return this.getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * Get available commands (extension commands, prompt templates, skills).
	 */
	async getCommands(): Promise<RpcSlashCommand[]> {
		const response = await this.send({ type: "get_commands" });
		return this.getData<{ commands: RpcSlashCommand[] }>(response).commands;
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when AGENT_TURN_COMPLETED is received.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				if (isIdleEvent(event)) {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			});
		});
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	collectEvents(timeout = 60000): Promise<EventBase[]> {
		return new Promise((resolve, reject) => {
			const events: EventBase[] = [];
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				events.push(event);
				if (isIdleEvent(event)) {
					clearTimeout(timer);
					unsubscribe();
					resolve(events);
				}
			});
		});
	}

	/**
	 * Send prompt and wait for completion, returning all events.
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<EventBase[]> {
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images);
		return eventsPromise;
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private handleLine(line: string): void {
		try {
			const data = JSON.parse(line);

			// Check if it's a response to a pending request
			if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
				const pending = this.pendingRequests.get(data.id)!;
				this.pendingRequests.delete(data.id);
				pending.resolve(data as RpcResponse);
				return;
			}

			// Otherwise it's an event
			for (const listener of this.eventListeners) {
				listener(data as EventBase);
			}
		} catch {
			// Ignore non-JSON lines
		}
	}

	/**
	 * Send a Layer-0 command that already carries its own `id` (used by the
	 * gateway to forward a channel frame verbatim — the response keeps the
	 * same id so the originating channel can correlate it). Public so the
	 * gateway multiplexer can forward arbitrary frames without a per-command
	 * typed wrapper.
	 */
	async sendCommand(command: RpcCommand, timeoutMs = command.type === "compact" ? COMPACTION_RPC_TIMEOUT_MS : 30_000): Promise<RpcResponse> {
		if (!this.process?.stdin) {
			throw new Error("Client not started");
		}
		const id = command.id ?? `req_${++this.requestId}`;
		const fullCommand = (command.id === undefined ? { ...command, id } : command) as RpcCommand;

		return new Promise((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });

			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
			}, timeoutMs);

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});

			this.process!.stdin!.write(serializeJsonLine(fullCommand));
		});
	}

	private send(command: RpcCommandBody): Promise<RpcResponse> {
		return this.sendCommand({ ...command, id: `req_${++this.requestId}` } as RpcCommand);
	}

	private getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new Error(errorResponse.error);
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}

function isIdleEvent(event: EventBase): boolean {
	const type = (event as { type?: string }).type;
	return type === "AGENT_TURN_COMPLETED" || type === "agent_end";
}
