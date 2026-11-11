/**
 * `tell` built-in CLI command — agent-to-agent messaging via the gateway.
 *
 * Routed internally by the `cli` tool (alongside read/write/edit/session_split/
 * history_tree/skill), wired up whenever the runtime has an
 * agent dir (see session-facade-factory.ts).
 *
 * `_tell` sends a message to another agent's workspace through the gateway
 * daemon and returns the target agent's reply. The gateway maintains a pool of
 * long-lived agent processes — repeated tells to the same workspace reuse the
 * agent and its accumulated context. This makes `_tell` conversational: you
 * can have a back-and-forth with another workspace's agent.
 *
 * The gateway is auto-started on demand (like ssh-agent) — the caller never
 * needs to manage it manually.
 *
 * Delivery is asynchronous: `_tell` returns a delivery ack (messageId)
 * immediately and never blocks on the target's turn. The target agent's final
 * reply is relayed back automatically by the gateway as an incoming
 * `<message from="agent:<cwd>">` turn — reply reliability lives in the
 * protocol, not in the receiver remembering to tell back.
 */

import { type Static, Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { defineTool, type ToolDefinition } from "../extensions/types.js";
import { GatewayClient, ensureGateway, gatewaySocketPath, type MessageSource } from "../../../packages/gateway/index.js";
import { VERSION } from "../../config.js";

/** Supported `tell` subcommands. */
export const TELL_ACTIONS = ["send", "list"] as const;
export type TellAction = (typeof TELL_ACTIONS)[number];

/**
 * CLI-style schema for the `tell` command. Mirrors the positional/flag form
 * parsed in `parseTellInput` (builtin-commands.ts):
 *
 *   tell send <to> <message>
 *   tell send --to <cwd|name> --message "..." [--async] [--timeout N]   (both flags deprecated no-ops)
 *   tell list
 */
const tellSchema = Type.Object({
	action: Type.Union([Type.Literal("send"), Type.Literal("list")], {
		description:
			"send: deliver a message to another agent's workspace (async — returns a delivery ack; the reply arrives later as an incoming <message> turn). " +
			"list: show known workspaces you can tell to.",
	}),
	to: Type.Optional(
		Type.String({
			description:
				"Destination workspace: a project path (cwd) or a workspace name (last path component). " +
				"Required for send. Use `tell list` to discover names.",
		}),
	),
	message: Type.Optional(
		Type.String({
			description:
				"The message to deliver to the target agent (required for send). Use --message or a <<EOF heredoc for long messages.",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description: "@deprecated Ignored — delivery is always asynchronous now.",
		}),
	),
	asyncSend: Type.Optional(
		Type.Boolean({
			description:
"@deprecated No-op — delivery is always asynchronous now.",
		}),
	),
});

export type TellToolInput = Static<typeof tellSchema>;

/** Options for {@link createTellToolDefinition}. */
export interface TellToolOptions {
	/** Agent config directory — used to discover known workspaces and to spawn the gateway. */
	agentDir: string;
	/**
	 * The calling agent's own working directory. Excluded from `list` results —
	 * an agent tells other projects, not itself.
	 */
	mainDir?: string;
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: undefined } {
	return { content: [{ type: "text", text }], details: undefined };
}

/** Format the known-workspace list as a readable text block. */
function formatWorkspaceList(
	workspaces: Array<{ cwd: string; workspace_id: string; last_accessed_at: number; has_event_db: boolean }>,
): string {
	if (workspaces.length === 0) {
		return (
			"No known workspace agents found. Provide an explicit `cwd` path to tell a new project " +
			"directory — it will be registered after the first tell."
		);
	}
	const lines = workspaces.map((ws, index) => {
		const last = ws.last_accessed_at > 0 ? new Date(ws.last_accessed_at).toISOString() : "unknown";
		const name = ws.cwd.replace(/\/+$/, "").split("/").pop() ?? ws.cwd;
		return `${index + 1}. name: ${name}\n   cwd: ${ws.cwd}\n   workspace_id: ${ws.workspace_id}\n   last_accessed: ${last}`;
	});
	return `Known workspace agents (${workspaces.length}):\n\n${lines.join("\n\n")}\n\nUse the name or cwd as the to argument for _tell send.`;
}

/**
 * Create the `tell` command's tool definition.
 *
 * Two actions:
 *  - **send**: deliver a message to another workspace's agent via the gateway,
 *    wait for the reply, and return it.
 *  - **list**: return the known workspaces.
 */
export function createTellToolDefinition(
	options: TellToolOptions,
): ToolDefinition<typeof tellSchema, undefined> {
	const { agentDir, mainDir } = options;

	return defineTool({
		name: "tell",
		label: "tell",
		description:
			"Send a message to another agent's workspace (agent-to-agent messaging via the gateway). " +
			"Delivery is asynchronous: send returns a delivery ack (messageId) immediately and does NOT wait for " +
			"the reply — the gateway automatically relays the target agent's final answer back to you as an " +
			'incoming <message from="agent:<cwd>"> turn. ' +
			"The gateway keeps target agents alive — repeated tells to the same workspace are conversational and " +
			"the agent remembers the context. " +
			"Use `list` to discover target workspaces, then `send` with `--to` (a workspace name or path) and `--message`.",
		promptSnippet: "_tell: send a message to another workspace's agent via the gateway and get its reply (conversational, reuses the agent)",
		promptGuidelines: [
			"Use _tell to send a message to another agent's workspace. The target agent stays alive in the gateway pool, so repeated tells are conversational — it remembers prior messages.",
			"Before telling an unfamiliar workspace, call `_tell list` to see which workspaces are known. The `to` argument is either a workspace name (last path component) or a project path (cwd).",
			"_tell send is asynchronous: it returns a delivery ack (messageId) immediately and does NOT wait for the reply. Do not resend because no reply came back within the same turn — the target's answer arrives later as an incoming <message from=\"agent:<id>\"> turn. End your turn (or continue other work) and watch for it.",
			"Prefer _tell over reading another project inline: the target agent runs in its own workspace and only its reply enters this context, keeping other projects' details out.",
			"The gateway relays replies automatically: when a told agent finishes its turn, its final answer is delivered back to you as a <message from=\"agent:<id>\" relay=\"auto\"> block. You can fire several tells and collect replies as they arrive.",
			"Messages from other agents arrive as <message from=\"agent:<id>\">...</message> blocks in your context. When the block carries relay=\"auto\", just write your final answer as a normal response — the gateway captures and relays it back to the sender; no explicit tell-back is needed. Without relay=\"auto\" (e.g. the message was queued behind a busy turn), reply with `_tell send --to <id> ...` (the <id> is the sender workspace path or name, taken from the from field).",
		],
		parameters: tellSchema,
		renderShell: "self",
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			if (params.action === "list") {
				// Lazy-import to avoid a circular dependency at module load time.
				const { listKnownWorkspaces } = await import("../event-store/workspace.js");
				const workspaces = listKnownWorkspaces(agentDir, mainDir);
				return textResult(formatWorkspaceList(workspaces));
			}

			// action === "send"
			if (!params.message) {
				throw new Error(
					"_tell send requires a `message`. Also provide `to` (a workspace name from `_tell list` or a project path).",
				);
			}
			if (!params.to) {
				throw new Error(
					"_tell send requires `to` (a workspace name from `_tell list` or a project path).",
				);
			}


			let socketPath: string;
			try {
				socketPath = await ensureGateway(agentDir, undefined, VERSION);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Failed to start gateway: ${message}`);
			}

			const client = new GatewayClient({ socketPath });
			try {
				await client.connect();

				if (signal?.aborted) {
					throw new Error("tell aborted before message was sent");
				}

				const from: MessageSource = { kind: "agent", id: mainDir ?? "(unknown)" };
				const delivery = await client.tell(params.to, params.message, from);
				if (delivery.messageId) {
					return textResult(
						`Delivered to ${params.to}. messageId=${delivery.messageId}. ` +
							`The gateway will relay the target agent's reply back to you automatically as an incoming <message from="agent:${params.to}"> turn — do not resend; end your turn or continue other work and watch for it.`,
					);
				}
				// Legacy gateway answered synchronously with the reply text.
				return textResult(delivery.reply ?? "(no response)");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`_tell to ${params.to} failed: ${message}`);
			} finally {
				await client.disconnect().catch(() => {});
			}
		},
		renderCall(args, _theme) {
			if (args?.action === "list") {
				return new Text("tell (list workspaces)", 0, 0);
			}
			const to = args?.to ?? "?";
			const message = args?.message
				? `: ${args.message.slice(0, 60)}${args.message.length > 60 ? "…" : ""}`
				: "";
			return new Text(`tell → ${to}${message}`, 0, 0);
		},
		renderResult(result, _options, _theme) {
			const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
			return new Text(`\n${text}`, 0, 0);
		},
	});
}

// Re-export for convenience.
export { gatewaySocketPath };