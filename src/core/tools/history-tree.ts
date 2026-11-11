import { type Static, Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { defineTool, type ToolDefinition } from "../extensions/types.js";
import { renderHistoryTreeText } from "../projection/history-tree.js";

const historyTreeSchema = Type.Object({
	action: Type.Union(
		[Type.Literal("list"), Type.Literal("view"), Type.Literal("jump"), Type.Literal("fork")],
		{
			description:
				"list: show the session history tree. view: preview a session's messages without switching. " +
				"jump: switch to a session and continue there. fork: start a new branch from a session.",
		},
	),
	session_id: Type.Optional(
		Type.String({ description: "Target session id (required for view, jump, and fork)." }),
	),
	query: Type.Optional(
		Type.String({ description: "For list: case-insensitive filter on session names and first messages." }),
	),
	max_messages: Type.Optional(
		Type.Number({ description: "For view: maximum number of recent messages to show (default 20)." }),
	),
	reason: Type.Optional(
		Type.String({ description: "For jump: short reason for the jump (for the audit log)." }),
	),
});

export type HistoryTreeToolInput = Static<typeof historyTreeSchema>;

export function createHistoryTreeToolDefinition(): ToolDefinition<typeof historyTreeSchema, undefined> {
	return defineTool({
		name: "history_tree",
		executionMode: "sequential",
		label: "history_tree",
		description:
			"Browse and navigate the session history tree. Every past session is a node; use 'list' to see the tree, " +
			"'view' to preview a session's messages without switching, 'jump' to return to a previous session and " +
			"continue from there, and 'fork' to start an alternative branch from a session. " +
			"Use this when the user wants to go back to an earlier conversation point or try a different approach.",
		promptSnippet: "Browse past sessions as a tree; view, jump back to, or fork from any previous session",
		promptGuidelines: [
			"Use _history_tree list to find previous sessions when the user refers to earlier work; use view to confirm before jumping.",
			"Use _history_tree jump to return to a previous session, and _history_tree fork to try an alternative approach from a past point.",
			"After _history_tree jump or fork, your context switches to the target session — continue the task there.",
		],
		parameters: historyTreeSchema,
		renderShell: "self",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const historyTree = ctx?.sessionManager?.historyTree;
			if (!historyTree) {
				throw new Error("History tree is not available in this runtime configuration.");
			}

			try {
				switch (params.action) {
					case "list": {
						let nodes = historyTree.list();
						if (params.query) {
							const query = params.query.toLowerCase();
							const matched = new Set(
								nodes
									.filter(
										(node) =>
											node.name?.toLowerCase().includes(query) ||
											node.title?.toLowerCase().includes(query) ||
											node.snippet?.toLowerCase().includes(query) ||
											node.session_id.toLowerCase().includes(query),
									)
									.map((node) => node.session_id),
							);
							nodes = nodes.filter((node) => matched.has(node.session_id));
							if (nodes.length === 0) {
								return textResult(`No sessions match query: ${params.query}`);
							}
						}
						return textResult(
							`Session history tree (${nodes.length} node${nodes.length === 1 ? "" : "s"}):\n${renderHistoryTreeText(nodes)}`,
						);
					}
					case "view": {
						if (!params.session_id) throw new Error("view requires session_id.");
						const view = historyTree.view(params.session_id, { maxMessages: params.max_messages });
						if (!view) throw new Error(`Session not found: ${params.session_id}`);
						const desc = view.descriptor;
						const header = [
							`Session ${desc.session_id}${desc.name ? ` "${desc.name}"` : ""}`,
							`created ${new Date(desc.created_at).toISOString()}, ${view.message_count} messages` +
								(desc.parent_session_id ? `, parent ${desc.parent_session_id}` : ""),
						].join("\n");
						const shown =
							view.messages.length < view.message_count
								? `\n(showing last ${view.messages.length} of ${view.message_count} messages)`
								: "";
						const body = view.messages.length > 0 ? view.messages.map((line) => `  ${line}`).join("\n") : "  (no messages)";
						return textResult(`${header}${shown}\n${body}`);
					}
					case "jump": {
						if (!params.session_id) throw new Error("jump requires session_id.");
						const result = historyTree.jump(params.session_id, params.reason);
						const note = result.reopened
							? `The target session was closed, so it was reopened as new session ${result.session_id} with its history preserved.`
							: `Now on session ${result.session_id}.`;
						return textResult(
							`Jumped to session ${params.session_id}. ${note} ` +
								"Your context now reflects that session — continue the user's task from there.",
						);
					}
					case "fork": {
						if (!params.session_id) throw new Error("fork requires session_id.");
						const result = historyTree.fork(params.session_id);
						return textResult(
							`Forked session ${params.session_id} into new branch ${result.session_id}. ` +
								"Your context starts fresh from the fork point — proceed with the alternative approach.",
						);
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`history_tree ${params.action} failed: ${message}`);
			}
		},
		renderCall(args, _theme) {
			const target = args?.session_id ? ` ${args.session_id}` : "";
			const query = args?.query ? ` query=${JSON.stringify(args.query)}` : "";
			return new Text(`history_tree ${args?.action ?? ""}${target}${query}`, 0, 0);
		},
		renderResult(result, _options, _theme) {
			const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
			return new Text(`\n${text}`, 0, 0);
		},
	});
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: undefined } {
	return { content: [{ type: "text", text }], details: undefined };
}
