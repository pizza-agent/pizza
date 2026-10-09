/**
 * Cross-workspace agent messages — parsing helpers for the conversation UI.
 *
 * When one workspace's agent messages another (the `_tell` gateway command),
 * the receiving agent sees the delivery as a user turn containing a raw
 * envelope block rendered by the gateway (see packages/gateway/gateway-server.ts
 * `renderInboundMessage`):
 *
 *   <message from="agent:/Users/tom/code/web" id="m_abc_1" relay="auto">
 *   the message body
 *   </message>
 *   [gateway: this message crossed a workspace boundary — ...]
 *
 * Outbound tells appear in the timeline as `cli` tool calls whose command
 * starts with `_tell send --to <target> ...`.
 *
 * These helpers turn that raw text into structured data so the conversation
 * can render a proper "workspace message" card (sender, relay mode, body)
 * instead of the markup, while keeping the raw text around for copy/search.
 */

export interface AgentMessageInfo {
	/** Serialized sender source, e.g. "agent:/Users/tom/code/web". */
	from: string;
	/** Source kind — "agent" for workspace-to-workspace, a channel type
	 *  ("telegram"/"lark"/…) for an outside party reaching in. */
	kind: string;
	/** Human-readable sender name (envelope `sender` attr), when the
	 *  channel provided one — prefer this over the opaque id. */
	senderName?: string;
	/** Short workspace label (last path segment of the sender id). */
	fromName: string;
	/** Gateway-generated message id, for future inReplyTo threading. */
	id?: string;
	/** True when the gateway relays this agent's reply back automatically. */
	autoRelay: boolean;
	/** Message body with the envelope stripped and HTML entities unescaped. */
	body: string;
}

/**
 * Source kinds produced inside the gateway's own trust domain — mirrors
 * INTERNAL_SOURCE_KINDS in packages/gateway/gateway-server.ts. Any other
 * kind arrived through an external channel and the card should say so
 * rather than labelling it cross-workspace traffic.
 */
export const INTERNAL_MESSAGE_KINDS = new Set(["agent", "cron", "watcher", "user"]);

export interface TellCommandInfo {
	/** "send" delivers a message; "list" shows known workspaces. */
	action: "send" | "list";
	/** Destination workspace (name or path), when present. */
	to?: string;
}

/** Unescape the entities `renderInboundMessage` applies to the body/attrs. */
function unescapeEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&");
}

/** Last path segment of a sender id — "/a/b/web" -> "web", "web" -> "web". */
export function workspaceNameFrom(fromId: string): string {
	const trimmed = fromId.replace(/\/+$/, "");
	const name = trimmed.split(/[\\/]/).pop() ?? trimmed;
	return name || fromId;
}

/**
 * Parse a user-turn that carries a gateway `<message from="...">` envelope.
 * Returns null for ordinary user messages.
 */
export function parseAgentMessage(text: string): AgentMessageInfo | null {
	if (!text) return null;
	const open = /^<message\s+([^>]*)>\n?/.exec(text.trimStart());
	if (!open) return null;
	// Attributes are quoted key="value" pairs; parse generically so attribute
	// order (from/id/relay) doesn't matter.
	const attrs = new Map<string, string>();
	const attrRe = /([a-zA-Z_][\w.-]*)\s*=\s*"([^"]*)"/g;
	for (let m = attrRe.exec(open[1]); m !== null; m = attrRe.exec(open[1])) {
		attrs.set(m[1].toLowerCase(), m[2]);
	}
	const from = attrs.get("from");
	if (from === undefined) return null;
	const start = open.index + open[0].length;
	const close = text.indexOf("</message>", start);
	if (close === -1) return null;
	const body = unescapeEntities(text.slice(start, close).trim());
	if (!body) return null;
	// "agent:/a/b/web" -> kind "agent", id "/a/b/web".
	const colon = from.indexOf(":");
	const kind = colon === -1 ? from : from.slice(0, colon);
	const fromId = colon === -1 ? from : from.slice(colon + 1);
	const id = attrs.get("id");
	const sender = attrs.get("sender");
	return {
		from,
		kind,
		senderName: sender ? unescapeEntities(sender) : undefined,
		fromName: workspaceNameFrom(fromId),
		id: id || undefined,
		autoRelay: attrs.get("relay") === "auto",
		body,
	};
}

/**
 * Parse a `cli` tool command that routes to the `_tell` built-in, so the
 * tool card can be titled "tell → <target>" instead of the raw command.
 */
export function parseTellCommand(command: string): TellCommandInfo | null {
	const m = /^\s*_tell\s+(send|list)\b/.exec(command);
	if (!m) return null;
	const action = m[1] as "send" | "list";
	if (action === "list") return { action };
	// Flag form first: --to "x" / --to x.
	const flag = /--to\s+(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(command);
	if (flag) return { action, to: flag[1] ?? flag[2] ?? flag[3] };
	// Positional form: _tell send <to> <message...>.
	const rest = command.slice(m[0].length).trimStart();
	const pos = /^(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(rest);
	if (pos) return { action, to: pos[1] ?? pos[2] ?? pos[3] };
	return { action };
}