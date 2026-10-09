/**
 * Channel core — the shared engine every pizza channel relay uses.
 *
 * A "channel" is an external message integration (Discord / Lark / Slack /
 * Telegram / webhook) that delivers inbound messages into a workspace agent and
 * relays the agent's replies back out. This package holds the parts that are
 * identical for every platform so each `packages/channels/<platform>` stays a thin
 * adapter: gateway lifecycle, provenance, config, and the deliver/reply loop.
 *
 *   external platform ──message──▶ runtime.deliver(workspace, text, source)
 *                                          │  synchronous gateway `tell` (carries `from`)
 *                                          ▼
 *                                   pizza gateway ──▶ workspace agent (Reactor)
 *                                   ◀── reply text ──
 *   external platform ◀──reply───── adapter posts it back
 *
 * Provenance is the whole point: `source` becomes a uniform
 * <message from="discord:#dev-alerts"> block inside the agent — the same
 * envelope agent tells, cron ticks, watchers and webhooks all use.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	GatewayClient,
	GatewayTransport,
	ensureGateway,
	gatewaySocketPath,
	type ChannelEvent,
	type MessageSource,
} from "@tomsun28/pizza/gateway";

export type { MessageSource } from "@tomsun28/pizza/gateway";

/** The integration kinds a channel can be. Open set — a new channel package
 *  adds a value here (and a field branch in the UI ChannelDialog). */
export type ChannelType = "discord" | "lark" | "slack" | "telegram" | "webhook";

/** A persisted channel configuration (mirrors apps/web/src/lib/channels.ts). */
export interface ChannelConfig {
	id: string;
	type: ChannelType;
	/** User-facing label. */
	name: string;
	enabled: boolean;
	/** Platform credential (bot token, signing secret, …). */
	token?: string;
	/** Discord guild / Lark tenant. */
	server?: string;
	/** Discord channel / Lark chat / Slack channel name. */
	channel?: string;
	/** webhook type only. */
	webhookUrl?: string;
	/** Target pizza workspace (cwd or name) that inbound messages route to. */
	workspace: string;
}

/** Build the provenance the agent attributes a message to.
 *  provenance("discord", "#dev-alerts") → { kind:"discord", id:"#dev-alerts" }. */
export function provenance(type: ChannelType, id: string): MessageSource {
	return { kind: type, id };
}

export interface ChannelRuntimeOptions {
	/** Pizza agent dir (default ~/.pizza/agent). */
	agentDir?: string;
	/** Gateway socket path (default gatewaySocketPath()). */
	socketPath?: string;
	/** Connect timeout ms (default 5000). */
	connectTimeout?: number;
	/** Per-deliver tell timeout ms (default 120000). Lets a full agent turn run. */
	tellTimeoutMs?: number;
}

/** Events that mark the end of an agent turn (the stream emits both spellings). */
function isIdleEvent(event: ChannelEvent): boolean {
	const type = event.type;
	return type === "AGENT_TURN_COMPLETED" || type === "AGENT_TURN_END" || type === "agent_end";
}

/** The pizza CLI entry (dist/src/cli.js) sits next to the package's main entry
 *  (dist/src/index.js). Needed because a channel adapter's own argv[1] is NOT
 *  the pizza CLI, so ensureGateway cannot resolve it from process.argv. */
function resolvePizzaCliPath(): string | undefined {
	try {
		const entry = import.meta.resolve("@tomsun28/pizza");
		if (!entry.startsWith("file:")) return undefined;
		return fileURLToPath(new URL("./cli.js", entry));
	} catch {
		return undefined;
	}
}

/**
 * Two long-lived gateway connections shared by every inbound message:
 *
 *   - a `GatewayClient` carrying `tell` (provenance envelope + per-agent
 *     serialization, acknowledged with a `messageId`), and
 *   - a `GatewayTransport` attached to each target workspace, streaming the
 *     agent's events and answering `get_last_assistant_text` rpc calls.
 *
 * `tell` is a delivery ack, not a synchronous reply — the agent's reply is
 * captured by watching the event stream: our prompt lands as a USER_MESSAGE
 * containing `id="<messageId>"`, the turn that follows ends with an idle
 * event, and `get_last_assistant_text` then yields the reply. Correlating on
 * messageId is what keeps concurrent chats (and the queued-follow-up path)
 * attributed to the right deliver.
 *
 * Concurrent delivers to the SAME workspace are serialized by the gateway
 * (queued — the agent processes one prompt at a time); delivers to DIFFERENT
 * workspaces run in parallel.
 */
export class ChannelRuntime {
	private readonly client: GatewayClient;
	private readonly transport: GatewayTransport;
	private readonly agentDir: string;
	private readonly tellTimeoutMs: number;
	private connected = false;
	/** workspace input → in-flight attach (resolves to the canonical cwd). */
	private readonly attached = new Map<string, Promise<string>>();
	/** cwd → recent events, so a turn that beats the tell ack is still matched. */
	private readonly recentEvents = new Map<string, ChannelEvent[]>();
	private readonly replyWaiters = new Set<(event: ChannelEvent, cwd: string) => void>();
	private rpcSeq = 0;

	constructor(options: ChannelRuntimeOptions = {}) {
		this.agentDir = options.agentDir ?? join(homedir(), ".pizza", "agent");
		this.tellTimeoutMs = options.tellTimeoutMs ?? 120_000;
		const socketPath = options.socketPath ?? gatewaySocketPath();
		const connectTimeout = options.connectTimeout ?? 5_000;
		this.client = new GatewayClient({ socketPath, connectTimeout });
		this.transport = new GatewayTransport({ socketPath, connectTimeout });
	}

