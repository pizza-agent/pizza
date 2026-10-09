/**
 * Gateway wire protocol — dependency-free types shared by the gateway server
 * (a long-running daemon) and its clients (the `_tell` tool inside an agent,
 * and eventually the desktop bridge / CLI).
 *
 * The gateway is a single Unix-socket (or Windows named-pipe) server that:
 *   1. Owns a pool of agent processes (one per workspace cwd), reusing the
 *      existing {@link RpcClient} infrastructure so a repeat `_tell` to the
 *      same workspace does NOT spawn a fresh agent each time.
 *   2. Routes messages between agents (the router pattern): no agent talks to
 *      another agent directly — every message flows through the gateway.
 *
 * Protocol: newline-delimited JSON (JSONL) over a single connection.
 *
 *   Client → Gateway:
 *     { "type": "tell",  "id": "req_1", "to": "<cwd|name>", "message": "...", "from": { "kind": "agent", "id": "web" }, "timeout": 60000 }
 *     { "type": "ping" }
 *
 *   Gateway → Client:
 *     { "type": "tell_result", "id": "req_1", "ok": true, "reply": "..." }
 *     { "type": "tell_result", "id": "req_1", "ok": false, "error": "..." }
 *     { "type": "pong" }
 *     { "type": "error",  "message": "..." }
 */

/** Base shape every message on the wire shares. */
export interface GatewayMessageBase {
	type: string;
}

// ── Client → Gateway ─────────────────────────────────────────────────────

/**
 * Provenance of an inbound message — who/what it originates from.
 *
 * This is the unifying field for the agents inbound path: every turn-trigger
 * (an agent tell, a cron tick, a file watcher, a webhook, a human user) is
 * modelled as a message carrying a `MessageSource`, so the context-rendering
 * and reply-routing code is source-agnostic and never needs a new type per
 * originator kind.
 *
 * `kind` is an OPEN set ("user" | "agent" | "cron" | "watcher" | "webhook" | …):
 * new external triggers add a value here without any protocol change. `id`
 * identifies the specific originator — an agents workspace name/cwd, a cron
 * job id, a watcher glob, etc. Together `kind:id` is the serialized address the
 * receiving agent displays and replies to (e.g. `agent:web`).
 */
export interface MessageSource {
	/** Open set: "user" | "agent" | "cron" | "watcher" | "webhook" | … */
	kind: string;
	/** Specific originator id (agent cwd/name, cron job id, watcher glob, …). */
	id: string;
	/** Human-readable sender name when the source provides one (Telegram
	 *  display name, Lark senderName). Surfaced in the UI in place of the
	 *  opaque id; also rendered as the envelope's `sender` attribute. */
	name?: string;
}

/**
 * `tell` — deliver a message to the agent for workspace `to`. The gateway
 * resolves `to` (a cwd or workspace name) to a workspace cwd, finds-or-spawns
 * the agent, and delivers the message. Delivery is asynchronous from the
 * client's perspective: the gateway acks a `tell_result` carrying
 * `delivered: true` + a `messageId` as soon as the target has accepted the
 * message, and the target agent's final reply is relayed back to the sender
 * automatically as an inbound `<message>` turn (see the relay flag below).
 */
export interface GatewayTellRequest extends GatewayMessageBase {
	type: "tell";
	/** Correlation id echoed back in the matching {@link GatewayTellResult}. */
	id: string;
	/**
	 * Destination: a workspace cwd (absolute path) or a workspace name (the
	 * last path component, resolved via known workspaces — case-insensitive).
	 */
	to: string;
	/** The message text to deliver to the target agent as its prompt. */
	message: string;
	/**
	 * @deprecated Delivery is always asynchronous now; this field is accepted
	 * for backwards compatibility and ignored.
	 */
	timeout?: number;
	/**
	 * @deprecated Delivery is always asynchronous now — the gateway acks with a
	 * `tell_result` carrying `delivered: true` + a `messageId` as soon as the
	 * target has *accepted* the message, instead of blocking until the reply is
	 * ready. When the target's turn settles, the gateway captures its final
	 * assistant text and relays it back to the sender (if the sender is an
	 * agent workspace) as an inbound `<message from="agent:<cwd>">` turn.
	 *
	 * Note the ack means "accepted", not "instant": tells to one agent are
	 * serialized, so a tell queued behind another tell is acked only once
	 * the agent takes it. If the agent is mid-turn on work the gateway does not
	 * own (a desktop user's prompt), the message is handed to the agent's
	 * follow-up queue and acked right away (no auto-relay in that case — the
	 * receiver replies on its own).
	 */
	async?: boolean;
	/**
	 * Internal (gateway use only): marks a synthesized relay-of-reply tell so
	 * the gateway does not relay the turn it triggers (loop guard). Never set
	 * by clients.
	 */
	relay?: boolean;
	/**
		 * Sender provenance. The gateway attaches this to the delivered prompt so
		 * the receiving agent knows who messaged it (and can reply). Optional for
		 * back-compat with older clients; absent means "unknown sender".
		 */
	from?: MessageSource;
}

