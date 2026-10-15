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
import { type ChannelEvent, type ChannelFrame, type MessageSource } from "../gateway/index.js";
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
	/**
	 * In-process gateway bridge — required. Channel adapters always run
	 * inside the gateway daemon; the bridge is the direct-call equivalent of
	 * the old socket transport.
	 */
	bridge: ChannelBridge;
	/** Per-deliver tell timeout ms. 0 (default) disables the timeout so long turns still get a reply. */
	tellTimeoutMs?: number;
	/**
	 * Called when the adapter hits a fatal platform failure mid-run (e.g. a
	 * dead polling loop). The gateway's supervisor passes a handler that marks
	 * the adapter crashed and schedules a respawn — adapters must NEVER
	 * process.exit inside the daemon.
	 */
	onFatal: (error: unknown) => void;
}

/**
 * The slice of the gateway a channel adapter needs, in-process. Implemented
 * by the gateway's channel host (see gateway-server.ts channelHost) so the
 * SAME deliver/reply logic works whether the adapter is a subprocess talking
 * over the socket or code running inside the daemon.
 *
 * Mirrors the socket protocol exactly: `tell` returns a delivery ack
 * ({messageId}), events stream via onEvent after `attach`, and
 * `sendToWorkspace` forwards a Layer-0 command and returns its response.
 */
export interface ChannelBridge {
	tell(to: string, message: string, from: MessageSource): Promise<{ messageId: string }>;
	attach(workspace: string, opts?: { headless?: boolean }): Promise<string>;
	detach(workspace: string): Promise<void>;
	onEvent(listener: (event: ChannelEvent, workspace: string) => void): () => void;
	sendToWorkspace(
		workspace: string,
		frame: ChannelFrame,
		opts?: { headless?: boolean },
	): Promise<Record<string, unknown>>;
	close?(): Promise<void>;
}

/** Events that mark the true end of an agent turn. AGENT_TURN_COMPLETED is terminal; AGENT_TURN_END fires after every tool-call round and must NOT count. */
function isIdleEvent(event: ChannelEvent): boolean {
	const type = event.type;
	return type === "AGENT_TURN_COMPLETED" || type === "agent_end";
}

