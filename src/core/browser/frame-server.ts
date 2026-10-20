/**
 * FrameServer — local WebSocket mirroring channel for the browser panel.
 *
 * Downstream (server → client): JSON control messages (FrameServerMessage)
 * and binary JPEG frames from the controller's screencast session.
 * Upstream (client → server): tab selection and input events, which are
 * forwarded to the controller — control operations (navigate/close/stop)
 * deliberately do NOT travel on this channel; they go through the RPC
 * command path.
 *
 * Security posture (deliberately stricter than the PTY server precedent):
 *  - binds 127.0.0.1 with an OS-assigned random port
 *  - handshake requires a one-shot token (≥128 bits, 30s TTL, rotated on
 *    every re-issue; obtained only via the browser_get_state RPC response —
 *    the token never appears in the event stream or the EventStore)
 *  - Origin/Host loopback validation (browser pages may open cross-origin
 *    WebSockets; a remote page must not reach this socket)
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { BrowserController } from "./controller.js";
import type { BrowserInputEvent, FrameClientMessage } from "./types.js";

const TOKEN_TTL_MS = 30_000;
/**
 * How many outstanding tokens may coexist. Credentials rotate on every
 * browser_get_state, and callers legitimately run concurrently (panel mount
 * fetches state while the frame client fetches credentials; a second panel
 * or a diagnostic tool may query state mid-session). Invalidating the
 * previous token on each issue made any concurrent query kill the live
 * one's handshake (endless "connecting…" loop), so instead the server keeps
 * the last few unexpired, unconsumed tokens valid.
 */
const MAX_OUTSTANDING_TOKENS = 8;

export interface FrameSessionCredentials {
	wsPort: number;
	token: string;
	/** Unix ms after which this token no longer accepts connections. */
	expiresAt: number;
}

/** Loopback/tauri origins the panel may connect from. */
export function isAllowedFrameOrigin(origin: string | undefined): boolean {
	if (!origin) return true; // non-browser local client; token still required
	try {
		const url = new URL(origin);
		if (!["http:", "https:", "tauri:", "ios:", "android:"].includes(url.protocol)) return false;
		const host = url.hostname.toLowerCase();
		return (
			host === "127.0.0.1" ||
			host === "localhost" ||
			host === "::1" ||
			host === "[::1]" ||
			host.endsWith(".localhost")
		);
	} catch {
		return false;
	}
}

/** DNS-rebinding guard: the Host header must name the loopback interface. */
export function isAllowedFrameHost(hostHeader: string | undefined): boolean {
	if (!hostHeader) return false;
	const hostname = hostHeader.split(":")[0]?.toLowerCase();
	return hostname === "127.0.0.1" || hostname === "localhost";
}

export class BrowserFrameServer {
	readonly port: number;
	private readonly controller: BrowserController;
	private readonly wss: WebSocketServer;
	private readonly outstandingTokens = new Map<string, number>(); // token -> expiresAt

	private constructor(controller: BrowserController, wss: WebSocketServer, port: number) {
		this.controller = controller;
		this.wss = wss;
		this.port = port;
	}

	static async start(controller: BrowserController): Promise<BrowserFrameServer> {
		const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		await new Promise<void>((resolve, reject) => {
			wss.once("listening", resolve);
			wss.once("error", reject);
		});
		const address = wss.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const server = new BrowserFrameServer(controller, wss, port);
		wss.on("connection", (ws, req) => server.handleConnection(ws, req));
		return server;
	}

	/**
	 * Credentials for the frontend. Issues a fresh single-use token; recent
	 * unexpired tokens stay valid too (see MAX_OUTSTANDING_TOKENS), so
	 * concurrent browser_get_state callers cannot invalidate each other.
	 */
	getCredentials(): FrameSessionCredentials {
		const value = randomBytes(24).toString("base64url");
		const expiresAt = Date.now() + TOKEN_TTL_MS;
		// Lazily drop expired tokens and cap the outstanding set.
		const now = Date.now();
		for (const [token, at] of this.outstandingTokens) {
			if (at <= now) this.outstandingTokens.delete(token);
		}
		while (this.outstandingTokens.size >= MAX_OUTSTANDING_TOKENS) {
			const oldest = this.outstandingTokens.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.outstandingTokens.delete(oldest);
		}
		this.outstandingTokens.set(value, expiresAt);
		return { wsPort: this.port, token: value, expiresAt };
	}

	/** Consume a token (single connection per token). Returns false when unknown/expired/used. */
	private consumeToken(token: string | undefined): boolean {
		if (!token) return false;
		const expiresAt = this.outstandingTokens.get(token);
		if (expiresAt === undefined) return false;
		this.outstandingTokens.delete(token);
		return Date.now() <= expiresAt;
	}

	private handleConnection(ws: WebSocket, req: IncomingMessage): void {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const token = url.searchParams.get("token") ?? undefined;
		if (!isAllowedFrameOrigin(req.headers.origin) || !isAllowedFrameHost(req.headers.host)) {
			ws.close(4403, "forbidden origin");
			return;
		}
		if (!this.consumeToken(token)) {
			ws.close(4401, "invalid or expired token");
			return;
		}

		const send = (message: unknown): void => {
			if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
		};

		const detachControl = this.controller.attachControlListener((message) => send(message));
		const detachFrames = this.controller.attachFrameSink((frame) => {
			if (ws.readyState === ws.OPEN) ws.send(frame.data);
		});

		send({ type: "hello", sessionId: `frames-${this.port}` });
		send({ type: "tabs", tabs: this.controller.getState().tabs });
		send({ type: "agent_active", active: this.controller.getState().agentActive });

		ws.on("message", (raw, isBinary) => {
			if (isBinary) return;
			let message: FrameClientMessage;
			try {
				message = JSON.parse(raw.toString()) as FrameClientMessage;
			} catch {
				return;
			}
			switch (message.type) {
				case "select_tab":
					void this.controller.use(message.tabId).catch(() => {});
					break;
				case "input":
					void this.controller.dispatchInput(message.event as BrowserInputEvent, message.tabId);
					break;
				case "ack_frame":
					// Frames are fire-and-forget; no per-frame acking needed.
					break;
				default:
					send({ type: "error", message: "unknown message type" });
			}
		});

		ws.on("close", () => {
			detachControl();
			detachFrames();
		});
		ws.on("error", () => {
			/* socket torn down */
		});
	}

	close(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.wss.close(() => resolve());
		});
	}
}
