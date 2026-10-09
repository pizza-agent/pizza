/**
 * Channel client — talk to a workspace agent either through the gateway
 * (multi-channel: many clients share one agent + event stream) or directly
 * (no gateway: spawn `pizza --mode rpc` yourself, daemon-free).
 *
 * Both transports speak the same Layer-0 RPC protocol (commands in, events +
 * responses out), so upper layers (desktop / web / SDK) are transport-agnostic.
 * See gateway-server.ts and protocol.ts for the Layer-1 envelope the gateway
 * adds on top.
 */

import { connect, type Socket } from "node:net";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import { gatewaySocketPath } from "./gateway-server.js";
import { type GatewayResponse, type GatewayWorkspaceInfo } from "./protocol.js";
import { RpcClient } from "../rpc/rpc-client.js";
import { resolveCliSpawn } from "../rpc/cli-spawn.js";

/** A Layer-0 command frame (what the gateway forwards verbatim to the agent). */
export type ChannelFrame = Record<string, unknown> & { id: string; type: string };

/** A Layer-0 event streamed out of the agent. */
export type ChannelEvent = Record<string, unknown> & { type: string };

/**
 * Transport-agnostic handle on a workspace agent. Same API whether the agent is
 * reached directly (spawned child) or via the gateway (multiplexed socket).
 */
export interface ChannelTransport {
	/** Subscribe to the agent's event stream. Returns an unsubscribe fn. */
	onEvent(listener: (event: ChannelEvent) => void): () => void;
	/** Send a Layer-0 command and await its Layer-0 response (correlated by id). */
	send(frame: ChannelFrame): Promise<Record<string, unknown>>;
	/** Enumerate known workspaces (gateway only; direct returns the single cwd). */
	list?(): Promise<GatewayWorkspaceInfo[]>;
	/** Tear the transport down. */
	close(): Promise<void>;
}

// ── Direct transport (no gateway) ─────────────────────────────────────────

/**
 * Spawn `pizza --mode rpc` for a single cwd and talk Layer 0 over stdin/stdout.
 * This is the daemon-free path: one channel, one agent, no broker. It is what
 * the desktop sidecar and the SDK do today.
 */
export class DirectTransport implements ChannelTransport {
	private client: RpcClient;
	constructor(private cwd: string) {
		const { cliPath, binary } = resolveCliSpawn();
		this.client = new RpcClient({ cwd, cliPath, binary });
	}

	async start(): Promise<void> {
		await this.client.start();
	}

	onEvent(listener: (event: ChannelEvent) => void): () => void {
		return this.client.onEvent((event) => listener(event as unknown as ChannelEvent));
	}

	async send(frame: ChannelFrame): Promise<Record<string, unknown>> {
		const response = await this.client.sendCommand(frame as never);
		return response as unknown as Record<string, unknown>;
	}

	async close(): Promise<void> {
		await this.client.stop();
	}
}

// ── Gateway transport (multi-channel) ─────────────────────────────────────

export interface GatewayTransportOptions {
	/** Gateway socket path (default: the standard location). */
	socketPath?: string;
	/** Connect timeout (ms), default 5000. */
	connectTimeout?: number;
}

/**
 * Connect to the gateway as a channel. One socket carries many workspaces; each
 * `attach` subscribes to that workspace's event stream, and `send` forwards a
 * Layer-0 command (the response comes back on the same connection, correlated
 * by frame.id). Multiple GatewayTransport instances (desktop, web, mobile)
 * attaching the same workspace share the one agent the gateway owns.
 */
export class GatewayTransport implements ChannelTransport {
	private socket: Socket | null = null;
	private readonly socketPath: string;
	private readonly connectTimeout: number;
	private eventListeners = new Set<(event: ChannelEvent, workspace: string) => void>();
	/** Pending send() calls awaiting their Layer-0 response, by frame.id. */
	private pending = new Map<string, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
	private detachReader: (() => void) | null = null;

	constructor(options: GatewayTransportOptions = {}) {
		this.socketPath = options.socketPath ?? gatewaySocketPath();
		this.connectTimeout = options.connectTimeout ?? 5_000;
	}