/**
 * One in-process {@link ChannelBridge} shared by every inbound message:
 *
 *   - `tell` delivers the prompt (provenance envelope + per-agent
 *     serialization, acknowledged with a `messageId`),
 *   - `attach`/`onEvent` stream the agent's events, and `sendToWorkspace`
 *     answers `get_last_assistant_text` rpc calls.
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
	private readonly bridge: ChannelBridge;
	private readonly onFatal: (error: unknown) => void;
	private readonly agentDir: string;
	private readonly tellTimeoutMs: number;
	private connected = false;
	/** Drop the bridge's event subscription on stop(). */
	private unsubEvents?: () => void;
	/** workspace input → in-flight attach (resolves to the canonical cwd). */
	private readonly attached = new Map<string, Promise<string>>();
	/** cwd → recent events, so a turn that beats the tell ack is still matched. */
	private readonly recentEvents = new Map<string, ChannelEvent[]>();
	private readonly replyWaiters = new Set<(event: ChannelEvent, cwd: string) => void>();
	private rpcSeq = 0;

	constructor(options: ChannelRuntimeOptions) {
		this.agentDir = options.agentDir;
		this.tellTimeoutMs = options.tellTimeoutMs ?? 0;
		this.bridge = options.bridge;
		this.onFatal = options.onFatal;
	}

	/**
	 * Report a fatal adapter failure — surfaces to the supervisor which marks
	 * the channel crashed and schedules a respawn. Never let one channel take
	 * the gateway down.
	 */
	reportFatal(error: unknown): void {
		this.onFatal(error);
	}

	/** Pizza agent dir — adapters read settings.json (voice config etc.) from here. */
	get dir(): string {
		return this.agentDir;
	}

	/** Subscribe to the workspace event stream. Call once at startup. */
	async start(): Promise<void> {
		if (this.connected) return;
		this.unsubEvents = this.bridge.onEvent((event, workspace) => {
			// Only buffer events correlation can possibly use. A single
			// streaming turn emits hundreds of AGENT_MESSAGE_CHUNKs (and tool
			// updates): letting them into the 128-slot ring buffer evicts the
			// USER_MESSAGE a waiter needs to find on replay, hanging the
			// deliver forever (tellTimeoutMs defaults to 0).
			if (event.type !== "AGENT_MESSAGE_CHUNK" && event.type !== "TOOL_EXECUTION_UPDATE") {
				const buf = this.recentEvents.get(workspace) ?? [];
				buf.push(event);
				if (buf.length > 128) buf.shift();
				this.recentEvents.set(workspace, buf);
			}
			for (const waiter of this.replyWaiters) waiter(event, workspace);
		});
		this.connected = true;
	}

	/** Attach (headless) to `workspace` once; resolves to the canonical cwd. */
	private attachWorkspace(workspace: string): Promise<string> {
		let pending = this.attached.get(workspace);
		if (!pending) {
			pending = this.bridge.attach(workspace, { headless: true });
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
			const ack = await this.bridge.tell(workspace, text, source);
			waiter.setMessageId(ack.messageId);
			await waiter.done;
			const response = await this.bridge.sendToWorkspace(
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
		// Events already processed — the buffered-event replay below passes
		// object-identical events the live listener may have seen.
		const seen = new Set<ChannelEvent>();
		const process = (event: ChannelEvent): void => {
			if (seen.has(event) || settled) return;
			seen.add(event);
			// The gateway broadcasts this when a queued tell could not be
			// delivered — without it we'd hang forever waiting for a
			// USER_MESSAGE that never comes.
			if (event.type === "TELL_DELIVERY_FAILED") {
				const payload = event.payload as { messageId?: string; error?: string } | undefined;
				if (payload?.messageId === messageId) {
					finish(new Error(payload.error ?? "tell delivery failed"));
				}
				return;
			}
			if (!sawOwnMessage) {
				if (event.type === "USER_MESSAGE" && containsId(event)) sawOwnMessage = true;
				return;
			}
			if (isIdleEvent(event)) finish();
		};
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
			if (ws !== cwd) return;
			process(event);
		};
		const timer =
			this.tellTimeoutMs > 0
				? setTimeout(
						() => finish(new Error(`timed out after ${this.tellTimeoutMs}ms waiting for the agent reply`)),
						this.tellTimeoutMs,
					)
				: undefined;
		this.replyWaiters.add(listener);
		return {
			done,
			setMessageId: (id: string) => {
				messageId = id;
				// The USER_MESSAGE — and in a fast-turn edge case the idle event
				// too — may have been broadcast before the tell ack arrived on the
				// other socket. Replay the buffered events to catch up.
				for (const event of this.recentEvents.get(cwd) ?? []) {
					process(event);
					if (settled) return;
				}
			},
			dispose: () => {
				clearTimeout(timer);
				this.replyWaiters.delete(listener);
			},
		};
	}

	/** Drop the event subscription. */
	async stop(): Promise<void> {
		if (!this.connected) return;
		this.unsubEvents?.();
		this.unsubEvents = undefined;
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

/** Guard so a second adapter can't double-wrap fetch. */
let fetchWrappedForProxy: string | undefined;

/** Guard so a second adapter (or a respawn) can't stack another
 *  https.request patch — each wrapper would add a ProxyAgent hop and leak. */
let httpsPatchedForProxy: string | undefined;

/**
 * Route `fetch()` through the proxy by injecting Bun's explicit `proxy`
 * request option. Under Bun, proxy env vars are snapshot at process start —
 * an env var injected later by the supervisor never reaches fetch — and
 * platform SDKs use the global fetch, which undici's global dispatcher does
 * not drive under Bun either. Wrapping fetch is deterministic in every
 * runtime: Bun honors `init.proxy`, undici fetch ignores unknown init keys
 * (Node mode keeps working via the refreshed EnvHttpProxyAgent).
 *
 * Idempotent per proxy URL; returns true if the patch is (now) active.
 */
export function routeFetchThroughProxy(proxyUrl: string): boolean {
	if (fetchWrappedForProxy === proxyUrl) return true;
	const realFetch = globalThis.fetch.bind(globalThis);
	const wrapped = ((input: Parameters<typeof fetch>[0], init?: RequestInit & { proxy?: string }) =>
		realFetch(input, { ...init, proxy: proxyUrl } as RequestInit)) as typeof fetch;
	globalThis.fetch = wrapped;
	fetchWrappedForProxy = proxyUrl;
	return true;
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
	if (httpsPatchedForProxy === proxy) return agent;
	httpsPatchedForProxy = proxy;
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