	/** Ensure the gateway daemon is up, then connect both sockets. Call once at startup. */
	async start(): Promise<void> {
		if (this.connected) return;
		await ensureGateway(this.agentDir, gatewaySocketPath(), undefined, resolvePizzaCliPath());
		await this.client.connect();
		await this.transport.connect();
		this.transport.onEvent((event, workspace) => {
			const buf = this.recentEvents.get(workspace) ?? [];
			buf.push(event);
			if (buf.length > 128) buf.shift();
			this.recentEvents.set(workspace, buf);
			for (const waiter of this.replyWaiters) waiter(event, workspace);
		});
		this.connected = true;
	}

	/** Attach (headless) to `workspace` once; resolves to the canonical cwd. */
	private attachWorkspace(workspace: string): Promise<string> {
		let pending = this.attached.get(workspace);
		if (!pending) {
			pending = this.transport.attach(workspace, { headless: true });
			pending.catch(() => this.attached.delete(workspace));
			this.attached.set(workspace, pending);
		}
		return pending;
	}

	/** Deliver `text` to a workspace agent and await its reply. */
	async deliver(workspace: string, text: string, source: MessageSource): Promise<string> {
		if (!this.connected) throw new Error("ChannelRuntime not started — call start() first");
		const cwd = await this.attachWorkspace(workspace);
		const waiter = this.expectReply(cwd);
		try {
			const ack = await this.client.tell(workspace, text, source);
			// Legacy gateway that still answers synchronously with the reply text.
			if ("reply" in ack && typeof ack.reply === "string") return ack.reply;
			waiter.setMessageId(ack.messageId);
			await waiter.done;
			const response = await this.transport.sendToWorkspace(
				cwd,
				{ id: `ch_${++this.rpcSeq}`, type: "get_last_assistant_text" },
				{ headless: true },
			);
			if ((response as { success?: boolean }).success === false) {
				throw new Error(String((response as { error?: unknown }).error ?? "get_last_assistant_text failed"));
			}
			const data = response.data as { text?: string | null } | undefined;
			return typeof data?.text === "string" ? data.text : "";
		} finally {
			waiter.dispose();
		}
	}

	/**
	 * Track one delivery: resolves once the workspace's event stream shows OUR
	 * prompt (a USER_MESSAGE containing the tell's `id="m_…"`) followed by an
	 * idle event — i.e. the turn our message started (or was queued into via
	 * follow-up) has settled. Rejects on tellTimeoutMs.
	 */
	private expectReply(cwd: string): {
		done: Promise<void>;
		setMessageId: (id: string) => void;
		dispose: () => void;
	} {
		let messageId: string | null = null;
		let sawOwnMessage = false;
		let settled = false;
		let resolveDone!: () => void;
		let rejectDone!: (err: Error) => void;
		const done = new Promise<void>((resolve, reject) => {
			resolveDone = resolve;
			rejectDone = reject;
		});
		const containsId = (event: ChannelEvent): boolean =>
			messageId !== null && JSON.stringify(event).includes(messageId);
		const finish = (err?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			this.replyWaiters.delete(listener);
			if (err) rejectDone(err);
			else resolveDone();
		};
		const listener = (event: ChannelEvent, ws: string): void => {
			if (ws !== cwd || settled) return;
			if (!sawOwnMessage) {
				if (event.type === "USER_MESSAGE" && containsId(event)) sawOwnMessage = true;
				return;
			}
			if (isIdleEvent(event)) finish();
		};
		const timer = setTimeout(
			() => finish(new Error(`timed out after ${this.tellTimeoutMs}ms waiting for the agent reply`)),
			this.tellTimeoutMs,
		);
		this.replyWaiters.add(listener);
		return {
			done,
			setMessageId: (id: string) => {
				messageId = id;
				// The USER_MESSAGE — and in a fast-turn edge case the idle event
				// too — may have been broadcast before the tell ack arrived on the
				// other socket. Replay the buffered events to catch up.
				for (const event of this.recentEvents.get(cwd) ?? []) {
					if (!sawOwnMessage) {
						if (event.type === "USER_MESSAGE" && containsId(event)) sawOwnMessage = true;
						continue;
					}
					if (isIdleEvent(event)) {
						finish();
						return;
					}
				}
			},
			dispose: () => {
				clearTimeout(timer);
				this.replyWaiters.delete(listener);
			},
		};
	}

	/** Drop both gateway connections. */
	async stop(): Promise<void> {
		if (!this.connected) return;
		await Promise.all([this.client.disconnect(), this.transport.close()]);
		this.attached.clear();
		this.connected = false;
	}
}

/**
 * Channel main loop harness. `factory` starts the platform client (using the
 * shared runtime to deliver messages) and returns a `stop()` to tear it down.
 * SIGINT/SIGTERM trigger a graceful shutdown of both the adapter and runtime.
 */
export async function runChannel(
	factory: (runtime: ChannelRuntime) => Promise<() => Promise<void>>,
): Promise<void> {
	const runtime = new ChannelRuntime();
	await runtime.start();
	const stopAdapter = await factory(runtime);

	const shutdown = async (signal: string): Promise<void> => {
		console.log(`[channel] ${signal} received, shutting down…`);
		await stopAdapter().catch(() => {});
		await runtime.stop().catch(() => {});
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/**
 * Parse a "keyA=valA,keyB=valB" env string into a map. Channels use it for
 * PIZZA_ROUTES ("#dev-alerts=myrepo,#general=myrepo") — the channel → workspace
 * routing that mirrors ChannelConfig.channel → ChannelConfig.workspace.
 */
export function parseRoutes(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const pair of raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)) {
		const [key, value] = pair.split("=").map((s) => s.trim());
		if (key && value) out[key] = value;
	}
	return out;
}