	/** Connect to the gateway socket. Must be called before attach/send. */
	async connect(): Promise<void> {
		if (this.socket) return;
		await new Promise<void>((resolve, reject) => {
			const socket = connect(this.socketPath);
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error(`gateway connect timeout (${this.socketPath})`));
			}, this.connectTimeout);
			socket.once("connect", () => {
				clearTimeout(timer);
				this.socket = socket;
				this.detachReader = attachJsonlLineReader(socket, (line) => this.handleLine(line));
				resolve();
			});
			socket.once("error", (err: Error) => {
				clearTimeout(timer);
				reject(new Error(`Failed to connect to gateway at ${this.socketPath}: ${err.message}`));
			});
		});
	}

	private controlWaiters: Array<{
		resolve: (msg: Record<string, unknown>) => void;
		reject: (error: Error) => void;
		match: (msg: Record<string, unknown>) => boolean;
	}> = [];

	private handleLine(line: string): void {
		let data: unknown;
		try {
			data = JSON.parse(line);
		} catch {
			return;
		}
		const msg = data as Record<string, unknown>;
		const type = msg.type as string | undefined;

		// Control responses (attach_ok / list_result) resolve a waiting request.
		if (type === "attach_ok" || type === "list_result") {
			const waiter = this.controlWaiters.shift();
			if (waiter) {
				waiter.resolve(msg);
				return;
			}
		}
		if (type === "error") {
			const message = (msg.message as string) ?? "gateway error";
			const waiter = this.controlWaiters.shift();
			if (waiter) {
				waiter.reject(new Error(message));
				return;
			}
		}

		// rpc delivery: a response (id we're waiting on) or an event (fan to listeners).
		if (type === "rpc") {
			const frame = msg.frame as { id?: string } | undefined;
			const workspace = (msg.workspace as string) ?? "";
			if (frame?.id && this.pending.has(frame.id)) {
				const pending = this.pending.get(frame.id)!;
				this.pending.delete(frame.id);
				pending.resolve(frame as Record<string, unknown>);
			} else if (frame) {
				for (const listener of this.eventListeners) {
					listener(frame as ChannelEvent, workspace);
				}
			}
		}
	}

	/** Subscribe to a workspace's event stream. Returns the resolved cwd.
	 *  `opts.headless` keeps the agent headless (bot channels — no human to
	 *  answer approvals). */
	async attach(workspace: string, opts?: { headless?: boolean }): Promise<string> {
		this.requireConnected();
		const msg = await this.request({ type: "attach", workspace, headless: opts?.headless === true ? true : undefined });
		return (msg as { workspace: string }).workspace;
	}

	/** Stop receiving events for a workspace on this connection. */
	async detach(workspace: string): Promise<void> {
		this.requireConnected();
		this.write({ type: "detach", workspace });
	}

	onEvent(listener: (event: ChannelEvent, workspace: string) => void): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	async send(frame: ChannelFrame): Promise<Record<string, unknown>> {
		// send() without a workspace is ambiguous for the gateway transport;
		// callers use sendToWorkspace. Kept for transport-parity.
		throw new Error("GatewayTransport.send requires a workspace — use sendToWorkspace");
	}

	/** Forward a Layer-0 command to a workspace's agent and await its response.
	 *  `opts.headless` keeps the agent headless (bot channels). */
	async sendToWorkspace(workspace: string, frame: ChannelFrame, opts?: { headless?: boolean }): Promise<Record<string, unknown>> {
		this.requireConnected();
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			this.pending.set(frame.id, { resolve, reject });
			this.write({ type: "rpc", workspace, frame, headless: opts?.headless === true ? true : undefined });
		});
	}

	async list(): Promise<GatewayWorkspaceInfo[]> {
		this.requireConnected();
		const msg = await this.request<{ workspaces: GatewayWorkspaceInfo[] }>({ type: "list" });
		return (msg as { workspaces: GatewayWorkspaceInfo[] }).workspaces;
	}

	/**
	 * Send a Layer-1 control request (attach / list) and await the matching
	 * control response. Responses are single-threaded through controlWaiters
	 * (a channel attaches/lists once at setup, so contention is not expected).
	 */
	private request<T = Record<string, unknown>>(req: Record<string, unknown>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.controlWaiters.push({
				resolve: (msg) => resolve(msg as T),
				reject,
				// Unused now — matching is by order (attach_ok/list_result shift off
				// the queue). Kept for a future cursor/reply correlation if needed.
				match: () => true,
			});
			this.write(req);
		});
	}

	private write(obj: Record<string, unknown>): void {
		this.socket?.write(`${serializeJsonLine(obj)}\n`);
	}

	private requireConnected(): void {
		if (!this.socket) {
			throw new Error("GatewayTransport is not connected — call connect() first");
		}
	}

	async close(): Promise<void> {
		this.detachReader?.();
		this.detachReader = null;
		for (const [, pending] of this.pending) {
			pending.reject(new Error("gateway transport closed"));
		}
		this.pending.clear();
		if (this.socket) {
			this.socket.destroy();
			this.socket = null;
		}
	}
}
