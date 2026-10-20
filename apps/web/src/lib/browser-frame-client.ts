/**
 * BrowserFrameClient — WebSocket client for the managed-browser mirror
 * channel (sidecar frame server).
 *
 * Downstream: text frames are JSON control messages (RpcBrowserFrameMessage),
 * binary frames are JPEG images preceded by a `frame_meta` message. Upstream:
 * tab selection and input events. Reconnects re-fetch fresh credentials via
 * the browser_get_state RPC (tokens are single-use and short-lived), so this
 * client never caches credentials across connections.
 */

import type {
	RpcBrowserFrameClientMessage,
	RpcBrowserFrameCredentials,
	RpcBrowserFrameMessage,
} from "@tomsun28/pizza-protocol";

export type FrameClientStatus = "connecting" | "open" | "closed" | "error";

export interface PushedFrame {
	/** Raw JPEG bytes. */
	data: ArrayBuffer;
	frameId: number;
	width: number;
	height: number;
}

export interface BrowserFrameClientOptions {
	/** Fetch fresh single-use credentials (browser_get_state response .frame). */
	fetchCredentials: () => Promise<RpcBrowserFrameCredentials | undefined>;
	onMessage: (message: RpcBrowserFrameMessage) => void;
	onFrame: (frame: PushedFrame) => void;
	onStatusChange: (status: FrameClientStatus) => void;
}

const RECONNECT_DELAY_MS = 1500;

export class BrowserFrameClient {
	private readonly options: BrowserFrameClientOptions;
	private ws: WebSocket | null = null;
	private closedByUs = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingMeta: { frameId: number; width: number; height: number } | undefined;
	private generation = 0;

	constructor(options: BrowserFrameClientOptions) {
		this.options = options;
	}

	connect(credentials?: RpcBrowserFrameCredentials): void {
		if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
			return;
		}
		this.closedByUs = false;
		const generation = ++this.generation;
		this.options.onStatusChange("connecting");
		// With caller-provided credentials (panel mount already fetched
		// state) we skip the extra RPC — every browser_get_state issues a new
		// token, and racing an extra one against our own handshake is how the
		// mirror ended up in connect loops.
		if (credentials) {
			this.openSocket(credentials, generation);
			return;
		}
		void this.options
			.fetchCredentials()
			.then((fresh) => {
				if (this.closedByUs || generation !== this.generation) return;
				if (!fresh) {
					// Transient RPC failure (sidecar restarting, bridge hiccup):
					// keep retrying — giving up here would kill the mirror for
					// good until the user reopens the panel.
					this.options.onStatusChange("error");
					this.scheduleReconnect(generation);
					return;
				}
				this.openSocket(fresh, generation);
			})
			.catch(() => {
				if (!this.closedByUs && generation === this.generation) {
					this.options.onStatusChange("error");
					this.scheduleReconnect(generation);
				}
			});
	}

	private openSocket(credentials: RpcBrowserFrameCredentials, generation: number): void {
		let ws: WebSocket;
		try {
			ws = new WebSocket(`ws://127.0.0.1:${credentials.wsPort}/?token=${encodeURIComponent(credentials.token)}`);
			ws.binaryType = "arraybuffer";
		} catch {
			this.options.onStatusChange("error");
			this.scheduleReconnect(generation);
			return;
		}
		this.ws = ws;

		ws.onopen = () => {
			if (generation !== this.generation) return;
			this.options.onStatusChange("open");
		};
		ws.onmessage = (ev: MessageEvent) => {
			if (generation !== this.generation) return;
			if (typeof ev.data === "string") {
				let message: RpcBrowserFrameMessage;
				try {
					message = JSON.parse(ev.data) as RpcBrowserFrameMessage;
				} catch {
					return;
				}
				if (message.type === "frame_meta") {
					this.pendingMeta = { frameId: message.frameId, width: message.width, height: message.height };
					return;
				}
				this.options.onMessage(message);
				return;
			}
			// Binary JPEG frame — pair it with the last frame_meta.
			const meta = this.pendingMeta;
			if (!meta || !(ev.data instanceof ArrayBuffer)) return;
			this.options.onFrame({ data: ev.data, ...meta });
		};
		const onDone = () => {
			if (generation !== this.generation) return;
			this.options.onStatusChange(this.closedByUs ? "closed" : "error");
			if (!this.closedByUs) this.scheduleReconnect(generation);
		};
		ws.onclose = onDone;
		ws.onerror = onDone;
	}

	private scheduleReconnect(generation: number): void {
		if (this.closedByUs || generation !== this.generation) return;
		this.reconnectTimer ??= setTimeout(() => {
			this.reconnectTimer = undefined;
			this.connect();
		}, RECONNECT_DELAY_MS);
	}

	send(message: RpcBrowserFrameClientMessage): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(message));
		}
	}

	close(): void {
		this.closedByUs = true;
		this.generation++;
		if (this.reconnectTimer !== undefined) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		this.ws?.close();
		this.ws = null;
		this.options.onStatusChange("closed");
	}
}