/** `ping` — health check; the gateway replies with `{ type: "pong" }`. */
export interface GatewayPingRequest extends GatewayMessageBase {
	type: "ping";
}

/** `status` — ask the gateway for pool info (workspaces, busy state, uptime). */
export interface GatewayStatusRequest extends GatewayMessageBase {
	type: "status";
}

/** `shutdown` — ask the gateway to gracefully stop all agents and exit. */
export interface GatewayShutdownRequest extends GatewayMessageBase {
	type: "shutdown";
}

export type GatewayRequest =
	| GatewayTellRequest
	| GatewayPingRequest
	| GatewayStatusRequest
	| GatewayShutdownRequest
	| GatewayChannelRequest;

// ── Gateway → Client ─────────────────────────────────────────────────────

/** The result of a {@link GatewayTellRequest}. */
export type GatewayTellResult =
	| (GatewayMessageBase & {
			type: "tell_result";
			id: string;
			ok: true;
			/** Legacy: a synchronous reply. Current gateways never return this
			 * shape (delivery is always async); kept for old-server compat. */
			reply: string;
		  })
	| (GatewayMessageBase & {
			type: "tell_result";
			id: string;
			ok: true;
			/** Delivery ack: the prompt was accepted (prompted or queued as a follow-up). The reply arrives separately as an auto-relayed message turn when possible. */
			delivered: true;
			/** Correlates with a future `inReplyTo` on the reply message. */
			messageId: string;
	  })
	| (GatewayMessageBase & {
			type: "tell_result";
			id: string;
			ok: false;
			/** Human-readable failure reason. */
			error: string;
	  });

/** Health-check reply to {@link GatewayPingRequest}. */
export interface GatewayPong extends GatewayMessageBase {
	type: "pong";
}

/** Reply to {@link GatewayStatusRequest}: pool info. */
export interface GatewayStatusResult extends GatewayMessageBase {
	type: "status_result";
	/** Gateway process uptime in ms. */
	uptime: number;
	/** Number of subscribed channels. */
	channels: number;
	/** Pizza version of the gateway process (from package.json). */
	version: string;
	/** One entry per agent in the pool. */
	agents: Array<{
		cwd: string;
		busy: boolean;
		queueLength: number;
		lastActivityMs: number;
	}>;
}

/** Reply to {@link GatewayShutdownRequest}: confirms shutdown initiated. */
export interface GatewayShutdownResult extends GatewayMessageBase {
	type: "shutdown_ok";
}

/** A generic, connection-level error (e.g. malformed message). */
export interface GatewayError extends GatewayMessageBase {
	type: "error";
	message: string;
}

export type GatewayResponse =
	| GatewayTellResult
	| GatewayPong
	| GatewayStatusResult
	| GatewayShutdownResult
	| GatewayError
	| GatewayChannelResponse;

// ── Helpers ──────────────────────────────────────────────────────────────

/** Is the value a valid {@link GatewayRequest}? Structural check. */
export function isGatewayRequest(value: unknown): value is GatewayRequest {
	if (typeof value !== "object" || value === null) return false;
	const type = (value as { type?: unknown }).type;
	return type === "tell" || type === "ping" || type === "status" || type === "shutdown" || type === "attach" || type === "detach" || type === "rpc" || type === "list" || type === "channel_op";
}

/** Is the value a valid {@link GatewayResponse}? Structural check. */
export function isGatewayResponse(value: unknown): value is GatewayResponse {
	if (typeof value !== "object" || value === null) return false;
	const type = (value as { type?: unknown }).type;
	return type === "tell_result" || type === "pong" || type === "status_result" || type === "shutdown_ok" || type === "error" || type === "attach_ok" || type === "rpc" || type === "list_result" || type === "channel_op_result";
}

/** Default tell timeout (ms) when the client omits one. */
export const GATEWAY_DEFAULT_TELL_TIMEOUT = 120_000;

/**
 * How long an async tell waits for its delivery ack. The ack is sent as soon as
 * the target accepts the prompt, but a tell queued behind another tell to the
 * same (single-threaded) agent is only delivered once that turn finishes — so
 * this has to allow for a full turn, not just a round trip.
 */
export const GATEWAY_ASYNC_ACK_TIMEOUT = GATEWAY_DEFAULT_TELL_TIMEOUT;

/**
 * How long the gateway waits for a told agent's turn to settle before relaying
 * its reply back to the sender. Generous on purpose: real work turns can run
 * long, and a timeout here only means the reply is not auto-relayed (it never
 * surfaces as a delivery failure).
 */
export const GATEWAY_REPLY_RELAY_TIMEOUT = 10 * 60_000;

