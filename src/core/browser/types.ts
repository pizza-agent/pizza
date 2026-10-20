/**
 * Shared types for the managed-browser engine (browser-use).
 *
 * The engine drives a managed Chromium via playwright-core and exposes both
 * the agent-facing `_browser` builtin command and the RPC-facing control
 * surface. All audit-facing payload shapes are defined here so the
 * EventStore whitelist (see event-store/events.ts BROWSER_*) stays the
 * single place where durable fields are decided: page content, snapshot
 * text, screenshot bytes, and frame-channel tokens must never appear in
 * any of these payloads.
 */

/** Where the managed Chromium executable came from. */
export type ChromiumSource =
	| "env" // PIZZA_BROWSER_EXECUTABLE
	| "agent-browser" // ~/.agent-browser/browsers/chrome-<ver> (Chrome for Testing)
	| "system"; // system Chrome/Chromium install

export interface ResolvedChromium {
	executablePath: string;
	source: ChromiumSource;
	/** Chrome-for-Testing version directory when source is agent-browser. */
	version?: string;
}

/** Serializable tab metadata (safe for events, RPC responses, and the UI). */
export interface BrowserTabInfo {
	id: string;
	url: string;
	title: string;
	origin: string;
	active: boolean;
	openedAt: number;
	lastActiveAt: number;
}

/** Navigation-policy decision for a candidate URL. */
export interface PolicyDecision {
	decision: "allow" | "ask" | "block";
	origin: string;
	/** Machine-readable reason for ask/block (also used in audit events). */
	reason?: string;
}

/**
 * Wiring hooks the host (rpc-mode or a headless embedder) provides. All are
 * optional: without them the engine still works, it just emits no durable
 * audit events and has no approval resolver (policy "ask" then fails closed).
 */
export interface BrowserHostHooks {
	/**
	 * Append a whitelisted audit event to the EventStore. Receives the
	 * snake_case audit payload only — never page content or credentials.
	 */
	emitAuditEvent?: (type: string, payload: Record<string, unknown>) => void;
	/**
	 * Resolve a policy "ask" decision (e.g. first navigation to a non-public
	 * origin under the "on" approval policy). Must resolve true (allow) or
	 * false (deny). Absent => deny.
	 */
	resolveApproval?: (url: string, reason: string) => Promise<boolean>;
	/**
	 * Whether screenshot bytes may be returned to the model. Wired from the
	 * global image settings; absent => allowed (mirrors blockImages default).
	 */
	screenshotAllowed?: () => boolean;
}

/** A single client input event forwarded from the frame channel. */
export interface BrowserInputEvent {
	kind:
		| "mousedown"
		| "mouseup"
		| "mousemove"
		| "click"
		| "dblclick"
		| "wheel"
		| "keydown"
		| "keyup";
	/** CSS pixels relative to the page viewport. */
	x?: number;
	y?: number;
	button?: "left" | "right" | "middle";
	deltaX?: number;
	deltaY?: number;
	/** Playwright key name, e.g. "a", "Enter", "Shift". */
	key?: string;
	/** Modifier keys held during the event. */
	modifiers?: string[];
}

/** Opaque frame-epoch identifier used to validate coordinate-based actions. */
export interface FrameEpoch {
	tabId: string;
	/** Monotonic counter bumped on every pushed frame. */
	frameId: number;
}

/** JSON control messages the frame server sends to connected clients. */
export type FrameServerMessage =
	| { type: "hello"; sessionId: string }
	| { type: "tabs"; tabs: BrowserTabInfo[] }
	| { type: "tab_activated"; tabId: string }
	| { type: "tab_closed"; tabId: string }
	| { type: "navigated"; tabId: string; url: string; title: string }
	| { type: "frame_meta"; tabId: string; frameId: number; width: number; height: number }
	| { type: "agent_active"; active: boolean }
	| { type: "error"; message: string };

/** JSON messages a frame-channel client may send upstream. */
export type FrameClientMessage =
	| { type: "select_tab"; tabId: string }
	| { type: "input"; tabId: string; event: BrowserInputEvent }
	| { type: "ack_frame"; frameId: number };
