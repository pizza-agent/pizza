/**
 * Channel runtime — the shared engine every pizza channel adapter uses.
 *
 * A "channel" is an external message integration (Discord / Lark / Slack /
 * Telegram / webhook) that delivers inbound messages into a workspace agent and
 * relays the agent's replies back out. This module holds the parts that are
 * identical for every platform so each `packages/channels/<platform>.ts` stays a
 * thin adapter: gateway connection, provenance, proxy, and the deliver/reply loop.
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

import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import {
	GatewayClient,
	GatewayTransport,
	ensureGateway,
	gatewaySocketPath,
	type ChannelEvent,
	type MessageSource,
} from "../gateway/index.js";
import type { ChannelType } from "./types.js";

export type { MessageSource } from "../gateway/index.js";

/** Build the provenance the agent attributes a message to.
 *  provenance("discord", "#dev-alerts", "tom") → { kind:"discord", id:"#dev-alerts", name:"tom" }.
 *  `name` is the human-readable sender — surfaced as the envelope's `sender`
 *  attribute so the UI can show it instead of the opaque id. */
export function provenance(type: ChannelType, id: string, name?: string): MessageSource {
	return { kind: type, id, ...(name ? { name } : {}) };
}

export interface ChannelRuntimeOptions {
	/** Pizza agent dir (where the gateway keeps its state). */
	agentDir: string;
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
	private readonly socketPath: string;
	private readonly tellTimeoutMs: number;
	private connected = false;
	/** workspace input → in-flight attach (resolves to the canonical cwd). */
	private readonly attached = new Map<string, Promise<string>>();
	/** cwd → recent events, so a turn that beats the tell ack is still matched. */
	private readonly recentEvents = new Map<string, ChannelEvent[]>();
	private readonly replyWaiters = new Set<(event: ChannelEvent, cwd: string) => void>();
	private rpcSeq = 0;

	constructor(options: ChannelRuntimeOptions) {
		this.agentDir = options.agentDir;
		this.tellTimeoutMs = options.tellTimeoutMs ?? 120_000;
		this.socketPath = options.socketPath ?? gatewaySocketPath();
		const connectTimeout = options.connectTimeout ?? 5_000;
		this.client = new GatewayClient({ socketPath: this.socketPath, connectTimeout });
		this.transport = new GatewayTransport({ socketPath: this.socketPath, connectTimeout });
	}

	/** Ensure the gateway daemon is up, then connect both sockets. Call once at startup. */
	async start(): Promise<void> {
		if (this.connected) return;
		await ensureGateway(this.agentDir, this.socketPath);
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

// ── shared adapter helpers ────────────────────────────────────────────────

/** `PIZZA_ANSWER_ALL=1` → reply to every group/channel message, not only @bot mentions. */
export const ANSWER_ALL = process.env.PIZZA_ANSWER_ALL === "1";

/** Proxy URL to reach platform APIs through. The supervisor injects the
 *  user's / OS proxy as HTTPS_PROXY (some networks can't reach Discord,
 *  Telegram or Slack directly). */
export function proxyFromEnv(): string | undefined {
	const env = process.env;
	return env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy;
}

/** Hide credentials embedded in a proxy URL before logging it. */
export function redactProxy(url: string): string {
	return url.replace(/\/\/[^/@]*@/, "//***@");
}

/**
 * Route every `https.request` through `proxy`. Needed for SDKs whose WebSocket
 * (`ws` package) handshakes via https.request with a pinned
 * `createConnection: tlsConnect` — that ignores agent/globalAgent, so the
 * upgrade is re-issued through the proxy agent instead. Process-local: an
 * adapter process only exists to reach its platform.
 */
export function routeHttpsThroughProxy(proxy: string): HttpsProxyAgent<string> {
	const agent = new HttpsProxyAgent(proxy);
	const origRequest = https.request.bind(https);
	const patched: typeof https.request = ((opts: unknown, ...rest: unknown[]) => {
		if (opts && typeof opts === "object" && !Array.isArray(opts) && !(opts instanceof URL)) {
			const options = { ...(opts as https.RequestOptions), agent } as https.RequestOptions & {
				createConnection?: unknown;
			};
			delete options.createConnection;
			return origRequest(options, ...(rest as [never]));
		}
		return (origRequest as (...a: unknown[]) => ReturnType<typeof origRequest>)(opts, ...rest);
	}) as typeof https.request;
	https.request = patched;
	return agent;
}

/** Split a long agent reply to fit a platform's per-message cap. */
export function chunk(text: string, size: number): string[] {
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
	return chunks;
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Text posted back to the platform when a delivery fails. */
export function failureReply(err: unknown): string {
	return `⚠️ Could not reach the agent (${errorMessage(err)}).`;
}