/** Protocol version — bump on breaking wire changes. */
export const GATEWAY_PROTOCOL_VERSION = 1;
// ── Channel protocol (Layer 1) ───────────────────────────────────────────
//
// The gateway multiplexes many channels over a single connection. A channel
// addresses a workspace by name-or-cwd and exchanges Layer-0 RPC frames with
// the workspace's agent. The agent speaks only Layer 0 (it never sees these
// envelopes); the gateway adds/strips the workspace address.
//
//   Channel → Gateway:
//     { "type": "attach", "workspace": "<cwd|name>" [, "cursor": N] }
//     { "type": "detach", "workspace": "<cwd|name>" }
//     { "type": "rpc",    "workspace": "<cwd|name>", "frame": <Layer-0 command> }
//     { "type": "list" }
//
//   Gateway → Channel:
//     { "type": "attach_ok", "workspace": "<cwd>" }
//     { "type": "rpc",       "workspace": "<cwd>", "frame": <Layer-0 response|event> }
//     { "type": "list_result", "workspaces": [...] }
//
// Responses are routed back to the originating channel by `frame.id`; events
// (no id) are fanned out to every channel attached to that workspace.

/** A Layer-0 RPC frame — an opaque command, response, or event the gateway forwards verbatim. */
export type GatewayRpcFrame = Record<string, unknown> & { type?: string; id?: string };

/** `attach` — subscribe to a workspace's event stream and claim it for this connection. */
export interface GatewayAttachRequest extends GatewayMessageBase {
	type: "attach";
	/** Destination workspace: a cwd (absolute path) or a workspace name (last path component). */
	workspace: string;
	/** Optional event-log cursor to resume from (reserved for the log-tail upgrade). */
	cursor?: number;
	/**
	 * Headless watcher: attach only to observe the event stream — do NOT upgrade
	 * the workspace's agent to interactive. Bot-style channels (Discord/Lark/…)
	 * set this so gated tool calls on turns they trigger auto-reject (headless
	 * semantics) instead of hanging on an approval no human will answer.
	 */
	headless?: boolean;
}

/** `detach` — stop receiving events for a workspace on this connection. */
export interface GatewayDetachRequest extends GatewayMessageBase {
	type: "detach";
	workspace: string;
}

/** `rpc` (channel → gateway) — forward a Layer-0 command to a workspace's agent. */
export interface GatewayRpcRequest extends GatewayMessageBase {
	type: "rpc";
	workspace: string;
	frame: GatewayRpcFrame;
	/** Same semantics as {@link GatewayAttachRequest.headless}: keep the agent headless. */
	headless?: boolean;
}

/** `list` — enumerate known workspaces (name, cwd, workspace_id, last_accessed). */
export interface GatewayListRequest extends GatewayMessageBase {
	type: "list";
}

/**
 * `channel_op` — manage message-channel integrations (Discord/Lark/…): the
 * configs the gateway persists and supervises (spawning one adapter process
 * per enabled channel). One envelope for every op keeps the wire small; the
 * response is always {@link GatewayChannelOpResult} with the same `id`.
 */
export interface GatewayChannelOpRequest extends GatewayMessageBase {
	type: "channel_op";
	/** Correlation id echoed back in the result. */
	id: string;
	action: "list" | "save" | "delete" | "set_enabled" | "test";
	/** `save`: the full channel config (without `id` → create). */
	channel?: Record<string, unknown>;
	/** `delete` / `set_enabled` / `test`: the target channel id. */
	channelId?: string;
	/** `set_enabled`: the desired state. */
	enabled?: boolean;
}

/** Any channel-originated request. */
export type GatewayChannelRequest =
	| GatewayAttachRequest
	| GatewayDetachRequest
	| GatewayRpcRequest
	| GatewayListRequest
	| GatewayChannelOpRequest;

/** `attach_ok` — confirms a subscription; carries the resolved cwd as the canonical workspace id. */
export interface GatewayAttachOk extends GatewayMessageBase {
	type: "attach_ok";
	workspace: string;
}

/** `rpc` (gateway → channel) — a Layer-0 response (id-routed) or event (fan-out). */
export interface GatewayRpcDelivery extends GatewayMessageBase {
	type: "rpc";
	workspace: string;
	frame: GatewayRpcFrame;
}

/** A workspace entry in a `list_result`. */
export interface GatewayWorkspaceInfo {
	workspace_id: string;
	cwd: string;
	name: string;
	last_accessed_at: number;
}

/** `list_result` — the known workspaces. */
export interface GatewayListResult extends GatewayMessageBase {
	type: "list_result";
	workspaces: GatewayWorkspaceInfo[];
}

/** Reply to {@link GatewayChannelOpRequest}: `ok` + action-specific `data` or an `error`. */
export interface GatewayChannelOpResult extends GatewayMessageBase {
	type: "channel_op_result";
	/** Echoes the request id. */
	id: string;
	ok: boolean;
	data?: unknown;
	error?: string;
}

/** Any gateway-originated message on a channel connection (broadened beyond tell-only). */
export type GatewayChannelResponse =
	| GatewayAttachOk
	| GatewayRpcDelivery
	| GatewayListResult
	| GatewayChannelOpResult
	| GatewayError;
